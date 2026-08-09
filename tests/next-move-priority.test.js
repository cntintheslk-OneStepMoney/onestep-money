import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { debtSafetyAssessment } from '../finance-core.js';
import {
  consolidatePriorityWork, evaluateReviewItem, PRIORITY_DIAGNOSTIC_CODES,
  prioritisedReviewGroups, prioritySnapshot, selectFiveMinuteCheckIn
} from '../next-move-priority.js';
import {
  activeReviewItems, resolveReviewItem, reviewRoute, snoozeReviewItem, startReviewItem, synchroniseReviewItems
} from '../review-lifecycle.js';

const NOW = new Date('2026-08-09T09:00:00.000Z');

test('high-risk over-limit work becomes the one Next Move ahead of housekeeping', () => {
  const state = baseState();
  state.budgets.push({ id: 'food', category: 'Food', planned: 100 });
  state.transactions.push(transaction({ description: 'Fictional Coffee', outgoing: 4 }));
  state.debts.push(debt({ id: 'over-limit', currentBalance: 1200, creditLimit: 1000 }));

  const snapshot = prioritySnapshot(state, NOW);

  assert.equal(snapshot.nextMove.item.sourceId, 'over-limit');
  assert.equal(snapshot.nextMove.priorityBand, 'critical');
  assert.equal(snapshot.today.filter((entry) => entry.item.id === snapshot.nextMove.item.id).length, 1);
});

test('an essential payment action due tomorrow outranks low-risk review work', () => {
  const state = baseState();
  state.transactions.push(transaction());
  state.tasks.push({ id: 'essential-bill', title: 'Confirm essential payment', essential: true, dueAt: '2026-08-10', priority: 'normal' });

  const snapshot = prioritySnapshot(state, NOW);

  assert.equal(snapshot.nextMove.item.sourceId, 'essential-bill');
  assert.equal(snapshot.nextMove.priorityBand, 'critical');
  assert.match(snapshot.nextMove.priorityReason, /due tomorrow/i);
});

test('a date ten days away influences priority without displacing a current critical risk', () => {
  const state = baseState();
  state.tasks.push({ id: 'later', title: 'Confirm future payment', essential: true, dueAt: '2026-08-19', priority: 'normal' });
  state.overdrafts.push(debt({ id: 'current-risk', type: 'Overdraft', currentBalance: 650, limit: 500 }));

  const snapshot = prioritySnapshot(state, NOW);

  assert.equal(snapshot.nextMove.item.sourceId, 'current-risk');
  assert.match(snapshot.candidates.find((entry) => entry.item.sourceId === 'later').priorityReason, /due in 10 days/i);
});

test('snoozing the highest-priority item removes it until due and reveals the next eligible item', () => {
  const state = baseState();
  state.debts.push(debt({ id: 'risk', currentBalance: 1200, creditLimit: 1000 }));
  state.tasks.push({ id: 'second', title: 'Confirm a saved action', priority: 'high' });
  synchroniseReviewItems(state, NOW);
  const highest = prioritySnapshot(state, NOW).nextMove.item;

  snoozeReviewItem(state, highest.id, 'tomorrow', NOW);

  assert.equal(prioritySnapshot(state, new Date('2026-08-09T12:00:00.000Z')).nextMove.item.sourceId, 'second');
  assert.equal(prioritySnapshot(state, new Date('2026-08-10T10:00:00.000Z')).nextMove.item.sourceId, 'risk');
});

test('resolving Next Move removes it and recalculates the next suitable action', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'duplicate', outgoing: 600, duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false }));
  state.tasks.push({ id: 'follow-up', title: 'Complete follow-up', priority: 'normal' });
  const first = prioritySnapshot(state, NOW).nextMove;
  assert.equal(first.item.sourceId, 'duplicate');

  resolveReviewItem(state, first.item.id, 'duplicate', NOW);

  assert.equal(prioritySnapshot(state, NOW).nextMove.item.sourceId, 'follow-up');
});

test('repeated snoozing raises an important returned item with factual wording', () => {
  const state = baseState();
  state.tasks.push({ id: 'deferred', title: 'Confirm payment arrangement', financialRisk: 'important', priority: 'high' });
  synchroniseReviewItems(state, NOW);
  const item = state.reviewItems[0];

  for (let index = 0; index < 3; index += 1) {
    const snoozeAt = new Date(`2026-08-${String(9 + index).padStart(2, '0')}T09:00:00.000Z`);
    activeReviewItems(state, snoozeAt);
    snoozeReviewItem(state, item.id, 'tomorrow', snoozeAt);
  }
  const returned = prioritySnapshot(state, new Date('2026-08-12T10:00:00.000Z')).nextMove;

  assert.equal(returned.item.snoozeCount, 3);
  assert.match(returned.priorityReason, /postponed 3 times/i);
  assert.doesNotMatch(returned.priorityReason, /you(?:'ve| have) ignored|ignored this again/i);
});

test('an old low-risk uncategorised payment does not outrank a new account conflict', () => {
  const state = baseState();
  state.transactions.push(transaction());
  synchroniseReviewItems(state, new Date('2026-06-01T09:00:00.000Z'));
  state.debts.push(debt({ id: 'conflict', statusConflict: true }));

  const snapshot = prioritySnapshot(state, NOW);

  assert.equal(snapshot.nextMove.item.sourceId, 'conflict');
  assert.equal(snapshot.candidates.find((entry) => entry.item.type === 'uncategorised_payment').priorityBand, 'low');
});

test('missing information that blocks Financial Safety ranks above ordinary categorisation', () => {
  const state = baseState();
  state.transactions.push(transaction());
  state.debts.push(debt({ id: 'missing', status: 'unknown', arrangementStatus: 'unknown', contractualPayment: null, creditLimit: null }));
  const safetyAssessment = debtSafetyAssessment(state);

  const snapshot = prioritySnapshot(state, NOW, { safetyAssessment });

  assert.equal(snapshot.nextMove.item.sourceId, 'missing');
  assert.equal(snapshot.nextMove.priorityBand, 'important');
  assert.match(snapshot.nextMove.priorityReason, /blocking.*Financial Safety/i);
});

test('related categorisation work consolidates without losing source-level lifecycle items', () => {
  const state = baseState();
  state.transactions.push(
    transaction({ id: 'one', description: 'Fictional Grocer 1' }),
    transaction({ id: 'two', description: 'Fictional Grocer 2' }),
    transaction({ id: 'three', description: 'Fictional Grocer 3' })
  );
  synchroniseReviewItems(state, NOW);
  const evaluations = activeReviewItems(state, NOW).map((item) => evaluateReviewItem(item, state, NOW));

  const workflows = consolidatePriorityWork(evaluations);

  assert.equal(workflows.length, 1);
  assert.equal(workflows[0].consolidated, true);
  assert.equal(workflows[0].itemIds.length, 3);
  assert.equal(state.reviewItems.filter((item) => item.status !== 'resolved').length, 3);
});

test('possible duplicates rank by trusted-balance consequence rather than using amount alone', () => {
  const state = baseState();
  state.transactions.push(
    transaction({ id: 'small', outgoing: 8, duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false }),
    transaction({ id: 'material', outgoing: 600, duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false })
  );
  synchroniseReviewItems(state, NOW);
  const small = evaluateReviewItem(state.reviewItems.find((item) => item.sourceId === 'small'), state, NOW);
  const material = evaluateReviewItem(state.reviewItems.find((item) => item.sourceId === 'material'), state, NOW);

  assert.equal(small.priorityBand, 'normal');
  assert.equal(material.priorityBand, 'important');
  assert.match(material.priorityReason, /trusted balance/i);
});

test('balance-affecting import conflicts outrank minor document review gaps', () => {
  const state = baseState();
  state.documents.push({ id: 'minor', kind: 'payslip', parseStatus: 'needs_review' });
  state.importBatches.push({
    id: 'material', kind: 'statement', documentId: 'statement-document', reconciliationState: 'review-required',
    reconciled: false, reviewDecision: null, reviewCount: 1, conflictCount: 0, possibleDuplicateCount: 0
  });

  const snapshot = prioritySnapshot(state, NOW);

  assert.equal(snapshot.nextMove.item.sourceId, 'material');
  assert.equal(snapshot.nextMove.priorityBand, 'critical');
  assert.equal(snapshot.candidates.find((entry) => entry.item.sourceId === 'minor').priorityBand, 'normal');
});

test('unrelated work is never consolidated merely because it is outstanding', () => {
  const state = baseState();
  state.transactions.push(
    transaction({ id: 'payment', description: 'Fictional Lunch' }),
    transaction({ id: 'duplicate', description: 'Fictional Transfer', duplicateStatus: 'possible', reviewStatus: 'pending', financiallyActive: false })
  );
  state.debts.push(debt({ id: 'default', status: 'defaulted', arrangementStatus: 'unknown' }));
  synchroniseReviewItems(state, NOW);
  const evaluations = activeReviewItems(state, NOW).map((item) => evaluateReviewItem(item, state, NOW));

  assert.equal(consolidatePriorityWork(evaluations).length, 3);
});

test('Five-Minute Money Check-In selects manageable consequential and quick work', () => {
  const state = baseState();
  state.tasks.push({ id: 'important', title: 'Confirm important details', priority: 'high' });
  state.transactions.push(
    transaction({ id: 'one', description: 'Fictional Shop 1' }),
    transaction({ id: 'two', description: 'Fictional Shop 2' }),
    transaction({ id: 'three', description: 'Different Place' })
  );

  const workflows = selectFiveMinuteCheckIn(state, NOW);

  assert.ok(workflows.length <= 4);
  assert.ok(workflows.some((workflow) => workflow.evaluations.some((entry) => entry.item.sourceId === 'important')));
  assert.ok(workflows.some((workflow) => workflow.consolidated));
});

test('only low-priority background work produces Done for Today while Review Inbox stays populated', () => {
  const state = baseState();
  state.transactions.push(...Array.from({ length: 8 }, (_, index) => transaction({ id: `background-${index}`, description: `Fictional Housekeeping ${index}` })));

  const snapshot = prioritySnapshot(state, NOW);
  const inbox = prioritisedReviewGroups(state, NOW);

  assert.equal(snapshot.doneForToday, true);
  assert.equal(snapshot.nextMove, null);
  assert.equal(snapshot.lowPriorityRemaining, 8);
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].priorityBand, 'low');
});

test('no unresolved work produces no manufactured Next Move', () => {
  const snapshot = prioritySnapshot(baseState(), NOW);

  assert.equal(snapshot.nextMove, null);
  assert.equal(snapshot.doneForToday, true);
  assert.equal(snapshot.unresolvedCount, 0);
});

test('Why explanation states the financial reason without exposing an internal score', () => {
  const state = baseState();
  state.debts.push(debt({ currentBalance: 1200, creditLimit: 1000 }));

  const nextMove = prioritySnapshot(state, NOW).nextMove;

  assert.match(nextMove.priorityReason, /above its recorded limit/i);
  assert.doesNotMatch(nextMove.priorityReason, /score|weight|modifier|\d+\.\d+/i);
});

test('priority automatically recalculates after authoritative account state changes', () => {
  const state = baseState();
  state.debts.push(debt({ id: 'risk', currentBalance: 1200, creditLimit: 1000 }));
  state.tasks.push({ id: 'next', title: 'Review saved action', priority: 'normal' });
  assert.equal(prioritySnapshot(state, NOW).nextMove.item.sourceId, 'risk');

  state.debts[0].currentBalance = 900;
  synchroniseReviewItems(state, NOW);

  assert.equal(prioritySnapshot(state, NOW).nextMove.item.sourceId, 'next');
});

test('an in-progress workflow remains stable within its priority band', () => {
  const state = baseState();
  state.tasks.push(
    { id: 'first', title: 'First action', priority: 'normal' },
    { id: 'second', title: 'Second action', priority: 'normal' }
  );
  synchroniseReviewItems(state, NOW);
  const second = state.reviewItems.find((item) => item.sourceId === 'second');
  startReviewItem(state, second.id, NOW);

  const snapshot = prioritySnapshot(state, NOW, { preferredItemId: second.id });

  assert.equal(snapshot.nextMove.item.id, second.id);
  assert.equal(snapshot.nextMove.actionLabel, 'Continue');
});

test('Do it routing can take a saved action directly to its financial workflow', () => {
  const state = baseState();
  state.debts.push(debt({ id: 'target-debt' }));
  state.tasks.push({ id: 'routed', title: 'Confirm debt details', priority: 'high', actionView: 'debts', targetType: 'debt', targetId: 'target-debt' });
  synchroniseReviewItems(state, NOW);
  const item = state.reviewItems.find((entry) => entry.sourceId === 'routed');

  assert.deepEqual(reviewRoute(item, state), { view: 'debts', type: 'task', id: 'routed', targetType: 'debt', targetId: 'target-debt' });
});

test('priority evaluation never changes financial values or Financial Safety conclusions', () => {
  const state = baseState();
  state.accounts.push({ id: 'cash', type: 'current', currentBalance: 250, active: true });
  state.debts.push(debt({ currentBalance: 1200, creditLimit: 1000 }));
  const beforeFinancialState = structuredClone({ accounts: state.accounts, debts: state.debts, transactions: state.transactions, budgets: state.budgets });
  const beforeSafety = debtSafetyAssessment(state);

  prioritySnapshot(state, NOW);

  assert.deepEqual({ accounts: state.accounts, debts: state.debts, transactions: state.transactions, budgets: state.budgets }, beforeFinancialState);
  assert.deepEqual(debtSafetyAssessment(state), beforeSafety);
  assert.equal(state.reviewItems.some((item) => 'priorityBand' in item || 'internalConsequence' in item || 'priorityReason' in item), false);
});

test('priority diagnostics are privacy-safe technical codes only', async () => {
  const source = await fs.readFile(new URL('../next-move-priority.js', import.meta.url), 'utf8');

  assert.deepEqual(PRIORITY_DIAGNOSTIC_CODES, {
    EVALUATION_FAILED: 'PRIORITY_EVALUATION_FAILED',
    NEXT_MOVE_UNAVAILABLE: 'NEXT_MOVE_UNAVAILABLE',
    CONSOLIDATION_INVALID: 'ACTION_CONSOLIDATION_INVALID'
  });
  assert.doesNotMatch(source, /console\.|record\([^)]*(amount|merchant|account|description)/i);
});

function baseState() {
  return {
    schemaVersion: 8,
    meta: { createdAt: '2026-08-09T08:00:00.000Z', updatedAt: '2026-08-09T08:00:00.000Z', revision: 0 },
    profile: { name: '', locale: 'en-GB', currency: 'GBP', dependableIncome: 2000, paydayDay: null },
    accounts: [], transactions: [], payslips: [], taxDocuments: [], creditReports: [], debts: [], overdrafts: [], budgets: [],
    scheduledPayments: [], documents: [], tasks: [], checkIns: [], importBatches: [], reviewItems: [],
    settings: { selectedMonth: '2026-08', extraDebtPayment: 0, emergencyBufferTarget: 500, emergencyBufferBalance: 500, extraIncomeDebtPercent: 80, llmModel: 'qwen2.5:1.5b', reminders: { weekly: false, weeklyDay: 'monday', hour: 9 }, snoozedActions: {} }
  };
}

function transaction(overrides = {}) {
  return {
    id: 'payment', accountId: 'cash', date: '2026-08-09', budgetMonth: '2026-08', description: 'Fictional Payment',
    incoming: 0, outgoing: 10, budgetCategoryId: '', category: '', categorySource: 'manual', budgetTreatment: 'auto',
    transferStatus: 'no', duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true,
    ...overrides
  };
}

function debt(overrides = {}) {
  return {
    id: 'debt', name: 'Fictional Account', type: 'Credit card', currentBalance: 700, creditLimit: 1000,
    contractualPayment: 30, status: 'current', arrangementStatus: 'none', arrangementPayment: null,
    statusConflict: false, includeInPlan: true, ...overrides
  };
}
