import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
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

const seedPath = new URL('../seed-data.json', import.meta.url);

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

test('rank, protection and notes survive restart and encrypted portable backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-subscription-ranking-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  let state = (await store.loadState()).state;
  state = createManualSubscription(state, { providerName: 'Fictional Ranked Service', amount: 11, cadence: 'monthly', notes: 'Fictional note' }, at(0));
  const id = listSubscriptionRecords(state)[0].id;
  state = updateSubscriptionRanking(state, [id], at(1));
  state = setSubscriptionProtection(state, id, SUBSCRIPTION_PROTECTION.KEEP, at(2));
  state = await store.saveState(state);

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  let record = listSubscriptionRecords(state).find((item) => item.id === id);
  assert.equal(record.rank, 1);
  assert.equal(record.protectionState, SUBSCRIPTION_PROTECTION.KEEP);
  assert.equal(record.notes, 'Fictional note');

  const backupPath = path.join(directory, 'fictional-ranking.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  state = updateSubscriptionRanking(state, [], at(3));
  state = setSubscriptionProtection(state, id, SUBSCRIPTION_PROTECTION.NONE, at(4));
  await restarted.saveState(state);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  record = listSubscriptionRecords(restored.state).find((item) => item.id === id);
  assert.equal(record.rank, 1);
  assert.equal(record.protectionState, SUBSCRIPTION_PROTECTION.KEEP);
  assert.equal(record.notes, 'Fictional note');
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
function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
