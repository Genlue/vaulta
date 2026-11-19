export const splitPath = path => String(path ?? '').split(/[\\/]+/).filter(Boolean);
export const norm = path => splitPath(path).join('/');
export const parentPath = path => splitPath(path).slice(0, -1).join('/');
export const basename = path => splitPath(path).at(-1) || '';
export const pathKey = path => norm(path).toLowerCase();
export const absolute = (root, path) => /^(?:[a-z]:[\\/]|\\\\)/i.test(path ?? '') ? path : [String(root ?? '').replace(/[\\/]+$/, ''), ...splitPath(path)].join('\\');
export const relative = (root, path) => {
  const p = norm(path), r = norm(root);
  return p.toLowerCase().startsWith(`${r.toLowerCase()}/`) ? p.slice(r.length + 1) : p;
};
export const containsPath = (root, path) => pathKey(root) === pathKey(path) || pathKey(path).startsWith(`${pathKey(root)}/`);
export const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const arr = value => Array.isArray(value) ? value : [];
export const assetKey = item => JSON.stringify(item.synthetic ? [item.vaultId, null, pathKey(item.rel)] : [item.vaultId, item.id]);
export const isDir = item => item?.kind === 'unit' || item?.kind === 'directory';
export const systemState = { inbox: '待入库', filed: '已入库', excluded: '已排除', missing: '已缺失' };
export const states = Object.keys(systemState);
export const defaultFlags = ['重点关注', '待处理', '即将使用', '暂时搁置'];
export const unique = list => [...new Set(list.filter(Boolean))];
export const labels = list => unique(arr(list).map(value => typeof value === 'string' ? value : value?.name));
const regular = item => item.state !== 'excluded' && item.state !== 'missing';

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes)) || bytes < 0) return '—';
  bytes = Number(bytes);
  if (bytes < 1024) return `${bytes} B`;
  const i = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`;
}
const shortDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
export function formatDate(value, full = false) {
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return value && Number.isFinite(date.getTime()) ? (full ? fullDate : shortDate).format(date) : '—';
}
export function extension(item) {
  return item?.name?.match(/\.(\w{1,14})$/)?.[1]?.toLowerCase() ?? '';
}
const imageExt = /^(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg|heic|heif|psd|ai|sketch|fig|xd|indd)$/;
const videoExt = /^(mp4|mov|avi|mkv|webm|wmv|flv|m4v|mpg|mpeg)$/;
const audioExt = /^(mp3|flac|wav|aac|m4a|opus|oga|ogg|wma|aiff?)$/;
const sheetExt = /^(xlsx?|csv|tsv|ods|numbers)$/;
const slideExt = /^(pptx?|ppsx?|odp|key)$/;
const docExt = /^(docx?|rtf|odt|pages|wps)$/;
const textExt = /^(txt|text|md|markdown|mdown|rst|log)$/;
const codeExt = /^(js|mjs|cjs|jsx|ts|tsx|json|jsonc|html?|xhtml|css|scss|sass|less|py|rs|go|java|kt|kts|c|h|cc|cpp|hpp|cs|php|rb|swift|lua|sh|bash|zsh|fish|ps1|bat|cmd|sql|xml|ya?ml|toml|ini|cfg|conf|vue|svelte|astro)$/;
const archiveExt = /^(zip|rar|7z|gz|tgz|bz2|xz|zst|tar|jar)$/;
const fontExt = /^(ttf|otf|woff2?|eot)$/;
const execExt = /^(exe|msi|msix|appx|com|dll|sys)$/;
// One page-shaped family, distinct marks inside: the mark says what kind of
// document it is, the tone separates neighbouring kinds (doc/sheet/slide).
function fileKind(ext) {
  if (ext === 'pdf') return { icon: 'file-text', tone: 'rose', group: 'document' };
  if (imageExt.test(ext)) return { icon: 'image', tone: 'violet', group: 'image' };
  if (videoExt.test(ext)) return { icon: 'play', tone: 'violet', group: 'video' };
  if (audioExt.test(ext)) return { icon: 'volume-2', tone: 'violet', group: 'audio' };
  if (sheetExt.test(ext)) return { icon: 'file-spreadsheet', tone: 'green', group: 'document' };
  if (slideExt.test(ext)) return { icon: 'presentation', tone: 'amber', group: 'document' };
  if (docExt.test(ext)) return { icon: 'file-text', tone: 'blue', group: 'document' };
  if (textExt.test(ext)) return { icon: 'file-lines', tone: 'slate', group: 'document' };
  if (codeExt.test(ext)) return { icon: 'file-code', tone: 'blue', group: 'document' };
  if (archiveExt.test(ext)) return { icon: 'file-archive', tone: 'amber', group: 'document' };
  if (fontExt.test(ext)) return { icon: 'file-type', tone: 'slate', group: 'document' };
  if (execExt.test(ext)) return { icon: 'terminal', tone: 'slate', group: 'document' };
  return null;
}
export function assetType(item) {
  if (item.kind === 'unit') return { icon: 'layers', tone: 'violet', name: '整体单元', group: 'folder' };
  if (item.kind === 'directory') return { icon: 'folder', tone: 'amber', name: '文件夹', group: 'folder' };
  const ext = extension(item), kind = ext ? fileKind(ext) : null;
  return {
    icon: kind?.icon || 'file-text', tone: kind?.tone || 'blue', group: kind?.group || 'document',
    name: ext ? `${ext.toUpperCase()} 文件` : '文件',
  };
}
export function normalizeSnapshot(data, vault) {
  const v = { ...vault, ...data.vault };
  return { ...data, vault: v, categories: arr(data.categories), tags: labels(data.tags), history: arr(data.history),
    assets: arr(data.assets).map(item => ({ ...item, vaultId: v.id, rel: relative(v.root, item.path), tags: labels(item.tags), flags: labels(item.flags) })) };
}
export function makeCategoryIndex(categories) {
  const map = new Map(categories.map(cat => [cat.id, cat]));
  const children = new Map();
  for (const cat of categories) {
    const key = map.has(cat.parent_id) && cat.parent_id !== cat.id ? cat.parent_id : '';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(cat);
  }
  for (const group of children.values()) group.sort((a, b) => collator.compare(a.name, b.name));
  return { map, children };
}
export function ancestry(id, index) {
  const seen = new Set(), nodes = [];
  while (index.map.has(id) && !seen.has(id)) {
    const node = index.map.get(id);
    nodes.unshift(node); seen.add(id); id = node.parent_id;
  }
  return nodes;
}
export function categoryOptions(index) {
  return [...index.map.values()].map(cat => ({ ...cat, label: ancestry(cat.id, index).map(c => c.name).join(' / ') })).sort((a, b) => collator.compare(a.label, b.label));
}
export function folderIndex(assets) {
  const nodes = new Map(), children = new Map();
  for (const item of assets) if (isDir(item) && regular(item)) nodes.set(pathKey(item.rel), item);
  const units = new Set([...nodes].filter(([, item]) => item.kind === 'unit').map(([key]) => key));
  for (const item of assets) {
    if (!regular(item)) continue;
    const parts = splitPath(item.rel);
    for (let depth = 1; depth < parts.length; depth++) {
      const rel = parts.slice(0, depth).join('/'), key = pathKey(rel);
      if (units.has(key)) break;
      if (!nodes.has(key)) nodes.set(key, { rel, name: parts[depth - 1], kind: 'directory', vaultId: item.vaultId, synthetic: true });
    }
  }
  for (const item of nodes.values()) {
    const parts = splitPath(item.rel);
    if (parts.slice(0, -1).some((_, i) => units.has(pathKey(parts.slice(0, i + 1).join('/'))))) continue;
    const parent = pathKey(parentPath(item.rel));
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  for (const group of children.values()) group.sort((a, b) => collator.compare(a.name, b.name));
  const files = new Map();
  for (const item of assets) {
    if (!regular(item) || isDir(item) || !withinBoundary(item, units)) continue;
    const parent = pathKey(parentPath(item.rel));
    if (!files.has(parent)) files.set(parent, []);
    files.get(parent).push(item);
  }
  return { nodes, children, units, files };
}
export function withinBoundary(item, units) {
  if (!units.size) return true;
  const parts = splitPath(item.rel);
  return !parts.slice(0, -1).some((_, i) => units.has(pathKey(parts.slice(0, i + 1).join('/'))));
}
// Use the same management boundaries as ordinary browsing: the parent retains
// the unit itself, but the unit's contents are shown only in its own vault.
export function markable(item) { return item && !item.synthetic && ['filed', 'inbox'].includes(item.state); }
export function visibleAssets({ assets, folders, categories, page, folder, facet, filters, recent, duplicates, searchItems, sort, direction, foldersFirst }) {
  let items;
  if (page === 'search') items = searchItems;
  else if (page === 'excluded' || page === 'missing') items = assets.filter(a => a.state === page);
  else if (page === 'physical') {
    const key = pathKey(folder);
    items = (folders.files.get(key) || []).concat(folders.children.get(key) || []);
  } else {
    items = assets.filter(a => regular(a) && withinBoundary(a, folders.units));
    // The library is the adopted subset. Unadopted files stay visible in the
    // disk tree and in the inbox, but never silently pad this list.
    if (page === 'all') items = items.filter(a => a.state === 'filed');
    else if (page === 'inbox') items = items.filter(a => a.state === 'inbox');
    else if (page === 'category' && facet) items = items.filter(a => ancestry(a.category_id, categories).some(c => c.id === facet));
    else if (page === 'flags' || page === 'marking') items = items.filter(a => facet ? a.flags.includes(facet) : a.flags.length);
    else if (page === 'recent') items = items.filter(a => recent.has(assetKey(a)));
    else if (page === 'duplicates') items = items.filter(a => duplicates.has(a.id));
  }
  const { category, flags, type } = filters;
  items = items.filter(a => (!category || (category === '!none' ? !a.category_id : ancestry(a.category_id, categories).some(c => c.id === category)))
    && flags.every(flag => a.flags.includes(flag))
    && (!type || (type === 'file' ? !isDir(a) : type === 'folder' ? isDir(a) : assetType(a).group === type && !isDir(a))));
  const sign = direction === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    if (page === 'duplicates' && duplicates.get(a.id) !== duplicates.get(b.id)) return duplicates.get(a.id) - duplicates.get(b.id);
    // Folders read as containers, not values: they stay on top in both directions.
    if (foldersFirst && isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
    if (page === 'recent' && sort === 'recent') return recent.get(assetKey(b)) - recent.get(assetKey(a));
    return compareAssets(a, b, sort, sign);
  });
}
function compareAssets(a, b, sort, sign) {
  let comparison = sort === 'modified' || sort === 'size' || sort === 'created' ? (Number(a[sort]) || 0) - (Number(b[sort]) || 0)
    : sort === 'type' ? collator.compare(assetType(a).name, assetType(b).name)
    : sort === 'path' ? collator.compare(a.rel, b.rel) : collator.compare(a.name, b.name);
  return sign * (comparison || collator.compare(a.name, b.name));
}
// The library is a tree over the disk layout: only the folders that hold a
// visible asset (or are one) become branches, so a moved file never shows up
// both inside its folder and beside it at the root.
export function treeRows({ items, folders, expanded, sort, direction, foldersFirst }) {
  const sign = direction === 'desc' ? -1 : 1;
  const vaultId = items[0]?.vaultId || '';
  const root = { key: '', rel: '', name: '', folder: true, item: null, base: null, children: [], total: 0 };
  const nodes = new Map([['', root]]);
  const ensure = rel => {
    const clean = norm(rel), key = pathKey(clean);
    if (!key) return root;
    const found = nodes.get(key);
    if (found) return found;
    const parts = splitPath(clean);
    const parent = ensure(parts.slice(0, -1).join('/'));
    const base = folders.nodes.get(key) || null;
    const node = { key, rel: clean, name: base?.name || parts.at(-1) || '', folder: true, item: null, base, children: [], total: 0 };
    nodes.set(key, node);
    parent.children.push(node);
    return node;
  };
  for (const item of items) {
    if (isDir(item)) {
      const node = ensure(item.rel);
      node.item = item;
    } else {
      ensure(parentPath(item.rel)).children.push({ key: assetKey(item), item, folder: false });
    }
  }
  const data = node => node.item || node.base || { rel: node.rel, name: node.name, kind: 'directory', vaultId, synthetic: true };
  const count = node => {
    let total = 0;
    for (const child of node.children) total += child.folder ? count(child) + 1 : 1;
    node.total = total;
    return total;
  };
  const order = node => {
    node.children.sort((a, b) => {
      if (foldersFirst && a.folder !== b.folder) return a.folder ? -1 : 1;
      return compareAssets(a.folder ? data(a) : a.item, b.folder ? data(b) : b.item, sort, sign);
    });
    for (const child of node.children) if (child.folder) order(child);
  };
  count(root); order(root);
  const rows = [];
  const walk = (node, depth) => {
    for (const child of node.children) {
      if (!child.folder) { rows.push({ item: child.item, depth, folder: false, open: false, hasChildren: false, count: 0, tree: true }); continue; }
      const open = !!expanded?.has(child.key), children = child.children.length > 0;
      rows.push({ item: data(child), depth, folder: true, open, hasChildren: children, count: child.total, tree: true });
      if (open && children) walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}
export function searchAssets(snapshots, query, matches) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const contents = new Set(arr(matches).map(item => assetKey({ vaultId: item.vault_id, id: item.asset_id })));
  return snapshots.flatMap(snap => {
    const cats = makeCategoryIndex(snap.categories), folders = folderIndex(snap.assets);
    return snap.assets.filter(a => regular(a) && withinBoundary(a, folders.units) && (contents.has(assetKey(a)) || words.every(word =>
      [a.name, a.rel, assetType(a).name, ...a.flags, ...ancestry(a.category_id, cats).map(c => c.name)].some(value => String(value).toLocaleLowerCase().includes(word)))));
  });
}
