const VIEW_META = Object.freeze({
  dashboard: ['YOUR MONEY AT A GLANCE', 'Dashboard'],
  today: ['ONE CLEAR MOVE', 'Today'],
  review: ['UNFINISHED FINANCIAL WORK', 'Review Inbox'],
  transactions: ['MONEY IN AND OUT', 'Payments'],
  pay: ['WHERE GROSS PAY GOES', 'Pay'],
  debts: ['LOANS, CARDS AND FINANCE', 'Debts'],
  overdrafts: ['BANK BORROWING', 'Overdrafts'],
  budget: ['DEPENDABLE INCOME FIRST', 'Budget'],
  guide: ['PRIVATE AND LOCAL', 'Guide'],
  documents: ['ENCRYPTED ON THIS DEVICE', 'Documents'],
  settings: ['CONTROL AND PRIVACY', 'Settings']
});

const installedDocuments = new WeakSet();

export function resolveCoreViewTarget(target) {
  if (!target || typeof target.closest !== 'function') return '';
  const control = target.closest('.nav-button[data-view], [data-view-target], #dashboardOpenNextMove');
  if (!control) return '';
  if (control.id === 'dashboardOpenNextMove') return 'today';
  return control.dataset?.view || control.dataset?.viewTarget || '';
}

export function activateCoreView(documentRef, name) {
  if (!documentRef || !name) return false;
  const targetView = documentRef.getElementById(`view-${name}`);
  if (!targetView) return false;

  documentRef.querySelectorAll('.nav-button').forEach((button) => {
    button.classList.toggle('active', button.dataset?.view === name);
  });
  documentRef.querySelectorAll('.view').forEach((view) => {
    const active = view === targetView || view.id === `view-${name}`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });

  const meta = VIEW_META[name];
  if (meta) {
    const eyebrow = documentRef.getElementById('viewEyebrow');
    const title = documentRef.getElementById('viewTitle');
    if (eyebrow) eyebrow.textContent = meta[0];
    if (title) title.textContent = meta[1];
  }
  return true;
}

export function installCoreInteractions(documentRef) {
  if (!documentRef || installedDocuments.has(documentRef)) return false;
  installedDocuments.add(documentRef);
  documentRef.addEventListener('click', (event) => {
    const viewName = resolveCoreViewTarget(event.target);
    if (viewName) activateCoreView(documentRef, viewName);
  }, true);
  return true;
}

if (typeof document !== 'undefined') installCoreInteractions(document);
