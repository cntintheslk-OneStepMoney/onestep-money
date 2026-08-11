import {
  applyRecurringPatternDecision, deriveRecurringPatterns, RECURRING_DECISION
} from './recurring-finance.js';
import { renderPaydayAwareness } from './payday-awareness-ui.js';

let latestState = null;
let renderScheduled = false;

export function renderRecurringActivityPanel(state) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return;
  latestState = state;
  renderPaydayAwareness(state);
  if (renderScheduled) return;
  renderScheduled = true;
  queueMicrotask(() => { renderScheduled = false; renderPanel(); });
}

function renderPanel() {
  const table = document.getElementById('transactionTable');
  if (!table || !latestState) return;
  const patterns = deriveRecurringPatterns(latestState, { includeRejected: true });
  let panel = document.getElementById('recurringActivityPanel');
  if (!panel) {
    panel = document.createElement('section'); panel.id = 'recurringActivityPanel'; panel.className = 'chart-card chart-card-wide';
    panel.setAttribute('aria-labelledby', 'recurringActivityTitle');
    table.parentElement?.insertBefore(panel, table.parentElement.querySelector('.filter-bar') || table);
    panel.addEventListener('click', handleDecision);
  }
  panel.replaceChildren();
  const heading = document.createElement('div'); heading.className = 'chart-card-heading';
  const headingCopy = document.createElement('div'); const eyebrow = document.createElement('p'); eyebrow.className = 'eyebrow'; eyebrow.textContent = 'RECURRING ACTIVITY';
  const title = document.createElement('h3'); title.id = 'recurringActivityTitle'; title.textContent = 'Income and commitments OneStep recognises';
  headingCopy.append(eyebrow, title); const count = document.createElement('span'); count.className = 'badge'; count.textContent = `${patterns.filter((item) => item.confirmationState !== 'rejected').length} detected`; heading.append(headingCopy, count); panel.append(heading);
  const intro = document.createElement('p'); intro.className = 'muted'; intro.textContent = 'Confirmed patterns can feed reminders and payday planning. Likely or uncertain patterns stay non-authoritative until the evidence is strong or you confirm them.'; panel.append(intro);
  const status = document.createElement('p'); status.id = 'recurringActivityStatus'; status.className = 'muted'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); panel.append(status);
  if (!patterns.length) { const empty = document.createElement('p'); empty.className = 'muted'; empty.textContent = 'No reliable recurring pattern is visible in trusted payment history yet.'; panel.append(empty); return; }
  const list = document.createElement('div'); list.className = 'dashboard-list'; for (const pattern of patterns.slice(0, 12)) list.append(patternCard(pattern)); panel.append(list);
}

function patternCard(pattern) {
  const article = document.createElement('article'); article.className = 'review-card'; article.dataset.recurringPatternId = pattern.id;
  const heading = document.createElement('div'); heading.className = 'review-card-heading'; const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = pattern.label;
  const detail = document.createElement('span'); detail.className = 'muted'; detail.textContent = [titleCase(pattern.direction), titleCase(pattern.cadence), pattern.purpose].filter(Boolean).join(' · '); copy.append(title, detail);
  const badge = document.createElement('span'); badge.className = `badge ${pattern.confirmationState === 'rejected' ? 'red' : ''}`.trim(); badge.textContent = pattern.confirmationState === 'rejected' ? 'Rejected' : titleCase(pattern.confidence); heading.append(copy, badge); article.append(heading);
  const amount = document.createElement('p'); amount.className = 'muted'; amount.textContent = amountSummary(pattern); article.append(amount);
  if (pattern.nextExpected) { const next = document.createElement('p'); next.textContent = `Next expected: ${formatDate(pattern.nextExpected.date)} (${formatDate(pattern.nextExpected.windowStart)}–${formatDate(pattern.nextExpected.windowEnd)} window)`; article.append(next); }
  const why = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Why?'; const explanation = document.createElement('p'); explanation.className = 'muted'; explanation.textContent = pattern.why; why.append(summary, explanation); article.append(why);
  if (pattern.confirmationState !== RECURRING_DECISION.REJECTED) { const actions = document.createElement('div'); actions.className = 'inline-actions'; if (pattern.confirmationState !== RECURRING_DECISION.CONFIRMED) actions.append(decisionButton('Confirm pattern', pattern.id, RECURRING_DECISION.CONFIRMED, 'primary-button')); actions.append(decisionButton('Reject pattern', pattern.id, RECURRING_DECISION.REJECTED, 'secondary-button')); article.append(actions); }
  return article;
}
function decisionButton(label, patternId, decision, className) { const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.dataset.recurringDecision = decision; button.dataset.recurringPatternId = patternId; return button; }
async function handleDecision(event) {
  const button = event.target.closest('[data-recurring-decision]'); if (!button || !latestState || !window.financeAPI?.saveState) return;
  const status = document.getElementById('recurringActivityStatus'); button.disabled = true; if (status) status.textContent = button.dataset.recurringDecision === RECURRING_DECISION.CONFIRMED ? 'Confirming this pattern…' : 'Rejecting this pattern…';
  try { const next = applyRecurringPatternDecision(latestState, button.dataset.recurringPatternId, button.dataset.recurringDecision, new Date()); latestState = await window.financeAPI.saveState(next); if (status) status.textContent = button.dataset.recurringDecision === RECURRING_DECISION.CONFIRMED ? 'Pattern confirmed. Its expected window can now be used by financial automation.' : 'Pattern rejected. Identical evidence will stay rejected unless the underlying history materially changes.'; renderPaydayAwareness(latestState); renderPanel(); window.setTimeout(() => window.location.reload(), 150); }
  catch (error) { button.disabled = false; if (status) status.textContent = error?.message || 'The recurring-pattern decision could not be saved.'; }
}
function amountSummary(pattern) { const range = pattern.amountRange; if (!range) return `${pattern.occurrences} occurrence${pattern.occurrences === 1 ? '' : 's'}`; const amount = range.min === range.max ? formatMoney(range.min) : `${formatMoney(range.min)}–${formatMoney(range.max)}`; return `${pattern.occurrences} occurrence${pattern.occurrences === 1 ? '' : 's'} · typical ${formatMoney(range.typical)} · observed ${amount}`; }
function formatMoney(value) { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(Number(value || 0)); }
function formatDate(value) { const [year, month, day] = String(value || '').split('-').map(Number); const date = new Date(year, month - 1, day, 12); return Number.isNaN(date.getTime()) ? 'date unavailable' : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date); }
function titleCase(value) { return String(value || '').replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
