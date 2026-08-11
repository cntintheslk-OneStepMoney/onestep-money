import assert from 'node:assert/strict';
import test from 'node:test';
import { activateCoreView, installCoreInteractions, resolveCoreViewTarget } from '../core-interactions.js';

function element(id, dataset = {}) {
  const classes = new Set();
  return {
    id, dataset, hidden: false, textContent: '',
    classList: {
      toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
      contains(name) { return classes.has(name); }
    }
  };
}

function fakeDocument() {
  const dashboardNav = element('dashboardNav', { view: 'dashboard' });
  const settingsNav = element('settingsNav', { view: 'settings' });
  const dashboard = element('view-dashboard'); dashboard.classList.toggle('active', true);
  const settings = element('view-settings'); settings.hidden = true;
  const review = element('view-review'); review.hidden = true;
  const today = element('view-today'); today.hidden = true;
  const eyebrow = element('viewEyebrow');
  const title = element('viewTitle');
  const byId = new Map([dashboard, settings, review, today, eyebrow, title].map((item) => [item.id, item]));
  let clickListener = null;
  let clickCapture = false;
  return {
    dashboardNav, settingsNav, dashboard, settings, review, today, eyebrow, title,
    addEventListener(type, listener, capture) { if (type === 'click') { clickListener = listener; clickCapture = capture === true; } },
    querySelectorAll(selector) { if (selector === '.nav-button') return [dashboardNav, settingsNav]; if (selector === '.view') return [dashboard, settings, review, today]; return []; },
    getElementById(id) { return byId.get(id) || null; },
    click(target) { clickListener?.({ target }); },
    get clickCapture() { return clickCapture; }
  };
}

function targetFor(control) {
  return { closest() { return control; } };
}

test('core navigation is installed in capture phase and remains idempotent', () => {
  const doc = fakeDocument();
  assert.equal(installCoreInteractions(doc), true);
  assert.equal(doc.clickCapture, true);
  assert.equal(installCoreInteractions(doc), false);
});

test('sidebar navigation switches the visible view and heading', () => {
  const doc = fakeDocument();
  installCoreInteractions(doc);
  doc.click(targetFor(doc.settingsNav));
  assert.equal(doc.dashboard.hidden, true);
  assert.equal(doc.settings.hidden, false);
  assert.equal(doc.settings.classList.contains('active'), true);
  assert.equal(doc.settingsNav.classList.contains('active'), true);
  assert.equal(doc.title.textContent, 'Settings');
  assert.equal(doc.eyebrow.textContent, 'CONTROL AND PRIVACY');
});

test('dashboard route buttons resolve without depending on renderer startup state', () => {
  const reviewButton = { id: '', dataset: { viewTarget: 'review' } };
  const nextMoveButton = { id: 'dashboardOpenNextMove', dataset: {} };
  assert.equal(resolveCoreViewTarget(targetFor(reviewButton)), 'review');
  assert.equal(resolveCoreViewTarget(targetFor(nextMoveButton)), 'today');
});

test('unknown views are ignored without hiding the current page', () => {
  const doc = fakeDocument();
  assert.equal(activateCoreView(doc, 'missing'), false);
  assert.equal(doc.dashboard.hidden, false);
  assert.equal(doc.dashboard.classList.contains('active'), true);
});
