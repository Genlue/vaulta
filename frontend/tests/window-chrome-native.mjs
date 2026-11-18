// Windows integration test. Run against a *debug* custom-protocol build with
// additionalBrowserArgs=--remote-debugging-port=<VAULTA_CHROME_TEST_PORT>
// --remote-debugging-address=127.0.0.1 in its test-only TAURI_CONFIG.
// Example: node frontend/tests/window-chrome-native.mjs target/chrome-native/debug/vaulta.exe
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

assert.equal(process.platform, 'win32');
assert.ok(process.argv[2], 'Pass the path to the isolated debug vaulta.exe');
const exe = resolve(process.argv[2]);
const port = Number(process.env.VAULTA_CHROME_TEST_PORT ?? 39379);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
const temp = await mkdtemp(join(tmpdir(), 'vaulta-window-chrome-'));
const dataPath = join(temp, 'data');
const preference = join(dataPath, 'window-chrome.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ipcState = `__TAURI__.core.invoke('window_chrome_state')`;
const home = 'document.querySelector("#window-chrome")';
const lights = `${home}.querySelector('.c-traffic')`;
const light = name => `(${lights})?.querySelector('.c-traffic__light--${name}')`;
const saved = async () => JSON.parse(await readFile(preference, 'utf8'));

function pages() {
  return fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
}

async function launch() {
  const busy = await pages().then(() => true, () => false);
  assert.equal(busy, false, `CDP port ${port} is busy; refusing to attach`);
  const child = spawn(exe, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, VAULTA_DATA_DIR: dataPath, WEBVIEW2_USER_DATA_FOLDER: join(temp, 'profile') } });
  let ws;
  let stderr = '';
  let spawnError;
  const errors = [];
  const exited = once(child, 'exit');
  exited.catch(() => {});
  child.on('error', err => { spawnError = err; });
  child.stderr.on('data', bytes => { stderr += bytes.toString(); });
  async function stop() {
    ws?.close();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exited;
    }
  }
  try {
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      if (spawnError || child.exitCode !== null) throw spawnError || new Error(`vaulta exited with ${child.exitCode}: ${stderr}`);
      const all = await pages().then(r => r.json()).catch(() => []);
      page = all.find(p => p.type === 'page' && /^(?:https?|tauri):\/\/(?:tauri\.)?localhost(?=[:/]|$)/.test(p.url));
      if (!page) await sleep(120);
    }
    assert.ok(page, `No vaulta WebView on debug port ${port}: ${stderr}`);
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = ({ data }) => {
      const m = JSON.parse(data);
      if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
      if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
      pending.get(m.id)?.(m);
    };
    function cdp(method, params = {}) {
      return new Promise((ok, fail) => {
        const n = ++id;
        const timer = setTimeout(() => { pending.delete(n); fail(new Error(`CDP timeout: ${method}`)); }, 5000);
        pending.set(n, m => {
          pending.delete(n);
          clearTimeout(timer);
          if (m.error) fail(new Error(m.error.message));
          else ok(m.result);
        });
        ws.send(JSON.stringify({ id: n, method, params }));
      });
    }
    async function get(expression) {
      const reply = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description ?? reply.exceptionDetails?.text);
      return reply.result.value;
    }
    async function wait(expression) {
      for (let i = 0; i < 70; i++) {
        if (await get(expression)) return;
        await sleep(100);
      }
      throw new Error(`Timed out: ${expression}. Startup: ${stderr}. Browser: ${errors.join('; ')}`);
    }
    await cdp('Runtime.enable');
    await cdp('Log.enable');
    await wait(`document.documentElement.dataset.gdRuntime === 'ready' && !!${home} && !!document.querySelector('#workspace h1')`);
    const chooseMode = async mode => {
      const fallback = `document.querySelector('select[data-setting="window-chrome"], select[data-setting="titlebar"]')`;
      const widget = `document.querySelector('.c-select button[aria-label="窗口标题栏"]')`;
      await wait(`!!document.querySelector('[data-act="nav"][data-value="settings"]')`);
      await get(`document.querySelector('[data-act="nav"][data-value="settings"]').click()`);
      await wait(`!!(${widget} || ${fallback})`);
      if (await get(`!!${widget}`)) {
        const label = mode === 'native' ? 'Windows 原生' : 'macOS 红绿灯';
        const option = `document.querySelector('.c-menu[role="menu"] [role="menuitemradio"][data-label="${label}"]')`;
        await get(`${widget}.click()`);
        await wait(`!!${option}`);
        await get(`${option}.click()`);
      } else {
        await get(`(() => { const input = ${fallback}; input.value = ${JSON.stringify(mode)}; input.dispatchEvent(new Event('change', {bubbles: true})); })()`);
      }
      await wait(`(async () => (await ${ipcState}).mode === ${JSON.stringify(mode)} && ${home}.hidden === ${mode === 'native'})()`);
    };
    return { cdp, get, wait, chooseMode, exited, errors, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

let running;
try {
  running = await launch();
  let { cdp, get, wait, chooseMode } = running;
  assert.equal((await get(ipcState)).mode, 'native');
  assert.equal(await get(`${home}.hidden`), true);
  await chooseMode('traffic-lights');
  assert.equal(await saved(), 'traffic-lights');
  await wait(`!!${light('zoom')} && ${light('zoom')}.title === '最大化'`);
  assert.equal(await get(`!!${home}.querySelector('[data-gd-widget="traffic-lights"][data-gd-mounted]')`), true);
  const lightsState = await get(`(async () => {
    const state = await ${ipcState};
    const group = ${lights};
    const dot = group.querySelector('.c-traffic__light--close').getBoundingClientRect();
    return { focused: state.focused, attr: group.dataset.focused, dot: [dot.width, dot.height], gap: getComputedStyle(group).gap };
  })()`);
  // The WebView child owns keyboard focus; the host must report the active window,
  // and the mounted control must mirror that state at the library's 12px dot size.
  assert.equal(lightsState.attr, lightsState.focused ? '1' : '0');
  assert.deepEqual(lightsState.dot, [12, 12]);
  assert.equal(lightsState.gap, '8px');
  const start = await get(`(() => {
    window.testTrafficLights = ${lights};
    const lights = ${lights}.getBoundingClientRect();
    const toggle = document.querySelector('.brand-slot .c-capsule')?.getBoundingClientRect();
    const app = document.querySelector('#app').getBoundingClientRect();
    const center = r => (r.top + r.bottom) / 2;
    return { sameRow: !!toggle && Math.abs(center(lights) - center(toggle)) < 1,
      inside: lights.left >= 0 && lights.right <= innerWidth,
      noClipping: app.bottom <= innerHeight + 1, width: innerWidth, height: innerHeight };
  })()`);
  assert.ok(start.sameRow && start.inside && start.noClipping, JSON.stringify(start));
  await get(`${light('zoom')}.click()`);
  await wait(`(async () => (await ${ipcState}).maximized && ${light('zoom')}.title === '还原' && ${lights}.dataset.maximized === '1')()`);
  assert.equal(await get(`window.testTrafficLights === ${lights}`), true);
  assert.ok(await get(`innerWidth !== ${start.width} || innerHeight !== ${start.height}`));
  await get(`${light('zoom')}.click()`);
  await wait(`(async () => !(await ${ipcState}).maximized && ${light('zoom')}.title === '最大化')()`);

  // A single press routes through Tauri's drag path. CDP doesn't move the
  // system cursor, so this tests hit targeting and IPC authorization, not distance.
  const drag = `document.querySelector('.brand[data-tauri-drag-region]')`;
  assert.equal(await get(`(() => {
    const target = ${drag};
    const box = target.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    const event = new MouseEvent('mousedown', {button: 0, detail: 1, bubbles: true, composed: true, cancelable: true});
    return !!hit?.closest('.brand') && !hit.dispatchEvent(event);
  })()`), true);
  await get(`__TAURI__.core.invoke('plugin:window|start_dragging')`);
  await get(`${drag}.dispatchEvent(new MouseEvent('mousedown', {button: 0, detail: 2, bubbles: true, composed: true, cancelable: true}))`);
  await wait(`(async () => (await ${ipcState}).maximized && ${light('zoom')}.title === '还原')()`);
  await get(`${light('zoom')}.click()`);
  await wait(`(async () => !(await ${ipcState}).maximized)()`);
  // IsZoomed flips before the restore animation ends; a minimize issued during
  // that animation is ignored by the shell, so let the window settle first.
  await sleep(450);
  // Capture the integrated settings page, not an isolated component preview.
  const screenshot = await cdp('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(temp, 'traffic-lights.png'), Buffer.from(screenshot.data, 'base64'));
  await get(`${light('min')}.click()`);
  await wait(`(async () => (await ${ipcState}).minimized)()`);
  assert.deepEqual(running.errors, []);
  await running.stop();
  await sleep(300);

  running = await launch();
  ({ get, wait, chooseMode } = running);
  assert.equal((await get(ipcState)).mode, 'traffic-lights');
  await wait(`!${home}.hidden && !!${light('close')}`);
  await chooseMode('native');
  assert.equal(await saved(), 'native');
  await chooseMode('traffic-lights');
  await wait(`!${home}.hidden && !!${light('close')}`);
  assert.deepEqual(running.errors, []);
  // Avoid waiting for a renderer response after requesting close: the WebView
  // may tear down before Runtime.evaluate can respond.
  void get(`${light('close')}.click()`).catch(() => {});
  const closeTimeout = AbortSignal.timeout(9000);
  const [code] = await Promise.race([running.exited, once(closeTimeout, 'abort').then(() => {
    throw new Error('Red window control did not close the test process');
  })]);
  assert.equal(code, 0);
  console.log(`Native window chrome passed (default, settings toggles, maximize, restore, drag IPC, double-click, minimize, restart, close). Artifacts: ${temp}`);
} finally {
  await running?.stop();
}
