import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { classifyImportCompatibility, DocumentImportCoordinator, IMPORT_OUTCOMES } from '../document-deduplication.js';

const baseState = () => ({
  accounts: [], transactions: [], payslips: [], creditReports: [], debts: [], overdrafts: [], documents: [], importBatches: []
});

test('duplicate outcomes use a calm dedicated result dialog with no override', () => {
  const markup = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');
  assert.match(markup, /id="importResultDialog"/);
  assert.match(markup, /Already imported/);
  assert.match(renderer, /OneStep recognised this document from its contents/);
  assert.doesNotMatch(`${markup}\n${renderer}`, /Import anyway/i);
});

test('import compatibility failures become privacy-safe diagnostic classifications', () => {
  assert.deepEqual(classifyImportCompatibility({
    records: [], rejected: [{ reason: 'Required labelled total is missing from this unsupported layout.' }],
    warnings: [], summary: { provider: 'mynavy' }, reconciled: false
  }), {
    providerFamily: 'mynavy', recognitionStage: 'layout_detection', failureCategory: 'unsupported_layout', reconciliationOutcome: 'failed'
  });
  assert.equal(classifyImportCompatibility({ records: [], rejected: [], warnings: [], summary: { provider: 'Private Bank Name' } }).providerFamily, 'unknown');
});

test('a first payslip is stored, parsed and offered for review exactly once', async () => {
  const harness = createHarness({ '/July-Payslip.pdf': 'fictional july payslip' }, payslipPreview('2026-07'));
  const results = await harness.process(['/July-Payslip.pdf'], 'payslip');

  assert.equal(results[0].status, IMPORT_OUTCOMES.READY);
  assert.equal(harness.store.vaultWrites, 1);
  assert.equal(harness.parseCalls(), 1);
  assert.equal(harness.store.backups, 1);
  assert.equal(harness.state.documents.length, 1);
  assert.equal(harness.state.importBatches.length, 0);
});

test('a completed payslip duplicate is terminal before parsing and cannot mutate financial state', async () => {
  const harness = createHarness({ '/July-Payslip.pdf': 'fictional july payslip' }, payslipPreview('2026-07'));
  await harness.process(['/July-Payslip.pdf'], 'payslip');
  completeImport(harness.state, 'payslip');
  harness.state.payslips.push({ id: 'payslip-2026-07', netPay: 2400 });
  const before = structuredClone(harness.state);
  const callsBefore = harness.parseCalls();
  const backupsBefore = harness.store.backups;

  const results = await harness.process(['/July-Payslip.pdf'], 'payslip');

  assert.equal(results[0].status, IMPORT_OUTCOMES.DUPLICATE);
  assert.equal(harness.parseCalls(), callsBefore);
  assert.equal(harness.store.vaultWrites, 1);
  assert.equal(harness.store.backups, backupsBefore);
  assert.deepEqual(harness.state, before);
});

test('renamed and copied payslips are matched only by identical contents', async () => {
  const harness = createHarness({
    '/original/July-Payslip.pdf': 'fictional july payslip',
    '/renamed/Payslip-July-Renamed.pdf': 'fictional july payslip',
    '/copy/Payslip-copy.pdf': 'fictional july payslip'
  }, payslipPreview('2026-07'));
  await harness.process(['/original/July-Payslip.pdf'], 'payslip');
  completeImport(harness.state, 'payslip');

  const results = await harness.process(['/renamed/Payslip-July-Renamed.pdf', '/copy/Payslip-copy.pdf'], 'payslip');

  assert.deepEqual(results.map((result) => result.status), [IMPORT_OUTCOMES.DUPLICATE, IMPORT_OUTCOMES.DUPLICATE]);
  assert.equal(harness.store.vaultWrites, 1);
});

test('consecutive payslips with different bytes both proceed', async () => {
  const harness = createHarness({ '/July.pdf': 'fictional july payslip', '/August.pdf': 'fictional august payslip' }, payslipPreview('2026-08'));

  const results = await harness.process(['/July.pdf', '/August.pdf'], 'payslip');

  assert.deepEqual(results.map((result) => result.status), [IMPORT_OUTCOMES.READY, IMPORT_OUTCOMES.READY]);
  assert.equal(harness.store.vaultWrites, 2);
  assert.equal(harness.parseCalls(), 2);
});

for (const scenario of [
  { kind: 'statement', financialKey: 'transactions' },
  { kind: 'credit-report', financialKey: 'creditReports' }
]) {
  test(`an exact completed ${scenario.kind} duplicate does not parse or change financial records`, async () => {
    const file = `/fictional-${scenario.kind}.pdf`;
    const harness = createHarness({ [file]: `fictional ${scenario.kind} bytes` }, genericPreview(scenario.kind));
    await harness.process([file], scenario.kind);
    completeImport(harness.state, scenario.kind);
    harness.state[scenario.financialKey].push({ id: `existing-${scenario.kind}`, amount: 123 });
    const before = structuredClone(harness.state);
    const callsBefore = harness.parseCalls();

    const results = await harness.process([file], scenario.kind);

    assert.equal(results[0].status, IMPORT_OUTCOMES.DUPLICATE);
    assert.equal(harness.parseCalls(), callsBefore);
    assert.deepEqual(harness.state, before);
  });
}

test('different overlapping statements are not rejected as document duplicates', async () => {
  const harness = createHarness({ '/July.pdf': 'date,shared transaction,july', '/August.pdf': 'date,shared transaction,august' }, genericPreview('statement'));
  const results = await harness.process(['/July.pdf', '/August.pdf'], 'statement');
  assert.deepEqual(results.map((result) => result.status), [IMPORT_OUTCOMES.READY, IMPORT_OUTCOMES.READY]);
});

test('a same-selection duplicate creates one preview and one pending outcome', async () => {
  const harness = createHarness({ '/Payslip.pdf': 'same fictional bytes', '/Payslip-copy.pdf': 'same fictional bytes' }, payslipPreview('2026-07'));

  const results = await harness.process(['/Payslip.pdf', '/Payslip-copy.pdf'], 'payslip');

  assert.deepEqual(results.map((result) => result.status), [IMPORT_OUTCOMES.READY, IMPORT_OUTCOMES.PENDING]);
  assert.equal(harness.store.vaultWrites, 1);
  assert.equal(harness.parseCalls(), 1);
});

test('a mixed multi-file selection continues unique files around a duplicate', async () => {
  const harness = createHarness({ '/A.pdf': 'same A bytes', '/B.pdf': 'unique B bytes', '/A-copy.pdf': 'same A bytes' }, payslipPreview('2026-07'));

  const results = await harness.process(['/A.pdf', '/B.pdf', '/A-copy.pdf'], 'payslip');

  assert.deepEqual(results.map((result) => result.status), [IMPORT_OUTCOMES.READY, IMPORT_OUTCOMES.READY, IMPORT_OUTCOMES.PENDING]);
  assert.equal(harness.store.vaultWrites, 2);
});

test('two simultaneous selections are serialized so identical bytes cannot both pass', async () => {
  const harness = createHarness({ '/one.pdf': 'same concurrent bytes', '/two.pdf': 'same concurrent bytes' }, payslipPreview('2026-07'));

  const [first, second] = await Promise.all([
    harness.process(['/one.pdf'], 'payslip'),
    harness.process(['/two.pdf'], 'payslip')
  ]);

  assert.equal(first[0].status, IMPORT_OUTCOMES.READY);
  assert.equal(second[0].status, IMPORT_OUTCOMES.PENDING);
  assert.equal(harness.store.vaultWrites, 1);
});

test('completed identity persists across coordinator restart and restored state', async () => {
  const harness = createHarness({ '/renamed.pdf': 'persistent fictional bytes' }, payslipPreview('2026-07'));
  await harness.process(['/renamed.pdf'], 'payslip');
  completeImport(harness.state, 'payslip');
  const restoredState = structuredClone(harness.state);
  const restarted = createHarness({ '/renamed.pdf': 'persistent fictional bytes' }, payslipPreview('2026-07'), restoredState);

  const results = await restarted.process(['/renamed.pdf'], 'payslip');

  assert.equal(results[0].status, IMPORT_OUTCOMES.DUPLICATE);
  assert.equal(restarted.parseCalls(), 0);
  assert.equal(restarted.store.vaultWrites, 0);
});

test('a failed stored document is retryable without another vault copy', async () => {
  let shouldFail = true;
  const harness = createHarness({ '/retry.pdf': 'retryable fictional bytes' }, () => {
    if (shouldFail) throw new Error('fictional parser failure');
    return payslipPreview('2026-07');
  });

  const failed = await harness.process(['/retry.pdf'], 'payslip');
  shouldFail = false;
  const retried = await harness.process(['/retry.pdf'], 'payslip');

  assert.equal(failed[0].status, IMPORT_OUTCOMES.FAILED);
  assert.equal(retried[0].status, IMPORT_OUTCOMES.READY);
  assert.equal(retried[0].retry, true);
  assert.equal(harness.store.vaultWrites, 1);
});

test('a pending preview cannot create a second independent confirmation path', async () => {
  const harness = createHarness({ '/pending.pdf': 'pending fictional bytes' }, payslipPreview('2026-07'));
  await harness.process(['/pending.pdf'], 'payslip');
  const callsBefore = harness.parseCalls();

  const results = await harness.process(['/pending.pdf'], 'payslip');

  assert.equal(results[0].status, IMPORT_OUTCOMES.PENDING);
  assert.equal(harness.parseCalls(), callsBefore);
});

test('a deleted completed source keeps canonical fingerprint provenance', async () => {
  const harness = createHarness({ '/deleted-source.pdf': 'deleted source bytes' }, genericPreview('statement'));
  await harness.process(['/deleted-source.pdf'], 'statement');
  completeImport(harness.state, 'statement');
  harness.state.documents[0].deletedAt = '2026-08-08T12:00:00.000Z';
  harness.state.documents[0].parseStatus = 'deleted';

  const results = await harness.process(['/deleted-source.pdf'], 'statement');

  assert.equal(results[0].status, IMPORT_OUTCOMES.DUPLICATE);
  assert.equal(harness.store.vaultWrites, 1);
});

function createHarness(files, preview, initialState = baseState()) {
  const stateHolder = { value: initialState };
  const store = new FakeStore(files);
  let parseCalls = 0;
  const coordinator = new DocumentImportCoordinator({
    store,
    extractPdfDocument: async (filePath) => files[filePath],
    parseImportedDocument: (...args) => {
      parseCalls += 1;
      return typeof preview === 'function' ? preview(...args) : structuredClone(preview);
    },
    recordFailure: async () => ({ reference: 'IMP-TEST' }),
    canonicalDocumentName: (document) => document.originalName
  });
  return {
    store,
    get state() { return stateHolder.value; },
    parseCalls: () => parseCalls,
    process: (filePaths, kind) => coordinator.processSelection({
      filePaths,
      kind,
      getState: () => stateHolder.value,
      saveState: async (state) => {
        store.saves += 1;
        stateHolder.value = state;
        return state;
      }
    })
  };
}

class FakeStore {
  constructor(files) {
    this.files = files;
    this.vaultWrites = 0;
    this.backups = 0;
    this.saves = 0;
  }

  async createAutomaticBackup() {
    this.backups += 1;
  }

  async inspectDocument(filePath, documents) {
    const bytes = Buffer.from(this.files[filePath]);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const document = documents.find((item) => item.sha256 === sha256) || null;
    return { filePath, bytes, sha256, document, duplicate: Boolean(document) };
  }

  async storeDocument(filePath, kind, documents, prepared) {
    const duplicate = documents.find((item) => item.sha256 === prepared.sha256);
    if (duplicate) return { duplicate: true, document: duplicate };
    this.vaultWrites += 1;
    const id = `00000000-0000-4000-8000-${String(this.vaultWrites).padStart(12, '0')}`;
    return {
      duplicate: false,
      document: {
        id,
        originalName: filePath.split('/').at(-1),
        storedName: `${id}.vault`,
        kind,
        size: prepared.bytes.length,
        sha256: prepared.sha256,
        importedAt: '2026-08-08T12:00:00.000Z',
        parseStatus: 'pending',
        linkedRecordIds: []
      }
    };
  }
}

function completeImport(state, kind) {
  const document = state.documents[0];
  document.parseStatus = 'imported';
  state.importBatches.push({ id: `batch-${kind}`, documentId: document.id, kind, importedAt: '2026-08-08T12:05:00.000Z', recordCount: 1 });
}

function payslipPreview(period) {
  return {
    kind: 'payslip',
    records: [{ id: `payslip-${period}`, period, netPay: 2400 }],
    rejected: [], warnings: [], summary: { period, gross: 3000, deductions: 600, net: 2400 }, reconciled: true
  };
}

function genericPreview(kind) {
  return {
    kind,
    records: kind === 'credit-report'
      ? [{ id: 'report-1', accounts: [{ id: 'debt-1', currentBalance: 500 }] }]
      : [{ id: 'transaction-1', date: '2026-07-31', incoming: 100, outgoing: 0 }],
    rejected: [], warnings: [], summary: {}, reconciled: true
  };
}
