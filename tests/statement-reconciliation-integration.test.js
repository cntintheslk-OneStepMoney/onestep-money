import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FinanceDataStore } from '../data-store.js';
import { isTransactionFinanciallyActive } from '../finance-core.js';
import { activeReviewItems } from '../review-lifecycle.js';
import { applyStatementImportPlan, buildStatementImportPlan } from '../statement-intelligence.js';
import { buildStatementReconciliationPlan, STATEMENT_RECONCILIATION_CLASS } from '../statement-reconciliation.js';

const seedPath = new URL('../seed-data.json', import.meta.url);
const passphrase = 'fictional-reconciliation-backup';

const transaction = (overrides = {}) => ({
  id: overrides.id || `transaction-${Math.random()}`,
  accountId: 'account-1',
  date: '2026-08-01',
  description: 'Fictional merchant',
  reference: 'REF-1',
  providerTransactionId: '',
  incoming: 0,
  outgoing: 10,
  runningBalance: 90,
  transferStatus: 'no',
  ...overrides
});

const baseState = () => ({
  meta: { revision: 12 },
  profile: { currency: 'GBP' },
  accounts: [{ id: 'account-1', name: 'Main account', institution: 'Fictional Bank', accountReference: '••••1234', type: 'Current account', currentBalance: 100, statementDate: '2026-07-31' }],
  transactions: [],
  overdrafts: [],
  documents: [{ id: 'document-1', kind: 'statement', parseStatus: 'ready' }],
  importBatches: [],
  reviewItems: [],
  budgets: [],
  debts: [],
  tasks: []
});

const statementPreview = (records, overrides = {}) => ({
  kind: 'statement',
  accountHint: 'account-1',
  records,
  rejected: [],
  warnings: [],
  reconciled: true,
  accountIdentity: { institution: 'Fictional Bank', accountReference: '••••1234', accountType: 'Current account', currency: 'GBP' },
  summary: { openingBalance: 100, closingBalance: 90, statementStartDate: '2026-08-01', statementEndDate: '2026-08-01', currency: 'GBP' },
  ...overrides
});

test('exact statement match adds provenance without adding a duplicate transaction', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'existing', sourceDocumentId: 'document-old' }));
  const preview = statementPreview([transaction({ id: 'incoming' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1', '2026-08-11T10:00:00.000Z');

  assert.equal(applied.state.transactions.length, 1);
  assert.deepEqual(applied.state.transactions[0].sourceDocumentIds.sort(), ['document-1', 'document-old']);
  assert.equal(applied.state.transactions[0].reconciliationProvenance[0].documentId, 'document-1');
  assert.equal(applied.result.matchedAutomatically, 1);
  assert.equal(applied.result.newTransactions, 0);
});

test('clear new statement transaction is added once and becomes financially active', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');

  assert.equal(applied.state.transactions.length, 1);
  assert.equal(applied.state.transactions[0].id, 'new-payment');
  assert.equal(applied.result.newTransactions, 1);
  assert.equal(isTransactionFinanciallyActive(applied.state.transactions[0]), true);
});

test('two plausible matches are quarantined and routed to Review Inbox', () => {
  const state = baseState();
  state.transactions.push(
    transaction({ id: 'candidate-one', description: 'Fictional Merchant A', reference: '' }),
    transaction({ id: 'candidate-two', description: 'Fictional Merchant B', reference: '' })
  );
  const preview = statementPreview([transaction({ id: 'ambiguous', description: 'Fictional Merchant C', reference: '' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');
  const ambiguous = applied.state.transactions.find((item) => item.id === 'ambiguous');

  assert.equal(plan.reconciliation.items[0].classification, STATEMENT_RECONCILIATION_CLASS.POSSIBLE_DUPLICATE);
  assert.deepEqual(plan.reconciliation.items[0].candidateTransactionIds.sort(), ['candidate-one', 'candidate-two']);
  assert.equal(ambiguous.duplicateStatus, 'possible');
  assert.equal(ambiguous.reviewStatus, 'pending');
  assert.equal(isTransactionFinanciallyActive(ambiguous), false);
  assert.ok(activeReviewItems(applied.state).some((item) => item.sourceId === 'ambiguous'));
});

test('manual transaction interpretation remains authoritative during reconciliation', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'existing', category: 'Groceries', categorySource: 'manual' }));
  const preview = statementPreview([transaction({ id: 'incoming', category: 'Fuel' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');

  const existing = applied.state.transactions.find((item) => item.id === 'existing');
  const incoming = applied.state.transactions.find((item) => item.id === 'incoming');
  assert.equal(existing.category, 'Groceries');
  assert.equal(existing.categorySource, 'manual');
  assert.equal(incoming.financiallyActive, false);
  assert.equal(plan.reconciliation.items[0].evidence, 'manual-value-conflict');
});

test('re-applying a completed statement document is idempotently rejected without changes', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const firstPlan = buildStatementImportPlan(state, preview, 'document-1');
  const first = applyStatementImportPlan(state, preview, firstPlan, 'document-1');
  const before = structuredClone(first.state);
  const secondPlan = buildStatementImportPlan(first.state, preview, 'document-1');

  assert.throws(
    () => applyStatementImportPlan(first.state, preview, secondPlan, 'document-1'),
    (error) => error.code === 'STATEMENT_IMPORT_ALREADY_APPLIED'
  );
  assert.deepEqual(first.state, before);
  assert.equal(first.state.transactions.length, 1);
  assert.equal(first.state.importBatches.length, 1);
});

test('partial reconciliation failure leaves the original state untouched', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const before = structuredClone(state);

  assert.throws(() => applyStatementImportPlan(state, preview, plan, 'document-1', '2026-08-11T10:00:00.000Z', {
    faultInjector(point) {
      if (point === 'after-new-records') throw new Error('fictional reconciliation failure');
    }
  }), /fictional reconciliation failure/);
  assert.deepEqual(state, before);
});

test('state revision change blocks a stale reconciliation plan', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  state.meta.revision += 1;

  assert.throws(
    () => applyStatementImportPlan(state, preview, plan, 'document-1'),
    (error) => error.code === 'STATEMENT_RECONCILIATION_STALE_REVISION'
  );
  assert.equal(state.transactions.length, 0);
  assert.equal(state.importBatches.length, 0);
});

test('restart and portable backup/restore preserve reconciliation provenance', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-reconciliation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage(), appVersion: '2.1.26' });
  await store.initialise();
  let state = (await store.loadState()).state;
  state.transactions.push({
    ...transaction({ id: 'reconciled', sourceDocumentId: 'document-fictional', sourceDocumentIds: ['document-fictional'] }),
    duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true,
    reconciliationProvenance: [{
      documentId: 'document-fictional', importBatchId: 'batch-fictional', reconciledAt: '2026-08-11T10:00:00.000Z',
      evidence: 'transaction-identity', classification: 'exact_authoritative_match'
    }]
  });
  state = await store.saveState(state);

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage(), appVersion: '2.1.26' });
  await restarted.initialise();
  const reloaded = (await restarted.loadState()).state;
  assert.equal(reloaded.transactions[0].reconciliationProvenance[0].documentId, 'document-fictional');

  const backup = path.join(directory, 'reconciliation.osmb');
  await restarted.createPortableBackup(backup, passphrase, reloaded);
  const changed = structuredClone(reloaded);
  changed.transactions = [];
  await restarted.saveState(changed);
  const restored = await restarted.restorePortableBackup(backup, passphrase);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.transactions[0].reconciliationProvenance[0].importBatchId, 'batch-fictional');
});

test('large fictional multi-month reconciliation remains bounded', () => {
  const existing = [];
  const incoming = [];
  for (let index = 0; index < 20_000; index += 1) {
    existing.push(transaction({
      id: `existing-${index}`,
      date: `2025-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
      outgoing: (index % 997) + 0.01,
      description: `Fictional merchant ${index}`,
      reference: `REF-${index}`
    }));
  }
  for (let index = 0; index < 2_000; index += 1) {
    incoming.push(transaction({
      id: `incoming-${index}`,
      date: `2026-${String((index % 8) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
      outgoing: 5_000 + index + 0.01,
      description: `New fictional merchant ${index}`,
      reference: `NEW-${index}`
    }));
  }
  const started = performance.now();
  const plan = buildStatementReconciliationPlan({ meta: { revision: 1 }, transactions: existing }, { records: incoming }, { documentId: 'fictional-performance-document' });
  const elapsed = performance.now() - started;
  assert.equal(plan.counts.newTransactions, 2_000);
  assert.ok(elapsed < 2_500, `reconciliation took ${elapsed.toFixed(1)}ms`);
});

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
