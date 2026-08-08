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
  constructor({
    autoUpdater,
    isPackaged,
    getCurrentVersion,
    sendStatus,
    recordFailure,
    openExternal,
    previouslyDownloadedVersion,
    rememberDownloadedVersion = () => {},
    forgetDownloadedVersion = () => {}
  }) {
    this.autoUpdater = autoUpdater;
    this.isPackaged = Boolean(isPackaged);
    this.getCurrentVersion = getCurrentVersion;
    this.sendStatus = sendStatus;
    this.recordFailure = recordFailure;
    this.openExternal = openExternal;
    this.previouslyDownloadedVersion = normaliseStableVersion(previouslyDownloadedVersion);
    this.rememberDownloadedVersion = rememberDownloadedVersion;
    this.forgetDownloadedVersion = forgetDownloadedVersion;
    this.activeCheck = null;
    this.activeDownload = null;
    this.availableVersion = null;
    this.downloadedVersion = null;
    this.installerPrepared = false;
    this.lastKnownStatus = null;
    this.installRequested = false;
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
    this.autoUpdater.on('download-progress', (progress) => this.handleDownloadProgress(progress));
    this.autoUpdater.on('update-downloaded', (info) => this.handleUpdateDownloaded(info));
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
        await this.recordOperationFailure(error, check);
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

  async downloadAvailableUpdate() {
    if (!this.isPackaged) throw new Error('Updates cannot be downloaded in development mode.');
    if (!this.availableVersion) throw new Error('There is no available update to download.');
    if (this.downloadedVersion === this.availableVersion) return this.getStatus();
    if (this.activeDownload) return this.activeDownload.promise;

    const download = { failurePromise: null, result: null, promise: null };
    this.activeDownload = download;
    this.lastKnownStatus = this.status('downloading', `Downloading OneStep Money v${this.availableVersion}…`, {
      version: this.availableVersion,
      percent: 0
    });
    this.sendStatus(this.lastKnownStatus);

    download.promise = (async () => {
      try {
        await this.autoUpdater.downloadUpdate();
        if (this.downloadedVersion !== this.availableVersion) {
          this.handleUpdateDownloaded({ version: this.availableVersion });
        }
        return this.lastKnownStatus;
      } catch (error) {
        await this.recordOperationFailure(error, download);
        if (!download.result) this.finishDownloadFailure(download);
        throw error;
      } finally {
        if (this.activeDownload === download) this.activeDownload = null;
      }
    })();

    return download.promise;
  }

  async restartAndInstall() {
    if (!this.isPackaged) throw new Error('Updates cannot be installed in development mode.');
    if (!this.availableVersion || this.downloadedVersion !== this.availableVersion) {
      throw new Error('The update has not finished downloading.');
    }
    if (this.installRequested) return this.lastKnownStatus;

    this.installRequested = true;
    if (!this.installerPrepared) {
      this.lastKnownStatus = this.status('downloading', `Preparing OneStep Money v${this.availableVersion} for installation…`, {
        version: this.availableVersion,
        percent: 100
      });
      this.sendStatus(this.lastKnownStatus);
      try {
        await this.autoUpdater.downloadUpdate();
        if (!this.installerPrepared) throw new Error('The cached update could not be prepared for installation.');
      } catch (error) {
        this.installRequested = false;
        await this.recordOperationFailure(error);
        this.lastKnownStatus = this.status('ready', 'The downloaded update could not be prepared. Choose Restart and install to try again.', {
          version: this.availableVersion
        });
        this.sendStatus(this.lastKnownStatus);
        throw error;
      }
    }

    this.lastKnownStatus = this.status('installing', `Restarting to install OneStep Money v${this.availableVersion}…`, {
      version: this.availableVersion
    });
    this.sendStatus(this.lastKnownStatus);
    this.autoUpdater.quitAndInstall(false, true);
    return this.lastKnownStatus;
  }

  async openAvailableRelease() {
    const url = buildTrustedReleaseUrl(this.availableVersion);
    if (!isTrustedReleaseUrl(url)) throw new TypeError('The update release destination is not trusted.');
    await this.openExternal(url);
    return { opened: true, version: this.availableVersion };
  }

  getStatus() {
    if (!this.isPackaged) return this.status('development', 'Updates are disabled in development mode.');
    if (['downloading', 'installing'].includes(this.lastKnownStatus?.state) && this.lastKnownStatus.version === this.availableVersion) {
      return this.lastKnownStatus;
    }
    if (this.downloadedVersion && this.downloadedVersion === this.availableVersion) {
      if (this.lastKnownStatus?.state === 'ready' && this.lastKnownStatus.version === this.downloadedVersion) return this.lastKnownStatus;
      return this.status('ready', `OneStep Money v${this.downloadedVersion} is ready to install.`, { version: this.downloadedVersion });
    }
    if (this.availableVersion) {
      if (this.lastKnownStatus?.state === 'available' && this.lastKnownStatus.version === this.availableVersion) return this.lastKnownStatus;
      return this.status('available', `OneStep Money v${this.availableVersion} is available.`, { version: this.availableVersion });
    }
    return this.lastKnownStatus || this.status('idle', 'Updates are checked automatically. Downloads and installation only start when you choose.');
  }

  handleUpdateAvailable(info = {}) {
    const version = normaliseStableVersion(info.version);
    if (!version) {
      const error = new TypeError('Update metadata did not contain a stable semantic version.');
      this.recordOperationFailure(error, this.activeCheck);
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

    if (this.availableVersion !== version) {
      this.downloadedVersion = this.previouslyDownloadedVersion === version ? version : null;
      this.installerPrepared = false;
      if (this.previouslyDownloadedVersion && this.previouslyDownloadedVersion !== version) this.forgetRememberedDownload();
    }
    this.availableVersion = version;
    const status = this.downloadedVersion === version
      ? this.status('ready', `OneStep Money v${version} is ready to install.`, { version })
      : this.status('available', `OneStep Money v${version} is available.`, { version });
    this.lastKnownStatus = status;
    if (this.activeCheck) this.activeCheck.result = status;
    this.sendStatus(status);
  }

  handleUpdateNotAvailable() {
    this.availableVersion = null;
    this.downloadedVersion = null;
    this.installerPrepared = false;
    this.forgetRememberedDownload();
    const status = this.status('current', 'You’re up to date.');
    this.lastKnownStatus = status;
    if (this.activeCheck) {
      this.activeCheck.result = status;
      if (this.activeCheck.manual) this.sendStatus(status);
    }
  }

  handleDownloadProgress(progress = {}) {
    if (!this.activeDownload || !this.availableVersion) return;
    const percent = clampPercent(progress.percent);
    this.lastKnownStatus = this.status('downloading', `Downloading OneStep Money v${this.availableVersion}… ${Math.round(percent)}%`, {
      version: this.availableVersion,
      percent
    });
    this.sendStatus(this.lastKnownStatus);
  }

  handleUpdateDownloaded(info = {}) {
    const version = normaliseStableVersion(info.version) || this.availableVersion;
    if (!version || version !== this.availableVersion) return;
    this.downloadedVersion = version;
    this.installerPrepared = true;
    this.previouslyDownloadedVersion = version;
    Promise.resolve(this.rememberDownloadedVersion(version)).catch(() => {});
    const status = this.status('ready', `OneStep Money v${version} is ready to install.`, { version });
    this.lastKnownStatus = status;
    if (this.activeDownload) this.activeDownload.result = status;
    this.sendStatus(status);
  }

  handleUpdateError(error) {
    const operation = this.activeDownload || this.activeCheck;
    this.recordOperationFailure(error, operation);
    if (this.activeDownload && !this.activeDownload.result) {
      this.finishDownloadFailure(this.activeDownload);
      return;
    }
    if (this.installRequested && this.availableVersion) {
      this.installRequested = false;
      this.lastKnownStatus = this.status('ready', 'The update could not be installed. You can try again when ready.', { version: this.availableVersion });
      this.sendStatus(this.lastKnownStatus);
      return;
    }
    if (this.activeCheck && !this.activeCheck.result) {
      this.activeCheck.result = this.status('unavailable', 'The update check couldn’t be completed.');
      if (this.activeCheck.manual) this.lastKnownStatus = this.activeCheck.result;
    }
  }

  finishDownloadFailure(download) {
    const status = this.status('available', 'The update couldn’t be downloaded. Check your connection and try again.', {
      version: this.availableVersion
    });
    download.result = status;
    this.lastKnownStatus = status;
    this.sendStatus(status);
  }

  recordOperationFailure(error, operation) {
    if (operation?.failurePromise) return operation.failurePromise;
    const failurePromise = Promise.resolve(this.recordFailure(error)).catch(() => {});
    if (operation) operation.failurePromise = failurePromise;
    return failurePromise;
  }

  forgetRememberedDownload() {
    this.previouslyDownloadedVersion = null;
    Promise.resolve(this.forgetDownloadedVersion()).catch(() => {});
  }

  status(state, message, extra = {}) {
    return { state, message, currentVersion: this.getCurrentVersion(), ...extra };
  }
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
