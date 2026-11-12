// Bundles the comparison page (src/compare.ts + the web/src modules it imports + pinned pixi.js) into dist/compare.js,
// and the device bench (src/device-bench.ts) into dist/device-bench/: index.html (full document, for static hosting),
// fragment.html (the same page without the document wrapper, for hosts that add it), device-bench.js, data/ (the
// web/data index and the first experiment the game view opens, read only). Local bundle only: no CDN at runtime.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname, repo = new URL('../../', import.meta.url).pathname;
mkdirSync(here + 'dist', { recursive: true });
await build({ entryPoints: [here + 'src/compare.ts'], bundle: true, format: 'iife', target: 'es2022', minify: true, outfile: here + 'dist/compare.js', logLevel: 'warning' });
const out = here + 'dist/device-bench/';
mkdirSync(out + 'data', { recursive: true });
await build({ entryPoints: [here + 'src/device-bench.ts'], bundle: true, format: 'esm', target: 'es2022', minify: true, outfile: out + 'device-bench.js', logLevel: 'warning', legalComments: 'none' });
const fragment = readFileSync(here + 'device-bench.html', 'utf8');
writeFileSync(out + 'fragment.html', fragment);
writeFileSync(out + 'index.html', `<!doctype html>\n<html lang="zh-Hant">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<style>html,body{margin:0}[hidden]{display:none!important}</style>\n</head>\n<body>\n${fragment}</body>\n</html>\n`);
const index = JSON.parse(readFileSync(repo + 'web/data/index.json', 'utf8')), first = index.experiments[0];
writeFileSync(out + 'data/index.json', JSON.stringify({ ...index, experiments: [first] }));
copyFileSync(repo + 'web/data/' + first.file, out + 'data/' + first.file);
console.log('built dist/compare.js and dist/device-bench/');
