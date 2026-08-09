import {
  ALL_TIME_PERIOD, availableReportingMonths, buildFallbackAnswer, buildFinancialChecks,
  calculatePeriodSummary, calculateStreak, createId, debtPlan, debtSafetyAssessment, exportTransactionsCsv,
  findSavingsOpportunities, formatCurrency, formatDate, hasCompletedCheckIn, INCOME_PAYMENT_CATEGORY, isIncomePayment,
  periodTransactions, removeBudgetCategory, reportingPeriodMonthCount, resolvePossibleDuplicate
} from './finance-core.js';
import { applyCreditReportImportPlan, buildCreditReportImportPlan } from './credit-report-intelligence.js';
import { applyStatementImportPlan, buildStatementImportPlan } from './statement-intelligence.js';
import { buildPayslipRecord, payslipEditorItem } from './payslip-record.js';
import {
  applyUpdateStatus, createUpdateUiState, dismissUpdateNotification as dismissUpdateUiNotification,
  setInstalledVersion, updateUiView
} from './update-ui.js';
import {
  buildTransactionLedgerIndex, filterTransactionLedger, INCOME_PAYMENT_CATEGORY_VALUE,
  paginateTransactionLedger
} from './transaction-ledger.js';
import {
  knownPaydayDay, resolveReviewItem, reviewInboxSummary, reviewItemPresentation, reviewRoute,
  snoozeReviewGroup, snoozeReviewItem, startReviewItem, synchroniseReviewItems
} from './review-lifecycle.js';
import {
  PRIORITY_DIAGNOSTIC_CODES, prioritisedReviewGroups, prioritySnapshot, selectFiveMinuteCheckIn
} from './next-move-priority.js';
import { buildFinancialReport, reportTextSummary } from './financial-reporting.js';
import {
  compareLabels, DASHBOARD_MODULES, defaultDashboardSettings, moveDashboardModule,
  normaliseDashboardSettings, THEMES, visibleDashboardModules
} from './presentation-settings.js';

let state;
let encryption;
let pendingAction;
let priorityView;
let prioritySafety;
let importQueue = [];
let currentImport = null;
let editorContext = null;
let diagnosticPreviewToken = null;
let recoveryResult = null;
let freshStartToken = null;
let restoreToken = null;
let restoreInProgress = false;
let restoreCanCancel = true;
let updateUiState = createUpdateUiState();
let normalEventsBound = false;
let recoveryEventsBound = false;
let restoreEventsBound = false;
let transactionPage = 1;
let financialViewCache = null;
let reviewGroupsById = new Map();
let welcomeBack = false;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

const viewMeta = {
  dashboard: ['YOUR MONEY AT A GLANCE', 'Dashboard'],
  today: ['ONE CLEAR MOVE', 'Today'], review: ['UNFINISHED FINANCIAL WORK', 'Review Inbox'], transactions: ['MONEY IN AND OUT', 'Payments'], pay: ['WHERE GROSS PAY GOES', 'Pay'],
  debts: ['LOANS, CARDS AND FINANCE', 'Debts'], overdrafts: ['BANK BORROWING', 'Overdrafts'], budget: ['DEPENDABLE INCOME FIRST', 'Budget'],
  guide: ['PRIVATE AND LOCAL', 'Guide'], documents: ['ENCRYPTED ON THIS DEVICE', 'Documents'], settings: ['CONTROL AND PRIVACY', 'Settings']
};

const byId = (id) => document.getElementById(id);

window.addEventListener('error', () => window.financeAPI?.recordRendererFault('RENDERER_UNHANDLED_ERROR').catch(() => {}));
window.addEventListener('unhandledrejection', () => window.financeAPI?.recordRendererFault('RENDERER_UNHANDLED_REJECTION').catch(() => {}));

initialiseNotificationLayer();
initialise();

async function initialise() {
  if (!window.financeAPI) {
    byId('desktopRequired').hidden = false;
    return;
  }
  window.financeAPI.getAppVersion()
    .then(renderAppVersion)
    .catch(() => renderAppVersion(''));
  try {
    const loaded = await window.financeAPI.loadState();
    if (loaded.status === 'recovery_required') showRecoveryMode(loaded);
    else if (loaded.status === 'normal') activateNormalMode(loaded);
    else throw new Error('The secure data store returned an unsupported startup state.');
  } catch (error) {
    byId('desktopRequired').hidden = false;
    byId('desktopRequired').querySelector('p').textContent = `The secure data store could not be opened: ${error.message}`;
  }
}

function renderAppVersion(value) {
  updateUiState = setInstalledVersion(updateUiState, value);
  renderUpdateUi();
}

function activateNormalMode(loaded) {
  state = loaded.state;
  synchroniseReviewItems(state);
  applyTheme();
  welcomeBack = Boolean(state.meta?.updatedAt && Date.now() - Date.parse(state.meta.updatedAt) >= 3 * 86_400_000);
  encryption = loaded.encryption;
  recoveryResult = null;
  freshStartToken = null;
  byId('desktopRequired').hidden = true;
  byId('recoveryScreen').hidden = true;
  byId('appShell').hidden = false;
  if (!normalEventsBound) {
    bindEvents();
    normalEventsBound = true;
  }
  populateMonthOptions();
  populateAccountOptions();
  populatePaymentCategoryOptions();
  render();
  checkModel();
}

function showRecoveryMode(result) {
  recoveryResult = result;
  byId('desktopRequired').hidden = true;
  byId('appShell').hidden = true;
  byId('recoveryScreen').hidden = false;
  if (!recoveryEventsBound) {
    bindRecoveryEvents();
    recoveryEventsBound = true;
  }
  renderRecoveryMode();
}

function bindRecoveryEvents() {
  bindRestoreEvents();
  byId('retryRecoveryButton').addEventListener('click', retryRecovery);
  byId('recoveryBackupList').addEventListener('click', restoreRecoveryBackup);
  byId('chooseRecoveryBackupButton').addEventListener('click', selectRecoveryPortableBackup);
  byId('requestFreshStartButton').addEventListener('click', requestFreshStart);
  byId('freshStartAcknowledgement').addEventListener('change', () => {
    byId('confirmFreshStartButton').disabled = !byId('freshStartAcknowledgement').checked;
  });
  byId('confirmFreshStartButton').addEventListener('click', confirmFreshStart);
  byId('freshStartDialog').addEventListener('close', cancelFreshStart);
}

function renderRecoveryMode() {
  const recovery = recoveryResult?.recovery || {};
  const reasonMessages = {
    state_not_found: 'The original state file is no longer available. OneStep will not treat this as a first installation while recovery is active.',
    read_failure: 'OneStep could not read the existing state file. This may be a temporary permission or storage problem.',
    decryption_failure: 'The existing state could not be decrypted or authenticated.',
    encryption_key_unavailable: 'The encryption service or key required to open the existing data is unavailable.',
    invalid_content: 'The existing state is incomplete or contains invalid data.',
    schema_validation_failure: 'The existing state did not pass OneStep’s data-integrity checks.',
    migration_failure: 'OneStep could not safely update the stored data to the current schema.',
    restore_interrupted: 'OneStep found a restore that did not finish. Saving remains paused while the complete datasets are preserved.',
    restore_rollback_failed: 'OneStep could not safely complete or reverse the last restore. The selected backup and safety copy have been preserved.',
    restore_journal_invalid: 'OneStep found restore-tracking data it could not safely interpret. Saving remains paused.',
    restore_interrupted_unresolved: 'OneStep could not determine which complete dataset should be active after an interrupted restore.',
    unknown_storage_failure: 'An unexpected storage error prevented OneStep from safely opening the existing data.'
  };
  byId('recoveryReason').textContent = reasonMessages[recovery.reasonCode] || reasonMessages.unknown_storage_failure;
  byId('recoveryCopyStatus').textContent = recovery.recoveryCopyCreated
    ? 'A separate byte-for-byte recovery copy was created and verified. The original file was left unchanged.'
    : 'OneStep could not verify a separate recovery copy. The original file has still not been replaced.';

  const list = byId('recoveryBackupList');
  clear(list);
  const backups = recovery.backups || [];
  const newestValid = backups.find((backup) => backup.valid);
  for (const backup of backups) {
    const card = element('article', `recovery-backup ${backup.valid ? '' : 'invalid'}`.trim());
    const copy = element('div', 'recovery-backup-copy');
    const title = backup.valid && backup.id === newestValid?.id ? 'Newest valid backup' : backup.valid ? 'Valid backup' : 'Backup could not be validated';
    const details = [formatRecoveryDate(backup.createdAt), backup.schemaVersion ? `Schema ${backup.schemaVersion}` : null, Number.isInteger(backup.documentCount) ? `${backup.documentCount} document${backup.documentCount === 1 ? '' : 's'}` : null, backup.migrationRequired ? 'Migration required' : null].filter(Boolean).join(' · ');
    append(copy, element('strong', '', title), element('span', '', details));
    card.append(copy);
    if (backup.valid) {
      const button = element('button', 'primary-button', 'Restore this backup');
      button.type = 'button';
      button.dataset.recoveryBackup = backup.id;
      card.append(button);
    } else {
      card.append(element('span', 'badge red', 'Not usable'));
    }
    list.append(card);
  }
  if (!backups.length) {
    list.append(element('p', 'muted', recovery.backupDiscoveryFailed
      ? 'OneStep could not inspect the local backup folder. You can try opening the original data again.'
      : 'No local backups were found. You can still retry opening the original data.'));
  }

  const statusMessages = {
    restore_failed: 'That backup could not be restored. Recovery mode is still active and the original state remains preserved.',
    backup_not_found: 'That backup is no longer available. Recovery mode is still active.',
    restore_rollback_failed: 'OneStep could not safely complete or reverse the restore. Saving remains paused and all recovery material has been preserved.',
    restore_interrupted: 'The restore was interrupted. OneStep has paused saving until recovery is resolved.',
    fresh_start_failed: 'A new state could not be created safely. Recovery mode is still active.',
    confirmation_invalid: 'The start-again confirmation expired. Review the warning again if you still want to continue.'
  };
  byId('recoveryStatus').textContent = statusMessages[recovery.lastOperationError] || '';
}

async function retryRecovery() {
  const button = byId('retryRecoveryButton');
  button.disabled = true;
  byId('recoveryStatus').textContent = 'Trying to open and validate the original data…';
  try {
    handleRecoveryResponse(await window.financeAPI.retryRecovery());
  } catch {
    byId('recoveryStatus').textContent = 'The data still could not be opened. Recovery mode remains active.';
  } finally {
    button.disabled = false;
  }
}

async function restoreRecoveryBackup(event) {
  const button = event.target.closest('[data-recovery-backup]');
  if (!button) return;
  button.disabled = true;
  byId('recoveryStatus').textContent = 'Preparing restore details…';
  try {
    const result = await window.financeAPI.restoreRecoveryBackup(button.dataset.recoveryBackup);
    if (!result.token) { handleRecoveryResponse(result); return; }
    restoreToken = result.token;
    restoreInProgress = false;
    restoreCanCancel = true;
    renderRestoreConfirmation(result.backup);
    byId('recoveryStatus').textContent = 'Backup checked. Review the restore details.';
    byId('restoreDialog').showModal();
  } catch (error) {
    byId('recoveryStatus').textContent = error.message || 'The backup could not be prepared. Recovery mode remains active.';
  } finally {
    button.disabled = false;
  }
}

async function selectRecoveryPortableBackup() {
  const button = byId('chooseRecoveryBackupButton');
  button.disabled = true;
  byId('recoveryStatus').textContent = 'Select an encrypted backup to check…';
  try {
    const result = await window.financeAPI.selectRecoveryPortableBackup(byId('recoveryBackupPassphrase').value);
    if (result.canceled) { byId('recoveryStatus').textContent = 'Backup selection cancelled.'; return; }
    if (!result.token) throw new Error('The backup could not be selected for recovery.');
    restoreToken = result.token;
    restoreInProgress = false;
    restoreCanCancel = true;
    renderRestoreConfirmation(result.backup);
    byId('recoveryStatus').textContent = 'Backup checked. Review the restore details.';
    byId('restoreDialog').showModal();
  } catch (error) {
    byId('recoveryStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function requestFreshStart() {
  const result = await window.financeAPI.requestFreshStart();
  if (result.status !== 'confirmation_required') {
    byId('recoveryStatus').textContent = 'The start-again confirmation could not be opened.';
    return;
  }
  freshStartToken = result.token;
  byId('freshStartAcknowledgement').checked = false;
  byId('confirmFreshStartButton').disabled = true;
  byId('freshStartStatus').textContent = '';
  byId('freshStartDialog').showModal();
}

async function confirmFreshStart() {
  if (!freshStartToken || !byId('freshStartAcknowledgement').checked) return;
  const button = byId('confirmFreshStartButton');
  button.disabled = true;
  byId('freshStartStatus').textContent = 'Preserving the original data and creating a new state…';
  const token = freshStartToken;
  try {
    const result = await window.financeAPI.confirmFreshStart(token);
    freshStartToken = null;
    byId('freshStartDialog').close('confirmed');
    handleRecoveryResponse(result);
  } catch {
    byId('freshStartStatus').textContent = 'A new state could not be created safely. Nothing has been cleared.';
    button.disabled = false;
  }
}

async function cancelFreshStart() {
  if (!freshStartToken) return;
  const token = freshStartToken;
  freshStartToken = null;
  await window.financeAPI.cancelFreshStart(token).catch(() => {});
}

function handleRecoveryResponse(result) {
  if (result?.status === 'normal') activateNormalMode(result);
  else if (result?.status === 'recovery_required') showRecoveryMode(result);
  else byId('recoveryStatus').textContent = 'Recovery could not continue. Your data has not been replaced.';
}

function formatRecoveryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function bindEvents() {
  bindRestoreEvents();
  document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
  document.querySelectorAll('[data-view-target]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.viewTarget)));
  byId('dashboardOpenNextMove').addEventListener('click', () => selectView('today'));
  document.querySelectorAll('[data-dashboard-mode]').forEach((button) => button.addEventListener('click', async () => {
    state.settings.dashboard.mode = button.dataset.dashboardMode;
    await saveAndRender();
    byId('dashboardStatus').textContent = `${titleCase(button.dataset.dashboardMode)} dashboard enabled.`;
  }));
  [byId('customiseDashboardButton'), byId('openDashboardSettingsButton')].forEach((button) => button.addEventListener('click', openDashboardCustomisation));
  byId('dashboardCustomisationList').addEventListener('click', handleDashboardCustomisation);
  byId('dashboardCustomisationList').addEventListener('change', handleDashboardCustomisation);
  byId('resetDashboardButton').addEventListener('click', resetDashboard);
  byId('themeSelect').addEventListener('change', saveThemePreference);
  systemTheme.addEventListener('change', () => {
    if (state?.settings?.appearance?.theme === 'system') applyTheme();
  });
  byId('monthSelect').addEventListener('change', async () => {
    state.settings.selectedMonth = byId('monthSelect').value;
    transactionPage = 1;
    await saveAndRender();
  });
  byId('completeActionButton').addEventListener('click', completeNextAction);
  byId('snoozeActionButton').addEventListener('click', snoozeNextAction);
  byId('quickCheckInButton').addEventListener('click', logCheckIn);
  bindSingleClickAction('importStatementButton', 'Opening…', () => importDocuments('statement'));
  bindSingleClickAction('importPayslipButton', 'Opening…', () => importDocuments('payslip'));
  bindSingleClickAction('importCreditReportButton', 'Opening…', () => importDocuments('credit-report'));
  byId('exportCsvButton').addEventListener('click', async () => {
    const saved = await window.financeAPI.exportCsv(exportTransactionsCsv(state.transactions));
    if (saved) showToast('Payments exported safely.');
  });
  [byId('transactionSearch'), byId('transactionAccountFilter'), byId('transactionTypeFilter'), byId('transactionCategoryFilter')].forEach((element) => element.addEventListener('input', () => {
    transactionPage = 1;
    renderTransactions();
  }));
  byId('transactionPreviousPage').addEventListener('click', () => {
    transactionPage = Math.max(1, transactionPage - 1);
    renderTransactions();
    focusTransactionTable();
  });
  byId('transactionNextPage').addEventListener('click', () => {
    transactionPage += 1;
    renderTransactions();
    focusTransactionTable();
  });
  document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.add)));
  byId('transactionRows').addEventListener('click', handleEditClick);
  byId('debtCards').addEventListener('click', handleEditClick);
  byId('overdraftCards').addEventListener('click', handleEditClick);
  byId('budgetRows').addEventListener('click', handleEditClick);
  byId('reviewUncategorisedButton').addEventListener('click', () => {
    byId('transactionCategoryFilter').value = 'uncategorised';
    selectView('transactions');
    renderTransactions();
  });
  byId('chartReviewUncategorisedButton').addEventListener('click', () => {
    byId('transactionCategoryFilter').value = 'uncategorised';
    renderTransactions();
    focusTransactionTable();
  });
  byId('welcomeBackReviewButton').addEventListener('click', () => selectView('review'));
  byId('reviewActiveList').addEventListener('click', handleReviewAction);
  byId('reviewSnoozedList').addEventListener('click', handleReviewAction);
  byId('checkInReviewList').addEventListener('click', handleReviewAction);
  byId('todaySupportingList').addEventListener('click', handleReviewAction);
  byId('payslipList').addEventListener('click', handleEditClick);
  byId('documentCards').addEventListener('click', handleDocumentClick);
  byId('accountCards').addEventListener('click', handleEditClick);
  bindSingleClickAction('saveEditButton', 'Saving…', saveEditor);
  bindSingleClickAction('confirmImportButton', 'Importing…', confirmCurrentImport, syncConfirmImportButton);
  byId('importDialog').addEventListener('close', handleImportDialogClosed);
  byId('importResultDialog').addEventListener('close', () => { currentImport = null; showNextImport(); });
  byId('guideForm').addEventListener('submit', askGuide);
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { byId('guideQuestion').value = button.dataset.prompt; byId('guideQuestion').focus(); }));
  byId('checkModelButton').addEventListener('click', checkModel);
  bindSingleClickAction('saveSettingsButton', 'Saving…', saveSettings);
  byId('createBackupButton').addEventListener('click', createBackup);
  byId('restoreBackupButton').addEventListener('click', restoreBackup);
  byId('checkUpdateButton').addEventListener('click', checkForUpdates);
  byId('dismissUpdateNotificationButton').addEventListener('click', dismissUpdateNotification);
  document.querySelectorAll('[data-download-update]').forEach((button) => button.addEventListener('click', downloadAvailableUpdate));
  document.querySelectorAll('[data-restart-update]').forEach((button) => button.addEventListener('click', restartAndInstallUpdate));
  document.querySelectorAll('[data-view-update]').forEach((button) => button.addEventListener('click', openAvailableUpdate));
  byId('reviewDiagnosticsButton').addEventListener('click', reviewDiagnostics);
  byId('exportDiagnosticsButton').addEventListener('click', exportDiagnostics);
  byId('deleteDiagnosticsButton').addEventListener('click', deleteDiagnostics);
  window.financeAPI.onUpdateStatus(handleUpdateStatus);
  window.financeAPI.getUpdateStatus().then(handleUpdateStatus).catch(() => {});
}

function bindRestoreEvents() {
  if (restoreEventsBound) return;
  restoreEventsBound = true;
  byId('confirmRestoreButton').addEventListener('click', confirmRestoreBackup);
  byId('cancelRestoreButton').addEventListener('click', cancelRestoreBackup);
  byId('closeRestoreButton').addEventListener('click', cancelRestoreBackup);
  byId('restoreDialog').addEventListener('cancel', (event) => {
    event.preventDefault();
    if (!restoreInProgress || restoreCanCancel) cancelRestoreBackup();
  });
  window.financeAPI.onRestoreProgress(handleRestoreProgress);
}

function selectView(name) {
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  document.querySelectorAll('.view').forEach((view) => { const active = view.id === `view-${name}`; view.classList.toggle('active', active); view.hidden = !active; });
  byId('viewEyebrow').textContent = viewMeta[name][0];
  byId('viewTitle').textContent = viewMeta[name][1];
  if (name === 'guide') checkModel();
}

function render() {
  synchroniseReviewItems(state);
  populateMonthOptions();
  populatePaymentCategoryOptions();
  const month = state.settings.selectedMonth;
  const summary = calculatePeriodSummary(state, month);
  try {
    prioritySafety = debtSafetyAssessment(state);
    priorityView = prioritySnapshot(state, new Date(), { preferredItemId: pendingAction?.reviewId, safetyAssessment: prioritySafety });
  } catch {
    prioritySafety = null;
    priorityView = unavailablePriorityView();
    recordPriorityDiagnostic(PRIORITY_DIAGNOSTIC_CODES.EVALUATION_FAILED);
  }
  pendingAction = priorityView.unavailable ? {
    title: 'Next Move is temporarily unavailable',
    detail: 'OneStep could not calculate a safe ordering. Your unresolved work is still available in Review Inbox.',
    priorityReason: 'The priority calculation failed without changing any financial data. Use Review Inbox until it can be recalculated.',
    timeframe: 'Unavailable', passive: true, unavailable: true
  } : priorityView.nextMove ? {
    ...priorityView.nextMove,
    reviewId: priorityView.nextMove.item.id,
    completeDirect: priorityView.nextMove.item.type === 'generated_action'
      && reviewRoute(priorityView.nextMove.item, state).view === 'today'
  } : {
    title: 'You’re caught up for now',
    detail: priorityView.lowPriorityRemaining
      ? `${priorityView.lowPriorityRemaining} lower-priority ${priorityView.lowPriorityRemaining === 1 ? 'item remains' : 'items remain'} available in Review Inbox, but nothing needs to take over Today.`
      : 'There is no unresolved work worth putting in front of you right now.',
    timeframe: 'Done', passive: true
  };
  byId('nextActionTitle').textContent = pendingAction.title;
  byId('nextActionDetail').textContent = pendingAction.detail || '';
  byId('nextActionTime').textContent = pendingAction.timeframe || '10 min';
  byId('nextMoveBand').textContent = pendingAction.unavailable ? 'Unavailable' : pendingAction.priorityBand ? priorityBandLabel(pendingAction.priorityBand) : 'Caught up';
  byId('nextMoveBand').className = `next-move-band band-${pendingAction.unavailable ? 'unavailable' : pendingAction.priorityBand || 'done'}`;
  byId('nextMoveWhyText').textContent = pendingAction.priorityReason || 'OneStep has no meaningful action to recommend right now.';
  byId('completeActionButton').textContent = pendingAction.actionLabel || 'Do it';
  byId('completeActionButton').hidden = Boolean(pendingAction.passive);
  byId('snoozeActionButton').hidden = Boolean(pendingAction.passive);
  renderDashboard();
  renderDailyCompletion();
  renderTodaySupporting();
  byId('marginValue').textContent = formatCurrency(summary.plannedMargin);
  byId('cashFlowValue').textContent = formatCurrency(summary.netCashFlow);
  const allTime = month === ALL_TIME_PERIOD;
  const periodHint = allTime ? `All trusted data · ${summary.monthCount} month${summary.monthCount === 1 ? '' : 's'}` : monthLabel(month);
  byId('marginHint').textContent = allTime ? `${summary.monthCount} × monthly safety margin` : `Plan for ${periodHint}`;
  byId('cashFlowHint').textContent = periodHint;
  byId('todayDebtValue').textContent = formatCurrency(summary.debts);
  byId('todayOverdraftValue').textContent = formatCurrency(summary.overdrafts);
  byId('grossPayValue').textContent = formatCurrency(summary.grossPay);
  byId('deductionsValue').textContent = formatCurrency(summary.payrollDeductions);
  byId('netPayValue').textContent = formatCurrency(summary.netPay);
  byId('grossPayHint').textContent = periodHint;
  byId('deductionsHint').textContent = allTime ? periodHint : 'Tax, NI and other deductions';
  byId('netPayHint').textContent = allTime ? periodHint : 'Amount paid by payroll';
  byId('streakValue').textContent = calculateStreak(state.checkIns);
  renderChecks();
  renderMomentum();
  renderReviewInbox();
  renderTransactions();
  renderPaymentInsights();
  renderPay();
  renderDebts();
  renderCreditReports();
  renderOverdrafts();
  renderBudget();
  renderDocuments();
  renderAccounts();
  renderSettings();
  renderPrivacy();
}

function renderDashboard() {
  const dashboard = normaliseDashboardSettings(state.settings.dashboard);
  state.settings.dashboard = dashboard;
  const report = getFinancialViewCache().report;
  const visible = new Set(visibleDashboardModules(dashboard));
  const container = byId('dashboardModules');
  const visualOrder = [...visibleDashboardModules(dashboard), ...dashboard.order.filter((moduleId) => !visible.has(moduleId))];
  for (const moduleId of visualOrder) {
    const module = container.querySelector(`[data-dashboard-module="${moduleId}"]`);
    if (!module) continue;
    module.hidden = !visible.has(moduleId);
    module.classList.toggle('module-wide', dashboard.sizes[moduleId] === 'wide');
    container.append(module);
  }
  document.querySelectorAll('[data-dashboard-mode]').forEach((button) => {
    const selected = button.dataset.dashboardMode === dashboard.mode;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });

  byId('dashboardNextMoveTitle').textContent = pendingAction.title;
  byId('dashboardNextMoveDetail').textContent = pendingAction.detail || '';
  byId('dashboardNextMoveTime').textContent = pendingAction.timeframe || '10 min';
  byId('dashboardNextMoveBand').textContent = pendingAction.unavailable ? 'Unavailable' : pendingAction.priorityBand ? priorityBandLabel(pendingAction.priorityBand) : 'Caught up';
  byId('dashboardNextMoveBand').className = `next-move-band band-${pendingAction.unavailable ? 'unavailable' : pendingAction.priorityBand || 'done'}`;
  byId('dashboardOpenNextMove').textContent = pendingAction.passive ? 'Open Today' : 'Open Next Move';

  byId('dashboardBalanceValue').textContent = formatCurrency(report.accountBalance);
  const available = prioritySafety?.currentCashCapacity ?? prioritySafety?.plannedCapacity ?? 0;
  byId('dashboardAvailableValue').textContent = formatCurrency(available);
  byId('dashboardCashFlowText').textContent = `${formatCurrency(report.summary.income)} in · ${formatCurrency(report.summary.spending)} out · ${formatCurrency(report.summary.netCashFlow)} net.`;
  byId('dashboardUpcomingValue').textContent = formatCurrency(report.upcomingCommitments);
  const payday = nextPaydayLabel(state.profile?.paydayDay);
  byId('dashboardUpcomingText').textContent = [
    report.upcomingCommitments > 0 ? 'Recorded commitments that are not marked paid or cancelled.' : 'No upcoming commitments recorded.',
    payday ? `Next recorded payday: ${payday}.` : 'Add an optional payday in Settings to show the next expected income date.'
  ].join(' ');
  byId('dashboardBudgetValue').textContent = report.budget.remaining < 0 ? `${formatCurrency(Math.abs(report.budget.remaining))} over` : `${formatCurrency(report.budget.remaining)} left`;
  byId('dashboardBudgetText').textContent = `${formatCurrency(report.budget.actual)} spent of ${formatCurrency(report.budget.planned)} planned. ${report.budget.coveragePercent}% categorised.`;
  const budgetPercent = report.budget.planned > 0 ? Math.max(0, Math.min(100, Math.round((report.budget.actual / report.budget.planned) * 100))) : 0;
  byId('dashboardBudgetProgress').style.width = `${budgetPercent}%`;

  const alerts = byId('dashboardAlerts'); clear(alerts);
  const checks = buildFinancialChecks(state).slice(0, 3);
  for (const check of checks) {
    const row = element('div', `dashboard-list-row tone-${check.tone}`);
    append(row, element('strong', '', check.title), element('span', '', check.text)); alerts.append(row);
  }
  if (!checks.length) alerts.append(element('p', 'muted', 'No important warnings for this period.'));

  renderDashboardProgress(report);
  renderLineChart(byId('dashboardSpendingChart'), report.spendingTimeline, 'spending', 'Trusted spending over time');
  byId('dashboardSpendingSummary').textContent = report.comparison.text;
  renderLineChart(byId('dashboardIncomeChart'), report.incomeTimeline, 'income', 'Trusted income over time');
  byId('dashboardIncomeSummary').textContent = report.incomeTimeline.length ? `${formatCurrency(report.summary.income)} received in the selected period.` : 'No trusted income is available for this period.';

  const review = reviewInboxSummary(state);
  byId('dashboardReviewValue').textContent = String(review.total);
  byId('dashboardReviewText').textContent = review.total ? `${review.total} unresolved ${review.total === 1 ? 'item needs' : 'items need'} your judgement.` : 'Nothing needs review.';
  const recent = byId('dashboardRecentPayments'); clear(recent);
  const recentRows = periodTransactions(state.transactions, state.settings.selectedMonth).slice(-5).reverse();
  for (const transaction of recentRows) {
    const row = element('div', 'dashboard-list-row horizontal');
    const direction = Number(transaction.outgoing || 0) > 0 ? -Number(transaction.outgoing) : Number(transaction.incoming || 0);
    append(row, element('span', '', transaction.userDescription || transaction.description || 'Payment'), element('strong', direction < 0 ? 'outgoing' : 'incoming', `${direction < 0 ? '−' : '+'}${formatCurrency(Math.abs(direction))}`));
    recent.append(row);
  }
  if (!recentRows.length) recent.append(element('p', 'muted', 'No trusted payments in this period.'));
}

function renderDashboardProgress(report) {
  const container = byId('dashboardProgress'); clear(container);
  const items = report.progress.debts.filter((item) => item.current > 0).slice(0, 4);
  for (const item of items) {
    const row = element('div', 'progress-item');
    const heading = element('div', 'progress-item-heading');
    const overdraftMilestone = item.kind === 'overdraft' && item.limit ? overdraftProgressLabel(item.current, item.limit) : '';
    const detail = overdraftMilestone || (item.cleared === null ? `${formatCurrency(item.current)} remaining · starting balance not recorded` : `${formatCurrency(item.current)} remaining · ${formatCurrency(item.cleared)} cleared`);
    append(heading, element('strong', '', item.name), element('span', '', detail)); row.append(heading);
    if (item.percent !== null) {
      const track = element('div', 'progress-track'); const bar = document.createElement('span'); bar.style.width = `${item.percent}%`; track.append(bar); row.append(track);
    }
    container.append(row);
  }
  const savings = report.progress.savings;
  if (savings.target > 0) {
    const row = element('div', 'progress-item');
    const heading = element('div', 'progress-item-heading');
    append(heading, element('strong', '', 'Emergency buffer'), element('span', '', `${formatCurrency(savings.current)} / ${formatCurrency(savings.target)}`));
    const track = element('div', 'progress-track'); const bar = document.createElement('span'); bar.style.width = `${savings.percent}%`; track.append(bar);
    append(row, heading, track); container.append(row);
  }
  if (!items.length && savings.target <= 0) container.append(element('p', 'muted', 'Add a known starting balance or savings target to show progress.'));
  const wins = byId('dashboardWins'); clear(wins);
  for (const message of report.wins.slice(0, 3)) wins.append(element('div', 'financial-win', `✓ ${message}`));
}

function renderPaymentInsights() {
  const report = getFinancialViewCache().report;
  byId('paymentInsightsSummary').textContent = reportTextSummary(report);
  renderBarChart(byId('moneyInOutChart'), [
    { label: 'Money in', amount: report.summary.income, tone: 'income' },
    { label: 'Money out', amount: report.summary.spending, tone: 'spending' }
  ], 'Money in compared with money out');
  byId('moneyInOutSummary').textContent = `${formatCurrency(report.summary.income)} in; ${formatCurrency(report.summary.spending)} out; ${formatCurrency(report.summary.netCashFlow)} net cash flow.`;
  renderLineChart(byId('spendingTrendChart'), report.spendingTimeline, 'spending', 'Trusted spending over time');
  byId('spendingTrendSummary').textContent = report.comparison.text;
  renderCategoryChart(report.categories);
  renderBarChart(byId('recurringChart'), [
    { label: 'Confirmed recurring', amount: report.recurring.committed, tone: 'committed' },
    { label: 'Flexible / not confirmed', amount: report.recurring.flexible, tone: 'flexible' }
  ], 'Confirmed recurring compared with flexible spending');
  byId('recurringChartSummary').textContent = report.recurring.evidence === 'confirmed'
    ? `${formatCurrency(report.recurring.committed)} is confirmed recurring; ${formatCurrency(report.recurring.flexible)} is flexible or not confirmed recurring.`
    : 'No spending is confirmed as recurring in this period; uncertain items remain flexible rather than being labelled commitments.';
}

function renderBarChart(container, rows, ariaLabel) {
  clear(container);
  container.setAttribute('role', 'img');
  container.setAttribute('aria-label', ariaLabel);
  const max = Math.max(1, ...rows.map((row) => Math.max(0, Number(row.amount || 0))));
  for (const item of rows) {
    const row = element('div', 'chart-bar-row');
    const label = element('div', 'chart-bar-label');
    append(label, element('span', '', item.label), element('strong', '', formatCurrency(item.amount)));
    const track = element('div', 'chart-bar-track');
    const bar = element('span', `chart-bar-fill tone-${item.tone || 'default'}`); bar.style.width = `${Math.max(0, Number(item.amount || 0)) / max * 100}%`; track.append(bar);
    append(row, label, track); container.append(row);
  }
}

function renderLineChart(container, points, tone, ariaLabel) {
  clear(container);
  if (!points.length) { container.append(element('p', 'chart-empty', 'No trusted data for this period.')); return; }
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 600 190'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', ariaLabel);
  const max = Math.max(1, ...points.map((point) => Math.max(0, Number(point.amount || 0))));
  for (const y of [30, 90, 150]) {
    const line = document.createElementNS(namespace, 'line'); line.setAttribute('x1', '26'); line.setAttribute('x2', '580'); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('class', 'chart-grid-line'); svg.append(line);
  }
  const coordinates = points.map((point, index) => {
    const x = points.length === 1 ? 300 : 28 + (index / (points.length - 1)) * 548;
    const y = 158 - (Math.max(0, Number(point.amount || 0)) / max) * 126;
    return { ...point, x, y };
  });
  const line = document.createElementNS(namespace, 'polyline'); line.setAttribute('points', coordinates.map((point) => `${point.x},${point.y}`).join(' ')); line.setAttribute('class', `chart-line tone-${tone}`); svg.append(line);
  for (const point of coordinates) {
    const circle = document.createElementNS(namespace, 'circle'); circle.setAttribute('cx', String(point.x)); circle.setAttribute('cy', String(point.y)); circle.setAttribute('r', '5'); circle.setAttribute('class', `chart-point tone-${tone}`); circle.setAttribute('tabindex', '0');
    const title = document.createElementNS(namespace, 'title'); title.textContent = `${shortPeriodLabel(point.label)}: ${formatCurrency(point.amount)}${point.incomplete ? ' · incomplete period' : ''}`; circle.append(title); svg.append(circle);
  }
  container.append(svg, chartDataTable(points));
}

function renderCategoryChart(categories) {
  const container = byId('categoryChart'); clear(container);
  const button = byId('chartReviewUncategorisedButton');
  button.hidden = !categories.some((category) => category.needsReview);
  if (!categories.length) {
    container.append(element('p', 'chart-empty', 'No trusted spending categories for this period.'));
    byId('categoryChartSummary').textContent = 'Income and transfers are not shown as expenditure.';
    return;
  }
  const max = Math.max(1, ...categories.map((category) => Math.max(0, category.amount)));
  for (const category of categories.slice(0, 10)) {
    const row = element('div', `category-chart-row${category.needsReview ? ' needs-review' : ''}`);
    const heading = element('div', 'category-chart-heading'); append(heading, element('span', '', category.label), element('strong', '', formatCurrency(category.amount)));
    const track = element('div', 'chart-bar-track'); const bar = element('span', category.needsReview ? 'chart-bar-fill tone-warning' : 'chart-bar-fill tone-category'); bar.style.width = `${Math.max(0, category.amount) / max * 100}%`; track.append(bar);
    append(row, heading, track); container.append(row);
  }
  const largest = categories[0];
  byId('categoryChartSummary').textContent = `${largest.label} is largest at ${formatCurrency(largest.amount)}. Income, confirmed transfers and savings transfers are excluded.`;
}

function chartDataTable(points) {
  const details = element('details', 'chart-data'); details.append(element('summary', '', 'View chart data'));
  const table = document.createElement('table'); const head = document.createElement('thead'); const header = document.createElement('tr'); append(header, element('th', '', 'Period'), element('th', '', 'Amount')); head.append(header);
  const body = document.createElement('tbody');
  for (const point of points) { const row = document.createElement('tr'); append(row, cell(`${shortPeriodLabel(point.label)}${point.incomplete ? ' · incomplete' : ''}`), amountCell(point.amount)); body.append(row); }
  append(table, head, body); details.append(table); return details;
}

function shortPeriodLabel(value) {
  if (/^\d{4}-\d{2}$/.test(String(value))) return monthLabel(value);
  return formatDate(value);
}

function nextPaydayLabel(value, now = new Date()) {
  const day = knownPaydayDay(value);
  if (!day) return '';
  let year = now.getFullYear(); let month = now.getMonth();
  let lastDay = new Date(year, month + 1, 0).getDate();
  let candidate = new Date(year, month, Math.min(day, lastDay), 12);
  if (candidate < new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0)) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
    lastDay = new Date(year, month + 1, 0).getDate();
    candidate = new Date(year, month, Math.min(day, lastDay), 12);
  }
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(candidate);
}

function overdraftProgressLabel(current, limit) {
  if (current <= 0) return 'Back in credit';
  const usage = Math.round((current / limit) * 100);
  const milestone = usage <= 25 ? 'below 25%' : usage <= 50 ? 'below 50%' : usage <= 75 ? 'below 75%' : usage <= 100 ? 'within the arranged limit' : 'over the arranged limit';
  return `${formatCurrency(current)} of ${formatCurrency(limit)} used · ${milestone}`;
}

function renderChecks() {
  const container = byId('checksList');
  clear(container);
  for (const check of buildFinancialChecks(state)) {
    const card = element('article', `check-card ${check.tone}`);
    append(card, element('h3', '', check.title), element('p', '', check.text));
    container.append(card);
  }
}

function renderMomentum() {
  const current = Number(state.settings.emergencyBufferBalance || 0);
  const target = Math.max(1, Number(state.settings.emergencyBufferTarget || 500));
  const percent = Math.min(100, Math.round((current / target) * 100));
  const completedToday = hasCompletedCheckIn(state.checkIns);
  byId('bufferProgress').style.width = `${percent}%`;
  byId('momentumTitle').textContent = current ? `${percent}% of your starter buffer` : 'Showing up counts';
  byId('momentumText').textContent = current ? `${formatCurrency(current)} saved toward ${formatCurrency(target)}. Keep the target small while payments are being stabilised.` : 'Your first win is a completed check-in. The buffer can grow after essential payments are secure.';
  byId('quickCheckInButton').disabled = completedToday;
  byId('quickCheckInButton').textContent = completedToday ? 'Check-in complete today' : 'Complete five-minute check-in';
  let reviewSelection = [];
  try {
    reviewSelection = selectFiveMinuteCheckIn(state, new Date(), 4, { safetyAssessment: prioritySafety });
  } catch {
    recordPriorityDiagnostic(PRIORITY_DIAGNOSTIC_CODES.CONSOLIDATION_INVALID);
  }
  const reviewList = byId('checkInReviewList'); clear(reviewList);
  for (const workflow of reviewSelection) {
    const row = element('div', 'check-in-review-item');
    const label = element('strong', '', workflow.title);
    const button = element('button', 'secondary-button', workflow.consolidated ? 'Start' : 'Open');
    button.type = 'button'; button.dataset.reviewRoute = workflow.itemIds[0];
    button.setAttribute('aria-label', `${workflow.consolidated ? 'Start' : 'Open'} ${workflow.title}`);
    append(row, label, button); reviewList.append(row);
  }
  reviewList.hidden = reviewSelection.length === 0;
  byId('checkInStatus').textContent = completedToday
    ? 'Recorded for today. Unresolved review work remains available in the Review Inbox.'
    : reviewSelection.length ? `A manageable ${reviewSelection.length} ${reviewSelection.length === 1 ? 'item is' : 'items are'} ready if you want to use the check-in.`
      : 'Nothing needs reviewing. A quick check-in is enough.';
}

function renderDailyCompletion() {
  const done = priorityView.doneForToday;
  document.querySelector('.focus-panel').hidden = done;
  document.querySelector('.permission-slip').hidden = done;
  byId('dailyCompleteState').hidden = !done;
  byId('dailyCompleteTitle').textContent = 'You’re caught up for now';
  byId('dailyCompleteText').textContent = priorityView.lowPriorityRemaining
    ? 'Nothing important needs to take over Today. Lower-priority housekeeping remains available in Review Inbox.'
    : 'There is no unresolved work worth surfacing today.';
  byId('todayProgressStatus').textContent = priorityView.unavailable
    ? 'Next Move is temporarily unavailable. Review Inbox remains available.'
    : done
    ? 'You’re caught up for now.'
    : `${priorityView.todayCount} ${priorityView.todayCount === 1 ? 'thing matters' : 'things matter'} today.`;
}

function renderTodaySupporting() {
  const section = byId('todaySupportingSection');
  const list = byId('todaySupportingList'); clear(list);
  section.hidden = priorityView.supporting.length === 0;
  for (const evaluation of priorityView.supporting) {
    const card = element('article', `today-support-card band-${evaluation.priorityBand}`);
    const copy = element('div');
    append(copy, element('span', 'review-priority', priorityBandLabel(evaluation.priorityBand)), element('h3', '', evaluation.title), element('p', '', evaluation.detail));
    const button = element('button', 'secondary-button', evaluation.inProgress ? 'Continue' : 'Do it');
    button.type = 'button'; button.dataset.reviewRoute = evaluation.item.id;
    button.setAttribute('aria-label', `${evaluation.inProgress ? 'Continue' : 'Do'} ${evaluation.title}`);
    append(card, copy, button); list.append(card);
  }
}

function renderReviewInbox() {
  const summary = reviewInboxSummary(state);
  let rankedGroups;
  try {
    rankedGroups = prioritisedReviewGroups(state, new Date(), { safetyAssessment: prioritySafety });
  } catch {
    recordPriorityDiagnostic(PRIORITY_DIAGNOSTIC_CODES.EVALUATION_FAILED);
    rankedGroups = summary.groups.map((group) => ({
      ...group,
      priorityBand: group.priority === 'high' ? 'important' : group.priority === 'low' ? 'low' : 'normal',
      priorityReason: 'This unresolved item remains available for review.'
    }));
  }
  reviewGroupsById = new Map(rankedGroups.map((group) => [group.id, group]));
  const count = byId('reviewNavCount');
  count.textContent = String(summary.total);
  count.hidden = summary.total === 0;
  count.setAttribute('aria-label', `${summary.total} active review ${summary.total === 1 ? 'item' : 'items'}`);
  byId('reviewSummaryTitle').textContent = summary.total
    ? `${summary.total} ${summary.total === 1 ? 'thing needs' : 'things need'} attention`
    : 'Nothing needs reviewing right now';
  byId('reviewSummaryText').textContent = summary.total
    ? 'Start with important work. Open details only when you need them.'
    : 'OneStep will put work here only when a decision or correction is genuinely needed.';
  byId('reviewCriticalCount').textContent = rankedGroups.filter((group) => group.priorityBand === 'critical').length;
  byId('reviewImportantCount').textContent = rankedGroups.filter((group) => group.priorityBand === 'important').length;
  byId('reviewNormalCount').textContent = rankedGroups.filter((group) => ['normal', 'low'].includes(group.priorityBand)).length;
  byId('reviewSnoozedCount').textContent = summary.snoozed.length;
  byId('reviewDoneState').hidden = summary.total !== 0;
  byId('reviewActiveSection').hidden = summary.total === 0;
  byId('reviewInboxStatus').textContent = summary.total ? `${summary.total} review items are active.` : 'Nothing needs reviewing right now.';

  const activeList = byId('reviewActiveList'); clear(activeList);
  for (const group of rankedGroups) activeList.append(reviewGroupCard(group));

  const snoozedSection = byId('reviewSnoozedSection');
  const snoozedList = byId('reviewSnoozedList'); clear(snoozedList);
  snoozedSection.hidden = summary.snoozed.length === 0;
  for (const item of summary.snoozed) snoozedList.append(snoozedReviewCard(item));

  const welcomePanel = byId('welcomeBackPanel');
  welcomePanel.hidden = !(welcomeBack && summary.total > 0);
  if (!welcomePanel.hidden) {
    const otherCount = Math.max(0, priorityView.unresolvedCount - 1);
    byId('welcomeBackText').textContent = priorityView.unavailable
      ? 'Your unresolved work is still in Review Inbox while Next Move is unavailable.'
      : priorityView.nextMove
      ? otherCount ? `One thing needs your attention first. ${otherCount} other ${otherCount === 1 ? 'item can' : 'items can'} wait.` : 'One thing needs your attention first. Nothing else needs you today.'
      : 'Nothing important needs your attention today. Lower-priority work can wait.';
  }
}

function reviewGroupCard(group) {
  const presentation = group.presentation;
  const card = element('article', `review-card band-${group.priorityBand}`);
  card.dataset.reviewGroup = group.id;
  const copy = element('div', 'review-card-copy');
  const heading = element('div', 'review-card-heading');
  append(heading, element('h3', '', presentation.title), element('span', 'review-priority', priorityBandLabel(group.priorityBand)));
  append(copy, heading, element('p', 'review-card-detail', presentation.detail));
  const explanation = element('details', 'review-explanation');
  explanation.append(element('summary', '', 'Why this?'));
  explanation.append(element('p', '', `${group.priorityReason} ${presentation.consequence}`));
  copy.append(explanation);
  if (group.type === 'uncategorised_payment' && group.items.length > 1) copy.append(reviewGroupDetails(group));

  const actions = element('div', 'review-card-actions');
  const open = element('button', 'primary-button', presentation.action);
  open.type = 'button'; open.dataset.reviewRoute = group.items[0].id;
  actions.append(open);
  if (group.type === 'possible_duplicate') actions.append(reviewDecisionRow(group.items[0]));
  if (group.type === 'import_conflict') {
    const item = group.items[0];
    const batch = item.sourceType === 'importBatch' ? state.importBatches.find((entry) => String(entry.id) === item.sourceId) : null;
    if (batch?.kind === 'statement') {
      const decisions = element('div', 'review-decision-row');
      const apply = element('button', 'secondary-button', 'Apply payments');
      apply.type = 'button'; apply.dataset.reviewDecision = 'apply_import'; apply.dataset.reviewItem = item.id;
      const keep = element('button', 'secondary-button', 'Reject changes');
      keep.type = 'button'; keep.dataset.reviewDecision = 'keep_current'; keep.dataset.reviewItem = item.id;
      append(decisions, apply, keep); actions.append(decisions);
    } else {
      const keep = element('button', 'secondary-button', item.sourceType === 'document' ? 'Keep document only' : 'Keep current data');
      keep.type = 'button'; keep.dataset.reviewDecision = item.sourceType === 'document' ? 'ignore_import' : 'keep_current'; keep.dataset.reviewItem = item.id;
      actions.append(keep);
    }
  }
  actions.append(reviewSnoozeControls(group));
  append(card, copy, actions);
  return card;
}

function reviewGroupDetails(group) {
  const details = element('details', 'review-group-items');
  details.append(element('summary', '', `Show ${group.items.length} payments`));
  for (const item of group.items.slice(0, 100)) {
    const presentation = reviewItemPresentation(item, state);
    const row = element('div', 'review-group-row');
    const button = element('button', 'secondary-button', 'Categorise');
    button.type = 'button'; button.dataset.reviewRoute = item.id;
    append(row, element('span', '', presentation.detail), button); details.append(row);
  }
  if (group.items.length > 100) details.append(element('p', 'muted', `Showing the first 100 of ${group.items.length}. Use Payments to work through the complete group.`));
  return details;
}

function reviewDecisionRow(item) {
  const row = element('div', 'review-decision-row');
  const genuine = element('button', 'secondary-button', 'Both genuine');
  genuine.type = 'button'; genuine.dataset.reviewDecision = 'both_genuine'; genuine.dataset.reviewItem = item.id;
  const duplicate = element('button', 'secondary-button', 'Duplicate');
  duplicate.type = 'button'; duplicate.dataset.reviewDecision = 'duplicate'; duplicate.dataset.reviewItem = item.id;
  append(row, genuine, duplicate); return row;
}

function reviewSnoozeControls(group) {
  const controls = element('div', 'review-snooze-controls');
  const select = document.createElement('select');
  select.className = 'review-snooze-choice'; select.setAttribute('aria-label', `Snooze ${group.presentation.title}`);
  for (const [value, label] of [['tomorrow', 'Tomorrow'], ['weekend', 'This weekend'], ['next_week', 'Next week']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  const payday = document.createElement('option'); payday.value = 'payday'; payday.textContent = knownPaydayDay(state.profile?.paydayDay) ? 'Payday' : 'Payday · not known'; payday.disabled = !knownPaydayDay(state.profile?.paydayDay); select.append(payday);
  const button = element('button', 'secondary-button', 'Snooze');
  button.type = 'button'; button.dataset.reviewSnooze = group.id;
  append(controls, select, button); return controls;
}

function snoozedReviewCard(item) {
  const presentation = reviewItemPresentation(item, state);
  const card = element('article', 'review-card');
  const copy = element('div', 'review-card-copy');
  append(copy, element('h3', '', presentation.title), element('p', 'review-card-detail', presentation.detail), element('span', 'review-due', `Returns ${formatReviewDate(item.snoozedUntil)}`));
  const actions = element('div', 'review-card-actions');
  const button = element('button', 'secondary-button', 'Review now'); button.type = 'button'; button.dataset.reviewRoute = item.id;
  actions.append(button); append(card, copy, actions); return card;
}

async function handleReviewAction(event) {
  const decision = event.target.closest('[data-review-decision]');
  if (decision) {
    const confirmations = {
      duplicate: 'Confirm these records are the same transaction. The reviewed payment will remain excluded from trusted totals.',
      both_genuine: 'Confirm both payments are legitimate. The reviewed payment will be included in trusted totals.',
      apply_import: 'Apply these reviewed statement payments to trusted totals? The protected account balance will not be guessed.',
      keep_current: 'Keep the current trusted data and reject the uncertain imported change?',
      ignore_import: 'Keep the encrypted document without importing its uncertain financial information?'
    };
    if (!window.confirm(confirmations[decision.dataset.reviewDecision] || 'Confirm this review decision?')) return;
    const labels = { duplicate: 'Payment confirmed as a duplicate.', both_genuine: 'Both payments confirmed as genuine.', apply_import: 'Reviewed payments added to trusted totals.', keep_current: 'Current trusted financial data kept.', ignore_import: 'Document kept without importing uncertain information.' };
    resolveReviewItem(state, decision.dataset.reviewItem, decision.dataset.reviewDecision);
    await saveState(); render(); showToast(labels[decision.dataset.reviewDecision] || 'Review item resolved.');
    return;
  }
  const snooze = event.target.closest('[data-review-snooze]');
  if (snooze) {
    const group = reviewGroupsById.get(snooze.dataset.reviewSnooze);
    const choice = snooze.closest('.review-card').querySelector('.review-snooze-choice').value;
    snoozeReviewGroup(state, group.items.map((item) => item.id), choice);
    await saveState(); render(); showToast('Review work snoozed. It will return automatically.');
    return;
  }
  const routeButton = event.target.closest('[data-review-route]');
  if (routeButton) await openReviewWorkflow(routeButton.dataset.reviewRoute);
}

async function openReviewWorkflow(itemId) {
  const item = state.reviewItems.find((entry) => entry.id === itemId);
  if (!item || item.status === 'resolved') { render(); showToast('That review work is already complete.'); return; }
  startReviewItem(state, itemId);
  await saveState();
  render();
  const route = reviewRoute(item, state);
  if (route.type === 'transaction') {
    const transaction = state.transactions.find((entry) => String(entry.id) === route.id);
    if (item.type === 'uncategorised_payment') {
      selectView('transactions'); openEditor('transaction', route.id, { reviewItemId: item.id });
      return;
    }
    state.settings.selectedMonth = ALL_TIME_PERIOD;
    byId('transactionSearch').value = transaction?.userDescription || transaction?.description || '';
    transactionPage = 1; populateMonthOptions(); selectView('transactions'); renderTransactions(); focusTransactionTable();
    return;
  }
  if (route.type === 'debt' || route.type === 'overdraft') {
    selectView(route.view); openEditor(route.type, route.id, { reviewItemId: item.id });
    return;
  }
  if (route.type === 'import') {
    selectView(route.view);
    byId(route.controlId)?.focus();
    showToast('Choose the correct account where needed, then select the original document again.');
    return;
  }
  if (route.type === 'importBatch' && route.view === 'transactions') {
    state.settings.selectedMonth = ALL_TIME_PERIOD;
    byId('transactionSearch').value = '';
    byId('transactionCategoryFilter').value = 'all';
    transactionPage = 1; populateMonthOptions(); selectView('transactions'); renderTransactions(); focusTransactionTable();
    return;
  }
  if (route.type === 'task' && route.targetType && route.targetId) {
    selectView(route.view);
    openEditor(route.targetType, route.targetId, { reviewItemId: item.id });
    return;
  }
  selectView(route.view);
}

function formatReviewDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'later' : new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function priorityBandLabel(value) {
  return ({ critical: 'Critical', important: 'Important', normal: 'Normal', low: 'Low' })[value] || 'Normal';
}

function unavailablePriorityView() {
  return {
    nextMove: null, today: [], supporting: [], candidates: [], doneForToday: false, unavailable: true,
    unresolvedCount: 0, todayCount: 0, lowPriorityRemaining: 0
  };
}

function recordPriorityDiagnostic(code) {
  window.financeAPI?.recordRendererFault(code).catch(() => {});
}

function renderTransactions() {
  const { ledgerIndex } = getFinancialViewCache();
  const rows = filterTransactionLedger(ledgerIndex, {
    period: state.settings.selectedMonth,
    search: byId('transactionSearch').value,
    account: byId('transactionAccountFilter').value,
    type: byId('transactionTypeFilter').value,
    category: byId('transactionCategoryFilter').value
  });
  const page = paginateTransactionLedger(rows, transactionPage);
  transactionPage = page.page;
  const body = byId('transactionRows');
  clear(body);
  for (const item of page.items) {
    const row = document.createElement('tr');
    row.append(cell(formatDate(item.date)));
    row.append(cell(ledgerIndex.accountNames.get(item.accountId) || item.accountId || 'Unassigned'));
    const description = cell();
    description.className = 'description-cell';
    append(description, element('strong', '', item.userDescription || item.description));
    if (item.userDescription) description.append(element('span', '', item.description));
    const badges = document.createElement('span');
    badges.className = 'note-preview';
    badges.textContent = isIncomePayment(item) ? INCOME_PAYMENT_CATEGORY
      : ledgerIndex.budgetByTransaction.get(item.id)?.category || (ledgerIndex.uncategorised.has(item.id) ? 'Uncategorised' : item.category || 'Not included in budget');
    if (item.transferStatus !== 'no') badges.textContent += ` · ${item.transferStatus} transfer`;
    if (item.duplicateStatus === 'possible') {
      const duplicateLabel = item.reviewStatus === 'accepted' ? 'accepted possible duplicate'
        : item.reviewStatus === 'rejected' ? 'excluded duplicate'
          : 'possible duplicate · excluded pending review';
      badges.textContent += ` · ${duplicateLabel}`;
    }
    if (item.importReviewStatus === 'pending') badges.textContent += ' · import review pending · excluded from trusted totals';
    if (item.importReviewStatus === 'rejected') badges.textContent += ' · rejected import · excluded from trusted totals';
    description.append(badges);
    row.append(description);
    row.append(amountCell(item.incoming, 'incoming'));
    row.append(amountCell(item.outgoing, 'outgoing'));
    row.append(amountCell(item.runningBalance, ''));
    row.append(cell(item.notes || '—', 'note-preview'));
    row.append(transactionActionCell(item));
    body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr'); const empty = cell('No payments match these filters.'); empty.colSpan = 8; row.append(empty); body.append(row);
  }
  byId('transactionCount').textContent = page.totalRows
    ? `Showing ${page.start}–${page.end} of ${page.totalRows} matching payment${page.totalRows === 1 ? '' : 's'}.`
    : '0 matching payments.';
  byId('transactionPageStatus').textContent = `Page ${page.page} of ${page.totalPages}`;
  byId('transactionPreviousPage').disabled = page.page <= 1;
  byId('transactionNextPage').disabled = page.page >= page.totalPages;
  byId('transactionPagination').hidden = page.totalPages <= 1;
}

function renderPay() {
  const list = byId('payslipList');
  clear(list);
  const payslips = [...state.payslips].sort((left, right) => right.period.localeCompare(left.period));
  if (!payslips.length) {
    const empty = element('article', 'panel');
    append(empty, element('h2', '', 'No payslips yet'), element('p', 'muted', 'Import a supported payslip to track gross pay, tax, National Insurance, other deductions and net pay.'));
    list.append(empty);
    return;
  }
  for (const payslip of payslips) {
    const card = element('article', 'payslip-card');
    const summary = element('div', 'payslip-summary');
    const title = element('div', 'entity-title');
    append(title, element('h3', '', monthLabel(payslip.period)), element('p', '', `${payslip.source} · Paid ${formatDate(payslip.payDate)}`));
    append(summary, title, stat('Gross', formatCurrency(payslip.grossPay)), stat('Deductions', formatCurrency(payslip.totalDeductions)), stat('Net', formatCurrency(payslip.netPay)), actionButton('payslip', payslip.id, 'Edit'));
    const details = element('details');
    const detailsSummary = element('summary', '', 'Show earnings and deductions');
    const detailGrid = element('div', 'payslip-details');
    detailGrid.append(lineItemGroup('Pay and allowances', payslip.earnings), lineItemGroup('Charges and deductions', payslip.deductions));
    append(details, detailsSummary, detailGrid);
    append(card, summary, details);
    list.append(card);
  }
}

function renderDebts() {
  const total = state.debts.reduce((sum, item) => sum + Number(item.currentBalance || 0), 0);
  const payments = state.debts.reduce((sum, item) => sum + Number(item.contractualPayment || 0), 0);
  const unknown = state.debts.filter((item) => item.apr == null).length;
  byId('debtTotalValue').textContent = formatCurrency(total);
  byId('debtPaymentsValue').textContent = formatCurrency(payments);
  byId('unknownAprValue').textContent = unknown;
  const container = byId('debtCards'); clear(container);
  if (!state.debts.length) {
    const empty = element('article', 'panel');
    append(empty, element('h2', '', 'No debts added'), element('p', 'muted', 'Add loans, cards, finance agreements or defaulted accounts here. Overdrafts stay on their own page.'));
    container.append(empty);
    return;
  }
  const plan = debtPlan(state, 'hybrid');
  const planCard = element('article', `check-card ${plan.safeToOverpay ? 'positive' : 'warning'}`);
  const planTitle = ({ safe: 'Hybrid payoff forecast', reduced: 'Extra payment reduced for safety', blocked: 'Forecast paused for safety', not_requested: 'Required-payment forecast' })[plan.overpaymentStatus] || 'Forecast paused for safety';
  const planText = plan.overpaymentStatus === 'safe'
    ? `${formatCurrency(plan.monthlyPot)} a month includes the checked extra payment and gives a provisional debt-free month of ${monthLabel(plan.debtFreeMonth)}. ${plan.unknownApr.length} unknown APRs could change this.`
    : plan.overpaymentStatus === 'reduced'
      ? `OneStep reduced the optional payment to ${formatCurrency(plan.safeExtraPayment)}. The forecast protects the commitments currently recorded.`
      : plan.overpaymentStatus === 'not_requested'
        ? `${formatCurrency(plan.minimumTotal)} a month covers the required payments currently recorded. No optional payment is included.`
        : plan.explanations[0] || 'We do not have enough information to recommend an extra payment safely.';
  append(planCard, element('h3', '', planTitle), element('p', '', planText));
  const whyItems = [...plan.explanations, ...plan.excludedAccounts.map((item) => `${item.name}: ${item.reason}`)].filter(Boolean);
  if (whyItems.length) {
    const why = element('details', 'plan-why');
    why.append(element('summary', '', 'Why?'));
    const list = element('ul');
    for (const explanation of [...new Set(whyItems)]) list.append(element('li', '', explanation));
    why.append(list);
    planCard.append(why);
  }
  container.append(planCard);
  for (const item of [...state.debts].sort((left, right) => compareLabels(left.name, right.name))) container.append(entityCard('debt', item, [stat('Balance', formatCurrency(item.currentBalance)), stat('APR', item.apr == null ? 'Unknown' : `${(item.apr * 100).toFixed(2)}%`), stat('Required / arrangement', paymentStatusLabel(item), true)]));
}

function renderCreditReports() {
  const container = byId('creditReportCards'); clear(container);
  const reports = [...(state.creditReports || [])].sort((left, right) => String(right.reportDate || '').localeCompare(String(left.reportDate || '')));
  if (!reports.length) {
    container.append(element('p', 'muted', 'No credit reports imported yet.'));
    return;
  }
  for (const report of reports) {
    const score = report.score == null ? 'Score not detected' : `Score ${report.score}${report.scoreMaximum ? ` / ${report.scoreMaximum}` : ''}`;
    const detail = `${report.reportDate ? formatDate(report.reportDate) : 'Date not detected'} · ${score} · ${(report.accounts || []).length} reported account${(report.accounts || []).length === 1 ? '' : 's'}`;
    container.append(entityCard('credit report', { ...report, name: report.provider, description: detail }, [], false));
  }
}

function renderOverdrafts() {
  const total = state.overdrafts.reduce((sum, item) => sum + Number(item.currentBalance || 0), 0);
  byId('overdraftTotalValue').textContent = formatCurrency(total);
  byId('overLimitCount').textContent = state.overdrafts.filter((item) => item.status === 'over_limit').length;
  byId('overdraftPlansValue').textContent = `${state.overdrafts.filter((item) => item.arrangementStatus === 'confirmed').length} / ${state.overdrafts.length}`;
  const container = byId('overdraftCards'); clear(container);
  if (!state.overdrafts.length) {
    const empty = element('article', 'panel');
    append(empty, element('h2', '', 'No overdrafts added'), element('p', 'muted', 'Add only the amount currently used, the arranged limit and the confirmed rate.'));
    container.append(empty);
    return;
  }
  for (const item of [...state.overdrafts].sort((left, right) => compareLabels(left.name, right.name))) container.append(entityCard('overdraft', item, [stat('Used', formatCurrency(item.currentBalance)), stat('Limit / APR', limitAprLabel(item)), stat('Required / arrangement', paymentStatusLabel(item), true)]));
}

function renderBudget() {
  const summary = calculatePeriodSummary(state);
  const { budgetAnalysis: analysis } = getFinancialViewCache();
  const allTime = analysis.month === ALL_TIME_PERIOD;
  const monthWord = analysis.monthCount === 1 ? 'month' : 'months';
  byId('budgetPeriodHeading').textContent = allTime ? 'All-time plan versus actual' : 'Simple monthly plan';
  byId('budgetPeriodDescription').textContent = allTime
    ? `${analysis.monthCount} ${monthWord} of trusted data. Every monthly budget quantity and dependable income amount is multiplied by ${analysis.monthCount}.`
    : `Plan versus actual for ${monthLabel(analysis.month)}. Dependable income first; variable income stays separate until it arrives.`;
  byId('budgetIncomeLabel').textContent = allTime ? `Dependable income · ${analysis.monthCount} ${monthWord}` : 'Dependable income';
  byId('plannedSpendingLabel').textContent = allTime ? `Planned · ${analysis.monthCount} ${monthWord}` : 'Planned';
  byId('actualSpendingLabel').textContent = allTime ? 'Spent · all time' : 'Spent';
  byId('budgetRemainingLabel').textContent = allTime ? 'Remaining · all time' : 'Remaining plan';
  byId('budgetIncomeValue').textContent = formatCurrency(summary.dependableIncome);
  byId('plannedSpendingValue').textContent = formatCurrency(analysis.planned);
  byId('actualSpendingValue').textContent = formatCurrency(analysis.actual);
  byId('budgetRemainingValue').textContent = analysis.remaining < 0 ? `${formatCurrency(Math.abs(analysis.remaining))} over` : formatCurrency(analysis.remaining);
  byId('budgetCoverageValue').textContent = `${analysis.coveragePercent}% of outgoing spending categorised`;
  byId('uncategorisedBudgetValue').textContent = formatCurrency(analysis.uncategorisedActual);
  byId('uncategorisedBudgetNotice').hidden = analysis.uncategorisedActual <= 0;
  const list = byId('budgetRows'); clear(list);
  if (!analysis.rows.length) {
    const empty = element('div', 'empty-inline', 'No budget items yet. Add essentials first, then minimum debt payments.');
    list.append(empty);
  }
  for (const item of analysis.rows) {
    const row = element('div', 'budget-item');
    const line = element('div', 'budget-line');
    const summary = element('div', 'budget-line-summary');
    append(summary, element('strong', 'budget-category-name', item.category), element('span', '', `${formatCurrency(item.actual)} spent of ${formatCurrency(item.planned)}`));
    const actions = element('div', 'budget-item-actions');
    const edit = actionButton('budget', item.id, 'Edit');
    edit.setAttribute('aria-label', `Edit ${item.category} budget`);
    const remove = element('button', 'budget-remove-button', 'Remove');
    remove.type = 'button'; remove.dataset.budgetRemove = item.id;
    remove.setAttribute('aria-label', `Remove ${item.category} from budget`);
    append(actions, edit, remove);
    append(line, summary, actions);
    let status = item.actual < 0
      ? `${formatCurrency(Math.abs(item.actual))} net refund`
      : item.remaining < 0
        ? `${formatCurrency(Math.abs(item.remaining))} over plan`
        : item.remaining === 0 ? 'Budget used' : `${formatCurrency(item.remaining)} remaining`;
    if (allTime) status += ` · ${formatCurrency(item.monthlyPlanned)} per month × ${analysis.monthCount}`;
    const track = element('div', `budget-bar${item.remaining < 0 ? ' over' : ''}`);
    const bar = document.createElement('span'); bar.style.width = `${Math.min(100, item.progressPercent ?? (item.actual ? 100 : 0))}%`; track.append(bar);
    append(row, line, element('span', 'budget-status', status), track);
    if (item.contributions.length) {
      const details = element('details', 'budget-contributions');
      details.append(element('summary', '', `Why? ${item.contributions.length} payment${item.contributions.length === 1 ? '' : 's'}`));
      const payments = element('div', 'budget-contribution-list');
      for (const contribution of item.contributions) {
        const payment = element('div', 'budget-contribution');
        append(payment, element('span', '', `${formatDate(contribution.date)} · ${contribution.description}`), element('strong', contribution.amount < 0 ? 'incoming' : '', formatCurrency(contribution.amount)), actionButton('transaction', contribution.id, 'Edit'));
        payments.append(payment);
      }
      details.append(payments); row.append(details);
    }
    list.append(row);
  }
  const ideas = byId('savingsIdeas'); clear(ideas);
  for (const item of findSavingsOpportunities(state).slice(0, 4)) {
    const card = element('article', 'check-card neutral'); append(card, element('h3', '', item.category), element('p', '', item.text)); ideas.append(card);
  }
}

function renderDocuments() {
  const container = byId('documentCards'); clear(container);
  const documents = state.documents.filter((document) => !document.deletedAt).sort((left, right) => right.importedAt.localeCompare(left.importedAt));
  if (!documents.length) {
    const empty = element('article', 'panel'); append(empty, element('h2', '', 'No secure documents yet'), element('p', 'muted', 'Import a bank statement, payslip or credit report. The encrypted original will appear here automatically.')); container.append(empty); return;
  }
  for (const documentItem of documents) {
    const card = entityCard('document', documentItem, [stat('Type', titleCase(documentItem.kind)), stat('Imported', formatDate(documentItem.importedAt)), stat('Status', titleCase(documentItem.parseStatus), true)], false);
    card.querySelector('.entity-title h3').textContent = documentItem.displayName || documentItem.originalName;
    card.querySelector('.entity-title p').textContent = `Original: ${documentItem.originalName}${documentItem.notes ? ` · ${documentItem.notes}` : ''}`;
    const controls = card.querySelector('.entity-controls'); clear(controls);
    const open = element('button', 'primary-button', 'Open securely'); open.type = 'button'; open.dataset.documentOpen = documentItem.id;
    const remove = element('button', 'danger-button', 'Delete'); remove.type = 'button'; remove.dataset.documentDelete = documentItem.id;
    append(controls, open, remove); container.append(card);
  }
}

function renderAccounts() {
  const container = byId('accountCards'); clear(container);
  if (!state.accounts.length) {
    container.append(element('p', 'muted', 'No accounts yet. Add one account to begin importing statements.'));
    return;
  }
  for (const account of [...state.accounts].sort((left, right) => compareLabels(left.name, right.name))) {
    container.append(entityCard('account', account, [
      stat('Type', titleCase(account.type || 'current')),
      stat('Balance', account.currentBalance == null ? 'Unknown' : formatCurrency(account.currentBalance)),
      stat('Status', account.active === false ? 'Archived' : 'Active', true)
    ]));
  }
}

function renderSettings() {
  byId('dependableIncomeInput').value = state.profile.dependableIncome;
  byId('paydayDayInput').value = knownPaydayDay(state.profile.paydayDay) || '';
  byId('extraPaymentInput').value = state.settings.extraDebtPayment;
  byId('bufferTargetInput').value = state.settings.emergencyBufferTarget;
  byId('bufferBalanceInput').value = state.settings.emergencyBufferBalance;
  byId('llmModelInput').value = state.settings.llmModel;
  byId('themeSelect').value = state.settings.appearance.theme;
}

function renderPrivacy() {
  byId('encryptionDot').className = `status-dot ${encryption.available ? 'good' : 'bad'}`;
  byId('encryptionText').textContent = encryption.available ? 'Data and documents protected by the operating system' : 'Secure document vault unavailable';
  byId('privacyDetails').textContent = encryption.available ? 'Your finance state and document-vault key are protected by the operating system. Documents are encrypted again with AES-256-GCM.' : 'The operating system did not provide secure storage. Finance data can still open, but document imports are blocked rather than stored insecurely.';
}

async function importDocuments(kind) {
  if (kind === 'statement' && !state.accounts.some((account) => account.active !== false)) {
    selectView('settings');
    openEditor('account');
    showToast('Add an account before importing its statement.');
    return;
  }
  try {
    const results = await window.financeAPI.importFiles({ kind, accountId: kind === 'statement' ? byId('statementAccountSelect').value : '' });
    if (results?.status === 'blocked') throw new Error(results.message || 'Saving is paused while recovery is required.');
    for (const result of results) {
      if (!state.documents.some((documentItem) => documentItem.id === result.document.id)) {
        state.documents.push(result.document);
      }
    }
    importQueue.push(...results);
    renderDocuments();
    showNextImport();
  } catch (error) { showToast(error.message); }
}

function showNextImport() {
  if (currentImport || !importQueue.length) return;
  currentImport = importQueue.shift();
  if (currentImport.status === 'duplicate' || currentImport.status === 'pending') {
    const duplicate = currentImport.status === 'duplicate';
    byId('importResultTitle').textContent = duplicate ? 'Already imported' : 'Already selected';
    byId('importResultMessage').textContent = duplicate
      ? 'OneStep recognised this document from its contents. Renaming, copying or moving the file does not create a new financial document.'
      : 'This document is already waiting for review. Finish or close its existing preview before selecting it again.';
    byId('importResultDialog').showModal();
    return;
  }
  const preview = currentImport.preview;
  byId('importTitle').textContent = currentImport.document.originalName;
  const summary = byId('importSummary'); clear(summary);
  clear(byId('importChanges'));
  byId('importChanges').hidden = true;
  if (preview.kind === 'credit-report') {
    currentImport.creditPlan = buildCreditReportImportPlan(state, preview, currentImport.document.id);
    const counts = currentImport.creditPlan.counts;
    const score = preview.summary.score == null ? 'Not detected' : `${preview.summary.score}${preview.summary.scoreMaximum ? ` / ${preview.summary.scoreMaximum}` : ''}`;
    append(summary,
      summaryTile('Provider', preview.summary.provider || 'Unknown'),
      summaryTile('Report date', preview.summary.reportDate ? formatDate(preview.summary.reportDate) : 'Not detected'),
      summaryTile('Score', score),
      summaryTile('Accounts found', counts.total),
      summaryTile('Matched', counts.match + counts.update + counts.conflict),
      summaryTile('New', counts.new),
      summaryTile('Needs review', counts.review + counts.conflict)
    );
    renderCreditReportChanges(currentImport.creditPlan);
  } else if (preview.kind === 'payslip') {
    append(summary, summaryTile('Period', monthLabel(preview.summary.period)), summaryTile('Gross', formatCurrency(preview.summary.gross)), summaryTile('Deductions', formatCurrency(preview.summary.deductions)), summaryTile('Net', formatCurrency(preview.summary.net)));
  } else {
    currentImport.statementPlan = buildStatementImportPlan(state, preview, currentImport.document.id);
    const plan = currentImport.statementPlan;
    const accountName = plan.accountMatch.account?.name || 'Needs confirmation';
    const balanceLabel = statementBalancePlanLabel(plan.balance);
    append(summary,
      summaryTile('Account', accountName),
      summaryTile('New', plan.counts.new),
      summaryTile('Already known', plan.counts.alreadyKnown),
      summaryTile('Needs review', plan.counts.needsReview),
      summaryTile('Reconciliation', preview.reconciled ? 'Reconciled' : 'Balance protected'),
      summaryTile('Account balance', balanceLabel)
    );
    renderStatementChanges(plan);
  }
  const warning = byId('importWarnings');
  const messages = [...(currentImport.statementPlan?.warnings || currentImport.creditPlan?.warnings || preview.warnings), ...preview.rejected.map((item) => `Row ${item.row || '—'}: ${item.reason}`)];
  warning.hidden = !messages.length; warning.textContent = messages.join('\n');
  renderImportPreview(preview);
  syncConfirmImportButton();
  byId('importDialog').showModal();
}

function syncConfirmImportButton() {
  const button = byId('confirmImportButton');
  if (!currentImport?.preview) {
    button.disabled = false;
    button.textContent = 'Import reviewed records';
    return;
  }
  const preview = currentImport.preview;
  button.disabled = preview.kind === 'statement'
    ? !currentImport.statementPlan.canApply
    : preview.kind === 'credit-report' ? !currentImport.creditPlan.canApply : !preview.records.length;
  button.textContent = preview.kind === 'credit-report' ? 'Apply reviewed credit report'
    : preview.kind === 'statement' && !preview.reconciled ? 'Store for Review Inbox' : 'Import reviewed records';
}

function renderImportPreview(preview) {
  const head = byId('importPreviewHead'); const body = byId('importPreviewRows'); clear(head); clear(body);
  const headerRow = document.createElement('tr');
  const headers = preview.kind === 'credit-report'
    ? ['Lender', 'Type', 'Balance', 'Limit', 'Action']
    : preview.kind === 'payslip' ? ['Period', 'Gross', 'Deductions', 'Net'] : ['Date', 'Description', 'Incoming', 'Outgoing', 'Balance', 'Action'];
  headers.forEach((label) => headerRow.append(element('th', '', label))); head.append(headerRow);
  if (preview.kind === 'credit-report') {
    const plan = currentImport?.creditPlan?.accountPlans || [];
    if (!plan.length) {
      const row = document.createElement('tr'); const empty = cell('No structured account rows detected. The PDF can still be stored securely.'); empty.colSpan = 5; row.append(empty); body.append(row);
      return;
    }
    for (const item of plan) {
      const row = document.createElement('tr');
      append(row, cell(item.account.lender), cell(item.account.accountType || 'Unknown'), amountCell(item.account.currentBalance), amountCell(item.account.creditLimit), cell(creditPlanLabel(item)));
      body.append(row);
    }
    return;
  }
  for (const record of preview.records.slice(0, 100)) {
    const row = document.createElement('tr');
    if (preview.kind === 'payslip') append(row, cell(monthLabel(record.period)), amountCell(record.grossPay), amountCell(record.totalDeductions), amountCell(record.netPay));
    else {
      const recordPlan = currentImport?.statementPlan?.recordPlans.find((item) => item.record.id === record.id) || { action: 'add' };
      append(row, cell(formatDate(record.date)), cell(record.description), amountCell(record.incoming, 'incoming'), amountCell(record.outgoing, 'outgoing'), amountCell(record.runningBalance), cell(statementRecordActionLabel(recordPlan)));
    }
    body.append(row);
  }
}

async function confirmCurrentImport(event) {
  event.preventDefault();
  if (!currentImport) return;
  const preview = currentImport.preview;
  let completionMessage = 'Reviewed records imported.';
  if (preview.kind === 'credit-report') {
    const applied = applyCreditReportImportPlan(state, preview, currentImport.creditPlan, currentImport.document.id);
    await saveState(applied.state);
    const result = applied.result;
    completionMessage = `Credit report imported. ${result.addedDebts} debt${result.addedDebts === 1 ? '' : 's'} and ${result.addedOverdrafts} overdraft${result.addedOverdrafts === 1 ? '' : 's'} added; ${result.updated} tracked account${result.updated === 1 ? '' : 's'} updated; ${result.review + result.conflicts} need${result.review + result.conflicts === 1 ? 's' : ''} review.`;
    currentImport = null;
    byId('importDialog').close('confirmed');
    render();
    showToast(completionMessage);
    showNextImport();
    return;
  } else if (preview.kind === 'payslip') {
    for (const record of preview.records) if (!state.payslips.some((item) => item.id === record.id)) state.payslips.push(record);
  } else {
    const applied = applyStatementImportPlan(state, preview, currentImport.statementPlan, currentImport.document.id);
    await saveState(applied.state);
    const result = applied.result;
    completionMessage = statementCompletionMessage(result);
    currentImport = null;
    byId('importDialog').close('confirmed');
    render();
    showToast(completionMessage);
    showNextImport();
    return;
  }
  const recordCount = preview.kind === 'credit-report' ? (preview.records[0]?.accounts || []).length : preview.records.length;
  const stateDocument = state.documents.find((document) => document.id === currentImport.document.id);
  if (stateDocument) stateDocument.parseStatus = 'imported';
  state.importBatches.push({ id: createId('import'), documentId: currentImport.document.id, kind: preview.kind, importedAt: new Date().toISOString(), recordCount, reconciled: preview.reconciled });
  await saveState();
  currentImport = null;
  byId('importDialog').close('confirmed');
  render();
  showToast(completionMessage);
  showNextImport();
}

function renderStatementChanges(plan) {
  const container = byId('importChanges');
  clear(container);
  const changes = [
    ['ADD', `${plan.counts.add} new transaction${plan.counts.add === 1 ? '' : 's'}`],
    ['ALREADY KNOWN', `${plan.counts.alreadyKnown} overlapping transaction${plan.counts.alreadyKnown === 1 ? '' : 's'}`],
    ['RECONCILE', statementBalancePlanLabel(plan.balance)],
    ['REVIEW', `${plan.counts.needsReview} possible duplicate${plan.counts.needsReview === 1 ? '' : 's'} · ${plan.counts.recurring} recurring observation${plan.counts.recurring === 1 ? '' : 's'}`]
  ];
  for (const [label, value] of changes) {
    const item = element('div', 'import-change');
    append(item, element('strong', '', label), element('span', '', value));
    container.append(item);
  }
  container.hidden = false;
}

function statementBalancePlanLabel(balance) {
  if (balance.action === 'update') {
    const current = balance.currentBalance !== null && balance.currentBalance !== undefined && Number.isFinite(Number(balance.currentBalance)) ? formatCurrency(balance.currentBalance) : 'Unknown';
    return `${current} → ${formatCurrency(balance.closingBalance)}`;
  }
  if (balance.action === 'historical-only') return 'Keep newer balance';
  if (balance.action === 'needs-review') return 'Account needs confirmation';
  return 'No balance update';
}

function statementRecordActionLabel(plan) {
  if (plan.action === 'already-known') return 'Already known';
  if (plan.action === 'needs-review') return 'Needs review · possible duplicate';
  if (plan.transfer) return `Add · ${plan.transfer.confidence} internal transfer`;
  if (plan.recurring) return `Add · ${plan.recurring.confidence} ${plan.recurring.cadence} pattern`;
  return 'Add';
}

function statementCompletionMessage(result) {
  if (result.awaitingImportReview) return `Statement stored. ${result.added} payment${result.added === 1 ? '' : 's'} remain outside trusted totals until you apply or reject them in Review Inbox.`;
  const balance = result.balanceAction === 'overdraft-created'
    ? ' Account balance updated and its overdraft added.'
    : result.balanceAction === 'overdraft-updated' ? ' Account and overdraft balances updated.'
      : result.balanceAction === 'account-updated' ? ' Account balance updated.'
        : result.balanceAction === 'historical-only' ? ' The newer account balance was preserved.' : ' The account balance was protected.';
  const known = result.alreadyKnown ? ` ${result.alreadyKnown} already-known transaction${result.alreadyKnown === 1 ? '' : 's'} skipped.` : '';
  return `Statement imported. ${result.added} new transaction${result.added === 1 ? '' : 's'} added.${known}${balance}`;
}

async function handleImportDialogClosed() {
  if (!currentImport) return;
  const abandoned = currentImport;
  currentImport = null;
  if (abandoned.status === 'ready') {
    const document = state.documents.find((item) => item.id === abandoned.document.id);
    if (document && document.parseStatus !== 'imported') {
      document.parseStatus = 'needs_review';
      await saveState();
      renderDocuments();
    }
  }
  showNextImport();
}

function creditPlanLabel(item) {
  if (item.category === 'new') return item.kind === 'overdraft' ? 'New · add as overdraft' : 'New · add as debt';
  const balance = item.changes?.find((change) => change.field === 'currentBalance');
  if (item.category === 'update' && balance?.apply) return `Update · ${formatCurrency(balance.from)} → ${formatCurrency(balance.to)}`;
  if (item.category === 'update') return `Update · ${item.changes.filter((change) => change.apply).length} field${item.changes.filter((change) => change.apply).length === 1 ? '' : 's'}`;
  if (item.category === 'match') return `Match · ${item.reason || 'unchanged'}`;
  if (item.category === 'conflict' && balance && !balance.apply) return `Conflict · keep ${formatCurrency(balance.from)}`;
  if (item.category === 'conflict') return 'Conflict · safer state kept';
  if (item.category === 'review') return 'Needs review';
  return 'Ignore historical / informational';
}

function renderCreditReportChanges(plan) {
  const container = byId('importChanges');
  clear(container);
  const counts = plan.counts;
  const changes = [
    ['UPDATE', `${counts.update} account${counts.update === 1 ? '' : 's'} with dated field changes`],
    ['NEW', `${counts.new} positive-balance account${counts.new === 1 ? '' : 's'} proposed`],
    ['CONFLICT', `${counts.conflict} material conflict${counts.conflict === 1 ? '' : 's'} kept cautious`],
    ['REVIEW', `${counts.review} ambiguous account${counts.review === 1 ? '' : 's'} left unchanged`],
    ['HISTORY', `${counts.ignore} settled, zero-balance or informational account${counts.ignore === 1 ? '' : 's'}`]
  ];
  for (const [label, value] of changes) {
    const item = element('div', 'import-change');
    append(item, element('strong', '', label), element('span', '', value));
    container.append(item);
  }
  container.hidden = false;
}

async function completeNextAction() {
  if (!pendingAction.reviewId) return;
  if (pendingAction.completeDirect) {
    const item = state.reviewItems.find((entry) => entry.id === pendingAction.reviewId);
    const task = state.tasks.find((entry) => String(entry.id) === item?.sourceId);
    if (task) task.completedAt = new Date().toISOString();
    synchroniseReviewItems(state);
    state.checkIns.push({ id: createId('checkin'), date: new Date().toISOString(), completed: true, kind: 'action', actionId: item?.sourceId, note: pendingAction.title });
    await saveState(); render(); showToast('Action completed. Here is what matters next.');
    return;
  }
  await openReviewWorkflow(pendingAction.reviewId);
}

async function snoozeNextAction() {
  if (!pendingAction.reviewId) return;
  snoozeReviewItem(state, pendingAction.reviewId, 'tomorrow');
  await saveState();
  await animateFocusPanel('is-switching', 180);
  render();
  const panel = document.querySelector('.focus-panel');
  panel.classList.add('is-arriving');
  window.setTimeout(() => panel.classList.remove('is-arriving'), 320);
  showToast('Snoozed until tomorrow. Here is your next available step.');
}

async function logCheckIn() {
  if (hasCompletedCheckIn(state.checkIns)) {
    showToast('Today’s check-in is already complete.');
    return;
  }
  state.checkIns.push({ id: createId('checkin'), date: new Date().toISOString(), completed: true, kind: 'five-minute', note: 'Five-minute check-in' });
  await saveState();
  await animateFocusPanel('is-completing', 360);
  render();
  showToast('Five-minute check-in complete. That is enough for today.');
}

async function animateFocusPanel(className, duration) {
  const panel = document.querySelector('.focus-panel');
  if (!panel || panel.hidden) return;
  panel.classList.add(className);
  await new Promise((resolve) => { window.setTimeout(resolve, duration); });
  panel.classList.remove(className);
}

async function handleEditClick(event) {
  const budgetRemove = event.target.closest('[data-budget-remove]');
  if (budgetRemove) {
    await removeBudgetItem(budgetRemove.dataset.budgetRemove);
    return;
  }
  const review = event.target.closest('[data-duplicate-review]');
  if (review) {
    const decision = review.dataset.duplicateReview;
    const label = decision === 'accepted' ? 'include this payment in trusted financial totals' : 'keep this payment excluded as a duplicate';
    if (!window.confirm(`Confirm that OneStep should ${label}?`)) return;
    const item = state.reviewItems.find((entry) => entry.type === 'possible_duplicate' && entry.sourceId === review.dataset.id && entry.status !== 'resolved');
    const next = item
      ? resolveReviewItem(state, item.id, decision === 'accepted' ? 'both_genuine' : 'duplicate')
      : resolvePossibleDuplicate(state, review.dataset.id, decision);
    await saveState(next);
    render();
    showToast(decision === 'accepted' ? 'Payment accepted and included in financial totals.' : 'Duplicate confirmed and kept out of financial totals.');
    return;
  }
  const button = event.target.closest('[data-edit]');
  if (button) openEditor(button.dataset.edit, button.dataset.id);
}

function openEditor(type, id = '', context = {}) {
  editorContext = { type, id, ...context };
  const collection = collectionFor(type);
  const item = id ? state[collection].find((entry) => entry.id === id) : null;
  const editorItem = type === 'transaction' && item
    ? transactionEditorItem(item)
    : type === 'payslip'
      ? payslipEditorItem(item || { period: state.settings.selectedMonth === ALL_TIME_PERIOD ? new Date().toISOString().slice(0, 7) : state.settings.selectedMonth })
      : item;
  byId('editEyebrow').textContent = item ? 'EDIT' : 'ADD';
  byId('editTitle').textContent = `${item ? 'Edit' : 'Add'} ${type === 'account' ? 'bank account' : type}`;
  const fields = byId('editFields'); clear(fields);
  for (const definition of editorDefinitions(type)) fields.append(buildField(definition, editorItem));
  if (item) {
    const deleteButton = element('button', 'danger-button wide-field', `Delete ${type}`); deleteButton.type = 'button'; deleteButton.addEventListener('click', () => deleteEditedItem(type, id)); fields.append(deleteButton);
  }
  byId('editDialog').showModal();
}

function editorDefinitions(type) {
  if (type === 'account') return [
    ['name', 'Account name', 'text', 'Required'], ['institution', 'Bank or institution', 'text'],
    ['type', 'Account type', 'select', [['current','Current account'],['savings','Savings account'],['cash','Cash account'],['other','Other']]],
    ['openingBalance', 'Opening balance', 'number'], ['currentBalance', 'Current / reconciled balance', 'number'],
    ['statementDate', 'Latest statement date', 'date'], ['active', 'Active account', 'checkbox'],
    ['notes', 'Notes', 'textarea', '', 'wide-field']
  ];
  if (type === 'transaction') return [
    ['accountId', 'Account', 'select', alphabeticalOptions(state.accounts.map((account) => [account.id, account.name]))], ['date', 'Date', 'date'],
    ['description', 'Statement / payment description', 'text', 'Required', 'wide-field'], ['userDescription', 'Your description', 'text', 'Optional clearer name', 'wide-field'],
    ['incoming', 'Incoming', 'number'], ['outgoing', 'Outgoing', 'number'], ['runningBalance', 'Running balance', 'number'],
    ['budgetCategoryId', 'Payment category', 'select', paymentCategoryOptions()],
    ['category', 'Statement category label', 'text'],
    ['budgetTreatment', 'Budget treatment', 'select', [['auto','Automatic'],['spending','Spending'],['refund','Refund'],['reversal','Reversal'],['transfer','Internal transfer'],['savings_transfer','Savings transfer'],['debt_payment','Debt payment'],['ignored','Do not include']]],
    ['transferStatus', 'Internal transfer match', 'select', [['no','No'],['possible','Possible'],['confirmed','Confirmed']], '', 'semantic'], ['recurring', 'Recurring payment', 'checkbox'], ['notes', 'Notes', 'textarea', '', 'wide-field']
  ];
  if (type === 'payslip') return [
    ['period', 'Pay month', 'month'], ['payDate', 'Pay date', 'date'],
    ['grossPay', 'Gross pay', 'number'], ['netPay', 'Net pay', 'number'],
    ['taxablePay', 'Taxable pay', 'number'], ['niablePay', 'NI-able pay', 'number'],
    ['annualSalary', 'Annual salary', 'number'], ['taxCode', 'Tax code', 'text'],
    ['taxBasis', 'Tax basis', 'text'], ['niCategory', 'NI category', 'text'],
    ['employerPayeReference', 'Employer PAYE reference', 'text'],
    ['earningsText', 'Payments and allowances - one per line as Description | 0.00', 'textarea', 'Basic pay | 2500.00', 'wide-field'],
    ['deductionsText', 'Deductions - one per line as Description | 0.00 (total calculated automatically)', 'textarea', 'PAYE | 350.00', 'wide-field'],
    ['grossPayYtd', 'Gross pay YTD', 'number'], ['taxablePayYtd', 'Taxable pay YTD', 'number'],
    ['niablePayYtd', 'NI-able pay YTD', 'number'], ['payeYtd', 'PAYE YTD', 'number'],
    ['niEmployeeYtd', 'Employee NI YTD', 'number'], ['niEmployerYtd', 'Employer NI YTD', 'number'],
    ['notes', 'Notes', 'textarea', '', 'wide-field']
  ];
  if (type === 'budget') return [['section','Section','select',[['Essentials','Essentials'],['Debt minimums','Debt minimums'],['Flexible','Flexible'],['Goals','Goals']], '', 'semantic'], ['category','Category','text'], ['planned','Planned monthly amount','number'], ['notes','Notes','textarea','','wide-field']];
  const base = [['name','Name','text'], ['type','Type','text'], ['accountReference','Account reference / last four digits','text'], ['openedDate','Opened date','date'], ['defaultDate','Default date','date'], ['lastReportedAt','Last reported date','date'], ['currentBalance','Current balance','number'], ['aprPercent','APR (%) - leave blank if unknown','number'], ['contractualPayment','Contractual / minimum payment','number'], ['arrearsAmount','Known arrears amount','number'], ['status','Status','select',[['unknown','Unknown'],['current','Current'],['arrears','Arrears'],['defaulted','Defaulted'],['over_limit','Over limit']], '', 'semantic'], ['arrangementStatus','Payment arrangement','select',[['unknown','Unknown'],['none','Confirmed none'],['confirmed','Confirmed arrangement']], '', 'semantic'], ['arrangementPayment','Agreed arrangement payment','number'], ['includeInPlan','Include in payoff plan','checkbox'], ['statusConflict','Status information conflicts / needs checking','checkbox'], ['interestFrozen','Interest or charges frozen','checkbox'], ['description','Description','textarea','','wide-field'], ['notes','Notes','textarea','','wide-field']];
  if (type === 'overdraft') {
    base.splice(1, 0, ['accountId', 'Linked account', 'select', [['','Not linked'], ...alphabeticalOptions(state.accounts.map((account) => [account.id, account.name]))]]);
    base.splice(8, 0, ['limit','Overdraft limit','number']);
  } else {
    base.splice(7, 0, ['originalBalance','Original balance / amount','number'], ['creditLimit','Credit limit','number']);
  }
  return base;
}

function buildField(definition, item) {
  const [name, labelText, type, options, className, order] = definition;
  const label = element('label', className || ''); label.append(document.createTextNode(labelText));
  let input;
  if (type === 'select') {
    input = document.createElement('select');
    const orderedOptions = order === 'semantic' ? options : alphabeticalOptions(options);
    for (const [value, text] of orderedOptions) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
  } else if (type === 'textarea') { input = document.createElement('textarea'); input.rows = 4; }
  else { input = document.createElement('input'); input.type = type; if (type === 'number') input.step = '0.01'; }
  input.name = name;
  let value = item?.[name];
  if (name === 'aprPercent') value = item?.apr == null ? '' : item.apr * 100;
  if (type === 'checkbox') input.checked = value ?? ['includeInPlan', 'active'].includes(name);
  else input.value = value ?? '';
  if (options && typeof options === 'string') input.placeholder = options;
  label.append(input); return label;
}

async function saveEditor(event) {
  event.preventDefault();
  if (!editorContext) return;
  const { type, id } = editorContext;
  const collection = collectionFor(type);
  let item = id ? state[collection].find((entry) => entry.id === id) : null;
  if (type === 'payslip') {
    const values = {};
    for (const definition of editorDefinitions(type)) {
      const [name, , fieldType] = definition;
      const input = byId('editFields').querySelector(`[name="${name}"]`);
      values[name] = fieldType === 'number' && input.value.trim() !== '' ? Number(input.value) : input.value.trim();
    }
    const result = buildPayslipRecord(values, item || { id: createId('payslip'), provider: 'manual', source: 'Manual entry' });
    if (!result.valid) {
      window.alert(`This pay record cannot be saved yet:\n\n${result.errors.join('\n')}`);
      return;
    }
    if (item) Object.assign(item, result.record);
    else state.payslips.push(result.record);
    await saveState();
    populateMonthOptions();
    byId('editDialog').close(); editorContext = null; render(); showToast('Pay record saved.');
    return;
  }
  const wasIncomePayment = type === 'transaction' && isIncomePayment(item);
  const previousBudgetCategory = type === 'budget' ? item?.category : '';
  if (!item) { item = { id: createId(type) }; state[collection].push(item); }
  for (const definition of editorDefinitions(type)) {
    const [name, , fieldType] = definition; const input = byId('editFields').querySelector(`[name="${name}"]`);
    let value = fieldType === 'checkbox' ? input.checked : input.value.trim();
    if (fieldType === 'number') value = value === '' ? null : Number(value);
    if (name === 'aprPercent') item.apr = value === null ? null : value / 100;
    else item[name] = value;
  }
  if (type === 'transaction') {
    item.budgetMonth = item.date?.slice(0, 7) || state.settings.selectedMonth;
    item.source ||= 'manual'; item.cleared ??= true; item.incoming = Number(item.incoming || 0); item.outgoing = Number(item.outgoing || 0);
    item.categorySource = 'manual';
    if (item.budgetCategoryId === INCOME_PAYMENT_CATEGORY_VALUE) {
      item.budgetCategoryId = '';
      item.category = INCOME_PAYMENT_CATEGORY;
    } else {
      const budget = state.budgets.find((entry) => entry.id === item.budgetCategoryId);
      if (budget) item.category = budget.category;
      else if (wasIncomePayment && isIncomePayment(item)) item.category = '';
    }
  }
  if (type === 'budget' && previousBudgetCategory && previousBudgetCategory !== item.category) {
    for (const transaction of state.transactions) {
      if (!transaction.budgetCategoryId && transaction.categorySource !== 'manual' && normalisedText(transaction.category) === normalisedText(previousBudgetCategory)) transaction.budgetCategoryId = item.id;
    }
  }
  if (type === 'debt' || type === 'overdraft') {
    item.updatedAt = new Date().toISOString(); item.planPriority ??= 999; item.arrangementConfirmed = item.arrangementStatus === 'confirmed';
    if (editorContext.reviewItemId && item.statusConflict === false) {
      item.reviewedReportedStatus = item.reportedStatus || '';
      item.statusReviewedAt = item.updatedAt;
    }
  }
  if (type === 'account') { item.name ||= 'Unnamed account'; item.active ??= true; }
  await saveState();
  if (type === 'account') populateAccountOptions();
  if (type === 'budget') populatePaymentCategoryOptions();
  if (type === 'transaction' || type === 'payslip') populateMonthOptions();
  byId('editDialog').close(); editorContext = null; render(); showToast('Saved.');
}

async function deleteEditedItem(type, id) {
  if (type === 'budget') {
    await removeBudgetItem(id, true);
    return;
  }
  if (type === 'account' && (state.transactions.some((item) => item.accountId === id) || state.overdrafts.some((item) => item.accountId === id))) {
    window.alert('This account is linked to payments or an overdraft. Mark it as archived instead.');
    return;
  }
  if (!window.confirm(`Delete this ${type}? This can be recovered only from a backup.`)) return;
  const collection = collectionFor(type); state[collection] = state[collection].filter((item) => item.id !== id);
  await saveState();
  if (type === 'account') populateAccountOptions();
  if (type === 'budget') populatePaymentCategoryOptions();
  byId('editDialog').close(); editorContext = null; render(); showToast('Deleted.');
}

async function removeBudgetItem(id, closeEditor = false) {
  const budget = state.budgets.find((item) => item.id === id);
  if (!budget) {
    showToast('That budget category is no longer available.');
    return;
  }
  const linkedCount = state.transactions.filter((transaction) => transaction.budgetCategoryId === id).length;
  const linkedMessage = linkedCount
    ? ` ${linkedCount} linked payment${linkedCount === 1 ? '' : 's'} will remain and become uncategorised.`
    : '';
  if (!window.confirm(`Remove ${budget.category} from your budget?${linkedMessage}`)) return;
  await saveState(removeBudgetCategory(state, id));
  populatePaymentCategoryOptions();
  if (closeEditor && byId('editDialog').open) byId('editDialog').close();
  editorContext = closeEditor ? null : editorContext;
  render();
  showToast(`${budget.category} was removed from your budget.`);
}

async function handleDocumentClick(event) {
  const open = event.target.closest('[data-document-open]');
  if (open) { try { await window.financeAPI.openDocument(open.dataset.documentOpen); } catch (error) { showToast(error.message); } return; }
  const remove = event.target.closest('[data-document-delete]');
  if (remove && window.confirm('Permanently delete this encrypted document? Records already imported from it will remain.')) {
    state = await window.financeAPI.deleteDocument(remove.dataset.documentDelete); render(); showToast('Encrypted document deleted. Its private import fingerprint was retained to prevent duplicate financial records.');
  }
}

async function askGuide(event) {
  event.preventDefault();
  const question = byId('guideQuestion').value.trim(); if (!question) return;
  addChatMessage('user', question); byId('guideQuestion').value = '';
  const pending = addChatMessage('guide', 'Thinking locally…');
  try {
    const answer = await window.financeAPI.askLocalModel(question);
    pending.textContent = answer.ok ? answer.message : buildFallbackAnswer(question, state);
    pending.append(element('small', '', answer.ok ? `Local model · ${state.settings.llmModel}` : `Local financial checks · ${answer.status?.reason || 'model unavailable'}`));
  } catch (error) {
    pending.textContent = buildFallbackAnswer(question, state); pending.append(element('small', '', `Local financial checks · ${error.message}`));
  }
}

function addChatMessage(role, text) {
  const message = element('div', `chat-message ${role}`, text); byId('chatMessages').append(message); message.scrollIntoView({ block: 'nearest' }); return message;
}

async function checkModel() {
  try {
    const status = await window.financeAPI.checkLocalModel(byId('llmModelInput')?.value || state.settings.llmModel);
    byId('llmStatus').className = `status-pill ${status.available ? 'good' : 'warning'}`;
    byId('llmStatus').textContent = status.available ? `Local model ready · ${state.settings.llmModel}` : `Checks fallback · ${status.reason}`;
  } catch { byId('llmStatus').className = 'status-pill warning'; byId('llmStatus').textContent = 'Local financial checks active'; }
}

async function saveSettings() {
  state.profile.dependableIncome = Number(byId('dependableIncomeInput').value || 0);
  state.profile.paydayDay = knownPaydayDay(byId('paydayDayInput').value);
  state.settings.extraDebtPayment = Number(byId('extraPaymentInput').value || 0);
  state.settings.emergencyBufferTarget = Number(byId('bufferTargetInput').value || 0);
  state.settings.emergencyBufferBalance = Number(byId('bufferBalanceInput').value || 0);
  state.settings.llmModel = byId('llmModelInput').value.trim() || 'qwen2.5:1.5b';
  await saveAndRender(); checkModel(); showToast('Settings saved.');
}

async function createBackup() {
  const passphrase = byId('backupPassphrase').value;
  const button = byId('createBackupButton');
  button.disabled = true;
  byId('backupStatus').textContent = 'Creating and verifying a consistent backup…';
  try { const result = await window.financeAPI.createBackup(passphrase); byId('backupStatus').textContent = result.canceled ? 'Backup cancelled.' : `${result.fileName} created and verified.`; }
  catch (error) { byId('backupStatus').textContent = error.message; }
  finally { button.disabled = false; }
}

async function restoreBackup() {
  const passphrase = byId('backupPassphrase').value;
  const button = byId('restoreBackupButton');
  button.disabled = true;
  byId('backupStatus').textContent = 'Select a backup to check…';
  try {
    const result = await window.financeAPI.selectRestoreBackup(passphrase);
    if (result?.status === 'blocked') throw new Error(result.message || 'Backup restore is currently unavailable.');
    if (result.canceled) { byId('backupStatus').textContent = 'Restore cancelled.'; return; }
    restoreToken = result.token;
    restoreInProgress = false;
    restoreCanCancel = true;
    renderRestoreConfirmation(result.backup);
    byId('backupStatus').textContent = 'Backup checked. Review the restore details.';
    byId('restoreDialog').showModal();
  } catch (error) {
    byId('backupStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function renderRestoreConfirmation(backup) {
  byId('restoreDialogTitle').textContent = 'Restore this backup?';
  byId('restoreExplanation').textContent = 'OneStep will verify this backup and create a safety copy of your current data before replacing anything. Your financial state and saved documents will be restored together.';
  byId('restoreCreatedAt').textContent = formatRecoveryDate(backup.createdAt);
  byId('restoreApplicationVersion').textContent = backup.applicationVersion ? `v${backup.applicationVersion}` : 'Legacy backup';
  byId('restoreDocumentCount').textContent = `${backup.documentCount} saved document${backup.documentCount === 1 ? '' : 's'}`;
  byId('restoreValidation').textContent = backup.complete ? (backup.migrationRequired ? 'Valid · migration required' : 'Complete and valid') : 'Limited legacy backup';
  byId('restoreMetadata').hidden = false;
  byId('restoreNotice').hidden = false;
  byId('restoreProgress').hidden = true;
  byId('restoreProgress').querySelectorAll('li').forEach((item) => item.className = '');
  byId('restoreStatus').textContent = backup.complete ? '' : 'This backup does not include the complete document vault and cannot be used for a normal restore.';
  byId('confirmRestoreButton').hidden = false;
  byId('confirmRestoreButton').disabled = !backup.complete;
  byId('cancelRestoreButton').textContent = 'Cancel';
  byId('closeRestoreButton').hidden = false;
}

async function confirmRestoreBackup() {
  if (!restoreToken || restoreInProgress) return;
  restoreInProgress = true;
  restoreCanCancel = true;
  byId('confirmRestoreButton').disabled = true;
  byId('confirmRestoreButton').hidden = true;
  byId('restoreMetadata').hidden = true;
  byId('restoreNotice').hidden = true;
  byId('restoreProgress').hidden = false;
  byId('restoreStatus').textContent = 'Preparing backup…';
  const token = restoreToken;
  try {
    const result = await window.financeAPI.restoreBackup(token);
    if (result.status === 'restored') {
      activateNormalMode({ status: 'normal', mode: 'normal', source: 'restored_backup', state: result.state, encryption: result.encryption || encryption });
      showRestoreOutcome('Backup restored successfully', 'Your financial data and saved documents have been verified and are ready to use.');
      byId('backupStatus').textContent = 'Backup restored successfully.';
    } else if (result.status === 'rolled_back') {
      activateNormalMode({ status: 'normal', mode: 'normal', source: 'restore_rollback', state: result.state, encryption: result.encryption || encryption });
      showRestoreOutcome('The backup could not be restored', 'OneStep returned your data to the state it was in before the restore began. Nothing from the incomplete restore has been kept as active data.');
      byId('backupStatus').textContent = 'Restore failed, but your previous data was recovered.';
    } else if (result.status === 'recovery_required') {
      byId('restoreDialog').close();
      showRecoveryMode(result);
    } else if (result.status === 'blocked') {
      throw new Error(result.message || 'The restore could not start.');
    }
  } catch (error) {
    if (error.message.includes('cancelled')) {
      byId('restoreDialog').close();
      byId('backupStatus').textContent = 'Restore cancelled before live data was changed.';
    } else {
      showRestoreOutcome('The backup could not be restored', `${error.message} Your current data has not been replaced.`);
      byId('backupStatus').textContent = error.message;
    }
  } finally {
    restoreInProgress = false;
    restoreCanCancel = true;
    restoreToken = null;
  }
}

async function cancelRestoreBackup() {
  if (!restoreToken) {
    if (byId('restoreDialog').open) byId('restoreDialog').close();
    return;
  }
  const result = await window.financeAPI.cancelRestoreBackup(restoreToken).catch(() => ({ canceled: false }));
  if (restoreInProgress && !result.canceled) return;
  if (!restoreInProgress) restoreToken = null;
  if (byId('restoreDialog').open) byId('restoreDialog').close();
  const status = recoveryResult ? byId('recoveryStatus') : byId('backupStatus');
  status.textContent = restoreInProgress ? 'Cancelling before live data is changed…' : 'Restore cancelled.';
}

function handleRestoreProgress(progress = {}) {
  if (!restoreInProgress) return;
  restoreCanCancel = Boolean(progress.canCancel);
  byId('cancelRestoreButton').hidden = !restoreCanCancel;
  byId('closeRestoreButton').hidden = !restoreCanCancel;
  const stages = [...byId('restoreProgress').querySelectorAll('li')];
  const activeIndex = stages.findIndex((item) => item.dataset.restoreStage === progress.stage);
  stages.forEach((item, index) => { item.className = index < activeIndex ? 'complete' : index === activeIndex ? 'active' : ''; });
  const labels = {
    preparing_backup: 'Preparing backup…', checking_backup_integrity: 'Checking backup integrity…', creating_safety_copy: 'Creating a safety copy…',
    ready_to_replace: 'Safety copy verified. Preparing to replace live data…', restoring_financial_data: 'Restoring financial data…', restoring_documents: 'Restoring documents…',
    verifying_restored_data: 'Verifying restored data…', finishing: 'Finishing…'
  };
  byId('restoreStatus').textContent = labels[progress.stage] || 'Restore in progress…';
}

function showRestoreOutcome(title, explanation) {
  byId('restoreDialogTitle').textContent = title;
  byId('restoreExplanation').textContent = explanation;
  byId('restoreExplanation').hidden = false;
  byId('restoreProgress').hidden = true;
  byId('restoreMetadata').hidden = true;
  byId('restoreNotice').hidden = true;
  byId('restoreStatus').textContent = '';
  byId('confirmRestoreButton').hidden = true;
  byId('cancelRestoreButton').hidden = false;
  byId('cancelRestoreButton').textContent = 'Close';
  byId('closeRestoreButton').hidden = false;
}

async function checkForUpdates() {
  byId('updateStatus').textContent = 'Checking for updates…';
  try { handleUpdateStatus(await window.financeAPI.checkForUpdates()); }
  catch { handleUpdateStatus({ state: 'unavailable', message: 'The update check couldn’t be completed.' }); }
}

async function openAvailableUpdate() {
  try {
    await window.financeAPI.openAvailableUpdate();
  } catch {
    byId('updateStatus').textContent = 'The trusted update page couldn’t be opened. Try again in a moment.';
  }
}

async function downloadAvailableUpdate() {
  try {
    handleUpdateStatus(await window.financeAPI.downloadAvailableUpdate());
  } catch {
    handleUpdateStatus({
      state: 'available',
      version: updateUiState.availableVersion,
      message: 'The update couldn’t be downloaded. Check your connection and try again.'
    });
  }
}

async function restartAndInstallUpdate() {
  try {
    handleUpdateStatus(await window.financeAPI.restartAndInstallUpdate());
  } catch {
    handleUpdateStatus({
      state: 'ready',
      version: updateUiState.availableVersion,
      message: 'OneStep could not restart into the update. Your data is safe; try again when ready.'
    });
  }
}

function handleUpdateStatus(status = {}) {
  updateUiState = applyUpdateStatus(updateUiState, status);
  renderUpdateUi();
}

function dismissUpdateNotification() {
  updateUiState = dismissUpdateUiNotification(updateUiState);
  renderUpdateUi();
}

function renderUpdateUi() {
  const view = updateUiView(updateUiState);
  const version = byId('appVersion');
  version.textContent = view.versionLabel;
  version.setAttribute('aria-label', view.versionAriaLabel);
  byId('updateStatus').textContent = view.settingsStatus;
  byId('checkUpdateButton').disabled = view.checkDisabled;
  document.querySelectorAll('[data-download-update]').forEach((button) => {
    button.hidden = !view.downloadVisible;
    button.disabled = view.downloadDisabled;
    button.textContent = view.downloadLabel;
  });
  document.querySelectorAll('[data-restart-update]').forEach((button) => {
    button.hidden = !view.installVisible;
    button.disabled = view.installDisabled;
    button.textContent = view.installLabel;
  });
  document.querySelectorAll('[data-view-update]').forEach((button) => { button.hidden = !view.viewUpdateVisible; });
  document.querySelectorAll('[data-update-progress], #settingsUpdateProgress').forEach((progress) => {
    progress.hidden = !view.progressVisible;
    progress.value = view.progressValue;
    progress.setAttribute('aria-label', view.progressLabel);
  });
  byId('updateNotificationTitle').textContent = view.notificationTitle;
  byId('updateNotificationMessage').textContent = view.notificationMessage;
  byId('updateNotificationRegion').hidden = !view.notificationVisible;
  syncNotificationLayer();
}

async function reviewDiagnostics() {
  const status = byId('diagnosticsStatus');
  const button = byId('reviewDiagnosticsButton');
  button.disabled = true;
  status.textContent = 'Preparing a private preview…';
  try {
    const report = await window.financeAPI.previewDiagnostics();
    diagnosticPreviewToken = report.token;
    byId('diagnosticsPreview').textContent = report.text;
    byId('diagnosticsSummary').textContent = `${report.entryCount} event${report.entryCount === 1 ? '' : 's'} · ${report.retentionDays}-day retention · ${report.encryptionAvailable ? 'encrypted local detail log active' : 'minimal startup log only'}`;
    status.textContent = 'Report ready to review. Nothing has been shared.';
    byId('diagnosticsDialog').showModal();
  } catch (error) {
    diagnosticPreviewToken = null;
    status.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function exportDiagnostics() {
  if (!diagnosticPreviewToken) {
    byId('diagnosticsStatus').textContent = 'Review the diagnostic report before exporting it.';
    return;
  }
  const button = byId('exportDiagnosticsButton');
  button.disabled = true;
  try {
    const result = await window.financeAPI.exportDiagnostics(diagnosticPreviewToken);
    if (!result.canceled) {
      byId('diagnosticsStatus').textContent = `${result.fileName} exported. Nothing was uploaded.`;
      showToast('Diagnostic report exported.');
    }
  } catch (error) {
    byId('diagnosticsStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function deleteDiagnostics() {
  if (!window.confirm('Delete all locally stored diagnostic events? This cannot be undone.')) return;
  const button = byId('deleteDiagnosticsButton');
  button.disabled = true;
  try {
    await window.financeAPI.deleteDiagnostics();
    diagnosticPreviewToken = null;
    byId('diagnosticsPreview').textContent = '';
    byId('diagnosticsStatus').textContent = 'All locally stored diagnostic events were deleted.';
    showToast('Diagnostics deleted.');
  } catch (error) {
    byId('diagnosticsStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function getFinancialViewCache() {
  if (financialViewCache?.state === state) return financialViewCache;
  const report = buildFinancialReport(state);
  const budgetAnalysis = report.budget;
  financialViewCache = {
    state,
    report,
    budgetAnalysis,
    ledgerIndex: buildTransactionLedgerIndex(state, budgetAnalysis)
  };
  return financialViewCache;
}

function openDashboardCustomisation() {
  renderDashboardCustomisation();
  byId('dashboardDialog').showModal();
}

function renderDashboardCustomisation() {
  const dashboard = normaliseDashboardSettings(state.settings.dashboard);
  const container = byId('dashboardCustomisationList'); clear(container);
  const modules = new Map(DASHBOARD_MODULES.map((module) => [module.id, module]));
  dashboard.order.forEach((moduleId, index) => {
    const module = modules.get(moduleId);
    const row = element('div', 'dashboard-customisation-row');
    const visibility = document.createElement('input'); visibility.type = 'checkbox'; visibility.checked = !dashboard.hidden.includes(moduleId); visibility.disabled = module.required; visibility.dataset.dashboardVisibility = moduleId; visibility.setAttribute('aria-label', `Show ${module.label}`);
    const copy = element('div', 'dashboard-customisation-copy'); append(copy, element('strong', '', module.label), element('span', '', module.simple ? 'Simple and Detailed' : 'Detailed only'));
    const pin = element('button', 'text-button', module.required ? 'Pinned' : dashboard.pinned.includes(moduleId) ? 'Unpin' : 'Pin'); pin.type = 'button'; pin.dataset.dashboardPin = moduleId; pin.disabled = module.required; pin.setAttribute('aria-pressed', String(dashboard.pinned.includes(moduleId)));
    const size = document.createElement('select'); size.dataset.dashboardSize = moduleId; size.setAttribute('aria-label', `${module.label} size`);
    for (const [value, label] of [['standard', 'Standard'], ['wide', 'Wide']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; size.append(option); }
    size.value = dashboard.sizes[moduleId];
    const controls = element('div', 'dashboard-order-controls');
    const up = element('button', 'icon-button', '↑'); up.type = 'button'; up.dataset.dashboardMove = moduleId; up.dataset.direction = 'up'; up.disabled = index === 0; up.setAttribute('aria-label', `Move ${module.label} up`);
    const down = element('button', 'icon-button', '↓'); down.type = 'button'; down.dataset.dashboardMove = moduleId; down.dataset.direction = 'down'; down.disabled = index === dashboard.order.length - 1; down.setAttribute('aria-label', `Move ${module.label} down`);
    append(controls, up, down); append(row, visibility, copy, pin, size, controls); container.append(row);
  });
}

async function handleDashboardCustomisation(event) {
  const move = event.target.closest('[data-dashboard-move]');
  const pin = event.target.closest('[data-dashboard-pin]');
  const visibility = event.target.closest('[data-dashboard-visibility]');
  const size = event.target.closest('[data-dashboard-size]');
  if (!move && !pin && !visibility && !size) return;
  let dashboard = normaliseDashboardSettings(state.settings.dashboard);
  if (move) dashboard = moveDashboardModule(dashboard, move.dataset.dashboardMove, move.dataset.direction);
  if (pin) {
    const moduleId = pin.dataset.dashboardPin;
    dashboard.pinned = dashboard.pinned.includes(moduleId) ? dashboard.pinned.filter((id) => id !== moduleId) : [...dashboard.pinned, moduleId];
  }
  if (visibility) dashboard.hidden = visibility.checked ? dashboard.hidden.filter((id) => id !== visibility.dataset.dashboardVisibility) : [...dashboard.hidden, visibility.dataset.dashboardVisibility];
  if (size) dashboard.sizes[size.dataset.dashboardSize] = size.value;
  state.settings.dashboard = normaliseDashboardSettings(dashboard);
  await saveAndRender();
  renderDashboardCustomisation();
  byId('dashboardStatus').textContent = 'Dashboard layout saved.';
}

async function resetDashboard() {
  if (!window.confirm('Reset the dashboard layout? Financial data, budgets, payments and review state will not change.')) return;
  state.settings.dashboard = defaultDashboardSettings();
  await saveAndRender();
  renderDashboardCustomisation();
  byId('dashboardStatus').textContent = 'Default dashboard restored. Financial data was unchanged.';
  showToast('Dashboard reset. Your financial data was not changed.');
}

async function saveThemePreference() {
  const theme = byId('themeSelect').value;
  state.settings.appearance.theme = THEMES.includes(theme) ? theme : 'system';
  applyTheme();
  await saveState();
  renderSettings();
  showToast(`${titleCase(state.settings.appearance.theme)} theme saved.`);
}

function applyTheme() {
  const preference = THEMES.includes(state?.settings?.appearance?.theme) ? state.settings.appearance.theme : 'system';
  const resolved = preference === 'system' ? (systemTheme.matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
}

function focusTransactionTable() {
  byId('transactionTable').focus({ preventScroll: true });
  byId('transactionTable').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function saveAndRender() { await saveState(); render(); }
async function saveState(nextState = state) {
  synchroniseSelectedMonth(nextState);
  synchroniseReviewItems(nextState);
  const saved = await window.financeAPI.saveState(nextState);
  if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while recovery is required.');
  if (saved?.status === 'conflict') {
    state = saved.state;
    synchroniseSelectedMonth(state);
    render();
    showToast(saved.message);
    const error = new Error(saved.message);
    error.code = 'STATE_REVISION_CONFLICT';
    throw error;
  }
  state = saved;
}

function populateMonthOptions() {
  const months = synchroniseSelectedMonth();
  const select = byId('monthSelect'); clear(select);
  const allTime = document.createElement('option');
  const monthCount = reportingPeriodMonthCount(state, ALL_TIME_PERIOD);
  allTime.value = ALL_TIME_PERIOD;
  allTime.textContent = `All time · ${monthCount} month${monthCount === 1 ? '' : 's'}`;
  select.append(allTime);
  for (const month of months) { const option = document.createElement('option'); option.value = month; option.textContent = monthLabel(month); select.append(option); }
  select.value = state.settings.selectedMonth;
}

function synchroniseSelectedMonth(targetState = state) {
  const months = availableReportingMonths(targetState);
  if (targetState.settings.selectedMonth !== ALL_TIME_PERIOD && !months.includes(targetState.settings.selectedMonth)) targetState.settings.selectedMonth = months[0];
  return months;
}

function populateAccountOptions() {
  for (const id of ['statementAccountSelect', 'transactionAccountFilter']) {
    const select = byId(id); const preserveAll = id === 'transactionAccountFilter'; clear(select);
    if (preserveAll) { const all = document.createElement('option'); all.value = 'all'; all.textContent = 'All accounts'; select.append(all); }
    const accounts = state.accounts.filter((item) => item.active !== false).sort((left, right) => compareLabels(left.name, right.name));
    for (const account of accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name; select.append(option); }
  }
}

function populatePaymentCategoryOptions() {
  const select = byId('transactionCategoryFilter');
  if (!select) return;
  const selected = select.value || 'all';
  clear(select);
  for (const [value, label] of [['all', 'All categories'], ...paymentCategoryOptions(true)]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option);
  }
  select.value = [...select.options].some((option) => option.value === selected) ? selected : 'all';
}

function paymentCategoryOptions(forFilter = false) {
  return alphabeticalOptions([
    [forFilter ? 'uncategorised' : '', 'Uncategorised'],
    [INCOME_PAYMENT_CATEGORY_VALUE, INCOME_PAYMENT_CATEGORY],
    ...state.budgets.filter((budget) => !isIncomePayment({ category: budget.category })).map((budget) => [budget.id, budget.category])
  ]);
}

function alphabeticalOptions(options) {
  return [...options].sort((left, right) => compareLabels(left[1], right[1]));
}

function transactionEditorItem(transaction) {
  if (isIncomePayment(transaction)) return { ...transaction, budgetCategoryId: INCOME_PAYMENT_CATEGORY_VALUE };
  if (!transaction.budgetCategoryId && transaction.categorySource !== 'manual') {
    return { ...transaction, budgetCategoryId: legacyBudgetIdForTransaction(transaction) };
  }
  return transaction;
}

function legacyBudgetIdForTransaction(transaction) {
  const category = normalisedText(transaction.category);
  const description = normalisedText(transaction.description);
  const matches = state.budgets.filter((budget) => {
    const categories = (budget.categories?.length ? budget.categories : [budget.category]).map(normalisedText);
    const merchantTerms = (budget.merchantTerms || []).map(normalisedText).filter(Boolean);
    return (category && categories.includes(category)) || (Number(transaction.outgoing || 0) > 0 && merchantTerms.some((term) => description.includes(term)));
  });
  return matches.length === 1 ? matches[0].id : '';
}

function normalisedText(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function collectionFor(type) { return ({ account: 'accounts', transaction: 'transactions', payslip: 'payslips', debt: 'debts', overdraft: 'overdrafts', budget: 'budgets' })[type]; }

function entityCard(type, item, stats, editable = true) {
  const card = element('article', 'entity-card');
  const title = element('div', 'entity-title');
  append(title, element('h3', '', item.name || item.originalName || titleCase(type)), element('p', '', item.notes || item.description || statusLabel(item.status)));
  card.append(title, ...stats);
  const controls = element('div', 'entity-controls');
  if (editable) controls.append(actionButton(type, item.id));
  card.append(controls); return card;
}

function actionCell(type, id) { const cellElement = cell(); cellElement.append(actionButton(type, id)); return cellElement; }
function transactionActionCell(item) {
  const cellElement = cell();
  const actions = element('div', 'transaction-actions');
  actions.append(actionButton('transaction', item.id));
  if (item.duplicateStatus === 'possible' && item.reviewStatus === 'pending') {
    const accept = element('button', 'duplicate-review-button accept', 'Accept');
    accept.type = 'button'; accept.dataset.duplicateReview = 'accepted'; accept.dataset.id = item.id;
    accept.setAttribute('aria-label', 'Accept possible duplicate as a genuine payment');
    const reject = element('button', 'duplicate-review-button reject', 'Duplicate');
    reject.type = 'button'; reject.dataset.duplicateReview = 'rejected'; reject.dataset.id = item.id;
    reject.setAttribute('aria-label', 'Confirm this possible duplicate should remain excluded');
    actions.append(accept, reject);
  }
  cellElement.append(actions);
  return cellElement;
}
function actionButton(type, id, label = 'Edit') { const button = element('button', 'edit-button', label); button.type = 'button'; button.dataset.edit = type; button.dataset.id = id; return button; }
function stat(label, value, optional = false) { const box = element('div', `entity-stat${optional ? ' optional-stat' : ''}`); append(box, element('span', '', label), element('strong', '', value)); return box; }
function summaryTile(label, value) { const tile = element('div'); append(tile, element('span', '', String(label)), element('strong', '', String(value))); return tile; }
function lineItemGroup(title, items = []) { const group = element('div'); append(group, element('h3', '', title)); const list = element('div', 'line-item-list'); for (const item of items) { const row = element('div', 'line-item'); append(row, element('span', '', item.name), element('strong', '', formatCurrency(item.amount))); list.append(row); } group.append(list); return group; }
function amountCell(value, className = '') { const output = cell(value === null || value === undefined || value === 0 ? '—' : formatCurrency(value)); output.className = `amount ${className}`.trim(); return output; }
function cell(text = '', className = '') { const output = element('td', className, String(text)); return output; }
function element(tag, className = '', text = '') { const output = document.createElement(tag); if (className) output.className = className; if (text !== '') output.textContent = text; return output; }
function append(parent, ...children) { parent.append(...children); return parent; }
function clear(node) { while (node.firstChild) node.firstChild.remove(); }
function bindSingleClickAction(id, busyLabel, action, afterAction) {
  byId(id).addEventListener('click', (event) => runSingleClickAction(event, busyLabel, action, afterAction));
}
async function runSingleClickAction(event, busyLabel, action, afterAction) {
  event.preventDefault();
  const button = event.currentTarget;
  if (button.disabled || button.getAttribute('aria-busy') === 'true') return;
  const previousLabel = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyLabel;
  try {
    await action(event);
  } catch (error) {
    showToast(error?.message || 'That action could not be completed. Nothing was saved.');
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.textContent === busyLabel) button.textContent = previousLabel;
    afterAction?.();
  }
}
function monthLabel(month) { if (!/^\d{4}-\d{2}$/.test(month || '')) return month || 'Unknown'; return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00`)); }
function titleCase(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
function statusLabel(value) { return value ? `Status: ${titleCase(value)}` : 'No notes yet'; }
function arrangementLabel(item) { return item.arrangementStatus === 'confirmed' ? 'Confirmed' : item.arrangementStatus === 'none' ? 'None confirmed' : 'Unknown'; }
function requiredPaymentLabel(item) { const value = item.arrangementStatus === 'confirmed' ? item.arrangementPayment : item.contractualPayment; return value == null ? 'Unknown' : formatCurrency(value); }
function paymentStatusLabel(item) { return `${requiredPaymentLabel(item)} · ${arrangementLabel(item)}`; }
function limitAprLabel(item) { return `${item.limit == null ? 'Unknown' : formatCurrency(item.limit)} · ${item.apr == null ? 'APR unknown' : `${(item.apr * 100).toFixed(2)}%`}`; }
function initialiseNotificationLayer() {
  const observer = new MutationObserver((mutations) => {
    if (mutations.some(({ target }) => target instanceof HTMLDialogElement && target.open)) {
      queueMicrotask(() => syncNotificationLayer(true));
    }
  });
  observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['open'] });
}
function syncNotificationLayer(promote = false) {
  const layer = byId('notificationLayer');
  const shouldShow = !byId('toast').hidden || !byId('updateNotificationRegion').hidden;
  if (!layer.showPopover) {
    layer.hidden = !shouldShow;
    return;
  }
  const isOpen = layer.matches(':popover-open');
  if (!shouldShow) {
    if (isOpen) layer.hidePopover();
    return;
  }
  if (isOpen && promote) layer.hidePopover();
  if (!layer.matches(':popover-open')) layer.showPopover();
}
function showToast(message) {
  const toast = byId('toast');
  toast.textContent = message;
  toast.hidden = false;
  syncNotificationLayer(true);
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.hidden = true;
    syncNotificationLayer();
  }, 4200);
}
