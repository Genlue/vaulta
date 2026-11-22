import { widget } from './glass.js';
import { glyphs } from './vendor/glassdesign/icons.js';
import { arr, assetKey, assetType, extension, formatBytes, formatDate, isDir, pathKey, systemState, markable, thumbKey, thumbnailable } from './model.js';

const extra = {
  inbox: '<path d="M4 4h16l2 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  tag: '<path d="M20.6 13.5 13.5 20.6a2 2 0 0 1-2.8 0L3 12.9V3h9.9l7.7 7.7a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r=".8"/>',
  flag: '<path d="M4 22V3m0 1c2.8-2 5.1-1.7 8.1 0s5.1 2 7.9 0v11c-2.8 2-4.9 1.8-7.9 0S6.8 13 4 15"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m7 8 4 4-4 4m6 0h4"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7.2l4.1-4.1a4 4 0 0 0-5.7-5.7l-2.1 2.1m2 5.5a4 4 0 0 0-5.7-.2l-4.1 4.1a4 4 0 0 0 5.7 5.7l2.1-2.1"/>',
  // Document family: one page silhouette, a different mark inside per kind.
  'file-spreadsheet': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 12h8"/><path d="M8 17h8"/><path d="M12 12v5"/>',
  'presentation': '<path d="M2 3h20"/><path d="M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3"/><path d="m7 21 5-5 5 5"/>',
  'file-lines': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M8 11h8"/><path d="M8 15h8"/><path d="M8 19h5"/>',
  'file-code': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 12.5-2.5 2.5 2.5 2.5"/><path d="m14 12.5 2.5 2.5-2.5 2.5"/>',
  'file-archive': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M11 8v2"/><path d="M11 12v2"/><path d="M11 16v2"/>',
  'file-type': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 13v-1h6v1"/><path d="M12 12v6"/>',
  // Text-editing commands used by the context menu.
  redo: '<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  clipboard: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  'rows-3': '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  'book-open': '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
};
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, size = 18) => `<svg class="ic${name === 'loader' ? ' va-spinner' : ''}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="var(--ic-stroke, 1.4)" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || extra[name] || glyphs.info}</svg>`;
export const act = (action, value) => `data-act="${esc(action)}"${value == null ? '' : ` data-value="${esc(value)}"`}`;
const buttonVariant = style => style.includes('primary') ? 'primary' : style.includes('destructive') ? 'danger' : style.includes('tinted') ? 'tonal' : style.includes('secondary') ? 'secondary' : 'plain';
export function button(label, action, { value, glyph, style = '', disabled = false, attrs = '', size = 'md' } = {}) {
  const sizeClass = size === 'lg' ? ' c-btn--lg' : size === 'sm' ? ' c-btn--sm' : '';
  const fallback = `<button type="button" class="c-btn va-btn${sizeClass} ${style}" ${act(action, value)} ${disabled ? 'disabled' : ''} ${attrs}>${glyph ? icon(glyph) : ''}<span class="c-btn__label">${esc(label)}</span></button>`;
  return widget('button', { label, icon: glyph, variant: buttonVariant(style), size, disabled }, { action, value, fallback });
}
export function ib(label, action, glyph, options = {}) {
  const style = options.style || '', { value, disabled = false, attrs = '' } = options;
  const className = style.split(' ').filter(c => c !== 'soft' && c !== 'on').join(' ');
  const fallback = `<button type="button" class="ic-btn ${style}" ${act(action, value)} aria-label="${esc(label)}" title="${esc(label)}" ${disabled ? 'disabled' : ''} ${attrs}>${icon(glyph)}</button>`;
  // The repeated per-row options are native buttons in the domain-specific asset list.
  if (action === 'asset-menu' || action === 'mark-one') return fallback;
  return widget('icon-button', { label, icon: glyph, variant: style.includes('on') ? 'on' : style.includes('soft') ? 'tonal' : 'plain',
    active: attrs.includes('aria-pressed="true"'), toggle: attrs.includes('aria-pressed'), size: 'md', className, disabled }, { action, value, fallback });
}
export function segmented(label, options, selected, action, className = '') {
  const fallback = `<div class="segment-fallback" role="group" aria-label="${esc(label)}">${options.map(([value, text, glyph]) =>
    `<button type="button" ${act(action, value)} aria-pressed="${value === selected}">${glyph ? icon(glyph, 15) : ''}${esc(text)}</button>`).join('')}</div>`;
  return widget('segmented', { label, options: options.map(([value, label, icon]) => ({ value, label, icon })), value: selected }, { key: action, action, className, fallback });
}
// A settings dropdown is the library's Select: the same `.c-btn` trigger shell
// as every other control, and a `.c-menu` panel instead of the OS picker. The
// native <select> stays as the fallback when the wasm runtime is unavailable,
// which is why it keeps the `data-setting` hand-off.
export function settingSelect({ label, options, value, action, setting, width = 180 }) {
  return widget('select', { label, width, options: options.map(([id, text]) => ({ value: id, label: text })), value },
    { key: action, action, fallback: select(setting, options, value, `aria-label="${esc(label)}" data-setting="${esc(setting)}"`) });
}
export function inlineNotice(tone, message, title = '') {
  return widget('inline-message', { tone, message, ...(title ? { title } : {}) }, { className: 'notice-message', fallback: `<span>${esc(message)}</span>` });
}
export const pill = (label, tone = '') => `<span class="pill ${tone}">${esc(label)}</span>`;
export const visual = (item, style = '') => { const t = assetType(item); return `<span class="file-visual ${t.tone} ${style}">${icon(t.icon, 21)}</span>`; };
export const statePill = item => pill(systemState[item.state] || '—', item.state);
export const field = (value, name, { placeholder = '', required = false, readonly = false, max = 200, attrs = '' } = {}) => `<div class="c-field form-field"><input class="c-field__input" name="${esc(name)}" aria-label="${esc(placeholder || name)}" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${max}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${attrs}></div>`;
export const labeled = (label, markup, help = '') => `<label class="form-label"><span>${esc(label)}</span>${markup}${help ? `<small>${esc(help)}</small>` : ''}</label>`;
export const select = (name, values, selected = '', attrs = '') => `<select class="form-select" name="${esc(name)}" ${attrs}>${values.map(([id, label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
export const check = (name, value, label, checked = false, disabled = false) => `<label class="check-option"><input type="checkbox" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
// Menu rows follow GlassDesign's `.c-menu__item` contract: an optional leading
// check gutter, an icon or an equal spacer, the label, then the key hint.
// `aria-checked` marks the current option and turns on the check column for the
// whole panel (see `.c-menu.has-checks` in app.css).
export const menuItem = (label, action, { glyph, value, shortcut, attrs = '', danger = false, selected = false, disabled = false } = {}) => `<button type="button" class="c-menu__item${danger ? ' c-menu__item--danger' : ''}" role="menuitem" tabindex="-1" ${act(action, value)} ${selected ? 'aria-checked="true"' : ''} ${disabled ? 'aria-disabled="true" disabled' : ''} ${attrs}><span class="c-menu__check">${selected ? icon('check', 12) : ''}</span>${glyph ? icon(glyph, 14) : '<span class="c-menu__icon-gap"></span>'}<span class="c-menu__label">${esc(label)}</span>${shortcut ? `<span class="c-menu__key">${esc(shortcut)}</span>` : ''}</button>`;
export const menuLine = '<div class="c-menu__sep" role="separator"></div>';
export const menuCaption = label => `<div class="c-menu__caption">${esc(label)}</div>`;
export const blank = (symbol, title, desc, actions = '') => `<div class="blank"><span class="blank-icon">${icon(symbol, 28)}</span><h2>${esc(title)}</h2><p>${esc(desc)}</p>${actions ? `<div class="blank-actions">${actions}</div>` : ''}</div>`;
export const infoRow = (label, value) => `<div class="info-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
export const trim = (string, n) => String(string || '').slice(0, n);
export const itemCheck = (item, selected) => `<input type="checkbox" class="item-check" aria-label="选择 ${esc(item.name)}" data-asset-check="${esc(assetKey(item))}" ${selected ? 'checked' : ''}>`;

const markControl = (item, showText) => {
  if (!markable(item)) return '';
  const marked = !!item.flags.length, label = marked ? `编辑标记：${item.flags.join('、')}` : '添加标记';
  return `<button type="button" class="asset-mark ${marked ? 'is-marked' : ''}" ${act('mark-one', assetKey(item))} aria-label="${esc(label)}" title="${esc(label)}">${icon(marked ? 'star' : 'flag', 14)}${showText ? `<span class="ellipsis">${esc(marked ? item.flags[0] : '标记')}${item.flags.length > 1 ? ` +${item.flags.length - 1}` : ''}</span>` : ''}</button>`;
};
// Real, live assets can be dragged; ordinary folders (not units) accept drops.
// Synthetic folders are valid disk destinations even when they were not scanned
// as assets, so they only need the path, not an asset id.
const dragAttrs = item => !item.synthetic && !['excluded', 'missing'].includes(item.state) ? ' draggable="true"' : '';
const dropAttrs = item => isDir(item) && item.kind !== 'unit' && !['excluded', 'missing'].includes(item.state)
  ? ` data-drop="${esc(item.rel)}" data-drop-vault="${esc(item.vaultId)}" data-drop-name="${esc(item.name)}"` : '';
export function assetCard(row, selected, cross, source) {
  const item = row.item, folder = row.folder ?? isDir(item), key = assetKey(item), mark = selected.has(key), type = assetType(item);
  // Grid cards carry the two facts a list row shows on one line: what it is and
  // how big it is, then where it lives and when it changed.
  const facts = [type.name, folder ? (row.count ? `${row.count} 项` : '') : formatBytes(item.size)].filter(Boolean).join(' · ');
  const foot = [cross ? source : '', row.trail || '', item.modified ? formatDate(item.modified) : ''].filter(Boolean).join(' · ');
  // A real thumbnail is the point of the grid; the type glyph stays underneath
  // as the loading and no-preview state.
  const thumb = thumbnailable(item)
    ? `<img class="tile-thumb" alt="" draggable="false" decoding="async" data-thumb-fit="${extension(item) === 'svg' ? 'contain' : 'cover'}" data-thumb="${esc(thumbKey(item))}" data-thumb-vault="${esc(item.vaultId)}" data-thumb-asset="${esc(item.id)}">`
    : '';
  return `<div class="tile ${mark ? 'selected' : ''} ${folder ? 'is-folder' : ''}" data-asset="${esc(key)}" tabindex="0" role="group" aria-label="${esc(item.name)}"${dragAttrs(item)}${dropAttrs(item)}>
    <div class="tile-art ${type.tone}${thumb ? ' has-thumb' : ''}">${visual(item, 'large')}${thumb}${item.synthetic ? '' : itemCheck(item, mark)}${ib('资产操作', 'asset-menu', 'more', { value: key, style: 'tile-more' })}${row.tree && folder && row.hasChildren ? `<button type="button" class="tile-tree ${row.open ? 'open' : ''}" ${act('tree-toggle', pathKey(item.rel))} aria-expanded="${row.open}" aria-label="${row.open ? '收起文件夹' : '展开文件夹'}">${icon('chevron-right', 15)}</button>` : ''}</div>
    <div class="tile-title" title="${esc(item.name)}">${esc(item.name)}</div>
    <div class="tile-meta" title="${esc(item.rel)}"><span class="ellipsis">${esc(facts)}</span></div>
    <div class="tile-meta tile-foot"><span class="ellipsis">${esc(foot)}</span>${markControl(item, false)}</div>
  </div>`;
}
export function assetRow(row, selected, cross, source, marking = false) {
  const item = row.item, folder = row.folder ?? isDir(item), key = assetKey(item), mark = selected.has(key), type = assetType(item);
  const subtitle = cross ? `${esc(source)} · ${esc(item.rel === item.name ? type.name : item.rel)}`
    : row.tree ? esc(type.name) : esc(item.rel === item.name ? type.name : item.rel);
  const toggle = row.tree
    ? folder
      ? row.hasChildren
        ? `<button type="button" class="tree-toggle ${row.open ? 'open' : ''}" ${act('tree-toggle', pathKey(item.rel))} aria-expanded="${row.open}" aria-label="${row.open ? '收起文件夹' : '展开文件夹'}">${icon('chevron-right', 14)}</button>`
        : '<span class="tree-toggle-spacer"></span>'
      : '<span class="tree-toggle-spacer"></span>'
    : '';
  return `<tr class="asset-row ${mark ? 'selected' : ''} ${folder ? 'is-folder' : ''}" data-asset="${esc(key)}" tabindex="0" aria-selected="${mark}"${dragAttrs(item)}${dropAttrs(item)}>
    <td class="col-check">${item.synthetic ? '' : itemCheck(item, mark)}</td>
    <td class="col-name"><div class="row-asset"${row.tree ? ` style="--tree-depth:${row.depth || 0}"` : ''}>${toggle}${visual(item)}<div class="row-identity"><div class="row-title"><strong class="ellipsis" title="${esc(item.name)}">${esc(item.name)}</strong>${row.tree && folder && row.count ? `<span class="tree-count">${row.count} 项</span>` : ''}${row.context && !item.synthetic ? `<button type="button" class="tree-file-in" ${act('file-in-folder', key)} title="将该文件夹内所有待入库文件全部入库">${icon('check', 12)}全部入库</button><button type="button" class="tree-unitize" ${act('unitize', key)} title="作为整体单元入库">${icon('layers', 12)}整体单元</button>` : ''}</div><small class="ellipsis" title="${esc(item.rel)}">${subtitle}</small></div></div></td>
    <td class="col-state">${marking ? markControl(item, true) : item.synthetic || (folder && item.state === 'filed') ? '—' : statePill(item)}</td>
    <td class="col-size">${esc(isDir(item) ? '—' : formatBytes(item.size))}</td>
    <td class="col-date">${esc(formatDate(item.modified))}</td>
    <td class="col-more"><div class="row-actions">${marking ? '' : markControl(item, false)}${ib('资产操作', 'asset-menu', 'more', { value: key })}</div></td>
  </tr>`;
}
export const lines = entries => arr(entries).map(entry => `<div class="event-row"><span class="event-icon">${icon('clock', 16)}</span><div><strong>${esc(entry.message)}</strong><small>${esc(entry.source || 'Vaulta')}</small></div><time>${esc(formatDate(entry.time, true))}</time></div>`).join('');
