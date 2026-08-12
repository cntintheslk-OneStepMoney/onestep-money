const fs = require('node:fs');

const version = '2.2.4';

const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
packageJson.version = version;
fs.writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);

const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
packageLock.version = version;
if (!packageLock.packages?.['']) throw new Error('package-lock root package metadata is missing.');
packageLock.packages[''].version = version;
fs.writeFileSync('package-lock.json', `${JSON.stringify(packageLock, null, 2)}\n`);

const section = `## 2.2.4 — Windows Pointer and Fullscreen Rendering

### Bug
- Removed post-v2.1.26 renderer self-observation loops that could repeatedly refresh debt presentation and automation history and starve normal pointer, layout and fullscreen work (#145).
- Restored packaged Windows native mouse interaction across sidebar navigation and ordinary Dashboard controls after delayed startup activity.
- Verified wheel scrolling continues to reach the intended scroll surface while click input remains responsive.
- Restored renderer, hit-test and scroll-surface resizing through maximize, fullscreen and return-to-windowed transitions.

### Maintenance
- Added privacy-safe packaged Windows native-input diagnostics using the real OS cursor/button/wheel path rather than relying only on \`webContents.sendInputEvent\`.
- Added hit-test, viewport, scrollbar-gutter, fixed-surface and renderer-stability regression coverage for delayed startup and fullscreen transitions.
- Kept the confirmed-working BrowserWindow/GPU configuration unchanged rather than disabling hardware acceleration or forcing content bounds speculatively.
- Updated application package and lockfile metadata for v2.2.4.

### Data/Migration
- No stored-data format or migration changes.

### Known Limitations
- Automated packaged-Windows verification passed, but final physical Windows review by the user remains required before #145 is considered complete.

`;

let changelog = fs.readFileSync('CHANGELOG.md', 'utf8');
if (!changelog.includes('## 2.2.4')) {
  const marker = '## 2.2.3';
  const index = changelog.indexOf(marker);
  if (index < 0) throw new Error('Expected 2.2.3 changelog marker was not found.');
  changelog = `${changelog.slice(0, index)}${section}${changelog.slice(index)}`;
  fs.writeFileSync('CHANGELOG.md', changelog);
}
