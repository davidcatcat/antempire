/**
 * V4 browser E2E: daily ecology charts and derived walking speed, desktop (1280x900, mouse) and Android phone profile
 * (Playwright "Pixel 7", touch; an emulation, not a physical phone). Expectations come from web/data, read here
 * independently of the page. FAILS (exit 1) on any failed check or page error.
 *  - every chart is drawn; hovering (desktop) or tapping a chart shows that day's engine values; a click/tap moves the
 *    map to that day; the table view lists Day0 + every simulated day; the official snapshot has no daily series;
 *  - a walking worker's panel shows the derived speed = recorded edge length / recorded time, labelled as an average
 *    from a game-assumption length; no horizontal page scroll on the phone.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-stats.check.cjs <outDir> http://localhost:8781/
 */
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');
const DATA = path.join(__dirname, '..', '..', 'web', 'data');
const read = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8'));

(async () => {
  const out = process.argv[2], base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const index = read('index.json'), meta = index.experiments.find((e) => e.id.includes('A4')) ?? index.experiments[0], exp = read(meta.file);
  const failures = [], errors = [], passed = [], check = (c, m) => (c ? passed : failures).push(m);
  const browser = await chromium.launch();
  for (const [name, opts] of [['desktop', { viewport: { width: 1280, height: 900 } }], ['android', { ...devices['Pixel 7'] }]]) {
    const ctx = await browser.newContext(opts), page = await ctx.newPage(), touch = !!opts.hasTouch;
    page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    const V = (fn, ...a) => page.evaluate(fn, ...a);
    const setDay = async (d, m) => { await page.$eval('#day', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, d); await page.$eval('#minute', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, m); };
    await page.goto(new URL('analysis.html', base).href); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));
    check((await page.$eval('#stats', (e) => e.textContent)).includes('沒有每日序列') && (await page.$$('#stats svg')).length === 0, `${name}: the official snapshot shows no daily series`);
    await page.selectOption('#mode', meta.id); await page.waitForFunction((id) => window.antempireViewer.state().mode === id, meta.id);
    await setDay(12, 0);
    const charts = await page.$$eval('#stats svg[data-chart]', (s) => s.map((x) => x.dataset.chart));
    check(charts.length === 5, `${name}: five daily charts are drawn (${charts.join(', ')})`);
    // hover / tap on the workers chart at ~80 %: readout = that day's engine values; tap/click moves the map there
    const svg = await page.$('#stats svg[data-chart="workers"]'); await svg.evaluate((e) => e.scrollIntoView({ block: 'end' })); await page.waitForTimeout(100);
    const bb = await svg.boundingBox(), px = bb.x + bb.width * 0.8, py = bb.y + bb.height / 2;
    if (touch) await page.touchscreen.tap(px, py); else { await page.mouse.move(px, py); await page.mouse.click(px, py); }
    const st = await V(() => window.antempireViewer.state()), ro = await page.$eval('#stats figure[data-chart="workers"] .readout', (e) => e.textContent);
    const want = st.day === 0 ? exp.day0.state.workers.length : exp.days[st.day - 1].end_state.workers.length;
    check(st.day > 12 && st.minute === 0 && ro.startsWith(`D${st.day}（`) && ro.includes(`工蟻 ${want} 隻`), `${name}: ${touch ? 'tapping' : 'clicking'} the chart moves the map to day ${st.day} and reads ${want} workers from the engine record (${ro})`);
    await page.screenshot({ path: `${out}/${name}-stats.png` });
    // table view
    await (touch ? page.locator('#statsTable').tap() : page.click('#statsTable'));
    const rows = await page.$$eval('#stats tbody tr', (r) => r.length);
    check(rows === exp.days.length + 1, `${name}: the table lists Day0 and every simulated day (${rows})`);
    await (touch ? page.locator('#statsChart').tap() : page.click('#statsChart'));
    // derived speed of a walking worker (A1: workers walk from day 1)
    const spMeta = index.experiments.find((e) => e.id.includes('A1')) ?? index.experiments[0], spExp = read(spMeta.file);
    await page.selectOption('#mode', spMeta.id); await page.waitForFunction((id) => window.antempireViewer.state().mode === id, spMeta.id);
    let walker = null, at = null;
    for (let d = 1; d <= 6 && !walker; d++) for (let m = 1; m <= 150 && !walker; m += 1) { await setDay(d, m); walker = (await V(() => window.antempireViewer.antsOnScreen())).find((a) => a.interpolated); if (walker) at = { d, m }; }
    check(!!walker, `${name}: a walking worker was found`);
    if (walker) {
      await page.selectOption('#who', walker.id);
      const sp = await V((id) => window.antempireViewer.speed(id), walker.id), info = await page.$eval('#info', (e) => e.textContent);
      const link = sp && spExp.map.links.find((l) => (l.from === sp.from && l.to === sp.to) || (l.from === sp.to && l.to === sp.from));
      const expect = link && typeof link.length_cm === 'number' ? (link.length_cm * 10) / ((sp.t1 - sp.t0) * 60) : null;
      check(sp && sp.mm_s === expect && (expect === null ? info.includes('速度未知') : info.includes(`${expect.toFixed(2)} mm/s`) && info.includes('不是瞬時速度') && info.includes('非量測')), `${name}: ${walker.id} (day ${at.d} minute ${at.m}) shows the derived speed ${expect === null ? 'unknown' : expect.toFixed(2) + ' mm/s'} with its basis`);
    }
    if (touch) check(await V(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no horizontal page scroll`);
    await ctx.close();
  }
  await browser.close();
  const summary = { suite: 'web-stats (V4)', passed: passed.length, failures, errors };
  fs.writeFileSync(path.join(out, 'web-stats-results.json'), JSON.stringify({ ...summary, checks: passed }, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  if (errors.length || failures.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
