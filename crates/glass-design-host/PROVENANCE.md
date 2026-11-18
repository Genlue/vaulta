# glass-design-host (vendored)

`crates/glass-design-host` is a source copy of GlassDesign's Tauri host glue,
kept inside this repository so a fresh clone builds offline without the sibling
checkout.

- Upstream: `GlassDesign/host` — crate `glass-design-host` 0.8.3
- Source base: `a021546ef84a724970bb7b66fb45a1b315b9e20b`, plus the wallpaper
  attribute fix (`data-has-image` alongside `data-source="host"`).
- Files: `Cargo.toml`, `src/lib.rs`, `assets/wallpaper.js`, `README.md`
- Refresh with `pwsh -NoProfile -File scripts/sync-glassdesign.ps1`, which also
  copies `assets/wallpaper.js` to `frontend/wallpaper.js` and rebuilds the
  vendored `glass.css` from the same checkout.
- The copy is rustfmt-formatted (mechanical line breaks only, no logic change);
  `crates/glass-design-host` is excluded from the workspace so vendored code
  keeps upstream lint state.
- License: see `frontend/vendor/glassdesign/LICENSE`.

Do not edit the copy in place; change GlassDesign and re-sync, otherwise the
next sync silently drops the local edit.
