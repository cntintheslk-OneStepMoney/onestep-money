import { formatCurrency, formatDate } from './finance-core.js';
import {
  buildPaydayAllocationPlan, PAYDAY_ALLOCATION_STATUS, PAYDAY_FUNDING_STATUS,
  setPaydayPlanningChoiceAccepted, setPaydayPlanningPreferences
} from './payday-allocation.js';

const STATUS = Object.freeze({
  [PAYDAY_ALLOCATION_STATUS.WAITING_FOR_INCOME]: ['Waiting for received income', ''],
  [PAYDAY_ALLOCATION_STATUS.READY]: ['Payday plan ready', 'green'],
  [PAYDAY_ALLOCATION_STATUS.BUDGET_SHORTFALL]: ['Budget gap is visible', 'amber'],
  [PAYDAY_ALLOCATION_STATUS.PROTECTED_SHORTFALL]: ['Protected needs exceed payday money', 'amber'],
  [PAYDAY_ALLOCATION_STATUS.NEEDS_REVIEW]: ['Review safety blockers', 'amber']
});
let queued = false;
let running = false;
let rerun = false;
let saving = false;

export function buildPaydayAllocationPresentationModel(plan) {
  return {
    status: plan?.status || PAYDAY_ALLOCATION_STATUS.NEEDS_REVIEW,
    income: plan?.income || null,
    horizonDate: plan?.horizonDate || null,
    availableForPlanning: Number(plan?.availableForPlanning || 0),
    protectedCommitments: plan?.protectedCommitments || emptyGroup(),
    requiredDebt: plan?.requiredDebt || emptyGroup(),
    buffer: plan?.buffer || { required: 0, funded: 0, shortfall: 0 },
    budget: plan?.budget || { required: 0, funded: 0, shortfall: 0, categories: [] },
    optionalDebt: plan?.optionalDebt || {}, optionalSavings: plan?.optionalSavings || {},
    leftoverUnallocated: Number(plan?.leftoverUnallocated || 0), warnings: plan?.warnings || [],
    preferences: plan?.preferences || {}, why: plan?.why || []
  };
}

function boot() {
  if (!window.financeAPI?.loadState) return;
  ensureHost();
  document.addEventListener('click', handleClick, true);
  document.addEventListener('submit', handleSubmit, true);
  document.addEventListener('change', (event) => {
    if (!document.getElementById('paydayAllocationPanel')?.contains(event.target)) window.setTimeout(scheduleRefresh, 120);
  }, true);
  window.addEventListener('focus', scheduleRefresh);
  observeRenders();
  scheduleRefresh();
}

function ensureHost() {
  if (document.getElementById('paydayAllocationPanel')) return;
  const view = document.getElementById('view-today');
  if (!view) return;
  const panel = document.createElement('section');
  panel.id = 'paydayAllocationPanel'; panel.className = 'panel'; panel.setAttribute('aria-labelledby', 'paydayAllocationTitle');
  panel.innerHTML = [
    '<div class="panel-heading"><div><p class="eyebrow">PAYDAY ALLOCATION</p><h2 id="paydayAllocationTitle">Protect the important money first</h2><p class="muted">A local plan for money already received. It never moves money or makes payments.</p></div><span id="paydayAllocationBadge" class="badge">Loading</span></div>',
    '<div id="paydayAllocationMetrics" class="metric-grid three"></div>',
    '<div id="paydayAllocationWarnings"></div><div id="paydayAllocationSteps" class="compact-card-list"></div>',
    '<details class="plan-why"><summary>Why?</summary><ul id="paydayAllocationWhy"></ul></details>',
    '<form id="paydayAllocationPreferences" class="form-grid" novalidate><h3>Planning preferences</h3>',
    '<label>Flexible Budget allowance · optional override<input id="paydayFlexibleAllowance" type="number" min="0" step="0.01" inputmode="decimal" /></label>',
    '<label>Safe optional priority debt<select id="paydayOptionalDebt"><option value="">Use current safe recommendation</option></select></label>',
    '<label class="confirmation-check"><input id="paydayDeclineOptionalDebt" type="checkbox" />Do not include an optional debt overpayment</label>',
    '<label>Optional savings target<input id="paydayOptionalSavings" type="number" min="0" step="0.01" inputmode="decimal" /></label>',
    '<div class="button-row"><button class="primary-button" type="submit">Save planning preferences</button><button id="paydayOpenBufferSettings" class="secondary-button" type="button">Adjust buffer in Settings</button></div>',
    '<p id="paydayAllocationPreferenceStatus" class="muted" role="status" aria-live="polite"></p></form>'
  ].join('');
  const existing = document.getElementById('paydayTodayPanel');
  if (existing?.parentElement === view) existing.after(panel);
  else { const metrics = view.querySelector('.metric-grid'); if (metrics) metrics.before(panel); else view.prepend(panel); }
}

function observeRenders() {
  for (const id of ['view-today', 'todaySupportingList', 'cashFlowValue']) {
    const target = document.getElementById(id); if (!target) continue;
    new MutationObserver(scheduleRefresh).observe(target, { attributes: true, childList: true, characterData: true, subtree: id !== 'view-today' });
  }
}

function handleClick(event) {
  if (event.target.closest('#paydayOpenBufferSettings')) { document.querySelector('.nav-button[data-view="settings"]')?.click(); return; }
  const choice = event.target.closest('[data-payday-choice]');
  if (choice) { saveChoice(choice.dataset.paydayChoice, choice.getAttribute('aria-pressed') !== 'true'); return; }
  if (event.target.closest('.nav-button, [data-view-target], [data-add], [data-edit], [data-review-route], #saveSettingsButton, #saveEditButton, #confirmImportButton')) window.setTimeout(scheduleRefresh, 120);
}
function handleSubmit(event) { if (event.target?.id === 'paydayAllocationPreferences') { event.preventDefault(); savePreferences(); } }
function scheduleRefresh() { if (queued || saving) return; queued = true; window.setTimeout(() => { queued = false; refresh(); }, 50); }

async function refresh() {
  if (running) { rerun = true; return; }
  running = true;
  try {
    ensureHost();
    const loaded = await window.financeAPI.loadState();
    if (loaded?.status !== 'normal' || !loaded.state) return renderUnavailable('Payday planning is unavailable while financial data is not in normal mode.');
    render(buildPaydayAllocationPresentationModel(buildPaydayAllocationPlan(loaded.state)));
  } catch { renderUnavailable('The payday allocation plan could not be calculated. No financial data, transfer or payment was changed.'); }
  finally { running = false; if (rerun) { rerun = false; scheduleRefresh(); } }
}

function render(model) {
  const [label, tone] = STATUS[model.status] || STATUS[PAYDAY_ALLOCATION_STATUS.NEEDS_REVIEW];
  const badge = byId('paydayAllocationBadge'); badge.textContent = label; badge.className = `badge ${tone}`.trim();
  replace(byId('paydayAllocationMetrics'),
    metric('Received', model.income ? money(model.income.amountReceived) : 'Not received', model.income?.name || 'Future income is not current cash'),
    metric('Available to plan', money(model.availableForPlanning), model.horizonDate ? `Through ${safeDate(model.horizonDate)}` : 'Planning horizon needs review'),
    metric('Budget gap', money(model.budget.shortfall), model.budget.shortfall > 0 ? 'Visible; no assumed borrowing' : 'Active Budget currently covered'));

  const warnings = byId('paydayAllocationWarnings'); replace(warnings);
  for (const item of model.warnings) warnings.append(messageCard(item.code === 'budget_shortfall' ? 'Budget gap' : 'Needs review', item.explanation));

  const steps = byId('paydayAllocationSteps'); replace(steps,
    groupCard('1 · MUST PROTECT', 'Known commitments', model.protectedCommitments),
    groupCard('2 · MUST PROTECT', 'Required debt payments', model.requiredDebt),
    simpleCard('3 · MUST PROTECT', 'Starter / emergency buffer', model.buffer.required, model.buffer.funded, model.buffer.fundingStatus, model.buffer.reason),
    budgetCard(model.budget), optionalDebtCard(model.optionalDebt), optionalSavingsCard(model.optionalSavings),
    simpleCard('UNALLOCATED', 'Left unallocated', model.leftoverUnallocated, model.leftoverUnallocated, PAYDAY_FUNDING_STATUS.FUNDED, 'Unassigned money stays unassigned.'));

  const why = byId('paydayAllocationWhy'); replace(why); for (const item of model.why) why.append(listItem(item));
  populatePreferences(model); renderDashboard(model);
}

function groupCard(eyebrow, title, group) {
  const card = shell(eyebrow, title, group.fundingStatus); const list = document.createElement('div'); list.className = 'dashboard-list';
  if (!group.items.length) list.append(muted('Nothing separate is recorded for this step.'));
  for (const item of group.items) list.append(row(item.name, item.required, item.funded, item.fundingStatus, item.date ? `Due ${safeDate(item.date)}` : 'Protected'));
  card.append(list, totals(group.required, group.funded, group.shortfall)); return card;
}
function budgetCard(budget) {
  const card = shell('4 · RECOMMENDED', 'Cover the active Budget', budget.shortfall > 0 ? PAYDAY_FUNDING_STATUS.PARTIALLY_FUNDED : PAYDAY_FUNDING_STATUS.FUNDED);
  card.append(muted(budget.userOverride ? `Saved flexible allowance: ${money(budget.requestedFlexibleAllowance)}. The complete Budget remains visible.` : 'Every active Budget category remains visible; short funding is shared proportionally.'));
  const list = document.createElement('div'); list.className = 'dashboard-list';
  if (!budget.categories.length) list.append(muted('No active Budget categories are recorded.'));
  for (const item of budget.categories) { const itemRow = row(item.name, item.required, item.funded, item.fundingStatus, item.section || 'Budget'); itemRow.append(choiceButton(item.choiceId, item.accepted)); list.append(itemRow); }
  card.append(list, totals(budget.required, budget.funded, budget.shortfall));
  if (budget.shortfall > 0) card.append(muted(`${money(budget.shortfall)} remains uncovered. A later income can be reconsidered only after it is received.`));
  return card;
}
function optionalDebtCard(item) {
  const card = shell('5 · OPTIONAL', 'Additional debt payment', item.funded > 0 ? PAYDAY_FUNDING_STATUS.FUNDED : PAYDAY_FUNDING_STATUS.UNFUNDED);
  card.append(muted(item.reason || 'No optional debt allocation is recommended.'));
  if (item.debtId) card.append(row(item.name, item.maximumSafeAmount || 0, item.funded || 0, item.fundingStatus, 'Safety ceiling, not a required payment'));
  card.append(choiceButton(item.choiceId || 'optional-debt', item.accepted)); return card;
}
function optionalSavingsCard(item) {
  const card = shell('6 · OPTIONAL', 'Savings / discretionary allocation', item.fundingStatus);
  card.append(row(item.name || 'Optional savings', item.target || 0, item.funded || 0, item.fundingStatus, item.reason || 'No target set.'));
  card.append(choiceButton(item.choiceId || 'optional-savings', item.accepted)); return card;
}
function simpleCard(eyebrow, title, required, funded, status, detail) { const card = shell(eyebrow, title, status); card.append(row(title, required, funded, status, detail || '')); return card; }

function shell(eyebrow, title, status) {
  const card = document.createElement('article'); card.className = 'review-card';
  const heading = document.createElement('div'); heading.className = 'review-card-heading';
  const copy = document.createElement('div'); const e = document.createElement('p'); e.className = 'eyebrow'; e.textContent = eyebrow;
  const h = document.createElement('h3'); h.textContent = title; copy.append(e, h); heading.append(copy, statusBadge(status)); card.append(heading); return card;
}
function row(name, required, funded, status, detail) {
  const out = document.createElement('div'); out.className = 'dashboard-list-row horizontal'; const copy = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = name; const small = document.createElement('span'); small.textContent = `${fundingLabel(status)}${detail ? ` · ${detail}` : ''}`;
  const amount = document.createElement('strong'); amount.textContent = required > 0 ? `${money(funded)} / ${money(required)}` : money(funded); copy.append(strong, small); out.append(copy, amount); return out;
}
function totals(required, funded, shortfall) { return muted(`${money(funded)} covered of ${money(required)}${shortfall > 0 ? ` · ${money(shortfall)} short` : ''}`); }
function statusBadge(status) { const node = document.createElement('span'); node.className = `badge ${status === PAYDAY_FUNDING_STATUS.FUNDED ? 'green' : status === PAYDAY_FUNDING_STATUS.PARTIALLY_FUNDED || status === PAYDAY_FUNDING_STATUS.NEEDS_REVIEW ? 'amber' : ''}`.trim(); node.textContent = fundingLabel(status); return node; }
function choiceButton(id, accepted) { const button = document.createElement('button'); button.type = 'button'; button.className = 'text-button'; button.dataset.paydayChoice = id; button.setAttribute('aria-pressed', String(Boolean(accepted))); button.textContent = accepted ? 'Accepted in plan' : 'Accept in plan'; return button; }

function populatePreferences(model) {
  byId('paydayFlexibleAllowance').value = model.preferences.flexibleAllowance ?? '';
  const debt = byId('paydayOptionalDebt'); replace(debt, option('', 'Use current safe recommendation'));
  for (const item of model.optionalDebt.options || []) debt.append(option(item.id, `${item.name} · ${money(item.balance)}`));
  debt.value = [...debt.options].some((item) => item.value === model.preferences.optionalDebtId) ? model.preferences.optionalDebtId : '';
  byId('paydayDeclineOptionalDebt').checked = model.preferences.optionalDebtDeclined === true;
  byId('paydayOptionalSavings').value = model.preferences.optionalSavingsTarget || '';
}

async function savePreferences() {
  await savePlanningState((state) => setPaydayPlanningPreferences(state, {
    flexibleAllowance: inputMoney('paydayFlexibleAllowance', null), optionalDebtId: byId('paydayOptionalDebt').value,
    optionalDebtDeclined: byId('paydayDeclineOptionalDebt').checked, optionalSavingsTarget: inputMoney('paydayOptionalSavings', 0)
  }), 'Planning preferences saved.');
}
async function saveChoice(id, accepted) { await savePlanningState((state) => setPaydayPlanningChoiceAccepted(state, id, accepted), accepted ? 'Planning choice accepted.' : 'Planning choice removed.'); }
async function savePlanningState(update, success) {
  if (saving) return; saving = true; const status = byId('paydayAllocationPreferenceStatus'); status.textContent = 'Saving…';
  try {
    const loaded = await window.financeAPI.loadState(); if (loaded?.status !== 'normal' || !loaded.state) throw new Error('Financial data is not available for editing.');
    const saved = await window.financeAPI.saveState(update(loaded.state));
    if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while recovery is required.');
    if (saved?.status === 'conflict') { status.textContent = 'Your data changed at the same time. Nothing was overwritten; try again.'; return; }
    status.textContent = success; window.location.reload();
  } catch (error) { status.textContent = error?.message || 'The planning preference could not be saved.'; }
  finally { saving = false; }
}

function renderDashboard(model) {
  const host = document.querySelector('[data-dashboard-module="upcoming"]'); if (!host) return;
  let item = byId('dashboardPaydayAllocation'); if (!item) { item = document.createElement('div'); item.id = 'dashboardPaydayAllocation'; item.className = 'dashboard-list-row horizontal'; host.append(item); }
  replace(item); const label = document.createElement('span'); label.textContent = model.income ? 'Payday plan' : 'Payday planning'; const value = document.createElement('strong');
  value.textContent = model.status === PAYDAY_ALLOCATION_STATUS.READY ? `${money(model.leftoverUnallocated)} unallocated`
    : model.status === PAYDAY_ALLOCATION_STATUS.WAITING_FOR_INCOME ? 'Waiting for income'
      : model.budget.shortfall > 0 ? `${money(model.budget.shortfall)} Budget gap` : 'Needs review'; item.append(label, value);
}
function renderUnavailable(message) { ensureHost(); replace(byId('paydayAllocationWarnings'), messageCard('Payday plan unavailable', message)); }
function messageCard(title, text) { const card = document.createElement('article'); card.className = 'check-card warning'; const strong = document.createElement('strong'); strong.textContent = title; const p = document.createElement('p'); p.textContent = text; card.append(strong, p); return card; }
function metric(label, value, hint) { const card = document.createElement('article'); card.className = 'metric-card'; const a = document.createElement('span'); a.textContent = label; const b = document.createElement('strong'); b.textContent = value; const c = document.createElement('small'); c.textContent = hint; card.append(a, b, c); return card; }
function fundingLabel(status) { return ({ funded: 'Funded', partially_funded: 'Partially funded', unfunded: 'Unfunded', needs_review: 'Needs review' })[status] || 'Needs review'; }
function safeDate(value) { try { return formatDate(value); } catch { return String(value || 'Unknown date'); } }
function money(value) { return Number.isFinite(Number(value)) ? formatCurrency(Number(value)) : 'Unavailable'; }
function inputMoney(id, fallback) { const value = byId(id).value; return value === '' ? fallback : Math.max(0, Number(value) || 0); }
function option(value, label) { const node = document.createElement('option'); node.value = value; node.textContent = label; return node; }
function muted(text) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = text; return p; }
function listItem(text) { const li = document.createElement('li'); li.textContent = text; return li; }
function emptyGroup() { return { required: 0, funded: 0, shortfall: 0, fundingStatus: PAYDAY_FUNDING_STATUS.FUNDED, items: [] }; }
function byId(id) { return document.getElementById(id); }
function replace(node, ...children) { if (node) node.replaceChildren(...children); }

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot();
