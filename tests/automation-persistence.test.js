import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTOMATION_CERTAINTY, AUTOMATION_EXECUTION_STATUS, AUTOMATION_REASON, AUTOMATION_SAFETY_CLASS, AUTOMATION_TRIGGER,
  createAutomationTrigger, evaluateAutomationRules, executeAutomationProposal, setAutomationEnabled
} from '../automation-engine.js';
import { synchroniseAutomationReviewSignals } from '../automation-review-integration.js';
import { FinanceDataStore } from '../data-store.js';
import { createUserFinancialReminder } from '../financial-reminders.js';
import { activeReviewItems, synchroniseReviewItems } from '../review-lifecycle.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('legacy state migrates automation metadata safely and backup/restore preserves it', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-automation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();

  let current = (await store.loadState()).state;
  assert.equal(current.schemaVersion, 10);
  assert.deepEqual(current.automation, { version: 2, enabled: true, rules: [], reminders: [], executions: {}, manualOverrides: {}, reviewSignals: {}, history: {} });

  current = createUserFinancialReminder(current, {
    title: 'Fictional annual renewal', dueDate: '2026-09-01', daysBefore: 7
  }, new Date('2026-08-10T19:00:00.000Z'));
  current.transactions.push(fictionalTransaction());
  current = synchroniseAutomationReviewSignals(current, {
    results: [{
      status: AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED,
      reasonCode: AUTOMATION_REASON.REVIEW_REQUIRED,
      sourceType: 'transaction',
      sourceId: 'fictional-automation-record',
      actionType: 'mark_local_record',
      dueAt: '2026-09-01T09:00:00.000Z'
    }]
  }, new Date('2026-08-10T19:30:00.000Z')).state;
  synchroniseReviewItems(current, new Date('2026-08-10T19:30:00.000Z'));
  const automationReviewId = activeReviewItems(current).find((item) => item.type === 'automation_attention')?.id;
  assert.ok(automationReviewId);
  current = await store.saveState(current);

  const trigger = createAutomationTrigger(AUTOMATION_TRIGGER.TRANSACTION_CHANGE, { sourceType: 'transaction', sourceId: 'fictional-automation-record' });
  const candidate = evaluateAutomationRules(current, trigger, [fictionalRule()])[0];
  const applied = await executeAutomationProposal(current, candidate, {
    mark_local_record: ({ state }) => {
      state.transactions[0].category = 'Fictional category';
      return { state };
    }
  }, { recoveryMode: store.mode, now: new Date('2026-08-10T20:00:00.000Z') });
  assert.equal(applied.result.status, 'applied');
  current = setAutomationEnabled(applied.state, false);
  current = await store.saveState(current);

  const executionId = candidate.executionId;
  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  current = (await restarted.loadState()).state;
  assert.equal(current.automation.enabled, false);
  assert.equal(current.automation.executions[executionId].status, 'applied');
  assert.deepEqual(current.automation.history, {});
  assert.equal(current.automation.reminders[0].title, 'Fictional annual renewal');
  assert.equal(current.automation.reminders[0].dueDate, '2026-09-01');
  assert.equal(Object.keys(current.automation.reviewSignals).length, 1);
  assert.equal(current.reviewItems.find((item) => item.id === automationReviewId)?.status, 'needs_attention');

  const backupPath = path.join(directory, 'fictional-automation.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', current);
  let changed = setAutomationEnabled(current, true);
  changed.automation.executions = {};
  changed.automation.reminders = [];
  changed.automation.reviewSignals = {};
  changed.automation.history = {};
  changed.reviewItems = [];
  await restarted.saveState(changed);

  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(restored.state.automation.enabled, false);
  assert.equal(restored.state.automation.executions[executionId].status, 'applied');
  assert.deepEqual(restored.state.automation.history, {});
  assert.equal(restored.state.automation.reminders[0].title, 'Fictional annual renewal');
  assert.equal(restored.state.automation.reminders[0].daysBefore, 7);
  assert.equal(Object.keys(restored.state.automation.reviewSignals).length, 1);
  assert.equal(restored.state.reviewItems.find((item) => item.id === automationReviewId)?.status, 'needs_attention');
});

function fictionalRule() {
  return {
    id: 'fictional_persistence_rule',
    triggers: [AUTOMATION_TRIGGER.TRANSACTION_CHANGE],
    conditions: [{ id: 'record_exists', test: ({ state }) => state.transactions.some((item) => item.id === 'fictional-automation-record') }],
    propose: () => ({
      source: { type: 'transaction', id: 'fictional-automation-record' },
      action: { type: 'mark_local_record', key: 'category', identityContext: { decision: 'fictional' }, payload: { category: 'Fictional category' } },
      safetyClass: AUTOMATION_SAFETY_CLASS.SAFE_AUTOMATIC,
      certainty: AUTOMATION_CERTAINTY.CERTAIN,
      reasonCode: 'fictional_rule_match'
    })
  };
}

function fictionalTransaction() {
  return {
    id: 'fictional-automation-record',
    date: '2026-08-10',
    budgetMonth: '2026-08',
    description: 'Fictional automation test record',
    category: '',
    incoming: 0,
    outgoing: 10,
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
