import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyCreditReportImportPlan, buildCreditReportImportPlan } from '../credit-report-intelligence.js';
import { FinanceDataStore, RECOVERY_MODES, RecoveryModeError } from '../data-store.js';
import { debtSafetyAssessment } from '../finance-core.js';
import {
  activeReviewItems, groupReviewItems, resolveReviewItem, reviewInboxSummary,
  snoozeReviewItem, startReviewItem, synchroniseReviewItems
} from '../review-lifecycle.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('uncategorised payment creates review work and categorising it resolves without regeneration', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 100 });
  state.transactions.push(transaction({ id: 'payment-1', description: 'Fictional Grocer' }));

  synchroniseReviewItems(state, new Date('2026-08-09T09:00:00.000Z'));
  const item = activeReviewItems(state)[0];
  assert.equal(item.type, 'uncategorised_payment');

  state.transactions[0].budgetCategoryId = 'food';
  state.transactions[0].category = 'Food';
  state.transactions[0].categorySource = 'manual';
  synchroniseReviewItems(state, new Date('2026-08-09T09:05:00.000Z'));
  assert.equal(activeReviewItems(state).length, 0);
  assert.equal(state.reviewItems[0].status, 'resolved');

  synchroniseReviewItems(state, new Date('2026-08-09T09:06:00.000Z'));
  assert.equal(state.reviewItems.length, 1);
  assert.equal(state.reviewItems[0].status, 'resolved');
});

test('possible duplicate decisions persist for Duplicate and Both are genuine', () => {
  const duplicateState = baseState();
  duplicateState.transactions.push(transaction({ id: 'possible-1', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false, duplicateCandidateId: 'existing-1' }));
  synchroniseReviewItems(duplicateState);
  resolveReviewItem(duplicateState, duplicateState.reviewItems[0].id, 'duplicate', new Date('2026-08-09T10:00:00.000Z'));
  assert.equal(duplicateState.transactions[0].reviewStatus, 'rejected');
  assert.equal(duplicateState.transactions[0].financiallyActive, false);
  assert.equal(duplicateState.reviewItems[0].resolution.decision, 'duplicate');
  synchroniseReviewItems(duplicateState);
  assert.equal(duplicateState.reviewItems.length, 1);

  const genuineState = baseState();
  genuineState.transactions.push(transaction({ id: 'possible-2', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false, duplicateCandidateId: 'existing-2' }));
  synchroniseReviewItems(genuineState);
  resolveReviewItem(genuineState, genuineState.reviewItems[0].id, 'both_genuine', new Date('2026-08-09T10:00:00.000Z'));
  assert.equal(genuineState.transactions[0].reviewStatus, 'accepted');
  assert.equal(genuineState.transactions[0].financiallyActive, true);
  assert.equal(activeReviewItems(genuineState).some((item) => item.type === 'possible_duplicate'), false);
});

test('snoozed work disappears now and automatically returns when due', () => {
  const state = baseState();
  state.transactions.push(transaction());
  const now = new Date('2026-08-09T09:00:00.000Z');
  synchroniseReviewItems(state, now);
  snoozeReviewItem(state, state.reviewItems[0].id, 'tomorrow', now);

  assert.equal(activeReviewItems(state, new Date('2026-08-09T12:00:00.000Z')).length, 0);
  assert.equal(state.reviewItems[0].status, 'snoozed');
  assert.equal(activeReviewItems(state, new Date('2026-08-10T10:00:00.000Z')).length, 1);
  assert.equal(state.reviewItems[0].status, 'needs_attention');
});

test('payday snooze is unavailable until a payday is genuinely known', () => {
  const state = baseState();
  state.transactions.push(transaction());
  synchroniseReviewItems(state);
  assert.throws(() => snoozeReviewItem(state, state.reviewItems[0].id, 'payday'), /not known/i);
  state.profile.paydayDay = 28;
  snoozeReviewItem(state, state.reviewItems[0].id, 'payday', new Date('2026-08-09T09:00:00.000Z'));
  assert.match(state.reviewItems[0].snoozedUntil, /^2026-08-28T/);
});

test('related uncategorised payments group by merchant while retaining source-level resolution', () => {
  const state = baseState();
  state.transactions.push(
    transaction({ id: 'one', description: 'Fictional Grocer 1234', outgoing: 20 }),
    transaction({ id: 'two', description: 'Fictional Grocer 5678', outgoing: 30 }),
    transaction({ id: 'three', description: 'Different Merchant', outgoing: 10 })
  );
  synchroniseReviewItems(state);
  const groups = groupReviewItems(activeReviewItems(state), state);
  assert.equal(groups.length, 2);
  assert.equal(groups.find((group) => group.items.length === 2).presentation.title, '2 Fictional Grocer payments need categorising');
});

test('credit-report conflicts create review work without overwriting trusted balances', () => {
  const state = baseState();
  state.documents.push({ id: 'document-1', parseStatus: 'ready' });
  state.debts.push({
    id: 'debt-1', name: 'Fictional Card', type: 'Credit card', accountReference: '1234', currentBalance: 700,
    balanceEffectiveDate: '2026-08-07', balanceSourceProvider: 'transunion', contractualPayment: 30, creditLimit: 1000,
    status: 'current', reportedStatus: 'Current', arrangementStatus: 'none', arrangementConfirmed: false,
    arrangementPayment: null, arrearsAmount: null, statusConflict: false, includeInPlan: true
  });
  const preview = creditPreview();
  const plan = buildCreditReportImportPlan(state, preview, 'document-1');
  assert.equal(plan.accountPlans[0].category, 'conflict');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1', '2026-08-09T12:00:00.000Z');

  assert.equal(applied.state.debts[0].currentBalance, 700);
  const review = activeReviewItems(applied.state).find((item) => item.type === 'import_conflict');
  assert.ok(review);
  assert.equal(debtSafetyAssessment(applied.state).accounts[0].reasonCodes.includes('conflicting_status'), true);

  resolveReviewItem(applied.state, review.id, 'keep_current', new Date('2026-08-09T12:05:00.000Z'));
  assert.equal(applied.state.debts[0].currentBalance, 700);
  assert.equal(activeReviewItems(applied.state).some((item) => item.type === 'import_conflict'), false);
  assert.equal(debtSafetyAssessment(applied.state).accounts[0].reasonCodes.includes('conflicting_status'), false);
});

test('an unresolved saved document can be deliberately kept without applying its import', () => {
  const state = baseState();
  state.documents.push({ id: 'document-1', originalName: 'fictional.pdf', parseStatus: 'needs_review' });
  synchroniseReviewItems(state);
  const review = activeReviewItems(state)[0];
  assert.equal(review.type, 'import_conflict');
  resolveReviewItem(state, review.id, 'ignore_import');
  assert.equal(state.documents[0].parseStatus, 'ignored');
  assert.equal(activeReviewItems(state).length, 0);
});

test('active, in-progress, snoozed and resolved review state survives restart and encrypted backup restore', async (t) => {
  const harness = await createHarness(t);
  let state = (await harness.store.loadState()).state;
  state.transactions.push(
    transaction({ id: 'active', description: 'Active Fictional Payment' }),
    transaction({ id: 'progress', description: 'Progress Fictional Payment' }),
    transaction({ id: 'snoozed', description: 'Snoozed Fictional Payment' }),
    transaction({ id: 'resolved', description: 'Resolved Fictional Payment', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false })
  );
  synchroniseReviewItems(state);
  const snoozed = state.reviewItems.find((item) => item.sourceId === 'snoozed');
  const progress = state.reviewItems.find((item) => item.sourceId === 'progress');
  const resolved = state.reviewItems.find((item) => item.sourceId === 'resolved');
  startReviewItem(state, progress.id);
  snoozeReviewItem(state, snoozed.id, 'next_week');
  resolveReviewItem(state, resolved.id, 'both_genuine');
  state = await harness.store.saveState(state);

  const restarted = new FinanceDataStore(harness.directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  assert.equal(state.reviewItems.find((item) => item.sourceId === 'active').status, 'needs_attention');
  assert.equal(state.reviewItems.find((item) => item.sourceId === 'progress').status, 'in_progress');
  assert.equal(state.reviewItems.find((item) => item.sourceId === 'snoozed').status, 'snoozed');
  assert.equal(state.reviewItems.find((item) => item.sourceId === 'resolved').status, 'resolved');

  const backupPath = path.join(harness.directory, 'review-state.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  const changed = structuredClone(state);
  changed.transactions = [];
  await restarted.saveState(changed);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.reviewItems.find((item) => item.sourceId === 'snoozed').status, 'snoozed');
  assert.equal(restored.state.reviewItems.find((item) => item.sourceId === 'resolved').resolution.decision, 'both_genuine');
});

test('recovery mode remains authoritative over duplicate decisions that mutate financial state', async (t) => {
  const harness = await createHarness(t);
  let state = (await harness.store.loadState()).state;
  state.transactions.push(transaction({ duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false }));
  state = await harness.store.saveState(state);
  const attempted = structuredClone(state);
  resolveReviewItem(attempted, attempted.reviewItems[0].id, 'both_genuine');
  harness.store.mode = RECOVERY_MODES.REQUIRED;
  await assert.rejects(harness.store.saveState(attempted), (error) => error instanceof RecoveryModeError);
  harness.store.mode = RECOVERY_MODES.NORMAL;
  const unchanged = (await harness.store.loadState()).state;
  assert.equal(unchanged.transactions[0].reviewStatus, 'pending');
  assert.equal(unchanged.reviewItems[0].status, 'needs_attention');
});

test('inbox summary uses restrained grouped counts and does not count snoozed work as active', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'one', description: 'Fictional Shop 1' }), transaction({ id: 'two', description: 'Fictional Shop 2' }));
  synchroniseReviewItems(state);
  snoozeReviewItem(state, state.reviewItems[0].id, 'next_week');
  const summary = reviewInboxSummary(state);
  assert.equal(summary.total, 1);
  assert.equal(summary.snoozed.length, 1);
});

test('large grouped review sources retain every active payment without flooding the visible inbox', () => {
  const state = baseState();
  state.transactions = Array.from({ length: 6000 }, (_, index) => transaction({ id: `bulk-${index}`, description: `Fictional Bulk Merchant ${index}` }));
  synchroniseReviewItems(state);
  const summary = reviewInboxSummary(state);
  assert.equal(state.reviewItems.filter((item) => item.status !== 'resolved').length, 6000);
  assert.equal(summary.total, 1);
  assert.equal(summary.groups[0].items.length, 6000);
});

function baseState() {
  return {
    schemaVersion: 8, meta: { createdAt: '2026-08-09T08:00:00.000Z', updatedAt: '2026-08-09T08:00:00.000Z', revision: 0 },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: null },
    accounts: [], transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [], budgets: [],
    scheduledPayments: [], documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    settings: { selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 500, emergencyBufferBalance: 0, extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 }, snoozedActions: {} }
  };
}

function transaction(overrides = {}) {
  return {
    id: 'payment-1', accountId: 'account-1', date: '2026-08-09', budgetMonth: '2026-08', description: 'Fictional Payment',
    incoming: 0, outgoing: 10, budgetCategoryId: '', category: '', categorySource: 'manual', budgetTreatment: 'auto',
    transferStatus: 'no', duplicateStatus: 'none', reviewStatus: 'not_required', financiallyActive: true, ...overrides
  };
}

function creditPreview() {
  return {
    kind: 'credit-report', warnings: [], rejected: [], reconciled: true,
    summary: { provider: 'Experian', reportDate: '2026-08-07', score: 700, scoreMaximum: 999 },
    records: [{
      id: 'report-1', provider: 'Experian', reportDate: '2026-08-07', score: 700, scoreMaximum: 999,
      accounts: [{
        id: 'reported-1', lender: 'Fictional Card', accountType: 'Credit card', normalisedAccountType: 'credit-card', accountReference: '1234',
        currentBalance: 800, creditLimit: 1000, contractualPayment: 30, apr: null, status: 'Default', normalisedStatus: 'defaulted',
        arrangementStatus: 'none', updatedDate: '2026-08-07', defaultDate: '', arrearsAmount: null, arrangementPayment: null, interestFrozen: false
      }]
    }]
  };
}

async function createHarness(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-review-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage(), appVersion: '2.1.22' });
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
