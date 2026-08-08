const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('financeAPI', Object.freeze({
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  importFiles: (options) => ipcRenderer.invoke('import:choose', options),
  openDocument: (id) => ipcRenderer.invoke('document:open', id),
  deleteDocument: (id) => ipcRenderer.invoke('document:delete', id),
  createBackup: (passphrase) => ipcRenderer.invoke('backup:create', passphrase),
  restoreBackup: (passphrase) => ipcRenderer.invoke('backup:restore', passphrase),
  checkLocalModel: (model) => ipcRenderer.invoke('llm:status', model),
  askLocalModel: (question) => ipcRenderer.invoke('llm:ask', question),
  exportCsv: (csv) => ipcRenderer.invoke('export:csv', csv),
  previewDiagnostics: () => ipcRenderer.invoke('diagnostics:preview'),
  exportDiagnostics: (token) => ipcRenderer.invoke('diagnostics:export', token),
  deleteDiagnostics: () => ipcRenderer.invoke('diagnostics:delete'),
  recordRendererFault: (eventName) => ipcRenderer.invoke('diagnostics:renderer-fault', eventName),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  }
}));
