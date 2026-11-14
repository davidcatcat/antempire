/**
 * Three.js 3D prototype (web/three.html; Owner 2026-11-14, #256 / #258) — browser checks (Playwright Chromium; the
 * NON-OFFICIAL P0-A2 experiment world). Desktop 1280×800 and Android Pixel 7 emulation. FAILS (exit 1) on a failed
 * check, a page error or a console error.
 *   npm run web:build && node cli/web-serve.ts 8783 &  node tests/browser/three-demo.check.cjs <outDir> http://localhost:8783/
 * Checks:
 *  - the page loads (three from the local vendor copy) with the labels 原型・非正式 / 示意 / 顯示插值 / 引擎 and draws
 *    the 30 workers of one P0-A2 world;
 *  - follow: the camera target goes to the followed ant and the card names it (engine state + display class);
 *  - gait: a worker walking on the route (display interpolation) advances its gait phase; a worker whose drawn point and
 *    drawn heading stand still does not;
 *  - pause: the world time, the micro-motion clock (uTime) and every gait phase stay frozen;
 *  - phone: no horizontal scroll.
 * Writes three-<profile>-{home,follow}.jpg into <outDir> and prints a JSON report.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'three-shots', base = process.argv[3] || 'http://localhost:8783/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], files = [], report = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', { ...devices['Pixel 7'] }]];
  for (const [tag, opts] of profiles) {
    const ctx = await browser.newContext(opts), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    await page.goto(new URL('three.html?seed=1', base).href);
    await page.waitForFunction(() => window.__three && window.__three.ready && window.__three.state().ants > 0, null, { timeout: 90000 });
    await page.waitForTimeout(1500);
    const st = await page.evaluate(() => ({ s: window.__three.state(), rev: window.__three.three, flag: document.querySelector('#flag').textContent, about: document.querySelector('#about').textContent, mag: document.querySelector('#magLabel').textContent, badge: document.querySelector('#badge').textContent }));
    check(st.s.ants === 30 && st.s.worlds === 1, `${tag}: 30 workers of one P0-A2 world drawn (${st.s.ants})`);
    check(st.rev === '187', `${tag}: three r${st.rev} from the vendor copy`);
    check(st.flag.includes('原型・非正式') && ['引擎', '顯示插值', '示意', '非正式'].every((s) => st.about.includes(s)) && st.mag.includes('位置與路線長度不放大') && st.badge.includes('方向示意'), `${tag}: honesty labels present`);
    const f = (n) => path.join(out, `three-${tag}-${n}.jpg`);
    await page.screenshot({ path: f('home'), type: 'jpeg', quality: 72 }); files.push(f('home'));

    // gait: walking vs standing (two samples while running)
    await page.waitForFunction(() => window.__three.ants().some((a) => a.where === 'route' && a.interpolated), null, { timeout: 60000 });
    const g = await page.evaluate(async () => {
      const T = window.__three, a0 = T.ants(); await new Promise((r) => setTimeout(r, 700)); const a1 = T.ants();
      const res = { walking: 0, walkingAdvanced: 0, standing: 0, standingFrozen: 0, bad: [] };
      for (const p of a0) {
        const q = a1.find((x) => x.key === p.key); if (!q || q.state !== p.state) continue;
        if (p.where === 'route' && p.interpolated && q.interpolated) { res.walking++; if (q.phase > p.phase) res.walkingAdvanced++; else res.bad.push(`${p.key} walking, phase ${p.phase}→${q.phase}`); }
        if (p.x === q.x && p.y === q.y && p.z === q.z && p.drawn_yaw === q.drawn_yaw) { res.standing++; if (q.phase === p.phase) res.standingFrozen++; else res.bad.push(`${p.key} standing, phase ${p.phase}→${q.phase}`); }
      }
      return res;
    });
    check(g.walking > 0 && g.walkingAdvanced === g.walking, `${tag}: walking workers advance their gait phase (${g.walkingAdvanced}/${g.walking})`);
    check(g.standing > 0 && g.standingFrozen === g.standing, `${tag}: standing workers keep their gait phase (${g.standingFrozen}/${g.standing}) ${g.bad.slice(0, 3).join('; ')}`);

    // follow a walking worker
    const fo = await page.evaluate(async () => {
      const T = window.__three, a = T.ants().find((x) => x.where === 'route' && x.interpolated); await T.follow(a.key);
      await new Promise((r) => setTimeout(r, 1500));
      const s = T.state(), b = T.ants().find((x) => x.key === a.key), d = Math.hypot(s.target[0] - b.x, s.target[1] - b.y, s.target[2] - b.z);
      return { key: a.key, id: a.id, following: s.following, d, card: document.querySelector('#card').hidden ? '' : document.querySelector('#card').textContent, who: document.querySelector('#who').value };
    });
    check(fo.following === fo.key && fo.d < 3 && fo.who === fo.key, `${tag}: follow keeps the camera on ${fo.id} (target ${fo.d.toFixed(2)} cm away)`);
    check(fo.card.includes(fo.id) && fo.card.includes('顯示插值') && fo.card.includes('只是畫面'), `${tag}: the card names the followed worker and its display class`);
    await page.screenshot({ path: f('follow'), type: 'jpeg', quality: 72 }); files.push(f('follow'));
    await page.evaluate(() => window.__three.follow(null));

    // pause: world time, micro-motion clock and gait phases frozen
    const pz = await page.evaluate(async () => {
      const T = window.__three; await T.setRunning(false); await new Promise((r) => setTimeout(r, 400));
      const s0 = T.state(), u0 = T.uTime(), p0 = T.ants().map((a) => [a.key, a.phase, a.drawn_yaw]);
      await new Promise((r) => setTimeout(r, 1200));
      const s1 = T.state(), u1 = T.uTime(), p1 = T.ants().map((a) => [a.key, a.phase, a.drawn_yaw]);
      await T.setRunning(true); await new Promise((r) => setTimeout(r, 600)); const u2 = T.uTime();
      return { t0: s0.t, t1: s1.t, u0, u1, u2, same: JSON.stringify(p0) === JSON.stringify(p1), running: s1.running };
    });
    check(!pz.running && pz.t0 === pz.t1, `${tag}: paused world time frozen (${pz.t0})`);
    check(pz.u0 === pz.u1 && pz.u2 > pz.u1, `${tag}: uTime frozen while paused (${pz.u0}), runs again on resume (${pz.u2})`);
    check(pz.same, `${tag}: gait phases and drawn headings frozen while paused`);

    const sc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, bw: document.body.scrollWidth, w: innerWidth }));
    check(sc.sw <= sc.w && sc.bw <= sc.w, `${tag}: no horizontal scroll (${sc.sw}/${sc.bw} ≤ ${sc.w})`);
    report[tag] = { gait: { walking: g.walking, standing: g.standing }, follow: fo.id, pause: pz };
    await ctx.close();
  }
  await browser.close();
  for (const e of errors) check(false, `no page / console error: ${e}`);
  console.log(JSON.stringify({ check: 'three-demo', passed: passed.length, failures, files, report }, null, 1));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
