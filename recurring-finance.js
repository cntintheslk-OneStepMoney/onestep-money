const CADENCES = Object.freeze({
  WEEKLY: 'weekly',
  FORTNIGHTLY: 'fortnightly',
  FOUR_WEEKLY: 'four-weekly',
  MONTHLY: 'monthly',
  QUARTERLY: 'quarterly',
  ANNUAL: 'annual'
});

export const RECURRING_CADENCE = CADENCES;
export const RECURRING_CONFIDENCE = Object.freeze({ CONFIRMED: 'confirmed', LIKELY: 'likely', UNCERTAIN: 'uncertain' });
export const RECURRING_DECISION = Object.freeze({ CONFIRMED: 'confirmed', REJECTED: 'rejected' });

export function deriveRecurringPatterns(state = {}, options = {}) {
  const transactions = (state.transactions || []).filter(isEligibleTransaction);
  const groups = new Map();
  for (const transaction of transactions) {
    const identity = transactionIdentity(transaction);
    if (!identity) continue;
    const key = [identity.direction, identity.accountId, identity.merchantKey, identity.purposeKey].join('|');
    if (!groups.has(key)) groups.set(key, { identity, transactions: [] });
    groups.get(key).transactions.push(transaction);
  }

  const patterns = [];
  for (const group of groups.values()) {
    const rows = uniqueTransactions(group.transactions).sort((a, b) => localDateKey(a.date).localeCompare(localDateKey(b.date)));
    if (rows.length < 2) continue;
    const dates = unique(rows.map((row) => localDateKey(row.date)).filter(Boolean));
    if (dates.length < 2) continue;
    const cadence = detectCadence(dates);
    if (!cadence) continue;
    const amounts = rows.map(transactionAmount).filter((value) => Number.isFinite(value) && value >= 0);
    const sourceTransactionIds = rows.map((row) => String(row.id || '')).filter(Boolean);
    const patternId = stableId('recurring', [group.identity.direction, group.identity.accountId, group.identity.merchantKey, group.identity.purposeKey, cadence].join('|'));
    const evidenceFingerprint = stableId('evidence', rows.map((row) => [
      String(row.id || ''),
      localDateKey(row.date),
      moneyFingerprint(transactionAmount(row)),
      String(row.providerTransactionId || ''),
      String(row.reference || '')
    ].join(':')).join('|'));
    const decision = matchingDecision(rows, patternId, evidenceFingerprint);
    const inferredConfidence = inferConfidence(rows, dates, cadence);
    const confidence = decision === RECURRING_DECISION.CONFIRMED ? RECURRING_CONFIDENCE.CONFIRMED : inferredConfidence;
    const amountRange = moneyRange(amounts);
    const nextExpected = expectedNextOccurrence({ cadence, dates, lastDate: dates.at(-1) });
    const purpose = displayPurpose(rows, group.identity.purposeKey);
    const label = displayIdentity(rows, group.identity.merchantKey);
    patterns.push({
      id: patternId,
      evidenceFingerprint,
      direction: group.identity.direction,
      accountId: group.identity.accountId,
      merchantKey: group.identity.merchantKey,
      purposeKey: group.identity.purposeKey,
      label,
      purpose,
      cadence,
      confidence,
      confirmationState: decision || 'unconfirmed',
      occurrences: dates.length,
      dates,
      sourceTransactionIds,
      amountRange,
      nextExpected: confidence === RECURRING_CONFIDENCE.CONFIRMED ? nextExpected : null,
      why: recurringPatternExplanation({ cadence, occurrences: dates.length, label, purpose, amountRange, decision, confidence })
    });
  }

  const includeRejected = options.includeRejected !== false;
  return patterns
    .filter((pattern) => includeRejected || pattern.confirmationState !== RECURRING_DECISION.REJECTED)
    .sort(comparePatterns);
}

export function confirmedRecurringPatterns(state = {}) {
  return deriveRecurringPatterns(state, { includeRejected: false }).filter((pattern) => pattern.confidence === RECURRING_CONFIDENCE.CONFIRMED);
}

export function confirmedRecurringTransactionIds(state = {}) {
  const ids = new Set(confirmedRecurringPatterns(state).flatMap((pattern) => pattern.sourceTransactionIds));
  for (const transaction of state.transactions || []) {
    if (transaction?.recurring === true && isEligibleTransaction(transaction)) ids.add(String(transaction.id));
  }
  return ids;
}

export function applyRecurringPatternDecision(state, patternId, decision, now = new Date()) {
  if (![RECURRING_DECISION.CONFIRMED, RECURRING_DECISION.REJECTED].includes(decision)) throw new TypeError('Recurring pattern decision must be confirmed or rejected.');
  const pattern = deriveRecurringPatterns(state, { includeRejected: true }).find((item) => item.id === patternId);
  if (!pattern) throw new Error('This recurring pattern is no longer available. Refresh and review the latest evidence.');
  const next = structuredClone(state);
  const decidedAt = validDate(now) ? now.toISOString() : new Date().toISOString();
  const sourceIds = new Set(pattern.sourceTransactionIds.map(String));
  for (const transaction of next.transactions || []) {
    if (!sourceIds.has(String(transaction.id))) continue;
    transaction.recurringPatternDecision = {
      patternId: pattern.id,
      evidenceFingerprint: pattern.evidenceFingerprint,
      decision,
      decidedAt
    };
    if (decision === RECURRING_DECISION.CONFIRMED) transaction.recurring = true;
    else if (transaction.recurringPatternDecisionSource === 'pattern') transaction.recurring = false;
    transaction.recurringPatternDecisionSource = 'pattern';
  }
  return next;
}

export function expectedNextOccurrence(pattern) {
  const cadence = pattern?.cadence;
  const lastDate = localDateKey(pattern?.lastDate || pattern?.dates?.at?.(-1));
  if (!lastDate || !Object.values(CADENCES).includes(cadence)) return null;
  const [year, month, day] = lastDate.split('-').map(Number);
  let next;
  if (cadence === CADENCES.WEEKLY) next = addDays(year, month, day, 7);
  else if (cadence === CADENCES.FORTNIGHTLY) next = addDays(year, month, day, 14);
  else if (cadence === CADENCES.FOUR_WEEKLY) next = addDays(year, month, day, 28);
  else if (cadence === CADENCES.MONTHLY) next = addMonths(year, month, day, 1);
  else if (cadence === CADENCES.QUARTERLY) next = addMonths(year, month, day, 3);
  else next = addMonths(year, month, day, 12);
  const tolerance = [CADENCES.WEEKLY, CADENCES.FORTNIGHTLY, CADENCES.FOUR_WEEKLY].includes(cadence) ? 1 : cadence === CADENCES.MONTHLY ? 3 : 5;
  return {
    date: next,
    windowStart: shiftLocalDate(next, -tolerance),
    windowEnd: shiftLocalDate(next, tolerance),
    toleranceDays: tolerance
  };
}

export function detectCadence(dates = []) {
  const ordered = unique(dates.map(localDateKey).filter(Boolean)).sort();
  if (ordered.length < 2) return '';
  const intervals = ordered.slice(1).map((date, index) => dateDistance(ordered[index], date));
  const exactInterval = (minimum, maximum) => intervals.every((days) => days >= minimum && days <= maximum);
  if (exactInterval(6, 8)) return CADENCES.WEEKLY;
  if (exactInterval(13, 15)) return CADENCES.FORTNIGHTLY;

  const monthProgression = calendarProgression(ordered, 1, 4);
  if (exactInterval(27, 29) && !monthProgression) return CADENCES.FOUR_WEEKLY;
  if (monthProgression) return CADENCES.MONTHLY;
  if (exactInterval(27, 29)) return CADENCES.FOUR_WEEKLY;
  if (calendarProgression(ordered, 3, 6)) return CADENCES.QUARTERLY;
  if (calendarProgression(ordered, 12, 7)) return CADENCES.ANNUAL;
  return '';
}

export function recurringPatternExplanation(pattern = {}) {
  const occurrenceText = `${pattern.occurrences || 0} matching occurrence${pattern.occurrences === 1 ? '' : 's'}`;
  const amountText = pattern.amountRange?.min === pattern.amountRange?.max
    ? `with the same amount each time`
    : pattern.amountRange ? `with amounts normally between ${formatPlainMoney(pattern.amountRange.min)} and ${formatPlainMoney(pattern.amountRange.max)}` : 'with amount evidence unavailable';
  if (pattern.decision === RECURRING_DECISION.CONFIRMED) return `You confirmed this pattern. OneStep also found ${occurrenceText} on a ${pattern.cadence} cadence ${amountText}.`;
  if (pattern.decision === RECURRING_DECISION.REJECTED) return `You rejected this pattern for the current evidence. It will stay rejected unless the underlying evidence materially changes.`;
  return `OneStep found ${occurrenceText} for the same account, direction and payee/purpose on a ${pattern.cadence} cadence ${amountText}.`;
}

function transactionIdentity(transaction) {
  const direction = Number(transaction.incoming || 0) > 0 ? 'incoming' : Number(transaction.outgoing || 0) > 0 ? 'outgoing' : '';
  if (!direction) return null;
  const merchantKey = normaliseMerchant(transaction.merchantName || transaction.payee || transaction.description || transaction.userDescription);
  if (!merchantKey) return null;
  const purposeKey = normalise(transaction.budgetCategoryId || transaction.category || transaction.transactionPurpose || 'unclassified');
  return { direction, accountId: String(transaction.accountId || 'unknown-account'), merchantKey, purposeKey };
}

function isEligibleTransaction(transaction = {}) {
  if (!transaction || !transaction.id || !localDateKey(transaction.date)) return false;
  if (transaction.financiallyActive === false) return false;
  if (['possible', 'exact'].includes(transaction.duplicateStatus) && transaction.reviewStatus !== 'accepted') return false;
  if (['pending', 'rejected'].includes(transaction.importReviewStatus)) return false;
  if (['confirmed', 'possible'].includes(transaction.transferStatus)) return false;
  const treatment = normalise(transaction.budgetTreatment);
  if (['transfer', 'savings_transfer', 'ignored', 'debt_payment'].includes(treatment)) return false;
  const category = normalise(transaction.category);
  if (/^(debt|credit card|loan|finance) payment$/.test(category)) return false;
  return Number(transaction.incoming || 0) > 0 || Number(transaction.outgoing || 0) > 0;
}

function inferConfidence(rows, dates, cadence) {
  if (rows.some((row) => row.recurring === true)) return RECURRING_CONFIDENCE.CONFIRMED;
  const strongCadence = cadence && dates.length >= 4;
  if (strongCadence) return RECURRING_CONFIDENCE.CONFIRMED;
  if (dates.length >= 3) return RECURRING_CONFIDENCE.LIKELY;
  return RECURRING_CONFIDENCE.UNCERTAIN;
}

function matchingDecision(rows, patternId, evidenceFingerprint) {
  const decisions = rows.map((row) => row.recurringPatternDecision).filter((decision) => decision
    && decision.patternId === patternId
    && decision.evidenceFingerprint === evidenceFingerprint
    && [RECURRING_DECISION.CONFIRMED, RECURRING_DECISION.REJECTED].includes(decision.decision));
  if (!decisions.length) return '';
  const values = new Set(decisions.map((decision) => decision.decision));
  return values.size === 1 ? decisions[0].decision : '';
}

function calendarProgression(dates, monthsApart, toleranceDays) {
  return dates.slice(1).every((date, index) => {
    const previous = parseLocalDate(dates[index]);
    const current = parseLocalDate(date);
    const months = (current.year - previous.year) * 12 + current.month - previous.month;
    if (months !== monthsApart) return false;
    if (isMonthEnd(previous) && isMonthEnd(current)) return true;
    return Math.abs(current.day - previous.day) <= toleranceDays;
  });
}

function moneyFingerprint(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? String(Math.round((amount + Number.EPSILON) * 100)) : '';
}

function transactionAmount(transaction) {
  return Number(transaction.incoming || 0) > 0 ? Number(transaction.incoming) : Number(transaction.outgoing || 0);
}

function moneyRange(values) {
  if (!values.length) return null;
  const min = roundMoney(Math.min(...values));
  const max = roundMoney(Math.max(...values));
  const typical = roundMoney(values.reduce((sum, value) => sum + value, 0) / values.length);
  return { min, max, typical };
}

function displayIdentity(rows, fallback) {
  const source = rows.map((row) => row.merchantName || row.payee || row.userDescription || row.description).find(Boolean);
  return String(source || fallback || 'Recurring activity').trim();
}

function displayPurpose(rows, fallback) {
  const source = rows.map((row) => row.transactionPurpose || row.category).find(Boolean);
  return String(source || fallback || 'Uncategorised').trim();
}

function comparePatterns(left, right) {
  const confidenceRank = { confirmed: 0, likely: 1, uncertain: 2 };
  const rejectedDifference = Number(left.confirmationState === 'rejected') - Number(right.confirmationState === 'rejected');
  return rejectedDifference || (confidenceRank[left.confidence] - confidenceRank[right.confidence]) || left.label.localeCompare(right.label);
}

function uniqueTransactions(rows) {
  return [...new Map(rows.map((row) => [String(row.id), row])).values()];
}

function unique(values) { return [...new Set(values)]; }
function normalise(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function normaliseMerchant(value) {
  return normalise(value)
    .replace(/\b(?:card|visa|mastercard|debit|credit|contactless|faster payment|faster payments|direct debit|standing order|bacs|fps|fpi|fpo)\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim().replace(/\s+/g, ' ');
}

function localDateKey(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return '';
  const parsed = parseLocalDate(text);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  return date.getUTCFullYear() === parsed.year && date.getUTCMonth() === parsed.month - 1 && date.getUTCDate() === parsed.day ? text : '';
}

function parseLocalDate(value) {
  const [year, month, day] = String(value).slice(0, 10).split('-').map(Number);
  return { year, month, day };
}

function dateDistance(left, right) {
  const a = parseLocalDate(left); const b = parseLocalDate(right);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

function addDays(year, month, day, days) {
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return utcDateKey(date);
}

function addMonths(year, month, day, months) {
  const sourceLastDay = daysInMonth(year, month);
  const sourceWasMonthEnd = day === sourceLastDay;
  const targetBase = new Date(Date.UTC(year, month - 1 + months, 1));
  const targetYear = targetBase.getUTCFullYear();
  const targetMonth = targetBase.getUTCMonth() + 1;
  const targetLastDay = daysInMonth(targetYear, targetMonth);
  return `${targetYear}-${pad(targetMonth)}-${pad(sourceWasMonthEnd ? targetLastDay : Math.min(day, targetLastDay))}`;
}

function shiftLocalDate(value, days) {
  const { year, month, day } = parseLocalDate(value);
  return addDays(year, month, day, days);
}

function isMonthEnd(value) { return value.day === daysInMonth(value.year, value.month); }
function daysInMonth(year, month) { return new Date(Date.UTC(year, month, 0)).getUTCDate(); }
function utcDateKey(date) { return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`; }
function pad(value) { return String(value).padStart(2, '0'); }
function roundMoney(value) { return Math.round((Number(value) + Number.EPSILON) * 100) / 100; }
function validDate(value) { return value instanceof Date && !Number.isNaN(value.getTime()); }
function formatPlainMoney(value) { return `£${Number(value || 0).toFixed(2)}`; }

function stableId(prefix, value) {
  let hash = 2166136261;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
