import { normaliseAutomationState } from './automation-state.js';
import { deriveRecurringPatterns, RECURRING_CONFIDENCE } from './recurring-finance.js';

const AUTOMATION_EXECUTION_STATUS = Object.freeze({
  APPLIED: 'applied',
  ALREADY_APPLIED: 'already_applied',
  BLOCKED: 'blocked',
  REVIEW_REQUIRED: 'review_required'
});

const AUTOMATION_REASON = Object.freeze({
  APPLIED: 'applied',
  MANUAL_OVERRIDE: 'manual_override',
  REVIEW_REQUIRED: 'review_required',
  SOURCE_INFORMATION_MISSING: 'source_information_missing',
  SOURCE_INFORMATION_CONFLICTING: 'source_information_conflicting',
  FINANCIAL_SAFETY_REQUIRED: 'financial_safety_required',
  FINANCIAL_SAFETY_BLOCKED: 'financial_safety_blocked'
});

export const AUTOMATION_REVIEW_TYPE = Object.freeze({
  RULE_CONFLICT: 'automation_rule_conflict',
  ENGINE_ATTENTION: 'automation_attention',
  RECURRING_CONFIRMATION: 'recurring_pattern_confirmation'
});

const ENGINE_REVIEW_REASONS = new Set([
  AUTOMATION_REASON.REVIEW_REQUIRED,
  AUTOMATION_REASON.SOURCE_INFORMATION_MISSING,
  AUTOMATION_REASON.SOURCE_INFORMATION_CONFLICTING,
  AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED,
  AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED
]);

const RESOLUTION_STATUSES = new Set([
  AUTOMATION_EXECUTION_STATUS.APPLIED,
  AUTOMATION_EXECUTION_STATUS.ALREADY_APPLIED
]);

export function synchroniseAutomationReviewSignals(state, input = {}, now = new Date()) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationState(next.automation);
  const before = JSON.stringify(next.automation.reviewSignals);
  const signals = { ...next.automation.reviewSignals };
  const timestamp = validDate(now).toISOString();
  const activeConflictIds = new Set();

  for (const conflict of input.conflicts || []) {
    const id = signalId('rule_conflict', conflict?.source?.type, conflict?.source?.id, conflict?.actionType);
    activeConflictIds.add(id);
    const existing = signals[id];
    signals[id] = {
      id,
      kind: 'rule_conflict',
      sourceType: safeCode(conflict?.source?.type, 'state'),
      sourceId: safeSourceId(conflict?.source?.id),
      actionType: safeCode(conflict?.actionType, 'unknown_action'),
      ruleIds: safeRuleIds(conflict?.ruleIds),
      reasonCode: 'rule_conflict',
      priority: 'high',
      dueAt: null,
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp
    };
  }

  for (const [id, signal] of Object.entries(signals)) {
    if (signal.kind === 'rule_conflict' && !activeConflictIds.has(id)) delete signals[id];
  }

  for (const result of input.results || []) {
    if (result?.reasonCode === 'rule_conflict') continue;
    const id = signalId('engine_review', result?.sourceType, result?.sourceId, result?.actionType, result?.ruleId);
    if (reviewableEngineResult(result)) {
      const existing = signals[id];
      signals[id] = {
        id,
        kind: 'engine_review',
        sourceType: safeCode(result?.sourceType, 'state'),
        sourceId: safeSourceId(result?.sourceId),
        actionType: safeCode(result?.actionType, 'unknown_action'),
        ruleIds: safeRuleIds([result?.ruleId]),
        reasonCode: safeCode(result?.reasonCode, AUTOMATION_REASON.REVIEW_REQUIRED),
        priority: financialSafetyReason(result?.reasonCode) ? 'high' : 'normal',
        dueAt: validIso(result?.dueAt) ? result.dueAt : null,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp
      };
      continue;
    }
    if (RESOLUTION_STATUSES.has(result?.status) || result?.reasonCode === AUTOMATION_REASON.MANUAL_OVERRIDE) delete signals[id];
  }

  next.automation.reviewSignals = signals;
  next.automation = normaliseAutomationState(next.automation);
  return { state: next, changed: before !== JSON.stringify(next.automation.reviewSignals) };
}

export function automationReviewSources(state, now = new Date()) {
  const automation = normaliseAutomationState(state?.automation);
  const signalSources = Object.values(automation.reviewSignals)
    .filter((signal) => automationSignalStillRelevant(state, signal))
    .map((signal) => ({
      type: signal.kind === 'rule_conflict' ? AUTOMATION_REVIEW_TYPE.RULE_CONFLICT : AUTOMATION_REVIEW_TYPE.ENGINE_ATTENTION,
      priority: signal.priority,
      sourceType: 'automation_review',
      sourceId: signal.id,
      conditionKey: [signal.reasonCode, signal.actionType, ...signal.ruleIds].join('|')
    }));

  const recurringSources = deriveRecurringPatterns(state || {}, { includeRejected: false })
    .filter((pattern) => pattern.confirmationState === 'unconfirmed'
      && [RECURRING_CONFIDENCE.LIKELY, RECURRING_CONFIDENCE.UNCERTAIN].includes(pattern.confidence))
    .map((pattern) => ({
      type: AUTOMATION_REVIEW_TYPE.RECURRING_CONFIRMATION,
      priority: pattern.confidence === RECURRING_CONFIDENCE.LIKELY ? 'normal' : 'low',
      sourceType: 'recurring_pattern',
      sourceId: pattern.id,
      conditionKey: pattern.evidenceFingerprint
    }));

  return [...signalSources, ...recurringSources]
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
      || left.type.localeCompare(right.type) || left.sourceId.localeCompare(right.sourceId));
}

export function automationReviewPresentation(state, item) {
  if (!item) return null;
  if (item.type === AUTOMATION_REVIEW_TYPE.RECURRING_CONFIRMATION) {
    const pattern = recurringPattern(state, item.sourceId);
    return pattern ? {
      title: 'Confirm recurring pattern',
      detail: `${pattern.label} looks ${pattern.confidence} as a ${plainText(pattern.cadence)} pattern. OneStep will not rely on it as confirmed until the evidence is strong enough or you confirm it.`,
      why: pattern.why,
      action: 'Confirm pattern',
      consequence: 'Confirming or rejecting the underlying pattern clears this review work automatically.'
    } : sourceResolvedPresentation();
  }

  const signal = automationSignal(state, item.sourceId);
  if (!signal) return sourceResolvedPresentation();
  if (item.type === AUTOMATION_REVIEW_TYPE.RULE_CONFLICT) {
    const names = ruleNames(state, signal.ruleIds);
    return {
      title: 'Automation rules disagree',
      detail: names.length ? `${names.join(' and ')} want different categories for the same payment.` : 'Two local rules want different categories for the same payment.',
      why: 'OneStep blocks conflicting automatic changes rather than guessing which rule should win.',
      action: 'Fix rules',
      consequence: 'The payment remains unchanged until the conflicting rules no longer disagree.'
    };
  }

  return {
    title: financialSafetyReason(signal.reasonCode) ? 'Automation blocked by Financial Safety' : 'Automation needs review',
    detail: engineReasonText(signal.reasonCode),
    why: 'The local automation engine stopped before changing financial state because its safety or certainty contract was not satisfied.',
    action: signal.sourceType === 'transaction' ? 'Review payment' : 'Review automation',
    consequence: 'The automatic action remains blocked until the underlying source information or safety condition is resolved.'
  };
}

export function automationReviewRoute(state, item) {
  let route;
  if (item?.type === AUTOMATION_REVIEW_TYPE.RECURRING_CONFIRMATION) {
    route = { view: 'transactions', type: 'recurring_pattern', id: item.sourceId };
  } else {
    const signal = automationSignal(state, item?.sourceId);
    if (item?.type === AUTOMATION_REVIEW_TYPE.RULE_CONFLICT) {
      route = { view: 'settings', type: 'automation_rules', id: signal?.ruleIds?.[0] || null };
    } else if (signal?.sourceType === 'transaction' && signal.sourceId) {
      route = { view: 'transactions', type: 'transaction', id: signal.sourceId };
    } else {
      route = { view: 'settings', type: 'automation_rules', id: signal?.ruleIds?.[0] || null };
    }
  }
  prepareDirectWorkflowRoute(state, route);
  return route;
}

export function automationReviewSourceActive(state, item, now = new Date()) {
  return automationReviewSources(state, now).some((source) => source.type === item?.type
    && source.sourceType === item?.sourceType && String(source.sourceId) === String(item?.sourceId));
}

export function automationReviewPrioritySource(state, item) {
  if (item?.type === AUTOMATION_REVIEW_TYPE.RECURRING_CONFIRMATION || item?.sourceType === 'recurring_pattern') {
    const pattern = recurringPattern(state, item?.sourceId);
    if (!pattern) return null;
    return {
      priority: item?.priority || (pattern.confidence === RECURRING_CONFIDENCE.LIKELY ? 'normal' : 'low'),
      dueAt: pattern.nextExpected?.date || null,
      financialRisk: null,
      blockingSafetyCalculation: false
    };
  }

  const signal = automationSignal(state, item?.sourceId);
  if (!signal || !automationSignalStillRelevant(state, signal)) return null;
  const blocksFinancialSafety = financialSafetyReason(signal.reasonCode);
  return {
    priority: signal.priority,
    dueAt: signal.dueAt,
    financialRisk: blocksFinancialSafety || signal.kind === 'rule_conflict' ? 'important' : null,
    blockingSafetyCalculation: blocksFinancialSafety
  };
}

export function automationSignal(state, signalIdValue) {
  const automation = normaliseAutomationState(state?.automation);
  return automation.reviewSignals[String(signalIdValue || '')] || null;
}

function recurringPattern(state, patternId) {
  return deriveRecurringPatterns(state || {}, { includeRejected: true }).find((pattern) => pattern.id === patternId) || null;
}

function automationSignalStillRelevant(state, signal) {
  if (!signal) return false;
  const automation = normaliseAutomationState(state?.automation);
  const enabledRuleIds = new Set(automation.rules.filter((rule) => rule.enabled).map((rule) => rule.id));
  if (signal.ruleIds?.length) {
    const enabledCount = signal.ruleIds.filter((ruleId) => enabledRuleIds.has(ruleId)).length;
    if (signal.kind === 'rule_conflict' && enabledCount < 2) return false;
    if (signal.kind === 'engine_review' && enabledCount === 0) return false;
  }
  if (signal.sourceType === 'transaction') {
    return (state?.transactions || []).some((transaction) => String(transaction?.id) === String(signal.sourceId) && !transaction?.deletedAt);
  }
  if (signal.sourceType === 'recurring_pattern') return Boolean(recurringPattern(state, signal.sourceId));
  return true;
}

function prepareDirectWorkflowRoute(state, route) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  queueMicrotask(async () => {
    try {
      const { renderRecurringActivityPanel } = await import('./recurring-finance-ui.js');
      renderRecurringActivityPanel(state);
      window.setTimeout(() => focusWorkflowRoute(route), 0);
    } catch {
      // Routing still lands on the correct existing view if an optional panel cannot render.
    }
  });
}

function focusWorkflowRoute(route) {
  if (route?.type === 'automation_rules') {
    const editButton = [...document.querySelectorAll('[data-automation-edit]')]
      .find((element) => element.dataset.automationEdit === String(route.id || ''));
    const panel = document.getElementById('automationRulesSettings');
    const target = editButton || panel;
    target?.scrollIntoView?.({ block: 'center' });
    target?.focus?.();
    if (editButton) {
      editButton.click();
      window.setTimeout(() => {
        const form = document.getElementById('automationRuleForm');
        form?.scrollIntoView?.({ block: 'center' });
        form?.querySelector?.('input, select, button')?.focus?.();
      }, 0);
    }
    return;
  }
  if (route?.type === 'recurring_pattern') {
    const card = [...document.querySelectorAll('[data-recurring-pattern-id]')]
      .find((element) => element.dataset.recurringPatternId === String(route.id || ''));
    const action = card?.querySelector?.('[data-recurring-decision="confirmed"]') || card?.querySelector?.('button');
    card?.scrollIntoView?.({ block: 'center' });
    action?.focus?.();
  }
}

function reviewableEngineResult(result) {
  if (result?.status === AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED) return true;
  return result?.status === AUTOMATION_EXECUTION_STATUS.BLOCKED && ENGINE_REVIEW_REASONS.has(result?.reasonCode);
}

function financialSafetyReason(reasonCode) {
  return [AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED, AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED].includes(reasonCode);
}

function engineReasonText(reasonCode) {
  const messages = {
    [AUTOMATION_REASON.SOURCE_INFORMATION_MISSING]: 'OneStep needs more source information before this local automation can run safely.',
    [AUTOMATION_REASON.SOURCE_INFORMATION_CONFLICTING]: 'The source information conflicts, so OneStep left this automatic change for review.',
    [AUTOMATION_REASON.FINANCIAL_SAFETY_REQUIRED]: 'Financial Safety needs an authoritative answer before this automatic financial action can continue.',
    [AUTOMATION_REASON.FINANCIAL_SAFETY_BLOCKED]: 'Financial Safety blocked this automatic financial action. The underlying financial position needs review.',
    [AUTOMATION_REASON.REVIEW_REQUIRED]: 'The available information is not certain enough for this local automation to change financial state automatically.'
  };
  return messages[reasonCode] || messages[AUTOMATION_REASON.REVIEW_REQUIRED];
}

function sourceResolvedPresentation() {
  return {
    title: 'Automation review completed',
    detail: 'The underlying source no longer needs review.',
    why: 'Review items follow authoritative source truth.',
    action: 'Review Inbox',
    consequence: 'This item will close automatically.'
  };
}

function ruleNames(state, ids) {
  const wanted = new Set(ids || []);
  return normaliseAutomationState(state?.automation).rules
    .filter((rule) => wanted.has(rule.id))
    .map((rule) => `“${String(rule.name || 'Rule').slice(0, 80)}”`)
    .slice(0, 3);
}

function signalId(kind, sourceType, sourceId, actionType, ruleId = '') {
  return `review_signal_${hashId([kind, safeCode(sourceType, 'state'), safeSourceId(sourceId), safeCode(actionType, 'unknown_action'), safeCode(ruleId, '')].join('|'))}`;
}

function hashId(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${(hash >>> 0).toString(36)}_${String(value).length}`;
}

function safeRuleIds(value) {
  return [...new Set((Array.isArray(value) ? value : []).flatMap((entry) => String(entry || '').split(','))
    .map((entry) => safeCode(entry, '')).filter(Boolean))].sort().slice(0, 8);
}

function safeSourceId(value) { return String(value || 'global').slice(0, 200); }
function safeCode(value, fallback) {
  const output = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
  return output || fallback;
}
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? new Date() : date; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function plainText(value) { return String(value || '').replace(/[-_]+/g, ' '); }
function priorityRank(value) { return ({ high: 0, normal: 1, low: 2 })[value] ?? 3; }
