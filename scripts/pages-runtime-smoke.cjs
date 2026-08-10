const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { app, BrowserWindow } = require('electron');

app.disableHardwareAcceleration();

const publicUrl = String(process.env.PAGES_SMOKE_URL || '').trim();
let server;
let browserWindow;
let exitCode = 0;

app.whenReady()
  .then(runSmoke)
  .catch((error) => {
    console.error(`Pages runtime smoke failed: ${error.message}`);
    exitCode = 1;
  })
  .finally(async () => {
    if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
    await closeServer();
    app.exit(exitCode);
  });

async function runSmoke() {
  const targetUrl = publicUrl || await startBuiltPagesServer();
  const runtimeErrors = [];
  browserWindow = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  browserWindow.webContents.on('console-message', (details) => {
    const message = String(details?.message || 'Browser console error');
    const ignoredMetaPolicyWarning = message.includes("The Content Security Policy directive 'frame-ancestors' is ignored");
    if (details?.level === 'error' && !ignoredMetaPolicyWarning) runtimeErrors.push(message);
  });
  browserWindow.webContents.on('render-process-gone', (_event, details) => {
    runtimeErrors.push(`Renderer stopped: ${details.reason}`);
  });

  await browserWindow.loadURL(targetUrl);
  await new Promise((resolve) => { setTimeout(resolve, 100); });
  if (runtimeErrors.length) throw new Error(`Pages runtime emitted ${runtimeErrors.length} browser error(s): ${runtimeErrors[0]}`);
  const result = await browserWindow.webContents.executeJavaScript(`
    (async () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 50));
      const requireNode = (selector, label) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error('Missing ' + label);
        return node;
      };
      const click = async (selector, label) => {
        requireNode(selector, label).click();
        await wait();
      };
      const expect = (condition, message) => {
        if (!condition) throw new Error(message);
      };

      expect(Boolean(document.querySelector('.demo-badge')), 'Expected the allowlisted Browser Demo artifact.');
      expect(document.documentElement.dataset.demoStartup === 'ready', 'Demo did not report successful startup.');
      expect(requireNode('#demoStartupError', 'startup failure panel').hidden, 'Startup failure panel remained visible.');
      const welcome = requireNode('#demoWelcome', 'welcome dialog');
      expect(welcome.open, 'Welcome dialog did not open.');
      expect(welcome.matches(':modal'), 'Welcome dialog is not modal.');

      await click('#enterDemoButton', 'Explore the demo button');
      expect(!welcome.open, 'Welcome dialog did not close.');

      await click('[data-view="today"]', 'Today navigation');
      expect(document.querySelector('#view-today:not([hidden])'), 'Today view did not open.');
      expect(requireNode('#viewTitle', 'view title').textContent === 'Today', 'Today title did not update.');

      await click('[data-view="payments"]', 'Payments navigation');
      expect(document.querySelector('#view-payments:not([hidden])'), 'Payments view did not open.');

      await click('#showImportButton', 'fictional import button');
      const importDialog = requireNode('#importPreviewDialog', 'fictional import dialog');
      expect(importDialog.open && importDialog.matches(':modal'), 'Fictional import dialog did not open modally.');
      await click('#cancelImportButton', 'close fictional import button');
      expect(!importDialog.open, 'Fictional import dialog did not close.');

      const previousTheme = document.documentElement.dataset.theme;
      await click('#quickThemeButton', 'quick theme button');
      expect(document.documentElement.dataset.theme !== previousTheme, 'Theme control did not change presentation.');

      await click('#resetDemoButton', 'reset demo button');
      expect(document.querySelector('#view-dashboard:not([hidden])'), 'Reset did not return to Dashboard.');
      expect(requireNode('#viewTitle', 'view title').textContent === 'Dashboard', 'Dashboard title was not restored.');

      return { ready: true };
    })()
  `, true);

  if (!result?.ready) throw new Error('Pages runtime smoke did not complete.');
  if (runtimeErrors.length) throw new Error(`Pages runtime emitted ${runtimeErrors.length} browser error(s): ${runtimeErrors[0]}`);
  console.log(publicUrl ? 'Public Pages runtime smoke passed.' : 'Built Pages artifact runtime smoke passed.');
}

async function startBuiltPagesServer() {
  const { buildPagesSite } = await import('./build-pages-site.mjs');
  const { output } = await buildPagesSite();
  server = http.createServer(async (request, response) => {
    try {
      const requestPath = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
      const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '');
      const filePath = path.resolve(output, relativePath);
      const relative = path.relative(output, filePath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid path');
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        'Content-Type': contentType(filePath),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Pages smoke server did not start.');
  return `http://127.0.0.1:${address.port}/`;
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}

async function closeServer() {
  if (!server) return;
  await new Promise((resolve) => { server.close(resolve); });
}
