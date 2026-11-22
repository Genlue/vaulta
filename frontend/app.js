import { viewPages, restoreViews, matchCommands, vaultSubtree } from './workflows.js';
import { widget, mount, unmount, redraw, updateWidget, installGlass, installGlassDefinitions } from './glass.js';
import { officePreview } from './document-preview.js';
import { host, connected } from './host.js';
import { createUpdates } from './updates.js';
import { installWindowChrome, canUseWindowChrome, getWindowChromeMode, setWindowChromeMode } from './window-chrome.js';
import { arr, unique, norm, pathKey, parentPath, splitPath, basename, absolute, containsPath, relative, normalizeSnapshot, makeCategoryIndex, ancestry,
  categoryOptions, folderIndex, visibleAssets, treeRows, searchAssets, assetType, assetKey, isDir, formatDate, formatBytes, defaultFlags, collator, markable, withinBoundary } from './model.js';
import { esc, icon, act, button, ib, pill, visual, statePill, field, labeled, select, check, menuItem, menuLine, menuCaption, blank, infoRow, assetCard, assetRow, lines, segmented, settingSelect, inlineNotice } from './ui.js';

const $ = selector => document.querySelector(selector);
const chrome = $('#chrome'), gripHost = $('#rail-grip'), rail = $('#rail'), dockHost = $('#dock'), workspace = $('#workspace'), inspector = $('#inspector'), status = $('#status'), pop = $('#pop'), modal = $('#modal');
function stored(key, fallback) { try { return JSON.parse(localStorage.getItem(`vaulta.${key}`)) ?? fallback; } catch { return fallback; } }
function persist(key, value) { try { localStorage.setItem(`vaulta.${key}`, JSON.stringify(value)); } catch {} }
const prefs = { railWidth: stored('rail-width', null), inspectWidth: stored('inspect-width', null), nav: stored('nav', 'rail'), confirmMove: stored('confirm-move', true) !== false, theme: stored('theme', 'system'), layout: stored('layout', 'list'), foldersFirst: stored('folders-first', true) !== false, docPreview: stored('doc-preview', 'flow'), recent: new Map(stored('recent', [])), views: restoreViews(stored('views.v1', [])) };
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
const setTheme = () => { document.documentElement.dataset.theme = prefs.theme === 'system' ? (systemTheme.matches ? 'dark' : 'light') : prefs.theme; };
setTheme(); systemTheme.addEventListener('change', setTheme);
const clearFilters = () => ({ category: '', flags: [], type: '' });
const viewHistory = { stack: [], index: -1, lock: false };
const S = { registry: [], cache: new Map(), id: null, page: 'home', facet: '', folder: '', filters: clearFilters(), selected: new Set(), anchor: null, multi: false,
  review: false, reviewing: false, viewId: null, pane: true, deferFolderPane: false, tab: 'details', rail: true, items: [], rows: [], expanded: new Map(), byKey: new Map(), limit: 160, sort: 'name', direction: 'asc',
  edited: null, preview: null, previewToken: 0, loading: false, scanning: null, booting: true, error: '', notice: '',
  dup: null, dupToken: 0, registryToken: 0, changed: new Set(), pendingChanges: new Set(),
  query: '', scope: 'current', scopeIds: [], deep: false, content: false, searching: false, searchItems: [], searchErrors: [], searchToken: 0, searchCount: 0,
  api: null, access: new Map(), accessLoading: new Set() };
const EMPTY_SNAPSHOT = { assets: [], categories: [], tags: [], history: [] };
const snapshotIndexes = new WeakMap();
function getSnapshotIndex(s) {
  let cached = snapshotIndexes.get(s);
  if (!cached) {
    const folders = folderIndex(s.assets);
    const inboxByFolder = new Map();
    let inbox = 0;
    for (const a of s.assets) {
      if (a.state !== 'inbox') continue;
      inbox++;
      if (a.synthetic || !withinBoundary(a, folders.units)) continue;
      const parts = splitPath(a.rel);
      for (let i = 1; i <= parts.length; i++) {
        const key = pathKey(parts.slice(0, i).join('/'));
        let list = inboxByFolder.get(key);
        if (!list) { list = []; inboxByFolder.set(key, list); }
        list.push(a);
      }
    }
    cached = {
      folders,
      categories: makeCategoryIndex(s.categories),
      flags: unique([...defaultFlags, ...s.assets.flatMap(a => a.flags)]).sort(collator.compare),
      inbox,
      inboxByFolder,
    };
    snapshotIndexes.set(s, cached);
  }
  return cached;
}
const vault = () => S.cache.get(S.id)?.vault || S.registry.find(v => v.id === S.id);
const snap = () => S.cache.get(S.id) || EMPTY_SNAPSHOT;
const getVault = id => S.cache.get(id)?.vault || S.registry.find(v => v.id === id);
const sourceName = id => {
  const v = getVault(id);
  if (!v) return '仓库';
  if (v.parent_id) return `${sourceName(v.parent_id)} / ${v.name}`;
  return v.name;
};
const folderInboxItems = folder => {
  if (!folder) return [];
  const vaultId = folder.vaultId || S.id;
  const s = S.cache.get(vaultId) || snap();
  return getSnapshotIndex(s).inboxByFolder.get(pathKey(folder.rel)) || [];
};
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
const expandedPaths = (id, scope = 'tree') => { const key = `${id}:${scope}`; if (!S.expanded.has(key)) S.expanded.set(key, new Set()); return S.expanded.get(key); };
const expandScope = () => S.page === 'inbox' ? 'inbox' : 'tree';
let catIndex, folders, flags;
const libraryPages = new Set(['all', 'physical', 'category', 'flags', 'recent', 'duplicates', 'excluded', 'missing', 'history']);
const markChoices = [...defaultFlags, '已核对'];

const pages = {
  home: ['仓库', 'house'], inbox: ['收件箱', 'inbox', '磁盘上发现、但还没加入资料库的文件，按文件夹分组；可以展开逐个入库，或把整个文件夹设为整体单元。'],
  all: ['资料库', 'bookmark', '已入库的资产，按磁盘文件夹分层显示；展开文件夹即可看到里面的文件。'], physical: ['文件', 'folder-tree', '按磁盘目录浏览。这里始终显示文件夹里的全部内容，不受入库状态影响。'],
  category: ['分类', 'layers', '主分类只改变逻辑归属，不会移动原文件。'],
  flags: ['标记', 'flag', '标记用来记录关注状态，不影响分类或磁盘路径。'], recent: ['最近使用', 'clock', '显示在本机通过 Vaulta 打开或预览过的资产。'],
  duplicates: ['重复文件', 'copy', '按文件内容识别完全重复的资产。每一份原文件都会保留。'],
  excluded: ['已排除', 'ban', '这些项目保留在磁盘上，但不参与常规浏览和搜索。'],
  missing: ['已缺失', 'triangle-alert', '磁盘上找不到这些资产。只有确认身份后才应关联到其他文件。'],
  history: ['操作历史', 'clock'], settings: ['设置', 'settings'], search: ['搜索结果', 'search', '按文件名、路径、分类和标记查找。'],
};
const sortOptions = [['name', '名称'], ['modified', '修改日期'], ['created', '创建日期'], ['size', '大小'], ['type', '类型'], ['path', '路径']];
const typeOptions = [['', '所有类型'], ['file', '所有文件'], ['folder', '文件夹与整体单元'], ['image', '图像'], ['video', '视频'], ['audio', '音频'], ['document', '文档与其他文件']];
const scopeOptions = [['current', '当前仓库'], ['selected', '所选仓库'], ['all', '全部仓库']];
const themeOptions = [['system', '跟随系统'], ['light', '浅色'], ['dark', '深色']];
const effectOptions = [['auto', '完整效果'], ['blur', '仅模糊'], ['solid', '性能优先']];
const titlebarOptions = [['native', 'Windows 原生'], ['traffic-lights', 'macOS 红绿灯']];
const navOptions = [['rail', '侧边栏'], ['dock', '悬浮导航栏']];
const moveConfirmOptions = [['on', '每次确认'], ['off', '直接移动']];
const accessOptions = [['off', '关闭'], ['read', '只读'], ['write', '读取与整理']];

function toast(text, kind = 'ok', duration = 4200) {
  // Same glass material and entrance as GlassDesign's ToastHost; the host owns
  // placement, copy and the close affordance.
  const node = document.createElement('div');
  node.className = `va-toast c-toast${kind === 'error' ? ' c-toast--danger' : kind === 'warn' ? ' va-toast--warning' : ''}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `${icon(kind === 'ok' ? 'circle-check' : kind === 'error' ? 'triangle-alert' : 'info', 17)}<span class="va-toast__text">${esc(text)}</span><button type="button" class="va-toast__close" aria-label="关闭提示">${icon('x', 14)}</button>`;
  node.querySelector('button').onclick = () => node.remove(); const shelf = $('#toasts'); shelf.append(node);
  while (shelf.childElementCount > 1) shelf.firstElementChild.remove();
  setTimeout(() => node.remove(), duration);
}
function indexItems() {
  const s = snap(); const cached = getSnapshotIndex(s); catIndex = cached.categories; folders = cached.folders; flags = cached.flags;
  S.items = configurationPage() ? [] : visibleAssets({ assets: s.assets, folders, categories: catIndex, page: S.page, folder: S.folder, facet: S.facet, filters: S.filters,
    recent: prefs.recent, duplicates: S.dup?.map || new Map(), searchItems: S.searchItems, sort: S.page === 'recent' && S.sort === 'name' ? 'recent' : S.sort, direction: S.direction, foldersFirst: prefs.foldersFirst });
  // 资料库 reads as a tree over the disk layout; every other page keeps its
  // flat result list (facets and search are cross-folder by nature). The inbox
  // groups incoming files under their folders so a dropped folder stays one
  // decision instead of a wall of files.
  const treePage = (S.page === 'all' || S.page === 'inbox') && !filterCount();
  S.rows = treePage
    ? treeRows({ items: S.items, folders, expanded: expandedPaths(S.id, expandScope()), sort: S.sort, direction: S.direction, foldersFirst: prefs.foldersFirst })
      .map(row => ({ ...row, trail: row.folder ? '' : parentPath(row.item.rel), context: S.page === 'inbox' && row.folder }))
    : S.items.map(item => ({ item, folder: isDir(item), depth: 0, open: false, hasChildren: false, count: 0, tree: false, context: false }));
  const contextItems = S.rows.filter(row => row.context).map(row => row.item);
  S.byKey = new Map([...S.items, ...contextItems].map(item => [assetKey(item), item]));
  for (const key of S.selected) if (!S.byKey.has(key)) S.selected.delete(key);
  if (!S.selected.size) S.multi = false;
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
  $('#app').classList.toggle('nav-dock', prefs.nav === 'dock');
  applyInspectWidth(); renderDock();
  renderChromeInto(); renderRailGrip(); redraw(rail, renderRail()); redraw(workspace, renderWorkspace()); renderInspector(); renderStatus();
  if (docsOpen && $('.agent-docs')) $('.agent-docs').open = true;
  if (S.batch?.dataset.location === `${S.id}:${S.page}`) { ($('#stage > .asset-intro') || $('#stage'))?.prepend(S.batch); mount(S.batch); }
  syncSelectAll();
  if (keepScroll) [$('#stage'), $('#rail-scroll'), $('#inspect-scroll')].forEach((e, i) => { if (e) e.scrollTop = scrolling[i]; });
  attachVeil();
  if (searchFocused) { const input = $('#query'); input?.focus({ preventScroll: true }); if (input && document.activeElement === input && cursor[0] != null) input.setSelectionRange(...cursor); }
  else if (focusData) [...document.querySelectorAll(focusSelector)].find(e => e.dataset.asset === focusData || e.dataset.assetCheck === focusData)?.focus({ preventScroll: true });
  else if (focusRegion && focusedSegment && !prev.isConnected) {
    const matching = [...focusRegion.querySelectorAll('[data-gd-widget=segmented]')].find(e => e.dataset.gdKey === focusedSegment[0]);
    const target = [...(matching?.querySelectorAll('.c-seg__opt') || [])].find(e => e.dataset.value === focusedSegment[1]);
    target?.focus({ preventScroll: true });
  } else if (focusRegion && focusAction[0] && !prev.isConnected) [...focusRegion.querySelectorAll('[data-act]')].find(e => e.dataset.act === focusAction[0] && e.dataset.value === focusAction[1])?.focus({ preventScroll: true });
  hydrateThumbs();
}

// Grid thumbnails are requested only for cards near the viewport, four at a
// time, and cached by asset revision. A failed or unsupported file keeps its
// type glyph instead of leaving a broken image in the grid.
const thumbCache = new Map(), thumbFailed = new Set(), thumbQueue = [];
let thumbObserver = null, thumbRoot = null, thumbActive = 0, thumbBytes = 0;
const THUMB_PARALLEL = 4, THUMB_CACHE = 240, THUMB_BYTES = 24 * 1024 * 1024;
function showThumb(img, url) {
  img.src = url; img.dataset.thumbState = 'done';
  img.closest('.tile-art')?.classList.add('has-image');
}
function failThumb(img) {
  img.closest('.tile-art')?.classList.add('thumb-failed');
  img.remove();
}
function rememberThumb(key, url) {
  const previous = thumbCache.get(key);
  if (previous) { thumbBytes -= previous.length; thumbCache.delete(key); }
  thumbCache.set(key, url); thumbBytes += url.length;
  while ((thumbBytes > THUMB_BYTES || thumbCache.size > THUMB_CACHE) && thumbCache.size) {
    const [oldKey, oldUrl] = thumbCache.entries().next().value;
    thumbCache.delete(oldKey); thumbBytes -= oldUrl.length;
  }
}
function pumpThumbs() {
  while (thumbActive < THUMB_PARALLEL && thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img.isConnected || img.dataset.thumbState !== 'queued') continue;
    img.dataset.thumbState = 'loading'; thumbActive++;
    host.thumbnail(img.dataset.thumbVault, img.dataset.thumbAsset)
      .then(url => { rememberThumb(img.dataset.thumb, url); if (img.isConnected) showThumb(img, url); })
      .catch(() => { thumbFailed.add(img.dataset.thumb); while (thumbFailed.size > 500) thumbFailed.delete(thumbFailed.values().next().value); if (img.isConnected) failThumb(img); })
      .finally(() => { img.dataset.thumbState = 'done'; thumbActive--; pumpThumbs(); });
  }
}
function hydrateThumbs() {
  const stage = $('#stage');
  if (prefs.layout !== 'grid' || !stage) { thumbObserver?.disconnect(); return; }
  const imgs = [...stage.querySelectorAll('img.tile-thumb')];
  if (!imgs.length) { thumbObserver?.disconnect(); return; }
  // `render` rebuilds #stage, so an observer bound to the old scroll root would
  // never see the new cards. Rebind whenever the root element changes.
  if (thumbObserver && thumbRoot !== stage) { thumbObserver.disconnect(); thumbObserver = null; }
  thumbRoot = stage;
  thumbObserver ??= new IntersectionObserver(entries => {
    const observer = thumbObserver;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.dataset.thumbState = 'queued';
      thumbQueue.push(entry.target);
    }
    pumpThumbs();
  }, { root: stage, rootMargin: '320px 0px' });
  thumbObserver.disconnect();
  for (const img of imgs) {
    const key = img.dataset.thumb;
    if (thumbFailed.has(key)) { failThumb(img); continue; }
    const cached = thumbCache.get(key);
    if (cached) { showThumb(img, cached); continue; }
    if (img.dataset.thumbState) continue;
    thumbObserver.observe(img);
  }
}
let veilStage = null;
function attachVeil() {
  const stage = $('#stage'), veil = $('#topveil');
  if (!stage || !veil) return;
  if (veilStage !== stage) {
    veilStage = stage;
    stage.addEventListener('scroll', () => { veil.dataset.on = stage.scrollTop > 2 ? '1' : '0'; }, { passive: true });
  }
  veil.dataset.on = stage.scrollTop > 2 ? '1' : '0';
}
// Preserve the live SearchField on results/scan redraws. Recreate it only when
// the host actually replaces the query; this also preserves an IME composition.
const capsule = (contents, className, size = 'auto', variant = '') => widget('capsule', { size, ...(variant ? { className: variant } : {}) }, { className, fallback: contents, tag: 'div' });
const viewState = () => ({ id: S.id, page: S.page, facet: S.facet, folder: S.folder, filters: structuredClone(S.filters), viewId: S.viewId, sort: S.sort, direction: S.direction });
const sameView = (a, b) => !!a && !!b && a.id === b.id && a.page === b.page && a.facet === b.facet && a.folder === b.folder
  && a.viewId === b.viewId && a.sort === b.sort && a.direction === b.direction
  && JSON.stringify(a.filters) === JSON.stringify(b.filters);
function paintNavPair() {
  const slot = $('#navpair-slot');
  if (!slot) return;
  if (!slot.querySelector('[data-act="history-back"]')) {
    redraw(slot, capsule(
      `<button type="button" class="c-navpair__btn" data-act="history-back" aria-label="后退" title="后退（Alt+←）">${icon('chevron-left', 17)}</button><span class="c-navpair__sep"></span><button type="button" class="c-navpair__btn" data-act="history-forward" aria-label="前进" title="前进（Alt+→）">${icon('chevron-right', 17)}</button>`,
      'navpair-glass', 'auto', 'c-capsule--nav'));
  }
  const back = slot.querySelector('[data-act="history-back"]'), forward = slot.querySelector('[data-act="history-forward"]');
  if (back) back.disabled = viewHistory.index <= 0;
  if (forward) forward.disabled = viewHistory.index >= viewHistory.stack.length - 1;
}
function recordView() {
  if (viewHistory.lock || !S.id || S.page === 'search') return paintNavPair();
  const next = viewState(), current = viewHistory.stack[viewHistory.index];
  if (sameView(next, current)) return paintNavPair();
  viewHistory.stack = viewHistory.stack.slice(0, viewHistory.index + 1);
  viewHistory.stack.push(next);
  if (viewHistory.stack.length > 60) viewHistory.stack.shift();
  viewHistory.index = viewHistory.stack.length - 1;
  paintNavPair();
}
async function goHistory(delta) {
  const next = viewHistory.index + delta;
  if (viewHistory.lock || next < 0 || next >= viewHistory.stack.length) return;
  const entry = viewHistory.stack[next];
  if (!getVault(entry.id)) return toast('这个仓库已不可用。', 'warn');
  viewHistory.index = next; viewHistory.lock = true;
  try {
    if (entry.id !== S.id) {
      S.id = entry.id; persist('active', entry.id); S.dup = null; S.dupToken++;
      await loadSnapshot(entry.id, false);
    }
    S.page = entry.page; S.facet = entry.facet; S.folder = entry.folder;
    S.filters = structuredClone(entry.filters); S.viewId = entry.viewId;
    S.sort = entry.sort; S.direction = entry.direction;
    S.query = ''; S.searchToken++; S.searchItems = []; S.searchOrigin = null;
    S.review = false; S.error = ''; S.limit = 160;
    clearSelection();
    render({ keepScroll: false });
    if (S.page === 'duplicates') void getDuplicates();
    if (S.page === 'settings') void readApi();
  } catch (error) { toast(msg(error), 'error'); }
  finally { viewHistory.lock = false; paintNavPair(); }
}
function renderChromeInto() {
  if (!$('#rail-toggle')) redraw($('#rail-toggle-slot'), capsule('<div id="rail-toggle"></div>', 'chrome-round', 'round'));
  if (!$('#search-form')) {
    const shell = `<div class="chrome-main">
      <div class="chrome-lead"><div id="navpair-slot"></div>${capsule('<div class="vault-loc"></div>', 'vault-glass')}</div>
      ${capsule('<form class="searchbar" id="search-form" role="search"><span id="query-slot"></span><kbd title="聚焦搜索">Ctrl K</kbd><div id="query-scope"></div></form>', 'search-glass')}
      <div class="chrome-actions"></div></div>`;
    redraw(chrome, widget('toolbar', {}, { fallback: shell, tag: 'div', className: 'vaulta-toolbar' }));
    // The empty parts of the topbar are the drag region; the search field and
    // every capsule control stay clickable.
    chrome.querySelector('.c-topbar')?.removeAttribute('data-tauri-drag-region');
  }
  redraw($('#rail-toggle'), ib(`${S.rail ? '隐藏' : '显示'}${prefs.nav === 'dock' ? '导航' : '侧栏'}`, 'toggle-rail', 'panel-left', { attrs: `aria-expanded="${S.rail}"` }));
  redraw($('.vault-loc'), vaultPicker());
  const old = $('#query'), disabled = !S.registry.length;
  if (!old || old.disabled !== disabled || (!composing && old.value !== S.query)) {
    redraw($('#query-slot'), widget('search-field', { id: 'query', value: S.query, placeholder: '搜索资产', label: '搜索资产 · Ctrl+K', width: 320, disabled }, {
      key: 'top-search', className: 'query-field', action: 'search-input', fallback: `<div class="c-field"><input id="query" class="c-field__input" type="search" aria-label="搜索资产" autocomplete="off" placeholder="搜索资产 · Ctrl+K" value="${esc(S.query)}" ${disabled ? 'disabled' : ''}></div>`
    }));
  }
  redraw($('#query-scope'), searchPicker({ disabled, compact: true }));
  // One capsule per action: 快捷指令 and 自动详情 are independent switches, and
  // sharing a capsule made them read as one control.
  redraw($('.chrome-actions'), `${capsule(ib('快捷指令 · Ctrl+Shift+P', 'command-palette', 'list-filter', { attrs: 'aria-keyshortcuts="Control+Shift+P" aria-haspopup="dialog"' }), 'chrome-round', 'round')}${!configurationPage() ? capsule(ib(S.deferFolderPane ? '显示详情栏' : S.pane ? '关闭自动详情' : '启用自动详情', 'toggle-pane', 'panel-right', { attrs: `aria-pressed="${S.pane && !S.deferFolderPane}"` }), 'chrome-round', 'round') : ''}`);
  paintNavPair();
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
let resizeFrame = 0;
window.addEventListener('resize', () => {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    if (gripHost.firstElementChild) renderRailGrip();
    applyInspectWidth();
    renderInspectGrip();
  });
});
window.addEventListener('pagehide', () => {
  if (prefs.railWidth != null) persist('rail-width', prefs.railWidth);
  if (prefs.inspectWidth != null) persist('inspect-width', prefs.inspectWidth);
});

// ---- Inspector divider ---------------------------------------------------
// The panel is right-anchored, so its leading edge is driven by width: dragging
// left widens it. The widget owns the same 9px hit area and 1px visual line as
// the rail grip; only the value direction is inverted here.
const inspectMin = 236, inspectDefault = 302, inspectMax = 1600;
const inspectGripHost = $('#inspect-grip');
function inspectLimit() {
  const reserved = Math.max(340, (S.rail && prefs.nav !== 'dock' ? effectiveRailWidth() : 0) + 200);
  return Math.max(inspectMin, Math.min(inspectMax, innerWidth - reserved));
}
function effectiveInspectWidth() { return Math.max(inspectMin, Math.min(inspectLimit(), Number.isInteger(prefs.inspectWidth) ? prefs.inspectWidth : inspectDefault)); }
function applyInspectWidth() { $('#app').style.setProperty('--inspect-width', `${effectiveInspectWidth()}px`); }
function renderInspectGrip() {
  const visible = !inspector.hidden && !configurationPage();
  inspectGripHost.hidden = !visible;
  if (!visible) return;
  if (!inspectGripHost.firstChild) {
    inspectGripHost.innerHTML = '<div class="c-resizer" data-axis="x" role="separator" aria-orientation="vertical" tabindex="0" aria-label="调整详情栏宽度" aria-controls="inspector"></div>';
  }
  const grip = inspectGripHost.firstElementChild, width = effectiveInspectWidth();
  grip.setAttribute('aria-valuemin', inspectMin);
  grip.setAttribute('aria-valuemax', inspectLimit());
  grip.setAttribute('aria-valuenow', width);
  grip.setAttribute('aria-valuetext', `${width} px`);
}
let saveInspectTimer;
function resizeInspector(value) {
  const width = Math.round(Number(value));
  if (!Number.isFinite(width)) return;
  prefs.inspectWidth = Math.max(inspectMin, Math.min(inspectLimit(), width));
  applyInspectWidth();
  const grip = inspectGripHost.firstElementChild;
  if (grip) { grip.setAttribute('aria-valuenow', prefs.inspectWidth); grip.setAttribute('aria-valuetext', `${prefs.inspectWidth} px`); }
  clearTimeout(saveInspectTimer);
  saveInspectTimer = setTimeout(() => persist('inspect-width', prefs.inspectWidth), 160);
}
let inspectDrag = null;
inspectGripHost.addEventListener('pointerdown', event => {
  const grip = event.target.closest('.c-resizer');
  if (!grip || event.button !== 0 || !event.isPrimary || inspectDrag) return;
  try { grip.setPointerCapture(event.pointerId); } catch { return; }
  event.preventDefault();
  grip.focus({ preventScroll: true });
  grip.dataset.active = '1';
  document.documentElement.dataset.resizing = 'x';
  inspectDrag = { id: event.pointerId, x: event.clientX, width: effectiveInspectWidth() };
});
let inspectMoveFrame = 0, inspectPendingX = 0;
inspectGripHost.addEventListener('pointermove', event => {
  if (!inspectDrag || event.pointerId !== inspectDrag.id) return;
  inspectPendingX = event.clientX;
  if (inspectMoveFrame) return;
  inspectMoveFrame = requestAnimationFrame(() => {
    inspectMoveFrame = 0;
    if (inspectDrag) resizeInspector(inspectDrag.width - (inspectPendingX - inspectDrag.x));
  });
});
function endInspectDrag(event) {
  if (!inspectDrag || (event && event.pointerId !== inspectDrag.id)) return;
  if (inspectMoveFrame) { cancelAnimationFrame(inspectMoveFrame); inspectMoveFrame = 0; }
  inspectDrag = null;
  delete document.documentElement.dataset.resizing;
  const grip = inspectGripHost.firstElementChild;
  if (grip) delete grip.dataset.active;
  if (prefs.inspectWidth != null) persist('inspect-width', prefs.inspectWidth);
}
inspectGripHost.addEventListener('pointerup', endInspectDrag);
inspectGripHost.addEventListener('pointercancel', endInspectDrag);
inspectGripHost.addEventListener('lostpointercapture', endInspectDrag);
inspectGripHost.addEventListener('keydown', event => {
  if (!event.target.closest('.c-resizer') || event.isComposing || event.ctrlKey || event.altKey || event.metaKey) return;
  const step = event.shiftKey ? 24 : 8, current = effectiveInspectWidth();
  const next = event.key === 'ArrowLeft' ? current + step : event.key === 'ArrowRight' ? current - step
    : event.key === 'Home' ? inspectMin : event.key === 'End' ? inspectLimit() : null;
  if (next == null) return;
  event.preventDefault();
  resizeInspector(next);
  persist('inspect-width', prefs.inspectWidth);
});
// Shared dropdown surface; filesystem context menus remain pointer-anchored native markup.
function popupWidget(label, glyph, items, fallback, className = 'c-btn--sm') {
  return widget('menu', { label, icon: glyph, className, items: items.map(({ label, icon, name, value, ...attrs }) => ({
    id: JSON.stringify([name, value ?? null]), label, icon, ...attrs,
  })) }, { action: 'popup-choice', fallback });
}
function vaultPicker() {
  const current = vault();
  const iconName = current?.parent_id ? 'layers' : 'hard-drive';
  const label = current ? (current.parent_id ? `${sourceName(current.parent_id)} / ${current.name}` : current.name) : '本地工作区';
  const choices = [];
  for (const root of roots()) {
    choices.push({ label: root.name, icon: 'hard-drive', name: 'switch', value: root.id, checked: root.id === S.id });
    const units = S.registry.filter(u => u.parent_id === root.id);
    for (const u of units) {
      choices.push({ label: `  └ ${u.name}`, icon: 'layers', name: 'switch', value: u.id, checked: u.id === S.id });
    }
  }
  if (current) {
    if (current.parent_id) {
      const parent = getVault(current.parent_id);
      choices.push({ label: `返回所属仓库 (${parent?.name || '上级'})`, icon: 'corner-up-left', name: 'switch', value: current.parent_id, separatorBefore: true });
      choices.push({ label: '重命名整体单元', icon: 'square-pen', name: 'rename-vault', value: current.id });
    } else {
      choices.push({ label: '重命名当前仓库', icon: 'square-pen', name: 'rename-vault', value: current.id, separatorBefore: true });
      choices.push({ label: '重定位仓库…', icon: 'folder-open', name: 'relocate-vault', value: current.id });
      choices.push({ label: '移除当前仓库…', icon: 'ban', name: 'remove-vault', value: current.id, danger: true });
    }
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
  const inbox = getSnapshotIndex(snap()).inbox;
  return `<div class="rail-brand" aria-label="Vaulta"><img src="./assets/vaulta.png" alt=""><span>Vaulta</span></div>
    <nav class="rail-scroll c-nav" id="rail-scroll" aria-label="主要导航"><section class="rail-section lead"><div class="rail-label">浏览</div>
    ${navLink('home', '仓库', 'house')}${hasVaults ? `${navLink('physical', '文件', 'folder-tree', 'physical', { active: S.page === 'physical' })}${navLink('all', '资料库', 'bookmark', 'all', { active: libraryPages.has(S.page) && !['physical', 'history'].includes(S.page) })}` : ''}</section>
    ${hasVaults ? `<section class="rail-section"><div class="rail-label">待办</div>${navLink('inbox', '收件箱', 'inbox', 'inbox', { count: inbox })}</section>` : ''}</nav>
    <div class="rail-bottom">${navLink('settings', '设置', 'settings')}<div class="local-note">${icon('shield', 14)}<span>仅本机</span></div></div>`;
}
// Floating navigation: the same destinations as the rail, as a GlassDesign
// `.c-dock` pill that floats over the content instead of occupying a column.
function renderDock() {
  if (prefs.nav !== 'dock') { if (dockHost.childElementCount) dockHost.innerHTML = ''; dockHost.hidden = true; return; }
  const hasVaults = !!S.registry.length, inbox = getSnapshotIndex(snap()).inbox;
  const entries = [
    ['home', '仓库', 'house', !S.viewId && S.page === 'home', 0],
    ...(hasVaults ? [
      ['physical', '文件', 'folder-tree', S.page === 'physical', 0],
      ['all', '资料库', 'bookmark', libraryPages.has(S.page) && !['physical', 'history'].includes(S.page), 0],
      ['inbox', '收件箱', 'inbox', !S.viewId && S.page === 'inbox', inbox],
    ] : []),
  ];
  const current = entries.findIndex(entry => entry[3]);
  const tabbable = current >= 0 ? current : 0;
  const button = (entry, index, focusable = index === tabbable) => {
    const [page, label, glyph, active, count] = entry;
    return `<button type="button" class="c-dock__item" data-act="nav" data-value="${esc(page)}" style="--i:${index};--n:${entries.length + 1}" title="${esc(label)}" aria-label="${esc(label)}"${active ? ' aria-current="page"' : ''}${focusable ? '' : ' tabindex="-1"'}>${icon(glyph, 19)}${count > 0 ? `<span class="c-dock__badge">${esc(count)}</span>` : ''}</button>`;
  };
  dockHost.hidden = false;
  dockHost.dataset.hidden = S.rail ? '0' : '1';
  // The pill is rebuilt wholesale, so carry the focused destination across the
  // render instead of dropping keyboard users back to the document.
  const focused = dockHost.contains(document.activeElement) ? document.activeElement.dataset.value : null;
  dockHost.innerHTML = `<div class="dock-brand" aria-hidden="true"><img src="./assets/vaulta.png" alt=""></div>
    <div class="c-dock__pill">${entries.map((entry, index) => `${entry[0] === 'inbox' ? '<div class="c-dock__sep" role="presentation"></div>' : ''}${button(entry, index)}`).join('')}</div>
    <div class="c-dock__foot">${button(['settings', '设置', 'settings', S.page === 'settings', 0], entries.length, true)}</div>`;
  if (focused) [...dockHost.querySelectorAll('[data-value]')].find(node => node.dataset.value === focused)?.focus({ preventScroll: true });
}
function renderHome() {
  const known = roots();
  return `<div class="home"><section class="welcome" aria-labelledby="welcome-title">
    <div class="welcome-copy"><div class="eyebrow"><span class="signal"></span> 个人数字资产仓库</div><h1 id="welcome-title">让你的文件，<br>井井有条<span>。</span></h1>
    <p>把本地文件夹变成可搜索、可整理的仓库。<br>用分类和标记建立秩序，原文件留在原处。</p>
    <div class="welcome-actions">${button('新建仓库', 'new-vault', { glyph: 'plus', style: 'c-btn--primary', size: 'lg' })}${button('添加现有文件夹', 'add-vault', { glyph: 'folder-open', style: 'secondary', size: 'lg' })}</div></div>
    <img class="hero-art" src="./assets/workspace.svg" alt="" draggable="false">
    </section>
    <section class="home-section"><header><div><h2>我的仓库</h2><p>在此打开你的本地资产空间。</p></div>${known.length ? ib('添加或新建仓库', 'new-menu', 'plus', { style: 'soft', attrs: 'aria-haspopup="menu"' }) : ''}</header>
    ${known.length ? `<div class="vault-cards">${known.map(v => {
      const units = S.registry.filter(u => u.parent_id === v.id);
      const desc = units.length ? `${v.root} · ${units.length} 个整体单元` : v.root;
      return `<div class="vault-card">${widget('nav-card', { title: v.name, desc, icon: 'hard-drive' }, { action: 'switch', value: v.id, fallback: `<button type="button" ${act('switch', v.id)}>${esc(v.name)}</button>`, className: 'vault-card-main', tag: 'div' })}${ib('管理仓库', 'manage-vault', 'more', { value: v.id })}</div>`;
    }).join('')}</div>` : `<div class="home-empty"><span class="home-vault-icon">${icon('hard-drive', 21)}</span><div><strong>还没有仓库</strong><p>新建一个仓库，或添加包含现有文件的文件夹。</p></div></div>`}</section>
    <section class="principles" aria-label="仓库工作方式">
      ${[['folder-tree', '真实目录', '文件留在磁盘上，仍可用资源管理器访问。'], ['flag', '灵活整理', '用分类和标记管理同一份文件。'], ['shield', '本地优先', '无需账号，管理信息和文件都留在本机。']].map(([glyph, title, text]) => `<div><span class="principle-icon">${icon(glyph, 20)}</span><section><h3>${title}</h3><p>${text}</p></section></div>`).join('')}
    </section></div>`;
}
function renderStatus() {
  const active = vault();
  const scanning = S.scanning !== null && S.scanning === S.id;
  let left = S.booting ? ['loader', '正在连接'] : !connected() ? ['info', '未连接桌面端'] : scanning && active ? ['loader', '正在扫描仓库'] : S.error ? ['triangle-alert', '同步未完成'] : S.loading ? ['loader', '正在读取仓库'] : ['circle-check', active ? (active.parent_id ? '整体单元' : '本地仓库') : '工作区就绪'];
  if (active?.status && active.status !== 'ready' && !S.loading && !S.error && !scanning) left = ['triangle-alert', `${active.name} · ${statusLabel(active.status)}`];
  const displayRoot = active?.parent_id ? `${sourceName(active.parent_id)} / ${active.name}` : (active?.root || '文件与数据存储在本机');
  const statusFields = `<span class="status-left ${left[0] === 'circle-check' ? 'ready' : ''}">${icon(left[0], 14)}<span class="ellipsis">${esc(left[1])}</span></span>
    <span class="status-middle ellipsis" title="${esc(displayRoot)}">${esc(displayRoot)}</span><span data-glass-slot="end" class="status-right">${configurationPage() ? `${roots().length} 个仓库` : `${S.items.length} 个项目${S.multi && S.selected.size ? ` · 已选 ${S.selected.size}` : ''}`}</span>`;
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
    ${item ? `<p class="ellipsis" title="${esc(item.rel || item.name)}">${esc(item.name)}</p>` : !empty ? '<p aria-hidden="true">&nbsp;</p>' : ''}
    ${empty ? '' : `<div class="review-tools">${button('上一个', 'review-prev', { glyph: 'chevron-left', style: 'secondary', disabled: S.reviewing || items.length < 2 })}${button('跳过 / 下一个', 'review-next', { glyph: 'chevron-right', style: 'secondary', disabled: S.reviewing || (items.length < 2 && !!item) })}${button('整理后入库…', 'review-organize', { glyph: 'tag', style: 'secondary', disabled: S.reviewing || !item })}${button('直接入库', 'review-file', { glyph: 'check', style: 'c-btn--primary', disabled: S.reviewing || !item })}</div>`}
    <small>${S.reviewing ? '正在更新索引…' : '入库会把文件加入资料库，并按文件类型自动归类；不会移动原文件。'}</small>`;
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
  // The inbox groups files under folders; reveal the item being reviewed.
  const set = expandedPaths(item.vaultId, 'inbox');
  let dir = parentPath(item.rel), reveal = false;
  while (dir) { const path = pathKey(dir); if (!set.has(path)) { set.add(path); reveal = true; } dir = parentPath(dir); }
  if (reveal && S.page === 'inbox') render();
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
    ...(viewHistory.index > 0 ? [cmd('后退', 'chevron-left', 'history-back', null, '导航', 'Alt+←')] : []),
    ...(viewHistory.index < viewHistory.stack.length - 1 ? [cmd('前进', 'chevron-right', 'history-forward', null, '导航', 'Alt+→')] : []),
    ...(vault() ? [cmd('打开收件箱', 'inbox', 'nav', 'inbox', '待办', '', 'inbox'), cmd('浏览文件', 'folder-tree', 'nav', 'physical', '浏览', '', 'folder tree 目录 物理'), cmd('打开资料库', 'bookmark', 'nav', 'all', '浏览', '', 'library all assets 全部'), cmd('查看标记', 'flag', 'nav', 'flags', '浏览', '查看带有关注标记的资产', 'flags mark 标记'), cmd('最近使用', 'clock', 'nav', 'recent', '浏览'),
      cmd('查找重复文件', 'copy', 'nav', 'duplicates', '整理'), cmd('扫描当前仓库', 'refresh-cw', 'rescan', null, '整理', 'F5', 'scan'), cmd('查看操作历史', 'clock', 'nav', 'history', '整理')] : []),
    ...(S.page === 'inbox' && S.items.length ? [cmd('逐项处理收件箱', 'square-check', 'review-start', null, '整理', '依次预览、整理和入库', 'inbox review')] : []),
    ...(canSaveView() ? [cmd('筛选当前资产', 'list-filter', 'filters', null, '整理'), cmd('保存此视图', 'star', 'save-view', null, '整理', '保存位置、筛选和排序')] : []),
    ...(current && !current.synthetic && current.state !== 'missing' ? [cmd('预览选中资产', 'eye', 'preview-one', assetKey(current), '选中资产', 'Space'), cmd('复制选中资产的路径', 'copy', 'copy-value', extPath(current), '选中资产')] : []),
    cmd('设置', 'settings', 'nav', 'settings', '工作区', '', 'settings preference'), cmd('返回首页', 'house', 'nav', 'home', '工作区', '', 'home'),
    cmd('添加现有文件夹', 'folder-open', 'add-vault', null, '仓库', '', 'add folder'), cmd('新建仓库', 'plus', 'new-vault', null, '仓库', '', 'new vault'),
    ...prefs.views.filter(v => getVault(v.vaultId)).map(v => cmd(v.name, 'star', 'open-view', v.id, '已保存视图', sourceName(v.vaultId))),
    ...roots().map(v => cmd(v.name, 'hard-drive', 'switch', v.id, '切换仓库', '')),
    ...S.registry.filter(v => v.parent_id).map(v => {
      const p = getVault(v.parent_id);
      return cmd(v.name, 'layers', 'switch', v.id, '进入整体单元', `所属仓库：${p?.name || '未知'}`);
    }),
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
  const current = vault();
  const pieces = splitPath(S.folder);
  let prefix = '';
  if (current?.parent_id) {
    const parent = getVault(current.parent_id);
    prefix = `<button ${act('switch', current.parent_id)} title="所属上级仓库">${icon('hard-drive', 14)}<span>${esc(parent?.name || '仓库')}</span></button>${icon('chevron-right', 12)}<button ${act('folder', '')} ${!pieces.length ? 'aria-current="page"' : ''} title="整体单元根目录">${icon('layers', 14)}<span>${esc(current.name)}</span></button>`;
  } else {
    prefix = `<button ${act('folder', '')} ${!pieces.length ? 'aria-current="page"' : ''}>${icon('hard-drive', 14)}<span>${esc(current?.name || '根目录')}</span></button>`;
  }
  return `<nav class="c-crumbs breadcrumbs" aria-label="物理路径">${prefix}${pieces.map((name, i) => `${icon('chevron-right', 12)}<button ${act('folder', pieces.slice(0, i + 1).join('/'))} ${i === pieces.length - 1 ? 'aria-current="page"' : ''}>${esc(name)}</button>`).join('')}</nav>`;
}
const menuFallback = (label, name, glyph) => `<button class="c-btn c-btn--sm" type="button" ${act(name)} aria-haspopup="menu">${icon(glyph, 14)}<span>${esc(label)}</span></button>`;
const browseModes = [['physical', '目录'], ['all', '资料库'], ['category', '分类'], ['flags', '标记']];
const utilityPages = ['recent', 'duplicates', 'missing', 'excluded', 'history'];
function libraryItems() {
  return [...utilityPages.map(id => ({ label: pages[id][0], icon: pages[id][1], name: 'nav', value: id, checked: S.page === id })),
    { label: '扫描当前仓库', icon: 'refresh-cw', name: 'rescan', disabled: S.loading || !!S.scanning, separatorBefore: true }];
}
function libraryBar() {
  if (!libraryPages.has(S.page) || !S.id) return '';
  return `<div class="library-bar">${segmented('浏览方式', browseModes, browseModes.some(([id]) => S.page === id) ? S.page : '', 'library-mode', 'library-segments')}
    <div class="library-tools">${savedPicker()}${popupWidget('仓库工具', 'more', libraryItems(), menuFallback('仓库工具', 'library-menu', 'more'))}</div></div>`;
}
function facetsMarkup() {
  if (S.page === 'category') {
    const trail = ancestry(S.facet, catIndex);
    const options = [{ label: '全部分类', name: 'category', value: '', checked: !S.facet }, ...categoryOptions(catIndex).map(c => ({ label: c.label, name: 'category', value: c.id, checked: c.id === S.facet }))];
    return `<div class="facet-row">${popupWidget('选择主分类', 'layers', options, menuFallback('选择主分类', 'category-select-menu', 'layers'))}${trail.length > 1 ? `<span class="facet-path" title="${esc(trail.map(c => c.name).join(' / '))}">${esc(trail.map(c => c.name).join(' / '))}</span>` : ''}</div>`;
  }
  const list = S.page === 'flags' ? flags : null;
  if (!list?.length) return '';
  const options = ['', ...list].map(item => ({ label: item || `全部${pages[S.page][0]}`, name: 'facet', value: item, checked: S.facet === item }));
  return `<div class="facet-row">${popupWidget('选择' + pages[S.page][0], pages[S.page][1], options, menuFallback('选择' + pages[S.page][0], 'label-select-menu', pages[S.page][1]))}${S.facet ? pill(S.facet, 'flag') : ''}</div>`;
}
function sortMenu() {
  const items = sortOptions.map(([id, label]) => ({ id, label, checked: id === S.sort }));
  items.push({ id: 'asc', label: '升序', icon: 'chevron-up', separatorBefore: true, checked: S.direction === 'asc' },
    { id: 'desc', label: '降序', icon: 'chevron-down', checked: S.direction === 'desc' },
    { id: 'toggle-folders', label: '文件夹优先', icon: 'folder', separatorBefore: true, checked: prefs.foldersFirst });
  return widget('menu', { label: '排序', icon: 'sort', className: 'c-btn--sm', items }, { action: 'sort-choice',
    fallback: `<button type="button" class="c-btn c-btn--sm" ${act('sort-menu')} aria-haspopup="menu">排序</button>` });
}
function renderWorkspace() {
  if (S.page === 'home') return `<div class="stage" id="stage">${S.error ? errorStrip() : ''}${renderHome()}</div>`;
  if (S.page === 'settings') return `<div class="stage" id="stage">${renderSettings()}</div>`;
  if (S.page === 'history') return `<div class="stage" id="stage">${renderHistory()}</div>`;
  const [baseTitle, glyph, desc] = pages[S.page] || pages.all;
  const title = S.page === 'physical' ? basename(S.folder) || baseTitle : S.page === 'category' ? catIndex.map.get(S.facet)?.name || baseTitle : baseTitle;
  const primary = S.page === 'physical' ? button('新建文件夹', 'create-folder', { glyph: 'folder-plus', style: 'secondary' })
    : S.page === 'category' ? button('新建分类', 'category-new', { glyph: 'plus', style: 'secondary' })
    : S.page === 'duplicates' ? button(S.dup?.loading ? '正在比对' : '查找重复', 'duplicates-refresh', { glyph: 'refresh-cw', style: 'secondary', disabled: S.dup?.loading })
    : '';
  const extra = S.page === 'category' && S.facet ? ib('管理分类', 'category-menu', 'more', { attrs: 'aria-haspopup="menu"' })
    : '';
  const count = filterCount();
  // Both tree pages can expand/collapse in one go. The keys come from the rows
  // themselves so folders the tree synthesised from a path are included too.
  const treeKeys = S.page === 'all' || S.page === 'inbox'
    ? S.rows.filter(row => row.tree && row.folder && row.hasChildren).map(row => pathKey(row.item.rel)) : [];
  const allOpen = treeKeys.length > 0 && treeKeys.every(key => expandedPaths(S.id, expandScope()).has(key));
  const files = S.items.filter(a => !isDir(a)).length, dirs = S.items.length - files;
  const summary = S.page === 'all' && dirs
    ? `<strong>${files.toLocaleString('zh-CN')}</strong> 个文件 · ${dirs.toLocaleString('zh-CN')} 个文件夹`
    : S.page === 'inbox' ? `<strong>${S.items.length.toLocaleString('zh-CN')}</strong> 个待入库文件`
    : `<strong>${S.items.length.toLocaleString('zh-CN')}</strong> 个项目`;
  return `<div class="stage asset-stage" id="stage">
    <div class="asset-intro">${errorStrip()}${S.notice ? `<div class="notice-row">${inlineNotice('warning', S.notice)}${ib('关闭提醒', 'hide-warning', 'x')}</div>` : ''}
    ${libraryBar()}<header class="page-heading asset-heading">${S.page === 'physical' ? folderBreadcrumb() : `<div class="page-context">${icon(glyph, 14)}<span>${esc(S.page === 'search' ? '全局查找' : vault()?.name || '仓库')}</span>${vault()?.parent_id && S.page !== 'search' ? `<button ${act('switch', vault().parent_id)}>返回上级仓库 ${icon('arrow-up-right', 12)}</button>` : ''}</div>`}
      <div class="heading-row"><div><h1>${esc(savedViews().find(v => v.id === S.viewId)?.name || title)}</h1><p>${esc(S.page === 'search' && S.query.trim() ? `「${S.query.trim()}」 · ${searchScopeLabel()}${S.content ? ' · 含本地文本与可提取的文档内容' : ''}` : desc)}</p></div><div class="heading-actions">${extra}${S.page === 'inbox' && S.items.length && !S.review ? `${button(`全部入库 · ${S.items.length}`, 'file-in-all', { glyph: 'check', style: 'tinted' })}${button('逐项处理', 'review-start', { glyph: 'square-check', style: 'secondary' })}` : ''}${canSaveView() ? ib(S.viewId ? '管理已保存视图' : '保存此视图', S.viewId ? 'manage-view' : 'save-view', 'star', { style: S.viewId ? 'soft' : '' }) : ''}${primary}</div></div>
    </header>
    ${facetsMarkup()}${renderReview()}</div>
    <div class="asset-toolbar"><div class="asset-summary">${summary}${S.page === 'duplicates' && S.dup?.groups?.length ? ` · ${S.dup.groups.length} 组重复` : ''}</div><div class="asset-tools">${S.page === 'search' ? '' : button(count ? `筛选 · ${count}` : '筛选', 'filters', { glyph: 'list-filter', style: count ? 'tinted' : 'secondary' })}${sortMenu()}${(S.page === 'all' || S.page === 'inbox') && !count && treeKeys.length ? button(allOpen ? '收起' : '展开', 'tree-all', { glyph: allOpen ? 'chevron-up' : 'chevron-down', style: 'secondary', size: 'sm', value: allOpen ? 'collapse' : 'expand', attrs: `title="${allOpen ? '收起全部文件夹' : '展开全部文件夹'}"` }) : ''}${segmented('资产视图', [['list', '列表', 'list'], ['grid', '网格', 'layout-grid']], prefs.layout, 'layout', 'view-switch')}</div></div>
    ${renderFilterChips()}${renderAssets()}
  </div>${renderBulk()}`;
}
function searchScopeLabel() { return scopeOptions.find(([id]) => id === S.scope)?.[1] || '当前仓库'; }
function filterCount() { return Number(!!S.filters.category) + S.filters.flags.length + Number(!!S.filters.type); }
function renderFilterChips() {
  if (S.page === 'search' || !filterCount()) return '';
  const f = S.filters;
  const active = [
    ...(f.category ? [['category', f.category, f.category === '!none' ? '未分类' : catIndex.map.get(f.category)?.name || '分类']] : []),
    ...f.flags.map(t => ['flags', t, t]),
    ...(f.type ? [['type', f.type, typeOptions.find(([id]) => id === f.type)?.[1] || f.type]] : []),
  ];
  return `<div class="applied-filters" aria-label="已应用筛选">${active.map(([key, value, text]) => `<button type="button" class="pill accent filter-chip" ${act('remove-filter', JSON.stringify([key, value]))} aria-label="移除筛选：${esc(text)}">${esc(text)}${icon('x', 12)}</button>`).join('')}<button type="button" ${act('clear-filters')}>清除筛选</button></div>`;

}
function errorStrip() { return S.error ? `<div class="notice-row">${inlineNotice('danger', S.error)}${button('重试', 'retry', { style: 'secondary' })}</div>` : ''; }
function renderBulk() {
  const picked = selection(), real = picked.filter(a => !a.synthetic);
  const excluded = real.length && real.every(a => a.state === 'excluded'), missing = real.some(a => a.state === 'missing');
  const selectables = S.items.filter(a => !a.synthetic), all = selectables.length && real.length === selectables.length;
  const hasInbox = real.some(a => a.state === 'inbox' || (isDir(a) && folderInboxItems(a).length > 0));
  return `<div class="bulk-band" id="bulk" ${S.multi && real.length ? '' : 'hidden'}><div><input type="checkbox" data-select-all aria-label="选择全部结果" ${all ? 'checked' : ''}><strong>已选 ${real.length} 项</strong>${ib('清除选择', 'clear-selection', 'x')}</div><div class="bulk-actions">
    ${missing ? '' : excluded ? button('重新纳入', 'restore', { glyph: 'undo' }) : `${button('标记', 'mark-selected', { glyph: 'flag', style: 'secondary' })}${button('整理', 'organize', { glyph: 'tag' })}${hasInbox ? button('入库', 'file-in', { glyph: 'check' }) : ''}${button('移动', 'move', { glyph: 'move' })}`}${ib('更多批量操作', 'bulk-menu', 'more', { attrs: 'aria-haspopup="menu"' })}</div></div>`;
}
function renderAssets() {
  if (S.loading && !S.cache.has(S.id) && S.page !== 'search') return blank('loader', '正在读取仓库', '正在从磁盘索引加载资产。');
  if (S.searching && !S.searchItems.length && S.page === 'search') return blank('loader', '正在查找资产', '根据当前范围读取仓库。');
  if (S.page === 'search' && !S.query.trim()) return blank('search', '开始搜索', '输入名称、类型、路径、分类或标记。');
  const partial = S.page === 'search' && S.searchErrors.length ? `<details class="search-fail"><summary>${S.searchErrors.length} 项搜索未完成，部分结果可能缺失</summary><ul>${S.searchErrors.map(e => `<li>${esc(e)}</li>`).join('')}</ul></details>` : '';
  if (!S.items.length) {
    const empties = { inbox: ['收件箱是空的', '磁盘上发现的内容都已入库。新加入仓库的文件会先出现在这里。'], all: ['资料库还是空的', '把「文件」或「收件箱」中的资产入库后，就会出现在这里。'], physical: ['此文件夹为空', '可以新建文件夹，或在资源管理器中放入文件后重新扫描。'], category: ['没有分类资产', '扫描会按文件类型给出分类建议，入库时自动采用。'], flags: ['没有带标记的资产', '可以在资产详情中设置标记。'], recent: ['还没有最近记录', '打开或预览资产后，它会显示在这里。'], duplicates: S.dup?.loading ? ['正在比对文件', '正在检查文件内容。'] : S.dup?.error ? ['未能检查重复文件', S.dup.error] : ['没有重复文件', '目前没有找到内容完全相同的文件。'], excluded: ['没有已排除的资产', '从仓库排除的项目将显示在这里。'], missing: ['没有已缺失的资产', '当前没有需要处理的丢失记录。'], search: ['没有匹配的资产', '试试更短的关键词，或调整搜索范围。'] };
    const [heading, hint] = filterCount() ? ['没有符合筛选条件的资产', '减少筛选条件以查看更多结果。'] : empties[S.page] || ['还没有项目', ''];
    const cta = filterCount() ? button('清除筛选', 'clear-filters', { style: 'secondary' })
      : S.page === 'all' ? button('打开收件箱', 'nav', { value: 'inbox', glyph: 'inbox', style: 'secondary' })
      : ['inbox', 'physical'].includes(S.page) ? button('浏览文件', 'nav', { value: 'physical', glyph: 'folder-open', style: 'secondary' })
      : '';
    return partial + blank(S.page === 'duplicates' && S.dup?.loading ? 'loader' : (pages[S.page]?.[1] || 'folder'), heading, hint, cta);
  }
  const cross = S.page === 'search', chunk = S.rows.slice(0, S.limit);
  const sortAria = key => S.sort === key ? `aria-sort="${S.direction === 'asc' ? 'ascending' : 'descending'}"` : '';
  const sortBtn = (key, text) => `<button type="button" class="c-table__sort" ${act('sort', key)}>${esc(text)}${S.sort === key ? icon(S.direction === 'asc' ? 'chevron-up' : 'chevron-down', 13) : ''}</button>`;
  const groupTitle = (entry, index) => {
    if (S.page !== 'duplicates') return '';
    const item = entry.item, group = S.dup.map.get(item.id);
    return group !== S.dup.map.get(chunk[index - 1]?.item.id) ? `重复组 ${group + 1} · ${S.dup.groups[group].length} 个文件` : '';
  };
  const main = prefs.layout === 'grid' ? `<div class="tiles${S.multi ? ' multi' : ''}" id="items">${chunk.map((row, i) => `${groupTitle(row, i) ? `<div class="group-title">${esc(groupTitle(row, i))}</div>` : ''}${assetCard(row, S.selected, cross, sourceName(row.item.vaultId))}`).join('')}</div>`
    : `<table class="asset-table c-table${S.multi ? ' multi' : ''}" id="items"><thead><tr><th class="col-check"><input type="checkbox" data-select-all aria-label="选择全部结果" ${S.items.some(a => !a.synthetic) && S.items.filter(a => !a.synthetic).every(a => S.selected.has(assetKey(a))) ? 'checked' : ''}></th><th ${sortAria('name')}>${sortBtn('name', '名称')}</th><th class="col-state">入库状态</th><th class="col-size" ${sortAria('size')}>${sortBtn('size', '大小')}</th><th class="col-date" ${sortAria('modified')}>${sortBtn('modified', '修改日期')}</th><th class="col-more"></th></tr></thead><tbody>${chunk.map((row, i) => `${groupTitle(row, i) ? [6, 5, 4].map(n => `<tr class="group-row cols-${n}"><td colspan="${n}">${esc(groupTitle(row, i))}</td></tr>`).join('') : ''}${assetRow(row, S.selected, cross, sourceName(row.item.vaultId))}`).join('')}</tbody></table>`;
  return partial + main + (S.rows.length > S.limit ? `<div class="load-more">${button(`显示更多 · 剩余 ${S.rows.length - S.limit} 项`, 'more-items', { style: 'secondary' })}</div>` : '');
}
function renderHistory() {
  return `${errorStrip()}<div class="utility">${libraryBar()}<header class="page-heading"><div class="page-context">${icon('clock', 15)} ${esc(vault()?.name || '仓库')}</div><div class="heading-row"><div><h1>操作历史</h1><p>查看仓库中的整理、同步和文件操作。</p></div>${button('撤销上一次操作', 'undo', { glyph: 'undo', style: 'secondary', disabled: !snap().history.length })}</div></header>
    ${snap().history.length ? `<div class="event-list">${lines([...snap().history].sort((a, b) => Number(b.time) - Number(a.time)))}</div>` : blank('clock', '暂无操作记录', '仓库产生变更后，可在这里查看记录。')}</div>`;
}
const updates = createUpdates(host, {
  changed: () => { const region = $('#update-settings'); if (region) redraw(region, renderUpdates()); },
  found: version => toast(`发现 Vaulta ${version}，可在「设置 → 软件更新」查看。`, 'ok', 7000),
});
function renderUpdates() {
  const heading = '<h2>软件更新</h2>';
  if (!connected()) return `${heading}<p class="utility-empty">请在 Vaulta 桌面应用中检查更新。</p>`;
  const u = updates.state;
  const title = u.current ? `当前版本 ${u.current}` : 'Vaulta 更新';
  const message = u.checking ? '正在检查…' : u.error || (u.available
    ? `发现版本 ${u.available}。${u.installable ? '安装前请保存手头的编辑。' : '便携版请下载新版压缩包。'}`
    : u.checked ? '已是最新版本。' : '启动时自动检查，运行期间每 6 小时检查一次。');
  const controls = button('检查更新', 'check-update', { glyph: 'refresh-cw', style: 'secondary', disabled: u.checking }) + ' '
    + (u.available && u.installable
      ? button('下载并安装', 'install-update', { disabled: u.checking })
      : button('发布页', 'update-releases', { glyph: 'external-link', style: 'secondary' }));
  return `${heading}<div class="setting"><span class="setting-icon">${icon('refresh-cw', 20)}</span><div><h3>${esc(title)}</h3><p role="status">${esc(message)}</p></div><div class="setting-control">${controls}</div></div>`;
}
function confirmUpdate() {
  const { available, installable, checking } = updates.state;
  if (!available || !installable || checking || modal.open) return;
  if (isDirty()) { toast('请先保存或关闭正在编辑的文件。', 'warn'); return; }
  showDialog({ title: `安装 Vaulta ${available}`, symbol: 'refresh-cw', submit: '下载并安装',
    text: 'Vaulta 将下载并验证更新。确认后，安装程序启动时应用会关闭并在安装完成后重新打开。',
    onSubmit: async (_values, form) => {
      form.querySelector('button[type="submit"]').textContent = '正在下载并验证…';
      await host.installUpdate(available);
    } });
}
function renderSettings() {
  const v = vault(), access = S.access.get(v?.id), info = S.api;
  const setting = (symbol, title, help, controls) => `<div class="setting"><span class="setting-icon">${icon(symbol, 20)}</span><div><h3>${esc(title)}</h3><p>${esc(help)}</p></div><div class="setting-control">${controls}</div></div>`;
  return `${errorStrip()}<div class="utility settings"><header class="page-heading"><div class="page-context">${icon('settings', 14)} 工作区</div><h1>设置</h1><p>管理外观、仓库与本地工具访问。</p></header>
  <section class="settings-section"><h2>通用</h2>
    ${setting('palette', '界面外观', '选择浅色、深色或跟随 Windows 系统设置。',
      settingSelect({ label: '配色方案', options: themeOptions, value: prefs.theme, action: 'set-theme', setting: 'theme' }))}
    ${setting('sparkles', '玻璃效果', '完整效果保留折射与色散；仅模糊只保留背景模糊；性能优先改用不透明面。',
      settingSelect({ label: '玻璃效果', options: effectOptions, value: vaultaEffects.read(), action: 'glass-effects', setting: 'glass-effects' }))}
    ${setting('panel-left', '导航栏形态', '侧边栏长期占位；悬浮导航是浮在内容上、跟随滚动位置的玻璃药丸。',
      settingSelect({ label: '导航栏形态', options: navOptions, value: prefs.nav, action: 'nav-mode', setting: 'nav' }))}
    ${setting('app-window', '窗口标题栏', '切换后立即生效，下次打开 Vaulta 时保持所选样式。',
      canUseWindowChrome()
        ? settingSelect({ label: '窗口标题栏', options: titlebarOptions, value: getWindowChromeMode(), action: 'titlebar-mode', setting: 'titlebar' })
        : pill('仅桌面应用'))}
    ${setting('layout-grid', '默认资产视图', '在列表和网格之间切换。',
      settingSelect({ label: '默认资产视图', options: [['list', '列表'], ['grid', '网格']], value: prefs.layout, action: 'layout', setting: 'layout' }))}
    ${setting('file-lines', '多页文档预览', '设置 PDF 与幻灯片演示文稿的默认查看方式（竖直流动或单页翻页）。',
      settingSelect({ label: '多页文档预览', options: [['flow', '竖直流动'], ['paged', '单页翻页']], value: prefs.docPreview, action: 'doc-preview', setting: 'doc-preview' }))}
    ${setting('move', '拖拽移动前确认', '关闭后，把文件拖到文件夹上会直接移动，不再每次询问。',
      settingSelect({ label: '拖拽移动前确认', options: moveConfirmOptions, value: prefs.confirmMove ? 'on' : 'off', action: 'move-confirm', setting: 'move-confirm' }))}
  </section>
  <section class="settings-section"><h2>${v?.parent_id ? '当前整体单元' : '当前仓库'}</h2>${v ? (v.parent_id ? `${setting('layers', v.name, `所属仓库：${sourceName(v.parent_id)}`, button('返回所属仓库', 'switch', { glyph: 'corner-up-left', style: 'secondary', value: v.parent_id }) + button('重命名', 'rename-vault', { glyph: 'square-pen', style: 'secondary', value: v.id }))}${setting('refresh-cw', '重新扫描', '检查磁盘和索引的变化。', button('扫描整体单元', 'rescan', { style: 'secondary', disabled: S.loading || !!S.scanning }))}` : `${setting('hard-drive', v.name, v.root, button('管理', 'manage-vault', { glyph: 'more', style: 'secondary', value: v.id }))}${setting('link', '磁盘分类视图', '以链接在磁盘展示逻辑分类，不复制或移动原文件。', button(v.view_enabled ? '已启用 · 配置' : '配置', 'view-config', { style: 'secondary' }))}${setting('refresh-cw', '重新扫描', '检查磁盘和索引的变化。', button('扫描仓库', 'rescan', { style: 'secondary', disabled: S.loading || !!S.scanning }))}`) : `<p class="utility-empty">请先打开一个仓库。${button('前往仓库', 'nav', { value: 'home', style: 'secondary' })}</p>`}</section>
  <section class="settings-section" id="update-settings">${renderUpdates()}</section>
  <section class="settings-section"><h2>Agent CLI</h2>${setting('terminal', '外部工具访问', '按仓库授权；整体单元的权限独立设置。CLI 不可执行磁盘文件操作。', v && access
    ? settingSelect({ label: '外部工具访问', options: accessOptions, value: access, action: 'set-access', setting: 'agent' })
    : v && S.accessLoading.has(v.id) ? pill('正在读取') : button('读取权限', 'load-access', { style: 'secondary', disabled: !v }))}
    ${access === 'write' ? `<div class="notice-row">${inlineNotice('warning', '外部工具可修改当前仓库的整理信息。你可随时将权限切回只读或关闭。')}</div>` : ''}
    <details class="agent-docs"><summary>命令与本地路径</summary><p>在终端中执行以下命令。<code>mutate</code> 从标准输入读取 JSON，需要「读取与整理」权限。</p><pre>vaulta-agent list\nvaulta-agent snapshot &lt;id&gt;\nvaulta-agent mutate &lt;id&gt;</pre>
      <dl>${v ? infoRow('当前仓库 ID', `<code>${esc(v.id)}</code>${ib('复制仓库 ID', 'copy-value', 'copy', { value: v.id })}`) : ''}
      ${info ? infoRow('可执行文件', `<code>${esc(info.executable)}</code>${ib('复制可执行文件路径', 'copy-value', 'copy', { value: info.executable })}`) + infoRow('数据库（勿直接编辑）', `<code>${esc(info.database)}</code>${ib('复制数据库路径', 'copy-value', 'copy', { value: info.database })}`) + (info.protocol != null ? infoRow('协议版本', esc(info.protocol)) : '') : ''}</dl></details>
  </section><div class="settings-footer"><img src="./assets/vaulta.png" alt=""><span>Vaulta</span></div></div>`;
}
const office = officePreview(inspector, {
  blocked(session) {
    S.preview = { ...S.preview, downloadMarked: session };
    renderInspector();
  },
  failed(error) {
    S.preview = { ...S.preview, error: msg(error) };
    renderInspector();
  },
});
// A slideshow's one-time allowance ends when its preview is dismissed, not
// when a component redraws or the reader navigates to another slide.
function dismissSlides() {
  flowObserver?.disconnect();
  flowQueue = [];
  if (S.preview?.data?.kind === 'slides' || S.preview?.loading && /\.pp[st]x$/i.test(one()?.name ?? '')) {
    S.previewToken++;
    S.preview = null;
  }
}
let disposeImagePreview = () => {};
function renderInspector(confirmedSession = null) {
  inspector.hidden = !S.pane || S.deferFolderPane || configurationPage() || !S.selected.size;
  if (inspector.hidden) { disposeImagePreview(); dismissSlides(); office.update(null); redraw(inspector, ''); renderInspectGrip(); return; }
  // Keep an unchanged preview DOM alive so watcher notifications don't restart audio/video.
  const current = one();
  const signature = current && S.tab === 'preview' ? previewSignature(current) : null;
  if (signature && inspector.dataset.previewSignature === signature && inspector.querySelector('.preview-pane')?.previewRecord === S.preview) { renderInspectGrip(); return; }
  disposeImagePreview();
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
  if (pane?.querySelector('[data-preview-image]')) setupImagePreview(pane, a, S.preview);
  setupDocFlow(inspector);
  office.update(S.tab === 'preview' ? a : null, confirmedSession);
  renderInspectGrip();
}
function renderAssetDetails(a) {
  const key = assetKey(a), disabled = a.synthetic || a.state === 'missing', live = !disabled && a.state !== 'excluded';
  const index = a.vaultId === S.id ? catIndex : makeCategoryIndex(S.cache.get(a.vaultId)?.categories || []);
  const category = ancestry(a.category_id, index).map(c => c.name).join(' / '), identity = typeof a.identity === 'string' ? a.identity : a.identity == null ? '' : JSON.stringify(a.identity);
  const inboxCount = isDir(a) ? folderInboxItems(a).length : 0;
  return `<div class="asset-profile">${visual(a, 'profile')}<h2 title="${esc(a.name)}">${esc(a.name)}</h2><div>${pill(assetType(a).name)}${a.synthetic ? '' : statePill(a)}</div></div>
    <div class="detail-tools">${disabled ? '' : `${a.state === 'inbox' ? button('入库', 'file-in-one', { value: key, glyph: 'check', style: 'c-btn--primary' }) : inboxCount ? button(`全部入库 · ${inboxCount}`, 'file-in-folder', { value: key, glyph: 'check', style: 'c-btn--primary' }) : ''}${a.kind === 'directory' ? button('整体单元', 'unitize', { value: key, glyph: 'layers', style: 'secondary' }) : ''}${button(isDir(a) ? a.kind === 'unit' ? '进入整体单元' : '打开文件夹' : '打开文件', 'open-asset', { value: key, glyph: 'external-link', style: 'secondary' })}`}${ib('更多资产操作', 'asset-menu', 'more', { value: key })}</div>
    ${a.state === 'missing' ? `<div class="notice-row">${inlineNotice('warning', '找不到原文件，仅显示上次记录。')}${button('核对并关联身份', 'recover-identity', { value: key, style: 'secondary' })}</div>` : ''}
    ${a.state === 'excluded' ? `<div class="notice-row">${inlineNotice('info', '文件仍在磁盘上。')}${button('重新纳入', 'restore-one', { value: key, style: 'secondary' })}</div>` : ''}
    ${!a.synthetic ? `<section class="inspect-section"><header><h3>整理信息</h3>${ib('编辑整理信息', 'organize-one', 'square-pen', { value: key, disabled: !live })}</header><dl>
      ${infoRow('主分类', esc(category || '未分类'))}${infoRow('标记', `${a.flags.length ? a.flags.map(t => pill(t, 'flag')).join('') : '<span class="muted">无标记</span>'}${live ? ib(a.flags.length ? '编辑标记' : '添加标记', 'mark-one', 'flag', { value: key }) : ''}`)}
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
function setupImagePreview(pane, asset, record) {
  const image = pane.querySelector('[data-preview-image]');
  let objectUrl;
  const dispose = () => {
    image.onerror = null;
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    if (disposeImagePreview === dispose) disposeImagePreview = () => {};
  };
  const failed = () => {
    dispose();
    // A decode from an obsolete selection/render must not touch the current preview.
    if (!image.isConnected || inspector.hidden || S.tab !== 'preview' || S.preview !== record) return;
    if (record.retryImage) {
      void loadPreview(asset, { used: false, retryImage: false });
    } else {
      S.preview = { key: record.key, signature: record.signature, error: '图片无法解码。请重试，或使用默认应用打开。' };
      renderInspector();
    }
  };
  disposeImagePreview = dispose;
  image.onerror = failed;
  try {
    // Keep the large raster payload out of the HTML and give each read a fresh
    // resource URL. Audio/video keep their existing data URL and playback path.
    const url = safeMediaUrl(record.data.data_url, 'image');
    const parts = /^data:(image\/[\w.+-]+);base64,([\s\S]+)$/i.exec(url);
    if (!parts) throw new Error('Invalid raster data URL');
    const bytes = typeof Uint8Array.fromBase64 === 'function'
      ? Uint8Array.fromBase64(parts[2]) : Uint8Array.from(atob(parts[2]), byte => byte.charCodeAt(0));
    objectUrl = URL.createObjectURL(new Blob([bytes], { type: parts[1] }));
    image.src = objectUrl;
  } catch {
    // Defer until the inspector has finished mounting the preview and its controls.
    queueMicrotask(failed);
  }
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
// Preserve the host's Shell allowlist: legacy or macro-enabled Office files
// that cannot use ordinary Open can still be located from the preview.
function documentOpen(a) {
  const key = assetKey(a);
  return /\.(?:doc|ppt|ppsx?|xls|docm|pptm|ppsm|xlsm|xlsb)$/i.test(a.name)
    ? ['在资源管理器中显示', 'reveal', 'folder-open', { value: key }]
    : ['用系统应用打开', 'open-asset', 'external-link', { value: key }];
}
function renderPreview(a) {
  const p = S.preview?.signature === previewSignature(a) ? S.preview : null;
  const kind = p?.data?.kind, document = ['pdf', 'slides', 'office'].includes(kind);
  const unavailable = p?.error || p?.downloadMarked;
  const open = document && !unavailable ? ib(...documentOpen(a)) : '';
  const edit = kind === 'text' ? ib('编辑文件', 'edit-text', 'square-pen', { disabled: p.data.revision == null || a.state === 'excluded' }) : '';
  return `<div class="preview-pane${kind === 'office' && !unavailable ? ' native-document' : ''}"><div class="preview-heading">${visual(a)}<div><strong class="ellipsis" title="${esc(a.name)}">${esc(a.name)}</strong><small>${document ? `${esc(assetType(a).name)} · 版式预览` : esc(assetType(a).name)}</small></div>${open || edit}</div>${previewBody(a, p)}</div>`;
}
function previewBody(a, p) {
  if (p?.loading || !p) return `<div class="preview-message" role="status">${icon('loader', 23)}<p>正在载入预览…</p></div>`;
  const d = p.data, isMarkdown = /\.(md|markdown|mdown)$/i.test(a.name);
  const [label, action, glyph, { value }] = documentOpen(a);
  const open = button(label, action, { value, glyph, style: 'secondary' });
  if (p.downloadMarked) return `<div class="preview-message">${icon('triangle-alert', 25)}<p role="status">此文件带有 Windows 下载标记，已暂停预览。仅在信任文件来源时继续。</p><div class="preview-actions">${button('仍然预览…', 'preview-marked-once', { style: 'secondary', attrs: 'aria-haspopup="dialog"' })}${open}</div></div>`;
  if (p.error) return `<div class="preview-message">${icon('triangle-alert', 25)}<p role="status">${esc(p.error)}</p><div class="preview-actions">${button('重试', 'retry-preview', { style: 'secondary' })}${isDir(a) ? '' : open}</div></div>`;
  if (d?.kind === 'pdf' || d?.kind === 'slides') return renderPaged(p);
  if (d?.kind === 'office') return `<div class="office-preview-surface" role="region" aria-label="Windows 文档预览" aria-busy="true"><p role="status">${icon('loader', 23)} 正在载入 Windows 文档预览…</p></div>`;
  if (d?.kind === 'text') return `<div class="preview-content">${isMarkdown ? markdown(d.text ?? '') : `<pre>${esc(d.text ?? '')}</pre>`}</div>`;
  if (d?.kind === 'image') return `<div class="media-preview"><img data-preview-image alt="${esc(a.name)}"></div>`;
  const url = safeMediaUrl(d?.data_url, d?.kind);
  if (url) {
    const src = esc(url);
    return `<div class="media-preview">${d.kind === 'video' ? `<video controls playsinline preload="metadata" src="${src}"></video>` : `<audio controls preload="metadata" src="${src}"></audio>`}</div>`;
  }
  return `<div class="preview-message">${icon(d?.kind === 'directory' ? 'folder-open' : 'eye', 26)}<p>${esc(d?.message || (d?.kind === 'directory' ? '打开文件夹即可查看内部项目。' : '此格式暂不支持内置预览。'))}</p>${isDir(a) ? button('打开文件夹', 'open-asset', { value: assetKey(a), glyph: 'external-link', style: 'secondary' }) : open}</div>`;
}
let flowObserver = null, flowQueue = [], flowLoading = false;
function updateFlowPageDom(index, url) {
  const item = inspector.querySelector(`.pdf-flow-item[data-page="${index}"]`);
  if (!item) return;
  const p = S.preview;
  const slides = p?.data?.kind === 'slides';
  const itemLabel = slides ? `第 ${index + 1} 张幻灯片` : `PDF 第 ${index + 1} 页`;
  const zoom = p?.paged?.zoom ?? 100;
  item.innerHTML = `<img src="${esc(url)}" alt="${itemLabel}" style="width:${zoom}%" draggable="false"><span class="pdf-flow-badge" aria-hidden="true">${index + 1}</span>`;
}
function updateFlowPageError(index, error) {
  const item = inspector.querySelector(`.pdf-flow-item[data-page="${index}"]`);
  if (!item) return;
  item.innerHTML = `<div class="pdf-flow-error"><p>${icon('triangle-alert', 16)} 无法绘制第 ${index + 1} 页</p><button type="button" class="c-btn va-btn secondary c-btn--sm" ${act('pdf-view', `retry-${index}`)}>重试</button></div><span class="pdf-flow-badge" aria-hidden="true">${index + 1}</span>`;
}
async function loadFlowPage(index) {
  const a = one(), p = S.preview, paged = p?.paged;
  const signature = previewSignature(a);
  if (!a || !paged || p.signature !== signature || paged.pages?.has(index) || paged.loadingPages?.has(index)) return;
  paged.loadingPages.add(index);
  inspector.querySelector(`.pdf-flow-item[data-page="${index}"]`)?.classList.add('loading');
  const token = S.previewToken;
  let res;
  try { res = await renderPage(a, p.data.kind, index, p.slideSession); }
  catch (err) { res = { error: msg(err) }; }
  if (S.previewToken !== token || S.preview?.signature !== signature) return;
  paged.loadingPages.delete(index);
  inspector.querySelector(`.pdf-flow-item[data-page="${index}"]`)?.classList.remove('loading');
  if (res?.url) {
    paged.pages?.set(index, res.url);
    updateFlowPageDom(index, res.url);
  } else if (res?.error) {
    updateFlowPageError(index, res.error);
  }
}
function syncFlowActivePage(root, pageIdx, count) {
  root.querySelectorAll('.pdf-flow-item').forEach(el => {
    const isTarget = parseInt(el.dataset.page, 10) === pageIdx;
    el.classList.toggle('pdf-page', isTarget);
    el.classList.toggle('active', isTarget);
  });
  const label = root.querySelector('.pdf-page-label');
  if (label) label.textContent = `${pageIdx + 1} / ${count}`;
  const prevBtn = root.querySelector('[data-act="pdf-view"][data-value="prev"]');
  const nextBtn = root.querySelector('[data-act="pdf-view"][data-value="next"]');
  if (prevBtn) { if (pageIdx === 0) prevBtn.setAttribute('aria-disabled', 'true'); else prevBtn.removeAttribute('aria-disabled'); }
  if (nextBtn) { if (pageIdx + 1 >= count) nextBtn.setAttribute('aria-disabled', 'true'); else nextBtn.removeAttribute('aria-disabled'); }
}
function scheduleFlowLoad(index, priority = false) {
  const p = S.preview?.paged;
  if (!p || index < 0 || index >= p.count || p.pages?.has(index) || p.loadingPages?.has(index)) return;
  const pos = flowQueue.indexOf(index);
  if (pos !== -1) {
    if (priority && pos > 0) { flowQueue.splice(pos, 1); flowQueue.unshift(index); }
  } else if (priority) {
    flowQueue.unshift(index);
  } else {
    flowQueue.push(index);
  }
  void drainFlowQueue();
}
async function drainFlowQueue() {
  if (flowLoading) return;
  flowLoading = true;
  try {
    while (flowQueue.length) {
      const index = flowQueue.shift();
      await loadFlowPage(index);
    }
  } finally {
    flowLoading = false;
  }
}
function setupDocFlow(inspectorNode) {
  flowObserver?.disconnect();
  flowQueue = [];
  const flowContainer = inspectorNode.querySelector('.pdf-flow');
  if (!flowContainer) return;
  const items = flowContainer.querySelectorAll('.pdf-flow-item');
  if (!items.length) return;

  const scrollRoot = inspectorNode.querySelector('.inspect-scroll');
  flowObserver = new IntersectionObserver(entries => {
    let maxRatio = 0, bestPage = null;
    for (const entry of entries) {
      const pageIdx = parseInt(entry.target.dataset.page, 10);
      if (entry.isIntersecting) {
        scheduleFlowLoad(pageIdx, true);
        scheduleFlowLoad(pageIdx + 1, false);
        if (entry.intersectionRatio > maxRatio) {
          maxRatio = entry.intersectionRatio;
          bestPage = pageIdx;
        }
      }
    }
    if (bestPage != null && maxRatio >= 0.25) {
      const p = S.preview?.paged;
      if (p && p.page !== bestPage) {
        p.page = bestPage;
        syncFlowActivePage(inspectorNode, bestPage, p.count);
      }
    }
  }, { root: scrollRoot || null, rootMargin: '400px 0px', threshold: [0, 0.25, 0.5, 0.75, 1.0] });

  items.forEach(item => flowObserver.observe(item));

  const p = S.preview?.paged;
  if (p && p.count > 1) {
    scheduleFlowLoad(1, false);
  }
}
function renderPaged(p) {
  const { page, count, url, zoom, pending, error, pages, loadingPages } = p.paged;
  const mode = p.paged.mode || prefs.docPreview || 'flow';
  const isFlow = mode === 'flow';
  const slides = p.data.kind === 'slides';
  const label = slides ? `第 ${page + 1} 张幻灯片` : `PDF 第 ${page + 1} 页`;
  const tool = (label, glyph, value, disabled) => `<button type="button" class="ic-btn" ${act('pdf-view', value)} aria-label="${label}" title="${label}" ${disabled ? 'aria-disabled="true"' : ''}>${icon(glyph, 16)}</button>`;
  const toolbar = `<div class="pdf-toolbar" role="group" aria-label="${slides ? '幻灯片切换与缩放' : 'PDF 页面与缩放'}">
    ${tool(slides ? '上一张' : '上一页', 'chevron-left', 'prev', isFlow ? page === 0 : (pending || page === 0))}<span class="pdf-page-label" aria-live="polite">${page + 1} / ${count}</span>${tool(slides ? '下一张' : '下一页', 'chevron-right', 'next', isFlow ? page + 1 >= count : (pending || page + 1 >= count))}
    <span class="pdf-divider" aria-hidden="true"></span>${tool('缩小', 'zoom-out', 'out', zoom === 100)}<button type="button" class="pdf-zoom" ${act('pdf-view', 'fit')} aria-label="适合栏宽" title="适合栏宽">${zoom}%</button>${tool('放大', 'zoom-in', 'in', zoom === 300)}
    <span class="pdf-divider" aria-hidden="true"></span>${tool(isFlow ? '切换为单页翻页' : '切换为竖直流动', isFlow ? 'book-open' : 'rows-3', 'toggle-mode')}
    </div>${pending ? `<p class="pdf-status" role="status">${icon('loader', 16)}正在绘制页面…</p>` : error ? `<p class="pdf-status" role="alert">${esc(error)}</p>` : ''}`;
  if (!isFlow) {
    return `${toolbar}<div class="pdf-page" tabindex="0" aria-label="${label}"><img src="${esc(url)}" alt="${label}" style="width:${zoom}%" draggable="false"></div>`;
  }
  const items = [];
  for (let i = 0; i < count; i++) {
    const pageUrl = pages?.get(i) || (i === 0 ? url : null);
    const itemLabel = slides ? `第 ${i + 1} 张幻灯片` : `PDF 第 ${i + 1} 页`;
    const isActive = i === page;
    const body = pageUrl
      ? `<img src="${esc(pageUrl)}" alt="${itemLabel}" style="width:${zoom}%" draggable="false"><span class="pdf-flow-badge" aria-hidden="true">${i + 1}</span>`
      : `<div class="pdf-flow-placeholder"><span class="pdf-flow-loader">${icon('loader', 17)}</span><span>正在载入第 ${i + 1} 页…</span></div><span class="pdf-flow-badge" aria-hidden="true">${i + 1}</span>`;
    items.push(`<div class="pdf-flow-item${isActive ? ' pdf-page active' : ''}${loadingPages?.has(i) ? ' loading' : ''}" data-page="${i}" tabindex="0" aria-label="${itemLabel}">${body}</div>`);
  }
  return `${toolbar}<div class="pdf-flow" tabindex="0" aria-label="${slides ? '幻灯片连续预览' : 'PDF 连续预览'}">${items.join('')}</div>`;
}
function pageResult(data, index) {
  const url = safeMediaUrl(data?.data_url, 'image');
  if (!url?.startsWith('data:image/png;') || !Number.isInteger(data?.count) || data.count <= index) throw new Error('未收到有效的页面图像。');
  return { page: index, count: data.count, url };
}
async function pageAction(value) {
  const a = one(), p = S.preview, paged = p?.paged, signature = previewSignature(a);
  if (!a || !paged || p.signature !== signature) return;
  const focus = () => inspector.querySelector(`[data-act="pdf-view"][data-value="${value}"]`)?.focus({ preventScroll: true });

  if (value === 'toggle-mode') {
    const currentMode = paged.mode || prefs.docPreview || 'flow';
    const nextMode = currentMode === 'flow' ? 'paged' : 'flow';
    prefs.docPreview = nextMode;
    persist('doc-preview', nextMode);
    paged.mode = nextMode;
    if (nextMode === 'paged') {
      const pageUrl = paged.pages?.get(paged.page);
      if (pageUrl) {
        paged.url = pageUrl;
        S.preview = { ...p, paged: { ...paged, mode: 'paged', url: pageUrl, pending: false, error: '' } };
        renderInspector();
        focus();
        return;
      }
      const token = S.previewToken;
      paged.pending = true;
      S.preview = { ...p, paged: { ...paged, mode: 'paged', pending: true, error: '' } };
      renderInspector();
      let res;
      try { res = await renderPage(a, p.data.kind, paged.page, p.slideSession); }
      catch (err) { res = { error: msg(err) }; }
      if (S.previewToken !== token || S.preview?.signature !== signature) return;
      if (res?.url) {
        paged.pages?.set(paged.page, res.url);
        S.preview = { ...S.preview, paged: { ...S.preview.paged, mode: 'paged', url: res.url, pending: false, error: '' } };
      } else {
        S.preview = { ...S.preview, paged: { ...S.preview.paged, mode: 'paged', error: res?.error || '无法载入页面', pending: false } };
      }
      renderInspector();
      focus();
      return;
    } else {
      S.preview = { ...p, paged: { ...paged, mode: 'flow' } };
      renderInspector();
      focus();
      const targetItem = inspector.querySelector(`.pdf-flow-item[data-page="${paged.page}"]`);
      targetItem?.scrollIntoView({ block: 'nearest' });
      return;
    }
  }

  if (['in', 'out', 'fit'].includes(value)) {
    const zoom = value === 'fit' ? 100 : Math.max(100, Math.min(300, paged.zoom + (value === 'in' ? 50 : -50)));
    if (zoom === paged.zoom) return;
    paged.zoom = zoom;
    for (const img of inspector.querySelectorAll('.pdf-page > img, .pdf-flow-item > img')) img.style.width = `${zoom}%`;
    const zoomLabel = inspector.querySelector('.pdf-zoom');
    if (zoomLabel) zoomLabel.textContent = `${zoom}%`;
    const outBtn = inspector.querySelector('[data-act="pdf-view"][data-value="out"]');
    const inBtn = inspector.querySelector('[data-act="pdf-view"][data-value="in"]');
    if (outBtn) { if (zoom === 100) outBtn.setAttribute('aria-disabled', 'true'); else outBtn.removeAttribute('aria-disabled'); }
    if (inBtn) { if (zoom === 300) inBtn.setAttribute('aria-disabled', 'true'); else inBtn.removeAttribute('aria-disabled'); }
    focus();
    return;
  }

  if (value.startsWith('retry-')) {
    const idx = parseInt(value.slice(6), 10);
    if (Number.isInteger(idx)) scheduleFlowLoad(idx, true);
    return;
  }

  if (!['prev', 'next'].includes(value)) return;

  const isFlow = (paged.mode || prefs.docPreview || 'flow') === 'flow';
  const index = paged.page + (value === 'next' ? 1 : -1);
  if (index < 0 || index >= paged.count) return;

  if (isFlow) {
    paged.page = index;
    syncFlowActivePage(inspector, index, paged.count);
    const targetItem = inspector.querySelector(`.pdf-flow-item[data-page="${index}"]`);
    targetItem?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    scheduleFlowLoad(index, true);
    focus();
    return;
  }

  if (paged.pending) return;
  const token = S.previewToken;
  if (paged.pages?.has(index)) {
    const pageUrl = paged.pages.get(index);
    paged.page = index;
    paged.url = pageUrl;
    paged.error = '';
    S.preview = { ...p, paged: { ...paged, page: index, url: pageUrl, error: '', pending: false } };
    renderInspector();
    focus();
    return;
  }

  paged.page = index;
  paged.error = '';
  paged.pending = true;
  S.preview = { ...p, paged: { ...paged, page: index, error: '', pending: true } };
  renderInspector();
  focus();
  let result;
  try { result = await renderPage(a, p.data.kind, index, p.slideSession); }
  catch (error) { result = { error: msg(error) }; }
  if (S.previewToken !== token || S.preview?.signature !== signature) return;
  const restoreFocus = document.activeElement?.matches(`[data-act="pdf-view"][data-value="${value}"]`);
  if (result.downloadMarked) {
    S.preview = { ...p, ...result };
  } else {
    if (result.url) paged.pages?.set(index, result.url);
    S.preview = {
      ...S.preview,
      paged: {
        ...S.preview.paged,
        page: index,
        count: result.count ?? S.preview.paged.count,
        url: result.url ?? S.preview.paged.url,
        error: result.error ?? '',
        pending: false,
      },
    };
  }
  renderInspector();
  if (restoreFocus) focus();
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
  const { onSubmit, ...rest } = opts;
  return new Promise(resolve => showDialog({ ...rest, title, text, onSubmit: values => { onSubmit?.(values); resolve(true); }, onCancel: () => { resolve(false); } }));
}
function filterDialog() {
  const f = S.filters;
  showDialog({ title: '筛选资产', text: '不同维度可组合；所选标记须同时匹配。', symbol: 'list-filter', submit: '应用筛选',
    body: `${labeled('主分类', select('category', [['', '所有分类'], ['!none', '未分类'], ...categoryOptions(catIndex).map(c => [c.id, c.label])], f.category))}${labeled('类型', select('type', typeOptions, f.type))}
    ${checkFields('标记', 'flags', flags, f.flags)}`,
    onSubmit: data => { S.viewId = null; S.filters = { category: data.get('category'), flags: data.getAll('flags'), type: data.get('type') }; clearSelection(); S.limit = 160; render({ keepScroll: false }); } });
}
function checkFields(label, name, values, selected = []) {
  return `<fieldset class="form-options"><legend>${esc(label)}</legend>${values.length ? values.map(v => check(name, v, v, selected.includes(v))).join('') : '<span class="muted">无可选项</span>'}</fieldset>`;
}
let popAnchor, popFocus, popCloseTimer, popToken = 0, contextTarget = null;
const menuOpen = () => !pop.hidden && pop.dataset.state === 'open';
const menuItems = () => [...pop.querySelectorAll('.c-menu__item:not([aria-disabled="true"])')];
function finishClose() {
  clearTimeout(popCloseTimer);
  pop.hidden = true; pop.dataset.state = ''; pop.innerHTML = ''; pop.classList.remove('has-checks');
  popAnchor?.setAttribute('aria-expanded', 'false');
  popAnchor = null; contextTarget = null;
  // A menu opened inside a modal lives in that dialog's top layer; put it back
  // so the next redraw of the dialog cannot drop it.
  if (pop.parentElement !== document.body) document.body.append(pop);
}
// `point` opens a coordinate menu (right-click). It keeps focus on the panel —
// a pointer menu must not pre-select a row — and grows from the pointer itself.
function showMenu(anchor, markup, point) {
  if (menuOpen() && anchor && popAnchor === anchor && !point) { closeMenu(); return; }
  const restore = menuOpen() ? popFocus : document.activeElement instanceof HTMLElement ? document.activeElement : null;
  // Read the anchor box first: a menu opened from another menu replaces the
  // panel, and the anchor would already be detached by then.
  const box = anchor?.getBoundingClientRect();
  finishClose();
  ++popToken;
  popAnchor = anchor || null; popFocus = restore;
  // A <dialog open> is in the top layer: a body-level panel would render behind
  // it, so the menu rides along inside the dialog while one is modal.
  const host = modal.open ? modal : commandDialog.open ? commandDialog : document.body;
  if (pop.parentElement !== host) host.append(pop);
  pop.hidden = false; pop.dataset.state = 'open'; pop.innerHTML = markup;
  pop.classList.toggle('has-checks', !!pop.querySelector('.c-menu__item[aria-checked="true"]'));
  pop.setAttribute('role', 'menu');
  anchor?.setAttribute('aria-expanded', 'true');
  const x = point?.x ?? box?.left ?? 8, y = point?.y ?? (box ? box.bottom + 6 : 8);
  const width = pop.offsetWidth, height = pop.offsetHeight;
  const left = Math.max(8, Math.min(x, innerWidth - width - 8));
  const top = y + height > innerHeight - 8 ? Math.max(8, (point ? y : box.top - 6) - height) : Math.max(8, y);
  pop.style.left = `${left}px`; pop.style.top = `${top}px`;
  pop.style.setProperty('--origin', `${Math.max(2, Math.min(width - 2, x - left))}px ${Math.max(2, Math.min(height - 2, y - top))}px`);
  const checked = pop.querySelector('.c-menu__item[aria-checked="true"], .c-menu__item[aria-selected="true"]');
  if (point) pop.focus({ preventScroll: true });
  else (checked || menuItems()[0])?.focus({ preventScroll: true });
}
pop.addEventListener('pointerover', e => {
  const item = e.target.closest('.c-menu__item:not([aria-disabled="true"])');
  if (item && item !== document.activeElement) item.focus({ preventScroll: true });
});
// The panel stays on screen for the library's 120ms exit transition; `popToken`
// makes sure a menu opened in that window is not wiped by the pending timer.
function closeMenu(focus = true) {
  if (pop.hidden) return;
  const anchor = popAnchor, restore = popFocus;
  popAnchor = null; popFocus = null;
  anchor?.setAttribute('aria-expanded', 'false');
  pop.dataset.state = 'closing';
  const token = ++popToken;
  clearTimeout(popCloseTimer);
  popCloseTimer = setTimeout(() => { if (token === popToken) finishClose(); }, 130);
  if (focus) (restore?.isConnected ? restore : anchor?.isConnected ? anchor : null)?.focus({ preventScroll: true });
}
const newItems = () => menuItem('新建仓库', 'new-vault', { glyph: 'plus' }) + menuItem('添加现有文件夹', 'add-vault', { glyph: 'folder-open' });
function vaultMenu(anchor) {
  const current = vault();
  const list = [menuCaption('仓库')];
  for (const root of roots()) {
    list.push(menuItem(root.name, 'switch', { glyph: 'hard-drive', value: root.id, selected: root.id === S.id }));
    const units = S.registry.filter(u => u.parent_id === root.id);
    for (const u of units) {
      list.push(menuItem(`  └ ${u.name}`, 'switch', { glyph: 'layers', value: u.id, selected: u.id === S.id }));
    }
  }
  if (current) {
    list.push(menuLine);
    if (current.parent_id) {
      const parent = getVault(current.parent_id);
      list.push(menuItem(`返回所属仓库 (${parent?.name || '上级'})`, 'switch', { glyph: 'corner-up-left', value: current.parent_id }));
      list.push(menuItem('重命名整体单元', 'rename-vault', { glyph: 'square-pen', value: current.id }));
    } else {
      list.push(menuItem('重命名仓库', 'rename-vault', { glyph: 'square-pen', value: current.id }));
      list.push(relocateVaultItem(current.id));
      list.push(menuItem('移除仓库', 'remove-vault', { glyph: 'ban', value: current.id, danger: true }));
    }
  }
  list.push(menuLine, newItems());
  showMenu(anchor, list.join(''));
}
function assetMenu(anchor, a, point) {
  if (!a) return;
  const key = assetKey(a), i = (label, command, glyph, options) => menuItem(label, command, { value: key, glyph, ...options });
  const copyPath = menuItem('复制真实路径', 'copy-value', { value: extPath(a), glyph: 'copy' });
  if (a.synthetic) return showMenu(anchor, i('打开文件夹', 'open-asset', 'folder-open', { shortcut: 'Enter' }) + copyPath, point);
  if (a.state === 'missing') return showMenu(anchor, i('核对并关联身份', 'recover-identity', 'link') + copyPath, point);
  const live = a.state !== 'excluded';
  const inboxCount = isDir(a) ? folderInboxItems(a).length : 0;
  showMenu(anchor, i(a.kind === 'unit' ? '进入整体单元' : isDir(a) ? '浏览文件夹' : '打开', 'open-asset', 'external-link', { shortcut: 'Enter' }) + (!isDir(a) ? i('预览', 'preview-one', 'eye', { shortcut: 'Space' }) + (runnable(a) ? '' : i('打开方式…', 'choose-file', 'app-window')) : '') + i('在资源管理器中显示', 'reveal', 'folder-open') + copyPath + i('属性', 'file-properties', 'info') + menuLine +
    (live ? i(a.flags.length ? '编辑标记' : '添加标记', 'mark-one', 'flag') + i('整理信息', 'organize-one', 'tag') + (a.state === 'inbox' ? i('入库', 'file-in-one', 'check') : inboxCount ? i(`全部入库 (${inboxCount})`, 'file-in-folder', 'check') : '') : i('重新纳入', 'restore-one', 'undo')) +
    (live ? i('重命名文件', 'rename-file', 'square-pen', { shortcut: 'F2' }) + i('移动到…', 'move-one', 'move') + (a.kind === 'directory' ? i('设为整体单元并进入', 'open-unit', 'layers') : '') : '') + menuLine +
    (live ? i('从仓库排除', 'exclude-one', 'ban') : '') + (runnable(a) ? i('执行文件…', 'run', 'play', { danger: true }) : '') + i('移至回收站…', 'recycle-one', 'trash', { danger: true, shortcut: 'Del' }), point);
}
function searchMenu(anchor) {
  showMenu(anchor, `${menuCaption('搜索范围')}${scopeOptions.map(([id, label]) => menuItem(label, 'scope', { value: id, selected: id === S.scope, glyph: 'search' })).join('')}${menuLine}${menuItem('包含整体单元内部', 'search-deep', { glyph: 'layers', selected: S.deep })}${menuItem('搜索文件内容（含文档）', 'search-content', { glyph: 'file-text', selected: S.content })}`);
}
async function loadRegistry() {
  const ticket = ++S.registryToken;
  const data = arr(await host.list());
  if (ticket !== S.registryToken) return;
  S.registry = data;
  for (const v of data) if (S.cache.has(v.id)) S.cache.get(v.id).vault = { ...S.cache.get(v.id).vault, ...v };
  for (const id of S.cache.keys()) if (!data.some(v => v.id === id)) S.cache.delete(id);
  if (S.id && !data.some(v => v.id === S.id)) {
    S.id = roots()[0]?.id || null; if (!S.id && !configurationPage()) S.page = 'home'; clearSelection();
  }
}
const requests = new Map(), generations = new Map();
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
  if (active) {
    const oldError = S.error;
    S.error = ''; S.loading = true;
    if (S.cache.has(id) && !oldError) renderStatus(); else render();
  }
  try { await loadSnapshot(id, fresh); }
  catch (error) { if (id === S.id) S.error = msg(error); else throw error; }
  finally { if (id === S.id) { S.loading = false; render(); } }
}
function clearSelection() { flowQueue = []; S.deferFolderPane = false; S.selected.clear(); S.anchor = null; S.multi = false; S.previewToken++; S.preview = null; S.tab = 'details'; }
function resetView() { S.limit = 160; S.filters = clearFilters(); clearSelection(); S.error = ''; }
function nav(page, opts = {}) {
  if (page === 'marking' || page === 'tags') page = 'flags';
  if (!pages[page]) return;
  clearTimeout(searchTimer); S.review = false; S.viewId = opts.viewId ?? null;
  if (!vault() && !['home', 'settings', 'search'].includes(page)) page = 'home';
  S.page = page; S.facet = opts.facet ?? ''; S.folder = norm(opts.folder ?? ''); resetView();
  if (opts.filters) S.filters = structuredClone(opts.filters);
  if (page !== 'search') { S.query = ''; S.searchToken++; S.searchItems = []; S.searchOrigin = null; }
  render({ keepScroll: false });
  if (page === 'duplicates') void getDuplicates();
  if (page === 'settings') void readApi();
  recordView();
}
async function switchVault(id, page = 'physical', folder = '') {
  if (!getVault(id)) return;
  S.id = id; persist('active', id); S.notice = ''; S.dup = null; S.dupToken++;
  const cached = S.cache.has(id) && !S.changed.has(id);
  S.loading = !cached;
  nav(page, { folder });
  if (!cached) await refreshView(id, false);
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
function selectedKeys(key, additive, range, reveal = true, preserveFolderGeometry = false) {
  const item = itemAt(key); if (!item) return;
  const prev = one();
  // A plain click is "show me this", not "start selecting". Checkbox, Ctrl and
  // Shift clicks are the explicit way into multi-selection.
  S.multi = !!(additive || range);
  if (range && S.anchor && S.byKey.has(S.anchor)) {
    let a = S.rows.findIndex(row => assetKey(row.item) === S.anchor), b = S.rows.findIndex(row => assetKey(row.item) === key);
    if (!additive) S.selected.clear();
    const low = Math.min(a, b), high = Math.max(a, b);
    for (const row of S.rows.slice(low, high + 1)) if (!row.item.synthetic) S.selected.add(assetKey(row.item));
  } else {
    if (!additive || item.synthetic) S.selected.clear();
    else for (const k of S.selected) if (itemAt(k)?.synthetic) S.selected.delete(k);
    if (additive && S.selected.has(key)) S.selected.delete(key);
    else S.selected.add(key);
    S.anchor = key;
  }
  // Deselecting the last row leaves multi-selection instead of an empty bar.
  if (!S.selected.size) S.multi = false;
  if (reveal && !S.multi) {
    const folder = isDir(item);
    // Preserve the pane geometry across the first and second pointer clicks.
    // This only defers the pane for this selection, not future auto-previews.
    const deferFolderPane = folder && preserveFolderGeometry && inspector.hidden;
    if (!deferFolderPane) S.pane = true;
    S.tab = folder ? 'details' : 'preview';
    syncSelection(prev, deferFolderPane);
  } else syncSelection(prev);
}
function syncSelectAll() {
  const real = S.items.filter(a => !a.synthetic), count = real.reduce((n, a) => n + Number(S.selected.has(assetKey(a))), 0);
  workspace.querySelectorAll('[data-select-all]').forEach(box => { box.checked = !!real.length && real.length === count; box.indeterminate = count > 0 && count < real.length; });
}
function syncSelection(old, deferFolderPane = false) {
  const paneWasDeferred = S.deferFolderPane;
  S.deferFolderPane = deferFolderPane;
  const item = one();
  if (old !== item) { flowQueue = []; S.previewToken++; S.preview = null; }
  if (!item || item.synthetic || item.state === 'missing') S.tab = 'details';
  const bulk = $('#bulk'); if (bulk) { unmount(bulk); bulk.outerHTML = renderBulk(); mount($('#bulk')); }
  updateReview();
  $('#items')?.classList.toggle('multi', S.multi);
  for (const node of workspace.querySelectorAll('[data-asset]')) {
    const selected = S.selected.has(node.dataset.asset); node.classList.toggle('selected', selected);
    if (node.hasAttribute('aria-selected')) node.setAttribute('aria-selected', selected);
    const box = node.querySelector('[data-asset-check]'); if (box) box.checked = selected;
  }
  syncSelectAll();
  renderInspector(); renderStatus();
  if (paneWasDeferred !== S.deferFolderPane) renderChromeInto();
  if (item && !inspector.hidden && S.tab === 'preview' && needsPreview(item)) void loadPreview(item);
}
function selectAll(checked) {
  const old = one(); S.selected = checked ? new Set(S.items.filter(a => !a.synthetic).map(assetKey)) : new Set(); S.multi = checked; syncSelection(old);
}
function remember(item) {
  const key = assetKey(item);
  // Revisiting a row while browsing Recently Used shouldn't move it under the pointer.
  prefs.recent.delete(key); prefs.recent.set(key, Date.now()); persist('recent', [...prefs.recent].slice(-300));
}
let slideSession = Date.now() * 1024;
async function renderPage(a, kind, index, session, confirmedSession = null) {
  if (kind === 'pdf') return pageResult(await host.pdfPage(a.vaultId, a.id, index), index);
  const result = await host.slidePage(a.vaultId, a.id, { page: index, session, confirmedSession });
  if (result?.status === 'download_marked') return { downloadMarked: session };
  if (result?.status !== 'rendered') throw new Error('未收到有效的幻灯片预览结果。');
  return pageResult(result, index);
}
const needsPreview = a => S.preview?.signature !== previewSignature(a) || !!S.preview?.error;
async function loadPreview(a, { used = true, confirmedSession = null, retryImage = true } = {}) {
  if (!a || a.synthetic || a.state === 'missing') return;
  const key = assetKey(a), token = ++S.previewToken;
  const signature = previewSignature(a);
  S.preview = { key, signature, loading: true }; renderInspector();
  try {
    const data = await host.preview(a.vaultId, a.id);
    if (S.previewToken !== token) return;
    const session = data?.kind === 'slides' ? ++slideSession : null;
    const page = ['pdf', 'slides'].includes(data?.kind) ? await renderPage(a, data.kind, 0, session, confirmedSession) : null;
    if (S.previewToken !== token) return;
    const pages = new Map();
    if (page?.url) pages.set(0, page.url);
    S.preview = { key, signature, data, retryImage, slideSession: session, downloadMarked: page?.downloadMarked, paged: page && { ...page, zoom: 100, pages, loadingPages: new Set(), mode: prefs.docPreview || 'flow' } };
    if (used) remember(a);
  }
  catch (error) { if (S.previewToken !== token) return; S.preview = { key, signature, error: msg(error) }; }
  renderInspector();
}
async function previewMarkedOnce(a) {
  const p = S.preview;
  if (!p?.downloadMarked || p.signature !== previewSignature(a) || S.tab !== 'preview' || inspector.hidden) return;
  const confirmed = await ask('仍然预览此文件？', `「${a.name}」带有 Windows 下载标记。仅在信任文件来源时继续。${p.data.kind === 'slides' ? 'PowerPoint 将只读渲染临时副本' : '本次将把文件内容交给 Windows 预览器'}；不会解除原文件的下载标记或修改原文件。`, {
    symbol: 'triangle-alert', submit: '仅本次预览',
  });
  if (!confirmed || S.preview !== p || p.signature !== previewSignature(one()) || S.tab !== 'preview' || inspector.hidden) return;
  if (p.data.kind === 'slides') return loadPreview(a, { confirmedSession: p.downloadMarked });
  // Pass the confirmation only to this render, never to regular retries or redraws.
  S.preview = { ...p, downloadMarked: null };
  renderInspector(p.downloadMarked);
}
function previewOne(a) {
  if (!a || a.synthetic || a.state === 'missing') return;
  S.selected = new Set([assetKey(a)]); S.anchor = assetKey(a); S.multi = false; S.pane = true; S.tab = 'preview';
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
// Adopt a whole folder as one project without leaving the current page: its
// files stop appearing in the parent inbox and live in the unit's own space.
async function unitize(item) {
  if (!item || item.kind !== 'directory' || item.synthetic) return;
  if (knowsUnit(item)) return toast('这个文件夹已经是整体单元。');
  if (!await ask('作为整体单元入库？', `「${item.name}」会成为仓库里的单一项目，内部文件在自己的空间里管理；磁盘上的文件夹结构不会变化。`, { symbol: 'layers', submit: '设为整体单元' })) return;
  const v = await host.unit(item.vaultId, item.id);
  if (!S.registry.some(old => old.id === v.id)) S.registry.push(v);
  S.changed.add(item.vaultId);
  await afterChanges([item.vaultId]);
  toast('已作为整体单元入库');
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
const relocateVaultItem = id => menuItem('重定位仓库…', 'relocate-vault', { value: id, glyph: 'folder-open' });
function relocateVault(v) {
  if (!v || v.parent_id) return;
  showDialog({
    title: '重定位仓库', symbol: 'folder-open', submit: '应用新位置',
    text: '选择整体搬迁后的原仓库文件夹。资产、标签和视图会保留。此操作不会移动文件，也不接受复制品。',
    body: `${labeled('原位置', field(v.root, 'previous_path', { readonly: true }))}<div class="path-input"><div>${labeled('新位置', field('', 'path', { placeholder: '未选择文件夹', readonly: true, max: 32768 }))}</div>${button('选择…', 'pick-folder', { glyph: 'folder-open', style: 'secondary', value: '选择搬迁后的原仓库文件夹' })}</div>`,
    onSubmit: async data => {
      const path = data.get('path');
      if (!path) throw new Error('请先选择搬迁后的仓库文件夹。');
      await host.relocate(v.id, path);
      // The binding is durable already; a refresh failure must not look like a failed move.
      try {
        await loadRegistry();
        const affected = vaultSubtree(S.registry, v.id);
        if (affected.has(S.id)) S.notice = '';
        for (const id of affected) S.changed.add(id);
        await afterChanges([...affected].filter(id => id === S.id || S.cache.has(id) || requests.has(id)));
        render();
      } catch (error) {
        changed('');
        toast(`仓库已重定位，但刷新未完成：${msg(error)}`, 'warn');
        return;
      }
      toast('仓库已重定位，正在同步新位置');
    },
  });
}
function renameVault(v) {
  if (!v) return;
  const isUnit = !!v.parent_id;
  showDialog({
    title: isUnit ? '重命名整体单元' : '重命名仓库',
    text: isUnit ? '只修改整体单元的显示名称，不重命名磁盘上的文件夹。' : '只修改显示名称，不重命名磁盘上的文件夹。',
    symbol: 'square-pen',
    submit: '保存名称',
    body: labeled(isUnit ? '单元名称' : '仓库名称', field(v.name, 'name', { required: true, placeholder: isUnit ? '整体单元名称' : '仓库名称' })),
    onSubmit: async data => {
      const name = validateName(data.get('name'));
      await host.rename(v.id, name);
      S.registry = S.registry.map(item => item.id === v.id ? { ...item, name } : item);
      if (S.cache.has(v.id)) S.cache.get(v.id).vault.name = name;
      render();
      toast(isUnit ? '整体单元已重命名' : '仓库已重命名');
    }
  });
}
function removeVault(v) {
  if (!v) return;
  showDialog({ title: '移除仓库？', text: `「${v.name}」将从仓库列表中移除，并撤销它和下属单元的 Agent CLI 授权。磁盘上的原文件不会删除。`, symbol: 'ban', danger: true, submit: '移除仓库', onSubmit: async () => {
    await host.remove(v.id);
    const detached = new Set([v.id]);
    for (let size = 0; size !== detached.size;) { size = detached.size; for (const item of S.registry) if (detached.has(item.parent_id)) detached.add(item.id); }
    S.registry = S.registry.filter(item => !detached.has(item.id));
    for (const id of detached) { S.cache.delete(id); S.access.delete(id); S.expanded.delete(`${id}:tree`); S.expanded.delete(`${id}:inbox`); }
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
  else if (ids.some(id => id !== S.id)) render();
  if (S.page === 'duplicates') void getDuplicates();
  const item = one();
  if (item && !inspector.hidden && S.tab === 'preview' && needsPreview(item)) void loadPreview(item, { used: false });
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
  if (items.some(isDir)) {
    const direct = items.filter(i => !isDir(i));
    const fromDirs = items.filter(isDir).flatMap(d => {
      const children = folderInboxItems(d);
      return children.length ? children : [d];
    });
    items = unique([...direct, ...fromDirs]);
  }
  items = items.filter(markable);
  if (!items.length) return;
  const a = items.length === 1 ? items[0] : null;
  const choices = unique([...markChoices, ...(a?.flags ?? [])]);
  showDialog({ title: a?.flags.length ? '编辑标记' : a ? '添加标记' : '批量添加标记',
    text: '只修改标记，不会改变入库状态或原文件。', symbol: 'flag', submit: '保存标记',
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
  if (items.some(isDir)) {
    const direct = items.filter(i => !isDir(i));
    const fromDirs = items.filter(isDir).flatMap(d => {
      const children = folderInboxItems(d);
      return children.length ? children : [d];
    });
    items = unique([...direct, ...fromDirs]);
  }
  items = items.filter(a => !a.synthetic && !['excluded', 'missing'].includes(a.state));
  if (!items.length) return;
  const id = items[0].vaultId, singleVault = perVault(items).size === 1, a = items.length === 1 ? items[0] : null;
  const opts = singleVault ? categoryOptions(makeCategoryIndex(S.cache.get(id)?.categories || [])) : [];
  showDialog({ title: review ? '整理后入库' : a ? '整理资产' : '批量整理', text: '在这里修改管理信息，不会移动磁盘上的文件。', symbol: 'layers', submit: review ? '保存并入库' : '保存整理信息',
    body: `${targetSummary(items)}${singleVault ? labeled('主分类', select('category', [['!keep', '保留原分类'], ['', '未分类'], ...opts.map(c => [c.id, c.label])], a ? a.category_id || '' : '!keep')) : '<p class="muted">多仓库选择不支持同时设置主分类。</p>'}
    ${a ? labeled('标记', field(a.flags.join('，'), 'flags', { placeholder: '例如：重点关注，待处理', max: 2000 })) + `<div class="suggestions"><small>添加常用标记</small>${defaultFlags.map(f => `<button type="button" class="facet" ${act('add-flag-chip', f)}>${icon('plus', 12)}${esc(f)}</button>`).join('')}</div>`
    : labeled('添加标记', field('', 'add-flags', { placeholder: '例如：重点关注，待处理', max: 2000 })) + labeled('移除标记', field('', 'remove-flags', { placeholder: '用逗号分隔', max: 2000 }))}
    ${review ? '' : labeled('入库状态', select('state', [['', '保留状态'], ['filed', '标记为已入库'], ['inbox', '放回收件箱']]))}`,
    onSubmit: async data => {
      const patch = {}, category = data.get('category'), state = data.get('state');
      if (singleVault && category !== '!keep' && (!a || (a.category_id ?? '') !== category)) patch.category_id = category || null;
      if (state) patch.state = state;
      const parsedFlags = parseLabels(data.get('flags'));
      const addFlags = a ? parsedFlags.filter(t => !a.flags.includes(t)) : parseLabels(data.get('add-flags'));
      const removeFlags = a ? a.flags.filter(t => !parsedFlags.includes(t)) : parseLabels(data.get('remove-flags'));
      if (addFlags.some(t => removeFlags.includes(t))) throw new Error('同一个标记不能同时添加和移除。');
      if (addFlags.length) patch.add_flags = addFlags;
      if (removeFlags.length) patch.remove_flags = removeFlags;
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
function revealDestination(destination) {
  // Show the destination branch so a moved item does not seem to vanish into a
  // collapsed folder. Cross-vault moves have no branch in this view.
  const active = vault();
  if (active && containsPath(active.root, destination) && pathKey(destination) !== pathKey(active.root)) {
    const rel = relative(active.root, destination);
    if (rel) { expandedPaths(active.id, expandScope()).add(pathKey(rel)); render(); }
  }
}
function commitMove(items, destination) {
  return batchFile(items, 'move', a => ({ value: destination, confirmed: !containsPath(getVault(a.vaultId)?.root, destination) }), '已移动');
}
async function move(items) {
  items = items.filter(a => !a.synthetic && !['excluded', 'missing'].includes(a.state)); if (!items.length) return;
  const p = await host.choose('选择目标文件夹'); if (!p) return;
  if (items.some(a => isDir(a) && containsPath(extPath(a), p))) throw new Error('不能将文件夹移动到自身或下级目录。');
  const outside = items.some(a => !containsPath(getVault(a.vaultId)?.root, p));
  showDialog({ title: outside ? '移动到仓库外？' : '移动磁盘项目？', text: outside ? '部分项目将移出其仓库，不再出现在原仓库的常规视图中。' : '项目的真实磁盘路径将发生变化。', symbol: 'move', submit: '移动', danger: outside,
    body: `${targetSummary(items)}${labeled('目标文件夹', field(p, 'destination', { readonly: true, max: 32768, placeholder: '目标文件夹' }))}`,
    onSubmit: async () => { await commitMove(items, p); revealDestination(p); } });
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
  S.searching = false; S.searchErrors = errors; S.searchItems = searchAssets(results, keyword, matches, getSnapshotIndex); render();
}
let searchTimer;
function beginSearch(value, immediate = false) {
  clearTimeout(searchTimer); S.query = value;
  if (!value.trim() && S.page !== 'search') return;
  if (!value.trim()) {
    const origin = S.searchOrigin;
    S.searchOrigin = null;
    if (origin && origin.vaultId === S.id) { S.sort = origin.sort; S.direction = origin.direction; nav(origin.page, origin); }
    else nav(S.id ? 'physical' : 'home');
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
function toggleFoldersFirst() {
  prefs.foldersFirst = !prefs.foldersFirst;
  persist('folders-first', prefs.foldersFirst);
  render({ keepScroll: false });
}
async function scan() {
  if (!S.id || S.scanning) return;
  const id = S.id;
  S.scanning = id;
  if (S.page === 'settings') render(); else renderStatus();
  try {
    await host.rescan(id);
    await afterChanges([id]);
    toast('扫描完成');
  } finally {
    S.scanning = null;
    if (S.page === 'settings') render(); else renderStatus();
  }
}
const menus = new Set(['vault-menu', 'new-menu', 'manage-vault', 'asset-menu', 'bulk-menu', 'category-menu', 'sort-menu', 'search-menu', 'library-menu', 'saved-menu', 'category-select-menu', 'label-select-menu']);
async function action(name, value, node) {
  const a = ['asset-menu','open-asset','preview-one','organize-one','file-in-one','file-in-folder','restore-one','exclude-one','recycle-one','rename-file','move-one','open-unit','unitize','run','choose-file','reveal','file-properties','recover-identity','mark-one'].includes(name) ? resolveItem(value) : null;
  const picked = selection();
  if (!menus.has(name)) closeMenu();
  if (modal.open && modalController?.active && node?.closest('#modal')) return;
  switch (name) {
    case 'nav': return nav(value);
    case 'check-update': return updates.check();
    case 'install-update': return confirmUpdate();
    case 'update-releases': return host.updateReleases();
    case 'history-back': return goHistory(-1);
    case 'history-forward': return goHistory(1);
    case 'library-mode': return nav(value);
    case 'rail-resize': return resizeRail(value);
    case 'mark-one': return editMarks(a ? [a] : []);
    case 'mark-selected': return editMarks(picked);
    case 'library-menu': return showMenu(node, libraryItems().map(i => menuItem(i.label, i.name, { glyph: i.icon, value: i.value, selected: i.checked, disabled: i.disabled })).join(''));
    case 'saved-menu': return showMenu(node, savedViews().map(v => menuItem(v.name, 'open-view', { glyph: 'star', value: v.id, selected: v.id === S.viewId })).join(''));
    case 'category-select-menu': return showMenu(node, [['', '全部分类'], ...categoryOptions(catIndex).map(c => [c.id, c.label])].map(([id, label]) => menuItem(label, 'category', { value: id, selected: id === S.facet })).join(''));
    case 'label-select-menu': return showMenu(node, ['', ...flags].map(label => menuItem(label || '全部', 'facet', { value: label, selected: label === S.facet })).join(''));
    case 'command-palette': return showCommands();
    case 'search-input': if (!composing) beginSearch(value); return;
    case 'titlebar-mode': try { await setWindowChromeMode(value); } catch (error) { render(); throw error; } return;
    case 'set-theme': prefs.theme = value; persist('theme', value); setTheme(); return;
    // The attribute alone re-renders every glass surface; no component rebuild.
    case 'glass-effects': vaultaEffects.save(value); return;
    case 'set-access': return setAccess(value).catch(error => toast(msg(error), 'error'));
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
    case 'toggle-rail': {
      S.rail = !S.rail;
      closeMenu(false);
      $('#app').classList.toggle('rail-hidden', !S.rail);
      const label = `${S.rail ? '隐藏' : '显示'}${prefs.nav === 'dock' ? '导航' : '侧栏'}`;
      const btn = $('#rail-toggle [data-act="toggle-rail"]');
      if (btn) {
        btn.setAttribute('aria-expanded', String(S.rail));
        btn.setAttribute('aria-label', label);
        btn.title = label;
      } else {
        redraw($('#rail-toggle'), ib(label, 'toggle-rail', 'panel-left', { attrs: `aria-expanded="${S.rail}"` }));
      }
      applyInspectWidth();
      renderDock();
      renderRailGrip();
      renderInspectGrip();
      return;
    }
    case 'toggle-pane':
      S.pane = S.deferFolderPane || !S.pane; S.deferFolderPane = false;
      closeMenu(false);
      renderInspector();
      renderChromeInto();
      renderStatus();
      if (!inspector.hidden && S.tab === 'preview' && one() && needsPreview(one())) void loadPreview(one());
      return;
    case 'edit-undo': editFocus(); document.execCommand('undo'); return;
    case 'edit-redo': editFocus(); document.execCommand('redo'); return;
    case 'edit-cut': return editClipboard('cut');
    case 'edit-copy': return editClipboard('copy');
    case 'edit-paste': return editClipboard('paste');
    case 'edit-select-all': return editSelectAll();
    case 'copy-selection': return clipboard(String(window.getSelection?.() || ''));
    case 'search-selection': {
      const text = String(window.getSelection?.() || '').replace(/\s+/g, ' ').trim();
      if (text) beginSearch(text, true);
      return;
    }
    case 'vault-menu': return vaultMenu(node);
    case 'new-menu': return showMenu(node, newItems());
    case 'manage-vault': {
      const target = getVault(value);
      const isUnit = !!target?.parent_id;
      return showMenu(node, menuItem(isUnit ? '进入整体单元' : '打开仓库', 'switch', { value, glyph: isUnit ? 'layers' : 'hard-drive' }) + menuItem('重命名', 'rename-vault', { value, glyph: 'square-pen' }) + (!isUnit ? relocateVaultItem(value) + menuItem('移除仓库', 'remove-vault', { value, glyph: 'ban', danger: true }) : ''));
    }
    case 'new-vault': return newVault(true);
    case 'add-vault': return newVault(false);
    case 'relocate-vault': return relocateVault(getVault(value));
    case 'rename-vault': return renameVault(getVault(value));
    case 'remove-vault': return removeVault(getVault(value));
    case 'pick-folder': {
      const form = node.closest('form'); node.disabled = true;
      try { const p = await host.choose(value); if (p && form.isConnected) { form.elements.path.value = p; if (value.includes('现有') && form.elements.name && !form.elements.name.value) form.elements.name.value = basename(p); } }
      catch (error) { if (form.isConnected) dialogError(error); }
      finally { if (node.isConnected) node.disabled = false; }
      return;
    }
    case 'close-dialog': closeDialog(); return;
    case 'folder': return nav('physical', { folder: value });
    case 'category': return nav('category', { facet: value });
    case 'facet': return nav(S.page, { facet: value });
    case 'layout': prefs.layout = value; persist('layout', value); render(); return;
    case 'nav-mode': if (!navOptions.some(([id]) => id === value) || prefs.nav === value) return; prefs.nav = value; persist('nav', value); if (value === 'dock') S.rail = true; render(); return;
    case 'move-confirm': prefs.confirmMove = value === 'on'; persist('confirm-move', prefs.confirmMove); render(); return;
    case 'doc-preview': {
      if (!['flow', 'paged'].includes(value) || prefs.docPreview === value) return;
      prefs.docPreview = value;
      persist('doc-preview', value);
      if (S.preview?.paged) {
        const pageUrl = (value === 'paged' ? S.preview.paged.pages?.get(S.preview.paged.page) : null) || S.preview.paged.url;
        S.preview = { ...S.preview, paged: { ...S.preview.paged, mode: value, url: pageUrl } };
      }
      render();
      return;
    }
    case 'popup-choice': {
      const [name, option] = JSON.parse(value);
      if (['switch','rename-vault','relocate-vault','remove-vault','new-vault','add-vault','scope','search-deep','search-content','nav','category','facet','open-view','rescan'].includes(name)) return action(name, option, node);
      return;
    }
    case 'sort': return updateSort(value);
    case 'sort-choice': if (value === 'toggle-folders') return toggleFoldersFirst(); if (value === 'asc' || value === 'desc') return updateSort(S.sort, value); return updateSort(value, value === S.sort ? S.direction : 'asc');
    case 'sort-direction': return updateSort(S.sort, value);
    case 'tree-toggle': {
      if (!value) return;
      const set = expandedPaths(S.id, expandScope());
      if (set.has(value)) set.delete(value); else set.add(value);
      render();
      [...workspace.querySelectorAll('[data-act="tree-toggle"]')].find(node => node.dataset.value === value)?.focus({ preventScroll: true });
      return;
    }
    case 'tree-all': {
      const set = expandedPaths(S.id, expandScope()), keys = S.rows.filter(row => row.tree && row.folder && row.hasChildren).map(row => pathKey(row.item.rel));
      const open = keys.length > 0 && keys.every(key => set.has(key));
      if (open || value === 'collapse') set.clear(); else keys.forEach(key => set.add(key));
      render({ keepScroll: false });
      return;
    }
    case 'toggle-folders': return toggleFoldersFirst();
    case 'sort-menu': return showMenu(node, sortOptions.map(([id, label]) => menuItem(label, 'sort', { value: id, selected: S.sort === id })).join('') + menuLine + menuItem('升序', 'sort-direction', { value: 'asc', selected: S.direction === 'asc' }) + menuItem('降序', 'sort-direction', { value: 'desc', selected: S.direction === 'desc' }) + menuLine + menuItem('文件夹优先', 'toggle-folders', { selected: prefs.foldersFirst }));
    case 'filters': return filterDialog();
    case 'remove-filter': {
      const [key, item] = JSON.parse(value);
      if (key === 'flags') S.filters[key] = S.filters[key].filter(v => v !== item);
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
    case 'more-items': S.limit += 160; render(); return;
    case 'clear-selection': return clearAndSync();
    case 'asset-menu': return assetMenu(node, a);
    case 'bulk-menu': return showMenu(node, menuItem('从仓库排除…', 'exclude', { glyph: 'ban', disabled: !picked.some(i => !i.synthetic && !['excluded','missing'].includes(i.state)) }) + menuItem('复制真实路径', 'copy-paths', { glyph: 'copy' }) + menuLine + menuItem('移至回收站…', 'recycle', { glyph: 'trash', danger: true, disabled: picked.some(i => i.state === 'missing') }));
    case 'open-asset': return openAsset(a);
    case 'open-unit': return openAsset(a, true);
    case 'unitize': return unitize(a);
    case 'preview-one': return previewOne(a);
    case 'retry-preview': return loadPreview(one());
    case 'preview-marked-once': return previewMarkedOnce(one());
    case 'pdf-view': return pageAction(value);
    case 'inspect-tab': S.tab = value; if (value !== 'preview') dismissSlides(); renderInspector(); inspector.querySelector('.c-seg__opt[aria-checked=true]')?.focus({ preventScroll: true }); if (value === 'preview' && one() && needsPreview(one())) await loadPreview(one()); return;
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
    case 'file-in': {
      const direct = picked.filter(i => i.state === 'inbox' && !i.synthetic);
      const fromFolders = picked.filter(i => isDir(i) && !i.synthetic).flatMap(f => folderInboxItems(f));
      const targets = unique([...direct, ...fromFolders]);
      if (!targets.length) return;
      return batchOrganize(targets, { state: 'filed' }, targets.length === 1 ? '已入库' : `${targets.length} 项已入库`);
    }
    case 'file-in-all': {
      const items = S.items.filter(i => !i.synthetic && i.state === 'inbox');
      if (!items.length) return;
      return batchOrganize(items, { state: 'filed' }, '已加入资料库');
    }
    case 'file-in-one': {
      if (!a) return;
      if (isDir(a)) {
        const targets = folderInboxItems(a);
        if (!targets.length) { toast('该文件夹内没有待入库的文件', 'info'); return; }
        return batchOrganize(targets, { state: 'filed' }, `「${a.name}」内 ${targets.length} 项已入库`);
      }
      return batchOrganize([a], { state: 'filed' }, '已入库');
    }
    case 'file-in-folder': {
      if (!a) return;
      const targets = folderInboxItems(a);
      if (!targets.length) { toast('该文件夹内没有待入库的文件', 'info'); return; }
      return batchOrganize(targets, { state: 'filed' }, `「${a.name}」内 ${targets.length} 项已入库`);
    }
    case 'restore': return batchOrganize(picked.filter(i => i.state === 'excluded'), { state: 'filed' }, '已重新纳入');
    case 'restore-one': return a && batchOrganize([a], { state: 'filed' }, '已重新纳入');
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
      if (id && await ask('撤销上一次可撤销的操作？', '并非所有磁盘操作都可撤销。Vaulta 会在安全的情况下恢复最近一次可撤销的变更。', { symbol: 'undo', submit: '撤销' })) {
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
  const flowItem = event.target.closest('.pdf-flow-item');
  if (flowItem) {
    const pageIdx = parseInt(flowItem.dataset.page, 10);
    const p = S.preview?.paged;
    if (Number.isInteger(pageIdx) && p && p.page !== pageIdx) {
      p.page = pageIdx;
      syncFlowActivePage(inspector, pageIdx, p.count);
    }
  }
  const tile = event.target.closest('[data-asset]');
  if (tile) { selectedKeys(tile.dataset.asset, event.ctrlKey || event.metaKey, event.shiftKey, true, true); tile.focus({ preventScroll: true }); }
});
document.addEventListener('dblclick', event => {
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.target.closest('input,button,a,[data-act]')) return;
  const node = event.target.closest('[data-asset]');
  if (node) perform('open-asset', node.dataset.asset, node);
});
// Drag a file or folder onto a folder row/card to move it there. Drops stay
// inside one vault; units are separate management spaces and reject drops.
let dragSession = null;
const movableItem = item => !!item && !item.synthetic && !['excluded', 'missing'].includes(item.state);
const dropTargetOf = node => node?.closest?.('[data-drop]') || null;
function dropPlan(zone, items) {
  if (!zone || !items?.length) return null;
  const target = { rel: norm(zone.dataset.drop), vaultId: zone.dataset.dropVault, name: zone.dataset.dropName || '' };
  const dir = pathKey(target.rel), plan = [];
  for (const item of items) {
    if (!movableItem(item) || item.vaultId !== target.vaultId) return null;
    if (isDir(item) && (pathKey(item.rel) === dir || dir.startsWith(`${pathKey(item.rel)}/`))) return null;
    if (pathKey(parentPath(item.rel)) === dir) continue;
    plan.push(item);
  }
  return plan.length ? { target, items: plan } : null;
}
function clearDrop() {
  if (!dragSession?.zone) return;
  dragSession.zone.classList.remove('drop-over');
  dragSession.zone = null;
}
function clearDrag() {
  clearDrop();
  dragSession = null;
  for (const node of workspace.querySelectorAll('.dragging')) node.classList.remove('dragging');
}
let dragScrollFrame = 0, dragScrollY = 0;
function dragScroll(event) {
  dragScrollY = event.clientY;
  if (dragScrollFrame) return;
  dragScrollFrame = requestAnimationFrame(() => {
    dragScrollFrame = 0;
    const stage = $('#stage');
    if (!stage || !dragSession) return;
    const box = stage.getBoundingClientRect(), edge = Math.min(64, box.height / 4);
    if (dragScrollY < box.top + edge) stage.scrollBy(0, -10);
    else if (dragScrollY > box.bottom - edge) stage.scrollBy(0, 10);
  });
}
async function dropMove(target, items) {
  const destination = absolute(getVault(target.vaultId)?.root, target.rel);
  const label = items.length > 1 ? `${items.length} 个项目` : `「${items[0].name}」`;
  if (prefs.confirmMove) {
    const ok = await ask(`移动${label}到「${target.name}」？`, '文件的真实磁盘路径会发生变化，不会复制内容。', {
      symbol: 'move', submit: '移动',
      body: `<label class="check-option"><input type="checkbox" name="dont-ask" value="1"><span>不再显示这个提醒，以后直接移动</span></label>`,
      onSubmit: values => { if (values?.get('dont-ask')) { prefs.confirmMove = false; persist('confirm-move', false); } },
    });
    if (!ok) return;
  }
  await commitMove(items, destination);
  revealDestination(destination);
}
document.addEventListener('dragstart', event => {
  if (event.target.closest('input,button,a')) return;
  const node = event.target.closest('[data-asset]'), item = node && resolveItem(node.dataset.asset);
  if (!movableItem(item)) return;
  // Dragging any row of a multi-selection carries the whole selection.
  const picked = S.selected.has(node.dataset.asset) && S.selected.size > 1 ? selection().filter(movableItem) : [item];
  if (!picked.length) { event.preventDefault(); return; }
  dragSession = { items: picked, zone: null };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', picked.map(assetKey).join('\n')); } catch {}
  }
  // Dim the source after the browser has taken its drag image, otherwise the
  // ghost itself turns translucent.
  const dim = picked.length === 1 ? [node] : [...workspace.querySelectorAll('[data-asset]')].filter(row => S.selected.has(row.dataset.asset));
  setTimeout(() => { if (dragSession) for (const row of dim) row.classList.add('dragging'); }, 0);
});
document.addEventListener('dragover', event => {
  if (!dragSession) return;
  const zone = dropTargetOf(event.target);
  const plan = zone === dragSession.lastZone ? dragSession.lastPlan : (dragSession.lastZone = zone, dragSession.lastPlan = dropPlan(zone, dragSession.items));
  if (!plan) { clearDrop(); return; }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  if (dragSession.zone !== zone) { clearDrop(); dragSession.zone = zone; zone.classList.add('drop-over'); }
  dragScroll(event);
});
document.addEventListener('drop', event => {
  if (!dragSession) return;
  event.preventDefault();
  const zone = dropTargetOf(event.target), plan = dropPlan(zone, dragSession.items);
  if (!plan) { clearDrag(); return; }
  const { target, items } = plan;
  clearDrag();
  void dropMove(target, items).catch(error => toast(msg(error), 'error', 6500));
});
document.addEventListener('dragend', clearDrag);
// ---- Context menus -------------------------------------------------------
// The browser's own menu is never shown; every right-click resolves to the most
// specific surface available and renders in the same liquid-glass panel.
const editableOf = node => node?.closest?.('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=""], [contenteditable="true"]') || null;
const pickedText = el => typeof el?.selectionStart === 'number' && typeof el.value === 'string'
  ? el.value.slice(el.selectionStart, el.selectionEnd) : String(window.getSelection?.() || '');
function editMenu(el, point) {
  const text = typeof el.value === 'string' ? el.value : String(window.getSelection?.() || '');
  const selected = text.length > 0 && pickedText(el).length > 0;
  showMenu(null, `${menuCaption('编辑')}${menuItem('撤销', 'edit-undo', { glyph: 'undo', shortcut: 'Ctrl+Z' })}${menuItem('重做', 'edit-redo', { glyph: 'redo', shortcut: 'Ctrl+Y' })}${menuLine}
    ${menuItem('剪切', 'edit-cut', { glyph: 'scissors', shortcut: 'Ctrl+X', disabled: !selected })}${menuItem('复制', 'edit-copy', { glyph: 'copy', shortcut: 'Ctrl+C', disabled: !selected })}${menuItem('粘贴', 'edit-paste', { glyph: 'clipboard', shortcut: 'Ctrl+V' })}${menuLine}
    ${menuItem('全选', 'edit-select-all', { shortcut: 'Ctrl+A' })}`, point);
  contextTarget = el;
}
function selectionMenu(text, point) {
  const short = text.replace(/\s+/g, ' ').trim();
  const query = short.length > 48 ? `${short.slice(0, 48)}…` : short;
  showMenu(null, `${menuItem('复制', 'copy-selection', { glyph: 'copy', shortcut: 'Ctrl+C' })}${menuLine}${menuItem(`在仓库中搜索「${query}」`, 'search-selection', { glyph: 'search' })}`, point);
}
function appMenu(point) {
  const views = prefs.layout === 'grid'
    ? menuItem('网格视图', 'layout', { glyph: 'layout-grid', value: 'grid', selected: true }) + menuItem('列表视图', 'layout', { glyph: 'list', value: 'list' })
    : menuItem('列表视图', 'layout', { glyph: 'list', value: 'list', selected: true }) + menuItem('网格视图', 'layout', { glyph: 'layout-grid', value: 'grid' });
  showMenu(null, `${S.id ? menuItem('刷新', 'rescan', { glyph: 'refresh-cw', shortcut: 'F5' }) + menuLine : ''}${views}${menuLine}
    ${menuItem(S.rail ? '隐藏导航' : '显示导航', 'toggle-rail', { glyph: 'panel-left' })}${configurationPage() ? '' : menuItem(S.pane && !S.deferFolderPane ? '隐藏详情栏' : '显示详情栏', 'toggle-pane', { glyph: 'panel-right' })}${menuLine}
    ${menuItem('新建仓库', 'new-vault', { glyph: 'plus' })}${menuItem('添加现有文件夹', 'add-vault', { glyph: 'folder-open' })}${menuLine}
    ${menuItem('设置…', 'nav', { glyph: 'settings', value: 'settings' })}`, point);
}
document.addEventListener('contextmenu', event => {
  if (event.target.closest?.('.c-menu')) { event.preventDefault(); return; }
  event.preventDefault();
  const point = { x: event.clientX, y: event.clientY };
  const node = event.target.closest('[data-asset]');
  if (node && !modal.open) {
    if (!S.selected.has(node.dataset.asset)) selectedKeys(node.dataset.asset, false, false, false);
    return assetMenu(node, resolveItem(node.dataset.asset), point);
  }
  const field = editableOf(event.target);
  if (field) return editMenu(field, point);
  const selected = String(window.getSelection?.() || '');
  if (selected.trim()) return selectionMenu(selected, point);
  const card = event.target.closest('.vault-card');
  const id = card?.querySelector('[data-act="switch"]')?.dataset.value;
  if (id && getVault(id)) return showMenu(null, menuItem('打开仓库', 'switch', { glyph: 'hard-drive', value: id }) + menuItem('重命名', 'rename-vault', { glyph: 'square-pen', value: id }) + (!getVault(id)?.parent_id ? relocateVaultItem(id) + menuItem('移除仓库', 'remove-vault', { glyph: 'ban', value: id, danger: true }) : ''), point);
  appMenu(point);
});
function editFocus() { const el = contextTarget; if (el?.isConnected) el.focus({ preventScroll: true }); return el?.isConnected ? el : null; }
function editSelectAll() {
  const el = editFocus();
  if (!el) return;
  if (typeof el.select === 'function') el.select();
  else { const range = document.createRange(); range.selectNodeContents(el); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); }
}
async function editClipboard(command) {
  const el = editFocus();
  if (!el) return;
  if (command === 'paste') {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch {}
    if (text) return void document.execCommand('insertText', false, text);
    if (!document.execCommand('paste')) throw new Error('无法读取剪贴板，请直接按 Ctrl+V。');
    return;
  }
  if (document.execCommand(command)) return;
  if (command === 'cut' || command === 'copy') {
    const text = pickedText(el);
    if (!text) return;
    await clipboard(text);
    if (command === 'cut') document.execCommand('insertText', false, '');
  }
}
document.addEventListener('change', event => {
  const node = event.target;
  if (node.hasAttribute('data-select-all')) selectAll(node.checked);
  else if (node.dataset.assetCheck) selectedKeys(node.dataset.assetCheck, true, false);
  else if (node.dataset.setting === 'theme') { prefs.theme = node.value; persist('theme', node.value); setTheme(); }
  else if (node.dataset.setting === 'titlebar') perform('titlebar-mode', node.value, node);
  else if (node.dataset.setting === 'layout') perform('layout', node.value, node);
  else if (node.dataset.setting === 'nav') perform('nav-mode', node.value, node);
  else if (node.dataset.setting === 'move-confirm') perform('move-confirm', node.value, node);
  else if (node.dataset.setting === 'doc-preview') perform('doc-preview', node.value, node);
  else if (node.dataset.setting === 'glass-effects') vaultaEffects.save(node.value);
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
  if (menuOpen()) {
    if (key === 'Escape') { e.preventDefault(); closeMenu(); return; }
    const items = menuItems();
    if (['ArrowDown','ArrowUp','Home','End'].includes(key) && items.length) {
      e.preventDefault(); const i = items.indexOf(document.activeElement), n = key === 'Home' ? 0 : key === 'End' ? items.length - 1 : (i + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; items[n].focus(); return;
    }
    if (key === 'Tab') closeMenu();
    else return;
  }
  if (ctrl && e.shiftKey && key.toLowerCase() === 'p') { e.preventDefault(); showCommands(); return; }
  if (ctrl && key.toLowerCase() === 'k') { e.preventDefault(); $('#query')?.focus(); $('#query')?.select(); return; }
  if (e.altKey && (key === 'ArrowLeft' || key === 'ArrowRight')) { e.preventDefault(); void goHistory(key === 'ArrowLeft' ? -1 : 1); return; }
  if (e.target.closest('input,textarea,select,[contenteditable],[role=separator]')) return;
  if (e.target.closest('.pdf-page, .pdf-toolbar') && ['ArrowLeft','ArrowRight','PageUp','PageDown'].includes(key)) {
    e.preventDefault();
    perform('pdf-view', ['ArrowLeft','PageUp'].includes(key) ? 'prev' : 'next');
    return;
  }
  if (configurationPage()) return;
  const tile = e.target.closest('[data-asset]'), a = tile ? resolveItem(tile.dataset.asset) : one();
  if (ctrl && key.toLowerCase() === 'a') { e.preventDefault(); selectAll(true); }
  else if (key === 'Escape') clearAndSync();
  else if (key === 'Enter' && a && !e.target.closest('button')) { e.preventDefault(); perform('open-asset', assetKey(a), tile); }
  else if (key === ' ' && a && !e.target.closest('button')) { e.preventDefault(); if (ctrl) selectedKeys(assetKey(a), true, false, false); else previewOne(a); }
  else if (key === 'F2' && a && !a.synthetic && !['excluded','missing'].includes(a.state)) { e.preventDefault(); renameFile(a); }
  else if (key === 'F5') { e.preventDefault(); perform('rescan'); }
  else if (key === 'Delete' && S.selected.size) { e.preventDefault(); recycle(selection()); }
  else if (tile && isDir(a) && (S.page === 'all' || S.page === 'inbox') && !filterCount() && prefs.layout === 'list' && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    const row = S.rows.find(entry => assetKey(entry.item) === tile.dataset.asset);
    if (row?.hasChildren && !(key === 'ArrowRight' ? row.open : !row.open)) { e.preventDefault(); perform('tree-toggle', pathKey(row.item.rel), tile); }
  }
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
  if (S.page === 'duplicates' && (received.includes(S.id) || received.includes(''))) void getDuplicates();
  const applies = id => received.includes(id) || received.includes('');
  if (S.page === 'settings' && S.id && applies(S.id)) void readAccess(S.id, true);
  const item = one();
  if (!S.edited && item && !inspector.hidden && S.tab === 'preview' && applies(item.vaultId) && needsPreview(item)) void loadPreview(item, { used: false });
}
function warning(payload) {
  const message = payload?.message; if (!message) return;
  if (!payload.vault_id || payload.vault_id === S.id) { S.notice = message; if (!isDirty()) render(); }
  toast(message, 'warn', 6500);
}
async function boot(prefetchedRegistry = null) {
  S.booting = connected(); S.error = ''; render();
  if (!connected()) { S.booting = false; renderStatus(); return; }
  let rendered = false;
  try {
    if (!listening) { listening = true; host.listen(changed, warning).catch(error => { listening = false; toast(msg(error), 'warn'); }); }
    if (prefetchedRegistry) {
      const err = await prefetchedRegistry;
      if (err) throw err;
    } else await loadRegistry();
    const last = stored('active', null), initial = getVault(last) || roots()[0];
    if (initial) {
      S.booting = false;
      await switchVault(initial.id, 'physical');
      rendered = true;
    }
  } catch (error) { S.error = msg(error); }
  finally { S.booting = false; if (!rendered) render(); }
}
void installGlassDefinitions();
const initialRegistry = connected() ? loadRegistry().then(() => null, error => error) : null;
await installGlass(perform);
await installWindowChrome();
void boot(initialRegistry);
if (connected()) updates.start();
