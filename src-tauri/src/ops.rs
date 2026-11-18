use anyhow::{Context, Result, anyhow, ensure};
use serde::Serialize;
use std::{
    collections::{HashMap, HashSet},
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Emitter};
use vaulta_core::{Asset, Core, Snapshot};
use vaulta_fs as disk;

pub const CHANGED: &str = "vaulta-changed";
const WARNING: &str = "vaulta-warning";

#[derive(Serialize, Clone)]
struct Warning<'a> {
    vault_id: &'a str,
    message: &'a str,
}

pub fn changed(app: &AppHandle, id: &str) {
    let _ = app.emit(CHANGED, id);
}
pub fn warn(app: &AppHandle, id: &str, message: &str) {
    let _ = app.emit(
        WARNING,
        Warning {
            vault_id: id,
            message,
        },
    );
}

pub fn checked_asset(core: &Core, id: &str, asset_id: &str) -> Result<(PathBuf, Asset)> {
    let root = core.checked_root(id)?;
    let asset = core.asset(id, asset_id)?;
    ensure!(asset.state != "missing", "这个文件已缺失。请先重新扫描。");
    let path = disk::resolve(&root, &asset.path)?;
    match asset.identity.as_ref() {
        Some(expected) => ensure!(
            vaulta_core::identity(&path)?.as_ref() == Some(expected),
            "磁盘对象已变化，请先重新扫描。"
        ),
        None => {
            // Do not use the same path as evidence that an unidentifiable object remained the same.
            return Err(anyhow!(
                "无法验证此文件的身份。可在资源管理器中手动定位仓库并操作真实文件。"
            ));
        }
    }
    Ok((root, asset))
}

pub fn relative(root: &Path, path: &Path) -> Option<String> {
    let mut original = path.components();
    for part in root.components() {
        let other = original.next()?;
        if !part
            .as_os_str()
            .to_str()?
            .eq_ignore_ascii_case(other.as_os_str().to_str()?)
        {
            return None;
        }
    }
    let remainder: Option<Vec<_>> = original
        .map(|p| {
            if let Component::Normal(s) = p {
                s.to_str()
            } else {
                None
            }
        })
        .collect();
    Some(remainder?.join("/"))
}

fn canonical_for_compare(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("无法访问目录 {}", path.display()))
}

pub fn prevent_data_overlap(root: &Path, db: &Path) -> Result<()> {
    let root = canonical_for_compare(root)?;
    prevent_canonical_data_overlap(&root, db)
}

pub fn prevent_canonical_data_overlap(root: &Path, db: &Path) -> Result<()> {
    let parent = canonical_for_compare(db.parent().context("应用数据目录无效")?)?;
    ensure!(
        relative(root, &parent).is_none() && relative(&parent, root).is_none(),
        "仓库不能与 Vaulta 的应用数据目录重叠。"
    );
    Ok(())
}

pub fn move_target(
    core: &Core,
    root: &Path,
    vault_id: &str,
    asset: &Asset,
    destination: &Path,
) -> Result<(PathBuf, bool)> {
    ensure!(destination.is_absolute(), "请选择一个绝对目标目录");
    let canonical = canonical_for_compare(destination)?;
    let origin = canonical_for_compare(root)?;
    let leaving = relative(&origin, &canonical).is_none();
    for v in core.vaults()? {
        if v.id == vault_id {
            continue;
        }
        let r = canonical_for_compare(&v.root).unwrap_or(v.root);
        if let Some(dest_rel) = relative(&r, &canonical) {
            // An ancestor is fine when moving inside the currently active unit.
            let is_ancestor = relative(&r, &origin).is_some_and(|p| !p.is_empty()) && !leaving;
            ensure!(
                is_ancestor
                    && !dest_rel
                        .split('/')
                        .any(|c| c.eq_ignore_ascii_case(".vaulta-views")),
                "目标位于另一个管理空间，不能在此移动。请单独选择仓库外的目录。"
            );
        }
    }
    let source = canonical_for_compare(&root.join(&asset.path))?;
    if asset.kind != "file" {
        ensure!(
            relative(&source, &canonical).is_none(),
            "不能将文件夹移入自身或其子目录"
        );
    }
    Ok((canonical, leaving))
}

fn category_path<'a>(
    id: &'a str,
    nodes: &HashMap<&'a str, (&'a str, Option<&'a str>)>,
) -> Result<Vec<String>> {
    let mut cursor = Some(id);
    let mut seen = HashSet::new();
    let mut path = Vec::new();
    while let Some(id) = cursor {
        ensure!(seen.insert(id), "分类存在循环");
        let &(name, parent) = nodes.get(id).context("分类缺少父项")?;
        path.push(name.to_owned());
        cursor = parent;
    }
    path.reverse();
    Ok(path)
}

struct Projection {
    categories: Vec<disk::ViewCategory>,
    items: Vec<disk::ViewItem>,
    identities: HashMap<String, String>,
}

fn view_data(snapshot: &Snapshot) -> Result<Projection> {
    let nodes: HashMap<_, _> = snapshot
        .categories
        .iter()
        .map(|c| (c.id.as_str(), (c.name.as_str(), c.parent_id.as_deref())))
        .collect();
    let mut categories = Vec::new();
    for c in &snapshot.categories {
        if snapshot.vault.view_categories.is_empty()
            || snapshot.vault.view_categories.contains(&c.id)
        {
            categories.push(disk::ViewCategory {
                id: c.id.clone(),
                path: category_path(&c.id, &nodes)?,
            });
        }
    }
    let items = snapshot
        .assets
        .iter()
        .filter(|a| a.state != "missing" && a.state != "excluded" && a.identity.is_some())
        .map(|a| disk::ViewItem {
            id: a.id.clone(),
            path: a.path.clone(),
            category_id: a.category_id.clone(),
            is_dir: a.kind != "file",
        })
        .collect();
    let identities = snapshot
        .assets
        .iter()
        .filter_map(|a| {
            a.identity
                .as_ref()
                .map(|identity| (a.id.clone(), identity.clone()))
        })
        .collect();
    Ok(Projection {
        categories,
        items,
        identities,
    })
}

pub fn sync_projection(core: &mut Core, id: &str, import: bool) -> Result<Vec<String>> {
    let initial = core.snapshot(id)?;
    if !initial.vault.view_enabled && !initial.vault.root.join(".vaulta-views").exists() {
        return Ok(Vec::new());
    }
    let root = core.checked_root(id)?;
    let data = view_data(&initial)?;
    let enabled = initial.vault.view_enabled;
    let mut report = disk::sync_view_checked(
        &root,
        id,
        &data.categories,
        &data.items,
        enabled,
        import,
        &data.identities,
    )?;
    if !report.changes.is_empty() {
        for change in &report.changes {
            if checked_asset(core, id, &change.id).is_err() {
                continue;
            }
            let action = serde_json::from_value(serde_json::json!({
                "type": "organize", "ids": [change.id], "category_id": change.category_id,
            }))?;
            if let Err(err) = core.mutate(id, action, "disk-view") {
                // Do not attempt an export if the detected external intent could not be applied.
                return Err(anyhow!("无法应用资源管理器里的分类变更：{err}"));
            }
        }
        let updated = core.snapshot(id)?;
        let data = view_data(&updated)?;
        report.warnings.extend(
            disk::sync_view_checked(
                &root,
                id,
                &data.categories,
                &data.items,
                enabled,
                false,
                &data.identities,
            )?
            .warnings,
        );
    }
    Ok(report.warnings)
}

pub fn projection_notice(app: &AppHandle, core: &mut Core, id: &str, import: bool) {
    match sync_projection(core, id, import) {
        Ok(warnings) if !warnings.is_empty() => warn(app, id, &warnings.join("\n")),
        Err(err) => warn(app, id, &format!("磁盘分类视图未同步：{err:#}")),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn relative_stays_inside_on_component_boundary() {
        let root = Path::new(r"C:\Work\Images");
        assert_eq!(
            relative(root, Path::new(r"C:\work\images\a\b.png")).as_deref(),
            Some("a/b.png")
        );
        assert!(relative(root, Path::new(r"C:\Work\Images2\b.png")).is_none());
        assert!(relative(root, Path::new(r"C:\Work\Images\..\b.png")).is_none());
    }
    #[test]
    fn categories_are_tree_paths_and_cycles_rejected() {
        let nodes = HashMap::from([
            ("a", ("A", None)),
            ("b", ("B", Some("a"))),
            ("c", ("C", Some("c"))),
        ]);
        assert_eq!(category_path("b", &nodes).unwrap(), vec!["A", "B"]);
        assert!(category_path("c", &nodes).is_err());
    }
}
