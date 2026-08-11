import {
  AUTOMATION_HISTORY_FILTER, automationHistoryEntries, automationHistoryPresentation,
  undoAutomationHistoryEntry
} from './automation-history.js';

let state = null;
let filter = AUTOMATION_HISTORY_FILTER.ALL;
let refreshRunning = false;
let refreshQueued = false;
let statusMessage = '';

function boot() {
  if (!window.financeAPI?.loadState) return;
  ensureHost();
  document.addEventListener('click', handleClick, true);
  observeApp();
  scheduleRefresh();
}

function ensureHost() {
  if (document.getElementById('automationHistorySettings')) return;
  const grid = document.querySelector('#view-settings .settings-grid');
  if (!grid) return;
  const panel = document.createElement('article');
  panel.id = 'automationHistorySettings';
  panel.className = 'panel';
  panel.setAttribute('aria-labelledby', 'automationHistoryTitle');
  panel.innerHTML = [
    '<div class="panel-heading"><div><p class="eyebrow">LOCAL AUTOMATION HISTORY</p><h2 id="automationHistoryTitle">What OneStep changed</h2>',
    '<p class="muted">See what local automations did, why they did it, and safely undo eligible changes. History stays on this device.</p></div></div>',
    '<div id="automationHistoryFilters" class="button-row" role="group" aria-label="Automation history filter"></div>',
    '<div id="automationHistoryList" class="compact-card-list"></div>',
    '<p id="automationHistoryStatus" class="muted" role="status" aria-live="polite"></p>'
  ].join('');
  grid.append(panel);
}

function observeApp() {
  const shell = document.getElementById('appShell');
  const settings = document.getElementById('view-settings');
  for (const target of [shell, settings].filter(Boolean)) {
    const observer = new MutationObserver(() => {
      ensureHost();
      scheduleRefresh();
    });
    observer.observe(target, { attributes: true, childList: true, subtree: target === settings });
  }
}

function scheduleRefresh() {
  if (refreshRunning) {
    refreshQueued = true;
    return;
  }
  refreshRunning = true;
  queueMicrotask(refresh);
}

async function refresh() {
  try {
    ensureHost();
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) return;
    state = loaded.state;
    render();
  } catch {
    setStatus('Automation history could not be refreshed. No financial information was changed.');
  } finally {
    refreshRunning = false;
    if (refreshQueued) {
      refreshQueued = false;
      scheduleRefresh();
    }
  }
}

function render() {
  ensureHost();
  const panel = document.getElementById('automationHistorySettings');
  if (!panel || !state) return;
  renderFilters();
  const list = document.getElementById('automationHistoryList');
  list.replaceChildren();

  const entries = automationHistoryEntries(state, filter);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = filter === AUTOMATION_HISTORY_FILTER.ALL
      ? 'No automation history yet. Safe local automation outcomes will appear here.'
      : 'No history items match this filter.';
    list.append(empty);
  }

  for (const entry of entries) {
    const presentation = automationHistoryPresentation(state, entry);
    if (!presentation) continue;
    list.append(historyCard(entry, presentation));
  }
  setStatus(statusMessage);
}

function renderFilters() {
  const container = document.getElementById('automationHistoryFilters');
  if (!container) return;
  container.replaceChildren();
  const options = [
    [AUTOMATION_HISTORY_FILTER.ALL, 'All'],
    [AUTOMATION_HISTORY_FILTER.APPLIED, 'Applied'],
    [AUTOMATION_HISTORY_FILTER.NEEDS_REVIEW, 'Needs review'],
    [AUTOMATION_HISTORY_FILTER.BLOCKED, 'Blocked'],
    [AUTOMATION_HISTORY_FILTER.UNDONE, 'Undone']
  ];
  for (const [value, label] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = value === filter ? 'secondary-button active' : 'secondary-button';
    button.dataset.automationHistoryFilter = value;
    button.setAttribute('aria-pressed', String(value === filter));
    button.textContent = label;
    container.append(button);
  }
}

function historyCard(entry, presentation) {
  const card = document.createElement('article');
  card.className = 'review-card';

  const heading = document.createElement('div');
  heading.className = 'review-card-heading';
  const copy = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = presentation.summary;
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent = [formatHistoryDate(presentation.timestamp), presentation.sourceLabel, presentation.ruleLabel].filter(Boolean).join(' · ');
  copy.append(title, meta);
  const badge = document.createElement('span');
  badge.className = `badge${entry.result === 'blocked' || entry.result === 'needs_review' ? ' red' : ''}`;
  badge.textContent = presentation.statusLabel;
  heading.append(copy, badge);
  card.append(heading);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Why?';
  const why = document.createElement('p');
  why.className = 'muted';
  why.textContent = presentation.why;
  details.append(summary, why);
  card.append(details);

  const actions = document.createElement('div');
  actions.className = 'button-row';
  if (presentation.undo.available) {
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'secondary-button';
    undo.dataset.automationHistoryUndo = entry.id;
    undo.textContent = 'Undo';
    actions.append(undo);
  } else if (entry.undoStatus === 'available' || ['newer_change', 'source_missing', 'stale_revision'].includes(presentation.undo.reasonCode)) {
    const unavailable = document.createElement('span');
    unavailable.className = 'muted';
    unavailable.textContent = presentation.undo.message;
    actions.append(unavailable);
    const review = document.createElement('button');
    review.type = 'button';
    review.className = 'secondary-button';
    review.dataset.automationHistoryReview = entry.sourceType;
    review.textContent = entry.sourceType === 'transaction' ? 'Review payment' : 'Open Review Inbox';
    actions.append(review);
  }
  if (actions.childNodes.length) card.append(actions);
  return card;
}

async function handleClick(event) {
  const filterButton = event.target.closest('[data-automation-history-filter]');
  if (filterButton) {
    filter = filterButton.dataset.automationHistoryFilter;
    render();
    return;
  }

  const undoButton = event.target.closest('[data-automation-history-undo]');
  if (undoButton) {
    await performUndo(undoButton.dataset.automationHistoryUndo, undoButton);
    return;
  }

  const reviewButton = event.target.closest('[data-automation-history-review]');
  if (reviewButton) {
    const view = reviewButton.dataset.automationHistoryReview === 'transaction' ? 'transactions' : 'review';
    document.querySelector(`.nav-button[data-view="${view}"]`)?.click();
  }
}

async function performUndo(historyId, button) {
  if (!state || button.disabled) return;
  button.disabled = true;
  setStatus('Checking that the automated change is still safe to undo…');
  try {
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) throw new Error('The latest local state is unavailable.');
    state = loaded.state;
    const result = undoAutomationHistoryEntry(state, historyId, {
      expectedRevision: state.meta?.revision,
      now: new Date()
    });
    if (result.status !== 'undone') {
      state = result.state;
      statusMessage = result.message;
      render();
      return;
    }
    const saved = await window.financeAPI.saveState(result.state);
    if (saved?.status === 'conflict') {
      state = saved.state;
      statusMessage = saved.message || 'Your financial information changed. Review the latest state before trying Undo again.';
      render();
      return;
    }
    if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while data recovery protections are active.');
    state = saved;
    statusMessage = result.message;
    render();
  } catch (error) {
    statusMessage = error?.message || 'Undo could not be completed safely. Nothing was changed.';
    setStatus(statusMessage);
    scheduleRefresh();
  } finally {
    button.disabled = false;
  }
}

function setStatus(message) {
  statusMessage = message || '';
  const output = document.getElementById('automationHistoryStatus');
  if (output) output.textContent = statusMessage;
}

function formatHistoryDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Date unavailable';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
