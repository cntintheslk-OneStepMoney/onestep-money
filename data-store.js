import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { safeStorage } from 'electron';

const STATE_FILE = 'finance-state.json';
const KEY_FILE = 'vault-key.json';
const VAULT_MAGIC = Buffer.from('LFVLT001');
const BACKUP_MAGIC = Buffer.from('LFB1');
const LEGACY_BACKUP_MAGIC = Buffer.from('HFB1');

export class FinanceDataStore {
  constructor(userDataPath, seedPath) {
    this.userDataPath = userDataPath;
    this.seedPath = seedPath;
    this.statePath = path.join(userDataPath, STATE_FILE);
    this.vaultPath = path.join(userDataPath, 'document-vault');
    this.backupPath = path.join(userDataPath, 'automatic-backups');
    this.keyPath = path.join(userDataPath, KEY_FILE);
    this.vaultKey = null;
  }

  async initialise() {
    await fs.mkdir(this.userDataPath, { recursive: true });
    await fs.mkdir(this.vaultPath, { recursive: true });
    await fs.mkdir(this.backupPath, { recursive: true });
    await this.loadOrCreateVaultKey();
  }

  encryptionStatus() {
    return {
      available: safeStorage.isEncryptionAvailable(),
      backend: safeStorage.isEncryptionAvailable() ? 'Operating-system protected' : 'Unavailable'
    };
  }

  async loadState() {
    try {
      const envelope = JSON.parse(await fs.readFile(this.statePath, 'utf8'));
      const state = envelope.encrypted
        ? JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')))
        : JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
      return migrateState(state);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        await this.createAutomaticBackup('unreadable-state').catch(() => {});
      }
      const seed = JSON.parse(await fs.readFile(this.seedPath, 'utf8'));
      const state = migrateState(seed);
      await this.saveState(state);
      return state;
    }
  }

  async saveState(state) {
    const clean = migrateState(structuredClone(state));
    clean.meta.updatedAt = new Date().toISOString();
    const json = JSON.stringify(clean);
    const encrypted = safeStorage.isEncryptionAvailable();
    const payload = encrypted
      ? safeStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64');
    await atomicWrite(this.statePath, JSON.stringify({ version: 1, encrypted, payload }));
    return clean;
  }

  async createAutomaticBackup(reason = 'before-change') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const destination = path.join(this.backupPath, `${stamp}-${slug(reason)}.json`);
    try {
      await fs.copyFile(this.statePath, destination);
      return destination;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async storeDocument(filePath, kind, existingDocuments = []) {
    if (!safeStorage.isEncryptionAvailable() || !this.vaultKey) {
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
        importedAt: new Date().toISOString(),
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

    const payload = Buffer.from(JSON.stringify({ version: 1, createdAt: new Date().toISOString(), state, documents }), 'utf8');
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(passphrase, salt, 32);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const tag = cipher.getAuthTag();
    await atomicWrite(destination, Buffer.concat([BACKUP_MAGIC, salt, iv, tag, ciphertext]));
  }

  async restorePortableBackup(source, passphrase) {
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

  async loadOrCreateVaultKey() {
    if (!safeStorage.isEncryptionAvailable()) {
      this.vaultKey = null;
      return;
    }
    try {
      const stored = JSON.parse(await fs.readFile(this.keyPath, 'utf8'));
      this.vaultKey = Buffer.from(safeStorage.decryptString(Buffer.from(stored.encryptedKey, 'base64')), 'base64');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.vaultKey = crypto.randomBytes(32);
      const encryptedKey = safeStorage.encryptString(this.vaultKey.toString('base64')).toString('base64');
      await atomicWrite(this.keyPath, JSON.stringify({ version: 1, encryptedKey }));
    }
  }
}

function migrateState(input) {
  const state = input && typeof input === 'object' ? input : {};
  return {
    schemaVersion: 5,
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
