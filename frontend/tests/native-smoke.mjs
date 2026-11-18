// Native UI smoke, using the debug Tauri build with custom-protocol enabled.
// Release builds intentionally leave DevTools disabled.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../../target/debug/vaulta.exe', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
const temp = await mkdtemp(join(tmpdir(), 'vaulta-native-'));
const vaultRoot = join(temp, 'fixture');
await mkdir(vaultRoot);
await writeFile(join(vaultRoot, 'note.md'), '# Native preview\n真实文件验证');
// The debug-only TAURI_CONFIG in the frontend README enables this port.
const port = Number(process.env.VAULTA_NATIVE_TEST_PORT || 39377);
const inUse = await fetch(`http://127.0.0.1:${port}/json/list`).then(() => true).catch(() => false);
assert.ok(!inUse, `Close any existing CDP target on port ${port} before running this test`);
const child = spawn(exe, { env: { ...process.env, VAULTA_DATA_DIR: join(temp, 'data'), WEBVIEW2_USER_DATA_FOLDER: join(temp, 'profile') }, stdio: 'ignore', windowsHide: true });
let error, ws;
child.once('error', e => { error = e; });
try {
  let tab, lastPages = [];
  for (let attempt = 0; attempt < 80 && !tab; attempt++) {
    if (error || child.exitCode != null) throw error || new Error(`vaulta exited with code ${child.exitCode}`);
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    lastPages = pages;
    tab = pages.find(p => p.type === 'page' && /^(?:https?|tauri):\/\/(?:tauri\.)?localhost(?=[:/]|$)/.test(p.url));
    if (!tab) await delay(150);
  }
  assert.ok(tab, `No Tauri WebView CDP target on ${port}; paths: ${JSON.stringify(lastPages.map(p => p.url))}; profile: ${temp}`);
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let id = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push(m.params.entry.text);
    pending.get(m.id)?.(m); pending.delete(m.id);
  };
  function cdp(method, params = {}) {
    return new Promise((ok, fail) => {
      const n = ++id, timeout = setTimeout(() => { pending.delete(n); fail(new Error(`CDP timeout: ${method}`)); }, 7500);
      pending.set(n, m => { clearTimeout(timeout); if (m.error) fail(new Error(m.error.message)); else ok(m.result); });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  }
  async function get(expression) {
    const out = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!out.exceptionDetails, out.exceptionDetails?.exception?.description || out.exceptionDetails?.text);
    return out.result.value;
  }
  async function wait(expression) {
    for (let i = 0; i < 70; i++) { if (await get(expression)) return; await delay(100); }
    throw new Error(`Timed out: ${expression}`);
  }
  await cdp('Runtime.enable'); await cdp('Log.enable');
  await wait(`document.documentElement.dataset.gdRuntime==='ready' && document.body.innerText.includes('工作区就绪')`);
  assert.ok(await get(`!!document.querySelector('.c-search input') && !!document.querySelector('.c-statusbar')`));
  const created = await get(`__TAURI__.core.invoke('add_vault', {path:${JSON.stringify(vaultRoot)},name:'Native smoke',create:false})`);
  assert.ok(created.id);
  await wait(`!!document.querySelector('.vault-card [data-act=switch]')`);
  await get(`document.querySelector('.vault-card [data-act=switch]').click()`);
  await wait(`!!document.querySelector('.asset-row')`);
  await get(`document.querySelector('#rail [data-value=inbox]').click()`);
  await wait(`!!document.querySelector('.asset-row') && document.querySelector('.asset-row').textContent.includes('note.md')`);
  await get(`document.querySelector('[data-act=review-start]').click()`);
  await wait(`document.querySelector('.preview-pane')?.textContent.includes('真实文件验证')`);
  assert.ok(await get(`!!document.querySelector('.review-band .c-card')`));
  await get(`document.querySelector('[data-act=review-file]').click()`);
  await wait(`document.querySelector('.review-band')?.textContent.includes('当前视图没有待处理项目')`);
  const snapshot = await get(`__TAURI__.core.invoke('snapshot', {vaultId:${JSON.stringify(created.id)}})`);
  assert.equal(snapshot.assets.find(a => a.name === 'note.md')?.state, 'filed');
  await get(`document.querySelector('#rail [data-value=marking]').click()`);
  await wait(`document.querySelector('.mark-counts')?.textContent.startsWith('1 待标记')`);
  await get(`document.querySelector('#items .asset-mark').click()`);
  await wait(`!!document.querySelector('#modal[open] input[name="chosen-mark"][value="已核对"]')`);
  await get(`document.querySelector('#modal [value="已核对"]').click(); document.querySelector('#dialog-form').requestSubmit()`);
  await wait(`!document.querySelector('#modal').open && document.querySelector('.mark-counts').textContent.startsWith('0 待标记')`);
  const marked = await get(`__TAURI__.core.invoke('snapshot', {vaultId:${JSON.stringify(created.id)}})`);
  assert.deepEqual(marked.assets.find(a => a.name === 'note.md')?.flags, ['已核对']);
  assert.equal(marked.assets.find(a => a.name === 'note.md')?.state, 'filed');
  assert.equal(await get(`document.documentElement.dataset.gdError ?? ''`), '');
  assert.deepEqual(errors, []);
  console.log(`Native Tauri/WebView2 smoke passed. Isolated data: ${temp}`);
} finally { ws?.close(); if (child.exitCode === null && !child.killed) child.kill(); }
