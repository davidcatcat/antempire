/**
 * Viewer HTTP server robustness (Issue #43 F06). Before the fix a malformed percent-encoded URL made
 * decodeURIComponent throw inside the request callback and the whole process exited, so every later request failed.
 * Now: malformed URL -> 400, path escape -> 404, non-GET -> 405, missing file -> 404, and the server keeps serving 200.
 */
import assert from 'node:assert/strict';
import { startServer, resolvePath } from '../cli/web-serve.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
ok('status' in resolvePath('/%E0%A4%A') && (resolvePath('/%E0%A4%A') as { status: number }).status === 400, 'malformed percent-encoding is a 400, not an exception');
ok('status' in resolvePath('/../saves/main.json'), 'paths outside web/ are refused');
ok('file' in resolvePath('/index.html'), 'normal path resolves');

const s = startServer(0);
await new Promise<void>((r) => s.on('listening', () => r()));
const port = (s.address() as { port: number }).port, get = (p: string, method = 'GET') => fetch(`http://127.0.0.1:${port}${p}`, { method }).then((r) => r.status);
try {
  ok((await get('/')) === 200, 'index served');
  ok((await get('/%E0%A4%A')) === 400, 'malformed URL -> 400');
  ok((await get('/')) === 200, 'after a malformed request the server still serves 200');
  ok((await get('/%')) === 400 && (await get('/a%zz')) === 400, 'other malformed encodings -> 400');
  ok((await get('/%2e%2e/saves/main.json')) === 404, 'encoded path escape -> 404');
  ok((await get('/no-such-file.json')) === 404, 'missing file -> 404');
  ok((await get('/', 'POST')) === 405, 'POST -> 405');
  ok((await get('/data/index.json')) === 200, 'data still served after all error cases');
} finally { s.close(); }
console.log(`web-serve: ${checks} checks passed`);
