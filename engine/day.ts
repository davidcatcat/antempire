/**
 * One simulated day for a whole WORLD (all colonies). Fixed order (docs/gm-rules.md §3):
 *   1. weather (world)            2. independent ecology (world; never reads any colony)
 *   3. foraging of every colony   4. storage overflow, metabolism, brood, mortality, queen per colony
 *   5. conservation / causality / event-type checks — any failure throws and nothing is returned.
 * Colonies are processed in array order within each phase.
 */
import { clone, nextDate, round } from './math.ts';
import { calcWeather, nextClimate } from './weather.ts';
import { growEcology } from './ecology.ts';
import { forageDay } from './foraging.ts';
import { consume, storageOverflow } from './nutrition.ts';
import { developBrood } from './brood.ts';
import { oviposition, queenSurvival, workerSurvival } from './queen.ts';
import { resolveBundle, type ParamBundle, type ResolvedParams, type SpeciesParams } from './params.ts';
import type { ColonyState, ColonySummary, SimEvent, Weather, WorldState } from './types.ts';

/**
 * Behaviour version. Any change of simulation output must bump this (approved rules updates are listed in
 * tests/golden/approved-rule-changes.json):
 *   v2-review.7  nest-temperature memory fix (#6)
 *   v2-review.8  injured workers: neutral task weights, forage ×1.0 and rest ×1.0 (#13)
 */
export const ENGINE_VERSION = 'antempire.v2-review.8-injured-worker-neutral-tasks';
/** Implementation of that behaviour (bumped for refactors that keep results byte-identical). */
export const ENGINE_IMPLEMENTATION = 'antempire.engine-ts.1';
/** The v2 engine only applies to states at or after the completed Day14 checkpoint. */
const ENGINE_FIRST_STATE_DAY = 14;

export const NATURAL_EVENT_TYPES: ReadonlySet<string> = new Set(['new_food_source', 'source_batch_consumed', 'food_delivered', 'insect_immigration', 'insect_natural_death', 'insect_population_birth', 'insect_background_death', 'physical_scout_visit', 'discovery', 'scouted_empty', 'nest_local_route_learning', 'local_contact_cue', 'local_brood_begging_contact', 'local_unloading_feedback', 'host_plant_death', 'hemipteran_colony_change', 'local_recruitment', 'route_step', 'route_timeout', 'trail_decay', 'trail_deposited', 'local_trail_choice', 'food_collected', 'trophallaxis', 'protein_cached_at_nest', 'live_prey_encounter', 'prey_escaped', 'local_alarm_signal', 'insect_predation', 'hatch', 'pupation', 'eclosion', 'egg_laid', 'worker_death', 'brood_death', 'injury_recovery', 'queen_death']);

/** Structural validation of a world (legacy error messages preserved). */
export function validateWorld(s: WorldState): void {
  if (!Number.isInteger(s.sim_day) || s.sim_day < ENGINE_FIRST_STATE_DAY || !s.sources || !Array.isArray(s.colonies) || !s.colonies.length || s.colonies.some((c) => !c.population?.workers || !c.population?.brood || !c.stores)) throw Error('invalid engine v2 state');
  if (!s.ecology?.insects_by_site || !Number.isInteger(s.ecology.adjacent_garden_living_insects) || s.ecology.adjacent_garden_living_insects < 0) throw Error('NO_GOD_MODE: missing causal ecology/local cues or finite neighbor insect population');
  for (const [site, pop] of Object.entries(s.ecology.insects_by_site)) {
    if (!s.sources[site] || s.sources[site].type !== 'carcass' || !Number.isInteger(pop.living) || pop.living < 0 || !Number.isInteger(pop.cumulative_deaths) || pop.cumulative_deaths < 0) throw Error('invalid local insect ecological population');
  }
  const namespaces = new Set<string>();
  for (const c of s.colonies) {
    for (const k of ['sugar', 'protein'] as const) { if (!Number.isFinite(c.stores[k]) || c.stores[k] < 0) throw Error('invalid ' + k + ' store'); }
    if (namespaces.has(c.rng_namespace)) throw Error('colonies must have distinct rng_namespace values');
    namespaces.add(c.rng_namespace);
    for (const id of Object.keys(s.sources)) if (!c.source_knowledge[id]) throw Error(`colony ${c.id} has no knowledge record for source ${id}`);
  }
  const ids = s.colonies.flatMap((c) => [...c.population.workers.map((x) => x.id), ...c.population.brood.map((x) => x.id)]);
  if (new Set(ids).size !== ids.length) throw Error('duplicate IDs');
  for (const src of Object.values(s.sources)) {
    if (src.type === 'carcass' && Math.abs(src.protein - src.batches.reduce((a, b) => a + b.protein, 0)) > 1e-4) throw Error('nonconserved carcass source ' + src.id);
    if ((src.sugar || 0) < 0 || (src.protein || 0) < 0) throw Error('negative source');
  }
}

function newSummary(world: WorldState, colony: ColonyState, dayDate: string, weather: Weather): ColonySummary {
  return { day: world.sim_day + 1, date: dayDate, weather, workers_before: colony.population.workers.length, brood_before: colony.population.brood.length, queen_alive_before: colony.population.queen_alive, income: { sugar: 0, protein: 0 }, tasks: { forage: 0, nurse: 0, repair: 0, rest: 0, guard: 0 }, foraging_trips: 0, foraging_successes: 0, scouts: 0, recruited: 0, extra_sugar_cost: 0, foraging_workers_by_macro: { sugar: new Set(), protein: new Set() }, worker_deaths: 0, brood_deaths: 0, hatchings: 0, pupations: 0, eclosions: 0, eggs_laid: 0 } as ColonySummary; // remaining fields are added in day order (v6 key order)
}

function assertCausalFood(events: SimEvent[], message: string): void {
  for (const e of events.filter((x) => x.type === 'new_food_source')) {
    if (!events.some((x) => (x.type === 'insect_natural_death' || x.type === 'insect_predation') && x.event_id === e.id && x.site === e.site)) throw Error(message);
  }
}

export interface ColonyDayResult { colony_id: string; species_id: string; summary: ColonySummary; events: SimEvent[] }
export interface WorldDayResult { day: number; date: string; weather: Weather; world_events: SimEvent[]; colonies: ColonyDayResult[] }

/** Runs one day IN PLACE on `s` (callers clone first). */
export function runWorldDay(s: WorldState, rp: ResolvedParams): WorldDayResult {
  const wp = rp.world, worldEvents: SimEvent[] = [], dayDate = nextDate(s.calendar_date);
  const speciesOf = (c: ColonyState): SpeciesParams => {
    const sp = rp.species[c.species_id];
    if (!sp) throw Error(`No species parameter file loaded for ${c.species_id} (colony ${c.id})`);
    return sp;
  };
  const weather = calcWeather(s, wp, dayDate);
  const work = s.colonies.map((colony) => ({ colony, sp: speciesOf(colony), events: [] as SimEvent[], initial: { sugar: colony.stores.sugar, protein: colony.stores.protein }, summary: newSummary(s, colony, dayDate, weather), overflow: { sugar: 0, protein: 0 } }));

  growEcology(s, wp, weather, worldEvents);
  assertCausalFood(worldEvents, 'NO_GOD_MODE: food has no physical source death');

  for (const w of work) forageDay(s, w.colony, w.sp, wp, weather, w.events, w.summary);
  assertCausalFood([...worldEvents, ...work.flatMap((w) => w.events)], 'NO_GOD_MODE: food without tracked dead insect');
  for (const w of work) {
    const m = w.summary.foraging_workers_by_macro as { sugar: Set<string>; protein: Set<string> };
    w.summary.foraging_workers_by_macro = { sugar: m.sugar.size, protein: m.protein.size };
  }

  for (const w of work) {
    const { colony, sp, summary, events, initial } = w, n = sp.nutrition;
    // Other colonymates carrying liquid do not duplicate colony external income.
    w.overflow = storageOverflow(colony, sp);
    const ratios = consume(s, colony, sp, summary, weather);
    developBrood(s, colony, sp, weather, ratios, events, summary);
    workerSurvival(s, colony, sp, events, summary);
    queenSurvival(s, colony, sp, events);
    oviposition(s, colony, sp, ratios, weather, events, summary);
    const pop = colony.population;
    summary.population = { queen: pop.queen_alive ? 1 : 0, workers: pop.workers.length, eggs: pop.brood.filter((b) => b.stage === 'egg').length, larvae: pop.brood.filter((b) => b.stage === 'larva').length, pupae: pop.brood.filter((b) => b.stage === 'pupa').length };
    summary.stock = { sugar: round(colony.stores.sugar), protein: round(colony.stores.protein) };
    summary.starvation = { sugar_gap_days: colony.stores.sugar_gap_days, protein_gap_days: colony.stores.protein_gap_days, stress_days: colony.stores.stress_days };
    const ledger = { unit: 'game_portions_NOT_mg', start: initial, foraged: summary.income, metabolized: summary.consumed, egg_laying: { sugar: round(summary.eggs_laid * n.egg_laying_sugar_cost), protein: round(summary.eggs_laid * n.egg_laying_protein_cost) }, storage_overflow_not_retained: w.overflow, note: 'Nest mass conservation exact within 1e-5 game portions; source decomposition/replenishment separate' };
    summary.mass_ledger = ledger;
    for (const x of ['sugar', 'protein'] as const) {
      const rhs = round(initial[x] + summary.income[x] - ledger.metabolized[x] - ledger.egg_laying[x] - ledger.storage_overflow_not_retained[x]);
      const stock = summary.stock[x];
      if (Math.abs(rhs - stock) > 2e-5) throw Error('Nutrient balance not closed: ' + x + ' ' + rhs + ' vs ' + stock);
    }
  }
  for (const event of [...worldEvents, ...work.flatMap((w) => w.events)]) if (!NATURAL_EVENT_TYPES.has(event.type)) throw Error('NO_GOD_MODE: impossible or unregistered event type ' + event.type);

  s.climate = nextClimate(s.climate, weather);
  s.sim_day += 1; s.calendar_date = dayDate;
  validateWorld(s);
  for (const { summary, colony } of work) {
    const pop = summary.population;
    if (pop.workers + summary.worker_deaths !== summary.workers_before + summary.eclosions) throw Error('worker conservation violated');
    // Exact brood count balance across stages and deaths, egg lays, eclosions.
    if (colony.population.brood.length + summary.brood_deaths + summary.eclosions !== summary.brood_before + summary.eggs_laid) throw Error('brood conservation violated');
  }
  return { day: s.sim_day, date: dayDate, weather, world_events: worldEvents, colonies: work.map((w) => ({ colony_id: w.colony.id, species_id: w.colony.species_id, summary: w.summary, events: w.events })) };
}

const V3_KEYS = new Set(['schema', 'sim_day', 'calendar_date', 'seed', 'climate', 'sources', 'ecology', 'colonies', 'migration_log', 'rules_fingerprint', 'active_signals', 'last_world_events']);

/**
 * Pure multi-colony entry point: (world state, parameter bundle) -> next day. Never mutates its input.
 * No third argument, no override keys (NO_GOD_MODE).
 */
export function simulateWorldDay(input: WorldState, bundle: ParamBundle): { engine_version: string; day: number; result: WorldDayResult; state: WorldState } {
  if (arguments.length !== 2) throw Error('NO_GOD_MODE: no overrides, directives or interventions');
  if (input.schema !== 'antempire.world-state.v3') throw Error('Expected antempire.world-state.v3');
  for (const key of Object.keys(input)) if (!V3_KEYS.has(key)) throw Error('NO_GOD_MODE: unauthorized input ' + key);
  const rp = resolveBundle(bundle);
  validateWorld(input);
  const s = clone(input);
  const result = runWorldDay(s, rp);
  for (const c of result.colonies) {
    const colony = s.colonies.find((x) => x.id === c.colony_id) as ColonyState;
    colony.last_report = c.summary; colony.last_events = c.events;
  }
  s.last_world_events = result.world_events;
  return { engine_version: ENGINE_VERSION, day: s.sim_day, result, state: s };
}
