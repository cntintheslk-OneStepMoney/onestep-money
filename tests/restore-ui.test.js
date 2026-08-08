import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('restore UI requires confirmation, exposes safe metadata and reports every transaction stage', async () => {
  const [html, renderer] = await Promise.all([
    fs.readFile(new URL('../index.html', import.meta.url), 'utf8'),
    fs.readFile(new URL('../renderer-app.js', import.meta.url), 'utf8')
  ]);

  for (const id of ['restoreDialog', 'restoreCreatedAt', 'restoreApplicationVersion', 'restoreDocumentCount', 'restoreValidation', 'confirmRestoreButton', 'cancelRestoreButton']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const stage of ['preparing_backup', 'checking_backup_integrity', 'creating_safety_copy', 'restoring_financial_data', 'restoring_documents', 'verifying_restored_data', 'finishing']) {
    assert.match(html, new RegExp(`data-restore-stage="${stage}"`));
  }
  assert.match(html, /does not merge individual records/);
  assert.match(html, /financial state and saved documents will be restored together/);
  assert.match(renderer, /selectRestoreBackup\(passphrase\)/);
  assert.match(renderer, /restoreBackup\(token\)/);
  assert.match(renderer, /cancelRestoreBackup\(restoreToken\)/);
  assert.doesNotMatch(renderer, /window\.confirm\('Restore a backup/);
});
