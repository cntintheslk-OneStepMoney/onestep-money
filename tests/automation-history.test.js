import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  AUTOMATION_HISTORY_FILTER, automationHistoryEntries, automationHistoryPresentation,
  automationUndoAvailability, recordAutomationHistoryOutcome, undoAutomationHistoryEntry
} from '../automation-history.js';
import { runStoredAutomationRulesWithHistory } from '../automation-history-runner.js';
import { MAX_AUTOMATION_HISTORY_ENTRIES, normaliseAutomationState } from '../automation-state.js';

const NOW = '2026-08-11T20:00:00.000Z';

async function applied() {
  return runStoredAutomationRulesWithHistory(baseState(), { now: NOW, recoveryMode: 'normal' });
}

test('successful automation records exactly one history entry and repeat evaluation does not duplicate it', async () => {
  const first = await applied();
  assert.equal(first.changed, true);
  assert.equal(first.historyChanged, true);
  assert.equal(first.state.transactions[0].category, 'Food');
  assert.equal(automationHistoryEntries(first.state).length, 1);
  const second = await runStoredAutomationRulesWithHistory(first.state, { now: '2026-08-11T20:01:00.000Z', recoveryMode: 'normal' });
  assert.equal(second.historyChanged, false);
  assert.equal(automationHistoryEntries(second.state).length, 1);
});

test('blocked and review-required outcomes are explainable without copied financial content', () => {
  let next = recordAutomationHistoryOutcome(baseState(), { result: engineResult('blocked', 'manual_override', 'a'), now: NOW }).state;
  next = recordAutomationHistoryOutcome(next, { result: { ...engineResult('review_required', 'rule_conflict'), executionId: null }, now: NOW }).state;
  const rows = automationHistoryEntries(next);
  assert.match(automationHistoryPresentation(next, rows.find((row) => row.result === 'blocked')).why, /manual choice/i);
  assert.match(automationHistoryPresentation(next, rows.find((row) => row.result === 'needs_review')).why, /rules/i);
  const stored = JSON.stringify(next.automation.history);
  assert.doesNotMatch(stored, /Corner Shop|12\.34/);
});

test('unchanged category assignment can be undone', async () => {
  const first = await applied();
  const entry = automationHistoryEntries(first.state, AUTOMATION_HISTORY_FILTER.APPLIED)[0];
  const result = undoAutomationHistoryEntry(first.state, entry.id, { expectedRevision: first.state.meta.revision, now: NOW });
  assert.equal(result.status, 'undone');
  assert.equal(result.state.transactions[0].category, undefined);
  assert.equal(result.state.transactions[0].budgetCategoryId, undefined);
  assert.equal(automationHistoryEntries(result.state, AUTOMATION_HISTORY_FILTER.UNDONE).length, 1);
});

test('newer manual edit blocks undo and remains authoritative', async () => {
  const first = await applied();
  const entry = automationHistoryEntries(first.state, AUTOMATION_HISTORY_FILTER.APPLIED)[0];
  const edited = structuredClone(first.state);
  Object.assign(edited.transactions[0], { budgetCategoryId: 'budget_travel', category: 'Travel', categorySource: 'manual' });
  delete edited.transactions[0].automationRuleId;
  const availability = automationUndoAvailability(edited, entry, { expectedRevision: edited.meta.revision });
  assert.equal(availability.reasonCode, 'newer_change');
  const result = undoAutomationHistoryEntry(edited, entry.id, { expectedRevision: edited.meta.revision, now: NOW });
  assert.equal(result.status, 'blocked');
  assert.equal(result.state.transactions[0].category, 'Travel');
});

test('undo cannot run twice and the original execution remains deduplicated', async () => {
  const first = await applied();
  const entry = automationHistoryEntries(first.state, AUTOMATION_HISTORY_FILTER.APPLIED)[0];
  const undone = undoAutomationHistoryEntry(first.state, entry.id, { expectedRevision: first.state.meta.revision, now: NOW });
  const repeat = undoAutomationHistoryEntry(undone.state, entry.id, { expectedRevision: undone.state.meta.revision, now: NOW });
  assert.equal(repeat.reasonCode, 'already_undone');
  const rerun = await runStoredAutomationRulesWithHistory(undone.state, { now: '2026-08-11T21:00:00.000Z', recoveryMode: 'normal' });
  assert.equal(rerun.state.transactions[0].category, undefined);
  assert.equal(automationHistoryEntries(rerun.state, AUTOMATION_HISTORY_FILTER.UNDONE).length, 1);
});

test('undo/history survives serialisation used by restart and backup restore', async () => {
  const first = await applied();
  const entry = automationHistoryEntries(first.state, AUTOMATION_HISTORY_FILTER.APPLIED)[0];
  const undone = undoAutomationHistoryEntry(first.state, entry.id, { expectedRevision: first.state.meta.revision, now: NOW });
  const restored = JSON.parse(JSON.stringify(undone.state));
  restored.automation = normaliseAutomationState(restored.automation);
  assert.equal(automationHistoryEntries(restored, AUTOMATION_HISTORY_FILTER.UNDONE)[0].undoStatus, 'completed');
  assert.equal(restored.automation.executions[entry.executionId].status, 'applied');
});

test('stale state revision blocks undo before mutation', async () => {
  const first = await applied();
  const entry = automationHistoryEntries(first.state, AUTOMATION_HISTORY_FILTER.APPLIED)[0];
  const result = undoAutomationHistoryEntry(first.state, entry.id, { expectedRevision: first.state.meta.revision + 1, now: NOW });
  assert.equal(result.reasonCode, 'stale_revision');
  assert.equal(result.state.transactions[0].category, 'Food');
});

test('history is bounded without dropping recent active undo state', () => {
  const history = {};
  for (let i = 0; i < MAX_AUTOMATION_HISTORY_ENTRIES + 30; i += 1) history[`history_${i.toString(16).padStart(64, '0')}`] = historyRow(i);
  const activeId = `history_${'f'.repeat(64)}`;
  history[activeId] = {
    ...historyRow(1), id: activeId, executionId: 'e'.repeat(64), sourceType: 'transaction', sourceId: 'tx_1',
    actionType: 'assign_transaction_budget', result: 'applied', timestamp: '2026-08-11T22:00:00.000Z', reasonCode: 'applied',
    undoStatus: 'available', undo: { kind: 'transaction_fields', fields: ['category'], before: { category: { present: false, value: null } }, after: { category: { present: true, value: 'Food' } } }
  };
  const normalised = normaliseAutomationState({ history });
  assert.ok(Object.keys(normalised.history).length <= MAX_AUTOMATION_HISTORY_ENTRIES);
  assert.equal(normalised.history[activeId].undoStatus, 'available');
});

test('invalid history is rejected independently', () => {
  const normalised = normaliseAutomationState({ enabled: true, history: { bad: { result: 'applied' }, [`history_${'a'.repeat(64)}`]: { result: 'unknown' } } });
  assert.equal(normalised.enabled, true);
  assert.deepEqual(normalised.history, {});
});

test('history UI exposes filters, Why and Undo locally without network or telemetry dependencies', async () => {
  const [preload, ui, core, runner] = await Promise.all(['preload-bridge.cjs', 'automation-history-ui.js', 'automation-history.js', 'automation-history-runner.js']
    .map((file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8')));
  assert.match(preload, /automation-history-ui\.js/);
  for (const label of ['Applied', 'Needs review', 'Blocked', 'Undone', 'Why?', 'Undo']) assert.ok(ui.includes(label));
  assert.doesNotMatch(`${ui}\n${core}\n${runner}`, /\bfetch\s*\(|telemetry|analytics|node:(?:http|https|net|tls|dns)/i);
});

function engineResult(status, reasonCode, seed = 'b') {
  return { status, reasonCode, executionId: seed.repeat(64), ruleId: 'rule_food', sourceType: 'transaction', sourceId: 'tx_1', actionType: 'assign_transaction_budget' };
}

function historyRow(index) {
  const id = `history_${index.toString(16).padStart(64, '0')}`;
  return { id, executionId: null, ruleIds: [], sourceType: 'state', sourceId: `source_${index}`, actionType: 'local_action', result: 'blocked', timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), reasonCode: 'review_required', undoStatus: 'unavailable', undo: null, undoneAt: null };
}

function baseState() {
  return {
    meta: { revision: 7, createdAt: NOW, updatedAt: NOW },
    automation: { enabled: true, rules: [{ id: 'rule_food', name: 'Food purchases', enabled: true, trigger: 'transaction_change', conditions: [{ id: 'merchant_match', field: 'merchant', operator: 'equals', value: 'Corner Shop' }], action: { type: 'assign_budget', value: 'budget_food' }, explanation: 'Categorise this known local merchant as Food.', createdAt: NOW, updatedAt: NOW }], executions: {}, manualOverrides: {}, reviewSignals: {}, history: {} },
    transactions: [{ id: 'tx_1', date: '2026-08-11', description: 'Corner Shop', outgoing: 12.34, incoming: 0 }],
    budgets: [{ id: 'budget_food', category: 'Food', monthlyAmount: 300 }, { id: 'budget_travel', category: 'Travel', monthlyAmount: 100 }],
    tasks: []
  };
}
