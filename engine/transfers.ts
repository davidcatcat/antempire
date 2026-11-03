/**
 * Work package C2 (docs/design-wpc-food-compartments.md; Issue #43 F01/A08): the ENGINE itself records every movement
 * of food between compartments as a `food_transfer` event, at the line of code that moves it. Nothing is inferred
 * afterwards. Diagnostics only (v2-review.22): the transfers describe what the engine already did; no quantity, draw
 * or decision changes. Removing every food_transfer event reproduces v2-review.21 byte for byte
 * (tests/rules-isolation.test.ts, normaliser food_transfer_events_v22).
 *
 * Compartments (`kind:id`):
 *   source:<site>          food at a site of the world (liquid or carcass batches)
 *   insect:<event id>      a tracked live insect killed by a hunt (becomes carcass food at the site)
 *   in_transit:<worker>    a load a worker carries between collecting and unloading (not in its crop yet)
 *   crop:<worker>          sugar in one worker's crop (a subset of the nest sugar ledger)
 *   nest_unlocated:<colony> nest sugar that is in the ledger but not in any crop (no location modelled)
 *   cache:<nest node>      protein in the nest (no location within the nest modelled)
 *   metabolized:<colony>   eaten in the daily metabolism (consumer not individual: F01)
 *   egg:<egg id>           invested in an egg (the queen's own intake is not modelled: A08)
 *   loss:storage_overflow  storage overflow, not retained
 * attribution: 'individual' = an individual act named by the engine (collect, unload, trophallaxis, hunt);
 *   'unknown' = taken from the colony ledger by an aggregate rule (metabolism, eggs, overflow; F01/A08, fixed by C3-C5);
 *   'engine_rule' = an engine bookkeeping rule, not an act (a dead worker's crop sugar stays in the nest ledger).
 * The settlement draws (which crop loses the sugar) follow the engine's own settleCrops order (worker array order);
 * that order dependence is Issue #56 and is reported, not hidden.
 */
import { round } from './math.ts';
import type { ColonyState, SimEvent, WorldState } from './types.ts';

export type FoodKind = 'source' | 'insect' | 'in_transit' | 'crop' | 'cache' | 'nest_unlocated' | 'metabolized' | 'egg' | 'loss';
export interface FoodRef { kind: FoodKind; id: string }
export type FoodCause = 'collect' | 'prey_kill' | 'unload' | 'trophallaxis' | 'storage_overflow' | 'metabolism' | 'lay_egg' | 'death_crop_to_nest_ledger';
export interface FoodTransferInput {
  minute: number | null; phase: 'foraging' | 'nest_settlement';
  source: FoodRef; recipient: FoodRef; food_type: 'sugar' | 'protein'; portions: number;
  cause: FoodCause; attribution: 'individual' | 'unknown' | 'engine_rule';
  nest_ledger_delta?: number; contact?: Record<string, unknown>; basis?: string;
}
export const FOOD_TRANSFER_SCHEMA = 'antempire.food-transfer.v1';
/** Compartments whose contents the engine holds and the closure check follows. */
export const TRACKED_KINDS: ReadonlySet<FoodKind> = new Set(['source', 'in_transit', 'crop', 'cache', 'nest_unlocated']);
/** Which food each nest compartment can hold (crops and the unlocated nest sugar hold sugar; the cache holds protein). */
const HOLDS: Partial<Record<FoodKind, 'sugar' | 'protein'>> = { crop: 'sugar', nest_unlocated: 'sugar', cache: 'protein' };

interface Binding { day: number; colony: string; n: number }
const BOUND = new WeakMap<SimEvent[], Binding>();
/** Called once per colony per day: transfers pushed to `events` get ids FT-<day>-<colony>-<n> in order. */
export function bindFoodTransfers(events: SimEvent[], day: number, colony: string): void { BOUND.set(events, { day, colony, n: 0 }); }

/** Record one transfer. A no-op for event lists that were not bound (callers outside runWorldDay). */
export function foodTransfer(events: SimEvent[], t: FoodTransferInput): void {
  const b = BOUND.get(events);
  if (!b) return;
  // a bound list never silently drops a bad amount (independent review of 31cf796): zero is "nothing moved"
  if (!Number.isFinite(t.portions) || t.portions < 0) throw Error(`FOOD_TRANSFER: invalid amount ${t.portions} for ${t.cause}`);
  if (t.portions === 0) return;
  b.n++;
  events.push({ type: 'food_transfer', schema: FOOD_TRANSFER_SCHEMA, transfer_id: `FT-${b.day}-${b.colony}-${b.n}`, day: b.day, colony: b.colony, ...t, portions: round(t.portions) });
}

/** Settlement from the crops (engine settleCrops order) then from the unlocated nest sugar. */
export function recordSettlement(events: SimEvent[], colony: ColonyState, draws: { worker: string; amount: number }[], used: number, cause: FoodCause, recipient: FoodRef, basis: string): void {
  let fromCrops = 0;
  for (const d of draws) {
    fromCrops = round(fromCrops + d.amount);
    foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'crop', id: d.worker }, recipient, food_type: 'sugar', portions: d.amount, cause, attribution: 'unknown', nest_ledger_delta: round(-d.amount), basis });
  }
  const rest = round(used - fromCrops);
  foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'nest_unlocated', id: colony.id }, recipient, food_type: 'sugar', portions: rest, cause, attribution: 'unknown', nest_ledger_delta: round(-rest), basis });
}

const micro = (x: number): number => Math.round(x * 1e6);
const key = (r: FoodRef, f: 'sugar' | 'protein') => `${r.kind}:${r.id}:${f}`;
const isTransfer = (e: SimEvent) => e.type === 'food_transfer';

/** Start-of-day holdings of one colony (micro-portions), taken before foraging. */
export interface ColonyFoodSnapshot { crops: Map<string, number>; sugar: number; protein: number; nests: string[] }
/** The nests of a colony. Today one (`nest_node`); a list so that several nests can be added without changing callers. */
export const colonyNests = (colony: ColonyState): string[] => [colony.nest_node];
export function colonySnapshot(colony: ColonyState): ColonyFoodSnapshot {
  return { crops: new Map(colony.population.workers.map((w) => [w.id, micro(w.crop_cargo_sugar || 0)])), sugar: micro(colony.stores.sugar), protein: micro(colony.stores.protein), nests: colonyNests(colony) };
}

/**
 * Issue #61 R3-08: the legal compartments of one colony-day, built from AUTHORITATIVE state and events only:
 * crops and transit loads of workers present at the start or the end of the day; caches of the colony's nests;
 * the colony's own unlocated sugar and metabolism; eggs laid that day (egg_laid event) that exist at the end;
 * insects killed that day (insect_predation event); the storage-overflow sink. Anything else is not a compartment.
 */
export function legalColonyRef(start: ColonyFoodSnapshot, colony: ColonyState, events: SimEvent[]): (r: FoodRef) => boolean {
  const workers = new Set([...start.crops.keys(), ...colony.population.workers.map((w) => w.id)]);
  const nests = new Set([...start.nests, ...colonyNests(colony)]);
  const laid = new Set(events.filter((e) => e.type === 'egg_laid').map((e) => String(e.id)));
  const eggs = new Set(colony.population.brood.filter((b) => laid.has(b.id)).map((b) => b.id));
  const kills = new Set(events.filter((e) => e.type === 'insect_predation').map((e) => String(e.event_id)));
  return (r) => {
    switch (r.kind) {
      case 'crop': case 'in_transit': return workers.has(r.id);
      case 'cache': return nests.has(r.id);
      case 'nest_unlocated': case 'metabolized': return r.id === colony.id;
      case 'egg': return eggs.has(r.id);
      case 'insect': return kills.has(r.id);
      case 'loss': return r.id === 'storage_overflow';
      case 'source': return true; // sources are shared; their existence is checked world-wide (checkSources)
      default: return false;
    }
  };
}

/**
 * Per-compartment closure of one colony-day: replay this day's transfers in order from the start snapshot; no
 * compartment may go negative; at the end every living worker's crop, the unlocated nest sugar and the protein
 * cache must equal the state exactly, nothing may be left in transit, and a dead worker's crop must be empty.
 * Sugar and protein are followed separately; a crop or the unlocated nest sugar may hold only sugar, the cache only
 * protein. Throws (the day is not produced) on any difference. Requires crops to be a subset of the ledger (v2-review.13).
 */
export function checkColonyFood(start: ColonyFoodSnapshot, colony: ColonyState, events: SimEvent[]): void {
  const cur = new Map<string, number>(), add = (k: string, v: number) => cur.set(k, (cur.get(k) ?? 0) + v);
  let cropSum = 0;
  for (const [id, v] of start.crops) { cur.set(`crop:${id}:sugar`, v); cropSum += v; }
  const unl = `nest_unlocated:${colony.id}:sugar`, cache = `cache:${colony.nest_node}:protein`;
  cur.set(unl, start.sugar - cropSum); cur.set(cache, start.protein);
  if ((cur.get(unl) as number) < 0) throw Error(`FOOD_TRANSFER: ${colony.id} starts the day with crops above the sugar ledger`);
  const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colony.id}: ${m}`); };
  const legal = legalColonyRef(start, colony, events);
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string; colony: string }, a = micro(x.portions);
    if (x.colony !== colony.id) fail(`${x.transfer_id} is recorded for colony ${x.colony}`);
    for (const r of [x.source, x.recipient]) if (!legal(r)) fail(`${x.transfer_id} uses ${r.kind}:${r.id}, which is not a compartment of this colony on this day (Issue #61 R3-08)`);
    for (const r of [x.source, x.recipient]) { const h = HOLDS[r.kind]; if (h && h !== x.food_type) fail(`${x.transfer_id} moves ${x.food_type} through ${r.kind}:${r.id}, which holds only ${h}`); }
    // sources are shared by all colonies and are checked world-wide (checkSources); only the colony side is followed here
    if (TRACKED_KINDS.has(x.source.kind) && x.source.kind !== 'source') {
      const k = key(x.source, x.food_type), h = cur.get(k) ?? 0;
      if (h < a) fail(`${x.transfer_id} takes ${a} µp ${x.food_type} from ${k}, which holds ${h}`);
      cur.set(k, h - a);
    }
    if (TRACKED_KINDS.has(x.recipient.kind) && x.recipient.kind !== 'source') add(key(x.recipient, x.food_type), a);
  }
  const alive = new Set(colony.population.workers.map((w) => w.id));
  let endCrops = 0;
  for (const w of colony.population.workers) {
    const v = micro(w.crop_cargo_sugar || 0); endCrops += v;
    if ((cur.get(`crop:${w.id}:sugar`) ?? 0) !== v) fail(`crop:${w.id} is ${v} µp, the transfers give ${cur.get(`crop:${w.id}:sugar`) ?? 0}`);
  }
  // every compartment that was touched must have a legal end state (not only the expected nest and colony)
  for (const [k, v] of cur) {
    if (k.startsWith('crop:')) { if (!alive.has(k.split(':')[1]) && v !== 0) fail(`${k} of a worker that is gone still holds ${v} µp`); }
    else if (k.startsWith('in_transit:')) { if (v !== 0) fail(`${k} still holds ${v} µp at the end of the day`); }
    else if (k !== unl && k !== cache) fail(`${k} holds ${v} µp at the end of the day but has no end state`);
  }
  if ((cur.get(unl) as number) !== micro(colony.stores.sugar) - endCrops) fail(`${unl} is ${micro(colony.stores.sugar) - endCrops} µp, the transfers give ${cur.get(unl)}`);
  if ((cur.get(cache) as number) !== micro(colony.stores.protein)) fail(`${cache} is ${micro(colony.stores.protein)} µp, the transfers give ${cur.get(cache)}`);
}

/** Source holdings after the day's ecology step and before foraging (micro-portions). */
export function sourceSnapshot(world: WorldState): Map<string, { sugar: number; protein: number }> {
  return new Map(Object.values(world.sources).map((s) => [s.id, { sugar: micro(s.sugar || 0), protein: micro(s.protein || 0) }]));
}
/** World-wide source closure over all colonies' foraging: start + kills - collections = end, per site and food.
 *  `colonyEvents[i]` are the events of `world.colonies[i]`; every transfer touching a source must be recorded for that
 *  colony, and its colony side (the transit load it fills, the insect it kills) must belong to that colony (R3-08). */
export function checkSources(start: Map<string, { sugar: number; protein: number }>, world: WorldState, colonyEvents: SimEvent[][]): void {
  const cur = new Map([...start].map(([k, v]) => [k, { ...v }]));
  colonyEvents.forEach((events, i) => {
    const colony = world.colonies?.[i];
    const transfers = events.filter(isTransfer);
    if (!colony) { if (transfers.length) throw Error(`FOOD_TRANSFER: transfers recorded for a colony that is not in the world (list ${i})`); return; }
    const workers = new Set(colony.population.workers.map((w) => w.id)), kills = new Set(events.filter((e) => e.type === 'insect_predation').map((e) => String(e.event_id)));
    for (const e of transfers) {
      const x = e as unknown as FoodTransferInput & { transfer_id: string; colony: string };
      if (x.source.kind !== 'source' && x.recipient.kind !== 'source') continue;
      if (x.colony !== colony.id) throw Error(`FOOD_TRANSFER: ${x.transfer_id} is recorded for colony ${x.colony}, in the events of ${colony.id}`);
      const other = x.source.kind === 'source' ? x.recipient : x.source;
      if (!(other.kind === 'in_transit' && workers.has(other.id)) && !(other.kind === 'insect' && kills.has(other.id))) throw Error(`FOOD_TRANSFER: ${x.transfer_id} links a source with ${other.kind}:${other.id}, which is not a worker or a recorded kill of ${colony.id} (Issue #61 R3-08)`);
    }
  });
  for (const events of colonyEvents) for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string }, a = micro(x.portions);
    if (x.source.kind === 'source') { const s = cur.get(x.source.id); if (!s || s[x.food_type] < a) throw Error(`FOOD_TRANSFER: ${x.transfer_id} takes ${a} µp from source:${x.source.id}, which holds ${s?.[x.food_type]}`); s[x.food_type] -= a; }
    if (x.recipient.kind === 'source') { const s = cur.get(x.recipient.id); if (!s) throw Error(`FOOD_TRANSFER: ${x.transfer_id} adds to unknown source ${x.recipient.id}`); s[x.food_type] += a; }
  }
  for (const s of Object.values(world.sources)) {
    const c = cur.get(s.id);
    if (!c || c.sugar !== micro(s.sugar || 0) || c.protein !== micro(s.protein || 0)) throw Error(`FOOD_TRANSFER: source:${s.id} is ${micro(s.sugar || 0)}/${micro(s.protein || 0)} µp after foraging, the transfers give ${c?.sugar}/${c?.protein}`);
  }
}
