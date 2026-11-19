// Run against a debug custom-protocol build with app.windows[0].additionalBrowserArgs
// set to --remote-debugging-port=39379 in the TAURI_CONFIG build environment.
// Launches an isolated app profile; set VAULTA_RELOCATION_TEST_PORT to match a different port.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readlink, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const exe = resolve(process.argv[2] || fileURLToPath(new URL('../../target/debug/vaulta.exe', import.meta.url)));
const port = Number(process.env.VAULTA_RELOCATION_TEST_PORT || 39379);
const endpoint = `http://127.0.0.1:${port}/json/list`;
assert.equal(await fetch(endpoint).then(() => true, () => false), false, 'CDP test port must be free');
const temp = await mkdtemp(join(tmpdir(), 'vaulta-relocation-'));
const old = join(temp, 'assets');
const moved = join(temp, 'moved-assets');
const data = join(temp, 'app-data');
const unitName = 'unit';
await mkdir(join(old, unitName), { recursive: true });
await writeFile(join(old, 'project.txt'), 'existing top-level file');
await writeFile(join(old, unitName, 'child.txt'), 'existing child file');
const child = spawn(exe, {
  env: { ...process.env, VAULTA_DATA_DIR: data, WEBVIEW2_USER_DATA_FOLDER: join(temp, 'profile'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1` },
  stdio: 'ignore', windowsHide: true,
});
let launchError, ws;
child.on('error', error => { launchError = error; });

async function until(check, description, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (launchError || child.exitCode !== null) throw launchError || new Error(`Vaulta exited: ${child.exitCode}`);
    const value = await check();
    if (value) return value;
    await pause(100);
  }
  throw new Error(`Timed out: ${description}`);
}
const $ = selector => `document.querySelector(${JSON.stringify(selector)})`;
try {
  const tab = await until(async () => {
    const pages = await fetch(endpoint).then(r => r.json()).catch(() => []);
    return pages.find(p => p.type === 'page' && p.url.includes('tauri.localhost'));
  }, 'WebView2 CDP', 15000);
  ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
  let next = 0;
  const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
    pending.get(message.id)?.(message);
  };
  function cdp(method, params = {}) {
    const id = ++next;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => { pending.delete(id); fail(new Error(`CDP timeout: ${method}`)); }, 8000);
      pending.set(id, result => {
        pending.delete(id); clearTimeout(timer);
        if (result.error) fail(new Error(result.error.message)); else ok(result.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function get(expression) {
    const out = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
    return out.result.value;
  }
  const invokeExpr = (command, args) => `__TAURI__.core.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`;
  const invoke = (command, args) => get(invokeExpr(command, args));
  const click = selector => get(`${$(selector)}.click()`);
  const wait = expr => until(() => get(expr), expr);
  await cdp('Runtime.enable');
  await wait(`document.documentElement.dataset.gdRuntime === 'ready' && document.body.innerText.includes('工作区就绪')`);

  const { id: vaultId } = await invoke('add_vault', { path: old, name: 'Relocation smoke', create: false });
  const snapshot = id => invoke('snapshot', { vaultId: id });
  const initial = await until(async () => {
    const snap = await snapshot(vaultId);
    return snap.assets.some(a => a.path === unitName) && snap;
  }, 'initial scan');
  const asset = initial.assets.find(a => a.path === 'project.txt');
  const unit = await invoke('open_unit', { vaultId, assetId: initial.assets.find(a => a.path === unitName).id });
  const initialChild = await until(async () => (await snapshot(unit.id)).assets.find(a => a.path === 'child.txt'), 'initial child scan');
  const category = initial.categories[0].id;
  const mutate = action => invoke('mutate', { vaultId, action });
  await mutate({ type: 'organize', ids: [asset.id], add_tags: ['Kept tag'], category_id: category, state: 'filed' });
  await mutate({ type: 'view_config', enabled: true, categories: [category] });
  // Confirm that a physical projection link is repaired when environment privileges permit its creation.
  async function findLinks(root) {
    const dirs = await readdir(root, { withFileTypes: true, recursive: true });
    return dirs.filter(entry => entry.isSymbolicLink()).map(entry => join(entry.parentPath, entry.name));
  }
  const beforeLinks = await findLinks(join(old, '.vaulta-views')).catch(() => []);
  await wait($(`.vault-card [data-act="switch"][data-value="${vaultId}"]`));
  await click(`.vault-card [data-act="switch"][data-value="${vaultId}"]`);
  await wait($('[data-act="save-view"]'));
  await click('[data-act="save-view"]');
  await get(`${$('#dialog-form')}.elements.name.value = 'Saved before move'; ${$('#dialog-form')}.requestSubmit()`);
  await wait(`!${$('#modal')}.open && ${$('h1')}.textContent === 'Saved before move'`);
  const savedViews = await get(`localStorage.getItem('vaulta.views.v1')`);
  assert.equal(JSON.parse(savedViews)[0]?.vaultId, vaultId);
  await click('#rail [data-act="nav"][data-value="home"]');

  await rename(old, moved);
  await invoke('rescan', { vaultId });
  assert.equal((await snapshot(vaultId)).vault.status, 'unavailable');
  const rejected = await get(`${invokeExpr('relocate_vault', { vaultId, path: data })}.then(() => null,e => String(e))`);
  assert.match(rejected, /应用数据目录重叠/);
  const incorrect = join(temp, 'unrelated');
  await mkdir(incorrect);
  // Replace the native folder picker only. Everything else, including errors, uses real IPC.
  await get(`import('/host.js').then(({host}) => { host.choose = () => Promise.resolve(window.relocationFolder); })`);
  await wait($(`.vault-card [data-act="manage-vault"][data-value="${vaultId}"]`));
  await click(`.vault-card [data-act="manage-vault"][data-value="${vaultId}"]`);
  await click('[data-act="relocate-vault"]');
  const form = $('#dialog-form');
  const submit = () => get(`${form}.requestSubmit()`);
  async function choose(path) {
    await get(`window.relocationFolder = ${JSON.stringify(path)}`);
    await click('#dialog-form [data-act="pick-folder"]');
    await wait(`${form}.elements.path.value === ${JSON.stringify(path)}`);
  }
  await submit();
  await wait(`${$('.dialog-error')}.textContent.includes('请先选择')`);
  await choose(incorrect);
  await submit();
  await wait(`${$('.dialog-error')}.textContent.includes('不是原仓库')`);
  assert.equal((await snapshot(vaultId)).vault.root, initial.vault.root);
  await choose(moved);
  await submit();
  await wait(`!${$('#modal')}.open`);
  const result = await snapshot(vaultId);
  assert.equal(result.vault.id, vaultId);
  assert.equal(result.vault.root.toLowerCase(), moved.toLowerCase());
  assert.deepEqual(result.vault.view_categories, [category]);
  assert.deepEqual(result.assets.find(a => a.id === asset.id).tags, ['Kept tag']);
  assert.equal((await snapshot(unit.id)).vault.root.toLowerCase(), join(moved, unitName).toLowerCase());
  assert.equal((await snapshot(unit.id)).assets.find(a => a.path === 'child.txt').id, initialChild.id);
  assert.equal(await get(`localStorage.getItem('vaulta.views.v1')`), savedViews);
  await click(`.vault-card [data-act="switch"][data-value="${vaultId}"]`);
  await get(`document.dispatchEvent(new KeyboardEvent('keydown', {key:'P', ctrlKey:true, shiftKey:true, bubbles:true}));
    ${$('#command-query')}.value = 'Saved before move';
    ${$('#command-query')}.dispatchEvent(new CompositionEvent('compositionend', {bubbles:true}));`);
  await click('#command-option-0');
  await wait(`${$('h1')}.textContent === 'Saved before move'`);
  if (beforeLinks.length) {
    await until(async () => {
      const links = await findLinks(join(moved, '.vaulta-views'));
      for (const path of links) {
        if ((await readlink(path).catch(() => '')).toLowerCase().endsWith(join('moved-assets', 'project.txt'))) return true;
      }
    }, 'projection retargeted to the new root');
  }

  // Wait for the explicit relocation pass to finish, then check real notify events before periodic scan.
  await pause(1800);
  await writeFile(join(moved, 'watch-new.txt'), 'new root');
  await writeFile(join(moved, unitName, 'watch-child.txt'), 'child of new root');
  await mkdir(old);
  await writeFile(join(old, 'not-indexed.txt'), 'unrelated replacement at old root');
  await until(async () => (await snapshot(vaultId)).assets.some(a => a.path === 'watch-new.txt')
    && (await snapshot(unit.id)).assets.some(a => a.path === 'watch-child.txt'), 'notify scan at the relocated root and child');
  assert.ok(!(await snapshot(vaultId)).assets.some(a => a.path === 'not-indexed.txt'));
  assert.deepEqual(errors, []);
  console.log(`Relocation UI, persisted metadata and watcher passed${beforeLinks.length ? ' (including disk projection)' : ' (disk link unavailable in this profile)'}.`);
} finally {
  ws?.close();
  if (child.pid && child.exitCode === null) {
    child.kill();
    await new Promise(ok => child.once('exit', ok));
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(error => console.warn(error.message));
}
