import {
  applyPaymentBulkCategorisation, buildPaymentBulkCategorisationPlan, paymentBulkCategoryOptions,
  paymentBulkEligibility, retainVisiblePaymentSelection
} from './payment-bulk-review.js';
import { synchroniseReviewItems } from './review-lifecycle.js';

const RETURN_TO_PAYMENTS_KEY = 'onestep:return-to-payments-after-bulk-review';

if (typeof window !== 'undefined' && typeof document !== 'undefined') initialisePaymentBulkReviewUi();

function initialisePaymentBulkReviewUi() {
  const body = document.getElementById('transactionRows');
  const table = document.getElementById('transactionTable');
  const view = document.getElementById('view-transactions');
  if (!body || !table || !view) return;

  injectStyles();
  const controls = createControls(table);
  const selection = new Set();
  let visibleEligibleIds = [];
  let pending = null;
  let syncGeneration = 0;

  const observer = new MutationObserver(() => scheduleSync());
  observer.observe(body, { childList: true });
  ensureSelectionHeader(table);
  scheduleSync();
  restorePaymentsViewAfterReload();

  controls.selectVisible.addEventListener('click', () => {
    selection.clear();
    visibleEligibleIds.forEach((id) => selection.add(id));
    syncCheckboxes();
    renderSelectionState();
  });
  controls.clearSelection.addEventListener('click', () => {
    selection.clear();
    syncCheckboxes();
    renderSelectionState();
  });
  controls.category.addEventListener('change', renderSelectionState);
  controls.review.addEventListener('click', reviewBulkChange);
  controls.cancel.addEventListener('click', () => controls.dialog.close('cancelled'));
  controls.dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    controls.dialog.close('cancelled');
  });
  controls.dialog.addEventListener('close', () => {
    if (controls.dialog.returnValue !== 'apply') pending = null;
  });
  controls.apply.addEventListener('click', applyBulkChange);

  function scheduleSync() {
    const generation = ++syncGeneration;
    queueMicrotask(() => syncVisibleRows(generation));
  }

  async function syncVisibleRows(generation) {
    let loaded;
    try { loaded = await window.financeAPI?.loadState(); }
    catch { controls.toolbar.hidden = true; return; }
    if (generation !== syncGeneration || loaded?.status !== 'normal') return;
    const currentState = loaded.state;
    refreshCategoryOptions(currentState);
    ensureSelectionHeader(table);

    const rows = [...body.querySelectorAll('tr')];
    const visibleIds = [];
    const eligibleIds = [];
    observer.disconnect();
    try {
      for (const row of rows) {
        const edit = row.querySelector('[data-edit="transaction"][data-id]');
        if (!edit) {
          const onlyCell = row.querySelector('td[colspan]');
          if (onlyCell) onlyCell.colSpan = 9;
          continue;
        }
        const id = String(edit.dataset.id || '');
        visibleIds.push(id);
        const transaction = (currentState.transactions || []).find((item) => String(item?.id) === id);
        const eligibility = paymentBulkEligibility(transaction);
        if (eligibility.eligible) eligibleIds.push(id);
        ensureRowCheckbox(row, id, eligibility);
      }
    } finally {
      observer.observe(body, { childList: true });
    }

    const retained = retainVisiblePaymentSelection([...selection], visibleIds, eligibleIds);
    selection.clear(); retained.forEach((id) => selection.add(id));
    visibleEligibleIds = eligibleIds;
    syncCheckboxes();
    controls.toolbar.hidden = visibleEligibleIds.length === 0;
    controls.selectVisible.disabled = visibleEligibleIds.length === 0;
    controls.selectVisible.textContent = visibleEligibleIds.length ? `Select visible (${visibleEligibleIds.length})` : 'Select visible';
    renderSelectionState();
  }

  function ensureRowCheckbox(row, id, eligibility) {
    let cell = row.querySelector('td.payment-bulk-select-cell');
    if (!cell) {
      cell = document.createElement('td');
      cell.className = 'payment-bulk-select-cell';
      row.prepend(cell);
    }
    let checkbox = cell.querySelector('input[data-payment-bulk-select]');
    if (!checkbox) {
      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.paymentBulkSelect = 'true';
      checkbox.setAttribute('aria-label', 'Select payment for bulk review');
      checkbox.addEventListener('change', () => {
        const paymentId = String(checkbox.dataset.id || '');
        if (checkbox.checked) selection.add(paymentId); else selection.delete(paymentId);
        renderSelectionState();
      });
      cell.append(checkbox);
    }
    checkbox.dataset.id = id;
    checkbox.disabled = !eligibility.eligible;
    checkbox.title = eligibility.eligible ? 'Select this visible payment' : eligibility.reason;
  }

  function syncCheckboxes() {
    body.querySelectorAll('input[data-payment-bulk-select]').forEach((checkbox) => {
      checkbox.checked = !checkbox.disabled && selection.has(String(checkbox.dataset.id || ''));
    });
  }

  function refreshCategoryOptions(currentState) {
    const previous = controls.category.value;
    const options = paymentBulkCategoryOptions(currentState);
    controls.category.replaceChildren(option('', 'Choose purpose / category'));
    options.forEach((entry) => controls.category.append(option(entry.value, entry.label)));
    controls.category.value = [...controls.category.options].some((entry) => entry.value === previous) ? previous : '';
  }

  function renderSelectionState() {
    const count = selection.size;
    controls.count.textContent = count ? `${count} selected` : 'No payments selected';
    controls.actions.hidden = count === 0;
    controls.clearSelection.disabled = count === 0;
    controls.review.disabled = count === 0 || !controls.category.value;
  }

  async function reviewBulkChange() {
    if (!selection.size || !controls.category.value) return;
    let loaded;
    try { loaded = await window.financeAPI.loadState(); }
    catch { controls.status.textContent = 'The current financial state could not be opened. Nothing changed.'; return; }
    if (loaded?.status !== 'normal') {
      controls.status.textContent = 'Bulk review is unavailable while financial data is in recovery mode.';
      return;
    }
    const plan = buildPaymentBulkCategorisationPlan(loaded.state, [...selection], controls.category.value);
    if (!plan.valid) {
      controls.status.textContent = plan.errors[0] || 'Those payments cannot safely share one bulk change.';
      scheduleSync();
      return;
    }
    pending = { state: loaded.state, plan };
    const direction = plan.direction === 'income' ? 'incoming' : 'outgoing';
    controls.summary.textContent = `Apply “${plan.targetLabel}” to ${plan.selectedCount} selected ${direction} payment${plan.selectedCount === 1 ? '' : 's'}?`;
    controls.explanation.textContent = plan.targetKind === 'clear'
      ? 'Their manual budget assignment will be cleared and the payments will remain Uncategorised until you choose a new purpose.'
      : 'Only the selected visible payments will change. Transfer, debt-payment, refund, reversal and unresolved-import semantics remain protected.';
    controls.dialogStatus.textContent = '';
    controls.dialog.showModal();
    controls.cancel.focus();
  }

  async function applyBulkChange() {
    if (!pending) return;
    controls.apply.disabled = true;
    controls.cancel.disabled = true;
    controls.dialogStatus.textContent = 'Applying reviewed change…';
    try {
      const result = applyPaymentBulkCategorisation(pending.state, pending.plan, { synchroniseReviewItems, now: new Date() });
      const saved = await window.financeAPI.saveState(result.state);
      if (saved?.status === 'blocked') throw new Error(saved.message || 'Saving is paused while recovery is required.');
      if (saved?.status === 'conflict') {
        controls.dialog.returnValue = 'conflict';
        controls.dialog.close();
        selection.clear();
        pending = null;
        controls.status.textContent = saved.message || 'Payments changed elsewhere. Nothing from this bulk action was saved.';
        window.sessionStorage.setItem(RETURN_TO_PAYMENTS_KEY, '1');
        window.setTimeout(() => window.location.reload(), 450);
        return;
      }
      window.sessionStorage.setItem(RETURN_TO_PAYMENTS_KEY, '1');
      controls.dialog.returnValue = 'apply';
      controls.dialog.close();
      pending = null;
      window.location.reload();
    } catch (error) {
      controls.dialogStatus.textContent = error?.message || 'That bulk change could not be saved. Nothing was applied.';
    } finally {
      controls.apply.disabled = false;
      controls.cancel.disabled = false;
    }
  }
}

function createControls(table) {
  const toolbar = document.createElement('section');
  toolbar.className = 'payment-bulk-toolbar';
  toolbar.hidden = true;
  toolbar.setAttribute('aria-label', 'Bulk payment review');

  const selectionControls = document.createElement('div');
  selectionControls.className = 'payment-bulk-selection-controls';
  const title = document.createElement('strong'); title.textContent = 'Bulk review';
  const selectVisible = button('secondary-button', 'Select visible');
  const clearSelection = button('secondary-button', 'Clear selection'); clearSelection.disabled = true;
  const count = document.createElement('span'); count.className = 'payment-bulk-count'; count.textContent = 'No payments selected'; count.setAttribute('aria-live', 'polite');
  selectionControls.append(title, selectVisible, clearSelection, count);

  const actions = document.createElement('div');
  actions.className = 'payment-bulk-actions'; actions.hidden = true;
  const categoryLabel = document.createElement('label'); categoryLabel.textContent = 'Purpose / budget category';
  const category = document.createElement('select'); category.setAttribute('aria-label', 'Bulk purpose or budget category');
  category.append(option('', 'Choose purpose / category')); categoryLabel.append(category);
  const review = button('primary-button', 'Review changes'); review.disabled = true;
  actions.append(categoryLabel, review);
  const status = document.createElement('p'); status.className = 'payment-bulk-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  toolbar.append(selectionControls, actions, status);
  table.before(toolbar);

  const dialog = document.createElement('dialog'); dialog.className = 'payment-bulk-dialog';
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'BULK PAYMENT REVIEW';
  const heading = document.createElement('h2'); heading.textContent = 'Review category change';
  const summary = document.createElement('p'); summary.className = 'payment-bulk-dialog-summary';
  const explanation = document.createElement('p'); explanation.className = 'muted';
  const dialogStatus = document.createElement('p'); dialogStatus.className = 'payment-bulk-dialog-status'; dialogStatus.setAttribute('role', 'status'); dialogStatus.setAttribute('aria-live', 'polite');
  const dialogActions = document.createElement('div'); dialogActions.className = 'payment-bulk-dialog-actions';
  const cancel = button('secondary-button', 'Cancel');
  const apply = button('primary-button', 'Apply to selected');
  dialogActions.append(cancel, apply);
  dialog.append(eyebrow, heading, summary, explanation, dialogStatus, dialogActions);
  document.body.append(dialog);

  return { toolbar, selectVisible, clearSelection, count, actions, category, review, status, dialog, summary, explanation, dialogStatus, cancel, apply };
}

function ensureSelectionHeader(table) {
  const row = table.querySelector('thead tr');
  if (!row || row.querySelector('th.payment-bulk-select-heading')) return;
  const heading = document.createElement('th'); heading.className = 'payment-bulk-select-heading'; heading.scope = 'col';
  const label = document.createElement('span'); label.className = 'sr-only'; label.textContent = 'Select';
  heading.append(label); row.prepend(heading);
}

function injectStyles() {
  if (document.getElementById('paymentBulkReviewStyles')) return;
  const style = document.createElement('style');
  style.id = 'paymentBulkReviewStyles';
  style.textContent = `
    .payment-bulk-toolbar { display: grid; gap: .75rem; margin: 1rem 0; padding: .9rem 1rem; background: var(--surface-subtle); border: 1px solid var(--line); border-radius: 16px; }
    .payment-bulk-selection-controls, .payment-bulk-actions, .payment-bulk-dialog-actions { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; }
    .payment-bulk-selection-controls strong { margin-right: .15rem; }
    .payment-bulk-count { color: var(--muted); font-weight: 700; }
    .payment-bulk-actions label { display: grid; gap: .3rem; min-width: min(100%, 260px); color: var(--muted); font-size: .82rem; font-weight: 700; }
    .payment-bulk-actions select { min-height: 40px; padding: .45rem .65rem; color: var(--ink); background: var(--control-surface); border: 1px solid var(--line-strong); border-radius: 10px; }
    .payment-bulk-status, .payment-bulk-dialog-status { min-height: 1.25rem; margin: 0; color: var(--warning-ink); font-size: .88rem; }
    .payment-bulk-select-heading, .payment-bulk-select-cell { width: 2.75rem; text-align: center; }
    .payment-bulk-select-cell input { width: 1.05rem; height: 1.05rem; accent-color: var(--teal-dark); }
    .payment-bulk-dialog { width: min(520px, calc(100vw - 2rem)); padding: 1.35rem; color: var(--ink); background: var(--panel); border: 1px solid var(--line-strong); border-radius: 20px; box-shadow: var(--shadow-strong); }
    .payment-bulk-dialog::backdrop { background: rgba(6, 26, 56, .48); }
    .payment-bulk-dialog-summary { font-weight: 700; }
    .payment-bulk-dialog-actions { justify-content: flex-end; margin-top: 1rem; }
    @media (max-width: 720px) { .payment-bulk-actions { align-items: stretch; } .payment-bulk-actions label, .payment-bulk-actions button { width: 100%; } }
  `;
  document.head.append(style);
}

function restorePaymentsViewAfterReload() {
  if (window.sessionStorage.getItem(RETURN_TO_PAYMENTS_KEY) !== '1') return;
  window.sessionStorage.removeItem(RETURN_TO_PAYMENTS_KEY);
  let attempts = 0;
  const timer = window.setInterval(() => {
    attempts += 1;
    const shell = document.getElementById('appShell');
    const button = document.querySelector('.nav-button[data-view="transactions"]');
    if (shell && !shell.hidden && button) {
      window.clearInterval(timer);
      button.click();
      document.getElementById('transactionTable')?.focus({ preventScroll: true });
      return;
    }
    if (attempts >= 80) window.clearInterval(timer);
  }, 50);
}

function button(className, text) { const output = document.createElement('button'); output.type = 'button'; output.className = className; output.textContent = text; return output; }
function option(value, text) { const output = document.createElement('option'); output.value = value; output.textContent = text; return output; }
