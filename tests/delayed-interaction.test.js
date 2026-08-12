import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('delayed packaged-style update status cannot take mouse interaction away from the app', async () => {
  const [html, renderer, preload, smoke] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../preload-bridge.cjs', import.meta.url), 'utf8'),
    fs.readFile(new URL('../interaction-smoke-main.js', import.meta.url), 'utf8')
  ]);

  assert.doesNotMatch(html, /id="notificationLayer"[^>]+popover=/);
  assert.doesNotMatch(renderer, /showPopover|hidePopover|:popover-open/);
  assert.doesNotMatch(preload, /executeInMainWorld|Element\.prototype\.matches|HTMLElement\.prototype\.(?:showPopover|hidePopover)/);
  assert.match(smoke, /await delay\(3600\)/);
  assert.match(smoke, /webContents\.send\('update:status'/);
  assert.match(smoke, /Delayed Settings/);
  assert.match(smoke, /Delayed Dashboard/);
  assert.match(smoke, /assertDashboardControl\(browserWindow, 'Delayed'\)/);
  assert.match(smoke, /hasPopoverAttribute/);
  assert.match(smoke, /before-quit/);
});
