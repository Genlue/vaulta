import { glyphs } from './vendor/glassdesign/icons.js';
// Each mount owns a real GlassDesign/Leptos component. The host owns layout,
// actions and the native window; controlled updates do not recreate a widget.
const live = new WeakMap();
const definitions = new WeakMap();
const projected = new Set(['card', 'status-bar', 'toolbar', 'capsule', 'glass-panel']);
const resultControls = new Set(['search-field', 'segmented', 'select', 'menu', 'traffic-lights', 'split-grip']);
const controlled = {
  'segmented': { value: props => props.options?.[0]?.value ?? '' },
  'select': { value: '' },
  'search-field': { value: '', disabled: false },
  'traffic-lights': { focused: true, maximized: false, dirty: false },
  'split-grip': { value: 0, min: 0, max: 600 },
};
let mountWidget;
let handleAction;
let prefix = 0;
const aliases = { inbox: 'folder-open', tag: 'bookmark', flag: 'star', link: 'external-link', terminal: 'code', zap: 'search' };
const knownIcon = name => name == null ? undefined : Object.hasOwn(glyphs, name) ? name : (aliases[name] && Object.hasOwn(glyphs, aliases[name])) ? aliases[name] : 'info';
const escAttr = s => String(s).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]);
const slots = root => [...(root.matches?.('[data-gd-widget]') ? [root] : []), ...root.querySelectorAll('[data-gd-widget]')];
const targetAttrs = ['aria-haspopup', 'aria-expanded', 'aria-current', 'aria-controls', 'aria-keyshortcuts', 'aria-label', 'aria-pressed', 'title'];
const inheritedAttrs = node => targetAttrs.map(key => [key, node?.getAttribute(key)]).filter(([, value]) => value != null);
const spec = slot => JSON.parse(slot.dataset.gdProps);

export function widget(kind, props, { key, action, value, attrs = '', className = '', fallback = '', tag = 'span' } = {}) {
  const data = escAttr(JSON.stringify({ props, action, value }));
  const keyed = key != null ? ` data-gd-key="${escAttr(key)}"` : '';
  return `<${tag} class="gd-slot ${className}" data-gd-widget="${kind}" data-gd-props="${data}"${keyed} ${attrs}>${fallback}</${tag}>`;
}

function unmountSlot(node) {
  const record = live.get(node);
  if (record) {
    record.handle.dispose();
    record.handle.free?.();
    live.delete(node);
    delete node.dataset.gdMounted;
  }
}
export function unmount(root) {
  for (const node of slots(root).reverse()) unmountSlot(node);
}

function controlFor(slot, kind) {
  if (kind === 'search-field') return slot.querySelector('input');
  if (projected.has(kind)) return null;
  return slot.querySelector('button, [tabindex], [role=option]');
}

function decorate(slot, record, inherited) {
  const { kind, control, config, original } = record;
  const { props, action, value } = config;
  if (!control) return;
  if (kind === 'nav-item') {
    // These are independent page links, not options in a single listbox.
    control.setAttribute('role', 'button');
    control.removeAttribute('aria-selected');
    control.dataset.vaultaCurrent = String(!!props.selected);
  }
  for (const name of record.inherited) {
    const base = original.get(name);
    if (base == null) control.removeAttribute(name);
    else control.setAttribute(name, base);
  }
  for (const [name, val] of inherited) control.setAttribute(name, val);
  record.inherited = inherited.map(([name]) => name);
  if (action) control.dataset.gdControl = '';
  else delete control.dataset.gdControl;
  if (action && !resultControls.has(kind)) {
    control.dataset.act = action;
    if (value != null) control.dataset.value = value;
    else delete control.dataset.value;
  } else delete control.dataset.act;
  if (kind === 'search-field') {
    control.autocomplete = 'off';
    control.spellcheck = false;
  }
}

export function mount(root) {
  if (!mountWidget) return;
  for (const slot of slots(root)) {
    if (live.has(slot) || !root.contains(slot)) continue;
    const kind = slot.dataset.gdWidget;
    const nodes = [...slot.childNodes];
    let handle;
    try {
      const config = spec(slot);
      const props = structuredClone(config.props);
      const inherited = projected.has(kind) ? [] : inheritedAttrs(slot.firstElementChild);
      if (props.icon != null) props.icon = knownIcon(props.icon);
      for (const choice of props.options || props.items || []) if (choice.icon != null) choice.icon = knownIcon(choice.icon);
      if (kind === 'search-field' && !props.id) props.id = `gd-search-${++prefix}`;
      const contents = projected.has(kind) ? slot.innerHTML : null;
      if (!projected.has(kind)) slot.replaceChildren();
      const record = { kind, config, contents, inherited: [] };
      handle = mountWidget(slot, kind, props, result => {
        const { action, value } = record.config;
        if (action && slot.isConnected) handleAction(action, value ?? result, record.control ?? slot);
      });
      const control = controlFor(slot, kind);
      Object.assign(record, { handle, control, original: new Map(inheritedAttrs(control)) });
      decorate(slot, record, inherited);
      live.set(slot, record);
      slot.dataset.gdMounted = '';
    } catch (error) {
      handle?.dispose();
      handle?.free?.();
      slot.replaceChildren(...nodes);
      document.documentElement.dataset.gdError = kind;
      console.error('GlassDesign widget:', kind, error);
    }
  }
}

// Patch a live Leptos control without emitting the change back to the host.
// A missing runtime/mount deliberately returns false so native fallbacks can be updated.
export function updateWidget(slot, patch) {
  const record = live.get(slot);
  if (!record?.handle.update) return false;
  record.handle.update(patch);
  Object.assign(record.config.props, patch);
  slot.dataset.gdProps = JSON.stringify(record.config);
  return true;
}

function keysBySlot(root) {
  const keyed = new Map();
  for (const slot of root.querySelectorAll('[data-gd-widget][data-gd-key]')) {
    const key = slot.dataset.gdKey;
    keyed.set(key, keyed.has(key) ? null : slot); // an ambiguous duplicate never reconciles
  }
  return keyed;
}

function syncAttrs(old, next, mounted = false) {
  for (const { name } of old.attributes) {
    if ((!mounted || name !== 'data-gd-mounted') && !next.hasAttribute(name)) old.removeAttribute(name);
  }
  for (const { name, value } of next.attributes) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
}

function staticProps(kind, props) {
  const allowed = controlled[kind];
  return JSON.stringify(Object.keys(props).sort().filter(key => !allowed || !Object.hasOwn(allowed, key)).map(key => [key, props[key]]));
}

// Opt-in keyed islands preserve their ancestor chain in place, so focus, pointer
// capture and running CSS transitions survive; other markup is still replaced.
// A keyed projection is opaque here: redraw a child container to change its contents.
export function redraw(root, html) {
  if (!root.querySelector('[data-gd-widget][data-gd-key][data-gd-mounted]')) {
    unmount(root);
    root.innerHTML = html;
    mount(root);
    return;
  }
  const next = root.cloneNode(false);
  next.innerHTML = html;
  const existing = keysBySlot(root);
  const pairs = new Map([[next, root]]), used = new Map([[root, next]]);
  const keepWidgets = new Map();
  for (const [key, candidate] of keysBySlot(next)) {
    const old = existing.get(key), record = live.get(old);
    if (!candidate || !record || candidate.dataset.gdWidget !== record.kind) continue;
    const config = spec(candidate);
    const { kind } = record;
    if (staticProps(kind, config.props) !== staticProps(kind, record.config.props)
        || (projected.has(kind) && candidate.innerHTML !== record.contents)) continue;
    const changes = {};
    for (const [name, def] of Object.entries(controlled[kind] || {})) {
      // The control may have changed its signal before the host accepts or
      // rejects that action. Reassert the controlled value, not cached markup.
      if (record.handle.update) changes[name] = config.props[name] ?? (typeof def === 'function' ? def(config.props) : def);
      else if (config.props[name] !== record.config.props[name]) changes[name] = config.props[name];
    }
    if (Object.keys(changes).length && !record.handle.update) continue;
    const route = [];
    let a = old, b = candidate;
    while (a && b && !used.has(a) && !pairs.has(b)) {
      if (a.localName !== b.localName || a.namespaceURI !== b.namespaceURI || a.id !== b.id
          || (a !== old && (a.hasAttribute('data-gd-widget') || b.hasAttribute('data-gd-widget')))) break;
      route.push([b, a]);
      a = a.parentElement; b = b.parentElement;
    }
    if (!a || used.get(a) !== b || pairs.get(b) !== a) continue;
    for (const [to, from] of route) { pairs.set(to, from); used.set(from, to); }
    keepWidgets.set(old, { config, changes });
  }
  // Mounted descendants of an unchanged projection belong to that island, even
  // though the opaque projection does not expose its internal DOM to this pass.
  for (const slot of slots(root).reverse()) {
    let owner = slot;
    while (owner !== root && !keepWidgets.has(owner)) owner = owner.parentElement;
    if (!keepWidgets.has(owner)) unmountSlot(slot);
  }
  function patch(old, desired) {
    const kept = keepWidgets.get(old);
    if (old !== root) syncAttrs(old, desired, !!kept);
    if (kept) {
      const record = live.get(old);
      if (Object.keys(kept.changes).length) record.handle.update(kept.changes);
      record.config = kept.config;
      decorate(old, record, projected.has(record.kind) ? [] : inheritedAttrs(desired.firstElementChild));
      return;
    }
    for (const child of [...old.childNodes]) if (!used.has(child)) child.remove();
    let cursor = old.firstChild;
    for (const child of [...desired.childNodes]) {
      const preserved = pairs.get(child);
      if (!preserved) old.insertBefore(child, cursor);
      else {
        if (preserved !== cursor) {
          if (typeof old.moveBefore === 'function') old.moveBefore(preserved, cursor);
          else old.insertBefore(preserved, cursor);
        }
        patch(preserved, child);
        cursor = preserved.nextSibling;
      }
    }
  }
  patch(root, next);
  mount(root);
}

// Same-document IDs are required; a linked image cannot supply URL filter IDs.
export function installGlassDefinitions(target = document.getElementById('glass-defs')) {
  if (!target || !target.isConnected) return Promise.resolve(false);
  if (document.getElementById('gd-glass-capsule-34')) return Promise.resolve(true);
  if (definitions.has(target)) return definitions.get(target);
  const request = (async () => {
    try {
      const response = await fetch(new URL('./vendor/glassdesign/glass-defs.svg', import.meta.url));
      if (!response.ok) return false;
      const parsed = new DOMParser().parseFromString(await response.text(), 'image/svg+xml');
      const svg = parsed.documentElement;
      if (svg.localName !== 'svg' || !svg.querySelector('defs > filter[id="gd-glass-capsule-34"]') || !target.isConnected) return false;
      if (!document.getElementById('gd-glass-capsule-34')) target.append(document.importNode(svg, true));
      return true;
    } catch { return false; }
    finally { definitions.delete(target); }
  })();
  definitions.set(target, request);
  return request;
}

export async function installGlass(dispatch) {
  handleAction = dispatch;
  try {
    const lib = await import('./vendor/glassdesign/glass_web.js');
    await lib.default();
    mountWidget = lib.mount_widget;
    document.documentElement.dataset.gdRuntime = 'ready';
  } catch (error) {
    document.documentElement.dataset.gdRuntime = 'unavailable';
    console.error('GlassDesign runtime:', error);
  }
}
