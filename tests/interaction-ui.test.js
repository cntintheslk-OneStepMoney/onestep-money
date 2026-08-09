import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('save and document import actions are explicit guarded single-click controls', async () => {
  const [html, renderer] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8')
  ]);

  for (const id of ['importStatementButton', 'importPayslipButton', 'importCreditReportButton', 'saveEditButton', 'confirmImportButton']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*type="button"`));
  }
  assert.match(renderer, /bindSingleClickAction\('saveEditButton', 'Saving…', saveEditor\)/);
  assert.match(renderer, /bindSingleClickAction\('confirmImportButton', 'Importing…', confirmCurrentImport, syncConfirmImportButton\)/);
  assert.match(renderer, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(renderer, /if \(button\.disabled \|\| button\.getAttribute\('aria-busy'\) === 'true'\) return/);
});

test('all transient and update notifications share a promoted browser top layer', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="notificationLayer"[^>]+popover="manual"[\s\S]+id="updateNotificationRegion"[\s\S]+id="toast"/);
  assert.match(renderer, /observer\.observe\(document\.body, \{ attributes: true, subtree: true, attributeFilter: \['open'\] \}\)/);
  assert.match(renderer, /syncNotificationLayer\(true\)/);
  assert.match(renderer, /layer\.showPopover\(\)/);
  assert.match(css, /\.notification-layer \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 2147483647/);
  assert.match(css, /\.notification-layer::backdrop \{ background: transparent; pointer-events: none; \}/);
});
