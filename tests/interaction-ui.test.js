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

test('Review Inbox uses accessible controls, restrained counts and progressive disclosure', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /data-view="review"[\s\S]*id="reviewNavCount"/);
  assert.match(html, /id="view-review"[\s\S]*id="reviewInboxStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="reviewDoneState"[\s\S]*Nothing needs reviewing right now/);
  assert.match(html, /id="reviewActiveList"/);
  assert.match(html, /id="reviewSnoozedList"/);
  assert.match(renderer, /resolveReviewItem\(state/);
  assert.match(renderer, /snoozeReviewGroup\(state/);
  assert.match(renderer, /openEditor\('transaction', route\.id, \{ reviewItemId: item\.id \}\)/);
  assert.match(renderer, /knownPaydayDay\(state\.profile\?\.paydayDay\)/);
  assert.match(css, /\.review-priority/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('Today exposes one explainable Next Move, supporting work and a genuine caught-up state', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);

  assert.equal((html.match(/id="nextActionTitle"/g) || []).length, 1);
  assert.match(html, /<p class="eyebrow">NEXT MOVE<\/p>/);
  assert.match(html, /id="completeActionButton"[^>]*type="button">Do it<\/button>/);
  assert.match(html, /id="snoozeActionButton"[^>]*type="button">Snooze<\/button>/);
  assert.match(html, /id="nextMoveWhy"[\s\S]*<summary>Why\?<\/summary>/);
  assert.match(html, /id="todayProgressStatus"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(html, /id="todaySupportingSection"[\s\S]*Everything else remains in Review Inbox/);
  assert.match(html, /id="dailyCompleteTitle">You’re caught up for now/);
  assert.match(renderer, /prioritySnapshot\(state, new Date\(\), \{ preferredItemId: pendingAction\?\.reviewId, safetyAssessment: prioritySafety \}\)/);
  assert.match(renderer, /priorityView\.lowPriorityRemaining/);
  assert.match(renderer, /recordPriorityDiagnostic\(PRIORITY_DIAGNOSTIC_CODES\.EVALUATION_FAILED\)/);
  assert.match(renderer, /recordPriorityDiagnostic\(PRIORITY_DIAGNOSTIC_CODES\.CONSOLIDATION_INVALID\)/);
  assert.doesNotMatch(renderer, /Priority score|dueDateModifier|financialRisk \+/i);
  assert.match(css, /\.next-move-band\.band-critical/);
  assert.match(css, /\.today-supporting-list/);
  assert.match(css, /summary:focus-visible/);
});
