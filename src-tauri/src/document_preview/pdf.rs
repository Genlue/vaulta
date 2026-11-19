use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    sync::{Arc, Mutex},
    time::SystemTime,
};
use vaulta_fs::RenderSource;
use windows::{
    Data::Pdf::{PdfDocument, PdfPageRenderOptions},
    Graphics::Imaging::BitmapEncoder,
    Storage::Streams::{DataReader, IRandomAccessStream, InMemoryRandomAccessStream},
    Win32::{
        System::WinRT::{
            BSOS_DEFAULT, CreateRandomAccessStreamOverStream, RO_INIT_MULTITHREADED, RoInitialize,
            RoUninitialize,
        },
        UI::Shell::SHCreateMemStream,
    },
};

struct Runtime;
impl Runtime {
    fn enter() -> Result<Self> {
        unsafe {
            RoInitialize(RO_INIT_MULTITHREADED)?;
        }
        Ok(Self)
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

struct CachedPdf {
    key: (String, String),
    revision: (String, u64, SystemTime),
    document: PdfDocument,
}

#[derive(Clone, Default)]
pub struct PdfCache(Arc<Mutex<Option<CachedPdf>>>);

#[derive(Serialize)]
pub struct Page {
    count: u32,
    data_url: String,
}

impl PdfCache {
    pub fn render(&self, key: (String, String), source: RenderSource, index: u32) -> Result<Page> {
        let _rt = Runtime::enter()?;
        let mut cache = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("PDF 渲染器不可用。"))?;
        let revision = source.revision()?;
        if !cache
            .as_ref()
            .is_some_and(|c| c.key == key && c.revision == revision)
        {
            *cache = Some(CachedPdf {
                key,
                revision,
                document: load(source.into_bytes()?)?,
            });
        } else {
            drop(source);
        }
        let document = &cache.as_ref().unwrap().document;
        let count = document.PageCount()?;
        ensure!(count > 0, "此 PDF 不包含页面。");
        ensure!(index < count, "此 PDF 中不存在这一页。");
        render_page(document, index)
            .map(|data_url| Page { count, data_url })
            .context("无法绘制此 PDF 页面。")
    }
}

fn load(bytes: Vec<u8>) -> Result<PdfDocument> {
    let header = &bytes[..bytes.len().min(1024)];
    ensure!(
        header.windows(5).any(|s| s == b"%PDF-"),
        "文件不是有效的 PDF。"
    );
    let stream = unsafe { SHCreateMemStream(Some(&bytes)) }.context("无法分配 PDF 读取缓冲区。")?;
    let stream: IRandomAccessStream =
        unsafe { CreateRandomAccessStreamOverStream(&stream, BSOS_DEFAULT)? };
    let document = PdfDocument::LoadFromStreamAsync(&stream)?
        .join()
        .context("无法加载 PDF；文件可能已损坏或受密码保护。")?;
    if document.IsPasswordProtected()? {
        bail!("此 PDF 受密码保护，请用系统应用打开。");
    }
    Ok(document)
}

fn render_page(document: &PdfDocument, index: u32) -> Result<String> {
    let page = document.GetPage(index)?;
    let size = page.Size()?;
    ensure!(
        size.Width.is_finite() && size.Height.is_finite() && size.Width > 0. && size.Height > 0.,
        "无效的页面尺寸。"
    );
    // Bound the pixel count even for extreme page aspect ratios.
    let scale = 1800. / size.Width.max(size.Height);
    let options = PdfPageRenderOptions::new()?;
    options.SetDestinationWidth((size.Width * scale).round().max(1.) as u32)?;
    options.SetDestinationHeight((size.Height * scale).round().max(1.) as u32)?;
    options.SetBitmapEncoderId(BitmapEncoder::PngEncoderId()?)?;
    let output = InMemoryRandomAccessStream::new()?;
    page.RenderWithOptionsToStreamAsync(&output, &options)?
        .join()?;
    let len = output.Size()?;
    ensure!(
        (8..=14 * 1024 * 1024).contains(&len),
        "PDF 页面超出预览限制。"
    );
    let reader = DataReader::CreateDataReader(&output.GetInputStreamAt(0)?)?;
    ensure!(
        reader.LoadAsync(len as u32)?.join()? == len as u32,
        "PDF 页面读取不完整。"
    );
    let mut png = vec![0; len as usize];
    reader.ReadBytes(&mut png)?;
    ensure!(
        png.starts_with(b"\x89PNG\r\n\x1a\n"),
        "没有生成可用的页面图像。"
    );
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}
