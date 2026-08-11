import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDebtRecommendation, DEBT_RECOMMENDATION_STATUS, DEBT_RECOMMENDATION_STRATEGY,
  normaliseDebtRecommendationStrategy, optionalDebtPlanEvent, setDebtRecommendationStrategy
} from '../debt-recommendation-engine.js';

const TODAY = '2026-08-11';
function fact(value, status = 'known') { return { value, status }; }
function debt(id, overrides = {}) {
  return { id, name: `Fictional ${id}`, currentBalance: 800, apr: 0.2, contractualPayment: 40, status: 'current', arrangementStatus: 'none', includeInPlan: true, interestFrozen: false, planPriority: 10, ...overrides };
}
function assessed(id, overrides = {}) {
  return { id, name: `Fictional ${id}`, kind: 'debt', balance: 800, effectiveStatus: 'current', arrangementStatus: 'none', requiredPayment: 40, eligibleForExtra: true, overLimit: false, blockingReasons: [], reasonCodes: [], ...overrides };
}
function profileFor(rawDebts, overrides = {}) {
  return {
    currency: 'GBP',
    liquidPosition: { total: fact(1200) },
    debts: { accounts: rawDebts.map((item) => ({ id: item.id, apr: fact(item.apr), status: fact(item.status || 'current'), arrangementStatus: fact(item.arrangementStatus || 'none') })) },
    commitments: { items: rawDebts.filter((item) => Number(item.contractualPayment || item.arrangementPayment || 0) > 0).map((item) => ({ id: `debt:${item.id}`, kind: 'required_debt_payment', dueDate: fact('2026-08-20') })) },
    ...overrides
  };
}
function safetyFor(accounts, overrides = {}) { return { accounts, safeExtraPayment: 600, blockingReasons: [], ...overrides }; }
function paydaySafe(amount = 500, overrides = {}) {
  return { nextPayday: { date: '2026-08-28' }, safeUntilPayday: { status: 'available', amount, horizonDate: '2026-08-28', reasonCodes: [], ...overrides } };
}
function recommendation({ debts = [debt('card')], overdrafts = [], accounts, profile, safety, payday, strategy, forecast } = {}) {
  const state = { profile: {}, debts, overdrafts };
  const all = [...debts, ...overdrafts];
  return buildDebtRecommendation(state, {
    today: TODAY,
    now: new Date('2026-08-11T12:00:00Z'),
    profile: profile || profileFor(all),
    safetyAssessment: safety || safetyFor(accounts || all.map((item) => assessed(item.id, { name: item.name, kind: item.type === 'overdraft' ? 'overdraft' : 'debt', balance: item.currentBalance, requiredPayment: item.arrangementStatus === 'confirmed' ? Number(item.arrangementPayment || 0) : Number(item.contractualPayment || 0) }))),
    paydayContext: payday || paydaySafe(),
    strategy,
    forecast
  });
}

test('highest-cost eligible card becomes priority when the safety gates pass', () => {
  const debts = [debt('low', { apr: 0.12 }), debt('high', { apr: 0.31 })];
  const result = recommendation({ debts });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.AVAILABLE);
  assert.equal(result.priorityDebt.id, 'high');
  assert.equal(result.maximumSafeOptionalAmount, 500);
  assert.ok(result.priorityDebt.reasonCodes.includes('highest_effective_cost'));
});

test('defaulted debt without confirmed extra-payment safety blocks optional overpayment', () => {
  const debts = [debt('default', { status: 'defaulted', arrangementStatus: 'unknown' }), debt('card')];
  const accounts = [assessed('default', { effectiveStatus: 'defaulted', arrangementStatus: 'unknown', eligibleForExtra: false, blockingReasons: ['Arrangement terms need confirmation.'], reasonCodes: ['default_arrangement_unresolved'] }), assessed('card')];
  const result = recommendation({ debts, accounts, safety: safetyFor(accounts, { safeExtraPayment: 0, blockingReasons: ['Arrangement terms need confirmation.'] }) });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW);
  assert.equal(result.maximumSafeOptionalAmount, 0);
  assert.ok(result.blockers.some((item) => item.code === 'financial_safety_default_arrangement_unresolved'));
});

test('active arrangement remains a required payment and is never treated as optional extra', () => {
  const debts = [debt('arranged', { status: 'defaulted', arrangementStatus: 'confirmed', arrangementPayment: 75, contractualPayment: null }), debt('card', { apr: 0.25 })];
  const accounts = [assessed('arranged', { effectiveStatus: 'defaulted', arrangementStatus: 'confirmed', requiredPayment: 75, eligibleForExtra: false }), assessed('card')];
  const result = recommendation({ debts, accounts });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.AVAILABLE);
  assert.equal(result.requiredPayments.find((item) => item.debtId === 'arranged').type, 'arrangement_or_agreed_payment');
  assert.equal(result.priorityDebt.id, 'card');
  assert.equal(result.eligibleDebts.some((item) => item.id === 'arranged'), false);
});

test('frozen-interest default is not automatically prioritised over costly current debt', () => {
  const debts = [debt('frozen', { status: 'defaulted', arrangementStatus: 'confirmed', arrangementPayment: 30, contractualPayment: null, interestFrozen: true, apr: 0.4 }), debt('costly', { apr: 0.29 })];
  const accounts = [assessed('frozen', { effectiveStatus: 'defaulted', arrangementStatus: 'confirmed', requiredPayment: 30, eligibleForExtra: false }), assessed('costly')];
  const result = recommendation({ debts, accounts });
  assert.equal(result.priorityDebt.id, 'costly');
});

test('overdraft recommendation cannot consume cash protected for imminent essentials', () => {
  const overdraft = debt('od', { type: 'overdraft', currentBalance: 700, limit: 1000, apr: 0.39, contractualPayment: 0 });
  const accounts = [assessed('od', { kind: 'overdraft', balance: 700, requiredPayment: 0 })];
  const result = recommendation({ debts: [], overdrafts: [overdraft], accounts, payday: paydaySafe(120) });
  assert.equal(result.priorityDebt.id, 'od');
  assert.equal(result.maximumSafeOptionalAmount, 120);
  assert.equal(result.capacity.expectedIncomeCountedAsCurrentCash, false);
});

test('required minimums are kept separate and protected before optional extra', () => {
  const debts = [debt('a', { contractualPayment: 55, apr: 0.2 }), debt('b', { contractualPayment: 45, apr: 0.15 })];
  const result = recommendation({ debts });
  assert.equal(result.requiredPaymentTotal, 100);
  assert.equal(result.requiredPayments.every((item) => item.optional === false), true);
  assert.equal(result.maximumSafeOptionalAmount, 500);
});

test('protected buffer reduces the maximum safe optional amount', () => {
  const result = recommendation({ payday: paydaySafe(90) });
  assert.equal(result.maximumSafeOptionalAmount, 90);
});

test('expected but unreceived income never increases the current safe amount', () => {
  const first = recommendation({ payday: { ...paydaySafe(80), streams: [{ id: 'salary', status: 'expected', expectedAmountRange: { min: 4000, max: 4000 } }] } });
  const second = recommendation({ payday: paydaySafe(80) });
  assert.equal(first.maximumSafeOptionalAmount, 80);
  assert.equal(second.maximumSafeOptionalAmount, 80);
  assert.equal(first.capacity.expectedIncomeCountedAsCurrentCash, false);
});

test('missing payday safety removes the optional recommendation', () => {
  const result = recommendation({ payday: { nextPayday: null, safeUntilPayday: { status: 'unavailable', amount: null, reasonCodes: ['dependable_payday_unknown'] } } });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW);
  assert.equal(result.maximumSafeOptionalAmount, 0);
  assert.ok(result.blockers.some((item) => item.code === 'payday_dependable_payday_unknown'));
});

test('multiple eligible debts have deterministic transparent ranking', () => {
  const debts = [debt('c', { apr: 0.2, currentBalance: 600 }), debt('a', { apr: 0.2, currentBalance: 600 }), debt('b', { apr: 0.15, currentBalance: 100 })];
  const first = recommendation({ debts });
  const second = recommendation({ debts: [...debts].reverse() });
  assert.deepEqual(first.eligibleDebts.map((item) => item.id), second.eligibleDebts.map((item) => item.id));
  assert.equal(first.priorityDebt.id, 'a');
});

test('small-balance preference still cannot override Financial Safety blockers', () => {
  const debts = [debt('tiny-default', { currentBalance: 50, status: 'defaulted', arrangementStatus: 'unknown' }), debt('large-card', { currentBalance: 1000 })];
  const accounts = [assessed('tiny-default', { balance: 50, effectiveStatus: 'defaulted', arrangementStatus: 'unknown', eligibleForExtra: false, blockingReasons: ['Default terms need review.'], reasonCodes: ['default_arrangement_unresolved'] }), assessed('large-card', { balance: 1000 })];
  const result = recommendation({ debts, accounts, safety: safetyFor(accounts, { safeExtraPayment: 0, blockingReasons: ['Default terms need review.'] }), strategy: DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW);
  assert.equal(result.priorityDebt, null);
});

test('unknown APR is conservative when material and unknown status is always review work', () => {
  const debts = [debt('known', { apr: 0.2 }), debt('unknown', { apr: null })];
  const unknownProfile = profileFor(debts);
  unknownProfile.debts.accounts.find((item) => item.id === 'unknown').apr = fact(null, 'unknown');
  const aprResult = recommendation({ debts, profile: unknownProfile });
  assert.equal(aprResult.status, DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW);
  assert.ok(aprResult.blockers.some((item) => item.code === 'material_apr_unknown'));

  const accounts = [assessed('known', { effectiveStatus: 'unknown', eligibleForExtra: false, blockingReasons: ['Status is unknown.'], reasonCodes: ['unknown_status'] })];
  const statusResult = recommendation({ debts: [debts[0]], accounts, safety: safetyFor(accounts, { safeExtraPayment: 0, blockingReasons: ['Status is unknown.'] }) });
  assert.ok(statusResult.blockers.some((item) => item.code === 'financial_safety_unknown_status'));
});

test('accepted optional amount can feed forecast/planning without being treated as already paid', () => {
  const result = recommendation();
  const event = optionalDebtPlanEvent(result, { amount: 100, date: '2026-08-15' });
  assert.equal(event.delta, -100);
  assert.equal(event.certainty, 'possible');
  assert.equal(event.applied, false);
  assert.equal(event.externalPaymentMade, false);
  assert.equal(result.externalPaymentMade, false);
});

test('explicit strategy preference survives serialisation while derived recommendations do not need persistence', () => {
  const initial = { profile: { name: 'Fictional User' }, debts: [], debtRecommendation: { stale: true } };
  const changed = setDebtRecommendationStrategy(initial, DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE);
  const restarted = JSON.parse(JSON.stringify(changed));
  assert.equal(restarted.profile.debtRecommendationStrategy, DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE);
  assert.equal(restarted.debtRecommendation, undefined);
  assert.equal(normaliseDebtRecommendationStrategy(restarted.profile.debtRecommendationStrategy), DEBT_RECOMMENDATION_STRATEGY.SMALL_BALANCE);
});

test('forecast cash risk blocks an otherwise available optional payment', () => {
  const result = recommendation({ forecast: { horizons: [{ status: 'available', date: '2026-08-20', riskFlags: ['buffer_breach'] }] } });
  assert.equal(result.status, DEBT_RECOMMENDATION_STATUS.NEEDS_REVIEW);
  assert.ok(result.blockers.some((item) => item.code === 'forecast_cash_risk'));
});
