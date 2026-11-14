/**
 * Three.js 3D prototype benchmark runner (#257) — NOT a check and NOT a device result when run headless.
 * Runs, in ONE Chromium, the page's own benchmark (three.html: 30 / 100 / 1,000 ants = 1 / 4 / 34 independent P0-A2
 * experiment worlds, each in its own Worker) and, for comparison in the same environment, the existing Canvas 2D
 * experiment page (experiment.html?seed=1&world=p0a2). Also records the start-up time of the extra Workers and the
 * resident memory of the whole browser process tree (Linux `ps`; a proxy, not a per-Worker figure).
 *   npm run web:build && node cli/web-serve.ts 8783 &
 *   node tests/browser/three-bench.run.cjs <out.json> http://localhost:8783/ [warm_s=4] [measure_s=10] [sizes=30,100,1000]
 * WARNING (2026-11-14, headless): the 1,000 case starts 34 Workers that each post a ~4.9 KB state frame every 16 ms;
 * when the main thread is starved (SwiftShader, < 1 fps) the queue grows ~10 MB/s and the renderer was killed at
 * ~10 GB. Pass sizes=30,100 on small machines (docs/three-prototype.md §5).
 * Headless Chromium renders WebGL with SwiftShader (CPU): every number it produces is labelled "NOT a device result"
 * (measurement_class from the page). Real-device numbers come only from three.html?bench=1 opened on the device.
 */
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const MARK = `--antempire-bench-${process.pid}`;
/** resident memory (MB) of the browser process started with MARK and all its descendants (Linux only; else null) */
function treeRssMb() {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).trim().split('\n').map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }; }).filter(Boolean);
    const root = rows.find((r) => r.args.includes(MARK)); if (!root) return null;
    const keep = new Set([root.pid]); let grew = true;
    while (grew) { grew = false; for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; } }
    return { mb: Math.round(rows.filter((r) => keep.has(r.pid)).reduce((s, r) => s + r.rss, 0) / 1024), processes: keep.size };
  } catch { return null; }
}

(async () => {
  const out = process.argv[2] || 'three-bench.json', base = process.argv[3] || 'http://localhost:8783/', warm = Number(process.argv[4] ?? 4), secs = Number(process.argv[5] ?? 10), sizes = (process.argv[6] ?? '30,100,1000').split(',').map(Number);
  const browser = await chromium.launch({ args: [MARK] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), errors = [];
  const result = { schema: 'antempire.three-bench-run.v1', when_utc: new Date().toISOString(), measurement_class: null, note: 'Headless Chromium + SwiftShader software WebGL on a shared host: NOT a device result. Use only to compare within this run.', host: { cpus: require('node:os').cpus().length, loadavg: require('node:os').loadavg().map((x) => +x.toFixed(2)), mem_gb: +(require('node:os').totalmem() / 2 ** 30).toFixed(1) }, three: null, canvas2d: null, workers: [], errors };

  // 1. three.html: the page's own benchmark, one size at a time, with Worker start-up time and process memory
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`three: ${e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`three: ${m.text()}`); });
  await page.goto(new URL('three.html?seed=1', base).href);
  await page.waitForFunction(() => window.__three && window.__three.ready, null, { timeout: 120000 });
  const rows = [];
  for (const n of sizes) {
    const before = treeRssMb();
    const st = await page.evaluate(async (n) => { const T = window.__three, t0 = performance.now(); await T.setCount(n); while (T.state().ants < n) await new Promise((r) => setTimeout(r, 50)); return { ms: Math.round(performance.now() - t0), worlds: T.state().worlds }; }, n);
    const r = await page.evaluate(([n, w, s]) => window.__three.runBench([n], w, s), [n, warm, secs]);
    const after = treeRssMb();
    result.measurement_class = r.measurement_class; result.three = { ...r, rows: undefined };
    rows.push(r.rows[0]); result.workers.push({ ants: n, worlds: st.worlds, startup_ms: st.ms, browser_rss_mb_before: before && before.mb, browser_rss_mb_after: after && after.mb, browser_processes: after && after.processes });
    process.stderr.write(`three ${n}: ${r.rows[0].summary.fps_mean} fps, start-up ${st.ms} ms, rss ${after && after.mb} MB\n`);
  }
  result.three.rows = rows;
  await page.close();

  // 2. Canvas 2D experiment page, same browser, same viewport
  const p2 = await ctx.newPage();
  p2.on('pageerror', (e) => errors.push(`canvas: ${e}`)); p2.on('console', (m) => { if (m.type() === 'error') errors.push(`canvas: ${m.text()}`); });
  await p2.goto(new URL('experiment.html?seed=1&world=p0a2', base).href);
  await p2.waitForFunction(() => window.__v62 && window.__v62.frame() && window.__v62.pacing() && window.__v62.pacing().running, null, { timeout: 120000 });
  await p2.waitForTimeout(warm * 1000);
  await p2.evaluate(() => window.__v62.resetFps()); await p2.waitForTimeout(secs * 1000);
  const c = await p2.evaluate(() => ({ fps: window.__v62.fps(), draw: window.__v62.drawCost(), heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, workers: window.__v62.frame().workers.length }));
  result.canvas2d = { page: 'web/experiment.html?seed=1&world=p0a2', ants: c.workers, fps_mean: c.fps.fps_mean && +c.fps.fps_mean.toFixed(2), frame_ms_p50: c.fps.p50_ms && +c.fps.p50_ms.toFixed(2), frame_ms_p95: c.fps.p95_ms && +c.fps.p95_ms.toFixed(2), main_thread_draw_ms_p50: c.draw.p50_ms, main_thread_draw_ms_p95: c.draw.p95_ms, js_heap_mb: c.heap, browser_rss_mb: (treeRssMb() || {}).mb ?? null, measurement_class: 'NOT a device result' };
  process.stderr.write(`canvas2d: ${result.canvas2d.fps_mean} fps\n`);
  await browser.close();
  fs.writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
  console.log(JSON.stringify({ out, measurement_class: result.measurement_class, three: rows.map((r) => [r.ants, r.summary.fps_mean]), canvas2d: result.canvas2d.fps_mean, errors: errors.length }));
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
