# glass-design-host

给 [glass-design](../控件) 的 Tauri 2 宿主胶水。

液态玻璃要折「窗口背后的桌面」，但 `backdrop-filter` 采不到窗口外的像素 —— 所以必须由宿主把窗口背后那块屏幕截成 PNG data URL，前端铺在 `#wallpaper` 上当材质输入。这个 crate 就是那段宿主代码，应用不必再抄一遍。

接入两步：

1. `.invoke_handler(glass_design_host::handlers!())`，并在 `setup` 里 `glass_design_host::install(app.handle())?`（挂 `WDA_EXCLUDEFROMCAPTURE`，避免截到自己）。
2. 把 `WALLPAPER_JS`（`assets/wallpaper.js`）同步到前端 dist，用普通 `<script src="wallpaper.js">` 引入。仓库里用 `scripts/sync-host-assets.mjs`。

平台：截屏走 Windows GDI（`BitBlt` + `GetDIBits`），只有 Windows 有实现；其它平台 `capture_backdrop` 返回错误，前端自动退回合成背景，编译不受影响。
