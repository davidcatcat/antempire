/**
 * Work package C1 (docs/design-wpc-food-compartments.md §3, §4, §7): food compartments and food_transfer records as
 * DIAGNOSTIC BOOKKEEPING over the engine's existing output. Nothing here is read by the simulation, and nothing in the
 * engine changes: it lives in cli/lib (not engine/), so the rules fingerprint and every golden output stay identical.
 * C2–C5 will move individual physiology into the engine behind switches; the record shapes are fixed here first so the
 * engine, the reports and the viewer share one structure.
 *
 * What the current engine (main, v2-review.19) physically locates, and what it does not:
 *  - sugar in each worker's crop (`crop:<worker>`) is located; the nest ledger `stores.sugar` INCLUDES those crops;
 *  - the remainder of the ledger (`nest_unlocated:<colony>` = ledger − Σ crops) is held by no individual. It is the F01
 *    abstraction (Issue #43): the engine has no physical place for it. The design has no liquid sugar store for this
 *    species (no replete evidence, #39), so in C2 this compartment must disappear;
 *  - protein at the nest is one cache (`cache:<nest>`), the only nest protein store the design keeps (until P1-B chambers);
 *  - metabolism, egg costs and storage overflow are taken from the AGGREGATE ledger: their transfers have no individual
 *    source (`source.kind = 'colony_ledger_aggregate'`, `individual_attribution: null`). That is F01/A08, recorded, not fixed.
 * Units: game portions (NOT mg); the design's exact integer unit is the micro-portion (10⁻⁶ portion), matching the
 * engine's six-decimal rounding.
 */
import type { ColonyState, SimEvent } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const MICRO_PER_PORTION = 1_000_000;
/** Game portions → integer micro-portions (the engine keeps six decimals, so this is exact up to float representation). */
export const toMicro = (portions: number): number => Math.round(portions * MICRO_PER_PORTION);

export type FoodType = 'sugar' | 'protein';
export type TransferCause = 'collect' | 'trophallaxis' | 'self_feed' | 'feed_larva' | 'feed_queen' | 'cache' | 'take_from_cache' | 'lay_egg' | 'metabolism' | 'death' | 'decay' | 'overflow' | 'unload';
export interface CompartmentRef { kind: 'source' | 'crop' | 'carried' | 'cache' | 'body' | 'egg' | 'corpse' | 'loss' | 'nest_unlocated' | 'colony_ledger_aggregate' | 'external'; id: string }
/** One transfer between two compartments (design §4). `minute` when the engine records a time; otherwise `phase`. */
export interface FoodTransfer {
  type: 'food_transfer'; day: number; minute?: number; phase?: 'foraging' | 'nest_settlement'; location: string;
  source: CompartmentRef; recipient: CompartmentRef; amount_microportions: number; food_type: FoodType; cause: TransferCause;
  /** null = the engine gives this transfer no individual source or recipient (F01/A08 abstraction). */
  individual_attribution: 'individual' | null;
  derived_from_event: string; contact_event_id?: string;
}
export type Compartments = Record<string, { sugar: number; protein: number }>;

/** The food a colony holds at one moment, by compartment, in micro-portions. Throws if the ledger is not covered. */
export function colonyCompartments(colony: ColonyState): Compartments {
  const out: Compartments = {};
  let crops = 0;
  for (const w of [...colony.population.workers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const s = toMicro(w.crop_cargo_sugar || 0);
    if (s < 0) throw Error(`compartments: negative crop ${w.id}`);
    if (s > 0) out[`crop:${w.id}`] = { sugar: s, protein: 0 };
    crops += s;
  }
  const ledgerSugar = toMicro(colony.stores.sugar), unlocated = ledgerSugar - crops;
  if (unlocated < 0) throw Error(`compartments: crops ${crops} µp exceed the sugar ledger ${ledgerSugar} µp (crops must be a subset of the ledger, v2-review.13)`);
  out[`nest_unlocated:${colony.id}`] = { sugar: unlocated, protein: 0 };
  out[`cache:${colony.nest_node}`] = { sugar: 0, protein: toMicro(colony.stores.protein) };
  return out;
}
export const totalOf = (c: Compartments, f: FoodType): number => Object.values(c).reduce((x, v) => x + v[f], 0);

/** food_transfer records derived from one colony-day of engine events and its summary (bookkeeping only). */
export function dayTransfers(events: SimEvent[], summary: Any, colony: { id: string; nest_node: string }, day: number): FoodTransfer[] {
  const out: FoodTransfer[] = [], nest = colony.nest_node;
  const t = (x: Omit<FoodTransfer, 'type' | 'day'>): void => { if (x.amount_microportions > 0) out.push({ type: 'food_transfer', day, ...x }); };
  const agg: CompartmentRef = { kind: 'colony_ledger_aggregate', id: colony.id };
  events.forEach((e: Any, i) => {
    const ref = `${e.type}#${i}`, time = typeof e.minute === 'number' ? { minute: e.minute } : { phase: 'foraging' as const };
    if (e.type === 'food_collected') {
      const f = e.macro as FoodType;
      t({ ...time, location: e.site, source: { kind: 'source', id: e.site }, recipient: { kind: f === 'sugar' ? 'crop' : 'carried', id: e.worker }, amount_microportions: toMicro(e.portions), food_type: f, cause: 'collect', individual_attribution: 'individual', derived_from_event: ref });
    } else if (e.type === 'food_delivered') {
      const f = e.macro as FoodType;
      // sugar arrives in the forager's own crop and enters the nest ledger; protein is cached at the nest
      if (f === 'protein') t({ ...time, location: nest, source: { kind: 'carried', id: e.worker }, recipient: { kind: 'cache', id: nest }, amount_microportions: toMicro(e.portions), food_type: f, cause: 'cache', individual_attribution: 'individual', derived_from_event: ref });
      else t({ ...time, location: nest, source: { kind: 'external', id: `in_transit:${e.worker}` }, recipient: { kind: 'crop', id: e.worker }, amount_microportions: toMicro(e.portions), food_type: f, cause: 'unload', individual_attribution: 'individual', derived_from_event: ref });
    } else if (e.type === 'trophallaxis') {
      t({ ...time, location: e.location ?? nest, source: { kind: 'crop', id: e.from }, recipient: { kind: 'crop', id: e.to }, amount_microportions: toMicro(e.portions), food_type: 'sugar', cause: 'trophallaxis', individual_attribution: 'individual', derived_from_event: ref, contact_event_id: ref });
    } else if (e.type === 'egg_laid') {
      for (const f of ['sugar', 'protein'] as const) t({ phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'egg', id: e.id }, amount_microportions: toMicro(e[`${f}_cost_portions`] ?? 0), food_type: f, cause: 'lay_egg', individual_attribution: null, derived_from_event: ref });
    }
  });
  const ledger = summary?.mass_ledger;
  if (ledger) for (const f of ['sugar', 'protein'] as const) {
    t({ phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'loss', id: 'metabolism' }, amount_microportions: toMicro(ledger.metabolized?.[f] ?? 0), food_type: f, cause: 'metabolism', individual_attribution: null, derived_from_event: 'summary.mass_ledger.metabolized' });
    t({ phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'loss', id: 'storage_overflow' }, amount_microportions: toMicro(ledger.storage_overflow_not_retained?.[f] ?? 0), food_type: f, cause: 'overflow', individual_attribution: null, derived_from_event: 'summary.mass_ledger.storage_overflow_not_retained' });
  }
  return out;
}

/** T3 (design §6) on the colony side, in exact integer micro-portions:
 *  held(end) = held(start) + delivered − metabolism − egg costs − overflow, for sugar and protein. */
export function colonyConservation(start: Compartments, end: Compartments, transfers: FoodTransfer[]): { ok: boolean; detail: Record<FoodType, { start: number; inflow: number; outflow: number; end: number; residual: number }> } {
  const detail = {} as Record<FoodType, { start: number; inflow: number; outflow: number; end: number; residual: number }>;
  for (const f of ['sugar', 'protein'] as const) {
    const of = transfers.filter((x) => x.food_type === f);
    const inflow = of.filter((x) => x.cause === 'unload' || x.cause === 'cache').reduce((a, x) => a + x.amount_microportions, 0);
    const outflow = of.filter((x) => x.source.kind === 'colony_ledger_aggregate').reduce((a, x) => a + x.amount_microportions, 0);
    const s = totalOf(start, f), e = totalOf(end, f);
    detail[f] = { start: s, inflow, outflow, end: e, residual: s + inflow - outflow - e };
  }
  return { ok: detail.sugar.residual === 0 && detail.protein.residual === 0, detail };
}
