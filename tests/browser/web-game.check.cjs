/**
 * V6 Game View (phase 1) browser E2E + frame-rate measurement. Desktop 1280x800 (mouse) and an Android Pixel 7
 * profile (touch). FAILS (exit 1) on any failed check, page error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-game.check.cjs <outDir> http://localhost:8781/
 * Checks: the page opens on the animated garden (not the analysis view); ants appear and move continuously; every drawn
 * ant equals model.poseAt recomputed in the page from the same replay file (engine record / display interpolation);
 * ants in the nest or at unrecorded places are not drawn; pause freezes time, play resumes, speed changes the rate;
 * tap selects an ant (card with engine data), follow keeps it centred; wheel zoom and drag pan; the data-source panel
 * names the three data classes; the analysis link opens the V5 view; no horizontal scroll.
 * Frame rate: mean / p50 / p95 frame interval over a 10 s window while playing, per profile; the Android profile is
 * measured again with 4x CPU throttling as a low-end phone estimate. Desktop unthrottled must reach a 30 fps mean.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'game-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], errors = [], passed = [], fps = {}, shots = [];
  const check = (c, m) => { if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['android', { ...devices['Pixel 7'] }]];
  for (const [tag, opt] of profiles) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage(), touch = tag === 'android';
    page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    const shot = async (n) => { const f = path.join(out, `${tag}-game-${n}.png`); await page.screenshot({ path: f }); shots.push(path.basename(f)); };
    // Issue #191 Q5: on narrow screens (Pixel 7, 412 px) panorama / skip / info / analysis live in the 「更多」 panel
    const more = async () => { if (await page.evaluate(() => window.__game.more().narrow && !window.__game.more().open)) await page.click('#moreBtn'); };
    await page.goto(base);
    await page.waitForFunction(() => window.__game && window.__game.ants().length > 0, null, { timeout: 20000 });
    check(await page.$('#scene') !== null && await page.$('#mode') === null, `${tag}: the start page is the game view (garden canvas), not the analysis view`);
    check((await page.textContent('#badge')).includes('非正式'), `${tag}: the experiment world is labelled 非正式`);
    // ants appear and move continuously (the default playback skips idle stretches)
    await page.waitForFunction(() => window.__game.ants().some((a) => a.vis === 'walking' && a.moving && a.sx !== null), null, { timeout: 20000 });
    const s1 = await page.evaluate(() => window.__game.ants().filter((a) => a.moving && a.sx !== null));
    await page.waitForTimeout(250);
    const s2 = await page.evaluate(() => window.__game.ants());
    const movedOnScreen = s1.some((a) => { const b = s2.find((x) => x.id === a.id); return b && b.sx !== null && Math.hypot(b.sx - a.sx, b.sy - a.sy) > 0.5; });
    check(movedOnScreen, `${tag}: a walking ant moves on screen between two frames 250 ms apart`);
    await shot('01-garden');
    // pause, then compare every ant with poseAt recomputed in the page from the same file
    await page.click('#play');
    const st = await page.evaluate(() => window.__game.state());
    check(st.playing === false, `${tag}: pause stops playback`);
    await page.waitForTimeout(400);
    check((await page.evaluate(() => window.__game.state().t)) === st.t, `${tag}: time does not advance while paused`);
    const cmp = await page.evaluate(async (s) => {
      const m = await import('./dist/model.js'), exp = await (await fetch('data/' + s.world)).json(), pos = m.displayPositions(exp.map.places), d = exp.days[s.day - 1];
      const bad = [];
      for (const a of window.__game.ants()) {
        const p = m.poseAt(d, a.id, s.t, pos);
        if (p.x !== a.x || p.y !== a.y || p.place !== a.place) bad.push(a.id);
        const drawn = a.sx !== null, unknown = a.place.split('>').some((q) => !pos[q] || !pos[q].known);
        if ((a.vis === 'in_nest' || a.vis === 'unknown_place') && drawn) bad.push(a.id + ':drawn-hidden');
        if (unknown && drawn) bad.push(a.id + ':drawn-unknown');
      }
      return { n: window.__game.ants().length, bad };
    }, st);
    check(cmp.n > 0 && cmp.bad.length === 0, `${tag}: all ${cmp.n} ants equal model.poseAt; none drawn in the nest or at an unrecorded place (${cmp.bad.join(',')})`);
    // tap / click a visible ant → card with engine data; follow
    const vis = (await page.evaluate(() => window.__game.ants())).filter((a) => a.sx !== null);
    if (vis.length) {
      const a = vis[0];
      if (touch) await page.touchscreen.tap(a.sx, a.sy); else await page.mouse.click(a.sx, a.sy);
      await page.waitForTimeout(150);
      const card = await page.textContent('#card');
      check(card.includes(a.id) && card.includes('熱帶大頭家蟻') && /引擎紀錄|插值/.test(card), `${tag}: selecting ${a.id} opens its card (engine record / interpolation stated)`);
      await page.click('#followBtn'); await page.click('#play'); await page.waitForTimeout(1200);
      const f = await page.evaluate(() => { const s = window.__game.state(), a = window.__game.ants().find((x) => x.id === s.following); return { s, a }; });
      const centred = f.a && f.a.sx !== null ? Math.hypot(f.a.sx - (touch ? 412 : 1280) / 2, f.a.sy - (touch ? 839 : 800) / 2) : null;
      check(f.s.following === a.id && (centred === null || centred < 120), `${tag}: follow keeps ${a.id} near the centre (offset ${centred === null ? 'in nest/hidden' : centred.toFixed(0) + ' px'})`);
      await shot('02-follow');
      await page.click('#closeCard');
    } else check(false, `${tag}: a visible ant to select`);
    // zoom and pan (mouse wheel / drag; the Android profile also gets a touch drag)
    const s0 = (await page.evaluate(() => window.__game.state())).cam.s;
    await page.mouse.move(300, 400); for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -300);
    await page.waitForTimeout(100);
    const s1c = (await page.evaluate(() => window.__game.state())).cam;
    check(s1c.s > s0, `${tag}: wheel zoom in (${s0.toFixed(2)} → ${s1c.s.toFixed(2)} px/cm)`);
    await page.mouse.move(300, 400); await page.mouse.down(); await page.mouse.move(200, 330, { steps: 5 }); await page.mouse.up();
    const s2c = (await page.evaluate(() => window.__game.state())).cam;
    check(Math.abs(s2c.x - s1c.x) > 0.1 && Math.abs(s2c.y - s1c.y) > 0.1, `${tag}: drag pans the camera`);
    await more(); await page.click('#fit'); await page.waitForTimeout(100);
    // speed: 60× advances ≈ 1 simulated minute per real second (allow wide tolerance; skip off so idle time counts)
    await more(); await page.uncheck('#skip'); await page.selectOption('#speed', '60');
    const ta = (await page.evaluate(() => window.__game.state())).t; await page.waitForTimeout(1000); const tb = (await page.evaluate(() => window.__game.state())).t;
    check(tb - ta > 0.6 && tb - ta < 1.4, `${tag}: 60× advances ≈1 simulated minute per second (${(tb - ta).toFixed(2)})`);
    await more(); await page.check('#skip'); await page.selectOption('#speed', '20');
    // the data-source panel
    await more(); await page.click('#infoBtn'); const about = await page.textContent('#about');
    check(['引擎紀錄', '顯示插值', '示意場景', '非正式'].every((w) => about.includes(w)), `${tag}: data panel names engine record / display interpolation / schematic scene / non-official`);
    await shot('03-about'); await more(); await page.click('#infoBtn');
    check(await page.evaluate(() => { const e = document.querySelector('#bottom #motionTag'); return !!e && e.offsetParent !== null && e.getBoundingClientRect().height > 0 && /頭與觸角動作＝示意動畫（引擎尚未模擬）/.test(e.textContent); }), `${tag}: the persistent bottom legend says head/antenna motion is display-only animation, not simulated`);
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${tag}: no horizontal scroll`);
    // R13-01: play to the end of the replay, then 「重新播放」 must show Day 1 with Day 1's own roster
    { const meta = await page.evaluate(() => window.__game.state());
      const last = await page.evaluate(async (s) => (await (await fetch('data/' + s.world)).json()).days.length, meta);
      await page.evaluate((n) => window.__game.gotoDay(n), last);
      await more(); await page.uncheck('#skip'); await page.selectOption('#speed', '300');
      await page.evaluate(() => { const c = document.getElementById('clock'); c.value = String(Number(c.max) - 0.02); c.dispatchEvent(new Event('input')); });
      if (!(await page.evaluate(() => window.__game.state().playing))) await page.click('#play');
      await page.waitForFunction(() => window.__game.state().ended, null, { timeout: 20000 });
      await page.click('#play'); await page.waitForTimeout(150);
      const after = await page.evaluate(async () => { const s = window.__game.state(), gm = await import('./dist/game-model.js'), exp = await (await fetch('data/' + s.world)).json(); return { day: s.day, ended: s.ended, playing: s.playing, ids: window.__game.ants().map((a) => a.id).sort(), expected: gm.rosterAtStart(exp, 1) }; });
      check(after.day === 1 && !after.ended && after.playing && JSON.stringify(after.ids) === JSON.stringify(after.expected), `${tag}: replay ended → 重新播放 shows Day 1 with Day 1's roster (${after.ids.length}/${after.expected.length} ants)`);
      await more(); await page.check('#skip'); await page.keyboard.press('Escape'); await page.selectOption('#speed', '20'); }
    // frame rate while playing (10 s), then 4× CPU throttling on the Android profile
    const measure = async (label) => { await page.evaluate(() => window.__game.resetFps()); await page.waitForTimeout(10000); fps[label] = await page.evaluate(() => ({ ...window.__game.fps(), low_res: window.__game.state().low_res, canvas_px: window.__game.state().canvas_px })); };
    await measure(`${tag}`);
    if (touch) { const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); await measure(`${tag}-cpu4x`); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); }
    if (tag === 'desktop') check(fps.desktop.fps_mean >= 30, `desktop: mean frame rate ≥ 30 fps while playing (${fps.desktop.fps_mean.toFixed(1)})`);
    await shot('04-playing');
    // analysis mode link
    await more(); await page.click('a.btn[href="analysis.html"]'); await page.waitForFunction(() => document.getElementById('badge') && document.getElementById('badge').textContent.includes('Day14'), null, { timeout: 15000 });
    check(page.url().endsWith('analysis.html'), `${tag}: the analysis link opens the V5 analysis view`);
    await ctx.close();
  }
  await browser.close();
  const summary = { suite: 'web-game (V6 phase 1)', passed: passed.length, failures, errors, fps, screenshots: shots };
  fs.writeFileSync(path.join(out, 'web-game-results.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  process.exit(failures.length || errors.length ? 1 : 0);
})();
