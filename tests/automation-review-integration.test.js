import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { AUTOMATION_EXECUTION_STATUS, AUTOMATION_REASON } from '../automation-engine.js';
import {
  AUTOMATION_REVIEW_TYPE, automationReviewPrioritySource, automationReviewRoute,
  synchroniseAutomationReviewSignals
} from '../automation-review-integration.js';
import { prioritySnapshot } from '../next-move-priority.js';
import { applyRecurringPatternDecision, deriveRecurringPatterns } from '../recurring-finance.js';
import {
  activeReviewItems, snoozeReviewItem, synchroniseReviewItems
} from '../review-lifecycle.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function baseState() {
  return {
    schemaVersion: 10,
    meta: { createdAt: '2026-08-11T08:00:00.000Z', updatedAt: '2026-08-11T08:00:00.000Z', revision: 0 },
    automation: {
      version: 1,
      enabled: true,
      rules: [automationRule('rule_fictional_review', 'budget-household')],
      reminders: [], executions: {}, manualOverrides: {}, reviewSignals: {}
    },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 2000, paydayDay: null },
    accounts: [{ id: 'account-main', type: 'current', currentBalance: 1000, active: true }],
    transactions: [transaction()], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [],
    budgets: [{ id: 'budget-household', category: 'Household', planned: 300 }, { id: 'budget-food', category: 'Food', planned: 250 }],
    scheduledPayments: [], documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    settings: { selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 500, emergencyBufferBalance: 0, extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 }, snoozedActions: {} }
  };
}

function transaction(overrides = {}) {
  return {
    id: 'tx-fictional-review', accountId: 'account-main', date: '2026-08-11', budgetMonth: '2026-08',
    description: 'Fictional Utility', merchantName: 'Fictional Utility', incoming: 0, outgoing: 42,
    budgetCategoryId: 'budget-household', category: 'Household', categorySource: 'imported', budgetTreatment: 'auto',
    transferStatus: 'no', duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true,
    ...overrides
  };
}

function automationRule(id, budgetId) {
  return {
    id,
    name: `Fictional rule ${id}`,
    enabled: true,
    trigger: 'transaction_change',
    conditions: [{ id: 'merchant', field: 'merchant', operator: 'equals', value: 'Fictional Utility' }],
    action: { type: 'assign_budget', value: budgetId },
    explanation: 'Use a fictional local category for test data.',
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-11T08:00:00.000Z'
  };
}

function engineReviewResult(overrides = {}) {
  return {
    status: AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED,
    reasonCode: AUTOMATION_REASON.REVIEW_REQUIRED,
    ruleId: 'rule_fictional_review',
    sourceType: 'transaction',
    sourceId: 'tx-fictional-review',
    actionType: 'assign_transaction_budget',
    dueAt: null,
    ...overrides
  };
}

test('uncertain automation creates one stable Review item and repeated evaluation updates instead of duplicating', () => {
  let state = baseState();
  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult()] }, NOW).state;
  synchroniseReviewItems(state, NOW);
  const first = activeReviewItems(state, NOW).filter((item) => item.type === AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION);
  assert.equal(first.length, 1);

  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult()] }, new Date('2026-08-11T12:05:00.000Z')).state;
  synchroniseReviewItems(state, new Date('2026-08-11T12:05:00.000Z'));
  const repeated = activeReviewItems(state).filter((item) => item.type === AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION);
  assert.equal(repeated.length, 1);
  assert.equal(repeated[0].id, first[0].id);

  const route = automationReviewRoute(state, repeated[0]);
  assert.deepEqual(route, { view: 'transactions', type: 'transaction', id: 'tx-fictional-review' });
});

test('authoritative automation result resolves its Review item instead of resolving on open', () => {
  let state = baseState();
  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult()] }, NOW).state;
  synchroniseReviewItems(state, NOW);
  const reviewId = state.reviewItems.find((item) => item.type === AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION).id;

  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult({ status: AUTOMATION_EXECUTION_STATUS.APPLIED, reasonCode: AUTOMATION_REASON.APPLIED })] }, new Date('2026-08-11T12:10:00.000Z')).state;
  synchroniseReviewItems(state, new Date('2026-08-11T12:10:00.000Z'));
  assert.equal(state.reviewItems.find((item) => item.id === reviewId).status, 'resolved');
  assert.equal(activeReviewItems(state).some((item) => item.id === reviewId), false);
});

test('snoozed automation review survives cloning and returns when due', () => {
  let state = baseState();
  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult()] }, NOW).state;
  synchroniseReviewItems(state, NOW);
  const item = activeReviewItems(state, NOW).find((entry) => entry.type === AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION);
  snoozeReviewItem(state, item.id, 'tomorrow', NOW);

  state = structuredClone(state);
  assert.equal(activeReviewItems(state, new Date('2026-08-11T20:00:00.000Z')).some((entry) => entry.id === item.id), false);
  assert.equal(activeReviewItems(state, new Date('2026-08-12T13:00:00.000Z')).some((entry) => entry.id === item.id), true);
  assert.equal(state.reviewItems.find((entry) => entry.id === item.id).status, 'needs_attention');
});

test('rule conflicts route to the existing rule workflow and disabling one source rule resolves the conflict item', () => {
  let state = baseState();
  state.automation.rules.push(automationRule('rule_fictional_conflict', 'budget-food'));
  const conflict = {
    source: { type: 'transaction', id: 'tx-fictional-review' },
    actionType: 'assign_transaction_budget',
    ruleIds: ['rule_fictional_review', 'rule_fictional_conflict']
  };
  state = synchroniseAutomationReviewSignals(state, { conflicts: [conflict] }, NOW).state;
  synchroniseReviewItems(state, NOW);
  const item = activeReviewItems(state, NOW).find((entry) => entry.type === AUTOMATION_REVIEW_TYPE.RULE_CONFLICT);
  assert.ok(item);
  assert.deepEqual(automationReviewRoute(state, item), { view: 'settings', type: 'automation_rules', id: 'rule_fictional_conflict' });

  state.automation.rules.find((rule) => rule.id === 'rule_fictional_conflict').enabled = false;
  synchroniseReviewItems(state, new Date('2026-08-11T12:05:00.000Z'));
  assert.equal(activeReviewItems(state).some((entry) => entry.id === item.id), false);
  assert.equal(state.reviewItems.find((entry) => entry.id === item.id).status, 'resolved');
});

test('global automation pause preserves unresolved Review work', () => {
  let state = baseState();
  state = synchroniseAutomationReviewSignals(state, { results: [engineReviewResult()] }, NOW).state;
  synchroniseReviewItems(state, NOW);
  const item = activeReviewItems(state, NOW).find((entry) => entry.type === AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION);
  state.automation.enabled = false;
  synchroniseReviewItems(state, new Date('2026-08-11T12:05:00.000Z'));
  assert.equal(activeReviewItems(state).some((entry) => entry.id === item.id), true);
});

test('incoming recurring confirmation remains an Automation Review path and source confirmation resolves it', () => {
  let state = baseState();
  state.transactions = [
    transaction({ id: 'recurring-1', date: '2026-06-10', incoming: 42, outgoing: 0, budgetCategoryId: '', category: 'Income' }),
    transaction({ id: 'recurring-2', date: '2026-07-10', incoming: 42, outgoing: 0, budgetCategoryId: '', category: 'Income' })
  ];
  const pattern = deriveRecurringPatterns(state)[0];
  assert.ok(pattern);
  assert.equal(pattern.direction, 'incoming');
  synchroniseReviewItems(state, NOW);
  const item = activeReviewItems(state, NOW).find((entry) => entry.type === AUTOMATION_REVIEW_TYPE.RECURRING_CONFIRMATION);
  assert.ok(item);
  assert.deepEqual(automationReviewRoute(state, item), { view: 'transactions', type: 'recurring_pattern', id: pattern.id });

  state = applyRecurringPatternDecision(state, pattern.id, 'confirmed', NOW);
  synchroniseReviewItems(state, new Date('2026-08-11T12:05:00.000Z'));
  assert.equal(activeReviewItems(state).some((entry) => entry.id === item.id), false);
});

test('Next Move uses automation Financial Safety and due-date context without a second priority score', () => {
  let state = baseState();
  state.tasks.push({ id: 'routine', title: 'Fictional routine task', priority: 'normal' });
  state = synchroniseAutomationReviewSignals(state, {
    results: [engineReviewResult({
      status: AUTOMATION_EXECUTION_STATUS.BLOCKED,
      reasonCode: AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED,
      dueAt: '2026-08-12T09:00:00.000Z'
    })]
  }, NOW).state;

  const snapshot = prioritySnapshot(state, NOW);
  assert.equal(snapshot.nextMove.item.type, AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION);
  assert.equal(snapshot.nextMove.priorityBand, 'critical');
  assert.equal(snapshot.nextMove.dueDays, 1);
  assert.match(snapshot.nextMove.priorityReason, /due tomorrow/i);
  assert.match(snapshot.nextMove.priorityReason, /Financial Safety/i);
  const source = automationReviewPrioritySource(state, snapshot.nextMove.item);
  assert.equal(source.blockingSafetyCalculation, true);
});

test('packaged app includes the automation Review integration module', async () => {
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.build.files.includes('automation-review-integration.js'));
});

test('automation Review integration stays local and does not add sensitive diagnostics or networking', async () => {
  const source = await fs.readFile(new URL('../automation-review-integration.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dns)['"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /telemetry|analytics/i);
  assert.doesNotMatch(source, /diagnostic(?:s|Logger)?\s*\.?\s*record/i);
  assert.match(source, /data-automation-edit/);
  assert.match(source, /data-recurring-pattern-id/);
});
