import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  AUTOMATION_RULE_ACTION, AUTOMATION_RULE_CONDITION, AUTOMATION_RULE_TRIGGER,
  duplicateAutomationRule, normaliseAutomationRuleCollection, removeAutomationRule,
  setAutomationRuleEnabled, upsertAutomationRule, validateAutomationRule
} from '../automation-rule-model.js';
import { normaliseAutomationState } from '../automation-state.js';
import { previewStoredAutomationRules, runStoredAutomationRules } from '../automation-rules.js';

function baseState() {
  return {
    meta: { revision: 7 },
    automation: normaliseAutomationState(),
    accounts: [{ id: 'account-main', name: 'Main account', active: true }],
    budgets: [
      { id: 'budget-food', category: 'Food', planned: 300 },
      { id: 'budget-fuel', category: 'Fuel', planned: 180 }
    ],
    transactions: [{
      id: 'tx-tesco-fuel',
      accountId: 'account-main',
      date: '2026-04-20',
      description: 'CARD PURCHASE 123456',
      merchantName: 'Tesco Fuel',
      outgoing: 45,
      incoming: 0,
      category: '',
      budgetCategoryId: '',
      categorySource: 'imported',
      reviewStatus: 'pending',
      financiallyActive: true
    }],
    tasks: []
  };
}

function merchantBudgetRule(overrides = {}) {
  return {
    id: 'rule_tesco_fuel',
    name: 'Tesco fuel to Fuel',
    enabled: true,
    trigger: AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE,
    conditions: [{
      id: 'merchant',
      field: AUTOMATION_RULE_CONDITION.MERCHANT,
      operator: 'equals',
      value: 'Tesco Fuel'
    }],
    action: { type: AUTOMATION_RULE_ACTION.ASSIGN_BUDGET, value: 'budget-fuel' },
    explanation: 'When the merchant is Tesco Fuel, use the Fuel budget.',
    ...overrides
  };
}

test('rule CRUD stays bounded, validated and restart-safe', () => {
  let state = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  assert.equal(state.automation.rules.length, 1);
  assert.equal(state.automation.rules[0].id, 'rule_tesco_fuel');

  state = duplicateAutomationRule(state, 'rule_tesco_fuel', 'rule_tesco_fuel_copy', new Date('2026-08-11T11:05:00.000Z'));
  assert.equal(state.automation.rules.length, 2);
  assert.equal(state.automation.rules.find((rule) => rule.id === 'rule_tesco_fuel_copy').enabled, false);

  state = setAutomationRuleEnabled(state, 'rule_tesco_fuel_copy', true, new Date('2026-08-11T11:10:00.000Z'));
  assert.equal(state.automation.rules.find((rule) => rule.id === 'rule_tesco_fuel_copy').enabled, true);

  state = removeAutomationRule(state, 'rule_tesco_fuel_copy');
  assert.deepEqual(state.automation.rules.map((rule) => rule.id), ['rule_tesco_fuel']);

  const restarted = normaliseAutomationState(JSON.parse(JSON.stringify(state.automation)));
  assert.deepEqual(restarted.rules, state.automation.rules);
});

test('invalid or unsupported actions cannot persist', () => {
  const checked = validateAutomationRule({
    ...merchantBudgetRule(),
    action: { type: 'transfer_money', value: 'fictional destination' }
  });
  assert.equal(checked.valid, false);
  assert.match(checked.errors.join(' '), /supported Then action/i);

  const collection = normaliseAutomationRuleCollection([merchantBudgetRule(), {
    ...merchantBudgetRule(),
    id: 'rule_forbidden',
    action: { type: 'external_payment', value: 'nowhere' }
  }]);
  assert.deepEqual(collection.map((rule) => rule.id), ['rule_tesco_fuel']);
});

test('merchant identity can drive a deterministic budget assignment through the shared engine', async () => {
  const configured = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  const result = await runStoredAutomationRules(configured, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, true);
  assert.equal(result.state.transactions[0].budgetCategoryId, 'budget-fuel');
  assert.equal(result.state.transactions[0].category, 'Fuel');
  assert.equal(result.state.transactions[0].categorySource, 'automation');
  assert.equal(result.results.filter((row) => row.status === 'applied').length, 1);
});

test('manual transaction purpose always wins over automation', async () => {
  const state = baseState();
  state.transactions[0].budgetCategoryId = 'budget-food';
  state.transactions[0].category = 'Food';
  state.transactions[0].categorySource = 'manual';
  const configured = upsertAutomationRule(state, merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  const result = await runStoredAutomationRules(configured, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, 'budget-food');
  assert.equal(result.state.transactions[0].category, 'Food');
  assert.ok(result.results.some((row) => row.reasonCode === 'manual_override'));
});

test('disabled rule and global pause never mutate financial state', async () => {
  const disabled = upsertAutomationRule(baseState(), { ...merchantBudgetRule(), enabled: false }, new Date('2026-08-11T11:00:00.000Z'));
  let result = await runStoredAutomationRules(disabled, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, '');

  const pausedState = baseState();
  pausedState.automation.enabled = false;
  const paused = upsertAutomationRule(pausedState, merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  result = await runStoredAutomationRules(paused, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, '');
});

test('recovery mode blocks otherwise safe rule execution', async () => {
  const configured = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  const result = await runStoredAutomationRules(configured, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'recovery_required' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, '');
  assert.ok(result.results.some((row) => row.reasonCode === 'recovery_mode_active'));
});

test('the same rule action is idempotent across repeated cycles', async () => {
  const configured = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  const first = await runStoredAutomationRules(configured, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  const second = await runStoredAutomationRules(first.state, { now: new Date('2026-08-11T12:05:00.000Z'), recoveryMode: 'normal' });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.ok(second.results.some((row) => row.status === 'already_applied'));
  assert.equal(second.state.transactions[0].budgetCategoryId, 'budget-fuel');
});

test('compatible duplicate actions deduplicate and conflicting categories fail safe', async () => {
  let compatible = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  compatible = upsertAutomationRule(compatible, {
    ...merchantBudgetRule(),
    id: 'rule_tesco_fuel_second',
    name: 'Same safe Fuel assignment'
  }, new Date('2026-08-11T11:01:00.000Z'));
  let result = await runStoredAutomationRules(compatible, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, true);
  assert.equal(result.state.transactions[0].budgetCategoryId, 'budget-fuel');
  assert.ok(result.results.some((row) => row.reasonCode === 'compatible_duplicate_rule_action'));

  let conflicting = upsertAutomationRule(baseState(), merchantBudgetRule(), new Date('2026-08-11T11:00:00.000Z'));
  conflicting = upsertAutomationRule(conflicting, {
    ...merchantBudgetRule(),
    id: 'rule_tesco_food',
    name: 'Conflicting Food assignment',
    action: { type: AUTOMATION_RULE_ACTION.ASSIGN_BUDGET, value: 'budget-food' }
  }, new Date('2026-08-11T11:01:00.000Z'));
  result = await runStoredAutomationRules(conflicting, { now: new Date('2026-08-11T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, '');
  assert.equal(result.conflicts.length, 1);
  assert.ok(result.results.some((row) => row.reasonCode === 'rule_conflict'));
});

test('preview includes a paused rule but never mutates state', async () => {
  const state = upsertAutomationRule(baseState(), { ...merchantBudgetRule(), enabled: false }, new Date('2026-08-11T11:00:00.000Z'));
  const preview = await previewStoredAutomationRules(state, { ruleId: 'rule_tesco_fuel', now: new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.matchCount, 1);
  assert.equal(state.transactions[0].budgetCategoryId, '');
});

test('date-relative recurring rule creates one local reminder for a confirmed pattern', async () => {
  const state = baseState();
  state.transactions = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'].map((date, index) => ({
    id: `tx-rent-${index + 1}`,
    accountId: 'account-main',
    date,
    merchantName: 'Fictional Homes',
    description: 'Fictional Homes',
    outgoing: 700,
    incoming: 0,
    category: 'Rent',
    budgetCategoryId: 'budget-food',
    categorySource: 'imported',
    financiallyActive: true
  }));
  const rule = {
    id: 'rule_rent_due',
    name: 'Rent reminder',
    enabled: true,
    trigger: AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY,
    conditions: [
      { id: 'cadence', field: AUTOMATION_RULE_CONDITION.RECURRING_CADENCE, operator: 'equals', value: 'monthly' },
      { id: 'due', field: AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE, operator: 'between', value: 0, value2: 3 }
    ],
    action: { type: AUTOMATION_RULE_ACTION.CREATE_REMINDER, value: 'Check upcoming rent' },
    explanation: 'Remind me shortly before the expected monthly rent date.'
  };
  const configured = upsertAutomationRule(state, rule, new Date('2026-04-28T12:00:00.000Z'));
  const result = await runStoredAutomationRules(configured, { now: new Date('2026-04-29T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(result.changed, true);
  assert.equal(result.state.tasks.length, 1);
  assert.equal(result.state.tasks[0].title, 'Check upcoming rent');
  const repeated = await runStoredAutomationRules(result.state, { now: new Date('2026-04-30T12:00:00.000Z'), recoveryMode: 'normal' });
  assert.equal(repeated.changed, false);
  assert.equal(repeated.state.tasks.length, 1);
});

test('rules implementation has no network, telemetry or analytics dependency', async () => {
  for (const file of ['automation-rule-model.js', 'automation-rules.js', 'automation-rules-core.js']) {
    const source = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /from ['"]node:(?:http|https|net|tls|dns)['"]/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /telemetry|analytics/i);
  }
});
