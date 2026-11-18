//! GlassDesign 的宿主胶水：窗口装配 + 桌面快照 + 壁纸接线。
//!
//! 为什么需要这个 crate：液态玻璃要折「窗口背后的桌面」，但 `backdrop-filter`
//! 只能采窗口内的像素 —— 窗口外的桌面它看不到。所以宿主必须先把窗口背后那块
//! 屏幕截成 PNG data URL，前端铺在 `#wallpaper` 上当材质输入，玻璃再折它。
//!
//! **取舍**：为了不把窗口自己截进「桌面快照」，`install()` 会给窗口挂
//! `WDA_EXCLUDEFROMCAPTURE` —— 副作用是系统截图、录屏、任务栏预览都拍不到它。
//! 需要被截图的应用用 [`install_with`] + `HostOptions { exclude_from_capture: false }`。
//!
//! 接入只需要两步：
//! 1. `.invoke_handler(glass_design_host::handlers!())` + `glass_design_host::install(app.handle())`
//! 2. 把 [`WALLPAPER_JS`] 同步成 `dist/wallpaper.js`（见 `scripts/sync-host-assets.mjs`）

/// 前端壁纸接线脚本：调 `capture_backdrop`、亮度校验、移动/缩放去抖、8 秒轮询。
///
/// 应用把它落到 dist 里当普通 `<script>` 跑（不是 ESM），页面一行都不用写这段。
pub const WALLPAPER_JS: &str = include_str!("../assets/wallpaper.js");

/// 一行注册命令：`app.invoke_handler(glass_design_host::handlers!())`
///
/// `$crate::capture_backdrop` 是必须的：`handlers!` 会被展开在应用的 crate 里，
/// 直接写 `capture_backdrop` 会去应用的根作用域找，找不到。
#[macro_export]
macro_rules! handlers {
    () => {
        tauri::generate_handler![$crate::capture_backdrop]
    };
}

/// 截「窗口背后那块屏幕」，编码成 PNG data URL 交给前端当背景层。
///
/// 截图前必须先 [`install`] 给窗口挂 `WDA_EXCLUDEFROMCAPTURE`：否则抓到的图里
/// 包含我们自己的窗口，下一帧又被贴回背景，会形成「镜中镜」的无限递归。
///
/// 实现放在子模块里：`#[tauri::command]` 会给 `pub fn` 生成 `#[macro_export]`
/// 的辅助宏，宏落在 crate 根；如果函数本身也写在根上，两者在同一命名空间撞名。
mod command {
    /// Windows：真截屏。
    #[cfg(windows)]
    #[tauri::command]
    pub fn capture_backdrop(window: tauri::WebviewWindow) -> Result<String, String> {
        super::imp::capture(&window)
    }

    /// 非 Windows 目标只保证能编译：没有 GDI，截不了屏，让前端退回合成背景。
    #[cfg(not(windows))]
    #[tauri::command]
    pub fn capture_backdrop(_window: tauri::WebviewWindow) -> Result<String, String> {
        Err("仅 Windows 实现".into())
    }
}

pub use command::capture_backdrop;

/// 宿主装配的开关。
#[derive(Debug, Clone, Copy)]
pub struct HostOptions {
    /// 给窗口挂 `WDA_EXCLUDEFROMCAPTURE`。默认 `true`。
    ///
    /// **这是有代价的**：那个 API 的语义是「让这个窗口不被任何截屏接口拍到」，
    /// 于是系统截图、录屏、任务栏与 Alt-Tab 的窗口预览也一并失效。
    /// 不挂的话，`capture_backdrop` 截到的桌面里会包含窗口自己，玻璃折出镜中镜。
    ///
    /// 二选一：
    /// - 界面本身就是主体、用户可能想截图（相册、笔记、阅读器）→ `false`，
    ///   同时别引 `wallpaper.js`，让壁纸退回 `tokens.css` 的合成背景；
    /// - 只要玻璃效果、不介意拍不到 → `true`（默认）。
    pub exclude_from_capture: bool,
}

impl Default for HostOptions {
    fn default() -> Self {
        Self {
            exclude_from_capture: true,
        }
    }
}

/// 给窗口挂 `WDA_EXCLUDEFROMCAPTURE`：截屏前必须先挂，否则截到的桌面里包含自己。
///
/// 等同于 `install_with(app, HostOptions::default())`。
/// 需要让应用能被系统截图的，改用 `install_with(app, HostOptions { exclude_from_capture: false })`。
#[cfg(windows)]
pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    install_with(app, HostOptions::default())
}

/// 同 [`install`]，但可以关掉「排除截屏」。
#[cfg(windows)]
pub fn install_with(app: &tauri::AppHandle, opts: HostOptions) -> Result<(), String> {
    use tauri::Manager;
    use windows::Win32::Foundation::HWND;

    if !opts.exclude_from_capture {
        return Ok(());
    }
    // 找不到 main 窗口不算致命：原实现同样是静默跳过，应用照常启动。
    if let Some(win) = app.get_webview_window("main") {
        if let Ok(hwnd) = win.hwnd() {
            // 挂失败也不中断启动：只是截出来的图可能有「镜中镜」。
            let _ = imp::exclude_from_capture(HWND(hwnd.0));
        }
    }
    Ok(())
}

/// 非 Windows 目标：没有这个 API，空实现即可。
#[cfg(not(windows))]
pub fn install(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// 非 Windows 目标：同上。
#[cfg(not(windows))]
pub fn install_with(_app: &tauri::AppHandle, _opts: HostOptions) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
mod imp {
    use std::io::Cursor;

    use base64::Engine as _;
    use tauri::WebviewWindow;
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
        HGDIOBJ, SRCCOPY,
    };
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE,
    };

    /// tauri 的 hwnd 来自它自己那份 windows crate，版本未必与我们相同；
    /// 用裸句柄重建一个本 crate 的 HWND，避开跨版本类型不匹配。
    pub(super) fn exclude_from_capture(hwnd: HWND) -> windows::core::Result<()> {
        unsafe { SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE) }
    }

    pub(super) fn capture(window: &WebviewWindow) -> Result<String, String> {
        let pos = window.outer_position().map_err(|e| e.to_string())?;
        let size = window.outer_size().map_err(|e| e.to_string())?;
        let (x, y) = (pos.x, pos.y);
        let (w, h) = (size.width as i32, size.height as i32);
        if w <= 0 || h <= 0 {
            return Err("窗口尺寸为空".into());
        }

        // 屏幕 DC：整块桌面的合成结果（含其它窗口）
        let screen = unsafe { GetDC(None) };
        if screen.is_invalid() {
            return Err("GetDC 失败".into());
        }
        let mem = unsafe { CreateCompatibleDC(Some(screen)) };
        let bmp = unsafe { CreateCompatibleBitmap(screen, w, h) };
        if mem.is_invalid() || bmp.is_invalid() {
            unsafe {
                let _ = ReleaseDC(None, screen);
            }
            return Err("CreateCompatible* 失败".into());
        }

        let mut pixels: Vec<u8> = Vec::new();
        let mut ok;
        unsafe {
            let old = SelectObject(mem, HGDIOBJ(bmp.0));
            ok = BitBlt(mem, 0, 0, w, h, Some(screen), x, y, SRCCOPY).is_ok();
            if ok {
                // biHeight 取负数：要 top-down 的行序，省一次翻转
                let mut bi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -h,
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                pixels.resize((w * h * 4) as usize, 0);
                let lines = GetDIBits(
                    mem,
                    bmp,
                    0,
                    h as u32,
                    Some(pixels.as_mut_ptr().cast()),
                    &mut bi,
                    DIB_RGB_COLORS,
                );
                ok = lines == h;
            }
            SelectObject(mem, old);
            let _ = DeleteObject(HGDIOBJ(bmp.0));
            let _ = DeleteDC(mem);
            let _ = ReleaseDC(None, screen);
        }

        if !ok {
            return Err("BitBlt / GetDIBits 失败".into());
        }

        // BGRA → RGBA。第 4 字节是 GDI 的填充位，PNG 需要 255。
        for px in pixels.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }

        let mut out = Vec::new();
        {
            let mut enc = png::Encoder::new(Cursor::new(&mut out), w as u32, h as u32);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            let mut writer = enc.write_header().map_err(|e| e.to_string())?;
            writer
                .write_image_data(&pixels)
                .map_err(|e| e.to_string())?;
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&out);
        Ok(format!("data:image/png;base64,{b64}"))
    }
}
