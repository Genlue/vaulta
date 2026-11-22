// GlassDesign's three performance tiers, applied before the first paint.
// The attribute and the storage key are the library contract (GlassEffects in
// glass-design); writing them here keeps a JS host on the same preference that
// a native GlassDesign bootstrap would restore.
(() => {
  const KEY = 'glass-design:effects';
  const VALUES = ['auto', 'blur', 'solid'];
  const normalize = value => VALUES.includes(value) ? value : 'auto';
  const read = () => { try { return normalize(localStorage.getItem(KEY)); } catch { return 'auto'; } };
  // `auto` is the absence of the attribute, not a third value on it.
  const apply = value => {
    const mode = normalize(value);
    if (mode === 'auto') document.documentElement.removeAttribute('data-gd-effects');
    else document.documentElement.setAttribute('data-gd-effects', mode);
    return mode;
  };
  const save = value => {
    const mode = apply(value);
    try { localStorage.setItem(KEY, mode); } catch {}
    return mode;
  };
  globalThis.vaultaEffects = { values: VALUES, normalize, read, apply, save };
  apply(read());
})();
