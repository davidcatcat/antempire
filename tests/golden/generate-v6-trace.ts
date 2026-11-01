/**
 * Generates tests/golden/v6-trace-sha256.json FROM THE ORIGINAL v6 ENGINE (sim/day_engine.cjs + sim/params.json).
 * Each scenario's hash chains sha256(JSON.stringify([summary, events, state])) of every simulated day.
 * Run once while sim/ still exists; the committed file then pins the full output after sim/ is archived.
 *   node tests/golden/generate-v6-trace.ts
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT, readJson } from '../../cli/lib/load.ts';
import { SCENARIOS, applyOld } from '../lib/scenarios.ts';

const require = createRequire(import.meta.url);
const enginePath = path.join(REPO_ROOT, 'sim/day_engine.cjs');
if (!fs.existsSync(enginePath)) throw Error('sim/day_engine.cjs not found: the v6 trace can only be generated from the original engine');
const { simulateDay } = require(enginePath);
const initial = readJson('sim/day14-projection.json'), baseParams = readJson('sim/params.json');
const out: Record<string, { days: number; final_day: number; sha256: string }> = {};
for (const sc of SCENARIOS) {
  let state = structuredClone(initial); if (sc.seed) state.seed = sc.seed; sc.state(state);
  const params = structuredClone(baseParams); applyOld(params, sc.params);
  let chain = '';
  for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, params); chain = crypto.createHash('sha256').update(chain + JSON.stringify([o.summary, o.events, o.state])).digest('hex'); state = o.state; }
  out[sc.name] = { days: sc.days, final_day: state.sim_day, sha256: chain };
}
const doc = { schema: 'antempire.golden-trace.v1', generated_from: { engine: 'sim/day_engine.cjs', params: 'sim/params.json', fixture: 'sim/day14-projection.json', engine_version: require(enginePath).ENGINE_VERSION }, method: 'per scenario: h_0="" ; h_d = sha256(h_{d-1} + JSON.stringify([summary, events, state])) ; recorded h_days', scenarios: out };
fs.writeFileSync(path.join(REPO_ROOT, 'tests/golden/v6-trace-sha256.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${Object.keys(out).length} scenario traces`);
