//! Desktop-only title bar commands. The web UI never receives a window label or
//! preference path it can substitute in an IPC call.
use crate::Reply;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::ErrorKind,
    path::{Path, PathBuf},
};
use tauri::{App, Manager, State, WebviewWindow, WebviewWindowBuilder};

const MAIN: &str = "main";
const PREFERENCE: &str = "window-chrome.json";

pub struct WindowChrome(PathBuf);

#[derive(Clone, Copy, Default, PartialEq, Eq, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChromeMode {
    #[default]
    Native,
    TrafficLights,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeState {
    mode: ChromeMode,
    maximized: bool,
    minimized: bool,
    focused: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChromeAction {
    Close,
    Minimize,
    ToggleMaximize,
}

fn read_mode(path: &Path) -> Result<ChromeMode> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).context("无效的标题栏设置"),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(ChromeMode::default()),
        Err(error) => Err(error).context("无法读取标题栏设置"),
    }
}

fn write_mode(path: &Path, mode: ChromeMode) -> Result<()> {
    let parent = path.parent().context("无效的标题栏设置路径")?;
    fs::create_dir_all(parent)?;
    let temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(temporary.as_file(), &mode)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path)?;
    Ok(())
}

pub fn open(app: &App, database: &Path) -> Result<()> {
    let path = database.with_file_name(PREFERENCE);
    let mode = read_mode(&path).unwrap_or_else(|error| {
        eprintln!("vaulta: {error:#}");
        ChromeMode::default()
    });
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN)
        .context("找不到主窗口配置")?
        .clone();
    // Apply the saved choice before building the window, not after the web UI loads.
    // All other window settings (including test-only WebView arguments) come from Tauri.
    config.decorations = mode == ChromeMode::Native;
    app.manage(WindowChrome(path));
    WebviewWindowBuilder::from_config(app, &config)?.build()?;
    Ok(())
}

fn check_window(window: &WebviewWindow) -> Reply<()> {
    if window.label() == MAIN {
        Ok(())
    } else {
        Err("仅可操作 vaulta 主窗口。".into())
    }
}

fn mode(window: &WebviewWindow) -> tauri::Result<ChromeMode> {
    Ok(if window.is_decorated()? {
        ChromeMode::Native
    } else {
        ChromeMode::TrafficLights
    })
}

/// The WebView child owns keyboard focus, so tao's `is_focused` reports false for
/// an active window. Ask Windows which top-level window is in front instead, and
/// accept our own HWND or one of its descendants.
#[cfg(windows)]
fn active(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, IsChild};
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let hwnd = hwnd.0;
    let foreground = unsafe { GetForegroundWindow() };
    foreground == hwnd || (!foreground.is_null() && unsafe { IsChild(hwnd, foreground) } != 0)
}

#[cfg(not(windows))]
fn active(window: &WebviewWindow) -> bool {
    window.is_focused().unwrap_or(false)
}

fn state(window: &WebviewWindow) -> tauri::Result<ChromeState> {
    Ok(ChromeState {
        mode: mode(window)?,
        maximized: window.is_maximized()?,
        minimized: window.is_minimized()?,
        focused: active(window),
    })
}

#[tauri::command]
pub fn window_chrome_state(window: WebviewWindow) -> Reply<ChromeState> {
    check_window(&window)?;
    state(&window).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_window_chrome_mode(
    window: WebviewWindow,
    chrome: State<'_, WindowChrome>,
    selected: ChromeMode,
) -> Reply<ChromeState> {
    check_window(&window)?;
    let previous = mode(&window).map_err(|e| e.to_string())?;
    if previous != selected {
        window
            .set_decorations(selected == ChromeMode::Native)
            .map_err(|e| e.to_string())?;
        let path = chrome.0.clone();
        let saved = tauri::async_runtime::spawn_blocking(move || write_mode(&path, selected))
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))
            .and_then(|r| r);
        if let Err(error) = saved {
            if let Err(rollback) = window.set_decorations(previous == ChromeMode::Native) {
                return Err(format!(
                    "无法保存标题栏设置：{error:#}。恢复窗口装饰失败：{rollback}"
                ));
            }
            return Err(format!("无法保存标题栏设置：{error:#}"));
        }
    }
    state(&window).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn window_chrome_action(window: WebviewWindow, action: ChromeAction) -> Reply<()> {
    check_window(&window)?;
    if mode(&window).map_err(|e| e.to_string())? != ChromeMode::TrafficLights {
        return Err("当前使用系统标题栏。".into());
    }
    match action {
        ChromeAction::Close => window.close(),
        ChromeAction::Minimize => window.minimize(),
        ChromeAction::ToggleMaximize => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
    }
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_round_trip_with_native_default_and_atomic_replacement() {
        let profile = tempfile::tempdir().unwrap();
        let path = profile.path().join("nested").join(PREFERENCE);
        assert_eq!(read_mode(&path).unwrap(), ChromeMode::Native);
        write_mode(&path, ChromeMode::TrafficLights).unwrap();
        assert_eq!(read_mode(&path).unwrap(), ChromeMode::TrafficLights);
        write_mode(&path, ChromeMode::Native).unwrap();
        assert_eq!(read_mode(&path).unwrap(), ChromeMode::Native);
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        fs::write(&path, "corrupt").unwrap();
        assert!(read_mode(&path).is_err());
    }
}
