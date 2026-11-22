# GlassDesign embedded web assets

glass_web.js, glass_web_bg.wasm, glass.css, and glass-defs.svg are built from
GlassDesign `v0.10.1` (commit `e8acea592e17fccef38fbcf56dcdfc968eeb5e88`) by `scripts/sync-glassdesign.ps1`. That script
fetches the pinned tag from <https://github.com/Genlue/GlassDesign>, runs its `scripts/build-web.ps1` and copies the
four files here, so the JS and WASM always come from one build. `icons.js` is generated
from the same commit's `控件/src/base/icon.rs`. See `LICENSE` for GlassDesign's license.

Synced: 2026-11-22