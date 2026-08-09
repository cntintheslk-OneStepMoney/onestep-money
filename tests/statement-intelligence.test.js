import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  detectRecurringTransactions, findDuplicateCandidates, matchInternalTransfers,
  isTransactionFinanciallyActive, matchStatementAccount, syncStatementAccount
} from '../finance-core.js';
import { applyStatementImportPlan, buildStatementImportPlan } from '../statement-intelligence.js';
import { activeReviewItems, resolveReviewItem } from '../review-lifecycle.js';

const transaction = (overrides = {}) => ({
  id: overrides.id || `transaction-${Math.random()}`,
  accountId: 'account-1',
  date: '2026-08-01',
  description: 'Example payment',
  reference: '',
  providerTransactionId: '',
  incoming: 0,
  outgoing: 10,
  runningBalance: 90,
  transferStatus: 'no',
  ...overrides
});

const baseState = () => ({
  profile: { currency: 'GBP' },
  accounts: [{ id: 'account-1', name: 'Main account', institution: 'Example Bank', accountReference: '••••1234', type: 'Current account', currentBalance: 100, statementDate: '2026-07-31' }],
  transactions: [],
  overdrafts: [],
  documents: [{ id: 'document-1', parseStatus: 'ready' }],
  importBatches: []
});

const statementPreview = (records, overrides = {}) => ({
  kind: 'statement',
  accountHint: 'account-1',
  records,
  rejected: [],
  warnings: [],
  reconciled: true,
  accountIdentity: { institution: 'Example Bank', accountReference: '••••1234', accountType: 'Current account', currency: 'GBP' },
  summary: { openingBalance: 100, closingBalance: 90, statementStartDate: '2026-08-01', statementEndDate: '2026-08-01', currency: 'GBP' },
  ...overrides
});

test('statement preview exposes classified changes and confirms through the atomic plan', () => {
  const markup = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(markup, /id="importChanges"/);
  assert.match(renderer, /buildStatementImportPlan\(state, preview/);
  assert.match(renderer, /applyStatementImportPlan\(state, preview/);
  assert.match(renderer, /await saveState\(applied\.state\)/);
  assert.ok(packageJson.build.files.includes('statement-intelligence.js'));
});

test('overlapping statements exclude deterministic transaction identities without using source row', () => {
  const existing = [transaction({ id: 'existing', sourceRow: 4 })];
  const incoming = [transaction({ id: 'incoming', sourceRow: 99 })];
  const result = findDuplicateCandidates(existing, incoming);
  assert.equal(result.exact.length, 1);
  assert.equal(result.possible.length, 0);
});

test('same amount and date at a different merchant remains a new transaction', () => {
  const existing = [transaction({ id: 'existing', description: 'Merchant Alpha' })];
  const incoming = [transaction({ id: 'incoming', description: 'Merchant Beta' })];
  const result = findDuplicateCandidates(existing, incoming);
  assert.equal(result.exact.length, 0);
  assert.equal(result.possible.length, 1);
});

test('possible duplicate imports are retained with pending inactive review state', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'existing', description: 'Merchant Alpha' }));
  const preview = statementPreview([transaction({ id: 'possible', description: 'Merchant Beta' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');
  const possible = applied.state.transactions.find((item) => item.id === 'possible');

  assert.equal(plan.counts.needsReview, 1);
  assert.equal(possible.duplicateStatus, 'possible');
  assert.equal(possible.reviewStatus, 'pending');
  assert.equal(possible.financiallyActive, false);
  assert.equal(possible.sourceDocumentId, 'document-1');
  assert.equal(possible.recurring, false);
  assert.equal(possible.transferStatus, 'no');
  assert.equal(possible.duplicateCandidateId, 'existing');
  assert.equal(applied.state.reviewItems.filter((item) => item.type === 'possible_duplicate' && item.status === 'needs_attention').length, 1);
});

test('provider transaction identifiers provide exact duplicate evidence', () => {
  const existing = [transaction({ id: 'existing', providerTransactionId: 'FIT-123', description: 'Old display text', runningBalance: null })];
  const incoming = [transaction({ id: 'incoming', providerTransactionId: 'FIT-123', description: 'New display text', runningBalance: null })];
  assert.equal(findDuplicateCandidates(existing, incoming).exact[0].evidence, 'provider-id');
});

test('selected account conflicts are blocked when strong statement identifiers disagree', () => {
  const accounts = baseState().accounts;
  const result = matchStatementAccount(accounts, statementPreview([], { accountIdentity: { institution: 'Other Bank', accountReference: '••••9999', accountType: 'Current account' } }));
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.conflicts.sort(), ['account_reference', 'institution']);
});

test('bank name alone never selects between two accounts at the same institution', () => {
  const accounts = [
    { id: 'one', institution: 'Example Bank', accountReference: '••••1111', type: 'Current account' },
    { id: 'two', institution: 'Example Bank', accountReference: '••••2222', type: 'Current account' }
  ];
  const preview = statementPreview([], { accountHint: '', accountIdentity: { institution: 'Example Bank', accountReference: '', accountType: 'Current account' } });
  assert.equal(matchStatementAccount(accounts, preview).status, 'unmatched');
});

test('safe account reference plus compatible institution identifies one existing account', () => {
  const accounts = [
    { id: 'one', institution: 'Example Bank', accountReference: '••••1111', type: 'Current account' },
    { id: 'two', institution: 'Example Bank', accountReference: '••••2222', type: 'Current account' }
  ];
  const preview = statementPreview([], { accountHint: '', accountIdentity: { institution: 'Example Bank', accountReference: '••••2222', accountType: 'Current account' } });
  const match = matchStatementAccount(accounts, preview);
  assert.equal(match.status, 'matched');
  assert.equal(match.account.id, 'two');
  assert.equal(match.confidence, 'strong-identity');
});

test('older reconciled statements never replace a newer trusted balance', () => {
  const state = baseState();
  state.accounts[0].currentBalance = 75;
  state.accounts[0].statementDate = '2026-08-08';
  const preview = statementPreview([transaction({ date: '2026-07-31' })], { summary: { openingBalance: 100, closingBalance: 90, statementStartDate: '2026-07-01', statementEndDate: '2026-07-31', currency: 'GBP' } });
  assert.equal(syncStatementAccount(state, state.accounts[0], preview, 'document-1'), 'historical-only');
  assert.equal(state.accounts[0].currentBalance, 75);
  assert.equal(state.accounts[0].statementDate, '2026-08-08');
});

test('newer reconciled statement updates balance and over-limit overdraft state', () => {
  const state = baseState();
  const preview = statementPreview([transaction()], { summary: { openingBalance: 100, closingBalance: -1150, overdraftLimit: 1000, statementStartDate: '2026-08-01', statementEndDate: '2026-08-01', currency: 'GBP' } });
  assert.equal(syncStatementAccount(state, state.accounts[0], preview, 'document-1'), 'overdraft-created');
  assert.equal(state.accounts[0].currentBalance, -1150);
  assert.equal(state.overdrafts[0].currentBalance, 1150);
  assert.equal(state.overdrafts[0].limit, 1000);
  assert.equal(state.overdrafts[0].status, 'over_limit');
});

test('recurring salary tolerates varying amounts when cadence and source are consistent', () => {
  const history = [
    transaction({ id: 'salary-1', date: '2026-06-30', description: 'EXAMPLE PAYROLL 1001', incoming: 2100, outgoing: 0 }),
    transaction({ id: 'salary-2', date: '2026-07-31', description: 'EXAMPLE PAYROLL 1002', incoming: 2340, outgoing: 0 })
  ];
  const current = transaction({ id: 'salary-3', date: '2026-08-29', description: 'EXAMPLE PAYROLL 1003', incoming: 2215, outgoing: 0 });
  const result = detectRecurringTransactions(history, [current]);
  assert.equal(result[0].confidence, 'confirmed');
  assert.equal(result[0].cadence, 'monthly');
});

test('one incoming payment is not promoted to recurring income', () => {
  const current = transaction({ id: 'one-off', date: '2026-08-01', description: 'Birthday transfer', incoming: 50, outgoing: 0 });
  assert.deepEqual(detectRecurringTransactions([], [current]), []);
});

test('variable utility amounts can form a monthly recurring observation', () => {
  const history = [
    transaction({ id: 'bill-1', date: '2026-06-12', description: 'Example Energy DD 1111', outgoing: 42.5 }),
    transaction({ id: 'bill-2', date: '2026-07-12', description: 'Example Energy DD 2222', outgoing: 61.7 })
  ];
  const current = transaction({ id: 'bill-3', date: '2026-08-12', description: 'Example Energy DD 3333', outgoing: 37.2 });
  const result = detectRecurringTransactions(history, [current]);
  assert.equal(result[0].confidence, 'confirmed');
  assert.equal(result[0].cadence, 'monthly');
});

test('strong internal-transfer evidence confirms a unique cross-account pair', () => {
  const rows = [
    transaction({ id: 'out', accountId: 'account-1', description: 'Transfer to Savings 5678', reference: 'MOVE5678', outgoing: 300, runningBalance: 0 }),
    transaction({ id: 'in', accountId: 'account-2', description: 'Internal transfer from Main 1234', reference: 'MOVE5678', incoming: 300, outgoing: 0, runningBalance: 300 })
  ];
  const accounts = [
    { id: 'account-1', name: 'Main', accountReference: '••••1234' },
    { id: 'account-2', name: 'Savings', accountReference: '••••5678' }
  ];
  assert.equal(matchInternalTransfers(rows, accounts)[0].confidence, 'confirmed');
});

test('equal-value nearby transactions without transfer evidence remain only possible', () => {
  const rows = [
    transaction({ id: 'out', accountId: 'account-1', description: 'Example purchase', outgoing: 300 }),
    transaction({ id: 'in', accountId: 'account-2', description: 'Example refund', incoming: 300, outgoing: 0 })
  ];
  assert.equal(matchInternalTransfers(rows)[0].confidence, 'possible');
});

test('confirmed plan applies to a clone, creates one batch and preserves the reviewed source state', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1', '2026-08-08T20:00:00.000Z');
  assert.equal(state.transactions.length, 0);
  assert.equal(state.importBatches.length, 0);
  assert.equal(applied.state.transactions.length, 1);
  assert.equal(applied.state.importBatches.length, 1);
  assert.equal(applied.state.documents[0].parseStatus, 'imported');
  assert.equal(applied.result.balanceAction, 'account-updated');
});

test('overlapping statement keeps one transaction and adds the second source relationship', () => {
  const state = baseState();
  state.transactions.push(transaction({ id: 'existing', sourceDocumentId: 'document-old' }));
  const preview = statementPreview([transaction({ id: 'incoming', sourceRow: 88 })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.transactions.length, 1);
  assert.deepEqual(applied.state.transactions[0].sourceDocumentIds.sort(), ['document-1', 'document-old']);
  assert.equal(applied.state.importBatches[0].exactDuplicateCount, 1);
});

test('a changed state invalidates a stale reviewed plan before any mutation', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'new-payment' })]);
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  state.transactions.push(transaction({ id: 'concurrent-change', description: 'Another payment' }));
  assert.throws(() => applyStatementImportPlan(state, preview, plan, 'document-1'), /changed after this preview/i);
  assert.equal(state.importBatches.length, 0);
});

test('unreconciled statements can add reviewed transactions without changing account balance', () => {
  const state = baseState();
  const preview = statementPreview([transaction({ id: 'reviewed-payment' })], { reconciled: false, warnings: ['Balance could not be reconciled.'], summary: { openingBalance: 100, closingBalance: 1, statementStartDate: '2026-08-01', statementEndDate: '2026-08-01', currency: 'GBP' } });
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  const applied = applyStatementImportPlan(state, preview, plan, 'document-1');
  assert.equal(applied.state.transactions.length, 1);
  assert.equal(applied.state.accounts[0].currentBalance, 100);
  assert.equal(applied.result.balanceAction, '');
  assert.equal(applied.state.transactions[0].importReviewStatus, 'pending');
  assert.equal(isTransactionFinanciallyActive(applied.state.transactions[0]), false);
  const review = activeReviewItems(applied.state).find((item) => item.type === 'import_conflict');
  assert.ok(review);
  resolveReviewItem(applied.state, review.id, 'apply_import');
  assert.equal(applied.state.transactions[0].importReviewStatus, 'accepted');
  assert.equal(isTransactionFinanciallyActive(applied.state.transactions[0]), true);
});

test('foreign-currency statement is review-only for a GBP profile', () => {
  const state = baseState();
  const preview = statementPreview([transaction()], { accountIdentity: { institution: 'Example Bank', accountReference: '••••1234', accountType: 'Current account', currency: 'EUR' }, summary: { closingBalance: 90, statementEndDate: '2026-08-01', currency: 'EUR' } });
  const plan = buildStatementImportPlan(state, preview, 'document-1');
  assert.equal(plan.canApply, false);
  assert.match(plan.warnings.join(' '), /uses EUR/i);
});
