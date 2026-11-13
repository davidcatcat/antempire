/**
 * VIS-1 demo evidence + checks (Playwright Chromium; NON-OFFICIAL experiment world). Desktop 1440×900 (mouse) and
 * Android Pixel 7 emulation (touch; screenshots at CSS scale). FAILS (exit 1) on a failed check, page error or console
 * error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/vis1-demo.check.cjs <outDir> http://localhost:8781/
 * Writes into <outDir>: vis1-<profile>-{surface,closeup,underground,night}.jpg, vis1-desktop-motion-frames.jpg source
 * frames (vis1-motion-NN.jpg), vis1-desktop-motion.webm, and prints a JSON report (checks + frame-time measurements).
 * Checks:
 *  - the garden view is the default P0-A2 view; the legend separates engine / display interpolation / 示意 / 裝飾 and
 *    the canvas chip names 「路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎」 (page text);
 *  - paused at the next departure / arrival of a travelling worker, every drawn worker's exact point equals the affine
 *    image of its display pose, departures are drawn exactly at the route end (engine), never interpolated;
 *  - follow + close-up: the followed ant is drawn ≥ 60 px long at true scale (magnification label 實際比例);
 *  - the underground view shows the concept label 「概念圖：巢室幾何尚未模擬」 and exactly the in-nest / transit workers;
 *  - surface ↔ underground, legend, close-up and follow do not change the event stream or the payload hash at the same
 *    t_sim (vs a page that only steps);
 *  - measurements (headless; reported, no target claimed): frame intervals, renderer CPU per frame, bake cost.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'vis1-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], measurements = {}, files = [];
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch();
  const url = (p) => new URL(p, base).href;
  const profiles = [['desktop', { viewport: { width: 1440, height: 900 } }], ['pixel7', { ...devices['Pixel 7'] }]];
  const open = async (ctx, tag, q) => {
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    await page.goto(url(`experiment.html${q}`));
    await page.waitForFunction((auto) => window.__v62 && window.__v62.frame() && window.__v62.pacing() && (!auto || window.__v62.pacing().running) && window.__v62.state().layers.length === 11, !q.includes('autostart=0'), { timeout: 60000 });
    return page;
  };
  const shot = async (page, name, clip) => { const f = path.join(out, `vis1-${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 82, scale: 'css', ...(clip ? { clip } : {}) }); files.push(f); return f; };
  const measure = async (page, key, ms = 5000) => {
    await page.evaluate(() => window.__v62.resetFps()); await page.waitForTimeout(ms);
    const r = await page.evaluate(() => ({ fps: window.__v62.fps(), g: window.__v62.state().garden, q: window.__v62.state().quality }));
    measurements[key] = { headless: true, fps_mean: r.fps.fps_mean && +r.fps.fps_mean.toFixed(1), frame_interval_p50_ms: r.fps.p50_ms && +r.fps.p50_ms.toFixed(1), frame_interval_p95_ms: r.fps.p95_ms && +r.fps.p95_ms.toFixed(1), renderer_cpu_p50_ms: r.g.frame_p50_ms, renderer_cpu_p95_ms: r.g.frame_p95_ms, chunk_bakes: r.g.bakes, bake_ms_last: r.g.lastBakeMs && +r.g.lastBakeMs.toFixed(1), quality: r.q };
  };

  for (const [tag, opts] of profiles.filter(([t]) => !process.env.VIS1_PROFILE || process.env.VIS1_PROFILE === t)) {
    const ctx = await browser.newContext(opts);
    const P = await open(ctx, tag, '?seed=7');
    // 1. labels
    const lab = await P.evaluate(() => ({ legend: document.querySelector('#legend').textContent, chipTag: document.querySelector('#bottom .legend-tag').textContent, view: window.__v62.state().view, decor: document.querySelector('#decor').checked, ug: document.querySelector('#ugLabel').hidden }));
    check(lab.view === 'surface' && lab.decor && lab.ug, `${tag}: P0-A2 opens on the garden surface with decoration on`);
    check(['引擎', '顯示插值', '示意', '裝飾', '不是障礙物', '路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎'].every((s) => lab.legend.includes(s)) && lab.chipTag.includes('路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎'), `${tag}: legend separates engine / display interpolation / 示意 / 裝飾 and names the path rule`);
    // a daytime moment with ants on the route (identical for both profiles: same seed, same t)
    await P.evaluate(async () => { const V = window.__v62; await V.client.pause(); await V.client.stepUntil(9 * 3600 + 1200); await V.client.resume(); await V.client.setSpeed(1); });
    await P.waitForTimeout(2500);
    await shot(P, `${tag}-surface`);
    // 2. drawn = display pose; departures exactly at the route end
    const rec = await P.evaluate(async () => {
      const V = window.__v62, raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await V.client.pause(); const out = { instants: 0, compared: 0, departures: 0, mismatches: [] };
      for (let k = 0; k < 8; k++) {
        const f = V.frame(), mv = f.workers.filter((w) => w.until_s !== null && w.until_s > f.t_sim && (w.state === 'outbound' || w.state === 'returning'));
        await V.client.stepUntil(mv.length ? Math.min(...mv.map((w) => w.until_s)) : f.t_sim + 300); await raf();
        const fr = V.frame(), cam = V.camera(), draws = V.draws(), poses = V.p0poses(), C = V.corridor();
        const W2S = (x, y) => [cam.w / 2 + (x - cam.cx) * cam.s, cam.h / 2 - (y - cam.cy) * cam.s];
        for (const w of fr.workers.filter((x) => x.loc === 'outside')) {
          const p = poses.find((x) => x.id === w.id), d = draws.find((x) => x.id === w.id), [ex, ey] = W2S(p.x, p.y); out.compared++;
          if (!d || d.ex !== ex || d.ey !== ey) out.mismatches.push(`${w.id} drawn off its pose`);
          if (w.since_s === fr.t_sim && (w.state === 'outbound' || w.state === 'returning') && w.route !== null) {
            const end = w.state === 'outbound' ? C.nest : C.source;
            if (p.interpolated || p.x !== end.x || p.y !== end.y) out.mismatches.push(`${w.id} not at the route end at its departure`); else out.departures++;
          }
        }
        out.instants++;
      }
      await V.client.resume(); return out;
    });
    check(rec.mismatches.length === 0 && rec.compared > 0, `${tag}: at ${rec.instants} record instants every drawn worker = its display pose (${rec.compared} comparisons, ${rec.departures} departures exactly at the route end; ${rec.mismatches.slice(0, 2).join(' | ')})`);
    await measure(P, `${tag}-surface-1x`);
    // 3. follow a travelling worker, close-up
    const id = await P.evaluate(async () => { const V = window.__v62; for (let i = 0; i < 40; i++) { const f = V.frame(), w = f.workers.find((x) => x.state === 'outbound' && x.until_s - f.t_sim > 40); if (w) return w.id; await V.client.stepUntil(f.t_sim + 30); } return null; });
    check(!!id, `${tag}: found an outbound worker to follow (${id})`);
    await P.selectOption('#follow', id); await P.waitForTimeout(300); await P.click('#closeBtn'); await P.waitForTimeout(3500);
    const cu = await P.evaluate((id) => { const V = window.__v62, c = V.camera(), d = V.draws().find((x) => x.id === id); return { s: c.s, len: 0.25 * c.s, d, w: c.w, h: c.h, following: V.state().following }; }, id);
    check(cu.following === id && cu.len >= 60 && cu.d && Math.abs(cu.d.sx - cu.w / 2) < cu.w * 0.25, `${tag}: follow + close-up draws the ant ${cu.len.toFixed(0)} px long at true scale, centred`);
    await shot(P, `${tag}-closeup`);
    await measure(P, `${tag}-closeup-follow-1x`, 4000);
    if (tag === 'desktop') { // motion test: frame sequence of the followed ant (1×, 100 ms apart)
      for (let i = 0; i < 8; i++) { const c = await P.evaluate(() => window.__v62.camera()); await shot(P, `motion-${String(i).padStart(2, '0')}`, { x: c.w / 2 - 200, y: c.h / 2 - 130, width: 400, height: 260 }); await P.waitForTimeout(100); }
    }
    await P.selectOption('#follow', ''); await P.waitForTimeout(200);
    // 4. underground concept view
    await P.click('#viewBtn'); await P.waitForTimeout(1200);
    const ug = await P.evaluate(() => { const V = window.__v62, f = V.frame(); return { label: document.querySelector('#ugLabel').textContent, hidden: document.querySelector('#ugLabel').hidden, view: V.state().view, hits: V.insetHits().map((h) => h.id).sort(), inNest: f.workers.filter((w) => w.loc !== 'outside').map((w) => w.id).sort() }; });
    check(ug.view === 'underground' && !ug.hidden && ug.label.includes('概念圖：巢室幾何尚未模擬'), `${tag}: underground view shows 「概念圖：巢室幾何尚未模擬」`);
    check(JSON.stringify(ug.hits) === JSON.stringify(ug.inNest), `${tag}: the concept view draws exactly the ${ug.inNest.length} workers the engine has in the nest or the entrance passage`);
    await shot(P, `${tag}-underground`);
    await measure(P, `${tag}-underground-1x`, 3000);
    await P.click('#viewBtn'); await P.waitForTimeout(300);
    // 5. night (engine light state night) at full view
    await P.click('#homeBtn');
    const night = await P.evaluate(async () => { const V = window.__v62; await V.client.pause(); await V.client.stepUntil(21 * 3600 + 15 * 60); await V.client.resume(); await new Promise((r) => setTimeout(r, 1500)); return { light: V.frame().env.light, scene: V.sceneLight() }; });
    check(night.light === 'night' && night.scene.includes('夜'), `${tag}: night scene follows the engine light state (${night.scene})`);
    await shot(P, `${tag}-night`);
    // 6. UI operations of VIS-1 do not change results
    const A = await open(ctx, tag, '?seed=41');
    await A.selectOption('#speed', '600'); await A.waitForTimeout(500);
    await A.click('#legendBtn'); await A.click('#viewBtn'); await A.waitForTimeout(300); await A.click('#zoomIn'); await A.click('#viewBtn'); await A.click('#closeBtn'); await A.waitForTimeout(300);
    await A.click('#decor'); await A.click('#homeBtn'); await A.click('#legendBtn'); await A.selectOption('#speed', '3600'); await A.waitForTimeout(600);
    const ra = await A.evaluate(async () => { const V = window.__v62; await V.client.pause(); const t0 = V.frame().t_sim, TT = Math.ceil(t0 / 3600) * 3600 + 3600.25; await V.client.stepUntil(TT); const s = (await V.client.snapshot()).snapshot; return { t0, T: TT, digest: V.digest(), hash: s.payload_sha256 }; });
    const B = await open(ctx, tag, '?seed=41&autostart=0');
    const rb = await B.evaluate(async (T) => { const V = window.__v62; await V.client.stepUntil(T); const s = (await V.client.snapshot()).snapshot; return { digest: V.digest(), hash: s.payload_sha256 }; }, ra.T);
    check(ra.t0 > 0 && ra.digest.value === rb.digest.value && ra.digest.count === rb.digest.count && ra.hash === rb.hash, `${tag}: legend, surface ↔ underground, zoom, close-up, decoration toggle, speeds → same event stream (${ra.digest.count} events) and payload hash at t_sim=${ra.T}`);
    await A.close(); await B.close();
    // 7. mid-range mobile proxy: 4× CPU throttling (emulated device; reported only)
    if (tag === 'pixel7') {
      const cdp = await ctx.newCDPSession(P); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await P.evaluate(async () => { const V = window.__v62; await V.client.pause(); await V.client.stepUntil(86400 + 9 * 3600); await V.client.resume(); await V.client.setSpeed(60); });
      await P.click('#homeBtn'); await P.waitForTimeout(1500); await measure(P, 'pixel7-surface-60x-cpu4', 5000);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    }
    await P.close(); await ctx.close();
  }
  // 8. short video (desktop): following an ant at close range, then zooming out
  if (!process.env.VIS1_PROFILE || process.env.VIS1_PROFILE === 'desktop') {
    const vctx = await browser.newContext({ viewport: { width: 960, height: 600 }, recordVideo: { dir: out, size: { width: 960, height: 600 } } });
    const V = await open(vctx, 'video', '?seed=7');
    const id = await V.evaluate(async () => { const X = window.__v62; await X.client.pause(); await X.client.stepUntil(9 * 3600 + 1200); for (let i = 0; i < 40; i++) { const f = X.frame(), w = f.workers.find((x) => x.state === 'outbound' && x.until_s - f.t_sim > 30); if (w) { await X.client.resume(); await X.client.setSpeed(1); return w.id; } await X.client.stepUntil(f.t_sim + 30); } await X.client.resume(); return null; });
    if (id) { await V.selectOption('#follow', id); await V.click('#closeBtn'); }
    await V.waitForTimeout(6500);
    for (let i = 0; i < 4; i++) { await V.click('#zoomOut'); await V.waitForTimeout(500); }
    await V.waitForTimeout(800);
    const vpath = await V.video().path(); await V.close(); await vctx.close();
    const dst = path.join(out, 'vis1-desktop-motion.webm'); fs.renameSync(vpath, dst); files.push(dst);
    check(fs.statSync(dst).size > 10000, `video recorded (${(fs.statSync(dst).size / 1024).toFixed(0)} KB)`);
  }
  await browser.close();
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  console.log(JSON.stringify({ test: 'vis1-demo-browser', passed: passed.length, failed: failures, measurements_note: 'headless Chromium; pixel7 = emulated viewport + touch (and 4× CPU throttling as a mid-range proxy), not a real device; renderer_cpu = main-thread time of the garden renderer per drawn frame', measurements, files: files.map((f) => path.basename(f)), passed_checks: passed }, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
