use crate::{content::extension, path::*, Error, Result};
use std::{
    cell::Cell,
    fs,
    io::{self, Read},
    path::Path,
};
use windows::{
    core::{implement, Error as WinError, Ref, HRESULT, PCWSTR},
    Win32::{
        Foundation::{E_ABORT, RPC_E_CHANGED_MODE, S_OK},
        Storage::FileSystem::*,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
            COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
        },
        UI::{
            Shell::{Common::ITEMIDLIST, *},
            WindowsAndMessaging::SW_SHOWNORMAL,
        },
    },
};

struct Apartment;
impl Apartment {
    fn enter() -> windows::core::Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.ok()?;
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

// Shell operations need an STA. Accept calls from a pre-initialized MTA host too.
fn sta<T: Send>(path: &Path, f: impl FnOnce() -> Result<T> + Send) -> Result<T> {
    match Apartment::enter() {
        Ok(_apt) => f(),
        Err(e) if e.code() == RPC_E_CHANGED_MODE => std::thread::scope(|scope| {
            scope
                .spawn(move || {
                    let _apt = Apartment::enter()
                        .map_err(|e| win_error("initialize Windows Shell STA", path, e))?;
                    f()
                })
                .join()
                .map_err(|_| Error::Refused("Windows Shell worker panicked".into()))?
        }),
        Err(e) => Err(win_error("initialize Windows Shell STA", path, e)),
    }
}

fn document_extension(ext: &str) -> bool {
    matches!(
        ext,
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
            | "css"
            | "rs"
            | "java"
            | "kt"
            | "c"
            | "h"
            | "cpp"
            | "hpp"
            | "cc"
            | "cs"
            | "go"
            | "swift"
            | "sql"
            | "diff"
            | "patch"
            | "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
            | "rtf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "bmp"
            | "tif"
            | "tiff"
            | "ico"
            | "mp3"
            | "wav"
            | "flac"
            | "ogg"
            | "m4a"
            | "mp4"
            | "webm"
            | "mkv"
            | "mov"
            | "avi"
            | "psd"
            | "ai"
            | "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
    )
}
fn show(path: &Path, mode: &str) -> Result<()> {
    let path = dos(path);
    let w = wide(path.as_os_str());
    let p = PCWSTR(w.as_ptr());
    let action = |e| win_error("Windows Shell action", &path, e);
    unsafe {
        match mode {
            "reveal" => {
                let mut pidl: *mut ITEMIDLIST = std::ptr::null_mut();
                SHParseDisplayName(p, None, &mut pidl, 0, None).map_err(action)?;
                let result = SHOpenFolderAndSelectItems(pidl, None, 0);
                ILFree(Some(pidl));
                result.map_err(action)
            }
            "properties" => {
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb: windows::core::w!("properties"),
                    lpFile: p,
                    nShow: SW_SHOWNORMAL.0,
                    ..Default::default()
                };
                ShellExecuteExW(&mut info).map_err(action)
            }
            "choose" => SHOpenWithDialog(
                None,
                &OPENASINFO {
                    pcszFile: p,
                    pcszClass: PCWSTR::null(),
                    oaifInFlags: OAIF_EXEC | OAIF_HIDE_REGISTRATION,
                },
            )
            .map_err(action),
            "default" | "run" => {
                let mut info = SHELLEXECUTEINFOW {
                    cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
                    fMask: SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
                    lpVerb: windows::core::w!("open"),
                    lpFile: p,
                    nShow: SW_SHOWNORMAL.0,
                    ..Default::default()
                };
                ShellExecuteExW(&mut info).map_err(action)
            }
            _ => Err(Error::Unsupported("unknown shell open mode")),
        }
    }
}

/// Explicit Shell interaction only. `allow_run` gates `run` (currently native .exe only).
/// Default/choose allow known document and media types, never scripts, shortcuts or executables.
pub fn open(root: &Path, rel: &str, mode: &str, allow_run: bool) -> Result<()> {
    open_impl(root, rel, mode, allow_run, None)
}
pub fn open_checked(
    root: &Path,
    rel: &str,
    mode: &str,
    allow_run: bool,
    expected_identity: &str,
) -> Result<()> {
    open_impl(root, rel, mode, allow_run, Some(expected_identity))
}
fn open_impl(
    root: &Path,
    rel: &str,
    mode: &str,
    allow_run: bool,
    expected_identity: Option<&str>,
) -> Result<()> {
    if !matches!(mode, "default" | "choose" | "reveal" | "properties" | "run") {
        return Err(Error::Unsupported("unknown shell open mode"));
    }
    if mode == "run" && !allow_run {
        return Err(Error::Refused(
            "explicit confirmation required to run a file".into(),
        ));
    }
    if rel.is_empty() {
        let dir = Dir::absolute(root)?;
        verify(dir.handle(), &dir.path, expected_identity)?;
        if matches!(mode, "choose" | "run") {
            return Err(Error::Unsupported("action is not available for folders"));
        }
        return sta(&dir.path, || show(&dir.path, mode));
    }
    let asset = Asset::open(root, rel, FILE_READ_DATA.0, FILE_SHARE_READ)?;
    verify(&asset.file, &asset.path, expected_identity)?;
    let ext = extension(&asset.path);
    if (mode == "choose" && asset.is_dir) || (mode == "run" && (asset.is_dir || ext != "exe")) {
        return Err(Error::Unsupported(
            "choose requires a document; run requires a native .exe",
        ));
    }
    if matches!(mode, "default" | "choose") && !asset.is_dir && !document_extension(&ext) {
        return Err(Error::Refused(
            "the type is not allowed for ordinary Shell open".into(),
        ));
    }
    if matches!(mode, "default" | "choose") && !asset.is_dir {
        let mut signature = Vec::new();
        (&asset.file)
            .take(2)
            .read_to_end(&mut signature)
            .map_err(|e| io_error("check for executable signature", &asset.path, e))?;
        if signature == b"MZ" {
            return Err(Error::Refused(
                "an executable signature is not allowed for ordinary Shell open".into(),
            ));
        }
    }
    sta(&asset.path, || show(&asset.path, mode))
}

#[implement(IFileOperationProgressSink)]
struct RecycleSink {
    path: std::path::PathBuf,
    expected: String,
    recycled: std::sync::Arc<std::sync::atomic::AtomicBool>,
    root_seen: Cell<bool>,
}
impl IFileOperationProgressSink_Impl for RecycleSink_Impl {
    fn StartOperations(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _: HRESULT) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, item: Ref<IShellItem>) -> windows::core::Result<()> {
        if self.root_seen.get() || flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            return Err(WinError::from_hresult(E_ABORT));
        }
        let matches = (|| -> windows::core::Result<bool> {
            let p = unsafe { item.ok()?.GetDisplayName(SIGDN_FILESYSPATH)? };
            let name = unsafe { p.to_string() };
            unsafe {
                CoTaskMemFree(Some(p.0.cast()));
            }
            let name = name.map_err(|_| WinError::from_hresult(E_ABORT))?;
            let expected_dos = dos(&self.path);
            let same_path = expected_dos
                .to_str()
                .map_or_else(|| Path::new(&name) == expected_dos, |s| name.eq_ignore_ascii_case(s));
            if !same_path {
                return Ok(false);
            }
            let result = file_open(
                &self.path,
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_DELETE,
                OPEN_EXISTING,
            )
            .and_then(|file| {
                real(&file, &self.path)?;
                identity_key(&file, &self.path)
            });
            Ok(result.is_ok_and(|id| id == self.expected))
        })()?;
        if !matches {
            return Err(WinError::from_hresult(E_ABORT));
        }
        self.root_seen.set(true);
        Ok(())
    }
    fn PostDeleteItem(
        &self,
        flags: u32,
        _: Ref<IShellItem>,
        status: HRESULT,
        new: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        if self.root_seen.get()
            && flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 != 0
            && matches!(status, S_OK | COPYENGINE_S_DONT_PROCESS_CHILDREN)
            && new.as_ref().is_some()
        {
            self.recycled
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows::core::Result<()> {
        Ok(())
    }
    fn PostNewItem(
        &self,
        _: u32,
        _: Ref<IShellItem>,
        _: &PCWSTR,
        _: &PCWSTR,
        _: u32,
        _: HRESULT,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows::core::Result<()> {
        Ok(())
    }
}

// Reject existing subtree reparse points and reserved paths; the actual delete is one Shell
// operation, never a recursive walk implemented by Vaulta, and rejects any child delete callback.
fn check_subtree(dir: &Dir, depth: usize, visited: &mut usize) -> Result<()> {
    for entry in
        fs::read_dir(&dir.path).map_err(|e| io_error("inspect recycle directory", &dir.path, e))?
    {
        *visited += 1;
        if depth >= 128 || *visited > 100_000 {
            return Err(Error::Unsupported(
                "recycle subtree safety inspection limit reached",
            ));
        }
        let entry = entry.map_err(|e| io_error("inspect directory entry", &dir.path, e))?;
        let path = entry.path();
        if !entry
            .file_name()
            .to_str()
            .is_some_and(|s| valid_component(s, false))
        {
            return Err(Error::InvalidPath(path.display().to_string()));
        }
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            check_subtree(&dir.child(&entry.file_name(), false)?, depth + 1, visited)?;
        } else {
            let file = file_open(
                &path,
                FILE_READ_ATTRIBUTES.0,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                OPEN_EXISTING,
            )?;
            if real(&file, &path)? {
                check_subtree(&dir.child(&entry.file_name(), false)?, depth + 1, visited)?;
            }
        }
    }
    Ok(())
}

/// Recoverable Recycle Bin operation only. Does not implement permanent deletion.
pub fn recycle(root: &Path, rel: &str) -> Result<()> {
    recycle_impl(root, rel, None)
}
pub fn recycle_checked(root: &Path, rel: &str, expected_identity: &str) -> Result<()> {
    recycle_impl(root, rel, Some(expected_identity))
}
fn recycle_impl(root: &Path, rel: &str, expected_identity: Option<&str>) -> Result<()> {
    let asset = Asset::open(root, rel, 0, FILE_SHARE_READ | FILE_SHARE_DELETE)?;
    let expected = identity_key(&asset.file, &asset.path)?;
    if let Some(wanted) = expected_identity {
        if expected != wanted {
            return Err(Error::Conflict);
        }
    }
    if asset.is_dir {
        let child = asset.parent.child(asset.path.file_name().unwrap(), false)?;
        verify(child.handle(), &child.path, Some(&expected))?;
        check_subtree(&child, 0, &mut 0)?;
    }
    sta(&asset.path, || unsafe {
        let dpath = dos(&asset.path);
        let drive = wide(Path::new(&dpath.to_str().unwrap()[..3]).as_os_str());
        if GetDriveTypeW(PCWSTR(drive.as_ptr())) != 3 {
            return Err(Error::Unsupported(
                "recycling is restricted to fixed local volumes",
            ));
        }
        let mut bin = SHQUERYRBINFO {
            cbSize: size_of::<SHQUERYRBINFO>() as u32,
            ..Default::default()
        };
        SHQueryRecycleBinW(PCWSTR(drive.as_ptr()), &mut bin)
            .map_err(|e| win_error("check Recycle Bin", &dpath, e))?;
        let context = |e| win_error("recycle with Windows Shell", &dpath, e);
        let w = wide(dpath.as_os_str());
        let item: IShellItem =
            SHCreateItemFromParsingName(PCWSTR(w.as_ptr()), None).map_err(context)?;
        let operation: IFileOperation =
            CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER).map_err(context)?;
        // No confirmation suppression: a fallback must never be accepted silently. EARLYFAILURE
        // and NOERRORUI keep errors from continuing; the sink refuses a non-recycling transfer.
        operation
            .SetOperationFlags(
                FOFX_RECYCLEONDELETE
                    | FOF_ALLOWUNDO
                    | FOFX_EARLYFAILURE
                    | FOF_NOERRORUI
                    | FOF_WANTNUKEWARNING
                    | FOFX_NOCOPYHOOKS,
            )
            .map_err(context)?;
        let state = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let sink: IFileOperationProgressSink = RecycleSink {
            path: asset.path.clone(),
            expected,
            recycled: state.clone(),
            root_seen: Cell::new(false),
        }
        .into();
        operation.DeleteItem(&item, &sink).map_err(context)?;
        operation.PerformOperations().map_err(context)?;
        let aborted = operation
            .GetAnyOperationsAborted()
            .map_err(context)?
            .as_bool();
        if aborted || !state.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(io_error(
                "recycle was cancelled or could not be confirmed",
                &dpath,
                io::Error::other("no recoverable item reported by Windows"),
            ));
        }
        Ok(())
    })
}
