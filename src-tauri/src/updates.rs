use serde::Serialize;
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use winreg::{RegKey, enums::HKEY_CURRENT_USER};

const RELEASE_PAGE: &str = "https://github.com/Genlue/vaulta/releases/latest";

#[derive(Default)]
pub(crate) struct Updates {
    candidate: Mutex<Option<Update>>,
    busy: AtomicBool,
}

struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updates {
    fn start(&self) -> Result<Operation<'_>, String> {
        self.busy
            .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
            .map_err(|_| "正在处理另一项更新操作。".to_owned())?;
        Ok(Operation(&self.busy))
    }
}

#[derive(Serialize)]
pub(crate) struct UpdateStatus {
    current: String,
    available: Option<String>,
    installable: bool,
    error: Option<String>,
}

fn nsis_install() -> bool {
    // NSIS would install over the registered copy, not over an arbitrary portable exe.
    let Ok(exe) = std::env::current_exe().and_then(std::fs::canonicalize) else {
        return false;
    };
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let Ok(key) = user.open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\vaulta")
    else {
        return false;
    };
    let Ok(location) = key.get_value::<String, _>("InstallLocation") else {
        return false;
    };
    let dir = PathBuf::from(location.trim_matches('"'));
    dir.is_absolute()
        && dir.join("uninstall.exe").is_file()
        && dir
            .join("vaulta.exe")
            .canonicalize()
            .is_ok_and(|registered| registered == exe)
}

#[tauri::command]
pub(crate) async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
) -> Result<UpdateStatus, String> {
    let _operation = state.start()?;
    let current = app.package_info().version.to_string();
    let installable = nsis_install();
    let updater = app
        .updater_builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| format!("无法初始化更新检查：{err}"))?;
    match updater.check().await {
        Ok(update) => {
            let available = update.as_ref().map(|update| update.version.clone());
            *state.candidate.lock().map_err(|_| "无法保存更新状态。")? = update;
            Ok(UpdateStatus {
                current,
                available,
                installable,
                error: None,
            })
        }
        // Leave the previously offered update intact after a transient connection failure.
        Err(err) => Ok(UpdateStatus {
            current,
            available: state
                .candidate
                .lock()
                .map_err(|_| "无法读取更新状态。")?
                .as_ref()
                .map(|update| update.version.clone()),
            installable,
            error: Some(format!("无法检查更新：{err}")),
        }),
    }
}

#[tauri::command]
pub(crate) async fn install_update(
    state: State<'_, Updates>,
    version: String,
) -> Result<(), String> {
    let _operation = state.start()?;
    if !nsis_install() {
        return Err("便携版请从发布页下载新版。".into());
    }
    let mut update = state
        .candidate
        .lock()
        .map_err(|_| "无法读取更新状态。")?
        .as_ref()
        .filter(|update| update.version == version)
        .cloned()
        .ok_or("请先检查更新，并确认要安装的版本。")?;
    update.timeout = Some(Duration::from_secs(300));
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| format!("下载、验证或启动安装失败：{err}"))
}

#[tauri::command]
pub(crate) async fn open_update_releases() -> Result<(), String> {
    use windows_sys::Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL};
    use windows_sys::core::w;
    let url: Vec<u16> = RELEASE_PAGE.encode_utf16().chain([0]).collect();
    // The frontend cannot supply a URL or a local executable to this command.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            w!("open"),
            url.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    if result as isize <= 32 {
        return Err("无法打开 GitHub 发布页面。".into());
    }
    Ok(())
}
