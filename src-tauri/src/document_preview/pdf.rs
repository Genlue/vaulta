use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
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

type Revision = (String, u64, SystemTime);

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

struct AliveGuard(Arc<AtomicBool>);
impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

struct PdfRequest {
    key: (String, String),
    source: RenderSource,
    index: u32,
    reply: mpsc::SyncSender<Result<Page>>,
}

struct Worker {
    send: mpsc::Sender<PdfRequest>,
    alive: Arc<AtomicBool>,
}

#[derive(Clone, Default)]
pub struct PdfCache(Arc<Mutex<Option<Worker>>>);

#[derive(Serialize)]
pub struct Page {
    count: u32,
    data_url: String,
}

impl PdfCache {
    fn worker(&self) -> Result<mpsc::Sender<PdfRequest>> {
        let mut slot = self
            .0
            .lock()
            .map_err(|_| anyhow::anyhow!("PDF 渲染器不可用。"))?;
        if let Some(worker) = slot.as_ref() {
            if worker.alive.load(Ordering::Acquire) {
                return Ok(worker.send.clone());
            }
        }
        let (send, recv) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        let thread_alive = alive.clone();
        thread::Builder::new()
            .name("vaulta-pdf-preview".into())
            .spawn(move || {
                let _guard = AliveGuard(thread_alive);
                run(recv);
            })?;
        *slot = Some(Worker {
            send: send.clone(),
            alive,
        });
        Ok(send)
    }

    pub fn render(&self, key: (String, String), source: RenderSource, index: u32) -> Result<Page> {
        let send = self.worker()?;
        let (reply, result) = mpsc::sync_channel(1);
        send.send(PdfRequest {
            key,
            source,
            index,
            reply,
        })
        .map_err(|_| anyhow::anyhow!("PDF 渲染器不可用。"))?;
        result.recv().context("PDF 渲染器未返回结果。")?
    }
}

struct CachedPdf {
    key: (String, String),
    revision: Revision,
    document: PdfDocument,
    count: u32,
}

const MAX_CACHED_PAGES: usize = 24;
const MAX_CACHE_BYTES: usize = 24 * 1024 * 1024;

fn run(recv: mpsc::Receiver<PdfRequest>) {
    let _rt = match Runtime::enter() {
        Ok(rt) => rt,
        Err(error) => {
            eprintln!("vaulta: pdf runtime init failed: {error:#}");
            return;
        }
    };
    let mut cached_doc: Option<CachedPdf> = None;
    let mut page_cache: VecDeque<(Revision, u32, u32, String)> = VecDeque::new();
    let mut cache_bytes = 0usize;

    while let Ok(req) = recv.recv() {
        let result = (|| -> Result<Page> {
            let revision = req.source.revision()?;
            if let Some(pos) = page_cache
                .iter()
                .position(|(rev, idx, _, _)| *rev == revision && *idx == req.index)
            {
                drop(req.source);
                let entry = page_cache.remove(pos).unwrap();
                let page = Page {
                    count: entry.2,
                    data_url: entry.3.clone(),
                };
                page_cache.push_back(entry);
                return Ok(page);
            }
            if !cached_doc
                .as_ref()
                .is_some_and(|c| c.key == req.key && c.revision == revision)
            {
                let document = load(req.source.into_bytes()?)?;
                let count = document.PageCount()?;
                cached_doc = Some(CachedPdf {
                    key: req.key,
                    revision: revision.clone(),
                    document,
                    count,
                });
            } else {
                drop(req.source);
            }
            let doc = cached_doc.as_ref().unwrap();
            ensure!(doc.count > 0, "此 PDF 不包含页面。");
            ensure!(req.index < doc.count, "此 PDF 中不存在这一页。");
            let data_url =
                render_page(&doc.document, req.index).context("无法绘制此 PDF 页面。")?;
            if data_url.len() <= MAX_CACHE_BYTES / 2 {
                cache_bytes += data_url.len();
                page_cache.push_back((revision, req.index, doc.count, data_url.clone()));
                while page_cache.len() > MAX_CACHED_PAGES || cache_bytes > MAX_CACHE_BYTES {
                    if let Some(old) = page_cache.pop_front() {
                        cache_bytes = cache_bytes.saturating_sub(old.3.len());
                    }
                }
            }
            Ok(Page {
                count: doc.count,
                data_url,
            })
        })();
        let _ = req.reply.send(result);
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
    const PREFIX: &str = "data:image/png;base64,";
    let mut url = String::with_capacity(PREFIX.len() + png.len().div_ceil(3) * 4);
    url.push_str(PREFIX);
    STANDARD.encode_string(&png, &mut url);
    Ok(url)
}
