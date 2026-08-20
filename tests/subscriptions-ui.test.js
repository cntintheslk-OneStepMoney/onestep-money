import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Subscriptions UI is packaged, first-class, accessible and local-only', async () => {
  const [ui, css, desktopUi, presentation, pkg] = await Promise.all([
    fs.readFile(new URL('../subscriptions-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../subscriptions.css', import.meta.url), 'utf8'),
    fs.readFile(new URL('../update-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../presentation-settings.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.match(desktopUi, /import '\.\/subscriptions-ui\.js';/);
  assert.doesNotMatch(presentation, /subscriptions-ui/);
  assert.match(ui, /className = 'subscriptions-nav-button'/);
  assert.match(ui, /dataset\.view = 'subscriptions'/);
  assert.match(ui, /draggable = true/);
  assert.match(ui, /data-subscription-protection|subscriptionProtection/);
  assert.match(ui, /Move up/);
  assert.match(ui, /Move down/);
  assert.match(ui, /needs confirmation/i);
  assert.match(ui, /Confirm subscription/);
  assert.match(ui, /Not a subscription/);
  assert.doesNotMatch(ui, /location\.reload|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.match(css, /var\(--panel\)/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /prefers-reduced-motion/);
  for (const file of ['subscription-model.js', 'subscriptions-presentation.js', 'subscriptions-ui.js', 'subscriptions.css']) assert.ok(pkg.build.files.includes(file));
});

test('Subscriptions UI exposes filtering, sorting, details and honest future boundaries', async () => {
  const ui = await fs.readFile(new URL('../subscriptions-ui.js', import.meta.url), 'utf8');
  for (const label of ['Highest value first', 'Lowest value first', 'Highest monthly cost', 'Lowest monthly cost', 'Next payment', 'Unranked']) assert.match(ui, new RegExp(label));
  assert.match(ui, /Details and notes/);
  assert.match(ui, /Cancellation guidance is not attached yet/);
  assert.match(ui, /Potential savings/);
  assert.match(ui, /Not calculated yet/);
  assert.match(ui, /newest state|latest safe state/i);
  assert.match(ui, /minimum is not greater than the maximum/i);
});
