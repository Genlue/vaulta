use super::*;
use crate::filesystem::{Entry, Physical, Walk};
use std::collections::{HashMap, HashSet};

#[derive(Debug)]
struct Indexed {
    id: String,
    path: String,
    identity: String,
    kind: String,
    size: u64,
    created: i64,
    modified: i64,
    links: u32,
    missing: bool,
    shadowed: bool,
}

impl Indexed {
    fn matches(&self, observed: &Physical) -> bool {
        self.identity == observed.identity && (self.kind != "file") == observed.directory
    }
    fn same(&self, entry: &Entry) -> bool {
        !self.missing
            && !self.shadowed
            && self.path == entry.path
            && self.matches(&entry.physical)
            && self.size == entry.physical.size
            && self.modified == entry.physical.modified
            && self.created == entry.physical.created
            && self.links == entry.physical.links
    }
}

fn indexed(db: &Connection, vault: &str) -> Result<Vec<Indexed>> {
    let mut stmt = db.prepare("SELECT id,path,identity,kind,size,created,modified,links,missing,shadowed FROM assets WHERE vault_id=?1 ORDER BY missing,id")?;
    let rows = stmt
        .query_map([vault], |r| {
            Ok(Indexed {
                id: r.get(0)?,
                path: r.get(1)?,
                identity: r.get(2)?,
                kind: r.get(3)?,
                size: r.get(4)?,
                created: r.get(5)?,
                modified: r.get(6)?,
                links: r.get(7)?,
                missing: r.get(8)?,
                shadowed: r.get(9)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

impl Core {
    /// Reconcile a vault from disk without ever modifying the user filesystem.
    /// A partial walk is additive and never makes an existing live asset missing.
    pub fn scan(&mut self, vault_id: &str) -> Result<()> {
        // Another connection can scan, rebind, detach, or create a unit while we walk.
        // If its scan epoch or our binding changes, discard the stale observations.
        for _ in 0..3 {
            let (start, start_binding, units) = {
                let tx = self.db.unchecked_transaction()?;
                let (start, binding) = binding(&tx, vault_id)?;
                let units = {
                    let mut stmt = tx
                        .prepare("SELECT identity FROM assets WHERE vault_id=?1 AND kind='unit'")?;
                    let rows = stmt
                        .query_map([vault_id], |r| r.get::<_, String>(0))?
                        .collect::<rusqlite::Result<HashSet<_>>>()?;
                    rows
                };
                tx.commit()?;
                (start, binding, units)
            };
            let mut observed = start_binding.check().ok().map(|guard| {
                let walk = Walk::collect(start_binding.root(), &guard, &units);
                (walk, guard)
            });
            let tx = self.write()?;
            let (current, current_binding) = binding(&tx, vault_id)?;
            if start.epoch != current.epoch || start_binding != current_binding {
                continue;
            }
            // The root handles stay open across reconciliation. If unavailable at the start,
            // check again before publishing the outage in case it returned in the meantime.
            if observed.is_none() && current_binding.check().is_ok() {
                continue;
            }
            if let Some((walk, guard)) = &mut observed {
                walk.validate_root(guard);
            }
            let status = match observed.as_ref() {
                Some((walk, _)) if !walk.root_listed => "unavailable",
                Some((walk, _)) if walk.complete => "ready",
                Some(_) => "partial",
                None => "unavailable",
            };
            let mut changes = ScanChanges::default();
            if let Some((walk, _)) = &observed {
                changes = reconcile(&tx, vault_id, walk)?;
            }
            tx.execute(
                "UPDATE vaults SET status=?2, scan_epoch=scan_epoch+1 WHERE id=?1",
                params![vault_id, status],
            )?;
            if changes.changed() || current.vault.status != status {
                bump(&tx)?;
                if changes.added + changes.moved + changes.missing + changes.returned > 0
                    || current.vault.status != status
                {
                    audit(
                        &tx,
                        vault_id,
                        "scan",
                        &format!(
                            "Scan {status}: {} added, {} moved, {} missing, {} returned",
                            changes.added, changes.moved, changes.missing, changes.returned
                        ),
                        None,
                    )?;
                }
            }
            tx.commit()?;
            return Ok(());
        }
        Err(invalid("vault changed during scan; retry"))
    }

    /// Designate a directory as a whole unit and create its independent child space.
    /// Parent descendant records are retained but hidden from the outer space.
    pub fn open_unit(&mut self, vault_id: &str, asset_id: &str) -> Result<Vault> {
        let tx = self.write()?;
        let (_, binding) = binding(&tx, vault_id)?;
        if binding.chain.len() > 256 {
            return Err(invalid("vault nesting limit exceeded"));
        }
        let asset = load_asset(&tx, vault_id, asset_id)?;
        if !matches!(asset.kind.as_str(), "directory" | "unit")
            || matches!(asset.state.as_str(), "missing" | "excluded")
        {
            return Err(invalid("a live, non-excluded directory is required"));
        }
        let _root = binding.check()?;
        let path = binding.root().join(filesystem::relative(&asset.path)?);
        let guard = filesystem::guarded(&path)?;
        if !guard.physical.directory || Some(&guard.physical.identity) != asset.identity.as_ref() {
            return Err(invalid(
                "the directory changed; scan before opening it as a unit",
            ));
        }
        ensure_outer_path(&tx, vault_id, &binding, &asset.path)?;
        let existing = tx
            .query_row(
                "SELECT id FROM vaults WHERE parent_id=?1 AND unit_id=?2",
                params![vault_id, asset_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        let child_id = match existing {
            Some(existing) => existing,
            None => {
                let nested = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM assets WHERE vault_id=?1 AND kind='unit'
                         AND substr(path,1,length(?2)+1) = ?2 || '/')",
                    params![vault_id, asset.path],
                    |r| r.get::<_, bool>(0),
                )?;
                if nested {
                    return Err(invalid("this directory already contains a folder unit; wrap it before designating any inner units"));
                }
                let child_id = id();
                tx.execute("INSERT INTO vaults(id,name,root,root_identity,parent_id,unit_id) VALUES(?1,?2,'',?3,?4,?5)", params![child_id, asset.name, guard.physical.identity, vault_id, asset_id])?;
                metadata::seed_categories(&tx, &child_id)?;
                tx.execute("UPDATE assets SET kind='unit' WHERE id=?1", [asset_id])?;
                tx.execute("UPDATE assets SET missing=1,shadowed=1 WHERE vault_id=?1 AND substr(path,1,length(?2)+1) = ?2 || '/'", params![vault_id, asset.path])?;
                invalidate(&tx, vault_id)?;
                audit(
                    &tx,
                    vault_id,
                    "app",
                    &format!("Opened folder unit {}", asset.path),
                    None,
                )?;
                audit(&tx, &child_id, "app", "Created child vault", None)?;
                bump(&tx)?;
                child_id
            }
        };
        let child = load_vault(&tx, &child_id)?;
        tx.commit()?;
        Ok(child)
    }

    /// Bind a tracked file to a verified destination after an explicit app operation.
    /// This is the only automatic path for a change of identity at the same path (atomic save).
    pub fn rebind(&mut self, vault_id: &str, asset_id: &str, new_path: &str) -> Result<()> {
        let rel = filesystem::relative(new_path)?;
        let tx = self.write()?;
        let (_, binding) = binding(&tx, vault_id)?;
        let asset = load_asset(&tx, vault_id, asset_id)?;
        if asset.state == "missing" {
            return Err(invalid("cannot rebind a missing asset"));
        }
        let _root = binding.check()?;
        let destination = binding.root().join(rel);
        let guard = filesystem::guarded(&destination)?;
        filesystem::validate_spelling(&destination, &guard.handle, new_path)?;
        let p = &guard.physical;
        let old_key = asset.identity.as_deref();
        let same_id = old_key == Some(p.identity.as_str());
        if (asset.kind != "file") != p.directory || (p.directory && !same_id) {
            return Err(invalid(
                "destination does not match the asset kind or directory identity",
            ));
        }
        if !same_id && (new_path != asset.path || p.links != 1) {
            return Err(invalid("a changed identity is allowed only for a single-link atomic save at the current path"));
        }
        ensure_outer_path(&tx, vault_id, &binding, new_path)?;
        let others = indexed(&tx, vault_id)?;
        if others
            .iter()
            .any(|a| a.id != asset_id && !a.missing && !a.shadowed && a.path == new_path)
        {
            return Err(invalid("destination is already tracked by another asset"));
        }
        if !same_id
            && others
                .iter()
                .any(|a| a.id != asset_id && a.identity == p.identity)
        {
            return Err(invalid(
                "destination identity is already known to this vault",
            ));
        }
        if new_path != asset.path && same_id && !p.directory && p.links > 1 {
            let old = binding.root().join(filesystem::relative(&asset.path)?);
            // If both names still exist, this is not a move. A case-only rename on a
            // multi-link file is left to reconciliation rather than an unsafe guess.
            match std::fs::symlink_metadata(&old) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                _ => return Err(invalid("cannot rebind an ambiguous hard-link move")),
            }
        }
        let before = others
            .iter()
            .find(|a| a.id == asset_id)
            .ok_or_else(|| missing("asset", asset_id))?;
        let entry = Entry {
            path: new_path.into(),
            physical: guard.physical,
        };
        if !before.same(&entry) {
            // Descendants are reconciled by their own IDs, not rewritten from a string prefix.
            apply_entry(&tx, asset_id, &entry)?;
            invalidate(&tx, vault_id)?;
            audit(
                &tx,
                vault_id,
                "app",
                &format!("Rebound {} to {new_path}", asset.path),
                None,
            )?;
            bump(&tx)?;
        }
        Ok(tx.commit()?)
    }
}

fn ensure_outer_path(db: &Connection, vault: &str, binding: &Binding, rel: &str) -> Result<()> {
    let units = {
        let mut stmt =
            db.prepare("SELECT identity FROM assets WHERE vault_id=?1 AND kind='unit'")?;
        let rows = stmt
            .query_map([vault], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<HashSet<_>>>()?;
        rows
    };
    if !units.is_empty() {
        let destination = binding.root().join(filesystem::relative(rel)?);
        for parent in destination
            .ancestors()
            .skip(1)
            .take_while(|p| *p != binding.root())
        {
            if filesystem::identity(parent)?.is_some_and(|key| units.contains(&key)) {
                return Err(invalid("destination is inside a folder unit"));
            }
        }
    }
    Ok(())
}

pub(crate) fn invalidate(db: &Connection, vault: &str) -> Result<()> {
    db.execute(
        "UPDATE vaults SET scan_epoch=scan_epoch+1 WHERE id=?1",
        [vault],
    )?;
    Ok(())
}

#[derive(Default)]
struct ScanChanges {
    added: usize,
    moved: usize,
    missing: usize,
    returned: usize,
    other: usize,
}
impl ScanChanges {
    fn changed(&self) -> bool {
        self.added + self.moved + self.missing + self.returned + self.other > 0
    }
}

fn reconcile(db: &Connection, vault: &str, walk: &Walk) -> Result<ScanChanges> {
    let old = indexed(db, vault)?;
    let categories = metadata::category_ids(db, vault)?;
    let mut by_identity: HashMap<&str, Vec<usize>> = HashMap::new();
    let mut live_by_path = HashMap::new();
    for (i, a) in old.iter().enumerate() {
        by_identity.entry(&a.identity).or_default().push(i);
        if !a.missing {
            live_by_path.insert(a.path.as_str(), i);
        }
    }
    let mut seen_count = HashMap::<&str, usize>::new();
    for entry in &walk.entries {
        *seen_count.entry(&entry.physical.identity).or_default() += 1;
    }
    let mut used = HashSet::new();
    let mut matches = vec![None; walk.entries.len()];
    // Exact pathname + guarded native ID wins, even for known hard-link aliases.
    for (j, entry) in walk.entries.iter().enumerate() {
        let candidates = by_identity
            .get(entry.physical.identity.as_str())
            .map(Vec::as_slice)
            .unwrap_or_default();
        let exact = candidates
            .iter()
            .copied()
            .filter(|&i| old[i].matches(&entry.physical) && old[i].path == entry.path)
            .collect::<Vec<_>>();
        let live_exact = exact.iter().copied().find(|&i| !old[i].missing);
        if let Some(i) = live_exact.or_else(|| {
            (walk.complete && exact.len() == 1)
                .then(|| exact[0])
                .filter(|&i| {
                    entry.physical.directory || (entry.physical.links == 1 && old[i].links == 1)
                })
        }) {
            matches[j] = Some(i);
            used.insert(i);
        }
    }
    if walk.complete {
        for (j, entry) in walk
            .entries
            .iter()
            .enumerate()
            .filter(|(j, _)| matches[*j].is_none())
            .collect::<Vec<_>>()
        {
            let key = entry.physical.identity.as_str();
            if seen_count[key] != 1 || (!entry.physical.directory && entry.physical.links != 1) {
                continue;
            }
            let Some(candidates) = by_identity.get(key).filter(|v| v.len() == 1) else {
                continue;
            };
            let i = candidates[0];
            if !used.contains(&i)
                && old[i].matches(&entry.physical)
                && (entry.physical.directory || old[i].links == 1)
            {
                matches[j] = Some(i);
                used.insert(i);
            }
        }
    }
    let mut out = ScanChanges::default();
    if walk.complete {
        // Vacate all moving and absent slots before applying any observations (including swaps).
        let mut moving = HashSet::new();
        for (j, i) in matches
            .iter()
            .enumerate()
            .filter_map(|(j, i)| i.map(|i| (j, i)))
        {
            if old[i].path != walk.entries[j].path {
                moving.insert(i);
            }
        }
        for (i, a) in old.iter().enumerate() {
            if !a.missing && (moving.contains(&i) || !used.contains(&i)) {
                db.execute("UPDATE assets SET missing=1 WHERE id=?1", [&a.id])?;
                if !used.contains(&i) {
                    out.missing += 1;
                }
            }
        }
    }
    for (entry, index) in walk.entries.iter().zip(matches) {
        if let Some(i) = index {
            let before = &old[i];
            if !before.same(entry) {
                apply_entry(db, &before.id, entry)?;
                if before.missing {
                    out.returned += 1;
                } else if before.path != entry.path {
                    out.moved += 1;
                } else {
                    out.other += 1;
                }
            }
        } else {
            // A partial scan cannot reliably decide that an old record moved or was replaced.
            if !walk.complete
                && (live_by_path.contains_key(entry.path.as_str())
                    || by_identity.contains_key(entry.physical.identity.as_str()))
            {
                continue;
            }
            let p = &entry.physical;
            // A new file arrives with the best category we can name. This is a
            // suggestion, not adoption: state stays at the default (inbox).
            let category = (!p.directory)
                .then(|| classify::category_for(&entry.path))
                .flatten()
                .and_then(|label| categories.get(label));
            let asset_id = id();
            // Folders are containers, not things to adopt; they enter the
            // library directly. Files wait in the inbox until the user files
            // them, even when the classifier already named a category.
            let state = if p.directory { "filed" } else { "inbox" };
            db.execute("INSERT INTO assets(id,vault_id,path,kind,size,modified,created,identity,links,category_id,state) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)",
                params![asset_id, vault, entry.path, if p.directory { "directory" } else { "file" }, p.size, p.modified, p.created, p.identity, p.links, category, state])?;
            out.added += 1;
        }
    }
    Ok(out)
}

fn apply_entry(db: &Connection, id: &str, entry: &Entry) -> Result<()> {
    let p = &entry.physical;
    db.execute("UPDATE assets SET path=?2,size=?3,modified=?4,created=?5,identity=?6,links=?7,missing=0,shadowed=0 WHERE id=?1",
        params![id, entry.path, p.size, p.modified, p.created, p.identity, p.links])?;
    Ok(())
}

pub(crate) fn recover(
    db: &Connection,
    vault_id: &str,
    old_id: &str,
    new_id: &str,
    binding: &Binding,
) -> Result<String> {
    let old = load_asset(db, vault_id, old_id)?;
    let new = load_asset(db, vault_id, new_id)?;
    // A scan may have attached the classifier's suggestion before the user saw
    // the replacement. That suggestion is not user metadata: any category that
    // differs from it means the record was organized deliberately.
    let categories = metadata::category_ids(db, vault_id)?;
    let suggested =
        classify::category_for(&new.path).and_then(|label| categories.get(label).cloned());
    let pristine_category =
        new.category_id.is_none() || new.category_id.as_deref() == suggested.as_deref();
    if old.state != "missing"
        || new.state != "inbox"
        || old.kind != new.kind
        || old.kind == "unit"
        || !pristine_category
        || !new.tags.is_empty()
        || !new.flags.is_empty()
    {
        return Err(invalid("recovery requires a missing record and an unorganized inbox asset of the same kind (not a unit)"));
    }
    let _root = binding.check()?;
    let path = binding.root().join(filesystem::relative(&new.path)?);
    let guard = filesystem::guarded(&path)?;
    if Some(&guard.physical.identity) != new.identity.as_ref()
        || guard.physical.directory != (new.kind == "directory")
    {
        return Err(invalid("recovery target changed; scan first"));
    }
    // Remove the provisional record so it cannot compete with the manually recovered identity.
    db.execute("DELETE FROM assets WHERE id=?1", [new_id])?;
    apply_entry(
        db,
        old_id,
        &Entry {
            path: new.path.clone(),
            physical: guard.physical,
        },
    )?;
    invalidate(db, vault_id)?;
    Ok(format!("Recovered {} as {}", old.path, new.path))
}
