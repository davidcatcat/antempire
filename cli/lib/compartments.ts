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
 *  - metabolism, egg costs and storage overflow are taken by the engine from the AGGREGATE ledger (Issue #43 F01/A08);
 *    they carry attribution 'unknown' and are replayed with the engine's own deterministic rule (settleCrops: crops in
 *    worker-array order, then the unlocated nest sugar), never given an invented individual source;
 *  - a dead worker's crop sugar stays in the engine ledger (no corpse compartment until C5): attribution 'engine_rule'.
 * The replay then requires EVERY compartment of the end snapshot to equal the replay exactly.
 * KNOWN LIMIT (independent reviews of a80b92e, cce69a1, b9e52b4): the engine gives only start-of-day and end-of-day
 * states. The settlement takes sugar from crops in array order and every crop it empties ends at 0; a dead worker's crop
 * leaves the snapshot. A misrouted or MISSING trophallaxis can then end in the same state as the record, so it goes
 * undetected from cli/ alone. This is possible ONLY on a day where the replay's settlement passes over a crop that ends
 * at 0, or a worker dies: otherwise every settlement draw stopped at the first crop in the order, whose content the end
 * state then fixes, and every other crop was untouched. `evidence_limited_compartments` lists those crops as a DAY
 * MARKER (non-empty = the day's trophallaxis records cannot be fully checked). It is NOT the list of crops that may
 * differ: the crop where the settlement stopped, or one it never reached in the replay, can differ too. Consumers must
 * only test it for non-empty. Full checking needs engine-side transfer events (C2).
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
  /** 'individual' = the engine names the individual source and recipient; 'unknown' = the engine takes it from the aggregate
   *  ledger; 'engine_rule' = an engine bookkeeping rule, not an individual act (a dead worker's crop kept in the ledger). */
  attribution: 'individual' | 'unknown' | 'engine_rule';
  /** Ids of the engine events that record this physical act (`E-<day>-<colony>-<index>`); one act may be logged by several events. */
  event_ids: string[];
  /** For trophallaxis: the engine logs the contact only as the trophallaxis event itself (no separate contact event). */
  contact_evidence?: 'trophallaxis_event_only';
  /** 'all_held': the amount is whatever the source holds when the replay reaches it (worker death). */
  amount_rule?: 'all_held';
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
  // Nest settlement, in the ENGINE's day order (engine/day.ts): storage overflow, metabolism, [brood], worker deaths,
  // [queen], egg laying. Overflow, metabolism and eggs come from the aggregate ledger (attribution unknown); the engine
  // removes their sugar from crops in worker-array order and the rest from the unlocated nest sugar (settleCrops), and
  // the replay applies exactly that rule. A dead worker's remaining crop sugar stays in the engine ledger.
  const agg: CompartmentRef = { kind: 'colony_ledger_aggregate', id: colony.id };
  const ml = summary?.mass_ledger;
  const settle = (cause: 'overflow' | 'metabolism', key: 'storage_overflow_not_retained' | 'metabolized', lossId: string) => {
    for (const f of ['sugar', 'protein'] as const) {
      const a = toMicro(ml?.[key]?.[f] ?? 0);
      t({ minute: null, phase: 'nest_settlement', location: nest, source: agg, recipient: { kind: 'loss', id: lossId }, food_type: f, amount_microportions: a, cause, attribution: 'unknown', event_ids: [`summary.mass_ledger.${key}`] });
      l({ food_type: f, amount_microportions: a, direction: 'out', reason: cause, event_ids: [`summary.mass_ledger.${key}`] });
    }
  };
  settle('overflow', 'storage_overflow_not_retained', 'storage_overflow');
  settle('metabolism', 'metabolized', 'metabolism');
  ev.forEach((e, i) => {
    if (e.type !== 'worker_death') return;
    // amount resolved by the replay: whatever the dead worker's crop holds at that moment (it stays in the nest ledger)
    transfers.push({ type: 'food_transfer', transfer_id: `FT-${day}-${colony.id}-${transfers.length + 1}`, day, colony: colony.id, minute: null, phase: 'nest_settlement', location: nest, source: { kind: 'crop', id: e.id }, recipient: { kind: 'nest_unlocated', id: colony.id }, food_type: 'sugar', amount_microportions: 0, amount_rule: 'all_held', cause: 'death', attribution: 'engine_rule', event_ids: [eid(i)], engine_note: 'engine abstraction until C5: a dead worker keeps no corpse compartment; its crop sugar stays in the nest ledger' });
  });
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
  /** Every transfer replayed with source balance and no negative compartment, the nest settlement replayed with the
   *  engine's own rule, and EVERY compartment of the end snapshot equal to the replay. */
  physical_verified: boolean;
  /** The nest ledger closes: start + delivered − used = end (accounting only). */
  ledger_only_closed: boolean;
  errors: string[];
  /** Food the engine took from the aggregate ledger with no individual source (F01/A08), per food type. */
  unattributed: Record<FoodType, number>;
  /** Where the engine's settlement rule took that unattributed food from (crops in worker-array order, then unlocated). */
  unattributed_by_compartment: Record<string, Record<FoodType, number>>;
  /** Engine abstractions this day relied on (they are not individual physiology): reported, never hidden. */
  engine_abstractions_used: string[];
  /** Crops of workers that died; their sugar stayed in the nest ledger (no corpse compartment until C5). */
  dead_worker_crops_to_ledger: string[];
  /** DAY MARKER: crops the replay's settlement passed over that end at 0, and dead workers' crops. Non-empty = the day's
   *  trophallaxis records cannot be fully checked from start/end states (KNOWN LIMIT). Not the set of crops that may
   *  differ (the settlement's stop crop can differ too): test it for non-empty only. */
  evidence_limited_compartments: string[];
  /** Whether source compartments were balance-checked (false for real engine days: ecology production is not evented). */
  sources_checked: boolean;
  /** Transfers with amounts resolved by the replay (deaths). */
  resolved: FoodTransfer[];
  replayed: Compartments;
}

/**
 * Replays transfers from the START compartments, one by one, and requires the END snapshot to equal the replay in EVERY
 * compartment (Issue #49 N2; independent review of f7aba02: an upper-bound check let settlement hide a missing or
 * misrouted transfer).
 *  - a transfer from a tracked compartment needs that compartment to hold the amount at that moment; no compartment may
 *    become negative; a transfer id may be applied only once; only located compartments or the aggregate ledger may be
 *    a source (never 'external', 'egg' or 'loss');
 *  - trophallaxis happens at the nest, between two workers not carrying a load outside (in_transit = 0);
 *  - after foraging nothing may be left in transit unless the end snapshot carries it;
 *  - nest settlement (attribution unknown) is applied with the engine's rule: crops in `workerOrder` (the engine's
 *    worker array at the start of the day), then the unlocated nest sugar; protein from the cache; a death moves the
 *    worker's remaining crop to the unlocated nest sugar and removes it from the order;
 *  - the transfers must agree with the ledger entries (unloads = 'in', aggregate use = 'out'), and the ledger must close.
 * `checkSources`: balance-check source compartments too (synthetic tests). On real engine days ecology production is
 * not evented, so sources are not checked (`sources_checked: false`).
 */
export function replayTransfers(start: Compartments, transfers: FoodTransfer[], ledger: LedgerEntry[], end: Compartments, opts: { nest: string; colony: string; workerOrder: string[]; ledgerStart: Record<FoodType, number>; ledgerEnd: Record<FoodType, number>; checkSources?: boolean; eggSettlesCrops?: boolean }): ReplayResult {
  const cur: Compartments = structuredClone(start), errors: string[] = [], seen = new Set<string>(), resolved: FoodTransfer[] = [];
  const unattributed = { sugar: 0, protein: 0 }, byComp: Record<string, Record<FoodType, number>> = {}, abstractions = new Set<string>(), deadCrops: string[] = [];
  const order = [...opts.workerOrder], unl = `nest_unlocated:${opts.colony}`, cache = `cache:${opts.nest}`;
  const get = (k: string) => (cur[k] ??= { sugar: 0, protein: 0 });
  const isTracked = (r: CompartmentRef) => TRACKED.has(r.kind) && (r.kind !== 'source' || !!opts.checkSources);
  const take = (k: string, f: FoodType, a: number) => { get(k)[f] -= a; ((byComp[k] ??= { sugar: 0, protein: 0 })[f] += a); };
  let phase: 'foraging' | 'nest_settlement' = 'foraging';
  const limited: string[] = [], scanned = new Set<string>(), died = new Set<string>();
  const endOfForaging = () => {
    for (const [k, v] of Object.entries(cur)) if (k.startsWith('in_transit:')) for (const f of ['sugar', 'protein'] as const) if (v[f] !== (end[k]?.[f] ?? 0)) errors.push(`${k}: ${v[f]} µp ${f} still in transit after foraging with no recipient (carrier died, unloading missing, or a collection logged twice)`);
  };
  for (const x0 of transfers) {
    const x = { ...x0 };
    if (seen.has(x.transfer_id)) { errors.push(`${x.transfer_id}: applied twice`); continue; }
    seen.add(x.transfer_id);
    if (x.phase === 'nest_settlement' && phase === 'foraging') { endOfForaging(); phase = 'nest_settlement'; }
    if (['external', 'egg', 'loss'].includes(x.source.kind)) { errors.push(`${x.transfer_id}: food cannot come from ${x.source.kind}:${x.source.id}`); continue; }
    if (x.cause === 'death') {
      const k = `crop:${x.source.id}`, held = cur[k]?.sugar ?? 0;
      died.add(k);
      x.amount_microportions = held;
      if (held > 0) { get(k).sugar = 0; get(unl).sugar += held; abstractions.add('dead_worker_crop_kept_in_nest_ledger'); deadCrops.push(k); }
      const i = order.indexOf(x.source.id); if (i >= 0) order.splice(i, 1);
      resolved.push(x); continue;
    }
    if (x.amount_microportions <= 0 || !Number.isInteger(x.amount_microportions)) { errors.push(`${x.transfer_id}: amount ${x.amount_microportions} is not a positive integer`); continue; }
    if (x.cause === 'trophallaxis') {
      if (x.food_type !== 'sugar') { errors.push(`${x.transfer_id}: trophallaxis of ${x.food_type}`); continue; }
      if (x.location !== opts.nest) { errors.push(`${x.transfer_id}: trophallaxis at ${x.location}, not where both workers are (the nest)`); continue; }
      const away = [x.source.id, x.recipient.id].filter((w) => (cur[`in_transit:${w}`]?.sugar ?? 0) + (cur[`in_transit:${w}`]?.protein ?? 0) > 0);
      if (away.length) { errors.push(`${x.transfer_id}: trophallaxis with ${away.join(', ')} while carrying a load outside the nest (no contact possible)`); continue; }
    }
    if (x.source.kind === 'colony_ledger_aggregate') {
      // nest settlement, attribution unknown: the engine's own rule (settleCrops) decides which compartment loses it
      let left = x.amount_microportions;
      // egg sugar leaves the crops only when the species rule nutrition.egg_laying_settles_crops is on (engine/queen.ts)
      const fromCrops = !(x.cause === 'lay_egg' && opts.eggSettlesCrops === false);
      if (x.food_type === 'sugar') {
        if (fromCrops) for (const w of order) { const k = `crop:${w}`, h = cur[k]?.sugar ?? 0, a = Math.min(h, left); scanned.add(k); if (a > 0) { take(k, 'sugar', a); left -= a; abstractions.add('settlement_from_crops_in_worker_array_order'); } if (!left) break; }
        if (left) { const h = cur[unl]?.sugar ?? 0; if (h < left) errors.push(`${x.transfer_id}: unattributed ${x.cause} ${x.amount_microportions} µp sugar exceeds the nest sugar`); take(unl, 'sugar', Math.min(h, left)); }
      } else { const h = cur[cache]?.protein ?? 0; if (h < left) errors.push(`${x.transfer_id}: unattributed ${x.cause} ${left} µp protein exceeds the cache`); take(cache, 'protein', Math.min(h, left)); }
      unattributed[x.food_type] += x.amount_microportions;
    } else if (isTracked(x.source)) {
      const s = get(key(x.source));
      if (s[x.food_type] < x.amount_microportions) { errors.push(`${x.transfer_id}: ${key(x.source)} holds ${s[x.food_type]} µp ${x.food_type}, cannot give ${x.amount_microportions}`); continue; }
      s[x.food_type] -= x.amount_microportions;
    }
    if (isTracked(x.recipient)) get(key(x.recipient))[x.food_type] += x.amount_microportions;
    resolved.push(x);
  }
  if (phase === 'foraging') endOfForaging();
  for (const k of new Set([...Object.keys(cur), ...Object.keys(end)])) {
    if (k.startsWith('crop:') && ((scanned.has(k) && (cur[k]?.sugar ?? 0) === 0) || died.has(k))) limited.push(k);
    if (k.startsWith('source:') && !opts.checkSources) continue;
    for (const f of ['sugar', 'protein'] as const) {
      const r = cur[k]?.[f] ?? 0, e = end[k]?.[f] ?? 0;
      if (r < 0) errors.push(`${k}: negative ${f} ${r}`);
      if (r !== e) errors.push(e > r ? `${k}: snapshot ${e} µp ${f} exceeds the replay ${r} (food appeared without a transfer)` : `${k}: snapshot ${e} µp ${f} is below the replay ${r} (food left without a transfer, or a transfer went elsewhere)`);
    }
  }
  // transfers and ledger entries must tell the same story
  for (const f of ['sugar', 'protein'] as const) {
    const unloads = resolved.filter((x) => x.cause === 'unload' && x.food_type === f).reduce((a, x) => a + x.amount_microportions, 0);
    const ins = ledger.filter((x) => x.food_type === f && x.direction === 'in').reduce((a, x) => a + x.amount_microportions, 0);
    const outs = ledger.filter((x) => x.food_type === f && x.direction === 'out').reduce((a, x) => a + x.amount_microportions, 0);
    if (unloads !== ins) errors.push(`${f}: unloaded ${unloads} µp but the ledger records ${ins} µp delivered`);
    if (unattributed[f] !== outs) errors.push(`${f}: unattributed use ${unattributed[f]} µp but the ledger records ${outs} µp used`);
  }
  const ledgerOk = (['sugar', 'protein'] as const).every((f) => opts.ledgerStart[f] + ledger.filter((x) => x.food_type === f && x.direction === 'in').reduce((a, x) => a + x.amount_microportions, 0) - ledger.filter((x) => x.food_type === f && x.direction === 'out').reduce((a, x) => a + x.amount_microportions, 0) === opts.ledgerEnd[f]);
  if (!ledgerOk) errors.push('nest ledger does not close: start + delivered − used ≠ end');
  return { physical_verified: errors.length === 0, ledger_only_closed: ledgerOk, errors, unattributed, unattributed_by_compartment: byComp, engine_abstractions_used: [...abstractions].sort(), dead_worker_crops_to_ledger: deadCrops, evidence_limited_compartments: limited.sort(), sources_checked: !!opts.checkSources, resolved, replayed: cur };
}

/** Convenience: replay one engine colony-day from its start state, events, summary and end state. */
export function replayColonyDay(startColony: ColonyState, endColony: ColonyState, events: SimEvent[], summary: Any, day: number, eggSettlesCrops: boolean): ReplayResult & { transfers: FoodTransfer[]; ledger: LedgerEntry[] } {
  const { transfers, ledger } = dayTransfers(events, summary, endColony, day);
  const start = colonyCompartments(startColony), end = colonyCompartments(endColony);
  const r = replayTransfers(start, transfers, ledger, end, { nest: endColony.nest_node, colony: endColony.id, workerOrder: startColony.population.workers.map((w) => w.id), ledgerStart: { sugar: toMicro(startColony.stores.sugar), protein: toMicro(startColony.stores.protein) }, ledgerEnd: { sugar: toMicro(endColony.stores.sugar), protein: toMicro(endColony.stores.protein) }, eggSettlesCrops });
  return { ...r, transfers, ledger };
}
