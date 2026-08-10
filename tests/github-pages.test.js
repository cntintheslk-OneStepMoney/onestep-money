import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildPagesSite, PAGE_FILES } from '../scripts/build-pages-site.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Pages build contains only the explicit public demo allowlist', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-pages-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'site');
  await buildPagesSite({ root, output });

  const expected = ['.nojekyll', ...PAGE_FILES.map(([, publicPath]) => publicPath)].sort();
  assert.deepEqual(await listFiles(output), expected);
  assert.ok(!expected.some((file) => /(?:main-process|preload|data-store|document-import|test|\.map$)/.test(file)));
});

test('Pages entry point uses project-relative resources that resolve in the artifact', async (context) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'onestep-pages-paths-'));
  context.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'site');
  await buildPagesSite({ root, output });
  const html = await fs.readFile(path.join(output, 'index.html'), 'utf8');

  assert.doesNotMatch(html, /(?:href|src)="\//);
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/demo\/demo-app\.js"/);
  assert.match(html, /connect-src 'none'/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('Pages workflow deploys the allowlisted artifact from main and supports manual runs', async () => {
  const workflow = (await fs.readFile(path.join(root, '.github/workflows/deploy-demo-pages.yml'), 'utf8')).replaceAll('\r\n', '\n');
  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /permissions:\n  contents: read\n  pages: write\n  id-token: write/);
  assert.match(workflow, /npm run build:pages/);
  assert.match(workflow, /actions\/upload-pages-artifact@v3/);
  assert.match(workflow, /path: dist\/pages/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});

async function listFiles(directory, prefix = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), relative));
    else files.push(relative);
  }
  return files.sort();
}
