/* --------------------------------------------------------------------------
   由 glass-design-host 提供（host/assets/wallpaper.js），应用不需要自己写这段。
   落地位置：应用/ui/dist/wallpaper.js，用普通 <script src="wallpaper.js"> 引入，
   **不是 ESM** —— 它必须在页面解析到这里时就跑，不等任何模块加载。

   背景层取值。这一层是**输入**，不是装饰：
     · 跑在 Tauri 里（window.__TAURI__ 存在）→ 让宿主实时截「窗口背后的屏幕」，
       截到的 PNG 写进 --wallpaper-image，data-source 切到 host；
       窗口移动 / 缩放 / 桌面变化（慢轮询）都要重截。
     · 跑在浏览器里 → 保持 data-source="demo" 的合成桌面，
       玻璃折的是它，观感与宿主一致，只是像素来源不同。
   页面本身一行都不改：玻璃始终折 #wallpaper。
   -------------------------------------------------------------------------- */
const wp = document.getElementById('wallpaper');
const tauri = window.__TAURI__;

// 一次截屏是不是「有效画面」。WDA_EXCLUDEFROMCAPTURE 在部分显卡/驱动上
// 会返回一张纯黑（而不是它背后的桌面）—— 那比用合成背景更难看，
// 所以缩到 8×8 取平均亮度，黑到看不见就丢弃这一帧。
const looksUsable = (url) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 8;
        c.height = 8;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        resolve(sum / (64 * 3) > 2);
      } catch {
        resolve(true);
      }
    };
    img.onerror = () => resolve(false);
    img.src = url;
  });

if (tauri && tauri.core && typeof tauri.core.invoke === 'function') {
  // 宿主里 UI 就是窗口本身：去掉那圈给浏览器预览用的 10px 缝。
  // 写在 <html> 上而不是 .l-app 上 —— 属性立刻生效，Leptos 后挂载的
  // 节点一样命中，不用等 DOM 就绪。
  document.documentElement.dataset.shell = 'host';

  let timer = 0;
  let busy = false;
  let dirty = false;
  let warned = false;
  let attempts = 0;

  // 首帧常常在窗口还没完成合成时到达，会是一张纯黑图。等 8 秒轮询太久了，
  // 这里用短退避补几次；成功一次后计数归零，之后交给 move/resize 与轮询。
  const retrySoon = () => {
    if (attempts >= 5) return;
    attempts += 1;
    clearTimeout(timer);
    timer = setTimeout(refresh, 250 * attempts);
  };

  const refresh = async () => {
    if (busy) { dirty = true; return; }
    busy = true;
    try {
      const url = await tauri.core.invoke('capture_backdrop');
      if (typeof url === 'string' && url.startsWith('data:image/') && (await looksUsable(url))) {
        wp.style.setProperty('--wallpaper-image', `url("${url}")`);
        wp.dataset.source = 'host';
        // glass.css 早期只认 data-has-image；两个都写，新旧样式表都能生效。
        wp.dataset.hasImage = '1';
        attempts = 0;
      } else if (!warned) {
        warned = true;
        console.warn('[backdrop] 截屏内容为空（可能被系统屏蔽），继续用合成背景');
        retrySoon();
      } else {
        retrySoon();
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        // 截屏失败不该把界面搞崩：留在 demo 背景上，只报一次
        console.warn('[backdrop] 截屏失败，退回合成背景：', err);
      }
      retrySoon();
    } finally {
      busy = false;
      if (dirty) { dirty = false; refresh(); }
    }
  };

  // 窗口拖动时会连发几十个 move：收一收，等停下 180ms 再截
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 180);
  };

  refresh();
  try {
    tauri.event.listen('tauri://move', schedule);
    tauri.event.listen('tauri://resize', schedule);
  } catch (err) {
    console.warn('[backdrop] 事件订阅失败：', err);
  }
  // 桌面内容会变（切换窗口、换壁纸），慢轮询兜底；失焦时不截
  setInterval(() => { if (document.hasFocus()) refresh(); }, 8000);
  // 手动重截（调试用）
  window.gdRefreshBackdrop = refresh;
}
