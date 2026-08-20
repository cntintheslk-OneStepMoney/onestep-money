import {
  SUBSCRIPTION_PROTECTION,
  activeSubscriptionRecords,
  buildSubscriptionModel,
  normaliseRecurringCost
} from './subscription-model.js';

const PREFERENCES_KIND = 'subscription_savings_preferences';
const PREFERENCES_ID = 'subscription_savings_preferences_v1';
const MAX_TARGET = 100_000_000;
const BLOCKED_LIFECYCLES = new Set(['review', 'cancellation_planned', 'cancellation_in_progress', 'cancelled', 'contract_ending']);

export const SUBSCRIPTION_SAVINGS_STATUS = Object.freeze({
  NO_TARGET: 'no_target', MET: 'met', PARTIAL: 'partial', NO_ELIGIBLE: 'no_eligible'
});
export const SUBSCRIPTION_SAVINGS_EXCLUSION = Object.freeze({
  NOT_CONFIRMED: 'not_confirmed', UNRANKED: 'unranked', PROTECTED: 'protected', LIFECYCLE: 'lifecycle',
  CONTRACT_RISK: 'contract_risk', FINANCIAL_SAFETY: 'financial_safety', COST_UNAVAILABLE: 'cost_unavailable'
});

export function readSubscriptionSavingsTarget(state = {}) {
  const rows = Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [];
  for (const row of rows) {
    if (row?.recordKind !== PREFERENCES_KIND) continue;
    const target = normaliseTarget(row.subscriptionSavingsPreferences?.monthlyTarget);
    if (target !== null) return target;
  }
  return 0;
}

export function setSubscriptionSavingsTarget(state, monthlyTarget, now = new Date()) {
  const target = normaliseTarget(monthlyTarget);
  if (target === null) throw new TypeError('Enter a valid non-negative monthly savings target.');
  const next = structuredClone(state || {});
  const rows = Array.isArray(next.scheduledPayments) ? next.scheduledPayments : [];
  const envelope = {
    id: PREFERENCES_ID,
    recordKind: PREFERENCES_KIND,
    active: false,
    includedInBudget: true,
    status: 'resolved',
    amount: 0,
    outgoing: 0,
    payment: 0,
    subscriptionSavingsPreferences: { monthlyTarget: target, updatedAt: timestamp(now) }
  };
  const index = rows.findIndex((row) => row?.recordKind === PREFERENCES_KIND);
  if (index >= 0) rows.splice(index, 1, envelope); else rows.push(envelope);
  next.scheduledPayments = rows;
  return next;
}

export function buildSubscriptionSavingsRecommendation(state = {}, options = {}) {
  const target = options.monthlyTarget === undefined ? readSubscriptionSavingsTarget(state) : normaliseTarget(options.monthlyTarget);
  const monthlyTarget = target === null ? 0 : target;
  const model = buildSubscriptionModel(state);
  const active = activeSubscriptionRecords(state);
  const lifecycleById = normaliseLookup(options.lifecycleById);
  const contractRiskIds = normaliseIdSet(options.contractRiskIds);
  const financialSafetyExcludedIds = normaliseIdSet(options.financialSafetyExcludedIds);
  const explicitExclusions = normaliseLookup(options.exclusionsById);
  const excluded = [];
  const eligible = [];

  for (const candidate of model.candidates) {
    excluded.push({ id: candidate.id, providerName: candidate.providerName, reason: SUBSCRIPTION_SAVINGS_EXCLUSION.NOT_CONFIRMED, detail: 'Recurring evidence still needs your confirmation.' });
  }

  for (const record of active) {
    const rank = validRank(record.rank);
    const protection = record.protectionState || SUBSCRIPTION_PROTECTION.NONE;
    const lifecycle = String(lifecycleById.get(record.id) || record.lifecycleStatus || 'active').toLowerCase();
    const explicit = explicitExclusions.get(record.id);
    let reason = null;
    let detail = '';
    if (!rank) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.UNRANKED; detail = 'Rank this subscription before OneStep uses it in value-based recommendations.'; }
    else if (protection !== SUBSCRIPTION_PROTECTION.NONE) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.PROTECTED; detail = `${protectionLabel(protection)} is authoritative and keeps this subscription out of cancellation recommendations.`; }
    else if (BLOCKED_LIFECYCLES.has(lifecycle)) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.LIFECYCLE; detail = `Lifecycle state “${lifecycle.replaceAll('_', ' ')}” is not eligible for a new cancellation recommendation.`; }
    else if (contractRiskIds.has(record.id)) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.CONTRACT_RISK; detail = 'Known or unresolved contract risk excludes this subscription.'; }
    else if (financialSafetyExcludedIds.has(record.id)) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.FINANCIAL_SAFETY; detail = 'Financial Safety excludes this subscription from the recommendation.'; }
    else if (explicit) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.FINANCIAL_SAFETY; detail = String(explicit); }
    const cost = normaliseRecurringCost(record.amountRange, record.cadence);
    if (!reason && !cost) { reason = SUBSCRIPTION_SAVINGS_EXCLUSION.COST_UNAVAILABLE; detail = 'A trustworthy recurring cost is not available.'; }
    if (reason) {
      excluded.push({ id: record.id, providerName: record.providerName, reason, detail });
      continue;
    }
    eligible.push({
      id: record.id,
      providerName: record.providerName,
      rank,
      protectionState: protection,
      cost,
      conservativeMonthlySaving: roundMoney(cost.monthly.min)
    });
  }

  eligible.sort((left, right) => right.rank - left.rank || compareText(left.providerName, right.providerName) || left.id.localeCompare(right.id));

  if (!(monthlyTarget > 0)) return result(SUBSCRIPTION_SAVINGS_STATUS.NO_TARGET, monthlyTarget, eligible, excluded, []);
  if (!eligible.length) return result(SUBSCRIPTION_SAVINGS_STATUS.NO_ELIGIBLE, monthlyTarget, eligible, excluded, []);

  const selected = [];
  let conservative = 0;
  for (const item of eligible) {
    if (conservative >= monthlyTarget) break;
    selected.push(item);
    conservative = roundMoney(conservative + item.conservativeMonthlySaving);
  }
  const status = conservative >= monthlyTarget ? SUBSCRIPTION_SAVINGS_STATUS.MET : SUBSCRIPTION_SAVINGS_STATUS.PARTIAL;
  return result(status, monthlyTarget, eligible, excluded, selected);
}

function result(status, monthlyTarget, eligible, excluded, selected) {
  const monthly = aggregate(selected.map((item) => item.cost.monthly));
  const annual = aggregate(selected.map((item) => item.cost.annual));
  const remainingGap = roundMoney(Math.max(0, monthlyTarget - monthly.min));
  const bottomPercent = eligible.length && selected.length ? Math.ceil((selected.length / eligible.length) * 100) : 0;
  return {
    status,
    monthlyTarget,
    selected: selected.map((item) => ({ ...item, cost: structuredClone(item.cost) })),
    monthly,
    annual,
    conservativeMonthlySaving: monthly.min,
    bottomPercent,
    remainingGap,
    eligibleCount: eligible.length,
    excluded: excluded.map((item) => ({ ...item })),
    meetsTarget: monthlyTarget > 0 && remainingGap === 0,
    adviceOnly: true
  };
}

function aggregate(ranges) {
  if (!ranges.length) return { min: 0, max: 0, typical: 0, exact: 0, variable: false };
  const total = ranges.reduce((sum, range) => ({
    min: sum.min + Number(range.min || 0), max: sum.max + Number(range.max || 0), typical: sum.typical + Number(range.typical || 0),
    exact: sum.exact === null || range.exact === null ? null : sum.exact + Number(range.exact || 0)
  }), { min: 0, max: 0, typical: 0, exact: 0 });
  return { min: roundMoney(total.min), max: roundMoney(total.max), typical: roundMoney(total.typical), exact: total.exact === null ? null : roundMoney(total.exact), variable: total.exact === null };
}
function normaliseTarget(value) {
  if (value === null || value === undefined || value === '') return value === '' ? 0 : null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= MAX_TARGET ? roundMoney(number) : null;
}
function validRank(value) { const number = Number(value); return Number.isInteger(number) && number > 0 ? number : null; }
function normaliseIdSet(value) { return new Set(Array.isArray(value) ? value.map(String) : value instanceof Set ? [...value].map(String) : []); }
function normaliseLookup(value) {
  if (value instanceof Map) return new Map([...value].map(([key, entry]) => [String(key), entry]));
  if (value && typeof value === 'object' && !Array.isArray(value)) return new Map(Object.entries(value).map(([key, entry]) => [String(key), entry]));
  return new Map();
}
function protectionLabel(value) { return value === SUBSCRIPTION_PROTECTION.ESSENTIAL ? 'Essential' : value === SUBSCRIPTION_PROTECTION.KEEP ? 'Keep' : 'Excluded'; }
function compareText(left, right) { return String(left || '').localeCompare(String(right || ''), 'en-GB', { sensitivity: 'base', numeric: true }); }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function timestamp(value) { const date = value instanceof Date ? value : new Date(value); if (Number.isNaN(date.getTime())) throw new TypeError('A valid timestamp is required.'); return date.toISOString(); }
