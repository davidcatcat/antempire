/**
 * Art preview screenshots (drawing assets only, no simulation data). Serves this folder read-only on a free port and
 * captures the contact sheet at deviceScaleFactor 1: desktop 1280x800 and Pixel 7 (412x915 CSS px).
 *   npx tsc -p prototypes/art-preview/tsconfig.json && node prototypes/art-preview/shoot.cjs
 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium, devices } = require('playwright');
const ROOT = __dirname, OUT = path.join(ROOT, 'screenshots'), TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
fs.mkdirSync(OUT, { recursive: true }); // git-ignored output folder: screenshots are generated, not committed
const server = http.createServer((req, res) => {
  const f = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0])));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`, errors = [];
  const browser = await chromium.launch();
  const only = process.argv[2];
  const profiles = [['desktop', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }], ['pixel7', { ...devices['Pixel 7'], deviceScaleFactor: 1 }]];
  for (const [tag, opt] of profiles) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${tag}: ${e}`)); page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
    await page.goto(base + (only ? `?only=${only}` : ''));
    await page.waitForFunction(() => window.__artReady === true, null, { timeout: 30000 });
    await page.waitForTimeout(1200);
    if (!only) await page.screenshot({ path: path.join(OUT, `${tag}-first-screen.png`) });
    const sections = await page.$$eval('section[data-shot]', (s) => s.map((e) => e.dataset.shot));
    for (const s of sections) {
      if (only && s !== only) continue;
      const el = await page.$(`section[data-shot="${s}"]`); await el.scrollIntoViewIfNeeded(); await page.waitForTimeout(150);
      await el.screenshot({ path: path.join(OUT, `${tag}-${s}.png`) });
    }
    await ctx.close();
  }
  await browser.close(); server.close();
  if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
  console.log('ok', fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).join(' '));
});
