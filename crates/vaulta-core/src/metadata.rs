use super::*;
use serde::Deserialize;
use std::collections::{BTreeMap, BTreeSet, HashSet};

#[derive(Debug, PartialEq, Eq, Clone, Serialize, Deserialize)]
struct Organization {
    category_id: Option<String>,
    tags: BTreeSet<String>,
    flags: BTreeSet<String>,
    state: String,
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
struct View {
    enabled: bool,
    categories: BTreeSet<String>,
}

struct Metadata {
    categories: BTreeMap<String, Category>,
    tags: BTreeSet<String>,
    assets: BTreeMap<String, Organization>,
    view: View,
}

#[derive(Serialize, Deserialize)]
struct Delta<T> {
    before: T,
    after: T,
}

#[derive(Default, Serialize, Deserialize)]
struct Patch {
    categories: BTreeMap<String, Delta<Option<Category>>>,
    tags: BTreeMap<String, Delta<bool>>,
    assets: BTreeMap<String, Delta<Organization>>,
    view: Option<Delta<View>>,
}

impl Patch {
    fn is_empty(&self) -> bool {
        self.categories.is_empty()
            && self.tags.is_empty()
            && self.assets.is_empty()
            && self.view.is_none()
    }

    fn apply(&self, db: &Connection, vault: &str, reverse: bool) -> Result<()> {
        for (id, delta) in &self.categories {
            let desired = if reverse { &delta.before } else { &delta.after };
            if let Some(c) = desired {
                db.execute("INSERT INTO categories(vault_id,id,name,parent_id) VALUES(?1,?2,?3,?4)
                    ON CONFLICT(vault_id,id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id", params![vault, id, c.name, c.parent_id])?;
            } else {
                db.execute(
                    "DELETE FROM categories WHERE vault_id=?1 AND id=?2",
                    params![vault, id],
                )?;
            }
        }
        for (tag, delta) in &self.tags {
            if if reverse { delta.before } else { delta.after } {
                db.execute(
                    "INSERT INTO tags(vault_id,name) VALUES(?1,?2)",
                    params![vault, tag],
                )?;
            } else {
                db.execute(
                    "DELETE FROM tags WHERE vault_id=?1 AND name=?2",
                    params![vault, tag],
                )?;
            }
        }
        for (asset, delta) in &self.assets {
            let o = if reverse { &delta.before } else { &delta.after };
            db.execute("UPDATE assets SET category_id=?3,tags=?4,flags=?5,state=?6 WHERE vault_id=?1 AND id=?2", params![vault,asset,o.category_id,encode(&o.tags)?,encode(&o.flags)?,o.state])?;
        }
        if let Some(delta) = &self.view {
            let v = if reverse { &delta.before } else { &delta.after };
            db.execute(
                "UPDATE vaults SET view_enabled=?2,view_categories=?3 WHERE id=?1",
                params![vault, v.enabled, encode(&v.categories)?],
            )?;
        }
        Ok(())
    }
}

impl Core {
    /// Modify logical metadata. No logical action moves or deletes physical files.
    pub fn mutate(&mut self, vault: &str, action: Mutation, source: &str) -> Result<()> {
        let source = name(source)?;
        let tx = self.write()?;
        let (row, binding) = binding(&tx, vault)?;
        match action {
            Mutation::Undo {} => {
                if undo(&tx, vault, source)? {
                    bump(&tx)?;
                }
            }
            Mutation::RecoverIdentity {
                missing_id,
                present_id,
            } => {
                let message = reconcile::recover(&tx, vault, &missing_id, &present_id, &binding)?;
                audit(&tx, vault, source, &message, None)?;
                bump(&tx)?;
            }
            other => {
                let mut patch = Patch::default();
                let message = prepare(&tx, &row.vault, other, &mut patch)?;
                if !patch.is_empty() {
                    patch.apply(&tx, vault, false)?;
                    audit(&tx, vault, source, &message, Some(&encode(&patch)?))?;
                    bump(&tx)?;
                }
            }
        }
        Ok(tx.commit()?)
    }
}

pub(crate) fn seed_categories(db: &Connection, vault: &str) -> Result<()> {
    for label in ["文档", "图片", "音视频", "项目"] {
        db.execute(
            "INSERT INTO categories(vault_id,id,name) VALUES(?1,?2,?3)",
            params![vault, id(), label],
        )?;
    }
    Ok(())
}

pub(crate) fn categories(db: &Connection, vault: &str) -> Result<Vec<Category>> {
    let mut stmt = db.prepare("SELECT id,name,parent_id FROM categories WHERE vault_id=?1 ORDER BY name COLLATE NOCASE,id")?;
    let rows = stmt
        .query_map([vault], |r| {
            Ok(Category {
                id: r.get(0)?,
                name: r.get(1)?,
                parent_id: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub(crate) fn tags(db: &Connection, vault: &str) -> Result<Vec<String>> {
    let mut stmt =
        db.prepare("SELECT name FROM tags WHERE vault_id=?1 ORDER BY name COLLATE NOCASE,name")?;
    let rows = stmt
        .query_map([vault], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn category_map(db: &Connection, vault: &str) -> Result<BTreeMap<String, Category>> {
    Ok(categories(db, vault)?
        .into_iter()
        .map(|c| (c.id.clone(), c))
        .collect())
}

fn org(r: &Row<'_>, i: usize) -> rusqlite::Result<Organization> {
    Ok(Organization {
        category_id: r.get(i)?,
        tags: json(r, i + 1)?,
        flags: json(r, i + 2)?,
        state: r.get(i + 3)?,
    })
}

fn all_org(db: &Connection, vault: &str) -> Result<BTreeMap<String, Organization>> {
    let mut stmt =
        db.prepare("SELECT id,category_id,tags,flags,state FROM assets WHERE vault_id=?1")?;
    let rows = stmt
        .query_map([vault], |r| Ok((r.get(0)?, org(r, 1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

fn asset_delta(patch: &mut Patch, id: String, before: Organization, after: Organization) {
    if before != after {
        patch.assets.insert(id, Delta { before, after });
    }
}
fn category_delta(
    patch: &mut Patch,
    id: String,
    before: Option<Category>,
    after: Option<Category>,
) {
    if before != after {
        patch.categories.insert(id, Delta { before, after });
    }
}
fn view_of(vault: &Vault) -> View {
    View {
        enabled: vault.view_enabled,
        categories: vault.view_categories.iter().cloned().collect(),
    }
}
fn names(values: Vec<String>) -> Result<BTreeSet<String>> {
    values.iter().map(|s| name(s).map(str::to_owned)).collect()
}

fn prepare(db: &Connection, vault: &Vault, action: Mutation, patch: &mut Patch) -> Result<String> {
    let vid = &vault.id;
    match action {
        Mutation::Organize {
            ids,
            category_id,
            add_tags,
            remove_tags,
            add_flags,
            remove_flags,
            state,
        } => {
            if state
                .as_deref()
                .is_some_and(|s| !matches!(s, "inbox" | "filed" | "excluded"))
            {
                return Err(invalid(
                    "organization state must be inbox, filed, or excluded",
                ));
            }
            if let Some(Some(category)) = &category_id {
                require_category(&category_map(db, vid)?, category)?;
            }
            let ids: BTreeSet<_> = ids.into_iter().collect();
            let add_tags = names(add_tags)?;
            let remove_tags = names(remove_tags)?;
            let add_flags = names(add_flags)?;
            let remove_flags = names(remove_flags)?;
            let mut stmt = db.prepare("SELECT category_id,tags,flags,state FROM assets WHERE vault_id=?1 AND id=?2 AND missing=0 AND shadowed=0")?;
            for asset in &ids {
                let before = stmt
                    .query_row(params![vid, asset], |r| org(r, 0))
                    .optional()?
                    .ok_or_else(|| missing("live asset", asset))?;
                let mut after = before.clone();
                if let Some(category) = &category_id {
                    after.category_id = category.clone();
                }
                if let Some(state) = &state {
                    after.state.clone_from(state);
                }
                after.tags.retain(|t| !remove_tags.contains(t));
                after.tags.extend(
                    add_tags
                        .iter()
                        .filter(|t| !remove_tags.contains(*t))
                        .cloned(),
                );
                after.flags.retain(|f| !remove_flags.contains(f));
                after.flags.extend(
                    add_flags
                        .iter()
                        .filter(|f| !remove_flags.contains(*f))
                        .cloned(),
                );
                asset_delta(patch, asset.clone(), before, after);
            }
            if !ids.is_empty() && !add_tags.is_empty() {
                let existing: BTreeSet<_> = tags(db, vid)?.into_iter().collect();
                for t in add_tags
                    .difference(&remove_tags)
                    .filter(|t| !existing.contains(*t))
                {
                    patch.tags.insert(
                        t.clone(),
                        Delta {
                            before: false,
                            after: true,
                        },
                    );
                }
            }
            Ok(format!("Organized {} asset(s)", patch.assets.len()))
        }
        Mutation::CategorySave {
            id: supplied,
            name: display,
            parent_id,
        } => {
            let display = name(&display)?.to_owned();
            let mut graph = category_map(db, vid)?;
            let (id, before) = match supplied {
                Some(id) => (id.clone(), Some(require_category(&graph, &id)?.clone())),
                None => (id(), None),
            };
            let after = Category {
                id: id.clone(),
                name: display.clone(),
                parent_id,
            };
            graph.insert(id.clone(), after.clone());
            validate_categories(&graph)?;
            category_delta(patch, id, before, Some(after));
            Ok(format!("Saved category {display}"))
        }
        Mutation::CategoryDelete { id, reassign_to } => {
            let mut graph = category_map(db, vid)?;
            let removed = graph.remove(&id).ok_or_else(|| missing("category", &id))?;
            if let Some(reassign) = &reassign_to {
                require_category(&graph, reassign)?;
            }
            let mut updated = graph.clone();
            // Keep direct child categories, moving them one level up.
            for c in updated
                .values_mut()
                .filter(|c| c.parent_id.as_deref() == Some(&id))
            {
                c.parent_id.clone_from(&removed.parent_id);
                category_delta(
                    patch,
                    c.id.clone(),
                    graph.get(&c.id).cloned(),
                    Some(c.clone()),
                );
            }
            validate_categories(&updated)?;
            for (key, before) in all_org(db, vid)? {
                if before.category_id.as_deref() == Some(&id) {
                    let mut after = before.clone();
                    after.category_id.clone_from(&reassign_to);
                    asset_delta(patch, key, before, after);
                }
            }
            let before = view_of(vault);
            if before.categories.contains(&id) {
                let mut categories = before.categories.clone();
                categories.remove(&id);
                // Empty selection otherwise means all; do not silently widen a specific view.
                let enabled = before.enabled && !categories.is_empty();
                patch.view = Some(Delta {
                    before,
                    after: View {
                        enabled,
                        categories,
                    },
                });
            }
            let message = format!("Deleted category {}", removed.name);
            category_delta(patch, id, Some(removed), None);
            Ok(message)
        }
        Mutation::TagCreate { name: tag } => {
            let tag = name(&tag)?;
            if !tags(db, vid)?.iter().any(|s| s == tag) {
                patch.tags.insert(
                    tag.into(),
                    Delta {
                        before: false,
                        after: true,
                    },
                );
            }
            Ok(format!("Created tag {tag}"))
        }
        Mutation::TagRename {
            name: old,
            new_name: new,
        } => {
            let (old, new) = (name(&old)?, name(&new)?);
            let existing = tags(db, vid)?;
            if !existing.iter().any(|t| t == old) {
                return Err(missing("tag", old));
            }
            if old != new {
                if existing.iter().any(|t| t == new) {
                    return Err(invalid("the new tag name is already in use"));
                }
                change_tag(db, vid, old, Some(new), patch)?;
            }
            Ok(format!("Renamed tag {old} to {new}"))
        }
        Mutation::TagDelete { name: tag } => {
            let tag = name(&tag)?;
            if !tags(db, vid)?.iter().any(|t| t == tag) {
                return Err(missing("tag", tag));
            }
            change_tag(db, vid, tag, None, patch)?;
            Ok(format!("Deleted tag {tag}"))
        }
        Mutation::ViewConfig {
            enabled,
            categories,
        } => {
            let before = view_of(vault);
            let after = View {
                enabled,
                categories: categories.into_iter().collect(),
            };
            let tree = category_map(db, vid)?;
            for id in &after.categories {
                require_category(&tree, id)?;
            }
            if before != after {
                patch.view = Some(Delta { before, after });
            }
            Ok("Updated disk view settings".into())
        }
        _ => unreachable!("special mutations are handled before building an undo patch"),
    }
}

fn change_tag(
    db: &Connection,
    vault: &str,
    old: &str,
    new: Option<&str>,
    patch: &mut Patch,
) -> Result<()> {
    for (key, before) in all_org(db, vault)? {
        if before.tags.contains(old) {
            let mut after = before.clone();
            after.tags.remove(old);
            if let Some(new) = new {
                after.tags.insert(new.into());
            }
            asset_delta(patch, key, before, after);
        }
    }
    patch.tags.insert(
        old.into(),
        Delta {
            before: true,
            after: false,
        },
    );
    if let Some(new) = new {
        patch.tags.insert(
            new.into(),
            Delta {
                before: false,
                after: true,
            },
        );
    }
    Ok(())
}

fn require_category<'a>(tree: &'a BTreeMap<String, Category>, id: &str) -> Result<&'a Category> {
    tree.get(id).ok_or_else(|| missing("category", id))
}

fn validate_categories(tree: &BTreeMap<String, Category>) -> Result<()> {
    let mut siblings = BTreeMap::<Option<&str>, Vec<&str>>::new();
    for c in tree.values() {
        let names = siblings.entry(c.parent_id.as_deref()).or_default();
        if names.iter().any(|n| same_component(n, &c.name)) {
            return Err(invalid("sibling categories must have distinct names"));
        }
        names.push(&c.name);
        let mut seen = HashSet::from([c.id.as_str()]);
        let mut parent = c.parent_id.as_deref();
        while let Some(id) = parent {
            if !seen.insert(id) {
                return Err(invalid("category cycle"));
            }
            parent = require_category(tree, id)?.parent_id.as_deref();
        }
    }
    Ok(())
}

fn undo(db: &Connection, vault: &str, source: &str) -> Result<bool> {
    let entry = db.query_row("SELECT seq,message,undo FROM history WHERE vault_id=?1 AND undone=0 AND undo IS NOT NULL ORDER BY seq DESC LIMIT 1", [vault], |r| {
        Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,json::<Patch>(r,2)?))
    }).optional()?;
    let Some((seq, message, patch)) = entry else {
        return Ok(false);
    };
    let current = Metadata {
        categories: category_map(db, vault)?,
        tags: tags(db, vault)?.into_iter().collect(),
        assets: all_org(db, vault)?,
        view: view_of(&row(db, vault)?.vault),
    };
    let conflict = || invalid("metadata no longer matches the operation to undo");
    let mut categories = current.categories;
    let mut tags = current.tags;
    let mut assets = current.assets;
    for (id, d) in &patch.categories {
        if categories.get(id) != d.after.as_ref() {
            return Err(conflict());
        }
        if let Some(before) = &d.before {
            categories.insert(id.clone(), before.clone());
        } else {
            categories.remove(id);
        }
    }
    for (tag, d) in &patch.tags {
        if tags.contains(tag) != d.after {
            return Err(conflict());
        }
        if d.before {
            tags.insert(tag.clone());
        } else {
            tags.remove(tag);
        }
    }
    for (id, d) in &patch.assets {
        if assets.get(id) != Some(&d.after) {
            return Err(conflict());
        }
        assets.insert(id.clone(), d.before.clone());
    }
    let view = match &patch.view {
        Some(d) if current.view == d.after => &d.before,
        Some(_) => return Err(conflict()),
        None => &current.view,
    };
    validate_categories(&categories)?;
    if view
        .categories
        .iter()
        .any(|id| !categories.contains_key(id))
        || assets.values().any(|a| {
            a.category_id
                .as_ref()
                .is_some_and(|id| !categories.contains_key(id))
                || !a.tags.is_subset(&tags)
        })
    {
        return Err(conflict());
    }
    patch.apply(db, vault, true)?;
    db.execute("UPDATE history SET undone=1 WHERE seq=?1", [seq])?;
    audit(db, vault, source, &format!("Undid: {message}"), None)?;
    Ok(true)
}
