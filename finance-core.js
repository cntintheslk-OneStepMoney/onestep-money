export const SCHEMA_VERSION = 5;

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
  return (transactions || []).filter((transaction) => String(transaction.budgetMonth || transaction.date || '').slice(0, 7) === month);
}

export function calculatePeriodSummary(state, month = state.settings?.selectedMonth) {
  const rows = periodTransactions(state.transactions, month);
  const external = rows.filter((transaction) => transaction.transferStatus !== 'confirmed');
  const income = sum(external, 'incoming');
  const spending = sum(external, 'outgoing');
  const payslips = (state.payslips || []).filter((payslip) => payslip.period === month);
  const grossPay = sum(payslips, 'grossPay');
  const payrollDeductions = sum(payslips, 'totalDeductions');
  const netPay = sum(payslips, 'netPay');
  const plannedSpending = roundMoney((state.budgets || []).reduce((total, budget) => total + Number(budget.planned || 0), 0));
  const dependableIncome = Number(state.profile?.dependableIncome || 0);
  const plannedMargin = roundMoney(dependableIncome - plannedSpending);
  const overdrafts = sum(state.overdrafts, 'currentBalance');
  const debts = sum(state.debts, 'currentBalance');
  return {
    month, income, spending, netCashFlow: roundMoney(income - spending),
    grossPay, payrollDeductions, netPay, dependableIncome, plannedSpending, plannedMargin,
    debts, overdrafts, totalOwed: roundMoney(debts + overdrafts), transactionCount: rows.length
  };
}

export function calculateBudgetRows(state, month = state.settings?.selectedMonth) {
  const rows = periodTransactions(state.transactions, month).filter((transaction) => transaction.transferStatus !== 'confirmed');
  return (state.budgets || []).map((budget) => {
    const categories = (budget.categories?.length ? budget.categories : [budget.category]).map(normalise);
    const terms = (budget.merchantTerms || []).map(normalise);
    const actual = roundMoney(rows.filter((transaction) => transaction.outgoing > 0 && (categories.includes(normalise(transaction.category)) || terms.some((term) => normalise(transaction.description).includes(term)))).reduce((total, transaction) => total + transaction.outgoing, 0));
    return { ...budget, actual, remaining: roundMoney(Number(budget.planned || 0) - actual) };
  });
}

export function buildNextAction(state, now = new Date()) {
  const today = localDateKey(now);
  const isSnoozed = (id) => String(state.settings?.snoozedActions?.[id] || '') > today;
  const task = (state.tasks || [])
    .filter((entry) => !entry.completedAt && (!entry.snoozedUntil || entry.snoozedUntil <= today))
    .sort((left, right) => Number(left.order || 999) - Number(right.order || 999))[0];
  if (task) return task;

  const checkIn = { id: 'generated-checkin', title: 'Complete a five-minute check-in', detail: 'Update one balance, then stop. Consistency matters more than perfection.', timeframe: '5 min', stage: 'today' };
  if (!(state.accounts || []).length) {
    const firstAccount = { id: 'generated-first-account', title: 'Add your first account', detail: 'Open Settings, add one bank account, then stop. No balances need to be perfect yet.', timeframe: '5 min', stage: 'today' };
    return isSnoozed(firstAccount.id) ? checkIn : firstAccount;
  }
  if (!(state.transactions || []).length) {
    const firstImport = { id: 'generated-first-import', title: 'Import one recent statement', detail: 'Choose one account and review the preview before accepting any payments.', timeframe: '10 min', stage: 'today' };
    return isSnoozed(firstImport.id) ? checkIn : firstImport;
  }

  const overLimit = (state.overdrafts || []).find((item) => item.status === 'over_limit');
  if (overLimit && !isSnoozed('generated-overlimit')) return { id: 'generated-overlimit', title: `Check ${overLimit.name}`, detail: 'Confirm the balance and ask about an affordable plan before making an extra debt payment.', timeframe: '10 min', stage: 'today' };
  const arrears = [...(state.overdrafts || []), ...(state.debts || [])].find((item) => ['arrears', 'defaulted'].includes(item.status));
  if (arrears && !isSnoozed('generated-arrears')) return { id: 'generated-arrears', title: `Confirm the plan for ${arrears.name}`, detail: 'Record the agreed payment and whether interest or charges are frozen.', timeframe: '10 min', stage: 'this week' };
  if (!isSnoozed(checkIn.id)) return checkIn;
  return { id: 'generated-paused', title: 'Nothing else needs your attention today', detail: 'Your available steps are snoozed. Come back tomorrow, or use another page if you choose to update something now.', timeframe: 'Done', stage: 'today', passive: true };
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
  const overLimit = (state.overdrafts || []).find((item) => item.status === 'over_limit');
  const arrears = [...(state.overdrafts || []), ...(state.debts || [])].filter((item) => ['arrears', 'defaulted'].includes(item.status));
  if (overLimit) checks.push({ tone: 'urgent', title: 'Stabilise the overdraft first', text: `${overLimit.name} is ${formatCurrency(overLimit.currentBalance)} overdrawn${overLimit.limit ? ` against a ${formatCurrency(overLimit.limit)} limit` : ''}. Confirm essential payments before overpaying another account.` });
  if (arrears.length) checks.push({ tone: 'warning', title: 'Plans still need confirming', text: `${arrears.length} account${arrears.length === 1 ? '' : 's'} are marked in arrears or defaulted. Record each agreed payment and whether charges are frozen.` });
  if (summary.plannedMargin >= 0) checks.push({ tone: 'positive', title: 'Planned safety margin', text: `${formatCurrency(summary.plannedMargin)} remains after the amounts currently entered. Treat it as provisional until every essential bill is recorded.` });
  else checks.push({ tone: 'urgent', title: 'Plan is short', text: `The entered plan is ${formatCurrency(Math.abs(summary.plannedMargin))} over dependable income. Reduce flexible spending before adding an extra payment.` });
  const savings = findSavingsOpportunities(state);
  if (savings[0]) checks.push({ tone: 'neutral', title: 'Best penny-pinching review', text: savings[0].text });
  return checks.slice(0, 4);
}

export function findSavingsOpportunities(state) {
  const months = [...new Set((state.transactions || []).map((transaction) => String(transaction.budgetMonth || '').slice(0, 7)).filter(Boolean))];
  const externalExpenses = (state.transactions || []).filter((transaction) => transaction.outgoing > 0 && transaction.transferStatus !== 'confirmed');
  const categories = new Map();
  for (const transaction of externalExpenses) categories.set(transaction.category, (categories.get(transaction.category) || 0) + transaction.outgoing);
  const flexible = ['Subscriptions & software', 'Eating out', 'Shopping', 'Other / review'];
  const budgetByCategory = new Map((state.budgets || []).map((budget) => [budget.category, Number(budget.planned || 0)]));
  const opportunities = flexible.map((category) => {
    const average = roundMoney((categories.get(category) || 0) / Math.max(1, months.length));
    const target = budgetByCategory.get(category) || (category === 'Eating out' ? 50 : 0);
    const possibleSaving = roundMoney(Math.max(0, average - target));
    return { category, average, target, possibleSaving, text: `${category} averaged ${formatCurrency(average)} a month. Reviewing it against a ${formatCurrency(target)} cap could free roughly ${formatCurrency(possibleSaving)} a month.` };
  }).filter((entry) => entry.possibleSaving > 0).sort((left, right) => right.possibleSaving - left.possibleSaving);

  return opportunities;
}

export function debtPlan(state, strategy = 'hybrid', extraPayment = state.settings?.extraDebtPayment ?? 0, startMonth = currentMonth()) {
  const items = [...(state.debts || []).map((item) => ({ ...item, kind: 'debt' })), ...(state.overdrafts || []).map((item) => ({ ...item, kind: 'overdraft' }))]
    .filter((item) => item.includeInPlan !== false && Number(item.currentBalance || 0) > 0)
    .map((item) => ({ ...item, balance: Number(item.currentBalance), apr: item.apr === null || item.apr === undefined ? null : Number(item.apr), minimum: Number(item.contractualPayment || item.minimumPayment || 0) }));
  const unknownApr = items.filter((item) => item.apr === null).map((item) => item.name);
  const minimumTotal = roundMoney(items.reduce((total, item) => total + item.minimum, 0));
  const monthlyPot = roundMoney(minimumTotal + Math.max(0, Number(extraPayment || 0)));
  const schedule = [];
  const balances = new Map(items.map((item) => [item.id, item.balance]));
  const date = new Date(`${startMonth}-01T00:00:00Z`);
  let totalInterest = 0;

  for (let monthIndex = 0; monthIndex < 120 && [...balances.values()].some((balance) => balance > 0.005); monthIndex += 1) {
    let interestThisMonth = 0;
    for (const item of items) {
      const balance = balances.get(item.id) || 0;
      if (balance <= 0) continue;
      const interest = roundMoney(balance * ((item.apr || 0) / 12));
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

  const unsafeStatuses = [...(state.debts || []), ...(state.overdrafts || [])].filter((item) => ['arrears', 'over_limit'].includes(item.status) && !item.arrangementConfirmed);
  return {
    strategy, schedule, unknownApr, minimumTotal, monthlyPot, totalInterest,
    debtFreeMonth: schedule.at(-1)?.endingBalance === 0 ? schedule.at(-1).month : '',
    safeToOverpay: unsafeStatuses.length === 0,
    blockers: unsafeStatuses.map((item) => item.name)
  };
}

export function findDuplicateCandidates(existing, incoming) {
  const exact = [];
  const possible = [];
  const exactMap = new Map((existing || []).map((item) => [exactTransactionKey(item), item]));
  for (const item of incoming || []) {
    const key = exactTransactionKey(item);
    if (exactMap.has(key)) { exact.push({ incoming: item, existing: exactMap.get(key) }); continue; }
    const candidate = (existing || []).find((other) => other.accountId === item.accountId && other.date === item.date && roundMoney(other.incoming) === roundMoney(item.incoming) && roundMoney(other.outgoing) === roundMoney(item.outgoing));
    if (candidate) possible.push({ incoming: item, existing: candidate });
  }
  return { exact, possible };
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
  const text = String(value || '').toLowerCase();
  if (/default/.test(text)) return 'defaulted';
  if (/over limit/.test(text)) return 'over_limit';
  if (/arrears|late|missed|delinquent/.test(text)) return 'arrears';
  return 'current';
}

export function syncStatementAccount(state, account, preview, documentId = '') {
  const closingBalance = Number(preview?.summary?.closingBalance);
  if (!account || !preview?.reconciled || !Number.isFinite(closingBalance)) return '';
  account.currentBalance = closingBalance;
  account.statementDate = (preview.records || []).map((item) => item.date).filter(Boolean).sort().at(-1) || account.statementDate;
  if (!Number.isFinite(account.openingBalance) && Number.isFinite(preview.summary.openingBalance)) account.openingBalance = preview.summary.openingBalance;
  if (!account.institution && preview.institution) account.institution = preview.institution;

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

export function matchInternalTransfers(transactions) {
  const credits = transactions.filter((item) => item.incoming > 0 && item.transferStatus !== 'confirmed');
  const matches = [];
  for (const debit of transactions.filter((item) => item.outgoing > 0 && item.transferStatus !== 'confirmed')) {
    const credit = credits.find((item) => item.accountId !== debit.accountId && Math.abs(item.incoming - debit.outgoing) < 0.01 && Math.abs(dateDistance(item.date, debit.date)) <= 2);
    if (credit) {
      const descriptions = `${normalise(debit.description)} ${normalise(credit.description)}`;
      matches.push({ debitId: debit.id, creditId: credit.id, amount: debit.outgoing, confidence: /own account|internal transfer|account transfer/.test(descriptions) ? 'likely' : 'possible' });
    }
  }
  return matches;
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
    const blocker = plan.safeToOverpay ? '' : ` First confirm arrangements for ${plan.blockers.join(' and ')}.`;
    return `Your recorded debt and overdrafts total ${formatCurrency(summary.totalOwed)}.${blocker} The payoff forecast is provisional while ${plan.unknownApr.length} rate${plan.unknownApr.length === 1 ? ' is' : 's are'} unknown.`;
  }
  return `Your selected month shows ${formatCurrency(summary.income)} external money in and ${formatCurrency(summary.spending)} out. The safest next move is: ${next.title}.`;
}

function priorityOrder(items, balances, strategy) {
  return items.filter((item) => (balances.get(item.id) || 0) > 0).sort((left, right) => {
    if (strategy === 'snowball') return (balances.get(left.id) || 0) - (balances.get(right.id) || 0);
    if (strategy === 'hybrid') return Number(left.planPriority || 999) - Number(right.planPriority || 999);
    const leftApr = left.apr === null ? -1 : left.apr;
    const rightApr = right.apr === null ? -1 : right.apr;
    return rightApr - leftApr || (balances.get(left.id) || 0) - (balances.get(right.id) || 0);
  });
}

function isBlankState(state) {
  return ['accounts', 'transactions', 'payslips', 'creditReports', 'debts', 'overdrafts', 'budgets'].every((key) => !(state[key] || []).length);
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
  return new Date().toISOString().slice(0, 7);
}

function reportingMonth(value) {
  const month = String(value || '').slice(0, 7);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : '';
}

function exactTransactionKey(item) {
  return [item.accountId, item.date, roundMoney(item.incoming), roundMoney(item.outgoing), normalise(item.description), item.sourceRow || ''].join('|');
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function normalise(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
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
