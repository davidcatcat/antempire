/**
 * Minimal static server for the read-only viewer (web/). Serves files only; accepts GET/HEAD; never writes.
 * Malformed URLs get HTTP 400 and do not stop the server (Issue #43 F06); stat/stream errors affect only that request.
 *   node cli/web-serve.ts [port]   (default 8780) -> http://localhost:8780/
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/load.ts';

const ROOT = path.join(REPO_ROOT, 'web'), TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
/** Resolve a request path to a file under web/, or null. Malformed percent-encoding is a client error (F06). */
export function resolvePath(rawUrl: string | undefined): { file: string } | { status: 400 | 404 } {
  let url: string;
  try { url = decodeURIComponent((rawUrl ?? '/').split('?')[0]); } catch { return { status: 400 }; }
  if (url.includes('\0')) return { status: 400 };
  const file = path.normalize(path.join(ROOT, url === '/' ? 'index.html' : url));
  if (!file.startsWith(ROOT + path.sep)) return { status: 404 };
  return { file };
}

export function startServer(port = 8780): http.Server {
  return http.createServer((req, res) => {
    const fail = (code: number, msg: string) => { if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' }); res.end(msg); };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { fail(405, 'method not allowed'); return; }
      const r = resolvePath(req.url);
      if ('status' in r) { fail(r.status, r.status === 400 ? 'bad request' : 'not found'); return; }
      fs.stat(r.file, (err, st) => {
        if (err || !st.isFile()) { fail(404, 'not found'); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(r.file)] ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-length': String(st.size) });
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(r.file);
        stream.on('error', () => res.destroy()); // file vanished or unreadable after stat: drop this response only
        stream.pipe(res);
      });
    } catch { fail(500, 'internal error'); } // a single bad request never stops the server
  }).listen(port);
}
if (import.meta.main) { const port = Number(process.argv[2] ?? 8780); startServer(port); console.log(`螞蟻帝國 觀察器：http://localhost:${port}/`); }
