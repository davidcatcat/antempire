/**
 * Read-only web viewer (web/, cli/web-export.ts). The viewer must only SHOW what the engine and the official saves
 * contain:
 *  1. the export is deterministic (same seed -> byte-identical files) and the committed web/data/ equals a fresh
 *     export (data are regenerated whenever the engine changes);
 *  2. exporting never writes saves/ or journal/;
 *  3. the official snapshot lists exactly the saved individuals (none invented, none dropped);
 *  4. every experiment event shown is an engine event (same fields, nothing added) and every worker drawn exists in
 *     the engine state at the start of that day;
 *  5. display interpolation is pure and only between recorded points: at every recorded route_step minute the drawn
 *     position is exactly the node's position, and poseAt never returns an event;
 *  6. the renderer is separated from the engine: web/src imports nothing from engine/ or cli/, never writes data,
 *     never uses randomness;
 *  7. the schematic layout comes only from the recorded bearing + approximate distance; places without them are
 *     marked unknown, never placed on the map;
 *  8. life-cycle and replay boundaries (every experiment): an eclosed worker is drawn from the next day only, a dead
 *     worker is not drawn after its death day, the population changes only by recorded eclosions and deaths, the day
 *     boundary is exactly the engine's end-of-day state, and minutes/days outside the recorded replay are not
 *     extrapolated;
 *  9. official and experiment data are never mixed: each file declares its kind, the loader refuses the wrong kind,
 *     experiment files hold no official colony data, the official snapshot holds no replay.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { exportOfficial, exportExperiment, EXPERIMENTS, layoutOf, WEB_DATA_DIR } from '../cli/web-export.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { buildDay0, seasonStart } from '../cli/lib/day0.ts';
import { type SimEvent, assertKind, taskOf, trailScale, stateAt, isTimed, SETTLEMENT_STEP, displayPositions, poseAt, stateAtStart, segmentsOf, eventsUntil, type Experiment } from '../web/src/model.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');
const protectedFiles = ['saves/main.json', 'saves/world-state.json'].map((f) => [f, sha(f)]);
const journalBefore = fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join();

try {
  // 1. determinism and committed data
  const off = exportOfficial(), off2 = exportOfficial();
  ok(JSON.stringify(off) === JSON.stringify(off2), 'official snapshot export is deterministic');
  ok(fs.readFileSync(path.join(REPO_ROOT, WEB_DATA_DIR, 'official-day14.json'), 'utf8') === JSON.stringify(off) + '\n', 'committed web/data/official-day14.json equals a fresh export');
  const exps: Experiment[] = [];
  for (const spec of EXPERIMENTS) {
    const a = exportExperiment(spec), b = exportExperiment(spec);
    ok(JSON.stringify(a) === JSON.stringify(b), `${spec.id}: same seed -> byte-identical export`);
    ok(fs.readFileSync(path.join(REPO_ROOT, WEB_DATA_DIR, `experiment-${spec.id}.json`), 'utf8') === JSON.stringify(a) + '\n', `${spec.id}: committed web/data equals a fresh export (re-run node cli/web-export.ts after engine changes)`);
    ok(a.official === false && a.kind === 'experiment', `${spec.id}: marked as experiment, not official`);
    exps.push(a);
  }
  // 3. official snapshot
  const main = readJson('saves/main.json');
  ok(JSON.stringify(off.workers.map((w: Any) => [w.id, w.status])) === JSON.stringify(main.colony.workers.individuals.map((w: Any) => [w.id, w.status])), 'official snapshot: exactly the saved workers with their status');
  ok(off.read_only === true && off.sources.files['saves/main.json'] === sha('saves/main.json'), 'official snapshot records the hashes of the saves it read');
  // 4. events and workers come from the engine — for EVERY experiment scenario
  EXPERIMENTS.forEach((spec, k) => {
    const exp = exps[k], bundle = loadBundle();
    let s = buildDay0(spec.founding, spec.seed, seasonStart(spec.season), bundle).state;
    let shown = 0;
    for (let i = 0; i < exp.days.length; i++) {
      const o = simulateWorldDay(s, bundle), engineEvents = [...o.result.world_events, ...o.result.colonies[0].events].map((e) => JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['assumption', 'hazards', 'sampling'].includes(k)))));
      const pool = new Map<string, number>(); for (const e of engineEvents) pool.set(e, (pool.get(e) ?? 0) + 1);
      for (const e of exp.days[i].events) { const key = JSON.stringify(e), n = pool.get(key) ?? 0; assert.ok(n > 0, `${spec.id} day ${i + 1}: exported event not produced by the engine: ${key.slice(0, 160)}`); pool.set(key, n - 1); shown++; }
      const ids = new Set(stateAtStart(exp, i + 1).workers.map((w) => w.id)), engineIds = new Set(s.colonies[0].population.workers.map((w) => w.id));
      assert.deepEqual([...ids].sort(), [...engineIds].sort(), `${spec.id} day ${i + 1}: drawn workers = engine workers at the start of the day`);
      s = o.state;
    }
    ok(shown > 0, `${spec.id}: ${shown} exported events, every one produced by the engine; drawn workers = engine workers on all ${exp.days.length} days`);
  });
  // 5. interpolation
  for (const exp of exps) {
    const pos = displayPositions(exp.map.places);
    for (const d of exp.days) {
      for (const st of d.events.filter((e) => e.type === 'route_step') as Any[]) {
        const p = poseAt(d, st.worker, st.minute, pos);
        assert.ok(Math.abs(p.x - pos[st.to].x) < 1e-6 && Math.abs(p.y - pos[st.to].y) < 1e-6, `${exp.spec.id} day ${d.day}: ${st.worker} drawn at ${st.to} when the engine says it arrived (minute ${st.minute})`);
        const again = poseAt(d, st.worker, st.minute, pos);
        assert.deepEqual(again, p, 'poseAt is pure');
      }
      for (const w of stateAtStart(exp, d.day).workers) for (const t of [0, 7.5, 60, 180, 359.9]) { const p = poseAt(d, w.id, t, pos); assert.ok(!('type' in (p as Any)) && Number.isFinite(p.x) && Number.isFinite(p.y), 'poseAt returns a display pose, never an event'); }
      const seen = eventsUntil(d, 1e9); assert.ok(seen.every((e) => d.events.includes(e)), 'eventsUntil only filters recorded events');
      if (segmentsOf(d, 'W001').some((x) => (x.end as number) < (x.start as number))) assert.fail('segment ends before it starts');
    }
    checks += 4;
  }
  // 6. separation
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'web/src'))) {
    const code = fs.readFileSync(path.join(REPO_ROOT, 'web/src', f), 'utf8');
    for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `web/src/${f} imports only viewer modules (${m[1]})`);
    ok(!/Math\.random|localStorage\.setItem|method:\s*'(POST|PUT|DELETE)'/.test(code), `web/src/${f}: no randomness, no storage writes, no write requests`);
    ok(!/simulateWorldDay|simulateDay|initializeDay0/.test(code), `web/src/${f}: the renderer does not run the simulation`);
  }
  // 7. layout
  ok(layoutOf('東北', 48)?.x === 33.94 && layoutOf('北', 92)?.y === 92 && layoutOf('未知', null) === null && layoutOf(null, 40) === null, 'layout only from recorded bearing + distance; unknown stays unknown');
  const pos = displayPositions(off.map.places);
  ok(off.map.places.filter((p: Any) => !p.layout).every((p: Any) => pos[p.id].known === false), 'places without a recorded position are flagged unknown (drawn in a separate tray)');
  // 8. life-cycle and replay boundaries
  let eclosionsSeen = 0, deathsSeen = 0;
  for (const exp of exps) {
    const id = exp.spec.id;
    ok(stateAtStart(exp, 1) === exp.day0.state, `${id}: day 1 starts from the exported Day0 state`);
    for (let d = 1; d <= exp.days.length; d++) {
      const day = exp.days[d - 1], before = new Set(stateAtStart(exp, d).workers.map((w) => w.id)), after = day.end_state.workers.map((w) => w.id);
      if (d < exp.days.length) assert.equal(stateAtStart(exp, d + 1), day.end_state, `${id} day ${d}: the next day starts exactly at the engine's end-of-day state`);
      const born = day.events.filter((e) => e.type === 'eclosion').map((e) => e.new_worker_id as string), died = day.events.filter((e) => e.type === 'worker_death').map((e) => e.id as string);
      for (const w of born) { assert.ok(!before.has(w) && after.includes(w), `${id} day ${d}: eclosed ${w} is drawn from the next day only`); eclosionsSeen++; }
      for (const w of died) { assert.ok(before.has(w) && !after.includes(w), `${id} day ${d}: ${w} died this day and is not drawn afterwards`); deathsSeen++; }
      assert.deepEqual([...before].filter((w) => !died.includes(w)).concat(born).sort(), [...after].sort(), `${id} day ${d}: population changes only by recorded eclosions and deaths`);
      assert.equal(day.eclosions, born.length, `${id} day ${d}: eclosion count = eclosion events`);
      // minutes: nothing before minute 0 is shown; untimed (end-of-day) events only after the settlement step
      const w = day.window_minutes ?? 360, all = eventsUntil(day, w + SETTLEMENT_STEP);
      assert.ok(eventsUntil(day, 0).every((e) => isTimed(e) && ((e.minute ?? e.start) as number) <= 0), `${id} day ${d}: at minute 0 only minute-0 events are shown`);
      assert.ok(eventsUntil(day, w).every(isTimed), `${id} day ${d}: end-of-day events (death, eclosion, laying) are NOT shown at any clock minute inside the window`);
      assert.deepEqual(eventsUntil(day, w + 1e6), all, `${id} day ${d}: nothing is added after the settlement step`);
      assert.equal(all.length, day.events.filter((e) => e.type !== 'worker_activity' && e.type !== 'route_step').length, `${id} day ${d}: after settlement every recorded event is listed`);
      // drawn colony: start-of-day during the window, end-of-day after the settlement step
      assert.equal(stateAt(exp, d, w), stateAtStart(exp, d), `${id} day ${d}: inside the window the drawn colony is the start-of-day state`);
      assert.equal(stateAt(exp, d, w + SETTLEMENT_STEP), day.end_state, `${id} day ${d}: after settlement the drawn colony is the engine's end-of-day state (deaths and eclosions applied)`);
      // one individual, one activity at a time (Issue #43 F03 would show up here in exported data)
      const byW = new Map<string, SimEvent[]>();
      for (const e of day.events.filter((x) => x.type === 'worker_activity')) byW.set(e.worker as string, [...(byW.get(e.worker as string) ?? []), e]);
      for (const [wk, segs] of byW) { const sorted = [...segs].sort((a, b) => (a.start as number) - (b.start as number)); for (let i = 1; i < sorted.length; i++) assert.ok((sorted[i].start as number) >= (sorted[i - 1].end as number) - 1e-6, `${id} day ${d}: ${wk} has overlapping activities ${JSON.stringify([sorted[i - 1], sorted[i]])}`); }
      const pos = displayPositions(exp.map.places);
      for (const wk of stateAtStart(exp, d).workers.slice(0, 6)) {
        assert.deepEqual(poseAt(day, wk.id, w, pos), poseAt(day, wk.id, w + 500, pos), `${id} day ${d}: ${wk.id} is not moved after the recorded window`);
        const first = segmentsOf(day, wk.id)[0];
        if (!first || (first.start as number) > 0) assert.equal(poseAt(day, wk.id, -5, pos).place, 'N00', `${id} day ${d}: before its first recorded segment ${wk.id} is drawn in the nest`);
      }
    }
    for (const bad of [0, -1, exp.days.length + 1, 1.5]) assert.throws(() => stateAtStart(exp, bad), RangeError, `${id}: day ${bad} is outside the replay and refused`);
    checks += exp.days.length * 6 + 4;
  }
  ok(eclosionsSeen > 0 && deathsSeen > 0, `eclosion (${eclosionsSeen}) and death (${deathsSeen}) boundaries were actually exercised`);
  // 10. layers (V2): task colours and pheromone legend only use engine records
  for (const exp of exps) for (let d = 1; d <= exp.days.length; d++) {
    const day = exp.days[d - 1], st = stateAtStart(exp, d);
    for (const w of st.workers) { const t = taskOf(day, st, w.id); assert.ok(t.source === 'engine_day_task' ? t.task === day.tasks![w.id].task : t.task === w.task, `${exp.spec.id} day ${d}: ${w.id} coloured by the engine's task`); }
    assert.equal(taskOf(day, st, 'NOT-A-WORKER').task, null, 'no task invented for an unknown id');
    const tr = trailScale(st), vals = Object.values(st.trails).filter((x) => x > 0);
    assert.ok(tr.max === (vals.length ? Math.max(...vals) : 0) && tr.edges === vals.length, `${exp.spec.id} day ${d}: pheromone legend = engine trail values at the start of the day`);
    checks += st.workers.length + 2;
  }
  // 9. official and experiment data are never mixed
  const idx = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, WEB_DATA_DIR, 'index.json'), 'utf8'));
  const offFile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, WEB_DATA_DIR, idx.official), 'utf8'));
  ok(assertKind(offFile, 'official', idx.official) === offFile && !('days' in offFile) && !('spec' in offFile) && !('engine_version' in offFile), 'the official file is an official snapshot without any replay');
  assert.throws(() => assertKind(offFile, 'experiment', idx.official), /not experiment data/); checks++;
  ok(idx.experiments.length === EXPERIMENTS.length && idx.experiments.every((e: Any) => e.file !== idx.official), 'index lists each experiment once and never the official file as an experiment');
  for (const e of idx.experiments) {
    const f = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, WEB_DATA_DIR, e.file), 'utf8'));
    ok(assertKind(f, 'experiment', e.file) === f && f.official === false, `${e.file}: declares itself experiment / not official`);
    assert.throws(() => assertKind(f, 'official', e.file), /not official data/); checks++;
    const spec = EXPERIMENTS.find((x) => x.id === e.id)!, engineDay0 = buildDay0(spec.founding, spec.seed, seasonStart(spec.season), loadBundle()).state.colonies[0];
    ok(JSON.stringify(f.day0.state.workers.map((w: Any) => w.id)) === JSON.stringify(engineDay0.population.workers.map((w) => w.id)) && JSON.stringify(f.day0.state.brood.map((b: Any) => b.id)) === JSON.stringify(engineDay0.population.brood.map((b) => b.id)), `${e.file}: Day0 individuals come from the Day0 initializer, not from the official save`);
    ok(typeof f.map.geography_source === 'string' && f.map.geography_source.includes('world_map.locations'), `${e.file}: only garden geography is read from the official record, and it says so`);
  }
  console.log(JSON.stringify({ passed: true, checks, experiments: EXPERIMENTS.map((e) => e.id), eclosions_checked: eclosionsSeen, deaths_checked: deathsSeen }, null, 2));
} finally {
  for (const [f, h] of protectedFiles) assert.equal(sha(f), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(), journalBefore, 'journal/ changed');
}
