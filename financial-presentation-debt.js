import { buildCashFlowForecast } from './cash-flow-forecast.js';
import {
  buildDebtRecommendation,
  DEBT_RECOMMENDATION_STATUS,
  DEBT_RECOMMENDATION_STRATEGY,
  setDebtRecommendationStrategy
} from './debt-recommendation-engine.js';
import { formatCurrency, formatDate } from './finance-core.js';

const STATUS_COPY = Object.freeze({
  [DEBT_RECOMMENDATION_STATUS.AVAILABLE]: {
    title: 'A safe optional debt move is available',
    tone: 'positive'
  },
  [DEBT_RECOMMENDATION_STATUS.DO_NOT_OVERPAY]: {
    title: 'Do not overpay yet',
    tone: 'warning'
  },
  [DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW]: {
    title: 'Review the safety blockers first',
    tone: 'warning'
  },
  [DEBT_RECOMMENDATION_STATUS.NO_DEBT]: {
    title: 'No active debt needs an overpayment recommendation',
    tone: 'neutral'
  }
});

let refreshQueued = false;
let refreshInFlight = false;
let rerunRefresh = false;
let savingStrategy = false;

export function buildDebtRecommendationPresentationModel(recommendation) {
  const status = recommendation?.status || DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW;
  return {
    status,
    heading: STATUS_COPY[status] || STATUS_COPY[DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW],
    strategy: recommendation?.strategy || DEBT_RECOMMENDATION_STRATEGY.RECOMMENDED,
    priority: recommendation?.priorityDebt || null,
    alternative: recommendation?.alternativeDebt || null,
    requiredPayments: Array.isArray(recommendation?.requiredPayments) ? recommendation.requiredPayments : [],
    requiredPaymentTotal: Number(recommendation?.requiredPaymentTotal || 0),
    maximumSafeOptionalAmount: Number(recommendation?.maximumSafeOptionalAmount || 0),
    blockers: Array.isArray(recommendation?.blockers) ? recommendation.blockers : [],
    why: Array.isArray(recommendation?.why) ? recommendation.why : [],
    capacity: recommendation?.capacity || {},
    externalPaymentMade: recommendation?.externalPaymentMade === true
  };
}

function boot() {
  if (!window.financeAPI?.loadState) return;
  ensureHost();
  document.addEventListener('click', handleDocumentClick, true);
  document.addEventListener('change', handleDocumentChange, true);
  observeDebtRenders();
  scheduleRefresh();
}

function ensureHost() {
  if (document.getElementById('debtRecommendationPanel')) return;
  const view = document.getElementById('view-debts');
  const metrics = view?.querySelector('.metric-grid');
  if (!view || !metrics) return;
  const panel = document.createElement('section');
  panel.id = 'debtRecommendationPanel';
  panel.className = 'panel';
  panel.setAttribute('aria-labelledby', 'debtRecommendationTitle');
  panel.innerHTML = [
    '<div class="panel-heading"><div><p class="eyebrow">SAFETY-FIRST DEBT PLAN</p><h2 id="debtRecommendationTitle">Debt recommendation</h2><p class="muted">Required payments first. Optional extra payments only when the current cash position and protected buffer make them safe.</p></div></div>',
    '<div class="button-row"><label class="compact-field">Strategy<select id="debtRecommendationStrategy"><option value="recommended">Recommended · safety first</option><option value="highest_cost">Highest cost first</option><option value="small_balance">Small balance first</option></select></label><span id="debtRecommendationStrategyStatus" class="muted" role="status" aria-live="polite"></span></div>',
    '<article id="debtRecommendationSummary" class="check-card neutral"></article>',
    '<div class="two-column"><div><h3>Required payments</h3><div id="debtRecommendationRequired" class="dashboard-list"></div></div><div><h3>Optional extra</h3><div id="debtRecommendationOptional"></div></div></div>',
    '<details id="debtRecommendationWhy" class="plan-why"><summary>Why?</summary><ul id="debtRecommendationWhyList"></ul></details>',
    '<p id="debtRecommendationStatus" class="muted" role="status" aria-live="polite"></p>'
  ].join('');
  metrics.after(panel);
}

function handleDocumentClick(event) {
  if (event.target.closest('.nav-button, [data-view-target], [data-add], [data-edit], [data-review-route], [data-review-decision], [data-review-snooze], #saveSettingsButton, #saveEditButton, #confirmImportButton, #confirmRestoreButton')) {
    window.setTimeout(scheduleRefresh, 120);
  }
}

function handleDocumentChange(event) {
  if (event.target?.id === 'debtRecommendationStrategy') {
    saveStrategy(event.target.value);
    return;
  }
  if (document.getElementById('debtRecommendationPanel')?.contains(event.target)) return;
  window.setTimeout(scheduleRefresh, 120);
}

function observeDebtRenders() {
  const targets = ['appShell', 'view-debts', 'debtCards', 'debtTotalValue', 'overdraftTotalValue'];
  for (const id of targets) {
    const target = document.getElementById(id);
    if (!target) continue;
    const observer = new MutationObserver(() => {
      hideLegacyDebtPlan();
      scheduleRefresh();
    });
    observer.observe(target, { attributes: true, childList: true, characterData: true, subtree: id !== 'appShell' && id !== 'view-debts' });
  }
  hideLegacyDebtPlan();
}

function hideLegacyDebtPlan() {
  const legacy = document.querySelector('#debtCards > .check-card');
  if (!legacy) return;
  legacy.hidden = true;
  legacy.setAttribute('aria-hidden', 'true');
  legacy.dataset.replacedByDebtRecommendation = 'true';
}

function scheduleRefresh() {
  if (refreshQueued || savingStrategy) return;
  refreshQueued = true;
  window.setTimeout(() => {
    refreshQueued = false;
    refreshRecommendation();
  }, 40);
}

async function refreshRecommendation() {
  if (refreshInFlight) {
    rerunRefresh = true;
    return;
  }
  refreshInFlight = true;
  try {
    ensureHost();
    hideLegacyDebtPlan();
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) {
      renderUnavailable('Debt planning is unavailable while financial data is not in normal mode.');
      return;
    }
    const forecast = buildCashFlowForecast(loaded.state);
    const recommendation = buildDebtRecommendation(loaded.state, { forecast });
    renderRecommendation(buildDebtRecommendationPresentationModel(recommendation));
  } catch {
    renderUnavailable('The debt recommendation could not be calculated. No debt balance or payment was changed.');
  } finally {
    refreshInFlight = false;
    if (rerunRefresh) {
      rerunRefresh = false;
      scheduleRefresh();
    }
  }
}

async function saveStrategy(value) {
  if (savingStrategy) return;
  savingStrategy = true;
  const status = document.getElementById('debtRecommendationStrategyStatus');
  if (status) status.textContent = 'Saving preference…';
  try {
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) throw new Error('Financial data is not available for editing.');
    const next = setDebtRecommendationStrategy(loaded.state, value);
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while recovery is required.');
    if (saved?.status === 'conflict') {
      if (status) status.textContent = 'Your data changed at the same time. The strategy was not overwritten; try again.';
      return;
    }
    if (status) status.textContent = 'Strategy saved.';
    window.location.reload();
  } catch (error) {
    if (status) status.textContent = error?.message || 'The strategy could not be saved.';
  } finally {
    savingStrategy = false;
  }
}

function renderRecommendation(model) {
  hideLegacyDebtPlan();
  const strategy = document.getElementById('debtRecommendationStrategy');
  if (strategy && strategy.value !== model.strategy) strategy.value = model.strategy;

  const summary = document.getElementById('debtRecommendationSummary');
  summary.className = `check-card ${model.heading.tone}`;
  summary.replaceChildren();
  const title = document.createElement('h3'); title.textContent = model.heading.title;
  const copy = document.createElement('p'); copy.textContent = recommendationSummary(model);
  summary.append(title, copy);

  const required = document.getElementById('debtRecommendationRequired');
  required.replaceChildren();
  if (!model.requiredPayments.length) required.append(emptyText('No separate required debt payment is recorded for the current recommendation.'));
  for (const item of model.requiredPayments) {
    const row = document.createElement('div'); row.className = 'dashboard-list-row horizontal';
    const copyNode = document.createElement('div');
    const name = document.createElement('strong'); name.textContent = item.name || 'Required debt payment';
    const meta = document.createElement('span'); meta.textContent = `${item.type === 'arrangement_or_agreed_payment' ? 'Agreed / arrangement payment' : 'Contractual minimum'}${item.dueDate ? ` · due ${safeDate(item.dueDate)}` : ''}`;
    copyNode.append(name, meta);
    const amount = document.createElement('strong'); amount.textContent = money(item.amount);
    row.append(copyNode, amount); required.append(row);
  }
  if (model.requiredPayments.length) {
    const total = document.createElement('p'); total.className = 'muted'; total.textContent = `${money(model.requiredPaymentTotal)} of required debt payments is protected before any optional extra.`; required.append(total);
  }

  const optional = document.getElementById('debtRecommendationOptional');
  optional.replaceChildren();
  if (model.status === DEBT_RECOMMENDATION_STATUS.AVAILABLE && model.priority) {
    optional.append(metric('Priority debt', model.priority.name || 'Eligible debt', priorityMeta(model.priority)));
    optional.append(metric('Maximum safe optional amount', money(model.maximumSafeOptionalAmount), 'This is a ceiling, not a required payment. OneStep will not make the payment for you.'));
    if (model.alternative) optional.append(metric('Alternative eligible debt', model.alternative.name || 'Alternative', priorityMeta(model.alternative)));
  } else {
    const card = document.createElement('article'); card.className = 'check-card warning';
    const heading = document.createElement('h3'); heading.textContent = model.status === DEBT_RECOMMENDATION_STATUS.NO_DEBT ? 'Nothing optional to plan' : 'Optional payment paused';
    const text = document.createElement('p'); text.textContent = model.blockers[0]?.explanation || 'OneStep is not recommending an optional debt payment from the current trusted information.';
    card.append(heading, text); optional.append(card);
  }

  if (model.blockers.length > 1) {
    const list = document.createElement('ul');
    for (const blocker of model.blockers.slice(1)) list.append(listItem(blocker.explanation || 'A safety condition needs review.'));
    optional.append(list);
  }

  const why = document.getElementById('debtRecommendationWhyList');
  why.replaceChildren();
  for (const item of model.why) why.append(listItem(item));
  why.append(listItem('Expected future income is never treated as cash already received.'));
  why.append(listItem('No external debt payment is initiated by this recommendation.'));

  document.getElementById('debtRecommendationStatus').textContent = model.externalPaymentMade
    ? 'Unexpected payment state detected; review the underlying financial record.'
    : 'Recommendation calculated locally from current trusted data. It is derived guidance, not a recorded payment.';
}

function recommendationSummary(model) {
  if (model.status === DEBT_RECOMMENDATION_STATUS.AVAILABLE && model.priority) {
    return `${model.priority.name} is the current priority after required payments and cash-safety checks. Up to ${money(model.maximumSafeOptionalAmount)} is available as an optional amount without using expected-but-unreceived income.`;
  }
  if (model.status === DEBT_RECOMMENDATION_STATUS.NO_DEBT) return 'No active eligible debt balance currently needs an optional-overpayment decision.';
  return model.blockers[0]?.explanation || 'Required payments, short-term stability and the protected buffer take priority over faster payoff.';
}

function priorityMeta(item) {
  const parts = [];
  if (Number.isFinite(Number(item.balance))) parts.push(`${money(item.balance)} balance`);
  if (Number.isFinite(Number(item.apr))) parts.push(`${(Number(item.apr) * 100).toFixed(2)}% APR`);
  if (item.interestFrozen) parts.push('interest frozen');
  if (item.overLimit) parts.push('over limit');
  return parts.join(' · ') || 'Eligible after safety checks';
}

function metric(label, value, hint) {
  const article = document.createElement('article'); article.className = 'metric-card';
  const span = document.createElement('span'); span.textContent = label;
  const strong = document.createElement('strong'); strong.textContent = value;
  const small = document.createElement('small'); small.textContent = hint;
  article.append(span, strong, small); return article;
}

function safeDate(value) {
  if (!value) return 'date not recorded';
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

function renderUnavailable(message) {
  ensureHost();
  const status = document.getElementById('debtRecommendationStatus');
  if (status) status.textContent = message;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();
