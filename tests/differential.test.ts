/**
 * DIFFERENTIAL TEST against the original v6 JavaScript in sim/ (runs only while sim/ still exists).
 *
 * v2-review.7 changed exactly ONE rule: the nest temperature now remembers yesterday's NEST temperature
 * (climate.prior_nest_temp_model_c) instead of yesterday's air temperature. This test proves nothing else
 * changed:
 *  1. ISOLATION PROOF — for every diagnostic scenario (20 seeds × 120 days + extremes) the v6 trajectory is
 *     replayed; each day the TypeScript engine receives the same v6 input state with only
 *     climate.prior_nest_temp_model_c removed (so its nest-memory input equals what v6 effectively used).
 *     summary, events and state must then be byte-identical to v6 (engine_version excepted).
 *  2. migrationState on the REAL Day14 saves: byte-identical v2 state.
 *  3. projectDaily on the REAL Day14 saves -> Day15 (first day after migration, no nest temperature recorded
 *     yet, so v6 and v7 coincide): main/world/journal byte-identical after normalising only intentional
 *     metadata (engine/params reference strings, timestamp).
 * Nothing is written to saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { simulateDay, migrationState } from '../engine/index.ts';
import { projectDaily, DEFAULT_REFS } from '../cli/lib/project-day.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew, applyOld } from './lib/scenarios.ts';
import { normaliseV6Projection } from './lib/v6-normalise.ts';

if (!fs.existsSync(path.join(REPO_ROOT, 'sim/day_engine.cjs'))) { console.log(JSON.stringify({ skipped: 'sim/ archived; tests/golden.test.ts pins the v6 output instead' })); process.exit(0); }
const require = createRequire(import.meta.url);
const old = require(path.join(REPO_ROOT, 'sim/day_engine.cjs')), oldMigrate = require(path.join(REPO_ROOT, 'sim/migrate_day15.cjs')), oldRun = require(path.join(REPO_ROOT, 'sim/run_day.cjs'));
const firstDiff = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `at char ${i}: old …${a.slice(Math.max(0, i - 120), i + 80)}… new …${b.slice(Math.max(0, i - 120), i + 80)}…`; };
const fail = (msg: string) => { console.error('DIFFERENTIAL FAILURE ' + msg); process.exit(1); };

const fx = readJson('tests/fixtures/day14-projection.json');
if (fs.readFileSync(path.join(REPO_ROOT, 'sim/day14-projection.json'), 'utf8') !== fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/day14-projection.json'), 'utf8')) fail('tests/fixtures/day14-projection.json is not a byte copy of sim/day14-projection.json');
let days = 0;
for (const sc of SCENARIOS) {
  let a = structuredClone(fx); if (sc.seed) a.seed = sc.seed; sc.state(a);
  const op = readJson('sim/params.json'); applyOld(op, sc.params);
  const nb = loadBundle(); applyNew(nb, sc.params);
  for (let d = 0; d < sc.days; d++) {
    const b = structuredClone(a); delete b.climate.prior_nest_temp_model_c; // neutralise ONLY the fixed rule
    const x = old.simulateDay(a, op), y = simulateDay(b, nb);
    const sx = JSON.stringify([x.day, x.summary, x.events, x.state]), sy = JSON.stringify([y.day, y.summary, y.events, y.state]);
    if (sx !== sy) fail(`${sc.name} day ${x.day} ${firstDiff(sx, sy)}`);
    a = x.state; days++;
  }
}

// Real authoritative Day14 saves (read-only).
const main = readJson('saves/main.json'), world = readJson('saves/world-state.json'), clim = readJson('data/taichung-climatology-1991-2020.json');
const oldParams = readJson('sim/params.json'), bundle = loadBundle();
const ms = JSON.stringify(oldMigrate.migrationState(main, world, clim, oldParams)), ns = JSON.stringify(migrationState(main, world, clim, bundle));
if (ms !== ns) fail('migrationState ' + firstDiff(ms, ns));

const fp = rulesFingerprint(), now = '2026-11-01T00:00:00.000Z';
const o = oldRun.projectDaily(structuredClone(main), structuredClone(world), clim, oldParams, fp.engine, fp.params);
const n = projectDaily(structuredClone(main), structuredClone(world), clim, bundle, fp, DEFAULT_REFS, now);
// Normalise ONLY the intentional save-mapping differences of the old output (see tests/lib/v6-normalise.ts).
normaliseV6Projection(o, now);
for (const [label, a, b] of [['main.json', o.main, n.main], ['world-state.json', o.world, n.world], ['journal', o.journal, n.journal]] as const) {
  const sa = JSON.stringify(a, null, 2), sb = JSON.stringify(b, null, 2);
  if (sa !== sb) fail(`projectDaily ${label} ${firstDiff(sa, sb)}`);
}
console.log(JSON.stringify({ passed: true, isolation_proof: 'v7 = v6 when only climate.prior_nest_temp_model_c is withheld', scenarios: SCENARIOS.length, simulated_days_compared: days, migration_state_identical: true, day15_projection_identical_after_metadata_normalisation: true, normalised: 'tests/lib/v6-normalise.ts (refs, timestamp, cumulative counters, eggs_hatching key)', day15_population: n.report.summary.population }, null, 2));
