use anyhow::{Context, Result};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
use vaulta_core::Core;

pub const APP_ID: &str = "com.vaulta.desktop";

pub fn database_path() -> Result<PathBuf> {
    // Explicit per-process profile override for development and isolated installations.
    if let Some(raw) = std::env::var_os("VAULTA_DATA_DIR") {
        let data = PathBuf::from(raw);
        anyhow::ensure!(data.is_absolute(), "VAULTA_DATA_DIR 必须是绝对路径");
        return Ok(data.join("vaulta.sqlite3"));
    }
    Ok(dirs::data_local_dir()
        .context("无法定位当前用户的应用数据目录")?
        .join(APP_ID)
        .join("vaulta.sqlite3"))
}

/// Read-only host and CLI operations do not queue behind a filesystem walk.
pub fn read<T>(path: &Path, f: impl FnOnce(&Core) -> Result<T>) -> Result<T> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    f(&Core::open(path).map_err(|e| anyhow::anyhow!("{e}"))?)
}

/// The same OS advisory lock is used by the app and the documented agent tool.
/// No stale-file cleanup is needed: Windows releases the lock on process exit.
pub fn locked<T>(path: &Path, f: impl FnOnce(&mut Core) -> Result<T>) -> Result<T> {
    let parent = path.parent().context("无效的数据库位置")?;
    fs::create_dir_all(parent)?;
    let guard: File = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join("vaulta.lock"))?;
    guard.lock()?;
    let mut core = Core::open(path).map_err(|e| anyhow::anyhow!("{e}"))?;
    f(&mut core)
}
