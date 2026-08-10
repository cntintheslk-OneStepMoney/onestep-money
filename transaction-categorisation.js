// Local, deterministic transaction categorisation. This module deliberately
// does not persist a rule engine or send merchant data anywhere.

export function normaliseCategorisationText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function merchantIdentity(transaction = {}) {
  return normaliseCategorisationText(transaction.merchantName || transaction.userDescription || transaction.description);
}

export function transactionContextKey(transaction = {}) {
  const merchant = merchantIdentity(transaction);
  let source = normaliseCategorisationText(transaction.description);
  if (merchant && source.startsWith(merchant)) source = source.slice(merchant.length).trim();
  return source.replace(/\b\d+\b/g, '').trim();
}

export function resolveTransactionBudgetAssignment(transaction, options = {}, visited = new Set()) {
  const budgets = Array.isArray(options.budgets) ? options.budgets : [];
  const transactions = Array.isArray(options.transactions) ? options.transactions : [];
  const budgetById = new Map(budgets.map((budget) => [String(budget.id), budget]));
  const transactionId = String(transaction?.id || '');
  if (!transaction || (transactionId && visited.has(transactionId))) return unresolved('cycle');
  if (transactionId) visited.add(transactionId);

  const explicit = transaction.budgetCategoryId && budgetById.get(String(transaction.budgetCategoryId));
  if (explicit) return resolved(explicit, 'explicit');
  if (transaction.categorySource === 'manual') return unresolved('manual_uncategorised');

  const linkedId = transaction.refundOfTransactionId || transaction.reversalOfTransactionId;
  if (linkedId) {
    const linked = transactions.find((item) => String(item?.id) === String(linkedId));
    if (linked) {
      const inherited = resolveTransactionBudgetAssignment(linked, options, visited);
      if (inherited.budget) return resolved(inherited.budget, 'refund_inheritance');
    }
  }

  const categoryMatches = matchingCategoryBudgets(transaction, budgets);
  if (categoryMatches.length === 1) return resolved(categoryMatches[0], 'category_evidence');
  if (categoryMatches.length > 1) return unresolved('ambiguous_category');

  const contextual = matchingConfirmedContext(transaction, transactions, budgets);
  if (contextual.length === 1) return resolved(contextual[0], 'confirmed_context');
  if (contextual.length > 1) return unresolved('ambiguous_context');

  // Existing merchant terms remain readable for backwards compatibility, but
  // cannot override known conflicting purposes for the same merchant.
  if (!merchantHasConflictingPurposes(transaction, transactions, budgets)) {
    const legacyMatches = matchingLegacyMerchantTerms(transaction, budgets);
    if (legacyMatches.length === 1) return resolved(legacyMatches[0], 'legacy_merchant_term');
    if (legacyMatches.length > 1) return unresolved('ambiguous_merchant');
  }
  return unresolved('no_unambiguous_evidence');
}

export function matchingCategoryBudgets(transaction, budgets = []) {
  const category = normaliseCategorisationText(transaction?.category);
  if (!category) return [];
  return budgets.filter((budget) => (budget.categories?.length ? budget.categories : [budget.category])
    .map(normaliseCategorisationText).includes(category));
}

function matchingConfirmedContext(transaction, transactions, budgets) {
  const merchant = merchantIdentity(transaction);
  const context = transactionContextKey(transaction);
  if (!merchant || !context) return [];
  const matches = new Map();
  for (const candidate of transactions) {
    if (!candidate || String(candidate.id || '') === String(transaction.id || '')) continue;
    if (merchantIdentity(candidate) !== merchant || transactionContextKey(candidate) !== context) continue;
    const assignment = confirmedAssignment(candidate, budgets);
    if (assignment) matches.set(String(assignment.id), assignment);
  }
  return [...matches.values()];
}

function merchantHasConflictingPurposes(transaction, transactions, budgets) {
  const merchant = merchantIdentity(transaction);
  if (!merchant) return false;
  const matches = new Set();
  for (const candidate of transactions) {
    if (!candidate || String(candidate.id || '') === String(transaction.id || '')) continue;
    if (merchantIdentity(candidate) !== merchant) continue;
    const assignment = confirmedAssignment(candidate, budgets);
    if (assignment) matches.add(String(assignment.id));
    if (matches.size > 1) return true;
  }
  return false;
}

function confirmedAssignment(transaction, budgets) {
  const direct = transaction.budgetCategoryId && budgets.find((budget) => String(budget.id) === String(transaction.budgetCategoryId));
  if (direct) return direct;
  const categories = matchingCategoryBudgets(transaction, budgets);
  return categories.length === 1 ? categories[0] : null;
}

function matchingLegacyMerchantTerms(transaction, budgets) {
  const description = normaliseCategorisationText(transaction?.description);
  if (!description || Number(transaction?.outgoing || 0) <= 0) return [];
  return budgets.filter((budget) => (budget.merchantTerms || [])
    .map(normaliseCategorisationText).filter(Boolean).some((term) => description.includes(term)));
}

function resolved(budget, reason) { return { budget, reason, ambiguous: false }; }
function unresolved(reason) { return { budget: null, reason, ambiguous: /^ambiguous_/.test(reason) }; }
