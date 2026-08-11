import assert from 'node:assert/strict';
import test from 'node:test';
import { activeReviewItems, snoozeReviewItem, synchroniseReviewItems } from '../review-lifecycle.js';

function stateWithReminder() {
  return {
    automation: { enabled: true, reminders: [] },
    profile: { paydayDay: null }, settings: {}, accounts: [], transactions: [], payslips: [], debts: [], overdrafts: [], budgets: [], documents: [], importBatches: [],
    scheduledPayments: [{ id: 'fictional-due', title: 'Fictional council tax', dueDate: '2026-08-12', status: 'scheduled' }],
    tasks: [], reviewItems: []
  };
}

test('financial reminder uses one existing Review/Today lifecycle item and snooze returns locally', () => {
  const state = stateWithReminder();
  const morning = new Date('2026-08-11T08:00:00+01:00');
  synchroniseReviewItems(state, morning);
  const task = state.tasks.find((item) => item.source === 'financial_reminder');
  assert.ok(task);
  const reviewItems = state.reviewItems.filter((item) => item.type === 'generated_action' && item.sourceId === task.id && item.status !== 'resolved');
  assert.equal(reviewItems.length, 1);

  synchroniseReviewItems(state, new Date('2026-08-11T12:00:00+01:00'));
  assert.equal(state.reviewItems.filter((item) => item.type === 'generated_action' && item.sourceId === task.id && item.status !== 'resolved').length, 1);

  snoozeReviewItem(state, reviewItems[0].id, 'tomorrow', new Date('2026-08-11T12:00:00+01:00'));
  assert.equal(activeReviewItems(state, new Date('2026-08-12T08:30:00+01:00')).some((item) => item.id === reviewItems[0].id), false);
  assert.equal(activeReviewItems(state, new Date('2026-08-12T10:00:00+01:00')).some((item) => item.id === reviewItems[0].id), true);
});

test('resolving the financial source resolves the existing lifecycle item instead of creating another', () => {
  const state = stateWithReminder();
  const now = new Date('2026-08-11T12:00:00+01:00');
  synchroniseReviewItems(state, now);
  const original = state.reviewItems.find((item) => item.type === 'generated_action');
  state.scheduledPayments[0].status = 'paid';
  synchroniseReviewItems(state, new Date('2026-08-11T13:00:00+01:00'));
  const same = state.reviewItems.find((item) => item.id === original.id);
  assert.equal(same.status, 'resolved');
  assert.equal(same.resolution.decision, 'source_resolved');
  assert.equal(state.reviewItems.filter((item) => item.sourceId === original.sourceId).length, 1);
});
