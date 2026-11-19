use crate::ops::{changed, sync_projection, warn};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::mpsc::{self, RecvTimeoutError, Sender},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use vaulta::locked;
use vaulta_core::{Core, Vault};

pub enum Wake {
    One(String),
    Relocated(String),
    Files(notify::Result<Event>),
}
const PROBE: Duration = Duration::from_secs(1);
const FULL_SCAN: Duration = Duration::from_secs(45);
const DEBOUNCE: Duration = Duration::from_millis(600);

pub fn start(app: AppHandle, db: PathBuf) -> Sender<Wake> {
    let (tx, rx) = mpsc::channel();
    let events = tx.clone();
    thread::Builder::new()
        .name("vaulta-index".into())
        .spawn(move || {
            let mut watcher: Option<RecommendedWatcher> =
                notify::recommended_watcher(move |result| {
                    let _ = events.send(Wake::Files(result));
                })
                .ok();
            let mut watched = HashMap::<PathBuf, String>::new();
            let mut spaces = Vec::<(String, PathBuf)>::new();
            let mut prior = None;
            let mut db_warning = None;
            let mut warnings = HashMap::<String, String>::new();
            let mut full = Instant::now();
            let mut probe = Instant::now();
            let mut pending = BTreeSet::<String>::new();
            let mut relocated = BTreeSet::<String>::new();
            let mut scheduled = None;

            loop {
                let next = scheduled.unwrap_or(full).min(full).min(probe);
                match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                    Ok(Wake::One(id)) => {
                        pending.insert(id);
                        scheduled = Some(Instant::now());
                    }
                    Ok(Wake::Relocated(id)) => {
                        relocated.insert(id);
                        scheduled = Some(Instant::now());
                    }
                    Ok(Wake::Files(Ok(event))) if !event.kind.is_access() => {
                        for (id, path) in &spaces {
                            // Include affected child spaces if a parent directory was renamed/removed.
                            if event.paths.iter().any(|p| below(p, path) || below(path, p))
                                || event.paths.is_empty()
                            {
                                pending.insert(id.clone());
                            }
                        }
                        if !pending.is_empty() {
                            scheduled.get_or_insert_with(|| Instant::now() + DEBOUNCE);
                        }
                    }
                    Ok(Wake::Files(Err(_))) => {
                        full = Instant::now();
                    }
                    Ok(_) | Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                let now = Instant::now();
                let probe_due = now >= probe;
                let full_due = now >= full;
                let dirty_due = scheduled.is_some_and(|t| now >= t);
                if !(probe_due || full_due || dirty_due) {
                    continue;
                }
                let targets = if dirty_due || full_due {
                    scheduled = None;
                    std::mem::take(&mut pending)
                } else {
                    BTreeSet::new()
                };

                let result = locked(&db, |core| {
                    let mut vaults = core.vaults()?;
                    // Parent first, so moved whole units are seen at their new roots when scanned.
                    vaults.sort_by_key(|v| v.root.components().count());
                    let moved = affected_subtree(&vaults, &relocated);
                    // Watch the new directory before walking it, so edits during the first
                    // scan schedule a follow-up scan rather than slipping through a gap.
                    if !relocated.is_empty() {
                        rebind(core, &vaults, &mut watcher, &mut watched);
                    }
                    let before = core.revision()?;
                    let metadata_changed = prior.is_some_and(|previous| previous != before);
                    for v in &vaults {
                        let moved = moved.contains(v.id.as_str());
                        let scan = full_due || targets.contains(&v.id) || moved;
                        let result = if scan {
                            core.scan(&v.id)
                                .map_err(anyhow::Error::from)
                                // Old absolute projection links may be broken by the move.
                                // Export the existing DB state before accepting disk edits.
                                .and_then(|()| sync_projection(core, &v.id, !moved))
                        } else if metadata_changed && v.view_enabled {
                            sync_projection(core, &v.id, true)
                        } else {
                            continue;
                        };
                        let message = match result {
                            Ok(w) => w.join("\n"),
                            Err(e) => format!("同步未完成：{e:#}"),
                        };
                        if message.is_empty() {
                            warnings.remove(&v.id);
                        } else if warnings.get(&v.id) != Some(&message) {
                            warn(&app, &v.id, &message);
                            warnings.insert(v.id.clone(), message);
                        }
                    }
                    let after = core.revision()?;
                    if metadata_changed || after != before || prior.is_none() {
                        changed(&app, "");
                    }
                    prior = Some(after);
                    let vaults = core.vaults()?;
                    rebind(core, &vaults, &mut watcher, &mut watched);
                    Ok(vaults)
                });
                match result {
                    Ok(vaults) => {
                        db_warning = None;
                        spaces = vaults
                            .iter()
                            .map(|v| (v.id.clone(), v.root.clone()))
                            .collect();
                        relocated.clear();
                    }
                    Err(e) => {
                        if !relocated.is_empty() {
                            scheduled = Some(Instant::now() + PROBE);
                        }
                        let message = format!("无法读取本地仓库索引：{e:#}");
                        if db_warning.as_ref() != Some(&message) {
                            warn(&app, "", &message);
                            db_warning = Some(message);
                        }
                    }
                }
                let finished = Instant::now();
                probe = finished + PROBE;
                if full_due {
                    full = finished + FULL_SCAN;
                }
            }
        })
        .expect("could not spawn vaulta index thread");
    tx
}

fn affected_subtree<'a>(vaults: &'a [Vault], roots: &BTreeSet<String>) -> HashSet<&'a str> {
    let mut affected = HashSet::new();
    // Caller orders the spaces parent-first; a child root is always deeper than its parent.
    for v in vaults {
        if roots.contains(&v.id)
            || v.parent_id
                .as_deref()
                .is_some_and(|id| affected.contains(id))
        {
            affected.insert(v.id.as_str());
        }
    }
    affected
}

fn rebind(
    core: &Core,
    vaults: &[Vault],
    watcher: &mut Option<RecommendedWatcher>,
    watched: &mut HashMap<PathBuf, String>,
) {
    let Some(watcher) = watcher else { return };
    let desired: HashMap<_, _> = vaults
        .iter()
        .filter(|v| v.parent_id.is_none() && v.root.is_dir())
        .map(|v| (v.root.as_path(), v.id.as_str()))
        .collect();
    // A different vault may register the vacated path before this thread wakes up.
    // The old OS watch still follows the moved directory, not the replacement.
    watched.retain(|path, id| {
        if desired.get(path.as_path()) == Some(&id.as_str()) {
            return true;
        }
        let _ = watcher.unwatch(path);
        false
    });
    for (path, id) in desired {
        if !watched.contains_key(path)
            && core.checked_root(id).is_ok()
            && watcher.watch(path, RecursiveMode::Recursive).is_ok()
        {
            watched.insert(path.to_owned(), id.to_owned());
        }
    }
}

fn below(candidate: &Path, root: &Path) -> bool {
    if candidate.starts_with(root) {
        return true;
    }
    fn normalized(path: &Path) -> String {
        let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
        if let Some(unc) = s.strip_prefix(r"\\?\unc\") {
            return format!(r"\\{unc}");
        }
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
    }
    let candidate = normalized(candidate);
    let root = normalized(root);
    let root = root.trim_end_matches('\\');
    candidate == root
        || candidate
            .strip_prefix(root)
            .is_some_and(|s| s.starts_with('\\'))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn watcher_accepts_windows_long_path_variants() {
        assert!(below(
            Path::new(r"C:\Vault\item.txt"),
            Path::new(r"\\?\c:\vault")
        ));
        assert!(!below(Path::new(r"C:\Vaultas\a"), Path::new(r"C:\Vault")));
        assert!(below(
            Path::new(r"\\server\share\folder\a"),
            Path::new(r"\\?\UNC\server\share\folder")
        ));
    }
}
