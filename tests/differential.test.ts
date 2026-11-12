/**
 * DIFFERENTIAL TEST against the original v6 JavaScript in sim/ (runs only while sim/ still exists).
 *
 * Every intentional behaviour change since v6 is listed in tests/golden/approved-rule-changes.json
 * (v2-review.7 nest-temperature memory, v2-review.8 injured-worker task weights, ...). This test proves the
 * current engine differs from v6 by NOTHING ELSE:
 *  1. ISOLATION PROOF — for every diagnostic scenario (20 seeds × 120 days + extremes) the v6 trajectory is
 *     replayed; each day the TypeScript engine receives the same v6 input with exactly the approved changes
 *     undone (approved parameter values reverted, approved engine changes neutralised on the input state).
 *     summary, events and state must then be byte-identical to v6 (engine_version excepted).
 * (Until #194 this test also replayed the Day14 -> Day15 migration and save mapping on the official Day14 saves against
 *  sim/migrate_day15.cjs and sim/run_day.cjs. The legacy saves and that official Day15 path were retired by the Owner
 *  on 2026-11-12, so only the engine isolation proof remains; tests/injury.test.ts and tests/migration.test.ts still
 *  cover engine/migration.ts on the retired fixture until a rules-update PR removes it.)
 * Nothing is written to saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { simulateDay } from '../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew, applyOld } from './lib/scenarios.ts';
import { neutraliseState, revertParams, approvedChanges, normaliseOutput } from './lib/approved-changes.ts';

if (!fs.existsSync(path.join(REPO_ROOT, 'sim/day_engine.cjs'))) { console.log(JSON.stringify({ skipped: 'sim/ archived; tests/golden.test.ts pins the v6 output instead' })); process.exit(0); }
const require = createRequire(import.meta.url);
const old = require(path.join(REPO_ROOT, 'sim/day_engine.cjs'));
const firstDiff = (a: string, b: string) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return `at char ${i}: old …${a.slice(Math.max(0, i - 120), i + 80)}… new …${b.slice(Math.max(0, i - 120), i + 80)}…`; };
const fail = (msg: string) => { console.error('DIFFERENTIAL FAILURE ' + msg); process.exit(1); };

const fx = readJson('tests/fixtures/day14-projection.json');
if (fs.readFileSync(path.join(REPO_ROOT, 'sim/day14-projection.json'), 'utf8') !== fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/day14-projection.json'), 'utf8')) fail('tests/fixtures/day14-projection.json is not a byte copy of sim/day14-projection.json');
let days = 0;
for (const sc of SCENARIOS) {
  let a = structuredClone(fx); if (sc.seed) a.seed = sc.seed; sc.state(a);
  const op = readJson('sim/params.json'); applyOld(op, sc.params);
  const nb = loadBundle(); revertParams(nb); applyNew(nb, sc.params);
  for (let d = 0; d < sc.days; d++) {
    const b = structuredClone(a); neutraliseState(b); // undo ONLY the approved engine changes
    const x = old.simulateDay(a, op), y = simulateDay(b, nb);
    const sx = JSON.stringify([x.day, x.summary, x.events, x.state]), sy = JSON.stringify(normaliseOutput([y.day, y.summary, y.events, y.state]));
    if (sx !== sy) fail(`${sc.name} day ${x.day} ${firstDiff(sx, sy)}`);
    a = x.state; days++;
  }
}

console.log(JSON.stringify({ passed: true, isolation_proof: 'current engine = v6 once exactly the approved changes are undone', approved_changes: approvedChanges().map((c) => `${c.rules_version} ${c.kind} ${c.path ?? c.neutralise?.delete_state_path ?? ''}`), scenarios: SCENARIOS.length, simulated_days_compared: days, retired_by_194: 'Day14 -> Day15 migration / save-mapping comparison (official world retired)' }, null, 2));
