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
  if (x.schema !== 'antempire.food-transfer.v1') out.push(`${label}: schema ${JSON.stringify(x.schema)} is not antempire.food-transfer.v1`);
  if (!Number.isInteger(x.day)) out.push(`${label}: day ${JSON.stringify(x.day)} is not an integer`);
  if (!nonEmpty(x.colony)) out.push(`${label}: colony missing or not a string`);
  if (x.phase !== 'foraging' && x.phase !== 'nest_settlement') out.push(`${label}: phase ${JSON.stringify(x.phase)} is not a defined phase (foraging | nest_settlement)`);
  if (typeof x.cause !== 'string' || !Object.hasOwn(PHASE_OF_CAUSE, x.cause)) out.push(`${label}: unknown cause ${JSON.stringify(x.cause)}`);
  else if ((x.phase === 'foraging' || x.phase === 'nest_settlement') && PHASE_OF_CAUSE[x.cause] !== x.phase) out.push(`${label}: ${x.cause} belongs to phase ${PHASE_OF_CAUSE[x.cause]}, recorded as ${x.phase}`);
  for (const side of ['source', 'recipient'] as const) {
    const r = x[side];
    if (!isObj(r)) { out.push(`${label}: ${side} missing or not an object`); continue; } // isObj excludes arrays
    if (typeof r.kind !== 'string' || !KINDS.has(r.kind)) out.push(`${label}: ${side} kind ${JSON.stringify(r.kind)} is not a compartment kind`);
    if (!nonEmpty(r.id)) out.push(`${label}: ${side} id ${JSON.stringify(r.id)} is not a non-empty string`);
  }
  if (x.food_type !== 'sugar' && x.food_type !== 'protein') out.push(`${label}: food_type ${JSON.stringify(x.food_type)} is not sugar or protein`);
  if (typeof x.portions !== 'number' || !Number.isFinite(x.portions) || !(x.portions > 0)) out.push(`${label}: portions ${JSON.stringify(x.portions)} is not a positive finite number`);
  if (!ATTRIBUTIONS.has(x.attribution as string)) out.push(`${label}: attribution ${JSON.stringify(x.attribution)} is not defined`);
  if (Array.isArray(x)) out.push(`${label}: the record is an array, not an object`);
  if (x.phase === 'foraging' && !(x.minute === null || (typeof x.minute === 'number' && Number.isFinite(x.minute) && x.minute >= 0 && x.minute <= 1440))) out.push(`${label}: minute ${JSON.stringify(x.minute)} is not null or a minute of the day (0..1440)`);
  if (x.phase === 'nest_settlement' && x.minute !== null) out.push(`${label}: a nest-settlement record has minute ${JSON.stringify(x.minute)} (settlement is not timed yet)`);
  return out;
}

export interface EngineReplay {
  ok: boolean; errors: string[]; transfers: number;
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
export function replayEngineColonyDay(start: ColonyState, end: ColonyState, events: SimEvent[], day: number, sourceIds: ReadonlySet<string>): EngineReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  // independent review of 9888217 (F-d): the event list itself is checked before anything reads it
  if (!Array.isArray(events)) return { ok: false, errors: ['the event list is not an array'], transfers: 0, by_cause: {}, by_attribution: {}, unattributed_by_cause: {} };
  const notObjects = events.map((e, i) => (typeof e === 'object' && e !== null ? -1 : i)).filter((i) => i >= 0);
  if (notObjects.length) return { ok: false, errors: notObjects.slice(0, 50).map((i) => `event ${i} is ${JSON.stringify(events[i])}, not an event object`), transfers: 0, by_cause: {}, by_attribution: {}, unattributed_by_cause: {} };
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
  return { ok: errors.length === 0, errors, transfers: xs.length, by_cause, by_attribution, unattributed_by_cause };
}
