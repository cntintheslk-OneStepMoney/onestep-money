import {
  SUBSCRIPTION_SAVINGS_STATUS,
  buildSubscriptionSavingsRecommendation,
  readSubscriptionSavingsTarget,
  setSubscriptionSavingsTarget
} from './subscription-savings.js';
import { subscriptionRecommendationOptions } from './subscription-workflow.js';

let latestState = null;
let refreshQueued = false;
let saving = false;
let statusMessage = '';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    new MutationObserver(scheduleRefresh).observe(document.documentElement, { childList: true, subtree: true });
    document.addEventListener('submit', handleSubmit);
    scheduleRefresh();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else queueMicrotask(start);
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(async () => {
    refreshQueued = false;
    await renderSavingsPanel();
  });
}

async function renderSavingsPanel() {
  const view = document.getElementById('view-subscriptions');
  const summary = view?.querySelector('.subscriptions-summary');
  if (!view || !summary || view.querySelector('[data-subscription-savings-panel]') || !window.financeAPI?.loadState) return;
  const loaded = await window.financeAPI.loadState().catch(() => null);
  if (loaded?.status !== 'normal') return;
  latestState = loaded.state;
  const panel = buildPanel(latestState);
  summary.after(panel);
}

function buildPanel(state) {
  const target = readSubscriptionSavingsTarget(state);
  const recommendation = buildSubscriptionSavingsRecommendation(state, subscriptionRecommendationOptions(state));
  const section = el('section', 'subscriptions-section');
  section.dataset.subscriptionSavingsPanel = 'true';

  const heading = el('div', 'subscriptions-section-heading');
  append(
    heading,
    el('h2', '', 'Monthly savings target'),
    el('p', 'muted', 'OneStep starts with your lowest-value eligible subscriptions and uses the conservative minimum monthly saving. Keep, Essential, Excluded and lifecycle review choices stay authoritative.')
  );
  section.append(heading);

  const form = el('form', 'subscription-add-form');
  form.id = 'subscriptionSavingsTargetForm';
  const targetInput = document.createElement('input');
  targetInput.name = 'monthlyTarget';
  targetInput.type = 'number';
  targetInput.min = '0';
  targetInput.max = '100000000';
  targetInput.step = '0.01';
  targetInput.value = String(target || 0);
  targetInput.required = true;
  form.append(field('Target to save each month', targetInput));
  const save = button(saving ? 'Saving…' : 'Save savings target', 'primary-button', 'submit');
  save.disabled = saving;
  form.append(save);
  section.append(form);

  const live = el('p', 'subscriptions-status muted', statusMessage);
  live.dataset.subscriptionSavingsStatus = 'true';
  live.setAttribute('role', 'status');
  live.setAttribute('aria-live', 'polite');
  section.append(live);

  section.append(recommendationView(recommendation));
  return section;
}

function recommendationView(recommendation) {
  const card = el('article', 'subscription-card');
  card.dataset.subscriptionSavingsRecommendation = recommendation.status;
  if (recommendation.status === SUBSCRIPTION_SAVINGS_STATUS.NO_TARGET) {
    append(card, el('strong', '', 'No savings target set'), el('p', 'muted', 'Set a monthly target above £0 to see a conservative subscription recommendation.'));
    return card;
  }
  if (recommendation.status === SUBSCRIPTION_SAVINGS_STATUS.NO_ELIGIBLE) {
    append(card, el('strong', '', 'No safe ranked subscriptions are eligible'), el('p', 'muted', 'OneStep will not substitute protected, unranked, uncertain, lifecycle-blocked or contract-review subscriptions just to hit the target.'));
    return card;
  }

  const heading = recommendation.meetsTarget ? 'Target can be covered by eligible subscriptions' : 'Eligible subscriptions do not fully cover the target';
  append(card, el('strong', '', heading));
  const facts = el('div', 'subscription-facts');
  facts.append(
    fact('Monthly target', money(recommendation.monthlyTarget)),
    fact('Conservative saving', money(recommendation.conservativeMonthlySaving)),
    fact('Monthly range', moneyRange(recommendation.monthly)),
    fact('Annual range', moneyRange(recommendation.annual)),
    fact('Bottom of ranking', recommendation.bottomPercent ? `Approx. ${recommendation.bottomPercent}%` : 'Not available'),
    fact('Remaining gap', money(recommendation.remainingGap))
  );
  card.append(facts);

  if (recommendation.selected.length) {
    const list = document.createElement('ol');
    list.className = 'subscription-savings-selection';
    for (const item of recommendation.selected) {
      const row = document.createElement('li');
      row.textContent = `${item.providerName} — ${money(item.conservativeMonthlySaving)} conservative monthly saving`;
      list.append(row);
    }
    card.append(el('p', 'muted', 'Lowest personal value first:'), list);
  }

  card.append(el('p', 'subscription-notice', 'Advice only. OneStep does not cancel subscriptions or move money. Review cancellation terms and Financial Safety before acting.'));
  return card;
}

async function handleSubmit(event) {
  const form = event.target.closest('#subscriptionSavingsTargetForm');
  if (!form || saving || !latestState || !window.financeAPI?.saveState) return;
  event.preventDefault();
  saving = true;
  statusMessage = 'Saving monthly savings target…';
  replacePanel();
  try {
    const next = setSubscriptionSavingsTarget(latestState, form.elements.monthlyTarget.value, new Date());
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'conflict') {
      latestState = saved.state || latestState;
      statusMessage = saved.message || 'Your data changed elsewhere. The newest state is shown; review it and try again.';
    } else {
      latestState = saved;
      statusMessage = 'Monthly savings target saved. Recommendation recalculated from current subscription and lifecycle data.';
    }
  } catch (error) {
    const loaded = await window.financeAPI.loadState().catch(() => null);
    if (loaded?.status === 'normal') latestState = loaded.state;
    statusMessage = error?.message || 'That savings target could not be saved. The latest safe state is shown.';
  } finally {
    saving = false;
    replacePanel();
  }
}

function replacePanel() {
  const current = document.querySelector('[data-subscription-savings-panel]');
  if (!current || !latestState) return;
  current.replaceWith(buildPanel(latestState));
}

function fact(label, value) { const item = el('div', 'subscription-fact'); append(item, el('span', '', label), el('strong', '', value)); return item; }
function moneyRange(range) { if (!range) return 'Not known'; if (range.exact !== null && range.exact !== undefined) return money(range.exact); return `${money(range.min)}–${money(range.max)}`; }
function money(value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
function field(text, control) { const label = document.createElement('label'); label.append(document.createTextNode(text), control); return label; }
function button(text, className, type = 'button') { const control = el('button', className, text); control.type = type; return control; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); }
