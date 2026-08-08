import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore, StateRevisionConflictError } from '../data-store.js';
import { buildNextAction } from '../finance-core.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('legacy state receives a safe revision and stale whole-state saves preserve newer information', async (t) => {
  const harness = await createHarness(t);
  const legacy = JSON.parse(await fs.readFile(seedPath, 'utf8'));
  legacy.schemaVersion = 6;
  delete legacy.meta.revision;
  await fs.writeFile(harness.store.statePath, stateEnvelope(legacy));

  const loaded = (await harness.store.loadState()).state;
  assert.equal(loaded.meta.revision, 0);

  const firstEdit = structuredClone(loaded);
  firstEdit.transactions.push(fictionalTransaction('newer-payment'));
  const firstSaved = await harness.store.saveState(firstEdit);
  assert.equal(firstSaved.meta.revision, 1);

  const staleImport = structuredClone(loaded);
  staleImport.transactions.push(fictionalTransaction('stale-import'));
  staleImport.importBatches.push({ id: 'stale-batch', documentId: 'fictional-document', kind: 'statement' });
  await assert.rejects(harness.store.saveState(staleImport), (error) => {
    assert.ok(error instanceof StateRevisionConflictError);
    assert.equal(error.expectedRevision, 0);
    assert.equal(error.actualRevision, 1);
    return true;
  });

  const afterConflict = (await harness.store.loadState()).state;
  assert.deepEqual(afterConflict.transactions.map((item) => item.id), ['newer-payment']);
  assert.equal(afterConflict.importBatches.length, 0);

  const sequentialEdit = structuredClone(afterConflict);
  sequentialEdit.transactions.push(fictionalTransaction('sequential-payment'));
  const sequentialSaved = await harness.store.saveState(sequentialEdit);
  assert.equal(sequentialSaved.meta.revision, 2);
  assert.deepEqual(sequentialSaved.transactions.map((item) => item.id), ['newer-payment', 'sequential-payment']);
});

test('renderer conflict handling replaces stale state and presents the protected-save message', async () => {
  const main = await fs.readFile(new URL('../main-process.js', import.meta.url), 'utf8');
  const renderer = await fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8');
  assert.match(main, /reasonCode: 'state_revision_conflict'/);
  assert.match(renderer, /saved\?\.status === 'conflict'/);
  assert.match(renderer, /showToast\(saved\.message\)/);
});

test('generated-action snoozes survive save, restart and encrypted backup restore while expired values are cleaned', async (t) => {
  const harness = await createHarness(t);
  const tomorrow = localDateKey(new Date(Date.now() + 86_400_000));
  let state = (await harness.store.loadState()).state;
  state.settings.snoozedActions = {
    'generated-first-account': tomorrow,
    'expired-action': '2000-01-01',
    'malformed action': 'not-a-date',
    'impossible-date': '2999-02-31'
  };
  state.settings.unrecognisedPersistedValue = { shouldNotSurvive: true };
  state = await harness.store.saveState(state);

  assert.deepEqual(state.settings.snoozedActions, { 'generated-first-account': tomorrow });
  assert.equal(state.settings.unrecognisedPersistedValue, undefined);
  assert.equal(buildNextAction(state).id, 'generated-checkin');

  const restarted = new FinanceDataStore(harness.directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  assert.equal(state.settings.snoozedActions['generated-first-account'], tomorrow);

  const backupPath = path.join(harness.directory, 'snoozes.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  const cleared = structuredClone(state);
  cleared.settings.snoozedActions = {};
  await restarted.saveState(cleared);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.settings.snoozedActions['generated-first-account'], tomorrow);

  const expired = structuredClone(restored.state);
  expired.settings.snoozedActions = { 'generated-first-account': '2000-01-01' };
  const cleaned = await restarted.saveState(expired);
  assert.deepEqual(cleaned.settings.snoozedActions, {});
  assert.equal(buildNextAction(cleaned).id, 'generated-first-account');
});

async function createHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-integrity-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  return { directory, store };
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}

function stateEnvelope(state) {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
  return JSON.stringify({ version: 1, encrypted: false, payload });
}

function fictionalTransaction(id) {
  return {
    id,
    date: '2026-08-08',
    budgetMonth: '2026-08',
    description: 'Fictional payment',
    incoming: 0,
    outgoing: 10,
    duplicateStatus: 'none',
    reviewStatus: 'not_required',
    financiallyActive: true
  };
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
