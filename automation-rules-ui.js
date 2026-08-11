import {
  AUTOMATION_RULE_ACTION, AUTOMATION_RULE_ACTIVATION, AUTOMATION_RULE_CONDITION, AUTOMATION_RULE_TRIGGER,
  actionLabel, conditionLabel, duplicateAutomationRule, normaliseAutomationRuleState,
  removeAutomationRule, setAutomationRuleEnabled, upsertAutomationRule
} from './automation-rule-model.js';

const PREVIEW_PAGE_SIZE = 20;
let state = null;
let editId = '';
let draft = null;
let lastCycleSignature = '';
let cycleRunning = false;
let runSummary = null;
let previewState = null;
let previewVisibleCount = PREVIEW_PAGE_SIZE;

export function renderAutomationRulesPanel(nextState) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  state = nextState;
  render();
  scheduleCycle();
}

function render() {
  const grid = document.querySelector('#view-settings .settings-grid');
  if (!grid || !state) return;
  let panel = document.getElementById('automationRulesSettings');
  if (!panel) {
    panel = document.createElement('article');
    panel.id = 'automationRulesSettings';
    panel.className = 'panel';
    grid.append(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('submit', onSubmit);
  }
  panel.replaceChildren();

  const automation = normaliseAutomationRuleState(state.automation);
  panel.append(heading(automation), statusLine(automation), buttonRow(button('Create rule', 'primary-button', { automationCreate: 'true' })));

  const list = el('div', 'compact-card-list');
  if (!automation.rules.length) list.append(el('p', 'muted', 'No rules yet. Start with one clear trigger, one or more conditions, and one approved local action.'));
  for (const rule of automation.rules) list.append(ruleCard(rule));
  panel.append(list);
  if (draft) panel.append(ruleForm());
  if (previewState) panel.append(previewPanel());
}

function heading(automation) {
  const wrapper = el('div', 'panel-heading');
  const copy = el('div');
  copy.append(el('p', 'eyebrow', 'LOCAL AUTOMATION'), el('h2', '', 'Simple rules'),
    el('p', 'muted', 'Build small “When… If… Then…” rules. Test them locally before activation. New and materially changed rules start paused and only affect future matching activity once enabled.'));
  const label = el('label', 'confirmation-check');
  const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = automation.enabled; toggle.dataset.automationGlobal = 'true';
  label.append(toggle, document.createTextNode(automation.enabled ? 'Automations enabled' : 'Automations paused'));
  wrapper.append(copy, label);
  return wrapper;
}

function statusLine(automation) {
  const output = el('p', 'muted'); output.id = 'automationRulesStatus'; output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite');
  if (!automation.enabled) output.textContent = 'Paused. Rules can still be edited and tested, but automatic changes are blocked.';
  else if (runSummary?.conflicts) output.textContent = `${runSummary.conflicts} conflicting rule decision${runSummary.conflicts === 1 ? '' : 's'} need review. No conflicting category was applied.`;
  else if (runSummary?.applied) output.textContent = `${runSummary.applied} safe local automation change${runSummary.applied === 1 ? '' : 's'} applied.`;
  return output;
}

function ruleCard(rule) {
  const card = el('article', 'review-card');
  const head = el('div', 'review-card-heading');
  const copy = el('div'); copy.append(el('strong', '', rule.name), el('span', 'muted', rule.explanation));
  head.append(copy, el('span', 'badge', rule.enabled ? 'Enabled' : 'Paused')); card.append(head);
  card.append(el('p', 'muted', `${triggerLabel(rule.trigger)} · ${rule.conditions.map(conditionLabel).join(' · ')} · ${actionLabel(rule.action)}`));
  if (rule.activationMode === AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY) {
    card.append(el('p', 'muted', rule.enabled && rule.activatedAt
      ? `Future activity only · enabled ${formatLocalDateTime(rule.activatedAt)}`
      : 'Future activity only when enabled · existing records will not be rewritten automatically.'));
  }
  card.append(buttonRow(
    button('Edit', 'secondary-button', { automationEdit: rule.id }),
    button('Test Rule', 'secondary-button', { automationPreview: rule.id }),
    button(rule.enabled ? 'Pause rule' : 'Enable rule', 'secondary-button', { automationToggle: rule.id }),
    button('Duplicate', 'secondary-button', { automationDuplicate: rule.id }),
    button('Delete', 'danger-button', { automationDelete: rule.id })
  ));
  return card;
}

function ruleForm() {
  const form = el('form', 'form-grid'); form.id = 'automationRuleForm';
  form.append(el('h3', 'wide-field', editId ? 'Edit rule' : 'Create rule'));
  form.append(field('Rule name', input('ruleName', draft.name, 'text', true)));
  form.append(field('When…', select('ruleTrigger', [
    ['transaction_change', 'A payment is added or changed'],
    ['date_boundary', 'A confirmed recurring item reaches a relative date']
  ], draft.trigger)));

  const conditions = el('div', 'wide-field'); conditions.append(el('strong', '', 'If…'));
  draft.conditions.forEach((condition, index) => conditions.append(conditionRow(condition, index)));
  conditions.append(button('Add condition', 'secondary-button', { conditionAdd: 'true' })); form.append(conditions);

  form.append(field('Then…', select('ruleAction', actionOptions(draft.trigger), draft.action.type)));
  form.append(field('Action value', actionValueInput(draft.action)));
  const why = field('Why this rule exists', input('ruleExplanation', draft.explanation || '', 'text', false)); why.classList.add('wide-field'); form.append(why);
  const note = el('p', 'muted', 'Test Rule is read-only. New rules and edits that change matching or actions are saved paused; enabling them later affects future matching activity only.');
  note.classList.add('wide-field'); form.append(note);
  const actions = buttonRow(
    button('Test Rule', 'secondary-button', { automationDraftPreview: 'true' }),
    button(editId ? 'Save rule' : 'Create rule', 'primary-button', {}, 'submit'),
    button('Cancel', 'secondary-button', { automationCancel: 'true' })
  );
  actions.classList.add('wide-field'); form.append(actions);
  return form;
}

function conditionRow(condition, index) {
  const row = el('div', 'review-card'); row.dataset.conditionIndex = String(index);
  row.append(field('Condition', select(`conditionField${index}`, conditionOptions(), condition.field)));
  row.append(field('Match', select(`conditionOperator${index}`, operatorOptions(condition.field), condition.operator)));
  row.append(field('Value', conditionValueInput(condition, index, 'value')));
  if (condition.operator === 'between' && numericCondition(condition.field)) row.append(field('To', conditionValueInput(condition, index, 'value2')));
  if (draft.conditions.length > 1) row.append(button('Remove condition', 'secondary-button', { conditionRemove: String(index) }));
  return row;
}

function previewPanel() {
  const wrapper = el('section', 'review-card');
  wrapper.setAttribute('aria-label', 'Test Rule preview');
  const result = previewState.result;
  wrapper.append(el('p', 'eyebrow', 'TEST RULE · LOCAL DRY RUN'), el('h3', '', 'Preview before activation'));
  const unchanged = el('p', '', result.unchangedMessage || 'Preview only — nothing has been changed.');
  unchanged.setAttribute('role', 'status'); wrapper.append(unchanged);
  wrapper.append(el('p', 'muted', `${result.evaluatedCount} existing record${result.evaluatedCount === 1 ? '' : 's'} evaluated · ${result.matchedRecordCount} matched · ${result.wouldApplyCount} would apply · ${result.reviewRequiredCount} need review · ${result.blockedCount} blocked.`));
  wrapper.append(el('p', 'muted', result.existingImpact?.message || 'Existing data was checked locally.'));
  wrapper.append(el('p', 'muted', result.futureImpact?.message || 'After activation, future matching activity is handled by this rule.'));
  wrapper.append(el('p', 'muted', result.retrospective?.message || 'Existing records are never changed automatically by this preview.'));

  if (result.truncated) {
    wrapper.append(el('p', 'muted', `This rule has a large preview. Details are capped at the first ${result.detailLimit} outcomes; narrow the rule to inspect a smaller set.`));
  }

  const details = el('div', 'compact-card-list');
  const visible = (result.items || []).slice(0, previewVisibleCount);
  if (!visible.length) details.append(el('p', 'muted', 'No matching outcomes to show.'));
  for (const item of visible) details.append(previewOutcomeCard(item));
  wrapper.append(details);

  const actions = [];
  if (previewVisibleCount < (result.items || []).length) actions.push(button('Show 20 more', 'secondary-button', { automationPreviewMore: 'true' }));
  if (previewState.activationIntent && previewState.ruleId && !rules().find((rule) => rule.id === previewState.ruleId)?.enabled) {
    actions.push(button('Enable for future activity', 'primary-button', { automationActivate: previewState.ruleId }));
  }
  actions.push(button('Close preview', 'secondary-button', { automationPreviewClose: 'true' }));
  wrapper.append(buttonRow(...actions));
  return wrapper;
}

function previewOutcomeCard(item) {
  const card = el('article', 'review-card');
  const head = el('div', 'review-card-heading');
  const copy = el('div'); copy.append(el('strong', '', previewSourceLabel(item)), el('span', 'muted', item.actionLabel || 'Automation action'));
  head.append(copy, el('span', 'badge', previewStatusLabel(item.status))); card.append(head);
  card.append(el('p', 'muted', item.explanation || previewReasonLabel(item.reasonCode)));
  return card;
}

async function onClick(event) {
  const target = event.target;
  if (target.closest('[data-automation-create]')) { editId = ''; draft = blankRule(); clearPreview(); render(); return; }
  if (target.closest('[data-automation-cancel]')) { editId = ''; draft = null; clearPreview(); render(); return; }
  if (target.closest('[data-automation-preview-close]')) { clearPreview(); render(); return; }
  if (target.closest('[data-automation-preview-more]')) { previewVisibleCount += PREVIEW_PAGE_SIZE; render(); return; }
  const edit = target.closest('[data-automation-edit]');
  if (edit) { const rule = rules().find((item) => item.id === edit.dataset.automationEdit); if (rule) { editId = rule.id; draft = structuredClone(rule); clearPreview(); render(); } return; }
  const add = target.closest('[data-condition-add]');
  if (add) { captureDraft(); if (draft.conditions.length < 8) draft.conditions.push(defaultCondition(draft.trigger)); clearPreview(); render(); return; }
  const removeCondition = target.closest('[data-condition-remove]');
  if (removeCondition) { captureDraft(); draft.conditions.splice(Number(removeCondition.dataset.conditionRemove), 1); clearPreview(); render(); return; }
  const draftPreview = target.closest('[data-automation-draft-preview]');
  if (draftPreview) { captureDraft(); await previewDraftRule(); return; }
  const toggle = target.closest('[data-automation-toggle]');
  if (toggle) {
    const rule = rules().find((item) => item.id === toggle.dataset.automationToggle);
    if (!rule) return;
    if (rule.enabled) {
      clearPreview();
      await persist(setAutomationRuleEnabled(state, rule.id, false), 'Rule paused. Existing financial history was left unchanged.');
    } else {
      await previewRule(rule.id, { activationIntent: true });
    }
    return;
  }
  const activate = target.closest('[data-automation-activate]');
  if (activate) { await activatePreviewedRule(activate.dataset.automationActivate); return; }
  const duplicate = target.closest('[data-automation-duplicate]');
  if (duplicate) { clearPreview(); await persist(duplicateAutomationRule(state, duplicate.dataset.automationDuplicate, createRuleId()), 'Rule duplicated in a paused state. Test it before enabling it.'); return; }
  const remove = target.closest('[data-automation-delete]');
  if (remove) { const rule = rules().find((item) => item.id === remove.dataset.automationDelete); if (rule && window.confirm(`Delete “${rule.name}”? Existing financial history will not be reversed.`)) { clearPreview(); await persist(removeAutomationRule(state, rule.id), 'Rule deleted. Existing history was left unchanged.'); } return; }
  const preview = target.closest('[data-automation-preview]');
  if (preview) await previewRule(preview.dataset.automationPreview);
}

async function onChange(event) {
  if (event.target.matches('[data-automation-global]')) {
    const next = structuredClone(state); next.automation = normaliseAutomationRuleState(next.automation); next.automation.enabled = event.target.checked;
    clearPreview(); await persist(next, event.target.checked ? 'Automations enabled.' : 'All automations paused.'); return;
  }
  if (!draft) return;
  clearPreview();
  if (event.target.id === 'ruleTrigger') {
    captureDraft(); draft.trigger = event.target.value;
    if (draft.trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY) {
      draft.action = { type: AUTOMATION_RULE_ACTION.CREATE_REMINDER, value: draft.action.type === AUTOMATION_RULE_ACTION.CREATE_REMINDER ? draft.action.value : '' };
      if (!draft.conditions.some((item) => item.field === AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE)) draft.conditions.push(defaultCondition(draft.trigger));
    }
    render(); return;
  }
  if (event.target.id === 'ruleAction') {
    captureDraft(); draft.action = { type: event.target.value, value: '' }; render(); return;
  }
  if (/^condition(Field|Operator)/.test(event.target.id)) {
    captureDraft();
    const row = event.target.closest('[data-condition-index]'); const index = Number(row?.dataset.conditionIndex);
    if (event.target.id.startsWith('conditionField')) draft.conditions[index] = defaultConditionForField(event.target.value, draft.conditions[index]?.id);
    render();
  }
}

async function onSubmit(event) {
  if (event.target.id !== 'automationRuleForm') return;
  event.preventDefault(); captureDraft();
  const existing = rules().find((item) => item.id === editId);
  const materialChanged = !existing || materialRuleChanged(existing, draft);
  try {
    const next = upsertAutomationRule(state, {
      ...(existing || {}),
      ...draft,
      id: existing?.id || createRuleId(),
      enabled: materialChanged ? false : existing.enabled,
      activationMode: materialChanged ? AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY : existing.activationMode,
      activatedAt: materialChanged ? null : existing.activatedAt
    });
    editId = ''; draft = null; clearPreview();
    const message = !existing
      ? 'Rule created in a paused state. Test it, then enable it for future activity.'
      : materialChanged
        ? 'Rule saved and paused because its matching or action changed. Test it before enabling it again.'
        : 'Rule saved.';
    await persist(next, message);
  } catch (error) { setStatus(error?.message || 'That rule could not be saved.'); }
}

function captureDraft() {
  const form = document.getElementById('automationRuleForm'); if (!form || !draft) return;
  draft.name = document.getElementById('ruleName')?.value || '';
  draft.trigger = document.getElementById('ruleTrigger')?.value || draft.trigger;
  draft.action = { type: document.getElementById('ruleAction')?.value || draft.action.type, value: document.getElementById('ruleActionValue')?.value || '' };
  draft.explanation = document.getElementById('ruleExplanation')?.value || '';
  draft.conditions = [...document.querySelectorAll('[data-condition-index]')].map((row, index) => {
    const fieldName = document.getElementById(`conditionField${index}`)?.value || draft.conditions[index]?.field;
    const operator = document.getElementById(`conditionOperator${index}`)?.value || 'equals';
    const value = document.getElementById(`conditionValue${index}`)?.value ?? '';
    const value2 = document.getElementById(`conditionValue2${index}`)?.value ?? null;
    return { id: draft.conditions[index]?.id || createConditionId(), field: fieldName, operator, value, value2 };
  });
}

async function previewDraftRule() {
  const existing = rules().find((item) => item.id === editId);
  const candidate = {
    ...(existing || {}), ...structuredClone(draft),
    id: existing?.id || 'rule_preview_draft',
    enabled: false,
    activationMode: AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY,
    activatedAt: null
  };
  await previewRule(candidate.id, { rule: candidate, activationIntent: false });
}

async function previewRule(ruleId, options = {}) {
  if (!window.financeAPI?.previewAutomationRules) { setStatus('Test Rule is available in the desktop app. No data was sent anywhere.'); return; }
  setStatus('Testing this rule locally…');
  try {
    const result = await window.financeAPI.previewAutomationRules(state, {
      ruleId,
      rule: options.rule || null,
      now: new Date().toISOString()
    });
    previewState = { ruleId, result, activationIntent: options.activationIntent === true };
    previewVisibleCount = PREVIEW_PAGE_SIZE;
    render();
    setStatus(`${result.matchedRecordCount} existing record${result.matchedRecordCount === 1 ? '' : 's'} matched. Preview only — nothing has been changed.`);
  } catch (error) { clearPreview(); render(); setStatus(error?.message || 'The local Test Rule preview could not be completed.'); }
}

async function activatePreviewedRule(ruleId) {
  const rule = rules().find((item) => item.id === ruleId);
  if (!rule || rule.enabled || previewState?.ruleId !== ruleId || !previewState?.result?.nothingChanged) return;
  const matches = Number(previewState.result.matchedRecordCount || 0);
  const confirmed = window.confirm(`Enable “${rule.name}” for future matching activity? ${matches} existing matching record${matches === 1 ? '' : 's'} shown by Test Rule will not be changed. Retrospective application is not available in this release.`);
  if (!confirmed) { setStatus('Activation cancelled. Nothing was changed.'); return; }
  try {
    const next = setAutomationRuleEnabled(state, rule.id, true, new Date());
    clearPreview();
    await persist(next, 'Rule enabled for future matching activity. Existing records were left unchanged.');
  } catch (error) { setStatus(error?.message || 'The rule could not be enabled safely.'); }
}

async function persist(next, message) {
  try {
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'blocked' || saved?.status === 'conflict') throw new Error(saved.message || 'The rule could not be saved safely.');
    state = saved; runSummary = null; render(); setStatus(message); scheduleCycle();
  } catch (error) { setStatus(error?.message || 'The rule could not be saved.'); }
}

function scheduleCycle() {
  if (!state || !window.financeAPI?.runAutomationRules || !window.financeAPI?.saveState || cycleRunning) return;
  const automation = normaliseAutomationRuleState(state.automation);
  if (!automation.enabled || !automation.rules.some((rule) => rule.enabled)) return;
  const signature = `${state.meta?.revision ?? 0}:${automation.rules.map((rule) => `${rule.id}:${rule.enabled}:${rule.updatedAt || ''}:${rule.activatedAt || ''}`).join('|')}`;
  if (signature === lastCycleSignature) return;
  lastCycleSignature = signature; cycleRunning = true; queueMicrotask(runCycle);
}

async function runCycle() {
  try {
    const result = await window.financeAPI.runAutomationRules(state, { now: new Date().toISOString() });
    runSummary = { applied: (result.results || []).filter((row) => row.status === 'applied').length, conflicts: result.conflicts?.length || 0 };
    if (result.changed || result.reviewChanged) {
      const saved = await window.financeAPI.saveState(result.state);
      if (saved?.status === 'blocked' || saved?.status === 'conflict') throw new Error(saved.message || 'Automation could not save safely.');
      state = saved; window.location.reload(); return;
    }
    render();
  } catch (error) { setStatus(error?.message || 'Automatic rules were not applied. Existing financial data was left unchanged.'); }
  finally { cycleRunning = false; }
}

function blankRule() {
  return {
    name: '', enabled: false, trigger: AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE,
    conditions: [defaultCondition(AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE)],
    action: { type: AUTOMATION_RULE_ACTION.ASSIGN_BUDGET, value: '' }, explanation: '',
    activationMode: AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY, activatedAt: null
  };
}
function defaultCondition(trigger) { return trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY ? { id: createConditionId(), field: AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE, operator: 'between', value: 0, value2: 3 } : { id: createConditionId(), field: AUTOMATION_RULE_CONDITION.MERCHANT, operator: 'equals', value: '' }; }
function defaultConditionForField(field, id = createConditionId()) {
  if (field === AUTOMATION_RULE_CONDITION.AMOUNT) return { id, field, operator: 'at_least', value: 0, value2: null };
  if (field === AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE) return { id, field, operator: 'between', value: 0, value2: 3 };
  const defaults = { direction: 'outgoing', recurring_cadence: 'monthly', review_state: 'pending' };
  return { id, field, operator: 'equals', value: defaults[field] || '' };
}
function conditionOptions() { return [['merchant','Merchant / payee'],['purpose','Resolved purpose / budget'],['account','Account'],['direction','Direction'],['amount','Amount'],['recurring_cadence','Recurring cadence'],['review_state','Review state'],['days_until_due','Days until expected recurring date']]; }
function operatorOptions(field) { return numericCondition(field) ? [['equals','Equals'],['at_least','At least'],['at_most','At most'],['between','Between']] : ['merchant','purpose'].includes(field) ? [['equals','Equals'],['contains','Contains']] : [['equals','Equals']]; }
function actionOptions(trigger) { return trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY ? [['create_reminder','Create a local reminder']] : [['assign_budget','Assign a budget/category'],['add_tag','Add a local tag'],['create_reminder','Create a local reminder']]; }
function actionValueInput(action) { return action.type === AUTOMATION_RULE_ACTION.ASSIGN_BUDGET ? select('ruleActionValue', (state.budgets || []).map((item) => [String(item.id), item.category]), action.value) : input('ruleActionValue', action.value || '', 'text', true); }
function conditionValueInput(condition, index, part) {
  const id = part === 'value2' ? `conditionValue2${index}` : `conditionValue${index}`; const value = condition[part] ?? '';
  if (condition.field === 'account') return select(id, (state.accounts || []).map((item) => [String(item.id), item.name]), value);
  if (condition.field === 'purpose') return select(id, (state.budgets || []).map((item) => [String(item.id), item.category]), value);
  if (condition.field === 'direction') return select(id, [['incoming','Incoming'],['outgoing','Outgoing']], value);
  if (condition.field === 'recurring_cadence') return select(id, [['weekly','Weekly'],['fortnightly','Fortnightly'],['four-weekly','Four-weekly'],['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']], value);
  if (condition.field === 'review_state') return select(id, [['none','No review state'],['pending','Pending'],['accepted','Accepted'],['rejected','Rejected'],['in_progress','In progress'],['snoozed','Snoozed']], value);
  return input(id, value, numericCondition(condition.field) ? 'number' : 'text', true);
}
function materialRuleChanged(existing, nextDraft) {
  return JSON.stringify(materialRuleSignature(existing)) !== JSON.stringify(materialRuleSignature(nextDraft));
}
function materialRuleSignature(rule) {
  return {
    trigger: rule?.trigger || '',
    conditions: (rule?.conditions || []).map((condition) => ({
      id: condition?.id || '',
      field: condition?.field || '',
      operator: condition?.operator || 'equals',
      value: normaliseConditionComparisonValue(condition?.field, condition?.value),
      value2: normaliseConditionComparisonValue(condition?.field, condition?.value2)
    })),
    action: { type: rule?.action?.type || '', value: String(rule?.action?.value ?? '') }
  };
}
function normaliseConditionComparisonValue(field, value) {
  if (value === '' || value === null || value === undefined) return null;
  if (numericCondition(field)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : String(value);
  }
  return String(value);
}
function previewSourceLabel(item) {
  if (item.sourceType !== 'transaction') return `Recurring item · ${item.sourceId}`;
  const transaction = (state.transactions || []).find((entry) => String(entry.id) === String(item.sourceId));
  if (!transaction) return `Payment · ${item.sourceId}`;
  const label = transaction.merchantName || transaction.payee || transaction.userDescription || transaction.description || 'Payment';
  const amount = Number(transaction.incoming || 0) > 0 ? Number(transaction.incoming) : Number(transaction.outgoing || 0);
  const amountText = Number.isFinite(amount) && amount ? ` · ${amount.toFixed(2)}` : '';
  return `${transaction.date || 'No date'} · ${label}${amountText}`;
}
function previewStatusLabel(status) {
  if (status === 'would_apply') return 'Would apply';
  if (status === 'conflict') return 'Conflict';
  if (status === 'review_required') return 'Needs review';
  if (status === 'blocked') return 'Blocked';
  if (status === 'already_applied') return 'Already applied';
  return 'Skipped';
}
function previewReasonLabel(reason) { return String(reason || 'preview').replace(/_/g, ' '); }
function clearPreview() { previewState = null; previewVisibleCount = PREVIEW_PAGE_SIZE; }
function formatLocalDateTime(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'recently' : date.toLocaleString(); }
function numericCondition(field) { return [AUTOMATION_RULE_CONDITION.AMOUNT, AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE].includes(field); }
function rules() { return normaliseAutomationRuleState(state.automation).rules; }
function triggerLabel(trigger) { return trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY ? 'When: recurring date' : 'When: payment changes'; }
function createRuleId() { const value = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`; return `rule_${String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '_')}`.slice(0, 120); }
function createConditionId() { return `condition_${Math.random().toString(36).slice(2, 10)}`; }
function setStatus(message) { const line = document.getElementById('automationRulesStatus'); if (line) line.textContent = message; }
function buttonRow(...buttons) { const row = el('div', 'inline-actions'); row.append(...buttons); return row; }
function button(text, className, data = {}, type = 'button') { const output = el('button', className, text); output.type = type; for (const [key, value] of Object.entries(data)) output.dataset[key] = value; return output; }
function field(text, control) { const label = el('label'); label.append(document.createTextNode(text), control); return label; }
function input(id, value, type, required) { const output = document.createElement('input'); output.id = id; output.type = type; output.value = value ?? ''; output.required = Boolean(required); if (type === 'number') output.step = '0.01'; return output; }
function select(id, options, value) { const output = document.createElement('select'); output.id = id; for (const [key, text] of options) { const option = document.createElement('option'); option.value = key; option.textContent = text; output.append(option); } output.value = value ?? ''; return output; }
function el(tag, className = '', text = '') { const output = document.createElement(tag); if (className) output.className = className; if (text) output.textContent = text; return output; }
