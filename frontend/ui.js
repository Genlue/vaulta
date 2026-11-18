import { widget } from './glass.js';
import { glyphs } from './vendor/glassdesign/icons.js';
import { arr, assetKey, assetType, formatBytes, formatDate, isDir, systemState, markable } from './model.js';

const extra = {
  inbox: '<path d="M4 4h16l2 10v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-5z"/><path d="M2 14h6l2 3h4l2-3h6"/>',
  tag: '<path d="M20.6 13.5 13.5 20.6a2 2 0 0 1-2.8 0L3 12.9V3h9.9l7.7 7.7a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r=".8"/>',
  flag: '<path d="M4 22V3m0 1c2.8-2 5.1-1.7 8.1 0s5.1 2 7.9 0v11c-2.8 2-4.9 1.8-7.9 0S6.8 13 4 15"/>',
  terminal: '<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m7 8 4 4-4 4m6 0h4"/>',
  link: '<path d="M10 13a4 4 0 0 0 5.7.2l4.1-4.1a4 4 0 0 0-5.7-5.7l-2.1 2.1m2 5.5a4 4 0 0 0-5.7-.2l-4.1 4.1a4 4 0 0 0 5.7 5.7l2.1-2.1"/>',
};
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const icon = (name, size = 18) => `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="var(--ic-stroke, 1.4)" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] || extra[name] || glyphs.info}</svg>`;
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
export function themeSelect(values, selected) {
  return widget('select', { label: '配色方案', width: 148, options: values.map(([value, label]) => ({ value, label })), value: selected },
    { action: 'set-theme', fallback: select('theme', values, selected, 'data-setting="theme"') });
}
export function inlineNotice(tone, message) {
  return widget('inline-message', { tone, message }, { className: 'notice-message', fallback: `<span>${esc(message)}</span>` });
}
export const pill = (label, tone = '') => `<span class="pill ${tone}">${esc(label)}</span>`;
export const visual = (item, style = '') => { const t = assetType(item); return `<span class="file-visual ${t.tone} ${style}">${icon(t.icon, 21)}</span>`; };
export const statePill = item => pill(systemState[item.state] || '—', item.state);
export const field = (value, name, { placeholder = '', required = false, readonly = false, max = 200, attrs = '' } = {}) => `<div class="c-field form-field"><input class="c-field__input" name="${esc(name)}" aria-label="${esc(placeholder || name)}" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="${max}" ${required ? 'required' : ''} ${readonly ? 'readonly' : ''} ${attrs}></div>`;
export const labeled = (label, markup, help = '') => `<label class="form-label"><span>${esc(label)}</span>${markup}${help ? `<small>${esc(help)}</small>` : ''}</label>`;
export const select = (name, values, selected = '', attrs = '') => `<select class="form-select" name="${esc(name)}" ${attrs}>${values.map(([id, label]) => `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
export const check = (name, value, label, checked = false, disabled = false) => `<label class="check-option"><input type="checkbox" name="${esc(name)}" value="${esc(value)}" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span>${esc(label)}</span></label>`;
export const menuItem = (label, action, { glyph, value, attrs = '', danger = false, selected = false, disabled = false } = {}) => `<button type="button" class="menu-item ${danger ? 'danger-text' : ''}" role="menuitem" ${act(action, value)} ${attrs} ${disabled ? 'disabled' : ''}>${glyph ? icon(glyph, 16) : '<span class="menu-indent"></span>'}<span>${esc(label)}</span>${selected ? icon('check', 15) : ''}</button>`;
export const menuLine = '<hr class="menu-line">';
export const blank = (symbol, title, desc, actions = '') => `<div class="blank"><span class="blank-icon">${icon(symbol, 28)}</span><h2>${esc(title)}</h2><p>${esc(desc)}</p>${actions ? `<div class="blank-actions">${actions}</div>` : ''}</div>`;
export const infoRow = (label, value) => `<div class="info-row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
export const trim = (string, n) => String(string || '').slice(0, n);
export const itemCheck = (item, selected) => `<input type="checkbox" class="item-check" aria-label="选择 ${esc(item.name)}" data-asset-check="${esc(assetKey(item))}" ${selected ? 'checked' : ''}>`;

const markControl = (item, showText) => {
  if (!markable(item)) return '';
  const marked = !!item.flags.length, label = marked ? `编辑标记：${item.flags.join('、')}` : '添加标记';
  return `<button type="button" class="asset-mark ${marked ? 'is-marked' : ''}" ${act('mark-one', assetKey(item))} aria-label="${esc(label)}" title="${esc(label)}">${icon(marked ? 'star' : 'flag', 14)}${showText ? `<span class="ellipsis">${esc(marked ? item.flags[0] : '标记')}${item.flags.length > 1 ? ` +${item.flags.length - 1}` : ''}</span>` : ''}</button>`;
};
export function assetCard(item, selected, cross, source, folder, marking = false) {
  const key = assetKey(item), mark = selected.has(key);
  return `<div class="tile ${mark ? 'selected' : ''}" data-asset="${esc(key)}" tabindex="0" role="group" aria-label="${esc(item.name)}">
    <div class="tile-art ${assetType(item).tone}">${visual(item, 'large')}${item.synthetic ? '' : itemCheck(item, mark)}${ib('资产操作', 'asset-menu', 'more', { value: key, style: 'tile-more' })}</div>
    <div class="tile-line"><div class="tile-title ellipsis" title="${esc(item.name)}">${esc(item.name)}</div>${markControl(item, marking)}</div>
    <div class="tile-meta ellipsis" title="${esc(item.rel)}">${cross ? esc(source) + ' · ' : ''}${folder ? esc(assetType(item).name) : esc(isDir(item) ? assetType(item).name : formatBytes(item.size))}</div>
  </div>`;
}
export function assetRow(item, selected, cross, source, marking = false) {
  const key = assetKey(item), mark = selected.has(key);
  return `<tr class="asset-row ${mark ? 'selected' : ''}" data-asset="${esc(key)}" tabindex="0" aria-selected="${mark}">
    <td class="col-check">${item.synthetic ? '' : itemCheck(item, mark)}</td>
    <td class="col-name"><div class="row-asset">${visual(item)}<div class="row-identity"><strong class="ellipsis" title="${esc(item.name)}">${esc(item.name)}</strong><small class="ellipsis" title="${esc(item.rel)}">${cross ? `${esc(source)} · ` : ''}${esc(item.rel === item.name ? assetType(item).name : item.rel)}</small></div></div></td>
    <td class="col-state">${marking ? markControl(item, true) : item.synthetic ? '—' : statePill(item)}</td>
    <td class="col-size">${esc(isDir(item) ? '—' : formatBytes(item.size))}</td>
    <td class="col-date">${esc(formatDate(item.modified))}</td>
    <td class="col-more"><div class="row-actions">${marking ? '' : markControl(item, false)}${ib('资产操作', 'asset-menu', 'more', { value: key })}</div></td>
  </tr>`;
}
export const lines = entries => arr(entries).map(entry => `<div class="event-row"><span class="event-icon">${icon('clock', 16)}</span><div><strong>${esc(entry.message)}</strong><small>${esc(entry.source || 'vaulta')}</small></div><time>${esc(formatDate(entry.time, true))}</time></div>`).join('');
