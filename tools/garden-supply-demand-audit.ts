/**
 * #202 item 8 — garden supply vs colony consumption: units, time scales and conservation audit (RESEARCH ONLY).
 *
 *   node tools/garden-supply-demand-audit.ts            -> print the report (markdown) to stdout
 *   node tools/garden-supply-demand-audit.ts --write    -> also write reports/garden-supply-demand-audit/{audit.md,audit.json}
 *
 * It READS the current parameter files (world/xitun-garden.json, species/pheidole-megacephala.json,
 * scenarios/day0/garden.json, scenarios/day0-budding-candidate.json, prototypes/p0a2-24h/params.json) and the literature
 * anchors (data/garden-supply-demand-anchors.json). It never runs or changes the engine, never reads or writes saves/ or
 * journal/, and changes no parameter. Every quantity it prints is either a game portion (份, unit-less: flagged) or a
 * literature-anchored magnitude whose conversion is printed explicitly.
 *
 * RULE (CLAUDE.md §7; Owner #202 item 8): nothing here is a target. The "worker count whose maintenance equals the model's
 * production ceiling" is a DIAGNOSTIC of the model's units, never a number to tune the garden to; the conversion scan is a
 * candidate range, not an established unit; no garden resource may be back-solved from these numbers to make a colony live.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readJson, readText, REPO_ROOT } from '../cli/lib/load.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- raw parameter files
export const OUT_DIR = 'reports/garden-supply-demand-audit';
export const ANCHORS_FILE = 'data/garden-supply-demand-anchors.json';
export const FILES = { world: 'world/xitun-garden.json', species: 'species/pheidole-megacephala.json', garden: 'scenarios/day0/garden.json', candidate: 'scenarios/day0-budding-candidate.json', p0a2: 'prototypes/p0a2-24h/params.json' } as const;
type FileKey = keyof typeof FILES;

/** what one parameter is in the food economy */
export type Role = 'supply' | 'supply_driver' | 'demand' | 'stock_cap' | 'loss' | 'handling_limit' | 'perception' | 'initial_stock';
/** GP = game portion (份): unit-less, NO mass. Every GP quantity is flagged. */
export interface UnitEntry {
  file: FileKey; path: string; role: Role; food: 'sugar' | 'protein' | 'sugar+protein' | 'none';
  unit: string; time_scale: string; physical_unit: null | string;
  origin: 'fixed_game_portion' | 'ecological_process' | 'ecological_driver' | 'colony_internal' | 'scenario_initial';
  note: string;
}
const gp = (u: string) => `game_portion ${u}`;
/** The registry: every supply / demand / capacity / handling quantity of both engines, with its unit and time scale. */
export const REGISTRY: UnitEntry[] = [
  // ---------- legacy daily engine: SUPPLY (world) ----------
  { file: 'world', path: 'hemipterans.honeydew_per_colony_per_day.aphid', role: 'supply', food: 'sugar', unit: gp('sugar / hemipteran "colony" / day'), time_scale: 'day', physical_unit: null, origin: 'ecological_process', note: '"colony" has no individual count, so the rate cannot be checked against per-insect honeydew data' },
  { file: 'world', path: 'hemipterans.honeydew_per_colony_per_day.scale', role: 'supply', food: 'sugar', unit: gp('sugar / hemipteran "colony" / day'), time_scale: 'day', physical_unit: null, origin: 'ecological_process', note: 'same as aphid' },
  { file: 'world', path: 'hemipterans.honeydew_productivity_multiplier', role: 'supply_driver', food: 'sugar', unit: 'dimensionless multiplier', time_scale: '-', physical_unit: null, origin: 'ecological_driver', note: 'sensitivity handle only' },
  { file: 'world', path: 'hemipterans.hemipteran_colony_daily_growth_probability', role: 'supply_driver', food: 'none', unit: '1/day (probability of +1 colony)', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'temperature- and season-independent (defect D5)' },
  { file: 'world', path: 'hemipterans.hemipteran_colony_daily_collapse_probability', role: 'supply_driver', food: 'none', unit: '1/day (probability of -1 colony)', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'temperature- and season-independent (defect D5)' },
  { file: 'world', path: 'hemipterans.max_hemipteran_colonies_per_host', role: 'supply_driver', food: 'none', unit: 'colonies / host plant', time_scale: 'state', physical_unit: null, origin: 'ecological_driver', note: 'host plant size not modelled' },
  { file: 'world', path: 'hemipterans.rain_honeydew_secretion_suppression_per_mm', role: 'supply_driver', food: 'sugar', unit: 'fraction / mm rain', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'mechanism direction R183' },
  { file: 'world', path: 'hemipterans.honeydew_rain_secretion_min_multiplier', role: 'supply_driver', food: 'sugar', unit: 'dimensionless floor', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'plants.host_plant_daily_death_probability', role: 'supply_driver', food: 'none', unit: '1/day per host plant', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'mean host lifetime = 1/p days' },
  { file: 'world', path: 'plants.new_plant_event_probability', role: 'supply_driver', food: 'none', unit: '1/day', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'declared but not implemented (not read by engine/params.ts)' },
  { file: 'world', path: 'honeydew.honeydew_max', role: 'stock_cap', food: 'sugar', unit: gp('sugar (standing crop cap per site)'), time_scale: 'state', physical_unit: null, origin: 'fixed_game_portion', note: 'same cap for every honeydew site regardless of colonies' },
  { file: 'world', path: 'honeydew.honeydew_daily_replenish', role: 'supply', food: 'sugar', unit: gp('sugar / day'), time_scale: 'day', physical_unit: null, origin: 'fixed_game_portion', note: 'DEAD: not read by engine/*.ts (production comes from colonies × rate); referenced only by the legacy v1 sim/ and a legacy-path override in tests/lib/scenarios.ts' },
  { file: 'world', path: 'honeydew.honeydew_initial', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'honeydew.honeydew_washoff_per_rain_mm', role: 'loss', food: 'sugar', unit: 'fraction / mm rain', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'honeydew.honeydew_washoff_max_fraction', role: 'loss', food: 'sugar', unit: 'fraction / day', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'nectar.nectar_max', role: 'stock_cap', food: 'sugar', unit: gp('sugar (standing crop cap)'), time_scale: 'state', physical_unit: null, origin: 'fixed_game_portion', note: '' },
  { file: 'world', path: 'nectar.nectar_daily_replenish', role: 'supply', food: 'sugar', unit: gp('sugar / site / day while blooming'), time_scale: 'day', physical_unit: null, origin: 'fixed_game_portion', note: 'not per flower; no flower count, no temperature response (R186 direction unused), single bloom countdown (D4)' },
  { file: 'world', path: 'nectar.nectar_initial', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'nectar.nectar_bloom_days_remaining', role: 'supply_driver', food: 'sugar', unit: 'days', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'one countdown, never re-blooms (D4)' },
  { file: 'world', path: 'nectar.nectar_washoff_per_rain_mm', role: 'loss', food: 'sugar', unit: 'fraction / mm rain', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'nectar.nectar_washoff_max_fraction', role: 'loss', food: 'sugar', unit: 'fraction / day', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'carcasses.carcass_new_protein_min', role: 'supply', food: 'protein', unit: gp('protein / natural insect death'), time_scale: 'event', physical_unit: null, origin: 'ecological_process', note: 'insects have no body mass in the model; yield independent of insect size' },
  { file: 'world', path: 'carcasses.carcass_new_protein_max', role: 'supply', food: 'protein', unit: gp('protein / natural insect death'), time_scale: 'event', physical_unit: null, origin: 'ecological_process', note: 'see min' },
  { file: 'world', path: 'carcasses.carcass_daily_decay_fraction', role: 'loss', food: 'protein', unit: 'fraction / day', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'temperature-independent' },
  { file: 'world', path: 'carcasses.carcass_rain_decay_bonus', role: 'loss', food: 'protein', unit: 'fraction / mm rain', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'carcasses.carcass_max_lifetime_days', role: 'loss', food: 'protein', unit: 'days', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'carcasses.carcass_decay_max_daily_fraction', role: 'loss', food: 'protein', unit: 'fraction / day', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_local_carrying_capacity', role: 'supply_driver', food: 'protein', unit: 'insects / site', time_scale: 'state', physical_unit: null, origin: 'ecological_driver', note: 'no area, no biomass' },
  { file: 'world', path: 'insects.insect_background_immigration_probability', role: 'supply_driver', food: 'protein', unit: '1/day (one insect)', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_local_daily_mortality_probability', role: 'supply_driver', food: 'protein', unit: '1/day (at most one death per site per day)', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'caps natural carcass generation at 1 per site per day' },
  { file: 'world', path: 'insects.insect_site_logistic_daily_birth_rate', role: 'supply_driver', food: 'protein', unit: '1/day per capita', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_boundary_logistic_daily_birth_rate', role: 'supply_driver', food: 'protein', unit: '1/day per capita', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_boundary_carrying_capacity', role: 'supply_driver', food: 'protein', unit: 'insects', time_scale: 'state', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_boundary_per_capita_daily_death_probability', role: 'supply_driver', food: 'protein', unit: '1/day per capita', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'boundary deaths leave no food' },
  { file: 'world', path: 'insects.insect_reproduction_reference_c', role: 'supply_driver', food: 'protein', unit: '°C', time_scale: '-', physical_unit: '°C', origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_reproduction_per_degree_c', role: 'supply_driver', food: 'protein', unit: '1/°C', time_scale: '-', physical_unit: '1/°C', origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_reproduction_min_multiplier', role: 'supply_driver', food: 'protein', unit: 'dimensionless', time_scale: '-', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_reproduction_max_multiplier', role: 'supply_driver', food: 'protein', unit: 'dimensionless', time_scale: '-', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'insects.insect_local_death_reference_population', role: 'supply_driver', food: 'protein', unit: 'insects', time_scale: '-', physical_unit: null, origin: 'ecological_driver', note: '' },
  { file: 'world', path: 'prey.small_prey_protein', role: 'supply', food: 'protein', unit: gp('protein / killed small insect'), time_scale: 'event', physical_unit: null, origin: 'fixed_game_portion', note: 'same tracked insect yields carcass_new_protein_* when it dies naturally (inconsistent per-insect yield)' },
  { file: 'world', path: 'prey.large_prey_protein', role: 'supply', food: 'protein', unit: gp('protein / killed large insect'), time_scale: 'event', physical_unit: null, origin: 'fixed_game_portion', note: 'see small_prey_protein' },
  { file: 'world', path: 'prey.large_prey_fraction', role: 'supply_driver', food: 'protein', unit: 'fraction of encounters', time_scale: 'event', physical_unit: null, origin: 'fixed_game_portion', note: 'insects have no size attribute' },
  { file: 'world', path: 'background_colonies.F04_rival.honeydew_harvest_fraction', role: 'loss', food: 'sugar', unit: 'fraction of F04 gross production', time_scale: 'day', physical_unit: null, origin: 'ecological_driver', note: 'fixed share, not a simulated colony' },
  // ---------- legacy daily engine: DEMAND (species) ----------
  { file: 'species', path: 'nutrition.worker_sugar_daily', role: 'demand', food: 'sugar', unit: gp('sugar / worker / day at metabolism.reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: 'scaled by Q10 of nest model temperature' },
  { file: 'species', path: 'nutrition.worker_protein_daily', role: 'demand', food: 'protein', unit: gp('protein / worker / day at reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.queen_sugar_daily', role: 'demand', food: 'sugar', unit: gp('sugar / queen / day at reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.queen_protein_daily', role: 'demand', food: 'protein', unit: gp('protein / queen / day at reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.larva_sugar_daily', role: 'demand', food: 'sugar', unit: gp('sugar / larva / day at reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: 'not instar-dependent' },
  { file: 'species', path: 'nutrition.larva_protein_daily', role: 'demand', food: 'protein', unit: gp('protein / larva / day at reference_c'), time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: 'not instar-dependent; no growth-efficiency link to adult mass' },
  { file: 'species', path: 'nutrition.egg_laying_protein_cost', role: 'demand', food: 'protein', unit: gp('protein / egg'), time_scale: 'event', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.egg_laying_sugar_cost', role: 'demand', food: 'sugar', unit: gp('sugar / egg'), time_scale: 'event', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.brood_protein_min_fraction', role: 'demand', food: 'protein', unit: 'fraction of larva_protein_daily', time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: 'not read by engine/*.ts (no reference by name); the legacy brood rule does not use it' },
  { file: 'species', path: 'nutrition.max_sugar_store', role: 'stock_cap', food: 'sugar', unit: gp('sugar (nest store cap at baseline)'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: 'overflow is destroyed (storage_overflow loss)' },
  { file: 'species', path: 'nutrition.max_protein_store', role: 'stock_cap', food: 'protein', unit: gp('protein (nest store cap at baseline)'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.store_capacity_baseline_workers', role: 'stock_cap', food: 'sugar+protein', unit: 'workers', time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.sugar_store_per_extra_worker', role: 'stock_cap', food: 'sugar', unit: gp('sugar / extra worker'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'nutrition.protein_store_per_extra_worker', role: 'stock_cap', food: 'protein', unit: gp('protein / extra worker'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'metabolism.q10', role: 'demand', food: 'sugar+protein', unit: 'dimensionless (per 10 °C)', time_scale: '-', physical_unit: null, origin: 'colony_internal', note: 'general physiology, applied to protein too' },
  { file: 'species', path: 'metabolism.reference_c', role: 'demand', food: 'sugar+protein', unit: '°C', time_scale: '-', physical_unit: '°C', origin: 'colony_internal', note: '' },
  { file: 'species', path: 'foraging_trips.foraging_trip_sugar_cost', role: 'demand', food: 'sugar', unit: gp('sugar / trip'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: 'independent of distance' },
  { file: 'species', path: 'foraging_trips.max_trips_per_forager', role: 'handling_limit', food: 'sugar+protein', unit: 'trips / forager / day', time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: 'time-scale cap on income (D2)' },
  { file: 'species', path: 'activity.active_minute_sugar_cost', role: 'demand', food: 'sugar', unit: gp('sugar / minute outside'), time_scale: 'minute', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'food_handling.crop_load_sugar_min', role: 'handling_limit', food: 'sugar', unit: gp('sugar / trip'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'food_handling.crop_load_sugar_max', role: 'handling_limit', food: 'sugar', unit: gp('sugar / trip'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'food_handling.crop_load_protein_min', role: 'handling_limit', food: 'protein', unit: gp('protein / trip'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'food_handling.crop_load_protein_max', role: 'handling_limit', food: 'protein', unit: gp('protein / trip'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: 'R107: a minor carries whole prey ≥9× its mass; per-trip piece cap is a game assumption' },
  { file: 'species', path: 'food_handling.liquid_collection_probability', role: 'handling_limit', food: 'sugar', unit: 'probability / arrival', time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'food_handling.carcass_access_probability', role: 'handling_limit', food: 'protein', unit: 'probability / arrival', time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'trophallaxis.crop_capacity', role: 'handling_limit', food: 'sugar+protein', unit: gp('per worker crop'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: 'R132: minor load 0.08 mg honey (a load, not the maximum)' },
  { file: 'species', path: 'trophallaxis.transfer_max_portions', role: 'handling_limit', food: 'sugar', unit: gp('sugar / trophallaxis'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'queen_feeding.take_from_cache_max_portions', role: 'handling_limit', food: 'protein', unit: gp('protein / nest round'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'queen_feeding.feed_max_portions_per_contact', role: 'handling_limit', food: 'sugar+protein', unit: gp('per contact'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'queen_feeding.self_feed_max_portions', role: 'handling_limit', food: 'protein', unit: gp('protein / round'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'queen_feeding.queen_satiation_days_of_need', role: 'handling_limit', food: 'sugar+protein', unit: 'days of own need', time_scale: 'day', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'queen_feeding.day0_initial_reserve_days_of_need', role: 'initial_stock', food: 'sugar+protein', unit: 'days of own need', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'species', path: 'larval_feeding.feed_bolus_sugar_portions', role: 'handling_limit', food: 'sugar', unit: gp('sugar / contact'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'larval_feeding.feed_bolus_protein_portions', role: 'handling_limit', food: 'protein', unit: gp('protein / contact'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'scouting.unproductive_route_threshold_portions', role: 'perception', food: 'sugar+protein', unit: gp('remembered harvest'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'site_choice.default_prior_success_portions', role: 'perception', food: 'sugar+protein', unit: gp('remembered harvest'), time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'species', path: 'site_choice.score_base_offset', role: 'perception', food: 'sugar+protein', unit: 'game_portion sugar+protein (added to remembered harvest in site scores)', time_scale: 'trip', physical_unit: null, origin: 'colony_internal', note: 'found by CE1 (RU-1, reports/ce1-conversion-invariance): score = (score_base_offset + prior) × …, so it is a portion quantity; left unscaled, the CE1 test diverges' },
  // ---------- legacy Day15 migration (one time, legacy Day14 history retired by #194; Day0 does not use it) ----------
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F04.initial_sugar', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F04.listed_production', role: 'supply', food: 'sugar', unit: gp('sugar / day (listed by the retired v1 code, not used)'), time_scale: 'day', physical_unit: null, origin: 'fixed_game_portion', note: 'Day15 migration only; the migration writes production_per_day = 0 (production comes from the ecology module)' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F04.capacity', role: 'stock_cap', food: 'sugar', unit: gp('sugar (standing crop cap per site)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F05.initial_sugar', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F05.listed_production', role: 'supply', food: 'sugar', unit: gp('sugar / day (listed by the retired v1 code, not used)'), time_scale: 'day', physical_unit: null, origin: 'fixed_game_portion', note: 'Day15 migration only; the migration writes production_per_day = 0 (production comes from the ecology module)' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F05.capacity', role: 'stock_cap', food: 'sugar', unit: gp('sugar (standing crop cap per site)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F10.initial_sugar', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F10.listed_production', role: 'supply', food: 'sugar', unit: gp('sugar / day (listed by the retired v1 code, not used)'), time_scale: 'day', physical_unit: null, origin: 'fixed_game_portion', note: 'Day15 migration only; the migration writes production_per_day = 0 (production comes from the ecology module)' },
  { file: 'world', path: 'day15_migration.hidden_honeydew_sites.F10.capacity', role: 'stock_cap', food: 'sugar', unit: gp('sugar (standing crop cap per site)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.starting_sugar', role: 'initial_stock', food: 'sugar', unit: gp('sugar (nest store, one time)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.starting_protein', role: 'initial_stock', food: 'protein', unit: gp('protein (nest store, one time)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.carcass_initial_F07', role: 'initial_stock', food: 'protein', unit: gp('protein (carcass remains, one time)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.carcass_initial_F11', role: 'initial_stock', food: 'protein', unit: gp('protein (carcass remains, one time)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  { file: 'world', path: 'day15_migration.carcass_initial_F07_older', role: 'initial_stock', food: 'protein', unit: gp('protein (carcass remains, one time)'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'Day15 migration only' },
  // ---------- Day0 garden census (scenario) ----------
  { file: 'garden', path: 'honeydew_sites.*.host_plants', role: 'supply_driver', food: 'sugar', unit: 'host plants / site', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'no plant size / species' },
  { file: 'garden', path: 'honeydew_sites.*.hemipteran_colonies', role: 'supply_driver', food: 'sugar', unit: 'hemipteran "colonies" / site', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: 'no individuals per colony' },
  { file: 'garden', path: 'honeydew_sites.*.exists_probability', role: 'supply_driver', food: 'sugar', unit: 'probability / world seed', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'garden', path: 'nectar_sites.*.bloom_days_at_start_of_warmup', role: 'supply_driver', food: 'sugar', unit: 'days', time_scale: 'day', physical_unit: null, origin: 'scenario_initial', note: 'shorter than warmup_days: bloom ends before Day0' },
  { file: 'garden', path: 'nectar_sites.*.initial_sugar', role: 'initial_stock', food: 'sugar', unit: gp('sugar'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'garden', path: 'carcass_sites.*.initial_living_insects', role: 'supply_driver', food: 'protein', unit: 'insects / site', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'garden', path: 'carcass_sites.*.initial_carcass_protein', role: 'initial_stock', food: 'protein', unit: gp('protein'), time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'garden', path: 'boundary_insects', role: 'supply_driver', food: 'protein', unit: 'insects', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'garden', path: 'warmup_days', role: 'supply_driver', food: 'sugar+protein', unit: 'days', time_scale: 'day', physical_unit: null, origin: 'scenario_initial', note: '' },
  // ---------- P0-A2 24 h prototype ----------
  { file: 'p0a2', path: 'parameters.honeydew_amount_portions', role: 'supply', food: 'sugar', unit: gp('sugar / production event'), time_scale: 'event (every honeydew_interval_s)', physical_unit: null, origin: 'fixed_game_portion', note: 'no hemipteran, plant, temperature or rain driver: a fixed scenario drip (synthetic)' },
  { file: 'p0a2', path: 'parameters.honeydew_interval_s', role: 'supply_driver', food: 'sugar', unit: 's', time_scale: 'event', physical_unit: 's', origin: 'fixed_game_portion', note: '' },
  { file: 'p0a2', path: 'parameters.worker_sugar_daily_portions', role: 'demand', food: 'sugar', unit: gp('sugar / worker / day, constant rate'), time_scale: 'continuous', physical_unit: null, origin: 'colony_internal', note: 'no Q10 (nest temperature not simulated)' },
  { file: 'p0a2', path: 'brood_feeding_variants.*.overrides.worker_sugar_daily_portions', role: 'demand', food: 'sugar', unit: gp('sugar / worker / day, constant rate (sensitivity variant m-half / m-double, #208; default off)'), time_scale: 'continuous', physical_unit: null, origin: 'colony_internal', note: 'isolated sensitivity override of the reference value; not the reference' },
  { file: 'p0a2', path: 'parameters.larva_sugar_daily_portions', role: 'demand', food: 'sugar', unit: gp('sugar / larva / day'), time_scale: 'continuous', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'p0a2', path: 'parameters.crop_capacity_portions', role: 'handling_limit', food: 'sugar', unit: gp('per worker crop'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'p0a2', path: 'parameters.larva_gut_capacity_portions', role: 'handling_limit', food: 'sugar', unit: gp('per larva gut'), time_scale: 'state', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'p0a2', path: 'parameters.feed_bolus_portions', role: 'handling_limit', food: 'sugar', unit: gp('sugar / contact'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'p0a2', path: 'parameters.transfer_max_portions', role: 'handling_limit', food: 'sugar', unit: gp('sugar / trophallaxis'), time_scale: 'contact', physical_unit: null, origin: 'colony_internal', note: '' },
  { file: 'p0a2', path: 'parameters.initial_crop_fill_max', role: 'initial_stock', food: 'sugar', unit: 'fraction of crop', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'p0a2', path: 'parameters.initial_larva_gut_fill_max', role: 'initial_stock', food: 'sugar', unit: 'fraction of gut', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'p0a2', path: 'parameters.colony_workers', role: 'demand', food: 'sugar', unit: 'workers', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
  { file: 'p0a2', path: 'parameters.colony_larvae', role: 'demand', food: 'sugar', unit: 'larvae', time_scale: 'state', physical_unit: null, origin: 'scenario_initial', note: '' },
];

/**
 * Completeness rule (tested): in these files, every labelled numeric leaf whose name matches FOOD_RE, and every leaf of the
 * listed food sections, must be in REGISTRY or in NOT_FOOD with a reason. Anything else fails the test, so a new supply
 * or demand parameter cannot be added without a declared unit.
 */
export const FOOD_RE = /sugar|protein|honeydew|nectar|carcass|prey|portion|crop|insect|hemipteran|food|feed|store|egg_laying|bloom|host_plant/;
export const FOOD_SECTIONS: Record<FileKey, string[]> = {
  world: ['plants', 'hemipterans', 'honeydew', 'nectar', 'carcasses', 'insects', 'prey', 'background_colonies'],
  species: ['nutrition', 'metabolism', 'foraging_trips', 'food_handling', 'trophallaxis'],
  garden: ['honeydew_sites', 'nectar_sites', 'carcass_sites', 'boundary_insects', 'warmup_days'],
  candidate: [], p0a2: [],
};
/** labelled leaves that match FOOD_RE but are not food quantities (each with the reason) */
export const NOT_FOOD: { file: FileKey; re: RegExp; reason: string }[] = [
  { file: 'species', re: /^(task_allocation|local_signals|site_choice|activity)\.[a-z_]*(weight|fill|hunger|request|feedback|begging|default|ease|priority)[a-z_]*$/, reason: 'dimensionless behavioural cue weight / memory default (0..1 or relative score), not a food quantity' },
  { file: 'species', re: /^activity\.(liquid_fill_minutes_full_crop|protein_handling_minutes|recruit_min_crop_fill_fraction)$/, reason: 'handling time (minutes) or crop fraction threshold: time budget, not a food amount' },
  { file: 'species', re: /^predation\./, reason: 'encounter / capture probabilities and team sizes: what the colony harvests, not what the garden produces (the yield per kill is world prey.*)' },
  { file: 'species', re: /^larval_feeding\.feed_begging_threshold$/, reason: 'begging signal threshold (0..1)' },
  { file: 'species', re: /^scouting\.scout_search_when_route_unproductive_probability$/, reason: 'probability' },
  { file: 'world', re: /^day15_migration\./, reason: 'one-time Day15 migration of the legacy history (CLAUDE.md §1); not used by the Day0 garden' },
  { file: 'species', re: /^nutrition\.ration_gap_threshold$/, reason: 'fraction of the day\'s demand that must be met to not count a gap day (state bookkeeping, not a food amount)' },
  { file: 'species', re: /^foraging_trips\.repeat_trip_probability$/, reason: 'probability' },
  { file: 'species', re: /^trophallaxis\.max_trophallaxis_contacts$/, reason: 'count of contacts per unloading' },
  { file: 'p0a2', re: /^parameters\.(larva_begging_threshold|recruit_min_crop_fill|liquid_fill_minutes_full_crop)$/, reason: 'signal / fraction threshold, or handling time in minutes' },
  { file: 'p0a2', re: /^(parameters|brood_feeding_variants\.[a-z0-9-]+\.overrides)\.brood_min_own_crop_fill$/, reason: 'carer own-crop fill threshold (fraction 0..1) for brood feeding (#188/#208): a decision threshold, not a food amount' },
  { file: 'candidate', re: /^fields\.(worker_crop_fill_fraction|stores_protein)$/, reason: 'colony entry state (Day0 founding candidate, #202); audited in docs/day0-founding-evidence.md, not a garden flow' },
];

const files = (root = REPO_ROOT): Record<FileKey, Any> => Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, readJson(f, root)])) as Record<FileKey, Any>;
/** labelled numeric leaves of a parameter file as [path, value] (a "labelled leaf" is an object with a numeric value) */
export function labelledLeaves(file: FileKey, o: Any): [string, number][] {
  const out: [string, number][] = [];
  const walk = (x: Any, p: string) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) return;
    if ('value' in x && (typeof x.value === 'number' || x.value === null) && ('basis' in x || 'assumption' in x || 'evidence_class' in x)) { out.push([p, x.value]); return; }
    for (const [k, v] of Object.entries(x)) walk(v, p ? `${p}.${k}` : k);
  };
  if (file === 'candidate') { for (const [k, v] of Object.entries(o.fields ?? {})) out.push([`fields.${k}`, (v as Any).value ?? (v as Any).max ?? NaN]); return out; }
  walk(o, '');
  return out;
}
const matches = (pattern: string, p: string) => new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$').test(p);
export const registered = (file: FileKey, p: string) => REGISTRY.find((e) => e.file === file && matches(e.path, p));
/** every food-related labelled leaf that is neither registered nor excluded (must be empty) */
export function unclassified(root = REPO_ROOT): string[] {
  const F = files(root), out: string[] = [];
  for (const fk of Object.keys(FILES) as FileKey[]) for (const [p] of labelledLeaves(fk, F[fk])) {
    const inSection = FOOD_SECTIONS[fk].some((s) => p === s || p.startsWith(s + '.'));
    const name = p.split('.').slice(-2).join('.');
    if (!inSection && !FOOD_RE.test(name)) continue;
    if (registered(fk, p) || NOT_FOOD.some((x) => x.file === fk && x.re.test(p))) continue;
    out.push(`${FILES[fk]}#${p}`);
  }
  return out;
}

const at = (o: Any, p: string): Any => p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const val = (o: Any, p: string): number => { const x = at(o, p); const v = x && typeof x === 'object' && 'value' in x ? x.value : x; if (typeof v !== 'number') throw Error(`not a number: ${p}`); return v; };
const r = (x: number, d = 4) => Number(x.toPrecision(d));

/** stationary mean of the hemipteran colony count on a host with the engine's daily rule (collapse first, then growth) */
export function stationaryColonies(cap: number, pg: number, pc: number): number {
  const n = cap + 1, P = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (let i = 0; i < n; i++) for (const [j0, p0] of (i > 0 ? [[i - 1, pc], [i, 1 - pc]] : [[i, 1]]) as [number, number][]) {
    if (j0 < cap) { P[i][j0 + 1] += p0 * pg; P[i][j0] += p0 * (1 - pg); } else P[i][j0] += p0;
  }
  let pi = new Array<number>(n).fill(1 / n);
  for (let k = 0; k < 20000; k++) { const nx = new Array<number>(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) nx[j] += pi[i] * P[i][j]; pi = nx; }
  return pi.reduce((s, p, i) => s + p * i, 0);
}
/** expected insect equilibrium at a carcass site (deterministic mean-field of engine/ecology.ts insectDemography) */
export function insectEquilibrium(W: Any, birthFactor: number): { living: number; deaths_per_day: number } {
  const K = val(W, 'insects.insect_local_carrying_capacity'), m = val(W, 'insects.insect_local_daily_mortality_probability'), ref = val(W, 'insects.insect_local_death_reference_population');
  const b = val(W, 'insects.insect_site_logistic_daily_birth_rate'), imm = val(W, 'insects.insect_background_immigration_probability');
  const deaths = (N: number) => 1 - Math.pow(1 - m, N / ref), net = (N: number) => N * b * birthFactor * (1 - N / K) + (N < K ? imm : 0) - deaths(N);
  let lo = 0.01, hi = K;
  if (net(hi - 1e-9) > 0) return { living: K, deaths_per_day: deaths(K) };
  for (let k = 0; k < 100; k++) { const mid = (lo + hi) / 2; if (net(mid) > 0) lo = mid; else hi = mid; }
  return { living: lo, deaths_per_day: deaths(lo) };
}

export function audit(root = REPO_ROOT): Any {
  const F = files(root), W = F.world, S = F.species, G = F.garden, C = F.candidate, P = F.p0a2, A = readJson(ANCHORS_FILE, root).anchors;
  const engineSrc = fs.readdirSync(path.join(root, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => readText(`engine/${f}`, root)).join('\n');
  // ---- 1. registry with current values, flags and engine use ----
  const rows = REGISTRY.flatMap((e) => {
    const paths = e.path.includes('*') ? labelledLeaves(e.file, F[e.file]).map(([p]) => p).filter((p) => matches(e.path, p)) : [e.path];
    return paths.map((p) => {
      const leaf = p.split('.').pop() as string, parent = p.split('.').slice(-2)[0];
      // a leaf is "read by the engine" when its own name appears in engine/*.ts; a map entry (3+ segments, e.g.
      // hemipterans.honeydew_per_colony_per_day.aphid) is read through its map's name (a lower-case map name, not a site key
      // such as F04: day15_migration.hidden_honeydew_sites.F04.listed_production is not read just because F04 appears)
      const engineUse = e.file === 'world' || e.file === 'species' ? (engineSrc.includes(leaf) || (p.split('.').length >= 3 && /^[a-z][a-z0-9_]*$/.test(parent) && engineSrc.includes(parent))) : null;
      const x = at(F[e.file], p); const v = x && typeof x === 'object' && 'value' in x ? x.value : x;
      const basis = x && typeof x === 'object' ? (x.basis ?? x.evidence_class ?? null) : null;
      // RU-1 (v2-review.32): species / world parameters declare their own `unit`; it must equal this registry's unit
      const declared = x && typeof x === 'object' && typeof x.unit === 'string' ? x.unit : null;
      return { file: FILES[e.file], path: p, value: v, role: e.role, food: e.food, unit: e.unit, declared_unit: declared, time_scale: e.time_scale, origin: e.origin, basis, flags: [...(e.unit.startsWith('game_portion') ? ['UNITLESS_PORTION'] : []), ...(e.file === 'world' || e.file === 'species' ? (declared === null ? ['UNIT_NOT_DECLARED_IN_FILE'] : declared !== e.unit ? ['UNIT_MISMATCH'] : []) : []), ...(engineUse === false ? ['NOT_READ_BY_ENGINE'] : []), ...(e.note.startsWith('DEAD') ? ['DEAD'] : []), ...(x && typeof x === 'object' && x.implementation?.status === '未實作' ? ['MARKED_NOT_IMPLEMENTED'] : [])], note: e.note };
    });
  });
  // ---- 2. legacy engine: garden production ceiling (game portions / day) ----
  const cap = val(W, 'hemipterans.max_hemipteran_colonies_per_host'), pg = val(W, 'hemipterans.hemipteran_colony_daily_growth_probability'), pc = val(W, 'hemipterans.hemipteran_colony_daily_collapse_probability');
  const mult = val(W, 'hemipterans.honeydew_productivity_multiplier'), rivals = Object.values(W.background_colonies ?? {}).filter((x: Any) => x && x.site) as Any[];
  const honeydew = Object.entries(G.honeydew_sites).map(([id, s]: [string, Any]) => {
    const rate = val(W, `hemipterans.honeydew_per_colony_per_day.${s.hemipteran_kind}`) * mult, rival = rivals.find((x) => x.site === id), share = rival ? val(rival, 'honeydew_harvest_fraction') : 0;
    const hosts = val(s, 'host_plants'), c0 = val(s, 'hemipteran_colonies'), pe = val(s, 'exists_probability');
    const cMax = hosts * cap, cStat = hosts * stationaryColonies(cap, pg, pc);
    return { site: id, kind: s.hemipteran_kind, exists_probability: pe, host_plants: hosts, colonies_day0_census: c0, colonies_max: cMax, colonies_stationary_mean: r(cStat), rate_per_colony: rate, rival_share: share,
      net_gp_per_day_census: r(c0 * rate * (1 - share)), net_gp_per_day_stationary: r(cStat * rate * (1 - share)), net_gp_per_day_max: r(cMax * rate * (1 - share)), expected_over_seeds_stationary: r(pe * cStat * rate * (1 - share)) };
  });
  const sum = (k: string) => r(honeydew.reduce((t, h: Any) => t + h[k], 0));
  const warm = val(G, 'warmup_days');
  const nectar = Object.entries(G.nectar_sites).map(([id, s]: [string, Any]) => {
    const bloom = val(s, 'bloom_days_at_start_of_warmup'), rate = val(W, 'nectar.nectar_daily_replenish');
    return { site: id, rate_gp_per_day_while_blooming: rate, bloom_days_at_warmup_start: bloom, warmup_days: warm, bloom_days_left_at_day0: Math.max(0, bloom - warm), gp_per_day_after_day0: bloom > warm ? rate : 0, flag: bloom <= warm ? 'BLOOM_ENDS_BEFORE_DAY0 (D4: no re-bloom)' : '' };
  });
  const cMin = val(W, 'carcasses.carcass_new_protein_min'), cMaxP = val(W, 'carcasses.carcass_new_protein_max'), carcassMean = (cMin + cMaxP) / 2;
  const fLo = val(W, 'insects.insect_reproduction_min_multiplier'), fHi = val(W, 'insects.insect_reproduction_max_multiplier');
  const carcass = Object.keys(G.carcass_sites).map((id) => {
    const eq = (f: number) => { const e = insectEquilibrium(W, f); return { insects: r(e.living), natural_deaths_per_day: r(e.deaths_per_day), protein_gp_per_day: r(e.deaths_per_day * carcassMean) }; };
    return { site: id, birth_factor_1: eq(1), birth_factor_min: eq(fLo), birth_factor_max: eq(fHi) };
  });
  const small = val(W, 'prey.small_prey_protein'), large = val(W, 'prey.large_prey_protein'), lf = val(W, 'prey.large_prey_fraction');
  const preyMean = lf * large + (1 - lf) * small;
  const supply = {
    honeydew_by_site: honeydew,
    honeydew_total_gp_per_day: { census_all_sites_present: sum('net_gp_per_day_census'), stationary_all_present: sum('net_gp_per_day_stationary'), max_all_present: sum('net_gp_per_day_max'), expected_over_world_seeds_stationary: sum('expected_over_seeds_stationary') },
    nectar_by_site: nectar,
    carcass_by_site: carcass,
    carcass_total_protein_gp_per_day_birth_factor_1: r(carcass.reduce((t, c) => t + c.birth_factor_1.protein_gp_per_day, 0)),
    per_insect_yield_gp: { natural_death_mean: r(carcassMean), natural_death_range: [cMin, cMaxP], killed_mean: r(preyMean), killed_small: small, killed_large: large, ratio_killed_to_natural: r(preyMean / carcassMean) },
  };
  // ---- 3. legacy engine: colony demand (game portions / day) ----
  const q10 = val(S, 'metabolism.q10'), refC = val(S, 'metabolism.reference_c'), f = (T: number) => Math.pow(q10, (T - refC) / 10);
  const n = (k: string) => val(S, `nutrition.${k}`);
  const route = val(W, 'routes.route_edge_minutes'), tripCost = val(S, 'foraging_trips.foraging_trip_sugar_cost') + val(S, 'activity.active_minute_sugar_cost') * (2 * route + val(S, 'activity.liquid_fill_minutes_full_crop') + val(S, 'activity.unload_minutes'));
  const lpm = (C.fields.larvae_per_minor.min + C.fields.larvae_per_minor.max) / 2, wMin = C.fields.minor_workers.min, wMax = C.fields.minor_workers.max;
  const sizes = [10, 30, Math.round(Math.sqrt(wMin * wMax)), wMax, 2000];
  const temps = [15, 20, 25, 30];
  const demand = sizes.map((N) => {
    const L = Math.round(N * lpm);
    return { workers: N, larvae: L, queens: 1, by_temp_c: Object.fromEntries(temps.map((T) => [T, { factor: r(f(T)), sugar_gp: r((N * n('worker_sugar_daily') + n('queen_sugar_daily') + L * n('larva_sugar_daily')) * f(T)), protein_gp: r((N * n('worker_protein_daily') + n('queen_protein_daily') + L * n('larva_protein_daily')) * f(T)) }])) };
  });
  const hdStat = supply.honeydew_total_gp_per_day.stationary_all_present, hdExp = supply.honeydew_total_gp_per_day.expected_over_world_seeds_stationary;
  const breakEven = Object.fromEntries(temps.map((T) => [T, { workers_whose_maintenance_sugar_equals_stationary_production_all_sites_present: r(hdStat / (n('worker_sugar_daily') * f(T)), 3), same_expected_over_world_seeds: r(hdExp / (n('worker_sugar_daily') * f(T)), 3), workers_whose_maintenance_protein_equals_natural_carcass_generation: r(supply.carcass_total_protein_gp_per_day_birth_factor_1 / (n('worker_protein_daily') * f(T)), 3) }]));
  const trips = val(S, 'foraging_trips.max_trips_per_forager'), loadMax = val(S, 'food_handling.crop_load_sugar_max'), pColl = val(S, 'food_handling.liquid_collection_probability');
  // ---- 4. P0-A2 prototype ----
  const pv = (k: string) => val(P, `parameters.${k}`);
  const p0Supply = pv('honeydew_amount_portions') * 86400 / pv('honeydew_interval_s'), p0Demand = pv('colony_workers') * pv('worker_sugar_daily_portions') + pv('colony_larvae') * pv('larva_sugar_daily_portions');
  // ---- 5. literature-anchored magnitudes (explicit conversions) ----
  const [m0, m1] = A.minor_fresh_mass_mg.range as number[], oxy = A.oxyjoule_j_per_ml_o2.value, eSugar = A.sugar_energy_j_per_mg.value;
  const smrT = (Mmg: number, T: number) => Math.pow(10, A.standard_vo2_temperature.a + A.standard_vo2_temperature.b * T) * (Mmg / 1000); // mL O2 / h
  const smrM = (Mmg: number) => A.standard_vo2_mass.c * Math.pow(Mmg / 1000, A.standard_vo2_mass.e); // mL O2 / h
  const mgSugarPerDay = (mlh: number) => (mlh * 24 * oxy) / eSugar;
  const restSugar = [mgSugarPerDay(smrT(m0, refC)), mgSugarPerDay(smrT(m1, refC)), mgSugarPerDay(smrM(m0)), mgSugarPerDay(smrM(m1))];
  const restLo = Math.min(...restSugar), restHi = Math.max(...restSugar);
  const convSmr = [restLo / n('worker_sugar_daily'), restHi / n('worker_sugar_daily')];
  const convLoad = (A.minor_liquid_load_mg.value * A.honey_sugar_mass_fraction.value) / val(S, 'trophallaxis.crop_capacity');
  const convLo = Math.min(convSmr[0], convLoad), convHi = Math.max(convSmr[1], convLoad);
  const [hdLo, hdHi] = A.aphid_honeydew_ug_per_aphid_h.range as number[], [sfLo, sfHi] = A.honeydew_sugar_mass_fraction.range as number[], [hLo, hHi] = A.honeydew_secretion_hours_per_day.range as number[];
  const aphidSugarMgDay = [(hdLo / 1000) * hLo * sfLo, (hdHi / 1000) * hHi * sfHi];
  const aphidRate = val(W, 'hemipterans.honeydew_per_colony_per_day.aphid');
  const gameColonyMg = [aphidRate * convLo, aphidRate * convHi];
  const anchored = {
    conversion_candidates_mg_sugar_per_gp: { load_based_R132: r(convLoad), smr_based_R951: [r(convSmr[0]), r(convSmr[1])], union: [r(convLo), r(convHi)], status: 'candidate range for comparison only; NOT an established unit' },
    resting_sugar_mg_per_minor_per_day_R951_extrapolated: [r(restLo), r(restHi)],
    aphid_honeydew_sugar_mg_per_aphid_per_day: [r(aphidSugarMgDay[0]), r(aphidSugarMgDay[1])],
    game_aphid_colony_sugar_mg_per_day: [r(gameColonyMg[0]), r(gameColonyMg[1])],
    game_aphid_colony_in_aphid_equivalents: [r(gameColonyMg[0] / aphidSugarMgDay[1]), r(gameColonyMg[1] / aphidSugarMgDay[0])],
    game_garden_honeydew_stationary_mg_sugar_per_day: [r(hdStat * convLo), r(hdStat * convHi)],
  };
  return {
    schema: 'antempire.garden-supply-demand-audit.v1', status: '研究稽核（#202 第 8 項）；診斷，不是目標，不得用來反推花園供給', inputs: FILES, anchors_file: ANCHORS_FILE,
    registry: rows, unclassified: unclassified(root),
    legacy: { supply, demand, break_even_diagnostic: breakEven, foraging_time_cap: { max_trips_per_forager: trips, crop_load_sugar_max: loadMax, liquid_collection_probability: pColl, max_sugar_gp_per_forager_day: r(trips * loadMax * pColl), sugar_cost_gp_per_trip_round_trip_one_edge: r(tripCost) } },
    p0a2: { supply_gp_per_day: r(p0Supply), demand_gp_per_day: r(p0Demand), ratio: r(p0Supply / p0Demand), supply_kind: 'fixed scenario drip (no ecological driver)' },
    anchored,
  };
}

const fmt = (x: Any): string => (Array.isArray(x) ? x.map(fmt).join('～') : x === null || x === undefined ? 'null' : String(x));
export function renderMarkdown(a: Any): string {
  const L: string[] = [];
  L.push('# 花園供給 vs 蟻群消耗：單位、時間尺度與守恆稽核（自動產生）', '');
  L.push('> 由 `node tools/garden-supply-demand-audit.ts --write` 產生；只讀參數檔與 `' + a.anchors_file + '`，不執行引擎、不讀寫 saves/ 或 journal/。', '> **診斷，不是目標**：本報告任何數字都不得用來反推花園資源或讓蟻群存活（CLAUDE.md §7；#202 Owner 裁示第 8 項）。「份」（game portion）是遊戲單位，**不是 mg**；mg 欄位只是用明列的候選換算做量級比較。', '');
  L.push('## 1. 參數單位登錄（每個供給／需求參數）', '', '| 檔案 | 參數 | 值 | 角色 | 食物 | 單位 | 參數檔宣告 | 時間尺度 | 來源類型 | 依據 | 旗標 | 備註 |', '|---|---|---:|---|---|---|---|---|---|---|---|---|');
  for (const x of a.registry) L.push(`| ${x.file} | \`${x.path}\` | ${fmt(x.value)} | ${x.role} | ${x.food} | ${x.unit} | ${x.declared_unit === null ? (x.file.startsWith('species/') || x.file.startsWith('world/') ? '**未宣告**' : '—（本檔不在 RU-1 範圍）') : x.declared_unit === x.unit ? '✔' : '**不一致**'} | ${x.time_scale} | ${x.origin} | ${fmt(x.basis)} | ${x.flags.join(' ') || '—'} | ${x.note || '—'} |`);
  const flagged = a.registry.filter((x: Any) => x.flags.includes('UNITLESS_PORTION')).length;
  L.push('', `共 ${a.registry.length} 項；其中 ${flagged} 項以「份」計（UNITLESS_PORTION：沒有質量單位）。物種／世界參數檔中 ${a.registry.filter((x: Any) => x.declared_unit !== null).length} 項已在檔內宣告 unit 欄位（RU-1，v2-review.32），未宣告或不一致：${a.registry.filter((x: Any) => x.flags.includes('UNIT_NOT_DECLARED_IN_FILE') || x.flags.includes('UNIT_MISMATCH')).length}。未分類的食物相關參數：${a.unclassified.length ? a.unclassified.join('、') : '0（全部已登錄或已列為非食物量）'}。`, '');
  const s = a.legacy.supply;
  L.push('## 2. 舊日程引擎：花園生產上限（份／日，世界過程的平均場計算）', '', '| 地點 | 種類 | 存在機率 | 寄主 | 群數（Day0 盤點／平穩平均／上限） | 每群份／日 | 背景競爭者取走 | 淨產量 份／日（盤點／平穩／上限） |', '|---|---|---:|---:|---|---:|---:|---|');
  for (const h of s.honeydew_by_site) L.push(`| ${h.site} | ${h.kind} | ${h.exists_probability} | ${h.host_plants} | ${h.colonies_day0_census}／${h.colonies_stationary_mean}／${h.colonies_max} | ${h.rate_per_colony} | ${h.rival_share} | ${h.net_gp_per_day_census}／${h.net_gp_per_day_stationary}／${h.net_gp_per_day_max} |`);
  const t = s.honeydew_total_gp_per_day;
  L.push('', `蜜露合計（四地點都存在）：盤點 ${t.census_all_sites_present}、平穩 ${t.stationary_all_present}、上限 ${t.max_all_present} 份／日；依存在機率平均（平穩）${t.expected_over_world_seeds_stationary} 份／日。未扣雨天抑制與沖刷（晴天上限）。`, '');
  for (const nx of s.nectar_by_site) L.push(`- 花蜜 ${nx.site}：開花時 ${nx.rate_gp_per_day_while_blooming} 份／日；暖機開始剩 ${nx.bloom_days_at_warmup_start} 日、暖機 ${nx.warmup_days} 日 → Day0 之後 **${nx.gp_per_day_after_day0} 份／日** ${nx.flag}`);
  L.push('', '| 屍體地點 | 生育倍率 1：平衡昆蟲數／自然死亡（隻／日）／蛋白 份／日 | 生育倍率下限 | 生育倍率上限 |', '|---|---|---|---|');
  for (const c of s.carcass_by_site) L.push(`| ${c.site} | ${c.birth_factor_1.insects}／${c.birth_factor_1.natural_deaths_per_day}／${c.birth_factor_1.protein_gp_per_day} | ${c.birth_factor_min.insects}／${c.birth_factor_min.natural_deaths_per_day}／${c.birth_factor_min.protein_gp_per_day} | ${c.birth_factor_max.insects}／${c.birth_factor_max.natural_deaths_per_day}／${c.birth_factor_max.protein_gp_per_day} |`);
  const y = s.per_insect_yield_gp;
  L.push('', `自然屍體蛋白合計（生育倍率 1）：${s.carcass_total_protein_gp_per_day_birth_factor_1} 份／日（未扣腐敗；捕食只是把同一批昆蟲提早變成食物，不增加昆蟲周轉）。`, `**每隻昆蟲的蛋白不一致**：自然死亡平均 ${y.natural_death_mean}（${fmt(y.natural_death_range)}）份；被獵殺平均 ${y.killed_mean}（小 ${y.killed_small}／大 ${y.killed_large}）份；比值 ${y.ratio_killed_to_natural}。同一隻被追蹤的昆蟲，死法不同、蛋白量不同，而昆蟲本身沒有體重。`, '');
  L.push('## 3. 舊日程引擎：蟻群需求（份／日；Q10 依巢溫模型）', '', '| 工蟻 | 幼蟲 | 蟻后 | ' + Object.keys(a.legacy.demand[0].by_temp_c).map((T) => `${T}°C 糖／蛋白`).join(' | ') + ' |', '|---:|---:|---:|' + Object.keys(a.legacy.demand[0].by_temp_c).map(() => '---').join('|') + '|');
  for (const d of a.legacy.demand) L.push(`| ${d.workers} | ${d.larvae} | ${d.queens} | ` + Object.values(d.by_temp_c).map((v: Any) => `${v.sugar_gp}／${v.protein_gp}`).join(' | ') + ' |');
  L.push('', '幼蟲數＝工蟻 × 候選 `larvae_per_minor` 中點；不含趟次活動耗糖（每趟約 ' + a.legacy.foraging_time_cap.sugar_cost_gp_per_trip_round_trip_one_edge + ' 份）與產卵成本。', '');
  L.push('**診斷（不是目標）**：在模型自己的單位下，「維生糖需求＝花園蜜露平穩產量」的工蟻數，以及「維生蛋白需求＝自然屍體蛋白產量」的工蟻數：', '', '| 巢溫 | 糖：四地點都存在 | 糖：依存在機率平均 | 蛋白：自然屍體 |', '|---:|---:|---:|---:|');
  for (const [T, b] of Object.entries(a.legacy.break_even_diagnostic) as [string, Any][]) L.push(`| ${T}°C | ${b.workers_whose_maintenance_sugar_equals_stationary_production_all_sites_present} | ${b.same_expected_over_world_seeds} | ${b.workers_whose_maintenance_protein_equals_natural_carcass_generation} |`);
  const ft = a.legacy.foraging_time_cap;
  L.push('', `時間尺度上限：每隻覓食工蟻每日最多 ${ft.max_trips_per_forager} 趟 × ${ft.crop_load_sugar_max} 份 × 採到機率 ${ft.liquid_collection_probability} ＝ ${ft.max_sugar_gp_per_forager_day} 份糖／日（D2）。`, '');
  const p = a.p0a2;
  L.push('## 4. P0-A2 24 小時原型', '', `供給 ${p.supply_gp_per_day} 份／日（${p.supply_kind}）；需求 ${p.demand_gp_per_day} 份／日；供需比 ${p.ratio}。供給不來自任何生態過程（沒有半翅目、植物、溫度或雨），是固定情境滴量。`, '');
  const an = a.anchored;
  L.push('## 5. 文獻錨定的量級比較（換算全部明列；非本種外推）', '', '| 量 | 值 | 換算／來源 |', '|---|---|---|');
  L.push(`| 候選換算：1 份糖 ＝ ? mg 糖 | 載量法 ${an.conversion_candidates_mg_sugar_per_gp.load_based_R132}；代謝法 ${fmt(an.conversion_candidates_mg_sugar_per_gp.smr_based_R951)}；聯集 ${fmt(an.conversion_candidates_mg_sugar_per_gp.union)} | 載量法：R132 0.08 mg 蜂蜜 × 0.8 糖分（假設）÷ crop_capacity；代謝法：R951（**非本種**）靜止耗氧外推到 R107／R346 體重，× 20.1 J/mL O2 ÷ 16.5 J/mg，對應 worker_sugar_daily |`);
  L.push(`| 小工蟻靜止耗糖（外推） | ${fmt(an.resting_sugar_mg_per_minor_per_day_R951_extrapolated)} mg／隻／日 | R951 兩式 × 體重 0.35～0.541 mg（R107、R346）；野外活動代謝更高（未量化） |`);
  L.push(`| 一隻蚜蟲的蜜露糖 | ${fmt(an.aphid_honeydew_sugar_mg_per_aphid_per_day)} mg／隻／日 | R950、R952：46～880 µg 蜜露／隻／h；× 分泌時數 12～24 h（假設）× 糖分 5～25%（假設） |`);
  L.push(`| 遊戲一個「蚜蟲群」 | ${fmt(an.game_aphid_colony_sugar_mg_per_day)} mg 糖／日 | aphid 每群份／日 × 換算聯集 |`);
  L.push(`| 遊戲一個「蚜蟲群」相當幾隻蚜蟲 | ${fmt(an.game_aphid_colony_in_aphid_equivalents)} 隻 | 上兩列相除（取極端組合） |`);
  L.push(`| 遊戲全花園蜜露平穩產量 | ${fmt(an.game_garden_honeydew_stationary_mg_sugar_per_day)} mg 糖／日 | 平穩產量 × 換算聯集 |`);
  L.push('', '解讀限制：換算本身是候選；蚜蟲數據來自歐洲溫帶寄主與 *Lasius niger*；臺中花園半翅目的種類、每群隻數、晝夜節律與糖濃度都未知。這些量級比較**只**說明「群」這個單位缺少個體數維度，不支持任何特定的花園供給數值。', '');
  return L.join('\n') + '\n';
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(REPO_ROOT, 'tools/garden-supply-demand-audit.ts');
if (isMain) {
  const a = audit(), md = renderMarkdown(a);
  if (process.argv.includes('--write')) {
    fs.mkdirSync(path.join(REPO_ROOT, OUT_DIR), { recursive: true });
    fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'audit.md'), md);
    fs.writeFileSync(path.join(REPO_ROOT, OUT_DIR, 'audit.json'), JSON.stringify(a, null, 2) + '\n');
  }
  process.stdout.write(md);
  if (a.unclassified.length) { console.error('UNCLASSIFIED food parameters: ' + a.unclassified.join(', ')); process.exitCode = 1; }
}
