import { confirmedRecurringPatterns } from './recurring-finance.js';

const MAX_CONFIGS = 500;
const MAX_TEXT = 160;
const MAX_DAYS_BEFORE = 31;
const FAR_FUTURE_DATE = '9999-12-31';
const SAFE_SOURCE_TYPES = new Set(['recurring_pattern', 'scheduled_payment', 'review_due', 'user']);

export const FINANCIAL_REMINDER_DEFAULT_DAYS = 3;
export const FINANCIAL_REMINDER_TIMING_OPTIONS = Object.freeze([0, 1, 3, 7]);
export const FINANCIAL_REMINDER_STATUS = Object.freeze({
  UPCOMING: 'upcoming',
  DUE_TODAY: 'due_today',
  OVERDUE: 'overdue',
  RESOLVED: 'resolved'
});

export function normaliseFinancialReminderCollection(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const input of value) {
    const config = normaliseConfig(input);
    if (!config || seen.has(config.id)) continue;
    seen.add(config.id);
    output.push(config);
    if (output.length >= MAX_CONFIGS) break;
  }
  return output.sort((left, right) => left.id.localeCompare(right.id));
}

export function listFinancialReminderSources(state = {}, now = new Date()) {
  const sources = [
    ...confirmedRecurringSources(state),
    ...scheduledPaymentSources(state),
    ...reviewDueSources(state),
    ...userReminderSources(state)
  ];
  const configs = configMap(state);
  const today = localDateKey(now);
  return sources.map((source) => {
    const config = configs.get(configId(source.sourceType, source.sourceId));
    const daysBefore = config?.daysBefore ?? defaultDaysBefore(source.sourceType);
    const triggerDate = shiftLocalDate(source.dueDate, -daysBefore);
    const status = reminderStatus(source.dueDate, today);
    const enabled = config?.enabled !== false;
    const dismissedToday = config?.dismissedUntil === today;
    return {
      ...source,
      configId: configId(source.sourceType, source.sourceId),
      taskId: reminderTaskId(source.sourceType, source.sourceId, source.dueDate),
      enabled,
      daysBefore,
      triggerDate,
      status,
      dismissedToday,
      relevant: enabled && !dismissedToday && status !== FINANCIAL_REMINDER_STATUS.RESOLVED && today >= triggerDate,
      automationPaused: state?.automation?.enabled === false
    };
  }).sort(compareSources);
}

export function synchroniseFinancialReminders(state = {}, now = new Date()) {
  const target = state && typeof state === 'object' ? state : {};
  target.automation = isPlainObject(target.automation) ? target.automation : {};
  target.automation.reminders = normaliseFinancialReminderCollection(target.automation.reminders);
  target.tasks = Array.isArray(target.tasks) ? target.tasks : [];

  const timestamp = validDate(now).toISOString();
  const automationPaused = target.automation.enabled === false;
  let changed = synchroniseRuleReminderPause(target.tasks, automationPaused, timestamp);
  const sources = listFinancialReminderSources(target, now);
  const desired = new Map();
  const nextTasks = [];
  const existingManaged = new Map();
  for (const task of target.tasks) {
    if (task?.source === 'financial_reminder' && task?.reminderTaskId) existingManaged.set(String(task.reminderTaskId), task);
    else nextTasks.push(task);
  }

  for (const source of sources) {
    if (source.sourceType === 'review_due') continue;
    if (source.relevant || existingManaged.has(source.taskId)) desired.set(source.taskId, source);
  }

  for (const [taskId, source] of desired) {
    const previous = existingManaged.get(taskId);
    if (!previous && (automationPaused || !source.enabled || source.dismissedToday || localDateKey(now) < source.triggerDate)) continue;
    const task = reminderTask(source, previous, timestamp, now);
    if (!previous || !sameReminderTask(previous, task)) changed = true;
    nextTasks.push(task);
    existingManaged.delete(taskId);
  }
  if (existingManaged.size) changed = true;

  if (changed) target.tasks = nextTasks;
  return { state: target, changed, reminders: sources };
}

export function setFinancialReminderConfiguration(state, input, now = new Date()) {
  const next = structuredClone(state || {});
  next.automation = isPlainObject(next.automation) ? next.automation : {};
  const configs = normaliseFinancialReminderCollection(next.automation.reminders);
  const sourceType = safeSourceType(input?.sourceType);
  const sourceId = safeSourceId(input?.sourceId);
  if (!sourceType || !sourceId) throw new TypeError('Choose a valid financial reminder source.');
  const id = configId(sourceType, sourceId);
  const existing = configs.find((item) => item.id === id);
  const timestamp = validDate(now).toISOString();
  const daysBefore = normaliseDaysBefore(input?.daysBefore ?? existing?.daysBefore ?? defaultDaysBefore(sourceType));
  const saved = {
    id,
    sourceType,
    sourceId,
    enabled: input?.enabled !== false,
    daysBefore,
    title: sourceType === 'user' ? safeText(input?.title ?? existing?.title, MAX_TEXT) : '',
    dueDate: sourceType === 'user' ? localDateKey(input?.dueDate ?? existing?.dueDate) : '',
    dismissedUntil: validLocalDate(input?.dismissedUntil) ? String(input.dismissedUntil) : existing?.dismissedUntil || '',
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp
  };
  if (sourceType === 'user' && (!saved.title || !saved.dueDate)) throw new TypeError('User-created reminders need a title and due date.');
  const index = configs.findIndex((item) => item.id === id);
  if (index >= 0) configs.splice(index, 1, saved);
  else {
    if (configs.length >= MAX_CONFIGS) throw new Error(`OneStep supports up to ${MAX_CONFIGS} reminder configurations.`);
    configs.push(saved);
  }
  next.automation.reminders = normaliseFinancialReminderCollection(configs);
  return next;
}

export function createUserFinancialReminder(state, input, now = new Date()) {
  const title = safeText(input?.title, MAX_TEXT);
  const dueDate = localDateKey(input?.dueDate);
  if (!title || !dueDate) throw new TypeError('Give the reminder a title and a valid due date.');
  const sourceId = safeSourceId(input?.sourceId) || `user_${shortHash(`${title}|${dueDate}|${validDate(now).toISOString()}`)}`;
  return setFinancialReminderConfiguration(state, {
    sourceType: 'user', sourceId, title, dueDate,
    daysBefore: input?.daysBefore ?? FINANCIAL_REMINDER_DEFAULT_DAYS,
    enabled: input?.enabled !== false
  }, now);
}

export function removeUserFinancialReminder(state, sourceId) {
  const next = structuredClone(state || {});
  next.automation = isPlainObject(next.automation) ? next.automation : {};
  next.automation.reminders = normaliseFinancialReminderCollection(next.automation.reminders)
    .filter((config) => !(config.sourceType === 'user' && config.sourceId === safeSourceId(sourceId)));
  next.tasks = (Array.isArray(next.tasks) ? next.tasks : []).filter((task) => !(task?.source === 'financial_reminder' && task?.reminderSourceType === 'user' && task?.reminderSourceId === safeSourceId(sourceId)));
  return next;
}

export function dismissFinancialReminderForToday(state, sourceType, sourceId, now = new Date()) {
  const type = safeSourceType(sourceType);
  const id = safeSourceId(sourceId);
  if (!type || !id) throw new TypeError('Choose a valid financial reminder.');
  const existing = configMap(state).get(configId(type, id));
  const source = listFinancialReminderSources(state, now).find((item) => item.sourceType === type && item.sourceId === id);
  if (!existing && !source) throw new Error('That financial reminder is no longer available.');
  return setFinancialReminderConfiguration(state, {
    sourceType: type,
    sourceId: id,
    enabled: existing?.enabled !== false,
    daysBefore: existing?.daysBefore ?? source?.daysBefore ?? defaultDaysBefore(type),
    title: existing?.title || source?.title,
    dueDate: existing?.dueDate || source?.dueDate,
    dismissedUntil: localDateKey(now)
  }, now);
}

export function reminderStatus(dueDate, now = new Date()) {
  const due = localDateKey(dueDate);
  const today = typeof now === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(now) ? localDateKey(now) : localDateKey(now);
  if (!due || !today) return FINANCIAL_REMINDER_STATUS.RESOLVED;
  if (today === due) return FINANCIAL_REMINDER_STATUS.DUE_TODAY;
  return today > due ? FINANCIAL_REMINDER_STATUS.OVERDUE : FINANCIAL_REMINDER_STATUS.UPCOMING;
}

export function reminderTaskId(sourceType, sourceId, dueDate) {
  return `financial_reminder_${shortHash(`${sourceType}|${sourceId}|${dueDate}`)}`;
}

function confirmedRecurringSources(state) {
  return confirmedRecurringPatterns(state)
    .filter((pattern) => pattern.direction === 'outgoing' && pattern.nextExpected?.date && validLocalDate(pattern.nextExpected.date))
    .map((pattern) => ({
      sourceType: 'recurring_pattern', sourceId: String(pattern.id), dueDate: pattern.nextExpected.date,
      title: safeText(pattern.label, MAX_TEXT) || 'Recurring commitment',
      detail: `Confirmed ${String(pattern.cadence || 'recurring').replace(/-/g, ' ')} commitment.`,
      actionView: 'transactions', targetType: '', targetId: ''
    }));
}

function scheduledPaymentSources(state) {
  return (Array.isArray(state.scheduledPayments) ? state.scheduledPayments : [])
    .filter((item) => item?.id && activeScheduledPayment(item))
    .map((item) => {
      const dueDate = authoritativeDueDate(item);
      if (!dueDate) return null;
      return {
        sourceType: 'scheduled_payment', sourceId: String(item.id), dueDate,
        title: safeText(item.name || item.title || item.description || item.payee, MAX_TEXT) || 'Scheduled payment',
        detail: 'Saved scheduled financial commitment.',
        actionView: safeView(item.actionView || item.view) || 'today',
        targetType: safeTargetType(item.targetType), targetId: safeSourceId(item.targetId)
      };
    }).filter(Boolean);
}

function reviewDueSources(state) {
  return (Array.isArray(state.reviewItems) ? state.reviewItems : [])
    .filter((item) => item?.id && item.status !== 'resolved' && validLocalDate(item.dueDate))
    .map((item) => ({
      sourceType: 'review_due', sourceId: String(item.id), dueDate: String(item.dueDate),
      title: safeText(item.title, MAX_TEXT) || 'Financial review due',
      detail: 'This existing Review Inbox item has an explicit due date.',
      actionView: 'review', targetType: '', targetId: ''
    }));
}

function userReminderSources(state) {
  return normaliseFinancialReminderCollection(state?.automation?.reminders)
    .filter((config) => config.sourceType === 'user' && config.title && config.dueDate)
    .map((config) => ({
      sourceType: 'user', sourceId: config.sourceId, dueDate: config.dueDate,
      title: config.title, detail: 'User-created financial reminder.',
      actionView: 'today', targetType: '', targetId: ''
    }));
}

function reminderTask(source, previous, timestamp, now) {
  const statusText = source.status === FINANCIAL_REMINDER_STATUS.DUE_TODAY
    ? 'Due today'
    : source.status === FINANCIAL_REMINDER_STATUS.OVERDUE ? `Due ${formatLocalDate(source.dueDate)} · still unresolved`
      : `Due ${formatLocalDate(source.dueDate)}`;
  const task = {
    id: source.taskId,
    title: source.status === FINANCIAL_REMINDER_STATUS.DUE_TODAY ? `${source.title} is due today`
      : source.status === FINANCIAL_REMINDER_STATUS.OVERDUE ? `${source.title} is overdue`
        : `${source.title} is coming up`,
    detail: `${statusText}. ${source.detail}`,
    priority: 'normal',
    actionView: source.actionView || 'today',
    targetType: source.targetType || '',
    targetId: source.targetId || '',
    source: 'financial_reminder',
    reminderTaskId: source.taskId,
    reminderSourceType: source.sourceType,
    reminderSourceId: source.sourceId,
    reminderDueDate: source.dueDate,
    reminderDaysBefore: source.daysBefore,
    createdAt: previous?.createdAt || timestamp,
    updatedAt: previous && sameDisplayState(previous, source) ? previous.updatedAt || previous.createdAt || timestamp : timestamp,
    completedAt: previous?.completedAt || null,
    snoozedUntil: previous?.snoozedUntil || null
  };
  const today = localDateKey(now);
  const suppressionUntil = source.automationPaused || !source.enabled ? FAR_FUTURE_DATE
    : source.dismissedToday ? shiftLocalDate(today, 1)
      : today < source.triggerDate ? source.triggerDate : '';
  if (suppressionUntil) {
    task.reminderSystemSuppressed = true;
    task.reminderPreviousSnoozedUntil = previous?.reminderSystemSuppressed ? previous.reminderPreviousSnoozedUntil || null : previous?.snoozedUntil || null;
    task.snoozedUntil = suppressionUntil;
  } else if (previous?.reminderSystemSuppressed) {
    task.snoozedUntil = previous.reminderPreviousSnoozedUntil || null;
  }
  return task;
}

function synchroniseRuleReminderPause(tasks, paused, timestamp) {
  let changed = false;
  for (const task of tasks) {
    if (task?.source !== 'automation_rule' || task.completedAt) continue;
    if (paused && !task.reminderPausedByAutomation) {
      task.reminderPausedByAutomation = true;
      task.reminderPausePreviousSnoozedUntil = task.snoozedUntil || null;
      task.snoozedUntil = FAR_FUTURE_DATE;
      task.updatedAt = timestamp;
      changed = true;
    } else if (!paused && task.reminderPausedByAutomation) {
      task.snoozedUntil = task.reminderPausePreviousSnoozedUntil || null;
      delete task.reminderPausePreviousSnoozedUntil;
      delete task.reminderPausedByAutomation;
      task.updatedAt = timestamp;
      changed = true;
    }
  }
  return changed;
}

function sameDisplayState(task, source) {
  return task.reminderDueDate === source.dueDate && task.reminderDaysBefore === source.daysBefore
    && task.reminderSourceType === source.sourceType && task.reminderSourceId === source.sourceId
    && ((source.status === FINANCIAL_REMINDER_STATUS.DUE_TODAY && task.title === `${source.title} is due today`)
      || (source.status === FINANCIAL_REMINDER_STATUS.OVERDUE && task.title === `${source.title} is overdue`)
      || (source.status === FINANCIAL_REMINDER_STATUS.UPCOMING && task.title === `${source.title} is coming up`));
}

function sameReminderTask(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configMap(state) {
  return new Map(normaliseFinancialReminderCollection(state?.automation?.reminders).map((config) => [config.id, config]));
}

function normaliseConfig(input) {
  if (!isPlainObject(input)) return null;
  const sourceType = safeSourceType(input.sourceType);
  const sourceId = safeSourceId(input.sourceId);
  if (!sourceType || !sourceId) return null;
  const id = configId(sourceType, sourceId);
  const title = sourceType === 'user' ? safeText(input.title, MAX_TEXT) : '';
  const dueDate = sourceType === 'user' ? localDateKey(input.dueDate) : '';
  if (sourceType === 'user' && (!title || !dueDate)) return null;
  return {
    id,
    sourceType,
    sourceId,
    enabled: input.enabled !== false,
    daysBefore: normaliseDaysBefore(input.daysBefore ?? defaultDaysBefore(sourceType)),
    title,
    dueDate,
    dismissedUntil: validLocalDate(input.dismissedUntil) ? String(input.dismissedUntil) : '',
    createdAt: validIso(input.createdAt) ? input.createdAt : null,
    updatedAt: validIso(input.updatedAt) ? input.updatedAt : null
  };
}

function authoritativeDueDate(item) {
  for (const field of ['dueDate', 'scheduledDate', 'paymentDate', 'date']) {
    if (validLocalDate(item?.[field])) return String(item[field]).slice(0, 10);
  }
  return '';
}
function activeScheduledPayment(item) { return !['paid', 'cancelled', 'completed', 'resolved'].includes(String(item.status || '').trim().toLowerCase()); }
function defaultDaysBefore(sourceType) { return sourceType === 'review_due' ? 0 : FINANCIAL_REMINDER_DEFAULT_DAYS; }
function normaliseDaysBefore(value) { const number = Number(value); return Number.isInteger(number) && number >= 0 && number <= MAX_DAYS_BEFORE ? number : FINANCIAL_REMINDER_DEFAULT_DAYS; }
function configId(sourceType, sourceId) { return `reminder_${shortHash(`${sourceType}|${sourceId}`)}`; }
function safeSourceType(value) { const type = String(value || ''); return SAFE_SOURCE_TYPES.has(type) ? type : ''; }
function safeSourceId(value) { return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 160); }
function safeText(value, limit) { return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, limit); }
function safeView(value) { const view = String(value || ''); return ['today', 'review', 'transactions', 'pay', 'debts', 'overdrafts', 'budget', 'documents', 'settings'].includes(view) ? view : ''; }
function safeTargetType(value) { const type = String(value || ''); return ['transaction', 'debt', 'overdraft'].includes(type) ? type : ''; }
function compareSources(left, right) { return left.dueDate.localeCompare(right.dueDate) || left.title.localeCompare(right.title) || left.sourceId.localeCompare(right.sourceId); }
function validLocalDate(value) { return Boolean(localDateKey(value)); }
function localDateKey(value = new Date()) {
  if (typeof value === 'string') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
    const [year, month, day] = value.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? value : '';
  }
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function shiftLocalDate(value, days) {
  const key = localDateKey(value); if (!key) return '';
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}
function formatLocalDate(value) {
  const key = localDateKey(value); if (!key) return 'date unavailable';
  const [year, month, day] = key.split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day, 12)));
}
function shortHash(value) { let hash = 2166136261; for (const character of String(value)) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 16777619); } return `${(hash >>> 0).toString(36)}_${String(value).length}`; }
function pad(value) { return String(value).padStart(2, '0'); }
function validIso(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value; }
function validDate(value) { const date = value instanceof Date ? new Date(value) : new Date(value); return Number.isNaN(date.getTime()) ? new Date() : date; }
function isPlainObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
