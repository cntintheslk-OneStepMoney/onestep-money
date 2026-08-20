import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBSCRIPTION_PROTECTION,
  createManualSubscription,
  listSubscriptionRecords,
  setSubscriptionProtection,
  updateSubscriptionRanking
} from '../subscription-model.js';
import {
  SUBSCRIPTION_FILTER,
  SUBSCRIPTION_SORT,
  buildSubscriptionsPresentation,
  filterAndSortSubscriptionRows
} from '../subscriptions-presentation.js';

test('subscription presentation uses authoritative normalised costs and preserves variable ranges', () => {
  let state = baseState();
  state = createManualSubscription(state, { providerName: 'Fictional Monthly', amount: 12, cadence: 'monthly' }, at(0));
  state = createManualSubscription(state, { providerName: 'Fictional Variable', amountRange: { min: 8, max: 12, typical: 10 }, cadence: 'monthly' }, at(1));
  const view = buildSubscriptionsPresentation(state);
  assert.equal(view.summary.activeCount, 2);
  assert.deepEqual(view.summary.monthly, { min: 20, max: 24, typical: 22, exact: null, variable: true });
  assert.deepEqual(view.summary.annual, { min: 240, max: 288, typical: 264, exact: null, variable: true });
  assert.equal(view.summary.potentialSavings, null);
});

test('ranking and protection are authoritative persisted subscription state and remain separate', () => {
  let state = baseState();
  state = createManualSubscription(state, { providerName: 'Fictional One', amount: 5, cadence: 'monthly' }, at(0));
  state = createManualSubscription(state, { providerName: 'Fictional Two', amount: 10, cadence: 'monthly' }, at(1));
  const [one, two] = listSubscriptionRecords(state);
  state = updateSubscriptionRanking(state, [two.id, one.id], at(2));
  state = setSubscriptionProtection(state, one.id, SUBSCRIPTION_PROTECTION.ESSENTIAL, at(3));
  const records = listSubscriptionRecords(JSON.parse(JSON.stringify(state)));
  assert.equal(records.find((record) => record.id === two.id).rank, 1);
  assert.equal(records.find((record) => record.id === one.id).rank, 2);
  assert.equal(records.find((record) => record.id === one.id).protectionState, SUBSCRIPTION_PROTECTION.ESSENTIAL);
  assert.equal(records.find((record) => record.id === two.id).protectionState, SUBSCRIPTION_PROTECTION.NONE);
});

test('legacy rankingExcluded records migrate to explicit excluded protection', () => {
  const state = baseState();
  state.scheduledPayments.push({
    id: 'subscription_manual_legacy01', recordKind: 'subscription', active: false, includedInBudget: true, status: 'resolved', amount: 0,
    subscription: {
      id: 'subscription_manual_legacy01', source: 'manual', classification: 'manual', decisionState: 'confirmed', visibility: 'active',
      providerName: 'Fictional Legacy', cadence: 'monthly', amountRange: { min: 9, max: 9, typical: 9 }, rankingExcluded: true,
      createdAt: at(0).toISOString(), updatedAt: at(0).toISOString(), confirmedAt: at(0).toISOString()
    }
  });
  const [record] = listSubscriptionRecords(state);
  assert.equal(record.protectionState, SUBSCRIPTION_PROTECTION.EXCLUDED);
  assert.equal(record.rankingExcluded, true);
});

test('filters and sorts keep review candidates distinct from confirmed subscriptions', () => {
  const rows = [
    { id: 'a', providerName: 'Alpha', lifecycleStatus: 'active', rank: 2, protectionState: 'none', cost: { monthly: { typical: 5 } } },
    { id: 'b', providerName: 'Beta', lifecycleStatus: 'active', rank: null, protectionState: 'keep', cost: { monthly: { typical: 20 } } },
    { id: 'c', providerName: 'Candidate', lifecycleStatus: 'review', rank: null, protectionState: 'none', cost: { monthly: { typical: 50 } } }
  ];
  assert.deepEqual(filterAndSortSubscriptionRows(rows, { filter: SUBSCRIPTION_FILTER.UNRANKED }).map((row) => row.id), ['b']);
  assert.deepEqual(filterAndSortSubscriptionRows(rows, { filter: SUBSCRIPTION_FILTER.PROTECTED }).map((row) => row.id), ['b']);
  assert.deepEqual(filterAndSortSubscriptionRows(rows, { filter: SUBSCRIPTION_FILTER.REVIEW }).map((row) => row.id), ['c']);
  assert.deepEqual(filterAndSortSubscriptionRows(rows, { sort: SUBSCRIPTION_SORT.COST_HIGH }).map((row) => row.id), ['c', 'b', 'a']);
  assert.deepEqual(filterAndSortSubscriptionRows(rows, { sort: SUBSCRIPTION_SORT.RANK_HIGH }).map((row) => row.id), ['a', 'b', 'c']);
});

function baseState() {
  return {
    transactions: [], scheduledPayments: [], accounts: [{ id: 'fictional-account', name: 'Fictional Account' }], debts: [], overdrafts: [], budgets: [],
    tasks: [], reviewItems: [], profile: {}, settings: {}, automation: { enabled: true }
  };
}
function at(offset) { return new Date(Date.UTC(2026, 7, 20, 8, offset, 0)); }
