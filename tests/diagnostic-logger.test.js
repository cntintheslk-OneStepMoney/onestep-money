import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DiagnosticLogger } from '../diagnostic-logger.js';

test('diagnostics keep approved fault metadata and redact raw error details', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory);

  await logger.initialise();
  await logger.record('APP_STARTED', { arbitrary: 'must-not-be-stored' });
  const result = await logger.record('DOCUMENT_IMPORT_FAILED', {
    documentType: 'payslip',
    fileType: '.pdf',
    originalName: 'private-payslip.pdf',
    error: new ReferenceError('DOMMatrix is not defined at C:\\Users\\Private\\pay.pdf account 12345678')
  });

  assert.equal(result.reference, 'PDF-104');
  const report = await logger.buildReport();
  assert.match(report.text, /PDF-104 DOCUMENT_IMPORT_FAILED/);
  assert.match(report.text, /classification=PDF_RENDER_DOMMATRIX_MISSING/);
  assert.match(report.text, /document_type=payslip file_type=pdf/);
  assert.doesNotMatch(report.text, /private-payslip|12345678|C:\\Users|must-not-be-stored/);

  const encryptedFile = await fs.readFile(path.join(directory, 'diagnostics', 'diagnostics-0.enc'), 'utf8');
  assert.doesNotMatch(encryptedFile, /DOMMatrix|12345678|Private/);
});

test('diagnostics retain supported credit-report and statement classifications without sensitive context', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory);

  await logger.record('DOCUMENT_IMPORT_FAILED', {
    documentType: 'credit-report', fileType: 'pdf',
    error: new Error('Fictional private credit reference and value £1234.56')
  });
  for (const fileType of ['tsv', 'txt', 'qfx']) {
    await logger.record('DOCUMENT_IMPORT_FAILED', {
      documentType: 'statement', fileType,
      error: new Error(`private-${fileType}-filename account 12345678`)
    });
  }
  const report = await logger.buildReport();

  assert.match(report.text, /document_type=credit-report file_type=pdf/);
  assert.match(report.text, /document_type=statement file_type=tsv/);
  assert.match(report.text, /document_type=statement file_type=txt/);
  assert.match(report.text, /document_type=statement file_type=qfx/);
  assert.doesNotMatch(report.text, /1234\.56|12345678|private-|credit reference/);
});

test('priority diagnostics retain only privacy-safe technical references', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory);

  await logger.record('PRIORITY_EVALUATION_FAILED', { amount: 999, description: 'Private payment detail' });
  await logger.record('NEXT_MOVE_UNAVAILABLE', { account: 'Private account' });
  await logger.record('ACTION_CONSOLIDATION_INVALID', { merchant: 'Private merchant' });
  const report = await logger.buildReport();

  assert.match(report.text, /UI-105 PRIORITY_EVALUATION_FAILED/);
  assert.match(report.text, /UI-106 NEXT_MOVE_UNAVAILABLE/);
  assert.match(report.text, /UI-107 ACTION_CONSOLIDATION_INVALID/);
  assert.doesNotMatch(report.text, /999|Private payment|Private account|Private merchant/);
});

test('parser compatibility diagnostics retain only approved classifications', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory);

  await logger.record('DOCUMENT_IMPORT_FAILED', {
    documentType: 'payslip', fileType: '.pdf', providerFamily: 'mynavy',
    recognitionStage: 'required_fields', failureCategory: 'missing_required_fields', reconciliationOutcome: 'failed',
    originalName: 'Private Person August Payslip.pdf', amount: 9876.54, documentText: 'Private account and address'
  });
  await logger.record('DOCUMENT_IMPORT_FAILED', {
    documentType: 'statement', fileType: '.pdf', providerFamily: 'Unapproved Private Bank',
    recognitionStage: 'private-stage', failureCategory: 'private-category', reconciliationOutcome: 'private-outcome'
  });
  const report = await logger.buildReport();

  assert.match(report.text, /provider_family=mynavy/);
  assert.match(report.text, /recognition_stage=required_fields/);
  assert.match(report.text, /failure_category=missing_required_fields/);
  assert.match(report.text, /reconciliation=failed/);
  assert.doesNotMatch(report.text, /Private Person|9876|account and address|Unapproved Private Bank|private-stage|private-category|private-outcome/);
});

test('detailed diagnostics are not written when secure storage is unavailable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory, false);

  await logger.initialise();
  await logger.record('APP_STARTED');
  await logger.record('SECURE_STORAGE_UNAVAILABLE');
  const result = await logger.record('STATE_SAVE_FAILED', { error: new Error('private detail') });
  const report = await logger.buildReport();

  assert.equal(result.stored, false);
  assert.equal(report.entryCount, 2);
  assert.match(report.text, /minimal startup events are retained/);
  await assert.rejects(fs.access(path.join(directory, 'diagnostics', 'diagnostics-0.enc')));
});

test('recovery diagnostics retain only safe reason codes', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory);

  await logger.record('STATE_RECOVERY_REQUIRED', {
    reasonCode: 'decryption_failure',
    error: new Error('balance £9876.54 key=fictional-secret decrypted={"name":"Private User"}')
  });
  await logger.record('BACKUP_RESTORE_FAILED', {
    reasonCode: 'restore_rollback_failed',
    error: new Error('raw PDF body and fictional account token must not be retained')
  });
  const report = await logger.buildReport();

  assert.match(report.text, /DAT-103 STATE_RECOVERY_REQUIRED/);
  assert.match(report.text, /reason_code=decryption_failure/);
  assert.match(report.text, /BAK-102 BACKUP_RESTORE_FAILED.*reason_code=restore_rollback_failed/);
  assert.doesNotMatch(report.text, /9876|fictional-secret|Private User|decrypted|raw PDF body|fictional account token/);
});

test('diagnostics expire after fourteen days and can be deleted locally', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let now = new Date('2026-08-01T12:00:00.000Z');
  const logger = createLogger(directory, true, () => new Date(now));

  await logger.record('APP_STARTED');
  await logger.record('DOCUMENT_IMPORT_FAILED', { documentType: 'statement', fileType: 'csv', error: new Error('failure') });
  now = new Date('2026-08-16T12:00:01.000Z');
  assert.equal((await logger.buildReport()).entryCount, 0);

  await logger.record('APP_READY');
  assert.equal((await logger.buildReport()).entryCount, 1);
  await logger.deleteAll();
  assert.equal((await logger.buildReport()).entryCount, 0);
});

test('encrypted detail logs rotate within the configured file limit', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-diagnostics-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const logger = createLogger(directory, true, undefined, { maxFileBytes: 280, maxFiles: 3 });

  for (let index = 0; index < 12; index += 1) {
    await logger.record('STATE_SAVE_FAILED', { error: new Error(`failure ${index}`) });
  }
  const files = (await fs.readdir(path.join(directory, 'diagnostics'))).filter((name) => /^diagnostics-\d+\.enc$/.test(name));
  assert.ok(files.length <= 3);
  assert.ok(files.includes('diagnostics-0.enc'));
});

function createLogger(directory, available = true, clock, extra = {}) {
  const secureStorage = {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
  return new DiagnosticLogger(directory, {
    secureStorage,
    appVersion: '2.1.1',
    platform: 'win32',
    architecture: 'x64',
    clock,
    ...extra
  });
}
