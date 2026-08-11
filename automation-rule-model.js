const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const MAX_RULES = 200;
const MAX_CONDITIONS = 8;
const MAX_TEXT = 160;

export const AUTOMATION_RULE_TRIGGER = Object.freeze({
  TRANSACTION_CHANGE: 'transaction_change',
  DATE_BOUNDARY: 'date_boundary'
});

export const AUTOMATION_RULE_CONDITION = Object.freeze({
  MERCHANT: 'merchant',
  PURPOSE: 'purpose',
  ACCOUNT: 'account',
  DIRECTION: 'direction',
  AMOUNT: 'amount',
  RECURRING_CADENCE: 'recurring_cadence',
  REVIEW_STATE: 'review_state',
  DAYS_UNTIL_DUE: 'days_until_due'
});

export const AUTOMATION_RULE_ACTION = Object.freeze({
  ASSIGN_BUDGET: 'assign_budget',
  ADD_TAG: 'add_tag',
  CREATE_REMINDER: 'create_reminder'
});

export const AUTOMATION_RULE_ACTIVATION = Object.freeze({
  LEGACY_EXISTING: 'legacy_existing',
  FUTURE_ONLY: 'future_only'
});

const TRIGGERS = new Set(Object.values(AUTOMATION_RULE_TRIGGER));
const CONDITIONS = new Set(Object.values(AUTOMATION_RULE_CONDITION));
const ACTIONS = new Set(Object.values(AUTOMATION_RULE_ACTION));
const TEXT_OPERATORS = new Set(['equals', 'contains']);
const RANGE_OPERATORS = new Set(['equals', 'at_least', 'at_most', 'between']);

export function normaliseAutomationRuleCollection(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const ids = new Set();
  for (const candidate of value) {
    const checked = validateAutomationRule(candidate);
    if (!checked.valid || ids.has(checked.rule.id)) continue;
    ids.add(checked.rule.id);
    output.push(checked.rule);
    if (output.length >= MAX_RULES) break;
  }
  return output.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

export function validateAutomationRule(input) {
  const errors = [];
  const rule = isPlainObject(input) ? input : {};
  const id = safeId(rule.id);
  if (!id) errors.push('Rule ID is invalid.');
  const name = safeText(rule.name, MAX_TEXT);
  if (!name) errors.push('Give the rule a name.');
  const trigger = TRIGGERS.has(rule.trigger) ? rule.trigger : '';
  if (!trigger) errors.push('Choose a supported When trigger.');

  const conditions = Array.isArray(rule.conditions)
    ? rule.conditions.slice(0, MAX_CONDITIONS).map((condition, index) => normaliseCondition(condition, index, errors)).filter(Boolean)
    : [];
  if (!conditions.length) errors.push('Add at least one If condition.');
  if (trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY && !conditions.some((condition) => condition.field === AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE)) {
    errors.push('Date-relative rules need a days-until-due condition.');
  }

  const action = normaliseAction(rule.action, trigger, errors);
  const explanation = safeText(rule.explanation, 240) || explainRule({ trigger, conditions, action });
  const createdAt = validIso(rule.createdAt) ? rule.createdAt : null;
  const updatedAt = validIso(rule.updatedAt) ? rule.updatedAt : createdAt;
  const activatedAt = validIso(rule.activatedAt) ? rule.activatedAt : null;
  const activationMode = rule.activationMode === AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY || activatedAt
    ? AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY
    : AUTOMATION_RULE_ACTIVATION.LEGACY_EXISTING;
  const enabled = rule.enabled !== false;

  return {
    valid: errors.length === 0,
    errors,
    rule: {
      id: id || '',
      name,
      enabled,
      trigger,
      conditions,
      action,
      explanation,
      activationMode,
      activatedAt,
      createdAt,
      updatedAt
    }
  };
}

export function upsertAutomationRule(state, input, now = new Date()) {
  const checked = validateAutomationRule(input);
  if (!checked.valid) {
    const error = new Error(checked.errors.join(' '));
    error.code = 'AUTOMATION_RULE_INVALID';
    error.validationErrors = checked.errors;
    throw error;
  }
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationRuleState(next.automation);
  const timestamp = validDate(now).toISOString();
  const existingIndex = next.automation.rules.findIndex((rule) => rule.id === checked.rule.id);
  const existing = existingIndex >= 0 ? next.automation.rules[existingIndex] : null;
  const saved = {
    ...checked.rule,
    createdAt: existing?.createdAt || checked.rule.createdAt || timestamp,
    updatedAt: timestamp
  };
  if (existingIndex >= 0) next.automation.rules.splice(existingIndex, 1, saved);
  else {
    if (next.automation.rules.length >= MAX_RULES) throw new Error(`OneStep supports up to ${MAX_RULES} local rules.`);
    next.automation.rules.push(saved);
  }
  next.automation.rules = normaliseAutomationRuleCollection(next.automation.rules);
  return next;
}

export function removeAutomationRule(state, ruleId) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationRuleState(next.automation);
  next.automation.rules = next.automation.rules.filter((rule) => rule.id !== safeId(ruleId));
  return next;
}

export function setAutomationRuleEnabled(state, ruleId, enabled, now = new Date()) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationRuleState(next.automation);
  const rule = next.automation.rules.find((item) => item.id === safeId(ruleId));
  if (!rule) throw new Error('That automation rule is no longer available.');
  const timestamp = validDate(now).toISOString();
  rule.enabled = Boolean(enabled);
  rule.updatedAt = timestamp;
  if (rule.enabled) {
    rule.activationMode = AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY;
    rule.activatedAt = timestamp;
  }
  return next;
}

export function duplicateAutomationRule(state, ruleId, newId, now = new Date()) {
  const source = normaliseAutomationRuleState(state?.automation).rules.find((rule) => rule.id === safeId(ruleId));
  if (!source) throw new Error('That automation rule is no longer available.');
  return upsertAutomationRule(state, {
    ...structuredClone(source),
    id: safeId(newId),
    name: `${source.name} copy`.slice(0, MAX_TEXT),
    enabled: false,
    activationMode: AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY,
    activatedAt: null,
    createdAt: null,
    updatedAt: null
  }, now);
}

export function explainRule(rule) {
  const trigger = rule?.trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY
    ? 'When a confirmed recurring date is reached'
    : 'When a payment is added or changed';
  const conditions = (rule?.conditions || []).map(conditionLabel).filter(Boolean).join(' and ');
  const action = actionLabel(rule?.action);
  return [trigger, conditions ? `if ${conditions}` : '', action ? `then ${action}` : ''].filter(Boolean).join(', ').slice(0, 240);
}

export function conditionLabel(condition) {
  const field = condition?.field;
  const operator = condition?.operator;
  if (field === AUTOMATION_RULE_CONDITION.MERCHANT) return `merchant ${operator === 'contains' ? 'contains' : 'is'} “${condition.value}”`;
  if (field === AUTOMATION_RULE_CONDITION.PURPOSE) return `purpose ${operator === 'contains' ? 'contains' : 'is'} “${condition.value}”`;
  if (field === AUTOMATION_RULE_CONDITION.ACCOUNT) return `account is “${condition.value}”`;
  if (field === AUTOMATION_RULE_CONDITION.DIRECTION) return `money is ${condition.value}`;
  if (field === AUTOMATION_RULE_CONDITION.RECURRING_CADENCE) return `recurring cadence is ${condition.value}`;
  if (field === AUTOMATION_RULE_CONDITION.REVIEW_STATE) return `review state is ${condition.value}`;
  if (field === AUTOMATION_RULE_CONDITION.AMOUNT) return rangeLabel('amount', condition);
  if (field === AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE) return rangeLabel('days until due', condition);
  return '';
}

export function actionLabel(action) {
  if (action?.type === AUTOMATION_RULE_ACTION.ASSIGN_BUDGET) return `assign budget/category “${action.value}”`;
  if (action?.type === AUTOMATION_RULE_ACTION.ADD_TAG) return `add local tag “${action.value}”`;
  if (action?.type === AUTOMATION_RULE_ACTION.CREATE_REMINDER) return `create local reminder “${action.value}”`;
  return '';
}

export function normaliseAutomationRuleState(value) {
  const automation = isPlainObject(value) ? structuredClone(value) : {};
  automation.enabled = automation.enabled !== false;
  automation.rules = normaliseAutomationRuleCollection(automation.rules);
  automation.executions = isPlainObject(automation.executions) ? automation.executions : {};
  automation.manualOverrides = isPlainObject(automation.manualOverrides) ? automation.manualOverrides : {};
  automation.version = Number.isInteger(automation.version) ? automation.version : 1;
  return automation;
}

function normaliseCondition(input, index, errors) {
  if (!isPlainObject(input) || !CONDITIONS.has(input.field)) {
    errors.push(`Condition ${index + 1} is not supported.`);
    return null;
  }
  const field = input.field;
  const id = safeId(input.id) || `condition_${index + 1}`;
  if ([AUTOMATION_RULE_CONDITION.MERCHANT, AUTOMATION_RULE_CONDITION.PURPOSE].includes(field)) {
    const operator = TEXT_OPERATORS.has(input.operator) ? input.operator : 'equals';
    const value = safeText(input.value, MAX_TEXT);
    if (!value) errors.push(`Condition ${index + 1} needs a value.`);
    return { id, field, operator, value };
  }
  if ([AUTOMATION_RULE_CONDITION.AMOUNT, AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE].includes(field)) {
    const operator = RANGE_OPERATORS.has(input.operator) ? input.operator : 'equals';
    const value = finiteOrNull(input.value);
    const value2 = finiteOrNull(input.value2);
    if (value === null) errors.push(`Condition ${index + 1} needs a number.`);
    if (operator === 'between' && value2 === null) errors.push(`Condition ${index + 1} needs both ends of the range.`);
    if (operator === 'between' && value !== null && value2 !== null && value > value2) errors.push(`Condition ${index + 1} range is backwards.`);
    return { id, field, operator, value, value2: operator === 'between' ? value2 : null };
  }
  const allowed = field === AUTOMATION_RULE_CONDITION.DIRECTION ? new Set(['incoming', 'outgoing'])
    : field === AUTOMATION_RULE_CONDITION.RECURRING_CADENCE ? new Set(['weekly', 'fortnightly', 'four-weekly', 'monthly', 'quarterly', 'annual'])
      : field === AUTOMATION_RULE_CONDITION.REVIEW_STATE ? new Set(['none', 'pending', 'accepted', 'rejected', 'in_progress', 'snoozed'])
        : null;
  const value = safeText(input.value, MAX_TEXT);
  if (!value || (allowed && !allowed.has(value))) errors.push(`Condition ${index + 1} has an invalid value.`);
  return { id, field, operator: 'equals', value };
}

function normaliseAction(input, trigger, errors) {
  if (!isPlainObject(input) || !ACTIONS.has(input.type)) {
    errors.push('Choose a supported Then action.');
    return { type: '', value: '' };
  }
  const type = input.type;
  const value = safeText(input.value, MAX_TEXT);
  if (!value) errors.push('The Then action needs a value.');
  if (trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY && type !== AUTOMATION_RULE_ACTION.CREATE_REMINDER) {
    errors.push('Date-relative rules can only create a local reminder in this release.');
  }
  return { type, value };
}

function rangeLabel(label, condition) {
  if (condition.operator === 'between') return `${label} is between ${condition.value} and ${condition.value2}`;
  if (condition.operator === 'at_least') return `${label} is at least ${condition.value}`;
  if (condition.operator === 'at_most') return `${label} is at most ${condition.value}`;
  return `${label} is ${condition.value}`;
}

function safeId(value) {
  const id = String(value || '').trim().toLowerCase();
  return SAFE_ID.test(id) ? id : '';
}
function safeText(value, limit) { return String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, limit); }
function finiteOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
