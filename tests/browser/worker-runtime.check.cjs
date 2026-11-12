/**
 * P0-A2 PR 2 — non-official experiment Worker in a real browser (Playwright Chromium) vs the same core under Node.
 * FAILS (exit 1) on any failed check, page error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/worker-runtime.check.cjs <outDir> http://localhost:8781/
 * Checks:
 *  - Node <-> Worker: the 48 h event sequence (ids, exact instants, data, every random draw) and the 48 h payload hash
 *    are compared with `node tests/lib/experiment-world-run.ts`. Byte identity is REPORTED, not assumed; if any number
 *    differs, the maximum absolute difference is recorded and must stay within a stated bound (1e-9 s / 1e-9 cm).
 *  - same environment replay: two Worker runs identical; 24 h -> snapshot -> new Worker -> restore -> 24 h identical to
 *    48 h continuous; irregular chunks identical; paced run (start / speeds / pause / resume) then step to 48 h identical.
 *  - refusal: a tampered snapshot is refused and the Worker keeps its world; an unknown command is rejected.
 *  - every reply and event carries 非正式實驗世界／不屬於正式遊戲歷史; the demo page shows the label and moving ants.
 *  - saves/ and journal/ hashes unchanged.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
const dirHash = (d) => { const h = crypto.createHash('sha256'); const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(ROOT, d)); return h.digest('hex'); };

(async () => {
  const out = process.argv[2] || 'worker-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], info = {};
  const check = (c, m) => { if (c) passed.push(m); else failures.push(m); };
  const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
  const SEEDS = [11, 12, 13];
  const nodeRuns = SEEDS.map((seed) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tests/lib/experiment-world-run.ts'), 'exp-xcheck', String(seed), '48'], { encoding: 'utf8', maxBuffer: 256 << 20 })));
  const node = nodeRuns[0];

  const browser = await chromium.launch();
  info.browser = browser.version();
  const page = await browser.newPage({ viewport: { width: 1180, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(new URL('experimental-worker.html?seed=5', base).href);
  await page.waitForFunction(() => window.__experiment && window.__experiment.frame(), null, { timeout: 20000 });

  const res = await page.evaluate(async (SEEDS) => {
    const { ExperimentWorkerClient } = await import('./dist/experimental/worker-client.js');
    const H = 3600;
    const mk = () => { const c = new ExperimentWorkerClient(); const evs = []; const bad = []; c.onEvents = (e) => evs.push(...e); c.onProtocolError = (w) => bad.push(w); return { c, evs, bad }; };
    const ser = (evs) => evs.map((e) => JSON.stringify(e));
    const hashOf = async (c) => (await c.snapshot()).snapshot.payload_sha256;
    const xs = [];
    for (const seed of SEEDS) { const X = mk(); await X.c.init('exp-xcheck', seed); await X.c.stepUntil(48 * H); xs.push({ events: ser(X.evs), payload: (await X.c.snapshot()).snapshot.payload }); X.c.terminate(); }
    // continuous 48 h (twice)
    const A = mk(); await A.c.init('exp-xcheck', 11); await A.c.stepUntil(48 * H); const hA = await hashOf(A.c);
    const A2 = mk(); await A2.c.init('exp-xcheck', 11); await A2.c.stepUntil(48 * H); const hA2 = await hashOf(A2.c);
    // 24 h -> snapshot -> terminate -> new Worker -> restore -> 24 h
    const B = mk(); await B.c.init('exp-xcheck', 11); await B.c.stepUntil(24 * H); const snap = (await B.c.snapshot()).snapshot; B.c.terminate();
    const C = mk(); await C.c.init('exp-xcheck', 99); const restored = await C.c.restore(snap); const cut = C.evs.length; await C.c.stepUntil(48 * H); const hC = await hashOf(C.c);
    const split = [...B.evs, ...C.evs.slice(cut)];
    // irregular chunks
    const D = mk(); await D.c.init('exp-xcheck', 11); let t = 0, k = 1; while (t < 48 * H) { t = Math.min(48 * H, t + ((k * 7919) % 5000) + 0.25); k++; await D.c.stepUntil(t); } const hD = await hashOf(D.c);
    // paced: start, speeds, pause, resume, then step to 48 h
    const E = mk(); await E.c.init('exp-xcheck', 11); await E.c.setSpeed(3600); await E.c.start();
    await new Promise((r) => setTimeout(r, 700)); await E.c.setSpeed(86400); await new Promise((r) => setTimeout(r, 300));
    await E.c.pause(); await new Promise((r) => setTimeout(r, 200)); await E.c.setSpeed(10); await E.c.resume(); await new Promise((r) => setTimeout(r, 200));
    const paused = await E.c.pause(); const tPaced = paused.frame.t_sim; await E.c.stepUntil(48 * H); const hE = await hashOf(E.c);
    // refusal keeps the world
    const tam = JSON.parse(JSON.stringify(snap)); tam.payload.ants[0].pos.x += 1;
    const before = await hashOf(D.c); const ref = await D.c.restore(tam); const after = await hashOf(D.c);
    const U = mk(); await U.c.init('exp-xcheck', 11); const hU = await hashOf(U.c); const unk = await U.c.send({ type: 'set_rain', mm: 50 }); const unkKept = (await hashOf(U.c)) === hU;
    const allEvents = [...A.evs, ...A2.evs, ...B.evs, ...C.evs, ...D.evs, ...E.evs];
    return {
      xs, A: ser(A.evs), hA, same2: JSON.stringify(ser(A2.evs)) === JSON.stringify(ser(A.evs)) && hA2 === hA,
      restoredOk: restored.type === 'ack', splitSame: JSON.stringify(ser(split)) === JSON.stringify(ser(A.evs)) && hC === hA,
      chunks: k - 1, chunkSame: JSON.stringify(ser(D.evs)) === JSON.stringify(ser(A.evs)) && hD === hA,
      tPaced, pacedSame: JSON.stringify(ser(E.evs)) === JSON.stringify(ser(A.evs)) && hE === hA,
      refused: ref.type === 'error' ? ref.code : 'accepted', keptWorld: before === after,
      unknown: unk.type === 'error' ? unk.code : unk.type, unkKept,
      labelled: allEvents.every((e) => e.official === false && e.label === '非正式實驗世界／不屬於正式遊戲歷史'),
      protocolErrors: [A, A2, B, C, D, E].flatMap((x) => x.bad),
    };
  }, SEEDS);
  // Node vs Worker comparison. Ant rules use only IEEE basic operations (detmath.ts), so ant and temperature events must
  // be byte-identical. Light transition times come from engine/clock/solar.ts (Math trigonometry, implementation-
  // approximated): those numbers are compared within a bound and every difference is recorded.
  const LIGHT_BOUND_MIN = 1e-9, LIGHT_BOUND_US = 1e-3;
  const cmp = { seeds: SEEDS, events: 0, identical_events: 0, light_events_differing: 0, strict_failures: [], max_light_minute_diff: 0, max_light_exact_us_diff: 0, payload_identical: 0, payload_identical_without_light: 0 };
  const lightNums = (a, b, pth) => { if (typeof a === 'number' && typeof b === 'number') { if (pth.endsWith('.us') || pth.endsWith('.us_lo')) return; cmp.max_light_minute_diff = Math.max(cmp.max_light_minute_diff, Math.abs(a - b) * (pth.endsWith('t_sim') ? 1 / 60 : 1)); return; } if (a && b && typeof a === 'object') { for (const k of Object.keys(a)) lightNums(a[k], b[k], `${pth}.${k}`); return; } if (a !== b) cmp.strict_failures.push(`${pth}: ${a} vs ${b}`); };
  const exactDiff = (a, b) => Math.abs((a.us - b.us) + (a.us_lo - b.us_lo) + (a.day - b.day) * 86400e6);
  const noLight = (p) => { const q = JSON.parse(JSON.stringify(p)); q.env.light_times = null; q.scheduler.events = q.scheduler.events.filter((e) => e.kind !== 'light_change'); return q; };
  const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  SEEDS.forEach((seed, si) => {
    const n = nodeRuns[si], w = res.xs[si];
    if (n.events.length !== w.events.length) { cmp.strict_failures.push(`seed ${seed}: ${n.events.length} vs ${w.events.length} events`); return; }
    for (let i = 0; i < n.events.length; i++) {
      cmp.events++;
      const a = JSON.stringify(n.events[i]); if (a === w.events[i]) { cmp.identical_events++; continue; }
      const A = n.events[i], B = JSON.parse(w.events[i]);
      if (A.event_id !== B.event_id || !['light_change', 'env_day'].includes(A.kind)) { cmp.strict_failures.push(`seed ${seed} #${i} ${A.event_id} vs ${B.event_id}`); continue; }
      cmp.light_events_differing++; cmp.max_light_exact_us_diff = Math.max(cmp.max_light_exact_us_diff, exactDiff(A.exact, B.exact));
      lightNums({ ...A, exact: null }, { ...B, exact: null }, '');
    }
    if (canon(n.payload) === canon(w.payload)) cmp.payload_identical++;
    if (canon(noLight(n.payload)) === canon(noLight(w.payload))) cmp.payload_identical_without_light++;
    else cmp.strict_failures.push(`seed ${seed}: 48 h state differs outside the light times`);
    lightNums(n.payload.env.light_times, w.payload.env.light_times, '.env.light_times');
    const ln = n.payload.scheduler.events.filter((e) => e.kind === 'light_change'), lw = w.payload.scheduler.events.filter((e) => e.kind === 'light_change');
    ln.forEach((e, i) => { if (!lw[i] || lw[i].id !== e.id) cmp.strict_failures.push(`seed ${seed}: pending light event ${e.id}`); else { cmp.max_light_exact_us_diff = Math.max(cmp.max_light_exact_us_diff, exactDiff(e.exact, lw[i].exact)); lightNums(e.native, lw[i].native, '.native'); } });
  });
  info.node_vs_worker = { node: node.platform, ...cmp, strict_failures: cmp.strict_failures.slice(0, 5), bound: { light_minutes: LIGHT_BOUND_MIN, light_exact_us: LIGHT_BOUND_US } };
  check(cmp.strict_failures.length === 0, `Node vs Worker (seeds ${SEEDS}): same event ids and order; every ant, temperature and non-light value byte-identical; 48 h state identical apart from light times (${cmp.identical_events}/${cmp.events} events byte-identical, ${cmp.payload_identical}/${SEEDS.length} payloads byte-identical)`);
  check(cmp.max_light_minute_diff <= LIGHT_BOUND_MIN && cmp.max_light_exact_us_diff <= LIGHT_BOUND_US, `Node vs Worker: light transition times within the bound (max ${cmp.max_light_minute_diff} min, ${cmp.max_light_exact_us_diff} µs)`);
  check(res.same2, 'Worker: same seed twice -> identical events and state');
  check(res.restoredOk && res.splitSame, 'Worker: 24 h -> snapshot -> new Worker -> restore -> 24 h == 48 h continuous (events, draws, state hash)');
  check(res.chunkSame, `Worker: ${res.chunks} irregular step_until chunks -> identical`);
  check(res.pacedSame && res.tPaced > 0, `Worker: paced run (speeds 3600/86400/10, pause, resume; paused at ${res.tPaced.toFixed(1)} s) then step to 48 h -> identical`);
  check(res.refused === 'HASH_MISMATCH' && res.keptWorld, `Worker: tampered snapshot refused (${res.refused}) and the world kept`);
  check(res.unknown === 'UNKNOWN_COMMAND' && res.unkKept, `Worker: unknown command (set_rain) rejected (${res.unknown}) and nothing changed`);
  check(res.labelled && res.protocolErrors.length === 0, 'Worker: every event labelled non-official; no reply rejected by the client');

  // the demo page: label, continuous motion, pause freezes world time
  check((await page.textContent('#badge')).includes(LABEL), 'demo page shows the non-official label');
  await page.click('#start'); await page.selectOption('#speed', '600');
  await page.waitForTimeout(1500);
  const t1 = await page.evaluate(() => window.__experiment.frame().t_sim);
  await page.waitForTimeout(1500);
  const t2 = await page.evaluate(() => window.__experiment.frame().t_sim);
  check(t2 > t1, `demo: world time advances while running (${t1.toFixed(1)} -> ${t2.toFixed(1)} s)`);
  await page.selectOption('#follow', 'w02');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, 'worker-demo-running.png') });
  await page.click('#pause'); await page.waitForTimeout(300);
  const p1 = await page.evaluate(() => window.__experiment.frame().t_sim); await page.waitForTimeout(700);
  const p2 = await page.evaluate(() => window.__experiment.frame().t_sim);
  check(p1 === p2, 'demo: pause freezes world time');
  check(await page.evaluate(() => window.__experiment.errors.length === 0), 'demo: no reply rejected by the client');
  await browser.close();

  check(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged');
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  const result = { test: 'worker-runtime-browser', passed: passed.length, failed: failures, info };
  console.log(JSON.stringify(result, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
