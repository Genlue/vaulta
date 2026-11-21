import { host } from './host.js';

// Native Win32 children paint above the WebView, so hide the provider while a
// dialog or menu is open, and send only the visible inspector placeholder rect.
export function officePreview(inspector, { blocked, failed }) {
  let target, session, frame = 0, last, running = false;
  let sequence = Date.now() * 1024;
  const overlays = 'dialog[open], #pop:not([hidden]), .c-menu[data-state=open], :popover-open';
  const observer = new ResizeObserver(schedule);
  const mutations = new MutationObserver(schedule);
  const physical = n => Math.round(n * window.devicePixelRatio);

  function bounds() {
    if (!target?.isConnected || document.hidden || document.querySelector(overlays)) return null;
    const r = target.getBoundingClientRect();
    const panel = target.closest('.inspect-scroll').getBoundingClientRect();
    const left = physical(Math.max(0, r.left, panel.left));
    const top = physical(Math.max(0, r.top, panel.top));
    const right = physical(Math.min(innerWidth, r.right, panel.right));
    const bottom = physical(Math.min(innerHeight, r.bottom, panel.bottom));
    return right - left >= 16 && bottom - top >= 16 ? { left, top, right, bottom } : null;
  }
  function send() {
    const area = bounds();
    const key = JSON.stringify([session ?? null, area]);
    if (key === last) return Promise.resolve();
    last = key;
    return host.officeLayout(++sequence, session ?? null, area);
  }
  function schedule() {
    if (!running || frame) return;
    frame = requestAnimationFrame(() => { frame = 0; void send().catch(() => {}); });
  }
  function attachListeners() {
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, { capture: true, passive: true });
    document.addEventListener('visibilitychange', schedule);
  }
  function detachListeners() {
    window.removeEventListener('resize', schedule);
    window.removeEventListener('scroll', schedule, { capture: true, passive: true });
    document.removeEventListener('visibilitychange', schedule);
  }
  function update(asset, confirmedSession = null) {
    const next = asset && inspector.querySelector('.office-preview-surface');
    if (target === next) { schedule(); return; }
    if (target) observer.unobserve(target);
    target = next || null;
    if (!target) {
      session = null;
      if (running) {
        running = false;
        detachListeners();
        observer.disconnect(); mutations.disconnect();
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        void send().catch(() => {});
      }
      return;
    }
    if (!running) {
      running = true;
      attachListeners();
    }
    session = ++sequence;
    const request = session;
    const node = target;
    observer.observe(node); observer.observe(inspector);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden', 'data-state'] });
    void send().then(() => {
      if (request === session) return host.officeOpen(asset.vaultId, asset.id, request, confirmedSession);
    }).then(result => {
      if (request !== session) return;
      if (result === 'download_marked') blocked(request);
      else if (result === 'shown') node.removeAttribute('aria-busy');
      else throw new Error('未收到有效的 Windows 预览结果。');
    }).catch(error => {
      if (request === session) failed(error);
    });
  }
  window.addEventListener('pagehide', () => update(null));
  return { update };
}
