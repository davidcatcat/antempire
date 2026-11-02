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
 *     marked unknown, never placed on the map.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { exportOfficial, exportExperiment, EXPERIMENTS, layoutOf, WEB_DATA_DIR } from '../cli/web-export.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { buildDay0, seasonStart } from '../cli/lib/day0.ts';
import { displayPositions, poseAt, stateAtStart, segmentsOf, eventsUntil, type Experiment } from '../web/src/model.ts';

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
  // 4. events and workers come from the engine
  {
    const spec = EXPERIMENTS[0], exp = exps[0], bundle = loadBundle();
    let s = buildDay0(spec.founding, spec.seed, seasonStart(spec.season), bundle).state;
    for (let i = 0; i < exp.days.length; i++) {
      const o = simulateWorldDay(s, bundle), engineEvents = [...o.result.world_events, ...o.result.colonies[0].events].map((e) => JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['assumption', 'hazards', 'sampling'].includes(k)))));
      const pool = new Map<string, number>(); for (const e of engineEvents) pool.set(e, (pool.get(e) ?? 0) + 1);
      for (const e of exp.days[i].events) { const k = JSON.stringify(e), n = pool.get(k) ?? 0; assert.ok(n > 0, `day ${i + 1}: exported event not produced by the engine: ${k.slice(0, 160)}`); pool.set(k, n - 1); }
      const ids = new Set(stateAtStart(exp, i + 1).workers.map((w) => w.id)), engineIds = new Set(s.colonies[0].population.workers.map((w) => w.id));
      assert.deepEqual([...ids].sort(), [...engineIds].sort(), `day ${i + 1}: drawn workers = engine workers at the start of the day`);
      s = o.state;
    }
    checks += exp.days.length * 2;
  }
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
  console.log(JSON.stringify({ passed: true, checks, experiments: EXPERIMENTS.map((e) => e.id) }, null, 2));
} finally {
  for (const [f, h] of protectedFiles) assert.equal(sha(f), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join(), journalBefore, 'journal/ changed');
}
