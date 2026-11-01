/**
 * ONE-TIME Day14 -> Day15 migration (port of sim/migrate_day15.cjs). Builds the first v2 engine state
 * from the authoritative Day14 saves. Does not advance Day14 and never writes anything; Day1–14
 * history is read only. All scenario numbers come from world/<id>.json#day15_migration.
 */
import { hash32 } from './rng.ts';
import { num, type ParamBundle } from './params.ts';
import { legacyColonyMeta, type LegacyV2State } from './legacy.ts';
import type { ScenarioColony } from './params.ts';
import type { Json } from './params.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- legacy save documents are free-form JSON

export function migrationState(main: Any, world: Any, climate: Any, bundle: ParamBundle): LegacyV2State {
  const w = bundle.world, P = (path: string) => num(w, path), mig = (path: string) => num(w, 'day15_migration.' + path);
  const m = (w.day15_migration ?? {}) as Record<string, Json>;
  const mainColony = legacyColonyMeta(w.scenario_colonies as unknown as ScenarioColony[]);
  if (main.simulation.latest_completed_day !== 14 || main.simulation.elapsed_sim_hours !== 336 || world.time.scientific_clock.day !== 14) throw Error('Migration requires authoritative completed Day14');
  const injuries = new Set(world.injuries.map((x: Any) => x.worker_id));
  const workerKnowledge = m.worker_known_sources as Record<string, string[]>;
  const workers = main.colony.workers.individuals.filter((x: Any) => x.status === 'alive').map((x: Any) => ({ id: x.id, alive: true, age_days: mig('legacy_unknown_age_initial_days'), age_origin: 'unknown adult age; explicit Day15 game assumption', injured: injuries.has(x.id), task: 'rest', known_sources: workerKnowledge[x.id] || [], last_location: x.v2_latest?.current_location_at_day_end || mainColony.nest_node, local_sensory: { own_crop_sugar_fill: mig('initial_local_sensory.own_crop_sugar_fill'), peer_sugar_hunger: mig('initial_local_sensory.peer_sugar_hunger'), peer_protein_request: mig('initial_local_sensory.peer_protein_request'), direct_brood_begging: mig('initial_local_sensory.direct_brood_begging'), unload_feedback: { sugar: mig('initial_local_sensory.unload_feedback_sugar'), protein: mig('initial_local_sensory.unload_feedback_protein') }, origin: 'individual neutral Day15 inference, unknown previous encounters' } }));
  const eggDays = num(bundle.species[mainColony.species_id], 'development.egg_days');
  const brood = main.colony.brood.individuals.filter((x: Any) => x.living).map((x: Any) => {
    if (x.stage === 'egg') {
      const age = 14 - x.laid_on_sim_day; if (age < 0) throw Error('Egg timestamp after Day14 ' + x.id);
      return { id: x.id, stage: 'egg', laid_on_day: x.laid_on_sim_day, age_days: age, progress: Math.min(mig('egg_progress_cap'), Math.round(age / eggDays * 1e6) / 1e6), origin: 'historical laid-on day; at-25C developmental progress is migration assumption' };
    }
    if (x.stage === 'larva') return { id: x.id, stage: 'larva', laid_on_day: null, age_days: null, progress: mig('legacy_larva_stage_progress'), begging_signal: mig('legacy_larva_begging_signal'), origin: 'unknown historical larval age -> assumed 50% of larval stage (not replaying Day1–14)' };
    throw Error('Unexpected Day14 brood stage ' + x.stage);
  });
  const sources: Record<string, Any> = {};
  const add = (id: string, type: string, sugar: number, protein: number, production: number, capacity: number, other: Any = {}) => { sources[id] = { id, type, sugar, protein, presence: 'confirmed_game_scenario', host_alive: true, renewable: type !== 'carcass', production_per_day: production, capacity, known_by: workers.filter((x: Any) => x.known_sources.includes(id)).map((x: Any) => x.id), recruits: [], ...other }; };
  const f01 = m.F01_census as Record<string, Any>;
  add('F01', 'honeydew', P('honeydew.honeydew_initial'), 0, 0, P('honeydew.honeydew_max'), { host_plants: mig('F01_census.host_plants'), hemipteran_kind: f01.hemipteran_kind, hemipteran_colonies: mig('F01_census.hemipteran_colonies'), ecology_origin: 'two garden plants with four aphid colonies; one-time independent garden census assumption' });
  add('F08', 'nectar', P('nectar.nectar_initial'), 0, P('nectar.nectar_daily_replenish'), P('nectar.nectar_max'), { bloom_days_left: P('nectar.nectar_bloom_days_remaining') });
  const sourceHistory = [{ id: 'V2D11-E04', site: 'F07', day: 11, protein: mig('carcass_initial_F07') }, { id: 'V2D10-E04', site: 'F07', day: 10, protein: mig('carcass_initial_F07_older') }, { id: 'V2D9-E04', site: 'F11', day: 9, protein: mig('carcass_initial_F11') }];
  if (!world.foraging_economy.day11_record.source_events.some((x: Any) => x.event_id === 'V2D11-E04' && x.source_node === 'F07') || !world.foraging_economy.day10_record.source_events.some((x: Any) => x.event_id === 'V2D10-E04' && x.source_node === 'F07') || !world.foraging_economy.day9_record.source_events.some((x: Any) => x.event_id === 'V2D9-E04' && x.source_node === 'F11')) throw Error('Missing historical carcass provenance');
  for (const site of ['F07', 'F11']) {
    const batches = sourceHistory.filter((x) => x.site === site).map((x) => ({ event_id: x.id, original_day: x.day, protein: x.protein, age_days: 14 - x.day, origin: 'Day14 qualified historical origin; remaining game portion amount is Day15 assumption' }));
    add(site, 'carcass', 0, Math.round(batches.reduce((t, x) => t + x.protein, 0) * 1e6) / 1e6, 0, 0, { batches });
  }
  // Potential ecology nodes existed in Day14 source descriptions, but were never confirmed to the colony.
  // Food viability is a STABLE scenario assumption, not a new world observation or auto-discovery by ants.
  const hidden = m.hidden_honeydew_sites as Record<string, Any>;
  for (const id of Object.keys(hidden)) {
    if (!world.foraging_economy.source_nodes[id]) throw Error('Potential source not in Day14 world: ' + id);
    const h = (k: string) => mig(`hidden_honeydew_sites.${id}.${k}`), quantity = h('initial_sugar'), max = h('capacity'), prob = h('exists_probability');
    const roll = hash32(`${P('model.scenario_seed')}|day15_migration_source|${id}`) / 4294967296; const alive = roll < prob; // deterministic hidden site viability scenario, NOT observed
    add(id, 'honeydew', alive ? quantity : 0, 0, 0, max, { presence: 'potential', host_alive: alive, host_plants: alive ? h('host_plants') : 0, hemipteran_kind: hidden[id].hemipteran_kind, hemipteran_colonies: alive ? h('hemipteran_colonies') : 0, ecology_origin: 'fixed 1-time host-plant and hemipteran starting census; no feedback from colony consumption', scenario_exists_probability: prob, known_by: [], access_from: hidden[id].access_from, origin: 'potential-only Day14 background route, host viability assumed not measured' });
  }
  const startSugar = mig('starting_sugar'), startProtein = mig('starting_protein');
  const s = {
    schema: 'antempire.engine-v2', sim_day: 14, calendar_date: '2026-11-13', seed: P('model.scenario_seed'),
    next_worker_number: Math.max(...main.colony.workers.individuals.map((x: Any) => Number(x.id.slice(1)))) + 1,
    next_egg_number: Math.max(...main.colony.brood.individuals.filter((x: Any) => x.id.startsWith('E')).map((x: Any) => Number(x.id.slice(1)))) + 1,
    population: { queen_alive: main.colony.queen.count > 0, workers, brood },
    colony: { sugar: startSugar, protein: startProtein, sugar_gap_days: 0, protein_gap_days: 0, stress_days: 0, queen_laid_yesterday: false },
    ecology: { adjacent_garden_living_insects: mig('insect_initial_boundary_reservoir'), adjacent_garden_carrying_capacity: P('insects.insect_boundary_carrying_capacity'), insects_by_site: { F07: { living: mig('insect_initial_living_F07'), carrying_capacity: P('insects.insect_local_carrying_capacity'), cumulative_deaths: 0, origin: 'baseline background insect count; ecological scenario assumption' }, F11: { living: mig('insect_initial_living_F11'), carrying_capacity: P('insects.insect_local_carrying_capacity'), cumulative_deaths: 0, origin: 'baseline background insect count; ecological scenario assumption' } } },
    climate: { monthly: climate.monthly_climatology.map((x: Any) => ({ month: x.month, mean_air_temperature_c: x.mean_air_temperature_c, mean_daily_maximum_air_temperature_c: x.mean_daily_maximum_air_temperature_c, mean_daily_minimum_air_temperature_c: x.mean_daily_minimum_air_temperature_c, mean_relative_humidity_percent: x.mean_relative_humidity_percent, mean_monthly_precipitation_mm: x.mean_monthly_precipitation_mm })), rain_days_per_year: climate.independent_cwa_station_normals.rainy_days_per_year, prior_wet: world.climate_engine.last_synthetic_condition.wet_or_dry === 'wet', temp_anomaly_c: world.climate_engine.last_synthetic_condition.synthetic_temp_anomaly_c, prior_air_temp_c: world.weather.latest_daily_weather.synthetic_weather.daily_mean_air_temperature_c, soil_index: world.climate_engine.last_synthetic_condition.model_surface_wetness_index, shade_index: world.climate_engine.last_synthetic_condition.model_shaded_soil_memory_index },
    sources, active_signals: [],
    migration_log: [{ type: 'v2_engine_day15_effective_only', prior_sim_day: 14, prior_elapsed_sim_hours: 336, day14_read_only: true, egg_rule: 'day14-laid_on_sim_day; egg-equivalent progress assumes past days at 25C', larva_rule: 'L001/L002 unknown historical age -> 0.5 larval stage progress', worker_rule: 'unknown legacy adult worker age ->7d; not a scientific inference', food_rule: `game portion starting sugar=${startSugar} protein=${startProtein}, not conversion of Day9-10 event counts`, original_carcass_events: sourceHistory.map((x) => x.id), source_lifetime_game_assumptions: true, ecological_background_insects: 'F07/F11 living insects initialized by explicit scenario assumptions; any future carcass requires a tracked insect death', global_food_or_death_overrides_prohibited: true }, { type: 'post_v2_failed_trial_hidden_honeydew_census_disclosure', effective_day: 15, day14_unmodified: true, added_after_failed_v2_trial: true, sites: ['F04', 'F05'], provenance: 'F04/F05 hidden honeydew host plants and hemipteran colonies were added as a retroactive garden census only after the original v2 test failed; not confirmed Day1–14 observations', restrictions: 'From Day15 onward fixed habitat definition and parameterization must never be altered in response to ant starvation, colony persistence, or review outcome; only autonomous ecological events may alter populations', world_definition_frozen_from_day15: true, assumption: true }],
  };
  return s as unknown as LegacyV2State;
}

export interface MigrationRefs { engine_ref: string; rules_ref: string; params_ref: string }

/** Main-save metadata after the migration. `now` is injected (the engine never reads a clock). */
export function metadataPreview(main: Any, refs: MigrationRefs, now: string): Any {
  const x = structuredClone(main);
  x.continuity = 'v1歷史1150分鐘唯讀；v2科學啟發的熱帶大頭家蟻 Pheidole megacephala；Day15起啟用假設參數化數值生態引擎，所有遊戲份數及生理危險率非實測';
  x.updated_at = now; x.simulation.next_engine_ref = refs.engine_ref; x.simulation.next_rules_ref = refs.rules_ref; x.simulation.v2_engine_effective_day = 15; x.simulation.v2_params_ref = refs.params_ref;
  x.migration_log.push({ type: 'v2_engine_rules_only_no_clock_advance', effective_from_day: 15, completed_day_unchanged: 14, assumptions_in: refs.params_ref, egg_ages: 'historical dates', unknown_larva_ages: 'assumed half larval stage', initial_stock: 'assumed not physically measured' });
  return x;
}
