import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableReportingMonths, buildFinancialChecks, buildNextAction, calculateBudgetRows, calculatePeriodSummary, debtPlan, exportTransactionsCsv,
  findDuplicateCandidates, formatCurrency, hasCompletedCheckIn, matchInternalTransfers, planCreditReportAccounts, syncStatementAccount
} from '../finance-core.js';

const baseState = () => ({
  profile: { dependableIncome: 2000 },
  settings: { selectedMonth: '2025-01', extraDebtPayment: 100, emergencyBufferTarget: 500, emergencyBufferBalance: 0 },
  transactions: [], payslips: [], creditReports: [], debts: [], overdrafts: [], budgets: [], tasks: [], checkIns: []
});

test('currency uses UK pounds', () => {
  assert.equal(formatCurrency(1234.56), '£1,234.56');
});

test('reporting months come only from dated financial records and leave gaps missing', () => {
  const state = baseState();
  state.settings.selectedMonth = '2025-08';
  state.transactions = [
    { date: '2025-04-03' },
    { budgetMonth: '2025-06', date: '2025-05-31' },
    { budgetMonth: 'not-a-month', date: '2025-03-20' },
    { date: 'not-a-date' }
  ];
  state.payslips = [{ period: '2025-01' }, { period: '2025-13', payDate: '2025-02-28' }];

  assert.deepEqual(availableReportingMonths(state), ['2025-06', '2025-04', '2025-03', '2025-02', '2025-01']);
});

test('reporting months retain a usable selected-month fallback when there is no dated data', () => {
  const state = baseState();
  state.settings.selectedMonth = '2025-08';
  assert.deepEqual(availableReportingMonths(state), ['2025-08']);
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

test('a generated action snoozed until tomorrow is replaced with a five-minute check-in', () => {
  const state = { ...baseState(), accounts: [], settings: { ...baseState().settings, snoozedActions: { 'generated-first-account': '2025-01-11' } } };
  assert.equal(buildNextAction(state, new Date(2025, 0, 10, 12)).id, 'generated-checkin');
});

test('today completion recognises both action and five-minute check-ins but not another day', () => {
  const now = new Date(2025, 0, 10, 12);
  assert.equal(hasCompletedCheckIn([{ date: new Date(2025, 0, 10, 9).toISOString(), completed: true }], now), true);
  assert.equal(hasCompletedCheckIn([{ date: new Date(2025, 0, 9, 23).toISOString(), completed: true }], now), false);
  assert.equal(hasCompletedCheckIn([{ date: new Date(2025, 0, 10, 9).toISOString(), completed: false }], now), false);
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
  state.debts = [{ id: 'd', name: 'Card', type: 'Credit card', creditLimit: 1000, currentBalance: 500, apr: null, contractualPayment: 25, status: 'current', arrangementStatus: 'none', arrangementConfirmed: false, includeInPlan: true, planPriority: 2 }];
  state.overdrafts = [{ id: 'o', name: 'Bank overdraft', currentBalance: 200, limit: 100, apr: 0.399, contractualPayment: 0, status: 'over_limit', arrangementStatus: 'unknown', arrangementConfirmed: false, includeInPlan: true, planPriority: 1 }];
  const plan = debtPlan(state, 'hybrid', 100, '2025-02');
  assert.equal(plan.safeToOverpay, false);
  assert.deepEqual(plan.blockers, ['Bank overdraft']);
  assert.deepEqual(plan.unknownApr, ['Card']);
});

test('credit report planning updates matches, adds new debts and keeps overdrafts separate', () => {
  const debts = [{ id: 'existing-card', name: 'Example Card Provider Limited', type: 'Credit card', accountReference: '••••1234' }];
  const accounts = [
    { lender: 'Example Card Provider Ltd', accountType: 'Credit card', accountReference: '****1234', currentBalance: 400 },
    { lender: 'Example Loan Provider', accountType: 'Personal loan', currentBalance: 800 },
    { lender: 'Example Current Provider', accountType: 'Current account', currentBalance: 75 },
    { lender: 'Example Settled Provider', accountType: 'Store card', currentBalance: 0 }
  ];
  const plan = planCreditReportAccounts(debts, [], accounts);
  assert.deepEqual(plan.map((item) => item.action), ['existing', 'add-debt', 'add-overdraft', 'no-balance']);
});

test('reconciled statements create and then clear linked overdraft usage automatically', () => {
  const state = { overdrafts: [] };
  const account = { id: 'acct-1', name: 'Example Main', institution: 'Example Bank', openingBalance: null };
  const overdrawn = { reconciled: true, institution: 'Example Bank', records: [{ date: '2025-08-31' }], summary: { openingBalance: 100, closingBalance: -75, overdraftLimit: 100 } };
  assert.equal(syncStatementAccount(state, account, overdrawn, 'doc-1'), 'overdraft-created');
  assert.equal(account.currentBalance, -75);
  assert.equal(state.overdrafts[0].currentBalance, 75);
  assert.equal(state.overdrafts[0].limit, 100);
  const inCredit = { ...overdrawn, records: [{ date: '2025-09-30' }], summary: { ...overdrawn.summary, closingBalance: 25 } };
  assert.equal(syncStatementAccount(state, account, inCredit, 'doc-2'), 'overdraft-updated');
  assert.equal(state.overdrafts[0].currentBalance, 0);
});

test('CSV export quotes fields and neutralises spreadsheet formulas', () => {
  const csv = exportTransactionsCsv([{ date: '2025-01-10', accountId: 'a', description: '=HYPERLINK("bad")', userDescription: '', category: 'Other', incoming: 0, outgoing: 1, runningBalance: 0, transferStatus: 'no', notes: '@unsafe' }]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"'@unsafe"/);
});
