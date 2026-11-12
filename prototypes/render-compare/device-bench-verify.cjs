/**
 * Headless check of the device bench page (dist/device-bench, built by build.mjs): serves it as static files, runs the
 * quick mode end to end in headless Chromium (desktop 1280×800 and Pixel 7 emulation), checks the report schema, no
 * page errors, no request outside the bundle, no horizontal scroll at phone width, and that the page flags the run as
 * software / automation. The numbers are HEADLESS / SOFTWARE numbers, never device results.
 *   node build.mjs && node device-bench-verify.cjs [outDir]
 */
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const { chromium, devices } = require('playwright');
const ROOT = path.join(__dirname, 'dist/device-bench'), OUT = process.argv[2] || path.join(__dirname, 'dist/verify');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json' };
fs.mkdirSync(OUT, { recursive: true });
const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]), f = path.normalize(path.join(ROOT, u === '/' ? 'index.html' : u));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
server.listen(0, async () => {
  const base = `http://localhost:${server.address().port}/`, browser = await chromium.launch({ args: ['--enable-precise-memory-info'] }), failures = [];
  for (const [tag, opt] of [['desktop', { viewport: { width: 1280, height: 800 } }], ['pixel7', { ...devices['Pixel 7'] }]]) {
    const ctx = await browser.newContext(opt), page = await ctx.newPage(), errors = [], outside = [];
    page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('request', (r) => { if (!r.url().startsWith(base)) outside.push(r.url()); });
    await page.goto(base);
    const sw0 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await page.screenshot({ path: path.join(OUT, `${tag}-intro.png`), fullPage: true });
    const t0 = Date.now();
    await page.evaluate(() => window.__deviceBench.start('quick'));
    await page.waitForTimeout(20000); await page.screenshot({ path: path.join(OUT, `${tag}-running.png`) });
    await page.waitForFunction(() => window.__deviceBench.report() !== null, null, { timeout: 900000, polling: 2000 });
    const secs = (Date.now() - t0) / 1000, report = await page.evaluate(() => window.__deviceBench.report());
    const sw1 = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), flag = await page.textContent('#envFlag');
    await page.screenshot({ path: path.join(OUT, `${tag}-results.png`), fullPage: true });
    fs.writeFileSync(path.join(OUT, `${tag}-report.json`), JSON.stringify(report, null, 1));
    const p = [];
    if (report.schema_problems.length) p.push('schema: ' + report.schema_problems.join(', '));
    if (report.matrix.length !== 36) p.push(`matrix ${report.matrix.length} cells`);
    if (report.matrix.some((m) => m.error)) p.push('matrix errors: ' + report.matrix.filter((m) => m.error).map((m) => m.error).join(' | '));
    if (report.breakdown.length !== 14 || report.breakdown.some((b) => b.error)) p.push('breakdown: ' + report.breakdown.map((b) => b.error).filter(Boolean).join(' | '));
    if (report.measurement_class === 'device') p.push('headless run classified as a device result');
    if (!/不是實機/.test(flag)) p.push('software / automation flag not shown');
    if (sw0 > 0 || sw1 > 0) p.push(`horizontal scroll ${sw0} / ${sw1} px`);
    if (errors.length) p.push('page errors: ' + errors.join(' | '));
    if (outside.length) p.push('requests outside the bundle: ' + outside.join(' '));
    console.log(`${tag}: ${secs.toFixed(0)} s, class "${report.measurement_class}", gpu "${report.device.webgl.unmasked_renderer ?? report.device.webgl.renderer}", ${p.length ? 'FAIL ' + p.join('; ') : 'ok'}`);
    if (p.length) failures.push(`${tag}: ${p.join('; ')}`);
    await ctx.close();
  }
  await browser.close(); server.close();
  if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
});
