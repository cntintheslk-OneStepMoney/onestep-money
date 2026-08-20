import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Subscriptions ranking has keyboard alternatives, labelled controls and non-colour status text', async () => {
  const ui = await fs.readFile(new URL('../subscriptions-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /Move up/);
  assert.match(ui, /Move down/);
  assert.match(ui, /Add to ranking/);
  assert.match(ui, /Unrank/);
  assert.match(ui, /aria-label/);
  assert.match(ui, /Confirmed subscription|Likely recurring subscription|Needs confirmation|Manual subscription/i);
  assert.match(ui, /Keep|Essential|Excluded/);
});
