import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore, PersistenceBusyError, RecoveryModeError } from '../data-store.js';

const seedPath = new URL('../seed-data.json', import.meta.url);
const passphrase = 'fictional-password';

test('automatic backups publish one verified state-and-vault set while all mutations are locked', async (t) => {
  let releaseSnapshot;
  let snapshotReached;
  const reached = new Promise((resolve) => { snapshotReached = resolve; });
  const gate = new Promise((resolve) => { releaseSnapshot = resolve; });
  const harness = await createHarness(t, {
    faultInjector: async (point) => {
      if (point === 'backup_before_publish') {
        snapshotReached();
        await gate;
      }
    }
  });
  const { state, fixture } = await stateWithDocument(harness, 'Snapshot state', 'fictional document bytes');
  const snapshot = harness.store.createAutomaticBackup('before-test');
  await reached;

  await assert.rejects(harness.store.saveState(state), PersistenceBusyError);
  await assert.rejects(harness.store.storeDocument(fixture, 'statement', state.documents), PersistenceBusyError);
  await assert.rejects(harness.store.deleteDocument(state.documents[0].id, state.documents), PersistenceBusyError);
  await assert.rejects(harness.store.createAutomaticBackup('second'), PersistenceBusyError);
  releaseSnapshot();

  const backupPath = await snapshot;
  const inspected = await harness.store.validateLocalBackupSet(backupPath, { requireSemanticValidation: true });
  assert.equal(inspected.manifest.documentCount, 1);
  assert.equal(inspected.state.profile.name, 'Snapshot state');
  const manifestText = await fs.readFile(path.join(backupPath, 'manifest.json'), 'utf8');
  assert.doesNotMatch(manifestText, /Snapshot state|fictional document bytes/);
  assert.equal((await fs.readdir(harness.store.backupPath)).some((name) => name.includes('.tmp-')), false);
});

test('failed backup publication leaves no valid or temporary backup behind', async (t) => {
  let fail = false;
  const harness = await createHarness(t, { faultInjector: async (point) => { if (fail && point === 'backup_before_publish') throw new Error('fictional publish failure'); } });
  await harness.store.loadState();
  fail = true;
  await assert.rejects(harness.store.createAutomaticBackup('failed'), /fictional publish failure/);
  assert.deepEqual(await fs.readdir(harness.store.backupPath), []);
  assert.equal((await harness.store.loadState()).status, 'normal');
});

test('a portable backup restores the matching state and documents without changing its source or duplicating records', async (t) => {
  const harness = await createHarness(t);
  const { state } = await stateWithDocument(harness, 'Backed up state', 'fictional portable contents');
  const source = path.join(harness.directory, 'complete.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  const sourceBefore = await fs.readFile(source);

  const changed = structuredClone(state);
  changed.profile.name = 'Later state';
  changed.transactions.push({ id: crypto.randomUUID(), date: '2026-08-08', amount: -12, description: 'Fictional later record' });
  await harness.store.saveState(changed);

  const first = await harness.store.restorePortableBackup(source, passphrase);
  assert.equal(first.status, 'restored');
  assert.equal(first.state.profile.name, 'Backed up state');
  assert.equal(first.state.transactions.length, 0);
  assert.equal(first.state.documents.length, 1);
  assert.equal((await harness.store.readDocument(first.state.documents[0].id, first.state.documents)).bytes.toString(), 'fictional portable contents');
  assert.deepEqual(await fs.readFile(source), sourceBefore);

  const second = await harness.store.restorePortableBackup(source, passphrase);
  assert.equal(second.status, 'restored');
  assert.equal(second.state.documents.length, 1);
  assert.equal(second.state.transactions.length, 0);
  assert.deepEqual(await fs.readFile(source), sourceBefore);
  assert.ok((await fs.readdir(harness.store.recoveryPath)).filter((name) => name.endsWith('.osmb-set')).length >= 2);
});

test('recovery mode restores a validated automatic backup with its matching document vault', async (t) => {
  const harness = await createHarness(t);
  const { state } = await stateWithDocument(harness, 'Recovery backup state', 'recovery document');
  await harness.store.createAutomaticBackup('recovery-test');
  await fs.writeFile(harness.store.statePath, 'fictional corrupt state');
  const recovery = await harness.store.loadState();
  assert.equal(recovery.status, 'recovery_required');
  const candidate = recovery.recovery.backups.find((backup) => backup.valid && backup.documentCount === 1);
  assert.ok(candidate);

  const restored = await harness.store.restoreRecoveryBackup(candidate.id);
  assert.equal(restored.status, 'normal');
  assert.equal(restored.state.profile.name, state.profile.name);
  assert.equal((await harness.store.readDocument(restored.state.documents[0].id, restored.state.documents)).bytes.toString(), 'recovery document');
});

test('portable restore stages a new encrypted vault key without altering a keyless live dataset first', async (t) => {
  const harness = await createHarness(t);
  const { state } = await stateWithDocument(harness, 'Backup with document', 'portable key fixture');
  const source = path.join(harness.directory, 'keyless-restore.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  await harness.store.deleteDocument(state.documents[0].id, state.documents);
  const keyless = await harness.store.saveState({ ...state, profile: { ...state.profile, name: 'Keyless live state' }, documents: [] });
  await fs.unlink(harness.store.keyPath);
  harness.store.vaultKey = null;
  const liveBefore = await fs.readFile(harness.store.statePath);

  const restored = await harness.store.restorePortableBackup(source, passphrase);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.profile.name, 'Backup with document');
  assert.equal((await harness.store.readDocument(restored.state.documents[0].id, restored.state.documents)).bytes.toString(), 'portable key fixture');
  assert.notDeepEqual(await fs.readFile(harness.store.statePath), liveBefore);
  assert.equal(keyless.documents.length, 0);
});

test('portable validation rejects authentication failure, corruption, unsafe paths and newer versions before live data changes', async (t) => {
  const harness = await createHarness(t);
  let state = (await harness.store.loadState()).state;
  state.profile.name = 'Live state';
  state = await harness.store.saveState(state);
  const liveBefore = await fs.readFile(harness.store.statePath);
  const validPath = path.join(harness.directory, 'valid.osmb');
  await harness.store.createPortableBackup(validPath, passphrase, state);

  await assert.rejects(harness.store.inspectPortableBackup(validPath, 'incorrect-password'), /password is incorrect|damaged/);
  const corrupt = Buffer.from(await fs.readFile(validPath));
  corrupt[corrupt.length - 1] ^= 0xff;
  const corruptPath = path.join(harness.directory, 'corrupt.osmb');
  await fs.writeFile(corruptPath, corrupt);
  await assert.rejects(harness.store.inspectPortableBackup(corruptPath, passphrase), /password is incorrect|damaged/);

  const traversalPath = path.join(harness.directory, 'traversal.osmb');
  await writeCraftedBackup(traversalPath, passphrase, state, { extraFilePath: '../escape' });
  await assert.rejects(harness.store.inspectPortableBackup(traversalPath, passphrase), /unsafe path/);
  const newerPath = path.join(harness.directory, 'newer.osmb');
  await writeCraftedBackup(newerPath, passphrase, state, { applicationVersion: '2.2.0' });
  await assert.rejects(harness.store.inspectPortableBackup(newerPath, passphrase), /newer unsupported/);
  const missingManifestPath = path.join(harness.directory, 'missing-manifest.osmb');
  await writeEncryptedPayload(missingManifestPath, passphrase, { formatVersion: 2, files: {} });
  await assert.rejects(harness.store.inspectPortableBackup(missingManifestPath, passphrase), /manifest is invalid/);

  assert.deepEqual(await fs.readFile(harness.store.statePath), liveBefore);
});

test('failure before commit abandons staging and leaves every live byte unchanged', async (t) => {
  let fail = false;
  const harness = await createHarness(t, { faultInjector: async (point) => { if (fail && point === 'restore_after_validation') throw new Error('fictional staging fault'); } });
  let state = (await stateWithDocument(harness, 'Backup state', 'backup document')).state;
  const source = path.join(harness.directory, 'backup.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  state.profile.name = 'Current state';
  state = await harness.store.saveState(state);
  const before = await captureLiveDataset(harness.store);
  fail = true;

  await assert.rejects(harness.store.restorePortableBackup(source, passphrase), /fictional staging fault/);
  assert.deepEqual(await captureLiveDataset(harness.store), before);
  assert.equal(await exists(harness.store.restoreJournalPath), false);
  assert.equal((await fs.readdir(harness.store.restorePath)).length, 0);
});

test('failure after live replacement begins rolls the complete dataset back and preserves the selected backup', async (t) => {
  let faultPoint = null;
  const harness = await createHarness(t, { faultInjector: async (point) => { if (point === faultPoint) throw new Error('fictional commit fault'); } });
  let state = (await stateWithDocument(harness, 'Backup state', 'backup document')).state;
  const source = path.join(harness.directory, 'backup.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  const sourceBefore = await fs.readFile(source);
  state.profile.name = 'Current state';
  state = await harness.store.saveState(state);
  const before = await captureLiveDataset(harness.store);
  faultPoint = 'restore_after_state_install';

  const result = await harness.store.restorePortableBackup(source, passphrase);
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.state.profile.name, 'Current state');
  assert.deepEqual(await captureLiveDataset(harness.store), before);
  assert.deepEqual(await fs.readFile(source), sourceBefore);
  assert.equal(harness.store.mode, 'normal');
});

test('rollback failure enters recovery mode, blocks writes and never creates a blank state', async (t) => {
  let enabled = false;
  const harness = await createHarness(t, {
    faultInjector: async (point) => {
      if (!enabled) return;
      if (point === 'restore_after_state_install') throw new Error('fictional install failure');
      if (point === 'restore_during_rollback') throw new Error('fictional rollback failure');
    }
  });
  let state = (await harness.store.loadState()).state;
  state.profile.name = 'Backup state';
  state = await harness.store.saveState(state);
  const source = path.join(harness.directory, 'backup.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  const sourceBefore = await fs.readFile(source);
  state.profile.name = 'Current state';
  await harness.store.saveState(state);
  enabled = true;

  const result = await harness.store.restorePortableBackup(source, passphrase);
  assert.equal(result.status, 'recovery_required');
  assert.equal(result.recovery.reasonCode, 'restore_rollback_failed');
  await assert.rejects(harness.store.saveState(state), RecoveryModeError);
  assert.equal(await exists(harness.store.restoreJournalPath), true);
  assert.doesNotMatch(await fs.readFile(harness.store.restoreJournalPath, 'utf8'), /Backup state|Current state|fictional install|fictional rollback/);
  assert.notEqual((await fs.readFile(harness.store.statePath)).length, 0);
  assert.deepEqual(await fs.readFile(source), sourceBefore);
});

test('startup resolves interruption after every durable restore phase', async (t) => {
  const scenarios = [
    ['restore_after_journal_write', 'Current state'],
    ['restore_during_staging', 'Current state'],
    ['restore_after_validation', 'Current state'],
    ['restore_after_safety_copy', 'Current state'],
    ['restore_before_live_replacement', 'Current state'],
    ['restore_after_live_state_displaced', 'Current state'],
    ['restore_after_state_install', 'Current state'],
    ['restore_after_document_install', 'Backup state'],
    ['restore_before_verification', 'Backup state'],
    ['restore_after_verification', 'Backup state']
  ];
  for (const [point, expectedName] of scenarios) {
    const harness = await createHarness(t, { cleanup: false });
    await prepareInterruptedRestore(harness, point);
    const restarted = new FinanceDataStore(harness.directory, seedPath, harness.diagnostics, { secureStorage: secureStorage(), appVersion: '2.1.6' });
    await restarted.initialise();
    const loaded = await restarted.loadState();
    assert.equal(loaded.status, 'normal', point);
    assert.equal(loaded.state.profile.name, expectedName, point);
    assert.equal(await exists(restarted.restoreJournalPath), false, point);
    await fs.rm(harness.directory, { recursive: true, force: true });
  }
});

test('restore mode centrally rejects concurrent saves, imports, deletes, backups and a second restore', async (t) => {
  let release;
  let reached;
  const gateReached = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let pause = false;
  const harness = await createHarness(t, { faultInjector: async (point) => { if (pause && point === 'restore_after_validation') { reached(); await gate; } } });
  const { state, fixture } = await stateWithDocument(harness, 'Backup state', 'backup document');
  const source = path.join(harness.directory, 'restore-lock.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  pause = true;
  const restoring = harness.store.restorePortableBackup(source, passphrase);
  await gateReached;

  await assert.rejects(harness.store.saveState(state), PersistenceBusyError);
  await assert.rejects(harness.store.storeDocument(fixture, 'statement', state.documents), PersistenceBusyError);
  await assert.rejects(harness.store.deleteDocument(state.documents[0].id, state.documents), PersistenceBusyError);
  await assert.rejects(harness.store.createAutomaticBackup('concurrent'), PersistenceBusyError);
  await assert.rejects(harness.store.restorePortableBackup(source, passphrase), PersistenceBusyError);
  release();
  assert.equal((await restoring).status, 'restored');
});

test('pre-commit cancellation and legacy classification are explicit and non-destructive', async (t) => {
  const harness = await createHarness(t);
  let state = (await harness.store.loadState()).state;
  state.profile.name = 'Current state';
  state = await harness.store.saveState(state);
  const source = path.join(harness.directory, 'backup.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  const before = await fs.readFile(harness.store.statePath);
  await assert.rejects(harness.store.restorePortableBackup(source, passphrase, { shouldCancel: () => true }), /cancelled before live data/);
  assert.deepEqual(await fs.readFile(harness.store.statePath), before);

  const completeLegacy = path.join(harness.directory, 'legacy-complete.hfb');
  await writeLegacyBackup(completeLegacy, passphrase, state, []);
  assert.equal((await harness.store.inspectPortableBackup(completeLegacy, passphrase)).classification, 'legacy_complete');
  const metadata = fictionalDocumentMetadata();
  const incompleteState = { ...state, documents: [metadata] };
  const stateOnlyLegacy = path.join(harness.directory, 'legacy-state-only.hfb');
  await writeLegacyBackup(stateOnlyLegacy, passphrase, incompleteState, []);
  const inspection = await harness.store.inspectPortableBackup(stateOnlyLegacy, passphrase);
  assert.equal(inspection.classification, 'legacy_state_only');
  assert.equal(inspection.complete, false);
  await assert.rejects(harness.store.restorePortableBackup(stateOnlyLegacy, passphrase), /does not contain a complete/);
  assert.deepEqual(await fs.readFile(harness.store.statePath), before);
});

test('deleting an imported vault file retains fingerprint provenance through backup and restore', async (t) => {
  const harness = await createHarness(t);
  let { state, fixture } = await stateWithDocument(harness, 'Fictional User', 'fictional completed statement');
  const document = state.documents[0];
  document.parseStatus = 'imported';
  state.importBatches.push({ id: 'fictional-import-batch', documentId: document.id, kind: 'statement', importedAt: '2026-08-08T12:00:00.000Z', recordCount: 1 });
  state = await harness.store.saveState(state);

  assert.equal(await harness.store.deleteDocument(document.id, state.documents), true);
  state = await harness.store.saveState(state);
  assert.ok(state.documents[0].deletedAt);
  assert.equal(state.documents[0].parseStatus, 'deleted');
  assert.deepEqual(await fs.readdir(harness.store.vaultPath), []);

  const prepared = await harness.store.inspectDocument(fixture, state.documents);
  assert.equal(prepared.duplicate, true);
  assert.equal(prepared.document.id, document.id);

  const backup = path.join(harness.directory, 'tombstone.osmb');
  await harness.store.createPortableBackup(backup, passphrase, state);
  const restored = await harness.store.restorePortableBackup(backup, passphrase);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.documents[0].sha256, document.sha256);
  assert.ok(restored.state.documents[0].deletedAt);
  assert.deepEqual(await fs.readdir(harness.store.vaultPath), []);
});

async function createHarness(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-backup-'));
  if (options.cleanup !== false) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const diagnostics = { events: [], async record(name, context) { this.events.push({ name, context }); } };
  const store = new FinanceDataStore(directory, seedPath, diagnostics, {
    secureStorage: secureStorage(),
    appVersion: '2.1.6',
    faultInjector: options.faultInjector
  });
  await store.initialise();
  return { directory, diagnostics, store };
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}

async function stateWithDocument(harness, name, contents) {
  let state = (await harness.store.loadState()).state;
  state.profile.name = name;
  const fixture = path.join(harness.directory, `${crypto.randomUUID()}.txt`);
  await fs.writeFile(fixture, contents);
  const stored = await harness.store.storeDocument(fixture, 'statement', state.documents);
  state.documents.push(stored.document);
  state = await harness.store.saveState(state);
  return { state, fixture };
}

async function captureLiveDataset(store) {
  const files = new Map();
  files.set('finance-state.json', await fs.readFile(store.statePath));
  if (await exists(store.keyPath)) files.set('vault-key.json', await fs.readFile(store.keyPath));
  for (const name of (await fs.readdir(store.vaultPath)).sort()) files.set(`document-vault/${name}`, await fs.readFile(path.join(store.vaultPath, name)));
  return [...files].map(([name, bytes]) => [name, bytes.toString('hex')]);
}

async function prepareInterruptedRestore(harness, point) {
  harness.store.faultInjector = async (current) => {
    if (current === point) {
      const error = new Error('simulated process interruption');
      error.code = 'SIMULATED_INTERRUPT';
      throw error;
    }
  };
  let state = (await harness.store.loadState()).state;
  state.profile.name = 'Backup state';
  state = await harness.store.saveState(state);
  const source = path.join(harness.directory, 'interrupted.osmb');
  await harness.store.createPortableBackup(source, passphrase, state);
  state.profile.name = 'Current state';
  await harness.store.saveState(state);
  await assert.rejects(harness.store.restorePortableBackup(source, passphrase), { code: 'SIMULATED_INTERRUPT' });
}

async function writeCraftedBackup(destination, password, state, options = {}) {
  const stateBytes = Buffer.from(JSON.stringify(state));
  const files = { 'state.json': stateBytes.toString('base64') };
  const manifestFiles = [{ path: 'state.json', role: 'financial_state', size: stateBytes.length, sha256: digest(stateBytes) }];
  if (options.extraFilePath) {
    files[options.extraFilePath] = '';
    manifestFiles.push({ path: options.extraFilePath, role: 'document', documentId: crypto.randomUUID(), size: 0, sha256: digest(Buffer.alloc(0)) });
  }
  await writeEncryptedPayload(destination, password, {
    formatVersion: 2,
    manifest: {
      manifestVersion: 1,
      backupId: crypto.randomUUID(),
      createdAt: '2026-08-08T12:00:00.000Z',
      applicationVersion: options.applicationVersion || '2.1.6',
      schemaVersion: state.schemaVersion,
      complete: true,
      documentCount: manifestFiles.filter((entry) => entry.role === 'document').length,
      files: manifestFiles
    },
    files
  });
}

async function writeLegacyBackup(destination, password, state, documents) {
  await writeEncryptedPayload(destination, password, { version: 1, createdAt: '2026-08-08T12:00:00.000Z', state, documents }, 'HFB1');
}

async function writeEncryptedPayload(destination, password, payload, magic = 'LFB1') {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  await fs.writeFile(destination, Buffer.concat([Buffer.from(magic), salt, iv, cipher.getAuthTag(), ciphertext]));
}

function fictionalDocumentMetadata() {
  const id = crypto.randomUUID();
  return { id, originalName: 'fictional.txt', storedName: `${id}.vault`, kind: 'statement', mimeType: 'text/plain', size: 10, sha256: '0'.repeat(64), importedAt: '2026-08-08T12:00:00.000Z', parseStatus: 'ready', linkedRecordIds: [], notes: '' };
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

async function exists(target) {
  return fs.lstat(target).then(() => true).catch((error) => error.code === 'ENOENT' ? false : Promise.reject(error));
}
