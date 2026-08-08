import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/renderer-app.js', ['renderer-app.js', 'text/javascript; charset=utf-8']],
  ['/finance-core.js', ['finance-core.js', 'text/javascript; charset=utf-8']],
  ['/assets/onestep-money-icon.png', ['assets/onestep-money-icon.png', 'image/png']]
]);

http.createServer(async (request, response) => {
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
}).listen(port, '127.0.0.1', () => {
  console.log(`Static preview: http://127.0.0.1:${port}`);
});
