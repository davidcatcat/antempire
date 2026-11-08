/**
 * Experiment-world simulation core (P0-A2 PR 2, Owner decision #39). Pure TypeScript: no DOM, no Node, no wall clock,
 * no Math.random. The same module runs in Node (tests) and in the browser Worker (entry.ts).
 *
 * NON-OFFICIAL: every output carries LABEL_ZH and official:false. Nothing here reads or writes saves/ or journal/,
 * nothing is persisted (snapshots are returned to the caller as data; persistence is the separate SAVE module).
 *
 * Time contract (P0-A0 / P0-A1, `layered`): every event keeps its native time (ant clocks in seconds, environment
 * clocks in minutes) and is ordered by its EXACT instant, then round, then canonical id (engine/scheduler/world-events).
 * All events of one exact instant are one batch and are handled as a SET: each handler reads the state as it was before
 * the batch, writes only its own entity (an ant, or a distinct environment field) and draws only from its own named
 * stream, so the result never depends on the order inside the batch. Two writes to the same field in one batch are
 * refused (same-instant contest rules are undecided; nothing picks a winner).
 *
 * Advancing: advanceTo(t) processes every batch at an exact instant <= t, then the world is AT t. A budget may stop it
 * earlier, but only between two distinct instants (a consistent boundary); no event is ever skipped or dropped.
 * Pacing (speed, pause) lives outside this module and can only choose the t values; results at the same t are the same
 * whatever the chunking (tests/worker-runtime.test.ts).
 *
 * Events are scheduled as world inputs (roots) after each batch commits, with the causing event id in the payload
 * (`cause`), so ids stay short in a run of unbounded length. Executed events are compacted out of the scheduler at
 * consistent boundaries (they were already emitted); compaction cannot change behaviour (order depends only on pending
 * events) and the snapshot always holds the compacted form, so a restored world and a continuous one are identical.
 */
import { WorldScheduler, type ExactTime, type EventSpec, type JsonValue, type SchedulerSnapshot, type WorldEvent, compareExact, exactOf, TICKS_PER_MINUTE } from '../../../engine/scheduler/world-events.ts';
import { lightTimes, lightStateAt, type LightState, type LightTimes } from '../../../engine/clock/solar.ts';
import { dateOfDay } from '../../../engine/clock/time-frames.ts';
import { DEFAULT_PARAMS, ENGINE_VERSION, LABEL_ZH, SCHEMA_VERSION, SNAPSHOT_SCHEMA, type WorldParams } from './params.ts';
import { DrawCursor, streamSeed, type StreamState } from './rng.ts';
import { canonicalJson, hashJson } from './sha256.ts';
import { detLog, norm, unitVector } from './detmath.ts';

export { LABEL_ZH, ENGINE_VERSION, SCHEMA_VERSION, SNAPSHOT_SCHEMA };

export class ExperimentRefused extends Error {
  readonly code: string;
  constructor(code: string, msg: string) { super(`EXPERIMENT_WORLD ${code}: ${msg}`); this.name = 'ExperimentRefused'; this.code = code; }
}
const refuse = (code: string, msg: string): never => { throw new ExperimentRefused(code, msg); };

export interface Vec { x: number; y: number }
export type Activity = 'resting' | 'walking' | 'pausing';
export interface AntState {
  id: string;
  activity: Activity;
  /** world seconds since the world's 00:00 of day 0 when the current activity started */
  since_s: number;
  /** when the current activity ends (the ant's pending bout_end event, native time on clock ant.<id>) */
  until_s: number;
  /** position at since_s (start of the current segment) */
  pos: Vec;
  /** walking: where the straight leg ends; resting / pausing: null */
  target: Vec | null;
  target_is_nest: boolean;
  in_nest: boolean;
  bout_index: number;
  next_event: string;
  /** the ant's own recent waypoints (synthetic memory; read by nothing yet) */
  memory: { x: number; y: number; t_s: number }[];
}
export interface EnvState {
  day: number; date: string | null;
  light: LightState | null; light_times: LightTimes | null;
  temperature_c: number | null; temperature_synthetic: true;
  next_day_event: string; next_hour_event: string;
}
export interface Ledgers {
  events_by_kind: Record<string, number>;
  ants: Record<string, { bouts: number; walked_cm: number; walking_s: number }>;
}
export interface ExperimentEvent {
  seq: number; event_id: string; kind: string; t_sim: number; exact: ExactTime; round: number; entity: string | null;
  data: { [k: string]: JsonValue };
  rng: { stream: string; from_draw: number; values: number[] } | null;
  world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  official: false; label: string;
}
export interface Payload {
  params: WorldParams; world_id: string; seed: number; engine_version: string; schema_version: number; rules_fingerprint: string;
  now: ExactTime; t_sim: number; seq: number;
  ants: AntState[]; env: EnvState; rng: Record<string, StreamState>; scheduler: SchedulerSnapshot; ledgers: Ledgers;
}
export interface ExperimentSnapshot {
  schema: string; label: string; official: false;
  world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  t_sim: number; seq: number; payload: Payload; payload_sha256: string;
}
export interface StateFrame {
  label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; t_sim: number; seq: number;
  ants: { id: string; activity: Activity; since_s: number; until_s: number; from: Vec; to: Vec | null; in_nest: boolean }[];
  env: { date: string | null; light: LightState | null; temperature_c: number | null; temperature_synthetic: true };
  arena_radius_cm: number;
}

export const rulesFingerprint = (p: WorldParams): string => hashJson({ engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, params: p as unknown as JsonValue });
/** the only rules this runtime implements: a snapshot with any other fingerprint is refused */
export const RULES_FINGERPRINT = rulesFingerprint(DEFAULT_PARAMS);

const WORLD_ID_RE = /^exp-[A-Za-z0-9._-]{1,60}$/;
const ORIGIN = { day: 0, minute: 0 };
const z = (n: number) => n + 0; // -0 -> 0 so live state equals its JSON round trip
/** seconds since 00:00 of day 0 (a double; for display and for ant clocks). Ordering always uses ExactTime. */
export const secondsOf = (x: ExactTime): number => x.day * 86_400 + x.us / 1e6 + x.us_lo / 1e6;
const exactOfSeconds = (t: number): ExactTime => exactOf({ clock: 'world', unit: 's', anchor: ORIGIN, t });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const dist = (a: Vec, b: Vec) => norm(b.x - a.x, b.y - a.y);

interface AntUpdate { ant: AntState; stream: string; rng: StreamState; walked_cm: number; walking_s: number; next: EventSpec }
interface Commit { ants: AntUpdate[]; env: Partial<EnvState>; envNext: EventSpec[]; records: Omit<ExperimentEvent, 'seq'>[] }

export class ExperimentWorld {
  readonly params: WorldParams; readonly worldId: string; readonly seed: number; readonly fingerprint: string;
  private sched: WorldScheduler;
  private now: ExactTime;
  private seq: number;
  private ants: Map<string, AntState>;
  private env: EnvState;
  private rng: Map<string, StreamState>;
  private ledgers: Ledgers;
  private sinceCompact = 0;
  /** executed events since the last compaction above which the scheduler is compacted (memory bound; behaviour-neutral) */
  static COMPACT_AFTER = 2048;

  private constructor(p: Payload, sched: WorldScheduler) {
    this.params = p.params; this.worldId = p.world_id; this.seed = p.seed; this.fingerprint = p.rules_fingerprint;
    this.sched = sched; this.now = { ...p.now }; this.seq = p.seq;
    this.ants = new Map(p.ants.map((a) => [a.id, a])); this.env = p.env;
    this.rng = new Map(Object.entries(p.rng)); this.ledgers = p.ledgers;
  }

  /** a new isolated world at 00:00 of day 0; events at that instant are processed before it returns */
  static create(worldId: string, seed: number): { world: ExperimentWorld; events: ExperimentEvent[] } {
    if (typeof worldId !== 'string' || !WORLD_ID_RE.test(worldId)) refuse('BAD_WORLD_ID', `world_id must match ${WORLD_ID_RE} (experiment worlds only)`);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) refuse('BAD_SEED', 'seed must be an integer in [0, 2^32)');
    const params = copy(DEFAULT_PARAMS), sched = new WorldScheduler(worldId, ORIGIN, { order: 'layered', on_conflict: 'refuse' });
    const ants: AntState[] = [], rng: Record<string, StreamState> = {}, ledgers: Ledgers = { events_by_kind: {}, ants: {} };
    for (let i = 1; i <= params.n_ants; i++) {
      const id = `w${String(i).padStart(2, '0')}`, stream = `ant/${id}`;
      const cur = new DrawCursor(stream, { state: streamSeed(seed, worldId, stream), draws: 0 });
      const until = Math.max(params.min_bout_s, -params.rest_mean_s * detLog(1 - cur.u()));
      const a: AntState = { id, activity: 'resting', since_s: 0, until_s: until, pos: { x: 0, y: 0 }, target: null, target_is_nest: false, in_nest: true, bout_index: 0, next_event: '', memory: [] };
      a.next_event = sched.schedule(antSpec(worldId, a, null));
      ants.push(a); rng[stream] = cur.result(); ledgers.ants[id] = { bouts: 0, walked_cm: 0, walking_s: 0 };
    }
    const env: EnvState = { day: 0, date: null, light: null, light_times: null, temperature_c: null, temperature_synthetic: true, next_day_event: '', next_hour_event: '' };
    env.next_day_event = sched.schedule(daySpec(worldId, 0, null));
    env.next_hour_event = sched.schedule(hourSpec(worldId, 0, 0, null));
    const p: Payload = { params, world_id: worldId, seed, engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, rules_fingerprint: rulesFingerprint(params), now: { day: 0, us: 0, us_lo: 0 }, t_sim: 0, seq: 0, ants, env, rng, scheduler: sched.snapshot(), ledgers };
    const world = new ExperimentWorld(p, sched);
    const events = world.advanceTo(0).events;
    return { world, events };
  }

  tSim(): number { return secondsOf(this.now); }
  nowExact(): ExactTime { return { ...this.now }; }
  seqNo(): number { return this.seq; }
  antIds(): string[] { return [...this.ants.keys()].sort(); }
  /** read-only copy of one ant (observation; used by follow) */
  antView(id: string): AntState | null { const a = this.ants.get(id); return a ? copy(a) : null; }

  /**
   * Process every batch at an exact instant <= t (seconds since day 0 00:00). maxBatches bounds the work of one call;
   * when it is reached the call stops after a complete instant and reports done:false (the world is then at that
   * instant, every event up to it processed). Refuses to go backwards.
   */
  advanceTo(t: number, maxBatches = Infinity): { events: ExperimentEvent[]; done: boolean } {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) refuse('BAD_TIME', 't must be a finite number >= 0');
    const end = exactOfSeconds(t);
    if (compareExact(end, this.now) < 0) refuse('TIME_BACKWARDS', `t ${t} is before the world time ${this.tSim()}`);
    const out: ExperimentEvent[] = [];
    let n = 0;
    for (;;) {
      const nx = this.sched.nextBatchAt();
      if (!nx || compareExact(nx.exact, end) > 0) { this.now = end; break; }
      if (n >= maxBatches && compareExact(nx.exact, this.now) > 0) { this.maybeCompact(); return { events: out, done: false }; }
      this.stepOne(out); n++;
    }
    this.maybeCompact();
    return { events: out, done: true };
  }

  private stepOne(out: ExperimentEvent[]): void {
    let commit = null as Commit | null;
    const batch = this.sched.step((b, ctx) => { commit = this.prepare(b, ctx.exact); });
    if (!commit || batch.length === 0) refuse('INTERNAL', 'a step produced no batch');
    const c = commit as Commit;
    // commit (nothing below reads producer objects; every value was computed above)
    for (const u of c.ants) {
      this.ants.set(u.ant.id, u.ant); this.rng.set(u.stream, u.rng);
      const l = this.ledgers.ants[u.ant.id]; l.bouts++; l.walked_cm = z(l.walked_cm + u.walked_cm); l.walking_s = z(l.walking_s + u.walking_s);
    }
    Object.assign(this.env, c.env);
    for (const r of c.records) { out.push({ ...r, seq: this.seq++ }); this.ledgers.events_by_kind[r.kind] = (this.ledgers.events_by_kind[r.kind] ?? 0) + 1; }
    this.now = { ...batch[0].exact };
    for (const u of c.ants) { const id = this.sched.schedule(u.next); this.ants.get(u.ant.id)!.next_event = id; }
    for (const s of c.envNext) {
      const id = this.sched.schedule(s);
      if (s.kind === 'env_day') this.env.next_day_event = id; else if (s.kind === 'env_hour') this.env.next_hour_event = id;
    }
    this.sinceCompact += batch.length;
  }

  /** compute the batch's effects from the state BEFORE the batch; mutate nothing */
  private prepare(batch: readonly Readonly<WorldEvent>[], at: ExactTime): Commit {
    const c: Commit = { ants: [], env: {}, envNext: [], records: [] };
    const written = new Set<string>();
    const write = (field: string) => { if (written.has(field)) refuse('SAME_INSTANT_CONTEST', `two events of one instant write ${field}; no rule decides the winner`); written.add(field); };
    const t_sim = secondsOf(at);
    const head = { world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, official: false as const, label: LABEL_ZH };
    for (const e of [...batch].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const base = { event_id: e.id, kind: e.kind, t_sim, exact: { ...e.exact }, round: e.round, ...head };
      if (e.kind === 'ant_bout_end') {
        const id = e.scope.individual!; write(`ant:${id}`);
        const a = this.ants.get(id);
        if (!a || a.next_event !== e.id) refuse('INTERNAL', `event ${e.id} does not belong to ${id}`);
        const stream = `ant/${id}`, cur = new DrawCursor(stream, this.rng.get(stream)!);
        const r = this.transition(a!, cur, e.id);
        c.ants.push({ ...r, stream, rng: cur.result() });
        c.records.push({ ...base, entity: id, data: { from: a!.activity, to: r.ant.activity, pos: { ...r.ant.pos }, target: r.ant.target && { ...r.ant.target }, until_s: r.ant.until_s, in_nest: r.ant.in_nest, cause: e.payload as JsonValue }, rng: { stream, from_draw: cur.from, values: [...cur.values] } });
      } else if (e.kind === 'env_day') {
        write('env:day');
        const day = (e.payload as { day: number }).day, date = dateOfDay(this.params.calendar, day), lt = lightTimes(this.params.site, this.params.calendar, date);
        c.env.day = day; c.env.date = date; c.env.light_times = lt;
        write('env:light'); c.env.light = lightStateAt(lt, 0);
        for (const [name, m] of [['civil_dawn', lt.civil_dawn], ['sunrise', lt.sunrise], ['sunset', lt.sunset], ['civil_dusk', lt.civil_dusk]] as const) c.envNext.push(lightSpec(this.worldId, day, name, m, e.id));
        c.envNext.push(daySpec(this.worldId, day + 1, e.id));
        c.records.push({ ...base, entity: null, data: { day, date, light: c.env.light, light_times: { ...lt } as unknown as JsonValue, cause: e.payload as JsonValue }, rng: null });
      } else if (e.kind === 'light_change') {
        write('env:light');
        const p = e.payload as { day: number; transition: string; minute: number };
        const lt = this.env.light_times;
        if (!lt || this.env.day !== p.day) refuse('INTERNAL', `${e.id}: light times of day ${p.day} are not loaded`);
        const light = lightStateAt(lt!, p.minute);
        c.env.light = light;
        c.records.push({ ...base, entity: null, data: { transition: p.transition, light, minute_of_day: p.minute, basis: '一般方法（engine/clock/solar.ts）' }, rng: null });
      } else if (e.kind === 'env_hour') {
        write('env:temperature');
        const p = e.payload as { day: number; hour: number };
        const temp = this.params.temperature_profile_c[p.hour];
        c.env.temperature_c = temp;
        const nh = p.hour === 23 ? { day: p.day + 1, hour: 0 } : { day: p.day, hour: p.hour + 1 };
        c.envNext.push(hourSpec(this.worldId, nh.day, nh.hour, e.id));
        c.records.push({ ...base, entity: null, data: { day: p.day, hour: p.hour, temperature_c: temp, synthetic: true, assumption: true, basis: '遊戲假設' }, rng: null });
      } else refuse('INTERNAL', `unknown event kind ${e.kind}`);
    }
    return c;
  }

  /** the synthetic bout rule of one ant (reads only that ant and its own stream) */
  private transition(a: AntState, cur: DrawCursor, cause: string): Omit<AntUpdate, 'stream' | 'rng'> {
    const P = this.params, t = a.until_s;
    const n: AntState = copy(a);
    n.bout_index = a.bout_index + 1; n.since_s = t;
    let walked = 0, walking = 0;
    const walkTo = (to: Vec, toNest: boolean) => {
      n.activity = 'walking'; n.target = { x: z(to.x), y: z(to.y) }; n.target_is_nest = toNest; n.in_nest = false;
      n.until_s = t + Math.max(P.min_bout_s, dist(n.pos, to) / P.walk_speed_cm_s);
    };
    const randomLeg = () => {
      const d = unitVector(() => cur.u()), len = P.leg_min_cm + (P.leg_max_cm - P.leg_min_cm) * cur.u();
      let x = n.pos.x + len * d.x, y = n.pos.y + len * d.y;
      const r = norm(x, y), lim = P.arena_radius_cm * 0.98;
      if (r > lim) { x = (x * lim) / r; y = (y * lim) / r; }
      walkTo({ x, y }, false);
    };
    const expo = (mean: number) => Math.max(P.min_bout_s, -mean * detLog(1 - cur.u()));
    if (a.activity === 'resting') randomLeg();
    else if (a.activity === 'walking') {
      walked = dist(a.pos, a.target!); walking = t - a.since_s;
      n.pos = { ...a.target! }; n.target = null;
      n.memory = [...a.memory, { x: n.pos.x, y: n.pos.y, t_s: t }].slice(-P.memory_size);
      if (a.target_is_nest) { n.activity = 'resting'; n.in_nest = true; n.target_is_nest = false; n.until_s = t + expo(P.rest_mean_s); }
      else { n.activity = 'pausing'; n.target_is_nest = false; n.until_s = t + expo(P.pause_mean_s); }
    } else {
      if (cur.u() < P.return_probability) walkTo({ x: 0, y: 0 }, true); else randomLeg();
    }
    if (!(n.until_s > t)) refuse('INTERNAL', `${a.id}: bout of zero length`);
    return { ant: n, walked_cm: walked, walking_s: walking, next: antSpec(this.worldId, n, cause) };
  }

  private maybeCompact(): void {
    if (this.sinceCompact < ExperimentWorld.COMPACT_AFTER) return;
    this.sched = WorldScheduler.restore(compactScheduler(this.sched.snapshot(), this.now));
    this.sinceCompact = 0;
  }

  /** the complete authoritative state; pure read (no stream, clock or queue changes) */
  payload(): Payload {
    const p: Payload = {
      params: this.params, world_id: this.worldId, seed: this.seed, engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, rules_fingerprint: this.fingerprint,
      now: this.now, t_sim: this.tSim(), seq: this.seq,
      ants: [...this.ants.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), env: this.env,
      rng: Object.fromEntries([...this.rng.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
      scheduler: compactScheduler(this.sched.snapshot(), this.now), ledgers: this.ledgers,
    };
    return copy(p);
  }

  /** a snapshot at the current (consistent) boundary: advanceTo always returns between two instants */
  snapshot(): ExperimentSnapshot {
    const payload = this.payload();
    return { schema: SNAPSHOT_SCHEMA, label: LABEL_ZH, official: false, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, t_sim: payload.t_sim, seq: payload.seq, payload, payload_sha256: hashJson(payload) };
  }

  /** a NEW world from a snapshot; refuses (throws ExperimentRefused) on any mismatch, never repairs or re-initialises */
  static restore(s: ExperimentSnapshot): ExperimentWorld {
    if (!s || typeof s !== 'object') refuse('BAD_SNAPSHOT', 'not an object');
    const keys = Object.keys(s).sort().join();
    if (keys !== 'engine_version,label,official,payload,payload_sha256,rules_fingerprint,schema,schema_version,seed,seq,t_sim,world_id') refuse('BAD_SNAPSHOT', `unexpected fields ${keys}`);
    if (s.schema !== SNAPSHOT_SCHEMA) refuse('SCHEMA_MISMATCH', `schema ${String(s.schema)} is not ${SNAPSHOT_SCHEMA}`);
    if (s.schema_version !== SCHEMA_VERSION) refuse('SCHEMA_MISMATCH', `schema_version ${String(s.schema_version)} is not ${SCHEMA_VERSION}`);
    if (s.label !== LABEL_ZH || s.official !== false) refuse('NOT_EXPERIMENT', 'a snapshot must be labelled non-official (official:false)');
    if (s.engine_version !== ENGINE_VERSION) refuse('ENGINE_MISMATCH', `engine_version ${String(s.engine_version)} is not ${ENGINE_VERSION}`);
    let h: string;
    try { h = hashJson(s.payload); } catch (e) { return refuse('HASH_MISMATCH', `payload is not canonical JSON data (${(e as Error).message})`); }
    if (h !== s.payload_sha256) refuse('HASH_MISMATCH', 'payload_sha256 does not match the payload');
    const p = s.payload;
    for (const k of ['world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq'] as const) if (p[k] !== s[k]) refuse('HEADER_MISMATCH', `${k} of the header and the payload differ`);
    if (s.rules_fingerprint !== RULES_FINGERPRINT || rulesFingerprint(p.params) !== RULES_FINGERPRINT) refuse('FINGERPRINT_MISMATCH', 'the snapshot was made under other rules or parameters than this runtime');
    if (!WORLD_ID_RE.test(p.world_id)) refuse('BAD_WORLD_ID', 'world_id');
    let sched: WorldScheduler;
    try { sched = WorldScheduler.restore(copy(p.scheduler)); } catch (e) { return refuse('BAD_QUEUE', (e as Error).message); }
    if (sched.world !== p.world_id || sched.order !== 'layered') refuse('BAD_QUEUE', 'scheduler world or order');
    const q = copy(p);
    const now = q.now;
    if (!now || canonicalJson(Object.keys(now).sort()) !== '["day","us","us_lo"]' || secondsOf(now) !== q.t_sim) refuse('BAD_STATE', 'now / t_sim');
    // cross-checks between the world state and the queue
    const pending = new Map(sched.pending().map((e) => [e.id, e]));
    const ids = q.ants.map((a) => a.id);
    if (ids.length !== q.params.n_ants || new Set(ids).size !== ids.length || ids.join() !== [...ids].sort().join()) refuse('BAD_STATE', 'ant ids');
    for (const a of q.ants) {
      const e = pending.get(a.next_event);
      if (!e || e.kind !== 'ant_bout_end' || e.scope.individual !== a.id || e.native.t !== a.until_s || e.native.clock !== `ant.${a.id}`) refuse('BAD_STATE', `${a.id}: pending event does not match the ant`);
      if (!(a.until_s > a.since_s) || compareExact(e!.exact, now) <= 0) refuse('BAD_STATE', `${a.id}: bout times`);
      if (!q.rng[`ant/${a.id}`] || !q.ledgers.ants[a.id]) refuse('BAD_STATE', `${a.id}: stream or ledger missing`);
    }
    if (Object.keys(q.rng).length !== ids.length) refuse('BAD_STATE', 'unexpected random streams');
    for (const id of [q.env.next_day_event, q.env.next_hour_event]) if (!pending.has(id)) refuse('BAD_STATE', `environment event ${id} is not pending`);
    const kinds = [...pending.values()].map((e) => e.kind), count = (k: string) => kinds.filter((x) => x === k).length;
    if (count('ant_bout_end') !== ids.length || count('env_day') !== 1 || count('env_hour') !== 1 || count('light_change') + ids.length + 2 !== kinds.length) refuse('BAD_STATE', 'queue has unexpected events');
    const total = Object.values(q.ledgers.events_by_kind).reduce((x, y) => x + y, 0);
    if (total !== q.seq) refuse('LEDGER_MISMATCH', `events by kind (${total}) != seq (${q.seq})`);
    return new ExperimentWorld(q, sched);
  }

  frame(): StateFrame {
    return {
      label: LABEL_ZH, official: false, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, t_sim: this.tSim(), seq: this.seq,
      ants: [...this.ants.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => ({ id: a.id, activity: a.activity, since_s: a.since_s, until_s: a.until_s, from: { ...a.pos }, to: a.target && { ...a.target }, in_nest: a.in_nest })),
      env: { date: this.env.date, light: this.env.light, temperature_c: this.env.temperature_c, temperature_synthetic: true },
      arena_radius_cm: this.params.arena_radius_cm,
    };
  }

  /** ledger conservation: per-kind counts sum to seq; per-ant bouts sum to ant events */
  checkLedgers(): void {
    const total = Object.values(this.ledgers.events_by_kind).reduce((x, y) => x + y, 0);
    if (total !== this.seq) refuse('LEDGER_MISMATCH', `${total} != ${this.seq}`);
    const bouts = Object.values(this.ledgers.ants).reduce((x, y) => x + y.bouts, 0);
    if (bouts !== (this.ledgers.events_by_kind.ant_bout_end ?? 0)) refuse('LEDGER_MISMATCH', 'bouts');
  }
}

// ------------------------------------------------------------------ event specs (all roots; cause in payload)
const ref = (world: string, individual: string | null) => ({ world, colony: individual ? 'exp' : null, individual });
function antSpec(world: string, a: AntState, cause: string | null): EventSpec {
  return { kind: 'ant_bout_end', key: `${a.id}.b${a.bout_index}`, native: { clock: `ant.${a.id}`, unit: 's', anchor: ORIGIN, t: a.until_s }, scope: ref(world, a.id), source: null, target: null, payload: cause };
}
function daySpec(world: string, day: number, cause: string | null): EventSpec {
  return { kind: 'env_day', key: `d${day}`, native: { clock: 'eco.calendar', unit: 'min', anchor: { day, minute: 0 }, t: 0 }, scope: ref(world, null), source: null, target: null, payload: { day, cause } };
}
function hourSpec(world: string, day: number, hour: number, cause: string | null): EventSpec {
  return { kind: 'env_hour', key: `d${day}.h${hour}`, native: { clock: 'eco.weather', unit: 'min', anchor: { day, minute: 0 }, t: hour * 60 }, scope: ref(world, null), source: null, target: null, payload: { day, hour, cause } };
}
function lightSpec(world: string, day: number, transition: string, minute: number, cause: string): EventSpec {
  return { kind: 'light_change', key: `d${day}.${transition}`, native: { clock: 'eco.light', unit: 'min', anchor: { day, minute: 0 }, t: minute }, scope: ref(world, null), source: null, target: null, payload: { day, transition, minute, cause } };
}

/** only the pending events, with an unstarted clock at a tick at or before `now` (every pending event is after now) */
export function compactScheduler(s: SchedulerSnapshot, now: ExactTime): SchedulerSnapshot {
  const tick = Math.max(0, Math.floor(now.us / 60) - 1);
  return {
    schema: s.schema, world: s.world, time: { ...s.time },
    clock: { at: { day: now.day, minute: tick / TICKS_PER_MINUTE }, round: -1, started: false, closed_day: -1 },
    log_seq: 0,
    events: s.events.filter((e) => e.state === 'scheduled'),
  };
}
