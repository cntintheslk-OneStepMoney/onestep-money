import * as base from './review-lifecycle-base.js';
import {
  ensurePaydayConfiguration, missingIncomePresentation, missingIncomeReviewSources, nextDependablePayday
} from './payday-awareness.js';

export const REVIEW_STATUS = base.REVIEW_STATUS;
export const REVIEW_DIAGNOSTIC_CODES = base.REVIEW_DIAGNOSTIC_CODES;
export const knownPaydayDay = base.knownPaydayDay;

export function synchroniseReviewItems(state, now = new Date()) {
  ensurePaydayConfiguration(state, now);
  const previousMissing = (Array.isArray(state.reviewItems) ? state.reviewItems : [])
    .filter((item) => item?.type === 'missing_income')
    .map((item) => structuredClone(item));
  state.reviewItems = (Array.isArray(state.reviewItems) ? state.reviewItems : []).filter((item) => item?.type !== 'missing_income');
  base.synchroniseReviewItems(state, now);
  mergeMissingItems(state, previousMissing, now);
  return state;
}

export function activeReviewItems(state, now = new Date()) {
  synchroniseReviewItems(state, now);
  return (state.reviewItems || [])
    .filter((item) => item.status !== REVIEW_STATUS.RESOLVED && !(item.status === REVIEW_STATUS.SNOOZED && !due(item.snoozedUntil, now)))
    .sort(compareReviewPriority);
}

export function snoozedReviewItems(state, now = new Date()) {
  synchroniseReviewItems(state, now);
  return (state.reviewItems || [])
    .filter((item) => item.status === REVIEW_STATUS.SNOOZED && !due(item.snoozedUntil, now))
    .sort((a, b) => String(a.snoozedUntil).localeCompare(String(b.snoozedUntil)));
}

export function reviewInboxSummary(state, now = new Date()) {
  const active = activeReviewItems(state, now);
  const snoozed = snoozedReviewItems(state, now);
  const groups = groupReviewItems(active, state, now);
  return {
    active, snoozed, groups, total: groups.length,
    important: groups.filter((item) => item.priority === 'high').length,
    normal: groups.filter((item) => item.priority === 'normal').length,
    low: groups.filter((item) => item.priority === 'low').length
  };
}

export function groupReviewItems(items, state, now = new Date()) {
  return base.groupReviewItems(items, state).map((group) => group.type === 'missing_income'
    ? { ...group, presentation: missingPresentation(state, group.items[0], now) }
    : group);
}

export function reviewItemPresentation(item, state, now = new Date()) {
  return item?.type === 'missing_income' ? missingPresentation(state, item, now) : base.reviewItemPresentation(item, state);
}

// Keep the renderer-facing merchant/payee precedence explicit at this integration boundary.
// This mirrors the established Review presentation contract while legacy item rendering delegates to the base module.
export function reviewMerchantLabel(transaction) {
  return transaction?.merchantName || transaction?.userDescription || transaction?.description || 'Payment';
}

export function startReviewItem(state, itemId, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  if (item.status !== REVIEW_STATUS.SNOOZED) item.status = REVIEW_STATUS.IN_PROGRESS;
  item.updatedAt = validDate(now).toISOString();
  return state;
}

export function snoozeReviewItem(state, itemId, choice, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  const payday = nextDependablePayday(state, now)?.date || legacyPaydayDate(state.profile?.paydayDay, now);
  const snoozedUntil = snoozeUntil(choice, now, payday);
  if (!snoozedUntil) {
    const error = new Error(choice === 'payday' ? 'Payday is not known yet.' : 'Choose a supported snooze time.');
    error.code = REVIEW_DIAGNOSTIC_CODES.SNOOZE_INVALID;
    throw error;
  }
  item.status = REVIEW_STATUS.SNOOZED;
  item.snoozedUntil = snoozedUntil;
  item.snoozeCount = nonNegativeInteger(item.snoozeCount) + 1;
  item.lastSnoozedAt = validDate(now).toISOString();
  item.updatedAt = item.lastSnoozedAt;
  return state;
}

export function snoozeReviewGroup(state, itemIds, choice, now = new Date()) {
  for (const itemId of itemIds) snoozeReviewItem(state, itemId, choice, now);
  return state;
}

export function resolveReviewItem(state, itemId, decision, now = new Date()) {
  synchroniseReviewItems(state, now);
  const item = requireOpenItem(state, itemId);
  if (item.type === 'missing_income') {
    if (missingIncomeReviewSources(state, now).some((source) => source.sourceId === item.sourceId)) {
      const error = new Error('Complete the underlying financial work before resolving this review item.');
      error.code = REVIEW_DIAGNOSTIC_CODES.RESOLUTION_FAILED;
      throw error;
    }
    const timestamp = validDate(now).toISOString();
    item.status = REVIEW_STATUS.RESOLVED;
    item.snoozedUntil = null;
    item.updatedAt = timestamp;
    item.resolution = { decision, resolvedAt: timestamp };
    return state;
  }
  const preservedMissing = extractMissing(state);
  try {
    base.resolveReviewItem(state, itemId, decision, now);
  } finally {
    restoreMissing(state, preservedMissing);
  }
  return synchroniseReviewItems(state, now);
}

export function selectCheckInReviewItems(state, now = new Date(), limit = 4) {
  const items = activeReviewItems(state, now);
  const selected = [];
  const important = items.find((item) => item.priority === 'high');
  if (important) selected.push(important);
  for (const item of items) {
    if (selected.includes(item)) continue;
    if (selected.length >= limit) break;
    selected.push(item);
  }
  return selected;
}

export function reviewRoute(item, state = {}) {
  return item?.type === 'missing_income'
    ? { view: 'settings', type: 'income_schedule', id: item.sourceId }
    : base.reviewRoute(item, state);
}

function mergeMissingItems(state, previousMissing, now) {
  const timestamp = validDate(now).toISOString();
  const previous = new Map(previousMissing.map((item) => [item.id, item]));
  const activeIds = new Set();
  const merged = [];
  for (const source of missingIncomeReviewSources(state, now)) {
    const id = reviewItemId(source.type, source.sourceType, source.sourceId);
    activeIds.add(id);
    const item = previous.get(id) || createMissingItem(source, id, timestamp);
    const conditionChanged = item.conditionKey !== (source.conditionKey || '');
    item.type = source.type;
    item.priority = source.priority;
    item.sourceType = source.sourceType;
    item.sourceId = String(source.sourceId);
    item.groupKey = '';
    item.conditionKey = source.conditionKey || '';
    if (item.status === REVIEW_STATUS.SNOOZED && due(item.snoozedUntil, now)) {
      item.status = REVIEW_STATUS.NEEDS_ATTENTION;
      item.snoozedUntil = null;
    }
    if (item.status === REVIEW_STATUS.RESOLVED && item.resolution?.decision === 'source_resolved') {
      item.status = REVIEW_STATUS.NEEDS_ATTENTION;
      item.resolution = null;
      item.snoozedUntil = null;
    }
    if (conditionChanged) item.updatedAt = timestamp;
    merged.push(item);
  }
  for (const item of previousMissing) {
    if (activeIds.has(item.id)) continue;
    if (item.status !== REVIEW_STATUS.RESOLVED) {
      item.status = REVIEW_STATUS.RESOLVED;
      item.snoozedUntil = null;
      item.updatedAt = timestamp;
      item.resolution = { decision: 'source_resolved', resolvedAt: timestamp };
    }
    merged.push(item);
  }
  const nonMissing = (state.reviewItems || []).filter((item) => item?.type !== 'missing_income');
  const resolved = merged.filter((item) => item.status === REVIEW_STATUS.RESOLVED).slice(-5000);
  const active = merged.filter((item) => item.status !== REVIEW_STATUS.RESOLVED);
  state.reviewItems = [...nonMissing, ...resolved, ...active]
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || String(a.id).localeCompare(String(b.id)));
}

function extractMissing(state) {
  const missing = (state.reviewItems || []).filter((item) => item?.type === 'missing_income').map((item) => structuredClone(item));
  state.reviewItems = (state.reviewItems || []).filter((item) => item?.type !== 'missing_income');
  return missing;
}

function restoreMissing(state, missing) {
  state.reviewItems = [...(state.reviewItems || []).filter((item) => item?.type !== 'missing_income'), ...missing];
}

function createMissingItem(source, id, timestamp) {
  return {
    id, type: source.type, status: REVIEW_STATUS.NEEDS_ATTENTION, priority: source.priority,
    createdAt: timestamp, updatedAt: timestamp, snoozedUntil: null,
    sourceType: source.sourceType, sourceId: String(source.sourceId), groupKey: '', conditionKey: source.conditionKey || '',
    resolution: null, snoozeCount: 0, lastSnoozedAt: null
  };
}

function missingPresentation(state, item, now) {
  return missingIncomePresentation(state, item?.sourceId, now) || {
    title: 'Expected income needs review',
    detail: 'The expected payday window passed without reliable matching income.',
    why: 'OneStep never assumes expected income has arrived.',
    action: 'Review payday',
    consequence: 'Correcting the schedule or receiving the income clears this item.'
  };
}

function legacyPaydayDate(paydayDay, now) {
  const day = knownPaydayDay(paydayDay);
  if (!day) return null;
  const date = validDate(now);
  let year = date.getFullYear();
  let month = date.getMonth() + 1;
  const today = `${year}-${String(month).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  let candidate = monthDate(year, month, day);
  if (candidate < today) {
    month += 1;
    if (month > 12) { month = 1; year += 1; }
    candidate = monthDate(year, month, day);
  }
  return candidate;
}

function monthDate(year, month, day) {
  const finalDay = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(day, finalDay)).padStart(2, '0')}`;
}

function snoozeUntil(choice, now, paydayDate) {
  const target = validDate(now);
  target.setHours(9, 0, 0, 0);
  if (choice === 'tomorrow') target.setDate(target.getDate() + 1);
  else if (choice === 'next_week') target.setDate(target.getDate() + 7);
  else if (choice === 'weekend') {
    const days = (6 - target.getDay() + 7) % 7;
    target.setDate(target.getDate() + (days || 7));
  } else if (choice === 'payday') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(paydayDate || ''))) return null;
    const [year, month, day] = paydayDate.split('-').map(Number);
    target.setFullYear(year, month - 1, day);
  } else return null;
  return target.toISOString();
}

function requireOpenItem(state, itemId) {
  const item = (state.reviewItems || []).find((entry) => entry.id === itemId);
  if (!item || item.status === REVIEW_STATUS.RESOLVED) {
    const error = new Error('This review item is no longer active.');
    error.code = REVIEW_DIAGNOSTIC_CODES.STATE_INVALID;
    throw error;
  }
  return item;
}

function reviewItemId(type, sourceType, sourceId) { return `review:${safeToken(type, 60)}:${safeToken(sourceType, 40)}:${hashId(String(sourceId))}`; }
function hashId(value) { let hash = 2166136261; for (const character of value) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `${(hash >>> 0).toString(36)}-${value.length}`; }
function safeToken(value, length) { return String(value || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, length); }
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? new Date() : date; }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function due(value, now) { return !validIso(value) || Date.parse(value) <= validDate(now).getTime(); }
function nonNegativeInteger(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 ? number : 0; }
function priorityRank(value) { return ({ high: 0, normal: 1, low: 2 })[value] ?? 3; }
function compareReviewPriority(left, right) { return priorityRank(left.priority) - priorityRank(right.priority) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id).localeCompare(String(right.id)); }
