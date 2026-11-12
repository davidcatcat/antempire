/**
 * Issue #159 / Owner decision 24: re-measure the OFFICIAL game view (web/index.html, layered renderer since PR C)
 * as shipped (adaptive quality on, no option changed). Needs `npm run web:build` first; serves web/ via cli/web-serve.ts.
 *   node prototypes/render-compare/game-bench.cjs [secs=10] [longSecs=60]
 * Per profile (desktop 1280×800, Pixel 7, Pixel 7 + 4× CPU throttle): fps mean, p50 / p95 / p99 frame interval,
 * renderer / GPU process CPU per frame (CDP SystemInfo), JS heap, quality level, canvas size; then a long run in
 * 10 s windows. Targets (not lowered): desktop ≥ 55, Pixel 7 ≥ 50, 4× ≥ 30. Writes game-results.json. Exit 1 only on
 * page errors (targets are reported, not enforced here).
 */
const os = require('node:os'), { spawn } = require('node:child_process'), fs = require('node:fs'), path = require('node:path');
const { chromium, devices } = require('playwright');
const REPO = path.resolve(__dirname, '../..'), SECS = Number(process.argv[2] || 10), LONG = Number(process.argv[3] || 60), PORT = 8800 + (process.pid % 100);
const TARGET = { desktop: 55, pixel7: 50, 'pixel7-cpu4x': 30 };
const PROFILES = [['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, 1], ['pixel7', { ...devices['Pixel 7'] }, 1], ['pixel7-cpu4x', { ...devices['Pixel 7'] }, 4]];
const srv = spawn(process.execPath, [path.join(REPO, 'cli/web-serve.ts'), String(PORT)], { stdio: 'ignore' });
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
(async () => {
  await new Promise((r) => setTimeout(r, 1500));
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] }), bcdp = await browser.newBrowserCDPSession(), rows = [], failures = [];
  const cpu = async () => { const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo'); const o = {}; for (const p of processInfo) o[p.type] = (o[p.type] || 0) + p.cpuTime; return o; };
  for (const [tag, opt, throttle] of PROFILES) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
    // per-frame intervals collected in the page from rAF (the game's own __game.fps() gives mean / p50 / p95 only)
    await page.addInitScript(() => { window.__iv = []; let last = 0; const f = (t) => { if (last) window.__iv.push(t - last); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f); });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__game && window.__game.ants().length > 0, null, { timeout: 60000 });
    await page.waitForTimeout(6000);
    const window1 = async (secs) => {
      await page.evaluate(() => { window.__game.resetFps(); window.__iv = []; }); const c0 = await cpu(), fr0 = await page.evaluate(() => window.__game.fps().frames);
      await page.waitForTimeout(secs * 1000);
      const iv = await page.evaluate(() => window.__iv), g = await page.evaluate(() => window.__game.fps()), st = await page.evaluate(() => window.__game.state()), c1 = await cpu(), heap = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
      const nf = Math.max(1, g.frames - fr0), mean = iv.reduce((s, x) => s + x, 0) / iv.length;
      return { fps_mean: 1000 / mean, p50_ms: q(iv, 0.5), p95_ms: q(iv, 0.95), p99_ms: q(iv, 0.99), max_ms: Math.max(...iv), game_fps_mean: g.fps_mean, renderer_proc_ms_per_frame: ((c1.renderer || 0) - (c0.renderer || 0)) * 1000 / nf, gpu_proc_ms_per_frame: ((c1.GPU || 0) - (c0.GPU || 0)) * 1000 / nf, heap_mb: heap / 1048576, host_load1: +os.loadavg()[0].toFixed(2), quality: st.quality, canvas_px: st.canvas_px, ants_drawn: (await page.evaluate(() => window.__game.ants().filter((a) => a.sx !== null).length)) };
    };
    const main = await window1(SECS), longW = [];
    for (let i = 0; i < Math.ceil(LONG / 10); i++) longW.push(await window1(10));
    const row = { profile: tag, cpu_throttle: throttle, target_fps: TARGET[tag], ...main, meets_target: main.fps_mean >= TARGET[tag], long_run: { secs: longW.length * 10, fps: longW.map((w) => +w.fps_mean.toFixed(1)), p95: longW.map((w) => +w.p95_ms.toFixed(1)), heap_mb: longW.map((w) => +w.heap_mb.toFixed(1)), quality: longW.map((w) => w.quality) } };
    rows.push(row); if (errors.length) failures.push(`${tag}: ${errors.join(' | ')}`);
    console.log(`${tag.padEnd(13)} fps ${main.fps_mean.toFixed(1)} (target ${TARGET[tag]}) p95 ${main.p95_ms.toFixed(1)} p99 ${main.p99_ms.toFixed(1)} heap ${main.heap_mb.toFixed(1)} MB q${main.quality} canvas ${main.canvas_px} ants ${main.ants_drawn} | long ${row.long_run.fps.join(' ')}`);
    await ctx.close();
  }
  await browser.close(); srv.kill();
  const meta = { measured: `official game view (web/index.html) as shipped, headless Chromium via Playwright, ${SECS} s after 6 s warm-up, then ${LONG} s in 10 s windows; not a real device`, chromium: browser.version(), node: process.version, date: new Date().toISOString().slice(0, 10) };
  fs.writeFileSync(path.join(__dirname, 'game-results.json'), JSON.stringify({ meta, rows, failures }, null, 1) + '\n');
  if (failures.length) { console.error('FAILURES\n' + failures.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); srv.kill(); process.exit(1); });
