import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRecurringPatternDecision, deriveRecurringPatterns, detectCadence, expectedNextOccurrence,
  RECURRING_CONFIDENCE
} from '../recurring-finance.js';

const tx = (id, date, amount, overrides = {}) => ({
  id, date, accountId: 'account-a', description: 'Fictional Utility', category: 'Household', incoming: 0, outgoing: amount,
  duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true, transferStatus: 'no', ...overrides
});
const state = (transactions) => ({ meta: { revision: 0 }, transactions });

test('detects fixed monthly bill conservatively', () => {
  const patterns = deriveRecurringPatterns(state([
    tx('m1','2026-01-15',42), tx('m2','2026-02-15',42), tx('m3','2026-03-15',42), tx('m4','2026-04-15',42)
  ]));
  assert.equal(patterns.length, 1);
  assert.equal(patterns[0].cadence, 'monthly');
  assert.equal(patterns[0].confidence, RECURRING_CONFIDENCE.CONFIRMED);
  assert.deepEqual(patterns[0].amountRange, { min: 42, max: 42, typical: 42 });
});

test('variable monthly utility keeps cadence', () => {
  const [pattern] = deriveRecurringPatterns(state([
    tx('u1','2026-01-28',55), tx('u2','2026-02-28',71), tx('u3','2026-03-28',49), tx('u4','2026-04-28',65)
  ]));
  assert.equal(pattern.cadence, 'monthly');
  assert.deepEqual(pattern.amountRange, { min: 49, max: 71, typical: 60 });
});

test('variable monthly salary is separate incoming activity', () => {
  const rows = [
    tx('s1','2026-01-31',2100,{description:'Fictional Employer A',category:'Income',incoming:2100,outgoing:0}),
    tx('s2','2026-02-28',2185,{description:'Fictional Employer A',category:'Income',incoming:2185,outgoing:0}),
    tx('s3','2026-03-31',2050,{description:'Fictional Employer A',category:'Income',incoming:2050,outgoing:0}),
    tx('s4','2026-04-30',2200,{description:'Fictional Employer A',category:'Income',incoming:2200,outgoing:0})
  ];
  const [pattern] = deriveRecurringPatterns(state(rows));
  assert.equal(pattern.direction, 'incoming');
  assert.equal(pattern.cadence, 'monthly');
});

test('four-weekly income stays distinct from monthly', () => {
  assert.equal(detectCadence(['2026-01-02','2026-01-30','2026-02-27','2026-03-27']), 'four-weekly');
});

test('detects fortnightly payment', () => {
  assert.equal(detectCadence(['2026-01-05','2026-01-19','2026-02-02','2026-02-16']), 'fortnightly');
});

test('detects quarterly and annual patterns', () => {
  assert.equal(detectCadence(['2025-01-31','2025-04-30','2025-07-31','2025-10-31']), 'quarterly');
  assert.equal(detectCadence(['2024-02-29','2025-02-28','2026-02-28']), 'annual');
});

test('one-off and irregular activity remain one-off', () => {
  assert.equal(deriveRecurringPatterns(state([tx('one','2026-01-10',30)])).length, 0);
  assert.equal(detectCadence(['2026-01-01','2026-01-17','2026-03-04']), '');
});

test('internal transfers and debt payments are excluded', () => {
  const rows = [
    tx('t1','2026-01-01',100,{transferStatus:'confirmed'}), tx('t2','2026-02-01',100,{transferStatus:'confirmed'}),
    tx('d1','2026-01-10',50,{budgetTreatment:'debt_payment'}), tx('d2','2026-02-10',50,{budgetTreatment:'debt_payment'})
  ];
  assert.equal(deriveRecurringPatterns(state(rows)).length, 0);
});

test('duplicate and review-inactive records are excluded', () => {
  const rows = [
    tx('a1','2026-01-10',20), tx('a2','2026-02-10',20),
    tx('bad','2026-03-10',20,{duplicateStatus:'possible',reviewStatus:'pending',financiallyActive:false})
  ];
  const [pattern] = deriveRecurringPatterns(state(rows));
  assert.equal(pattern.occurrences, 2);
  assert.equal(pattern.confidence, RECURRING_CONFIDENCE.UNCERTAIN);
});

test('same merchant on different accounts remains distinct', () => {
  const rows = [
    tx('a1','2026-01-10',20), tx('a2','2026-02-10',20), tx('a3','2026-03-10',20),
    tx('b1','2026-01-12',20,{accountId:'account-b'}), tx('b2','2026-02-12',20,{accountId:'account-b'}), tx('b3','2026-03-12',20,{accountId:'account-b'})
  ];
  assert.equal(deriveRecurringPatterns(state(rows)).length, 2);
});

test('rejected pattern stays rejected until evidence changes materially', () => {
  const original = state([tx('r1','2026-01-10',20), tx('r2','2026-02-10',20), tx('r3','2026-03-10',20)]);
  const [pattern] = deriveRecurringPatterns(original);
  const rejected = applyRecurringPatternDecision(original, pattern.id, 'rejected', new Date('2026-03-11T12:00:00Z'));
  assert.equal(deriveRecurringPatterns(rejected)[0].confirmationState, 'rejected');
  const amountChanged = structuredClone(rejected);
  amountChanged.transactions[2].outgoing = 25;
  assert.notEqual(deriveRecurringPatterns(amountChanged)[0].confirmationState, 'rejected');
  const changed = structuredClone(rejected);
  changed.transactions.push(tx('r4','2026-04-10',21));
  assert.notEqual(deriveRecurringPatterns(changed)[0].confirmationState, 'rejected');
});

test('confirmed pattern decision is persisted in transaction metadata and survives cloning', () => {
  const original = state([tx('c1','2026-01-10',20), tx('c2','2026-02-10',20), tx('c3','2026-03-10',20)]);
  const [pattern] = deriveRecurringPatterns(original);
  const confirmed = applyRecurringPatternDecision(original, pattern.id, 'confirmed', new Date('2026-03-11T12:00:00Z'));
  const restarted = structuredClone(confirmed);
  const [restoredPattern] = deriveRecurringPatterns(restarted);
  assert.equal(restoredPattern.confirmationState, 'confirmed');
  assert.equal(restoredPattern.confidence, 'confirmed');
  assert.ok(restarted.transactions.every((row) => row.recurringPatternDecision?.decision === 'confirmed'));
});

test('next expected occurrence handles month and year boundaries with local dates', () => {
  assert.deepEqual(expectedNextOccurrence({cadence:'monthly',dates:['2026-01-31']}), {
    date:'2026-02-28',windowStart:'2026-02-25',windowEnd:'2026-03-03',toleranceDays:3
  });
  assert.equal(expectedNextOccurrence({cadence:'annual',dates:['2024-02-29']}).date, '2025-02-28');
});
