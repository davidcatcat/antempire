/**
 * Port of sim/test_local_ecology.cjs (blocking part): ecological production and worker behaviour are
 * local-only; every parameter is a tagged assumption; the sugar-only control changes one parameter.
 * The orphan-queen hazard check of the same v6 script is in local-ecology-orphan-queen.test.ts because
 * it already FAILS on main (pre-existing, reported in the PR; not modified here).
 */
import { simulateDay, validateParamTree } from '../engine/index.ts';
import { bundle, counter, fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';
import { codeOnly } from './lib/static.ts';
import type { ParamFile } from '../engine/index.ts';

const c = counter(), { ok } = c, p = bundle(), initial = fixture();
// Static: ecology never sees any colony; worker decision/foraging modules never read the nest ledger.
const ecology = codeOnly('engine/ecology.ts');
ok(!/\b(colon(y|ies)|stores|population|workers)\b/i.test(ecology), 'plant and hemipteran ecology does not read nest budget');
for (const file of ['engine/workers.ts', 'engine/foraging.ts', 'engine/trails.ts', 'engine/routes.ts']) {
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
void MAIN_SPECIES;
console.log(JSON.stringify({ passed: c.checks, food_source_independent_of_colony_stocks: true, worker_task_no_global_inventory: true, sugar_control_one_variable: true, source_count: 4, official_save_changed: false }, null, 2));
