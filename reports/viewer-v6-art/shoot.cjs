/**
 * V6 art scene screenshots (game view, read-only replay): opening view, analysis layers on, follow — desktop 1280x800
 * and Pixel 7. Usage: npm run web:build && node cli/web-serve.ts 8781 &  node reports/viewer-v6-art/shoot.cjs http://localhost:8781/
 */
const path = require('node:path');
const { chromium, devices } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://localhost:8781/', out = path.join(__dirname, 'screenshots'), errors = [];
  const browser = await chromium.launch();
  for (const [tag, opt] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', { ...devices['Pixel 7'] }]]) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e}`));
    await page.goto(base);
    await page.waitForFunction(() => window.__game && window.__game.ants().some((a) => a.sx !== null), null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(out, `${tag}-1-opening.png`) });
    await page.click('#layersBtn'); for (const id of ['layerEngine', 'layerLabels', 'layerRoutes', 'layerIds', 'layerChips']) await page.check('#' + id);
    await page.screenshot({ path: path.join(out, `${tag}-2-layers-open.png`) });
    await page.click('#layersBtn'); await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(out, `${tag}-3-overlay.png`) });
    for (const id of ['layerEngine', 'layerLabels', 'layerRoutes', 'layerIds', 'layerChips']) await page.evaluate((i) => { const el = document.getElementById(i); el.checked = false; el.dispatchEvent(new Event('change')); }, id);
    await page.waitForFunction(() => window.__game.ants().some((a) => a.sx !== null && a.vis === 'walking'), null, { timeout: 30000 });
    const a = (await page.evaluate(() => window.__game.ants())).find((x) => x.sx !== null && x.vis === 'walking');
    if (tag === 'pixel7') await page.touchscreen.tap(a.sx, a.sy); else await page.mouse.click(a.sx, a.sy);
    await page.click('#followBtn'); await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, `${tag}-4-follow.png`) });
    await ctx.close();
  }
  await browser.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('ok');
})();
