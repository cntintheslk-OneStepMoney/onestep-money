import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCreditReportText, parseCsvStatement, parseImportedDocument, parseOfxStatement, parsePayslipText, parsePdfStatement, parseQifStatement } from '../document-import.js';

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
  assert.equal(result.reconciled, false);
  assert.match(result.warnings[0], /will not update the account balance/i);
});

test('explicit CSV opening and closing balances can reconcile without running-balance rows', () => {
  const csv = 'Opening balance: £100.00\nClosing balance: £112.50\nDate,Description,Amount\n01/02/2025,Purchase,-12.50\n02/02/2025,Refund,25.00';
  const result = parseCsvStatement(csv, 'labelled-balances.csv', 'acct-1');
  assert.equal(result.summary.openingBalance, 100);
  assert.equal(result.summary.closingBalance, 112.5);
  assert.equal(result.reconciled, true);
});

test('semicolon exports can contain a preamble and common UK bank headings', () => {
  const csv = '\uFEFFExample Current Account\nTransaction Date;Transaction Description;Debit Amount;Credit Amount;Account Balance\n1 August 2025;Example Books;12.50;;87.50\n2 August 2025;Example Refund;;5.00;92.50';
  const result = parseCsvStatement(csv, 'semicolon.csv', 'acct-1');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].date, '2025-08-01');
  assert.equal(result.records[0].outgoing, 12.5);
  assert.equal(result.records[1].incoming, 5);
  assert.equal(result.records[0].sourceRow, 3);
});

test('tab-separated exports support timestamps, counter parties and debit type codes', () => {
  const tsv = 'Completed Date\tCounter Party\tTransaction Type\tAmount (GBP)\tBalance (GBP)\n2025-08-01 10:15:00\tExample Market\tCARD_PAYMENT\t12.50\t87.50\n2025-08-02 09:00:00\tExample Employer\tCREDIT\t25.00\t112.50';
  const result = parseCsvStatement(tsv, 'starling-style.tsv', 'acct-1');
  assert.deepEqual(result.records.map((item) => [item.incoming, item.outgoing]), [[0, 12.5], [25, 0]]);
});

test('specific description and amount headings win over generic metadata columns', () => {
  const csv = 'Value Date,Name,Description,Value\n01/08/2025,Example Account,Example Purchase,-4.25';
  const result = parseCsvStatement(csv, 'metadata-columns.csv', 'acct-1');
  assert.equal(result.records[0].description, 'Example Purchase');
  assert.equal(result.records[0].outgoing, 4.25);
});

test('transaction, posting and value dates remain distinct when a bank exports all three', () => {
  const csv = 'Transaction Date,Posting Date,Value Date,Description,Amount,Balance\n01/08/2026,02/08/2026,03/08/2026,Example payment,-10.00,90.00';
  const result = parseCsvStatement(csv, 'multiple-dates.csv', 'acct-1');
  assert.equal(result.records[0].date, '2026-08-01');
  assert.equal(result.records[0].postingDate, '2026-08-02');
  assert.equal(result.records[0].valueDate, '2026-08-03');
});

test('descending statement exports expose the latest reconciled balance for account sync', () => {
  const csv = 'Date,Description,Amount,Balance\n02/08/2025,Example Refund,5.00,92.50\n01/08/2025,Example Purchase,-12.50,87.50';
  const result = parseCsvStatement(csv, 'descending.csv', 'acct-1');
  assert.equal(result.summary.openingBalance, 100);
  assert.equal(result.summary.closingBalance, 92.5);
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
  assert.equal(result.records[0].providerTransactionId, 'ABC1');
});

test('OFX statement identity preserves safe account, period and currency metadata', () => {
  const ofx = '<CURDEF>GBP<BANKACCTFROM><BANKID>EXAMPLE<ACCTID>001122334455<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><DTSTART>20260701000000<DTEND>20260731235959<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260715<TRNAMT>-10.00<FITID>FIT-1<NAME>Example</STMTTRN></BANKTRANLIST>';
  const result = parseOfxStatement(ofx, 'statement.ofx', 'acct-1');
  assert.equal(result.accountIdentity.accountReference, '••••4455');
  assert.equal(result.accountIdentity.currency, 'GBP');
  assert.equal(result.period.startDate, '2026-07-01');
  assert.equal(result.period.endDate, '2026-07-31');
  assert.equal(result.period.source, 'explicit');
});

test('QFX files use the OFX transaction parser', () => {
  const qfx = '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20250802<TRNAMT>15.00<FITID>QFX1<NAME>Example refund</STMTTRN></BANKTRANLIST>';
  const result = parseImportedDocument('example.qfx', qfx, 'statement', 'acct-1');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].incoming, 15);
});

test('labelled PDF tables use the conservative generic fallback and reconcile', () => {
  const item = (text, x) => ({ text, x, width: text.length * 5, y: 0, height: 10 });
  const line = (items) => ({ items, text: items.map((entry) => entry.text).join(' ') });
  const document = {
    text: 'Example Bank\nOpening balance £100.00\nClosing balance £112.50',
    pages: [{
      width: 600,
      lines: [
        line([item('Date', 10), item('Description', 100), item('Type', 280), item('Money Out', 350), item('Money In', 430), item('Balance', 510)]),
        line([item('01 August 2025', 10), item('Example Books', 100), item('DEB', 280), item('12.50', 350), item('87.50', 510)]),
        line([item('02 August 2025', 10), item('Example Refund', 100), item('FPI', 280), item('25.00', 430), item('112.50', 510)])
      ]
    }]
  };
  const result = parsePdfStatement(document, 'accessible-table.pdf', 'acct-1');
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].outgoing, 12.5);
  assert.equal(result.records[1].incoming, 25);
  assert.equal(result.reconciled, true);
});

test('explicit PDF statement period and account identity override transaction-derived dates', () => {
  const item = (text, x) => ({ text, x, width: text.length * 5, y: 0, height: 10 });
  const line = (items) => ({ items, text: items.map((entry) => entry.text).join(' ') });
  const document = {
    text: 'Example Bank\nAccount number: 001122334455\nAccount type: Current account\nStatement period: 1 July 2026 to 31 July 2026\nCurrency: GBP\nOpening balance £100.00\nClosing balance £90.00',
    pages: [{ width: 600, lines: [
      line([item('Date', 10), item('Description', 100), item('Money Out', 350), item('Money In', 430), item('Balance', 510)]),
      line([item('15 July 2026', 10), item('Example payment', 100), item('10.00', 350), item('90.00', 510)])
    ] }]
  };
  const result = parsePdfStatement(document, 'explicit-period.pdf', 'acct-1');
  assert.equal(result.period.startDate, '2026-07-01');
  assert.equal(result.period.endDate, '2026-07-31');
  assert.equal(result.period.source, 'explicit');
  assert.equal(result.accountIdentity.accountReference, '••••4455');
  assert.equal(result.accountIdentity.accountType, 'Current account');
  assert.equal(result.accountIdentity.currency, 'GBP');
});

test('explicit closing balance is not overwritten by a plausible running balance', () => {
  const item = (text, x) => ({ text, x, width: text.length * 5, y: 0, height: 10 });
  const line = (items) => ({ items, text: items.map((entry) => entry.text).join(' ') });
  const document = {
    text: 'Opening balance £100.00\nClosing balance £95.00',
    pages: [{ width: 600, lines: [
      line([item('Date', 10), item('Description', 100), item('Money Out', 350), item('Money In', 430), item('Balance', 510)]),
      line([item('15 July 2026', 10), item('Example payment', 100), item('10.00', 350), item('90.00', 510)])
    ] }]
  };
  const result = parsePdfStatement(document, 'conflicting-balance.pdf', 'acct-1');
  assert.equal(result.summary.closingBalance, 95);
  assert.equal(result.summary.reconciliationDifference, -5);
  assert.equal(result.reconciled, false);
  assert.match(result.warnings.join(' '), /£5\.00/);
});

test('available funds are not confused with closing balance or arranged overdraft limit', () => {
  const item = (text, x) => ({ text, x, width: text.length * 5, y: 0, height: 10 });
  const line = (items) => ({ items, text: items.map((entry) => entry.text).join(' ') });
  const document = {
    text: 'Opening balance £0.00\nClosing balance -£300.00\nArranged overdraft: £1,000.00\nAvailable funds: £700.00',
    pages: [{ width: 600, lines: [
      line([item('Date', 10), item('Description', 100), item('Money Out', 350), item('Money In', 430), item('Balance', 510)]),
      line([item('15 July 2026', 10), item('Example payment', 100), item('300.00', 350), item('-300.00', 510)])
    ] }]
  };
  const result = parsePdfStatement(document, 'overdraft.pdf', 'acct-1');
  assert.equal(result.summary.closingBalance, -300);
  assert.equal(result.summary.overdraftLimit, 1000);
  assert.equal(result.reconciled, true);
});

test('malformed monetary values are rejected rather than converted to zero', () => {
  const result = parseCsvStatement('Date,Description,Amount\n01/08/2026,Malformed,£12..50', 'invalid-amount.csv', 'acct-1');
  assert.equal(result.records.length, 0);
  assert.match(result.rejected[0].reason, /amount/i);
});

test('fees and interest preserve their direction and distinct classification', () => {
  const result = parseCsvStatement('Date,Description,Amount,Balance\n01/08/2026,Overdraft fee,-5.00,-5.00\n02/08/2026,Interest received,1.25,-3.75', 'charges.csv', 'acct-1');
  assert.equal(result.records[0].category, 'Bank fees');
  assert.equal(result.records[0].transactionType, 'fee');
  assert.equal(result.records[1].category, 'Interest received');
  assert.equal(result.records[1].transactionType, 'interest');
  assert.equal(result.records[1].incoming, 1.25);
});

test('Lloyds-branded PDFs reuse the reconciled LBG statement layout', () => {
  const items = [
    { text: '1 Aug 25', x: 10 },
    { text: 'Example Employer', x: 100 },
    { text: 'FPI', x: 280 },
    { text: '1000.00', x: 350 },
    { text: '1000.00', x: 510 }
  ];
  const document = { text: 'Lloyds Bank plc', pages: [{ lines: [{ items, text: items.map((item) => item.text).join(' ') }] }] };
  const result = parsePdfStatement(document, 'lloyds-layout.pdf', '');
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].accountId, 'Lloyds');
  assert.equal(result.records[0].incoming, 1000);
  assert.equal(result.reconciled, true);
});

test('credit report parser extracts labelled score and debt details without guessing omissions', () => {
  const text = `Experian Credit Report
  Report date: 8 August 2025
  Credit score: 612 out of 999
  Lender: Example Card Provider Ltd
  Account type: Credit card
  Account number: ****1234
  Current balance: £420.50
  Credit limit: £1,200
  Minimum payment: £25.00
  APR: 29.9%
  Account status: Up to date
  Opened: 4 June 2021
  Last updated: 2 August 2025`;
  const result = parseCreditReportText(text, 'example-credit-report.pdf');
  const account = result.records[0].accounts[0];
  assert.equal(result.summary.provider, 'Experian');
  assert.equal(result.summary.reportDate, '2025-08-08');
  assert.equal(result.summary.score, 612);
  assert.equal(account.currentBalance, 420.5);
  assert.equal(account.creditLimit, 1200);
  assert.equal(account.contractualPayment, 25);
  assert.equal(account.apr, 0.299);
  assert.equal(account.accountReference, '••••1234');
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
