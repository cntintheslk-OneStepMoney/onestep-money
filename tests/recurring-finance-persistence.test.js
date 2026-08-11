import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FinanceDataStore } from '../data-store.js';
import { applyRecurringPatternDecision, deriveRecurringPatterns } from '../recurring-finance.js';

const seedPath = new URL('../seed-data.json', import.meta.url);

test('confirmed recurring decision survives restart and encrypted backup restore', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-recurring-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await store.initialise();

  let current = (await store.loadState()).state;
  current.transactions.push(
    fictionalTransaction('recurring-1', '2026-01-31', 75),
    fictionalTransaction('recurring-2', '2026-02-28', 79),
    fictionalTransaction('recurring-3', '2026-03-31', 72)
  );
  current = await store.saveState(current);
  const pattern = deriveRecurringPatterns(current)[0];
  current = applyRecurringPatternDecision(current, pattern.id, 'confirmed', new Date('2026-04-01T10:00:00.000Z'));
  current = await store.saveState(current);

  const restarted = new FinanceDataStore(directory, seedPath, null, { secureStorage: secureStorage() });
  await restarted.initialise();
  current = (await restarted.loadState()).state;
  assert.equal(deriveRecurringPatterns(current)[0].confirmationState, 'confirmed');

  const backupPath = path.join(directory, 'fictional-recurring.osmb');
  await restarted.createPortableBackup(backupPath, 'fictional-passphrase', current);
  const changed = structuredClone(current);
  for (const transaction of changed.transactions) delete transaction.recurringPatternDecision;
  await restarted.saveState(changed);

  const restored = await restarted.restorePortableBackup(backupPath, 'fictional-passphrase');
  assert.equal(restored.status, 'restored');
  assert.equal(deriveRecurringPatterns(restored.state)[0].confirmationState, 'confirmed');
});

function fictionalTransaction(id, date, outgoing) {
  return {
    id, date, budgetMonth: date.slice(0, 7), accountId: 'fictional-current-account',
    description: 'Fictional Energy Service', category: 'Household', incoming: 0, outgoing,
    duplicateStatus: 'none', reviewStatus: 'not_required', importReviewStatus: 'trusted', financiallyActive: true, transferStatus: 'no'
  };
}

function secureStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8'),
    decryptString: (value) => value.toString('utf8')
  };
}
