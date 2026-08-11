import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCashFlowForecast, CASH_FLOW_HORIZON, forecastHorizon } from '../cash-flow-forecast.js';

const TODAY = '2026-08-11';

function fact(value, status = 'known') { return { value, status }; }
function profile(overrides = {}) {
  return {
    currency: 'GBP',
    liquidPosition: { total: fact(1000), complete: true },
    buffer: { target: fact(200), balance: fact(200), shortfall: 0 },
    commitments: { items: [] },
    budget: { planned: 300, remaining: 180, categories: [{ id: 'food', name: 'Food', monthlyPlanned: 300, remaining: 180 }] },
    uncertainty: { blocking: [], safeForAutomation: true },
    ...overrides
  };
}
function payday(overrides = {}) { return { schedules: [], streams: [], nextPayday: null, ...overrides }; }
function stream(overrides = {}) {
  return {
    id: 'salary', name: 'Fictional Salary', cadence: 'monthly', status: 'expected', active: true,
    expectedAmountRange: { min: 2000, max: 2200 }, nextExpected: { date: '2026-08-28' }, ...overrides
  };
}
function hard(id, kind, name, amount, dueDate) { return { id, kind, name, amount: fact(amount), dueDate: fact(dueDate) }; }
function forecast(options = {}) {
  return buildCashFlowForecast({}, { today: TODAY, now: new Date('2026-08-11T12:00:00Z'), profile: profile(), paydayContext: payday(), recurringPatterns: [], ...options });
}

test('today horizon starts from the trusted current balance when no event is due', () => {
  const result = forecast();
  const today = forecastHorizon(result, CASH_FLOW_HORIZON.TODAY);
  assert.equal(today.projectedBalance, 1000);
  assert.equal(today.safeProjectedBalance, 1000);
  assert.equal(today.eventCount, 0);
  assert.equal(result.persist, false);
});

test('confirmed bill and expected income affect ordinary 7/30 day forecast but income is excluded from safe view', () => {
  const result = forecast({
    profile: profile({ commitments: { items: [hard('scheduled:rent', 'scheduled_payment', 'Fictional Rent', 400, '2026-08-15')] } }),
    paydayContext: payday({ nextPayday: { date: '2026-08-28' }, streams: [stream()], schedules: [{ id: 'salary', cadence: 'monthly', rule: { type: 'fixed_day', day: 28 } }] })
  });
  const seven = forecastHorizon(result, CASH_FLOW_HORIZON.SEVEN_DAYS);
  const thirty = forecastHorizon(result, CASH_FLOW_HORIZON.THIRTY_DAYS);
  assert.equal(seven.projectedBalance, 600);
  assert.equal(seven.safeProjectedBalance, 600);
  assert.equal(thirty.projectedBalance, 2600);
  assert.equal(thirty.safeProjectedBalance, 600);
  assert.ok(thirty.reasonCodes.includes('expected_income_excluded_from_safe_projection'));
});

test('before-payday and payday horizons are calendar-specific', () => {
  const result = forecast({ paydayContext: payday({ nextPayday: { date: '2026-08-28' }, streams: [stream()], schedules: [{ id: 'salary', cadence: 'monthly', rule: { type: 'fixed_day', day: 28 } }] }) });
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.BEFORE_PAYDAY).date, '2026-08-27');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.NEXT_PAYDAY).date, '2026-08-28');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.BEFORE_PAYDAY).projectedBalance, 1000);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.NEXT_PAYDAY).projectedBalance, 3000);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.NEXT_PAYDAY).safeProjectedBalance, 1000);
});

test('three-month horizon repeats confirmed monthly recurring outgoing activity', () => {
  const result = forecast({ recurringPatterns: [{
    id: 'rent-pattern', direction: 'outgoing', confidence: 'confirmed', cadence: 'monthly', label: 'Fictional Rent',
    amountRange: { min: 100, max: 120, typical: 110 }, nextExpected: { date: '2026-08-20' }
  }] });
  const events = result.events.filter((event) => event.sourceRef === 'rent-pattern');
  assert.deepEqual(events.map((event) => event.date), ['2026-08-20', '2026-09-20', '2026-10-20']);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THREE_MONTHS).projectedBalance, 670);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THREE_MONTHS).safeProjectedBalance, 640);
});

test('four-weekly expected income crosses calendar month boundaries without becoming safe cash', () => {
  const result = forecast({ paydayContext: payday({ nextPayday: { date: '2026-08-28' }, streams: [stream({ cadence: 'four-weekly', nextExpected: { date: '2026-08-28' }, expectedAmountRange: { min: 500, max: 600 } })] }) });
  const incomeDates = result.events.filter((event) => event.sourceType === 'income_schedule').map((event) => event.date);
  assert.deepEqual(incomeDates, ['2026-08-28', '2026-09-25', '2026-10-23']);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THREE_MONTHS).projectedBalance, 2500);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THREE_MONTHS).safeProjectedBalance, 1000);
});

test('a missing expected income occurrence is not invented as received cash', () => {
  const result = forecast({ paydayContext: payday({ nextPayday: { date: '2026-09-25' }, streams: [stream({ status: 'missing', cadence: 'four-weekly', expected: { date: '2026-07-31' }, nextExpected: { date: '2026-08-28' }, expectedAmountRange: { min: 500, max: 600 } })] }) });
  assert.equal(result.events.some((event) => event.date === '2026-07-31'), false);
  assert.equal(result.events.find((event) => event.date === '2026-08-28').reasonCode, 'future_income_after_missing_occurrence');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THIRTY_DAYS).safeProjectedBalance, 1000);
});

test('discretionary budget allowance remains context rather than a mandatory event', () => {
  const result = forecast();
  assert.equal(result.budgetContext.planned, 300);
  assert.equal(result.budgetContext.treatment, 'context_only');
  assert.equal(result.events.some((event) => event.sourceType === 'budget'), false);
});

test('required default or arrangement debt payment is represented as a confirmed commitment', () => {
  const result = forecast({ profile: profile({ commitments: { items: [hard('debt:arranged', 'required_debt_payment', 'Fictional Arrangement', 75, '2026-08-18')] } }) });
  const event = result.events.find((item) => item.sourceRef === 'debt:arranged');
  assert.equal(event.certainty, 'confirmed');
  assert.equal(event.reasonCode, 'required_debt_payment');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.SEVEN_DAYS).safeProjectedBalance, 925);
});

test('negative balance and protected-buffer breaches are flagged', () => {
  const result = forecast({ profile: profile({
    liquidPosition: { total: fact(250), complete: true },
    buffer: { target: fact(500), balance: fact(300), shortfall: 200 },
    commitments: { items: [hard('scheduled:bill', 'scheduled_payment', 'Fictional Bill', 100, '2026-08-12'), hard('scheduled:bill2', 'scheduled_payment', 'Fictional Bill Two', 200, '2026-08-13')] }
  }) });
  const horizon = forecastHorizon(result, CASH_FLOW_HORIZON.SEVEN_DAYS);
  assert.ok(horizon.riskFlags.includes('safe_negative'));
  assert.ok(horizon.riskFlags.includes('buffer_breach'));
});

test('calendar horizons are deterministic across leap-year and month-end boundaries', () => {
  const result = buildCashFlowForecast({}, { today: '2028-02-29', now: new Date('2028-02-29T23:30:00+00:00'), profile: profile(), paydayContext: payday(), recurringPatterns: [] });
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.SEVEN_DAYS).date, '2028-03-07');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THIRTY_DAYS).date, '2028-03-30');
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THREE_MONTHS).date, '2028-05-31');
});

test('uncertain recurring activity cannot silently enter the baseline forecast', () => {
  const result = forecast({ recurringPatterns: [{ id: 'uncertain', direction: 'outgoing', confidence: 'likely', cadence: 'monthly', label: 'Uncertain Item', amountRange: { min: 50, max: 60, typical: 55 }, nextExpected: { date: '2026-08-20' } }] });
  assert.equal(result.events.some((event) => event.sourceRef === 'uncertain'), false);
  assert.equal(forecastHorizon(result, CASH_FLOW_HORIZON.THIRTY_DAYS).projectedBalance, 1000);
});

test('the same hard commitment is not double-counted through a recurring pattern', () => {
  const result = forecast({
    profile: profile({ commitments: { items: [hard('scheduled:phone', 'scheduled_payment', 'Fictional Phone', 40, '2026-08-20')] } }),
    recurringPatterns: [{ id: 'phone-pattern', direction: 'outgoing', confidence: 'confirmed', cadence: 'monthly', label: 'Fictional Phone', amountRange: { min: 40, max: 40, typical: 40 }, nextExpected: { date: '2026-08-20' } }]
  });
  assert.equal(result.events.filter((event) => event.date === '2026-08-20' && event.delta === -40).length, 1);
});

test('explicit optional plans affect only the plan-aware projection', () => {
  const result = forecast({ plannedEvents: [{ id: 'optional-debt:card', date: '2026-08-15', delta: -100, sourceType: 'optional_debt_plan', sourceRef: 'debt:card' }] });
  const horizon = forecastHorizon(result, CASH_FLOW_HORIZON.SEVEN_DAYS);
  assert.equal(horizon.projectedBalance, 1000);
  assert.equal(horizon.safeProjectedBalance, 1000);
  assert.equal(horizon.planAwareBalance, 900);
});
