/**
 * State types.
 *
 * A WORLD holds species-independent things (clock, climate memory, food sources, insects) and a list of
 * COLONIES. Each colony belongs to one species (species_id -> species/<id>.json) and owns its own
 * workers, brood, nest stores, pheromone trails and knowledge of food sources. Today only the main
 * colony is simulated; the structure already allows several colonies of different species.
 */

export interface LocalSensory {
  own_crop_sugar_fill?: number;
  peer_sugar_hunger?: number;
  peer_protein_request?: number;
  direct_brood_begging?: number;
  unload_feedback?: { sugar: number; protein: number; [k: string]: number };
  own_feeding_fraction?: number;
  last_food_kind?: string;
  last_unloading_ease?: number;
  origin?: string;
  [k: string]: unknown;
}

export interface SiteMemory { last_success_portions: number; last_visit_day: number }

export interface Worker {
  id: string;
  alive?: boolean;
  age_days: number;
  age_origin?: string;
  injured: boolean;
  task: string;
  known_sources: string[];
  last_location: string;
  local_sensory?: LocalSensory;
  site_memory?: Record<string, SiteMemory>;
  crop_cargo_sugar?: number;
  recruited_today?: boolean;
  [k: string]: unknown;
}

export type BroodStage = 'egg' | 'larva' | 'pupa';
export interface Brood {
  id: string;
  stage: BroodStage;
  laid_on_day?: number | null;
  age_days: number | null;
  progress: number;
  begging_signal?: number;
  no_caretaker_days?: number;
  alive?: boolean;
  origin?: string;
  [k: string]: unknown;
}

export interface Population { queen_alive: boolean; workers: Worker[]; brood: Brood[] }

/** Nest food ledger and chronic-shortage counters of one colony (v2 field name: `colony`). */
export interface ColonyStores {
  sugar: number;
  protein: number;
  sugar_gap_days: number;
  protein_gap_days: number;
  stress_days: number;
  queen_laid_yesterday: boolean;
  no_worker_days?: number;
  [k: string]: unknown;
}

export interface CarcassBatch { event_id: string; original_day: number; protein: number; age_days: number; origin?: string; [k: string]: unknown }

/** A physical food source in the world (species-independent). */
export interface Source {
  id: string;
  type: 'honeydew' | 'nectar' | 'carcass' | string;
  sugar: number;
  protein: number;
  host_alive?: boolean;
  production_per_day?: number;
  production_last_day?: number;
  capacity?: number;
  host_plants?: number;
  hemipteran_kind?: string;
  hemipteran_colonies?: number;
  bloom_days_left?: number;
  batches: CarcassBatch[];
  access_from?: string[];
  ecological_record?: Record<string, unknown>;
  [k: string]: unknown;
}

/** What ONE colony knows about one source. Discovery is per colony, never shared world knowledge. */
export interface SourceKnowledge {
  presence: 'confirmed_game_scenario' | 'potential' | 'scouted_empty' | string;
  known_by: string[];
  [k: string]: unknown;
}

export interface InsectSite { living: number; carrying_capacity?: number; cumulative_deaths: number; [k: string]: unknown }

export interface WorldEcology {
  adjacent_garden_living_insects: number;
  adjacent_garden_carrying_capacity?: number;
  insects_by_site: Record<string, InsectSite>;
  [k: string]: unknown;
}

export interface MonthlyClimate {
  month: number;
  mean_air_temperature_c: number;
  mean_daily_maximum_air_temperature_c: number;
  mean_daily_minimum_air_temperature_c: number;
  mean_relative_humidity_percent: number;
  mean_monthly_precipitation_mm: number;
}

export interface ClimateState {
  monthly: MonthlyClimate[];
  rain_days_per_year?: number;
  prior_wet: boolean;
  temp_anomaly_c: number;
  prior_air_temp_c: number;
  /** NOTE: read by weather.ts but never written by v6 (it writes prior_nest_temp_model_c). See PR notes. */
  prior_nest_temp_c?: number;
  prior_nest_temp_model_c?: number;
  soil_index: number;
  shade_index: number;
  [k: string]: unknown;
}

export interface ColonyState {
  id: string;
  species_id: string;
  nest_node: string;
  queen_id: string;
  /** Prefix for every colony-level random stream tag. '' only for the legacy main colony. */
  rng_namespace: string;
  worker_id_prefix: string;
  egg_id_prefix: string;
  id_number_width: number;
  next_worker_number: number;
  next_egg_number: number;
  population: Population;
  stores: ColonyStores;
  /** Pheromone trail strength by undirected edge key "A:B" — this colony's own trails. */
  trail_by_edge: Record<string, number>;
  /** Per-source discovery state for THIS colony. */
  source_knowledge: Record<string, SourceKnowledge>;
  last_report?: ColonySummary;
  last_events?: SimEvent[];
}

export interface WorldState {
  schema: 'antempire.world-state.v3';
  sim_day: number;
  calendar_date: string;
  seed: number;
  climate: ClimateState;
  sources: Record<string, Source>;
  ecology: WorldEcology;
  colonies: ColonyState[];
  migration_log?: unknown[];
  rules_fingerprint?: unknown;
  active_signals?: unknown[];
  last_world_events?: SimEvent[];
}

export type SimEvent = { type: string; [k: string]: unknown };

export interface Weather {
  day: number; date: string; kind: string; wet: boolean;
  air_temp_c: number; daytime_air_temp_c: number; daily_max_air_temp_c: number; daily_min_air_temp_c: number;
  daytime_proxy_basis: string; nest_temp_model_c: number; relative_humidity_model_percent: number;
  rain_mm: number; soil_index: number; shade_index: number; temperature_anomaly_c: number; rain_probability_model: number;
}

export type Macro = 'sugar' | 'protein';
export type Task = 'forage' | 'nurse' | 'repair' | 'rest' | 'guard';

/** Per-colony daily summary. Key order matches the v6 engine summary exactly. */
export interface ColonySummary {
  day: number; date: string; weather: Weather;
  workers_before: number; brood_before: number; queen_alive_before: boolean;
  income: { sugar: number; protein: number };
  tasks: Record<Task, number>;
  foraging_trips: number; foraging_successes: number; scouts: number; recruited: number; extra_sugar_cost: number;
  foraging_workers_by_macro: { sugar: Set<string> | number; protein: Set<string> | number };
  worker_deaths: number; brood_deaths: number; hatchings: number; pupations: number; eclosions: number; eggs_laid: number;
  // Filled in later during the day (consume, brood, queen, final accounting), in this order:
  metabolic_factor: number; nurse_available: boolean;
  demand: { sugar: number; protein: number }; consumed: { sugar: number; protein: number }; ratios: { sugar: number; protein: number };
  development_factor: number; queen_laying_temperature_factor: number; queen_laying_probability_applied: number;
  population: { queen: number; workers: number; eggs: number; larvae: number; pupae: number };
  stock: { sugar: number; protein: number };
  starvation: { sugar_gap_days: number; protein_gap_days: number; stress_days: number };
  mass_ledger: Record<string, unknown>;
  [k: string]: unknown;
}

export interface Ratios { sFraction: number; pFraction: number }
