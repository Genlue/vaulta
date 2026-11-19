// All host calls go here. JS argument casing follows the Tauri command ABI;
// nested mutation payloads and responses use the core's snake_case schema.
function invoke(name, args = {}) {
  const core = globalThis.__TAURI__?.core;
  if (typeof core?.invoke !== 'function') return Promise.reject(new Error('请在 vaulta 桌面应用中使用此功能。'));
  return core.invoke(name, args);
}
export const connected = () => typeof globalThis.__TAURI__?.core?.invoke === 'function';
export const host = {
  list: () => invoke('list_vaults'),
  choose: title => invoke('choose_folder', { title }),
  add: (path, name, create) => invoke('add_vault', { path, name, create }),
  relocate: (vaultId, path) => invoke('relocate_vault', { vaultId, path }),
  rename: (vaultId, name) => invoke('rename_vault', { vaultId, name }),
  remove: vaultId => invoke('remove_vault', { vaultId }),
  unit: (vaultId, assetId) => invoke('open_unit', { vaultId, assetId }),
  snapshot: vaultId => invoke('snapshot', { vaultId }),
  rescan: vaultId => invoke('rescan', { vaultId }),
  mutate: (vaultId, action) => invoke('mutate', { vaultId, action }),
  preview: (vaultId, assetId) => invoke('preview', { vaultId, assetId }),
  pdfPage: (vaultId, assetId, page) => invoke('pdf_preview_page', { vaultId, assetId, page }),
  slidePage: (vaultId, assetId, request) => invoke('slides_preview_page', { vaultId, assetId, request }),
  officeOpen: (vaultId, assetId, session, confirmedSession) => invoke('office_preview_open', { vaultId, assetId, session, confirmedSession }),
  officeLayout: (seq, session, bounds) => invoke('office_preview_layout', { seq, session, bounds }),
  save: (vaultId, assetId, revision, text) => invoke('save_text', { vaultId, assetId, revision, text }),
  file: (vaultId, assetId, operation, options = {}) => invoke('file_operation', { vaultId, assetId, operation, ...options }),
  folder: (vaultId, parent, name) => invoke('create_folder', { vaultId, parent, name }),
  duplicates: vaultId => invoke('duplicates', { vaultId }),
  matches: (vaultIds, query) => invoke('content_matches', { vaultIds, query }),
  info: () => invoke('api_info'),
  checkUpdate: () => invoke('check_update'),
  installUpdate: version => invoke('install_update', { version }),
  updateReleases: () => invoke('open_update_releases'),
  agentAccess: vaultId => invoke('agent_access', { vaultId }),
  setAgentAccess: (vaultId, access) => invoke('set_agent_access', { vaultId, access }),
  async listen(changed, warning) {
    const events = globalThis.__TAURI__?.event;
    if (typeof events?.listen !== 'function') return [];
    return Promise.all([events.listen('vaulta-changed', event => changed(event.payload)),
      events.listen('vaulta-warning', event => warning(event.payload))]);
  },
};
