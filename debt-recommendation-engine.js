import { debtSafetyAssessment } from './finance-core.js';
import { buildUnifiedFinancialProfile, UNIFIED_FACT_STATUS } from './unified-financial-profile.js';
import { buildPaydayContext } from './payday-awareness.js';

export const DEBT_RECOMMENDATION_VERSION = 1;
export const DEBT_RECOMMENDATION_STRATEGY = Object.freeze({
  RECOMMENDED: 'recommended',
  HIGHEST_COST: 'highest_cost',
  SMALL_BALANCE: 'small_balance'
});
export const DEBT_RECOMMENDATION_STATUS = Object.freeze({
  AVAILABLE: 'recommendation_available',
  DO_NOT_OVERPAY: 'do_not_overpay_yet',
  NEEDS_REVIEW: 'needs_review',
  NO_DEBT: 'no_debt'
});

const MAX_CAPACITY_REQUEST = 1_000_000_000;

export function buildDebtRecommendation(state = {}, options = {}) {
  const now = validDate(options.now);
  const today = validDateKey(options.today) ? options.today : localDateKey(now);
  const profile = options.profile || buildUnifiedFinancialProfile(state, { now });
  const payday = options.paydayContext || buildPaydayContext(state, { now });
  const safety = options.safetyAssessment || debtSafetyAssessment(state, MAX_CAPACITY_REQUEST);
  const strategy = normaliseDebtRecommendationStrategy(options.strategy || state?.profile?.debtRecommendationStrategy);
  const rawById = rawDebtIndex(state);
  const assessed = (safety?.accounts || []).map((item) => recommendationAccount(item, rawById.get(String(item.id)), profile));
  const active = assessed.filter((item) => item.balance > 0);
  const requiredPayments = requiredPaymentItems(active, profile);
  const eligible = active.filter((item) => item.eligibleForExtra);
  const blockers = recommendationBlockers({ profile, payday, safety, eligible, strategy, forecast: options.forecast });
  const ranked = blockers.some((item) => item.code === 'material_apr_unknown') ? [] : rankEligibleDebts(eligible, strategy);
  const priority = ranked[0] || null;
  const alternative = ranked[1] || null;

  if (!active.length) return deepFreeze(baseResult({ today, strategy, profile, payday, safety, requiredPayments, status: DEBT_RECOMMENDATION_STATUS.NO_DEBT, blockers, ranked }));
  if (blockers.length) return deepFreeze(baseResult({ today, strategy, profile, payday, safety, requiredPayments, status: DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW, blockers, ranked }));
  if (!priority) {
    const noEligible = [{ code: 'no_eligible_debt', explanation: 'No recorded debt is currently eligible for an optional additional payment.' }];
    return deepFreeze(baseResult({ today, strategy, profile, payday, safety, requiredPayments, status: DEBT_RECOMMENDATION_STATUS.DO_NOT_OVERPAY, blockers: noEligible, ranked }));
  }

  const safetyCapacity = finiteNonNegative(safety?.safeExtraPayment) ?? 0;
  const paydayCapacity = finiteNonNegative(payday?.safeUntilPayday?.amount) ?? 0;
  const capacity = floorMoney(Math.min(safetyCapacity, paydayCapacity, priority.balance));
  if (!(capacity > 0)) {
    const noCapacity = [{
      code: 'no_optional_capacity',
      explanation: 'Required commitments and the protected buffer leave no money safely available for an optional debt payment before the next dependable income.'
    }];
    return deepFreeze(baseResult({ today, strategy, profile, payday, safety, requiredPayments, status: DEBT_RECOMMENDATION_STATUS.DO_NOT_OVERPAY, blockers: noCapacity, ranked, priority, alternative, maximumSafeOptionalAmount: 0 }));
  }

  return deepFreeze(baseResult({
    today, strategy, profile, payday, safety, requiredPayments, status: DEBT_RECOMMENDATION_STATUS.AVAILABLE,
    blockers: [], ranked, priority, alternative, maximumSafeOptionalAmount: capacity,
    recommendationReasonCodes: priority.reasonCodes,
    why: recommendationExplanation(priority, strategy, capacity, requiredPayments)
  }));
}

export function normaliseDebtRecommendationStrategy(value) {
  return Object.values(DEBT_RECOMMENDATION_STRATEGY).includes(value) ? value : DEBT_RECOMMENDATION_STRATEGY.RECOMMENDED;
}

export function setDebtRecommendationStrategy(state = {}, strategy) {
  const next = structuredClone(state || {});
  next.profile = next.profile && typeof next.profile === 'object' ? next.profile : {};
  next.profile.debtRecommendationStrategy = normaliseDebtRecommendationStrategy(strategy);
  delete next.debtRecommendation;
  delete next.debtRecommendationSnapshot;
  return next;
}

export function optionalDebtPlanEvent(recommendation, options = {}) {
  if (recommendation?.status !== DEBT_RECOMMENDATION_STATUS.AVAILABLE || !recommendation.priorityDebt) {
    throw new Error('No safe optional debt recommendation is available to add to a plan.');
  }
  const maximum = finiteNonNegative(recommendation.maximumSafeOptionalAmount) ?? 0;
  const requested = options.amount === undefined ? maximum : finiteNonNegative(options.amount);
  if (requested === null || requested <= 0 || requested > maximum) throw new RangeError('Optional debt plan amount must be above zero and no more than the current maximum safe optional amount.');
  const date = validDateKey(options.date) ? options.date : recommendation.asOf;
  return deepFreeze({
    id: `optional-debt:${recommendation.priorityDebt.id}:${date}`,
    date,
    delta: -floorMoney(requested),
    sourceType: 'optional_debt_plan',
    sourceRef: `debt:${recommendation.priorityDebt.id}`,
    certainty: 'possible',
    reasonCode: 'accepted_optional_debt_plan',
    explanation: `A ${recommendation.priorityDebt.name} optional payment has been included in the plan only. It is not treated as paid until a real payment is recorded.`,
    applied: false,
    externalPaymentMade: false
  });
}

function baseResult({ today, strategy, profile, payday, safety, requiredPayments, status, blockers, ranked, priority = null, alternative = null, maximumSafeOptionalAmount = 0, recommendationReasonCodes = [], why = null }) {
  const safeUntil = payday?.safeUntilPayday || {};
  return {
    kind: 'debt-recommendation',
    version: DEBT_RECOMMENDATION_VERSION,
    derived: true,
    persist: false,
    asOf: today,
    currency: profile?.currency || 'GBP',
    strategy,
    status,
    requiredPayments,
    requiredPaymentTotal: floorMoney(requiredPayments.reduce((sum, item) => sum + item.amount, 0)),
    priorityDebt: priority ? publicDebt(priority) : null,
    alternativeDebt: alternative ? publicDebt(alternative) : null,
    eligibleDebts: ranked.map(publicDebt),
    maximumSafeOptionalAmount: floorMoney(maximumSafeOptionalAmount),
    blockers: uniqueBlockers(blockers),
    recommendationReasonCodes: [...new Set(recommendationReasonCodes)],
    capacity: {
      financialSafety: finiteNonNegative(safety?.safeExtraPayment),
      safeUntilPayday: safeUntil.status === 'available' ? finiteNonNegative(safeUntil.amount) : null,
      paydayHorizon: validDateKey(safeUntil.horizonDate) ? safeUntil.horizonDate : validDateKey(payday?.nextPayday?.date) ? payday.nextPayday.date : null,
      expectedIncomeCountedAsCurrentCash: false
    },
    why: why || defaultExplanation(status, blockers),
    externalPaymentMade: false
  };
}

function recommendationAccount(safety, raw = {}, profile) {
  const profileAccount = (profile?.debts?.accounts || []).find((item) => String(item.id) === String(safety.id));
  const aprFact = profileAccount?.apr;
  const apr = profileAccount
    ? aprFact?.status === UNIFIED_FACT_STATUS.KNOWN ? finiteNonNegative(aprFact.value) : null
    : finiteNonNegative(raw?.apr);
  const interestFrozen = raw?.interestFrozen === true;
  const effectiveApr = interestFrozen ? 0 : apr;
  const explicitPriority = finiteNonNegative(raw?.planPriority);
  return {
    id: String(safety.id || ''),
    name: String(safety.name || raw?.name || 'Unnamed debt'),
    kind: String(safety.kind || raw?.kind || 'debt'),
    balance: floorMoney(Math.max(0, Number(safety.balance || 0))),
    status: String(safety.effectiveStatus || profileAccount?.status?.value || raw?.status || 'unknown'),
    arrangementStatus: String(safety.arrangementStatus || profileAccount?.arrangementStatus?.value || raw?.arrangementStatus || 'unknown'),
    requiredPayment: floorMoney(Math.max(0, Number(safety.requiredPayment || 0))),
    eligibleForExtra: safety.eligibleForExtra === true && raw?.includeInPlan !== false,
    overLimit: safety.overLimit === true,
    blockingReasons: [...new Set(safety.blockingReasons || [])],
    financialSafetyReasonCodes: [...new Set(safety.reasonCodes || [])],
    apr,
    effectiveApr,
    interestFrozen,
    explicitPriority,
    creditLimit: finiteNonNegative(raw?.creditLimit ?? raw?.limit)
  };
}

function requiredPaymentItems(accounts, profile) {
  const dueDates = new Map((profile?.commitments?.items || [])
    .filter((item) => item?.kind === 'required_debt_payment')
    .map((item) => [String(item.id || '').replace(/^debt:/, ''), item?.dueDate?.status === UNIFIED_FACT_STATUS.KNOWN && validDateKey(item.dueDate.value) ? item.dueDate.value : null]));
  return accounts.filter((item) => item.requiredPayment > 0).map((item) => ({
    debtId: item.id,
    name: item.name,
    amount: item.requiredPayment,
    dueDate: dueDates.get(item.id) || null,
    status: item.status,
    arrangementStatus: item.arrangementStatus,
    type: item.arrangementStatus === 'confirmed' ? 'arrangement_or_agreed_payment' : 'contractual_minimum',
    optional: false
  })).sort((a, b) => (a.dueDate || '9999-12-31').localeCompare(b.dueDate || '9999-12-31') || a.name.localeCompare(b.name));
}

function recommendationBlockers({ profile, payday, safety, eligible, strategy, forecast }) {
  const blockers = [];
  for (const account of safety?.accounts || []) {
    for (const [index, code] of (account.reasonCodes || []).entries()) {
      blockers.push({ code: `financial_safety_${code}`, debtId: String(account.id || ''), explanation: account.blockingReasons?.[index] || account.blockingReasons?.[0] || 'Financial Safety requires review before an optional debt payment.' });
    }
  }
  if ((safety?.blockingReasons || []).length && !blockers.length) blockers.push({ code: 'financial_safety_blocked', explanation: safety.blockingReasons[0] });
  if (profile?.liquidPosition?.total?.status !== UNIFIED_FACT_STATUS.KNOWN) blockers.push({ code: 'trusted_liquid_position_unavailable', explanation: 'A trusted current liquid balance is required before optional debt money can be recommended.' });
  if (payday?.safeUntilPayday?.status !== 'available') {
    const reasonCodes = payday?.safeUntilPayday?.reasonCodes?.length ? payday.safeUntilPayday.reasonCodes : ['safe_until_payday_unavailable'];
    for (const code of reasonCodes) blockers.push({ code: `payday_${code}`, explanation: paydayBlockerExplanation(code) });
  }
  const materialUnknownApr = eligible.filter((item) => item.apr === null).length > 0 && eligible.length > 1
    && [DEBT_RECOMMENDATION_STRATEGY.RECOMMENDED, DEBT_RECOMMENDATION_STRATEGY.HIGHEST_COST].includes(strategy);
  if (materialUnknownApr) blockers.push({ code: 'material_apr_unknown', explanation: 'At least one eligible debt has an unknown APR, so OneStep cannot safely claim which debt is the most expensive. Confirm the missing rate or choose Small balance first.' });
  if (forecastHasCashRisk(forecast, payday?.nextPayday?.date || payday?.safeUntilPayday?.horizonDate)) blockers.push({ code: 'forecast_cash_risk', explanation: 'The current cash-flow forecast shows a negative balance or protected-buffer breach before the payday horizon, so optional debt overpayment is paused.' });
  return uniqueBlockers(blockers);
}

function rankEligibleDebts(accounts, strategy) {
  return [...accounts].sort((left, right) => {
    if (strategy === DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE) return left.balance - right.balance || compareKnownCost(right, left) || compareExplicitPriority(left, right) || left.id.localeCompare(right.id);
    if (strategy === DEBT_RECOMMENDATION_STRATEGY.HIGHEST_COST) return compareKnownCost(right, left) || Number(right.overLimit) - Number(left.overLimit) || left.balance - right.balance || compareExplicitPriority(left, right) || left.id.localeCompare(right.id);
    return Number(right.overLimit) - Number(left.overLimit)
      || compareKnownCost(right, left)
      || Number(right.kind === 'overdraft') - Number(left.kind === 'overdraft')
      || compareExplicitPriority(left, right)
      || left.balance - right.balance
      || left.id.localeCompare(right.id);
  }).map((item, index, ordered) => ({ ...item, reasonCodes: rankingReasonCodes(item, index, ordered, strategy) }));
}

function rankingReasonCodes(item, index, ordered, strategy) {
  const reasons = [];
  if (item.overLimit) reasons.push('over_limit_risk');
  if (item.kind === 'overdraft') reasons.push('overdraft_liquidity_risk');
  if (item.interestFrozen) reasons.push('interest_frozen');
  if (index === 0 && strategy === DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE) reasons.push('smallest_balance');
  if (index === 0 && strategy === DEBT_RECOMMENDATION_STRATEGY.HIGHEST_COST) reasons.push('highest_effective_cost');
  if (index === 0 && strategy === DEBT_RECOMMENDATION_STRATEGY.RECOMMENDED) {
    if (item.overLimit) reasons.push('safety_risk_first');
    else if (ordered.length === 1 || item.effectiveApr >= Math.max(...ordered.map((candidate) => candidate.effectiveApr ?? -1))) reasons.push('highest_effective_cost');
    else reasons.push('safety_first_recommended');
  }
  if (item.explicitPriority !== null) reasons.push('user_priority_tiebreak');
  return [...new Set(reasons)];
}

function recommendationExplanation(priority, strategy, amount, requiredPayments) {
  const mode = strategy === DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE
    ? `${priority.name} is the smallest eligible balance.`
    : strategy === DEBT_RECOMMENDATION_STRATEGY.HIGHEST_COST
      ? `${priority.name} has the highest known effective cost among debts that passed the safety gates.`
      : priority.overLimit
        ? `${priority.name} is over its recorded limit and is the highest safety-risk eligible account.`
        : `${priority.name} is the highest-cost eligible account after required-payment and cash-safety checks.`;
  const protectedText = requiredPayments.length
    ? `${requiredPayments.length} required debt payment${requiredPayments.length === 1 ? ' is' : 's are'} protected before this optional amount.`
    : 'No separate required debt payment is being confused with this optional amount.';
  return [mode, `${protectedText} The maximum optional amount is ${formatPlainMoney(amount)} using only cash that is safe before the next dependable income.`, 'Expected future income is not counted as cash already received.'];
}

function defaultExplanation(status, blockers) {
  if (status === DEBT_RECOMMENDATION_STATUS.NO_DEBT) return ['No active debt balance needs a recommendation.'];
  if (status === DEBT_RECOMMENDATION_STATUS.DO_NOT_OVERPAY) return ['Do not overpay yet. Required payments, cash stability and the protected buffer come first.', ...blockers.map((item) => item.explanation)];
  return ['Needs review before any optional debt overpayment.', ...blockers.map((item) => item.explanation)];
}

function publicDebt(item) {
  return {
    id: item.id,
    name: item.name,
    kind: item.kind,
    balance: item.balance,
    status: item.status,
    arrangementStatus: item.arrangementStatus,
    requiredPayment: item.requiredPayment,
    apr: item.apr,
    effectiveApr: item.effectiveApr,
    interestFrozen: item.interestFrozen,
    overLimit: item.overLimit,
    reasonCodes: item.reasonCodes || []
  };
}

function forecastHasCashRisk(forecast, paydayDate) {
  if (!forecast || !Array.isArray(forecast.horizons)) return false;
  return forecast.horizons.some((item) => item?.status === 'available'
    && (!validDateKey(paydayDate) || !validDateKey(item.date) || item.date <= paydayDate)
    && (item.riskFlags || []).some((flag) => ['safe_negative', 'buffer_breach'].includes(flag)));
}

function rawDebtIndex(state) {
  const entries = [
    ...(state?.debts || []).map((item) => [String(item.id), { ...item, kind: 'debt' }]),
    ...(state?.overdrafts || []).map((item) => [String(item.id), { ...item, kind: 'overdraft' }])
  ];
  return new Map(entries);
}

function compareKnownCost(left, right) {
  const leftCost = left.effectiveApr === null ? -1 : left.effectiveApr;
  const rightCost = right.effectiveApr === null ? -1 : right.effectiveApr;
  return leftCost - rightCost;
}
function compareExplicitPriority(left, right) { return (left.explicitPriority ?? Number.MAX_SAFE_INTEGER) - (right.explicitPriority ?? Number.MAX_SAFE_INTEGER); }
function paydayBlockerExplanation(code) {
  const messages = {
    dependable_payday_unknown: 'The next dependable payday is unknown, so OneStep cannot prove that near-term commitments are protected.',
    trusted_liquid_position_unavailable: 'The current liquid position is not trusted enough to calculate an optional debt amount.',
    buffer_unknown: 'The protected buffer is incomplete, so optional overpayment remains paused.',
    required_debt_due_date_unknown: 'A required debt payment has no confirmed due date, so cash before payday cannot be protected reliably.'
  };
  return messages[code] || 'Safe Until Payday is unavailable because a required near-term financial fact needs review.';
}
function uniqueBlockers(values) { const seen = new Set(); return (values || []).filter((item) => { const key = `${item.code}|${item.debtId || ''}`; if (seen.has(key)) return false; seen.add(key); return true; }).sort((a, b) => a.code.localeCompare(b.code) || String(a.debtId || '').localeCompare(String(b.debtId || ''))); }
function finiteNonNegative(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? number : null; }
function floorMoney(value) { return Math.floor((Math.max(0, Number(value || 0)) + Number.EPSILON) * 100) / 100; }
function validDate(value) { const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date() : date; }
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function validDateKey(value) { const text = String(value || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const date = new Date(`${text}T00:00:00.000Z`); return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text; }
function formatPlainMoney(value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
