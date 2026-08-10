import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicFiles = new Map([
  ['/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/demo', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/demo/', ['demo/index.html', 'text/html; charset=utf-8']],
  ['/desktop-preview', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/demo/demo.css', ['demo/demo.css', 'text/css; charset=utf-8']],
  ['/demo/demo-app.js', ['demo/demo-app.js', 'text/javascript; charset=utf-8']],
  ['/demo/demo-data.js', ['demo/demo-data.js', 'text/javascript; charset=utf-8']],
  ['/demo/demo-state.js', ['demo/demo-state.js', 'text/javascript; charset=utf-8']],
  ['/renderer-app.js', ['renderer-app.js', 'text/javascript; charset=utf-8']],
  ['/finance-core.js', ['finance-core.js', 'text/javascript; charset=utf-8']],
  ['/financial-reporting.js', ['financial-reporting.js', 'text/javascript; charset=utf-8']],
  ['/date-utils.js', ['date-utils.js', 'text/javascript; charset=utf-8']],
  ['/next-move-priority.js', ['next-move-priority.js', 'text/javascript; charset=utf-8']],
  ['/presentation-settings.js', ['presentation-settings.js', 'text/javascript; charset=utf-8']],
  ['/review-lifecycle.js', ['review-lifecycle.js', 'text/javascript; charset=utf-8']],
  ['/statement-intelligence.js', ['statement-intelligence.js', 'text/javascript; charset=utf-8']],
  ['/assets/onestep-money-icon.png', ['assets/onestep-money-icon.png', 'image/png']],
  ['/assets/onestep-money-wordmark.png', ['assets/onestep-money-wordmark.png', 'image/png']]
]);

export function createPreviewServer() {
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    const asset = publicFiles.get(pathname);
    const headers = {
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; object-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    };
    if (!asset) {
      response.writeHead(404, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    try {
      const contents = await fs.readFile(path.join(root, asset[0]));
      response.writeHead(200, { ...headers, 'Content-Type': asset[1] });
      response.end(contents);
    } catch {
      response.writeHead(500, { ...headers, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Asset unavailable');
    }
  });
}

export function startPreviewServer(port = Number(process.env.PORT || 3000)) {
  const server = createPreviewServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`Interactive demo: http://127.0.0.1:${port}`);
  });
  return server;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) startPreviewServer();
