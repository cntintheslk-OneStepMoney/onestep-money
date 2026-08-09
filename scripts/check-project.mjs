import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignored = new Set(['node_modules', 'dist', 'release', 'tmp', '.git']);
const javascript = [];
walk(root);

for (const file of javascript) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${path.relative(root, file)} failed syntax check:\n${result.stderr}`);
}

const seed = JSON.parse(fs.readFileSync(path.join(root, 'seed-data.json'), 'utf8'));
const emptyCollections = ['accounts', 'transactions', 'payslips', 'taxDocuments', 'creditReports', 'debts', 'overdrafts', 'budgets', 'scheduledPayments', 'documents', 'tasks', 'checkIns', 'importBatches', 'reviewItems'];
for (const collection of emptyCollections) {
  if (!Array.isArray(seed[collection]) || seed[collection].length) throw new Error(`Public seed ${collection} must be an empty array.`);
}
if (seed.profile?.name) throw new Error('Public seed profile name must be blank.');
if (Number(seed.profile?.dependableIncome || 0) !== 0) throw new Error('Public seed dependable income must be zero.');
if (seed.settings?.selectedMonth) throw new Error('Public seed selected month must be blank and resolved at first run.');
if (Number(seed.settings?.extraDebtPayment || 0) !== 0) throw new Error('Public seed extra debt payment must be zero.');

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (packageJson.name !== 'onestep-money' || packageJson.build?.productName !== 'OneStep Money') throw new Error('Package branding is inconsistent.');
if (!packageJson.dependencies?.['electron-updater']) throw new Error('The installed update channel is not configured.');
verifyPackagedRuntimeDependencies(packageJson.build?.files || []);
if (!packageJson.build?.files?.includes('diagnostic-logger.js')) throw new Error('The diagnostic logger is missing from packaged builds.');
if (!packageJson.build?.files?.includes('transaction-ledger.js')) throw new Error('The paginated transaction ledger is missing from packaged builds.');
if (!packageJson.build?.files?.includes('review-lifecycle.js')) throw new Error('The persisted review lifecycle is missing from packaged builds.');
if (!packageJson.build?.files?.includes('next-move-priority.js')) throw new Error('The derived Next Move priority engine is missing from packaged builds.');
if (packageJson.scripts?.lint !== 'eslint .') throw new Error('The correctness-focused static analysis command is not configured.');

console.log(JSON.stringify({ javascriptFiles: javascript.length, seedCollections: emptyCollections.length, package: packageJson.name, version: packageJson.version }));

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs') || entry.name.endsWith('.cjs')) javascript.push(target);
  }
}

function verifyPackagedRuntimeDependencies(packagedEntries) {
  const missing = [];
  for (const entry of packagedEntries) {
    if (!entry.endsWith('.js') && !entry.endsWith('.cjs')) continue;
    const importerPath = path.join(root, entry);
    if (!fs.existsSync(importerPath)) continue;
    const source = fs.readFileSync(importerPath, 'utf8');
    for (const specifier of localRuntimeSpecifiers(source)) {
      const dependencyPath = resolveLocalRuntimeDependency(importerPath, specifier);
      if (!dependencyPath) continue;
      const relativeDependency = path.relative(root, dependencyPath).replaceAll(path.sep, '/');
      if (!isPackaged(relativeDependency, packagedEntries)) missing.push(`${entry} -> ${relativeDependency}`);
    }
  }
  if (missing.length) {
    throw new Error(`Packaged runtime dependencies are missing from build.files:\n${[...new Set(missing)].sort().join('\n')}`);
  }
}

function localRuntimeSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?:[^'\"]*?\s+from\s*)?['\"](\.[^'\"]+)['\"]/g,
    /\bimport\s*\(\s*['\"](\.[^'\"]+)['\"]\s*\)/g,
    /\brequire\s*\(\s*['\"](\.[^'\"]+)['\"]\s*\)/g
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]));
}

function resolveLocalRuntimeDependency(importerPath, specifier) {
  const candidate = path.resolve(path.dirname(importerPath), specifier);
  for (const resolved of [candidate, `${candidate}.js`, `${candidate}.cjs`, path.join(candidate, 'index.js')]) {
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

function isPackaged(relativePath, packagedEntries) {
  return packagedEntries.some((entry) => entry === relativePath || (entry.endsWith('/**') && relativePath.startsWith(entry.slice(0, -2))));
}
