# Vaulta frontend

Static Chinese Windows UI for Tauri's `frontendDist`. There is no JS bundler, npm dependency, or remote runtime asset. An ordinary HTTP server can render the shell but cannot perform vault operations without the Tauri IPC host.

- `host.js` defines the command and event ABI. Filesystem boundaries, authorization, and confirmed disk operations remain in Rust.
- `model.js` computes views on snapshots; `app.js` owns navigation, selection and edit sessions. `workflows.js` handles local view rules and command matching.
- Grid thumbnails flow through the `thumbnail` IPC command: `app.js` observes only the cards near the viewport, keeps at most four requests in flight, and caches the returned data URL by asset revision. The Rust side (`src-tauri/src/thumbnails.rs`) bounds the input size and decoded pixels, applies EXIF orientation, fits the image into 720px and keeps a small LRU cache in memory. Unsupported or unreadable images keep their type glyph.
- `ui.js` composes the UI. `glass.js` mounts real GlassDesign components using the `glass-web` WebAssembly adapter. Anything replacing a mounted DOM subtree must call `unmount` before removal (or use `redraw`). Ordinary native input controls remain in modal forms; GlassDesign anchored menus and selects portal to the document outside dialogs. Host action clusters (settings rows, dialog footers, toolbars) use the GlassDesign spacing scale: peers are a flex/grid cluster with `--s-4` (8px) between controls, wrapping instead of sitting flush when the column is narrow.
- `#pop` is the one menu surface for Vaulta's own data. It paints with GlassDesign's `.c-menu` material and `.c-menu__*` rows, opens from an anchor or from a pointer coordinate, and moves inside an open `<dialog>` so a right-click menu stays in the dialog's top layer. The browser context menu is suppressed document-wide; `contextmenu` resolves to asset, text-editing, selection or application items.
- `glass-effects.js` is a classic head script: it restores `glass-design:effects` onto `<html data-gd-effects>` before the first style pass, so a low-end machine never paints a frame of full glass first. The same file exposes `vaultaEffects` for the settings row; `auto` is the absence of the attribute.
- `vendor/glassdesign` includes matching JS/WASM runtime files, generated CSS/SVG, generated icon paths and the upstream license, all built from one pinned GlassDesign tag. `UPSTREAM.json` records the tag, commit and hash of each file; `PROVENANCE.md` explains the build. Run `pwsh -NoProfile -File scripts/sync-glassdesign.ps1` from the project root to fetch that tag, rebuild the web adapter and refresh the directory (pass `-GlassDesignPath` only for a local checkout under development). `assets/vaulta.ico` is the supplied icon; the PNG is its extracted 256px image.

## Tests

From the project root on Windows (Node 24+):

```powershell
node frontend/tests/smoke.mjs
pwsh -NoProfile -File scripts/test-native-windows.ps1
```

The Edge test uses a test-only IPC fixture and prints a temporary screenshot directory (`VAULTA_EDGE` can override the browser path). The native test uses a debug Tauri build and isolated data and WebView profiles, exercising the embedded asset protocol and real scan, preview, filing and flag mutation IPC. The separate `frontend/tests/window-chrome-native.mjs` exercises desktop title-bar switching, minimize, maximize/restore, drag dispatch, close and restart persistence. Neither suite drives Windows folder selection or Windows recycle bin UI. Release builds leave DevTools disabled.

### Document previews

The desktop host draws PDFs using Windows PDF APIs, renders `.pptx` / `.ppsx` into per-slide bitmaps with desktop PowerPoint, and mounts the registered out-of-process preview handler for other Office formats over the inspector's reserved surface. PowerPoint opens a temporary copy read-only, with macros disabled during the open call and any original download mark preserved on the copy. The UI hides the native surface under menus/dialogs and discards results for old selections. An Office source with a Windows download mark is blocked by default. The confirmation applies to one native render request for the same file revision; the provider receives a read-only stream or a disposable byte snapshot, not the original file. The original file and its mark are not changed. Search still uses bounded text extraction, independently of rendering.

The native smoke test includes a two-page image-only PDF and validates colors from the actual page bitmaps. To also exercise the Office providers, set `VAULTA_PREVIEW_FIXTURES` to a local folder containing `word.docx` and `grid.xlsx` and run `scripts/test-native-windows.ps1` on a machine with compatible handlers. This also tests a bundled two-slide PowerPoint fixture by checking image pixels (dark blue and orange), including page changes and a real `Zone.Identifier` stream. Both the Word and PowerPoint download-mark tests verify that the original files and marks stay unchanged.
