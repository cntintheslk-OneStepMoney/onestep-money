import { performance } from 'node:perf_hooks';
import { AUTOMATION_TRIGGER, createAutomationTrigger, evaluateAutomationRules } from '../automation-engine.js';
import { buildCashFlowForecast } from '../cash-flow-forecast.js';
import { buildDebtRecommendation } from '../debt-recommendation-engine.js';
import {
  buildNextAction, calculateBudgetAnalysis, calculatePeriodSummary
} from '../finance-core.js';
import { financialSnapshot } from '../local-llm-service.js';
import { buildPaydayAllocationPlan } from '../payday-allocation.js';
import { buildStatementImportPlan } from '../statement-intelligence.js';
import {
  buildTransactionLedgerIndex, filterTransactionLedger, paginateTransactionLedger
} from '../transaction-ledger.js';
import { buildUnifiedFinancialProfile } from '../unified-financial-profile.js';

const sizes = [1_000, 5_000, 10_000];
const benchmarkNow = new Date('2026-08-11T12:00:00.000Z');
const automationTrigger = createAutomationTrigger(AUTOMATION_TRIGGER.TRANSACTION_CHANGE, {
  sourceType: 'transaction', sourceId: 'transaction-0', occurredAt: benchmarkNow.toISOString()
});
const results = sizes.map(runScenario);
console.log(JSON.stringify({ benchmark: 'fictional-large-dataset', unit: 'milliseconds', results }, null, 2));

function runScenario(size) {
  const state = fictionalState(size);
  const timings = {};
  let loadedState;
  timings.applicationDataLoad = measure(() => { loadedState = JSON.parse(JSON.stringify(state)); });
  timings.dashboardPeriodSummary = measure(() => calculatePeriodSummary(loadedState));
  let budgetAnalysis;
  timings.budgetRecalculation = measure(() => { budgetAnalysis = calculateBudgetAnalysis(loadedState); });
  let unifiedProfile;
  timings.unifiedFinancialProfile = measure(() => {
    unifiedProfile = buildUnifiedFinancialProfile(loadedState, { now: benchmarkNow });
  });
  timings.automationRuleEvaluation = measure(() => evaluateAutomationRules(loadedState, automationTrigger, []));
  let cashFlowForecast;
  timings.cashFlowForecast = measure(() => {
    cashFlowForecast = buildCashFlowForecast(loadedState, { now: benchmarkNow, profile: unifiedProfile });
  });
  timings.debtRecommendation = measure(() => buildDebtRecommendation(loadedState, {
    now: benchmarkNow, profile: unifiedProfile, forecast: cashFlowForecast
  }));
  timings.paydayAllocationPlan = measure(() => buildPaydayAllocationPlan(loadedState, {
    now: benchmarkNow, profile: unifiedProfile, forecast: cashFlowForecast
  }));
  let ledgerIndex;
  timings.allTimePaymentsPreparation = measure(() => {
    ledgerIndex = buildTransactionLedgerIndex(loadedState, budgetAnalysis);
    const allRows = filterTransactionLedger(ledgerIndex, { period: 'all' });
    paginateTransactionLedger(allRows, 1);
  });
  timings.fullDatasetSearch = measure(() => filterTransactionLedger(ledgerIndex, { period: 'all', search: `merchant ${size - 1}` }));
  timings.fullDatasetFilter = measure(() => filterTransactionLedger(ledgerIndex, { period: 'all', account: 'account-3', type: 'outgoing' }));
  timings.generatedAction = measure(() => buildNextAction(loadedState, new Date('2026-08-09T12:00:00.000Z')));
  timings.localGuideSnapshot = measure(() => financialSnapshot(loadedState));
  timings.statementDuplicateMatching = measure(() => buildStatementImportPlan(loadedState, fictionalStatementPreview(size)));
  timings.saveSerialisation = measure(() => JSON.stringify(loadedState));
  return { transactions: size, ...roundTimings(timings) };
}

function measure(action) {
  for (let index = 0; index < 2; index += 1) action();
  const startedAt = performance.now();
  for (let index = 0; index < 3; index += 1) action();
  return (performance.now() - startedAt) / 3;
}

function roundTimings(timings) {
  return Object.fromEntries(Object.entries(timings).map(([name, value]) => [name, Number(value.toFixed(2))]));
}

function fictionalState(size) {
  const accounts = Array.from({ length: 4 }, (_, index) => ({
    id: `account-${index}`, name: `Fictional account ${index + 1}`, institution: 'Fictional Bank',
    accountReference: `000${index}`, currentBalance: 500 + index, active: true
  }));
  const budgets = Array.from({ length: 8 }, (_, index) => ({
    id: `budget-${index}`, section: index < 4 ? 'Essentials' : 'Flexible', category: `Fictional category ${index + 1}`,
    planned: 100 + (index * 25), categories: [`category-${index}`], merchantTerms: []
  }));
  const transactions = Array.from({ length: size }, (_, index) => {
    const month = String((index % 36) + 1);
    const year = 2024 + Math.floor((Number(month) - 1) / 12);
    const monthNumber = ((Number(month) - 1) % 12) + 1;
    return {
      id: `transaction-${index}`, accountId: `account-${index % accounts.length}`,
      date: `${year}-${String(monthNumber).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
      budgetMonth: `${year}-${String(monthNumber).padStart(2, '0')}`,
      description: `Fictional merchant ${index}`, category: `category-${index % budgets.length}`,
      budgetCategoryId: `budget-${index % budgets.length}`, categorySource: 'generated',
      incoming: index % 20 === 0 ? 2_100 : 0, outgoing: index % 20 === 0 ? 0 : (index % 190) + 1,
      runningBalance: 1_000 - index, transferStatus: 'no', budgetTreatment: 'auto', cleared: true,
      duplicateStatus: index % 211 === 0 ? 'possible' : 'unique', reviewStatus: index % 211 === 0 ? 'pending' : 'accepted',
      source: 'generated-fictional-benchmark'
    };
  });
  return {
    meta: { revision: 1 },
    profile: { name: '', currency: 'GBP', dependableIncome: 2_100 },
    settings: { selectedMonth: 'all', extraDebtPayment: 50, emergencyBufferTarget: 500, emergencyBufferBalance: 100 },
    accounts,
    transactions,
    payslips: Array.from({ length: 36 }, (_, index) => ({ id: `payslip-${index}`, period: `202${4 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`, grossPay: 2_700, netPay: 2_100, deductions: [] })),
    taxDocuments: [], creditReports: [],
    debts: [{ id: 'debt-1', name: 'Fictional card', currentBalance: 500, creditLimit: 1_000, apr: 0.2, contractualPayment: 25, status: 'current', arrangementStatus: 'none', includeInPlan: true }],
    overdrafts: [{ id: 'overdraft-1', name: 'Fictional overdraft', accountId: 'account-0', currentBalance: 0, limit: 500, apr: 0.3, contractualPayment: 0, status: 'current', arrangementStatus: 'none', includeInPlan: true }],
    budgets,
    scheduledPayments: [], documents: Array.from({ length: 72 }, (_, index) => ({ id: `document-${index}`, kind: index % 3 === 0 ? 'statement' : index % 3 === 1 ? 'payslip' : 'credit-report', parseStatus: 'imported', importedAt: '2026-01-01T00:00:00.000Z', linkedRecordIds: [] })),
    tasks: [], checkIns: [], importBatches: []
  };
}

function fictionalStatementPreview(size) {
  return {
    kind: 'statement', accountHint: 'account-0', reconciled: true, warnings: [], rejected: [],
    records: Array.from({ length: 50 }, (_, index) => ({
      id: `incoming-${index}`, accountId: 'account-0', date: `2026-08-${String((index % 27) + 1).padStart(2, '0')}`,
      description: index === 0 ? `Fictional merchant ${size - 1}` : `New fictional merchant ${index}`,
      incoming: 0, outgoing: (index % 190) + 1, transferStatus: 'no', cleared: true
    })),
    summary: { currency: 'GBP' }, accountIdentity: { currency: 'GBP' }
  };
}
