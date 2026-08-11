import test from 'node:test';
import assert from 'node:assert/strict';
import { buildForecastPresentationModel } from '../financial-presentation-forecast.js';

test('forecast presentation selects a horizon and limits timeline to it', () => {
  const model = buildForecastPresentationModel({
    status: 'available',
    asOf: '2026-08-11',
    horizons: [
      { id: '7_days', label: '7 days', status: 'available', date: '2026-08-18', projectedBalance: 420, safeProjectedBalance: 300, eventCount: 2, riskFlags: [] },
      { id: '30_days', label: '30 days', status: 'available', date: '2026-09-10', projectedBalance: 510, safeProjectedBalance: 210, eventCount: 3, riskFlags: ['buffer_breach'] }
    ],
    events: [
      { id: 'bill', date: '2026-08-13', delta: -80, certainty: 'confirmed' },
      { id: 'pay', date: '2026-08-17', delta: 200, certainty: 'expected' },
      { id: 'later', date: '2026-08-25', delta: -50, certainty: 'expected' }
    ],
    blockers: [],
    why: ['Expected income is excluded from the safe view until received.'],
    budgetContext: { treatment: 'context_only' }
  }, '7_days');

  assert.equal(model.selected.id, '7_days');
  assert.deepEqual(model.timeline.map((item) => item.id), ['bill', 'pay']);
  assert.equal(model.budgetTreatment, 'context_only');
});
