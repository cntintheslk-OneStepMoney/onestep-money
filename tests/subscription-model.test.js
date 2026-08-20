import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import { debtSafetyAssessment } from '../finance-core.js';
import { listFinancialReminderSources } from '../financial-reminders.js';
import {
  SUBSCRIPTION_CLASSIFICATION,
  SUBSCRIPTION_DECISION,
  SUBSCRIPTION_SOURCE,
  activeSubscriptionRecords,
  buildSubscriptionModel,
  confirmSubscriptionCandidate,
  createManualSubscription,
  deriveSubscriptionCandidates,
  editSubscription,
  listSubscriptionRecords,
  normaliseRecurringCost,
  rejectSubscriptionCandidate,
  removeSubscription,
  setSubscriptionHidden
} from '../subscription-model.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('subscription candidates consume recurring-payment evidence without a second recurrence engine', () => {
  const state = recurringState([
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12)
  ]);

  const [candidate] = deriveSubscriptionCandidates(state);
  assert.ok(candidate);
  assert.equal(candidate.source, SUBSCRIPTION_SOURCE.RECURRING);
  assert.equal(candidate.classification, SUBSCRIPTION_CLASSIFICATION.LIKELY);
  assert.equal(candidate.providerName, 'Fictional Stream');
  assert.equal(candidate.cadence, 'monthly');
  assert.deepEqual(candidate.amountRange, { min: 12, max: 12, typical: 12 });
  assert.equal(candidate.cost.monthly.exact, 12);
  assert.equal(candidate.cost.annual.exact, 144);
});

test('four strong recurring occurrences produce a confirmed-evidence subscription candidate', () => {
  const state = recurringState([
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12),
    monthlyRow('r4', '2026-04-15', 12)
  ]);
  const [candidate] = deriveSubscriptionCandidates(state);
  assert.equal(candidate.classification, SUBSCRIPTION_CLASSIFICATION.CONFIRMED);
});

test('rejected unchanged evidence stays suppressed and materially changed evidence returns for review', () => {
  let state = recurringState([
    monthlyRow('r1', '2026-01-15', 12),
    monthlyRow('r2', '2026-02-15', 12),
    monthlyRow('r3', '2026-03-15', 12)
  ]);
  const first = deriveSubscriptionCandidates(state)[0];
  state = rejectSubscriptionCandidate(state, first.id, new Date('2026-03-16T10:00:00.000Z'));
  assert.deepEqual(deriveSubscriptionCandidates(state), []);
  const rejectedRecord = listSubscriptionRecords(state)[0];
  assert.equal(rejectedRecord.decisionState, SUBSCRIPTION_DECISION.REJECTED);

  state.transactions.push(monthlyRow('r4', '2026-04-15', 13));
  const changed = deriveSubscriptionCandidates(state)[0];
  assert.ok(changed);
  assert.equal(changed.evidenceChanged, true);
  assert.equal(changed.previousDecision, SUBSCRIPTION_DECISION.REJECTED);
  assert.notEqual(changed.sourceEvidenceFingerprint, first.sourceEvidenceFingerprint);

  state = confirmSubscriptionCandidate(state, changed.id, new Date('2026-04-16T10:00:00.000Z'));
  const records = listSubscriptionRecords(state);
  assert.equal(records.length, 2);
  const confirmed = activeSubscriptionRecords(state)[0];
  assert.equal(confirmed.decisionState, SUBSCRIPTION_DECISION.CONFIRMED);
  assert.equal(confirmed.supersedesRecordId, rejectedRecord.id);
  assert.deepEqual(deriveSubscriptionCandidates(state), []);
});

test('manual subscriptions can be added, edited, hidden, restored and removed without touching transactions', () => {
  const originalTransaction = monthlyRow('preserved', '2026-01-10', 5);
  let state = recurringState([originalTransaction]);
  state = createManualSubscription(state, {
    providerName: 'Fictional Annual Service', accountId: 'fictional-current', amount: 120, cadence: 'annual', nextPaymentDate: '2027-01-10'
  }, new Date('2026-08-20T08:00:00.000Z'));
  let record = activeSubscriptionRecords(state)[0];
  assert.equal(record.classification, SUBSCRIPTION_CLASSIFICATION.MANUAL);
  assert.equal(record.providerName, 'Fictional Annual Service');

  state = editSubscription(state, record.id, { providerName: 'Fictional Revised Service', amount: 15, cadence: 'monthly' }, new Date('2026-08-20T08:05:00.000Z'));
  record = activeSubscriptionRecords(state)[0];
  assert.equal(record.providerName, 'Fictional Revised Service');
  assert.equal(record.cadence, 'monthly');
  assert.equal(record.amountRange.typical, 15);

  state = setSubscriptionHidden(state, record.id, true, new Date('2026-08-20T08:10:00.000Z'));
  assert.equal(activeSubscriptionRecords(state).length, 0);
  state = setSubscriptionHidden(state, record.id, false, new Date('2026-08-20T08:15:00.000Z'));
  assert.equal(activeSubscriptionRecords(state).length, 1);
  state = removeSubscription(state, record.id, new Date('2026-08-20T08:20:00.000Z'));
  assert.equal(listSubscriptionRecords(state).length, 0);
  assert.deepEqual(state.transactions, [originalTransaction]);
});

test('same provider and account can produce distinct subscriptions when recurring purpose differs', () => {
  const rows = [
    monthlyRow('music-1', '2026-01-05', 8, 'Music'), monthlyRow('music-2', '2026-02-05', 8, 'Music'), monthlyRow('music-3', '2026-03-05', 8, 'Music'),
    monthlyRow('cloud-1', '2026-01-20', 5, 'Cloud storage'), monthlyRow('cloud-2', '2026-02-20', 5, 'Cloud storage'), monthlyRow('cloud-3', '2026-03-20', 5, 'Cloud storage')
  ];
  const candidates = deriveSubscriptionCandidates(recurringState(rows));
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].sourcePatternId, candidates[1].sourcePatternId);
});

test('variable recurring costs preserve a range instead of inventing an exact monthly or annual price', () => {
  const variable = normaliseRecurringCost({ min: 9, max: 11, typical: 10 }, 'monthly');
  assert.deepEqual(variable.monthly, { min: 9, max: 11, typical: 10, exact: null });
  assert.deepEqual(variable.annual, { min: 108, max: 132, typical: 120, exact: null });

  const weekly = normaliseRecurringCost(10, 'weekly');
  assert.equal(weekly.annual.exact, 520);
  assert.equal(weekly.monthly.exact, 43.33);
});

test('model ignores malformed optional subscription envelopes without making the wider state unusable', () => {
  let state = recurringState([]);
  state.scheduledPayments.push({ id: 'broken-subscription', recordKind: 'subscription', active: false, subscription: { id: 'invalid' } });
  assert.deepEqual(listSubscriptionRecords(state), []);
  state = createManualSubscription(state, { providerName: 'Fictional Safe Record', amount: 9, cadence: 'monthly' }, new Date('2026-08-20T08:00:00.000Z'));
  assert.equal(listSubscriptionRecords(state).length, 1);
  assert.equal(state.scheduledPayments.some((entry) => entry.id === 'broken-subscription'), true);
});

test('subscription storage is inert to existing scheduled-payment safety/reminder logic and survives restart plus backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-subscriptions-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  let current = (await store.loadState()).state;
  const safetyBefore = debtSafetyAssessment(current);

  current = createManualSubscription(current, {
    providerName: 'Fictional Local Subscription', accountId: 'fictional-account', amount: 19.99, cadence: 'monthly', nextPaymentDate: '2026-09-20'
  }, new Date('2026-08-20T08:00:00.000Z'));
  const record = activeSubscriptionRecords(current)[0];
  const envelope = current.scheduledPayments.find((entry) => entry.id === record.id);
  assert.equal(envelope.active, false);
  assert.equal(envelope.includedInBudget, true);
  assert.equal(envelope.amount, 0);
  assert.equal(envelope.outgoing, 0);
  assert.equal(envelope.payment, 0);
  assert.equal(Object.hasOwn(envelope, 'dueDate'), false);
  assert.equal(debtSafetyAssessment(current).scheduledCommitments, safetyBefore.scheduledCommitments);
  assert.equal(listFinancialReminderSources(current, new Date('2026-08-20T08:00:00.000Z')).some((source) => source.sourceId === record.id), false);

  current = await store.saveState(current);
  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  current = (await restarted.loadState()).state;
  assert.equal(activeSubscriptionRecords(current)[0].providerName, 'Fictional Local Subscription');

  const backupPath = path.join(directory, 'fictional-subscriptions.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', current);
  current = removeSubscription(current, activeSubscriptionRecords(current)[0].id, new Date('2026-08-20T08:30:00.000Z'));
  current = await restarted.saveState(current);
  assert.equal(activeSubscriptionRecords(current).length, 0);

  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(activeSubscriptionRecords(restored.state)[0].providerName, 'Fictional Local Subscription');
  assert.equal(debtSafetyAssessment(restored.state).scheduledCommitments, safetyBefore.scheduledCommitments);
});

test('buildSubscriptionModel separates saved active subscriptions from outstanding evidence candidates', () => {
  let state = recurringState([
    monthlyRow('r1', '2026-01-15', 12), monthlyRow('r2', '2026-02-15', 12), monthlyRow('r3', '2026-03-15', 12)
  ]);
  state = createManualSubscription(state, { providerName: 'Fictional Manual Service', amount: 30, cadence: 'quarterly' }, new Date('2026-08-20T08:00:00.000Z'));
  const model = buildSubscriptionModel(state);
  assert.equal(model.records.length, 1);
  assert.equal(model.active.length, 1);
  assert.equal(model.candidates.length, 1);
});

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

function monthlyRow(id, date, outgoing, category = 'Entertainment') {
  return {
    id,
    accountId: 'fictional-current',
    date,
    merchantName: 'Fictional Stream',
    description: `Fictional Stream ${category}`,
    category,
    incoming: 0,
    outgoing,
    duplicateStatus: 'none',
    reviewStatus: 'not_required',
    importReviewStatus: 'trusted',
    financiallyActive: true
  };
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
