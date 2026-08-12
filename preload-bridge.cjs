const { contextBridge, ipcRenderer } = require('electron');

function installNotificationLayerMainWorldGuard() {
  if (typeof contextBridge.executeInMainWorld !== 'function') return;
  contextBridge.executeInMainWorld({
    func: () => {
      const ElementConstructor = globalThis.Element;
      const HTMLElementConstructor = globalThis.HTMLElement;
      if (!ElementConstructor || !HTMLElementConstructor) return;
      const nativeMatches = ElementConstructor.prototype.matches;
      const nativeShowPopover = HTMLElementConstructor.prototype.showPopover;
      const nativeHidePopover = HTMLElementConstructor.prototype.hidePopover;
      const isNotificationLayer = (element) => element?.id === 'notificationLayer';

      ElementConstructor.prototype.matches = function matches(selector) {
        if (isNotificationLayer(this) && selector === ':popover-open') return !this.hidden;
        return nativeMatches.call(this, selector);
      };

      if (typeof nativeShowPopover === 'function') {
        HTMLElementConstructor.prototype.showPopover = function showPopover(...args) {
          if (isNotificationLayer(this)) {
            this.hidden = false;
            return undefined;
          }
          return nativeShowPopover.apply(this, args);
        };
      }

      if (typeof nativeHidePopover === 'function') {
        HTMLElementConstructor.prototype.hidePopover = function hidePopover(...args) {
          if (isNotificationLayer(this)) {
            this.hidden = true;
            return undefined;
          }
          return nativeHidePopover.apply(this, args);
        };
      }
    },
    args: []
  });
}

installNotificationLayerMainWorldGuard();

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

function hardenInitialInteractionSurface() {
  const layer = document.getElementById('notificationLayer');
  if (layer) {
    if (typeof layer.matches === 'function' && layer.matches(':popover-open') && typeof layer.hidePopover === 'function') {
      layer.hidePopover();
    }
    layer.removeAttribute('popover');
    layer.style.inset = '';
    layer.style.width = '';
    layer.style.maxWidth = '';
    layer.style.height = '';
    layer.style.maxHeight = '';
    layer.style.margin = '';

    const toast = document.getElementById('toast');
    const updateRegion = document.getElementById('updateNotificationRegion');
    layer.hidden = Boolean(toast?.hidden && updateRegion?.hidden);
  }

  document.querySelectorAll('dialog[open]').forEach((dialog) => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
}

function loadCoreInteractionModule() {
  const source = 'core-interactions.js';
  if (document.querySelector(`script[data-core-interactions="${source}"]`)) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  script.dataset.coreInteractions = source;
  document.head.append(script);
}

function loadFinancialPresentationModules() {
  for (const source of ['financial-presentation-forecast.js', 'financial-presentation-debt.js', 'payday-allocation-ui.js']) {
    if (document.querySelector(`script[data-financial-presentation="${source}"]`)) continue;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = source;
    script.dataset.financialPresentation = source;
    document.head.append(script);
  }
}

function loadAutomationHistoryModule() {
  const source = 'automation-history-ui.js';
  if (document.querySelector(`script[data-automation-history="${source}"]`)) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  script.dataset.automationHistory = source;
  document.head.append(script);
}

function loadAutomationDashboardModule() {
  const stylesheet = 'automation-dashboard.css';
  if (!document.querySelector(`link[data-automation-dashboard-style="${stylesheet}"]`)) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = stylesheet;
    link.dataset.automationDashboardStyle = stylesheet;
    document.head.append(link);
  }

  const source = 'automation-dashboard-ui.js';
  if (document.querySelector(`script[data-automation-dashboard="${source}"]`)) return;
  const script = document.createElement('script');
  script.type = 'module';
  script.src = source;
  script.dataset.automationDashboard = source;
  document.head.append(script);
}

function loadLocalPresentationModules() {
  hardenInitialInteractionSurface();
  loadCoreInteractionModule();
  loadFinancialPresentationModules();
  loadAutomationHistoryModule();
  loadAutomationDashboardModule();
  window.requestAnimationFrame(() => hardenInitialInteractionSurface());
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', loadLocalPresentationModules, { once: true });
  } else {
    loadLocalPresentationModules();
  }
}
