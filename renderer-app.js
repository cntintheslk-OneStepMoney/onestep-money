import {
  availableReportingMonths, buildFallbackAnswer, buildFinancialChecks, buildNextAction, calculateBudgetRows,
  calculatePeriodSummary, calculateStreak, createId, debtPlan, exportTransactionsCsv,
  creditReportDebtStatus, creditReportStatusConflict, findDuplicateCandidates, findSavingsOpportunities, formatCurrency, formatDate,
  hasCompletedCheckIn, planCreditReportAccounts, syncStatementAccount
} from './finance-core.js';

let state;
let encryption;
let pendingAction;
let importQueue = [];
let currentImport = null;
let editorContext = null;
let diagnosticPreviewToken = null;
let recoveryResult = null;
let freshStartToken = null;
let restoreToken = null;
let restoreInProgress = false;
let restoreCanCancel = true;
let normalEventsBound = false;
let recoveryEventsBound = false;
let restoreEventsBound = false;

const viewMeta = {
  today: ['ONE CLEAR MOVE', 'Today'], transactions: ['MONEY IN AND OUT', 'Payments'], pay: ['WHERE GROSS PAY GOES', 'Pay'],
  debts: ['LOANS, CARDS AND FINANCE', 'Debts'], overdrafts: ['BANK BORROWING', 'Overdrafts'], budget: ['DEPENDABLE INCOME FIRST', 'Budget'],
  guide: ['PRIVATE AND LOCAL', 'Guide'], documents: ['ENCRYPTED ON THIS DEVICE', 'Documents'], settings: ['CONTROL AND PRIVACY', 'Settings']
};

const byId = (id) => document.getElementById(id);

window.addEventListener('error', () => window.financeAPI?.recordRendererFault('RENDERER_UNHANDLED_ERROR').catch(() => {}));
window.addEventListener('unhandledrejection', () => window.financeAPI?.recordRendererFault('RENDERER_UNHANDLED_REJECTION').catch(() => {}));

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
  const version = String(value || '').trim().replace(/^v/i, '');
  byId('appVersion').textContent = version ? `v${version}` : 'Version unavailable';
}

function activateNormalMode(loaded) {
  state = loaded.state;
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
  byId('monthSelect').addEventListener('change', async () => { state.settings.selectedMonth = byId('monthSelect').value; await saveAndRender(); });
  byId('completeActionButton').addEventListener('click', completeNextAction);
  byId('snoozeActionButton').addEventListener('click', snoozeNextAction);
  byId('quickCheckInButton').addEventListener('click', logCheckIn);
  byId('importStatementButton').addEventListener('click', () => importDocuments('statement'));
  byId('importPayslipButton').addEventListener('click', () => importDocuments('payslip'));
  byId('importCreditReportButton').addEventListener('click', () => importDocuments('credit-report'));
  byId('exportCsvButton').addEventListener('click', async () => {
    const saved = await window.financeAPI.exportCsv(exportTransactionsCsv(state.transactions));
    if (saved) showToast('Payments exported safely.');
  });
  [byId('transactionSearch'), byId('transactionAccountFilter'), byId('transactionTypeFilter')].forEach((element) => element.addEventListener('input', renderTransactions));
  document.querySelectorAll('[data-add]').forEach((button) => button.addEventListener('click', () => openEditor(button.dataset.add)));
  byId('transactionRows').addEventListener('click', handleEditClick);
  byId('debtCards').addEventListener('click', handleEditClick);
  byId('overdraftCards').addEventListener('click', handleEditClick);
  byId('budgetRows').addEventListener('click', handleEditClick);
  byId('payslipList').addEventListener('click', handleEditClick);
  byId('documentCards').addEventListener('click', handleDocumentClick);
  byId('accountCards').addEventListener('click', handleEditClick);
  byId('saveEditButton').addEventListener('click', saveEditor);
  byId('confirmImportButton').addEventListener('click', confirmCurrentImport);
  byId('importDialog').addEventListener('close', () => { if (currentImport) { currentImport = null; showNextImport(); } });
  byId('guideForm').addEventListener('submit', askGuide);
  document.querySelectorAll('[data-prompt]').forEach((button) => button.addEventListener('click', () => { byId('guideQuestion').value = button.dataset.prompt; byId('guideQuestion').focus(); }));
  byId('checkModelButton').addEventListener('click', checkModel);
  byId('saveSettingsButton').addEventListener('click', saveSettings);
  byId('createBackupButton').addEventListener('click', createBackup);
  byId('restoreBackupButton').addEventListener('click', restoreBackup);
  byId('checkUpdateButton').addEventListener('click', checkForUpdates);
  byId('installUpdateButton').addEventListener('click', installUpdate);
  byId('reviewDiagnosticsButton').addEventListener('click', reviewDiagnostics);
  byId('exportDiagnosticsButton').addEventListener('click', exportDiagnostics);
  byId('deleteDiagnosticsButton').addEventListener('click', deleteDiagnostics);
  window.financeAPI.onUpdateStatus(handleUpdateStatus);
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
  populateMonthOptions();
  const month = state.settings.selectedMonth;
  const summary = calculatePeriodSummary(state, month);
  pendingAction = buildNextAction(state);
  byId('nextActionTitle').textContent = pendingAction.title;
  byId('nextActionDetail').textContent = pendingAction.detail || '';
  byId('nextActionTime').textContent = pendingAction.timeframe || '10 min';
  byId('completeActionButton').hidden = Boolean(pendingAction.passive);
  byId('snoozeActionButton').hidden = Boolean(pendingAction.passive);
  renderDailyCompletion();
  byId('marginValue').textContent = formatCurrency(summary.plannedMargin);
  byId('cashFlowValue').textContent = formatCurrency(summary.netCashFlow);
  byId('todayDebtValue').textContent = formatCurrency(summary.debts);
  byId('todayOverdraftValue').textContent = formatCurrency(summary.overdrafts);
  byId('grossPayValue').textContent = formatCurrency(summary.grossPay);
  byId('deductionsValue').textContent = formatCurrency(summary.payrollDeductions);
  byId('netPayValue').textContent = formatCurrency(summary.netPay);
  byId('streakValue').textContent = calculateStreak(state.checkIns);
  renderChecks();
  renderMomentum();
  renderTransactions();
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
  byId('checkInStatus').textContent = completedToday
    ? 'Recorded for today. There is nothing else you need to tick off.'
    : 'Use this when you reviewed your money but did not finish the action above.';
}

function renderDailyCompletion() {
  const completedToday = hasCompletedCheckIn(state.checkIns);
  document.querySelector('.focus-panel').hidden = completedToday;
  document.querySelector('.permission-slip').hidden = completedToday;
  byId('dailyCompleteState').hidden = !completedToday;
}

function renderTransactions() {
  const search = byId('transactionSearch').value.trim().toLowerCase();
  const account = byId('transactionAccountFilter').value;
  const type = byId('transactionTypeFilter').value;
  const accountNames = new Map(state.accounts.map((item) => [item.id, item.name]));
  const rows = state.transactions
    .filter((item) => String(item.budgetMonth || item.date).startsWith(state.settings.selectedMonth))
    .filter((item) => account === 'all' || item.accountId === account)
    .filter((item) => type === 'all' || (type === 'incoming' && item.incoming > 0) || (type === 'outgoing' && item.outgoing > 0) || (type === 'transfer' && item.transferStatus !== 'no'))
    .filter((item) => !search || [item.description, item.userDescription, item.category, item.notes].join(' ').toLowerCase().includes(search))
    .sort((left, right) => left.date.localeCompare(right.date) || Number(left.sourceRow || 0) - Number(right.sourceRow || 0));
  const body = byId('transactionRows');
  clear(body);
  for (const item of rows.slice(0, 300)) {
    const row = document.createElement('tr');
    row.append(cell(formatDate(item.date)));
    row.append(cell(accountNames.get(item.accountId) || item.accountId || 'Unassigned'));
    const description = cell();
    description.className = 'description-cell';
    append(description, element('strong', '', item.userDescription || item.description));
    if (item.userDescription) description.append(element('span', '', item.description));
    const badges = document.createElement('span');
    badges.className = 'note-preview';
    badges.textContent = item.category;
    if (item.transferStatus !== 'no') badges.textContent += ` · ${item.transferStatus} transfer`;
    description.append(badges);
    row.append(description);
    row.append(amountCell(item.incoming, 'incoming'));
    row.append(amountCell(item.outgoing, 'outgoing'));
    row.append(amountCell(item.runningBalance, ''));
    row.append(cell(item.notes || '—', 'note-preview'));
    row.append(actionCell('transaction', item.id));
    body.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr'); const empty = cell('No payments match these filters.'); empty.colSpan = 8; row.append(empty); body.append(row);
  }
  byId('transactionCount').textContent = rows.length > 300 ? `Showing 300 of ${rows.length} payments. Narrow the search to see a specific item.` : `${rows.length} payment${rows.length === 1 ? '' : 's'} shown.`;
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
    append(summary, title, stat('Gross', formatCurrency(payslip.grossPay)), stat('Deductions', formatCurrency(payslip.totalDeductions)), stat('Net', formatCurrency(payslip.netPay)), actionButton('payslip', payslip.id, 'Notes'));
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
  for (const item of state.debts) container.append(entityCard('debt', item, [stat('Balance', formatCurrency(item.currentBalance)), stat('APR', item.apr == null ? 'Unknown' : `${(item.apr * 100).toFixed(2)}%`), stat('Required / arrangement', paymentStatusLabel(item), true)]));
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
  for (const item of state.overdrafts) container.append(entityCard('overdraft', item, [stat('Used', formatCurrency(item.currentBalance)), stat('Limit / APR', limitAprLabel(item)), stat('Required / arrangement', paymentStatusLabel(item), true)]));
}

function renderBudget() {
  const summary = calculatePeriodSummary(state);
  byId('budgetIncomeValue').textContent = formatCurrency(summary.dependableIncome);
  byId('plannedSpendingValue').textContent = formatCurrency(summary.plannedSpending);
  byId('budgetMarginValue').textContent = formatCurrency(summary.plannedMargin);
  const list = byId('budgetRows'); clear(list);
  if (!state.budgets.length) {
    const empty = element('div', 'empty-inline', 'No budget items yet. Add essentials first, then minimum debt payments.');
    list.append(empty);
  }
  for (const item of calculateBudgetRows(state)) {
    const row = element('div', 'budget-item');
    const line = element('div', 'budget-line');
    const button = element('button', '', item.category); button.type = 'button'; button.dataset.edit = 'budget'; button.dataset.id = item.id;
    append(line, button, element('span', '', `${formatCurrency(item.actual)} / ${formatCurrency(item.planned)}`));
    const track = element('div', 'budget-bar'); const bar = document.createElement('span'); bar.style.width = `${Math.min(100, item.planned ? (item.actual / item.planned) * 100 : item.actual ? 100 : 0)}%`; track.append(bar);
    append(row, line, track); list.append(row);
  }
  const ideas = byId('savingsIdeas'); clear(ideas);
  for (const item of findSavingsOpportunities(state).slice(0, 4)) {
    const card = element('article', 'check-card neutral'); append(card, element('h3', '', item.category), element('p', '', item.text)); ideas.append(card);
  }
}

function renderDocuments() {
  const container = byId('documentCards'); clear(container);
  const documents = [...state.documents].sort((left, right) => right.importedAt.localeCompare(left.importedAt));
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
  for (const account of state.accounts) {
    container.append(entityCard('account', account, [
      stat('Type', titleCase(account.type || 'current')),
      stat('Balance', account.currentBalance == null ? 'Unknown' : formatCurrency(account.currentBalance)),
      stat('Status', account.active === false ? 'Archived' : 'Active', true)
    ]));
  }
}

function renderSettings() {
  byId('dependableIncomeInput').value = state.profile.dependableIncome;
  byId('extraPaymentInput').value = state.settings.extraDebtPayment;
  byId('bufferTargetInput').value = state.settings.emergencyBufferTarget;
  byId('bufferBalanceInput').value = state.settings.emergencyBufferBalance;
  byId('llmModelInput').value = state.settings.llmModel;
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
  const preview = currentImport.preview;
  byId('importTitle').textContent = currentImport.document.originalName;
  const summary = byId('importSummary'); clear(summary);
  if (preview.kind === 'credit-report') {
    const report = preview.records[0];
    currentImport.creditPlan = report ? creditReportAdditionPlan(report) : [];
    const newBalances = currentImport.creditPlan.filter((item) => item.action === 'add-debt' || item.action === 'add-overdraft').length;
    const updates = currentImport.creditPlan.filter((item) => item.action === 'existing').length;
    const score = preview.summary.score == null ? 'Not detected' : `${preview.summary.score}${preview.summary.scoreMaximum ? ` / ${preview.summary.scoreMaximum}` : ''}`;
    append(summary, summaryTile('Provider', preview.summary.provider || 'Unknown'), summaryTile('Report date', preview.summary.reportDate ? formatDate(preview.summary.reportDate) : 'Not detected'), summaryTile('Score', score), summaryTile('Debt sync', `${newBalances} new · ${updates} update${updates === 1 ? '' : 's'}`));
  } else if (preview.kind === 'payslip') {
    append(summary, summaryTile('Period', monthLabel(preview.summary.period)), summaryTile('Gross', formatCurrency(preview.summary.gross)), summaryTile('Deductions', formatCurrency(preview.summary.deductions)), summaryTile('Net', formatCurrency(preview.summary.net)));
  } else {
    append(summary, summaryTile('Records', preview.records.length), summaryTile('Money in', formatCurrency(preview.summary.incoming)), summaryTile('Money out', formatCurrency(preview.summary.outgoing)), summaryTile('Reconciled', preview.reconciled ? 'Yes' : 'Needs review'));
  }
  const warning = byId('importWarnings');
  const messages = [...preview.warnings, ...preview.rejected.map((item) => `Row ${item.row || '—'}: ${item.reason}`)];
  warning.hidden = !messages.length; warning.textContent = messages.join('\n');
  renderImportPreview(preview);
  byId('confirmImportButton').disabled = !preview.records.length;
  byId('confirmImportButton').textContent = preview.kind === 'credit-report' ? 'Save report and sync debts' : 'Import reviewed records';
  byId('importDialog').showModal();
}

function renderImportPreview(preview) {
  const head = byId('importPreviewHead'); const body = byId('importPreviewRows'); clear(head); clear(body);
  const headerRow = document.createElement('tr');
  const headers = preview.kind === 'credit-report'
    ? ['Lender', 'Type', 'Balance', 'Limit', 'Action']
    : preview.kind === 'payslip' ? ['Period', 'Gross', 'Deductions', 'Net'] : ['Date', 'Description', 'Incoming', 'Outgoing', 'Balance'];
  headers.forEach((label) => headerRow.append(element('th', '', label))); head.append(headerRow);
  if (preview.kind === 'credit-report') {
    const plan = currentImport?.creditPlan || [];
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
    else append(row, cell(formatDate(record.date)), cell(record.description), amountCell(record.incoming, 'incoming'), amountCell(record.outgoing, 'outgoing'), amountCell(record.runningBalance));
    body.append(row);
  }
}

async function confirmCurrentImport(event) {
  event.preventDefault();
  if (!currentImport) return;
  const preview = currentImport.preview;
  let completionMessage = 'Reviewed records imported.';
  if (preview.kind === 'credit-report') {
    const report = preview.records[0];
    state.creditReports ||= [];
    if (report && !state.creditReports.some((item) => item.id === report.id || item.sourceDocumentId === report.sourceDocumentId)) state.creditReports.push(report);
    const added = applyCreditReportPlan(report, currentImport.creditPlan || []);
    completionMessage = `Credit report saved. ${added.debts} debt${added.debts === 1 ? '' : 's'} and ${added.overdrafts} overdraft${added.overdrafts === 1 ? '' : 's'} added; ${added.updated} tracked balance${added.updated === 1 ? '' : 's'} updated.`;
  } else if (preview.kind === 'payslip') {
    for (const record of preview.records) if (!state.payslips.some((item) => item.id === record.id)) state.payslips.push(record);
  } else {
    const duplicates = findDuplicateCandidates(state.transactions, preview.records);
    const exactIds = new Set(duplicates.exact.map((item) => item.incoming.id));
    const possibleIds = new Set(duplicates.possible.map((item) => item.incoming.id));
    state.transactions.push(...preview.records.filter((item) => !exactIds.has(item.id)).map((item) => ({ ...item, duplicateStatus: possibleIds.has(item.id) ? 'possible' : 'none' })));
    const account = state.accounts.find((item) => item.id === preview.accountHint);
    if (account) {
      const overdraftSync = syncStatementAccount(state, account, preview, currentImport.document.id);
      completionMessage = overdraftSync === 'overdraft-created'
        ? 'Statement imported. Account balance updated and its overdraft added.'
        : overdraftSync === 'overdraft-updated' ? 'Statement imported. Account and overdraft balances updated.'
          : overdraftSync === 'account-updated' ? 'Statement imported and account balance updated.' : completionMessage;
    }
    if (exactIds.size) showToast(`${exactIds.size} exact duplicate${exactIds.size === 1 ? '' : 's'} skipped.`);
  }
  const recordCount = preview.kind === 'credit-report' ? (preview.records[0]?.accounts || []).length : preview.records.length;
  state.importBatches.push({ id: createId('import'), documentId: currentImport.document.id, kind: preview.kind, importedAt: new Date().toISOString(), recordCount, reconciled: preview.reconciled });
  await saveState();
  byId('importDialog').close('confirmed');
  currentImport = null;
  render();
  showToast(completionMessage);
  showNextImport();
}

function creditReportAdditionPlan(report) {
  return planCreditReportAccounts(state.debts, state.overdrafts, report?.accounts || []);
}

function applyCreditReportPlan(report, plan) {
  const added = { debts: 0, overdrafts: 0, updated: 0 };
  for (const item of plan) {
    const account = item.account;
    if (item.action === 'existing') {
      const collection = item.kind === 'overdraft' ? state.overdrafts : state.debts;
      const existing = collection.find((entry) => entry.id === item.existingId);
      if (existing) {
        applyReportedAccountFields(existing, account, report);
        added.updated += 1;
      }
      continue;
    }
    if (!['add-debt', 'add-overdraft'].includes(item.action)) continue;
    const common = {
      name: account.lender || 'Reported account',
      currentBalance: Number(account.currentBalance || 0),
      apr: account.apr ?? null,
      contractualPayment: account.contractualPayment ?? null,
      creditLimit: account.creditLimit ?? null,
      originalBalance: account.originalBalance ?? null,
      openedDate: account.openedDate || '',
      defaultDate: account.defaultDate || '',
      lastReportedAt: account.updatedDate || report.reportDate || '',
      reportedStatus: account.status || '',
      status: creditReportDebtStatus(account.status),
      includeInPlan: true,
      arrangementConfirmed: false,
      arrangementStatus: 'unknown',
      arrangementPayment: null,
      arrearsAmount: null,
      statusConflict: creditReportStatusConflict(account.status),
      interestFrozen: false,
      planPriority: 999,
      accountReference: account.accountReference || '',
      sourceCreditReportId: report.id,
      sourceCreditAccountId: account.id,
      description: `Imported from ${report.provider} credit report${report.reportDate ? ` dated ${formatDate(report.reportDate)}` : ''}.`,
      notes: 'Confirm the APR, minimum payment and current balance against the lender before planning overpayments.',
      updatedAt: new Date().toISOString()
    };
    if (item.action === 'add-overdraft') {
      state.overdrafts.push({ id: createId('overdraft'), ...common, type: 'overdraft', accountId: '', limit: account.creditLimit ?? null });
      added.overdrafts += 1;
    } else {
      state.debts.push({ id: createId('debt'), ...common, type: account.accountType || 'Credit report account' });
      added.debts += 1;
    }
  }
  return added;
}

function applyReportedAccountFields(existing, account, report) {
  if (account.currentBalance !== null && account.currentBalance !== undefined && Number.isFinite(Number(account.currentBalance))) existing.currentBalance = Number(account.currentBalance);
  if (account.apr !== null && account.apr !== undefined) existing.apr = account.apr;
  if (account.contractualPayment !== null && account.contractualPayment !== undefined) existing.contractualPayment = account.contractualPayment;
  if (account.creditLimit !== null && account.creditLimit !== undefined) {
    existing.creditLimit = account.creditLimit;
    if ('limit' in existing) existing.limit = account.creditLimit;
  }
  if (account.originalBalance !== null && account.originalBalance !== undefined) existing.originalBalance = account.originalBalance;
  if (account.openedDate) existing.openedDate = account.openedDate;
  if (account.defaultDate) existing.defaultDate = account.defaultDate;
  if (account.accountReference) existing.accountReference = account.accountReference;
  if (account.status) {
    existing.reportedStatus = account.status;
    const reportedStatus = creditReportDebtStatus(account.status);
    const previousStatus = existing.status || 'unknown';
    existing.statusConflict = Boolean(existing.statusConflict) || creditReportStatusConflict(account.status) || (reportedStatus !== 'unknown' && previousStatus !== 'unknown' && previousStatus !== reportedStatus);
    if (previousStatus === 'unknown' && reportedStatus !== 'unknown') existing.status = reportedStatus;
  }
  existing.lastReportedAt = account.updatedDate || report.reportDate || existing.lastReportedAt || '';
  existing.sourceCreditReportId = report.id;
  existing.sourceCreditAccountId = account.id;
  existing.updatedAt = new Date().toISOString();
}

function creditPlanLabel(item) {
  if (item.action === 'add-debt') return 'Add as new debt';
  if (item.action === 'add-overdraft') return 'Add as overdraft';
  if (item.action === 'existing') return 'Update tracked balance';
  return 'No balance — do not add';
}

async function completeNextAction() {
  if (hasCompletedCheckIn(state.checkIns)) return;
  const blocker = actionCompletionBlocker(pendingAction);
  if (blocker) {
    byId('nextActionDetail').textContent = blocker;
    const panel = document.querySelector('.focus-panel');
    panel.classList.remove('is-blocked');
    void panel.offsetWidth;
    panel.classList.add('is-blocked');
    window.setTimeout(() => panel.classList.remove('is-blocked'), 460);
    showToast('This action is still open. Complete it, or use the five-minute check-in below.');
    return;
  }
  const task = state.tasks.find((item) => item.id === pendingAction.id);
  if (task) task.completedAt = new Date().toISOString();
  state.checkIns.push({ id: createId('checkin'), date: new Date().toISOString(), completed: true, kind: 'action', actionId: pendingAction.id, note: pendingAction.title });
  await saveState();
  await animateFocusPanel('is-completing', 360);
  render();
  showToast('Today is complete. You can close the app now.');
}

function actionCompletionBlocker(action) {
  if (action.id === 'generated-first-account' && !state.accounts.length) return 'This step is still open: add an account in Settings first. If you only reviewed your money today, use the five-minute check-in below instead.';
  if (action.id === 'generated-first-import' && !state.transactions.length) return 'This step is still open: import and confirm at least one payment first. If you only reviewed your money today, use the five-minute check-in below instead.';
  return '';
}

async function snoozeNextAction() {
  const task = state.tasks.find((item) => item.id === pendingAction.id);
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const snoozedUntil = localDateKey(tomorrow);
  if (task) task.snoozedUntil = snoozedUntil;
  else {
    state.settings.snoozedActions ||= {};
    state.settings.snoozedActions[pendingAction.id] = snoozedUntil;
  }
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
  await new Promise((resolve) => window.setTimeout(resolve, duration));
  panel.classList.remove(className);
}

function handleEditClick(event) {
  const button = event.target.closest('[data-edit]');
  if (button) openEditor(button.dataset.edit, button.dataset.id);
}

function openEditor(type, id = '') {
  editorContext = { type, id };
  const collection = collectionFor(type);
  const item = id ? state[collection].find((entry) => entry.id === id) : null;
  byId('editEyebrow').textContent = item ? 'EDIT' : 'ADD';
  byId('editTitle').textContent = `${item ? 'Edit' : 'Add'} ${type === 'account' ? 'bank account' : type}`;
  const fields = byId('editFields'); clear(fields);
  for (const definition of editorDefinitions(type)) fields.append(buildField(definition, item));
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
    ['accountId', 'Account', 'select', state.accounts.map((account) => [account.id, account.name])], ['date', 'Date', 'date'],
    ['description', 'Statement / payment description', 'text', 'Required', 'wide-field'], ['userDescription', 'Your description', 'text', 'Optional clearer name', 'wide-field'],
    ['incoming', 'Incoming', 'number'], ['outgoing', 'Outgoing', 'number'], ['runningBalance', 'Running balance', 'number'], ['category', 'Category', 'text'],
    ['transferStatus', 'Internal transfer', 'select', [['no','No'],['possible','Possible'],['confirmed','Confirmed']]], ['recurring', 'Recurring payment', 'checkbox'], ['notes', 'Notes', 'textarea', '', 'wide-field']
  ];
  if (type === 'payslip') return [['notes', 'Notes', 'textarea', '', 'wide-field']];
  if (type === 'budget') return [['section','Section','select',[['Essentials','Essentials'],['Debt minimums','Debt minimums'],['Flexible','Flexible'],['Goals','Goals']]], ['category','Category','text'], ['planned','Planned monthly amount','number'], ['notes','Notes','textarea','','wide-field']];
  const base = [['name','Name','text'], ['type','Type','text'], ['accountReference','Account reference / last four digits','text'], ['openedDate','Opened date','date'], ['defaultDate','Default date','date'], ['lastReportedAt','Last reported date','date'], ['currentBalance','Current balance','number'], ['aprPercent','APR (%) - leave blank if unknown','number'], ['contractualPayment','Contractual / minimum payment','number'], ['arrearsAmount','Known arrears amount','number'], ['status','Status','select',[['unknown','Unknown'],['current','Current'],['arrears','Arrears'],['defaulted','Defaulted'],['over_limit','Over limit']]], ['arrangementStatus','Payment arrangement','select',[['unknown','Unknown'],['none','Confirmed none'],['confirmed','Confirmed arrangement']]], ['arrangementPayment','Agreed arrangement payment','number'], ['includeInPlan','Include in payoff plan','checkbox'], ['statusConflict','Status information conflicts / needs checking','checkbox'], ['interestFrozen','Interest or charges frozen','checkbox'], ['description','Description','textarea','','wide-field'], ['notes','Notes','textarea','','wide-field']];
  if (type === 'overdraft') {
    base.splice(1, 0, ['accountId', 'Linked account', 'select', [['','Not linked'], ...state.accounts.map((account) => [account.id, account.name])]]);
    base.splice(8, 0, ['limit','Overdraft limit','number']);
  } else {
    base.splice(7, 0, ['originalBalance','Original balance / amount','number'], ['creditLimit','Credit limit','number']);
  }
  return base;
}

function buildField(definition, item) {
  const [name, labelText, type, options, className] = definition;
  const label = element('label', className || ''); label.append(document.createTextNode(labelText));
  let input;
  if (type === 'select') {
    input = document.createElement('select');
    for (const [value, text] of options) { const option = document.createElement('option'); option.value = value; option.textContent = text; input.append(option); }
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
  if (!item) { item = { id: createId(type) }; state[collection].push(item); }
  for (const definition of editorDefinitions(type)) {
    const [name, , fieldType] = definition; const input = byId('editFields').querySelector(`[name="${name}"]`);
    let value = fieldType === 'checkbox' ? input.checked : input.value.trim();
    if (fieldType === 'number') value = value === '' ? null : Number(value);
    if (name === 'aprPercent') item.apr = value === null ? null : value / 100;
    else item[name] = value;
  }
  if (type === 'transaction') { item.budgetMonth = item.date?.slice(0, 7) || state.settings.selectedMonth; item.source ||= 'manual'; item.cleared ??= true; item.incoming = Number(item.incoming || 0); item.outgoing = Number(item.outgoing || 0); }
  if (type === 'debt' || type === 'overdraft') { item.updatedAt = new Date().toISOString(); item.planPriority ??= 999; item.arrangementConfirmed = item.arrangementStatus === 'confirmed'; }
  if (type === 'account') { item.name ||= 'Unnamed account'; item.active ??= true; }
  await saveState();
  if (type === 'account') populateAccountOptions();
  if (type === 'transaction' || type === 'payslip') populateMonthOptions();
  byId('editDialog').close(); editorContext = null; render(); showToast('Saved.');
}

async function deleteEditedItem(type, id) {
  if (type === 'account' && (state.transactions.some((item) => item.accountId === id) || state.overdrafts.some((item) => item.accountId === id))) {
    window.alert('This account is linked to payments or an overdraft. Mark it as archived instead.');
    return;
  }
  if (!window.confirm(`Delete this ${type}? This can be recovered only from a backup.`)) return;
  const collection = collectionFor(type); state[collection] = state[collection].filter((item) => item.id !== id);
  await saveState();
  if (type === 'account') populateAccountOptions();
  byId('editDialog').close(); editorContext = null; render(); showToast('Deleted.');
}

async function handleDocumentClick(event) {
  const open = event.target.closest('[data-document-open]');
  if (open) { try { await window.financeAPI.openDocument(open.dataset.documentOpen); } catch (error) { showToast(error.message); } return; }
  const remove = event.target.closest('[data-document-delete]');
  if (remove && window.confirm('Permanently delete this encrypted document? Records already imported from it will remain.')) {
    state = await window.financeAPI.deleteDocument(remove.dataset.documentDelete); render(); showToast('Encrypted document deleted.');
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
  catch (error) { handleUpdateStatus({ state: 'error', message: error.message }); }
}

async function installUpdate() {
  byId('installUpdateButton').disabled = true;
  byId('updateStatus').textContent = 'Creating a recovery backup, then restarting…';
  try { await window.financeAPI.installUpdate(); }
  catch (error) { byId('installUpdateButton').disabled = false; handleUpdateStatus({ state: 'error', message: error.message }); }
}

function handleUpdateStatus(status = {}) {
  byId('updateStatus').textContent = status.message || 'Update status unavailable.';
  byId('installUpdateButton').hidden = status.state !== 'ready';
  byId('checkUpdateButton').disabled = ['checking', 'downloading'].includes(status.state);
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

async function saveAndRender() { await saveState(); render(); }
async function saveState() {
  synchroniseSelectedMonth();
  const saved = await window.financeAPI.saveState(state);
  if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while recovery is required.');
  state = saved;
}

function populateMonthOptions() {
  const months = synchroniseSelectedMonth();
  const select = byId('monthSelect'); clear(select);
  for (const month of months) { const option = document.createElement('option'); option.value = month; option.textContent = monthLabel(month); select.append(option); }
  select.value = state.settings.selectedMonth;
}

function synchroniseSelectedMonth() {
  const months = availableReportingMonths(state);
  if (!months.includes(state.settings.selectedMonth)) state.settings.selectedMonth = months[0];
  return months;
}

function populateAccountOptions() {
  for (const id of ['statementAccountSelect', 'transactionAccountFilter']) {
    const select = byId(id); const preserveAll = id === 'transactionAccountFilter'; clear(select);
    if (preserveAll) { const all = document.createElement('option'); all.value = 'all'; all.textContent = 'All accounts'; select.append(all); }
    for (const account of state.accounts.filter((item) => item.active !== false)) { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name; select.append(option); }
  }
}

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
function actionButton(type, id, label = 'Edit') { const button = element('button', 'edit-button', label); button.type = 'button'; button.dataset.edit = type; button.dataset.id = id; return button; }
function stat(label, value, optional = false) { const box = element('div', `entity-stat${optional ? ' optional-stat' : ''}`); append(box, element('span', '', label), element('strong', '', value)); return box; }
function summaryTile(label, value) { const tile = element('div'); append(tile, element('span', '', String(label)), element('strong', '', String(value))); return tile; }
function lineItemGroup(title, items = []) { const group = element('div'); append(group, element('h3', '', title)); const list = element('div', 'line-item-list'); for (const item of items) { const row = element('div', 'line-item'); append(row, element('span', '', item.name), element('strong', '', formatCurrency(item.amount))); list.append(row); } group.append(list); return group; }
function amountCell(value, className = '') { const output = cell(value === null || value === undefined || value === 0 ? '—' : formatCurrency(value)); output.className = `amount ${className}`.trim(); return output; }
function cell(text = '', className = '') { const output = element('td', className, String(text)); return output; }
function element(tag, className = '', text = '') { const output = document.createElement(tag); if (className) output.className = className; if (text !== '') output.textContent = text; return output; }
function append(parent, ...children) { parent.append(...children); return parent; }
function clear(node) { while (node.firstChild) node.firstChild.remove(); }
function monthLabel(month) { if (!/^\d{4}-\d{2}$/.test(month || '')) return month || 'Unknown'; return new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00`)); }
function localDateKey(value) { const date = value instanceof Date ? value : new Date(value); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function titleCase(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
function statusLabel(value) { return value ? `Status: ${titleCase(value)}` : 'No notes yet'; }
function arrangementLabel(item) { return item.arrangementStatus === 'confirmed' ? 'Confirmed' : item.arrangementStatus === 'none' ? 'None confirmed' : 'Unknown'; }
function requiredPaymentLabel(item) { const value = item.arrangementStatus === 'confirmed' ? item.arrangementPayment : item.contractualPayment; return value == null ? 'Unknown' : formatCurrency(value); }
function paymentStatusLabel(item) { return `${requiredPaymentLabel(item)} · ${arrangementLabel(item)}`; }
function limitAprLabel(item) { return `${item.limit == null ? 'Unknown' : formatCurrency(item.limit)} · ${item.apr == null ? 'APR unknown' : `${(item.apr * 100).toFixed(2)}%`}`; }
function showToast(message) { const toast = byId('toast'); toast.textContent = message; toast.hidden = false; window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 4200); }
