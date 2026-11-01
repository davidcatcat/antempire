/**
 * Adapter for the v2 single-colony state format `antempire.engine-v2`
 * (saves/world-state.json#/sim_engine_v2, sim/day14-projection.json).
 *
 * The v2 format stores the one simulated colony at the top level (population, colony, ...) and keeps
 * that colony's knowledge (presence, known_by) and trails inside world sources / ecology. The adapter
 * builds a multi-colony WorldState VIEW whose objects ARE the v2 objects (no copying), runs the normal
 * world day, then writes the few top-level scalars back. Because every nested object is shared and
 * mutated in the same order as the v6 engine, the returned v2 state is byte-identical to v6 output.
 *
 * Mapping (v2 -> v3 colony "MAIN"):
 *   population -> colony.population          colony (ledger) -> colony.stores
 *   ecology.trail_by_edge -> colony.trail_by_edge
 *   sources[id].{presence,known_by} -> colony.source_knowledge[id] (the source object itself)
 *   next_worker_number / next_egg_number -> colony.next_*
 *   colony identity (species, nest node N00, queen Q001, ID prefixes) -> world scenario_colonies[MAIN]
 */
import { clone } from './math.ts';
import { ENGINE_VERSION, runWorldDay, validateWorld, type WorldDayResult } from './day.ts';
import { resolveBundle, type ParamBundle, type ScenarioColony } from './params.ts';
import type { ClimateState, ColonyState, ColonyStores, ColonySummary, Population, SimEvent, Source, SourceKnowledge, WorldEcology, WorldState } from './types.ts';

export interface LegacyV2State {
  schema: 'antempire.engine-v2';
  sim_day: number;
  calendar_date: string;
  seed: number;
  next_worker_number: number;
  next_egg_number: number;
  next_larva_number?: number;
  next_pupa_number?: number;
  population: Population;
  colony: ColonyStores;
  climate: ClimateState;
  sources: Record<string, Source & SourceKnowledge>;
  ecology: WorldEcology & { trail_by_edge?: Record<string, number> };
  active_signals?: unknown[];
  migration_log?: unknown[];
  rules_fingerprint?: unknown;
  last_report?: ColonySummary;
  last_events?: SimEvent[];
}

const ACCEPTED_INPUT_KEYS = new Set(['schema', 'sim_day', 'calendar_date', 'seed', 'next_worker_number', 'next_egg_number', 'next_larva_number', 'next_pupa_number', 'population', 'colony', 'climate', 'sources', 'ecology', 'active_signals', 'migration_log', 'rules_fingerprint', 'last_report', 'last_events']);

/** The world scenario entry describing the legacy main colony (the only one with rng_namespace ''). */
export function legacyColonyMeta(scenarioColonies: ScenarioColony[]): ScenarioColony {
  const found = (scenarioColonies || []).filter((c) => c.rng_namespace === '');
  if (found.length !== 1) throw Error('world scenario_colonies must contain exactly one legacy main colony (rng_namespace "")');
  return found[0];
}

/** Build a v3 view that SHARES all nested objects with `s`. Does not mutate `s`. */
export function legacyView(s: LegacyV2State, meta: ScenarioColony, trails: Record<string, number>): WorldState {
  const colony: ColonyState = {
    id: meta.id, species_id: meta.species_id, nest_node: meta.nest_node, queen_id: meta.queen_id, rng_namespace: meta.rng_namespace,
    worker_id_prefix: meta.worker_id_prefix, egg_id_prefix: meta.egg_id_prefix, id_number_width: meta.id_number_width,
    next_worker_number: s.next_worker_number, next_egg_number: s.next_egg_number,
    population: s.population, stores: s.colony, trail_by_edge: trails, source_knowledge: s.sources,
  };
  return { schema: 'antempire.world-state.v3', sim_day: s.sim_day, calendar_date: s.calendar_date, seed: s.seed, climate: s.climate, sources: s.sources, ecology: s.ecology, colonies: [colony] };
}

/** v6-compatible return shape. */
export interface LegacyDayOutput { engine_version: string; params_schema: string; day: number; summary: ColonySummary; events: SimEvent[]; state: LegacyV2State }

/**
 * Drop-in replacement for sim/day_engine.cjs simulateDay(state, params), with params given as the
 * split bundle { world, species }. Output (summary, events, state) is byte-identical to v6.
 */
export function simulateDay(input: LegacyV2State, bundle: ParamBundle): LegacyDayOutput {
  if (arguments.length !== 2) throw Error('NO_GOD_MODE: no overrides, directives or interventions');
  if (input.schema !== 'antempire.engine-v2') throw Error('Expected migrated Day14-or-later engine state');
  for (const key of Object.keys(input)) if (!ACCEPTED_INPUT_KEYS.has(key)) throw Error('NO_GOD_MODE: unauthorized input ' + key);
  const rp = resolveBundle(bundle);
  const meta = legacyColonyMeta(rp.world.scenario_colonies);
  validateWorld(legacyView(input, meta, input.ecology?.trail_by_edge ?? {}));
  const s = clone(input);
  // v6 created ecology.trail_by_edge lazily at the start of foraging; nothing adds ecology keys before
  // that, so creating it here yields the same key order.
  s.ecology.trail_by_edge ??= {};
  const world = legacyView(s, meta, s.ecology.trail_by_edge);
  const result: WorldDayResult = runWorldDay(world, rp);
  const colony = world.colonies[0], out = result.colonies[0];
  s.climate = world.climate; s.sim_day = world.sim_day; s.calendar_date = world.calendar_date;
  s.next_worker_number = colony.next_worker_number; s.next_egg_number = colony.next_egg_number;
  const events = [...result.world_events, ...out.events];
  s.last_report = out.summary; s.last_events = events;
  return { engine_version: ENGINE_VERSION, params_schema: String(bundle.world.schema), day: s.sim_day, summary: out.summary, events, state: s };
}

/** Independent deep-copied v3 world from a v2 state (knowledge split out of the sources). */
export function legacyToWorldState(input: LegacyV2State, meta: ScenarioColony): WorldState {
  const s = clone(input);
  const knowledge: Record<string, SourceKnowledge> = {};
  const sources: Record<string, Source> = {};
  for (const [id, src] of Object.entries(s.sources)) {
    const { presence, known_by, ...rest } = src;
    knowledge[id] = { presence, known_by };
    sources[id] = rest as Source;
  }
  const { trail_by_edge, ...ecology } = s.ecology;
  const view = legacyView({ ...s, sources: sources as LegacyV2State['sources'], ecology }, meta, trail_by_edge ?? {});
  view.colonies[0].source_knowledge = knowledge;
  if (s.last_report) view.colonies[0].last_report = s.last_report;
  if (s.migration_log) view.migration_log = s.migration_log;
  if (s.rules_fingerprint) view.rules_fingerprint = s.rules_fingerprint;
  if (s.active_signals) view.active_signals = s.active_signals;
  return view;
}
