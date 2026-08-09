import { createId } from './finance-core.js';
import { synchroniseReviewItems } from './review-lifecycle.js';

const SUPPORTED_TYPES = new Set([
  'credit-card', 'personal-loan', 'car-finance', 'hire-purchase', 'store-card',
  'catalogue-credit', 'overdraft', 'revolving-credit', 'other-loan'
]);
const INFORMATIONAL_TYPES = new Set(['mortgage', 'student-loan', 'communications']);
const HIGH_RISK_STATUSES = new Set(['defaulted', 'arrears', 'over_limit']);

export function buildCreditReportImportPlan(state, preview, documentId = '') {
  if (preview?.kind !== 'credit-report') throw new Error('Credit Report Intelligence only accepts credit-report previews.');
  const report = preview.records?.[0] || null;
  if (!report) return emptyPlan(documentId, preview);

  const existing = [
    ...(state.debts || []).map((account) => ({ account, kind: 'debt' })),
    ...(state.overdrafts || []).map((account) => ({ account, kind: 'overdraft' }))
  ];
  const usedIds = new Set();
  const seenReportedIdentities = new Set();
  const accountPlans = (report.accounts || []).map((account) => {
    const identity = reportedIdentity(account);
    if (identity && seenReportedIdentities.has(identity)) {
      return reviewPlan(account, accountKind(account), 'This report repeats the same lender, type and ending digits. OneStep will not count it twice.');
    }
    if (identity) seenReportedIdentities.add(identity);
    return planAccount(account, report, existing, usedIds);
  });
  const counts = countCategories(accountPlans);
  const warnings = unique([
    ...(preview.warnings || []),
    ...accountPlans.flatMap((item) => item.warnings || [])
  ]);

  return {
    kind: 'credit-report-import-plan',
    documentId,
    report,
    accountPlans,
    counts,
    warnings,
    canApply: true,
    basisToken: creditReportStateToken(state, preview, documentId)
  };
}

export function applyCreditReportImportPlan(state, preview, reviewedPlan, documentId = '', importedAt = new Date().toISOString()) {
  const currentPlan = buildCreditReportImportPlan(state, preview, documentId);
  if (currentPlan.basisToken !== reviewedPlan?.basisToken) {
    throw new Error('Financial information changed after this preview was prepared. Review the refreshed credit-report plan before importing.');
  }
  if (!currentPlan.report) throw new Error('This credit report contains no report record to import.');
  if ((state.importBatches || []).some((batch) => batch.documentId === documentId)) {
    throw new Error('This credit report already has a completed import batch.');
  }

  const next = structuredClone(state);
  next.creditReports ||= [];
  next.debts ||= [];
  next.overdrafts ||= [];
  next.importBatches ||= [];
  const report = { ...structuredClone(currentPlan.report), sourceDocumentId: documentId };
  if (next.creditReports.some((item) => item.id === report.id || (documentId && item.sourceDocumentId === documentId))) {
    throw new Error('This credit report is already recorded.');
  }

  const result = { addedDebts: 0, addedOverdrafts: 0, updated: 0, unchanged: 0, conflicts: 0, review: 0, ignored: 0 };
  for (const item of currentPlan.accountPlans) {
    if (item.category === 'new') {
      const record = createBorrowingRecord(item.account, report, item.kind, importedAt);
      if (item.kind === 'overdraft') {
        next.overdrafts.push(record);
        result.addedOverdrafts += 1;
      } else {
        next.debts.push(record);
        result.addedDebts += 1;
      }
      continue;
    }
    if (['match', 'update', 'conflict'].includes(item.category) && item.existingId) {
      const collection = item.kind === 'overdraft' ? next.overdrafts : next.debts;
      const existing = collection.find((entry) => entry.id === item.existingId);
      if (!existing) throw new Error('A reviewed credit-report account match is no longer available.');
      applyMatchedAccount(existing, item, report, importedAt);
      if (item.category === 'match') result.unchanged += 1;
      else if (item.category === 'conflict') result.conflicts += 1;
      else result.updated += 1;
      continue;
    }
    if (item.category === 'review') result.review += 1;
    else result.ignored += 1;
  }

  next.creditReports.push(report);
  const stateDocument = (next.documents || []).find((document) => document.id === documentId);
  if (stateDocument) stateDocument.parseStatus = 'imported';
  next.importBatches.push({
    id: createId('import'),
    documentId,
    kind: 'credit-report',
    importedAt,
    recordCount: currentPlan.accountPlans.filter((item) => ['new', 'update', 'conflict'].includes(item.category)).length,
    parsedRecordCount: currentPlan.accountPlans.length,
    reconciled: currentPlan.counts.review === 0 && currentPlan.counts.conflict === 0,
    reconciliationState: currentPlan.counts.review || currentPlan.counts.conflict ? 'review-required' : 'reconciled',
    sourceReportId: report.id,
    sourceProvider: normaliseProvider(report.provider),
    sourceReportDate: report.reportDate || '',
    matchedCount: currentPlan.counts.match + currentPlan.counts.update + currentPlan.counts.conflict,
    newCount: currentPlan.counts.new,
    reviewCount: currentPlan.counts.review,
    conflictCount: currentPlan.counts.conflict,
    ignoredCount: currentPlan.counts.ignore
  });
  return { state: synchroniseReviewItems(next, new Date(importedAt)), result };
}

export function normaliseCreditAccountType(value) {
  const text = normalise(value);
  if (/\b(?:current account|bank account)\b/.test(text) && /\boverdraft\b/.test(text)) return 'overdraft';
  if (/\boverdraft\b|\bcurrent account\b/.test(text)) return 'overdraft';
  if (/\bcredit card\b|\bcharge card\b/.test(text)) return 'credit-card';
  if (/\bstore card\b/.test(text)) return 'store-card';
  if (/\bcatalogue\b|\bmail order\b/.test(text)) return 'catalogue-credit';
  if (/\bhire purchase\b|\bhp agreement\b/.test(text)) return 'hire-purchase';
  if (/\bcar finance\b|\bvehicle finance\b|\bmotor finance\b/.test(text)) return 'car-finance';
  if (/\bmortgage\b/.test(text)) return 'mortgage';
  if (/\bstudent loan\b/.test(text)) return 'student-loan';
  if (/\bpersonal loan\b|\bunsecured loan\b/.test(text)) return 'personal-loan';
  if (/\brevolving credit\b|\bline of credit\b/.test(text)) return 'revolving-credit';
  if (/\bcommunications\b|\btelecom\b|\bmobile phone\b|\butilities\b/.test(text)) return 'communications';
  if (/\bloan\b|\bfinance\b|\bcredit agreement\b/.test(text)) return 'other-loan';
  return 'unknown';
}

export function normaliseCreditStatus(value) {
  const text = normalise(value);
  const riskText = text.replace(/\bno arrears\b|\bnot in arrears\b|\bnot defaulted\b|\bnot over[ -]?limit\b/g, ' ');
  if (/\bdefault(?:ed)?\b/.test(riskText)) return 'defaulted';
  if (/\barrears\b|\bdelinquent\b|\bpast due\b|\boverdue\b|\bmissed payment/.test(riskText)) return 'arrears';
  if (/\bover[ -]?limit\b|\babove (?:the )?limit\b/.test(riskText)) return 'over_limit';
  if (/\bsettled\b|\bsatisfied\b|\bpaid off\b/.test(text)) return 'settled';
  if (/\bclosed\b|\bterminated\b/.test(text)) return 'closed';
  if (/\bcurrent\b|\bup to date\b|\bsatisfactory\b|\bpaid as agreed\b|\bno arrears\b/.test(text)) return 'current';
  return 'unknown';
}

export function normaliseLender(value) {
  const key = normalise(value)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:the|bank|plc|limited|ltd|llp|incorporated|inc|company|co|uk)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const aliases = new Map([
    ['barclaycard', 'barclays'], ['barclays', 'barclays'],
    ['mbna', 'mbna'], ['mbna europe', 'mbna'],
    ['newday', 'newday'], ['new day', 'newday']
  ]);
  return aliases.get(key) || key;
}

export function normaliseAccountReference(value) {
  const compact = String(value || '').replace(/[^a-z0-9]/gi, '').toUpperCase();
  return compact.length >= 4 ? compact.slice(-4) : '';
}

function planAccount(account, report, existing, usedIds) {
  const kind = accountKind(account);
  const type = account.normalisedAccountType || normaliseCreditAccountType(account.accountType);
  const status = account.normalisedStatus || normaliseCreditStatus(account.status);
  const balance = finiteMoney(account.currentBalance);
  const warnings = [];

  if (!account.lender) return reviewPlan(account, kind, 'The lender could not be identified reliably.');
  if (account.jointAccount || account.disputed) return reviewPlan(account, kind, account.jointAccount ? 'Joint borrowing needs individual review.' : 'A disputed account needs individual review.');
  if (INFORMATIONAL_TYPES.has(type)) {
    return { account, kind, category: 'ignore', confidence: 'informational', reason: `${displayType(type)} is informational because OneStep does not yet model it safely.`, changes: [], warnings };
  }
  if (type === 'unknown') return reviewPlan(account, kind, 'The borrowing type is unclear, so OneStep will not guess where to add it.');

  const match = findAccountMatch(account, kind, existing.filter((item) => !usedIds.has(item.account.id)));
  if (match.status === 'ambiguous' || match.status === 'conflict') {
    return reviewPlan(account, kind, match.reason, match.candidates);
  }
  if (match.status === 'matched') {
    usedIds.add(match.item.account.id);
    const reconciliation = reconcileMatchedAccount(match.item.account, account, report, kind);
    const category = reconciliation.conflicts.length ? 'conflict' : reconciliation.changes.some((change) => change.apply) ? 'update' : 'match';
    return {
      account, kind, category, existingId: match.item.account.id, confidence: match.confidence,
      reason: match.reason, changes: reconciliation.changes,
      conflicts: reconciliation.conflicts, warnings: reconciliation.warnings,
      explanation: match.explanation
    };
  }

  if (balance === null) return reviewPlan(account, kind, 'The outstanding balance is missing or invalid.');
  if (status === 'settled' && balance > 0) return reviewPlan(account, kind, 'The report describes this account as settled but also shows an outstanding balance.');
  if (balance <= 0) {
    return { account, kind, category: 'ignore', confidence: 'high', reason: status === 'settled' ? 'Settled zero-balance history will not create active borrowing.' : 'A zero-balance historical account will not create active borrowing.', changes: [], warnings };
  }
  if (!SUPPORTED_TYPES.has(type)) return reviewPlan(account, kind, 'This account type is not supported for active borrowing.');
  return { account, kind, category: 'new', confidence: 'high', reason: 'No credible existing match was found for this positive-balance borrowing.', changes: [], warnings };
}

function findAccountMatch(reported, kind, existing) {
  const sameKind = existing.filter((item) => item.kind === kind);
  const sourceKey = accountSourceKey(reported);
  const sourceMatches = sameKind.filter((item) => item.account.sourceCreditAccountKey && item.account.sourceCreditAccountKey === sourceKey);
  if (sourceMatches.length === 1) return matched(sourceMatches[0], 'confirmed', 'Existing source relationship', 'Matched because this report account has the same stored source relationship.');
  if (sourceMatches.length > 1) return ambiguous(sourceMatches, 'More than one tracked account has the same source relationship.');

  const reference = normaliseAccountReference(reported.accountReference);
  const lender = normaliseLender(reported.lender);
  const type = reported.normalisedAccountType || normaliseCreditAccountType(reported.accountType);
  if (reference) {
    const referenceMatches = sameKind.filter((item) => normaliseAccountReference(item.account.accountReference) === reference);
    const compatible = referenceMatches.filter((item) => typesCompatible(item.account.type, type));
    const lenderMatches = compatible.filter((item) => normaliseLender(item.account.name) === lender);
    if (lenderMatches.length === 1) return matched(lenderMatches[0], 'high', 'Reference, lender and type', 'Matched because lender, account type and ending digits agree.');
    if (lenderMatches.length > 1) return ambiguous(lenderMatches, 'Several tracked accounts share the same lender, type and ending digits.');
    if (compatible.length === 1 && creditorTransferEvidence(compatible[0].account, reported)) {
      return matched(compatible[0], 'high', 'Reference and creditor-transfer evidence', 'Matched because ending digits, account type and account history support a creditor transfer.');
    }
    if (compatible.length) return ambiguous(compatible, 'The ending digits match, but the lender identity changed without enough evidence to confirm a creditor transfer.');
  }

  const lenderTypeMatches = sameKind.filter((item) => normaliseLender(item.account.name) === lender && typesCompatible(item.account.type, type));
  const compatibleReferences = lenderTypeMatches.filter((item) => referencesCompatible(item.account.accountReference, reported.accountReference));
  if (compatibleReferences.length === 1) {
    const candidate = compatibleReferences[0];
    const existingReference = normaliseAccountReference(candidate.account.accountReference);
    if (reference && existingReference && reference !== existingReference) return { status: 'conflict', candidates: [candidate], reason: 'Lender and type match, but the account ending digits conflict.' };
    if (!reference || !existingReference) {
      if (!strongHistoryEvidence(candidate.account, reported)) {
        return ambiguous([candidate], 'Lender and account type alone are not enough to prove this is the same account.');
      }
      return matched(candidate, 'high', 'Lender, type and account history', 'Matched because lender, account type and dated account history agree.');
    }
    return matched(candidate, 'high', 'Unique lender, type and reference', 'Matched because lender, account type and ending digits agree.');
  }
  if (compatibleReferences.length > 1) return ambiguous(compatibleReferences, 'Several tracked accounts share this lender and account type.');
  if (lenderTypeMatches.length) return { status: 'conflict', candidates: lenderTypeMatches, reason: 'A tracked account has the same lender and type, but its ending digits conflict.' };
  return { status: 'unmatched', candidates: [] };
}

function reconcileMatchedAccount(existing, reported, report, kind) {
  const changes = [];
  const conflicts = [];
  const warnings = [];
  const effectiveDate = factDate(reported, report);
  const balanceDate = existing.balanceEffectiveDate || existing.statementDate || existing.lastReportedAt || '';
  const sourceIsOlder = Boolean(effectiveDate && balanceDate && effectiveDate < balanceDate);
  const sourceDateUnknown = Boolean(balanceDate && !effectiveDate);
  const sameDateProviderConflict = Boolean(
    effectiveDate && balanceDate && effectiveDate === balanceDate
    && existing.balanceSourceProvider
    && normaliseProvider(existing.balanceSourceProvider) !== normaliseProvider(report.provider)
  );
  const incomingBalance = finiteMoney(reported.currentBalance);

  if (incomingBalance !== null && incomingBalance !== finiteMoney(existing.currentBalance)) {
    if (sourceIsOlder || sourceDateUnknown || sameDateProviderConflict) {
      conflicts.push('balance');
      const reason = sourceIsOlder ? 'older-than-current-balance' : sourceDateUnknown ? 'source-date-unknown' : 'same-date-provider-conflict';
      changes.push(change('currentBalance', existing.currentBalance, incomingBalance, false, reason));
      warnings.push(sourceIsOlder
        ? 'This report is older than the balance OneStep already has, so the newer balance will be kept.'
        : sourceDateUnknown
          ? 'The report date is unknown, so a dated tracked balance will be kept.'
          : 'Two providers report different balances on the same date, so the existing balance will be kept for review.');
    } else {
      changes.push(change('currentBalance', existing.currentBalance, incomingBalance, true, 'newer-reported-balance'));
      changes.push(change('balanceEffectiveDate', balanceDate, effectiveDate, true, 'balance-source-date'));
      changes.push(change('balanceSourceProvider', existing.balanceSourceProvider || '', normaliseProvider(report.provider), true, 'balance-source-provider'));
    }
  }

  addKnownFieldChange(changes, existing, reported, 'apr', 'apr', effectiveDate, balanceDate);
  addKnownFieldChange(changes, existing, reported, 'contractualPayment', 'contractualPayment', effectiveDate, balanceDate);
  const limitField = kind === 'overdraft' ? 'limit' : 'creditLimit';
  if (reported.creditLimit !== null && reported.creditLimit !== undefined) addKnownFieldChange(changes, existing, reported, limitField, 'creditLimit', effectiveDate, balanceDate);
  addKnownFieldChange(changes, existing, reported, 'originalBalance', 'originalBalance', effectiveDate, balanceDate);
  addKnownFieldChange(changes, existing, reported, 'arrearsAmount', 'arrearsAmount', effectiveDate, balanceDate);
  addTextFieldChange(changes, existing, reported, 'openedDate', 'openedDate');
  addTextFieldChange(changes, existing, reported, 'defaultDate', 'defaultDate');
  if (!existing.accountReference && reported.accountReference) changes.push(change('accountReference', existing.accountReference || '', reported.accountReference, true, 'source-supplied'));

  const existingStatus = normaliseStoredStatus(existing.status);
  const reportedStatus = reported.normalisedStatus || normaliseCreditStatus(reported.status);
  if (reported.status) changes.push(change('reportedStatus', existing.reportedStatus || '', reported.status, true, 'source-status'));
  if (reportedStatus === 'defaulted' && reported.defaultDate && existing.defaultDate !== reported.defaultDate) changes.push(change('defaultDate', existing.defaultDate || '', reported.defaultDate, true, 'explicit-default-date'));
  if (HIGH_RISK_STATUSES.has(existingStatus) && ['unknown', 'current', 'closed', 'settled'].includes(reportedStatus)) {
    if (reportedStatus !== 'unknown' && existingStatus !== reportedStatus) conflicts.push('status');
  } else if (HIGH_RISK_STATUSES.has(reportedStatus) && existingStatus !== reportedStatus) {
    changes.push(change('status', existing.status || 'unknown', reportedStatus, true, 'explicit-risk-status'));
  } else if (reportedStatus === 'current' && existingStatus === 'unknown' && !sourceIsOlder) {
    changes.push(change('status', existing.status || 'unknown', 'current', true, 'explicit-current-status'));
  }

  const reportedArrangement = normaliseArrangement(reported.arrangementStatus);
  const existingArrangement = normaliseArrangement(existing.arrangementStatus);
  if (reportedArrangement === 'confirmed') {
    if (existingArrangement !== 'confirmed') changes.push(change('arrangementStatus', existingArrangement, 'confirmed', true, 'explicit-arrangement'));
    if (reported.arrangementPayment !== null && reported.arrangementPayment !== undefined) addKnownFieldChange(changes, existing, reported, 'arrangementPayment', 'arrangementPayment', effectiveDate, balanceDate);
  } else if (reportedArrangement === 'none' && existingArrangement === 'unknown' && !sourceIsOlder) {
    changes.push(change('arrangementStatus', existingArrangement, 'none', true, 'explicit-no-arrangement'));
  } else if (reportedArrangement === 'none' && existingArrangement === 'confirmed') {
    conflicts.push('arrangement');
  }
  if (reported.interestFrozen === true && existing.interestFrozen !== true) changes.push(change('interestFrozen', Boolean(existing.interestFrozen), true, true, 'explicit-frozen-interest'));

  const lifecycle = reported.lifecycleStatus || lifecycleFromStatus(reportedStatus);
  if (lifecycle === 'closed' && existing.lifecycleStatus !== 'closed') changes.push(change('lifecycleStatus', existing.lifecycleStatus || 'unknown', 'closed', true, 'explicit-closure'));
  if (lifecycle === 'settled') {
    const settlementDate = reported.settledDate || effectiveDate;
    const newerPositiveBalance = finiteMoney(existing.currentBalance) > 0 && balanceDate && (!settlementDate || settlementDate < balanceDate);
    if (newerPositiveBalance) {
      conflicts.push('settlement');
      warnings.push('This settled record is older than the positive balance OneStep already has, so the borrowing will remain active.');
    } else if (incomingBalance === 0) {
      changes.push(change('lifecycleStatus', existing.lifecycleStatus || 'unknown', 'settled', true, 'explicit-settlement'));
      changes.push(change('includeInPlan', existing.includeInPlan !== false, false, true, 'settled-zero-balance'));
    }
  }

  if (reportedStatus === 'over_limit' || (incomingBalance !== null && finiteMoney(reported.creditLimit) !== null && incomingBalance > Number(reported.creditLimit))) {
    if (existingStatus !== 'defaulted' && existingStatus !== 'arrears' && existingStatus !== 'over_limit') changes.push(change('status', existing.status || 'unknown', 'over_limit', true, 'reported-over-limit'));
  }
  if (conflicts.length && existing.statusConflict !== true) changes.push(change('statusConflict', Boolean(existing.statusConflict), true, true, 'material-source-conflict'));
  return { changes: dedupeChanges(changes), conflicts: unique(conflicts), warnings: unique(warnings) };
}

function applyMatchedAccount(existing, item, report, importedAt) {
  for (const fieldChange of item.changes || []) if (fieldChange.apply) existing[fieldChange.field] = fieldChange.to;
  existing.arrangementConfirmed = normaliseArrangement(existing.arrangementStatus) === 'confirmed';
  existing.sourceCreditReportId = report.id;
  existing.sourceCreditReportIds = unique([...(existing.sourceCreditReportIds || []), report.id]);
  existing.sourceCreditAccountId = item.account.id;
  existing.sourceCreditAccountKey = accountSourceKey(item.account);
  existing.lastCreditReportAt = factDate(item.account, report);
  existing.updatedAt = importedAt;
}

function createBorrowingRecord(account, report, kind, importedAt) {
  const status = account.normalisedStatus || normaliseCreditStatus(account.status);
  const effectiveStatus = ['current', 'arrears', 'defaulted', 'over_limit'].includes(status) ? status : 'unknown';
  const limit = finiteMoney(account.creditLimit);
  const balance = finiteMoney(account.currentBalance) ?? 0;
  const arrangementStatus = normaliseArrangement(account.arrangementStatus);
  const lifecycleStatus = account.lifecycleStatus || lifecycleFromStatus(status);
  const common = {
    id: createId(kind),
    name: account.lender || 'Reported account',
    type: kind === 'overdraft' ? 'overdraft' : displayType(account.normalisedAccountType || normaliseCreditAccountType(account.accountType)),
    currentBalance: balance,
    apr: finiteMoney(account.apr),
    contractualPayment: finiteMoney(account.contractualPayment),
    originalBalance: finiteMoney(account.originalBalance),
    openedDate: account.openedDate || '',
    defaultDate: account.defaultDate || '',
    lastReportedAt: factDate(account, report),
    balanceEffectiveDate: factDate(account, report),
    balanceSourceProvider: normaliseProvider(report.provider),
    reportedStatus: account.status || '',
    status: limit !== null && balance > limit && !['defaulted', 'arrears'].includes(effectiveStatus) ? 'over_limit' : effectiveStatus,
    lifecycleStatus,
    includeInPlan: lifecycleStatus !== 'settled',
    arrangementConfirmed: arrangementStatus === 'confirmed',
    arrangementStatus,
    arrangementPayment: finiteMoney(account.arrangementPayment),
    arrearsAmount: finiteMoney(account.arrearsAmount),
    statusConflict: Boolean(account.statusConflict),
    interestFrozen: account.interestFrozen === true,
    planPriority: 999,
    accountReference: account.accountReference || '',
    sourceCreditReportId: report.id,
    sourceCreditReportIds: [report.id],
    sourceCreditAccountId: account.id,
    sourceCreditAccountKey: accountSourceKey(account),
    lastCreditReportAt: factDate(account, report),
    description: `Imported from ${report.provider || 'a credit-report provider'}${report.reportDate ? ` report dated ${report.reportDate}` : ' credit report'}.`,
    notes: 'Confirm any missing APR, required payment or arrangement information before planning optional overpayments.',
    updatedAt: importedAt
  };
  if (kind === 'overdraft') return { ...common, accountId: '', limit };
  return { ...common, creditLimit: limit };
}

function addKnownFieldChange(changes, existing, reported, targetField, sourceField, effectiveDate, existingDate) {
  const value = finiteMoney(reported[sourceField]);
  if (value === null || value === finiteMoney(existing[targetField])) return;
  const older = Boolean(effectiveDate && existingDate && effectiveDate < existingDate);
  changes.push(change(targetField, existing[targetField] ?? null, value, !older, older ? 'older-source-preserved' : 'source-supplied'));
}

function addTextFieldChange(changes, existing, reported, targetField, sourceField) {
  const value = String(reported[sourceField] || '');
  if (value && value !== String(existing[targetField] || '')) changes.push(change(targetField, existing[targetField] || '', value, true, 'source-supplied'));
}

function change(field, from, to, apply, reason) { return { field, from, to, apply, reason }; }
function matched(item, confidence, reason, explanation) { return { status: 'matched', item, confidence, reason, explanation, candidates: [item] }; }
function ambiguous(candidates, reason) { return { status: 'ambiguous', candidates, reason }; }
function reviewPlan(account, kind, reason, candidates = []) { return { account, kind, category: 'review', confidence: 'review', reason, candidates: candidates.map((item) => item.account?.id || item.id), changes: [], warnings: [reason] }; }
function normalise(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
function finiteMoney(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function normaliseProvider(value) { return normalise(value).replace(/\s+/g, '-'); }
function normaliseStoredStatus(value) { const status = normalise(value).replace(/ /g, '_'); return ['current', 'arrears', 'defaulted', 'over_limit', 'unknown'].includes(status) ? status : 'unknown'; }
function normaliseArrangement(value) { const status = normalise(value); if (/confirmed|arrangement|reduced payment|payment plan/.test(status)) return 'confirmed'; if (/^(?:none|no arrangement|not arranged)$/.test(status)) return 'none'; return 'unknown'; }
function lifecycleFromStatus(status) { return status === 'settled' ? 'settled' : status === 'closed' ? 'closed' : ['current', 'arrears', 'defaulted', 'over_limit'].includes(status) ? 'active' : 'unknown'; }
function accountKind(account) { return (account.normalisedAccountType || normaliseCreditAccountType(account.accountType)) === 'overdraft' ? 'overdraft' : 'debt'; }
function displayType(type) { return String(type || 'unknown').split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '); }
function typesCompatible(existingType, reportedType) { const existing = normaliseCreditAccountType(existingType); return existing === 'unknown' || reportedType === 'unknown' || existing === reportedType || (['car-finance', 'hire-purchase'].includes(existing) && ['car-finance', 'hire-purchase'].includes(reportedType)); }
function referencesCompatible(left, right) { const a = normaliseAccountReference(left); const b = normaliseAccountReference(right); return !a || !b || a === b; }
function factDate(account, report) { return account.updatedDate || account.reportedDate || report.reportDate || ''; }
function accountSourceKey(account) { return [normaliseLender(account.lender), account.normalisedAccountType || normaliseCreditAccountType(account.accountType), normaliseAccountReference(account.accountReference)].join('|'); }
function reportedIdentity(account) { const reference = normaliseAccountReference(account.accountReference); return reference ? accountSourceKey(account) : ''; }
function creditorTransferEvidence(existing, reported) { const sameOpened = Boolean(existing.openedDate && reported.openedDate && existing.openedDate === reported.openedDate); const sameBalance = finiteMoney(existing.currentBalance) !== null && finiteMoney(existing.currentBalance) === finiteMoney(reported.currentBalance); const transferText = normalise(`${reported.status || ''} ${reported.notes || ''} ${reported.originalLender || ''}`); return sameOpened || (sameBalance && /assigned|sold|transferred|purchased|collection|original lender/.test(transferText)); }
function strongHistoryEvidence(existing, reported) { return Boolean(existing.openedDate && reported.openedDate && existing.openedDate === reported.openedDate); }
function unique(values) { return [...new Set(values.filter(Boolean))]; }
function dedupeChanges(changes) { const map = new Map(); for (const item of changes) map.set(item.field, item); return [...map.values()]; }
function countCategories(plans) { const counts = { total: plans.length, match: 0, update: 0, new: 0, conflict: 0, review: 0, ignore: 0 }; for (const item of plans) counts[item.category] += 1; return counts; }
function emptyPlan(documentId, preview) { return { kind: 'credit-report-import-plan', documentId, report: null, accountPlans: [], counts: { total: 0, match: 0, update: 0, new: 0, conflict: 0, review: 0, ignore: 0 }, warnings: preview?.warnings || [], canApply: false, basisToken: '' }; }

function creditReportStateToken(state, preview, documentId) {
  return JSON.stringify({
    documentId,
    preview: {
      summary: preview.summary || {},
      report: preview.records?.[0] || null
    },
    debts: (state.debts || []).map(accountToken),
    overdrafts: (state.overdrafts || []).map(accountToken),
    creditReports: (state.creditReports || []).map((item) => [item.id, item.sourceDocumentId, item.reportDate]),
    importBatches: (state.importBatches || []).map((item) => [item.id, item.documentId, item.importedAt])
  });
}

function accountToken(item) {
  return [item.id, item.name, item.type, item.accountReference, item.currentBalance, item.balanceEffectiveDate, item.balanceSourceProvider, item.statementDate, item.lastReportedAt, item.apr, item.contractualPayment, item.creditLimit, item.limit, item.status, item.reportedStatus, item.defaultDate, item.arrangementStatus, item.arrangementPayment, item.arrearsAmount, item.lifecycleStatus, item.includeInPlan, item.sourceCreditAccountKey];
}
