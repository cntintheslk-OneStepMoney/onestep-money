import { execFileSync } from 'node:child_process';

const titlePattern = /^\[(?:v\d+\.\d+\.\d+|Unscheduled|Historical|Superseded)\]\[(?:Feature|Bug|UI\/UX|Security|QOL|Maintenance)\] .+/;
const requiredPrSections = [
  '## Purpose',
  '## Work completed',
  '## Files changed',
  '## User-facing changes',
  '## Technical changes',
  '## Testing and verification',
  '## Data and migration impact',
  '## Known limitations',
  '## Excluded work',
  '## Branch details',
  '## Confirmations'
];
const requiredCommitLabels = ['Purpose:', 'Changes:', 'Verification:', 'Issue:'];
const grandfatherThroughPr = 120;

const prNumber = Number(process.env.PR_NUMBER || 0);
const prTitle = String(process.env.PR_TITLE || '');
const prBody = String(process.env.PR_BODY || '');
const baseSha = String(process.env.BASE_SHA || '');
const headSha = String(process.env.HEAD_SHA || '');

if (!prNumber || !prTitle) {
  console.log('Git convention check skipped outside pull requests.');
  process.exit(0);
}

const failures = [];
if (!titlePattern.test(prTitle)) {
  failures.push(`PR title must match [vX.Y.Z][Type] Concise title (or an allowed Unscheduled/Historical/Superseded prefix): ${prTitle}`);
}
for (const section of requiredPrSections) {
  if (!prBody.includes(section)) failures.push(`PR body is missing required section: ${section}`);
}

if (prNumber > grandfatherThroughPr) {
  if (!baseSha || !headSha) {
    failures.push('BASE_SHA and HEAD_SHA are required to validate commit messages.');
  } else {
    let log = '';
    try {
      log = execFileSync('git', ['log', '--format=%H%x1f%s%x1f%b%x1e', `${baseSha}..${headSha}`], { encoding: 'utf8' });
    } catch (error) {
      failures.push(`Unable to inspect PR commits: ${error.message}`);
    }
    for (const record of log.split('\x1e').map((value) => value.trim()).filter(Boolean)) {
      const [sha = '', subject = '', body = ''] = record.split('\x1f');
      if (subject.startsWith('Merge ')) continue;
      if (!titlePattern.test(subject)) failures.push(`${sha.slice(0, 7)} commit title is not OSM-formatted: ${subject}`);
      for (const label of requiredCommitLabels) {
        if (!body.includes(label)) failures.push(`${sha.slice(0, 7)} commit body is missing ${label}`);
      }
    }
  }
} else {
  console.log(`Commit-message enforcement is grandfathered through PR #${grandfatherThroughPr}; PR metadata is still validated.`);
}

if (failures.length) {
  console.error('Git convention check failed:\n- ' + failures.join('\n- '));
  process.exit(1);
}

console.log('Git convention check passed.');
