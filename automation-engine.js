import { createHash } from 'node:crypto';
import { automationEnabled, normaliseAutomationState } from './automation-state.js';

export const AUTOMATION_TRIGGER = Object.freeze({
  STATE_LOAD: 'state_load',
  IMPORT_COMPLETION: 'import_completion',
  TRANSACTION_CHANGE: 'transaction_change',
  DATE_BOUNDARY: 'date_boundary',
  EXPLICIT_TEST: 'explicit_user_test'
});

export const AUTOMATION_SAFETY_CLASS = Object.freeze({
  SAFE_AUTOMATIC: 'safe_automatic',
  REVIEW_REQUIRED: 'review_required',
  BLOCKED: 'blocked'
});

export const AUTOMATION_CERTAINTY = Object.freeze({
  CERTAIN: 'certain',
  AMBIGUOUS: 'ambiguous',
  CONFLICTING: 'conflicting',
  INSUFFICIENT: 'insufficient'
});

export const AUTOMATION_EXECUTION_STATUS = Object.freeze({
  APPLIED: 'applied',
  SKIPPED: 'skipped',
  ALREADY_APPLIED: 'already_applied',
  BLOCKED: 'blocked',
  REVIEW_REQUIRED: 'review_required',
  FAILED: 'failed'
});

export const AUTOMATION_REASON = Object.freeze({
  APPLIED: 'applied',
  AUTOMATION_PAUSED: 'automation_paused',
  RECOVERY_MODE_ACTIVE: 'recovery_mode_active',
  RECOVERY_STATUS_UNKNOWN: 'recovery_status_unknown',
  STALE_STATE_REVISION: 'stale_state_revision',
  MANUAL_OVERRIDE: 'manual_override',
  ALREADY_APPLIED: 'already_applied',
  REVIEW_REQUIRED: 'review_required',
  SOURCE_INFORMATION_MISSING: 'source_information_missing',
  SOURCE_INFORMATION_CONFLICTING: 'source_information_conflicting',
  FINANCIAL_SAFETY_REQUIRED: 'financial_safety_required',
  FINANCIAL_SAFETY_BLOCKED: 'financial_safety_blocked',
  UNSUPPORTED_FINANCIAL_ACTION: 'unsupported_financial_action',
  FORBIDDEN_ACTION: 'forbidden_action',
  HANDLER_MISSING: 'handler_missing',
  HANDLER_FAILED: 'handler_failed',
  PREVIEW_ONLY: 'preview_only'
});

const TRIGGER_TYPES = new Set(Object.values(AUTOMATION_TRIGGER));
const SAFETY_CLASSES = new Set(Object.values(AUTOMATION_SAFETY_CLASS));
const CERTAINTY_CLASSES = new Set(Object.values(AUTOMATION_CERTAINTY));
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const FORBIDDEN_ACTIONS = new Set([
  'transfer_money', 'external_payment', 'borrow_money', 'delete_financial_record', 'delete_document',
  'contact_external_service', 'resolve_review_ambiguity', 'overwrite_manual_category', 'overwrite_manual_budget'
]);

const EXPLANATIONS = Object.freeze({
  [AUTOMATION_REASON.APPLIED]: 'OneStep applied this local automation action.',
  [AUTOMATION_REASON.AUTOMATION_PAUSED]: 'Automations are paused. You can still preview suggestions and use OneStep manually.',
  [AUTOMATION_REASON.RECOVERY_MODE_ACTIVE]: 'Automation is paused while OneStep is protecting or recovering your financial data.',
  [AUTOMATION_REASON.RECOVERY_STATUS_UNKNOWN]: 'OneStep could not confirm that stored financial data is safe to change automatically.',
  [AUTOMATION_REASON.STALE_STATE_REVISION]: 'Your financial information changed before this automation could run. Review the latest state first.',
  [AUTOMATION_REASON.MANUAL_OVERRIDE]: 'A manual choice already exists, so automation left it unchanged.',
  [AUTOMATION_REASON.ALREADY_APPLIED]: 'This automation action was already applied.',
  [AUTOMATION_REASON.REVIEW_REQUIRED]: 'This needs review because the available information is not certain enough for an automatic change.',
  [AUTOMATION_REASON.SOURCE_INFORMATION_MISSING]: 'OneStep does not have enough source information to make this change automatically.',
  [AUTOMATION_REASON.SOURCE_INFORMATION_CONFLICTING]: 'The available source information conflicts, so OneStep left this for review.',
  [AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED]: 'Financial Safety must confirm this action before automation can change financial state.',
  [AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED]: 'Financial Safety blocked this automatic financial action.',
  [AUTOMATION_REASON.UNSUPPORTED_FINANCIAL_ACTION]: 'This type of financial action is not approved for automatic execution.',
  [AUTOMATION_REASON.FORBIDDEN_ACTION]: 'This action is outside OneStep’s approved local automation boundary.',
  [AUTOMATION_REASON.HANDLER_MISSING]: 'OneStep has no approved local executor for this automation action.',
  [AUTOMATION_REASON.HANDLER_FAILED]: 'The automation action could not be completed, so the original financial state was kept.',
  [AUTOMATION_REASON.PREVIEW_ONLY]: 'This was a preview only, so no financial state was changed.'
});

export function createAutomationTrigger(type, details = {}) {
  if (!TRIGGER_TYPES.has(type)) throw new TypeError('Unsupported automation trigger.');
  const sourceType = safeCode(details.sourceType, 'state');
  const sourceId = String(details.sourceId || 'global').slice(0, 200);
  const occurredAt = validIsoDate(details.occurredAt) ? details.occurredAt : null;
  return Object.freeze({ type, sourceType, sourceId, occurredAt });
}

export function evaluateAutomationRules(state, trigger, rules = []) {
  const safeTrigger = normaliseTrigger(trigger);
  const safeState = structuredClone(state || {});
  const expectedRevision = stateRevision(safeState);
  const proposals = [];
  const orderedRules = [...rules].sort((left, right) => safeRuleId(left?.id).localeCompare(safeRuleId(right?.id)));

  for (const rule of orderedRules) {
    const ruleId = safeRuleId(rule?.id);
    if (!ruleId || typeof rule?.propose !== 'function') continue;
    const supportedTriggers = Array.isArray(rule.triggers) ? rule.triggers.filter((type) => TRIGGER_TYPES.has(type)) : [];
    if (supportedTriggers.length && !supportedTriggers.includes(safeTrigger.type)) continue;
    if (!conditionsMatch(rule.conditions, safeState, safeTrigger)) continue;
    const proposed = rule.propose({ state: structuredClone(safeState), trigger: structuredClone(safeTrigger) });
    const rows = Array.isArray(proposed) ? proposed : proposed ? [proposed] : [];
    for (const row of rows) proposals.push(normaliseProposal(row, ruleId, safeTrigger, expectedRevision));
  }

  return proposals.sort((left, right) => left.executionId.localeCompare(right.executionId));
}

export async function executeAutomationProposal(state, proposal, handlers = {}, context = {}) {
  const currentState = structuredClone(state || {});
  const normalised = normaliseProposalForExecution(proposal);
  const guard = executionGuard(currentState, normalised, context);
  if (guard) return { state: currentState, result: guard };

  if (context.previewOnly === true) {
    return { state: currentState, result: executionResult(AUTOMATION_EXECUTION_STATUS.SKIPPED, AUTOMATION_REASON.PREVIEW_ONLY, normalised) };
  }

  const handler = handlerFor(handlers, normalised.action.type);
  if (typeof handler !== 'function') {
    return { state: currentState, result: executionResult(AUTOMATION_EXECUTION_STATUS.SKIPPED, AUTOMATION_REASON.HANDLER_MISSING, normalised) };
  }

  let nextState = structuredClone(currentState);
  try {
    const handled = await handler({ state: nextState, proposal: structuredClone(normalised), trigger: structuredClone(normalised.trigger) });
    if (handled?.state !== undefined) nextState = structuredClone(handled.state);
    if (!isPlainObject(nextState)) throw new TypeError('Automation handlers must return a financial-state object.');
  } catch (error) {
    await recordDiagnostic(context.diagnostics, AUTOMATION_EXECUTION_STATUS.FAILED, AUTOMATION_REASON.HANDLER_FAILED, normalised.safetyClass);
    return {
      state: currentState,
      result: { ...executionResult(AUTOMATION_EXECUTION_STATUS.FAILED, AUTOMATION_REASON.HANDLER_FAILED, normalised), errorCode: safeErrorCode(error) }
    };
  }

  const appliedAt = nowIso(context.now);
  nextState.automation = normaliseAutomationState(nextState.automation);
  nextState.automation.executions[normalised.executionId] = {
    status: 'applied',
    ruleId: normalised.ruleId,
    actionType: normalised.action.type,
    appliedAt,
    reasonCode: AUTOMATION_REASON.APPLIED
  };
  nextState.automation = normaliseAutomationState(nextState.automation);
  await recordDiagnostic(context.diagnostics, AUTOMATION_EXECUTION_STATUS.APPLIED, AUTOMATION_REASON.APPLIED, normalised.safetyClass);
  return { state: nextState, result: { ...executionResult(AUTOMATION_EXECUTION_STATUS.APPLIED, AUTOMATION_REASON.APPLIED, normalised), appliedAt } };
}

export function setAutomationEnabled(state, enabled) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationState(next.automation);
  next.automation.enabled = Boolean(enabled);
  return next;
}

export function recordAutomationManualOverride(state, proposal, now = new Date()) {
  const next = structuredClone(state || {});
  const normalised = normaliseProposalForExecution(proposal);
  next.automation = normaliseAutomationState(next.automation);
  next.automation.manualOverrides[manualOverrideId(normalised)] = {
    setAt: nowIso(now),
    reasonCode: AUTOMATION_REASON.MANUAL_OVERRIDE
  };
  next.automation = normaliseAutomationState(next.automation);
  return next;
}

export function automationExecutionId(input) {
  return stableHash({
    ruleId: safeRuleId(input?.ruleId),
    source: { type: safeCode(input?.source?.type, 'state'), id: String(input?.source?.id || 'global') },
    action: {
      type: safeCode(input?.action?.type, 'unknown_action'),
      key: String(input?.action?.key || ''),
      context: stableIdentityContext(input?.action?.identityContext)
    }
  });
}

function executionGuard(state, proposal, context) {
  if (context.recoveryMode === undefined || context.recoveryMode === null) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.RECOVERY_STATUS_UNKNOWN, proposal);
  }
  if (context.recoveryMode !== 'normal') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.RECOVERY_MODE_ACTIVE, proposal);
  }
  if (proposal.expectedRevision !== stateRevision(state)) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.STALE_STATE_REVISION, proposal);
  }
  if (!automationEnabled(state)) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.AUTOMATION_PAUSED, proposal);
  }
  const automation = normaliseAutomationState(state.automation);
  if (automation.manualOverrides[manualOverrideId(proposal)]) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.MANUAL_OVERRIDE, proposal);
  }
  if (automation.executions[proposal.executionId]?.status === 'applied') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.ALREADY_APPLIED, AUTOMATION_REASON.ALREADY_APPLIED, proposal);
  }
  if (proposal.sourceStatus === 'missing') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED, AUTOMATION_REASON.SOURCE_INFORMATION_MISSING, proposal);
  }
  if (proposal.sourceStatus === 'conflicting') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED, AUTOMATION_REASON.SOURCE_INFORMATION_CONFLICTING, proposal);
  }
  if (proposal.safetyClass === AUTOMATION_SAFETY_CLASS.BLOCKED) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, proposal.reasonCode || AUTOMATION_REASON.REVIEW_REQUIRED, proposal);
  }
  if (proposal.safetyClass !== AUTOMATION_SAFETY_CLASS.SAFE_AUTOMATIC || proposal.certainty !== AUTOMATION_CERTAINTY.CERTAIN) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED, proposal.reasonCode || AUTOMATION_REASON.REVIEW_REQUIRED, proposal);
  }
  if (forbiddenAction(proposal.action.type)) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.FORBIDDEN_ACTION, proposal);
  }
  return financialSafetyGuard(state, proposal, context);
}

function financialSafetyGuard(state, proposal, context) {
  if (proposal.action.risk !== 'financial') return null;
  if (!proposal.financialSafety) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED, proposal);
  }
  if (proposal.financialSafety.kind !== 'debt_overpayment') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.UNSUPPORTED_FINANCIAL_ACTION, proposal);
  }
  if (typeof context.financialSafetyAssessment !== 'function') {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED, proposal);
  }
  const amount = Number(proposal.financialSafety.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    return executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED, proposal);
  }
  const assessment = context.financialSafetyAssessment(structuredClone(state), amount);
  const safe = assessment?.safeToOverpay === true && Number(assessment.safeExtraPayment || 0) >= amount;
  return safe ? null : executionResult(AUTOMATION_EXECUTION_STATUS.BLOCKED, AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED, proposal);
}

function normaliseProposal(input, ruleId, trigger, expectedRevision) {
  const proposal = isPlainObject(input) ? input : {};
  const source = {
    type: safeCode(proposal.source?.type, 'state'),
    id: String(proposal.source?.id || 'global').slice(0, 240)
  };
  const action = {
    type: safeCode(proposal.action?.type, 'unknown_action'),
    key: String(proposal.action?.key || '').slice(0, 240),
    risk: proposal.action?.risk === 'financial' ? 'financial' : 'housekeeping',
    identityContext: stableIdentityContext(proposal.action?.identityContext),
    payload: structuredClone(proposal.action?.payload ?? null)
  };
  const safetyClass = SAFETY_CLASSES.has(proposal.safetyClass) ? proposal.safetyClass : AUTOMATION_SAFETY_CLASS.REVIEW_REQUIRED;
  const certainty = CERTAINTY_CLASSES.has(proposal.certainty) ? proposal.certainty : AUTOMATION_CERTAINTY.INSUFFICIENT;
  const sourceStatus = ['ready', 'missing', 'conflicting'].includes(proposal.sourceStatus) ? proposal.sourceStatus : 'ready';
  const reasonCode = safeCode(proposal.reasonCode, safetyClass === AUTOMATION_SAFETY_CLASS.SAFE_AUTOMATIC ? 'conditions_met' : AUTOMATION_REASON.REVIEW_REQUIRED);
  const explanation = safeExplanation(proposal.explanation, reasonCode);
  const financialSafety = normaliseFinancialSafety(proposal.financialSafety);
  const base = { ruleId, trigger, source, sourceStatus, action, safetyClass, certainty, reasonCode, explanation, expectedRevision, financialSafety };
  return { ...base, executionId: automationExecutionId(base) };
}

function normaliseProposalForExecution(input) {
  const proposal = isPlainObject(input) ? input : {};
  const trigger = normaliseTrigger(proposal.trigger);
  const expectedRevision = Number.isInteger(proposal.expectedRevision) && proposal.expectedRevision >= 0 ? proposal.expectedRevision : -1;
  return normaliseProposal(proposal, safeRuleId(proposal.ruleId) || 'unknown_rule', trigger, expectedRevision);
}

function normaliseFinancialSafety(value) {
  if (!isPlainObject(value)) return null;
  return {
    kind: safeCode(value.kind, 'unsupported'),
    amount: Number.isFinite(Number(value.amount)) ? Number(value.amount) : null
  };
}

function normaliseTrigger(value) {
  if (TRIGGER_TYPES.has(value?.type)) return createAutomationTrigger(value.type, value);
  throw new TypeError('A valid automation trigger is required.');
}

function conditionsMatch(conditions, state, trigger) {
  const rows = Array.isArray(conditions) ? [...conditions] : [];
  rows.sort((left, right) => safeCode(left?.id, '').localeCompare(safeCode(right?.id, '')));
  return rows.every((condition) => typeof condition?.test === 'function'
    && condition.test({ state: structuredClone(state), trigger: structuredClone(trigger) }) === true);
}

function handlerFor(handlers, actionType) {
  if (handlers instanceof Map) return handlers.get(actionType);
  return isPlainObject(handlers) ? handlers[actionType] : null;
}

function manualOverrideId(proposal) {
  return stableHash({
    ruleId: proposal.ruleId,
    source: proposal.source,
    action: { type: proposal.action.type, key: proposal.action.key }
  });
}

function executionResult(status, reasonCode, proposal) {
  return {
    status,
    reasonCode,
    explanation: EXPLANATIONS[reasonCode] || safeExplanation(proposal.explanation, reasonCode),
    executionId: proposal.executionId,
    safetyClass: proposal.safetyClass,
    certainty: proposal.certainty
  };
}

async function recordDiagnostic(diagnostics, status, reasonCode, safetyClass) {
  if (typeof diagnostics?.record !== 'function') return;
  try {
    await diagnostics.record('AUTOMATION_EXECUTION_RESULT', { status, reasonCode, safetyClass });
  } catch {
    // Diagnostics must never make an otherwise-safe local automation fail.
  }
}

function forbiddenAction(actionType) {
  return FORBIDDEN_ACTIONS.has(actionType)
    || /^(?:external_|network_|cloud_|payment_|borrow_|transfer_)/.test(actionType);
}

function stableIdentityContext(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(stableIdentityContext);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableIdentityContext(value[key])]));
  }
  if (['string', 'number', 'boolean'].includes(typeof value)) return value;
  return String(value);
}

function stableHash(value) {
  return createHash('sha256').update(stableSerialise(value)).digest('hex');
}

function stableSerialise(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialise).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialise(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function stateRevision(state) {
  const revision = Number(state?.meta?.revision);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function safeRuleId(value) {
  return safeCode(value, '');
}

function safeCode(value, fallback) {
  const code = String(value || '').toLowerCase();
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function safeExplanation(value, reasonCode) {
  const known = EXPLANATIONS[reasonCode];
  if (known) return known;
  const text = String(value || '').replace(/[\r\n]+/g, ' ').trim();
  return text.slice(0, 240) || EXPLANATIONS[AUTOMATION_REASON.REVIEW_REQUIRED];
}

function safeErrorCode(error) {
  const code = String(error?.code || '').toLowerCase();
  return SAFE_CODE_PATTERN.test(code) ? code : 'automation_handler_error';
}

function nowIso(value) {
  const candidate = typeof value === 'function' ? value() : value;
  const date = candidate === undefined ? new Date() : new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new TypeError('Automation clock returned an invalid date.');
  return date.toISOString();
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
