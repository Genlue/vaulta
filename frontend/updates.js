// Check on startup and on a long interval; downloads always require confirmation.
export function createUpdates(host, { changed, found }) {
  const state = { current: '', available: '', installable: null, error: '', checking: false, checked: false };
  let pending, timer, noticed;
  function check({ automatic = false } = {}) {
    if (pending) return pending;
    pending = Promise.resolve().then(async () => {
      state.checking = true;
      state.error = '';
      changed();
      try {
        const result = await host.checkUpdate();
        state.current = result.current ?? '';
        state.available = result.available ?? '';
        state.installable = result.installable === true;
        state.error = result.error ?? '';
        state.checked = !state.error;
        if (automatic && state.available && noticed !== state.available) found(state.available);
        if (state.available) noticed = state.available;
      } catch (error) {
        state.error = typeof error === 'string' ? error : (error?.message || '无法检查更新。');
        state.checked = false;
      } finally {
        state.checking = false;
        pending = undefined;
        changed();
      }
      return state;
    });
    return pending;
  }
  function start() {
    if (timer !== undefined) return;
    void check({ automatic: true });
    timer = setInterval(() => void check({ automatic: true }), 6 * 60 * 60 * 1000);
  }
  return { state, check, start };
}
