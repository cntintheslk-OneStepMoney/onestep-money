import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUBSCRIPTION_PROTECTION,
  createManualSubscription,
  listSubscriptionRecords,
  setSubscriptionProtection,
  updateSubscriptionRanking
} from '../subscription-model.js';

test('subscription rank, protection and notes survive JSON persistence without changing financial envelope values', () => {
  let state = { transactions: [], scheduledPayments: [], accounts: [], debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [], profile: {}, settings: {}, automation: {} };
  state = createManualSubscription(state, { providerName: 'Fictional Reader', amount: 9.5, cadence: 'monthly', notes: 'Fictional note' }, new Date('2026-08-20T08:00:00.000Z'));
  const id = listSubscriptionRecords(state)[0].id;
  state = updateSubscriptionRanking(state, [id], new Date('2026-08-20T08:01:00.000Z'));
  state = setSubscriptionProtection(state, id, SUBSCRIPTION_PROTECTION.KEEP, new Date('2026-08-20T08:02:00.000Z'));
  const roundTripped = JSON.parse(JSON.stringify(state));
  const record = listSubscriptionRecords(roundTripped)[0];
  const envelope = roundTripped.scheduledPayments.find((row) => row.id === id);
  assert.equal(record.rank, 1);
  assert.equal(record.protectionState, SUBSCRIPTION_PROTECTION.KEEP);
  assert.equal(record.notes, 'Fictional note');
  assert.equal(envelope.amount, 0);
  assert.equal(envelope.outgoing, 0);
  assert.equal(envelope.active, false);
  assert.equal(envelope.status, 'resolved');
});
