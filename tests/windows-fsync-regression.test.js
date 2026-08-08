import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('automatic backup does not fsync a read-only file handle', async (t) => {
  const originalOpen = fs.open;
  fs.open = async (target, flags, ...args) => {
    const handle = await originalOpen(target, flags, ...args);
    if (flags !== 'r') return handle;

    return new Proxy(handle, {
      get(object, property) {
        if (property === 'sync') {
          return async () => {
            const error = new Error('simulated Windows read-only fsync rejection');
            error.code = 'EPERM';
            throw error;
          };
        }
        const value = Reflect.get(object, property, object);
        return typeof value === 'function' ? value.bind(object) : value;
      }
    });
  };
  t.after(() => { fs.open = originalOpen; });

  const { FinanceDataStore } = await import(`../data-store.js?windows-fsync=${Date.now()}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-fsync-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const store = new FinanceDataStore(directory, seedPath, null, {
    secureStorage: { isEncryptionAvailable: () => false },
    appVersion: '2.1.8'
  });
  await store.initialise();
  const loaded = await store.loadState();
  assert.equal(loaded.status, 'normal');

  const backupPath = await store.createAutomaticBackup('windows-fsync-regression');
  assert.ok(backupPath);
  const inspected = await store.validateLocalBackupSet(backupPath, { requireSemanticValidation: true });
  assert.equal(inspected.valid, true);
});
