import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPaymentBulkCategorisation, buildPaymentBulkCategorisationPlan, PAYMENT_BULK_CLEAR_VALUE,
  PAYMENT_BULK_INCOME_VALUE, paymentBulkCategoryOptions, paymentBulkEligibility, retainVisiblePaymentSelection
} from '../payment-bulk-review.js';
import { activeReviewItems, synchroniseReviewItems } from '../review-lifecycle.js';

test('bulk categorises several compatible uncategorised expenses together', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one' }), transaction({ id: 'two' }), transaction({ id: 'three' }));
  const plan = buildPaymentBulkCategorisationPlan(state, ['one', 'two', 'three'], 'food');
  assert.equal(plan.valid, true);
  const result = applyPaymentBulkCategorisation(state, plan);
  assert.deepEqual(result.updatedIds, ['one', 'two', 'three']);
  assert.deepEqual(result.state.transactions.map((item) => [item.budgetCategoryId, item.category, item.categorySource]), [
    ['food', 'Food', 'manual'], ['food', 'Food', 'manual'], ['food', 'Food', 'manual']
  ]);
});

test('duplicate selected IDs are applied exactly once', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one' }));
  const plan = buildPaymentBulkCategorisationPlan(state, ['one', 'one', 'one'], 'food');
  assert.equal(plan.selectedCount, 1);
  const result = applyPaymentBulkCategorisation(state, plan);
  assert.deepEqual(result.updatedIds, ['one']);
});

test('mixed incoming and outgoing selection is blocked', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'expense' }), transaction({ id: 'income', incoming: 100, outgoing: 0 }));
  const plan = buildPaymentBulkCategorisationPlan(state, ['expense', 'income'], 'food');
  assert.equal(plan.valid, false);
  assert.match(plan.errors[0], /Income and outgoing spending/i);
});

test('Income target only accepts ordinary incoming payments', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'income', incoming: 100, outgoing: 0 }));
  const incomePlan = buildPaymentBulkCategorisationPlan(state, ['income'], PAYMENT_BULK_INCOME_VALUE);
  assert.equal(incomePlan.valid, true);
  const result = applyPaymentBulkCategorisation(state, incomePlan);
  assert.equal(result.state.transactions[0].category, 'Income');
  assert.equal(result.state.transactions[0].budgetCategoryId, '');

  const expenseState = baseState(); expenseState.transactions.push(transaction({ id: 'expense' }));
  assert.equal(buildPaymentBulkCategorisationPlan(expenseState, ['expense'], PAYMENT_BULK_INCOME_VALUE).valid, false);
});

test('special transfer, debt, refund and reversal semantics are excluded from bulk changes', () => {
  const candidates = [
    transaction({ id: 'transfer', transferStatus: 'confirmed' }),
    transaction({ id: 'debt', budgetTreatment: 'debt_payment' }),
    transaction({ id: 'refund', budgetTreatment: 'refund' }),
    transaction({ id: 'reversal', reversalOfTransactionId: 'source' })
  ];
  candidates.forEach((item) => assert.equal(paymentBulkEligibility(item).eligible, false));
});

test('Select visible retains only currently visible qualifying payments', () => {
  assert.deepEqual(retainVisiblePaymentSelection(['one', 'two', 'hidden'], ['one', 'two', 'three'], ['one', 'three']), ['one']);
});

test('bulk categorisation resolves only source-linked uncategorised Review items', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one', description: 'Fictional Grocer' }), transaction({ id: 'two', description: 'Fictional Grocer' }));
  synchroniseReviewItems(state, new Date('2026-08-11T10:00:00.000Z'));
  assert.equal(activeReviewItems(state).filter((item) => item.type === 'uncategorised_payment').length, 2);

  const plan = buildPaymentBulkCategorisationPlan(state, ['one'], 'food');
  const result = applyPaymentBulkCategorisation(state, plan, { synchroniseReviewItems, now: new Date('2026-08-11T10:05:00.000Z') });
  const one = result.state.reviewItems.find((item) => item.sourceId === 'one');
  const two = result.state.reviewItems.find((item) => item.sourceId === 'two');
  assert.equal(one.status, 'resolved');
  assert.equal(one.resolution.decision, 'source_resolved');
  assert.notEqual(two.status, 'resolved');
});

test('reviewing a plan does not mutate state, so cancel leaves data unchanged', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one' }));
  const before = structuredClone(state);
  const plan = buildPaymentBulkCategorisationPlan(state, ['one'], 'food');
  assert.equal(plan.valid, true);
  assert.deepEqual(state, before);
});

test('a stale revision cannot apply a reviewed bulk plan to a newer state', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one' }));
  const plan = buildPaymentBulkCategorisationPlan(state, ['one'], 'food');
  const newer = structuredClone(state); newer.meta.revision = state.meta.revision + 1;
  assert.throws(() => applyPaymentBulkCategorisation(newer, plan), (error) => error.code === 'PAYMENT_BULK_STALE_REVISION');
});

test('bulk category choices stay alphabetical and exclude Income-like budgets', () => {
  const state = baseState();
  state.budgets.push(
    { id: 'travel', category: 'Travel' },
    { id: 'bills', category: 'Bills' },
    { id: 'income-budget', category: 'Income' },
    { id: 'food', category: 'Food' }
  );
  const labels = paymentBulkCategoryOptions(state).map((entry) => entry.label);
  assert.deepEqual(labels, ['Bills', 'Food', 'Income', 'Travel', 'Uncategorised']);
  assert.equal(paymentBulkCategoryOptions(state).some((entry) => entry.value === 'income-budget'), false);
});

test('clearing a budget category persists as an ordinary manual edit after JSON round-trip', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 200 });
  state.transactions.push(transaction({ id: 'one', budgetCategoryId: 'food', category: 'Food' }));
  const plan = buildPaymentBulkCategorisationPlan(state, ['one'], PAYMENT_BULK_CLEAR_VALUE);
  const result = applyPaymentBulkCategorisation(state, plan);
  const restored = JSON.parse(JSON.stringify(result.state));
  assert.equal(restored.transactions[0].budgetCategoryId, '');
  assert.equal(restored.transactions[0].category, '');
  assert.equal(restored.transactions[0].categorySource, 'manual');
  assert.equal(Object.hasOwn(restored, 'paymentBulkReview'), false);
});

function baseState() {
  return {
    schemaVersion: 8,
    meta: { createdAt: '2026-08-11T09:00:00.000Z', updatedAt: '2026-08-11T09:00:00.000Z', revision: 7 },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: null },
    accounts: [], transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [], budgets: [],
    scheduledPayments: [], documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    settings: { selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 500, emergencyBufferBalance: 0, extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 }, snoozedActions: {} }
  };
}

function transaction(overrides = {}) {
  return {
    id: 'payment-1', accountId: 'account-1', date: '2026-08-11', budgetMonth: '2026-08', description: 'Fictional Payment',
    incoming: 0, outgoing: 10, budgetCategoryId: '', category: '', categorySource: 'manual', budgetTreatment: 'auto',
    transferStatus: 'no', duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'accepted', financiallyActive: true,
    ...overrides
  };
}
