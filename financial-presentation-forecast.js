import { buildCashFlowForecast, CASH_FLOW_CERTAINTY, CASH_FLOW_HORIZON } from './cash-flow-forecast.js';
import { formatCurrency, formatDate } from './finance-core.js';

const HORIZON_ORDER = Object.freeze([
  CASH_FLOW_HORIZON.TODAY,
  CASH_FLOW_HORIZON.BEFORE_PAYDAY,
  CASH_FLOW_HORIZON.SEVEN_DAYS,
  CASH_FLOW_HORIZON.THIRTY_DAYS,
  CASH_FLOW_HORIZON.NEXT_PAYDAY,
  CASH_FLOW_HORIZON.THREE_MONTHS
]);

const RISK_COPY = Object.freeze({
  projected_negative: 'The ordinary projection falls below £0 before this horizon.',
  safe_negative: 'The conservative safe projection falls below £0 before this horizon.',
  buffer_breach: 'The protected buffer may be breached before this horizon.'
});

let selectedHorizon = CASH_FLOW_HORIZON.SEVEN_DAYS;
let refreshQueued = false;
let refreshInFlight = false;
let rerunRefresh = false;

export function buildForecastPresentationModel(forecast, horizonId = CASH_FLOW_HORIZON.SEVEN_DAYS) {
  const available = Array.isArray(forecast?.horizons) ? forecast.horizons : [];
  const selected = available.find((item) => item.id === horizonId)
    || available.find((item) => item.status === 'available')
    || available[0]
    || null;
  const endDate = selected?.date || forecast?.asOf || null;
  const timeline = (forecast?.events || [])
    .filter((item) => !endDate || item.date <= endDate)
    .slice(0, 10);
  return {
    status: forecast?.status || 'unavailable',
    asOf: forecast?.asOf || null,
    selected,
    horizons: HORIZON_ORDER.map((id) => available.find((item) => item.id === id)).filter(Boolean),
    timeline,
    blockers: Array.isArray(forecast?.blockers) ? forecast.blockers : [],
    why: Array.isArray(forecast?.why) ? forecast.why : [],
    budgetTreatment: forecast?.budgetContext?.treatment || 'context_only'
  };
}

function boot() {
  if (!window.financeAPI?.loadState) return;
  ensureHost();
  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('change', handleDocumentChange, true);
  observeExternalRenders();
  scheduleRefresh();
}

function ensureHost() {
  if (document.getElementById('cashFlowForecastPanel')) return;
  const today = document.getElementById('view-today');
  const metrics = today?.querySelector('.metric-grid');
  if (!today || !metrics) return;
  const panel = document.createElement('section');
  panel.id = 'cashFlowForecastPanel';
  panel.className = 'panel';
  panel.setAttribute('aria-labelledby', 'cashFlowForecastTitle');
  panel.innerHTML = [
    '<div class="panel-heading"><div><p class="eyebrow">LOOKING AHEAD</p><h2 id="cashFlowForecastTitle">Cash-flow forecast</h2><p class="muted">A conservative local view of what is already known, what is expected, and what is only planned.</p></div></div>',
    '<div id="cashFlowForecastHorizons" class="button-row" role="group" aria-label="Forecast horizon"></div>',
    '<div id="cashFlowForecastSummary" class="metric-grid three"></div>',
    '<div id="cashFlowForecastWarnings" class="warning-box" hidden></div>',
    '<div class="two-column"><div><h3>Major expected movements</h3><div id="cashFlowForecastTimeline" class="dashboard-list"></div></div><div><h3>Assumptions</h3><div id="cashFlowForecastAssumptions"></div></div></div>',
    '<p id="cashFlowForecastStatus" class="muted" role="status" aria-live="polite"></p>'
  ].join('');
  metrics.after(panel);
}

function handleDocumentClick(event) {
  const horizon = event.target.closest('[data-cash-flow-horizon]');
  if (horizon) {
    selectedHorizon = horizon.dataset.cashFlowHorizon;
    scheduleRefresh();
    return;
  }
  if (event.target.closest('.nav-button, [data-view-target], [data-add], [data-edit], [data-review-route], [data-review-decision], [data-review-snooze], #saveSettingsButton, #saveEditButton, #confirmImportButton, #confirmRestoreButton')) {
    window.setTimeout(scheduleRefresh, 120);
  }
}

function handleDocumentChange(event) {
  if (document.getElementById('cashFlowForecastPanel')?.contains(event.target)) return;
  window.setTimeout(scheduleRefresh, 120);
}

function observeExternalRenders() {
  const targets = ['appShell', 'view-today', 'todayDebtValue', 'todayOverdraftValue', 'marginValue', 'dashboardUpcomingValue'];
  for (const id of targets) {
    const target = document.getElementById(id);
    if (!target) continue;
    const observer = new MutationObserver(() => scheduleRefresh());
    observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: id !== 'appShell' && id !== 'view-today' });
  }
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  window.setTimeout(() => {
    refreshQueued = false;
    refreshForecast();
  }, 40);
}

async function refreshForecast() {
  if (refreshInFlight) {
    rerunRefresh = true;
    return;
  }
  refreshInFlight = true;
  try {
    ensureHost();
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) {
      renderUnavailable('Forecasting is unavailable while financial data is not in normal mode.');
      return;
    }
    const forecast = buildCashFlowForecast(loaded.state);
    renderForecast(buildForecastPresentationModel(forecast, selectedHorizon));
  } catch {
    renderUnavailable('The forecast could not be calculated. No financial data was changed.');
  } finally {
    refreshInFlight = false;
    if (rerunRefresh) {
      rerunRefresh = false;
      scheduleRefresh();
    }
  }
}

function renderForecast(model) {
  const panel = document.getElementById('cashFlowForecastPanel');
  if (!panel) return;
  const controls = document.getElementById('cashFlowForecastHorizons');
  controls.replaceChildren();
  for (const horizon of model.horizons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = horizon.id === model.selected?.id ? 'primary-button' : 'secondary-button';
    button.dataset.cashFlowHorizon = horizon.id;
    button.textContent = horizon.label;
    button.disabled = horizon.status !== 'available';
    button.setAttribute('aria-pressed', String(horizon.id === model.selected?.id));
    if (horizon.date) button.title = `Through ${safeDate(horizon.date)}`;
    controls.append(button);
  }

  const summary = document.getElementById('cashFlowForecastSummary');
  summary.replaceChildren();
  if (!model.selected || model.selected.status !== 'available') {
    summary.append(metric('Projected balance', 'Unavailable', 'Add a dependable payday or the missing trusted information.'));
  } else {
    summary.append(
      metric('Projected balance', money(model.selected.projectedBalance), 'Includes expected scheduled income and expected outgoings.'),
      metric('Safe view', money(model.selected.safeProjectedBalance), 'Expected future income is not counted until it is received.'),
      metric('Forecast through', safeDate(model.selected.date), `${model.selected.eventCount || 0} major movement${model.selected.eventCount === 1 ? '' : 's'} included.`)
    );
  }

  const warnings = document.getElementById('cashFlowForecastWarnings');
  const warningCopy = [...new Set((model.selected?.riskFlags || []).map((flag) => RISK_COPY[flag]).filter(Boolean))];
  warnings.hidden = warningCopy.length === 0;
  warnings.replaceChildren();
  if (warningCopy.length) {
    const strong = document.createElement('strong');
    strong.textContent = 'Check this horizon';
    const list = document.createElement('ul');
    for (const copy of warningCopy) list.append(listItem(copy));
    warnings.append(strong, list);
  }

  const timeline = document.getElementById('cashFlowForecastTimeline');
  timeline.replaceChildren();
  if (!model.timeline.length) timeline.append(emptyText('No scheduled or strongly evidenced movements fall inside this horizon.'));
  for (const event of model.timeline) timeline.append(timelineRow(event));

  const assumptions = document.getElementById('cashFlowForecastAssumptions');
  assumptions.replaceChildren();
  if (model.blockers.length) {
    const blocker = document.createElement('div');
    blocker.className = 'check-card warning';
    const title = document.createElement('h3'); title.textContent = 'Needs review';
    const list = document.createElement('ul');
    for (const item of model.blockers) list.append(listItem(item.explanation || 'A financial fact needs review.'));
    blocker.append(title, list); assumptions.append(blocker);
  }
  const details = document.createElement('details');
  details.className = 'plan-why';
  const summaryNode = document.createElement('summary'); summaryNode.textContent = 'Why?';
  const whyList = document.createElement('ul');
  for (const copy of model.why) whyList.append(listItem(copy));
  if (model.budgetTreatment === 'context_only') whyList.append(listItem('Budget allowances remain planning context and are not treated as mandatory bills.'));
  details.append(summaryNode, whyList);
  assumptions.append(details);

  document.getElementById('cashFlowForecastStatus').textContent = model.status === 'available'
    ? 'Forecast calculated locally from the current trusted financial profile. Derived totals are not stored as authoritative data.'
    : 'Forecast shown conservatively because one or more trusted inputs need review.';
}

function renderUnavailable(message) {
  ensureHost();
  const status = document.getElementById('cashFlowForecastStatus');
  if (status) status.textContent = message;
}

function metric(label, value, hint) {
  const article = document.createElement('article'); article.className = 'metric-card';
  const span = document.createElement('span'); span.textContent = label;
  const strong = document.createElement('strong'); strong.textContent = value;
  const small = document.createElement('small'); small.textContent = hint;
  article.append(span, strong, small); return article;
}

function timelineRow(event) {
  const row = document.createElement('div'); row.className = 'dashboard-list-row horizontal';
  const copy = document.createElement('div');
  const title = document.createElement('strong'); title.textContent = event.explanation || event.sourceType || 'Forecast movement';
  const meta = document.createElement('span');
  meta.textContent = `${safeDate(event.date)} · ${certaintyLabel(event.certainty)}${event.certainty === CASH_FLOW_CERTAINTY.EXPECTED && event.delta > 0 ? ' · not counted in safe view until received' : ''}`;
  copy.append(title, meta);
  const amount = document.createElement('strong');
  amount.className = event.delta < 0 ? 'outgoing' : 'incoming';
  amount.textContent = `${event.delta < 0 ? '−' : '+'}${money(Math.abs(event.delta))}`;
  row.append(copy, amount); return row;
}

function certaintyLabel(value) {
  if (value === CASH_FLOW_CERTAINTY.CONFIRMED) return 'Confirmed';
  if (value === CASH_FLOW_CERTAINTY.EXPECTED) return 'Expected';
  return 'Possible · plan only';
}

function safeDate(value) {
  if (!value) return 'Unavailable';
  try { return formatDate(value); } catch { return String(value); }
}

function money(value) {
  return Number.isFinite(Number(value)) ? formatCurrency(Number(value)) : 'Unavailable';
}

function listItem(text) {
  const item = document.createElement('li'); item.textContent = text; return item;
}

function emptyText(text) {
  const p = document.createElement('p'); p.className = 'muted'; p.textContent = text; return p;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();
