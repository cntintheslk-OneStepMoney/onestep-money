import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('late renderer modules do not observe and rewrite their own rendered subtrees', async () => {
  const [history, debt] = await Promise.all([
    fs.readFile(new URL('../automation-history-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../financial-presentation-debt.js', import.meta.url), 'utf8')
  ]);

  assert.match(history, /observer\.observe\(settings, \{ attributes: true, attributeFilter: \['hidden', 'class'\] \}\)/);
  assert.doesNotMatch(history, /observer\.observe\(settings,[\s\S]{0,180}(?:childList|subtree): true/);
  assert.doesNotMatch(history, /observer\.observe\(target, \{ attributes: true, childList: true, subtree: target === settings \}\)/);

  assert.match(debt, /observer\.observe\(cards, \{ childList: true \}\)/);
  assert.doesNotMatch(debt, /observer\.observe\(target,[\s\S]{0,220}attributes: true[\s\S]{0,220}subtree:/);
  assert.match(debt, /if \(!legacy\.hidden\) \{[\s\S]{0,90}legacy\.hidden = true;[\s\S]{0,90}changed = true;[\s\S]{0,20}\}/);
  assert.match(debt, /legacy\.dataset\.replacedByDebtRecommendation !== 'true'/);
});

test('interaction smoke includes native Windows hit testing and fullscreen geometry checks', async () => {
  const smoke = await fs.readFile(new URL('../native-interaction-smoke-main.js', import.meta.url), 'utf8');
  assert.match(smoke, /--interaction-smoke/);
  assert.match(smoke, /screen\.dipToScreenPoint/);
  assert.match(smoke, /elementsFromPoint/);
  for (const eventName of ['pointerdown', 'mousedown', 'mouseup', 'click', 'wheel']) assert.match(smoke, new RegExp(`['\"]${eventName}['\"]`));
  assert.match(smoke, /setFullScreen\(true\)/);
  assert.match(smoke, /setFullScreen\(false\)/);
  assert.match(smoke, /getContentBounds\(\)/);
  assert.match(smoke, /assertViewport/);
  assert.match(smoke, /assertStable/);
});
