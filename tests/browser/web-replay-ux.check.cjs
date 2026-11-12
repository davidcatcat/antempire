/**
 * V6 Game View replay navigation (Issue #148) browser E2E. Desktop 1280x800 (mouse, keyboard) and a 400px-wide phone
 * (touch, DPR 2). FAILS (exit 1) on any failed check, page error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-replay-ux.check.cjs <outDir> http://localhost:8781/
 * Checks: the walk marks under the slider equal walkIntervals of the day (recomputed in the page from the same replay
 * file) and are labelled as engine records; 「下一段活動」 (button, and key N on desktop) lands where the pure
 * nextActivityJump says, before the walk start, with no walk start skipped; at the end of the day's walks it says so and
 * does not move; tapping / dragging the marks strip scrubs the viewing minute; the day-summary mode hides the canvas
 * and clock, shows 「日摘要，非連續播放」, lists minute-less events only as day-level, does not advance time, and
 * returning restores the previous playback day, minute and play state; touch targets ≥ 44 px; no horizontal scroll.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

(async () => {
  const out = process.argv[2] || 'replay-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], errors = [], passed = [], shots = [];
  const check = (c, m) => { if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['phone400', { viewport: { width: 400, height: 860 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]];
  for (const [tag, opt] of profiles) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage(), touch = tag !== 'desktop';
    page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    const shot = async (n) => { const f = path.join(out, `${tag}-replay-${n}.png`); await page.screenshot({ path: f }); shots.push(path.basename(f)); };
    const tap = async (sel) => { if (touch) await page.tap(sel); else await page.click(sel); };
    const state = () => page.evaluate(() => window.__game.state());
    await page.goto(base);
    await page.waitForFunction(() => window.__game && window.__game.ants().length > 0 && document.querySelectorAll('#marks i').length > 0, null, { timeout: 20000 });
    // 0. opening framing (integration-3): the nest is inside the unobscured canvas band (between the top bar and the
    //    bottom control panel), and while the opening plays at least one ant is drawn inside that band (ants().sx is
    //    null for ants under the bars or off screen)
    const vw = await page.evaluate(() => window.__game.view());
    check(vw.home && vw.nest && vw.nest[0] >= 0 && vw.nest[0] <= vw.w && vw.nest[1] >= vw.top && vw.nest[1] <= vw.bottom, `${tag}: opening view frames the nest inside the unobscured canvas band (nest ${vw.nest && vw.nest.map((v) => v.toFixed(0))}, band y ${vw.top.toFixed(0)}–${vw.bottom.toFixed(0)})`);
    const seen = await page.waitForFunction(() => window.__game.ants().some((a) => a.sx !== null && (a.vis === 'walking' || a.vis === 'at_site')), null, { timeout: 8000 }).then(() => true, () => false);
    check(seen, `${tag}: during the opening an ant is drawn inside the unobscured canvas band (not under the controls)`);
    // 0b. ground tiling: no one-pixel line across the canvas (the chunk-seam gap row seen at 1280×800 before the fix):
    //     no canvas row where ≥ 30% of the columns step sharply against the rows two pixels above and below
    const lines = await page.evaluate(() => {
      const c = document.getElementById('scene'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w = c.width, H = c.height;
      const lum = (x, y) => { const i = (y * w + x) * 4; return 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; }, out = [];
      for (let y = 2; y < H - 2; y++) { let n = 0, m = 0; for (let x = 0; x < w; x += 2, m++) if (Math.abs(lum(x, y) - (lum(x, y - 2) + lum(x, y + 2)) / 2) > 18) n++; if (n > m * 0.3) out.push(y); }
      return out;
    });
    check(lines.length === 0, `${tag}: no horizontal line artefact across the scene (rows ${lines.join(',') || 'none'})`);
    // pause so time is under test control
    if ((await state()).playing) await tap('#play');
    // 1. marks = walkIntervals of the day
    const mk = await page.evaluate(async () => {
      const s = window.__game.state(), gm = await import('./dist/game-model.js'), m = await import('./dist/model.js'), exp = await (await fetch('data/' + s.world)).json(), d = exp.days[s.day - 1];
      const w = gm.walkIntervals(d), win = m.windowOf(d), el = [...document.querySelectorAll('#marks i')];
      const bad = el.filter((e, i) => Number(e.dataset.start) !== w[i].start || Number(e.dataset.end) !== w[i].end || Math.abs(parseFloat(e.style.left) - (w[i].start / win) * 100) > 1e-3).length;
      return { n: el.length, w: w.length, bad, title: document.getElementById('marks').title, legend: document.querySelector('.marks-legend').textContent };
    });
    check(mk.n === mk.w && mk.bad === 0, `${tag}: ${mk.n} walk marks = walkIntervals of the day (${mk.w}), positions = start/window`);
    check(/引擎紀錄/.test(mk.title) && /引擎紀錄/.test(mk.legend), `${tag}: the marks are labelled as engine records (legend + tooltip)`);
    // 2. next-activity jump (button; key N on desktop) vs the pure function; no walk start skipped
    const press = async (how) => {
      const before = await state();
      if (how === 'key') { await page.locator('#scene').focus().catch(() => {}); await page.keyboard.press('n'); } else await tap('#nextAct');
      await page.waitForTimeout(80);
      const after = await state();
      const exp = await page.evaluate(async ([b]) => { const r = await import('./dist/replay-ux.js'), gm = await import('./dist/game-model.js'), d = (await (await fetch('data/' + b.world)).json()).days[b.day - 1], w = gm.walkIntervals(d); return { r: r.nextActivityJump(w, d, b.t), skipped: w.filter((x) => x.start > b.t && x.start < (r.nextActivityJump(w, d, b.t).target ?? -1)).length }; }, [before]);
      return { before, after, exp };
    };
    let okJumps = 0, n = 0;
    for (const how of touch ? ['tap', 'tap', 'tap'] : ['click', 'key', 'click', 'key']) {
      const p = await press(how); n++;
      if (p.exp.r.kind === 'jump' && Math.abs(p.after.t - p.exp.r.target) < 1e-9 && p.after.t <= p.exp.r.walkStart && p.exp.skipped === 0 && !p.after.playing) okJumps++;
    }
    check(okJumps === n, `${tag}: ${okJumps}/${n} next-activity jumps (${touch ? 'tap' : 'button + key N'}) land at nextActivityJump's target before the walk start, skipping no walk start`);
    await page.waitForTimeout(150);
    check((await page.textContent('#toast')).includes('引擎紀錄的行走'), `${tag}: the jump toast names the engine-recorded walk`);
    await shot('01-marks-jump');
    // after the day's last walk start: says so, does not move
    const lastT = await page.evaluate(async () => { const s = window.__game.state(), gm = await import('./dist/game-model.js'), d = (await (await fetch('data/' + s.world)).json()).days[s.day - 1]; const w = gm.walkIntervals(d); return Math.max(...w.map((x) => x.start)) + 0.001; });
    await page.evaluate((v) => { const c = document.getElementById('clock'); c.value = String(v); c.dispatchEvent(new Event('input')); }, lastT);
    const t0 = (await state()).t; await tap('#nextAct'); await page.waitForTimeout(100);
    check((await state()).t === t0 && (await page.textContent('#toast')).includes('沒有記錄任何行走開始'), `${tag}: no later walk start → says so and does not move`);
    // 3. scrub on the marks strip (tap / click)
    const box = await page.locator('#marks').boundingBox();
    if (touch) await page.touchscreen.tap(box.x + box.width * 0.25, box.y + box.height / 2); else await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.waitForTimeout(80);
    const sc = await state(), win = await page.evaluate(() => Number(document.getElementById('clock').max));
    check(Math.abs(sc.t - win * 0.25) < win * 0.01, `${tag}: tapping the marks strip at 25% moves the viewing minute to ≈${(win * 0.25).toFixed(0)} (${sc.t.toFixed(1)})`);
    // touch target sizes and layout
    const sizes = await page.evaluate(() => ['nextAct', 'modeBtn'].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, r.width, r.height]; }));
    check(sizes.every(([, w, h]) => w >= 44 && h >= 44), `${tag}: new controls are ≥44 px touch targets (${sizes.map((s) => `${s[0]} ${s[1].toFixed(0)}×${s[2].toFixed(0)}`).join(', ')})`);
    if (touch) { const ch = await page.evaluate(() => [document.getElementById('clock').getBoundingClientRect().height, document.getElementById('marks').getBoundingClientRect().height]); check(ch[0] >= 44 && ch[1] >= 20, `${tag}: slider ${ch[0].toFixed(0)} px and marks strip ${ch[1].toFixed(0)} px tall for touch`); }
    check(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.getElementById('bottom').scrollWidth <= window.innerWidth + 1), `${tag}: no horizontal scroll`);
    // 4. day summary mode
    // play slowly (1×, idle skip off) from ≈90 min so the restored position is a mid-day minute, not a skip landing
    await page.uncheck('#skip'); await page.selectOption('#speed', '1'); await tap('#play'); await page.waitForTimeout(300);
    const pre = await state();
    check(pre.playing && pre.t > 89 && pre.t < 95, `${tag}: playing at a mid-day minute before the summary (${pre.t.toFixed(3)})`);
    await tap('#modeBtn'); await page.waitForTimeout(150);
    const sm = await page.evaluate(() => ({ s: window.__game.state(), text: document.getElementById('summary').textContent, vis: !document.getElementById('summary').hidden, canvas: getComputedStyle(document.getElementById('scene')).visibility, clock: getComputedStyle(document.getElementById('timeline')).display, play: getComputedStyle(document.getElementById('play')).display }));
    check(sm.s.mode === 'summary' && sm.vis && sm.text.includes('日摘要，非連續播放'), `${tag}: summary mode shows 「日摘要，非連續播放」`);
    check(sm.canvas === 'hidden' && sm.clock === 'none' && sm.play === 'none' && !sm.s.playing, `${tag}: summary mode hides the canvas, clock and play control and stops playback`);
    await page.waitForTimeout(500);
    check((await state()).t === sm.s.t, `${tag}: time does not advance in summary mode`);
    const cls = await page.evaluate(async () => {
      const s = window.__game.state(), m = await import('./dist/model.js'), d = (await (await fetch('data/' + s.world)).json()).days[s.day - 1];
      const untimed = d.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step' && !m.isTimed(e)).length;
      const listed = [...document.querySelectorAll('#summary details li')].filter((li) => !li.classList.contains('muted')).length;
      const more = [...document.querySelectorAll('#summary details li.muted')].reduce((a, li) => a + Number((li.textContent.match(/\d+/) || [0])[0]), 0);
      return { untimed, listed: listed + more, heading: document.getElementById('summary').textContent.includes('不放在任何時間點') };
    });
    check(cls.untimed === cls.listed && cls.heading, `${tag}: all ${cls.untimed} minute-less events are listed as day-level (not at a time)`);
    await page.evaluate(() => { const d = document.querySelector('#summary details'); if (d) d.open = true; });
    await shot('02-summary');
    await tap('#nextDay'); await page.waitForTimeout(100);
    check((await state()).day === pre.day + 1 && (await page.textContent('#summary')).includes(`第 ${pre.day + 1} 日`), `${tag}: day buttons browse summaries`);
    await tap('#modeBtn'); await page.waitForTimeout(60);
    const back = await state();
    check(back.mode === 'playback' && back.day === pre.day && Math.abs(back.t - pre.t) < 0.05 && back.playing === pre.playing, `${tag}: returning to playback restores day ${pre.day}, minute ≈${pre.t.toFixed(2)} and play state (${back.day}, ${back.t.toFixed(2)}, ${back.playing})`);
    check(await page.evaluate(() => getComputedStyle(document.getElementById('scene')).visibility === 'visible' && document.getElementById('summary').hidden), `${tag}: the canvas is back and the summary panel hidden`);
    // paused case: the restored play state stays paused
    await tap('#play'); const p2 = await state(); await tap('#modeBtn'); await page.waitForTimeout(200); await tap('#modeBtn'); await page.waitForTimeout(100);
    const b2 = await state();
    check(!p2.playing && !b2.playing && b2.t === p2.t && b2.day === p2.day, `${tag}: paused → summary → back keeps the exact minute ${p2.t.toFixed(3)} and stays paused`);
    await page.check('#skip'); await page.selectOption('#speed', '20');
    await ctx.close();
  }
  await browser.close();
  const summary = { suite: 'web-replay-ux (V6 replay navigation, #148)', passed: passed.length, failures, errors, screenshots: shots, checks: passed };
  fs.writeFileSync(path.join(out, 'web-replay-ux-results.json'), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  process.exit(failures.length || errors.length ? 1 : 0);
})();
