import { normaliseAutomationState } from './automation-state.js';
import {
  AUTOMATION_HISTORY_FILTER,
  automationHistoryEntries,
  automationHistoryPresentation
} from './automation-history.js';
import { automationReviewSources } from './automation-review-integration.js';
import { actionLabel, explainRule } from './automation-rule-model.js';
import { FINANCIAL_REMINDER_STATUS, listFinancialReminderSources } from './financial-reminders.js';
import { deriveRecurringPatterns, RECURRING_CONFIDENCE } from './recurring-finance.js';

const RECENT_ACTIVITY_LIMIT = 5;
const RECENT_SUMMARY_LIMIT = 20;
const MANAGEMENT_LIST_LIMIT = 6;

export function buildAutomationDashboardModel(state = {}, now = new Date()) {
  const automation = normaliseAutomationState(state?.automation);
  const sourceState = { ...state, automation };
  const historyEntries = automationHistoryEntries(sourceState, AUTOMATION_HISTORY_FILTER.ALL);
  const latestByRule = latestHistoryByRule(historyEntries);
  const rules = automation.rules.map((rule) => ruleSummary(rule, latestByRule.get(rule.id)));
  const configuredReminderIds = new Set(automation.reminders.map((reminder) => reminder.id));
  const reminders = listFinancialReminderSources(sourceState, now)
    .filter((reminder) => configuredReminderIds.has(reminder.configId)
      && reminder.enabled
      && reminder.status !== FINANCIAL_REMINDER_STATUS.RESOLVED)
    .slice(0, MANAGEMENT_LIST_LIMIT)
    .map(reminderSummary);
  const recurring = deriveRecurringPatterns(sourceState, { includeRejected: false })
    .filter((pattern) => [RECURRING_CONFIDENCE.CONFIRMED, RECURRING_CONFIDENCE.LIKELY].includes(pattern.confidence))
    .slice(0, MANAGEMENT_LIST_LIMIT)
    .map(recurringSummary);
  const reviewSources = automationReviewSources(sourceState, now);
  const recentActivity = historyEntries.slice(0, RECENT_ACTIVITY_LIMIT)
    .map((entry) => ({ entry, presentation: automationHistoryPresentation(sourceState, entry) }))
    .filter(({ presentation }) => Boolean(presentation))
    .map(({ entry, presentation }) => ({
      id: entry.id || presentation.id,
      status: presentation.statusLabel,
      summary: presentation.summary,
      ruleLabel: presentation.ruleLabel,
      timestamp: presentation.timestamp,
      undoAvailable: Boolean(presentation.undo?.available)
    }));

  return {
    enabled: automation.enabled,
    enabledRuleCount: rules.filter((rule) => rule.enabled).length,
    totalRuleCount: rules.length,
    reviewCount: reviewSources.length,
    configuredReminderCount: configuredReminderIds.size,
    recurringCount: recurring.length,
    rules,
    reminders,
    recurring,
    recentActivity,
    recentTotals: recentActivityTotals(historyEntries.slice(0, RECENT_SUMMARY_LIMIT))
  };
}

export function setAutomationEnabledState(state = {}, enabled) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationState(next.automation);
  next.automation.enabled = Boolean(enabled);
  return next;
}

function latestHistoryByRule(entries) {
  const output = new Map();
  for (const entry of entries) {
    for (const ruleId of entry.ruleIds || []) {
      if (!output.has(ruleId)) output.set(ruleId, entry);
    }
  }
  return output;
}

function ruleSummary(rule, latest) {
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    summary: explainRule(rule),
    action: actionLabel(rule.action) || 'local action',
    lastRun: latest ? {
      status: historyStatusLabel(latest.result),
      timestamp: latest.timestamp
    } : null
  };
}

function recurringSummary(pattern) {
  return {
    id: pattern.id,
    label: pattern.label,
    purpose: pattern.purpose,
    direction: pattern.direction,
    cadence: pattern.cadence,
    confidence: pattern.confidence,
    nextExpected: pattern.nextExpected?.date || null
  };
}

function reminderSummary(reminder) {
  return {
    id: reminder.configId,
    sourceType: reminder.sourceType,
    sourceId: reminder.sourceId,
    title: reminder.title,
    dueDate: reminder.dueDate,
    daysBefore: reminder.daysBefore,
    status: reminder.status,
    dismissedToday: reminder.dismissedToday
  };
}

function recentActivityTotals(entries) {
  const totals = { applied: 0, needsReview: 0, skipped: 0, blocked: 0, undone: 0 };
  for (const entry of entries) {
    if (entry.result === 'applied') totals.applied += 1;
    else if (entry.result === 'needs_review') totals.needsReview += 1;
    else if (entry.result === 'skipped') totals.skipped += 1;
    else if (entry.result === 'blocked') totals.blocked += 1;
    else if (entry.result === 'undone') totals.undone += 1;
  }
  return totals;
}

function historyStatusLabel(result) {
  return ({
    applied: 'Applied',
    needs_review: 'Needs review',
    skipped: 'Skipped',
    blocked: 'Blocked',
    undone: 'Undone'
  })[result] || 'Recorded';
}
