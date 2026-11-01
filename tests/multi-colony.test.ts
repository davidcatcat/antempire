/**
 * Multi-colony structure.
 *  1. The native v3 world path (knowledge split out of sources, colony list) produces the same results as
 *     the legacy single-colony path for 20 seeds × 60 days (key order may differ; values identical).
 *  2. A second colony of a DIFFERENT species file can live in the same world: separate RNG namespace, ID
 *     prefixes, trails and knowledge; world ecology before foraging is unaffected by its presence;
 *     conservation holds and replay is deterministic. (Structural fixture only — the second "species" is a
 *     relabelled copy used to exercise the code path, NOT a real species parameterisation.)
 */
import assert from 'node:assert/strict';
import { simulateDay, simulateWorldDay, legacyToWorldState, legacyColonyMeta, type WorldState, type ParamBundle } from '../engine/index.ts';
import { bundle as loadB, fixture, MAIN_SPECIES } from './lib/harness.ts';

const b = loadB(), meta = legacyColonyMeta(b.world.scenario_colonies as any), init = fixture(); // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0;
for (let k = 0; k < 20; k++) {
  let legacy = structuredClone(init); legacy.seed = 15032026 + k;
  let world: WorldState = legacyToWorldState(legacy, meta);
  for (let d = 0; d < 60; d++) {
    const a = simulateDay(legacy, b), v = simulateWorldDay(world, b);
    const col = v.state.colonies[0], res = v.result.colonies[0];
    assert.deepStrictEqual(res.summary, a.summary, `summary seed ${legacy.seed} day ${a.day}`);
    assert.deepStrictEqual([...v.result.world_events, ...res.events], a.events, `events seed ${legacy.seed} day ${a.day}`);
    assert.deepStrictEqual(col.population, a.state.population);
    assert.deepStrictEqual(col.stores, a.state.colony);
    assert.deepStrictEqual(col.trail_by_edge, a.state.ecology.trail_by_edge ?? {});
    for (const [id, src] of Object.entries(a.state.sources)) { const { presence, known_by, ...rest } = src; assert.deepStrictEqual(v.state.sources[id], rest); assert.deepStrictEqual(col.source_knowledge[id], { presence, known_by }); }
    const { trail_by_edge, ...eco } = a.state.ecology; void trail_by_edge; assert.deepStrictEqual(v.state.ecology, eco);
    assert.equal(col.next_worker_number, a.state.next_worker_number); assert.equal(col.next_egg_number, a.state.next_egg_number);
    checks += 9; legacy = a.state; world = v.state;
  }
}

// Two colonies, two species files.
const OTHER = 'structural-test-species-b';
const two: ParamBundle = structuredClone(b);
two.species[OTHER] = { ...structuredClone(b.species[MAIN_SPECIES]), species_id: OTHER };
const base = legacyToWorldState(init, meta);
const second = structuredClone(base.colonies[0]);
Object.assign(second, { id: 'B', species_id: OTHER, nest_node: 'U00', queen_id: 'B-Q001', rng_namespace: 'B|', worker_id_prefix: 'B-W', egg_id_prefix: 'B-E', next_worker_number: 1, next_egg_number: 1, trail_by_edge: {}, last_report: undefined });
second.population.workers = second.population.workers.slice(0, 5).map((w, i) => ({ ...w, id: `B-W9${i}`, known_sources: [], last_location: 'U00', site_memory: {} }));
second.population.brood = [];
second.source_knowledge = Object.fromEntries(Object.keys(base.sources).map((id) => [id, { presence: 'potential', known_by: [] }]));
delete (second as any).last_report; // eslint-disable-line @typescript-eslint/no-explicit-any
let both: WorldState = { ...structuredClone(base), colonies: [structuredClone(base.colonies[0]), second] };
let solo: WorldState = structuredClone(base);
const ids = new Set<string>();
for (let d = 0; d < 40; d++) {
  const o = simulateWorldDay(both, two), s1 = simulateWorldDay(solo, b);
  assert.deepStrictEqual(o, simulateWorldDay(both, two), 'deterministic replay with two colonies'); checks++;
  assert.deepStrictEqual(o.result.weather, s1.result.weather, 'weather independent of colonies'); checks++;
  if (d === 0) { assert.deepStrictEqual(o.result.world_events, s1.result.world_events, 'ecology before foraging independent of a second colony'); checks++; }
  for (const c of o.result.colonies) {
    const pop = c.summary.population;
    assert.equal(pop.workers + c.summary.worker_deaths, c.summary.workers_before + c.summary.eclosions); checks++;
    for (const e of c.events) if (e.type === 'egg_laid' || e.type === 'eclosion') ids.add(String(e.id ?? e.new_worker_id));
  }
  const bCol = o.state.colonies[1];
  assert.ok(bCol.population.workers.every((w) => w.id.startsWith('B-W')), 'colony B IDs keep its prefix'); checks++;
  assert.ok(Object.values(o.state.colonies[0].source_knowledge).every((k) => k.known_by.every((id) => !id.startsWith('B-'))), 'colony knowledge is not shared'); checks++;
  both = o.state; solo = s1.state;
}
console.log(JSON.stringify({ checks, v3_equals_legacy_seeds: 20, v3_equals_legacy_days: 60, two_colony_days: 40, distinct_new_ids: ids.size }, null, 2));
