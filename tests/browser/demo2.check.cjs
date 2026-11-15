/**
 * Demo 2 (web/demo2.html; Owner brief 2026-11-15) — browser checks (Playwright Chromium; the NON-OFFICIAL P0-A2
 * experiment world). Desktop 1440×900 and Android Pixel 7 emulation (touch). FAILS (exit 1) on a failed check, a page
 * error or a console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - the page loads (three and the nest layout from the local vendor copy), shows the non-official / mode badges and
 *    draws the 30 engine workers, some on the surface and some underground, plus the 8 engine larvae;
 *  - natural mode draws no queen / major / egg / pupa and labels them 「尚未模擬」; 展示情境 adds the labelled demo
 *    individuals and the badge; switching back removes them; engine workers are the same in both;
 *  - view buttons (完整剖面／地表／地下) move the camera; tap / click selects an ant and shows its card; 跟隨 keeps the
 *    camera on it;
 *  - one worker is followed through a FULL trip with step_until (scheduling only): chamber → tunnel → entrance →
 *    surface → source → back to the entrance → nest, the same id throughout, the drawn point continuous (bounded
 *    step) except the listed engine-defined discontinuity, every underground point inside the cavity;
 *  - pause freezes the world time, the micro-motion clock and every drawn point;
 *  - save → reload → the same world continues from the saved instant (SAVE-2 session; desktop);
 *  - labels never overlap each other and stay on screen; the status line is not clipped; soil reaches the bottom edge;
 *    with the panel open no scene label lies under it;
 *  - phone: no horizontal scroll; short labels with ※ + legend; legible ants at the default portrait framing; the panel
 *    opens as a bottom sheet (the phone layout itself is checked by demo2-ui.check.cjs).
 * Writes demo2-<profile>-*.jpg (and, with DEMO2_VIDEO=1, demo2-desktop-follow.webm) into <outDir>; prints a JSON
 * report (performance numbers are software-rendered: NOT device results).
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], files = [], report = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch();
  const ready = (page) => page.waitForFunction(() => window.__demo2 && window.__demo2.ready && window.__demo2.state().ants > 0, null, { timeout: 120000 });
  const S = (page) => page.evaluate(() => window.__demo2.state());
  const shot = async (page, name, q = name.includes('pixel7') ? 55 : 70) => { const f = path.join(out, `${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: q }); files.push(f); };
  const profiles = [['desktop', { viewport: { width: 1440, height: 900 } }], ['pixel7', { ...devices['Pixel 7'] }]];
  for (const [tag, opts] of profiles) {
    const mobile = tag === 'pixel7';
    const ctx = await browser.newContext(opts), page = await ctx.newPage();
    // phones keep 展示情境／跟隨／面板 in the 更多 menu (one compact control row); wide screens have them in the bar
    const bar = async (sel) => { if (mobile) await page.click('#moreBtn'); await page.click(sel); };
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    await page.goto(new URL(`demo2.html?seed=1&quality=${mobile ? 'medium' : 'high'}&speed=5`, base).href);
    await ready(page); await page.waitForTimeout(2500);
    let st = await S(page);
    const ants = await page.evaluate(() => window.__demo2.ants());
    check(st.ants === 30 && st.hi + st.lo === 30 && st.larvae === 8, `${tag}: 30 engine workers and 8 engine larvae drawn (${st.ants}, ${st.larvae})`);
    check(ants.some((a) => a.realm === 'surface') && ants.some((a) => a.realm === 'nest'), `${tag}: workers on the surface (${ants.filter((a) => a.realm === 'surface').length}) and underground (${ants.filter((a) => a.realm === 'nest').length}) in one scene`);
    const txt = await page.evaluate(() => ({ flag: document.querySelector('#flag').textContent, badge: document.querySelector('#modeBadge').textContent, labels: document.querySelector('#labels').textContent, hud: document.querySelector('#hud').textContent, backend: window.__demo2.backend(), rev: window.__demo2.three, noScroll: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth }));
    check(txt.flag.includes('非正式實驗世界') && txt.badge.includes('自然模式') && (mobile || txt.hud.includes('非正式')), `${tag}: non-official and natural-mode badges`);
    check(txt.rev === '187' && txt.backend.includes('WebGL 2') && txt.backend.includes('WebGPU'), `${tag}: backend string shown (${txt.backend.slice(0, 40)}…)`);
    check(txt.noScroll, `${tag}: no horizontal scroll`);
    // the Worker build decides: plain P0-A2 (no queens / majors / eggs / pupae) or the candidate world p0a2-colony (engine individuals)
    const col = await page.evaluate(() => { const c = window.__demo2.frame().colony; return c ? { q: c.queens.length, m: c.majors.length, e: c.eggs.length, p: c.pupae.length } : null; });
    report[`${tag}_world`] = col ? { kind: 'p0a2-colony', ...col } : { kind: 'p0a2' };
    // wide screens: the full wording in the scene labels; narrow screens: short labels with ※ and a one-line legend that explains it
    const legendTxt = await page.evaluate(() => { const e = document.querySelector('#lblLegend'); return e.hidden ? '' : e.textContent; });
    const wording = mobile ? /后 \d+※/.test(txt.labels) && /大工蟻 \d+※/.test(txt.labels) && /蛹 \d+※/.test(txt.labels) && legendTxt.includes('※＝引擎個體，生理與行為尚未模擬') && !txt.labels.includes('（引擎個體；') : /蟻后 \d+（引擎個體；生理與行為尚未模擬）/.test(txt.labels) && /大工蟻（大頭） \d+（引擎個體；生理與行為尚未模擬）/.test(txt.labels) && legendTxt === '';
    if (!col) check(st.queens === 0 && st.majors === 0 && st.eggs === 0 && st.pupae === 0 && /蟻后：尚未模擬/.test(txt.labels) && /蛹：尚未模擬/.test(txt.labels) && /大工蟻：尚未模擬/.test(txt.labels) && txt.labels.includes('展示假設'), `${tag}: natural mode draws no queen / major / egg / pupa and labels them 尚未模擬`);
    else check(st.queens === col.q && st.majors === col.m && st.eggs === col.e && st.pupae === col.p && wording && !/蟻后：尚未模擬/.test(txt.labels) && !/示範資料/.test(txt.labels) && txt.labels.includes('展示假設'), `${tag}: natural mode draws the candidate world's ENGINE queens / majors / eggs / pupae (${JSON.stringify(col)}), labelled 引擎`);
    await shot(page, `demo2-${tag}-full`);
    // framing: the whole nest is on screen in the default view (every chamber centre and both chamber ends project inside the canvas)
    const framed = async () => page.evaluate(() => { const V = window.__demo2.nestOnScreen(); return V; });
    const fr0 = await framed();
    // labels: none overlaps another, all inside the screen; status line not clipped; soil down to the bottom edge
    const lay = async (what) => { const L = await page.evaluate(() => { const D = window.__demo2, r = D.labelRects(), hud = document.querySelector('#hud'), hb = hud.getBoundingClientRect(), top = document.querySelector('#top').getBoundingClientRect(); let over = []; for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) if (r[i].left < r[j].left + r[j].w && r[j].left < r[i].left + r[i].w && r[i].top < r[j].top + r[j].h && r[j].top < r[i].top + r[i].h) over.push(`${r[i].text} × ${r[j].text}`); return { n: r.length, over, out: r.filter((x) => x.left < 0 || x.left + x.w > innerWidth + 0.5 || x.top < top.bottom - 0.5 || x.top + x.h > innerHeight + 0.5).map((x) => x.text), keys: r.map((x) => x.key), maxLines: Math.max(...r.map((x) => Math.round(x.h / 15))), hudClip: hud.scrollWidth > hud.clientWidth + 1 || hud.scrollHeight > hud.clientHeight + 1 || hb.right > innerWidth + 0.5 || hb.bottom > top.bottom + 0.5, hud: hud.textContent, soil: D.soilAtBottom(), px: D.antPx() }; });
      check(L.n >= 4 && L.over.length === 0 && L.out.length === 0, `${tag}: ${what} — ${L.n} labels, none overlapping, all on screen (${JSON.stringify(L.over.concat(L.out))})`);
      check(!L.hudClip && L.hud.length > 20, `${tag}: ${what} — the status line is not clipped (「${L.hud.slice(-18)}」)`);
      check(L.soil, `${tag}: ${what} — soil down to the bottom edge of the scene (no void)`);
      return L; };
    const L0 = await lay('完整剖面');
    if (mobile) check(L0.keys.includes('entrance') && L0.px >= 18 && L0.maxLines <= 1 && /左右拖曳/.test(await page.textContent('#lblLegend')), `${tag}: 完整剖面 (portrait) shows the entrance with legible ants (${L0.px.toFixed(0)} px long), one-line labels, and says the nest can be dragged sideways`);
    else check(fr0.inside, `${tag}: 完整剖面 frames the whole nest (${JSON.stringify(fr0.box)})`);
    if (col) { // an ENGINE queen of the candidate world: selectable, with its own 尚未模擬 list and the assumption label
      const qid = await page.evaluate(() => window.__demo2.frame().colony.queens[0].id);
      const qp = await page.evaluate((id) => window.__demo2.screenOf(id), qid);
      if (mobile) await page.touchscreen.tap(qp.x, qp.y); else await page.mouse.click(qp.x, qp.y);
      await page.waitForTimeout(500);
      const qc = await page.evaluate(() => ({ sel: window.__demo2.state().selected, card: document.querySelector('#card').hidden ? '' : document.querySelector('#card').textContent, n: document.querySelectorAll('#card li').length, ns: window.__demo2.frame().colony.queens[0].not_simulated.length }));
      check(qc.card.includes('引擎個體') && qc.card.includes('情境假設') && qc.card.includes('尚未模擬') && qc.n > 0 && !qc.card.includes('示範資料') && /^(q|m|e|p)\d+/.test(qc.sel || ''), `${tag}: ${mobile ? 'tap' : 'click'} on an engine queen selects a colony individual (${qc.sel}) and its card lists what is 尚未模擬 (${qc.n} items)`);
      await page.evaluate((id) => window.__demo2.select(id), qid); await page.waitForTimeout(300);
      const q2 = await page.evaluate(() => ({ n: document.querySelectorAll('#card li').length, ns: window.__demo2.frame().colony.queens[0].not_simulated.length, t: document.querySelector('#card').textContent }));
      check(q2.n === q2.ns && q2.t.includes('蟻后'), `${tag}: the queen's card shows exactly its engine not_simulated list (${q2.n} = ${q2.ns})`);
      if (!mobile) { await page.evaluate(() => window.__demo2.view([4, -27.5, 26], [1, -28.6, 0])); await page.waitForTimeout(900); }
      await shot(page, `demo2-${tag}-engine-queen`);
      await page.evaluate(() => { window.__demo2.select(null); window.__demo2.setView('full'); }); await page.waitForTimeout(300);
    }

    // views
    const cam0 = st.cam;
    await page.click('#viewSurface'); await page.waitForTimeout(1600); const vs = await S(page);
    check(vs.view === 'surface' && vs.cam[1] > cam0[1] + 20 && await page.getAttribute('#viewSurface', 'aria-pressed') === 'true', `${tag}: 地表 view (camera rises to ${vs.cam[1].toFixed(0)} cm)`);
    await shot(page, `demo2-${tag}-surface`);
    await page.click('#viewUnder'); await page.waitForTimeout(1600); const vu = await S(page);
    check(vu.view === 'under' && (mobile || vu.target[1] < -10) && Math.abs(vu.cam[1] - vu.target[1]) < 40, // portrait: the target is set by the fit-to-nest framing (checked below)
      `${tag}: 地下 view (level, target y ${vu.target[1].toFixed(0)})`);
    await shot(page, `demo2-${tag}-underground`);
    const fr1 = await framed(), L1 = await lay('地下');
    if (mobile) check(L1.px >= 18 && L1.keys.includes('ch-A'), `${tag}: 地下 (portrait) shows the entry chamber with legible ants (${L1.px.toFixed(0)} px)`); else check(fr1.inside, `${tag}: 地下 frames the whole nest (${JSON.stringify(fr1.box)})`);

    // 展示情境 toggle
    await bar('#modeBtn'); await page.waitForTimeout(900);
    const dm = await page.evaluate(() => ({ s: window.__demo2.state(), badge: document.querySelector('#modeBadge').textContent, labels: document.querySelector('#labels').textContent, r: window.__demo2.roster(), demoClass: document.body.classList.contains('demo') }));
    check(dm.s.mode === 'demo' && dm.badge === '展示情境・示範資料' && dm.demoClass && (col ? dm.s.queens === col.q && dm.s.majors === col.m && dm.s.eggs === col.e && dm.s.pupae === col.p && dm.r.individuals.every((x) => x.source === 'engine') : dm.s.queens === 2 && dm.s.majors === 4 && dm.s.eggs === 36 && dm.s.pupae === 9) && /示範/.test(dm.labels), `${tag}: 展示情境 badge and labelled demo individuals (queens ${dm.s.queens}, majors ${dm.s.majors}, eggs ${dm.s.eggs}, pupae ${dm.s.pupae})`);
    check(dm.s.ants === 30 && dm.r.counts.minor.engine === 30 && dm.r.counts.minor.demo === 0 && dm.r.individuals.filter((x) => x.source === 'demo').every((x) => x.id.startsWith('demo-')), `${tag}: the 30 engine workers are unchanged in 展示情境`);
    await shot(page, `demo2-${tag}-scenario`);
    if (!mobile) { await page.evaluate(() => window.__demo2.view([4, -27.5, 24], [1, -28.6, 0])); await page.waitForTimeout(900); await shot(page, 'demo2-desktop-scenario-queens'); await page.evaluate(() => window.__demo2.setView('under')); }
    await bar('#modeBtn'); await page.waitForTimeout(600);
    const nm = await S(page);
    check(nm.mode === 'natural' && (col ? nm.queens === col.q : nm.queens === 0 && nm.majors === 0 && nm.eggs === 0 && nm.pupae === 0) && (await page.textContent('#modeBadge')).includes('自然模式'), `${tag}: back to natural mode: no demo individual left`);

    // select by tap / click, card, follow
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(500);
    const target = await page.evaluate(() => { const a = window.__demo2.ants().filter((x) => x.realm === 'nest' && !x.moving); for (const x of a) { const p = window.__demo2.screenOf(x.id); if (p && p.x > 60 && p.x < innerWidth - 60 && p.y > 170 && p.y < innerHeight - 60) return { id: x.id, ...p }; } return null; });
    check(!!target, `${tag}: an underground worker is on screen to tap`);
    if (target) {
      if (mobile) await page.touchscreen.tap(target.x, target.y - 4); else await page.mouse.click(target.x, target.y - 4);
      await page.waitForTimeout(500);
      const sel = await page.evaluate(() => ({ s: window.__demo2.state(), card: document.querySelector('#card').hidden ? '' : document.querySelector('#card').textContent }));
      check(sel.s.selected !== null && sel.card.includes('引擎個體') && sel.card.includes('引擎狀態') && sel.card.includes('展示假設'), `${tag}: ${mobile ? 'tap' : 'click'} selects a worker and shows its card with data-category labels (${sel.s.selected})`);
      await page.click('#cardFollow'); await page.waitForTimeout(1800);
      const fo = await page.evaluate(() => { const s = window.__demo2.state(), a = window.__demo2.ants().find((x) => x.id === s.following); return { s, a }; });
      check(fo.s.following === fo.s.selected && fo.a && Math.hypot(fo.s.target[0] - fo.a.x, fo.s.target[1] - fo.a.y, fo.s.target[2] - fo.a.z) < 2.5, `${tag}: 跟隨 keeps the camera target on the worker`);
      await shot(page, `demo2-${tag}-follow`);
      await page.evaluate(() => window.__demo2.follow(null));
    }

    // pause freezes time, micro-motion and every drawn point
    const p1 = await page.evaluate(() => ({ s: window.__demo2.state(), a: window.__demo2.ants().map((x) => [x.id, x.x, x.y, x.z, x.phase]) }));
    await page.waitForTimeout(900);
    const p2 = await page.evaluate(() => ({ s: window.__demo2.state(), a: window.__demo2.ants().map((x) => [x.id, x.x, x.y, x.z, x.phase]) }));
    check(!p2.s.running && p2.s.t === p1.s.t && p2.s.uTime === p1.s.uTime && JSON.stringify(p2.a) === JSON.stringify(p1.a) && (await page.textContent('#play')).includes('繼續'), `${tag}: paused — world time, micro-motion clock and every drawn point frozen`);

    // panel
    await bar('#sideBtn'); await page.waitForTimeout(500);
    const pane = await page.evaluate(() => ({ stats: document.querySelector('#pane-stats').textContent, box: document.querySelector('#side').getBoundingClientRect().toJSON(), w: innerWidth, h: innerHeight }));
    check(['引擎', '示範資料', '尚未模擬', '小工蟻', '巢內休息'].every((s) => pane.stats.includes(s)) && (mobile ? pane.box.width >= pane.w - 2 && pane.box.bottom >= pane.h - 2 : pane.box.width < 400), `${tag}: stats panel (engine vs demo counts, states)${mobile ? ' as a bottom sheet' : ''}`);
    await page.waitForTimeout(600);
    const under = await page.evaluate(() => { const side = document.querySelector('#side').getBoundingClientRect(), r = window.__demo2.labelRects(), lg = document.querySelector('#lblLegend'), lb = lg.hidden ? null : lg.getBoundingClientRect(); return { n: r.length, hidden: r.filter((x) => x.top + x.h > side.top + 0.5 && x.left + x.w > side.left && x.left < side.right).map((x) => x.text), legendUnder: !!lb && lb.bottom > side.top + 0.5 && innerWidth < 760, opaque: getComputedStyle(document.querySelector('#side')).backgroundColor }; });
    check(under.hidden.length === 0 && !under.legendUnder && /^rgb\(/.test(under.opaque), `${tag}: with the panel open no scene label lies under it (${JSON.stringify(under.hidden)}); the panel is opaque (${under.opaque})`);
    await shot(page, `demo2-${tag}-panel`);
    for (const t of ['legend', 'notsim', 'perf']) await page.click(`#tabs button[data-tab="${t}"]`);
    const panes = await page.evaluate(() => ({ legend: document.querySelector('#pane-legend').textContent, ns: document.querySelector('#pane-notsim').textContent, perf: document.querySelector('#pane-perf').textContent }));
    check(['引擎', '顯示插值', '展示假設', '示範資料', '費洛蒙：尚未模擬', 'R290'].every((s) => panes.legend.includes(s)) && /尚未模擬（未接入）\d+ 項/.test(panes.ns) && panes.ns.includes('蟻后') && panes.perf.includes('WebGL 2') && panes.perf.includes('NOT a device result'), `${tag}: legend, the world's own 尚未模擬 list, and the performance panel`);
    await bar('#sideBtn');
    report[tag] = { perf: await page.evaluate(() => window.__demo2.perf()), viewport: await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio })) };

    // one worker followed through a full trip (desktop; scheduling only: step_until while paused)
    if (!mobile) {
      const STEP = 1, LIMIT = 1500;
      const trip = await page.evaluate(async ({ STEP, LIMIT }) => {
        const D = window.__demo2; D.setRender(false); const f0 = D.frame(), v = f0.layout.source_distance_cm / f0.layout.travel_s, bound = 4.5 * v * STEP + 0.05;
        let t = f0.t_sim, id = null, prev = null, phase = 0, maxStep = 0, bad = [], soil = 0, listed = 0, realms = [], n = 0, feeding = false;
        for (let i = 0; i < LIMIT; i++) {
          t += STEP; await D.stepUntil(t); const s = D.sampleNow();
          if (!id) { const c = D.frame().workers.find((w) => w.state === 'to_entrance' && w.route); if (!c) continue; id = c.id; D.follow(id); }
          const a = s.ants.find((x) => x.id === id); if (!a) { bad.push('lost'); break; } n++;
          if (a.realm === 'nest' && a.absorbed === 0 && !(D.sdf(a.x, a.y + 0.3) < 0)) soil++;
          if (prev) { const j = Math.hypot(a.x - prev.x, a.y - prev.y, a.z - prev.z); if (j > bound) { if (prev.state === 'searching' && a.state !== 'searching') listed++; else bad.push(`${prev.state}->${a.state} ${j.toFixed(2)}cm`); } else maxStep = Math.max(maxStep, j); }
          if (realms[realms.length - 1] !== a.realm) realms.push(a.realm);
          if (a.state === 'feeding') feeding = true;
          if (phase === 0 && a.realm === 'surface') phase = 1; else if (phase === 1 && a.realm === 'nest') phase = 2; else if (phase >= 2 && ++phase > 40) { prev = a; break; } // 40 s more inside the nest, then stop
          prev = a;
        }
        D.setRender(true); return { id, n, maxStep, bound, bad, soil, listed, realms, feeding, t, done: phase > 2, state: D.state() };
      }, { STEP, LIMIT });
      check(trip.id && trip.done && trip.realms.join('>').startsWith('nest>surface>nest'), `desktop: worker ${trip.id} followed through a full trip, same id (${trip.realms.join(' → ')}; ${trip.n} samples${trip.feeding ? '; fed at the source' : ''})`);
      check(trip.bad.length === 0 && trip.soil === 0, `desktop: its drawn point is continuous through the entrance both ways (max step ${trip.maxStep.toFixed(2)} cm ≤ ${trip.bound.toFixed(2)} cm per ${STEP} s; listed jumps ${trip.listed}; unlisted ${JSON.stringify(trip.bad)}) and never inside the soil`);
      check(trip.state.following === trip.id && trip.state.followed, `desktop: the follow camera stayed on ${trip.id} (and the Worker sends its record: observation only)`);
      report.trip = trip; delete report.trip.state;
      await page.waitForTimeout(600); await shot(page, 'demo2-desktop-follow-home');
      // a running close-up for the video / motion check
      await page.evaluate(() => { window.__demo2.setSpeed(2); return window.__demo2.setRunning(true); });
      const g1 = await page.evaluate(() => window.__demo2.ants().filter((a) => a.moving).map((a) => [a.id, a.phase]));
      await page.waitForTimeout(2500);
      const g2 = await page.evaluate(() => Object.fromEntries(window.__demo2.ants().map((a) => [a.id, [a.phase, a.moving]])));
      check(g1.length > 0 && g1.some(([id, ph]) => g2[id] && g2[id][0] !== ph), 'desktop: walking workers advance their gait phase while running');
    }
    await ctx.close();
  }
  // optional short clip (DEMO2_VIDEO=1): following a worker that is about to leave the nest (software rendering: low frame rate)
  if (process.env.DEMO2_VIDEO === '1') {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 500 }, recordVideo: { dir: out, size: { width: 800, height: 500 } } }), page = await ctx.newPage();
    await page.goto(new URL('demo2.html?seed=1&quality=low&speed=5&t=32520', base).href); await ready(page);
    await page.click('#followBtn'); await page.waitForTimeout(16000);
    await ctx.close(); const dst = path.join(out, 'demo2-desktop-follow.webm'); fs.renameSync(await page.video().path(), dst); files.push(dst);
  }

  // save → reload → continue (SAVE-2 session; one context keeps its IndexedDB across the reload)
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`save: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`save: ${m.text()}`); });
    await page.goto(new URL('demo2.html?new=1&quality=low&speed=30', base).href); await ready(page);
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(400);
    const a = await S(page), saved = await page.evaluate(() => window.__demo2.save());
    const kindA = await page.evaluate(() => !!window.__demo2.frame().colony);
    check(kindA, 'save: a new Demo world is the candidate world p0a2-colony by default');
    check(!a.temp && a.seed === 20261113 && saved.ok, `save: a new saved world (seed ${a.seed}) was stored with the SAVE-2 session (${JSON.stringify(saved)})`);
    await page.evaluate(() => window.__demo2.setMode('demo'));
    await page.goto(new URL('demo2.html?quality=low&autostart=0', base).href); await ready(page);
    const b = await S(page);
    check(b.world_id === a.world_id && b.seed === a.seed && Math.abs(b.frame_t - a.frame_t) < 1e-9 && b.mode === 'natural' && b.queens === a.queens && b.queens >= 2 && await page.evaluate(() => !!window.__demo2.frame().colony), `save: reload re-opens the saved colony world at the saved instant (${a.frame_t} s → ${b.frame_t} s); the 展示情境 toggle is not saved`);
    await page.evaluate(() => window.__demo2.setRunning(true)); await page.waitForTimeout(1500);
    const c = await S(page); check(c.frame_t > b.frame_t && c.ants === 30, `save: the loaded world runs on (${c.frame_t.toFixed(1)} s)`);
    await page.click('#sideBtn'); await page.click('#tabs button[data-tab="saves"]'); await page.waitForTimeout(800);
    const list = await page.textContent('#saveList'); check(list.includes('Demo 2') && list.includes('20261113'), 'save: the save list shows the world');
    await shot(page, 'demo2-desktop-saves');
    await ctx.close();
  }
  // ?world=p0a2: the plain world still works — those castes are 尚未模擬 in natural mode and labelled demo data in 展示情境
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`p0a2: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`p0a2: ${m.text()}`); });
    await page.goto(new URL('demo2.html?seed=1&world=p0a2&quality=low', base).href); await ready(page); await page.waitForTimeout(1200);
    const a = await page.evaluate(() => ({ s: window.__demo2.state(), colony: !!window.__demo2.frame().colony, labels: document.querySelector('#labels').textContent }));
    check(!a.colony && a.s.queens === 0 && a.s.majors === 0 && a.s.eggs === 0 && a.s.pupae === 0 && /蟻后：尚未模擬/.test(a.labels) && /大工蟻：尚未模擬/.test(a.labels), 'p0a2: plain world — natural mode draws no queen / major / egg / pupa and labels them 尚未模擬');
    await page.click('#modeBtn'); await page.waitForTimeout(700);
    const b = await page.evaluate(() => ({ s: window.__demo2.state(), r: window.__demo2.roster() }));
    check(b.s.queens === 2 && b.s.majors === 4 && b.s.eggs === 36 && b.s.pupae === 9 && b.r.individuals.filter((x) => x.caste === 'queen').every((x) => x.source === 'demo'), 'p0a2: 展示情境 adds the labelled demo individuals');
    await ctx.close();
  }
  await browser.close();
  check(errors.length === 0, `no page or console errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
  console.log(JSON.stringify({ check: 'demo2', passed: passed.length, failures, errors, files: files.map((f) => path.basename(f)), report, note: 'performance numbers come from software rendering under automation: NOT device results' }, null, 1));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
