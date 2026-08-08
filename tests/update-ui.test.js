import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  applyUpdateStatus, createUpdateUiState, dismissUpdateNotification, setInstalledVersion, updateUiView
} from '../update-ui.js';

test('available update shows the popup and persistent installed-version reminder', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.10');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.11', message: 'OneStep Money v2.1.11 is available.' });
  const view = updateUiView(state);

  assert.equal(view.notificationVisible, true);
  assert.equal(view.notificationMessage, 'OneStep Money v2.1.11 is available.');
  assert.equal(view.versionLabel, 'v2.1.10 · Update available');
  assert.equal(view.viewUpdateVisible, true);
});

test('dismissal lasts for the session and does not remove the version reminder', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.10');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.11', message: 'OneStep Money v2.1.11 is available.' });
  state = dismissUpdateNotification(state);
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.11', message: 'OneStep Money v2.1.11 is available.' });
  const view = updateUiView(state);

  assert.equal(view.notificationVisible, false);
  assert.equal(view.versionLabel, 'v2.1.10 · Update available');
  assert.equal(view.viewUpdateVisible, true);
});

test('a new application session may show the same outstanding update again', () => {
  let previousSession = applyUpdateStatus(createUpdateUiState(), { state: 'available', version: '2.1.11' });
  previousSession = dismissUpdateNotification(previousSession);
  assert.equal(updateUiView(previousSession).notificationVisible, false);

  const nextSession = applyUpdateStatus(createUpdateUiState(), { state: 'available', version: '2.1.11' });
  assert.equal(updateUiView(nextSession).notificationVisible, true);
});

test('no-update state leaves the installed version unchanged and failure preserves known availability', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.10');
  state = applyUpdateStatus(state, { state: 'current', message: 'You’re up to date.' });
  assert.equal(updateUiView(state).notificationVisible, false);
  assert.equal(updateUiView(state).versionLabel, 'v2.1.10');

  state = applyUpdateStatus(state, { state: 'available', version: '2.1.11', message: 'Update available.' });
  state = applyUpdateStatus(state, { state: 'unavailable', message: 'The update check couldn’t be completed.' });
  assert.equal(updateUiView(state).versionLabel, 'v2.1.10 · Update available');
});

test('notification markup and styles preserve accessibility, minimum sizing and reduced motion', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../main-process.js', import.meta.url), 'utf8');

  assert.match(html, /aria-label="Dismiss update notification"/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /data-view-update/);
  assert.match(css, /padding: 0 18px 18px 0/);
  assert.match(css, /max-width: 340px/);
  assert.match(css, /rgba\(7, 29, 67, 0\.84\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /\.app-shell\.update-notification-visible/);
  assert.doesNotMatch(main, /quitAndInstall|downloadUpdate|update:install/);
});
