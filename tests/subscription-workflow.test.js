import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildCashFlowForecast, CASH_FLOW_HORIZON, forecastHorizon } from '../cash-flow-forecast.js';
import { FinanceDataStore } from '../data-store.js';
import { debtSafetyAssessment } from '../finance-core.js';
import { prioritySnapshot } from '../next-move-priority.js';
import {
  confirmSubscriptionCandidate,
  createManualSubscription,
  deriveSubscriptionCandidates,
  listSubscriptionRecords,
  updateSubscriptionRanking
} from '../subscription-model.js';
import { buildSubscriptionSavingsRecommendation, SUBSCRIPTION_SAVINGS_EXCLUSION } from '../subscription-savings.js';
import {
  SUBSCRIPTION_LIFECYCLE,
  SUBSCRIPTION_REVIEW_TYPE,
  exportSubscriptionsCsv,
  readSubscriptionWorkflow,
  setSubscriptionContractReview,
  setSubscriptionLifecycle,
  subscriptionOccurrenceStillCommitted,
  subscriptionRecommendationOptions,
  subscriptionReviewSources
} from '../subscription-workflow.js';
import { activeReviewItems, reviewRoute, synchroniseReviewItems } from '../review-lifecycle.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

function baseState() {
  return {
    transactions: [], scheduledPayments: [], accounts: [], debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [],
    payslips: [], creditReports: [], documents: [], importBatches: [], checkIns: [], profile: {}, settings: {}, automation: {}
  };
}
function at(day = 20, hour = 9) { return new Date(Date.UTC(2026, 7, day, hour, 0, 0)); }
function addManual(state, name = 'Fictional Stream', amount = 12) {
  return createManualSubscription(state, { providerName: name, amount, cadence: 'monthly', notes: 'Fictional fixture only' }, at());
}
function recurringTransactions(endMonth = 7) {
  const rows = [];
  for (let month = 4; month <= endMonth; month += 1) {
    rows.push({
      id: `fictional-stream-${month}`,
      accountId: 'account-fictional',
      date: `2026-${String(month).padStart(2, '0')}-15`,
      incoming: 0,
      outgoing: 12,
      merchantName: 'Fictional Stream',
      category: 'Subscriptions & software',
      transferStatus: 'no',
      financiallyActive: true
    });
  }
  return rows;
}

function forecastProfile() {
  const fact = (value) => ({ value, status: 'known' });
  return {
    currency: 'GBP',
    liquidPosition: { total: fact(1000), complete: true },
    buffer: { target: fact(100), balance: fact(100), shortfall: 0 },
    commitments: { items: [] },
    budget: { planned: 0, remaining: 0, categories: [] },
    uncertainty: { blocking: [], safeForAutomation: true }
  };
}

test('subscription lifecycle transitions are explicit and future completed cancellation is rejected', () => {
  let state = addManual(baseState());
  const id = listSubscriptionRecords(state)[0].id;
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.ACTIVE);

  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, {}, at());
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED);
  assert.equal(readSubscriptionWorkflow(state, id).cancellationEffectiveDate, null);

  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS, {}, at());
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS);
  assert.throws(() => setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLED, { effectiveDate: '2026-08-25' }, at()), /future end date/i);

  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING, { contractEndDate: '2026-09-01' }, at());
  assert.equal(readSubscriptionWorkflow(state, id).contractEndDate, '2026-09-01');

  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLED, { effectiveDate: '2026-08-19' }, at());
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLED);
  assert.equal(readSubscriptionWorkflow(state, id).cancellationEffectiveDate, '2026-08-19');
});

test('planned and in-progress cancellation remain commitments and do not mutate recurring financial evidence', () => {
  let state = baseState();
  state.transactions = recurringTransactions(7);
  const candidate = deriveSubscriptionCandidates(state)[0];
  state = confirmSubscriptionCandidate(state, candidate.id, at());
  const record = listSubscriptionRecords(state)[0];
  const beforeTransactions = structuredClone(state.transactions);

  state = setSubscriptionLifecycle(state, record.id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, {}, at());
  assert.equal(subscriptionOccurrenceStillCommitted(state, record.sourcePatternId, '2026-08-15'), true);
  assert.deepEqual(state.transactions, beforeTransactions);
  state = setSubscriptionLifecycle(state, record.id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS, {}, at());
  assert.equal(subscriptionOccurrenceStillCommitted(state, record.sourcePatternId, '2026-08-15'), true);
  assert.deepEqual(state.transactions, beforeTransactions);

  const recurringPattern = {
    id: record.sourcePatternId,
    direction: 'outgoing', confidence: 'confirmed', cadence: 'monthly', label: 'Fictional Stream',
    amountRange: { min: 12, max: 12, typical: 12 }, nextExpected: { date: '2026-08-25' }
  };
  const forecast = buildCashFlowForecast(state, {
    today: '2026-08-20', now: at(), profile: forecastProfile(), paydayContext: { schedules: [], streams: [], nextPayday: null },
    recurringPatterns: [recurringPattern]
  });
  const thirty = forecastHorizon(forecast, CASH_FLOW_HORIZON.THIRTY_DAYS);
  assert.equal(forecast.events.some((event) => event.sourceRef === record.sourcePatternId), true);
  assert.equal(thirty.safeProjectedBalance, 988);
});

test('effective cancellation records a boundary while later recurring evidence creates review instead of silently reopening lifecycle', () => {
  let state = baseState();
  state.transactions = recurringTransactions(7);
  const candidate = deriveSubscriptionCandidates(state)[0];
  state = confirmSubscriptionCandidate(state, candidate.id, at());
  const record = listSubscriptionRecords(state)[0];
  state = setSubscriptionLifecycle(state, record.id, SUBSCRIPTION_LIFECYCLE.CANCELLED, { effectiveDate: '2026-07-20' }, at());
  assert.equal(subscriptionOccurrenceStillCommitted(state, record.sourcePatternId, '2026-08-15'), false);

  state.transactions.push(...recurringTransactions(8).filter((row) => row.date === '2026-08-15'));
  const sources = subscriptionReviewSources(state, at());
  assert.ok(sources.some((source) => source.type === SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_CONFLICT && source.sourceId === record.id));
  assert.equal(readSubscriptionWorkflow(state, record.id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLED);
});

test('subscription review sources use the existing Review Inbox and remain duplicate-safe', () => {
  const state = baseState();
  state.transactions = recurringTransactions(6);
  synchroniseReviewItems(state, at());
  const first = activeReviewItems(state, at()).filter((item) => item.type === SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION);
  assert.equal(first.length, 1);
  const id = first[0].id;
  synchroniseReviewItems(state, at());
  const second = activeReviewItems(state, at()).filter((item) => item.type === SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION);
  assert.deepEqual(second.map((item) => item.id), [id]);
  assert.deepEqual(reviewRoute(second[0], state), { view: 'subscriptions', type: 'subscription_candidate', id: second[0].sourceId });
  const snapshot = prioritySnapshot(state, at());
  assert.ok(snapshot.candidates.some((entry) => entry.item.id === id));
});

test('resolving the underlying candidate automatically resolves its subscription Review item', () => {
  let state = baseState();
  state.transactions = recurringTransactions(6);
  synchroniseReviewItems(state, at());
  const review = activeReviewItems(state, at()).find((item) => item.type === SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION);
  assert.ok(review);
  const candidate = deriveSubscriptionCandidates(state)[0];
  state = confirmSubscriptionCandidate(state, candidate.id, at());
  synchroniseReviewItems(state, at());
  const stored = state.reviewItems.find((item) => item.id === review.id);
  assert.equal(stored.status, 'resolved');
  assert.equal(stored.resolution.decision, 'source_resolved');
});

test('missing cancellation information and contract uncertainty feed Review Inbox without a second task queue', () => {
  let state = addManual(baseState(), 'Fictional Contract');
  const id = listSubscriptionRecords(state)[0].id;
  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS, {}, at());
  state = setSubscriptionContractReview(state, id, true, at());
  synchroniseReviewItems(state, at());
  const activeTypes = new Set(activeReviewItems(state, at()).map((item) => item.type));
  assert.ok(activeTypes.has(SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_INFORMATION));
  assert.ok(activeTypes.has(SUBSCRIPTION_REVIEW_TYPE.CONTRACT_REVIEW));
  assert.equal(Array.isArray(state.subscriptionTasks), false);
  assert.equal(Array.isArray(state.subscriptionReviewItems), false);
});

test('lifecycle and contract review exclusions feed the existing savings engine automatically', () => {
  let state = addManual(baseState(), 'Lifecycle blocked', 8);
  state = addManual(state, 'Contract blocked', 9);
  state = addManual(state, 'Eligible', 10);
  const records = listSubscriptionRecords(state);
  state = updateSubscriptionRanking(state, records.map((record) => record.id), at());
  const byName = Object.fromEntries(listSubscriptionRecords(state).map((record) => [record.providerName, record.id]));
  state = setSubscriptionLifecycle(state, byName['Lifecycle blocked'], SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, {}, at());
  state = setSubscriptionContractReview(state, byName['Contract blocked'], true, at());
  const recommendation = buildSubscriptionSavingsRecommendation(state, { monthlyTarget: 30, ...subscriptionRecommendationOptions(state) });
  assert.deepEqual(recommendation.selected.map((item) => item.providerName), ['Eligible']);
  assert.ok(recommendation.excluded.some((item) => item.id === byName['Lifecycle blocked'] && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.LIFECYCLE));
  assert.ok(recommendation.excluded.some((item) => item.id === byName['Contract blocked'] && item.reason === SUBSCRIPTION_SAVINGS_EXCLUSION.CONTRACT_RISK));
});

test('workflow persistence is inert to Financial Safety and survives restart plus encrypted backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-subscription-workflow-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();
  let state = (await store.loadState()).state;
  state = addManual(state, 'Fictional Backup Service', 7);
  const id = listSubscriptionRecords(state)[0].id;
  const commitmentsBefore = debtSafetyAssessment(state).scheduledCommitments;
  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS, {}, at());
  state = setSubscriptionContractReview(state, id, true, at());
  const envelope = state.scheduledPayments.find((row) => row.recordKind === 'subscription_workflow');
  assert.equal(envelope.active, false);
  assert.equal(envelope.status, 'resolved');
  assert.equal(envelope.amount, 0);
  assert.equal(debtSafetyAssessment(state).scheduledCommitments, commitmentsBefore);

  state = await store.saveState(state);
  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  state = (await restarted.loadState()).state;
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS);
  assert.equal(readSubscriptionWorkflow(state, id).contractReviewRequired, true);

  const backupPath = path.join(directory, 'fictional-workflow.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', state);
  state = await restarted.saveState(setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.ACTIVE, {}, at()));
  assert.equal(readSubscriptionWorkflow(state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.ACTIVE);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(readSubscriptionWorkflow(restored.state, id).lifecycleStatus, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS);
  assert.equal(readSubscriptionWorkflow(restored.state, id).contractReviewRequired, true);
  assert.equal(debtSafetyAssessment(restored.state).scheduledCommitments, commitmentsBefore);
});

test('subscription export includes workflow data and neutralises spreadsheet formulas', () => {
  let state = createManualSubscription(baseState(), { providerName: '=Fictional Formula', amount: 5, cadence: 'monthly', notes: '@fictional-note' }, at());
  const id = listSubscriptionRecords(state)[0].id;
  state = setSubscriptionLifecycle(state, id, SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING, { contractEndDate: '2026-09-30', contractReviewRequired: true }, at());
  const csv = exportSubscriptionsCsv(state);
  assert.match(csv, /"Lifecycle"/);
  assert.match(csv, /"contract_ending"/);
  assert.match(csv, /"2026-09-30"/);
  assert.match(csv, /"'=Fictional Formula"/);
  assert.match(csv, /"'@fictional-note"/);
});

test('malformed optional workflow metadata fails conservatively without breaking subscription state', () => {
  let state = addManual(baseState());
  const id = listSubscriptionRecords(state)[0].id;
  state.scheduledPayments.push({
    id: 'malformed-workflow', recordKind: 'subscription_workflow', active: false, status: 'resolved', amount: 0,
    subscriptionWorkflow: { subscriptionId: id, lifecycleStatus: 'cancelled', cancellationEffectiveDate: 'not-a-date' }
  });
  const workflow = readSubscriptionWorkflow(state, id);
  assert.equal(workflow.lifecycleStatus, SUBSCRIPTION_LIFECYCLE.REVIEW);
  assert.equal(workflow.contractReviewRequired, true);
  assert.equal(listSubscriptionRecords(state).length, 1);
});

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
