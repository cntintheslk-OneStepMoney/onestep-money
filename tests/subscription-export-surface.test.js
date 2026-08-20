import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  ensureSubscriptionExportControl,
  runSubscriptionExport
} from '../subscription-workflow-ui.js';

function fakeSubscriptionsView() {
  const heading = {
    children: [],
    append(node) { this.children.push(node); }
  };
  return {
    heading,
    querySelector(selector) {
      if (selector === '.subscriptions-heading') return heading;
      if (selector === '[data-subscription-export]') {
        return heading.children.find((child) => child?.dataset?.subscriptionExport === 'true') || null;
      }
      return null;
    }
  };
}

function fakeExportButton() {
  return { dataset: {}, disabled: false };
}

test('actual Subscriptions header receives exactly one export control and rerenders restore it', async () => {
  const subscriptionsUi = await fs.readFile(new URL('../subscriptions-ui.js', import.meta.url), 'utf8');
  assert.match(subscriptionsUi, /el\('div', 'subscriptions-heading'\)/);

  const firstView = fakeSubscriptionsView();
  const first = ensureSubscriptionExportControl(firstView, fakeExportButton);
  const repeated = ensureSubscriptionExportControl(firstView, fakeExportButton);
  assert.equal(first, repeated);
  assert.equal(firstView.heading.children.length, 1);
  assert.equal(first.dataset.subscriptionExport, 'true');

  const rerenderedView = fakeSubscriptionsView();
  const restored = ensureSubscriptionExportControl(rerenderedView, fakeExportButton);
  assert.ok(restored);
  assert.equal(rerenderedView.heading.children.length, 1);
});

test('subscription export uses the existing CSV path and always re-enables its control', async () => {
  const state = { scheduledPayments: [], transactions: [], accounts: [] };
  const snapshot = structuredClone(state);
  const button = fakeExportButton();
  let receivedCsv = '';

  const result = await runSubscriptionExport(button, state, async (csv) => {
    assert.equal(button.disabled, true);
    receivedCsv = csv;
    return { cancelled: true };
  });

  assert.deepEqual(result, { cancelled: true });
  assert.match(receivedCsv, /"Subscription ID"/);
  assert.equal(button.disabled, false);
  assert.deepEqual(state, snapshot);

  await assert.rejects(() => runSubscriptionExport(button, state, async () => {
    throw new Error('fictional save failure');
  }), /fictional save failure/);
  assert.equal(button.disabled, false);
  assert.deepEqual(state, snapshot);
});

test('export surface stays local-only and observer-driven across ordinary Subscriptions rerenders', async () => {
  const ui = await fs.readFile(new URL('../subscription-workflow-ui.js', import.meta.url), 'utf8');
  assert.match(ui, /querySelector\('\.subscriptions-heading'\)/);
  assert.match(ui, /MutationObserver\(scheduleAugment\)/);
  assert.match(ui, /ensureSubscriptionExportControl\(view\)/);
  assert.match(ui, /window\.financeAPI\.exportCsv/);
  assert.doesNotMatch(ui, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon|telemetry|analytics/);
});
