/**
 * Port of the orphan-queen assertion of sim/test_local_ecology.cjs, kept VERBATIM.
 *
 * KNOWN PRE-EXISTING FAILURE: on main the v6 engine gives 0 queen deaths in both arms (0 vs 0), because
 * since v2-review.5 the zero-worker hazard needs colony.no_worker_days >= 3, which this one-day fixture
 * never reaches. The old script therefore fails on main too. Not fixed here (no rule/test changes in a
 * refactor PR); the question is raised in the PR. This script still verifies parity: it reports the exact
 * counts and exits 1 while the original assertion fails.
 */
import { simulateDay } from '../engine/index.ts';
import { bundle, fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';

const p = bundle(), initial = fixture();
function orphanState(seed: number) {
  const x = structuredClone(initial); x.seed = seed; x.population.workers = []; x.population.brood = []; x.colony.sugar = 0; x.colony.protein = 0; x.colony.sugar_gap_days = 7; x.colony.protein_gap_days = 7; x.colony.stress_days = 7;
  for (const f of Object.values(x.sources)) { f.sugar = 0; f.protein = 0; f.host_alive = false; f.production_per_day = 0; if (f.type === 'honeydew') { f.host_plants = 0; f.hemipteran_colonies = 0; } if (f.type === 'nectar') f.bloom_days_left = 0; if (f.type === 'carcass') f.batches = []; }
  for (const q of Object.values(x.ecology.insects_by_site)) q.living = 0; x.ecology.adjacent_garden_living_insects = 0; return x;
}
const low = structuredClone(p); setParam(low, MAIN_SPECIES, 'starvation.queen_zero_worker_starved_daily_hazard', (low.species[MAIN_SPECIES] as any).starvation.queen_daily_hazard.value); // eslint-disable-line @typescript-eslint/no-explicit-any
let orphanDeaths = 0, baseDeaths = 0;
for (let i = 0; i < 160; i++) { const state = orphanState(420000 + i * 29); orphanDeaths += Number(simulateDay(state, p).summary.population.queen === 0); baseDeaths += Number(simulateDay(state, low).summary.population.queen === 0); } // eslint-disable-line @typescript-eslint/no-explicit-any
const pass = orphanDeaths > baseDeaths && orphanDeaths >= 25;
console.log(JSON.stringify({ assertion: 'zero-worker starved queen mortality risk materially higher under unchanged deterministic seeds', pass, orphan_queen_trial_count: 160, queen_deaths_when_starved_and_workerless: orphanDeaths, queen_deaths_without_added_orphan_hazard: baseDeaths, v6_engine_on_main_gives: { orphanDeaths: 0, baseDeaths: 0 }, status: pass ? 'PASS' : 'KNOWN PRE-EXISTING FAILURE (also fails with sim/test_local_ecology.cjs on main) — awaiting decision' }, null, 2));
if (!pass) process.exitCode = 1;
