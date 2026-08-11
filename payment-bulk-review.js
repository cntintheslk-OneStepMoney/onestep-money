export const PAYMENT_BULK_CLEAR_VALUE = 'payment-category:uncategorised';
export const PAYMENT_BULK_INCOME_VALUE = 'payment-category:income';

const BLOCKED_TREATMENTS = new Set(['transfer', 'savings_transfer', 'debt_payment', 'refund', 'reversal', 'ignored']);
const INCOME_LABEL = 'Income';
const UNCATEGORISED_LABEL = 'Uncategorised';

export function paymentBulkEligibility(transaction) {
  if (!transaction || !transaction.id) return ineligible('Payment is unavailable.');
  if (transaction.deletedAt || transaction.ignored === true || transaction.valid === false) return ineligible('This payment is inactive or invalid.');
  if (transaction.duplicateStatus === 'exact' || transaction.reviewStatus === 'rejected' || transaction.financiallyActive === false) {
    return ineligible('This payment is excluded from trusted financial data.');
  }
  if (['pending', 'rejected'].includes(normalise(transaction.importReviewStatus))) {
    return ineligible('This payment still has an unresolved import decision.');
  }
  if (transaction.transferStatus && normalise(transaction.transferStatus) !== 'no') {
    return ineligible('Transfer candidates must be reviewed individually.');
  }
  if (BLOCKED_TREATMENTS.has(normalise(transaction.budgetTreatment)) || transaction.refundOfTransactionId || transaction.reversalOfTransactionId) {
    return ineligible('This payment has special financial treatment that bulk categorisation must preserve.');
  }
  const direction = paymentDirection(transaction);
  if (!direction) return ineligible('This payment does not have one clear incoming or outgoing direction.');
  return { eligible: true, direction, reason: '' };
}

export function paymentBulkCategoryOptions(state = {}) {
  const options = [
    { value: PAYMENT_BULK_INCOME_VALUE, label: INCOME_LABEL, kind: 'income' },
    { value: PAYMENT_BULK_CLEAR_VALUE, label: UNCATEGORISED_LABEL, kind: 'clear' },
    ...(Array.isArray(state.budgets) ? state.budgets : [])
      .filter((budget) => budget?.id && normalise(budget.category) !== 'income')
      .map((budget) => ({ value: String(budget.id), label: String(budget.category || 'Budget category'), kind: 'budget' }))
  ];
  return options.sort((left, right) => left.label.localeCompare(right.label, 'en-GB', { sensitivity: 'base' }) || left.value.localeCompare(right.value));
}

export function retainVisiblePaymentSelection(selectedIds, visibleIds, eligibleIds = visibleIds) {
  const visible = new Set((visibleIds || []).map(String));
  const eligible = new Set((eligibleIds || []).map(String));
  return [...new Set((selectedIds || []).map(String))].filter((id) => visible.has(id) && eligible.has(id));
}

export function buildPaymentBulkCategorisationPlan(state, transactionIds, targetValue) {
  const selectedIds = [...new Set((transactionIds || []).map(String).filter(Boolean))];
  if (!selectedIds.length) return invalidPlan('Select at least one visible payment.');
  const transactions = Array.isArray(state?.transactions) ? state.transactions : [];
  const selected = [];
  for (const id of selectedIds) {
    const transaction = transactions.find((item) => String(item?.id) === id);
    if (!transaction) return invalidPlan('One or more selected payments are no longer available.');
    const eligibility = paymentBulkEligibility(transaction);
    if (!eligibility.eligible) return invalidPlan(eligibility.reason);
    selected.push({ transaction, direction: eligibility.direction });
  }

  const directions = new Set(selected.map((entry) => entry.direction));
  if (directions.size !== 1) return invalidPlan('Income and outgoing spending cannot share one bulk category change.');
  const direction = selected[0].direction;
  const target = resolveTarget(state, targetValue);
  if (!target.valid) return invalidPlan(target.error);
  if (target.kind === 'income' && direction !== 'income') return invalidPlan('Income can only be assigned to incoming payments.');
  if (target.kind !== 'income' && direction !== 'expense') return invalidPlan('Budget categories and Uncategorised can only be applied to outgoing spending.');

  return {
    valid: true,
    errors: [],
    transactionIds: selectedIds,
    selectedCount: selectedIds.length,
    direction,
    targetValue: target.value,
    targetKind: target.kind,
    targetLabel: target.label,
    budgetCategoryId: target.budgetCategoryId || '',
    expectedRevision: Number.isInteger(state?.meta?.revision) ? state.meta.revision : null
  };
}

export function applyPaymentBulkCategorisation(state, plan, options = {}) {
  const checked = buildPaymentBulkCategorisationPlan(state, plan?.transactionIds, plan?.targetValue);
  if (!checked.valid) throw bulkError(checked.errors[0] || 'The bulk category change is no longer valid.');
  if (plan?.expectedRevision !== undefined && plan.expectedRevision !== null && checked.expectedRevision !== plan.expectedRevision) {
    throw bulkError('The financial state changed after this bulk action was reviewed.', 'PAYMENT_BULK_STALE_REVISION');
  }

  const nextState = structuredClone(state || {});
  const updatedIds = [];
  for (const id of checked.transactionIds) {
    const transaction = nextState.transactions.find((item) => String(item?.id) === id);
    if (!transaction) throw bulkError('A selected payment is no longer available.');
    if (checked.targetKind === 'income') {
      transaction.budgetCategoryId = '';
      transaction.category = INCOME_LABEL;
    } else if (checked.targetKind === 'clear') {
      transaction.budgetCategoryId = '';
      transaction.category = '';
    } else {
      transaction.budgetCategoryId = checked.budgetCategoryId;
      transaction.category = checked.targetLabel;
    }
    transaction.categorySource = 'manual';
    if (/^\d{4}-\d{2}/.test(String(transaction.date || ''))) transaction.budgetMonth = String(transaction.date).slice(0, 7);
    updatedIds.push(String(transaction.id));
  }

  if (typeof options.synchroniseReviewItems === 'function') options.synchroniseReviewItems(nextState, validDate(options.now));
  return { state: nextState, updatedIds, plan: checked };
}

function resolveTarget(state, targetValue) {
  const value = String(targetValue || '');
  if (value === PAYMENT_BULK_CLEAR_VALUE) return { valid: true, value, kind: 'clear', label: UNCATEGORISED_LABEL, budgetCategoryId: '' };
  if (value === PAYMENT_BULK_INCOME_VALUE) return { valid: true, value, kind: 'income', label: INCOME_LABEL, budgetCategoryId: '' };
  const budget = (Array.isArray(state?.budgets) ? state.budgets : []).find((item) => String(item?.id) === value);
  if (!budget) return { valid: false, error: 'Choose an available purpose or budget category.' };
  if (normalise(budget.category) === 'income') return { valid: false, error: 'Income must use the dedicated Income category.' };
  return { valid: true, value, kind: 'budget', label: String(budget.category || 'Budget category'), budgetCategoryId: String(budget.id) };
}

function paymentDirection(transaction) {
  const incoming = Number(transaction?.incoming || 0) > 0;
  const outgoing = Number(transaction?.outgoing || 0) > 0;
  if (incoming === outgoing) return '';
  return incoming ? 'income' : 'expense';
}

function invalidPlan(message) { return { valid: false, errors: [message], transactionIds: [], selectedCount: 0 }; }
function ineligible(reason) { return { eligible: false, direction: '', reason }; }
function normalise(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, '_'); }
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date() : date; }
function bulkError(message, code = 'PAYMENT_BULK_INVALID') { const error = new Error(message); error.code = code; return error; }
