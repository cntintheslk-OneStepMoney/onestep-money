import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  createUserFinancialReminder, dismissFinancialReminderForToday, listFinancialReminderSources,
  reminderTaskId, setFinancialReminderConfiguration, synchroniseFinancialReminders
} from '../financial-reminders.js';

function baseState() { return { automation: { enabled: true, reminders: [] }, tasks: [], scheduledPayments: [], reviewItems: [], transactions: [], budgets: [] }; }

test('upcoming, due-today and overdue states use local calendar dates', () => {
  const state = baseState(); state.scheduledPayments.push({ id: 'rent', title: 'Fictional rent', dueDate: '2026-10-25', status: 'scheduled' });
  assert.equal(listFinancialReminderSources(state, new Date('2026-10-24T12:00:00+01:00'))[0].status, 'upcoming');
  assert.equal(listFinancialReminderSources(state, new Date('2026-10-25T00:30:00+01:00'))[0].status, 'due_today');
  assert.equal(listFinancialReminderSources(state, new Date('2026-10-26T12:00:00+00:00'))[0].status, 'overdue');
});

test('restart-style repeated synchronisation is duplicate-safe', () => {
  const state = baseState(); state.scheduledPayments.push({ id: 'insurance', title: 'Fictional insurance', dueDate: '2026-08-14' });
  synchroniseFinancialReminders(state, new Date('2026-08-11T12:00:00+01:00'));
  const id = state.tasks[0].id;
  synchroniseFinancialReminders(state, new Date('2026-08-11T18:00:00+01:00'));
  assert.equal(state.tasks.filter((task) => task.source === 'financial_reminder').length, 1);
  assert.equal(state.tasks[0].id, id);
  assert.equal(id, reminderTaskId('scheduled_payment', 'insurance', '2026-08-14'));
});

test('resolved scheduled source removes its active reminder task', () => {
  const state = baseState(); state.scheduledPayments.push({ id: 'card', title: 'Fictional card', dueDate: '2026-08-11', status: 'scheduled' });
  synchroniseFinancialReminders(state, new Date('2026-08-11T10:00:00+01:00'));
  assert.equal(state.tasks.length, 1);
  state.scheduledPayments[0].status = 'paid';
  synchroniseFinancialReminders(state, new Date('2026-08-11T11:00:00+01:00'));
  assert.equal(state.tasks.length, 0);
});

test('dismiss for today preserves the source and returns on the next local date', () => {
  let state = baseState(); state.scheduledPayments.push({ id: 'utility', title: 'Fictional utility', dueDate: '2026-08-12' });
  synchroniseFinancialReminders(state, new Date('2026-08-11T09:00:00+01:00'));
  state = dismissFinancialReminderForToday(state, 'scheduled_payment', 'utility', new Date('2026-08-11T10:00:00+01:00'));
  synchroniseFinancialReminders(state, new Date('2026-08-11T10:00:00+01:00'));
  assert.equal(state.tasks[0].snoozedUntil, '2026-08-12');
  synchroniseFinancialReminders(state, new Date('2026-08-12T08:00:00+01:00'));
  assert.equal(state.tasks[0].snoozedUntil, null);
  assert.equal(state.tasks[0].title, 'Fictional utility is due today');
});

test('confirmed recurring commitment generates; uncertain pattern does not', () => {
  const state = baseState();
  state.transactions.push(
    ...['2026-04-13', '2026-05-13', '2026-06-13', '2026-07-13'].map((date, index) => fictionalRecurringTransaction(`confirmed-${index}`, date, 'Fictional Broadband')),
    fictionalRecurringTransaction('uncertain-1', '2026-06-20', 'Fictional Maybe'),
    fictionalRecurringTransaction('uncertain-2', '2026-07-20', 'Fictional Maybe')
  );
  synchroniseFinancialReminders(state, new Date('2026-08-11T12:00:00+01:00'));
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].title, 'Fictional Broadband is coming up');
});

test('global pause blocks creation and pauses existing local and rule reminders without deleting configuration', () => {
  let state = baseState(); state.scheduledPayments.push({ id: 'subscription', title: 'Fictional subscription', dueDate: '2026-08-12' });
  state = setFinancialReminderConfiguration(state, { sourceType: 'scheduled_payment', sourceId: 'subscription', enabled: true, daysBefore: 3 }, new Date('2026-08-10T12:00:00Z'));
  state.automation.enabled = false;
  state.tasks.push({ id: 'automation_example', source: 'automation_rule', title: 'Fictional rule reminder', updatedAt: '2026-08-10T12:00:00.000Z', snoozedUntil: null });
  synchroniseFinancialReminders(state, new Date('2026-08-11T12:00:00+01:00'));
  assert.equal(state.tasks.some((task) => task.source === 'financial_reminder'), false);
  assert.equal(state.tasks[0].snoozedUntil, '9999-12-31');
  assert.equal(state.automation.reminders.length, 1);
  state.automation.enabled = true;
  synchroniseFinancialReminders(state, new Date('2026-08-11T12:05:00+01:00'));
  assert.equal(state.tasks.find((task) => task.source === 'automation_rule').snoozedUntil, null);
  assert.equal(state.tasks.filter((task) => task.source === 'financial_reminder').length, 1);
});

test('pausing after creation preserves completion lifecycle when re-enabled', () => {
  const state = baseState(); state.scheduledPayments.push({ id: 'loan', title: 'Fictional loan', dueDate: '2026-08-11' });
  synchroniseFinancialReminders(state, new Date('2026-08-11T09:00:00+01:00'));
  state.tasks[0].completedAt = '2026-08-11T09:05:00.000Z';
  state.automation.enabled = false;
  synchroniseFinancialReminders(state, new Date('2026-08-11T10:00:00+01:00'));
  state.automation.enabled = true;
  synchroniseFinancialReminders(state, new Date('2026-08-11T11:00:00+01:00'));
  assert.equal(state.tasks[0].completedAt, '2026-08-11T09:05:00.000Z');
});

test('existing review item with explicit due date is recognised without creating a duplicate task', () => {
  const state = baseState(); state.reviewItems.push({ id: 'review:test', status: 'needs_attention', dueDate: '2026-08-11', title: 'Fictional review' });
  const sources = listFinancialReminderSources(state, new Date('2026-08-11T09:00:00+01:00'));
  assert.equal(sources.some((source) => source.sourceType === 'review_due'), true);
  synchroniseFinancialReminders(state, new Date('2026-08-11T09:00:00+01:00'));
  assert.equal(state.tasks.length, 0);
});

test('timing crosses year and BST boundaries without timezone drift', () => {
  let state = baseState(); state.scheduledPayments.push({ id: 'annual', title: 'Fictional annual fee', dueDate: '2027-01-02' });
  state = setFinancialReminderConfiguration(state, { sourceType: 'scheduled_payment', sourceId: 'annual', daysBefore: 7, enabled: true }, new Date('2026-12-01T12:00:00Z'));
  assert.equal(listFinancialReminderSources(state, new Date('2026-12-20T12:00:00Z'))[0].triggerDate, '2026-12-26');
  state.scheduledPayments[0].dueDate = '2026-03-30';
  assert.equal(listFinancialReminderSources(state, new Date('2026-03-28T23:30:00Z'))[0].status, 'upcoming');
});

test('user-created reminders require explicit date/title and stay local-state only', async () => {
  const state = createUserFinancialReminder(baseState(), { title: 'Fictional renewal', dueDate: '2026-09-01', daysBefore: 7 }, new Date('2026-08-11T12:00:00Z'));
  assert.equal(state.automation.reminders[0].sourceType, 'user');
  const source = await fs.readFile(new URL('../financial-reminders.js', import.meta.url), 'utf8');
  assert.equal(/\bfetch\s*\(|https?:\/\/|XMLHttpRequest|WebSocket/.test(source), false);
});

function fictionalRecurringTransaction(id, date, merchantName) {
  return { id, date, accountId: 'fictional-account', merchantName, outgoing: 20, incoming: 0, financiallyActive: true, duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', transferStatus: 'no', budgetTreatment: 'spending', category: 'Fictional bills' };
}
