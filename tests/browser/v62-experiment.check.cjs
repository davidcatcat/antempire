/**
 * V6-2 experiment mode (P0-A2 PR 3) in a real browser (Playwright Chromium): desktop 1280x800 (mouse) and the
 * Android Pixel 7 profile (touch). NON-OFFICIAL. FAILS (exit 1) on any failed check, page error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/v62-experiment.check.cjs <outDir> http://localhost:8781/
 * Checks:
 *  - the page is labelled 非正式實驗世界／不屬於正式遊戲歷史; the layered renderer draws all 11 layers; world time
 *    advances at the default 1× and pause freezes it.
 *  - drawn = engine at record instants: paused at an ant's record instant (step_until its until_s), every drawn ant's
 *    exact screen point equals the affine image of the Worker's recorded position, and the ant that had the event is
 *    drawn exactly at the event's recorded position; drawn ants = ants outside the nest.
 *  - UI operations do not change results: a session with real input (pause / resume, speeds, wheel or button zoom,
 *    drag, tap-select, follow, frame-rate cap, décor toggle) then step_until T has the same event digest, event count
 *    and payload SHA-256 as a fresh session that only steps to T.
 *  - isolation: the official pages (index.html, analysis.html) create no Worker and request nothing from worker-dist;
 *    the experiment page creates exactly one Worker and requests nothing under data/, saves/ or journal/.
 *  - measurements (HEADLESS Chromium on this machine; the Pixel 7 profile is an emulated viewport + touch, NOT a real
 *    phone): frame intervals, JS heap, main-thread task time, Worker throughput; also with 4x CPU throttling.
 *    Reported only; no frame-rate target is claimed.
 *  - saves/ and journal/ unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
const dirHash = (d) => { const h = crypto.createHash('sha256'); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(ROOT, d)); return h.digest('hex'); };
const COUNT_WORKERS = () => { window.__workerCount = 0; const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__workerCount++; } }; };

(async () => {
  const out = process.argv[2] || 'v62-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], measurements = {}, shots = [];
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
  const browser = await chromium.launch();
  const url = (p) => new URL(p, base).href;
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', { ...devices['Pixel 7'] }]];
  const T = 12 * 3600 + 0.25;

  for (const [tag, opts] of profiles.filter(([t]) => !process.env.V62_PROFILE || process.env.V62_PROFILE === t)) {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(COUNT_WORKERS);
    const requests = [];
    ctx.on('request', (r) => requests.push(r.url()));
    const open = async (q) => {
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
      await page.goto(url(`experiment.html${q}`));
      await page.waitForFunction(() => window.__v62 && window.__v62.frame() && window.__v62.pacing(), null, { timeout: 20000 });
      return page;
    };
    const shot = async (page, name) => { const f = path.join(out, `v62-${tag}-${name}.png`); await page.screenshot({ path: f }); shots.push(f); };

    // --- 1. label, layers, default 1x, continuous time, pause
    const page = await open('?seed=7');
    check((await page.textContent('#badge')).includes(LABEL) && (await page.textContent('#exp-flag')) === '非正式', `${tag}: non-official label and flag shown`);
    await page.waitForTimeout(1200);
    const s0 = await page.evaluate(() => ({ p: window.__v62.pacing(), t: window.__v62.frame().t_sim, layers: window.__v62.state().layers, workers: window.__workerCount }));
    check(s0.p.running && s0.p.speed === 1, `${tag}: running at the default 1× (${JSON.stringify(s0.p)})`);
    check(s0.layers.length === 11 && s0.layers[0] === 'ground' && s0.layers[10] === 'ui', `${tag}: layered renderer drew 11 layers`);
    check(s0.workers === 1, `${tag}: experiment page created exactly one Worker`);
    await page.waitForTimeout(1500);
    const t1 = await page.evaluate(() => window.__v62.frame().t_sim);
    check(t1 - s0.t > 1.0 && t1 - s0.t < 2.5, `${tag}: world time advances ≈ real time at 1× (${(t1 - s0.t).toFixed(2)} s in 1.5 s)`);
    await shot(page, '1-opening-1x');
    await page.selectOption('#speed', '600');
    await page.waitForTimeout(2500);
    await shot(page, '2-running-600x');
    await page.click('#play'); await page.waitForTimeout(300);
    const pz = await page.evaluate(() => window.__v62.frame().t_sim); await page.waitForTimeout(600);
    check(pz === await page.evaluate(() => window.__v62.frame().t_sim) && !(await page.evaluate(() => window.__v62.pacing().running)), `${tag}: pause freezes world time`);

    // --- 2. drawn = engine at record instants (paused)
    const inst = await page.evaluate(async () => {
      const V = window.__v62, raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const out = { instants: 0, antsCompared: 0, eventAntExact: 0, mismatches: [], countMismatch: 0 };
      for (let k = 0; k < 12; k++) {
        const f = V.frame(), next = f.ants.reduce((m, a) => (a.until_s < m.until_s ? a : m), f.ants[0]);
        await V.client.stepUntil(next.until_s); await raf();
        const fr = V.frame(), cam = V.camera(), draws = V.draws(), poses = V.poses();
        const W2S = (x, y) => [cam.w / 2 + (x - cam.cx) * cam.s, cam.h / 2 - (y - cam.cy) * cam.s];
        const outside = fr.ants.filter((a) => !a.in_nest);
        if (draws.length !== outside.length) out.countMismatch++;
        if (V.state().lastDisplay !== null || V.pacing().running) out.mismatches.push('paused display clock is not the frame t_sim');
        // paused: every pose is evaluated at exactly the Worker's t_sim (walking ants mid-segment are interpolated AT t_sim)
        for (const a of outside) { const p = poses.find((x) => x.id === a.id); let x = a.from.x, y = a.from.y;
          if (a.activity === 'walking' && a.to) { const k = (fr.t_sim - a.since_s) / (a.until_s - a.since_s); if (k >= 1) { x = a.to.x; y = a.to.y; } else if (k > 0) { x = a.from.x + (a.to.x - a.from.x) * k; y = a.from.y + (a.to.y - a.from.y) * k; } }
          if (p.x !== x || p.y !== y) out.mismatches.push(`${a.id} pose not evaluated at t_sim`); }
        for (const a of outside) {
          const d = draws.find((x) => x.id === a.id), [ex, ey] = W2S(a.from.x, a.from.y); out.antsCompared++;
          // paused at t_sim: every outside ant is at a record (segment start), walking ants exactly at their start only if since_s == t
          const p = poses.find((x) => x.id === a.id), [px, py] = W2S(p.x, p.y);
          if (!d || d.ex !== px || d.ey !== py) out.mismatches.push(`${a.id} drawn ${d && [d.ex, d.ey]} pose ${[px, py]}`);
          if (a.since_s === fr.t_sim && (!d || d.ex !== ex || d.ey !== ey)) out.mismatches.push(`${a.id} at its record instant drawn off the recorded point`);
        }
        const ev = V.recent().filter((e) => e.kind === 'ant_bout_end' && e.t_sim === next.until_s && e.entity === next.id).pop();
        if (ev && !fr.ants.find((a) => a.id === ev.entity).in_nest) {
          const d = draws.find((x) => x.id === ev.entity), [ex, ey] = W2S(ev.data.pos.x, ev.data.pos.y);
          if (d && d.ex === ex && d.ey === ey) out.eventAntExact++; else out.mismatches.push(`event ant ${ev.entity} drawn ${d && [d.ex, d.ey]} vs recorded ${[ex, ey]}`);
        } else if (!ev) out.mismatches.push(`no event for ${next.id} at ${next.until_s}`);
        out.instants++;
      }
      return out;
    });
    check(inst.mismatches.length === 0 && inst.countMismatch === 0 && inst.eventAntExact > 0, `${tag}: at ${inst.instants} record instants drawn ants = Worker state exactly (${inst.antsCompared} ant comparisons, ${inst.eventAntExact} event ants at the recorded point; ${inst.mismatches.slice(0, 2).join(' | ')})`);
    // follow + info screenshots
    await page.selectOption('#speed', '60'); await page.click('#play');
    await page.waitForTimeout(800);
    // pause before reading the ant's screen position, so the tap lands where the ant is drawn (at 60× an ant moves
    // between reading draws() and the tap; that race, not the selection, made this check flaky); resume afterwards
    await page.click('#play'); await page.waitForFunction(() => !window.__v62.pacing().running); await page.waitForTimeout(150);
    const pick = await page.evaluate(() => window.__v62.draws()[0] || null);
    if (pick) { if (tag === 'pixel7') await page.tap('#scene', { position: { x: pick.sx, y: pick.sy } }); else await page.mouse.click(pick.sx, pick.sy); }
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.__v62.state().selected);
    check(pick === null || sel === pick.id, `${tag}: tapping an ant selects it (${sel})`);
    await page.click('#play'); await page.waitForFunction(() => window.__v62.pacing().running);
    if (sel) { await page.click('#followBtn'); await page.waitForTimeout(1500); await shot(page, '3-follow'); }
    const fol = await page.evaluate(() => ({ s: window.__v62.state(), f: window.__v62.followed() }));
    check(!sel || (fol.s.following === sel && fol.f && fol.f.id === sel), `${tag}: follow attaches the Worker's read-only copy of the ant`);
    await page.click('#infoBtn'); await page.waitForTimeout(200); await shot(page, '4-about'); await page.click('#infoBtn');
    await page.click('#logBtn'); await page.waitForTimeout(400); await shot(page, '5-event-log'); await page.click('#logBtn');

    // --- 3. measurements (headless; reported only)
    const cdp = await ctx.newCDPSession(page); await cdp.send('Performance.enable');
    const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
    const measure = async (label, speed, throttle) => {
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
      await page.selectOption('#speed', String(speed)); await page.waitForTimeout(800);
      await page.evaluate(() => window.__v62.resetFps());
      const m0 = await metric(), w0 = Date.now(), ts0 = await page.evaluate(() => window.__v62.frame().t_sim);
      await page.waitForTimeout(6000);
      const m1 = await metric(), wall = (Date.now() - w0) / 1000, ts1 = await page.evaluate(() => window.__v62.frame().t_sim);
      const f = await page.evaluate(() => ({ ...window.__v62.fps(), lagging: window.__v62.pacing().lagging, quality: window.__v62.state().quality }));
      measurements[`${tag}-${label}`] = { headless: true, emulated_device: tag === 'pixel7', cpu_throttle: throttle, speed, fps_mean: f.fps_mean && +f.fps_mean.toFixed(1), frame_p50_ms: f.p50_ms && +f.p50_ms.toFixed(1), frame_p95_ms: f.p95_ms && +f.p95_ms.toFixed(1), main_thread_task_s_per_s: +((m1.TaskDuration - m0.TaskDuration) / wall).toFixed(3), main_thread_script_s_per_s: +((m1.ScriptDuration - m0.ScriptDuration) / wall).toFixed(3), js_heap_used_mb: +(m1.JSHeapUsedSize / 1048576).toFixed(1), world_s_per_real_s: +((ts1 - ts0) / wall).toFixed(1), worker_lagging: f.lagging, render_quality_level: f.quality };
    };
    await measure('1x', 1, 1); await measure('3600x', 3600, 1); await measure('3600x-cpu4', 3600, 4);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    check(Object.keys(measurements).filter((k) => k.startsWith(tag)).every((k) => measurements[k].fps_mean > 0), `${tag}: frames drawn in every measurement`);

    // --- 4. UI operations do not change results (real input), vs a fresh page that only steps
    const A = await open('?seed=21');
    const W = (opts.viewport.width), H = (opts.viewport.height);
    await A.selectOption('#speed', '3600'); await A.waitForTimeout(700);
    if (tag === 'desktop') { await A.mouse.move(W / 2, H / 2); await A.mouse.wheel(0, -400); await A.mouse.down(); await A.mouse.move(W / 2 + 120, H / 2 + 60, { steps: 6 }); await A.mouse.up(); await A.mouse.wheel(0, 300); }
    else { await A.tap('#zoomIn'); await A.tap('#zoomIn'); await A.tap('#zoomOut'); }
    await A.selectOption('#fpsCap', '15'); await A.waitForTimeout(500);
    await A.click('#play'); await A.waitForTimeout(300); await A.click('#play');
    await A.selectOption('#follow', 'w02'); await A.waitForTimeout(400);
    await A.selectOption('#speed', '600'); await A.click('#decor'); await A.waitForTimeout(500);
    await A.selectOption('#fpsCap', '30'); await A.click('#homeBtn'); await A.selectOption('#speed', '3600'); await A.waitForTimeout(800);
    await A.selectOption('#follow', ''); await A.click('#play');
    const ra = await A.evaluate(async (T) => { const V = window.__v62; await new Promise((r) => setTimeout(r, 200)); const t0 = V.frame().t_sim; const TT = Math.max(T, Math.ceil(t0 / 3600) * 3600 + 3600.25); await V.client.stepUntil(TT); const s = (await V.client.snapshot()).snapshot; return { t0, T: TT, digest: V.digest(), hash: s.payload_sha256, t: s.t_sim }; }, T);
    const B = await open('?seed=21&autostart=0');
    const rb = await B.evaluate(async (T) => { const V = window.__v62; await V.client.stepUntil(T); const s = (await V.client.snapshot()).snapshot; return { digest: V.digest(), hash: s.payload_sha256, t: s.t_sim }; }, ra.T);
    check(ra.t0 > 0 && ra.t0 < ra.T, `${tag}: UI session reached t=${ra.t0.toFixed(0)} s before the comparison step at t=${ra.T}`);
    check(ra.digest.value === rb.digest.value && ra.digest.count === rb.digest.count && ra.digest.gaps === 0 && ra.hash === rb.hash, `${tag}: pause/resume, speeds, zoom, drag, follow, FPS cap, décor → same event stream (${ra.digest.count} events, digest ${ra.digest.value}) and payload hash at t_sim=${ra.T}`);
    await A.close(); await B.close();

    // --- 5. isolation: official pages never create the Worker
    for (const p of ['index.html', 'analysis.html']) {
      const before = requests.length, o = await ctx.newPage();
      o.on("pageerror", (e) => errors.push(`${tag} ${p}: ${e.stack || e}`));
      await o.goto(url(p)); await o.waitForTimeout(2500);
      const n = await o.evaluate(() => window.__workerCount);
      check(n === 0 && !requests.slice(before).some((r) => r.includes('worker-dist')), `${tag}: official ${p} creates no Worker and loads nothing from worker-dist`);
      await o.close();
    }
    const expReq = requests.filter((r) => r.includes('experiment.html') || r.includes('/dist/v62') || r.includes('worker-dist'));
    check(expReq.length > 0, `${tag}: experiment requests recorded`);
    await page.close();
    await ctx.close();
    // a context that only opens the experiment page: nothing under data/, saves/ or journal/ is requested
    const iso = await browser.newContext(opts); const reqs = []; iso.on('request', (r) => reqs.push(new URL(r.url()).pathname));
    const ip = await iso.newPage(); await ip.goto(url('experiment.html?seed=4')); await ip.waitForFunction(() => window.__v62 && window.__v62.frame()); await ip.waitForTimeout(1500);
    check(reqs.length > 0 && !reqs.some((p) => /^\/(data|saves|journal)\//.test(p) || p.includes('/data/')), `${tag}: experiment mode requests nothing under data/, saves/ or journal/ (${reqs.length} requests)`);
    await iso.close();
  }
  await browser.close();
  check(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged');
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  const result = { test: 'v62-experiment-browser', passed: passed.length, failed: failures, measurements_note: 'headless Chromium on the CI/dev machine; pixel7 = emulated viewport+touch, not a real device; main-thread metrics only (Worker CPU not measured); no frame-rate target claimed', measurements, screenshots: shots.map((s) => path.basename(s)), passed_checks: passed };
  console.log(JSON.stringify(result, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
