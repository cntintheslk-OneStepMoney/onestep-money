export const DEMO_CLOCK = '2026-08-10T12:00:00.000Z';

export const DEMO_IMPORT_TRANSACTIONS = Object.freeze([
  Object.freeze({
    id: 'demo-import-groceries', accountId: 'account-current', date: '2026-08-08',
    description: 'Northstar Grocers', category: 'Food & groceries', budgetCategoryId: 'budget-food',
    categorySource: 'imported', incoming: 0, outgoing: 34.25, recurring: false, financiallyActive: true
  }),
  Object.freeze({
    id: 'demo-import-bus', accountId: 'account-current', date: '2026-08-09',
    description: 'Cityline Bus', category: 'Transport', budgetCategoryId: 'budget-transport',
    categorySource: 'imported', incoming: 0, outgoing: 4.5, recurring: false, financiallyActive: true
  }),
  Object.freeze({
    id: 'demo-import-refund', accountId: 'account-current', date: '2026-08-09',
    description: 'Northstar Grocers refund', category: 'Food & groceries', budgetCategoryId: 'budget-food',
    categorySource: 'imported', incoming: 5.25, outgoing: 0, budgetTreatment: 'refund', recurring: false, financiallyActive: true
  })
]);

export const DEMO_BASE_STATE = Object.freeze({
  schemaVersion: 9,
  meta: Object.freeze({
    demo: true,
    demoVersion: 1,
    createdAt: DEMO_CLOCK,
    updatedAt: DEMO_CLOCK,
    revision: 0
  }),
  profile: Object.freeze({
    name: 'Alex Rowan',
    locale: 'en-GB',
    currency: 'GBP',
    dependableIncome: 2100,
    paydayDay: 28
  }),
  accounts: Object.freeze([
    Object.freeze({ id: 'account-current', name: 'Everyday Current', type: 'current', currentBalance: 620.85, active: true }),
    Object.freeze({ id: 'account-savings', name: 'Rainy Day Savings', type: 'savings', currentBalance: 320, active: true })
  ]),
  transactions: Object.freeze([
    Object.freeze({ id: 'tx-income', accountId: 'account-current', date: '2026-08-01', description: 'Fictional Employer Payroll', category: 'Income', categorySource: 'manual', incoming: 2100, outgoing: 0, financiallyActive: true }),
    Object.freeze({ id: 'tx-rent', accountId: 'account-current', date: '2026-08-02', description: 'Harbour View Rent', category: 'Housing', budgetCategoryId: 'budget-housing', categorySource: 'manual', incoming: 0, outgoing: 675, recurring: true, financiallyActive: true }),
    Object.freeze({ id: 'tx-food', accountId: 'account-current', date: '2026-08-03', description: 'Northstar Grocers', category: 'Food & groceries', budgetCategoryId: 'budget-food', categorySource: 'manual', incoming: 0, outgoing: 72.4, recurring: false, financiallyActive: true }),
    Object.freeze({ id: 'tx-fuel', accountId: 'account-current', date: '2026-08-04', description: 'Bluebird Fuel', category: 'Transport', budgetCategoryId: 'budget-transport', categorySource: 'manual', incoming: 0, outgoing: 54.6, recurring: false, financiallyActive: true }),
    Object.freeze({ id: 'tx-mobile', accountId: 'account-current', date: '2026-08-05', description: 'Pine Mobile', category: 'Bills & utilities', budgetCategoryId: 'budget-bills', categorySource: 'manual', incoming: 0, outgoing: 18, recurring: true, financiallyActive: true }),
    Object.freeze({ id: 'tx-streaming', accountId: 'account-current', date: '2026-08-06', description: 'Lantern Streaming', category: 'Subscriptions & software', budgetCategoryId: 'budget-subscriptions', categorySource: 'manual', incoming: 0, outgoing: 10.99, recurring: true, financiallyActive: true }),
    Object.freeze({ id: 'tx-coffee', accountId: 'account-current', date: '2026-08-07', description: 'Copper Kettle Cafe', category: '', categorySource: 'manual', incoming: 0, outgoing: 7.2, recurring: false, financiallyActive: true }),
    Object.freeze({ id: 'tx-market-original', accountId: 'account-current', date: '2026-08-07', description: 'Harbour Market', category: 'Food & groceries', budgetCategoryId: 'budget-food', categorySource: 'manual', incoming: 0, outgoing: 48, recurring: false, financiallyActive: true }),
    Object.freeze({ id: 'tx-market-possible-duplicate', accountId: 'account-current', date: '2026-08-07', description: 'Harbour Market', category: 'Food & groceries', budgetCategoryId: 'budget-food', categorySource: 'imported', incoming: 0, outgoing: 48, duplicateStatus: 'possible', duplicateCandidateId: 'tx-market-original', reviewStatus: 'pending', financiallyActive: false })
  ]),
  payslips: Object.freeze([
    Object.freeze({ id: 'pay-aug', period: '2026-08', payDate: '2026-08-01', employer: 'Fictional Employer', grossPay: 2785, totalDeductions: 685, netPay: 2100 })
  ]),
  taxDocuments: Object.freeze([]),
  creditReports: Object.freeze([]),
  debts: Object.freeze([
    Object.freeze({
      id: 'debt-card', name: 'Anchor Credit Card', type: 'credit card', originalBalance: 500,
      currentBalance: 420, creditLimit: 500, apr: 0, contractualPayment: 0, status: 'defaulted',
      arrangementStatus: 'unknown', arrangementPayment: null, includeInPlan: true, interestFrozen: true
    }),
    Object.freeze({
      id: 'debt-loan', name: 'Beacon Personal Loan', type: 'loan', originalBalance: 1200,
      currentBalance: 840, apr: 8.9, contractualPayment: 80, status: 'current',
      arrangementStatus: 'none', arrangementPayment: null, includeInPlan: true
    })
  ]),
  overdrafts: Object.freeze([
    Object.freeze({
      id: 'overdraft-main', accountId: 'account-current', name: 'Everyday overdraft', type: 'overdraft',
      originalBalance: 300, currentBalance: 190, limit: 500, apr: 39.9, contractualPayment: 0,
      status: 'current', arrangementStatus: 'none', includeInPlan: true
    })
  ]),
  budgets: Object.freeze([
    Object.freeze({ id: 'budget-bills', category: 'Bills & utilities', planned: 180, section: 'Essentials' }),
    Object.freeze({ id: 'budget-debt', category: 'Debt payments', planned: 80, section: 'Debt minimums' }),
    Object.freeze({ id: 'budget-eating', category: 'Eating out', planned: 70, section: 'Flexible' }),
    Object.freeze({ id: 'budget-food', category: 'Food & groceries', planned: 300, section: 'Essentials' }),
    Object.freeze({ id: 'budget-housing', category: 'Housing', planned: 675, section: 'Essentials' }),
    Object.freeze({ id: 'budget-other', category: 'Other / review', planned: 80, section: 'Flexible' }),
    Object.freeze({ id: 'budget-subscriptions', category: 'Subscriptions & software', planned: 40, section: 'Flexible' }),
    Object.freeze({ id: 'budget-transport', category: 'Transport', planned: 160, section: 'Essentials' })
  ]),
  scheduledPayments: Object.freeze([
    Object.freeze({ id: 'scheduled-electric', name: 'Electricity direct debit', amount: 58, dueDate: '2026-08-12', status: 'scheduled', includedInBudget: true }),
    Object.freeze({ id: 'scheduled-insurance', name: 'Home contents cover', amount: 14, dueDate: '2026-08-16', status: 'scheduled', includedInBudget: false })
  ]),
  documents: Object.freeze([]),
  tasks: Object.freeze([
    Object.freeze({ id: 'task-electric', title: 'Confirm the electricity direct debit', detail: 'Check that the new amount matches the bill before it leaves the account.', priority: 'high', essential: true, dueDate: '2026-08-12', actionView: 'today', createdAt: '2026-08-06T09:00:00.000Z' }),
    Object.freeze({ id: 'task-insurance', title: 'Compare the renewal quote', detail: 'A useful saving check, but it does not need to take over Today.', priority: 'low', dueDate: '2026-08-22', actionView: 'today', createdAt: '2026-08-05T09:00:00.000Z' })
  ]),
  checkIns: Object.freeze([
    Object.freeze({ id: 'check-1', date: '2026-08-03T18:00:00.000Z', completed: true }),
    Object.freeze({ id: 'check-2', date: '2026-08-10T09:00:00.000Z', completed: true })
  ]),
  importBatches: Object.freeze([]),
  reviewItems: Object.freeze([]),
  settings: Object.freeze({
    selectedMonth: '2026-08',
    extraDebtPayment: 100,
    emergencyBufferTarget: 500,
    emergencyBufferBalance: 320,
    extraIncomeDebtPercent: 80,
    snoozedActions: Object.freeze({}),
    appearance: Object.freeze({ theme: 'system' }),
    dashboard: Object.freeze({ mode: 'detailed', order: Object.freeze([]), hidden: Object.freeze([]), pinned: Object.freeze(['next-move']), sizes: Object.freeze({}) }),
    demo: Object.freeze({ guidanceDismissed: false, importApplied: false })
  })
});
