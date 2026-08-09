import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { buildFinancialReport } from '../financial-reporting.js';

test('payment charts reconcile with Budget Intelligence and trusted cash-flow rules', () => {
  const input = reportingState();
  const report = buildFinancialReport(input, '2026-08', new Date('2026-09-10T12:00:00'));

  assert.equal(report.summary.spending, 110);
  assert.equal(report.summary.income, 1220);
  assert.equal(report.budget.actual, 90);
  assert.deepEqual(report.categories.map(({ label, amount }) => [label, amount]), [['Groceries', 60], ['Uncategorised', 30]]);
  assert.equal(report.categories.some((category) => category.label === 'Income'), false);
  assert.deepEqual(report.recurring, { committed: 60, flexible: 30, evidence: 'confirmed' });
  assert.equal(report.comparison.direction, 'lower');
  assert.equal(report.comparison.difference, -10);
});

test('all-time reporting uses trusted multi-month data rather than stretching one month', () => {
  const report = buildFinancialReport(reportingState(), 'all', new Date('2026-09-10T12:00:00'));
  assert.equal(report.fullTimeline.length, 2);
  assert.deepEqual(report.fullTimeline.map((row) => [row.month, row.spending]), [['2026-07', 100], ['2026-08', 90]]);
  assert.deepEqual(report.categories.map(({ label, amount }) => [label, amount]), [['Groceries', 160], ['Uncategorised', 30]]);
  assert.equal(report.summary.budgetActualSpending, 190);
});

test('the current month is explicitly incomplete rather than used as a like-for-like win', () => {
  const report = buildFinancialReport(reportingState(), '2026-08', new Date('2026-08-09T12:00:00'));
  assert.equal(report.comparison.incomplete, true);
  assert.match(report.comparison.text, /not like-for-like/i);
  assert.equal(report.wins.some((message) => /lower than last month/i.test(message)), false);
});

test('reporting stays practical with thousands of fictional transactions', () => {
  const input = reportingState();
  input.transactions = Array.from({ length: 5000 }, (_, index) => transaction({
    id: `fictional-${index}`, date: `2026-${String(index % 12 + 1).padStart(2, '0')}-${String(index % 28 + 1).padStart(2, '0')}`,
    budgetMonth: `2026-${String(index % 12 + 1).padStart(2, '0')}`, outgoing: 1, budgetCategoryId: 'groceries'
  }));
  const started = performance.now();
  const report = buildFinancialReport(input, 'all', new Date('2027-01-10T12:00:00'));
  assert.equal(report.summary.budgetActualSpending, 5000);
  assert.equal(report.fullTimeline.length, 12);
  assert.ok(performance.now() - started < 2000);
});

function reportingState() {
  return {
    profile: { dependableIncome: 2000 },
    accounts: [{ id: 'current', type: 'current', currentBalance: 400, active: true }],
    payslips: [], debts: [], overdrafts: [], scheduledPayments: [], reviewItems: [],
    settings: { selectedMonth: '2026-08', emergencyBufferBalance: 100, emergencyBufferTarget: 500 },
    budgets: [{ id: 'groceries', category: 'Groceries', planned: 300 }],
    transactions: [
      transaction({ id: 'july-spend', date: '2026-07-04', budgetMonth: '2026-07', outgoing: 100, budgetCategoryId: 'groceries' }),
      transaction({ id: 'july-income', date: '2026-07-01', budgetMonth: '2026-07', incoming: 1000, category: 'Income' }),
      transaction({ id: 'purchase', date: '2026-08-02', outgoing: 80, budgetCategoryId: 'groceries', recurring: true }),
      transaction({ id: 'refund', date: '2026-08-03', incoming: 20, refundOfTransactionId: 'purchase', budgetTreatment: 'refund', recurring: true }),
      transaction({ id: 'uncategorised', date: '2026-08-04', outgoing: 30 }),
      transaction({ id: 'income', date: '2026-08-01', incoming: 1200, category: 'Income' }),
      transaction({ id: 'internal', date: '2026-08-05', outgoing: 200, transferStatus: 'confirmed' }),
      transaction({ id: 'savings', date: '2026-08-06', outgoing: 100, budgetTreatment: 'savings_transfer' }),
      transaction({ id: 'pending', date: '2026-08-07', outgoing: 999, financiallyActive: false, duplicateStatus: 'possible', reviewStatus: 'pending' })
    ]
  };
}

function transaction(overrides = {}) {
  return {
    id: 'transaction', date: '2026-08-01', budgetMonth: '2026-08', incoming: 0, outgoing: 0,
    category: '', budgetCategoryId: '', budgetTreatment: 'auto', transferStatus: 'no', duplicateStatus: 'none',
    reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true, ...overrides
  };
}
