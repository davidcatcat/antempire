// Issue #102 step 1 — runs dist/index.html in Playwright Chromium for each renderer x N x profile and records
// requestAnimationFrame frame intervals. Measures DRAWING SPRITES, not ants and not simulation throughput.
// Usage: node build.mjs && node bench.cjs [--seconds 5] [--warmup 1]
const { chromium, devices } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SECONDS = arg('--seconds', 5), WARMUP = arg('--warmup', 1);
const PAGE = 'file://' + path.join(__dirname, 'dist', 'index.html');
const RENDERERS = ['canvas', 'pixi'], NS = [100, 1000, 10000];
const PROFILES = [
  { name: 'desktop', context: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 } },
  { name: 'phone (Pixel 7 emulation)', context: { ...devices['Pixel 7'] } },
];

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const pkgVersion = (name, dir = path.join(__dirname, 'node_modules', name)) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
const isSoftwareGL = (s) => !s || /swiftshader|llvmpipe|software|softpipe|basic render/i.test(s);

(async () => {
  if (!fs.existsSync(path.join(__dirname, 'dist', 'index.html'))) throw new Error('run `node build.mjs` first');
  // --enable-precise-memory-info: performance.memory otherwise reports bucketed values
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] });
  const results = [];
  for (const prof of PROFILES) {
    for (const renderer of RENDERERS) {
      for (const n of NS) {
        const ctx = await browser.newContext(prof.context);
        const page = await ctx.newPage();
        await page.goto(`${PAGE}?renderer=${renderer}&n=${n}`);
        await page.waitForFunction(() => window.__bench && (window.__bench.ready || window.__bench.error), null, { timeout: 30000 });
        const err = await page.evaluate(() => window.__bench.error);
        let row;
        if (err) row = { profile: prof.name, renderer, n, error: err };
        else {
          await page.waitForTimeout(WARMUP * 1000);
          const heapBefore = await page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null));
          await page.evaluate(() => { window.__bench.frames = []; window.__bench.cpu = []; window.__bench.rec = true; });
          await page.waitForTimeout(SECONDS * 1000);
          const d = await page.evaluate(() => {
            window.__bench.rec = false; const b = window.__bench;
            return { frames: b.frames, cpu: b.cpu, gl: b.gl, pixi: b.pixiRenderer, heap: performance.memory ? performance.memory.usedJSHeapSize : null, dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight };
          });
          const dts = []; for (let i = 1; i < d.frames.length; i++) dts.push(d.frames[i] - d.frames[i - 1]);
          const sorted = [...dts].sort((a, b) => a - b), span = d.frames.length > 1 ? d.frames[d.frames.length - 1] - d.frames[0] : 0;
          const cpuSorted = [...d.cpu].sort((a, b) => a - b);
          const glString = (d.pixi && d.pixi.gl) || (d.gl && d.gl.renderer) || null;
          row = {
            profile: prof.name, renderer, n, viewport: `${d.vw}x${d.vh}`, dpr: d.dpr, frames: dts.length,
            meanFps: span ? r2((dts.length / span) * 1000) : null,
            p50Ms: r2(pct(sorted, 50)), p95Ms: r2(pct(sorted, 95)), p99Ms: r2(pct(sorted, 99)), maxMs: r2(sorted[sorted.length - 1]),
            cpuP50Ms: r2(pct(cpuSorted, 50)), cpuP95Ms: r2(pct(cpuSorted, 95)),
            jsHeapMB: d.heap == null ? null : r2(d.heap / 1048576), jsHeapBeforeMB: heapBefore == null ? null : r2(heapBefore / 1048576),
            webglAvailable: !!(d.gl && d.gl.available), glRenderer: glString, softwareGL: isSoftwareGL(glString),
            pixiRenderer: d.pixi ? d.pixi.name : null,
          };
        }
        results.push(row);
        console.error(`done ${prof.name} ${renderer} N=${n}`);
        await ctx.close();
      }
    }
  }
  const meta = {
    issue: 102, what: 'drawing sprites (not ants, not simulation data, not simulation throughput)',
    headless: true, chromium: browser.version(), playwright: pkgVersion('playwright', path.dirname(require.resolve('playwright'))),
    pixi: pkgVersion('pixi.js'), esbuild: pkgVersion('esbuild'), node: process.version,
    warmupSeconds: WARMUP, recordSeconds: SECONDS, platform: `${process.platform} ${process.arch}`,
    note: 'Frame interval = delta of requestAnimationFrame timestamps; headless Chromium caps rAF near 60 Hz, so ~16.7 ms is the floor. cpu* = JS time inside one frame callback (update + draw calls / render submit), not GPU time.',
  };
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ meta, results }, null, 2) + '\n');
  const gl = results.find((r) => r.glRenderer);
  console.log(`\nGL renderer: ${gl ? gl.glRenderer : 'none'}${gl && gl.softwareGL ? '  <-- SOFTWARE GL (SwiftShader): numbers are only relative, NOT device GPU performance' : ''}`);
  console.log(`Chromium ${meta.chromium} headless · PixiJS ${meta.pixi} · ${SECONDS}s after ${WARMUP}s warm-up\n`);
  const cols = ['profile', 'renderer', 'n', 'meanFps', 'p50Ms', 'p95Ms', 'p99Ms', 'maxMs', 'cpuP50Ms', 'cpuP95Ms', 'jsHeapMB'];
  console.log('| ' + cols.join(' | ') + ' |'); console.log('|' + cols.map(() => '---').join('|') + '|');
  for (const r of results) console.log('| ' + cols.map((c) => (r.error && c === 'meanFps' ? 'ERROR' : r[c] ?? '—')).join(' | ') + ' |');
})().catch((e) => { console.error(e); process.exit(1); });
