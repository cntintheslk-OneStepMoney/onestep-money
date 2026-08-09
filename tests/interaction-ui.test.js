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
  assert.match(renderer, /bindSingleClickAction\('saveSettingsButton', 'Saving…', saveSettings\)/);
  assert.match(renderer, /button\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(renderer, /if \(button\.disabled \|\| button\.getAttribute\('aria-busy'\) === 'true'\) return/);
});

test('primary controls have explicit button behaviour and dialogs expose accessible titles', async () => {
  const html = await fs.readFile(new URL('../index.html', import.meta.url), 'utf8');
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
  assert.ok(buttons.length > 0);
  for (const button of buttons) assert.match(button, /type="(?:button|submit)"/);

  for (const [dialogId, titleId] of [
    ['editDialog', 'editTitle'], ['importDialog', 'importTitle'], ['importResultDialog', 'importResultTitle'],
    ['diagnosticsDialog', 'diagnosticsDialogTitle'], ['restoreDialog', 'restoreDialogTitle'], ['freshStartDialog', 'freshStartDialogTitle']
  ]) {
    assert.match(html, new RegExp(`id="${dialogId}"[^>]*aria-labelledby="${titleId}"`));
    assert.match(html, new RegExp(`id="${titleId}"`));
  }
});

test('payments pagination reports full-result counts and has keyboard-operable navigation', async () => {
  const [html, renderer] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="transactionCount"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="transactionPagination"[^>]*aria-label="Payments pages"/);
  assert.match(html, /id="transactionPreviousPage"[^>]*type="button"/);
  assert.match(html, /id="transactionNextPage"[^>]*type="button"/);
  assert.match(renderer, /filterTransactionLedger\(ledgerIndex/);
  assert.match(renderer, /paginateTransactionLedger\(rows, transactionPage\)/);
  assert.doesNotMatch(renderer, /rows\.slice\(0, 300\)/);
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
