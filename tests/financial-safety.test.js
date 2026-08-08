import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFallbackAnswer, buildNextAction, creditReportDebtStatus, creditReportStatusConflict,
  debtPlan, debtSafetyAssessment
} from '../finance-core.js';

const baseState = () => ({
  profile: { dependableIncome: 2400 },
  settings: { selectedMonth: '2026-08', extraDebtPayment: 100, emergencyBufferTarget: 500, emergencyBufferBalance: 500 },
  accounts: [], transactions: [], payslips: [], creditReports: [], debts: [], overdrafts: [], budgets: [], scheduledPayments: [], tasks: [], checkIns: []
});

const healthyDebt = (overrides = {}) => ({
  id: 'healthy-debt', name: 'Fictional Loan', type: 'Personal loan', currentBalance: 800, apr: 0.12,
  contractualPayment: 25, status: 'current', arrangementStatus: 'none', arrangementPayment: null,
  statusConflict: false, includeInPlan: true, planPriority: 5, ...overrides
});

test('healthy debt retains normal safe overpayment behaviour', () => {
  const state = baseState();
  state.debts = [healthyDebt()];

  const plan = debtPlan(state, 'hybrid', 100, '2026-08');

  assert.equal(plan.safeToOverpay, true);
  assert.equal(plan.safeExtraPayment, 100);
  assert.equal(plan.monthlyPot, 125);
  assert.deepEqual(plan.priority, ['Fictional Loan']);
});

test('defaulted debt with unknown arrangement receives no discretionary payment', () => {
  const state = baseState();
  state.debts = [healthyDebt({ id: 'defaulted', name: 'Fictional Default', status: 'defaulted', arrangementStatus: 'unknown' })];

  const plan = debtPlan(state);

  assert.equal(plan.safeToOverpay, false);
  assert.equal(plan.safeExtraPayment, 0);
  assert.deepEqual(plan.blockers, ['Fictional Default']);
  assert.match(plan.explanations.join(' '), /defaulted|arrangement/i);
});

test('confirmed default arrangement is protected and excluded from optional payments', () => {
  const state = baseState();
  state.debts = [
    healthyDebt({ id: 'defaulted', name: 'Fictional Default', status: 'defaulted', arrangementStatus: 'confirmed', arrangementPayment: 30, planPriority: 1 }),
    healthyDebt()
  ];

  const plan = debtPlan(state);

  assert.equal(plan.minimumTotal, 55);
  assert.equal(plan.safeExtraPayment, 100);
  assert.deepEqual(plan.priority, ['Fictional Loan']);
  assert.match(plan.excludedAccounts.find((item) => item.name === 'Fictional Default').reason, /agreed payment/i);
});

test('unresolved arrears block a healthy debt from receiving limited surplus', () => {
  const state = baseState();
  state.debts = [
    healthyDebt({ id: 'arrears', name: 'Fictional Arrears', status: 'arrears', arrangementStatus: 'unknown', planPriority: 9 }),
    healthyDebt()
  ];

  const plan = debtPlan(state);

  assert.equal(plan.safeExtraPayment, 0);
  assert.deepEqual(plan.blockers, ['Fictional Arrears']);
  assert.match(plan.explanations.join(' '), /arrears/i);
});

test('a balance above its credit limit receives risk priority', () => {
  const state = baseState();
  state.debts = [
    healthyDebt(),
    healthyDebt({ id: 'over-limit', name: 'Fictional Card', type: 'Credit card', currentBalance: 1200, creditLimit: 1000, planPriority: 99 })
  ];

  const assessment = debtSafetyAssessment(state);
  const plan = debtPlan(state);

  assert.equal(assessment.accounts.find((item) => item.id === 'over-limit').overLimit, true);
  assert.equal(plan.safeExtraPayment, 100);
  assert.equal(plan.priority[0], 'Fictional Card');
});

test('unknown material debt state is not treated as safe', () => {
  const state = baseState();
  state.debts = [healthyDebt({ status: 'unknown', arrangementStatus: 'unknown' })];

  const plan = debtPlan(state);

  assert.equal(plan.safeExtraPayment, 0);
  assert.match(plan.explanations.join(' '), /does not know|unknown/i);
});

test('conflicting current and defaulted information uses the conservative state', () => {
  const state = baseState();
  state.debts = [healthyDebt({ status: 'current', reportedStatus: 'Defaulted account' })];

  const assessment = debtSafetyAssessment(state);

  assert.equal(assessment.safeExtraPayment, 0);
  assert.equal(assessment.accounts[0].effectiveStatus, 'defaulted');
  assert.ok(assessment.accounts[0].reasonCodes.includes('conflicting_status'));
});

test('essential commitments reduce an optional payment to genuinely remaining money', () => {
  const state = baseState();
  state.profile.dependableIncome = 2000;
  state.budgets = [{ id: 'essentials', section: 'Essentials', category: 'Fictional essentials', planned: 1900 }];
  state.debts = [healthyDebt({ contractualPayment: 50 })];

  const assessment = debtSafetyAssessment(state, 100);

  assert.equal(assessment.safeExtraPayment, 50);
  assert.equal(assessment.safeToOverpay, false);
  assert.match(assessment.explanations.join(' '), /essential commitments/i);
});

test('overdraft dependency blocks transferring debt into the current account', () => {
  const state = baseState();
  state.accounts = [{ id: 'cash', name: 'Fictional Current Account', type: 'current', currentBalance: 75, active: true }];
  state.scheduledPayments = [{ id: 'bill', amount: 100, status: 'due', includedInBudget: false }];
  state.debts = [healthyDebt()];

  const assessment = debtSafetyAssessment(state, 100);

  assert.equal(assessment.currentCashCapacity, 0);
  assert.equal(assessment.safeExtraPayment, 0);
});

test('generated actions ask for arrangement information instead of overpayment', () => {
  const state = baseState();
  state.accounts = [{ id: 'cash', type: 'current', currentBalance: 500, active: true }];
  state.transactions = [{ id: 'payment', date: '2026-08-01', budgetMonth: '2026-08', outgoing: 10, incoming: 0 }];
  state.debts = [healthyDebt({ name: 'Fictional Default', status: 'defaulted', arrangementStatus: 'unknown' })];

  const action = buildNextAction(state, new Date('2026-08-08T12:00:00Z'));
  const answer = buildFallbackAnswer('What debt should I overpay?', state);

  assert.equal(action.title, 'Check your payment arrangement');
  assert.match(answer, /No unsafe extra payment is included/i);
});

test('credit-report statuses preserve unknowns and expose conflicts', () => {
  assert.equal(creditReportDebtStatus(''), 'unknown');
  assert.equal(creditReportDebtStatus('No arrears, up to date'), 'current');
  assert.equal(creditReportDebtStatus('Up to date / defaulted'), 'defaulted');
  assert.equal(creditReportStatusConflict('Up to date / defaulted'), true);
});

test('missing revolving-credit limit blocks discretionary recommendations', () => {
  const state = baseState();
  state.debts = [healthyDebt({ type: 'Credit card', creditLimit: null })];

  const assessment = debtSafetyAssessment(state);

  assert.equal(assessment.safeExtraPayment, 0);
  assert.ok(assessment.accounts[0].reasonCodes.includes('unknown_credit_limit'));
});
