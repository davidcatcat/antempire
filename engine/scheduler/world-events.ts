/**
 * P0-A0 — shared WORLD EVENT SCHEDULER (engineering foundation only; docs/p0a0-world-event-scheduler.md).
 *
 * Status: ISOLATED. Not used by simulateWorldDay() or any official pipeline (tests/scheduler-isolation.test.ts), not in
 * the rules fingerprint (cli/lib/fingerprint.ts covers engine/*.ts only). Wiring it into the day loop is a later
 * rules-update PR. This module is NOT 24-hour ecology: no behaviour, no species parameter, no environment, no random draw.
 *
 * Guarantees
 *  - World time = (day, minute): day an integer >= 0, minute in [0, 1440) on a fixed grid of TICKS_PER_MINUTE ticks.
 *    Every time is canonicalised to that grid, so "the same instant" is integer equality of ticks, never float luck
 *    (0.1 + 0.2 and 0.3 are the same instant). Delays are quantised to ticks before they are added.
 *  - Processing order is a pure function of the events: (day, tick, round, id). `round` is the causal depth inside one
 *    instant (a child at its cause's instant runs in the next round); `id` is canonical (cause id + kind + producer key),
 *    never insertion order or the position of a colony / worker in an array. (engine/activity.ts falls back to FIFO
 *    insertion order on ties; this scheduler removes that dependency. Migration: design doc §6.)
 *  - All events of one (instant, round) are delivered TOGETHER as one batch. The batch's id order is for deterministic
 *    logging only; the scheduler does not decide who wins a simultaneous contest (feeding, attack, collection,
 *    yielding …) and accepts no priority. Handlers must treat a batch as a set; same-instant competition rules are
 *    undecided biology and are NOT implemented here.
 *  - Causality: nothing may be scheduled before its cause or before the clock; a batch cannot cancel its own events; a
 *    world input (root event) cannot be added at an instant that is already being processed (that would silently
 *    order it after events it is simultaneous with), nor on a day already closed by runDay(). While a handler runs, the
 *    scheduler refuses re-entry.
 *  - Exactly once: every event ends executed or cancelled, never both, never twice, never dropped (audit(), verifyLog()).
 *  - Each batch is atomic. Readers get frozen copies, never internal objects.
 *  - Illegal times, ids, kinds, references, payloads, transitions and snapshots are refused, never repaired. The one
 *    normalisation is QUANTISATION to the tick grid (documented, deterministic): a minute or delay below half a tick
 *    becomes 0 (a child then lands in the next round of the same instant).
 */

export const MINUTES_PER_DAY = 1440;
/** time resolution of the world tick: 1e-6 minute (60 µs), the engine's rounding grid (engine/math.ts round) — an
 *  engineering choice. The tick is a LABEL; under the layered contract the order also uses the exact native time. */
export const TICKS_PER_MINUTE = 1_000_000;
const TICKS_PER_DAY = MINUTES_PER_DAY * TICKS_PER_MINUTE;
/** one tick in microseconds (1 minute = 6e7 µs) */
export const TICK_US = 60;
export const US_PER_DAY = 86_400_000_000;
export const SCHEDULER_SNAPSHOT_SCHEMA = 'antempire.world-scheduler.v2';

export interface WorldTime { day: number; minute: number }
/** who: world always; colony / individual null when the event is not about one */
export interface EntityRef { world: string; colony: string | null; individual: string | null }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type EventState = 'scheduled' | 'executed' | 'cancelled';

/*
 * TIME CONTRACT (docs/p0a0-time-contract.md). Every event keeps the time its producer gave (NATIVE time: a named clock,
 * its unit, the world instant its zero sits at, and the native value t) and the quantised world tick (`at`, a label).
 * EXACT time = the native time as microseconds since 00:00 of a world day, held as an unevaluated sum us + us_lo of two
 * doubles (error-free products and sums), so two distinct native values never become equal by conversion.
 *  - order 'tick'   (#116 contract): order (day, tick, round, id). Distinct exact instants inside one tick are MERGED
 *                   into one batch; every such merge, and every batch that truly happened before an event already
 *                   executed (an inversion), is DETECTED and reported (timeReport(), ctx.distinct_instants) — or refused
 *                   with on_conflict 'refuse'. Never silently merged.
 *  - order 'layered': order (exact instant, round, id); the tick is only a label. A batch is the set of events at one
 *                   exact instant: no two distinct native instants share a batch, no order is changed by rounding.
 * Neither contract decides a contest between truly simultaneous events (same exact instant): that rule is open.
 */
export type TimeOrder = 'tick' | 'layered';
export type ConflictPolicy = 'report' | 'refuse';
export type NativeUnit = 'min' | 's';
/** the producer's own time: `t` units of `unit` after `anchor` (a world instant on the tick grid) on clock `clock` */
export interface NativeTime { clock: string; unit: NativeUnit; anchor: WorldTime; t: number }
/** exact instant: day, and microseconds since its 00:00 as the unevaluated double-double us + us_lo (normalised) */
export interface ExactTime { day: number; us: number; us_lo: number }

/** what a producer asks for; the scheduler assigns id, cause, round and state. Give EITHER `at` (a world minute, kept
 *  as native time on clock 'world') OR `native` (the producer's own clock), never both. */
export interface EventSpec {
  kind: string;
  /** unique among the events of the same kind with the same cause; must come from entity ids, not array positions */
  key: string;
  at?: WorldTime;
  native?: NativeTime;
  scope: EntityRef;
  source: EntityRef | null;
  target: EntityRef | null;
  payload?: JsonValue;
}
export interface WorldEvent {
  id: string; kind: string; key: string;
  /** quantised world tick (label) */
  at: WorldTime;
  /** the time as the producer gave it (provenance) */
  native: NativeTime;
  /** the native time as an exact world instant */
  exact: ExactTime;
  round: number;
  scope: EntityRef; source: EntityRef | null; target: EntityRef | null; payload: JsonValue;
  cause: string | null; state: EventState;
  cancelled_by: string | null; cancel_reason: string | null;
}
export interface Cancel { id: string; reason: string }
/** what a step handler returns: children (each naming its cause in the batch) and cancellations of other pending events */
export interface StepOutput { children?: { cause: string; spec: EventSpec }[]; cancel?: Cancel[] }
/** distinct_instants > 1 only under order 'tick': the batch merged that many distinct exact instants (reported) */
export interface BatchContext { at: WorldTime; round: number; exact: ExactTime; distinct_instants: number }
export type Handler = (batch: readonly Readonly<WorldEvent>[], ctx: BatchContext) => StepOutput | void;
export interface LogEntry { seq: number; id: string; kind: string; at: WorldTime; exact: ExactTime; round: number; cause: string | null; state: 'executed' | 'cancelled'; by: string | null; reason: string | null }
/** a batch that merged distinct exact instants into one tick (order 'tick' only) */
export interface MergeRecord { at: WorldTime; round: number; ids: string[]; distinct_instants: number; span_us: number }
/** a batch with an event that truly happened before an event already executed (order changed by quantisation) */
export interface InversionRecord { at: WorldTime; round: number; ids: string[]; earlier_than: string; by_us: number }
export interface TimeReport { order: TimeOrder; on_conflict: ConflictPolicy; merges: MergeRecord[]; inversions: InversionRecord[] }
export interface TimeOptions { order?: TimeOrder; on_conflict?: ConflictPolicy }

export class SchedulerError extends Error { constructor(msg: string) { super(`WORLD_SCHEDULER: ${msg}`); this.name = 'SchedulerError'; } }
const fail = (msg: string): never => { throw new SchedulerError(msg); };

// ------------------------------------------------------------------ exact arithmetic (error-free transformations)
const SPLITTER = 134_217_729; // 2^27 + 1 (Dekker)
const twoSum = (a: number, b: number): [number, number] => { const s = a + b, bb = s - a; return [s, (a - (s - bb)) + (b - bb)]; };
const splitD = (a: number): [number, number] => { const c = SPLITTER * a, hi = c - (c - a); return [hi, a - hi]; };
/** a * b = p + e exactly (Dekker / Veltkamp; no overflow for the magnitudes used here) */
const twoProd = (a: number, b: number): [number, number] => { const p = a * b, [ah, al] = splitD(a), [bh, bl] = splitD(b); return [p, ((ah * bh - p) + ah * bl + al * bh) + al * bl]; };
const LIMIT = 2 ** 52;
/**
 * The integer nearest to (hi + lo) * n / d, ties upwards, for a normalised double-double hi + lo >= 0 and positive
 * integers n, d (|hi * n| < 2^52). The residual hi*n - q*d is exact (Sterbenz), so the rounding is correct for the
 * real value, not for its double approximation.
 */
export function nearestDiv(hi: number, lo: number, n: number, d: number): number {
  let [a, b] = twoProd(hi, n); [a, b] = twoSum(a, b + lo * n);
  if (!(Math.abs(a) < LIMIT)) fail(`time value ${hi} x ${n} outside the exactly representable range`);
  const q0 = Math.round(a / d), s = a - q0 * d;
  if (s > d / 2 || (s === d / 2 && b >= 0)) return q0 + 1;
  if (s < -d / 2 || (s === -d / 2 && b < 0)) return q0 - 1;
  return q0;
}

// ------------------------------------------------------------------ time
/** the tick nearest to the exact real value minute * TICKS_PER_MINUTE (ties up): |tick - minute*1e6| <= 0.5 exactly */
const toTick = (minute: number) => { const [p, e] = twoProd(minute, TICKS_PER_MINUTE); return nearestDiv(p, e, 1, 1); };
/** refuses an illegal time; a legal one is returned on the tick grid (minute rounding to 1440 is refused, not wrapped) */
export function checkTime(t: WorldTime, what = 'time'): WorldTime {
  if (t === null || typeof t !== 'object') fail(`${what} is not a world time`);
  if (!Number.isSafeInteger(t.day) || t.day < 0) fail(`${what}: day must be an integer >= 0 (got ${t.day})`);
  if (typeof t.minute !== 'number' || !Number.isFinite(t.minute) || t.minute < 0 || t.minute >= MINUTES_PER_DAY) fail(`${what}: minute must be finite and in [0, ${MINUTES_PER_DAY}) (got ${t.minute})`);
  const k = toTick(t.minute);
  if (k >= TICKS_PER_DAY) fail(`${what}: minute ${t.minute} rounds to 24:00 on the ${TICKS_PER_MINUTE}-per-minute grid; write it as the next day's 0`);
  return { day: t.day, minute: k / TICKS_PER_MINUTE };
}
const isCanonical = (t: WorldTime) => toTick(t.minute) / TICKS_PER_MINUTE === t.minute;
export const compareTime = (a: WorldTime, b: WorldTime): number => a.day - b.day || toTick(a.minute) - toTick(b.minute);
/**
 * t + dm minutes (dm finite, >= 0, quantised to the tick grid), carrying across midnight. LEGACY HELPER: the delay is
 * rounded on its own, so a chain of delays can land up to one tick away from its true time and before an event that
 * truly came first (docs/p0a0-time-contract.md §4). Producers with a native clock use addNative instead.
 */
export function addMinutes(t: WorldTime, dm: number): WorldTime {
  const c = checkTime(t);
  if (typeof dm !== 'number' || !Number.isFinite(dm) || dm < 0) fail(`addMinutes: delay must be finite and >= 0 (got ${dm})`);
  const total = toTick(c.minute) + toTick(dm), day = c.day + Math.floor(total / TICKS_PER_DAY), tick = total % TICKS_PER_DAY;
  if (!Number.isSafeInteger(day) || !Number.isSafeInteger(total)) fail('addMinutes: result outside the representable range');
  return { day, minute: tick / TICKS_PER_MINUTE };
}

const NAME_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const UNIT_US: Record<NativeUnit, number> = { min: 60_000_000, s: 1_000_000 };
/** refuses an illegal native time (exactly clock, unit, anchor, t; anchor on the tick grid; t finite and >= 0) */
export function checkNative(n: NativeTime, what = 'native'): NativeTime {
  if (n === null || typeof n !== 'object') fail(`${what} is not a native time`);
  const keys = Object.keys(n).sort().join();
  if (keys !== 'anchor,clock,t,unit') fail(`${what} must have exactly clock, unit, anchor, t (got ${keys})`);
  if (!(typeof n.clock === 'string' && NAME_RE.test(n.clock))) fail(`${what}.clock must be a plain id`);
  if (n.unit !== 'min' && n.unit !== 's') fail(`${what}.unit must be 'min' or 's'`);
  const a = checkTime(n.anchor, `${what}.anchor`); if (a.minute !== n.anchor.minute) fail(`${what}.anchor must lie on the tick grid`);
  if (typeof n.t !== 'number' || !Number.isFinite(n.t) || n.t < 0) fail(`${what}.t must be finite and >= 0 (got ${n.t})`);
  if (!(n.t * UNIT_US[n.unit] < LIMIT / 2)) fail(`${what}.t too large to be held exactly`);
  return { clock: n.clock, unit: n.unit, anchor: { day: a.day, minute: a.minute }, t: n.t + 0 };
}
/** the native time of a plain world minute: clock 'world', unit 'min', anchored at 00:00 of its day */
export const nativeOfWorld = (t: WorldTime): NativeTime => ({ clock: 'world', unit: 'min', anchor: { day: t.day, minute: 0 }, t: t.minute + 0 });
/** native t + dt in the producer's own clock (the producer's arithmetic; nothing is rounded to ticks) */
export function addNative(n: NativeTime, dt: number): NativeTime {
  const c = checkNative(n);
  if (typeof dt !== 'number' || !Number.isFinite(dt) || dt < 0) fail(`addNative: delay must be finite and >= 0 (got ${dt})`);
  return checkNative({ ...c, t: c.t + dt });
}
/** the exact instant of a (checked) native time: error-free, carried across midnight */
export function exactOf(n: NativeTime): ExactTime {
  const c = checkNative(n);
  const [p, e] = twoProd(c.t, UNIT_US[c.unit]);
  let [hi, lo] = twoSum(toTick(c.anchor.minute) * TICK_US, p); [hi, lo] = twoSum(hi, lo + e);
  let day = c.anchor.day;
  const k = Math.floor(hi / US_PER_DAY);
  if (k !== 0) { const [h, x] = twoSum(hi, -k * US_PER_DAY); [hi, lo] = twoSum(h, lo + x); day += k; }
  if (hi < 0) { const [h, x] = twoSum(hi, US_PER_DAY); [hi, lo] = twoSum(h, lo + x); day -= 1; }
  else if (hi > US_PER_DAY || (hi === US_PER_DAY && lo >= 0)) { const [h, x] = twoSum(hi, -US_PER_DAY); [hi, lo] = twoSum(h, lo + x); day += 1; }
  if (!Number.isSafeInteger(day)) fail('native time outside the representable range');
  return { day, us: hi + 0, us_lo: lo + 0 };
}
export const exactOfWorld = (t: WorldTime): ExactTime => exactOf(nativeOfWorld(checkTime(t)));
export const compareExact = (a: ExactTime, b: ExactTime): number => a.day - b.day || a.us - b.us || a.us_lo - b.us_lo;
const sameExact = (a: ExactTime, b: ExactTime) => a.day === b.day && a.us === b.us && a.us_lo === b.us_lo;
/**
 * The world tick (label) of an exact instant: the nearest tick, ties up; |label - exact| <= 30 µs (half a tick).
 * 'tick' refuses an instant that rounds to 24:00 (#116 rule); 'layered' keeps it in its own day on the last tick
 * (error then < 60 µs) because its day is decided by the exact instant.
 */
export function labelOf(x: ExactTime, order: TimeOrder): WorldTime {
  let q = nearestDiv(x.us, x.us_lo, 1, TICK_US);
  if (q >= TICKS_PER_DAY) { if (order === 'tick') fail(`instant d${x.day}+${x.us}us rounds to 24:00 on the tick grid; give it as the next day's 0`); q = TICKS_PER_DAY - 1; }
  return { day: x.day, minute: q / TICKS_PER_MINUTE };
}
/** label minus exact instant, in µs (a double: for reports) */
export const quantisationErrorUs = (label: WorldTime, x: ExactTime): number => ((label.day - x.day) * US_PER_DAY + toTick(label.minute) * TICK_US - x.us) - x.us_lo;
const spanUs = (a: ExactTime, b: ExactTime): number => ((b.day - a.day) * US_PER_DAY + (b.us - a.us)) + (b.us_lo - a.us_lo);
/**
 * Name of the random stream a PRODUCER should draw from for one event (the scheduler draws nothing): world, the event's
 * canonical id and a purpose word. Derived from content, never from processing order or a shared sequential stream.
 */
export function rngStreamName(world: string, eventId: string, purpose: string): string {
  if (!NAME_RE.test(world) || !/^[A-Za-z0-9._:/-]{1,4096}$/.test(eventId) || !/^[a-z][a-z0-9_]{0,63}$/.test(purpose)) fail('rngStreamName: world, event id and purpose must be plain ids');
  return `rng/${world}/${eventId}#${purpose}`;
}

// ------------------------------------------------------------------ validation
const KIND_RE = /^[a-z][a-z0-9_]{0,63}$/, KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function checkRef(r: EntityRef | null, what: string, world: string, nullable: boolean): void {
  if (r === null || r === undefined) { if (!nullable) fail(`${what} is required`); if (r === undefined) fail(`${what} must be an entity reference or null`); return; }
  if (typeof r !== 'object') fail(`${what} is not an entity reference`);
  const keys = Object.keys(r).sort().join();
  if (keys !== 'colony,individual,world') fail(`${what} must have exactly world, colony, individual (got ${keys})`);
  if (r.world !== world) fail(`${what}.world ${r.world} is not this world (${world})`);
  for (const k of ['colony', 'individual'] as const) if (r[k] !== null && !(typeof r[k] === 'string' && NAME_RE.test(r[k] as string))) fail(`${what}.${k} must be null or a plain id`);
  if (r.individual !== null && r.colony === null) fail(`${what}: an individual must belong to a colony`);
}
function checkJson(v: unknown, path: string, depth = 0): void {
  if (depth > 32) fail(`payload too deep at ${path}`);
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
  if (typeof v === 'number') { if (!Number.isFinite(v)) fail(`payload ${path} is not a finite number`); return; }
  if (Array.isArray(v)) { v.forEach((x, i) => checkJson(x, `${path}[${i}]`, depth + 1)); return; }
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) { for (const [k, x] of Object.entries(v as object)) checkJson(x, `${path}.${k}`, depth + 1); return; }
  fail(`payload ${path} is not JSON data`);
}
/*
 * SINGLE-READ COPIES (Owner P2 2026-11-07, #116): producer objects may carry getters or be proxies, so a value read
 * twice can differ (validated once, committed as something else). Every input is read EXACTLY ONCE into plain data,
 * and only that copy is validated and committed.
 */
/** limits on what a producer may hand over (engineering bounds, not model parameters) */
export const MAX_PAYLOAD_NODES = 100_000, MAX_OUTPUT_ITEMS = 100_000;
const isPlain = (v: unknown) => { if (v === null || typeof v !== 'object') return false; const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };
/** own property names, enumerable or not (a non-enumerable field is never silently dropped); symbols refused */
function ownKeys(v: object, what: string): string[] {
  if (Object.getOwnPropertySymbols(v).length) fail(`${what} has symbol keys`);
  return Object.getOwnPropertyNames(v);
}
function copyJson(v: unknown, path: string, budget = { n: 0 }, depth = 0): JsonValue {
  if (++budget.n > MAX_PAYLOAD_NODES) fail(`payload has more than ${MAX_PAYLOAD_NODES} values`);
  if (depth > 32) fail(`payload too deep at ${path}`);
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') { if (!Number.isFinite(v)) fail(`payload ${path} is not a finite number`); return v; }
  if (Array.isArray(v)) {
    const n = v.length;
    if (!Number.isSafeInteger(n) || n > MAX_PAYLOAD_NODES) fail(`payload ${path} array too long`);
    const out: JsonValue[] = [];
    for (let i = 0; i < n; i++) { if (!(i in v)) fail(`payload ${path}[${i}] is a hole`); out.push(copyJson(v[i], `${path}[${i}]`, budget, depth + 1)); }
    return out;
  }
  if (isPlain(v)) {
    const out: Record<string, JsonValue> = {};
    // defineProperty: a key named "__proto__" stays an ordinary key (assignment would set the prototype)
    for (const k of ownKeys(v as object, `payload ${path}`)) Object.defineProperty(out, k, { value: copyJson((v as Record<string, unknown>)[k], `${path}.${k}`, budget, depth + 1), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return fail(`payload ${path} is not JSON data`);
}
function copyRef(r: unknown, what: string): EntityRef | null {
  if (r === null) return null;
  if (!isPlain(r)) return fail(`${what} must be an entity reference or null`);
  const keys = ownKeys(r as object, what).sort().join();
  if (keys !== 'colony,individual,world') fail(`${what} must have exactly world, colony, individual (got ${keys})`);
  const o = r as Record<string, unknown>;
  return { world: o.world as string, colony: o.colony as string | null, individual: o.individual as string | null };
}
function copyNative(v: unknown): NativeTime {
  if (!isPlain(v)) return fail('event spec native is not a native time');
  const keys = ownKeys(v as object, 'native').sort().join();
  if (keys !== 'anchor,clock,t,unit') fail(`native must have exactly clock, unit, anchor, t (got ${keys})`);
  const o = v as Record<string, unknown>, an = o.anchor;
  if (!isPlain(an)) fail('native anchor is not a world time');
  const a = an as Record<string, unknown>;
  return { clock: o.clock as string, unit: o.unit as NativeUnit, anchor: { day: a.day as number, minute: a.minute as number }, t: o.t as number };
}
function copySpec(spec: unknown): EventSpec {
  if (!isPlain(spec)) return fail('event spec must be a plain object');
  const allowed = new Set(['kind', 'key', 'at', 'native', 'scope', 'source', 'target', 'payload']), keys = ownKeys(spec as object, 'event spec');
  for (const k of keys) if (!allowed.has(k)) fail(`event spec has an unknown field ${k}`);
  const o = spec as Record<string, unknown>;
  const hasAt = keys.includes('at'), hasNative = keys.includes('native');
  if (hasAt && hasNative) fail('event spec gives both at and native: give one (the tick label is derived from native)');
  const out: EventSpec = { kind: o.kind as string, key: o.key as string, scope: undefined as unknown as EntityRef, source: null, target: null };
  if (hasNative) out.native = copyNative(o.native);
  else {
    const at = o.at;
    if (!isPlain(at)) fail('event spec at is not a world time');
    const a = at as Record<string, unknown>;
    out.at = { day: a.day as number, minute: a.minute as number };
  }
  out.scope = copyRef(o.scope, 'scope') as EntityRef; out.source = copyRef(o.source, 'source'); out.target = copyRef(o.target, 'target');
  if (keys.includes('payload')) { const pv = o.payload; out.payload = pv === undefined ? null : copyJson(pv, 'payload'); }   // explicit undefined = no payload (null)
  return out;
}
function copyList(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) return fail(`${what} must be an array`);
  const n = v.length;
  if (!Number.isSafeInteger(n) || n > MAX_OUTPUT_ITEMS) fail(`${what} has more than ${MAX_OUTPUT_ITEMS} items`);
  const out: unknown[] = []; for (let i = 0; i < n; i++) out.push(v[i]); return out;
}
/** a handler must return undefined or a plain { children?, cancel? }: a Promise, a misspelt field or any other shape is refused */
function copyOutput(out: unknown): { children: { cause: string; spec: EventSpec }[]; cancel: Cancel[] } {
  if (out === undefined) return { children: [], cancel: [] };
  if (!isPlain(out)) return fail('handler output must be undefined or a plain object { children?, cancel? } (an async handler is not allowed)');
  const keys = ownKeys(out as object, 'handler output');
  for (const k of keys) if (k !== 'children' && k !== 'cancel') fail(`handler output has an unknown field ${k}`);
  const o = out as Record<string, unknown>, ch = keys.includes('children') ? o.children : undefined, ca = keys.includes('cancel') ? o.cancel : undefined;
  const children: { cause: string; spec: EventSpec }[] = [], cancel: Cancel[] = [];
  if (ch !== undefined) for (const c of copyList(ch, 'children')) {
    if (!isPlain(c)) fail('a child must be a plain { cause, spec }');
    const ks = ownKeys(c as object, 'child').sort().join(); if (ks !== 'cause,spec') fail(`a child must have exactly cause, spec (got ${ks})`);
    const r = c as Record<string, unknown>; children.push({ cause: r.cause as string, spec: copySpec(r.spec) });
  }
  if (ca !== undefined) for (const c of copyList(ca, 'cancel')) {
    if (!isPlain(c)) fail('a cancel needs an id and a non-empty reason');
    const ks = ownKeys(c as object, 'cancel').sort().join(); if (ks !== 'id,reason') fail(`a cancel must have exactly id, reason (got ${ks})`);
    const r = c as Record<string, unknown>; cancel.push({ id: r.id as string, reason: r.reason as string });
  }
  return { children, cancel };
}
const canonJson = (v: JsonValue): JsonValue => (Array.isArray(v) ? v.map(canonJson) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonJson((v as Record<string, JsonValue>)[k])])) : v); // fromEntries keeps a "__proto__" key
const deepFreeze = <T>(v: T): T => { if (v && typeof v === 'object') { for (const x of Object.values(v as object)) deepFreeze(x); Object.freeze(v); } return v; };
/** a frozen deep copy for readers (internal objects never leave the scheduler) */
const view = <T>(v: T): T => deepFreeze(JSON.parse(JSON.stringify(v)) as T);
const EVENT_FIELDS = 'at,cancel_reason,cancelled_by,cause,exact,id,key,kind,native,payload,round,scope,source,state,target';

// ------------------------------------------------------------------ ordering (binary heap)
const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** the instant used for ordering: the tick label ('tick') or the exact instant ('layered') */
const slotCompare = (order: TimeOrder) => order === 'tick'
  ? (a: WorldEvent, b: WorldEvent) => compareTime(a.at, b.at)
  : (a: WorldEvent, b: WorldEvent) => compareExact(a.exact, b.exact);
class Heap {
  private h: WorldEvent[] = [];
  private readonly cmp: (a: WorldEvent, b: WorldEvent) => number;
  constructor(cmp: (a: WorldEvent, b: WorldEvent) => number) { this.cmp = cmp; }
  get size() { return this.h.length; }
  peek(): WorldEvent | undefined { return this.h[0]; }
  push(e: WorldEvent) { const h = this.h; h.push(e); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (this.cmp(h[i], h[p]) >= 0) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } }
  pop(): WorldEvent | undefined {
    const h = this.h; if (!h.length) return undefined; const top = h[0], last = h.pop()!;
    if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && this.cmp(h[l], h[m]) < 0) m = l; if (r < h.length && this.cmp(h[r], h[m]) < 0) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } }
    return top;
  }
}

export interface SchedulerSnapshot {
  schema: string; world: string;
  time: { order: TimeOrder; on_conflict: ConflictPolicy };
  clock: { at: WorldTime; round: number; started: boolean; closed_day: number };
  log_seq: number;
  events: WorldEvent[];
}

export class WorldScheduler {
  readonly world: string;
  readonly order: TimeOrder;
  readonly onConflict: ConflictPolicy;
  private clockAt: WorldTime; private clockRound = -1; private started = false;
  /** latest exact instant executed so far (and its event): the clock of 'layered', the inversion detector of 'tick' */
  private maxExact: ExactTime | null = null; private maxExactId: string | null = null;
  private events = new Map<string, WorldEvent>();
  private heap: Heap;
  private readonly slot: (a: WorldEvent, b: WorldEvent) => number;
  private logEntries: LogEntry[] = [];
  private merges: MergeRecord[] = []; private inversions: InversionRecord[] = [];
  private seq = 0;
  /** events already executed or cancelled when this instance was restored (their log entries belong to the earlier segment) */
  private finishedAtRestore = 0;
  /** the operation that currently holds the scheduler (handler call, or reading a caller's object), else null */
  private busy: string | null = null;
  /** last day closed by runDay() (-1: none); nothing may be scheduled on or before it */
  private closedDay = -1;
  /** called inside step() after a batch's output is validated and before the scheduler commits (see setCommitHook) */
  private commitHook: ((ids: readonly string[], handler: Handler) => void) | null = null;

  /** start: the earliest instant anything may be scheduled at. time.order: 'tick' (default, the #116 contract) or 'layered'. */
  constructor(world: string, start: WorldTime = { day: 0, minute: 0 }, time: TimeOptions = {}) {
    if (!(typeof world === 'string' && NAME_RE.test(world))) fail('world id must be a plain id');
    if (time === null || typeof time !== 'object' || Object.keys(time).some((k) => k !== 'order' && k !== 'on_conflict')) fail('time options must be { order?, on_conflict? }');
    const order = time.order ?? 'tick', oc = time.on_conflict ?? 'report';
    if (order !== 'tick' && order !== 'layered') fail(`time order must be 'tick' or 'layered' (got ${order})`);
    if (oc !== 'report' && oc !== 'refuse') fail(`on_conflict must be 'report' or 'refuse' (got ${oc})`);
    this.world = world; this.order = order; this.onConflict = oc; this.clockAt = checkTime(start, 'start');
    const cmp = slotCompare(order);
    this.slot = cmp; this.heap = new Heap((a, b) => cmp(a, b) || a.round - b.round || byId(a, b));
  }

  private guard(op: string): void {
    if (this.busy === null) return;
    if (this.busy === 'step') fail(`${op} called from inside a batch handler or while its output is read: return children / cancellations instead`);
    fail(`${op} called while ${this.busy} is reading its input (a getter or proxy may not re-enter the scheduler)`);
  }
  /** run fn holding the scheduler: any re-entry (from a handler, a getter, a proxy trap or toString) is refused until fn ends */
  private exclusive<T>(op: string, fn: () => T): T {
    this.guard(op); this.busy = op;
    try { return fn(); } finally { this.busy = null; }
  }
  /**
   * Let a holder of state OUTSIDE the scheduler (e.g. the environment clock) commit that state in the same atomic step
   * as the batch: the hook receives the sorted ids of the batch and the handler that produced the output, after the
   * handler returned and its output passed validation, and before the scheduler commits. If the hook throws, the batch
   * goes back and the scheduler is unchanged; the hook itself must apply its change last (e.g. one assignment). Not part
   * of a snapshot: whoever restores a scheduler sets its hook again. Re-entry from the hook is refused like a handler's.
   */
  setCommitHook(fn: ((ids: readonly string[], handler: Handler) => void) | null): void {
    this.guard('setCommitHook');
    if (fn !== null && typeof fn !== 'function') fail('commit hook must be a function or null');
    this.commitHook = fn;
  }
  get clock(): { at: WorldTime; round: number } { return { at: { ...this.clockAt }, round: this.clockRound }; }
  /** a frozen copy of this instance's log (entries since construction or restore) */
  get log(): readonly LogEntry[] { return view(this.logEntries); }
  /** quantisation merges and inversions detected by this instance (always empty under 'layered') */
  timeReport(): TimeReport { return view({ order: this.order, on_conflict: this.onConflict, merges: this.merges, inversions: this.inversions }); }
  get(id: string): Readonly<WorldEvent> | undefined { const e = this.events.get(id); return e && view(e); }
  pending(): Readonly<WorldEvent>[] { const c = this.slot; return view([...this.events.values()].filter((e) => e.state === 'scheduled').sort((a, b) => c(a, b) || a.round - b.round || byId(a, b))); }

  /** the canonical id: a root is "<kind>:<key>", a child "<cause id>/<kind>:<key>" */
  static idOf(cause: string | null, kind: string, key: string): string { return `${cause === null ? '' : cause + '/'}${kind}:${key}`; }

  /** spec must be a plain copy from copySpec() (read once); nothing here reads producer objects */
  private build(spec: EventSpec, cause: WorldEvent | null, batchAt: { at: WorldTime; round: number; exact: ExactTime } | null): WorldEvent {
    if (!(typeof spec.kind === 'string' && KIND_RE.test(spec.kind))) fail(`event kind ${spec.kind} must match ${KIND_RE}`);
    if (!(typeof spec.key === 'string' && KEY_RE.test(spec.key))) fail(`event key ${spec.key} must match ${KEY_RE}`);
    const what = `${spec.kind}:${spec.key}`;
    if ((spec.at === undefined) === (spec.native === undefined)) fail(`${what}: give exactly one of at, native`);
    const native = spec.native !== undefined ? checkNative(spec.native, `${what} native`) : nativeOfWorld((checkTime(spec.at!, `${what} at`), spec.at!));
    const exact = exactOf(native), at = labelOf(exact, this.order);
    checkRef(spec.scope, 'scope', this.world, false); checkRef(spec.source, 'source', this.world, true); checkRef(spec.target, 'target', this.world, true);
    const payload = spec.payload === undefined ? null : spec.payload; checkJson(payload, 'payload'); // already a plain copy
    const id = WorldScheduler.idOf(cause ? cause.id : null, spec.kind, spec.key);
    const vs = (x: WorldTime, xe: ExactTime) => (this.order === 'tick' ? compareTime(at, x) : compareExact(exact, xe));
    let round = 0;
    if (cause && batchAt) {
      if (vs(cause.at, cause.exact) < 0) fail(`${id}: scheduled before its cause ${cause.id} (${fmt(at)} < ${fmt(cause.at)}${this.order === 'layered' ? ', exact instants' : ''})`);
      if (vs(batchAt.at, batchAt.exact) === 0) round = batchAt.round + 1;
    } else {
      // a world input: strictly after the instant being processed, or (before any batch) at or after the start
      const c = this.started ? vs(this.clockAt, this.maxExact!) : vs(this.clockAt, exactOfWorld(this.clockAt));
      if (at.day <= this.closedDay) fail(`${id}: day ${at.day} was already closed by runDay(${this.closedDay})`);
      if (this.started ? c <= 0 : c < 0) fail(`${id}: world input at ${fmt(at)} is not after the clock ${fmt(this.clockAt)}${this.started && c === 0 ? ' (that instant is already being processed)' : ''}`);
    }
    return {
      id, kind: spec.kind, key: spec.key, at, native, exact, round,
      scope: { ...spec.scope }, source: spec.source ? { ...spec.source } : null, target: spec.target ? { ...spec.target } : null,
      payload: deepFreeze(canonJson(payload)), cause: cause ? cause.id : null,
      state: 'scheduled', cancelled_by: null, cancel_reason: null,
    };
  }

  /** schedule a ROOT event (a world input, no cause) from outside a batch. Returns its id. */
  schedule(spec: EventSpec): string {
    return this.exclusive('schedule', () => {
      const e = this.build(copySpec(spec), null, null);
      if (this.events.has(e.id)) fail(`duplicate event id ${e.id}`);
      this.events.set(e.id, e); this.heap.push(e); return e.id;
    });
  }

  /** cancel a pending event from outside a batch */
  cancel(id: string, reason: string): void { this.exclusive('cancel', () => { const cs = [{ id, reason }]; this.checkCancels(cs, new Set()); this.applyCancels(cs, null); }); }

  private checkCancels(cs: Cancel[], inBatch: Set<string>): void {
    if (!Array.isArray(cs)) fail('cancel must be an array');
    const seen = new Set<string>();
    for (const c of cs) {
      if (!c || typeof c.id !== 'string' || !(typeof c.reason === 'string' && c.reason.length > 0)) fail('a cancel needs an id and a non-empty reason');
      const e = this.events.get(c.id);
      if (!e) fail(`cancel of unknown event ${c.id}`);
      if (inBatch.has(c.id)) fail(`cancel of ${c.id} by its own batch: deciding between simultaneous events is a behavioural rule, not the scheduler's`);
      if (e!.state !== 'scheduled') fail(`cancel of ${c.id} in state ${e!.state} (only scheduled events can be cancelled)`);
      if (seen.has(c.id)) fail(`${c.id} cancelled twice in one call`);
      seen.add(c.id);
    }
  }
  /** commit only: callers have validated cs with checkCancels on the same plain copy */
  private applyCancels(cs: Cancel[], by: string | null): void {
    for (const c of [...cs].sort(byId)) {
      const e = this.events.get(c.id)!; e.state = 'cancelled'; e.cancelled_by = by; e.cancel_reason = c.reason;
      this.logEntries.push({ seq: this.seq++, id: e.id, kind: e.kind, at: { ...e.at }, exact: { ...e.exact }, round: e.round, cause: e.cause, state: 'cancelled', by, reason: c.reason });
    }
  }

  private dropCancelledTop(): void { while (this.heap.size && this.heap.peek()!.state !== 'scheduled') this.heap.pop(); }

  /** the instant (label and exact) and round of the next batch, or null when nothing is pending */
  nextBatchAt(): { at: WorldTime; round: number; exact: ExactTime } | null { this.dropCancelledTop(); const t = this.heap.peek(); return t ? { at: { ...t.at }, round: t.round, exact: { ...t.exact } } : null; }

  /**
   * Process exactly one batch: every pending event with the earliest (instant, round) — the instant being the tick
   * label ('tick') or the exact instant ('layered'). The handler receives the batch (frozen copies) and returns children
   * — each naming its cause, an event of this batch — and cancellations of OTHER pending events. It may read the
   * scheduler (frozen copies) but not call schedule / cancel / step. Output is validated in full before anything
   * changes; on any error the batch stays pending and the state is unchanged. Under 'tick', a batch that merges distinct
   * exact instants, or contains an instant earlier than one already executed, is recorded in timeReport() (or refused
   * before the handler runs, with on_conflict 'refuse').
   */
  step(handler: Handler): Readonly<WorldEvent>[] {
    // the scheduler is held from before the batch is taken until after the commit: the handler, every read of its output
    // (getters, proxy traps, toString in messages) and the validation run with re-entry refused; on any error the batch
    // goes back and nothing else has changed (the guard is released in finally, whatever happens)
    return this.exclusive('step', () => {
      const top = this.nextBatchAt(); if (!top) return [];
      const batch: WorldEvent[] = [], first = this.heap.peek()!;
      while (this.heap.size) { this.dropCancelledTop(); const t = this.heap.peek(); if (!t || this.slot(t, first) !== 0 || t.round !== top.round) break; batch.push(this.heap.pop()!); }
      const inBatch = new Set(batch.map((e) => e.id)), restore = () => { for (const e of batch) this.heap.push(e); };
      // quantisation diagnostics (read-only, before the handler)
      const byExact = [...batch].sort((a, b) => compareExact(a.exact, b.exact) || byId(a, b));
      let distinct = 1; for (let i = 1; i < byExact.length; i++) if (!sameExact(byExact[i].exact, byExact[i - 1].exact)) distinct++;
      const lo = byExact[0].exact, hi = byExact[byExact.length - 1].exact;
      const inverted = this.maxExact !== null && compareExact(lo, this.maxExact) < 0;
      if (this.order === 'layered' && (distinct > 1 || inverted)) { restore(); fail('internal: a layered batch merged instants or ran out of order'); }
      if (this.onConflict === 'refuse' && (distinct > 1 || inverted)) {
        restore();
        fail(distinct > 1 ? `batch at ${fmt(top.at)}#${top.round} would merge ${distinct} distinct exact instants (span ${spanUs(lo, hi)} µs) into one tick` : `batch at ${fmt(top.at)}#${top.round} truly happened ${spanUs(lo, this.maxExact!)} µs before ${this.maxExactId}, already executed`);
      }
      const ctx: BatchContext = { at: { ...top.at }, round: top.round, exact: { ...lo }, distinct_instants: distinct };
      // read the output ONCE into plain data, validate that copy in full, and commit only that copy (atomic batch)
      let out: ReturnType<typeof copyOutput>;
      const children: WorldEvent[] = [], newIds = new Set<string>();
      try {
        const raw = handler(view(batch), ctx);
        out = copyOutput(raw);
        for (const c of out.children) {
          if (typeof c.cause !== 'string' || !inBatch.has(c.cause)) fail(`a child must name a cause in the current batch (got ${c.cause})`);
          const e = this.build(c.spec, this.events.get(c.cause)!, { at: top.at, round: top.round, exact: this.events.get(c.cause)!.exact });
          if (this.events.has(e.id) || newIds.has(e.id)) fail(`duplicate event id ${e.id}`);
          newIds.add(e.id); children.push(e);
        }
        this.checkCancels(out.cancel, inBatch);
        // external state commits here, last, so that it and the batch below commit together or not at all
        if (this.commitHook) this.commitHook(Object.freeze(batch.map((e) => e.id).sort()), handler);
      } catch (err) { restore(); throw err; }
      // nothing below can fail: every value was validated above and is no longer read from the producer
      // commit: the batch executes, then its cancellations, then its children are queued
      const ids = batch.map((e) => e.id).sort();
      if (distinct > 1) this.merges.push({ at: { ...top.at }, round: top.round, ids, distinct_instants: distinct, span_us: spanUs(lo, hi) });
      if (inverted) this.inversions.push({ at: { ...top.at }, round: top.round, ids, earlier_than: this.maxExactId!, by_us: spanUs(lo, this.maxExact!) });
      this.started = true; this.clockAt = { ...top.at }; this.clockRound = top.round;
      if (this.maxExact === null || compareExact(hi, this.maxExact) > 0) { this.maxExact = { ...hi }; this.maxExactId = byExact.filter((e) => sameExact(e.exact, hi))[0].id; }
      for (const e of batch) { e.state = 'executed'; this.logEntries.push({ seq: this.seq++, id: e.id, kind: e.kind, at: { ...e.at }, exact: { ...e.exact }, round: e.round, cause: e.cause, state: 'executed', by: null, reason: null }); }
      this.applyCancels(out.cancel, batch.length === 1 ? batch[0].id : `batch@${fmt(top.at)}#${top.round}`);
      for (const e of children) { this.events.set(e.id, e); this.heap.push(e); }
      return view(batch);
    });
  }

  /**
   * Process batches while the next one is strictly before `end` (exclusive; label under 'tick', exact instant under
   * 'layered'). Each batch is atomic; the run as a whole is not: if maxBatches is exceeded it throws after the batches
   * already done, leaving a consistent state.
   */
  runUntil(end: WorldTime, handler: Handler, maxBatches = 1_000_000): number {
    this.guard('runUntil');
    const e = this.exclusive('runUntil', () => ({ ...checkTime(end, 'runUntil end') })), ex = exactOfWorld(e);
    let n = 0;
    for (;;) {
      const nx = this.nextBatchAt(); if (!nx) break;
      if ((this.order === 'tick' ? compareTime(nx.at, e) : compareExact(nx.exact, ex)) >= 0) break;
      if (++n > maxBatches) fail(`more than ${maxBatches} batches before ${fmt(e)} (runaway schedule?)`);
      this.step(handler);
    }
    return n;
  }
  /** process every batch of world day `day` (00:00 to before 24:00); later events stay queued, nothing resets at 24:00 */
  runDay(day: number, handler: Handler, maxBatches?: number): number {
    this.guard('runDay');
    if (!Number.isSafeInteger(day) || day < 0) fail(`runDay: day must be an integer >= 0 (got ${day})`);
    const nx = this.nextBatchAt(); if (nx && nx.at.day < day) fail(`runDay(${day}): events of day ${nx.at.day} are still pending (days must be run in order)`);
    if (day <= this.closedDay) fail(`runDay(${day}): day already closed (last closed ${this.closedDay})`);
    const n = this.runUntil({ day: day + 1, minute: 0 }, handler, maxBatches);
    this.closedDay = day;
    return n;
  }

  /** counts by state; total = executed + cancelled + pending; each id logged at most once and in its final state */
  audit(): { total: number; executed: number; cancelled: number; pending: number; logged: number; finished_before_restore: number } {
    let ex = 0, ca = 0, pe = 0; for (const e of this.events.values()) { if (e.state === 'executed') ex++; else if (e.state === 'cancelled') ca++; else pe++; }
    const ids = new Set(this.logEntries.map((l) => l.id));
    if (ids.size !== this.logEntries.length) fail('an event was logged twice');
    if (ids.size + this.finishedAtRestore !== ex + ca) fail('log and event states disagree');
    for (const l of this.logEntries) if (this.events.get(l.id)?.state !== l.state) fail(`log entry ${l.id} (${l.state}) disagrees with the event state`);
    return { total: this.events.size, executed: ex, cancelled: ca, pending: pe, logged: this.logEntries.length, finished_before_restore: this.finishedAtRestore };
  }

  /** a JSON snapshot (events sorted by id) from which an identical scheduler can be restored, e.g. across a save */
  snapshot(): SchedulerSnapshot {
    this.guard('snapshot');
    return JSON.parse(JSON.stringify({ schema: SCHEDULER_SNAPSHOT_SCHEMA, world: this.world, time: { order: this.order, on_conflict: this.onConflict }, clock: { at: this.clockAt, round: this.clockRound, started: this.started, closed_day: this.closedDay }, log_seq: this.seq, events: [...this.events.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) }));
  }
  /** restore from snapshot(); refuses anything inconsistent rather than repairing it */
  static restore(s: SchedulerSnapshot): WorldScheduler {
    if (!s || typeof s !== 'object' || s.schema !== SCHEDULER_SNAPSHOT_SCHEMA) fail(`snapshot schema ${s && s.schema} is not ${SCHEDULER_SNAPSHOT_SCHEMA}`);
    if (Object.keys(s).sort().join() !== 'clock,events,log_seq,schema,time,world') fail('snapshot must have exactly schema, world, time, clock, log_seq, events');
    if (!Array.isArray(s.events)) fail('snapshot events must be an array');
    if (!s.time || typeof s.time !== 'object' || Object.keys(s.time).sort().join() !== 'on_conflict,order') fail('snapshot time must be { order, on_conflict }');
    if (!s.clock || typeof s.clock !== 'object' || Object.keys(s.clock).sort().join() !== 'at,closed_day,round,started' || typeof s.clock.started !== 'boolean') fail('snapshot clock must be { at, round, started, closed_day }');
    if (!Number.isSafeInteger(s.clock.closed_day) || s.clock.closed_day < -1) fail('snapshot closed_day invalid');
    const w = new WorldScheduler(s.world, { day: 0, minute: 0 }, { order: s.time.order, on_conflict: s.time.on_conflict });
    const layered = w.order === 'layered';
    const at = checkTime(s.clock.at, 'snapshot clock'); if (!isCanonical(s.clock.at)) fail('snapshot clock is not on the tick grid');
    if (!Number.isSafeInteger(s.clock.round) || s.clock.round < -1 || (s.clock.started ? s.clock.round < 0 : s.clock.round !== -1)) fail('snapshot clock round invalid');
    w.clockAt = at; w.clockRound = s.clock.round; w.started = s.clock.started; w.closedDay = s.clock.closed_day;
    const checkedExact = (e: WorldEvent): ExactTime => {
      if (!e.exact || typeof e.exact !== 'object' || Object.keys(e.exact).sort().join() !== 'day,us,us_lo' || ![e.exact.day, e.exact.us, e.exact.us_lo].every((v) => typeof v === 'number' && Number.isFinite(v))) fail(`snapshot ${e.id}: exact must be { day, us, us_lo }`);
      return e.exact;
    };
    // the clock's exact instant: the latest executed exact instant (layered order compares with it)
    let maxEx: ExactTime | null = null, maxId: string | null = null;
    for (const e of s.events) if (e && typeof e === 'object' && e.state === 'executed') { const x = checkedExact(e); if (maxEx === null || compareExact(x, maxEx) > 0 || (compareExact(x, maxEx) === 0 && e.id < maxId!)) { maxEx = x; maxId = e.id; } }
    const clockEx = w.started ? maxEx : exactOfWorld(at);
    if (w.started && clockEx === null) fail('snapshot: a started clock needs an executed event');
    const vsClock = (e: WorldEvent) => (layered ? compareExact(e.exact, clockEx!) : compareTime(e.at, at)) || e.round - s.clock.round;
    let finished = 0;
    for (const e of s.events) {
      if (!e || typeof e !== 'object' || Object.keys(e).sort().join() !== EVENT_FIELDS) fail(`snapshot event must have exactly ${EVENT_FIELDS}`);
      if (!(typeof e.kind === 'string' && KIND_RE.test(e.kind)) || !(typeof e.key === 'string' && KEY_RE.test(e.key))) fail(`snapshot ${e.id}: illegal kind or key`);
      if (e.cause !== null && typeof e.cause !== 'string') fail(`snapshot ${e.id}: cause must be an id or null`);
      if (WorldScheduler.idOf(e.cause, e.kind, e.key) !== e.id) fail(`snapshot ${e.id}: id is not canonical`);
      if (w.events.has(e.id)) fail(`snapshot: duplicate id ${e.id}`);
      checkTime(e.at, `snapshot ${e.id}`); if (!isCanonical(e.at)) fail(`snapshot ${e.id}: time not on the tick grid`);
      checkedExact(e);
      if (!Number.isSafeInteger(e.round) || e.round < 0) fail(`snapshot ${e.id}: round must be an integer >= 0`);
      if (!['scheduled', 'executed', 'cancelled'].includes(e.state)) fail(`snapshot ${e.id}: state ${e.state} unknown`);
      if (e.state === 'cancelled' ? !(typeof e.cancel_reason === 'string' && e.cancel_reason.length > 0) || !(e.cancelled_by === null || typeof e.cancelled_by === 'string') : e.cancelled_by !== null || e.cancel_reason !== null) fail(`snapshot ${e.id}: cancel fields inconsistent with state ${e.state}`);
      checkRef(e.scope, 'scope', s.world, false); checkRef(e.source, 'source', s.world, true); checkRef(e.target, 'target', s.world, true); checkJson(e.payload, 'payload');
      const v = vsClock(e);
      if (e.state === 'scheduled' && (w.started ? v <= 0 : (layered ? compareExact(e.exact, clockEx!) : compareTime(e.at, at)) < 0)) fail(`snapshot ${e.id}: pending but not after the clock`);
      if (e.state === 'scheduled' && e.at.day <= w.closedDay) fail(`snapshot ${e.id}: pending on a closed day`);
      if (e.state === 'executed' && (!w.started || v > 0)) fail(`snapshot ${e.id}: executed but after the clock (or the clock never started)`);
      const ev: WorldEvent = { ...e, at: { ...e.at }, native: e.native && typeof e.native === 'object' ? { ...e.native, anchor: e.native.anchor && { ...e.native.anchor } } : e.native, exact: { ...e.exact }, scope: { ...e.scope }, source: e.source && { ...e.source }, target: e.target && { ...e.target }, payload: deepFreeze(canonJson(e.payload)) };
      w.events.set(e.id, ev); if (ev.state === 'scheduled') w.heap.push(ev); else finished++;
    }
    for (const e of w.events.values()) if (e.cause !== null) {
      const c = w.events.get(e.cause); if (!c) fail(`snapshot ${e.id}: cause ${e.cause} missing`);
      if (c!.state !== 'executed') fail(`snapshot ${e.id}: cause ${e.cause} was not executed`);
      const t = layered ? compareExact(e.exact, c!.exact) : compareTime(e.at, c!.at);
      if (t < 0) fail(`snapshot ${e.id}: before its cause`);
      if (t === 0 ? e.round !== c!.round + 1 : e.round !== 0) fail(`snapshot ${e.id}: round ${e.round} inconsistent with its cause (${c!.round})`);
    } else if (e.round !== 0) fail(`snapshot ${e.id}: a world input must be in round 0`);
    // provenance: the label and the exact instant must follow from the native time, bit for bit
    for (const e of w.events.values()) {
      const x = exactOf(checkNative(e.native, `snapshot ${e.id} native`));
      if (!sameExact(x, e.exact)) fail(`snapshot ${e.id}: exact instant does not follow from its native time`);
      const l = labelOf(x, w.order); if (l.day !== e.at.day || l.minute !== e.at.minute) fail(`snapshot ${e.id}: tick label does not follow from its native time`);
    }
    if (s.log_seq !== finished) fail(`snapshot log_seq ${s.log_seq} must equal the ${finished} finished events (each is logged exactly once)`);
    w.seq = s.log_seq; w.finishedAtRestore = finished; w.maxExact = maxEx && { ...maxEx }; w.maxExactId = maxId;
    return w;
  }
}

const fmt = (t: WorldTime) => `d${t.day}+${t.minute}min`;

/**
 * Independent check of an execution log (does not trust the scheduler's internal state): each id at most once; the
 * executed sequence is non-decreasing in (instant, round, id) — the instant being the tick label ('tick', default) or
 * the exact instant ('layered'); a child executes only after its cause executed and in a later round when at the same
 * instant; cancelled events never execute. `before` lists events finished before the log starts (e.g. the executed
 * events of the snapshot a scheduler was restored from), so a log recorded after a restore can be checked on its own.
 */
export function verifyLog(log: readonly (Omit<LogEntry, 'exact'> & { exact?: ExactTime })[], before: readonly { id: string; at: WorldTime; exact?: ExactTime; round: number; state: EventState }[] = [], opts: { order?: TimeOrder } = {}): { ok: true } {
  const layered = (opts.order ?? 'tick') === 'layered';
  type Seen = { at: WorldTime; exact?: ExactTime; round: number; state: string };
  const inst = (a: Seen, b: Seen) => { if (!layered) return compareTime(a.at, b.at); if (!a.exact || !b.exact) fail('log: layered verification needs exact instants'); return compareExact(a.exact!, b.exact!); };
  const seen = new Map<string, Seen>(); let prev: (typeof log)[number] | null = null;
  for (const b of before) if (b.state !== 'scheduled') seen.set(b.id, b);
  for (const l of log) {
    if (seen.has(l.id)) fail(`log: ${l.id} appears twice (${seen.get(l.id)!.state}, ${l.state})`);
    seen.set(l.id, l);
    if (l.state !== 'executed') continue;
    if (prev) { const c = inst(l, prev) || l.round - prev.round || (l.id < prev.id ? -1 : l.id > prev.id ? 1 : 0); if (c < 0) fail(`log: ${l.id} executed out of order after ${prev.id}`); }
    if (l.cause !== null) {
      const c = seen.get(l.cause);
      if (!c || c.state !== 'executed') fail(`log: ${l.id} executed before its cause ${l.cause}`);
      const t = inst(l, c!);
      if (t < 0 || (t === 0 && l.round <= c!.round)) fail(`log: ${l.id} not after its cause ${l.cause}`);
    }
    prev = l;
  }
  return { ok: true };
}
