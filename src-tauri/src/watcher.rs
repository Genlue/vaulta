use crate::ops::{changed, sync_projection, warn};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
        mpsc::{self, RecvTimeoutError, Sender},
    },
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;
use vaulta::{locked, read};
use vaulta_core::{Core, Vault};

pub enum Wake {
    One(String),
    Relocated(String),
    Refresh,
    Files(notify::Result<Event>),
}
const STARTUP_DELAY: Duration = Duration::from_secs(2);
const PROBE: Duration = Duration::from_secs(2);
const FULL_SCAN: Duration = Duration::from_secs(180);
const FALLBACK_FULL_SCAN: Duration = Duration::from_secs(45);
const DEBOUNCE: Duration = Duration::from_millis(600);
const MAX_DEBOUNCE: Duration = Duration::from_secs(3);

pub fn start(app: AppHandle, db: PathBuf, app_revision: Arc<AtomicI64>) -> Sender<Wake> {
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
            let mut spaces = Vec::<(String, PathBuf, String)>::new();
            let mut prior = None;
            let mut db_warning = None;
            let mut warnings = HashMap::<String, String>::new();
            let boot = Instant::now();
            let mut full = boot + STARTUP_DELAY;
            let mut probe = boot + STARTUP_DELAY;
            let mut pending = BTreeSet::<String>::new();
            let mut relocated = BTreeSet::<String>::new();
            let mut refresh = false;
            let mut scheduled: Option<Instant> = None;
            let mut debounce_cap: Option<Instant> = None;

            let handle_wake = |msg: Wake,
                               spaces: &[(String, PathBuf, String)],
                               pending: &mut BTreeSet<String>,
                               relocated: &mut BTreeSet<String>,
                               refresh: &mut bool,
                               scheduled: &mut Option<Instant>,
                               debounce_cap: &mut Option<Instant>,
                               full: &mut Instant| {
                let now = Instant::now();
                match msg {
                    Wake::One(id) => {
                        pending.insert(id);
                        *scheduled = Some(now);
                        *debounce_cap = None;
                    }
                    Wake::Relocated(id) => {
                        relocated.insert(id);
                        *scheduled = Some(now);
                        *debounce_cap = None;
                    }
                    Wake::Refresh => {
                        *refresh = true;
                        *scheduled = Some(now);
                        *debounce_cap = None;
                    }
                    Wake::Files(Ok(event)) if !event.kind.is_access() => {
                        let mut matched = false;
                        if event.paths.is_empty() {
                            for (id, _, _) in spaces {
                                pending.insert(id.clone());
                                matched = true;
                            }
                        } else {
                            let norm_events: Vec<(&Path, String)> = event
                                .paths
                                .iter()
                                .map(|p| (p.as_path(), normalize_path(p)))
                                .collect();
                            for (id, path, norm_root) in spaces {
                                // Include affected child spaces if a parent directory was renamed/removed.
                                if norm_events.iter().any(|(p, norm_p)| {
                                    below_pre(p, norm_p, path, norm_root)
                                        || below_pre(path, norm_root, p, norm_p)
                                }) {
                                    pending.insert(id.clone());
                                    matched = true;
                                }
                            }
                        }
                        if matched && !pending.is_empty() {
                            let cap = *debounce_cap.get_or_insert(now + MAX_DEBOUNCE);
                            let next = (now + DEBOUNCE).min(cap);
                            *scheduled = Some(scheduled.map_or(next, |s| s.max(next).min(cap)));
                        }
                    }
                    Wake::Files(Err(_)) => {
                        let target = now + DEBOUNCE;
                        if *full > target {
                            *full = target;
                        }
                    }
                    Wake::Files(_) => {}
                }
            };

            loop {
                let next = scheduled.unwrap_or(full).min(full).min(probe);
                match rx.recv_timeout(next.saturating_duration_since(Instant::now())) {
                    Ok(msg) => {
                        handle_wake(
                            msg,
                            &spaces,
                            &mut pending,
                            &mut relocated,
                            &mut refresh,
                            &mut scheduled,
                            &mut debounce_cap,
                            &mut full,
                        );
                        while let Ok(more) = rx.try_recv() {
                            handle_wake(
                                more,
                                &spaces,
                                &mut pending,
                                &mut relocated,
                                &mut refresh,
                                &mut scheduled,
                                &mut debounce_cap,
                                &mut full,
                            );
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {}
                    Err(RecvTimeoutError::Disconnected) => break,
                }
                let now = Instant::now();
                let probe_due = now >= probe;
                let full_due = now >= full;
                let dirty_due = scheduled.is_some_and(|t| now >= t);
                if !(probe_due || full_due || dirty_due) {
                    continue;
                }

                // Fast read-only probe when idle: avoid vaulta.lock and duplicate broadcasts.
                if probe_due && !full_due && !dirty_due && relocated.is_empty() && !refresh {
                    if let Some(previous) = prior {
                        match read(&db, |core| Ok(core.revision()?)) {
                            Ok(rev) => {
                                db_warning = None;
                                if rev == previous {
                                    probe = Instant::now() + PROBE;
                                    continue;
                                }
                                if rev == app_revision.load(Ordering::Acquire) {
                                    prior = Some(rev);
                                    probe = Instant::now() + PROBE;
                                    continue;
                                }
                            }
                            Err(e) => {
                                let message = format!("无法读取本地仓库索引：{e:#}");
                                if db_warning.as_ref() != Some(&message) {
                                    warn(&app, "", &message);
                                    db_warning = Some(message);
                                }
                                probe = Instant::now() + PROBE;
                                continue;
                            }
                        }
                    }
                }

                let targets = if dirty_due || full_due {
                    scheduled = None;
                    debounce_cap = None;
                    std::mem::take(&mut pending)
                } else {
                    BTreeSet::new()
                };
                let do_refresh = std::mem::take(&mut refresh);

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
                    let app_rev = app_revision.load(Ordering::Acquire);
                    let metadata_changed =
                        prior.is_some_and(|previous| previous != before && before != app_rev);
                    let mut any_scan = false;
                    for v in &vaults {
                        let moved = moved.contains(v.id.as_str());
                        let scan = full_due || targets.contains(&v.id) || moved;
                        let result = if scan {
                            any_scan = true;
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
                    let notify_ui = metadata_changed
                        || after != before
                        || (prior.is_none() && before != app_rev);
                    if notify_ui {
                        changed(&app, "");
                    }
                    prior = Some(after);
                    let vaults = if any_scan || !relocated.is_empty() {
                        core.vaults()?
                    } else {
                        vaults
                    };
                    if any_scan || !relocated.is_empty() || do_refresh || watched.is_empty() {
                        rebind(core, &vaults, &mut watcher, &mut watched);
                    }
                    Ok(vaults)
                });
                match result {
                    Ok(vaults) => {
                        db_warning = None;
                        spaces = vaults
                            .iter()
                            .map(|v| {
                                let norm = normalize_path(&v.root);
                                (v.id.clone(), v.root.clone(), norm)
                            })
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
                    let interval = if watcher.is_some() {
                        FULL_SCAN
                    } else {
                        FALLBACK_FULL_SCAN
                    };
                    full = finished + interval;
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

fn normalize_path(path: &Path) -> String {
    let s = path.to_string_lossy().replace('/', "\\").to_lowercase();
    let stripped = if let Some(unc) = s.strip_prefix(r"\\?\unc\") {
        format!(r"\\{unc}")
    } else {
        s.strip_prefix(r"\\?\").unwrap_or(&s).to_owned()
    };
    stripped.trim_end_matches('\\').to_owned()
}

fn below_pre(candidate: &Path, norm_candidate: &str, root: &Path, norm_root: &str) -> bool {
    if candidate.starts_with(root) {
        return true;
    }
    norm_candidate == norm_root
        || norm_candidate
            .strip_prefix(norm_root)
            .is_some_and(|s| s.starts_with('\\'))
}

#[cfg(test)]
fn below(candidate: &Path, root: &Path) -> bool {
    below_pre(
        candidate,
        &normalize_path(candidate),
        root,
        &normalize_path(root),
    )
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
