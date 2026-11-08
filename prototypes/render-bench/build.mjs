// Builds the standalone benchmark page into dist/ (index.html + bench.js as one IIFE bundle, so file:// works).
import { build } from 'esbuild';
import { mkdirSync, copyFileSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
mkdirSync(here + 'dist', { recursive: true });
await build({
  entryPoints: [here + 'src/main.js'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  outfile: here + 'dist/bench.js',
  logLevel: 'warning',
});
copyFileSync(here + 'src/index.html', here + 'dist/index.html');
console.log('built dist/index.html + dist/bench.js');
