import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('subscription workflow UI keeps cancellation lifecycle explicit and separate from external navigation', async () => {
  const ui = await fs.readFile(new URL('../subscription-workflow-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /Cancellation planned/);
  assert.match(ui, /Cancellation in progress/);
  assert.match(ui, /Cancelled/);
  assert.match(ui, /Contract ending/);
  assert.match(ui, /Opening cancellation guidance never changes this status/);
  assert.match(ui, /remains a financial commitment until effective evidence supports otherwise/);
  assert.match(ui, /Cancellation effective date/);
  assert.match(ui, /Known contract end date/);
  assert.doesNotMatch(ui, /openCancellationDestination|shell\.openExternal|location\.reload/);
});

test('subscription workflow UI persists through guarded state and recovers revision conflicts locally', async () => {
  const ui = await fs.readFile(new URL('../subscription-workflow-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /setSubscriptionLifecycle/);
  assert.match(ui, /window\.financeAPI\.saveState/);
  assert.match(ui, /saved\?\.status === 'conflict'/);
  assert.match(ui, /newest state is shown/i);
  assert.match(ui, /window\.financeAPI\.loadState/);
  assert.doesNotMatch(ui, /console\.|diagnostic|logger/);
});

test('subscription export reuses the local CSV bridge and no network or telemetry path is added', async () => {
  const ui = await fs.readFile(new URL('../subscription-workflow-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /Export subscription data/);
  assert.match(ui, /exportSubscriptionsCsv/);
  assert.match(ui, /window\.financeAPI\.exportCsv/);
  assert.doesNotMatch(ui, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|telemetry|analytics/);
});

test('subscription workflow modules are bootstrapped and packaged', async () => {
  const [updateUi, pkg] = await Promise.all([
    fs.readFile(new URL('../update-ui.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8').then(JSON.parse)
  ]);
  assert.match(updateUi, /import '\.\/subscription-workflow-ui\.js';/);
  for (const file of ['subscription-workflow.js', 'subscription-workflow-ui.js']) assert.ok(pkg.build.files.includes(file));
});

test('Review integration consumes subscription sources without introducing a parallel review or priority engine', async () => {
  const [review, workflow, priority] = await Promise.all([
    fs.readFile(new URL('../review-lifecycle.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../subscription-workflow.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../next-move-priority.js', import.meta.url), 'utf8')
  ]);
  assert.match(review, /subscriptionReviewSources/);
  assert.match(review, /subscriptionReviewPresentation/);
  assert.match(review, /subscriptionReviewRoute/);
  assert.doesNotMatch(workflow, /subscriptionReviewItems\s*=|subscriptionTasks\s*=|prioritySnapshot\s*\(/);
  assert.match(priority, /activeReviewItems\(state, now\)/);
});
