import {
  createUserFinancialReminder, dismissFinancialReminderForToday,
  listFinancialReminderSources, removeUserFinancialReminder, setFinancialReminderConfiguration
} from './financial-reminders.js';

let state = null;

export function renderFinancialRemindersPanel(nextState) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  state = nextState;
  const grid = document.querySelector('#view-settings .settings-grid');
  if (!grid || !state) return;
  let panel = document.getElementById('financialRemindersSettings');
  if (!panel) {
    panel = document.createElement('article');
    panel.id = 'financialRemindersSettings';
    panel.className = 'panel';
    grid.append(panel);
    panel.addEventListener('click', onClick);
    panel.addEventListener('change', onChange);
    panel.addEventListener('submit', onSubmit);
  }
  render(panel);
}

function render(panel) {
  const sources = listFinancialReminderSources(state, new Date());
  panel.replaceChildren();
  const heading = el('div', 'panel-heading');
  const copy = el('div');
  copy.append(el('p', 'eyebrow', 'FINANCIAL REMINDERS'), el('h2', '', 'Due dates and reminders'),
    el('p', 'muted', 'OneStep uses confirmed or explicit dates only. Reminders stay on this device and flow through Today and Review Inbox.'));
  heading.append(copy, el('span', 'badge', state.automation?.enabled === false ? 'Paused' : `${sources.filter((item) => item.enabled).length} enabled`));
  panel.append(heading);

  const status = el('p', 'muted'); status.id = 'financialRemindersStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  status.textContent = state.automation?.enabled === false
    ? 'Automations are globally paused. Reminder settings are preserved, but automatic reminder delivery is paused.'
    : 'Reminder timing uses local calendar dates, including month, year and daylight-saving boundaries.';
  panel.append(status, createForm());

  const list = el('div', 'compact-card-list');
  if (!sources.length) list.append(el('p', 'muted', 'No confirmed or explicitly dated financial reminders are available yet. You can add one below.'));
  for (const source of sources.slice(0, 30)) list.append(reminderCard(source));
  panel.append(list);
}

function createForm() {
  const form = el('form', 'form-grid'); form.id = 'financialReminderForm';
  form.append(el('h3', 'wide-field', 'Add a financial reminder'));
  const title = input('reminderTitle', 'text'); title.maxLength = 160; title.required = true; title.placeholder = 'e.g. Review annual insurance renewal';
  const due = input('reminderDueDate', 'date'); due.required = true;
  const days = input('reminderDaysBefore', 'number'); days.min = '0'; days.max = '31'; days.step = '1'; days.value = '3'; days.required = true;
  form.append(field('What is due?', title), field('Due date', due), field('Remind me days before', days));
  const actions = el('div', 'inline-actions wide-field'); const add = el('button', 'primary-button', 'Add reminder'); add.type = 'submit'; actions.append(add); form.append(actions);
  return form;
}

function reminderCard(source) {
  const card = el('article', 'review-card'); card.dataset.reminderSourceType = source.sourceType; card.dataset.reminderSourceId = source.sourceId;
  const head = el('div', 'review-card-heading'); const copy = el('div'); copy.append(el('strong', '', source.title), el('span', 'muted', sourceLabel(source)));
  head.append(copy, el('span', `badge ${source.status === 'overdue' ? 'red' : ''}`.trim(), statusLabel(source))); card.append(head);
  card.append(el('p', 'muted', `${formatDate(source.dueDate)} · reminder ${timingLabel(source.daysBefore)}.`));

  const controls = el('div', 'form-grid');
  const enabledLabel = el('label', 'confirmation-check'); const enabled = input('', 'checkbox'); enabled.checked = source.enabled; enabled.dataset.reminderEnabled = 'true'; enabledLabel.append(enabled, document.createTextNode(source.enabled ? 'Reminder enabled' : 'Reminder paused')); controls.append(enabledLabel);
  const days = input('', 'number'); days.min = '0'; days.max = '31'; days.step = '1'; days.value = String(source.daysBefore); days.dataset.reminderDays = 'true'; controls.append(field('Days before', days));
  card.append(controls);

  const actions = el('div', 'inline-actions');
  const dismiss = el('button', 'secondary-button', source.dismissedToday ? 'Dismissed today' : 'Dismiss for today'); dismiss.type = 'button'; dismiss.dataset.reminderDismiss = 'true'; dismiss.disabled = source.dismissedToday; actions.append(dismiss);
  if (source.sourceType === 'user') { const remove = el('button', 'danger-button', 'Delete reminder'); remove.type = 'button'; remove.dataset.reminderDelete = 'true'; actions.append(remove); }
  card.append(actions);
  return card;
}

async function onSubmit(event) {
  if (event.target.id !== 'financialReminderForm' || !state) return;
  event.preventDefault();
  try {
    const next = createUserFinancialReminder(state, {
      title: document.getElementById('reminderTitle')?.value,
      dueDate: document.getElementById('reminderDueDate')?.value,
      daysBefore: document.getElementById('reminderDaysBefore')?.value
    }, new Date());
    await persist(next, 'Financial reminder added.');
  } catch (error) { setStatus(error?.message || 'That reminder could not be added.'); }
}

async function onChange(event) {
  const card = event.target.closest('[data-reminder-source-type]');
  if (!card || !state || (!event.target.matches('[data-reminder-enabled]') && !event.target.matches('[data-reminder-days]'))) return;
  const source = currentSource(card); if (!source) return;
  const enabled = card.querySelector('[data-reminder-enabled]')?.checked !== false;
  const daysBefore = card.querySelector('[data-reminder-days]')?.value;
  try {
    const next = setFinancialReminderConfiguration(state, {
      sourceType: source.sourceType, sourceId: source.sourceId, enabled, daysBefore,
      title: source.title, dueDate: source.dueDate
    }, new Date());
    await persist(next, enabled ? 'Reminder settings saved.' : 'Reminder paused.');
  } catch (error) { setStatus(error?.message || 'That reminder setting could not be saved.'); }
}

async function onClick(event) {
  const card = event.target.closest('[data-reminder-source-type]'); if (!card || !state) return;
  const source = currentSource(card); if (!source) return;
  if (event.target.closest('[data-reminder-dismiss]')) {
    try { await persist(dismissFinancialReminderForToday(state, source.sourceType, source.sourceId, new Date()), 'Reminder dismissed for today. The financial source was not deleted.'); }
    catch (error) { setStatus(error?.message || 'That reminder could not be dismissed.'); }
    return;
  }
  if (event.target.closest('[data-reminder-delete]') && source.sourceType === 'user') {
    if (!window.confirm(`Delete “${source.title}”? This removes only the reminder, not any financial records.`)) return;
    await persist(removeUserFinancialReminder(state, source.sourceId), 'Reminder deleted.');
  }
}

function currentSource(card) {
  return listFinancialReminderSources(state, new Date()).find((item) => item.sourceType === card.dataset.reminderSourceType && item.sourceId === card.dataset.reminderSourceId) || null;
}

async function persist(next, message) {
  try {
    const saved = await window.financeAPI.saveState(next);
    if (saved?.status === 'blocked' || saved?.status === 'conflict') throw new Error(saved.message || 'The reminder could not be saved safely.');
    state = saved; setStatus(message); window.setTimeout(() => window.location.reload(), 120);
  } catch (error) { setStatus(error?.message || 'The reminder could not be saved.'); }
}

function sourceLabel(source) {
  if (source.sourceType === 'recurring_pattern') return 'Confirmed recurring commitment';
  if (source.sourceType === 'scheduled_payment') return 'Scheduled payment';
  if (source.sourceType === 'review_due') return 'Existing Review Inbox item';
  return 'Your reminder';
}
function statusLabel(source) { return source.status === 'due_today' ? 'Due today' : source.status === 'overdue' ? 'Overdue' : source.dismissedToday ? 'Dismissed today' : 'Upcoming'; }
function timingLabel(days) { return Number(days) === 0 ? 'on the due date' : `${days} day${Number(days) === 1 ? '' : 's'} before`; }
function formatDate(value) { const [year, month, day] = String(value || '').split('-').map(Number); const date = new Date(Date.UTC(year, month - 1, day, 12)); return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date); }
function setStatus(message) { const node = document.getElementById('financialRemindersStatus'); if (node) node.textContent = message; }
function field(labelText, control) { const label = el('label'); label.append(document.createTextNode(labelText), control); return label; }
function input(id, type) { const node = document.createElement('input'); if (id) node.id = id; node.type = type; return node; }
function el(tag, className = '', text = '') { const node = document.createElement(tag); if (className) node.className = className; if (text) node.textContent = text; return node; }
