use crate::{Error, Result, VIEW_DIR};
use serde::{Deserialize, Serialize};
use std::{
    ffi::{OsStr, OsString},
    fs::{self, File},
    io,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Path, PathBuf, Prefix},
};
use windows::{
    core::PCWSTR,
    Win32::{Foundation::HANDLE, Storage::FileSystem::*},
};

pub(crate) fn wide(s: &OsStr) -> Vec<u16> {
    s.encode_wide().chain([0]).collect()
}
pub(crate) fn raw(file: &File) -> HANDLE {
    HANDLE(file.as_raw_handle())
}
pub(crate) fn io_error(action: &'static str, path: &Path, source: io::Error) -> Error {
    Error::Io {
        action,
        path: path.into(),
        source,
    }
}
pub(crate) fn win_error(action: &'static str, path: &Path, e: windows::core::Error) -> Error {
    let code = e.code().0 as u32;
    io_error(
        action,
        path,
        if code >> 16 == 0x8007 {
            io::Error::from_raw_os_error((code & 0xffff) as i32)
        } else {
            io::Error::other(e.to_string())
        },
    )
}
pub(crate) fn missing(e: &Error) -> bool {
    matches!(e, Error::Io { source, .. } if source.kind() == io::ErrorKind::NotFound)
}
pub(crate) fn valid_component(s: &str, allow_reserved: bool) -> bool {
    if s.is_empty()
        || s.ends_with(['.', ' '])
        || s.encode_utf16().count() > 255
        || s.chars()
            .any(|c| c.is_control() || "<>:\"/\\|?*".contains(c))
        || (!allow_reserved && s.eq_ignore_ascii_case(VIEW_DIR))
    {
        return false;
    }
    let stem = s
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) && !["COM", "LPT"].iter().any(|p| {
        stem.strip_prefix(p).is_some_and(|v| {
            matches!(
                v,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    })
}
pub(crate) fn parts(rel: &str, empty_ok: bool) -> Result<Vec<&str>> {
    if empty_ok && rel.is_empty() {
        return Ok(vec![]);
    }
    let parts: Vec<_> = rel.split(['/', '\\']).collect();
    if parts.iter().all(|s| valid_component(s, false)) {
        Ok(parts)
    } else {
        Err(Error::InvalidPath(rel.into()))
    }
}
fn name(name: &str) -> Result<&str> {
    if valid_component(name, false) {
        Ok(name)
    } else {
        Err(Error::InvalidPath(name.into()))
    }
}

pub(crate) fn file_open(
    path: &Path,
    access: u32,
    share: FILE_SHARE_MODE,
    how: FILE_CREATION_DISPOSITION,
) -> Result<File> {
    let w = wide(path.as_os_str());
    // OPEN_REPARSE_POINT applies to the final component; callers pin and inspect parents first.
    let handle = unsafe {
        CreateFileW(
            PCWSTR(w.as_ptr()),
            access,
            share,
            None,
            how,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            None,
        )
    }
    .map_err(|e| win_error("open filesystem handle", path, e))?;
    Ok(unsafe { File::from_raw_handle(handle.0) })
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
pub(crate) struct Identity {
    pub(crate) volume: u64,
    pub(crate) id: [u8; 16],
}
pub(crate) fn identity(file: &File, path: &Path) -> Result<Identity> {
    let mut info = FILE_ID_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            raw(file),
            FileIdInfo,
            (&mut info as *mut FILE_ID_INFO).cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    }
    .map_err(|e| win_error("read file identity", path, e))?;
    Ok(Identity {
        volume: info.VolumeSerialNumber,
        id: info.FileId.Identifier,
    })
}
pub(crate) fn identity_key(file: &File, path: &Path) -> Result<String> {
    let id = identity(file, path)?;
    let mut basic = FILE_BASIC_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            raw(file),
            FileBasicInfo,
            (&mut basic as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        )
    }
    .map_err(|e| win_error("read creation time", path, e))?;
    if basic.CreationTime <= 0 || id.id == [0; 16] {
        return Err(Error::Unsupported(
            "a native file ID and creation time are required",
        ));
    }
    Ok(format!(
        "win:{:016x}:{:032x}:{:016x}",
        id.volume,
        u128::from_be_bytes(id.id),
        basic.CreationTime
    ))
}
pub(crate) fn verify(file: &File, path: &Path, expected: Option<&str>) -> Result<()> {
    if let Some(expected) = expected {
        if identity_key(file, path)? != expected {
            return Err(Error::Conflict);
        }
    }
    Ok(())
}
pub(crate) fn info(file: &File, path: &Path) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(raw(file), &mut info) }
        .map_err(|e| win_error("inspect filesystem handle", path, e))?;
    Ok(info)
}
pub(crate) fn tag(file: &File, path: &Path) -> Result<FILE_ATTRIBUTE_TAG_INFO> {
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    unsafe {
        GetFileInformationByHandleEx(
            raw(file),
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    }
    .map_err(|e| win_error("inspect reparse tag", path, e))?;
    Ok(tag)
}
pub(crate) fn real(file: &File, path: &Path) -> Result<bool> {
    let attrs = info(file, path)?.dwFileAttributes;
    if attrs & FILE_ATTRIBUTE_REPARSE_POINT.0 != 0 {
        return Err(Error::Reparse(path.into()));
    }
    if unsafe { GetFileType(raw(file)) } != FILE_TYPE_DISK {
        return Err(Error::WrongType {
            expected: "disk file or directory",
            path: path.into(),
        });
    }
    Ok(attrs & FILE_ATTRIBUTE_DIRECTORY.0 != 0)
}
pub(crate) fn final_path(file: &File, path: &Path) -> Result<PathBuf> {
    let mut buf = vec![0u16; 512];
    loop {
        let n = unsafe { GetFinalPathNameByHandleW(raw(file), &mut buf, VOLUME_NAME_DOS) } as usize;
        if n == 0 {
            return Err(io_error(
                "read normalized Windows path",
                path,
                io::Error::last_os_error(),
            ));
        }
        if n < buf.len() {
            return Ok(OsString::from_wide(&buf[..n]).into());
        }
        buf.resize(n + 1, 0);
    }
}
fn check_actual_name(path: &Path, allow_reserved: bool) -> Result<()> {
    if path.file_name().is_none_or(|s| {
        s.to_str()
            .is_some_and(|s| valid_component(s, allow_reserved))
    }) {
        Ok(())
    } else {
        Err(Error::InvalidPath(path.display().to_string()))
    }
}

/// Holds non-delete-sharing directory handles for every ancestor above the drive root.
/// All absolute paths used for I/O are verified normalized volume paths, not unchecked DOS aliases.
pub(crate) struct Dir {
    pub(crate) path: PathBuf,
    handles: Vec<File>,
}
impl Dir {
    pub(crate) fn absolute(path: &Path) -> Result<Self> {
        // Parse the raw drive path first: Path::components() can hide `.` or repeated separators.
        let s = path
            .to_str()
            .ok_or_else(|| Error::InvalidPath(path.display().to_string()))?;
        let s = s.strip_prefix(r"\\?\").unwrap_or(s);
        let bytes = s.as_bytes();
        if bytes.len() < 3
            || !bytes[0].is_ascii_alphabetic()
            || bytes[1] != b':'
            || !matches!(bytes[2], b'\\' | b'/')
        {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        let rest = s[3..].trim_end_matches(['\\', '/']);
        let components = parts(rest, true)?;
        let drive = PathBuf::from(format!(
            r"\\?\{}:\",
            (bytes[0] as char).to_ascii_uppercase()
        ));
        let handle = file_open(
            &drive,
            FILE_READ_ATTRIBUTES.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
        )?;
        if !real(&handle, &drive)? {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        let actual = final_path(&handle, &drive)?;
        if !matches!(actual.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::VerbatimDisk(_)))
            || actual.parent().is_some()
            || actual != drive
        {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        let mut dir = Self {
            path: actual,
            handles: vec![handle],
        };
        for part in components {
            dir.push(OsStr::new(part), false)?;
        }
        Ok(dir)
    }
    pub(crate) fn push(&mut self, name: &OsStr, allow_reserved: bool) -> Result<()> {
        let path = self.path.join(name);
        let handle = directory(&path)?;
        let actual = final_path(&handle, &path)?;
        check_actual_name(&actual, allow_reserved)?;
        if actual.parent() != Some(self.path.as_path()) {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        self.path = actual;
        self.handles.push(handle);
        Ok(())
    }
    pub(crate) fn child(&self, name: &OsStr, allow_reserved: bool) -> Result<Self> {
        let handles = self
            .handles
            .iter()
            .map(File::try_clone)
            .collect::<io::Result<Vec<_>>>()
            .map_err(|e| io_error("duplicate pinned directory handle", &self.path, e))?;
        let mut result = Self {
            path: self.path.clone(),
            handles,
        };
        result.push(name, allow_reserved)?;
        Ok(result)
    }
    pub(crate) fn handle(&self) -> &File {
        self.handles.last().expect("dir always owns a handle")
    }
}
fn directory(path: &Path) -> Result<File> {
    let file = file_open(
        path,
        (FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES).0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
    )?;
    if !real(&file, path)? {
        return Err(Error::WrongType {
            expected: "directory",
            path: path.into(),
        });
    }
    Ok(file)
}
pub(crate) struct Asset {
    pub(crate) parent: Dir,
    pub(crate) path: PathBuf,
    pub(crate) file: File,
    pub(crate) is_dir: bool,
}
impl Asset {
    pub(crate) fn open(
        root: &Path,
        rel: &str,
        access: u32,
        share: FILE_SHARE_MODE,
    ) -> Result<Self> {
        let parts = parts(rel, false)?;
        let (leaf, ancestors) = parts.split_last().expect("nonempty relative path");
        let mut parent = Dir::absolute(root)?;
        for part in ancestors {
            parent.push(OsStr::new(part), false)?;
        }
        let path = parent.path.join(leaf);
        let file = file_open(&path, access | FILE_READ_ATTRIBUTES.0, share, OPEN_EXISTING)?;
        let is_dir = real(&file, &path)?;
        let actual = final_path(&file, &path)?;
        check_actual_name(&actual, false)?;
        if actual.parent() != Some(parent.path.as_path()) {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        Ok(Self {
            parent,
            path: actual,
            file,
            is_dir,
        })
    }
}

/// Returns an ordinary DOS path for display/Shell interop. A returned path is not a security handle.
pub(crate) fn dos(path: &Path) -> PathBuf {
    path.to_str()
        .and_then(|s| s.strip_prefix(r"\\?\"))
        .map_or_else(|| path.into(), PathBuf::from)
}
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    if rel.is_empty() {
        return Ok(dos(&Dir::absolute(root)?.path));
    }
    Ok(dos(&Asset::open(root, rel, 0, FILE_SHARE_READ)?.path))
}

/// Rename a pinned source, to a full name below pinned destination directory components.
pub(crate) fn rename_handle(file: &File, dir: &Dir, leaf: &OsStr) -> Result<()> {
    let to = dir.path.join(leaf);
    let w = wide(to.as_os_str());
    let len = (w.len() - 1) * 2;
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = (offset + len + 2).max(size_of::<FILE_RENAME_INFO>());
    let mut buf = vec![0usize; size.div_ceil(size_of::<usize>())];
    let p = buf.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // FILE_RENAME_INFO needs a native-aligned flexible buffer with the name inline.
    let result = unsafe {
        // Win32 FileRenameInfo requires RootDirectory to be null for full paths.
        (*p).FileNameLength = len as u32;
        std::ptr::copy_nonoverlapping(w.as_ptr(), (*p).FileName.as_mut_ptr(), w.len());
        SetFileInformationByHandle(raw(file), FileRenameInfo, p.cast(), size as u32)
    };
    result.map_err(|e| {
        let e = win_error("rename without overwrite", &to, e);
        if matches!(&e, Error::Io { source, .. } if source.kind() == io::ErrorKind::AlreadyExists)
            || fs::symlink_metadata(&to).is_ok()
        {
            Error::Collision(dos(&to))
        } else {
            e
        }
    })
}

pub fn rename(root: &Path, rel: &str, new_name: &str) -> Result<String> {
    rename_impl(root, rel, new_name, None)
}
pub fn rename_checked(
    root: &Path,
    rel: &str,
    new_name: &str,
    expected_identity: &str,
) -> Result<String> {
    rename_impl(root, rel, new_name, Some(expected_identity))
}
fn rename_impl(
    root: &Path,
    rel: &str,
    new_name: &str,
    expected_identity: Option<&str>,
) -> Result<String> {
    let new_name = name(new_name)?;
    let mut rel_parts = parts(rel, false)?;
    let asset = Asset::open(root, rel, DELETE.0, FILE_SHARE_READ)?;
    verify(&asset.file, &asset.path, expected_identity)?;
    rename_handle(&asset.file, &asset.parent, OsStr::new(new_name))?;
    *rel_parts.last_mut().unwrap() = new_name;
    Ok(rel_parts.join("/"))
}
pub fn move_asset(root: &Path, rel: &str, destination: &Path) -> Result<PathBuf> {
    move_impl(root, rel, destination, None)
}
pub fn move_asset_checked(
    root: &Path,
    rel: &str,
    destination: &Path,
    expected_identity: &str,
) -> Result<PathBuf> {
    move_impl(root, rel, destination, Some(expected_identity))
}
fn move_impl(
    root: &Path,
    rel: &str,
    destination: &Path,
    expected_identity: Option<&str>,
) -> Result<PathBuf> {
    let asset = Asset::open(root, rel, DELETE.0, FILE_SHARE_READ)?;
    verify(&asset.file, &asset.path, expected_identity)?;
    let dir = Dir::absolute(destination)?;
    if asset.is_dir && dir.path.starts_with(&asset.path) {
        return Err(Error::Refused("cannot move a directory into itself".into()));
    }
    if identity(&asset.file, &asset.path)?.volume != identity(dir.handle(), &dir.path)?.volume {
        return Err(Error::Unsupported("cross-volume moves are not performed"));
    }
    let leaf = asset.path.file_name().unwrap();
    rename_handle(&asset.file, &dir, leaf)?;
    Ok(dos(&dir.path.join(leaf)))
}
pub(crate) fn create_dir(path: &Path) -> Result<()> {
    fs::create_dir(path).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            Error::Collision(dos(path))
        } else {
            io_error("create directory", path, e)
        }
    })
}
pub fn mkdir(root: &Path, parent: &str, new_name: &str) -> Result<String> {
    let new_name = name(new_name)?;
    let mut rel_parts = parts(parent, true)?;
    let mut dir = Dir::absolute(root)?;
    for part in &rel_parts {
        dir.push(OsStr::new(part), false)?;
    }
    create_dir(&dir.path.join(new_name))?;
    rel_parts.push(new_name);
    Ok(rel_parts.join("/"))
}
