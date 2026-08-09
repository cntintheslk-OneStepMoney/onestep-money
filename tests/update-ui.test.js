import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  applyUpdateStatus, createUpdateUiState, dismissUpdateNotification, setInstalledVersion, updateUiView
} from '../update-ui.js';

test('available update offers a deliberate download and keeps the GitHub option', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14', message: 'OneStep Money v2.1.14 is available.' });
  const view = updateUiView(state);

  assert.equal(view.notificationVisible, true);
  assert.equal(view.notificationTitle, 'Update available');
  assert.equal(view.notificationMessage, 'OneStep Money v2.1.14 is available.');
  assert.equal(view.versionLabel, 'v2.1.13 · Update available');
  assert.equal(view.downloadVisible, true);
  assert.equal(view.installVisible, false);
  assert.equal(view.viewUpdateVisible, true);
  assert.equal(view.progressVisible, false);
});

test('downloading state shows progress and does not expose installation early', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14' });
  state = applyUpdateStatus(state, { state: 'downloading', version: '2.1.14', percent: 63.4, message: 'Downloading…' });
  const view = updateUiView(state);

  assert.equal(view.notificationTitle, 'Downloading update');
  assert.equal(view.downloadVisible, true);
  assert.equal(view.downloadDisabled, true);
  assert.equal(view.downloadLabel, 'Downloading update…');
  assert.equal(view.installVisible, false);
  assert.equal(view.progressVisible, true);
  assert.equal(view.progressValue, 63.4);
  assert.equal(view.progressLabel, 'Update download 63% complete');
});

test('downloaded update stays ready until the user deliberately restarts and installs', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14' });
  state = applyUpdateStatus(state, { state: 'ready', version: '2.1.14', message: 'OneStep Money v2.1.14 is ready to install.' });
  const view = updateUiView(state);

  assert.equal(view.notificationTitle, 'Ready to install');
  assert.match(view.notificationMessage, /Restart when you’re ready/);
  assert.equal(view.versionLabel, 'v2.1.13 · Update ready');
  assert.equal(view.downloadVisible, false);
  assert.equal(view.installVisible, true);
  assert.equal(view.installDisabled, false);
  assert.equal(view.progressVisible, false);
});

test('dismissal lasts for the session and does not remove the version reminder or settings actions', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14' });
  state = dismissUpdateNotification(state);
  state = applyUpdateStatus(state, { state: 'ready', version: '2.1.14' });
  const view = updateUiView(state);

  assert.equal(view.notificationVisible, false);
  assert.equal(view.versionLabel, 'v2.1.13 · Update ready');
  assert.equal(view.installVisible, true);
  assert.equal(view.viewUpdateVisible, true);
});

test('a new application session may show the same outstanding update again', () => {
  let previousSession = applyUpdateStatus(createUpdateUiState(), { state: 'available', version: '2.1.14' });
  previousSession = dismissUpdateNotification(previousSession);
  assert.equal(updateUiView(previousSession).notificationVisible, false);

  const nextSession = applyUpdateStatus(createUpdateUiState(), { state: 'available', version: '2.1.14' });
  assert.equal(updateUiView(nextSession).notificationVisible, true);
});

test('no-update state clears actions while failure preserves known availability', () => {
  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'current', message: 'You’re up to date.' });
  assert.equal(updateUiView(state).notificationVisible, false);
  assert.equal(updateUiView(state).versionLabel, 'v2.1.13');

  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14', message: 'Update available.' });
  state = applyUpdateStatus(state, { state: 'unavailable', message: 'The update check couldn’t be completed.' });
  assert.equal(updateUiView(state).versionLabel, 'v2.1.13 · Update available');
  assert.equal(updateUiView(state).downloadVisible, true);
  assert.equal(updateUiView(state).downloadLabel, 'Retry download');
});

test('settings update actions use stable equal-height two-row grid markup in every primary state', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');

  assert.match(html, /class="update-action-grid"/);
  assert.match(html, /id="checkUpdateButton"[\s\S]+data-view-update[\s\S]+class="primary-button update-primary-action"[^>]+data-download-update/);
  assert.match(css, /\.update-action-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.update-action-grid > button \{[^}]*height: 44px;[^}]*min-height: 44px/);
  assert.match(css, /\.update-action-grid \.update-primary-action \{ grid-column: 1 \/ -1; \}/);
  assert.match(renderer, /button\.textContent = view\.downloadLabel/);
  assert.match(renderer, /button\.textContent = view\.installLabel/);

  let state = setInstalledVersion(createUpdateUiState(), '2.1.13');
  state = applyUpdateStatus(state, { state: 'available', version: '2.1.14' });
  assert.equal(updateUiView(state).downloadLabel, 'Download update');
  state = applyUpdateStatus(state, { state: 'downloading', version: '2.1.14', percent: 40 });
  assert.equal(updateUiView(state).downloadVisible, true);
  state = applyUpdateStatus(state, { state: 'ready', version: '2.1.14' });
  assert.equal(updateUiView(state).installVisible, true);
  assert.equal(updateUiView(state).installLabel, 'Restart and install');
  state = applyUpdateStatus(state, { state: 'installing', version: '2.1.14' });
  assert.equal(updateUiView(state).installDisabled, true);
  assert.equal(updateUiView(state).installLabel, 'Restarting to install…');
});

test('notification markup and styles preserve accessibility, minimum sizing and reduced motion', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../main-process.js', import.meta.url), 'utf8');
  const service = fs.readFileSync(new URL('../update-service.js', import.meta.url), 'utf8');

  assert.match(html, /aria-label="Dismiss update notification"/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /data-download-update/);
  assert.match(html, /data-restart-update/);
  assert.match(html, /data-view-update/);
  assert.match(html, /<progress[^>]+max="100"/);
  assert.match(html, /id="notificationLayer"[^>]+popover="manual"/);
  assert.match(css, /\.notification-layer \{[^}]*position: fixed;[^}]*z-index: 2147483647/);
  assert.match(css, /\.update-notification-region \{[^}]*width: min\(340px/);
  assert.match(css, /max-width: 340px/);
  assert.match(css, /rgba\(7, 29, 67, 0\.84\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.doesNotMatch(css, /\.app-shell\.update-notification-visible/);
  assert.match(main, /update:download/);
  assert.match(main, /update:restart-and-install/);
  assert.match(service, /autoDownload = false/);
  assert.match(service, /autoInstallOnAppQuit = false/);
});
