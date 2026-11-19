//! Windows filesystem operations for Vaulta. No index, UI, or core dependency.

use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::{collections::HashMap, path::Path};
use std::{io, path::PathBuf};

pub const VIEW_DIR: &str = ".vaulta-views";

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum Error {
    #[error("invalid or reserved path: {0}")]
    InvalidPath(String),
    #[error("reparse point is not allowed: {0}")]
    Reparse(PathBuf),
    #[error("expected {expected}: {path}")]
    WrongType {
        expected: &'static str,
        path: PathBuf,
    },
    #[error("the destination already exists: {0}")]
    Collision(PathBuf),
    #[error("the disk object or content changed; reload or rescan before retrying")]
    Conflict,
    #[error("unsupported operation: {0}")]
    Unsupported(&'static str),
    #[error("operation refused: {0}")]
    Refused(String),
    #[error("{action} ({path}): {source}")]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreviewKind {
    Text,
    Image,
    Audio,
    Video,
    Pdf,
    Office,
    Slides,
    Unsupported,
    Directory,
}

/// Render `text` as a text node, not as HTML. Media URLs are for img/audio/video only.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preview {
    pub kind: PreviewKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ViewCategory {
    pub id: String,
    pub path: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ViewItem {
    pub id: String,
    pub path: String,
    pub category_id: Option<String>,
    pub is_dir: bool,
}
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ViewChange {
    pub id: String,
    pub category_id: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ViewReport {
    pub changes: Vec<ViewChange>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextSave {
    pub path: PathBuf,
    pub revision: String,
}

#[cfg(windows)]
mod content;
#[cfg(windows)]
mod document_text;
#[cfg(windows)]
mod path;
#[cfg(windows)]
mod shell;
#[cfg(windows)]
mod view;
#[cfg(windows)]
pub use {
    content::{
        duplicate_groups, open_render_source, preview, save_text, save_text_verified,
        save_text_verified_checked, text_matches, RenderSource,
    },
    path::{mkdir, move_asset, move_asset_checked, rename, rename_checked, resolve},
    shell::{open, open_checked, recycle, recycle_checked},
    view::{sync_view, sync_view_checked},
};

#[cfg(not(windows))]
macro_rules! unsupported {
    ($($name:ident($($arg:ident: $ty:ty),*) -> $ret:ty;)*) => {$(
        pub fn $name($($arg: $ty),*) -> Result<$ret> {
            let _ = ($($arg,)*);
            Err(Error::Unsupported("Vaulta's filesystem backend requires Windows"))
        }
    )*}
}
#[cfg(not(windows))]
unsupported! {
    preview(root: &Path, rel: &str) -> Preview;
    save_text(root: &Path, rel: &str, revision: &str, text: &str) -> ();
    save_text_verified(root: &Path, rel: &str, revision: &str, text: &str) -> TextSave;
    duplicate_groups(root: &Path, paths: &[String]) -> Vec<Vec<String>>;
    text_matches(root: &Path, rel: &str, query: &str) -> Option<bool>;
    resolve(root: &Path, rel: &str) -> PathBuf;
    rename(root: &Path, rel: &str, name: &str) -> String;
    mkdir(root: &Path, parent: &str, name: &str) -> String;
    move_asset(root: &Path, rel: &str, destination: &Path) -> PathBuf;
    open(root: &Path, rel: &str, mode: &str, allow_run: bool) -> ();
    recycle(root: &Path, rel: &str) -> ();
    rename_checked(root: &Path, rel: &str, name: &str, expected_identity: &str) -> String;
    move_asset_checked(root: &Path, rel: &str, destination: &Path, expected_identity: &str) -> PathBuf;
    recycle_checked(root: &Path, rel: &str, expected_identity: &str) -> ();
    open_checked(root: &Path, rel: &str, mode: &str, allow_run: bool, expected_identity: &str) -> ();
    save_text_verified_checked(root: &Path, rel: &str, revision: &str, text: &str, expected_identity: &str) -> TextSave;
    sync_view_checked(root: &Path, vault_id: &str, categories: &[ViewCategory], items: &[ViewItem], enabled: bool, import: bool, expected_identities: &HashMap<String, String>) -> ViewReport;
    sync_view(root: &Path, vault_id: &str, categories: &[ViewCategory], items: &[ViewItem], enabled: bool, import: bool) -> ViewReport;
}

#[cfg(all(test, windows))]
mod tests;
