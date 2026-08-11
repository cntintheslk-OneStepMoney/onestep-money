import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import {
  buildPaydayContext, deriveIncomeSchedules, ensurePaydayConfiguration, missingIncomeReviewSources,
  PAYDAY_RULE, PAYDAY_TIMING, scheduleOccurrenceForMonth, upsertIncomeSchedule, WEEKEND_ADJUSTMENT
} from '../payday-awareness.js';
import {
  applyRecurringPatternDecision, deriveRecurringPatterns, RECURRING_DECISION
} from '../recurring-finance.js';
import {
  activeReviewItems, reviewItemPresentation, snoozeReviewItem, synchroniseReviewItems
} from '../review-lifecycle.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');
const seedPath = new URL('../seed-data.json', import.meta.url);

function baseState(overrides = {}) {
  return {
    schemaVersion: 10,
    meta: { createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), revision: 4 },
    automation: { version: 1, enabled: true, executions: [], manualOverrides: [] },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: null, incomeSchedules: [] },
    settings: {
      selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 200, emergencyBufferBalance: 50,
      extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 },
      snoozedActions: {}, appearance: { theme: 'system' }, dashboard: {}
    },
    accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: 1000, statementDate: '2026-08-10', active: true }],
    transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [], budgets: [], scheduledPayments: [],
    documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    ...overrides
  };
}

function withSchedule(state, input, now = NOW) {
  return upsertIncomeSchedule(state, {
    name: 'Fictional Employer', matchText: 'Fictional Employer', cadence: 'monthly',
    rule: { type: PAYDAY_RULE.FIXED_DAY, day: 28, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE },
    timingRelationship: PAYDAY_TIMING.CURRENT, expectedAmountRange: { min: 1900, max: 2100 }, active: true,
    effectiveFrom: '2026-08-01', ...input
  }, now);
}

function incoming(id, date, amount, description = 'Fictional Employer') {
  return {
    id, accountId: 'current', date, budgetMonth: date.slice(0, 7), description, category: 'Income', incoming: amount, outgoing: 0,
    transferStatus: 'no', budgetTreatment: 'income', duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true
  };
}

function outgoingRecurring(id, date, amount, description = 'Fictional Utility') {
  return {
    id, accountId: 'current', date, budgetMonth: date.slice(0, 7), description, category: 'Household', incoming: 0, outgoing: amount,
    transferStatus: 'no', budgetTreatment: 'auto', duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true
  };
}

function confirmDetectedPattern(state, direction, now = NOW) {
  const pattern = deriveRecurringPatterns(state).find((item) => item.direction === direction);
  assert.ok(pattern, `Expected a detected ${direction} recurring pattern`);
  return applyRecurringPatternDecision(state, pattern.id, RECURRING_DECISION.CONFIRMED, now);
}

test('monthly payday rules handle fixed weekends, last working day, last selected weekday and short months', () => {
  const fixed = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.FIXED_DAY, day: 30, weekendAdjustment: WEEKEND_ADJUSTMENT.PREVIOUS } }).profile.incomeSchedules[0];
  const working = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.LAST_WORKING_DAY } }).profile.incomeSchedules[0];
  const friday = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.LAST_WEEKDAY, weekday: 5 } }).profile.incomeSchedules[0];

  assert.equal(scheduleOccurrenceForMonth(fixed, 2026, 8).date, '2026-08-28');
  assert.equal(scheduleOccurrenceForMonth(working, 2027, 2).date, '2027-02-26');
  assert.equal(scheduleOccurrenceForMonth(friday, 2026, 2).date, '2026-02-27');
  assert.equal(scheduleOccurrenceForMonth(friday, 2026, 3).date, '2026-03-27');
  assert.equal(scheduleOccurrenceForMonth(friday, 2026, 10).date, '2026-10-30');
});

test('multiple independent streams include four-weekly income and expose one shared consumer schedule', () => {
  let state = withSchedule(baseState(), { id: 'main-monthly', name: 'Fictional Main Employer', matchText: 'Main Employer', rule: { type: PAYDAY_RULE.FIXED_DAY, day: 10, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE } }, new Date('2026-08-01T12:00:00Z'));
  state.transactions = [
    incoming('side-1', '2026-01-02', 340, 'Fictional Side Work'),
    incoming('side-2', '2026-01-30', 350, 'Fictional Side Work'),
    incoming('side-3', '2026-02-27', 360, 'Fictional Side Work'),
    incoming('side-4', '2026-03-27', 355, 'Fictional Side Work')
  ];
  state = confirmDetectedPattern(state, 'incoming', new Date('2026-08-01T12:00:00Z'));
  const context = buildPaydayContext(state, { now: new Date('2026-08-01T12:00:00Z') });

  assert.equal(context.streams.length, 2);
  assert.equal(context.streams.some((item) => item.cadence === 'four-weekly'), true);
  assert.equal(context.nextPayday.date, '2026-08-10');
  assert.equal(context.consumerSchedule.length, 2);
  assert.equal(context.consumerSchedule.some((item) => item.cadence === 'four-weekly' && item.nextExpected.date === '2026-08-14'), true);
});

test('matching payslip and bank credit are one received income event, never two incomes', () => {
  let state = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.FIXED_DAY, day: 10, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE } });
  state.transactions = [incoming('salary-bank', '2026-08-10', 2000)];
  state.payslips = [{ id: 'salary-slip', employer: 'Fictional Employer', provider: 'manual', period: '2026-08', payDate: '2026-08-10', netPay: 2000 }];
  const context = buildPaydayContext(state, { now: NOW });
  const stream = context.streams[0];

  assert.equal(stream.status, 'received');
  assert.equal(stream.received.amount, 2000);
  assert.deepEqual(stream.received.sourceTypes.sort(), ['payslip', 'transaction']);
});

test('future expected income is never added to Safe Until Payday', () => {
  const state = withSchedule(baseState(), { expectedAmountRange: { min: 5000, max: 5000 } });
  const context = buildPaydayContext(state, { now: NOW });

  assert.equal(context.nextPayday.date, '2026-08-28');
  assert.equal(context.safeUntilPayday.status, 'available');
  assert.equal(context.safeUntilPayday.amount, 850);
  assert.equal(context.safeUntilPayday.reasonCodes.includes('expected_income_not_counted_before_receipt'), true);
});

test('dated bills, required debt payments and protected buffer reduce Safe Until Payday', () => {
  const state = withSchedule(baseState({
    scheduledPayments: [{ id: 'bill', name: 'Fictional Essential Bill', amount: 100, dueDate: '2026-08-20', status: 'due', includedInBudget: false }],
    debts: [{ id: 'loan', name: 'Fictional Loan', type: 'Personal loan', currentBalance: 500, balanceEffectiveDate: '2026-08-10', apr: 0.1, contractualPayment: 50, paymentDueDate: '2026-08-22', status: 'current', arrangementStatus: 'none', arrangementPayment: null, statusConflict: false, includeInPlan: true }]
  }), {});
  const context = buildPaydayContext(state, { now: NOW });

  assert.equal(context.safeUntilPayday.status, 'available');
  assert.equal(context.safeUntilPayday.protected.scheduled, 100);
  assert.equal(context.safeUntilPayday.protected.debt, 50);
  assert.equal(context.safeUntilPayday.protected.buffer, 150);
  assert.equal(context.safeUntilPayday.amount, 700);
});

test('confirmed recurring commitments before payday are protected without being treated as discretionary Budget cash', () => {
  let state = withSchedule(baseState(), {});
  state.transactions = [
    outgoingRecurring('utility-1', '2026-05-15', 80),
    outgoingRecurring('utility-2', '2026-06-15', 82),
    outgoingRecurring('utility-3', '2026-07-15', 81)
  ];
  state = confirmDetectedPattern(state, 'outgoing');
  const context = buildPaydayContext(state, { now: NOW });

  assert.equal(context.safeUntilPayday.status, 'available');
  assert.equal(context.safeUntilPayday.protected.recurring, 82);
  assert.equal(context.safeUntilPayday.amount, 768);
});

test('unknown trusted liquid position makes Safe Until Payday unavailable instead of guessed', () => {
  const state = withSchedule(baseState({ accounts: [{ id: 'current', name: 'Fictional Current', type: 'current', currentBalance: null, statementDate: '2026-08-10', active: true }] }), {});
  const context = buildPaydayContext(state, { now: NOW });

  assert.equal(context.safeUntilPayday.status, 'unavailable');
  assert.equal(context.safeUntilPayday.amount, null);
  assert.equal(context.safeUntilPayday.reasonCodes.includes('trusted_liquid_position_unavailable'), true);
});

test('missing income appears only after the configured window and enters Review', () => {
  const state = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.FIXED_DAY, day: 5, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE }, effectiveFrom: '2026-08-01' }, new Date('2026-08-01T12:00:00Z'));
  const duringWindow = missingIncomeReviewSources(state, new Date('2026-08-06T12:00:00Z'));
  const afterWindow = missingIncomeReviewSources(state, new Date('2026-08-07T12:00:00Z'));

  assert.equal(duringWindow.length, 0);
  assert.equal(afterWindow.length, 1);
  synchroniseReviewItems(state, new Date('2026-08-07T12:00:00Z'));
  const item = activeReviewItems(state, new Date('2026-08-07T12:00:00Z')).find((entry) => entry.type === 'missing_income');
  assert.ok(item);
  assert.equal(item.priority, 'high');
  assert.match(reviewItemPresentation(item, state, new Date('2026-08-07T12:00:00Z')).action, /Review payday/);
});

test('received trusted income automatically clears a previously generated missing-income review item', () => {
  const state = withSchedule(baseState(), { rule: { type: PAYDAY_RULE.FIXED_DAY, day: 5, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE }, effectiveFrom: '2026-08-01' }, new Date('2026-08-01T12:00:00Z'));
  synchroniseReviewItems(state, new Date('2026-08-07T12:00:00Z'));
  assert.equal(activeReviewItems(state, new Date('2026-08-07T12:00:00Z')).some((item) => item.type === 'missing_income'), true);

  state.transactions.push(incoming('late-evidence', '2026-08-06', 2000));
  synchroniseReviewItems(state, new Date('2026-08-07T12:00:00Z'));
  assert.equal(activeReviewItems(state, new Date('2026-08-07T12:00:00Z')).some((item) => item.type === 'missing_income'), false);
});

test('legacy confirmed payday migrates conservatively and keeps fixed-date meaning', () => {
  const state = baseState({ profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 2100, paydayDay: 30 } });
  ensurePaydayConfiguration(state, NOW);
  const schedule = state.profile.incomeSchedules[0];

  assert.equal(schedule.confirmation, 'user');
  assert.equal(schedule.rule.type, PAYDAY_RULE.FIXED_DAY);
  assert.equal(schedule.rule.day, 30);
  assert.equal(schedule.rule.weekendAdjustment, WEEKEND_ADJUSTMENT.NONE);
  assert.equal(scheduleOccurrenceForMonth(schedule, 2026, 8).date, '2026-08-30');
  assert.equal(scheduleOccurrenceForMonth(schedule, 2027, 2).date, '2027-02-28');
});

test('unknown legacy payday remains unknown and is not mapped to an invented income source', () => {
  const state = baseState({ profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 2100, paydayDay: null } });
  ensurePaydayConfiguration(state, NOW);
  assert.deepEqual(state.profile.incomeSchedules, []);
});

test('pay-in-arrears context is represented without rewriting historical income', () => {
  const original = incoming('salary', '2026-08-10', 1999.5);
  let state = baseState({ transactions: [original] });
  state = withSchedule(state, { timingRelationship: PAYDAY_TIMING.ARREARS, rule: { type: PAYDAY_RULE.FIXED_DAY, day: 10, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE } });

  assert.equal(deriveIncomeSchedules(state)[0].timingRelationship, PAYDAY_TIMING.ARREARS);
  assert.equal(state.transactions[0].incoming, 1999.5);
  assert.equal(state.transactions[0].date, '2026-08-10');
});

test('snooze until payday uses the next actual per-stream payday instead of the legacy global day', () => {
  let state = baseState({
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 0, paydayDay: 28, incomeSchedules: [] },
    tasks: [{ id: 'fictional-task', title: 'Fictional action', priority: 'normal', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(), actionView: 'settings' }]
  });
  state = withSchedule(state, { id: 'later', name: 'Later income', matchText: 'Later', rule: { type: PAYDAY_RULE.FIXED_DAY, day: 20, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE } });
  state = withSchedule(state, { id: 'sooner', name: 'Sooner income', matchText: 'Sooner', rule: { type: PAYDAY_RULE.FIXED_DAY, day: 15, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE } });
  const task = activeReviewItems(state, NOW).find((item) => item.type === 'generated_action');
  snoozeReviewItem(state, task.id, 'payday', NOW);
  const snoozed = state.reviewItems.find((item) => item.id === task.id);

  assert.equal(snoozed.snoozedUntil.slice(0, 10), '2026-08-15');
});

test('income schedules survive restart and encrypted portable backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-payday-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage(), clock: () => new Date(NOW) });
  await store.initialise();
  let current = (await store.loadState()).state;
  current = withSchedule(current, { id: 'persisted-payday', rule: { type: PAYDAY_RULE.LAST_WEEKDAY, weekday: 5 }, timingRelationship: PAYDAY_TIMING.ARREARS });
  current = await store.saveState(current);

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage(), clock: () => new Date(NOW) });
  await restarted.initialise();
  current = (await restarted.loadState()).state;
  assert.equal(deriveIncomeSchedules(current).find((item) => item.id === 'persisted-payday').rule.type, PAYDAY_RULE.LAST_WEEKDAY);

  const backupPath = path.join(directory, 'fictional-payday.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', current);
  current.profile.incomeSchedules = [];
  await restarted.saveState(current);
  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  const restoredSchedule = deriveIncomeSchedules(restored.state).find((item) => item.id === 'persisted-payday');
  assert.equal(restored.status, 'restored');
  assert.equal(restoredSchedule.rule.weekday, 5);
  assert.equal(restoredSchedule.timingRelationship, PAYDAY_TIMING.ARREARS);
});

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
