import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  buildTrustedReleaseUrl, isTrustedReleaseUrl, SafeUpdateService
} from '../update-service.js';

test('updater keeps automatic download and install-on-quit disabled', () => {
  const harness = createHarness();
  harness.service.configure();

  assert.equal(harness.updater.autoDownload, false);
  assert.equal(harness.updater.autoInstallOnAppQuit, false);
  assert.equal(harness.updater.allowPrerelease, false);
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(harness.updater.installCalls, 0);
});

test('automatic availability check announces an update without downloading it', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-available', { version: '2.1.14' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: false });

  assert.equal(result.state, 'available');
  assert.equal(result.version, '2.1.14');
  assert.deepEqual(harness.statuses, [{
    state: 'available',
    message: 'OneStep Money v2.1.14 is available.',
    currentVersion: '2.1.13',
    version: '2.1.14'
  }]);
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(harness.updater.installCalls, 0);
});

test('download starts only after explicit action and reports progress before becoming ready', async () => {
  const harness = createHarness({
    download: async (updater) => {
      updater.emit('download-progress', { percent: 47.6 });
      updater.emit('update-downloaded', { version: '2.1.14', downloadedFile: '/private/cache/update.exe' });
      return ['/private/cache/update.exe'];
    }
  });
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });
  harness.statuses.length = 0;

  const result = await harness.service.downloadAvailableUpdate();

  assert.equal(harness.updater.downloadCalls, 1);
  assert.deepEqual(harness.statuses.map((status) => status.state), ['downloading', 'downloading', 'ready']);
  assert.equal(harness.statuses[1].percent, 47.6);
  assert.equal(result.state, 'ready');
  assert.equal(result.version, '2.1.14');
  assert.equal('downloadedFile' in result, false);
  assert.equal(harness.updater.installCalls, 0);
});

test('restart and install is unreachable until the explicit download finishes', async () => {
  const harness = createHarness({
    download: async (updater) => updater.emit('update-downloaded', { version: '2.1.14' })
  });
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });

  await assert.rejects(harness.service.restartAndInstall(), /not finished downloading/);
  assert.equal(harness.updater.installCalls, 0);

  await harness.service.downloadAvailableUpdate();
  const result = await harness.service.restartAndInstall();

  assert.equal(result.state, 'installing');
  assert.deepEqual(harness.updater.installArguments, [[false, true]]);
  assert.equal(harness.updater.installCalls, 1);
});

test('a previously downloaded update is remembered and cache-validated before later installation', async () => {
  const harness = createHarness({
    previouslyDownloadedVersion: '2.1.14',
    download: async (updater) => updater.emit('update-downloaded', { version: '2.1.14' })
  });
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });

  assert.equal(harness.service.getStatus().state, 'ready');
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(harness.updater.installCalls, 0);

  const result = await harness.service.restartAndInstall();

  assert.equal(result.state, 'installing');
  assert.equal(harness.updater.downloadCalls, 1);
  assert.equal(harness.updater.installCalls, 1);
  assert.deepEqual(harness.remembered, ['2.1.14']);
});

test('normal app quit remains unrelated to update installation', async () => {
  const harness = createHarness();
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });

  harness.updater.emit('app-quit');

  assert.equal(harness.updater.autoInstallOnAppQuit, false);
  assert.equal(harness.updater.installCalls, 0);
});

test('download failure keeps the available update actionable and records only technical failure detail', async () => {
  const harness = createHarness({ download: async () => { throw new Error('offline'); } });
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });
  harness.statuses.length = 0;

  await assert.rejects(harness.service.downloadAvailableUpdate(), /offline/);

  assert.equal(harness.updater.downloadCalls, 1);
  assert.equal(harness.service.getStatus().state, 'available');
  assert.match(harness.service.getStatus().message, /couldn’t be downloaded/);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.updater.installCalls, 0);
});

test('automatic current and failure results stay silent while manual checks receive calm feedback', async () => {
  const current = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.13' })
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

test('manual current check reports completion without downloading', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.13' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: true });

  assert.equal(result.state, 'current');
  assert.deepEqual(harness.statuses.map((status) => status.state), ['checking', 'current']);
  assert.equal(harness.updater.downloadCalls, 0);
});

test('development builds neither schedule nor perform production update work', async () => {
  const harness = createHarness({ packaged: false });
  harness.service.configure();
  const scheduled = [];

  assert.equal(harness.service.scheduleAutomaticCheck(4000, (...args) => scheduled.push(args)), false);
  assert.equal((await harness.service.check({ manual: false })).state, 'development');
  await assert.rejects(harness.service.downloadAvailableUpdate(), /development mode/);
  await assert.rejects(harness.service.restartAndInstall(), /development mode/);
  assert.equal(harness.updater.checkCalls, 0);
  assert.equal(harness.updater.downloadCalls, 0);
  assert.equal(scheduled.length, 0);
});

test('packaged automatic check is scheduled once after the requested delay', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-not-available', { version: '2.1.13' })
  });
  harness.service.configure();
  let callback;
  let delay;

  assert.equal(harness.service.scheduleAutomaticCheck(4000, (next, wait) => { callback = next; delay = wait; }), true);
  assert.equal(delay, 4000);
  callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.updater.checkCalls, 1);
  assert.equal(harness.updater.downloadCalls, 0);
});

test('prerelease metadata is rejected even if a provider emits it', async () => {
  const harness = createHarness({
    check: async (updater) => updater.emit('update-available', { version: '2.1.14-beta.1' })
  });
  harness.service.configure();

  const result = await harness.service.check({ manual: true });

  assert.equal(result.state, 'unavailable');
  assert.equal(harness.service.availableVersion, null);
  assert.deepEqual(harness.statuses.map((status) => status.state), ['checking', 'unavailable']);
  assert.equal(harness.failures.length, 1);
  assert.equal(harness.updater.downloadCalls, 0);
});

test('release opening remains optional and restricted to the trusted stable tag path', async () => {
  const harness = createHarness();
  harness.service.configure();
  harness.updater.emit('update-available', { version: '2.1.14' });

  const result = await harness.service.openAvailableRelease();

  assert.deepEqual(result, { opened: true, version: '2.1.14' });
  assert.deepEqual(harness.opened, ['https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.14']);
  assert.equal(buildTrustedReleaseUrl('v2.1.14'), harness.opened[0]);
  for (const url of [
    'http://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.14',
    'https://example.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.14',
    'file:///tmp/update.exe',
    'javascript:alert(1)',
    'https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/download/v2.1.14/update.exe',
    'https://github.com/cntintheslk-OneStepMoney/onestep-money/releases/tag/v2.1.14-beta.1'
  ]) assert.equal(isTrustedReleaseUrl(url), false, url);
});

function createHarness({ packaged = true, check, download, previouslyDownloadedVersion } = {}) {
  const updater = new MockUpdater({ check, download });
  const statuses = [];
  const failures = [];
  const opened = [];
  const remembered = [];
  let forgotten = 0;
  const service = new SafeUpdateService({
    autoUpdater: updater,
    isPackaged: packaged,
    getCurrentVersion: () => '2.1.13',
    sendStatus: (status) => statuses.push(status),
    recordFailure: async (error) => failures.push(error),
    openExternal: async (url) => opened.push(url),
    previouslyDownloadedVersion,
    rememberDownloadedVersion: async (version) => remembered.push(version),
    forgetDownloadedVersion: async () => { forgotten += 1; }
  });
  return { service, updater, statuses, failures, opened, remembered, get forgotten() { return forgotten; } };
}

class MockUpdater extends EventEmitter {
  constructor({ check, download }) {
    super();
    this.check = check || (async (updater) => updater.emit('update-not-available', { version: '2.1.13' }));
    this.download = download || (async (updater) => updater.emit('update-downloaded', { version: '2.1.14' }));
    this.checkCalls = 0;
    this.downloadCalls = 0;
    this.installCalls = 0;
    this.installArguments = [];
  }

  async checkForUpdates() {
    this.checkCalls += 1;
    return this.check(this);
  }

  async downloadUpdate() {
    this.downloadCalls += 1;
    return this.download(this);
  }

  quitAndInstall(...args) {
    this.installCalls += 1;
    this.installArguments.push(args);
  }
}
