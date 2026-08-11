const AUTOMATION_SAFETY = Object.freeze({
  SAFE_AUTOMATIC: 'safe_automatic',
  REVIEW_REQUIRED: 'review_required'
});

const AUTOMATION_CERTAINTY = Object.freeze({
  CERTAIN: 'certain',
  AMBIGUOUS: 'ambiguous',
  CONFLICTING: 'conflicting',
  INSUFFICIENT: 'insufficient'
});

export const STATEMENT_RECONCILIATION_CLASS = Object.freeze({
  EXACT_MATCH: 'exact_authoritative_match',
  COMPATIBLE_UPDATE: 'high_confidence_compatible_update',
  NEW_RECORD: 'new_record',
  POSSIBLE_DUPLICATE: 'possible_duplicate_conflict',
  REVIEW_REQUIRED: 'insufficient_evidence_review_required',
  NO_CHANGE: 'no_change'
});

const SAFE_FILL_FIELDS = Object.freeze([
  'providerTransactionId',
  'reference',
  'description',
  'runningBalance',
  'merchantName'
]);

export function buildStatementReconciliationPlan(state, preview, options = {}) {
  const documentId = String(options.documentId || '');
  const existing = Array.isArray(state?.transactions) ? state.transactions : [];
  const incoming = Array.isArray(preview?.records) ? preview.records : [];
  const exactPairs = new Map((options.duplicates?.exact || []).map((pair) => [String(pair.incoming?.id || ''), pair]));
  const indexes = buildExistingIndexes(existing);
  const items = incoming.map((record) => classifyRecord(record, indexes, exactPairs.get(String(record?.id || '')), documentId));
  return {
    kind: 'statement-reconciliation-plan',
    documentId,
    expectedRevision: normaliseRevision(state?.meta?.revision),
    items,
    counts: summarise(items)
  };
}

export function applyStatementReconciliationMatches(state, plan, options = {}) {
  if (!state || typeof state !== 'object') throw new TypeError('A financial state is required for statement reconciliation.');
  const expectedRevision = normaliseRevision(plan?.expectedRevision);
  const actualRevision = normaliseRevision(state?.meta?.revision);
  if (expectedRevision !== actualRevision) {
    const error = new Error('Financial information changed after this reconciliation preview was prepared. Review the refreshed statement plan before importing.');
    error.code = 'STATEMENT_RECONCILIATION_STALE_REVISION';
    throw error;
  }

  const documentId = String(options.documentId || plan?.documentId || '');
  const importBatchId = String(options.importBatchId || '');
  const importedAt = validIso(options.importedAt) || new Date().toISOString();
  const transactions = Array.isArray(state.transactions) ? state.transactions : [];
  let matchedAutomatically = 0;
  let automaticUpdates = 0;
  let noChange = 0;

  for (const item of plan?.items || []) {
    if (![STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH, STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE, STATEMENT_RECONCILIATION_CLASS.NO_CHANGE].includes(item.classification)) continue;
    const existing = transactions.find((transaction) => String(transaction?.id || '') === String(item.existingTransactionId || ''));
    if (!existing) {
      const error = new Error('A transaction selected for reconciliation is no longer available.');
      error.code = 'STATEMENT_RECONCILIATION_TARGET_MISSING';
      throw error;
    }
    if (manualConflictFields(existing, item.incoming).length) {
      const error = new Error('A manual transaction value changed before statement reconciliation could be applied.');
      error.code = 'STATEMENT_RECONCILIATION_MANUAL_CONFLICT';
      throw error;
    }

    const changedFields = applySafePatch(existing, item.patch || {});
    const provenanceChanged = attachProvenance(existing, {
      documentId,
      importBatchId,
      importedAt,
      evidence: item.evidence,
      classification: item.classification
    });
    if (changedFields.length || provenanceChanged) matchedAutomatically += 1;
    if (changedFields.length) automaticUpdates += 1;
    if (!changedFields.length && !provenanceChanged) noChange += 1;
  }

  return { matchedAutomatically, automaticUpdates, noChange };
}

function classifyRecord(record, indexes, exactPair, documentId) {
  if (!hasMinimumEvidence(record)) {
    return reviewItem(record, [], 'minimum-evidence-missing', AUTOMATION_CERTAINTY.INSUFFICIENT);
  }

  const providerMatches = providerCandidates(indexes, record);
  if (providerMatches.length > 1) {
    return reviewItem(record, providerMatches, 'multiple-provider-id-matches', AUTOMATION_CERTAINTY.AMBIGUOUS);
  }
  if (providerMatches.length === 1) {
    const providerMatch = providerMatches[0];
    if (manualConflictFields(providerMatch, record).length) {
      return reviewItem(record, [providerMatch], 'manual-value-conflict', AUTOMATION_CERTAINTY.CONFLICTING);
    }
    const patch = safeMissingFieldPatch(providerMatch, record);
    const alreadyLinked = documentId && sourceDocumentIds(providerMatch).includes(documentId);
    if (!Object.keys(patch).length && alreadyLinked) {
      return automaticItem(record, providerMatch, STATEMENT_RECONCILIATION_CLASS.NO_CHANGE, 'source-already-linked', {}, false);
    }
    return automaticItem(
      record, providerMatch, Object.keys(patch).length ? STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE : STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH,
      'provider-id', patch, true
    );
  }

  const coreCandidates = indexes.core.get(coreIdentityKey(record)) || [];
  const manualConflicts = coreCandidates.filter((candidate) => manualConflictFields(candidate, record).length);
  if (manualConflicts.length) {
    return reviewItem(record, coreCandidates, 'manual-value-conflict', AUTOMATION_CERTAINTY.CONFLICTING);
  }
  if (coreCandidates.length > 1) {
    return reviewItem(record, coreCandidates, 'multiple-plausible-matches', AUTOMATION_CERTAINTY.AMBIGUOUS);
  }

  const exact = exactPair?.existing || exactAuthoritativeCandidate(coreCandidates, record);
  if (exact) {
    const patch = safeMissingFieldPatch(exact, record);
    const alreadyLinked = documentId && sourceDocumentIds(exact).includes(documentId);
    if (!Object.keys(patch).length && alreadyLinked) {
      return automaticItem(record, exact, STATEMENT_RECONCILIATION_CLASS.NO_CHANGE, 'source-already-linked', {}, false);
    }
    const classification = Object.keys(patch).length
      ? STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE
      : STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH;
    const evidence = exactPair?.evidence || providerEvidence(exact, record) || 'transaction-identity';
    return automaticItem(record, exact, classification, evidence, patch, true);
  }

  if (coreCandidates.length === 1) {
    const candidate = coreCandidates[0];
    const evidence = compatibleEvidence(candidate, record);
    if (evidence) {
      const patch = safeMissingFieldPatch(candidate, record);
      if (Object.keys(patch).length) {
        return automaticItem(record, candidate, STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE, evidence, patch, true);
      }
    }
    return reviewItem(record, [candidate], 'compatible-core-without-deterministic-identity', AUTOMATION_CERTAINTY.AMBIGUOUS);
  }

  return {
    incoming: record,
    classification: STATEMENT_RECONCILIATION_CLASS.NEW_RECORD,
    existingTransactionId: '',
    candidateTransactionIds: [],
    patch: {},
    evidence: 'no-existing-core-match',
    safetyClass: AUTOMATION_SAFETY.SAFE_AUTOMATIC,
    certainty: AUTOMATION_CERTAINTY.CERTAIN,
    automatic: true
  };
}

function automaticItem(record, existing, classification, evidence, patch, automatic) {
  return {
    incoming: record,
    classification,
    existingTransactionId: String(existing?.id || ''),
    candidateTransactionIds: [String(existing?.id || '')].filter(Boolean),
    patch,
    evidence,
    safetyClass: AUTOMATION_SAFETY.SAFE_AUTOMATIC,
    certainty: AUTOMATION_CERTAINTY.CERTAIN,
    automatic
  };
}

function reviewItem(record, candidates, evidence, certainty) {
  return {
    incoming: record,
    classification: certainty === AUTOMATION_CERTAINTY.INSUFFICIENT
      ? STATEMENT_RECONCILIATION_CLASS.REVIEW_REQUIRED
      : STATEMENT_RECONCILIATION_CLASS.POSSIBLE_DUPLICATE,
    existingTransactionId: candidates.length === 1 ? String(candidates[0]?.id || '') : '',
    candidateTransactionIds: candidates.map((candidate) => String(candidate?.id || '')).filter(Boolean),
    patch: {},
    evidence,
    safetyClass: AUTOMATION_SAFETY.REVIEW_REQUIRED,
    certainty,
    automatic: false
  };
}

function summarise(items) {
  const count = (classification) => items.filter((item) => item.classification === classification).length;
  const exactMatches = count(STATEMENT_RECONCILIATION_CLASS.EXACT_MATCH);
  const automaticUpdates = count(STATEMENT_RECONCILIATION_CLASS.COMPATIBLE_UPDATE);
  const newTransactions = count(STATEMENT_RECONCILIATION_CLASS.NEW_RECORD);
  const possibleDuplicates = count(STATEMENT_RECONCILIATION_CLASS.POSSIBLE_DUPLICATE);
  const insufficientEvidence = count(STATEMENT_RECONCILIATION_CLASS.REVIEW_REQUIRED);
  const noChange = count(STATEMENT_RECONCILIATION_CLASS.NO_CHANGE);
  return {
    total: items.length,
    matchedAutomatically: exactMatches + automaticUpdates,
    exactMatches,
    automaticUpdates,
    newTransactions,
    needsReview: possibleDuplicates + insufficientEvidence,
    possibleDuplicates,
    insufficientEvidence,
    duplicatesIgnoredOrQuarantined: exactMatches + possibleDuplicates + noChange,
    noChange
  };
}

function hasMinimumEvidence(record) {
  if (!record || !String(record.accountId || '').trim() || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || ''))) return false;
  const incoming = moneyPennies(record.incoming);
  const outgoing = moneyPennies(record.outgoing);
  return (incoming > 0 && outgoing === 0) || (outgoing > 0 && incoming === 0);
}

function coreIdentityKey(item) {
  return [String(item?.accountId || ''), String(item?.date || ''), moneyPennies(item?.incoming), moneyPennies(item?.outgoing)].join('|');
}

function exactAuthoritativeCandidate(candidates, incoming) {
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (providerEvidence(candidate, incoming)) return candidate;
  const sameDescription = normalise(candidate.description) === normalise(incoming.description);
  const sameReference = normalise(candidate.reference) === normalise(incoming.reference);
  return sameDescription && sameReference ? candidate : null;
}

function compatibleEvidence(existing, incoming) {
  if (providerEvidence(existing, incoming)) return 'provider-id';
  const reference = nonEmptyEqual(existing.reference, incoming.reference);
  const description = nonEmptyEqualNormalised(existing.description, incoming.description);
  if (reference && description) return 'reference-and-description';
  if (reference && isMissing(existing.description) && !isMissing(incoming.description)) return 'reference-with-missing-description';
  if (description && isMissing(existing.reference) && !isMissing(incoming.reference)) return 'description-with-missing-reference';
  return '';
}

function buildExistingIndexes(existing) {
  const core = new Map();
  const provider = new Map();
  for (const candidate of existing || []) {
    addToIndex(core, coreIdentityKey(candidate), candidate);
    const providerId = String(candidate?.providerTransactionId || '').trim();
    if (providerId) addToIndex(provider, `${String(candidate?.accountId || '')}|${providerId}`, candidate);
  }
  return { core, provider };
}

function addToIndex(index, key, value) {
  const rows = index.get(key) || [];
  rows.push(value);
  index.set(key, rows);
}

function providerCandidates(indexes, incoming) {
  const providerId = String(incoming?.providerTransactionId || '').trim();
  if (!providerId) return [];
  return indexes.provider.get(`${String(incoming?.accountId || '')}|${providerId}`) || [];
}

function providerEvidence(existing, incoming) {
  const left = String(existing?.providerTransactionId || '').trim();
  const right = String(incoming?.providerTransactionId || '').trim();
  return left && right && left === right ? 'provider-id' : '';
}

function safeMissingFieldPatch(existing, incoming) {
  const patch = {};
  for (const field of SAFE_FILL_FIELDS) {
    if (!isMissing(existing?.[field]) || isMissing(incoming?.[field])) continue;
    patch[field] = incoming[field];
  }
  return patch;
}

function applySafePatch(existing, patch) {
  const changed = [];
  for (const [field, value] of Object.entries(patch || {})) {
    if (!SAFE_FILL_FIELDS.includes(field) || !isMissing(existing[field]) || isMissing(value)) continue;
    existing[field] = value;
    changed.push(field);
  }
  return changed;
}

function manualConflictFields(existing, incoming) {
  const conflicts = [];
  const manualPairs = [
    ['categorySource', 'category'],
    ['budgetCategorySource', 'budgetCategoryId'],
    ['merchantSource', 'merchantName'],
    ['descriptionSource', 'description']
  ];
  for (const [sourceField, valueField] of manualPairs) {
    if (String(existing?.[sourceField] || '').toLowerCase() !== 'manual') continue;
    if (isMissing(incoming?.[valueField]) || isMissing(existing?.[valueField])) continue;
    if (normalise(existing[valueField]) !== normalise(incoming[valueField])) conflicts.push(valueField);
  }
  return conflicts;
}

function attachProvenance(transaction, entry) {
  const beforeDocumentIds = sourceDocumentIds(transaction);
  const afterDocumentIds = [...new Set([...beforeDocumentIds, entry.documentId].filter(Boolean))];
  transaction.sourceDocumentIds = afterDocumentIds;
  if (!transaction.sourceDocumentId && entry.documentId) transaction.sourceDocumentId = entry.documentId;

  const history = Array.isArray(transaction.reconciliationProvenance) ? transaction.reconciliationProvenance : [];
  const provenanceKey = [entry.documentId, entry.importBatchId, entry.evidence, entry.classification].join('|');
  const alreadyRecorded = history.some((item) => [item?.documentId || '', item?.importBatchId || '', item?.evidence || '', item?.classification || ''].join('|') === provenanceKey);
  if (!alreadyRecorded && (entry.documentId || entry.importBatchId)) {
    transaction.reconciliationProvenance = [...history, {
      documentId: entry.documentId,
      importBatchId: entry.importBatchId,
      reconciledAt: entry.importedAt,
      evidence: entry.evidence,
      classification: entry.classification
    }];
  }
  return afterDocumentIds.length !== beforeDocumentIds.length || !alreadyRecorded;
}

function sourceDocumentIds(transaction) {
  return [...new Set([...(Array.isArray(transaction?.sourceDocumentIds) ? transaction.sourceDocumentIds : []), transaction?.sourceDocumentId].filter(Boolean).map(String))];
}

function moneyPennies(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Math.round((amount + Number.EPSILON) * 100) : Number.NaN;
}

function nonEmptyEqual(left, right) {
  return !isMissing(left) && !isMissing(right) && String(left).trim() === String(right).trim();
}

function nonEmptyEqualNormalised(left, right) {
  return !isMissing(left) && !isMissing(right) && normalise(left) === normalise(right);
}

function isMissing(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function normalise(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function normaliseRevision(value) {
  const revision = Number(value);
  return Number.isInteger(revision) && revision >= 0 ? revision : 0;
}

function validIso(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}
