/**
 * Browser check of the read-only viewer (NOT part of CI: needs a local Chromium + Playwright).
 * Opens the viewer on a desktop (1280x800) and a phone (390x844, touch, DPR 3) viewport, checks: no page errors,
 * the official Day14 snapshot loads, clicking an ant shows its record, the experiment replay loads, an ant caught
 * between two recorded points can be selected and is labelled as display interpolation, and the nest view renders.
 * Screenshots go to the directory given as the first argument.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/web-viewer.check.cjs <outDir> http://localhost:8781/
 */
const { chromium } = require('playwright');
(async () => {
  const out = process.argv[2], base = process.argv[3] || 'http://localhost:8781/';
  const browser = await chromium.launch(), errors = [], results = {};
  for (const [name, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }]]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch, deviceScaleFactor: vp.deviceScaleFactor || 1 });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
    await page.goto(base); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('Day14'));
    const off = await page.evaluate(() => window.antempireViewer.antsOnScreen());
    await page.mouse.click(off[0].x, off[0].y);
    const offInfo = await page.$eval('#info', (e) => e.textContent);
    await page.screenshot({ path: `${out}/${name}-official.png`, fullPage: true });
    const val = await page.$eval('#mode', (s) => s.options[1].value);
    await page.selectOption('#mode', val); await page.waitForFunction(() => document.getElementById('badge').textContent.includes('實驗世界'));
    // find a minute on day 6 where some ant is between recorded points (walking)
    let moving = null;
    for (let m = 0; m <= 60 && !moving; m += 0.5) {
      await page.$eval('#day', (el) => { el.value = '6'; el.dispatchEvent(new Event('input')); });
      await page.$eval('#minute', (el, v) => { el.value = String(v); el.dispatchEvent(new Event('input')); }, m);
      const a = await page.evaluate(() => window.antempireViewer.antsOnScreen());
      moving = a.find((x) => x.interpolated) ? { m, ant: a.find((x) => x.interpolated) } : null;
    }
    if (moving) await page.mouse.click(moving.ant.x, moving.ant.y);
    const expInfo = await page.$eval('#info', (e) => e.textContent);
    await page.screenshot({ path: `${out}/${name}-experiment-walking.png`, fullPage: true });
    await page.selectOption('#view', 'nest'); await page.screenshot({ path: `${out}/${name}-nest.png` });
    results[name] = { official_click: off[0].id, official_info_shows_id: offInfo.includes(off[0].id), walking_minute: moving?.m, walking_ant: moving?.ant.id, experiment_info_shows_id: moving ? expInfo.includes(moving.ant.id) : false, info_mentions_interpolation: expInfo.includes('顯示插值') };
    await ctx.close();
  }
  await browser.close();
  console.log(JSON.stringify({ results, errors }, null, 1));
  if (errors.length || Object.values(results).some((r) => !r.official_info_shows_id || !r.experiment_info_shows_id)) process.exit(1);
})();
