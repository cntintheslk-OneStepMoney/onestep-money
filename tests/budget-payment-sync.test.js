import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateBudgetAnalysis, calculateBudgetRows, calculatePeriodSummary } from '../finance-core.js';

function state(overrides = {}) {
  return {
    profile: { dependableIncome: 2000 },
    settings: { selectedMonth: '2026-08' },
    accounts: [], payslips: [], debts: [], overdrafts: [], scheduledPayments: [],
    budgets: [{ id: 'groceries', category: 'Groceries', planned: 200 }],
    transactions: [],
    ...overrides
  };
}

function outgoing(id, amount, overrides = {}) {
  return { id, date: '2026-08-08', budgetMonth: '2026-08', incoming: 0, outgoing: amount, transferStatus: 'no', description: `Fictional payment ${id}`, ...overrides };
}

test('categorised imported and manual payments become one budget actual for the selected month', () => {
  const input = state({ transactions: [
    outgoing('imported', 50, { source: 'fictional.csv', category: 'Groceries' }),
    outgoing('manual', 30, { source: 'manual', budgetCategoryId: 'groceries', categorySource: 'manual' }),
    outgoing('previous', 100, { budgetMonth: '2026-07', date: '2026-07-31', category: 'Groceries' })
  ] });
  const analysis = calculateBudgetAnalysis(input);
  assert.equal(analysis.rows[0].actual, 80);
  assert.equal(analysis.rows[0].remaining, 120);
  assert.equal(analysis.rows[0].contributions.length, 2);
  assert.equal(analysis.actual, 80);
});

test('overspending is retained above 100 percent and reported as a negative remaining plan', () => {
  const analysis = calculateBudgetAnalysis(state({ transactions: [outgoing('large', 130, { category: 'Groceries' })], budgets: [{ id: 'groceries', category: 'Groceries', planned: 100 }] }));
  assert.equal(analysis.rows[0].actual, 130);
  assert.equal(analysis.rows[0].remaining, -30);
  assert.equal(analysis.rows[0].progressPercent, 130);
});

test('confirmed internal transfers and explicit savings transfers do not count as spending', () => {
  const input = state({ transactions: [
    outgoing('transfer-out', 300, { transferStatus: 'confirmed', category: 'Groceries' }),
    { id: 'transfer-in', date: '2026-08-08', budgetMonth: '2026-08', incoming: 300, outgoing: 0, transferStatus: 'confirmed' },
    outgoing('savings', 200, { budgetTreatment: 'savings_transfer' })
  ] });
  const analysis = calculateBudgetAnalysis(input);
  assert.equal(analysis.actual, 0);
  assert.equal(analysis.uncategorisedActual, 0);
});

test('debt repayments are excluded unless assigned to an explicit commitment budget', () => {
  const input = state({
    budgets: [
      { id: 'groceries', category: 'Groceries', planned: 200 },
      { id: 'debt', category: 'Debt commitment', section: 'Debt minimums', planned: 100 }
    ],
    transactions: [
      outgoing('unassigned-debt', 50, { category: 'Debt payment', budgetTreatment: 'debt_payment' }),
      outgoing('assigned-debt', 75, { category: 'Debt payment', budgetTreatment: 'debt_payment', budgetCategoryId: 'debt', categorySource: 'manual' })
    ]
  });
  const analysis = calculateBudgetAnalysis(input);
  assert.equal(analysis.rows.find((row) => row.id === 'debt').actual, 75);
  assert.equal(analysis.uncategorisedActual, 0);
  assert.equal(analysis.actual, 75);
});

test('scheduled commitments do not double count an actual payment', () => {
  const input = state({
    scheduledPayments: [{ id: 'phone-plan', amount: 30, dueDate: '2026-08-09' }],
    budgets: [{ id: 'phone', category: 'Phone', planned: 30 }],
    transactions: [outgoing('phone-paid', 30, { budgetCategoryId: 'phone', categorySource: 'manual' })]
  });
  assert.equal(calculateBudgetAnalysis(input).actual, 30);
});

test('a categorised refund and full reversal reduce the original category in pennies', () => {
  const input = state({ transactions: [
    outgoing('purchase', 80, { category: 'Groceries' }),
    { id: 'refund', date: '2026-08-09', budgetMonth: '2026-08', incoming: 30, outgoing: 0, transferStatus: 'no', refundOfTransactionId: 'purchase', budgetTreatment: 'refund' },
    outgoing('reversed-payment', 42, { category: 'Groceries' }),
    { id: 'reversal', date: '2026-08-10', budgetMonth: '2026-08', incoming: 42, outgoing: 0, transferStatus: 'no', reversalOfTransactionId: 'reversed-payment', budgetTreatment: 'reversal' }
  ] });
  const row = calculateBudgetRows(input)[0];
  assert.equal(row.actual, 50);
  assert.equal(row.remaining, 150);
});

test('a refund larger than spending remains accurate without a negative progress value', () => {
  const input = state({ transactions: [
    outgoing('purchase', 10, { budgetCategoryId: 'groceries', categorySource: 'manual' }),
    { id: 'refund', date: '2026-08-09', budgetMonth: '2026-08', incoming: 20, outgoing: 0, transferStatus: 'no', budgetCategoryId: 'groceries', categorySource: 'manual', budgetTreatment: 'refund' }
  ] });
  const row = calculateBudgetRows(input)[0];
  assert.equal(row.actual, -10);
  assert.equal(row.remaining, 210);
  assert.equal(row.progressPercent, 0);
});

test('uncategorised spending is explicit and reconciles with category totals', () => {
  const analysis = calculateBudgetAnalysis(state({ transactions: [
    outgoing('known', 50, { category: 'Groceries' }),
    outgoing('unknown', 25, { category: '' })
  ] }));
  assert.equal(analysis.categorisedActual, 50);
  assert.equal(analysis.uncategorisedActual, 25);
  assert.equal(analysis.actual, 75);
  assert.equal(analysis.remaining, 125);
  assert.equal(analysis.coveragePercent, 67);
  assert.deepEqual(analysis.uncategorisedTransactionIds, ['unknown']);
});

test('a manual uncategorised override wins over an imported category label', () => {
  const analysis = calculateBudgetAnalysis(state({ transactions: [
    outgoing('manual-override', 40, { category: 'Groceries', budgetCategoryId: '', categorySource: 'manual' })
  ] }));
  assert.equal(analysis.rows[0].actual, 0);
  assert.equal(analysis.uncategorisedActual, 40);
});

test('exact duplicates are excluded while legitimate same-value payments both count', () => {
  const input = state({ transactions: [
    outgoing('first', 20, { category: 'Groceries' }),
    outgoing('second', 20, { category: 'Groceries' }),
    outgoing('duplicate', 20, { category: 'Groceries', duplicateStatus: 'exact' })
  ] });
  assert.equal(calculateBudgetAnalysis(input).actual, 40);
});

test('stable budget identifiers preserve relationships across a category rename', () => {
  const input = state({
    budgets: [{ id: 'food', category: 'Food and groceries', planned: 250 }],
    transactions: [outgoing('tesco', 45, { category: 'Groceries', budgetCategoryId: 'food', categorySource: 'manual' })]
  });
  assert.equal(calculateBudgetRows(input)[0].actual, 45);
});

test('a deleted category leaves its transaction intact and explicitly uncategorised', () => {
  const transaction = outgoing('preserved', 45, { category: 'Old category', budgetCategoryId: '', categorySource: 'manual' });
  const analysis = calculateBudgetAnalysis(state({ budgets: [], transactions: [transaction] }));
  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.uncategorisedActual, 45);
  assert.equal(transaction.outgoing, 45);
});

test('edited amount, date and planned amount are derived without cached actuals', () => {
  const input = state({ transactions: [outgoing('editable', 40, { category: 'Groceries' })] });
  assert.equal(calculateBudgetAnalysis(input).rows[0].remaining, 160);
  input.transactions[0].outgoing = 45;
  assert.equal(calculateBudgetAnalysis(input).rows[0].actual, 45);
  input.transactions[0].budgetMonth = '2026-07';
  assert.equal(calculateBudgetAnalysis(input).rows[0].actual, 0);
  input.transactions[0].budgetMonth = '2026-08';
  input.budgets[0].planned = 250;
  assert.equal(calculateBudgetAnalysis(input).rows[0].remaining, 205);
});

test('zero plans and penny arithmetic remain safe', () => {
  const input = state({
    budgets: [{ id: 'groceries', category: 'Groceries', planned: 0 }],
    transactions: [outgoing('one', 0.1, { category: 'Groceries' }), outgoing('two', 0.2, { category: 'Groceries' })]
  });
  const row = calculateBudgetRows(input)[0];
  assert.equal(row.actual, 0.3);
  assert.equal(row.remaining, -0.3);
  assert.equal(row.progressPercent, null);
});

test('period summary exposes the same shared budget totals used by the budget rows', () => {
  const input = state({ transactions: [outgoing('known', 50, { category: 'Groceries' }), outgoing('unknown', 25)] });
  const summary = calculatePeriodSummary(input);
  assert.equal(summary.budgetCategorisedSpending, 50);
  assert.equal(summary.budgetUncategorisedSpending, 25);
  assert.equal(summary.budgetActualSpending, 75);
  assert.equal(summary.budgetRemaining, 125);
});
