import { normaliseAutomationRuleCollection } from './automation-rule-model.js';
import { normaliseFinancialReminderCollection } from './financial-reminders.js';

const EXECUTION_ID_PATTERN = /^[0-9a-f]{64}$/;
const HISTORY_ID_PATTERN = /^history_[a-z0-9][a-z0-9._-]{0,198}$/;
const REVIEW_SIGNAL_ID_PATTERN = /^review_signal_[a-z0-9_]{1,80}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const REVIEW_SIGNAL_KINDS = new Set(['rule_conflict', 'engine_review']);
const REVIEW_PRIORITIES = new Set(['high', 'normal', 'low']);
const HISTORY_RESULTS = new Set(['applied', 'needs_review', 'blocked', 'skipped', 'undone']);
const UNDO_STATUSES = new Set(['available', 'unavailable', 'expired', 'completed']);
const UNDO_KINDS = new Set(['transaction_fields', 'transaction_tag', 'created_task']);
const MAX_EXECUTIONS = 5000;
const MAX_MANUAL_OVERRIDES = 1000;
const MAX_REVIEW_SIGNALS = 500;
export const MAX_AUTOMATION_HISTORY_ENTRIES = 1000;
export const MAX_ACTIVE_AUTOMATION_UNDO_ENTRIES = 250;

export const AUTOMATION_STATE_VERSION = 1;

export function normaliseAutomationState(value) {
  const automation = isPlainObject(value) ? value : {};
  return {
    version: AUTOMATION_STATE_VERSION,
    enabled: automation.enabled !== false,
    rules: normaliseAutomationRuleCollection(automation.rules),
    reminders: normaliseFinancialReminderCollection(automation.reminders),
    executions: normaliseExecutions(automation.executions),
    manualOverrides: normaliseManualOverrides(automation.manualOverrides),
    reviewSignals: normaliseReviewSignals(automation.reviewSignals),
    history: normaliseHistory(automation.history)
  };
}

export function automationEnabled(state) {
  return normaliseAutomationState(state?.automation).enabled;
}

function normaliseExecutions(value) {
  if (!isPlainObject(value)) return {};
  const entries = Object.entries(value)
    .filter(([id, record]) => EXECUTION_ID_PATTERN.test(id) && validExecutionRecord(record))
    .map(([id, record]) => [id, {
      status: 'applied',
      ruleId: safeCode(record.ruleId, 'unknown_rule'),
      actionType: safeCode(record.actionType, 'unknown_action'),
      appliedAt: validIsoDate(record.appliedAt) ? record.appliedAt : null,
      reasonCode: safeCode(record.reasonCode, 'applied')
    }])
    .sort((left, right) => compareTimestampThenId(left, right))
    .slice(-MAX_EXECUTIONS);
  return Object.fromEntries(entries);
}

function normaliseManualOverrides(value) {
  if (!isPlainObject(value)) return {};
  const entries = Object.entries(value)
    .filter(([id, record]) => EXECUTION_ID_PATTERN.test(id) && isPlainObject(record))
    .map(([id, record]) => [id, {
      setAt: validIsoDate(record.setAt) ? record.setAt : null,
      reasonCode: 'manual_override'
    }])
    .sort((left, right) => compareTimestampThenId(left, right, 'setAt'))
    .slice(-MAX_MANUAL_OVERRIDES);
  return Object.fromEntries(entries);
}

function normaliseReviewSignals(value) {
  if (!isPlainObject(value)) return {};
  const entries = Object.entries(value)
    .map(([id, record]) => [id, normaliseReviewSignal(id, record)])
    .filter(([, record]) => Boolean(record))
    .sort((left, right) => compareTimestampThenId(left, right, 'updatedAt'))
    .slice(-MAX_REVIEW_SIGNALS);
  return Object.fromEntries(entries);
}

function normaliseReviewSignal(id, value) {
  if (!REVIEW_SIGNAL_ID_PATTERN.test(id) || !isPlainObject(value)) return null;
  const kind = REVIEW_SIGNAL_KINDS.has(value.kind) ? value.kind : '';
  if (!kind) return null;
  const sourceType = safeCode(value.sourceType, 'state');
  const sourceId = String(value.sourceId || 'global').slice(0, 200);
  const actionType = safeCode(value.actionType, 'unknown_action');
  const reasonCode = safeCode(value.reasonCode, kind === 'rule_conflict' ? 'rule_conflict' : 'review_required');
  const priority = REVIEW_PRIORITIES.has(value.priority) ? value.priority : 'normal';
  const ruleIds = [...new Set((Array.isArray(value.ruleIds) ? value.ruleIds : [])
    .map((entry) => safeCode(entry, '')).filter(Boolean))].sort().slice(0, 8);
  return {
    id,
    kind,
    sourceType,
    sourceId,
    actionType,
    ruleIds,
    reasonCode,
    priority,
    dueAt: validIsoDate(value.dueAt) ? value.dueAt : null,
    createdAt: validIsoDate(value.createdAt) ? value.createdAt : null,
    updatedAt: validIsoDate(value.updatedAt) ? value.updatedAt : null
  };
}

function normaliseHistory(value) {
  if (!isPlainObject(value)) return {};
  const ordered = Object.entries(value)
    .map(([id, record]) => [id, normaliseHistoryEntry(id, record)])
    .filter(([, record]) => Boolean(record))
    .sort((left, right) => compareTimestampThenId(left, right, 'timestamp'));

  const available = ordered.filter(([, record]) => record.undoStatus === 'available' && record.undo);
  const protectedRows = available.slice(-MAX_ACTIVE_AUTOMATION_UNDO_ENTRIES);
  const protectedIds = new Set(protectedRows.map(([id]) => id));

  const safeRows = ordered.map(([id, record]) => {
    if (record.undoStatus === 'available' && record.undo && !protectedIds.has(id)) {
      return [id, { ...record, undoStatus: 'expired', undo: null }];
    }
    return [id, record];
  });
  const protectedSafeRows = safeRows.filter(([id]) => protectedIds.has(id));
  const otherRows = safeRows
    .filter(([id]) => !protectedIds.has(id))
    .slice(-(MAX_AUTOMATION_HISTORY_ENTRIES - protectedSafeRows.length));
  return Object.fromEntries([...otherRows, ...protectedSafeRows]
    .sort((left, right) => compareTimestampThenId(left, right, 'timestamp')));
}

function normaliseHistoryEntry(id, value) {
  if (!HISTORY_ID_PATTERN.test(id) || !isPlainObject(value)) return null;
  const result = HISTORY_RESULTS.has(value.result) ? value.result : '';
  if (!result) return null;
  const executionId = EXECUTION_ID_PATTERN.test(String(value.executionId || '')) ? String(value.executionId) : null;
  const ruleIds = [...new Set((Array.isArray(value.ruleIds) ? value.ruleIds : [])
    .map((entry) => safeCode(entry, '')).filter(Boolean))].sort().slice(0, 8);
  const sourceType = safeCode(value.sourceType, 'state');
  const sourceId = String(value.sourceId || 'global').slice(0, 240);
  const actionType = safeCode(value.actionType, 'unknown_action');
  const reasonCode = safeCode(value.reasonCode, 'unknown_reason');
  const undo = normaliseUndo(value.undo);
  let undoStatus = UNDO_STATUSES.has(value.undoStatus) ? value.undoStatus : undo ? 'available' : 'unavailable';
  if (!undo && undoStatus === 'available') undoStatus = 'unavailable';
  if (result === 'undone') undoStatus = 'completed';
  return {
    id,
    executionId,
    ruleIds,
    sourceType,
    sourceId,
    actionType,
    result,
    timestamp: validIsoDate(value.timestamp) ? value.timestamp : null,
    reasonCode,
    undoStatus,
    undo: undoStatus === 'available' ? undo : null,
    undoneAt: validIsoDate(value.undoneAt) ? value.undoneAt : null
  };
}

function normaliseUndo(value) {
  if (!isPlainObject(value) || !UNDO_KINDS.has(value.kind)) return null;
  if (value.kind === 'transaction_fields') {
    const fields = [...new Set((Array.isArray(value.fields) ? value.fields : [])
      .map((field) => safeFieldName(field)).filter(Boolean))].slice(0, 12);
    if (!fields.length) return null;
    const before = normaliseFieldSnapshot(value.before, fields);
    const after = normaliseFieldSnapshot(value.after, fields);
    if (!before || !after) return null;
    return { kind: value.kind, fields, before, after };
  }
  if (value.kind === 'transaction_tag') {
    const tag = String(value.tag || '').trim().slice(0, 80);
    if (!tag || typeof value.beforePresent !== 'boolean' || typeof value.afterPresent !== 'boolean') return null;
    const afterTags = normaliseTags(value.afterTags);
    if (!afterTags.includes(tag)) return null;
    return { kind: value.kind, tag, beforePresent: value.beforePresent, afterPresent: value.afterPresent, afterTags };
  }
  const taskId = String(value.taskId || '').slice(0, 120);
  if (!/^automation_[0-9a-f]{32}$/.test(taskId)) return null;
  const after = normaliseTaskSnapshot(value.after);
  if (!after || after.id !== taskId) return null;
  return { kind: value.kind, taskId, after };
}

function normaliseFieldSnapshot(value, fields) {
  if (!isPlainObject(value)) return null;
  const output = {};
  for (const field of fields) {
    const snapshot = value[field];
    if (!isPlainObject(snapshot) || typeof snapshot.present !== 'boolean') return null;
    output[field] = { present: snapshot.present, value: normaliseScalar(snapshot.value) };
  }
  return output;
}

function normaliseTags(value) {
  return Array.isArray(value) ? value.map((tag) => String(tag).slice(0, 80)).slice(0, 20) : [];
}

function normaliseTaskSnapshot(value) {
  if (!isPlainObject(value)) return null;
  return {
    id: String(value.id || '').slice(0, 120),
    title: String(value.title || '').slice(0, 160),
    detail: String(value.detail || '').slice(0, 240),
    priority: String(value.priority || '').slice(0, 40),
    actionView: String(value.actionView || '').slice(0, 80),
    source: String(value.source || '').slice(0, 80),
    automationRuleId: String(value.automationRuleId || '').slice(0, 120),
    automationExecutionId: String(value.automationExecutionId || '').slice(0, 64),
    createdAt: String(value.createdAt || '').slice(0, 40),
    updatedAt: String(value.updatedAt || '').slice(0, 40),
    completedAt: value.completedAt === null || typeof value.completedAt === 'string' ? value.completedAt : null
  };
}

function validExecutionRecord(value) {
  return isPlainObject(value) && value.status === 'applied';
}

function compareTimestampThenId(left, right, field = 'appliedAt') {
  return String(left[1][field] || '').localeCompare(String(right[1][field] || '')) || left[0].localeCompare(right[0]);
}

function safeFieldName(value) {
  const field = String(value || '');
  return /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(field) ? field : '';
}

function safeCode(value, fallback) {
  const code = String(value || '').toLowerCase();
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function normaliseScalar(value) {
  if (value === null || value === undefined) return null;
  if (['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return null;
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
