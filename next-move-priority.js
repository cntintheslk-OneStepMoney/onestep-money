import {
  activeReviewItems, groupReviewItems, reviewItemPresentation, synchroniseReviewItems
} from './review-lifecycle.js';

export const PRIORITY_BAND = Object.freeze({
  CRITICAL: 'critical',
  IMPORTANT: 'important',
  NORMAL: 'normal',
  LOW: 'low'
});

export const PRIORITY_DIAGNOSTIC_CODES = Object.freeze({
  EVALUATION_FAILED: 'PRIORITY_EVALUATION_FAILED',
  NEXT_MOVE_UNAVAILABLE: 'NEXT_MOVE_UNAVAILABLE',
  CONSOLIDATION_INVALID: 'ACTION_CONSOLIDATION_INVALID'
});

const BAND_RANK = Object.freeze({ critical: 0, important: 1, normal: 2, low: 3 });

export function prioritySnapshot(state, now = new Date(), options = {}) {
  synchroniseReviewItems(state, now);
  const context = priorityContext(state, now, options.safetyAssessment);
  const preferredItemId = String(options.preferredItemId || '');
  const candidates = activeReviewItems(state, now)
    .map((item) => evaluateWithContext(item, state, context))
    .sort((left, right) => compareEvaluations(left, right, preferredItemId));
  const nextMove = candidates.find(worthSurfacingToday) || null;
  const today = nextMove
    ? [nextMove, ...candidates.filter((entry) => entry.item.id !== nextMove.item.id && worthSurfacingToday(entry)).slice(0, 3)]
    : [];
  const supporting = today.slice(1);
  const lowPriorityRemaining = candidates.filter((entry) => entry.priorityBand === PRIORITY_BAND.LOW).length;

  return {
    nextMove,
    today,
    supporting,
    candidates,
    doneForToday: nextMove === null,
    unresolvedCount: candidates.length,
    todayCount: today.length,
    lowPriorityRemaining
  };
}

export function evaluateReviewItem(item, state, now = new Date(), options = {}) {
  return evaluateWithContext(item, state, priorityContext(state, now, options.safetyAssessment));
}

export function prioritisedReviewGroups(state, now = new Date(), options = {}) {
  synchroniseReviewItems(state, now);
  const context = priorityContext(state, now, options.safetyAssessment);
  return groupReviewItems(activeReviewItems(state, now), state)
    .map((group) => {
      const evaluations = group.items.map((item) => evaluateWithContext(item, state, context)).sort(compareEvaluations);
      const leading = evaluations[0];
      return {
        ...group,
        priorityBand: leading.priorityBand,
        priorityReason: leading.priorityReason,
        dueAt: leading.dueAt,
        evaluations
      };
    })
    .sort((left, right) => compareEvaluations(left.evaluations[0], right.evaluations[0]));
}

export function selectFiveMinuteCheckIn(state, now = new Date(), limit = 4, options = {}) {
  const snapshot = prioritySnapshot(state, now, options);
  const selected = [];
  const consequential = snapshot.candidates.find((entry) => entry.priorityBand === PRIORITY_BAND.IMPORTANT || entry.priorityBand === PRIORITY_BAND.CRITICAL);
  if (consequential) selected.push(consequential);

  for (const entry of snapshot.candidates) {
    if (selected.includes(entry) || selected.length >= Math.max(1, limit)) continue;
    if (quickReview(entry)) selected.push(entry);
    if (selected.filter(quickReview).length >= 2) break;
  }
  const usefulCheck = snapshot.candidates.find((entry) => !selected.includes(entry) && entry.item.type === 'financial_action');
  if (usefulCheck && selected.length < limit) selected.push(usefulCheck);
  for (const entry of snapshot.candidates) {
    if (selected.length >= limit) break;
    if (!selected.includes(entry)) selected.push(entry);
  }
  return consolidatePriorityWork(selected);
}

export function consolidatePriorityWork(evaluations) {
  const groups = new Map();
  for (const evaluation of evaluations || []) {
    if (!evaluation?.item?.id) continue;
    const key = evaluation.item.type === 'uncategorised_payment' && evaluation.item.groupKey
      ? `categorisation:${evaluation.item.groupKey}`
      : `item:${evaluation.item.id}`;
    const group = groups.get(key) || { id: key, evaluations: [] };
    group.evaluations.push(evaluation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const leading = [...group.evaluations].sort(compareEvaluations)[0];
    const consolidated = group.evaluations.length > 1 && leading.item.type === 'uncategorised_payment';
    return {
      id: group.id,
      itemIds: group.evaluations.map((entry) => entry.item.id),
      evaluations: group.evaluations,
      priorityBand: leading.priorityBand,
      title: consolidated ? `Categorise ${group.evaluations.length} related payments` : leading.title,
      detail: consolidated ? 'Work through these related payments together. Each payment keeps its own review state.' : leading.detail,
      consolidated,
      workflowType: consolidated ? 'categorisation' : 'single'
    };
  }).sort((left, right) => BAND_RANK[left.priorityBand] - BAND_RANK[right.priorityBand]);
}

function evaluateWithContext(item, state, context) {
  const presentation = reviewItemPresentation(item, state);
  const source = sourceRecord(item, state);
  const dueAt = sourceDueAt(source);
  const dueDays = daysUntil(dueAt, context.now);
  const base = baseConsequence(item, source, context);
  let consequence = base.value;
  consequence += dueModifier(item, source, dueDays, consequence);
  consequence += deferralModifier(item, consequence);
  consequence += ageModifier(item, context.now, consequence);
  if (item.status === 'in_progress') consequence += 6;
  consequence = Math.min(100, consequence);
  let priorityBand = bandFor(consequence);
  if (item.type === 'uncategorised_payment' && !base.material && priorityBand === PRIORITY_BAND.IMPORTANT) priorityBand = PRIORITY_BAND.NORMAL;
  const priorityReason = explainPriority(item, context, { base, dueDays, priorityBand });
  return {
    item,
    title: presentation.title,
    detail: presentation.detail,
    actionLabel: item.status === 'in_progress' ? 'Continue' : 'Do it',
    timeframe: item.type === 'uncategorised_payment' ? '2 min' : item.type === 'possible_duplicate' ? '5 min' : '10 min',
    priorityBand,
    priorityReason,
    dueAt,
    dueDays,
    inProgress: item.status === 'in_progress',
    internalConsequence: consequence
  };
}

function priorityContext(state, now, safetyAssessment) {
  const safeNow = validDate(now);
  const safety = safetyAssessment && typeof safetyAssessment === 'object'
    ? safetyAssessment
    : { accounts: [], blockingReasons: [], plannedCapacity: 0, currentCashCapacity: null };
  const cashBalance = (state.accounts || [])
    .filter((account) => account.active !== false && ['current', 'cash'].includes(normalise(account.type)))
    .reduce((total, account) => total + finitePositive(account.currentBalance), 0);
  return {
    now: safeNow,
    safety,
    safetyById: new Map((safety.accounts || []).map((account) => [String(account.id), account])),
    dependableIncome: finitePositive(state.profile?.dependableIncome),
    cashBalance
  };
}

function baseConsequence(item, source, context) {
  if (item.type === 'financial_action') {
    const safety = context.safetyById.get(item.sourceId);
    const codes = new Set(safety?.reasonCodes || []);
    const status = normalise(source?.status);
    const arrangement = normalise(source?.arrangementStatus);
    const limit = finiteOrNull(item.sourceType === 'overdraft' ? source?.limit : source?.creditLimit);
    const overLimit = safety?.overLimit || codes.has('over_limit')
      || (limit !== null && Number(source?.currentBalance || 0) > limit);
    if (overLimit) return { value: 96, reason: 'over_limit', material: true };
    if (codes.has('conflicting_status') || source?.statusConflict === true) return { value: 94, reason: 'safety_conflict', material: true };
    if (codes.has('default_arrangement_unresolved') || (status === 'defaulted' && arrangement !== 'confirmed')) return { value: 92, reason: 'default_unresolved', material: true };
    if (codes.has('arrears_arrangement_unresolved') || (status === 'arrears' && arrangement !== 'confirmed')) return { value: 90, reason: 'arrears_unresolved', material: true };
    if ([...codes].some((code) => ['unknown_status', 'unknown_arrangement', 'unknown_arrangement_payment', 'unknown_required_payment', 'unknown_credit_limit'].includes(code))) {
      return { value: 72, reason: 'safety_blocked', material: true };
    }
    return { value: item.priority === 'high' ? 66 : 52, reason: 'account_review', material: true };
  }
  if (item.type === 'import_conflict') {
    const conflictCount = finitePositive(source?.conflictCount);
    const balanceAffecting = source?.kind === 'statement' && source?.reconciled === false;
    if (conflictCount > 0 || balanceAffecting) return { value: 88, reason: 'trusted_balance_conflict', material: true };
    if (source?.kind === 'credit-report' || source?.kind === 'statement') return { value: 70, reason: 'financial_import_conflict', material: true };
    return { value: 48, reason: 'import_review', material: false };
  }
  if (item.type === 'possible_duplicate') {
    const amount = Math.max(finitePositive(source?.outgoing), finitePositive(source?.incoming));
    const affectsTrustedBalance = source?.financiallyActive === false || source?.reviewStatus === 'pending';
    const material = affectsTrustedBalance && (amount >= 500
      || (context.dependableIncome > 0 && amount >= context.dependableIncome * 0.1)
      || (context.cashBalance > 0 && amount >= context.cashBalance * 0.2));
    return { value: material ? 68 : 43, reason: material ? 'material_duplicate' : 'duplicate_review', material };
  }
  if (item.type === 'uncategorised_payment') {
    const amount = finitePositive(source?.outgoing);
    const blocksSafety = Boolean(source?.blockingSafetyCalculation || source?.financialSafetyRequired);
    const recurring = Boolean(source?.recurringCommitment || source?.recurring === true);
    const material = blocksSafety || recurring || amount >= Math.max(100, context.dependableIncome * 0.05);
    if (blocksSafety) return { value: 68, reason: 'classification_blocks_safety', material: true };
    if (recurring) return { value: 56, reason: 'recurring_classification', material: true };
    return { value: material ? 42 : 20, reason: material ? 'material_categorisation' : 'housekeeping', material };
  }
  const taskRisk = normalise(source?.financialRisk || source?.severity || source?.risk);
  if (source?.blockingSafetyCalculation === true) return { value: 88, reason: 'task_blocks_safety', material: true };
  if (taskRisk === 'critical') return { value: 92, reason: 'critical_task', material: true };
  if (['high', 'important', 'serious'].includes(taskRisk)) return { value: 70, reason: 'important_task', material: true };
  if (source?.essential === true || source?.isEssential === true) return { value: 58, reason: 'essential_task', material: true };
  if (item.priority === 'high' || source?.priority === 'high') return { value: 64, reason: 'important_task', material: true };
  if (item.priority === 'low' || source?.priority === 'low') return { value: 22, reason: 'background_task', material: false };
  return { value: 44, reason: 'saved_action', material: false };
}

function dueModifier(item, source, dueDays, consequence) {
  if (dueDays === null || dueDays > 10) return 0;
  const meaningful = consequence >= 35 || source?.essential === true || source?.isEssential === true;
  if (!meaningful) return dueDays <= 0 ? 8 : 0;
  if (dueDays < 0) return 38;
  if (dueDays === 0) return 34;
  if (dueDays === 1) return 30;
  if (dueDays <= 3) return 18;
  if (dueDays <= 7) return 9;
  return item.type === 'generated_action' ? 4 : 0;
}

function deferralModifier(item, consequence) {
  const count = nonNegativeInteger(item.snoozeCount);
  if (count < 2 || consequence < 35) return 0;
  return Math.min(12, (count - 1) * 4);
}

function ageModifier(item, now, consequence) {
  if (item.type === 'uncategorised_payment' || consequence < 35) return 0;
  const created = Date.parse(item.createdAt);
  if (!Number.isFinite(created)) return 0;
  const days = Math.floor((now.getTime() - created) / 86_400_000);
  return days >= 60 ? 6 : days >= 30 ? 3 : 0;
}

function explainPriority(item, context, result) {
  let explanation;
  switch (result.base.reason) {
    case 'over_limit': explanation = 'This account is above its recorded limit, so checking it has a more immediate financial consequence than routine housekeeping.'; break;
    case 'safety_conflict': explanation = 'Conflicting account information is preventing Financial Safety from relying on the recorded status.'; break;
    case 'default_unresolved': explanation = 'This default still needs a confirmed payment arrangement before Financial Safety can rely on it.'; break;
    case 'arrears_unresolved': explanation = 'This account is in arrears and its payment arrangement is not yet confirmed.'; break;
    case 'safety_blocked': explanation = 'Missing account information is blocking a cautious Financial Safety calculation.'; break;
    case 'trusted_balance_conflict': explanation = 'This import conflict could materially affect a trusted balance, so it should be decided before routine review work.'; break;
    case 'financial_import_conflict': explanation = 'This imported financial information needs a decision before OneStep can treat it as trusted.'; break;
    case 'material_duplicate': explanation = 'This possible duplicate could materially change the trusted balance and is worth checking before smaller review items.'; break;
    case 'duplicate_review': explanation = 'This payment is excluded from trusted totals until you confirm whether both records are genuine.'; break;
    case 'classification_blocks_safety': explanation = 'Financial Safety depends on understanding this payment before it can make a cautious calculation.'; break;
    case 'recurring_classification': explanation = 'This may be a recurring commitment, so confirming its category improves future budget decisions.'; break;
    case 'material_categorisation': explanation = 'This payment has a meaningful effect on the accuracy of the current budget.'; break;
    case 'housekeeping': explanation = 'This is useful housekeeping, but it does not currently outweigh known financial risks or near-term commitments.'; break;
    case 'task_blocks_safety': explanation = 'Completing this action unblocks a Financial Safety calculation.'; break;
    case 'critical_task': explanation = 'This saved action is marked as having an immediate financial consequence.'; break;
    case 'important_task': explanation = 'This saved action has an important financial consequence.'; break;
    case 'essential_task': explanation = 'This action concerns an essential commitment.'; break;
    case 'background_task': explanation = 'This remains available in Review Inbox, but it does not need to take over Today.'; break;
    default: explanation = 'This is a useful open action that can be completed now.';
  }
  const due = dueExplanation(result.dueDays);
  if (due) explanation = `${due} ${explanation}`;
  const snoozes = nonNegativeInteger(item.snoozeCount);
  if (snoozes >= 2) explanation += ` It has been postponed ${snoozes} times and is available again.`;
  if (result.priorityBand === PRIORITY_BAND.CRITICAL && context.safety?.blockingReasons?.length && item.type !== 'financial_action') {
    explanation += ' Financial Safety remains responsible for what is safe; this ranking only chooses what to review first.';
  }
  return explanation;
}

function dueExplanation(days) {
  if (days === null) return '';
  if (days < 0) return 'The related date has passed.';
  if (days === 0) return 'This is due today.';
  if (days === 1) return 'This is due tomorrow.';
  if (days <= 10) return `This is due in ${days} days.`;
  return '';
}

function compareEvaluations(left, right, preferredItemId = '') {
  const bandDifference = BAND_RANK[left.priorityBand] - BAND_RANK[right.priorityBand];
  if (bandDifference) return bandDifference;
  if (preferredItemId) {
    if (left.item.id === preferredItemId && right.item.id !== preferredItemId) return -1;
    if (right.item.id === preferredItemId && left.item.id !== preferredItemId) return 1;
  }
  if (left.inProgress !== right.inProgress) return left.inProgress ? -1 : 1;
  return right.internalConsequence - left.internalConsequence
    || nullableNumber(left.dueDays) - nullableNumber(right.dueDays)
    || String(left.item.createdAt || '').localeCompare(String(right.item.createdAt || ''))
    || left.item.id.localeCompare(right.item.id);
}

function worthSurfacingToday(evaluation) {
  return evaluation.inProgress || evaluation.priorityBand !== PRIORITY_BAND.LOW;
}

function quickReview(evaluation) {
  return ['uncategorised_payment', 'possible_duplicate'].includes(evaluation.item.type)
    && evaluation.priorityBand !== PRIORITY_BAND.CRITICAL;
}

function sourceRecord(item, state) {
  if (item.sourceType === 'transaction') return (state.transactions || []).find((entry) => String(entry.id) === item.sourceId) || null;
  if (item.sourceType === 'debt') return (state.debts || []).find((entry) => String(entry.id) === item.sourceId) || null;
  if (item.sourceType === 'overdraft') return (state.overdrafts || []).find((entry) => String(entry.id) === item.sourceId) || null;
  if (item.sourceType === 'document') return (state.documents || []).find((entry) => String(entry.id) === item.sourceId) || null;
  if (item.sourceType === 'importBatch') return (state.importBatches || []).find((entry) => String(entry.id) === item.sourceId) || null;
  if (item.sourceType === 'task') return (state.tasks || []).find((entry) => String(entry.id) === item.sourceId) || null;
  return null;
}

function sourceDueAt(source) {
  for (const candidate of [source?.dueAt, source?.dueDate, source?.paymentDueAt, source?.paymentDueDate, source?.deadline]) {
    if (validDateValue(candidate)) return String(candidate);
  }
  return null;
}

function daysUntil(value, now) {
  if (!value) return null;
  const due = new Date(String(value).length === 10 ? `${value}T12:00:00` : value);
  if (Number.isNaN(due.getTime())) return null;
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startDue = new Date(due.getFullYear(), due.getMonth(), due.getDate());
  return Math.round((startDue.getTime() - startToday.getTime()) / 86_400_000);
}

function bandFor(value) {
  if (value >= 85) return PRIORITY_BAND.CRITICAL;
  if (value >= 60) return PRIORITY_BAND.IMPORTANT;
  if (value >= 35) return PRIORITY_BAND.NORMAL;
  return PRIORITY_BAND.LOW;
}

function validDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function validDateValue(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)); }
function finitePositive(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, number) : 0; }
function finiteOrNull(value) { const number = Number(value); return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number; }
function nonNegativeInteger(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : 0; }
function nullableNumber(value) { return value === null ? Number.POSITIVE_INFINITY : value; }
function normalise(value) { return String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); }
