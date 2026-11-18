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

pub enum Wake {
    One(String),
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
            let mut watched = HashSet::<PathBuf>::new();
            let mut spaces = Vec::<(String, PathBuf)>::new();
            let mut prior = None;
            let mut db_warning = None;
            let mut warnings = HashMap::<String, String>::new();
            let mut full = Instant::now();
            let mut probe = Instant::now();
            let mut pending = BTreeSet::<String>::new();
            let mut scheduled = None;

            loop {
                let next = scheduled.unwrap_or(full).min(full).min(probe);
                match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                    Ok(Wake::One(id)) => {
                        pending.insert(id);
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
                probe = now + PROBE;
                if full_due {
                    full = now + FULL_SCAN;
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
                    let before = core.revision()?;
                    let metadata_changed = prior.is_some_and(|previous| previous != before);
                    for v in &vaults {
                        let scan = full_due || targets.contains(&v.id);
                        let result = if scan {
                            core.scan(&v.id)
                                .map_err(anyhow::Error::from)
                                .and_then(|()| sync_projection(core, &v.id, true))
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
                    Ok(core.vaults()?)
                });
                match result {
                    Ok(vaults) => {
                        db_warning = None;
                        spaces = vaults
                            .iter()
                            .map(|v| (v.id.clone(), v.root.clone()))
                            .collect();
                        if let Some(watcher) = &mut watcher {
                            let desired: HashSet<_> = vaults
                                .into_iter()
                                .filter(|v| v.parent_id.is_none())
                                .map(|v| v.root)
                                .filter(|p| p.is_dir())
                                .collect();
                            for removed in watched.difference(&desired) {
                                let _ = watcher.unwatch(removed);
                            }
                            watched.retain(|p| desired.contains(p));
                            for path in desired {
                                if !watched.contains(&path)
                                    && watcher.watch(&path, RecursiveMode::Recursive).is_ok()
                                {
                                    watched.insert(path);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        let message = format!("无法读取本地仓库索引：{e:#}");
                        if db_warning.as_ref() != Some(&message) {
                            warn(&app, "", &message);
                            db_warning = Some(message);
                        }
                    }
                }
            }
        })
        .expect("could not spawn vaulta index thread");
    tx
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
