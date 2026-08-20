import { listSubscriptionRecords } from './subscription-model.js';
import {
  SUBSCRIPTION_LIFECYCLE,
  exportSubscriptionsCsv,
  readSubscriptionWorkflow,
  setSubscriptionLifecycle
} from './subscription-workflow.js';

let latestState = null;
let refreshQueued = false;
let saving = false;
let statusMessage = '';

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const start = () => {
    document.addEventListener('submit', handleSubmit);
    document.addEventListener('click', handleClick);
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
    await augmentWorkflowControls();
  });
}

async function augmentWorkflowControls() {
  const view = document.getElementById('view-subscriptions');
  if (!view || !window.financeAPI?.loadState) return;
  const loaded = await window.financeAPI.loadState().catch(() => null);
  if (loaded?.status !== 'normal') return;
  latestState = loaded.state;

  ensureSubscriptionExportControl(view);

  const records = new Map(listSubscriptionRecords(latestState).map((record) => [record.id, record]));
  for (const card of view.querySelectorAll('[data-subscription-id]')) {
    if (card.querySelector('[data-subscription-workflow-panel]')) continue;
    const record = records.get(card.dataset.subscriptionId);
    const details = card.querySelector('.subscription-details');
    if (!record || !details) continue;
    details.append(workflowPanel(record));
  }
}

export function ensureSubscriptionExportControl(view, createControl = createExportControl) {
  if (!view?.querySelector) return null;
  const existing = view.querySelector('[data-subscription-export]');
  if (existing) return existing;
  const heading = view.querySelector('.subscriptions-heading');
  if (!heading) return null;
  const exportButton = createControl();
  if (!exportButton) return null;
  exportButton.dataset.subscriptionExport = 'true';
  heading.append(exportButton);
  return exportButton;
}

function createExportControl() {
  return button('Export subscription data', 'secondary-button');
}

function workflowPanel(record) {
  const workflow = readSubscriptionWorkflow(latestState || {}, record.id);
  const section = el('section', 'subscription-workflow-panel');
  section.dataset.subscriptionWorkflowPanel = record.id;
  append(
    section,
    el('h3', '', 'Lifecycle'),
    el('p', 'muted', lifecycleExplanation(workflow.lifecycleStatus))
  );

  const form = el('form', 'subscription-workflow-form');
  form.dataset.subscriptionWorkflowForm = record.id;
  form.append(field('Status', select('lifecycleStatus', [
    [SUBSCRIPTION_LIFECYCLE.ACTIVE, 'Active'],
    [SUBSCRIPTION_LIFECYCLE.REVIEW, 'Review'],
    [SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, 'Cancellation planned'],
    [SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS, 'Cancellation in progress'],
    [SUBSCRIPTION_LIFECYCLE.CANCELLED, 'Cancelled'],
    [SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING, 'Contract ending']
  ], workflow.lifecycleStatus)));

  const effectiveDate = input('effectiveDate', workflow.cancellationEffectiveDate || '', 'date');
  form.append(field('Cancellation effective date', effectiveDate, 'subscription-effective-date-field'));
  const contractEndDate = input('contractEndDate', workflow.contractEndDate || '', 'date');
  form.append(field('Known contract end date', contractEndDate, 'subscription-contract-end-field'));

  const review = document.createElement('label');
  review.className = 'subscription-workflow-review-field';
  const reviewCheckbox = document.createElement('input');
  reviewCheckbox.type = 'checkbox';
  reviewCheckbox.name = 'contractReviewRequired';
  reviewCheckbox.checked = workflow.contractReviewRequired;
  review.append(reviewCheckbox, document.createTextNode(' Contract / notice / fee information still needs review'));
  form.append(review);

  const save = button(saving ? 'Saving…' : 'Save lifecycle', 'secondary-button', 'submit');
  save.disabled = saving;
  form.append(save);
  const status = el('p', 'muted', statusMessage);
  status.dataset.subscriptionWorkflowStatus = record.id;
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  form.append(status);
  updateFieldVisibility(form);
  section.append(form);

  section.append(el('p', 'subscription-notice', 'Opening cancellation guidance never changes this status. Cancellation planned or in progress remains a financial commitment until effective evidence supports otherwise.'));
  return section;
}

async function handleSubmit(event) {
  const form = event.target.closest('[data-subscription-workflow-form]');
  if (!form || saving || !latestState || !window.financeAPI?.saveState) return;
  event.preventDefault();
  const id = form.dataset.subscriptionWorkflowForm;
  saving = true;
  statusMessage = 'Saving subscription lifecycle…';
  rerenderPanel(id);
  try {
    const next = setSubscriptionLifecycle(latestState, id, form.elements.lifecycleStatus.value, {
      effectiveDate: form.elements.effectiveDate.value || undefined,
      contractEndDate: form.elements.contractEndDate.value || undefined,
      contractReviewRequired: form.elements.contractReviewRequired.checked
    }, new Date());
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'conflict') {
      latestState = saved.state || latestState;
      statusMessage = saved.message || 'Your data changed elsewhere. The newest state is shown; review it and try again.';
    } else {
      latestState = saved;
      statusMessage = 'Lifecycle saved. Review Inbox and recommendations will follow the updated source state.';
    }
  } catch (error) {
    const loaded = await window.financeAPI.loadState().catch(() => null);
    if (loaded?.status === 'normal') latestState = loaded.state;
    statusMessage = error?.message || 'That lifecycle change could not be saved. The latest safe state is shown.';
  } finally {
    saving = false;
    rerenderPanel(id);
  }
}

async function handleClick(event) {
  const exportButton = event.target.closest('[data-subscription-export]');
  if (!exportButton || !window.financeAPI?.exportCsv || !latestState) return;
  try {
    await runSubscriptionExport(exportButton, latestState, window.financeAPI.exportCsv);
  } catch {
    // Export cancellation/failure is non-destructive; the control is re-enabled by the runner.
  }
}

export async function runSubscriptionExport(exportButton, state, exportCsv) {
  if (!exportButton || !state || typeof exportCsv !== 'function') return null;
  exportButton.disabled = true;
  try {
    return await exportCsv(exportSubscriptionsCsv(state));
  } finally {
    exportButton.disabled = false;
  }
}

function handleChange(event) {
  if (event.target.name !== 'lifecycleStatus') return;
  const form = event.target.closest('[data-subscription-workflow-form]');
  if (form) updateFieldVisibility(form);
}

function updateFieldVisibility(form) {
  const lifecycle = form.elements.lifecycleStatus.value;
  const effective = form.querySelector('.subscription-effective-date-field');
  const contractEnd = form.querySelector('.subscription-contract-end-field');
  if (effective) effective.hidden = lifecycle !== SUBSCRIPTION_LIFECYCLE.CANCELLED;
  if (contractEnd) contractEnd.hidden = lifecycle !== SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING;
  form.elements.effectiveDate.required = lifecycle === SUBSCRIPTION_LIFECYCLE.CANCELLED;
  form.elements.contractEndDate.required = lifecycle === SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING;
}

function rerenderPanel(id) {
  const current = document.querySelector(`[data-subscription-workflow-panel="${cssEscape(id)}"]`);
  const record = listSubscriptionRecords(latestState || {}).find((entry) => entry.id === id);
  if (!current || !record) return;
  current.replaceWith(workflowPanel(record));
}

function lifecycleExplanation(value) {
  const copy = {
    [SUBSCRIPTION_LIFECYCLE.ACTIVE]: 'This subscription is currently treated as active.',
    [SUBSCRIPTION_LIFECYCLE.REVIEW]: 'The current lifecycle is uncertain and needs your review.',
    [SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED]: 'You intend to cancel it, but OneStep still treats the commitment conservatively.',
    [SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS]: 'Cancellation has started, but it is not yet treated as completed.',
    [SUBSCRIPTION_LIFECYCLE.CANCELLED]: 'You explicitly confirmed cancellation as effective.',
    [SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING]: 'A known contract end date is recorded; commitments remain protected through that boundary.'
  };
  return copy[value] || copy[SUBSCRIPTION_LIFECYCLE.REVIEW];
}

function cssEscape(value) { return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replace(/[^A-Za-z0-9_-]/g, ''); }
function field(text, control, className = '') { const label = el('label', className); label.append(document.createTextNode(text), control); return label; }
function select(name, options, value) { const node = document.createElement('select'); node.name = name; for (const [optionValue, text] of options) { const option = document.createElement('option'); option.value = optionValue; option.textContent = text; option.selected = optionValue === value; node.append(option); } return node; }
function input(name, value, type) { const node = document.createElement('input'); node.name = name; node.value = value || ''; node.type = type; return node; }
function button(text, className, type = 'button') { const node = el('button', className, text); node.type = type; return node; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
function append(parent, ...children) { for (const child of children) if (child) parent.append(child); }
