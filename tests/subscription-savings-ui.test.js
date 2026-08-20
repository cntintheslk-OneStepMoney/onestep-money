import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('subscription savings UI exposes a local target and conservative advice-only recommendation', async () => {
  const ui = await fs.readFile(new URL('../subscription-savings-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /Monthly savings target/);
  assert.match(ui, /Target to save each month/);
  assert.match(ui, /conservative minimum monthly saving/i);
  assert.match(ui, /Lowest personal value first/);
  assert.match(ui, /Remaining gap/);
  assert.match(ui, /Advice only/);
  assert.match(ui, /does not cancel subscriptions or move money/i);
  assert.match(ui, /Keep, Essential, Excluded and lifecycle review choices stay authoritative/);
  assert.doesNotMatch(ui, /openCancellationDestination|location\.reload|fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
});

test('subscription savings UI persists through the guarded state API and handles revision conflicts locally', async () => {
  const ui = await fs.readFile(new URL('../subscription-savings-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /setSubscriptionSavingsTarget/);
  assert.match(ui, /window\.financeAPI\.saveState/);
  assert.match(ui, /saved\?\.status === 'conflict'/);
  assert.match(ui, /newest state is shown/i);
  assert.match(ui, /window\.financeAPI\.loadState/);
  assert.doesNotMatch(ui, /console\.|diagnostic|logger/);
});

test('subscription savings UI is bootstrapped and packaged with the savings engine', async () => {
  const [updateUi, pkg] = await Promise.all([
    fs.readFile(new URL('../update-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.match(updateUi, /import '\.\/subscription-savings-ui\.js';/);
  for (const file of ['subscription-savings.js', 'subscription-savings-ui.js']) assert.ok(pkg.build.files.includes(file));
});
