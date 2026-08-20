import {
  SUBSCRIPTION_CLASSIFICATION,
  SUBSCRIPTION_SOURCE,
  deriveSubscriptionCandidates,
  listSubscriptionRecords
} from './subscription-model.js';
import { deriveRecurringPatterns } from './recurring-finance.js';

const WORKFLOW_KIND = 'subscription_workflow';
const MAX_WORKFLOWS = 1000;

export const SUBSCRIPTION_LIFECYCLE = Object.freeze({
  ACTIVE: 'active',
  REVIEW: 'review',
  CANCELLATION_PLANNED: 'cancellation_planned',
  CANCELLATION_IN_PROGRESS: 'cancellation_in_progress',
  CANCELLED: 'cancelled',
  CONTRACT_ENDING: 'contract_ending'
});

export const SUBSCRIPTION_REVIEW_TYPE = Object.freeze({
  CANDIDATE_CONFIRMATION: 'subscription_confirmation',
  EVIDENCE_CHANGE: 'subscription_evidence_change',
  CANCELLATION_INFORMATION: 'subscription_cancellation_information',
  CANCELLATION_CONFLICT: 'subscription_cancellation_conflict',
  CONTRACT_REVIEW: 'subscription_contract_review',
  LIFECYCLE_REVIEW: 'subscription_lifecycle_review'
});

export function readSubscriptionWorkflow(state = {}, subscriptionId) {
  const id = String(subscriptionId || '');
  const rows = Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [];
  for (const row of rows) {
    if (row?.recordKind !== WORKFLOW_KIND) continue;
    const workflow = normaliseWorkflow(row.subscriptionWorkflow);
    if (workflow?.subscriptionId === id) return workflow;
  }
  return defaultWorkflow(id);
}

export function listSubscriptionWorkflows(state = {}) {
  const validSubscriptions = new Set(listSubscriptionRecords(state).map((record) => record.id));
  const rows = Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [];
  const byId = new Map();
  for (const row of rows) {
    if (row?.recordKind !== WORKFLOW_KIND) continue;
    const workflow = normaliseWorkflow(row.subscriptionWorkflow);
    if (!workflow || !validSubscriptions.has(workflow.subscriptionId)) continue;
    byId.set(workflow.subscriptionId, workflow);
    if (byId.size >= MAX_WORKFLOWS) break;
  }
  for (const subscriptionId of validSubscriptions) {
    if (!byId.has(subscriptionId)) byId.set(subscriptionId, defaultWorkflow(subscriptionId));
  }
  return [...byId.values()].sort((left, right) => left.subscriptionId.localeCompare(right.subscriptionId));
}

export function subscriptionLifecycleById(state = {}) {
  return new Map(listSubscriptionWorkflows(state).map((workflow) => [workflow.subscriptionId, workflow.lifecycleStatus]));
}

export function setSubscriptionLifecycle(state = {}, subscriptionId, lifecycleStatus, input = {}, now = new Date()) {
  const id = requireSubscription(state, subscriptionId);
  if (!Object.values(SUBSCRIPTION_LIFECYCLE).includes(lifecycleStatus)) throw new TypeError('Choose a supported subscription lifecycle state.');
  const current = readSubscriptionWorkflow(state, id);
  const timestamp = validDate(now).toISOString();
  const today = localDateKey(now);
  let cancellationEffectiveDate = current.cancellationEffectiveDate;
  let contractEndDate = current.contractEndDate;

  if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.ACTIVE) {
    cancellationEffectiveDate = null;
    contractEndDate = null;
  } else if ([SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS].includes(lifecycleStatus)) {
    cancellationEffectiveDate = null;
  } else if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CANCELLED) {
    cancellationEffectiveDate = validLocalDate(input.effectiveDate) ? input.effectiveDate : today;
    if (cancellationEffectiveDate > today) throw new TypeError('A future end date is not a completed cancellation. Use Contract ending until the subscription has actually ended.');
    contractEndDate = null;
  } else if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING) {
    contractEndDate = validLocalDate(input.contractEndDate) ? input.contractEndDate : null;
    if (!contractEndDate) throw new TypeError('Enter the known contract end date before marking a subscription Contract ending.');
    cancellationEffectiveDate = null;
  }

  return persistWorkflow(state, {
    ...current,
    subscriptionId: id,
    lifecycleStatus,
    cancellationEffectiveDate,
    contractEndDate,
    contractReviewRequired: input.contractReviewRequired === undefined ? current.contractReviewRequired : input.contractReviewRequired === true,
    updatedAt: timestamp,
    lifecycleChangedAt: timestamp
  });
}

export function setSubscriptionContractReview(state = {}, subscriptionId, required, now = new Date()) {
  const id = requireSubscription(state, subscriptionId);
  const current = readSubscriptionWorkflow(state, id);
  return persistWorkflow(state, {
    ...current,
    subscriptionId: id,
    contractReviewRequired: required === true,
    updatedAt: validDate(now).toISOString()
  });
}

export function subscriptionRecommendationOptions(state = {}) {
  const lifecycleById = subscriptionLifecycleById(state);
  const contractRiskIds = listSubscriptionWorkflows(state)
    .filter((workflow) => workflow.contractReviewRequired)
    .map((workflow) => workflow.subscriptionId);
  return { lifecycleById, contractRiskIds };
}

export function subscriptionOccurrenceStillCommitted(state = {}, patternId, occurrenceDate) {
  const date = validLocalDate(occurrenceDate) ? occurrenceDate : null;
  if (!date) return true;
  const records = listSubscriptionRecords(state)
    .filter((record) => record.source === SUBSCRIPTION_SOURCE.RECURRING && record.sourcePatternId === String(patternId || ''));
  if (!records.length) return true;
  for (const record of records) {
    const workflow = readSubscriptionWorkflow(state, record.id);
    if (workflow.lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CANCELLED && workflow.cancellationEffectiveDate && date >= workflow.cancellationEffectiveDate) continue;
    if (workflow.lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING && workflow.contractEndDate && date > workflow.contractEndDate) continue;
    return true;
  }
  return false;
}

export function subscriptionReviewSources(state = {}, now = new Date()) {
  const sources = [];
  const candidates = deriveSubscriptionCandidates(state);
  for (const candidate of candidates) {
    sources.push({
      type: candidate.evidenceChanged ? SUBSCRIPTION_REVIEW_TYPE.EVIDENCE_CHANGE : SUBSCRIPTION_REVIEW_TYPE.CANDIDATE_CONFIRMATION,
      priority: candidate.evidenceChanged ? 'normal' : candidate.classification === SUBSCRIPTION_CLASSIFICATION.UNCERTAIN ? 'low' : 'normal',
      sourceType: 'subscription_candidate',
      sourceId: candidate.id,
      conditionKey: [candidate.sourceEvidenceFingerprint, candidate.classification, candidate.previousDecision || ''].join('|')
    });
  }

  const patterns = new Map(deriveRecurringPatterns(state, { includeRejected: true }).map((pattern) => [pattern.id, pattern]));
  for (const record of listSubscriptionRecords(state)) {
    const workflow = readSubscriptionWorkflow(state, record.id);
    if (workflow.lifecycleStatus === SUBSCRIPTION_LIFECYCLE.REVIEW) {
      sources.push(source(SUBSCRIPTION_REVIEW_TYPE.LIFECYCLE_REVIEW, 'normal', record, workflow, 'lifecycle_review'));
    }
    if ([SUBSCRIPTION_LIFECYCLE.CANCELLATION_PLANNED, SUBSCRIPTION_LIFECYCLE.CANCELLATION_IN_PROGRESS].includes(workflow.lifecycleStatus)
      && !record.cancellationMetadataRef) {
      sources.push(source(SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_INFORMATION, 'normal', record, workflow, 'cancellation_route_missing'));
    }
    if (workflow.contractReviewRequired) {
      sources.push(source(SUBSCRIPTION_REVIEW_TYPE.CONTRACT_REVIEW, 'normal', record, workflow, 'contract_review_required'));
    }
    const boundary = workflow.lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CANCELLED
      ? workflow.cancellationEffectiveDate
      : workflow.lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING ? workflow.contractEndDate : null;
    const pattern = record.source === SUBSCRIPTION_SOURCE.RECURRING ? patterns.get(record.sourcePatternId) : null;
    if (boundary && pattern?.dates?.some((date) => date > boundary)) {
      sources.push(source(
        SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_CONFLICT,
        'high', record, workflow,
        `${workflow.lifecycleStatus}|${boundary}|${pattern.evidenceFingerprint}`
      ));
    }
  }

  return sources.sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority)
    || left.type.localeCompare(right.type) || String(left.sourceId).localeCompare(String(right.sourceId)));
}

export function subscriptionReviewPresentation(state = {}, item) {
  if (!item) return null;
  if (item.sourceType === 'subscription_candidate') {
    const candidate = deriveSubscriptionCandidates(state, { includeResolved: true, includeHidden: true })
      .find((entry) => entry.id === item.sourceId);
    if (!candidate) return resolvedPresentation();
    if (item.type === SUBSCRIPTION_REVIEW_TYPE.EVIDENCE_CHANGE) return {
      title: 'Recurring subscription evidence changed',
      detail: `${candidate.providerName} has materially different recurring evidence and needs another decision before OneStep relies on the new pattern.`,
      why: 'OneStep preserves your earlier decision and asks again only when the underlying evidence changes materially.',
      action: 'Review subscription',
      consequence: 'Confirming or rejecting the new candidate clears this review item automatically.'
    };
    return {
      title: 'Confirm possible subscription',
      detail: `${candidate.providerName} appears to be recurring but is not yet a confirmed subscription.`,
      why: 'Detected recurring spending is evidence, not an automatic subscription decision.',
      action: 'Review subscription',
      consequence: 'Confirming or rejecting the candidate clears this review item automatically.'
    };
  }

  const record = listSubscriptionRecords(state).find((entry) => entry.id === item.sourceId);
  if (!record) return resolvedPresentation();
  if (item.type === SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_CONFLICT) return {
    title: 'Subscription activity after its recorded end',
    detail: `${record.providerName} has recurring evidence after the recorded cancellation or contract-end boundary.`,
    why: 'OneStep does not silently reopen the subscription or ignore the new charge. Your explicit lifecycle decision remains recorded while the conflict is reviewed.',
    action: 'Review subscription',
    consequence: 'Check whether the payment is genuine and correct the lifecycle only if the recorded state is no longer accurate.'
  };
  if (item.type === SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_INFORMATION) return {
    title: 'Cancellation route needs checking',
    detail: `${record.providerName} is marked for cancellation but no reliable online cancellation destination is stored.`,
    why: 'OneStep will not invent a provider cancellation path or assume that opening a page completes cancellation.',
    action: 'Review cancellation guidance',
    consequence: 'Store reliable guidance or use the provider’s own account/support route before progressing the cancellation.'
  };
  if (item.type === SUBSCRIPTION_REVIEW_TYPE.CONTRACT_REVIEW) return {
    title: 'Subscription terms need review',
    detail: `${record.providerName} has unresolved contract, notice-period or fee information.`,
    why: 'Uncertain contract terms can change whether cancelling is genuinely safe or useful.',
    action: 'Review subscription terms',
    consequence: 'Clear the contract review flag only after the relevant terms are known well enough to act.'
  };
  return {
    title: 'Subscription lifecycle needs review',
    detail: `${record.providerName} is explicitly marked Review.`,
    why: 'OneStep keeps uncertain subscription status visible instead of guessing an active or cancelled state.',
    action: 'Review subscription',
    consequence: 'Choose the lifecycle state that matches the evidence when you are ready.'
  };
}

export function subscriptionReviewRoute(_state, item) {
  return {
    view: 'subscriptions',
    type: item?.sourceType === 'subscription_candidate' ? 'subscription_candidate' : 'subscription',
    id: item?.sourceId || null
  };
}

export function subscriptionReviewSourceActive(state = {}, item, now = new Date()) {
  return subscriptionReviewSources(state, now).some((sourceItem) => sourceItem.type === item?.type
    && sourceItem.sourceType === item?.sourceType && String(sourceItem.sourceId) === String(item?.sourceId));
}

export function subscriptionReviewPrioritySource(state = {}, item) {
  if (item?.sourceType === 'subscription_candidate') {
    const candidate = deriveSubscriptionCandidates(state, { includeResolved: true, includeHidden: true })
      .find((entry) => entry.id === item.sourceId);
    if (!candidate) return null;
    return {
      priority: item.priority,
      dueAt: candidate.expectedNextPayment?.date || null,
      financialRisk: item.type === SUBSCRIPTION_REVIEW_TYPE.EVIDENCE_CHANGE ? 'important' : null,
      blockingSafetyCalculation: false
    };
  }
  const record = listSubscriptionRecords(state).find((entry) => entry.id === item?.sourceId);
  if (!record) return null;
  return {
    priority: item.priority,
    dueAt: record.expectedNextPayment?.date || null,
    financialRisk: item.type === SUBSCRIPTION_REVIEW_TYPE.CANCELLATION_CONFLICT ? 'important' : null,
    blockingSafetyCalculation: false
  };
}

export function exportSubscriptionsCsv(state = {}) {
  const rows = listSubscriptionRecords(state).map((record) => {
    const workflow = readSubscriptionWorkflow(state, record.id);
    return [
      record.id,
      record.providerName,
      record.source,
      record.classification,
      record.decisionState,
      record.cadence,
      record.amountRange?.min ?? '',
      record.amountRange?.max ?? '',
      record.amountRange?.typical ?? '',
      record.expectedNextPayment?.date || '',
      record.accountId || '',
      record.rank ?? '',
      record.protectionState || '',
      workflow.lifecycleStatus,
      workflow.cancellationEffectiveDate || '',
      workflow.contractEndDate || '',
      workflow.contractReviewRequired ? 'yes' : 'no',
      record.notes || '',
      record.cancellationMetadataRef || ''
    ];
  });
  const headers = ['Subscription ID', 'Provider', 'Source', 'Classification', 'Decision', 'Cadence', 'Amount min', 'Amount max', 'Amount typical', 'Next expected payment', 'Account ID', 'Rank', 'Protection', 'Lifecycle', 'Cancellation effective date', 'Contract end date', 'Contract review required', 'Notes', 'Cancellation metadata reference'];
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
}

function source(type, priority, record, workflow, conditionKey) {
  return {
    type,
    priority,
    sourceType: 'subscription',
    sourceId: record.id,
    conditionKey: [conditionKey, workflow.updatedAt || '', record.updatedAt || ''].join('|')
  };
}

function persistWorkflow(state, input) {
  const workflow = normaliseWorkflow(input);
  if (!workflow) throw new TypeError('The subscription workflow state is invalid.');
  const next = structuredClone(state || {});
  const rows = Array.isArray(next.scheduledPayments) ? next.scheduledPayments : [];
  const envelope = {
    id: `subscription_workflow_${shortHash(workflow.subscriptionId)}`,
    recordKind: WORKFLOW_KIND,
    active: false,
    includedInBudget: true,
    status: 'resolved',
    amount: 0,
    outgoing: 0,
    payment: 0,
    subscriptionWorkflow: structuredClone(workflow)
  };
  const index = rows.findIndex((row) => row?.recordKind === WORKFLOW_KIND && row?.subscriptionWorkflow?.subscriptionId === workflow.subscriptionId);
  if (index >= 0) rows.splice(index, 1, envelope);
  else {
    if (rows.filter((row) => row?.recordKind === WORKFLOW_KIND).length >= MAX_WORKFLOWS) throw new Error(`OneStep supports up to ${MAX_WORKFLOWS} subscription workflow records.`);
    rows.push(envelope);
  }
  next.scheduledPayments = rows;
  return next;
}

function normaliseWorkflow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subscriptionId = String(value.subscriptionId || '');
  if (!/^subscription_[a-z0-9][a-z0-9_-]{7,159}$/i.test(subscriptionId)) return null;
  let lifecycleStatus = Object.values(SUBSCRIPTION_LIFECYCLE).includes(value.lifecycleStatus)
    ? value.lifecycleStatus : SUBSCRIPTION_LIFECYCLE.ACTIVE;
  let cancellationEffectiveDate = validLocalDate(value.cancellationEffectiveDate) ? value.cancellationEffectiveDate : null;
  let contractEndDate = validLocalDate(value.contractEndDate) ? value.contractEndDate : null;
  let contractReviewRequired = value.contractReviewRequired === true;
  if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CANCELLED && !cancellationEffectiveDate) {
    lifecycleStatus = SUBSCRIPTION_LIFECYCLE.REVIEW;
    contractReviewRequired = true;
  }
  if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.CONTRACT_ENDING && !contractEndDate) {
    lifecycleStatus = SUBSCRIPTION_LIFECYCLE.REVIEW;
    contractReviewRequired = true;
  }
  if (lifecycleStatus === SUBSCRIPTION_LIFECYCLE.ACTIVE) {
    cancellationEffectiveDate = null;
    contractEndDate = null;
  }
  return {
    subscriptionId,
    lifecycleStatus,
    cancellationEffectiveDate,
    contractEndDate,
    contractReviewRequired,
    lifecycleChangedAt: validIso(value.lifecycleChangedAt) ? value.lifecycleChangedAt : null,
    updatedAt: validIso(value.updatedAt) ? value.updatedAt : null
  };
}

function defaultWorkflow(subscriptionId) {
  return {
    subscriptionId: String(subscriptionId || ''),
    lifecycleStatus: SUBSCRIPTION_LIFECYCLE.ACTIVE,
    cancellationEffectiveDate: null,
    contractEndDate: null,
    contractReviewRequired: false,
    lifecycleChangedAt: null,
    updatedAt: null
  };
}

function requireSubscription(state, subscriptionId) {
  const id = String(subscriptionId || '');
  if (!listSubscriptionRecords(state).some((record) => record.id === id)) throw new Error('That subscription is no longer available.');
  return id;
}

function resolvedPresentation() {
  return {
    title: 'Subscription review completed',
    detail: 'The underlying subscription source no longer needs review.',
    why: 'Review items follow authoritative source truth.',
    action: 'Subscriptions',
    consequence: 'This item will close automatically.'
  };
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? new Date() : date; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validLocalDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}
function localDateKey(value) {
  const date = validDate(value);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
function priorityRank(value) { return ({ high: 0, normal: 1, low: 2 })[value] ?? 3; }
function shortHash(value) {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
