/**
 * Minimal static server for the read-only viewer (web/). Serves files only; accepts GET/HEAD; never writes.
 *   node cli/web-serve.ts [port]   (default 8780) -> http://localhost:8780/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/load.ts';

const ROOT = path.join(REPO_ROOT, 'web'), TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
export function startServer(port = 8780): http.Server {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]), file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
    if (!file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  }).listen(port);
}
if (import.meta.main) { const port = Number(process.argv[2] ?? 8780); startServer(port); console.log(`螞蟻帝國 觀察器：http://localhost:${port}/`); }
