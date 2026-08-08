import {
  buildFallbackAnswer, buildFinancialChecks, buildNextAction, calculateBudgetRows,
  calculatePeriodSummary, calculateStreak, createId, debtPlan, exportTransactionsCsv,
  findDuplicateCandidates, findSavingsOpportunities, formatCurrency, formatDate
} from './finance-core.js';

let state;
let encryption;
let pendingAction;
let importQueue = [];
let currentImport = null;
let editorContext = null;
let diagnosticPreviewToken = null;

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
  try {
    const loaded = await window.financeAPI.loadState();
    state = loaded.state;
    encryption = loaded.encryption;
    byId('appShell').hidden = false;
    bindEvents();
    populateMonthOptions();
    populateAccountOptions();
    render();
    checkModel();
  } catch (error) {
    byId('desktopRequired').hidden = false;
    byId('desktopRequired').querySelector('p').textContent = `The secure data store could not be opened: ${error.message}`;
  }
}

function bindEvents() {
  document.querySelectorAll('.nav-button').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
  byId('monthSelect').addEventListener('change', async () => { state.settings.selectedMonth = byId('monthSelect').value; await saveAndRender(); });
  byId('completeActionButton').addEventListener('click', completeNextAction);
  byId('snoozeActionButton').addEventListener('click', snoozeNextAction);
  byId('quickCheckInButton').addEventListener('click', logCheckIn);
  byId('importStatementButton').addEventListener('click', () => importDocuments('statement'));
  byId('importPayslipButton').addEventListener('click', () => importDocuments('payslip'));
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

function selectView(name) {
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
  document.querySelectorAll('.view').forEach((view) => { const active = view.id === `view-${name}`; view.classList.toggle('active', active); view.hidden = !active; });
  byId('viewEyebrow').textContent = viewMeta[name][0];
  byId('viewTitle').textContent = viewMeta[name][1];
  if (name === 'guide') checkModel();
}

function render() {
  const month = state.settings.selectedMonth;
  const summary = calculatePeriodSummary(state, month);
  pendingAction = buildNextAction(state);
  byId('nextActionTitle').textContent = pendingAction.title;
  byId('nextActionDetail').textContent = pendingAction.detail || '';
  byId('nextActionTime').textContent = pendingAction.timeframe || '10 min';
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
  byId('bufferProgress').style.width = `${percent}%`;
  byId('momentumTitle').textContent = current ? `${percent}% of your starter buffer` : 'Showing up counts';
  byId('momentumText').textContent = current ? `${formatCurrency(current)} saved toward ${formatCurrency(target)}. Keep the target small while payments are being stabilised.` : 'Your first win is a completed check-in. The buffer can grow after essential payments are secure.';
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
  append(planCard, element('h3', '', plan.safeToOverpay ? 'Hybrid payoff forecast' : 'Forecast paused for safety'), element('p', '', plan.safeToOverpay ? `${formatCurrency(plan.monthlyPot)} a month gives a provisional debt-free month of ${monthLabel(plan.debtFreeMonth)}. ${plan.unknownApr.length} unknown APRs could change this.` : `Confirm arrangements for ${plan.blockers.join(' and ')} before treating the ${formatCurrency(state.settings.extraDebtPayment)} target as safe.`));
  container.append(planCard);
  for (const item of state.debts) container.append(entityCard('debt', item, [stat('Balance', formatCurrency(item.currentBalance)), stat('APR', item.apr == null ? 'Unknown' : `${(item.apr * 100).toFixed(2)}%`), stat('Payment', item.contractualPayment ? formatCurrency(item.contractualPayment) : 'Unknown', true)]));
}

function renderOverdrafts() {
  const total = state.overdrafts.reduce((sum, item) => sum + Number(item.currentBalance || 0), 0);
  byId('overdraftTotalValue').textContent = formatCurrency(total);
  byId('overLimitCount').textContent = state.overdrafts.filter((item) => item.status === 'over_limit').length;
  byId('overdraftPlansValue').textContent = `${state.overdrafts.filter((item) => item.arrangementConfirmed).length} / ${state.overdrafts.length}`;
  const container = byId('overdraftCards'); clear(container);
  if (!state.overdrafts.length) {
    const empty = element('article', 'panel');
    append(empty, element('h2', '', 'No overdrafts added'), element('p', 'muted', 'Add only the amount currently used, the arranged limit and the confirmed rate.'));
    container.append(empty);
    return;
  }
  for (const item of state.overdrafts) container.append(entityCard('overdraft', item, [stat('Used', formatCurrency(item.currentBalance)), stat('Limit', item.limit ? formatCurrency(item.limit) : 'Unknown'), stat('APR', item.apr == null ? 'Unknown' : `${(item.apr * 100).toFixed(2)}%`, true)]));
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
    const empty = element('article', 'panel'); append(empty, element('h2', '', 'No secure documents yet'), element('p', 'muted', 'Import a bank statement or payslip. The encrypted original will appear here automatically.')); container.append(empty); return;
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
  if (preview.kind === 'payslip') {
    append(summary, summaryTile('Period', monthLabel(preview.summary.period)), summaryTile('Gross', formatCurrency(preview.summary.gross)), summaryTile('Deductions', formatCurrency(preview.summary.deductions)), summaryTile('Net', formatCurrency(preview.summary.net)));
  } else {
    append(summary, summaryTile('Records', preview.records.length), summaryTile('Money in', formatCurrency(preview.summary.incoming)), summaryTile('Money out', formatCurrency(preview.summary.outgoing)), summaryTile('Reconciled', preview.reconciled ? 'Yes' : 'Needs review'));
  }
  const warning = byId('importWarnings');
  const messages = [...preview.warnings, ...preview.rejected.map((item) => `Row ${item.row || '—'}: ${item.reason}`)];
  warning.hidden = !messages.length; warning.textContent = messages.join('\n');
  renderImportPreview(preview);
  byId('confirmImportButton').disabled = !preview.records.length;
  byId('importDialog').showModal();
}

function renderImportPreview(preview) {
  const head = byId('importPreviewHead'); const body = byId('importPreviewRows'); clear(head); clear(body);
  const headerRow = document.createElement('tr');
  const headers = preview.kind === 'payslip' ? ['Period', 'Gross', 'Deductions', 'Net'] : ['Date', 'Description', 'Incoming', 'Outgoing', 'Balance'];
  headers.forEach((label) => headerRow.append(element('th', '', label))); head.append(headerRow);
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
  if (preview.kind === 'payslip') {
    for (const record of preview.records) if (!state.payslips.some((item) => item.id === record.id)) state.payslips.push(record);
  } else {
    const duplicates = findDuplicateCandidates(state.transactions, preview.records);
    const exactIds = new Set(duplicates.exact.map((item) => item.incoming.id));
    const possibleIds = new Set(duplicates.possible.map((item) => item.incoming.id));
    state.transactions.push(...preview.records.filter((item) => !exactIds.has(item.id)).map((item) => ({ ...item, duplicateStatus: possibleIds.has(item.id) ? 'possible' : 'none' })));
    const account = state.accounts.find((item) => item.id === preview.accountHint);
    if (account && preview.reconciled && Number.isFinite(preview.summary.closingBalance)) {
      account.currentBalance = preview.summary.closingBalance;
      account.statementDate = preview.records.map((item) => item.date).filter(Boolean).sort().at(-1) || account.statementDate;
    }
    if (exactIds.size) showToast(`${exactIds.size} exact duplicate${exactIds.size === 1 ? '' : 's'} skipped.`);
  }
  state.importBatches.push({ id: createId('import'), documentId: currentImport.document.id, kind: preview.kind, importedAt: new Date().toISOString(), recordCount: preview.records.length, reconciled: preview.reconciled });
  await saveState();
  byId('importDialog').close('confirmed');
  currentImport = null;
  render();
  showToast('Reviewed records imported.');
  showNextImport();
}

async function completeNextAction() {
  const task = state.tasks.find((item) => item.id === pendingAction.id);
  if (task) task.completedAt = new Date().toISOString();
  state.checkIns.push({ id: createId('checkin'), date: new Date().toISOString(), note: pendingAction.title });
  await saveAndRender();
  showToast('Done. You can close the app now.');
}

async function snoozeNextAction() {
  const task = state.tasks.find((item) => item.id === pendingAction.id);
  if (task) { const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); task.snoozedUntil = tomorrow.toISOString().slice(0, 10); }
  await saveAndRender();
  showToast('Snoozed for one day.');
}

async function logCheckIn() {
  state.checkIns.push({ id: createId('checkin'), date: new Date().toISOString(), note: 'Five-minute check-in' });
  await saveAndRender();
  showToast('Check-in logged. That is enough for today.');
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
  const base = [['name','Name','text'], ['type','Type','text'], ['currentBalance','Current balance','number'], ['aprPercent','APR (%) - leave blank if unknown','number'], ['contractualPayment','Contractual payment','number'], ['status','Status','select',[['current','Current'],['arrears','Arrears'],['defaulted','Defaulted'],['over_limit','Over limit']]], ['includeInPlan','Include in payoff plan','checkbox'], ['arrangementConfirmed','Payment arrangement confirmed','checkbox'], ['interestFrozen','Interest or charges frozen','checkbox'], ['description','Description','textarea','','wide-field'], ['notes','Notes','textarea','','wide-field']];
  if (type === 'overdraft') {
    base.splice(1, 0, ['accountId', 'Linked account', 'select', [['','Not linked'], ...state.accounts.map((account) => [account.id, account.name])]]);
    base.splice(4, 0, ['limit','Overdraft limit','number']);
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
  if (type === 'debt' || type === 'overdraft') { item.updatedAt = new Date().toISOString(); item.planPriority ??= 999; }
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
  if (remove && window.confirm('Permanently delete this encrypted document? Its imported payment records will remain.')) {
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
  try { const result = await window.financeAPI.createBackup(passphrase); byId('backupStatus').textContent = result.canceled ? 'Backup cancelled.' : `${result.fileName} created.`; }
  catch (error) { byId('backupStatus').textContent = error.message; }
}

async function restoreBackup() {
  const passphrase = byId('backupPassphrase').value;
  if (!window.confirm('Restore a backup? Current data will be saved automatically first.')) return;
  try { const result = await window.financeAPI.restoreBackup(passphrase); if (!result.canceled) { state = result.state; populateMonthOptions(); populateAccountOptions(); render(); byId('backupStatus').textContent = 'Backup restored.'; } }
  catch (error) { byId('backupStatus').textContent = error.message; }
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
async function saveState() { state = await window.financeAPI.saveState(state); }

function populateMonthOptions() {
  const months = [...new Set([...state.transactions.map((item) => String(item.budgetMonth || item.date).slice(0, 7)), ...state.payslips.map((item) => item.period), state.settings.selectedMonth].filter(Boolean))].sort().reverse();
  const select = byId('monthSelect'); clear(select);
  for (const month of months) { const option = document.createElement('option'); option.value = month; option.textContent = monthLabel(month); select.append(option); }
  select.value = state.settings.selectedMonth;
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
function titleCase(value) { return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
function statusLabel(value) { return value ? `Status: ${titleCase(value)}` : 'No notes yet'; }
function showToast(message) { const toast = byId('toast'); toast.textContent = message; toast.hidden = false; window.clearTimeout(showToast.timer); showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 4200); }
