#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ops;
mod watcher;
mod window_chrome;

use anyhow::{Context, Result, bail, ensure};
use ops::{changed, checked_asset, projection_notice};
use serde::Serialize;
use std::{path::PathBuf, sync::mpsc::Sender};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use vaulta::{database_path, locked, read};
use vaulta_core::{Core, Mutation, Snapshot, Vault};
use vaulta_fs as disk;

type Reply<T> = std::result::Result<T, String>;
struct Desktop {
    db: PathBuf,
    wake: Sender<watcher::Wake>,
}

async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T> + Send + 'static) -> Reply<T> {
    tauri::async_runtime::spawn_blocking(move || job().map_err(|e| format!("{e:#}")))
        .await
        .map_err(|e| format!("后台任务未完成：{e}"))?
}

async fn dispatch<T: Send + 'static>(
    state: &Desktop,
    job: impl FnOnce(&mut Core) -> Result<T> + Send + 'static,
) -> Reply<T> {
    let path = state.db.clone();
    blocking(move || locked(&path, job)).await
}

async fn inspect<T: Send + 'static>(
    state: &Desktop,
    job: impl FnOnce(&Core) -> Result<T> + Send + 'static,
) -> Reply<T> {
    let path = state.db.clone();
    blocking(move || read(&path, job)).await
}

#[tauri::command]
async fn list_vaults(state: State<'_, Desktop>) -> Reply<Vec<Vault>> {
    inspect(&state, |core| Ok(core.vaults()?)).await
}

#[tauri::command]
async fn choose_folder(app: AppHandle, title: Option<String>) -> Reply<Option<PathBuf>> {
    blocking(move || {
        app.dialog()
            .file()
            .set_title(title.unwrap_or_else(|| "选择仓库文件夹".into()))
            .blocking_pick_folder()
            .map(|p| p.into_path().map_err(Into::into))
            .transpose()
    })
    .await
}

#[tauri::command]
async fn add_vault(
    app: AppHandle,
    state: State<'_, Desktop>,
    path: PathBuf,
    name: String,
    create: bool,
) -> Reply<Vault> {
    let db = state.db.clone();
    let wake = state.wake.clone();
    dispatch(&state, move |core| {
        let name = name.trim();
        let root = if create {
            ensure!(
                !name.is_empty() && !name.ends_with(['.', ' ']) && !name.contains(['/', '\\', ':']),
                "请输入有效的单个文件夹名称。"
            );
            // Validate the prospective child, not the selected parent: e.g. creating a
            // new library in the user profile must not overlap the app's standard data path.
            let planned = path.canonicalize()?.join(name);
            ops::prevent_canonical_data_overlap(&planned, &db)?;
            for v in core.vaults()? {
                let root = v.root.canonicalize().unwrap_or(v.root);
                ensure!(
                    ops::relative(&root, &planned).is_none()
                        && ops::relative(&planned, &root).is_none(),
                    "不能在已管理的目录中创建顶层仓库。"
                );
            }
            path.join(disk::mkdir(&path, "", name)?)
        } else {
            path
        };
        ops::prevent_data_overlap(&root, &db)?;
        let v = core.add_vault(&root, name)?;
        changed(&app, "");
        let _ = wake.send(watcher::Wake::One(v.id.clone()));
        Ok(v)
    })
    .await
}

#[tauri::command]
async fn rename_vault(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    name: String,
) -> Reply<()> {
    dispatch(&state, move |core| {
        core.rename_vault(&vault_id, &name)?;
        changed(&app, "");
        Ok(())
    })
    .await
}

#[tauri::command]
async fn remove_vault(app: AppHandle, state: State<'_, Desktop>, vault_id: String) -> Reply<()> {
    dispatch(&state, move |core| {
        core.remove_vault(&vault_id)?;
        changed(&app, "");
        Ok(())
    })
    .await
}

#[tauri::command]
async fn open_unit(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    asset_id: String,
) -> Reply<Vault> {
    let wake = state.wake.clone();
    dispatch(&state, move |core| {
        let (_, asset) = checked_asset(core, &vault_id, &asset_id)?;
        ensure!(asset.kind != "file", "只有文件夹可以成为整体单元。");
        let unit = core.open_unit(&vault_id, &asset_id)?;
        let _ = wake.send(watcher::Wake::One(vault_id));
        let _ = wake.send(watcher::Wake::One(unit.id.clone()));
        changed(&app, "");
        Ok(unit)
    })
    .await
}

#[tauri::command]
async fn snapshot(state: State<'_, Desktop>, vault_id: String) -> Reply<Snapshot> {
    inspect(&state, move |core| Ok(core.snapshot(&vault_id)?)).await
}

#[tauri::command]
async fn rescan(app: AppHandle, state: State<'_, Desktop>, vault_id: String) -> Reply<()> {
    dispatch(&state, move |core| {
        let result = core.scan(&vault_id);
        if result.is_ok() {
            projection_notice(&app, core, &vault_id, true);
        }
        changed(&app, &vault_id);
        Ok(result?)
    })
    .await
}

#[tauri::command]
async fn mutate(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    action: Mutation,
) -> Reply<()> {
    dispatch(&state, move |core| {
        core.mutate(&vault_id, action, "app")?;
        projection_notice(&app, core, &vault_id, true);
        changed(&app, &vault_id);
        Ok(())
    })
    .await
}

#[tauri::command]
async fn preview(
    state: State<'_, Desktop>,
    vault_id: String,
    asset_id: String,
) -> Reply<disk::Preview> {
    let (root, asset) = inspect(&state, {
        let id = vault_id;
        move |core| checked_asset(core, &id, &asset_id)
    })
    .await?;
    blocking(move || {
        let preview = disk::preview(&root, &asset.path)?;
        let path = disk::resolve(&root, &asset.path)?;
        ensure!(
            vaulta_core::identity(&path)? == asset.identity,
            "读取期间文件已更换，请重新扫描。"
        );
        Ok(preview)
    })
    .await
}

#[tauri::command]
async fn save_text(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    asset_id: String,
    revision: String,
    text: String,
) -> Reply<()> {
    dispatch(&state, move |core| {
        let (root, asset) = checked_asset(core, &vault_id, &asset_id)?;
        let identity = asset
            .identity
            .as_deref()
            .context("无法验证文本文件的身份")?;
        disk::save_text_verified_checked(&root, &asset.path, &revision, &text, identity)?;
        let update = core
            .scan(&vault_id)
            .context("内容已保存，但管理记录未更新。请重新扫描并检查该文件。");
        changed(&app, &vault_id);
        update?;
        core.record(&vault_id, "app", &format!("保存文本 · {}", asset.path))?;
        Ok(())
    })
    .await
}

#[tauri::command]
async fn file_operation(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    asset_id: String,
    operation: String,
    value: Option<String>,
    confirmed: Option<bool>,
) -> Reply<()> {
    let db = state.db.clone();
    blocking(move || {
        let (root, asset, proposed_destination, outside) = locked(&db, |core| {
            let (root, asset) = checked_asset(core, &vault_id, &asset_id)?;
            let mv = if operation == "move" {
                let dest = value.as_deref().context("未选择移动目标")?;
                let destination = PathBuf::from(dest);
                let (canonical, outside) = ops::move_target(core, &root, &vault_id, &asset, &destination)?;
                Some(((destination, canonical), outside))
            } else { None };
            let (destination, outside) = mv.map(|(d,outside)| (Some(d),outside)).unwrap_or((None,false));
            Ok((root, asset, destination, outside))
        })?;
        let requires_consent = match operation.as_str() {
            "recycle" => Some(format!("将以下对象送入回收站？\n\n{}\n\n这是对真实文件系统的操作。不能回收时，Vaulta 不会永久删除它。", root.join(&asset.path).display())),
            "run" => Some(format!("运行以下文件？\n\n{}\n\n程序或脚本可能修改系统或数据。只运行你信任的文件。", root.join(&asset.path).display())),
            "move" if outside => Some(format!("将以下真实对象移出仓库？\n\n{}\n\n目标目录：{}", root.join(&asset.path).display(), proposed_destination.as_ref().unwrap().0.display())),
            _ => None,
        };
        if let Some(message) = requires_consent {
            ensure!(confirmed.unwrap_or(false), "这项操作需要明确确认。");
            let yes = app.dialog().message(message).title("vaulta · 确认真实文件操作")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNo).blocking_show();
            ensure!(yes, "操作已取消。");
        }
        locked(&db, |core| {
            let (current_root, current) = checked_asset(core, &vault_id, &asset_id)?;
            ensure!(root == current_root && asset.path == current.path && asset.identity == current.identity, "等待确认时对象发生变化，请重新操作。");
            let identity = asset.identity.as_deref().context("无法验证文件身份")?;
            match operation.as_str() {
                "rename" => {
                    let next = disk::rename_checked(&root, &asset.path, value.as_deref().context("没有提供新名称")?, identity)?;
                    core.record(&vault_id, "app", &format!("重命名 · {} → {}", asset.path, next))?;
                }
                "move" => {
                    let (destination, expected) = proposed_destination.as_ref().context("没有移动目标")?;
                    let (canonical, current_outside) = ops::move_target(core, &root, &vault_id, &asset, destination)?;
                    ensure!(&canonical == expected && current_outside == outside, "目标目录已变化，请重新选择。");
                    let result = disk::move_asset_checked(&root, &asset.path, destination, identity)?;
                    core.record(&vault_id, "app", &format!("{} · {} → {}", if outside {"移出仓库"} else {"移动"}, asset.path, result.display()))?;
                }
                "recycle" => {
                    disk::recycle_checked(&root, &asset.path, identity)?;
                    core.record(&vault_id, "app", &format!("移至回收站 · {}", asset.path))?;
                }
                "default" | "choose" | "reveal" | "properties" | "run" => {
                    disk::open_checked(&root, &asset.path, &operation, operation == "run" && confirmed.unwrap_or(false), identity)?;
                    if matches!(operation.as_str(), "default" | "choose" | "run") {
                        core.record(&vault_id, "app", &format!("{} · {}", if operation == "run" {"运行"} else {"打开"}, asset.path))?;
                        changed(&app, &vault_id);
                    }
                    return Ok(());
                }
                _ => bail!("未知真实文件操作"),
            }
            let scan = core.scan(&vault_id);
            if scan.is_ok() { projection_notice(&app, core, &vault_id, false); }
            changed(&app, &vault_id);
            scan.context("文件操作已经执行，但重新扫描失败。请不要重复执行，先检查磁盘状态。")?;
            Ok(())
        })
    }).await
}

#[tauri::command]
async fn create_folder(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    parent: String,
    name: String,
) -> Reply<String> {
    dispatch(&state, move |core| {
        let root = core.checked_root(&vault_id)?;
        if !parent.is_empty() {
            let snapshot = core.snapshot(&vault_id)?;
            let a = snapshot
                .assets
                .iter()
                .find(|a| a.path == parent && a.kind == "directory" && a.state != "missing")
                .context("请选择当前管理空间中的普通文件夹")?;
            checked_asset(core, &vault_id, &a.id)?;
        }
        let path = disk::mkdir(&root, &parent, &name)?;
        let scan = core.scan(&vault_id);
        changed(&app, &vault_id);
        scan.context("已创建文件夹，但重新扫描失败。")?;
        Ok(path)
    })
    .await
}

#[tauri::command]
async fn duplicates(state: State<'_, Desktop>, vault_id: String) -> Reply<Vec<Vec<String>>> {
    let (root, paths) = inspect(&state, move |core| {
        let root = core.checked_root(&vault_id)?;
        let paths: std::collections::HashMap<_, _> = core
            .snapshot(&vault_id)?
            .assets
            .into_iter()
            .filter(|a| {
                a.kind == "file"
                    && !matches!(a.state.as_str(), "excluded" | "missing")
                    && a.identity.is_some()
            })
            .map(|a| (a.path, (a.id, a.identity.unwrap())))
            .collect();
        Ok((root, paths))
    })
    .await?;
    blocking(move || {
        let live = |rel: &str, expected: &str| {
            disk::resolve(&root, rel)
                .ok()
                .and_then(|p| vaulta_core::identity(&p).ok().flatten())
                .as_deref()
                == Some(expected)
        };
        let inputs: Vec<String> = paths
            .iter()
            .filter(|(rel, (_, id))| live(rel, id))
            .map(|(k, _)| k.clone())
            .collect();
        let groups = disk::duplicate_groups(&root, &inputs)?;
        Ok(groups
            .into_iter()
            .map(|group| {
                group
                    .iter()
                    .filter_map(|rel| {
                        let (id, expected) = paths.get(rel)?;
                        live(rel, expected).then(|| id.clone())
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|g| g.len() > 1)
            .collect())
    })
    .await
}

#[derive(Serialize)]
struct ContentMatch {
    vault_id: String,
    asset_id: String,
}

#[tauri::command]
async fn content_matches(
    state: State<'_, Desktop>,
    vault_ids: Vec<String>,
    query: String,
) -> Reply<Vec<ContentMatch>> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let collections = inspect(&state, move |core| {
        let mut collections = Vec::new();
        for id in vault_ids
            .into_iter()
            .collect::<std::collections::BTreeSet<_>>()
        {
            if let Ok(root) = core.checked_root(&id) {
                collections.push((id.clone(), root, core.snapshot(&id)?.assets));
            }
        }
        Ok(collections)
    })
    .await?;
    blocking(move || {
        let mut matches = Vec::new();
        for (id, root, assets) in collections {
            for a in assets
                .into_iter()
                .filter(|a| a.kind == "file" && !matches!(a.state.as_str(), "missing" | "excluded"))
            {
                let Some(expected) = a.identity else {
                    continue;
                };
                if let Ok(path) = disk::resolve(&root, &a.path) {
                    let identity_matches = || {
                        vaulta_core::identity(&path).ok().flatten().as_deref()
                            == Some(expected.as_str())
                    };
                    if identity_matches()
                        && disk::text_matches(&root, &a.path, &query).unwrap_or(false)
                        && identity_matches()
                    {
                        matches.push(ContentMatch {
                            vault_id: id.clone(),
                            asset_id: a.id,
                        });
                    }
                }
            }
        }
        Ok(matches)
    })
    .await
}

#[derive(Serialize)]
struct ApiInfo {
    executable: PathBuf,
    database: PathBuf,
    protocol: u8,
}

#[tauri::command]
fn api_info(state: State<'_, Desktop>) -> Reply<ApiInfo> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    Ok(ApiInfo {
        executable: exe.with_file_name("vaulta-agent.exe"),
        database: state.db.clone(),
        protocol: 1,
    })
}

#[tauri::command]
async fn agent_access(state: State<'_, Desktop>, vault_id: String) -> Reply<String> {
    inspect(&state, move |core| Ok(core.agent_access(&vault_id)?)).await
}

#[tauri::command]
async fn set_agent_access(
    app: AppHandle,
    state: State<'_, Desktop>,
    vault_id: String,
    access: String,
) -> Reply<()> {
    dispatch(&state, move |core| {
        core.set_agent_access(&vault_id, &access)?;
        changed(&app, &vault_id);
        Ok(())
    })
    .await
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db = database_path()?;
            let wake = watcher::start(app.handle().clone(), db.clone());
            app.manage(Desktop {
                db: db.clone(),
                wake,
            });
            window_chrome::open(app, &db)?;
            // The wallpaper layer needs a real sample of the desktop behind the
            // window: backdrop-filter cannot read pixels outside the webview.
            // install() also hides this window from capture APIs, otherwise the
            // screenshot would contain Vaulta itself (mirror-in-mirror).
            glass_design_host::install(app.handle()).map_err(|e| anyhow::anyhow!(e))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_vaults,
            choose_folder,
            add_vault,
            rename_vault,
            remove_vault,
            open_unit,
            snapshot,
            rescan,
            mutate,
            preview,
            save_text,
            file_operation,
            create_folder,
            duplicates,
            content_matches,
            api_info,
            agent_access,
            set_agent_access,
            window_chrome::window_chrome_state,
            window_chrome::set_window_chrome_mode,
            window_chrome::window_chrome_action,
            glass_design_host::capture_backdrop
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("vaulta: {err}");
        std::process::exit(1);
    }
}
