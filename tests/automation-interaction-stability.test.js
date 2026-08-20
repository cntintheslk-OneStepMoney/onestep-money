import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const dashboard = read('../automation-dashboard-ui.js');
const recurring = read('../recurring-finance-ui.js');
const reminders = read('../financial-reminders-ui.js');
const rules = read('../automation-rules-ui.js');
const automationSurfaces = [dashboard, recurring, reminders, rules];

test('Automation interaction surfaces never reload the document after ordinary actions', () => {
  for (const source of automationSurfaces) {
    assert.doesNotMatch(source, /(?:window\.)?location\.reload\s*\(/);
  }
});

test('Automation dashboard saves stay in place and retain duplicate-click guards', () => {
  assert.match(dashboard, /control\.disabled = true;/);
  assert.match(dashboard, /button\.disabled = true;/);
  assert.match(dashboard, /state = saved;\s*await refresh\(/);
  assert.doesNotMatch(dashboard, /sessionStorage/);
  assert.doesNotMatch(dashboard, /document\.body|appShell\.replace|appShell\.innerHTML/);
});

test('Recurring decisions save safely, cannot double-fire, and return to Automation when launched there', () => {
  assert.match(dashboard, /markRecurringActivityReturnToAutomation\(\);/);
  assert.match(recurring, /let returnToAutomationAfterDecision = false;/);
  assert.match(recurring, /button\.disabled = true;/);
  assert.match(recurring, /saved\?\.status === 'blocked' \|\| saved\?\.status === 'conflict'/);
  assert.match(recurring, /returnToAutomationAfterDecision = false;\s*document\.querySelector\('\.nav-button\[data-view="automation"\]'\)\?\.click\(\);/);
  assert.match(recurring, /catch \(error\) \{ button\.disabled = false;/);
});

test('Reminder actions rerender locally and reject overlapping saves', () => {
  assert.match(reminders, /let saving = false;/);
  assert.match(reminders, /if \(saving\) \{/);
  assert.match(reminders, /state = saved;/);
  assert.match(reminders, /if \(panel\) render\(panel\);/);
  assert.match(reminders, /finally \{\s*saving = false;/);
  assert.match(reminders, /event\.preventDefault\(\);/);
});

test('Rule saves and automatic rule-cycle results rerender in place', () => {
  assert.match(rules, /state = saved; runSummary = null; render\(\); setStatus\(message\); scheduleCycle\(\);/);
  assert.match(rules, /cycleRunning = true; queueMicrotask\(runCycle\);/);
  assert.match(rules, /state = saved;\s*render\(\);\s*setStatus\(runSummary\.conflicts/);
  assert.match(rules, /finally \{ cycleRunning = false; \}/);
  assert.match(rules, /if \(event\.target\.id !== 'automationRuleForm'\) return;\s*event\.preventDefault\(\);/);
});

test('Automation failures use local status messaging instead of replacing the application shell', () => {
  assert.match(dashboard, /Automation state could not be changed safely/);
  assert.match(recurring, /recurring-pattern decision could not be saved/);
  assert.match(reminders, /reminder could not be saved/);
  assert.match(rules, /Automation could not save safely/);
  for (const source of automationSurfaces) {
    assert.doesNotMatch(source, /document\.documentElement\.innerHTML|document\.body\.innerHTML/);
  }
});
