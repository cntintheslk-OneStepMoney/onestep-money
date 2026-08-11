import { isExternalCashflowTransaction } from './finance-core.js';
import { confirmedRecurringPatterns, RECURRING_CADENCE } from './recurring-finance.js';
export { RECURRING_CADENCE } from './recurring-finance.js';
import { buildUnifiedFinancialProfile, UNIFIED_FACT_STATUS } from './unified-financial-profile.js';

export const PAYDAY_SCHEDULE_VERSION = 1;
export const PAYDAY_RULE = Object.freeze({
  FIXED_DAY: 'fixed_day',
  LAST_WORKING_DAY: 'last_working_day',
  LAST_WEEKDAY: 'last_weekday',
  ANCHOR: 'anchor'
});
export const PAYDAY_TIMING = Object.freeze({ CURRENT: 'current', ARREARS: 'arrears', OTHER: 'other' });
export const WEEKEND_ADJUSTMENT = Object.freeze({ NONE: 'none', PREVIOUS: 'previous', NEXT: 'next' });
export const PAYDAY_STATUS = Object.freeze({ EXPECTED: 'expected', RECEIVED: 'received', MISSING: 'missing', INACTIVE: 'inactive' });

const SUPPORTED_CADENCES = new Set([
  RECURRING_CADENCE.WEEKLY,
  RECURRING_CADENCE.FORTNIGHTLY,
  RECURRING_CADENCE.FOUR_WEEKLY,
  RECURRING_CADENCE.MONTHLY
]);
const REVIEW_SAFETY = Object.freeze({ safetyClass: 'review_required', certainty: 'certain' });

export function normaliseIncomeSchedules(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    const schedule = normaliseSchedule(item);
    if (!schedule || seen.has(schedule.id)) continue;
    seen.add(schedule.id);
    output.push(schedule);
  }
  return output.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function ensurePaydayConfiguration(state = {}, now = new Date()) {
  const target = state && typeof state === 'object' ? state : {};
  target.profile = target.profile && typeof target.profile === 'object' ? target.profile : {};
  const current = normaliseIncomeSchedules(target.profile.incomeSchedules);
  if (current.length) {
    target.profile.incomeSchedules = current;
    return target;
  }
  const day = validDay(target.profile.paydayDay);
  const dependableIncome = finiteNonNegative(target.profile.dependableIncome);
  if (!day || !(dependableIncome > 0)) {
    target.profile.incomeSchedules = [];
    return target;
  }
  target.profile.incomeSchedules = [normaliseSchedule({
    id: 'legacy-manual-payday',
    version: PAYDAY_SCHEDULE_VERSION,
    sourceType: 'manual_total',
    sourceId: 'manual-dependable-total',
    name: 'Confirmed dependable income',
    matchText: '',
    accountId: '',
    cadence: RECURRING_CADENCE.MONTHLY,
    rule: { type: PAYDAY_RULE.FIXED_DAY, day, weekendAdjustment: WEEKEND_ADJUSTMENT.NONE },
    timingRelationship: PAYDAY_TIMING.CURRENT,
    expectedAmountRange: { min: dependableIncome, max: dependableIncome },
    confirmation: 'user',
    active: true,
    effectiveFrom: null,
    createdAt: null,
    updatedAt: localDateKey(validDate(now))
  })];
  return target;
}

export function deriveIncomeSchedules(state = {}, options = {}) {
  const now = validDate(options.now);
  const working = structuredClone(state || {});
  ensurePaydayConfiguration(working, now);
  const persisted = normaliseIncomeSchedules(working.profile?.incomeSchedules);
  const coveredSources = new Set(persisted.map((item) => `${item.sourceType}:${item.sourceId}`).filter((item) => !item.endsWith(':')));
  const inferred = confirmedRecurringPatterns(working)
    .filter((pattern) => pattern.direction === 'incoming' && SUPPORTED_CADENCES.has(pattern.cadence))
    .filter((pattern) => !coveredSources.has(`recurring_pattern:${pattern.id}`))
    .map((pattern) => scheduleFromRecurringPattern(pattern));
  return [...persisted, ...inferred]
    .filter(Boolean)
    .sort((a, b) => Number(a.confirmation !== 'user') - Number(b.confirmation !== 'user') || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function upsertIncomeSchedule(state = {}, input = {}, now = new Date()) {
  const next = structuredClone(state || {});
  ensurePaydayConfiguration(next, now);
  const existing = normaliseIncomeSchedules(next.profile?.incomeSchedules);
  const requested = normaliseSchedule({
    ...input,
    id: safeId(input.id) || generatedScheduleId(input),
    confirmation: 'user',
    effectiveFrom: validDateKey(input.effectiveFrom) ? input.effectiveFrom : localDateKey(validDate(now)),
    createdAt: validIso(input.createdAt) ? input.createdAt : validDate(now).toISOString(),
    updatedAt: validDate(now).toISOString()
  });
  if (!requested) throw new TypeError('Choose a complete supported income schedule.');
  const index = existing.findIndex((item) => item.id === requested.id);
  if (index >= 0) existing[index] = requested;
  else existing.push(requested);
  next.profile.incomeSchedules = normaliseIncomeSchedules(existing);
  return next;
}

export function removeIncomeSchedule(state = {}, scheduleId) {
  const next = structuredClone(state || {});
  next.profile = next.profile && typeof next.profile === 'object' ? next.profile : {};
  next.profile.incomeSchedules = normaliseIncomeSchedules(next.profile.incomeSchedules).filter((item) => item.id !== String(scheduleId));
  return next;
}

export function buildPaydayContext(state = {}, options = {}) {
  const now = validDate(options.now);
  const today = localDateKey(now);
  const schedules = deriveIncomeSchedules(state, { now });
  const recurring = confirmedRecurringPatterns(state);
  const streams = schedules.map((schedule) => evaluateSchedule(state, schedule, recurring, today));
  const nextPayday = selectNextPayday(streams, today);
  const profile = buildUnifiedFinancialProfile(state, { now });
  const safeUntilPayday = calculateSafeUntilPayday(state, profile, recurring, streams, nextPayday, today);
  return {
    kind: 'payday-awareness',
    asOf: today,
    schedules,
    streams,
    nextPayday,
    missing: streams.filter((stream) => stream.status === PAYDAY_STATUS.MISSING),
    safeUntilPayday,
    consumerSchedule: streams.map((stream) => ({
      id: stream.id,
      name: stream.name,
      cadence: stream.cadence,
      confirmation: stream.confirmation,
      timingRelationship: stream.timingRelationship,
      status: stream.status,
      expected: stream.expected,
      nextExpected: stream.nextExpected,
      amountRange: stream.expectedAmountRange
    }))
  };
}

export function nextDependablePayday(state = {}, now = new Date()) {
  const today = localDateKey(validDate(now));
  const recurring = confirmedRecurringPatterns(state);
  const streams = deriveIncomeSchedules(state, { now }).map((schedule) => evaluateSchedule(state, schedule, recurring, today));
  return selectNextPayday(streams, today);
}

export function missingIncomeReviewSources(state = {}, now = new Date()) {
  const today = localDateKey(validDate(now));
  const recurring = confirmedRecurringPatterns(state);
  return deriveIncomeSchedules(state, { now })
    .map((schedule) => evaluateSchedule(state, schedule, recurring, today))
    .filter((stream) => stream.status === PAYDAY_STATUS.MISSING)
    .map((stream) => ({
      type: 'missing_income',
      priority: 'high',
      sourceType: 'income_schedule',
      sourceId: stream.reviewSourceId,
      groupKey: '',
      conditionKey: `${stream.expected?.date || ''}|${stream.expected?.windowEnd || ''}|${stream.id}`,
      ...REVIEW_SAFETY
    }));
}

export function missingIncomePresentation(state = {}, sourceId, now = new Date()) {
  const context = buildPaydayContext(state, { now });
  const stream = context.streams.find((item) => item.reviewSourceId === String(sourceId));
  if (!stream) return null;
  return {
    title: `${stream.name} has not been matched yet`,
    detail: stream.expected?.date ? `Expected around ${stream.expected.date}. OneStep has not found reliable matching income in the expected window.` : 'Expected income has not been matched.',
    why: 'Expected income is never treated as received money. The missed window stays in Review until trusted evidence arrives or you correct the income schedule.',
    action: 'Review payday',
    consequence: 'Confirming the schedule or importing the missing payment will update Safe Until Payday automatically.'
  };
}

export function scheduleOccurrenceForMonth(schedule, year, month) {
  const normalised = normaliseSchedule(schedule);
  if (!normalised || normalised.cadence !== RECURRING_CADENCE.MONTHLY) return null;
  return occurrenceFromDate(normalised, monthlyDate(normalised, year, month));
}

function evaluateSchedule(state, schedule, recurringPatterns, today) {
  if (schedule.active === false) return { ...schedule, status: PAYDAY_STATUS.INACTIVE, expected: null, nextExpected: null, reviewSourceId: '' };
  const occurrences = nearbyOccurrences(schedule, today);
  const past = occurrences.filter((item) => item.date <= today).at(-1) || null;
  let next = occurrences.find((item) => item.date >= today) || null;
  const evidence = past ? matchIncomeEvidence(state, schedule, past, recurringPatterns) : null;
  const eligibleForMissing = past && missingEligibility(schedule, recurringPatterns, past);
  let status = PAYDAY_STATUS.EXPECTED;
  if (past && evidence) status = PAYDAY_STATUS.RECEIVED;
  else if (past && today > past.windowEnd && eligibleForMissing) status = PAYDAY_STATUS.MISSING;
  else if (past && today >= past.windowStart && today <= past.windowEnd) status = PAYDAY_STATUS.EXPECTED;
  if (status === PAYDAY_STATUS.RECEIVED && next?.date === past?.date) next = occurrences.find((item) => item.date > today) || null;
  const expected = status === PAYDAY_STATUS.MISSING || status === PAYDAY_STATUS.RECEIVED || (past && today >= past.windowStart) ? past : next;
  return {
    ...schedule,
    status,
    expected,
    nextExpected: next,
    received: evidence ? { date: evidence.date, amount: evidence.amount, sourceTypes: evidence.sourceTypes } : null,
    reviewSourceId: status === PAYDAY_STATUS.MISSING && past ? `${schedule.id}@${past.date}` : '',
    why: streamExplanation(schedule, status, expected, evidence)
  };
}

function selectNextPayday(streams, today) {
  const candidates = streams
    .filter((stream) => stream.active !== false && stream.nextExpected)
    .map((stream) => ({
      streamId: stream.id,
      source: stream.name,
      date: stream.nextExpected.date,
      windowStart: stream.nextExpected.windowStart,
      windowEnd: stream.nextExpected.windowEnd,
      daysUntil: dateDistance(today, stream.nextExpected.date),
      confirmation: stream.confirmation,
      status: stream.status
    }))
    .sort((a, b) => a.date.localeCompare(b.date) || Number(a.confirmation !== 'user') - Number(b.confirmation !== 'user') || a.streamId.localeCompare(b.streamId));
  return candidates[0] || null;
}

function calculateSafeUntilPayday(state, profile, recurringPatterns, streams, nextPayday, today) {
  if (!nextPayday) return { status: 'unavailable', amount: null, horizonDate: null, reasonCodes: ['dependable_payday_unknown'], protected: null };
  const reasons = [];
  if (!profile.liquidPosition.complete || profile.liquidPosition.total.status !== UNIFIED_FACT_STATUS.KNOWN) reasons.push('trusted_liquid_position_unavailable');
  if (profile.buffer.balance.status !== UNIFIED_FACT_STATUS.KNOWN || profile.buffer.target.status !== UNIFIED_FACT_STATUS.KNOWN) reasons.push('buffer_unknown');
  const blockingCodes = new Set((profile.uncertainty?.blocking || []).map((item) => item.code));
  for (const code of blockingCodes) {
    if (['dependable_income_not_confirmed'].includes(code)) continue;
    if (code.startsWith('review_missing_income')) continue;
    reasons.push(code);
  }
  const horizon = nextPayday.date;
  const scheduled = [];
  const debt = [];
  for (const item of profile.commitments.items || []) {
    const amount = finiteNonNegative(item.amount?.value);
    if (!(amount >= 0)) continue;
    const due = validDateKey(item.dueDate?.value) ? item.dueDate.value : '';
    if (item.kind === 'required_debt_payment' && amount > 0 && !due) reasons.push('required_debt_due_date_unknown');
    if (!due || due < today || due >= horizon) continue;
    if (item.kind === 'scheduled_payment') scheduled.push({ id: item.id, name: item.name, date: due, amount });
    if (item.kind === 'required_debt_payment') debt.push({ id: item.id, name: item.name, date: due, amount });
  }
  const recurring = recurringCommitmentsBefore(recurringPatterns, today, horizon)
    .filter((item) => ![...scheduled, ...debt].some((known) => likelySameCommitment(known, item)));
  const buffer = finiteNonNegative(profile.buffer.shortfall) ?? 0;
  if ([...new Set(reasons)].length) {
    return {
      status: 'unavailable', amount: null, horizonDate: horizon,
      reasonCodes: [...new Set(reasons)].sort(),
      protected: { scheduled: sumAmounts(scheduled), recurring: sumAmounts(recurring), debt: sumAmounts(debt), buffer, total: null }
    };
  }
  const protectedTotal = roundMoney(sumAmounts(scheduled) + sumAmounts(recurring) + sumAmounts(debt) + buffer);
  const liquid = finiteNonNegative(profile.liquidPosition.total.value) ?? 0;
  const amount = roundMoney(Math.max(0, liquid - protectedTotal));
  const missing = streams.filter((item) => item.status === PAYDAY_STATUS.MISSING).map((item) => item.id);
  return {
    status: 'available',
    amount,
    horizonDate: horizon,
    reasonCodes: ['expected_income_not_counted_before_receipt', ...(missing.length ? ['missing_income_not_counted'] : []), ...(profile.budget?.planned > 0 ? ['undated_budget_context_not_assumed_as_cash'] : [])],
    missingStreamIds: missing,
    protected: { scheduled: sumAmounts(scheduled), recurring: sumAmounts(recurring), debt: sumAmounts(debt), buffer, total: protectedTotal },
    detail: { scheduled, recurring, debt }
  };
}

function recurringCommitmentsBefore(patterns, today, horizon) {
  const output = [];
  for (const pattern of patterns.filter((item) => item.direction === 'outgoing' && SUPPORTED_CADENCES.has(item.cadence))) {
    let date = pattern.nextExpected?.date || nextPatternDate(pattern);
    let guard = 0;
    while (date && date < today && guard++ < 24) date = advanceDate(date, pattern.cadence);
    guard = 0;
    while (date && date < horizon && guard++ < 24) {
      const amount = finiteNonNegative(pattern.amountRange?.max ?? pattern.amountRange?.typical);
      if (amount !== null) output.push({ id: `recurring:${pattern.id}:${date}`, name: pattern.label, date, amount, accountId: pattern.accountId });
      date = advanceDate(date, pattern.cadence);
    }
  }
  return output;
}

function matchIncomeEvidence(state, schedule, occurrence, recurringPatterns) {
  const transactions = (state.transactions || []).filter((item) => isFinanciallyActive(item)
    && isExternalCashflowTransaction(item)
    && Number(item.incoming || 0) > 0
    && validDateKey(item.date)
    && item.date >= occurrence.windowStart
    && item.date <= occurrence.windowEnd
    && matchesIdentity(item, schedule, recurringPatterns)
    && matchesAmount(item.incoming, schedule.expectedAmountRange));
  const payslips = (state.payslips || []).filter((item) => validDateKey(item?.payDate)
    && item.payDate >= occurrence.windowStart
    && item.payDate <= occurrence.windowEnd
    && matchesPayslipIdentity(item, schedule)
    && matchesAmount(item.netPay, schedule.expectedAmountRange));
  if (!transactions.length && !payslips.length) return null;
  const transaction = transactions.sort((a, b) => a.date.localeCompare(b.date))[0];
  const payslip = payslips.sort((a, b) => a.payDate.localeCompare(b.payDate))[0];
  return {
    date: transaction?.date || payslip?.payDate,
    amount: finiteNonNegative(transaction?.incoming ?? payslip?.netPay),
    sourceTypes: [transaction ? 'transaction' : null, payslip ? 'payslip' : null].filter(Boolean)
  };
}

function isFinanciallyActive(item) {
  return Boolean(item) && !item.deletedAt && item.valid !== false && item.financiallyActive !== false
    && item.duplicateStatus !== 'exact' && item.reviewStatus !== 'rejected'
    && !['pending', 'rejected'].includes(item.importReviewStatus);
}

function matchesIdentity(transaction, schedule, recurringPatterns) {
  if (schedule.accountId && String(transaction.accountId || '') !== schedule.accountId) return false;
  const text = normalise([transaction.merchantName, transaction.payee, transaction.userDescription, transaction.description].filter(Boolean).join(' '));
  if (schedule.matchText) return text.includes(normalise(schedule.matchText));
  if (schedule.sourceType === 'recurring_pattern') {
    const pattern = recurringPatterns.find((item) => item.id === schedule.sourceId);
    if (!pattern) return false;
    if (pattern.accountId && pattern.accountId !== 'unknown-account' && String(transaction.accountId || '') !== String(pattern.accountId)) return false;
    return normaliseMerchant(text) === pattern.merchantKey || text.includes(normalise(pattern.label));
  }
  return false;
}

function matchesPayslipIdentity(payslip, schedule) {
  const text = normalise([payslip.employer, payslip.provider, payslip.source].filter(Boolean).join(' '));
  return Boolean(schedule.matchText && text.includes(normalise(schedule.matchText)));
}

function matchesAmount(value, range) {
  if (!range) return true;
  const amount = finiteNonNegative(value);
  if (amount === null) return false;
  return (range.min === null || amount >= range.min) && (range.max === null || amount <= range.max);
}

function nearbyOccurrences(schedule, today) {
  const current = parseDateKey(today);
  if (!current) return [];
  const dates = [];
  if (schedule.cadence === RECURRING_CADENCE.MONTHLY) {
    for (let offset = -2; offset <= 2; offset += 1) {
      const base = new Date(Date.UTC(current.year, current.month - 1 + offset, 1));
      dates.push(monthlyDate(schedule, base.getUTCFullYear(), base.getUTCMonth() + 1));
    }
  } else {
    const anchor = schedule.rule.anchorDate;
    if (!validDateKey(anchor)) return [];
    const interval = cadenceDays(schedule.cadence);
    const distance = dateDistance(anchor, today);
    const near = Math.floor(distance / interval);
    for (let offset = near - 2; offset <= near + 2; offset += 1) dates.push(shiftDate(anchor, offset * interval));
  }
  return [...new Set(dates.filter(validDateKey))].sort().map((date) => occurrenceFromDate(schedule, date));
}

function occurrenceFromDate(schedule, date) {
  const tolerance = schedule.confirmation === 'inferred' && schedule.cadence === RECURRING_CADENCE.MONTHLY ? 3 : 1;
  return { date, windowStart: shiftDate(date, -tolerance), windowEnd: shiftDate(date, tolerance), toleranceDays: tolerance };
}

function monthlyDate(schedule, year, month) {
  const rule = schedule.rule;
  if (rule.type === PAYDAY_RULE.LAST_WORKING_DAY) return lastWorkingDay(year, month);
  if (rule.type === PAYDAY_RULE.LAST_WEEKDAY) return lastSelectedWeekday(year, month, rule.weekday);
  const day = Math.min(rule.day || 1, daysInMonth(year, month));
  let date = dateKey(year, month, day);
  if (rule.weekendAdjustment === WEEKEND_ADJUSTMENT.PREVIOUS) date = adjustWeekend(date, -1);
  if (rule.weekendAdjustment === WEEKEND_ADJUSTMENT.NEXT) date = adjustWeekend(date, 1);
  return date;
}

function missingEligibility(schedule, recurringPatterns, occurrence) {
  if (validDateKey(schedule.effectiveFrom) && occurrence.windowStart >= schedule.effectiveFrom) return true;
  if (schedule.sourceType === 'recurring_pattern') return recurringPatterns.some((item) => item.id === schedule.sourceId && item.occurrences >= 2);
  return false;
}

function scheduleFromRecurringPattern(pattern) {
  const anchor = pattern.dates?.at?.(-1) || pattern.nextExpected?.date;
  if (!validDateKey(anchor)) return null;
  return normaliseSchedule({
    id: `inferred-${pattern.id}`,
    sourceType: 'recurring_pattern',
    sourceId: pattern.id,
    name: pattern.label || 'Recurring income',
    matchText: pattern.label || '',
    accountId: pattern.accountId || '',
    cadence: pattern.cadence,
    rule: pattern.cadence === RECURRING_CADENCE.MONTHLY
      ? { type: PAYDAY_RULE.FIXED_DAY, day: Number(anchor.slice(8, 10)), weekendAdjustment: WEEKEND_ADJUSTMENT.NONE, anchorDate: anchor }
      : { type: PAYDAY_RULE.ANCHOR, anchorDate: anchor },
    timingRelationship: PAYDAY_TIMING.CURRENT,
    expectedAmountRange: pattern.amountRange ? { min: pattern.amountRange.min, max: pattern.amountRange.max } : null,
    confirmation: 'inferred',
    active: true,
    effectiveFrom: pattern.dates?.[0] || null,
    createdAt: null,
    updatedAt: null
  });
}

function normaliseSchedule(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = safeId(item.id);
  const cadence = SUPPORTED_CADENCES.has(item.cadence) ? item.cadence : '';
  if (!id || !cadence) return null;
  const rule = normaliseRule(item.rule, cadence);
  if (!rule) return null;
  const timingRelationship = Object.values(PAYDAY_TIMING).includes(item.timingRelationship) ? item.timingRelationship : PAYDAY_TIMING.CURRENT;
  const confirmation = item.confirmation === 'inferred' ? 'inferred' : 'user';
  return {
    version: PAYDAY_SCHEDULE_VERSION,
    id,
    sourceType: safeToken(item.sourceType, 40) || 'manual',
    sourceId: String(item.sourceId || '').slice(0, 180),
    name: String(item.name || 'Income stream').trim().replace(/\s+/g, ' ').slice(0, 120) || 'Income stream',
    matchText: String(item.matchText || '').trim().replace(/\s+/g, ' ').slice(0, 120),
    accountId: String(item.accountId || '').slice(0, 120),
    cadence,
    rule,
    timingRelationship,
    expectedAmountRange: normaliseAmountRange(item.expectedAmountRange),
    confirmation,
    active: item.active !== false,
    effectiveFrom: validDateKey(item.effectiveFrom) ? item.effectiveFrom : null,
    createdAt: validIso(item.createdAt) ? item.createdAt : null,
    updatedAt: validIso(item.updatedAt) ? item.updatedAt : null
  };
}

function normaliseRule(value, cadence) {
  const rule = value && typeof value === 'object' ? value : {};
  if (cadence !== RECURRING_CADENCE.MONTHLY) return validDateKey(rule.anchorDate) ? { type: PAYDAY_RULE.ANCHOR, anchorDate: rule.anchorDate } : null;
  const type = Object.values(PAYDAY_RULE).includes(rule.type) ? rule.type : PAYDAY_RULE.FIXED_DAY;
  if (type === PAYDAY_RULE.LAST_WORKING_DAY) return { type, anchorDate: validDateKey(rule.anchorDate) ? rule.anchorDate : null };
  if (type === PAYDAY_RULE.LAST_WEEKDAY) {
    const weekday = Number(rule.weekday);
    return Number.isInteger(weekday) && weekday >= 0 && weekday <= 6 ? { type, weekday, anchorDate: validDateKey(rule.anchorDate) ? rule.anchorDate : null } : null;
  }
  const day = validDay(rule.day);
  if (!day) return null;
  const weekendAdjustment = Object.values(WEEKEND_ADJUSTMENT).includes(rule.weekendAdjustment) ? rule.weekendAdjustment : WEEKEND_ADJUSTMENT.NONE;
  return { type: PAYDAY_RULE.FIXED_DAY, day, weekendAdjustment, anchorDate: validDateKey(rule.anchorDate) ? rule.anchorDate : null };
}

function normaliseAmountRange(value) {
  if (!value || typeof value !== 'object') return null;
  const min = finiteNonNegative(value.min);
  const max = finiteNonNegative(value.max);
  if (min === null && max === null) return null;
  if (min !== null && max !== null && max < min) return { min: max, max: min };
  return { min, max };
}

function generatedScheduleId(input) {
  const identity = [input.name, input.sourceType, input.sourceId, input.cadence, JSON.stringify(input.rule || {})].join('|');
  return `income-${hashId(identity)}`;
}

function streamExplanation(schedule, status, expected, evidence) {
  const timing = schedule.timingRelationship === PAYDAY_TIMING.ARREARS ? ' Pay is recorded as relating to an earlier earning period.' : '';
  if (status === PAYDAY_STATUS.RECEIVED) return `Trusted ${evidence?.sourceTypes?.join(' + ') || 'income'} evidence matches the expected window. Payslip and bank evidence are treated as one income event, not added together.${timing}`;
  if (status === PAYDAY_STATUS.MISSING) return `The expected window ended without reliable matching income. OneStep has not assumed that money exists.${timing}`;
  return `Income is expected in the configured local window. It is not included in spendable money until matching evidence is received.${timing}`;
}

function nextPatternDate(pattern) {
  const anchor = pattern.dates?.at?.(-1);
  return validDateKey(anchor) ? advanceDate(anchor, pattern.cadence) : '';
}

function advanceDate(value, cadence) {
  if (!validDateKey(value)) return '';
  if (cadence === RECURRING_CADENCE.WEEKLY) return shiftDate(value, 7);
  if (cadence === RECURRING_CADENCE.FORTNIGHTLY) return shiftDate(value, 14);
  if (cadence === RECURRING_CADENCE.FOUR_WEEKLY) return shiftDate(value, 28);
  if (cadence === RECURRING_CADENCE.MONTHLY) return shiftMonth(value, 1);
  return '';
}

function shiftMonth(value, offset) {
  const parsed = parseDateKey(value);
  if (!parsed) return '';
  const wasMonthEnd = parsed.day === daysInMonth(parsed.year, parsed.month);
  const base = new Date(Date.UTC(parsed.year, parsed.month - 1 + offset, 1));
  const year = base.getUTCFullYear(); const month = base.getUTCMonth() + 1;
  const day = wasMonthEnd ? daysInMonth(year, month) : Math.min(parsed.day, daysInMonth(year, month));
  return dateKey(year, month, day);
}

function lastWorkingDay(year, month) {
  let day = daysInMonth(year, month);
  while ([0, 6].includes(new Date(Date.UTC(year, month - 1, day)).getUTCDay())) day -= 1;
  return dateKey(year, month, day);
}

function lastSelectedWeekday(year, month, weekday) {
  let day = daysInMonth(year, month);
  while (new Date(Date.UTC(year, month - 1, day)).getUTCDay() !== Number(weekday)) day -= 1;
  return dateKey(year, month, day);
}

function adjustWeekend(value, direction) {
  let date = value;
  let weekday = weekdayFor(date);
  while ([0, 6].includes(weekday)) {
    date = shiftDate(date, direction);
    weekday = weekdayFor(date);
  }
  return date;
}

function likelySameCommitment(left, right) {
  if (left.date !== right.date || Math.abs(Number(left.amount) - Number(right.amount)) > 0.01) return false;
  return normalise(left.name).includes(normalise(right.name)) || normalise(right.name).includes(normalise(left.name));
}

function sumAmounts(rows) { return roundMoney(rows.reduce((sum, item) => sum + Number(item.amount || 0), 0)); }
function cadenceDays(cadence) { return ({ weekly: 7, fortnightly: 14, 'four-weekly': 28 })[cadence] || 0; }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function dateKey(year, month, day) { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; }
function weekdayFor(value) { const parsed = parseDateKey(value); return parsed ? new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay() : -1; }
function shiftDate(value, days) { const parsed = parseDateKey(value); if (!parsed) return ''; const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days)); return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()); }
function dateDistance(left, right) { const a = parseDateKey(left); const b = parseDateKey(right); return a && b ? Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000) : 0; }
function parseDateKey(value) { if (!validDateKey(value)) return null; const [year, month, day] = value.split('-').map(Number); return { year, month, day }; }
function validDateKey(value) { const text = String(value || '').slice(0, 10); if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(text)) return false; const parsed = new Date(`${text}T00:00:00.000Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text; }
function validDay(value) { const day = Number(value); return Number.isInteger(day) && day >= 1 && day <= 31 ? day : null; }
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value || Date.now()); return Number.isNaN(date.getTime()) ? new Date() : date; }
function localDateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function finiteNonNegative(value) { if (value === null || value === undefined || value === '') return null; const number = Number(value); return Number.isFinite(number) && number >= 0 ? roundMoney(number) : null; }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function safeId(value) { return /^[A-Za-z0-9][A-Za-z0-9._:-]{1,159}$/.test(String(value || '')) ? String(value) : ''; }
function safeToken(value, length) { return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, length); }
function hashId(value) { let hash = 2166136261; for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `${(hash >>> 0).toString(36)}-${String(value).length}`; }
function normalise(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normaliseMerchant(value) { return normalise(value).replace(/\b(?:card|visa|mastercard|debit|credit|contactless|faster payment|faster payments|direct debit|standing order|bacs|fps|fpi|fpo)\b/g, ' ').replace(/\b\d{4,}\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' '); }
