import { mount, updateWidget, widget } from './glass.js';

const NATIVE = 'native';
const LIGHTS = 'traffic-lights';
const actions = { close: 'close', min: 'minimize', zoom: 'toggle-maximize' };
const core = () => globalThis.__TAURI__?.core;
const invoke = (name, args) => core().invoke(name, args);
let state = { mode: NATIVE, focused: true, maximized: false, minimized: false };
let root;
let installation;
let changing = false;
let refreshQueued = false;
let resizeTimer = 0;
let generation = 0;

export const getWindowChromeMode = () => state.mode;
export const canUseWindowChrome = () => typeof core()?.invoke === 'function'
  && globalThis.__TAURI_INTERNALS__?.metadata?.currentWindow?.label === 'main';

// Reserve the mode's controls on the persistent host once. These small, fully
// functional fallback buttons are only used when the optional WASM mount fails.
function populate() {
  const fallback = `<div class="window-chrome__fallback" role="group" aria-label="窗口控制">
    <button type="button" data-chrome-action="close" title="关闭" aria-label="关闭窗口">×</button>
    <button type="button" data-chrome-action="minimize" title="最小化" aria-label="最小化窗口">−</button>
    <button type="button" data-chrome-action="toggle-maximize" title="最大化" aria-label="最大化窗口">□</button>
  </div>`;
  root.innerHTML = `${widget(LIGHTS, { focused: state.focused, maximized: state.maximized }, {
    tag: 'div', className: 'window-chrome__lights', attrs: 'data-tauri-drag-region="false"', fallback,
  })}<div class="window-chrome__drag" data-tauri-drag-region><span>Vaulta</span></div>`;
  mount(root);
  root.querySelector('.c-traffic')?.setAttribute('aria-label', '窗口控制');
  root.querySelector('.c-traffic')?.setAttribute('role', 'group');
  for (const [light, action] of Object.entries(actions)) {
    const button = root.querySelector(`.c-traffic__light--${light}`);
    if (button) button.dataset.chromeAction = action;
  }
}

function apply(next) {
  const unchanged = root.dataset.maximized !== undefined
    && next.mode === state.mode && next.maximized === state.maximized && next.focused === state.focused;
  state = next;
  if (unchanged) return;
  if (next.mode === LIGHTS && !root.querySelector('[data-gd-widget]')) populate();
  root.hidden = next.mode !== LIGHTS;
  root.dataset.maximized = String(next.maximized);
  root.dataset.focused = String(next.focused);
  const slot = root.querySelector('.window-chrome__lights[data-gd-mounted]');
  if (slot && updateWidget(slot, { focused: next.focused, maximized: next.maximized })) {
    return;
  }
  // Fallback until the web adapter is available.
  const lights = slot?.querySelector('.c-traffic');
  if (lights) lights.dataset.focused = next.focused ? '1' : '0';
  const zoom = root.querySelector('[data-chrome-action="toggle-maximize"]');
  if (zoom) {
    zoom.title = next.maximized ? '还原' : '最大化';
    zoom.setAttribute('aria-label', `${zoom.title}窗口`);
    if (!lights) zoom.textContent = next.maximized ? '❐' : '□';
  }
}

async function readWindow() {
  const at = ++generation;
  const next = await invoke('window_chrome_state');
  if (generation === at && !changing) apply(next);
}

function refresh() {
  if (state.mode !== LIGHTS || refreshQueued || changing) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if (!changing) void readWindow().catch(reportError);
  });
}

function refreshOnResize() {
  if (state.mode !== LIGHTS || changing) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(refresh, 80);
}

function reportError(error) {
  console.error('Vaulta window chrome:', error);
  if (!root?.querySelector('.window-chrome__feedback')) {
    const status = document.createElement('span');
    status.className = 'window-chrome__feedback sr-only';
    status.setAttribute('role', 'status');
    root?.append(status);
  }
  const status = root?.querySelector('.window-chrome__feedback');
  if (status) status.textContent = '无法操作窗口，请重试。';
}

export function installWindowChrome() {
  if (installation) return installation;
  root = document.getElementById('window-chrome');
  if (!root || !canUseWindowChrome()) return Promise.resolve();
  installation = (async () => {
    root.addEventListener('click', async event => {
      const button = event.target.closest('[data-chrome-action]');
      if (!button || changing) return;
      try {
        await invoke('window_chrome_action', { action: button.dataset.chromeAction });
        if (button.dataset.chromeAction !== 'close') refresh();
      } catch (error) { reportError(error); }
    });
    // Attach before the first read so a focus change during startup is not lost.
    // DOM resize handles live resizing; native focus/resize also notify when
    // WebView rendering is suspended or asynchronously resized at the OS level.
    window.addEventListener('resize', refreshOnResize);
    window.addEventListener('focus', refresh);
    window.addEventListener('blur', refresh);
    document.addEventListener('visibilitychange', refresh);
    const events = globalThis.__TAURI__?.event;
    const owner = { kind: 'WebviewWindow', label: 'main' };
    if (events?.listen) {
      void events.listen('tauri://resize', refreshOnResize, { target: owner }).catch(reportError);
      for (const event of ['tauri://focus', 'tauri://blur']) {
        void events.listen(event, refresh, { target: owner }).catch(reportError);
      }
    }
    await readWindow();
  })().catch(error => {
    // The rest of the desktop app still works with the default native chrome.
    installation = undefined;
    reportError(error);
  });
  return installation;
}

export async function setWindowChromeMode(selected) {
  if (selected !== NATIVE && selected !== LIGHTS) throw new Error('未知的标题栏样式。');
  await installWindowChrome();
  if (!root || !canUseWindowChrome()) throw new Error('请在 Vaulta 桌面应用中更改窗口标题栏。');
  if (changing) throw new Error('正在切换标题栏，请稍后重试。');
  changing = true;
  ++generation;
  try {
    apply(await invoke('set_window_chrome_mode', { selected }));
    return state.mode;
  } finally {
    changing = false;
    refresh();
  }
}
