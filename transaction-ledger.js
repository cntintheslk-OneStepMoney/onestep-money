import { ALL_TIME_PERIOD, isIncomePayment } from './finance-core.js';

export const DEFAULT_TRANSACTION_PAGE_SIZE = 100;
export const INCOME_PAYMENT_CATEGORY_VALUE = 'payment-category:income';

export function buildTransactionLedgerIndex(state, budgetAnalysis) {
  const budgetByTransaction = new Map();
  for (const budget of budgetAnalysis.rows) {
    for (const contribution of budget.contributions) budgetByTransaction.set(contribution.id, budget);
  }

  return {
    accountNames: new Map(state.accounts.map((item) => [item.id, item.name])),
    budgetByTransaction,
    uncategorised: new Set(budgetAnalysis.uncategorisedTransactionIds),
    transactions: [...state.transactions].sort((left, right) => (
      String(left.date || '').localeCompare(String(right.date || ''))
      || Number(left.sourceRow || 0) - Number(right.sourceRow || 0)
    ))
  };
}

export function filterTransactionLedger(index, filters = {}) {
  const period = filters.period || ALL_TIME_PERIOD;
  const search = String(filters.search || '').trim().toLowerCase();
  const account = filters.account || 'all';
  const type = filters.type || 'all';
  const category = filters.category || 'all';

  return index.transactions.filter((item) => {
    if (period !== ALL_TIME_PERIOD && !String(item.budgetMonth || item.date || '').startsWith(period)) return false;
    if (account !== 'all' && item.accountId !== account) return false;
    if (type === 'incoming' && Number(item.incoming || 0) <= 0) return false;
    if (type === 'outgoing' && Number(item.outgoing || 0) <= 0) return false;
    if (type === 'transfer' && item.transferStatus === 'no') return false;
    if (!['all', 'incoming', 'outgoing', 'transfer'].includes(type)) return false;

    const budget = index.budgetByTransaction.get(item.id);
    if (category === 'uncategorised' && !index.uncategorised.has(item.id)) return false;
    if (category === INCOME_PAYMENT_CATEGORY_VALUE && !isIncomePayment(item)) return false;
    if (!['all', 'uncategorised', INCOME_PAYMENT_CATEGORY_VALUE].includes(category) && budget?.id !== category) return false;

    if (search) {
      const searchable = [item.description, item.userDescription, budget?.category, item.category, item.notes]
        .join(' ')
        .toLowerCase();
      if (!searchable.includes(search)) return false;
    }
    return true;
  });
}

export function paginateTransactionLedger(rows, requestedPage = 1, pageSize = DEFAULT_TRANSACTION_PAGE_SIZE) {
  const safePageSize = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : DEFAULT_TRANSACTION_PAGE_SIZE;
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / safePageSize));
  const page = Math.min(totalPages, Math.max(1, Number.isInteger(requestedPage) ? requestedPage : 1));
  const startIndex = (page - 1) * safePageSize;
  const endIndex = Math.min(startIndex + safePageSize, totalRows);

  return {
    items: rows.slice(startIndex, endIndex),
    page,
    pageSize: safePageSize,
    totalPages,
    totalRows,
    start: totalRows ? startIndex + 1 : 0,
    end: endIndex
  };
}
