const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function createUpdateUiState() {
  return {
    installedVersion: '',
    availableVersion: '',
    notificationDismissed: false,
    statusState: 'idle',
    statusMessage: 'Updates are checked automatically. OneStep never downloads or installs them.'
  };
}

export function setInstalledVersion(state, value) {
  const version = normaliseVersion(value);
  return { ...state, installedVersion: version };
}

export function applyUpdateStatus(state, status = {}) {
  const next = {
    ...state,
    statusState: String(status.state || 'idle'),
    statusMessage: String(status.message || 'Update status unavailable.')
  };

  if (next.statusState === 'available') {
    const version = normaliseVersion(status.version);
    if (version) next.availableVersion = version;
  } else if (next.statusState === 'current') {
    next.availableVersion = '';
  }

  return next;
}

export function dismissUpdateNotification(state) {
  return { ...state, notificationDismissed: true };
}

export function updateUiView(state) {
  const hasUpdate = Boolean(state.availableVersion);
  const installedLabel = state.installedVersion ? `v${state.installedVersion}` : 'Version unavailable';
  return {
    versionLabel: hasUpdate ? `${installedLabel} · Update available` : installedLabel,
    versionAriaLabel: hasUpdate ? `OneStep Money ${installedLabel}. Update available.` : `OneStep Money ${installedLabel}.`,
    notificationVisible: hasUpdate && !state.notificationDismissed,
    notificationMessage: hasUpdate ? `OneStep Money v${state.availableVersion} is available.` : '',
    settingsStatus: state.statusMessage,
    checkDisabled: state.statusState === 'checking',
    viewUpdateVisible: hasUpdate
  };
}

function normaliseVersion(value) {
  const version = String(value || '').trim().replace(/^v/i, '');
  return STABLE_VERSION_PATTERN.test(version) ? version : '';
}
