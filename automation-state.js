import { normaliseAutomationRuleCollection } from './automation-rule-model.js';
import { normaliseFinancialReminderCollection } from './financial-reminders.js';

const EXECUTION_ID_PATTERN = /^[0-9a-f]{64}$/;
const REVIEW_SIGNAL_ID_PATTERN = /^review_signal_[a-z0-9_]{1,80}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const REVIEW_SIGNAL_KINDS = new Set(['rule_conflict', 'engine_review']);
const REVIEW_PRIORITIES = new Set(['high', 'normal', 'low']);
const MAX_EXECUTIONS = 5000;
const MAX_MANUAL_OVERRIDES = 1000;
const MAX_REVIEW_SIGNALS = 500;

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
    reviewSignals: normaliseReviewSignals(automation.reviewSignals)
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

function validExecutionRecord(value) {
  return isPlainObject(value) && value.status === 'applied';
}

function compareTimestampThenId(left, right, field = 'appliedAt') {
  return String(left[1][field] || '').localeCompare(String(right[1][field] || '')) || left[0].localeCompare(right[0]);
}

function safeCode(value, fallback) {
  const code = String(value || '').toLowerCase();
  return SAFE_CODE_PATTERN.test(code) ? code : fallback;
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
