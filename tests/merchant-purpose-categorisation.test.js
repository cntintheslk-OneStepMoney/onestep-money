import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculateBudgetAnalysis, calculatePeriodSummary } from '../finance-core.js';
import { activeReviewItems, synchroniseReviewItems } from '../review-lifecycle.js';
import { resolveTransactionBudgetAssignment } from '../transaction-categorisation.js';

const budgets = [
  { id: 'groceries', category: 'Groceries', planned: 200, merchantTerms: ['fictional store'] },
  { id: 'fuel', category: 'Fuel', planned: 120, merchantTerms: ['fictional store'] }
];

function transaction(id, overrides = {}) {
  return {
    id, date: '2026-08-08', budgetMonth: '2026-08', incoming: 0, outgoing: 20,
    transferStatus: 'no', description: 'Fictional Store', merchantName: 'Fictional Store',
    ...overrides
  };
}

function state(transactions, overrides = {}) {
  return {
    profile: { dependableIncome: 2000 }, settings: { selectedMonth: '2026-08' },
    accounts: [], payslips: [], debts: [], overdrafts: [], scheduledPayments: [],
    budgets, transactions, reviewItems: [], ...overrides
  };
}

test('one merchant can have separate Groceries and Fuel purposes', () => {
  const transactions = [
    transaction('groceries', { budgetCategoryId: 'groceries', category: 'Groceries', categorySource: 'manual' }),
    transaction('fuel', { budgetCategoryId: 'fuel', category: 'Fuel', categorySource: 'manual' })
  ];
  const analysis = calculateBudgetAnalysis(state(transactions));
  assert.equal(analysis.rows.find((row) => row.id === 'groceries').actual, 20);
  assert.equal(analysis.rows.find((row) => row.id === 'fuel').actual, 20);
});

test('conflicting merchant history leaves a generic payment uncategorised and in Review Inbox', () => {
  const transactions = [
    transaction('groceries', { budgetCategoryId: 'groceries', category: 'Groceries', categorySource: 'manual' }),
    transaction('fuel', { budgetCategoryId: 'fuel', category: 'Fuel', categorySource: 'manual' }),
    transaction('unknown')
  ];
  const input = state(transactions);
  assert.equal(resolveTransactionBudgetAssignment(transactions[2], { budgets, transactions }).budget, null);
  assert.deepEqual(calculateBudgetAnalysis(input).uncategorisedTransactionIds, ['unknown']);
  synchroniseReviewItems(input);
  assert.equal(activeReviewItems(input).some((item) => item.sourceId === 'unknown' && item.type === 'uncategorised_payment'), true);
});

test('a repeated specific local descriptor can resolve one confirmed purpose', () => {
  const transactions = [
    transaction('known-fuel', {
      description: 'Fictional Store Fuel Pump 123', budgetCategoryId: 'fuel', category: 'Fuel', categorySource: 'manual'
    }),
    transaction('new-fuel', { description: 'Fictional Store Fuel Pump 987' })
  ];
  const result = resolveTransactionBudgetAssignment(transactions[1], { budgets, transactions });
  assert.equal(result.budget.id, 'fuel');
  assert.equal(result.reason, 'confirmed_context');
});

test('manual decisions win, including a deliberate uncategorised choice', () => {
  const history = transaction('known-fuel', {
    description: 'Fictional Store Fuel Pump 123', budgetCategoryId: 'fuel', category: 'Fuel', categorySource: 'manual'
  });
  const override = transaction('override', {
    description: 'Fictional Store Fuel Pump 987', budgetCategoryId: 'groceries', category: 'Groceries', categorySource: 'manual'
  });
  const deliberatelyUncategorised = transaction('manual-none', {
    description: 'Fictional Store Fuel Pump 222', budgetCategoryId: '', category: 'Fuel', categorySource: 'manual'
  });
  assert.equal(resolveTransactionBudgetAssignment(override, { budgets, transactions: [history, override] }).budget.id, 'groceries');
  assert.equal(resolveTransactionBudgetAssignment(deliberatelyUncategorised, { budgets, transactions: [history, deliberatelyUncategorised] }).budget, null);
});

test('merchant identity and purpose stay independent, while legacy category evidence still works', () => {
  const categorised = transaction('categorised', { merchantName: 'Different Fictional Merchant', category: 'Groceries' });
  const reassignedMerchant = { ...categorised, merchantName: 'Another Fictional Merchant' };
  assert.equal(resolveTransactionBudgetAssignment(categorised, { budgets, transactions: [categorised] }).budget.id, 'groceries');
  assert.equal(resolveTransactionBudgetAssignment(reassignedMerchant, { budgets, transactions: [reassignedMerchant] }).budget.id, 'groceries');
});

test('Payments and Review Inbox label merchant and purpose separately', () => {
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');
  const reviewLifecycle = fs.readFileSync(new URL('../review-lifecycle.js', import.meta.url), 'utf8');
  assert.match(renderer, /Merchant \/ payee \(who was paid\)/);
  assert.match(renderer, /Transaction purpose \/ budget category \(what it was for\)/);
  assert.match(renderer, /Purpose: \$\{purpose\}/);
  assert.match(reviewLifecycle, /transaction\?\.merchantName \|\| transaction\?\.userDescription/);
});

test('financial treatment rules and selected-month / All-Time reporting remain intact', () => {
  const transactions = [
    transaction('august-groceries', { budgetCategoryId: 'groceries', category: 'Groceries', categorySource: 'manual' }),
    transaction('july-groceries', { date: '2026-07-08', budgetMonth: '2026-07', budgetCategoryId: 'groceries', category: 'Groceries', categorySource: 'manual' }),
    transaction('income', { incoming: 1000, outgoing: 0, category: 'Income' }),
    transaction('transfer', { transferStatus: 'confirmed', budgetCategoryId: 'fuel', category: 'Fuel' }),
    transaction('refund', { incoming: 5, outgoing: 0, budgetTreatment: 'refund', refundOfTransactionId: 'august-groceries' }),
    transaction('possible-duplicate', { duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false, budgetCategoryId: 'fuel', category: 'Fuel' })
  ];
  const august = state(transactions);
  const allTime = state(transactions, { settings: { selectedMonth: 'all' } });
  assert.equal(calculateBudgetAnalysis(august).rows.find((row) => row.id === 'groceries').actual, 15);
  assert.equal(calculateBudgetAnalysis(august).rows.find((row) => row.id === 'fuel').actual, 0);
  assert.equal(calculateBudgetAnalysis(allTime).rows.find((row) => row.id === 'groceries').actual, 35);
  assert.equal(calculatePeriodSummary(allTime).budgetCategorisedSpending, 35);
});
