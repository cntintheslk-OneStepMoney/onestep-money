import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_FILES = 5;
const STARTUP_FILE = 'startup.ndjson';
const DETAIL_FILE_PATTERN = /^diagnostics-(\d+)\.enc$/;

const EVENT_DEFINITIONS = Object.freeze({
  APP_STARTED: { level: 'info', reference: 'APP-001', stage: 'startup', layer: 'startup' },
  APP_READY: { level: 'info', reference: 'APP-002', stage: 'startup', layer: 'startup' },
  APP_FATAL: { level: 'error', reference: 'APP-500', stage: 'startup', layer: 'startup' },
  SECURE_STORAGE_UNAVAILABLE: { level: 'warning', reference: 'SEC-101', stage: 'secure_storage', layer: 'startup' },
  STATE_LOAD_RECOVERED: { level: 'error', reference: 'DAT-101', stage: 'state_load', layer: 'detail' },
  STATE_SAVE_FAILED: { level: 'error', reference: 'DAT-102', stage: 'state_save', layer: 'detail' },
  STATE_RECOVERY_REQUIRED: { level: 'error', reference: 'DAT-103', stage: 'state_recovery', layer: 'detail', fields: ['reasonCode'] },
  RECOVERY_OPERATION_FAILED: { level: 'error', reference: 'DAT-104', stage: 'state_recovery', layer: 'detail', fields: ['reasonCode'] },
  DOCUMENT_IMPORT_FAILED: { level: 'error', reference: 'IMP-101', stage: 'document_import', layer: 'detail', fields: ['documentType', 'fileType'] },
  DOCUMENT_OPEN_FAILED: { level: 'error', reference: 'DOC-101', stage: 'document_open', layer: 'detail' },
  DOCUMENT_DELETE_FAILED: { level: 'error', reference: 'DOC-102', stage: 'document_delete', layer: 'detail' },
  BACKUP_CREATE_FAILED: { level: 'error', reference: 'BAK-101', stage: 'backup_create', layer: 'detail' },
  BACKUP_RESTORE_FAILED: { level: 'error', reference: 'BAK-102', stage: 'backup_restore', layer: 'detail', fields: ['reasonCode'] },
  UPDATE_FAILED: { level: 'error', reference: 'UPD-101', stage: 'update', layer: 'detail' },
  RENDERER_UNHANDLED_ERROR: { level: 'error', reference: 'UI-101', stage: 'renderer', layer: 'detail' },
  RENDERER_UNHANDLED_REJECTION: { level: 'error', reference: 'UI-102', stage: 'renderer', layer: 'detail' },
  RENDERER_PROCESS_GONE: { level: 'error', reference: 'UI-103', stage: 'renderer', layer: 'detail' },
  RENDERER_UNRESPONSIVE: { level: 'error', reference: 'UI-104', stage: 'renderer', layer: 'detail' }
});

const FAULT_CLASSIFIERS = [
  { pattern: /DOMMatrix[^\n]{0,40}(?:not defined|missing)|(?:not defined|missing)[^\n]{0,40}DOMMatrix/i, classification: 'PDF_RENDER_DOMMATRIX_MISSING', reference: 'PDF-104' },
  { pattern: /DOMPoint[^\n]{0,40}(?:not defined|missing)|(?:not defined|missing)[^\n]{0,40}DOMPoint/i, classification: 'PDF_RENDER_DOMPOINT_MISSING', reference: 'PDF-105' },
  { pattern: /unsupported|unrecognised|unrecognized/i, classification: 'DOCUMENT_FORMAT_UNSUPPORTED', reference: 'IMP-103' },
  { pattern: /damaged|corrupt|invalid pdf/i, classification: 'FILE_DAMAGED', reference: 'IMP-104' },
  { pattern: /ENOSPC|no space left/i, classification: 'STORAGE_FULL', reference: 'STO-101' },
  { pattern: /EACCES|EPERM|permission denied/i, classification: 'PERMISSION_DENIED', reference: 'STO-102' },
  { pattern: /secure (?:document )?storage is unavailable|encryption unavailable/i, classification: 'SECURE_STORAGE_UNAVAILABLE', reference: 'SEC-101' }
];

const ALLOWED_DOCUMENT_TYPES = new Set(['statement', 'payslip', 'credit-report']);
const ALLOWED_FILE_TYPES = new Set(['pdf', 'csv', 'tsv', 'txt', 'qif', 'ofx', 'qfx', 'json']);
const ALLOWED_REASON_CODES = new Set([
  'state_not_found', 'read_failure', 'decryption_failure', 'encryption_key_unavailable',
  'invalid_content', 'schema_validation_failure', 'migration_failure', 'unknown_storage_failure',
  'backup_discovery_failed', 'restore_failed', 'fresh_start_failed', 'restore_cancelled',
  'restore_interrupted', 'restore_journal_invalid', 'restore_interrupted_unresolved',
  'restore_cleanup_failed', 'restore_rollback_failed'
]);
const ALLOWED_ERROR_NAMES = new Set(['Error', 'TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'URIError', 'AggregateError']);
const ALLOWED_CLASSIFICATIONS = new Set(['PDF_RENDER_DOMMATRIX_MISSING', 'PDF_RENDER_DOMPOINT_MISSING', 'DOCUMENT_FORMAT_UNSUPPORTED', 'FILE_DAMAGED', 'STORAGE_FULL', 'PERMISSION_DENIED', 'SECURE_STORAGE_UNAVAILABLE', 'UNCLASSIFIED_FAILURE']);
const ALLOWED_REFERENCES = new Set([
  ...Object.values(EVENT_DEFINITIONS).map((definition) => definition.reference),
  ...FAULT_CLASSIFIERS.map((classifier) => classifier.reference)
]);

export const RENDERER_FAULT_EVENTS = Object.freeze([
  'RENDERER_UNHANDLED_ERROR',
  'RENDERER_UNHANDLED_REJECTION'
]);

export class DiagnosticLogger {
  constructor(userDataPath, options = {}) {
    this.directory = path.join(userDataPath, 'diagnostics');
    this.secureStorage = options.secureStorage;
    this.appVersion = safeIdentifier(options.appVersion, 'unknown');
    this.platform = safeIdentifier(options.platform, 'unknown');
    this.architecture = safeIdentifier(options.architecture, 'unknown');
    this.sessionId = crypto.randomBytes(4).toString('hex');
    this.retentionDays = positiveInteger(options.retentionDays, DEFAULT_RETENTION_DAYS);
    this.maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    this.maxFiles = positiveInteger(options.maxFiles, DEFAULT_MAX_FILES);
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    this.initialised = false;
  }

  async initialise() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => {});
    await this.pruneExpired();
    this.initialised = true;
  }

  encryptionAvailable() {
    try {
      return Boolean(this.secureStorage?.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  async record(eventName, context = {}) {
    const definition = EVENT_DEFINITIONS[eventName];
    if (!definition) throw new TypeError(`Unsupported diagnostic event: ${eventName}`);
    if (!this.initialised) await this.initialise();

    const fault = definition.layer === 'detail' && context.error ? classifyFault(context.error) : null;
    const entry = {
      timestamp: this.clock().toISOString(),
      level: definition.level,
      event: eventName,
      reference: fault?.reference || definition.reference,
      stage: definition.stage,
      appVersion: this.appVersion,
      platform: this.platform,
      architecture: this.architecture,
      session: this.sessionId
    };

    for (const field of definition.fields || []) {
      const value = sanitiseField(field, context[field]);
      if (value) entry[field] = value;
    }
    if (fault) entry.fault = { name: fault.name, classification: fault.classification };

    if (definition.layer === 'startup') {
      await this.appendStartup(entry);
      return { event: entry.event, reference: entry.reference, stored: true };
    }
    if (!this.encryptionAvailable()) {
      return { event: entry.event, reference: entry.reference, stored: false };
    }
    await this.appendEncrypted(entry);
    return { event: entry.event, reference: entry.reference, stored: true };
  }

  async buildReport() {
    if (!this.initialised) await this.initialise();
    const entries = await this.readEntries();
    const generatedAt = this.clock().toISOString();
    const encryptionState = this.encryptionAvailable()
      ? 'Active (detailed entries are encrypted on this device)'
      : 'Unavailable (only minimal startup events are retained)';
    const lines = [
      'OneStep Money diagnostic report',
      `Generated: ${generatedAt}`,
      `App version: ${this.appVersion}`,
      `Platform: ${this.platform} (${this.architecture})`,
      `Current session: ${this.sessionId}`,
      `Retention: ${this.retentionDays} days`,
      `Encrypted detail log: ${encryptionState}`,
      'Automatic upload: Disabled',
      'Financial data, document contents, amounts, names, notes, filenames and file paths are excluded.',
      `Events included: ${entries.length}`,
      '',
      'Events'
    ];

    if (!entries.length) lines.push('No diagnostic events are currently stored.');
    for (const entry of entries) {
      const details = [
        entry.documentType ? `document_type=${entry.documentType}` : '',
        entry.fileType ? `file_type=${entry.fileType}` : '',
        entry.reasonCode ? `reason_code=${entry.reasonCode}` : '',
        entry.fault?.name ? `fault=${entry.fault.name}` : '',
        entry.fault?.classification ? `classification=${entry.fault.classification}` : ''
      ].filter(Boolean).join(' ');
      lines.push(`${entry.timestamp} ${entry.level.toUpperCase()} ${entry.reference} ${entry.event} stage=${entry.stage} session=${entry.session}${details ? ` ${details}` : ''}`);
    }

    return {
      text: `${lines.join('\n')}\n`,
      entryCount: entries.length,
      generatedAt,
      retentionDays: this.retentionDays,
      encryptionAvailable: this.encryptionAvailable()
    };
  }

  async deleteAll() {
    if (!this.initialised) await this.initialise();
    const names = await fs.readdir(this.directory).catch(() => []);
    for (const name of names) {
      if (name === STARTUP_FILE || DETAIL_FILE_PATTERN.test(name)) {
        await fs.unlink(path.join(this.directory, name)).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  }

  async appendStartup(entry) {
    const target = path.join(this.directory, STARTUP_FILE);
    const retained = await readJsonLines(target);
    retained.push(entry);
    const cutoff = this.clock().getTime() - (this.retentionDays * DAY_MS);
    const safeEntries = retained.filter((item) => isValidEntry(item) && Date.parse(item.timestamp) >= cutoff).slice(-500);
    await atomicWrite(target, safeEntries.length ? `${safeEntries.map((item) => JSON.stringify(item)).join('\n')}\n` : '');
  }

  async appendEncrypted(entry) {
    const encrypted = this.secureStorage.encryptString(JSON.stringify(entry)).toString('base64');
    const line = `${encrypted}\n`;
    const target = this.detailPath(0);
    const size = await fs.stat(target).then((stat) => stat.size).catch((error) => error.code === 'ENOENT' ? 0 : Promise.reject(error));
    if (size && size + Buffer.byteLength(line) > this.maxFileBytes) await this.rotateDetails();
    await fs.appendFile(target, line, { encoding: 'utf8', mode: 0o600 });
    await fs.chmod(target, 0o600).catch(() => {});
  }

  async rotateDetails() {
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const destination = this.detailPath(index);
      const source = this.detailPath(index - 1);
      await fs.unlink(destination).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      await fs.rename(source, destination).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async pruneExpired() {
    const cutoff = this.clock().getTime() - (this.retentionDays * DAY_MS);
    const startupPath = path.join(this.directory, STARTUP_FILE);
    const startup = (await readJsonLines(startupPath)).filter((entry) => isValidEntry(entry) && Date.parse(entry.timestamp) >= cutoff);
    if (startup.length) await atomicWrite(startupPath, `${startup.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
    else await fs.unlink(startupPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });

    if (!this.encryptionAvailable()) return;
    for (let index = 0; index < this.maxFiles; index += 1) {
      const target = this.detailPath(index);
      const entries = (await this.readEncryptedFile(target)).filter((entry) => Date.parse(entry.timestamp) >= cutoff);
      if (entries.length) {
        const encryptedLines = entries.map((entry) => this.secureStorage.encryptString(JSON.stringify(entry)).toString('base64'));
        await atomicWrite(target, `${encryptedLines.join('\n')}\n`);
      } else {
        await fs.unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      }
    }
  }

  async readEntries() {
    const cutoff = this.clock().getTime() - (this.retentionDays * DAY_MS);
    const startup = await readJsonLines(path.join(this.directory, STARTUP_FILE));
    const detail = [];
    if (this.encryptionAvailable()) {
      for (let index = this.maxFiles - 1; index >= 0; index -= 1) {
        detail.push(...await this.readEncryptedFile(this.detailPath(index)));
      }
    }
    return [...startup, ...detail]
      .filter((entry) => isValidEntry(entry) && Date.parse(entry.timestamp) >= cutoff)
      .map(normaliseStoredEntry)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  }

  async readEncryptedFile(target) {
    const contents = await fs.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
    const entries = [];
    for (const line of contents.split('\n').filter(Boolean)) {
      try {
        const json = this.secureStorage.decryptString(Buffer.from(line, 'base64'));
        const entry = JSON.parse(json);
        if (isValidEntry(entry)) entries.push(entry);
      } catch {
        // A damaged diagnostic entry is skipped. It is never copied into an export.
      }
    }
    return entries;
  }

  detailPath(index) {
    return path.join(this.directory, `diagnostics-${index}.enc`);
  }
}

function classifyFault(error) {
  const name = ALLOWED_ERROR_NAMES.has(error?.name) ? error.name : 'Error';
  const searchable = [error?.name, error?.code, error?.message].filter(Boolean).join(' ');
  const match = FAULT_CLASSIFIERS.find((classifier) => classifier.pattern.test(searchable));
  return {
    name,
    classification: match?.classification || 'UNCLASSIFIED_FAILURE',
    reference: match?.reference
  };
}

function normaliseStoredEntry(entry) {
  const definition = EVENT_DEFINITIONS[entry.event];
  const normalised = {
    timestamp: new Date(entry.timestamp).toISOString(),
    level: definition.level,
    event: entry.event,
    reference: ALLOWED_REFERENCES.has(entry.reference) ? entry.reference : definition.reference,
    stage: definition.stage,
    appVersion: safeIdentifier(entry.appVersion, 'unknown'),
    platform: safeIdentifier(entry.platform, 'unknown'),
    architecture: safeIdentifier(entry.architecture, 'unknown'),
    session: /^[a-f0-9]{8}$/i.test(entry.session) ? entry.session : 'unknown'
  };
  for (const field of definition.fields || []) {
    const value = sanitiseField(field, entry[field]);
    if (value) normalised[field] = value;
  }
  const classification = ALLOWED_CLASSIFICATIONS.has(entry.fault?.classification) ? entry.fault.classification : null;
  if (classification) {
    normalised.fault = {
      name: ALLOWED_ERROR_NAMES.has(entry.fault?.name) ? entry.fault.name : 'Error',
      classification
    };
  }
  return normalised;
}

function sanitiseField(field, value) {
  if (field === 'documentType') return ALLOWED_DOCUMENT_TYPES.has(value) ? value : null;
  if (field === 'reasonCode') return ALLOWED_REASON_CODES.has(value) ? value : null;
  if (field === 'fileType') {
    const extension = String(value || '').toLowerCase().replace(/^\./, '');
    return ALLOWED_FILE_TYPES.has(extension) ? extension : null;
  }
  return null;
}

function safeIdentifier(value, fallback) {
  const identifier = String(value || '').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 40);
  return identifier || fallback;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function isValidEntry(entry) {
  return Boolean(entry && typeof entry === 'object' && EVENT_DEFINITIONS[entry.event] && !Number.isNaN(Date.parse(entry.timestamp)));
}

async function readJsonLines(target) {
  const contents = await fs.readFile(target, 'utf8').catch((error) => error.code === 'ENOENT' ? '' : Promise.reject(error));
  return contents.split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function atomicWrite(destination, contents) {
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    if (!['EEXIST', 'EPERM'].includes(error.code)) throw error;
    await fs.unlink(destination).catch((unlinkError) => {
      if (unlinkError.code !== 'ENOENT') throw unlinkError;
    });
    await fs.rename(temporary, destination);
  }
}
