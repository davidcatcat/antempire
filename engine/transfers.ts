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
 *   egg:<egg id>           invested in an egg (paid from the colony ledger, not from what the queen ate: A08; C3b changes it)
 *   loss:storage_overflow  storage overflow, not retained
 *   C3a (v2-review.25, switch queen_feeding.individual_queen_body_c3a): queen_body:<queen> (what the queen has EATEN, known
 *     balance only), crops may also hold liquid protein (shared capacity), loss:worker_corpse (a dead carrier's liquid
 *     protein until C5 models the corpse), phase nest_round with an ORDINAL time (no minutes; transitional, §12).
 *   C4a (v2-review.28, switch larval_feeding.individual_larva_body_c4a): larva_body:<brood id> (what the larva was FED minus
 *     what it paid, known part only; kept through the pupa until eclosion, D5), loss:brood_corpse (a dead larva's or pupa's
 *     known balance; a sink until C5).
 * attribution: 'individual' = an individual act named by the engine (collect, unload, trophallaxis, hunt);
 *   'unknown' = taken from the colony ledger by an aggregate rule (metabolism, eggs, overflow; F01/A08, fixed by C3-C5);
 *   'engine_rule' = an engine bookkeeping rule, not an act (a dead worker's crop sugar stays in the nest ledger).
 * The settlement draws (which crop loses the sugar) follow the engine's own settleCrops order (worker array order);
 * that order dependence is Issue #56 and is reported, not hidden.
 */
import { round } from './math.ts';
import type { ColonyState, SimEvent, WorldState } from './types.ts';
import type { SpeciesParams } from './params.ts';

export type FoodKind = 'source' | 'insect' | 'in_transit' | 'crop' | 'cache' | 'nest_unlocated' | 'metabolized' | 'egg' | 'loss' | 'queen_body' | 'larva_body';
export interface FoodRef { kind: FoodKind; id: string }
export type FoodCause = 'collect' | 'prey_kill' | 'unload' | 'trophallaxis' | 'storage_overflow' | 'metabolism' | 'lay_egg' | 'death_crop_to_nest_ledger' | 'take_from_cache' | 'feed_queen' | 'queen_self_feed' | 'queen_metabolism' | 'death_crop_to_corpse' | 'return_to_cache' | 'feed_larva' | 'larva_metabolism' | 'brood_body_at_eclosion' | 'death_body_to_corpse';
export type FoodPhase = 'foraging' | 'nest_round' | 'nest_settlement';
export interface FoodTransferInput {
  minute: number | null; ordinal?: number; phase: FoodPhase;
  source: FoodRef; recipient: FoodRef; food_type: 'sugar' | 'protein'; portions: number;
  cause: FoodCause; attribution: 'individual' | 'unknown' | 'engine_rule';
  nest_ledger_delta?: number; contact?: Record<string, unknown>; basis?: string;
}
export const FOOD_TRANSFER_SCHEMA = 'antempire.food-transfer.v1';
/** Compartments whose contents the engine holds and the closure check follows. */
export const TRACKED_KINDS: ReadonlySet<FoodKind> = new Set(['source', 'in_transit', 'crop', 'cache', 'nest_unlocated', 'queen_body', 'larva_body']);
/** Which food each nest compartment can hold (crops and the unlocated nest sugar hold sugar; the cache holds protein). */
const HOLDS: Partial<Record<FoodKind, 'sugar' | 'protein'>> = { crop: 'sugar', nest_unlocated: 'sugar', cache: 'protein' };
/** C3a: a crop may also hold liquid protein (and the queen's body both foods) — only on a C3a day. */
const holdsOk = (kind: FoodKind, food: 'sugar' | 'protein', c3a: boolean, c4a = false) => (kind === 'larva_body' ? c4a : kind === 'queen_body' ? c3a : kind === 'crop' && c3a ? true : !HOLDS[kind] || HOLDS[kind] === food);

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
export interface ColonyFoodSnapshot { crops: Map<string, number>; sugar: number; protein: number; nests: string[]; c3a: boolean; cropsProtein: Map<string, number>; queen: { id: string; alive: boolean; sugar: number; protein: number } | null; c4a?: boolean; larvae?: Map<string, { sugar: number; protein: number }> }
/** The nests of a colony. Today one (`nest_node`); a list so that several nests can be added without changing callers. */
export const colonyNests = (colony: ColonyState): string[] => [colony.nest_node];
export function colonySnapshot(colony: ColonyState, c3a = false, c4a = false): ColonyFoodSnapshot {
  const q = colony.population.queens?.[0];
  // C4a: every brood item with an account (larvae and pupae, D5), taken after the day's records are ensured
  if (c4a) return { ...colonySnapshot(colony, c3a), c4a: true, larvae: new Map(colony.population.brood.filter((b) => b.body).map((b) => [b.id, { sugar: micro((b.body as { fed_balance: { sugar: number } }).fed_balance.sugar), protein: micro((b.body as { fed_balance: { protein: number } }).fed_balance.protein) }])) };
  return { crops: new Map(colony.population.workers.map((w) => [w.id, micro(w.crop_cargo_sugar || 0)])), sugar: micro(colony.stores.sugar), protein: micro(colony.stores.protein), nests: colonyNests(colony), c3a,
    cropsProtein: new Map(colony.population.workers.map((w) => [w.id, micro(w.crop_cargo_protein_liquid || 0)])), queen: c3a && q ? { id: q.id, alive: colony.population.queen_alive, sugar: micro(q.body.known_balance.sugar), protein: micro(q.body.known_balance.protein) } : null };
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
      case 'crop': case 'in_transit': return phase === 'foraging' || phase === 'nest_round' ? atStart.has(r.id) : workers.has(r.id);
      // C3a: the colony's own queen, alive at the start of the day (the round and her metabolism precede her death)
      case 'queen_body': return !!start.queen && start.queen.alive && r.id === start.queen.id && r.id === colony.queen_id;
      case 'cache': return nests.has(r.id);
      case 'nest_unlocated': case 'metabolized': return r.id === colony.id;
      case 'egg': return eggs.has(r.id);
      // C4a: a brood item that had an account at the start of the day (hatchlings get theirs after every transfer to it)
      case 'larva_body': return !!start.c4a && !!start.larvae?.has(r.id);
      case 'insect': return kills.has(r.id);
      case 'loss': return r.id === 'storage_overflow' || (start.c3a && r.id === 'worker_corpse') || (!!start.c4a && r.id === 'brood_corpse');
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
  take_from_cache: [['cache'], ['crop']], feed_queen: [['crop'], ['queen_body']], queen_self_feed: [['cache'], ['queen_body']], queen_metabolism: [['queen_body'], ['metabolized']], death_crop_to_corpse: [['crop'], ['loss']], return_to_cache: [['crop'], ['cache']],
  feed_larva: [['crop'], ['larva_body']], larva_metabolism: [['larva_body'], ['metabolized']], brood_body_at_eclosion: [['larva_body'], ['metabolized']], death_body_to_corpse: [['larva_body'], ['loss']],
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
const PHASE_OF: Record<FoodCause, FoodPhase> = { collect: 'foraging', prey_kill: 'foraging', unload: 'foraging', trophallaxis: 'foraging', storage_overflow: 'nest_settlement', metabolism: 'nest_settlement', death_crop_to_nest_ledger: 'nest_settlement', lay_egg: 'nest_settlement', take_from_cache: 'nest_round', feed_queen: 'nest_round', queen_self_feed: 'nest_round', queen_metabolism: 'nest_settlement', death_crop_to_corpse: 'nest_settlement', return_to_cache: 'nest_round', feed_larva: 'nest_round', larva_metabolism: 'nest_settlement', brood_body_at_eclosion: 'nest_settlement', death_body_to_corpse: 'nest_settlement' };
/** The engine's settlement order (engine/day.ts): overflow, metabolism, deaths, eggs. */
const SETTLE_STEP: Partial<Record<FoodCause, number>> = { return_to_cache: -0.5, take_from_cache: -0.5, feed_queen: -0.5, queen_self_feed: -0.5, storage_overflow: 0, metabolism: 1, queen_metabolism: 1.5, feed_larva: -0.5, larva_metabolism: 1.6, brood_body_at_eclosion: 1.8, death_body_to_corpse: 1.8, death_crop_to_nest_ledger: 2, death_crop_to_corpse: 2, lay_egg: 3 };
const FOOD_KINDS: ReadonlySet<string> = new Set(['source', 'insect', 'in_transit', 'crop', 'cache', 'nest_unlocated', 'metabolized', 'egg', 'loss', 'queen_body', 'larva_body']);
/**
 * Runtime shape of every transfer record before any field is used (Codex review of 1bdba72, F1: records may come from
 * JSON, where the TypeScript types prove nothing). Throws a FOOD_TRANSFER error naming the record.
 */
/** The attribution each cause carries (written here independently of the cli reader's table). */
const ATTRIBUTION_OF: Record<FoodCause, 'individual' | 'unknown' | 'engine_rule'> = { collect: 'individual', prey_kill: 'individual', unload: 'individual', trophallaxis: 'individual', storage_overflow: 'unknown', metabolism: 'unknown', lay_egg: 'unknown', death_crop_to_nest_ledger: 'engine_rule', take_from_cache: 'individual', feed_queen: 'individual', queen_self_feed: 'individual', queen_metabolism: 'individual', death_crop_to_corpse: 'engine_rule', return_to_cache: 'individual', feed_larva: 'individual', larva_metabolism: 'individual', brood_body_at_eclosion: 'engine_rule', death_body_to_corpse: 'engine_rule' };
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
    if (x.phase !== 'foraging' && x.phase !== 'nest_round' && x.phase !== 'nest_settlement') fail(`phase ${JSON.stringify(x.phase)} is not foraging, nest_round or nest_settlement`);
    // C3a: a nest-round record has an ordinal time (not minutes; transitional) and no minute; no other record has an ordinal
    if (x.phase === 'nest_round' && (x.minute !== null || typeof x.ordinal !== 'number' || !Number.isFinite(x.ordinal) || x.ordinal < 0)) fail(`a nest-round record needs minute null and an ordinal ≥ 0 (has minute ${JSON.stringify(x.minute)}, ordinal ${JSON.stringify(x.ordinal)})`);
    if (x.phase !== 'nest_round' && x.ordinal !== undefined) fail(`ordinal ${JSON.stringify(x.ordinal)} on a ${x.phase} record`);
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
    // review of 3acfa0b: an amount must be at least one micro-portion (a 0 µp record is a phantom transfer)
    if (micro(x.portions as number) < 1) fail(`portions ${x.portions} is less than one micro-portion`);
    // review of 3acfa0b: the attribution is fixed by the cause (individual act, aggregate rule, bookkeeping rule)
    if (x.attribution !== ATTRIBUTION_OF[x.cause as FoodCause]) fail(`${x.cause} must have attribution ${ATTRIBUTION_OF[x.cause as FoodCause]}, has ${JSON.stringify(x.attribution)}`);
  });
}

function checkPathAndKills(colonyId: string, events: SimEvent[]): void {
  const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colonyId}: ${m}`); };
  assertTransferShape(colonyId, events);
  // the phase a record declares must be the phase of its cause, and phases follow the engine's day order (the roster's
  // time rule depends on it; independent review of 4a78ee4)
  let step = -1, lastOrdinal = -Infinity;
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string };
    if (PHASE_OF[x.cause] !== x.phase) fail(`${x.transfer_id}: ${x.cause} is recorded in phase ${x.phase}, it belongs to ${PHASE_OF[x.cause]}`);
    const k = x.phase === 'foraging' ? -1 : (SETTLE_STEP[x.cause] as number);
    // within the nest round the ordinal never goes back along the array (the engine writes the round in time order)
    if (x.phase === 'nest_round') { if ((x.ordinal as number) < lastOrdinal) fail(`${x.transfer_id}: ordinal ${x.ordinal} after ${lastOrdinal}: the nest round goes back in time`); lastOrdinal = x.ordinal as number; }
    if (k < step) fail(`${x.transfer_id}: ${x.cause} (${x.phase}) out of the engine's day order`);
    step = k;
    if (x.cause === 'prey_kill' && x.food_type !== 'protein') fail(`${x.transfer_id}: a kill yields protein, recorded as ${x.food_type}`);
    if ((x.cause === 'take_from_cache' || x.cause === 'queen_self_feed' || x.cause === 'death_crop_to_corpse' || x.cause === 'return_to_cache') && x.food_type !== 'protein') fail(`${x.transfer_id}: ${x.cause} moves protein, recorded as ${x.food_type}`);
    if (x.cause === 'death_crop_to_corpse' && x.recipient.id !== 'worker_corpse') fail(`${x.transfer_id}: a dead carrier's liquid protein goes to loss:worker_corpse, not ${x.recipient.id}`);
    if (x.cause === 'death_body_to_corpse' && x.recipient.id !== 'brood_corpse') fail(`${x.transfer_id}: a dead larva's or pupa's balance goes to loss:brood_corpse, not ${x.recipient.id}`);
    if (x.cause === 'death_crop_to_nest_ledger' && x.food_type !== 'sugar') fail(`${x.transfer_id}: only crop sugar stays in the nest ledger at death`);
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
 * Codex reviews 2026-11-04/05, F1 (P2): TIME causality of the foraging transfers. A closing end balance does not show
 * that the transfers could have happened in that order: an unload stamped before the collect that supplied it balances
 * just as well. Semantics (the engine's event clock, engine/activity.ts): a foraging record's `minute` is the event-clock
 * time of the act, and the engine writes the records of one colony-day in the order it processes them — so at the same
 * minute, array order IS the order of the acts (the tie rule). This check never sorts records into a legal order and
 * never changes them; it rejects:
 *   (a) on a timed day (mode from the rules, foodTimingFor) a foraging record with minute null — null is never read as
 *       minute 0, and an all-null day cannot pass as legacy. On the untimed legacy path (individual timeline off) the
 *       time order is NOT validated (only the array-order replay applies); this is a stated limit;
 *   (b) a worker's own acts out of time order: the records touching one worker's compartments (in_transit:W, crop:W)
 *       must not go back in time along the array (different workers' records may interleave freely);
 *   (d) a carcass collect (contact.prey_event_id) before the kill that made it, or a prey_kill record whose minute is
 *       not the minute of its insect_predation event (independent review of ed32299, N1);
 *   (c) a dependency in the wrong time order: replaying the timed records in time order (ties: array order) no
 *       compartment of the colony may ever hold less than zero — e.g. an unload before the collect that filled the
 *       transit load, or a trophallaxis before the unload that filled the donor's crop.
 * Sources are shared between colonies; their time order is not checked here (stated limit; checkSources balances them).
 * Returns 'timed' or 'untimed_legacy' (time not validated); throws on a violation.
 */
/** How a colony-day's foraging was produced: on the individual activity timeline (v2-review.17) every act has an
 * event-clock minute; the earlier planned-trip path ('untimed_legacy') records collects and unloads without one. The mode
 * comes from the rules (species switches), never from the records themselves, so nulling minutes cannot select it. */
export type FoodTiming = 'timed' | 'untimed_legacy';
export function foodTimingFor(sp: SpeciesParams): FoodTiming { return sp.activity.individual_timeline && sp.navigation.individual_route_memory ? 'timed' : 'untimed_legacy'; }
export function checkTimedCausality(start: ColonyFoodSnapshot, colony: ColonyState, events: SimEvent[], timing: FoodTiming): 'timed' | 'untimed_legacy' | 'no_foraging' {
  const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colony.id}: ${m}`); };
  const fx = events.filter(isTransfer).map((e) => e as unknown as FoodTransferInput & { transfer_id: string }).filter((x) => x.phase === 'foraging');
  if (!fx.length) return 'no_foraging';
  // Untimed legacy path: minute values (hunt windows carry one, collects and unloads do not) are NOT validated; only the
  // array-order replay of checkColonyFood applies. Stated limit, not a pass.
  if (timing === 'untimed_legacy') return 'untimed_legacy';
  const nulls = fx.filter((x) => x.minute === null).length;
  if (nulls) fail(`${nulls} of ${fx.length} foraging records have minute null on a timed day (individual activity timeline): an act without a time cannot be placed in time, and null is never minute 0`);
  // (d) a carcass exists only after its kill (independent review of ed32299, N1): sources are shared and not replayed
  // here, so the kill -> carcass collect link is checked directly. The prey_kill record is the same act as the
  // insect_predation event (same minute); a collect naming a prey must follow that prey's kill at the same site.
  const pos = new Map(fx.map((x, i) => [x, i]));
  const killRec = new Map(fx.filter((x) => x.cause === 'prey_kill').map((x) => [x.source.id, x]));
  for (const e of events) if (e.type === 'insect_predation') {
    const k = killRec.get(String(e.event_id));
    if (k && e.minute !== k.minute) fail(`${k.transfer_id} (prey_kill of ${e.event_id}) is at minute ${k.minute}, the kill itself (insect_predation) at minute ${e.minute}`);
  }
  for (const x of fx) {
    const prey = (x as { contact?: { prey_event_id?: unknown } }).contact?.prey_event_id;
    if (x.cause !== 'collect' || prey === undefined) continue;
    const k = killRec.get(String(prey));
    if (!k) fail(`${x.transfer_id} collects the carcass of ${prey}, which has no prey_kill record this day`);
    else if (k.recipient.id !== x.source.id) fail(`${x.transfer_id} collects the carcass of ${prey} at ${x.source.id}; the kill was at ${k.recipient.id}`);
    else if ((x.minute as number) < (k.minute as number) || (x.minute === k.minute && (pos.get(x) as number) < (pos.get(k) as number))) fail(`${x.transfer_id} (collect, minute ${x.minute}) takes the carcass of ${prey} before its kill ${k.transfer_id} (minute ${k.minute})`);
  }
  // (b) per worker: its own acts never go back in time along the array
  const lastMinute = new Map<string, { m: number; id: string }>();
  for (const x of fx) {
    const holders = [x.source, x.recipient].filter((r) => r.kind === 'in_transit' || r.kind === 'crop').map((r) => r.id);
    for (const w of new Set(holders)) {
      const prev = lastMinute.get(w);
      if (prev && (x.minute as number) < prev.m) fail(`${x.transfer_id} (${x.cause}, minute ${x.minute}) is recorded after ${prev.id} (minute ${prev.m}) of the same worker ${w}: its acts go back in time`);
      lastMinute.set(w, { m: x.minute as number, id: x.transfer_id });
    }
  }
  // (c) time-ordered replay; ties at the same minute keep the engine's processing (array) order
  const order = fx.map((x, i) => ({ x, i })).sort((p, q) => (p.x.minute as number) - (q.x.minute as number) || p.i - q.i);
  const hold = new Map<string, number>();
  let cropSum = 0;
  for (const [id, v] of start.crops) { hold.set(`crop:${id}:sugar`, v); cropSum += v; }
  hold.set(`nest_unlocated:${colony.id}:sugar`, start.sugar - cropSum); hold.set(`cache:${colony.nest_node}:protein`, start.protein);
  for (const { x } of order) {
    const a = micro(x.portions);
    if (TRACKED_KINDS.has(x.source.kind) && x.source.kind !== 'source') {
      const k = key(x.source, x.food_type), h = hold.get(k) ?? 0;
      if (h < a) fail(`${x.transfer_id} (${x.cause} at minute ${x.minute}) takes ${a} µp ${x.food_type} from ${k}, which at that time holds ${h}: it uses food that has not arrived yet`);
      hold.set(k, h - a);
    }
    if (TRACKED_KINDS.has(x.recipient.kind) && x.recipient.kind !== 'source') { const k = key(x.recipient, x.food_type); hold.set(k, (hold.get(k) ?? 0) + a); }
  }
  return 'timed';
}

/**
 * Per-compartment closure of one colony-day: replay this day's transfers in order from the start snapshot; no
 * compartment may go negative; at the end every living worker's crop, the unlocated nest sugar and the protein
 * cache must equal the state exactly, nothing may be left in transit, and a dead worker's crop must be empty.
 * Sugar and protein are followed separately; a crop or the unlocated nest sugar may hold only sugar, the cache only
 * protein. Throws (the day is not produced) on any difference. Requires crops to be a subset of the ledger (v2-review.13).
 */
export function checkColonyFood(start: ColonyFoodSnapshot, colony: ColonyState, events: SimEvent[], timing: FoodTiming = 'timed'): void {
  const cur = new Map<string, number>(), add = (k: string, v: number) => cur.set(k, (cur.get(k) ?? 0) + v);
  let cropSum = 0;
  for (const [id, v] of start.crops) { cur.set(`crop:${id}:sugar`, v); cropSum += v; }
  const unl = `nest_unlocated:${colony.id}:sugar`, cache = `cache:${colony.nest_node}:protein`;
  cur.set(unl, start.sugar - cropSum); cur.set(cache, start.protein);
  if (start.c3a) { for (const [id, v] of start.cropsProtein) if (v) cur.set(`crop:${id}:protein`, v); if (start.queen) { cur.set(`queen_body:${start.queen.id}:sugar`, start.queen.sugar); cur.set(`queen_body:${start.queen.id}:protein`, start.queen.protein); } }
  if (start.c4a) for (const [id, v] of start.larvae ?? []) { cur.set(`larva_body:${id}:sugar`, v.sugar); cur.set(`larva_body:${id}:protein`, v.protein); }
  if ((cur.get(unl) as number) < 0) throw Error(`FOOD_TRANSFER: ${colony.id} starts the day with crops above the sugar ledger`);
  const fail = (m: string) => { throw Error(`FOOD_TRANSFER ${colony.id}: ${m}`); };
  assertTransferShape(colony.id, events); // before any field of any event is read (legalColonyRef reads the events)
  const legal = legalColonyRef(start, colony, events);
  checkPathAndKills(colony.id, events);
  for (const e of events.filter(isTransfer)) {
    const x = e as unknown as FoodTransferInput & { transfer_id: string; colony: string }, a = micro(x.portions);
    if (x.colony !== colony.id) fail(`${x.transfer_id} is recorded for colony ${x.colony}`);
    for (const r of [x.source, x.recipient]) if (!legal(r, x.phase)) fail(`${x.transfer_id} uses ${r.kind}:${r.id}, which is not a compartment of this colony on this day (Issue #61 R3-08)`);
    for (const r of [x.source, x.recipient]) if (!holdsOk(r.kind, x.food_type, start.c3a, !!start.c4a)) fail(`${x.transfer_id} moves ${x.food_type} through ${r.kind}:${r.id}, which holds only ${HOLDS[r.kind] ?? 'nothing on this day'}`);
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
  for (const w of colony.population.workers) {
    const v = micro(w.crop_cargo_protein_liquid || 0), got = cur.get(`crop:${w.id}:protein`) ?? 0;
    if (got !== v) fail(`crop:${w.id} holds ${v} µp liquid protein, the transfers give ${got}`);
  }
  const q = colony.population.queens?.[0];
  // every compartment that was touched must have a legal end state (not only the expected nest and colony)
  for (const [k, v] of cur) {
    if (k.startsWith('crop:')) { if (!alive.has(k.split(':')[1]) && v !== 0) fail(`${k} of a worker that is gone still holds ${v} µp`); }
    else if (k.startsWith('queen_body:')) {
      const [, id, f] = k.split(':'), want = q && q.id === id ? micro(q.body.known_balance[f as 'sugar' | 'protein']) : 0;
      if (v !== want) fail(`${k} is ${want} µp in the state, the transfers give ${v}`);
    }
    else if (k.startsWith('larva_body:')) {
      const [, id, f] = k.split(':'), b = colony.population.brood.find((x) => x.id === id), want = b?.body ? micro(b.body.fed_balance[f as 'sugar' | 'protein']) : 0;
      if (v !== want) fail(`${k} is ${want} µp in the state, the transfers give ${v}`);
    }
    else if (k.startsWith('in_transit:')) { if (v !== 0) fail(`${k} still holds ${v} µp at the end of the day`); }
    else if (k !== unl && k !== cache) fail(`${k} holds ${v} µp at the end of the day but has no end state`);
  }
  // C4a (A11): every account at the end has its start balance and transfers behind it (a hatchling's starts at 0)
  if (start.c4a) for (const b of colony.population.brood) if (b.body) for (const f of ['sugar', 'protein'] as const) {
    const k = `larva_body:${b.id}:${f}`, want = micro(b.body.fed_balance[f]);
    if (!cur.has(k) && want !== 0) fail(`${k} is ${want} µp with no start balance or transfer behind it`);
  }
  if ((cur.get(unl) as number) !== micro(colony.stores.sugar) - endCrops) fail(`${unl} is ${micro(colony.stores.sugar) - endCrops} µp, the transfers give ${cur.get(unl)}`);
  if ((cur.get(cache) as number) !== micro(colony.stores.protein)) fail(`${cache} is ${micro(colony.stores.protein)} µp, the transfers give ${cur.get(cache)}`);
  checkTimedCausality(start, colony, events, timing);
}

/** Source holdings after the day's ecology step and before foraging (micro-portions). */
export function sourceSnapshot(world: WorldState): Map<string, { sugar: number; protein: number }> {
  return new Map(Object.values(world.sources).map((s) => [s.id, { sugar: micro(s.sugar || 0), protein: micro(s.protein || 0) }]));
}
/** World-wide source closure over all colonies' foraging: start + kills - collections = end, per site and food.
 *  `colonyEvents[i]` are the events of `world.colonies[i]`; every transfer touching a source must be recorded for that
 *  colony, and its colony side (the transit load it fills, the insect it kills) must belong to that colony (R3-08). */
export function checkSources(start: Map<string, { sugar: number; protein: number }>, world: WorldState, colonyEvents: SimEvent[][], timings: FoodTiming[] = []): void {
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
  // Colonies forage one after another (engine/day.ts), so a colony starts from the holdings its predecessors left. Within
  // a timed colony-day the source records are taken in TIME order (ties: list order): a kill adds carcass protein to a
  // source only at its minute, so nothing — tagged with the prey or not — can be taken from it earlier (independent
  // review of af6779c). On the untimed legacy path the list order is used (time not validated).
  colonyEvents.forEach((events, ci) => {
    const xs = events.filter(isTransfer).map((e, i) => ({ x: e as unknown as FoodTransferInput & { transfer_id: string }, i })).filter(({ x }) => x.source.kind === 'source' || x.recipient.kind === 'source');
    if ((timings[ci] ?? 'timed') === 'timed') {
      const untimed = xs.find(({ x }) => typeof x.minute !== 'number');
      if (untimed) throw Error(`FOOD_TRANSFER: ${untimed.x.transfer_id} moves source food without a minute on a timed day`);
      xs.sort((p, q) => (p.x.minute as number) - (q.x.minute as number) || p.i - q.i);
    }
    for (const { x } of xs) {
    const a = micro(x.portions);
    if (x.source.kind === 'source') { const s = cur.get(x.source.id); if (!s || s[x.food_type] < a) throw Error(`FOOD_TRANSFER: ${x.transfer_id} takes ${a} µp from source:${x.source.id}, which holds ${s?.[x.food_type]}`); s[x.food_type] -= a; }
    if (x.recipient.kind === 'source') { const s = cur.get(x.recipient.id); if (!s) throw Error(`FOOD_TRANSFER: ${x.transfer_id} adds to unknown source ${x.recipient.id}`); s[x.food_type] += a; }
    }
  });
  for (const s of Object.values(world.sources)) {
    const c = cur.get(s.id);
    if (!c || c.sugar !== micro(s.sugar || 0) || c.protein !== micro(s.protein || 0)) throw Error(`FOOD_TRANSFER: source:${s.id} is ${micro(s.sugar || 0)}/${micro(s.protein || 0)} µp after foraging, the transfers give ${c?.sugar}/${c?.protein}`);
  }
}
