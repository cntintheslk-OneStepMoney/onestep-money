import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { createPreviewServer } from '../static-preview-server.js';

const root = new URL('../', import.meta.url);

test('browser demo markup declares its fictional, local and accessible boundaries', async () => {
  const html = await fs.readFile(new URL('demo/index.html', root), 'utf8');
  assert.match(html, /INTERACTIVE FICTIONAL DEMO/);
  assert.match(html, /No real documents can be uploaded/);
  assert.match(html, /session storage/i);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /<main[^>]+id="demoMain"/);
  assert.match(html, /<nav[^>]+aria-label="Demo navigation"/);
  assert.match(html, /role="img" aria-label="Money in and money out comparison"/);
  assert.doesNotMatch(html, /https?:\/\//);
});

test('browser runtime has no Electron bridge, telemetry or remote requests', async () => {
  const html = await fs.readFile(new URL('demo/index.html', root), 'utf8');
  const source = await fs.readFile(new URL('demo/demo-app.js', root), 'utf8');
  assert.doesNotMatch(source, /financeAPI|window\.financeAPI/);
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|WebSocket|sendBeacon/);
  assert.doesNotMatch(source, /analytics|telemetry/i);
  assert.match(source, /loadDemoState/);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'demo markup must not contain duplicate IDs');
  for (const [, id] of source.matchAll(/byId\('([^']+)'\)/g)) {
    assert.ok(ids.includes(id), `demo runtime references missing #${id}`);
  }
});

test('demo stylesheet includes narrow reflow and shared reduced-motion/theme handling', async () => {
  const css = await fs.readFile(new URL('demo/demo.css', root), 'utf8');
  assert.match(css, /@media \(max-width: 840px\)/);
  assert.match(css, /grid-template-columns: 1fr/);
  const shared = await fs.readFile(new URL('styles.css', root), 'utf8');
  assert.match(shared, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(shared, /:root\[data-theme="dark"\]/);
});

test('secure preview server serves the demo root and keeps desktop preview explicit', async (context) => {
  const server = createPreviewServer();
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  context.after(() => new Promise((resolve) => { server.close(resolve); }));
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;
  const demo = await fetch(`${base}/`);
  assert.equal(demo.status, 200);
  assert.match(await demo.text(), /Interactive Demo/);
  assert.match(demo.headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal(demo.headers.get('referrer-policy'), 'no-referrer');
  const module = await fetch(`${base}/demo/demo-state.js`);
  assert.equal(module.status, 200);
  assert.match(module.headers.get('content-type'), /text\/javascript/);
  const desktop = await fetch(`${base}/desktop-preview`);
  assert.equal(desktop.status, 200);
  assert.match(await desktop.text(), /desktopRequired/);
  assert.equal((await fetch(`${base}/private-file`)).status, 404);
});
