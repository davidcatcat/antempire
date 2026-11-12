/**
 * P0-A2 phase 2 — ISOLATED 24-hour individual-behaviour prototype (docs/p0a2-24h-prototype.md, design
 * docs/p0a2-24h-behaviour-design.md). NON-OFFICIAL Day0 experiment world only: writes nothing, is not imported by any
 * official code, is not in the rules fingerprint, never touches saves/ or journal/.
 *
 * Time: continuous event time. Every event happens at an exact instant t (integer ms since experiment Day0 00:00 local)
 * and is processed in the 'layered' order of docs/p0a0-time-contract.md: (exact instant, round, then a seeded tie-break hash32(seed|t|id), then canonical id). A child
 * at its cause's instant runs in the next round. Delays are drawn in the producer's own time and added exactly (integer
 * ms). There are no frames or ticks: advanceTo(T) runs every event with t <= T, so how the caller chunks time (1 s,
 * 37 s, 1 h, 24 h at once, or a snapshot / restore in between) cannot change what happens.
 * Randomness: each event draws from its OWN stream, rng(hash32(seed|event id)) (content-derived, as
 * engine/scheduler/world-events.ts rngStreamName prescribes) — no shared sequential stream, so no RNG state to save.
 *
 * Locality (CLAUDE.md §2.1, §2.1b): decisions are in decision.ts and receive only guarded views built here from ONE
 * individual (its own physiology, traits, memory, experienced contacts) and its OWN location (temperature and light at
 * the entrance / outside, food present at a source it reached, the crop distension of a nestmate or the begging of a
 * larva it actually touched). Colony totals exist only in `stats` and `ledger` (statistics and conservation checks).
 * Environment (environment.ts) is a pure function of time and scenario; it never reads the colony (§2.2).
 *
 * Why not engine/scheduler/world-events.ts WorldScheduler directly: its canonical id chains the cause id
 * (`cause/kind:key`), so an individual's causal chain over days grows ids without bound, and it keeps every finished
 * event; this prototype keeps the same ordering contract and id rules (content-derived, never array positions) in a
 * small queue whose snapshot holds only live events. Merging the two is a phase-3 engineering question (document §7).
 */
import { hash32, rng } from '../../engine/rng.ts';
import { sha256Hex } from '../../engine/sha256.ts';
import { US_PER_DAY, type ExactTime } from '../../engine/scheduler/world-events.ts';
import { canon } from './canon.ts';
import { chooseInNest, decideAtSource, decideExit, decideFeedLarva, decideTransfer, ownNeed, ownReserve } from './decision.ts';
import { Environment, MS_PER_DAY, MS_PER_HOUR, dayOf, hourOfDay } from './environment.ts';
import { type Model, buildModel } from './params.ts';
import { type CarerView, type DonorView, type Json, type Larva, type Loc, type QEvent, type SelfView, type Stats, type Worker, type WorkerState, type WorldState, WORKER_STATES } from './types.ts';

export const STATE_SCHEMA = 'antempire.p0a2-24h-proto.state.v1';
export const LOG_GENESIS = 'antempire.p0a2-24h-proto.log.v1';
export const SOURCE_ID = 'hemiptera-A';
export const WORKER_KINDS = ['bout_end', 'wake', 'at_entrance', 'back_in', 'arrive_source', 'feed_end', 'search_end', 'arrive_nest'] as const;
export const WORLD_KINDS = ['env_day', 'env_light', 'env_sample', 'produce'] as const;

const fail = (m: string): never => { throw Error(`P0A2: ${m}`); };
const pad = (n: number, w: number) => String(n).padStart(w, '0');
/** order: exact instant, round, seeded tie-break q (so same-instant events of different actors are not ordered by id,
 *  which would systematically favour w001 over w030), canonical id (only if q collides) */
const cmp = (a: QEvent, b: QEvent) => a.t - b.t || a.r - b.r || a.q - b.q || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** the seeded tie-break of an event: a pure function of seed, instant and id (deterministic and chunk-invariant).
 *  A transitional ENGINEERING arbitration (Owner #193 Q4), NOT a claimed natural competition rule; its fairness (no id
 *  bias in first-served position), chunk invariance and replay are verified in tests/p0a2-24h-proto.test.ts §8b. */
export const tieOf = (seed: number, t: number, id: string): number => hash32(`${seed}|${t}|${id}`);

/** an exact instant of the shared world axis (engine/scheduler ExactTime) for a prototype instant — for phase 3 */
export const exactOfMs = (t: number): ExactTime => ({ day: dayOf(t), us: (t - dayOf(t) * MS_PER_DAY) * 1000, us_lo: 0 });
if (US_PER_DAY !== MS_PER_DAY * 1000) fail('day length mismatch with the world scheduler');

// ------------------------------------------------------------------ locality guard
export class LocalityError extends Error { constructor(what: string) { super(`LOCALITY: ${what} is not a local signal of this individual`); this.name = 'LocalityError'; } }
/** a frozen copy of a view that throws on any field it does not have (a decision cannot reach anything else) */
export function guardView<T extends object>(o: T, name: string): T {
  const frozen = Object.freeze({ ...o });
  return new Proxy(frozen, {
    get(t, k, r) { if (typeof k === 'string' && !Object.prototype.hasOwnProperty.call(t, k)) throw new LocalityError(`${name}.${k}`); return Reflect.get(t, k, r); },
    set() { throw new LocalityError(`${name} (write)`); },
    defineProperty() { throw new LocalityError(`${name} (define)`); },
  });
}

// ------------------------------------------------------------------ own metabolism (process 1) and hunger diagnostics
/** the booking fields an individual's own pool (worker crop / larval gut) shares */
interface Pool { last: number; carry: number; consumed: number; empty_since: number | null; empty_ms: number; max_empty_ms: number }
/** book a constant own consumption `rate` (µP / day) from a pool holding `have` µP over [x.last, t] (exact integers);
 *  returns what was taken and the unmet part. Also books the HUNGER DIAGNOSTICS (statistics only, never in a view):
 *  the instant the pool ran dry inside the interval, total and longest continuous time empty. A pool refilled since
 *  its last booking ended its spell then (refills only happen at instants where the receiver is booked) */
export function drainPool(x: Pool, have: number, rate: number, t: number): { take: number; short: number } {
  if (t < x.last) fail('booked backwards');
  const num = (t - x.last) * rate + x.carry, need = Math.floor(num / MS_PER_DAY);
  if (have > 0) x.empty_since = null;
  const dry = have === 0 ? x.last : rate > 0 && need >= have ? x.last + Math.ceil((have * MS_PER_DAY - x.carry) / rate) : null;
  if (dry !== null) { x.empty_ms += t - dry; if (x.empty_since === null) x.empty_since = dry; x.max_empty_ms = Math.max(x.max_empty_ms, t - x.empty_since); }
  x.carry = num - need * MS_PER_DAY;
  const take = Math.min(need, have); x.consumed += take; x.last = t;
  return { take, short: need - take };
}

// ------------------------------------------------------------------ queue
class Heap {
  a: QEvent[] = [];
  get size() { return this.a.length; }
  peek(): QEvent | undefined { return this.a[0]; }
  push(e: QEvent) { const a = this.a; a.push(e); let i = a.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (cmp(a[i], a[p]) >= 0) break; [a[i], a[p]] = [a[p], a[i]]; i = p; } }
  pop(): QEvent | undefined {
    const a = this.a; if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) { a[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && cmp(a[l], a[m]) < 0) m = l; if (r < a.length && cmp(a[r], a[m]) < 0) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; i = m; } }
    return top;
  }
}

const emptyStats = (): Stats => ({
  occ: Object.fromEntries(WORKER_STATES.map((s) => [s, new Array(24).fill(0)])) as Record<WorkerState, number[]>,
  exits_by_hour: new Array(24).fill(0), declines_by_hour: new Array(24).fill(0), returns_by_hour: new Array(24).fill(0),
  temp_unavailable: 0, heat_refusals: 0, searches_found: 0, searches_failed: 0, trophallaxis_events: 0, larva_feeds: 0, same_instant_events: 0,
});

export interface WorldOptions {
  /** keep every log line in memory (tests, observers); the hash chain is kept regardless */
  captureLog?: boolean;
  /** variant of params.json (default: its reference_variant, 'ft-flat' — Owner #193 Q1 = B); stored in the state */
  variant?: string;
  /** TEST INSTRUMENTATION ONLY: called with every guarded view handed to a decision (read-only, frozen); cannot change
   *  anything and does not change results (tests check the hashes with and without it). Not offered to any UI. */
  inspectViews?: (view: string, actor: string, t: number, v: object) => void;
}

export class World {
  readonly m: Model; readonly env: Environment;
  /** the canonical log lines of this World object's run (only what it executed itself; null unless captured) */
  readonly lines: string[] | null;
  #s: WorldState; #heap = new Heap();
  #workerIds: string[]; #larvaIds: string[];
  readonly #inspect: WorldOptions['inspectViews'] | null;

  private constructor(m: Model, s: WorldState, opts: WorldOptions) {
    this.m = m; this.env = new Environment(m); this.#s = s; this.lines = opts.captureLog ? [] : null; this.#inspect = opts.inspectViews ?? null;
    for (const e of s.queue) this.#heap.push(e);
    s.queue = [];
    this.#workerIds = Object.keys(s.workers).sort(); this.#larvaIds = Object.keys(s.larvae).sort();
  }

  /** a fresh experiment world at Day0 00:00 (t = 0) */
  static create(rawParams: unknown, scenario: string, seed: number, opts: WorldOptions = {}): World {
    if (!Number.isSafeInteger(seed) || seed < 0) fail('seed must be a non-negative integer');
    const m = buildModel(rawParams, scenario, opts.variant), variant = m.variant;
    const workers: Record<string, Worker> = {}, larvae: Record<string, Larva> = {}, queue: QEvent[] = [];
    let initial = 0;
    for (let i = 1; i <= m.workers; i++) {
      const id = `w${pad(i, 3)}`, g = rng(hash32(`${seed}|init|${id}`));
      const crop = Math.floor(g() * m.init_crop_max * m.crop_cap); initial += crop;
      const lerp = (r: [number, number]) => r[0] + g() * (r[1] - r[0]);
      workers[id] = { id, state: 'resting', loc: 'nest', since: 0, crop, last: 0, carry: 0, consumed: 0, debt: 0,
        theta_forage: lerp(m.theta_forage), theta_brood: lerp(m.theta_brood), gain: lerp(m.gain), thermal_offset_c: 0, ctmax_c: m.ctmax_c,
        route: null, trip_loaded: false, empty_streak: 0, last_intake_t: null, forage_interval_ms: null, contacts: [], begging: [],
        empty_since: crop === 0 ? 0 : null, empty_ms: 0, max_empty_ms: 0, pending: null, n: 0 };
      const w = workers[id], first = Math.max(1, Math.round(-m.rest_ms * Math.log(1 - g())));
      const eid = `${id}#${pad(w.n++, 8)}`, ev: QEvent = { t: first, r: 0, q: tieOf(seed, first, eid), id: eid, k: 'bout_end', a: id, p: {} };
      w.pending = ev.id; queue.push(ev);
    }
    for (let i = 1; i <= m.larvae; i++) {
      const id = `l${pad(i, 2)}`, g = rng(hash32(`${seed}|init|${id}`));
      const gut = Math.floor(g() * m.init_gut_max * m.gut_cap); initial += gut;
      larvae[id] = { id, gut, last: 0, carry: 0, consumed: 0, deficit: 0, received: 0, empty_since: gut === 0 ? 0 : null, empty_ms: 0, max_empty_ms: 0 };
    }
    queue.push({ t: 0, r: 0, q: tieOf(seed, 0, 'env:d00000:day'), id: 'env:d00000:day', k: 'env_day', a: 'env', p: { day: 0 } });
    const pid = `${SOURCE_ID}#${pad(0, 8)}`;
    queue.push({ t: m.honeydew_ms, r: 0, q: tieOf(seed, m.honeydew_ms, pid), id: pid, k: 'produce', a: SOURCE_ID, p: {} });
    const s: WorldState = {
      schema: STATE_SCHEMA, official: false, params_sha: m.params_sha, scenario, variant, seed, t_now: 0,
      workers, larvae, sources: { [SOURCE_ID]: { id: SOURCE_ID, stock: 0, produced: 0, taken: 0, n: 1 } },
      ledger: { initial, produced: 0 }, log: { count: 0, hash: sha256Hex(LOG_GENESIS) }, stats: emptyStats(), queue, last_key: null,
    };
    return new World(m, s, opts);
  }

  /** restore a snapshot() taken under the same parameter file; refuses anything else */
  static restore(rawParams: unknown, snapshot: string, opts: WorldOptions = {}): World {
    const s = JSON.parse(snapshot) as WorldState;
    if (s.schema !== STATE_SCHEMA || s.official !== false) fail('snapshot schema mismatch (or not an experiment world)');
    const m = buildModel(rawParams, s.scenario, s.variant);
    if (m.params_sha !== s.params_sha) fail('snapshot was taken under another parameter file');
    if (canon(s) !== snapshot) fail('snapshot is not in canonical form');
    return new World(m, s, opts);
  }

  get t_now(): number { return this.#s.t_now; }
  get seed(): number { return this.#s.seed; }
  get logHash(): string { return this.#s.log.hash; }
  get logCount(): number { return this.#s.log.count; }

  /** run every event with t <= T (exact instants; nothing depends on how T is chosen) */
  advanceTo(T: number): void {
    if (!Number.isSafeInteger(T) || T < this.#s.t_now) fail(`advanceTo(${T}): must be an integer ms >= t_now (${this.#s.t_now})`);
    for (;;) { const e = this.#heap.peek(); if (!e || e.t > T) break; this.#heap.pop(); this.#exec(e); }
    this.#s.t_now = T;
  }

  /** complete state as canonical JSON (live queue included, stale entries dropped) */
  snapshot(): string {
    const live = this.#heap.a.filter((e) => !(e.a in this.#s.workers) || this.#s.workers[e.a].pending === e.id).sort(cmp);
    return canon({ ...this.#s, queue: live });
  }
  stateHash(): string { return sha256Hex(this.snapshot()); }

  /** read-only copies for observers / tests (never fed back) */
  stats(): Stats { return JSON.parse(JSON.stringify(this.#s.stats)); }
  view(): Pick<WorldState, 'workers' | 'larvae' | 'sources' | 'ledger' | 't_now'> { const s = this.#s; return JSON.parse(JSON.stringify({ workers: s.workers, larvae: s.larvae, sources: s.sources, ledger: s.ledger, t_now: s.t_now })); }

  /** food conservation (µP, exact integers) and individual counts — statistics only */
  conservation(): { ok: boolean; held: number; used: number; initial: number; produced: number; workers: number; larvae: number } {
    const s = this.#s; let held = 0, used = 0, prod = 0;
    for (const w of Object.values(s.workers)) { held += w.crop; used += w.consumed; if (w.crop < 0) fail(`${w.id} crop < 0`); }
    for (const l of Object.values(s.larvae)) { held += l.gut; used += l.consumed; if (l.gut < 0) fail(`${l.id} gut < 0`); }
    for (const x of Object.values(s.sources)) { held += x.stock; prod += x.produced; if (x.stock < 0) fail(`${x.id} stock < 0`); }
    const workers = Object.keys(s.workers).length, larvae = Object.keys(s.larvae).length;
    return { ok: held + used === s.ledger.initial + s.ledger.produced && prod === s.ledger.produced && workers === this.m.workers && larvae === this.m.larvae, held, used, initial: s.ledger.initial, produced: s.ledger.produced, workers, larvae };
  }

  // ---------------------------------------------------------------- event execution
  #exec(e: QEvent): void {
    const s = this.#s, w = s.workers[e.a];
    if (w && w.pending !== e.id) return; // stale: superseded by a wake (logged by the event that woke it)
    if (s.last_key && s.last_key.t === e.t && s.last_key.r === e.r && s.last_key.a !== e.a) s.stats.same_instant_events++;
    s.last_key = { t: e.t, r: e.r, a: e.a };
    const g = rng(hash32(`${s.seed}|${e.id}`));
    let out: { [k: string]: Json };
    if (w) {
      w.pending = null;
      this.#book(w, e.t);
      switch (e.k) {
        case 'bout_end': out = { from: w.state, ...(w.state === 'idle' ? { larvae: this.#touchLarvae(w, e.t, g, false) } : {}), ...this.#decideInNest(w, e, g) }; break;
        case 'wake': out = { from: w.state, ...this.#decideInNest(w, e, g) }; break;
        case 'at_entrance': out = this.#atEntrance(w, e, g); break;
        case 'back_in': this.#set(w, e.t, 'resting', 'nest'); this.#next(w, e, 'bout_end', this.#exp(g, this.m.rest_ms)); out = { to: 'resting' }; break;
        case 'arrive_source': out = this.#arriveSource(w, e, g); break;
        case 'feed_end': w.trip_loaded = w.crop / this.m.crop_cap >= this.m.recruit_min_fill; this.#set(w, e.t, 'returning', 'outside'); this.#next(w, e, 'arrive_nest', this.m.travel_ms); out = { crop: w.crop, loaded: w.trip_loaded }; break;
        case 'search_end': out = this.#searchEnd(w, e, g); break;
        case 'arrive_nest': out = this.#arriveNest(w, e, g); break;
        default: return fail(`unknown worker event kind ${e.k}`);
      }
      if (w.pending === null) fail(`${w.id} has no next event after ${e.id}`);
    } else if (e.k === 'produce') {
      const src = s.sources[e.a], amt = this.m.honeydew_amount;
      src.stock += amt; src.produced += amt; s.ledger.produced += amt;
      this.#push({ t: e.t + this.m.honeydew_ms, r: 0, q: 0, id: `${src.id}#${pad(src.n++, 8)}`, k: 'produce', a: src.id, p: {} });
      out = { amount: amt, stock: src.stock, source_kind: 'hemipteran honeydew (scenario)', synthetic: true };
    } else if (e.k === 'env_day') out = this.#envDay(e);
    else if (e.k === 'env_light') out = { to: e.p.to, date: e.p.date, minute_local: e.p.minute_local };
    else if (e.k === 'env_sample') out = { temp_c: this.env.airTemp(e.t), rh_percent: this.env.rh(e.t), rain: null, synthetic: true, assumption: true };
    else return fail(`unknown event kind ${e.k}`);
    const line = canon({ t: e.t, r: e.r, q: e.q, id: e.id, k: e.k, a: e.a, p: out });
    s.log.hash = sha256Hex(s.log.hash + line); s.log.count++;
    this.lines?.push(line);
  }

  /** queue an event; its tie-break is always recomputed here from (seed, t, id) */
  #push(e: QEvent) { if (e.t < this.#s.t_now) fail(`${e.id} scheduled before the clock`); e.q = tieOf(this.#s.seed, e.t, e.id); this.#heap.push(e); }
  /** a guarded view for a decision; the test inspector (if any) sees the same frozen view */
  #gv<T extends object>(o: T, name: string, actor: string, t: number): T { const v = guardView(o, name); this.#inspect?.(name, actor, t, v); return v; }
  /** schedule the worker's one next event `delay` ms after the cause (round + 1 when at the same instant) */
  #next(w: Worker, cause: QEvent, kind: string, delay: number): string {
    if (!Number.isSafeInteger(delay) || delay < 0) fail(`delay ${delay}`);
    const ev: QEvent = { t: cause.t + delay, r: delay === 0 ? cause.r + 1 : 0, q: 0, id: `${w.id}#${pad(w.n++, 8)}`, k: kind, a: w.id, p: {} };
    w.pending = ev.id; this.#push(ev); return ev.id;
  }
  #exp(g: () => number, mean: number): number { return Math.max(1, Math.round(-mean * Math.log(1 - g()))); }

  /** book metabolism and the time budget of the worker's current state up to t (exact integer arithmetic) */
  #book(w: Worker, t: number): void {
    if (t < w.last) fail(`${w.id} booked backwards`);
    const occ = this.#s.stats.occ[w.state];
    for (let a = w.last; a < t;) { const end = Math.min(t, (Math.floor(a / MS_PER_HOUR) + 1) * MS_PER_HOUR); occ[hourOfDay(a)] += end - a; a = end; }
    // (1) own metabolism: from its own crop only; an unmet need is `debt` (diagnostic, not food)
    const d = drainPool(w, w.crop, this.m.worker_rate, t); w.crop -= d.take; w.debt += d.short;
  }
  #bookLarva(l: Larva, t: number): void { const d = drainPool(l, l.gut, this.m.larva_rate, t); l.gut -= d.take; l.deficit += d.short; }

  /** HUNGER, GROWTH-PROXY AND 'DEATH'-PROXY DIAGNOSTICS at t_now (statistics only: computed on copies, books nothing,
   *  never fed back). Development and starvation death are NOT modelled: `received` is food received (growth proxy)
   *  and the long-spell counts are diagnostic thresholds, not deaths */
  hunger(): { workers: HungerRow[]; larvae: HungerRow[] } {
    const s = this.#s, T = s.t_now;
    const row = (id: string, x: Pool & { debt?: number; deficit?: number; received?: number }, have: number, rate: number): HungerRow => {
      const c = JSON.parse(JSON.stringify(x)) as Pool, d = drainPool(c, have, rate, T);
      return { id, unmet: (x.debt ?? x.deficit ?? 0) + d.short, empty_ms: c.empty_ms, max_empty_ms: c.max_empty_ms, empty_now: have - d.take === 0, received: x.received ?? null, held: have - d.take };
    };
    return {
      workers: this.#workerIds.map((id) => row(id, s.workers[id], s.workers[id].crop, this.m.worker_rate)),
      larvae: this.#larvaIds.map((id) => row(id, s.larvae[id], s.larvae[id].gut, this.m.larva_rate)),
    };
  }
  #set(w: Worker, t: number, state: WorkerState, loc: Loc): void { this.#book(w, t); w.state = state; w.loc = loc; w.since = t; }

  /** the worker's own view; buffers are pruned to the contact window at the worker's own event */
  #self(w: Worker, t: number): SelfView {
    const from = t - this.m.window_ms;
    w.contacts = w.contacts.filter((c) => c.t >= from); w.begging = w.begging.filter((b) => b.t >= from);
    return this.#gv<SelfView>({
      crop: w.crop, crop_room: this.m.crop_cap - w.crop, crop_fill: w.crop / this.m.crop_cap,
      theta_forage: w.theta_forage, theta_brood: w.theta_brood, gain: w.gain, thermal_offset_c: w.thermal_offset_c, ctmax_c: w.ctmax_c,
      has_route: w.route !== null,
      recruit_contacts_recent: w.contacts.filter((c) => c.loaded).length,
      begging_recent: w.begging.filter((b) => b.signal >= this.m.consts.brood.begging_threshold).length,
      forage_interval_ms: w.forage_interval_ms,
    }, 'self', w.id, t);
  }

  /** (2) the returning forager's own view when it offers trophallaxis */
  #donor(w: Worker, t: number): DonorView { return this.#gv<DonorView>({ crop: w.crop, forage_interval_ms: w.forage_interval_ms }, 'donor', w.id, t); }
  /** (3) the carer's own view when it feeds a larva it touched */
  #carer(w: Worker, t: number): CarerView { return this.#gv<CarerView>({ crop: w.crop, crop_fill: w.crop / this.m.crop_cap, forage_interval_ms: w.forage_interval_ms }, 'carer', w.id, t); }

  #decideInNest(w: Worker, e: QEvent, g: () => number): { [k: string]: Json } {
    const c = chooseInNest(this.#self(w, e.t), this.m.consts, g(), g(), g());
    if (c === 'forage') { this.#set(w, e.t, 'to_entrance', 'nest_transit'); this.#next(w, e, 'at_entrance', this.m.move_ms); return { choice: c }; }
    if (c === 'brood') {
      this.#set(w, e.t, 'brood_care', 'nest');
      // brood candidates on (isolated experiment only): log the carer's own brood reserve before and its crop after, so
      // tests can verify from the log that a carer never feeds below its own reserve; reference: nothing added
      const b = this.m.consts.brood, logged = b.retention !== null || b.min_own_crop_fill !== null;
      const pre: { [k: string]: Json } = logged ? { carer_reserve: ownNeed(this.#carer(w, e.t), b.retention, this.m.consts), carer_crop: w.crop } : {};
      const larvae = this.#touchLarvae(w, e.t, g, true);
      this.#next(w, e, 'bout_end', this.#exp(g, this.m.brood_ms));
      return { choice: c, larvae, ...pre, ...(logged ? { carer_crop_left: w.crop } : {}) };
    }
    if (c === 'idle') { this.#set(w, e.t, 'idle', 'nest'); this.#next(w, e, 'bout_end', this.#exp(g, this.m.idle_ms)); return { choice: c }; }
    this.#set(w, e.t, 'resting', 'nest'); this.#next(w, e, 'bout_end', this.#exp(g, this.m.rest_ms)); return { choice: c };
  }

  /** larvae the worker actually touches (each with its own probability); it perceives each one's begging; feeds if asked */
  #touchLarvae(w: Worker, t: number, g: () => number, feed: boolean): Json[] {
    const out: Json[] = [];
    for (const id of this.#larvaIds) {
      if (!(g() < this.m.larva_contact_p)) continue;
      const l = this.#s.larvae[id]; this.#bookLarva(l, t);
      const signal = 1 - l.gut / this.m.gut_cap;
      w.begging.push({ t, larva: id, signal });
      let fed = 0;
      if (feed) {
        // (3) adult→brood feeding: the carer's own view, the begging of THIS larva at THIS contact; the graded trigger
        // (isolated experiment only) draws one uniform from the event's own stream, the reference draws nothing
        const u = this.m.consts.brood.trigger === 'graded' ? g() : 0;
        fed = decideFeedLarva(this.#carer(w, t), this.#gv({ begging: signal, room: this.m.gut_cap - l.gut }, 'larva', w.id, t), this.m.consts, u);
        if (fed > w.crop || fed > this.m.gut_cap - l.gut) fail(`${w.id} -> ${id}: a feed beyond the carer's crop or the larva's room`);
        if (fed > 0) { l.gut += fed; l.received += fed; w.crop -= fed; this.#s.stats.larva_feeds++; }
      }
      out.push({ larva: id, signal, fed });
    }
    return out;
  }

  #atEntrance(w: Worker, e: QEvent, g: () => number): { [k: string]: Json } {
    const temp = this.env.siteTemp(e.t), light = this.env.light(e.t), h = hourOfDay(e.t), st = this.#s.stats;
    const ch = decideExit(this.#self(w, e.t), this.#gv({ temp_c: temp, light }, 'site', w.id, e.t), this.m.consts, g());
    if (ch === 'exit') {
      st.exits_by_hour[h]++;
      if (w.route) { this.#set(w, e.t, 'outbound', 'outside'); this.#next(w, e, 'arrive_source', this.m.travel_ms); }
      else { this.#set(w, e.t, 'searching', 'outside'); this.#next(w, e, 'search_end', this.#exp(g, this.m.search_ms)); }
      return { choice: ch, temp_c: temp, light, route: w.route };
    }
    if (ch === 'temp_unavailable') st.temp_unavailable++;
    if (ch === 'heat') st.heat_refusals++;
    st.declines_by_hour[h]++;
    // walks back inside: it is in the nest (contactable) only once it arrives (back_in)
    this.#set(w, e.t, 'from_entrance', 'nest_transit');
    this.#next(w, e, 'back_in', this.m.move_ms);
    return { choice: ch, temp_c: temp, light };
  }

  #arriveSource(w: Worker, e: QEvent, _g: () => number): { [k: string]: Json } {
    const src = this.#s.sources[w.route!], temp = this.env.siteTemp(e.t);
    const d = decideAtSource(this.#self(w, e.t), this.#gv({ food_here: src.stock, temp_c: temp }, 'source', w.id, e.t));
    if (d.heat) {
      this.#s.stats.heat_refusals++; w.trip_loaded = w.crop / this.m.crop_cap >= this.m.recruit_min_fill;
      this.#set(w, e.t, 'returning', 'outside'); this.#next(w, e, 'arrive_nest', this.m.travel_ms);
      return { source: src.id, heat: true, temp_c: temp };
    }
    const take = Math.min(d.take, src.stock);
    if (take <= 0) {
      // own experience only: consecutive empty arrivals; the give-up switch (off in the reference) forgets the route
      w.empty_streak++;
      const forgot = this.m.give_up_empty_trips !== null && src.stock === 0 && w.empty_streak >= this.m.give_up_empty_trips;
      if (forgot) { w.route = null; w.empty_streak = 0; }
      w.trip_loaded = false; this.#set(w, e.t, 'returning', 'outside'); this.#next(w, e, 'arrive_nest', this.m.travel_ms);
      return { source: src.id, take: 0, seen: src.stock, ...(forgot ? { forgot_route: true } : {}) };
    }
    w.empty_streak = 0;
    // own experience only (read by the Q2 retention candidate, default off): interval between its own source intakes
    if (w.last_intake_t !== null) w.forage_interval_ms = e.t - w.last_intake_t;
    w.last_intake_t = e.t;
    src.stock -= take; src.taken += take; w.crop += take;
    this.#set(w, e.t, 'feeding', 'outside');
    this.#next(w, e, 'feed_end', Math.max(1, Math.round((this.m.fill_ms_full * take) / this.m.crop_cap)));
    return { source: src.id, take, temp_c: temp };
  }

  #searchEnd(w: Worker, e: QEvent, g: () => number): { [k: string]: Json } {
    if (g() < this.m.find_p) { this.#s.stats.searches_found++; w.route = SOURCE_ID; return { found: SOURCE_ID, ...this.#arriveSource(w, e, g) }; }
    this.#s.stats.searches_failed++; w.trip_loaded = false;
    this.#set(w, e.t, 'returning', 'outside'); this.#next(w, e, 'arrive_nest', this.m.travel_ms);
    return { found: null };
  }

  /** back in the nest: meets nestmates that are in the nest (each with its own probability), offers crop contents, and
   *  — if it is a loaded forager — passes the recruitment signal (route) and wakes resting or idle nestmates it touched */
  #arriveNest(w: Worker, e: QEvent, g: () => number): { [k: string]: Json } {
    const s = this.#s, t = e.t;
    s.stats.returns_by_hour[hourOfDay(t)]++;
    this.#set(w, t, 'idle', 'nest');
    const met: { id: string; k: number }[] = [];
    for (const id of this.#workerIds) if (id !== w.id && s.workers[id].loc === 'nest' && g() < this.m.nest_contact_p) met.push({ id, k: g() });
    // meeting order is random (own stream), never array or id order
    met.sort((a, b) => a.k - b.k || (a.id < b.id ? -1 : 1));
    const loaded = w.trip_loaded, touched: Json[] = [];
    for (const { id } of met.slice(0, this.m.max_trophallaxis)) {
      const J = s.workers[id]; this.#book(J, t);
      const amt = decideTransfer(this.#donor(w, t), this.#gv({ crop_room: this.m.crop_cap - J.crop }, 'partner', w.id, t), this.m.consts);
      if (amt > w.crop || amt > this.m.crop_cap - J.crop) fail(`${w.id} -> ${id}: a transfer beyond the donor's crop or the partner's room`);
      if (amt > 0) { J.crop += amt; w.crop -= amt; s.stats.trophallaxis_events++; }
      J.contacts.push({ t, from: w.id, loaded, route: loaded ? w.route : null });
      if (loaded && w.route && J.route === null) J.route = w.route;
      let woke: string | null = null;
      if (loaded && this.m.contact_wakes && (J.state === 'resting' || J.state === 'idle')) woke = this.#next(J, e, 'wake', 0);
      touched.push({ worker: id, amount: amt, woke });
    }
    w.trip_loaded = false;
    // Q2 candidate on (isolated experiment only): log the forager's own reserve and what it kept, so tests can verify
    // the rule from the event log; with retention off (reference) nothing is added and the log is unchanged
    const kept: { [k: string]: Json } = this.m.consts.trophallaxis.retention === null ? {} : { reserve: ownReserve(this.#donor(w, t), this.m.consts), crop_left: w.crop };
    return { loaded, touched, ...kept, ...this.#decideInNest(w, e, g) };
  }

  #envDay(e: QEvent): { [k: string]: Json } {
    const d = e.p.day as number, base = d * MS_PER_DAY, L = this.env.lightTimes(d), tag = `env:d${pad(d, 5)}`;
    const child = (t: number, id: string, k: string, p: { [k: string]: Json }) => this.#push({ t, r: t === e.t ? e.r + 1 : 0, q: 0, id, k, a: 'env', p });
    // the event instant is the transition minute rounded to the ms (display / log); `to` names the state it starts
    for (const [name, minute, to] of [['civil_dawn', L.civil_dawn, 'civil_twilight'], ['sunrise', L.sunrise, 'day'], ['sunset', L.sunset, 'civil_twilight'], ['civil_dusk', L.civil_dusk, 'night']] as const) child(base + Math.round(minute * 60_000), `${tag}:light_${name}`, 'env_light', { date: L.date, to, minute_local: minute });
    for (let h = 0; h < 24; h++) child(base + h * MS_PER_HOUR, `${tag}:sample_h${pad(h, 2)}`, 'env_sample', {});
    child(base + MS_PER_DAY, `env:d${pad(d + 1, 5)}:day`, 'env_day', { day: d + 1 });
    return { date: L.date, sunrise_min: L.sunrise, sunset_min: L.sunset, temperature: 'synthetic scenario hourly profile', synthetic: true, assumption: true, rain: null };
  }
}

/** one individual's hunger diagnostics (World.hunger): unmet own need (µP), total / longest continuous empty time (ms),
 *  empty at t_now, food received from carers (larvae only; growth proxy), food held at t_now */
export interface HungerRow { id: string; unmet: number; empty_ms: number; max_empty_ms: number; empty_now: boolean; received: number | null; held: number }

/** convenience for tests and phase 3: build, run to t, return the world */
export function runTo(rawParams: unknown, scenario: string, seed: number, t: number, opts: WorldOptions = {}): World {
  const w = World.create(rawParams, scenario, seed, opts); w.advanceTo(t); return w;
}
