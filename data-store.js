import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = 'finance-state.json';
const KEY_FILE = 'vault-key.json';
const VAULT_MAGIC = Buffer.from('LFVLT001');
const BACKUP_MAGIC = Buffer.from('LFB1');
const LEGACY_BACKUP_MAGIC = Buffer.from('HFB1');
const PORTABLE_BACKUP_FORMAT_VERSION = 2;
const LOCAL_BACKUP_FORMAT_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 6;
const FRESH_START_CONFIRMATION_MS = 5 * 60 * 1000;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_BACKUP_FILE_BYTES = 128 * 1024 * 1024;
const MAX_BACKUP_ENTRIES = 5000;
const JOURNAL_FILE = 'active-restore.json';
const STATE_COLLECTIONS = Object.freeze([
  'accounts', 'transactions', 'payslips', 'taxDocuments', 'creditReports', 'debts', 'overdrafts',
  'budgets', 'scheduledPayments', 'documents', 'tasks', 'checkIns', 'importBatches'
]);

export const RECOVERY_MODES = Object.freeze({
  NORMAL: 'normal',
  REQUIRED: 'recovery_required',
  RESOLVING: 'resolution_in_progress',
  BACKUP: 'backup_in_progress',
  RESTORE: 'restore_in_progress'
});

export const RESTORE_PHASES = Object.freeze({
  STAGING: 'staging',
  VALIDATED: 'validated',
  ROLLBACK_COPY: 'rollback_copy',
  ROLLBACK_COPY_VERIFIED: 'rollback_copy_verified',
  COMMIT_STARTED: 'commit_started',
  INSTALLED: 'installed',
  VERIFIED: 'verified',
  ROLLBACK_STARTED: 'rollback_started',
  ROLLBACK_VERIFIED: 'rollback_verified',
  COMMITTED: 'committed'
});

export const LOAD_REASON_CODES = Object.freeze({
  STATE_NOT_FOUND: 'state_not_found',
  READ_FAILURE: 'read_failure',
  DECRYPTION_FAILURE: 'decryption_failure',
  ENCRYPTION_KEY_UNAVAILABLE: 'encryption_key_unavailable',
  INVALID_CONTENT: 'invalid_content',
  SCHEMA_VALIDATION_FAILURE: 'schema_validation_failure',
  MIGRATION_FAILURE: 'migration_failure',
  UNKNOWN_STORAGE_FAILURE: 'unknown_storage_failure'
});

export class RecoveryModeError extends Error {
  constructor(mode) {
    super('Saving is paused while financial data recovery is required.');
    this.name = 'RecoveryModeError';
    this.code = 'RECOVERY_MODE_ACTIVE';
    this.result = { status: 'blocked', mode, reasonCode: 'recovery_mode_active' };
  }
}

export class PersistenceBusyError extends Error {
  constructor(mode) {
    const restoring = mode === RECOVERY_MODES.RESTORE;
    super(restoring ? 'A backup restore is already in progress.' : 'A backup or restore operation is already in progress.');
    this.name = 'PersistenceBusyError';
    this.code = restoring ? 'RESTORE_IN_PROGRESS' : 'PERSISTENCE_BUSY';
    this.result = { status: 'blocked', mode, reasonCode: restoring ? 'restore_in_progress' : 'persistence_busy' };
  }
}

class StateLoadError extends Error {
  constructor(reasonCode, cause = null) {
    super(reasonCode);
    this.name = 'StateLoadError';
    this.reasonCode = reasonCode;
    this.cause = cause;
  }
}

export class FinanceDataStore {
  constructor(userDataPath, seedPath, diagnostics = null, options = {}) {
    this.userDataPath = userDataPath;
    this.seedPath = seedPath;
    this.statePath = path.join(userDataPath, STATE_FILE);
    this.vaultPath = path.join(userDataPath, 'document-vault');
    this.backupPath = path.join(userDataPath, 'automatic-backups');
    this.recoveryPath = path.join(userDataPath, 'recovery-copies');
    this.restorePath = path.join(userDataPath, 'restore-transactions');
    this.restoreJournalPath = path.join(this.restorePath, JOURNAL_FILE);
    this.keyPath = path.join(userDataPath, KEY_FILE);
    this.vaultKey = null;
    this.diagnostics = diagnostics;
    this.secureStorage = options.secureStorage;
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    this.migrate = typeof options.migrateState === 'function' ? options.migrateState : migrateState;
    this.appVersion = typeof options.appVersion === 'string' ? options.appVersion : '2.1.8';
    this.faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : async () => {};
    this.mode = RECOVERY_MODES.NORMAL;
    this.recovery = null;
    this.backupCandidates = new Map();
    this.freshStartConfirmation = null;
    this.interruptedRestoreUnresolved = false;
  }

  async initialise() {
    await fs.mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.vaultPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.backupPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.recoveryPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.restorePath, { recursive: true, mode: 0o700 });
    await this.recoverInterruptedRestore();
    await this.cleanupAbandonedBackupTemps();
  }

  encryptionStatus() {
    const available = this.encryptionAvailable();
    return {
      available,
      backend: available ? 'Operating-system protected' : 'Unavailable'
    };
  }

  async loadState() {
    if (this.interruptedRestoreUnresolved && this.mode === RECOVERY_MODES.REQUIRED) {
      await this.refreshRecoveryBackups();
      return this.recoveryResult();
    }
    const inspected = await this.inspectStateFile(this.statePath);
    if (inspected.status === 'not_found') {
      return this.createFirstInstallState();
    }
    if (inspected.status === 'failed') {
      return this.enterRecovery(inspected.reasonCode, inspected.error);
    }

    try {
      await this.loadOrCreateVaultKey({ hasDocuments: inspected.state.documents.length > 0 });
    } catch (error) {
      return this.enterRecovery(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE, error);
    }

    this.clearRecovery();
    return this.normalResult(inspected.state, 'existing');
  }

  async saveState(state) {
    this.assertWritable();
    return this.writeState(state);
  }

  assertWritable() {
    if (this.mode === RECOVERY_MODES.REQUIRED || this.mode === RECOVERY_MODES.RESOLVING) throw new RecoveryModeError(this.mode);
    if (this.mode !== RECOVERY_MODES.NORMAL) throw new PersistenceBusyError(this.mode);
  }

  recoveryStatus() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }

  async retryRecoveryLoad() {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
    if (this.interruptedRestoreUnresolved && await pathExists(this.restoreJournalPath)) return this.recoveryFailure('restore_interrupted');
    this.mode = RECOVERY_MODES.RESOLVING;
    const inspected = await this.inspectStateFile(this.statePath);
    if (inspected.status === 'loaded') {
      try {
        await this.loadOrCreateVaultKey({ hasDocuments: inspected.state.documents.length > 0 });
        this.clearRecovery();
        return this.normalResult(inspected.state, 'existing');
      } catch (error) {
        return this.enterRecovery(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE, error);
      }
    }
    const reasonCode = inspected.status === 'not_found' ? LOAD_REASON_CODES.STATE_NOT_FOUND : inspected.reasonCode;
    return this.enterRecovery(reasonCode, inspected.error);
  }

  async restoreRecoveryBackup(backupId, options = {}) {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
    if (this.interruptedRestoreUnresolved && await pathExists(this.restoreJournalPath)) return this.recoveryFailure('restore_interrupted');
    let candidate = this.backupCandidates.get(String(backupId));
    if (!candidate) {
      await this.refreshRecoveryBackups();
      candidate = this.backupCandidates.get(String(backupId));
    }
    if (!candidate) return this.recoveryFailure('backup_not_found');
    const previousRecoveryReason = this.recovery?.reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE;
    try {
      return await this.withPersistenceMode(RECOVERY_MODES.RESTORE, [RECOVERY_MODES.REQUIRED], async (previousMode) => {
        const decoded = await this.readLocalRestoreCandidate(candidate);
        const result = await this.runRestoreTransaction({
          decoded,
          sourcePath: candidate.path,
          sourceKind: 'local',
          previousMode,
          previousRecoveryReason,
          onProgress: options.onProgress,
          shouldCancel: options.shouldCancel
        });
        if (result.status === 'restored') return this.normalResult(result.state, 'restored_backup');
        return result;
      });
    } catch (error) {
      await this.diagnostics?.record('RECOVERY_OPERATION_FAILED', { error, reasonCode: 'restore_failed' }).catch(() => {});
      return this.recoveryFailure('restore_failed');
    }
  }

  requestFreshStart() {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
    if (this.interruptedRestoreUnresolved) return { status: 'invalid_operation', mode: this.mode, reasonCode: 'restore_interrupted' };
    const token = crypto.randomUUID();
    this.freshStartConfirmation = { token, expiresAt: this.clock().getTime() + FRESH_START_CONFIRMATION_MS };
    return { status: 'confirmation_required', token, expiresAt: new Date(this.freshStartConfirmation.expiresAt).toISOString() };
  }

  cancelFreshStart(token) {
    if (this.freshStartConfirmation?.token === token) this.freshStartConfirmation = null;
    return this.recoveryResult();
  }

  async confirmFreshStart(token) {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
    if (!this.freshStartConfirmation || token !== this.freshStartConfirmation.token || this.clock().getTime() > this.freshStartConfirmation.expiresAt) {
      return this.recoveryFailure('confirmation_invalid');
    }

    this.mode = RECOVERY_MODES.RESOLVING;
    this.freshStartConfirmation = null;
    let originalBytes;
    let installed = false;
    try {
      originalBytes = await fs.readFile(this.statePath);
      if (!this.recovery?.recoveryCopyCreated) {
        const copy = await this.createRecoveryCopy();
        if (!copy.created) throw new StateLoadError('recovery_copy_required');
        this.recovery.recoveryCopyCreated = true;
        this.recovery.recoveryCopyFileName = copy.fileName;
      }
      const seed = await this.readSeedState();
      await this.loadOrCreateVaultKey({ hasDocuments: false });
      await this.writeState(seed, { bypassRecovery: true });
      installed = true;
      const reopened = await this.inspectStateFile(this.statePath);
      if (reopened.status !== 'loaded') throw new StateLoadError(reopened.reasonCode || 'fresh_state_invalid');
      this.clearRecovery();
      return this.normalResult(reopened.state, 'fresh_start');
    } catch (error) {
      if (installed && originalBytes) await atomicWrite(this.statePath, originalBytes).catch(() => {});
      await this.diagnostics?.record('RECOVERY_OPERATION_FAILED', { error, reasonCode: 'fresh_start_failed' }).catch(() => {});
      return this.recoveryFailure('fresh_start_failed');
    }
  }

  async writeState(state, options = {}) {
    if (!options.bypassRecovery) this.assertWritable();
    const clean = this.migrate(structuredClone(state));
    validateMigratedState(clean);
    clean.meta.updatedAt = this.clock().toISOString();
    const json = JSON.stringify(clean);
    const encrypted = this.encryptionAvailable();
    const payload = encrypted
      ? this.secureStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
    await atomicWrite(this.statePath, JSON.stringify({ version: 1, encrypted, payload }));
    return clean;
  }

  async createAutomaticBackup(reason = 'before-change') {
    return this.withPersistenceMode(RECOVERY_MODES.BACKUP, [RECOVERY_MODES.NORMAL], async () => {
      const inspection = await this.inspectStateFile(this.statePath);
      if (inspection.status === 'not_found') return null;
      if (inspection.status !== 'loaded') throw new StateLoadError(inspection.reasonCode || LOAD_REASON_CODES.READ_FAILURE, inspection.error);

      const backupId = crypto.randomUUID();
      const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
      const finalPath = path.join(this.backupPath, `${stamp}-${slug(reason)}-${backupId}.osmb-set`);
      const temporaryPath = path.join(this.backupPath, `.${backupId}.tmp-${crypto.randomUUID()}`);
      try {
        await this.createLocalBackupSet(temporaryPath, {
          backupId,
          purpose: 'automatic_backup',
          state: inspection.state,
          stateBytes: inspection.bytes,
          includeAllVaultFiles: false
        });
        await this.injectFault('backup_before_publish');
        await durableRename(temporaryPath, finalPath);
        return finalPath;
      } catch (error) {
        await fs.rm(temporaryPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async withPersistenceMode(nextMode, allowedModes, operation) {
    const previousMode = this.mode;
    if (!allowedModes.includes(previousMode)) {
      if (previousMode === RECOVERY_MODES.REQUIRED || previousMode === RECOVERY_MODES.RESOLVING) throw new RecoveryModeError(previousMode);
      throw new PersistenceBusyError(previousMode);
    }
    this.mode = nextMode;
    try {
      return await operation(previousMode);
    } finally {
      if (this.mode === nextMode) this.mode = previousMode;
    }
  }

  async injectFault(point) {
    await this.faultInjector(point);
  }

  encryptionAvailable() {
    try {
      return Boolean(this.secureStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  normalResult(state, source) {
    return {
      status: 'normal',
      mode: RECOVERY_MODES.NORMAL,
      source,
      state,
      encryption: this.encryptionStatus()
    };
  }

  recoveryResult() {
    return {
      status: 'recovery_required',
      mode: RECOVERY_MODES.REQUIRED,
      recovery: this.recoveryStatus(),
      encryption: this.encryptionStatus()
    };
  }

  recoveryFailure(reasonCode) {
    this.mode = RECOVERY_MODES.REQUIRED;
    if (this.recovery) this.recovery.lastOperationError = reasonCode;
    return this.recoveryResult();
  }

  clearRecovery() {
    this.mode = RECOVERY_MODES.NORMAL;
    this.recovery = null;
    this.backupCandidates.clear();
    this.freshStartConfirmation = null;
  }

  async createFirstInstallState() {
    const seed = await this.readSeedState();
    await this.loadOrCreateVaultKey({ hasDocuments: false });
    const saved = await this.writeState(seed, { bypassRecovery: true });
    const reopened = await this.inspectStateFile(this.statePath);
    if (reopened.status !== 'loaded') throw new StateLoadError(reopened.reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE);
    this.clearRecovery();
    return this.normalResult(saved, 'first_install');
  }

  async readSeedState() {
    const seed = JSON.parse(await fs.readFile(this.seedPath, 'utf8'));
    validateStoredState(seed);
    let migrated;
    try {
      migrated = this.migrate(structuredClone(seed));
    } catch (error) {
      throw new StateLoadError(LOAD_REASON_CODES.MIGRATION_FAILURE, error);
    }
    validateMigratedState(migrated);
    return migrated;
  }

  async inspectStateFile(target) {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if (error.code === 'ENOENT') return { status: 'not_found' };
      return { status: 'failed', reasonCode: LOAD_REASON_CODES.READ_FAILURE, error };
    }
    if (!stat.isFile()) {
      return { status: 'failed', reasonCode: LOAD_REASON_CODES.READ_FAILURE, error: new Error('State path is not a regular file.') };
    }

    let bytes;
    try {
      bytes = await fs.readFile(target);
    } catch (error) {
      return { status: 'failed', reasonCode: LOAD_REASON_CODES.READ_FAILURE, error };
    }

    try {
      const envelope = parseJson(bytes.toString('utf8'), LOAD_REASON_CODES.INVALID_CONTENT);
      if (!isPlainObject(envelope) || envelope.version !== 1 || typeof envelope.encrypted !== 'boolean' || !isCanonicalBase64(envelope.payload)) {
        throw new StateLoadError(LOAD_REASON_CODES.INVALID_CONTENT);
      }

      let serialised;
      if (envelope.encrypted) {
        if (!this.encryptionAvailable()) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
        try {
          serialised = this.secureStorage.decryptString(Buffer.from(envelope.payload, 'base64'));
        } catch (error) {
          throw new StateLoadError(classifyDecryptionFailure(error), error);
        }
      } else {
        serialised = Buffer.from(envelope.payload, 'base64').toString('utf8');
      }

      const stored = parseJson(serialised, LOAD_REASON_CODES.INVALID_CONTENT);
      validateStoredState(stored);
      let migrated;
      try {
        migrated = this.migrate(structuredClone(stored));
      } catch (error) {
        throw new StateLoadError(LOAD_REASON_CODES.MIGRATION_FAILURE, error);
      }
      validateMigratedState(migrated);
      return { status: 'loaded', state: migrated, bytes, schemaVersion: migrated.schemaVersion };
    } catch (error) {
      const failure = error instanceof StateLoadError
        ? error
        : new StateLoadError(LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE, error);
      return { status: 'failed', reasonCode: failure.reasonCode, error: failure.cause || failure };
    }
  }

  async enterRecovery(reasonCode, error = null) {
    this.mode = RECOVERY_MODES.REQUIRED;
    this.freshStartConfirmation = null;
    const copy = await this.createRecoveryCopy();
    this.recovery = {
      reasonCode: reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE,
      recoveryCopyCreated: copy.created,
      recoveryCopyFileName: copy.created ? copy.fileName : null,
      backupDiscoveryFailed: false,
      backups: [],
      lastOperationError: null
    };
    await this.refreshRecoveryBackups();
    await this.diagnostics?.record('STATE_RECOVERY_REQUIRED', {
      error,
      reasonCode: this.recovery.reasonCode
    }).catch(() => {});
    return this.recoveryResult();
  }

  async createRecoveryCopy() {
    const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
    const fileName = `finance-state.recovery-${stamp}-${crypto.randomUUID()}.json`;
    const destination = path.join(this.recoveryPath, fileName);
    try {
      await fs.copyFile(this.statePath, destination, fsConstants.COPYFILE_EXCL);
      const [original, copy] = await Promise.all([fs.readFile(this.statePath), fs.readFile(destination)]);
      if (sha256(original) !== sha256(copy)) {
        await fs.unlink(destination).catch(() => {});
        return { created: false, fileName: null };
      }
      return { created: true, fileName };
    } catch {
      return { created: false, fileName: null };
    }
  }

  async refreshRecoveryBackups() {
    this.backupCandidates.clear();
    try {
      const entries = await fs.readdir(this.backupPath, { withFileTypes: true });
      const backups = [];
      for (const entry of entries) {
        const target = path.join(this.backupPath, entry.name);
        const id = sha256(Buffer.from(entry.name, 'utf8')).slice(0, 24);
        if (entry.isDirectory() && entry.name.endsWith('.osmb-set')) {
          try {
            const inspection = await this.validateLocalBackupSet(target, { requireSemanticValidation: true });
            const descriptor = localBackupDescriptor(id, inspection);
            this.backupCandidates.set(id, { type: 'local_set', path: target, descriptor });
            backups.push(descriptor);
          } catch (error) {
            backups.push(invalidBackupDescriptor(id, (await fs.stat(target)).mtime.toISOString(), safeRestoreReason(error)));
          }
          continue;
        }
        if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.json') {
          const [inspection, stat] = await Promise.all([this.inspectStateFile(target), fs.stat(target)]);
          const complete = inspection.status === 'loaded' && inspection.state.documents.length === 0;
          const descriptor = {
            id,
            createdAt: stat.mtime.toISOString(),
            valid: complete,
            compatible: complete,
            complete,
            classification: inspection.status === 'loaded' ? (complete ? 'legacy_complete' : 'legacy_state_only') : 'corrupt',
            schemaVersion: inspection.status === 'loaded' ? inspection.schemaVersion : null,
            applicationVersion: null,
            documentCount: inspection.status === 'loaded' ? inspection.state.documents.length : null,
            migrationRequired: false,
            reasonCode: complete ? null : inspection.status === 'loaded' ? 'legacy_state_only' : inspection.reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE
          };
          if (complete) this.backupCandidates.set(id, { type: 'legacy_state', path: target, descriptor, inspection });
          backups.push(descriptor);
        }
      }
      backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      if (this.recovery) {
        this.recovery.backups = backups;
        this.recovery.backupDiscoveryFailed = false;
      }
    } catch (error) {
      if (this.recovery) {
        this.recovery.backups = [];
        this.recovery.backupDiscoveryFailed = true;
      }
      await this.diagnostics?.record('RECOVERY_OPERATION_FAILED', { error, reasonCode: 'backup_discovery_failed' }).catch(() => {});
    }
  }

  async readLocalRestoreCandidate(candidate) {
    if (candidate.type === 'local_set') {
      const inspected = await this.validateLocalBackupSet(candidate.path, { requireSemanticValidation: true });
      const files = new Map([['state.json', Buffer.from(JSON.stringify(inspected.state), 'utf8')]]);
      const key = await this.readVaultKeyAt(path.join(candidate.path, 'data', KEY_FILE), inspected.state.documents.length > 0);
      for (const document of inspected.state.documents) {
        const encrypted = await fs.readFile(path.join(candidate.path, 'data', 'document-vault', document.storedName));
        files.set(`documents/${document.id}.bin`, decryptVaultBytesWithKey(encrypted, key));
      }
      return {
        formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
        classification: inspected.classification,
        complete: true,
        valid: true,
        manifest: buildPortableManifest({
          backupId: inspected.manifest.backupId,
          createdAt: inspected.manifest.createdAt,
          applicationVersion: inspected.manifest.applicationVersion,
          schemaVersion: inspected.state.schemaVersion,
          documents: inspected.state.documents,
          files
        }),
        files,
        state: inspected.state,
        sourceFingerprint: inspected.sourceFingerprint
      };
    }
    if (candidate.type === 'legacy_state' && candidate.inspection?.status === 'loaded' && candidate.inspection.state.documents.length === 0) {
      const state = candidate.inspection.state;
      const files = new Map([['state.json', Buffer.from(JSON.stringify(state), 'utf8')]]);
      return {
        formatVersion: 1,
        classification: 'legacy_complete',
        complete: true,
        valid: true,
        manifest: buildPortableManifest({
          backupId: candidate.descriptor.id,
          createdAt: candidate.descriptor.createdAt,
          applicationVersion: null,
          schemaVersion: state.schemaVersion,
          documents: [],
          files
        }),
        files,
        state,
        sourceFingerprint: sha256(candidate.inspection.bytes)
      };
    }
    throw new Error('The selected recovery backup is incomplete.');
  }

  async storeDocument(filePath, kind, existingDocuments = []) {
    this.assertWritable();
    if (!this.encryptionAvailable() || !this.vaultKey) {
      throw new Error('Secure document storage is unavailable on this device.');
    }

    const bytes = await fs.readFile(filePath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const duplicate = existingDocuments.find((document) => document.sha256 === digest);
    if (duplicate) {
      return { document: duplicate, duplicate: true };
    }

    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.vaultKey, iv);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedBytes = Buffer.concat([VAULT_MAGIC, iv, tag, ciphertext]);
    const storedName = `${id}.vault`;
    await atomicWrite(path.join(this.vaultPath, storedName), encryptedBytes);

    return {
      duplicate: false,
      document: {
        id,
        originalName: path.basename(filePath),
        storedName,
        kind,
        mimeType: mimeFromName(filePath),
        size: bytes.length,
        sha256: digest,
        importedAt: this.clock().toISOString(),
        parseStatus: 'pending',
        linkedRecordIds: [],
        notes: ''
      }
    };
  }

  async readDocument(id, documents) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Invalid document identifier.');
    const document = documents.find((entry) => entry.id === id);
    if (!document) throw new Error('Document not found.');
    const encrypted = await fs.readFile(path.join(this.vaultPath, document.storedName));
    return { document, bytes: this.decryptVaultBytes(encrypted) };
  }

  async deleteDocument(id, documents) {
    this.assertWritable();
    const document = documents.find((entry) => entry.id === id);
    if (!document) return false;
    await fs.unlink(path.join(this.vaultPath, document.storedName)).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    return true;
  }

  async createPortableBackup(destination, passphrase, state) {
    requirePassphrase(passphrase);
    return this.withPersistenceMode(RECOVERY_MODES.BACKUP, [RECOVERY_MODES.NORMAL], async () => {
      const inspected = await this.inspectStateFile(this.statePath);
      if (inspected.status !== 'loaded') throw new Error('The current financial state could not be verified for backup.');
      const snapshotState = structuredClone(inspected.state);
      if (state && JSON.stringify(state) !== JSON.stringify(snapshotState)) {
        throw new Error('The financial state changed before the backup snapshot could begin.');
      }
      const createdAt = this.clock().toISOString();
      const backupId = crypto.randomUUID();
      const files = new Map();
      files.set('state.json', Buffer.from(JSON.stringify(snapshotState), 'utf8'));
      for (const document of snapshotState.documents) {
        validateDocumentMetadata(document);
        const { bytes } = await this.readDocument(document.id, snapshotState.documents);
        if (bytes.length !== document.size || sha256(bytes) !== document.sha256) {
          throw new Error('A saved document did not pass backup integrity checks.');
        }
        files.set(`documents/${document.id}.bin`, bytes);
      }
      const manifest = buildPortableManifest({
        backupId,
        createdAt,
        applicationVersion: this.appVersion,
        schemaVersion: snapshotState.schemaVersion,
        documents: snapshotState.documents,
        files
      });
      const payload = Buffer.from(JSON.stringify({
        formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
        manifest,
        files: Object.fromEntries([...files].map(([name, bytes]) => [name, bytes.toString('base64')]))
      }), 'utf8');
      if (payload.length > MAX_BACKUP_BYTES) throw new Error('The backup is too large to create safely.');
      const encrypted = encryptPortablePayload(payload, passphrase);
      const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' });
        await syncFile(temporary);
        const verified = await this.readPortableBackup(temporary, passphrase);
        if (!verified.complete || verified.manifest.backupId !== backupId) throw new Error('The completed backup could not be verified.');
        await this.injectFault('portable_backup_before_publish');
        await durableRename(temporary, destination);
        return this.portableBackupDescriptor(verified);
      } catch (error) {
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    });
  }

  async inspectPortableBackup(source, passphrase) {
    requirePassphrase(passphrase);
    const decoded = await this.readPortableBackup(source, passphrase);
    return this.portableBackupDescriptor(decoded);
  }

  async restorePortableBackup(source, passphrase, options = {}) {
    requirePassphrase(passphrase);
    if (options.allowRecovery && this.interruptedRestoreUnresolved && await pathExists(this.restoreJournalPath)) {
      throw new Error('An interrupted restore must be resolved before another restore can begin.');
    }
    const allowedModes = options.allowRecovery ? [RECOVERY_MODES.NORMAL, RECOVERY_MODES.REQUIRED] : [RECOVERY_MODES.NORMAL];
    return this.withPersistenceMode(RECOVERY_MODES.RESTORE, allowedModes, async (previousMode) => {
      const decoded = await this.readPortableBackup(source, passphrase);
      if (options.expectedFingerprint && options.expectedFingerprint !== decoded.sourceFingerprint) {
        throw new Error('The selected backup changed after it was checked. Select it again.');
      }
      if (!decoded.complete) throw new Error('This legacy backup does not contain a complete financial state and document vault.');
      return this.runRestoreTransaction({
        decoded,
        sourcePath: source,
        sourceKind: 'portable',
        previousMode,
        previousRecoveryReason: previousMode === RECOVERY_MODES.REQUIRED ? (options.previousRecoveryReason || this.recovery?.reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE) : null,
        onProgress: options.onProgress,
        shouldCancel: options.shouldCancel
      });
    });
  }

  portableBackupDescriptor(decoded) {
    return {
      backupId: decoded.manifest.backupId,
      formatVersion: decoded.formatVersion,
      classification: decoded.classification,
      complete: decoded.complete,
      valid: decoded.valid,
      createdAt: decoded.manifest.createdAt,
      applicationVersion: decoded.manifest.applicationVersion || null,
      schemaVersion: decoded.manifest.schemaVersion,
      documentCount: decoded.manifest.documentCount,
      migrationRequired: decoded.manifest.schemaVersion < CURRENT_SCHEMA_VERSION,
      sourceFingerprint: decoded.sourceFingerprint
    };
  }

  async readPortableBackup(source, passphrase) {
    const stat = await regularFileStat(source, 'The selected backup is not a regular file.');
    if (stat.size < 49 || stat.size > MAX_BACKUP_BYTES) throw new Error('The selected backup has an unsafe or unsupported size.');
    const contents = await fs.readFile(source);
    const sourceFingerprint = sha256(contents);
    const magic = contents.subarray(0, 4);
    if (!magic.equals(BACKUP_MAGIC) && !magic.equals(LEGACY_BACKUP_MAGIC)) throw new Error('This is not a supported OneStep Money backup.');
    const decrypted = decryptPortablePayload(contents, passphrase);
    if (decrypted.length > MAX_BACKUP_BYTES) throw new Error('The selected backup expands beyond the safe size limit.');
    const payload = parseJson(decrypted.toString('utf8'), 'backup_invalid');

    if (payload?.formatVersion === PORTABLE_BACKUP_FORMAT_VERSION) {
      const manifest = validatePortableManifest(payload.manifest, this.appVersion);
      const files = decodePortableFiles(payload.files, manifest);
      const state = this.validatePortableState(files.get('state.json'), manifest.schemaVersion);
      validatePortableDocumentSet(state, manifest, files);
      return {
        formatVersion: PORTABLE_BACKUP_FORMAT_VERSION,
        classification: manifest.schemaVersion < CURRENT_SCHEMA_VERSION ? 'complete_migration_required' : 'complete_valid',
        complete: true,
        valid: true,
        manifest,
        files,
        state,
        sourceFingerprint
      };
    }

    if (isPlainObject(payload) && payload.formatVersion !== undefined) throw new Error('This backup uses an unsupported format version.');

    return this.readLegacyPortableBackup(payload, magic, sourceFingerprint);
  }

  readLegacyPortableBackup(payload, magic, sourceFingerprint) {
    if (!isPlainObject(payload) || !payload.state) throw new Error('The legacy backup is incomplete.');
    const state = this.validatePortableState(Buffer.from(JSON.stringify(payload.state), 'utf8'));
    const legacyDocuments = Array.isArray(payload.documents) ? payload.documents : [];
    const files = new Map([['state.json', Buffer.from(JSON.stringify(state), 'utf8')]]);
    const documentsById = new Map();
    for (const entry of legacyDocuments) {
      if (!isPlainObject(entry) || !isPlainObject(entry.metadata) || !isCanonicalBase64(entry.contents)) throw new Error('The legacy backup contains an invalid document entry.');
      validateDocumentMetadata(entry.metadata);
      if (documentsById.has(entry.metadata.id)) throw new Error('The legacy backup contains duplicate document entries.');
      const bytes = Buffer.from(entry.contents, 'base64');
      if (bytes.length > MAX_BACKUP_FILE_BYTES || bytes.length !== entry.metadata.size || sha256(bytes) !== entry.metadata.sha256) {
        throw new Error('A document in the legacy backup failed integrity checks.');
      }
      documentsById.set(entry.metadata.id, entry.metadata);
      files.set(`documents/${entry.metadata.id}.bin`, bytes);
    }
    const expectedIds = new Set(state.documents.map((document) => {
      validateDocumentMetadata(document);
      return document.id;
    }));
    const complete = expectedIds.size === documentsById.size && [...expectedIds].every((id) => documentsById.has(id));
    const createdAt = validIsoDate(payload.createdAt) ? payload.createdAt : this.clock().toISOString();
    const backupId = `legacy-${sourceFingerprint.slice(0, 24)}`;
    const manifest = buildPortableManifest({
      backupId,
      createdAt,
      applicationVersion: null,
      schemaVersion: state.schemaVersion,
      documents: state.documents,
      files
    });
    return {
      formatVersion: 1,
      classification: complete ? 'legacy_complete' : state.documents.length ? 'legacy_state_only' : 'legacy_complete',
      complete: complete || state.documents.length === 0,
      valid: true,
      manifest,
      files,
      state,
      sourceFingerprint,
      legacyMagic: magic.toString('ascii')
    };
  }

  validatePortableState(bytes, expectedSchemaVersion = null) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BACKUP_FILE_BYTES) throw new Error('The backup financial state has an unsafe size.');
    const stored = parseJson(bytes.toString('utf8'), LOAD_REASON_CODES.INVALID_CONTENT);
    validateStoredState(stored);
    if (expectedSchemaVersion !== null && stored.schemaVersion !== expectedSchemaVersion) throw new Error('The backup schema does not match its manifest.');
    let migrated;
    try {
      migrated = this.migrate(structuredClone(stored));
    } catch (error) {
      throw new StateLoadError(LOAD_REASON_CODES.MIGRATION_FAILURE, error);
    }
    validateMigratedState(migrated);
    return migrated;
  }

  async createLocalBackupSet(destination, options) {
    const dataPath = path.join(destination, 'data');
    const targetVault = path.join(dataPath, 'document-vault');
    await fs.mkdir(targetVault, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(dataPath, STATE_FILE), options.stateBytes, { mode: 0o600, flag: 'wx' });

    const documentFiles = new Set();
    if (options.includeAllVaultFiles) {
      for (const entry of await fs.readdir(this.vaultPath, { withFileTypes: true })) {
        if (!entry.isFile()) throw new Error('The document vault contains an unsafe path redirection.');
        documentFiles.add(entry.name);
      }
    } else {
      for (const document of options.state.documents) {
        validateDocumentMetadata(document);
        documentFiles.add(document.storedName);
      }
    }

    if (documentFiles.size > MAX_BACKUP_ENTRIES) throw new Error('The document vault contains too many files to back up safely.');
    for (const fileName of documentFiles) {
      validateVaultFileName(fileName);
      await copyVerifiedFile(path.join(this.vaultPath, fileName), path.join(targetVault, fileName));
    }
    if (documentFiles.size) await copyVerifiedFile(this.keyPath, path.join(dataPath, KEY_FILE));

    const manifest = await buildLocalManifest(dataPath, {
      backupId: options.backupId,
      createdAt: this.clock().toISOString(),
      applicationVersion: this.appVersion,
      schemaVersion: options.state.schemaVersion,
      documentCount: options.state.documents.length,
      purpose: options.purpose
    });
    await atomicWrite(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
    await this.validateLocalBackupSet(destination, { requireSemanticValidation: options.purpose !== 'pre_restore_safety' });
    return manifest;
  }

  async validateLocalBackupSet(setPath, options = {}) {
    const rootStat = await fs.lstat(setPath).catch(() => null);
    if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The backup set is not a safe directory.');
    const manifestPath = path.join(setPath, 'manifest.json');
    const manifestStat = await regularFileStat(manifestPath, 'The backup manifest is missing or unsafe.');
    if (manifestStat.size > 2_000_000) throw new Error('The backup manifest is too large.');
    const manifest = validateLocalManifest(parseJson(await fs.readFile(manifestPath, 'utf8'), 'backup_manifest_invalid'), this.appVersion);
    const dataPath = path.join(setPath, 'data');
    const actualFiles = await listRegularFiles(dataPath);
    const expectedPaths = new Set(manifest.files.map((entry) => entry.path));
    if (actualFiles.length !== expectedPaths.size || actualFiles.some((relative) => !expectedPaths.has(relative))) {
      throw new Error('The backup set contains missing or unexpected files.');
    }
    let totalSize = 0;
    for (const entry of manifest.files) {
      const target = resolveSafeChild(dataPath, entry.path);
      const stat = await regularFileStat(target, 'A backup file is missing or unsafe.');
      totalSize += stat.size;
      if (stat.size !== entry.size || stat.size > MAX_BACKUP_FILE_BYTES) throw new Error('A backup file has an invalid size.');
      if (sha256(await fs.readFile(target)) !== entry.sha256) throw new Error('A backup file failed its checksum check.');
    }
    if (totalSize > MAX_BACKUP_BYTES) throw new Error('The backup set exceeds the safe size limit.');

    let state = null;
    if (options.requireSemanticValidation !== false) {
      state = await this.validateDatasetSemantics(dataPath, manifest);
    }
    return {
      valid: true,
      complete: manifest.complete,
      classification: manifest.schemaVersion < CURRENT_SCHEMA_VERSION ? 'complete_migration_required' : 'complete_valid',
      manifest,
      state,
      sourceFingerprint: sha256(Buffer.from(JSON.stringify(manifest), 'utf8'))
    };
  }

  async validateDatasetSemantics(dataPath, manifest) {
    const stateEntry = manifest.files.find((entry) => entry.role === 'financial_state');
    if (!stateEntry || stateEntry.path !== STATE_FILE) throw new Error('The backup does not contain its financial state.');
    const inspected = await this.inspectStateFile(path.join(dataPath, stateEntry.path));
    if (inspected.status !== 'loaded') throw new StateLoadError(inspected.reasonCode || LOAD_REASON_CODES.INVALID_CONTENT, inspected.error);
    if (inspected.state.schemaVersion !== CURRENT_SCHEMA_VERSION) throw new Error('The backup financial state could not be migrated safely.');
    if (manifest.documentCount !== inspected.state.documents.length) throw new Error('The backup document count does not match its financial state.');

    const vaultKey = await this.readVaultKeyAt(path.join(dataPath, KEY_FILE), inspected.state.documents.length > 0);
    const expectedDocumentFiles = new Set();
    for (const document of inspected.state.documents) {
      validateDocumentMetadata(document);
      const relative = `document-vault/${document.storedName}`;
      expectedDocumentFiles.add(relative);
      const manifestEntry = manifest.files.find((entry) => entry.role === 'document' && entry.documentId === document.id && entry.path === relative);
      if (!manifestEntry) throw new Error('The backup is missing a document mapping.');
      const encrypted = await fs.readFile(resolveSafeChild(dataPath, relative));
      const bytes = decryptVaultBytesWithKey(encrypted, vaultKey);
      if (bytes.length !== document.size || sha256(bytes) !== document.sha256) throw new Error('A backed-up document failed authenticated validation.');
    }
    const manifestDocumentFiles = manifest.files.filter((entry) => entry.role === 'document').map((entry) => entry.path);
    if (manifestDocumentFiles.length !== expectedDocumentFiles.size || manifestDocumentFiles.some((file) => !expectedDocumentFiles.has(file))) {
      throw new Error('The backup contains an orphaned document file.');
    }
    return inspected.state;
  }

  async readVaultKeyAt(keyPath, required) {
    if (!required) return null;
    if (!this.encryptionAvailable()) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    let stored;
    try {
      stored = parseJson(await fs.readFile(keyPath, 'utf8'), LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    } catch (error) {
      throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE, error);
    }
    if (!isPlainObject(stored) || stored.version !== 1 || !isCanonicalBase64(stored.encryptedKey)) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    let key;
    try {
      key = Buffer.from(this.secureStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')), 'base64');
    } catch (error) {
      throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE, error);
    }
    if (key.length !== 32) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    return key;
  }

  encodeStateEnvelope(state) {
    validateMigratedState(state);
    const json = JSON.stringify(state);
    const encrypted = this.encryptionAvailable();
    const payload = encrypted
      ? this.secureStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
    return Buffer.from(JSON.stringify({ version: 1, encrypted, payload }), 'utf8');
  }

  encryptVaultBytes(bytes, key = this.vaultKey) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.concat([VAULT_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  }

  async createStagedDataset(destination, decoded) {
    await fs.mkdir(path.join(destination, 'data', 'document-vault'), { recursive: true, mode: 0o700 });
    if (decoded.state.documents.length && !this.encryptionAvailable()) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    const stagingVaultKey = this.encryptionAvailable() ? crypto.randomBytes(32) : null;
    const stateBytes = this.encodeStateEnvelope(decoded.state);
    await fs.writeFile(path.join(destination, 'data', STATE_FILE), stateBytes, { mode: 0o600, flag: 'wx' });
    for (const document of decoded.state.documents) {
      validateDocumentMetadata(document);
      const contents = decoded.files.get(`documents/${document.id}.bin`);
      if (!contents) throw new Error('The selected backup is missing a required document.');
      const encrypted = this.encryptVaultBytes(contents, stagingVaultKey);
      await fs.writeFile(path.join(destination, 'data', 'document-vault', document.storedName), encrypted, { mode: 0o600, flag: 'wx' });
    }
    if (stagingVaultKey) {
      const encryptedKey = this.secureStorage.encryptString(stagingVaultKey.toString('base64')).toString('base64');
      await fs.writeFile(path.join(destination, 'data', KEY_FILE), JSON.stringify({ version: 1, encryptedKey }), { mode: 0o600, flag: 'wx' });
    }
    const manifest = await buildLocalManifest(path.join(destination, 'data'), {
      backupId: decoded.manifest.backupId,
      createdAt: decoded.manifest.createdAt,
      applicationVersion: decoded.manifest.applicationVersion || this.appVersion,
      schemaVersion: decoded.state.schemaVersion,
      documentCount: decoded.state.documents.length,
      purpose: 'restore_staging'
    });
    await atomicWrite(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
    return this.validateLocalBackupSet(destination, { requireSemanticValidation: true });
  }

  async runRestoreTransaction(options) {
    const transactionId = crypto.randomUUID();
    const transactionPath = path.join(this.restorePath, transactionId);
    const journal = {
      formatVersion: 1,
      transactionId,
      backupId: options.decoded.manifest.backupId,
      phase: RESTORE_PHASES.STAGING,
      previousMode: options.previousMode,
      previousRecoveryReason: options.previousRecoveryReason || null,
      stagingVerified: false,
      rollbackVerified: false,
      commitStep: 0,
      postInstallVerified: false,
      rollbackCompleted: false,
      updatedAt: this.clock().toISOString()
    };
    let commitStarted = false;
    await fs.mkdir(transactionPath, { recursive: false, mode: 0o700 });

    const progress = async (stage, canCancel = false) => {
      await options.onProgress?.({ stage, canCancel });
      if (canCancel && await options.shouldCancel?.()) {
        const error = new Error('The restore was cancelled before live data was changed.');
        error.code = 'RESTORE_CANCELLED';
        throw error;
      }
    };

    try {
      await this.writeRestoreJournal(journal);
      await progress('preparing_backup', true);
      if (options.sourceKind === 'portable') {
        await copyVerifiedFile(options.sourcePath, path.join(transactionPath, 'selected-backup.osmb'));
      }
      await this.injectFault('restore_during_staging');
      await progress('checking_backup_integrity', true);
      await this.createStagedDataset(path.join(transactionPath, 'staging'), options.decoded);
      journal.phase = RESTORE_PHASES.VALIDATED;
      journal.stagingVerified = true;
      await this.writeRestoreJournal(journal);
      await this.injectFault('restore_after_validation');

      await progress('creating_safety_copy', true);
      journal.phase = RESTORE_PHASES.ROLLBACK_COPY;
      await this.writeRestoreJournal(journal);
      await this.createExactSafetySnapshot(path.join(transactionPath, 'rollback'), options.previousMode);
      journal.phase = RESTORE_PHASES.ROLLBACK_COPY_VERIFIED;
      journal.rollbackVerified = true;
      await this.writeRestoreJournal(journal);
      await this.injectFault('restore_after_safety_copy');
      await progress('ready_to_replace', true);

      commitStarted = true;
      await this.installStagedDataset(transactionPath, journal, progress);
      await this.injectFault('restore_before_verification');
      await progress('verifying_restored_data', false);
      const verified = await this.validateInstalledDataset(path.join(transactionPath, 'staging', 'manifest.json'));
      journal.phase = RESTORE_PHASES.VERIFIED;
      journal.postInstallVerified = true;
      await this.writeRestoreJournal(journal);
      await this.injectFault('restore_after_verification');

      journal.phase = RESTORE_PHASES.COMMITTED;
      await this.writeRestoreJournal(journal);
      await progress('finishing', false);
      const safetyCopy = await this.publishSafetyCopy(transactionPath, journal);
      await this.cleanupResolvedTransaction(transactionPath);
      this.clearRecovery();
      this.interruptedRestoreUnresolved = false;
      return { status: 'restored', state: verified.state, backupId: journal.backupId, safetyCopy };
    } catch (error) {
      if (error?.code === 'SIMULATED_INTERRUPT') {
        this.setRestoreRecovery('restore_interrupted', 'restore_interrupted');
        throw error;
      }
      if (!commitStarted) {
        await this.cleanupResolvedTransaction(transactionPath).catch(async (cleanupError) => {
          await this.recordRestoreDiagnostic('restore_cleanup_failed', cleanupError);
        });
        throw error;
      }
      return this.rollbackRestoreTransaction(transactionPath, journal, error);
    }
  }

  async createExactSafetySnapshot(destination, previousMode) {
    const dataPath = path.join(destination, 'data');
    await fs.mkdir(path.join(dataPath, 'document-vault'), { recursive: true, mode: 0o700 });
    await copyVerifiedFile(this.statePath, path.join(dataPath, STATE_FILE));
    const entries = await fs.readdir(this.vaultPath, { withFileTypes: true });
    if (entries.length > MAX_BACKUP_ENTRIES) throw new Error('The live document vault is too large to snapshot safely.');
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('The live document vault contains an unsafe path redirection.');
      validateVaultFileName(entry.name);
      await copyVerifiedFile(path.join(this.vaultPath, entry.name), path.join(dataPath, 'document-vault', entry.name));
    }
    const keyStat = await fs.lstat(this.keyPath).catch((error) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (keyStat) {
      if (!keyStat.isFile() || keyStat.isSymbolicLink()) throw new Error('The live vault key path is unsafe.');
      await copyVerifiedFile(this.keyPath, path.join(dataPath, KEY_FILE));
    }
    const inspected = await this.inspectStateFile(this.statePath);
    const state = inspected.status === 'loaded' ? inspected.state : null;
    if (previousMode === RECOVERY_MODES.NORMAL && !state) throw new Error('The current financial state could not be verified before restore.');
    const manifest = await buildLocalManifest(dataPath, {
      backupId: crypto.randomUUID(),
      createdAt: this.clock().toISOString(),
      applicationVersion: this.appVersion,
      schemaVersion: state?.schemaVersion ?? null,
      documentCount: state?.documents.length ?? null,
      purpose: 'pre_restore_safety'
    });
    await atomicWrite(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
    await this.validateLocalBackupSet(destination, { requireSemanticValidation: previousMode === RECOVERY_MODES.NORMAL });
    return manifest;
  }

  async installStagedDataset(transactionPath, journal, progress) {
    const stagingData = path.join(transactionPath, 'staging', 'data');
    const displaced = path.join(transactionPath, 'displaced-live');
    await fs.mkdir(displaced, { recursive: true, mode: 0o700 });
    journal.phase = RESTORE_PHASES.COMMIT_STARTED;
    journal.commitStep = 0;
    await this.writeRestoreJournal(journal);
    await this.injectFault('restore_before_live_replacement');

    await movePathIfPresent(this.statePath, path.join(displaced, STATE_FILE));
    journal.commitStep = 1;
    await this.writeRestoreJournal(journal);
    await this.injectFault('restore_after_live_state_displaced');
    await movePathIfPresent(this.vaultPath, path.join(displaced, 'document-vault'));
    journal.commitStep = 2;
    await this.writeRestoreJournal(journal);
    await movePathIfPresent(this.keyPath, path.join(displaced, KEY_FILE));
    journal.commitStep = 3;
    await this.writeRestoreJournal(journal);

    await progress('restoring_financial_data', false);
    await durableRename(path.join(stagingData, STATE_FILE), this.statePath);
    journal.commitStep = 4;
    await this.writeRestoreJournal(journal);
    await this.injectFault('restore_after_state_install');
    await progress('restoring_documents', false);
    await durableRename(path.join(stagingData, 'document-vault'), this.vaultPath);
    journal.commitStep = 5;
    await this.writeRestoreJournal(journal);
    const stagedKey = path.join(stagingData, KEY_FILE);
    if (await pathExists(stagedKey)) await durableRename(stagedKey, this.keyPath);
    journal.commitStep = 6;
    journal.phase = RESTORE_PHASES.INSTALLED;
    await this.writeRestoreJournal(journal);
    await this.injectFault('restore_after_document_install');
  }

  async validateInstalledDataset(manifestPath) {
    const manifest = validateLocalManifest(parseJson(await fs.readFile(manifestPath, 'utf8'), 'backup_manifest_invalid'), this.appVersion);
    for (const entry of manifest.files) {
      const target = resolveSafeChild(this.userDataPath, entry.path);
      const stat = await regularFileStat(target, 'A restored file is missing or unsafe.');
      if (stat.size !== entry.size || sha256(await fs.readFile(target)) !== entry.sha256) throw new Error('The installed restore does not match the validated staging set.');
    }
    const expectedVault = new Set(manifest.files.filter((entry) => entry.role === 'document').map((entry) => path.basename(entry.path)));
    const actualVault = new Set((await fs.readdir(this.vaultPath, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name));
    if (expectedVault.size !== actualVault.size || [...expectedVault].some((name) => !actualVault.has(name))) throw new Error('The installed document vault contains a mixed file set.');
    const state = await this.validateDatasetSemantics(this.userDataPath, manifest);
    await this.loadInstalledVaultKey(state.documents.length > 0);
    return { manifest, state };
  }

  async loadInstalledVaultKey(required) {
    if (!await pathExists(this.keyPath)) {
      this.vaultKey = null;
      if (required) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
      return;
    }
    this.vaultKey = await this.readVaultKeyAt(this.keyPath, true);
  }

  async rollbackRestoreTransaction(transactionPath, journal, originalError) {
    try {
      journal.phase = RESTORE_PHASES.ROLLBACK_STARTED;
      await this.writeRestoreJournal(journal);
      await this.injectFault('restore_during_rollback');
      const rollbackSource = path.join(transactionPath, 'rollback');
      await this.validateLocalBackupSet(rollbackSource, { requireSemanticValidation: journal.previousMode === RECOVERY_MODES.NORMAL });
      const candidate = path.join(transactionPath, `rollback-install-${crypto.randomUUID()}`);
      await copyDirectoryVerified(rollbackSource, candidate);
      const partial = path.join(transactionPath, `partial-install-${crypto.randomUUID()}`);
      await fs.mkdir(partial, { recursive: true, mode: 0o700 });
      await movePathIfPresent(this.statePath, path.join(partial, STATE_FILE));
      await movePathIfPresent(this.vaultPath, path.join(partial, 'document-vault'));
      await movePathIfPresent(this.keyPath, path.join(partial, KEY_FILE));
      await durableRename(path.join(candidate, 'data', STATE_FILE), this.statePath);
      await durableRename(path.join(candidate, 'data', 'document-vault'), this.vaultPath);
      if (await pathExists(path.join(candidate, 'data', KEY_FILE))) await durableRename(path.join(candidate, 'data', KEY_FILE), this.keyPath);
      const rollbackManifestPath = path.join(rollbackSource, 'manifest.json');
      const rollbackManifest = validateLocalManifest(parseJson(await fs.readFile(rollbackManifestPath, 'utf8'), 'backup_manifest_invalid'), this.appVersion);
      await this.verifyInstalledBytes(rollbackManifest);
      let state = null;
      if (journal.previousMode === RECOVERY_MODES.NORMAL) {
        const verified = await this.validateDatasetSemantics(this.userDataPath, rollbackManifest);
        state = verified;
        await this.loadInstalledVaultKey(state.documents.length > 0);
      }
      journal.phase = RESTORE_PHASES.ROLLBACK_VERIFIED;
      journal.rollbackCompleted = true;
      await this.writeRestoreJournal(journal);
      const safetyCopy = await this.publishSafetyCopy(transactionPath, journal);
      await this.cleanupResolvedTransaction(transactionPath);
      if (journal.previousMode === RECOVERY_MODES.NORMAL) {
        this.mode = RECOVERY_MODES.NORMAL;
        this.interruptedRestoreUnresolved = false;
        return { status: 'rolled_back', state, reasonCode: safeRestoreReason(originalError), safetyCopy };
      }
      this.setRestoreRecovery(journal.previousRecoveryReason || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE, 'restore_failed');
      await this.refreshRecoveryBackups();
      return this.recoveryResult();
    } catch (rollbackError) {
      await this.recordRestoreDiagnostic('restore_rollback_failed', rollbackError);
      this.setRestoreRecovery('restore_rollback_failed', 'restore_rollback_failed');
      await this.refreshRecoveryBackups().catch(() => {});
      return this.recoveryResult();
    }
  }

  async verifyInstalledBytes(manifest) {
    for (const entry of manifest.files) {
      const target = resolveSafeChild(this.userDataPath, entry.path);
      const stat = await regularFileStat(target, 'A rollback file is missing or unsafe.');
      if (stat.size !== entry.size || sha256(await fs.readFile(target)) !== entry.sha256) throw new Error('The rollback dataset could not be verified.');
    }
  }

  async writeRestoreJournal(journal) {
    const safe = validateRestoreJournal({ ...journal, updatedAt: this.clock().toISOString() });
    await atomicWrite(this.restoreJournalPath, JSON.stringify(safe));
    Object.assign(journal, safe);
    await this.injectFault('restore_after_journal_write');
  }

  async publishSafetyCopy(transactionPath, journal) {
    const source = path.join(transactionPath, 'rollback');
    if (!await pathExists(source)) return null;
    const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
    const fileName = `pre-restore-${stamp}-${journal.transactionId}.osmb-set`;
    const destination = path.join(this.recoveryPath, fileName);
    await durableRename(source, destination);
    return fileName;
  }

  async cleanupResolvedTransaction(transactionPath) {
    await fs.unlink(this.restoreJournalPath).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
    try {
      await fs.rm(transactionPath, { recursive: true, force: true });
    } catch (error) {
      await this.recordRestoreDiagnostic('restore_cleanup_failed', error);
    }
  }

  setRestoreRecovery(reasonCode, lastOperationError = null) {
    this.mode = RECOVERY_MODES.REQUIRED;
    this.interruptedRestoreUnresolved = true;
    this.recovery = {
      reasonCode: reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE,
      recoveryCopyCreated: false,
      recoveryCopyFileName: null,
      backupDiscoveryFailed: false,
      backups: [],
      lastOperationError
    };
    this.freshStartConfirmation = null;
  }

  async recordRestoreDiagnostic(reasonCode, error) {
    await this.diagnostics?.record('BACKUP_RESTORE_FAILED', { error, reasonCode }).catch(() => {});
  }

  async recoverInterruptedRestore() {
    let journal;
    try {
      const stat = await regularFileStat(this.restoreJournalPath, 'The restore journal is unsafe.');
      if (stat.size > 1_000_000) throw new Error('The restore journal is too large.');
      journal = validateRestoreJournal(parseJson(await fs.readFile(this.restoreJournalPath, 'utf8'), 'restore_journal_invalid'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      this.setRestoreRecovery('restore_journal_invalid', 'restore_interrupted');
      await this.recordRestoreDiagnostic('restore_journal_invalid', error);
      return;
    }

    const transactionPath = resolveSafeChild(this.restorePath, journal.transactionId);
    const preCommit = [RESTORE_PHASES.STAGING, RESTORE_PHASES.VALIDATED, RESTORE_PHASES.ROLLBACK_COPY, RESTORE_PHASES.ROLLBACK_COPY_VERIFIED].includes(journal.phase);
    if (preCommit) {
      await this.cleanupResolvedTransaction(transactionPath);
      if (journal.previousMode === RECOVERY_MODES.REQUIRED) {
        this.setRestoreRecovery(journal.previousRecoveryReason || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE, 'restore_interrupted');
      }
      return;
    }

    try {
      if ([RESTORE_PHASES.INSTALLED, RESTORE_PHASES.VERIFIED, RESTORE_PHASES.COMMITTED].includes(journal.phase)) {
        const stagedManifest = path.join(transactionPath, 'staging', 'manifest.json');
        const installed = await this.validateInstalledDataset(stagedManifest).catch(() => null);
        if (installed) {
          journal.phase = RESTORE_PHASES.COMMITTED;
          journal.postInstallVerified = true;
          await this.writeRestoreJournal(journal);
          await this.publishSafetyCopy(transactionPath, journal);
          await this.cleanupResolvedTransaction(transactionPath);
          this.mode = RECOVERY_MODES.NORMAL;
          this.interruptedRestoreUnresolved = false;
          return;
        }
      }
      if ([RESTORE_PHASES.COMMIT_STARTED, RESTORE_PHASES.INSTALLED, RESTORE_PHASES.ROLLBACK_STARTED, RESTORE_PHASES.ROLLBACK_VERIFIED, RESTORE_PHASES.VERIFIED, RESTORE_PHASES.COMMITTED].includes(journal.phase)) {
        const result = await this.rollbackRestoreTransaction(transactionPath, journal, new Error('restore_interrupted'));
        if (result.status === 'rolled_back') {
          this.mode = RECOVERY_MODES.NORMAL;
          this.interruptedRestoreUnresolved = false;
        }
        return;
      }
      throw new Error('The durable restore phase could not be determined.');
    } catch (error) {
      this.setRestoreRecovery('restore_interrupted_unresolved', 'restore_interrupted');
      await this.recordRestoreDiagnostic('restore_interrupted_unresolved', error);
    }
  }

  async cleanupAbandonedBackupTemps() {
    try {
      for (const entry of await fs.readdir(this.backupPath, { withFileTypes: true })) {
        if (entry.name.startsWith('.') && entry.name.includes('.tmp-')) {
          await fs.rm(path.join(this.backupPath, entry.name), { recursive: true, force: true });
        }
      }
      if (!await pathExists(this.restoreJournalPath)) {
        for (const entry of await fs.readdir(this.restorePath, { withFileTypes: true })) {
          if (entry.name === JOURNAL_FILE) continue;
          await fs.rm(path.join(this.restorePath, entry.name), { recursive: true, force: true });
        }
      }
    } catch (error) {
      await this.recordRestoreDiagnostic('restore_cleanup_failed', error);
    }
  }

  decryptVaultBytes(encrypted) {
    if (!encrypted.subarray(0, VAULT_MAGIC.length).equals(VAULT_MAGIC)) throw new Error('Document vault file is damaged.');
    const ivStart = VAULT_MAGIC.length;
    const iv = encrypted.subarray(ivStart, ivStart + 12);
    const tag = encrypted.subarray(ivStart + 12, ivStart + 28);
    const ciphertext = encrypted.subarray(ivStart + 28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.vaultKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  async loadOrCreateVaultKey({ hasDocuments = false } = {}) {
    if (!this.encryptionAvailable()) {
      this.vaultKey = null;
      if (hasDocuments) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
      return;
    }
    try {
      const stored = JSON.parse(await fs.readFile(this.keyPath, 'utf8'));
      if (!isPlainObject(stored) || stored.version !== 1 || !isCanonicalBase64(stored.encryptedKey)) {
        throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
      }
      this.vaultKey = Buffer.from(this.secureStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')), 'base64');
      if (this.vaultKey.length !== 32) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE);
    } catch (error) {
      if (error.code !== 'ENOENT' && hasDocuments) throw error;
      if (error.code === 'ENOENT' && hasDocuments) throw new StateLoadError(LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE, error);
      this.vaultKey = crypto.randomBytes(32);
      const encryptedKey = this.secureStorage.encryptString(this.vaultKey.toString('base64')).toString('base64');
      await atomicWrite(this.keyPath, JSON.stringify({ version: 1, encryptedKey }));
    }
  }
}

function encryptPortablePayload(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
  return Buffer.concat([BACKUP_MAGIC, salt, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptPortablePayload(contents, passphrase) {
  if (!Buffer.isBuffer(contents) || contents.length < 49) throw new Error('The backup file is truncated.');
  try {
    const salt = contents.subarray(4, 20);
    const iv = contents.subarray(20, 32);
    const tag = contents.subarray(32, 48);
    const ciphertext = contents.subarray(48);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('The backup password is incorrect or the file is damaged.');
  }
}

function buildPortableManifest({ backupId, createdAt, applicationVersion, schemaVersion, documents, files }) {
  const entries = [...files.entries()].map(([filePath, bytes]) => {
    const documentMatch = /^documents\/([0-9a-f-]{36})\.bin$/i.exec(filePath);
    return {
      path: filePath,
      role: filePath === 'state.json' ? 'financial_state' : 'document',
      ...(documentMatch ? { documentId: documentMatch[1] } : {}),
      size: bytes.length,
      sha256: sha256(bytes)
    };
  }).sort((left, right) => left.path.localeCompare(right.path));
  return {
    manifestVersion: 1,
    backupId,
    createdAt,
    applicationVersion,
    schemaVersion,
    complete: true,
    documentCount: documents.length,
    files: entries
  };
}

function validatePortableManifest(value, currentAppVersion) {
  if (!isPlainObject(value) || value.manifestVersion !== 1 || value.complete !== true) throw new Error('The backup manifest is invalid.');
  if (!isSafeIdentifier(value.backupId) || !validIsoDate(value.createdAt)) throw new Error('The backup manifest identity is invalid.');
  if (typeof value.applicationVersion !== 'string' || !isSupportedApplicationVersion(value.applicationVersion, currentAppVersion)) {
    throw new Error('This backup was created by a newer unsupported application version.');
  }
  if (!Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error('The backup uses an unsupported stored-data schema.');
  }
  if (!Number.isInteger(value.documentCount) || value.documentCount < 0 || value.documentCount > MAX_BACKUP_ENTRIES) throw new Error('The backup document count is invalid.');
  const files = validateManifestFiles(value.files);
  if (files.filter((entry) => entry.role === 'financial_state').length !== 1 || !files.some((entry) => entry.path === 'state.json')) {
    throw new Error('The backup manifest does not contain exactly one financial state.');
  }
  if (files.filter((entry) => entry.role === 'document').length !== value.documentCount) throw new Error('The backup document count does not match its manifest.');
  return { ...value, files };
}

function decodePortableFiles(value, manifest) {
  if (!isPlainObject(value)) throw new Error('The backup file table is invalid.');
  const expected = new Set(manifest.files.map((entry) => entry.path));
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((name) => !expected.has(name))) throw new Error('The backup contains missing or unexpected files.');
  const files = new Map();
  let totalSize = 0;
  for (const entry of manifest.files) {
    const encoded = value[entry.path];
    if (!isCanonicalBase64AllowEmpty(encoded)) throw new Error('A backup file has invalid encoding.');
    const bytes = Buffer.from(encoded, 'base64');
    totalSize += bytes.length;
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw new Error('A backup file failed its size or checksum validation.');
    files.set(entry.path, bytes);
  }
  if (totalSize > MAX_BACKUP_BYTES) throw new Error('The backup expands beyond the safe size limit.');
  return files;
}

function validatePortableDocumentSet(state, manifest, files) {
  if (state.documents.length !== manifest.documentCount) throw new Error('The backup document metadata is incomplete.');
  const ids = new Set();
  for (const document of state.documents) {
    validateDocumentMetadata(document);
    if (ids.has(document.id)) throw new Error('The backup contains duplicate document identifiers.');
    ids.add(document.id);
    const entry = manifest.files.find((candidate) => candidate.role === 'document' && candidate.documentId === document.id);
    const bytes = files.get(`documents/${document.id}.bin`);
    if (!entry || !bytes || bytes.length !== document.size || sha256(bytes) !== document.sha256) throw new Error('A backup document does not match its financial-state mapping.');
  }
}

async function buildLocalManifest(dataPath, metadata) {
  const files = [];
  for (const relative of await listRegularFiles(dataPath)) {
    const target = resolveSafeChild(dataPath, relative);
    await syncFile(target);
    const bytes = await fs.readFile(target);
    const match = /^document-vault\/([0-9a-f-]{36})\.vault$/i.exec(relative);
    files.push({
      path: relative,
      role: relative === STATE_FILE ? 'financial_state' : relative === KEY_FILE ? 'vault_key' : 'document',
      ...(match ? { documentId: match[1] } : {}),
      size: bytes.length,
      sha256: sha256(bytes)
    });
  }
  await syncDirectory(dataPath);
  if (await pathExists(path.join(dataPath, 'document-vault'))) await syncDirectory(path.join(dataPath, 'document-vault'));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    formatVersion: LOCAL_BACKUP_FORMAT_VERSION,
    backupId: metadata.backupId,
    createdAt: metadata.createdAt,
    applicationVersion: metadata.applicationVersion,
    schemaVersion: metadata.schemaVersion,
    complete: true,
    documentCount: metadata.documentCount,
    purpose: metadata.purpose,
    files
  };
}

function validateLocalManifest(value, currentAppVersion) {
  if (!isPlainObject(value) || value.formatVersion !== LOCAL_BACKUP_FORMAT_VERSION || value.complete !== true) throw new Error('The local backup manifest is invalid.');
  if (!isSafeIdentifier(value.backupId) || !validIsoDate(value.createdAt)) throw new Error('The local backup identity is invalid.');
  const purposes = ['automatic_backup', 'pre_restore_safety', 'restore_staging'];
  if (!purposes.includes(value.purpose)) throw new Error('The local backup purpose is invalid.');
  if (typeof value.applicationVersion !== 'string' || (value.purpose !== 'pre_restore_safety' && !isSupportedApplicationVersion(value.applicationVersion, currentAppVersion))) {
    throw new Error('The local backup was created by an unsupported application version.');
  }
  const safety = value.purpose === 'pre_restore_safety';
  if (!(Number.isInteger(value.schemaVersion) && value.schemaVersion >= 1 && value.schemaVersion <= CURRENT_SCHEMA_VERSION) && !(safety && value.schemaVersion === null)) {
    throw new Error('The local backup schema is invalid.');
  }
  if (!(Number.isInteger(value.documentCount) && value.documentCount >= 0 && value.documentCount <= MAX_BACKUP_ENTRIES) && !(safety && value.documentCount === null)) {
    throw new Error('The local backup document count is invalid.');
  }
  const files = validateManifestFiles(value.files, true);
  if (files.filter((entry) => entry.role === 'financial_state').length !== 1 || !files.some((entry) => entry.path === STATE_FILE)) throw new Error('The local backup financial state is missing.');
  if (!safety && files.filter((entry) => entry.role === 'document').length !== value.documentCount) throw new Error('The local backup document count does not match its manifest.');
  return { ...value, files };
}

function validateManifestFiles(value, local = false) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_BACKUP_ENTRIES + 2) throw new Error('The backup file list is invalid.');
  const seenPaths = new Set();
  const seenDocumentIds = new Set();
  let totalSize = 0;
  return value.map((entry) => {
    if (!isPlainObject(entry) || !isSafeRelativePath(entry.path)) throw new Error('The backup contains an unsafe path.');
    const roles = local ? ['financial_state', 'document', 'vault_key'] : ['financial_state', 'document'];
    if (!roles.includes(entry.role) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_BACKUP_FILE_BYTES || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error('A backup manifest entry is invalid.');
    }
    if (seenPaths.has(entry.path)) throw new Error('The backup contains duplicate file entries.');
    seenPaths.add(entry.path);
    totalSize += entry.size;
    if (entry.role === 'document') {
      if (!isUuid(entry.documentId) || seenDocumentIds.has(entry.documentId)) throw new Error('The backup contains duplicate or invalid document mappings.');
      seenDocumentIds.add(entry.documentId);
    } else if (entry.documentId !== undefined) {
      throw new Error('The backup contains an invalid document mapping.');
    }
    return { ...entry };
  }).map((entry, index, entries) => {
    if (index === entries.length - 1 && totalSize > MAX_BACKUP_BYTES) throw new Error('The backup file list exceeds the safe size limit.');
    return entry;
  });
}

function validateDocumentMetadata(document) {
  if (!isPlainObject(document) || !isUuid(document.id) || document.storedName !== `${document.id}.vault`) throw new Error('Document metadata contains an invalid vault mapping.');
  if (!Number.isInteger(document.size) || document.size < 0 || document.size > MAX_BACKUP_FILE_BYTES || !/^[0-9a-f]{64}$/.test(document.sha256)) {
    throw new Error('Document metadata contains invalid integrity information.');
  }
}

function validateVaultFileName(fileName) {
  if (!isUuid(String(fileName).replace(/\.vault$/i, '')) || !/^[0-9a-f-]{36}\.vault$/i.test(fileName)) throw new Error('The document vault contains an unsafe filename.');
}

function decryptVaultBytesWithKey(encrypted, key) {
  if (!Buffer.isBuffer(encrypted) || !encrypted.subarray(0, VAULT_MAGIC.length).equals(VAULT_MAGIC) || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error('Document vault authentication failed.');
  }
  const ivStart = VAULT_MAGIC.length;
  if (encrypted.length < ivStart + 29) throw new Error('A document vault file is truncated.');
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, encrypted.subarray(ivStart, ivStart + 12));
    decipher.setAuthTag(encrypted.subarray(ivStart + 12, ivStart + 28));
    return Buffer.concat([decipher.update(encrypted.subarray(ivStart + 28)), decipher.final()]);
  } catch {
    throw new Error('Document vault authentication failed.');
  }
}

async function regularFileStat(target, message) {
  let stat;
  try {
    stat = await fs.lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    const wrapped = new Error(message);
    wrapped.code = error.code;
    throw wrapped;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
  return stat;
}

async function copyVerifiedFile(source, destination) {
  const stat = await regularFileStat(source, 'A required source file is missing or unsafe.');
  if (stat.size > MAX_BACKUP_FILE_BYTES) throw new Error('A required file exceeds the safe size limit.');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  await syncFile(destination);
  const [sourceBytes, destinationBytes] = await Promise.all([fs.readFile(source), fs.readFile(destination)]);
  if (sourceBytes.length !== destinationBytes.length || sha256(sourceBytes) !== sha256(destinationBytes)) {
    await fs.unlink(destination).catch(() => {});
    throw new Error('A file copy failed verification.');
  }
}

async function listRegularFiles(root) {
  const rootStat = await fs.lstat(root).catch(() => null);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) throw new Error('A backup directory is missing or unsafe.');
  const output = [];
  const walk = async (directory, prefix = '') => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('The backup contains a symbolic link or path redirection.');
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!isSafeRelativePath(relative)) throw new Error('The backup contains an unsafe path.');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target, relative);
      else if (entry.isFile()) output.push(relative);
      else throw new Error('The backup contains an unsupported filesystem entry.');
      if (output.length > MAX_BACKUP_ENTRIES + 2) throw new Error('The backup contains too many files.');
    }
  };
  await walk(root);
  return output.sort();
}

function resolveSafeChild(root, relative) {
  if (!isSafeRelativePath(relative)) throw new Error('The backup contains an unsafe path.');
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relative.split('/'));
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error('The backup path escapes its controlled directory.');
  return resolved;
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..' && !part.includes(':')) && path.posix.normalize(value) === value;
}

async function pathExists(target) {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function syncFile(target) {
  const handle = await fs.open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function durableRename(source, destination) {
  await fs.rename(source, destination);
  await Promise.all([...new Set([path.dirname(source), path.dirname(destination)])].map(syncDirectory));
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function movePathIfPresent(source, destination) {
  let stat;
  try {
    stat = await fs.lstat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('A live persistence path is unsafe.');
  await durableRename(source, destination);
  return true;
}

async function copyDirectoryVerified(source, destination) {
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('The safety-copy directory is unsafe.');
  await fs.mkdir(destination, { recursive: false, mode: 0o700 });
  const copyTree = async (from, to) => {
    for (const entry of await fs.readdir(from, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('The safety copy contains a path redirection.');
      const sourcePath = path.join(from, entry.name);
      const destinationPath = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destinationPath, { mode: 0o700 });
        await copyTree(sourcePath, destinationPath);
      } else if (entry.isFile()) await copyVerifiedFile(sourcePath, destinationPath);
      else throw new Error('The safety copy contains an unsupported entry.');
    }
  };
  await copyTree(source, destination);
}

function validateRestoreJournal(value) {
  if (!isPlainObject(value) || value.formatVersion !== 1 || !isUuid(value.transactionId) || !isSafeIdentifier(value.backupId)) throw new Error('The restore journal identity is invalid.');
  if (!Object.values(RESTORE_PHASES).includes(value.phase) || ![RECOVERY_MODES.NORMAL, RECOVERY_MODES.REQUIRED].includes(value.previousMode)) throw new Error('The restore journal phase is invalid.');
  if (value.previousRecoveryReason !== null && !/^[a-z0-9_]{3,80}$/.test(value.previousRecoveryReason)) throw new Error('The restore journal recovery reason is invalid.');
  if (![value.stagingVerified, value.rollbackVerified, value.postInstallVerified, value.rollbackCompleted].every((item) => typeof item === 'boolean')) throw new Error('The restore journal flags are invalid.');
  if (!Number.isInteger(value.commitStep) || value.commitStep < 0 || value.commitStep > 6 || !validIsoDate(value.updatedAt)) throw new Error('The restore journal commit position is invalid.');
  return {
    formatVersion: 1,
    transactionId: value.transactionId,
    backupId: value.backupId,
    phase: value.phase,
    previousMode: value.previousMode,
    previousRecoveryReason: value.previousRecoveryReason,
    stagingVerified: value.stagingVerified,
    rollbackVerified: value.rollbackVerified,
    commitStep: value.commitStep,
    postInstallVerified: value.postInstallVerified,
    rollbackCompleted: value.rollbackCompleted,
    updatedAt: value.updatedAt
  };
}

function localBackupDescriptor(id, inspection) {
  return {
    id,
    createdAt: inspection.manifest.createdAt,
    valid: true,
    compatible: true,
    complete: true,
    classification: inspection.classification,
    schemaVersion: inspection.manifest.schemaVersion,
    applicationVersion: inspection.manifest.applicationVersion,
    documentCount: inspection.manifest.documentCount,
    migrationRequired: inspection.manifest.schemaVersion < CURRENT_SCHEMA_VERSION,
    reasonCode: null
  };
}

function invalidBackupDescriptor(id, createdAt, reasonCode) {
  return { id, createdAt, valid: false, compatible: false, complete: false, classification: 'corrupt', schemaVersion: null, applicationVersion: null, documentCount: null, migrationRequired: false, reasonCode };
}

function safeRestoreReason(error) {
  const reason = String(error?.reasonCode || error?.code || '').toLowerCase();
  if (/^[a-z0-9_]{3,80}$/.test(reason)) return reason;
  return 'restore_failed';
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9-]{8,80}$/.test(value);
}

function isUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isSupportedApplicationVersion(candidate, current) {
  const parse = (value) => /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value));
  const candidateParts = parse(candidate);
  const currentParts = parse(current);
  if (!candidateParts || !currentParts) return false;
  const [, candidateMajor, candidateMinor] = candidateParts.map(Number);
  const [, currentMajor, currentMinor] = currentParts.map(Number);
  return candidateMajor < currentMajor || (candidateMajor === currentMajor && candidateMinor <= currentMinor);
}

function isCanonicalBase64AllowEmpty(value) {
  return value === '' || isCanonicalBase64(value);
}

function migrateState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    meta: { createdAt: state.meta?.createdAt || new Date().toISOString(), updatedAt: state.meta?.updatedAt || new Date().toISOString() },
    profile: state.profile || { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: 30 },
    accounts: Array.isArray(state.accounts) ? state.accounts : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : [],
    payslips: Array.isArray(state.payslips) ? state.payslips : [],
    taxDocuments: Array.isArray(state.taxDocuments) ? state.taxDocuments : [],
    creditReports: Array.isArray(state.creditReports) ? state.creditReports : [],
    debts: Array.isArray(state.debts) ? state.debts.map(migrateDebtSafetyRecord) : [],
    overdrafts: Array.isArray(state.overdrafts) ? state.overdrafts.map(migrateDebtSafetyRecord) : [],
    budgets: Array.isArray(state.budgets) ? state.budgets : [],
    scheduledPayments: Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [],
    documents: Array.isArray(state.documents) ? state.documents : [],
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    checkIns: Array.isArray(state.checkIns) ? state.checkIns : [],
    importBatches: Array.isArray(state.importBatches) ? state.importBatches : [],
    settings: {
      selectedMonth: state.settings?.selectedMonth || currentMonth(),
      extraDebtPayment: Number(state.settings?.extraDebtPayment ?? 0),
      emergencyBufferTarget: Number(state.settings?.emergencyBufferTarget ?? 500),
      emergencyBufferBalance: Number(state.settings?.emergencyBufferBalance ?? 0),
      extraIncomeDebtPercent: Number(state.settings?.extraIncomeDebtPercent ?? 80),
      llmModel: state.settings?.llmModel || 'qwen2.5:1.5b',
      reminders: state.settings?.reminders || { weekly: true, weeklyDay: 'monday', hour: 9 }
    }
  };
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function migrateDebtSafetyRecord(item) {
  if (!isPlainObject(item)) throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  const supportedStatuses = new Set(['current', 'arrears', 'defaulted', 'over_limit', 'unknown']);
  const supportedArrangements = new Set(['unknown', 'none', 'confirmed']);
  const previousStatus = String(item.status || '').trim().toLowerCase();
  const status = supportedStatuses.has(previousStatus) ? previousStatus : 'unknown';
  const previousArrangement = String(item.arrangementStatus || '').trim().toLowerCase();
  const arrangementStatus = supportedArrangements.has(previousArrangement)
    ? previousArrangement
    : item.arrangementConfirmed === true ? 'confirmed' : 'unknown';
  const arrangementPayment = finiteNonNegativeOrNull(item.arrangementPayment);
  const arrearsAmount = finiteNonNegativeOrNull(item.arrearsAmount);
  return {
    ...item,
    ...(previousStatus && status === 'unknown' && !item.statusDetail ? { statusDetail: item.status } : {}),
    status,
    arrangementStatus,
    arrangementConfirmed: arrangementStatus === 'confirmed',
    arrangementPayment,
    arrearsAmount,
    statusConflict: Boolean(item.statusConflict)
  };
}

function finiteNonNegativeOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

async function atomicWrite(destination, contents) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await durableRename(temporary, destination);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

function mimeFromName(fileName) {
  const extension = path.extname(fileName).toLowerCase();
  return ({ '.pdf': 'application/pdf', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.qif': 'application/qif', '.ofx': 'application/x-ofx', '.qfx': 'application/x-ofx', '.txt': 'text/plain', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' })[extension] || 'application/octet-stream';
}

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('Use a backup password with at least 8 characters.');
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'backup';
}

function parseJson(value, reasonCode) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new StateLoadError(reasonCode, error);
  }
}

function validateStoredState(state) {
  if (!isPlainObject(state)) throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  if (state.schemaVersion !== undefined && (!Number.isInteger(state.schemaVersion) || state.schemaVersion < 1 || state.schemaVersion > CURRENT_SCHEMA_VERSION)) {
    throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
  for (const collection of STATE_COLLECTIONS) {
    if (state[collection] !== undefined && !Array.isArray(state[collection])) {
      throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
    }
  }
  for (const objectName of ['meta', 'profile', 'settings']) {
    if (state[objectName] !== undefined && !isPlainObject(state[objectName])) {
      throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
    }
  }
  if (state.settings?.reminders !== undefined && !isPlainObject(state.settings.reminders)) {
    throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
}

function validateMigratedState(state) {
  if (!isPlainObject(state) || state.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
  for (const collection of STATE_COLLECTIONS) {
    if (!Array.isArray(state[collection])) throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
  if (!isPlainObject(state.meta) || !isPlainObject(state.profile) || !isPlainObject(state.settings) || !isPlainObject(state.settings.reminders)) {
    throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
  for (const value of [
    state.profile.dependableIncome,
    state.settings.extraDebtPayment,
    state.settings.emergencyBufferTarget,
    state.settings.emergencyBufferBalance,
    state.settings.extraIncomeDebtPercent
  ]) {
    if (!Number.isFinite(Number(value))) throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
  }
  for (const item of [...state.debts, ...state.overdrafts]) {
    if (!isPlainObject(item)
      || !['current', 'arrears', 'defaulted', 'over_limit', 'unknown'].includes(item.status)
      || !['unknown', 'none', 'confirmed'].includes(item.arrangementStatus)
      || item.arrangementConfirmed !== (item.arrangementStatus === 'confirmed')
      || (item.arrangementPayment !== null && (!Number.isFinite(item.arrangementPayment) || item.arrangementPayment < 0))
      || (item.arrearsAmount !== null && (!Number.isFinite(item.arrearsAmount) || item.arrearsAmount < 0))) {
      throw new StateLoadError(LOAD_REASON_CODES.SCHEMA_VALIDATION_FAILURE);
    }
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isCanonicalBase64(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length % 4 === 0
    && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function classifyDecryptionFailure(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '');
  if (['ENOKEY', 'KEY_NOT_FOUND', 'CREDENTIAL_NOT_FOUND'].includes(code) || /(?:encryption |credential )?key (?:is )?(?:missing|not found|unavailable)/i.test(message)) {
    return LOAD_REASON_CODES.ENCRYPTION_KEY_UNAVAILABLE;
  }
  return LOAD_REASON_CODES.DECRYPTION_FAILURE;
}
