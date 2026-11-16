/**
 * Demo 2 (web/demo2.html) — D2E-3: the food source, the environment and the 24-hour activity timeline, from engine
 * events and engine state (docs/demo2-engine-gap.md). Playwright Chromium; the NON-OFFICIAL experiment world.
 * FAILS (exit 1) on a failed check, a page error or a console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-env.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - RECONCILIATION on the real page: the page's hourly bins and source record (window.__demo2.timeline()) equal
 *    tests/lib/demo2-replay.ts replayHourly over exactly the events the page received — after the fast-forward to
 *    09:00, after stepping into the night (22:30) and after running;
 *  - Pixel 7: the scene keeps ≥ 80 % by default; the 環境 tab shows the source (stock now = the frame's; «空的» said in
 *    words; drops; arrivals with food / with none and the share), the environment (light, synthetic temperature and
 *    humidity marked 合成, rain 無資料), the behaviour variant's status, and the 24-hour chart with 24 hit columns;
 *    a tap on an hour shows that hour's numbers (= the page's bin); the table view repeats them; hours before the
 *    world began are worded so, never drawn as 0; controls ≥ 44 px, no horizontal scroll;
 *  - after dark the strip shows night hours while the exit counts go on (no day / night difference is invented or
 *    hidden); the scene label of the source says «空的» exactly when the frame's stock is 0;
 *  - #144: using the 環境 tab changes no Worker message and no world state.
 * Writes demo2-env-*.jpg (and, with DEMO2_VIDEO=1, demo2-env-pixel7.webm) into <outDir>; prints a JSON report.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const { replayHourly, replayLines } = await import('../lib/demo2-replay.ts');
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
  const SEED = 1, LINES = replayLines(SEED, 26 * 3600 * 1000);
  const KEYS = ['exit', 'empty', 'take', 'transfer', 'larva_fed', 'produce'];
  const reconcile = async (page, tag) => {
    const x = await page.evaluate(() => { const D = window.__demo2, f = D.frame(); return { tl: D.timeline(), ev: D.events(), roster: f.colony ? f.colony.queens.length + f.colony.majors.length + f.colony.eggs.length + f.colony.pupae.length : 0, stock: f.source.stock_portions }; });
    const n = x.ev.total - x.roster, rep = replayHourly(LINES, 0, n), hours = Object.keys(rep.hours).map(Number).sort((a, b) => a - b);
    const same = x.tl.bins.length === hours.length && x.tl.bins.every((b) => { const r = rep.hours[b.h]; return r && KEYS.every((k) => b.counts[k] === r[k]) && b.temp_c === r.temp_c; });
    const S = x.tl.source, R = rep.source;
    check(same, `${tag}: the page's ${x.tl.bins.length} hourly bins (counts and the hourly temperature record) == Node replay of the same ${n} events`);
    check(S.drops === R.drops && S.dropped_up === R.dropped_up && S.arrivals_take === R.arrivals_take && S.arrivals_empty === R.arrivals_empty && S.taken_up === R.taken_up, `${tag}: the source record == replay (滴出 ${S.drops}，到場有取食 ${S.arrivals_take}，到場是空的 ${S.arrivals_empty})`);
    return x;
  };
  const audit = (page) => page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.bottom > 0 && r.top < innerHeight && !e.closest('[hidden]'); };
    const small = [...document.querySelectorAll('button, select, a.btn, input[type=text], summary')].filter(vis).map((e) => ({ id: e.id || e.textContent.trim().slice(0, 8), r: e.getBoundingClientRect() })).filter((x) => x.r.width < 43.5 || x.r.height < 43.5).map((x) => `${x.id} ${x.r.width.toFixed(0)}×${x.r.height.toFixed(0)}`);
    return { small, noScroll: document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth, layout: window.__demo2.layout() };
  });
  const paneOf = (page) => page.evaluate(() => { const p = document.querySelector('#pane-env'), svg = p.querySelector('#tlBox svg'); return { hidden: p.hidden, text: p.textContent, source: p.querySelector('#envSource').textContent, now: p.querySelector('#envNowT').textContent, variant: p.querySelector('#envVariant').textContent, hits: svg ? svg.querySelectorAll('.tl-hit').length : 0, bars: svg ? svg.querySelectorAll('path[data-m]').length : 0, svgW: svg ? svg.getBoundingClientRect().width : 0, paneW: p.clientWidth, light: svg ? [...svg.querySelectorAll('rect[data-light]')].map((r) => r.dataset.light) : [], tip: p.querySelector('#tlTip').textContent, frame: window.__demo2.frame() }; });

  // ---------- Pixel 7 ----------
  {
    const video = process.env.DEMO2_VIDEO === '1', opts = { ...devices['Pixel 7'] };
    const { ctx, page } = await open(video ? { ...opts, recordVideo: { dir: out, size: opts.viewport } } : opts, `seed=${SEED}&quality=low&speed=10&tour=0&autostart=0`, 'pixel7');
    let a = await audit(page);
    check(a.layout.sheet === 'peek' && a.layout.scene_fraction >= 0.8, `pixel7: the scene keeps ${(a.layout.scene_fraction * 100).toFixed(1)} % of the page height by default (≥ 80 %)`);
    await reconcile(page, 'pixel7 after the fast-forward to 09:00');
    await page.evaluate(() => window.__demo2.openSide('env')); await page.waitForTimeout(900);
    let p = await paneOf(page);
    const stock = p.frame.source.stock_portions;
    check(!p.hidden && p.hits === 24 && p.bars > 20 && p.svgW <= p.paneW && p.svgW > 250, `pixel7: the 環境 tab shows the 24-hour chart (24 hour columns, ${p.bars} bars, ${Math.round(p.svgW)} px wide inside the ${p.paneW} px sheet)`);
    check((stock <= 0 ? p.source.includes('空的') && p.source.includes('0 份') : p.source.includes(`${stock >= 0.1 ? stock.toFixed(2) : stock.toFixed(3)} 份`)) && p.source.includes('到場是空的') && /占到場的 \d+%/.test(p.source) && p.source.includes('滴出'), `pixel7: the source table shows the engine's stock now (${stock}) and the arrivals that found it empty`);
    check(p.now.includes('合成') && p.now.includes(`${p.frame.env.temperature_c.toFixed(1)}°C`) && p.now.includes('無資料（情境沒有雨') && p.now.includes('沒有任何決定讀它') && p.text.includes('不是觀測') && p.variant.includes(p.frame.model.variant_status), 'pixel7: temperature and humidity are marked 合成, rain is 無資料, the behaviour variant\'s own status text is shown');
    check(p.light.filter((x) => x === 'none').length === 14 && p.text.includes('世界開始之前') && p.light.slice(14).every((x) => x !== 'none'), 'pixel7: the 14 hours before the world began are worded so (not drawn as zero); every hour since has a light state');
    check(!/費洛蒙|下雨了|躲雨|蚜蟲數|花蜜量|獵物/.test(p.text.replace('半翅目、花蜜、獵物尚未模擬', '')), 'pixel7: nothing unsimulated is worded as present');
    a = await audit(page); check(a.small.length === 0 && a.noScroll, `pixel7: 環境 tab — every visible control ≥ 44 px (${a.small.join(', ') || 'none smaller'}), no horizontal scroll`);
    await shot(page, 'demo2-env-pixel7-tab');
    // tap an hour → that hour's numbers
    await page.evaluate(() => document.querySelector('#tlBox').scrollIntoView({ block: 'center' })); await page.waitForTimeout(300);
    const box = await page.evaluate(() => { const r = document.querySelector('#tlBox svg').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    const col = 20; await page.touchscreen.tap(box.x + ((col + 0.5) / 24) * box.w, box.y + box.h * 0.4); await page.waitForTimeout(400);
    const tip = await page.evaluate(() => ({ tip: document.querySelector('#tlTip').textContent, tl: window.__demo2.timeline() }));
    const hour = tip.tl.hours[col], bin = tip.tl.bins.find((b) => b.h === hour);
    check(!!bin && tip.tip.includes(`${String(hour % 24).padStart(2, '0')}:00`) && tip.tip.includes(`出巢 ${bin.counts.exit}`) && tip.tip.includes(`到食源：是空的 ${bin.counts.empty}`) && tip.tip.includes(`到食源：有取食 ${bin.counts.take}`) && tip.tip.includes('（合成）'), `pixel7: tapping hour ${hour} shows its numbers (出巢 ${bin && bin.counts.exit}，空的 ${bin && bin.counts.empty}，取食 ${bin && bin.counts.take})`);
    await shot(page, 'demo2-env-pixel7-chart');
    await page.evaluate(() => { const d = document.querySelector('#tlDetails'); d.open = true; d.dispatchEvent(new Event('toggle')); }); await page.waitForTimeout(600);
    const tbl = await page.evaluate(() => ({ rows: document.querySelectorAll('#tlTable tr').length, text: document.querySelector('#tlTable').textContent }));
    check(tbl.rows === 11 && tbl.text.includes(`${bin.counts.exit}`), `pixel7: the table view repeats the numbers (${tbl.rows - 1} hours of data)`);
    // into the night: the world goes on, the strip shows night, exits continue
    await page.evaluate(() => { document.querySelector('#tlDetails').open = false; return window.__demo2.stepUntil(22.5 * 3600); }); await page.waitForTimeout(1500);
    const xn = await reconcile(page, 'pixel7 after stepping to 22:30');
    p = await paneOf(page);
    const nightBins = xn.tl.bins.filter((b) => b.h >= 20 && b.h <= 21), dayBins = xn.tl.bins.filter((b) => b.h >= 12 && b.h <= 13);
    check(p.now.includes('夜') && p.light.filter((x) => x === 'night').length >= 3 && p.light.filter((x) => x === 'day').length >= 10, `pixel7 at 22:30: the engine's light state is night; the strip shows ${p.light.filter((x) => x === 'night').length} night hours and ${p.light.filter((x) => x === 'day').length} day hours`);
    check(nightBins.every((b) => b.counts.exit > 0) && dayBins.every((b) => b.counts.exit > 0), `pixel7: the chart shows what the engine did — exits at night (${nightBins.map((b) => b.counts.exit)}) as by day (${dayBins.map((b) => b.counts.exit)}); nothing is dimmed or added for the night`);
    report.pixel7 = { source: xn.tl.source, exits_by_hour: xn.tl.bins.map((b) => b.counts.exit), empty_by_hour: xn.tl.bins.map((b) => b.counts.empty), take_by_hour: xn.tl.bins.map((b) => b.counts.take) };
    await shot(page, 'demo2-env-pixel7-night');
    // the source label in the scene (surface view): 空的 exactly when the frame's stock is 0
    // (the camera is aimed at the source, 2 m from the nest along the display route: display only)
    const aim = () => { const D = window.__demo2, s = D.ants().find((x) => x.place === '食源'); const t = s ? [s.x, 0, s.z] : [176, 0, -76]; D.view([t[0], 130, t[2] + 150], t); };
    await page.evaluate(() => { window.__demo2.openSide(null); window.__demo2.setView('surface'); }); await page.evaluate(aim); await page.waitForTimeout(1500);
    const lab = await page.evaluate(() => ({ t: (window.__demo2.labelRects().find((x) => x.key === 'host') || {}).text || '', stock: window.__demo2.frame().source.stock_portions }));
    check(lab.t.includes('蜜露來源（引擎）') && (lab.stock <= 0 ? lab.t.includes('空的') : !lab.t.includes('空的') && lab.t.includes('份')), `pixel7: the source's scene label says what the engine has (「${lab.t}」, stock ${lab.stock})`);
    await shot(page, 'demo2-env-pixel7-surface');
    if (video) { await page.evaluate(async () => { const D = window.__demo2; D.setView('full'); await D.setSpeed(30); await D.setRunning(true); D.openSide('env'); }); await page.waitForTimeout(9000); await page.evaluate(() => document.querySelector('#tlBox').scrollIntoView({ block: 'center' })); await page.waitForTimeout(7000); await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(800); await reconcile(page, 'pixel7 after running at 30× with the 環境 tab open'); }
    await ctx.close();
    if (video) { const dst = path.join(out, 'demo2-env-pixel7.webm'); fs.renameSync(await page.video().path(), dst); files.push(dst); }
  }

  // ---------- desktop ----------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } }, `seed=${SEED}&quality=low&speed=30&tour=0&view=surface`, 'desktop');
    await page.evaluate(() => window.__demo2.openSide('env')); await page.waitForTimeout(6000);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    await reconcile(page, 'desktop after running at 30×');
    const box = await page.evaluate(() => { document.querySelector('#tlBox').scrollIntoView({ block: 'center' }); const r = document.querySelector('#tlBox svg').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await page.mouse.move(box.x + (22.5 / 24) * box.w, box.y + box.h * 0.5); await page.waitForTimeout(400);
    await page.evaluate(() => { const D = window.__demo2; D.view([176, 70, -4], [176, 0, -76]); }); await page.waitForTimeout(1500);
    const d = await page.evaluate(() => ({ tip: document.querySelector('#tlTip').textContent, host: (window.__demo2.labelRects().find((x) => x.key === 'host') || {}).text || '', stock: window.__demo2.frame().source.stock_portions }));
    check(/第 0 天 \d\d:00/.test(d.tip) && d.tip.includes('出巢 '), `desktop: hovering an hour shows its numbers (「${d.tip.slice(0, 60)}…」)`);
    check(d.host.includes('合成情境') && d.host.includes('寄主植物外形＝裝飾') && (d.stock <= 0 ? d.host.includes('現在是空的') : d.host.includes('存量')), `desktop: the source label names the data class and the engine's stock (「${d.host}」)`);
    await shot(page, 'demo2-env-desktop');
    await ctx.close();
  }

  // ---------- #144 ----------
  {
    const T_CMP = 9 * 3600 + 300, Q = `seed=${SEED}&quality=low&speed=10&tour=0`;
    const on = await open({ ...devices['Pixel 7'] }, Q, '144-on', LOG), off = await open({ ...devices['Pixel 7'] }, Q, '144-off', LOG);
    await on.page.evaluate(() => window.__demo2.openSide('env')); await on.page.waitForTimeout(2000);
    const b = await on.page.evaluate(() => { document.querySelector('#tlBox').scrollIntoView({ block: 'center' }); const r = document.querySelector('#tlBox svg').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
    await on.page.touchscreen.tap(b.x + b.w * 0.9, b.y + b.h * 0.5); await on.page.waitForTimeout(600);
    await on.page.evaluate(() => { const d = document.querySelector('#tlDetails'); d.open = true; d.dispatchEvent(new Event('toggle')); }); await on.page.waitForTimeout(800);
    await on.page.evaluate(() => window.__demo2.openSide(null)); await off.page.waitForTimeout(500);
    const at = async (p) => p.evaluate(async (T) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(T); await new Promise((r) => setTimeout(r, 500)); const f = D.frame(); return { t: f.t_sim, json: JSON.stringify(f), log: window.__workerLog.slice() }; }, T_CMP);
    const A = await at(on.page), B = await at(off.page);
    check(JSON.stringify(A.log) === JSON.stringify(B.log) && A.log.length > 4, `#144: the messages posted to the Worker are identical with the 環境 tab used and never opened (${A.log.length} messages)`);
    check(A.t === T_CMP && B.t === T_CMP && A.json === B.json && A.json.length > 2000, `#144: the two worlds are identical at t = ${T_CMP} s (frame JSON ${A.json.length} bytes equal)`);
    await on.ctx.close(); await off.ctx.close();
  }

  await browser.close();
  check(errors.length === 0, `no page or console error (${errors.slice(0, 3).join(' | ') || 'none'})`);
  console.log(JSON.stringify({ test: 'demo2-env', passed: passed.length, failed: failures, errors, files, report }, null, 2));
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
