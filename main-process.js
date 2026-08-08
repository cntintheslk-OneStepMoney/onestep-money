import { app, BrowserWindow, dialog, ipcMain, protocol, safeStorage } from 'electron';
import updater from 'electron-updater';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinanceDataStore } from './data-store.js';
import { DiagnosticLogger, RENDERER_FAULT_EVENTS } from './diagnostic-logger.js';
import { extractPdfDocument } from './pdf-service.js';
import { parseImportedDocument } from './document-import.js';
import { askLocalModel, checkLocalModel } from './local-llm-service.js';

const { autoUpdater } = updater;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let mainWindow;
let store;
let currentState;
let diagnostics;
let diagnosticPreviewCache;

protocol.registerSchemesAsPrivileged([{ scheme: 'vault', privileges: { standard: true, secure: true, supportFetchAPI: false, stream: true } }]);

if (process.env.FINANCE_USER_DATA_PATH) {
  app.setPath('userData', path.resolve(process.env.FINANCE_USER_DATA_PATH));
}

app.whenReady().then(async () => {
  diagnostics = new DiagnosticLogger(app.getPath('userData'), {
    secureStorage: safeStorage,
    appVersion: app.getVersion(),
    platform: process.platform,
    architecture: process.arch
  });
  await diagnostics.initialise();
  await diagnostics.record('APP_STARTED');
  if (!diagnostics.encryptionAvailable()) await diagnostics.record('SECURE_STORAGE_UNAVAILABLE');

  store = new FinanceDataStore(app.getPath('userData'), path.join(__dirname, 'seed-data.json'), diagnostics);
  await store.initialise();
  currentState = await store.loadState();
  registerVaultProtocol();
  registerIpcHandlers();
  createWindow();
  configureAutoUpdater();
  await diagnostics.record('APP_READY');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(async (error) => {
  await diagnostics?.record('APP_FATAL', { error }).catch(() => {});
  dialog.showErrorBox('OneStep Money could not start', 'The app could not open its private local storage. Restart the app, then export diagnostics from Settings if the issue continues.');
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: '#0d1117',
    show: !process.argv.includes('--capture-ui'),
    webPreferences: {
      preload: path.join(__dirname, 'preload-bridge.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true
    }
  });
  mainWindow.removeMenu();
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
  mainWindow.webContents.on('unresponsive', () => diagnostics.record('RENDERER_UNRESPONSIVE').catch(() => {}));
  mainWindow.webContents.on('render-process-gone', () => diagnostics.record('RENDERER_PROCESS_GONE').catch(() => {}));
  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  if (process.argv.includes('--capture-ui')) {
    mainWindow.webContents.once('did-finish-load', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const image = await mainWindow.webContents.capturePage();
      const capturePath = process.env.FINANCE_CAPTURE_PATH || path.join(__dirname, 'tmp', 'finance-ui.png');
      await fs.mkdir(path.dirname(capturePath), { recursive: true });
      await fs.writeFile(capturePath, image.toPNG());
      app.quit();
    });
  }
}

function configureAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ state: 'checking', message: 'Checking for updates…' }));
  autoUpdater.on('update-available', (info) => sendUpdateStatus({ state: 'downloading', version: info.version, message: `Version ${info.version} is downloading…` }));
  autoUpdater.on('update-not-available', () => sendUpdateStatus({ state: 'current', message: 'You have the latest version.' }));
  autoUpdater.on('download-progress', (progress) => sendUpdateStatus({ state: 'downloading', percent: Math.round(progress.percent || 0), message: `Downloading update… ${Math.round(progress.percent || 0)}%` }));
  autoUpdater.on('update-downloaded', (info) => sendUpdateStatus({ state: 'ready', version: info.version, message: `Version ${info.version} is ready to install.` }));
  autoUpdater.on('error', (error) => {
    diagnostics.record('UPDATE_FAILED', { error }).catch(() => {});
    sendUpdateStatus({ state: 'error', message: 'The update check failed. You can try again from Settings.' });
  });

  mainWindow.webContents.once('did-finish-load', () => {
    sendUpdateStatus({ state: app.isPackaged ? 'idle' : 'development', version: app.getVersion(), message: app.isPackaged ? 'Updates are checked automatically.' : 'Updates are disabled in development mode.' });
    if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  });
}

function sendUpdateStatus(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('update:status', { ...status, currentVersion: app.getVersion() });
}

function registerIpcHandlers() {
  ipcMain.handle('state:load', async () => ({ state: currentState, encryption: store.encryptionStatus() }));
  ipcMain.handle('state:save', async (_event, nextState) => {
    try {
      if (!nextState || JSON.stringify(nextState).length > 25_000_000) throw new Error('The data update is invalid or too large.');
      currentState = await store.saveState(nextState);
      return currentState;
    } catch (error) {
      await diagnostics.record('STATE_SAVE_FAILED', { error }).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('import:choose', async (_event, options = {}) => {
    const kind = options.kind === 'payslip' ? 'payslip' : 'statement';
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: kind === 'payslip' ? 'Import payslip' : 'Import bank statement',
      properties: ['openFile', 'multiSelections'],
      filters: kind === 'payslip'
        ? [{ name: 'Payslips', extensions: ['pdf'] }]
        : [{ name: 'Statements', extensions: ['pdf', 'csv', 'qif', 'ofx', 'json'] }]
    });
    if (selection.canceled) return [];
    await store.createAutomaticBackup('before-import');
    const results = [];
    for (const filePath of selection.filePaths) {
      const extension = path.extname(filePath).toLowerCase();
      let stored;
      try {
        stored = await store.storeDocument(filePath, kind, currentState.documents);
        const document = stored.document;
        const payload = extension === '.pdf' ? await extractPdfDocument(filePath) : await fs.readFile(filePath, 'utf8');
        const preview = parseImportedDocument(path.basename(filePath), payload, kind, options.accountId || '');
        preview.records = preview.records.map((record) => ({ ...record, sourceDocumentId: document.id }));
        document.displayName = canonicalDocumentName(document, preview, options.accountId, currentState);
        document.parseStatus = preview.records.length ? (preview.reconciled ? 'ready' : 'review') : 'needs_review';
        document.linkedRecordIds = preview.records.map((record) => record.id);
        results.push({ document, duplicateDocument: stored.duplicate, preview });
      } catch (error) {
        const fault = await diagnostics.record('DOCUMENT_IMPORT_FAILED', { error, documentType: kind, fileType: extension }).catch(() => ({ reference: 'IMP-101' }));
        const reason = `We couldn't read this ${kind === 'payslip' ? 'payslip' : 'bank statement'}. Error reference: ${fault.reference}.`;
        if (!stored) throw new Error(reason);
        stored.document.parseStatus = 'needs_review';
        results.push({ document: stored.document, duplicateDocument: stored.duplicate, preview: { kind, records: [], rejected: [{ row: 0, reason }], warnings: [], summary: {}, reconciled: false, errorReference: fault.reference } });
      }
      if (stored && !stored.duplicate) currentState.documents.push(stored.document);
    }
    currentState = await store.saveState(currentState);
    return results;
  });

  ipcMain.handle('document:open', async (_event, id) => {
    try {
      if (!currentState.documents.some((document) => document.id === id)) throw new Error('Document not found.');
      const viewer = new BrowserWindow({
        parent: mainWindow,
        width: 1040,
        height: 820,
        title: 'Secure document',
        backgroundColor: '#20242b',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, plugins: true }
      });
      viewer.removeMenu();
      viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      await viewer.loadURL(`vault://document/${id}`);
      return true;
    } catch (error) {
      await diagnostics.record('DOCUMENT_OPEN_FAILED', { error }).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('document:delete', async (_event, id) => {
    try {
      await store.createAutomaticBackup('before-document-delete');
      await store.deleteDocument(id, currentState.documents);
      currentState.documents = currentState.documents.filter((document) => document.id !== id);
      currentState = await store.saveState(currentState);
      return currentState;
    } catch (error) {
      await diagnostics.record('DOCUMENT_DELETE_FAILED', { error }).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('backup:create', async (_event, passphrase) => {
    try {
      const selection = await dialog.showSaveDialog(mainWindow, { title: 'Create encrypted backup', defaultPath: `onestep-money-backup-${new Date().toISOString().slice(0, 10)}.osmb`, filters: [{ name: 'OneStep Money backup', extensions: ['osmb'] }] });
      if (selection.canceled || !selection.filePath) return { canceled: true };
      await store.createPortableBackup(selection.filePath, passphrase, currentState);
      return { canceled: false, fileName: path.basename(selection.filePath) };
    } catch (error) {
      await diagnostics.record('BACKUP_CREATE_FAILED', { error }).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('backup:restore', async (_event, passphrase) => {
    try {
      const selection = await dialog.showOpenDialog(mainWindow, { title: 'Restore encrypted backup', properties: ['openFile'], filters: [{ name: 'OneStep Money backup', extensions: ['osmb', 'hfb'] }] });
      if (selection.canceled) return { canceled: true };
      currentState = await store.restorePortableBackup(selection.filePaths[0], passphrase);
      return { canceled: false, state: currentState };
    } catch (error) {
      await diagnostics.record('BACKUP_RESTORE_FAILED', { error }).catch(() => {});
      throw error;
    }
  });

  ipcMain.handle('llm:status', async (_event, model) => checkLocalModel(model || currentState.settings.llmModel));
  ipcMain.handle('llm:ask', async (_event, question) => askLocalModel(question, currentState, currentState.settings.llmModel));
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return { state: 'development', message: 'Updates are disabled in development mode.', currentVersion: app.getVersion() };
    await autoUpdater.checkForUpdates();
    return { state: 'checking', message: 'Checking for updates…', currentVersion: app.getVersion() };
  });
  ipcMain.handle('update:install', async () => {
    if (!app.isPackaged) return false;
    await store.createAutomaticBackup('before-update');
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  });

  ipcMain.handle('export:csv', async (_event, csv) => {
    const selection = await dialog.showSaveDialog(mainWindow, { title: 'Export payments', defaultPath: 'payments.csv', filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (selection.canceled || !selection.filePath) return false;
    await fs.writeFile(selection.filePath, String(csv), { encoding: 'utf8', mode: 0o600 });
    return true;
  });

  ipcMain.handle('diagnostics:preview', async () => {
    const report = await diagnostics.buildReport();
    diagnosticPreviewCache = { ...report, token: crypto.randomUUID(), expiresAt: Date.now() + (30 * 60 * 1000) };
    return {
      token: diagnosticPreviewCache.token,
      text: diagnosticPreviewCache.text,
      entryCount: diagnosticPreviewCache.entryCount,
      generatedAt: diagnosticPreviewCache.generatedAt,
      retentionDays: diagnosticPreviewCache.retentionDays,
      encryptionAvailable: diagnosticPreviewCache.encryptionAvailable
    };
  });

  ipcMain.handle('diagnostics:export', async (_event, token) => {
    if (!diagnosticPreviewCache || token !== diagnosticPreviewCache.token || Date.now() > diagnosticPreviewCache.expiresAt) {
      throw new Error('Review the diagnostic report again before exporting it.');
    }
    const selection = await dialog.showSaveDialog(mainWindow, {
      title: 'Export diagnostic report',
      defaultPath: `onestep-money-diagnostics-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: 'Text report', extensions: ['txt'] }]
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    await fs.writeFile(selection.filePath, diagnosticPreviewCache.text, { encoding: 'utf8', mode: 0o600 });
    return { canceled: false, fileName: path.basename(selection.filePath) };
  });

  ipcMain.handle('diagnostics:delete', async () => {
    await diagnostics.deleteAll();
    diagnosticPreviewCache = null;
    return true;
  });

  ipcMain.handle('diagnostics:renderer-fault', async (_event, eventName) => {
    if (!RENDERER_FAULT_EVENTS.includes(eventName)) throw new Error('Unsupported diagnostic event.');
    await diagnostics.record(eventName);
    return true;
  });
}

function registerVaultProtocol() {
  protocol.handle('vault', async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== 'document') return new Response('Not found', { status: 404 });
    const id = url.pathname.replace(/^\//, '');
    try {
      const { document, bytes } = await store.readDocument(id, currentState.documents);
      return new Response(bytes, {
        status: 200,
        headers: {
          'Content-Type': document.mimeType,
          'Content-Disposition': `inline; filename="${safeFileName(document.displayName || document.originalName)}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src 'self'"
        }
      });
    } catch (error) {
      diagnostics.record('DOCUMENT_OPEN_FAILED', { error }).catch(() => {});
      return new Response('Document could not be opened.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    }
  });
}

function safeFileName(value) {
  return String(value || 'document').replace(/["\r\n\\/]/g, '_');
}

function canonicalDocumentName(document, preview, accountId, state) {
  const extension = path.extname(document.originalName).toLowerCase() || '.bin';
  const record = preview.records?.[0];
  const date = preview.kind === 'payslip'
    ? record?.payDate || `${record?.period || new Date().toISOString().slice(0, 7)}-01`
    : [...(preview.records || [])].map((item) => item.date).filter(Boolean).sort().at(-1) || new Date().toISOString().slice(0, 10);
  const type = preview.kind === 'payslip' ? 'payslip' : 'bank-statement';
  const provider = preview.kind === 'payslip'
    ? 'jpa'
    : slugName(state.accounts.find((account) => account.id === accountId)?.institution || 'unassigned');
  const base = `${date}__${type}__${provider}`;
  const used = new Set((state.documents || []).map((item) => item.displayName).filter(Boolean));
  let candidate = `${base}${extension}`;
  let number = 2;
  while (used.has(candidate)) { candidate = `${base}__${number}${extension}`; number += 1; }
  return candidate;
}

function slugName(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}
