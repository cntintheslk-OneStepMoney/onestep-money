import { buildCashFlowForecast } from './cash-flow-forecast.js';
import { buildDebtRecommendation, DEBT_RECOMMENDATION_STATUS } from './debt-recommendation-engine.js';
import { buildPaydayContext, PAYDAY_STATUS } from './payday-awareness.js';
import { buildUnifiedFinancialProfile, UNIFIED_FACT_STATUS } from './unified-financial-profile.js';

export const PAYDAY_ALLOCATION_VERSION = 1;
export const PAYDAY_ALLOCATION_STATUS = Object.freeze({
  WAITING_FOR_INCOME: 'waiting_for_income', READY: 'ready', BUDGET_SHORTFALL: 'budget_shortfall',
  PROTECTED_SHORTFALL: 'protected_shortfall', NEEDS_REVIEW: 'needs_review'
});
export const PAYDAY_FUNDING_STATUS = Object.freeze({
  FUNDED: 'funded', PARTIALLY_FUNDED: 'partially_funded', UNFUNDED: 'unfunded', NEEDS_REVIEW: 'needs_review'
});
export const PAYDAY_PLANNING_PREFERENCES_VERSION = 1;

export function normalisePaydayPlanningPreferences(value) {
  const source = plainObject(value) ? value : {};
  return {
    version: PAYDAY_PLANNING_PREFERENCES_VERSION,
    flexibleAllowance: moneyOrNull(source.flexibleAllowance),
    optionalDebtId: safeId(source.optionalDebtId),
    optionalDebtDeclined: source.optionalDebtDeclined === true,
    optionalSavingsTarget: moneyOrNull(source.optionalSavingsTarget) ?? 0,
    acceptedChoiceIds: [...new Set((Array.isArray(source.acceptedChoiceIds) ? source.acceptedChoiceIds : []).map(safeId).filter(Boolean))].slice(0, 100)
  };
}

export function setPaydayPlanningPreferences(state = {}, patch = {}) {
  const next = structuredClone(state || {});
  next.profile = plainObject(next.profile) ? next.profile : {};
  const current = normalisePaydayPlanningPreferences(next.profile.paydayPlanningPreferences);
  next.profile.paydayPlanningPreferences = normalisePaydayPlanningPreferences({ ...current, ...(patch || {}) });
  delete next.paydayAllocationPlan;
  delete next.paydayAllocationSnapshot;
  return next;
}

export function setPaydayPlanningChoiceAccepted(state = {}, choiceId, accepted = true) {
  const id = safeId(choiceId);
  if (!id) return structuredClone(state || {});
  const current = normalisePaydayPlanningPreferences(state?.profile?.paydayPlanningPreferences);
  const acceptedChoiceIds = accepted ? [...new Set([...current.acceptedChoiceIds, id])] : current.acceptedChoiceIds.filter((item) => item !== id);
  return setPaydayPlanningPreferences(state, { acceptedChoiceIds });
}

export function buildPaydayAllocationPlan(state = {}, options = {}) {
  const now = validDate(options.now);
  const today = validDateKey(options.today) ? options.today : localDateKey(now);
  const profile = options.profile || buildUnifiedFinancialProfile(state, { now });
  const payday = options.paydayContext || buildPaydayContext(state, { now });
  const forecast = options.forecast || buildCashFlowForecast(state, { now, profile, paydayContext: payday });
  const debt = options.debtRecommendation || buildDebtRecommendation(state, { now, profile, paydayContext: payday, forecast });
  const preferences = normalisePaydayPlanningPreferences(state?.profile?.paydayPlanningPreferences);
  const context = { today, profile, payday, forecast, debt, preferences };
  const received = receivedStreams(payday);
  const requested = safeId(options.streamId);
  const stream = requested ? received.find((item) => String(item.id) === requested) : received[0];
  return deepFreeze(stream ? activePlan(context, stream) : waitingPlan(context));
}

function waitingPlan(context) {
  const horizonDate = nextHorizon(context.payday, context.today);
  const budget = budgetCoverage(context.profile, 0, true, context.preferences);
  return finish(context, {
    id: `payday-allocation:${horizonDate || 'waiting'}`, status: PAYDAY_ALLOCATION_STATUS.WAITING_FOR_INCOME,
    income: null, horizonDate, availableForPlanning: 0,
    protectedCommitments: emptyGroup('protected_commitments'), requiredDebt: emptyGroup('required_debt'),
    buffer: allocation('buffer', 'Protected starter / emergency buffer', bufferShortfall(context.profile), 0, true),
    budget, optionalDebt: optionalDebt(context, 0, false), optionalSavings: optionalSavings(context, 0, true),
    leftoverUnallocated: 0,
    warnings: [{ code: 'income_not_received', explanation: 'Expected future income is not allocated until trusted received evidence exists.' }],
    blockerCodes: ['income_not_received']
  });
}

function activePlan(context, stream) {
  const received = round(moneyOrNull(stream?.received?.amount) ?? 0);
  const liquid = trustedLiquid(context.profile);
  const availableForPlanning = liquid === null ? 0 : round(Math.min(received, Math.max(0, liquid)));
  const horizonDate = nextHorizon(context.payday, context.today);
  const safe = context.payday?.safeUntilPayday || {};
  const blockers = [];
  const warnings = [];

  if (liquid === null) blockers.push('trusted_liquid_position_unavailable');
  if (!horizonDate) blockers.push('dependable_payday_unknown');
  if (safe.status !== 'available') blockers.push(...(safe.reasonCodes || ['safe_until_payday_unavailable']).map((code) => `payday_${safeId(code)}`));
  else if (safe.horizonDate !== horizonDate) blockers.push('payday_horizon_mismatch');
  if (context.forecast?.status === 'unavailable') blockers.push('forecast_unavailable');
  for (const item of context.forecast?.blockers || []) warnings.push({ code: `forecast_${safeId(item.code) || 'review'}`, explanation: String(item.explanation || item.reason || 'The forecast contains an unresolved safety condition.') });

  let remaining = availableForPlanning;
  const protectedTarget = round(nonNegative(safe?.protected?.scheduled) + nonNegative(safe?.protected?.recurring));
  const protectedCommitments = groupAllocation('protected_commitments', protectedItems(safe), protectedTarget, remaining);
  remaining = round(Math.max(0, remaining - protectedCommitments.funded));
  const debtTarget = round(nonNegative(safe?.protected?.debt));
  const requiredDebt = groupAllocation('required_debt', debtItems(safe), debtTarget, remaining);
  remaining = round(Math.max(0, remaining - requiredDebt.funded));
  const buffer = allocation('buffer', 'Protected starter / emergency buffer', nonNegative(safe?.protected?.buffer), Math.min(nonNegative(safe?.protected?.buffer), remaining), false);
  buffer.reason = 'The recorded starter / emergency buffer shortfall is protected before flexible or optional allocations.';
  buffer.choiceId = 'buffer';
  buffer.accepted = context.preferences.acceptedChoiceIds.includes('buffer');
  remaining = round(Math.max(0, remaining - buffer.funded));

  const protectedShortfall = round(protectedCommitments.shortfall + requiredDebt.shortfall + buffer.shortfall);
  if (protectedShortfall > 0) warnings.push({ code: 'protected_shortfall', explanation: 'Received trusted money does not fully cover known protected needs before the next dependable income.' });

  const hold = blockers.length > 0 || protectedShortfall > 0;
  const budget = budgetCoverage(context.profile, hold ? 0 : remaining, hold, context.preferences);
  if (!hold) remaining = round(Math.max(0, remaining - budget.funded));
  if (budget.shortfall > 0) warnings.push({ code: 'budget_shortfall', explanation: 'Part of the active Budget remains uncovered. Every Budget category stays visible; the gap is not treated as cash or borrowing.' });

  const canUseOptional = !hold && budget.shortfall === 0;
  const optional = optionalDebt(context, remaining, canUseOptional);
  remaining = round(Math.max(0, remaining - optional.funded));
  const savings = optionalSavings(context, remaining, !canUseOptional);
  remaining = round(Math.max(0, remaining - savings.funded));

  if (received > availableForPlanning && liquid !== null) warnings.push({ code: 'received_income_exceeds_current_liquid_cash', explanation: 'The plan is capped at the lower current trusted liquid amount rather than reallocating payday money that may already have been spent.' });
  for (const item of context.debt?.blockers || []) warnings.push({ code: `debt_${safeId(item.code) || 'review'}`, explanation: String(item.explanation || 'A debt safety condition blocks optional overpayment.') });

  const status = blockers.length ? PAYDAY_ALLOCATION_STATUS.NEEDS_REVIEW
    : protectedShortfall > 0 ? PAYDAY_ALLOCATION_STATUS.PROTECTED_SHORTFALL
      : budget.shortfall > 0 ? PAYDAY_ALLOCATION_STATUS.BUDGET_SHORTFALL : PAYDAY_ALLOCATION_STATUS.READY;

  return finish(context, {
    id: `payday-allocation:${safeId(stream.id) || 'income'}:${stream.received?.date || context.today}`, status,
    income: { streamId: String(stream.id || ''), name: String(stream.name || 'Received income'), receivedDate: stream.received?.date || context.today,
      amountReceived: received, sourceTypes: [...new Set(stream.received?.sourceTypes || [])], expectedAmountRange: stream.expectedAmountRange || null,
      expectedIncomeCountedAsCurrentCash: false },
    horizonDate, availableForPlanning, protectedCommitments, requiredDebt, buffer, budget,
    optionalDebt: optional, optionalSavings: savings, leftoverUnallocated: remaining,
    warnings: uniqueWarnings(warnings), blockerCodes: [...new Set(blockers)]
  });
}

function finish(context, values) {
  return {
    kind: 'payday-allocation-plan', version: PAYDAY_ALLOCATION_VERSION, derived: true, persist: false,
    asOf: context.today, sourceRevision: context.profile?.sourceRevision ?? null, currency: context.profile?.currency || 'GBP',
    preferences: { ...context.preferences, acceptedChoiceIds: [...context.preferences.acceptedChoiceIds] }, ...values,
    totals: { received: values.income?.amountReceived ?? 0, availableForPlanning: values.availableForPlanning,
      protectedCommitments: values.protectedCommitments.required, requiredDebt: values.requiredDebt.required,
      protectedBuffer: values.buffer.required, budgetRemaining: values.budget.required, budgetFunded: values.budget.funded,
      budgetShortfall: values.budget.shortfall, optionalDebt: values.optionalDebt.funded, optionalSavings: values.optionalSavings.funded,
      leftoverUnallocated: values.leftoverUnallocated },
    futureCoverage: { nextDependableIncomeDate: values.horizonDate || null, assumedFutureIncomeAmount: 0,
      budgetShortfallAwaitingLaterReceipt: values.budget.shortfall,
      treatment: values.budget.shortfall > 0 && values.horizonDate ? 'revisit_when_received' : 'none_required' },
    safety: { externalTransferMade: false, externalPaymentMade: false, automaticBorrowingUsed: false,
      futureExpectedIncomeAllocated: false, financialSafetyOverpaymentStatus: context.profile?.financialSafety?.overpaymentStatus || null,
      forecastStatus: context.forecast?.status || 'unavailable' },
    why: [
      'Only trusted income already marked as received is eligible for this payday allocation plan.',
      'Known commitments, required debt payments and the protected starter / emergency buffer come before flexible or optional money.',
      'The complete active Budget remains visible even when available income cannot cover it all.',
      'Expected future income can set the next horizon but is never counted as cash before receipt.',
      'Derived guidance is recalculated from current facts; no transfer, payment, standing order or borrowing action is performed.'
    ]
  };
}

function budgetCoverage(profile, available, review, preferences) {
  const categories = (profile?.budget?.categories || []).map((item) => ({
    id: String(item.id || ''), name: String(item.name || 'Budget category'), section: String(item.section || ''),
    required: round(Math.max(0, Number(item.remaining || 0))), monthlyPlanned: round(Math.max(0, Number(item.monthlyPlanned || 0))),
    actual: round(Math.max(0, Number(item.actual || 0)))
  }));
  const required = round(categories.reduce((sum, item) => sum + item.required, 0));
  const requested = preferences.flexibleAllowance === null ? required : round(Math.min(required, preferences.flexibleAllowance));
  const pool = review ? 0 : round(Math.min(Math.max(0, available), requested));
  const fundedCategories = proportionalCoverage(categories, pool, review, preferences);
  const funded = round(fundedCategories.reduce((sum, item) => sum + item.funded, 0));
  return { kind: 'budget_coverage', treatment: 'planning_coverage_not_recorded_spending', required, funded,
    shortfall: round(Math.max(0, required - funded)), requestedFlexibleAllowance: requested, defaultFlexibleAllowance: required,
    userOverride: preferences.flexibleAllowance !== null, categories: fundedCategories, allActiveCategoriesVisible: true,
    expectedFutureIncomeAppliedToShortfall: false };
}

function proportionalCoverage(categories, pool, review, preferences) {
  const total = categories.reduce((sum, item) => sum + item.required, 0);
  let assigned = 0;
  return categories.map((item, index) => {
    let funded = review || total <= 0 ? 0 : round(pool * (item.required / total));
    if (index === categories.length - 1) funded = round(Math.min(item.required, Math.max(0, pool - assigned)));
    funded = Math.min(item.required, funded); assigned = round(assigned + funded);
    const choiceId = `budget:${safeId(item.id) || index}`;
    return { ...item, choiceId, funded, shortfall: round(Math.max(0, item.required - funded)),
      fundingStatus: review ? PAYDAY_FUNDING_STATUS.NEEDS_REVIEW : fundingStatus(item.required, funded),
      accepted: preferences.acceptedChoiceIds.includes(choiceId), source: 'authoritative_budget_remaining' };
  });
}

function optionalDebt(context, available, allowed) {
  const recommendation = context.debt || {};
  const candidates = Array.isArray(recommendation.eligibleDebts) ? recommendation.eligibleDebts : [];
  const selected = context.preferences.optionalDebtId ? candidates.find((item) => String(item.id) === context.preferences.optionalDebtId) : recommendation.priorityDebt;
  const safeMaximum = round(moneyOrNull(recommendation.maximumSafeOptionalAmount) ?? 0);
  const balance = round(moneyOrNull(selected?.balance) ?? safeMaximum);
  const canFund = allowed && recommendation.status === DEBT_RECOMMENDATION_STATUS.AVAILABLE && selected && !context.preferences.optionalDebtDeclined;
  const funded = canFund ? round(Math.min(Math.max(0, available), safeMaximum, balance)) : 0;
  const choiceId = selected ? `optional-debt:${safeId(selected.id)}` : 'optional-debt';
  return { kind: 'optional_debt', debtId: selected ? String(selected.id || '') : null, name: String(selected?.name || 'Optional debt payment'),
    required: 0, maximumSafeAmount: safeMaximum, funded, shortfall: 0,
    fundingStatus: funded > 0 ? PAYDAY_FUNDING_STATUS.FUNDED : PAYDAY_FUNDING_STATUS.UNFUNDED,
    declined: context.preferences.optionalDebtDeclined, userSelectedDebt: Boolean(context.preferences.optionalDebtId),
    options: candidates.map((item) => ({ id: String(item.id || ''), name: String(item.name || 'Eligible debt'), balance: round(moneyOrNull(item.balance) ?? 0) })),
    choiceId, accepted: context.preferences.acceptedChoiceIds.includes(choiceId),
    reason: context.preferences.optionalDebtDeclined ? 'The user has declined optional debt allocation.'
      : !allowed ? 'Optional debt allocation is paused until protected needs and the active Budget are covered.'
        : recommendation.status !== DEBT_RECOMMENDATION_STATUS.AVAILABLE ? String(recommendation.blockers?.[0]?.explanation || 'Financial Safety is not currently offering an optional debt overpayment.')
          : 'Financial Safety permits this optional planning amount. It does not make a payment.', externalPaymentMade: false };
}

function optionalSavings(context, available, review) {
  const target = round(context.preferences.optionalSavingsTarget);
  const funded = review ? 0 : round(Math.min(Math.max(0, available), target));
  return { kind: 'optional_savings', name: 'Optional savings allocation', target, required: 0, funded,
    shortfall: round(Math.max(0, target - funded)), fundingStatus: review ? PAYDAY_FUNDING_STATUS.NEEDS_REVIEW : fundingStatus(target, funded),
    choiceId: 'optional-savings', accepted: context.preferences.acceptedChoiceIds.includes('optional-savings'),
    reason: target > 0 ? 'This saved planning target is considered only after protected needs and Budget coverage. No transfer is made.' : 'No optional savings target is set.',
    externalTransferMade: false };
}

function protectedItems(safe) {
  return [...(safe?.detail?.scheduled || []).map((item) => detail(item, 'scheduled_commitment')),
    ...(safe?.detail?.recurring || []).map((item) => detail(item, 'recurring_commitment'))].filter(Boolean).sort(byDate);
}
function debtItems(safe) { return (safe?.detail?.debt || []).map((item) => detail(item, 'required_debt_payment')).filter(Boolean).sort(byDate); }
function detail(item, kind) {
  const amount = moneyOrNull(item?.amount); if (amount === null || amount <= 0) return null;
  return { id: safeId(item.id) || safeId(item.name), name: String(item.name || 'Protected item'), date: validDateKey(item.date) ? item.date : null, amount: round(amount), kind };
}
function byDate(a, b) { return (a.date || '9999-12-31').localeCompare(b.date || '9999-12-31') || a.name.localeCompare(b.name); }

function groupAllocation(kind, items, required, available) {
  let remaining = available;
  const fundedItems = items.map((item) => { const funded = round(Math.min(item.amount, Math.max(0, remaining))); remaining = round(Math.max(0, remaining - funded));
    return { ...item, required: item.amount, funded, shortfall: round(item.amount - funded), fundingStatus: fundingStatus(item.amount, funded) }; });
  let funded = round(fundedItems.reduce((sum, item) => sum + item.funded, 0));
  if (funded < required && remaining > 0) funded = round(Math.min(required, funded + remaining));
  return { kind, required, funded, shortfall: round(Math.max(0, required - funded)), fundingStatus: fundingStatus(required, funded), items: fundedItems };
}
function emptyGroup(kind) { return { kind, required: 0, funded: 0, shortfall: 0, fundingStatus: PAYDAY_FUNDING_STATUS.FUNDED, items: [] }; }
function allocation(id, name, required, funded, review) {
  const need = round(nonNegative(required)); const covered = round(Math.min(need, nonNegative(funded)));
  return { id, name, required: need, funded: covered, shortfall: round(need - covered), fundingStatus: review ? PAYDAY_FUNDING_STATUS.NEEDS_REVIEW : fundingStatus(need, covered) };
}
function fundingStatus(required, funded) { return required <= 0 || funded >= required ? PAYDAY_FUNDING_STATUS.FUNDED : funded > 0 ? PAYDAY_FUNDING_STATUS.PARTIALLY_FUNDED : PAYDAY_FUNDING_STATUS.UNFUNDED; }

function receivedStreams(payday) { return (payday?.streams || []).filter((item) => item?.status === PAYDAY_STATUS.RECEIVED && moneyOrNull(item?.received?.amount) !== null)
  .sort((a, b) => String(b.received?.date || '').localeCompare(String(a.received?.date || '')) || String(a.id || '').localeCompare(String(b.id || ''))); }
function nextHorizon(payday, today) {
  if (validDateKey(payday?.nextPayday?.date) && payday.nextPayday.date > today) return payday.nextPayday.date;
  return (payday?.streams || []).map((item) => item?.nextExpected?.date).filter((date) => validDateKey(date) && date > today).sort()[0] || null;
}
function trustedLiquid(profile) { const fact = profile?.liquidPosition?.total; if (fact?.status !== UNIFIED_FACT_STATUS.KNOWN) return null; const value = Number(fact.value); return Number.isFinite(value) ? round(value) : null; }
function bufferShortfall(profile) { const value = Number(profile?.buffer?.shortfall); return Number.isFinite(value) && value > 0 ? round(value) : 0; }
function uniqueWarnings(items) { const map = new Map(); for (const item of items) { const code = safeId(item.code) || 'review'; if (!map.has(code)) map.set(code, { code, explanation: String(item.explanation || 'Review this planning condition.') }); } return [...map.values()]; }
function safeId(value) { return String(value || '').trim().replace(/[^a-z0-9:_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 160); }
function moneyOrNull(value) { if (value === null || value === undefined || value === '') return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; }
function nonNegative(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : 0; }
function round(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function plainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function validDate(value) { const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date() : date; }
function validDateKey(value) { const text = String(value || ''); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const date = new Date(`${text}T12:00:00Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text; }
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
