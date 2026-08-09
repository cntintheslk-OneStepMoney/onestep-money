import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compareLabels, defaultDashboardSettings, moveDashboardModule, normaliseAppearanceSettings,
  normaliseDashboardSettings, visibleDashboardModules
} from '../presentation-settings.js';

test('dashboard defaults keep Next Move prominent and give new users a low-overwhelm layout', () => {
  const dashboard = defaultDashboardSettings();
  assert.equal(dashboard.mode, 'simple');
  assert.equal(dashboard.order[0], 'next-move');
  assert.ok(dashboard.pinned.includes('next-move'));
  assert.deepEqual(visibleDashboardModules(dashboard), ['next-move', 'balance', 'upcoming', 'budget', 'alerts', 'progress']);
});

test('valid dashboard choices persist while malformed layout state resets only presentation settings', () => {
  const valid = normaliseDashboardSettings({
    mode: 'detailed', order: ['review', 'next-move'], hidden: ['income'], pinned: ['review'], sizes: { review: 'wide' }
  });
  assert.equal(valid.mode, 'detailed');
  assert.equal(valid.order[0], 'review');
  assert.ok(valid.pinned.includes('next-move'));
  assert.ok(valid.hidden.includes('income'));
  assert.equal(valid.sizes.review, 'wide');

  const malformed = normaliseDashboardSettings({ mode: 'detailed', order: ['not-a-module'], hidden: 'everything' });
  assert.deepEqual(malformed, defaultDashboardSettings());
  assert.deepEqual(normaliseAppearanceSettings({ theme: 'not-a-theme' }), { theme: 'system' });
});

test('dashboard modules support keyboard-equivalent ordering without a freeform canvas', () => {
  const moved = moveDashboardModule(defaultDashboardSettings(), 'balance', 'down');
  assert.equal(moved.order.indexOf('balance'), 2);
  assert.equal(moved.order.indexOf('upcoming'), 1);
});

test('alphabetical choice ordering is case-insensitive and numeric-aware', () => {
  const labels = ['Fuel 10', 'groceries', 'Fuel 2', 'Bills'].sort(compareLabels);
  assert.deepEqual(labels, ['Bills', 'Fuel 2', 'Fuel 10', 'groceries']);
});
