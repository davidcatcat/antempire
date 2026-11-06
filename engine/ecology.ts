/**
 * World ecology: host plants, hemipteran groups, honeydew, nectar, carcass decay and tracked insect
 * populations. RULE (CLAUDE.md §2.2): this module receives only the world clock, world sources,
 * world insects, weather and world parameters — it has no access to any ant nest, so production can
 * never react to ant demand. Verified by tests/local-ecology.test.ts.
 *
 * v2-review.26 (Issue #80; switch source_flows.record_source_flows_v26, introduced OFF): every change of a source's food in
 * the ecology step is written as a `source_flow` world event with a cause, an origin and a destination, and the step checks
 * that the events close each source's stock. The stock arithmetic is NOT changed (conservative candidate): the switch only
 * names what the old clamp, expiry, washoff and decay did. Causes (all values game assumptions; mechanisms see
 * docs/design-source-flows-v26.md):
 *   secretion        producer:<hemipterans|flowers>:<site> -> source:<site>  (what enters the standing crop)
 *   rival_harvest    source -> consumer:background_rival:<id>               (existing background rivals, Issue #85)
 *   rain_washoff     source -> loss:rain_washoff
 *   capacity_runoff  source -> loss:capacity_runoff     (produced, not retained at the capacity; honeydew default)
 *   capacity_withheld   no origin, no destination, never_existed: true  (not secreted at the capacity; nectar default)
 *   decomposition    carcass batch -> loss:decomposition  (daily loss of edible protein; decomposers are NOT simulated)
 *   expired_remains  carcass batch -> loss:decomposition  (what was left when the batch passed its edible lifetime)
 * New remains keep their existing new_food_source event; ant collection and kills stay C2 food_transfer events.
 */
import { clamp, round } from './math.ts';
import { dice, type Rng } from './rng.ts';
import type { WorldParams } from './params.ts';
import type { SimEvent, Source, Weather, WorldEcology } from './types.ts';

interface EcologyInput { seed: number; sim_day: number; sources: Record<string, Source>; ecology: WorldEcology }

export const SOURCE_FLOW_CAUSES = ['secretion', 'rival_harvest', 'rain_washoff', 'capacity_runoff', 'capacity_withheld', 'decomposition', 'expired_remains'] as const;
export type SourceFlowCause = typeof SOURCE_FLOW_CAUSES[number];
const FLOW_BASIS: Record<SourceFlowCause, string> = {
  secretion: 'production by the site\'s existing hemipterans or flowers; mechanism and value are model assumptions',
  rival_harvest: 'taken by the background rival colony registered for this site (world parameter, Issue #85); not a simulated colony',
  rain_washoff: 'rain removes standing honeydew or nectar (mechanism: R183/R186, not this garden); value game assumption',
  capacity_runoff: 'produced but not retained above the standing-crop capacity (honeydew left unharvested accumulates and drips/falls, Way 1963, non-species); its consumers are not simulated',
  capacity_withheld: 'not secreted at the standing-crop capacity (nectar secretion/resorption regulate standing crop, Nepi & Stpiczyńska 2008, non-species); this quantity never existed',
  decomposition: 'edible protein lost to decomposition; the decomposer community is not simulated (game assumption)',
  expired_remains: 'remains past their edible lifetime leave the food pool by decomposition; the decomposer community is not simulated (game assumption)',
};
/** Collects one day's source flows when the v26 switch is on; null keeps the old code path (no event, no extra arithmetic). */
interface FlowLog { day: number; events: SimEvent[]; n: Map<string, number> }
const TOL_FLOW = 1e-5; // stocks are rounded to 1e-6 (engine/math.ts round)

function flow(log: FlowLog, site: string, food: 'sugar' | 'protein', cause: SourceFlowCause, portions: number, from: string | null, to: string | null, extra: Record<string, unknown> = {}): void {
  const p = round(portions);
  if (!(p > 0)) return;
  const k = (log.n.get(site) ?? 0) + 1; log.n.set(site, k);
  log.events.push({ type: 'source_flow', id: `SF-${log.day}-${site}-${k}`, day: log.day, site, food, cause, portions: p, from, to, ...extra, causal_basis: FLOW_BASIS[cause], assumption: true });
}

const CAUSES_BY_TYPE: Record<string, readonly SourceFlowCause[]> = {
  honeydew: ['secretion', 'rival_harvest', 'rain_washoff', 'capacity_runoff', 'capacity_withheld'],
  nectar: ['secretion', 'rain_washoff', 'capacity_runoff', 'capacity_withheld'],
  carcass: ['decomposition', 'expired_remains'],
};
/** The origin and destination a cause must have at a site (null = none); rival_harvest's consumer is checked by prefix. */
export function sourceFlowEnds(cause: SourceFlowCause, type: string, site: string): { from: string | null; to: string | null } {
  const src = 'source:' + site;
  switch (cause) {
    case 'secretion': return { from: `producer:${type === 'honeydew' ? 'hemipterans' : 'flowers'}:${site}`, to: src };
    case 'rival_harvest': return { from: src, to: 'consumer:background_rival:' };
    case 'rain_washoff': return { from: src, to: 'loss:rain_washoff' };
    case 'capacity_runoff': return { from: src, to: 'loss:capacity_runoff' };
    case 'capacity_withheld': return { from: null, to: null };
    default: return { from: src, to: 'loss:decomposition' };
  }
}

/**
 * Engine check (v26): the ecology step's source_flow events are well formed and close every source's stock:
 *   stock after the ecology step = stock before + Σ flows into source:<id> − Σ flows out of it (capacity_withheld excluded)
 * — no change without a flow, no flow counted twice (one flow per source, cause and carcass batch), each flow's origin and
 * destination fixed by its cause, the capacity interpretation the parameter chose. The values themselves are recomputed
 * from the parameters by the independent reader (cli/lib/source-flow-replay.ts), not here.
 */
export function checkSourceFlows(start: Record<string, { type: string; food: number; batches: string[] }>, after: Record<string, Source>, flows: SimEvent[], mode: { honeydew_withheld: boolean; nectar_withheld: boolean }, day: number): void {
  const fail = (m: string) => { throw Error('SOURCE_FLOW ' + m); };
  const net = new Map<string, number>(), seen = new Set<string>(), ids = new Set<string>();
  for (const f of flows as (SimEvent & Record<string, unknown>)[]) {
    const site = String(f.site), s0 = start[site], cause = f.cause as SourceFlowCause, p = f.portions as number;
    if (!s0) fail(`flow ${f.id}: no source ${site} before the day`);
    if (f.day !== day || typeof f.id !== 'string' || !f.id.startsWith(`SF-${day}-${site}-`) || ids.has(f.id)) fail(`flow ${f.id}: id/day not unique for day ${day}`);
    ids.add(String(f.id));
    if (!CAUSES_BY_TYPE[s0.type]?.includes(cause)) fail(`flow ${f.id}: cause ${f.cause} is not possible at a ${s0.type} source`);
    if (f.food !== (s0.type === 'carcass' ? 'protein' : 'sugar')) fail(`flow ${f.id}: ${f.food} at a ${s0.type} source`);
    if (!(typeof p === 'number' && Number.isFinite(p) && p > 0)) fail(`flow ${f.id}: portions ${p}`);
    const ends = sourceFlowEnds(cause, s0.type, site);
    const toOk = cause === 'rival_harvest' ? typeof f.to === 'string' && (f.to as string).startsWith(ends.to as string) : f.to === ends.to;
    if (f.from !== ends.from || !toOk) fail(`flow ${f.id}: ${f.from} -> ${f.to} is not the path of ${cause}`);
    if ((f.never_existed === true) !== (cause === 'capacity_withheld')) fail(`flow ${f.id}: never_existed must mark exactly capacity_withheld`);
    const withheld = s0.type === 'honeydew' ? mode.honeydew_withheld : mode.nectar_withheld;
    if (cause === 'capacity_withheld' && !withheld || cause === 'capacity_runoff' && withheld) fail(`flow ${f.id}: ${cause} contradicts the ${s0.type} capacity parameter`);
    const batch = f.batch_event_id === undefined ? '' : String(f.batch_event_id);
    if (s0.type === 'carcass' && !s0.batches.includes(batch)) fail(`flow ${f.id}: batch ${batch} did not exist at ${site} before the day`);
    const key = `${site}|${cause}|${batch}`;
    if (seen.has(key) || s0.type === 'carcass' && seen.has(`${site}|${cause === 'decomposition' ? 'expired_remains' : 'decomposition'}|${batch}`)) fail(`flow ${f.id}: ${key} counted twice`);
    seen.add(key);
    if (cause === 'capacity_withheld') continue;
    net.set(site, (net.get(site) ?? 0) + (f.to === 'source:' + site ? p : -p));
  }
  for (const [site, s0] of Object.entries(start)) {
    const end = sourceSum(after[site]);
    if (!(Math.abs(s0.food + (net.get(site) ?? 0) - end) <= TOL_FLOW)) fail(`${site}: ${s0.food} + flows ${round(net.get(site) ?? 0)} ≠ ${end} after the ecology step (a change without a flow, or a flow without a change)`);
  }
}

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

function decayCarcasses(w: EcologyInput, id: string, src: Source, wp: WorldParams, weather: Weather, log: FlowLog | null): void {
  const c = wp.carcasses;
  const frac = clamp(c.carcass_daily_decay_fraction + weather.rain_mm * c.carcass_rain_decay_bonus, 0, c.carcass_decay_max_daily_fraction);
  for (const batch of src.batches) {
    batch.age_days = w.sim_day + 1 - batch.original_day;
    const before = batch.protein;
    batch.protein = batch.age_days > c.carcass_max_lifetime_days ? 0 : round(batch.protein * (1 - frac));
    if (log) flow(log, id, 'protein', batch.age_days > c.carcass_max_lifetime_days ? 'expired_remains' : 'decomposition', before - batch.protein, 'source:' + id, 'loss:decomposition', { batch_event_id: batch.event_id, batch_age_days: batch.age_days });
  }
  syncSource(src);
}

function growHoneydew(id: string, src: Source, wp: WorldParams, weather: Weather, events: SimEvent[], g: Rng, log: FlowLog | null): void {
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
  const before = src.sugar, uncapped = src.sugar * (1 - wash) + net; src.sugar = round(clamp(uncapped, 0, src.capacity as number));
  if (log) {
    const excess = Math.max(0, uncapped - (src.capacity as number)), withheld = wp.source_flows.honeydew_capacity_limits_secretion;
    const rival = wp.background_rivals.find((r) => r.site === id);
    flow(log, id, 'sugar', 'secretion', gross - (withheld ? excess : 0), `producer:hemipterans:${id}`, 'source:' + id, { hemipteran_colonies: src.hemipteran_colonies, potential_portions: round(gross) });
    if (rival) flow(log, id, 'sugar', 'rival_harvest', gross * rivals, 'source:' + id, `consumer:background_rival:${rival.id}`, { harvest_fraction: rivals });
    flow(log, id, 'sugar', 'rain_washoff', before * wash, 'source:' + id, 'loss:rain_washoff', { rain_mm: weather.rain_mm });
    if (withheld) flow(log, id, 'sugar', 'capacity_withheld', excess, null, null, { never_existed: true, capacity: src.capacity });
    else flow(log, id, 'sugar', 'capacity_runoff', excess, 'source:' + id, 'loss:capacity_runoff', { capacity: src.capacity });
  }
  src.production_last_day = round(net); src.production_per_day = round(net);
  src.ecological_record = { host_plants: src.host_plants, hemipteran_kind: src.hemipteran_kind, hemipteran_colonies: src.hemipteran_colonies, gross_portions: round(gross), rival_share_portions: round(gross * rivals), rain_mm: weather.rain_mm, net_portions: round(net), stock_before: before, stock_after: src.sugar };
  syncSource(src);
}

function growNectar(id: string, src: Source, wp: WorldParams, weather: Weather, log: FlowLog | null): void {
  // Nectar has a flowering lifecycle, not a user-inserted sugar supply.
  const blooming = (src.bloom_days_left as number) > 0, wash = clamp(weather.rain_mm * wp.nectar.nectar_washoff_per_rain_mm, 0, wp.nectar.nectar_washoff_max_fraction);
  const before = src.sugar, production = blooming && src.host_alive !== false ? (src.production_per_day as number) : 0;
  const uncapped = src.sugar * (1 - wash) + production;
  src.sugar = round(clamp(uncapped, 0, src.capacity as number));
  if (log) {
    const excess = Math.max(0, uncapped - (src.capacity as number)), withheld = wp.source_flows.nectar_capacity_limits_secretion;
    flow(log, id, 'sugar', 'secretion', production - (withheld ? excess : 0), `producer:flowers:${id}`, 'source:' + id, { potential_portions: round(production) });
    flow(log, id, 'sugar', 'rain_washoff', before * wash, 'source:' + id, 'loss:rain_washoff', { rain_mm: weather.rain_mm });
    if (withheld) flow(log, id, 'sugar', 'capacity_withheld', excess, null, null, { never_existed: true, capacity: src.capacity });
    else flow(log, id, 'sugar', 'capacity_runoff', excess, 'source:' + id, 'loss:capacity_runoff', { capacity: src.capacity });
  }
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
  const sf = wp.source_flows, log: FlowLog | null = sf.record_source_flows_v26 ? { day: w.sim_day + 1, events: [], n: new Map() } : null;
  const start = log ? Object.fromEntries(Object.entries(w.sources).map(([id, s]) => [id, { type: s.type, food: sourceSum(s), batches: s.type === 'carcass' ? s.batches.map((b) => b.event_id) : [] }])) : null;
  for (const [id, src] of Object.entries(w.sources)) {
    if (src.type === 'carcass') { decayCarcasses(w, id, src, wp, weather, log); continue; }
    if (src.type === 'honeydew') { growHoneydew(id, src, wp, weather, events, g, log); continue; }
    growNectar(id, src, wp, weather, log);
  }
  if (log && start) { checkSourceFlows(start, w.sources, log.events, { honeydew_withheld: sf.honeydew_capacity_limits_secretion, nectar_withheld: sf.nectar_capacity_limits_secretion }, log.day); events.push(...log.events); }
  insectDemography(w, wp, weather, events);
}
