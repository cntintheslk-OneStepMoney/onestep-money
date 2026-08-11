import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDebtRecommendationPresentationModel } from '../financial-presentation-debt.js';

test('debt presentation keeps required and optional amounts separate', () => {
  const model = buildDebtRecommendationPresentationModel({
    status: 'recommendation_available',
    strategy: 'recommended',
    priorityDebt: { id: 'card-a', name: 'Card A', balance: 640, apr: 0.249 },
    alternativeDebt: { id: 'loan-b', name: 'Loan B', balance: 1200, apr: 0.119 },
    requiredPayments: [{ debtId: 'card-a', name: 'Card A', amount: 30, type: 'contractual_minimum' }],
    requiredPaymentTotal: 30,
    maximumSafeOptionalAmount: 75,
    blockers: [],
    why: ['Card A is the highest-cost eligible account.'],
    capacity: { expectedIncomeCountedAsCurrentCash: false },
    externalPaymentMade: false
  });

  assert.equal(model.requiredPaymentTotal, 30);
  assert.equal(model.maximumSafeOptionalAmount, 75);
  assert.equal(model.priority.name, 'Card A');
  assert.equal(model.externalPaymentMade, false);
});
