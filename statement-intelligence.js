import {
  createId, detectRecurringTransactions, findDuplicateCandidates, matchInternalTransfers,
  isTransactionFinanciallyActive, matchStatementAccount, syncStatementAccount
} from './finance-core.js';

export function buildStatementImportPlan(state, preview, documentId = '') {
  if (preview?.kind !== 'statement') throw new Error('Statement Intelligence only accepts bank-statement previews.');
  const accounts = state.accounts || [];
  const accountMatch = matchStatementAccount(accounts, preview);
  const duplicates = findDuplicateCandidates(state.transactions || [], preview.records || []);
  const exactIds = new Set(duplicates.exact.map((item) => item.incoming.id));
  const possibleIds = new Set(duplicates.possible.map((item) => item.incoming.id));
  const newRecords = (preview.records || []).filter((record) => !exactIds.has(record.id));
  const trustedHistory = (state.transactions || []).filter(isTransactionFinanciallyActive);
  const trustedNewRecords = newRecords.filter((record) => !possibleIds.has(record.id));
  const recurring = detectRecurringTransactions(trustedHistory, trustedNewRecords);
  const transferMatches = matchInternalTransfers([...trustedHistory, ...trustedNewRecords], accounts)
    .filter((match) => trustedNewRecords.some((record) => record.id === match.debitId || record.id === match.creditId));
  const balance = balanceChangePlan(accountMatch.account, preview);
  const configuredCurrency = String(state.profile?.currency || 'GBP').toUpperCase();
  const statementCurrency = String(preview.accountIdentity?.currency || preview.summary?.currency || '').toUpperCase();
  const currencyConflict = Boolean(statementCurrency && statementCurrency !== configuredCurrency);
  const warnings = statementWarnings(preview, accountMatch, balance, currencyConflict, statementCurrency, configuredCurrency, possibleIds.size);
  const recordPlans = (preview.records || []).map((record) => ({
    record,
    action: exactIds.has(record.id) ? 'already-known' : possibleIds.has(record.id) ? 'needs-review' : 'add',
    recurring: recurring.find((item) => item.transactionId === record.id) || null,
    transfer: transferMatches.find((item) => item.debitId === record.id || item.creditId === record.id) || null
  }));
  const canApply = accountMatch.status === 'matched' && !currencyConflict && preview.records?.length > 0;

  return {
    kind: 'statement-import-plan',
    documentId,
    accountMatch,
    balance,
    recordPlans,
    duplicates,
    newRecords,
    recurring,
    transferMatches,
    warnings,
    currencyConflict,
    canApply,
    counts: {
      total: preview.records?.length || 0,
      new: newRecords.length,
      add: recordPlans.filter((item) => item.action === 'add').length,
      alreadyKnown: recordPlans.filter((item) => item.action === 'already-known').length,
      needsReview: recordPlans.filter((item) => item.action === 'needs-review').length,
      recurring: recurring.length,
      transfers: transferMatches.length
    },
    basisToken: statementStateToken(state, preview, documentId)
  };
}

export function applyStatementImportPlan(state, preview, reviewedPlan, documentId = '', importedAt = new Date().toISOString()) {
  const currentPlan = buildStatementImportPlan(state, preview, documentId);
  if (currentPlan.basisToken !== reviewedPlan?.basisToken) {
    throw new Error('Financial information changed after this preview was prepared. Review the refreshed statement plan before importing.');
  }
  if (!currentPlan.canApply) throw new Error(currentPlan.warnings[0] || 'This statement needs review before it can be imported.');
  if ((state.importBatches || []).some((batch) => batch.documentId === documentId)) {
    throw new Error('This statement already has a completed import batch.');
  }

  const next = structuredClone(state);
  next.transactions ||= [];
  next.importBatches ||= [];
  next.overdrafts ||= [];
  const recurringById = new Map(currentPlan.recurring.map((item) => [item.transactionId, item]));
  const possibleIds = new Set(currentPlan.duplicates.possible.map((item) => item.incoming.id));
  const addedIds = new Set();
  for (const duplicate of currentPlan.duplicates.exact) {
    const existing = next.transactions.find((item) => item.id === duplicate.existing.id);
    if (!existing || !documentId) continue;
    existing.sourceDocumentIds = [...new Set([...(existing.sourceDocumentIds || []), existing.sourceDocumentId, documentId].filter(Boolean))];
  }
  for (const record of currentPlan.newRecords) {
    const observation = recurringById.get(record.id);
    next.transactions.push({
      ...record,
      sourceDocumentId: documentId || record.sourceDocumentId || '',
      sourceDocumentIds: [...new Set([...(record.sourceDocumentIds || []), documentId || record.sourceDocumentId].filter(Boolean))],
      duplicateStatus: possibleIds.has(record.id) ? 'possible' : 'none',
      reviewStatus: possibleIds.has(record.id) ? 'pending' : 'not_required',
      financiallyActive: !possibleIds.has(record.id),
      recurring: record.recurring || observation?.confidence === 'confirmed',
      recurringObservation: observation || null
    });
    addedIds.add(record.id);
  }

  applyTransferEvidence(next.transactions, currentPlan.transferMatches, addedIds);
  const account = next.accounts.find((item) => item.id === currentPlan.accountMatch.account.id);
  const balanceAction = syncStatementAccount(next, account, preview, documentId);
  const stateDocument = (next.documents || []).find((document) => document.id === documentId);
  if (stateDocument) stateDocument.parseStatus = 'imported';
  next.importBatches.push({
    id: createId('import'),
    documentId,
    kind: 'statement',
    importedAt,
    recordCount: currentPlan.newRecords.length,
    parsedRecordCount: preview.records.length,
    exactDuplicateCount: currentPlan.counts.alreadyKnown,
    possibleDuplicateCount: currentPlan.counts.needsReview,
    reconciled: Boolean(preview.reconciled),
    reconciliationState: preview.reconciled ? 'reconciled' : 'review-required',
    statementStartDate: preview.summary?.statementStartDate || '',
    statementEndDate: preview.summary?.statementEndDate || '',
    accountId: account.id
  });
  return {
    state: next,
    result: {
      added: currentPlan.newRecords.length,
      alreadyKnown: currentPlan.counts.alreadyKnown,
      needsReview: currentPlan.counts.needsReview,
      balanceAction,
      recurring: currentPlan.counts.recurring,
      transfers: currentPlan.counts.transfers
    }
  };
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

function statementWarnings(preview, accountMatch, balance, currencyConflict, statementCurrency, configuredCurrency, possibleCount) {
  const warnings = [...(preview.warnings || [])];
  if (accountMatch.status === 'conflict') warnings.push('Account needs confirmation. The selected account conflicts with identifiers read from this statement, so OneStep will not apply it.');
  if (accountMatch.status === 'ambiguous') warnings.push(`Account needs confirmation. This statement could match ${accountMatch.candidates.length} accounts.`);
  if (accountMatch.status === 'unmatched') warnings.push('Account needs confirmation. OneStep could not safely match this statement to an account.');
  if (balance.action === 'historical-only') warnings.push('Statement transactions can be imported, but this statement is older than the balance OneStep already has. The current account balance will be preserved.');
  if (currencyConflict) warnings.push(`Currency needs review. This statement uses ${statementCurrency}, but this OneStep profile uses ${configuredCurrency}. No financial changes will be applied.`);
  if (possibleCount) warnings.push(`${possibleCount} transaction${possibleCount === 1 ? '' : 's'} look similar to existing payments but cannot be proven to be duplicates. They are marked for review and will remain visible.`);
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
    accountHint: preview.accountHint || '',
    preview: {
      reconciled: Boolean(preview.reconciled),
      identity: preview.accountIdentity || {},
      summary: preview.summary || {},
      records: (preview.records || []).map((item) => [item.id, item.accountId, item.date, item.incoming, item.outgoing, item.description, item.reference, item.runningBalance, item.providerTransactionId])
    },
    accounts: (state.accounts || []).map((item) => [item.id, item.institution, item.accountReference, item.type, item.currentBalance, item.statementDate]),
    transactions: (state.transactions || []).map((item) => [item.id, item.accountId, item.date, item.incoming, item.outgoing, item.description, item.reference, item.runningBalance, item.providerTransactionId]),
    overdrafts: (state.overdrafts || []).map((item) => [item.id, item.accountId, item.currentBalance, item.limit, item.status]),
    importBatches: (state.importBatches || []).map((item) => [item.id, item.documentId, item.importedAt])
  });
}
