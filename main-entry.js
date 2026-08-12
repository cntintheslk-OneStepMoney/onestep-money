import { ipcMain } from 'electron';
import { runStoredAutomationRulesWithHistory } from './automation-history-runner.js';
import { previewStoredAutomationRules } from './automation-rules.js';
import './interaction-smoke-main.js';
import './main-process.js';

const MAX_AUTOMATION_STATE_BYTES = 25_000_000;
const PREVIEW_RECOVERY_MODES = new Set(['normal', 'recovery_required', 'resolution_in_progress', 'backup_in_progress', 'restore_in_progress']);

ipcMain.handle('automation:preview', async (_event, state, options = {}) => {
  validateStatePayload(state);
  return previewStoredAutomationRules(state, {
    ruleId: String(options?.ruleId || ''),
    rule: validRulePayload(options?.rule),
    recoveryMode: PREVIEW_RECOVERY_MODES.has(options?.recoveryMode) ? options.recoveryMode : 'normal',
    now: safeNow(options?.now)
  });
});

ipcMain.handle('automation:run', async (_event, state, options = {}) => {
  validateStatePayload(state);
  return runStoredAutomationRulesWithHistory(state, {
    now: safeNow(options?.now),
    recoveryMode: 'normal'
  });
});

function validateStatePayload(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new TypeError('Automation state is invalid.');
  if (JSON.stringify(state).length > MAX_AUTOMATION_STATE_BYTES) throw new TypeError('Automation state is too large.');
}

function validRulePayload(rule) {
  if (rule === undefined || rule === null) return null;
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) throw new TypeError('Automation rule preview is invalid.');
  if (JSON.stringify(rule).length > 25_000) throw new TypeError('Automation rule preview is too large.');
  return structuredClone(rule);
}

function safeNow(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Automation date is invalid.');
  return date;
}
