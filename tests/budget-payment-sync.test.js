import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  calculateBudgetAnalysis, calculateBudgetRows, calculatePeriodSummary, findSavingsOpportunities,
  isTransactionFinanciallyActive, removeBudgetCategory, resolvePossibleDuplicate
} from '../finance-core.js';
import { financialSnapshot } from '../local-llm-service.js';

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

test('budget plan versus actual rows sort from highest percentage used to lowest', () => {
  const input = state({
    budgets: [
      { id: 'unused', category: 'Unused', planned: 100 },
      { id: 'quarter-used', category: 'Quarter used', planned: 200 },
      { id: 'mostly-used', category: 'Mostly used', planned: 100 },
      { id: 'over-budget', category: 'Over budget', planned: 100 }
    ],
    transactions: [
      outgoing('quarter-payment', 50, { budgetCategoryId: 'quarter-used', categorySource: 'manual' }),
      outgoing('mostly-payment', 90, { budgetCategoryId: 'mostly-used', categorySource: 'manual' }),
      outgoing('over-payment', 130, { budgetCategoryId: 'over-budget', categorySource: 'manual' })
    ]
  });

  const rows = calculateBudgetRows(input);
  assert.deepEqual(rows.map((row) => row.id), ['over-budget', 'mostly-used', 'quarter-used', 'unused']);
  assert.deepEqual(rows.map((row) => row.progressPercent), [130, 90, 25, 0]);
});

test('spending against a zero plan is prioritised above percentage-based rows', () => {
  const input = state({
    budgets: [
      { id: 'over-budget', category: 'Over budget', planned: 100 },
      { id: 'unplanned', category: 'Unplanned', planned: 0 }
    ],
    transactions: [
      outgoing('over-payment', 150, { budgetCategoryId: 'over-budget', categorySource: 'manual' }),
      outgoing('unplanned-payment', 10, { budgetCategoryId: 'unplanned', categorySource: 'manual' })
    ]
  });

  const rows = calculateBudgetRows(input);
  assert.deepEqual(rows.map((row) => row.id), ['unplanned', 'over-budget']);
  assert.equal(rows[0].progressPercent, null);
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

test('pending possible duplicates remain stored but inactive until explicitly accepted', () => {
  const pendingExpense = outgoing('possible-expense', 120, {
    category: 'Groceries', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false
  });
  const pendingIncome = {
    id: 'possible-income', date: '2026-08-08', budgetMonth: '2026-08', incoming: 500, outgoing: 0,
    transferStatus: 'no', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false
  };
  const input = state({ transactions: [pendingExpense, pendingIncome] });

  assert.equal(input.transactions.length, 2);
  assert.equal(isTransactionFinanciallyActive(pendingExpense), false);
  assert.equal(calculateBudgetAnalysis(input).actual, 0);
  assert.equal(calculatePeriodSummary(input).spending, 0);
  assert.equal(calculatePeriodSummary(input).income, 0);
  assert.deepEqual(findSavingsOpportunities(input), []);
  assert.match(financialSnapshot(input), /External cash flow: £0\.00 in; £0\.00 out; £0\.00 net/);

  const accepted = resolvePossibleDuplicate(input, pendingExpense.id, 'accepted');
  assert.equal(isTransactionFinanciallyActive(accepted.transactions[0]), true);
  assert.equal(calculateBudgetAnalysis(accepted).actual, 120);
  assert.equal(calculatePeriodSummary(accepted).spending, 120);

  const rejected = resolvePossibleDuplicate(input, pendingExpense.id, 'rejected');
  assert.equal(rejected.transactions.length, 2);
  assert.equal(isTransactionFinanciallyActive(rejected.transactions[0]), false);
  assert.equal(calculateBudgetAnalysis(rejected).actual, 0);
});

test('Savings Opportunities reconcile transfers, review state, refunds, reversals and user overrides with Budget Intelligence', () => {
  const input = state({
    budgets: [{ id: 'shopping', category: 'Shopping', planned: 50 }],
    transactions: [
      outgoing('purchase', 200, { category: 'Shopping' }),
      { id: 'refund', date: '2026-08-09', budgetMonth: '2026-08', incoming: 30, outgoing: 0, transferStatus: 'no', refundOfTransactionId: 'purchase', budgetTreatment: 'refund' },
      outgoing('reversed-purchase', 40, { category: 'Shopping' }),
      { id: 'reversal', date: '2026-08-10', budgetMonth: '2026-08', incoming: 40, outgoing: 0, transferStatus: 'no', reversalOfTransactionId: 'reversed-purchase', budgetTreatment: 'reversal' },
      outgoing('transfer', 300, { category: 'Shopping', transferStatus: 'confirmed' }),
      outgoing('savings', 200, { category: 'Shopping', budgetTreatment: 'savings_transfer' }),
      outgoing('ignored', 100, { category: 'Shopping', budgetTreatment: 'ignored' }),
      outgoing('exact', 100, { category: 'Shopping', duplicateStatus: 'exact' }),
      outgoing('pending', 100, { category: 'Shopping', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false }),
      outgoing('debt', 100, { category: 'Debt payment', budgetTreatment: 'debt_payment' }),
      outgoing('manual-uncategorised', 100, { category: 'Shopping', categorySource: 'manual', budgetCategoryId: '' }),
      outgoing('manual-shopping', 20, { category: 'Other', categorySource: 'manual', budgetCategoryId: 'shopping' })
    ]
  });

  const analysis = calculateBudgetAnalysis(input);
  const opportunity = findSavingsOpportunities(input).find((item) => item.category === 'Shopping');
  assert.equal(analysis.rows[0].actual, 190);
  assert.equal(opportunity.average, 190);
  assert.equal(opportunity.target, 50);
  assert.equal(opportunity.possibleSaving, 140);
});

test('stable budget identifiers preserve relationships across a category rename', () => {
  const input = state({
    budgets: [{ id: 'food', category: 'Food and groceries', planned: 250 }],
    transactions: [outgoing('tesco', 45, { category: 'Groceries', budgetCategoryId: 'food', categorySource: 'manual' })]
  });
  assert.equal(calculateBudgetRows(input)[0].actual, 45);
});

test('a deleted category leaves its transaction intact and explicitly uncategorised', () => {
  const input = state({ transactions: [outgoing('preserved', 45, { category: 'Groceries', budgetCategoryId: 'groceries', categorySource: 'manual' })] });
  const removed = removeBudgetCategory(input, 'groceries');
  const analysis = calculateBudgetAnalysis(removed);
  assert.equal(analysis.rows.length, 0);
  assert.equal(analysis.uncategorisedActual, 45);
  assert.equal(removed.transactions[0].outgoing, 45);
  assert.equal(removed.transactions[0].budgetCategoryId, '');
  assert.equal(removed.transactions[0].categorySource, 'manual');
  assert.equal(input.budgets.length, 1);
  assert.equal(input.transactions[0].budgetCategoryId, 'groceries');
});

test('budget rows expose clear accessible edit and remove controls', () => {
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');
  const styles = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(renderer, /actionButton\('budget', item\.id, 'Edit'\)/);
  assert.match(renderer, /dataset\.budgetRemove = item\.id/);
  assert.match(renderer, /Edit \$\{item\.category\} budget/);
  assert.match(renderer, /Remove \$\{item\.category\} from budget/);
  assert.match(styles, /\.budget-item-actions\s*\{[^}]*display: flex/);
  assert.match(styles, /\.budget-remove-button\s*\{/);
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
