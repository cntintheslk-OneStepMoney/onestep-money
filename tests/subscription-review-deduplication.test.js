import assert from 'node:assert/strict';
import test from 'node:test';
import { activeReviewItems, synchroniseReviewItems } from '../review-lifecycle.js';
import { SUBSCRIPTION_REVIEW_TYPE } from '../subscription-workflow.js';

function stateWithLikelyRecurringSubscription() {
  return {
    accounts: [], debts: [], overdrafts: [], budgets: [], scheduledPayments: [], tasks: [], reviewItems: [], documents: [], importBatches: [],
    payslips: [], creditReports: [], checkIns: [], profile: {}, settings: {}, automation: {},
    transactions: ['2026-04-15', '2026-05-15', '2026-06-15'].map((date, index) => ({
      id: `fictional-subscription-${index}`,
      accountId: 'fictional-account',
      date,
      incoming: 0,
      outgoing: 12,
      merchantName: 'Fictional Stream',
      category: 'Subscriptions & software',
      transferStatus: 'no',
      financiallyActive: true
    }))
  };
}

test('one recurring subscription candidate produces one active Review path', () => {
  const state = stateWithLikelyRecurringSubscription();
  const now = new Date('2026-08-20T09:00:00Z');
  synchroniseReviewItems(state, now);
  const active = activeReviewItems(state, now);
  const subscription = active.filter((item) => item.type === SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION);
  const legacyRecurring = active.filter((item) => item.type === 'recurring_pattern_confirmation');
  assert.equal(subscription.length, 1);
  assert.equal(legacyRecurring.length, 0);
  synchroniseReviewItems(state, now);
  assert.equal(activeReviewItems(state, now).filter((item) => item.type === SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION).length, 1);
});
