export const THEMES = Object.freeze(['system', 'light', 'dark']);
export const DASHBOARD_MODES = Object.freeze(['simple', 'detailed']);

export const DASHBOARD_MODULES = Object.freeze([
  { id: 'next-move', label: 'Next Move', required: true, simple: true, defaultSize: 'wide' },
  { id: 'balance', label: 'Balance overview', simple: true, defaultSize: 'standard' },
  { id: 'upcoming', label: 'Upcoming commitments', simple: true, defaultSize: 'standard' },
  { id: 'budget', label: 'Budget health', simple: true, defaultSize: 'standard' },
  { id: 'alerts', label: 'Important warnings', simple: true, defaultSize: 'standard' },
  { id: 'progress', label: 'Debt and savings progress', simple: true, defaultSize: 'wide' },
  { id: 'spending', label: 'Spending trend', simple: false, defaultSize: 'wide' },
  { id: 'income', label: 'Income trend', simple: false, defaultSize: 'standard' },
  { id: 'review', label: 'Review Inbox summary', simple: false, defaultSize: 'standard' },
  { id: 'recent', label: 'Recent payments', simple: false, defaultSize: 'wide' }
]);

const MODULE_IDS = new Set(DASHBOARD_MODULES.map((module) => module.id));
const REQUIRED_IDS = new Set(DASHBOARD_MODULES.filter((module) => module.required).map((module) => module.id));
const DEFAULT_ORDER = DASHBOARD_MODULES.map((module) => module.id);

export function defaultAppearanceSettings() {
  return { theme: 'system' };
}

export function defaultDashboardSettings() {
  return {
    mode: 'simple',
    order: [...DEFAULT_ORDER],
    hidden: [],
    pinned: ['next-move'],
    sizes: Object.fromEntries(DASHBOARD_MODULES.map((module) => [module.id, module.defaultSize]))
  };
}

export function normaliseAppearanceSettings(value) {
  const appearance = isPlainObject(value) ? value : {};
  return { theme: THEMES.includes(appearance.theme) ? appearance.theme : 'system' };
}

export function normaliseDashboardSettings(value) {
  if (!isPlainObject(value)) return defaultDashboardSettings();
  const suppliedOrder = uniqueKnownIds(value.order);
  const order = [...suppliedOrder, ...DEFAULT_ORDER.filter((id) => !suppliedOrder.includes(id))];
  if (!isValidOrder(value.order, suppliedOrder)) return defaultDashboardSettings();

  const hidden = uniqueKnownIds(value.hidden).filter((id) => !REQUIRED_IDS.has(id));
  const pinned = uniqueKnownIds(value.pinned);
  const rawSizes = isPlainObject(value.sizes) ? value.sizes : {};
  const sizes = Object.fromEntries(DASHBOARD_MODULES.map((module) => [
    module.id,
    ['standard', 'wide'].includes(rawSizes[module.id]) ? rawSizes[module.id] : module.defaultSize
  ]));
  return {
    mode: DASHBOARD_MODES.includes(value.mode) ? value.mode : 'simple',
    order,
    hidden,
    pinned: pinned.includes('next-move') ? pinned : ['next-move', ...pinned],
    sizes
  };
}

export function visibleDashboardModules(settings) {
  const dashboard = normaliseDashboardSettings(settings);
  const modules = new Map(DASHBOARD_MODULES.map((module) => [module.id, module]));
  const visible = dashboard.order.filter((id) => {
    const module = modules.get(id);
    return module && !dashboard.hidden.includes(id) && (dashboard.mode === 'detailed' || module.simple);
  });
  return [...dashboard.pinned.filter((id) => visible.includes(id)), ...visible.filter((id) => !dashboard.pinned.includes(id))];
}

export function moveDashboardModule(settings, moduleId, direction) {
  const dashboard = normaliseDashboardSettings(settings);
  const index = dashboard.order.indexOf(moduleId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= dashboard.order.length) return dashboard;
  const order = [...dashboard.order];
  [order[index], order[target]] = [order[target], order[index]];
  return { ...dashboard, order };
}

export function compareLabels(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'en-GB', { sensitivity: 'base', numeric: true });
}

function uniqueKnownIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && MODULE_IDS.has(id)))];
}

function isValidOrder(raw, cleaned) {
  if (raw === undefined) return true;
  if (!Array.isArray(raw) || raw.length > DASHBOARD_MODULES.length) return false;
  return raw.length === cleaned.length;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
