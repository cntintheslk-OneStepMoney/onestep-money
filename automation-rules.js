import { AUTOMATION_EXECUTION_STATUS, AUTOMATION_REASON, executeAutomationProposal } from './automation-engine.js';
import {
  AUTOMATION_RULE_ACTIVATION, normaliseAutomationRuleCollection, normaliseAutomationRuleState, validateAutomationRule
} from './automation-rule-model.js';
import { synchroniseAutomationReviewSignals } from './automation-review-integration.js';
import {
  evaluationContexts, evaluateContexts, resolveRuleProposalConflicts, ruleActionHandlers, validDate
} from './automation-rules-core.js';

const MAX_PREVIEW_ITEMS = 100;

export async function previewStoredAutomationRules(state, options = {}) {
  const safeState = withNormalisedRules(state);
  const now = validDate(options.now);
  const transientRule = options.rule ? previewRuleInput(options.rule, now) : null;
  const selectedRuleId = transientRule?.id || String(options.ruleId || '');
  const selectedRules = transientRule
    ? [transientRule]
    : safeState.automation.rules.filter((rule) => !selectedRuleId || rule.id === selectedRuleId);

  if (selectedRuleId && !selectedRules.length) throw new Error('That automation rule is no longer available.');
  if (!selectedRules.length) return emptyPreview();

  const contexts = evaluationContexts(safeState, now, true, selectedRules);
  const selectedProposals = evaluateContexts(safeState, selectedRules, contexts, true, now, { includeExisting: true });
  const selectedRuleIds = new Set(selectedRules.map((rule) => rule.id));
  const peerRules = selectedRuleId
    ? safeState.automation.rules.filter((rule) => rule.enabled && !selectedRuleIds.has(rule.id))
    : [];
  const peerProposals = peerRules.length
    ? evaluateContexts(safeState, peerRules, contexts, false, now, { includeExisting: true })
    : [];
  const resolution = resolveRuleProposalConflicts([...selectedProposals, ...peerProposals]);
  const selectedExecutable = resolution.executable.filter((proposal) => selectedRuleIds.has(proposal.ruleId));
  const selectedDuplicates = resolution.duplicates.filter((proposal) => selectedRuleIds.has(proposal.ruleId));
  const selectedConflicts = resolution.conflicts.filter((conflict) => conflict.ruleIds.some((ruleId) => selectedRuleIds.has(ruleId)));
  const results = [];

  for (const proposal of selectedExecutable) {
    const preview = await executeAutomationProposal(safeState, proposal, ruleActionHandlers(), {
      recoveryMode: normalisePreviewRecoveryMode(options.recoveryMode),
      now,
      previewOnly: true
    });
    results.push({ proposal, result: preview.result });
  }

  const matchedSources = new Set(selectedProposals.map((proposal) => sourceKey(proposal.source)));
  const proposalItems = results.map(({ proposal, result }) => previewProposalItem(safeState, proposal, result));
  const duplicateItems = selectedDuplicates.map((proposal) => previewDuplicateItem(safeState, proposal));
  const conflictItems = selectedConflicts.map((conflict) => previewConflictItem(safeState, conflict));
  const allItems = [...conflictItems, ...proposalItems, ...duplicateItems]
    .sort((left, right) => previewStatusRank(left.status) - previewStatusRank(right.status)
      || left.sourceType.localeCompare(right.sourceType) || left.sourceId.localeCompare(right.sourceId)
      || left.ruleId.localeCompare(right.ruleId));
  const items = allItems.slice(0, MAX_PREVIEW_ITEMS);
  const wouldApplyCount = proposalItems.filter((item) => item.status === 'would_apply').length;
  const reviewRequiredCount = proposalItems.filter((item) => item.status === AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED).length + selectedConflicts.length;
  const blockedCount = proposalItems.filter((item) => item.status === AUTOMATION_EXECUTION_STATUS.BLOCKED).length;
  const alreadyAppliedCount = proposalItems.filter((item) => item.status === AUTOMATION_EXECUTION_STATUS.ALREADY_APPLIED).length;

  return {
    previewMode: 'dry_run',
    nothingChanged: true,
    unchangedMessage: 'Preview only — nothing has been changed.',
    evaluatedCount: contexts.length,
    matchedRecordCount: matchedSources.size,
    matchCount: matchedSources.size,
    proposedActionCount: selectedProposals.length,
    notMatchedCount: Math.max(0, contexts.length - matchedSources.size),
    wouldApplyCount,
    reviewRequiredCount,
    conflictCount: selectedConflicts.length,
    duplicateCount: selectedDuplicates.length,
    blockedCount,
    alreadyAppliedCount,
    proposals: selectedExecutable.slice(0, MAX_PREVIEW_ITEMS),
    conflicts: selectedConflicts.slice(0, MAX_PREVIEW_ITEMS),
    duplicates: selectedDuplicates.slice(0, MAX_PREVIEW_ITEMS),
    items,
    totalDetailCount: allItems.length,
    truncated: allItems.length > items.length,
    detailLimit: MAX_PREVIEW_ITEMS,
    existingImpact: {
      evaluatedCount: contexts.length,
      matchedRecordCount: matchedSources.size,
      proposedActionCount: selectedProposals.length,
      message: matchedSources.size
        ? `${matchedSources.size} existing record${matchedSources.size === 1 ? '' : 's'} would match this rule now.`
        : 'No existing records match this rule now.'
    },
    futureImpact: {
      activationMode: AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY,
      message: 'After activation, the rule applies only to future matching activity. Existing records shown in this preview are not changed automatically.'
    },
    retrospective: {
      supported: false,
      automatic: false,
      requiresSeparateConfirmation: true,
      message: 'Retrospective apply is not available in this release. Existing records are never rewritten automatically when a rule is enabled.'
    }
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
  const proposals = evaluateContexts(current, current.automation.rules, contexts, false, options.now, { includeExisting: false });
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

function previewRuleInput(input, now) {
  const candidate = structuredClone(input || {});
  if (!candidate.id) candidate.id = 'rule_preview_draft';
  candidate.updatedAt = validDate(now).toISOString();
  candidate.enabled = false;
  candidate.activationMode = AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY;
  candidate.activatedAt = null;
  const checked = validateAutomationRule(candidate);
  if (!checked.valid) {
    const error = new Error(checked.errors.join(' '));
    error.code = 'AUTOMATION_RULE_INVALID';
    error.validationErrors = checked.errors;
    throw error;
  }
  return checked.rule;
}

function previewProposalItem(state, proposal, result) {
  const status = result.reasonCode === AUTOMATION_REASON.PREVIEW_ONLY ? 'would_apply' : result.status;
  return {
    kind: 'proposal',
    status,
    reasonCode: result.reasonCode,
    explanation: result.explanation,
    requiresReview: result.status === AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED,
    ruleId: proposal.ruleId,
    sourceType: proposal.source.type,
    sourceId: proposal.source.id,
    actionType: proposal.action.type,
    actionLabel: previewActionLabel(state, proposal)
  };
}

function previewDuplicateItem(state, proposal) {
  return {
    kind: 'duplicate',
    status: AUTOMATION_EXECUTION_STATUS.SKIPPED,
    reasonCode: 'compatible_duplicate_rule_action',
    explanation: 'Another matching rule proposes the same action, so OneStep would apply that action only once.',
    requiresReview: false,
    ruleId: proposal.ruleId,
    sourceType: proposal.source.type,
    sourceId: proposal.source.id,
    actionType: proposal.action.type,
    actionLabel: previewActionLabel(state, proposal)
  };
}

function previewConflictItem(state, conflict) {
  const labels = (conflict.values || []).map((value) => budgetLabel(state, value)).filter(Boolean);
  return {
    kind: 'conflict',
    status: 'conflict',
    reasonCode: 'rule_conflict',
    explanation: 'Matching rules disagree, so OneStep would leave this item unchanged and require review.',
    requiresReview: true,
    ruleId: conflict.ruleIds.join(','),
    ruleIds: [...conflict.ruleIds],
    sourceType: conflict.source.type,
    sourceId: conflict.source.id,
    actionType: conflict.actionType,
    actionLabel: labels.length ? `Conflicting budget/category choices: ${labels.join(' / ')}` : 'Conflicting rule actions'
  };
}

function previewActionLabel(state, proposal) {
  if (proposal.action.type === 'assign_transaction_budget') return `Assign budget/category “${budgetLabel(state, proposal.action.payload?.budgetId)}”`;
  if (proposal.action.type === 'add_local_tag') return `Add local tag “${String(proposal.action.payload?.tag || '')}”`;
  if (proposal.action.type === 'create_local_reminder') return `Create local reminder “${String(proposal.action.payload?.title || '')}”`;
  return proposal.action.type.replace(/_/g, ' ');
}

function budgetLabel(state, budgetId) {
  const budget = (state.budgets || []).find((item) => String(item.id) === String(budgetId || ''));
  return String(budget?.category || budgetId || 'Unknown');
}

function normalisePreviewRecoveryMode(value) {
  return ['normal', 'recovery_required', 'resolution_in_progress', 'backup_in_progress', 'restore_in_progress'].includes(value)
    ? value
    : 'normal';
}

function emptyPreview() {
  return {
    previewMode: 'dry_run', nothingChanged: true, unchangedMessage: 'Preview only — nothing has been changed.',
    evaluatedCount: 0, matchedRecordCount: 0, matchCount: 0, proposedActionCount: 0, notMatchedCount: 0,
    wouldApplyCount: 0, reviewRequiredCount: 0, conflictCount: 0, duplicateCount: 0, blockedCount: 0,
    alreadyAppliedCount: 0, proposals: [], conflicts: [], duplicates: [], items: [], totalDetailCount: 0,
    truncated: false, detailLimit: MAX_PREVIEW_ITEMS,
    existingImpact: { evaluatedCount: 0, matchedRecordCount: 0, proposedActionCount: 0, message: 'No existing records match this rule now.' },
    futureImpact: { activationMode: AUTOMATION_RULE_ACTIVATION.FUTURE_ONLY, message: 'After activation, the rule applies only to future matching activity. Existing records shown in this preview are not changed automatically.' },
    retrospective: { supported: false, automatic: false, requiresSeparateConfirmation: true, message: 'Retrospective apply is not available in this release. Existing records are never rewritten automatically when a rule is enabled.' }
  };
}

function previewStatusRank(status) {
  return status === 'conflict' ? 0 : status === AUTOMATION_EXECUTION_STATUS.REVIEW_REQUIRED ? 1
    : status === AUTOMATION_EXECUTION_STATUS.BLOCKED ? 2 : status === 'would_apply' ? 3 : 4;
}

function sourceKey(source) { return `${source?.type || 'state'}:${source?.id || 'global'}`; }
function withNormalisedRules(state) {
  const next = structuredClone(state || {});
  next.automation = normaliseAutomationRuleState(next.automation);
  next.automation.rules = normaliseAutomationRuleCollection(next.automation.rules);
  return next;
}

