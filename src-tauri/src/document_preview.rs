use crate::{Desktop, Reply, blocking, checked_asset, inspect};
use anyhow::{Context, Result, ensure};
use tauri::{State, WebviewWindow};
use vaulta_fs::{PreviewKind, RenderSource};

pub(crate) mod office;
mod pdf;
mod slides;
pub use office::OfficeHost;
pub use pdf::PdfCache;
pub use slides::SlidesHost;

async fn source(
    state: &Desktop,
    vault_id: String,
    asset_id: String,
    kind: PreviewKind,
) -> Reply<RenderSource> {
    let (root, asset) =
        inspect(state, move |core| checked_asset(core, &vault_id, &asset_id)).await?;
    blocking(move || {
        Ok(vaulta_fs::open_render_source(
            &root,
            &asset.path,
            asset.identity.as_deref().context("无法核对文件身份。")?,
            kind,
        )?)
    })
    .await
}

fn main_window(window: &WebviewWindow) -> Result<()> {
    ensure!(window.label() == "main", "仅可在主窗口预览文档。");
    Ok(())
}

#[tauri::command]
pub async fn pdf_preview_page(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    cache: State<'_, PdfCache>,
    vault_id: String,
    asset_id: String,
    page: u32,
) -> Reply<pdf::Page> {
    main_window(&window).map_err(|e| e.to_string())?;
    let cache = cache.inner().clone();
    let key = (vault_id.clone(), asset_id.clone());
    let source = source(&state, vault_id, asset_id, PreviewKind::Pdf).await?;
    blocking(move || cache.render(key, source, page)).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SlideRequest {
    page: u32,
    session: u64,
    confirmed_session: Option<u64>,
}

#[tauri::command]
pub async fn slides_preview_page(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    slides: State<'_, SlidesHost>,
    vault_id: String,
    asset_id: String,
    request: SlideRequest,
) -> Reply<slides::PageResult> {
    main_window(&window).map_err(|e| e.to_string())?;
    let slides = slides.inner().clone();
    let source = source(&state, vault_id, asset_id, PreviewKind::Slides).await?;
    blocking(move || {
        slides.page(
            source,
            request.page,
            request.session,
            request.confirmed_session,
        )
    })
    .await
}

#[tauri::command]
pub async fn office_preview_open(
    window: WebviewWindow,
    state: State<'_, Desktop>,
    office: State<'_, OfficeHost>,
    vault_id: String,
    asset_id: String,
    session: u64,
    confirmed_session: Option<u64>,
) -> Reply<office::OpenResult> {
    main_window(&window).map_err(|e| e.to_string())?;
    let host = office.worker(&window).map_err(|e| e.to_string())?;
    let source = source(&state, vault_id, asset_id, PreviewKind::Office).await?;
    blocking(move || host.open(session, source, confirmed_session)).await
}
