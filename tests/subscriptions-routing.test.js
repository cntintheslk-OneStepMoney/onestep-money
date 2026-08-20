import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Subscriptions route stays independent of core renderer view metadata and avoids load-order coupling', async () => {
  const [renderer, ui] = await Promise.all([
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../subscriptions-ui.js', import.meta.url), 'utf8')
  ]);
  assert.doesNotMatch(ui, /className\s*=\s*['\"]nav-button/);
  assert.match(ui, /className = 'subscriptions-nav-button'/);
  assert.match(ui, /button\.addEventListener\('click', openSubscriptionsView\)/);
  assert.match(ui, /document\.querySelectorAll\('\.view'\)/);
  assert.match(renderer, /document\.querySelectorAll\('\.nav-button'\)/);
});
