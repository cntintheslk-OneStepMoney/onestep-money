import {
  AUTOMATION_CERTAINTY, AUTOMATION_EXECUTION_STATUS, AUTOMATION_REASON, AUTOMATION_SAFETY_CLASS,
  AUTOMATION_TRIGGER, createAutomationTrigger, evaluateAutomationRules, executeAutomationProposal
} from './automation-engine.js';
import {
  AUTOMATION_RULE_ACTION, AUTOMATION_RULE_CONDITION, AUTOMATION_RULE_TRIGGER,
  normaliseAutomationRuleCollection, normaliseAutomationRuleState, validateAutomationRule
} from './automation-rule-model.js';
import { synchroniseAutomationReviewSignals } from './automation-review-integration.js';
import { deriveRecurringPatterns, RECURRING_CONFIDENCE } from './recurring-finance.js';
import { resolveTransactionBudgetAssignment } from './transaction-categorisation.js';

const EXECUTION_TRIGGERS = new Set([AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE, AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY]);

export function previewStoredAutomationRules(state, options = {}) {
  const safeState = withNormalisedRules(state);
  const selectedRuleId = String(options.ruleId || '');
  const rules = safeState.automation.rules.filter((rule) => !selectedRuleId || rule.id === selectedRuleId);
  const contexts = evaluationContexts(safeState, options.now, true);
  const proposals = evaluateContexts(safeState, rules, contexts, true, options.now);
  const resolution = resolveRuleProposalConflicts(proposals);
  return {
    proposals: resolution.executable,
    conflicts: resolution.conflicts,
    duplicates: resolution.duplicates,
    matchCount: resolution.executable.length + resolution.conflicts.length + resolution.duplicates.length
  };
}

export async function runStoredAutomationRules(state, options = {}) {
  let current = withNormalisedRules(state);
  if (current.automation.enabled === false) {
    return { state: current, changed: false, reviewChanged: false, results: [], conflicts: [] };
  }
  if (!current.automation.rules.some((rule) => rule.enabled)) {
    const reviewSync = synchroniseAutomationReviewSignals(current, { conflicts: [], results: [] }, options.now);
    return { state: reviewSync.state, changed: false, reviewChanged: reviewSync.changed, results: [], conflicts: [] };
  }
  const contexts = evaluationContexts(current, options.now);
  const proposals = evaluateContexts(current, current.automation.rules, contexts, false, options.now);
  const resolution = resolveRuleProposalConflicts(proposals);
  const results = [
    ...resolution.duplicates.map((entry) => ({
      status: AUTOMATION_EXECUTION_STATUS.SKIPPED,
      reasonCode: 'compatible_duplicate_rule_action',
      ruleId: entry.ruleId,
      sourceType: entry.source.type,
      sourceId: entry.source.id,
      actionType: entry.action.type
    })),
    ...resolution.conflicts.map((entry) => ({
      status: AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED,
      reasonCode: 'rule_conflict',
      ruleId: entry.ruleIds.join(','),
      sourceType: entry.source.type,
      sourceId: entry.source.id,
      actionType: entry.actionType
    }))
  ];

  let changed = false;
  const handlers = ruleActionHandlers();
  for (const proposal of resolution.executable) {
    const executed = await executeAutomationProposal(current, proposal, handlers, {
      recoveryMode: options.recoveryMode || 'normal',
      now: options.now
    });
    current = executed.state;
    changed ||= executed.result.status === AUTOMATION_EXECUTION_STATUS.APPLIED;
    results.push({
      ...executed.result,
      ruleId: proposal.ruleId,
      sourceType: proposal.source.type,
      sourceId: proposal.source.id,
      actionType: proposal.action.type
    });
  }
  const reviewSync = synchroniseAutomationReviewSignals(current, { conflicts: resolution.conflicts, results }, options.now);
  current = reviewSync.state;
  return { state: current, changed, reviewChanged: reviewSync.changed, results, conflicts: resolution.conflicts };
}

export function ruleActionHandlers() {
  return {
    assign_transaction_budget: ({ state, proposal }) => {
      const transaction = transactionById(state, proposal.source.id);
      const budget = (state.budgets || []).find((item) => String(item.id) === String(proposal.action.payload?.budgetId || ''));
      if (!transaction || !budget) return { state };
      if (transaction.categorySource === 'manual') return { state };
      transaction.budgetCategoryId = budget.id;
      transaction.category = budget.category;
      transaction.categorySource = 'automation';
      transaction.automationRuleId = proposal.ruleId;
      return { state };
    },
    add_local_tag: ({ state, proposal }) => {
      const transaction = transactionById(state, proposal.source.id);
      if (!transaction) return { state };
      const value = String(proposal.action.payload?.tag || '').trim().slice(0, 80);
      if (!value) return { state };
      transaction.automationTags = [...new Set([...(Array.isArray(transaction.automationTags) ? transaction.automationTags : []), value])].slice(-20);
      return { state };
    },
    create_local_reminder: ({ state, proposal }) => {
      const title = String(proposal.action.payload?.title || '').trim().slice(0, 160);
      if (!title) return { state };
      state.tasks = Array.isArray(state.tasks) ? state.tasks : [];
      const id = `automation_${proposal.executionId.slice(0, 32)}`;
      const existing = state.tasks.find((task) => String(task.id) === id);
      const timestamp = new Date().toISOString();
      const task = {
        id,
        title,
        detail: String(proposal.action.payload?.detail || 'Created by a local automation rule.').slice(0, 240),
        priority: 'normal',
        actionView: 'today',
        source: 'automation_rule',
        automationRuleId: proposal.ruleId,
        automationExecutionId: proposal.executionId,
        createdAt: existing?.createdAt || timestamp,
        updatedAt: timestamp,
        completedAt: existing?.completedAt || null
      };
      if (existing) Object.assign(existing, task);
      else state.tasks.push(task);
      return { state };
    }
  };
}

export function resolveRuleProposalConflicts(proposals = []) {
  const ordered = [...proposals].sort((left, right) => left.executionId.localeCompare(right.executionId));
  const executable = [];
  const duplicates = [];
  const conflicts = [];
  const categoryGroups = new Map();

  for (const proposal of ordered) {
    if (proposal.action.type !== 'assign_transaction_budget') {
      executable.push(proposal);
      continue;
    }
    const key = `${proposal.source.type}:${proposal.source.id}:budget-category`;
    if (!categoryGroups.has(key)) categoryGroups.set(key, []);
    categoryGroups.get(key).push(proposal);
  }

  for (const rows of categoryGroups.values()) {
    const byValue = new Map();
    for (const row of rows) {
      const value = String(row.action.payload?.budgetId || '');
      if (!byValue.has(value)) byValue.set(value, []);
      byValue.get(value).push(row);
    }
    if (byValue.size > 1) {
      conflicts.push({
        source: rows[0].source,
        ruleIds: rows.map((row) => row.ruleId).sort(),
        actionType: 'assign_transaction_budget',
        values: [...byValue.keys()].sort()
      });
      continue;
    }
    const compatible = [...rows].sort((left, right) => left.ruleId.localeCompare(right.ruleId));
    executable.push(compatible[0]);
    duplicates.push(...compatible.slice(1));
  }

  executable.sort((left, right) => left.executionId.localeCompare(right.executionId));
  return { executable, duplicates, conflicts };
}

function evaluateContexts(state, rules, contexts, includeDisabled, now) {
  const proposals = [];
  const runtimeRules = rules
    .filter((rule) => includeDisabled || rule.enabled)
    .map((rule) => compileStoredRule(rule, now))
    .filter(Boolean);
  for (const context of contexts) {
    const trigger = createAutomationTrigger(context.triggerType, {
      sourceType: context.sourceType,
      sourceId: context.sourceId,
      occurredAt: validDate(now).toISOString()
    });
    proposals.push(...evaluateAutomationRules(state, trigger, runtimeRules));
  }
  return proposals;
}

function compileStoredRule(rule, now) {
  const checked = validateAutomationRule(rule);
  if (!checked.valid || !EXECUTION_TRIGGERS.has(checked.rule.trigger)) return null;
  const stored = checked.rule;
  return {
    id: stored.id,
    triggers: [stored.trigger, AUTOMATION_TRIGGER.EXPLICIT_TEST],
    conditions: stored.conditions.map((condition) => ({
      id: condition.id,
      test: ({ state, trigger }) => conditionMatches(condition, state, trigger, now)
    })),
    propose: ({ state, trigger }) => proposalForRule(stored, state, trigger, now)
  };
}

function proposalForRule(rule, state, trigger, now) {
  const source = { type: trigger.sourceType, id: trigger.sourceId };
  const manualCategory = rule.action.type === AUTOMATION_RULE_ACTION.ASSIGN_BUDGET
    && transactionById(state, trigger.sourceId)?.categorySource === 'manual';
  const base = {
    source,
    sourceStatus: 'ready',
    safetyClass: manualCategory ? AUTOMATION_SAFETY_CLASS.BLOCKED : AUTOMATION_SAFETY_CLASS.SAFE_AUTOMATIC,
    certainty: AUTOMATION_CERTAINTY.CERTAIN,
    reasonCode: manualCategory ? AUTOMATION_REASON.MANUAL_OVERRIDE : 'user_defined_local_rule',
    explanation: rule.explanation
  };

  if (rule.action.type === AUTOMATION_RULE_ACTION.ASSIGN_BUDGET) {
    const transaction = transactionById(state, trigger.sourceId);
    const budget = (state.budgets || []).find((item) => String(item.id) === String(rule.action.value));
    if (!transaction || !budget) return { ...base, sourceStatus: 'missing' };
    return {
      ...base,
      action: {
        type: 'assign_transaction_budget',
        key: 'budget-category',
        risk: 'housekeeping',
        identityContext: { budgetId: budget.id, ruleUpdatedAt: rule.updatedAt },
        payload: { budgetId: budget.id }
      }
    };
  }

  if (rule.action.type === AUTOMATION_RULE_ACTION.ADD_TAG) {
    if (!transactionById(state, trigger.sourceId)) return { ...base, sourceStatus: 'missing' };
    return {
      ...base,
      action: {
        type: 'add_local_tag',
        key: `tag:${normalise(rule.action.value)}`,
        risk: 'housekeeping',
        identityContext: { tag: normalise(rule.action.value), ruleUpdatedAt: rule.updatedAt },
        payload: { tag: rule.action.value }
      }
    };
  }

  const pattern = recurringPatternForTrigger(state, trigger);
  const dueDate = pattern?.nextExpected?.date || '';
  return {
    ...base,
    action: {
      type: 'create_local_reminder',
      key: 'local-reminder',
      risk: 'housekeeping',
      identityContext: { title: rule.action.value, dueDate, ruleUpdatedAt: rule.updatedAt },
      payload: {
        title: rule.action.value,
        detail: pattern ? `${pattern.label} · expected ${dueDate}` : rule.explanation
      }
    }
  };
}

function conditionMatches(condition, state, trigger, now) {
  const transaction = transactionById(state, trigger.sourceId);
  const pattern = recurringPatternForTrigger(state, trigger);

  if (condition.field === AUTOMATION_RULE_CONDITION.MERCHANT) {
    if (!transaction) return false;
    const merchant = normalise(transaction.merchantName || transaction.payee || transaction.description || transaction.userDescription);
    return textMatches(merchant, condition);
  }
  if (condition.field === AUTOMATION_RULE_CONDITION.PURPOSE) {
    if (!transaction) return false;
    const assignment = resolveTransactionBudgetAssignment(transaction, { budgets: state.budgets || [], transactions: state.transactions || [] });
    const values = [
      assignment.budget?.id,
      assignment.budget?.category,
      transaction.transactionPurpose,
      transaction.category,
      transaction.budgetCategoryId
    ].map(normalise).filter(Boolean);
    return values.some((value) => textMatches(value, condition));
  }
  if (condition.field === AUTOMATION_RULE_CONDITION.ACCOUNT) return Boolean(transaction) && String(transaction.accountId || '') === String(condition.value);
  if (condition.field === AUTOMATION_RULE_CONDITION.DIRECTION) {
    if (!transaction) return false;
    const direction = Number(transaction.incoming || 0) > 0 ? 'incoming' : Number(transaction.outgoing || 0) > 0 ? 'outgoing' : '';
    return direction === condition.value;
  }
  if (condition.field === AUTOMATION_RULE_CONDITION.AMOUNT) {
    if (!transaction) return false;
    const amount = Number(transaction.incoming || 0) > 0 ? Number(transaction.incoming) : Number(transaction.outgoing || 0);
    return rangeMatches(amount, condition);
  }
  if (condition.field === AUTOMATION_RULE_CONDITION.RECURRING_CADENCE) return pattern?.cadence === condition.value;
  if (condition.field === AUTOMATION_RULE_CONDITION.REVIEW_STATE) {
    if (!transaction) return false;
    const stateValue = transaction.reviewStatus || transaction.importReviewStatus || 'none';
    return stateValue === condition.value;
  }
  if (condition.field === AUTOMATION_RULE_CONDITION.DAYS_UNTIL_DUE) {
    if (!pattern?.nextExpected?.date) return false;
    return rangeMatches(daysBetween(localDateKey(validDate(now)), pattern.nextExpected.date), condition);
  }
  return false;
}

function evaluationContexts(state, now, includeDisabled = false) {
  const contexts = [];
  const hasTransactionRules = state.automation.rules.some((rule) => (includeDisabled || rule.enabled) && rule.trigger === AUTOMATION_RULE_TRIGGER.TRANSACTION_CHANGE);
  if (hasTransactionRules) {
    for (const transaction of state.transactions || []) {
      if (!transaction?.id || transaction.deletedAt) continue;
      contexts.push({ triggerType: AUTOMATION_TRIGGER.TRANSACTION_CHANGE, sourceType: 'transaction', sourceId: String(transaction.id) });
    }
  }
  const hasDateRules = state.automation.rules.some((rule) => (includeDisabled || rule.enabled) && rule.trigger === AUTOMATION_RULE_TRIGGER.DATE_BOUNDARY);
  if (hasDateRules) {
    for (const pattern of deriveRecurringPatterns(state, { includeRejected: false })) {
      if (pattern.confidence !== RECURRING_CONFIDENCE.CONFIRMED || !pattern.nextExpected?.date) continue;
      contexts.push({ triggerType: AUTOMATION_TRIGGER.DATE_BOUNDARY, sourceType: 'recurring_pattern', sourceId: pattern.id });
    }
  }
  return contexts;
}

function recurringPatternForTrigger(state, trigger) {
  const patterns = deriveRecurringPatterns(state, { includeRejected: false });
  if (trigger.sourceType === 'recurring_pattern') return patterns.find((pattern) => pattern.id === trigger.sourceId) || null;
  if (trigger.sourceType === 'transaction') return patterns.find((pattern) => pattern.sourceTransactionIds.includes(String(trigger.sourceId))) || null;
  return null;
}

function withNormalisedRules(state) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationRuleState(next.automation);
  next.automation.rules = normaliseAutomationRuleCollection(next.automation.rules);
  return next;
}

function transactionById(state, id) {
  return (state.transactions || []).find((transaction) => String(transaction.id) === String(id)) || null;
}

function textMatches(value, condition) {
  const expected = normalise(condition.value);
  if (!expected) return false;
  return condition.operator === 'contains' ? value.includes(expected) : value === expected;
}

function rangeMatches(value, condition) {
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const first = Number(condition.value);
  if (!Number.isFinite(first)) return false;
  if (condition.operator === 'at_least') return number >= first;
  if (condition.operator === 'at_most') return number <= first;
  if (condition.operator === 'between') {
    const second = Number(condition.value2);
    return Number.isFinite(second) && number >= first && number <= second;
  }
  return number === first;
}

function daysBetween(left, right) {
  const [ly, lm, ld] = String(left).split('-').map(Number);
  const [ry, rm, rd] = String(right).split('-').map(Number);
  return Math.round((Date.UTC(ry, rm - 1, rd) - Date.UTC(ly, lm - 1, ld)) / 86_400_000);
}
function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function normalise(value) { return String(value || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function validDate(value) {
  const candidate = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  return Number.isNaN(candidate.getTime()) ? new Date() : candidate;
}