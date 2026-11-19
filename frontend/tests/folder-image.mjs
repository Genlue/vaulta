// Run: node frontend/tests/folder-image.mjs
// Edge exercises actual coordinates and rendering. Only the desktop IPC is stubbed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const browser = process.env.VAULTA_EDGE || join(process.env['ProgramFiles(x86)'], 'Microsoft/Edge/Application/msedge.exe');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = createServer(async (req, res) => {
  const path = resolve(root, '.' + (req.url === '/' ? '/index.html' : req.url));
  try {
    if (!path.startsWith(root + sep) || !mime[extname(path)]) { res.writeHead(404).end(); return; }
    const body = await readFile(path);
    res.writeHead(200, { 'Content-Type': mime[extname(path)], 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'" });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'vaulta-folder-image-'));
const edge = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, origin], { windowsHide: true, stdio: 'ignore' });
let ws, seq = 0, spawnError;
const pending = new Map(), exceptions = [];
edge.on('error', error => { spawnError = error; });
async function until(fn, label) {
  for (let i = 0; i < 100; i++) { const result = await fn(); if (result) return result; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function get(expression) {
  const { result, exceptionDetails } = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
  return result.value;
}
const wait = expression => until(() => get(`Boolean(${expression})`), expression).catch(async error => { throw new Error(error.message + JSON.stringify(exceptions) + ' ' + await get('document.body.innerText.slice(0, 750)')); });
const selector = (id, tail = '') => `[data-asset='["main","${id}"]']${tail}`;
const query = s => `document.querySelector(${JSON.stringify(s)})`;
async function click(point, clickCount = 1) {
  await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount });
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount });
}
function preload() {
  const item = (id, path, kind = 'file') => ({ id, name: path.split('/').at(-1), path, kind, state: 'filed', size: 500, identity: id });
  const vault = { id: 'main', name: 'Fixture', root: 'C:\\Fixture', status: 'ready' };
  const assets = [item('a', 'A', 'directory'), item('b', 'B', 'directory'), item('c', 'C', 'directory'), item('d', 'D', 'directory'), item('inside', 'D/inside.txt'), item('jpeg', 'photo.jpg'), item('other', 'next.jpg')];
  const canvas = document.createElement('canvas'); canvas.width = 2; canvas.height = 3;
  const good = canvas.toDataURL('image/jpeg'), bad = 'data:image/jpeg;base64,/9j/AA==';
  const response = data_url => ({ kind: 'image', data_url });
  const state = globalThis.fixture = { good, calls: [], plan: [bad, good], hold: false, released: false };
  globalThis.__TAURI__ = { event: { async listen() {} }, core: { async invoke(cmd, { assetId } = {}) {
    if (cmd === 'list_vaults') return [vault];
    if (cmd === 'snapshot') return structuredClone({ vault, assets });
    if (cmd === 'preview') {
      state.calls.push(assetId);
      if (assetId === 'jpeg' && state.hold) return new Promise(done => { state.release = () => { done(response(bad)); state.released = true; }; });
      const url = assetId === 'jpeg' ? state.plan.shift() : good;
      if (url instanceof Error) throw url;
      return response(url || good);
    }
    throw new Error(`Unexpected IPC ${cmd}`);
  } } };
}

try {
  const endpoint = await until(async () => {
    if (spawnError) throw spawnError;
    try {
      const [port] = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/);
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      return targets.find(t => t.url.startsWith(origin))?.webSocketDebuggerUrl;
    } catch { return null; }
  }, 'Edge CDP');
  ws = new WebSocket(endpoint);
  await new Promise((done, fail) => { ws.onopen = done; ws.onerror = fail; });
  ws.onmessage = ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === 'Runtime.exceptionThrown') exceptions.push(reply.params.exceptionDetails);
    const request = pending.get(reply.id);
    if (!request) return;
    pending.delete(reply.id);
    if (reply.error) request.reject(new Error(reply.error.message)); else request.resolve(reply.result);
  };
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${preload})()` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1310, height: 840, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.reload');
  await wait(query(selector('d')) + ' && document.documentElement.dataset.gdRuntime === "ready"');
  const box = node => `(() => { const { x,y,width,height } = ${node}.getBoundingClientRect(); return {x,y,width,height}; })()`;
  for (const layout of ['list', 'grid']) {
    if (layout === 'grid') {
      const grid = '.gd-slot[data-gd-props*=\'"action":"layout"\'] .c-seg__opt[data-value="grid"]';
      await get(`${query(grid)}.click()`); await wait(query('.tile.is-folder'));
    }
    const dir = query(selector('d')), bounds = await get(box(dir));
    const point = { x: Math.floor(bounds.x + bounds.width * 0.76), y: Math.floor(bounds.y + bounds.height * 0.5) };
    const hitsDir = `document.elementFromPoint(${point.x}, ${point.y})?.closest('[data-asset]') === ${dir}`;
    await wait(hitsDir);
    await click(point);
    assert.ok(await get(`${dir}.classList.contains('selected') && document.querySelector('#inspector').hidden`), layout);
    assert.deepEqual(await get(box(dir)), bounds, `${layout}: first click moved folder`);
    assert.ok(await get(hitsDir), `${layout}: second click misses folder`);
    await click(point, 2);
    await wait(`${query(selector('inside'))} && !${dir}`);
    const physical = query('[data-act="nav"][data-value="physical"]');
    await wait(physical); await get(`${physical}.click()`);
    await wait(dir);
  }
  const photo = query(selector('jpeg')), other = query(selector('other'));
  const preview = query('#inspector [data-preview-image]');
  await get(`${photo}.click()`);
  await wait(`${preview}?.naturalWidth === 2`);
  assert.deepEqual(await get('fixture.calls'), ['jpeg', 'jpeg']);
  assert.match(await get(`${preview}.src`), /^blob:/);

  // If details are already visible, folder selection must not close them or
  // move the next target. An explicitly opened folder pane remains available.
  const dir = query(selector('d')), inspector = query('#inspector');
  const shownBounds = await get(box(dir));
  await get(`${dir}.click()`);
  assert.equal(await get(`${inspector}.hidden`), false);
  assert.deepEqual(await get(box(dir)), shownBounds);
  await get(`${inspector}.querySelector('[data-act="toggle-pane"]').click()`);
  await get(`${dir}.click()`);
  assert.equal(await get(`${inspector}.hidden`), true);
  await get(`${query('#chrome [data-act="toggle-pane"]')}.click()`);
  assert.equal(await get(`${inspector}.hidden`), false);

  // A permanent decode failure stops after one automatic re-read. An explicit
  // Retry fetches an entirely new response, without reloading the app/session.
  await get(`fixture.plan = Array(2).fill('data:image/jpeg;base64,/9j/AA=='); ${other}.click(); ${photo}.click()`);
  const retry = query('[data-act="retry-preview"]');
  await wait(`${retry} && document.querySelector('#inspector').textContent.includes('图片无法解码')`);
  assert.deepEqual(await get('fixture.calls'), ['jpeg', 'jpeg', 'other', 'jpeg', 'jpeg']);
  await get(`${retry}.click()`);
  await wait(`${preview}?.naturalHeight === 3`);

  await get(`fixture.plan = [new Error('sharing violation')]; ${other}.click(); ${photo}.click()`);
  await wait(`${retry} && document.querySelector('#inspector').textContent.includes('sharing violation')`);
  await get(`${photo}.click()`); // reselecting the same asset is also recovery
  await wait(`${preview}?.naturalWidth === 2`);

  // Late responses for an abandoned selection cannot replace the new preview.
  await get(`fixture.hold = true; ${other}.click(); ${photo}.click()`);
  await wait('fixture.release');
  await get(`${other}.click(); fixture.release()`);
  await wait(`fixture.released && ${preview}?.alt === 'next.jpg' && ${preview}.naturalWidth === 2`);
  assert.deepEqual(exceptions, []);
  console.log('Folder / JPG regression passed in Edge.');
} finally {
  ws?.close();
  if (!spawnError && edge.exitCode === null) {
    const exit = new Promise(done => edge.once('exit', done)); edge.kill(); await exit;
  }
  server.close();
  if (resolve(profile).startsWith(join(resolve(tmpdir()), 'vaulta-folder-image-'))) {
    await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
