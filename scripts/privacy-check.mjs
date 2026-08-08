import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ignoredDirectories = new Set(['node_modules', 'dist', 'release', 'tmp', '.git']);
const forbiddenFileTypes = new Set(['.pdf', '.xlsx', '.xls', '.csv', '.qif', '.ofx', '.vault', '.hfb', '.lfb', '.osmb']);
const textExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.yml', '.yaml', '.txt', '']);
const forbiddenText = [
  /harry/i,
  /sanderson/i,
  /core meals/i,
  /capital one/i,
  /creation(?:\.co)?/i,
  /lendable/i,
  /admiral insurance/i,
  /lowell/i,
  /vodafone device/i,
  /\bplum\b/i,
  /\b(?:8578\.22|7313\.33|1264\.89|2613\.09|3264\.34|2448\.96|640\.43|910\.90|756\.62|275\.35|232\.92|160\.55|2090)\b/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /\bsk-[A-Za-z0-9_-]{20,}/
];

const failures = [];
let checkedFiles = 0;
walk(root);
if (failures.length) throw new Error(`Privacy check failed:\n${failures.join('\n')}`);
console.log(JSON.stringify({ privacyCheck: 'passed', checkedFiles }));

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignoredDirectories.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    checkedFiles += 1;
    const relative = path.relative(root, target);
    const extension = path.extname(entry.name).toLowerCase();
    if (forbiddenFileTypes.has(extension)) failures.push(`${relative}: financial document type must not be committed`);
    if (extension === '.png' && !relative.startsWith(`assets${path.sep}`)) failures.push(`${relative}: PNG files are allowed only in the reviewed assets directory`);
    if (extension === '.ico' && relative !== path.join('build', 'icon.ico')) failures.push(`${relative}: unexpected icon file`);
    if (!textExtensions.has(extension) || entry.name === 'package-lock.json' || entry.name === 'privacy-check.mjs') continue;
    const contents = fs.readFileSync(target, 'utf8');
    for (const pattern of forbiddenText) if (pattern.test(contents)) failures.push(`${relative}: matched forbidden pattern ${pattern}`);
  }
}
