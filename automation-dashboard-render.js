const $ = (id) => document.getElementById(id);
const e = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function automationViewMarkup() {
  return `<p id="automationStatus" class="sr-only" role="status" aria-live="polite"></p>
  <section class="automation-hero panel" aria-labelledby="automationHeroTitle">
    <div class="automation-hero-copy"><p class="eyebrow">LOCAL FINANCIAL AUTOMATION</p><h2 id="automationHeroTitle">Automation is loading…</h2><p id="automationHeroText" class="muted"></p></div>
    <label class="automation-master-switch"><input id="automationMasterToggle" type="checkbox" role="switch"><span><strong id="automationMasterLabel">Automation On</strong><small>Pause stops automatic changes. Rules, reminders, history and Review Inbox work stay intact.</small></span></label>
  </section>
  <div class="automation-summary-grid">
    ${stat('Enabled rules','automationEnabledRuleCount','automationRuleCountDetail')}
    <article class="automation-stat panel"><span>Needs review</span><strong id="automationReviewCount">0</strong><small>Uncertain automation stays review-first.</small><button class="text-button" type="button" data-automation-route="review">Open Review Inbox</button></article>
    ${stat('Configured reminders','automationReminderCount','Definitions remain saved while paused.')}
    ${stat('Recent activity','automationRecentCount','automationRecentDetail')}
  </div>
  <div class="automation-layout">
    ${section('RULES','Your automation rules','See what is active, what each rule does, and its latest recorded outcome.','Manage rules','rules','automationRulesList',true)}
    ${section('RECURRING ACTIVITY','Recognised patterns','','Review patterns','recurring','automationRecurringList')}
    ${section('REMINDERS','Upcoming reminders','','Manage reminders','reminders','automationRemindersList')}
    ${section('RECENT ACTIVITY','What OneStep did','A compact view only. Full Why? and Undo controls stay in local automation history.','Open full history','history','automationActivityList',true)}
  </div>`;
}

export function renderAutomationModel(model, message = '') {
  const toggle = $('automationMasterToggle');
  if (toggle) { toggle.checked = model.enabled; toggle.disabled = false; toggle.setAttribute('aria-checked', String(model.enabled)); }
  set('automationMasterLabel', model.enabled ? 'Automation On' : 'Automation Paused');
  set('automationHeroTitle', model.enabled ? 'Automation is on' : 'Automation is paused');
  set('automationHeroText', model.enabled
    ? 'OneStep can apply enabled local rules when their safety and certainty checks pass. Anything uncertain stays review-first.'
    : 'Automatic mutations are stopped. Your rules, reminders, history and review work are preserved until you resume.');
  set('automationEnabledRuleCount', model.enabledRuleCount);
  set('automationRuleCountDetail', model.totalRuleCount ? `${model.totalRuleCount} rule${model.totalRuleCount === 1 ? '' : 's'} configured` : 'No rules configured');
  set('automationReviewCount', model.reviewCount);
  set('automationReminderCount', model.configuredReminderCount);
  const recent = Object.values(model.recentTotals).reduce((sum, value) => sum + value, 0);
  set('automationRecentCount', recent);
  set('automationRecentDetail', recent ? `${model.recentTotals.applied} applied · ${model.recentTotals.needsReview} need review · ${model.recentTotals.skipped + model.recentTotals.blocked} skipped or blocked` : 'Nothing recorded yet.');
  renderList('automationRulesList', model.rules, ruleRow, empty('No automation rules yet.','Create a small rule when you have a repeatable task worth automating.','Create a rule','rules'));
  renderList('automationRecurringList', model.recurring, recurringRow, '<p class="muted">No confirmed or likely recurring patterns are ready to show yet.</p>');
  renderList('automationRemindersList', model.reminders, reminderRow, empty('No upcoming configured reminders.','Add a reminder for a due date you want OneStep to surface locally.','Add reminder','reminders'));
  renderList('automationActivityList', model.recentActivity, activityRow, '<p class="muted">No automation activity yet. Applied, skipped, blocked and review-required outcomes will appear here.</p>');
  set('automationStatus', message);
  renderDashboardStatus(model);
}

export function renderAutomationRecovery() {
  const toggle = $('automationMasterToggle');
  if (toggle) toggle.disabled = true;
  set('automationHeroTitle','Automation controls are unavailable during data recovery');
  set('automationHeroText','Data recovery protections are separate from Automation pause. Resolve recovery first; Automation cannot override those protections.');
  set('automationMasterLabel','Automation unavailable');
  set('automationStatus','Data recovery protections are active. Automation controls are unavailable.');
  set('dashboardAutomationTitle','Automation unavailable');
  set('dashboardAutomationBadge','Recovery');
  set('dashboardAutomationText','Data recovery protections are active. Automation cannot override them.');
}

export function renderDashboardStatus(model) {
  set('dashboardAutomationTitle', model.enabled ? 'Automation on' : 'Automation paused');
  set('dashboardAutomationBadge', model.enabled ? 'On' : 'Paused');
  set('dashboardAutomationText', model.reviewCount
    ? `${model.enabledRuleCount} enabled rule${model.enabledRuleCount === 1 ? '' : 's'} · ${model.reviewCount} item${model.reviewCount === 1 ? '' : 's'} need review.`
    : `${model.enabledRuleCount} enabled rule${model.enabledRuleCount === 1 ? '' : 's'} · nothing from automation needs review.`);
}

function stat(label,id,detail) {
  const detailMarkup = detail.startsWith?.('automation') ? `<small id="${detail}"></small>` : `<small>${e(detail)}</small>`;
  return `<article class="automation-stat panel"><span>${e(label)}</span><strong id="${id}">0</strong>${detailMarkup}</article>`;
}
function section(eyebrow,title,copy,button,route,listId,wide=false) {
  return `<article class="panel automation-section${wide ? ' automation-section-wide' : ''}"><div class="panel-heading"><div><p class="eyebrow">${eyebrow}</p><h2>${title}</h2>${copy ? `<p class="muted">${copy}</p>` : ''}</div><button class="${wide ? 'secondary-button' : 'text-button'}" type="button" data-automation-route="${route}">${button}</button></div><div id="${listId}" class="automation-list"></div></article>`;
}
function ruleRow(rule) {
  return `<article class="automation-row"><div class="automation-row-heading"><strong>${e(rule.name)}</strong><span class="badge ${rule.enabled ? '' : 'muted-badge'}">${rule.enabled ? 'Enabled' : 'Paused'}</span></div><p class="muted automation-row-summary">${e(rule.summary)}</p><p class="automation-row-meta">${rule.lastRun ? `Last result: ${e(rule.lastRun.status)} · ${e(formatDateTime(rule.lastRun.timestamp))}` : 'No recorded run yet.'}</p><div class="button-row"><button class="secondary-button" type="button" data-automation-rule-open="${e(rule.id)}">Open</button><button class="secondary-button" type="button" data-automation-rule-toggle="${e(rule.id)}" data-automation-rule-enable="${String(!rule.enabled)}">${rule.enabled ? 'Pause rule' : 'Enable rule'}</button></div></article>`;
}
function recurringRow(item) {
  return `<article class="automation-row compact"><div class="automation-row-heading"><strong>${e(item.label || 'Recurring activity')}</strong><span class="badge">${e(titleCase(item.confidence))}</span></div><p class="muted">${e([titleCase(item.direction), titleCase(item.cadence), item.purpose].filter(Boolean).join(' · '))}</p>${item.nextExpected ? `<p class="automation-row-meta">Next expected around ${e(formatLocalDate(item.nextExpected))}.</p>` : ''}</article>`;
}
function reminderRow(item) {
  return `<article class="automation-row compact"><div class="automation-row-heading"><strong>${e(item.title || 'Financial reminder')}</strong><span class="badge">${e(reminderStatus(item.status))}</span></div><p class="muted">${e(formatLocalDate(item.dueDate))} · reminder ${e(timing(item.daysBefore))}.</p></article>`;
}
function activityRow(item) {
  const attention = ['Needs review','Blocked'].includes(item.status) ? ' attention-badge' : '';
  return `<article class="automation-row compact"><div class="automation-row-heading"><strong>${e(item.summary)}</strong><span class="badge${attention}">${e(item.status)}</span></div><p class="automation-row-meta">${e([formatDateTime(item.timestamp), item.ruleLabel].filter(Boolean).join(' · '))}</p></article>`;
}
function empty(title,detail,button,route) { return `<div class="automation-empty"><p class="automation-empty-title">${e(title)}</p><p class="muted">${e(detail)}</p><button class="secondary-button" type="button" data-automation-route="${route}">${e(button)}</button></div>`; }
function renderList(id,items,mapper,emptyMarkup) { const node=$(id); if (node) node.innerHTML=items.length ? items.map(mapper).join('') : emptyMarkup; }
function set(id,value) { const node=$(id); if (node) node.textContent=String(value ?? ''); }
function formatDateTime(value) { const date=new Date(value); return Number.isNaN(date.getTime()) ? 'Date unavailable' : new Intl.DateTimeFormat('en-GB',{dateStyle:'medium',timeStyle:'short'}).format(date); }
function formatLocalDate(value) { const [y,m,d]=String(value||'').split('-').map(Number); const date=new Date(y,m-1,d,12); return Number.isNaN(date.getTime()) ? 'date unavailable' : new Intl.DateTimeFormat('en-GB',{day:'numeric',month:'short',year:'numeric'}).format(date); }
function titleCase(value) { return String(value||'').replace(/[-_]/g,' ').replace(/\b\w/g,(c)=>c.toUpperCase()); }
function reminderStatus(value) { return value==='due_today' ? 'Due today' : value==='overdue' ? 'Overdue' : 'Upcoming'; }
function timing(days) { return Number(days)===0 ? 'on the due date' : `${days} day${Number(days)===1?'':'s'} before`; }
