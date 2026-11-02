/**
 * Browser smoke test of the read-only viewer (needs Chromium + Playwright; runs in CI as the "viewer-smoke" job and
 * locally). Desktop (1280x800) and phone (390x844, touch, DPR 3). FAILS (exit 1) when any check fails:
 *  - no page errors; the official Day14 snapshot loads; clicking an ant shows its record;
 *  - every experiment loads with the "非正式" badge, and the official snapshot is restored when switching back
 *    (same living workers as the save, no timeline): the two worlds never mix;
 *  - an ant caught between two recorded points is found, selected, and its panel shows the label
 *    「位置為顯示插值」 — a missing label fails the test;
 *  - day crossing: the ants drawn at the start of day d+1 are exactly the engine's end-of-day-d workers (from the
 *    exported data, read here independently of the page);
 *  - death and eclosion: a worker that dies on day d is drawn on day d and not on day d+1; a worker that ecloses on
 *    day d appears only from day d+1;
 *  - replay boundaries: the last day's last minute renders without errors, and playing at the end stops.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-viewer.check.cjs <outDir> http://localhost:8781/
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const DATA = path.join(__dirname, '..', '..', 'web', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

(async () => {
  const out = process.argv[2], base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const index = read('index.json'), official = read(index.official), failures = [], errors = [];
  const check = (cond, msg) => { if (!cond) failures.push(msg); };
  const browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }]]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    const V = (fn, ...a) => page.evaluate(fn, ...a);
    const setDay = async (d, m) => { await page.$eval('#day', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, d); await page.$eval('#minute', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, m); };
    const drawn = async () => (await V(() => window.antempireViewer.antsOnScreen())).map((a) => a.id).sort();
    await page.goto(base); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));
    // official snapshot
    const aliveSaved = official.workers.filter((w) => w.status === 'alive').map((w) => w.id).sort();
    const off = await V(() => window.antempireViewer.antsOnScreen());
    check(JSON.stringify(off.map((a) => a.id).sort()) === JSON.stringify(aliveSaved), `${name}: official ants = living workers of the save`);
    await page.mouse.click(off[0].x, off[0].y);
    check((await page.$eval('#info', (e) => e.textContent)).includes(off[0].id), `${name}: clicking an official ant shows its record`);
    await page.screenshot({ path: `${out}/${name}-official.png`, fullPage: true });
    for (const meta of index.experiments) {
      const exp = read(meta.file), ndays = exp.days.length;
      await page.selectOption('#mode', meta.id); await page.waitForFunction((t) => document.getElementById('badge').textContent.includes(t), meta.title);
      check((await page.$eval('#badge', (e) => e.textContent)).includes('非正式'), `${name} ${meta.id}: experiment badge says 非正式`);
      // interpolation label: find an ant between two recorded points, select it, require the label
      let moving = null;
      for (let d = 1; d <= Math.min(ndays, 8) && !moving; d++) for (let m = 0; m <= 120 && !moving; m += 1) {
        await setDay(d, m);
        const a = (await V(() => window.antempireViewer.antsOnScreen())).find((x) => x.interpolated);
        if (a) moving = { d, m, a };
      }
      if (meta.id === index.experiments[0].id) check(!!moving, `${name} ${meta.id}: an ant between recorded points was found`);
      if (moving) {
        await page.mouse.click(moving.a.x, moving.a.y);
        const sel = await V(() => window.antempireViewer.selected()), info = await page.$eval('#info', (e) => e.textContent);
        check(sel === moving.a.id, `${name} ${meta.id}: the moving ant ${moving.a.id} can be selected (got ${sel})`);
        check(info.includes('位置為顯示插值'), `${name} ${meta.id}: the selected moving ant is labelled 「位置為顯示插值」`);
        if (meta.id === index.experiments[0].id) await page.screenshot({ path: `${out}/${name}-experiment-walking.png`, fullPage: true });
      }
      // V2 layers: task colours follow the engine's day task; the legend explains them
      await page.check('#ovTask'); await setDay(3, 30);
      const tasks = await V(() => window.antempireViewer.antsOnScreen());
      check(tasks.length === read(meta.file).days[1].end_state.workers.length && tasks.every((a) => a.task === (exp.days[2].tasks?.[a.id]?.task ?? read(meta.file).days[1].end_state.workers.find((w) => w.id === a.id)?.task)), `${name} ${meta.id}: ants coloured by the engine's day-3 task`);
      const legend = await page.$eval('#legend', (e) => e.textContent);
      check(legend.includes('覓食') && legend.includes('費洛蒙') && legend.includes('本日開始時'), `${name} ${meta.id}: legend explains task colours and the pheromone scale`);
      await page.uncheck('#ovTask');
      // day crossing, deaths and eclosions (expectations from the exported engine data, not from the page)
      for (let d = 1; d < ndays; d++) {
        const day = exp.days[d - 1], died = day.events.filter((e) => e.type === 'worker_death').map((e) => e.id), born = day.events.filter((e) => e.type === 'eclosion').map((e) => e.new_worker_id);
        if (!died.length && !born.length && d % 7) continue;
        const w = day.window_minutes ?? 360;
        await setDay(d, w); const inWindow = await drawn();
        check(JSON.stringify(inWindow) === JSON.stringify((d === 1 ? exp.day0.state : exp.days[d - 2].end_state).workers.map((x) => x.id).sort()), `${name} ${meta.id}: inside the window of day ${d} the start-of-day colony is drawn`);
        await setDay(d, w + 1); const settled = await drawn();
        check((await page.$eval('#timeLabel', (e) => e.textContent)).includes('日終結算後'), `${name} ${meta.id}: the settlement step is labelled, not shown as a clock minute`);
        await setDay(d + 1, 0); const next = await drawn();
        check(JSON.stringify(settled) === JSON.stringify(day.end_state.workers.map((x) => x.id).sort()), `${name} ${meta.id}: after the day-${d} settlement the engine's end-of-day workers are drawn`);
        check(JSON.stringify(next) === JSON.stringify(settled), `${name} ${meta.id}: day ${d + 1} starts with exactly the settled day-${d} colony`);
        for (const x of died) check(inWindow.includes(x) && !settled.includes(x), `${name} ${meta.id}: ${x} (died day ${d}) drawn during the window, gone after the settlement`);
        for (const x of born) check(!inWindow.includes(x) && settled.includes(x), `${name} ${meta.id}: ${x} (eclosed day ${d}) appears at the settlement of day ${d}`);
      }
      // replay boundary: last minute of the last day, then play stops at the end
      const lastW = (exp.days[ndays - 1].window_minutes ?? 360) + 1;
      await setDay(ndays, lastW);
      check((await V(() => window.antempireViewer.state())).day === ndays, `${name} ${meta.id}: last day renders`);
      await page.selectOption('#speed', '60'); await page.click('#play'); await page.waitForTimeout(600);
      const st = await V(() => window.antempireViewer.state());
      check(st.day === ndays && st.minute <= lastW + 1e-9 && (await page.$eval('#play', (e) => e.textContent)) === '播放', `${name} ${meta.id}: playing at the end of the replay stops at day ${ndays} minute ${lastW}`);
    }
    await page.selectOption('#view', 'nest'); await page.screenshot({ path: `${out}/${name}-nest.png` }); await page.selectOption('#view', 'garden');
    // back to the official world: nothing from the experiments remains
    await page.selectOption('#mode', 'official'); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));
    const back = await V(() => window.antempireViewer.state());
    check(back.official === true && JSON.stringify([...back.workers].sort()) === JSON.stringify(aliveSaved) && (await page.$eval('#timeline', (e) => e.hidden)), `${name}: switching back restores the official snapshot (no timeline, saved workers only)`);
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({ failures, errors }, null, 1));
  if (errors.length || failures.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
