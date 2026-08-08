import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCsvStatement, parseOfxStatement, parsePayslipText, parseQifStatement } from '../document-import.js';

test('CSV with separate debit and credit columns keeps a positive BACS credit as income', () => {
  const result = parseCsvStatement('Date,Description,Debit,Credit,Balance\n31/01/2025,BACS PAYROLL,,2500.00,100.00', 'pay.csv', 'acct-1');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].incoming, 2500);
  assert.equal(result.records[0].outgoing, 0);
  assert.equal(result.records[0].category, 'Income - pay');
});

test('signed amount CSV distinguishes incoming and outgoing', () => {
  const result = parseCsvStatement('Date,Description,Amount\n01/02/2025,Refund,12.50\n02/02/2025,Purchase,-4.25', 'signed.csv', 'acct-1');
  assert.deepEqual(result.records.map((item) => [item.incoming, item.outgoing]), [[12.5, 0], [0, 4.25]]);
});

test('invalid dates are rejected and never changed to today', () => {
  const result = parseCsvStatement('Date,Description,Amount\n31/02/2025,Impossible,-10.00', 'bad.csv', 'acct-1');
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].reason, /date/i);
});

test('QIF parser reads independent transactions', () => {
  const result = parseQifStatement('!Type:Bank\nD01/02/2025\nT-12.34\nPCoffee\n^\nD02/02/2025\nT50.00\nPRefund\n^', 'bank.qif', 'acct-1');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].outgoing, 12.34);
  assert.equal(result.records[1].incoming, 50);
});

test('OFX parser supports common unclosed SGML tags', () => {
  const ofx = '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20250201<TRNAMT>-9.99<FITID>ABC1<NAME>Example merchant</STMTTRN></BANKTRANLIST>';
  const result = parseOfxStatement(ofx, 'bank.ofx', 'acct-1');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].date, '2025-02-01');
  assert.equal(result.records[0].outgoing, 9.99);
});

test('JPA payslip parser reconciles gross, detailed deductions and net pay', () => {
  const text = `JPA E017 Statement of Salary and Deductions Jan 2025
  Pay Date 31/01/25
  Gross Pay PTD 3000.00 Gross Pay YTD 3000.00
  NIable Pay PTD 3000.00 NIable Pay YTD 3000.00
  Taxable Pay PTD 3000.00 Taxable Pay YTD 3000.00
  Total Payments 3000.00 Total 600.00 Net Pay 2400.00
  NI A 100.00
  PAYE 500.00
  Basic Pay 3000.00
  Basic Pay: Annual Salary 36,000.00`;
  const result = parsePayslipText(text, 'example-payslip.pdf');
  assert.equal(result.reconciled, true);
  assert.equal(result.records[0].grossPay, 3000);
  assert.equal(result.records[0].totalDeductions, 600);
  assert.equal(result.records[0].earnings.length, 1);
  assert.equal(result.records[0].deductions.length, 2);
});
