import {
  SUBSCRIPTION_PROTECTION,
  SUBSCRIPTION_SOURCE,
  confirmSubscriptionCandidate,
  createManualSubscription,
  editSubscription,
  rejectSubscriptionCandidate,
  removeSubscription,
  setSubscriptionProtection,
  updateSubscriptionRanking
} from './subscription-model.js';
import {
  SUBSCRIPTION_FILTER,
  SUBSCRIPTION_SORT,
  buildSubscriptionsPresentation
} from './subscriptions-presentation.js';

let latestState = null;
let currentFilter = SUBSCRIPTION_FILTER.ALL;
let currentSort = SUBSCRIPTION_SORT.RANK_HIGH;
let draggedSubscriptionId = '';
let lastStatus = '';
let saving = false;
let booted = false;
let shellNavigationBound = false;

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => { bootSubscriptionsUI().catch(() => {}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else queueMicrotask(start);
}

export async function bootSubscriptionsUI() {
  if (booted || !window.financeAPI?.loadState) return;
  booted = true;
  ensureStylesheet();
  const loaded = await window.financeAPI.loadState();
  if (loaded?.status !== 'normal') return;
  latestState = loaded.state;
  ensureShell();
  renderSubscriptionsUI();
}

export function buildSubscriptionRankingOrder(state = latestState) {
  if (!state) return [];
  return buildSubscriptionsPresentation(state, { filter: SUBSCRIPTION_FILTER.ACTIVE, sort: SUBSCRIPTION_SORT.RANK_HIGH })
    .activeRows.filter((row) => row.rank !== null).map((row) => row.id);
}

function ensureStylesheet() {
  if (document.getElementById('subscriptionsStylesheet')) return;
  const link = document.createElement('link');
  link.id = 'subscriptionsStylesheet'; link.rel = 'stylesheet'; link.href = 'subscriptions.css';
  document.head.append(link);
}

function ensureShell() {
  const nav = document.querySelector('.sidebar nav');
  const main = document.querySelector('.main-content');
  if (!nav || !main) return;
  let button = document.querySelector('.subscriptions-nav-button[data-view="subscriptions"]');
  if (!button) {
    button = document.createElement('button');
    button.type = 'button'; button.className = 'subscriptions-nav-button'; button.dataset.view = 'subscriptions';
    button.setAttribute('aria-label', 'Subscriptions');
    const icon = document.createElement('span'); icon.className = 'subscriptions-nav-icon'; icon.setAttribute('aria-hidden', 'true'); icon.textContent = '↻';
    const label = document.createElement('span'); label.className = 'nav-label'; label.textContent = 'Subscriptions';
    button.append(icon, label);
    const guide = nav.querySelector('[data-view="guide"]');
    nav.insertBefore(button, guide || nav.lastElementChild);
    button.addEventListener('click', openSubscriptionsView);
  }
  bindShellNavigation(button);

  let view = document.getElementById('view-subscriptions');
  if (!view) {
    view = document.createElement('section');
    view.id = 'view-subscriptions'; view.className = 'view subscriptions-view'; view.hidden = true;
    view.setAttribute('aria-labelledby', 'viewTitle');
    const guide = document.getElementById('view-guide');
    main.insertBefore(view, guide || null);
    view.addEventListener('click', handleSubscriptionClick);
    view.addEventListener('change', handleSubscriptionChange);
    view.addEventListener('submit', handleSubscriptionSubmit);
    view.addEventListener('dragstart', handleDragStart);
    view.addEventListener('dragover', handleDragOver);
    view.addEventListener('drop', handleDrop);
  }
}

function bindShellNavigation(button) {
  if (shellNavigationBound) return;
  shellNavigationBound = true;
  document.addEventListener('click', (event) => {
    if (event.target.closest('.nav-button,[data-view-target]')) button.classList.remove('active');
  }, true);
  const view = document.getElementById('view-subscriptions');
  if (view) new MutationObserver(() => {
    if (view.hidden || !view.classList.contains('active')) button.classList.remove('active');
  }).observe(view, { attributes: true, attributeFilter: ['hidden', 'class'] });
}

async function openSubscriptionsView() {
  const loaded = await window.financeAPI.loadState().catch(() => null);
  if (loaded?.status === 'normal') latestState = loaded.state;
  document.querySelectorAll('.nav-button').forEach((button) => button.classList.remove('active'));
  document.querySelector('.subscriptions-nav-button[data-view="subscriptions"]')?.classList.add('active');
  document.querySelectorAll('.view').forEach((view) => {
    const active = view.id === 'view-subscriptions';
    view.classList.toggle('active', active); view.hidden = !active;
  });
  const eyebrow = document.getElementById('viewEyebrow'); const title = document.getElementById('viewTitle');
  if (eyebrow) eyebrow.textContent = 'RECURRING SPEND, MADE CLEAR';
  if (title) title.textContent = 'Subscriptions';
  renderSubscriptionsUI();
}

function renderSubscriptionsUI() {
  const view = document.getElementById('view-subscriptions');
  if (!view || !latestState) return;
  const all = buildSubscriptionsPresentation(latestState);
  const visible = buildSubscriptionsPresentation(latestState, { filter: currentFilter, sort: currentSort });
  view.replaceChildren();

  const intro = el('div', 'subscriptions-heading');
  const copy = el('div');
  append(copy, el('p', 'eyebrow', 'SUBSCRIPTIONS'), el('h2', '', 'Know the real recurring cost'), el('p', 'muted', 'Confirmed subscriptions stay separate from detected evidence. Rank what matters to you; protection choices remain independent from rank.'));
  append(intro, copy, manualSubscriptionForm()); view.append(intro);

  const summary = el('div', 'subscriptions-summary');
  summary.append(
    metric('Active subscriptions', String(all.summary.activeCount), `${all.summary.reviewCount} ${all.summary.reviewCount === 1 ? 'candidate' : 'candidates'} to review`),
    metric('Monthly equivalent', moneyRange(all.summary.monthly), all.summary.monthly.variable ? 'Variable costs shown as a range' : 'Confirmed active subscriptions'),
    metric('Annual equivalent', moneyRange(all.summary.annual), 'Uses the authoritative cadence normalisation'),
    metric('Potential savings', all.summary.potentialSavings === null ? 'Not calculated yet' : moneyRange(all.summary.potentialSavings), 'Savings recommendations arrive in the dedicated recommendation brief')
  );
  view.append(summary);

  const toolbar = el('div', 'subscriptions-toolbar');
  toolbar.append(selectField('Show', 'subscriptionFilter', [
    ['all', 'All known'], ['active', 'Active'], ['review', 'Needs confirmation'], ['unranked', 'Unranked'], ['protected', 'Keep / Essential / Excluded']
  ], currentFilter), selectField('Sort', 'subscriptionSort', [
    ['rank-high', 'Highest value first'], ['rank-low', 'Lowest value first'], ['cost-high', 'Highest monthly cost'], ['cost-low', 'Lowest monthly cost'], ['upcoming', 'Next payment'], ['name', 'Name']
  ], currentSort));
  const status = el('p', 'subscriptions-status muted', lastStatus); status.id = 'subscriptionStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  toolbar.append(status); view.append(toolbar);

  if (visible.activeRows.length) {
    const section = sectionHeading('Your subscriptions', 'Rank is your personal value order. Drag ranked cards directly or use the Move up/down buttons for a keyboard-accessible alternative.');
    const list = el('div', 'subscriptions-list'); list.id = 'activeSubscriptionList';
    for (const row of visible.activeRows) list.append(activeCard(row, all));
    section.append(list); view.append(section);
  }

  if (visible.candidateRows.length) {
    const section = sectionHeading('Needs your confirmation', 'Recurring evidence is not treated as a confirmed subscription until you say so.');
    const list = el('div', 'subscriptions-list candidates');
    for (const row of visible.candidateRows) list.append(candidateCard(row));
    section.append(list); view.append(section);
  }

  if (!visible.rows.length) {
    const empty = el('article', 'panel subscriptions-empty');
    append(empty, el('h2', '', currentFilter === 'all' ? 'No subscriptions found yet' : 'Nothing matches this view'), el('p', 'muted', currentFilter === 'all'
      ? 'Add a subscription manually or import enough payment history for OneStep to identify recurring evidence.'
      : 'Change the filter to see the rest of your subscription information.'));
    view.append(empty);
  }
}

function activeCard(row, allPresentation) {
  const card = el('article', 'subscription-card');
  card.dataset.subscriptionId = row.id; card.draggable = true;
  const heading = el('div', 'subscription-card-heading');
  const copy = el('div'); append(copy, el('div', 'subscription-title-line', '', [rankBadge(row), el('strong', '', row.providerName)]), el('span', 'muted', `${row.statusLabel} · ${titleCase(row.cadence)}`));
  const amount = el('div', 'subscription-cost'); append(amount, el('strong', '', moneyRange(row.cost?.monthly)), el('span', 'muted', 'per month equivalent'));
  append(heading, copy, amount); card.append(heading);
  const facts = el('div', 'subscription-facts');
  facts.append(fact('Charge', chargeLabel(row)), fact('Annual', moneyRange(row.cost?.annual)), fact('Next', paymentLabel(row.expectedNextPayment)), fact('Account', row.accountName));
  card.append(facts);
  const controls = el('div', 'subscription-controls'); controls.append(rankingControls(row, allPresentation), protectionControl(row)); card.append(controls);
  const details = document.createElement('details'); details.className = 'subscription-details';
  const summary = document.createElement('summary'); summary.textContent = 'Details and notes'; details.append(summary, editForm(row)); card.append(details);
  return card;
}

function candidateCard(row) {
  const card = el('article', 'subscription-card candidate'); card.dataset.candidateId = row.candidateId;
  const heading = el('div', 'subscription-card-heading');
  const copy = el('div'); append(copy, el('strong', '', row.providerName), el('span', 'muted', row.statusLabel));
  const amount = el('div', 'subscription-cost'); append(amount, el('strong', '', moneyRange(row.cost?.monthly)), el('span', 'muted', 'monthly evidence'));
  append(heading, copy, amount); card.append(heading);
  const facts = el('div', 'subscription-facts'); facts.append(fact('Charge', chargeLabel(row)), fact('Annual', moneyRange(row.cost?.annual)), fact('Next', paymentLabel(row.expectedNextPayment)), fact('Account', row.accountName)); card.append(facts);
  if (row.evidenceChanged) card.append(el('p', 'subscription-notice', 'The recurring evidence changed since your previous decision, so OneStep is asking again.'));
  const actions = el('div', 'inline-actions'); actions.append(button('Confirm subscription', 'primary-button', { candidateConfirm: row.candidateId }), button('Not a subscription', 'secondary-button', { candidateReject: row.candidateId })); card.append(actions);
  const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Why OneStep noticed this'; details.append(summary, el('p', 'muted', row.why || 'Repeated outgoing activity matched the existing recurring-payment evidence rules.')); card.append(details);
  return card;
}

function rankingControls(row, allPresentation) {
  const group = el('div', 'subscription-ranking-controls'); group.setAttribute('aria-label', `Value ranking for ${row.providerName}`);
  const ranked = allPresentation.activeRows.filter((item) => item.rank !== null).sort((a, b) => a.rank - b.rank);
  if (row.rank === null) { group.append(button('Add to ranking', 'secondary-button compact', { rankAdd: row.id })); return group; }
  const index = ranked.findIndex((item) => item.id === row.id);
  const label = el('span', 'rank-label', `Value rank #${row.rank}`);
  const up = button('Move up', 'secondary-button compact', { rankMove: 'up', subscriptionId: row.id }); up.disabled = index <= 0;
  const down = button('Move down', 'secondary-button compact', { rankMove: 'down', subscriptionId: row.id }); down.disabled = index < 0 || index >= ranked.length - 1;
  group.append(label, up, down, button('Unrank', 'text-button', { rankRemove: row.id }));
  return group;
}

function protectionControl(row) {
  const label = el('label', 'subscription-protection'); label.append(document.createTextNode('Protection'));
  const select = document.createElement('select'); select.dataset.subscriptionProtection = row.id; select.setAttribute('aria-label', `Protection state for ${row.providerName}`);
  for (const [value, text] of [['none','None'],['keep','Keep'],['essential','Essential'],['excluded','Excluded']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; option.selected = row.protectionState === value; select.append(option);
  }
  label.append(select); return label;
}

function editForm(row) {
  const form = el('form', 'subscription-edit-form'); form.dataset.subscriptionEdit = row.id;
  form.append(field('Provider / service', input('providerName', row.providerName, 'text', true)));
  form.append(field('Minimum charge', input('amountMin', row.amountRange?.min ?? '', 'number', true, { min: '0', step: '0.01' })));
  form.append(field('Maximum charge', input('amountMax', row.amountRange?.max ?? '', 'number', true, { min: '0', step: '0.01' })));
  form.append(field('Billing frequency', select('cadence', [['weekly','Weekly'],['fortnightly','Fortnightly'],['four-weekly','Four-weekly'],['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']], row.cadence)));
  form.append(field('Next expected payment', input('nextPaymentDate', row.expectedNextPayment?.date || '', 'date', false)));
  const notes = document.createElement('textarea'); notes.name = 'notes'; notes.rows = 3; notes.value = row.notes; form.append(field('Notes', notes, 'wide'));
  const provenance = el('p', 'muted wide', row.source === SUBSCRIPTION_SOURCE.MANUAL ? 'Source: added manually.' : `Source: recurring-payment evidence${row.sourcePatternId ? ` · pattern ${row.sourcePatternId}` : ''}.`); form.append(provenance);
  const future = el('p', 'muted wide', row.cancellationMetadataRef ? 'Cancellation guidance is linked to this record.' : 'Cancellation guidance is not attached yet. #130 owns provider routing; this view will use it when available.'); form.append(future);
  const actions = el('div', 'button-row wide'); actions.append(button('Save details', 'primary-button', { submitOnly: 'true' }, 'submit'), button(row.source === SUBSCRIPTION_SOURCE.MANUAL ? 'Remove' : 'Hide', 'danger-button', { subscriptionRemove: row.id })); form.append(actions);
  return form;
}

function manualSubscriptionForm() {
  const details = document.createElement('details'); details.className = 'subscriptions-add';
  const summary = document.createElement('summary'); summary.className = 'secondary-button'; summary.textContent = 'Add subscription'; details.append(summary);
  const form = el('form', 'subscription-add-form'); form.id = 'manualSubscriptionForm';
  form.append(field('Provider / service', input('providerName', '', 'text', true)));
  form.append(field('Amount', input('amount', '', 'number', true, { min: '0', step: '0.01' })));
  form.append(field('Billing frequency', select('cadence', [['weekly','Weekly'],['fortnightly','Fortnightly'],['four-weekly','Four-weekly'],['monthly','Monthly'],['quarterly','Quarterly'],['annual','Annual']], 'monthly')));
  form.append(field('Next expected payment', input('nextPaymentDate', '', 'date', false)));
  const accountOptions = [['', 'Account not recorded'], ...(latestState?.accounts || []).map((account) => [account.id, account.name || account.institution || 'Recorded account'])];
  form.append(field('Payment account', select('accountId', accountOptions, '')));
  form.append(field('Protection', select('protectionState', [['none','None'],['keep','Keep'],['essential','Essential'],['excluded','Excluded']], 'none')));
  const notes = document.createElement('textarea'); notes.name = 'notes'; notes.rows = 3; form.append(field('Notes', notes, 'wide'));
  const save = button('Add subscription', 'primary-button wide', {}, 'submit'); form.append(save); details.append(form); return details;
}

async function handleSubscriptionClick(event) {
  const confirm = event.target.closest('[data-candidate-confirm]');
  const reject = event.target.closest('[data-candidate-reject]');
  const add = event.target.closest('[data-rank-add]');
  const move = event.target.closest('[data-rank-move]');
  const removeRank = event.target.closest('[data-rank-remove]');
  const remove = event.target.closest('[data-subscription-remove]');
  if (confirm) return persistChange((state) => confirmSubscriptionCandidate(state, confirm.dataset.candidateConfirm), 'Subscription confirmed.');
  if (reject) return persistChange((state) => rejectSubscriptionCandidate(state, reject.dataset.candidateReject), 'Candidate rejected. Unchanged evidence will stay suppressed.');
  if (add) { const order = buildSubscriptionRankingOrder(); order.push(add.dataset.rankAdd); return persistChange((state) => updateSubscriptionRanking(state, order), 'Added to your value ranking.'); }
  if (move) {
    const order = buildSubscriptionRankingOrder(); const id = move.dataset.subscriptionId; const index = order.indexOf(id); const target = move.dataset.rankMove === 'up' ? index - 1 : index + 1;
    if (index >= 0 && target >= 0 && target < order.length) [order[index], order[target]] = [order[target], order[index]];
    return persistChange((state) => updateSubscriptionRanking(state, order), 'Value ranking updated.');
  }
  if (removeRank) { const order = buildSubscriptionRankingOrder().filter((id) => id !== removeRank.dataset.rankRemove); return persistChange((state) => updateSubscriptionRanking(state, order), 'Removed from your value ranking.'); }
  if (remove) {
    const record = buildSubscriptionsPresentation(latestState).activeRows.find((row) => row.id === remove.dataset.subscriptionRemove);
    const wording = record?.source === SUBSCRIPTION_SOURCE.MANUAL ? 'remove this manually added subscription' : 'hide this detected subscription';
    if (!window.confirm(`Confirm that OneStep should ${wording}?`)) return;
    return persistChange((state) => removeSubscription(state, remove.dataset.subscriptionRemove), record?.source === SUBSCRIPTION_SOURCE.MANUAL ? 'Subscription removed.' : 'Subscription hidden.');
  }
}

async function handleSubscriptionChange(event) {
  if (event.target.id === 'subscriptionFilter') { currentFilter = event.target.value; renderSubscriptionsUI(); return; }
  if (event.target.id === 'subscriptionSort') { currentSort = event.target.value; renderSubscriptionsUI(); return; }
  if (event.target.matches('[data-subscription-protection]')) {
    const id = event.target.dataset.subscriptionProtection;
    return persistChange((state) => setSubscriptionProtection(state, id, event.target.value), 'Protection state saved separately from ranking.');
  }
}

async function handleSubscriptionSubmit(event) {
  if (event.target.id === 'manualSubscriptionForm') {
    event.preventDefault(); const form = event.target;
    const input = {
      providerName: form.elements.providerName.value,
      amount: form.elements.amount.value,
      cadence: form.elements.cadence.value,
      nextPaymentDate: form.elements.nextPaymentDate.value || undefined,
      accountId: form.elements.accountId.value,
      protectionState: form.elements.protectionState.value,
      notes: form.elements.notes.value
    };
    return persistChange((state) => createManualSubscription(state, input), 'Manual subscription added.');
  }
  if (event.target.matches('[data-subscription-edit]')) {
    event.preventDefault(); const form = event.target; const min = Number(form.elements.amountMin.value); const max = Number(form.elements.amountMax.value);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0 || min > max) {
      lastStatus = 'Enter a valid charge range where the minimum is not greater than the maximum.';
      renderSubscriptionsUI();
      return;
    }
    const patch = {
      providerName: form.elements.providerName.value,
      amountRange: { min, max, typical: (min + max) / 2 },
      cadence: form.elements.cadence.value,
      nextPaymentDate: form.elements.nextPaymentDate.value || null,
      notes: form.elements.notes.value
    };
    return persistChange((state) => editSubscription(state, form.dataset.subscriptionEdit, patch), 'Subscription details saved.');
  }
}

function handleDragStart(event) {
  const card = event.target.closest('[data-subscription-id]');
  if (!card) return;
  draggedSubscriptionId = card.dataset.subscriptionId;
  event.dataTransfer?.setData('text/plain', draggedSubscriptionId);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
}
function handleDragOver(event) { if (event.target.closest('[data-subscription-id]')) event.preventDefault(); }
async function handleDrop(event) {
  const target = event.target.closest('[data-subscription-id]');
  if (!target || !draggedSubscriptionId || target.dataset.subscriptionId === draggedSubscriptionId) return;
  event.preventDefault();
  const order = buildSubscriptionRankingOrder().filter((id) => id !== draggedSubscriptionId);
  const targetIndex = order.indexOf(target.dataset.subscriptionId);
  if (targetIndex >= 0) order.splice(targetIndex, 0, draggedSubscriptionId); else order.push(draggedSubscriptionId);
  draggedSubscriptionId = '';
  await persistChange((state) => updateSubscriptionRanking(state, order), 'Value ranking updated.');
}

async function persistChange(buildNext, successMessage) {
  if (saving || !latestState || !window.financeAPI?.saveState) return;
  saving = true; lastStatus = 'Saving subscription changes…'; renderSubscriptionsUI();
  try {
    const saved = await window.financeAPI.saveState(buildNext(latestState));
    if (saved?.status === 'conflict') {
      latestState = saved.state || latestState;
      lastStatus = saved.message || 'Your data changed elsewhere. The newest state is shown; review it and try again.';
    } else {
      latestState = saved;
      lastStatus = successMessage;
    }
  } catch {
    const loaded = await window.financeAPI.loadState().catch(() => null);
    if (loaded?.status === 'normal') latestState = loaded.state;
    lastStatus = 'That subscription change could not be saved. The latest safe state is shown; review it and try again.';
  } finally {
    saving = false; renderSubscriptionsUI();
  }
}

function sectionHeading(title, text) { const section = el('section', 'subscriptions-section'); const heading = el('div', 'subscriptions-section-heading'); append(heading, el('h2', '', title), el('p', 'muted', text)); section.append(heading); return section; }
function metric(label, value, hint) { const card = el('article', 'metric-card'); append(card, el('span', '', label), el('strong', '', value), el('small', '', hint)); return card; }
function fact(label, value) { const item = el('div', 'subscription-fact'); append(item, el('span', '', label), el('strong', '', value || 'Not known')); return item; }
function rankBadge(row) { return el('span', `subscription-rank ${row.rank === null ? 'unranked' : ''}`, row.rank === null ? 'Unranked' : `#${row.rank}`); }
function chargeLabel(row) { const range = row.amountRange || {}; const amount = range.min === range.max ? money(range.typical) : `${money(range.min)}–${money(range.max)}`; return `${amount} ${cadenceSuffix(row.cadence)}`; }
function paymentLabel(value) { if (!value?.date) return 'Not known'; const start = value.windowStart || value.date; const end = value.windowEnd || value.date; return start === end ? formatDate(start) : `${formatDate(start)}–${formatDate(end)}`; }
function moneyRange(range) { if (!range) return 'Not known'; if (range.exact !== null && range.exact !== undefined) return money(range.exact); return `${money(range.min)}–${money(range.max)}`; }
function money(value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
function formatDate(value) { const date = new Date(`${String(value).slice(0, 10)}T12:00:00Z`); return Number.isNaN(date.getTime()) ? 'Not known' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date); }
function cadenceSuffix(value) { return ({ weekly: 'weekly', fortnightly: 'fortnightly', 'four-weekly': 'every four weeks', monthly: 'monthly', quarterly: 'quarterly', annual: 'annually' })[value] || value; }
function titleCase(value) { return String(value || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()); }
function selectField(labelText, id, options, value) { const label = el('label', 'compact-field'); label.append(document.createTextNode(labelText)); const control = select(id, options, value); control.id = id; label.append(control); return label; }
function field(labelText, control, className = '') { const label = el('label', className); label.append(document.createTextNode(labelText), control); return label; }
function input(name, value, type, required, attrs = {}) { const control = document.createElement('input'); control.name = name; control.type = type; control.value = value ?? ''; control.required = required; for (const [key, val] of Object.entries(attrs)) control.setAttribute(key, val); return control; }
function select(name, options, value) { const control = document.createElement('select'); control.name = name; for (const [optionValue, text] of options) { const option = document.createElement('option'); option.value = optionValue; option.textContent = text; option.selected = optionValue === value; control.append(option); } return control; }
function button(text, className, dataset = {}, type = 'button') { const control = el('button', className, text); control.type = type; for (const [key, value] of Object.entries(dataset)) control.dataset[key] = value; if (saving) control.disabled = true; return control; }
function el(tag, className = '', text = '', children = []) { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; for (const child of children) node.append(child); return node; }
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); return parent; }
