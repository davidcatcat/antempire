/**
 * Port of sim/test_local_ecology.cjs: ecological production and worker behaviour are local-only; every
 * parameter is a tagged assumption; the sugar-only control changes one parameter; a workerless, starved
 * queen faces a materially higher hazard.
 *
 * Orphan-queen fixture (corrected 2026-11-01, approved by the player in PR #3): since v2-review.5 the
 * zero-worker queen hazard starts only after colony.no_worker_days >= starvation.queen_zero_worker_hazard_after_days.
 * The v6 script ran ONE day without setting no_worker_days, so the hazard could never trigger (0 vs 0) and
 * the script failed on main. The fixture now states that the colony has already been workerless for
 * (after_days - 1) days, so the simulated day is the first day the rule applies. Engine and parameters are
 * unchanged; the v6 engine gives the same 39 vs 1 with this fixture (= reports/local-ecology-tests.json).
 */
import { simulateDay, validateParamTree } from '../engine/index.ts';
import { bundle, counter, fixture, MAIN_SPECIES, setParam, species } from './lib/harness.ts';
import { codeOnly } from './lib/static.ts';
import type { ParamFile } from '../engine/index.ts';

const c = counter(), { ok } = c, p = bundle(), initial = fixture();
// Static: ecology never sees any colony; worker decision/foraging modules never read the nest ledger.
const ecology = codeOnly('engine/ecology.ts');
ok(!/\b(colon(y|ies)|stores|population|workers)\b/i.test(ecology), 'plant and hemipteran ecology does not read nest budget');
for (const file of ['engine/workers.ts', 'engine/foraging.ts', 'engine/trails.ts', 'engine/routes.ts', 'engine/activity.ts', 'engine/navigation.ts']) {
  ok(!/\bstores\b|\.sugar_gap_days|\.protein_gap_days|\.stress_days/.test(codeOnly(file)), 'worker behavior ' + file + ' does not read nest budget');
}
// Every numeric parameter is a labelled assumption with a basis (throws otherwise).
for (const [label, file] of [['world', p.world], ...Object.entries(p.species)] as [string, ParamFile][]) ok(validateParamTree(file, label) > 0, label + ' parameters are labelled game assumptions');
const starve = structuredClone(initial); starve.colony.sugar = 0; starve.colony.protein = 0; const a = simulateDay(initial, p), b = simulateDay(starve, p);
for (const id of ['F01', 'F04', 'F05', 'F10']) ok(JSON.stringify(a.state.sources[id].ecological_record) === JSON.stringify(b.state.sources[id].ecological_record), 'ecological production must ignore colony sugar/protein ' + id);
ok(JSON.stringify(a.summary.tasks) === JSON.stringify(b.summary.tasks), 'initial worker tasks must not look at colony inventory');
// Single-variable control: exactly one parameter differs.
const high = structuredClone(p); setParam(high, 'world', 'hemipterans.honeydew_productivity_multiplier', 1.5);
const leaves = (node: any, path: string, out: Map<string, number>) => { if (!node || typeof node !== 'object') return out; if ('value' in node) { out.set(path, node.value); return out; } for (const [k, v] of Object.entries(node)) leaves(v, path + '.' + k, out); return out; }; // eslint-disable-line @typescript-eslint/no-explicit-any
const before = leaves(p, '', new Map()), after = leaves(high, '', new Map());
const diff = [...before.keys()].filter((k) => before.get(k) !== after.get(k));
ok(diff.length === 1 && diff[0] === '.world.hemipterans.honeydew_productivity_multiplier', 'single-variable sugar-only test changes exactly one source productivity parameter');
// Workerless, starved queen: hazard materially higher than with the ordinary deficit hazard alone.
const starvation = (species(p) as any).starvation; // eslint-disable-line @typescript-eslint/no-explicit-any
function orphanState(seed: number) {
  const x = structuredClone(initial); x.seed = seed; x.population.workers = []; x.population.brood = []; x.colony.sugar = 0; x.colony.protein = 0; x.colony.sugar_gap_days = 7; x.colony.protein_gap_days = 7; x.colony.stress_days = 7;
  x.colony.no_worker_days = starvation.queen_zero_worker_hazard_after_days.value - 1; // already workerless for (after_days - 1) days
  for (const f of Object.values(x.sources)) { f.sugar = 0; f.protein = 0; f.host_alive = false; f.production_per_day = 0; if (f.type === 'honeydew') { f.host_plants = 0; f.hemipteran_colonies = 0; } if (f.type === 'nectar') f.bloom_days_left = 0; if (f.type === 'carcass') f.batches = []; }
  for (const q of Object.values(x.ecology.insects_by_site)) q.living = 0; x.ecology.adjacent_garden_living_insects = 0; return x;
}
const low = structuredClone(p); setParam(low, MAIN_SPECIES, 'starvation.queen_zero_worker_starved_daily_hazard', starvation.queen_daily_hazard.value);
let orphanDeaths = 0, baseDeaths = 0;
for (let i = 0; i < 160; i++) { const state = orphanState(420000 + i * 29); orphanDeaths += Number(simulateDay(state, p).summary.population.queen === 0); baseDeaths += Number(simulateDay(state, low).summary.population.queen === 0); }
ok(orphanDeaths > baseDeaths && orphanDeaths >= 25, 'zero-worker starved queen mortality risk materially higher under unchanged deterministic seeds');
console.log(JSON.stringify({ passed: c.checks, orphan_queen_trial_count: 160, queen_deaths_when_starved_and_workerless: orphanDeaths, queen_deaths_without_added_orphan_hazard: baseDeaths, food_source_independent_of_colony_stocks: true, worker_task_no_global_inventory: true, sugar_control_one_variable: true, source_count: 4, official_save_changed: false }, null, 2));
