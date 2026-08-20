import assert from 'node:assert/strict';
import test from 'node:test';
import { ALL_TIME_PERIOD, calculatePeriodIncome, calculatePeriodSummary } from '../finance-core.js';
import { buildFinancialReport } from '../financial-reporting.js';

test('Money In counts normal trusted external income for one month', () => {
  const state = baseState();
  state.transactions = [transaction({ id: 'salary-credit', date: '2026-08-28', incoming: 2100 })];

  const evidence = calculatePeriodIncome(state, '2026-08');
  const summary = calculatePeriodSummary(state, '2026-08');
  assert.equal(evidence.total, 2100);
  assert.equal(evidence.transactionTotal, 2100);
  assert.equal(evidence.payslipFallbackTotal, 0);
  assert.equal(summary.income, 2100);
});

test('Money In uses a dated payslip as fallback when no corresponding trusted credit exists', () => {
  const state = baseState();
  state.payslips = [payslip({ id: 'august-payslip', period: '2026-08', payDate: '2026-08-28', netPay: 2050 })];

  const evidence = calculatePeriodIncome(state, '2026-08');
  assert.equal(evidence.total, 2050);
  assert.equal(evidence.transactionTotal, 0);
  assert.equal(evidence.payslipFallbackTotal, 2050);
  assert.deepEqual(evidence.entries.map(({ sourceType, date, amount }) => [sourceType, date, amount]), [
    ['payslip', '2026-08-28', 2050]
  ]);
});

test('matching payslip and bank salary evidence are reconciled once, while distinct income remains counted', () => {
  const state = baseState();
  state.transactions = [
    transaction({ id: 'salary-credit', date: '2026-08-29', incoming: 2050 }),
    transaction({ id: 'fictional-side-income', date: '2026-08-14', incoming: 125.5 })
  ];
  state.payslips = [payslip({ id: 'august-payslip', period: '2026-08', payDate: '2026-08-28', netPay: 2050 })];

  const evidence = calculatePeriodIncome(state, '2026-08');
  assert.equal(evidence.total, 2175.5);
  assert.equal(evidence.transactionTotal, 2175.5);
  assert.equal(evidence.payslipFallbackTotal, 0);
  assert.equal(evidence.entries.filter((entry) => entry.sourceType === 'payslip').length, 0);
});

test('multiple payslips reconcile one-to-one and preserve a genuinely unmatched second payment', () => {
  const state = baseState();
  state.transactions = [transaction({ id: 'salary-one', date: '2026-08-15', incoming: 1000 })];
  state.payslips = [
    payslip({ id: 'payslip-one', period: '2026-08', payDate: '2026-08-15', netPay: 1000 }),
    payslip({ id: 'payslip-two', period: '2026-08', payDate: '2026-08-29', netPay: 1000 })
  ];

  const evidence = calculatePeriodIncome(state, '2026-08');
  assert.equal(evidence.total, 2000);
  assert.equal(evidence.transactionTotal, 1000);
  assert.equal(evidence.payslipFallbackTotal, 1000);
  assert.equal(evidence.entries.filter((entry) => entry.sourceType === 'payslip').length, 1);
});

test('refund cashflow stays Money In but is not mistaken for matching salary evidence', () => {
  const state = baseState();
  state.transactions = [transaction({
    id: 'refund', date: '2026-08-28', incoming: 2050, budgetTreatment: 'refund', refundOfTransactionId: 'fictional-purchase'
  })];
  state.payslips = [payslip({ id: 'august-payslip', period: '2026-08', payDate: '2026-08-28', netPay: 2050 })];

  const evidence = calculatePeriodIncome(state, '2026-08');
  assert.equal(evidence.transactionTotal, 2050);
  assert.equal(evidence.payslipFallbackTotal, 2050);
  assert.equal(evidence.total, 4100);
});

test('Money In preserves transfer and duplicate financial-activity rules', () => {
  const state = baseState();
  state.transactions = [
    transaction({ id: 'normal', date: '2026-08-01', incoming: 500 }),
    transaction({ id: 'internal', date: '2026-08-02', incoming: 900, transferStatus: 'confirmed' }),
    transaction({ id: 'exact', date: '2026-08-03', incoming: 700, duplicateStatus: 'exact' }),
    transaction({ id: 'possible-pending', date: '2026-08-04', incoming: 600, duplicateStatus: 'possible', reviewStatus: 'pending' }),
    transaction({ id: 'possible-accepted', date: '2026-08-05', incoming: 650, duplicateStatus: 'possible', reviewStatus: 'accepted' })
  ];

  const evidence = calculatePeriodIncome(state, '2026-08');
  assert.equal(evidence.total, 1150);
  assert.deepEqual(evidence.entries.map((entry) => entry.sourceId).sort(), ['normal', 'possible-accepted']);
});

test('eight-month reporting aggregates the same authoritative Money In rule without multiplying payslips', () => {
  const state = baseState();
  const months = Array.from({ length: 8 }, (_, index) => `2026-${String(index + 1).padStart(2, '0')}`);
  state.payslips = months.map((period, index) => payslip({
    id: `payslip-${index + 1}`,
    period,
    payDate: `${period}-28`,
    netPay: 2000 + index
  }));
  state.transactions = months.slice(0, 4).map((period, index) => transaction({
    id: `salary-${index + 1}`,
    date: `${period}-28`,
    budgetMonth: period,
    incoming: 2000 + index
  }));

  const expected = months.reduce((total, _period, index) => total + 2000 + index, 0);
  const evidence = calculatePeriodIncome(state, ALL_TIME_PERIOD);
  const summary = calculatePeriodSummary(state, ALL_TIME_PERIOD);
  assert.equal(evidence.total, expected);
  assert.equal(summary.income, expected);
  assert.equal(evidence.entries.length, 8);
});

test('spending and net cash flow remain reconciled when payslip fallback supplies Money In', () => {
  const state = baseState();
  state.transactions = [transaction({ id: 'spend', date: '2026-08-12', outgoing: 125 })];
  state.payslips = [payslip({ id: 'august-payslip', period: '2026-08', payDate: '2026-08-28', netPay: 2050 })];

  const summary = calculatePeriodSummary(state, '2026-08');
  assert.equal(summary.income, 2050);
  assert.equal(summary.spending, 125);
  assert.equal(summary.netCashFlow, 1925);
});

test('financial report summary and Money In timeline consume the same authoritative income evidence', () => {
  const state = baseState();
  state.transactions = [transaction({ id: 'side-income', date: '2026-08-10', incoming: 100 })];
  state.payslips = [payslip({ id: 'august-payslip', period: '2026-08', payDate: '2026-08-28', netPay: 2050 })];

  const evidence = calculatePeriodIncome(state, '2026-08');
  const report = buildFinancialReport(state, '2026-08', new Date('2026-09-10T12:00:00.000Z'));
  assert.equal(report.summary.income, evidence.total);
  assert.deepEqual(report.incomeTimeline, [
    { label: '2026-08-10', amount: 100, incomplete: false },
    { label: '2026-08-28', amount: 2050, incomplete: false }
  ]);
});

test('invalid or undated payslips do not get matched across months or invented into Money In', () => {
  const state = baseState();
  state.payslips = [
    payslip({ id: 'missing-date', period: '2026-08', payDate: '', netPay: 2050 }),
    payslip({ id: 'invalid-date', period: '2026-08', payDate: '2026-08-99', netPay: 2100 })
  ];
  state.transactions = [transaction({ id: 'september-credit', date: '2026-09-01', budgetMonth: '2026-09', incoming: 2050 })];

  assert.equal(calculatePeriodIncome(state, '2026-08').total, 0);
  assert.equal(calculatePeriodIncome(state, '2026-09').total, 2050);
});

function baseState() {
  return {
    profile: { dependableIncome: 2000 },
    settings: { selectedMonth: '2026-08', emergencyBufferTarget: 0, emergencyBufferBalance: 0 },
    accounts: [{ id: 'fictional-current', type: 'current', currentBalance: 1000, active: true }],
    transactions: [], payslips: [], debts: [], overdrafts: [], budgets: [], tasks: [], reviewItems: [], scheduledPayments: []
  };
}

function transaction(overrides = {}) {
  return {
    id: 'transaction',
    accountId: 'fictional-current',
    date: '2026-08-01',
    budgetMonth: '2026-08',
    incoming: 0,
    outgoing: 0,
    category: '',
    budgetTreatment: 'auto',
    transferStatus: 'no',
    duplicateStatus: 'none',
    reviewStatus: 'not_required',
    importReviewStatus: 'trusted',
    financiallyActive: true,
    ...overrides
  };
}

function payslip(overrides = {}) {
  return {
    id: 'payslip',
    period: '2026-08',
    payDate: '2026-08-28',
    grossPay: 2500,
    totalDeductions: 450,
    netPay: 2050,
    ...overrides
  };
}
