const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('financeAPI', Object.freeze({
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  previewAutomationRules: (state, options) => ipcRenderer.invoke('automation:preview', state, options),
  runAutomationRules: (state, options) => ipcRenderer.invoke('automation:run', state, options),
  retryRecovery: () => ipcRenderer.invoke('recovery:retry'),
  restoreRecoveryBackup: (backupId) => ipcRenderer.invoke('recovery:restore-backup', backupId),
  selectRecoveryPortableBackup: (passphrase) => ipcRenderer.invoke('recovery:select-portable-backup', passphrase),
  requestFreshStart: () => ipcRenderer.invoke('recovery:fresh-start:request'),
  cancelFreshStart: (token) => ipcRenderer.invoke('recovery:fresh-start:cancel', token),
  confirmFreshStart: (token) => ipcRenderer.invoke('recovery:fresh-start:confirm', token),
  importFiles: (options) => ipcRenderer.invoke('import:choose', options),
  openDocument: (id) => ipcRenderer.invoke('document:open', id),
  deleteDocument: (id) => ipcRenderer.invoke('document:delete', id),
  createBackup: (passphrase) => ipcRenderer.invoke('backup:create', passphrase),
  selectRestoreBackup: (passphrase) => ipcRenderer.invoke('backup:select-restore', passphrase),
  restoreBackup: (token) => ipcRenderer.invoke('backup:restore', token),
  cancelRestoreBackup: (token) => ipcRenderer.invoke('backup:restore-cancel', token),
  checkLocalModel: (model) => ipcRenderer.invoke('llm:status', model),
  askLocalModel: (question) => ipcRenderer.invoke('llm:ask', question),
  exportCsv: (csv) => ipcRenderer.invoke('export:csv', csv),
  previewDiagnostics: () => ipcRenderer.invoke('diagnostics:preview'),
  exportDiagnostics: (token) => ipcRenderer.invoke('diagnostics:export', token),
  deleteDiagnostics: () => ipcRenderer.invoke('diagnostics:delete'),
  recordRendererFault: (eventName) => ipcRenderer.invoke('diagnostics:renderer-fault', eventName),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadAvailableUpdate: () => ipcRenderer.invoke('update:download'),
  restartAndInstallUpdate: () => ipcRenderer.invoke('update:restart-and-install'),
  openAvailableUpdate: () => ipcRenderer.invoke('update:open-release'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('update:status', listener);
    return () => ipcRenderer.removeListener('update:status', listener);
  },
  onRestoreProgress: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('backup:restore-progress', listener);
    return () => ipcRenderer.removeListener('backup:restore-progress', listener);
  }
}));

function loadFinancialPresentationModules() {
  for (const source of ['financial-presentation-forecast.js', 'financial-presentation-debt.js']) {
    if (document.querySelector(`script[data-financial-presentation="${source}"]`)) continue;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = source;
    script.dataset.financialPresentation = source;
    document.head.append(script);
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', loadFinancialPresentationModules, { once: true });
} else {
  loadFinancialPresentationModules();
}
