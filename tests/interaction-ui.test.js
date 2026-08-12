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
    ['dashboardDialog', 'dashboardDialogTitle'], ['diagnosticsDialog', 'diagnosticsDialogTitle'], ['restoreDialog', 'restoreDialogTitle'], ['freshStartDialog', 'freshStartDialogTitle']
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

test('transient and update notifications stay above the app without entering the browser top layer', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);

  assert.match(html, /id="notificationLayer" class="notification-layer"[\s\S]+id="updateNotificationRegion"[\s\S]+id="toast"/);
  assert.doesNotMatch(html, /id="notificationLayer"[^>]+popover=/);
  assert.match(renderer, /const shouldShow = !byId\('toast'\)\.hidden \|\| !byId\('updateNotificationRegion'\)\.hidden/);
  assert.match(renderer, /layer\.hidden = !shouldShow/);
  assert.doesNotMatch(renderer, /showPopover|hidePopover|:popover-open/);
  assert.match(css, /\.notification-layer \{[^}]*position: fixed;[^}]*inset: 0;[^}]*z-index: 2147483647[^}]*pointer-events: none/);
  assert.match(css, /\.update-notification-region \{[^}]*pointer-events: auto/);
  assert.doesNotMatch(css, /\.notification-layer::backdrop/);
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

test('Dashboard supports persisted modes, accessible personalisation and authoritative chart summaries', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);
  assert.match(html, /data-view="dashboard"/);
  assert.match(html, /id="view-dashboard"[\s\S]*id="dashboardNextMoveTitle"/);
  assert.match(html, /data-dashboard-mode="simple"[\s\S]*data-dashboard-mode="detailed"/);
  assert.match(html, /id="dashboardCustomisationList"/);
  assert.match(renderer, /visibleDashboardModules\(dashboard\)/);
  assert.match(renderer, /await saveAndRender\(\)/);
  assert.match(renderer, /prioritySafety\?\.currentCashCapacity/);
  assert.match(css, /\.dashboard-grid/);
  assert.match(css, /\.dashboard-customisation-row/);
});

test('Payments charts, text alternatives and accessible theme controls are present without remote assets', async () => {
  const [html, renderer, css] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../styles.css', import.meta.url), 'utf8')
  ]);
  for (const id of ['moneyInOutChart', 'spendingTrendChart', 'categoryChart', 'recurringChart']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(renderer, /buildFinancialReport\(state\)/);
  assert.match(renderer, /chartDataTable\(points\)/);
  assert.match(html, /id="themeControl"[^>]*aria-describedby="themeHelp"[\s\S]*name="appearance-theme" value="system"[\s\S]*name="appearance-theme" value="light"[\s\S]*name="appearance-theme" value="dark"/);
  assert.match(html, /<fieldset[^>]*id="themeControl"[\s\S]*<legend>Theme<\/legend>/);
  assert.match(renderer, /querySelectorAll\('input\[name="appearance-theme"\]'\)[\s\S]*addEventListener\('change', saveThemePreference\)/);
  assert.match(renderer, /const theme = event\?\.target\?\.value;[\s\S]*state\.settings\.appearance\.theme = THEMES\.includes\(theme\) \? theme : 'system'/);
  assert.match(renderer, /input\.checked = input\.value === theme/);
  assert.match(renderer, /matchMedia\('\(prefers-color-scheme: dark\)'\)/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /\.theme-option input:checked \+ span::after \{ content: "✓"/);
  assert.match(css, /\.theme-option input:focus-visible \+ span/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('confirmed shared surfaces use theme-aware semantic tokens', async () => {
  const css = await fs.readFile(new URL('../styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.streak-chip, \.time-chip, \.status-pill \{[\s\S]*?background: var\(--surface-raised\)/);
  assert.match(css, /\.secondary-button, \.edit-button \{[^}]*background: var\(--control-surface\)/);
  assert.match(css, /\.check-card \{[^}]*background: var\(--surface-subtle\)/);
  assert.match(css, /\.review-summary-counts span \{[^}]*background: var\(--surface-raised\)/);
  assert.match(css, /\.review-card \{[^}]*background: var\(--surface-raised\)/);
  assert.match(css, /\.review-card-detail \{[^}]*color: var\(--ink-soft\)/);
});
