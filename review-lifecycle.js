const REVIEW_STATUSES = new Set(['needs_attention', 'in_progress', 'snoozed', 'resolved']);
const REVIEW_PRIORITIES = new Set(['high', 'normal', 'low']);

export const REVIEW_STATUS = Object.freeze({
  NEEDS_ATTENTION: 'needs_attention',
  IN_PROGRESS: 'in_progress',
  SNOOZED: 'snoozed',
  RESOLVED: 'resolved'
});

export const REVIEW_DIAGNOSTIC_CODES = Object.freeze({
  STATE_INVALID: 'REVIEW_ITEM_STATE_INVALID',
  RESOLUTION_FAILED: 'REVIEW_RESOLUTION_FAILED',
  SNOOZE_INVALID: 'SNOOZE_STATE_INVALID'
});

export function synchroniseReviewItems(state, now = new Date()) {
  const target = state && typeof state === 'object' ? state : {};
  const timestamp = validDate(now).toISOString();
  const existing = new Map((Array.isArray(target.reviewItems) ? target.reviewItems : [])
    .map((item) => migrateReviewItem(item, timestamp))
    .filter(Boolean)
    .map((item) => [item.id, item]));
  const sources = reviewSources(target, now);
  const activeSourceIds = new Set();

  for (const source of sources) {
    const id = reviewItemId(source.type, source.sourceType, source.sourceId);
    activeSourceIds.add(id);
    const previous = existing.get(id);
    if (!previous) {
      existing.set(id, createReviewItem(source, id, timestamp));
      continue;
    }
    let changed = previous.type !== source.type
      || previous.priority !== source.priority
      || previous.sourceType !== source.sourceType
      || previous.sourceId !== String(source.sourceId)
      || previous.groupKey !== (source.groupKey || '')
      || previous.conditionKey !== (source.conditionKey || '');
    previous.type = source.type;
    previous.priority = source.priority;
    previous.sourceType = source.sourceType;
    previous.sourceId = String(source.sourceId);
    previous.groupKey = source.groupKey || '';
    previous.conditionKey = source.conditionKey || '';
    if (previous.status === REVIEW_STATUS.SNOOZED && due(previous.snoozedUntil, now)) {
      previous.status = REVIEW_STATUS.NEEDS_ATTENTION;
      previous.snoozedUntil = null;
      changed = true;
    }
    if (previous.status === REVIEW_STATUS.RESOLVED && previous.resolution?.decision === 'source_resolved') {
      previous.status = REVIEW_STATUS.NEEDS_ATTENTION;
      previous.resolution = null;
      previous.snoozedUntil = null;
      changed = true;
    }
    if (changed) previous.updatedAt = timestamp;
  }

  for (const item of existing.values()) {
    if (activeSourceIds.has(item.id) || item.status === REVIEW_STATUS.RESOLVED) continue;
    item.status = REVIEW_STATUS.RESOLVED;
    item.snoozedUntil = null;
    item.updatedAt = timestamp;
    item.resolution = { decision: 'source_resolved', resolvedAt: timestamp };
  }

  const sorted = [...existing.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const active = sorted.filter((item) => item.status !== REVIEW_STATUS.RESOLVED);
  const resolved = sorted.filter((item) => item.status === REVIEW_STATUS.RESOLVED).slice(-5000);
  target.reviewItems = [...resolved, ...active]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  return target;
}

export function activeReviewItems(state, now = new Date()) {
  synchroniseReviewItems(state, now);
  return (state.reviewItems || [])
    .filter((item) => item.status !== REVIEW_STATUS.RESOLVED && !(item.status === REVIEW_STATUS.SNOOZED && !due(item.snoozedUntil, now)))
    .sort(compareReviewPriority);
}

export function snoozedReviewItems(state, now = new Date()) {
  synchroniseReviewItems(state, now);
  return (state.reviewItems || [])
    .filter((item) => item.status === REVIEW_STATUS.SNOOZED && !due(item.snoozedUntil, now))
    .sort((left, right) => String(left.snoozedUntil).localeCompare(String(right.snoozedUntil)));
}

export function reviewInboxSummary(state, now = new Date()) {
  const active = activeReviewItems(state, now);
  const snoozed = snoozedReviewItems(state, now);
  const groups = groupReviewItems(active, state);
  return {
    active,
    snoozed,
    groups,
    total: groups.length,
    important: groups.filter((item) => item.priority === 'high').length,
    normal: groups.filter((item) => item.priority === 'normal').length,
    low: groups.filter((item) => item.priority === 'low').length
  };
}

export function groupReviewItems(items, state) {
  const groups = new Map();
  for (const item of items) {
    const key = item.type === 'uncategorised_payment' && item.groupKey
      ? `uncategorised_payment:${item.groupKey}`
      : item.id;
    const group = groups.get(key) || { id: key, type: item.type, priority: item.priority, items: [] };
    group.items.push(item);
    if (priorityRank(item.priority) < priorityRank(group.priority)) group.priority = item.priority;
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, presentation: reviewGroupPresentation(group, state) }))
    .sort((left, right) => compareReviewPriority(left, right));
}

export function reviewItemPresentation(item, state) {
  return reviewGroupPresentation({ type: item.type, items: [item], priority: item.priority }, state);
}

export function startReviewItem(state, itemId, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  if (item.status !== REVIEW_STATUS.SNOOZED) item.status = REVIEW_STATUS.IN_PROGRESS;
  item.updatedAt = validDate(now).toISOString();
  return state;
}

export function snoozeReviewItem(state, itemId, choice, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  const snoozedUntil = snoozeUntil(choice, now, state.profile?.paydayDay);
  if (!snoozedUntil) {
    const error = new Error(choice === 'payday' ? 'Payday is not known yet.' : 'Choose a supported snooze time.');
    error.code = REVIEW_DIAGNOSTIC_CODES.SNOOZE_INVALID;
    throw error;
  }
  item.status = REVIEW_STATUS.SNOOZED;
  item.snoozedUntil = snoozedUntil;
  item.updatedAt = validDate(now).toISOString();
  return state;
}

export function snoozeReviewGroup(state, itemIds, choice, now = new Date()) {
  for (const itemId of itemIds) snoozeReviewItem(state, itemId, choice, now);
  return state;
}

export function resolveReviewItem(state, itemId, decision, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  const timestamp = validDate(now).toISOString();

  if (item.type === 'possible_duplicate') {
    const transaction = (state.transactions || []).find((entry) => String(entry.id) === item.sourceId);
    if (!transaction || transaction.duplicateStatus !== 'possible' || transaction.reviewStatus !== 'pending') {
      return synchroniseReviewItems(state, now);
    }
    if (!['duplicate', 'both_genuine'].includes(decision)) throw resolutionError('Choose Duplicate or Both are genuine.');
    transaction.reviewStatus = decision === 'duplicate' ? 'rejected' : 'accepted';
    transaction.financiallyActive = decision === 'both_genuine' && !['pending', 'rejected'].includes(transaction.importReviewStatus);
    transaction.reviewedAt = timestamp;
    transaction.duplicateDecision = decision;
  } else if (item.type === 'import_conflict') {
    if (!['keep_current', 'ignore_import', 'apply_import'].includes(decision)) throw resolutionError('Choose how the uncertain import should be handled.');
    resolveImportConflict(state, item, decision, timestamp);
  } else if (!sourceResolved(state, item)) {
    throw resolutionError('Complete the underlying financial work before resolving this review item.');
  }

  item.status = REVIEW_STATUS.RESOLVED;
  item.snoozedUntil = null;
  item.updatedAt = timestamp;
  item.resolution = { decision, resolvedAt: timestamp };
  return synchroniseReviewItems(state, now);
}

export function selectCheckInReviewItems(state, now = new Date(), limit = 4) {
  const items = activeReviewItems(state, now);
  const selected = [];
  const important = items.find((item) => item.priority === 'high');
  if (important) selected.push(important);
  for (const item of items) {
    if (selected.includes(item)) continue;
    if (selected.length >= limit) break;
    selected.push(item);
  }
  return selected;
}

export function reviewRoute(item, state = {}) {
  if (!item) return { view: 'review' };
  if (item.type === 'uncategorised_payment' || item.type === 'possible_duplicate') return { view: 'transactions', type: 'transaction', id: item.sourceId };
  if (item.type === 'financial_action') return { view: item.sourceType === 'overdraft' ? 'overdrafts' : 'debts', type: item.sourceType, id: item.sourceId };
  if (item.sourceType === 'document') {
    const document = (state.documents || []).find((entry) => String(entry.id) === item.sourceId);
    if (document?.kind === 'statement') return { view: 'transactions', type: 'import', id: item.sourceId, controlId: 'importStatementButton' };
    if (document?.kind === 'credit-report') return { view: 'debts', type: 'import', id: item.sourceId, controlId: 'importCreditReportButton' };
    if (document?.kind === 'payslip') return { view: 'pay', type: 'import', id: item.sourceId, controlId: 'importPayslipButton' };
    return { view: 'documents', type: 'document', id: item.sourceId };
  }
  if (item.sourceType === 'importBatch') {
    const batch = (state.importBatches || []).find((entry) => String(entry.id) === item.sourceId);
    return { view: batch?.kind === 'statement' ? 'transactions' : 'debts', type: 'importBatch', id: item.sourceId };
  }
  if (item.sourceType === 'task') return { view: 'today', type: 'task', id: item.sourceId };
  return { view: 'review' };
}

export function knownPaydayDay(value) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null;
}

function reviewSources(state, now) {
  return [
    ...uncategorisedSources(state),
    ...duplicateSources(state),
    ...financialActionSources(state),
    ...importConflictSources(state),
    ...taskSources(state, now)
  ];
}

function uncategorisedSources(state) {
  const budgets = state.budgets || [];
  return (state.transactions || [])
    .filter((transaction) => transactionNeedsCategory(transaction, budgets))
    .map((transaction) => ({
      type: 'uncategorised_payment', priority: 'normal', sourceType: 'transaction', sourceId: transaction.id,
      groupKey: merchantKey(transaction), conditionKey: categoryConditionKey(transaction)
    }));
}

function duplicateSources(state) {
  return (state.transactions || [])
    .filter((transaction) => transaction.duplicateStatus === 'possible' && transaction.reviewStatus === 'pending')
    .map((transaction) => ({
      type: 'possible_duplicate', priority: 'high', sourceType: 'transaction', sourceId: transaction.id,
      groupKey: '', conditionKey: [transaction.duplicateCandidateId || '', transaction.date || '', transaction.incoming || 0, transaction.outgoing || 0].join('|')
    }));
}

function financialActionSources(state) {
  const output = [];
  for (const [sourceType, records] of [['debt', state.debts || []], ['overdraft', state.overdrafts || []]]) {
    for (const account of records) {
      const reasons = financialActionReasons(account, sourceType);
      if (!reasons.length) continue;
      output.push({
        type: 'financial_action', priority: reasons.some((reason) => ['conflict', 'over_limit', 'default_arrangement', 'arrears_arrangement'].includes(reason)) ? 'high' : 'normal',
        sourceType, sourceId: account.id, groupKey: '', conditionKey: reasons.sort().join('|')
      });
    }
  }
  return output;
}

function importConflictSources(state) {
  const output = [];
  for (const document of state.documents || []) {
    if (document.parseStatus !== 'needs_review') continue;
    output.push({ type: 'import_conflict', priority: 'high', sourceType: 'document', sourceId: document.id, groupKey: '', conditionKey: 'document-needs-review' });
  }
  for (const batch of state.importBatches || []) {
    if (batch.reconciliationState !== 'review-required' || batch.reviewDecision) continue;
    const requiresImportDecision = batch.kind === 'credit-report'
      ? Number(batch.reviewCount || 0) + Number(batch.conflictCount || 0) > 0
      : batch.kind === 'statement' && batch.reconciled === false;
    if (!requiresImportDecision) continue;
    output.push({
      type: 'import_conflict', priority: 'high', sourceType: 'importBatch', sourceId: batch.id,
      groupKey: '', conditionKey: [batch.documentId || '', batch.reviewCount || 0, batch.conflictCount || 0, batch.possibleDuplicateCount || 0].join('|')
    });
  }
  return output;
}

function taskSources(state, now) {
  const today = localDateKey(validDate(now));
  return (state.tasks || [])
    .filter((task) => !task.completedAt && (!task.snoozedUntil || String(task.snoozedUntil) <= today))
    .map((task) => ({ type: 'generated_action', priority: task.priority === 'high' ? 'high' : 'normal', sourceType: 'task', sourceId: task.id, groupKey: '', conditionKey: String(task.updatedAt || task.createdAt || '') }));
}

function transactionNeedsCategory(transaction, budgets) {
  if (!transaction || transaction.deletedAt || transaction.ignored === true || transaction.valid === false) return false;
  if (transaction.duplicateStatus === 'exact' || transaction.reviewStatus === 'rejected' || transaction.financiallyActive === false) return false;
  if (Number(transaction.outgoing || 0) <= 0 || normalise(transaction.category) === 'income') return false;
  if (['transfer', 'savings_transfer', 'debt_payment', 'ignored'].includes(normalise(transaction.budgetTreatment))) return false;
  if (transaction.transferStatus === 'confirmed') return false;
  if (transaction.budgetCategoryId && budgets.some((budget) => String(budget.id) === String(transaction.budgetCategoryId))) return false;
  if (transaction.categorySource === 'manual') return !normalise(transaction.category);
  const category = normalise(transaction.category);
  const description = normalise(transaction.description);
  const matches = budgets.filter((budget) => {
    const categories = (budget.categories?.length ? budget.categories : [budget.category]).map(normalise);
    const terms = (budget.merchantTerms || []).map(normalise).filter(Boolean);
    return (category && categories.includes(category)) || terms.some((term) => description.includes(term));
  });
  return matches.length !== 1;
}

function financialActionReasons(account, sourceType) {
  if (!account || Number(account.currentBalance || 0) <= 0 || account.includeInPlan === false) return [];
  const reasons = [];
  const status = normalise(account.status).replace(/ /g, '_');
  const arrangement = normalise(account.arrangementStatus);
  const limit = finiteOrNull(sourceType === 'overdraft' ? account.limit : account.creditLimit);
  if (account.statusConflict === true) reasons.push('conflict');
  if (status === 'unknown' || !status) reasons.push('unknown_status');
  if (Number.isFinite(limit) && Number(account.currentBalance) > limit) reasons.push('over_limit');
  if (status === 'defaulted' && arrangement !== 'confirmed') reasons.push('default_arrangement');
  else if (status === 'arrears' && arrangement !== 'confirmed') reasons.push('arrears_arrangement');
  else if (!arrangement || arrangement === 'unknown') reasons.push('unknown_arrangement');
  if (arrangement === 'confirmed' && !knownNonNegative(account.arrangementPayment)) reasons.push('arrangement_payment');
  if (arrangement === 'none' && ['current', 'over_limit'].includes(status) && !knownNonNegative(account.contractualPayment)) reasons.push('required_payment');
  if ((sourceType === 'overdraft' || revolvingCredit(account)) && !Number.isFinite(limit)) reasons.push('credit_limit');
  return [...new Set(reasons)];
}

function sourceResolved(state, item) {
  if (item.type === 'uncategorised_payment') {
    const transaction = (state.transactions || []).find((entry) => String(entry.id) === item.sourceId);
    return !transaction || !transactionNeedsCategory(transaction, state.budgets || []);
  }
  if (item.type === 'financial_action') {
    const collection = item.sourceType === 'overdraft' ? state.overdrafts : state.debts;
    const account = (collection || []).find((entry) => String(entry.id) === item.sourceId);
    return !account || financialActionReasons(account, item.sourceType).length === 0;
  }
  if (item.type === 'generated_action') {
    const task = (state.tasks || []).find((entry) => String(entry.id) === item.sourceId);
    return !task || Boolean(task.completedAt);
  }
  return false;
}

function resolveImportConflict(state, item, decision, timestamp) {
  if (item.sourceType === 'document') {
    const document = (state.documents || []).find((entry) => String(entry.id) === item.sourceId);
    if (!document || document.parseStatus !== 'needs_review') throw resolutionError('This document no longer has an unresolved import review.');
    if (decision !== 'ignore_import') throw resolutionError('Choose Keep document only for this unresolved import.');
    document.parseStatus = 'ignored';
    document.reviewedAt = timestamp;
    return;
  }
  const batch = (state.importBatches || []).find((entry) => String(entry.id) === item.sourceId);
  if (!batch || batch.reconciliationState !== 'review-required') throw resolutionError('This import conflict is no longer available.');
  const statementDecision = batch.kind === 'statement' && ['keep_current', 'apply_import'].includes(decision);
  if (!statementDecision && decision !== 'keep_current') throw resolutionError('Choose how this imported conflict should be handled.');
  batch.reviewDecision = decision;
  batch.reviewedAt = timestamp;
  if (batch.kind === 'statement') {
    for (const transaction of state.transactions || []) {
      if (transaction.sourceDocumentId !== batch.documentId && !(transaction.sourceDocumentIds || []).includes(batch.documentId)) continue;
      transaction.importReviewStatus = decision === 'apply_import' ? 'accepted' : 'rejected';
      transaction.financiallyActive = decision === 'apply_import'
        && transaction.duplicateStatus !== 'exact'
        && !(transaction.duplicateStatus === 'possible' && transaction.reviewStatus !== 'accepted');
      transaction.importReviewedAt = timestamp;
    }
    return;
  }
  const report = (state.creditReports || []).find((entry) => entry.id === batch.sourceReportId);
  for (const account of [...(state.debts || []), ...(state.overdrafts || [])]) {
    if (!report || account.sourceCreditReportId !== report.id) continue;
    account.statusConflict = false;
    account.reviewedReportedStatus = account.reportedStatus || '';
    account.statusReviewedAt = timestamp;
  }
}

function reviewGroupPresentation(group, state) {
  const item = group.items[0];
  if (group.type === 'uncategorised_payment') {
    const transactions = group.items.map((entry) => (state.transactions || []).find((transaction) => String(transaction.id) === entry.sourceId)).filter(Boolean);
    const merchant = displayGroupMerchant(transactions[0]);
    const count = transactions.length;
    return {
      title: count > 1 ? `${count} ${merchant} payments need categorising` : 'Payment needs a category',
      detail: count > 1 ? 'Choose the right category for each payment. The group updates as you work.' : paymentDetail(transactions[0]),
      why: 'OneStep could not match this spending to exactly one budget category.', action: 'Categorise', consequence: 'Categorised spending will be included in the correct budget totals.'
    };
  }
  if (group.type === 'possible_duplicate') {
    const transaction = (state.transactions || []).find((entry) => String(entry.id) === item.sourceId);
    return {
      title: 'Possible duplicate payment', detail: paymentDetail(transaction),
      why: 'This payment looks similar to an existing one, so it is excluded from trusted totals until you decide.', action: 'Review duplicate',
      consequence: 'Choosing Duplicate keeps it excluded; Both are genuine includes it in trusted totals.'
    };
  }
  if (group.type === 'financial_action') {
    const collection = item.sourceType === 'overdraft' ? state.overdrafts : state.debts;
    const account = (collection || []).find((entry) => String(entry.id) === item.sourceId);
    const reasons = financialActionReasons(account, item.sourceType);
    const arrangementReview = reasons.some((reason) => ['default_arrangement', 'arrears_arrangement', 'unknown_arrangement', 'arrangement_payment'].includes(reason));
    return {
      title: arrangementReview ? 'Check your payment arrangement' : `Confirm the details for ${account?.name || 'this account'}`,
      detail: financialReasonText(account, item.sourceType), why: 'OneStep is keeping financial safety cautious until the missing or conflicting details are confirmed.',
      action: 'Review account', consequence: 'Saving confirmed details updates Financial Safety and automatically clears this item when it is safe.'
    };
  }
  if (group.type === 'import_conflict') {
    const document = item.sourceType === 'document' ? (state.documents || []).find((entry) => String(entry.id) === item.sourceId) : null;
    const batch = item.sourceType === 'importBatch' ? (state.importBatches || []).find((entry) => String(entry.id) === item.sourceId) : null;
    const statementBatch = batch?.kind === 'statement';
    return {
      title: item.sourceType === 'document' ? 'Import needs a decision' : 'Imported information needs review',
      detail: document ? `${document.originalName || 'A saved document'} was kept without applying uncertain financial information.` : `${batch?.kind === 'credit-report' ? 'Credit-report' : 'Statement'} information was kept outside trusted decisions where it conflicted.`,
      why: 'OneStep could not apply this information safely without a deliberate choice.', action: item.sourceType === 'document' ? 'Retry import' : statementBatch ? 'Review imported payments' : 'Review affected accounts',
      consequence: item.sourceType === 'document' ? 'You can keep the encrypted document without importing it.' : statementBatch ? 'The stored payments stay outside trusted totals until you apply or reject them.' : 'You can deliberately keep the current trusted data.'
    };
  }
  const task = (state.tasks || []).find((entry) => String(entry.id) === item.sourceId);
  return { title: task?.title || 'Financial action', detail: task?.detail || task?.description || 'This action still needs completing.', why: 'This saved action remains open.', action: 'Continue', consequence: 'Completing the action removes it from active review.' };
}

function paymentDetail(transaction) {
  if (!transaction) return 'The payment is no longer available.';
  const direction = Number(transaction.incoming || 0) > 0 ? 'incoming' : 'outgoing';
  return `${displayMerchant(transaction)} · ${formatMoney(transaction[direction])}`;
}

function financialReasonText(account, sourceType) {
  const reasons = financialActionReasons(account, sourceType);
  if (reasons.includes('conflict')) return 'The recorded status conflicts with imported information.';
  if (reasons.includes('over_limit')) return 'This borrowing appears to be above its recorded limit.';
  if (reasons.includes('default_arrangement') || reasons.includes('arrears_arrangement')) return 'The account status is serious and its payment arrangement is not confirmed.';
  if (reasons.includes('unknown_status')) return 'The current account status is not known.';
  if (reasons.includes('unknown_arrangement') || reasons.includes('arrangement_payment')) return 'The payment-arrangement details are incomplete.';
  if (reasons.includes('required_payment')) return 'The required payment is not known.';
  if (reasons.includes('credit_limit')) return 'The borrowing limit is not known.';
  return 'Some safety-critical account details are missing.';
}

function migrateReviewItem(item, now) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const type = safeToken(item.type, 60);
  const sourceType = safeToken(item.sourceType, 40);
  const sourceId = String(item.sourceId || '').slice(0, 160);
  if (!type || !sourceType || !sourceId) return null;
  const status = REVIEW_STATUSES.has(item.status) ? item.status : REVIEW_STATUS.NEEDS_ATTENTION;
  const priority = REVIEW_PRIORITIES.has(item.priority) ? item.priority : 'normal';
  const createdAt = validIso(item.createdAt) ? item.createdAt : now;
  const updatedAt = validIso(item.updatedAt) ? item.updatedAt : createdAt;
  const snoozedUntil = status === REVIEW_STATUS.SNOOZED && validIso(item.snoozedUntil) ? item.snoozedUntil : null;
  const resolution = status === REVIEW_STATUS.RESOLVED && item.resolution && typeof item.resolution === 'object' && validIso(item.resolution.resolvedAt)
    ? { decision: safeToken(item.resolution.decision, 60) || 'source_resolved', resolvedAt: item.resolution.resolvedAt }
    : null;
  const migratedStatus = (status === REVIEW_STATUS.SNOOZED && !snoozedUntil) || (status === REVIEW_STATUS.RESOLVED && !resolution)
    ? REVIEW_STATUS.NEEDS_ATTENTION : status;
  return {
    id: reviewItemId(type, sourceType, sourceId), type, status: migratedStatus,
    priority, createdAt, updatedAt, snoozedUntil, sourceType, sourceId,
    groupKey: String(item.groupKey || '').slice(0, 160), conditionKey: String(item.conditionKey || '').slice(0, 500), resolution: migratedStatus === REVIEW_STATUS.RESOLVED ? resolution : null
  };
}

function createReviewItem(source, id, timestamp) {
  return {
    id, type: source.type, status: REVIEW_STATUS.NEEDS_ATTENTION, priority: source.priority,
    createdAt: timestamp, updatedAt: timestamp, snoozedUntil: null,
    sourceType: source.sourceType, sourceId: String(source.sourceId), groupKey: source.groupKey || '', conditionKey: source.conditionKey || '', resolution: null
  };
}

function requireOpenItem(state, itemId) {
  const item = (state.reviewItems || []).find((entry) => entry.id === itemId);
  if (!item || item.status === REVIEW_STATUS.RESOLVED) {
    const error = new Error('This review item is no longer active.');
    error.code = REVIEW_DIAGNOSTIC_CODES.STATE_INVALID;
    throw error;
  }
  return item;
}

function resolutionError(message) {
  const error = new Error(message);
  error.code = REVIEW_DIAGNOSTIC_CODES.RESOLUTION_FAILED;
  return error;
}

function snoozeUntil(choice, now, paydayDay) {
  const date = validDate(now);
  const target = new Date(date);
  target.setHours(9, 0, 0, 0);
  if (choice === 'tomorrow') target.setDate(target.getDate() + 1);
  else if (choice === 'next_week') target.setDate(target.getDate() + 7);
  else if (choice === 'weekend') {
    const days = (6 - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + (days || 7));
  } else if (choice === 'payday') {
    const day = knownPaydayDay(paydayDay);
    if (!day) return null;
    const candidate = nextPayday(target, day);
    target.setTime(candidate.getTime());
  } else return null;
  return target.toISOString();
}

function nextPayday(from, requestedDay) {
  const candidateFor = (year, month) => {
    const lastDay = new Date(year, month + 1, 0).getDate();
    return new Date(year, month, Math.min(requestedDay, lastDay), 9, 0, 0, 0);
  };
  let candidate = candidateFor(from.getFullYear(), from.getMonth());
  if (candidate <= from) candidate = candidateFor(from.getFullYear(), from.getMonth() + 1);
  return candidate;
}

function due(value, now) { return !validIso(value) || Date.parse(value) <= validDate(now).getTime(); }
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? new Date() : date; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function safeToken(value, length) { const token = String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, length); return token; }
function reviewItemId(type, sourceType, sourceId) { return `review:${safeToken(type, 60)}:${safeToken(sourceType, 40)}:${hashId(String(sourceId))}`; }
function hashId(value) { let hash = 2166136261; for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `${(hash >>> 0).toString(36)}-${value.length}`; }
function compareReviewPriority(left, right) { return priorityRank(left.priority) - priorityRank(right.priority) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id).localeCompare(String(right.id)); }
function priorityRank(value) { return ({ high: 0, normal: 1, low: 2 })[value] ?? 3; }
function normalise(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
function merchantKey(transaction) { return normalise(transaction.userDescription || transaction.description).replace(/\b\d+\b/g, '').trim().slice(0, 80) || 'other'; }
function displayMerchant(transaction) { return String(transaction?.userDescription || transaction?.description || 'Payment').trim().replace(/\s+/g, ' ').slice(0, 80); }
function displayGroupMerchant(transaction) { return displayMerchant(transaction).replace(/\b\d+\b/g, '').replace(/\s+/g, ' ').trim() || 'Related'; }
function categoryConditionKey(transaction) { return [transaction.budgetCategoryId || '', transaction.category || '', transaction.categorySource || '', transaction.budgetTreatment || ''].join('|'); }
function knownNonNegative(value) { return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0; }
function finiteOrNull(value) { return value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value); }
function revolvingCredit(item) { return /credit card|store card|revolving|catalogue/i.test(String(item?.type || '')); }
function formatMoney(value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
