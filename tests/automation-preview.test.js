import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATION_RULE_ACTION, AUTOMATION_RULE_ACTIVATION, AUTOMATION_RULE_CONDITION, AUTOMATION_RULE_TRIGGER,
  setAutomationRuleEnabled, upsertAutomationRule
} from '../automation-rule-model.js';
import { previewStoredAutomationRules, runStoredAutomationRules } from '../automation-rules.js';

function stateWithTransactions(count = 1) {
  const transactions = Array.from({ length: count }, (_, index) => ({
    id: `tx-${index + 1}`, accountId: 'account-main', date: '2026-08-10', merchantName: 'Fictional Fuel', description: 'Fictional Fuel',
    outgoing: 25 + index, incoming: 0, category: '', budgetCategoryId: '', categorySource: 'imported', financiallyActive: true,
    sourceDocumentId: `doc-${index + 1}`
  }));
  return {
    meta: { revision: 11 },
    automation: { version: 1, enabled: true, rules: [], reminders: [], executions: {}, manualOverrides: {}, reviewSignals: {} },
    accounts: [{ id:'account-main', name:'Main account' }],
    budgets: [{ id:'budget-fuel', category:'Fuel' }, { id:'budget-food', category:'Food' }],
    transactions,
    documents: transactions.map((tx, index)=>({ id:tx.sourceDocumentId, importedAt:`2026-08-10T10:${String(index % 60).padStart(2,'0')}:00.000Z` })),
    tasks: [], reviewItems: []
  };
}

function fuelRule(overrides={}) {
  return {
    id:'rule_fictional_fuel', name:'Fictional fuel to Fuel', enabled:false,
    trigger:AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE,
    conditions:[{ id:'merchant', field:AUTOMATION_RULE_CONDITION.MERCHANT, operator:'equals', value:'Fictional Fuel' }],
    action:{ type:AUTOMATION_RULE_ACTION.ASSIGN_BUDGET, value:'budget-fuel' },
    explanation:'Assign the fictional fuel merchant to Fuel.',
    activationMode:AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY, activatedAt:null,
    ...overrides
  };
}

test('dry run uses real proposal execution guard without mutating state or revision', async () => {
  let state = stateWithTransactions();
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T11:00:00.000Z'));
  const before = structuredClone(state);
  const preview = await previewStoredAutomationRules(state, { ruleId:'rule_fictional_fuel', now:new Date('2026-08-11T12:00:00.000Z') });
  assert.deepEqual(state, before);
  assert.equal(state.meta.revision, 11);
  assert.equal(Object.keys(state.automation.executions).length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.reviewItems.length, 0);
  assert.equal(preview.nothingChanged, true);
  assert.equal(preview.matchedRecordCount, 1);
  assert.equal(preview.wouldApplyCount, 1);
  assert.equal(preview.items[0].reasonCode, 'preview_only');
});

test('unsaved disabled rule can be tested without persisting it', async () => {
  const state = stateWithTransactions();
  const before = structuredClone(state);
  const preview = await previewStoredAutomationRules(state, { rule:fuelRule({ id:'rule_preview_draft' }), now:new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.matchedRecordCount, 1);
  assert.deepEqual(state, before);
  assert.equal(state.automation.rules.length, 0);
});

test('preview explains conflicts with an active peer rule', async () => {
  let state = stateWithTransactions();
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T10:00:00.000Z'));
  state = upsertAutomationRule(state, fuelRule({ id:'rule_food', name:'Conflicting food rule', enabled:true, action:{ type:AUTOMATION_RULE_ACTION.ASSIGN_BUDGET, value:'budget-food' } }), new Date('2026-08-11T10:05:00.000Z'));
  const before = structuredClone(state);
  const preview = await previewStoredAutomationRules(state, { ruleId:'rule_fictional_fuel', now:new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.conflictCount, 1);
  assert.equal(preview.reviewRequiredCount, 1);
  assert.equal(preview.items[0].status, 'conflict');
  assert.match(preview.items[0].explanation, /leave this item unchanged/i);
  assert.deepEqual(state, before);
});

test('large previews are bounded while keeping full counts', async () => {
  let state = stateWithTransactions(150);
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T11:00:00.000Z'));
  const preview = await previewStoredAutomationRules(state, { ruleId:'rule_fictional_fuel', now:new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.evaluatedCount, 150);
  assert.equal(preview.matchedRecordCount, 150);
  assert.equal(preview.totalDetailCount, 150);
  assert.equal(preview.items.length, 100);
  assert.equal(preview.truncated, true);
  assert.equal(preview.detailLimit, 100);
});

test('activation leaves existing imported records alone and permits later imported matches', async () => {
  let state = stateWithTransactions();
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T11:00:00.000Z'));
  state = setAutomationRuleEnabled(state, 'rule_fictional_fuel', true, new Date('2026-08-11T12:00:00.000Z'));
  assert.equal(state.automation.rules[0].activatedAt, '2026-08-11T12:00:00.000Z');
  let result = await runStoredAutomationRules(state, { now:new Date('2026-08-11T12:10:00.000Z'), recoveryMode:'normal' });
  assert.equal(result.changed, false);
  assert.equal(result.state.transactions[0].budgetCategoryId, '');

  state = result.state;
  state.transactions.push({ id:'tx-new', accountId:'account-main', date:'2026-08-01', merchantName:'Fictional Fuel', description:'Fictional Fuel', outgoing:40, incoming:0, category:'', budgetCategoryId:'', categorySource:'imported', financiallyActive:true, sourceDocumentId:'doc-new' });
  state.documents.push({ id:'doc-new', importedAt:'2026-08-11T12:30:00.000Z' });
  result = await runStoredAutomationRules(state, { now:new Date('2026-08-11T12:35:00.000Z'), recoveryMode:'normal' });
  assert.equal(result.changed, true);
  assert.equal(result.state.transactions.find((tx)=>tx.id === 'tx-1').budgetCategoryId, '');
  assert.equal(result.state.transactions.find((tx)=>tx.id === 'tx-new').budgetCategoryId, 'budget-fuel');
});

test('recovery-mode preview is read-only and reports the block', async () => {
  let state = stateWithTransactions();
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T11:00:00.000Z'));
  const before = structuredClone(state);
  const preview = await previewStoredAutomationRules(state, { ruleId:'rule_fictional_fuel', recoveryMode:'recovery_required', now:new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.blockedCount, 1);
  assert.equal(preview.items[0].reasonCode, 'recovery_mode_active');
  assert.deepEqual(state, before);
});

test('retrospective application remains unavailable and separate from preview', async () => {
  let state = stateWithTransactions();
  state = upsertAutomationRule(state, fuelRule(), new Date('2026-08-11T11:00:00.000Z'));
  const preview = await previewStoredAutomationRules(state, { ruleId:'rule_fictional_fuel', now:new Date('2026-08-11T12:00:00.000Z') });
  assert.equal(preview.retrospective.supported, false);
  assert.equal(preview.retrospective.automatic, false);
  assert.equal(preview.retrospective.requiresSeparateConfirmation, true);
});
