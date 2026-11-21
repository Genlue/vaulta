use std::ffi::OsStr;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

use crate::{invalid, Error, Result};

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Physical {
    pub identity: String,
    pub directory: bool,
    pub size: u64,
    pub created: i64,
    pub modified: i64,
    pub links: u32,
    // Native precision; used to detect mutation during directory enumeration.
    changed: i64,
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::fs::{File, OpenOptions};
    use std::mem::{size_of, MaybeUninit};
    use std::os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
        io::AsRawHandle,
    };
    use windows_sys::Win32::Globalization::CompareStringOrdinal;
    use windows_sys::Win32::Storage::FileSystem::*;

    pub(crate) type Handle = File;

    pub(crate) fn open(path: &Path, pin: bool) -> io::Result<Handle> {
        OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(
                FILE_SHARE_READ
                    | FILE_SHARE_WRITE
                    | if pin { 0 } else { FILE_SHARE_DELETE },
            )
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    }

    fn query<T>(file: &File, class: FILE_INFO_BY_HANDLE_CLASS) -> io::Result<T> {
        let mut out = MaybeUninit::<T>::uninit();
        // Win32 initializes the output on success. T matches the class at every call site.
        unsafe {
            if GetFileInformationByHandleEx(
                file.as_raw_handle(),
                class,
                out.as_mut_ptr().cast(),
                size_of::<T>() as u32,
            ) == 0
            {
                Err(io::Error::last_os_error())
            } else {
                Ok(out.assume_init())
            }
        }
    }

    pub(crate) fn inspect(file: &Handle) -> io::Result<Option<Physical>> {
        let basic: FILE_BASIC_INFO = query(file, FileBasicInfo)?;
        if basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Ok(None);
        }
        if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "expected a disk object",
            ));
        }
        let stat: FILE_STANDARD_INFO = query(file, FileStandardInfo)?;
        // Do not downgrade to a path or content key on filesystems without FileIdInfo.
        let id: FILE_ID_INFO = query(file, FileIdInfo)?;
        if basic.CreationTime <= 0 || stat.DeletePending || id.FileId.Identifier == [0; 16] {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "usable file ID and creation time required",
            ));
        }
        let key = u128::from_be_bytes(id.FileId.Identifier);
        let created = basic.CreationTime;
        Ok(Some(Physical {
            identity: format!(
                "win:{:016x}:{key:032x}:{created:016x}",
                id.VolumeSerialNumber
            ),
            directory: stat.Directory,
            size: if stat.Directory {
                0
            } else {
                stat.EndOfFile.max(0) as u64
            },
            created: filetime_ms(created),
            modified: filetime_ms(basic.LastWriteTime),
            links: stat.NumberOfLinks,
            changed: basic.ChangeTime,
        }))
    }

    pub(crate) fn basic_stable(file: &Handle, before: &Physical) -> bool {
        let Ok(basic) = query::<FILE_BASIC_INFO>(file, FileBasicInfo) else {
            return false;
        };
        basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
            && basic.ChangeTime == before.changed
            && filetime_ms(basic.LastWriteTime) == before.modified
    }

    pub(crate) fn final_path(file: &Handle) -> io::Result<PathBuf> {
        let mut stack = [0u16; 512];
        let count = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                stack.as_mut_ptr(),
                stack.len() as u32,
                FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
            )
        } as usize;
        if count == 0 {
            return Err(io::Error::last_os_error());
        }
        if count < stack.len() {
            return Ok(std::ffi::OsString::from_wide(&stack[..count]).into());
        }
        let mut buffer = vec![0u16; count + 1];
        loop {
            let count = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
                )
            } as usize;
            if count == 0 {
                return Err(io::Error::last_os_error());
            }
            if count < buffer.len() {
                return Ok(std::ffi::OsString::from_wide(&buffer[..count]).into());
            }
            buffer.resize(count + 1, 0);
        }
    }

    fn filetime_ms(value: i64) -> i64 {
        value.div_euclid(10_000) - 11_644_473_600_000
    }

    pub(crate) fn same_name(a: &OsStr, b: &OsStr) -> bool {
        let mut sa = [0u16; 260];
        let mut sb = [0u16; 260];
        let mut na = 0usize;
        let mut overflow = false;
        for u in a.encode_wide() {
            if na < sa.len() {
                sa[na] = u;
                na += 1;
            } else {
                overflow = true;
                break;
            }
        }
        let mut nb = 0usize;
        if !overflow {
            for u in b.encode_wide() {
                if nb < sb.len() {
                    sb[nb] = u;
                    nb += 1;
                } else {
                    overflow = true;
                    break;
                }
            }
        }
        if !overflow {
            return unsafe {
                CompareStringOrdinal(sa.as_ptr(), na as i32, sb.as_ptr(), nb as i32, 1) == 2
            };
        }
        let a: Vec<_> = a.encode_wide().collect();
        let b: Vec<_> = b.encode_wide().collect();
        unsafe {
            CompareStringOrdinal(a.as_ptr(), a.len() as i32, b.as_ptr(), b.len() as i32, 1) == 2
        }
    }
}

// Native Windows is the supported target. Fail closed rather than using a weaker identity.
#[cfg(not(windows))]
mod native {
    use super::*;
    pub(crate) type Handle = ();
    pub(crate) fn open(_: &Path, _: bool) -> io::Result<Handle> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows file identity required",
        ))
    }
    pub(crate) fn inspect(_: &Handle) -> io::Result<Option<Physical>> {
        Ok(None)
    }
    pub(crate) fn basic_stable(_: &Handle, _: &Physical) -> bool {
        false
    }
    pub(crate) fn final_path(_: &Handle) -> io::Result<PathBuf> {
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "Windows path required",
        ))
    }
    pub(crate) fn same_name(a: &OsStr, b: &OsStr) -> bool {
        a == b
    }
}

pub(crate) use native::{basic_stable, final_path, inspect, open, same_name, Handle};

#[derive(Debug)]
pub(crate) struct Guarded {
    // Keep traversed ancestors pinned against normal rename/delete while using pathname APIs.
    pub(crate) ancestors: Vec<Handle>,
    pub(crate) handle: Handle,
    pub(crate) physical: Physical,
}

pub(crate) fn reserved(name: &OsStr) -> bool {
    name.to_str()
        .is_some_and(|s| s.eq_ignore_ascii_case(".vaulta-views"))
}

fn valid_name(s: &str) -> bool {
    if s.is_empty()
        || s.ends_with(['.', ' '])
        || s.contains(['\\', '/', ':', '<', '>', '"', '|', '?', '*'])
        || s.encode_utf16().count() > 255
        || s.chars().any(char::is_control)
    {
        return false;
    }
    let stem = s.split('.').next().unwrap_or_default().trim_end();
    if matches!(stem.len(), 3 | 6 | 7)
        && (stem.eq_ignore_ascii_case("CON")
            || stem.eq_ignore_ascii_case("PRN")
            || stem.eq_ignore_ascii_case("AUX")
            || stem.eq_ignore_ascii_case("NUL")
            || stem.eq_ignore_ascii_case("CONIN$")
            || stem.eq_ignore_ascii_case("CONOUT$"))
    {
        return false;
    }
    if let Some(prefix) = stem.get(..3) {
        if prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT") {
            let suffix = &stem[3..];
            if matches!(
                suffix,
                "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            ) {
                return false;
            }
        }
    }
    true
}

pub(crate) fn relative(path: &str) -> Result<PathBuf> {
    if path.is_empty()
        || path
            .split('/')
            .any(|part| !valid_name(part) || reserved(OsStr::new(part)))
    {
        return Err(invalid(
            "expected a safe slash-separated vault-relative path",
        ));
    }
    Ok(path.split('/').collect())
}

pub(crate) fn validate_absolute(path: &Path) -> Result<()> {
    if !path.is_absolute() || path.to_str().is_none() {
        return Err(invalid("expected an absolute UTF-8 path"));
    }
    for part in path.components() {
        match part {
            Component::Normal(part) if part.to_str().is_some_and(valid_name) && !reserved(part) => {
            }
            #[cfg(windows)]
            Component::Prefix(p) => {
                use std::path::Prefix::*;
                if !matches!(
                    p.kind(),
                    Disk(_) | VerbatimDisk(_) | UNC(..) | VerbatimUNC(..)
                ) {
                    return Err(invalid("expected a Windows drive or UNC path"));
                }
            }
            Component::RootDir => (),
            _ => return Err(invalid("invalid path component")),
        }
    }
    Ok(())
}

pub(crate) fn guarded(path: &Path) -> Result<Guarded> {
    validate_absolute(path)?;
    let mut paths: Vec<_> = path.ancestors().filter(|p| p.has_root()).collect();
    paths.reverse();
    let mut ancestors = Vec::new();
    for p in paths {
        let handle = open(p, true).map_err(|e| Error::Filesystem(p.into(), e))?;
        let physical = required(p, &handle)?;
        validate_handle_path(p, &handle)?;
        if p == path {
            return Ok(Guarded {
                ancestors,
                handle,
                physical,
            });
        }
        if !physical.directory {
            return Err(invalid(format!(
                "ancestor is not a directory: {}",
                p.display()
            )));
        }
        ancestors.push(handle);
    }
    Err(invalid("path has no filesystem root"))
}

fn validate_handle_path(path: &Path, handle: &Handle) -> Result<()> {
    let actual = final_path(handle).map_err(|e| Error::Filesystem(path.into(), e))?;
    validate_absolute(&actual)
}

/// Ensure an explicit rebind records the real spelling, not an 8.3 or case alias.
pub(crate) fn validate_spelling(path: &Path, handle: &Handle, rel: &str) -> Result<()> {
    let actual = final_path(handle).map_err(|e| Error::Filesystem(path.into(), e))?;
    if !rel
        .rsplit('/')
        .zip(actual.components().rev())
        .all(|(part, component)| matches!(component, Component::Normal(n) if n == OsStr::new(part)))
    {
        return Err(invalid(
            "destination must use its actual vault-relative spelling",
        ));
    }
    Ok(())
}

pub(crate) fn required(path: &Path, handle: &Handle) -> Result<Physical> {
    inspect(handle)
        .map_err(|e| Error::Filesystem(path.into(), e))?
        .ok_or_else(|| {
            invalid(format!(
                "reparse points are not managed: {}",
                path.display()
            ))
        })
}

/// Read the identity used by reconciliation, including the full native creation timestamp.
/// Returns `None` for a final reparse point. Ancestor reparse points and I/O failures are errors.
pub fn identity(path: &Path) -> Result<Option<String>> {
    let path = std::path::absolute(path).map_err(|e| Error::Filesystem(path.into(), e))?;
    validate_absolute(&path)?;
    let _parent = if let Some(parent) = path.parent().filter(|p| p.has_root()) {
        Some(guarded(parent)?)
    } else {
        None
    };
    let handle = open(&path, false).map_err(|e| Error::Filesystem(path.clone(), e))?;
    let physical = inspect(&handle).map_err(|e| Error::Filesystem(path.clone(), e))?;
    if let Some(physical) = physical {
        validate_handle_path(&path, &handle)?;
        Ok(Some(physical.identity))
    } else {
        Ok(None)
    }
}

pub(crate) struct Entry {
    pub path: String,
    pub physical: Physical,
}

pub(crate) struct Walk {
    pub entries: Vec<Entry>,
    pub complete: bool,
    pub root_listed: bool,
}

impl Walk {
    pub(crate) fn collect(
        root: &Path,
        guard: &Guarded,
        units: &std::collections::HashSet<String>,
    ) -> Self {
        let mut walk = Self {
            entries: Vec::new(),
            complete: true,
            root_listed: false,
        };
        walk.descend(root, "", &guard.handle, &guard.physical, units, 0);
        walk.entries.sort_unstable_by(|a, b| a.path.cmp(&b.path));
        walk
    }

    pub(crate) fn validate_root(&mut self, guard: &Guarded) {
        if !basic_stable(&guard.handle, &guard.physical) {
            self.entries.clear();
            self.complete = false;
        }
    }

    fn descend(
        &mut self,
        dir: &Path,
        prefix: &str,
        handle: &Handle,
        before: &Physical,
        units: &std::collections::HashSet<String>,
        depth: usize,
    ) {
        // Bound stack and simultaneously pinned handles even for pathological trees.
        if depth >= 256 {
            self.complete = false;
            return;
        }
        let start = self.entries.len();
        let Ok(entries) = fs::read_dir(dir) else {
            self.complete = false;
            return;
        };
        if depth == 0 {
            self.root_listed = true;
        }
        for item in entries {
            let Ok(item) = item else {
                self.complete = false;
                continue;
            };
            let name = item.file_name();
            if reserved(&name) {
                continue;
            }
            let Some(name) = name.to_str().filter(|s| valid_name(s)) else {
                self.complete = false;
                continue;
            };
            // On Windows, DirEntry::file_type reads WIN32_FIND_DATAW directly with zero syscalls.
            let ft = item.file_type().ok();
            if ft.is_some_and(|t| t.is_symlink()) {
                continue;
            }
            let path = item.path();
            let rel = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            let expect_dir = ft.is_some_and(|t| t.is_dir());
            let physical = if expect_dir {
                match open(&path, true).and_then(|child| inspect(&child).map(|p| (child, p))) {
                    Ok((child, Some(p))) => {
                        if p.directory && !units.contains(&p.identity) {
                            self.descend(&path, &rel, &child, &p, units, depth + 1);
                        }
                        p
                    }
                    Ok((_, None)) => continue,
                    Err(_) => {
                        self.complete = false;
                        continue;
                    }
                }
            } else {
                let physical = match open(&path, false).and_then(|handle| inspect(&handle)) {
                    Ok(Some(p)) => p,
                    Ok(None) => continue,
                    Err(_) => {
                        self.complete = false;
                        continue;
                    }
                };
                if physical.directory && !units.contains(&physical.identity) {
                    match open(&path, true).and_then(|child| inspect(&child).map(|p| (child, p))) {
                        Ok((child, Some(p))) if p.identity == physical.identity => {
                            self.descend(&path, &rel, &child, &p, units, depth + 1)
                        }
                        _ => {
                            self.complete = false;
                            continue;
                        }
                    }
                }
                physical
            };
            self.entries.push(Entry {
                path: rel,
                physical,
            });
        }
        if !basic_stable(handle, before) {
            // Discard the unstable subtree rather than committing observations from a raced path.
            self.entries.truncate(start);
            self.complete = false;
        }
    }
}
