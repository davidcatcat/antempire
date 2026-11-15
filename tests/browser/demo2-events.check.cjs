/**
 * Demo 2 (web/demo2.html) — D2E-1: every engine event the page receives is visible, and the page's counts equal an
 * independent Node replay (docs/demo2-engine-gap.md). Playwright Chromium; the NON-OFFICIAL experiment world.
 * FAILS (exit 1) on a failed check, a page error or a console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-events.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - RECONCILIATION on the real page: the counts by class and by raw kind that the page shows (window.__demo2.events(),
 *    and the numbers in the 事件 tab) equal tests/lib/demo2-replay.ts over exactly the events the page received
 *    (seq span), after the fast-forward, after a further step_until, and after running at 60×; for the default
 *    candidate world (roster events + base events) and for `?world=p0a2`;
 *  - Pixel 7: the scene still keeps ≥ 80 % of the page height by default; the 事件 tab lists every class (zeros
 *    included), the futile trips («到食源：是空的») with their real count, the list of recent events; a tap on a line
 *    selects that worker; the filter narrows the table and the list; every control is ≥ 44 CSS px; no horizontal scroll;
 *  - in-scene cues (◆): appear on drawn individuals / the source, never more than the budget at once (also at 60×),
 *    never under the sheet; switching them off removes the labels and changes no count;
 *  - nothing from the not-to-be-shown list is worded as happening;
 *  - #144: with cues on + the 事件 tab used, and with cues off + the panel never opened, the complete log of messages
 *    posted to the Worker is IDENTICAL and the two worlds are identical at the same simulation instant.
 * Writes demo2-events-*.jpg (and, with DEMO2_VIDEO=1, demo2-events-pixel7.webm) into <outDir>; prints a JSON report.
 * Software rendering under automation: nothing here is a device performance result.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const { replayCounts, replayLines } = await import('../lib/demo2-replay.ts');
  const failures = [], passed = [], errors = [], files = [], report = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const ready = (page) => page.waitForFunction(() => window.__demo2 && window.__demo2.ready && window.__demo2.state().ants > 0, null, { timeout: 120000 });
  const shot = async (page, name) => { const f = path.join(out, `${name}.jpg`); await page.screenshot({ path: f, type: 'jpeg', quality: 62 }); files.push(f); };
  const LOG = () => { const send = Worker.prototype.postMessage; window.__workerLog = []; Worker.prototype.postMessage = function (m, ...r) { window.__workerLog.push(JSON.stringify(m)); return send.call(this, m, ...r); }; };
  const open = async (opts, query, tag, init) => {
    const ctx = await browser.newContext(opts), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.stack || e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    if (init) await page.addInitScript(init);
    await page.goto(new URL(`demo2.html?${query}`, base).href); await ready(page);
    return { ctx, page };
  };
  const sorted = (o) => Object.fromEntries(Object.entries(o).filter(([, n]) => n > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  const ROSTER = ['queen_added', 'worker_added', 'brood_item_added'];
  const SEED = 1, LINES = replayLines(SEED, 14 * 3600 * 1000); // the reference world of this seed, further than any page below runs
  /** page counts vs the replay over exactly the base events the page has received; roster = the candidate world's K events */
  const reconcile = async (page, tag) => {
    const ev = await page.evaluate(() => window.__demo2.events()), roster = await page.evaluate(() => { const c = window.__demo2.frame().colony; return c ? c.queens.length + c.majors.length + c.eggs.length + c.pupae.length : 0; });
    const cls = { ...ev.classes }, kinds = { ...ev.kinds }; let rosterSeen = 0;
    for (const k of ROSTER) { rosterSeen += cls[k] || 0; delete cls[k]; delete kinds[k]; }
    const n = ev.total - rosterSeen, rep = replayCounts(LINES, 0, n);
    const same = JSON.stringify(sorted(cls)) === JSON.stringify(rep.classes) && JSON.stringify(sorted(kinds)) === JSON.stringify(rep.kinds);
    check(ev.gaps === 0 && ev.first_seq === 0 && ev.last_seq === ev.total - 1 && rosterSeen === roster && n <= LINES.length, `${tag}: the page received every event from seq 0 (${ev.total} events, ${rosterSeen} roster events, no gap)`);
    check(same && rep.total === n, `${tag}: page counts by class and by raw kind == Node replay of the same ${n} events (exit ${cls.exit}, 空的食源 ${cls.source_empty}, 取食 ${cls.source_take}, 交哺 ${cls.contact_transfer}, 無轉移接觸 ${cls.contact_only}, 走動碰幼蟲 ${cls.idle_larva_touch})`);
    if (!same) process.stderr.write(`page ${JSON.stringify(sorted(cls))}\nreplay ${JSON.stringify(rep.classes)}\n`);
    return { ev, classes: sorted(cls), n };
  };
  const audit = (page) => page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && !e.closest('[hidden]'); };
    const small = [...document.querySelectorAll('button, select, a.btn, input[type=text]')].filter(vis).map((e) => ({ id: e.id || e.textContent.trim().slice(0, 8), r: e.getBoundingClientRect() })).filter((x) => x.r.width < 43.5 || x.r.height < 43.5).map((x) => `${x.id} ${x.r.width.toFixed(0)}×${x.r.height.toFixed(0)}`);
    return { small, noScroll: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth, layout: window.__demo2.layout() };
  });
  const cueLabels = (page) => page.evaluate(() => { const D = window.__demo2, L = D.layout(), limit = innerHeight - L.sheet_px + 0.5; const r = D.labelRects().filter((x) => x.key.startsWith('cue-')); return { n: r.length, texts: r.map((x) => x.text), under: r.filter((x) => x.top + x.h > limit).length, legend: document.querySelector('#lblLegend').textContent, max: D.events().cue_max }; });
  /** words that would claim a mechanism the engine does not simulate (audit §3.3) */
  const FORBIDDEN = /費洛蒙路徑|產卵中|孵化|化蛹了|羽化了|死亡|屍體被|搬運固體|捕獵|挖掘|打鬥|警戒中|下雨|躲雨/;

  // ---------- Pixel 7, portrait: reconciliation + the 事件 tab + cues ----------
  {
    const video = process.env.DEMO2_VIDEO === '1';
    const opts = { ...devices['Pixel 7'] };
    const { ctx, page } = await open(video ? { ...opts, recordVideo: { dir: out, size: opts.viewport } } : opts, `seed=${SEED}&quality=low&speed=5&tour=0&autostart=0`, 'pixel7');
    let a = await audit(page);
    check(a.layout.narrow && a.layout.sheet === 'peek' && a.layout.scene_fraction >= 0.8 && a.noScroll, `pixel7: the scene keeps ${(a.layout.scene_fraction * 100).toFixed(1)} % of the page height by default (≥ 80 %), no horizontal scroll`);
    const r0 = await reconcile(page, 'pixel7 after the fast-forward to 09:00 (paused)');
    report.pixel7_ff = { events: r0.n, classes: r0.classes };
    await page.evaluate(() => window.__demo2.stepUntil(9.5 * 3600)); await page.waitForTimeout(600);
    await reconcile(page, 'pixel7 after step_until 09:30');
    // run: cues appear on screen
    await page.evaluate(() => window.__demo2.setRunning(true));
    let seen = { n: 0, texts: [], under: 0, legend: '', max: 0 }, most = 0;
    for (let i = 0; i < 120 && seen.n === 0; i++) { await page.waitForTimeout(150); seen = await cueLabels(page); most = Math.max(most, seen.n); }
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(500); // a paused page keeps its cue labels
    const held = await cueLabels(page); check(held.n > 0, `pixel7: cue labels stay while paused (${JSON.stringify(held.texts)})`);
    check(seen.n > 0 && seen.texts.every((t) => t.startsWith('◆ ')) && seen.legend.includes('◆＝引擎事件'), `pixel7 at 5×: in-scene event cues appear (${JSON.stringify(seen.texts)}); the legend line says what ◆ is`);
    await shot(page, 'demo2-events-pixel7-cues');
    await page.evaluate(() => window.__demo2.setRunning(true));
    // open the sheet, 事件 tab
    await page.evaluate(() => window.__demo2.openSide('events')); await page.waitForTimeout(900);
    const pane = await page.evaluate(() => { const p = document.querySelector('#pane-events'); const rows = [...p.querySelectorAll('#evCounts tr[data-evk]')].map((tr) => ({ k: tr.dataset.evk, label: tr.children[0].textContent, n: Number(tr.children[1].textContent) })); return { hidden: p.hidden, text: p.textContent, rows, lines: p.querySelectorAll('#evList .ev').length, ev: window.__demo2.events() }; });
    check(!pane.hidden && pane.rows.length >= 29 && pane.lines > 5 && pane.text.includes('引擎事件') && pane.text.includes('顯示'), `pixel7: the 事件 tab lists ${pane.rows.length} classes and ${pane.lines} recent events, labelled 引擎事件 / 顯示`);
    const empty = pane.rows.find((x) => x.k === 'source_empty'), take = pane.rows.find((x) => x.k === 'source_take'), refused = pane.rows.find((x) => x.k === 'exit_refused');
    check(empty && take && empty.n > take.n && empty.label.includes('空') && refused && refused.n === 0, `pixel7: futile trips are shown as they are (空的食源 ${empty && empty.n} vs 取食 ${take && take.n}); a class that never happened stays listed with 0`);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    const frozen = await page.evaluate(() => { const D = window.__demo2; D.openSide('events'); const p = document.querySelector('#pane-events'); return { rows: [...p.querySelectorAll('#evCounts tr[data-evk]')].map((tr) => [tr.dataset.evk, Number(tr.children[1].textContent)]), classes: D.events().classes }; });
    check(frozen.rows.every(([k, n]) => (frozen.classes[k] || 0) === n), 'pixel7 (paused): every number in the 事件 tab equals the page ledger');
    await reconcile(page, 'pixel7 after running at 5× with the 事件 tab open');
    a = await audit(page); check(a.small.length === 0 && a.noScroll, `pixel7: 事件 tab — every visible control ≥ 44 px (${a.small.join(', ') || 'none smaller'}), no horizontal scroll`);
    const cu = await cueLabels(page); check(cu.under === 0, 'pixel7: no cue label lies under the open sheet');
    await shot(page, 'demo2-events-pixel7-tab');
    check(!FORBIDDEN.test(pane.text), 'pixel7: the 事件 tab words nothing the engine does not simulate');
    // filter
    await page.tap('#pane-events button[data-evg="outside"]'); await page.waitForTimeout(300);
    const flt = await page.evaluate(() => { const p = document.querySelector('#pane-events'); return { rows: [...p.querySelectorAll('#evCounts tr[data-evk]')].map((tr) => tr.dataset.evk), lines: [...p.querySelectorAll('#evList .ev')].map((b) => b.textContent) }; });
    check(flt.rows.includes('source_empty') && !flt.rows.includes('contact_transfer') && flt.lines.length > 0 && flt.lines.every((t) => /出巢|食源|搜尋|巢口|取食|折返/.test(t)), `pixel7: the 巢外 filter narrows the table (${flt.rows.length} classes) and the list (${flt.lines.length} lines)`);
    // tap a line → that worker is selected
    const target = await page.evaluate(() => { const b = document.querySelector('#evList .ev[data-ent]'); b.scrollIntoView({ block: 'center' }); return b.dataset.ent; });
    await page.waitForTimeout(200); await page.tap(`#evList .ev[data-ent="${target}"]`); await page.waitForTimeout(400);
    const sel = await page.evaluate(() => window.__demo2.state().selected);
    check(sel === target, `pixel7: tapping a listed event selects its worker (${target})`);
    await shot(page, 'demo2-events-pixel7-filter');
    await page.evaluate(() => { window.__demo2.select(null); window.__demo2.openSide(null); });
    // 60×: the cue budget holds, counts stay exact
    await page.evaluate(async () => { await window.__demo2.setSpeed(60); await window.__demo2.setRunning(true); });
    let peak = 0, texts = new Set();
    for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); const c = await cueLabels(page); peak = Math.max(peak, c.n); c.texts.forEach((t) => texts.add(t)); check(c.n <= c.max, `pixel7 at 60×: ${c.n} cue labels ≤ budget ${c.max}`); }
    await shot(page, 'demo2-events-pixel7-60x');
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    const r60 = await reconcile(page, 'pixel7 after running at 60×');
    check(peak > 0 && r60.ev.cues_dropped > 0 && r60.ev.cues_shown > 0, `pixel7 at 60×: cues are rate-limited (${r60.ev.cues_shown} shown, ${r60.ev.cues_dropped} not shown) while the counts stay exact`);
    report.pixel7_60x = { events: r60.n, classes: r60.classes, cues_shown: r60.ev.cues_shown, cues_dropped: r60.ev.cues_dropped, cue_texts: [...texts].slice(0, 12) };
    // cues off: no cue label, counts untouched
    const before = await page.evaluate(() => JSON.stringify(window.__demo2.events().classes));
    await page.evaluate(async () => { window.__demo2.setCues(false); await window.__demo2.setSpeed(10); await window.__demo2.setRunning(true); });
    await page.waitForTimeout(3500); const off = await cueLabels(page);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(700);
    check(off.n === 0 && off.max === 0, 'pixel7: with cues switched off no cue label is drawn');
    const rOff = await reconcile(page, 'pixel7 with cues off');
    check(JSON.stringify(rOff.ev.classes) !== before, 'pixel7: the world kept running with cues off (counts advanced)');
    if (video) { await page.evaluate(async () => { window.__demo2.setCues(true); await window.__demo2.setSpeed(5); await window.__demo2.setRunning(true); }); await page.waitForTimeout(9000); await page.evaluate(() => window.__demo2.openSide('events')); await page.waitForTimeout(7000); }
    await ctx.close();
    if (video) { const dst = path.join(out, 'demo2-events-pixel7.webm'); fs.renameSync(await page.video().path(), dst); files.push(dst); }
  }

  // ---------- desktop 1440×900: the plain world (`?world=p0a2`), panel beside the scene ----------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } }, `seed=${SEED}&world=p0a2&quality=low&speed=10&tour=0`, 'desktop');
    await page.evaluate(() => window.__demo2.openSide('events'));
    let most = 0, texts = [];
    for (let i = 0; i < 14; i++) { await page.waitForTimeout(500); const c = await cueLabels(page); if (c.n > most) { most = c.n; texts = c.texts; } check(c.n <= c.max, `desktop at 10×: ${c.n} cue labels ≤ budget ${c.max}`); }
    check(most > 0, `desktop: cues appear beside the open panel (${JSON.stringify(texts)})`);
    for (let i = 0; i < 100; i++) { await page.waitForTimeout(150); if ((await cueLabels(page)).n >= 2) break; }
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    await shot(page, 'demo2-events-desktop');
    const r = await reconcile(page, 'desktop, plain world (?world=p0a2), after running at 10×');
    const txt = await page.evaluate(() => document.querySelector('#pane-events').textContent + document.querySelector('#pane-stats').textContent);
    check(!FORBIDDEN.test(txt) && r.ev.classes.queen_added === undefined, 'desktop: plain world has no roster events; nothing unsimulated is worded as happening');
    report.desktop = { events: r.n, classes: r.classes };
    await ctx.close();
  }

  // ---------- #144: cues + 事件 tab vs cues off + panel closed — same Worker messages, same world ----------
  {
    const T_CMP = 9 * 3600 + 240, Q = `seed=${SEED}&quality=low&speed=10&tour=0`;
    const on = await open({ ...devices['Pixel 7'] }, Q, '144-on', LOG), off = await open({ ...devices['Pixel 7'] }, `${Q}&cues=0`, '144-off', LOG);
    await on.page.evaluate(() => window.__demo2.openSide('events')); await on.page.waitForTimeout(2500);
    await on.page.tap('#pane-events button[data-evg="contact"]'); await on.page.waitForTimeout(800);
    await on.page.evaluate(() => { const b = document.querySelector('#evList .ev[data-ent]'); if (b) b.click(); }); await on.page.waitForTimeout(1200);
    await on.page.evaluate(() => { window.__demo2.select(null); window.__demo2.openSide(null); });
    await off.page.waitForTimeout(1500);
    const at = async (p) => p.evaluate(async (T) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(T); await new Promise((r) => setTimeout(r, 500)); const f = D.frame(); return { t: f.t_sim, json: JSON.stringify(f), log: window.__workerLog.slice(), ev: D.events() }; }, T_CMP);
    const A = await at(on.page), B = await at(off.page);
    const types = (log) => [...new Set(log.map((m) => JSON.parse(m).type))].sort().join(',');
    check(JSON.stringify(A.log) === JSON.stringify(B.log) && A.log.length > 4, `#144: the messages posted to the Worker are identical with the feature used and with it off (${A.log.length} / ${B.log.length} messages; types ${types(A.log)})`);
    check(A.t === T_CMP && B.t === T_CMP && A.json === B.json && A.json.length > 2000, `#144: the two worlds are identical at t = ${T_CMP} s (frame JSON ${A.json.length} bytes equal)`);
    check(JSON.stringify(A.ev.classes) === JSON.stringify(B.ev.classes) && A.ev.total === B.ev.total && B.ev.cues_shown === 0 && A.ev.cues_shown > 0, `#144: both pages counted the same ${A.ev.total} events; only the display differs (cues shown ${A.ev.cues_shown} vs ${B.ev.cues_shown})`);
    await on.ctx.close(); await off.ctx.close();
  }

  await browser.close();
  check(errors.length === 0, `no page or console error (${errors.slice(0, 3).join(' | ') || 'none'})`);
  console.log(JSON.stringify({ test: 'demo2-events', passed: passed.length, failed: failures, errors, files, report }, null, 2));
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
