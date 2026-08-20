import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('cancellation UI uses only explicit safe-open navigation and never changes cancellation state on open', async () => {
  const [ui, preload, main, entry, pkg, updateUi] = await Promise.all([
    fs.readFile(new URL('../subscription-cancellation-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../preload-bridge.cjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../subscription-cancellation-main.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../main-entry.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse),
    fs.readFile(new URL('../update-ui.js', import.meta.url), 'utf8')
  ]);
  assert.match(ui, /openCancellationDestination\(route\.url\)/);
  assert.match(ui, /Opening the official page does not mark this subscription as cancelled/);
  assert.match(ui, /Your cancellation status has not changed/);
  assert.doesNotMatch(ui, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|location\.reload/);
  assert.match(preload, /openCancellationDestination: \(url\) => ipcRenderer\.invoke\('subscription:open-cancellation', url\)/);
  assert.match(main, /validateExternalDestination\(destination\)/);
  assert.match(main, /shell\.openExternal\(url\)/);
  assert.doesNotMatch(main, /state:save|saveState|cancelled|lifecycle/i);
  assert.match(entry, /import '\.\/subscription-cancellation-main\.js';/);
  assert.match(updateUi, /import '\.\/subscription-cancellation-ui\.js';/);
  for (const file of ['subscription-cancellation.js','subscription-cancellation-main.js','subscription-cancellation-ui.js']) assert.ok(pkg.build.files.includes(file));
});

test('cancellation UI states uncertainty rather than inventing contract or fee certainty', async () => {
  const ui = await fs.readFile(new URL('../subscription-cancellation-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /notice periods, minimum terms or fee uncertainty/);
  assert.match(ui, /does not invent those facts/);
  assert.match(ui, /Manual guidance only/);
  assert.match(ui, /Apple \/ App Store/);
});
