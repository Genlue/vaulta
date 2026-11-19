// Native UI smoke, using the debug Tauri build with custom-protocol enabled.
// Release builds intentionally leave DevTools disabled.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exe = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../../target/debug/vaulta.exe', import.meta.url));
const delay = ms => new Promise(r => setTimeout(r, ms));
const temp = await mkdtemp(join(tmpdir(), 'vaulta-native-'));
const vaultRoot = join(temp, 'fixture');
await mkdir(vaultRoot);
await writeFile(join(vaultRoot, 'note.md'), '# Native preview\n真实文件验证');
// A two-page, image-only PDF. The very small embedded RGB image is scaled to fill
// the first page. An extractor cannot return any text from either page.
function imagePdf() {
  const commands = ['q 200 0 0 300 0 0 cm /Im0 Do Q', '0 .3 .67 rg 0 0 200 300 re f'];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << /XObject << /Im0 7 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Resources << >> /Contents 6 0 R >>',
    ...commands.map(c => `<< /Length ${c.length} >>\nstream\n${c}\nendstream`),
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length 13 /Filter /ASCIIHexDecode >>\nstream\nEC57304EBD8F>\nendstream',
  ];
  let pdf = '%PDF-1.4\n', offsets = [];
  for (const object of objects) { offsets.push(pdf.length); pdf += `${offsets.length} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  return pdf + `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n${offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}
const officeFixtures = process.env.VAULTA_PREVIEW_FIXTURES;
const slideFixture = fileURLToPath(new URL('../../scripts/fixtures/preview-slides.pptx', import.meta.url));
const zoneMarker = '[ZoneTransfer]\r\nZoneId=3\r\n';
const officeFiles = officeFixtures ? ['word.docx', 'grid.xlsx'] : [];
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
  await wait(`Array.from(document.querySelectorAll('.asset-row')).some(r => r.textContent.includes('note.md'))`);
  await get(`document.querySelector('[data-act=review-start]').click()`);
  await wait(`document.querySelector('.preview-pane')?.textContent.includes('真实文件验证')`);
  assert.ok(await get(`!!document.querySelector('.review-band .c-card')`));
  await get(`document.querySelector('[data-act=review-file]').click()`);
  await wait(`document.querySelector('.review-band')?.textContent.includes('当前视图没有待处理项目')`);
  const snapshot = await get(`__TAURI__.core.invoke('snapshot', {vaultId:${JSON.stringify(created.id)}})`);
  assert.equal(snapshot.assets.find(a => a.name === 'note.md')?.state, 'filed');
  await get(`document.querySelector('#rail [data-value=all]').click()`);
  await wait(`Array.from(document.querySelectorAll('.asset-row')).some(r => r.textContent.includes('note.md'))`);
  await get(`document.querySelector('#items .asset-mark').click()`);
  await wait(`!!document.querySelector('#modal[open] input[name="chosen-mark"][value="已核对"]')`);
  await get(`document.querySelector('#modal [value="已核对"]').click(); document.querySelector('#dialog-form').requestSubmit()`);
  await wait(`!document.querySelector('#modal').open && document.querySelector('#items .asset-mark.is-marked')`);
  const marked = await get(`__TAURI__.core.invoke('snapshot', {vaultId:${JSON.stringify(created.id)}})`);
  assert.deepEqual(marked.assets.find(a => a.name === 'note.md')?.flags, ['已核对']);
  assert.equal(marked.assets.find(a => a.name === 'note.md')?.state, 'filed');
  await writeFile(join(vaultRoot, 'scan.pdf'), imagePdf());
  await writeFile(join(vaultRoot, 'broken.pdf'), '%PDF-1.4\nnot a real document');
  for (const name of officeFiles) await copyFile(join(officeFixtures, name), join(vaultRoot, name));
  if (officeFixtures) {
    for (const name of ['slides.pptx', 'downloaded.pptx']) await copyFile(slideFixture, join(vaultRoot, name));
    await writeFile(join(vaultRoot, 'downloaded.pptx:Zone.Identifier'), zoneMarker);
    await copyFile(join(officeFixtures, 'word.docx'), join(vaultRoot, 'downloaded.docx'));
    await writeFile(join(vaultRoot, 'downloaded.docx:Zone.Identifier'), zoneMarker);
  }
  await get(`document.querySelector('#rail [data-value=inbox]').click()`);
  const clickFile = async name => {
    const row = `Array.from(document.querySelectorAll('#items .asset-row')).find(r=>r.querySelector('.asset-name')?.title===${JSON.stringify(name)} || r.querySelector('.asset-name')?.textContent.trim()===${JSON.stringify(name)} || r.textContent.includes(${JSON.stringify(name)}))`;
    await wait(`!!(${row})`); await get(`(${row}).click()`);
  };
  await clickFile('scan.pdf');
  await wait(`document.querySelector('.pdf-page img')?.naturalHeight > 0`);
  const pixel = `(() => { const image = document.querySelector('.pdf-page img'); const c = document.createElement('canvas'); c.width=10;c.height=10; const ctx = c.getContext('2d'); ctx.drawImage(image,0,0,10,10);return [...ctx.getImageData(2,2,1,1).data]; })()`;
  const first = await get(pixel);
  assert.ok(first[0] > 190 && first[1] < 130, `First page should show the embedded orange image: ${first}`);
  await get(`document.querySelector('[data-act=pdf-view][data-value=next]').click()`);
  await wait(`document.querySelector('.pdf-page-label')?.textContent === '2 / 2' && document.querySelector('.pdf-page img')?.naturalHeight > 0`);
  const second = await get(pixel);
  assert.ok(second[2] > 130 && second[0] < 10, `Second page should be blue: ${second}`);
  await clickFile('broken.pdf');
  await wait(`document.querySelector('.preview-message [data-act=retry-preview]') && document.querySelector('.preview-message [data-act=open-asset]')`);
  for (const name of officeFiles) {
    await clickFile(name);
    await wait(`!!document.querySelector('.office-preview-surface:not([aria-busy]), .preview-message [data-act=retry-preview]')`);
    assert.ok(await get(`!!document.querySelector('.office-preview-surface:not([aria-busy])')`), await get(`document.querySelector('.preview-pane')?.innerText`));
    assert.deepEqual(await readFile(join(vaultRoot, name)), await readFile(join(officeFixtures, name)));
  }
  if (officeFixtures) {
    const assertSlide = async (page, color) => {
      await wait(`(document.querySelector('.pdf-page-label')?.textContent === '${page} / 2' && document.querySelector('.pdf-page img')?.naturalHeight > 0) || !!document.querySelector('.preview-message [data-act=retry-preview], .pdf-status[role=alert]')`);
      assert.equal(await get(`document.querySelector('.pdf-page-label')?.textContent`), `${page} / 2`, await get(`document.querySelector('.preview-pane')?.innerText`));
      const rgb = await get(pixel);
      assert.ok(color.every((c, i) => Math.abs(rgb[i] - c) <= 5), `Slide ${page} should paint ${color}, got ${rgb}`);
    };
    await clickFile('slides.pptx');
    await assertSlide(1, [16, 43, 99]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=next]').click()`);
    await assertSlide(2, [182, 74, 35]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=prev]').click()`);
    await assertSlide(1, [16, 43, 99]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=toggle-mode]').click()`);
    await wait(`!document.querySelector('.pdf-flow')`);
    await get(`document.querySelector('[data-act=pdf-view][data-value=next]').click()`);
    await assertSlide(2, [182, 74, 35]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=prev]').click()`);
    await assertSlide(1, [16, 43, 99]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=toggle-mode]').click()`);
    await wait(`!!document.querySelector('.pdf-flow')`);
    assert.deepEqual(await readFile(join(vaultRoot, 'slides.pptx')), await readFile(slideFixture));
    await clickFile('downloaded.pptx');
    const allowOnce = `document.querySelector('[data-act=preview-marked-once]')`;
    await wait(`!!${allowOnce}`);
    await get(`${allowOnce}.click()`);
    await wait(`document.querySelector('#modal[open]')?.textContent.includes('仅本次预览')`);
    await get(`document.querySelector('#dialog-form').requestSubmit()`);
    await assertSlide(1, [16, 43, 99]);
    await get(`document.querySelector('[data-act=pdf-view][data-value=next]').click()`);
    await assertSlide(2, [182, 74, 35]);
    assert.deepEqual(await readFile(join(vaultRoot, 'downloaded.pptx')), await readFile(slideFixture));
    assert.equal(await readFile(join(vaultRoot, 'downloaded.pptx:Zone.Identifier'), 'utf8'), zoneMarker);
    await clickFile('slides.pptx');
    await assertSlide(1, [16, 43, 99]);
    await clickFile('downloaded.pptx');
    await wait(`!!${allowOnce}`);
    await clickFile('downloaded.docx');
    await wait(`!!${allowOnce}`);
    await get(`${allowOnce}.click()`);
    await wait(`document.querySelector('#modal[open]')?.textContent.includes('仅本次预览')`);
    await get(`document.querySelector('#dialog-form').requestSubmit()`);
    await wait(`!!document.querySelector('.office-preview-surface:not([aria-busy]), .preview-message [data-act=retry-preview]')`);
    assert.ok(await get(`!!document.querySelector('.office-preview-surface:not([aria-busy])')`), await get(`document.querySelector('.preview-pane')?.innerText`));
    assert.deepEqual(await readFile(join(vaultRoot, 'downloaded.docx')), await readFile(join(officeFixtures, 'word.docx')));
    assert.equal(await readFile(join(vaultRoot, 'downloaded.docx:Zone.Identifier'), 'utf8'), zoneMarker);
    await clickFile('word.docx');
    await wait(`!!document.querySelector('.office-preview-surface:not([aria-busy])')`);
    await clickFile('downloaded.docx');
    await wait(`!!${allowOnce}`);
  }
  assert.equal(await get(`document.documentElement.dataset.gdError ?? ''`), '');
  assert.deepEqual(errors, []);
  console.log(`Native Tauri/WebView2 smoke passed. Isolated data: ${temp}`);
} finally { ws?.close(); if (child.exitCode === null && !child.killed) child.kill(); }
