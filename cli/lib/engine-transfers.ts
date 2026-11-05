/**
 * Work package C2: an INDEPENDENT reader of the food_transfer events the engine records itself (engine/transfers.ts,
 * v2-review.22). The engine checks its own closure every day; this is a second implementation in cli/ that shares
 * no code with it, used by the tests and reports to verify that the engine's records are complete and consistent:
 *   - every transfer id is unique and numbered in order for the colony-day; schema, units, kinds and causes are valid;
 *   - the attribution is the one the cause allows (individual acts / aggregate rule / engine bookkeeping rule);
 *   - phases are ordered: all foraging transfers before the nest settlement, settlement in the engine's day order
 *     (storage overflow, metabolism, deaths, eggs);
 *   - every trophallaxis happens at the nest, right after the donor's own unloading at the same minute, and the
 *     recipient is in the nest. NOTE: this checks the engine's own record for SELF-CONSISTENCY (location and minute are
 *     fields the engine writes; on the legacy path both minutes are null); it does not show that the recipient was
 *     physically there (no separate contact event or nest space exists yet);
 *   - replaying all transfers from the start state reproduces every compartment of the end state exactly:
 *     each living worker's crop, the unlocated nest sugar, the protein cache; nothing left in transit; dead
 *     workers' crops empty. Sources are shared by colonies and balanced world-wide only by the engine itself
 *     (engine/transfers.ts checkSources; its fault injection is tested in tests/c2-engine-transfers.test.ts): this reader
 *     has no independent source check, because the source state after the ecology step is not in the output.
 * Unlike the C1 reconstruction (cli/lib/compartments.ts), nothing is inferred: every settlement draw names its crop,
 * so the C1 KNOWN LIMIT (crops emptied by the settlement) does not apply to engine-recorded days.
 */
import { toMicro } from './compartments.ts';
import type { ColonyState, SimEvent } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export interface EngineTransfer { type: 'food_transfer'; schema: string; transfer_id: string; day: number; colony: string; minute: number | null; phase: 'foraging' | 'nest_settlement'; source: { kind: string; id: string }; recipient: { kind: string; id: string }; food_type: 'sugar' | 'protein'; portions: number; cause: string; attribution: string; nest_ledger_delta?: number; contact?: Any; basis?: string }
export const engineTransfers = (events: SimEvent[]): EngineTransfer[] => events.filter((e) => typeof e === 'object' && e !== null && (e as { type?: unknown }).type === 'food_transfer') as unknown as EngineTransfer[];

const ATTRIBUTION: Record<string, string> = { collect: 'individual', prey_kill: 'individual', unload: 'individual', trophallaxis: 'individual', storage_overflow: 'unknown', metabolism: 'unknown', lay_egg: 'unknown', death_crop_to_nest_ledger: 'engine_rule' };
const SETTLEMENT_ORDER = ['storage_overflow', 'metabolism', 'death_crop_to_nest_ledger', 'lay_egg'];
const HOLDS: Record<string, ('sugar' | 'protein')[]> = { crop: ['sugar'], nest_unlocated: ['sugar'], cache: ['protein'], in_transit: ['sugar', 'protein'], source: ['sugar', 'protein'] };
const ENDPOINTS: Record<string, [string[], string[]]> = { // allowed [source kinds, recipient kinds] per cause
  collect: [['source'], ['in_transit']], prey_kill: [['insect'], ['source']], unload: [['in_transit'], ['crop', 'cache']], trophallaxis: [['crop'], ['crop']],
  storage_overflow: [['crop', 'nest_unlocated', 'cache'], ['loss']], metabolism: [['crop', 'nest_unlocated', 'cache'], ['metabolized']], lay_egg: [['crop', 'nest_unlocated', 'cache'], ['egg']], death_crop_to_nest_ledger: [['crop'], ['nest_unlocated']],
};

/** The phase each cause belongs to (written here independently of the engine's table). */
const PHASE_OF_CAUSE: Record<string, 'foraging' | 'nest_settlement'> = { collect: 'foraging', prey_kill: 'foraging', unload: 'foraging', trophallaxis: 'foraging', storage_overflow: 'nest_settlement', metabolism: 'nest_settlement', death_crop_to_nest_ledger: 'nest_settlement', lay_egg: 'nest_settlement' };
const KINDS = new Set(['source', 'insect', 'in_transit', 'crop', 'cache', 'nest_unlocated', 'metabolized', 'egg', 'loss']);
const ATTRIBUTIONS = new Set(['individual', 'unknown', 'engine_rule']);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
/** A value for an error message that never throws (BigInt, cycles, getters, proxies) and never echoes huge inputs. */
const show = (v: unknown): string => { let t: string; try { t = typeof v === 'bigint' ? `${v}n` : String(JSON.stringify(v)); } catch { t = `<${typeof v}>`; } return t.length > 80 ? `${t.slice(0, 77)}...` : t; };
/** An amount the micro-portion arithmetic can hold exactly: at least 1 µp and a safe integer (no overflow to Infinity/NaN). */
const exactMicro = (v: number, min = 1): boolean => sixDecimal(v) && toMicro(v) >= min;
/** The colony reader's six-decimal policy (replay: |v·10⁶ − round(v·10⁶)| ≤ 1e-3 µp), checked on the RAW value: 0.6 µp
 * or 1.4 µp is not a legal amount even though it rounds to 1 µp (Codex follow-up 2026-11-05, N1). Safe integer result. */
const sixDecimal = (v: number): boolean => { if (typeof v !== 'number' || !Number.isFinite(v)) return false; const m = toMicro(v); return Number.isSafeInteger(m) && Math.abs(v * 1e6 - m) <= 1e-3; };
/** Any message line is bounded (ids and labels are not otherwise truncated); any thrown value is printable. */
const MAX_LINE = 300, MAX_LINES = 50;
const boundLines = (xs: string[], what = 'errors'): string[] => { const out = xs.slice(0, MAX_LINES).map((m) => (m.length > MAX_LINE ? `${m.slice(0, MAX_LINE - 3)}...` : m)); if (xs.length > MAX_LINES) out.push(`sources: ... and ${xs.length - MAX_LINES} more ${what}`); return out; };
const printable = (e: unknown): string => { try { return show(String(e)); } catch { return '<unprintable error>'; } };
/**
 * Codex review of 1bdba72, F1: runtime schema of one record, checked BEFORE any field is used (records come from JSON;
 * TypeScript types prove nothing at run time). Returns the problems found; a record with any problem is not replayed, so
 * an undefined phase can never select a roster and a missing field can never crash the reader.
 */
export function recordSchemaErrors(x: unknown, where: string): string[] {
  const out: string[] = [];
  if (!isObj(x)) return [`${where}: not an object`];
  const label = nonEmpty(x.transfer_id) ? x.transfer_id : where;
  if (!nonEmpty(x.transfer_id)) out.push(`${where}: transfer_id missing or not a string`);
  if (x.schema !== 'antempire.food-transfer.v1') out.push(`${label}: schema ${show(x.schema)} is not antempire.food-transfer.v1`);
  if (!Number.isInteger(x.day)) out.push(`${label}: day ${show(x.day)} is not an integer`);
  if (!nonEmpty(x.colony)) out.push(`${label}: colony missing or not a string`);
  if (x.phase !== 'foraging' && x.phase !== 'nest_settlement') out.push(`${label}: phase ${show(x.phase)} is not a defined phase (foraging | nest_settlement)`);
  if (typeof x.cause !== 'string' || !Object.hasOwn(PHASE_OF_CAUSE, x.cause)) out.push(`${label}: unknown cause ${show(x.cause)}`);
  else if ((x.phase === 'foraging' || x.phase === 'nest_settlement') && PHASE_OF_CAUSE[x.cause] !== x.phase) out.push(`${label}: ${x.cause} belongs to phase ${PHASE_OF_CAUSE[x.cause]}, recorded as ${x.phase}`);
  for (const side of ['source', 'recipient'] as const) {
    const r = x[side];
    if (!isObj(r)) { out.push(`${label}: ${side} missing or not an object`); continue; } // isObj excludes arrays
    if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) out.push(`${label}: ${side} kind ${show(r.kind)} is not a compartment kind`);
    if (!nonEmpty(r.id)) out.push(`${label}: ${side} id ${show(r.id)} is not a non-empty string`);
  }
  if (x.food_type !== 'sugar' && x.food_type !== 'protein') out.push(`${label}: food_type ${show(x.food_type)} is not sugar or protein`);
  if (typeof x.portions !== 'number' || !Number.isFinite(x.portions) || !(x.portions > 0)) out.push(`${label}: portions ${show(x.portions)} is not a positive finite number`);
  else if (!Number.isSafeInteger(toMicro(x.portions))) out.push(`${label}: portions ${show(x.portions)} is too large for exact micro-portion arithmetic`); // sub-micro amounts: the six-decimal check of the replay
  if (!ATTRIBUTIONS.has(x.attribution as string)) out.push(`${label}: attribution ${show(x.attribution)} is not defined`);
  if (Array.isArray(x)) out.push(`${label}: the record is an array, not an object`);
  if (x.phase === 'foraging' && !(x.minute === null || (typeof x.minute === 'number' && Number.isFinite(x.minute) && x.minute >= 0 && x.minute <= 1440))) out.push(`${label}: minute ${show(x.minute)} is not null or a minute of the day (0..1440)`);
  if (x.phase === 'nest_settlement' && x.minute !== null) out.push(`${label}: a nest-settlement record has minute ${show(x.minute)} (settlement is not timed yet)`);
  return out;
}

export interface EngineReplay {
  ok: boolean; errors: string[]; transfers: number;
  /** Codex F1 (P2): whether the foraging transfers' TIME order was checked ('untimed_legacy': minute null, not validated) */
  time_validation: 'timed' | 'untimed_legacy' | 'no_foraging' | 'invalid';
  by_cause: Record<string, number>; by_attribution: Record<string, { sugar: number; protein: number }>;
  /** micro-portions taken from the colony ledger by aggregate rules (F01/A08), by cause */
  unattributed_by_cause: Record<string, { sugar: number; protein: number }>;
}

/**
 * Replay one colony-day of engine-recorded transfers from `start` (deep copy taken before the day) to `end`.
 * `sourceIds`: the world's food-source ids that day (a collection or a kill may only name a real source).
 * Issue #61 R3-08: every source and recipient must be a compartment of THIS colony on this day, built here from the
 * start and end colony states and the day's events (independently of the engine's roster): crops / transit loads of
 * workers present at the start or the end; caches of the colony's nests; its own unlocated sugar and metabolism;
 * eggs laid that day (egg_laid) that exist at the end; insects killed that day (insect_predation); storage overflow.
 * Independent review of 7ae0967: a worker is legal only while it exists (foraging phase: present at the start of the
 * day); an unload goes into the carrier's own crop; each kill is credited once, at its site, with its carcass's protein.
 * KNOWN LIMITS (not reconciled; F01/A08, C3-C5): the split of the colony ledger between the metabolized / egg / loss
 * sinks is not compared with the engine's consumption and egg costs; a worker's task (role) is not checked.
 */
/**
 * Timing mode of a colony-day, read from the species parameters as given (independent of the engine's foodTimingFor):
 * the individual activity timeline needs both switches; anything else is the untimed legacy path. Missing or non-boolean
 * switches are treated as timed, the stricter mode.
 */
export function speciesFoodTiming(species: unknown): 'timed' | 'untimed_legacy' {
  const sp = (species ?? {}) as { activity?: { individual_timeline?: unknown }; navigation?: { individual_route_memory?: unknown } };
  return sp.activity?.individual_timeline === false || sp.navigation?.individual_route_memory === false ? 'untimed_legacy' : 'timed';
}
export function replayEngineColonyDay(start: ColonyState, end: ColonyState, events: SimEvent[], day: number, sourceIds: ReadonlySet<string>, timing: 'timed' | 'untimed_legacy' = 'timed'): EngineReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  // independent review of 9888217 (F-d): the event list itself is checked before anything reads it
  if (!Array.isArray(events)) return { ok: false, errors: ['the event list is not an array'], transfers: 0, time_validation: 'invalid', by_cause: {}, by_attribution: {}, unattributed_by_cause: {} };
  const notObjects = events.map((e, i) => (typeof e === 'object' && e !== null ? -1 : i)).filter((i) => i >= 0);
  if (notObjects.length) return { ok: false, errors: notObjects.slice(0, 50).map((i) => `event ${i} is ${JSON.stringify(events[i])}, not an event object`), transfers: 0, time_validation: 'invalid', by_cause: {}, by_attribution: {}, unattributed_by_cause: {} };
  const nestsOf = (c: ColonyState): string[] => [c.nest_node]; // one nest today; a list so several nests can be added
  // a worker is a compartment only while it exists: foraging-phase transfers may name only workers present at the start of
  // the day (eclosions and deaths happen later); settlement transfers may name workers present at the start or the end
  const startWorkers = new Set(start.population.workers.map((w) => w.id));
  const workerIds = new Set([...start.population.workers, ...end.population.workers].map((w) => w.id));
  const nestIds = new Set([...nestsOf(start), ...nestsOf(end)]);
  const laidToday = new Set((events as Any[]).filter((e) => e.type === 'egg_laid').map((e) => String(e.id)));
  const eggIds = new Set(end.population.brood.map((b) => b.id).filter((id) => laidToday.has(id)));
  const killSite = new Map((events as Any[]).filter((e) => e.type === 'insect_predation').map((e) => [String(e.event_id), String(e.site)]));
  const killIds = new Set(killSite.keys());
  // the carcass each kill created (new_food_source caused by that kill): a kill is credited once, with exactly that protein
  const killYield = new Map((events as Any[]).filter((e) => e.type === 'new_food_source' && killIds.has(String(e.caused_by_event_id))).map((e) => [String(e.caused_by_event_id), toMicro(Number(e.protein_portions))]));
  const credited = new Set<string>();
  let curPhase = 'foraging';
  const exists = (r: { kind: string; id: string }): boolean => ({
    crop: () => (curPhase === 'foraging' ? startWorkers : workerIds).has(r.id), in_transit: () => (curPhase === 'foraging' ? startWorkers : workerIds).has(r.id), cache: () => nestIds.has(r.id),
    nest_unlocated: () => r.id === start.id, metabolized: () => r.id === start.id, egg: () => eggIds.has(r.id),
    insect: () => killIds.has(r.id), loss: () => r.id === 'storage_overflow', source: () => sourceIds.has(r.id),
  } as Record<string, () => boolean>)[r.kind]?.() ?? false;
  const xs = engineTransfers(events), by_cause: Record<string, number> = {}, by_attribution: Record<string, { sugar: number; protein: number }> = {}, unattributed_by_cause: Record<string, { sugar: number; protein: number }> = {};
  const cur = new Map<string, number>(), k = (r: { kind: string; id: string }, f: string) => `${r.kind}:${r.id}:${f}`;
  let crops = 0;
  for (const w of start.population.workers) { const v = toMicro(w.crop_cargo_sugar || 0); cur.set(`crop:${w.id}:sugar`, v); crops += v; }
  const unl = `nest_unlocated:${start.id}:sugar`, cache = `cache:${start.nest_node}:protein`;
  cur.set(unl, toMicro(start.stores.sugar) - crops); cur.set(cache, toMicro(start.stores.protein));
  if ((cur.get(unl) as number) < 0) err('start: crops exceed the sugar ledger');
  let phase = 'foraging', settleStep = 0, lastUnload: { worker: string; minute: number | null } | null = null;
  xs.forEach((x, i) => {
    const id = `FT-${day}-${start.id}-${i + 1}`;
    const bad = recordSchemaErrors(x, `transfer ${i + 1}`);
    if (bad.length) { for (const m of bad) err(m); return; } // never use a field of a malformed record
    if (x.transfer_id !== id) err(`transfer ${i + 1}: id ${x.transfer_id}, expected ${id}`);
    if (x.schema !== 'antempire.food-transfer.v1' || x.day !== day || x.colony !== start.id) err(`${x.transfer_id}: schema/day/colony fields wrong`);
    const a = toMicro(x.portions);
    if (!(a > 0) || Math.abs(x.portions * 1e6 - a) > 1e-3) err(`${x.transfer_id}: amount ${x.portions} is not a positive six-decimal portion`);
    const ends = ENDPOINTS[x.cause];
    if (!ends) { err(`${x.transfer_id}: unknown cause ${x.cause}`); return; }
    if (!ends[0].includes(x.source.kind) || !ends[1].includes(x.recipient.kind)) err(`${x.transfer_id}: ${x.cause} from ${x.source.kind} to ${x.recipient.kind} is not a possible path`);
    if (ATTRIBUTION[x.cause] !== x.attribution) err(`${x.transfer_id}: ${x.cause} must have attribution ${ATTRIBUTION[x.cause]}, has ${x.attribution}`);
    for (const r of [x.source, x.recipient]) if (HOLDS[r.kind] && !HOLDS[r.kind].includes(x.food_type)) err(`${x.transfer_id}: ${r.kind} cannot hold ${x.food_type}`);
    curPhase = x.phase;
    if (x.cause === 'unload' && x.recipient.kind === 'crop' && x.recipient.id !== x.source.id) err(`${x.transfer_id}: the transit load of ${x.source.id} is unloaded into the crop of ${x.recipient.id}`);
    if (x.cause === 'prey_kill') {
      if (x.food_type !== 'protein') err(`${x.transfer_id}: a kill yields protein, recorded as ${x.food_type}`);
      if (credited.has(x.source.id)) err(`${x.transfer_id}: kill ${x.source.id} credited twice`);
      credited.add(x.source.id);
      if (killSite.has(x.source.id) && killSite.get(x.source.id) !== x.recipient.id) err(`${x.transfer_id}: kill ${x.source.id} happened at ${killSite.get(x.source.id)}, credited to ${x.recipient.id}`);
      if (killYield.get(x.source.id) !== a) err(`${x.transfer_id}: kill ${x.source.id} credited ${a} µp, its carcass is ${killYield.get(x.source.id)} µp`);
    }
    for (const r of [x.source, x.recipient]) if (!exists(r)) err(`${x.transfer_id}: ${r.kind}:${r.id} is not a compartment of ${start.id} on day ${day} (R3-08)`);
    // phase order
    if (x.phase === 'foraging' && phase !== 'foraging') err(`${x.transfer_id}: foraging transfer after the nest settlement began`);
    if (x.phase === 'nest_settlement') {
      phase = 'nest_settlement';
      const step = SETTLEMENT_ORDER.indexOf(x.cause);
      if (step < 0) err(`${x.transfer_id}: ${x.cause} is not a settlement cause`); else if (step < settleStep) err(`${x.transfer_id}: ${x.cause} out of the engine's settlement order`); else settleStep = step;
    } else if (SETTLEMENT_ORDER.includes(x.cause)) err(`${x.transfer_id}: ${x.cause} recorded in the foraging phase`);
    // trophallaxis causality: at the nest, right after the donor's own unloading at the same minute
    if (x.cause === 'unload') lastUnload = { worker: x.source.id, minute: x.minute };
    else if (x.cause === 'trophallaxis') {
      if (!lastUnload || lastUnload.worker !== x.source.id || lastUnload.minute !== x.minute) err(`${x.transfer_id}: trophallaxis from ${x.source.id} is not part of its own unloading`);
      if (x.contact?.location !== start.nest_node || x.contact?.recipient_location !== start.nest_node) err(`${x.transfer_id}: trophallaxis not at the nest`);
      if (x.source.id === x.recipient.id) err(`${x.transfer_id}: trophallaxis to itself`);
    } else if (x.cause !== 'collect' && x.cause !== 'prey_kill') lastUnload = null;
    // unattributed accounting
    (by_attribution[x.attribution] ??= { sugar: 0, protein: 0 })[x.food_type] += a;
    by_cause[x.cause] = (by_cause[x.cause] ?? 0) + 1;
    if (x.attribution === 'unknown') (unattributed_by_cause[x.cause] ??= { sugar: 0, protein: 0 })[x.food_type] += a;
    // colony compartments (sources are balanced world-wide only by the engine's checkSources)
    if (x.source.kind !== 'source' && x.source.kind !== 'insect' && HOLDS[x.source.kind]) {
      const s = k(x.source, x.food_type), h = cur.get(s) ?? 0;
      if (h < a) err(`${x.transfer_id}: ${s} holds ${h} µp, cannot give ${a}`);
      cur.set(s, h - a);
    }
    if (x.recipient.kind !== 'source' && HOLDS[x.recipient.kind]) cur.set(k(x.recipient, x.food_type), (cur.get(k(x.recipient, x.food_type)) ?? 0) + a);
  });
  for (const kId of killIds) if (!credited.has(kId)) err(`kill ${kId} has no prey_kill transfer`);
  const time_validation = timeCausality(start, xs, err, timing, events as Any[]);
  let endCrops = 0;
  const alive = new Set(end.population.workers.map((w) => w.id));
  for (const w of end.population.workers) {
    const v = toMicro(w.crop_cargo_sugar || 0); endCrops += v;
    if ((cur.get(`crop:${w.id}:sugar`) ?? 0) !== v) err(`crop:${w.id}: state ${v} µp, replay ${cur.get(`crop:${w.id}:sugar`) ?? 0}`);
  }
  // every compartment touched must have a legal end state, not only the expected nest and colony
  for (const [key, v] of cur) {
    if (key.startsWith('in_transit:')) { if (v !== 0) err(`${key}: ${v} µp still in transit`); }
    else if (key.startsWith('crop:')) { if (!alive.has(key.split(':')[1]) && v !== 0) err(`${key}: a worker that is gone still holds ${v} µp`); }
    else if (key !== unl && key !== cache) err(`${key}: ${v} µp at the end of the day in a compartment that has no end state`);
  }
  if ((cur.get(unl) as number) !== toMicro(end.stores.sugar) - endCrops) err(`${unl}: state ${toMicro(end.stores.sugar) - endCrops} µp, replay ${cur.get(unl)}`);
  if ((cur.get(cache) as number) !== toMicro(end.stores.protein)) err(`${cache}: state ${toMicro(end.stores.protein)} µp, replay ${cur.get(cache)}`);
  return { ok: errors.length === 0, errors, transfers: xs.length, time_validation, by_cause, by_attribution, unattributed_by_cause };
}

/**
 * Codex reviews 2026-11-04/05, F1 (P2), written here independently of engine/transfers.ts checkTimedCausality.
 * A foraging record's minute is the event-clock time of the act; at the same minute the order of the records is the order
 * of the acts. Nothing is sorted into a legal order or changed. Rejected:
 *   - on a timed day (mode from the species parameters, speciesFoodTiming — never from the records) any foraging record
 *     with minute null (null is "not timed", never minute 0; nulling every minute does not turn a day into a legacy day);
 *   - a worker whose own records (its transit load or crop) go back in time along the list;
 *   - a carcass collect (contact.prey_event_id) before its kill, or a kill record off the minute of its predation event;
 *   - any colony compartment below zero when the records are taken minute by minute (within a minute in list order):
 *     food used before the act that supplied it.
 * Legacy days (individual timeline off) return 'untimed_legacy': their time order is NOT validated.
 */
function timeCausality(start: ColonyState, xs: EngineTransfer[], err: (m: string) => void, timing: 'timed' | 'untimed_legacy', events: Any[]): EngineReplay['time_validation'] {
  const forage = xs.filter((x) => recordSchemaErrors(x, 'x').length === 0 && x.phase === 'foraging');
  if (forage.length === 0) return 'no_foraging';
  if (timing === 'untimed_legacy') return 'untimed_legacy'; // time order not validated on the legacy path (stated limit)
  const nulls = forage.filter((x) => x.minute === null).length;
  if (nulls > 0) { err(`time: ${nulls} of ${forage.length} foraging records have minute null on a timed (individual timeline) day — an untimed act cannot be placed in time`); return 'invalid'; }
  // a carcass is food only after its kill: the kill record carries the minute of the predation event, and every collect
  // that names the prey comes later (same minute: later in the list) at the kill's site (review of ed32299, N1)
  const kills = new Map<string, { x: EngineTransfer; i: number }>();
  forage.forEach((x, i) => { if (x.cause === 'prey_kill') kills.set(x.source.id, { x, i }); });
  for (const e of events.filter((ev) => ev && ev.type === 'insect_predation')) {
    const k = kills.get(String(e.event_id));
    if (k && k.x.minute !== e.minute) err(`time: kill ${e.event_id} happened at minute ${e.minute} but ${k.x.transfer_id} credits its carcass at minute ${k.x.minute}`);
  }
  forage.forEach((x, i) => {
    const prey = (x as Any).contact?.prey_event_id;
    if (x.cause !== 'collect' || prey === undefined) return;
    const k = kills.get(String(prey));
    if (!k) { err(`time: ${x.transfer_id} takes the carcass of ${prey}, but no kill of ${prey} is recorded`); return; }
    if (k.x.recipient.id !== x.source.id) err(`time: ${x.transfer_id} takes the carcass of ${prey} at ${x.source.id}, the kill was at ${k.x.recipient.id}`);
    if ((x.minute as number) < (k.x.minute as number) || (x.minute === k.x.minute && i < k.i)) err(`time: ${x.transfer_id} at minute ${x.minute} takes the carcass of ${prey} before the kill (${k.x.transfer_id}, minute ${k.x.minute})`);
  });
  // each worker's own acts in time order along the list
  const seen = new Map<string, EngineTransfer>();
  for (const x of forage) {
    for (const w of new Set([x.source, x.recipient].filter((r) => r.kind === 'crop' || r.kind === 'in_transit').map((r) => r.id))) {
      const p = seen.get(w);
      if (p && (x.minute as number) < (p.minute as number)) err(`time: ${x.transfer_id} at minute ${x.minute} follows ${p.transfer_id} at minute ${p.minute} for worker ${w}`);
      seen.set(w, x);
    }
  }
  // minute-by-minute holdings: buckets of records per minute, in list order inside a bucket
  const buckets = new Map<number, EngineTransfer[]>();
  for (const x of forage) { const l = buckets.get(x.minute as number); if (l) l.push(x); else buckets.set(x.minute as number, [x]); }
  const held = new Map<string, number>(), slot = (r: { kind: string; id: string }, f: string) => `${r.kind}:${r.id}:${f}`;
  let crops = 0;
  for (const w of start.population.workers) { const v = toMicro(w.crop_cargo_sugar || 0); held.set(`crop:${w.id}:sugar`, v); crops += v; }
  held.set(`nest_unlocated:${start.id}:sugar`, toMicro(start.stores.sugar) - crops); held.set(`cache:${start.nest_node}:protein`, toMicro(start.stores.protein));
  const colonySide = (r: { kind: string }) => r.kind === 'crop' || r.kind === 'in_transit' || r.kind === 'cache' || r.kind === 'nest_unlocated';
  for (const m of [...buckets.keys()].sort((p, q) => p - q)) for (const x of buckets.get(m)!) {
    const a = toMicro(x.portions);
    if (colonySide(x.source)) {
      const s = slot(x.source, x.food_type), h = held.get(s) ?? 0;
      if (h < a) err(`time: ${x.transfer_id} (${x.cause}, minute ${m}) takes ${a} µp from ${s}, which holds ${h} µp at that minute — food used before it arrived`);
      held.set(s, h - a);
    }
    if (colonySide(x.recipient)) held.set(slot(x.recipient, x.food_type), (held.get(slot(x.recipient, x.food_type)) ?? 0) + a);
  }
  return 'timed';
}

/**
 * World-level time check of the shared food sources (independent review of af6779c), written independently of the
 * engine's checkSources. Nothing changes a source after foraging, so the reader reconstructs each source's holding at the
 * start of foraging from the end state: start = end + everything collected − everything credited by kills (all colonies).
 * Colonies forage one after another in list order; within a timed colony-day the colony's source records are taken
 * minute by minute (same minute: list order), within an untimed legacy day in list order. A source may never be taken
 * below zero — e.g. carcass protein collected before the kill that put it there, whether or not the collect names the prey.
 */
export function replayEngineSourcesDay(endSources: Record<string, { sugar?: number; protein?: number }>, colonies: { id: string; events: SimEvent[]; timing: 'timed' | 'untimed_legacy' }[]): string[] {
  // Codex reviews 2026-11-05 (latest N1; follow-up N1–N3): the caller's objects are read exactly once, into a plain-data
  // snapshot (structuredClone: getters run once, proxies and functions are refused); everything after that reads only the
  // snapshot. Every input is validated before it is used; nothing thrown can escape; every returned line is bounded.
  try {
    let snap: { endSources: unknown; colonies: unknown };
    try { snap = structuredClone({ endSources, colonies }); } catch (e) { return boundLines([`sources: the input cannot be read as plain data (${printable(e)})`]); }
    const invalid = sourceDayInputErrors(snap.endSources, snap.colonies);
    if (invalid.length) return boundLines(invalid, 'input errors');
    return boundLines(replaySources(snap.endSources as Record<string, { sugar?: number; protein?: number }>, snap.colonies as { id: string; events: SimEvent[]; timing: 'timed' | 'untimed_legacy' }[]));
  } catch (e) { return boundLines([`sources: the input cannot be read (${printable(e)})`]); }
}

/** The replay itself, on a validated snapshot. Exact integer micro-portions in BigInt: sums of safe amounts never lose
 * precision (Codex follow-up N1: 2^52 + 2^52 + 1 µp). Start = end + collected − credited; then replayed in time order. */
function replaySources(endSources: Record<string, { sugar?: number; protein?: number }>, colonies: { id: string; events: SimEvent[]; timing: 'timed' | 'untimed_legacy' }[]): string[] {
  const errors: string[] = [], mu = (v: number) => BigInt(toMicro(v));
  const touches = colonies.map((c) => (c.events as Any[]).filter((e) => e.type === 'food_transfer' && (e.source.kind === 'source' || e.recipient.kind === 'source')) as EngineTransfer[]);
  const held = new Map<string, bigint>(), slot = (id: string, f: string) => `${id}|${f}`, get = (k: string) => held.get(k) ?? 0n;
  for (const [id, s] of Object.entries(endSources)) { held.set(slot(id, 'sugar'), mu(s.sugar || 0)); held.set(slot(id, 'protein'), mu(s.protein || 0)); }
  const end = new Map(held);
  for (const x of touches.flat()) {
    const a = mu(x.portions);
    if (x.source.kind === 'source') held.set(slot(x.source.id, x.food_type), get(slot(x.source.id, x.food_type)) + a);
    if (x.recipient.kind === 'source') held.set(slot(x.recipient.id, x.food_type), get(slot(x.recipient.id, x.food_type)) - a);
  }
  for (const [k, v] of held) if (v < 0n) errors.push(`sources: ${show(k)} would have held ${v} µp at the start of foraging`);
  colonies.forEach((c, ci) => {
    let order = touches[ci].map((x, i) => ({ x, i }));
    if (c.timing === 'timed') {
      for (const { x } of order) if (typeof x.minute !== 'number' || !Number.isFinite(x.minute)) errors.push(`sources: ${show(x.transfer_id)} of ${show(c.id)} has no minute on a timed day`);
      order = order.filter(({ x }) => typeof x.minute === 'number').sort((p, q) => (p.x.minute as number) - (q.x.minute as number) || p.i - q.i);
    }
    for (const { x } of order) {
      const a = mu(x.portions);
      if (x.source.kind === 'source') {
        const k = slot(x.source.id, x.food_type), h = get(k);
        if (h < a) errors.push(`sources: ${show(x.transfer_id)} of ${show(c.id)} (minute ${x.minute}) takes ${a} µp from ${show(x.source.id)}, which holds ${h} µp then — food taken before it was there`);
        held.set(k, h - a);
      }
      if (x.recipient.kind === 'source') held.set(slot(x.recipient.id, x.food_type), get(slot(x.recipient.id, x.food_type)) + a);
    }
  });
  // exact arithmetic closes by construction; checked anyway so that any future change to the replay cannot drift silently
  for (const [k, v] of end) if (get(k) !== v) errors.push(`sources: ${show(k)} replays to ${get(k)} µp, the end state says ${v} µp`);
  return errors;
}

/** Input contract of replayEngineSourcesDay (N1): the end-of-day sources, the colony list, every event and every record. */
function sourceDayInputErrors(endSources: unknown, colonies: unknown): string[] {
  const out: string[] = [];
  if (!isObj(endSources)) return [`sources: the end-of-day source table is ${show(endSources)}, not an object`];
  for (const [id, v] of Object.entries(endSources)) {
    if (!isObj(v)) { out.push(`sources: source ${id} is ${show(v)}, not an object`); continue; }
    for (const f of ['sugar', 'protein'] as const) if (v[f] !== undefined && !(typeof v[f] === 'number' && Number.isFinite(v[f]) && (v[f] as number) >= 0 && sixDecimal(v[f] as number))) out.push(`sources: source ${show(id)} ${f} is ${show(v[f])}, not a non-negative number (six-decimal, within exact micro-portion range)`);
  }
  if (!Array.isArray(colonies)) return [...out, `sources: the colony list is ${show(colonies)}, not an array`];
  const ids = new Set<string>();
  for (let i = 0; i < colonies.length; i++) if (!(i in colonies)) out.push(`sources: colony ${i} is a hole in the colony list`);
  colonies.forEach((c: unknown, ci) => {
    if (!isObj(c)) { out.push(`sources: colony ${ci} is ${show(c)}, not an object`); return; }
    const cid = nonEmpty(c.id) ? c.id : `list ${ci}`;
    if (!nonEmpty(c.id)) out.push(`sources: colony ${ci} has no id`);
    else if (ids.has(c.id)) out.push(`sources: colony ${c.id} is listed twice`); else ids.add(c.id);
    if (c.timing !== 'timed' && c.timing !== 'untimed_legacy') out.push(`sources: colony ${cid} timing ${show(c.timing)} is not timed | untimed_legacy`);
    if (!Array.isArray(c.events)) { out.push(`sources: colony ${cid} events is ${show(c.events)}, not an array`); return; }
    for (let i = 0; i < c.events.length; i++) if (!(i in c.events)) out.push(`sources: colony ${cid} event ${i} is a hole in the event list`);
    c.events.forEach((e: unknown, ei) => {
      if (!isObj(e)) { out.push(`sources: colony ${cid} event ${ei} is ${show(e)}, not an event object`); return; }
      if (e.type !== 'food_transfer') return;
      const errs = recordSchemaErrors(e, `colony ${cid} event ${ei}`);
      if (errs.length) { out.push(...errs.map((m) => `sources: ${m}`)); return; }
      const x = e as unknown as EngineTransfer, at = `sources: ${x.transfer_id} (colony ${cid})`;
      if (!exactMicro(x.portions)) out.push(`${at}: portions ${show(x.portions)} is below one micro-portion or not a six-decimal amount`);
      if (x.colony !== cid) out.push(`${at} is recorded for colony ${x.colony}`);
      if (x.source.kind !== 'source' && x.recipient.kind !== 'source') return;
      // a source is only collected from or credited by a kill, during foraging (same paths as the colony reader)
      const legal = (x.cause === 'collect' && x.source.kind === 'source' && x.recipient.kind === 'in_transit') || (x.cause === 'prey_kill' && x.source.kind === 'insect' && x.recipient.kind === 'source');
      if (!legal) out.push(`${at}: ${x.cause} ${x.source.kind} -> ${x.recipient.kind} is not a collection or a kill`);
      const sid = x.source.kind === 'source' ? x.source.id : x.recipient.id;
      if (!Object.hasOwn(endSources, sid)) out.push(`${at}: source ${sid} is not a food source of this world (not in the end-of-day source table)`);
    });
  });
  return out;
}
