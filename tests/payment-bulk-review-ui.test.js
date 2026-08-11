import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const ui = fs.readFileSync(new URL('../payment-bulk-review-ui.js', import.meta.url), 'utf8');
const ledger = fs.readFileSync(new URL('../transaction-ledger.js', import.meta.url), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('Payments loads the bulk review UI without adding a second application entry point', () => {
  assert.match(ledger, /import '\.\/payment-bulk-review-ui\.js';/);
});

test('bulk UI uses visible-row IDs, native checkboxes and explicit review/apply confirmation', () => {
  assert.match(ui, /retainVisiblePaymentSelection/);
  assert.match(ui, /Select visible/);
  assert.match(ui, /checkbox\.type = 'checkbox'/);
  assert.match(ui, /Review changes/);
  assert.match(ui, /showModal\(\)/);
  assert.match(ui, /Apply to selected/);
  assert.match(ui, /Cancel/);
});

test('bulk UI synchronises Review Inbox from source truth before normal state save', () => {
  assert.match(ui, /synchroniseReviewItems/);
  assert.match(ui, /applyPaymentBulkCategorisation\(pending\.state, pending\.plan, \{ synchroniseReviewItems/);
  assert.match(ui, /window\.financeAPI\.saveState\(result\.state\)/);
});

test('bulk UI handles state revision conflicts conservatively', () => {
  assert.match(ui, /saved\?\.status === 'conflict'/);
  assert.match(ui, /Nothing from this bulk action was saved/);
});

test('packaged application includes both bulk review modules', () => {
  assert.ok(packageJson.build.files.includes('payment-bulk-review.js'));
  assert.ok(packageJson.build.files.includes('payment-bulk-review-ui.js'));
});

test('bulk UI styles use shared theme variables for light and night compatibility', () => {
  assert.match(ui, /var\(--surface-subtle\)/);
  assert.match(ui, /var\(--panel\)/);
  assert.match(ui, /var\(--ink\)/);
  assert.match(ui, /var\(--focus-ring\)|primary-button|secondary-button/);
});
