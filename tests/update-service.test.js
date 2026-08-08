import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  buildTrustedReleaseUrl, isTrustedReleaseUrl, SafeUpdateService
} from '../update-service.js';

test('updater is configured for stable availability checks without download or install', () => {
  const harness = createHarness();
  harness.service.configure();

  assert.equal(harness.updater.autoDownload, false);
  assert.equal(harness.updater.autoInstallOnAppQuit, false);
  assert.equal(harness.updater.allowPrerelease, false);
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(harness.updater.installCalls, 0);
});

test('automatic update availability is announced without downloading or staging an installer', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-available', { version: '2.1.11' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: false });

  assert.equal(result.state, 'available');
  assert.equal(result.version, '2.1.11');
  assert.deepEqual(harness.statuses, [{
    state: 'available',
    message: 'OneStep Money v2.1.11 is available.',
    currentVersion: '2.1.10',
    version: '2.1.11'
  }]);
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(harness.updater.installCalls, 0);
});

test('automatic current and failure results stay silent while manual checks receive calm feedback', async () => {
  const current = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.10' })
  });
  current.service.configure();
  assert.equal((await current.service.check({ manual: false })).state, 'current');
  assert.deepEqual(current.statuses, []);

  const failedAutomatic = createHarness({ check: async () => { throw new Error('offline'); } });
  failedAutomatic.service.configure();
  assert.equal((await failedAutomatic.service.check({ manual: false })).state, 'unavailable');
  assert.deepEqual(failedAutomatic.statuses, []);
  assert.equal(failedAutomatic.failures.length, 1);

  const failedManual = createHarness({ check: async () => { throw new Error('offline'); } });
  failedManual.service.configure();
  assert.equal((await failedManual.service.check({ manual: true })).state, 'unavailable');
  assert.deepEqual(failedManual.statuses.map((status) => status.state), ['checking', 'unavailable']);
});

test('manual current check reports completion and never uses download states', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.10' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: true });

  assert.equal(result.state, 'current');
  assert.deepEqual(harness.statuses.map((status) => status.state), ['checking', 'current']);
  assert.ok(harness.statuses.every((status) => !['downloading', 'ready'].includes(status.state)));
});

test('development builds neither schedule nor perform production update checks', async () => {
  const harness = createHarness({ packaged: false });
  harness.service.configure();
  const scheduled = [];

  assert.equal(harness.service.scheduleAutomaticCheck(4000, (...args) => scheduled.push(args)), false);
  assert.equal((await harness.service.check({ manual: false })).state, 'development');
  assert.equal(harness.updater.checkCalls, 0);
  assert.equal(scheduled.length, 0);
});

test('packaged automatic check is scheduled once after the requested delay', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.10' })
  });
  harness.service.configure();
  let callback;
  let delay;

  assert.equal(harness.service.scheduleAutomaticCheck(4000, (next, wait) => { callback = next; delay = wait; }), true);
  assert.equal(delay, 4000);
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.updater.checkCalls, 1);
});

test('prerelease metadata is rejected even if a provider emits it', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-available', { version: '2.1.11-beta.1' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: true });

  assert.equal(result.state, 'unavailable');
  assert.equal(harness.service.availableVersion, null);
  assert.deepEqual(harness.statuses.map((status) => status.state), ['checking', 'unavailable']);
  assert.equal(harness.failures.length, 1);
});

test('release opening is built in the service and restricted to the trusted stable tag path', async () => {
  const harness = createHarness();
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.11' });

  const result = await harness.service.openAvailableRelease();

  assert.deepEqual(result, { opened: true, version: '2.1.11' });
  assert.deepEqual(harness.opened, ['https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.11']);
  assert.equal(buildTrustedReleaseUrl('v2.1.11'), harness.opened[0]);
  for (const url of [
    'http://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.11',
    'https://example.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.11',
    'file:///tmp/update.exe',
    'javascript:alert(1)',
    'https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/download/v2.1.11/update.exe',
    'https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.11-beta.1'
  ]) assert.equal(isTrustedReleaseUrl(url), false, url);
});

function createHarness({ packaged = true, check } = {}) {
  const updater = new MockUpdater(check);
  const statuses = [];
  const failures = [];
  const opened = [];
  const service = new SafeUpdateService({
    autoUpdater: updater,
    isPackaged: packaged,
    getCurrentVersion: () => '2.1.10',
    sendStatus: (status) => statuses.push(status),
    recordFailure: async (error) => failures.push(error),
    openExternal: async (url) => opened.push(url)
  });
  return { service, updater, statuses, failures, opened };
}

class MockUpdater extends EventEmitter {
  constructor(check) {
    super();
    this.check = check || (async (updater) => updater.emit('update-not-available', { version: '2.1.10' }));
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = 0;
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.check(this);
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
  }

  quitAndInstall() {
    this.installCalls += 1;
  }
}
