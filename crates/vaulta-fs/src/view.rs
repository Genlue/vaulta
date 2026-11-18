use crate::{
    content::Writer, path::*, Error, Result, ViewCategory, ViewChange, ViewItem, ViewReport,
    VIEW_DIR,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    ffi::OsStr,
    fs::{self, File},
    io::{Read, Seek, Write},
    os::windows::fs::{symlink_dir, symlink_file},
    path::{Component, Path, PathBuf},
};
use windows::Win32::Storage::FileSystem::*;

const MANIFEST: &str = ".vaulta-manifest.json";
const MAX_MANIFEST: usize = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 100_000;
const MAX_DEPTH: usize = 64;
const SYMLINK_TAG: u32 = 0xa000000c;

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    vault: String,
    root: String,
    view: String,
    categories: Vec<ViewCategory>,
    links: BTreeMap<String, Record>,
}
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    // File ID plus creation time: a new link at the same pathname is never owned by Vaulta.
    key: String,
    slot: PathBuf,
    raw_target: PathBuf,
    target: PathBuf,
    target_key: String,
    category: String,
    directory: bool,
    owned: bool,
}
struct Link {
    key: String,
    slot: PathBuf,
    raw_target: PathBuf,
    directory: bool,
}
struct Target {
    relative: String,
    category: Option<String>,
    path: PathBuf,
    key: String,
    directory: bool,
}
struct Disk {
    links: Vec<Link>,
    slots: HashSet<PathBuf>,
    dirs: HashMap<PathBuf, Dir>,
}

fn inspect_link(file: &File, path: &Path) -> Result<Option<Link>> {
    let attrs = tag(file, path)?;
    if attrs.ReparseTag != SYMLINK_TAG {
        return Ok(None);
    }
    let raw_target = fs::read_link(path)
        .map_err(|e| io_error("read symbolic link without following it", path, e))?;
    Ok(Some(Link {
        key: identity_key(file, path)?,
        slot: path.into(),
        raw_target,
        directory: attrs.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0,
    }))
}
fn dispose(file: &File, path: &Path) -> Result<()> {
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    unsafe {
        SetFileInformationByHandle(
            raw(file),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    }
    .map_err(|e| win_error("unlink the checked entry", path, e))
}
fn unlink(dir: &Dir, link: &Link) -> Result<()> {
    let path = dir.path.join(link.slot.file_name().unwrap());
    let file = file_open(
        &path,
        DELETE.0 | FILE_READ_ATTRIBUTES.0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
    )?;
    if !inspect_link(&file, &path)?.is_some_and(|l| {
        l.key == link.key && l.raw_target == link.raw_target && l.directory == link.directory
    }) {
        return Err(Error::Refused(format!(
            "projection link changed; left untouched: {}",
            path.display()
        )));
    }
    dispose(&file, &path)
}
fn verify_manifest(file: &File, path: &Path) -> Result<String> {
    if real(file, path)? || info(file, path)?.nNumberOfLinks != 1 {
        return Err(Error::Refused(format!(
            "projection manifest is not a single-link regular file: {}",
            path.display()
        )));
    }
    identity_key(file, path)
}
fn init_manifest(view: &Dir, value: &Manifest) -> Result<()> {
    let path = view
        .path
        .join(format!(".vaulta-new-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = file_open(
        &path,
        FILE_GENERIC_WRITE.0 | DELETE.0,
        FILE_SHARE_READ,
        CREATE_NEW,
    )?;
    let result = (|| {
        serde_json::to_writer_pretty(&mut file, value)
            .map_err(|e| io_error("write new projection manifest", &path, e.into()))?;
        file.sync_all()
            .map_err(|e| io_error("flush new projection manifest", &path, e))?;
        rename_handle(&file, view, OsStr::new(MANIFEST))
    })();
    if result.is_err() {
        let _ = dispose(&file, &path);
    }
    result
}
fn load_file(view: &Dir) -> Result<File> {
    file_open(
        &view.path.join(MANIFEST),
        FILE_READ_ATTRIBUTES.0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
    )
}
fn read_manifest(file: &mut File, path: &Path) -> Result<Manifest> {
    let mut bytes = Vec::new();
    file.take(MAX_MANIFEST as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| io_error("read projection manifest", path, e))?;
    if bytes.len() > MAX_MANIFEST {
        return Err(Error::Refused("projection manifest too large".into()));
    }
    serde_json::from_slice(&bytes).map_err(|e| {
        io_error(
            "unrecognized projection manifest; left untouched",
            path,
            e.into(),
        )
    })
}
fn write_manifest(writer: &mut Writer, path: &Path, manifest: &Manifest, key: &str) -> Result<()> {
    let data = serde_json::to_vec_pretty(manifest)
        .map_err(|e| io_error("encode projection manifest", path, e.into()))?;
    if data.len() > MAX_MANIFEST || verify_manifest(&writer.file, path)? != key {
        return Err(Error::Conflict);
    }
    (|| {
        writer.file.rewind()?;
        writer.file.write_all(&data)?;
        writer.file.set_len(data.len() as u64)?;
        writer.file.sync_all()
    })()
    .map_err(|e| io_error("write projection manifest", path, e))?;
    writer.commit(path)
}
fn scan(dir: Dir, depth: usize, disk: &mut Disk) -> Result<()> {
    if depth > MAX_DEPTH {
        return Err(Error::Refused("projection scan depth limit reached".into()));
    }
    let entries =
        fs::read_dir(&dir.path).map_err(|e| io_error("scan projection directory", &dir.path, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| io_error("scan projection entry", &dir.path, e))?;
        let path = entry.path();
        if disk.slots.len() >= MAX_ENTRIES {
            return Err(Error::Refused("projection scan entry limit reached".into()));
        }
        disk.slots.insert(path.clone());
        if depth == 0 && entry.file_name() == MANIFEST {
            continue;
        }
        let file = file_open(
            &path,
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            OPEN_EXISTING,
        )?;
        let attrs = tag(&file, &path)?;
        if attrs.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
            if let Some(link) = inspect_link(&file, &path)? {
                disk.links.push(link);
            }
        } else if attrs.FileAttributes & FILE_ATTRIBUTE_DIRECTORY.0 != 0 {
            scan(dir.child(&entry.file_name(), true)?, depth + 1, disk)?;
        }
    }
    disk.dirs.insert(dir.path.clone(), dir);
    Ok(())
}

fn category_dirs(
    categories: &[ViewCategory],
    disk: &Disk,
    base: &Dir,
    warnings: &mut Vec<String>,
    create: bool,
) -> HashMap<String, PathBuf> {
    let mut result = HashMap::new();
    let mut by_path = HashMap::<PathBuf, Vec<String>>::new();
    for c in categories {
        let attempt = (|| -> Result<Option<PathBuf>> {
            if c.path.is_empty()
                || c.path.len() > MAX_DEPTH
                || !c.path.iter().all(|x| valid_component(x, false))
            {
                return Err(Error::Refused(
                    "invalid Windows category directory name or depth".into(),
                ));
            }
            let mut current = base.path.clone();
            let mut guard: Option<Dir> = None;
            for name in &c.path {
                let parent = guard.as_ref().unwrap_or(base);
                let path = current.join(name);
                let child = match parent.child(OsStr::new(name), false) {
                    Ok(dir) => dir,
                    Err(e) if missing(&e) && !create => return Ok(None),
                    Err(e) if missing(&e) => {
                        create_dir(&path)?;
                        parent.child(OsStr::new(name), false)?
                    }
                    Err(e) => return Err(e),
                };
                current = child.path.clone();
                guard = Some(child);
            }
            if create || disk.dirs.contains_key(&current) {
                Ok(Some(current))
            } else {
                Ok(None)
            }
        })();
        match attempt {
            Ok(Some(path)) => by_path.entry(path).or_default().push(c.id.clone()),
            Ok(None) => (),
            Err(e) => warnings.push(format!("Category {}: {e}", c.id)),
        }
    }
    for (path, ids) in by_path {
        if ids.len() > 1 {
            warnings.push(format!("Categories overlap at {}; skipped", path.display()));
        } else {
            result.insert(ids.into_iter().next().unwrap(), path);
        }
    }
    result
}
fn targets(
    root: &Path,
    items: &[ViewItem],
    expected_identities: &HashMap<String, String>,
    warnings: &mut Vec<String>,
) -> BTreeMap<String, Target> {
    let mut targets = BTreeMap::new();
    for item in items {
        match Asset::open(root, &item.path, 0, FILE_SHARE_READ) {
            Ok(file) if file.is_dir == item.is_dir => match identity_key(&file.file, &file.path) {
                Ok(key)
                    if expected_identities
                        .get(&item.id)
                        .is_none_or(|expected| expected == &key) =>
                {
                    targets.insert(
                        item.id.clone(),
                        Target {
                            relative: item.path.clone(),
                            category: item.category_id.clone(),
                            path: file.path,
                            key,
                            directory: file.is_dir,
                        },
                    );
                }
                Ok(_) => warnings.push(format!(
                    "Asset {} changed physical identity; skipped",
                    item.id
                )),
                Err(e) => warnings.push(format!("Asset {}: {e}", item.id)),
            },
            Ok(_) => warnings.push(format!("Asset {} changed type; skipped", item.id)),
            Err(e) => warnings.push(format!("Asset {}: {e}", item.id)),
        }
    }
    targets
}

// Lexically interpret the link payload; never open or canonicalize the link itself. A second
// walk from the real vault root verifies the prospective target with all reparse checks enabled.
fn link_destination(link: &Link, root: &Dir) -> Option<(PathBuf, String)> {
    let raw = dos(&link.raw_target);
    let mut normalized = if raw.is_absolute() {
        PathBuf::new()
    } else {
        if raw.has_root() || matches!(raw.components().next(), Some(Component::Prefix(_))) {
            return None;
        }
        dos(link.slot.parent()?)
    };
    let mut seen_name = raw.is_absolute();
    for c in raw.components() {
        match c {
            Component::ParentDir => {
                // Leading `..` in relative symlinks refers to the verified link parent. Do
                // not collapse `name/..`: name could really be a reparse component.
                if seen_name || !normalized.pop() {
                    return None;
                }
            }
            Component::CurDir => (),
            Component::Normal(name) => {
                seen_name = true;
                normalized.push(name);
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let vault = dos(&root.path);
    let mut relative = Vec::new();
    let mut cursor = normalized.components();
    for parent in vault.components() {
        if !parent
            .as_os_str()
            .to_str()?
            .eq_ignore_ascii_case(cursor.next()?.as_os_str().to_str()?)
        {
            return None;
        }
    }
    for part in cursor {
        let Component::Normal(part) = part else {
            return None;
        };
        relative.push(part.to_str()?);
    }
    let file = Asset::open(&root.path, &relative.join("/"), 0, FILE_SHARE_READ).ok()?;
    let key = identity_key(&file.file, &file.path).ok()?;
    (link.directory == file.is_dir).then_some((file.path, key))
}
fn identify_owned<'a>(
    record: &Record,
    links: &'a [Link],
    indexes: &HashMap<&str, Vec<usize>>,
) -> Option<&'a Link> {
    let which = indexes.get(record.key.as_str())?;
    if which.len() != 1 {
        return None;
    }
    let link = &links[which[0]];
    (link.raw_target == record.raw_target && link.directory == record.directory).then_some(link)
}
fn record(link: &Link, target: &Target, category: &str, owned: bool) -> Record {
    Record {
        key: link.key.clone(),
        slot: link.slot.clone(),
        raw_target: link.raw_target.clone(),
        target: target.path.clone(),
        target_key: target.key.clone(),
        category: category.into(),
        directory: link.directory,
        owned,
    }
}
fn establish_link(dir: &Dir, target: &Target, id: &str) -> Result<Link> {
    // Stage at an unpredictable, create-new name and then rename the checked *link handle*.
    // A normal file or external link already in either destination slot is never claimed.
    let stage = dir
        .path
        .join(format!(".vaulta-new-{}.link", uuid::Uuid::new_v4()));
    let result = if target.directory {
        symlink_dir(&target.path, &stage)
    } else {
        symlink_file(&target.path, &stage)
    };
    result.map_err(|e| {
        io_error(
            "create symbolic link (Windows Developer Mode or symlink privilege may be required)",
            &stage,
            e,
        )
    })?;
    let f = file_open(
        &stage,
        DELETE.0 | FILE_READ_ATTRIBUTES.0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
    )?;
    let created = inspect_link(&f, &stage)?.ok_or(Error::Conflict)?;
    if created.directory != target.directory || dos(&created.raw_target) != dos(&target.path) {
        return Err(Error::Conflict);
    }
    let leaf = target.path.file_name().unwrap();
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    for (n, name) in [leaf.to_os_string(), format!("asset-{}", &hash[..24]).into()]
        .into_iter()
        .enumerate()
    {
        if name == OsStr::new(MANIFEST) {
            continue;
        }
        match rename_handle(&f, dir, &name) {
            Ok(()) => {
                let path = dir.path.join(name);
                // NTFS can update creation time when a deleted slot is reused.
                return Ok(Link {
                    key: identity_key(&f, &path)?,
                    slot: path,
                    ..created
                });
            }
            Err(Error::Collision(_)) if n == 0 => continue,
            Err(e) => {
                let _ = dispose(&f, &stage);
                return Err(e);
            }
        }
    }
    let _ = dispose(&f, &stage);
    Err(Error::Refused(
        "no noncolliding projection link name is available".into(),
    ))
}

/// Synchronize the optional, reserved `.vaulta-views` tree. `import=true` returns changes and
/// stops before materialization if the caller has category changes to apply. Call again with
/// `import=false` and the fresh snapshot. Only links this manifest created can be removed.
pub fn sync_view(
    root: &Path,
    vault_id: &str,
    categories: &[ViewCategory],
    items: &[ViewItem],
    enabled: bool,
    import: bool,
) -> Result<ViewReport> {
    sync_view_checked(
        root,
        vault_id,
        categories,
        items,
        enabled,
        import,
        &HashMap::new(),
    )
}

/// As [`sync_view`], checking the pinned native identity for every item whose ID is in the map.
/// Mismatches produce a warning and leave that item's projection alone.
pub fn sync_view_checked(
    root: &Path,
    vault_id: &str,
    categories: &[ViewCategory],
    items: &[ViewItem],
    enabled: bool,
    import: bool,
    expected_identities: &HashMap<String, String>,
) -> Result<ViewReport> {
    let mut report = ViewReport::default();
    if categories
        .iter()
        .map(|c| &c.id)
        .collect::<HashSet<_>>()
        .len()
        != categories.len()
        || items.iter().map(|a| &a.id).collect::<HashSet<_>>().len() != items.len()
    {
        return Err(Error::Refused(
            "duplicate category or asset ID in the projection snapshot".into(),
        ));
    }
    let root = Dir::absolute(root)?;
    let base = match root.child(OsStr::new(VIEW_DIR), true) {
        Ok(dir) => dir,
        Err(e) if missing(&e) && !enabled => return Ok(report),
        Err(e) if missing(&e) => {
            if let Err(e) = create_dir(&root.path.join(VIEW_DIR)) {
                report.warnings.push(e.to_string());
                return Ok(report);
            }
            root.child(OsStr::new(VIEW_DIR), true)?
        }
        Err(e) => {
            report.warnings.push(e.to_string());
            return Ok(report);
        }
    };
    let result = sync(
        &root,
        &base,
        vault_id,
        categories,
        items,
        enabled,
        import,
        expected_identities,
        &mut report,
    );
    if let Err(e) = result {
        report.warnings.push(e.to_string());
    }
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn sync(
    root: &Dir,
    base: &Dir,
    vault: &str,
    categories: &[ViewCategory],
    items: &[ViewItem],
    enabled: bool,
    import: bool,
    expected_identities: &HashMap<String, String>,
    report: &mut ViewReport,
) -> Result<()> {
    let root_key = identity_key(root.handle(), &root.path)?;
    let view_key = identity_key(base.handle(), &base.path)?;
    let path = base.path.join(MANIFEST);
    let pinned = match load_file(base) {
        Ok(f) => f,
        Err(e) if missing(&e) && !enabled => return Ok(()),
        Err(e) if missing(&e) => {
            // Don't claim an already populated, unowned tree.
            if fs::read_dir(&base.path)
                .map_err(|e| io_error("inspect unowned projection", &base.path, e))?
                .next()
                .is_some()
            {
                return Err(Error::Refused(
                    "projection directory has no Vaulta manifest and is not empty; left untouched"
                        .into(),
                ));
            }
            init_manifest(
                base,
                &Manifest {
                    version: 1,
                    vault: vault.into(),
                    root: root_key.clone(),
                    view: view_key.clone(),
                    categories: vec![],
                    links: BTreeMap::new(),
                },
            )?;
            load_file(base)?
        }
        Err(e) => return Err(e),
    };
    let key = verify_manifest(&pinned, &path)?;
    let mut writer = Writer::open(&path)?;
    if verify_manifest(&writer.file, &path)? != key {
        return Err(Error::Conflict);
    }
    let original = read_manifest(&mut writer.file, &path)?;
    let mut manifest = original.clone();
    if manifest.version != 1
        || manifest.vault != vault
        || manifest.root != root_key
        || manifest.view != view_key
    {
        return Err(Error::Refused(
            "foreign projection manifest; left untouched".into(),
        ));
    }
    let mut disk = Disk {
        dirs: HashMap::new(),
        links: vec![],
        slots: HashSet::new(),
    };
    scan(root.child(OsStr::new(VIEW_DIR), true)?, 0, &mut disk)?;
    let dirs = category_dirs(categories, &disk, base, &mut report.warnings, false);
    let dir_category: HashMap<&Path, &str> = dirs
        .iter()
        .map(|(id, p)| (p.as_path(), id.as_str()))
        .collect();
    let mut indexes = HashMap::<&str, Vec<usize>>::new();
    for (i, link) in disk.links.iter().enumerate() {
        indexes.entry(&link.key).or_default().push(i);
    }
    let targets = if enabled {
        targets(&root.path, items, expected_identities, &mut report.warnings)
    } else {
        BTreeMap::new()
    };
    let mut by_target = HashMap::<(&Path, &str), Option<&str>>::new();
    for (id, target) in &targets {
        by_target
            .entry((&target.path, &target.key))
            .and_modify(|x| *x = None)
            .or_insert(Some(id));
    }
    let mut candidates = HashMap::<&str, Vec<&Link>>::new();
    let mut outside = HashMap::<&str, Vec<&Link>>::new();
    for link in &disk.links {
        if let Some((path, key)) = link_destination(link, root) {
            if let Some(&id) = by_target
                .get(&(path.as_path(), &key))
                .and_then(Option::as_ref)
            {
                if dir_category.contains_key(link.slot.parent().unwrap()) {
                    candidates.entry(id).or_default().push(link);
                } else {
                    outside.entry(id).or_default().push(link);
                }
            }
        }
    }
    let same_layout = |category: &str| {
        let prior = manifest.categories.iter().find(|c| c.id == category);
        let current = categories.iter().find(|c| c.id == category);
        matches!((prior, current), (Some(a), Some(b)) if a.path == b.path)
    };
    let mut blocked = BTreeSet::new();
    if enabled && import {
        for (id, target) in &targets {
            let previous = manifest.links.get(id);
            let links = candidates
                .get(id.as_str())
                .map(Vec::as_slice)
                .unwrap_or_default();
            let owned = previous.and_then(|r| identify_owned(r, &disk.links, &indexes));
            // Avoid undoing a newer logical category assignment, or inferring from a moved real target.
            if previous.is_some_and(|r| {
                target.category.as_deref() != Some(&r.category)
                    || target.path != r.target
                    || target.key != r.target_key
                    || !same_layout(&r.category)
            }) {
                continue;
            }
            let change = match links {
                [link] if !outside.contains_key(id.as_str()) => {
                    let category = dir_category[link.slot.parent().unwrap()];
                    (Some(category) != target.category.as_deref())
                        .then(|| Some(category.to_owned()))
                }
                [] if previous.is_some_and(|r| {
                    dirs.contains_key(&r.category) && !disk.slots.contains(&r.slot)
                }) && owned.is_none()
                    && !outside.contains_key(id.as_str()) =>
                {
                    Some(None)
                }
                [] if previous.is_none() && !outside.contains_key(id.as_str()) => None,
                _ => {
                    blocked.insert(id.as_str());
                    report.warnings.push(format!(
                        "Asset {id}: ambiguous projection change; links left untouched"
                    ));
                    None
                }
            };
            if let Some(category_id) = change {
                report.changes.push(ViewChange {
                    id: id.clone(),
                    category_id,
                });
            }
        }
        if !report.changes.is_empty() {
            return Ok(());
        }
    }
    let desired = if enabled {
        category_dirs(categories, &disk, base, &mut report.warnings, true)
    } else {
        HashMap::new()
    };
    let known_items: HashSet<_> = items.iter().map(|a| a.id.as_str()).collect();
    let all_ids: BTreeSet<_> = manifest
        .links
        .keys()
        .cloned()
        .chain(targets.keys().cloned())
        .collect();
    for id in all_ids {
        let old = manifest.links.get(&id);
        let observed = old.and_then(|r| identify_owned(r, &disk.links, &indexes));
        let target = targets.get(&id);
        if blocked.contains(id.as_str())
            || (enabled && target.is_none() && known_items.contains(id.as_str()))
        {
            continue;
        }
        let dest = target
            .and_then(|t| t.category.as_ref())
            .and_then(|id| desired.get(id));
        if target
            .and_then(|t| t.category.as_ref())
            .is_some_and(|id| categories.iter().any(|c| c.id == *id))
            && dest.is_none()
        {
            continue;
        }
        let keep = target.and_then(|t| {
            let dest = dest?;
            let found: Vec<_> = candidates
                .get(id.as_str())
                .into_iter()
                .flatten()
                .filter(|l| l.slot.parent() == Some(dest))
                .collect();
            match found.as_slice() {
                [link] => Some(record(
                    link,
                    t,
                    t.category.as_deref().unwrap(),
                    old.is_some_and(|r| r.owned && observed.is_some_and(|o| o.key == link.key)),
                )),
                _ => None,
            }
        });
        if candidates.get(id.as_str()).is_some_and(|l| l.len() > 1) {
            report
                .warnings
                .push(format!("Asset {id}: multiple links; left untouched"));
            continue;
        }
        // Ambiguous external additions are not grounds to remove an existing owned link.
        if keep.is_none()
            && dest.is_some()
            && (outside.get(id.as_str()).is_some_and(|ls| {
                ls.iter().any(|l| {
                    !old.is_some_and(|r| r.owned && observed.is_some_and(|o| o.key == l.key))
                })
            }) || candidates.get(id.as_str()).is_some_and(|ls| {
                ls.iter().any(|l| {
                    !old.is_some_and(|r| r.owned && observed.is_some_and(|o| o.key == l.key))
                })
            }))
        {
            report.warnings.push(format!(
                "Asset {id}: external link outside the selected category; left untouched"
            ));
            continue;
        }
        // Hold a non-delete-shared target during link creation or retargeting; never bind a
        // replacement that appeared after reading the metadata snapshot.
        let _target_guard = if let (Some(target), Some(_)) = (target, dest) {
            match Asset::open(
                &root.path,
                &target.relative,
                FILE_READ_DATA.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
            )
            .and_then(|file| {
                if file.path != target.path || file.is_dir != target.directory {
                    return Err(Error::Conflict);
                }
                verify(&file.file, &file.path, Some(&target.key))?;
                Ok(file)
            }) {
                Ok(file) => Some(file),
                Err(e) => {
                    report.warnings.push(format!("Asset {id}: {e}"));
                    continue;
                }
            }
        } else {
            None
        };
        if let Some(link) = observed.filter(|l| {
            old.is_some_and(|r| r.owned) && keep.as_ref().is_none_or(|k| k.key != l.key)
        }) {
            let dir = &disk.dirs[link.slot.parent().unwrap()];
            if let Err(e) = unlink(dir, link) {
                report.warnings.push(e.to_string());
                continue;
            }
        }
        let updated = if let Some(keep) = keep {
            Some(keep)
        } else if let (Some(target), Some(dest)) = (target, dest) {
            let relative = dest.strip_prefix(&base.path).map_err(|_| Error::Conflict)?;
            let mut dir = root.child(OsStr::new(VIEW_DIR), true)?;
            for component in relative.components() {
                dir.push(component.as_os_str(), false)?;
            }
            match establish_link(&dir, target, &id) {
                Ok(link) => Some(record(
                    &link,
                    target,
                    target.category.as_deref().unwrap(),
                    true,
                )),
                Err(e) => {
                    report.warnings.push(e.to_string());
                    None
                }
            }
        } else {
            None
        };
        if let Some(entry) = updated {
            manifest.links.insert(id, entry);
        } else {
            manifest.links.remove(&id);
        }
    }
    manifest.categories = if enabled { categories.to_vec() } else { vec![] };
    manifest.categories.sort_by(|a, b| a.id.cmp(&b.id));
    // Never write, flush or commit a stable manifest: it is under a recursive watcher.
    if manifest == original {
        return Ok(());
    }
    write_manifest(&mut writer, &path, &manifest, &key)
}
