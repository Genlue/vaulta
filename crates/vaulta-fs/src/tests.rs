use super::*;
use std::{fs, path::Path};
use tempfile::TempDir;
use windows::Win32::Storage::FileSystem::FILE_SHARE_READ;

fn temp() -> TempDir {
    // Explicitly put test assets on the current workspace volume. No user-owned file is used.
    tempfile::Builder::new()
        .prefix("fs-test-")
        .tempdir_in(env!("CARGO_MANIFEST_DIR"))
        .unwrap()
}
fn native_key_from_key(key: &str) -> &str {
    key.rsplit_once(':').unwrap().0
}
fn native_key(root: &Path, rel: &str) -> String {
    native_key_from_key(&key(root, rel)).to_owned()
}
fn key(root: &Path, rel: &str) -> String {
    let a = path::Asset::open(root, rel, 0, FILE_SHARE_READ).unwrap();
    path::identity_key(&a.file, &a.path).unwrap()
}

#[test]
fn rename_move_and_mkdir_never_clobber() {
    let t = temp();
    let root = t.path();
    fs::write(root.join("one.txt"), b"one").unwrap();
    fs::write(root.join("two.txt"), b"two").unwrap();
    assert!(matches!(
        rename(root, "one.txt", "TWO.TXT"),
        Err(Error::Collision(_))
    ));
    assert!(matches!(
        rename_checked(root, "one.txt", "other.txt", &key(root, "two.txt")),
        Err(Error::Conflict)
    ));
    let id = key(root, "one.txt");
    assert_eq!(
        rename_checked(root, "one.txt", "sp ace.txt", &id).unwrap(),
        "sp ace.txt"
    );
    assert_eq!(mkdir(root, "", "in").unwrap(), "in");
    assert!(matches!(mkdir(root, "", "IN"), Err(Error::Collision(_))));
    let to = root.join("in");
    fs::write(to.join("sp ace.txt"), b"not mine").unwrap();
    assert!(matches!(
        move_asset(root, "sp ace.txt", &to),
        Err(Error::Collision(_))
    ));
    assert_eq!(fs::read(to.join("sp ace.txt")).unwrap(), b"not mine");
    fs::remove_file(to.join("sp ace.txt")).unwrap();
    assert_eq!(
        move_asset_checked(root, "sp ace.txt", &to, &id).unwrap(),
        to.join("sp ace.txt")
    );
    assert_eq!(native_key(root, "in/sp ace.txt"), native_key_from_key(&id));
    assert_eq!(fs::read(root.join("two.txt")).unwrap(), b"two");
}

#[test]
fn validation_and_shell_refusals() {
    let t = temp();
    let root = t.path();
    for p in [
        "/foo",
        "C:foo",
        "a//b",
        "a/../b",
        "./name",
        "a/",
        r"\\?\C:\name",
        "foo. ",
        "x:stream",
        "nul.txt",
        "COM¹.md",
        "A/.VAULTA-VIEWS/b",
    ] {
        assert!(
            matches!(resolve(root, p), Err(Error::InvalidPath(_))),
            "{p}"
        );
    }
    assert!(rename(root, "ignored", ".VaUlTa-ViEwS").is_err());
    fs::write(root.join("demo.ps1"), "test").unwrap();
    assert!(matches!(
        open(root, "demo.ps1", "default", true),
        Err(Error::Refused(_))
    ));
    assert!(matches!(
        open(root, "demo.ps1", "choose", true),
        Err(Error::Refused(_))
    ));
    assert!(matches!(
        open(root, "demo.ps1", "run", false),
        Err(Error::Refused(_))
    ));
    assert!(matches!(
        open(root, "demo.ps1", "run", true),
        Err(Error::Unsupported(_))
    ));
    assert!(matches!(
        open_checked(root, "demo.ps1", "reveal", false, "wrong"),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        recycle_checked(root, "demo.ps1", "wrong"),
        Err(Error::Conflict)
    ));
    fs::write(root.join("fake.txt"), b"MZ\0\0").unwrap();
    assert!(matches!(
        open(root, "fake.txt", "default", false),
        Err(Error::Refused(_))
    ));
    assert!(root.join("demo.ps1").exists());
}

#[test]
fn preview_search_and_duplicates() {
    let t = temp();
    let root = t.path();
    fs::write(
        root.join("markup.html"),
        b"\xef\xbb\xbf<script>Forbidden()</script>",
    )
    .unwrap();
    fs::copy(root.join("markup.html"), root.join("same.txt")).unwrap();
    fs::write(root.join("fake.png"), b"<html>").unwrap();
    fs::write(root.join("image.png"), b"\x89PNG\r\n\x1a\n").unwrap();
    fs::write(root.join("payload.svg"), b"<svg onload='x()'>").unwrap();
    fs::File::create(root.join("big.txt"))
        .unwrap()
        .set_len(2 * 1024 * 1024 + 1)
        .unwrap();
    let p = preview(root, "markup.html").unwrap();
    assert_eq!(p.kind, PreviewKind::Text);
    assert_eq!(p.text.as_deref(), Some("<script>Forbidden()</script>"));
    assert!(p.data_url.is_none());
    assert_eq!(p.mime.as_deref(), Some("text/plain"));
    assert!(text_matches(root, "markup.html", "FORBIDDEN").unwrap());
    for name in ["fake.png", "payload.svg", "big.txt"] {
        assert_eq!(preview(root, name).unwrap().kind, PreviewKind::Unsupported);
        assert!(!text_matches(root, name, "").unwrap());
    }
    assert!(preview(root, "image.png")
        .unwrap()
        .data_url
        .unwrap()
        .starts_with("data:image/png;base64,"));
    assert_eq!(
        duplicate_groups(
            root,
            &[
                "markup.html".into(),
                "MARKUP.HTML".into(),
                "same.txt".into(),
                "image.png".into()
            ]
        )
        .unwrap(),
        vec![vec!["markup.html", "same.txt"]]
    );
}

#[test]
fn atomic_save_preserves_identity_and_rejects_stale_snapshots() {
    let t = temp();
    let root = t.path();
    let p = root.join("one.txt");
    fs::write(&p, b"\xef\xbb\xbfhello").unwrap();
    let original_id = key(root, "one.txt");
    let revision = preview(root, "one.txt").unwrap().revision.unwrap();
    fs::write(&p, b"outside edit").unwrap();
    assert!(matches!(
        save_text(root, "one.txt", &revision, "inside edit"),
        Err(Error::Conflict)
    ));
    assert_eq!(fs::read(&p).unwrap(), b"outside edit");
    fs::write(&p, b"\xef\xbb\xbfhello").unwrap();
    let stamp =
        save_text_verified_checked(root, "one.txt", &revision, "new", &original_id).unwrap();
    assert_eq!(stamp.path, p);
    assert_eq!(fs::read(&p).unwrap(), b"\xef\xbb\xbfnew");
    assert_eq!(key(root, "one.txt"), original_id);
    assert_eq!(
        preview(root, "one.txt").unwrap().revision.unwrap(),
        stamp.revision
    );
    fs::rename(&p, root.join("archived.txt")).unwrap();
    fs::write(&p, b"\xef\xbb\xbfnew").unwrap();
    assert!(matches!(
        save_text(root, "one.txt", &stamp.revision, "stale"),
        Err(Error::Conflict)
    ));
    assert!(matches!(
        save_text_verified_checked(root, "one.txt", &stamp.revision, "stale", &original_id),
        Err(Error::Conflict)
    ));
    let revision = preview(root, "one.txt").unwrap().revision.unwrap();
    fs::hard_link(&p, root.join("alias.txt")).unwrap();
    assert!(preview(root, "one.txt").unwrap().revision.is_none());
    assert!(matches!(
        save_text(root, "one.txt", &revision, "stale"),
        Err(Error::Refused(_))
    ));
    assert_eq!(
        fs::read(root.join("alias.txt")).unwrap(),
        b"\xef\xbb\xbfnew"
    );
}

#[test]
#[ignore = "uses the real Windows Recycle Bin; run explicitly on a fixed local volume"]
fn recycle_only_on_disposable_file() {
    let t = temp();
    let root = t.path();
    let file = root.join("recycle-test.txt");
    fs::write(&file, b"disposable test fixture").unwrap();
    recycle_checked(root, "recycle-test.txt", &key(root, "recycle-test.txt")).unwrap();
    assert!(!file.exists());
    fs::create_dir(root.join("bin-test-dir")).unwrap();
    fs::write(root.join("bin-test-dir/child.txt"), "disposable child").unwrap();
    recycle(root, "bin-test-dir").unwrap();
    assert!(!root.join("bin-test-dir").exists());
}

#[test]
fn projection_import_apply_and_cleanup() {
    use std::os::windows::fs::{symlink_dir, symlink_file};
    let t = temp();
    let root = t.path();
    let target = root.join("a.txt");
    fs::write(&target, "data").unwrap();
    fs::create_dir(root.join("unit")).unwrap();
    let categories = [
        ViewCategory {
            id: "c1".into(),
            path: vec!["A".into()],
        },
        ViewCategory {
            id: "c2".into(),
            path: vec!["B".into()],
        },
    ];
    let mut items = [
        ViewItem {
            id: "a".into(),
            path: "a.txt".into(),
            category_id: Some("c1".into()),
            is_dir: false,
        },
        ViewItem {
            id: "u".into(),
            path: "unit".into(),
            category_id: Some("c1".into()),
            is_dir: true,
        },
    ];
    let v = root.join(VIEW_DIR);
    let a = v.join("A/a.txt");
    let b = v.join("B/a.txt");
    let first = sync_view(root, "test", &categories, &items, true, false).unwrap();
    if first.warnings.iter().any(|w| w.contains("privilege")) && !a.is_symlink() {
        eprintln!("Symlink creation unavailable: {:?}", first.warnings);
        assert!(v.join("A").is_dir());
        return;
    }
    assert!(first.warnings.is_empty(), "{:?}", first.warnings);
    assert!(a.is_symlink());
    assert!(v.join("A/unit").is_symlink());
    assert!(resolve(root, ".VAULTA-VIEWS/A/a.txt").is_err());
    symlink_file(&target, root.join("outside.txt")).unwrap();
    symlink_dir(root.join("unit"), root.join("outside-dir")).unwrap();
    assert!(matches!(
        preview(root, "outside.txt"),
        Err(Error::Reparse(_))
    ));
    assert!(matches!(
        mkdir(root, "outside-dir", "new"),
        Err(Error::Reparse(_))
    ));
    fs::rename(&a, &b).unwrap();
    let report = sync_view(root, "test", &categories, &items, true, true).unwrap();
    assert_eq!(
        report.changes,
        [ViewChange {
            id: "a".into(),
            category_id: Some("c2".into())
        }]
    );
    assert!(!a.exists() && b.is_symlink());
    items[0].category_id = Some("c2".into());
    assert!(sync_view(root, "test", &categories, &items, true, false)
        .unwrap()
        .warnings
        .is_empty());
    fs::remove_file(&b).unwrap();
    let report = sync_view(root, "test", &categories, &items, true, true).unwrap();
    assert_eq!(
        report.changes,
        [ViewChange {
            id: "a".into(),
            category_id: None
        }]
    );
    items[0].category_id = None;
    sync_view(root, "test", &categories, &items, true, false).unwrap();
    let foreign = v.join("B/external.txt");
    symlink_file(&target, &foreign).unwrap();
    let report = sync_view(root, "test", &categories, &items, true, true).unwrap();
    assert_eq!(
        report.changes,
        [ViewChange {
            id: "a".into(),
            category_id: Some("c2".into())
        }]
    );
    items[0].category_id = Some("c2".into());
    sync_view(root, "test", &categories, &items, true, false).unwrap();
    let ordinary = v.join("A/ordinary.txt");
    fs::write(&ordinary, "not a link").unwrap();
    let report = sync_view(root, "test", &categories, &items, false, false).unwrap();
    assert!(report.warnings.is_empty(), "{:?}", report.warnings);
    assert!(target.exists() && foreign.is_symlink());
    assert!(!v.join("A/unit").is_symlink());
    assert!(root.join("unit").is_dir() && ordinary.exists());
}

#[test]
fn pinned_directory_refuses_name_replacement() {
    let t = temp();
    let root = t.path();
    let parent = root.join("pinned");
    fs::create_dir(&parent).unwrap();
    let guard = path::Dir::absolute(&parent).unwrap();
    assert!(fs::rename(&parent, root.join("replaced")).is_err());
    drop(guard);
    assert!(fs::rename(&parent, root.join("replaced")).is_ok());
}

#[test]
fn projection_retargets_and_never_takes_foreign_collision() {
    use std::os::windows::fs::symlink_file;
    let t = temp();
    let root = t.path();
    let first = root.join("first.txt");
    let second = root.join("second.txt");
    fs::write(&first, "target").unwrap();
    let mut categories = [ViewCategory {
        id: "category".into(),
        path: vec!["Old".into()],
    }];
    let mut items = [ViewItem {
        id: "asset".into(),
        path: "first.txt".into(),
        category_id: Some("category".into()),
        is_dir: false,
    }];
    sync_view(root, "test", &categories, &items, true, false).unwrap();
    let old = root.join(VIEW_DIR).join("Old/first.txt");
    if !old.is_symlink() {
        return;
    }
    fs::rename(&first, &second).unwrap();
    items[0].path = "second.txt".into();
    categories[0].path = vec!["New".into()];
    let view_slot = root.join(VIEW_DIR).join("New/second.txt");
    fs::create_dir(view_slot.parent().unwrap()).unwrap();
    fs::write(&view_slot, "foreign regular file").unwrap();
    let report = sync_view(root, "test", &categories, &items, true, true).unwrap();
    assert!(report.changes.is_empty(), "{report:?}");
    assert!(!old.is_symlink());
    let links = fs::read_dir(view_slot.parent().unwrap())
        .unwrap()
        .map(|f| f.unwrap().path())
        .filter(|p| p.is_symlink())
        .collect::<Vec<_>>();
    assert_eq!(links.len(), 1);
    assert_eq!(fs::read(&view_slot).unwrap(), b"foreign regular file");
    let foreign = view_slot.with_file_name("external.txt");
    symlink_file(r"..\..\second.txt", &foreign).unwrap();
    let report = sync_view(root, "test", &categories, &items, true, true).unwrap();
    assert!(report.changes.is_empty() && !report.warnings.is_empty());
    sync_view(root, "test", &categories, &items, false, false).unwrap();
    assert!(!links[0].is_symlink());
    assert!(foreign.is_symlink() && view_slot.is_file());
    assert_eq!(fs::read(&second).unwrap(), b"target");
}

#[test]
fn projection_noop_preserves_manifest_and_checks_target_identity() {
    use std::{
        collections::HashMap,
        fs::FileTimes,
        time::{Duration, SystemTime},
    };
    let t = temp();
    let root = t.path();
    fs::write(root.join("asset.txt"), "fixture").unwrap();
    let categories = [ViewCategory {
        id: "c".into(),
        path: vec!["Category".into()],
    }];
    let items = [ViewItem {
        id: "asset".into(),
        path: "asset.txt".into(),
        category_id: Some("c".into()),
        is_dir: false,
    }];
    let stale = HashMap::from([(String::from("asset"), String::from("wrong identity"))]);
    let report = sync_view_checked(root, "test", &categories, &items, true, false, &stale).unwrap();
    assert!(report
        .warnings
        .iter()
        .any(|w| w.contains("changed physical identity")));
    assert!(!root.join(VIEW_DIR).join("Category/asset.txt").is_symlink());
    let identities = HashMap::from([(String::from("asset"), key(root, "asset.txt"))]);
    sync_view_checked(root, "test", &categories, &items, true, false, &identities).unwrap();
    let path = root.join(VIEW_DIR).join(".vaulta-manifest.json");
    let fixture_time = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
    fs::OpenOptions::new()
        .write(true)
        .open(&path)
        .unwrap()
        .set_times(FileTimes::new().set_modified(fixture_time))
        .unwrap();
    let contents = fs::read(&path).unwrap();
    sync_view_checked(root, "test", &categories, &items, true, false, &identities).unwrap();
    sync_view_checked(root, "test", &categories, &items, true, true, &identities).unwrap();
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        fixture_time
    );
    assert_eq!(fs::read(&path).unwrap(), contents);
}

#[test]
fn document_search_is_separate_from_binary_preview() {
    use crate::document_text::tests::{pdf_fixture, slide_fixture, word_fixture, workbook_fixture};
    let temp = temp();
    let root = temp.path();
    for (name, data, query, kind) in [
        (
            "word.DOCX",
            word_fixture(),
            "VAULTA & 猫",
            PreviewKind::Office,
        ),
        (
            "slides.pptx",
            slide_fixture(),
            "TENTH SLIDE",
            PreviewKind::Slides,
        ),
        (
            "book.xlsx",
            workbook_fixture(),
            "SHARED LABEL",
            PreviewKind::Office,
        ),
        ("paper.pdf", pdf_fixture(), "PDF ÉVIDENCE", PreviewKind::Pdf),
    ] {
        let path = root.join(name);
        fs::write(&path, &data).unwrap();
        assert!(text_matches(root, name, query).unwrap(), "{name}");
        let p = preview(root, name).unwrap();
        assert_eq!(p.kind, kind);
        assert!(p.text.is_none() && p.data_url.is_none() && p.revision.is_none());
        let asset = crate::path::Asset::open(
            root,
            name,
            0,
            windows::Win32::Storage::FileSystem::FILE_SHARE_READ,
        )
        .unwrap();
        let expected = crate::path::identity_key(&asset.file, &asset.path).unwrap();
        drop(asset);
        assert!(matches!(
            open_render_source(root, name, "incorrect file ID", kind),
            Err(Error::Conflict)
        ));
        assert_eq!(
            open_render_source(root, name, &expected, kind)
                .unwrap()
                .into_bytes()
                .unwrap(),
            data
        );
        assert!(matches!(
            save_text(root, name, "v1:invalid", "replacement"),
            Err(Error::Unsupported(_))
        ));
        assert_eq!(fs::read(path).unwrap(), data);
    }
    for name in [
        "old.doc",
        "old.ppt",
        "old.xls",
        "report.odt",
        "slides.odp",
        "table.ods",
        "note.rtf",
    ] {
        fs::write(root.join(name), b"test").unwrap();
        assert_eq!(preview(root, name).unwrap().kind, PreviewKind::Office);
    }
    fs::write(root.join("malformed.docx"), b"pretend text").unwrap();
    fs::write(root.join("macro.docm"), word_fixture()).unwrap();
    fs::File::create(root.join("large.pdf"))
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert!(!text_matches(root, "malformed.docx", "").unwrap());
    for name in ["macro.docm", "large.pdf"] {
        assert!(!text_matches(root, name, "").unwrap());
        assert_eq!(preview(root, name).unwrap().kind, PreviewKind::Unsupported);
    }
}
