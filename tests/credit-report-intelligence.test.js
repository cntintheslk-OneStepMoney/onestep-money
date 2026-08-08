import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseCreditReportText } from '../document-import.js';
import { debtSafetyAssessment } from '../finance-core.js';
import {
  applyCreditReportImportPlan, buildCreditReportImportPlan,
  normaliseAccountReference, normaliseCreditAccountType, normaliseCreditStatus, normaliseLender
} from '../credit-report-intelligence.js';

const stateFixture = () => ({
  profile: { currency: 'GBP' },
  accounts: [], transactions: [], payslips: [], taxDocuments: [], creditReports: [],
  debts: [], overdrafts: [], budgets: [], scheduledPayments: [], tasks: [], checkIns: [],
  documents: [{ id: 'document-1', parseStatus: 'ready' }], importBatches: [],
  settings: { selectedMonth: '2026-08', extraDebtPayment: 100, emergencyBufferTarget: 500, emergencyBufferBalance: 500 }
});

const debtFixture = (overrides = {}) => ({
  id: 'debt-1', name: 'Example Card Provider', type: 'Credit card', accountReference: '••••1234',
  currentBalance: 900, balanceEffectiveDate: '2026-07-31', balanceSourceProvider: 'experian',
  apr: 0.249, contractualPayment: 45, creditLimit: 1500, status: 'current', reportedStatus: 'Up to date',
  arrangementStatus: 'none', arrangementConfirmed: false, arrangementPayment: null, arrearsAmount: null,
  includeInPlan: true, statusConflict: false, planPriority: 1, ...overrides
});

const accountFixture = (overrides = {}) => ({
  id: 'report-account-1', lender: 'Example Card Provider Ltd', accountType: 'Credit card',
  normalisedAccountType: 'credit-card', accountReference: 'XXXX1234', currentBalance: 820,
  creditLimit: 1500, contractualPayment: 41, apr: null, status: 'Up to date', normalisedStatus: 'current',
  arrangementStatus: 'unknown', updatedDate: '2026-08-07', openedDate: '', defaultDate: '',
  arrearsAmount: null, arrangementPayment: null, interestFrozen: false, ...overrides
});

const previewFixture = (accounts = [accountFixture()], overrides = {}) => ({
  kind: 'credit-report', rejected: [], warnings: [], reconciled: true,
  summary: { provider: 'Experian', reportDate: '2026-08-08', score: 700, scoreMaximum: 999 },
  records: [{ id: 'report-1', provider: 'Experian', reportDate: '2026-08-08', score: 700, scoreMaximum: 999, accounts }],
  ...overrides
});

function planFor(state, preview = previewFixture()) {
  return buildCreditReportImportPlan(state, preview, 'document-1');
}

test('credit-report implementation is packaged and renderer confirms through the atomic plan', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');
  assert.equal(packageJson.version, '2.1.15');
  assert.ok(packageJson.build.files.includes('credit-report-intelligence.js'));
  assert.match(renderer, /buildCreditReportImportPlan\(state, preview/);
  assert.match(renderer, /applyCreditReportImportPlan\(state, preview/);
  assert.match(renderer, /await saveState\(applied\.state\)/);
});

test('normalisation recognises borrowing types, conservative lender aliases and visible ending digits', () => {
  assert.equal(normaliseCreditAccountType('Current account with overdraft'), 'overdraft');
  assert.equal(normaliseCreditAccountType('Hire purchase agreement'), 'hire-purchase');
  assert.equal(normaliseCreditAccountType('Catalogue / mail order'), 'catalogue-credit');
  assert.equal(normaliseCreditAccountType('Something unclear'), 'unknown');
  assert.equal(normaliseLender('BARCLAYCARD'), normaliseLender('Barclays Bank PLC'));
  assert.equal(normaliseAccountReference('Ending 1234'), '1234');
  assert.equal(normaliseAccountReference('123'), '');
});

test('provider parser distinguishes balances, limits, payment kinds and explicit risk metadata', () => {
  const parsed = parseCreditReportText(`Experian Credit Report
Report date: 8 August 2026
Credit score: 700 out of 999
Lender: Fictional Card Ltd
Account type: Credit card
Account number: Ending 4321
Current balance: £1,050.00
Credit limit: £1,000.00
Minimum payment: £35.00
APR: 29.9%
Status: In arrears
Arrears amount: £70.00
Missed payments: 2
Payment arrangement: Yes
Arrangement payment: £25.00
Interest frozen: Yes
Last updated: 7 August 2026`, 'fictional.pdf');
  const account = parsed.records[0].accounts[0];
  assert.equal(account.currentBalance, 1050);
  assert.equal(account.creditLimit, 1000);
  assert.equal(account.minimumPayment, 35);
  assert.equal(account.monthlyPayment, null);
  assert.equal(account.contractualPayment, 35);
  assert.equal(account.normalisedStatus, 'arrears');
  assert.equal(account.arrearsAmount, 70);
  assert.equal(account.missedPayments, 2);
  assert.equal(account.arrangementStatus, 'confirmed');
  assert.equal(account.arrangementPayment, 25);
  assert.equal(account.interestFrozen, true);
});

test('known providers retain their own score scale and explicit report date', () => {
  for (const provider of ['Experian', 'ClearScore', 'Credit Karma', 'TransUnion', 'Equifax', 'TotallyMoney']) {
    const parsed = parseCreditReportText(`${provider} Credit Report\nReport date: 8 August 2026\nCredit score: 650 out of 710`, `${provider}.pdf`);
    assert.equal(parsed.summary.provider, provider);
    assert.equal(parsed.summary.reportDate, '2026-08-08');
    assert.equal(parsed.summary.score, 650);
    assert.equal(parsed.summary.scoreMaximum, 710);
  }
  assert.equal(parseCreditReportText('TotallyMoney report using TransUnion data\nReport date: 8 August 2026', 'tm.pdf').summary.provider, 'TotallyMoney');
});

test('parser keeps settled, closed and default dates distinct', () => {
  const settled = parseCreditReportText(`Experian Credit Report
Report date: 8 August 2026
Lender: Fictional Settled Card
Account type: Credit card
Current balance: £0.00
Status: Settled
Settlement date: 30 May 2026
Closed date: 29 May 2026`, 'fictional-settled.pdf').records[0].accounts[0];
  assert.equal(settled.normalisedStatus, 'settled');
  assert.equal(settled.settledDate, '2026-05-30');
  assert.equal(settled.closedDate, '2026-05-29');
  assert.equal(settled.defaultDate, '');
});

test('invalid monetary text remains unknown rather than becoming zero or a guessed value', () => {
  const parsed = parseCreditReportText(`Experian Credit Report
Report date: 8 August 2026
Lender: Fictional Loan
Account type: Personal loan
Current balance: £1,2x0
Status: Current`, 'fictional-invalid.pdf');
  assert.equal(parsed.records[0].accounts[0].currentBalance, null);
});

test('an existing debt matches by lender, type and ending digits without creating a duplicate', () => {
  const state = stateFixture();
  state.debts = [debtFixture()];
  const plan = planFor(state);
  assert.equal(plan.accountPlans[0].existingId, 'debt-1');
  assert.equal(plan.accountPlans[0].category, 'update');
  const applied = applyCreditReportImportPlan(state, previewFixture(), plan, 'document-1', '2026-08-08T12:00:00.000Z');
  assert.equal(applied.state.debts.length, 1);
  assert.equal(applied.state.debts[0].currentBalance, 820);
});

test('same lender with two cards stays separate through distinct references', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ id: 'one', accountReference: '••••1111' }), debtFixture({ id: 'two', accountReference: '••••2222' })];
  const preview = previewFixture([
    accountFixture({ id: 'a', accountReference: 'XXXX1111', currentBalance: 700 }),
    accountFixture({ id: 'b', accountReference: 'XXXX2222', currentBalance: 600 })
  ]);
  const plan = planFor(state, preview);
  assert.deepEqual(plan.accountPlans.map((item) => item.existingId), ['one', 'two']);
});

test('a positive-balance unmatched account is proposed and created only on confirmation', () => {
  const state = stateFixture();
  const preview = previewFixture([accountFixture({ lender: 'Fictional Loan Provider', accountType: 'Personal loan', normalisedAccountType: 'personal-loan', accountReference: 'XXXX9999', currentBalance: 1460 })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'new');
  assert.equal(state.debts.length, 0);
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts.length, 1);
  assert.equal(applied.state.debts[0].currentBalance, 1460);
});

test('zero-balance and settled history never creates active borrowing', () => {
  const state = stateFixture();
  const preview = previewFixture([accountFixture({ currentBalance: 0, status: 'Settled', normalisedStatus: 'settled', lifecycleStatus: 'settled', settledDate: '2026-08-01' })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'ignore');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts.length, 0);
});

test('an explicit default updates risk state and Financial Safety remains authoritative', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ status: 'unknown', arrangementStatus: 'unknown' })];
  const preview = previewFixture([accountFixture({ status: 'Default', normalisedStatus: 'defaulted', defaultDate: '2026-06-01', arrangementStatus: 'unknown' })]);
  const plan = planFor(state, preview);
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  const safety = debtSafetyAssessment(applied.state);
  assert.equal(applied.state.debts[0].status, 'defaulted');
  assert.equal(applied.state.debts[0].defaultDate, '2026-06-01');
  assert.equal(safety.accounts[0].effectiveStatus, 'defaulted');
  assert.equal(safety.accounts[0].eligibleForExtra, false);
});

test('a later unknown status does not remove an existing default', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ status: 'defaulted', reportedStatus: 'Default', arrangementStatus: 'unknown' })];
  const preview = previewFixture([accountFixture({ status: '', normalisedStatus: 'unknown', updatedDate: '2026-08-07' })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].status, 'defaulted');
});

test('explicit arrears and payment arrangements update safety without becoming discretionary overpayments', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ status: 'current', arrangementStatus: 'unknown' })];
  const preview = previewFixture([accountFixture({ status: 'In arrears', normalisedStatus: 'arrears', arrangementStatus: 'confirmed', arrangementPayment: 30, arrearsAmount: 90 })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  const account = debtSafetyAssessment(applied.state).accounts[0];
  assert.equal(account.effectiveStatus, 'arrears');
  assert.equal(account.arrangementStatus, 'confirmed');
  assert.equal(account.requiredPayment, 30);
  assert.equal(account.eligibleForExtra, false);
});

test('omitted arrangement information never clears a confirmed arrangement', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ arrangementStatus: 'confirmed', arrangementConfirmed: true, arrangementPayment: 30 })];
  const preview = previewFixture([accountFixture({ arrangementStatus: 'unknown', arrangementPayment: null })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].arrangementStatus, 'confirmed');
  assert.equal(applied.state.debts[0].arrangementPayment, 30);
});

test('missing APR preserves the known APR while supplied payment and balance can update', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ apr: 0.249, contractualPayment: 45 })];
  const applied = applyCreditReportImportPlan(state, previewFixture(), planFor(state), 'document-1');
  assert.equal(applied.state.debts[0].apr, 0.249);
  assert.equal(applied.state.debts[0].contractualPayment, 41);
  assert.equal(applied.state.debts[0].currentBalance, 820);
});

test('an older credit-report balance cannot overwrite a newer trusted balance', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 700, balanceEffectiveDate: '2026-08-07' })];
  const preview = previewFixture([accountFixture({ currentBalance: 820, updatedDate: '2026-07-31' })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'conflict');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 700);
  assert.equal(applied.state.debts[0].statusConflict, true);
});

test('a newer credit-report balance updates after confirmation', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 820, balanceEffectiveDate: '2026-07-31' })];
  const preview = previewFixture([accountFixture({ currentBalance: 700, updatedDate: '2026-08-07' })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 700);
  assert.equal(applied.state.debts[0].balanceEffectiveDate, '2026-08-07');
});

test('same-date provider disagreement is a visible conflict rather than an arbitrary overwrite', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 800, balanceEffectiveDate: '2026-08-07', balanceSourceProvider: 'transunion' })];
  const preview = previewFixture([accountFixture({ currentBalance: 700, updatedDate: '2026-08-07' })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'conflict');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 800);
});

test('current-account borrowing is proposed as an overdraft, not a generic debt', () => {
  const state = stateFixture();
  const preview = previewFixture([accountFixture({ lender: 'Fictional Bank', accountType: 'Current account', normalisedAccountType: 'overdraft', currentBalance: 250, creditLimit: 500 })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].kind, 'overdraft');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts.length, 0);
  assert.equal(applied.state.overdrafts.length, 1);
  assert.equal(applied.state.overdrafts[0].limit, 500);
});

test('over-limit borrowing is explicit and reaches Financial Safety', () => {
  const state = stateFixture();
  const preview = previewFixture([accountFixture({ currentBalance: 1050, creditLimit: 1000, status: 'Current', normalisedStatus: 'over_limit' })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].status, 'over_limit');
  assert.equal(debtSafetyAssessment(applied.state).accounts[0].overLimit, true);
});

test('a current settled snapshot deactivates a matched zero-balance debt', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 50, balanceEffectiveDate: '2026-07-31' })];
  const preview = previewFixture([accountFixture({ currentBalance: 0, status: 'Settled', normalisedStatus: 'settled', lifecycleStatus: 'settled', settledDate: '2026-08-07', updatedDate: '2026-08-07' })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 0);
  assert.equal(applied.state.debts[0].lifecycleStatus, 'settled');
  assert.equal(applied.state.debts[0].includeInPlan, false);
});

test('an older settled snapshot cannot deactivate a newer positive balance', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 120, balanceEffectiveDate: '2026-08-07', includeInPlan: true })];
  const preview = previewFixture([accountFixture({ currentBalance: 0, status: 'Settled', normalisedStatus: 'settled', lifecycleStatus: 'settled', settledDate: '2026-07-31', updatedDate: '2026-07-31' })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'conflict');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 120);
  assert.notEqual(applied.state.debts[0].lifecycleStatus, 'settled');
  assert.equal(applied.state.debts[0].includeInPlan, true);
  assert.equal(debtSafetyAssessment(applied.state).accounts[0].eligibleForExtra, false);
});

test('closed but outstanding borrowing remains relevant', () => {
  const state = stateFixture();
  const preview = previewFixture([accountFixture({ lender: 'Fictional Closed Loan', accountType: 'Personal loan', normalisedAccountType: 'personal-loan', accountReference: 'XXXX7777', currentBalance: 600, status: 'Closed', normalisedStatus: 'closed', lifecycleStatus: 'closed' })]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts[0].currentBalance, 600);
  assert.equal(applied.state.debts[0].lifecycleStatus, 'closed');
  assert.equal(applied.state.debts[0].includeInPlan, true);
});

test('an existing account absent from a later report is never deleted', () => {
  const state = stateFixture();
  state.debts = [debtFixture()];
  const preview = previewFixture([]);
  const applied = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1');
  assert.equal(applied.state.debts.length, 1);
  assert.equal(applied.state.debts[0].id, 'debt-1');
});

test('same-lender ambiguity updates no arbitrary account', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ id: 'one', accountReference: '' }), debtFixture({ id: 'two', accountReference: '' })];
  const preview = previewFixture([accountFixture({ accountReference: '' })]);
  const plan = planFor(state, preview);
  assert.equal(plan.accountPlans[0].category, 'review');
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.deepEqual(applied.state.debts.map((item) => item.currentBalance), [900, 900]);
});

test('one same-lender account still needs review when lender and type are the only evidence', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ accountReference: '', openedDate: '' })];
  const preview = previewFixture([accountFixture({ accountReference: '', openedDate: '' })]);
  assert.equal(planFor(state, preview).accountPlans[0].category, 'review');
});

test('a repeated report row with the same ending digits cannot create duplicate borrowing', () => {
  const state = stateFixture();
  const first = accountFixture({ id: 'first', accountReference: 'XXXX4444', lender: 'Fictional Card' });
  const repeated = accountFixture({ id: 'repeated', accountReference: 'Ending 4444', lender: 'Fictional Card' });
  const preview = previewFixture([first, repeated]);
  const plan = planFor(state, preview);
  assert.deepEqual(plan.accountPlans.map((item) => item.category), ['new', 'review']);
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.debts.length, 1);
});

test('strong creditor-transfer evidence avoids double counting while weak evidence requires review', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ name: 'Original Fictional Lender', openedDate: '2020-01-01' })];
  const strong = previewFixture([accountFixture({ lender: 'Fictional Collections', openedDate: '2020-01-01', status: 'Debt purchased from original lender' })]);
  assert.equal(planFor(state, strong).accountPlans[0].existingId, 'debt-1');
  const weak = previewFixture([accountFixture({ lender: 'Different Collections', openedDate: '', status: 'Default' })]);
  assert.equal(planFor(state, weak).accountPlans[0].category, 'review');
});

test('mortgages, student loans, joint and disputed accounts are not forced into ordinary debt logic', () => {
  const state = stateFixture();
  const preview = previewFixture([
    accountFixture({ id: 'm', accountType: 'Mortgage', normalisedAccountType: 'mortgage', currentBalance: 100000 }),
    accountFixture({ id: 's', accountType: 'Student loan', normalisedAccountType: 'student-loan', currentBalance: 5000 }),
    accountFixture({ id: 'j', accountReference: 'XXXX5555', jointAccount: true }),
    accountFixture({ id: 'd', accountReference: 'XXXX6666', disputed: true })
  ]);
  assert.deepEqual(planFor(state, preview).accountPlans.map((item) => item.category), ['ignore', 'ignore', 'review', 'review']);
});

test('confirmation applies to a clone, records provenance and creates one coherent import batch', () => {
  const state = stateFixture();
  state.debts = [debtFixture()];
  const preview = previewFixture();
  const plan = planFor(state, preview);
  const applied = applyCreditReportImportPlan(state, preview, plan, 'document-1', '2026-08-08T12:00:00.000Z');
  assert.equal(state.debts[0].currentBalance, 900);
  assert.equal(state.creditReports.length, 0);
  assert.equal(state.importBatches.length, 0);
  assert.equal(applied.state.documents[0].parseStatus, 'imported');
  assert.equal(applied.state.creditReports[0].sourceDocumentId, 'document-1');
  assert.deepEqual(applied.state.debts[0].sourceCreditReportIds, ['report-1']);
  assert.equal(applied.state.importBatches.length, 1);
  assert.equal(applied.state.importBatches[0].kind, 'credit-report');
});

test('preview cancellation and persistent-save failure leave live financial state unchanged', async () => {
  const liveState = stateFixture();
  liveState.debts = [debtFixture()];
  const preview = previewFixture();
  const plan = planFor(liveState, preview);
  assert.equal(liveState.debts[0].currentBalance, 900);
  assert.equal(liveState.importBatches.length, 0);

  const applied = applyCreditReportImportPlan(liveState, preview, plan, 'document-1');
  let rendererState = liveState;
  await assert.rejects(async () => {
    await Promise.reject(new Error('simulated persistent save failure'));
    rendererState = applied.state;
  }, /simulated persistent save failure/);
  assert.equal(rendererState.debts[0].currentBalance, 900);
  assert.equal(rendererState.creditReports.length, 0);
  assert.equal(rendererState.importBatches.length, 0);
});

test('a confirmed report creates one batch and cannot be confirmed twice', () => {
  const state = stateFixture();
  const preview = previewFixture();
  const first = applyCreditReportImportPlan(state, preview, planFor(state, preview), 'document-1').state;
  const secondPlan = buildCreditReportImportPlan(first, preview, 'document-1');
  assert.throws(() => applyCreditReportImportPlan(first, preview, secondPlan, 'document-1'), /already has a completed import batch/);
  assert.equal(first.importBatches.length, 1);
});

test('a stale reviewed plan is rejected before any state can be mutated', () => {
  const state = stateFixture();
  state.debts = [debtFixture()];
  const preview = previewFixture();
  const plan = planFor(state, preview);
  state.debts[0].currentBalance = 875;
  assert.throws(() => applyCreditReportImportPlan(state, preview, plan, 'document-1'), /changed after this preview/);
  assert.equal(state.creditReports.length, 0);
  assert.equal(state.importBatches.length, 0);
});

test('chronological imports cannot let an older report processed later overwrite a newer fact', () => {
  const state = stateFixture();
  state.debts = [debtFixture({ currentBalance: 900, balanceEffectiveDate: '2026-07-01' })];
  const newer = previewFixture([accountFixture({ currentBalance: 700, updatedDate: '2026-08-07' })]);
  const first = applyCreditReportImportPlan(state, newer, planFor(state, newer), 'document-1').state;
  first.documents.push({ id: 'document-2', parseStatus: 'ready' });
  const older = previewFixture([accountFixture({ id: 'older-account', currentBalance: 820, updatedDate: '2026-07-31' })], {
    summary: { provider: 'Experian', reportDate: '2026-07-31' },
    records: [{ id: 'report-older', provider: 'Experian', reportDate: '2026-07-31', accounts: [accountFixture({ id: 'older-account', currentBalance: 820, updatedDate: '2026-07-31' })] }]
  });
  const secondPlan = buildCreditReportImportPlan(first, older, 'document-2');
  const second = applyCreditReportImportPlan(first, older, secondPlan, 'document-2').state;
  assert.equal(second.debts[0].currentBalance, 700);
  assert.equal(second.importBatches.length, 2);
});

test('status normalisation never treats negated risk text as a default or arrears', () => {
  assert.equal(normaliseCreditStatus('No arrears, not defaulted, up to date'), 'current');
  assert.equal(normaliseCreditStatus('Default'), 'defaulted');
  assert.equal(normaliseCreditStatus('Arrangement but status unclear'), 'unknown');
});
