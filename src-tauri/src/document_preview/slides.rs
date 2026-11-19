//! PowerPoint's preview handler can create a window without painting a slide.
//! Export actual slide bitmaps instead, off the UI thread, with no slideshow window.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use flate2::bufread::DeflateDecoder;
use quick_xml::{Reader, XmlVersion, events::Event};
use rawzip::{CompressionMethod, ZipArchive};
use serde::Serialize;
use std::collections::HashSet;
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, SystemTime},
};
use vaulta_fs::RenderSource;
use windows::{
    Win32::System::{
        Com::{
            CLSCTX_LOCAL_SERVER, CLSIDFromProgID, COINIT_APARTMENTTHREADED, CoCreateInstance,
            CoInitializeEx, CoUninitialize, DISPATCH_FLAGS, DISPATCH_METHOD, DISPATCH_PROPERTYGET,
            DISPATCH_PROPERTYPUT, DISPPARAMS, IDispatch,
        },
        Ole::DISPID_PROPERTYPUT,
        Variant::VARIANT,
    },
    core::{BSTR, GUID, w},
};

#[derive(Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum PageResult {
    Rendered { count: u32, data_url: String },
    DownloadMarked,
}

struct Request {
    source: RenderSource,
    index: u32,
    session: u64,
    confirmed_session: Option<u64>,
    reply: mpsc::SyncSender<Result<PageResult>>,
}

#[derive(Clone, Default)]
pub struct SlidesHost(Arc<Mutex<Option<mpsc::SyncSender<Request>>>>);

impl SlidesHost {
    pub fn page(
        &self,
        source: RenderSource,
        index: u32,
        session: u64,
        confirmed_session: Option<u64>,
    ) -> Result<PageResult> {
        let send = {
            let mut worker = self
                .0
                .lock()
                .map_err(|_| anyhow::anyhow!("幻灯片渲染器不可用。"))?;
            if let Some(send) = worker.as_ref() {
                send.clone()
            } else {
                let (send, recv) = mpsc::sync_channel(1);
                thread::Builder::new()
                    .name("vaulta-slides-preview".into())
                    .spawn(move || run(recv))?;
                *worker = Some(send.clone());
                send
            }
        };
        let (reply, result) = mpsc::sync_channel(1);
        send.try_send(Request {
            source,
            index,
            session,
            confirmed_session,
            reply,
        })
        .map_err(|_| anyhow::anyhow!("PowerPoint 正在渲染其他幻灯片，请重试。"))?;
        result
            .recv_timeout(Duration::from_secs(15))
            .context("PowerPoint 未及时完成渲染；请重试或用系统应用打开。")?
    }
}

type Revision = (String, u64, SystemTime);

fn run(recv: mpsc::Receiver<Request>) {
    let mut prompt: Option<(u64, Revision)> = None;
    let mut allowed: Option<(u64, Revision)> = None;
    while let Ok(req) = recv.recv() {
        let previous_prompt = prompt.take();
        let previous_allowed = allowed.take();
        let mut next_allowed = None;
        let result = (|| {
            let marker = req
                .source
                .open_zone_marker()
                .context("无法核对文件的下载来源。")?;
            if marker.is_some() {
                let revision = req.source.revision()?;
                let confirmed = previous_prompt.is_some_and(|(session, old)| {
                    Some(session) == req.confirmed_session && old == revision
                }) || previous_allowed
                    .is_some_and(|(session, old)| session == req.session && old == revision);
                if !confirmed {
                    prompt = Some((req.session, revision));
                    return Ok(PageResult::DownloadMarked);
                }
                next_allowed = Some((req.session, revision));
            }
            render(req.source, marker, req.index)
        })();
        let rendered = matches!(result, Ok(PageResult::Rendered { .. }));
        if req.reply.send(result).is_ok() && rendered {
            allowed = next_allowed;
        }
    }
}

struct Apartment;
impl Apartment {
    fn enter() -> Result<Self> {
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()? };
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn render(source: RenderSource, marker: Option<File>, index: u32) -> Result<PageResult> {
    let ext = source.extension();
    let mut zone = Vec::new();
    let marked = marker.is_some();
    if let Some(marker) = marker {
        marker.take(65537).read_to_end(&mut zone)?;
        ensure!(zone.len() <= 65536, "Windows 下载标记过大，无法预览。");
    }
    let bytes = source.into_bytes()?;
    // Encrypted OOXML uses a compound-file envelope. Don't send it (or a
    // misnamed legacy file) to Office, where it could prompt for a password.
    ensure!(
        bytes.starts_with(b"PK\x03\x04"),
        "此文件不是有效的 PPTX / PPSX，或受密码保护。"
    );
    check_package(&bytes)?;
    let temp = tempfile::Builder::new()
        .prefix("vaulta-slides-")
        .tempdir()?;
    let input = temp.path().join(format!("preview.{ext}"));
    File::create_new(&input)?.write_all(&bytes)?;
    if marked {
        let mut stream = input.as_os_str().to_os_string();
        stream.push(":Zone.Identifier:$DATA");
        File::create_new(stream)
            .and_then(|mut file| file.write_all(&zone))
            .context("无法为临时副本保留 Windows 下载标记。")?;
    }
    let _apartment = Apartment::enter()?;
    let clsid = unsafe { CLSIDFromProgID(w!("PowerPoint.Application")) }
        .context("未找到桌面版 Microsoft PowerPoint，无法渲染幻灯片。")?;
    let app: IDispatch = unsafe { CoCreateInstance(&clsid, None, CLSCTX_LOCAL_SERVER) }
        .context("无法启动 PowerPoint 渲染器。")?;
    let presentations = object(&app, "Presentations", DISPATCH_PROPERTYGET, &mut [])?;
    let document = {
        // The automation instance can be shared with the user's open PowerPoint.
        // Force macros off only for Open, restore immediately, and never Quit it.
        let _macros = MacroGuard::enter(&app)?;
        Presentation(
            object(
                &presentations,
                "Open",
                DISPATCH_METHOD,
                &mut [
                    0i32.into(),    // WithWindow = msoFalse
                    0i32.into(),    // Untitled = msoFalse
                    (-1i32).into(), // ReadOnly = msoTrue
                    file_arg(&input),
                ],
            )
            .context("PowerPoint 无法以只读方式打开此演示文稿。")?,
        )
    };
    let slides = object(&document.0, "Slides", DISPATCH_PROPERTYGET, &mut [])?;
    let count = u32::try_from(&property(&slides, "Count")?)?;
    ensure!(
        index < count && index < i32::MAX as u32,
        "此演示文稿中没有这张幻灯片。"
    );
    let slide = object(
        &slides,
        "Item",
        DISPATCH_METHOD | DISPATCH_PROPERTYGET,
        &mut [(index as i32 + 1).into()],
    )?;
    let setup = object(&document.0, "PageSetup", DISPATCH_PROPERTYGET, &mut [])?;
    let width = f64::try_from(&property(&setup, "SlideWidth")?)?;
    let height = f64::try_from(&property(&setup, "SlideHeight")?)?;
    ensure!(
        width.is_finite() && height.is_finite() && width > 0. && height > 0.,
        "无效的幻灯片尺寸。"
    );
    let scale = 1600. / width.max(height);
    let output = temp.path().join("slide.png");
    invoke(
        &slide,
        "Export",
        DISPATCH_METHOD,
        &mut [
            ((height * scale).round().max(1.) as i32).into(),
            ((width * scale).round().max(1.) as i32).into(),
            "PNG".into(),
            file_arg(&output),
        ],
    )
    .context("PowerPoint 无法绘制此幻灯片。")?;
    const MAX_PNG: u64 = 14 * 1024 * 1024;
    let mut png = Vec::new();
    File::open(output)?
        .take(MAX_PNG + 1)
        .read_to_end(&mut png)?;
    ensure!(
        png.len() as u64 <= MAX_PNG && png.starts_with(b"\x89PNG\r\n\x1a\n"),
        "未生成可用的幻灯片图像。"
    );
    Ok(PageResult::Rendered {
        count,
        data_url: format!("data:image/png;base64,{}", STANDARD.encode(png)),
    })
}

// This route opens a copy for rendering rather than using the Shell preview
// interface. Refuse active package parts and external data relationships before
// calling Office. Ordinary click-only hyperlinks are not followed by export.
fn check_package(bytes: &[u8]) -> Result<()> {
    const MAX_ENTRIES: u64 = 16_384;
    const MAX_EXPANDED: u64 = 512 * 1024 * 1024;
    const MAX_RELATIONSHIPS: u64 = 8 * 1024 * 1024;
    let zip = ZipArchive::from_slice(bytes).context("此文件不是有效的 PowerPoint 文档。")?;
    let mut names = HashSet::new();
    let mut expanded = 0u64;
    let mut rel_bytes = 0u64;
    for entry in zip.entries() {
        let entry = entry?;
        let name = entry.file_path().as_bytes().to_ascii_lowercase();
        let size = entry.uncompressed_size_hint();
        expanded = expanded.saturating_add(size);
        ensure!(
            names.len() < MAX_ENTRIES as usize
                && expanded <= MAX_EXPANDED
                && names.insert(name.clone())
                && !entry.flags().is_encrypted(),
            "PowerPoint 文件包无效、已加密或超出预览限制。"
        );
        ensure!(
            !name.starts_with(b"ppt/activex/") && !name.ends_with(b"/vbaproject.bin"),
            "PowerPoint 文件含有活动内容，请用系统应用打开。"
        );
        if name.ends_with(b".rels") {
            rel_bytes = rel_bytes.saturating_add(size);
            ensure!(
                rel_bytes <= MAX_RELATIONSHIPS,
                "PowerPoint 文件包超出预览限制。"
            );
            let local = zip.get_entry(entry.wayfinder())?;
            ensure!(
                local.local_header().file_path().as_bytes() == entry.file_path().as_bytes()
                    && !local.local_header().flags().is_encrypted()
                    && local.compressed_data_range().1 <= zip.directory_offset(),
                "PowerPoint 文件包无效。"
            );
            let mut xml = Vec::new();
            match entry.compression_method() {
                CompressionMethod::STORE => local
                    .verifying_reader(local.data())
                    .take(size + 1)
                    .read_to_end(&mut xml)?,
                CompressionMethod::DEFLATE => local
                    .verifying_reader(DeflateDecoder::new(local.data()))
                    .take(size + 1)
                    .read_to_end(&mut xml)?,
                _ => anyhow::bail!("不支持此 PowerPoint 压缩格式。"),
            };
            ensure!(xml.len() as u64 == size, "PowerPoint 文件包无效。");
            check_relationships(&xml)?;
        }
    }
    ensure!(
        names.contains(b"[content_types].xml".as_slice())
            && names.contains(b"ppt/presentation.xml".as_slice()),
        "此文件不是有效的 PowerPoint 文档。"
    );
    Ok(())
}

fn check_relationships(xml: &[u8]) -> Result<()> {
    let mut reader = Reader::from_reader(xml);
    loop {
        match reader.read_event()? {
            Event::Start(node) | Event::Empty(node)
                if node.local_name().as_ref() == "Relationship" =>
            {
                let mut external = false;
                let mut hyperlink = false;
                for attr in node.attributes() {
                    let attr = attr?;
                    match attr.key.as_ref() {
                        "TargetMode" => {
                            external = attr
                                .normalized_value(XmlVersion::Implicit1_0)?
                                .eq_ignore_ascii_case("External")
                        }
                        "Type" => {
                            hyperlink = matches!(
                                attr.normalized_value(XmlVersion::Implicit1_0)?.as_ref(),
                                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
                                    | "http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink"
                            )
                        }
                        _ => (),
                    }
                }
                ensure!(
                    !external || hyperlink,
                    "演示文稿链接了外部资源，请用系统应用打开。"
                );
            }
            Event::DocType(_) => anyhow::bail!("PowerPoint 文件包无效。"),
            Event::Eof => return Ok(()),
            _ => (),
        }
    }
}

struct Presentation(IDispatch);
impl Drop for Presentation {
    fn drop(&mut self) {
        let _ = invoke(&self.0, "Close", DISPATCH_METHOD, &mut []);
    }
}

struct MacroGuard<'a>(&'a IDispatch, i32);
impl<'a> MacroGuard<'a> {
    fn enter(app: &'a IDispatch) -> Result<Self> {
        let previous = i32::try_from(&property(app, "AutomationSecurity")?)?;
        invoke(
            app,
            "AutomationSecurity",
            DISPATCH_PROPERTYPUT,
            &mut [3i32.into()],
        )?;
        Ok(Self(app, previous))
    }
}
impl Drop for MacroGuard<'_> {
    fn drop(&mut self) {
        let _ = invoke(
            self.0,
            "AutomationSecurity",
            DISPATCH_PROPERTYPUT,
            &mut [self.1.into()],
        );
    }
}

fn file_arg(path: &Path) -> VARIANT {
    use std::os::windows::ffi::OsStrExt;
    BSTR::from_wide(&path.as_os_str().encode_wide().collect::<Vec<_>>()).into()
}

fn property(object: &IDispatch, name: &str) -> Result<VARIANT> {
    invoke(object, name, DISPATCH_PROPERTYGET, &mut [])
}
fn object(
    parent: &IDispatch,
    name: &str,
    flags: DISPATCH_FLAGS,
    args: &mut [VARIANT],
) -> Result<IDispatch> {
    IDispatch::try_from(&invoke(parent, name, flags, args)?)
        .with_context(|| format!("PowerPoint 未返回 {name}。"))
}
fn invoke(
    object: &IDispatch,
    name: &str,
    flags: DISPATCH_FLAGS,
    args: &mut [VARIANT],
) -> Result<VARIANT> {
    let name_w: Vec<u16> = name.encode_utf16().chain([0]).collect();
    let mut member = 0;
    let iid = GUID::zeroed();
    let mut property_put = DISPID_PROPERTYPUT;
    let mut params = DISPPARAMS {
        rgvarg: args.as_mut_ptr(),
        cArgs: args.len() as u32,
        ..Default::default()
    };
    if flags == DISPATCH_PROPERTYPUT {
        params.rgdispidNamedArgs = &mut property_put;
        params.cNamedArgs = 1;
    }
    let mut result = VARIANT::default();
    unsafe {
        object.GetIDsOfNames(
            &iid,
            &windows::core::PCWSTR(name_w.as_ptr()),
            1,
            0,
            &mut member,
        )?;
        object.Invoke(
            member,
            &iid,
            0,
            flags,
            &params,
            Some(&mut result),
            None,
            None,
        )
    }
    .with_context(|| format!("PowerPoint: {name}"))?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::check_relationships;

    #[test]
    fn external_data_links_are_blocked_but_hyperlinks_are_inert() {
        assert!(check_relationships(br#"<Relationships><Relationship TargetMode="Exte&#114;nal" Type="image"/></Relationships>"#).is_err());
        assert!(check_relationships(br#"<Relationships><Relationship TargetMode="External" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"/></Relationships>"#).is_ok());
        assert!(check_relationships(br#"<Relationships><Relationship Target="../media/image.png" Type="image"/></Relationships>"#).is_ok());
        assert!(check_relationships(br#"<!DOCTYPE Relationships><Relationships/>"#).is_err());
    }
}
