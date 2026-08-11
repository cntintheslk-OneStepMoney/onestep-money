import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

test('package metadata derives the release version from package.json', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/);
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[''].version, packageJson.version);
});

test('runtime display and Windows artifact naming derive from package metadata', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const mainProcess = fs.readFileSync(new URL('../main-process.js', import.meta.url), 'utf8');
  const renderer = fs.readFileSync(new URL('../renderer-app.js', import.meta.url), 'utf8');

  assert.equal(packageJson.build.win.artifactName, 'onestep-money-${version}-windows-${arch}.${ext}');
  assert.match(mainProcess, /ipcMain\.handle\('app:version', \(\) => app\.getVersion\(\)\)/);
  assert.match(renderer, /window\.financeAPI\.getAppVersion\(\)/);
  assert.doesNotMatch(renderer, new RegExp(`v${packageJson.version.replaceAll('.', '\\.')}`));
});

test('the current package version has consolidated changelog coverage', () => {
  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const changelog = fs.readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const escapedVersion = packageJson.version.replaceAll('.', '\\.');

  assert.match(changelog, new RegExp(`^## ${escapedVersion}(?:\\s|$)`, 'm'));
});
