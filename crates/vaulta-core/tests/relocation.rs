#![cfg(windows)]

use std::{fs, path::Path};

use serde_json::{json, Value};
use vaulta_core::{Core, Vault};

fn add(core: &mut Core, root: &Path, name: &str) -> Vault {
    fs::create_dir_all(root).unwrap();
    core.add_vault(root, name).unwrap()
}

fn change(core: &mut Core, vault: &str, action: Value) {
    core.mutate(vault, serde_json::from_value(action).unwrap(), "test")
        .unwrap();
}

#[test]
fn relocation_preserves_inventory_metadata_and_nested_vaults_after_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let old = temp.path().join("before").join("repository");
    let new_parent = temp.path().join("after");
    let new = new_parent.join("Renamed vault");
    let db = temp.path().join("metadata.sqlite3");
    let mut core = Core::open(&db).unwrap();
    let v = add(&mut core, &old, "Original display name");
    fs::create_dir(old.join("unit")).unwrap();
    fs::write(old.join("note.txt"), "top").unwrap();
    fs::write(old.join("unit/photo.jpg"), "child").unwrap();
    core.scan(&v.id).unwrap();
    let snap = core.snapshot(&v.id).unwrap();
    let asset = snap.assets.iter().find(|a| a.path == "note.txt").unwrap();
    let asset_id = asset.id.clone();
    let category = snap.categories[0].id.clone();
    let unit = snap.assets.iter().find(|a| a.path == "unit").unwrap();
    let child = core.open_unit(&v.id, &unit.id).unwrap();
    core.scan(&child.id).unwrap();
    let child_asset = core.snapshot(&child.id).unwrap().assets.remove(0);
    change(
        &mut core,
        &v.id,
        json!({"type":"organize","ids":[asset_id],"category_id":category,"add_tags":["Saved"],"add_flags":["Flag"],"state":"filed"}),
    );
    change(
        &mut core,
        &v.id,
        json!({"type":"view_config","enabled":true,"categories":[category]}),
    );
    change(
        &mut core,
        &child.id,
        json!({"type":"organize","ids":[child_asset.id],"add_tags":["Child tag"]}),
    );
    core.set_agent_access(&v.id, "read").unwrap();

    fs::create_dir(&new_parent).unwrap();
    fs::rename(&old, &new).unwrap();
    // Indexing while offline must not discard old assets before relocation.
    core.scan(&v.id).unwrap();
    core.scan(&child.id).unwrap();
    assert_eq!(core.get_vault(&v.id).unwrap().status, "unavailable");
    let revision = core.revision().unwrap();
    let relocated = core.relocate_vault(&v.id, &new).unwrap();
    assert_eq!(relocated.id, v.id);
    assert_eq!(relocated.name, v.name);
    assert_eq!(relocated.status, "ready");
    assert_eq!(core.revision().unwrap(), revision + 1);
    assert_eq!(
        core.checked_root(&child.id).unwrap(),
        relocated.root.join("unit")
    );
    assert_eq!(core.asset(&v.id, &asset_id).unwrap().tags, ["Saved"]);
    // A repeated request for the same canonical location is a no-op.
    core.relocate_vault(&v.id, &new).unwrap();
    assert_eq!(core.revision().unwrap(), revision + 1);
    drop(core);

    let mut core = Core::open(&db).unwrap();
    core.scan(&v.id).unwrap();
    core.scan(&child.id).unwrap();
    let updated = core.asset(&v.id, &asset_id).unwrap();
    assert_eq!(updated.identity, asset.identity);
    assert_eq!(updated.flags, ["Flag"]);
    assert_eq!(updated.tags, ["Saved"]);
    assert_eq!(updated.category_id.as_deref(), Some(category.as_str()));
    assert_eq!(updated.state, "filed");
    let snapshot = core.snapshot(&v.id).unwrap();
    assert!(snapshot.vault.view_enabled);
    assert_eq!(snapshot.vault.view_categories, [category]);
    assert!(snapshot
        .history
        .iter()
        .any(|entry| entry.message.starts_with("Relocated vault")));
    assert_eq!(core.agent_access(&v.id).unwrap(), "read");
    let updated_child = core.asset(&child.id, &child_asset.id).unwrap();
    assert_eq!(updated_child.identity, child_asset.identity);
    assert_eq!(updated_child.tags, ["Child tag"]);
    assert_ne!(updated_child.state, "missing");
    assert_eq!(
        core.get_vault(&child.id).unwrap().root,
        relocated.root.join("unit")
    );
}

#[test]
fn relocation_refuses_unrelated_replacements_and_overlaps_without_writing() {
    let temp = tempfile::tempdir().unwrap();
    let mut core = Core::open(&temp.path().join("meta.sqlite3")).unwrap();
    let old = temp.path().join("old");
    let v = add(&mut core, &old, "Moving");
    let other = temp.path().join("registered");
    add(&mut core, &other, "Other");
    fs::write(old.join("same.txt"), "same contents").unwrap();
    core.scan(&v.id).unwrap();
    let copy = temp.path().join("copy");
    fs::create_dir(&copy).unwrap();
    fs::copy(old.join("same.txt"), copy.join("same.txt")).unwrap();
    let nested = other.join("nested");
    fs::rename(&old, &nested).unwrap();
    fs::create_dir(&old).unwrap();
    let revision = core.revision().unwrap();
    for unrelated in [&old, &copy] {
        assert!(core
            .relocate_vault(&v.id, unrelated)
            .unwrap_err()
            .to_string()
            .contains("不是原仓库"));
    }
    for overlap in [&nested, &other, &temp.path().to_owned()] {
        assert!(core
            .relocate_vault(&v.id, overlap)
            .unwrap_err()
            .to_string()
            .contains("重叠"));
    }
    for invalid in [copy.join("gone"), copy.join("same.txt"), "relative".into()] {
        assert!(core.relocate_vault(&v.id, &invalid).is_err());
    }
    assert_eq!(core.revision().unwrap(), revision);
    assert_eq!(core.get_vault(&v.id).unwrap().root, v.root);
    assert_eq!(core.snapshot(&v.id).unwrap().assets.len(), 1);
    let new = temp.path().join("now-safe");
    fs::rename(nested, &new).unwrap();
    assert_eq!(core.relocate_vault(&v.id, &new).unwrap().id, v.id);
}

#[test]
fn relocation_is_only_for_attached_top_level_vaults() {
    let temp = tempfile::tempdir().unwrap();
    let mut core = Core::open(&temp.path().join("meta.sqlite3")).unwrap();
    let root = temp.path().join("vault");
    let v = add(&mut core, &root, "Moving");
    fs::create_dir(root.join("unit")).unwrap();
    core.scan(&v.id).unwrap();
    let unit = core.snapshot(&v.id).unwrap().assets.remove(0);
    let child = core.open_unit(&v.id, &unit.id).unwrap();
    assert!(core.relocate_vault(&child.id, &root.join("unit")).is_err());
    core.remove_vault(&v.id).unwrap();
    let revision = core.revision().unwrap();
    assert!(core.relocate_vault(&v.id, &root).is_err());
    assert_eq!(core.revision().unwrap(), revision);
    assert!(core.vaults().unwrap().is_empty());
}
