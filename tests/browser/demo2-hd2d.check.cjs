/**
 * Demo 2 — the opt-in HD-2D picture style (畫面效果; WebGL 2 renderer only). Playwright Chromium, NON-OFFICIAL P0-A2
 * experiment world; desktop 1440×900 and Pixel 7 (touch). FAILS (exit 1) on a failed check, a page error or a console
 * error.   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-hd2d.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - default is the standard style; the 效能 tab toggle (畫面風格：標準／HD-2D) and `?style=hd2d` switch it; the tab
 *    lists the active effects; pixel factor 關／2×／3×／4× resizes the internal target; the picture really is
 *    pixelated (runs of identical neighbouring pixels) while the HTML labels stay at native resolution;
 *  - rendering only: the same individuals are drawn in both styles; the display director's output at the same
 *    simulated instant is identical with the style on or off; tap / click selection and follow work with pixelation on;
 *  - the extras follow the ENGINE light state: light shafts are shown by day and hidden at night;
 *  - auto quality drops depth of field first, then bloom (software rendering is slow enough to trigger it);
 *  - under the WebGPU renderer path the style is refused and the 效能 tab says 「HD-2D 目前僅 WebGL 2」;
 *  - screenshots standard vs HD-2D (full, underground, follow close-up; phone full) into <outDir>.
 * Performance numbers are software-rendered under automation: NOT device results.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-hd2d-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], files = [], report = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const ready = (page) => page.waitForFunction(() => window.__demo2 && window.__demo2.ready && window.__demo2.state().ants > 0, null, { timeout: 120000 });
  const shot = async (page, name, q = 70) => { const f = path.join(out, `${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: q }); files.push(f); };
  const T = 9 * 3600 + 240, sample = (page) => page.evaluate(async (t) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(t); return JSON.stringify(D.sampleNow()); }, T);
  // fraction of pixels identical to their left neighbour in a strip of the scene (pixelation shows as long runs)
  const runs = async (page, clip) => { const png = (await page.screenshot({ type: 'png', clip })).toString('base64'); return page.evaluate(async (d) => { const im = new Image(); im.src = 'data:image/png;base64,' + d; await im.decode(); const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const g = c.getContext('2d'); g.drawImage(im, 0, 0); const A = g.getImageData(0, 0, c.width, c.height).data; let same = 0, n = 0; for (let y = 0; y < c.height; y++) for (let x = 1; x < c.width; x++) { const i = (y * c.width + x) * 4; n++; if (A[i] === A[i - 4] && A[i + 1] === A[i - 3] && A[i + 2] === A[i - 2]) same++; } return same / n; }, png); };
  const browser = await chromium.launch();
  for (const [tag, opts] of [['desktop', { viewport: { width: 1440, height: 900 } }], ['pixel7', { ...devices['Pixel 7'] }]]) {
    const mobile = tag === 'pixel7', vp = opts.viewport, clip = { x: Math.round(vp.width * 0.2), y: Math.round(vp.height * 0.55), width: Math.round(vp.width * 0.6), height: 60 };
    const open = async (query, name) => { const ctx = await browser.newContext(opts), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${tag}/${name}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}/${name}: ${m.text()}`); }); await page.goto(new URL(`demo2.html?${query}`, base).href); await ready(page); return { ctx, page }; };

    // reference: the standard style (paused page, straight after loading)
    const std = await open('seed=1&quality=medium&autostart=0', 'standard');
    const s0 = await std.page.evaluate(() => ({ st: window.__demo2.style(), s: window.__demo2.state(), statics: window.__demo2.statics().map((x) => x.id).join() }));
    check(s0.st.style === 'standard' && !s0.st.active && s0.st.scene.built === false, `${tag}: the default is the standard style (no HD-2D scenery built)`);
    const ref = await sample(std.page);
    await std.page.waitForTimeout(800); const runStd = await runs(std.page, clip);
    if (!mobile) { await shot(std.page, 'demo2-std-desktop-full'); await std.page.evaluate(() => window.__demo2.setView('under')); await std.page.waitForTimeout(1200); await shot(std.page, 'demo2-std-desktop-underground'); await std.page.evaluate(() => window.__demo2.setView('full')); }
    else await shot(std.page, 'demo2-std-pixel7-full', 55);
    // switch with the toggle in the 效能 tab
    if (mobile) await std.page.click('#moreBtn'); // phones keep the panel button in the 更多 menu
    await std.page.click('#sideBtn'); await std.page.click('#tabs button[data-tab="perf"]'); await std.page.waitForTimeout(400);
    await std.page.click('#pane-perf button[data-style="hd2d"]'); await std.page.waitForTimeout(1500);
    const t1 = await std.page.evaluate(() => ({ st: window.__demo2.style(), perf: document.querySelector('#pane-perf').textContent, legendBtn: !!document.querySelector('#tabs button[data-tab="legend"]') }));
    check(t1.st.active && t1.st.px === 3 && Math.abs(t1.st.low[0] - t1.st.buf[0] / 3) <= 1 && Math.abs(t1.st.low[1] - t1.st.buf[1] / 3) <= 1, `${tag}: the 效能 tab toggle turns HD-2D on; internal target ${t1.st.low.join('×')} = drawing buffer ${t1.st.buf.join('×')} / 3`);
    check(['畫面風格', '像素化 3×', '景深', '泛光', '作用中的畫面效果', '只是畫面效果'].every((x) => t1.perf.includes(x)) && t1.st.scene.on && t1.st.scene.extra_instances > 2000 && t1.st.scene.dust > 0, `${tag}: the tab lists the active effects (${t1.st.text.slice(0, 30)}…); denser foliage and dust are scenery (${t1.st.scene.extra_instances} extra instances)`);
    await std.page.click('#pane-perf button[data-px="2"]'); await std.page.waitForTimeout(500); const p2 = await std.page.evaluate(() => window.__demo2.style());
    await std.page.click('#pane-perf button[data-px="1"]'); await std.page.waitForTimeout(500); const p1 = await std.page.evaluate(() => window.__demo2.style());
    await std.page.click('#pane-perf button[data-px="4"]'); await std.page.waitForTimeout(500); const p4 = await std.page.evaluate(() => window.__demo2.style());
    check(Math.abs(p2.low[0] - p2.buf[0] / 2) <= 1 && p1.low[0] === p1.buf[0] && Math.abs(p4.low[0] - p4.buf[0] / 4) <= 1 && /像素化 關/.test(p1.text), `${tag}: pixel factor 2× / 關 / 4× resizes the internal target (${p2.low[0]}, ${p1.low[0]}, ${p4.low[0]} px wide)`);
    await std.page.click('#pane-perf #fxDof'); await std.page.waitForTimeout(300); const nd = await std.page.evaluate(() => window.__demo2.style());
    check(!nd.fx.dof && nd.fx.bloom && !/景深/.test(nd.text), `${tag}: depth of field can be switched off (active: ${nd.text.slice(0, 26)}…)`);
    await std.page.click('#pane-perf button[data-style="standard"]'); await std.page.waitForTimeout(600);
    check(!(await std.page.evaluate(() => window.__demo2.style().active)) && /無（標準畫面）/.test(await std.page.textContent('#fxNow')), `${tag}: back to the standard style`);
    await std.ctx.close();

    // ?style=hd2d: same world, same individuals, same director output; really pixelated; selection and follow work
    const hd = await open('seed=1&quality=medium&autostart=0&style=hd2d', 'hd2d');
    const h0 = await hd.page.evaluate(() => ({ st: window.__demo2.style(), s: window.__demo2.state(), statics: window.__demo2.statics().map((x) => x.id).join() }));
    check(h0.st.active && h0.s.ants === s0.s.ants && h0.s.queens === s0.s.queens && h0.s.majors === s0.s.majors && h0.s.eggs === s0.s.eggs && h0.s.pupae === s0.s.pupae && h0.s.larvae === s0.s.larvae && h0.statics === s0.statics, `${tag}: ?style=hd2d draws exactly the same individuals (${h0.s.ants} workers, ${h0.s.queens} queens, ${h0.s.larvae} larvae…)`);
    check(await sample(hd.page) === ref, `${tag}: display director output is identical with the style on or off (same instant)`);
    await hd.page.waitForTimeout(1200); const runHd = await runs(hd.page, clip);
    report[`${tag}_pixel_runs`] = { standard: runStd, hd2d: runHd };
    check(runHd > 0.55 && runHd > runStd + 0.15, `${tag}: the picture is pixelated (identical neighbouring pixels: ${(runHd * 100).toFixed(0)}% vs ${(runStd * 100).toFixed(0)}% in the standard style)`);
    const lbl = await hd.page.evaluate(() => { const e = [...document.querySelectorAll('#labels .lbl')].find((x) => !x.hidden); const cs = getComputedStyle(e); return { fs: cs.fontSize, filter: cs.filter, canvasImg: getComputedStyle(document.querySelector('#scene')).imageRendering }; });
    check(parseFloat(lbl.fs) >= 10 && lbl.filter === 'none', `${tag}: overlay labels stay native HTML text (${lbl.fs}, no filter)`);
    if (!mobile) { await shot(hd.page, 'demo2-hd2d-desktop-full'); await hd.page.evaluate(() => window.__demo2.setView('under')); await hd.page.waitForTimeout(1200); await shot(hd.page, 'demo2-hd2d-desktop-underground'); await hd.page.evaluate(() => window.__demo2.setView('surface')); await hd.page.waitForTimeout(1200); await shot(hd.page, 'demo2-hd2d-desktop-surface'); await hd.page.evaluate(() => window.__demo2.setView('full')); await hd.page.waitForTimeout(600); }
    else await shot(hd.page, 'demo2-hd2d-pixel7-full', 55);
    const target = await hd.page.evaluate(() => { const top = document.querySelector('#top').getBoundingClientRect().bottom; for (const x of window.__demo2.ants().filter((a) => a.realm === 'nest' && !a.moving)) { const p = window.__demo2.screenOf(x.id); if (p && p.x > 40 && p.x < innerWidth - 40 && p.y > top + 30 && p.y < innerHeight - 60) return { id: x.id, ...p }; } return null; });
    if (target) { if (mobile) await hd.page.touchscreen.tap(target.x, target.y - 3); else await hd.page.mouse.click(target.x, target.y - 3); await hd.page.waitForTimeout(500); }
    const sel = await hd.page.evaluate(() => ({ s: window.__demo2.state(), card: document.querySelector('#card').hidden ? '' : document.querySelector('#card').textContent }));
    check(!!target && sel.s.selected !== null && sel.card.includes('引擎個體'), `${tag}: ${mobile ? 'tap' : 'click'} selection works with pixelation on (${sel.s.selected})`);
    await hd.page.evaluate(() => window.__demo2.setRunning(true)); await hd.page.click('#cardFollow'); await hd.page.waitForTimeout(2500);
    const fo = await hd.page.evaluate(() => { const s = window.__demo2.state(), a = window.__demo2.ants().find((x) => x.id === s.following); return { s, a }; });
    check(!!fo.s.following && fo.a && Math.hypot(fo.s.target[0] - fo.a.x, fo.s.target[1] - fo.a.y, fo.s.target[2] - fo.a.z) < 3, `${tag}: follow works in HD-2D (the focus plane is the followed ant)`);
    await shot(hd.page, `demo2-hd2d-${tag}-follow`, mobile ? 55 : 70);
    report[tag] = await hd.page.evaluate(() => { const p = window.__demo2.perf(); return { fps: p.fps_mean, frame_ms_p50: p.frame_ms.p50, calls: p.calls, triangles: p.triangles, quality: p.quality, dpr: p.dpr, measurement_class: p.measurement_class, style: window.__demo2.style().text }; });
    await hd.ctx.close();
    if (!mobile) { // the matching standard follow close-up
      const sf = await open('seed=1&quality=medium', 'standard-follow'); await sf.page.evaluate((id) => window.__demo2.follow(id), fo.s.following); await sf.page.waitForTimeout(2500); await shot(sf.page, 'demo2-std-desktop-follow'); await sf.ctx.close();
    }
  }
  const ctxOpt = { viewport: { width: 1280, height: 800 } }, plain = async (query, name) => { const ctx = await browser.newContext(ctxOpt), page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${name}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name}: ${m.text()}`); }); await page.goto(new URL(`demo2.html?${query}`, base).href); await ready(page); return { ctx, page }; };
  { // the extras follow the engine light state: shafts by day, none at night; the night grade is neutral
    const day = await plain('seed=1&quality=low&style=hd2d&autostart=0', 'day'); await day.page.waitForTimeout(1200); const d = await day.page.evaluate(() => window.__demo2.style()); await day.ctx.close();
    const night = await plain('seed=1&quality=low&style=hd2d&autostart=0&t=7200', 'night'); await night.page.waitForTimeout(1200); const n = await night.page.evaluate(() => window.__demo2.style()); await shot(night.page, 'demo2-hd2d-desktop-night'); await night.ctx.close();
    check(d.light === 'day' && d.scene.shafts === true && n.light === 'night' && n.scene.shafts === false && n.active, `light shafts follow the engine light state (day: shown; night at 02:00: hidden)`);
  }
  { // auto quality: depth of field goes first, then bloom
    const a = await plain('seed=1&style=hd2d', 'auto'); const seen = [];
    for (let i = 0; i < 40; i++) { const s = await a.page.evaluate(() => { const st = window.__demo2.style(), p = window.__demo2.perf(); return { dof: st.fx.dof, bloom: st.fx.bloom, q: p.quality, fps: p.fps_mean }; }); seen.push(s); if (!s.dof && !s.bloom) break; await a.page.waitForTimeout(700); }
    const slow = seen.some((s) => s.fps > 0 && s.fps < 24), order = seen.every((s) => !(s.dof && !s.bloom)), qKept = seen.filter((s) => s.dof || s.bloom).every((s) => s.q === seen[0].q);
    report.auto = { slow, steps: seen.filter((s, i) => i === 0 || s.dof !== seen[i - 1].dof || s.bloom !== seen[i - 1].bloom).map((s) => `${s.dof ? 'dof' : '-'}/${s.bloom ? 'bloom' : '-'}/${s.q}`) };
    if (slow) check(!seen[seen.length - 1].dof && order && qKept && seen.some((s) => !s.dof && s.bloom), `auto quality under a low frame rate drops depth of field first, then bloom, before the quality level (${report.auto.steps.join(' → ')})`);
    else check(seen.every((s) => s.dof && s.bloom), 'frame rate stayed high here: auto quality left the effects on (the drop order is checked in the Node test)');
    const txt = await a.page.evaluate(() => { window.__demo2.openSide('perf'); return new Promise((r) => setTimeout(() => r(document.querySelector('#fxNow').textContent), 500)); });
    check(/作用中的畫面效果/.test(txt), 'the 效能 tab shows the effects that are still active');
    await a.ctx.close();
  }
  { // WebGPU renderer path (node materials on three's WebGL 2 backend here): HD-2D is refused and says so
    const w = await plain('seed=1&quality=low&renderer=webgpu&backend=webgl2&style=hd2d&autostart=0&panel=perf', 'webgpu-path'); await w.page.waitForTimeout(800);
    const r = await w.page.evaluate(() => ({ st: window.__demo2.style(), perf: document.querySelector('#pane-perf').textContent, disabled: document.querySelector('#pane-perf button[data-style="hd2d"]').disabled }));
    check(r.st.renderer !== 'webgl2' && r.st.style === 'standard' && !r.st.active && r.disabled && r.perf.includes('HD-2D 目前僅 WebGL 2'), 'under the WebGPU renderer path the style stays standard and the 效能 tab says 「HD-2D 目前僅 WebGL 2」');
    await w.ctx.close();
  }
  await browser.close();
  check(errors.length === 0, `no page or console errors${errors.length ? ': ' + errors.slice(0, 4).join(' | ') : ''}`);
  console.log(JSON.stringify({ check: 'demo2-hd2d', passed: passed.length, failures, errors, files: files.map((f) => path.basename(f)), report, note: 'software rendering under automation: NOT device results' }, null, 1));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
