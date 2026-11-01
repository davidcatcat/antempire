/**
 * Parameter files -> typed numeric parameters.
 *
 * Two kinds of files (see CLAUDE.md §3–4):
 *   species/<id>.json  — biology of ONE ant species (development, metabolism, behaviour, ...)
 *   world/<id>.json    — the garden (weather, plants, hemipterans, insects, routes, ...), species-independent
 *
 * Every numeric leaf is { value, assumption: true, basis, ... }. Resolution fails loudly when a value
 * is missing, non-finite, or not tagged as an assumption, exactly like the v6 P() accessor did.
 */
import { UNIT_DECIMALS } from './math.ts';

export const ALLOWED_BASIS = ['文獻支持', '一般生理學', '遊戲假設'] as const;

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type ParamFile = { [k: string]: Json };

/** A bundle of everything one simulated day needs: the world file and one file per species. */
export interface ParamBundle {
  world: ParamFile;
  species: Record<string, ParamFile>;
}

function at(file: ParamFile, path: string): Json | undefined {
  let v: Json | undefined = file;
  for (const segment of path.split('.')) {
    v = v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, Json>)[segment] : undefined;
  }
  return v;
}

/** Read one tagged numeric parameter. Throws like v6 P(). */
export function num(file: ParamFile, path: string): number {
  const v = at(file, path) as Record<string, Json> | undefined;
  if (!v || typeof v !== 'object' || v.assumption !== true || typeof v.value !== 'number' || !Number.isFinite(v.value)) {
    throw Error('Missing/untagged assumption parameter ' + path);
  }
  return v.value;
}

function str(file: ParamFile, path: string): string {
  const v = at(file, path);
  if (typeof v !== 'string') throw Error('Missing string parameter ' + path);
  return v;
}

function bool(file: ParamFile, path: string): boolean {
  const v = at(file, path);
  if (typeof v !== 'boolean') throw Error('Missing boolean parameter ' + path);
  return v;
}

function section<K extends string>(file: ParamFile, name: string, keys: readonly K[]): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(file, `${name}.${k}`);
  return out;
}

/** Walk a whole file: every object holding `value` must be a tagged assumption with an allowed basis. */
export function validateParamTree(file: ParamFile, label: string): number {
  let count = 0;
  const walk = (node: Json, path: string): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach((x, i) => walk(x, `${path}[${i}]`)); return; }
    if ('value' in node) {
      count++;
      if (node.assumption !== true) throw Error(`${label}:${path} must be assumption:true`);
      if (!ALLOWED_BASIS.includes(node.basis as (typeof ALLOWED_BASIS)[number])) throw Error(`${label}:${path} needs basis ∈ ${ALLOWED_BASIS.join('/')}`);
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(file, '');
  return count;
}

export function resolveSpecies(file: ParamFile) {
  if (file.schema !== 'antempire.species-params.v1') throw Error('Unknown species params schema ' + String(file.schema));
  const p = {
    species_id: str(file, 'species_id'),
    castes: {
      eclosion_caste_label: str(file, 'castes.eclosion_caste_label'),
      major_worker_production_enabled: bool(file, 'castes.major_worker_production_enabled'),
    },
    development: section(file, 'development', ['reference_c', 'egg_days', 'larva_days', 'pupa_days', 'q10', 'min_temp_factor', 'max_temp_factor', 'larva_min_nutrition_growth_factor'] as const),
    metabolism: section(file, 'metabolism', ['reference_c', 'q10'] as const),
    nutrition: section(file, 'nutrition', ['worker_sugar_daily', 'worker_protein_daily', 'queen_sugar_daily', 'queen_protein_daily', 'larva_sugar_daily', 'larva_protein_daily', 'egg_laying_protein_cost', 'egg_laying_sugar_cost', 'max_sugar_store', 'max_protein_store', 'store_capacity_baseline_workers', 'sugar_store_per_extra_worker', 'protein_store_per_extra_worker', 'ration_gap_threshold'] as const),
    starvation: section(file, 'starvation', ['queen_egg_pause_days', 'worker_mortality_starts_days', 'larva_mortality_starts_days', 'worker_daily_hazard_base', 'worker_daily_hazard_slope', 'larva_daily_hazard_base', 'larva_daily_hazard_slope', 'queen_hazard_after_days', 'queen_daily_hazard', 'queen_zero_worker_hazard_after_days', 'queen_zero_worker_starved_daily_hazard', 'larva_daily_hazard_cap', 'worker_starvation_hazard_cap'] as const),
    brood_care: section(file, 'brood_care', ['unattended_larva_max_days', 'unattended_egg_max_days', 'unattended_pupa_max_days'] as const),
    worker_lifespan: section(file, 'worker_lifespan', ['natural_daily_base_hazard', 'age_risk_from_days', 'age_hazard_slope', 'injury_mortality_multiplier', 'newborn_initial_age_days', 'injury_repair_probability', 'adult_total_daily_hazard_cap'] as const),
    queen_laying: section(file, 'queen_laying', ['base_laying_probability', 'max_eggs_per_day', 'existing_brood_pressure', 'previous_laying_penalty', 'adequate_nutrition_threshold', 'laying_reference_c', 'laying_temperature_q10', 'second_egg_given_laying_probability', 'laying_probability_cap'] as const),
    task_allocation: section(file, 'task_allocation', ['rest_baseline_probability', 'nurse_baseline_probability', 'maintenance_baseline_probability', 'forage_baseline_probability', 'defence_baseline_probability', 'newborn_nurse_days', 'injured_task_forage_multiplier', 'newborn_forage_multiplier', 'hunger_own_crop_weight', 'hunger_peer_weight', 'hunger_forage_boost', 'brood_begging_nurse_boost', 'newborn_nurse_multiplier', 'injured_rest_multiplier', 'soil_wetness_repair_boost'] as const),
    local_signals: section(file, 'local_signals', ['local_peer_contact_probability', 'local_signal_smoothing', 'default_own_crop_sugar_fill', 'default_peer_sugar_hunger', 'default_direct_brood_begging', 'default_peer_protein_request', 'nurse_larva_contact_probability', 'default_larva_begging_contact_signal', 'crop_fill_previous_weight', 'crop_fill_today_weight', 'default_crop_fill_before_feeding', 'larva_begging_previous_weight', 'larva_begging_shortfall_weight', 'default_larva_begging_prior', 'unload_feedback_default', 'unload_ease_base', 'unload_ease_contact_weight', 'unload_feedback_previous_weight', 'unload_feedback_today_weight'] as const),
    foraging_activity: section(file, 'foraging_activity', ['rain_suppression_fraction', 'min_rain_activity_multiplier', 'foraging_cold_limit_c', 'foraging_full_activity_c', 'foraging_cold_min_multiplier', 'daily_window_minutes'] as const),
    foraging_trips: section(file, 'foraging_trips', ['max_trips_per_forager', 'foraging_trip_sugar_cost', 'repeat_trip_probability'] as const),
    scouting: section(file, 'scouting', ['scout_discovery_probability', 'scout_search_when_route_unproductive_probability', 'unproductive_route_threshold_portions'] as const),
    site_choice: section(file, 'site_choice', ['sugar_hunger_priority_weight', 'protein_begging_priority_weight', 'unloading_success_memory_weight', 'need_own_crop_weight', 'need_peer_weight', 'default_prior_success_portions', 'default_last_visit_days_ago', 'recent_failure_penalty', 'recent_failure_window_days', 'brood_begging_protein_weight', 'peer_protein_feedback_weight', 'score_base_offset', 'unloading_memory_base', 'best_site_choice_probability'] as const),
    food_handling: section(file, 'food_handling', ['carcass_access_probability', 'liquid_collection_probability', 'crop_load_sugar_min', 'crop_load_sugar_max', 'crop_load_protein_min', 'crop_load_protein_max'] as const),
    recruitment: section(file, 'recruitment', ['recruitment_probability', 'recruitment_max_followers', 'trail_daily_retention', 'trail_deposit_per_success', 'trail_min_detectable', 'trail_max_strength', 'follow_intermediate_source_probability', 'trail_follow_max_hops'] as const),
    trophallaxis: section(file, 'trophallaxis', ['crop_capacity', 'max_trophallaxis_contacts', 'transfer_max_portions'] as const),
    predation: section(file, 'predation', ['live_prey_encounter_probability', 'large_prey_min_team', 'live_prey_capture_probability'] as const),
  };
  if (p.castes.major_worker_production_enabled) {
    throw Error(`Species ${p.species_id}: castes.major_worker_production_enabled=true is not implemented by this engine`);
  }
  return p;
}
export type SpeciesParams = ReturnType<typeof resolveSpecies>;

export interface ScenarioColony {
  id: string; species_id: string; nest_node: string; queen_id: string;
  worker_id_prefix: string; egg_id_prefix: string; id_number_width: number; rng_namespace: string;
}

export function resolveWorld(file: ParamFile) {
  if (file.schema !== 'antempire.world-params.v1') throw Error('Unknown world params schema ' + String(file.schema));
  const edges = at(file, 'routes.topology.edges');
  if (!Array.isArray(edges) || !edges.every((e) => Array.isArray(e) && e.length === 2 && e.every((n) => typeof n === 'string'))) {
    throw Error('NO_GOD_MODE: physical route topology missing or malformed');
  }
  const kinds = at(file, 'hemipterans.honeydew_per_colony_per_day') as Record<string, Json> | undefined;
  if (!kinds || typeof kinds !== 'object') throw Error('Missing hemipterans.honeydew_per_colony_per_day');
  const honeydewPerColony: Record<string, number> = {};
  for (const kind of Object.keys(kinds)) honeydewPerColony[kind] = num(file, `hemipterans.honeydew_per_colony_per_day.${kind}`);
  const rivals: { id: string; site: string; honeydew_harvest_fraction: number }[] = [];
  const bg = at(file, 'background_colonies') as Record<string, Json>;
  for (const [id, entry] of Object.entries(bg ?? {})) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry) && 'honeydew_harvest_fraction' in entry) {
      rivals.push({ id, site: str(file, `background_colonies.${id}.site`), honeydew_harvest_fraction: num(file, `background_colonies.${id}.honeydew_harvest_fraction`) });
    }
  }
  const model = section(file, 'model', ['scenario_seed', 'unit_precision'] as const);
  if (model.unit_precision !== UNIT_DECIMALS) throw Error(`model.unit_precision=${model.unit_precision} but the engine rounds to ${UNIT_DECIMALS} decimals`);
  return {
    world_id: str(file, 'world_id'),
    scenario_colonies: at(file, 'scenario_colonies') as unknown as ScenarioColony[],
    model,
    climate: section(file, 'climate', ['annual_rain_days', 'wet_persistence', 'temperature_ar', 'temperature_daily_sigma_c', 'rainfall_gamma_shape', 'soil_daily_loss', 'soil_rain_gain_per_mm', 'soil_persistence', 'soil_shade_daily_loss', 'soil_shade_persistence', 'soil_shade_rain_gain_per_mm', 'wet_day_temperature_offset_c', 'rh_wet_offset_percent', 'rh_dry_offset_percent', 'rh_anomaly_coefficient', 'rain_prior_month_weight_exponent', 'rain_probability_daily_cap'] as const),
    nest_microclimate: section(file, 'nest_microclimate', ['nest_temp_memory'] as const),
    plants: section(file, 'plants', ['host_plant_daily_death_probability'] as const),
    hemipterans: { ...section(file, 'hemipterans', ['honeydew_productivity_multiplier', 'hemipteran_colony_daily_growth_probability', 'hemipteran_colony_daily_collapse_probability', 'max_hemipteran_colonies_per_host', 'rain_honeydew_secretion_suppression_per_mm', 'honeydew_rain_secretion_min_multiplier'] as const), honeydew_per_colony_per_day: honeydewPerColony },
    honeydew: section(file, 'honeydew', ['honeydew_max', 'honeydew_initial', 'honeydew_washoff_per_rain_mm', 'honeydew_washoff_max_fraction'] as const),
    nectar: section(file, 'nectar', ['nectar_max', 'nectar_daily_replenish', 'nectar_initial', 'nectar_bloom_days_remaining', 'nectar_washoff_per_rain_mm', 'nectar_washoff_max_fraction'] as const),
    carcasses: section(file, 'carcasses', ['carcass_daily_decay_fraction', 'carcass_rain_decay_bonus', 'carcass_new_protein_min', 'carcass_new_protein_max', 'carcass_max_lifetime_days', 'carcass_decay_max_daily_fraction'] as const),
    insects: section(file, 'insects', ['insect_local_carrying_capacity', 'insect_background_immigration_probability', 'insect_local_daily_mortality_probability', 'insect_site_logistic_daily_birth_rate', 'insect_boundary_logistic_daily_birth_rate', 'insect_boundary_carrying_capacity', 'insect_boundary_per_capita_daily_death_probability', 'insect_reproduction_reference_c', 'insect_reproduction_per_degree_c', 'insect_reproduction_min_multiplier', 'insect_reproduction_max_multiplier', 'insect_local_death_reference_population'] as const),
    prey: section(file, 'prey', ['large_prey_fraction', 'small_prey_protein', 'large_prey_protein'] as const),
    routes: { edges: edges as [string, string][], route_edge_minutes: num(file, 'routes.route_edge_minutes') },
    background_rivals: rivals,
  };
}
export type WorldParams = ReturnType<typeof resolveWorld>;

export interface ResolvedParams {
  world: WorldParams;
  species: Record<string, SpeciesParams>;
  /** Raw world file (needed by the one-time Day15 migration). */
  worldFile: ParamFile;
}

export function resolveBundle(bundle: ParamBundle): ResolvedParams {
  if (!bundle || typeof bundle !== 'object' || !bundle.world || !bundle.species) throw Error('Parameter bundle must be { world, species }');
  const species: Record<string, SpeciesParams> = {};
  for (const [id, file] of Object.entries(bundle.species)) {
    const resolved = resolveSpecies(file);
    if (resolved.species_id !== id) throw Error(`Species bundle key ${id} does not match file species_id ${resolved.species_id}`);
    species[id] = resolved;
  }
  return { world: resolveWorld(bundle.world), species, worldFile: bundle.world };
}
