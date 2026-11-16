/**
 * Demo 2 (web/demo2.html) — phone UI and watching without touching (Owner directive 2026-11-15, items 4 and the final
 * goal). Playwright Chromium; the NON-OFFICIAL P0-A2 experiment world. FAILS (exit 1) on a failed check, a page error
 * or a console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-ui.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - Pixel 7 (portrait, touch): ONE control row + a one-line status row; the scene keeps ≥ 80 % of the page height by
 *    default and with an individual's compact card; the 非正式實驗世界 and 自然模式／展示情境 chips are visible in every
 *    state (default, 更多 menu, card, sheet half / full, 展示情境); every visible control is ≥ 44 CSS px; no horizontal
 *    scroll; the status row expands on tap;
 *  - bottom sheet: closed (floating pill with key counts) → half (tap) → full (drag) → closed (drag); no scene label
 *    under the sheet or the card; the scene is re-framed into the free part;
 *  - individual observation: tap an ant → compact card with 跟隨 and 詳情; 跟隨 → 上一隻／下一隻 stepper; 詳情 opens
 *    the details in the sheet; a tap on empty space dismisses;
 *  - no input at all: the world starts and keeps running; after the idle time the 自動導覽 camera tour starts, shows
 *    its chip, takes overview shots and follows a worker chosen from ENGINE states / events; one tap hands the camera back;
 *  - the camera never changes the world (#144): the complete log of messages posted to the Worker is IDENTICAL with
 *    the tour on and off, and the two worlds are identical at the same simulation instant;
 *  - every view switch (instant and animated) lands on its framing and the camera looks at its target; so do the
 *    takeover, follow, sheet and resize states (the camera-at-rest guard must never undo or distort a move);
 *  - desktop 1440×900 and a landscape phone do not regress (all controls in the bar, no 更多 button, floating card).
 * Writes demo2-ui-*.jpg (and, with DEMO2_VIDEO=1, demo2-ui-pixel7-idle-tour.webm) into <outDir>; prints a JSON report.
 * Software rendering under automation: nothing here is a device performance result.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], files = [], report = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ready = (page) => page.waitForFunction(() => window.__demo2 && window.__demo2.ready && window.__demo2.state().ants > 0, null, { timeout: 120000 });
  const shot = async (page, name) => { const f = path.join(out, `${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 60 }); files.push(f); };
  const open = async (opts, query, tag, init) => {
    const ctx = await browser.newContext(opts), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    if (init) await page.addInitScript(init);
    await page.goto(new URL(`demo2.html?${query}`, base).href); await ready(page);
    return { ctx, page };
  };
  /** visible controls smaller than 44 CSS px, the two chips' visibility, horizontal scroll */
  const audit = (page) => page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && !e.closest('[hidden]'); };
    const small = [...document.querySelectorAll('button, select, a.btn, input[type=text]')].filter(vis).map((e) => ({ id: e.id || e.textContent.trim().slice(0, 8), r: e.getBoundingClientRect() })).filter((x) => x.r.width < 43.5 || x.r.height < 43.5).map((x) => `${x.id} ${x.r.width.toFixed(0)}×${x.r.height.toFixed(0)}`);
    const chip = (id) => { const e = document.querySelector(id), r = e.getBoundingClientRect(), at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return vis(e) && r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && (at === e || at.id === 'statusRow') ? e.textContent : null; }; // the status row's own tap area may lie over its chip; anything else on top = covered
    return { small, flag: chip('#flag'), mode: chip('#modeBadge'), noScroll: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth, layout: window.__demo2.layout() };
  });
  const marks = (a, mode = '自然模式') => !!a.flag && a.flag.includes('非正式實驗世界') && !!a.mode && a.mode.includes(mode);
  /** every view switch lands on its framing, and the camera's orientation belongs to its pose (the rest guard of
   *  main.ts must never undo or distort a move): the instant switch is the reference, the animated one must end on it */
  const AIM_RAD = 1e-9;
  const pose = (page) => page.evaluate(() => { const D = window.__demo2, s = D.state(); return { view: s.view, cam: s.cam, target: s.target, aim: D.camAim(), box: D.nestOnScreen().box, labels: D.labelRects().length }; });
  const framing = async (page, tag, tap) => {
    const ref = {}, got = {}, d3 = (p, q2) => Math.hypot(p[0] - q2[0], p[1] - q2[1], p[2] - q2[2]);
    for (const v of ['surface', 'under', 'full']) { await page.evaluate((x) => window.__demo2.setView(x, true), v); await page.waitForTimeout(700); ref[v] = await pose(page); }
    for (const [v, id] of [['surface', '#viewSurface'], ['under', '#viewUnder'], ['full', '#viewFull']]) {
      if (tap) await page.tap(id); else await page.click(id);
      await page.waitForFunction(({ c, v2 }) => { const s = window.__demo2.state(); return s.view === v2 && Math.hypot(s.cam[0] - c[0], s.cam[1] - c[1], s.cam[2] - c[2]) < 1e-6; }, { c: ref[v].cam, v2: v }, { timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(700); got[v] = await pose(page);
    }
    const bad = [];
    for (const v of ['surface', 'under', 'full']) {
      const r = ref[v], g = got[v];
      if (!(r.aim < AIM_RAD)) bad.push(`${v}: instant switch aims ${r.aim.toExponential(1)} rad off its target`);
      if (!(g.aim < AIM_RAD)) bad.push(`${v}: animated switch aims ${g.aim.toExponential(1)} rad off its target`);
      if (!(g.view === v && d3(g.cam, r.cam) < 1e-9 && d3(g.target, r.target) < 1e-9)) bad.push(`${v}: animated switch did not end on the view's pose`);
      if (!g.box.every((x, i) => Math.abs(x - r.box[i]) <= 1)) bad.push(`${v}: nest framed at ${JSON.stringify(g.box)} instead of ${JSON.stringify(r.box)}`);
      if (g.labels !== r.labels || (v !== 'surface' && g.labels < 2)) bad.push(`${v}: ${g.labels} labels (instant switch: ${r.labels})`);
    }
    check(bad.length === 0, `${tag}: every view switch (地表／地下／完整, instant and animated) lands on its framing and the camera looks at its target (${JSON.stringify(Object.fromEntries(Object.entries(got).map(([k, g]) => [k, g.box])))}) ${JSON.stringify(bad)}`);
  };
  const aimed = async (page, what, tag) => { const a = await page.evaluate(() => window.__demo2.camAim()); check(a < AIM_RAD, `${tag}: ${what} — the camera looks at its target (${a.toExponential(1)} rad off)`); };
  const labelsUnder = (page) => page.evaluate(() => { const D = window.__demo2, L = D.layout(), limit = innerHeight - L.sheet_px + 0.5, lg = document.querySelector('#lblLegend'), lb = lg.hidden ? null : lg.getBoundingClientRect(); return { under: D.labelRects().filter((x) => x.top + x.h > limit).map((x) => x.text), legendUnder: !!lb && lb.bottom > limit, n: D.labelRects().length }; });

  // ---------- Pixel 7, portrait ----------
  {
    const { ctx, page } = await open({ ...devices['Pixel 7'] }, 'seed=1&quality=medium&speed=5&tour=0', 'pixel7');
    await page.waitForTimeout(1500);
    const vp = page.viewportSize();
    let a = await audit(page);
    report.pixel7 = { viewport: vp, default: a.layout };
    check(a.layout.narrow && a.layout.sheet === 'peek' && a.layout.scene_fraction >= 0.8, `pixel7: the scene keeps ${(a.layout.scene_fraction * 100).toFixed(1)} % of the page height by default (≥ 80 %; top bar ${a.layout.top_px.toFixed(0)} px of ${vp.height})`);
    const rows = await page.evaluate(() => { const ys = [...document.querySelectorAll('#top > button, #top > select, #top > .seg')].filter((e) => e.getBoundingClientRect().width > 0).map((e) => Math.round(e.getBoundingClientRect().top)); const hud = document.querySelector('#hud').getBoundingClientRect(); return { rows: new Set(ys).size, n: ys.length, hudH: hud.height, hudClip: document.querySelector('#hud').scrollWidth > document.querySelector('#hud').clientWidth + 1, hud: document.querySelector('#hud').textContent, shown: ['#play', '#speed', '#viewFull', '#viewSurface', '#viewUnder', '#moreBtn'].every((s) => document.querySelector(s).getBoundingClientRect().width > 0), hiddenInMenu: ['#modeBtn', '#followBtn', '#sideBtn', '#tourBtn'].every((s) => document.querySelector(s).getBoundingClientRect().width === 0) }; });
    check(rows.rows === 1 && rows.shown && rows.hiddenInMenu, `pixel7: ONE control row (${rows.n} controls: play, speed, three views, 更多); 展示情境／跟隨／自動導覽／面板 are in the 更多 menu`);
    check(rows.hudH <= 20 && !rows.hudClip && rows.hud.includes('（合成）'), `pixel7: the status row is one unclipped line (${rows.hudH.toFixed(0)} px: 「${rows.hud}」)`);
    check(marks(a) && a.noScroll && a.small.length === 0, `pixel7: default — both markings visible, no horizontal scroll, every control ≥ 44 px (${JSON.stringify(a.small)})`);
    await shot(page, 'demo2-ui-pixel7-default');
    // the status row expands on tap and collapses again (its tap target reaches 44 px)
    const sr = await page.evaluate(() => { const r = document.querySelector('#statusRow').getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + 40, hit: !!document.elementFromPoint(r.left + r.width * 0.7, r.top + 40).closest('#statusRow') }; });
    await page.touchscreen.tap(sr.x, sr.y); await page.waitForTimeout(500);
    const ex = await page.evaluate(() => ({ t: document.querySelector('#hud').textContent, h: document.querySelector('#hud').getBoundingClientRect().height, open: window.__demo2.layout().hud_open, aria: document.querySelector('#hud').getAttribute('aria-expanded') }));
    check(sr.hit && ex.open && ex.aria === 'true' && ex.t.includes('種子') && ex.t.includes('巢外') && ex.t.includes('非正式') && ex.h > rows.hudH, `pixel7: a tap 44 px into the status row expands it (${ex.h.toFixed(0)} px, seed and counts shown)`);
    a = await audit(page); check(marks(a) && a.noScroll, 'pixel7: expanded status — markings visible, no horizontal scroll');
    await page.touchscreen.tap(sr.x, sr.y - 30); await page.waitForTimeout(400);
    check(!(await page.evaluate(() => window.__demo2.layout().hud_open)), 'pixel7: a second tap collapses the status row');

    // 更多 menu
    await page.tap('#moreBtn'); await page.waitForTimeout(300);
    a = await audit(page);
    const menu = await page.evaluate(() => ['#modeBtn', '#followBtn', '#tourBtn', '#sideBtn', '#perfBtn'].map((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth && r.height >= 44; }));
    check(menu.every(Boolean) && marks(a) && a.small.length === 0 && a.noScroll, `pixel7: 更多 menu shows 展示情境, 跟隨, 自動導覽, 面板, 畫面與效能 (all ≥ 44 px; markings still visible) ${JSON.stringify(a.small)}`);
    await shot(page, 'demo2-ui-pixel7-more');
    await page.tap('#modeBtn'); await page.waitForTimeout(700);
    a = await audit(page);
    check(marks(a, '展示情境') && a.noScroll && !(await page.evaluate(() => document.body.classList.contains('more-open'))) && a.layout.top_px <= report.pixel7.default.top_px + 0.5, `pixel7: 展示情境 from the menu — the mode chip says 「${a.mode}」, the menu closed, the bar did not grow`);
    await page.tap('#moreBtn'); await page.tap('#modeBtn'); await page.waitForTimeout(500);
    await page.tap('#moreBtn'); await page.waitForTimeout(200); await page.touchscreen.tap(60, vp.height * 0.6); await page.waitForTimeout(300);
    check(!(await page.evaluate(() => document.body.classList.contains('more-open'))), 'pixel7: a tap outside closes the 更多 menu');

    await framing(page, 'pixel7', true);
    // individual observation: tap → compact card (跟隨, 詳情) → stepper → details in the sheet → tap empty space dismisses
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(400);
    const target = await page.evaluate(() => { for (const x of window.__demo2.ants().filter((y) => y.realm === 'nest' && !y.moving)) { const p = window.__demo2.screenOf(x.id); if (p && p.x > 60 && p.x < innerWidth - 60 && p.y > 150 && p.y < innerHeight - 140) return { id: x.id, ...p }; } return null; });
    check(!!target, 'pixel7: an underground worker is on screen to tap');
    await page.touchscreen.tap(target.x, target.y - 4); await page.waitForTimeout(500);
    const card = await page.evaluate(() => { const v = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { w: r.width, h: r.height, top: r.top, bottom: r.bottom, t: e.textContent } : null; }; return { sel: window.__demo2.state().selected, card: v('#card'), sum: v('#card .sum'), detail: v('#card .detail'), follow: v('#cardFollow'), more: v('#cardDetail'), prev: v('#cardPrev'), pill: v('#peek'), h: innerHeight }; });
    check(card.sel && card.card && card.card.h <= 60 && card.card.bottom >= card.h - 1 && card.sum && card.sum.t.includes(card.sel) && card.sum.t.includes('小工蟻') && card.sum.t.includes('引擎') && !card.detail && card.follow && card.more && !card.prev && !card.pill, `pixel7: tap selects ${card.sel} → a compact card (${card.card ? card.card.h.toFixed(0) : '?'} px) with 跟隨 and 詳情 at the bottom edge`);
    a = await audit(page);
    check(a.layout.scene_fraction >= 0.8 && marks(a) && a.small.length === 0, `pixel7: with the compact card the scene keeps ${(a.layout.scene_fraction * 100).toFixed(1)} % (≥ 80 %), controls ≥ 44 px ${JSON.stringify(a.small)}`);
    let lu = await labelsUnder(page); check(lu.under.length === 0 && !lu.legendUnder, `pixel7: no scene label or legend under the compact card (${JSON.stringify(lu.under)})`);
    await shot(page, 'demo2-ui-pixel7-card');
    await page.tap('#cardFollow'); await page.waitForTimeout(1200);
    const f1 = await page.evaluate(() => ({ s: window.__demo2.state(), prev: document.querySelector('#cardPrev')?.getAttribute('aria-label'), next: document.querySelector('#cardNext')?.getAttribute('aria-label'), w: document.querySelector('#cardNext')?.getBoundingClientRect().width }));
    check(f1.s.following === card.sel && f1.prev === '上一隻' && f1.next === '下一隻' && f1.w >= 44, `pixel7: 跟隨 follows ${f1.s.following} and shows the 上一隻／下一隻 stepper`);
    await page.tap('#cardNext'); await page.waitForTimeout(900);
    const f2 = await page.evaluate(() => { const s = window.__demo2.state(), x = window.__demo2.ants().find((y) => y.id === s.following); return { s, d: x ? Math.hypot(s.target[0] - x.x, s.target[1] - x.y, s.target[2] - x.z) : 99, sum: document.querySelector('#card .sum').textContent }; });
    await page.tap('#cardPrev'); await page.waitForTimeout(600);
    const f3 = await page.evaluate(() => window.__demo2.state());
    check(f2.s.following && f2.s.following !== card.sel && f2.s.selected === f2.s.following && f2.sum.includes(f2.s.following) && f2.d < 3 && f3.following === card.sel, `pixel7: 下一隻 moves the follow to ${f2.s.following} (camera on it), 上一隻 back to ${f3.following}`);
    a = await audit(page); check(a.small.length === 0 && a.noScroll, `pixel7: following — stepper and buttons ≥ 44 px, no horizontal scroll ${JSON.stringify(a.small)}`);
    await shot(page, 'demo2-ui-pixel7-follow');
    await aimed(page, 'following, after the stepper', 'pixel7');
    await page.tap('#cardDetail'); await page.waitForTimeout(600);
    const det = await page.evaluate(() => { const p = document.querySelector('#pane-ant'), r = p.getBoundingClientRect(); return { L: window.__demo2.layout(), vis: !p.hidden && r.height > 40, t: p.textContent, tab: document.querySelector('#tabs button[data-tab="ant"]').getAttribute('aria-pressed') }; });
    check(det.L.sheet === 'half' && det.vis && det.tab === 'true' && ['引擎個體', '引擎狀態', '展示假設', '嗉囊'].every((s) => det.t.includes(s)), 'pixel7: 詳情 opens the full card (data-category labels) in the sheet\'s 個體 tab');
    lu = await labelsUnder(page); a = await audit(page);
    check(lu.under.length === 0 && !lu.legendUnder && marks(a) && a.small.length === 0, `pixel7: sheet half + card — no label under them, markings visible, controls ≥ 44 px ${JSON.stringify(a.small.concat(lu.under))}`);
    await shot(page, 'demo2-ui-pixel7-detail');
    await page.evaluate(() => window.__demo2.setSheet('peek')); await page.waitForTimeout(300);
    const empty = await page.evaluate(() => { const D = window.__demo2, pts = [...D.ants(), ...D.statics()].map((x) => D.screenOf(x.id)).filter(Boolean); for (let y = 110; y < innerHeight - 160; y += 12) for (let x = 30; x < innerWidth - 30; x += 12) if (pts.every((p) => Math.hypot(p.x - x, p.y - y) > 60)) return { x, y }; return null; });
    await page.touchscreen.tap(empty.x, empty.y); await page.waitForTimeout(500);
    const gone = await page.evaluate(() => ({ s: window.__demo2.state(), hidden: document.querySelector('#card').hidden, pill: document.querySelector('#peek').getBoundingClientRect().width > 0 }));
    check(gone.s.selected === null && gone.s.following === null && gone.hidden && gone.pill, 'pixel7: a tap on empty space dismisses the card and the follow; the 面板 pill is back');

    // bottom sheet: pill (closed) → half (tap) → full (drag up) → closed (drag down)
    const pill = await page.evaluate(() => { const e = document.querySelector('#peek'), r = e.getBoundingClientRect(); return { t: e.textContent, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    check(/巢外 \d+・巢內 \d+/.test(pill.t) && pill.h >= 44 && pill.w <= 170, `pixel7: closed sheet = a small floating pill with key counts (「${pill.t}」, ${pill.w.toFixed(0)}×${pill.h.toFixed(0)} px)`);
    await page.tap('#viewFull'); await page.waitForTimeout(1500);
    const fr0 = await page.evaluate(() => window.__demo2.nestOnScreen().h);
    await page.touchscreen.tap(pill.x, pill.y); await page.waitForTimeout(500);
    a = await audit(page); lu = await labelsUnder(page);
    const half = await page.evaluate(() => ({ L: window.__demo2.layout(), stats: document.querySelector('#pane-stats').getBoundingClientRect().height, side: document.querySelector('#side').getBoundingClientRect().toJSON(), fr: window.__demo2.nestOnScreen().h, soil: window.__demo2.soilAtBottom(), bg: getComputedStyle(document.querySelector('#side')).backgroundColor }));
    check(half.L.sheet === 'half' && half.stats > 100 && half.side.bottom >= vp.height - 1 && half.side.width >= vp.width - 1 && Math.abs(half.L.sheet_px - half.side.height) < 1.5 && half.fr < fr0 - 200 && half.soil && /^rgb\(/.test(half.bg), `pixel7: a tap on the pill opens the sheet half (${half.L.sheet_px.toFixed(0)} px, opaque); the scene is re-framed into the free ${half.fr.toFixed(0)} px`);
    check(lu.under.length === 0 && !lu.legendUnder && lu.n >= 2 && marks(a) && a.small.length === 0 && a.noScroll, `pixel7: sheet half — ${lu.n} labels, none under the sheet; markings visible; controls ≥ 44 px ${JSON.stringify(a.small.concat(lu.under))}`);
    await shot(page, 'demo2-ui-pixel7-sheet-half');
    await aimed(page, 'sheet half (scene re-framed)', 'pixel7');
    const drag = async (dy) => { const g = await page.evaluate(() => { const r = document.querySelector('#grip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 6 }; }); const cdp = await ctx.newCDPSession(page), pt = (y) => [{ x: g.x, y, id: 1 }]; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(g.y) }); for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(g.y + (dy * i) / 8) }); await page.waitForTimeout(20); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); await page.waitForTimeout(500); };
    await drag(-320);
    a = await audit(page); lu = await labelsUnder(page);
    check(a.layout.sheet === 'full' && a.layout.sheet_px > vp.height * 0.8 && marks(a) && lu.under.length === 0 && a.noScroll, `pixel7: dragging the grip up opens the sheet full (${a.layout.sheet_px.toFixed(0)} px); the bar and both markings stay visible; no label shows through ${JSON.stringify([a.layout.sheet, a.flag, a.mode, a.noScroll, lu])}`);
    await shot(page, 'demo2-ui-pixel7-sheet-full');
    await aimed(page, 'sheet full', 'pixel7');
    for (const t of ['legend', 'notsim', 'saves', 'perf']) { await page.tap(`#tabs button[data-tab="${t}"]`); await page.waitForTimeout(250); const s = await audit(page); check(s.small.length === 0 && s.noScroll, `pixel7: sheet tab ${t} — controls ≥ 44 px, no horizontal scroll ${JSON.stringify(s.small)}`); }
    await page.tap('#tabs button[data-tab="stats"]');
    await drag(700);
    a = await audit(page);
    check(a.layout.sheet === 'peek' && a.layout.sheet_px === 0 && Math.abs((await page.evaluate(() => window.__demo2.nestOnScreen().h)) - fr0) < 1, 'pixel7: dragging the grip down closes the sheet; the scene gets the whole height back');
    await aimed(page, 'sheet closed again', 'pixel7');
    await page.tap('#moreBtn'); await page.tap('#perfBtn'); await page.waitForTimeout(400);
    const pf = await page.evaluate(() => ({ L: window.__demo2.layout(), t: document.querySelector('#pane-perf').textContent, hidden: document.querySelector('#pane-perf').hidden }));
    check(pf.L.sheet === 'half' && !pf.hidden && pf.t.includes('畫面風格') && pf.t.includes('渲染器') && pf.t.includes('WebGL 2'), 'pixel7: 更多 → 畫面風格／渲染器／效能 opens that tab (style and renderer toggles live in the sheet)');
    await ctx.close();
  }

  // ---------- watching without touching: the world runs, the idle tour starts, one tap takes over ----------
  const LOG = () => { const send = Worker.prototype.postMessage; window.__workerLog = []; Worker.prototype.postMessage = function (m, ...r) { window.__workerLog.push(JSON.stringify(m)); return send.call(this, m, ...r); }; };
  const T_CMP = 9 * 3600 + 900;
  let tourRun = null;
  for (const [tag, opts] of [['pixel7', { ...devices['Pixel 7'] }], ['desktop', { viewport: { width: 1440, height: 900 } }]]) {
    const video = process.env.DEMO2_VIDEO === '1' && tag === 'pixel7';
    const { ctx, page } = await open(video ? { ...opts, recordVideo: { dir: out, size: opts.viewport } } : opts, 'seed=1&quality=low&speed=10&tour=8', `tour-${tag}`, LOG);
    const s0 = await page.evaluate(() => ({ s: window.__demo2.state(), tour: window.__demo2.tour(), play: document.querySelector('#play').textContent }));
    check(s0.s.running && s0.play.includes('暫停') && s0.tour.on, `tour ${tag}: the world is running right after load with no input; 自動導覽 is on`);
    // wait (no input at all) until the tour has shown an overview and followed a worker
    await page.waitForFunction(() => { const t = window.__demo2.tour(); return t.active && t.follows && t.log.length >= 2; }, null, { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const t1 = await page.evaluate(() => { const D = window.__demo2, t = D.tour(), s = D.state(), fw = D.frame().workers.find((w) => w.id === s.following), chip = document.querySelector('#tourChip'), x = D.ants().find((y) => y.id === s.following), r = chip.getBoundingClientRect(); return { t, s, fw, chip: chip.hidden ? '' : chip.textContent, chipOn: r.width > 0 && r.top >= D.layout().top_px - 1 && r.right <= innerWidth, d: x ? Math.hypot(s.target[0] - x.x, s.target[1] - x.y, s.target[2] - x.z) : 99, sum: document.querySelector('#card .sum').textContent, card: !document.querySelector('#card').hidden, L: D.layout() }; });
    const ACTIVE = ['to_entrance', 'feeding', 'returning', 'outbound', 'brood_care', 'searching', 'from_entrance'];
    check(t1.t.active && t1.chip === '自動導覽中・點一下接手' && t1.chipOn, `tour ${tag}: after ${t1.t.idle_s} s without input the tour runs and shows 「${t1.chip}」`);
    check(t1.t.log[0].kind === 'view' && t1.t.log.some((x) => x.kind === 'follow') && t1.t.follows && t1.s.following === t1.t.shot.id && t1.d < 6 && t1.card, `tour ${tag}: an overview first, then it follows ${t1.s.following} (reason ${t1.t.shot.reason}; camera ${t1.d.toFixed(1)} cm from it; its card is shown)`);
    check(t1.t.shot.reason === 'troph' || t1.t.shot.reason === 'larva_feed' ? t1.t.cues > 0 : ACTIVE.includes(t1.t.shot.reason), `tour ${tag}: the followed worker was chosen from engine data (${t1.t.shot.reason}; its engine state now: ${t1.fw && t1.fw.state})`);
    check(t1.t.observed === null && !t1.s.followed && t1.s.running && t1.s.frame_t > s0.s.frame_t, `tour ${tag}: the tour follow is camera only (the Worker was not asked to report this worker) and the world ran on (${s0.s.frame_t.toFixed(0)} → ${t1.s.frame_t.toFixed(0)} s)`);
    if (tag === 'pixel7') check(t1.L.scene_fraction >= 0.8, `tour pixel7: the scene keeps ${(t1.L.scene_fraction * 100).toFixed(1)} % while the tour follows`);
    await shot(page, `demo2-ui-${tag}-idle-tour`);
    if (video) await page.waitForTimeout(26000); // a few more shots for the clip
    const logOn = await page.evaluate(() => window.__workerLog.slice());
    // one tap hands the camera back. The camera must then stay put for as long as the user is not idle again: both
    // samples are taken inside ONE in-page call, within the idle time (after it the tour may rightly start again; on a
    // slow runner two separate calls can straddle that moment, so a late sample is retaken, never accepted).
    // takeOver(kind): wait until the tour is in a shot of that kind (for 'view': while its camera move is still running), tap, sample
    // "stays where it is" is EXACT: a camera at rest is bit-identical from frame to frame (the page puts back the
    // last-digit noise of OrbitControls.update(); main.ts REST_EPS_CM). `moved` is the distance, for the message.
    const still = (p, q2) => JSON.stringify(p) === JSON.stringify(q2), moved = (x, y) => Math.max(Math.hypot(x.cam[0] - y.cam[0], x.cam[1] - y.cam[1], x.cam[2] - y.cam[2]), Math.hypot(x.target[0] - y.target[0], x.target[1] - y.target[1], x.target[2] - y.target[2]));
    const takeOver = async (kind) => {
    let stop = null, taps = 0, moving = null;
    for (; taps < 4; ) {
      await page.waitForFunction((k) => { const t = window.__demo2.tour(); return t.active && t.shot.kind === k && !document.querySelector('#tourChip').hidden; }, kind, { timeout: 90000 });
      if (kind === 'view') moving = await page.evaluate(async () => { const D = window.__demo2, a = D.state().cam, t0 = performance.now(); let moved = false; while (!moved && performance.now() - t0 < 1500) { await new Promise((r) => requestAnimationFrame(r)); moved = JSON.stringify(D.state().cam) !== JSON.stringify(a); } return { moved, still_view: D.tour().active && D.tour().shot.kind === 'view' }; });
      if (kind === 'view' && !(moving.moved && moving.still_view)) { await page.waitForTimeout(500); continue; } // the overview move already ended: wait for the next one
      // (coordinates, not a locator: the page hands the camera back on pointerdown, which hides the chip at once)
      const cp = await page.evaluate(() => { const r = document.querySelector('#tourChip').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
      if (tag === 'pixel7') await page.touchscreen.tap(cp.x, cp.y); else await page.mouse.click(cp.x, cp.y);
      taps++;
      stop = await page.evaluate(async () => {
        const D = window.__demo2, snap = () => ({ t: D.tour(), s: D.state(), aim: D.camAim(), chip: document.querySelector('#tourChip').hidden });
        // hold for up to 900 ms of REAL time, but never past the idle window (timers run late on a loaded machine:
        // the elapsed time is measured, not assumed)
        const a = snap(), t0 = performance.now(), room = () => a.t.idle_s - D.tour().idle_for_s;
        if (room() < 2.5) return { a, b: null, hold: 0 };
        let frames = 0; const count = () => { frames++; if (performance.now() - t0 < 900) requestAnimationFrame(count); }; requestAnimationFrame(count);
        while ((performance.now() - t0 < 900 || frames < 3) && room() > 2) await new Promise((r) => setTimeout(r, 50));
        return { a, b: snap(), hold: performance.now() - t0, frames };
      });
      if (stop.b && stop.b.t.idle_for_s < stop.b.t.idle_s && stop.frames >= 3) break; // both samples lie inside the idle window, with frames drawn in between
    }
    return { stop, taps, moving };
    };
    const { stop, taps } = await takeOver('follow');
    const sa = stop.a, sb = stop.b;
    check(!!sb && sb.t.idle_for_s < sb.t.idle_s && stop.hold >= 300 && stop.frames >= 3, `tour ${tag}: both samples after the tap were taken within the idle time, ${stop.frames} frames apart (${sb ? sb.t.idle_for_s.toFixed(2) : '—'} s of ${sa.t.idle_s} s; ${taps} tap${taps > 1 ? 's' : ''})`);
    check(!!sb && !sa.t.active && sa.chip && sa.s.following === null && sa.s.running && !sb.t.active && sb.chip && sb.s.following === null && sb.s.running && sb.s.frame_t >= sa.s.frame_t && still(sb.s.cam, sa.s.cam) && still(sb.s.target, sa.s.target) && sa.aim < AIM_RAD && sb.aim < AIM_RAD, `tour ${tag}: one tap stops the tour (chip gone, the camera stays exactly where it is for the next ${Math.round(stop.hold)} ms — moved ${sb ? moved(sb.s, sa.s).toExponential(1) : '?'} cm — the world keeps running) ${JSON.stringify(sb ? { a: [sa.t.active, sa.chip, sa.s.following, sa.s.running, sa.s.cam, sa.s.target, sa.s.frame_t], b: [sb.t.active, sb.chip, sb.s.following, sb.s.running, sb.s.cam, sb.s.target, sb.s.frame_t] } : null)}`);
    // … and the same while an overview move is under way (the tour starts again after the idle time; its first shot is an overview)
    const v = await takeOver('view'), va = v.stop.a, vb = v.stop.b;
    check(!!vb && v.moving && v.moving.moved && vb.t.idle_for_s < vb.t.idle_s && v.stop.hold >= 300 && v.stop.frames >= 3 && !va.t.active && va.chip && !vb.t.active && vb.s.running && still(vb.s.cam, va.s.cam) && still(vb.s.target, va.s.target) && va.aim < AIM_RAD && vb.aim < AIM_RAD, `tour ${tag}: a tap during an overview move stops the camera where it is (it was moving; then exactly still for ${Math.round(v.stop.hold)} ms, moved ${vb ? moved(vb.s, va.s).toExponential(1) : '?'} cm; ${v.taps} tap${v.taps > 1 ? 's' : ''}) ${JSON.stringify(vb ? { moving: v.moving, a: [va.t.active, va.chip, va.s.cam, va.s.target], b: [vb.t.active, vb.t.idle_for_s, vb.s.running, vb.s.cam, vb.s.target] } : null)}`);
    if (tag === 'desktop') {
      // the same run with the tour OFF: the Worker received exactly the same messages, and the worlds are the same
      const off = await open(opts, 'seed=1&quality=low&speed=10&tour=0', 'tour-off', LOG);
      await off.page.waitForTimeout(4000);
      const o1 = await off.page.evaluate(() => ({ log: window.__workerLog.slice(), t: window.__demo2.tour(), s: window.__demo2.state() }));
      check(!o1.t.on && !o1.t.active && o1.t.log.length === 0 && o1.s.following === null, 'tour off (?tour=0): no tour ran');
      check(logOn.length >= 5 && JSON.stringify(logOn) === JSON.stringify(o1.log), `#144: the complete Worker message log is IDENTICAL with the tour on and off (${logOn.length} messages: ${logOn.map((m) => JSON.parse(m).type).join(', ')})`);
      const at = async (p) => p.evaluate(async (T) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(T); const f = D.frame(); return { t: f.t_sim, json: JSON.stringify(f), log: window.__workerLog.slice() }; }, T_CMP);
      const A = await at(page), B = await at(off.page);
      check(A.t === T_CMP && B.t === T_CMP && A.json === B.json && A.json.length > 2000, `#144: after the tour, the world is identical to the never-toured one at t = ${T_CMP} s (frame JSON ${A.json.length} bytes equal)`);
      // the tap on the chip is page input only: the toured page's log differs from the other by nothing
      check(JSON.stringify(A.log) === JSON.stringify(B.log), `#144: stopping the tour sent nothing either (${A.log.length} messages on both pages)`);
      tourRun = { shots: t1.t.log, messages: logOn.map((m) => JSON.parse(m).type) };
      await off.ctx.close();
    }
    await ctx.close();
    if (video) { const dst = path.join(out, 'demo2-ui-pixel7-idle-tour.webm'); fs.renameSync(await page.video().path(), dst); files.push(dst); }
  }
  report.tour = tourRun;

  // ---------- desktop and landscape phone: no regression ----------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } }, 'seed=1&quality=low&speed=5', 'desktop');
    await page.waitForTimeout(1000);
    const d = await page.evaluate(() => { const w = (s) => document.querySelector(s).getBoundingClientRect(); return { L: window.__demo2.layout(), tour: window.__demo2.tour(), bar: ['#play', '#speed', '#viewFull', '#viewSurface', '#viewUnder', '#modeBtn', '#followBtn', '#tourBtn', '#sideBtn'].map((s) => [s, w(s).width > 0 && w(s).bottom <= w('#top').bottom]), gone: ['#moreBtn', '#peek', '#grip', '#perfBtn'].every((s) => w(s).width === 0), h1: w('h1').width > 50, full: document.querySelector('#viewFull').textContent, order: w('h1').left < w('#flag').left && w('#flag').left < w('#modeBadge').left && w('#modeBadge').left < w('#play').left, hud: document.querySelector('#hud').textContent, noScroll: document.documentElement.scrollWidth <= innerWidth }; });
    check(!d.L.narrow && d.bar.every((x) => x[1]) && d.gone && d.h1 && d.order && d.full === '完整剖面' && d.L.top_px < 80 && d.hud.includes('非正式') && d.noScroll, `desktop: the bar keeps its layout (title, markings, then all controls in the bar; no 更多／pill; ${d.L.top_px.toFixed(0)} px) ${JSON.stringify(d.bar.filter((x) => !x[1]))}`);
    check(!d.tour.on, 'desktop: under automation the tour is off unless ?tour= asks for it (the other checks keep their own camera)');
    await framing(page, 'desktop', false);
    await page.setViewportSize({ width: 1200, height: 760 }); await page.waitForTimeout(700); await aimed(page, 'after a window resize', 'desktop');
    await page.evaluate(() => window.__demo2.setView('full', true)); await page.waitForTimeout(500);
    check((await page.evaluate(() => window.__demo2.nestOnScreen().inside)), 'desktop: after the resize 完整剖面 frames the whole nest again');
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(700); await page.evaluate(() => window.__demo2.setView('full', true)); await page.waitForTimeout(400);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(300);
    const id = await page.evaluate(() => window.__demo2.ants().find((y) => y.realm === 'nest' && !y.moving).id);
    await page.evaluate((x) => window.__demo2.select(x), id); await page.waitForTimeout(300);
    const c = await page.evaluate(() => { const v = (s) => { const e = document.querySelector(s); return !!e && e.getBoundingClientRect().width > 0; }; const r = document.querySelector('#card').getBoundingClientRect(); return { detail: v('#card .detail'), sum: v('#card .sum'), follow: document.querySelector('#cardFollow').textContent, close: v('#cardClose'), more: v('#cardDetail'), box: [r.left, r.top, r.width] }; });
    check(c.detail && !c.sum && c.follow === '跟隨這隻' && c.close && !c.more && c.box[0] < 20 && c.box[2] <= 380, 'desktop: the floating card with the full details, 跟隨這隻 and 關閉 (no compact summary)');
    await page.click('#cardFollow'); await page.waitForTimeout(500);
    const n0 = await page.evaluate(() => ({ t: document.querySelector('#cardNext').textContent, f: document.querySelector('#cardFollow').textContent })); await page.click('#cardNext'); await page.waitForTimeout(500);
    const n1 = await page.evaluate(() => window.__demo2.state());
    check(n0.t.includes('下一隻') && n0.f === '停止跟隨' && n1.following && n1.following !== id, `desktop: while following, 上一隻／下一隻 step to the next worker (${id} → ${n1.following})`);
    await shot(page, 'demo2-ui-desktop-follow');
    await aimed(page, 'following', 'desktop');
    await page.evaluate(() => window.__demo2.select(null)); await page.waitForTimeout(500); await aimed(page, 'after the follow ended', 'desktop');
    await page.click('#sideBtn'); await page.waitForTimeout(300);
    const sd = await page.evaluate(() => { const r = document.querySelector('#side').getBoundingClientRect(); return { w: r.width, right: innerWidth - r.right, ant: document.querySelector('#tabs button[data-tab="ant"]').getBoundingClientRect().width, L: window.__demo2.layout() }; });
    check(sd.w === 340 && sd.right < 12 && sd.ant === 0 && sd.L.sheet_px === 0, 'desktop: the side panel is unchanged (340 px on the right; no 個體 tab; the scene is not re-framed)');
    await shot(page, 'demo2-ui-desktop-default');
    await ctx.close();
  }
  {
    const p7 = devices['Pixel 7'];
    const { ctx, page } = await open({ ...p7, viewport: { width: p7.viewport.height, height: p7.viewport.width } }, 'seed=1&quality=low&speed=5&tour=0', 'landscape');
    await page.waitForTimeout(800);
    const a = await audit(page);
    const l = await page.evaluate(() => ['#play', '#speed', '#viewFull', '#modeBtn', '#followBtn', '#sideBtn'].every((s) => { const r = document.querySelector(s).getBoundingClientRect(); return r.width > 0 && r.right <= innerWidth; }));
    check(!a.layout.narrow && l && marks(a) && a.noScroll && a.layout.scene_fraction > 0.6, `landscape phone (${page.viewportSize().width}×${page.viewportSize().height}): the wide layout, all controls and both markings visible, no horizontal scroll (scene ${(a.layout.scene_fraction * 100).toFixed(0)} %)`);
    await shot(page, 'demo2-ui-landscape-default');
    await ctx.close();
  }
  await browser.close();
  check(errors.length === 0, `no page or console errors${errors.length ? ': ' + errors.slice(0, 5).join(' | ') : ''}`);
  console.log(JSON.stringify({ check: 'demo2-ui', passed: passed.length, failures, errors, files: files.map((f) => path.basename(f)), report, note: 'software rendering under automation: no number here is a device result' }, null, 1));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
