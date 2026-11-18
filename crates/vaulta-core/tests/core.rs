#![cfg(windows)]

use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;
use vaulta_core::{identity, Asset, Core, Mutation, Vault};

struct Setup {
    temp: TempDir,
    db: PathBuf,
    root: PathBuf,
    core: Core,
    vault: Vault,
}

impl Setup {
    fn new() -> Self {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        let db = temp.path().join("meta.db");
        fs::create_dir(&root).unwrap();
        let mut core = Core::open(&db).unwrap();
        let vault = core
            .add_vault(&root.canonicalize().unwrap(), "Test")
            .unwrap();
        Self {
            temp,
            db,
            root,
            core,
            vault,
        }
    }
    fn scan(&mut self) {
        self.core.scan(&self.vault.id).unwrap();
    }
    fn path(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
    fn put(&self, rel: &str) {
        fs::write(self.path(rel), b"sample file bytes").unwrap();
    }
    fn asset(&self, rel: &str) -> Asset {
        self.core
            .snapshot(&self.vault.id)
            .unwrap()
            .assets
            .into_iter()
            .find(|a| a.path == rel && a.state != "missing")
            .unwrap_or_else(|| panic!("no live asset: {rel}"))
    }
    fn action(&mut self, value: Value) {
        run(&mut self.core, &self.vault.id, value).unwrap();
    }
}

fn run(core: &mut Core, id: &str, value: Value) -> vaulta_core::Result<()> {
    core.mutate(
        id,
        serde_json::from_value(value).unwrap(),
        "integration-test",
    )
}

#[test]
fn reconcile_rename_exclusion_copy_and_replacement() {
    let mut s = Setup::new();
    s.put("old.txt");
    s.scan();
    let orig = s.asset("old.txt");
    assert_eq!(orig.identity, identity(&s.path("old.txt")).unwrap());
    assert_eq!(orig.state, "inbox");
    assert_eq!(orig.size, 17);
    assert!(orig.created > 0 && orig.modified > 0);
    s.action(json!({"type":"organize","ids":[orig.id],"add_tags":["Doc"],"add_flags":["Important"],"state":"excluded"}));
    fs::rename(s.path("old.txt"), s.path("renamed.txt")).unwrap();
    fs::copy(s.path("renamed.txt"), s.path("copy.txt")).unwrap();
    s.scan();
    let moved = s.asset("renamed.txt");
    assert_eq!(moved.id, orig.id);
    assert_eq!(moved.identity, orig.identity);
    assert_eq!(moved.tags, ["Doc"]);
    assert_eq!(moved.flags, ["Important"]);
    assert_eq!(moved.state, "excluded");
    let copied = s.asset("copy.txt");
    assert_ne!(copied.identity, orig.identity);
    assert_ne!(copied.id, orig.id);
    assert!(copied.tags.is_empty());

    // Replace while retaining the old file on the same volume outside the vault.
    let backup = s.temp.path().join("backup");
    fs::rename(s.path("renamed.txt"), &backup).unwrap();
    s.put("renamed.txt");
    s.scan();
    let replacement = s.asset("renamed.txt");
    assert_ne!(replacement.id, orig.id);
    assert_eq!(replacement.state, "inbox");
    let missing = s.core.asset(&s.vault.id, &orig.id).unwrap();
    assert_eq!(missing.tags, ["Doc"]);
    assert_eq!(missing.state, "missing");
    s.action(json!({"type":"recover_identity","missing_id":orig.id,"present_id":replacement.id}));
    assert_eq!(s.asset("renamed.txt").id, orig.id);
    assert_eq!(s.asset("renamed.txt").state, "excluded");
}

#[test]
fn tracks_hard_link_aliases_separately_and_does_not_guess_at_rename() {
    let mut s = Setup::new();
    s.put("a");
    fs::hard_link(s.path("a"), s.path("b")).unwrap();
    s.scan();
    let a = s.asset("a");
    let b = s.asset("b");
    assert_ne!(a.id, b.id);
    assert_eq!(a.identity, b.identity);
    s.action(json!({"type":"organize","ids":[a.id],"add_tags":["Only a"]}));
    fs::rename(s.path("a"), s.path("c")).unwrap();
    s.scan();
    assert_eq!(s.asset("b").id, b.id);
    let c = s.asset("c");
    assert_ne!(c.id, a.id);
    assert!(c.tags.is_empty());
    assert_eq!(s.core.asset(&s.vault.id, &a.id).unwrap().state, "missing");
}

#[test]
fn root_outage_replacement_and_reattach_are_fail_closed() {
    let mut s = Setup::new();
    s.put("a");
    s.scan();
    let orig = s.asset("a");
    let db2 = Core::open(&s.db).unwrap();
    let revision = db2.revision().unwrap();
    s.scan();
    assert_eq!(db2.revision().unwrap(), revision);
    let held = s.temp.path().join("held");
    fs::rename(&s.root, &held).unwrap();
    assert!(s.core.checked_root(&s.vault.id).is_err());
    s.scan();
    assert_eq!(s.core.get_vault(&s.vault.id).unwrap().status, "unavailable");
    fs::create_dir(&s.root).unwrap();
    s.put("replacement.txt");
    assert!(s.core.checked_root(&s.vault.id).is_err());
    let down_revision = db2.revision().unwrap();
    s.scan();
    assert_eq!(db2.revision().unwrap(), down_revision);
    assert_eq!(
        s.core.snapshot(&s.vault.id).unwrap().assets,
        std::slice::from_ref(&orig)
    );
    fs::remove_file(s.path("replacement.txt")).unwrap();
    fs::remove_dir(&s.root).unwrap();
    fs::rename(&held, &s.root).unwrap();
    assert_eq!(s.core.checked_root(&s.vault.id).unwrap(), s.vault.root);
    s.scan();
    assert_eq!(s.core.get_vault(&s.vault.id).unwrap().status, "ready");
    assert_eq!(s.asset("a").id, orig.id);
    assert!(s.core.add_vault(&s.root, "Duplicate").is_err());
    assert!(s.core.add_vault(s.temp.path(), "Overlapping").is_err());
    s.core.set_agent_access(&s.vault.id, "write").unwrap();
    s.core.remove_vault(&s.vault.id).unwrap();
    assert!(db2.vaults().unwrap().is_empty());
    assert!(db2.get_vault(&s.vault.id).is_err());
    let same = s.core.add_vault(&s.root, "Restored").unwrap();
    assert_eq!(same.id, s.vault.id);
    assert_eq!(s.asset("a").id, orig.id);
    assert_eq!(db2.agent_access(&s.vault.id).unwrap(), "off");
}

fn junction(link: &Path, target: &Path) {
    let result = Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{} {}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

#[test]
fn skips_reserved_and_junction_paths_including_ancestor_roots() {
    let mut s = Setup::new();
    let external = s.temp.path().join("ext");
    fs::create_dir_all(external.join("nested")).unwrap();
    fs::write(external.join("nested/a"), b"outside").unwrap();
    junction(&s.path("junction"), &external);
    fs::create_dir(s.path(".VaUlTa-Views")).unwrap();
    s.put(".VaUlTa-Views/ignore.txt");
    s.scan();
    assert!(s.core.snapshot(&s.vault.id).unwrap().assets.is_empty());
    assert_eq!(identity(&s.path("junction")).unwrap(), None);
    assert!(identity(&s.path("junction/nested/a")).is_err());
    assert!(s.core.add_vault(&s.path("junction"), "Junction").is_err());
    let alias = s.temp.path().join("alias");
    junction(&alias, &external);
    assert!(s
        .core
        .add_vault(&alias.join("nested"), "Alias nested")
        .is_err());
    fs::remove_dir(&alias).unwrap();
    fs::remove_dir(s.path("junction")).unwrap();
}

#[test]
fn partial_scan_preserves_old_rows_and_recovers() {
    let mut s = Setup::new();
    s.put("gone");
    s.scan();
    let orig = s.asset("gone");
    fs::remove_file(s.path("gone")).unwrap();
    s.put("visible");
    // A verbatim Windows path lets us create a name the app cannot represent safely.
    let absolute = s.root.canonicalize().unwrap();
    let unsupported = absolute.join("unrepresentable.");
    fs::write(&unsupported, b"bad name").unwrap();
    s.scan();
    assert_eq!(s.core.get_vault(&s.vault.id).unwrap().status, "partial");
    assert_eq!(s.core.asset(&s.vault.id, &orig.id).unwrap().state, "inbox");
    assert_eq!(s.asset("visible").state, "inbox");
    fs::remove_file(unsupported).unwrap();
    s.scan();
    assert_eq!(s.core.get_vault(&s.vault.id).unwrap().status, "ready");
    assert_eq!(
        s.core.asset(&s.vault.id, &orig.id).unwrap().state,
        "missing"
    );
}

#[test]
fn units_rebind_after_move_and_never_follow_a_replacement() {
    let mut s = Setup::new();
    fs::create_dir_all(s.path("folder/whole")).unwrap();
    s.put("folder/whole/inner");
    s.scan();
    let unit = s.asset("folder/whole");
    let child = s.core.open_unit(&s.vault.id, &unit.id).unwrap();
    assert_eq!(child.parent_id.as_ref(), Some(&s.vault.id));
    assert_eq!(child.unit_id.as_ref(), Some(&unit.id));
    assert_eq!(s.asset("folder/whole").kind, "unit");
    assert_eq!(
        s.core.open_unit(&s.vault.id, &unit.id).unwrap().id,
        child.id
    );
    assert_eq!(s.core.vaults().unwrap().len(), 2);
    assert!(!s
        .core
        .snapshot(&s.vault.id)
        .unwrap()
        .assets
        .iter()
        .any(|a| a.path.ends_with("/inner")));
    s.core.scan(&child.id).unwrap();
    let child_asset = s.core.snapshot(&child.id).unwrap().assets.pop().unwrap();
    assert_eq!(child_asset.path, "inner");
    run(
        &mut s.core,
        &child.id,
        json!({"type":"organize","ids":[child_asset.id],"add_tags":["Inner"]}),
    )
    .unwrap();
    fs::rename(s.path("folder"), s.path("renamed")).unwrap();
    fs::create_dir_all(s.path("folder/whole")).unwrap();
    assert!(s.core.checked_root(&child.id).is_err());
    s.scan();
    assert_eq!(
        s.core.checked_root(&child.id).unwrap(),
        s.vault.root.join("renamed/whole")
    );
    s.core.scan(&child.id).unwrap();
    assert_eq!(
        s.core.asset(&child.id, &child_asset.id).unwrap().tags,
        ["Inner"]
    );
    fs::rename(s.path("renamed/whole"), s.temp.path().join("removed-unit")).unwrap();
    fs::create_dir(s.path("renamed/whole")).unwrap();
    s.put("renamed/whole/new");
    s.scan();
    assert!(s.core.checked_root(&child.id).is_err());
    s.core.scan(&child.id).unwrap();
    assert_eq!(s.core.get_vault(&child.id).unwrap().status, "unavailable");
    assert_eq!(s.core.snapshot(&child.id).unwrap().assets.len(), 1);
    assert_eq!(
        s.core.asset(&child.id, &child_asset.id).unwrap().state,
        "inbox"
    );
    assert_eq!(s.asset("renamed/whole").kind, "directory");
}

#[test]
fn rebind_supports_atomic_save_but_not_implicit_unrelated_moves() {
    let mut s = Setup::new();
    s.put("name");
    s.scan();
    let orig = s.asset("name");
    s.action(json!({"type":"organize","ids":[orig.id],"add_tags":["Kept"]}));
    s.put("another");
    assert!(s.core.rebind(&s.vault.id, &orig.id, "another").is_err());
    assert!(s
        .core
        .rebind(&s.vault.id, &orig.id, ".vaulta-views/secret")
        .is_err());
    assert!(s.core.rebind(&s.vault.id, &orig.id, "../escape").is_err());
    let old = s.temp.path().join("prior");
    fs::rename(s.path("name"), &old).unwrap();
    fs::rename(s.path("another"), s.path("name")).unwrap();
    s.core.rebind(&s.vault.id, &orig.id, "name").unwrap();
    s.scan();
    let current = s.asset("name");
    assert_eq!(current.id, orig.id);
    assert_ne!(current.identity, orig.identity);
    assert_eq!(current.tags, ["Kept"]);
    fs::rename(s.path("name"), s.path("moved")).unwrap();
    s.core.rebind(&s.vault.id, &orig.id, "moved").unwrap();
    assert_eq!(s.asset("moved").id, orig.id);
}

#[test]
fn logical_batches_validation_and_undo_across_connections() {
    let mut s = Setup::new();
    s.put("a");
    s.scan();
    let a = s.asset("a");
    let mut external = Core::open(&s.db).unwrap();
    assert_eq!(external.agent_access(&s.vault.id).unwrap(), "off");
    assert!(s.core.set_agent_access(&s.vault.id, "execute").is_err());
    s.core.set_agent_access(&s.vault.id, "read").unwrap();
    assert_eq!(external.agent_access(&s.vault.id).unwrap(), "read");
    s.action(json!({"type":"category_save","name":"Parent"}));
    let parent = s
        .core
        .snapshot(&s.vault.id)
        .unwrap()
        .categories
        .into_iter()
        .find(|c| c.name == "Parent")
        .unwrap()
        .id;
    s.action(json!({"type":"category_save","name":"Child","parent_id":parent}));
    let child = external
        .snapshot(&s.vault.id)
        .unwrap()
        .categories
        .into_iter()
        .find(|c| c.name == "Child")
        .unwrap()
        .id;
    let revision = external.revision().unwrap();
    assert!(run(
        &mut s.core,
        &s.vault.id,
        json!({"type":"category_save","id":parent,"name":"Parent","parent_id":child})
    )
    .is_err());
    assert!(run(
        &mut s.core,
        &s.vault.id,
        json!({"type":"organize","ids":[a.id,"bogus"],"add_tags":["not committed"]})
    )
    .is_err());
    assert_eq!(external.revision().unwrap(), revision);
    s.action(json!({"type":"organize","ids":[a.id],"category_id":parent,"add_tags":["One"],"add_flags":["Pin"],"state":"filed"}));
    run(
        &mut external,
        &s.vault.id,
        json!({"type":"organize","ids":[a.id],"add_tags":["Two"]}),
    )
    .unwrap();
    assert_eq!(s.asset("a").category_id.as_deref(), Some(parent.as_str()));
    s.action(json!({"type":"organize","ids":[a.id],"category_id":null}));
    assert_eq!(s.asset("a").category_id, None);
    s.action(json!({"type":"undo"}));
    assert_eq!(s.asset("a").category_id.as_deref(), Some(parent.as_str()));
    s.action(json!({"type":"category_delete","id":parent,"reassign_to":child}));
    assert_eq!(s.asset("a").category_id.as_deref(), Some(child.as_str()));
    assert_eq!(
        external
            .snapshot(&s.vault.id)
            .unwrap()
            .categories
            .into_iter()
            .find(|c| c.id == child)
            .unwrap()
            .parent_id,
        None
    );
    s.action(json!({"type":"undo"}));
    assert_eq!(s.asset("a").category_id.as_deref(), Some(parent.as_str()));
    s.action(json!({"type":"tag_rename","name":"One","new_name":"Uno"}));
    assert_eq!(s.asset("a").tags, ["Two", "Uno"]);
    s.action(json!({"type":"tag_delete","name":"Two"}));
    assert_eq!(s.asset("a").tags, ["Uno"]);
    s.action(json!({"type":"undo"}));
    assert_eq!(s.asset("a").tags, ["Two", "Uno"]);
    assert!(external
        .snapshot(&s.vault.id)
        .unwrap()
        .history
        .iter()
        .any(|h| h.message.contains("Agent access")));
    assert!(s.path("a").is_file());
    let both = serde_json::to_value(
        serde_json::from_value::<Mutation>(json!({"type":"organize","ids":[],"category_id":null}))
            .unwrap(),
    )
    .unwrap();
    assert!(both.get("category_id").is_some_and(|v| v.is_null()));
    let omitted = serde_json::to_value(
        serde_json::from_value::<Mutation>(json!({"type":"organize","ids":[]})).unwrap(),
    )
    .unwrap();
    assert!(omitted.get("category_id").is_none());
}

#[test]
fn simultaneous_connections_do_not_lose_updates() {
    let mut s = Setup::new();
    s.put("a");
    s.scan();
    let a = s.asset("a");
    let revision = s.core.revision().unwrap();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(4));
    std::thread::scope(|scope| {
        for i in 0..4 {
            let barrier = barrier.clone();
            let db = &s.db;
            let id = &s.vault.id;
            let asset_id = &a.id;
            scope.spawn(move || {
                let mut core = Core::open(db).unwrap();
                barrier.wait();
                run(
                    &mut core,
                    id,
                    json!({"type":"organize","ids":[asset_id],"add_tags":[format!("thread {i}")]}),
                )
                .unwrap();
            });
        }
    });
    assert_eq!(s.core.revision().unwrap(), revision + 4);
    assert_eq!(s.asset("a").tags.len(), 4);
}

#[test]
fn a_folder_cannot_wrap_an_existing_unit_or_strand_its_vault() {
    let mut s = Setup::new();
    fs::create_dir_all(s.path("outer/inner")).unwrap();
    s.put("outer/inner/data");
    s.scan();
    let outer = s.asset("outer");
    let inner = s.asset("outer/inner");
    let unit = s.core.open_unit(&s.vault.id, &inner.id).unwrap();
    let rev = s.core.revision().unwrap();
    assert!(s.core.open_unit(&s.vault.id, &outer.id).is_err());
    assert_eq!(s.core.revision().unwrap(), rev);
    assert_eq!(s.asset("outer").kind, "directory");
    assert_eq!(s.core.checked_root(&unit.id).unwrap(), unit.root);
    s.core.scan(&unit.id).unwrap();
    assert_eq!(s.core.snapshot(&unit.id).unwrap().assets[0].path, "data");
}

#[test]
fn view_and_organize_noops_do_not_advance_revision() {
    let mut s = Setup::new();
    s.put("entry");
    s.scan();
    let asset = s.asset("entry");
    let categories = s.core.snapshot(&s.vault.id).unwrap().categories;
    assert!(!categories.is_empty());
    s.action(json!({"type":"view_config","enabled":true,"categories":[categories[0].id]}));
    let rev = s.core.revision().unwrap();
    s.action(json!({"type":"view_config","enabled":true,"categories":[categories[0].id,categories[0].id]}));
    s.action(json!({"type":"organize","ids":[asset.id],"state":"inbox"}));
    s.core.set_agent_access(&s.vault.id, "off").unwrap();
    s.scan();
    assert_eq!(s.core.revision().unwrap(), rev);
    s.action(json!({"type":"category_delete","id":categories[0].id}));
    let vault = s.core.get_vault(&s.vault.id).unwrap();
    assert!(
        !vault.view_enabled,
        "deleting the only selected category must not widen the view"
    );
    s.action(json!({"type":"undo"}));
    let vault = s.core.get_vault(&s.vault.id).unwrap();
    assert!(vault.view_enabled);
    assert_eq!(vault.view_categories, [categories[0].id.clone()]);
}

#[test]
fn scan_suggests_categories_and_filing_fills_the_gap() {
    let mut s = Setup::new();
    fs::create_dir_all(s.path("文档")).unwrap();
    s.put("文档/计划.md");
    s.put("封面.PNG");
    s.put("素材.tar.gz");
    s.put("license.bin");
    s.scan();

    let categories = s.core.snapshot(&s.vault.id).unwrap().categories;
    let name = |asset: &Asset| {
        asset
            .category_id
            .as_ref()
            .and_then(|id| categories.iter().find(|c| &c.id == id))
            .map(|c| c.name.as_str())
    };
    assert_eq!(name(&s.asset("文档/计划.md")), Some("文档"));
    assert_eq!(name(&s.asset("封面.PNG")), Some("图片"));
    assert_eq!(name(&s.asset("素材.tar.gz")), Some("压缩包"));
    assert!(s.asset("license.bin").category_id.is_none());
    // A suggestion is not adoption: the asset still waits in the inbox.
    assert_eq!(s.asset("文档/计划.md").state, "inbox");

    let doc = s.asset("文档/计划.md");
    s.action(json!({"type":"organize","ids":[doc.id],"category_id":null}));
    assert!(s.asset("文档/计划.md").category_id.is_none());
    // Filing names the category again when the user did not choose one.
    s.action(json!({"type":"organize","ids":[doc.id],"state":"filed"}));
    let filed = s.asset("文档/计划.md");
    assert_eq!(filed.state, "filed");
    assert_eq!(name(&filed), Some("文档"));
}
