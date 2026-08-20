import { deriveRecurringPatterns, RECURRING_CONFIDENCE } from './recurring-finance.js';

const STORAGE_KIND = 'subscription';
const MAX_RECORDS = 1000;
const MAX_TEXT = 200;
const CADENCE_FACTORS = Object.freeze({
  weekly: 52,
  fortnightly: 26,
  'four-weekly': 13,
  monthly: 12,
  quarterly: 4,
  annual: 1
});

export const SUBSCRIPTION_SOURCE = Object.freeze({ RECURRING: 'recurring_pattern', MANUAL: 'manual' });
export const SUBSCRIPTION_CLASSIFICATION = Object.freeze({
  CONFIRMED: 'confirmed',
  LIKELY: 'likely',
  UNCERTAIN: 'uncertain',
  MANUAL: 'manual'
});
export const SUBSCRIPTION_DECISION = Object.freeze({
  UNCONFIRMED: 'unconfirmed',
  CONFIRMED: 'confirmed',
  REJECTED: 'rejected'
});
export const SUBSCRIPTION_VISIBILITY = Object.freeze({ ACTIVE: 'active', HIDDEN: 'hidden' });
export const SUBSCRIPTION_CADENCE = Object.freeze(Object.fromEntries(Object.keys(CADENCE_FACTORS).map((value) => [value.toUpperCase().replace(/-/g, '_'), value])));

export function listSubscriptionRecords(state = {}) {
  const rows = Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [];
  const output = [];
  const seen = new Set();
  for (const envelope of rows) {
    if (envelope?.recordKind !== STORAGE_KIND) continue;
    const record = normaliseSubscriptionRecord(envelope.subscription);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    output.push(record);
    if (output.length >= MAX_RECORDS) break;
  }
  return output.sort(compareRecords);
}

export function activeSubscriptionRecords(state = {}) {
  return listSubscriptionRecords(state).filter((record) => (
    record.decisionState === SUBSCRIPTION_DECISION.CONFIRMED
    && record.visibility === SUBSCRIPTION_VISIBILITY.ACTIVE
  ));
}

export function deriveSubscriptionCandidates(state = {}, options = {}) {
  const records = listSubscriptionRecords(state);
  const recordsByPattern = new Map();
  for (const record of records) {
    if (record.source !== SUBSCRIPTION_SOURCE.RECURRING || !record.sourcePatternId) continue;
    if (!recordsByPattern.has(record.sourcePatternId)) recordsByPattern.set(record.sourcePatternId, []);
    recordsByPattern.get(record.sourcePatternId).push(record);
  }

  const includeResolved = options.includeResolved === true;
  const includeHidden = options.includeHidden === true;
  return deriveRecurringPatterns(state, { includeRejected: true })
    .filter((pattern) => pattern.direction === 'outgoing')
    .map((pattern) => {
      const history = (recordsByPattern.get(String(pattern.id)) || []).sort(compareRecordsNewestFirst);
      const current = history.find((record) => record.sourceEvidenceFingerprint === String(pattern.evidenceFingerprint));
      const previous = current ? null : history[0] || null;
      if (current && !includeResolved && current.decisionState !== SUBSCRIPTION_DECISION.UNCONFIRMED) return null;
      if (current && !includeHidden && current.visibility === SUBSCRIPTION_VISIBILITY.HIDDEN) return null;
      return candidateFromPattern(pattern, current, previous);
    })
    .filter(Boolean)
    .sort(compareCandidates);
}

export function buildSubscriptionModel(state = {}) {
  return {
    records: listSubscriptionRecords(state),
    active: activeSubscriptionRecords(state),
    candidates: deriveSubscriptionCandidates(state)
  };
}

export function confirmSubscriptionCandidate(state, candidateId, now = new Date()) {
  return decideSubscriptionCandidate(state, candidateId, SUBSCRIPTION_DECISION.CONFIRMED, now);
}

export function rejectSubscriptionCandidate(state, candidateId, now = new Date()) {
  return decideSubscriptionCandidate(state, candidateId, SUBSCRIPTION_DECISION.REJECTED, now);
}

export function createManualSubscription(state, input = {}, now = new Date()) {
  const timestamp = isoTimestamp(now);
  const providerName = safeText(input.providerName || input.name);
  const cadence = safeCadence(input.cadence);
  const amountRange = normaliseAmountRange(input.amountRange ?? input.amount);
  if (!providerName) throw new TypeError('A subscription needs a provider or service name.');
  if (!cadence) throw new TypeError('Choose a supported subscription billing cadence.');
  if (!amountRange) throw new TypeError('Enter a valid non-negative subscription amount or amount range.');

  const existing = listSubscriptionRecords(state);
  const id = safeRecordId(input.id) || `subscription_manual_${shortHash(`${providerName}|${input.accountId || ''}|${timestamp}|${existing.length}`)}`;
  if (existing.some((record) => record.id === id)) throw new Error('That subscription identifier is already in use.');
  const record = normaliseSubscriptionRecord({
    id,
    source: SUBSCRIPTION_SOURCE.MANUAL,
    classification: SUBSCRIPTION_CLASSIFICATION.MANUAL,
    decisionState: SUBSCRIPTION_DECISION.CONFIRMED,
    visibility: input.hidden === true ? SUBSCRIPTION_VISIBILITY.HIDDEN : SUBSCRIPTION_VISIBILITY.ACTIVE,
    providerName,
    accountId: safeText(input.accountId, 120),
    cadence,
    amountRange,
    expectedNextPayment: normaliseExpectedPayment(input.expectedNextPayment || input.nextPaymentDate),
    rankingExcluded: input.rankingExcluded === true,
    cancellationMetadataRef: safeReference(input.cancellationMetadataRef),
    sourcePatternId: '',
    sourceEvidenceFingerprint: '',
    supersedesRecordId: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    confirmedAt: timestamp,
    rejectedAt: null,
    hiddenAt: input.hidden === true ? timestamp : null
  });
  return persistRecord(state, record);
}

export function editSubscription(state, subscriptionId, patch = {}, now = new Date()) {
  const id = safeRecordId(subscriptionId);
  const existing = listSubscriptionRecords(state).find((record) => record.id === id);
  if (!existing) throw new Error('That subscription is no longer available.');
  const timestamp = isoTimestamp(now);
  const providerName = patch.providerName === undefined && patch.name === undefined
    ? existing.providerName : safeText(patch.providerName ?? patch.name);
  const cadence = patch.cadence === undefined ? existing.cadence : safeCadence(patch.cadence);
  const amountRange = patch.amountRange === undefined && patch.amount === undefined
    ? existing.amountRange : normaliseAmountRange(patch.amountRange ?? patch.amount);
  if (!providerName) throw new TypeError('A subscription needs a provider or service name.');
  if (!cadence) throw new TypeError('Choose a supported subscription billing cadence.');
  if (!amountRange) throw new TypeError('Enter a valid non-negative subscription amount or amount range.');

  const updated = normaliseSubscriptionRecord({
    ...existing,
    providerName,
    accountId: patch.accountId === undefined ? existing.accountId : safeText(patch.accountId, 120),
    cadence,
    amountRange,
    expectedNextPayment: patch.expectedNextPayment === undefined && patch.nextPaymentDate === undefined
      ? existing.expectedNextPayment
      : normaliseExpectedPayment(patch.expectedNextPayment ?? patch.nextPaymentDate),
    rankingExcluded: patch.rankingExcluded === undefined ? existing.rankingExcluded : patch.rankingExcluded === true,
    cancellationMetadataRef: patch.cancellationMetadataRef === undefined
      ? existing.cancellationMetadataRef : safeReference(patch.cancellationMetadataRef),
    updatedAt: timestamp
  });
  return persistRecord(state, updated);
}

export function setSubscriptionHidden(state, subscriptionId, hidden = true, now = new Date()) {
  const id = safeRecordId(subscriptionId);
  const existing = listSubscriptionRecords(state).find((record) => record.id === id);
  if (!existing) throw new Error('That subscription is no longer available.');
  const timestamp = isoTimestamp(now);
  return persistRecord(state, {
    ...existing,
    visibility: hidden ? SUBSCRIPTION_VISIBILITY.HIDDEN : SUBSCRIPTION_VISIBILITY.ACTIVE,
    hiddenAt: hidden ? timestamp : null,
    updatedAt: timestamp
  });
}

export function removeSubscription(state, subscriptionId, now = new Date()) {
  const id = safeRecordId(subscriptionId);
  const existing = listSubscriptionRecords(state).find((record) => record.id === id);
  if (!existing) throw new Error('That subscription is no longer available.');
  if (existing.source !== SUBSCRIPTION_SOURCE.MANUAL) return setSubscriptionHidden(state, id, true, now);
  const next = structuredClone(state || {});
  next.scheduledPayments = (Array.isArray(next.scheduledPayments) ? next.scheduledPayments : [])
    .filter((envelope) => !(envelope?.recordKind === STORAGE_KIND && envelope?.subscription?.id === id));
  return next;
}

export function normaliseRecurringCost(amountOrRange, cadence) {
  const amountRange = normaliseAmountRange(amountOrRange);
  const safe = safeCadence(cadence);
  if (!amountRange || !safe) return null;
  const annualFactor = CADENCE_FACTORS[safe];
  const variable = amountRange.min !== amountRange.max;
  const annual = scaleRange(amountRange, annualFactor, variable);
  const monthly = scaleRange(amountRange, annualFactor / 12, variable);
  return { cadence: safe, variable, source: { ...amountRange }, monthly, annual };
}

function decideSubscriptionCandidate(state, candidateId, decision, now) {
  const candidate = deriveSubscriptionCandidates(state, { includeResolved: true, includeHidden: true })
    .find((item) => item.id === String(candidateId || ''));
  if (!candidate) throw new Error('That subscription candidate is no longer available. Refresh and review the latest evidence.');
  const timestamp = isoTimestamp(now);
  const existing = candidate.recordId
    ? listSubscriptionRecords(state).find((record) => record.id === candidate.recordId)
    : null;
  const id = existing?.id || `subscription_recurring_${shortHash(`${candidate.sourcePatternId}|${candidate.sourceEvidenceFingerprint}`)}`;
  const record = normaliseSubscriptionRecord({
    ...(existing || {}),
    id,
    source: SUBSCRIPTION_SOURCE.RECURRING,
    classification: candidate.classification,
    decisionState: decision,
    visibility: SUBSCRIPTION_VISIBILITY.ACTIVE,
    providerName: existing?.providerName || candidate.providerName,
    accountId: existing?.accountId || candidate.accountId,
    cadence: existing?.cadence || candidate.cadence,
    amountRange: existing?.amountRange || candidate.amountRange,
    expectedNextPayment: existing?.expectedNextPayment || candidate.expectedNextPayment,
    rankingExcluded: existing?.rankingExcluded === true,
    cancellationMetadataRef: existing?.cancellationMetadataRef || null,
    sourcePatternId: candidate.sourcePatternId,
    sourceEvidenceFingerprint: candidate.sourceEvidenceFingerprint,
    supersedesRecordId: existing?.supersedesRecordId || candidate.previousRecordId || '',
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
    confirmedAt: decision === SUBSCRIPTION_DECISION.CONFIRMED ? timestamp : existing?.confirmedAt || null,
    rejectedAt: decision === SUBSCRIPTION_DECISION.REJECTED ? timestamp : null,
    hiddenAt: null
  });
  return persistRecord(state, record);
}

function candidateFromPattern(pattern, current, previous) {
  const classification = recurringClassification(pattern.confidence);
  const amountRange = normaliseAmountRange(pattern.amountRange);
  if (!amountRange) return null;
  return {
    id: `subscription_candidate_${shortHash(`${pattern.id}|${pattern.evidenceFingerprint}`)}`,
    recordId: current?.id || null,
    source: SUBSCRIPTION_SOURCE.RECURRING,
    sourcePatternId: String(pattern.id),
    sourceEvidenceFingerprint: String(pattern.evidenceFingerprint),
    classification,
    providerName: current?.providerName || safeText(pattern.label) || 'Recurring service',
    accountId: current?.accountId || safeText(pattern.accountId, 120),
    cadence: current?.cadence || safeCadence(pattern.cadence),
    amountRange: current?.amountRange || amountRange,
    expectedNextPayment: current?.expectedNextPayment || normaliseExpectedPayment(pattern.nextExpected),
    cost: normaliseRecurringCost(current?.amountRange || amountRange, current?.cadence || pattern.cadence),
    decisionState: current?.decisionState || SUBSCRIPTION_DECISION.UNCONFIRMED,
    visibility: current?.visibility || SUBSCRIPTION_VISIBILITY.ACTIVE,
    evidenceChanged: Boolean(previous),
    previousRecordId: previous?.id || null,
    previousDecision: previous?.decisionState || null,
    previousEvidenceFingerprint: previous?.sourceEvidenceFingerprint || null,
    occurrences: Number(pattern.occurrences || 0),
    why: String(pattern.why || '')
  };
}

function persistRecord(state, input) {
  const record = normaliseSubscriptionRecord(input);
  if (!record) throw new TypeError('The subscription record is invalid.');
  const next = structuredClone(state || {});
  const rows = Array.isArray(next.scheduledPayments) ? next.scheduledPayments : [];
  const envelope = storageEnvelope(record);
  const index = rows.findIndex((item) => item?.recordKind === STORAGE_KIND && item?.subscription?.id === record.id);
  if (index >= 0) rows.splice(index, 1, envelope);
  else {
    const validCount = rows.filter((item) => item?.recordKind === STORAGE_KIND && normaliseSubscriptionRecord(item.subscription)).length;
    if (validCount >= MAX_RECORDS) throw new Error(`OneStep supports up to ${MAX_RECORDS} saved subscription records.`);
    rows.push(envelope);
  }
  next.scheduledPayments = rows;
  return next;
}

function storageEnvelope(record) {
  return {
    id: record.id,
    recordKind: STORAGE_KIND,
    active: false,
    includedInBudget: true,
    status: 'resolved',
    amount: 0,
    outgoing: 0,
    payment: 0,
    subscription: structuredClone(record)
  };
}

function normaliseSubscriptionRecord(value) {
  if (!isPlainObject(value)) return null;
  const id = safeRecordId(value.id);
  const source = Object.values(SUBSCRIPTION_SOURCE).includes(value.source) ? value.source : '';
  const providerName = safeText(value.providerName || value.name);
  const cadence = safeCadence(value.cadence);
  const amountRange = normaliseAmountRange(value.amountRange ?? value.amount);
  if (!id || !source || !providerName || !cadence || !amountRange) return null;

  const recurring = source === SUBSCRIPTION_SOURCE.RECURRING;
  const sourcePatternId = recurring ? safeReference(value.sourcePatternId) : '';
  const sourceEvidenceFingerprint = recurring ? safeReference(value.sourceEvidenceFingerprint) : '';
  if (recurring && (!sourcePatternId || !sourceEvidenceFingerprint)) return null;
  const classification = source === SUBSCRIPTION_SOURCE.MANUAL
    ? SUBSCRIPTION_CLASSIFICATION.MANUAL
    : Object.values(SUBSCRIPTION_CLASSIFICATION).filter((item) => item !== SUBSCRIPTION_CLASSIFICATION.MANUAL).includes(value.classification)
      ? value.classification : SUBSCRIPTION_CLASSIFICATION.UNCERTAIN;
  const decisionState = source === SUBSCRIPTION_SOURCE.MANUAL
    ? SUBSCRIPTION_DECISION.CONFIRMED
    : Object.values(SUBSCRIPTION_DECISION).includes(value.decisionState) ? value.decisionState : SUBSCRIPTION_DECISION.UNCONFIRMED;
  const visibility = Object.values(SUBSCRIPTION_VISIBILITY).includes(value.visibility) ? value.visibility : SUBSCRIPTION_VISIBILITY.ACTIVE;
  return {
    id,
    source,
    classification,
    decisionState,
    visibility,
    providerName,
    accountId: safeText(value.accountId, 120),
    cadence,
    amountRange,
    expectedNextPayment: normaliseExpectedPayment(value.expectedNextPayment),
    rankingExcluded: value.rankingExcluded === true,
    cancellationMetadataRef: safeReference(value.cancellationMetadataRef),
    sourcePatternId,
    sourceEvidenceFingerprint,
    supersedesRecordId: safeRecordId(value.supersedesRecordId),
    createdAt: validIsoDate(value.createdAt) ? value.createdAt : null,
    updatedAt: validIsoDate(value.updatedAt) ? value.updatedAt : null,
    confirmedAt: validIsoDate(value.confirmedAt) ? value.confirmedAt : null,
    rejectedAt: validIsoDate(value.rejectedAt) ? value.rejectedAt : null,
    hiddenAt: validIsoDate(value.hiddenAt) ? value.hiddenAt : null
  };
}

function recurringClassification(confidence) {
  if (confidence === RECURRING_CONFIDENCE.CONFIRMED) return SUBSCRIPTION_CLASSIFICATION.CONFIRMED;
  if (confidence === RECURRING_CONFIDENCE.LIKELY) return SUBSCRIPTION_CLASSIFICATION.LIKELY;
  return SUBSCRIPTION_CLASSIFICATION.UNCERTAIN;
}

function normaliseAmountRange(value) {
  if (typeof value === 'number' || typeof value === 'string') {
    const exact = finiteNonNegative(value);
    return exact === null ? null : { min: roundMoney(exact), max: roundMoney(exact), typical: roundMoney(exact) };
  }
  if (!isPlainObject(value)) return null;
  const min = finiteNonNegative(value.min);
  const max = finiteNonNegative(value.max);
  if (min === null || max === null || min > max) return null;
  const fallbackTypical = (min + max) / 2;
  const typicalCandidate = finiteNonNegative(value.typical);
  const typical = Math.min(max, Math.max(min, typicalCandidate === null ? fallbackTypical : typicalCandidate));
  return { min: roundMoney(min), max: roundMoney(max), typical: roundMoney(typical) };
}

function normaliseExpectedPayment(value) {
  if (typeof value === 'string') {
    const date = localDateKey(value);
    return date ? { date, windowStart: date, windowEnd: date, toleranceDays: 0 } : null;
  }
  if (!isPlainObject(value)) return null;
  const date = localDateKey(value.date);
  if (!date) return null;
  const windowStart = localDateKey(value.windowStart) || date;
  const windowEnd = localDateKey(value.windowEnd) || date;
  const toleranceDays = Number.isInteger(Number(value.toleranceDays)) && Number(value.toleranceDays) >= 0 && Number(value.toleranceDays) <= 31
    ? Number(value.toleranceDays) : 0;
  return { date, windowStart, windowEnd, toleranceDays };
}

function scaleRange(range, factor, variable) {
  const output = {
    min: roundMoney(range.min * factor),
    max: roundMoney(range.max * factor),
    typical: roundMoney(range.typical * factor),
    exact: null
  };
  if (!variable) output.exact = output.typical;
  return output;
}

function compareRecords(left, right) {
  return String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || left.id.localeCompare(right.id);
}

function compareRecordsNewestFirst(left, right) {
  return String(right.updatedAt || right.createdAt || '').localeCompare(String(left.updatedAt || left.createdAt || '')) || right.id.localeCompare(left.id);
}

function compareCandidates(left, right) {
  const rank = { confirmed: 0, likely: 1, uncertain: 2, manual: 3 };
  return (rank[left.classification] - rank[right.classification]) || left.providerName.localeCompare(right.providerName) || left.id.localeCompare(right.id);
}

function safeCadence(value) {
  const cadence = String(value || '').trim().toLowerCase();
  return Object.hasOwn(CADENCE_FACTORS, cadence) ? cadence : '';
}

function safeRecordId(value) {
  const text = String(value || '').trim();
  return /^subscription_[a-z0-9][a-z0-9_-]{7,159}$/i.test(text) ? text : '';
}

function safeReference(value) {
  const text = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(text) ? text : null;
}

function safeText(value, max = MAX_TEXT) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError('A valid timestamp is required.');
  return date.toISOString();
}

function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function localDateKey(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? text : '';
}

function shortHash(value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
