/**
 * Issue #159 comparison bench: A (Canvas 2D) / B (Canvas 2D + pre-rotated atlas) / C (PixiJS WebGL ants) on the same
 * scene, animation and camera. Serves the repo read only (prototypes/render-compare/ and web/data/ only).
 *   cd prototypes/render-compare && npm ci && node build.mjs && node bench.cjs [secs=8] [longSecs=60] [quick]
 * Per profile × mode × renderer: frame interval mean / p50 / p95 / p99, CPU ms per frame (performance.now around the
 * whole frame and around the two ant layers), renderer- and GPU-process CPU time per frame (CDP SystemInfo; with
 * SwiftShader the GPU process IS the emulated GPU), JS heap, estimated ant-texture and ground-chunk bytes.
 * Correctness: drawn anchors = planned screen positions (and = affine(poseAt) in the replay); headings within the
 * bucket tolerance; identical input hash across A / B / C (rendering does not feed back); pixel probe (centroid and
 * body axis of every isolated sprite, B and C vs A). Long runs: 60 s in 10 s windows. Exit 1 on any failed check.
 */
const os = require('node:os'), http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium, devices } = require('playwright');
const ROUNDS = Number(process.env.ROUNDS || 3), REPO = path.resolve(__dirname, '../..'), SECS = Number(process.argv[2] || 6), LONG = Number(process.argv[3] || 60), QUICK = process.argv.includes('quick');
const ALLOWED = ['/prototypes/render-compare/', '/web/data/'], TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]), f = path.normalize(path.join(REPO, u));
  if (!ALLOWED.some((a) => u.startsWith(a)) || !f.startsWith(REPO) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const PROFILES = [['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }, 1], ['pixel7', { ...devices['Pixel 7'] }, 1], ['pixel7-cpu4x', { ...devices['Pixel 7'] }, 4]];
const MODES = QUICK ? [['replay', 'mode=replay'], ['stress1000', 'mode=stress&n=1000']] : [['replay', 'mode=replay'], ['stress100', 'mode=stress&n=100'], ['stress1000', 'mode=stress&n=1000'], ['stress5000', 'mode=stress&n=5000']];
const RENDERERS = ['A', 'B', 'C'];
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a)), axisDiff = (a, b) => { let d = Math.abs(wrap(a - b)) % Math.PI; return Math.min(d, Math.PI - d); };

async function procCpu(bcdp) { const { processInfo } = await bcdp.send('SystemInfo.getProcessInfo'); const o = {}; for (const p of processInfo) o[p.type] = (o[p.type] || 0) + p.cpuTime; return o; }
async function open(browser, opt, throttle, q) {
  const ctx = await browser.newContext(opt), page = await ctx.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (x) => { if (x.type() === 'error') errors.push(x.text()); });
  if (throttle > 1) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle }); }
  await page.goto(base + '?' + q);
  await page.waitForFunction(() => window.__cmp && (window.__cmp.ready() || window.__cmp.error()), null, { timeout: 180000 });
  const err = await page.evaluate(() => window.__cmp.error()); if (err) errors.push(err);
  return { ctx, page, errors };
}
let base;
server.listen(0, async () => {
  base = `http://localhost:${server.address().port}/prototypes/render-compare/index.html`;
  const browser = await chromium.launch({ args: ['--enable-precise-memory-info'] }), bcdp = await browser.newBrowserCDPSession();
  const failures = [], rows = [], probes = [], longRuns = [];
  const runs = [];
  for (const [tag, opt, throttle] of PROFILES) for (const [m, q] of MODES) {
    const hashes = {};
    // ROUNDS interleaved rounds (A B C A B C …) so slow drifts of the shared host hit every renderer alike; medians
    for (let round = 0; round < ROUNDS; round++) for (const r of RENDERERS) {
      const { ctx, page, errors } = await open(browser, opt, throttle, `${q}&r=${r}`);
      await page.waitForTimeout(4000); await page.evaluate(() => window.__cmp.reset());
      const c0 = await procCpu(bcdp), f0 = (await page.evaluate(() => window.__cmp.info())).frames;
      await page.waitForTimeout(SECS * 1000);
      const fps = await page.evaluate(() => window.__cmp.fps()), info = await page.evaluate(() => window.__cmp.info()), c1 = await procCpu(bcdp), nf = Math.max(1, info.frames - f0);
      const row = { profile: tag, mode: m, renderer: r, round, cpu_throttle: throttle, host_load1: +os.loadavg()[0].toFixed(2), canvas_px: info.canvas, dpr: info.dpr, quality: info.quality, ...fps,
        renderer_proc_ms_per_frame: ((c1.renderer || 0) - (c0.renderer || 0)) * 1000 / nf, gpu_proc_ms_per_frame: ((c1.GPU || 0) - (c0.GPU || 0)) * 1000 / nf,
        heap_mb: info.heap / 1048576, ant_texture_mb: info.ant_texture_bytes / 1048576, chunk_mb: info.chunk_bytes / 1048576, buckets: info.ant_stats.buckets, prerotated: info.ant_stats.prerotated, live_rotated: info.ant_stats.rotated, rot_bake_ms: info.ant_stats.rotBakeMs,
        positions_checked: info.checks.positionsChecked, anchors_checked: info.checks.anchorsChecked, max_heading_err_deg: info.checks.maxBucketErr * 180 / Math.PI, pixi: info.pixi };
      runs.push(row); hashes[`${r}${round}`] = `${info.input_hash}/${info.hash_frames}`; if (info.hash_frames < 10) failures.push(`${tag}/${m}/${r}: only ${info.hash_frames} frames hashed`);
      if (errors.length) failures.push(`${tag}/${m}/${r}: ${errors.join(' | ')}`);
      if (info.checks.positionErrors) failures.push(`${tag}/${m}/${r}: drawn engine position != affine(position) ${info.checks.position}`);
      if (info.checks.anchorErrors) failures.push(`${tag}/${m}/${r}: blit anchor / heading ${info.checks.anchor}`);
      if (info.checks.mutation) failures.push(`${tag}/${m}/${r}: renderer mutated its input`);
      if (!(info.checks.anchorsChecked > 0)) failures.push(`${tag}/${m}/${r}: no anchors checked`);
      console.log(`${tag.padEnd(13)} ${m.padEnd(10)} ${r} fps ${fps.fps_mean?.toFixed(1).padStart(5)} p95 ${fps.p95_ms?.toFixed(1).padStart(6)} cpu ${fps.cpu_mean_ms?.toFixed(2).padStart(6)} ants ${fps.ant_layers_mean_ms?.toFixed(2).padStart(6)} gpu ${row.gpu_proc_ms_per_frame.toFixed(1).padStart(6)} heap ${row.heap_mb.toFixed(1)} tex ${row.ant_texture_mb.toFixed(1)} n=${row.buckets}`);
      await ctx.close();
    }
    const hs = new Set(Object.values(hashes)); if (hs.size !== 1) failures.push(`${tag}/${m}: input hashes differ across renderers ${JSON.stringify(hashes)} (rendering must not affect the animation)`);
    for (const r of RENDERERS) {
      const rs = runs.filter((x) => x.profile === tag && x.mode === m && x.renderer === r), med = (k) => { const v = rs.map((x) => x[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor((v.length - 1) / 2)] : null; };
      const agg = { ...rs[rs.length - 1], rounds: rs.length }; delete agg.round;
      for (const k of ['fps_mean', 'p50_ms', 'p95_ms', 'p99_ms', 'max_ms', 'cpu_mean_ms', 'cpu_p95_ms', 'ant_layers_mean_ms', 'renderer_proc_ms_per_frame', 'gpu_proc_ms_per_frame', 'heap_mb', 'host_load1']) agg[k] = med(k);
      agg.fps_rounds = rs.map((x) => +(x.fps_mean ?? 0).toFixed(1));
      rows.push(agg);
    }
  }
  // pixel probe: isolated sprites, B and C against A
  for (const [tag, opt] of PROFILES.filter((p) => p[2] === 1)) {
    const res = {};
    for (const r of RENDERERS) { const { ctx, page, errors } = await open(browser, opt, 1, `mode=probe&r=${r}&budget=64`); /* budget raised: the probe exercises the pre-rotated path at every DPR */ await page.waitForTimeout(800); res[r] = await page.evaluate(() => window.__cmp.probe()); if (errors.length) failures.push(`probe ${tag}/${r}: ${errors.join(' | ')}`); await ctx.close(); }
    const A = res.A;
    for (const r of RENDERERS) {
      const P = res[r], out = { profile: tag, renderer: r, L: P.L, dpr: P.dpr, ants: P.ants.length, max_centroid_vs_A_px: 0, max_axis_vs_A_deg: 0, max_axis_vs_heading_deg: 0, max_anchor_err_px: 0, bucket_n: P.blits[0]?.n ?? 0 };
      for (const a of P.ants) {
        const ref = A.ants.find((x) => x.id === a.id), d = P.draws.find((x) => x.id === a.id), b = P.blits.find((x) => x.id === a.id);
        out.max_centroid_vs_A_px = Math.max(out.max_centroid_vs_A_px, Math.hypot(a.centroid[0] - ref.centroid[0], a.centroid[1] - ref.centroid[1]));
        out.max_axis_vs_A_deg = Math.max(out.max_axis_vs_A_deg, axisDiff(a.axis, ref.axis) * 180 / Math.PI);
        out.max_axis_vs_heading_deg = Math.max(out.max_axis_vs_heading_deg, axisDiff(a.axis, d.heading) * 180 / Math.PI);
        out.max_anchor_err_px = Math.max(out.max_anchor_err_px, Math.hypot(b.ax - d.sx, b.ay - d.sy), Math.hypot(d.ex - d.sx, d.ey - d.sy));
      }
      probes.push(out);
      const tol = r === 'B' && out.bucket_n ? 180 / out.bucket_n : 0;
      if (out.max_anchor_err_px > 1e-6) failures.push(`probe ${tag}/${r}: anchor error ${out.max_anchor_err_px}`);
      if (out.max_axis_vs_A_deg > tol + 2) failures.push(`probe ${tag}/${r}: body axis differs from A by ${out.max_axis_vs_A_deg.toFixed(2)}° (> bucket tolerance ${tol.toFixed(2)}° + 2°)`);
      if (out.max_centroid_vs_A_px > 1 + (tol ? P.L * 0.3 * Math.sin(tol * Math.PI / 180) : 0)) failures.push(`probe ${tag}/${r}: sprite centroid differs from A by ${out.max_centroid_vs_A_px.toFixed(2)} px`);
      console.log(`probe ${tag} ${r}: centroid vs A ${out.max_centroid_vs_A_px.toFixed(2)} px, axis vs A ${out.max_axis_vs_A_deg.toFixed(2)}°, axis vs heading ${out.max_axis_vs_heading_deg.toFixed(2)}°, n=${out.bucket_n}`);
    }
  }
  // long runs (≥ 60 s), 10 s windows
  const LONGS = QUICK ? [] : [['desktop', 'stress1000', 'mode=stress&n=1000'], ['pixel7-cpu4x', 'replay', 'mode=replay']];
  for (const [tag, m, q] of LONGS) for (const r of RENDERERS) {
    const [, opt, throttle] = PROFILES.find((p) => p[0] === tag), { ctx, page, errors } = await open(browser, opt, throttle, `${q}&r=${r}`);
    await page.waitForTimeout(5000); const h0 = (await page.evaluate(() => window.__cmp.info())).heap, windows = [];
    for (let w = 0; w < Math.ceil(LONG / 10); w++) { await page.evaluate(() => window.__cmp.reset()); await page.waitForTimeout(10000); const f = await page.evaluate(() => window.__cmp.fps()); windows.push({ fps: f.fps_mean, p95: f.p95_ms, max: f.max_ms }); }
    const info = await page.evaluate(() => window.__cmp.info());
    longRuns.push({ profile: tag, mode: m, renderer: r, secs: windows.length * 10, windows, heap_start_mb: h0 / 1048576, heap_end_mb: info.heap / 1048576, errors: errors.length });
    if (errors.length) failures.push(`long ${tag}/${m}/${r}: ${errors.join(' | ')}`);
    console.log(`long ${tag} ${m} ${r}: fps ${windows.map((x) => x.fps?.toFixed(1)).join(' ')} heap ${(h0 / 1048576).toFixed(1)}→${(info.heap / 1048576).toFixed(1)} MB`);
    await ctx.close();
  }
  await browser.close(); server.close();
  const meta = { host_cpus: os.cpus().length, measured: `headless Chromium via Playwright; ${ROUNDS} interleaved rounds × ${SECS} s per run after 4 s warm-up (medians); shared host (load average recorded per run); fixed quality level 1 (no glints) for all renderers; not a real device`, chromium: browser.version?.() ?? null, node: process.version, pixi: '8.22.0', date: new Date().toISOString().slice(0, 10) };
  if (!QUICK) fs.writeFileSync(path.join(__dirname, 'results.json'), JSON.stringify({ meta, rows, runs, probes, longRuns, failures }, null, 1) + '\n');
  if (failures.length) { console.error('FAILURES\n' + failures.join('\n')); process.exit(1); }
  console.log('all checks passed');
});
