const RELEASE_ORIGIN = 'https://github.com';
const RELEASE_PATH_PREFIX = '/cntintheslk-OneStepMoney/onestep-money/releases/tag/v';
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function normaliseStableVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  return STABLE_VERSION_PATTERN.test(version) ? version : null;
}

export function buildTrustedReleaseUrl(value) {
  const version = normaliseStableVersion(value);
  if (!version) throw new TypeError('The available update version is not a stable semantic version.');
  return `${RELEASE_ORIGIN}${RELEASE_PATH_PREFIX}${version}`;
}

export function isTrustedReleaseUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'https:' || url.origin !== RELEASE_ORIGIN || url.username || url.password || url.search || url.hash) return false;
    return new RegExp(`^${escapeRegExp(RELEASE_PATH_PREFIX)}${STABLE_VERSION_PATTERN.source.slice(1, -1)}$`).test(url.pathname);
  } catch {
    return false;
  }
}

export class SafeUpdateService {
  constructor({ autoUpdater, isPackaged, getCurrentVersion, sendStatus, recordFailure, openExternal }) {
    this.autoUpdater = autoUpdater;
    this.isPackaged = Boolean(isPackaged);
    this.getCurrentVersion = getCurrentVersion;
    this.sendStatus = sendStatus;
    this.recordFailure = recordFailure;
    this.openExternal = openExternal;
    this.activeCheck = null;
    this.availableVersion = null;
    this.lastKnownStatus = null;
    this.configured = false;
  }

  configure() {
    if (this.configured) return;
    this.configured = true;
    this.autoUpdater.autoDownload = false;
    this.autoUpdater.autoInstallOnAppQuit = false;
    this.autoUpdater.allowPrerelease = false;
    this.autoUpdater.on('update-available', (info) => this.handleUpdateAvailable(info));
    this.autoUpdater.on('update-not-available', () => this.handleUpdateNotAvailable());
    this.autoUpdater.on('error', (error) => this.handleUpdateError(error));
  }

  scheduleAutomaticCheck(delay = 4000, schedule = setTimeout) {
    if (!this.isPackaged) return false;
    schedule(() => { this.check({ manual: false }).catch(() => {}); }, delay);
    return true;
  }

  async check({ manual = false } = {}) {
    if (!this.isPackaged) {
      const status = this.status('development', 'Updates are disabled in development mode.');
      this.lastKnownStatus = status;
      if (manual) this.sendStatus(status);
      return status;
    }

    if (this.activeCheck) {
      if (manual && !this.activeCheck.manual) {
        this.activeCheck.manual = true;
        this.lastKnownStatus = this.status('checking', 'Checking for updates…');
        this.sendStatus(this.lastKnownStatus);
      }
      return this.activeCheck.promise;
    }

    const check = { manual: Boolean(manual), result: null, failurePromise: null, promise: null };
    this.activeCheck = check;
    if (check.manual) {
      this.lastKnownStatus = this.status('checking', 'Checking for updates…');
      this.sendStatus(this.lastKnownStatus);
    }

    check.promise = (async () => {
      try {
        await this.autoUpdater.checkForUpdates();
        const status = check.result || this.status('current', 'You’re up to date.');
        if (!check.result) this.lastKnownStatus = status;
        return status;
      } catch (error) {
        await this.recordCheckFailure(error, check);
        const status = check.result?.state === 'unavailable'
          ? check.result
          : this.status('unavailable', 'The update check couldn’t be completed.');
        check.result = status;
        if (check.manual) {
          this.lastKnownStatus = status;
          this.sendStatus(status);
        }
        return status;
      } finally {
        if (this.activeCheck === check) this.activeCheck = null;
      }
    })();

    return check.promise;
  }

  async openAvailableRelease() {
    const url = buildTrustedReleaseUrl(this.availableVersion);
    if (!isTrustedReleaseUrl(url)) throw new TypeError('The update release destination is not trusted.');
    await this.openExternal(url);
    return { opened: true, version: this.availableVersion };
  }

  getStatus() {
    if (!this.isPackaged) return this.status('development', 'Updates are disabled in development mode.');
    if (this.availableVersion) {
      return this.status('available', `OneStep Money v${this.availableVersion} is available.`, { version: this.availableVersion });
    }
    return this.lastKnownStatus || this.status('idle', 'Updates are checked automatically. OneStep never downloads or installs them.');
  }

  handleUpdateAvailable(info = {}) {
    const version = normaliseStableVersion(info.version);
    if (!version) {
      const error = new TypeError('Update metadata did not contain a stable semantic version.');
      this.recordCheckFailure(error);
      const status = this.status('unavailable', 'The update check couldn’t be completed.');
      if (this.activeCheck) {
        this.activeCheck.result = status;
        if (this.activeCheck.manual) {
          this.lastKnownStatus = status;
          this.sendStatus(status);
        }
      }
      return;
    }

    this.availableVersion = version;
    const status = this.status('available', `OneStep Money v${version} is available.`, { version });
    this.lastKnownStatus = status;
    if (this.activeCheck) this.activeCheck.result = status;
    this.sendStatus(status);
  }

  handleUpdateNotAvailable() {
    this.availableVersion = null;
    const status = this.status('current', 'You’re up to date.');
    this.lastKnownStatus = status;
    if (this.activeCheck) {
      this.activeCheck.result = status;
      if (this.activeCheck.manual) this.sendStatus(status);
    }
  }

  handleUpdateError(error) {
    this.recordCheckFailure(error);
    if (this.activeCheck && !this.activeCheck.result) {
      this.activeCheck.result = this.status('unavailable', 'The update check couldn’t be completed.');
      if (this.activeCheck.manual) this.lastKnownStatus = this.activeCheck.result;
    }
  }

  recordCheckFailure(error, check = this.activeCheck) {
    if (check?.failurePromise) return check.failurePromise;
    const failurePromise = Promise.resolve(this.recordFailure(error)).catch(() => {});
    if (check) check.failurePromise = failurePromise;
    return failurePromise;
  }

  status(state, message, extra = {}) {
    return { state, message, currentVersion: this.getCurrentVersion(), ...extra };
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
