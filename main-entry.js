import { ipcMain } from 'electron';
import { runStoredAutomationRulesWithHistory } from './automation-history-runner.js';
import { previewStoredAutomationRules } from './automation-rules.js';
import './main-process.js';

const MAX_AUTOMATION_STATE_BYTES = 25_000_000;

ipcMain.handle('automation:preview', (_event, state, options = {}) => {
  validateStatePayload(state);
  return previewStoredAutomationRules(state, {
    ruleId: String(options?.ruleId || ''),
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

function safeNow(value) {
  if (value === undefined || value === null || value === '') return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('Automation date is invalid.');
  return date;
}
