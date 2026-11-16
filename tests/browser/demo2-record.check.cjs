/**
 * Demo 2 (web/demo2.html) — D2E-2: the individual card built from ONE worker's own engine record
 * (docs/demo2-engine-gap.md). Playwright Chromium; the NON-OFFICIAL experiment world. FAILS (exit 1) on a failed check,
 * a page error or a console error.
 *   npm run web:build && node cli/web-serve.ts 8787 &  node tests/browser/demo2-record.check.cjs <outDir> http://localhost:8787/
 * Checks:
 *  - Pixel 7: selecting a worker keeps the scene ≥ 80 % of the page height (compact card); 詳情 opens the record in the
 *    sheet's 個體 tab: «為什麼牠這樣做», what the ant does not know, its contacts, the larvae it touched, crop and route
 *    memory, hunger diagnostics (labelled 診斷, no death wording), traits, its own events;
 *  - the numbers on the card equal the Worker's record of THAT worker (window.__demo2.record().followed) and the
 *    page's per-individual totals equal the Node replay of the same events (tests/lib/demo2-replay.ts);
 *  - 下一隻 switches the record to the next worker; a larva's card shows its gut, signal and carers' contacts;
 *  - desktop: the record sits in the floating card in its own scroll box, inside the viewport;
 *  - #144: a page that selects, follows and reads records and a page that never does send the Worker the same messages
 *    except `follow` (an existing observation command), and the two worlds are identical at the same instant.
 * Writes demo2-record-*.jpg (and, with DEMO2_VIDEO=1, demo2-record-pixel7.webm) into <outDir>; prints a JSON report.
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

(async () => {
  const out = process.argv[2] || 'demo2-shots', base = process.argv[3] || 'http://localhost:8787/';
  fs.mkdirSync(out, { recursive: true });
  const { replayOwn, replayLines } = await import('../lib/demo2-replay.ts');
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
  const SEED = 1, LINES = replayLines(SEED, 14 * 3600 * 1000);
  /** the record tab's text, the Worker's record as the page holds it, and the page's own totals for the selected worker */
  const read = (page) => page.evaluate(() => { const D = window.__demo2, r = D.record(), f = D.frame(), w = f.workers.find((x) => x.id === r.selected); const el = document.querySelector('#antRec'); return { r, w, text: el.textContent, html: el.innerHTML, base: document.querySelector('#antBase').textContent, ev: D.events(), roster: f.colony ? f.colony.queens.length + f.colony.majors.length + f.colony.eggs.length + f.colony.pupae.length : 0, layout: D.layout() }; });
  const sameAsWorker = (x, tag) => {
    const rec = x.r.followed;
    check(!!rec && rec.id === x.r.selected && x.r.observed === x.r.selected && rec.kind === 'p0a2_worker', `${tag}: the Worker reports the record of the selected worker (${x.r.selected})`);
    if (!rec) return;
    const loaded = rec.contacts.filter((c) => c.loaded).length;
    check(x.text.includes(`紀錄中的接觸${rec.contacts.length} 筆（其中來自滿載回巢者 ${loaded} 筆）`) && x.text.includes(`紀錄中的幼蟲接觸${rec.begging.length} 筆`) && x.text.includes(`覓食門檻${rec.theta_forage.toFixed(2)}`) && x.text.includes(`育幼門檻${rec.theta_brood.toFixed(2)}`) && x.text.includes(`連續到場是空的${rec.empty_streak} 次`), `${tag}: the card's numbers are the Worker's record (contacts ${rec.contacts.length}, larva contacts ${rec.begging.length}, θ ${rec.theta_forage.toFixed(2)}, empty streak ${rec.empty_streak})`);
    const n = x.ev.total - x.roster, own = replayOwn(LINES, 0, n).workers[x.r.selected] || {}, t = x.r.totals;
    check(['exits', 'takes', 'empties', 'taken_up', 'gave', 'gave_up', 'got', 'got_up', 'fed_larvae', 'fed_up', 'woken', 'contacts_made', 'contacted_by'].every((k) => (own[k] || 0) === t[k]), `${tag}: ${x.r.selected}'s totals on the page == Node replay of the same ${n} events (出巢 ${t.exits}, 空的 ${t.empties}, 取食 ${t.takes}, 交哺 ${t.gave}, 收到 ${t.got})`);
    check(x.text.includes(`到食源：有取食／是空的${t.takes}／${t.empties} 次`) && x.text.includes(`出巢${t.exits} 次`), `${tag}: the card shows those totals (futile trips included)`);
  };
  const wording = (x, tag) => {
    check(x.text.includes('為什麼牠這樣做（只用牠自己的資訊）') && x.text.includes('工蟻不知道：全巢有多少食物') && x.text.includes('玩家視角'), `${tag}: the card explains from the ant's own information and says what the ant does not know`);
    check(x.html.includes('class="tag engine"') && x.text.includes('診斷') && x.text.includes('引擎沒有死亡模型') && !/餓死|死了|瀕死/.test(x.text), `${tag}: rows are labelled (引擎 / 診斷 / 事件); hunger is a diagnostic, no death wording`);
    check(!/費洛蒙|氣味|巢內座標是|產卵|羽化|挖掘|捕獵/.test(x.text), `${tag}: nothing unsimulated is worded as this ant's behaviour`);
  };

  // ---------- Pixel 7 ----------
  {
    const video = process.env.DEMO2_VIDEO === '1', opts = { ...devices['Pixel 7'] };
    const { ctx, page } = await open(video ? { ...opts, recordVideo: { dir: out, size: opts.viewport } } : opts, `seed=${SEED}&quality=low&speed=5&tour=0`, 'pixel7');
    await page.waitForTimeout(1500);
    // a worker that is out on a trip (most of them come back empty-handed)
    const id = await page.evaluate(() => { const f = window.__demo2.frame(); return (f.workers.find((w) => w.state === 'returning') || f.workers.find((w) => w.state === 'outbound') || f.workers[0]).id; });
    await page.evaluate((i) => window.__demo2.select(i), id); await page.waitForTimeout(1200);
    let x = await read(page);
    check(x.layout.sheet === 'peek' && x.layout.scene_fraction >= 0.8, `pixel7: with a worker selected the scene keeps ${(x.layout.scene_fraction * 100).toFixed(1)} % of the page height (compact card; ≥ 80 %)`);
    await shot(page, 'demo2-record-pixel7-card');
    await page.tap('#cardDetail'); await page.waitForTimeout(900);
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    x = await read(page);
    const vis = await page.evaluate(() => { const p = document.querySelector('#pane-ant'), r = p.getBoundingClientRect(); return !p.hidden && r.height > 80 && document.querySelector('#tabs button[data-tab="ant"]').getAttribute('aria-pressed') === 'true'; });
    check(vis && x.r.selected === id, 'pixel7: 詳情 opens the record in the sheet\'s 個體 tab');
    sameAsWorker(x, 'pixel7'); wording(x, 'pixel7');
    report.pixel7 = { id, state: x.w.state, totals: x.r.totals, contacts: x.r.followed && x.r.followed.contacts.length, why: (x.text.match(/為什麼牠這樣做（只用牠自己的資訊）(.{0,160})/) || [])[1] };
    await shot(page, 'demo2-record-pixel7-detail');
    await page.evaluate(() => window.__demo2.setSheet('full')); await page.waitForTimeout(500);
    await page.evaluate(() => { const p = document.querySelector('#pane-ant'); p.scrollTop = 520; }); await page.waitForTimeout(300);
    await shot(page, 'demo2-record-pixel7-detail-full');
    const sc = await page.evaluate(() => ({ noScroll: document.documentElement.scrollWidth <= innerWidth, paneScrolls: document.querySelector('#pane-ant').scrollHeight > document.querySelector('#pane-ant').clientHeight }));
    check(sc.noScroll && sc.paneScrolls, 'pixel7: the record scrolls inside the sheet; no horizontal scroll');
    // follow + next: the record follows the worker
    await page.evaluate(() => { window.__demo2.setSheet('half'); window.__demo2.follow(window.__demo2.state().selected); }); await page.waitForTimeout(400);
    await page.evaluate(() => window.__demo2.setRunning(true)); await page.waitForTimeout(600);
    await page.evaluate(() => document.querySelector('#cardNext') && document.querySelector('#cardNext').click());
    await page.waitForFunction(() => { const r = window.__demo2.record(); return r.followed && r.followed.id === r.selected && r.observed === r.selected; }, null, { timeout: 15000 });
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    const y = await read(page);
    check(y.r.selected !== id, `pixel7: 下一隻 moves to another worker (${id} → ${y.r.selected})`);
    sameAsWorker(y, 'pixel7 next');
    // a larva
    await page.evaluate(() => { const D = window.__demo2; D.follow(null); D.select(D.frame().larvae[0].id); D.openSide('ant'); }); await page.waitForTimeout(700);
    const lv = await page.evaluate(() => ({ text: document.querySelector('#antRec').textContent, obs: window.__demo2.record().observed, fill: window.__demo2.frame().larvae[0].gut_fill }));
    check(lv.obs === null && lv.text.includes('腸道量') && lv.text.includes(`${(lv.fill * 100).toFixed(0)}%`) && lv.text.includes('只有碰到牠的工蟻感知得到') && !/發育中|化蛹|羽化/.test(lv.text), 'pixel7: a larva\'s card shows its gut, its signal and the carers\' contacts (no Worker record is requested for it)');
    if (video) { await page.evaluate(async (i) => { const D = window.__demo2; D.openSide(null); D.select(i); await D.setRunning(true); }, id); await page.waitForTimeout(5000); await page.tap('#cardDetail'); await page.waitForTimeout(9000); }
    await ctx.close();
    if (video) { const dst = path.join(out, 'demo2-record-pixel7.webm'); fs.renameSync(await page.video().path(), dst); files.push(dst); }
  }

  // ---------- desktop ----------
  {
    const { ctx, page } = await open({ viewport: { width: 1440, height: 900 } }, `seed=${SEED}&quality=low&speed=5&tour=0`, 'desktop');
    await page.waitForTimeout(1200);
    const id = await page.evaluate(() => { const f = window.__demo2.frame(); const w = f.workers.find((x) => x.state === 'resting') || f.workers[0]; window.__demo2.select(w.id); return w.id; });
    await page.waitForFunction(() => { const r = window.__demo2.record(); return r.followed && r.followed.id === r.selected; }, null, { timeout: 15000 });
    await page.evaluate(() => window.__demo2.setRunning(false)); await page.waitForTimeout(900);
    const d = await page.evaluate(() => { const c = document.querySelector('#card'), rec = c.querySelector('.rec'), r = c.getBoundingClientRect(), rr = rec.getBoundingClientRect(); return { card: [r.left, r.top, r.right, r.bottom], recH: rr.height, scrolls: rec.scrollHeight > rec.clientHeight, text: rec.textContent, hidden: rec.hidden, follow: !!document.querySelector('#cardFollow'), rowBottom: c.querySelector('.row').getBoundingClientRect().bottom }; });
    check(!d.hidden && d.recH > 120 && d.card[3] <= 900 && d.card[1] >= 0 && d.rowBottom <= 900 && d.follow && d.text.includes('為什麼牠這樣做') && d.text.includes('工蟻不知道'), `desktop: the record is in the floating card (own scroll box ${Math.round(d.recH)} px, card inside the viewport, buttons reachable)`);
    const x = await page.evaluate(() => { const D = window.__demo2, r = D.record(), f = D.frame(); return { r, w: f.workers.find((q) => q.id === r.selected), text: document.querySelector('#card .rec').textContent, html: document.querySelector('#card .rec').innerHTML, ev: D.events(), roster: f.colony ? f.colony.queens.length + f.colony.majors.length + f.colony.eggs.length + f.colony.pupae.length : 0 }; });
    sameAsWorker(x, 'desktop'); wording(x, 'desktop');
    report.desktop = { id, state: x.w.state };
    await shot(page, 'demo2-record-desktop');
    await ctx.close();
  }

  // ---------- #144 ----------
  {
    const T_CMP = 9 * 3600 + 300, Q = `seed=${SEED}&quality=low&speed=10&tour=0`;
    const on = await open({ ...devices['Pixel 7'] }, Q, '144-on', LOG), off = await open({ ...devices['Pixel 7'] }, Q, '144-off', LOG);
    for (const k of [3, 11, 20]) { await on.page.evaluate((i) => { const D = window.__demo2; D.select(D.frame().workers[i].id); D.openSide('ant'); }, k); await on.page.waitForTimeout(900); }
    await on.page.evaluate(() => { const D = window.__demo2; D.follow(D.state().selected); }); await on.page.waitForTimeout(900);
    await on.page.evaluate(() => { const b = document.querySelector('#cardNext'); if (b) b.click(); }); await on.page.waitForTimeout(900);
    await on.page.evaluate(() => { window.__demo2.select(null); window.__demo2.openSide(null); }); await off.page.waitForTimeout(600);
    const at = async (p) => p.evaluate(async (T) => { const D = window.__demo2; await D.setRunning(false); await D.stepUntil(T); await new Promise((r) => setTimeout(r, 500)); const f = D.frame(); return { t: f.t_sim, json: JSON.stringify(f), log: window.__workerLog.slice(), obs: D.record().observed }; }, T_CMP);
    const A = await at(on.page), B = await at(off.page);
    const strip = (log, dropFollow) => log.map((m) => JSON.parse(m)).filter((m) => !(dropFollow && m.type === 'follow')).map((m) => { const { req, ...rest } = m; return JSON.stringify(rest); });
    const follows = A.log.map((m) => JSON.parse(m)).filter((m) => m.type === 'follow');
    check(follows.length >= 5 && follows[follows.length - 1].id === null && B.log.every((m) => JSON.parse(m).type !== 'follow'), `#144: reading records sent only the existing observation command (${follows.length} × follow; the other page sent none)`);
    check(JSON.stringify(strip(A.log, true)) === JSON.stringify(strip(B.log, false)), `#144: apart from follow, the messages posted to the Worker are identical (${B.log.length} messages)`);
    check(A.t === T_CMP && B.t === T_CMP && A.json === B.json && A.json.length > 2000 && A.obs === null, `#144: the two worlds are identical at t = ${T_CMP} s (frame JSON ${A.json.length} bytes equal)`);
    await on.ctx.close(); await off.ctx.close();
  }

  await browser.close();
  check(errors.length === 0, `no page or console error (${errors.slice(0, 3).join(' | ') || 'none'})`);
  console.log(JSON.stringify({ test: 'demo2-record', passed: passed.length, failed: failures, errors, files, report }, null, 2));
  process.exit(failures.length || errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
