// Dependency-free browser smoke for Windows. Run: node frontend/tests/smoke.mjs
// All host actions use a test-only in-memory IPC stub injected through CDP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = fileURLToPath(new URL('../', import.meta.url));
const browser = process.env.VAULTA_EDGE || `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`;
const temp = await mkdtemp(join(tmpdir(), 'vaulta-ui-'));
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const path = resolve(frontend, `.${pathname === '/' ? '/index.html' : pathname}`);
  const ext = path.split('.').at(-1), mime = { html: 'text/html; charset=utf-8', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', wasm: 'application/wasm' };
  try {
    if (!path.startsWith(resolve(frontend) + sep) || !mime[ext]) throw new Error('Unknown resource');
    res.writeHead(200, { 'Content-Type': mime[ext], 'Content-Security-Policy': "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'" });
    res.end(await readFile(path));
  } catch { res.end(); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${server.address().port}`;
const edge = spawn(browser, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${join(temp, 'profile')}`, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
const pause = ms => new Promise(r => setTimeout(r, ms));
const cdpUrl = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Edge CDP did not start')), 10000);
  edge.once('error', error => { clearTimeout(timer); reject(error); });
  edge.stderr.on('data', data => { const m = String(data).match(/DevTools listening on (ws:\/\/[^\s]+)/); if (m) { clearTimeout(timer); resolve(m[1]); } });
});
const tabs = await fetch(cdpUrl.replace('ws:', 'http:').replace(/\/devtools\/.*/, '/json/list')).then(r => r.json());
const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let seq = 0;
const pending = new Map(), errors = [], logs = [];
ws.onmessage = event => {
  const data = JSON.parse(event.data);
  if (data.method === 'Runtime.exceptionThrown') errors.push(`${data.params.exceptionDetails.exception?.description || data.params.exceptionDetails.text} @ ${data.params.exceptionDetails.url}:${data.params.exceptionDetails.lineNumber}`);
  if (data.method === 'Log.entryAdded' && data.params.entry.level === 'error') logs.push(data.params.entry.text);
  if (!data.id || !pending.has(data.id)) return;
  const { resolve, reject } = pending.get(data.id); pending.delete(data.id);
  if (data.error) reject(new Error(data.error.message)); else resolve(data.result);
};
function cdp(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function get(expression) {
  const out = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text);
  return out.result.value;
}
async function wait(expression) {
  for (let i = 0; i < 50; i++) { if (await get(expression)) return; await pause(60); }
  throw new Error(`Timed out: ${expression}\n${await get('document.body.innerText.slice(0,2400)')}\n${JSON.stringify({errors,logs})}`);
}
const exists = s => `!!document.querySelector(${JSON.stringify(s)})`;
const text = s => `document.body.innerText.includes(${JSON.stringify(s)})`;
const click = async s => { await wait(exists(s)); await get(`document.querySelector(${JSON.stringify(s)}).click()`); };
const action = (name, value) => `[data-act="${name}"]${value == null ? '' : `[data-value="${value}"]`}`;
const set = (sel, value) => get(`(() => {const a=document.querySelector(${JSON.stringify(sel)}); a.value=${JSON.stringify(value)}; a.dispatchEvent(new Event(${JSON.stringify(sel.startsWith('select') ? 'change' : 'input')}, {bubbles:true}));})()`);
const segment = (actionName, value) => `.gd-slot[data-gd-props*='"action":"${actionName}"'] .c-seg__opt[data-value="${value}"]`;
const key = (selector, key, options = {}) => get(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, bubbles: true, cancelable: true, ...options })}))`);
const chooseMenu = async (anchor, label) => { await click(anchor); await clickText('.c-menu[data-state=open] .c-menu__item', label); };
const vaultChoice = label => chooseMenu('.vault-loc [data-gd-widget=menu] button', label);
const toolChoice = label => chooseMenu('.library-tools [data-gd-props*=仓库工具] button', label);
const clickText = async (selector, value) => {
  const lookup = `[...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(value)})`;
  await wait(`!!${lookup}`); await get(`${lookup}.click()`);
};
const submit = () => get(`document.querySelector('#dialog-form').requestSubmit()`);
const close = () => wait('!document.querySelector("#modal").open');
const shot = async (name, clip) => { const r = await cdp('Page.captureScreenshot', { format: 'png', ...(clip && { clip }) }); await writeFile(join(temp, `${name}.png`), Buffer.from(r.data, 'base64')); };

function preload() {
  const D = Date.UTC(2026, 10, 16, 9, 23), makeVault = (id, name, root, parent_id = null, unit_id = null) => ({ id, name, root, parent_id, unit_id, view_enabled: false, view_categories: [], status: 'ready' });
  const item = (id, path, opts = {}) => ({ id, path, name: path.split('\\').at(-1), kind: 'file', size: 186460, modified: D, created: D, category_id: null, tags: [], flags: [], state: 'inbox', identity: 'test:' + id, ...opts });
  const seed = [item('a', '设计\u005c界面方案.md', { size: 2687, tags: ['设计', '2026'], flags: ['重点关注'], category_id: 'cat' }),
    item('b', '设计/封面.png', { tags: ['设计'], size: 1284962, state: 'filed' }), item('c','导出/封面副本.png', { state: 'filed' }), item('d','说明.txt', { state: 'filed' }),
    item('i1','待整理/资料一.txt'), item('i2','待整理/资料二.txt'), item('i3','待整理/资料三.txt'),
    item('folder','设计', { kind: 'directory', state: 'filed' }), item('unit','短片项目', { kind: 'directory', state: 'filed' }),
    item('unit-content','短片项目\u005c分镜.md', { state: 'filed' }), item('e','不参与归档.pdf', { state: 'excluded' }), item('f','遗失的照片.jpg', { state: 'missing' })];
  const data = new Map(), watchers = new Map(), revisions = new Map(), access = new Map(), calls = [];
  const store = (vault, assets) => data.set(vault.id, { vault, assets: structuredClone(assets), categories: [{ id: 'cat', name: '设计资料', parent_id: null }, { id: 'child', name: '品牌', parent_id: 'cat' }], tags: ['设计','2026'], history: [{ time: D, source: '扫描', message: '发现新资产' }] });
  const emit = (name, payload) => { for (const cb of watchers.get(name) || []) cb({ payload }); };
  globalThis.fixture = { data, calls, emit, revisions, conflict: false, second() { store(makeVault('other','资料备份','D:\\资料备份'), [item('a','界面方案.md'), item('doc','会议纪要.docx')]); emit('vaulta-changed',''); } };
  globalThis.__TAURI__ = { event: { async listen(type, cb) { if (!watchers.has(type)) watchers.set(type, []); watchers.get(type).push(cb); return () => {}; } }, core: {
    async invoke(cmd, args = {}) {
      calls.push([cmd, structuredClone(args)]); const s = data.get(args.vaultId), a = s?.assets.find(x => x.id === args.assetId);
      switch (cmd) {
        case 'list_vaults': return structuredClone([...data.values()].map(x => x.vault));
        case 'choose_folder': return args.title.includes('目标') ? 'D:\\输出' : 'C:\\本地文件';
        case 'add_vault': { const v = makeVault('main',args.name,args.create ? args.path + '\\' + args.name : args.path); store(v,seed); return structuredClone(v); }
        case 'rename_vault': s.vault.name = args.name; return;
        case 'remove_vault': data.delete(args.vaultId); return;
        case 'snapshot': if (!s) throw '仓库不存在'; return structuredClone(s);
        case 'preview': if (a.id === 'doc') return {kind:'text',text:'里程碑说明 <script>不会执行</script>'}; return revisions.get(a.id) || { kind:'text', text:'# 设计构想\n\n预览 **测试**', revision:'r1' };
        case 'save_text': if (fixture.conflict) throw '文件已在外部修改，未覆盖'; revisions.set(a.id, { kind:'text', text:args.text, revision:'r2' }); emit('vaulta-changed',args.vaultId); return;
        case 'duplicates': return [['b','c']];
        case 'rescan': emit('vaulta-changed', args.vaultId); return;
        case 'api_info': return { executable:'C:\\vaulta-agent.exe', database:'C:\\vaulta.db', protocol:1 };
        case 'agent_access': return access.get(args.vaultId) || 'off';
        case 'set_agent_access': access.set(args.vaultId,args.access); return;
        case 'content_matches': return args.query === '里程碑说明' && args.vaultIds.includes('other') ? [{vault_id:'other',asset_id:'doc'}] : [];
        case 'create_folder': return args.parent ? args.parent + '\\' + args.name : args.name;
        case 'open_unit': { a.kind = 'unit'; const v=makeVault('unit-v',a.name,s.vault.root+'\\'+a.name,args.vaultId,a.id); store(v,[item('unit-content','分镜.md')]); return structuredClone(v); }
        case 'file_operation': if (args.operation === 'move' && a.id === 'b') throw '目标路径已存在'; return;
        case 'mutate': { const op = args.action;
          if (op.type === 'organize') for (const x of s.assets.filter(a => op.ids.includes(a.id))) { if ('category_id' in op) x.category_id=op.category_id; if (op.state) x.state=op.state; for (const key of ['tags','flags']) x[key]=[...new Set([...x[key],...(op['add_'+key]||[])])].filter(v => !op['remove_'+key]?.includes(v)); }
          if (op.type === 'category_save') { if(op.id) Object.assign(s.categories.find(x=>x.id===op.id), op); else s.categories.push({id:'new-cat',name:op.name,parent_id:op.parent_id}); }
          if (op.type === 'tag_create') s.tags.push(op.name);
          if (op.type === 'view_config') Object.assign(s.vault, {view_enabled:op.enabled,view_categories:op.categories});
          return; }
        default: throw new Error('Unknown ABI call: '+cmd);
      }
    }
  } };
}
try {
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Log.enable');
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `(${preload.toString()})()` });
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 860, deviceScaleFactor: 1, mobile: false });
  await cdp('Page.navigate', { url: origin });
  await wait(`document.documentElement.dataset.gdRuntime === 'ready'`);
  await wait(exists('.c-statusbar')); await wait(exists('.c-nav__item')); await wait(exists('.c-search input'));
  await wait(text('还没有仓库')); await wait(text('工作区就绪')); await wait(exists('#glass-defs svg'));
  await wait(exists('#chrome [data-gd-widget=toolbar][data-gd-mounted] .c-topbar'));
  assert.ok(await get(`document.querySelectorAll('#chrome [data-gd-widget=capsule][data-gd-mounted] .c-capsule').length >= 4`));
  // Brand moved into the rail's second row; the capsule row only holds controls.
  assert.ok(await get(`!!document.querySelector('.rail-brand img') && !document.querySelector('.brand-slot')`));
  assert.ok(await get(`!!document.querySelector('.vault-glass > .c-capsule')`));
  assert.equal(await get(`getComputedStyle(document.querySelector('.chrome-main')).columnGap`), '16px');
  assert.equal(await get(`getComputedStyle(document.querySelector('.chrome')).backgroundColor`), 'rgba(0, 0, 0, 0)');
  assert.ok(await get(`!!document.querySelector('#topveil.c-topveil')`));
  const optic = await get(`getComputedStyle(document.querySelector('#rail-toggle-slot .c-capsule--round')).backdropFilter`);
  assert.match(optic, /blur.*saturate/);
  if (await get(`CSS.supports('backdrop-filter','url(#gd-glass-capsule-34)')`)) assert.match(optic, /gd-glass-capsule-34/);
  await shot('01-home');
  await click(action('new-vault')); await click(action('pick-folder')); await set('#modal input[name=name]', '设计素材'); await submit(); await close();
  await click(action('nav','inbox')); await wait(exists('.asset-row')); assert.equal(await get('document.querySelectorAll(".asset-row").length'),4);
  // Back/forward capsule drives the same view state as direct navigation.
  await click(action('nav','all')); await wait(`document.querySelector('h1').textContent === '资料库'`);
  await wait(`!document.querySelector('[data-act=history-back]').disabled`);
  await click(action('history-back')); await wait(`document.querySelector('h1').textContent === '收件箱'`);
  await wait(`!document.querySelector('[data-act=history-forward]').disabled`);
  await click(action('history-forward')); await wait(`document.querySelector('h1').textContent === '资料库'`);
  await click(action('history-back')); await wait(`document.querySelector('h1').textContent === '收件箱'`);
  await get(`[...document.querySelectorAll('.asset-row')].find(n=>n.textContent.includes('界面方案.md')).click()`);
  // A plain click previews the file; metadata lives behind the 信息 tab.
  await wait(text('设计构想'));
  assert.equal(await get(`document.querySelector('#bulk').hidden`), true);
  assert.ok(await get(`getComputedStyle(document.querySelector('.asset-row .col-check input')).opacity === '0'`));
  await click(segment('inspect-tab','details')); await wait(text('整理信息')); await shot('02-inbox');
  await click(action('organize-one')); await set('#modal input[name=tags]', '设计，2026，已核对'); await submit(); await close(); await wait(text('已核对'));
  await click(segment('inspect-tab','preview')); await wait(exists('.markdown'));
  await get(`globalThis.oldPreview=document.querySelector('.preview-pane'); fixture.emit('vaulta-changed','')`);
  await pause(425); assert.equal(await get(`document.querySelector('.preview-pane')===oldPreview`),true);
  await get(`fixture.data.get('main').assets.find(a=>a.id==='a').modified++; fixture.revisions.set('a',{kind:'text',revision:'r1a',text:'# 外部刷新'}); fixture.emit('vaulta-changed','')`);
  await wait(text('外部刷新')); assert.equal(await get(`document.querySelector('.preview-pane')===oldPreview`),false);
  await click(action('edit-text')); await set('#editor', '# 未保存草稿');
  await get(`fixture.conflict=true; fixture.revisions.set('a',{kind:'text',revision:'r3',text:'磁盘内容'}); fixture.emit('vaulta-changed','main')`);
  const before = await get(`fixture.calls.filter(x=>x[0]==='snapshot').length`); await pause(450);
  assert.equal(await get(`fixture.calls.filter(x=>x[0]==='snapshot').length`),before);
  await submit(); await wait(text('未覆盖')); assert.equal(await get('document.querySelector("#editor").value'),'# 未保存草稿'); await shot('03-editor-conflict');
  await click(action('reload-draft')); await wait(text('磁盘内容')); await click(action('use-disk-version')); await click(action('use-disk-version'));
  await get('fixture.conflict=false'); await set('#editor', '# 保存成功'); await submit(); await close(); await wait(text('保存成功'));
  await click(action('nav','all')); await click(segment('library-mode','physical')); await wait(text('文件')); await click(segment('layout','grid')); await shot('04-physical-grid');
  await click(segment('library-mode','all')); await wait(text('说明.txt'));
  // The library only lists adopted assets; the inbox file stays in the tree.
  assert.ok(await get(`!document.querySelector('#items').textContent.includes('界面方案.md')`));
  await shot('04b-library');
  await click(segment('library-mode','physical')); await wait(text('文件'));
  await get(`document.querySelectorAll('.tile').forEach(n=>{if(n.textContent.includes('短片项目'))n.querySelector('[data-act=asset-menu]').click()})`);
  await click(action('open-unit')); await wait(text('将文件夹设为整体单元')); await submit(); await close(); await wait(text('分镜.md'));
  // Inside a folder unit the tree still offers a way back to the parent vault.
  assert.ok(await get(`!!document.querySelector('.breadcrumbs [data-act=switch]')`));
  await click(action('nav','settings')); await wait(exists('select[data-setting=agent]')); await set('select[data-setting=agent]','read'); await wait(text('允许外部工具访问')); await submit(); await close();
  await wait(`fixture.calls.some(([c,p])=>c==='set_agent_access'&&p.vaultId==='unit-v'&&p.access==='read')`);
  await click('.agent-docs summary'); await shot('05-agent-settings');
  await get(`__TAURI__.core.invoke('set_agent_access',{vaultId:'unit-v',access:'off'}); fixture.emit('vaulta-changed','')`);
  await wait(`document.querySelector('select[data-setting=agent]').value==='off'`);
  assert.equal(await get(`document.querySelector('.agent-docs').open`),true);
  await get('fixture.second()'); await wait(`fixture.calls.some(([c,p])=>c==='snapshot'&&p.vaultId==='other')`);
  await click('#query-scope [data-gd-widget=menu] button'); await clickText('.c-menu[data-state=open] .c-menu__item', '全部仓库'); await set('#query','界面方案'); await wait(`document.querySelectorAll('.tile').length===2`); await shot('06-cross-vault-search');
  await click('#query-scope [data-gd-widget=menu] button'); await clickText('.c-menu[data-state=open] .c-menu__item', '搜索文件内容（含文档）'); await set('#query', '里程碑说明');
  await wait(`document.querySelectorAll('.tile').length===1 && document.querySelector('.tile').textContent.includes('会议纪要.docx')`);
  await click('.tile'); await click(segment('inspect-tab','preview')); await wait(text('提取文本 · 只读')); await wait(text('<script>不会执行</script>'));
  assert.ok(await get(`!document.querySelector('.preview-content script') && !document.querySelector('[data-act=edit-text]')`));
  await click('#query-scope [data-gd-widget=menu] button'); await clickText('.c-menu[data-state=open] .c-menu__item', '搜索文件内容（含文档）');
  await vaultChoice('设计素材'); await click(action('nav','all')); await toolChoice('重复文件'); await wait(text('重复组 1')); await click(segment('layout','list'));
  await click('thead [data-select-all]'); await wait(text('已选 2 项')); await click(action('move')); await wait(text('移动到仓库外')); await submit(); await close();
  await wait(text('1 项成功，1 项未确认完成'));
  assert.equal(await get(`fixture.calls.filter(([c,p])=>c==='file_operation'&&p.operation==='move'&&p.confirmed===true).length`),2);
  await click(action('nav','all')); await click(action('filters')); await set('#modal select[name=type]', 'image'); await submit(); await close();
  await click(action('save-view')); await set('#modal input[name=name]', '只看图像'); await submit(); await close(); await wait(exists('.library-tools [data-gd-props*=open-view]'));
  assert.ok(await get(`JSON.parse(localStorage.getItem('vaulta.views.v1')).some(v=>v.name==='只看图像' && v.filters.type==='image')`));
  await click(action('nav','all')); await chooseMenu('.library-tools [data-gd-props*=open-view] button', '只看图像'); await wait(`document.querySelector('h1').textContent === '只看图像'`);
  assert.ok(await get(`document.querySelectorAll('.asset-row').length > 0 && [...document.querySelectorAll('.asset-row')].every(e=>/\\.png/.test(e.textContent))`));
  await set('#query', '封面'); await wait(`document.querySelector('h1').textContent === '搜索结果'`);
  await click('#query-slot button[aria-label=清除]'); await wait(`document.querySelector('h1').textContent === '只看图像' && !!document.querySelector('.filter-chip')`);
  await click('.asset-tools [data-gd-widget=menu] button'); await wait(exists('.c-menu[data-state=open]'));
  await clickText('.c-menu[data-state=open] .c-menu__item', '修改日期'); await wait(exists('th.col-date[aria-sort=ascending]'));
  await key('body','P',{ctrlKey:true,shiftKey:true}); await wait(exists('#commands[open] #command-query'));
  await set('#command-query','逐项'); // Contextual commands must not appear on a non-Inbox page.
  await wait(text('没有匹配的指令')); await set('#command-query','打开收件箱'); await wait(text('打开收件箱'));
  await key('#command-query','Enter'); await wait(`!document.querySelector('#commands').open && document.querySelector('h1').textContent === '收件箱'`);
  await click(action('review-start')); await wait(exists('.review-band [data-act=review-file]:not(:disabled)'));
  const first = await get(`document.querySelector('.review-band p').textContent`);
  await click(action('review-next')); await wait(`document.querySelector('.review-band p').textContent !== ${JSON.stringify(first)}`);
  const inboxBefore = await get(`fixture.data.get('main').assets.filter(a=>a.state==='inbox').length`);
  await click(action('review-organize')); await set('#modal input[name=tags]', '已逐项处理'); await submit(); await close();
  assert.equal(await get(`fixture.data.get('main').assets.filter(a=>a.state==='inbox').length`), inboxBefore - 1);
  assert.ok(await get(`fixture.data.get('main').assets.some(a=>a.state==='filed' && a.tags.includes('已逐项处理'))`));
  await wait(exists('.review-band [data-act=review-file]:not(:disabled)')); await shot('09-review');
  await click(action('review-stop')); await click(action('nav','all')); await toolChoice('重复文件'); await wait(text('重复组 1'));
  await click(action('nav','marking'));
  await wait(`document.querySelector('.mark-counts')?.textContent.includes('已标记') && document.querySelector('#items').textContent.includes('资料备份')`);
  assert.ok(await get(`!document.querySelector('#items').textContent.includes('遗失的照片.jpg') && !document.querySelector('#items').textContent.includes('不参与归档.pdf') && document.querySelectorAll('#items .asset-row[data-asset*="unit-content"]').length===1`));
  const firstPending = await get(`Number(document.querySelector('.mark-counts').textContent.match(/^\\d+/)[0])`);
  const marked = ['["main","b"]', '["other","a"]'];
  for (const id of marked) await click(`[data-asset-check=${JSON.stringify(id)}]`);
  await click(action('mark-selected')); await click('#modal input[name="chosen-mark"][value="已核对"]'); await submit(); await close();
  await wait(`document.querySelector('.mark-counts').textContent.startsWith('${firstPending - 2} 待标记')`);
  assert.ok(await get(`fixture.calls.filter(([c,p])=>c==='mutate'&&p.action.add_flags?.includes('已核对')).every(([,p])=>!p.action.state&&!p.action.add_tags)`));
  await wait(`document.querySelector('.mark-segments .c-seg__ind').offsetWidth>0`);
  const movement = await get(`(async()=>{
    const region=document.querySelector('.mark-segments'); const ind=region.querySelector('.c-seg__ind');
    const x=()=>new DOMMatrixReadOnly(getComputedStyle(ind).transform).m41;
    const before=x(); region.querySelector('button[data-value=marked]').focus(); region.querySelector('button[data-value=marked]').click();
    const moved=await new Promise(resolve=>{ let sawTransition=false, furthest=before, tries=0; const frame=()=>{sawTransition||=ind.getAnimations().some(a=>a.transitionProperty==='transform'); furthest=Math.max(furthest,x()); if (++tries>28) resolve({sawTransition,furthest}); else requestAnimationFrame(frame);}; requestAnimationFrame(frame); });
    return {before, ...moved, same:ind===document.querySelector('.mark-segments .c-seg__ind'), focus:document.activeElement===region.querySelector('button[data-value=marked]')};
  })()`);
  assert.ok(movement.same && movement.focus && movement.sawTransition && movement.furthest - movement.before > 30, JSON.stringify(movement));
  assert.ok(await get(`(async()=>{const region=document.querySelector('.mark-segments'), ind=region.querySelector('.c-seg__ind'); region.querySelector('button[data-value=pending]').click(); for(let i=0;i<20;i++){ await new Promise(requestAnimationFrame); const motion=ind.getAnimations().find(a=>a.transitionProperty==='transform'); if(motion){motion.pause(); globalThis.motion=motion; return true;} } return false; })()`));
  const clip = await get(`(()=>{const a=document.querySelector('.marking-controls').getBoundingClientRect();return {x:Math.max(0,Math.round(a.left-8)),y:Math.max(0,Math.round(a.top-6)),width:370,height:46,scale:1}})()`);
  for(const [frame, t] of [0,35,65,95,130,170,220,280].entries()) { await get(`motion.currentTime=${t}`); await shot(`motion-${frame}`,clip); }
  await get(`motion.finish()`); await click(segment('mark-mode','marked'));
  await wait(`document.querySelectorAll('#items .asset-mark.is-marked').length===3 && document.querySelector('#items').textContent.includes('资料备份')`);
  await click(`#items [data-asset=${JSON.stringify(marked[1])}] .asset-mark`);
  await click('#modal input[name="chosen-mark"][value="已核对"]'); await submit(); await close();
  await wait(`document.querySelector('.mark-counts').textContent.startsWith('${firstPending - 1} 待标记')`);
  assert.ok(await get(`fixture.data.get('other').assets.find(a=>a.id==='a').state==='inbox'`));
  await click(segment('mark-mode','pending'));
  await get(`const s=fixture.data.get('main'); s.assets.push(...Array.from({length:100},(_,i)=>({...s.assets[0],id:'long'+i,name:'中文超长文件名用于检测折行和重叠'+i+'.md',path:'非常长的层级目录/'.repeat(9)+'中文超长文件名用于检测折行和重叠'+i+'.md',flags:[]}))); fixture.emit('vaulta-changed','main')`);
  await wait(`document.querySelectorAll('.asset-row').length>100`); await shot('10-pending-wide');
  await get(`document.querySelector('.asset-row').click()`);
  await wait(`!document.querySelector('#inspector').hidden`);
  await cdp('Emulation.setDeviceMetricsOverride', { width: 900, height: 570, deviceScaleFactor: 1, mobile: false });
  await get(`document.querySelector('#stage').scrollTop=480`); await pause(320);
  assert.equal(await get(`getComputedStyle(document.querySelector('#topveil')).opacity`), '1');
  assert.equal(await get(`getComputedStyle(document.querySelector('.asset-stage')).paddingLeft`), '0px');
  // The stage is full-bleed, but its content keeps the shared inner gutter.
  assert.ok(parseFloat(await get(`getComputedStyle(document.querySelector('.asset-intro')).paddingLeft`)) >= 16);
  assert.ok(parseFloat(await get(`getComputedStyle(document.querySelector('.asset-toolbar')).paddingLeft`)) >= 16);
  assert.deepEqual(await get(`(()=>{const stage=document.querySelector('#stage'), th=document.querySelector('thead th'), r=th.getBoundingClientRect(), s=stage.getBoundingClientRect(); const rowPoint=document.elementFromPoint(r.left+45, r.bottom+4); return {gap:r.top-s.top, head:!!document.elementFromPoint(r.left+8,r.top+6)?.closest('thead'), row:!!rowPoint?.closest('tbody tr'), noOverflow:stage.scrollWidth===stage.clientWidth}})()`), { gap: 52, head: true, row: true, noOverflow: true });
  await shot('07-compact-sticky');
  const startGrip = await get(`(()=>{const rail=document.querySelector('#rail'), grip=document.querySelector('#rail-grip [role=separator]'), a=grip.getBoundingClientRect();return {x:Math.round(a.left+a.width/2),y:Math.round(a.top+a.height/2),width:rail.offsetWidth};})()`);
  const { x, y, width } = startGrip;
  // Stay inside the 900px viewport's rail limit (innerWidth - 620 = 280px).
  const grow = Math.min(40, 280 - width);
  await cdp('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', buttons:1, clickCount:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseMoved', x:x+grow, y:y+23, button:'left', buttons:1 });
  await cdp('Input.dispatchMouseEvent', { type:'mouseReleased', x:x+grow, y:y+23, button:'left', buttons:0, clickCount:1 });
  await wait(`document.querySelector('#rail').offsetWidth === ${width + grow}`);
  assert.equal(await get(`document.querySelector('#rail-grip [role=separator]').getAttribute('aria-valuenow')`), String(width+grow));
  await key('#rail-grip [role=separator]', 'ArrowLeft');
  await wait(`localStorage.getItem('vaulta.rail-width') === '${width + grow - 8}'`);
  // The chosen width survives collapsing and reopening the sidebar.
  await click(action('toggle-rail')); await wait(`document.querySelector('#rail-grip').hidden`);
  await click(action('toggle-rail')); await wait(`document.querySelector('#rail').offsetWidth === ${width + grow - 8}`);
  await shot('11-resized-sidebar');

  await click(action('nav','settings'));
  await click('.c-select button[aria-label="配色方案"]'); await clickText('.c-menu[data-state=open] .c-menu__item', '浅色'); await wait(`document.documentElement.dataset.theme === 'light'`); await shot('08-light');
  await click('.c-select button[aria-label="配色方案"]'); await clickText('.c-menu[data-state=open] .c-menu__item', '深色'); await wait(`document.documentElement.dataset.theme === 'dark'`); await shot('08-dark');
  await cdp('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion',value:'reduce' }] });
  await click(action('nav','marking')); await wait(exists('.mark-segments .c-seg__ind'));
  await click(segment('mark-mode','marked'));
  await wait(`document.querySelector('.mark-segments .c-seg').dataset.value==='marked'`);
  assert.ok(await get(`matchMedia('(prefers-reduced-motion: reduce)').matches && parseFloat(getComputedStyle(document.querySelector('.mark-segments .c-seg__ind')).transitionDuration) < 0.001`));
  assert.equal(await get(`document.documentElement.dataset.gdError ?? ''`), '');
  await cdp('Page.reload');
  await wait(`document.querySelector('#rail').offsetWidth === ${width + grow - 8} && document.querySelector('#rail-grip [role=separator]')`);
  assert.deepEqual(errors, []); assert.deepEqual(logs, []);
  console.log(`Edge smoke passed. Screenshots: ${temp}`);
} finally { ws.close(); edge.kill(); server.close(); }

