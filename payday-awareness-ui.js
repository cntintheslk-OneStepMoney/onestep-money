import {
  buildPaydayContext, deriveIncomeSchedules, PAYDAY_RULE, PAYDAY_TIMING, removeIncomeSchedule,
  RECURRING_CADENCE, upsertIncomeSchedule, WEEKEND_ADJUSTMENT
} from './payday-awareness.js';

let latestState = null;
let editingScheduleId = '';

export function renderPaydayAwareness(state) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  latestState = state;
  const context = buildPaydayContext(state, { now: new Date() });
  renderDashboard(context);
  renderToday(context);
  renderSettings(context);
}

function renderDashboard(context) {
  const module = document.querySelector('[data-dashboard-module="upcoming"]');
  if (!module) return;
  let container = document.getElementById('dashboardPaydayAwareness');
  if (!container) {
    container = document.createElement('div');
    container.id = 'dashboardPaydayAwareness';
    container.className = 'dashboard-list';
    module.append(container);
  }
  container.replaceChildren();
  const next = context.nextPayday;
  const safe = context.safeUntilPayday;
  container.append(summaryRow('Next dependable payday', next ? `${formatDate(next.date)} · ${next.source}` : 'Not known yet'));
  container.append(summaryRow('Safe Until Payday', safe.status === 'available' ? formatMoney(safe.amount) : 'Unavailable'));
  if (context.missing.length) container.append(summaryRow('Income review', `${context.missing.length} expected ${context.missing.length === 1 ? 'payment needs' : 'payments need'} checking`));
}

function renderToday(context) {
  const view = document.getElementById('view-today');
  if (!view) return;
  let panel = document.getElementById('paydayTodayPanel');
  if (!panel) {
    panel = document.createElement('article');
    panel.id = 'paydayTodayPanel';
    panel.className = 'panel';
    const metricGrid = view.querySelector('.metric-grid');
    view.insertBefore(panel, metricGrid || view.firstChild);
  }
  panel.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'panel-heading';
  const copy = document.createElement('div');
  const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'PAYDAY AWARENESS';
  const title = document.createElement('h2'); title.textContent = 'Safe until the next dependable income';
  copy.append(eyebrow, title); heading.append(copy); panel.append(heading);
  const grid = document.createElement('div'); grid.className = 'metric-grid three';
  grid.append(metric('Next payday', context.nextPayday ? formatDate(context.nextPayday.date) : 'Unknown', context.nextPayday?.source || 'Add or confirm an income schedule'));
  const stream = context.streams.find((item) => item.id === context.nextPayday?.streamId) || context.streams.find((item) => item.status === 'missing') || context.streams[0];
  grid.append(metric('Income status', stream ? titleCase(stream.status) : 'Unknown', stream?.name || 'No dependable income stream'));
  grid.append(metric('Safe Until Payday', context.safeUntilPayday.status === 'available' ? formatMoney(context.safeUntilPayday.amount) : 'Unavailable', context.safeUntilPayday.status === 'available' ? `Protected through ${formatDate(context.safeUntilPayday.horizonDate)}` : safeReason(context.safeUntilPayday)));
  panel.append(grid);
  const why = document.createElement('details'); why.className = 'plan-why';
  const summary = document.createElement('summary'); summary.textContent = 'Why?';
  const list = document.createElement('ul');
  const safe = context.safeUntilPayday;
  if (safe.status === 'available') {
    list.append(li(`Starts from trusted liquid money and protects ${formatMoney(safe.protected.total)} of known commitments/buffer before the next payday.`));
    list.append(li('Expected future income is not included until OneStep finds reliable received evidence.'));
    if (safe.protected.scheduled) list.append(li(`${formatMoney(safe.protected.scheduled)} protected for dated scheduled commitments.`));
    if (safe.protected.recurring) list.append(li(`${formatMoney(safe.protected.recurring)} protected for confirmed recurring commitments.`));
    if (safe.protected.debt) list.append(li(`${formatMoney(safe.protected.debt)} protected for required debt or arrangement payments.`));
    if (safe.protected.buffer) list.append(li(`${formatMoney(safe.protected.buffer)} protected for the selected starter/emergency buffer.`));
  } else {
    for (const reason of safe.reasonCodes || []) list.append(li(reasonText(reason)));
  }
  why.append(summary, list); panel.append(why);
}

function renderSettings(context) {
  const grid = document.querySelector('#view-settings .settings-grid');
  if (!grid) return;
  const legacy = document.getElementById('paydayDayInput');
  if (legacy) {
    const label = legacy.closest('label');
    if (label) label.hidden = true;
    const note = label?.nextElementSibling;
    if (note?.classList.contains('muted') && /Snooze until payday|payday automation/i.test(note.textContent || '')) note.hidden = true;
  }
  let panel = document.getElementById('incomeScheduleSettings');
  if (!panel) {
    panel = document.createElement('article'); panel.id = 'incomeScheduleSettings'; panel.className = 'panel';
    const planning = document.getElementById('dependableIncomeInput')?.closest('article');
    if (planning?.nextSibling) grid.insertBefore(panel, planning.nextSibling); else grid.append(panel);
    panel.addEventListener('click', handleScheduleClick);
    panel.addEventListener('submit', handleScheduleSubmit);
    panel.addEventListener('change', handleScheduleFormChange);
  }
  panel.replaceChildren();
  const title = document.createElement('h2'); title.textContent = 'Paydays & income schedules';
  const intro = document.createElement('p'); intro.className = 'muted'; intro.textContent = 'Keep each dependable income stream separate. OneStep uses local dates only and never assumes expected income has arrived.';
  panel.append(title, intro);
  const status = document.createElement('p'); status.id = 'incomeScheduleStatus'; status.className = 'muted'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
  const list = document.createElement('div'); list.className = 'compact-card-list';
  for (const schedule of context.schedules) list.append(scheduleCard(schedule));
  if (!context.schedules.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No dependable payday is configured yet. Confirm a detected recurring income or add one below.'; list.append(empty); }
  panel.append(list, scheduleForm(context.schedules));
  const note = document.createElement('p'); note.className = 'muted'; note.textContent = '“Working day” means Monday–Friday only. OneStep does not invent UK bank-holiday certainty or contact a remote calendar service.'; panel.append(note);
}

function scheduleCard(schedule) {
  const card = document.createElement('article'); card.className = 'review-card';
  const heading = document.createElement('div'); heading.className = 'review-card-heading';
  const copy = document.createElement('div');
  const strong = document.createElement('strong'); strong.textContent = schedule.name;
  const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = `${titleCase(schedule.cadence)} · ${ruleLabel(schedule)} · ${schedule.timingRelationship === PAYDAY_TIMING.ARREARS ? 'Pay in arrears' : 'Current earning period'}`;
  copy.append(strong, detail);
  const badge = document.createElement('span'); badge.className = 'badge'; badge.textContent = schedule.confirmation === 'user' ? 'Confirmed' : 'Inferred';
  heading.append(copy, badge); card.append(heading);
  const amount = document.createElement('p'); amount.className = 'muted'; amount.textContent = schedule.expectedAmountRange ? `Expected ${rangeMoney(schedule.expectedAmountRange)}` : 'Expected amount not fixed'; card.append(amount);
  const actions = document.createElement('div'); actions.className = 'inline-actions';
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'secondary-button'; edit.dataset.paydayEdit = schedule.id; edit.textContent = schedule.confirmation === 'user' ? 'Edit' : 'Confirm & edit'; actions.append(edit);
  if (schedule.confirmation === 'user') { const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'danger-button'; remove.dataset.paydayRemove = schedule.id; remove.textContent = 'Remove'; actions.append(remove); }
  card.append(actions); return card;
}

function scheduleForm(schedules) {
  const source = schedules.find((item) => item.id === editingScheduleId) || null;
  const form = document.createElement('form'); form.id = 'incomeScheduleForm'; form.className = 'form-grid';
  form.append(field('Income/source name', input('scheduleName', source?.name || '', 'text', true)));
  form.append(field('Match text in income evidence', input('scheduleMatchText', source?.matchText || '', 'text', false)));
  form.append(field('Cadence', select('scheduleCadence', [['monthly', 'Monthly'], ['four-weekly', 'Four-weekly'], ['fortnightly', 'Fortnightly'], ['weekly', 'Weekly']], source?.cadence || 'monthly')));
  form.append(field('Monthly payday rule', select('scheduleRule', [[PAYDAY_RULE.FIXED_DAY, 'Fixed day of month'], [PAYDAY_RULE.LAST_WORKING_DAY, 'Last working day'], [PAYDAY_RULE.LAST_WEEKDAY, 'Last selected weekday']], source?.rule?.type === PAYDAY_RULE.ANCHOR ? PAYDAY_RULE.FIXED_DAY : source?.rule?.type || PAYDAY_RULE.FIXED_DAY)));
  form.append(field('Day of month', input('scheduleDay', source?.rule?.day || '28', 'number', false, { min: '1', max: '31' })));
  form.append(field('Selected weekday', select('scheduleWeekday', [['1','Monday'],['2','Tuesday'],['3','Wednesday'],['4','Thursday'],['5','Friday'],['6','Saturday'],['0','Sunday']], String(source?.rule?.weekday ?? 5))));
  form.append(field('Weekend adjustment', select('scheduleWeekend', [[WEEKEND_ADJUSTMENT.NONE,'No adjustment'],[WEEKEND_ADJUSTMENT.PREVIOUS,'Previous weekday'],[WEEKEND_ADJUSTMENT.NEXT,'Next weekday']], source?.rule?.weekendAdjustment || WEEKEND_ADJUSTMENT.NONE)));
  form.append(field('Anchor date (weekly / fortnightly / four-weekly)', input('scheduleAnchor', source?.rule?.anchorDate || source?.effectiveFrom || '', 'date', false)));
  form.append(field('Pay timing', select('scheduleTiming', [[PAYDAY_TIMING.CURRENT,'Current earning period'],[PAYDAY_TIMING.ARREARS,'Paid in arrears / month in lieu'],[PAYDAY_TIMING.OTHER,'Other timing relationship']], source?.timingRelationship || PAYDAY_TIMING.CURRENT)));
  form.append(field('Expected minimum · optional', input('scheduleMin', source?.expectedAmountRange?.min ?? '', 'number', false, { min: '0', step: '0.01' })));
  form.append(field('Expected maximum · optional', input('scheduleMax', source?.expectedAmountRange?.max ?? '', 'number', false, { min: '0', step: '0.01' })));
  const active = document.createElement('label'); active.className = 'confirmation-check'; const checkbox = document.createElement('input'); checkbox.id = 'scheduleActive'; checkbox.type = 'checkbox'; checkbox.checked = source?.active !== false; active.append(checkbox, document.createTextNode('Active dependable income stream')); form.append(active);
  const actions = document.createElement('div'); actions.className = 'button-row';
  const save = document.createElement('button'); save.type = 'submit'; save.className = 'primary-button'; save.textContent = source ? (source.confirmation === 'user' ? 'Save income schedule' : 'Confirm income schedule') : 'Add income schedule'; actions.append(save);
  if (source) { const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'secondary-button'; cancel.dataset.paydayCancel = 'true'; cancel.textContent = 'Cancel'; actions.append(cancel); }
  form.append(actions); queueMicrotask(updateScheduleFormVisibility); return form;
}

async function handleScheduleSubmit(event) {
  if (event.target.id !== 'incomeScheduleForm' || !latestState || !window.financeAPI?.saveState) return;
  event.preventDefault();
  const form = event.target; const source = deriveIncomeSchedules(latestState).find((item) => item.id === editingScheduleId) || null;
  const cadence = form.querySelector('#scheduleCadence').value;
  const ruleType = form.querySelector('#scheduleRule').value;
  const anchorDate = form.querySelector('#scheduleAnchor').value;
  const rule = cadence === RECURRING_CADENCE.MONTHLY
    ? ruleType === PAYDAY_RULE.LAST_WORKING_DAY ? { type: ruleType }
      : ruleType === PAYDAY_RULE.LAST_WEEKDAY ? { type: ruleType, weekday: Number(form.querySelector('#scheduleWeekday').value) }
        : { type: PAYDAY_RULE.FIXED_DAY, day: Number(form.querySelector('#scheduleDay').value), weekendAdjustment: form.querySelector('#scheduleWeekend').value }
    : { type: PAYDAY_RULE.ANCHOR, anchorDate };
  const range = amountRange(form.querySelector('#scheduleMin').value, form.querySelector('#scheduleMax').value);
  const input = {
    ...(source || {}), id: source?.confirmation === 'user' ? source.id : '',
    sourceType: source?.sourceType || 'manual', sourceId: source?.sourceId || '',
    name: form.querySelector('#scheduleName').value, matchText: form.querySelector('#scheduleMatchText').value,
    accountId: source?.accountId || '', cadence, rule,
    timingRelationship: form.querySelector('#scheduleTiming').value,
    expectedAmountRange: range, active: form.querySelector('#scheduleActive').checked,
    effectiveFrom: source?.effectiveFrom || anchorDate || undefined
  };
  await saveScheduleChange(() => upsertIncomeSchedule(latestState, input, new Date()), 'Income schedule saved.');
}

async function handleScheduleClick(event) {
  const edit = event.target.closest('[data-payday-edit]');
  const remove = event.target.closest('[data-payday-remove]');
  const cancel = event.target.closest('[data-payday-cancel]');
  if (cancel) { editingScheduleId = ''; renderSettings(buildPaydayContext(latestState)); return; }
  if (edit) { editingScheduleId = edit.dataset.paydayEdit; renderSettings(buildPaydayContext(latestState)); document.getElementById('scheduleName')?.focus(); return; }
  if (remove && latestState && window.financeAPI?.saveState) await saveScheduleChange(() => removeIncomeSchedule(latestState, remove.dataset.paydayRemove), 'Income schedule removed.');
}

function handleScheduleFormChange(event) {
  if (['scheduleCadence','scheduleRule'].includes(event.target.id)) updateScheduleFormVisibility();
}

async function saveScheduleChange(buildNext, success) {
  const status = document.getElementById('incomeScheduleStatus');
  if (status) status.textContent = 'Saving payday settings…';
  try {
    latestState = await window.financeAPI.saveState(buildNext());
    editingScheduleId = '';
    if (status) status.textContent = success;
    window.setTimeout(() => window.location.reload(), 150);
  } catch (error) {
    if (status) status.textContent = error?.message || 'The payday settings could not be saved.';
  }
}

function updateScheduleFormVisibility() {
  const cadence = document.getElementById('scheduleCadence')?.value;
  const rule = document.getElementById('scheduleRule')?.value;
  setFieldHidden('scheduleRule', cadence !== RECURRING_CADENCE.MONTHLY);
  setFieldHidden('scheduleDay', cadence !== RECURRING_CADENCE.MONTHLY || rule !== PAYDAY_RULE.FIXED_DAY);
  setFieldHidden('scheduleWeekend', cadence !== RECURRING_CADENCE.MONTHLY || rule !== PAYDAY_RULE.FIXED_DAY);
  setFieldHidden('scheduleWeekday', cadence !== RECURRING_CADENCE.MONTHLY || rule !== PAYDAY_RULE.LAST_WEEKDAY);
  setFieldHidden('scheduleAnchor', cadence === RECURRING_CADENCE.MONTHLY);
}

function setFieldHidden(id, hidden) { const control = document.getElementById(id); if (control?.closest('label')) control.closest('label').hidden = hidden; }
function summaryRow(label, value) { const row = document.createElement('div'); row.className = 'dashboard-list-row horizontal'; const name = document.createElement('span'); name.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; row.append(name, strong); return row; }
function metric(label, value, hint) { const article = document.createElement('article'); article.className = 'metric-card'; const span = document.createElement('span'); span.textContent = label; const strong = document.createElement('strong'); strong.textContent = value; const small = document.createElement('small'); small.textContent = hint; article.append(span, strong, small); return article; }
function li(text) { const item = document.createElement('li'); item.textContent = text; return item; }
function field(labelText, control) { const label = document.createElement('label'); label.append(document.createTextNode(labelText), control); return label; }
function input(id, value, type, required, attrs = {}) { const control = document.createElement('input'); control.id = id; control.type = type; control.value = value ?? ''; control.required = required; for (const [key,val] of Object.entries(attrs)) control.setAttribute(key,val); return control; }
function select(id, options, value) { const control = document.createElement('select'); control.id = id; for (const [itemValue,label] of options) { const option = document.createElement('option'); option.value = itemValue; option.textContent = label; option.selected = String(itemValue) === String(value); control.append(option); } return control; }
function amountRange(minValue, maxValue) { const min = minValue === '' ? null : Number(minValue); const max = maxValue === '' ? null : Number(maxValue); return min === null && max === null ? null : { min, max }; }
function ruleLabel(schedule) { if (schedule.cadence !== 'monthly') return `Anchored ${formatDate(schedule.rule.anchorDate)}`; if (schedule.rule.type === PAYDAY_RULE.LAST_WORKING_DAY) return 'Last working day'; if (schedule.rule.type === PAYDAY_RULE.LAST_WEEKDAY) return `Last ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][schedule.rule.weekday]}`; return `Day ${schedule.rule.day}${schedule.rule.weekendAdjustment !== 'none' ? ` · ${schedule.rule.weekendAdjustment} weekday if weekend` : ''}`; }
function rangeMoney(range) { if (range.min !== null && range.max !== null) return range.min === range.max ? formatMoney(range.min) : `${formatMoney(range.min)}–${formatMoney(range.max)}`; return formatMoney(range.min ?? range.max); }
function formatMoney(value) { const currency = String(latestState?.profile?.currency || 'GBP').toUpperCase(); try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(Number(value || 0)); } catch { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); } }
function formatDate(value) { const [year,month,day] = String(value || '').split('-').map(Number); const date = new Date(year, month - 1, day, 12); return Number.isNaN(date.getTime()) ? 'date unavailable' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date); }
function titleCase(value) { return String(value || '').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function safeReason(safe) { return safe.reasonCodes?.length ? reasonText(safe.reasonCodes[0]) : 'More trusted information is needed.'; }
function reasonText(code) { return ({ dependable_payday_unknown: 'Add or confirm a dependable payday before OneStep calculates a short-horizon safe amount.', trusted_liquid_position_unavailable: 'A current trusted liquid balance is needed.', buffer_unknown: 'Confirm the starter/emergency buffer before relying on this figure.', required_debt_due_date_unknown: 'A required debt payment has no trusted due date, so OneStep will not guess.' })[code] || 'Some financial information is unresolved, so OneStep is keeping Safe Until Payday unavailable.'; }
