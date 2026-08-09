import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import {
  buildTransactionLedgerIndex, filterTransactionLedger, paginateTransactionLedger
} from '../transaction-ledger.js';

test('all-time pagination makes every matching payment reachable beyond the former 300-row boundary', () => {
  const { state, analysis } = fictionalLedger(1_025);
  const index = buildTransactionLedgerIndex(state, analysis);
  const matches = filterTransactionLedger(index, { period: 'all', account: 'all', type: 'all', category: 'all' });
  const reached = new Set();

  for (let pageNumber = 1; pageNumber <= Math.ceil(matches.length / 100); pageNumber += 1) {
    const page = paginateTransactionLedger(matches, pageNumber, 100);
    for (const item of page.items) reached.add(item.id);
  }

  assert.equal(matches.length, 1_025);
  assert.equal(reached.size, 1_025);
  assert.ok(reached.has('transaction-1024'));
});

test('search and category filters inspect the complete applicable dataset before pagination', () => {
  const { state, analysis } = fictionalLedger(750);
  state.transactions[649].description = 'Fictional old boundary target';
  const index = buildTransactionLedgerIndex(state, analysis);

  const searchMatches = filterTransactionLedger(index, { period: 'all', search: 'boundary target' });
  const categoryMatches = filterTransactionLedger(index, { period: 'all', category: 'budget-food' });

  assert.deepEqual(searchMatches.map((item) => item.id), ['transaction-649']);
  assert.equal(categoryMatches.length, 375);
  assert.ok(categoryMatches.some((item) => item.id === 'transaction-748'));
});

test('large generated ledgers remain bounded and preserve complete results at 1k, 5k and 10k rows', () => {
  for (const size of [1_000, 5_000, 10_000]) {
    const { state, analysis } = fictionalLedger(size);
    const startedAt = performance.now();
    const index = buildTransactionLedgerIndex(state, analysis);
    const outgoing = filterTransactionLedger(index, { period: 'all', type: 'outgoing' });
    const lastPage = paginateTransactionLedger(outgoing, Math.ceil(outgoing.length / 100), 100);
    const elapsed = performance.now() - startedAt;

    assert.equal(outgoing.length, size);
    assert.ok(lastPage.items.length > 0 && lastPage.items.length <= 100);
    assert.ok(elapsed < 2_000, `${size} fictional payments took ${elapsed.toFixed(1)}ms to index and filter`);
  }
});

function fictionalLedger(size) {
  const transactions = Array.from({ length: size }, (_, index) => ({
    id: `transaction-${index}`,
    accountId: `account-${index % 4}`,
    date: `2026-${String((index % 12) + 1).padStart(2, '0')}-${String((index % 27) + 1).padStart(2, '0')}`,
    budgetMonth: `2026-${String((index % 12) + 1).padStart(2, '0')}`,
    description: `Fictional merchant ${index}`,
    incoming: 0,
    outgoing: (index % 200) + 1,
    transferStatus: 'no',
    notes: index % 9 === 0 ? 'Generated fixture' : ''
  }));
  const foodContributions = transactions.filter((_, index) => index % 2 === 0).map((item) => ({ id: item.id }));
  const uncategorisedTransactionIds = transactions.filter((_, index) => index % 2 === 1).map((item) => item.id);
  return {
    state: {
      accounts: Array.from({ length: 4 }, (_, index) => ({ id: `account-${index}`, name: `Fictional account ${index + 1}` })),
      transactions
    },
    analysis: {
      rows: [{ id: 'budget-food', category: 'Food', contributions: foodContributions }],
      uncategorisedTransactionIds
    }
  };
}
