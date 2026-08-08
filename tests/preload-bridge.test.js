import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('sandboxed preload exposes the complete desktop API', async () => {
  const source = fs.readFileSync(new URL('../preload-bridge.cjs', import.meta.url), 'utf8');
  const invocations = [];
  const listeners = new Map();
  let exposed;

  const electron = {
    contextBridge: {
      exposeInMainWorld(name, api) {
        exposed = { name, api };
      }
    },
    ipcRenderer: {
      invoke(channel, ...args) {
        invocations.push([channel, ...args]);
        return Promise.resolve({ channel });
      },
      on(channel, listener) {
        listeners.set(channel, listener);
      },
      removeListener(channel, listener) {
        if (listeners.get(channel) === listener) listeners.delete(channel);
      }
    }
  };

  vm.runInNewContext(source, {
    require(specifier) {
      assert.equal(specifier, 'electron');
      return electron;
    }
  }, { filename: 'preload-bridge.cjs' });

  assert.equal(exposed.name, 'financeAPI');
  assert.ok(Object.isFrozen(exposed.api));
  await exposed.api.loadState();
  await exposed.api.saveState({ ok: true });
  await exposed.api.retryRecovery();
  await exposed.api.restoreRecoveryBackup('backup-id');
  await exposed.api.selectRecoveryPortableBackup('backup-password');
  await exposed.api.requestFreshStart();
  await exposed.api.cancelFreshStart('confirmation-token');
  await exposed.api.confirmFreshStart('confirmation-token');
  await exposed.api.importFiles({ kind: 'statement' });
  await exposed.api.createBackup('backup-password');
  await exposed.api.selectRestoreBackup('backup-password');
  await exposed.api.restoreBackup('restore-token');
  await exposed.api.cancelRestoreBackup('restore-token');
  await exposed.api.previewDiagnostics();
  await exposed.api.exportDiagnostics('preview-token');
  await exposed.api.deleteDiagnostics();
  await exposed.api.recordRendererFault('RENDERER_UNHANDLED_ERROR');
  await exposed.api.checkForUpdates();
  assert.deepEqual(invocations, [
    ['state:load'],
    ['state:save', { ok: true }],
    ['recovery:retry'],
    ['recovery:restore-backup', 'backup-id'],
    ['recovery:select-portable-backup', 'backup-password'],
    ['recovery:fresh-start:request'],
    ['recovery:fresh-start:cancel', 'confirmation-token'],
    ['recovery:fresh-start:confirm', 'confirmation-token'],
    ['import:choose', { kind: 'statement' }],
    ['backup:create', 'backup-password'],
    ['backup:select-restore', 'backup-password'],
    ['backup:restore', 'restore-token'],
    ['backup:restore-cancel', 'restore-token'],
    ['diagnostics:preview'],
    ['diagnostics:export', 'preview-token'],
    ['diagnostics:delete'],
    ['diagnostics:renderer-fault', 'RENDERER_UNHANDLED_ERROR'],
    ['update:check']
  ]);

  let updateStatus;
  const unsubscribe = exposed.api.onUpdateStatus((status) => { updateStatus = status; });
  listeners.get('update:status')({}, { state: 'ready' });
  assert.deepEqual(updateStatus, { state: 'ready' });
  unsubscribe();
  assert.equal(listeners.has('update:status'), false);

  let restoreProgress;
  const unsubscribeRestore = exposed.api.onRestoreProgress((status) => { restoreProgress = status; });
  listeners.get('backup:restore-progress')({}, { stage: 'verifying_restored_data', canCancel: false });
  assert.deepEqual(restoreProgress, { stage: 'verifying_restored_data', canCancel: false });
  unsubscribeRestore();
  assert.equal(listeners.has('backup:restore-progress'), false);
});
