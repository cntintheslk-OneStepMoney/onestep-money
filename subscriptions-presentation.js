import {
  SUBSCRIPTION_CLASSIFICATION,
  SUBSCRIPTION_PROTECTION,
  buildSubscriptionModel,
  normaliseRecurringCost
} from './subscription-model.js';

export const SUBSCRIPTION_FILTER = Object.freeze({
  ALL: 'all', ACTIVE: 'active', REVIEW: 'review', UNRANKED: 'unranked', PROTECTED: 'protected'
});
export const SUBSCRIPTION_SORT = Object.freeze({
  RANK_HIGH: 'rank-high', RANK_LOW: 'rank-low', COST_HIGH: 'cost-high', COST_LOW: 'cost-low', UPCOMING: 'upcoming', NAME: 'name'
});

export function buildSubscriptionsPresentation(state = {}, options = {}) {
  const model = buildSubscriptionModel(state);
  const accounts = new Map((Array.isArray(state.accounts) ? state.accounts : []).map((account) => [String(account.id || ''), account]));
  const activeRows = model.active.map((record) => recordRow(record, accounts));
  const candidateRows = model.candidates.map((candidate) => candidateRow(candidate, accounts));
  const rows = filterAndSortSubscriptionRows([...activeRows, ...candidateRows], options);
  return {
    rows,
    activeRows: filterAndSortSubscriptionRows(activeRows, options),
    candidateRows: filterAndSortSubscriptionRows(candidateRows, options),
    summary: {
      activeCount: activeRows.length,
      reviewCount: candidateRows.length,
      monthly: aggregateCost(activeRows.map((row) => row.cost?.monthly).filter(Boolean)),
      annual: aggregateCost(activeRows.map((row) => row.cost?.annual).filter(Boolean)),
      potentialSavings: null
    }
  };
}

export function filterAndSortSubscriptionRows(rows = [], options = {}) {
  const filter = Object.values(SUBSCRIPTION_FILTER).includes(options.filter) ? options.filter : SUBSCRIPTION_FILTER.ALL;
  const sort = Object.values(SUBSCRIPTION_SORT).includes(options.sort) ? options.sort : SUBSCRIPTION_SORT.RANK_HIGH;
  const filtered = rows.filter((row) => {
    if (filter === SUBSCRIPTION_FILTER.ACTIVE) return row.lifecycleStatus === 'active';
    if (filter === SUBSCRIPTION_FILTER.REVIEW) return row.lifecycleStatus === 'review';
    if (filter === SUBSCRIPTION_FILTER.UNRANKED) return row.lifecycleStatus === 'active' && row.rank === null;
    if (filter === SUBSCRIPTION_FILTER.PROTECTED) return row.lifecycleStatus === 'active' && row.protectionState !== SUBSCRIPTION_PROTECTION.NONE;
    return true;
  });
  return [...filtered].sort(rowComparator(sort));
}

function recordRow(record, accounts) {
  const cost = normaliseRecurringCost(record.amountRange, record.cadence);
  return {
    id: record.id,
    recordId: record.id,
    candidateId: null,
    providerName: record.providerName,
    accountId: record.accountId,
    accountName: accountLabel(record.accountId, accounts),
    cadence: record.cadence,
    amountRange: record.amountRange,
    cost,
    expectedNextPayment: record.expectedNextPayment,
    classification: record.classification,
    statusLabel: record.classification === SUBSCRIPTION_CLASSIFICATION.MANUAL ? 'Manual' : 'Confirmed by you',
    lifecycleStatus: 'active',
    rank: Number.isInteger(record.rank) && record.rank > 0 ? record.rank : null,
    protectionState: record.protectionState || SUBSCRIPTION_PROTECTION.NONE,
    notes: record.notes || '',
    source: record.source,
    sourcePatternId: record.sourcePatternId || null,
    sourceEvidenceFingerprint: record.sourceEvidenceFingerprint || null,
    cancellationMetadataRef: record.cancellationMetadataRef || null,
    evidenceChanged: false,
    why: ''
  };
}

function candidateRow(candidate, accounts) {
  return {
    id: candidate.id,
    recordId: candidate.recordId || null,
    candidateId: candidate.id,
    providerName: candidate.providerName,
    accountId: candidate.accountId,
    accountName: accountLabel(candidate.accountId, accounts),
    cadence: candidate.cadence,
    amountRange: candidate.amountRange,
    cost: candidate.cost || normaliseRecurringCost(candidate.amountRange, candidate.cadence),
    expectedNextPayment: candidate.expectedNextPayment,
    classification: candidate.classification,
    statusLabel: candidateStatusLabel(candidate.classification),
    lifecycleStatus: 'review',
    rank: null,
    protectionState: SUBSCRIPTION_PROTECTION.NONE,
    notes: '',
    source: candidate.source,
    sourcePatternId: candidate.sourcePatternId || null,
    sourceEvidenceFingerprint: candidate.sourceEvidenceFingerprint || null,
    cancellationMetadataRef: null,
    evidenceChanged: candidate.evidenceChanged === true,
    why: String(candidate.why || '')
  };
}

function candidateStatusLabel(classification) {
  if (classification === SUBSCRIPTION_CLASSIFICATION.CONFIRMED) return 'Strong match · needs confirmation';
  if (classification === SUBSCRIPTION_CLASSIFICATION.LIKELY) return 'Likely · needs confirmation';
  return 'Possible · needs confirmation';
}

function accountLabel(accountId, accounts) {
  const account = accounts.get(String(accountId || ''));
  return account?.name || account?.institution || (accountId ? 'Recorded account' : 'Account not recorded');
}

function aggregateCost(ranges) {
  if (!ranges.length) return { min: 0, max: 0, typical: 0, exact: 0, variable: false };
  const total = ranges.reduce((sum, range) => ({
    min: sum.min + Number(range.min || 0),
    max: sum.max + Number(range.max || 0),
    typical: sum.typical + Number(range.typical || 0),
    exact: sum.exact === null || range.exact === null ? null : sum.exact + Number(range.exact || 0)
  }), { min: 0, max: 0, typical: 0, exact: 0 });
  return {
    min: roundMoney(total.min), max: roundMoney(total.max), typical: roundMoney(total.typical),
    exact: total.exact === null ? null : roundMoney(total.exact), variable: total.exact === null
  };
}

function rowComparator(sort) {
  const byName = (left, right) => left.providerName.localeCompare(right.providerName, 'en-GB', { sensitivity: 'base', numeric: true }) || left.id.localeCompare(right.id);
  if (sort === SUBSCRIPTION_SORT.COST_HIGH) return (left, right) => costValue(right) - costValue(left) || byName(left, right);
  if (sort === SUBSCRIPTION_SORT.COST_LOW) return (left, right) => costValue(left) - costValue(right) || byName(left, right);
  if (sort === SUBSCRIPTION_SORT.UPCOMING) return (left, right) => nextPaymentValue(left) - nextPaymentValue(right) || byName(left, right);
  if (sort === SUBSCRIPTION_SORT.NAME) return byName;
  if (sort === SUBSCRIPTION_SORT.RANK_LOW) return (left, right) => rankLowValue(left) - rankLowValue(right) || byName(left, right);
  return (left, right) => rankHighValue(left) - rankHighValue(right) || byName(left, right);
}

function costValue(row) { return Number(row.cost?.monthly?.typical || 0); }
function nextPaymentValue(row) { const value = Date.parse(`${row.expectedNextPayment?.date || '9999-12-31'}T12:00:00Z`); return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER; }
function rankHighValue(row) { return row.lifecycleStatus === 'review' ? 2_000_000 : row.rank ?? 1_000_000; }
function rankLowValue(row) { return row.lifecycleStatus === 'review' ? 2_000_000 : row.rank === null ? 1_000_000 : 100_000 - row.rank; }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
