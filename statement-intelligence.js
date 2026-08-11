import {
  createId, detectRecurringTransactions, findDuplicateCandidates, matchInternalTransfers,
  isTransactionFinanciallyActive, matchStatementAccount, syncStatementAccount
} from './finance-core.js';
import { synchroniseReviewItems } from './review-lifecycle.js';
import {
  applyStatementReconciliationMatches,
  buildStatementReconciliationPlan,
  STATEMENT_RECONCILIATION_CLASS
} from './statement-reconciliation.js';

export function buildStatementImportPlan(state, preview, documentId = '') {
  if (preview?.kind !== 'statement') throw new Error('Statement Intelligence only accepts bank-statement previews.');
  const accounts = state.accounts || [];
  const accountMatch = matchStatementAccount(accounts, preview);
  const duplicates = findDuplicateCandidates(state.transactions || [], preview.records || []);
  const reconciliation = buildStatementReconciliationPlan(state, preview, { documentId, duplicates });
  const classificationById = new Map(reconciliation.items.map((item) => [String(item.incoming?.id || ''), item]));
  const reviewItems = reconciliation.items.filter((item) => item.safetyClass === 'review_required');
  const reviewIds = new Set(reviewItems.map((item) => String(item.incoming?.id || '')));
  const automaticMatches = reconciliation.items.filter((item) => [
    STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH,
    STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE,
    STATEMENT_RECONCILIATION_CLASS.NO_CHANGE
  ].includes(item.classification));
  const automaticMatchIds = new Set(automaticMatches.map((item) => String(item.incoming?.id || '')));
  const newRecords = (preview.records || []).filter((record) => !automaticMatchIds.has(String(record.id || '')));
  const trustedHistory = (state.transactions || []).filter(isTransactionFinanciallyActive);
  const trustedNewRecords = preview.reconciled ? newRecords.filter((record) => !reviewIds.has(String(record.id || ''))) : [];
  const recurring = detectRecurringTransactions(trustedHistory, trustedNewRecords);
  const transferMatches = matchInternalTransfers([...trustedHistory, ...trustedNewRecords], accounts)
    .filter((match) => trustedNewRecords.some((record) => record.id === match.debitId || record.id === match.creditId));
  const balance = balanceChangePlan(accountMatch.account, preview);
  const configuredCurrency = String(state.profile?.currency || 'GBP').toUpperCase();
  const statementCurrency = String(preview.accountIdentity?.currency || preview.summary?.currency || '').toUpperCase();
  const currencyConflict = Boolean(statementCurrency && statementCurrency !== configuredCurrency);
  const warnings = statementWarnings(preview, accountMatch, balance, currencyConflict, statementCurrency, configuredCurrency, reconciliation.counts.needsReview);
  const recordPlans = (preview.records || []).map((record) => {
    const reconciliationItem = classificationById.get(String(record.id || ''));
    return {
      record,
      action: reconciliationItem?.safetyClass === 'review_required'
        ? 'needs-review'
        : automaticMatchIds.has(String(record.id || '')) ? 'already-known' : 'add',
      reconciliation: reconciliationItem || null,
      recurring: recurring.find((item) => item.transactionId === record.id) || null,
      transfer: transferMatches.find((item) => item.debitId === record.id || item.creditId === record.id) || null
    };
  });
  const canApply = accountMatch.status === 'matched' && !currencyConflict && preview.records?.length > 0;

  return {
    kind: 'statement-import-plan',
    documentId,
    accountMatch,
    balance,
    recordPlans,
    duplicates,
    reconciliation,
    newRecords,
    recurring,
    transferMatches,
    warnings,
    currencyConflict,
    canApply,
    expectedRevision: reconciliation.expectedRevision,
    counts: {
      total: preview.records?.length || 0,
      new: reconciliation.counts.newTransactions,
      add: reconciliation.counts.newTransactions,
      alreadyKnown: reconciliation.counts.matchedAutomatically + reconciliation.counts.noChange,
      needsReview: reconciliation.counts.needsReview,
      recurring: recurring.length,
      transfers: transferMatches.length,
      matchedAutomatically: reconciliation.counts.matchedAutomatically,
      automaticUpdates: reconciliation.counts.automaticUpdates,
      duplicatesIgnoredOrQuarantined: reconciliation.counts.duplicatesIgnoredOrQuarantined,
      noChange: reconciliation.counts.noChange
    },
    basisToken: statementStateToken(state, preview, documentId)
  };
}

export function applyStatementImportPlan(state, preview, reviewedPlan, documentId = '', importedAt = new Date().toISOString(), options = {}) {
  const currentPlan = buildStatementImportPlan(state, preview, documentId);
  if (currentPlan.expectedRevision !== reviewedPlan?.expectedRevision) {
    throw stalePlanError();
  }
  if (currentPlan.basisToken !== reviewedPlan?.basisToken) {
    throw stalePlanError();
  }
  if (!currentPlan.canApply) throw new Error(currentPlan.warnings[0] || 'This statement needs review before it can be imported.');
  if ((state.importBatches || []).some((batch) => batch.documentId === documentId)) {
    const error = new Error('This statement already has a completed import batch. No duplicate changes were made.');
    error.code = 'STATEMENT_IMPORT_ALREADY_APPLIED';
    throw error;
  }

  const next = structuredClone(state);
  next.transactions ||= [];
  next.importBatches ||= [];
  next.overdrafts ||= [];
  const batchId = createId('import');
  const reconciliationResult = applyStatementReconciliationMatches(next, currentPlan.reconciliation, {
    documentId,
    importBatchId: batchId,
    importedAt
  });
  injectFault(options, 'after-existing-match-reconciliation');

  const recurringById = new Map(currentPlan.recurring.map((item) => [item.transactionId, item]));
  const reviewById = new Map(currentPlan.reconciliation.items
    .filter((item) => item.safetyClass === 'review_required')
    .map((item) => [String(item.incoming?.id || ''), item]));
  const addedIds = new Set();
  for (const record of currentPlan.newRecords) {
    const observation = recurringById.get(record.id);
    const review = reviewById.get(String(record.id || ''));
    next.transactions.push({
      ...record,
      sourceDocumentId: documentId || record.sourceDocumentId || '',
      sourceDocumentIds: [...new Set([...(record.sourceDocumentIds || []), documentId || record.sourceDocumentId].filter(Boolean))],
      reconciliationProvenance: [...(Array.isArray(record.reconciliationProvenance) ? record.reconciliationProvenance : []), {
        documentId,
        importBatchId: batchId,
        reconciledAt: importedAt,
        evidence: review?.evidence || 'new-statement-record',
        classification: review?.classification || STATEMENT_RECONCILIATION_CLASS.NEW_RECORD
      }],
      duplicateStatus: review ? 'possible' : 'none',
      reviewStatus: review ? 'pending' : 'not_required',
      importReviewStatus: preview.reconciled ? 'trusted' : 'pending',
      financiallyActive: Boolean(preview.reconciled) && !review,
      duplicateCandidateId: review?.existingTransactionId || '',
      duplicateCandidateIds: review?.candidateTransactionIds || [],
      reconciliationStatus: review ? 'review_required' : 'reconciled',
      reconciliationEvidence: review?.evidence || 'new-statement-record',
      recurring: record.recurring || (!review && observation?.confidence === 'confirmed'),
      recurringObservation: review ? null : observation || null
    });
    addedIds.add(record.id);
  }
  injectFault(options, 'after-new-records');

  applyTransferEvidence(next.transactions, currentPlan.transferMatches, addedIds);
  const account = next.accounts.find((item) => item.id === currentPlan.accountMatch.account.id);
  const balanceAction = syncStatementAccount(next, account, preview, documentId);
  const stateDocument = (next.documents || []).find((document) => document.id === documentId);
  if (stateDocument) stateDocument.parseStatus = 'imported';
  const needsReview = currentPlan.counts.needsReview > 0 || !preview.reconciled;
  next.importBatches.push({
    id: batchId,
    documentId,
    kind: 'statement',
    importedAt,
    recordCount: currentPlan.newRecords.length,
    parsedRecordCount: preview.records.length,
    exactDuplicateCount: currentPlan.reconciliation.counts.exactMatches,
    possibleDuplicateCount: currentPlan.reconciliation.counts.possibleDuplicates,
    reconciled: Boolean(preview.reconciled),
    reconciliationState: needsReview ? 'review-required' : 'reconciled',
    reconciliationSummary: {
      matchedAutomatically: currentPlan.counts.matchedAutomatically,
      automaticUpdates: currentPlan.counts.automaticUpdates,
      newTransactions: currentPlan.counts.new,
      needsReview: currentPlan.counts.needsReview,
      duplicatesIgnoredOrQuarantined: currentPlan.counts.duplicatesIgnoredOrQuarantined,
      noChange: currentPlan.counts.noChange
    },
    reviewCount: currentPlan.counts.needsReview,
    noChangeCount: currentPlan.counts.noChange,
    statementStartDate: preview.summary?.statementStartDate || '',
    statementEndDate: preview.summary?.statementEndDate || '',
    accountId: account.id
  });
  injectFault(options, 'before-review-synchronisation');
  const synchronised = synchroniseReviewItems(next, new Date(importedAt));
  injectFault(options, 'before-return');
  return {
    state: synchronised,
    result: {
      added: currentPlan.newRecords.length,
      newTransactions: currentPlan.counts.new,
      alreadyKnown: currentPlan.counts.alreadyKnown,
      matchedAutomatically: reconciliationResult.matchedAutomatically,
      automaticUpdates: reconciliationResult.automaticUpdates,
      needsReview: currentPlan.counts.needsReview,
      duplicatesIgnoredOrQuarantined: currentPlan.counts.duplicatesIgnoredOrQuarantined,
      noChange: reconciliationResult.noChange,
      balanceAction,
      recurring: currentPlan.counts.recurring,
      transfers: currentPlan.counts.transfers,
      awaitingImportReview: !preview.reconciled,
      reviewRequired: currentPlan.counts.needsReview > 0
    }
  };
}

function stalePlanError() {
  const error = new Error('Financial information changed after this preview was prepared. Review the refreshed statement plan before importing.');
  error.code = 'STATEMENT_RECONCILIATION_STALE_REVISION';
  return error;
}

function injectFault(options, point) {
  if (typeof options?.faultInjector !== 'function') return;
  options.faultInjector(point);
}

function balanceChangePlan(account, preview) {
  const closingBalance = Number(preview.summary?.closingBalance);
  const statementDate = preview.summary?.statementEndDate
    || (preview.records || []).map((item) => item.date).filter(Boolean).sort().at(-1)
    || '';
  if (!account) return { action: 'needs-review', reason: 'account-not-matched', statementDate, closingBalance: null };
  if (!preview.reconciled || !Number.isFinite(closingBalance)) return { action: 'no-update', reason: 'unreconciled', statementDate, closingBalance: null };
  if (!statementDate) return { action: 'no-update', reason: 'statement-date-unknown', statementDate: '', closingBalance };
  if (account.statementDate && account.statementDate > statementDate) {
    return { action: 'historical-only', reason: 'older-than-current-balance', statementDate, closingBalance, currentBalance: account.currentBalance };
  }
  return { action: 'update', reason: 'newer-reconciled-balance', statementDate, closingBalance, currentBalance: account.currentBalance };
}

function statementWarnings(preview, accountMatch, balance, currencyConflict, statementCurrency, configuredCurrency, reviewCount) {
  const warnings = [...(preview.warnings || [])];
  if (accountMatch.status === 'conflict') warnings.push('Account needs confirmation. The selected account conflicts with identifiers read from this statement, so OneStep will not apply it.');
  if (accountMatch.status === 'ambiguous') warnings.push(`Account needs confirmation. This statement could match ${accountMatch.candidates.length} accounts.`);
  if (accountMatch.status === 'unmatched') warnings.push('Account needs confirmation. OneStep could not safely match this statement to an account.');
  if (balance.action === 'historical-only') warnings.push('Statement transactions can be imported, but this statement is older than the balance OneStep already has. The current account balance will be preserved.');
  if (currencyConflict) warnings.push(`Currency needs review. This statement uses ${statementCurrency}, but this OneStep profile uses ${configuredCurrency}. No financial changes will be applied.`);
  if (reviewCount) warnings.push(`${reviewCount} transaction${reviewCount === 1 ? '' : 's'} cannot be reconciled automatically. They will stay outside trusted totals until reviewed.`);
  return [...new Set(warnings)];
}

function applyTransferEvidence(transactions, matches, addedIds) {
  for (const match of matches) {
    const debit = transactions.find((item) => item.id === match.debitId);
    const credit = transactions.find((item) => item.id === match.creditId);
    if (!debit || !credit) continue;
    if (match.confidence === 'confirmed') {
      debit.transferStatus = 'confirmed';
      credit.transferStatus = 'confirmed';
      debit.transferPairId = credit.id;
      credit.transferPairId = debit.id;
    } else {
      if (addedIds.has(debit.id) && debit.transferStatus !== 'confirmed') debit.transferStatus = 'possible';
      if (addedIds.has(credit.id) && credit.transferStatus !== 'confirmed') credit.transferStatus = 'possible';
    }
  }
}

function statementStateToken(state, preview, documentId) {
  return JSON.stringify({
    documentId,
    revision: Number.isInteger(state.meta?.revision) ? state.meta.revision : 0,
    accountHint: preview.accountHint || '',
    preview: {
      reconciled: Boolean(preview.reconciled),
      identity: preview.accountIdentity || {},
      summary: preview.summary || {},
      records: (preview.records || []).map((item) => [item.id, item.accountId, item.date, item.incoming, item.outgoing, item.description, item.reference, item.runningBalance, item.providerTransactionId])
    },
    accounts: (state.accounts || []).map((item) => [item.id, item.institution, item.accountReference, item.type, item.currentBalance, item.statementDate]),
    transactions: (state.transactions || []).map((item) => [
      item.id, item.accountId, item.date, item.incoming, item.outgoing, item.description, item.reference, item.runningBalance,
      item.providerTransactionId, item.category, item.categorySource, item.budgetCategoryId, item.budgetCategorySource,
      item.merchantName, item.merchantSource, item.descriptionSource, item.sourceDocumentId, item.sourceDocumentIds
    ]),
    overdrafts: (state.overdrafts || []).map((item) => [item.id, item.accountId, item.currentBalance, item.limit, item.status]),
    importBatches: (state.importBatches || []).map((item) => [item.id, item.documentId, item.importedAt])
  });
}
