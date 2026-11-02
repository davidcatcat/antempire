/**
 * Day0 initializer (v2-review.15): builds a complete, legal, replayable WORLD at Day0 directly from world
 * initial conditions (scenarios/day0/garden.json) and a founding scenario (scenarios/day0/founding-*.json).
 *
 *  - It never calls the one-time Day14 -> Day15 migration and reads nothing from Day1–14 colony history
 *    (no old carcass batches, stores, ages, injuries or routes).
 *  - Garden ecology first runs ALONE for `warmup_days` (weather, host plants, hemipterans, insects, natural
 *    deaths creating carcasses); its events are returned. Nothing in the warm-up knows any colony.
 *  - Then the founding propagule is placed at its nest at Day0: no route memory, no known sources, no
 *    injuries, ages drawn from the scenario range with the world seed.
 *  - Founding modes whose biology the engine does not implement (independent founding, polygyny) are
 *    refused with the missing mechanisms, never run as a fake single-queen state.
 * Pure: no clock, no file system; every input is passed in.
 */
import { round } from './math.ts';
import { dice, hash32 } from './rng.ts';
import { resolveBundle, type ParamBundle } from './params.ts';
import { calcWeather, monthInterp, nextClimate } from './weather.ts';
import { growEcology } from './ecology.ts';
import { validateWorld, NATURAL_EVENT_TYPES } from './day.ts';
import type { ColonyState, Source, SourceKnowledge, SimEvent, Worker, WorldState, Brood, MonthlyClimate } from './types.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- scenario documents are tagged JSON
const val = (x: Any, path: string): number => {
  if (!x || x.assumption !== true || typeof x.value !== 'number' || !Number.isFinite(x.value) || !['文獻支持', '一般生理學', '遊戲假設'].includes(x.basis)) throw Error('Day0 scenario value must be a tagged assumption: ' + path);
  return x.value;
};

export class FoundingNotSupported extends Error {
  missing: string[];
  constructor(id: string, missing: string[]) { super(`FOUNDING_NOT_SUPPORTED: scenario ${id} needs mechanisms the engine does not implement: ${missing.join('; ')}`); this.missing = missing; }
}

export interface Day0Input {
  garden: Any; founding: Any; climatology: Any;
  /** World seed of this evaluation run (weather, garden host existence, founder ages). */
  seed: number;
  /** Calendar date of Day0 (YYYY-MM-DD). */
  start_date: string;
}
export interface Day0Output { state: WorldState; warmup: { days: number; from_date: string; events: SimEvent[] }; provenance: Record<string, unknown> }

const DAY_MS = 86400000;
const shiftDate = (date: string, days: number): string => new Date(Date.parse(date + 'T00:00:00Z') + days * DAY_MS).toISOString().slice(0, 10);

export function initializeDay0(input: Day0Input, bundle: ParamBundle): Day0Output {
  const { garden, founding, climatology, seed, start_date } = input;
  if (garden?.schema !== 'antempire.day0-garden.v1') throw Error('Day0: unknown garden schema');
  if (founding?.schema !== 'antempire.day0-founding.v1') throw Error('Day0: unknown founding schema');
  if (founding.engine_supported !== true) throw new FoundingNotSupported(founding.id, founding.missing_mechanisms ?? ['unspecified']);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start_date)) throw Error('Day0: start_date must be YYYY-MM-DD');
  if (!Number.isInteger(seed)) throw Error('Day0: seed must be an integer');
  const rp = resolveBundle(bundle), wp = rp.world, sp = rp.species[founding.species_id];
  if (!sp) throw Error('Day0: no species parameter file for ' + founding.species_id);
  const warmupDays = val(garden.warmup_days, 'warmup_days');
  if (!Number.isInteger(warmupDays) || warmupDays < 0) throw Error('Day0: warmup_days must be a non-negative integer');

  // ---- climate (from the station climatology; the run seed drives the synthetic weather) ----
  const monthly: MonthlyClimate[] = climatology.monthly_climatology.map((x: Any) => ({ month: x.month, mean_air_temperature_c: x.mean_air_temperature_c, mean_daily_maximum_air_temperature_c: x.mean_daily_maximum_air_temperature_c, mean_daily_minimum_air_temperature_c: x.mean_daily_minimum_air_temperature_c, mean_relative_humidity_percent: x.mean_relative_humidity_percent, mean_monthly_precipitation_mm: x.mean_monthly_precipitation_mm }));
  const from = shiftDate(start_date, -warmupDays), [fy, fm, fd] = from.split('-').map(Number);
  const ic = garden.initial_climate;
  const climate = { monthly, rain_days_per_year: climatology.independent_cwa_station_normals.rainy_days_per_year, prior_wet: ic.prior_wet === true, temp_anomaly_c: val(ic.temp_anomaly_c, 'initial_climate.temp_anomaly_c'), prior_air_temp_c: round(monthInterp(monthly, fy, fm, fd, 'mean_air_temperature_c')), soil_index: val(ic.soil_index, 'initial_climate.soil_index'), shade_index: val(ic.shade_index, 'initial_climate.shade_index') };

  // ---- garden sources (world ecology only; existence of uncertain hosts is drawn from the world seed) ----
  const sources: Record<string, Source> = {};
  for (const [id, h] of Object.entries(garden.honeydew_sites as Record<string, Any>)) {
    const p = val(h.exists_probability, `${id}.exists_probability`), alive = hash32(`${seed}|day0_garden_host|${id}`) / 4294967296 < p;
    sources[id] = { id, type: 'honeydew', sugar: 0, protein: 0, host_alive: alive, renewable: true, production_per_day: 0, capacity: wp.honeydew.honeydew_max, host_plants: alive ? val(h.host_plants, `${id}.host_plants`) : 0, hemipteran_kind: h.hemipteran_kind, hemipteran_colonies: alive ? val(h.hemipteran_colonies, `${id}.hemipteran_colonies`) : 0, batches: [], ...(Array.isArray(h.access_from) && h.access_from.length ? { access_from: h.access_from } : {}), ecology_origin: 'Day0 garden census game assumption (scenarios/day0/garden.json)' } as Source;
  }
  for (const [id, n] of Object.entries(garden.nectar_sites as Record<string, Any>)) {
    sources[id] = { id, type: 'nectar', sugar: val(n.initial_sugar, `${id}.initial_sugar`), protein: 0, host_alive: true, renewable: true, production_per_day: wp.nectar.nectar_daily_replenish, capacity: wp.nectar.nectar_max, bloom_days_left: val(n.bloom_days_at_start_of_warmup, `${id}.bloom_days_at_start_of_warmup`), batches: [] } as Source;
  }
  const insects: WorldState['ecology']['insects_by_site'] = {};
  for (const [id, c] of Object.entries(garden.carcass_sites as Record<string, Any>)) {
    if (val(c.initial_carcass_protein, `${id}.initial_carcass_protein`) !== 0) throw Error('Day0: carcasses must come from recorded deaths (initial_carcass_protein must be 0)');
    sources[id] = { id, type: 'carcass', sugar: 0, protein: 0, host_alive: true, renewable: false, production_per_day: 0, capacity: 0, batches: [] } as Source;
    insects[id] = { living: val(c.initial_living_insects, `${id}.initial_living_insects`), carrying_capacity: wp.insects.insect_local_carrying_capacity, cumulative_deaths: 0 };
  }
  for (const id of new Set(wp.routes.edges.flat())) if (/^F\d+$/.test(id) && !sources[id]) throw Error('Day0: garden.json has no entry for food node ' + id);

  // ---- ecology warm-up: the garden alone, no colony exists yet ----
  const world = { seed, sim_day: -warmupDays, calendar_date: from, climate, sources, ecology: { adjacent_garden_living_insects: val(garden.boundary_insects, 'boundary_insects'), adjacent_garden_carrying_capacity: wp.insects.insect_boundary_carrying_capacity, insects_by_site: insects } } as Any;
  const warmupEvents: SimEvent[] = [];
  for (let d = 0; d < warmupDays; d++) {
    const date = shiftDate(world.calendar_date, 1), weather = calcWeather(world, wp, date), events: SimEvent[] = [];
    growEcology(world, wp, weather, events);
    for (const e of events) {
      if (!NATURAL_EVENT_TYPES.has(e.type)) throw Error('NO_GOD_MODE: unregistered warm-up event ' + e.type);
      if (e.type === 'new_food_source' && !events.some((x) => x.type === 'insect_natural_death' && x.event_id === e.id && x.site === e.site)) throw Error('NO_GOD_MODE: warm-up food has no physical source death');
    }
    for (const e of events) warmupEvents.push({ ...e, warmup_day: world.sim_day + 1, date });
    world.climate = nextClimate(world.climate, weather); world.sim_day += 1; world.calendar_date = date;
  }
  if (world.sim_day !== 0 || world.calendar_date !== start_date) throw Error('Day0: warm-up did not end at Day0');

  // ---- founding propagule ----
  const nest = founding.nest_node as string;
  if (!wp.routes.edges.some(([a, b]) => a === nest || b === nest)) throw Error('Day0: nest node not on the route network: ' + nest);
  const queens = val(founding.queens, 'queens');
  if (queens !== 1) throw new FoundingNotSupported(founding.id, [`${queens} queens: the colony state holds exactly one queen`]);
  const nWorkers = val(founding.workers, 'workers'), ageMin = val(founding.worker_age_days_min, 'worker_age_days_min'), ageMax = val(founding.worker_age_days_max, 'worker_age_days_max');
  const fill = val(founding.worker_crop_fill_fraction, 'worker_crop_fill_fraction'), ls = sp.local_signals;
  const ident = founding.colony_identity, width = ident?.id_number_width;
  if (!ident || typeof ident.id !== 'string' || typeof ident.queen_id !== 'string' || typeof ident.rng_namespace !== 'string' || typeof ident.worker_id_prefix !== 'string' || typeof ident.egg_id_prefix !== 'string' || !Number.isInteger(width) || width < 1) throw Error('Day0: founding.colony_identity (id, queen_id, rng_namespace, worker/egg prefixes, id_number_width) is required');
  const ageDice = dice({ seed, sim_day: -1 }, 'day0_founder_ages:' + founding.id);
  const workers: Worker[] = [];
  for (let i = 1; i <= nWorkers; i++) {
    const crop = round(fill * sp.trophallaxis.crop_capacity);
    workers.push({
      id: ident.worker_id_prefix + String(i).padStart(width, '0'), alive: true, age_days: ageMin + Math.floor(ageDice() * (ageMax - ageMin + 1)),
      age_origin: 'founded_day0_propagule_game_assumption', injured: false, task: 'rest', known_sources: [], last_location: nest,
      local_sensory: { own_crop_sugar_fill: fill, peer_sugar_hunger: ls.default_peer_sugar_hunger, peer_protein_request: ls.default_peer_protein_request, direct_brood_begging: ls.default_direct_brood_begging, unload_feedback: { sugar: ls.unload_feedback_default, protein: ls.unload_feedback_default }, origin: 'own crop fill = the scenario crop load the worker carries (its own body); peer/brood/unloading cues = species defaults (no contacts at the new nest yet)' },
      route_memory: { origin: 'founded_day0', edges: {}, empty_sites: {} },
      ...(crop > 0 ? { crop_cargo_sugar: crop } : {}),
    } as Worker);
  }
  const brood: Brood[] = [];
  const progress = val(founding.carried_brood_progress, 'carried_brood_progress');
  let egg = 1;
  for (const [stage, key] of [['egg', 'eggs'], ['larva', 'larvae'], ['pupa', 'pupae']] as const) for (let i = 0; i < val(founding[key], key); i++) brood.push({ id: ident.egg_id_prefix + String(egg++).padStart(width, '0'), stage, laid_on_day: null, age_days: null, progress, ...(stage === 'larva' ? { begging_signal: ls.default_larva_begging_prior } : {}), origin: 'carried by the budding propagule; age unknown (game assumption)' });
  const knowledge: Record<string, SourceKnowledge> = Object.fromEntries(Object.keys(sources).sort().map((id) => [id, { presence: 'potential', known_by: [] }]));
  const colony: ColonyState = {
    id: ident.id, species_id: founding.species_id, nest_node: nest, queen_id: ident.queen_id, rng_namespace: ident.rng_namespace, worker_id_prefix: ident.worker_id_prefix, egg_id_prefix: ident.egg_id_prefix, id_number_width: width,
    next_worker_number: nWorkers + 1, next_egg_number: egg,
    population: { queen_alive: true, workers, brood },
    stores: { sugar: round(workers.reduce((a, w) => a + ((w.crop_cargo_sugar as number) || 0), 0)), protein: val(founding.stores_protein, 'stores_protein'), sugar_gap_days: 0, protein_gap_days: 0, stress_days: 0, queen_laid_yesterday: false, no_worker_days: 0 },
    trail_by_edge: {}, source_knowledge: knowledge,
  };
  const state: WorldState = {
    schema: 'antempire.world-state.v3', sim_day: 0, calendar_date: start_date, seed,
    climate: world.climate, sources: world.sources, ecology: world.ecology, colonies: [colony],
    migration_log: [{ type: 'day0_initialization', founding: founding.id, mode: founding.mode, garden: garden.world_id, warmup_days: warmupDays, warmup_from: from, warmup_event_count: warmupEvents.length, day14_history_used: false, note: 'Day0 world built by engine/initialization.ts; not a Day14 migration' }],
  };
  validateWorld(state);
  return { state, warmup: { days: warmupDays, from_date: from, events: warmupEvents }, provenance: { founding: founding.id, garden: garden.world_id, seed, start_date, warmup_days: warmupDays } };
}
