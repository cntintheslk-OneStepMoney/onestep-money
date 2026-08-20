import assert from 'node:assert/strict';
import test from 'node:test';
import { listRepositoryBranches, listRepositoryIssues, paginateRest, syncIssues } from '../scripts/project-sync.mjs';

function pagedClient(itemsByPath, calls = []) {
  return {
    owner: 'Blackline-Development-DevOps',
    async rest(path) {
      calls.push(path);
      const url = new URL(`https://example.invalid${path}`);
      const key = url.pathname + (url.searchParams.has('state') ? `?state=${url.searchParams.get('state')}` : '');
      const all = itemsByPath[key];
      if (!all) throw new Error(`unexpected REST path: ${path}`);
      const page = Number(url.searchParams.get('page') || 1);
      const perPage = Number(url.searchParams.get('per_page') || 100);
      return all.slice((page - 1) * perPage, page * perPage);
    }
  };
}

function issue(number, extra = {}) {
  return { number, node_id: `ISSUE_${number}`, title: `[Work][Bug][v2.3.1] Issue ${number}`, body: '', state: 'open', created_at: '2026-08-20T00:00:00Z', ...extra };
}

test('full issue reconciliation paginates beyond 100 and filters pull requests only after retrieval', async () => {
  const raw = Array.from({ length: 205 }, (_, index) => issue(index + 1));
  raw[25] = { ...raw[25], pull_request: { url: 'https://example.invalid/pr/26' } };
  raw[150] = { ...raw[150], pull_request: { url: 'https://example.invalid/pr/151' } };
  const calls = [];
  const issues = await listRepositoryIssues(pagedClient({ '/issues?state=all': raw }, calls));

  assert.equal(issues.length, 203);
  assert.equal(issues.at(-1).number, 205);
  assert.deepEqual(calls, [
    '/issues?state=all&per_page=100&page=1',
    '/issues?state=all&per_page=100&page=2',
    '/issues?state=all&per_page=100&page=3'
  ]);
  assert.equal(issues.some(item => item.number === 26 || item.number === 151), false);
});

test('focused single-Issue reconciliation does not fetch the full Issue collection', async () => {
  const calls = [];
  const client = {
    async rest(path) {
      calls.push(path);
      if (path === '/issues/174') return issue(174);
      throw new Error(`unexpected REST path: ${path}`);
    }
  };

  const issues = await listRepositoryIssues(client, 174);
  assert.deepEqual(issues.map(item => item.number), [174]);
  assert.deepEqual(calls, ['/issues/174']);
});

test('branch evidence paginates beyond 100 entries', async () => {
  const branches = Array.from({ length: 145 }, (_, index) => ({ name: `branch-${index + 1}` }));
  const calls = [];
  const result = await listRepositoryBranches(pagedClient({ '/branches': branches }, calls));

  assert.equal(result.length, 145);
  assert.equal(result.at(-1).name, 'branch-145');
  assert.deepEqual(calls, ['/branches?per_page=100&page=1', '/branches?per_page=100&page=2']);
});

test('later-page API failure rejects pagination instead of returning partial data', async () => {
  const client = {
    async rest(path) {
      const page = Number(new URL(`https://example.invalid${path}`).searchParams.get('page'));
      if (page === 1) return Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
      throw new Error('GitHub 502: upstream failure');
    }
  };

  await assert.rejects(() => paginateRest(client, '/issues?state=all'), /GitHub 502: upstream failure/);
});

test('pagination is bounded and fails visibly rather than assuming completeness', async () => {
  const client = { async rest() { return [{ id: 1 }]; } };
  await assert.rejects(() => paginateRest(client, '/branches', { perPage: 1, maxPages: 2 }), /exceeded 2 pages/);
});

test('dry-run reconciliation returns every collected Issue number without forcing branch enumeration', async () => {
  const issues = Array.from({ length: 105 }, (_, index) => issue(index + 1));
  const client = { owner: 'Blackline-Development-DevOps', async rest(path) { throw new Error(`unexpected REST path: ${path}`); } };
  const getBranches = async () => { throw new Error('branch enumeration should remain lazy for branchless Issues'); };
  const context = { id: 'PROJECT', fields: {} };
  const adapter = { project: { displayName: 'OneStep Money Development' }, areas: [] };

  const results = await syncIssues(client, context, adapter, issues, getBranches, true);
  assert.equal(results.length, 105);
  assert.deepEqual(results.map(result => result.issue), issues.map(item => item.number));
});
