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
export function assetType(item) {
  if (item.kind === 'unit') return { icon: 'layers', tone: 'violet', name: '整体单元' };
  if (item.kind === 'directory') return { icon: 'folder', tone: 'amber', name: '文件夹' };
  const ext = extension(item);
  const icon = /^(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|svg|heic|psd)$/.test(ext) ? ['image', 'violet']
    : /^(mp3|flac|wav|aac|m4a|opus|ogg)$/.test(ext) ? ['volume-2', 'violet']
    : /^(mp4|mov|avi|mkv|webm|wmv)$/.test(ext) ? ['play', 'violet']
    : /^(zip|rar|7z|gz|tar)$/.test(ext) ? ['album', 'amber']
    : ['file-text', ext === 'pdf' ? 'rose' : 'blue'];
  return { icon: icon[0], tone: icon[1], name: ext ? `${ext.toUpperCase()} 文件` : '文件' };
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
  return { nodes, children, units };
}
export function withinBoundary(item, units) {
  const parts = splitPath(item.rel);
  return !parts.slice(0, -1).some((_, i) => units.has(pathKey(parts.slice(0, i + 1).join('/'))));
}
// Use the same management boundaries as ordinary browsing: the parent retains
// the unit itself, but the unit's contents are shown only in its own vault.
export function markable(item) { return item && !item.synthetic && ['filed', 'inbox'].includes(item.state); }
const markingCache = new WeakMap();
export function markingAssets(snapshot) {
  if (!markingCache.has(snapshot)) {
    const { units } = folderIndex(snapshot.assets);
    markingCache.set(snapshot, snapshot.assets.filter(item => markable(item) && withinBoundary(item, units)));
  }
  return markingCache.get(snapshot);
}
export function visibleAssets({ assets, folders, categories, page, folder, facet, filters, recent, duplicates, searchItems, markingItems, sort, direction }) {
  let items;
  if (page === 'search') items = searchItems;
  else if (page === 'marking') items = markingItems.filter(item => !!item.flags.length === (facet === 'marked'));
  else if (page === 'excluded' || page === 'missing') items = assets.filter(a => a.state === page);
  else {
    items = assets.filter(a => regular(a) && withinBoundary(a, folders.units));
    if (page === 'physical') {
      const key = pathKey(folder);
      items = items.filter(a => !isDir(a) && pathKey(parentPath(a.rel)) === key).concat(folders.children.get(key) || []);
    } else if (page === 'inbox') items = items.filter(a => a.state === 'inbox');
    else if (page === 'category' && facet) items = items.filter(a => ancestry(a.category_id, categories).some(c => c.id === facet));
    else if (page === 'tags') items = items.filter(a => facet ? a.tags.includes(facet) : a.tags.length);
    else if (page === 'flags') items = items.filter(a => facet ? a.flags.includes(facet) : a.flags.length);
    else if (page === 'recent') items = items.filter(a => recent.has(assetKey(a)));
    else if (page === 'duplicates') items = items.filter(a => duplicates.has(a.id));
  }
  const { category, tags, flags, type } = filters;
  items = items.filter(a => (!category || (category === '!none' ? !a.category_id : ancestry(a.category_id, categories).some(c => c.id === category)))
    && tags.every(tag => a.tags.includes(tag)) && flags.every(flag => a.flags.includes(flag))
    && (!type || (type === 'file' ? !isDir(a) : type === 'folder' ? isDir(a) : assetType(a).icon === type && !isDir(a))));
  const sign = direction === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    if (page === 'duplicates' && duplicates.get(a.id) !== duplicates.get(b.id)) return duplicates.get(a.id) - duplicates.get(b.id);
    if (page === 'physical' && isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
    if (page === 'recent' && sort === 'recent') return recent.get(assetKey(b)) - recent.get(assetKey(a));
    let comparison = sort === 'modified' || sort === 'size' || sort === 'created' ? (Number(a[sort]) || 0) - (Number(b[sort]) || 0)
      : sort === 'type' ? collator.compare(assetType(a).name, assetType(b).name)
      : sort === 'path' ? collator.compare(a.rel, b.rel) : collator.compare(a.name, b.name);
    return sign * (comparison || collator.compare(a.name, b.name));
  });
}
export function searchAssets(snapshots, query, matches) {
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const contents = new Set(arr(matches).map(item => assetKey({ vaultId: item.vault_id, id: item.asset_id })));
  return snapshots.flatMap(snap => {
    const cats = makeCategoryIndex(snap.categories), folders = folderIndex(snap.assets);
    return snap.assets.filter(a => regular(a) && withinBoundary(a, folders.units) && (contents.has(assetKey(a)) || words.every(word =>
      [a.name, a.rel, assetType(a).name, ...a.tags, ...a.flags, ...ancestry(a.category_id, cats).map(c => c.name)].some(value => String(value).toLocaleLowerCase().includes(word)))));
  });
}
