import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAutomationDashboardModel, setAutomationEnabledState } from '../automation-dashboard.js';
import { createUserFinancialReminder } from '../financial-reminders.js';

const NOW = new Date('2026-08-11T12:00:00.000Z');

function baseState() {
  return {
    meta: { revision: 7 },
    accounts: [],
    transactions: [],
    tasks: [],
    reviewItems: [],
    automation: {
      enabled: true,
      rules: [{
        id: 'fictional_groceries',
        name: 'Tag fictional groceries',
        enabled: true,
        trigger: 'transaction_change',
        conditions: [{ field: 'merchant', operator: 'contains', value: 'fictional market' }],
        action: { type: 'add_tag', value: 'groceries' },
        explanation: 'Tag fictional grocery payments for local review.',
        activationMode: 'future_only',
        activatedAt: '2026-08-10T12:00:00.000Z',
        createdAt: '2026-08-10T12:00:00.000Z',
        updatedAt: '2026-08-10T12:00:00.000Z'
      }, {
        id: 'fictional_paused',
        name: 'Paused fictional rule',
        enabled: false,
        trigger: 'transaction_change',
        conditions: [{ field: 'purpose', operator: 'equals', value: 'fictional' }],
        action: { type: 'add_tag', value: 'paused' },
        explanation: 'A paused fictional rule.',
        activationMode: 'future_only',
        activatedAt: null,
        createdAt: '2026-08-10T12:00:00.000Z',
        updatedAt: '2026-08-10T12:00:00.000Z'
      }],
      reminders: [],
      executions: {},
      manualOverrides: {},
      reviewSignals: {
        review_signal_fictional: {
          id: 'review_signal_fictional',
          kind: 'engine_review',
          sourceType: 'state',
          sourceId: 'global',
          actionType: 'add_local_tag',
          ruleIds: ['fictional_groceries'],
          reasonCode: 'review_required',
          priority: 'normal',
          dueAt: null,
          createdAt: '2026-08-11T10:00:00.000Z',
          updatedAt: '2026-08-11T10:00:00.000Z'
        }
      },
      history: {
        history_fictional_applied: {
          id: 'history_fictional_applied',
          executionId: null,
          ruleIds: ['fictional_groceries'],
          sourceType: 'state',
          sourceId: 'global',
          actionType: 'add_local_tag',
          result: 'applied',
          timestamp: '2026-08-11T09:00:00.000Z',
          reasonCode: 'applied',
          undoStatus: 'unavailable',
          undo: null,
          undoneAt: null
        }
      }
    }
  };
}

test('dashboard derives authoritative state, enabled rules, review count and recent history', () => {
  const model = buildAutomationDashboardModel(baseState(), NOW);
  assert.equal(model.enabled, true);
  assert.equal(model.totalRuleCount, 2);
  assert.equal(model.enabledRuleCount, 1);
  assert.equal(model.reviewCount, 1);
  assert.equal(model.recentTotals.applied, 1);
  assert.equal(model.rules.find((rule) => rule.id === 'fictional_groceries')?.lastRun?.status, 'Applied');
});

test('pause and resume preserve definitions and history without replaying anything', () => {
  const original = baseState();
  const paused = setAutomationEnabledState(original, false);
  const resumed = setAutomationEnabledState(paused, true);

  assert.equal(original.automation.enabled, true);
  assert.equal(paused.automation.enabled, false);
  assert.equal(resumed.automation.enabled, true);
  assert.deepEqual(resumed.automation.rules, paused.automation.rules);
  assert.deepEqual(resumed.automation.reminders, paused.automation.reminders);
  assert.deepEqual(resumed.automation.history, paused.automation.history);
  assert.deepEqual(resumed.automation.executions, paused.automation.executions);
});

test('configured reminders are derived from reminder source truth', () => {
  const withReminder = createUserFinancialReminder(baseState(), {
    title: 'Review fictional annual policy',
    dueDate: '2026-08-20',
    daysBefore: 7
  }, NOW);
  const model = buildAutomationDashboardModel(withReminder, NOW);
  assert.equal(model.configuredReminderCount, 1);
  assert.equal(model.reminders.length, 1);
  assert.equal(model.reminders[0].title, 'Review fictional annual policy');
});

test('empty automation state produces a useful zero-state model', () => {
  const model = buildAutomationDashboardModel({ transactions: [], tasks: [] }, NOW);
  assert.equal(model.enabled, true);
  assert.equal(model.totalRuleCount, 0);
  assert.equal(model.reviewCount, 0);
  assert.equal(model.recentActivity.length, 0);
  assert.equal(model.reminders.length, 0);
});


test('UI contract keeps pause semantic, review routing and passive refresh mutation-free', () => {
  const source = [
    readFileSync(new URL('../automation-dashboard-ui.js', import.meta.url), 'utf8'),
    readFileSync(new URL('../automation-dashboard-render.js', import.meta.url), 'utf8')
  ].join('\n');
  const css = readFileSync(new URL('../automation-dashboard.css', import.meta.url), 'utf8');

  assert.match(source, /id="automationMasterToggle" type="checkbox" role="switch"/);
  assert.match(source, /id="automationStatus"[^>]+aria-live="polite"/);
  assert.match(source, /data-automation-route="review">Open Review Inbox/);
  assert.doesNotMatch(source, /runAutomationRules\s*\(/);
  assert.match(source, /Data recovery protections are separate from Automation pause/);
  assert.match(css, /@media \(max-width: 820px\)/);
  assert.match(css, /var\(--surface-subtle\)/);
});
