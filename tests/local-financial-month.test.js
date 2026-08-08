import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { localFinancialMonthKey } from '../date-utils.js';

test('local financial month uses local calendar components at month and year boundaries', () => {
  assert.equal(localFinancialMonthKey(new Date(2026, 8, 1, 0, 0)), '2026-09');
  assert.equal(localFinancialMonthKey(new Date(2026, 8, 30, 23, 59)), '2026-09');
  assert.equal(localFinancialMonthKey(new Date(2027, 0, 1, 0, 0)), '2027-01');
  assert.equal(localFinancialMonthKey(new Date('invalid')), '');
});

test('BST and GMT reporting boundaries use Europe/London rather than UTC month keys', () => {
  const source = `
    import { localFinancialMonthKey } from ${JSON.stringify(new URL('../date-utils.js', import.meta.url).href)};
    console.log(JSON.stringify([
      localFinancialMonthKey(new Date('2026-08-31T23:30:00.000Z')),
      localFinancialMonthKey(new Date('2026-10-31T23:30:00.000Z')),
      localFinancialMonthKey(new Date('2026-12-31T23:30:00.000Z'))
    ]));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    encoding: 'utf8',
    env: { ...process.env, TZ: 'Europe/London' }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), ['2026-09', '2026-10', '2026-12']);
});
