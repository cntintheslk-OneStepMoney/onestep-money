import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore, RecoveryModeError } from '../data-store.js';
import { debtPlan } from '../finance-core.js';

const seedPath = new URL('../seed-data.json', import.meta.url);
const fixedNow = new Date('2026-08-08T12:34:56.000Z');

test('a genuine first launch creates one valid initial state and starts normally', async (t) => {
  const harness = await createHarness(t);

  const first = await harness.store.loadState();
  assert.equal(first.status, 'normal');
  assert.equal(first.source, 'first_install');
  assert.equal(first.state.schemaVersion, 10);

  const firstBytes = await fs.readFile(harness.store.statePath);
  const second = await harness.store.loadState();
  assert.equal(second.status, 'normal');
  assert.equal(second.source, 'existing');
  assert.deepEqual(await fs.readFile(harness.store.statePath), firstBytes);
  assert.deepEqual(await fs.readdir(harness.store.recoveryPath), []);
});

test('a valid existing state opens normally without rewriting it', async (t) => {
  const harness = await createHarness(t);
  const original = stateEnvelope(validState({ profile: { ...validState().profile, name: 'Fictional User' } }));
  await fs.writeFile(harness.store.statePath, original);

  const result = await harness.store.loadState();

  assert.equal(result.status, 'normal');
  assert.equal(result.source, 'existing');
  assert.equal(result.state.profile.name, 'Fictional User');
  assert.deepEqual(await fs.readFile(harness.store.statePath), original);
});

test('malformed dashboard preferences reset without putting financial data into recovery', async (t) => {
  const harness = await createHarness(t);
  const original = validState({
    accounts: [{ id: 'fictional-account', name: 'Fictional account', currentBalance: 321 }],
    settings: { ...validState().settings, appearance: { theme: 'ultraviolet' }, dashboard: { mode: 'detailed', order: ['unknown-module'], hidden: 'all' } }
  });
  await fs.writeFile(harness.store.statePath, stateEnvelope(original));

  const result = await harness.store.loadState();

  assert.equal(result.status, 'normal');
  assert.equal(result.state.accounts[0].currentBalance, 321);
  assert.equal(result.state.settings.appearance.theme, 'system');
  assert.equal(result.state.settings.dashboard.mode, 'simple');
  assert.equal(result.state.settings.dashboard.order[0], 'next-move');
});

test('a valid Night Mode preference survives save and restart', async (t) => {
  const harness = await createHarness(t);
  const settings = { ...validState().settings, appearance: { theme: 'dark' } };
  await fs.writeFile(harness.store.statePath, stateEnvelope(validState({ settings })));

  const loaded = await harness.store.loadState();
  assert.equal(loaded.state.settings.appearance.theme, 'dark');
  await harness.store.saveState(loaded.state);

  const restarted = new FinanceDataStore(harness.directory, seedPath, harness.diagnostics, {
    secureStorage: secureStorage({ available: false }), clock: () => new Date(fixedNow)
  });
  await restarted.initialise();
  const reopened = await restarted.loadState();
  assert.equal(reopened.state.settings.appearance.theme, 'dark');
});

test('legacy debt safety fields migrate conservatively and persist across restart', async (t) => {
  const harness = await createHarness(t);
  const original = stateEnvelope(validState({
    profile: { ...validState().profile, dependableIncome: 2000 },
    debts: [{
      id: 'fictional-legacy-debt', name: 'Fictional Legacy Loan', type: 'Personal loan', currentBalance: 500,
      contractualPayment: 25, status: 'current', arrangementConfirmed: false, includeInPlan: true
    }]
  }));
  await fs.writeFile(harness.store.statePath, original);

  const loaded = await harness.store.loadState();

  assert.equal(loaded.state.schemaVersion, 10);
  assert.equal(loaded.state.debts[0].arrangementStatus, 'unknown');
  assert.equal(loaded.state.debts[0].arrangementPayment, null);
  assert.equal(loaded.state.debts[0].statusConflict, false);
  assert.equal(debtPlan(loaded.state, 'hybrid', 100, '2026-08').safeExtraPayment, 0);
  await harness.store.saveState(loaded.state);

  const restarted = new FinanceDataStore(harness.directory, seedPath, harness.diagnostics, {
    secureStorage: secureStorage({ available: false }), clock: () => new Date(fixedNow)
  });
  await restarted.initialise();
  const reopened = await restarted.loadState();
  assert.equal(reopened.state.debts[0].arrangementStatus, 'unknown');
  assert.equal(debtPlan(reopened.state, 'hybrid', 100, '2026-08').safeExtraPayment, 0);
});

for (const scenario of [
  { name: 'corrupt JSON', bytes: Buffer.from('{not-json'), reason: 'invalid_content' },
  { name: 'a truncated envelope', bytes: Buffer.from('{"version":1,"encrypted":false,"payload":"abc'), reason: 'invalid_content' },
  { name: 'an invalid schema', bytes: stateEnvelope(validState({ accounts: {} })), reason: 'schema_validation_failure' }
]) {
  test(`${scenario.name} enters recovery without replacing the original`, async (t) => {
    const harness = await createHarness(t);
    await fs.writeFile(harness.store.statePath, scenario.bytes);

    const result = await harness.store.loadState();

    assert.equal(result.status, 'recovery_required');
    assert.equal(result.recovery.reasonCode, scenario.reason);
    assert.equal(result.recovery.recoveryCopyCreated, true);
    assert.deepEqual(await fs.readFile(harness.store.statePath), scenario.bytes);
    const copies = await fs.readdir(harness.store.recoveryPath);
    assert.equal(copies.length, 1);
    assert.deepEqual(await fs.readFile(path.join(harness.store.recoveryPath, copies[0])), scenario.bytes);
  });
}

test('decryption and missing-key failures have distinct safe reason codes', async (t) => {
  const encrypted = stateEnvelope(validState(), true);
  const decryptFailure = await createHarness(t, {
    secureStorage: secureStorage({ decryptString: () => { throw new Error('fictional authentication material must not be logged'); } })
  });
  await fs.writeFile(decryptFailure.store.statePath, encrypted);
  assert.equal((await decryptFailure.store.loadState()).recovery.reasonCode, 'decryption_failure');
  assert.deepEqual(await fs.readFile(decryptFailure.store.statePath), encrypted);

  const missingKey = await createHarness(t, { secureStorage: secureStorage({ available: false }) });
  await fs.writeFile(missingKey.store.statePath, encrypted);
  assert.equal((await missingKey.store.loadState()).recovery.reasonCode, 'encryption_key_unavailable');
  assert.deepEqual(await fs.readFile(missingKey.store.statePath), encrypted);
});

test('migration failure enters recovery and preserves the stored bytes', async (t) => {
  const harness = await createHarness(t, { migrateState: () => { throw new Error('fictional migration failure'); } });
  const original = stateEnvelope(validState());
  await fs.writeFile(harness.store.statePath, original);

  const result = await harness.store.loadState();

  assert.equal(result.recovery.reasonCode, 'migration_failure');
  assert.deepEqual(await fs.readFile(harness.store.statePath), original);
});

test('read failure and recovery-copy failure never trigger a blank-state write', async (t) => {
  const readFailure = await createHarness(t);
  await fs.mkdir(readFailure.store.statePath);
  const readResult = await readFailure.store.loadState();
  assert.equal(readResult.status, 'recovery_required');
  assert.equal(readResult.recovery.reasonCode, 'read_failure');
  assert.equal(readResult.recovery.recoveryCopyCreated, false);
  assert.equal((await fs.stat(readFailure.store.statePath)).isDirectory(), true);

  const copyFailure = await createHarness(t);
  const original = Buffer.from('unreadable fictional state');
  await fs.writeFile(copyFailure.store.statePath, original);
  copyFailure.store.createRecoveryCopy = async () => ({ created: false, fileName: null });
  const copyResult = await copyFailure.store.loadState();
  assert.equal(copyResult.status, 'recovery_required');
  assert.equal(copyResult.recovery.recoveryCopyCreated, false);
  assert.deepEqual(await fs.readFile(copyFailure.store.statePath), original);
});

test('recovery centrally blocks saves, imports, deletes and automatic backups', async (t) => {
  const harness = await createHarness(t);
  const original = Buffer.from('invalid state');
  await fs.writeFile(harness.store.statePath, original);
  await harness.store.loadState();
  const fixture = path.join(harness.directory, 'fictional-statement.txt');
  await fs.writeFile(fixture, 'fictional contents');

  await assert.rejects(harness.store.saveState(validState()), RecoveryModeError);
  await assert.rejects(harness.store.createAutomaticBackup('autosave'), RecoveryModeError);
  await assert.rejects(harness.store.storeDocument(fixture, 'statement', []), RecoveryModeError);
  await assert.rejects(harness.store.deleteDocument('00000000-0000-0000-0000-000000000000', []), RecoveryModeError);
  assert.deepEqual(await fs.readFile(harness.store.statePath), original);
});

test('valid backups are identified, corrupt backups are rejected, and discovery is read-only', async (t) => {
  const harness = await createHarness(t);
  const corruptState = Buffer.from('invalid active state');
  const validBackup = stateEnvelope(validState({ profile: { ...validState().profile, name: 'Backup User' } }));
  const corruptBackup = Buffer.from('invalid backup');
  const validPath = path.join(harness.store.backupPath, '2026-08-07-valid.json');
  const corruptPath = path.join(harness.store.backupPath, '2026-08-06-corrupt.json');
  await fs.writeFile(harness.store.statePath, corruptState);
  await fs.writeFile(validPath, validBackup);
  await fs.writeFile(corruptPath, corruptBackup);

  const result = await harness.store.loadState();

  assert.equal(result.recovery.backups.length, 2);
  assert.equal(result.recovery.backups.filter((backup) => backup.valid).length, 1);
  assert.equal(result.recovery.backups.filter((backup) => !backup.valid).length, 1);
  assert.deepEqual(await fs.readFile(validPath), validBackup);
  assert.deepEqual(await fs.readFile(corruptPath), corruptBackup);
  assert.deepEqual(await fs.readFile(harness.store.statePath), corruptState);
});

test('restoring a validated backup exits recovery only after the restored state reopens', async (t) => {
  const harness = await createHarness(t);
  const original = Buffer.from('invalid active state');
  const backup = stateEnvelope(validState({ profile: { ...validState().profile, name: 'Restored User' } }));
  await fs.writeFile(harness.store.statePath, original);
  const backupPath = path.join(harness.store.backupPath, '2026-08-07-valid.json');
  await fs.writeFile(backupPath, backup);
  const recovery = await harness.store.loadState();
  const validBackup = recovery.recovery.backups.find((item) => item.valid);

  const restored = await harness.store.restoreRecoveryBackup(validBackup.id);

  assert.equal(restored.status, 'normal');
  assert.equal(restored.source, 'restored_backup');
  assert.equal(restored.state.profile.name, 'Restored User');
  assert.equal(restored.state.schemaVersion, 10);
  assert.deepEqual(await fs.readFile(backupPath), backup);
  const recoveryCopies = await fs.readdir(harness.store.recoveryPath);
  assert.ok(recoveryCopies.length >= 2);
  const originalCopy = recoveryCopies.find((name) => name.startsWith('finance-state.recovery-'));
  assert.ok(originalCopy);
  assert.deepEqual(await fs.readFile(path.join(harness.store.recoveryPath, originalCopy)), original);
  assert.ok(recoveryCopies.some((name) => name.endsWith('.osmb-set')));
});

test('a corrupt selected backup cannot replace the active state', async (t) => {
  const harness = await createHarness(t);
  const original = Buffer.from('invalid active state');
  const corruptBackup = Buffer.from('invalid backup');
  await fs.writeFile(harness.store.statePath, original);
  await fs.writeFile(path.join(harness.store.backupPath, '2026-08-07-corrupt.json'), corruptBackup);
  const recovery = await harness.store.loadState();
  const invalidBackup = recovery.recovery.backups.find((item) => !item.valid);

  const result = await harness.store.restoreRecoveryBackup(invalidBackup.id);

  assert.equal(result.status, 'recovery_required');
  assert.equal(result.recovery.lastOperationError, 'backup_not_found');
  assert.deepEqual(await fs.readFile(harness.store.statePath), original);
});

test('retry clears recovery only after the original becomes valid', async (t) => {
  const harness = await createHarness(t);
  const invalid = Buffer.from('invalid active state');
  await fs.writeFile(harness.store.statePath, invalid);
  await harness.store.loadState();

  const failedRetry = await harness.store.retryRecoveryLoad();
  assert.equal(failedRetry.status, 'recovery_required');
  assert.equal((await fs.readdir(harness.store.recoveryPath)).length, 2);
  assert.deepEqual(await fs.readFile(harness.store.statePath), invalid);

  await fs.writeFile(harness.store.statePath, stateEnvelope(validState()));
  const successfulRetry = await harness.store.retryRecoveryLoad();
  assert.equal(successfulRetry.status, 'normal');
  assert.equal(successfulRetry.source, 'existing');
});

test('restarting with the same unreadable state cannot bypass recovery', async (t) => {
  const harness = await createHarness(t);
  const original = Buffer.from('invalid active state');
  await fs.writeFile(harness.store.statePath, original);
  assert.equal((await harness.store.loadState()).status, 'recovery_required');

  const restarted = new FinanceDataStore(harness.directory, seedPath, harness.diagnostics, {
    secureStorage: secureStorage({ available: false }),
    clock: () => new Date(fixedNow)
  });
  await restarted.initialise();
  const result = await restarted.loadState();

  assert.equal(result.status, 'recovery_required');
  assert.equal(result.recovery.reasonCode, 'invalid_content');
  assert.deepEqual(await fs.readFile(restarted.statePath), original);
});

test('fresh start requires a live confirmation and cancellation changes nothing', async (t) => {
  const harness = await createHarness(t);
  const original = Buffer.from('invalid active state');
  await fs.writeFile(harness.store.statePath, original);
  await harness.store.loadState();

  const request = harness.store.requestFreshStart();
  assert.equal(request.status, 'confirmation_required');
  harness.store.cancelFreshStart(request.token);
  const cancelled = await harness.store.confirmFreshStart(request.token);
  assert.equal(cancelled.status, 'recovery_required');
  assert.equal(cancelled.recovery.lastOperationError, 'confirmation_invalid');
  assert.deepEqual(await fs.readFile(harness.store.statePath), original);

  const confirmedRequest = harness.store.requestFreshStart();
  const confirmed = await harness.store.confirmFreshStart(confirmedRequest.token);
  assert.equal(confirmed.status, 'normal');
  assert.equal(confirmed.source, 'fresh_start');
  assert.equal(confirmed.state.schemaVersion, 10);
  assert.equal(confirmed.state.accounts.length, 0);
  assert.notDeepEqual(await fs.readFile(harness.store.statePath), original);
  const recoveryCopies = await fs.readdir(harness.store.recoveryPath);
  assert.ok(recoveryCopies.length >= 1);
  assert.deepEqual(await fs.readFile(path.join(harness.store.recoveryPath, recoveryCopies[0])), original);
});

async function createHarness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const diagnostics = { events: [], async record(name, context) { this.events.push({ name, context }); } };
  const store = new FinanceDataStore(directory, seedPath, diagnostics, {
    secureStorage: options.secureStorage || secureStorage({ available: false }),
    clock: () => new Date(fixedNow),
    migrateState: options.migrateState
  });
  await store.initialise();
  return { directory, diagnostics, store };
}

function secureStorage(options = {}) {
  const available = options.available ?? true;
  return {
    isEncryptionAvailable: () => available,
    encryptString: options.encryptString || ((value) => Buffer.from(value, 'utf8')),
    decryptString: options.decryptString || ((value) => value.toString('utf8'))
  };
}

function validState(overrides = {}) {
  return {
    schemaVersion: 5,
    meta: { createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z' },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: 30 },
    accounts: [], transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [],
    budgets: [], scheduledPayments: [], documents: [], tasks: [], checkIns: [], importBatches: [],
    settings: {
      selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 500, emergencyBufferBalance: 0,
      extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 }
    },
    ...overrides
  };
}

function stateEnvelope(state, encrypted = false) {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  return Buffer.from(JSON.stringify({ version: 1, encrypted, payload }), 'utf8');
}