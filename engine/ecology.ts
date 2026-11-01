/**
 * World ecology: host plants, hemipteran groups, honeydew, nectar, carcass decay and tracked insect
 * populations. RULE (CLAUDE.md §2.2): this module receives only the world clock, world sources,
 * world insects, weather and world parameters — it has no access to any ant nest, so production can
 * never react to ant demand. Verified by tests/local-ecology.test.ts.
 */
import { clamp, round } from './math.ts';
import { dice, type Rng } from './rng.ts';
import type { WorldParams } from './params.ts';
import type { SimEvent, Source, Weather, WorldEcology } from './types.ts';

interface EcologyInput { seed: number; sim_day: number; sources: Record<string, Source>; ecology: WorldEcology }

export function sourceSum(src: Source): number {
  if (src.type === 'carcass') return round(src.batches.reduce((t, x) => t + x.protein, 0));
  return src.sugar;
}

export function syncSource(src: Source): void {
  if (src.type === 'carcass') { src.protein = sourceSum(src); } else src.protein = 0;
  src.sugar = round(src.sugar || 0);
}

export function insectBirthFactor(wp: WorldParams, weather: Weather): number {
  const i = wp.insects;
  return clamp(1 + (weather.air_temp_c - i.insect_reproduction_reference_c) * i.insect_reproduction_per_degree_c, i.insect_reproduction_min_multiplier, i.insect_reproduction_max_multiplier);
}

function logisticBirths(wp: WorldParams, weather: Weather, events: SimEvent[], site: string, living: number, capacity: number, rate: number, g: Rng): number {
  const prob = clamp(rate * insectBirthFactor(wp, weather) * (1 - living / Math.max(1, capacity)), 0, 1);
  let births = 0;
  for (let i = 0; i < living && births < Math.max(0, capacity - living); i++) if (g() < prob) births++;
  if (births) events.push({ type: 'insect_population_birth', site, individuals: births, population_before: living, population_after: living + births, local_capacity: capacity, temperature_c: weather.air_temp_c, causal_basis: 'natural density-limited reproduction independent of ant diet', assumption: true });
  return births;
}

/** Fraction of a site's honeydew taken by background (non-simulated) rival colonies. */
function rivalShare(wp: WorldParams, siteId: string): number {
  const rival = wp.background_rivals.find((r) => r.site === siteId);
  return rival ? rival.honeydew_harvest_fraction : 0;
}

function decayCarcasses(w: EcologyInput, src: Source, wp: WorldParams, weather: Weather): void {
  const c = wp.carcasses;
  const frac = clamp(c.carcass_daily_decay_fraction + weather.rain_mm * c.carcass_rain_decay_bonus, 0, c.carcass_decay_max_daily_fraction);
  for (const batch of src.batches) {
    batch.age_days = w.sim_day + 1 - batch.original_day;
    batch.protein = batch.age_days > c.carcass_max_lifetime_days ? 0 : round(batch.protein * (1 - frac));
  }
  syncSource(src);
}

function growHoneydew(id: string, src: Source, wp: WorldParams, weather: Weather, events: SimEvent[], g: Rng): void {
  const h = wp.hemipterans;
  // ALL production is environmental. No ant count, ant demand, or nest sugar balance is consulted.
  src.host_plants ??= 0; src.hemipteran_colonies ??= 0;
  if (src.host_plants > 0 && src.host_alive && g() < wp.plants.host_plant_daily_death_probability) {
    src.host_plants--; events.push({ type: 'host_plant_death', site: id, hosts_remaining: src.host_plants, causal_basis: 'natural garden host mortality assumption' });
  }
  src.host_alive = src.host_plants > 0 && src.host_alive !== false;
  if (src.host_alive) {
    if (src.hemipteran_colonies > 0 && g() < h.hemipteran_colony_daily_collapse_probability) { src.hemipteran_colonies--; events.push({ type: 'hemipteran_colony_change', site: id, delta: -1, remaining: src.hemipteran_colonies, causal_basis: 'background insect colony collapse' }); }
    if (src.hemipteran_colonies < src.host_plants * h.max_hemipteran_colonies_per_host && g() < h.hemipteran_colony_daily_growth_probability) { src.hemipteran_colonies++; events.push({ type: 'hemipteran_colony_change', site: id, delta: 1, remaining: src.hemipteran_colonies, causal_basis: 'reproduction within living host plant carrying capacity' }); }
  } else src.hemipteran_colonies = 0;
  const kind = src.hemipteran_kind ?? '';
  const groupRate = h.honeydew_per_colony_per_day[kind];
  if (groupRate === undefined) throw Error(`Unknown hemipteran_kind ${kind} at ${id}: add hemipterans.honeydew_per_colony_per_day.${kind}`);
  const rainFactor = clamp(1 - weather.rain_mm * h.rain_honeydew_secretion_suppression_per_mm, h.honeydew_rain_secretion_min_multiplier, 1);
  const gross = src.host_alive ? src.hemipteran_colonies * groupRate * h.honeydew_productivity_multiplier * rainFactor : 0;
  const rivals = rivalShare(wp, id);
  const net = gross * (1 - rivals);
  const wash = clamp(weather.rain_mm * wp.honeydew.honeydew_washoff_per_rain_mm, 0, wp.honeydew.honeydew_washoff_max_fraction);
  const before = src.sugar; src.sugar = round(clamp(src.sugar * (1 - wash) + net, 0, src.capacity as number));
  src.production_last_day = round(net); src.production_per_day = round(net);
  src.ecological_record = { host_plants: src.host_plants, hemipteran_kind: src.hemipteran_kind, hemipteran_colonies: src.hemipteran_colonies, gross_portions: round(gross), rival_share_portions: round(gross * rivals), rain_mm: weather.rain_mm, net_portions: round(net), stock_before: before, stock_after: src.sugar };
  syncSource(src);
}

function growNectar(src: Source, wp: WorldParams, weather: Weather): void {
  // Nectar has a flowering lifecycle, not a user-inserted sugar supply.
  const blooming = (src.bloom_days_left as number) > 0, wash = clamp(weather.rain_mm * wp.nectar.nectar_washoff_per_rain_mm, 0, wp.nectar.nectar_washoff_max_fraction);
  const before = src.sugar, production = blooming && src.host_alive !== false ? (src.production_per_day as number) : 0;
  src.sugar = round(clamp(src.sugar * (1 - wash) + production, 0, src.capacity as number));
  src.bloom_days_left = Math.max(0, (src.bloom_days_left as number) - 1);
  src.production_last_day = round(production); src.ecological_record = { bloom_days_left: src.bloom_days_left, rain_mm: weather.rain_mm, production_portions: production, stock_before: before, stock_after: src.sugar }; syncSource(src);
}

/** Track living insects in the adjacent habitat and at carcass sites; deaths create carcasses with IDs. */
function insectDemography(w: EcologyInput, wp: WorldParams, weather: Weather, events: SimEvent[]): void {
  const i = wp.insects, c = wp.carcasses;
  const neighborSite = 'adjacent_garden_habitat', gn = dice(w, 'insect_demography:' + neighborSite);
  const neighborK = i.insect_boundary_carrying_capacity;
  let neighbor = w.ecology.adjacent_garden_living_insects, neighborDeaths = 0;
  for (let k = 0, n = neighbor; k < n; k++) if (gn() < i.insect_boundary_per_capita_daily_death_probability) neighborDeaths++;
  neighbor -= neighborDeaths;
  if (neighborDeaths) events.push({ type: 'insect_background_death', site: neighborSite, individuals: neighborDeaths, population_after: neighbor, causal_basis: 'natural death outside harvested garden', assumption: true });
  neighbor += logisticBirths(wp, weather, events, neighborSite, neighbor, neighborK, i.insect_boundary_logistic_daily_birth_rate, gn);
  w.ecology.adjacent_garden_living_insects = neighbor;
  for (const site of Object.keys(w.ecology.insects_by_site).sort()) {
    const pop = w.ecology.insects_by_site[site], g = dice(w, 'insect_demography:' + site);
    const localK = pop.carrying_capacity ?? i.insect_local_carrying_capacity;
    const mortality = 1 - Math.pow(1 - i.insect_local_daily_mortality_probability, pop.living / Math.max(1, i.insect_local_death_reference_population));
    if (pop.living > 0 && g() < mortality) {
      const before = pop.living; pop.living--; pop.cumulative_deaths++;
      const quantity = round(c.carcass_new_protein_min + g() * (c.carcass_new_protein_max - c.carcass_new_protein_min));
      const id = 'NAT-D' + (w.sim_day + 1) + '-' + site + '-' + pop.cumulative_deaths;
      w.sources[site].batches.push({ event_id: id, original_day: w.sim_day + 1, protein: quantity, age_days: 0, origin: 'tracked local mortality and portion estimate', insect_population_before: before, insect_population_after: pop.living }); syncSource(w.sources[site]);
      events.push({ type: 'insect_natural_death', site, event_id: id, insect_count_before: before, insect_count_after: pop.living, causal_basis: 'natural death of existing tracked insect' });
      events.push({ type: 'new_food_source', id, site, protein_portions: quantity, caused_by_event_id: id, causal_basis: 'physical remains after recorded natural insect death', assumption: true });
    }
    pop.living += logisticBirths(wp, weather, events, site, pop.living, localK, i.insect_site_logistic_daily_birth_rate, g);
    if (w.ecology.adjacent_garden_living_insects > 0 && pop.living < localK && g() < i.insect_background_immigration_probability) {
      w.ecology.adjacent_garden_living_insects--; pop.living++;
      events.push({ type: 'insect_immigration', site, from: neighborSite, individuals: 1, adjacent_population_after: w.ecology.adjacent_garden_living_insects, causal_basis: 'physical transfer from tracked neighboring habitat', assumption: true });
    }
  }
}

/** One day of independent garden ecology. Mutates w.sources and w.ecology. */
export function growEcology(w: EcologyInput, wp: WorldParams, weather: Weather, events: SimEvent[]): void {
  const g = dice(w, 'ecology');
  for (const [id, src] of Object.entries(w.sources)) {
    if (src.type === 'carcass') { decayCarcasses(w, src, wp, weather); continue; }
    if (src.type === 'honeydew') { growHoneydew(id, src, wp, weather, events, g); continue; }
    growNectar(src, wp, weather);
  }
  insectDemography(w, wp, weather, events);
}
