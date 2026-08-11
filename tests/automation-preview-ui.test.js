import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ui = fs.readFileSync(new URL('../automation-rules-ui.js', import.meta.url), 'utf8');

test('Test Rule is explicit and preview copy promises no mutation', () => {
  assert.match(ui, /Test Rule/);
  assert.match(ui, /Preview only — nothing has been changed/);
  assert.match(ui, /previewAutomationRules/);
});

test('new and materially edited rules are saved paused', () => {
  assert.match(ui, /enabled: false/);
  assert.match(ui, /materialRuleChanged/);
  assert.match(ui, /enabled: materialChanged \? false : existing\.enabled/);
  assert.match(ui, /Rule saved and paused because its matching or action changed/);
});

test('activation requires preview and separate confirmation for future activity', () => {
  assert.match(ui, /activationIntent: true/);
  assert.match(ui, /Enable for future activity/);
  assert.match(ui, /window\.confirm\(`/);
  assert.match(ui, /existing matching record/);
  assert.match(ui, /Retrospective application is not available/);
  assert.match(ui, /setAutomationRuleEnabled\(state, rule\.id, true/);
});

test('large previews use bounded progressive disclosure', () => {
  assert.match(ui, /const PREVIEW_PAGE_SIZE = 20/);
  assert.match(ui, /slice\(0, previewVisibleCount\)/);
  assert.match(ui, /Show 20 more/);
  assert.match(ui, /Details are capped at the first/);
});

test('preview UI adds no network, telemetry or analytics path', () => {
  assert.doesNotMatch(ui, /\bfetch\s*\(/);
  assert.doesNotMatch(ui, /node:(?:http|https|net|tls|dns)/);
  assert.doesNotMatch(ui, /telemetry|analytics/i);
});
