/**
 * Demo 2 performance tests — headless runner (web/demo2-bench.html; docs/demo2.md 「效能測試」). NOT a device result:
 * headless Chromium draws with SwiftShader (CPU), and the page classifies every such result `software`
 * (「軟體算繪，不是裝置結果」). Real-device numbers come only from opening demo2-bench.html on the device.
 *   npm run web:build && node cli/web-serve.ts 8787 &
 *   node tests/browser/demo2-bench.run.cjs <out.json> http://localhost:8787/ [--sizes 30,100,300,1000] [--modes render,sim]
 *        [--warm 3] [--dur 10] [--speed 5] [--quality medium] [--renderer webgpu] [--viewport 1280x800|pixel7] [--smoke]
 * It runs the page's own matrix (`?auto=1`), copies the page's result JSON, and adds what only the outside can see:
 * the resident memory of the whole browser process tree over time (Linux `ps`; a proxy — it includes every Worker
 * and the message queues, which the page's own JS-heap figure does not).
 * --smoke (CI, demo2-optional job): exit 1 unless every case completed, the result is classified software under
 * automation, the watermark matched the mode, the render-only cases started no Worker and the full-simulation cases
 * drew exactly N engine workers. Without --smoke the runner never fails on a case that stopped itself: a failed case
 * is a finding and is written into the result.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium, devices } = require('playwright');

const MARK = `--antempire-demo2-bench-${process.pid}`;
function treeRssMb() {
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss=,args='], { encoding: 'utf8' }).trim().split('\n').map((l) => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(l); return m && { pid: +m[1], ppid: +m[2], rss: +m[3], args: m[4] }; }).filter(Boolean);
    const root = rows.find((r) => r.args.includes(MARK)); if (!root) return null;
    const keep = new Set([root.pid]); let grew = true;
    while (grew) { grew = false; for (const r of rows) if (!keep.has(r.pid) && keep.has(r.ppid)) { keep.add(r.pid); grew = true; } }
    return Math.round(rows.filter((r) => keep.has(r.pid)).reduce((s, r) => s + r.rss, 0) / 1024);
  } catch { return null; }
}

(async () => {
  const [outFile = 'demo2-bench.json', base = 'http://localhost:8787/', ...rest] = process.argv.slice(2);
  const opt = {}; for (let i = 0; i < rest.length; i++) { if (rest[i] === '--smoke') opt.smoke = true; else if (rest[i].startsWith('--')) opt[rest[i].slice(2)] = rest[++i]; }
  const smoke = !!opt.smoke, vp = opt.viewport || '1280x800';
  const ctxOpts = vp === 'pixel7' ? { ...devices['Pixel 7'] } : { viewport: { width: Number(vp.split('x')[0]), height: Number(vp.split('x')[1]) } };
  const query = new URLSearchParams({ auto: '1' });
  for (const k of ['sizes', 'modes', 'warm', 'dur', 'speed', 'quality', 'renderer', 'present', 'start_timeout']) if (opt[k]) query.set(k, opt[k]);
  if (smoke) { if (!opt.sizes) query.set('sizes', '30'); if (!opt.warm) query.set('warm', '1'); if (!opt.dur) query.set('dur', '2'); }
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info', ...(opt.renderer === 'webgpu' ? ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] : []), MARK] });
  const ctx = await browser.newContext(ctxOpts), page = await ctx.newPage();
  const errors = [], workers = []; let seen = [];
  page.on('pageerror', (e) => errors.push(String(e.stack || e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('worker', (w) => workers.push({ at: Date.now(), url: w.url() }));
  const t0 = Date.now(), rss = [];
  await page.goto(new URL(`demo2-bench.html?${query}`, base).href);
  await page.waitForFunction(() => window.__bench && (window.__bench.ready || window.__bench.done), null, { timeout: 120000 });
  let crashed = null; page.on('crash', () => { crashed = 'the page crashed (out of memory?)'; });
  // poll: progress, the watermark of the running case, Workers alive, process-tree memory
  let last = '';
  for (;;) {
    if (crashed) break;
    const s = await page.evaluate(() => ({ done: window.__bench.done, progress: window.__bench.progress, st: window.__bench.state() })).catch((e) => ({ err: String(e) }));
    if (s.err) { crashed = crashed || s.err; break; }
    const mb = treeRssMb(); rss.push({ t_s: Math.round((Date.now() - t0) / 100) / 10, rss_mb: mb, progress: s.progress });
    const head = (s.progress || '').split('：')[0]; if (head && head !== last) { last = head; process.stderr.write(`${head}  [tree RSS ${mb} MB]\n`); }
    if (s.st && s.st.busy && s.st.drawn > 0) seen.push({ head, mark: s.st.mark, text: s.st.mark_text, drawn: s.st.drawn, workers_started: workers.length });
    if (s.done) break;
    if (Date.now() - t0 > Number(opt.timeout || 3600) * 1000) { crashed = 'runner timeout'; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const result = crashed ? null : await page.evaluate(() => window.__bench.result);
  if (!crashed) await page.screenshot({ path: outFile.replace(/\.json$/, '') + '.jpg', type: 'jpeg', quality: 60 }).catch(() => {});
  await browser.close().catch(() => {});
  const out = {
    schema: 'antempire.demo2-bench-run.v1', runner: 'tests/browser/demo2-bench.run.cjs', url_query: query.toString(),
    host: { cpus: os.cpus().length, cpu_model: os.cpus()[0] && os.cpus()[0].model, mem_gb: Math.round(os.totalmem() / 1073741824 * 10) / 10, platform: `${os.platform()} ${os.arch()}`, loadavg_end: os.loadavg().map((x) => Math.round(x * 100) / 100) },
    crashed, page_errors: errors, workers_started: workers.length,
    tree_rss_mb: { note: 'resident memory of the whole browser process tree (ps); includes Workers and message queues', max: Math.max(...rss.map((r) => r.rss_mb || 0)), series: rss.filter((_, i) => i % 5 === 0 || i === rss.length - 1) },
    result,
  };
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n');
  const cases = result ? result.cases : [];
  for (const c of cases) process.stderr.write(`${c.mode} ${c.n}: ${c.status}${c.status === 'ok' ? ` fps ${c.fps_mean} p50 ${c.frame_ms.p50} ms draw calls ${c.draw_calls}` : ` — ${c.reason}`}\n`);
  process.stderr.write(`measurement_class: ${result ? result.measurement_class : '—'} (${result ? result.label_zh : crashed})\n`);
  if (!smoke) process.exit(crashed ? 2 : 0);
  // ---------- smoke assertions ----------
  const fails = [], check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (!c) fails.push(m); };
  check(!crashed && errors.length === 0, `no crash, no page or console error ${JSON.stringify(errors.slice(0, 3))}`);
  check(!!result && result.schema === 'antempire.demo2-bench.v1' && result.measurement_class === 'software' && result.gpu_class === 'software' && result.label_zh === '軟體算繪，不是裝置結果' && result.automated === true, `the headless result is classified software and labelled 「${result && result.label_zh}」 (${result && result.gpu_rule})`);
  check(!!result && result.renderer_api === result.gpu.api && (opt.renderer === 'webgpu' || result.renderer_api === 'webgl2') && typeof result.gpu.webgl_unmasked_renderer === 'string', `the API in use is recorded from the renderer (${result && result.renderer_api}; UNMASKED_RENDERER 「${result && result.gpu.webgl_unmasked_renderer}」)`);
  check(cases.length >= 2 && cases.every((c) => c.status === 'ok' && c.frames >= 2 && c.fps_mean > 0 && c.draw_calls > 0 && c.triangles > 0 && c.frame_ms.p99 >= c.frame_ms.p50 && c.canvas[0] > 0), `every case completed with frame statistics (${cases.map((c) => `${c.mode} ${c.n}: ${c.status}`).join(', ')})`);
  const R = cases.filter((c) => c.mode === 'render'), S = cases.filter((c) => c.mode === 'sim');
  const rSeen = seen.filter((x) => x.mark === 'render'), sSeen = seen.filter((x) => x.mark === 'sim');
  check(R.length > 0 && R.every((c) => c.sim === null) && rSeen.length > 0 && rSeen.every((x) => x.text.includes('效能測試・合成資料，非模擬') && x.workers_started === 0), 'render-only: watermark 「效能測試・合成資料，非模擬」 over the screen, no Worker was started, no simulation statistics in the record');
  check(S.length > 0 && S.every((c) => c.sim && c.sim.drawn === c.n && c.sim.worlds === Math.ceil(c.n / 30) && c.sim.msgs_per_s > 0 && c.sim.frame_bytes_est > 1000 && c.sim.ratio_achieved_mean > 0 && c.sim.sim_events_per_s >= 0) && sSeen.length > 0 && sSeen.every((x) => /個互不相干的獨立蟻群/.test(x.text) && x.text.includes('非正式實驗世界')), `full simulation: exactly N engine workers drawn from ⌈N/30⌉ independent worlds, Worker message rate and sim/real ratio recorded, watermark says the colonies are independent (${S.map((c) => c.sim && `${c.n}: ${c.sim.worlds} worlds, ${c.sim.msgs_per_s} msg/s, ${c.sim.ratio_achieved_mean}× of ${c.sim.ratio_requested}×`).join('; ')})`);
  check(workers.length === S.reduce((a, c) => a + Math.ceil(c.n / 30), 0), `Workers started = the worlds of the full-simulation cases only (${workers.length})`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
