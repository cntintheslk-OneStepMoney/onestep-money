import {
  ALL_TIME_PERIOD, availableReportingMonths, calculateBudgetAnalysis, calculatePeriodSummary,
  formatCurrency, isExternalCashflowTransaction, periodTransactions
} from './finance-core.js';
import { confirmedRecurringTransactionIds, deriveRecurringPatterns } from './recurring-finance.js';
import { renderRecurringActivityPanel } from './recurring-finance-ui.js';

export function buildFinancialReport(state, period = state.settings?.selectedMonth, now = new Date()) {
  const summary = calculatePeriodSummary(state, period);
  const budget = calculateBudgetAnalysis(state, period);
  const months = availableReportingMonths(state).sort();
  const timeline = months.map((month) => {
    const monthSummary = calculatePeriodSummary(state, month);
    return {
      month,
      income: monthSummary.income,
      spending: monthSummary.budgetActualSpending,
      cashOut: monthSummary.spending,
      net: monthSummary.netCashFlow,
      incomplete: isIncompleteMonth(month, now)
    };
  });
  const selectedTimeline = period === ALL_TIME_PERIOD ? timeline : timeline.filter((row) => row.month === period);
  const categories = [
    ...budget.rows.map((row) => ({ id: row.id, label: row.category, amount: row.actual })),
    ...(budget.uncategorisedActual > 0 ? [{ id: 'uncategorised', label: 'Uncategorised', amount: budget.uncategorisedActual, needsReview: true }] : [])
  ].filter((row) => row.amount !== 0).sort((left, right) => right.amount - left.amount || left.label.localeCompare(right.label));
  const recurring = recurringSplit(state, period, budget);
  const recurringPatterns = deriveRecurringPatterns(state, { includeRejected: true });
  const comparison = period === ALL_TIME_PERIOD ? allTimeComparison(timeline) : monthlyComparison(timeline, period, now);
  renderRecurringActivityPanel(state);
  return {
    period,
    isAllTime: period === ALL_TIME_PERIOD,
    summary,
    budget,
    timeline: selectedTimeline,
    fullTimeline: timeline,
    spendingTimeline: spendingTimeline(state, period, budget, timeline),
    incomeTimeline: incomeTimeline(state, period, timeline),
    categories,
    largestCategory: categories[0] || null,
    recurring,
    recurringPatterns,
    comparison,
    progress: buildProgress(state),
    wins: buildFinancialWins(state, comparison),
    accountBalance: sum((state.accounts || []).filter((account) => account.active !== false), 'currentBalance'),
    upcomingCommitments: (state.scheduledPayments || []).filter((item) => !['paid', 'cancelled'].includes(item.status)).reduce((total, item) => total + Number(item.amount || 0), 0)
  };
}

function spendingTimeline(state, period, budget, monthlyTimeline) {
  if (period === ALL_TIME_PERIOD) return monthlyTimeline.map((row) => ({ label: row.month, amount: row.spending, incomplete: row.incomplete }));
  const transactions = new Map((state.transactions || []).map((transaction) => [String(transaction.id), transaction]));
  const amounts = new Map();
  for (const row of budget.rows) {
    for (const contribution of row.contributions) {
      const date = String(transactions.get(String(contribution.id))?.date || '').slice(0, 10);
      if (date) amounts.set(date, roundMoney((amounts.get(date) || 0) + Number(contribution.amount || 0)));
    }
  }
  for (const id of budget.uncategorisedTransactionIds) {
    const transaction = transactions.get(String(id));
    const date = String(transaction?.date || '').slice(0, 10);
    if (date) amounts.set(date, roundMoney((amounts.get(date) || 0) + Number(transaction.outgoing || 0)));
  }
  return [...amounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([label, amount]) => ({ label, amount, incomplete: false }));
}

function incomeTimeline(state, period, monthlyTimeline) {
  if (period === ALL_TIME_PERIOD) return monthlyTimeline.map((row) => ({ label: row.month, amount: row.income, incomplete: row.incomplete }));
  const amounts = new Map();
  for (const transaction of periodTransactions(state.transactions, period).filter(isExternalCashflowTransaction)) {
    const date = String(transaction.date || '').slice(0, 10);
    if (!date || Number(transaction.incoming || 0) <= 0) continue;
    amounts.set(date, roundMoney((amounts.get(date) || 0) + Number(transaction.incoming || 0)));
  }
  return [...amounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([label, amount]) => ({ label, amount, incomplete: false }));
}

export function reportTextSummary(report) {
  const largest = report.largestCategory
    ? `${report.largestCategory.label} is the largest spending category at ${formatCurrency(report.largestCategory.amount)}.`
    : 'No trusted category spending is available for this period.';
  return `${formatCurrency(report.summary.income)} in and ${formatCurrency(report.summary.spending)} out. ${largest}`;
}

function recurringSplit(state, period, budget) {
  const transactionsById = new Map((state.transactions || []).map((transaction) => [String(transaction.id), transaction]));
  const confirmedIds = confirmedRecurringTransactionIds(state);
  let committed = 0;
  let flexible = 0;
  for (const row of budget.rows) {
    for (const contribution of row.contributions) {
      const transaction = transactionsById.get(String(contribution.id));
      if (confirmedIds.has(String(transaction?.id))) committed += Number(contribution.amount || 0);
      else flexible += Number(contribution.amount || 0);
    }
  }
  const uncategorisedIds = new Set(budget.uncategorisedTransactionIds.map(String));
  for (const transaction of periodTransactions(state.transactions, period)) {
    if (!uncategorisedIds.has(String(transaction.id))) continue;
    if (confirmedIds.has(String(transaction.id))) committed += Number(transaction.outgoing || 0);
    else flexible += Number(transaction.outgoing || 0);
  }
  return { committed: roundMoney(committed), flexible: roundMoney(flexible), evidence: committed > 0 ? 'confirmed' : 'insufficient' };
}

function monthlyComparison(timeline, period, now) {
  const current = timeline.find((row) => row.month === period);
  const previousMonth = offsetMonth(period, -1);
  const previous = timeline.find((row) => row.month === previousMonth);
  if (!current || !previous) return { available: false, incomplete: Boolean(current?.incomplete), text: 'A previous complete month is needed for comparison.' };
  const difference = roundMoney(current.spending - previous.spending);
  const incomplete = isIncompleteMonth(period, now);
  return {
    available: true,
    incomplete,
    current: current.spending,
    previous: previous.spending,
    difference,
    direction: difference < 0 ? 'lower' : difference > 0 ? 'higher' : 'same',
    text: incomplete
      ? `Current month to date: ${formatCurrency(current.spending)}. Last complete month: ${formatCurrency(previous.spending)}. These are not like-for-like periods.`
      : difference === 0
        ? `Spending matched last month at ${formatCurrency(current.spending)}.`
        : `Spending was ${formatCurrency(Math.abs(difference))} ${difference < 0 ? 'lower' : 'higher'} than last month.`
  };
}

function allTimeComparison(timeline) {
  const complete = timeline.filter((row) => !row.incomplete);
  const average = complete.length ? roundMoney(complete.reduce((total, row) => total + row.spending, 0) / complete.length) : 0;
  return {
    available: complete.length > 0,
    incomplete: timeline.some((row) => row.incomplete),
    average,
    completeMonths: complete.length,
    text: complete.length ? `Average spending across ${complete.length} complete month${complete.length === 1 ? '' : 's'}: ${formatCurrency(average)}.` : 'A complete month is needed before an average can be shown.'
  };
}

function buildProgress(state) {
  const tracked = [...(state.debts || []).map((item) => ({ ...item, progressKind: 'debt' })), ...(state.overdrafts || []).map((item) => ({ ...item, progressKind: 'overdraft' }))];
  const debts = tracked.map((item) => {
    const current = Math.max(0, Number(item.currentBalance || 0));
    const original = finitePositive(item.originalBalance) ? Number(item.originalBalance) : null;
    const cleared = original === null ? null : Math.max(0, roundMoney(original - current));
    const percent = original === null ? null : Math.max(0, Math.min(100, Math.round((cleared / original) * 100)));
    const limit = finitePositive(item.limit ?? item.creditLimit) ? Number(item.limit ?? item.creditLimit) : null;
    return { id: item.id, name: item.name || 'Unnamed account', kind: item.progressKind, current, original, cleared, percent, limit };
  });
  const savingsCurrent = Math.max(0, Number(state.settings?.emergencyBufferBalance || 0));
  const savingsTarget = Math.max(0, Number(state.settings?.emergencyBufferTarget || 0));
  return {
    debts,
    savings: {
      current: savingsCurrent,
      target: savingsTarget,
      percent: savingsTarget > 0 ? Math.min(100, Math.round((savingsCurrent / savingsTarget) * 100)) : null
    }
  };
}

function buildFinancialWins(state, comparison) {
  const wins = [];
  const totalCleared = [...(state.debts || []), ...(state.overdrafts || [])].reduce((total, item) => {
    const original = finitePositive(item.originalBalance) ? Number(item.originalBalance) : null;
    return total + (original === null ? 0 : Math.max(0, original - Number(item.currentBalance || 0)));
  }, 0);
  if (totalCleared > 0) wins.push(`${formatCurrency(totalCleared)} cleared from balances with a known starting amount.`);
  if ((state.overdrafts || []).length && state.overdrafts.every((item) => Number(item.currentBalance || 0) <= 0)) wins.push('Your tracked overdrafts are currently back in credit.');
  const buffer = Number(state.settings?.emergencyBufferBalance || 0);
  const milestone = [500, 250, 100].find((value) => buffer >= value);
  if (milestone) wins.push(`Emergency buffer has passed ${formatCurrency(milestone, { whole: true })}.`);
  if (comparison.available && !comparison.incomplete && comparison.direction === 'lower') wins.push(comparison.text);
  return wins;
}

function isIncompleteMonth(month, now) {
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return month === currentMonth;
}

function offsetMonth(month, offset) {
  if (!/^\d{4}-\d{2}$/.test(String(month))) return '';
  const [year, number] = month.split('-').map(Number);
  const date = new Date(year, number - 1 + offset, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function finitePositive(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function sum(rows, field) {
  return roundMoney(rows.reduce((total, row) => total + (Number.isFinite(Number(row[field])) ? Number(row[field]) : 0), 0));
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}
