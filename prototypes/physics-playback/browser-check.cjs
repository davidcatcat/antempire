/**
 * Browser check of the physics playback page (needs the preinstalled Chromium + Playwright). Serves this directory,
 * loads every run at desktop 1280x800 and phone 412x915 (DPR 2), steps through events and checks:
 *  - no page errors; the 非正式 label is shown;
 *  - at every visited time the drawn pose of every agent equals the exact piecewise motion read here independently
 *    from the JSON (|Δ| ≤ 1e-9 mm), and the highlighted agents are those of the current engine event;
 *  - clicking an event row jumps to that event's exact time.
 * Screenshots go to ./screenshots/.   node prototypes/physics-playback/browser-check.cjs [maxStepsPerRun]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const DIR = __dirname, OUT = path.join(DIR, 'screenshots');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const read = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));

function exactPose(a, t) { // independent of the page: the segment that holds t (later one at a boundary)
  const S = a.segments;
  if (t < S[0].t0) return { x: S[0].x0, y: S[0].y0 };
  if (t >= S[S.length - 1].t1) return { x: a.final.x, y: a.final.y };
  let g = S[0]; for (const s of S) if (s.t0 <= t) g = s;
  if (t === g.t1) return { x: g.x1, y: g.y1 };
  const f = (t - g.t0) / (g.t1 - g.t0); return { x: g.x0 + (g.x1 - g.x0) * f, y: g.y0 + (g.y1 - g.y0) * f };
}

(async () => {
  const maxSteps = Number(process.argv[2] || 40);
  fs.mkdirSync(OUT, { recursive: true });
  const server = http.createServer((req, res) => {
    const u = decodeURIComponent(new URL(req.url, 'http://x').pathname), f = path.join(DIR, u === '/' ? 'index.html' : u);
    if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const index = read('data/index.json'), failures = [], errors = [];
  let checks = 0; const check = (c, m) => { checks++; if (!c) failures.push(m); };
  const browser = await chromium.launch();
  for (const [name, vp] of [['desktop', { width: 1280, height: 800, dsf: 1 }], ['phone', { width: 412, height: 915, dsf: 2, mobile: true }]]) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.dsf, isMobile: !!vp.mobile, hasTouch: !!vp.mobile });
    const page = await ctx.newPage(); page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
    await page.goto(base); await page.evaluate(() => window.playback.ready);
    check((await page.textContent('#badge')).includes('非正式'), `${name}: 非正式 label`);
    // a WP4 candidate run carries its own badge
    { const c = index.runs.find((r) => r.solver === 'steer'); if (c) { await page.evaluate((id) => window.playback.load(id), c.run_id); check((await page.textContent('#badge')).includes('隔離物理實驗・候選行為規則（非本種/假設）'), `${name}: candidate badge`); } }
    // the dense benchmark carries its applicability note; other runs do not show one
    { const c = index.runs.find((r) => r.scenario === 'crossing-traffic-100'); if (c) { await page.evaluate((id) => window.playback.load(id), c.run_id); const sc = await page.evaluate(() => { const e = document.getElementById('scope'); return { hidden: e.hidden, text: e.textContent }; }); check(!sc.hidden && sc.text.includes('適用範圍') && sc.text.includes('不適用於'), `${name}: dense benchmark applicability shown`); } }
    { const c = index.runs.find((r) => r.scenario === 'head-on-2' && r.solver === 'ph3b'); await page.evaluate((id) => window.playback.load(id), c.run_id); check(await page.evaluate(() => document.getElementById('scope').hidden), `${name}: no applicability note on a small scenario`); }
    // a contact_end row shows the independent checker's bracket and error bound
    { const id = 'head-on-2--steer-B', run = read(`data/${id}.json`), i = run.events.findIndex((e) => e.kind === 'contact_end');
      if (i >= 0) { await page.evaluate((x) => window.playback.load(x), id); await page.evaluate((x) => window.playback.selectEvent(x), i); const t = await page.evaluate(() => document.getElementById('now').textContent); check(t.includes('獨立檢查') && t.includes('誤差界'), `${name}: contact_end shows the independent bracket`); } else failures.push(`${id}: no contact_end`); }
    const noHScroll = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    check(noHScroll, `${name}: no horizontal page scroll`);
    for (const meta of index.runs) {
      const run = read(meta.file);
      await page.evaluate((id) => window.playback.load(id), meta.run_id);
      const times = [...new Set(run.events.map((e) => e.t))].sort((a, b) => a - b);
      // step through the first maxSteps event times (and the last one), compare drawn poses to the exact motion
      const visit = times.length <= maxSteps ? times : [...times.slice(0, maxSteps - 1), times[times.length - 1]];
      let k = 0;
      for (const t of visit) {
        while (true) { const s = await page.evaluate(() => window.playback.state()); if (s.t >= t) break; await page.evaluate(() => window.playback.stepEvent(1)); if (++k > 100000) break; }
        const s = await page.evaluate(() => window.playback.state());
        check(s.t === t, `${name} ${meta.run_id}: stepping lands on event time ${t} (got ${s.t})`);
        for (const d of s.drawn) { const a = run.agents.find((x) => x.id === d.id), p = exactPose(a, s.t); check(Math.abs(p.x - d.x) <= 1e-9 && Math.abs(p.y - d.y) <= 1e-9, `${name} ${meta.run_id} t=${s.t} ${d.id}: drawn pose = exact motion`); }
        const ev = run.events[s.sel]; check(ev && ev.t === s.t && JSON.stringify([...s.highlighted].sort()) === JSON.stringify([...ev.agents].sort()), `${name} ${meta.run_id} t=${s.t}: highlighted = agents of the current event`);
        if (times.length > visit.length && t === visit[visit.length - 2]) await page.evaluate((x) => window.playback.setTime(x), times[times.length - 2]);
      }
      // between two events: a time strictly inside a segment
      const mid = (times[0] + (times[1] ?? run.horizon_s)) / 2; await page.evaluate((x) => window.playback.setTime(x), mid);
      const s2 = await page.evaluate(() => window.playback.state());
      for (const d of s2.drawn) { const p = exactPose(run.agents.find((x) => x.id === d.id), mid); check(Math.abs(p.x - d.x) <= 1e-9 && Math.abs(p.y - d.y) <= 1e-9, `${name} ${meta.run_id} mid: drawn pose = exact motion`); }
    }
    // click a row: jumps to its exact time; screenshots of chosen moments
    const shots = [['head-on-2--ph3b', 'contact_start'], ['pass-clear--ph3b', 'pass'], ['offset-block--ph3b', 'stop'], ['crossing-flank--ph3b', 'contact_start'], ['crossing-flank--ph3b', 'contact_end'], ['pass-graze--ph3b', 'contact_end'], ['crossing-flank--ph3b', 'arrive'], ['stone--ph3b', 'stop'], ['corridor-8--ph3b', 'resume'], ['head-on-2--native', 'yield_start'], ['head-on-2--steer-B', 'back_off'], ['offset-block--steer-C', 'sidestep'], ['stone--steer-A', 'sidestep'], ['crossing-traffic-100--steer-A', 'blocked_report']];
    for (const [id, kind] of shots) {
      const run = read(`data/${id}.json`), i = run.events.findIndex((e) => e.kind === kind); if (i < 0) { failures.push(`${id}: no ${kind}`); continue; }
      await page.evaluate((x) => window.playback.load(x), id);
      await page.evaluate(() => window.playback.setTime(0));
      await page.evaluate((x) => { const l = document.getElementById('events'); l.scrollTop = Math.max(0, x * 26 - 60); l.dispatchEvent(new Event('scroll')); }, i);
      const row = await page.$(`.ev[data-i="${i}"]`); check(!!row, `${name} ${id}: row of event ${i} rendered`);
      if (row) await row.click();
      const s = await page.evaluate(() => window.playback.state());
      check(s.t === run.events[i].t && s.sel === i, `${name} ${id}: clicking row ${i} jumps to ${run.events[i].t}`);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `${name}-${id}-${kind}.png`), fullPage: name === 'phone' && id === 'pass-clear--ph3b' });
    }
    await ctx.close();
  }
  await browser.close(); server.close();
  console.log(JSON.stringify({ checks, failures: failures.slice(0, 20), failure_count: failures.length, errors }, null, 1));
  if (failures.length || errors.length) process.exitCode = 1;
})();
