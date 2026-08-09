import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPayslipRecord, formatPayslipLineItems, parsePayslipLineItems, payslipEditorItem } from '../payslip-record.js';

test('manual pay records calculate deductions and reconcile before saving', () => {
  const result = buildPayslipRecord({
    period: '2026-08', payDate: '2026-08-31', grossPay: 3000, netPay: 2400,
    taxablePay: 2950, niablePay: 3000, annualSalary: 36000,
    earningsText: 'Basic pay | 2800.00\nAllowance | 200.00',
    deductionsText: 'PAYE | 450.00\nNational Insurance | 150.00',
    taxCode: '1100L', taxBasis: 'Cumulative', niCategory: 'A', notes: 'Fictional record'
  }, { id: 'pay-1', provider: 'manual', source: 'Manual entry' });

  assert.equal(result.valid, true);
  assert.equal(result.totalDeductions, 600);
  assert.equal(result.record.totalDeductions, 600);
  assert.equal(result.record.earnings.length, 2);
  assert.equal(result.record.deductions.length, 2);
  assert.equal(result.record.source, 'Manual entry');
});

test('manual pay records cannot save when itemised figures do not balance', () => {
  const result = buildPayslipRecord({
    period: '2026-08', payDate: '2026-08-31', grossPay: 3000, netPay: 2500,
    earningsText: 'Basic pay | 3000.00', deductionsText: 'PAYE | 400.00'
  }, { id: 'pay-2' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /gross pay less itemised deductions/i);
});

test('line-item editing round trips imported payments and deductions', () => {
  const source = [{ id: 'old', name: 'Example deduction', amount: 12.34, type: 'deduction', notes: '' }];
  const text = formatPayslipLineItems(source);
  const parsed = parsePayslipLineItems(text, 'deduction');
  assert.equal(text, 'Example deduction | 12.34');
  assert.deepEqual(parsed.items.map((item) => [item.name, item.amount]), [['Example deduction', 12.34]]);
  assert.equal(payslipEditorItem({ deductions: source }).deductionsText, text);
});

test('manual pay UI and packaged application include the pay-record workflow', async () => {
  const [html, renderer, packageJson] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8'),
    fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
  ]);
  assert.match(html, /data-add="payslip"[^>]*>Add pay manually</);
  assert.match(renderer, /buildPayslipRecord/);
  assert.ok(JSON.parse(packageJson).build.files.includes('payslip-record.js'));
});
