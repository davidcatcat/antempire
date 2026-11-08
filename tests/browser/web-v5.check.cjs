/**
 * V5 browser E2E + screenshots of the read-only viewer, desktop (1280x800, mouse) and a Pixel-like phone (412x915,
 * touch, DPR 2; Chromium emulation, not a physical phone). Expectations come from web/data, read here independently of
 * the page. FAILS (exit 1) on any failed check, page error or console error. One screenshot per feature and profile:
 *   <profile>-v5-01-follow, -02-timeline, -03-stats, -03b-flows, -04-route, -05-event-map, -05b-nest, -06-official,
 *   -06b-experiment.  (profile = desktop | phone)
 * Checks:
 *  - world separation: the canvas itself carries the world mark (official / 非正式); official has no filter, route or series;
 *  - follow: select a walking worker, follow while playing (camera centred);
 *  - recorded route: every leg = an edge of a recorded walk; every shown arrival minute is an engine route_step minute;
 *  - timeline: scope 全部日子 + category filter lists exactly the matching engine events of all days; jumping to a death
 *    on another day goes to that day's settlement step (no minute); jumping to a food_collected goes to its exact minute
 *    and centres its recorded location;
 *  - event map: with a category filter, marks + 「無地點紀錄」 = the filtered events shown so far; deaths are never marked;
 *  - nest view: after the settlement, the brood named by that day's egg_laid / hatch / pupation records are highlighted;
 *  - daily flows: three charts; the table's 產卵 column = the engine day summaries; no horizontal page scroll.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-v5.check.cjs <outDir> http://localhost:8781/
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const DATA = path.join(__dirname, '..', '..', 'web', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));
const DEATH = ['worker_death', 'brood_death', 'queen_death'];
const FORAGE = ['discovery', 'scouted_empty', 'food_collected', 'food_delivered', 'forager_stopped', 'action_cancelled_no_time', 'no_route_cannot_depart', 'protein_cached_at_nest'];
const listed = (e) => e.type !== 'worker_activity' && e.type !== 'route_step';

(async () => {
  const out = process.argv[2], base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const index = read('index.json'), A1 = index.experiments.find((e) => e.id.includes('A1')) ?? index.experiments[0], exp = read(A1.file);
  const A4 = index.experiments.find((e) => e.id.includes('A4')) ?? index.experiments[0], exp4 = read(A4.file);
  const failures = [], errors = [], passed = [], shots = [], check = (c, m) => (c ? passed : failures).push(m);
  const browser = await chromium.launch();
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }], ['phone', { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 }]];
  for (const [name, opts] of profiles) {
    const ctx = await browser.newContext(opts), page = await ctx.newPage(), touch = !!opts.hasTouch;
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`); });
    const V = (fn, ...a) => page.evaluate(fn, ...a);
    const settle = () => (touch ? page.waitForTimeout(450) : null);
    const press = async (sel) => { if (touch) { await page.locator(sel).first().tap(); await settle(); } else await page.locator(sel).first().click(); };
    const setDay = async (d, m) => { await page.$eval('#day', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, d); await page.$eval('#minute', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, m); };
    const mode = async (id) => { if ((await V(() => window.antempireViewer.state().mode)) === id) return; await page.selectOption('#mode', id); await page.waitForFunction((x) => window.antempireViewer.state().mode === x && !document.getElementById('badge').textContent.includes('載入'), id); };
    const shot = async (tag, section) => {
      if (section) await page.$eval(section, (e) => (e.closest('section') ?? e).scrollIntoView({ block: 'start' })); else await V(() => window.scrollTo(0, 0));
      await page.waitForTimeout(150); const f = `${out}/${name}-v5-${tag}.png`; await page.screenshot({ path: f }); shots.push(path.basename(f));
    };
    const chip = async (cat) => press(`#evCats button[data-cat="${cat}"]`);
    await page.goto(new URL('analysis.html', base).href); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));

    // ── 6. official snapshot: world mark on the canvas; no filter chips, no route, no series ──
    check((await V(() => window.antempireViewer.worldMark())) === '正式 Day14・唯讀快照', `${name}: the official canvas carries 「正式 Day14・唯讀快照」`);
    check((await page.$$('#evCats button')).length === 0 && (await page.$eval('#route', (e) => e.textContent)).includes('正式快照') && (await page.$eval('#flows', (e) => e.textContent)).includes('沒有每日序列'), `${name}: the official snapshot has no event filter, no recorded route and no daily flows`);
    await shot('06-official');
    await mode(A1.id);
    check((await V(() => window.antempireViewer.worldMark())) === '實驗世界・非正式' && (await page.$eval('#badge', (e) => e.className)).includes('experiment'), `${name}: the experiment canvas carries 「實驗世界・非正式」 and the experiment badge`);
    await shot('06b-experiment');

    // ── 1. follow a walking worker ──
    let walker = null;
    for (let d = 2; d <= 6 && !walker; d++) for (let m = 1; m <= 200 && !walker; m += 1) { await setDay(d, m); const a = (await V(() => window.antempireViewer.antsOnScreen())).find((x) => x.interpolated); if (a) walker = { ...a, d, m }; }
    check(!!walker, `${name}: a worker between two recorded points was found`);
    if (walker) {
      await page.selectOption('#who', walker.id); await press('#follow');
      await page.selectOption('#speed', '5'); await press('#play'); await page.waitForTimeout(700); await press('#play');
      const a = (await V(() => window.antempireViewer.antsOnScreen())).find((x) => x.id === walker.id), c = await V(() => window.antempireViewer.canvasCentre());
      check((await V(() => window.antempireViewer.following())) === walker.id && a && Math.hypot(a.x - c.x, a.y - c.y) <= 2, `${name}: following ${walker.id} keeps it centred while playing`);
      await shot('01-follow');

      // ── 4. recorded route of the followed worker ──
      const st = await V(() => window.antempireViewer.state()), d = exp.days[st.day - 1];
      const legs = await V((id) => window.antempireViewer.route(id), walker.id);
      const segs = d.events.filter((e) => e.type === 'worker_activity' && e.worker === walker.id && String(e.place).includes('>'));
      const nEdges = segs.reduce((q, s) => q + String(s.place).split('>').length - 1, 0);
      const steps = d.events.filter((e) => e.type === 'route_step' && e.worker === walker.id);
      check(legs.length === nEdges && legs.every((l) => l.t1 === null || steps.some((s) => s.minute === l.t1 && s.from === l.from && s.to === l.to)), `${name}: ${walker.id} day ${st.day}: ${legs.length} route legs = the edges of its recorded walks; every arrival minute is an engine route_step`);
      const rows = await page.$$eval('#route tbody tr', (r) => r.length), txt = await page.$eval('#route', (e) => e.textContent);
      check(rows === legs.length && txt.includes('由紀錄推得') && txt.includes('不是實際軌跡'), `${name}: the route table lists every leg and labels derived values and the schematic line`);
      await press('#follow');
      await shot('04-route', '#route');
    }

    // ── 2. timeline: all days + category filter, jump across days ──
    await page.selectOption('#evScope', 'all'); await chip('death');
    const deaths = exp.days.flatMap((d) => d.events.map((e, i) => ({ d, e, i })).filter((x) => DEATH.includes(x.e.type)));
    const evRows = await page.$$eval('#events button.ev', (b) => b.map((x) => ({ i: Number(x.dataset.ev), day: Number(x.dataset.day), text: x.textContent })));
    check(evRows.length === deaths.length && evRows.every((r, k) => r.day === deaths[k].d.day && r.i === deaths[k].i && r.text.includes('日終（無時刻）')), `${name}: 全部日子 + 死亡 lists exactly the ${deaths.length} engine death records, each at its day's settlement (no minute)`);
    if (deaths.length) {
      const dc = deaths[deaths.length - 1]; await setDay(1, 10);
      await press(`#events button[data-ev="${dc.i}"][data-day="${dc.d.day}"]`);
      const s = await V(() => ({ ...window.antempireViewer.state(), jump: window.antempireViewer.lastJump() }));
      check(s.day === dc.d.day && s.minute === (dc.d.window_minutes ?? 360) + 1 && !s.jump.timed && (await page.$eval('#jump', (e) => e.textContent)).includes('日終結算'), `${name}: jumping to ${dc.e.type} ${dc.e.id} from day 1 goes to day ${dc.d.day}'s settlement step (no minute)`);
      await shot('02-timeline', '#evsec');
    }
    await chip('death'); await chip('forage');
    const food = exp.days.flatMap((d) => d.events.map((e, i) => ({ d, e, i })).filter((x) => x.e.type === 'food_collected')), fc = food[Math.floor(food.length / 2)];
    const forageCount = exp.days.reduce((q, d) => q + d.events.filter((e) => FORAGE.includes(e.type)).length, 0);
    check((await page.$$('#events button.ev')).length === forageCount, `${name}: 全部日子 + 覓食與採集 lists ${forageCount} engine records`);
    if (fc) {
      await press(`#events button[data-ev="${fc.i}"][data-day="${fc.d.day}"]`);
      const s = await V(() => ({ ...window.antempireViewer.state(), cam: window.antempireViewer.camera() })), p = exp.map.places.find((x) => x.id === fc.e.location);
      check(s.day === fc.d.day && s.minute === fc.e.minute && p.layout && Math.abs(s.cam.x - p.layout.x) < 1e-9 && Math.abs(s.cam.y - p.layout.y) < 1e-9, `${name}: jumping to food_collected (day ${fc.d.day}, minute ${fc.e.minute}) lands on the recorded minute and centres its recorded location ${fc.e.location}`);
    }

    // ── 5. event map: forage filter, after the settlement of a day ──
    const dm = exp.days.find((d) => d.events.filter((e) => FORAGE.includes(e.type)).length >= 6) ?? exp.days[0];
    await setDay(dm.day, (dm.window_minutes ?? 360) + 1);
    let mk = await V(() => window.antempireViewer.eventMarks());
    const nForage = dm.events.filter((e) => FORAGE.includes(e.type)).length;
    check(mk && mk.marks.reduce((q, m) => q + m.total, 0) + mk.noPlace === nForage && mk.marks.every((m) => Object.keys(m.byCat).every((c) => c === 'forage')), `${name}: day ${dm.day} forage marks + 無地點紀錄 = the ${nForage} forage records of that day`);
    const fcAt = {}; for (const e of dm.events) if (e.type === 'food_collected') fcAt[e.location] = (fcAt[e.location] ?? 0) + 1;
    check(Object.entries(fcAt).every(([p, n]) => (mk.marks.find((m) => m.place === p)?.total ?? 0) >= n), `${name}: every food_collected is counted at its recorded location`);
    await shot('05-event-map');
    await chip('forage'); await chip('death');
    const dDeath = exp.days.find((d) => d.events.some((e) => e.type === 'worker_death'));
    if (dDeath) { await setDay(dDeath.day, (dDeath.window_minutes ?? 360) + 1); mk = await V(() => window.antempireViewer.eventMarks()); check(mk.marks.length === 0 && mk.noPlace === dDeath.events.filter((e) => DEATH.includes(e.type)).length, `${name}: deaths (day ${dDeath.day}) are never drawn on the map, only counted as 無地點紀錄`); }
    await chip('death'); await page.selectOption('#evScope', 'day');

    // ── 5b. nest view: brood named by the day's records, after the settlement only ──
    const dEgg = exp.days.find((d) => d.events.some((e) => ['egg_laid', 'hatch', 'pupation'].includes(e.type)));
    if (dEgg) {
      const ids = dEgg.events.filter((e) => ['egg_laid', 'hatch', 'pupation'].includes(e.type)).map((e) => e.id);
      await page.selectOption('#view', 'nest'); await setDay(dEgg.day, 5);
      const before = (await V(() => window.antempireViewer.nestHighlights())).map((x) => x[0]);
      await setDay(dEgg.day, (dEgg.window_minutes ?? 360) + 1);
      const hl = (await V(() => window.antempireViewer.nestHighlights())).map((x) => x[0]);
      check(ids.every((id) => hl.includes(id)) && !ids.some((id) => before.includes(id)), `${name}: nest view highlights ${ids.join(', ')} only after day ${dEgg.day}'s settlement`);
      await shot('05b-nest'); await page.selectOption('#view', 'garden');
    }

    // ── 3. daily statistics (V4 charts) and V5 flows ──
    await mode(A4.id); await setDay(12, 0);
    await shot('03-stats', '#stats');
    const flows = await page.$$eval('#flows svg[data-chart]', (s) => s.map((x) => x.dataset.chart));
    check(flows.join() === 'flows,insects,hemiptera', `${name}: three daily flow / biota charts (${flows.join(', ')})`);
    await shot('03b-flows', '#flows');
    await press('#flowsTable');
    const eggs = await page.$$eval('#flows tbody tr', (r) => r.map((x) => x.children[1].textContent));
    check(eggs.length === exp4.days.length + 1 && eggs[0] === '—' && exp4.days.every((d, k) => eggs[k + 1] === String(d.eggs_laid)), `${name}: the flows table's 產卵 column = the engine day summaries (Day0 —)`);
    await press('#flowsChart');
    if (touch) check(await V(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no horizontal page scroll`);
    await ctx.close();
  }
  await browser.close();
  const summary = { suite: 'web-v5', passed: passed.length, failures, errors, screenshots: shots.length };
  fs.writeFileSync(path.join(out, 'web-v5-results.json'), JSON.stringify({ ...summary, checks: passed, files: shots }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length || failures.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
