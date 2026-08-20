import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import { debtSafetyAssessment } from '../finance-core.js';
import { listFinancialReminderSources } from '../financial-reminders.js';
import {
  SUBSCRIPTION_PROTECTION,
  createManualSubscription,
  listSubscriptionRecords,
  setSubscriptionProtection,
  updateSubscriptionRanking
} from '../subscription-model.js';
import {
  SUBSCRIPTION_SAVINGS_EXCLUSION,
  SUBSCRIPTION_SAVINGS_STATUS,
  buildSubscriptionSavingsRecommendation,
  readSubscriptionSavingsTarget,
  setSubscriptionSavingsTarget
} from '../subscription-savings.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('lowest personal-value subscriptions are accumulated until the conservative target is met', () => {
  let state = baseState();
  state = add(state, 'Highest value', 20, 0);
  state = add(state, 'Middle value', 10, 1);
  state = add(state, 'Lowest value', 5, 2);
  const records = listSubscriptionRecords(state);
  const ids = Object.fromEntries(records.map((record) => [record.providerName, record.id]));
  state = updateSubscriptionRanking(state, [ids['Highest value'], ids['Middle value'], ids['Lowest value']], at(5));
  const before = structuredClone(state);
  const recommendation = buildSubscriptionSavingsRecommendation(state, { monthlyTarget: 15 });
  assert.equal(recommendation.status, SUBSCRIPTION_SAVINGS_STATUS.MET);
  assert.deepEqual(recommendation.selected.map((item) => item.providerName), ['Lowest value', 'Middle value']);
  assert.equal(recommendation.monthly.min, 15);
  assert.equal(recommendation.monthly.exact, 15);
  assert.equal(recommendation.annual.exact, 180);
  assert.equal(recommendation.bottomPercent, 67);
  assert.equal(recommendation.remainingGap, 0);
  assert.equal(recommendation.adviceOnly, true);
  assert.deepEqual(state, before);
});

test('protected and unranked subscriptions are never substituted to force target coverage', () => {
  let state = baseState();
  state = add(state, 'Eligible low value', 4, 0);
  state = add(state, 'Essential service', 40, 1);
  state = add(state, 'Unranked service', 30, 2);
  const records = listSubscriptionRecords(state);
  const eligible = records.find((item) => item.providerName === 'Eligible low value');
  const essential = records.find((item) => item.providerName === 'Essential service');
  state = updateSubscriptionRanking(state, [eligible.id, essential.id], at(5));
  state = setSubscriptionProtection(state, essential.id, SUBSCRIPTION_PROTECTION.ESSENTIAL, at(6));
  const recommendation = buildSubscriptionSavingsRecommendation(state, { monthlyTarget: 20 });
  assert.equal(recommendation.status, SUBSCRIPTION_SAVINGS_STATUS.PARTIAL);
  assert.deepEqual(recommendation.selected.map((item) => item.providerName), ['Eligible low value']);
  assert.equal(recommendation.remainingGap, 16);
  assert.ok(recommendation.excluded.some((item) => item.providerName === 'Essential service' && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.PROTECTED));
  assert.ok(recommendation.excluded.some((item) => item.providerName === 'Unranked service' && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.UNRANKED));
});

test('variable costs use minimum monthly savings for target coverage and preserve the full range', () => {
  let state = baseState();
  state = createManualSubscription(state, { providerName: 'Variable service', amountRange: { min: 5, max: 15, typical: 10 }, cadence: 'monthly' }, at(0));
  state = add(state, 'Fixed service', 5, 1);
  const records = listSubscriptionRecords(state);
  state = updateSubscriptionRanking(state, [records.find((item) => item.providerName === 'Fixed service').id, records.find((item) => item.providerName === 'Variable service').id], at(5));
  const recommendation = buildSubscriptionSavingsRecommendation(state, { monthlyTarget: 10 });
  assert.equal(recommendation.status, SUBSCRIPTION_SAVINGS_STATUS.MET);
  assert.deepEqual(recommendation.selected.map((item) => item.providerName), ['Variable service', 'Fixed service']);
  assert.deepEqual(recommendation.monthly, { min: 10, max: 20, typical: 15, exact: null, variable: true });
  assert.deepEqual(recommendation.annual, { min: 120, max: 240, typical: 180, exact: null, variable: true });
});

test('lifecycle, contract-risk and Financial Safety exclusions remain authoritative', () => {
  let state = baseState();
  for (const [index, name] of ['Lifecycle', 'Contract', 'Safety', 'Eligible'].entries()) state = add(state, name, 8, index);
  const records = listSubscriptionRecords(state);
  state = updateSubscriptionRanking(state, records.map((item) => item.id), at(8));
  const byName = Object.fromEntries(listSubscriptionRecords(state).map((item) => [item.providerName, item.id]));
  const recommendation = buildSubscriptionSavingsRecommendation(state, {
    monthlyTarget: 20,
    lifecycleById: { [byName.Lifecycle]: 'cancellation_in_progress' },
    contractRiskIds: [byName.Contract],
    financialSafetyExcludedIds: [byName.Safety]
  });
  assert.deepEqual(recommendation.selected.map((item) => item.providerName), ['Eligible']);
  assert.equal(recommendation.remainingGap, 12);
  assert.ok(recommendation.excluded.some((item) => item.id === byName.Lifecycle && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.LIFECYCLE));
  assert.ok(recommendation.excluded.some((item) => item.id === byName.Contract && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.CONTRACT_RISK));
  assert.ok(recommendation.excluded.some((item) => item.id === byName.Safety && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.FINANCIAL_SAFETY));
});

test('non-positive or absent target produces no recommendation', () => {
  let state = add(baseState(), 'Fictional service', 10, 0);
  const record = listSubscriptionRecords(state)[0]; state = updateSubscriptionRanking(state, [record.id], at(2));
  for (const monthlyTarget of [0, -1, 'not-a-number']) {
    const recommendation = buildSubscriptionSavingsRecommendation(state, { monthlyTarget });
    assert.equal(recommendation.status, SUBSCRIPTION_SAVINGS_STATUS.NO_TARGET);
    assert.deepEqual(recommendation.selected, []);
    assert.equal(recommendation.meetsTarget, false);
  }
});

test('monthly savings target persists inertly through restart and encrypted backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-subscription-savings-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  let state = (await store.loadState()).state;
  const safetyBefore = debtSafetyAssessment(state).scheduledCommitments;
  state = setSubscriptionSavingsTarget(state, 37.5, at(1));
  const envelope = state.scheduledPayments.find((item) => item.recordKind === 'subscription_savings_preferences');
  assert.equal(envelope.active, false);
  assert.equal(envelope.status, 'resolved');
  assert.equal(envelope.amount, 0);
  assert.equal(envelope.outgoing, 0);
  assert.equal(readSubscriptionSavingsTarget(state), 37.5);
  assert.equal(debtSafetyAssessment(state).scheduledCommitments, safetyBefore);
  assert.equal(listFinancialReminderSources(state, at(1)).some((item) => item.sourceId === envelope.id), false);

  state = await store.saveState(state);
  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  assert.equal(readSubscriptionSavingsTarget(state), 37.5);

  const backupPath = path.join(directory, 'fictional-savings.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  state = await restarted.saveState(setSubscriptionSavingsTarget(state, 0, at(2)));
  assert.equal(readSubscriptionSavingsTarget(state), 0);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(readSubscriptionSavingsTarget(restored.state), 37.5);
  assert.equal(debtSafetyAssessment(restored.state).scheduledCommitments, safetyBefore);
});

function add(state, providerName, amount, minutes) { return createManualSubscription(state, { providerName, amount, cadence: 'monthly' }, at(minutes)); }
function baseState() { return { transactions: [], scheduledPayments: [], accounts: [], debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [], profile: {}, settings: {}, automation: {} }; }
function at(minutes) { return new Date(Date.UTC(2026, 7, 20, 9, minutes, 0)); }
function secureStorage() { return { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value, 'utf8'), decryptString: (value) => value.toString('utf8') }; }
