import { listSubscriptionRecords } from './subscription-model.js';
import {
  CANCELLATION_MANAGEMENT,
  CANCELLATION_ROUTE_TYPE,
  resolveCancellationRoute,
  setSubscriptionCancellationRoute
} from './subscription-cancellation.js';

let latestState = null;
let refreshQueued = false;
let saving = false;

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    document.addEventListener('click', handleClick);
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('change', handleChange);
    new MutationObserver(scheduleAugment).observe(document.documentElement, { childList: true, subtree: true });
    scheduleAugment();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else queueMicrotask(start);
}

function scheduleAugment() {
  if (refreshQueued) return;
  refreshQueued = true;
  queueMicrotask(async () => {
    refreshQueued = false;
    await augmentCancellationPanels();
  });
}

async function augmentCancellationPanels() {
  const cards = [...document.querySelectorAll('#view-subscriptions [data-subscription-id]')];
  if (!cards.length || !window.financeAPI?.loadState) return;
  const loaded = await window.financeAPI.loadState().catch(() => null);
  if (loaded?.status !== 'normal') return;
  latestState = loaded.state;
  const records = new Map(listSubscriptionRecords(latestState).map((record) => [record.id, record]));
  for (const card of cards) {
    if (card.querySelector('[data-cancellation-panel]')) continue;
    const record = records.get(card.dataset.subscriptionId);
    const details = card.querySelector('.subscription-details');
    if (!record || !details) continue;
    details.append(cancellationPanel(record));
  }
}

function cancellationPanel(record) {
  const route = resolveCancellationRoute(record);
  const section = el('section', 'subscription-cancellation-panel');
  section.dataset.cancellationPanel = record.id;
  append(section, el('h3', '', 'Cancellation guidance'), el('p', 'muted', route.guidance));
  if (route.url) {
    const open = button(route.label, 'secondary-button');
    open.dataset.cancellationOpen = record.id;
    section.append(open, el('p', 'muted', 'Opening the official page does not mark this subscription as cancelled. OneStep waits for your explicit confirmation or later evidence.'));
  } else {
    section.append(el('p', 'subscription-notice', 'No online destination will be opened. Check who bills you and use that provider’s own account, receipt or support contact.'));
  }
  section.append(el('p', 'muted', `Routing source: ${provenanceLabel(route.provenance)}. Use Notes above for notice periods, minimum terms or fee uncertainty; OneStep does not invent those facts.`));

  const form = el('form', 'subscription-cancellation-form');
  form.dataset.cancellationForm = record.id;
  const decodedManagement = route.managementType || CANCELLATION_MANAGEMENT.MANUAL;
  form.append(field('Managed by', select('managementType', [
    [CANCELLATION_MANAGEMENT.PROVIDER, 'Provider directly'],
    [CANCELLATION_MANAGEMENT.APPLE, 'Apple / App Store'],
    [CANCELLATION_MANAGEMENT.MANUAL, 'Manual guidance only']
  ], decodedManagement)));
  form.append(field('Official route type', select('routeType', [
    [CANCELLATION_ROUTE_TYPE.DIRECT, 'Direct cancellation / management'],
    [CANCELLATION_ROUTE_TYPE.HELP, 'Official cancellation instructions'],
    [CANCELLATION_ROUTE_TYPE.GENERAL, 'General subscription management']
  ], route.routeType === CANCELLATION_ROUTE_TYPE.MANUAL ? CANCELLATION_ROUTE_TYPE.GENERAL : route.routeType), 'cancellation-provider-field'));
  const url = input('officialUrl', decodedManagement === CANCELLATION_MANAGEMENT.PROVIDER ? route.url || '' : '', 'url');
  url.placeholder = 'https://provider.example/account';
  form.append(field('Official HTTPS destination', url, 'cancellation-provider-field'));
  const save = button('Save cancellation guidance', 'secondary-button', 'submit');
  form.append(save);
  const status = el('p', 'muted'); status.dataset.cancellationStatus = record.id; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); form.append(status);
  queueMicrotask(() => updateFormVisibility(form));
  section.append(form);
  return section;
}

async function handleClick(event) {
  const open = event.target.closest('[data-cancellation-open]');
  if (!open || saving || !window.financeAPI?.openCancellationDestination) return;
  const record = listSubscriptionRecords(latestState || {}).find((item) => item.id === open.dataset.cancellationOpen);
  const route = resolveCancellationRoute(record || {});
  if (!route.url) return;
  open.disabled = true;
  setStatus(record.id, 'Opening the official destination…');
  const result = await window.financeAPI.openCancellationDestination(route.url).catch(() => ({ opened: false, reasonCode: 'open_failed' }));
  setStatus(record.id, result?.opened ? 'Official page opened. Your cancellation status has not changed.' : result?.reasonCode === 'invalid_destination' ? 'That destination was blocked by OneStep’s safe-navigation rules.' : 'The official page could not be opened. Your subscription data and status were not changed.');
  open.disabled = false;
}

async function handleSubmit(event) {
  const form = event.target.closest('[data-cancellation-form]');
  if (!form || saving || !latestState || !window.financeAPI?.saveState) return;
  event.preventDefault();
  const id = form.dataset.cancellationForm;
  saving = true; setStatus(id, 'Saving cancellation guidance…');
  try {
    const next = setSubscriptionCancellationRoute(latestState, id, {
      managementType: form.elements.managementType.value,
      routeType: form.elements.routeType.value,
      officialUrl: form.elements.officialUrl.value
    }, new Date());
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'conflict') {
      latestState = saved.state || latestState;
      setStatus(id, saved.message || 'Your data changed elsewhere. Review the newest state and try again.');
    } else {
      latestState = saved;
      setStatus(id, 'Cancellation guidance saved. No cancellation status was changed.');
      rerenderPanel(id);
    }
  } catch (error) {
    setStatus(id, error?.message || 'That cancellation guidance could not be saved.');
  } finally { saving = false; }
}

function handleChange(event) {
  if (event.target.name !== 'managementType') return;
  const form = event.target.closest('[data-cancellation-form]');
  if (form) updateFormVisibility(form);
}

function rerenderPanel(id) {
  const old = document.querySelector(`[data-cancellation-panel="${cssEscape(id)}"]`);
  const record = listSubscriptionRecords(latestState || {}).find((item) => item.id === id);
  if (!old || !record) return;
  old.replaceWith(cancellationPanel(record));
}

function updateFormVisibility(form) {
  const provider = form.elements.managementType.value === CANCELLATION_MANAGEMENT.PROVIDER;
  form.querySelectorAll('.cancellation-provider-field').forEach((label) => { label.hidden = !provider; });
  form.elements.officialUrl.required = provider;
}
function setStatus(id, text) { const node = document.querySelector(`[data-cancellation-status="${cssEscape(id)}"]`); if (node) node.textContent = text; }
function provenanceLabel(value) { return value === 'official_apple' ? 'verified Apple generic management route' : value === 'user_verified_official' ? 'official destination you saved' : 'local manual guidance'; }
function cssEscape(value) { return globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^A-Za-z0-9_-]/g, ''); }
function field(text, control, className = '') { const label = el('label', className); label.append(document.createTextNode(text), control); return label; }
function select(name, options, value) { const node = document.createElement('select'); node.name = name; for (const [v, text] of options) { const option = document.createElement('option'); option.value = v; option.textContent = text; option.selected = v === value; node.append(option); } return node; }
function input(name, value, type) { const node = document.createElement('input'); node.name = name; node.value = value || ''; node.type = type; return node; }
function button(text, className, type = 'button') { const node = el('button', className, text); node.type = type; return node; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); }
