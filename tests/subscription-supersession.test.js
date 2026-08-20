import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import {
  activeSubscriptionRecords,
  confirmSubscriptionCandidate,
  deriveSubscriptionCandidates,
  listSubscriptionRecords,
  normaliseRecurringCost,
  setSubscriptionHidden,
  updateSubscriptionRanking
} from '../subscription-model.js';
import { buildSubscriptionSavingsRecommendation, setSubscriptionSavingsTarget } from '../subscription-savings.js';
import { buildSubscriptionsPresentation } from '../subscriptions-presentation.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('reconfirming materially changed evidence preserves history but exposes only the replacement as current', () => {
  let state = recurringState([
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12)
  ]);

  state = confirmSubscriptionCandidate(state, deriveSubscriptionCandidates(state)[0].id, new Date('2026-03-16T10:00:00.000Z'));
  const original = activeSubscriptionRecords(state)[0];
  assert.ok(original);

  state.transactions.push(monthlyRow('r4', '2026-04-15', 13));
  const changed = deriveSubscriptionCandidates(state)[0];
  assert.equal(changed.evidenceChanged, true);
  state = confirmSubscriptionCandidate(state, changed.id, new Date('2026-04-16T10:00:00.000Z'));

  const history = listSubscriptionRecords(state);
  const active = activeSubscriptionRecords(state);
  assert.equal(history.length, 2);
  assert.equal(active.length, 1);
  assert.notEqual(active[0].id, original.id);
  assert.equal(active[0].supersedesRecordId, original.id);
  assert.equal(history.some((record) => record.id === original.id), true);
});

test('presentation totals, ranking and savings use only the current replacement', () => {
  let state = confirmedReplacementState();
  const history = listSubscriptionRecords(state);
  const current = activeSubscriptionRecords(state)[0];
  const superseded = history.find((record) => record.id !== current.id);

  state = updateSubscriptionRanking(state, [superseded.id, current.id], new Date('2026-04-17T10:00:00.000Z'));
  const rankedCurrent = activeSubscriptionRecords(state)[0];
  const rankedHistory = listSubscriptionRecords(state);
  assert.equal(rankedCurrent.rank, 1);
  assert.equal(rankedHistory.find((record) => record.id === superseded.id).rank, null);

  const expectedCost = normaliseRecurringCost(rankedCurrent.amountRange, rankedCurrent.cadence);
  const presentation = buildSubscriptionsPresentation(state);
  assert.equal(presentation.activeRows.length, 1);
  assert.equal(presentation.activeRows[0].id, rankedCurrent.id);
  assert.equal(presentation.summary.monthly.min, expectedCost.monthly.min);
  assert.equal(presentation.summary.monthly.max, expectedCost.monthly.max);
  assert.equal(presentation.summary.annual.min, expectedCost.annual.min);
  assert.equal(presentation.summary.annual.max, expectedCost.annual.max);

  state = setSubscriptionSavingsTarget(state, 1, new Date('2026-04-17T10:05:00.000Z'));
  const recommendation = buildSubscriptionSavingsRecommendation(state);
  assert.equal(recommendation.eligibleCount, 1);
  assert.equal(recommendation.selected.length, 1);
  assert.equal(recommendation.selected[0].id, rankedCurrent.id);
  assert.equal(recommendation.selected.some((item) => item.id === superseded.id), false);
});

test('multi-step confirmed supersession chain retains exactly one current record', () => {
  let state = confirmedReplacementState();
  const second = activeSubscriptionRecords(state)[0];
  state.transactions.push(monthlyRow('r5', '2026-05-15', 14));
  const changedAgain = deriveSubscriptionCandidates(state)[0];
  assert.ok(changedAgain);
  state = confirmSubscriptionCandidate(state, changedAgain.id, new Date('2026-05-16T10:00:00.000Z'));

  const history = listSubscriptionRecords(state);
  const current = activeSubscriptionRecords(state);
  assert.equal(history.length, 3);
  assert.equal(current.length, 1);
  assert.equal(current[0].supersedesRecordId, second.id);
  assert.equal(history.filter((record) => record.id !== current[0].id).length, 2);
});

test('broken or cyclic supersession metadata does not silently hide otherwise valid confirmed records', () => {
  const state = confirmedReplacementState();
  const records = listSubscriptionRecords(state);
  const current = activeSubscriptionRecords(state)[0];
  const previous = records.find((record) => record.id !== current.id);

  const broken = structuredClone(state);
  subscriptionEnvelope(broken, current.id).subscription.supersedesRecordId = 'subscription_missing_record';
  assert.deepEqual(new Set(activeSubscriptionRecords(broken).map((record) => record.id)), new Set([previous.id, current.id]));

  const cyclic = structuredClone(state);
  subscriptionEnvelope(cyclic, current.id).subscription.supersedesRecordId = previous.id;
  subscriptionEnvelope(cyclic, previous.id).subscription.supersedesRecordId = current.id;
  assert.deepEqual(new Set(activeSubscriptionRecords(cyclic).map((record) => record.id)), new Set([previous.id, current.id]));
});

test('supersession current/history distinction survives restart and encrypted portable backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-subscription-supersession-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  let state = (await store.loadState()).state;
  state.transactions = [
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12)
  ];
  state.scheduledPayments = [];
  state = confirmSubscriptionCandidate(state, deriveSubscriptionCandidates(state)[0].id, new Date('2026-03-16T10:00:00.000Z'));
  state.transactions.push(monthlyRow('r4', '2026-04-15', 13));
  state = confirmSubscriptionCandidate(state, deriveSubscriptionCandidates(state)[0].id, new Date('2026-04-16T10:00:00.000Z'));
  state = await store.saveState(state);

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  assert.equal(listSubscriptionRecords(state).length, 2);
  assert.equal(activeSubscriptionRecords(state).length, 1);

  const currentId = activeSubscriptionRecords(state)[0].id;
  const backupPath = path.join(directory, 'supersession.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  state = setSubscriptionHidden(state, currentId, true, new Date('2026-04-17T10:00:00.000Z'));
  state = await restarted.saveState(state);
  assert.equal(activeSubscriptionRecords(state).length, 0);

  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(listSubscriptionRecords(restored.state).length, 2);
  assert.equal(activeSubscriptionRecords(restored.state).length, 1);
  assert.equal(activeSubscriptionRecords(restored.state)[0].id, currentId);
});

function confirmedReplacementState() {
  let state = recurringState([
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12)
  ]);
  state = confirmSubscriptionCandidate(state, deriveSubscriptionCandidates(state)[0].id, new Date('2026-03-16T10:00:00.000Z'));
  state.transactions.push(monthlyRow('r4', '2026-04-15', 13));
  state = confirmSubscriptionCandidate(state, deriveSubscriptionCandidates(state)[0].id, new Date('2026-04-16T10:00:00.000Z'));
  return state;
}

function recurringState(transactions) {
  return {
    transactions,
    scheduledPayments: [],
    accounts: [{ id: 'fictional-current', name: 'Fictional Current Account', type: 'current', currentBalance: 1000, active: true }],
    debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [],
    profile: { dependableIncome: 2000 },
    settings: { emergencyBufferTarget: 0, emergencyBufferBalance: 0 },
    automation: { enabled: true, reminders: [] }
  };
}

function monthlyRow(id, date, outgoing) {
  return {
    id,
    accountId: 'fictional-current',
    date,
    merchantName: 'Fictional Stream',
    description: 'Fictional Stream Entertainment',
    category: 'Entertainment',
    incoming: 0,
    outgoing,
    duplicateStatus: 'none',
    reviewStatus: 'not_required',
    importReviewStatus: 'trusted',
    financiallyActive: true
  };
}

function subscriptionEnvelope(state, id) {
  const envelope = state.scheduledPayments.find((entry) => entry?.recordKind === 'subscription' && entry?.subscription?.id === id);
  assert.ok(envelope);
  return envelope;
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
