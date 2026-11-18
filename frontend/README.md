# vaulta frontend

Static Chinese Windows UI for Tauri's `frontendDist`. There is no JS bundler, npm dependency, or remote runtime asset. An ordinary HTTP server can render the shell but cannot perform vault operations without the Tauri IPC host.

- `host.js` defines the command and event ABI. Filesystem boundaries, authorization, and confirmed disk operations remain in Rust.
- `model.js` computes views on snapshots; `app.js` owns navigation, selection and edit sessions. `workflows.js` handles local view rules and command matching.
- `ui.js` composes the UI. `glass.js` mounts real GlassDesign components using the `glass-web` WebAssembly adapter. Anything replacing a mounted DOM subtree must call `unmount` before removal (or use `redraw`). Ordinary native input controls remain in modal forms; GlassDesign anchored menus and selects portal to the document outside dialogs.
- `vendor/glassdesign` includes matching JS/WASM runtime files, generated CSS/SVG, icon paths and the upstream license. Run `pwsh -NoProfile -File scripts/sync-glassdesign.ps1` from the project root to rebuild from the adjacent GlassDesign checkout. `assets/vaulta.ico` is the supplied icon; the PNG is its extracted 256px image.

## Tests

From the project root on Windows (Node 24+):

```powershell
node frontend/tests/smoke.mjs
pwsh -NoProfile -File scripts/test-native-windows.ps1
```

The Edge test uses a test-only IPC fixture and prints a temporary screenshot directory (`VAULTA_EDGE` can override the browser path). The native test uses a debug Tauri build and isolated data and WebView profiles, exercising the embedded asset protocol and real scan, preview, filing and flag mutation IPC. The separate `frontend/tests/window-chrome-native.mjs` exercises desktop title-bar switching, minimize, maximize/restore, drag dispatch, close and restart persistence. Neither suite drives Windows folder selection or Windows recycle bin UI. Release builds leave DevTools disabled.
