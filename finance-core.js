import { localFinancialMonthKey } from './date-utils.js';
import { synchroniseReviewItems } from './review-lifecycle.js';
import { prioritySnapshot } from './next-move-priority.js';
import { resolveTransactionBudgetAssignment } from './transaction-categorisation.js';

export const SCHEMA_VERSION = 9;
export const ALL_TIME_PERIOD = 'all';
export const INCOME_PAYMENT_CATEGORY = 'Income';

export function formatCurrency(value, options = {}) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP',
    minimumFractionDigits: options.whole ? 0 : 2,
    maximumFractionDigits: options.whole ? 0 : 2
  }).format(Number(value || 0));
}

export function formatDate(value) {
  if (!value) return 'Not set';
  const date = new Date(`${String(value).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return 'Not set';
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

export function createId(prefix = 'item') {
  const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${id}`;
}

export function availableReportingMonths(state = {}, fallbackMonth = state.settings?.selectedMonth || currentMonth()) {
  const months = new Set();
  for (const transaction of state.transactions || []) {
    const month = reportingMonth(transaction.budgetMonth) || reportingMonth(transaction.date);
    if (month) months.add(month);
  }
  for (const payslip of state.payslips || []) {
    const month = reportingMonth(payslip.period) || reportingMonth(payslip.payDate);
    if (month) months.add(month);
  }
  if (months.size) return [...months].sort().reverse();
  return [reportingMonth(fallbackMonth) || currentMonth()];
}

export function periodTransactions(transactions, month) {
  return (transactions || []).filter((transaction) => (month === ALL_TIME_PERIOD
    || String(transaction.budgetMonth || transaction.date || '').slice(0, 7) === month)
    && isTransactionFinanciallyActive(transaction));
}

export function calculatePeriodSummary(state, month = state.settings?.selectedMonth) {
  const monthCount = reportingPeriodMonthCount(state, month);
  const rows = periodTransactions(state.transactions, month);
  const external = rows.filter(isExternalCashflowTransaction);
  const income = sum(external, 'incoming');
  const spending = sum(external, 'outgoing');
  const payslips = (state.payslips || []).filter((payslip) => month === ALL_TIME_PERIOD || payslip.period === month);
  const grossPay = sum(payslips, 'grossPay');
  const payrollDeductions = sum(payslips, 'totalDeductions');
  const netPay = sum(payslips, 'netPay');
  const budget = calculateBudgetAnalysis(state, month);
  const plannedSpending = budget.planned;
  const dependableMonthlyIncome = Number(state.profile?.dependableIncome || 0);
  const dependableIncome = roundMoney(dependableMonthlyIncome * monthCount);
  const plannedMargin = roundMoney(dependableIncome - plannedSpending);
  const overdrafts = sum(state.overdrafts, 'currentBalance');
  const debts = sum(state.debts, 'currentBalance');
  return {
    month, monthCount, income, spending, netCashFlow: roundMoney(income - spending),
    grossPay, payrollDeductions, netPay, dependableMonthlyIncome, dependableIncome, plannedSpending, plannedMargin,
    budgetActualSpending: budget.actual, budgetCategorisedSpending: budget.categorisedActual,
    budgetUncategorisedSpending: budget.uncategorisedActual, budgetRemaining: budget.remaining,
    debts, overdrafts, totalOwed: roundMoney(debts + overdrafts), transactionCount: rows.length
  };
}

export function calculateBudgetRows(state, month = state.settings?.selectedMonth) {
  return calculateBudgetAnalysis(state, month).rows;
}

export function removeBudgetCategory(state, budgetId) {
  const next = structuredClone(state);
  const budgetExists = (next.budgets || []).some((budget) => budget.id === budgetId);
  if (!budgetExists) throw new Error('This budget category is no longer available.');
  next.budgets = next.budgets.filter((budget) => budget.id !== budgetId);
  for (const transaction of next.transactions || []) {
    if (transaction.budgetCategoryId !== budgetId) continue;
    transaction.budgetCategoryId = '';
    transaction.categorySource = 'manual';
  }
  return next;
}

export function calculateBudgetAnalysis(state, month = state.settings?.selectedMonth) {
  const budgets = (state.budgets || []).filter((budget) => !isIncomeCategory(budget.category));
  const monthCount = reportingPeriodMonthCount(state, month);
  const transactions = periodTransactions(state.transactions, month);
  const actualPennies = new Map(budgets.map((budget) => [String(budget.id), 0]));
  const contributions = new Map(budgets.map((budget) => [String(budget.id), []]));
  const assignmentCache = new Map();
  const uncategorisedTransactionIds = [];
  let uncategorisedPennies = 0;
  let categorisedGrossPennies = 0;
  let eligibleGrossPennies = 0;

  const assignedBudget = (transaction) => {
    const transactionId = String(transaction?.id || '');
    if (transactionId && assignmentCache.has(transactionId)) return assignmentCache.get(transactionId);
    const match = resolveTransactionBudgetAssignment(transaction, { budgets, transactions: state.transactions || [] }).budget;
    if (transactionId) assignmentCache.set(transactionId, match);
    return match;
  };

  for (const transaction of transactions) {
    const treatment = normaliseBudgetTreatment(transaction.budgetTreatment);
    if (transaction.transferStatus === 'confirmed' || ['transfer', 'savings_transfer', 'ignored'].includes(treatment)) continue;
    if (isIncomePayment(transaction)) continue;

    const outgoingPennies = Math.max(0, moneyToPennies(transaction.outgoing));
    const incomingPennies = Math.max(0, moneyToPennies(transaction.incoming));
    const budget = assignedBudget(transaction);
    const isDebtPayment = treatment === 'debt_payment' || /^(?:debt|credit card|loan|finance) payment$/.test(normalise(transaction.category));
    if (isDebtPayment && !budget) continue;

    if (outgoingPennies > 0) {
      eligibleGrossPennies += outgoingPennies;
      if (budget) {
        const id = String(budget.id);
        actualPennies.set(id, (actualPennies.get(id) || 0) + outgoingPennies);
        categorisedGrossPennies += outgoingPennies;
        contributions.get(id).push(budgetContribution(transaction, outgoingPennies));
      } else {
        uncategorisedPennies += outgoingPennies;
        uncategorisedTransactionIds.push(transaction.id);
      }
    }

    const isRefund = ['refund', 'reversal'].includes(treatment)
      || Boolean(transaction.refundOfTransactionId || transaction.reversalOfTransactionId)
      || Boolean(budget && incomingPennies > 0);
    if (incomingPennies > 0 && isRefund && budget) {
      const id = String(budget.id);
      actualPennies.set(id, (actualPennies.get(id) || 0) - incomingPennies);
      contributions.get(id).push(budgetContribution(transaction, -incomingPennies));
    }
  }

  const rows = budgets.map((budget) => {
    const monthlyPlanned = penniesToMoney(moneyToPennies(budget.planned));
    const plannedPennies = moneyToPennies(monthlyPlanned) * monthCount;
    const actual = penniesToMoney(actualPennies.get(String(budget.id)) || 0);
    const planned = penniesToMoney(plannedPennies);
    const remaining = penniesToMoney(plannedPennies - moneyToPennies(actual));
    return {
      ...budget, monthlyPlanned, planned, actual, remaining,
      progressPercent: plannedPennies > 0 ? Math.max(0, Math.round(((actualPennies.get(String(budget.id)) || 0) / plannedPennies) * 100)) : null,
      contributions: contributions.get(String(budget.id)) || []
    };
  }).sort(compareBudgetUsageDescending);
  const plannedPennies = rows.reduce((total, row) => total + moneyToPennies(row.planned), 0);
  const categorisedPennies = rows.reduce((total, row) => total + moneyToPennies(row.actual), 0);
  const totalActualPennies = categorisedPennies + uncategorisedPennies;
  return {
    month,
    monthCount,
    rows,
    planned: penniesToMoney(plannedPennies),
    categorisedActual: penniesToMoney(categorisedPennies),
    uncategorisedActual: penniesToMoney(uncategorisedPennies),
    actual: penniesToMoney(totalActualPennies),
    remaining: penniesToMoney(plannedPennies - totalActualPennies),
    coveragePercent: eligibleGrossPennies > 0 ? Math.round((categorisedGrossPennies / eligibleGrossPennies) * 100) : 100,
    uncategorisedTransactionIds
  };
}

export function isIncomePayment(transaction = {}) {
  return isIncomeCategory(transaction.category);
}

export function reportingPeriodMonthCount(state, month = state.settings?.selectedMonth) {
  if (month !== ALL_TIME_PERIOD) return 1;
  const months = new Set();
  for (const transaction of state.transactions || []) {
    if (!isTransactionFinanciallyActive(transaction)) continue;
    const reportingPeriod = reportingMonth(transaction.budgetMonth) || reportingMonth(transaction.date);
    if (reportingPeriod) months.add(reportingPeriod);
  }
  for (const payslip of state.payslips || []) {
    const reportingPeriod = reportingMonth(payslip.period) || reportingMonth(payslip.payDate);
    if (reportingPeriod) months.add(reportingPeriod);
  }
  return Math.max(1, months.size);
}

function compareBudgetUsageDescending(left, right) {
  const leftUsage = budgetUsageRatio(left);
  const rightUsage = budgetUsageRatio(right);
  if (leftUsage === rightUsage) return 0;
  return rightUsage > leftUsage ? 1 : -1;
}

function budgetUsageRatio(row) {
  const plannedPennies = moneyToPennies(row.planned);
  const actualPennies = moneyToPennies(row.actual);
  if (plannedPennies > 0) return Math.max(0, actualPennies / plannedPennies);
  return actualPennies > 0 ? Number.POSITIVE_INFINITY : 0;
}

export function buildNextAction(state, now = new Date()) {
  const snapshot = prioritySnapshot(state, now, { safetyAssessment: debtSafetyAssessment(state) });
  if (!snapshot.nextMove) return {
    id: 'next-move-caught-up', title: 'You’re caught up for now',
    detail: snapshot.lowPriorityRemaining
      ? 'Lower-priority housekeeping remains available in Review Inbox, but nothing needs to take over Today.'
      : 'There is no unresolved work worth surfacing today.',
    timeframe: 'Done', stage: 'today', passive: true
  };
  const next = snapshot.nextMove;
  const task = next.item.sourceType === 'task' ? (state.tasks || []).find((entry) => String(entry.id) === next.item.sourceId) : null;
  return {
    id: `next-move-${next.item.id}`,
    reviewId: next.item.id,
    completeDirect: next.item.type === 'generated_action' && !task?.actionView && !task?.view,
    title: next.title,
    detail: next.detail,
    timeframe: next.timeframe,
    stage: 'today',
    priorityBand: next.priorityBand,
    priorityReason: next.priorityReason,
    actionLabel: next.actionLabel
  };
}

export function hasCompletedCheckIn(checkIns = [], now = new Date()) {
  const today = localDateKey(now);
  return checkIns.some((entry) => entry.completed !== false && localDateKey(new Date(entry.date)) === today);
}

export function calculateStreak(checkIns = [], now = new Date()) {
  const weeks = new Set(checkIns.map((entry) => weekKey(new Date(entry.date))));
  let streak = 0;
  const cursor = new Date(now);
  for (let index = 0; index < 52; index += 1) {
    if (!weeks.has(weekKey(cursor))) break;
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }
  return streak;
}

export function buildFinancialChecks(state, month = state.settings?.selectedMonth) {
  if (isBlankState(state)) return [
    { tone: 'neutral', title: 'Start with one account', text: 'Add only the account name and type. You can fill in the balance after importing a statement.' },
    { tone: 'neutral', title: 'Your data starts empty', text: 'No example transactions, debts, payslips or balances are included in a new installation.' }
  ];
  const summary = calculatePeriodSummary(state, month);
  const checks = [];
  const safety = debtSafetyAssessment(state);
  const unsafe = safety.accounts.find((item) => item.blockingReasons.length);
  const overLimit = safety.accounts.find((item) => item.overLimit);
  const protectedArrangements = safety.accounts.filter((item) => item.arrangementStatus === 'confirmed' && ['arrears', 'defaulted'].includes(item.effectiveStatus));
  if (unsafe) checks.push({ tone: 'warning', title: 'Extra payments paused for safety', text: unsafe.blockingReasons[0] });
  if (overLimit) checks.push({ tone: 'urgent', title: 'Account above its limit', text: `${overLimit.name} is being prioritised as an over-limit account. Essential commitments still come before reducing it.` });
  if (protectedArrangements.length) checks.push({ tone: 'neutral', title: 'Agreed payments protected', text: `${protectedArrangements.length} payment arrangement${protectedArrangements.length === 1 ? ' is' : 's are'} included as required spending. OneStep is not adding discretionary payments to those accounts.` });
  if (summary.plannedMargin >= 0 && safety.plannedCapacity > 0) checks.push({ tone: 'positive', title: 'Provisional room after commitments', text: `${formatCurrency(safety.plannedCapacity)} remains after the budgets, required payments, scheduled commitments and selected buffer currently recorded. Treat it as provisional until every essential bill is entered.` });
  else if (summary.plannedMargin >= 0) checks.push({ tone: 'neutral', title: 'No optional-payment room confirmed', text: 'The current plan does not leave money safely available for an optional payment after recorded commitments and the selected buffer.' });
  else checks.push({ tone: 'urgent', title: 'Plan is short', text: `The entered plan is ${formatCurrency(Math.abs(summary.plannedMargin))} over dependable income. Reduce flexible spending before adding an extra payment.` });
  const savings = findSavingsOpportunities(state);
  if (savings[0]) checks.push({ tone: 'neutral', title: 'Best penny-pinching review', text: savings[0].text });
  return checks.slice(0, 4);
}

export function findSavingsOpportunities(state) {
  const flexible = ['Subscriptions & software', 'Eating out', 'Shopping', 'Other / review'];
  const existingBudgets = state.budgets || [];
  const existingKeys = new Set(existingBudgets.map((budget) => normalise(budget.category)));
  const analysisBudgets = [
    ...existingBudgets,
    ...flexible.filter((category) => !existingKeys.has(normalise(category))).map((category) => ({
      id: `savings-analysis-${normalise(category).replace(/[^a-z0-9]+/g, '-')}`,
      category,
      planned: 0
    }))
  ];
  const months = [...new Set((state.transactions || [])
    .filter(isTransactionFinanciallyActive)
    .map((transaction) => reportingMonth(transaction.budgetMonth) || reportingMonth(transaction.date))
    .filter(Boolean))];
  const categoryTotals = new Map(flexible.map((category) => [normalise(category), 0]));
  for (const month of months) {
    const analysis = calculateBudgetAnalysis({ ...state, budgets: analysisBudgets }, month);
    for (const row of analysis.rows) {
      const key = normalise(row.category);
      if (categoryTotals.has(key)) categoryTotals.set(key, categoryTotals.get(key) + Number(row.actual || 0));
    }
  }
  const budgetByCategory = new Map(existingBudgets.map((budget) => [normalise(budget.category), Number(budget.planned || 0)]));
  const opportunities = flexible.map((category) => {
    const average = roundMoney((categoryTotals.get(normalise(category)) || 0) / Math.max(1, months.length));
    const key = normalise(category);
    const target = budgetByCategory.has(key) ? budgetByCategory.get(key) : (category === 'Eating out' ? 50 : 0);
    const possibleSaving = roundMoney(Math.max(0, average - target));
    return { category, average, target, possibleSaving, text: `${category} averaged ${formatCurrency(average)} a month. Reviewing it against a ${formatCurrency(target)} cap could free roughly ${formatCurrency(possibleSaving)} a month.` };
  }).filter((entry) => entry.possibleSaving > 0).sort((left, right) => right.possibleSaving - left.possibleSaving);

  return opportunities;
}

export function isTransactionFinanciallyActive(transaction = {}) {
  if (transaction.deletedAt || transaction.ignored === true || transaction.valid === false) return false;
  if (['pending', 'rejected'].includes(transaction.importReviewStatus)) return false;
  if (transaction.duplicateStatus === 'exact') return false;
  if (transaction.reviewStatus === 'rejected') return false;
  if (transaction.duplicateStatus === 'possible' && transaction.reviewStatus !== 'accepted') return false;
  return transaction.financiallyActive !== false;
}

export function resolvePossibleDuplicate(state, transactionId, decision) {
  if (!['accepted', 'rejected'].includes(decision)) throw new TypeError('Choose whether to accept or reject this possible duplicate.');
  const next = structuredClone(state);
  const transaction = (next.transactions || []).find((item) => item.id === transactionId);
  if (!transaction || transaction.duplicateStatus !== 'possible') throw new Error('This possible duplicate is no longer available for review.');
  transaction.reviewStatus = decision;
  transaction.financiallyActive = decision === 'accepted' && !['pending', 'rejected'].includes(transaction.importReviewStatus);
  transaction.reviewedAt = new Date().toISOString();
  transaction.duplicateDecision = decision === 'accepted' ? 'both_genuine' : 'duplicate';
  return synchroniseReviewItems(next);
}

export function debtPlan(state, strategy = 'hybrid', extraPayment = state.settings?.extraDebtPayment ?? 0, startMonth = currentMonth()) {
  const safety = debtSafetyAssessment(state, extraPayment);
  const safetyById = new Map(safety.accounts.map((item) => [item.id, item]));
  const items = [...(state.debts || []).map((item) => ({ ...item, kind: 'debt' })), ...(state.overdrafts || []).map((item) => ({ ...item, kind: 'overdraft' }))]
    .filter((item) => item.includeInPlan !== false && Number(item.currentBalance || 0) > 0)
    .map((item) => ({ ...item, balance: Number(item.currentBalance), apr: item.apr === null || item.apr === undefined ? null : Number(item.apr), minimum: Number(safetyById.get(item.id)?.requiredPayment || 0), safety: safetyById.get(item.id) }));
  const unknownApr = items.filter((item) => item.apr === null).map((item) => item.name);
  const minimumTotal = roundMoney(items.reduce((total, item) => total + item.minimum, 0));
  const monthlyPot = roundMoney(minimumTotal + safety.safeExtraPayment);
  const schedule = [];
  const balances = new Map(items.map((item) => [item.id, item.balance]));
  const initialPriority = priorityOrder(items, balances, strategy).map((item) => item.name);
  const date = new Date(`${startMonth}-01T00:00:00Z`);
  let totalInterest = 0;

  for (let monthIndex = 0; monthIndex < 120 && [...balances.values()].some((balance) => balance > 0.005); monthIndex += 1) {
    let interestThisMonth = 0;
    for (const item of items) {
      const balance = balances.get(item.id) || 0;
      if (balance <= 0) continue;
      const interest = item.interestFrozen ? 0 : roundMoney(balance * ((item.apr || 0) / 12));
      balances.set(item.id, roundMoney(balance + interest));
      interestThisMonth += interest;
    }
    let remainingPot = monthlyPot;
    for (const item of items) {
      const balance = balances.get(item.id) || 0;
      const payment = Math.min(balance, item.minimum, remainingPot);
      balances.set(item.id, roundMoney(balance - payment));
      remainingPot = roundMoney(remainingPot - payment);
    }
    for (const item of priorityOrder(items, balances, strategy)) {
      if (remainingPot <= 0) break;
      const balance = balances.get(item.id) || 0;
      const payment = Math.min(balance, remainingPot);
      balances.set(item.id, roundMoney(balance - payment));
      remainingPot = roundMoney(remainingPot - payment);
    }
    totalInterest = roundMoney(totalInterest + interestThisMonth);
    schedule.push({
      month: date.toISOString().slice(0, 7),
      endingBalance: roundMoney([...balances.values()].reduce((total, balance) => total + balance, 0)),
      interest: roundMoney(interestThisMonth), payment: roundMoney(monthlyPot - remainingPot),
      cleared: items.filter((item) => (balances.get(item.id) || 0) <= 0.005).length
    });
    date.setUTCMonth(date.getUTCMonth() + 1);
  }

  return {
    strategy, schedule, unknownApr, minimumTotal, monthlyPot, totalInterest,
    requestedExtraPayment: safety.requestedExtraPayment,
    safeExtraPayment: safety.safeExtraPayment,
    debtFreeMonth: safety.blockingReasons.length === 0 && schedule.at(-1)?.endingBalance === 0 ? schedule.at(-1).month : '',
    safeToOverpay: safety.safeToOverpay,
    overpaymentStatus: safety.overpaymentStatus,
    blockers: safety.blockers,
    explanations: safety.explanations,
    excludedAccounts: safety.accounts.filter((item) => !item.eligibleForExtra && item.balance > 0).map((item) => ({ name: item.name, reason: item.exclusionReason })),
    priority: initialPriority
  };
}

export function debtSafetyAssessment(state, extraPayment = state.settings?.extraDebtPayment ?? 0) {
  const requestedExtraPayment = roundMoney(Math.max(0, Number(extraPayment || 0)));
  const accounts = [...(state.debts || []).map((item) => ({ ...item, kind: 'debt' })), ...(state.overdrafts || []).map((item) => ({ ...item, kind: 'overdraft' }))]
    .filter((item) => Number(item.currentBalance || 0) > 0)
    .map(assessDebtAccount);
  const blockingReasons = accounts.flatMap((item) => item.blockingReasons);
  const blockers = [...new Set(accounts.filter((item) => item.blockingReasons.length).map((item) => item.name))];
  const eligibleAccounts = accounts.filter((item) => item.eligibleForExtra);
  const requiredPaymentTotal = roundMoney(accounts.reduce((total, item) => total + Number(item.requiredPayment || 0), 0));
  const budgetedDebtPayments = roundMoney((state.budgets || []).filter((item) => normalise(item.section) === 'debt minimums').reduce((total, item) => total + Number(item.planned || 0), 0));
  const unbudgetedRequiredPayments = roundMoney(Math.max(0, requiredPaymentTotal - budgetedDebtPayments));
  const scheduledCommitments = roundMoney((state.scheduledPayments || [])
    .filter((item) => item.includedInBudget !== true && !item.paidAt && !item.completedAt && !['paid', 'cancelled', 'canceled'].includes(normalise(item.status)))
    .reduce((total, item) => total + Math.max(0, Number(item.amount ?? item.outgoing ?? item.payment ?? 0)), 0));
  const plannedSpending = roundMoney((state.budgets || []).reduce((total, item) => total + Number(item.planned || 0), 0));
  const dependableIncome = Math.max(0, Number(state.profile?.dependableIncome || 0));
  const bufferReserve = roundMoney(Math.max(0, Number(state.settings?.emergencyBufferTarget || 0) - Number(state.settings?.emergencyBufferBalance || 0)));
  const plannedCapacity = roundMoney(Math.max(0, dependableIncome - plannedSpending - unbudgetedRequiredPayments - scheduledCommitments - bufferReserve));
  const cashAccounts = (state.accounts || []).filter((item) => item.active !== false && ['current', 'cash'].includes(normalise(item.type)) && item.currentBalance !== null && item.currentBalance !== undefined && item.currentBalance !== '' && Number.isFinite(Number(item.currentBalance)));
  const currentCashCapacity = cashAccounts.length
    ? roundMoney(Math.max(0, cashAccounts.reduce((total, item) => total + Number(item.currentBalance), 0) - scheduledCommitments - bufferReserve))
    : null;
  const capacity = roundMoney(Math.min(plannedCapacity, currentCashCapacity === null ? Number.POSITIVE_INFINITY : currentCashCapacity));
  const canAllocateExtra = blockingReasons.length === 0 && eligibleAccounts.length > 0;
  const safeExtraPayment = canAllocateExtra ? roundMoney(Math.min(requestedExtraPayment, capacity)) : 0;
  const explanations = [...blockingReasons];
  if (!eligibleAccounts.length && accounts.length && !blockingReasons.length) explanations.push('No recorded account is eligible for an optional additional payment. Agreed arrangements remain at their recorded payment amount.');
  if (requestedExtraPayment > safeExtraPayment && canAllocateExtra) explanations.push(safeExtraPayment > 0
    ? `Essential commitments, required payments and the selected buffer leave ${formatCurrency(safeExtraPayment)} of the requested extra payment safely available.`
    : 'Essential commitments, required payments, scheduled bills or the selected buffer leave no money safely available for an extra payment.');
  const safeToOverpay = blockingReasons.length === 0 && (requestedExtraPayment === 0 ? eligibleAccounts.length > 0 : safeExtraPayment === requestedExtraPayment);
  const overpaymentStatus = requestedExtraPayment === 0 ? (blockingReasons.length ? 'blocked' : 'not_requested')
    : safeExtraPayment === requestedExtraPayment && safeToOverpay ? 'safe'
      : safeExtraPayment > 0 ? 'reduced' : 'blocked';
  return {
    accounts, requestedExtraPayment, safeExtraPayment, safeToOverpay, overpaymentStatus,
    blockers, blockingReasons, explanations: [...new Set(explanations)], requiredPaymentTotal,
    unbudgetedRequiredPayments, scheduledCommitments, plannedCapacity, currentCashCapacity
  };
}

export function findDuplicateCandidates(existing, incoming) {
  const exact = [];
  const possible = [];
  const usedExisting = new Set();
  const providerIndex = new Map();
  const identityIndex = new Map();
  const possibleIndex = new Map();
  for (const item of existing || []) {
    const providerId = String(item.providerTransactionId || '').trim();
    if (providerId) addToIndex(providerIndex, `${item.accountId}|${providerId}`, item);
    addToIndex(identityIndex, exactTransactionKey(item), item);
    addToIndex(possibleIndex, possibleTransactionKey(item), item);
  }
  for (const item of incoming || []) {
    const providerId = String(item.providerTransactionId || '').trim();
    const providerMatch = providerId
      ? firstUnused(providerIndex.get(`${item.accountId}|${providerId}`), usedExisting)
      : null;
    const identityMatch = providerMatch || firstUnused(identityIndex.get(exactTransactionKey(item)), usedExisting, (other) => compatibleRunningBalance(other, item));
    if (identityMatch) {
      usedExisting.add(identityMatch.id);
      exact.push({ incoming: item, existing: identityMatch, evidence: providerMatch ? 'provider-id' : 'transaction-identity' });
      continue;
    }
    const candidate = possibleIndex.get(possibleTransactionKey(item))?.[0];
    if (candidate) possible.push({ incoming: item, existing: candidate });
  }
  return { exact, possible };
}

export function matchStatementAccount(accounts = [], preview = {}) {
  const identity = preview.accountIdentity || preview.summary || {};
  const selected = accounts.find((account) => account.id === preview.accountHint);
  if (selected) {
    const conflicts = accountIdentityConflicts(selected, identity);
    return conflicts.length
      ? { status: 'conflict', account: selected, candidates: [selected], conflicts, confidence: 'review' }
      : { status: 'matched', account: selected, candidates: [selected], conflicts: [], confidence: 'user-selected' };
  }

  const reference = referenceKey(identity.accountReference);
  const institution = accountMatchKey(identity.institution);
  const type = accountTypeKey(identity.accountType);
  const candidates = accounts.filter((account) => {
    const accountReference = referenceKey(account.accountReference);
    if (!reference || !accountReference || reference !== accountReference) return false;
    if (institution && account.institution && institution !== accountMatchKey(account.institution)) return false;
    if (type && account.type && type !== accountTypeKey(account.type)) return false;
    return true;
  });
  if (candidates.length === 1) return { status: 'matched', account: candidates[0], candidates, conflicts: [], confidence: 'strong-identity' };
  if (candidates.length > 1) return { status: 'ambiguous', account: null, candidates, conflicts: [], confidence: 'review' };
  return { status: 'unmatched', account: null, candidates: [], conflicts: [], confidence: 'review' };
}

export function planCreditReportAccounts(debts = [], overdrafts = [], accounts = []) {
  const usedMatches = new Set();
  return accounts.map((account) => {
    const balance = Number(account.currentBalance);
    const kind = reportedAccountKind(account);
    const collection = kind === 'overdraft' ? overdrafts : debts;
    const existing = collection.find((item) => !usedMatches.has(item.id) && reportedAccountMatches(item, account));
    if (existing) {
      usedMatches.add(existing.id);
      return { account, action: 'existing', kind, existingId: existing.id };
    }
    if (!Number.isFinite(balance) || balance <= 0) return { account, action: 'no-balance', kind };
    return { account, action: kind === 'overdraft' ? 'add-overdraft' : 'add-debt', kind };
  });
}

export function creditReportDebtStatus(value) {
  const signals = debtStatusSignals(value);
  if (signals.has('defaulted')) return 'defaulted';
  if (signals.has('arrears')) return 'arrears';
  if (signals.has('over_limit')) return 'over_limit';
  if (signals.has('current')) return 'current';
  return 'unknown';
}

export function creditReportStatusConflict(value) {
  return debtStatusSignals(value).size > 1;
}

export function syncStatementAccount(state, account, preview, documentId = '') {
  const closingBalance = Number(preview?.summary?.closingBalance);
  if (!account || !preview?.reconciled || !Number.isFinite(closingBalance)) return '';
  const statementDate = preview.summary.statementEndDate
    || (preview.records || []).map((item) => item.date).filter(Boolean).sort().at(-1)
    || '';
  if (!statementDate) return '';
  if (account.statementDate && account.statementDate > statementDate) return 'historical-only';
  account.currentBalance = closingBalance;
  account.statementDate = statementDate;
  if (!Number.isFinite(account.openingBalance) && Number.isFinite(preview.summary.openingBalance)) account.openingBalance = preview.summary.openingBalance;
  if (!account.institution && (preview.institution || preview.accountIdentity?.institution)) account.institution = preview.institution || preview.accountIdentity.institution;
  if (!account.accountReference && preview.accountIdentity?.accountReference) account.accountReference = preview.accountIdentity.accountReference;

  const used = Math.max(0, -closingBalance);
  let overdraft = (state.overdrafts || []).find((item) => item.accountId === account.id);
  if (!overdraft && used > 0) overdraft = findUnlinkedOverdraftForAccount(state.overdrafts || [], account);
  let action = 'account-updated';
  if (!overdraft && used > 0) {
    overdraft = {
      id: createId('overdraft'),
      accountId: account.id,
      name: `${account.name || account.institution || 'Account'} overdraft`,
      type: 'overdraft',
      currentBalance: used,
      limit: preview.summary.overdraftLimit ?? null,
      apr: null,
      contractualPayment: null,
      status: Number.isFinite(preview.summary.overdraftLimit) && used > preview.summary.overdraftLimit ? 'over_limit' : 'current',
      includeInPlan: true,
      arrangementConfirmed: false,
      arrangementStatus: 'unknown',
      arrangementPayment: null,
      statusConflict: false,
      interestFrozen: false,
      planPriority: 999,
      description: 'Automatically kept in sync with the linked bank statement balance.',
      notes: 'Confirm the arranged limit and APR if they are not shown on the statement.'
    };
    state.overdrafts.push(overdraft);
    action = 'overdraft-created';
  }
  if (!overdraft) return action;
  overdraft.accountId = account.id;
  overdraft.currentBalance = used;
  if (Number.isFinite(preview.summary.overdraftLimit)) overdraft.limit = preview.summary.overdraftLimit;
  if (Number.isFinite(preview.summary.overdraftApr)) overdraft.apr = preview.summary.overdraftApr;
  if (overdraft.status === 'over_limit' && (!Number.isFinite(overdraft.limit) || used <= overdraft.limit)) overdraft.status = 'current';
  if (Number.isFinite(overdraft.limit) && used > overdraft.limit) overdraft.status = 'over_limit';
  overdraft.statementDate = account.statementDate;
  overdraft.sourceStatementDocumentId = documentId;
  overdraft.updatedAt = new Date().toISOString();
  return action === 'overdraft-created' ? action : 'overdraft-updated';
}

export function matchInternalTransfers(transactions, accounts = []) {
  const credits = transactions.filter((item) => item.incoming > 0 && item.transferStatus !== 'confirmed');
  const matches = [];
  const usedCredits = new Set();
  for (const debit of transactions.filter((item) => item.outgoing > 0 && item.transferStatus !== 'confirmed')) {
    const candidates = credits.filter((item) => !usedCredits.has(item.id) && item.accountId !== debit.accountId
      && Math.abs(item.incoming - debit.outgoing) < 0.01 && Math.abs(dateDistance(item.date, debit.date)) <= 2);
    if (candidates.length !== 1) continue;
    const [credit] = candidates;
    if (credit) {
      const descriptions = `${normalise(debit.description)} ${normalise(credit.description)}`;
      const transferSignal = /own account|internal transfer|account transfer|transfer to|transfer from/.test(descriptions);
      const referenceSignal = sharedTransferReference(debit, credit);
      const accountSignal = descriptionsReferenceAccounts(descriptions, debit, credit, accounts);
      const confidence = transferSignal && (referenceSignal || accountSignal) ? 'confirmed' : transferSignal ? 'likely' : 'possible';
      usedCredits.add(credit.id);
      matches.push({ debitId: debit.id, creditId: credit.id, amount: debit.outgoing, confidence, evidence: { transferSignal, referenceSignal, accountSignal } });
    }
  }
  return matches;
}

export function normaliseMerchantDescription(value) {
  return normalise(value)
    .replace(/\b(?:card|visa|mastercard|debit|credit|contactless|faster payment|faster payments|direct debit|standing order|bacs|fps|fpi|fpo)\b/g, ' ')
    .replace(/\b\d{4,}\b/g, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function detectRecurringTransactions(history = [], candidates = []) {
  const all = [...history, ...candidates];
  const unique = [...new Map(all.map((item) => [item.id, item])).values()];
  const observations = [];
  for (const candidate of candidates) {
    const merchantKey = normaliseMerchantDescription(candidate.description);
    const direction = candidate.incoming > 0 ? 'incoming' : candidate.outgoing > 0 ? 'outgoing' : '';
    if (!merchantKey || !direction || !candidate.date) continue;
    const related = unique.filter((item) => item.accountId === candidate.accountId && item.date
      && normaliseMerchantDescription(item.description) === merchantKey
      && (item.incoming > 0 ? 'incoming' : item.outgoing > 0 ? 'outgoing' : '') === direction)
      .sort((left, right) => left.date.localeCompare(right.date));
    const dates = [...new Set(related.map((item) => item.date))];
    const cadence = recurringCadence(dates);
    if (!cadence) continue;
    const confidence = dates.length >= 3 ? 'confirmed' : 'likely';
    observations.push({ transactionId: candidate.id, merchantKey, direction, cadence, confidence, occurrences: dates.length });
  }
  return observations;
}

export function exportTransactionsCsv(transactions) {
  const header = ['Date', 'Account', 'Description', 'User description', 'Category', 'Incoming', 'Outgoing', 'Running balance', 'Transfer', 'Notes'];
  const rows = transactions.map((item) => [item.date, item.accountId, item.description, item.userDescription, item.category, item.incoming || '', item.outgoing || '', item.runningBalance ?? '', item.transferStatus, item.notes]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export function buildFallbackAnswer(question, state) {
  const query = normalise(question);
  const summary = calculatePeriodSummary(state);
  const next = buildNextAction(state);
  if (/next|today|do first|priority/.test(query)) return `Immediate action - ${next.timeframe || '10 min'}\n\n${next.title}. ${next.detail}\n\nStop after that.`;
  if (/save|saving|penn|cut|spend/.test(query)) {
    const opportunity = findSavingsOpportunities(state)[0];
    return opportunity ? `This week - 10 min\n\n${opportunity.text}\n\nChange only one recurring cost, then stop.` : 'No reliable saving opportunity is visible yet. Import a recent statement, then review one flexible category.';
  }
  if (/debt|overdraft|pay off|avalanche|snowball/.test(query)) {
    const plan = debtPlan(state, 'hybrid');
    const safetyMessage = plan.safeToOverpay
      ? ` The recorded extra-payment target is within the current safety checks.`
      : ` No unsafe extra payment is included. ${plan.explanations[0] || 'OneStep does not have enough confirmed information to recommend one safely.'}`;
    return `Your recorded debt and overdrafts total ${formatCurrency(summary.totalOwed)}.${safetyMessage} The payoff forecast is provisional while ${plan.unknownApr.length} rate${plan.unknownApr.length === 1 ? ' is' : 's are'} unknown.`;
  }
  const periodLabel = summary.month === ALL_TIME_PERIOD ? `Across all ${summary.monthCount} months held` : 'Your selected month';
  return `${periodLabel} shows ${formatCurrency(summary.income)} external money in and ${formatCurrency(summary.spending)} out. The safest next move is: ${next.title}.`;
}

function priorityOrder(items, balances, strategy) {
  return items.filter((item) => (balances.get(item.id) || 0) > 0 && item.safety?.eligibleForExtra).sort((left, right) => {
    const riskDifference = debtRiskRank(left.safety) - debtRiskRank(right.safety);
    if (riskDifference) return riskDifference;
    if (strategy === 'snowball') return (balances.get(left.id) || 0) - (balances.get(right.id) || 0);
    if (strategy === 'hybrid') return Number(left.planPriority || 999) - Number(right.planPriority || 999);
    const leftApr = left.apr === null ? -1 : left.apr;
    const rightApr = right.apr === null ? -1 : right.apr;
    return rightApr - leftApr || (balances.get(left.id) || 0) - (balances.get(right.id) || 0);
  });
}

function assessDebtAccount(item) {
  const balance = Math.max(0, Number(item.currentBalance || 0));
  const storedStatus = normaliseDebtStatus(item.status);
  const reportedStatusReviewed = Boolean(item.statusReviewedAt) && String(item.reviewedReportedStatus || '') === String(item.reportedStatus || '');
  const reportedStatus = reportedStatusReviewed ? 'unknown' : creditReportDebtStatus(item.reportedStatus);
  const statusSignals = new Set([storedStatus]);
  if (reportedStatus !== 'unknown') statusSignals.add(reportedStatus);
  if (item.defaultDate) statusSignals.add('defaulted');
  const limit = debtLimit(item);
  const overLimit = Number.isFinite(limit) && balance > limit;
  if (overLimit) statusSignals.add('over_limit');
  statusSignals.delete('unknown');
  const effectiveStatus = conservativeDebtStatus(statusSignals);
  const arrangementStatus = normaliseArrangementStatus(item);
  const arrangementPayment = knownNonNegative(item.arrangementPayment) ? Number(item.arrangementPayment) : null;
  const contractualPayment = knownNonNegative(item.contractualPayment ?? item.minimumPayment) ? Number(item.contractualPayment ?? item.minimumPayment) : null;
  const requiredPayment = arrangementStatus === 'confirmed' ? arrangementPayment : contractualPayment;
  const reportedConflict = storedStatus !== 'unknown' && reportedStatus !== 'unknown' && storedStatus !== reportedStatus;
  const defaultDateConflict = Boolean(item.defaultDate) && !['defaulted', 'unknown'].includes(storedStatus);
  const conflictingStatus = Boolean(item.statusConflict) || (!reportedStatusReviewed && creditReportStatusConflict(item.reportedStatus)) || reportedConflict || defaultDateConflict;
  const blocking = [];
  const reasonCodes = [];
  const addBlock = (code, message) => { reasonCodes.push(code); blocking.push(message); };

  if (conflictingStatus) addBlock('conflicting_status', `${item.name || 'This account'} has conflicting status information. OneStep is using the more cautious state and is not recommending an extra payment until it is confirmed.`);
  if (effectiveStatus === 'unknown') addBlock('unknown_status', `OneStep does not know the current status of ${item.name || 'this account'}, so it cannot recommend an extra payment safely.`);
  if (effectiveStatus === 'defaulted' && arrangementStatus !== 'confirmed') addBlock('default_arrangement_unresolved', `${item.name || 'This defaulted account'} is marked as defaulted, but its payment arrangement is not confirmed. No discretionary payment is being recommended.`);
  else if (effectiveStatus === 'arrears' && arrangementStatus !== 'confirmed') addBlock('arrears_arrangement_unresolved', `${item.name || 'This account'} is in arrears and its required payment position is not confirmed. Optional overpayments are paused.`);
  else if (arrangementStatus === 'unknown') addBlock('unknown_arrangement', `OneStep does not know whether ${item.name || 'this account'} has a payment arrangement, so it is not treating the account as safe to overpay.`);
  if (arrangementStatus === 'confirmed' && arrangementPayment === null) addBlock('unknown_arrangement_payment', `The arrangement for ${item.name || 'this account'} is confirmed, but the agreed payment amount is missing. Confirm it before relying on the forecast.`);
  if (arrangementStatus === 'none' && ['current', 'over_limit'].includes(effectiveStatus) && contractualPayment === null) addBlock('unknown_required_payment', `The required payment for ${item.name || 'this account'} is unknown. OneStep cannot safely calculate money available for an optional payment.`);
  if ((item.kind === 'overdraft' || revolvingCredit(item)) && !Number.isFinite(limit)) addBlock('unknown_credit_limit', `The limit for ${item.name || 'this account'} is unknown, so OneStep cannot rule out an over-limit risk.`);

  const eligibleForExtra = blocking.length === 0 && arrangementStatus === 'none' && ['current', 'over_limit'].includes(effectiveStatus);
  let exclusionReason = '';
  if (arrangementStatus === 'confirmed') exclusionReason = 'The agreed payment is treated as required; no additional discretionary payment is assigned.';
  else if (effectiveStatus === 'defaulted') exclusionReason = 'Defaulted accounts are excluded from automatic discretionary overpayments.';
  else if (effectiveStatus === 'arrears') exclusionReason = 'The arrears position must be resolved before optional overpayments elsewhere.';
  else if (blocking[0]) exclusionReason = blocking[0];
  return {
    id: item.id, name: item.name || 'Unnamed account', kind: item.kind, balance, effectiveStatus, overLimit,
    arrangementStatus, arrangementPayment, contractualPayment, requiredPayment, eligibleForExtra,
    blockingReasons: [...new Set(blocking)], reasonCodes: [...new Set(reasonCodes)], exclusionReason
  };
}

function normaliseDebtStatus(value) {
  const status = normalise(value);
  return ['current', 'arrears', 'defaulted', 'over_limit', 'unknown'].includes(status) ? status : 'unknown';
}

function normaliseArrangementStatus(item) {
  const status = normalise(item.arrangementStatus);
  if (['unknown', 'none', 'confirmed'].includes(status)) return status;
  return item.arrangementConfirmed === true ? 'confirmed' : 'unknown';
}

function debtStatusSignals(value) {
  const text = normalise(value);
  const riskText = text.replace(/\bno arrears\b|\bnot in arrears\b|\bnot defaulted\b|\bnot over[ -]?limit\b/g, ' ');
  const signals = new Set();
  if (/default/.test(riskText)) signals.add('defaulted');
  if (/arrears|late|missed|delinquent|past due|overdue/.test(riskText)) signals.add('arrears');
  if (/over[ -]?limit|above (?:the )?limit/.test(riskText)) signals.add('over_limit');
  if (/\bcurrent\b|up to date|satisfactory|paid as agreed|no arrears/.test(text)) signals.add('current');
  return signals;
}

function conservativeDebtStatus(signals) {
  if (signals.has('defaulted')) return 'defaulted';
  if (signals.has('arrears')) return 'arrears';
  if (signals.has('over_limit')) return 'over_limit';
  if (signals.has('current')) return 'current';
  return 'unknown';
}

function debtLimit(item) {
  const value = item.kind === 'overdraft' ? item.limit : item.creditLimit;
  return knownNonNegative(value) ? Number(value) : Number.NaN;
}

function revolvingCredit(item) {
  return /credit|store card|charge card|catalogue|revolving/.test(normalise(item.type));
}

function knownNonNegative(value) {
  return value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function debtRiskRank(safety) {
  return safety?.overLimit ? 0 : 1;
}

function isBlankState(state) {
  return !(state.accounts || []).length
    && !(state.transactions || []).some(isTransactionFinanciallyActive)
    && ['payslips', 'creditReports', 'debts', 'overdrafts', 'budgets'].every((key) => !(state[key] || []).length);
}

function reportedAccountMatches(existing, reported) {
  const existingLender = creditorKey(existing.name);
  const reportedLender = creditorKey(reported.lender);
  if (!existingLender || existingLender !== reportedLender) return false;
  const existingReference = referenceKey(existing.accountReference);
  const reportedReference = referenceKey(reported.accountReference);
  if (existingReference && reportedReference && existingReference !== reportedReference) return false;
  const existingType = reportedTypeKey(existing.type);
  const reportedType = reportedTypeKey(reported.accountType);
  return !existingType || !reportedType || existingType === reportedType;
}

function creditorKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:the|plc|limited|ltd|llp|incorporated|inc|company|co)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function referenceKey(value) {
  return String(value || '').replace(/[^a-z0-9]/gi, '').slice(-4).toLowerCase();
}

function reportedTypeKey(value) {
  const text = String(value || '').toLowerCase();
  if (/overdraft|current account/.test(text)) return 'overdraft';
  if (/credit card|store card|charge card/.test(text)) return 'card';
  if (/hire purchase|vehicle|motor finance/.test(text)) return 'vehicle-finance';
  if (/mortgage/.test(text)) return 'mortgage';
  if (/loan/.test(text)) return 'loan';
  if (/mobile|communications|telecom/.test(text)) return 'communications';
  if (/catalogue|mail order/.test(text)) return 'catalogue';
  return text.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function reportedAccountKind(account) {
  return reportedTypeKey(account.accountType) === 'overdraft' ? 'overdraft' : 'debt';
}

function findUnlinkedOverdraftForAccount(overdrafts, account) {
  const accountNames = [account.name, account.institution].map(accountMatchKey).filter(Boolean);
  const candidates = overdrafts.filter((item) => !item.accountId && accountNames.some((name) => {
    const overdraftName = accountMatchKey(item.name);
    return overdraftName && (overdraftName === name || overdraftName.includes(name) || name.includes(overdraftName));
  }));
  return candidates.length === 1 ? candidates[0] : null;
}

function accountMatchKey(value) {
  return String(value || '').toLowerCase().replace(/\b(?:bank|current|account|overdraft|plc|limited|ltd|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function currentMonth() {
  return localFinancialMonthKey();
}

function reportingMonth(value) {
  const month = String(value || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : '';
}

function exactTransactionKey(item) {
  return [item.accountId, item.date, roundMoney(item.incoming), roundMoney(item.outgoing), normalise(item.description), normalise(item.reference)].join('|');
}

function possibleTransactionKey(item) {
  return [item.accountId, item.date, roundMoney(item.incoming), roundMoney(item.outgoing)].join('|');
}

function addToIndex(index, key, item) {
  const values = index.get(key) || [];
  values.push(item);
  index.set(key, values);
}

function firstUnused(items = [], usedIds, predicate = () => true) {
  return items.find((item) => !usedIds.has(item.id) && predicate(item)) || null;
}

function compatibleRunningBalance(left, right) {
  const leftBalance = Number(left.runningBalance);
  const rightBalance = Number(right.runningBalance);
  if (!Number.isFinite(leftBalance) || !Number.isFinite(rightBalance)) return true;
  return roundMoney(leftBalance) === roundMoney(rightBalance);
}

function accountIdentityConflicts(account, identity) {
  const conflicts = [];
  const identityReference = referenceKey(identity.accountReference);
  const accountReference = referenceKey(account.accountReference);
  if (identityReference && accountReference && identityReference !== accountReference) conflicts.push('account_reference');
  const identityInstitution = accountMatchKey(identity.institution);
  const accountInstitution = accountMatchKey(account.institution);
  if (identityInstitution && accountInstitution && identityInstitution !== accountInstitution) conflicts.push('institution');
  const identityType = accountTypeKey(identity.accountType);
  const accountType = accountTypeKey(account.type);
  if (identityType && accountType && identityType !== accountType) conflicts.push('account_type');
  return conflicts;
}

function accountTypeKey(value) {
  const key = normalise(value).replace(/\baccount\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (/\b(?:checking|current)\b/.test(key)) return 'current';
  if (/\b(?:saving|savings|deposit)\b/.test(key)) return 'savings';
  return key;
}

function sharedTransferReference(left, right) {
  const leftTokens = transferReferenceTokens(`${left.reference || ''} ${left.description || ''}`);
  const rightTokens = transferReferenceTokens(`${right.reference || ''} ${right.description || ''}`);
  return [...leftTokens].some((token) => rightTokens.has(token));
}

function transferReferenceTokens(value) {
  const ignored = new Set(['transfer', 'account', 'internal', 'payment', 'faster', 'from', 'into', 'own']);
  return new Set(normalise(value).split(/[^a-z0-9]+/).filter((token) => token.length >= 4 && !ignored.has(token) && !/^\d+$/.test(token)));
}

function descriptionsReferenceAccounts(descriptions, debit, credit, accounts) {
  const debitAccount = accounts.find((account) => account.id === debit.accountId);
  const creditAccount = accounts.find((account) => account.id === credit.accountId);
  const debitKeys = [debitAccount?.name, debitAccount?.institution, referenceKey(debitAccount?.accountReference)].map(accountMatchKey).filter(Boolean);
  const creditKeys = [creditAccount?.name, creditAccount?.institution, referenceKey(creditAccount?.accountReference)].map(accountMatchKey).filter(Boolean);
  return [...debitKeys, ...creditKeys].some((key) => key.length >= 3 && descriptions.includes(key));
}

function recurringCadence(dates) {
  if (dates.length < 2) return '';
  const intervals = dates.slice(1).map((date, index) => Math.abs(dateDistance(date, dates[index])));
  const cadenceRules = [
    ['weekly', 6, 8],
    ['fortnightly', 13, 15],
    ['four-weekly', 27, 29],
    ['monthly', 26, 35],
    ['quarterly', 80, 100],
    ['annual', 350, 380]
  ];
  return cadenceRules.find(([, minimum, maximum]) => intervals.every((days) => days >= minimum && days <= maximum))?.[0] || '';
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function isExternalCashflowTransaction(transaction) {
  const treatment = normaliseBudgetTreatment(transaction.budgetTreatment);
  return transaction.transferStatus !== 'confirmed'
    && !['transfer', 'savings_transfer', 'ignored'].includes(treatment);
}

function normaliseBudgetTreatment(value) {
  const treatment = String(value || 'auto').trim().toLowerCase();
  return ['auto', 'spending', 'refund', 'reversal', 'transfer', 'savings_transfer', 'debt_payment', 'ignored'].includes(treatment) ? treatment : 'auto';
}

function budgetContribution(transaction, pennies) {
  return {
    id: transaction.id,
    date: transaction.date,
    description: transaction.userDescription || transaction.description || 'Payment',
    amount: penniesToMoney(pennies)
  };
}

function moneyToPennies(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100);
}

function penniesToMoney(value) {
  return Number(value || 0) / 100;
}

function normalise(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isIncomeCategory(value) {
  return normalise(value) === normalise(INCOME_PAYMENT_CATEGORY);
}

function sum(rows = [], field) {
  return roundMoney(rows.reduce((total, row) => total + Number(row[field] || 0), 0));
}

function roundMoney(value) {
  return Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;
}

function dateDistance(left, right) {
  return (new Date(`${left}T12:00:00Z`) - new Date(`${right}T12:00:00Z`)) / 86400000;
}

function weekKey(date) {
  const value = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  value.setUTCDate(value.getUTCDate() - ((value.getUTCDay() + 6) % 7));
  return value.toISOString().slice(0, 10);
}

function localDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
