import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFinancialChecks, buildNextAction, calculateBudgetRows, calculatePeriodSummary, debtPlan, exportTransactionsCsv,
  findDuplicateCandidates, formatCurrency, matchInternalTransfers
} from '../finance-core.js';

const baseState = () => ({
  profile: { dependableIncome: 2000 },
  settings: { selectedMonth: '2025-01', extraDebtPayment: 100, emergencyBufferTarget: 500, emergencyBufferBalance: 0 },
  transactions: [], payslips: [], debts: [], overdrafts: [], budgets: [], tasks: [], checkIns: []
});

test('currency uses UK pounds', () => {
  assert.equal(formatCurrency(1234.56), '£1,234.56');
});

test('a blank installation gives one onboarding action without example finance data', () => {
  const state = { ...baseState(), accounts: [] };
  assert.equal(buildNextAction(state).id, 'generated-first-account');
  assert.equal(buildFinancialChecks(state).length, 2);
});

test('an account with no payments advances onboarding to one statement import', () => {
  const state = { ...baseState(), accounts: [{ id: 'account-1', name: 'Main account' }] };
  assert.equal(buildNextAction(state).id, 'generated-first-import');
});

test('monthly summary excludes confirmed internal transfers and keeps overdrafts separate', () => {
  const state = baseState();
  state.transactions = [
    { budgetMonth: '2025-01', incoming: 1000, outgoing: 0, transferStatus: 'no' },
    { budgetMonth: '2025-01', incoming: 123.45, outgoing: 0, transferStatus: 'confirmed' },
    { budgetMonth: '2025-01', incoming: 0, outgoing: 200, transferStatus: 'no' },
    { budgetMonth: '2025-01', incoming: 0, outgoing: 123.45, transferStatus: 'confirmed' },
    { budgetMonth: '2024-12', incoming: 9999, outgoing: 0, transferStatus: 'no' }
  ];
  state.debts = [{ currentBalance: 500 }];
  state.overdrafts = [{ currentBalance: 275 }];
  const summary = calculatePeriodSummary(state);
  assert.equal(summary.income, 1000);
  assert.equal(summary.spending, 200);
  assert.equal(summary.debts, 500);
  assert.equal(summary.overdrafts, 275);
});

test('budget actuals use only the selected month and support merchant terms', () => {
  const state = baseState();
  state.transactions = [
    { budgetMonth: '2025-01', outgoing: 12, transferStatus: 'no', category: 'Other / review', description: 'LOCAL SUPERMARKET' },
    { budgetMonth: '2024-12', outgoing: 100, transferStatus: 'no', category: 'Other / review', description: 'LOCAL SUPERMARKET' }
  ];
  state.budgets = [{ id: 'food', category: 'Food', categories: ['Groceries'], merchantTerms: ['supermarket'], planned: 250 }];
  assert.equal(calculateBudgetRows(state)[0].actual, 12);
});

test('exact duplicate matching does not merge a legitimate same-value purchase', () => {
  const existing = [{ id: 'a', accountId: 'one', date: '2025-01-10', incoming: 0, outgoing: 10, description: 'Shop A', sourceRow: 1 }];
  const incoming = [
    { id: 'b', accountId: 'one', date: '2025-01-10', incoming: 0, outgoing: 10, description: 'Shop A', sourceRow: 1 },
    { id: 'c', accountId: 'one', date: '2025-01-10', incoming: 0, outgoing: 10, description: 'Shop B', sourceRow: 2 }
  ];
  const result = findDuplicateCandidates(existing, incoming);
  assert.equal(result.exact.length, 1);
  assert.equal(result.possible.length, 1);
});

test('transfer matching requires different accounts, equal values and nearby dates', () => {
  const matches = matchInternalTransfers([
    { id: 'out', accountId: 'a', date: '2025-01-10', incoming: 0, outgoing: 123.45, transferStatus: 'no', description: 'Transfer to own account' },
    { id: 'in', accountId: 'b', date: '2025-01-10', incoming: 123.45, outgoing: 0, transferStatus: 'no', description: 'Internal transfer' }
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].confidence, 'likely');
});

test('payoff model visibly blocks overpayments while an overdraft arrangement is unresolved', () => {
  const state = baseState();
  state.debts = [{ id: 'd', name: 'Card', currentBalance: 500, apr: null, contractualPayment: 25, status: 'current', arrangementConfirmed: true, includeInPlan: true, planPriority: 2 }];
  state.overdrafts = [{ id: 'o', name: 'Bank overdraft', currentBalance: 200, apr: 0.399, contractualPayment: 0, status: 'over_limit', arrangementConfirmed: false, includeInPlan: true, planPriority: 1 }];
  const plan = debtPlan(state, 'hybrid', 100, '2025-02');
  assert.equal(plan.safeToOverpay, false);
  assert.deepEqual(plan.blockers, ['Bank overdraft']);
  assert.deepEqual(plan.unknownApr, ['Card']);
});

test('CSV export quotes fields and neutralises spreadsheet formulas', () => {
  const csv = exportTransactionsCsv([{ date: '2025-01-10', accountId: 'a', description: '=HYPERLINK("bad")', userDescription: '', category: 'Other', incoming: 0, outgoing: 1, runningBalance: 0, transferStatus: 'no', notes: '@unsafe' }]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"'@unsafe"/);
});
