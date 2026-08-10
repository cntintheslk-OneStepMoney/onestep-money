import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFinancialReport } from '../financial-reporting.js';
import { debtSafetyAssessment } from '../finance-core.js';
import {
  actOnDemoReviewItem, applySimulatedImport, categoriseDemoTransaction, createCanonicalDemoState,
  DEMO_STORAGE_KEY, deriveDemoView, loadDemoState, resetDemoState, saveDemoState, setDemoTheme,
  validDemoState
} from '../demo/demo-state.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    value: (key) => values.get(key)
  };
}

test('canonical browser demo is deterministic, fictional and internally reconciled', () => {
  const first = createCanonicalDemoState();
  const second = createCanonicalDemoState();
  assert.deepEqual(first, second);
  assert.equal(first.meta.demo, true);
  assert.equal(first.profile.name, 'Alex Rowan');
  const view = deriveDemoView(first);
  assert.equal(view.report.summary.income, 2100);
  assert.equal(view.report.summary.netCashFlow, view.report.summary.income - view.report.summary.spending);
  assert.equal(view.report.summary.budgetActualSpending, view.report.budget.actual);
  assert.equal(view.report.summary.netPay, view.report.summary.income);
  assert.ok(view.review.active.some((item) => item.type === 'uncategorised_payment'));
  assert.ok(view.review.active.some((item) => item.type === 'possible_duplicate'));
  assert.ok(view.review.active.some((item) => item.type === 'financial_action'));
  assert.ok(view.review.snoozed.some((item) => item.sourceId === 'task-insurance'));
  assert.ok(view.priority.nextMove);
});

test('malformed disposable state recovers to the exact canonical baseline', () => {
  const storage = memoryStorage({ [DEMO_STORAGE_KEY]: '{bad json' });
  const loaded = loadDemoState(storage);
  assert.equal(loaded.recovered, true);
  assert.deepEqual(loaded.state, createCanonicalDemoState());
  assert.deepEqual(JSON.parse(storage.value(DEMO_STORAGE_KEY)), createCanonicalDemoState());
});

test('saved valid state reloads while invalid non-demo state is rejected', () => {
  const storage = memoryStorage();
  const state = createCanonicalDemoState();
  state.settings.demo.guidanceDismissed = true;
  saveDemoState(state, storage);
  const loaded = loadDemoState(storage);
  assert.equal(loaded.recovered, false);
  assert.equal(loaded.state.settings.demo.guidanceDismissed, true);
  assert.equal(validDemoState({ transactions: [] }), false);
});

test('categorisation updates Payments, Budget and Review Inbox together', () => {
  const state = createCanonicalDemoState();
  const before = deriveDemoView(state);
  categoriseDemoTransaction(state, 'tx-coffee', 'budget-eating');
  const after = deriveDemoView(state);
  assert.equal(after.report.budget.uncategorisedActual, 0);
  assert.equal(after.report.budget.rows.find((row) => row.id === 'budget-eating').actual, 7.2);
  assert.equal(after.review.active.some((item) => item.sourceId === 'tx-coffee'), false);
  assert.equal(after.report.budget.actual, before.report.budget.actual);
});

test('possible duplicate decision controls trusted totals', () => {
  const state = createCanonicalDemoState();
  const before = buildFinancialReport(state, '2026-08').summary.spending;
  const item = state.reviewItems.find((entry) => entry.type === 'possible_duplicate');
  actOnDemoReviewItem(state, item.id, 'both_genuine');
  const after = buildFinancialReport(state, '2026-08').summary.spending;
  assert.equal(after - before, 48);
  assert.equal(state.transactions.find((entry) => entry.id === 'tx-market-possible-duplicate').financiallyActive, true);
});

test('confirming the fictional default arrangement clears the safety blocker conservatively', () => {
  const state = createCanonicalDemoState();
  assert.ok(debtSafetyAssessment(state).blockingReasons.length > 0);
  const item = state.reviewItems.find((entry) => entry.type === 'financial_action' && entry.sourceId === 'debt-card');
  actOnDemoReviewItem(state, item.id);
  const safety = debtSafetyAssessment(state);
  assert.equal(safety.blockingReasons.length, 0);
  assert.equal(safety.accounts.find((account) => account.id === 'debt-card').eligibleForExtra, false);
  assert.equal(safety.accounts.find((account) => account.id === 'debt-card').requiredPayment, 25);
});

test('simulated import uses fictional fixture rows and reset restores exactly', () => {
  const storage = memoryStorage();
  const state = createCanonicalDemoState();
  const before = state.transactions.length;
  applySimulatedImport(state);
  assert.equal(state.transactions.length, before + 3);
  assert.equal(state.settings.demo.importApplied, true);
  applySimulatedImport(state);
  assert.equal(state.transactions.length, before + 3);
  saveDemoState(state, storage);
  const reset = resetDemoState(storage);
  assert.deepEqual(reset, createCanonicalDemoState());
  assert.deepEqual(JSON.parse(storage.value(DEMO_STORAGE_KEY)), createCanonicalDemoState());
});

test('demo theme preserves supported preferences and normalises invalid values', () => {
  const state = createCanonicalDemoState();
  for (const theme of ['system', 'light', 'dark']) {
    setDemoTheme(state, theme);
    assert.equal(state.settings.appearance.theme, theme);
  }
  setDemoTheme(state, 'neon');
  assert.equal(state.settings.appearance.theme, 'system');
});
