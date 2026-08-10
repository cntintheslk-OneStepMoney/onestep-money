const EXECUTION_ID_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const MAX_EXECUTIONS = 5000;
const MAX_MANUAL_OVERRIDES = 1000;

export const AUTOMATION_STATE_VERSION = 1;

export function normaliseAutomationState(value) {
  const automation = isPlainObject(value) ? value : {};
  return {
    version: AUTOMATION_STATE_VERSION,
    enabled: automation.enabled !== false,
    executions: normaliseExecutions(automation.executions),
    manualOverrides: normaliseManualOverrides(automation.manualOverrides)
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
