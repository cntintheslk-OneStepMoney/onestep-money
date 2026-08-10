import {
  calculateStreak, compareLabels, formatCurrency, formatDate, isTransactionFinanciallyActive,
  periodTransactions
} from '../finance-core.js';
import { reviewItemPresentation } from '../review-lifecycle.js';
import {
  actOnDemoReviewItem, applySimulatedImport, categoriseDemoTransaction, deriveDemoView,
  loadDemoState, resetDemoState, saveDemoState, setDemoTheme, snoozeDemoReviewItem,
  wakeDemoReviewItem
} from './demo-state.js';

const VIEW_META = Object.freeze({
  dashboard: ['FICTIONAL MONEY AT A GLANCE', 'Dashboard'],
  today: ['ONE USEFUL THING', 'Today'],
  review: ['DECISIONS, NOT CLUTTER', 'Review Inbox'],
  payments: ['ONE TRUSTED LEDGER', 'Payments'],
  budget: ['THE SAME MONEY, PLANNED', 'Budget'],
  pay: ['FICTIONAL INCOME', 'Pay'],
  safety: ['CAUTIOUS BY DESIGN', 'Financial Safety'],
  settings: ['LOCAL DEMO CONTROLS', 'Demo settings']
});

let state;
let currentView = 'dashboard';
let toastTimer;
const loaded = loadDemoState();
state = loaded.state;

bindEvents();
applyTheme();
renderAll();
openWelcome();
if (loaded.recovered) showToast('The demo state was malformed, so the fictional baseline was restored safely.');

function bindEvents() {
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.view)));
  document.querySelectorAll('[data-open-view]').forEach((button) => button.addEventListener('click', () => selectView(button.dataset.openView)));
  document.querySelectorAll('[data-reset-demo], #resetDemoButton').forEach((button) => button.addEventListener('click', resetDemo));
  byId('enterDemoButton').addEventListener('click', () => closeDialog(byId('demoWelcome')));
  byId('dismissGuidanceButton').addEventListener('click', () => {
    state.settings.demo.guidanceDismissed = true;
    commit('Guidance dismissed. You can keep exploring at your own pace.');
  });
  byId('quickThemeButton').addEventListener('click', () => {
    setDemoTheme(state, document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    commit(`${state.settings.appearance.theme === 'dark' ? 'Night' : 'Light'} presentation selected.`);
  });
  document.querySelectorAll('input[name="demo-theme"]').forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    setDemoTheme(state, input.value);
    commit(`${input.value === 'dark' ? 'Night' : titleCase(input.value)} presentation selected.`);
  }));
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  media?.addEventListener?.('change', () => {
    if (state.settings.appearance.theme === 'system') applyTheme();
  });
  byId('todayDoButton').addEventListener('click', actOnToday);
  byId('todaySnoozeButton').addEventListener('click', snoozeToday);
  byId('reviewActive').addEventListener('click', handleReviewAction);
  byId('reviewSnoozed').addEventListener('click', handleReviewAction);
  byId('paymentRows').addEventListener('click', handlePaymentAction);
  byId('paymentSearch').addEventListener('input', renderPayments);
  byId('paymentCategoryFilter').addEventListener('change', renderPayments);
  byId('showImportButton').addEventListener('click', () => openDialog(byId('importPreviewDialog')));
  byId('closeImportButton').addEventListener('click', () => closeDialog(byId('importPreviewDialog')));
  byId('cancelImportButton').addEventListener('click', () => closeDialog(byId('importPreviewDialog')));
  byId('applyImportButton').addEventListener('click', () => {
    applySimulatedImport(state);
    closeDialog(byId('importPreviewDialog'));
    commit('Three fictional preview rows were applied. Payments and Budget now use the updated demo state.');
  });
}

function renderAll() {
  const view = deriveDemoView(state);
  applyTheme();
  renderNavigation(view);
  renderDashboard(view);
  renderToday(view);
  renderReview(view);
  renderPayments(view);
  renderBudget(view);
  renderPay(view);
  renderSafety(view);
  renderSettings();
  byId('demoGuidance').hidden = state.settings.demo.guidanceDismissed;
  byId('applyImportButton').disabled = state.settings.demo.importApplied;
  byId('applyImportButton').textContent = state.settings.demo.importApplied ? 'Fictional preview already applied' : 'Apply fictional preview';
}

function renderNavigation(view) {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const active = button.dataset.view === currentView;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === currentView;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  const [eyebrow, title] = VIEW_META[currentView];
  byId('viewEyebrow').textContent = eyebrow;
  byId('viewTitle').textContent = title;
  byId('reviewNavCount').textContent = String(view.review.total);
  byId('reviewNavCount').setAttribute('aria-label', `${view.review.total} active review groups`);
}

function renderDashboard({ report, safety, priority, review }) {
  const next = priority.nextMove;
  byId('dashboardNextTitle').textContent = next?.title || 'You’re caught up for now';
  byId('dashboardNextDetail').textContent = next?.detail || 'Nothing important needs to take over Today.';
  byId('dashboardNextBand').textContent = priorityLabel(next?.priorityBand || 'done');
  byId('dashboardNextBand').className = `next-move-band band-${next?.priorityBand || 'done'}`;
  byId('dashboardNextTime').textContent = next?.timeframe || 'Done';
  byId('dashboardBalance').textContent = formatCurrency(report.accountBalance);
  byId('dashboardAvailable').textContent = formatCurrency(safety.currentCashCapacity ?? safety.plannedCapacity);
  byId('dashboardCashFlow').textContent = `${formatCurrency(report.summary.income)} in · ${formatCurrency(report.summary.spending)} out · ${formatCurrency(report.summary.netCashFlow)} net.`;
  byId('dashboardBudgetRemaining').textContent = report.budget.remaining < 0 ? `${formatCurrency(Math.abs(report.budget.remaining))} over` : `${formatCurrency(report.budget.remaining)} left`;
  byId('dashboardBudgetText').textContent = `${formatCurrency(report.budget.actual)} spent of ${formatCurrency(report.budget.planned)} planned. ${report.budget.coveragePercent}% categorised.`;
  const budgetPercent = report.budget.planned ? Math.min(100, Math.round((report.budget.actual / report.budget.planned) * 100)) : 0;
  byId('dashboardBudgetProgress').style.width = `${budgetPercent}%`;
  byId('dashboardCommitments').textContent = formatCurrency(report.upcomingCommitments);
  byId('dashboardReviewCount').textContent = String(review.total);
  byId('dashboardReviewText').textContent = review.total ? `${review.total} grouped ${review.total === 1 ? 'decision needs' : 'decisions need'} Alex’s judgement.` : 'Nothing needs review.';
  renderCashFlowChart(report);
  renderRecentPayments();
  renderProgress(report);
}

function renderCashFlowChart(report) {
  const chart = byId('cashFlowChart');
  clear(chart);
  const values = [report.summary.income, report.summary.spending];
  const maximum = Math.max(...values, 1);
  [['Money in', values[0], 'in'], ['Money out', values[1], 'out']].forEach(([label, value, tone]) => {
    const column = element('div', `demo-bar-column ${tone}`);
    const bar = element('span');
    bar.style.height = `${Math.max(8, Math.round((value / maximum) * 130))}px`;
    append(column, bar, element('strong', '', formatCurrency(value)), element('small', '', label));
    chart.append(column);
  });
  byId('cashFlowAlternative').textContent = `Text alternative: ${formatCurrency(report.summary.income)} came in and ${formatCurrency(report.summary.spending)} went out, leaving ${formatCurrency(report.summary.netCashFlow)} net.`;
}

function renderRecentPayments() {
  const container = byId('dashboardRecent');
  clear(container);
  const rows = periodTransactions(state.transactions, state.settings.selectedMonth).slice(-5).reverse();
  rows.forEach((transaction) => {
    const amount = Number(transaction.outgoing || 0) > 0 ? -Number(transaction.outgoing) : Number(transaction.incoming || 0);
    const row = element('div', 'dashboard-list-row horizontal');
    append(row, element('span', '', transaction.description), element('strong', amount < 0 ? 'outgoing' : 'incoming', `${amount < 0 ? '−' : '+'}${formatCurrency(Math.abs(amount))}`));
    container.append(row);
  });
}

function renderProgress(report) {
  const container = byId('dashboardProgress');
  clear(container);
  report.progress.debts.slice(0, 2).forEach((debt) => {
    const row = element('div', 'progress-item');
    const heading = element('div', 'progress-item-heading');
    append(heading, element('strong', '', debt.name), element('span', '', debt.percent === null ? `${formatCurrency(debt.current)} remaining` : `${debt.percent}% cleared`));
    const track = element('div', 'progress-track');
    const bar = element('span'); bar.style.width = `${debt.percent || 0}%`; track.append(bar);
    append(row, heading, track); container.append(row);
  });
  const savings = report.progress.savings;
  const row = element('div', 'progress-item');
  const heading = element('div', 'progress-item-heading');
  append(heading, element('strong', '', 'Emergency buffer'), element('span', '', `${formatCurrency(savings.current)} of ${formatCurrency(savings.target)}`));
  const track = element('div', 'progress-track'); const bar = element('span'); bar.style.width = `${savings.percent || 0}%`; track.append(bar);
  append(row, heading, track); container.append(row);
}

function renderToday({ report, priority, review }) {
  const next = priority.nextMove;
  byId('todayTitle').textContent = next?.title || 'You’re caught up for now';
  byId('todayDetail').textContent = next?.detail || 'There is no unresolved work worth putting in front of Alex right now.';
  byId('todayWhy').textContent = next?.priorityReason || 'OneStep has no meaningful action to recommend right now.';
  byId('todayBand').textContent = priorityLabel(next?.priorityBand || 'done');
  byId('todayBand').className = `next-move-band band-${next?.priorityBand || 'done'}`;
  byId('todayTime').textContent = next?.timeframe || 'Done';
  byId('todayDoButton').hidden = !next;
  byId('todaySnoozeButton').hidden = !next;
  byId('todayDoButton').textContent = next ? actionLabel(next.item) : 'Done';
  byId('todayMargin').textContent = formatCurrency(report.summary.plannedMargin);
  byId('todayCashFlow').textContent = formatCurrency(report.summary.netCashFlow);
  byId('todayDebt').textContent = formatCurrency(report.summary.totalOwed);
  byId('todayReview').textContent = String(review.total);
  const supporting = byId('todaySupporting'); clear(supporting);
  priority.supporting.forEach((entry) => {
    const card = element('article', 'check-in-review-item');
    append(card, element('strong', '', entry.title), element('p', '', entry.detail), element('span', 'time-chip', entry.timeframe));
    supporting.append(card);
  });
  if (!priority.supporting.length) supporting.append(element('p', 'demo-empty', 'Nothing else needs to crowd Today.'));
}

function renderReview({ review }) {
  byId('reviewHeading').textContent = review.total ? `${review.total} grouped ${review.total === 1 ? 'decision' : 'decisions'} need attention` : 'Nothing needs reviewing right now';
  byId('reviewSummary').replaceChildren(
    summaryCount(review.important, 'important'), summaryCount(review.normal, 'other'), summaryCount(review.snoozed.length, 'snoozed')
  );
  const active = byId('reviewActive'); clear(active);
  review.groups.forEach((group) => active.append(reviewCard(group.presentation, group.items, group.priority, false)));
  if (!review.groups.length) active.append(element('p', 'demo-empty', 'The fictional Review Inbox is clear. Reset the demo to restore its starting decisions.'));
  const snoozed = byId('reviewSnoozed'); clear(snoozed);
  review.snoozed.forEach((item) => snoozed.append(reviewCard(reviewItemPresentation(item, state), [item], item.priority, true)));
  byId('reviewSnoozedSection').hidden = !review.snoozed.length;
}

function reviewCard(presentation, items, priority, snoozed) {
  const card = element('article', 'review-card');
  const copy = element('div', 'review-card-copy');
  append(copy, element('span', `review-priority ${priority}`, priority === 'high' ? 'Important' : titleCase(priority)), element('h3', '', presentation.title), element('p', '', presentation.detail));
  const details = element('details', 'review-card-why');
  append(details, element('summary', '', 'Why is this here?'), element('p', '', `${presentation.why} ${presentation.consequence}`));
  copy.append(details);
  const actions = element('div', 'review-card-actions');
  if (snoozed) {
    const wake = actionButton('Return now', 'secondary-button', 'wake', items[0].id); actions.append(wake);
  } else if (items[0].type === 'possible_duplicate') {
    const row = element('div', 'demo-inline-actions');
    append(row, actionButton('Duplicate', 'secondary-button', 'duplicate', items[0].id), actionButton('Both genuine', 'primary-button', 'both_genuine', items[0].id)); actions.append(row);
    actions.append(actionButton('Snooze 1 week', 'text-button', 'snooze', items[0].id));
  } else {
    actions.append(actionButton(actionLabel(items[0]), 'primary-button', 'complete', items[0].id));
    actions.append(actionButton('Snooze 1 week', 'text-button', 'snooze', items[0].id));
  }
  append(card, copy, actions);
  return card;
}

function renderPayments({ report }) {
  byId('paymentsIncome').textContent = formatCurrency(report.summary.income);
  byId('paymentsSpending').textContent = formatCurrency(report.summary.spending);
  byId('paymentsNet').textContent = formatCurrency(report.summary.netCashFlow);
  byId('paymentsUncategorised').textContent = formatCurrency(report.budget.uncategorisedActual);
  populateCategoryFilter();
  const search = byId('paymentSearch').value.trim().toLowerCase();
  const filter = byId('paymentCategoryFilter').value;
  const rows = [...state.transactions].sort((left, right) => right.date.localeCompare(left.date) || right.id.localeCompare(left.id)).filter((transaction) => {
    const category = transaction.category || 'Uncategorised';
    const matchesSearch = !search || `${transaction.description} ${category}`.toLowerCase().includes(search);
    const matchesCategory = filter === 'all' || category === filter;
    return matchesSearch && matchesCategory;
  });
  const body = byId('paymentRows'); clear(body);
  rows.forEach((transaction) => {
    const row = element('tr');
    append(row, cell(formatDate(transaction.date)), cell(transaction.description));
    const categoryCell = element('td'); categoryCell.append(paymentCategoryControl(transaction)); row.append(categoryCell);
    append(row, cell(transaction.incoming ? formatCurrency(transaction.incoming) : '—'), cell(transaction.outgoing ? formatCurrency(transaction.outgoing) : '—'));
    const trusted = isTransactionFinanciallyActive(transaction);
    const trustCell = element('td'); trustCell.append(element('span', `demo-trust${trusted ? '' : ' pending'}`, trusted ? 'Trusted' : 'Held for review')); row.append(trustCell);
    body.append(row);
  });
  if (!rows.length) {
    const row = element('tr'); const empty = element('td', '', 'No fictional payments match these filters.'); empty.colSpan = 6; row.append(empty); body.append(row);
  }
}

function paymentCategoryControl(transaction) {
  if (transaction.duplicateStatus === 'possible' && transaction.reviewStatus === 'pending') {
    const wrapper = element('div', 'demo-category-control');
    append(wrapper, element('span', '', transaction.category || 'Uncategorised'));
    const actions = element('div', 'demo-inline-actions');
    append(actions, paymentButton('Duplicate', transaction.id, 'duplicate'), paymentButton('Both genuine', transaction.id, 'both_genuine'));
    wrapper.append(actions); return wrapper;
  }
  if (Number(transaction.outgoing || 0) > 0 && !transaction.category) {
    const wrapper = element('div', 'demo-category-control');
    const select = element('select'); select.setAttribute('aria-label', `Category for ${transaction.description}`); select.dataset.categorySelect = transaction.id;
    const prompt = element('option', '', 'Choose category'); prompt.value = ''; select.append(prompt);
    [...state.budgets].sort((a, b) => compareLabels(a.category, b.category)).forEach((budget) => { const option = element('option', '', budget.category); option.value = budget.id; select.append(option); });
    const button = element('button', 'secondary-button', 'Save'); button.type = 'button'; button.dataset.categorySave = transaction.id;
    append(wrapper, select, button); return wrapper;
  }
  return element('span', '', transaction.category || 'Uncategorised');
}

function renderBudget({ report }) {
  byId('budgetPlanned').textContent = formatCurrency(report.budget.planned);
  byId('budgetActual').textContent = formatCurrency(report.budget.actual);
  byId('budgetRemaining').textContent = formatCurrency(report.budget.remaining);
  byId('budgetCoverage').textContent = `${report.budget.coveragePercent}%`;
  const container = byId('budgetRows'); clear(container);
  [...report.budget.rows].sort((a, b) => compareLabels(a.category, b.category)).forEach((budget) => {
    const row = element('article', 'demo-budget-row');
    const copy = element('div', 'demo-budget-copy'); append(copy, element('strong', '', budget.category), element('span', '', budget.section || 'Budget category'));
    const track = element('div', 'progress-track'); const progress = element('span'); progress.style.width = `${Math.min(100, Math.max(0, budget.progressPercent || 0))}%`; track.append(progress);
    const values = element('div', 'demo-budget-values'); append(values, element('strong', '', `${formatCurrency(budget.actual)} / ${formatCurrency(budget.planned)}`), element('span', '', `${formatCurrency(budget.remaining)} remaining`));
    append(row, copy, track, values); container.append(row);
  });
  if (report.budget.uncategorisedActual > 0) {
    const row = element('article', 'demo-budget-row');
    const copy = element('div', 'demo-budget-copy'); append(copy, element('strong', '', 'Uncategorised'), element('span', '', 'Needs review'));
    append(row, copy, element('p', 'muted', 'Included in total actual spending, but not assigned to a plan yet.'), element('strong', '', formatCurrency(report.budget.uncategorisedActual)));
    container.append(row);
  }
}

function renderPay({ report }) {
  byId('grossPay').textContent = formatCurrency(report.summary.grossPay);
  byId('payDeductions').textContent = formatCurrency(report.summary.payrollDeductions);
  byId('netPay').textContent = formatCurrency(report.summary.netPay);
}

function renderSafety({ safety }) {
  const blocked = safety.blockingReasons.length > 0;
  byId('safetyHero').classList.toggle('safe', !blocked);
  byId('safetyTitle').textContent = blocked ? 'Optional extra payments are paused' : 'Recorded details pass the current safety checks';
  byId('safetyText').textContent = blocked ? safety.blockingReasons[0] : 'No unresolved safety-critical detail is blocking the fictional plan. Arranged accounts still keep only their agreed payment.';
  byId('safetyRequested').textContent = formatCurrency(safety.requestedExtraPayment);
  byId('safetyAvailable').textContent = formatCurrency(safety.safeExtraPayment);
  const container = byId('safetyAccounts'); clear(container);
  safety.accounts.forEach((account) => {
    const card = element('article', 'demo-safety-card'); const header = element('header');
    append(header, element('h3', '', account.name), element('span', `safety-status${account.blockingReasons.length ? ' blocked' : ''}`, account.blockingReasons.length ? 'Needs information' : account.eligibleForExtra ? 'Eligible' : 'Protected'));
    append(card, header, element('strong', '', `${formatCurrency(account.balance)} remaining`), element('p', '', account.blockingReasons[0] || account.exclusionReason || 'Recorded details are complete for this fictional account.'));
    container.append(card);
  });
}

function renderSettings() {
  const theme = state.settings.appearance.theme;
  document.querySelectorAll('input[name="demo-theme"]').forEach((input) => { input.checked = input.value === theme; });
  byId('quickThemeButton').textContent = document.documentElement.dataset.theme === 'dark' ? 'Light mode' : 'Night mode';
}

function actOnToday() {
  const { priority } = deriveDemoView(state);
  if (!priority.nextMove) return;
  actOnDemoReviewItem(state, priority.nextMove.item.id);
  commit('Next Move completed. OneStep has recalculated what deserves attention next.');
}

function snoozeToday() {
  const { priority } = deriveDemoView(state);
  if (!priority.nextMove) return;
  snoozeDemoReviewItem(state, priority.nextMove.item.id);
  commit('Next Move snoozed for one week. The next useful decision is now in focus.');
}

function handleReviewAction(event) {
  const button = event.target.closest('[data-review-action]');
  if (!button) return;
  if (button.dataset.reviewAction === 'snooze') snoozeDemoReviewItem(state, button.dataset.reviewId);
  else if (button.dataset.reviewAction === 'wake') wakeDemoReviewItem(state, button.dataset.reviewId);
  else actOnDemoReviewItem(state, button.dataset.reviewId, button.dataset.reviewAction);
  commit('The fictional Review Inbox and connected totals were updated.');
}

function handlePaymentAction(event) {
  const save = event.target.closest('[data-category-save]');
  if (save) {
    const select = document.querySelector(`[data-category-select="${save.dataset.categorySave}"]`);
    if (!select?.value) return showToast('Choose a category first.');
    categoriseDemoTransaction(state, save.dataset.categorySave, select.value);
    return commit('Payment categorised. Budget and Review Inbox now reflect the same decision.');
  }
  const duplicate = event.target.closest('[data-payment-action]');
  if (!duplicate) return;
  const item = state.reviewItems.find((entry) => entry.sourceId === duplicate.dataset.paymentId && entry.type === 'possible_duplicate' && entry.status !== 'resolved');
  if (!item) return;
  actOnDemoReviewItem(state, item.id, duplicate.dataset.paymentAction);
  commit('Possible duplicate decision applied to trusted Payments totals.');
}

function selectView(viewName) {
  if (!VIEW_META[viewName]) return;
  currentView = viewName;
  renderAll();
  byId('demoMain').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetDemo() {
  state = resetDemoState();
  currentView = 'dashboard';
  byId('paymentSearch').value = '';
  byId('paymentCategoryFilter').value = 'all';
  renderAll();
  showToast('The canonical fictional demo has been restored exactly.');
}

function commit(message) {
  saveDemoState(state);
  renderAll();
  showToast(message);
}

function applyTheme() {
  const preference = state.settings.appearance.theme;
  const resolved = preference === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : preference;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = resolved;
}

function populateCategoryFilter() {
  const select = byId('paymentCategoryFilter');
  const value = select.value || 'all';
  const categories = [...new Set(state.transactions.map((transaction) => transaction.category || 'Uncategorised'))].sort(compareLabels);
  select.replaceChildren(option('All categories', 'all'), ...categories.map((category) => option(category, category)));
  select.value = categories.includes(value) || value === 'all' ? value : 'all';
}

function openWelcome() {
  const dialog = byId('demoWelcome');
  dialog.removeAttribute('open');
  openDialog(dialog);
}

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function' && dialog.open) dialog.close();
  else dialog.removeAttribute('open');
}

function showToast(message) {
  const toast = byId('demoToast');
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, 4200);
}

function actionLabel(item) {
  if (!item) return 'Do it';
  if (item.type === 'uncategorised_payment') return 'Categorise as Eating out';
  if (item.type === 'possible_duplicate') return 'Mark as duplicate';
  if (item.type === 'financial_action') return 'Confirm fictional £25 arrangement';
  if (item.type === 'generated_action') return 'Mark action complete';
  return 'Continue';
}

function actionButton(label, className, action, id) {
  const button = element('button', className, label); button.type = 'button'; button.dataset.reviewAction = action; button.dataset.reviewId = id; return button;
}

function paymentButton(label, id, action) {
  const button = element('button', action === 'both_genuine' ? 'primary-button' : 'secondary-button', label); button.type = 'button'; button.dataset.paymentId = id; button.dataset.paymentAction = action; return button;
}

function summaryCount(value, label) {
  const span = element('span'); append(span, element('strong', '', String(value)), document.createTextNode(` ${label}`)); return span;
}

function priorityLabel(value) { return ({ critical: 'Critical', important: 'Important', normal: 'Useful', low: 'Low priority', done: 'Caught up' })[value] || titleCase(value); }
function titleCase(value) { return String(value || '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function byId(id) { return document.getElementById(id); }
function clear(node) { node.replaceChildren(); }
function element(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text !== '') node.textContent = String(text); return node; }
function append(node, ...children) { node.append(...children.filter(Boolean)); return node; }
function cell(text) { return element('td', '', text); }
function option(label, value) { const node = element('option', '', label); node.value = value; return node; }
