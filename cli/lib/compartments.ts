/**
 * Work package C1 (docs/design-wpc-food-compartments.md §3, §4, §7): food compartments, physical food_transfer
 * records and a replay that checks them COMPARTMENT BY COMPARTMENT. Diagnostic bookkeeping over the engine's existing
 * output: nothing here is read by the simulation, and it lives in cli/lib (not engine/), so the rules fingerprint and
 * every golden output are unchanged.
 *
 * Revised after Issue #49 N2 (Codex): the first version credited the same sugar to a forager's crop twice (at
 * collection AND at delivery) and its conservation check still passed, because it compared only ledger totals. Now:
 *  - each portion of food is in exactly one compartment at a time; a transfer moves it out of one and into another;
 *  - what the ENGINE physically does decides the path. collect() takes the load out of the source but does not change
 *    the worker's crop_cargo_sugar; the load travels with the trip (the forager's crop load / the solid carried in its
 *    mandibles) and is added to its crop, or cached, only at unloading (nutrition.handoff). So the path is
 *    source:<site> → in_transit:<worker> → crop:<worker> (sugar) or cache:<nest> (protein). in_transit is the load
 *    carried INSIDE the forager (crop) or in its mandibles; liquid stuck to the body surface is not modelled.
 *  - handoff() adds the load to the forager's crop BEFORE its trophallaxis, but logs food_delivered AFTER them; the
 *    unload transfer is placed before the trophallaxis of the same handoff (code order, engine/nutrition.ts handoff).
 *  - nest-ledger membership (food entering / leaving stores.sugar / stores.protein) is recorded SEPARATELY as
 *    LedgerEntry; it is accounting, not a physical move, and is never counted as a second income.
 *  - metabolism, egg costs and storage overflow are taken by the engine from the AGGREGATE ledger (settleCrops in
 *    worker-array order is an engine abstraction, Issue #43 F01/A08); they are recorded with attribution 'unknown'
 *    and checked only at pool level. A dead worker's crop sugar stays in the engine ledger (no corpse compartment yet,
 *    C5). These are reported, not hidden, and never given an invented source.
 * Two different results are therefore reported:
 *   physical_verified — every individual/located transfer replayed with source balance, no negative compartment,
 *     nothing left in transit, and each located compartment consistent with the snapshot;
 *   ledger_only — the pool and nest ledger close exactly, but the individual source of the unattributed use is unknown.
 * Units: game portions (NOT mg); exact integer micro-portions (10⁻⁶ portion), the engine's six-decimal resolution.
 */
import type { ColonyState, SimEvent } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const MICRO_PER_PORTION = 1_000_000;
/** Game portions → integer micro-portions (the engine keeps six decimals). */
export const toMicro = (portions: number): number => Math.round(portions * MICRO_PER_PORTION);

export type FoodType = 'sugar' | 'protein';
export type CompartmentKind = 'source' | 'in_transit' | 'crop' | 'cache' | 'nest_unlocated' | 'egg' | 'loss' | 'colony_ledger_aggregate' | 'external';
export interface CompartmentRef { kind: CompartmentKind; id: string }
export type TransferCause = 'collect' | 'unload' | 'trophallaxis' | 'metabolism' | 'lay_egg' | 'overflow' | 'death';
/** One physical move of food between two compartments (design §4). */
export interface FoodTransfer {
  type: 'food_transfer'; transfer_id: string; day: number; colony: string; minute: number | null; phase: 'foraging' | 'nest_settlement';
  location: string; source: CompartmentRef; recipient: CompartmentRef; food_type: FoodType; amount_microportions: number; cause: TransferCause;
  /** 'individual' = the engine names the individual source and recipient; 'unknown' = the engine takes it from the aggregate ledger. */
  attribution: 'individual' | 'unknown';
  /** Ids of the engine events that record this physical act (`E-<day>-<colony>-<index>`); one act may be logged by several events. */
  event_ids: string[];
  /** For trophallaxis: the engine logs the contact only as the trophallaxis event itself (no separate contact event). */
  contact_evidence?: 'trophallaxis_event_only';
  engine_note?: string;
}
/** Food entering or leaving the nest ledger (accounting boundary; NOT a physical transfer). */
export interface LedgerEntry { type: 'ledger_entry'; entry_id: string; day: number; colony: string; food_type: FoodType; amount_microportions: number; direction: 'in' | 'out'; reason: 'delivered' | 'metabolism' | 'lay_egg' | 'overflow'; event_ids: string[] }
export type Compartments = Record<string, { sugar: number; protein: number }>;
const key = (r: CompartmentRef) => `${r.kind}:${r.id}`;
/** Compartments whose content is tracked (others are outside the system: egg, loss, or the aggregate pseudo-source). */
const TRACKED = new Set<CompartmentKind>(['source', 'in_transit', 'crop', 'cache', 'nest_unlocated']);

/** The food a colony holds at a moment, by compartment (micro-portions). Throws if the ledger is not covered. */
export function colonyCompartments(colony: ColonyState): Compartments {
  const out: Compartments = {};
  let crops = 0;
  for (const w of [...colony.population.workers].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const s = toMicro(w.crop_cargo_sugar || 0);
    if (s < 0) throw Error(`compartments: negative crop ${w.id}`);
    out[`crop:${w.id}`] = { sugar: s, protein: 0 };
    crops += s;
  }
  const ledgerSugar = toMicro(colony.stores.sugar), unlocated = ledgerSugar - crops;
  if (unlocated < 0) throw Error(`compartments: crops ${crops} µp exceed the sugar ledger ${ledgerSugar} µp (crops must be a subset of the ledger, v2-review.13)`);
  out[`nest_unlocated:${colony.id}`] = { sugar: unlocated, protein: 0 };
  out[`cache:${colony.nest_node}`] = { sugar: 0, protein: toMicro(colony.stores.protein) };
  return out;
}
export const totalOf = (c: Compartments, f: FoodType, kinds?: CompartmentKind[]): number => Object.entries(c).filter(([k]) => !kinds || kinds.some((x) => k.startsWith(x + ':'))).reduce((x, [, v]) => x + v[f], 0);

/**
 * food_transfer records and ledger entries derived from ONE colony-day of engine events and its summary.
 * Transfer ids are global: FT-<day>-<colony>-<n>; event ids E-<day>-<colony>-<index in the colony's event list>.
 */
export function dayTransfers(events: SimEvent[], summary: Any, colony: { id: string; nest_node: string }, day: number): { transfers: FoodTransfer[]; ledger: LedgerEntry[] } {
  const transfers: FoodTransfer[] = [], ledger: LedgerEntry[] = [], nest = colony.nest_node;
  const eid = (i: number) => `E-${day}-${colony.id}-${i}`;
  const t = (x: Omit<FoodTransfer, 'type' | 'transfer_id' | 'day' | 'colony'>) => { if (x.amount_microportions > 0) transfers.push({ type: 'food_transfer', transfer_id: `FT-${day}-${colony.id}-${transfers.length + 1}`, day, colony: colony.id, ...x }); };
  const l = (x: Omit<LedgerEntry, 'type' | 'entry_id' | 'day' | 'colony'>) => { if (x.amount_microportions > 0) ledger.push({ type: 'ledger_entry', entry_id: `LE-${day}-${colony.id}-${ledger.length + 1}`, day, colony: colony.id, ...x }); };
  const ev = events as Any[];
  // place each sugar unload before the trophallaxis events of the same handoff (logged immediately before it)
  const order: number[] = [];
  const unloadFirst = new Map<number, number>(); // index of first trophallaxis of the run -> index of its food_delivered
  for (let i = 0; i < ev.length; i++) {
    if (ev[i].type !== 'food_delivered' || ev[i].macro !== 'sugar') continue;
    let j = i; while (j > 0 && ev[j - 1].type === 'trophallaxis' && ev[j - 1].from === ev[i].worker) j--;
    if (j < i) unloadFirst.set(j, i);
  }
  const moved = new Set(unloadFirst.values());
  for (let i = 0; i < ev.length; i++) { if (unloadFirst.has(i)) order.push(unloadFirst.get(i) as number); if (!moved.has(i)) order.push(i); }
  for (const i of order) {
    const e = ev[i], minute = typeof e.minute === 'number' ? e.minute : null;
    if (e.type === 'food_collected') {
      t({ minute, phase: 'foraging', location: e.site, source: { kind: 'source', id: e.site }, recipient: { kind: 'in_transit', id: e.worker }, food_type: e.macro, amount_microportions: toMicro(e.portions), cause: 'collect', attribution: 'individual', event_ids: [eid(i)] });
    } else if (e.type === 'food_delivered') {
      const f = e.macro as FoodType, cached = f === 'protein' ? ev.findIndex((x, k) => k < i && x.type === 'protein_cached_at_nest' && x.worker === e.worker && x.portions === e.portions && !ev.slice(k + 1, i).some((y) => y.type === 'food_delivered' && y.worker === e.worker)) : -1;
      t({ minute, phase: 'foraging', location: nest, source: { kind: 'in_transit', id: e.worker }, recipient: f === 'sugar' ? { kind: 'crop', id: e.worker } : { kind: 'cache', id: nest }, food_type: f, amount_microportions: toMicro(e.portions), cause: 'unload', attribution: 'individual', event_ids: cached >= 0 ? [eid(cached), eid(i)] : [eid(i)] });
      l({ food_type: f, amount_microportions: toMicro(e.portions), direction: 'in', reason: 'delivered', event_ids: [eid(i)] });
    } else if (e.type === 'trophallaxis') {
      t({ minute, phase: 'foraging', location: e.location ?? nest, source: { kind: 'crop', id: e.from }, recipient: { kind: 'crop', id: e.to }, food_type: 'sugar', amount_microportions: toMicro(e.portions), cause: 'trophallaxis', attribution: 'individual', event_ids: [eid(i)], contact_evidence: 'trophallaxis_event_only' });
    }
  }
  // nest settlement (after foraging, engine day order): aggregate use, attribution unknown
  const agg: CompartmentRef = { kind: 'colony_ledger_aggregate', id: colony.id };
  const ml = summary?.mass_ledger;
  for (const f of ['sugar', 'protein'] as const) {
    const over = toMicro(ml?.storage_overflow_not_retained?.[f] ?? 0), met = toMicro(ml?.metabolized?.[f] ?? 0);
    t({ minute: null, phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'loss', id: 'storage_overflow' }, food_type: f, amount_microportions: over, cause: 'overflow', attribution: 'unknown', event_ids: ['summary.mass_ledger.storage_overflow_not_retained'] });
    l({ food_type: f, amount_microportions: over, direction: 'out', reason: 'overflow', event_ids: ['summary.mass_ledger.storage_overflow_not_retained'] });
    t({ minute: null, phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'loss', id: 'metabolism' }, food_type: f, amount_microportions: met, cause: 'metabolism', attribution: 'unknown', event_ids: ['summary.mass_ledger.metabolized'] });
    l({ food_type: f, amount_microportions: met, direction: 'out', reason: 'metabolism', event_ids: ['summary.mass_ledger.metabolized'] });
  }
  ev.forEach((e, i) => {
    if (e.type !== 'egg_laid') return;
    for (const f of ['sugar', 'protein'] as const) {
      const a = toMicro(e[`${f}_cost_portions`] ?? 0);
      t({ minute: null, phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'egg', id: e.id }, food_type: f, amount_microportions: a, cause: 'lay_egg', attribution: 'unknown', event_ids: [eid(i)] });
      l({ food_type: f, amount_microportions: a, direction: 'out', reason: 'lay_egg', event_ids: [eid(i)] });
    }
  });
  return { transfers, ledger };
}

export interface ReplayResult {
  physical_verified: boolean; ledger_only_closed: boolean; errors: string[];
  /** Food the engine took from the aggregate ledger with no individual source (F01/A08), per food type. */
  unattributed: Record<FoodType, number>;
  /** Located compartments whose snapshot is lower than the physical replay: the share of the unattributed use the engine took from them. */
  unattributed_by_compartment: Record<string, Record<FoodType, number>>;
  /** Crops of workers that died (their sugar stays in the engine's nest ledger: engine abstraction until C5). */
  dead_worker_crops_to_ledger: string[];
  replayed: Compartments;
}

/**
 * Replays transfers from the START compartments, one by one, and checks them against the END snapshot.
 *  - every transfer from a tracked compartment needs that compartment to hold the amount at that moment; no tracked
 *    compartment may become negative; a transfer id may be applied only once;
 *  - after the foraging phase nothing may be left in transit unless the end snapshot carries it (carried into the next day);
 *  - unattributed (aggregate) use is checked against the nest pool (crops + unlocated sugar; cache protein) only;
 *  - at the end: transit and source compartments must equal the snapshot exactly; each crop / unlocated compartment may
 *    only be lower than the replay (the engine's unattributed settlement takes from them, or a dead worker's crop is gone),
 *    and the pool and the nest ledger must close exactly.
 * `sources`: give the source compartments in `start`/`end` to check them too (synthetic tests); for real engine days
 * source production by the ecology module is not evented, so sources are not balance-checked (reported).
 */
export function replayTransfers(start: Compartments, transfers: FoodTransfer[], ledger: LedgerEntry[], end: Compartments, opts: { nest: string; colony: string; ledgerStart: Record<FoodType, number>; ledgerEnd: Record<FoodType, number>; checkSources?: boolean }): ReplayResult {
  const cur: Compartments = structuredClone(start), errors: string[] = [], seen = new Set<string>();
  const unattributed = { sugar: 0, protein: 0 };
  const get = (k: string) => (cur[k] ??= { sugar: 0, protein: 0 });
  const isTracked = (r: CompartmentRef) => TRACKED.has(r.kind) && (r.kind !== 'source' || !!opts.checkSources);
  /** The nest pool the engine's aggregate ledger draws from: crops + unlocated sugar; the protein cache. */
  const pool = (f: FoodType) => Object.entries(cur).filter(([k]) => (f === 'sugar' ? k.startsWith('crop:') || k.startsWith('nest_unlocated:') : k.startsWith('cache:'))).reduce((x, [, v]) => x + v[f], 0);
  let phase: 'foraging' | 'nest_settlement' = 'foraging';
  const endOfForaging = () => {
    for (const [k, v] of Object.entries(cur)) if (k.startsWith('in_transit:')) for (const f of ['sugar', 'protein'] as const) if (v[f] !== (end[k]?.[f] ?? 0)) errors.push(`${k}: ${v[f]} µp ${f} still in transit after foraging with no recipient (carrier died, unloading missing, or a collection logged twice)`);
  };
  for (const x of transfers) {
    if (seen.has(x.transfer_id)) { errors.push(`${x.transfer_id}: applied twice`); continue; }
    seen.add(x.transfer_id);
    if (x.phase === 'nest_settlement' && phase === 'foraging') { endOfForaging(); phase = 'nest_settlement'; }
    if (x.amount_microportions <= 0 || !Number.isInteger(x.amount_microportions)) { errors.push(`${x.transfer_id}: amount ${x.amount_microportions} is not a positive integer`); continue; }
    if (x.cause === 'trophallaxis' && x.food_type !== 'sugar') { errors.push(`${x.transfer_id}: trophallaxis of ${x.food_type}`); continue; }
    if (x.cause === 'trophallaxis' && x.location !== opts.nest) { errors.push(`${x.transfer_id}: trophallaxis at ${x.location}, not where both workers are (the nest)`); continue; }
    if (x.source.kind === 'colony_ledger_aggregate') {
      // unattributed: only the pool as a whole can be checked
      if (pool(x.food_type) - unattributed[x.food_type] < x.amount_microportions) errors.push(`${x.transfer_id}: unattributed ${x.cause} ${x.amount_microportions} µp ${x.food_type} exceeds the nest pool`);
      unattributed[x.food_type] += x.amount_microportions;
    } else if (isTracked(x.source)) {
      const s = get(key(x.source));
      if (s[x.food_type] < x.amount_microportions) { errors.push(`${x.transfer_id}: ${key(x.source)} holds ${s[x.food_type]} µp ${x.food_type}, cannot give ${x.amount_microportions}`); continue; }
      s[x.food_type] -= x.amount_microportions;
    }
    if (isTracked(x.recipient)) get(key(x.recipient))[x.food_type] += x.amount_microportions;
  }
  if (phase === 'foraging') endOfForaging();
  const byComp: Record<string, Record<FoodType, number>> = {};
  // A worker that died during settlement is absent from the end snapshot; the engine keeps its crop sugar in the nest
  // ledger (no corpse compartment yet, C5), so it joins the unlocated pool for the comparison (reported, not hidden).
  const unl = `nest_unlocated:${opts.colony}`, deadCrops: string[] = [];
  for (const k of Object.keys(cur)) if (k.startsWith('crop:') && !(k in end)) { deadCrops.push(k); get(unl).sugar += cur[k].sugar; cur[k].sugar = 0; }
  for (const k of new Set([...Object.keys(cur), ...Object.keys(end)])) {
    if (k.startsWith('source:') && !opts.checkSources) continue;
    for (const f of ['sugar', 'protein'] as const) {
      const r = cur[k]?.[f] ?? 0, e = end[k]?.[f] ?? 0;
      if (r < 0) errors.push(`${k}: negative ${f} ${r}`);
      if (k.startsWith('in_transit:') || k.startsWith('source:')) { if (r !== e) errors.push(`${k}: replay ${r} µp ${f} ≠ snapshot ${e}`); continue; }
      if (e > r) errors.push(`${k}: snapshot ${e} µp ${f} exceeds the replay ${r} (food appeared without a transfer)`);
      else if (e < r) ((byComp[k] ??= { sugar: 0, protein: 0 })[f] = r - e);
    }
  }
  for (const f of ['sugar', 'protein'] as const) {
    const removed = Object.values(byComp).reduce((x, v) => x + v[f], 0);
    if (removed !== unattributed[f]) errors.push(`pool ${f}: snapshots are ${removed} µp below the replay but the unattributed use is ${unattributed[f]} µp`);
  }
  const ledgerOk = (['sugar', 'protein'] as const).every((f) => opts.ledgerStart[f] + ledger.filter((x) => x.food_type === f && x.direction === 'in').reduce((a, x) => a + x.amount_microportions, 0) - ledger.filter((x) => x.food_type === f && x.direction === 'out').reduce((a, x) => a + x.amount_microportions, 0) === opts.ledgerEnd[f]);
  if (!ledgerOk) errors.push('nest ledger does not close: start + delivered − used ≠ end');
  const physical = errors.length === 0;
  return { physical_verified: physical, ledger_only_closed: ledgerOk, errors, unattributed, unattributed_by_compartment: byComp, dead_worker_crops_to_ledger: deadCrops, replayed: cur };
}

/** Convenience: replay one engine colony-day from its start state, events, summary and end state. */
export function replayColonyDay(startColony: ColonyState, endColony: ColonyState, events: SimEvent[], summary: Any, day: number): ReplayResult & { transfers: FoodTransfer[]; ledger: LedgerEntry[] } {
  const { transfers, ledger } = dayTransfers(events, summary, endColony, day);
  const start = colonyCompartments(startColony), end = colonyCompartments(endColony);
  const r = replayTransfers(start, transfers, ledger, end, { nest: endColony.nest_node, colony: endColony.id, ledgerStart: { sugar: toMicro(startColony.stores.sugar), protein: toMicro(startColony.stores.protein) }, ledgerEnd: { sugar: toMicro(endColony.stores.sugar), protein: toMicro(endColony.stores.protein) } });
  return { ...r, transfers, ledger };
}
