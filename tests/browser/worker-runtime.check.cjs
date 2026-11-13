/**
 * P0-A2 PR 2 — non-official experiment Worker in a real browser (Playwright Chromium) vs the same core under Node.
 * FAILS (exit 1) on any failed check, page error or console error.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/worker-runtime.check.cjs <outDir> http://localhost:8781/
 * Checks:
 *  - Node <-> Worker: the 48 h event sequence (ids, exact instants, data, every random draw, light transitions) and the
 *    48 h payload are compared with `node tests/lib/experiment-world-run.ts` and must be BYTE-IDENTICAL (no tolerance;
 *    light times bit-identical since Owner decision #190, engine/clock/detmath.ts). Verified on x86-64 only.
 *  - same environment replay: two Worker runs identical; 24 h -> snapshot -> new Worker -> restore -> 24 h identical to
 *    48 h continuous; irregular chunks identical; paced run (start / speeds / pause / resume) then step to 48 h identical.
 *  - refusal: a tampered snapshot is refused and the Worker keeps its world; an unknown command is rejected.
 *  - every reply and event carries 非正式實驗世界／不屬於正式遊戲歷史; the demo page shows the label and moving ants.
 *  - P0-A2 24 h world (#156 phase 3): Node (tests/lib/p0a2-world-run.ts) vs Worker, 48 h, two seeds, every event, the
 *    log hash chain, the event-chain head and the whole payload BYTE-IDENTICAL (rules update detmath-exp); same-environment
 *    replay; 24 h -> snapshot -> terminate -> new Worker -> restore -> 24 h == 48 h; irregular chunks; paced run with
 *    speeds / follow / pause then step to 48 h (event-log hash); tampered and other-code snapshots refused.
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
  // Node vs Worker comparison: STRICT byte identity, no tolerance. Ant rules use only IEEE basic operations
  // (prototypes/continuous-world/worker/detmath.ts); since Owner decision #190 (ruled in #193, 2026-11-12) the light
  // transition times of engine/clock/solar.ts do too (engine/clock/detmath.ts). Before that change the light times were
  // compared within a bound and differed by 1 ulp (PR #169; docs/solar-cross-env-check.md) — that bound is removed.
  const cmp = { seeds: SEEDS, events: 0, identical_events: 0, differing: [], payload_identical: 0 };
  const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  SEEDS.forEach((seed, si) => {
    const n = nodeRuns[si], w = res.xs[si];
    if (n.events.length !== w.events.length) { cmp.differing.push(`seed ${seed}: ${n.events.length} vs ${w.events.length} events`); return; }
    for (let i = 0; i < n.events.length; i++) {
      cmp.events++;
      if (JSON.stringify(n.events[i]) === w.events[i]) cmp.identical_events++; else cmp.differing.push(`seed ${seed} #${i} ${n.events[i].event_id} (${n.events[i].kind})`);
    }
    if (canon(n.payload) === canon(w.payload)) cmp.payload_identical++; else cmp.differing.push(`seed ${seed}: 48 h payload differs`);
  });
  info.node_vs_worker = { node: node.platform, ...cmp, differing: cmp.differing.slice(0, 5), differing_count: cmp.differing.length, arm64: 'not verified' };
  check(cmp.differing.length === 0 && cmp.identical_events === cmp.events && cmp.events > 0 && cmp.payload_identical === SEEDS.length, `Node vs Worker (seeds ${SEEDS}): every event byte-identical, light transitions included (${cmp.identical_events}/${cmp.events}); 48 h payloads byte-identical (${cmp.payload_identical}/${SEEDS.length})`);
  check(res.same2, 'Worker: same seed twice -> identical events and state');
  check(res.restoredOk && res.splitSame, 'Worker: 24 h -> snapshot -> new Worker -> restore -> 24 h == 48 h continuous (events, draws, state hash)');
  check(res.chunkSame, `Worker: ${res.chunks} irregular step_until chunks -> identical`);
  check(res.pacedSame && res.tPaced > 0, `Worker: paced run (speeds 3600/86400/10, pause, resume; paused at ${res.tPaced.toFixed(1)} s) then step to 48 h -> identical`);
  check(res.refused === 'HASH_MISMATCH' && res.keptWorld, `Worker: tampered snapshot refused (${res.refused}) and the world kept`);
  check(res.unknown === 'UNKNOWN_COMMAND' && res.unkKept, `Worker: unknown command (set_rain) rejected (${res.unknown}) and nothing changed`);
  check(res.labelled && res.protocolErrors.length === 0, 'Worker: every event labelled non-official; no reply rejected by the client');

  // ---------------- P0-A2 24 h world (#156 phase 3) in the real Chromium Worker
  const P0SEEDS = [11, 12];
  const p0node = P0SEEDS.map((seed) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'tests/lib/p0a2-world-run.ts'), 'exp-p0-xcheck', String(seed), '48'], { encoding: 'utf8', maxBuffer: 256 << 20 })));
  const p0 = await page.evaluate(async (P0SEEDS) => {
    const { ExperimentWorkerClient } = await import('./dist/experimental/worker-client.js');
    const H = 3600, K = 'p0a2';
    const mk = () => { const c = new ExperimentWorkerClient(); const evs = []; const bad = []; c.onEvents = (e) => evs.push(...e); c.onProtocolError = (w) => bad.push(w); return { c, evs, bad }; };
    const ser = (evs) => evs.map((e) => JSON.stringify(e));
    const snapOf = async (c) => (await c.snapshot()).snapshot;
    const xs = [];
    for (const seed of P0SEEDS) { const X = mk(); await X.c.init('exp-p0-xcheck', seed, K); await X.c.stepUntil(48 * H); const s = await snapOf(X.c); xs.push({ events: ser(X.evs), payload: s.payload, hash: s.payload_sha256 }); X.c.terminate(); }
    const A = mk(); await A.c.init('exp-p0-xcheck', 11, K); await A.c.stepUntil(48 * H); const sA = await snapOf(A.c);
    const A2 = mk(); await A2.c.init('exp-p0-xcheck', 11, K); await A2.c.stepUntil(48 * H); const sA2 = await snapOf(A2.c);
    // 24 h -> snapshot -> terminate the Worker -> new Worker (holding a synthetic world) -> restore -> 24 h
    const B = mk(); await B.c.init('exp-p0-xcheck', 11, K); await B.c.stepUntil(24 * H); const snap = await snapOf(B.c); B.c.terminate();
    const C = mk(); await C.c.init('exp-other', 5); const restored = await C.c.restore(snap); const cut = C.evs.length; await C.c.stepUntil(48 * H); const sC = await snapOf(C.c);
    const split = [...B.evs, ...C.evs.slice(cut)];
    // irregular chunks
    const D = mk(); await D.c.init('exp-p0-xcheck', 11, K); let t = 0, k = 1; while (t < 48 * H) { t = Math.min(48 * H, t + ((k * 7919) % 9000) + 0.37); k++; await D.c.stepUntil(t); } const sD = await snapOf(D.c);
    // paced with UI-like operations: start, speeds, follow, pause, resume, then step to 48 h
    const E = mk(); await E.c.init('exp-p0-xcheck', 11, K); await E.c.setSpeed(3600); await E.c.start(); await E.c.follow('w007');
    await new Promise((r) => setTimeout(r, 600)); await E.c.setSpeed(86400); await new Promise((r) => setTimeout(r, 300));
    await E.c.pause(); await new Promise((r) => setTimeout(r, 200)); await E.c.follow(null); await E.c.setSpeed(60); await E.c.resume(); await new Promise((r) => setTimeout(r, 200));
    const paused = await E.c.pause(); const tPaced = paused.frame.t_sim; await E.c.stepUntil(48 * H); const sE = await snapOf(E.c);
    const fE = (await E.c.follow(null)).frame;
    // a tampered P0-A2 snapshot is refused and the world kept; a P0-A2 snapshot with another code hash is refused
    const tam = JSON.parse(JSON.stringify(snap)); tam.payload.state.workers.w001.crop += 1;
    const h0 = (await snapOf(D.c)).payload_sha256, ref = await D.c.restore(tam), kept = (await snapOf(D.c)).payload_sha256 === h0;
    const other = JSON.parse(JSON.stringify(snap)); other.payload.code_sha256 = '0'.repeat(64);
    const enc = new TextEncoder(); const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((x) => `${JSON.stringify(x)}:${canon(v[x])}`).join(',')}}`;
    const dg = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canon(other.payload)))); other.payload_sha256 = [...dg].map((b) => b.toString(16).padStart(2, '0')).join('');
    const refCode = await D.c.restore(other);
    const all = [A, A2, B, C, D, E];
    return {
      xs, n48: A.evs.length, same2: JSON.stringify(ser(A2.evs)) === JSON.stringify(ser(A.evs)) && sA2.payload_sha256 === sA.payload_sha256,
      restoredOk: restored.type === 'ack' && restored.frame.world_kind === 'p0a2', splitSame: JSON.stringify(ser(split)) === JSON.stringify(ser(A.evs)) && sC.payload_sha256 === sA.payload_sha256,
      chunks: k - 1, chunkSame: JSON.stringify(ser(D.evs)) === JSON.stringify(ser(A.evs)) && sD.payload_sha256 === sA.payload_sha256,
      tPaced, pacedSame: JSON.stringify(ser(E.evs)) === JSON.stringify(ser(A.evs)) && sE.payload_sha256 === sA.payload_sha256 && fE.log.hash === sA.payload.state.log.hash,
      logHash: sA.payload.state.log.hash, refused: ref.type === 'error' ? ref.code : 'accepted', kept, refCode: refCode.type === 'error' ? refCode.code : 'accepted',
      labelled: all.every((x) => x.evs.every((e) => e.official === false && e.label === '非正式實驗世界／不屬於正式遊戲歷史')), protocolErrors: all.flatMap((x) => x.bad),
    };
  }, P0SEEDS);
  {
    const canon = (v) => (v === null || typeof v !== 'object') ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
    // Cross-environment (rules update detmath-exp, Owner #190 scheme A extended to exp / log / **): every module the
    // P0-A2 world runs uses only IEEE-exact operations (engine/clock/detmath.ts detExp / detLog / detPow / detSin; the
    // static rule in tests/worker-boundary.test.ts forbids Math.exp / log / ** and the other approximated functions in
    // the Worker graph). So EVERY event, the log hash chain, the event-chain head and the whole payload must be
    // byte-identical between Node and the Chromium Worker. No tolerance and no exception (the earlier rh_percent /
    // chain.head exception, needed while weather-input.ts used Math.exp, is removed). x86-64 only; ARM64 not verified.
    const c = { seeds: P0SEEDS, events: 0, identical_events: 0, differing: [], payload_identical: 0, chain_head_identical: 0, log_hash_identical: 0 };
    P0SEEDS.forEach((seed, i) => {
      const n = p0node[i], w = p0.xs[i];
      if (n.events.length !== w.events.length) { c.differing.push(`seed ${seed}: ${n.events.length} vs ${w.events.length} events`); return; }
      for (let j = 0; j < n.events.length; j++) {
        c.events++; if (n.events[j] === w.events[j]) { c.identical_events++; continue; }
        if (c.differing.length < 20) { const a = JSON.parse(n.events[j]); c.differing.push(`seed ${seed} #${j} ${a.event_id} (${a.kind})`); }
      }
      if (canon(n.payload) === canon(w.payload) && n.payload_sha256 === w.hash) c.payload_identical++; else c.differing.push(`seed ${seed}: 48 h payload differs`);
      if (n.payload.chain && w.payload.chain && n.payload.chain.head === w.payload.chain.head) c.chain_head_identical++;
      if (n.payload.state.log.hash === w.payload.state.log.hash) c.log_hash_identical++;
    });
    info.p0a2_node_vs_worker = { node: p0node[0].platform, ...c, differing: c.differing.slice(0, 5), arm64: 'not verified' };
    check(c.differing.length === 0 && c.events > 0 && c.identical_events === c.events && c.payload_identical === P0SEEDS.length && c.chain_head_identical === P0SEEDS.length && c.log_hash_identical === P0SEEDS.length, `P0-A2 Node vs Chromium Worker (seeds ${P0SEEDS}, 48 h): ${c.identical_events}/${c.events} events byte-identical; log hash chain ${c.log_hash_identical}/${P0SEEDS.length}, event-chain head ${c.chain_head_identical}/${P0SEEDS.length}, whole payload ${c.payload_identical}/${P0SEEDS.length} identical (no tolerance; x86-64 only)`);
    info.p0a2 = { events_48h: p0.n48, log_hash_48h: p0.logHash, paced_pause_t: p0.tPaced, chunks: p0.chunks };
    check(p0.same2, 'P0-A2 Worker: same seed twice -> identical events and state');
    check(p0.restoredOk && p0.splitSame, 'P0-A2 Worker: 24 h -> snapshot -> terminate -> new Worker -> restore -> 24 h == 48 h continuous (every event and the full state, byte-identical)');
    check(p0.chunkSame, `P0-A2 Worker: ${p0.chunks} irregular step_until chunks -> identical`);
    check(p0.pacedSame && p0.tPaced > 0, `P0-A2 Worker: paced run (speeds 3600/86400/60, follow, pause, resume; paused at ${p0.tPaced.toFixed(1)} s) then step to 48 h -> identical events, event-log hash and state`);
    check(p0.refused === 'HASH_MISMATCH' && p0.kept && p0.refCode === 'FINGERPRINT_MISMATCH', `P0-A2 Worker: tampered snapshot refused (${p0.refused}), other code hash refused (${p0.refCode}), world kept`);
    check(p0.labelled && p0.protocolErrors.length === 0, 'P0-A2 Worker: every event labelled non-official; no reply rejected by the client');
  }

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
