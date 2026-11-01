/**
 * Rules-update evidence for v2-review.7 (nest-temperature memory fix): runs every diagnostic scenario of
 * tests/lib/scenarios.ts with the ORIGINAL v6 engine (sim/day_engine.cjs + sim/params.json) and with the
 * current engine, and writes the outcome table to reports/rules-update-v7-nest-temperature-scenarios.json.
 * Diagnostic only: never touches saves/ or journal/. Requires sim/ (the v6 engine) to exist.
 *   node cli/reports/compare-v6-v7.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { simulateDay, ENGINE_VERSION } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { SCENARIOS, applyNew, applyOld } from '../../tests/lib/scenarios.ts';

const require = createRequire(import.meta.url);
const old = require(path.join(REPO_ROOT, 'sim/day_engine.cjs'));
const initial = readJson('tests/fixtures/day14-projection.json');
type Row = Record<string, number | string | null>;
const summarise = (outs: any[]): Row => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const last = outs.at(-1).summary, nest = outs.map((o) => o.summary.weather.nest_temp_model_c);
  let swing = 0; for (let i = 1; i < nest.length; i++) swing += Math.abs(nest[i] - nest[i - 1]);
  const sum = (f: (s: any) => number) => +outs.reduce((a, o) => a + f(o.summary), 0).toFixed(4); // eslint-disable-line @typescript-eslint/no-explicit-any
  return { final_day: last.day, queen: last.population.queen, workers: last.population.workers, eggs: last.population.eggs, larvae: last.population.larvae, pupae: last.population.pupae, eggs_laid: sum((s) => s.eggs_laid), eclosions: sum((s) => s.eclosions), worker_deaths: sum((s) => s.worker_deaths), sugar_consumed: sum((s) => s.consumed.sugar), protein_consumed: sum((s) => s.consumed.protein), mean_nest_temp_c: +(nest.reduce((a, b) => a + b, 0) / nest.length).toFixed(3), min_nest_temp_c: Math.min(...nest), max_nest_temp_c: Math.max(...nest), mean_abs_daily_nest_change_c: nest.length > 1 ? +(swing / (nest.length - 1)).toFixed(3) : null };
};
const rows = [];
for (const sc of SCENARIOS.filter((s) => !s.name.startsWith('baseline-seed-'))) {
  const runs: Record<string, Row> = {};
  for (const engine of ['v6', 'v7'] as const) {
    let state = structuredClone(initial); if (sc.seed) state.seed = sc.seed; sc.state(state);
    const outs = [];
    if (engine === 'v6') { const p = readJson('sim/params.json'); applyOld(p, sc.params); for (let d = 0; d < sc.days; d++) { const o = old.simulateDay(state, p); outs.push(o); state = o.state; } }
    else { const b = loadBundle(); applyNew(b, sc.params); for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, b); outs.push(o); state = o.state; } }
    runs[engine] = summarise(outs);
  }
  rows.push({ scenario: sc.name, days: sc.days, v6: runs.v6, v7: runs.v7 });
}
const doc = { schema: 'antempire.rules-update.v7-nest-temperature.scenarios', v6_engine: old.ENGINE_VERSION, v7_engine: ENGINE_VERSION, official_day14_advanced: false, game_assumptions: true, note: 'Same fixture, seeds and parameters; only the nest-temperature memory differs. Diagnostic, not a target; nothing was tuned.', scenarios: rows };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v7-nest-temperature-scenarios.json'), JSON.stringify(doc, null, 2) + '\n');
for (const r of rows) console.log(r.scenario.padEnd(28), 'v6', JSON.stringify([r.v6.queen, r.v6.workers, r.v6.eggs_laid, r.v6.eclosions, r.v6.worker_deaths, r.v6.mean_abs_daily_nest_change_c]), 'v7', JSON.stringify([r.v7.queen, r.v7.workers, r.v7.eggs_laid, r.v7.eclosions, r.v7.worker_deaths, r.v7.mean_abs_daily_nest_change_c]));
