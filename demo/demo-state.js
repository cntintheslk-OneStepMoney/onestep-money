import { buildFinancialReport } from '../financial-reporting.js';
import { debtSafetyAssessment } from '../finance-core.js';
import { normaliseAppearanceSettings } from '../presentation-settings.js';
import { prioritySnapshot } from '../next-move-priority.js';
import {
  reviewInboxSummary, resolveReviewItem, snoozeReviewItem, synchroniseReviewItems
} from '../review-lifecycle.js';
import { DEMO_BASE_STATE, DEMO_CLOCK, DEMO_IMPORT_TRANSACTIONS } from './demo-data.js';

export const DEMO_STORAGE_KEY = 'onestep-browser-demo-v1';
const ALLOWED_COLLECTIONS = ['accounts', 'transactions', 'payslips', 'debts', 'overdrafts', 'budgets', 'scheduledPayments', 'tasks', 'reviewItems'];

export function demoNow() {
  return new Date(DEMO_CLOCK);
}

export function createCanonicalDemoState() {
  const state = structuredClone(DEMO_BASE_STATE);
  synchroniseReviewItems(state, demoNow());
  const snoozed = state.reviewItems.find((item) => item.sourceId === 'task-insurance');
  if (snoozed) snoozeReviewItem(state, snoozed.id, 'next_week', demoNow());
  return state;
}

export function loadDemoState(storage = globalThis.sessionStorage) {
  try {
    const raw = storage?.getItem?.(DEMO_STORAGE_KEY);
    if (!raw) return { state: createCanonicalDemoState(), recovered: false };
    const state = JSON.parse(raw);
    if (!validDemoState(state)) throw new TypeError('Invalid demo state');
    state.settings.appearance = normaliseAppearanceSettings(state.settings.appearance);
    synchroniseReviewItems(state, demoNow());
    return { state, recovered: false };
  } catch {
    const state = createCanonicalDemoState();
    writeExactDemoState(state, storage);
    return { state, recovered: true };
  }
}

export function saveDemoState(state, storage = globalThis.sessionStorage) {
  if (!validDemoState(state)) throw new TypeError('Only valid fictional demo state can be saved.');
  state.meta.updatedAt = DEMO_CLOCK;
  state.meta.revision = Number(state.meta.revision || 0) + 1;
  storage?.setItem?.(DEMO_STORAGE_KEY, JSON.stringify(state));
  return state;
}

export function resetDemoState(storage = globalThis.sessionStorage) {
  const state = createCanonicalDemoState();
  storage?.removeItem?.(DEMO_STORAGE_KEY);
  writeExactDemoState(state, storage);
  return state;
}

export function deriveDemoView(state) {
  synchroniseReviewItems(state, demoNow());
  const safety = debtSafetyAssessment(state);
  return {
    report: buildFinancialReport(state, state.settings.selectedMonth, demoNow()),
    safety,
    priority: prioritySnapshot(state, demoNow(), { safetyAssessment: safety }),
    review: reviewInboxSummary(state, demoNow())
  };
}

export function categoriseDemoTransaction(state, transactionId, budgetId) {
  const transaction = state.transactions.find((item) => item.id === transactionId);
  const budget = state.budgets.find((item) => item.id === budgetId);
  if (!transaction || !budget || Number(transaction.outgoing || 0) <= 0) throw new Error('Choose an available outgoing payment and budget category.');
  transaction.category = budget.category;
  transaction.budgetCategoryId = budget.id;
  transaction.categorySource = 'manual';
  synchroniseReviewItems(state, demoNow());
  return state;
}

export function actOnDemoReviewItem(state, itemId, action = 'complete') {
  synchroniseReviewItems(state, demoNow());
  const item = state.reviewItems.find((entry) => entry.id === itemId && entry.status !== 'resolved');
  if (!item) throw new Error('That demo review item is no longer active.');
  if (item.type === 'uncategorised_payment') return categoriseDemoTransaction(state, item.sourceId, 'budget-eating');
  if (item.type === 'possible_duplicate') return resolveReviewItem(state, item.id, action === 'both_genuine' ? 'both_genuine' : 'duplicate', demoNow());
  if (item.type === 'financial_action') {
    const collection = item.sourceType === 'overdraft' ? state.overdrafts : state.debts;
    const account = collection.find((entry) => String(entry.id) === item.sourceId);
    if (!account) throw new Error('That fictional account is no longer available.');
    account.arrangementStatus = 'confirmed';
    account.arrangementConfirmed = true;
    account.arrangementPayment = 25;
    return synchroniseReviewItems(state, demoNow());
  }
  if (item.type === 'generated_action') {
    const task = state.tasks.find((entry) => String(entry.id) === item.sourceId);
    if (task) task.completedAt = DEMO_CLOCK;
    return synchroniseReviewItems(state, demoNow());
  }
  return state;
}

export function snoozeDemoReviewItem(state, itemId) {
  return snoozeReviewItem(state, itemId, 'next_week', demoNow());
}

export function wakeDemoReviewItem(state, itemId) {
  synchroniseReviewItems(state, demoNow());
  const item = state.reviewItems.find((entry) => entry.id === itemId && entry.status === 'snoozed');
  if (!item) throw new Error('That snoozed demo item is no longer available.');
  item.status = 'needs_attention';
  item.snoozedUntil = null;
  item.updatedAt = DEMO_CLOCK;
  return synchroniseReviewItems(state, demoNow());
}

export function applySimulatedImport(state) {
  if (state.settings.demo.importApplied) return state;
  state.transactions.push(...structuredClone(DEMO_IMPORT_TRANSACTIONS));
  state.settings.demo.importApplied = true;
  synchroniseReviewItems(state, demoNow());
  return state;
}

export function setDemoTheme(state, theme) {
  state.settings.appearance = normaliseAppearanceSettings({ theme });
  return state;
}

export function validDemoState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false;
  if (state.meta?.demo !== true || state.meta?.demoVersion !== 1) return false;
  if (!state.settings || typeof state.settings !== 'object' || !state.settings.demo) return false;
  return ALLOWED_COLLECTIONS.every((field) => Array.isArray(state[field]));
}

function writeExactDemoState(state, storage) {
  storage?.setItem?.(DEMO_STORAGE_KEY, JSON.stringify(state));
}
