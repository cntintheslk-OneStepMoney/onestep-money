import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveIssueMetadata, extract, validateIssueMetadata } from '../scripts/project-sync.mjs';

test('canonical numbered metadata with bold labels is parsed', () => {
  const body = `## Project metadata

1. **Priority:** High
2. **Complexity:** Small
3. **Title:** Example work
4. **Status:** In Progress
5. **Type:** Bug
6. **Target Release:** v2.3.1
7. **Area:** Repository / Git History / Maintenance
8. **Branch:** \`fix/example\`
9. **Start Date:** 2026-08-20
10. **Target Date:** *(blank — not scheduled)*`;

  assert.equal(extract(body, 'Priority'), 'High');
  assert.equal(extract(body, 'Complexity'), 'Small');
  assert.equal(extract(body, 'Status'), 'In Progress');
  assert.equal(extract(body, 'Type'), 'Bug');
  assert.equal(extract(body, 'Target Release'), 'v2.3.1');
  assert.equal(extract(body, 'Area'), 'Repository / Git History / Maintenance');
  assert.equal(extract(body, 'Branch'), 'fix/example');
  assert.equal(extract(body, 'Start Date'), '2026-08-20');
  assert.equal(extract(body, 'Target Date'), undefined);
});

test('existing heading, bullet and standalone bold metadata forms remain supported', () => {
  const body = `## Priority
High
- **Complexity:** Medium
* Status: Planned
**Planned branch:** \`fix/project-sync-numbered-metadata\``;

  assert.equal(extract(body, 'Priority'), 'High');
  assert.equal(extract(body, 'Complexity'), 'Medium');
  assert.equal(extract(body, 'Status'), 'Planned');
  assert.equal(extract(body, 'Planned branch'), 'fix/project-sync-numbered-metadata');
});

test('canonical blank placeholders do not become Project field values', () => {
  const body = `8. **Branch:** *(blank — not commenced)*
9. **Start Date:** *(blank — not commenced)*
10. **Target Date:** *(blank — not scheduled)*`;

  assert.equal(extract(body, 'Branch'), undefined);
  assert.equal(extract(body, 'Start Date'), undefined);
  assert.equal(extract(body, 'Target Date'), undefined);
});

test('ordinary Work titles only fall back to valid Project Types', () => {
  for (const type of ['Feature', 'Bug', 'UI/UX', 'Security', 'QOL', 'Maintenance']) {
    const metadata = deriveIssueMetadata({ title: `[Work][${type}][v2.3.1] Example`, body: '', state: 'open' });
    assert.equal(metadata.Type, type);
  }
});

test('explicit body Type wins over title fallback', () => {
  const metadata = deriveIssueMetadata({
    title: '[Work][Bug][v2.3.1] Example',
    body: '5. **Type:** Security',
    state: 'open'
  });
  assert.equal(metadata.Type, 'Security');
});

test('Umbrella stays typeless while Design Brief can use an explicit valid Type', () => {
  const umbrella = deriveIssueMetadata({
    title: '[Roadmap][Umbrella][v2.3.1] Stability',
    body: '5. **Type:** *(blank — umbrellas are branchless)*',
    state: 'open'
  });
  assert.equal(Object.hasOwn(umbrella, 'Type'), false);

  const design = deriveIssueMetadata({
    title: '[Roadmap][Design Brief][v2.3.1] Example',
    body: '5. **Type:** UI/UX',
    state: 'open'
  });
  assert.equal(design.Type, 'UI/UX');
});

test('explicit lifecycle metadata is respected until stronger Git or PR facts exist', () => {
  const issue = {
    title: '[Work][Bug][v2.3.1] Example',
    body: '4. **Status:** Backlog',
    state: 'open'
  };

  assert.equal(deriveIssueMetadata(issue).Status, 'Backlog');
  assert.equal(deriveIssueMetadata(issue, { branch: 'fix/example' }).Status, 'In Progress');
  assert.equal(deriveIssueMetadata(issue, { branch: 'fix/example', reviewReady: true }).Status, 'Review');
  assert.equal(deriveIssueMetadata(issue, { branch: 'fix/example', merged: true }).Status, 'Done');
});

test('Future Design Brief and Target Release fallbacks remain conservative', () => {
  const future = deriveIssueMetadata({
    title: '[Roadmap][Design Brief][Future] Local accounts',
    body: '',
    state: 'open'
  });
  assert.equal(future.Status, 'Backlog');
  assert.equal(Object.hasOwn(future, 'Target Release'), false);

  const versioned = deriveIssueMetadata({
    title: '[Work][Maintenance][v2.3.2] Example',
    body: '',
    state: 'open'
  });
  assert.equal(versioned['Target Release'], 'v2.3.2');
});

test('Area validation runs after numbered metadata is parsed', () => {
  const metadata = deriveIssueMetadata({
    title: '[Work][Bug][v2.3.1] Example',
    body: '7. **Area:** Demo / UI/UX',
    state: 'open'
  });

  assert.equal(validateIssueMetadata(metadata, ['Demo / UI/UX']), metadata);
  assert.throws(() => validateIssueMetadata(metadata, ['Repository / Git History / Maintenance']), /Area not allowed by adapter/);
});
