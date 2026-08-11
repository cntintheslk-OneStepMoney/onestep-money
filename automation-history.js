import { normaliseAutomationState } from './automation-state.js';

export const AUTOMATION_HISTORY_RESULT = Object.freeze({
  APPLIED: 'applied',
  NEEDS_REVIEW: 'needs_review',
  BLOCKED: 'blocked',
  SKIPPED: 'skipped',
  UNDONE: 'undone'
});

export const AUTOMATION_HISTORY_FILTER = Object.freeze({
  ALL: 'all',
  APPLIED: AUTOMATION_HISTORY_RESULT.APPLIED,
  NEEDS_REVIEW: AUTOMATION_HISTORY_RESULT.NEEDS_REVIEW,
  BLOCKED: AUTOMATION_HISTORY_RESULT.BLOCKED,
  UNDONE: AUTOMATION_HISTORY_RESULT.UNDONE
});

const EXECUTION_ID_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const FILTERS = new Set(Object.values(AUTOMATION_HISTORY_FILTER));
const CATEGORY_FIELDS = ['budgetCategoryId', 'category', 'categorySource', 'automationRuleId'];

export function recordAutomationHistoryOutcome(state, input = {}) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationState(next.automation);

  const proposal = input.proposal || null;
  const result = input.result || {};
  const executionId = safeExecutionId(result.executionId || proposal?.executionId);
  const ruleIds = safeRuleIds(result.ruleIds || result.ruleId || proposal?.ruleId);
  const sourceType = safeCode(result.sourceType || proposal?.source?.type, 'state');
  const sourceId = safeSourceId(result.sourceId || proposal?.source?.id);
  const actionType = safeCode(result.actionType || proposal?.action?.type, 'unknown_action');
  const reasonCode = safeCode(result.reasonCode || proposal?.reasonCode, 'unknown_reason');
  const outcome = historyOutcome(result.status);
  if (result.status === 'already_applied' && executionId) {
    const existingExecution = Object.values(next.automation.history)
      .find((entry) => entry.executionId === executionId && ['applied', 'undone'].includes(entry.result));
    if (existingExecution) return { state: next, changed: false, entry: existingExecution };
  }
  const historyId = stableHistoryId({ executionId, ruleIds, sourceType, sourceId, actionType, reasonCode, outcome });

  if (next.automation.history[historyId]) return { state: next, changed: false, entry: next.automation.history[historyId] };

  const timestamp = validDate(input.now).toISOString();
  const undo = outcome === AUTOMATION_HISTORY_RESULT.APPLIED
    ? buildUndoDescriptor(input.beforeState, next, proposal, executionId)
    : null;

  next.automation.history[historyId] = {
    id: historyId,
    executionId,
    ruleIds,
    sourceType,
    sourceId,
    actionType,
    result: outcome,
    timestamp,
    reasonCode,
    undoStatus: undo ? 'available' : 'unavailable',
    undo,
    undoneAt: null
  };
  next.automation = normaliseAutomationState(next.automation);
  return { state: next, changed: true, entry: next.automation.history[historyId] || null };
}

export function automationHistoryEntries(state, filter = AUTOMATION_HISTORY_FILTER.ALL) {
  const automation = normaliseAutomationState(state?.automation);
  const wanted = FILTERS.has(filter) ? filter : AUTOMATION_HISTORY_FILTER.ALL;
  return Object.values(automation.history)
    .filter((entry) => wanted === AUTOMATION_HISTORY_FILTER.ALL || entry.result === wanted)
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')) || right.id.localeCompare(left.id));
}

export function automationHistoryPresentation(state, entryOrId) {
  const automation = normaliseAutomationState(state?.automation);
  const entry = typeof entryOrId === 'string' ? automation.history[entryOrId] : entryOrId;
  if (!entry) return null;

  const ruleNames = entry.ruleIds
    .map((id) => automation.rules.find((rule) => rule.id === id)?.name)
    .filter(Boolean)
    .slice(0, 3);
  const ruleLabel = ruleNames.length ? ruleNames.join(' · ') : entry.ruleIds.length ? 'Previous local rule' : 'OneStep automation';
  const sourceLabel = resolveSourceLabel(state, entry);
  const statusLabel = ({
    applied: 'Applied',
    needs_review: 'Needs review',
    blocked: 'Blocked',
    skipped: 'Skipped',
    undone: 'Undone'
  })[entry.result] || 'Recorded';
  const actionLabel = ({
    assign_transaction_budget: 'Budget/category assignment',
    add_local_tag: 'Local tag',
    create_local_reminder: 'Local reminder'
  })[entry.actionType] || 'Local automation action';
  const outcomePhrase = ({
    applied: 'was applied',
    needs_review: 'needs review',
    blocked: 'was blocked',
    skipped: 'made no additional change',
    undone: 'was undone'
  })[entry.result] || 'was recorded';
  const why = explanationFor(state, entry, ruleNames);
  const undo = automationUndoAvailability(state, entry);

  return {
    id: entry.id,
    statusLabel,
    actionLabel,
    summary: `${actionLabel} ${outcomePhrase}.`,
    sourceLabel,
    ruleLabel,
    why,
    timestamp: entry.timestamp,
    undo
  };
}

export function automationUndoAvailability(state, entryOrId, options = {}) {
  const automation = normaliseAutomationState(state?.automation);
  const entry = typeof entryOrId === 'string' ? automation.history[entryOrId] : entryOrId;
  if (!entry) return unavailable('history_missing', 'This history item is no longer available.');
  if (Number.isInteger(options.expectedRevision) && Number(state?.meta?.revision) !== options.expectedRevision) {
    return unavailable('stale_revision', 'Your financial information changed. Review the latest state before undoing this action.');
  }
  if (entry.result === AUTOMATION_HISTORY_RESULT.UNDONE || entry.undoStatus === 'completed') {
    return unavailable('already_undone', 'This automation action has already been undone.');
  }
  if (entry.undoStatus === 'expired') {
    return unavailable('undo_expired', 'Undo is no longer available for this older history item.');
  }
  if (entry.undoStatus !== 'available' || !entry.undo) {
    return unavailable('not_reversible', 'This automation action cannot be undone safely.');
  }

  if (entry.undo.kind === 'transaction_fields') {
    const transaction = transactionById(state, entry.sourceId);
    if (!transaction) return unavailable('source_missing', 'The payment no longer exists, so OneStep will not guess how to undo this.');
    if (!sameValue(captureFields(transaction, entry.undo.fields), entry.undo.after)) {
      return unavailable('newer_change', 'This payment changed after the automation ran. Undo is blocked to protect the newer choice.');
    }
    return available();
  }

  if (entry.undo.kind === 'transaction_tag') {
    const transaction = transactionById(state, entry.sourceId);
    if (!transaction) return unavailable('source_missing', 'The payment no longer exists, so OneStep will not guess how to undo this.');
    if (!sameValue({ present: Object.hasOwn(transaction, 'automationTags'), tags: safeTags(transaction.automationTags) },
      { present: entry.undo.afterPresent, tags: entry.undo.afterTags })) {
      return unavailable('newer_change', 'The payment tags changed after the automation ran. Undo is blocked to protect the newer choice.');
    }
    return available();
  }

  if (entry.undo.kind === 'created_task') {
    const task = (state?.tasks || []).find((item) => String(item?.id) === entry.undo.taskId);
    if (!task) return unavailable('source_missing', 'The reminder no longer exists, so there is nothing safe to undo.');
    if (!sameValue(captureTask(task), entry.undo.after)) {
      return unavailable('newer_change', 'The reminder changed after the automation ran. Undo is blocked to protect the newer choice.');
    }
    return available();
  }

  return unavailable('not_reversible', 'This automation action cannot be undone safely.');
}

export function undoAutomationHistoryEntry(state, historyId, options = {}) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationState(next.automation);
  const entry = next.automation.history[String(historyId || '')];
  const availability = automationUndoAvailability(next, entry, options);
  if (!availability.available) {
    return { state: next, status: 'blocked', reasonCode: availability.reasonCode, message: availability.message };
  }

  if (entry.undo.kind === 'transaction_fields') {
    const transaction = transactionById(next, entry.sourceId);
    restoreFields(transaction, entry.undo.before);
  } else if (entry.undo.kind === 'transaction_tag') {
    const transaction = transactionById(next, entry.sourceId);
    const tags = (Array.isArray(transaction.automationTags) ? transaction.automationTags : [])
      .filter((tag) => tag !== entry.undo.tag);
    if (entry.undo.beforePresent) transaction.automationTags = tags;
    else if (tags.length) transaction.automationTags = tags;
    else delete transaction.automationTags;
  } else if (entry.undo.kind === 'created_task') {
    next.tasks = (Array.isArray(next.tasks) ? next.tasks : []).filter((task) => String(task?.id) !== entry.undo.taskId);
  }

  entry.result = AUTOMATION_HISTORY_RESULT.UNDONE;
  entry.undoStatus = 'completed';
  entry.undoneAt = validDate(options.now).toISOString();
  next.automation = normaliseAutomationState(next.automation);
  return {
    state: next,
    status: 'undone',
    reasonCode: 'undo_applied',
    message: 'The local automation change was undone without overwriting newer information.'
  };
}

function buildUndoDescriptor(beforeState, afterState, proposal, executionId) {
  if (!beforeState || !proposal || !executionId) return null;
  const actionType = proposal.action?.type;
  const sourceId = proposal.source?.id;

  if (actionType === 'assign_transaction_budget') {
    const before = transactionById(beforeState, sourceId);
    const after = transactionById(afterState, sourceId);
    if (!before || !after) return null;
    return {
      kind: 'transaction_fields',
      fields: CATEGORY_FIELDS,
      before: captureFields(before, CATEGORY_FIELDS),
      after: captureFields(after, CATEGORY_FIELDS)
    };
  }

  if (actionType === 'add_local_tag') {
    const before = transactionById(beforeState, sourceId);
    const after = transactionById(afterState, sourceId);
    const tag = String(proposal.action?.payload?.tag || '').trim().slice(0, 80);
    if (!before || !after || !tag) return null;
    const beforeTags = Array.isArray(before.automationTags) ? before.automationTags : [];
    const afterTags = Array.isArray(after.automationTags) ? after.automationTags : [];
    if (beforeTags.includes(tag) || !afterTags.includes(tag)) return null;
    return {
      kind: 'transaction_tag',
      tag,
      beforePresent: Object.hasOwn(before, 'automationTags'),
      afterPresent: Object.hasOwn(after, 'automationTags'),
      afterTags: safeTags(after.automationTags)
    };
  }

  if (actionType === 'create_local_reminder') {
    const taskId = `automation_${executionId.slice(0, 32)}`;
    const existedBefore = (beforeState?.tasks || []).some((task) => String(task?.id) === taskId);
    const after = (afterState?.tasks || []).find((task) => String(task?.id) === taskId);
    if (existedBefore || !after || after.automationExecutionId !== executionId || after.source !== 'automation_rule') return null;
    return { kind: 'created_task', taskId, after: captureTask(after) };
  }

  return null;
}

function explanationFor(state, entry, ruleNames) {
  const rule = entry.ruleIds.map((id) => normaliseAutomationState(state?.automation).rules.find((item) => item.id === id)).find(Boolean);
  const ruleContext = ruleNames.length
    ? `${ruleNames.join(' and ')} matched its saved local conditions.`
    : entry.ruleIds.length ? 'The original local rule is no longer present, but this result remains in local history.' : '';

  const reasons = {
    applied: 'OneStep considered the action certain and inside the approved local automation boundary.',
    manual_override: 'A manual choice already existed, so OneStep left it unchanged.',
    rule_conflict: 'Two or more rules wanted incompatible results, so OneStep left the financial state unchanged for review.',
    source_information_missing: 'The source information was incomplete, so OneStep did not make an automatic change.',
    source_information_conflicting: 'The source information conflicted, so OneStep left the decision for review.',
    review_required: 'The available information was not certain enough for an automatic change.',
    financial_safety_required: 'Financial Safety needed an authoritative answer before an automatic financial action could continue.',
    financial_safety_blocked: 'Financial Safety blocked the automatic action.',
    stale_state_revision: 'The financial state changed before the action could run, so OneStep protected the newer state.',
    automation_paused: 'Automations were paused, so no automatic change was made.',
    recovery_mode_active: 'Data recovery protections were active, so automatic changes were blocked.',
    recovery_status_unknown: 'OneStep could not confirm that stored data was safe to change automatically.',
    already_applied: 'The same stable execution had already run, so OneStep did not apply it twice.',
    compatible_duplicate_rule_action: 'Another rule requested the same compatible change, so OneStep avoided a duplicate execution.',
    handler_missing: 'No approved local executor was available for this action.',
    handler_failed: 'The local executor failed, so the original financial state was kept.'
  };
  const reason = reasons[entry.reasonCode] || (entry.result === 'undone'
    ? 'You reversed this local automation action after OneStep verified that the automated change was still unchanged.'
    : 'OneStep recorded this local automation outcome so it can be explained later.');
  const savedExplanation = rule?.explanation ? ` ${rule.explanation}` : '';
  return `${ruleContext}${ruleContext ? ' ' : ''}${reason}${savedExplanation}`.trim();
}

function resolveSourceLabel(state, entry) {
  if (entry.sourceType === 'transaction') {
    const transaction = transactionById(state, entry.sourceId);
    const name = String(transaction?.userDescription || transaction?.description || transaction?.merchantName || transaction?.payee || '').trim();
    return name ? `Payment · ${name.slice(0, 120)}` : 'Payment';
  }
  if (entry.sourceType === 'recurring_pattern') return 'Confirmed recurring item';
  if (entry.sourceType === 'state') return 'Local financial state';
  return entry.sourceType.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function historyOutcome(status) {
  if (status === 'applied') return AUTOMATION_HISTORY_RESULT.APPLIED;
  if (status === 'review_required') return AUTOMATION_HISTORY_RESULT.NEEDS_REVIEW;
  if (status === 'blocked' || status === 'failed') return AUTOMATION_HISTORY_RESULT.BLOCKED;
  return AUTOMATION_HISTORY_RESULT.SKIPPED;
}

function stableHistoryId(parts) {
  if (parts.executionId) return `history_${parts.executionId}_${parts.outcome}_${parts.reasonCode}`.slice(0, 200);
  const identity = [parts.ruleIds.join(','), parts.sourceType, parts.sourceId, parts.actionType, parts.reasonCode, parts.outcome].join('|');
  return `history_${stableId(identity)}`;
}

function captureFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, {
    present: Object.hasOwn(value, field),
    value: safeScalar(value[field])
  }]));
}

function restoreFields(target, snapshot) {
  for (const [field, record] of Object.entries(snapshot || {})) {
    if (record?.present) target[field] = structuredClone(record.value);
    else delete target[field];
  }
}

function safeTags(value) {
  return Array.isArray(value) ? value.map((tag) => String(tag).slice(0, 80)).slice(0, 20) : [];
}

function captureTask(task) {
  return {
    id: String(task?.id || ''),
    title: String(task?.title || '').slice(0, 160),
    detail: String(task?.detail || '').slice(0, 240),
    priority: String(task?.priority || '').slice(0, 40),
    actionView: String(task?.actionView || '').slice(0, 80),
    source: String(task?.source || '').slice(0, 80),
    automationRuleId: String(task?.automationRuleId || '').slice(0, 120),
    automationExecutionId: String(task?.automationExecutionId || '').slice(0, 64),
    createdAt: String(task?.createdAt || '').slice(0, 40),
    updatedAt: String(task?.updatedAt || '').slice(0, 40),
    completedAt: task?.completedAt || null
  };
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stableId(value) {
  let hash = 14695981039346656037n;
  const prime = 1099511628211n;
  const mask = 0xffffffffffffffffn;
  for (const character of String(value)) {
    hash ^= BigInt(character.codePointAt(0));
    hash = (hash * prime) & mask;
  }
  return `${hash.toString(16).padStart(16, '0')}_${String(value).length.toString(36)}`;
}

function transactionById(state, id) {
  return (state?.transactions || []).find((transaction) => String(transaction?.id) === String(id)) || null;
}

function safeExecutionId(value) {
  const id = String(value || '');
  return EXECUTION_ID_PATTERN.test(id) ? id : null;
}

function safeRuleIds(value) {
  const rows = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(rows.map((entry) => safeCode(entry, '')).filter(Boolean))].sort().slice(0, 8);
}

function safeSourceId(value) {
  return String(value || 'global').slice(0, 240);
}

function safeCode(value, fallback) {
  const code = String(value || '').toLowerCase();
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function safeScalar(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function validDate(value) {
  const date = value === undefined ? new Date() : value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function available() {
  return { available: true, reasonCode: null, message: 'Undo is available because the automated change is still unchanged.' };
}

function unavailable(reasonCode, message) {
  return { available: false, reasonCode, message };
}
