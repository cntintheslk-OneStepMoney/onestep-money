import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import {
  buildPaydayAllocationPlan,
  PAYDAY_ALLOCATION_STATUS,
  setPaydayPlanningPreferences
} from '../payday-allocation.js';
import {
  PAYDAY_RULE,
  PAYDAY_TIMING,
  upsertIncomeSchedule,
  WEEKEND_ADJUSTMENT
} from '../payday-awareness.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const seedPath = new URL('../seed-data.json', import.meta.url);
const backupPassword = 'fictional-payday-password';

function baseState(overrides = {}) {
  return {
    schemaVersion: 10,
    meta: { createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), revision: 4 },
    automation: { version: 1, enabled: true, executions: [], manualOverrides: [] },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 2000, paydayDay: null, incomeSchedules: [] },
    settings: {
      selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 200, emergencyBufferBalance: 50,
      extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 },
      snoozedActions: {}, appearance: { theme: 'system' }, dashboard: {}
    },
    accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: 2000, statementDate: '2026-08-10', active: true }],
    transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [], budgets: [], scheduledPayments: [],
    documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    ...overrides
  };
}

function withIncomeSchedule(state, input = {}) {
  return upsertIncomeSchedule(state, {
    id: input.id || 'fictional-salary',
    name: input.name || 'Fictional Employer',
    matchText: input.matchText || input.name || 'Fictional Employer',
    cadence: 'monthly',
    rule: { type: PAYDAY_RULE.FIXED_DAY, day: input.day || 10, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE },
    timingRelationship: PAYDAY_TIMING.CURRENT,
    expectedAmountRange: input.expectedAmountRange || { min: 1900, max: 2100 },
    active: true,
    effectiveFrom: '2026-08-01'
  }, NOW);
}

function receivedIncome(amount = 2000, date = '2026-08-10', description = 'Fictional Employer') {
  return {
    id: `income-${date}-${amount}`, accountId: 'current', date, budgetMonth: date.slice(0, 7), description,
    category: 'Income', incoming: amount, outgoing: 0, transferStatus: 'no', budgetTreatment: 'income',
    duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true
  };
}

function activeBudget(id, category, planned, section = 'Essentials') {
  return { id, category, section, planned };
}

function currentDebt(overrides = {}) {
  return {
    id: 'fictional-loan', name: 'Fictional Loan', type: 'Personal loan', currentBalance: 500,
    balanceEffectiveDate: '2026-08-10', apr: 0.12, contractualPayment: 50, paymentDueDate: '2026-08-22',
    status: 'current', arrangementStatus: 'none', arrangementPayment: null, statusConflict: false, includeInPlan: true,
    ...overrides
  };
}

function paydayState(overrides = {}) {
  const state = withIncomeSchedule(baseState(overrides));
  if (!state.transactions.length) state.transactions = [receivedIncome()];
  return state;
}

test('salary received with bills before the next payday protects those commitments first', () => {
  const state = paydayState({
    scheduledPayments: [{ id: 'essential-bill', name: 'Fictional Essential Bill', amount: 100, dueDate: '2026-08-20', status: 'due', includedInBudget: false }],
    budgets: [activeBudget('food', 'Food', 300)]
  });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.income.amountReceived, 2000);
  assert.equal(plan.horizonDate, '2026-09-10');
  assert.equal(plan.protectedCommitments.required, 100);
  assert.equal(plan.protectedCommitments.funded, 100);
  assert.equal(plan.safety.futureExpectedIncomeAllocated, false);
  assert.equal(plan.safety.externalPaymentMade, false);
});

test('required debt minimums are protected before flexible or optional allocation', () => {
  const state = paydayState({ debts: [currentDebt()], budgets: [activeBudget('food', 'Food', 300)] });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.requiredDebt.required, 50);
  assert.equal(plan.requiredDebt.funded, 50);
  assert.equal(plan.requiredDebt.items[0].kind, 'required_debt_payment');
});

test('default or unresolved arrangement safety state blocks unsafe optional overpayment', () => {
  const state = paydayState({
    debts: [currentDebt({ status: 'defaulted', arrangementStatus: 'unknown' })],
    budgets: []
  });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.notEqual(plan.status, PAYDAY_ALLOCATION_STATUS.READY);
  assert.equal(plan.optionalDebt.funded, 0);
  assert.equal(plan.safety.externalPaymentMade, false);
});

test('starter or emergency buffer shortfall is explicitly protected', () => {
  const state = paydayState({ settings: { ...baseState().settings, emergencyBufferTarget: 400, emergencyBufferBalance: 100 } });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.buffer.required, 300);
  assert.equal(plan.buffer.funded, 300);
});

test('reduced-than-expected income exposes Budget shortfall and compresses optional allocation first', () => {
  const state = paydayState({
    accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: 650, statementDate: '2026-08-10', active: true }],
    transactions: [receivedIncome(650)],
    scheduledPayments: [{ id: 'bill', name: 'Fictional Bill', amount: 100, dueDate: '2026-08-20', status: 'due', includedInBudget: false }],
    debts: [currentDebt()],
    budgets: [activeBudget('food', 'Food', 300), activeBudget('travel', 'Travel', 200)]
  });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.income.amountReceived, 650);
  assert.notEqual(plan.status, PAYDAY_ALLOCATION_STATUS.READY);
  assert.equal(plan.budget.categories.length, 2);
  assert.ok(plan.budget.shortfall > 0);
  assert.equal(plan.optionalDebt.funded, 0);
  assert.ok(plan.leftoverUnallocated >= 0);
});

test('a second dependable income stream shortens the current payday planning horizon', () => {
  let state = paydayState();
  state = withIncomeSchedule(state, { id: 'fictional-side-income', name: 'Fictional Side Income', matchText: 'Fictional Side Income', day: 15, expectedAmountRange: { min: 300, max: 350 } });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.income.streamId, 'fictional-salary');
  assert.equal(plan.horizonDate, '2026-08-15');
});

test('a changed bill amount or date recalculates the derived plan instead of retaining a stale snapshot', () => {
  const first = paydayState({ scheduledPayments: [{ id: 'bill', name: 'Fictional Bill', amount: 100, dueDate: '2026-08-20', status: 'due', includedInBudget: false }] });
  const second = structuredClone(first);
  second.scheduledPayments[0].amount = 225;
  second.scheduledPayments[0].dueDate = '2026-08-18';

  const before = buildPaydayAllocationPlan(first, { now: NOW });
  const after = buildPaydayAllocationPlan(second, { now: NOW });
  assert.equal(before.protectedCommitments.required, 100);
  assert.equal(after.protectedCommitments.required, 225);
  assert.equal(after.protectedCommitments.items[0].date, '2026-08-18');
});

test('future expected income is not allocated before trusted receipt evidence exists', () => {
  const state = withIncomeSchedule(baseState(), { day: 28, expectedAmountRange: { min: 5000, max: 5000 } });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.status, PAYDAY_ALLOCATION_STATUS.WAITING_FOR_INCOME);
  assert.equal(plan.income, null);
  assert.equal(plan.availableForPlanning, 0);
  assert.equal(plan.safety.futureExpectedIncomeAllocated, false);
});

test('user-adjusted flexible allowance persists as an explicit override and never replaces the Budget', () => {
  let state = paydayState({ budgets: [activeBudget('food', 'Food', 300), activeBudget('travel', 'Travel', 200)] });
  state = setPaydayPlanningPreferences(state, { flexibleAllowance: 250 });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.preferences.flexibleAllowance, 250);
  assert.equal(plan.budget.userOverride, true);
  assert.equal(plan.budget.required, 500);
  assert.equal(plan.budget.requestedFlexibleAllowance, 250);
  assert.equal(plan.budget.categories.length, 2);
});

test('no negative or silently overcommitted plan is recommended when protected needs exceed payday cash', () => {
  const state = paydayState({
    accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: 120, statementDate: '2026-08-10', active: true }],
    transactions: [receivedIncome(120)],
    scheduledPayments: [{ id: 'bill', name: 'Fictional Bill', amount: 150, dueDate: '2026-08-20', status: 'due', includedInBudget: false }],
    budgets: [activeBudget('food', 'Food', 300)]
  });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.status, PAYDAY_ALLOCATION_STATUS.PROTECTED_SHORTFALL);
  assert.ok(plan.protectedCommitments.shortfall > 0);
  assert.equal(plan.budget.funded, 0);
  assert.equal(plan.optionalDebt.funded, 0);
  assert.ok(plan.leftoverUnallocated >= 0);
});

test('the complete active Budget remains visible with funded, partial or unfunded coverage when money is short', () => {
  const state = paydayState({
    accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: 500, statementDate: '2026-08-10', active: true }],
    transactions: [receivedIncome(500)],
    settings: { ...baseState().settings, emergencyBufferTarget: 0, emergencyBufferBalance: 0 },
    budgets: [
      activeBudget('food', 'Food', 300),
      activeBudget('travel', 'Travel', 200),
      activeBudget('health', 'Health', 100)
    ]
  });
  const plan = buildPaydayAllocationPlan(state, { now: NOW });

  assert.equal(plan.budget.allActiveCategoriesVisible, true);
  assert.deepEqual(plan.budget.categories.map((item) => item.id), ['food', 'travel', 'health']);
  assert.ok(plan.budget.shortfall > 0);
  assert.ok(plan.budget.categories.every((item) => ['funded', 'partially_funded', 'unfunded', 'needs_review'].includes(item.fundingStatus)));
  assert.equal(plan.budget.expectedFutureIncomeAppliedToShortfall, false);
});

test('portable backup and restore preserve explicit payday planning preferences without persisting a derived plan', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-payday-allocation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { appVersion: '2.1.26' });
  await store.initialise();
  let state = (await store.loadState()).state;
  state = setPaydayPlanningPreferences(state, {
    flexibleAllowance: 275,
    optionalDebtId: 'fictional-loan',
    optionalDebtDeclined: true,
    optionalSavingsTarget: 40,
    acceptedChoiceIds: ['budget:food']
  });
  state = await store.saveState(state);
  const backupPath = path.join(directory, 'payday-preferences.osmb');
  await store.createPortableBackup(backupPath, backupPassword, state);

  let changed = setPaydayPlanningPreferences(state, { flexibleAllowance: 50, optionalDebtDeclined: false });
  changed = await store.saveState(changed);
  assert.equal(changed.profile.paydayPlanningPreferences.flexibleAllowance, 50);

  const restored = await store.restorePortableBackup(backupPath, backupPassword);
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.profile.paydayPlanningPreferences.flexibleAllowance, 275);
  assert.equal(restored.state.profile.paydayPlanningPreferences.optionalDebtDeclined, true);
  assert.equal(restored.state.profile.paydayPlanningPreferences.optionalSavingsTarget, 40);
  assert.deepEqual(restored.state.profile.paydayPlanningPreferences.acceptedChoiceIds, ['budget:food']);
  assert.equal('paydayAllocationPlan' in restored.state, false);
  assert.equal('paydayAllocationSnapshot' in restored.state, false);
});
