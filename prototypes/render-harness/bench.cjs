/**
 * Render harness bench (PR B). Serves the repo read-only (only prototypes/render-harness/ and web/data/), opens the
 * harness in Chromium and measures frame intervals per profile × mode. Writes results.json and screenshots.
 *   npx tsc -p prototypes/render-harness/tsconfig.json && node prototypes/render-harness/bench.cjs [seconds]
 * FAILS (exit 1) on page errors, input mutation, position mismatch or a wrong layer order.
 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium, devices } = require('playwright');
const REPO = path.resolve(__dirname, '../..'), OUT = path.join(__dirname, 'screenshots'), SECS = Number(process.argv[2] || 6);
const ALLOWED = ['/prototypes/render-harness/', '/web/data/'], TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const LAYERS = ['ground', 'decals', 'shadows', 'propsLow', 'routes', 'antShadows', 'ants', 'propsHigh', 'lighting', 'weather', 'ui'];
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]), f = path.normalize(path.join(REPO, u));
  if (!ALLOWED.some((a) => u.startsWith(a)) || !f.startsWith(REPO) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/prototypes/render-harness/index.html`, failures = [], rows = [], seams = [];
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, 1], ['pixel7', { ...devices['Pixel 7'] }, 1], ['pixel7-cpu4x', { ...devices['Pixel 7'] }, 4]];
  const modes = [['replay', '?mode=replay'], ['stress100', '?mode=stress&n=100'], ['stress1000', '?mode=stress&n=1000']];
  for (const [tag, opt, throttle] of profiles) for (const [m, q] of modes) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (x) => { if (x.type() === 'error') errors.push(x.text()); });
    if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
    await page.goto(base + q); await page.waitForFunction(() => window.__harness && window.__harness.ready(), null, { timeout: 60000 });
    await page.waitForTimeout(6000); await page.evaluate(() => window.__harness.reset()); await page.waitForTimeout(SECS * 1000);
    const fps = await page.evaluate(() => window.__harness.fps()), info = await page.evaluate(() => window.__harness.info());
    rows.push({ profile: tag, mode: m, cpu_throttle: throttle, canvas_px: info.canvas, quality_level: info.quality.level, ...fps, chunk_bakes: info.stats.bakes });
    if (errors.length) failures.push(`${tag}/${m}: ${errors.join(' | ')}`);
    if (JSON.stringify(info.trace) !== JSON.stringify(LAYERS)) failures.push(`${tag}/${m}: layer order ${info.trace}`);
    if (m === 'replay') {
      if (info.checks.mutationCount) failures.push(`${tag}: renderer mutated input frames ${info.checks.mutation}`);
      if (info.checks.positionErrors) failures.push(`${tag}: drawn position != affine(poseAt) ${info.checks.position}`);
      if (!(info.checks.positionsChecked > 0)) failures.push(`${tag}: no drawn ant positions were checked`);
      rows[rows.length - 1].positions_checked = info.checks.positionsChecked; rows[rows.length - 1].frames_checked = info.checks.framesChecked;
      if (!info.engineObjects.every((o) => o.source === 'engine')) failures.push(`${tag}: registry has non-engine objects`);
    }
    if (throttle === 1 && m !== 'stress1000') await page.screenshot({ path: path.join(OUT, `${tag}-${m}.png`) });
    if (throttle === 1 && m === 'replay') {
      // extra views: 全景 and the engine-object overlay; then the seam / periodicity check on the ground alone
      for (const [suffix, extra] of [['full', '&view=full'], ['overlay', '&highlight&labels&routes']]) { await page.goto(base + q + extra); await page.waitForFunction(() => window.__harness.ready()); await page.waitForTimeout(1500); await page.screenshot({ path: path.join(OUT, `${tag}-replay-${suffix}.png`) }); }
      for (const [view, extra] of [['default', ''], ['full', '&view=full']]) {
        await page.goto(base + q + '&groundonly' + extra); await page.waitForFunction(() => window.__harness.ready()); await page.waitForTimeout(1500);
        const sc = await page.evaluate(() => window.__harness.seamCheck()); seams.push({ profile: tag, view, max_seam_ratio: sc.max_seam_ratio, ordinary_column_p99_ratio: sc.ordinary_column_p99_ratio, periodic_amp: sc.periodic_amp, seams: sc.seams_x.length + sc.seams_y.length });
        if (!(sc.seams_x.length + sc.seams_y.length > 0)) failures.push(`${tag}/${view}: no chunk boundary in view to check`);
        if (sc.max_seam_ratio > 1.6 || sc.max_seam_ratio > sc.ordinary_column_p99_ratio + 0.2) failures.push(`${tag}/${view}: luminance step at a chunk boundary ${sc.max_seam_ratio.toFixed(2)} vs ordinary p99 ${sc.ordinary_column_p99_ratio.toFixed(2)}`);
        if (sc.periodic_amp > 0.04) failures.push(`${tag}/${view}: visible periodic repetition (relative amplitude ${sc.periodic_amp.toFixed(4)})`);
      }
    }
    if (tag === 'desktop' && m === 'stress1000') await page.screenshot({ path: path.join(OUT, 'desktop-stress1000.png') });
    await ctx.close();
  }
  await browser.close(); server.close();
  const meta = { measured: 'headless Chromium via Playwright; frame intervals over ' + SECS + ' s after 6 s warm-up; not a real device', node: process.version };
  fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ meta, rows, seams }, null, 1) + '\n');
  for (const x of seams) console.log(`seam ${x.profile} ${x.view}: boundary ${x.max_seam_ratio.toFixed(2)} vs ordinary p99 ${x.ordinary_column_p99_ratio.toFixed(2)}, periodic amp ${x.periodic_amp.toFixed(4)}`);
  for (const r of rows) console.log(`${r.profile.padEnd(13)} ${r.mode.padEnd(11)} fps ${r.fps_mean?.toFixed(1).padStart(5)} p50 ${r.p50_ms?.toFixed(1)} p95 ${r.p95_ms?.toFixed(1)} q${r.quality_level} canvas ${r.canvas_px}`);
  if (failures.length) { console.error('FAILURES\n' + failures.join('\n')); process.exit(1); }
});
