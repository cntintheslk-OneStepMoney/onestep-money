import './subscriptions-ui.js';
import './subscription-cancellation-ui.js';

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function createUpdateUiState() {
  return {
    installedVersion: '',
    availableVersion: '',
    downloadedVersion: '',
    downloadPercent: 0,
    notificationDismissed: false,
    statusState: 'idle',
    statusMessage: 'Updates are checked automatically. Downloads and installation only start when you choose.'
  };
}

export function setInstalledVersion(state, value) {
  const version = normaliseVersion(value);
  return { ...state, installedVersion: version };
}

export function applyUpdateStatus(state, status = {}) {
  const statusState = String(status.state || 'idle');
  const next = {
    ...state,
    statusState,
    statusMessage: String(status.message || 'Update status unavailable.')
  };

  if (['available', 'downloading', 'ready', 'installing'].includes(statusState)) {
    const version = normaliseVersion(status.version);
    if (version && version !== next.availableVersion) {
      next.availableVersion = version;
      next.downloadedVersion = '';
      next.downloadPercent = 0;
    }
    if (statusState === 'downloading') next.downloadPercent = clampPercent(status.percent);
    if (statusState === 'ready' && version) {
      next.downloadedVersion = version;
      next.downloadPercent = 100;
    }
  } else if (statusState === 'current') {
    next.availableVersion = '';
    next.downloadedVersion = '';
    next.downloadPercent = 0;
  }

  return next;
}

export function dismissUpdateNotification(state) {
  return { ...state, notificationDismissed: true };
}

export function updateUiView(state) {
  const hasUpdate = Boolean(state.availableVersion);
  const updateReady = hasUpdate && state.downloadedVersion === state.availableVersion;
  const downloading = hasUpdate && state.statusState === 'downloading';
  const installing = hasUpdate && state.statusState === 'installing';
  const installedLabel = state.installedVersion ? `v${state.installedVersion}` : 'Version unavailable';
  const versionSuffix = updateReady ? 'Update ready' : hasUpdate ? 'Update available' : '';
  const notificationTitle = installing ? 'Restarting to install' : updateReady ? 'Ready to install' : downloading ? 'Downloading update' : 'Update available';

  return {
    versionLabel: versionSuffix ? `${installedLabel} · ${versionSuffix}` : installedLabel,
    versionAriaLabel: versionSuffix ? `OneStep Money ${installedLabel}. ${versionSuffix}.` : `OneStep Money ${installedLabel}.`,
    notificationVisible: hasUpdate && !state.notificationDismissed,
    notificationTitle,
    notificationMessage: hasUpdate
      ? installing
        ? `OneStep is restarting to install v${state.availableVersion}.`
        : updateReady
        ? `OneStep Money v${state.availableVersion} has downloaded. Restart when you’re ready to install it.`
        : downloading
          ? `OneStep Money v${state.availableVersion} is downloading. You can keep using the app.`
          : `OneStep Money v${state.availableVersion} is available.`
      : '',
    settingsStatus: state.statusMessage,
    checkDisabled: ['checking', 'downloading', 'installing'].includes(state.statusState),
    downloadVisible: hasUpdate && !updateReady,
    downloadDisabled: downloading || installing,
    downloadLabel: downloading ? 'Downloading update…' : state.statusState === 'unavailable' ? 'Retry download' : 'Download update',
    installVisible: updateReady,
    installDisabled: installing,
    installLabel: installing ? 'Restarting to install…' : 'Restart and install',
    viewUpdateVisible: hasUpdate,
    progressVisible: downloading,
    progressValue: state.downloadPercent,
    progressLabel: `Update download ${Math.round(state.downloadPercent)}% complete`
  };
}

function normaliseVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  return STABLE_VERSION_PATTERN.test(version) ? version : '';
}

function clampPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, percent));
}
