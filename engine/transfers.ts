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
export type FoodPhase = 'foraging' | 'nest_settlement';
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
const isTransfer = (e: SimEvent) => typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'food_transfer';

/** Start-of-day holdings of one colony (micro-portions), taken before foraging. */
export interface ColonyFoodSnapshot { crops: Map<string, number>; sugar: number; protein: number; nests: string[] }
/** The nests of a colony. Today one (`nest_node`); a list so that several nests can be added without changing callers. */
export const colonyNests = (colony: ColonyState): string[] => [colony.nest_node];
export function colonySnapshot(colony: ColonyState): ColonyFoodSnapshot {
  return { crops: new Map(colony.population.workers.map((w) => [w.id, micro(w.crop_cargo_sugar || 0)])), sugar: micro(colony.stores.sugar), protein: micro(colony.stores.protein), nests: colonyNests(colony) };
}

/**
 * Issue #61 R3-08: the legal compartments of one colony-day, built from AUTHORITATIVE state and events only:
 * crops and transit loads of workers that existed WHEN the transfer happened (foraging phase: workers present at the
 * start of the day — eclosions and deaths come later in the day; nest settlement: present at the start or the end);
 * caches of the colony's nests; the colony's own unlocated sugar and metabolism; eggs laid that day (egg_laid event)
 * that exist at the end; insects killed that day (insect_predation event); the storage-overflow sink.
 */
export function legalColonyRef(start: ColonyFoodSnapshot, colony: ColonyState, events: SimEvent[]): (r: FoodRef, phase: FoodPhase) => boolean {
  const atStart = new Set(start.crops.keys()), workers = new Set([...atStart, ...colony.population.workers.map((w) => w.id)]);
  const nests = new Set([...start.nests, ...colonyNests(colony)]);
  const laid = new Set(events.filter((e) => e.type === 'egg_laid').map((e) => String(e.id)));
  const eggs = new Set(colony.population.brood.filter((b) => laid.has(b.id)).map((b) => b.id));
  const kills = new Set(events.filter((e) => e.type === 'insect_predation').map((e) => String(e.event_id)));
  return (r, phase) => {
    switch (r.kind) {
      case 'crop': case 'in_transit': return phase === 'foraging' ? atStart.has(r.id) : workers.has(r.id);
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

/** The paths each cause may take, [source kinds, recipient kinds] (the engine's own table; the cli reader has its own). */
const PATHS: Record<FoodCause, [string[], string[]]> = {
  collect: [['source'], ['in_transit']], prey_kill: [['insect'], ['source']], unload: [['in_transit'], ['crop', 'cache']], trophallaxis: [['crop'], ['crop']],
  storage_overflow: [['crop', 'nest_unlocated', 'cache'], ['loss']], metabolism: [['crop', 'nest_unlocated', 'cache'], ['metabolized']],
  lay_egg: [['crop', 'nest_unlocated', 'cache'], ['egg']], death_crop_to_nest_ledger: [['crop'], ['nest_unlocated']],
};
/**
 * Path, holder and one-shot rules of one transfer (Issue #61 R3-08, independent reviews of 7ae0967 and 4a78ee4):
 *   - the declared phase is the cause's phase, in the engine's day order (foraging, then overflow, metabolism, deaths, eggs);
 *   - the cause allows this source and recipient kind;
 *   - an unload moves a transit load into the crop of the SAME worker (or a nest cache), never into another's crop;
 *   - a trophallaxis is between two different crops;
 *   - a kill is a one-shot compartment: one prey_kill per insect_predation, to that event's site, of exactly the protein
 *     of the carcass the engine created for it (new_food_source with the same id).
 */
const PHASE_OF: Record<FoodCause, FoodPhase> = { collect: 'foraging', prey_kill: 'foraging', unload: 'foraging', trophallaxis: 'foraging', storage_overflow: 'nest_settlement', metabolism: 'nest_settlement', death_crop_to_nest_ledger: 'nest_settlement', lay_egg: 'nest_settlement' };
/** The engine's settlement order (engine/day.ts): overflow, metabolism, deaths, eggs. */
const SETTLE_STEP: Partial<Record<FoodCause, number>> = { storage_overflow: 0, metabolism: 1, death_crop_to_nest_ledger: 2, lay_egg: 3 };
const FOOD_KINDS: ReadonlySet<string> = new Set(['source', 'insect', 'in_transit', 'crop', 'cache', 'nest_unlocated', 'metabolized', 'egg', 'loss']);
/**
 * Runtime shape of every transfer record before any field is used (Codex review of 1bdba72, F1: records may come from
 * JSON, where the TypeScript types prove nothing). Throws a FOOD_TRANSFER error naming the record.
 */
/** Minutes in a day: the latest a timed (foraging) record can be. */
const DAY_MINUTES = 1440;
export function assertTransferShape(colonyId: string, events: SimEvent[]): void {
  if (!Array.isArray(events)) throw Error(`FOOD_TRANSFER ${colonyId}: the event list is not an array`);
  const ids = new Set<string>();
  let day: unknown;
  events.forEach((e, i) => {
    // independent review of 9888217 (F-d): a list element that is not an object is a located error, not a crash
    if (typeof e !== 'object' || e === null) throw Error(`FOOD_TRANSFER ${colonyId}: event ${i} is ${JSON.stringify(e)}, not an event object`);
    if (!isTransfer(e)) return;
    const x = e as Record<string, unknown>, name = typeof x.transfer_id === 'string' && x.transfer_id ? x.transfer_id : `event ${i}`;
    const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colonyId}: ${name}: ${m}`); };
    if (Array.isArray(e)) fail('the record is an array, not an object');
    if (typeof x.transfer_id !== 'string' || !x.transfer_id) fail('transfer_id missing');
    if (ids.has(x.transfer_id as string)) fail('transfer_id used twice'); ids.add(x.transfer_id as string);
    if (x.schema !== 'antempire.food-transfer.v1') fail(`schema ${JSON.stringify(x.schema)} is not antempire.food-transfer.v1`);
    if (!Number.isInteger(x.day)) fail(`day ${JSON.stringify(x.day)} is not an integer`);
    if (day === undefined) day = x.day; else if (x.day !== day) fail(`day ${JSON.stringify(x.day)} differs from the other records (${JSON.stringify(day)})`);
    if (typeof x.colony !== 'string' || !x.colony) fail('colony missing');
    if (x.attribution !== 'individual' && x.attribution !== 'unknown' && x.attribution !== 'engine_rule') fail(`attribution ${JSON.stringify(x.attribution)} is not defined`);
    if (x.phase !== 'foraging' && x.phase !== 'nest_settlement') fail(`phase ${JSON.stringify(x.phase)} is not foraging or nest_settlement`);
    if (typeof x.cause !== 'string' || !Object.prototype.hasOwnProperty.call(PHASE_OF, x.cause)) fail(`unknown cause ${JSON.stringify(x.cause)}`);
    // a foraging record has a minute of the day (or null on the untimed legacy path); a settlement record is not timed
    if (x.phase === 'foraging' && !(x.minute === null || (typeof x.minute === 'number' && Number.isFinite(x.minute) && x.minute >= 0 && x.minute <= DAY_MINUTES))) fail(`minute ${JSON.stringify(x.minute)} is not null or a minute of the day (0..${DAY_MINUTES})`);
    if (x.phase === 'nest_settlement' && x.minute !== null) fail(`a nest-settlement record has minute ${JSON.stringify(x.minute)} (settlement is not timed)`);
    for (const side of ['source', 'recipient']) {
      const r = x[side] as Record<string, unknown> | null | undefined;
      if (typeof r !== 'object' || r === null || Array.isArray(r)) fail(`${side} missing or not an object`);
      const ref = r as Record<string, unknown>;
      if (typeof ref.kind !== 'string' || !FOOD_KINDS.has(ref.kind)) fail(`${side} kind ${JSON.stringify(ref.kind)} is not a compartment kind`);
      if (typeof ref.id !== 'string' || !ref.id) fail(`${side} id ${JSON.stringify(ref.id)} is not a non-empty string`);
    }
    if (x.food_type !== 'sugar' && x.food_type !== 'protein') fail(`food_type ${JSON.stringify(x.food_type)} is not sugar or protein`);
    if (typeof x.portions !== 'number' || !Number.isFinite(x.portions) || !(x.portions > 0)) fail(`portions ${JSON.stringify(x.portions)} is not a positive finite number`);
    if (Math.abs((x.portions as number) * 1e6 - Math.round((x.portions as number) * 1e6)) > 1e-3) fail(`portions ${x.portions} has more than six decimals`);
  });
}

function checkPathAndKills(colonyId: string, events: SimEvent[]): void {
  const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colonyId}: ${m}`); };
  assertTransferShape(colonyId, events);
  // the phase a record declares must be the phase of its cause, and phases follow the engine's day order (the roster's
  // time rule depends on it; independent review of 4a78ee4)
  let step = -1;
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string };
    if (PHASE_OF[x.cause] !== x.phase) fail(`${x.transfer_id}: ${x.cause} is recorded in phase ${x.phase}, it belongs to ${PHASE_OF[x.cause]}`);
    const k = x.phase === 'foraging' ? -1 : (SETTLE_STEP[x.cause] as number);
    if (k < step) fail(`${x.transfer_id}: ${x.cause} (${x.phase}) out of the engine's day order`);
    step = k;
    if (x.cause === 'prey_kill' && x.food_type !== 'protein') fail(`${x.transfer_id}: a kill yields protein, recorded as ${x.food_type}`);
  }
  const kills = new Map(events.filter((e) => e.type === 'insect_predation').map((e) => [String(e.event_id), String(e.site)]));
  const carcass = new Map(events.filter((e) => e.type === 'new_food_source' && e.caused_by_event_id === e.id).map((e) => [String(e.id), micro(Number(e.protein_portions))]));
  const used = new Set<string>();
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string }, p = PATHS[x.cause];
    if (!p) fail(`${x.transfer_id} has unknown cause ${x.cause}`);
    if (!p[0].includes(x.source.kind) || !p[1].includes(x.recipient.kind)) fail(`${x.transfer_id}: ${x.cause} from ${x.source.kind} to ${x.recipient.kind} is not a possible path`);
    if (x.cause === 'unload' && x.recipient.kind === 'crop' && x.recipient.id !== x.source.id) fail(`${x.transfer_id} unloads the transit load of ${x.source.id} into the crop of ${x.recipient.id}`);
    if (x.cause === 'trophallaxis' && x.source.id === x.recipient.id) fail(`${x.transfer_id} is a trophallaxis of ${x.source.id} with itself`);
    if (x.cause === 'prey_kill') {
      if (used.has(x.source.id)) fail(`${x.transfer_id} credits kill ${x.source.id} a second time`);
      used.add(x.source.id);
      if (kills.get(x.source.id) !== x.recipient.id) fail(`${x.transfer_id} credits kill ${x.source.id} to source:${x.recipient.id}, the kill was at ${kills.get(x.source.id)}`);
      if (carcass.get(x.source.id) !== micro(x.portions)) fail(`${x.transfer_id} credits ${micro(x.portions)} µp for kill ${x.source.id}, its carcass holds ${carcass.get(x.source.id)}`);
    }
  }
  for (const k of kills.keys()) if (!used.has(k)) fail(`kill ${k} has no prey_kill transfer`);
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
  assertTransferShape(colony.id, events); // before any field of any event is read (legalColonyRef reads the events)
  const legal = legalColonyRef(start, colony, events);
  checkPathAndKills(colony.id, events);
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string; colony: string }, a = micro(x.portions);
    if (x.colony !== colony.id) fail(`${x.transfer_id} is recorded for colony ${x.colony}`);
    for (const r of [x.source, x.recipient]) if (!legal(r, x.phase)) fail(`${x.transfer_id} uses ${r.kind}:${r.id}, which is not a compartment of this colony on this day (Issue #61 R3-08)`);
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
    assertTransferShape(colony?.id ?? `list ${i}`, events);
    const transfers = events.filter(isTransfer);
    if (!colony) { if (transfers.length) throw Error(`FOOD_TRANSFER: transfers recorded for a colony that is not in the world (list ${i})`); return; }
    assertTransferShape(colony.id, events);
    const workers = new Set(colony.population.workers.map((w) => w.id)), kills = new Set(events.filter((e) => e.type === 'insect_predation').map((e) => String(e.event_id)));
    for (const e of transfers) {
      const x = e as unknown as FoodTransferInput & { transfer_id: string; colony: string };
      if (x.source.kind !== 'source' && x.recipient.kind !== 'source') continue;
      if (x.colony !== colony.id) throw Error(`FOOD_TRANSFER: ${x.transfer_id} is recorded for colony ${x.colony}, in the events of ${colony.id}`);
      // independent review of 9888217 (F-c): the world check ties cause, phase and path itself (it also runs alone when
      // the colony check is not defined): a source is only collected from (collect) or credited by a kill (prey_kill)
      const ok = (x.cause === 'collect' && x.phase === 'foraging' && x.source.kind === 'source' && x.recipient.kind === 'in_transit') || (x.cause === 'prey_kill' && x.phase === 'foraging' && x.source.kind === 'insect' && x.recipient.kind === 'source');
      if (!ok) throw Error(`FOOD_TRANSFER: ${x.transfer_id} (${x.cause}, ${x.phase}) moves food ${x.source.kind} -> ${x.recipient.kind}, which is not a collection or a kill`);
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
