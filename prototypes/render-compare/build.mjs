// Bundles the comparison page (src/compare.ts + the web/src modules it imports + pinned pixi.js) into dist/compare.js.
// Local bundle only: no CDN at runtime.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
mkdirSync(here + 'dist', { recursive: true });
await build({ entryPoints: [here + 'src/compare.ts'], bundle: true, format: 'iife', target: 'es2022', minify: true, outfile: here + 'dist/compare.js', logLevel: 'warning' });
console.log('built dist/compare.js');
