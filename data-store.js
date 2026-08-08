import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const STATE_FILE = 'finance-state.json';
const KEY_FILE = 'vault-key.json';
const VAULT_MAGIC = Buffer.from('LFVLT001');
const BACKUP_MAGIC = Buffer.from('LFB1');
const LEGACY_BACKUP_MAGIC = Buffer.from('HFB1');
const CURRENT_SCHEMA_VERSION = 5;
const FRESH_START_CONFIRMATION_MS = 5 * 60 * 1000;
const STATE_COLLECTIONS = Object.freeze([
  'accounts', 'transactions', 'payslips', 'taxDocuments', 'creditReports', 'debts', 'overdrafts',
  'budgets', 'scheduledPayments', 'documents', 'tasks', 'checkIns', 'importBatches'
]);

export const RECOVERY_MODES = Object.freeze({
  NORMAL: 'normal',
  REQUIRED: 'recovery_required',
  RESOLVING: 'resolution_in_progress'
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
    this.keyPath = path.join(userDataPath, KEY_FILE);
    this.vaultKey = null;
    this.diagnostics = diagnostics;
    this.secureStorage = options.secureStorage;
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    this.migrate = typeof options.migrateState === 'function' ? options.migrateState : migrateState;
    this.mode = RECOVERY_MODES.NORMAL;
    this.recovery = null;
    this.backupCandidates = new Map();
    this.freshStartConfirmation = null;
  }

  async initialise() {
    await fs.mkdir(this.userDataPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.vaultPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.backupPath, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.recoveryPath, { recursive: true, mode: 0o700 });
  }

  encryptionStatus() {
    const available = this.encryptionAvailable();
    return {
      available,
      backend: available ? 'Operating-system protected' : 'Unavailable'
    };
  }

  async loadState() {
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
    if (this.mode !== RECOVERY_MODES.NORMAL) throw new RecoveryModeError(this.mode);
  }

  recoveryStatus() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }

  async retryRecoveryLoad() {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
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

  async restoreRecoveryBackup(backupId) {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
    let candidatePath = this.backupCandidates.get(String(backupId));
    if (!candidatePath) {
      await this.refreshRecoveryBackups();
      candidatePath = this.backupCandidates.get(String(backupId));
    }
    if (!candidatePath) return this.recoveryFailure('backup_not_found');

    this.mode = RECOVERY_MODES.RESOLVING;
    let originalBytes;
    let installed = false;
    try {
      const candidate = await this.inspectStateFile(candidatePath);
      if (candidate.status !== 'loaded') throw new StateLoadError(candidate.reasonCode || 'backup_invalid');
      const backupBytes = await fs.readFile(candidatePath);
      originalBytes = await fs.readFile(this.statePath);
      await atomicWrite(this.statePath, backupBytes);
      installed = true;
      const reopened = await this.inspectStateFile(this.statePath);
      if (reopened.status !== 'loaded') throw new StateLoadError(reopened.reasonCode || 'restored_state_invalid');
      await this.loadOrCreateVaultKey({ hasDocuments: reopened.state.documents.length > 0 });
      this.clearRecovery();
      return this.normalResult(reopened.state, 'restored_backup');
    } catch (error) {
      if (installed && originalBytes) await atomicWrite(this.statePath, originalBytes).catch(() => {});
      await this.diagnostics?.record('RECOVERY_OPERATION_FAILED', { error, reasonCode: 'restore_failed' }).catch(() => {});
      return this.recoveryFailure('restore_failed');
    }
  }

  requestFreshStart() {
    if (this.mode !== RECOVERY_MODES.REQUIRED) return { status: 'invalid_operation', mode: this.mode };
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
    this.assertWritable();
    const stamp = this.clock().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.backupPath, `${stamp}-${slug(reason)}.json`);
    try {
      await fs.copyFile(this.statePath, destination);
      return destination;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
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
        if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
        const target = path.join(this.backupPath, entry.name);
        const id = sha256(Buffer.from(entry.name, 'utf8')).slice(0, 24);
        const [inspection, stat] = await Promise.all([this.inspectStateFile(target), fs.stat(target)]);
        const valid = inspection.status === 'loaded';
        this.backupCandidates.set(id, target);
        backups.push({
          id,
          createdAt: stat.mtime.toISOString(),
          valid,
          compatible: valid,
          schemaVersion: valid ? inspection.schemaVersion : null,
          reasonCode: valid ? null : inspection.reasonCode || LOAD_REASON_CODES.UNKNOWN_STORAGE_FAILURE
        });
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
    const documents = [];
    for (const document of state.documents || []) {
      const { bytes } = await this.readDocument(document.id, state.documents);
      documents.push({ metadata: document, contents: bytes.toString('base64') });
    }

    const payload = Buffer.from(JSON.stringify({ version: 1, createdAt: this.clock().toISOString(), state, documents }), 'utf8');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    await atomicWrite(destination, Buffer.concat([BACKUP_MAGIC, salt, iv, tag, ciphertext]));
  }

  async restorePortableBackup(source, passphrase) {
    this.assertWritable();
    requirePassphrase(passphrase);
    const contents = await fs.readFile(source);
    const magic = contents.subarray(0, 4);
    if (!magic.equals(BACKUP_MAGIC) && !magic.equals(LEGACY_BACKUP_MAGIC)) throw new Error('This is not a supported OneStep Money backup.');
    const salt = contents.subarray(4, 20);
    const iv = contents.subarray(20, 32);
    const tag = contents.subarray(32, 48);
    const ciphertext = contents.subarray(48);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let backup;
    try {
      backup = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('The backup password is incorrect or the file is damaged.');
    }
    if (!backup?.state || !Array.isArray(backup.documents)) throw new Error('The backup is incomplete.');

    await this.createAutomaticBackup('before-restore');
    const restoredIds = new Map();
    for (const entry of backup.documents) {
      const previousId = entry.metadata.id;
      const temporary = path.join(this.userDataPath, `${crypto.randomUUID()}.restore`);
      await fs.writeFile(temporary, Buffer.from(entry.contents, 'base64'));
      const stored = await this.storeDocument(temporary, entry.metadata.kind, []);
      await fs.unlink(temporary).catch(() => {});
      Object.assign(entry.metadata, stored.document);
      restoredIds.set(previousId, stored.document.id);
    }
    backup.state.documents = backup.documents.map((entry) => entry.metadata);
    for (const collectionName of ['transactions', 'payslips', 'taxDocuments', 'creditReports']) {
      for (const record of backup.state[collectionName] || []) {
        if (restoredIds.has(record.sourceDocumentId)) record.sourceDocumentId = restoredIds.get(record.sourceDocumentId);
        for (const account of record.accounts || []) {
          if (restoredIds.has(account.sourceDocumentId)) account.sourceDocumentId = restoredIds.get(account.sourceDocumentId);
        }
      }
    }
    for (const collectionName of ['debts', 'overdrafts']) {
      for (const record of backup.state[collectionName] || []) {
        if (restoredIds.has(record.sourceStatementDocumentId)) record.sourceStatementDocumentId = restoredIds.get(record.sourceStatementDocumentId);
      }
    }
    for (const batch of backup.state.importBatches || []) {
      if (restoredIds.has(batch.documentId)) batch.documentId = restoredIds.get(batch.documentId);
    }
    return this.saveState(backup.state);
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
    debts: Array.isArray(state.debts) ? state.debts : [],
    overdrafts: Array.isArray(state.overdrafts) ? state.overdrafts : [],
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

async function atomicWrite(destination, contents) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { mode: 0o600 });
  await fs.rename(temporary, destination);
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
