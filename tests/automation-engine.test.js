import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  AUTOMATION_CERTAINTY, AUTOMATION_EXECUTION_STATUS, AUTOMATION_REASON, AUTOMATION_SAFETY_CLASS, AUTOMATION_TRIGGER,
  createAutomationTrigger, evaluateAutomationRules, executeAutomationProposal, recordAutomationManualOverride, setAutomationEnabled
} from '../automation-engine.js';
import { normaliseAutomationState } from '../automation-state.js';

const trigger = createAutomationTrigger(AUTOMATION_TRIGGER.TRANSACTION_CHANGE, { sourceType: 'transaction', sourceId: 'fictional-transaction' });

function state() {
  return { meta: { revision: 4 }, automation: normaliseAutomationState(), transactions: [{ id: 'fictional-transaction', category: '' }] };
}

function rule(overrides = {}) {
  return {
    id: 'categorise_known_local_record',
    triggers: [AUTOMATION_TRIGGER.TRANSACTION_CHANGE],
    conditions: [{ id: 'has_record', test: ({ state: current }) => current.transactions.some((item) => item.id === 'fictional-transaction') }],
    propose: () => ({
      source: { type: 'transaction', id: 'fictional-transaction' },
      action: { type: 'mark_local_record', key: 'category', identityContext: { decision: 'known' }, payload: { category: 'Fictional category' } },
      safetyClass: AUTOMATION_SAFETY_CLASS.SAFE_AUTOMATIC,
      certainty: AUTOMATION_CERTAINTY.CERTAIN,
      reasonCode: 'known_local_rule',
      explanation: 'A deterministic local rule matched.',
      ...overrides
    })
  };
}

function proposal(overrides = {}) {
  return evaluateAutomationRules(state(), trigger, [rule(overrides)])[0];
}

const handlers = {
  mark_local_record: ({ state: next, proposal: item }) => {
    next.transactions[0].category = item.action.payload.category;
    return { state: next };
  }
};

const normalContext = { recoveryMode: 'normal', now: new Date('2026-08-10T20:00:00.000Z') };

test('same state and trigger evaluate to identical deterministic proposals', () => {
  const first = evaluateAutomationRules(state(), trigger, [rule()]);
  const second = evaluateAutomationRules(state(), trigger, [rule()]);
  assert.deepEqual(first, second);
  assert.match(first[0].executionId, /^[0-9a-f]{64}$/);
});

test('the same mutation cannot execute twice after persisted state is reloaded', async () => {
  const first = await executeAutomationProposal(state(), proposal(), handlers, normalContext);
  assert.equal(first.result.status, AUTOMATION_EXECUTION_STATUS.APPLIED);
  const restarted = structuredClone(first.state);
  restarted.automation = normaliseAutomationState(restarted.automation);
  const reevaluated = evaluateAutomationRules(restarted, trigger, [rule()])[0];
  const second = await executeAutomationProposal(restarted, reevaluated, handlers, normalContext);
  assert.equal(second.result.status, AUTOMATION_EXECUTION_STATUS.ALREADY_APPLIED);
  assert.equal(second.result.reasonCode, AUTOMATION_REASON.ALREADY_APPLIED);
  assert.equal(second.state.transactions[0].category, 'Fictional category');
});

test('global pause allows evaluation but blocks automatic mutation', async () => {
  const paused = setAutomationEnabled(state(), false);
  const evaluated = evaluateAutomationRules(paused, trigger, [rule()]);
  assert.equal(evaluated.length, 1);
  const executed = await executeAutomationProposal(paused, evaluated[0], handlers, normalContext);
  assert.equal(executed.result.reasonCode, AUTOMATION_REASON.AUTOMATION_PAUSED);
  assert.equal(executed.state.transactions[0].category, '');
});

test('unknown or active recovery mode blocks execution conservatively', async () => {
  const unknown = await executeAutomationProposal(state(), proposal(), handlers, {});
  assert.equal(unknown.result.reasonCode, AUTOMATION_REASON.RECOVERY_STATUS_UNKNOWN);
  const recovery = await executeAutomationProposal(state(), proposal(), handlers, { recoveryMode: 'recovery_required' });
  assert.equal(recovery.result.reasonCode, AUTOMATION_REASON.RECOVERY_MODE_ACTIVE);
});

test('stale state revision blocks execution', async () => {
  const stale = proposal();
  const changed = state();
  changed.meta.revision = 5;
  const result = await executeAutomationProposal(changed, stale, handlers, normalContext);
  assert.equal(result.result.reasonCode, AUTOMATION_REASON.STALE_STATE_REVISION);
  assert.equal(result.state.transactions[0].category, '');
});

test('manual override wins over an otherwise safe automation', async () => {
  const candidate = proposal();
  const manuallyDecided = recordAutomationManualOverride(state(), candidate, new Date('2026-08-10T19:00:00.000Z'));
  const result = await executeAutomationProposal(manuallyDecided, candidate, handlers, normalContext);
  assert.equal(result.result.reasonCode, AUTOMATION_REASON.MANUAL_OVERRIDE);
  assert.equal(result.state.transactions[0].category, '');
});

test('ambiguous proposals require review instead of guessing', async () => {
  const ambiguous = proposal({ certainty: AUTOMATION_CERTAINTY.AMBIGUOUS, reasonCode: 'ambiguous_match' });
  const result = await executeAutomationProposal(state(), ambiguous, handlers, normalContext);
  assert.equal(result.result.status, AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED);
  assert.equal(result.state.transactions[0].category, '');
});

test('successful execution persists only stable technical result metadata and privacy-safe diagnostics', async () => {
  const calls = [];
  const diagnostics = { record: async (code, details) => calls.push({ code, details }) };
  const candidate = proposal({ action: { type: 'mark_local_record', key: 'category', identityContext: { amount: 123.45 }, payload: { category: 'Private-looking fictional label 9999' } } });
  const result = await executeAutomationProposal(state(), candidate, handlers, { ...normalContext, diagnostics });
  const record = result.state.automation.executions[candidate.executionId];
  assert.deepEqual(Object.keys(record).sort(), ['actionType', 'appliedAt', 'reasonCode', 'ruleId', 'status']);
  assert.equal(record.actionType, 'mark_local_record');
  const diagnosticText = JSON.stringify(calls);
  assert.doesNotMatch(diagnosticText, /123\.45|9999|fictional-transaction|private-looking/i);
  assert.equal(calls[0].code, 'AUTOMATION_EXECUTION_RESULT');
});

test('failed execution returns the original coherent state', async () => {
  const original = state();
  const result = await executeAutomationProposal(original, proposal(), {
    mark_local_record: ({ state: next }) => {
      next.transactions[0].category = 'Partial mutation';
      const error = new Error('fictional handler failed');
      error.code = 'LOCAL_HANDLER_FAILED';
      throw error;
    }
  }, normalContext);
  assert.equal(result.result.status, AUTOMATION_EXECUTION_STATUS.FAILED);
  assert.deepEqual(result.state, original);
});

test('financial actions require the authoritative Financial Safety assessment', async () => {
  const financial = proposal({
    action: { type: 'record_safe_debt_adjustment', key: 'extra-payment', risk: 'financial', identityContext: { kind: 'debt' } },
    financialSafety: { kind: 'debt_overpayment', amount: 25 }
  });
  const missing = await executeAutomationProposal(state(), financial, { record_safe_debt_adjustment: ({ state: next }) => ({ state: next }) }, normalContext);
  assert.equal(missing.result.reasonCode, AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED);
  const unsafe = await executeAutomationProposal(state(), financial, { record_safe_debt_adjustment: ({ state: next }) => ({ state: next }) }, {
    ...normalContext, financialSafetyAssessment: () => ({ safeToOverpay: false, safeExtraPayment: 0 })
  });
  assert.equal(unsafe.result.reasonCode, AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED);
  const safe = await executeAutomationProposal(state(), financial, { record_safe_debt_adjustment: ({ state: next }) => ({ state: next }) }, {
    ...normalContext, financialSafetyAssessment: (_state, amount) => ({ safeToOverpay: amount === 25, safeExtraPayment: 25 })
  });
  assert.equal(safe.result.status, AUTOMATION_EXECUTION_STATUS.APPLIED);
});

test('external money movement remains forbidden even if a handler is registered', async () => {
  const external = proposal({ action: { type: 'transfer_money', key: 'forbidden', risk: 'financial' }, financialSafety: { kind: 'debt_overpayment', amount: 1 } });
  const result = await executeAutomationProposal(state(), external, { transfer_money: () => { throw new Error('must not run'); } }, {
    ...normalContext, financialSafetyAssessment: () => ({ safeToOverpay: true, safeExtraPayment: 100 })
  });
  assert.equal(result.result.reasonCode, AUTOMATION_REASON.FORBIDDEN_ACTION);
});

test('legacy or malformed automation metadata migrates to safe bounded defaults', () => {
  const migrated = normaliseAutomationState({ enabled: false, executions: { bad: { status: 'applied' } }, manualOverrides: [] });
  assert.equal(migrated.enabled, false);
  assert.deepEqual(migrated.executions, {});
  assert.deepEqual(migrated.manualOverrides, {});
});

test('automation engine has no network or telemetry dependency', async () => {
  const source = await fs.readFile(new URL('../automation-engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dns)['"]/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /telemetry|analytics/i);
});
