import { viewPages, restoreViews, matchCommands } from './workflows.js';
import { widget, mount, unmount, redraw, updateWidget, installGlass, installGlassDefinitions } from './glass.js';
import { host, connected } from './host.js';
import { installWindowChrome, canUseWindowChrome, getWindowChromeMode, setWindowChromeMode } from './window-chrome.js';
import { arr, unique, norm, pathKey, parentPath, splitPath, basename, absolute, containsPath, normalizeSnapshot, makeCategoryIndex, ancestry,
  categoryOptions, folderIndex, visibleAssets, searchAssets, assetType, assetKey, isDir, formatDate, formatBytes, defaultFlags, collator, markable, markingAssets } from './model.js';
import { esc, icon, act, button, ib, pill, visual, statePill, field, labeled, select, check, menuItem, menuLine, blank, infoRow, assetCard, assetRow, lines, segmented, themeSelect, inlineNotice } from './ui.js';

const $ = selector => document.querySelector(selector);
const chrome = $('#chrome'), gripHost = $('#rail-grip'), rail = $('#rail'), workspace = $('#workspace'), inspector = $('#inspector'), status = $('#status'), pop = $('#pop'), modal = $('#modal');
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(`vaulta.${key}`)) ?? fallback; } catch { return fallback; } }
function persist(key, value) { try { localStorage.setItem(`vaulta.${key}`, JSON.stringify(value)); } catch {} }
const prefs = { railWidth: stored('rail-width', null), theme: stored('theme', 'system'), layout: stored('layout', 'list'), recent: new Map(stored('recent', [])), views: restoreViews(stored('views.v1', [])) };
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const setTheme = () => { document.documentElement.dataset.theme = prefs.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : prefs.theme; };
setTheme(); systemTheme.addEventListener('change', setTheme);
const clearFilters = () => ({ category: '', tags: [], flags: [], type: '' });
const S = { registry: [], cache: new Map(), id: null, page: 'home', facet: '', folder: '', filters: clearFilters(), selected: new Set(), anchor: null,
  markingLoading: false, markingErrors: new Map(), markMode: 'pending', review: false, reviewing: false, viewId: null, pane: true, tab: 'details', rail: true, items: [], byKey: new Map(), limit: 160, sort: 'name', direction: 'asc',
  edited: null, preview: null, previewToken: 0, loading: false, actionBusy: false, booting: true, error: '', notice: '',
  dup: null, dupToken: 0, registryToken: 0, changed: new Set(), pendingChanges: new Set(),
  query: '', scope: 'current', scopeIds: [], deep: false, content: false, searching: false, searchItems: [], searchErrors: [], searchToken: 0, searchCount: 0,
  api: null, access: new Map(), accessLoading: new Set() };
const vault = () => S.cache.get(S.id)?.vault || S.registry.find(v => v.id === S.id);
const snap = () => S.cache.get(S.id) || { assets: [], categories: [], tags: [], history: [] };
const getVault = id => S.cache.get(id)?.vault || S.registry.find(v => v.id === id);
const sourceName = id => getVault(id)?.name || '仓库';
const itemAt = key => S.byKey.get(key);
const selection = () => [...S.selected].map(itemAt).filter(Boolean);
const one = () => selection().length === 1 ? selection()[0] : null;
const selectedKey = a => a ? assetKey(a) : null;
const previewSignature = a => a && JSON.stringify([assetKey(a), a.path, a.kind, a.state, a.modified, a.size, a.identity]);
const isDirty = () => !!S.edited && S.edited.text !== S.edited.original;
const roots = () => S.registry.filter(v => !v.parent_id);
const configurationPage = () => ['home', 'settings', 'history'].includes(S.page);
const msg = error => typeof error === 'string' ? error : error?.message || '操作未完成，请重试。';
const extPath = item => absolute(getVault(item.vaultId)?.root, item.path ?? item.rel);
const knowsUnit = item => S.registry.some(v => v.parent_id === item.vaultId && v.unit_id === item.id);
const perVault = items => Map.groupBy(items, a => a.vaultId);
let catIndex, folders, flags, tags, markingItems = [], pendingMarks = 0;
const libraryPages = new Set(['all', 'physical', 'category', 'tags', 'flags', 'recent', 'duplicates', 'excluded', 'missing', 'history']);
const markChoices = [...defaultFlags, '已核对'];

const pages = {
  home: ['仓库', 'house'], marking: ['待标记', 'flag'], inbox: ['收件箱', 'inbox', '从磁盘发现的新资产。可直接预览、整理或入库。'],
  all: ['全部资产', 'layout-grid', '浏览并整理当前仓库中的所有在管资产。'], physical: ['物理目录', 'folder-tree', '按真实磁盘文件夹浏览。'],
  category: ['分类', 'layers', '主分类只改变逻辑归属，不会移动原文件。'], tags: ['标签', 'tag', '使用多个标签描述和查找同一份资产。'],
  flags: ['标记', 'flag', '标记用来记录关注状态，不影响分类或磁盘路径。'], recent: ['最近使用', 'clock', '显示在本机通过 vaulta 打开或预览过的资产。'],
  duplicates: ['重复文件', 'copy', '按文件内容识别完全重复的资产。每一份原文件都会保留。'],
  excluded: ['已排除', 'ban', '这些项目保留在磁盘上，但不参与常规浏览和搜索。'],
  missing: ['已缺失', 'triangle-alert', '磁盘上找不到这些资产。只有确认身份后才应关联到其他文件。'],
  history: ['操作历史', 'clock'], settings: ['设置', 'settings'], search: ['搜索结果', 'search', '按文件名、路径、分类、标签和标记查找。'],
};
const sortOptions = [['name', '名称'], ['modified', '修改日期'], ['created', '创建日期'], ['size', '大小'], ['type', '类型'], ['path', '路径']];
const typeOptions = [['', '所有类型'], ['file', '所有文件'], ['folder', '文件夹与整体单元'], ['image', '图像'], ['play', '视频'], ['volume-2', '音频'], ['file-text', '文档与其他文件']];
const scopeOptions = [['current', '当前仓库'], ['selected', '所选仓库'], ['all', '全部仓库']];
const supportedTextDocument = a => /\.(pdf|docx|pptx|xlsx)$/i.test(a?.name || '');
const themeOptions = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
const titlebarOptions = [['native', 'Windows 原生'], ['traffic-lights', 'macOS 红绿灯']];
const accessOptions = [['off', '关闭'], ['read', '只读'], ['write', '读取与整理']];

function toast(text, kind = 'ok', duration = 4200) {
  const node = document.createElement('div'); node.className = `va-toast ${kind}`;
  node.innerHTML = `${icon(kind === 'ok' ? 'circle-check' : kind === 'error' ? 'triangle-alert' : 'info', 19)}<span>${esc(text)}</span><button type="button" aria-label="关闭提示">${icon('x', 15)}</button>`;
  node.querySelector('button').onclick = () => node.remove(); const shelf = $('#toasts'); shelf.append(node);
  while (shelf.childElementCount > 1) shelf.firstElementChild.remove();
  setTimeout(() => node.remove(), duration);
}
function indexItems() {
  catIndex = makeCategoryIndex(snap().categories); folders = folderIndex(snap().assets);
  flags = unique([...defaultFlags, ...snap().assets.flatMap(a => a.flags)]).sort(collator.compare);
  tags = unique([...snap().tags, ...snap().assets.flatMap(a => a.tags)]).sort(collator.compare);
  markingItems = S.page === 'marking' ? S.registry.flatMap(v => S.cache.has(v.id) ? markingAssets(S.cache.get(v.id)) : []) : [];
  pendingMarks = 0;
  for (const v of S.registry) if (S.cache.has(v.id)) {
    // The cached snapshot is immutable as far as asset metadata is concerned.
    pendingMarks += markingCountsFor(S.cache.get(v.id));
  }
  S.items = configurationPage() ? [] : visibleAssets({ assets: snap().assets, folders, categories: catIndex, page: S.page, folder: S.folder, facet: S.page === 'marking' ? S.markMode : S.facet, markingItems, filters: S.filters,
    recent: prefs.recent, duplicates: S.dup?.map || new Map(), searchItems: S.searchItems, sort: S.page === 'recent' && S.sort === 'name' ? 'recent' : S.sort, direction: S.direction });
  S.byKey = new Map(S.items.map(item => [assetKey(item), item]));
  for (const key of S.selected) if (!S.byKey.has(key)) S.selected.delete(key);
}
function render({ keepScroll = true } = {}) {
  closeMenu(false);
  const prev = document.activeElement, searchFocused = prev?.id === 'query', cursor = searchFocused ? [prev.selectionStart, prev.selectionEnd] : null;
  const focusRegion = [chrome, rail, workspace, inspector].find(region => region.contains(prev));
  const focusAction = [prev?.dataset.act, prev?.dataset.value];
  const focusedSegment = prev?.matches('.c-seg__opt') ? [prev.closest('[data-gd-widget]')?.dataset.gdKey, prev.dataset.value] : null;
  const docsOpen = !!$('.agent-docs')?.open;
  const focusData = prev?.dataset.asset || prev?.dataset.assetCheck;
  const focusSelector = prev?.dataset.assetCheck ? '[data-asset-check]' : '[data-asset]';
  const scrolling = [$('#stage'), $('#rail-scroll'), $('#inspect-scroll')].map(e => e?.scrollTop || 0);
  indexItems();
  $('#app').classList.toggle('rail-hidden', !S.rail);
  renderChromeInto(); renderRailGrip(); redraw(rail, renderRail()); redraw(workspace, renderWorkspace()); renderInspector(); renderStatus();
  if (docsOpen && $('.agent-docs')) $('.agent-docs').open = true;
  if (S.batch?.dataset.location === `${S.id}:${S.page}`) { ($('#stage > .asset-intro') || $('#stage'))?.prepend(S.batch); mount(S.batch); }
  syncSelectAll();
  if (keepScroll) [$('#stage'), $('#rail-scroll'), $('#inspect-scroll')].forEach((e, i) => { if (e) e.scrollTop = scrolling[i]; });
  if (searchFocused) { const input = $('#query'); input?.focus({ preventScroll: true }); if (input && document.activeElement === input && cursor[0] != null) input.setSelectionRange(...cursor); }
  else if (focusData) [...document.querySelectorAll(focusSelector)].find(e => e.dataset.asset === focusData || e.dataset.assetCheck === focusData)?.focus({ preventScroll: true });
  else if (focusRegion && focusedSegment && !prev.isConnected) {
    const matching = [...focusRegion.querySelectorAll('[data-gd-widget=segmented]')].find(e => e.dataset.gdKey === focusedSegment[0]);
    const target = [...(matching?.querySelectorAll('.c-seg__opt') || [])].find(e => e.dataset.value === focusedSegment[1]);
    target?.focus({ preventScroll: true });
  } else if (focusRegion && focusAction[0] && !prev.isConnected) [...focusRegion.querySelectorAll('[data-act]')].find(e => e.dataset.act === focusAction[0] && e.dataset.value === focusAction[1])?.focus({ preventScroll: true });
}
// Preserve the live SearchField on results/scan redraws. Recreate it only when
// the host actually replaces the query; this also preserves an IME composition.
const capsule = (contents, className, size = 'auto') => widget('capsule', { size }, { className, fallback: contents, tag: 'div' });
function renderChromeInto() {
  if (!$('#search-form')) {
    const shell = `<div class="brand-slot">${capsule('<div id="rail-toggle"></div>', 'chrome-round', 'round')}<div class="brand" aria-label="vaulta"><img src="./assets/vaulta.png" alt=""><span>vaulta</span></div></div>
      <div class="chrome-main"><div class="vault-loc"></div>
      ${capsule('<form class="searchbar" id="search-form" role="search"><span id="query-slot"></span><kbd title="聚焦搜索">Ctrl K</kbd><div id="query-scope"></div></form>', 'search-glass')}
      ${capsule('<div class="chrome-actions"></div>', 'actions-glass')}</div>`;
    redraw(chrome, widget('toolbar', {}, { fallback: shell, tag: 'div', className: 'vaulta-toolbar' }));
    // Vaulta has a dedicated native or custom title strip; the search toolbar
    // is never a drag (or double-click-to-maximize) region.
    chrome.querySelector('.c-topbar')?.removeAttribute('data-tauri-drag-region');
  }
  redraw($('#rail-toggle'), ib(S.rail ? '隐藏侧栏' : '显示侧栏', 'toggle-rail', 'panel-left', { attrs: `aria-expanded="${S.rail}"` }));
  redraw($('.vault-loc'), vaultPicker());
  const old = $('#query'), disabled = !S.registry.length;
  if (!old || old.disabled !== disabled || (!composing && old.value !== S.query)) {
    redraw($('#query-slot'), widget('search-field', { id: 'query', value: S.query, placeholder: '搜索资产', label: '搜索资产 · Ctrl+K', width: 320, disabled }, {
      key: 'top-search', className: 'query-field', action: 'search-input', fallback: `<div class="c-field"><input id="query" class="c-field__input" type="search" aria-label="搜索资产" autocomplete="off" placeholder="搜索资产 · Ctrl+K" value="${esc(S.query)}" ${disabled ? 'disabled' : ''}></div>`
    }));
  }
  redraw($('#query-scope'), searchPicker({ disabled, compact: true }));
  redraw($('.chrome-actions'), `${ib('快捷指令 · Ctrl+Shift+P', 'command-palette', 'list-filter', { attrs: 'aria-keyshortcuts="Control+Shift+P" aria-haspopup="dialog"' })}${!configurationPage() ? ib(S.pane ? '关闭自动详情' : '启用自动详情', 'toggle-pane', 'panel-right', { attrs: `aria-pressed="${S.pane}"` }) : ''}`);
}
const railMin = 190, railDefault = 224, railMax = 340;
function railLimit() { return Math.min(railMax, Math.max(railMin, innerWidth - 620)); }
function effectiveRailWidth() { return Math.max(railMin, Math.min(railLimit(), Number.isInteger(prefs.railWidth) ? prefs.railWidth : railDefault)); }
function renderRailGrip() {
  $('#app').style.setProperty('--rail-preference', `${effectiveRailWidth()}px`);
  gripHost.hidden = !S.rail;
  const props = { min: railMin, max: railLimit(), value: effectiveRailWidth(), label: '调整侧栏宽度', controls: 'rail' };
  if (!gripHost.firstChild) redraw(gripHost, widget('split-grip', props, { tag: 'div', action: 'rail-resize' }));
  else updateWidget(gripHost.firstElementChild, { min: props.min, max: props.max, value: props.value });
}
let saveRailTimer;
function resizeRail(value) {
  const width = Number(value);
  if (!Number.isInteger(width)) return;
  prefs.railWidth = Math.max(railMin, Math.min(railLimit(), width));
  $('#app').style.setProperty('--rail-preference', `${prefs.railWidth}px`);
  clearTimeout(saveRailTimer);
  // Do not write to disk on every pointermove; the selected width is a UI preference.
  saveRailTimer = setTimeout(() => persist('rail-width', prefs.railWidth), 160);
}
window.addEventListener('resize', () => { if (gripHost.firstElementChild) renderRailGrip(); });
window.addEventListener('pagehide', () => { if (prefs.railWidth != null) persist('rail-width', prefs.railWidth); });
// Shared dropdown surface; filesystem context menus remain pointer-anchored native markup.
function popupWidget(label, glyph, items, fallback, className = 'c-btn--sm') {
  return widget('menu', { label, icon: glyph, className, items: items.map(({ label, icon, name, value, ...attrs }) => ({
    id: JSON.stringify([name, value ?? null]), label, icon, ...attrs,
  })) }, { action: 'popup-choice', fallback });
}
function vaultPicker() {
  const current = vault(), iconName = current?.parent_id ? 'layers' : 'hard-drive', label = current?.name || '本地工作区';
  const choices = unique([...roots().map(v => v.id), ...(current?.parent_id ? [current.parent_id, current.id] : []), ...S.registry.filter(v => v.parent_id === S.id).map(v => v.id)]).map(id => {
    const v = getVault(id); return { label: v.name, icon: v.parent_id ? 'layers' : 'hard-drive', name: 'switch', value: v.id, checked: v.id === S.id };
  });
  if (current) {
    choices.push({ label: '重命名当前仓库', icon: 'square-pen', name: 'rename-vault', value: current.id, separatorBefore: true });
    if (!current.parent_id) choices.push({ label: '移除当前仓库…', icon: 'ban', name: 'remove-vault', value: current.id, danger: true });
  }
  choices.push({ label: '新建仓库', icon: 'plus', name: 'new-vault', separatorBefore: choices.length > 0 }, { label: '添加现有文件夹', icon: 'folder-open', name: 'add-vault' });
  return popupWidget(label, iconName, choices, `<button type="button" ${act('vault-menu')} aria-haspopup="menu" class="vault-picker">${icon(iconName, 16)}<span class="ellipsis">${esc(label)}</span>${icon('chevron-down', 12)}</button>`);
}
function searchPicker({ disabled, compact } = {}) {
  const label = compact ? '范围' : '搜索范围';
  const fallback = `<button class="c-btn c-btn--sm" type="button" ${act('search-menu')} aria-label="搜索范围" aria-haspopup="menu" ${disabled ? 'disabled' : ''}>${icon('sliders', 14)}<span>${label}</span></button>`;
  if (disabled) return fallback;
  return popupWidget(label, 'sliders', [
    ...scopeOptions.map(([value, label]) => ({ label, name: 'scope', value, checked: S.scope === value })),
    { label: '包含整体单元内部', icon: 'layers', name: 'search-deep', separatorBefore: true, checked: S.deep },
    { label: '搜索文件内容（含文档）', icon: 'file-text', name: 'search-content', checked: S.content },
  ], fallback);
}
function navLink(page, label, symbol, value = page, options = {}) {
  const active = options.active ?? (!S.viewId && S.page === page && !S.facet && (page !== 'physical' || !S.folder));
  const action = options.action || 'nav';
  const fallback = `<button type="button" class="nav-link ${active ? 'active' : ''}" ${act(action, value)} ${active ? 'aria-current="page"' : ''} ${options.disabled ? 'disabled' : ''}>${icon(symbol, 17)}<span class="ellipsis">${esc(label)}</span>${options.count ? `<span class="nav-count">${esc(options.count)}</span>` : ''}</button>`;
  return widget('nav-item', { label, icon: symbol, selected: active, count: options.count || undefined, disabled: !!options.disabled }, { action, value, fallback, className: `side-nav-item ${options.style || ''}` });
}
function renderRail() {
  const hasVaults = !!S.registry.length;
  const inbox = snap().assets.filter(a => a.state === 'inbox').length;
  return `<nav class="rail-scroll c-nav" id="rail-scroll" aria-label="主要导航"><section class="rail-section lead"><div class="rail-label">浏览</div>
    ${navLink('home', '仓库', 'house')}${hasVaults ? navLink('all', '资产库', 'layout-grid', 'all', { active: libraryPages.has(S.page) }) : ''}</section>
    ${hasVaults ? `<section class="rail-section"><div class="rail-label">待办</div>${navLink('inbox', '收件箱', 'inbox', 'inbox', { count: inbox })}${navLink('marking', '待标记', 'flag', 'marking', { count: S.registry.every(v => S.cache.has(v.id) && !S.markingErrors.has(v.id)) ? pendingMarks : 0 })}</section>` : ''}</nav>
    <div class="rail-bottom">${navLink('settings', '设置', 'settings')}<div class="local-note">${icon('shield', 14)}<span>仅本机</span></div></div>`;
}
function renderHome() {
  const known = roots();
  return `<div class="home"><section class="welcome" aria-labelledby="welcome-title">
    <div class="welcome-copy"><div class="eyebrow"><span class="signal"></span> 个人数字资产仓库</div><h1 id="welcome-title">让你的文件，<br>井井有条<span>。</span></h1>
    <p>把本地文件夹变成可搜索、可整理的仓库。<br>用分类和标签建立秩序，原文件留在原处。</p>
    <div class="welcome-actions">${button('新建仓库', 'new-vault', { glyph: 'plus', style: 'c-btn--primary', size: 'lg' })}${button('添加现有文件夹', 'add-vault', { glyph: 'folder-open', style: 'secondary', size: 'lg' })}</div></div>
    <img class="hero-art" src="./assets/workspace.svg" alt="" draggable="false">
    </section>
    <section class="home-section"><header><div><h2>我的仓库</h2><p>在此打开你的本地资产空间。</p></div>${known.length ? ib('添加或新建仓库', 'new-menu', 'plus', { style: 'soft', attrs: 'aria-haspopup="menu"' }) : ''}</header>
    ${known.length ? `<div class="vault-cards">${known.map(v => `<div class="vault-card">${widget('nav-card', { title: v.name, desc: v.root, icon: 'hard-drive' }, { action: 'switch', value: v.id, fallback: `<button type="button" ${act('switch', v.id)}>${esc(v.name)}</button>`, className: 'vault-card-main', tag: 'div' })}${ib('管理仓库', 'manage-vault', 'more', { value: v.id })}</div>`).join('')}</div>` : `<div class="home-empty"><span class="home-vault-icon">${icon('hard-drive', 21)}</span><div><strong>还没有仓库</strong><p>新建一个仓库，或添加包含现有文件的文件夹。</p></div></div>`}</section>
    <section class="principles" aria-label="仓库工作方式">
      ${[['folder-tree', '真实目录', '文件留在磁盘上，仍可用资源管理器访问。'], ['tag', '灵活整理', '用分类、标签和标记管理同一份文件。'], ['shield', '本地优先', '无需账号，管理信息和文件都留在本机。']].map(([glyph, title, text]) => `<div><span class="principle-icon">${icon(glyph, 20)}</span><section><h3>${title}</h3><p>${text}</p></section></div>`).join('')}
    </section></div>`;
}
function renderStatus() {
  const active = vault();
  let left = S.booting ? ['loader', '正在连接'] : !connected() ? ['info', '未连接桌面端'] : S.error ? ['triangle-alert', '同步未完成'] : S.loading ? ['loader', '正在读取仓库'] : ['circle-check', active ? '本地仓库' : '工作区就绪'];
  if (active?.status && active.status !== 'ready' && !S.loading && !S.error) left = ['triangle-alert', `${active.name} · ${statusLabel(active.status)}`];
  const statusFields = `<span class="status-left ${left[0] === 'circle-check' ? 'ready' : ''}">${icon(left[0], 14)}<span class="ellipsis">${esc(left[1])}</span></span>
    <span class="status-middle ellipsis" title="${esc(active?.root || '')}">${esc(active?.root || '文件与数据存储在本机')}</span><span data-glass-slot="end" class="status-right">${configurationPage() ? `${roots().length} 个仓库` : `${S.items.length} 个项目${S.selected.size ? ` · 已选 ${S.selected.size}` : ''}`}</span>`;
  redraw(status, widget('status-bar', {}, { tag: 'div', fallback: statusFields }));
}
function statusLabel(value) { return ({ ready: '就绪', partial: '扫描不完整', unavailable: '目录不可用' })[value] || value; }
function savedViews(id = S.id) { return prefs.views.filter(v => v.vaultId === id); }
function canSaveView() { return !!S.id && viewPages.has(S.page) && !S.review && !S.loading && !S.error; }
function savedPicker() {
  const saved = savedViews();
  return saved.length ? popupWidget('视图', 'star', saved.map(v => ({ label: v.name, name: 'open-view', value: v.id, checked: v.id === S.viewId })),
    menuFallback('视图', 'saved-menu', 'star')) : '';
}
function storeViews() { persist('views.v1', prefs.views); }
function saveView(existing = null) {
  if (!existing && !canSaveView()) return;
  if (!existing && prefs.views.length >= 40) return toast('最多保存 40 个视图，请先移除不常用的视图。', 'warn');
  const folderNode = S.page === 'physical' && S.folder ? folders.nodes.get(pathKey(S.folder)) : null;
  if (!existing && S.page === 'physical' && S.folder && !folderNode) return toast('找不到此目录，无法保存。', 'warn');
  const rule = existing || {
    id: crypto.randomUUID(), vaultId: S.id, page: S.page, facet: S.facet, folder: S.folder, folderId: folderNode?.id || '',
    sort: S.sort, direction: S.direction, filters: structuredClone(S.filters),
  };
  const title = pages[S.page]?.[0] || '资产';
  const suggested = existing?.name || (S.folder ? basename(S.folder) : `${title}${filterCount() ? ' · 已筛选' : ''}`);
  showDialog({ title: existing ? '重命名视图' : '保存此视图', symbol: 'star', submit: existing ? '重命名' : '保存视图',
    text: existing ? '更改名称不会改变视图规则。' : '记住此仓库、位置、筛选和排序。视图随仓库内容更新，不复制文件。',
    body: labeled('视图名称', field(suggested, 'name', { required: true, max: 48, placeholder: '例如：待整理的设计稿' })),
    onSubmit: data => {
      const name = String(data.get('name') || '').trim();
      if (!name) throw new Error('请输入视图名称。');
      if (savedViews(rule.vaultId).some(v => v.id !== rule.id && v.name === name)) throw new Error('此仓库中已有同名视图。');
      prefs.views = [...prefs.views.filter(v => v.id !== rule.id), { ...rule, name }];
      storeViews();
      if (!existing && S.id === rule.vaultId) S.viewId = rule.id;
      render(); toast(existing ? '已重命名视图' : '已保存到侧栏');
    } });
}
function manageView(id) {
  const view = prefs.views.find(v => v.id === id);
  if (!view) return;
  showDialog({ title: view.name, text: '视图只保存浏览规则，移除视图不会修改任何资产。', symbol: 'star', submit: '完成',
    body: `<div class="view-dialog-tools">${button('重命名', 'rename-view', { value: id, glyph: 'square-pen', style: 'secondary' })}${button('移除视图', 'remove-view', { value: id, glyph: 'x', style: 'secondary' })}</div>` });
}
async function openView(id) {
  const view = prefs.views.find(v => v.id === id);
  if (!view || !getVault(view.vaultId)) return;
  if (view.vaultId !== S.id) await switchVault(view.vaultId);
  if (S.id !== view.vaultId || S.error) return;
  let folder = view.folder;
  if (view.page === 'physical' && folder) {
    const dir = view.folderId ? [...folders.nodes.values()].find(a => a.id === view.folderId && a.kind !== 'unit') : folders.nodes.get(pathKey(folder));
    if (!dir || dir.kind === 'unit') return toast('视图的目录不再可用；它可能已移除或改为整体单元。', 'warn');
    folder = dir.rel;
  }
  if ((view.page === 'category' && view.facet && !catIndex.map.has(view.facet)) ||
    (view.filters.category && view.filters.category !== '!none' && !catIndex.map.has(view.filters.category))) {
    return toast('视图所用的分类已删除。请调整筛选后重新保存。', 'warn');
  }
  if (sortOptions.some(([key]) => key === view.sort)) S.sort = view.sort;
  S.direction = view.direction;
  nav(view.page, { folder, facet: view.facet, filters: view.filters, viewId: view.id });
}

const reviewItems = () => S.items.filter(a => !a.synthetic && a.state === 'inbox');
function renderReview() {
  if (!S.review) return '';
  const items = reviewItems(), index = items.findIndex(a => assetKey(a) === selectedKey(one()));
  const item = items[index], empty = !items.length;
  const content = `<div class="review-top"><div>${icon('square-check', 16)}<strong>逐项处理</strong><span>${empty ? '当前视图没有待处理项目' : `${items.length} 项待处理${index >= 0 ? ` · 第 ${index + 1} 项` : ''}`}</span></div>${ib('结束逐项处理', 'review-stop', 'x')}</div>
    ${item ? `<p class="ellipsis" title="${esc(item.rel || item.name)}">${esc(item.name)}</p>` : ''}
    ${empty ? '' : `<div class="review-tools">${button('上一个', 'review-prev', { glyph: 'chevron-left', style: 'secondary', disabled: S.reviewing || items.length < 2 })}${button('跳过 / 下一个', 'review-next', { glyph: 'chevron-right', style: 'secondary', disabled: S.reviewing || (items.length < 2 && !!item) })}${button('整理后入库…', 'review-organize', { glyph: 'tag', style: 'secondary', disabled: S.reviewing || !item })}${button('直接入库', 'review-file', { glyph: 'check', style: 'c-btn--primary', disabled: S.reviewing || !item })}</div>`}
    <small>${S.reviewing ? '正在更新索引…' : '入库仅更新管理状态，不移动文件。跳过不会修改资产。'}</small>`;
  return widget('card', { className: 'review-card' }, { fallback: content, className: 'review-band', attrs: 'role=region aria-label="收件箱逐项处理"', tag: 'section' });
}
function updateReview() {
  const node = $('.review-band');
  if (node) { unmount(node); node.outerHTML = renderReview(); if ($('.review-band')) mount($('.review-band')); }
}
function selectForReview(item) {
  if (!item) { clearAndSync(); return; }
  const key = assetKey(item), i = S.items.indexOf(item);
  S.pane = true;
  if (i >= S.limit) { S.limit = Math.ceil((i + 1) / 160) * 160; render(); }
  previewOne(item);
  [...workspace.querySelectorAll('[data-asset]')].find(node => node.dataset.asset === key)?.scrollIntoView({ block: 'nearest' });
}
function startReview() {
  if (S.page !== 'inbox' || !reviewItems().length) return;
  const chosen = one();
  S.review = {}; S.viewId = null; render();
  selectForReview(reviewItems().find(a => assetKey(a) === selectedKey(chosen)) || reviewItems()[0]);
  ($('.review-band [data-act="review-next"]:not(:disabled)') || $('.review-band [data-act="review-stop"]'))?.focus({ preventScroll: true });
}
const reviewFocusTarget = () => $('.review-band [data-act="review-file"]:not(:disabled)') || $('.review-band [data-act="review-stop"]');
function focusReview() { reviewFocusTarget()?.focus({ preventScroll: true }); }
function stepReview(offset) {
  if (!S.review || S.reviewing) return;
  const items = reviewItems(), i = items.findIndex(a => assetKey(a) === selectedKey(one()));
  if (items.length) selectForReview(items[i < 0 ? 0 : (i + offset + items.length) % items.length]);
  focusReview();
}
async function reviewFile(patch = {}) {
  const item = one(), queue = reviewItems(), index = queue.findIndex(a => assetKey(a) === selectedKey(item));
  if (index < 0 || !S.review || S.reviewing) return;
  const review = S.review;
  S.reviewing = true; updateReview();
  try { await batchOrganize([item], { ...patch, state: 'filed' }, '已入库'); }
  finally { S.reviewing = false; updateReview(); }
  if (S.review === review) {
    const remaining = reviewItems();
    if (remaining.some(a => a.id === item.id && a.vaultId === item.vaultId)) { toast('入库已提交，但当前列表尚未同步，请刷新后核对。', 'warn'); return; }
    selectForReview(remaining[index] || remaining[0]);
    if (modal.open) modalFocus = reviewFocusTarget(); else focusReview();
  }
}

const commandDialog = $('#commands');
let commandFocus, commandResults = [], commandIndex = 0;
function commandsForContext() {
  const current = one();
  const cmd = (label, glyph, action, value, group = '工作区', hint = '', keywords = '') => ({ label, glyph, action, value, group, hint, keywords });
  return [
    ...(S.registry.length ? [cmd('打开待标记', 'flag', 'nav', 'marking', '待办', '查看所有仓库中还没有标记的资产')] : []),
    ...(vault() ? [cmd('打开收件箱', 'inbox', 'nav', 'inbox', '浏览', '', 'inbox'), cmd('浏览物理目录', 'folder-tree', 'nav', 'physical', '浏览', '', 'folder'), cmd('浏览全部资产', 'layout-grid', 'nav', 'all', '浏览'), cmd('最近使用', 'clock', 'nav', 'recent', '浏览'),
      cmd('查找重复文件', 'copy', 'nav', 'duplicates', '整理'), cmd('扫描当前仓库', 'refresh-cw', 'rescan', null, '整理', 'F5', 'scan'), cmd('查看操作历史', 'clock', 'nav', 'history', '整理')] : []),
    ...(S.page === 'inbox' && S.items.length ? [cmd('逐项处理收件箱', 'square-check', 'review-start', null, '整理', '依次预览、整理和入库', 'inbox review')] : []),
    ...(canSaveView() ? [cmd('筛选当前资产', 'list-filter', 'filters', null, '整理'), cmd('保存此视图', 'star', 'save-view', null, '整理', '保存位置、筛选和排序')] : []),
    ...(current && !current.synthetic && current.state !== 'missing' ? [cmd('预览选中资产', 'eye', 'preview-one', assetKey(current), '选中资产', 'Space'), cmd('复制选中资产的路径', 'copy', 'copy-value', extPath(current), '选中资产')] : []),
    cmd('设置', 'settings', 'nav', 'settings', '工作区', '', 'settings preference'), cmd('返回首页', 'house', 'nav', 'home', '工作区', '', 'home'),
    cmd('添加现有文件夹', 'folder-open', 'add-vault', null, '仓库', '', 'add folder'), cmd('新建仓库', 'plus', 'new-vault', null, '仓库', '', 'new vault'),
    ...prefs.views.filter(v => getVault(v.vaultId)).map(v => cmd(v.name, 'star', 'open-view', v.id, '已保存视图', sourceName(v.vaultId))),
    ...S.registry.map(v => cmd(v.name, v.parent_id ? 'layers' : 'hard-drive', 'switch', v.id, '切换仓库', v.parent_id ? '整体单元' : '')),
  ];
}
function showCommands() {
  if (modal.open || commandDialog.open) return;
  closeMenu(); commandFocus = document.activeElement;
  redraw(commandDialog, `<header><h2 id="commands-title">快捷指令</h2>${ib('关闭快捷指令', 'close-commands', 'x')}</header><div class="command-search">${widget('search-field', { id: 'command-query', label: '查找指令', placeholder: '查找操作、仓库或视图…', width: 500 }, { action: 'command-query', fallback: '<div class="c-field"><input class="c-field__input" id="command-query" aria-label="查找指令" placeholder="查找操作、仓库或视图…"></div>' })}</div><div id="command-results" role="listbox" aria-label="可用指令"></div><p class="command-hint"><kbd>↑ ↓</kbd> 选择 <kbd>Enter</kbd> 执行 <kbd>Esc</kbd> 关闭</p>`);
  const input = $('#command-query'); input.setAttribute('role', 'combobox'); input.setAttribute('aria-controls', 'command-results'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-autocomplete', 'list');
  commandDialog.showModal(); filterCommands(''); input.focus();
}
function filterCommands(value) {
  if (!commandDialog.open) return;
  commandResults = matchCommands(commandsForContext(), value); commandIndex = 0;
  $('#command-results').innerHTML = commandResults.length ? commandResults.map((c, i) => `<div id="command-option-${i}" class="command-option" ${act('run-command', i)} role="option" aria-selected="false">${icon(c.glyph, 17)}<span><strong>${esc(c.label)}</strong>${c.hint ? `<small>${esc(c.hint)}</small>` : ''}</span><small>${esc(c.group)}</small></div>`).join('') : '<p class="command-empty">没有匹配的指令，试试“收件箱”或“设置”。</p>';
  highlightCommand();
}
function highlightCommand() {
  const input = $('#command-query');
  $('#command-results').querySelectorAll('[role="option"]').forEach((node, i) => {
    node.setAttribute('aria-selected', String(i === commandIndex));
    if (i === commandIndex) { input.setAttribute('aria-activedescendant', node.id); node.scrollIntoView({ block: 'nearest' }); }
  });
  if (!commandResults.length) input.removeAttribute('aria-activedescendant');
}
function closeCommands() {
  if (!commandDialog.open) return;
  commandDialog.close(); commandComposing = false; redraw(commandDialog, '');
  if (commandFocus?.isConnected) commandFocus.focus({ preventScroll: true });
}
commandDialog.addEventListener('cancel', event => { event.preventDefault(); closeCommands(); });
commandDialog.addEventListener('keydown', event => {
  if (event.isComposing || event.keyCode === 229 || document.activeElement?.id !== 'command-query') return;
  if (event.key === 'Escape') { event.preventDefault(); closeCommands(); return; }
  if (!commandResults.length) return;
  if (['ArrowDown','ArrowUp'].includes(event.key)) {
    event.preventDefault(); commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + commandResults.length) % commandResults.length; highlightCommand();
  } else if (event.key === 'Enter') { event.preventDefault(); perform('run-command', commandIndex); }
}, true);

function folderBreadcrumb() {
  const pieces = splitPath(S.folder);
  return `<nav class="c-crumbs breadcrumbs" aria-label="物理路径"><button ${act('folder', '')}>${icon('hard-drive', 15)}<span>${esc(vault()?.name || '根目录')}</span></button>${pieces.map((name, i) => `${icon('chevron-right', 12)}<button ${act('folder', pieces.slice(0, i + 1).join('/'))} ${i === pieces.length - 1 ? 'aria-current="page"' : ''}>${esc(name)}</button>`).join('')}</nav>`;
}
const menuFallback = (label, name, glyph) => `<button class="c-btn c-btn--sm" type="button" ${act(name)} aria-haspopup="menu">${icon(glyph, 14)}<span>${esc(label)}</span></button>`;
const browseModes = [['all', '全部'], ['category', '主分类'], ['tags', '标签'], ['physical', '磁盘目录']];
const utilityPages = ['recent', 'duplicates', 'missing', 'excluded', 'history'];
function libraryItems() {
  return [...utilityPages.map(id => ({ label: pages[id][0], icon: pages[id][1], name: 'nav', value: id, checked: S.page === id })),
    { label: '扫描当前仓库', icon: 'refresh-cw', name: 'rescan', disabled: S.loading, separatorBefore: true }];
}
function libraryBar() {
  if (!libraryPages.has(S.page) || !S.id) return '';
  return `<div class="library-bar">${segmented('资产库浏览方式', browseModes, browseModes.some(([id]) => S.page === id) ? S.page : '', 'library-mode', 'library-segments')}
    <div class="library-tools">${savedPicker()}${popupWidget('仓库工具', 'more', libraryItems(), menuFallback('仓库工具', 'library-menu', 'more'))}</div></div>`;
}
function facetsMarkup() {
  if (S.page === 'category') {
    const trail = ancestry(S.facet, catIndex);
    const options = [{ label: '全部分类', name: 'category', value: '', checked: !S.facet }, ...categoryOptions(catIndex).map(c => ({ label: c.label, name: 'category', value: c.id, checked: c.id === S.facet }))];
    return `<div class="facet-row">${popupWidget('选择主分类', 'layers', options, menuFallback('选择主分类', 'category-select-menu', 'layers'))}${trail.length > 1 ? `<span class="facet-path" title="${esc(trail.map(c => c.name).join(' / '))}">${esc(trail.map(c => c.name).join(' / '))}</span>` : ''}</div>`;
  }
  const list = S.page === 'tags' ? tags : S.page === 'flags' ? flags : null;
  if (!list?.length) return '';
  const options = ['', ...list].map(tag => ({ label: tag || `全部${pages[S.page][0]}`, name: 'facet', value: tag, checked: S.facet === tag }));
  return `<div class="facet-row">${popupWidget('选择' + pages[S.page][0], pages[S.page][1], options, menuFallback('选择' + pages[S.page][0], 'label-select-menu', pages[S.page][1]))}${S.facet ? pill(S.facet, 'accent') : ''}</div>`;
}
function markingControls() {
  if (S.page !== 'marking') return '';
  const failures = [...S.markingErrors].filter(([id]) => getVault(id));
  return `<div class="marking-controls">${segmented('标记状态', [['pending', '待标记'], ['marked', '已标记']], S.markMode, 'mark-mode', 'mark-segments')}
    <span class="mark-counts" aria-live="polite">${S.markingLoading ? '正在读取仓库…' : `${pendingMarks} 待标记 · ${markingItems.length - pendingMarks} 已标记`}</span></div>
    ${failures.length ? `<details class="search-fail"><summary>${failures.length} 个仓库未能读取，列表和计数可能不完整</summary><ul>${failures.map(([id, error]) => `<li>${esc(sourceName(id))}：${esc(error)}</li>`).join('')}</ul>${button('重试读取', 'mark-refresh', { style: 'secondary' })}</details>` : ''}`;
}
function sortMenu() {
  const items = sortOptions.map(([id, label]) => ({ id, label, checked: id === S.sort }));
  items.push({ id: 'asc', label: '升序', icon: 'chevron-up', separatorBefore: true, checked: S.direction === 'asc' },
    { id: 'desc', label: '降序', icon: 'chevron-down', checked: S.direction === 'desc' });
  return widget('menu', { label: '排序', icon: 'sort', className: 'c-btn--sm', items }, { action: 'sort-choice',
    fallback: `<button type="button" class="c-btn c-btn--sm" ${act('sort-menu')} aria-haspopup="menu">排序</button>` });
}
function renderWorkspace() {
  if (S.page === 'home') return `<div class="stage" id="stage">${S.error ? errorStrip() : ''}${renderHome()}</div>`;
  if (S.page === 'settings') return `<div class="stage" id="stage">${renderSettings()}</div>`;
  if (S.page === 'history') return `<div class="stage" id="stage">${renderHistory()}</div>`;
  const [baseTitle, glyph, desc] = pages[S.page] || pages.all;
  const marking = S.page === 'marking';
  const title = marking ? '标记工作台' : S.page === 'physical' ? basename(S.folder) || baseTitle : S.page === 'category' ? catIndex.map.get(S.facet)?.name || baseTitle : baseTitle;
  const primary = S.page === 'physical' ? button('新建文件夹', 'create-folder', { glyph: 'folder-plus', style: 'secondary' })
    : S.page === 'category' ? button('新建分类', 'category-new', { glyph: 'plus', style: 'secondary' })
    : S.page === 'tags' ? button('新建标签', 'tag-new', { glyph: 'plus', style: 'secondary' })
    : S.page === 'duplicates' ? button(S.dup?.loading ? '正在比对' : '查找重复', 'duplicates-refresh', { glyph: 'refresh-cw', style: 'secondary', disabled: S.dup?.loading })
    : '';
  const extra = S.page === 'category' && S.facet ? ib('管理分类', 'category-menu', 'more', { attrs: 'aria-haspopup="menu"' })
    : S.page === 'tags' && S.facet ? ib('管理标签', 'tag-menu', 'more', { attrs: 'aria-haspopup="menu"' })
    : '';
  const count = filterCount();
  return `<div class="stage asset-stage" id="stage">
    <div class="asset-intro">${errorStrip()}${S.notice ? `<div class="notice-row">${inlineNotice('warning', S.notice)}${ib('关闭提醒', 'hide-warning', 'x')}</div>` : ''}
    ${libraryBar()}<header class="page-heading asset-heading">${S.page === 'physical' ? folderBreadcrumb() : `<div class="page-context">${icon(glyph, 14)}<span>${esc(marking ? '全部仓库' : S.page === 'search' ? '全局查找' : vault()?.name || '仓库')}</span>${vault()?.parent_id && !marking && S.page !== 'search' ? `<button ${act('switch', vault().parent_id)}>返回上级仓库 ${icon('arrow-up-right', 12)}</button>` : ''}</div>`}
      <div class="heading-row"><div><h1>${esc(savedViews().find(v => v.id === S.viewId)?.name || title)}</h1><p>${esc(S.page === 'search' && S.query.trim() ? `「${S.query.trim()}」 · ${searchScopeLabel()}${S.content ? ' · 含本地文本与可提取的文档内容' : ''}` : marking ? '集中处理所有仓库的标记。标记记录关注状态，不会入库、改标签或移动文件。' : desc)}</p></div><div class="heading-actions">${extra}${S.page === 'inbox' && S.items.length && !S.review ? button('逐项处理', 'review-start', { glyph: 'square-check', style: 'tinted' }) : ''}${canSaveView() ? ib(S.viewId ? '管理已保存视图' : '保存此视图', S.viewId ? 'manage-view' : 'save-view', 'star', { style: S.viewId ? 'soft' : '' }) : ''}${primary}</div></div>
    </header>
    ${markingControls()}${facetsMarkup()}${renderReview()}</div>
    <div class="asset-toolbar"><div class="asset-summary"><strong>${S.items.length.toLocaleString('zh-CN')}</strong> 个项目${S.page === 'duplicates' && S.dup?.groups?.length ? ` · ${S.dup.groups.length} 组重复` : ''}</div><div class="asset-tools">${S.page === 'search' || marking ? '' : button(count ? `筛选 · ${count}` : '筛选', 'filters', { glyph: 'list-filter', style: count ? 'tinted' : 'secondary' })}${sortMenu()}${segmented('资产视图', [['list', '列表', 'list'], ['grid', '网格', 'layout-grid']], prefs.layout, 'layout', 'view-switch')}</div></div>
    ${renderFilterChips()}${renderAssets()}
  </div>${renderBulk()}`;
}
function searchScopeLabel() { return scopeOptions.find(([id]) => id === S.scope)?.[1] || '当前仓库'; }
function filterCount() { return Number(!!S.filters.category) + S.filters.tags.length + S.filters.flags.length + Number(!!S.filters.type); }
function renderFilterChips() {
  if (S.page === 'search' || !filterCount()) return '';
  const f = S.filters;
  const active = [
    ...(f.category ? [['category', f.category, f.category === '!none' ? '未分类' : catIndex.map.get(f.category)?.name || '分类']] : []),
    ...f.tags.map(t => ['tags', t, t]), ...f.flags.map(t => ['flags', t, t]),
    ...(f.type ? [['type', f.type, typeOptions.find(([id]) => id === f.type)?.[1] || f.type]] : []),
  ];
  return `<div class="applied-filters" aria-label="已应用筛选">${active.map(([key, value, text]) => `<button type="button" class="pill accent filter-chip" ${act('remove-filter', JSON.stringify([key, value]))} aria-label="移除筛选：${esc(text)}">${esc(text)}${icon('x', 12)}</button>`).join('')}<button type="button" ${act('clear-filters')}>清除筛选</button></div>`;

}
function errorStrip() { return S.error ? `<div class="notice-row">${inlineNotice('danger', S.error)}${button('重试', 'retry', { style: 'secondary' })}</div>` : ''; }
function renderBulk() {
  const picked = selection(), real = picked.filter(a => !a.synthetic);
  const marking = S.page === 'marking';
  const excluded = real.length && real.every(a => a.state === 'excluded'), missing = real.some(a => a.state === 'missing');
  const selectables = S.items.filter(a => !a.synthetic), all = selectables.length && real.length === selectables.length;
  return `<div class="bulk-band" id="bulk" ${real.length ? '' : 'hidden'}><div><input type="checkbox" data-select-all aria-label="选择全部结果" ${all ? 'checked' : ''}><strong>已选 ${real.length} 项</strong>${ib('清除选择', 'clear-selection', 'x')}</div><div class="bulk-actions">
    ${marking ? button('批量添加标记', 'mark-selected', { glyph: 'flag', style: 'tinted' }) : missing ? '' : excluded ? button('重新纳入', 'restore', { glyph: 'undo' }) : `${button('整理', 'organize', { glyph: 'tag' })}${real.some(a => a.state === 'inbox') ? button('入库', 'file-in', { glyph: 'check' }) : ''}${button('移动', 'move', { glyph: 'move' })}`}${marking ? '' : ib('更多批量操作', 'bulk-menu', 'more', { attrs: 'aria-haspopup="menu"' })}</div></div>`;
}
function renderAssets() {
  if (S.page === 'marking' && S.markingLoading && !S.items.length) return blank('loader', '正在汇总标记', '正在读取各仓库的索引。');
  if (S.loading && !S.cache.has(S.id) && !['search', 'marking'].includes(S.page)) return blank('loader', '正在读取仓库', '正在从磁盘索引加载资产。');
  if (S.searching && !S.searchItems.length && S.page === 'search') return blank('search', '正在查找资产', '根据当前范围读取仓库。');
  if (S.page === 'search' && !S.query.trim()) return blank('search', '开始搜索', '输入名称、类型、路径、分类或标签。');
  const partial = S.page === 'search' && S.searchErrors.length ? `<details class="search-fail"><summary>${S.searchErrors.length} 项搜索未完成，部分结果可能缺失</summary><ul>${S.searchErrors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : '';
  if (!S.items.length) {
    const empties = { marking: S.markingErrors.size ? ['当前没有已读取的结果', '部分仓库尚未读取，展开上方提醒查看。'] : S.markMode === 'marked' ? ['还没有已标记资产', '给资产添加标记后，就能在这里查阅。'] : ['没有待标记资产', '所有可见在管资产都已有标记。移除某项的最后一个标记，它会回到这里。'], inbox: ['收件箱是空的', '在仓库目录中添加文件，vaulta 会在这里显示新资产。'], all: ['还没有资产', '将文件放入仓库目录，然后扫描查看。'], physical: ['此文件夹为空', '你可以新建文件夹，或在资源管理器中添加文件。'], category: ['没有分类资产', '可以在资产详情中设置主分类。'], tags: ['没有带标签的资产', '可以在资产详情中添加标签。'], flags: ['没有带标记的资产', '可以在资产详情中设置标记。'], recent: ['还没有最近记录', '打开或预览资产后，它会显示在这里。'], duplicates: S.dup?.loading ? ['正在比对文件', '正在检查文件内容。'] : S.dup?.error ? ['未能检查重复文件', S.dup.error] : ['没有重复文件', '目前没有找到内容完全相同的文件。'], excluded: ['没有已排除的资产', '从仓库排除的项目将显示在这里。'], missing: ['没有已缺失的资产', '当前没有需要处理的丢失记录。'], search: ['没有匹配的资产', '试试更短的关键词，或调整搜索范围。'] };
    const [heading, hint] = filterCount() ? ['没有符合筛选条件的资产', '减少筛选条件以查看更多结果。'] : empties[S.page] || ['还没有项目', ''];
    return partial + blank(pages[S.page][1], heading, hint, filterCount() ? button('清除筛选', 'clear-filters', { style: 'secondary' }) : ['inbox', 'all'].includes(S.page) ? button('浏览物理目录', 'folder', { value: '', glyph: 'folder-open', style: 'secondary' }) : '');
  }
  const marking = S.page === 'marking', cross = S.page === 'search' || marking, chunk = S.items.slice(0, S.limit);
  const sortAria = key => S.sort === key ? `aria-sort="${S.direction === 'asc' ? 'ascending' : 'descending'}"` : '';
  const sortBtn = (key, text) => `<button type="button" class="c-table__sort" ${act('sort', key)}>${esc(text)}${S.sort === key ? icon(S.direction === 'asc' ? 'chevron-up' : 'chevron-down', 13) : ''}</button>`;
  const groupTitle = (item, index) => {
    if (S.page !== 'duplicates') return '';
    const group = S.dup.map.get(item.id);
    return group !== S.dup.map.get(chunk[index - 1]?.id) ? `重复组 ${group + 1} · ${S.dup.groups[group].length} 个文件` : '';
  };
  const main = prefs.layout === 'grid' ? `<div class="tiles" id="items">${chunk.map((a, i) => `${groupTitle(a, i) ? `<div class="group-title">${esc(groupTitle(a, i))}</div>` : ''}${assetCard(a, S.selected, cross, sourceName(a.vaultId), S.page === 'physical', marking)}`).join('')}</div>`
    : `<table class="asset-table c-table" id="items"><thead><tr><th class="col-check"><input type="checkbox" data-select-all aria-label="选择全部结果" ${S.items.some(a => !a.synthetic) && S.items.filter(a => !a.synthetic).every(a => S.selected.has(assetKey(a))) ? 'checked' : ''}></th><th ${sortAria('name')}>${sortBtn('name', '名称')}</th><th class="col-state">${marking ? '标记' : '入库状态'}</th><th class="col-size" ${sortAria('size')}>${sortBtn('size', '大小')}</th><th class="col-date" ${sortAria('modified')}>${sortBtn('modified', '修改日期')}</th><th class="col-more"></th></tr></thead><tbody>${chunk.map((a, i) => `${groupTitle(a, i) ? [6, 5, 4].map(n => `<tr class="group-row cols-${n}"><td colspan="${n}">${esc(groupTitle(a, i))}</td></tr>`).join('') : ''}${assetRow(a, S.selected, cross, sourceName(a.vaultId), marking)}`).join('')}</tbody></table>`;
  return partial + main + (S.items.length > S.limit ? `<div class="load-more">${button(`显示更多 · 剩余 ${S.items.length - S.limit} 项`, 'more-items', { style: 'secondary' })}</div>` : '');
}
function renderHistory() {
  return `${errorStrip()}<div class="utility">${libraryBar()}<header class="page-heading"><div class="page-context">${icon('clock', 15)} ${esc(vault()?.name || '仓库')}</div><div class="heading-row"><div><h1>操作历史</h1><p>查看仓库中的整理、同步和文件操作。</p></div>${button('撤销上一次操作', 'undo', { glyph: 'undo', style: 'secondary', disabled: !snap().history.length })}</div></header>
    ${snap().history.length ? `<div class="event-list">${lines([...snap().history].sort((a, b) => Number(b.time) - Number(a.time)))}</div>` : blank('clock', '暂无操作记录', '仓库产生变更后，可在这里查看记录。')}</div>`;
}
function renderSettings() {
  const v = vault(), access = S.access.get(v?.id), info = S.api;
  const setting = (symbol, title, help, controls) => `<div class="setting"><span class="setting-icon">${icon(symbol, 20)}</span><div><h3>${esc(title)}</h3><p>${esc(help)}</p></div><div class="setting-control">${controls}</div></div>`;
  return `${errorStrip()}<div class="utility settings"><header class="page-heading"><div class="page-context">${icon('settings', 14)} 工作区</div><h1>设置</h1><p>管理外观、仓库与本地工具访问。</p></header>
  <section class="settings-section"><h2>通用</h2>${setting('palette', '界面外观', '选择浅色、深色或跟随 Windows 系统设置。', themeSelect(themeOptions, prefs.theme))}${setting('app-window', '窗口标题栏', '切换后立即生效，下次打开 vaulta 时保持所选样式。', canUseWindowChrome() ? widget('select', { label: '窗口标题栏', width: 148, options: titlebarOptions.map(([value, label]) => ({ value, label })), value: getWindowChromeMode() }, { key: 'titlebar-mode', action: 'titlebar-mode', fallback: select('titlebarPref', titlebarOptions, getWindowChromeMode(), 'aria-label="窗口标题栏" data-setting="titlebar"') }) : pill('仅桌面应用'))}${setting('layout-grid', '默认资产视图', '在列表和网格之间切换。', select('layoutPref', [['list','列表'],['grid','网格']], prefs.layout, 'aria-label="默认资产视图" data-setting="layout"'))}</section>
  <section class="settings-section"><h2>当前仓库</h2>${v ? `${setting(v.parent_id ? 'layers' : 'hard-drive', v.name, v.root, button('管理', 'manage-vault', { glyph: 'more', style: 'secondary', value: v.id }))}${setting('link', '磁盘分类视图', '以链接在磁盘展示逻辑分类，不复制或移动原文件。', button(v.view_enabled ? '已启用 · 配置' : '配置', 'view-config', { style: 'secondary' }))}${setting('refresh-cw', '重新扫描', '检查磁盘和索引的变化。', button('扫描仓库', 'rescan', { style: 'secondary', disabled: S.loading }))}` : `<p class="utility-empty">请先打开一个仓库。${button('前往仓库', 'nav', { value: 'home', style: 'secondary' })}</p>`}</section>
  <section class="settings-section"><h2>Agent CLI</h2>${setting('terminal', '外部工具访问', '按仓库授权；整体单元的权限独立设置。CLI 不可执行磁盘文件操作。', v && access ? select('access', accessOptions, access, 'aria-label="外部工具访问" data-setting="agent"') : v && S.accessLoading.has(v.id) ? pill('正在读取') : button('读取权限', 'load-access', { style: 'secondary', disabled: !v }))}
    ${access === 'write' ? '<div class="agent-note">外部工具可修改当前仓库的整理信息。你可随时将权限切回只读或关闭。</div>' : ''}
    <details class="agent-docs"><summary>命令与本地路径</summary><p>在终端中执行以下命令。<code>mutate</code> 从标准输入读取 JSON，需要「读取与整理」权限。</p><pre>vaulta-agent list\nvaulta-agent snapshot &lt;id&gt;\nvaulta-agent mutate &lt;id&gt;</pre>
      <dl>${v ? infoRow('当前仓库 ID', `<code>${esc(v.id)}</code>${ib('复制仓库 ID', 'copy-value', 'copy', { value: v.id })}`) : ''}
      ${info ? infoRow('可执行文件', `<code>${esc(info.executable)}</code>${ib('复制可执行文件路径', 'copy-value', 'copy', { value: info.executable })}`) + infoRow('数据库（勿直接编辑）', `<code>${esc(info.database)}</code>${ib('复制数据库路径', 'copy-value', 'copy', { value: info.database })}`) + (info.protocol != null ? infoRow('协议版本', esc(info.protocol)) : '') : ''}</dl></details>
  </section><div class="settings-footer"><img src="./assets/vaulta.png" alt=""><span>vaulta</span></div></div>`;
}
function renderInspector() {
  inspector.hidden = !S.pane || configurationPage() || !S.selected.size;
  if (inspector.hidden) { redraw(inspector, ''); return; }
  // Keep an unchanged preview DOM alive so watcher notifications don't restart audio/video.
  const current = one();
  const signature = current && S.tab === 'preview' ? previewSignature(current) : null;
  if (signature && inspector.dataset.previewSignature === signature && inspector.querySelector('.preview-pane')?.previewRecord === S.preview) return;
  inspector.dataset.previewSignature = signature || '';
  const picked = selection(), a = picked.length === 1 ? picked[0] : null;
  const hasTabs = a && !a.synthetic && a.state !== 'missing';
  redraw(inspector, `<header class="inspector-head"><div>${icon('panel-right', 17)}<strong>${picked.length > 1 ? '批量详情' : '资产详情'}</strong></div>${ib('隐藏详情面板', 'toggle-pane', 'x')}</header>
    ${hasTabs ? segmented('详情面板视图', [['details', '信息'], ['preview', '预览']], S.tab, 'inspect-tab', 'inspect-tabs') : ''}
    <div class="inspect-scroll" id="inspect-scroll">${
      a ? S.tab === 'preview' && hasTabs ? renderPreview(a) : renderAssetDetails(a)
      : picked.length ? `<div class="inspect-empty multi"><span>${icon('layers', 27)}</span><h3>${picked.length} 个项目</h3><p>可同时整理、移动或更改所选资产的状态。</p>${button('批量整理', 'organize', { glyph: 'tag', style: 'secondary', disabled: picked.some(item => item.synthetic || ['excluded', 'missing'].includes(item.state)) })}</div>`
      : `<div class="inspect-empty"><span>${icon('file-text', 27)}</span><h3>选择一个项目</h3><p>在这里查看资产信息、<br>管理分类或打开文件预览。</p></div>`}</div>`);
  const pane = inspector.querySelector('.preview-pane'); if (pane) pane.previewRecord = S.preview;
}
function renderAssetDetails(a) {
  const key = assetKey(a), disabled = a.synthetic || a.state === 'missing', live = !disabled && a.state !== 'excluded';
  const index = a.vaultId === S.id ? catIndex : makeCategoryIndex(S.cache.get(a.vaultId)?.categories || []);
  const category = ancestry(a.category_id, index).map(c => c.name).join(' / '), identity = typeof a.identity === 'string' ? a.identity : a.identity == null ? '' : JSON.stringify(a.identity);
  return `<div class="asset-profile">${visual(a, 'profile')}<h2 title="${esc(a.name)}">${esc(a.name)}</h2><div>${pill(assetType(a).name)}${a.synthetic ? '' : statePill(a)}</div></div>
    <div class="detail-tools">${disabled ? '' : button(isDir(a) ? a.kind === 'unit' ? '进入整体单元' : '打开文件夹' : '打开文件', 'open-asset', { value: key, glyph: 'external-link', style: 'secondary' })}${ib('更多资产操作', 'asset-menu', 'more', { value: key })}</div>
    ${a.state === 'missing' ? `<div class="detail-callout">${icon('triangle-alert', 16)}<span>找不到原文件，仅显示上次记录。</span>${button('核对并关联身份', 'recover-identity', { value: key, style: 'secondary' })}</div>` : ''}
    ${a.state === 'excluded' ? `<div class="detail-callout">${icon('ban', 16)}<span>文件仍在磁盘上。</span>${button('重新纳入', 'restore-one', { value: key, style: 'secondary' })}</div>` : ''}
    ${!a.synthetic ? `<section class="inspect-section"><header><h3>整理信息</h3>${ib('编辑整理信息', 'organize-one', 'square-pen', { value: key, disabled: !live })}</header><dl>
      ${infoRow('主分类', esc(category || '未分类'))}${infoRow('标签', a.tags.length ? a.tags.map(t => pill(t, 'accent')).join('') : '—')}${infoRow('标记', `${a.flags.length ? a.flags.map(t => pill(t, 'flag')).join('') : '<span class="muted">未标记</span>'}${live ? ib(a.flags.length ? '编辑标记' : '添加标记', 'mark-one', 'flag', { value: key }) : ''}`)}
    </dl></section>` : ''}
    <section class="inspect-section"><header><h3>文件信息</h3></header><dl>
      ${infoRow('仓库', esc(sourceName(a.vaultId)))}${infoRow('位置', `<span class="path-text" title="${esc(extPath(a))}">${esc(extPath(a))}</span>${ib('复制真实路径', 'copy-value', 'copy', { value: extPath(a) })}`)}${infoRow('大小', esc(isDir(a) ? '—' : formatBytes(a.size)))}${infoRow('创建时间', esc(formatDate(a.created, true)))}${infoRow('修改时间', esc(formatDate(a.modified, true)))}
      ${identity ? infoRow('文件身份', `<span class="path-text">${esc(identity)}</span>`) : ''}${a.kind === 'unit' ? infoRow('管理边界', '拥有独立的内部管理空间') : ''}
    </dl></section>`;
}
function safeMediaUrl(value, kind) {
  if (kind === 'image' && /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon|tiff)[;,]/i.test(value ?? '')) return value;
  if (kind === 'audio' && /^data:audio\/[\w.+-]+[;,]/i.test(value ?? '')) return value;
  if (kind === 'video' && /^data:video\/[\w.+-]+[;,]/i.test(value ?? '')) return value;
  return '';
}
function markdown(text) {
  const output = [], inline = str => esc(str).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  let fenced = false, code = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^```/.test(line)) {
      if (fenced) { output.push(`<pre>${esc(code.join('\n'))}</pre>`); code = []; }
      fenced = !fenced; continue;
    }
    if (fenced) { code.push(line); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/), li = line.match(/^\s*[-*+]\s+(.+)$/);
    output.push(h ? `<h${h[1].length + 1}>${inline(h[2])}</h${h[1].length + 1}>` : li ? `<p class="md-li">• ${inline(li[1])}</p>` : line ? `<p>${inline(line)}</p>` : '<br>');
  }
  if (code.length) output.push(`<pre>${esc(code.join('\n'))}</pre>`);
  return `<div class="markdown">${output.join('')}</div>`;
}
function renderPreview(a) {
  const key = assetKey(a), p = S.preview?.key === key ? S.preview : null;
  const extracted = supportedTextDocument(a) && p?.data?.kind === 'text';
  return `<div class="preview-pane"><div class="preview-heading">${visual(a)}<div><strong class="ellipsis" title="${esc(a.name)}">${esc(a.name)}</strong><small>${extracted ? '提取文本 · 只读' : esc(assetType(a).name)}</small></div>${p?.data?.kind === 'text' && !extracted ? ib('编辑文件', 'edit-text', 'square-pen', { disabled: p.data.revision == null || a.state === 'excluded' }) : ''}</div>${previewBody(a, p)}</div>`;
}
function previewBody(a, p) {
  if (p?.loading || !p) return `<div class="preview-message">${icon('loader', 23)}<p>正在载入预览…</p></div>`;
  const d = p.data, isMarkdown = /\.(md|markdown|mdown)$/i.test(a.name);
  if (p.error) return `<div class="preview-message">${icon('triangle-alert', 25)}<p>${esc(p.error)}</p>${button('重试', 'retry-preview', { style: 'secondary' })}</div>`;
  if (d?.kind === 'text') return `<div class="preview-content">${isMarkdown ? markdown(d.text ?? '') : `<pre>${esc(d.text ?? '')}</pre>`}</div>`;
  const url = safeMediaUrl(d?.data_url, d?.kind);
  if (url) {
    const src = esc(url);
    if (d.kind === 'image') return `<div class="media-preview"><img src="${src}" alt="${esc(a.name)}"></div>`;
    return `<div class="media-preview">${d.kind === 'video' ? `<video controls playsinline preload="metadata" src="${src}"></video>` : `<audio controls preload="metadata" src="${src}"></audio>`}</div>`;
  }
  return `<div class="preview-message">${icon(d?.kind === 'directory' ? 'folder-open' : 'eye', 26)}<p>${esc(supportedTextDocument(a) ? '无法提取文本：文件可能没有文本层、超出大小限制，或使用了尚不支持的文档结构。' : d?.message || (d?.kind === 'directory' ? '打开文件夹即可查看内部项目。' : '此格式暂不支持内置预览。'))}</p>${button(isDir(a) ? '打开文件夹' : '用系统应用打开', 'open-asset', { value: assetKey(a), glyph: 'external-link', style: 'secondary' })}</div>`;
}
let modalController, modalFocus;
function showDialog({ title, text = '', symbol = 'info', body = '', submit = '确定', cancel = '取消', danger = false, wide = false, onSubmit, onCancel }) {
  closeMenu(false);
  modalFocus = document.activeElement;
  modalController = { onSubmit, onCancel, active: false };
  modal.className = `dialog ${wide ? 'wide' : ''}`;
  redraw(modal, `<form class="dialog-form" id="dialog-form"><div class="dialog-head"><span class="dialog-icon ${danger ? 'danger' : ''}">${icon(symbol, 22)}</span><div><h2 id="dialog-title">${esc(title)}</h2>${text ? `<p>${esc(text)}</p>` : ''}</div>${ib('关闭窗口', 'close-dialog', 'x')}</div>
    <div class="dialog-body" ${body ? '' : 'hidden'}>${body}</div><p class="dialog-error" role="alert" hidden></p>
    <div class="dialog-actions"><button type="button" class="c-btn va-btn secondary" ${act('close-dialog')}>${esc(cancel)}</button><button type="submit" class="c-btn va-btn ${danger ? 'destructive' : 'c-btn--primary'}">${esc(submit)}</button></div></form>`);
  if (!modal.open) modal.showModal();
  modal.querySelector('[autofocus],input:not([type="checkbox"]):not([readonly]),textarea')?.focus();
}
function dialogError(error) { const node = modal.querySelector('.dialog-error'); if (node) { node.hidden = false; node.textContent = msg(error); } }
function closeDialog(force = false) {
  if (!modal.open || (!force && modalController?.active)) return false;
  if (!force && modalController?.onCancel && modalController.onCancel() === false) return false;
  modal.close(); redraw(modal, ''); modalController = null;
  if (modalFocus?.isConnected) modalFocus.focus({ preventScroll: true });
  return true;
}
modal.addEventListener('cancel', event => { event.preventDefault(); closeDialog(); });
modal.addEventListener('submit', async event => {
  if (event.target.id !== 'dialog-form') return;
  event.preventDefault(); const controller = modalController;
  if (!controller || controller.active) return;
  controller.active = true;
  const form = event.target, values = new FormData(form), submit = form.querySelector('button[type="submit"]'), text = submit.textContent;
  submit.disabled = true; submit.textContent = '正在处理…';
  const err = modal.querySelector('.dialog-error'); if (err) err.hidden = true;
  const editor = form.querySelector('#editor'); if (editor) editor.readOnly = true;
  try { const keepOpen = await controller.onSubmit?.(values, form); if (keepOpen !== false && controller === modalController) closeDialog(true); }
  catch (error) { if (controller === modalController) dialogError(error); else toast(msg(error), 'error'); }
  finally { controller.active = false; if (editor) editor.readOnly = false; if (submit.isConnected) { submit.disabled = false; submit.textContent = text; } }
});
function ask(title, text, opts = {}) {
  return new Promise(resolve => showDialog({ title, text, ...opts, onSubmit: () => { resolve(true); }, onCancel: () => { resolve(false); } }));
}
function filterDialog() {
  const f = S.filters;
  showDialog({ title: '筛选资产', text: '不同维度可组合；所选标签与标记须同时匹配。', symbol: 'list-filter', submit: '应用筛选',
    body: `${labeled('主分类', select('category', [['', '所有分类'], ['!none', '未分类'], ...categoryOptions(catIndex).map(c => [c.id, c.label])], f.category))}${labeled('类型', select('type', typeOptions, f.type))}
    ${checkFields('标签', 'tags', tags, f.tags)}${checkFields('标记', 'flags', flags, f.flags)}`,
    onSubmit: data => { S.viewId = null; S.filters = { category: data.get('category'), tags: data.getAll('tags'), flags: data.getAll('flags'), type: data.get('type') }; clearSelection(); S.limit = 160; render({ keepScroll: false }); } });
}
function checkFields(label, name, values, selected = []) {
  return `<fieldset class="form-options"><legend>${esc(label)}</legend>${values.length ? values.map(v => check(name, v, v, selected.includes(v))).join('') : '<span class="muted">无可选项</span>'}</fieldset>`;
}
let popAnchor;
function showMenu(anchor, markup, point) {
  const old = popAnchor;
  if (!pop.hidden && anchor && old === anchor && !point) { closeMenu(); return; }
  closeMenu(false); popAnchor = anchor; pop.hidden = false; pop.innerHTML = markup;
  pop.setAttribute('role', 'menu'); anchor?.setAttribute('aria-expanded', 'true');
  const r = anchor?.getBoundingClientRect() || { left: 0, bottom: 0, top: 0 };
  const x = point?.x ?? r.left, y = point?.y ?? r.bottom + 6;
  const left = Math.max(8, Math.min(x, innerWidth - pop.offsetWidth - 8));
  const top = y + pop.offsetHeight > innerHeight - 8 ? Math.max(8, (point?.y ?? r.top) - pop.offsetHeight - 6) : Math.max(8, y);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`; pop.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}
function closeMenu(focus = true) {
  if (pop.hidden) return;
  pop.hidden = true; pop.innerHTML = ''; const anchor = popAnchor; popAnchor = null; anchor?.setAttribute('aria-expanded', 'false');
  if (focus && anchor?.isConnected) anchor.focus({ preventScroll: true });
}
const newItems = () => menuItem('新建仓库', 'new-vault', { glyph: 'plus' }) + menuItem('添加现有文件夹', 'add-vault', { glyph: 'folder-open' });
function vaultMenu(anchor) {
  const nested = S.registry.filter(v => v.parent_id === S.id);
  const current = vault();
  showMenu(anchor, `<div class="menu-caption">切换仓库</div>${roots().map(v => menuItem(v.name, 'switch', { glyph: 'hard-drive', value: v.id, selected: v.id === S.id })).join('')}
    ${current?.parent_id ? menuItem(current.name, 'switch', { glyph: 'layers', value: current.id, selected: true }) : ''}${nested.map(v => menuItem(v.name, 'switch', { glyph: 'layers', value: v.id })).join('')}
    ${current ? menuLine + menuItem('重命名仓库', 'rename-vault', { glyph: 'square-pen', value: current.id }) + (!current.parent_id ? menuItem('移除仓库', 'remove-vault', { glyph: 'ban', value: current.id, danger: true }) : '') : ''}${menuLine}${newItems()}`);
}
function assetMenu(anchor, a, point) {
  if (!a) return;
  const key = assetKey(a), i = (label, command, glyph, options) => menuItem(label, command, { value: key, glyph, ...options });
  const copyPath = menuItem('复制真实路径', 'copy-value', { value: extPath(a), glyph: 'copy' });
  if (a.synthetic) return showMenu(anchor, i('打开文件夹', 'open-asset', 'folder-open') + copyPath, point);
  if (a.state === 'missing') return showMenu(anchor, i('核对并关联身份', 'recover-identity', 'link') + copyPath, point);
  const live = a.state !== 'excluded';
  showMenu(anchor, i(a.kind === 'unit' ? '进入整体单元' : isDir(a) ? '浏览文件夹' : '打开', 'open-asset', 'external-link') + (!isDir(a) ? i('预览', 'preview-one', 'eye') + (runnable(a) ? '' : i('打开方式…', 'choose-file', 'app-window')) : '') + i('在资源管理器中显示', 'reveal', 'folder-open') + copyPath + i('属性', 'file-properties', 'info') + menuLine +
    (live ? i(a.flags.length ? '编辑标记' : '添加标记', 'mark-one', 'flag') + i('整理信息', 'organize-one', 'tag') + (a.state === 'inbox' ? i('入库', 'file-in-one', 'check') : '') : i('重新纳入', 'restore-one', 'undo')) +
    (live ? i('重命名文件', 'rename-file', 'square-pen') + i('移动到…', 'move-one', 'move') + (a.kind === 'directory' ? i('设为整体单元并进入', 'open-unit', 'layers') : '') : '') + menuLine +
    (live ? i('从仓库排除', 'exclude-one', 'ban') : '') + (runnable(a) ? i('执行文件…', 'run', 'play', { danger: true }) : '') + i('移至回收站…', 'recycle-one', 'trash', { danger: true }), point);
}
function searchMenu(anchor) {
  showMenu(anchor, `<div class="menu-caption">搜索范围</div>${scopeOptions.map(([id, label]) => menuItem(label, 'scope', { value: id, selected: id === S.scope, glyph: 'search' })).join('')}${menuLine}${menuItem('包含整体单元内部', 'search-deep', { glyph: 'layers', selected: S.deep })}${menuItem('搜索文件内容（含文档）', 'search-content', { glyph: 'file-text', selected: S.content })}`);
}
async function loadRegistry() {
  const ticket = ++S.registryToken;
  const data = arr(await host.list());
  if (ticket !== S.registryToken) return;
  S.registry = data;
  for (const v of data) if (S.cache.has(v.id)) S.cache.get(v.id).vault = { ...S.cache.get(v.id).vault, ...v };
  for (const id of S.cache.keys()) if (!data.some(v => v.id === id)) S.cache.delete(id);
  for (const id of S.markingErrors.keys()) if (!data.some(v => v.id === id)) S.markingErrors.delete(id);
  if (S.id && !data.some(v => v.id === S.id)) {
    S.id = roots()[0]?.id || null; if (!S.id && !configurationPage()) S.page = 'home'; clearSelection();
  }
}
const requests = new Map(), generations = new Map();
const markCounts = new WeakMap();
function markingCountsFor(snapshot) {
  if (!markCounts.has(snapshot)) markCounts.set(snapshot, markingAssets(snapshot).filter(a => !a.flags.length).length);
  return markCounts.get(snapshot);
}
let markingRun, markingRefreshQueued = false, markingForceQueued = false;
function loadMarking({ force = false } = {}) {
  if (markingRun) { markingRefreshQueued = true; markingForceQueued ||= force; return markingRun; }
  const queue = S.registry.filter(v => force || !S.cache.has(v.id) || S.changed.has(v.id));
  if (!queue.length) return Promise.resolve();
  S.markingLoading = true;
  const worker = async () => {
    for (let v; (v = queue.shift());) {
      try { await loadSnapshot(v.id, force); S.markingErrors.delete(v.id); }
      catch (error) { if (getVault(v.id)) S.markingErrors.set(v.id, msg(error)); }
    }
  };
  markingRun = Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker)).finally(() => {
    markingRun = null; S.markingLoading = false;
    if (markingRefreshQueued) {
      const force = markingForceQueued; markingRefreshQueued = markingForceQueued = false;
      void loadMarking({ force });
    }
    if (!isDirty()) render();
  });
  return markingRun;
}
function loadSnapshot(id, fresh = false) {
  if (!id) return Promise.resolve(null);
  if (!fresh && requests.has(id)) return requests.get(id);
  if (!fresh && S.cache.has(id) && !S.changed.has(id)) return Promise.resolve(S.cache.get(id));
  const generation = (generations.get(id) || 0) + 1;
  generations.set(id, generation); S.changed.delete(id);
  const task = (async () => {
    try {
      const data = normalizeSnapshot(await host.snapshot(id), getVault(id));
      if (generations.get(id) === generation) {
        S.cache.set(id, data);
        S.registry = S.registry.map(v => v.id === id ? { ...v, ...data.vault } : v);
        return data;
      }
      return requests.get(id) !== task ? requests.get(id) || S.cache.get(id) || data : S.cache.get(id) || data;
    } catch (error) { S.changed.add(id); throw error; }
    finally { if (requests.get(id) === task) requests.delete(id); }
  })();
  requests.set(id, task); return task;
}
async function refreshView(id = S.id, fresh = true) {
  if (!id) return;
  const active = id === S.id;
  if (active) { S.error = ''; S.loading = true; render(); }
  try { await loadSnapshot(id, fresh); }
  catch (error) { if (id === S.id) S.error = msg(error); else throw error; }
  finally { if (id === S.id) { S.loading = false; render(); } }
}
function clearSelection() { S.selected.clear(); S.anchor = null; S.previewToken++; S.preview = null; S.tab = 'details'; }
function resetView() { S.limit = 160; S.filters = clearFilters(); clearSelection(); S.error = ''; }
function nav(page, opts = {}) {
  if (!pages[page]) return;
  clearTimeout(searchTimer); S.review = false; S.viewId = opts.viewId ?? null;
  if (!vault() && !['home', 'settings', 'search', 'marking'].includes(page)) page = 'home';
  S.page = page; S.facet = opts.facet ?? ''; S.folder = norm(opts.folder ?? ''); resetView();
  if (opts.filters) S.filters = structuredClone(opts.filters);
  if (page !== 'search') { S.query = ''; S.searchToken++; S.searchItems = []; S.searchOrigin = null; }
  if (page === 'marking') void loadMarking();
  render({ keepScroll: false });
  if (page === 'duplicates') void getDuplicates();
  if (page === 'settings') void readApi();
}
async function switchVault(id, page = 'inbox', folder = '') {
  if (!getVault(id)) return;
  S.id = id; persist('active', id); S.notice = ''; S.dup = null; S.dupToken++;
  S.loading = !S.cache.has(id);
  if (page === 'inbox' && !getVault(id)?.parent_id && S.page !== 'inbox') page = 'all';
  nav(page, { folder }); await refreshView(id, false);
}
async function getDuplicates() {
  const id = S.id, token = ++S.dupToken;
  if (!id) return;
  S.dup = { loading: true }; render();
  try {
    const groups = arr(await host.duplicates(id)).filter(g => Array.isArray(g) && g.length > 1);
    if (token !== S.dupToken || S.id !== id) return;
    S.dup = { groups, map: new Map(groups.flatMap((group, i) => group.map(x => [x, i]))) };
  } catch (error) { if (token === S.dupToken && S.id === id) S.dup = { error: msg(error) }; }
  if (token === S.dupToken && S.page === 'duplicates') render();
}
function selectedKeys(key, additive, range) {
  const item = itemAt(key); if (!item) return;
  const prev = one();
  if (range && S.anchor && S.byKey.has(S.anchor)) {
    let a = S.items.findIndex(item => assetKey(item) === S.anchor), b = S.items.findIndex(item => assetKey(item) === key);
    if (!additive) S.selected.clear();
    const low = Math.min(a, b), high = Math.max(a, b);
    for (const i of S.items.slice(low, high + 1)) if (!i.synthetic) S.selected.add(assetKey(i));
  } else {
    if (!additive || item.synthetic) S.selected.clear();
    else for (const k of S.selected) if (itemAt(k)?.synthetic) S.selected.delete(k);
    if (additive && S.selected.has(key)) S.selected.delete(key);
    else S.selected.add(key);
    S.anchor = key;
  }
  syncSelection(prev);
}
function syncSelectAll() {
  const real = S.items.filter(a => !a.synthetic), count = real.reduce((n, a) => n + Number(S.selected.has(assetKey(a))), 0);
  workspace.querySelectorAll('[data-select-all]').forEach(box => { box.checked = !!real.length && real.length === count; box.indeterminate = count > 0 && count < real.length; });
}
function syncSelection(old) {
  const item = one();
  if (old !== item) { S.previewToken++; S.preview = null; }
  if (!item || item.synthetic || item.state === 'missing') S.tab = 'details';
  const bulk = $('#bulk'); if (bulk) { unmount(bulk); bulk.outerHTML = renderBulk(); mount($('#bulk')); }
  updateReview();
  for (const node of workspace.querySelectorAll('[data-asset]')) {
    const selected = S.selected.has(node.dataset.asset); node.classList.toggle('selected', selected);
    if (node.hasAttribute('aria-selected')) node.setAttribute('aria-selected', selected);
    const box = node.querySelector('[data-asset-check]'); if (box) box.checked = selected;
  }
  syncSelectAll();
  renderInspector(); renderStatus();
  if (item && S.pane && S.tab === 'preview' && !S.preview) void loadPreview(item);
}
function selectAll(checked) {
  const old = one(); S.selected = checked ? new Set(S.items.filter(a => !a.synthetic).map(assetKey)) : new Set(); syncSelection(old);
}
function remember(item) {
  const key = assetKey(item);
  // Revisiting a row while browsing Recently Used shouldn't move it under the pointer.
  prefs.recent.delete(key); prefs.recent.set(key, Date.now()); persist('recent', [...prefs.recent].slice(-300));
}
async function loadPreview(a, { used = true } = {}) {
  if (!a || a.synthetic || a.state === 'missing') return;
  const key = assetKey(a), token = ++S.previewToken;
  const signature = previewSignature(a);
  S.preview = { key, signature, loading: true }; renderInspector();
  try { const data = await host.preview(a.vaultId, a.id); if (S.previewToken !== token) return; S.preview = { key, signature, data }; if (used) remember(a); }
  catch (error) { if (S.previewToken !== token) return; S.preview = { key, signature, error: msg(error) }; }
  renderInspector();
}
function previewOne(a) {
  if (!a || a.synthetic || a.state === 'missing') return;
  S.selected = new Set([assetKey(a)]); S.anchor = assetKey(a); S.pane = true; S.tab = 'preview';
  const old = S.preview?.key === assetKey(a) ? a : null; syncSelection(old);
  renderChromeInto();
  if (!S.preview) void loadPreview(a);
}
function openEditor(a = one()) {
  const data = S.preview?.signature === previewSignature(a) ? S.preview?.data : null;
  if (!a || a.state === 'excluded' || data?.kind !== 'text' || data.revision == null) return;
  S.edited = { item: a, original: data.text ?? '', text: data.text ?? '', revision: data.revision, abandon: false };
  showDialog({ title: a.name, text: '编辑将保存到原文件。若磁盘版本已变化，不会覆盖它。', symbol: 'square-pen', wide: true,
    submit: '保存', cancel: '关闭编辑器', body: `<label class="sr-only" for="editor">文本内容</label><textarea id="editor" name="text" spellcheck="false" autofocus></textarea><div class="editor-foot"><span id="editor-state">未修改</span><button type="button" ${act('copy-draft')}>复制草稿</button><button type="button" ${act('reload-draft')}>查看磁盘版本</button></div><div id="external-version" hidden></div>`,
    onCancel: () => {
      if (isDirty() && !S.edited.abandon) {
        S.edited.abandon = true; dialogError('存在未保存的修改。再次选择「关闭编辑器」将放弃草稿，或先复制草稿。'); return false;
      }
      S.edited = null; flushChanges(); return true;
    },
    onSubmit: async () => {
      const edit = S.edited; if (!edit) return;
      if (edit.text !== edit.original) {
        const written = edit.text;
        await host.save(a.vaultId, a.id, edit.revision, written);
        // Inputs are locked during save so the committed draft cannot discard later keystrokes.
        S.preview = null;
        toast('已保存到原文件');
      }
      S.edited = null; changed(a.vaultId); await flushChanges();
    } });
  const editor = $('#editor'); editor.value = S.edited.text; editor.focus();
}
async function compareExternal() {
  const edit = S.edited; if (!edit) return;
  const preview = await host.preview(edit.item.vaultId, edit.item.id);
  if (S.edited !== edit) return;
  if (preview.kind !== 'text' || preview.revision == null) throw new Error(preview.message || '当前磁盘文件无法读取为可编辑文本。');
  const container = $('#external-version'); container.hidden = false;
  container.innerHTML = `<div class="editor-compare"><strong>磁盘版本 · 草稿未改动</strong><pre>${esc(preview.text ?? '')}</pre><button type="button" class="c-btn va-btn secondary" ${act('use-disk-version')}>采用磁盘版本</button></div>`;
  edit.external = preview;
}
async function openAsset(a, unit = false) {
  if (!a || a.state === 'missing') return;
  if (a.state === 'excluded' && isDir(a)) { await host.file(a.vaultId, a.id, 'default'); return; }
  if (unit || a.kind === 'unit') {
    if (!knowsUnit(a) && !await ask('将文件夹设为整体单元？', `「${a.name}」将作为外层仓库中的单一资产。进入后可独立整理内部文件，磁盘结构不会变化。`, { symbol: 'layers', submit: '设为整体单元' })) return;
    const v = await host.unit(a.vaultId, a.id); remember(a);
    if (!S.registry.some(old => old.id === v.id)) S.registry.push(v);
    S.changed.add(a.vaultId); await switchVault(v.id, 'physical'); return;
  }
  if (isDir(a) && a.state !== 'excluded') {
    if (!a.synthetic) remember(a);
    if (a.vaultId !== S.id) await switchVault(a.vaultId, 'physical', a.rel);
    else nav('physical', { folder: a.rel });
    return;
  }
  if (runnable(a)) { await runFile(a); return; }
  await host.file(a.vaultId, a.id, 'default'); remember(a);
}
const runnable = a => !isDir(a) && /\.exe$/i.test(a.name);
async function runFile(a) {
  if (!a || !await ask('执行此文件？', `「${a.name}」可能运行代码。请确认文件来源可信。`, { symbol: 'triangle-alert', danger: true, submit: '执行' })) return;
  await host.file(a.vaultId, a.id, 'run', { confirmed: true }); remember(a);
}
function newVault(create) {
  showDialog({ title: create ? '新建仓库' : '添加现有文件夹', symbol: create ? 'plus' : 'folder-open', text: create ? '在所选位置创建一个新的仓库文件夹。' : '将现有文件夹纳入管理，不移动或复制其中的文件。', submit: create ? '创建仓库' : '添加仓库',
    body: `${labeled('仓库名称', field('', 'name', { placeholder: '例如：我的设计资料', required: true }))}<div class="path-input"><div>${labeled(create ? '父文件夹' : '文件夹位置', field('', 'path', { placeholder: '未选择文件夹', readonly: true, max: 32768 }))}</div>${button('选择…', 'pick-folder', { glyph: 'folder-open', style: 'secondary', value: create ? '选择新仓库的父文件夹' : '选择现有仓库文件夹' })}</div>`,
    onSubmit: async data => {
      const path = data.get('path'), name = validateName(data.get('name'));
      if (!path) throw new Error('请先选择文件夹。');
      const v = await host.add(path, name, create);
      if (!S.registry.some(x => x.id === v.id)) S.registry.push(v);
      await switchVault(v.id); toast(create ? '已创建仓库' : '已添加仓库');
    } });
}
function validateName(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请输入名称。');
  return value;
}
function renameVault(v) {
  if (!v) return;
  showDialog({ title: '重命名仓库', text: '只修改显示名称，不重命名磁盘上的文件夹。', symbol: 'square-pen', submit: '保存名称', body: labeled('仓库名称', field(v.name, 'name', { required: true, placeholder: '仓库名称' })),
    onSubmit: async data => { const name = validateName(data.get('name')); await host.rename(v.id, name);
      S.registry = S.registry.map(item => item.id === v.id ? { ...item, name } : item);
      if (S.cache.has(v.id)) S.cache.get(v.id).vault.name = name; render(); toast('仓库已重命名'); } });
}
function removeVault(v) {
  if (!v) return;
  showDialog({ title: '移除仓库？', text: `「${v.name}」将从仓库列表中移除，并撤销它和下属单元的 Agent CLI 授权。磁盘上的原文件不会删除。`, symbol: 'ban', danger: true, submit: '移除仓库', onSubmit: async () => {
    await host.remove(v.id);
    const detached = new Set([v.id]);
    for (let size = 0; size !== detached.size;) { size = detached.size; for (const item of S.registry) if (detached.has(item.parent_id)) detached.add(item.id); }
    S.registry = S.registry.filter(item => !detached.has(item.id));
    for (const id of detached) { S.cache.delete(id); S.access.delete(id); }
    if (detached.has(S.id)) { S.id = null; persist('active', null); nav('home'); } else render();
    toast('已移除仓库，磁盘文件未删除');
  } });
}
function makeFolder() {
  const id = S.id, parent = S.folder;
  if (!id) return;
  showDialog({ title: '新建文件夹', text: `创建于 ${absolute(vault().root, parent)}`, symbol: 'folder-plus', submit: '创建文件夹', body: labeled('文件夹名称', field('', 'name', { required: true, placeholder: '新文件夹' })), onSubmit: async data => {
    const path = await host.folder(id, parent, validateName(data.get('name'))); await afterChanges([id]);
    if (path && S.id === id) nav('physical', { folder: path }); toast('已创建文件夹');
  } });
}
async function afterChanges(ids) {
  for (const id of ids) S.changed.add(id);
  await Promise.allSettled(unique(ids).map(id => id === S.id ? refreshView(id) : loadSnapshot(id, true)));
  if (S.page === 'search') await doSearch();
  else if (S.page === 'marking' || ids.some(id => id !== S.id)) render();
  if (S.page === 'duplicates') void getDuplicates();
  if (one() && S.tab === 'preview') void loadPreview(one(), { used: false });
}
function targetSummary(items) {
  return `<div class="target-summary"><strong>${items.length} 个项目 · ${perVault(items).size} 个仓库</strong><ul>${items.slice(0, 5).map(a => `<li title="${esc(extPath(a))}">${esc(sourceName(a.vaultId))} / ${esc(a.rel || a.name)}</li>`).join('')}${items.length > 5 ? `<li>还有 ${items.length - 5} 项</li>` : ''}</ul></div>`;
}
async function reportResults(results, successLabel) {
  const successes = results.filter(r => r.ok).reduce((n, r) => n + r.items.length, 0), failed = results.filter(r => !r.ok);
  if (!failed.length) { toast(`${successLabel} · ${successes} 项`); return; }
  if (!successes) throw new Error(failed.length === 1 && failed[0].items.length === 1 ? failed[0].error : failed.map(r => `${r.items.map(a => `${sourceName(a.vaultId)}/${a.rel || a.name}`).join('、')}：${r.error}`).join('\n'));
  const node = document.createElement('details'); node.className = 'inline-note batch-result'; node.open = false;
  node.innerHTML = `<summary>${esc(successLabel)}：${successes} 项成功，${failed.reduce((n, r) => n + r.items.length, 0)} 项未确认完成</summary><div><strong>成功</strong><ul>${results.filter(r => r.ok).flatMap(r => r.items.map(a => `<li>${esc(sourceName(a.vaultId))} / ${esc(a.rel || a.name)}</li>`)).join('')}</ul><strong>失败或状态未确认</strong><ul>${failed.flatMap(r => r.items.map(a => `<li>${esc(sourceName(a.vaultId))} / ${esc(a.rel || a.name)}：${esc(r.error)}</li>`)).join('')}</ul>${ib('关闭批量结果', 'close-results', 'x')}</div>`;
  node.dataset.location = `${S.id}:${S.page}`; S.batch = node;
  ($('#stage > .asset-intro') || $('#stage'))?.prepend(node); mount(node); toast(`${successLabel}：${successes} 项成功，部分项目未完成`, 'warn');
}
async function batchOrganize(items, patch, label) {
  if (!items.length) return;
  const results = [];
  for (const [id, group] of perVault(items)) {
    try { await host.mutate(id, { type: 'organize', ids: group.map(a => a.id), ...patch }); results.push({ ok: true, items: group }); }
    catch (error) { results.push({ ok: false, items: group, error: msg(error) }); }
  }
  await afterChanges([...perVault(items).keys()]); await reportResults(results, label);
}
async function batchFile(items, operation, options, label) {
  const results = [];
  for (const item of items) {
    try { await host.file(item.vaultId, item.id, operation, options(item)); results.push({ ok: true, items: [item] }); }
    catch (error) { results.push({ ok: false, items: [item], error: msg(error) }); }
  }
  await afterChanges([...perVault(items).keys()]); await reportResults(results, label);
}
function editMarks(items) {
  items = items.filter(markable);
  if (!items.length) return;
  const a = items.length === 1 ? items[0] : null;
  const choices = unique([...markChoices, ...(a?.flags ?? [])]);
  showDialog({ title: a?.flags.length ? '编辑标记' : a ? '添加标记' : '批量添加标记',
    text: '只修改标记，不会改变入库状态、标签或原文件。', symbol: 'flag', submit: '保存标记',
    body: `${targetSummary(items)}<fieldset class="mark-choices"><legend>选择标记</legend>${choices.map(mark => check('chosen-mark', mark, mark, !!a?.flags.includes(mark))).join('')}</fieldset>${labeled('自定义标记', field('', 'custom-marks', { placeholder: '可选，用逗号分隔', max: 2000 }))}${a?.flags.length ? '<p class="muted">取消勾选可移除对应的标记。</p>' : ''}`,
    onSubmit: async data => {
      const next = unique([...data.getAll('chosen-mark'), ...parseLabels(data.get('custom-marks'))]);
      const add = next.filter(mark => !a?.flags.includes(mark));
      const remove = a ? a.flags.filter(mark => !next.includes(mark)) : [];
      if (!add.length && !remove.length) { if (!a?.flags.length) throw new Error('请选择或填写至少一个标记。'); return; }
      await batchOrganize(items, { add_flags: add, remove_flags: remove }, '标记已更新');
    },
  });
}
const parseLabels = value => unique(String(value || '').split(/[,，;；\r\n]+/).map(t => t.trim()));
function organize(items, { review = false } = {}) {
  items = items.filter(a => !a.synthetic && !['excluded', 'missing'].includes(a.state));
  if (!items.length) return;
  const id = items[0].vaultId, singleVault = perVault(items).size === 1, a = items.length === 1 ? items[0] : null;
  const opts = singleVault ? categoryOptions(makeCategoryIndex(S.cache.get(id)?.categories || [])) : [];
  showDialog({ title: review ? '整理后入库' : a ? '整理资产' : '批量整理', text: '在这里修改管理信息，不会移动磁盘上的文件。', symbol: 'tag', submit: review ? '保存并入库' : '保存整理信息',
    body: `${targetSummary(items)}${singleVault ? labeled('主分类', select('category', [['!keep', '保留原分类'], ['', '未分类'], ...opts.map(c => [c.id, c.label])], a ? a.category_id || '' : '!keep')) : '<p class="muted">多仓库选择不支持同时设置主分类。</p>'}
    ${a ? labeled('标签', field(a.tags.join('，'), 'tags', { placeholder: '用逗号分隔多个标签', max: 2000 })) + labeled('标记', field(a.flags.join('，'), 'flags', { placeholder: '例如：重点关注，待处理', max: 2000 })) + `<div class="suggestions"><small>添加常用标记</small>${defaultFlags.map(f => `<button type="button" class="facet" ${act('add-flag-chip', f)}>${icon('plus', 12)}${esc(f)}</button>`).join('')}</div>`
    : labeled('添加标签', field('', 'add-tags', { placeholder: '用逗号分隔', max: 2000 })) + labeled('移除标签', field('', 'remove-tags', { placeholder: '用逗号分隔', max: 2000 })) + labeled('添加标记', field('', 'add-flags', { placeholder: '例如：重点关注，待处理', max: 2000 })) + labeled('移除标记', field('', 'remove-flags', { placeholder: '用逗号分隔', max: 2000 }))}
    ${review ? '' : labeled('入库状态', select('state', [['', '保留状态'], ['filed', '标记为已入库'], ['inbox', '放回收件箱']]))}`,
    onSubmit: async data => {
      const patch = {}, category = data.get('category'), state = data.get('state');
      if (singleVault && category !== '!keep' && (!a || (a.category_id ?? '') !== category)) patch.category_id = category || null;
      if (state) patch.state = state;
      for (const dimension of ['tags', 'flags']) {
        const parsed = parseLabels(data.get(dimension));
        const add = a ? parsed.filter(t => !a[dimension].includes(t)) : parseLabels(data.get(`add-${dimension}`));
        const remove = a ? a[dimension].filter(t => !parsed.includes(t)) : parseLabels(data.get(`remove-${dimension}`));
        if (add.some(t => remove.includes(t))) throw new Error('同一个标签或标记不能同时添加和移除。');
        if (add.length) patch[`add_${dimension}`] = add;
        if (remove.length) patch[`remove_${dimension}`] = remove;
      }
      if (review) { if (selectedKey(one()) !== assetKey(a)) throw new Error('选择已变化，请重新打开整理。'); await reviewFile(patch); }
      else if (Object.keys(patch).length) await batchOrganize(items, patch, '已整理');
    } });
}
function exclude(items) {
  const eligible = items.filter(a => !a.synthetic && !['excluded', 'missing'].includes(a.state)); if (!eligible.length) return;
  showDialog({ title: '从仓库排除？', text: '原文件保留在磁盘，但不再参与浏览和搜索。可在「已排除」中重新纳入。', symbol: 'ban', submit: '排除', body: targetSummary(eligible), onSubmit: () => batchOrganize(eligible, { state: 'excluded' }, '已排除') });
}
function recycle(items) {
  items = items.filter(a => !a.synthetic && a.state !== 'missing'); if (!items.length) return;
  showDialog({ title: '移至 Windows 回收站？', text: '这会从原位置移除真实文件。文件夹中的所有内容也会被移至回收站。', symbol: 'trash', submit: '移至回收站', danger: true, body: targetSummary(items),
    onSubmit: () => batchFile(items, 'recycle', () => ({ confirmed: true }), '已移至回收站') });
}
function renameFile(a) {
  if (!a) return;
  showDialog({ title: '重命名磁盘项目', text: '会修改真实文件名。修改文件扩展名可能影响打开方式。', symbol: 'square-pen', submit: '保存名称', body: labeled('文件名', field(a.name, 'name', { required: true, placeholder: '文件名' })),
    onSubmit: async data => { const name = validateName(data.get('name')); if (name !== a.name) await batchFile([a], 'rename', () => ({ value: name }), '已重命名'); } });
}
async function move(items) {
  items = items.filter(a => !a.synthetic && !['excluded', 'missing'].includes(a.state)); if (!items.length) return;
  const p = await host.choose('选择目标文件夹'); if (!p) return;
  if (items.some(a => isDir(a) && containsPath(extPath(a), p))) throw new Error('不能将文件夹移动到自身或下级目录。');
  const outside = items.some(a => !containsPath(getVault(a.vaultId)?.root, p));
  showDialog({ title: outside ? '移动到仓库外？' : '移动磁盘项目？', text: outside ? '部分项目将移出其仓库，不再出现在原仓库的常规视图中。' : '项目的真实磁盘路径将发生变化。', symbol: 'move', submit: '移动', danger: outside,
    body: `${targetSummary(items)}${labeled('目标文件夹', field(p, 'destination', { readonly: true, max: 32768, placeholder: '目标文件夹' }))}`,
    onSubmit: () => batchFile(items, 'move', a => ({ value: p, confirmed: !containsPath(getVault(a.vaultId)?.root, p) }), '已移动') });
}
function editCategory(id = '') {
  const v = S.id, current = catIndex.map.get(id);
  const eligible = categoryOptions(catIndex).filter(c => !id || !ancestry(c.id, catIndex).some(node => node.id === id));
  showDialog({ title: current ? '编辑分类' : '新建分类', text: '逻辑分类与磁盘目录相互独立。', symbol: 'layers', submit: '保存分类',
    body: labeled('分类名称', field(current?.name || '', 'name', { required: true, placeholder: '分类名称' })) + labeled('父分类', select('parent', [['', '无 · 顶级分类'], ...eligible.map(c => [c.id, c.label])], current ? current.parent_id || '' : S.facet || '')),
    onSubmit: async data => { const parent = data.get('parent') || null; await host.mutate(v, { type: 'category_save', ...(id ? { id } : {}), name: validateName(data.get('name')), parent_id: parent }); await afterChanges([v]); toast('分类已保存'); } });
}
function deleteCategory() {
  const v = S.id, id = S.facet, c = catIndex.map.get(id); if (!c) return;
  showDialog({ title: '删除分类？', text: `删除「${c.name}」不会删除磁盘文件。可以为受影响的资产指定新的主分类。`, symbol: 'layers', danger: true, submit: '删除分类',
    body: labeled('将资产重新归类到', select('reassign', [['', '未分类'], ...categoryOptions(catIndex).filter(other => !ancestry(other.id, catIndex).some(node => node.id === id)).map(other => [other.id, other.label])])),
    onSubmit: async data => { await host.mutate(v, { type: 'category_delete', id, reassign_to: data.get('reassign') || null }); S.facet = ''; if (S.filters.category === id) S.filters.category = ''; await afterChanges([v]); toast('分类已删除'); } });
}
function editTag(name = '') {
  const id = S.id;
  showDialog({ title: name ? '重命名标签' : '新建标签', text: name ? '重命名将应用到仓库中使用此标签的资产。' : '标签可以添加到任意分类中的资产。', symbol: 'tag', submit: '保存标签', body: labeled('标签名称', field(name, 'name', { required: true, placeholder: '标签名称' })),
    onSubmit: async data => { const newName = validateName(data.get('name')); if (name === newName) return;
      await host.mutate(id, name ? { type: 'tag_rename', name, new_name: newName } : { type: 'tag_create', name: newName });
      S.facet = newName; S.filters.tags = S.filters.tags.map(t => t === name ? newName : t); await afterChanges([id]); toast('标签已保存'); } });
}
function deleteTag() {
  const id = S.id, name = S.facet; if (!name) return;
  showDialog({ title: '删除标签？', text: `「${name}」将从仓库及相关资产中移除，原文件不受影响。`, symbol: 'tag', danger: true, submit: '删除标签',
    onSubmit: async () => { await host.mutate(id, { type: 'tag_delete', name }); S.facet = ''; S.filters.tags = S.filters.tags.filter(t => t !== name); await afterChanges([id]); toast('标签已删除'); } });
}
function viewConfig() {
  const v = vault(); if (!v) return;
  showDialog({ title: '磁盘分类视图', text: '在磁盘上以链接展示分类。这些链接不是文件副本，不会改变原文件路径。', symbol: 'link', submit: '保存配置',
    body: `<div>${check('enabled', 'on', '启用磁盘分类视图', !!v.view_enabled)}</div><fieldset class="form-options"><legend>只生成所选分类（全不选代表全部）</legend>${categoryOptions(catIndex).map(c => check('categories', c.id, c.label, arr(v.view_categories).includes(c.id))).join('') || '<span class="muted">尚未创建分类</span>'}</fieldset>`,
    onSubmit: async values => { await host.mutate(v.id, { type: 'view_config', enabled: values.has('enabled'), categories: values.getAll('categories') }); await afterChanges([v.id]); toast('分类视图配置已保存'); } });
}
function recover(a) {
  if (!a || a.state !== 'missing') return;
  const candidates = (S.cache.get(a.vaultId)?.assets || []).filter(item => !['missing', 'excluded'].includes(item.state) && item.kind === a.kind);
  const ordered = candidates.sort((x, y) => Number(y.name === a.name) - Number(x.name === a.name) || collator.compare(x.rel, y.rel));
  showDialog({ title: '核对并关联身份', text: '仅当现有文件确为缺失文件移动或改名后的同一份资产时才关联。内容相同不代表身份相同。', symbol: 'link', submit: '确认关联', danger: true,
    body: targetSummary([a]) + labeled('现有资产', select('present', [['', '先选择要关联的真实文件'], ...ordered.map(b => [b.id, b.rel || b.name])], '', 'required')) + check('verified', 'yes', '我已核对文件身份'),
    onSubmit: async values => { if (!values.has('verified')) throw new Error('请先确认已核对身份。'); await host.mutate(a.vaultId, { type: 'recover_identity', missing_id: a.id, present_id: values.get('present') }); await afterChanges([a.vaultId]); toast('资产身份已关联'); } });
}
async function readAccess(id = S.id, force = false) {
  if (!id || S.accessLoading.has(id) || (!force && S.access.has(id))) return;
  S.accessLoading.add(id); render();
  try { S.access.set(id, await host.agentAccess(id)); } catch (error) { toast(msg(error), 'error'); }
  finally { S.accessLoading.delete(id); if (S.page === 'settings') render(); }
}
async function readApi() {
  if (!connected()) return;
  const id = S.id;
  void readAccess(id, true);
  if (!S.api) try { S.api = await host.info(); if (S.page === 'settings') render(); } catch (error) { toast(msg(error), 'error'); }
}
async function setAccess(access) {
  const v = vault(); if (!v || !accessOptions.some(([value]) => value === access)) return;
  render();
  if (access !== 'off' && !await ask('允许外部工具访问？', `仅向本机 Agent CLI 授权访问「${v.name}」的${access === 'read' ? '管理信息（只读）' : '管理信息（读取和修改）'}；不能执行磁盘文件操作。`, { symbol: 'terminal', submit: '授予权限' })) return;
  await host.setAgentAccess(v.id, access); S.access.set(v.id, access); render(); toast(access === 'off' ? '已关闭 Agent CLI 访问' : 'Agent CLI 权限已更新');
}
function searchVaultIds() {
  const v = vault();
  const initial = unique(S.scope === 'all' ? roots().map(v => v.id) : S.scope === 'selected' ? S.scopeIds.filter(id => getVault(id)) : [v?.id || roots()[0]?.id]);
  if (!S.deep) return initial;
  const included = new Set(initial);
  for (let added = true; added;) {
    const size = included.size;
    for (const item of S.registry) if (included.has(item.parent_id)) included.add(item.id);
    added = size !== included.size;
  }
  return [...included];
}
let pendingContent = Promise.resolve();
function contentSearch(ids, keyword, token) {
  // Coalesce searches whose turn has not started. Rust finishes at most one
  // disk-content pass at a time even when the user keeps typing or switches scopes.
  const result = pendingContent.then(() => token === S.searchToken && S.page === 'search' ? host.matches(ids, keyword) : []);
  pendingContent = result.catch(() => {});
  return result;
}
async function doSearch({ preserve = false } = {}) {
  const keyword = S.query.trim(), token = ++S.searchToken, ids = searchVaultIds();
  if (!keyword) { S.searching = false; S.searchItems = []; S.searchErrors = []; if (S.page === 'search') render(); return; }
  S.searching = true; S.searchErrors = [];
  if (!preserve) { S.searchItems = []; S.searchCount = ids.length; render({ keepScroll: false }); }
  // Bound parallel reads so large registries do not flood the host.
  const errors = [], results = [];
  const remaining = ids.slice();
  async function worker() { while (remaining.length && token === S.searchToken) { const id = remaining.shift();
    try { const data = await loadSnapshot(id); if (data) results.push(data); }
    catch (error) { errors.push(`${sourceName(id)}：${msg(error)}`); }
  } }
  const matchJob = S.content && ids.length ? contentSearch(ids, keyword, token).catch(error => { errors.push(`文件内容：${msg(error)}`); return []; }) : [];
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  const matches = await matchJob;
  if (token !== S.searchToken || S.page !== 'search') return;
  S.searching = false; S.searchErrors = errors; S.searchItems = searchAssets(results, keyword, matches); render();
}
let searchTimer;
function beginSearch(value, immediate = false) {
  clearTimeout(searchTimer); S.query = value;
  if (!value.trim() && S.page !== 'search') return;
  if (!value.trim()) {
    const origin = S.searchOrigin;
    S.searchOrigin = null;
    if (origin && origin.vaultId === S.id) { S.sort = origin.sort; S.direction = origin.direction; nav(origin.page, origin); }
    else nav(S.id ? 'inbox' : 'home');
    return;
  }
  if (S.page !== 'search') { S.searchOrigin = { vaultId: S.id, page: S.page, facet: S.facet, folder: S.folder, filters: structuredClone(S.filters), viewId: S.viewId, sort: S.sort, direction: S.direction }; S.page = 'search'; S.facet = ''; S.review = false; S.viewId = null; resetView(); }
  S.searchToken++; S.searching = true;
  if (immediate) void doSearch(); else searchTimer = setTimeout(doSearch, S.content ? 480 : 220);
}
function selectedScope() {
  const values = S.registry.map(v => check('ids', v.id, `${v.parent_id ? `${sourceName(v.parent_id)} / ` : ''}${v.name}`, S.scopeIds.includes(v.id)));
  showDialog({ title: '选择搜索仓库', text: '搜索结果会标明每个资产来自哪个仓库。', symbol: 'search', submit: '应用范围',
    body: `<fieldset class="form-options"><legend>仓库</legend>${values.join('')}</fieldset>`,
    onSubmit: data => { const ids = data.getAll('ids'); if (!ids.length) throw new Error('请选择至少一个仓库。'); S.scope = 'selected'; S.scopeIds = ids; if (S.query.trim()) beginSearch(S.query, true); else render(); } });
}
async function clipboard(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); toast('已复制'); return; } catch {}
  }
  const old = document.activeElement, input = document.createElement('textarea'); input.value = value; input.className = 'clipboard';
  (modal.open ? modal : document.body).append(input); input.select();
  const ok = document.execCommand('copy'); input.remove(); old?.focus({ preventScroll: true });
  if (!ok) throw new Error('无法访问剪贴板。'); toast('已复制');
}
function resolveItem(key) {
  if (!key) return one();
  const item = itemAt(key);
  if (item) return item;
  try { const [id, asset] = JSON.parse(key); return asset == null ? null : S.cache.get(id)?.assets.find(a => a.id === asset); } catch { return null; }
}
function clearAndSync() { const a = one(); clearSelection(); syncSelection(a); }
function updateSort(key, fixed) { S.viewId = null; S.direction = fixed ?? (S.sort === key && S.direction === 'asc' ? 'desc' : 'asc'); S.sort = key; render({ keepScroll: false }); }
async function scan() {
  if (!S.id || S.actionBusy) return;
  S.actionBusy = true; S.loading = true; render(); const id = S.id;
  try { await host.rescan(id); await afterChanges([id]); toast('扫描完成'); }
  finally { S.actionBusy = false; if (S.id === id) { S.loading = false; render(); } }
}
const menus = new Set(['vault-menu', 'new-menu', 'manage-vault', 'asset-menu', 'bulk-menu', 'category-menu', 'tag-menu', 'sort-menu', 'search-menu', 'library-menu', 'saved-menu', 'category-select-menu', 'label-select-menu']);
async function action(name, value, node) {
  const a = ['asset-menu','open-asset','preview-one','organize-one','file-in-one','restore-one','exclude-one','recycle-one','rename-file','move-one','open-unit','run','choose-file','reveal','file-properties','recover-identity','mark-one'].includes(name) ? resolveItem(value) : null;
  const picked = selection();
  if (!menus.has(name)) closeMenu();
  if (modal.open && modalController?.active && node?.closest('#modal')) return;
  switch (name) {
    case 'nav': if (value === 'marking' && S.page !== 'marking') S.markMode = 'pending'; return nav(value);
    case 'library-mode': return nav(value);
    case 'rail-resize': return resizeRail(value);
    case 'mark-mode':
      if (S.markMode === value || !['pending', 'marked'].includes(value)) return;
      S.markMode = value; S.limit = 160; clearSelection(); render({ keepScroll: false }); return;
    case 'mark-one': return editMarks(a ? [a] : []);
    case 'mark-selected': return editMarks(picked);
    case 'mark-refresh': { const task = loadMarking({ force: true }); render(); return task; }
    case 'library-menu': return showMenu(node, libraryItems().map(i => menuItem(i.label, i.name, { glyph: i.icon, value: i.value, selected: i.checked, disabled: i.disabled })).join(''));
    case 'saved-menu': return showMenu(node, savedViews().map(v => menuItem(v.name, 'open-view', { glyph: 'star', value: v.id, selected: v.id === S.viewId })).join(''));
    case 'category-select-menu': return showMenu(node, [['', '全部分类'], ...categoryOptions(catIndex).map(c => [c.id, c.label])].map(([id, label]) => menuItem(label, 'category', { value: id, selected: id === S.facet })).join(''));
    case 'label-select-menu': return showMenu(node, ['', ...(S.page === 'tags' ? tags : flags)].map(label => menuItem(label || '全部', 'facet', { value: label, selected: label === S.facet })).join(''));
    case 'command-palette': return showCommands();
    case 'search-input': if (!composing) beginSearch(value); return;
    case 'titlebar-mode': try { await setWindowChromeMode(value); } catch (error) { render(); throw error; } return;
    case 'set-theme': prefs.theme = value; persist('theme', value); setTheme(); return;
    case 'save-view': return saveView();
    case 'manage-view': return manageView(value || S.viewId);
    case 'rename-view': { const view = prefs.views.find(v => v.id === value); if (view && closeDialog()) saveView(view); return; }
    case 'remove-view': {
      if (!closeDialog()) return;
      prefs.views = prefs.views.filter(v => v.id !== value); storeViews();
      if (S.viewId === value) S.viewId = null;
      render(); toast('已移除视图，文件未更改'); return;
    }
    case 'close-commands': return closeCommands();
    case 'command-query': if (!commandComposing) filterCommands(value); return;
    case 'run-command': { const c = commandResults[Number(value)]; if (c) { closeCommands(); return action(c.action, c.value, null); } return; }
    case 'open-view': return openView(value);
    case 'review-start': return startReview();
    case 'review-stop': S.review = false; render(); return;
    case 'review-next': return stepReview(1);
    case 'review-prev': return stepReview(-1);
    case 'review-file': return reviewFile();
    case 'review-organize': if (S.review && !S.reviewing) return organize([one()].filter(Boolean), { review: true }); return;
    case 'switch': return switchVault(value);
    case 'toggle-rail': S.rail = !S.rail; render(); return;
    case 'toggle-pane': S.pane = !S.pane; render(); if (S.pane && S.tab === 'preview' && one() && S.preview?.signature !== previewSignature(one())) void loadPreview(one()); return;
    case 'vault-menu': return vaultMenu(node);
    case 'new-menu': return showMenu(node, newItems());
    case 'manage-vault': return showMenu(node, menuItem('打开仓库', 'switch', { value, glyph: 'hard-drive' }) + menuItem('重命名', 'rename-vault', { value, glyph: 'square-pen' }) + (!getVault(value)?.parent_id ? menuItem('移除仓库', 'remove-vault', { value, glyph: 'ban', danger: true }) : ''));
    case 'new-vault': return newVault(true);
    case 'add-vault': return newVault(false);
    case 'rename-vault': return renameVault(getVault(value));
    case 'remove-vault': return removeVault(getVault(value));
    case 'pick-folder': {
      const form = node.closest('form'); node.disabled = true;
      try { const p = await host.choose(value); if (p && form.isConnected) { form.elements.path.value = p; if (!form.elements.name.value && value.includes('现有')) form.elements.name.value = basename(p); } }
      catch (error) { if (form.isConnected) dialogError(error); }
      finally { if (node.isConnected) node.disabled = false; }
      return;
    }
    case 'close-dialog': closeDialog(); return;
    case 'folder': return nav('physical', { folder: value });
    case 'category': return nav('category', { facet: value });
    case 'facet': return nav(S.page, { facet: value });
    case 'layout': prefs.layout = value; persist('layout', value); render(); return;
    case 'popup-choice': {
      const [name, option] = JSON.parse(value);
      if (['switch','rename-vault','remove-vault','new-vault','add-vault','scope','search-deep','search-content','nav','category','facet','open-view','rescan'].includes(name)) return action(name, option, node);
      return;
    }
    case 'sort': return updateSort(value);
    case 'sort-choice': if (value === 'asc' || value === 'desc') return updateSort(S.sort, value); return updateSort(value, value === S.sort ? S.direction : 'asc');
    case 'sort-direction': return updateSort(S.sort, value);
    case 'sort-menu': return showMenu(node, sortOptions.map(([id, label]) => menuItem(label, 'sort', { value: id, selected: S.sort === id })).join('') + menuLine + menuItem('升序', 'sort-direction', { value: 'asc', selected: S.direction === 'asc' }) + menuItem('降序', 'sort-direction', { value: 'desc', selected: S.direction === 'desc' }));
    case 'filters': return filterDialog();
    case 'remove-filter': {
      const [key, item] = JSON.parse(value);
      if (key === 'tags' || key === 'flags') S.filters[key] = S.filters[key].filter(v => v !== item);
      else if (key === 'category' || key === 'type') S.filters[key] = '';
      S.viewId = null; S.limit = 160; clearSelection(); render({ keepScroll: false });
      ($('.filter-chip') || $('[data-act=filters]'))?.focus({ preventScroll: true }); return;
    }
    case 'clear-filters': S.viewId = null; S.filters = clearFilters(); clearSelection(); render({ keepScroll: false }); return;
    case 'create-folder': return makeFolder();
    case 'category-new': return editCategory();
    case 'category-edit': return editCategory(S.facet);
    case 'category-delete': return deleteCategory();
    case 'category-menu': return showMenu(node, menuItem('编辑分类', 'category-edit', { glyph: 'square-pen' }) + menuItem('删除分类', 'category-delete', { glyph: 'trash', danger: true }));
    case 'tag-new': return editTag();
    case 'tag-edit': return editTag(S.facet);
    case 'tag-delete': return deleteTag();
    case 'tag-menu': return showMenu(node, menuItem('重命名标签', 'tag-edit', { glyph: 'square-pen' }) + menuItem('删除标签', 'tag-delete', { glyph: 'trash', danger: true }));
    case 'more-items': S.limit += 160; render(); return;
    case 'clear-selection': return clearAndSync();
    case 'asset-menu': return assetMenu(node, a);
    case 'bulk-menu': return showMenu(node, menuItem('从仓库排除…', 'exclude', { glyph: 'ban', disabled: !picked.some(i => !i.synthetic && !['excluded','missing'].includes(i.state)) }) + menuItem('复制真实路径', 'copy-paths', { glyph: 'copy' }) + menuLine + menuItem('移至回收站…', 'recycle', { glyph: 'trash', danger: true, disabled: picked.some(i => i.state === 'missing') }));
    case 'open-asset': return openAsset(a);
    case 'open-unit': return openAsset(a, true);
    case 'preview-one': return previewOne(a);
    case 'retry-preview': return loadPreview(one());
    case 'inspect-tab': S.tab = value; renderInspector(); inspector.querySelector('.c-seg__opt[aria-checked=true]')?.focus({ preventScroll: true }); if (value === 'preview' && one() && S.preview?.signature !== previewSignature(one())) await loadPreview(one()); return;
    case 'edit-text': return openEditor();
    case 'reload-draft': try { await compareExternal(); } catch (e) { dialogError(e); } return;
    case 'copy-draft': return clipboard(S.edited?.text || '');
    case 'use-disk-version': {
      const e = S.edited; if (!e?.external) return;
      if (isDirty() && !e.useExternal) { e.useExternal = true; dialogError('再次选择「采用磁盘版本」将替换草稿；如需保留，先复制草稿。'); return; }
      e.revision = e.external.revision; e.text = e.original = e.external.text ?? ''; e.external = null; e.useExternal = false;
      $('#editor').value = e.text; $('#editor-state').textContent = '已载入磁盘版本'; $('#external-version').hidden = true; modal.querySelector('.dialog-error').hidden = true; return;
    }
    case 'copy-value': return clipboard(value);
    case 'copy-paths': return clipboard(picked.map(extPath).join('\r\n'));
    case 'choose-file': if (a) { await host.file(a.vaultId, a.id, 'choose'); remember(a); } return;
    case 'reveal': if (a) await host.file(a.vaultId, a.id, 'reveal'); return;
    case 'file-properties': if (a) await host.file(a.vaultId, a.id, 'properties'); return;
    case 'run': return runFile(a);
    case 'organize': return organize(picked);
    case 'organize-one': return a && organize([a]);
    case 'file-in': return batchOrganize(picked.filter(i => i.state === 'inbox' && !i.synthetic), { state: 'filed' }, '已入库');
    case 'file-in-one': return a && batchOrganize([a], { state: 'filed' }, '已入库');
    case 'restore': return batchOrganize(picked.filter(i => i.state === 'excluded'), { state: 'inbox' }, '已重新纳入');
    case 'restore-one': return a && batchOrganize([a], { state: 'inbox' }, '已重新纳入');
    case 'exclude': return exclude(picked);
    case 'exclude-one': return a && exclude([a]);
    case 'recycle': return recycle(picked);
    case 'recycle-one': return a && recycle([a]);
    case 'rename-file': return renameFile(a);
    case 'move': return move(picked);
    case 'move-one': return a && move([a]);
    case 'add-flag-chip': { const control = node.closest('form').elements.flags; control.value = unique([...parseLabels(control.value), value]).join('，'); return; }
    case 'recover-identity': return recover(a);
    case 'close-results': if (S.batch) { unmount(S.batch); S.batch.remove(); S.batch = null; } return;
    case 'rescan': return scan();
    case 'duplicates-refresh': return getDuplicates();
    case 'retry': return S.booting || !S.id ? boot() : refreshView();
    case 'hide-warning': S.notice = ''; render(); return;
    case 'view-config': return viewConfig();
    case 'load-access': return readAccess(S.id, true);
    case 'undo': {
      const id = S.id;
      if (id && await ask('撤销上一次可撤销的操作？', '并非所有磁盘操作都可撤销。vaulta 会在安全的情况下恢复最近一次可撤销的变更。', { symbol: 'undo', submit: '撤销' })) {
        await host.mutate(id, { type: 'undo' }); await afterChanges([id]); toast('已撤销');
      } return;
    }
    case 'search-menu': return searchMenu(node);
    case 'scope': if (value === 'selected') return selectedScope(); S.scope = value; if (S.query.trim()) beginSearch(S.query, true); else render(); return;
    case 'search-deep': S.deep = !S.deep; if (S.query.trim()) beginSearch(S.query, true); else render(); return;
    case 'search-content': S.content = !S.content; if (S.query.trim()) beginSearch(S.query, true); else render(); return;
  }
}
function perform(name, value, node) {
  const task = action(name, value, node);
  task.catch(error => { if (modal.open) dialogError(error); else toast(msg(error), 'error', 6500); });
}
document.addEventListener('click', event => {
  const node = event.target.closest('[data-act]');
  if (node?.hasAttribute('data-gd-control')) return;
  if (node && !node.disabled) { event.preventDefault(); perform(node.dataset.act, node.dataset.value, node); return; }
  if (!pop.contains(event.target)) closeMenu(false);
  if (event.target.closest('input,button,a')) return;
  const tile = event.target.closest('[data-asset]');
  if (tile) { selectedKeys(tile.dataset.asset, event.ctrlKey || event.metaKey, event.shiftKey); tile.focus({ preventScroll: true }); }
});
document.addEventListener('dblclick', event => {
  if (event.target.closest('input,button,a')) return;
  const node = event.target.closest('[data-asset]');
  if (node) perform('open-asset', node.dataset.asset, node);
});
document.addEventListener('contextmenu', event => {
  const node = event.target.closest('[data-asset]'); if (!node || modal.open) return;
  event.preventDefault();
  if (!S.selected.has(node.dataset.asset)) selectedKeys(node.dataset.asset, false, false);
  assetMenu(node, resolveItem(node.dataset.asset), { x: event.clientX, y: event.clientY });
});
document.addEventListener('change', event => {
  const node = event.target;
  if (node.hasAttribute('data-select-all')) selectAll(node.checked);
  else if (node.dataset.assetCheck) selectedKeys(node.dataset.assetCheck, true, false);
  else if (node.dataset.setting === 'theme') { prefs.theme = node.value; persist('theme', node.value); setTheme(); }
  else if (node.dataset.setting === 'titlebar') perform('titlebar-mode', node.value, node);
  else if (node.dataset.setting === 'layout') perform('layout', node.value, node);
  else if (node.dataset.setting === 'agent') setAccess(node.value).catch(error => toast(msg(error), 'error'));
});
let composing = false, commandComposing = false;
document.addEventListener('compositionstart', e => { if (e.target.id === 'query') composing = true; else if (e.target.id === 'command-query') commandComposing = true; });
document.addEventListener('compositionend', e => { if (e.target.id === 'query') { composing = false; beginSearch(e.target.value); } else if (e.target.id === 'command-query') { commandComposing = false; filterCommands(e.target.value); } });
document.addEventListener('input', event => {
  if (event.target.id === 'query' && !event.target.hasAttribute('data-gd-control') && !composing && !event.isComposing) beginSearch(event.target.value);
  if (event.target.id === 'command-query' && !event.target.hasAttribute('data-gd-control') && !commandComposing && !event.isComposing) filterCommands(event.target.value);
  if (event.target.id === 'editor' && S.edited) {
    S.edited.text = event.target.value; S.edited.abandon = false; S.edited.useExternal = false;
    $('#editor-state').textContent = isDirty() ? '有未保存的修改' : '未修改';
  }
});
document.addEventListener('submit', event => { if (event.target.id === 'search-form') { event.preventDefault(); if (!composing) beginSearch($('#query').value, true); } });
document.addEventListener('keydown', e => {
  if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
  const ctrl = e.ctrlKey || e.metaKey, key = e.key;
  if (modal.open || commandDialog.open) { if (modal.open && ctrl && key.toLowerCase() === 's' && S.edited) { e.preventDefault(); $('#dialog-form').requestSubmit(); } return; }
  if (!pop.hidden) {
    if (key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const items = [...pop.querySelectorAll('button:not(:disabled)')];
    if (['ArrowDown','ArrowUp','Home','End'].includes(key) && items.length) {
      e.preventDefault(); const i = items.indexOf(document.activeElement), n = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (i + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[n].focus(); return;
    }
    if (key === 'Tab') closeMenu();
    else return;
  }
  if (ctrl && e.shiftKey && key.toLowerCase() === 'p') { e.preventDefault(); showCommands(); return; }
  if (ctrl && key.toLowerCase() === 'k') { e.preventDefault(); $('#query')?.focus(); $('#query')?.select(); return; }
  if (e.target.closest('input,textarea,select,[contenteditable],[role=separator]')) return;
  if (configurationPage()) return;
  const tile = e.target.closest('[data-asset]'), a = tile ? resolveItem(tile.dataset.asset) : one();
  if (ctrl && key.toLowerCase() === 'a') { e.preventDefault(); selectAll(true); }
  else if (key === 'Escape') clearAndSync();
  else if (key === 'Enter' && a && !e.target.closest('button')) { e.preventDefault(); perform('open-asset', assetKey(a), tile); }
  else if (key === ' ' && a && !e.target.closest('button')) { e.preventDefault(); previewOne(a); }
  else if (key === 'F2' && a && !a.synthetic && !['excluded','missing'].includes(a.state)) { e.preventDefault(); renameFile(a); }
  else if (key === 'F5') { e.preventDefault(); perform('rescan'); }
  else if (key === 'Delete' && S.selected.size) { e.preventDefault(); recycle(selection()); }
  else if (tile && ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(key)) {
    e.preventDefault(); const rows = [...$('#items').querySelectorAll('[data-asset]')]; const i = rows.indexOf(tile);
    const cols = prefs.layout === 'grid' ? Math.max(1, getComputedStyle($('#items')).gridTemplateColumns.split(' ').length) : 1;
    const shift = key === 'ArrowUp' ? -cols : key === 'ArrowDown' ? cols : key === 'ArrowLeft' ? -1 : 1;
    const dest = rows[i + shift]; if (dest) { selectedKeys(dest.dataset.asset, ctrl, e.shiftKey); dest.focus(); }
  }
});
let eventTimer, listening = false;
function changed(payload) {
  const id = typeof payload === 'string' ? payload : '';
  if (id) S.changed.add(id); S.pendingChanges.add(id);
  clearTimeout(eventTimer); eventTimer = setTimeout(flushChanges, 260);
}
async function flushChanges() {
  if (isDirty() || !S.pendingChanges.size) return;
  const received = [...S.pendingChanges]; S.pendingChanges.clear();
  if (received.includes('')) {
    try { await loadRegistry(); } catch (error) { toast(msg(error), 'error'); }
    for (const v of S.registry) S.changed.add(v.id);
  }
  if (S.id && (received.includes(S.id) || received.includes(''))) await refreshView(S.id, false);
  else if (received.includes('')) render();
  if (S.page === 'search' && S.query.trim()) await doSearch({ preserve: true });
  if (S.page === 'marking' || received.includes('') || received.some(id => id && id !== S.id)) void loadMarking();
  if (S.page === 'duplicates' && (received.includes(S.id) || received.includes(''))) void getDuplicates();
  const applies = id => received.includes(id) || received.includes('');
  if (S.page === 'settings' && S.id && applies(S.id)) void readAccess(S.id, true);
  const item = one();
  if (!S.edited && item && S.pane && S.tab === 'preview' && applies(item.vaultId) && S.preview?.signature !== previewSignature(item)) void loadPreview(item, { used: false });
}
function warning(payload) {
  const message = payload?.message; if (!message) return;
  if (!payload.vault_id || payload.vault_id === S.id) { S.notice = message; if (!isDirty()) render(); }
  toast(message, 'warn', 6500);
}
async function boot() {
  S.booting = connected(); S.error = ''; render();
  if (!connected()) { S.booting = false; renderStatus(); return; }
  try {
    if (!listening) { listening = true; host.listen(changed, warning).catch(error => { listening = false; toast(msg(error), 'warn'); }); }
    await loadRegistry();
    const last = stored('active', null), initial = getVault(last) || roots()[0];
    if (initial) { await switchVault(initial.id, 'all'); void loadMarking(); }
  } catch (error) { S.error = msg(error); }
  finally { S.booting = false; render(); }
}
void installGlassDefinitions();
await installGlass(perform);
await installWindowChrome();
void boot();
