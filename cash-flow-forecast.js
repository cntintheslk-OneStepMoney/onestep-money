import { buildUnifiedFinancialProfile, UNIFIED_FACT_STATUS } from './unified-financial-profile.js';
import { buildPaydayContext, PAYDAY_STATUS, scheduleOccurrenceForMonth } from './payday-awareness.js';
import { confirmedRecurringPatterns, expectedNextOccurrence, RECURRING_CONFIDENCE } from './recurring-finance.js';

export const CASH_FLOW_FORECAST_VERSION = 1;
export const CASH_FLOW_CERTAINTY = Object.freeze({
  CONFIRMED: 'confirmed',
  EXPECTED: 'expected',
  POSSIBLE: 'possible'
});
export const CASH_FLOW_HORIZON = Object.freeze({
  TODAY: 'today',
  BEFORE_PAYDAY: 'before_next_payday',
  SEVEN_DAYS: '7_days',
  THIRTY_DAYS: '30_days',
  NEXT_PAYDAY: 'next_payday',
  THREE_MONTHS: '3_months'
});

const HORIZON_LABELS = Object.freeze({
  [CASH_FLOW_HORIZON.TODAY]: 'Today',
  [CASH_FLOW_HORIZON.BEFORE_PAYDAY]: 'Before next payday',
  [CASH_FLOW_HORIZON.SEVEN_DAYS]: '7 days',
  [CASH_FLOW_HORIZON.THIRTY_DAYS]: '30 days',
  [CASH_FLOW_HORIZON.NEXT_PAYDAY]: 'Next payday',
  [CASH_FLOW_HORIZON.THREE_MONTHS]: '3 months'
});

export function buildCashFlowForecast(state = {}, options = {}) {
  const now = validDate(options.now);
  const today = validDateKey(options.today) ? options.today : localDateKey(now);
  const profile = options.profile || buildUnifiedFinancialProfile(state, { now });
  const payday = options.paydayContext || buildPaydayContext(state, { now });
  const recurringPatterns = options.recurringPatterns || confirmedRecurringPatterns(state);
  const nextPaydayDate = validDateKey(payday?.nextPayday?.date) ? payday.nextPayday.date : null;
  const horizonDates = {
    [CASH_FLOW_HORIZON.TODAY]: today,
    [CASH_FLOW_HORIZON.BEFORE_PAYDAY]: nextPaydayDate ? maxDate(today, shiftDate(nextPaydayDate, -1)) : null,
    [CASH_FLOW_HORIZON.SEVEN_DAYS]: shiftDate(today, 7),
    [CASH_FLOW_HORIZON.THIRTY_DAYS]: shiftDate(today, 30),
    [CASH_FLOW_HORIZON.NEXT_PAYDAY]: nextPaydayDate,
    [CASH_FLOW_HORIZON.THREE_MONTHS]: addCalendarMonths(today, 3)
  };
  const maximumDate = maxDate(...Object.values(horizonDates).filter(Boolean));
  const startBalance = knownMoney(profile?.liquidPosition?.total) ? roundMoney(profile.liquidPosition.total.value) : null;
  const protectedBuffer = knownMoney(profile?.buffer?.target) && knownMoney(profile?.buffer?.balance)
    ? roundMoney(Math.max(0, Number(profile.buffer.target.value) - Number(profile.buffer.balance.value)))
    : null;

  const hardEvents = hardCommitmentEvents(profile, today, maximumDate);
  const recurringEvents = recurringOutgoingEvents(recurringPatterns, today, maximumDate, hardEvents);
  const incomeEvents = paydayIncomeEvents(payday, today, maximumDate);
  const possibleEvents = plannedEvents(options.plannedEvents, today, maximumDate);
  const rawEvents = deduplicateEvents([...hardEvents, ...recurringEvents, ...incomeEvents, ...possibleEvents]);
  const events = projectBalances(rawEvents, startBalance, protectedBuffer);
  const horizons = Object.entries(horizonDates).map(([id, date]) => buildHorizon(id, date, today, events, startBalance, protectedBuffer));
  const blocking = forecastBlockers(profile, startBalance, protectedBuffer);
  const expectedIncomeCount = events.filter((event) => event.certainty === CASH_FLOW_CERTAINTY.EXPECTED && event.delta > 0).length;
  const possibleCount = events.filter((event) => event.certainty === CASH_FLOW_CERTAINTY.POSSIBLE).length;

  return deepFreeze({
    kind: 'cash-flow-forecast',
    version: CASH_FLOW_FORECAST_VERSION,
    derived: true,
    persist: false,
    asOf: today,
    currency: profile?.currency || 'GBP',
    status: startBalance === null ? 'unavailable' : blocking.length ? 'review_required' : 'available',
    startBalance,
    protectedBuffer,
    nextPayday: nextPaydayDate,
    horizons,
    events,
    budgetContext: {
      treatment: 'context_only',
      planned: roundMoney(profile?.budget?.planned || 0),
      remaining: roundMoney(profile?.budget?.remaining || 0),
      categories: (profile?.budget?.categories || []).map((item) => ({
        id: String(item.id || ''),
        name: String(item.name || ''),
        monthlyPlanned: roundMoney(item.monthlyPlanned || 0),
        remaining: roundMoney(item.remaining || 0)
      }))
    },
    blockers: blocking,
    why: [
      'Confirmed scheduled and required debt payments are included as hard commitments.',
      'Confirmed recurring outgoings are forecast using their typical amount, while the safe view protects the high end of the observed range.',
      expectedIncomeCount
        ? 'Expected future income is shown in the ordinary forecast but excluded from the safe projection until it is actually received.'
        : 'No expected future income is being relied on as currently spendable cash.',
      'Budget allowances are shown as planning context and are not silently converted into mandatory cash outflows.',
      possibleCount
        ? 'Optional or user-planned items affect only the plan-aware projection until they are explicitly recorded.'
        : 'No optional plan items are assumed to have happened.',
      'Forecast totals are derived locally and are not persisted as authoritative financial state.'
    ]
  });
}

export function forecastHorizon(forecast, horizonId) {
  return forecast?.horizons?.find((item) => item.id === horizonId) || null;
}

function hardCommitmentEvents(profile, today, maximumDate) {
  const events = [];
  for (const item of profile?.commitments?.items || []) {
    if (!['scheduled_payment', 'required_debt_payment'].includes(item?.kind)) continue;
    if (!knownMoney(item.amount) || !knownDate(item.dueDate)) continue;
    const date = item.dueDate.value;
    if (date < today || date > maximumDate) continue;
    const amount = roundMoney(Math.max(0, Number(item.amount.value)));
    if (amount <= 0) continue;
    events.push({
      id: `confirmed:${item.id}:${date}`,
      date,
      delta: -amount,
      safeDelta: -amount,
      sourceType: item.kind,
      sourceRef: item.id,
      certainty: CASH_FLOW_CERTAINTY.CONFIRMED,
      includedInSafeView: true,
      reasonCode: item.kind === 'required_debt_payment' ? 'required_debt_payment' : 'scheduled_commitment',
      explanation: item.kind === 'required_debt_payment'
        ? `${item.name || 'Required debt payment'} is recorded as a required payment.`
        : `${item.name || 'Scheduled payment'} is recorded with a known due date and amount.`
    });
  }
  return events;
}

function recurringOutgoingEvents(patterns, today, maximumDate, hardEvents) {
  const events = [];
  for (const pattern of patterns || []) {
    if (pattern?.direction !== 'outgoing' || pattern?.confidence !== RECURRING_CONFIDENCE.CONFIRMED) continue;
    const typical = finiteNonNegative(pattern?.amountRange?.typical);
    const high = finiteNonNegative(pattern?.amountRange?.max);
    if (typical === null && high === null) continue;
    let occurrence = pattern.nextExpected || expectedNextOccurrence(pattern);
    let guard = 0;
    while (occurrence?.date && occurrence.date < today && guard++ < 36) {
      occurrence = expectedNextOccurrence({ ...pattern, lastDate: occurrence.date, dates: [occurrence.date] });
    }
    guard = 0;
    while (occurrence?.date && occurrence.date <= maximumDate && guard++ < 36) {
      const amount = roundMoney(typical ?? high);
      const safeAmount = roundMoney(high ?? typical);
      if (!likelyDuplicatesHardCommitment(pattern, occurrence.date, safeAmount, hardEvents)) {
        events.push({
          id: `expected:recurring:${pattern.id}:${occurrence.date}`,
          date: occurrence.date,
          delta: -amount,
          safeDelta: -safeAmount,
          sourceType: 'recurring_pattern',
          sourceRef: pattern.id,
          certainty: CASH_FLOW_CERTAINTY.EXPECTED,
          includedInSafeView: true,
          reasonCode: 'confirmed_recurring_outgoing',
          explanation: `${pattern.label || 'Recurring outgoing'} is a confirmed recurring pattern; the safe view protects the high end of its observed amount range.`
        });
      }
      occurrence = expectedNextOccurrence({ ...pattern, lastDate: occurrence.date, dates: [occurrence.date] });
    }
  }
  return events;
}

function paydayIncomeEvents(payday, today, maximumDate) {
  const events = [];
  const schedules = new Map((payday?.schedules || []).map((item) => [String(item.id), item]));
  for (const stream of payday?.streams || []) {
    if (stream?.active === false || stream?.status === PAYDAY_STATUS.INACTIVE) continue;
    const minimum = finiteNonNegative(stream?.expectedAmountRange?.min);
    const maximum = finiteNonNegative(stream?.expectedAmountRange?.max);
    const amount = roundMoney(minimum ?? maximum ?? 0);
    if (amount <= 0) continue;
    const dates = futureIncomeDates(stream, schedules.get(String(stream.id)), today, maximumDate);
    for (const date of dates) {
      events.push({
        id: `expected:income:${stream.id}:${date}`,
        date,
        delta: amount,
        safeDelta: 0,
        sourceType: 'income_schedule',
        sourceRef: stream.id,
        certainty: CASH_FLOW_CERTAINTY.EXPECTED,
        includedInSafeView: false,
        reasonCode: stream.status === PAYDAY_STATUS.MISSING ? 'future_income_after_missing_occurrence' : 'expected_future_income',
        explanation: `${stream.name || 'Expected income'} is scheduled for this date, but it is not counted in the safe projection before receipt.`
      });
    }
  }
  return events;
}

function futureIncomeDates(stream, schedule, today, maximumDate) {
  const dates = new Set();
  if (schedule?.cadence === 'monthly') {
    const start = parseDate(today);
    const end = parseDate(maximumDate);
    let year = start.year;
    let month = start.month;
    let guard = 0;
    while ((year < end.year || (year === end.year && month <= end.month)) && guard++ < 18) {
      const occurrence = scheduleOccurrenceForMonth(schedule, year, month);
      if (occurrence?.date > today && occurrence.date <= maximumDate) dates.add(occurrence.date);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
    if (dates.size) return [...dates].sort();
  }
  let date = validDateKey(stream?.nextExpected?.date) ? stream.nextExpected.date
    : validDateKey(stream?.expected?.date) && stream.expected.date > today ? stream.expected.date : '';
  const step = cadenceDays(stream?.cadence || schedule?.cadence);
  let guard = 0;
  while (date && date <= maximumDate && guard++ < 36) {
    if (date > today) dates.add(date);
    if (step) date = shiftDate(date, step);
    else if ((stream?.cadence || schedule?.cadence) === 'monthly') date = addCalendarMonths(date, 1);
    else break;
  }
  return [...dates].sort();
}

function plannedEvents(values, today, maximumDate) {
  const events = [];
  for (const item of Array.isArray(values) ? values : []) {
    if (!validDateKey(item?.date) || item.date < today || item.date > maximumDate) continue;
    const delta = finiteNumber(item.delta);
    if (delta === null || delta === 0) continue;
    events.push({
      id: String(item.id || `possible:${events.length + 1}:${item.date}`),
      date: item.date,
      delta: roundMoney(delta),
      safeDelta: 0,
      sourceType: String(item.sourceType || 'planned_item'),
      sourceRef: String(item.sourceRef || item.id || ''),
      certainty: CASH_FLOW_CERTAINTY.POSSIBLE,
      includedInSafeView: false,
      reasonCode: String(item.reasonCode || 'explicit_optional_plan'),
      explanation: String(item.explanation || item.reason || 'This item is optional or planned and is not treated as already completed.')
    });
  }
  return events;
}

function projectBalances(rawEvents, startBalance, protectedBuffer) {
  const ordered = [...rawEvents].sort(compareEvents);
  if (startBalance === null) return ordered.map((event) => ({ ...event, projectedBalance: null, safeProjectedBalance: null, planAwareBalance: null, riskFlags: [] }));
  let projected = startBalance;
  let safe = startBalance;
  let planAware = startBalance;
  return ordered.map((event) => {
    if (event.certainty === CASH_FLOW_CERTAINTY.CONFIRMED) {
      projected = roundMoney(projected + event.delta);
      safe = roundMoney(safe + event.delta);
      planAware = roundMoney(planAware + event.delta);
    } else if (event.certainty === CASH_FLOW_CERTAINTY.EXPECTED) {
      projected = roundMoney(projected + event.delta);
      if (event.delta < 0) safe = roundMoney(safe + (finiteNumber(event.safeDelta) ?? event.delta));
      planAware = roundMoney(planAware + event.delta);
    } else {
      planAware = roundMoney(planAware + event.delta);
    }
    return {
      ...event,
      projectedBalance: projected,
      safeProjectedBalance: safe,
      planAwareBalance: planAware,
      riskFlags: riskFlags(projected, safe, protectedBuffer)
    };
  });
}

function buildHorizon(id, date, today, events, startBalance, protectedBuffer) {
  if (!date) return { id, label: HORIZON_LABELS[id], status: 'unavailable', date: null, projectedBalance: null, safeProjectedBalance: null, planAwareBalance: null, eventCount: 0, riskFlags: [], reasonCodes: ['dependable_payday_unknown'] };
  const relevant = events.filter((event) => event.date >= today && event.date <= date);
  const last = relevant.at(-1);
  const projectedBalance = last?.projectedBalance ?? startBalance;
  const safeProjectedBalance = last?.safeProjectedBalance ?? startBalance;
  const planAwareBalance = last?.planAwareBalance ?? startBalance;
  return {
    id,
    label: HORIZON_LABELS[id],
    status: startBalance === null ? 'unavailable' : 'available',
    date,
    projectedBalance,
    safeProjectedBalance,
    planAwareBalance,
    eventCount: relevant.length,
    riskFlags: startBalance === null ? [] : riskFlags(projectedBalance, safeProjectedBalance, protectedBuffer),
    reasonCodes: [
      'confirmed_commitments_included',
      ...(relevant.some((event) => event.certainty === CASH_FLOW_CERTAINTY.EXPECTED && event.delta > 0) ? ['expected_income_excluded_from_safe_projection'] : []),
      ...(relevant.some((event) => event.certainty === CASH_FLOW_CERTAINTY.POSSIBLE) ? ['possible_items_plan_aware_only'] : [])
    ]
  };
}

function forecastBlockers(profile, startBalance, protectedBuffer) {
  const blockers = [];
  if (startBalance === null) blockers.push({ code: 'trusted_liquid_position_unavailable', explanation: 'A trusted current liquid position is required before projected balances can be relied on.' });
  if (protectedBuffer === null) blockers.push({ code: 'buffer_position_unknown', explanation: 'The protected buffer position is incomplete, so buffer-breach warnings need review.' });
  for (const item of profile?.uncertainty?.blocking || []) {
    const code = String(item?.code || 'financial_fact_needs_review');
    if (!blockers.some((existing) => existing.code === code)) blockers.push({ code, explanation: String(item?.message || item?.explanation || 'A required financial fact needs review.') });
  }
  return blockers.sort((a, b) => a.code.localeCompare(b.code));
}

function likelyDuplicatesHardCommitment(pattern, date, amount, hardEvents) {
  const patternName = normaliseLabel(pattern?.label || pattern?.purpose);
  return hardEvents.some((event) => event.date === date
    && Math.abs(Math.abs(event.delta) - amount) <= 0.01
    && patternName && normaliseLabel(event.explanation).includes(patternName));
}

function deduplicateEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.date}|${event.sourceType}|${event.sourceRef}|${event.certainty}|${roundMoney(event.delta)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareEvents(left, right) {
  const date = left.date.localeCompare(right.date);
  if (date) return date;
  if (left.delta !== right.delta) return left.delta - right.delta;
  const certaintyRank = { confirmed: 0, expected: 1, possible: 2 };
  const certainty = certaintyRank[left.certainty] - certaintyRank[right.certainty];
  return certainty || left.id.localeCompare(right.id);
}

function riskFlags(projected, safe, protectedBuffer) {
  const flags = [];
  if (Number.isFinite(projected) && projected < 0) flags.push('projected_negative');
  if (Number.isFinite(safe) && safe < 0) flags.push('safe_negative');
  if (protectedBuffer !== null && Number.isFinite(safe) && safe < protectedBuffer) flags.push('buffer_breach');
  return flags;
}

function knownMoney(fact) {
  return fact?.status === UNIFIED_FACT_STATUS.KNOWN && finiteNumber(fact.value) !== null;
}
function knownDate(fact) { return fact?.status === UNIFIED_FACT_STATUS.KNOWN && validDateKey(fact.value); }
function finiteNumber(value) { const number = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number; }
function finiteNonNegative(value) { const number = finiteNumber(value); return number !== null && number >= 0 ? number : null; }
function roundMoney(value) { return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100; }
function validDate(value) { const date = value instanceof Date ? new Date(value.getTime()) : new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date() : date; }
function localDateKey(date) { const year = date.getFullYear(); const month = String(date.getMonth() + 1).padStart(2, '0'); const day = String(date.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; }
function validDateKey(value) { const text = String(value || '').slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false; const { year, month, day } = parseDate(text); const date = new Date(Date.UTC(year, month - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day; }
function parseDate(value) { const [year, month, day] = String(value).slice(0, 10).split('-').map(Number); return { year, month, day }; }
function shiftDate(value, days) { const { year, month, day } = parseDate(value); const date = new Date(Date.UTC(year, month - 1, day + days)); return date.toISOString().slice(0, 10); }
function addCalendarMonths(value, months) { const { year, month, day } = parseDate(value); const sourceLast = daysInMonth(year, month); const target = new Date(Date.UTC(year, month - 1 + months, 1)); const targetYear = target.getUTCFullYear(); const targetMonth = target.getUTCMonth() + 1; const targetLast = daysInMonth(targetYear, targetMonth); const chosenDay = day === sourceLast ? targetLast : Math.min(day, targetLast); return `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(chosenDay).padStart(2, '0')}`; }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function cadenceDays(cadence) { return ({ weekly: 7, fortnightly: 14, 'four-weekly': 28 })[cadence] || 0; }
function maxDate(...values) { return values.filter(Boolean).sort().at(-1) || null; }
function normaliseLabel(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function deepFreeze(value) { if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
