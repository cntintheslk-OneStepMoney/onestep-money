import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const secretPatterns = [
  ['GitHub token', /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['AWS access key', /AKIA[0-9A-Z]{16}/],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/]
];

export function scanContent(path, content) {
  const findings = [];
  for (const [name, pattern] of secretPatterns) if (pattern.test(content)) findings.push({ path, rule: 'secret', detail: name });
  if (/\.github\/workflows\/.*\.ya?ml$/i.test(path)) {
    if (/pull_request_target\s*:/i.test(content)) findings.push({ path, rule: 'workflow', detail: 'pull_request_target requires explicit threat review' });
    if (/permissions\s*:\s*write-all/i.test(content)) findings.push({ path, rule: 'workflow', detail: 'write-all permissions forbidden' });
    if (/run\s*:[^\n]*\$\{\{\s*github\.event\./i.test(content)) findings.push({ path, rule: 'workflow', detail: 'untrusted event data interpolated into shell' });
    for (const match of content.matchAll(/uses:\s*([^\s@]+)@([^\s]+)/g)) if (!/^[0-9a-f]{40}$/i.test(match[2]) && !match[1].startsWith('./')) findings.push({ path, rule: 'supply-chain', detail: `action not pinned to commit: ${match[0]}` });
  }
  if (/\.(?:mjs|cjs|js|ts|tsx|jsx)$/i.test(path)) {
    if (/\beval\s*\(|new\s+Function\s*\(/.test(content)) findings.push({ path, rule: 'dynamic-execution', detail: 'dynamic code execution' });
    if (/\bexec\s*\([^)]*\+/.test(content)) findings.push({ path, rule: 'process-execution', detail: 'string-built process execution' });
  }
  return findings;
}

export function attackSurface(paths) {
  const surface = new Set();
  for (const path of paths) {
    if (path.startsWith('.github/workflows/')) surface.add('workflow-permissions-and-supply-chain');
    if (/package(?:-lock)?\.json$/.test(path)) surface.add('dependencies-and-install-scripts');
    if (/scripts?\//.test(path)) surface.add('process-filesystem-and-automation');
    if (/security|auth|permission|secret/i.test(path)) surface.add('security-controls');
    if (/schema|migration|data/i.test(path)) surface.add('state-data-and-migration');
  }
  return [...surface];
}

function changedFiles(base, head) {
  return execFileSync('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...${head}`], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
}

async function main() {
  const base = process.env.DEVOPS_BASE_SHA;
  const head = process.env.DEVOPS_HEAD_SHA ?? 'HEAD';
  if (!base) throw new Error('DEVOPS_BASE_SHA is required');
  const paths = changedFiles(base, head);
  const findings = [];
  for (const path of paths) {
    try { findings.push(...scanContent(path, await readFile(path, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const adapter = JSON.parse(await readFile(process.env.DEVOPS_ADAPTER ?? '.development-operations.yml', 'utf8'));
  const report = { base, head, paths, attackSurface: attackSurface(paths), repositoryThreatExtensions: adapter.security?.threatExtensions ?? [], automatedFindings: findings, changeAwareReviewRequired: true, zeroWaiver: true };
  console.log(JSON.stringify(report, null, 2));
  if (findings.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replaceAll('\\\\', '/')}`).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
