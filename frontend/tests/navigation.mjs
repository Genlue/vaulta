// Run with Node 22+ and Microsoft Edge: node frontend/tests/navigation.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await mkdtemp(join(tmpdir(), 'vaulta-nav-'));
const browser = process.env.VAULTA_EDGE || join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  try {
    if (!file.startsWith(resolve(root) + sep) || !mime[extname(file)]) throw new Error('Not a frontend resource');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': mime[extname(file)] }).end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const edge = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, origin], { stdio: 'ignore', windowsHide: true });
let spawnError, ws;
const exited = new Promise(r => { edge.once('exit', r); edge.once('error', e => { spawnError = e; r(); }); });
const pending = new Map();
let id = 0;
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const seq = ++id;
    const timer = setTimeout(() => { pending.delete(seq); reject(new Error(`Timed out: ${method}`)); }, 8000);
    pending.set(seq, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: seq, method, params }));
  });
}
async function get(expression) {
  const reply = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result.value;
}
async function retry(probe, message) {
  for (let i = 0; i < 100; i++) {
    const result = await probe();
    if (result) return result;
    await pause(50);
  }
  throw new Error(message);
}
const viewport = width => cdp('Emulation.setDeviceMetricsOverride', { width, height: 700, deviceScaleFactor: 1, mobile: false });
const toggle = `document.querySelector('#rail-toggle [data-act=toggle-rail]')`;
const state = `(() => {
  const box = s => document.querySelector(s).getBoundingClientRect();
  const style = s => getComputedStyle(document.querySelector(s));
  const rail = box('#rail'), capsule = box('#rail-toggle-slot'), app = box('#app');
  return { left: box('#stage').left - app.left, rail: rail.right - app.left,
    railWidth: rail.width, slot: capsule.left - app.left, rightGap: rail.right - capsule.right,
    centerOffset: (capsule.top + capsule.bottom - box('#topbar').top - box('#topbar').bottom) / 2,
    pad: parseFloat(style('#workspace').paddingLeft), status: parseFloat(style('#status').paddingLeft),
    railVisibility: style('#rail').visibility, dockVisibility: style('#dock').visibility,
    dockDisplay: style('#dock').display, expanded: ${toggle}.getAttribute('aria-expanded') };
})()`;
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < .75, `Expected ${actual} near ${expected}`);
const waitFor = expression => retry(() => get(expression), expression);
const navModeTrigger = '.c-select .c-btn[aria-label="导航栏形态"]';
// The setting is a GlassDesign Select: open its menu, then pick the labelled row.
const switchMode = async value => {
  const label = { rail: '侧边栏', dock: '悬浮导航栏' }[value];
  await get(`document.querySelector('${navModeTrigger}').click()`);
  await retry(() => get(`(() => {
    const item = [...document.querySelectorAll('.c-menu .c-menu__item')].find(node => node.textContent.trim() === ${JSON.stringify(label)});
    if (!item) return false;
    item.click();
    return true;
  })()`), `nav mode option ${label}`);
};

try {
  const url = await retry(async () => {
    if (spawnError) throw spawnError;
    try {
      const port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0];
      const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      return pages.find(p => p.type === 'page' && p.url.startsWith(origin))?.webSocketDebuggerUrl;
    } catch { return null; }
  }, 'Edge CDP did not start');
  ws = new WebSocket(url);
  await new Promise((r, reject) => { ws.onopen = r; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const { id, error, result } = JSON.parse(data);
    const req = pending.get(id);
    if (!req) return;
    pending.delete(id);
    clearTimeout(req.timer);
    if (error) req.reject(new Error(error.message)); else req.resolve(result);
  };
  await viewport(1100);
  await waitFor(`!!${toggle} && !!document.querySelector('#rail-grip [role=separator]')`);
  const open = await get(state);
  near(open.left, open.railWidth);
  near(open.rightGap, 16);
  near(open.centerOffset, 0);
  assert.equal(open.expanded, 'true');
  assert.equal(await get(`document.elementFromPoint(...(() => {const b=${toggle}.getBoundingClientRect(); return [(b.left+b.right)/2,(b.top+b.bottom)/2]})()).closest('[data-act=toggle-rail]') === ${toggle}`), true);
  await get(`window.navTestSlot = document.querySelector('#rail-toggle-slot'); ${toggle}.click()`);
  await waitFor(`${state}.expanded === 'false'`);
  assert.equal((await get(state)).left, 0, 'collapse releases the content immediately');
  // Seek both real CSS transitions to the same midpoint; no flaky wall-clock sampling.
  const middle = await get(`(() => {
    const elements = [document.querySelector('#rail'), window.navTestSlot.parentElement];
    const animations = elements.map(el => el.getAnimations().find(a => a.transitionProperty === 'transform'));
    if (animations.some(a => !a)) throw new Error('Missing slide transition');
    const motions = animations.map(a => [a.effect.getTiming().duration, getComputedStyle(a.effect.target).transitionTimingFunction]);
    for (const a of animations) { a.pause(); a.currentTime = 190; }
    window.navTestAnimations = animations;
    return { motions, geometry: ${state} };
  })()`);
  assert.deepEqual(middle.motions, [[380, 'cubic-bezier(0.4, 0, 0.2, 1), linear'], [380, 'cubic-bezier(0.4, 0, 0.2, 1)']]);
  assert.ok(middle.geometry.rail > 0 && middle.geometry.rail < open.railWidth);
  assert.equal(middle.geometry.railVisibility, 'visible');
  await get(`window.navTestAnimations.forEach(a => a.finish())`);
  await waitFor(`${state}.railVisibility === 'hidden'`);
  const closed = await get(state);
  near(closed.slot, 16);
  near(closed.rail, 0);
  assert.equal(closed.expanded, 'false');
  assert.ok(middle.geometry.slot > closed.slot && middle.geometry.slot < open.slot);
  await get(`${toggle}.click()`);
  await waitFor(`${state}.expanded === 'true'`);
  const opening = await get(state);
  assert.equal(opening.left, 0, 'opening does not reflow before the rail covers the edge');
  await waitFor(`${state}.left === ${open.railWidth}`);
  near((await get(state)).rightGap, 16);
  assert.equal(await get(`window.navTestSlot === document.querySelector('#rail-toggle-slot')`), true);

  const grip = `document.querySelector('#rail-grip [role=separator]')`;
  await get(`${grip}.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))`);
  const resized = await get(state);
  assert.ok(resized.railWidth > open.railWidth);
  near(resized.left, resized.railWidth);
  near(resized.rightGap, 16);

  await get(`document.querySelector('#rail [data-act=nav][data-value=settings]').click()`);
  await waitFor(`!!document.querySelector('${navModeTrigger}')`);
  await switchMode('dock');
  await waitFor(`${state}.pad > 0`);
  const dockOpen = await get(state);
  assert.equal(dockOpen.pad, dockOpen.status);
  near(dockOpen.left, dockOpen.pad);
  await get(`${toggle}.click()`);
  await waitFor(`${state}.expanded === 'false'`);
  const dockClosed = await get(state);
  assert.equal(dockClosed.pad, 0);
  assert.equal(dockClosed.status, 0);
  near(dockClosed.left, 0);
  await waitFor(`${state}.dockVisibility === 'hidden'`);
  await get(`${toggle}.click()`);
  await waitFor(`${state}.expanded === 'true'`);
  assert.equal((await get(state)).pad, dockOpen.pad);

  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await viewport(500);
  await waitFor(`${state}.dockDisplay === 'none' && ${state}.pad === 0`);
  const drawer = await get(state);
  assert.equal(drawer.dockDisplay, 'none');
  assert.equal(drawer.pad, 0);
  near(drawer.left, 0);
  near(drawer.rightGap, 16);
  await get(`${toggle}.click()`);
  await waitFor(`${state}.expanded === 'false'`);
  assert.equal((await get(state)).railVisibility, 'hidden');
  await switchMode('rail');
  await viewport(1100);
  await waitFor(`matchMedia('(min-width: 651px)').matches && matchMedia('(prefers-reduced-motion: reduce)').matches && !document.querySelector('#app').classList.contains('nav-dock')`);
  await get(`${toggle}.click()`);
  await waitFor(`${state}.expanded === 'true'`);
  const reducedOpen = await get(state);
  assert.equal(await get(`document.querySelector('#rail').getAnimations().length`), 0);
  near(reducedOpen.left, reducedOpen.railWidth);
  near(reducedOpen.rightGap, 16);
  console.log('Navigation passed: dock gutter, sidebar/capsule motion, resize, drawer fallback, reduced motion.');
} finally {
  ws?.close();
  edge.kill();
  await exited;
  server.closeAllConnections();
  await new Promise(r => server.close(r));
  if (dirname(resolve(profile)) === resolve(tmpdir())) {
    await rm(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
  }
}
