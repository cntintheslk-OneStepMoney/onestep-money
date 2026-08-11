import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStatementReconciliationMatches,
  buildStatementReconciliationPlan,
  STATEMENT_RECONCILIATION_CLASS
} from '../statement-reconciliation.js';

const transaction = (overrides = {}) => ({
  id: overrides.id || 'tx-1',
  accountId: 'account-1',
  date: '2026-08-01',
  description: 'Example merchant',
  reference: 'REF-1',
  providerTransactionId: '',
  incoming: 0,
  outgoing: 10,
  runningBalance: 90,
  duplicateStatus: 'none',
  reviewStatus: 'not_required',
  importReviewStatus: 'trusted',
  financiallyActive: true,
  ...overrides
});

const preview = (records) => ({ kind: 'statement', records });
const state = (transactions = []) => ({ meta: { revision: 7 }, transactions });

test('exact transaction match adds provenance without creating a duplicate', () => {
  const existing = transaction({ id: 'existing', sourceDocumentId: 'document-old' });
  const incoming = transaction({ id: 'incoming' });
  const plan = buildStatementReconciliationPlan(state([existing]), preview([incoming]), {
    documentId: 'document-new',
    duplicates: { exact: [{ incoming, existing, evidence: 'transaction-identity' }], possible: [] }
  });
  const working = structuredClone(state([existing]));
  const result = applyStatementReconciliationMatches(working, plan, {
    documentId: 'document-new', importBatchId: 'batch-1', importedAt: '2026-08-11T09:00:00.000Z'
  });

  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH);
  assert.equal(working.transactions.length, 1);
  assert.deepEqual(working.transactions[0].sourceDocumentIds.sort(), ['document-new', 'document-old']);
  assert.equal(working.transactions[0].reconciliationProvenance[0].importBatchId, 'batch-1');
  assert.equal(result.matchedAutomatically, 1);
});

test('clear new statement transaction is classified for one safe add', () => {
  const plan = buildStatementReconciliationPlan(state([]), preview([transaction({ id: 'new' })]), { documentId: 'document-1' });
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.NEW_RECORD);
  assert.equal(plan.counts.newTransactions, 1);
  assert.equal(plan.counts.needsReview, 0);
});

test('two plausible candidates are ambiguous and never automatic', () => {
  const incoming = transaction({ id: 'incoming', description: 'Different display text', reference: '' });
  const existing = [
    transaction({ id: 'one', description: 'First', reference: '' }),
    transaction({ id: 'two', description: 'Second', reference: '' })
  ];
  const plan = buildStatementReconciliationPlan(state(existing), preview([incoming]));
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.POSSIBLE_DUPLICATE);
  assert.equal(plan.items[0].certainty, 'ambiguous');
  assert.equal(plan.items[0].automatic, false);
  assert.deepEqual(plan.items[0].candidateTransactionIds.sort(), ['one', 'two']);
});

test('manual category conflict is routed to review and never overwritten', () => {
  const existing = transaction({ id: 'existing', category: 'Food', categorySource: 'manual' });
  const incoming = transaction({ id: 'incoming', category: 'Fuel' });
  const plan = buildStatementReconciliationPlan(state([existing]), preview([incoming]), {
    duplicates: { exact: [{ incoming, existing, evidence: 'transaction-identity' }], possible: [] }
  });
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.POSSIBLE_DUPLICATE);
  assert.equal(plan.items[0].certainty, 'conflicting');
  assert.equal(plan.items[0].evidence, 'manual-value-conflict');
});

test('trusted statement evidence only fills missing compatible fields', () => {
  const existing = transaction({ id: 'existing', description: '', reference: 'REF-1', providerTransactionId: '' });
  const incoming = transaction({ id: 'incoming', description: 'Example merchant', reference: 'REF-1', providerTransactionId: 'BANK-123' });
  const plan = buildStatementReconciliationPlan(state([existing]), preview([incoming]));
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE);
  assert.deepEqual(plan.items[0].patch, { providerTransactionId: 'BANK-123', description: 'Example merchant' });

  const working = structuredClone(state([existing]));
  applyStatementReconciliationMatches(working, plan, { documentId: 'document-1', importBatchId: 'batch-1' });
  assert.equal(working.transactions[0].description, 'Example merchant');
  assert.equal(working.transactions[0].providerTransactionId, 'BANK-123');
  assert.equal(working.transactions[0].reference, 'REF-1');
});

test('same evidence already linked becomes a no-change item', () => {
  const existing = transaction({ id: 'existing', sourceDocumentId: 'document-1', sourceDocumentIds: ['document-1'] });
  const incoming = transaction({ id: 'incoming' });
  const plan = buildStatementReconciliationPlan(state([existing]), preview([incoming]), {
    documentId: 'document-1',
    duplicates: { exact: [{ incoming, existing, evidence: 'transaction-identity' }], possible: [] }
  });
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.NO_CHANGE);
  assert.equal(plan.counts.noChange, 1);
});

test('stale state revision blocks reconciliation before mutation', () => {
  const existing = transaction({ id: 'existing', sourceDocumentId: '' });
  const incoming = transaction({ id: 'incoming' });
  const plan = buildStatementReconciliationPlan(state([existing]), preview([incoming]), {
    documentId: 'document-1',
    duplicates: { exact: [{ incoming, existing, evidence: 'transaction-identity' }], possible: [] }
  });
  const working = structuredClone(state([existing]));
  working.meta.revision += 1;
  assert.throws(
    () => applyStatementReconciliationMatches(working, plan, { documentId: 'document-1' }),
    (error) => error.code === 'STATEMENT_RECONCILIATION_STALE_REVISION'
  );
  assert.equal(working.transactions[0].sourceDocumentId, '');
});

test('insufficient evidence is review-required and not automatic', () => {
  const incoming = transaction({ id: 'incoming', date: '', outgoing: 0, incoming: 0 });
  const plan = buildStatementReconciliationPlan(state([]), preview([incoming]));
  assert.equal(plan.items[0].classification, STATEMENT_RECONCILIATION_CLASS.REVIEW_REQUIRED);
  assert.equal(plan.items[0].certainty, 'insufficient');
  assert.equal(plan.counts.needsReview, 1);
});

test('reconciliation summary exposes import UI categories without financial content', () => {
  const exactExisting = transaction({ id: 'exact-existing' });
  const exactIncoming = transaction({ id: 'exact-incoming' });
  const newIncoming = transaction({ id: 'new', date: '2026-08-02', outgoing: 20 });
  const ambiguousIncoming = transaction({ id: 'ambiguous', date: '2026-08-03', outgoing: 30, description: 'Unknown', reference: '' });
  const candidates = [
    exactExisting,
    transaction({ id: 'candidate-a', date: '2026-08-03', outgoing: 30, description: 'A', reference: '' }),
    transaction({ id: 'candidate-b', date: '2026-08-03', outgoing: 30, description: 'B', reference: '' })
  ];
  const plan = buildStatementReconciliationPlan(state(candidates), preview([exactIncoming, newIncoming, ambiguousIncoming]), {
    documentId: 'document-2',
    duplicates: { exact: [{ incoming: exactIncoming, existing: exactExisting, evidence: 'transaction-identity' }], possible: [] }
  });
  assert.deepEqual(plan.counts, {
    total: 3,
    matchedAutomatically: 1,
    exactMatches: 1,
    automaticUpdates: 0,
    newTransactions: 1,
    needsReview: 1,
    possibleDuplicates: 1,
    insufficientEvidence: 0,
    duplicatesIgnoredOrQuarantined: 2,
    noChange: 0
  });
});

test('module has no network, telemetry, logging, or statement-content diagnostics', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile(new URL('../statement-reconciliation.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|https?:\/\//i);
  assert.doesNotMatch(source, /console\.|telemetry|analytics/i);
});
