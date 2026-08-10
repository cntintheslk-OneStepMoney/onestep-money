import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import { calculateBudgetAnalysis, debtSafetyAssessment } from '../finance-core.js';
import { buildUnifiedFinancialProfile } from '../unified-financial-profile.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const seedPath = new URL('../seed-data.json', import.meta.url);

function state(overrides = {}) {
  return {
    schemaVersion: 9,
    meta: { createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), revision: 3 },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 3000, paydayDay: 28 },
    settings: {
      selectedMonth: '2026-08', extraDebtPayment: 100, emergencyBufferTarget: 1000, emergencyBufferBalance: 500,
      extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 },
      snoozedActions: {}, appearance: { theme: 'system' }, dashboard: {}
    },
    accounts: [
      { id: 'current', name: 'Fictional Current Account', type: 'current', currentBalance: 1200, statementDate: '2026-08-01', active: true },
      { id: 'savings', name: 'Fictional Savings', type: 'savings', currentBalance: 500, statementDate: '2026-08-01', active: true }
    ],
    transactions: [
      transaction({ id: 'groceries-payment', outgoing: 100, budgetCategoryId: 'groceries' }),
      transaction({ id: 'salary-payment', incoming: 2500, description: 'Fictional Employer', category: 'Income', recurring: true }),
      transaction({ id: 'side-income', incoming: 300, description: 'Fictional Side Work', category: 'Income', recurring: true })
    ],
    payslips: [
      { id: 'payslip-main', employerPayeReference: '111/AB123', provider: 'manual', period: '2026-08', payDate: '2026-08-01', netPay: 2500 }
    ],
    taxDocuments: [], creditReports: [],
    debts: [
      debt({ id: 'loan', name: 'Fictional Loan', currentBalance: 1000, contractualPayment: 50 }),
      debt({ id: 'default', name: 'Fictional Default', currentBalance: 300, status: 'defaulted', arrangementStatus: 'confirmed', arrangementPayment: 30, contractualPayment: null })
    ],
    overdrafts: [debt({ id: 'overdraft', name: 'Fictional Overdraft', type: 'overdraft', currentBalance: 200, contractualPayment: 0, limit: 500 })],
    budgets: [
      { id: 'groceries', section: 'Essentials', category: 'Groceries', planned: 400 },
      { id: 'debt-minimums', section: 'Debt minimums', category: 'Debt minimums', planned: 50 }
    ],
    scheduledPayments: [{ id: 'phone', name: 'Fictional Phone', amount: 40, dueDate: '2026-08-20', status: 'due', includedInBudget: false }],
    documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    ...overrides
  };
}

function transaction(overrides = {}) {
  return {
    id: 'transaction', accountId: 'current', date: '2026-08-02', budgetMonth: '2026-08', description: 'Fictional payment',
    incoming: 0, outgoing: 0, transferStatus: 'no', budgetTreatment: 'auto', duplicateStatus: 'none', reviewStatus: 'not_required',
    importReviewStatus: 'trusted', financiallyActive: true, ...overrides
  };
}

function debt(overrides = {}) {
  return {
    id: 'debt', name: 'Fictional Debt', type: 'Personal loan', currentBalance: 800, apr: 0.12,
    contractualPayment: 25, status: 'current', arrangementStatus: 'none', arrangementPayment: null,
    statusConflict: false, includeInPlan: true, planPriority: 5, ...overrides
  };
}

test('one coherent source state produces the complete shared financial profile', () => {
  const profile = buildUnifiedFinancialProfile(state(), { now: NOW });

  assert.equal(profile.kind, 'unified-financial-profile');
  assert.equal(profile.derived, true);
  assert.equal(profile.persist, false);
  assert.equal(profile.liquidPosition.total.value, 1700);
  assert.equal(profile.income.dependableMonthlyTotal.value, 3000);
  assert.equal(profile.budget.planned, 450);
  assert.equal(profile.budget.actual, 100);
  assert.equal(profile.debts.totalOwed.value, 1500);
  assert.equal(profile.debts.requiredPaymentTotal.value, 80);
  assert.equal(profile.commitments.knownMonthlyTotal.value, 520);
  assert.equal(profile.commitments.items.find((item) => item.id === 'scheduled:phone').dueDate.value, '2026-08-20');
  assert.equal(profile.upcomingDates.some((item) => item.kind === 'scheduled_payment' && item.date === '2026-08-20'), true);
  assert.equal(profile.upcomingDates.some((item) => item.kind === 'payday' && item.date === '2026-08-28'), true);
  assert.equal(profile.debts.accounts.find((item) => item.id === 'default').status.value, 'defaulted');
});

test('unknown and stale source facts remain explicit and unsafe to use', () => {
  const input = state({
    accounts: [{ id: 'unknown', name: 'Fictional Unknown Account', type: 'current', currentBalance: null, active: true }],
    scheduledPayments: [{ id: 'undated', name: 'Fictional Undated Bill', amount: 25, status: 'due' }],
    debts: [debt({ id: 'stale', balanceEffectiveDate: '2025-01-01', apr: null, contractualPayment: null })],
    overdrafts: []
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(profile.liquidPosition.accounts[0].balance.status, 'unknown');
  assert.equal(profile.debts.accounts[0].balance.status, 'stale');
  assert.equal(profile.debts.accounts[0].apr.status, 'unknown');
  assert.equal(profile.debts.accounts[0].requiredPayment.status, 'unknown');
  assert.equal(profile.commitments.items.find((item) => item.id === 'scheduled:undated').dueDate.status, 'unknown');
  assert.equal(profile.uncertainty.safeForAutomation, false);
});

test('confirmed manual dependable income wins without discarding observed sources', () => {
  const input = state({
    profile: { currency: 'GBP', dependableIncome: 2400, paydayDay: 28 },
    payslips: [{ id: 'observed-pay', employerPayeReference: '222/CD456', period: '2026-08', payDate: '2026-08-01', netPay: 3100 }]
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(profile.income.dependableMonthlyTotal.value, 2400);
  assert.equal(profile.income.precedence, 'manual');
  assert.equal(profile.income.inferredValuesUsedInDependableTotal, false);
  assert.equal(profile.income.streams.find((item) => item.kind === 'payslip_observation').monthlyAmount.value, 3100);
  assert.equal(profile.income.streams.find((item) => item.kind === 'payslip_observation').includedInDependableTotal, false);
});

test('pending possible duplicates remain financially inactive everywhere in the profile', () => {
  const input = state({
    transactions: [
      transaction({ id: 'trusted', outgoing: 10, budgetCategoryId: 'groceries' }),
      transaction({ id: 'pending', outgoing: 900, budgetCategoryId: 'groceries', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false }),
      transaction({ id: 'pending-income', incoming: 4000, category: 'Income', recurring: true, duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false })
    ]
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(profile.budget.actual, 10);
  assert.equal(profile.income.streams.some((item) => item.id.includes('pending-income')), false);
  assert.equal(profile.uncertainty.blocking.some((item) => item.code === 'pending_possible_duplicate'), true);
});

test('unresolved conflicts are represented as unsafe uncertainty instead of guessed facts', () => {
  const input = state({
    debts: [debt({ id: 'conflict', status: 'current', reportedStatus: 'Defaulted account' })],
    importBatches: [{ id: 'batch', kind: 'credit-report', reconciliationState: 'review-required', reviewCount: 1 }]
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });
  const account = profile.debts.accounts[0];

  assert.equal(account.status.value, 'defaulted');
  assert.equal(account.status.status, 'conflict');
  assert.equal(account.status.safeToUse, false);
  assert.equal(profile.uncertainty.safeForAutomation, false);
  assert.equal(profile.uncertainty.blocking.some((item) => item.code === 'debt_status_conflict'), true);
  assert.equal(profile.uncertainty.blocking.some((item) => item.code === 'unresolved_import_conflict'), true);
});

test('defaulted and arrears obligations retain Financial Safety status and arrangements', () => {
  const input = state({
    debts: [
      debt({ id: 'defaulted', status: 'defaulted', arrangementStatus: 'confirmed', arrangementPayment: 35 }),
      debt({ id: 'arrears', status: 'arrears', arrangementStatus: 'unknown', contractualPayment: null })
    ],
    overdrafts: []
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(profile.debts.accounts.find((item) => item.id === 'defaulted').status.value, 'defaulted');
  assert.equal(profile.debts.accounts.find((item) => item.id === 'defaulted').requiredPayment.value, 35);
  assert.equal(profile.debts.accounts.find((item) => item.id === 'arrears').status.value, 'arrears');
  assert.equal(profile.debts.accounts.find((item) => item.id === 'arrears').requiredPayment.status, 'unknown');
  assert.equal(profile.financialSafety.safeToOverpay, false);
});

test('multiple income streams remain independently identifiable', () => {
  const input = state({
    payslips: [
      { id: 'a-july', employerPayeReference: '111/AA111', employer: 'Fictional Employer A', period: '2026-07', payDate: '2026-07-28', netPay: 1800 },
      { id: 'a-august', employerPayeReference: '111/AA111', employer: 'Fictional Employer A', period: '2026-08', payDate: '2026-08-01', netPay: 1850 },
      { id: 'b-august', employerPayeReference: '222/BB222', employer: 'Fictional Employer B', period: '2026-08', payDate: '2026-08-02', netPay: 450 }
    ],
    transactions: [transaction({ id: 'other-income', incoming: 200, description: 'Fictional Other Income', category: 'Income', recurring: true })]
  });
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });
  const observed = profile.income.streams.filter((item) => item.kind !== 'manual_total');

  assert.equal(observed.length, 3);
  assert.equal(observed.filter((item) => item.kind === 'payslip_observation').length, 2);
  assert.deepEqual(observed.filter((item) => item.kind === 'payslip_observation').map((item) => item.evidenceCount).sort(), [1, 2]);
});

test('shared budget and safety facts use the existing trusted calculations', () => {
  const input = state();
  const expectedBudget = calculateBudgetAnalysis(input, '2026-08');
  const expectedSafety = debtSafetyAssessment(input, input.settings.extraDebtPayment);
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(profile.budget.planned, expectedBudget.planned);
  assert.equal(profile.budget.actual, expectedBudget.actual);
  assert.equal(profile.debts.requiredPaymentTotal.value, expectedSafety.requiredPaymentTotal);
  assert.equal(profile.financialSafety.safeExtraPayment, expectedSafety.safeExtraPayment);
  assert.equal(profile.financialSafety.currentCashCapacity, expectedSafety.currentCashCapacity);
});

test('the profile is rebuilt after storage and backup without a persisted snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: unavailableSecureStorage(), clock: () => new Date(NOW) });
  await store.initialise();
  const loaded = await store.loadState();
  loaded.state.profile.dependableIncome = 2100;
  loaded.state.accounts = [{ id: 'cash', name: 'Fictional Cash', type: 'cash', currentBalance: 650, active: true }];
  const saved = await store.saveState(loaded.state);
  await store.createAutomaticBackup('unified-profile-test');

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: unavailableSecureStorage(), clock: () => new Date(NOW) });
  await restarted.initialise();
  const reopened = await restarted.loadState();
  const profile = buildUnifiedFinancialProfile(reopened.state, { now: NOW });

  assert.equal(saved.unifiedFinancialProfile, undefined);
  assert.equal(reopened.state.unifiedFinancialProfile, undefined);
  assert.equal(profile.income.dependableMonthlyTotal.value, 2100);
  assert.equal(profile.liquidPosition.total.value, 650);
  assert.equal((await fs.readdir(restarted.backupPath)).some((name) => name.endsWith('.osmb-set')), true);
});

test('returned objects are immutable without freezing or changing source state', () => {
  const input = state();
  const before = structuredClone(input);
  const profile = buildUnifiedFinancialProfile(input, { now: NOW });

  assert.equal(Object.isFrozen(profile), true);
  assert.equal(Object.isFrozen(profile.liquidPosition.accounts[0]), true);
  assert.equal(Object.isFrozen(input.accounts), false);
  assert.throws(() => { profile.liquidPosition.accounts[0].balance.value = 999999; }, TypeError);
  assert.throws(() => { profile.budget.categories.push({}); }, TypeError);
  assert.deepEqual(input, before);
});

function unavailableSecureStorage() {
  return {
    isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('not available'); },
    decryptString: () => { throw new Error('not available'); }
  };
}
