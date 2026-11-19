use crate::{document_text, path::*, Error, Preview, PreviewKind, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::File,
    io::{self, Read, Seek, Write},
    os::windows::io::FromRawHandle,
    path::{Path, PathBuf},
};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Storage::FileSystem::*,
    },
};

pub const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_MEDIA_BYTES: usize = 12 * 1024 * 1024;

pub(crate) fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}
fn text_type(path: &Path) -> bool {
    matches!(
        extension(path).as_str(),
        "txt"
            | "md"
            | "markdown"
            | "rst"
            | "log"
            | "csv"
            | "tsv"
            | "json"
            | "jsonl"
            | "yaml"
            | "yml"
            | "toml"
            | "ini"
            | "cfg"
            | "conf"
            | "xml"
            | "html"
            | "htm"
            | "css"
            | "rs"
            | "py"
            | "js"
            | "jsx"
            | "ts"
            | "tsx"
            | "mjs"
            | "cjs"
            | "java"
            | "kt"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cc"
            | "cs"
            | "go"
            | "rb"
            | "php"
            | "swift"
            | "sql"
            | "sh"
            | "ps1"
            | "bat"
            | "cmd"
            | "lua"
            | "vue"
            | "svelte"
            | "diff"
            | "patch"
    ) || path.file_name().and_then(|s| s.to_str()).is_some_and(|s| {
        matches!(
            s.to_ascii_lowercase().as_str(),
            "readme"
                | "license"
                | "copying"
                | "makefile"
                | "dockerfile"
                | ".gitignore"
                | ".editorconfig"
        )
    })
}
fn bytes(file: &File, path: &Path, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut data = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| io_error("read bounded content", path, e))?;
    Ok((data.len() <= limit).then_some(data))
}
fn inert_text(data: &[u8]) -> Option<&str> {
    let s = std::str::from_utf8(data.strip_prefix(b"\xef\xbb\xbf").unwrap_or(data)).ok()?;
    (!s.chars()
        .any(|c| c.is_control() && !matches!(c, '\t' | '\n' | '\r' | '\x0c')))
    .then_some(s)
}
fn revision(id: &str, data: &[u8]) -> String {
    // Bind the content digest to the OS file identity to detect replacement with identical bytes.
    let mut hash = Sha256::new();
    hash.update(b"vaulta:text:v1\0");
    hash.update(id.as_bytes());
    hash.update(data);
    format!("v1:{:x}", hash.finalize())
}
fn read_text(file: &File, path: &Path) -> Result<Option<Vec<u8>>> {
    Ok(bytes(file, path, MAX_TEXT_BYTES)?.filter(|data| inert_text(data).is_some()))
}
fn preview_of(kind: PreviewKind) -> Preview {
    Preview {
        kind,
        text: None,
        data_url: None,
        revision: None,
        message: None,
        mime: None,
    }
}
fn unsupported(message: &str) -> Preview {
    Preview {
        message: Some(message.into()),
        ..preview_of(PreviewKind::Unsupported)
    }
}
fn media_type(ext: &str) -> Option<(PreviewKind, &'static str)> {
    use PreviewKind::*;
    Some(match ext {
        "png" => (Image, "image/png"),
        "jpg" | "jpeg" => (Image, "image/jpeg"),
        "gif" => (Image, "image/gif"),
        "webp" => (Image, "image/webp"),
        "wav" => (Audio, "audio/wav"),
        "mp3" => (Audio, "audio/mpeg"),
        "flac" => (Audio, "audio/flac"),
        "mp4" => (Video, "video/mp4"),
        "webm" => (Video, "video/webm"),
        _ => return None,
    })
}
fn riff(data: &[u8], kind: &[u8; 4]) -> bool {
    data.starts_with(b"RIFF") && data.get(8..12) == Some(kind)
}
fn media_header(mime: &str, d: &[u8]) -> bool {
    match mime {
        "image/png" => d.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => d.starts_with(b"\xff\xd8\xff"),
        "image/gif" => d.starts_with(b"GIF87a") || d.starts_with(b"GIF89a"),
        "image/webp" => riff(d, b"WEBP"),
        "audio/wav" => riff(d, b"WAVE"),
        "audio/flac" => d.starts_with(b"fLaC"),
        "audio/mpeg" => {
            d.starts_with(b"ID3")
                || d.starts_with(&[0xff]) && d.get(1).is_some_and(|v| v & 0xe0 == 0xe0)
        }
        "video/mp4" => d.len() >= 12 && d.get(4..8) == Some(b"ftyp"),
        "video/webm" => d.starts_with(b"\x1a\x45\xdf\xa3"),
        _ => false,
    }
}
fn read_document(
    file: &File,
    path: &Path,
    format: document_text::Format,
) -> Result<Option<String>> {
    Ok(bytes(file, path, document_text::MAX_INPUT)?.and_then(|data| format.extract(&data)))
}

const MAX_RENDER_BYTES: usize = 64 * 1024 * 1024;

fn render_kind(ext: &str) -> Option<PreviewKind> {
    Some(match ext {
        "pdf" => PreviewKind::Pdf,
        "pptx" | "ppsx" => PreviewKind::Slides,
        "doc" | "docx" | "rtf" | "odt" | "ppt" | "pps" | "odp" | "xls"
        | "xlsx" | "ods" => PreviewKind::Office,
        _ => return None,
    })
}

/// A bounded, verified document. Renderers never receive an arbitrary path from the UI.
pub struct RenderSource(Asset);

impl RenderSource {
    pub fn extension(&self) -> String {
        extension(&self.0.path)
    }

    pub fn into_bytes(self) -> Result<Vec<u8>> {
        bytes(&self.0.file, &self.0.path, MAX_RENDER_BYTES)?
            .ok_or(Error::Unsupported("document preview is limited to 64 MiB"))
    }

    pub fn revision(&self) -> Result<(String, u64, std::time::SystemTime)> {
        let asset = &self.0;
        let meta = asset
            .file
            .metadata()
            .map_err(|e| io_error("inspect document", &asset.path, e))?;
        let modified = meta
            .modified()
            .map_err(|e| io_error("inspect document modification time", &asset.path, e))?;
        Ok((
            identity_key(&asset.file, &asset.path)?,
            meta.len(),
            modified,
        ))
    }

    pub fn has_zone_marker(&self) -> io::Result<bool> {
        Ok(self.open_zone_marker()?.is_some())
    }

    /// Read the alternate stream while the original and its parent paths are pinned.
    pub fn open_zone_marker(&self) -> io::Result<Option<File>> {
        let mut stream = self.0.path.as_os_str().to_os_string();
        stream.push(":Zone.Identifier:$DATA");
        match File::open(PathBuf::from(stream)) {
            Ok(file) => Ok(Some(file)),
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || matches!(error.raw_os_error(), Some(1 | 123)) =>
            {
                Ok(None)
            }
            Err(error) => Err(error),
        }
    }
}

pub fn open_render_source(
    root: &Path,
    rel: &str,
    expected_identity: &str,
    kind: PreviewKind,
) -> Result<RenderSource> {
    let asset = Asset::open(root, rel, FILE_GENERIC_READ.0, FILE_SHARE_READ)?;
    verify(&asset.file, &asset.path, Some(expected_identity))?;
    if asset.is_dir || render_kind(&extension(&asset.path)) != Some(kind) {
        return Err(Error::Unsupported("not a supported document format"));
    }
    if render_size(&asset)? > MAX_RENDER_BYTES as u64 {
        return Err(Error::Unsupported("document preview is limited to 64 MiB"));
    }
    Ok(RenderSource(asset))
}

fn render_size(asset: &Asset) -> Result<u64> {
    Ok(asset
        .file
        .metadata()
        .map_err(|e| io_error("inspect document", &asset.path, e))?
        .len())
}

/// Inert UTF-8 source, native document routing, or bounded raster/audio/video.
pub fn preview(root: &Path, rel: &str) -> Result<Preview> {
    if rel.is_empty() {
        Dir::absolute(root)?;
        return Ok(preview_of(PreviewKind::Directory));
    }
    let asset = Asset::open(root, rel, FILE_GENERIC_READ.0, FILE_SHARE_READ)?;
    if asset.is_dir {
        return Ok(preview_of(PreviewKind::Directory));
    }
    if text_type(&asset.path) {
        let Some(data) = read_text(&asset.file, &asset.path)? else {
            return Ok(unsupported("Text must be UTF-8 and no larger than 2 MiB."));
        };
        let mut result = preview_of(PreviewKind::Text);
        result.text = inert_text(&data).map(str::to_owned);
        result.mime = Some("text/plain".into());
        if info(&asset.file, &asset.path)?.nNumberOfLinks == 1 {
            result.revision = Some(revision(&identity_key(&asset.file, &asset.path)?, &data));
        } else {
            result.message = Some("Hard-linked files are read-only in Vaulta.".into());
        }
        return Ok(result);
    }
    let ext = extension(&asset.path);
    if let Some(kind) = render_kind(&ext) {
        return Ok(if render_size(&asset)? > MAX_RENDER_BYTES as u64 {
            unsupported("文档预览上限为 64 MiB。")
        } else {
            preview_of(kind)
        });
    }
    if let Some((kind, mime)) = media_type(&ext) {
        let Some(data) = bytes(&asset.file, &asset.path, MAX_MEDIA_BYTES)? else {
            return Ok(unsupported("Media preview is limited to 12 MiB."));
        };
        if !media_header(mime, &data) {
            return Ok(unsupported("Content does not match the media format."));
        }
        return Ok(Preview {
            data_url: Some(format!("data:{mime};base64,{}", STANDARD.encode(data))),
            mime: Some(mime.into()),
            ..preview_of(kind)
        });
    }
    Ok(unsupported("This file format has no built-in preview."))
}

/// Case-insensitive Unicode-lowercase substring search on bounded inert text; unsupported is false.
pub fn text_matches(root: &Path, rel: &str, query: &str) -> Result<bool> {
    if rel.is_empty() {
        Dir::absolute(root)?;
        return Ok(false);
    }
    let asset = Asset::open(root, rel, FILE_GENERIC_READ.0, FILE_SHARE_READ)?;
    if asset.is_dir {
        return Ok(false);
    }
    let query = query.to_lowercase();
    if let Some(format) = document_text::Format::from_extension(&extension(&asset.path)) {
        return Ok(read_document(&asset.file, &asset.path, format)?
            .is_some_and(|s| s.to_lowercase().contains(&query)));
    }
    if !text_type(&asset.path) {
        return Ok(false);
    }
    Ok(read_text(&asset.file, &asset.path)?
        .as_deref()
        .and_then(inert_text)
        .is_some_and(|s| s.to_lowercase().contains(&query)))
}

struct Tx(HANDLE);
impl Drop for Tx {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}
pub(crate) struct Writer {
    pub(crate) file: File,
    tx: Tx,
}
impl Writer {
    pub(crate) fn open(path: &Path) -> Result<Self> {
        let tx = Tx(unsafe {
            CreateTransaction(
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                PCWSTR::null(),
            )
        }
        .map_err(|e| win_error("start atomic transaction", path, e))?);
        let w = wide(path.as_os_str());
        let handle = unsafe {
            CreateFileTransactedW(
                PCWSTR(w.as_ptr()),
                (FILE_GENERIC_READ | FILE_GENERIC_WRITE).0,
                FILE_SHARE_READ,
                None,
                OPEN_EXISTING,
                FILE_FLAG_OPEN_REPARSE_POINT,
                None,
                tx.0,
                None,
                None,
            )
        }
        .map_err(|e| {
            win_error(
                "open atomic writer (requires local NTFS with TxF; otherwise edit externally)",
                path,
                e,
            )
        })?;
        Ok(Self {
            file: unsafe { File::from_raw_handle(handle.0) },
            tx,
        })
    }
    pub(crate) fn commit(&self, path: &Path) -> Result<()> {
        unsafe { CommitTransaction(self.tx.0) }
            .map_err(|e| win_error("commit atomic write", path, e))
    }
}
/// Atomically commits only the unnamed text stream of the checked original file on TxF-capable
/// Windows volumes, preserving identity, ACL and ADS. No in-place or unchecked replace fallback.
pub fn save_text(root: &Path, rel: &str, expected: &str, text: &str) -> Result<()> {
    save_text_verified(root, rel, expected, text).map(|_| ())
}
/// Like [`save_text`], returning the real path and new revision derived from the same pinned
/// physical file, without resolving the caller's relative path a second time.
pub fn save_text_verified(
    root: &Path,
    rel: &str,
    expected: &str,
    text: &str,
) -> Result<crate::TextSave> {
    save_impl(root, rel, expected, text, None)
}
pub fn save_text_verified_checked(
    root: &Path,
    rel: &str,
    expected: &str,
    text: &str,
    expected_identity: &str,
) -> Result<crate::TextSave> {
    save_impl(root, rel, expected, text, Some(expected_identity))
}
fn save_impl(
    root: &Path,
    rel: &str,
    expected: &str,
    text: &str,
    expected_identity: Option<&str>,
) -> Result<crate::TextSave> {
    if text.len() > MAX_TEXT_BYTES || inert_text(text.as_bytes()).is_none() {
        return Err(Error::Refused(
            "edited text must be inert UTF-8, at most 2 MiB".into(),
        ));
    }
    let asset = Asset::open(
        root,
        rel,
        FILE_READ_DATA.0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
    )?;
    if asset.is_dir || !text_type(&asset.path) {
        return Err(Error::Unsupported(
            "only supported UTF-8 text files are editable",
        ));
    }
    verify(&asset.file, &asset.path, expected_identity)?;
    let id = identity_key(&asset.file, &asset.path)?;
    if info(&asset.file, &asset.path)?.nNumberOfLinks != 1 {
        return Err(Error::Refused("hard-linked files are read-only".into()));
    }
    let mut writer = Writer::open(&asset.path)?;
    let file = &mut writer.file;
    if real(file, &asset.path)?
        || identity_key(file, &asset.path)? != id
        || info(file, &asset.path)?.nNumberOfLinks != 1
    {
        return Err(Error::Conflict);
    }
    let before = read_text(file, &asset.path)?.ok_or(Error::Conflict)?;
    if revision(&id, &before) != expected {
        return Err(Error::Conflict);
    }
    // Preview strips the BOM for rendering; preserve it on save.
    let bom = before.starts_with(b"\xef\xbb\xbf");
    if text.len() + usize::from(bom) * 3 > MAX_TEXT_BYTES {
        return Err(Error::Refused(
            "edited text exceeds 2 MiB including BOM".into(),
        ));
    }
    (|| -> io::Result<()> {
        file.rewind()?;
        if bom {
            file.write_all(b"\xef\xbb\xbf")?;
        }
        file.write_all(text.as_bytes())?;
        file.set_len((text.len() + usize::from(bom) * 3) as u64)?;
        file.sync_all()
    })()
    .map_err(|e| io_error("write transaction", &asset.path, e))?;
    if identity_key(file, &asset.path)? != id || info(file, &asset.path)?.nNumberOfLinks != 1 {
        return Err(Error::Conflict);
    }
    // The transaction handle rolls back on drop unless committed. Keep both file handles open
    // through commit, so neither path replacement nor another writer can slip in at that point.
    writer.commit(&asset.path)?;
    if identity_key(&asset.file, &asset.path)? != id {
        return Err(Error::Refused(
            "text committed, but the pinned file's identity could not be confirmed".into(),
        ));
    }
    let mut committed = Vec::with_capacity(text.len() + usize::from(bom) * 3);
    if bom {
        committed.extend_from_slice(b"\xef\xbb\xbf");
    }
    committed.extend_from_slice(text.as_bytes());
    Ok(crate::TextSave {
        path: dos(&asset.path),
        revision: revision(&id, &committed),
    })
}

/// Groups file contents, not identities. Inputs are checked paths; directories are ignored.
/// Streams SHA-256 only for size buckets with at least two distinct paths.
pub fn duplicate_groups(root: &Path, paths: &[String]) -> Result<Vec<Vec<String>>> {
    Dir::absolute(root)?;
    let mut seen = HashSet::new();
    let mut sizes = BTreeMap::<u64, Vec<(String, Identity)>>::new();
    for rel in paths {
        let asset = Asset::open(root, rel, 0, FILE_SHARE_READ)?;
        if asset.is_dir || !seen.insert(asset.path.clone()) {
            continue;
        }
        let info = info(&asset.file, &asset.path)?;
        let size = (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow);
        sizes.entry(size).or_default().push((
            parts(rel, false)?.join("/"),
            identity(&asset.file, &asset.path)?,
        ));
    }
    let mut duplicates = Vec::new();
    for (size, bucket) in sizes.into_iter().filter(|(_, b)| b.len() > 1) {
        let mut hashes = BTreeMap::<[u8; 32], Vec<String>>::new();
        for (rel, id) in bucket {
            let mut asset = Asset::open(root, &rel, FILE_GENERIC_READ.0, FILE_SHARE_READ)?;
            if identity(&asset.file, &asset.path)? != id || asset.is_dir {
                return Err(Error::Conflict);
            }
            let mut hasher = Sha256::new();
            let n = io::copy(&mut asset.file, &mut hasher)
                .map_err(|e| io_error("hash file", &asset.path, e))?;
            if n != size {
                return Err(Error::Conflict);
            }
            hashes
                .entry(hasher.finalize().into())
                .or_default()
                .push(rel);
        }
        duplicates.extend(hashes.into_values().filter(|g| g.len() > 1).map(|mut g| {
            g.sort();
            g
        }));
    }
    duplicates.sort();
    Ok(duplicates)
}
