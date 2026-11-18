#![cfg(windows)]
use serde_json::{Value, json};
use std::{
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};
use vaulta::locked;

fn tool(home: &Path, args: &[&str], payload: Option<Value>) -> Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_vaulta-agent"));
    command
        .env("VAULTA_DATA_DIR", home)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if payload.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().unwrap();
    if let Some(payload) = payload {
        child
            .stdin
            .take()
            .unwrap()
            .write_all(payload.to_string().as_bytes())
            .unwrap();
    }
    child.wait_with_output().unwrap()
}
fn response(output: &Output) -> Value {
    let data = if output.status.success() {
        &output.stdout
    } else {
        &output.stderr
    };
    serde_json::from_slice(data).unwrap()
}

#[test]
fn agent_cli_enforces_opt_in_permissions_and_shares_metadata() {
    let test = tempfile::tempdir().unwrap();
    let home = test.path().join("profile");
    let root = test.path().join("files");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("note.md"), "One").unwrap();
    let index = home.join("vaulta.sqlite3");
    let (id, asset) = locked(&index, |core| {
        let vault = core.add_vault(&root, "Notes")?;
        core.scan(&vault.id)?;
        let id = core.snapshot(&vault.id)?.assets[0].id.clone();
        Ok((vault.id, id))
    })
    .unwrap();
    let list = tool(&home, &["list"], None);
    assert_eq!(response(&list)["vaults"], json!([]));
    assert!(!tool(&home, &["snapshot", &id], None).status.success());
    locked(&index, |core| Ok(core.set_agent_access(&id, "read")?)).unwrap();
    let list = tool(&home, &["list"], None);
    assert_eq!(response(&list)["vaults"][0]["vault"]["id"], id);
    let snapshot = tool(&home, &["snapshot", &id], None);
    assert!(snapshot.status.success());
    assert_eq!(response(&snapshot)["snapshot"]["assets"][0]["id"], asset);
    let change = json!({"type":"organize","ids":[asset],"add_tags":["资料"]});
    assert!(
        !tool(&home, &["mutate", &id], Some(change.clone()))
            .status
            .success()
    );
    locked(&index, |core| Ok(core.set_agent_access(&id, "write")?)).unwrap();
    let modified = tool(&home, &["mutate", &id], Some(change));
    assert!(modified.status.success(), "{:?}", response(&modified));
    assert!(
        !tool(
            &home,
            &["mutate", &id],
            Some(json!({"type":"view_config","enabled":true}))
        )
        .status
        .success()
    );
    locked(&index, |core| {
        let snap = core.snapshot(&id)?;
        assert_eq!(snap.assets[0].tags, ["资料"]);
        assert!(snap.history.iter().any(|h| h.source == "agent"));
        assert_eq!(std::fs::read_to_string(root.join("note.md"))?, "One");
        Ok(())
    })
    .unwrap();
}
