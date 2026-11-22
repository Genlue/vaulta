//! Small raster thumbnails for the grid view.
//!
//! The grid used to draw a file-type glyph for every card, which makes photos
//! indistinguishable. This module decodes the original image once, bounds the
//! pixels it is willing to allocate, and returns a compact data URL that the
//! frontend can cache per asset revision. It is deliberately separate from the
//! inspector preview: a thumbnail may be 720px and is never the full file.

use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use image::{
    DynamicImage, ImageDecoder, ImageFormat, ImageReader, Limits,
    codecs::{jpeg::JpegEncoder, png::PngEncoder},
    metadata::Orientation,
};
use std::{
    collections::{HashMap, VecDeque},
    fs::File,
    io::Read,
    path::Path,
    sync::Mutex,
};

const MAX_INPUT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_DIMENSION: u32 = 12_000;
const MAX_ALLOC: u64 = 192 * 1024 * 1024;
const MAX_EDGE: u32 = 720;
const JPEG_QUALITY: u8 = 82;
const CACHE_BYTES: usize = 24 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 4 * 1024 * 1024;
const EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "svg"];

/// Process-wide thumbnail cache, owned by the desktop state.
#[derive(Clone, Default)]
pub struct Thumbs(std::sync::Arc<Mutex<Lru>>);

impl Thumbs {
    pub fn new() -> Self {
        Self::default()
    }

    fn get(&self, key: &str) -> Option<String> {
        self.0.lock().ok()?.get(key)
    }

    fn put(&self, key: String, value: String) {
        if let Ok(mut cache) = self.0.lock() {
            cache.put(key, value);
        }
    }
}

#[derive(Default)]
struct Lru {
    map: HashMap<String, String>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Lru {
    fn get(&mut self, key: &str) -> Option<String> {
        let value = self.map.get(key)?.clone();
        self.order.retain(|item| item != key);
        self.order.push_back(key.to_string());
        Some(value)
    }

    fn put(&mut self, key: String, value: String) {
        if let Some(previous) = self.map.insert(key.clone(), value.clone()) {
            self.bytes = self.bytes.saturating_sub(previous.len());
            self.order.retain(|item| item != &key);
        }
        self.bytes += value.len();
        self.order.push_back(key);
        while self.bytes > CACHE_BYTES {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(removed) = self.map.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(removed.len());
            }
        }
    }
}

/// Return a data URL for the image at `path`, or a cached one for `key`.
///
/// `relative` is only used for the extension check and error text; the caller
/// has already resolved and identity-checked the absolute path.
pub fn load(thumbs: &Thumbs, key: &str, path: &Path, relative: &str) -> Result<String> {
    if let Some(hit) = thumbs.get(key) {
        return Ok(hit);
    }
    let url = render(path, relative)?;
    thumbs.put(key.to_string(), url.clone());
    Ok(url)
}

fn render(path: &Path, relative: &str) -> Result<String> {
    let extension = Path::new(relative)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    ensure!(
        EXTENSIONS.contains(&extension.as_str()),
        "这个文件类型没有缩略图。"
    );
    let size = std::fs::metadata(path)
        .with_context(|| format!("无法读取文件信息：{relative}"))?
        .len();
    if size == 0 {
        bail!("文件为空，无法生成缩略图。");
    }
    ensure!(
        size <= MAX_INPUT_BYTES,
        "图片超过 64 MiB，未生成缩略图。"
    );

    // SVG is already resolution independent: hand it to the webview as-is
    // instead of trying to rasterize it here. Scripts and external references
    // do not run inside an <img>.
    if extension == "svg" {
        let mut data = Vec::new();
        File::open(path)
            .with_context(|| format!("无法打开图片：{relative}"))?
            .take(MAX_SVG_BYTES + 1)
            .read_to_end(&mut data)
            .with_context(|| format!("无法读取图片：{relative}"))?;
        ensure!(data.len() as u64 <= MAX_SVG_BYTES, "SVG 超过 4 MiB，未生成缩略图。");
        ensure!(
            String::from_utf8_lossy(&data[..data.len().min(2048)]).contains("<svg"),
            "文件内容不是 SVG。"
        );
        let prefix = "data:image/svg+xml;base64,";
        let mut url = String::with_capacity(prefix.len() + data.len().div_ceil(3) * 4);
        url.push_str(prefix);
        STANDARD.encode_string(&data, &mut url);
        return Ok(url);
    }

    let mut reader = ImageReader::open(path)
        .with_context(|| format!("无法打开图片：{relative}"))?
        .with_guessed_format()
        .with_context(|| format!("无法识别图片格式：{relative}"))?;
    let format = reader.format().context("无法识别图片格式。")?;
    ensure!(
        matches!(
            format,
            ImageFormat::Png
                | ImageFormat::Jpeg
                | ImageFormat::Gif
                | ImageFormat::WebP
                | ImageFormat::Bmp
                | ImageFormat::Tiff
                | ImageFormat::Ico
        ),
        "这个文件类型没有缩略图。"
    );
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(MAX_ALLOC);
    reader.limits(limits);

    let mut decoder = reader
        .into_decoder()
        .with_context(|| format!("无法解码图片：{relative}"))?;
    // Phone photos rely on EXIF orientation; the grid should not show them sideways.
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut image = DynamicImage::from_decoder(decoder)
        .with_context(|| format!("无法解码图片：{relative}"))?;
    image.apply_orientation(orientation);
    ensure!(
        image.width() > 0 && image.height() > 0,
        "图片没有可显示的像素。"
    );
    let image = image.thumbnail(MAX_EDGE, MAX_EDGE);

    let mut out = Vec::new();
    let png = image.color().has_alpha()
        && image
            .to_rgba8()
            .pixels()
            .any(|pixel| pixel.0[3] != u8::MAX);
    if png {
        image
            .write_with_encoder(PngEncoder::new(&mut out))
            .context("无法编码缩略图。")?;
        let prefix = "data:image/png;base64,";
        let mut url = String::with_capacity(prefix.len() + out.len().div_ceil(3) * 4);
        url.push_str(prefix);
        STANDARD.encode_string(&out, &mut url);
        Ok(url)
    } else {
        image
            .write_with_encoder(JpegEncoder::new_with_quality(&mut out, JPEG_QUALITY))
            .context("无法编码缩略图。")?;
        let prefix = "data:image/jpeg;base64,";
        let mut url = String::with_capacity(prefix.len() + out.len().div_ceil(3) * 4);
        url.push_str(prefix);
        STANDARD.encode_string(&out, &mut url);
        Ok(url)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn temp_png(width: u32, height: u32) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sample.png");
        let mut image = RgbImage::new(width, height);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            *pixel = Rgb([(x % 256) as u8, (y % 256) as u8, 128]);
        }
        image.save(&path).unwrap();
        (dir, path)
    }

    #[test]
    fn renders_a_bounded_jpeg() {
        let (_dir, path) = temp_png(1600, 1200);
        let url = render(&path, "sample.png").unwrap();
        assert!(url.starts_with("data:image/jpeg;base64,"));
        let bytes = STANDARD
            .decode(url.trim_start_matches("data:image/jpeg;base64,"))
            .unwrap();
        let decoded = image::load_from_memory(&bytes).unwrap();
        assert!(decoded.width() <= MAX_EDGE && decoded.height() <= MAX_EDGE);
        assert_eq!((decoded.width(), decoded.height()), (720, 540));
    }

    #[test]
    fn passes_svg_to_the_webview() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mark.svg");
        std::fs::write(
            &path,
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>"#,
        )
        .unwrap();
        let url = render(&path, "mark.svg").unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        let bytes = STANDARD
            .decode(url.trim_start_matches("data:image/svg+xml;base64,"))
            .unwrap();
        assert!(bytes.windows(4).any(|w| w == b"<svg"));
    }

    #[test]
    fn rejects_unknown_extensions_and_small_cache_evicts() {
        let (_dir, path) = temp_png(32, 24);
        assert!(render(&path, "notes.txt").is_err());
        let mut lru = Lru::default();
        lru.put("a".into(), "x".repeat(CACHE_BYTES / 2));
        lru.put("b".into(), "y".repeat(CACHE_BYTES / 2));
        lru.put("c".into(), "z".repeat(CACHE_BYTES / 2));
        assert!(lru.map.len() < 3);
        assert!(lru.bytes <= CACHE_BYTES);
    }
}
