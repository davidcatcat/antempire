/**
 * Cumulative population counters in saves/main.json are maintained by the save mapping (Owner decision, PR #5):
 *   colony.workers.confirmed_born += eclosions, colony.workers.cumulative_deaths += worker deaths,
 *   colony.worker_deaths_cumulative mirrors cumulative_deaths, colony.brood_deaths_cumulative += brood deaths,
 *   and the stage ledger uses the corrected key flux.eggs_hatching. world ant_population.legacy_* stay frozen.
 * Chains projectDaily IN MEMORY from the real Day14 saves for 120 days (nothing is written) and requires every
 * error-level conservation/transition check to pass every day, with births and deaths actually occurring.
 */
import assert from 'node:assert/strict';
import { projectDaily, DEFAULT_REFS } from '../cli/lib/project-day.ts';
import { checkSaves, checkTransition } from '../cli/lib/conservation.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';

const bundle = loadBundle(), fp = rulesFingerprint(), now = '2026-11-01T00:00:00.000Z';
let main = readJson('saves/main.json'), world = readJson('saves/world-state.json');
const clim = readJson('data/taichung-climatology-1991-2020.json');
const start = { born: main.colony.workers.confirmed_born, deaths: main.colony.workers.cumulative_deaths, brood: main.colony.brood_deaths_cumulative };
const legacy = JSON.stringify(['legacy_worker_births_confirmed', 'legacy_worker_deaths', 'legacy_brood_deaths'].map((k) => world.ant_population[k]));
let eclosions = 0, workerDeaths = 0, broodDeaths = 0, checks = 0;
for (let d = 0; d < 120; d++) {
  const before = { main: structuredClone(main), world: structuredClone(world) };
  const expectedStart = world.sim_engine_v2 ? { sugar: world.sim_engine_v2.colony.sugar, protein: world.sim_engine_v2.colony.protein } : { sugar: 7.6, protein: 2.3 };
  const run = projectDaily(main, world, world.sim_engine_v2 ? null : clim, bundle, fp, DEFAULT_REFS, now);
  const errors = [...checkSaves(run.main, run.world), ...checkTransition(before, { main: run.main, world: run.world }, run.report, expectedStart)].filter((c) => !c.ok && c.level === 'error');
  assert.equal(errors.length, 0, `Day ${run.report.day}: ${JSON.stringify(errors)}`); checks++;
  const flux = run.main.colony.population_demography.stage_ledger.flux;
  assert.ok('eggs_hatching' in flux && !('eggs_hatcing' in flux) && flux.eggs_hatching === run.report.summary.hatchings, 'corrected eggs_hatching key'); checks++;
  eclosions += run.report.summary.eclosions; workerDeaths += run.report.summary.worker_deaths; broodDeaths += run.report.summary.brood_deaths;
  main = run.main; world = run.world;
}
const w = main.colony.workers;
assert.equal(w.confirmed_born, start.born + eclosions); assert.equal(w.cumulative_deaths, start.deaths + workerDeaths);
assert.equal(main.colony.worker_deaths_cumulative, w.cumulative_deaths); assert.equal(main.colony.brood_deaths_cumulative, start.brood + broodDeaths);
assert.equal(w.confirmed_born - w.cumulative_deaths, w.current_alive); checks += 5;
assert.equal(JSON.stringify(['legacy_worker_births_confirmed', 'legacy_worker_deaths', 'legacy_brood_deaths'].map((k) => world.ant_population[k])), legacy, 'world legacy_* counters frozen after 120 days (Owner decision, PR #12)'); checks++;
assert.ok(eclosions > 0 && workerDeaths > 0, 'the 120-day chain must actually contain births and deaths to exercise the counters'); checks++;
console.log(JSON.stringify({ passed: true, checks, days: 120, eclosions, worker_deaths: workerDeaths, brood_deaths: broodDeaths, final: { confirmed_born: w.confirmed_born, cumulative_deaths: w.cumulative_deaths, current_alive: w.current_alive, brood_deaths_cumulative: main.colony.brood_deaths_cumulative } }, null, 2));
