//! Hosts the same read-only preview interfaces used by Windows Explorer. COM
//! callbacks and child windows live on a dedicated STA, not the Tauri UI thread.
use super::main_window;
use crate::Reply;
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::Write,
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, SystemTime},
};
use tauri::{State, WebviewWindow};
use vaulta_fs::RenderSource;
use windows::{
    Win32::{
        Foundation::{HWND, RECT},
        System::Com::{
            CLSCTX_LOCAL_SERVER, CLSIDFromString, COINIT_APARTMENTTHREADED, CoCreateInstance,
            CoInitializeEx, CoUninitialize, STGM_READ,
        },
        UI::{
            Shell::{
                ASSOCF_NOTRUNCATE, ASSOCSTR_SHELLEXTENSION, AssocQueryStringW, IInitializeWithItem,
                IPreviewHandler, IShellItem,
                PropertiesSystem::{IInitializeWithFile, IInitializeWithStream},
                SHCreateItemFromParsingName, SHCreateMemStream,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DestroyWindow, DispatchMessageW, GetClientRect, HWND_TOP,
                IsWindow, MSG, PM_REMOVE, PeekMessageW, SW_HIDE, SWP_NOACTIVATE, SWP_SHOWWINDOW,
                SetWindowPos, ShowWindow, TranslateMessage, WINDOW_EX_STYLE, WS_CHILD,
                WS_CLIPCHILDREN, WS_CLIPSIBLINGS,
            },
        },
    },
    core::{GUID, Interface, PCWSTR, PWSTR, w},
};

#[derive(Clone, Copy, Deserialize, PartialEq)]
pub(crate) struct Bounds {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[derive(Default, Clone, Copy)]
struct Layout {
    seq: u64,
    session: Option<u64>,
    bounds: Option<Bounds>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OpenResult {
    Shown,
    DownloadMarked,
}

struct Open {
    session: u64,
    source: RenderSource,
    confirmed_session: Option<u64>,
    reply: mpsc::SyncSender<Result<OpenResult>>,
}

struct DownloadPrompt {
    session: u64,
    revision: (String, u64, SystemTime),
}

#[derive(Clone)]
pub struct Worker {
    send: mpsc::SyncSender<Open>,
    layout: Arc<Mutex<Layout>>,
}

#[derive(Default)]
pub struct OfficeHost(Mutex<Option<Worker>>);

impl OfficeHost {
    pub fn worker(&self, window: &WebviewWindow) -> Result<Worker> {
        let mut worker = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("Office 预览器不可用。"))?;
        if let Some(worker) = worker.as_ref() {
            return Ok(worker.clone());
        }
        let parent = window.hwnd()?.0 as usize;
        let (send, recv) = mpsc::sync_channel(1);
        let layout = Arc::new(Mutex::new(Layout::default()));
        let thread_layout = layout.clone();
        thread::Builder::new()
            .name("vaulta-office-preview".into())
            .spawn(move || {
                if let Err(error) = run(parent, recv, thread_layout) {
                    eprintln!("vaulta: {error:#}");
                }
            })?;
        let active = Worker { send, layout };
        *worker = Some(active.clone());
        Ok(active)
    }
}

impl Worker {
    pub fn open(
        &self,
        session: u64,
        source: RenderSource,
        confirmed_session: Option<u64>,
    ) -> Result<OpenResult> {
        // Do not queue many files if a provider is slow or becomes unresponsive.
        let (reply, result) = mpsc::sync_channel(1);
        self.send
            .try_send(Open {
                session,
                source,
                confirmed_session,
                reply,
            })
            .map_err(|_| anyhow::anyhow!("Office 预览器正在处理其他文件，请重试。"))?;
        result
            .recv_timeout(Duration::from_secs(15))
            .context("Office 预览器未及时响应。")?
    }
}

#[tauri::command]
pub fn office_preview_layout(
    window: WebviewWindow,
    office: State<'_, OfficeHost>,
    seq: u64,
    session: Option<u64>,
    bounds: Option<Bounds>,
) -> Reply<()> {
    main_window(&window).map_err(|e| e.to_string())?;
    let worker = office.worker(&window).map_err(|e| e.to_string())?;
    let mut layout = worker.layout.lock().map_err(|_| "Office 预览器不可用。")?;
    if seq >= layout.seq {
        *layout = Layout {
            seq,
            session,
            bounds,
        };
    }
    Ok(())
}

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
struct Surface(HWND);
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            let _ = DestroyWindow(self.0);
        }
    }
}

struct Preview {
    handler: IPreviewHandler,
    _temporary: Option<tempfile::TempDir>,
}
impl Drop for Preview {
    fn drop(&mut self) {
        unsafe {
            let _ = self.handler.Unload();
        }
    }
}

fn run(parent: usize, recv: mpsc::Receiver<Open>, shared: Arc<Mutex<Layout>>) -> Result<()> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
    }
    let _apartment = Apartment;
    let parent = HWND(parent as _);
    let surface = Surface(unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            w!("Static"),
            w!(""),
            WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
            0,
            0,
            1,
            1,
            Some(parent),
            None,
            None,
            None,
        )?
    });
    let mut current: Option<(u64, Preview)> = None;
    let mut last = None;
    let mut download_prompt = None;
    loop {
        let mut msg = MSG::default();
        while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() } {
            unsafe {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if !unsafe { IsWindow(Some(parent)).as_bool() } {
            break;
        }
        let layout = *shared.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|(id, _)| Some(*id) != layout.session)
        {
            hide(&surface);
            current = None;
            last = None;
        }
        if let Some((_, preview)) = current.as_ref() {
            let bounds = clipped(parent, layout.bounds);
            if bounds != last {
                if let Some(b) = bounds {
                    let rect = local(b);
                    unsafe {
                        let _ = SetWindowPos(
                            surface.0,
                            Some(HWND_TOP),
                            b.left,
                            b.top,
                            rect.right,
                            rect.bottom,
                            SWP_NOACTIVATE | SWP_SHOWWINDOW,
                        );
                        let _ = preview.handler.SetRect(&rect);
                    }
                } else {
                    hide(&surface);
                }
                last = bounds;
            }
        }
        match recv.recv_timeout(Duration::from_millis(16)) {
            Ok(Open {
                session,
                source,
                confirmed_session,
                reply,
            }) => {
                if shared.lock().unwrap().session != Some(session) {
                    let _ = reply.send(Err(anyhow::anyhow!("预览已切换。")));
                    continue;
                }
                hide(&surface);
                drop(current.take());
                last = None;
                let rect = clipped(parent, shared.lock().unwrap().bounds)
                    .map(local)
                    .unwrap_or(RECT {
                        left: 0,
                        top: 0,
                        right: 320,
                        bottom: 400,
                    });
                let preview =
                    download_blocked(&source, &mut download_prompt, session, confirmed_session)
                        .and_then(|blocked| {
                            if blocked {
                                Ok(None)
                            } else {
                                start(&surface, &rect, source).map(Some)
                            }
                        });
                let result = match preview {
                    Ok(_) if shared.lock().unwrap().session != Some(session) => {
                        Err(anyhow::anyhow!("预览已切换。"))
                    }
                    Ok(None) => Ok(OpenResult::DownloadMarked),
                    Ok(Some(preview)) => {
                        current = Some((session, preview));
                        Ok(OpenResult::Shown)
                    }
                    Err(error) => Err(error),
                };
                if reply.send(result).is_err() {
                    current = None;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
    }
    Ok(())
}

fn hide(surface: &Surface) {
    unsafe {
        let _ = ShowWindow(surface.0, SW_HIDE);
    }
}
fn local(b: Bounds) -> RECT {
    RECT {
        left: 0,
        top: 0,
        right: b.right - b.left,
        bottom: b.bottom - b.top,
    }
}
fn clipped(parent: HWND, bounds: Option<Bounds>) -> Option<Bounds> {
    let mut b = bounds?;
    let mut area = RECT::default();
    unsafe { GetClientRect(parent, &mut area) }.ok()?;
    b.left = b.left.clamp(0, area.right);
    b.top = b.top.clamp(0, area.bottom);
    b.right = b.right.clamp(0, area.right);
    b.bottom = b.bottom.clamp(0, area.bottom);
    (b.right - b.left >= 16 && b.bottom - b.top >= 16).then_some(b)
}

fn handler_id(ext: &str) -> Result<GUID> {
    let assoc: Vec<u16> = format!(".{ext}").encode_utf16().chain([0]).collect();
    let mut result = [0u16; 64];
    let mut len = result.len() as u32;
    unsafe {
        AssocQueryStringW(
            ASSOCF_NOTRUNCATE,
            ASSOCSTR_SHELLEXTENSION,
            PCWSTR(assoc.as_ptr()),
            w!("{8895b1c6-b41f-4c1c-a562-0d564250836f}"),
            Some(PWSTR(result.as_mut_ptr())),
            &mut len,
        )
        .ok()
        .context("未找到此格式的 Windows 预览器；请安装或修复 Microsoft Office 或兼容的预览器。")?;
        CLSIDFromString(PCWSTR(result.as_ptr())).context("此格式的 Windows 预览器注册无效。")
    }
}

fn download_blocked(
    source: &RenderSource,
    pending: &mut Option<DownloadPrompt>,
    session: u64,
    confirmed_session: Option<u64>,
) -> Result<bool> {
    // Consume the previous prompt even if this request is for a different file.
    let previous = pending.take();
    if !source
        .has_zone_marker()
        .context("无法核对文件的下载来源。")?
    {
        return Ok(false);
    }
    let revision = source.revision()?;
    if previous.is_some_and(|p| Some(p.session) == confirmed_session && p.revision == revision) {
        return Ok(false);
    }
    *pending = Some(DownloadPrompt { session, revision });
    Ok(true)
}

fn start(surface: &Surface, rect: &RECT, source: RenderSource) -> Result<Preview> {
    let ext = source.extension();
    let clsid = handler_id(&ext)?;
    let bytes = source.into_bytes()?; // Release all source handles before calling COM.
    ensure!(!bytes.starts_with(b"MZ"), "文件内容与文档格式不符。");
    let handler: IPreviewHandler =
        unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }
            .context("无法启动此格式的 Windows 预览器；请安装或修复相应的桌面应用。")?;
    let mut preview = Preview {
        handler,
        _temporary: None,
    };
    // Give the provider only the verified bytes, never the original path.
    // Path-only providers get a disposable byte snapshot, not a Shell open
    // or an unblock of the original file. Marked sources reach this point
    // only through explicit, single-use consent.
    if let Ok(init) = preview.handler.cast::<IInitializeWithStream>() {
        let stream =
            unsafe { SHCreateMemStream(Some(&bytes)) }.context("无法分配 Office 预览缓冲区。")?;
        unsafe { init.Initialize(&stream, STGM_READ.0) }
            .context("Windows 预览器无法读取此文件。")?;
    } else {
        let temporary = tempfile::Builder::new()
            .prefix("vaulta-preview-")
            .tempdir()?;
        let file = temporary.path().join(format!("preview.{ext}"));
        File::create_new(&file)?.write_all(&bytes)?;
        preview._temporary = Some(temporary);
        initialize_file(&preview.handler, &file).context("Windows 预览器无法读取此文件。")?;
    }
    unsafe {
        // Prime the host size while hidden. The latest layout is applied only
        // after the handler returns, so stale requests never show old content.
        SetWindowPos(
            surface.0,
            None,
            0,
            0,
            rect.right,
            rect.bottom,
            SWP_NOACTIVATE,
        )?;
        preview.handler.SetWindow(surface.0, rect)?;
        preview
            .handler
            .DoPreview()
            .context("无法渲染文档；文件可能受保护、已损坏或格式不受预览器支持。")?;
    }
    Ok(preview)
}

fn initialize_file(handler: &IPreviewHandler, path: &Path) -> Result<()> {
    let path: Vec<u16> = path.as_os_str().encode_wide().chain([0]).collect();
    let path = PCWSTR(path.as_ptr());
    if let Ok(init) = handler.cast::<IInitializeWithFile>() {
        unsafe {
            init.Initialize(path, STGM_READ.0)?;
        }
    } else if let Ok(init) = handler.cast::<IInitializeWithItem>() {
        let item: IShellItem = unsafe { SHCreateItemFromParsingName(path, None)? };
        unsafe {
            init.Initialize(&item, STGM_READ.0)?;
        }
    } else {
        bail!("此 Windows 预览器不支持文档文件或流。");
    }
    Ok(())
}
