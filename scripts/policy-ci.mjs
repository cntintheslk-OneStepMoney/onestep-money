import { readFile } from 'node:fs/promises';

export function validateVersions(packageJson, lock, expected) {
  const observed = { package: packageJson.version, lock: lock.version, root: lock.packages?.['']?.version };
  const errors = [];
  for (const [name, value] of Object.entries(observed)) if (value !== expected) errors.push(`${name} version ${value ?? 'missing'} != expected ${expected}`);
  return { observed, errors };
}

export function validateBranch(branch) {
  if (['main', 'development', 'production'].includes(branch)) return [];
  return /^(feature|fix|security|policy|release|migration|maintenance)\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(branch) ? [] : [`invalid branch: ${branch}`];
}

export function validatePullRequest(title, body) {
  const errors = [];
  if (!title?.trim()) errors.push('PR title is required');
  for (let number = 1; number <= 15; number += 1) if (!new RegExp(`^## ${number}\\.`, 'm').test(body ?? '')) errors.push(`missing PR section ${number}`);
  if (!/^## 8\. Security review\s*$/im.test(body ?? '')) errors.push('missing canonical Security review section');
  if (!/no (?:known |identified )?(?:genuine )?security finding remains unresolved|no known finding/i.test(body ?? '')) errors.push('missing explicit zero-waiver security conclusion');
  if (!/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#\d+|Issue[^\n]*#\d+/i.test(body ?? '')) errors.push('missing Issue traceability');
  return errors;
}

async function main() {
  const errors = [];
  errors.push(...validateBranch(process.env.DEVOPS_BRANCH ?? ''));
  if (process.env.DEVOPS_PR_BODY_FILE) errors.push(...validatePullRequest(process.env.DEVOPS_PR_TITLE, await readFile(process.env.DEVOPS_PR_BODY_FILE, 'utf8')));
  const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  const expectedVersion = process.env.DEVOPS_EXPECTED_VERSION || packageJson.version;
  const version = validateVersions(packageJson, lock, expectedVersion);
  errors.push(...version.errors);
  const report = { branch: process.env.DEVOPS_BRANCH, expectedVersion, observedVersions: version.observed, independentCentralReadStillRequired: true, errors };
  console.log(JSON.stringify(report, null, 2));
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\\\', '/')}`).href) main();
