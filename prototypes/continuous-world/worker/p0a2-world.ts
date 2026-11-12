/**
 * Thin adapter: the P0-A2 24-hour individual-behaviour world (prototypes/p0a2-24h/, docs/p0a2-24h-prototype.md) inside
 * the NON-OFFICIAL experiment Worker (issue #156 phase 3). Candidate / experiment world only (Owner #201: no official
 * Day0 before Owner approval): every output carries LABEL_ZH and official:false; nothing is persisted here.
 *
 * This file does NOT change any P0-A2 behaviour. It only:
 *  - builds the world from prototypes/p0a2-24h/params.json (reference variant, one fixed weather scenario);
 *  - advances it with World.advanceTo(ms) (continuous event time; chunk-invariant, proven by tests/p0a2-24h-proto and
 *    tests/worker-runtime): the pacer's target (world seconds) is floored to the world's integer milliseconds;
 *  - turns the world's own canonical log lines into protocol events (one event per log line, seq = log position);
 *  - wraps World.snapshot() in the SAVE envelope (antempire.experiment-world-snapshot.v1) and restores it, refusing
 *    anything else (rules fingerprint = engine version + parameter file SHA-256 + code SHA-256 of the world's module
 *    graph + scenario + variant);
 *  - reports a state frame for the viewer: each worker's engine state (activity, location class, state start, its own
 *    crop fill, route memory), the larvae, the source stock (player view), the light state the workers sense, the
 *    synthetic temperature and, for drawing only, the sun altitude by the general method (engine/clock/solar.ts).
 * The frame and follow copies are read-only observation (CLAUDE.md §2.4): nothing in them reaches the world.
 * Pacing (speed, pause, frame rate) only chooses the advanceTo targets (runtime.ts); it cannot change results.
 *
 * Payload schema 2 (Owner ruling #200, option C; docs/save-format-v2.md §5): every emitted protocol event also advances
 * the event-chain commitment (chain.ts, antempire.event-chain.v1, the same definition as the synthetic world) and the
 * payload carries save_meta (world kind p0a2-24h-v1, trusted initial conditions, species / environment fingerprints,
 * fork lineage) and chain (head + count). Recording the chain draws nothing and changes no event or world state; restore
 * checks the chain's shape, genesis and count (the head itself only by Node recomputation, cli/verify-save.ts).
 */
import raw from '../../p0a2-24h/params.json' with { type: 'json' };
import { World, exactOfMs, SOURCE_ID } from '../../p0a2-24h/world.ts';
import type { ExactTime } from '../../../engine/scheduler/world-events.ts';
import { canon } from '../../p0a2-24h/canon.ts';
import { applyVariant, buildModel } from '../../p0a2-24h/params.ts';
import { dayOf, MS_PER_DAY } from '../../p0a2-24h/environment.ts';
import { solarAltitude } from '../../../engine/clock/solar.ts';
import { dateOfDay } from '../../../engine/clock/time-frames.ts';
import { canonicalJson, hashJson } from './sha256.ts';
import { chainNext, chainShapeProblem, chainStart, type ChainState } from './chain.ts';
import { P0A2_CODE_FILES, P0A2_CODE_SHA256 } from './p0a2-code-hash.ts';

/** the same strings as the synthetic world (worker/params.ts; tests check equality), kept here so that a change of the
 *  synthetic world's parameters does not change the P0-A2 code hash */
export const LABEL_ZH = '非正式實驗世界／不屬於正式遊戲歷史';
export const SNAPSHOT_SCHEMA = 'antempire.experiment-world-snapshot.v1';
/** bump the engine version or the payload schema on any change of what this adapter emits or stores (the code hash
 *  also changes with every module it runs) */
export const P0A2_ENGINE_VERSION = 'experiment-p0a2-24h/1';
/** payload schema 2 (Owner ruling #200): payload.save_meta + payload.chain (event-chain commitment). Snapshots of
 *  schema 1 are refused (no chain; kept unchanged, no migration path). docs/save-format-v2.md §6. */
export const P0A2_SCHEMA_VERSION = 2;
/** the runtime / protocol world kind (init command, frames, payload.world_kind) */
export const P0A2_WORLD_KIND = 'p0a2';
/** the save-format world kind (payload.save_meta.world_kind; the Node verifier's registry id, world-kinds.ts) */
export const P0A2_SAVE_WORLD_KIND = 'p0a2-24h-v1';
/** the weather scenario of the experiment page (params.json; synthetic: true); the reference variant of the file is used */
export const P0A2_SCENARIO = 'taichung-march-ref';
/** product label of this world (Owner #201): a candidate / experiment world, never an official Day0 */
export const P0A2_STATUS_ZH = '候選／實驗世界，非正式';

export class P0a2Refused extends Error {
  readonly code: string;
  constructor(code: string, msg: string) { super(`P0A2_WORLD ${code}: ${msg}`); this.name = 'P0a2Refused'; this.code = code; }
}
const refuse = (code: string, msg: string): never => { throw new P0a2Refused(code, msg); };
const WORLD_ID_RE = /^exp-[A-Za-z0-9._-]{1,60}$/;
type J = { [k: string]: unknown };

const RAW: unknown = raw;
/** the integer millisecond of an exact instant (inverse of exactOfMs); refuses instants off the millisecond grain */
function msOfExact(e: ExactTime): number {
  const ok = typeof e === 'object' && e !== null && Number.isSafeInteger(e.day) && e.day >= 0 && Number.isSafeInteger(e.us) && e.us >= 0 && e.us % 1000 === 0 && e.us_lo === 0;
  if (!ok) refuse('BAD_TIME', 'an exact instant of the P0-A2 world must be a whole millisecond (us multiple of 1000, us_lo 0)');
  const ms = e.day * MS_PER_DAY + e.us / 1000;
  if (e.us / 1000 >= MS_PER_DAY) refuse('BAD_TIME', 'us beyond one day');
  return ms;
}
const VARIANT: string = (raw as { reference_variant: string }).reference_variant;
/** the model of this runtime (validated once; buildModel refuses an incompletely labelled parameter file) */
export const P0A2_PARAMS_SHA = buildModel(RAW, P0A2_SCENARIO, VARIANT).params_sha;
/** nest-to-source distance of the model (params.json source_distance_mm, cm); the route's DIRECTION is not modelled */
const SOURCE_DISTANCE_CM = (applyVariant(RAW, VARIANT).parameters.source_distance_mm.value as number) / 10;
export const P0A2_RULES_FINGERPRINT = hashJson({ engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION, world_kind: P0A2_WORLD_KIND, params_sha256: P0A2_PARAMS_SHA, code_sha256: P0A2_CODE_SHA256, code_files: [...P0A2_CODE_FILES], scenario: P0A2_SCENARIO, variant: VARIANT });
/** id of the environment this world runs in: the synthetic weather scenario of params.json plus its site */
export const P0A2_ENVIRONMENT_ID = `p0a2-weather/${P0A2_SCENARIO}`;
/** SHA-256 of the environment definition (canonical {scenario, site, weather_scenario} of params.json) */
export const P0A2_ENVIRONMENT_SHA = hashJson({ scenario: P0A2_SCENARIO, site: (raw as { site: unknown }).site, weather_scenario: (raw as { weather_scenarios: Record<string, unknown> }).weather_scenarios[P0A2_SCENARIO] } as never);

/**
 * Save metadata of a P0-A2 world (payload schema 2, docs/save-format-v2.md §2 and §5): the world kind, the TRUSTED
 * initial conditions a verifier recomputes from (world id, seed, t = 0, this build's parameter-file SHA-256, scenario,
 * variant), species / environment fingerprints and the fork lineage. Constant for a world.
 */
export interface P0a2SaveMeta {
  format: 'antempire.experiment-save-meta.v1';
  world_kind: typeof P0A2_SAVE_WORLD_KIND;
  initial: { world_id: string; seed: number; t_sim: 0; params_sha256: string; scenario: string; variant: string; how: string };
  /** P0-A2 has no official species parameter file: null, with the reason (not fabricated) */
  species: { id: null; fingerprint: null; note: string };
  environment: { id: string; fingerprint: string; synthetic: true; note: string };
  /** fork records, oldest first (docs/save-format-v2.md §6). This runtime implements no fork: always empty. */
  lineage: never[];
}
export function p0a2SaveMetaOf(worldId: string, seed: number): P0a2SaveMeta {
  return {
    format: 'antempire.experiment-save-meta.v1', world_kind: P0A2_SAVE_WORLD_KIND,
    initial: { world_id: worldId, seed, t_sim: 0, params_sha256: P0A2_PARAMS_SHA, scenario: P0A2_SCENARIO, variant: VARIANT, how: 'P0a2ExperimentWorld.create(world_id, seed) with the runtime\'s own prototypes/p0a2-24h/params.json (scenario and reference variant above)' },
    species: { id: null, fingerprint: null, note: 'P0-A2 原型沒有正式物種參數檔（species/*.json）；個體參數在原型參數檔 prototypes/p0a2-24h/params.json（原型、非正式），其 SHA-256 見 initial.params_sha256' },
    environment: { id: P0A2_ENVIRONMENT_ID, fingerprint: P0A2_ENVIRONMENT_SHA, synthetic: true, note: '合成天氣情境（params.json weather_scenarios，synthetic: true）＋示意地點；光照由一般方法計算' },
    lineage: [],
  };
}

export interface P0a2Event {
  seq: number; event_id: string; kind: string; t_sim: number; exact: { day: number; us: number; us_lo: number }; round: number; entity: string | null;
  data: J; rng: null; world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  official: false; label: string;
}
export interface P0a2Payload {
  world_kind: typeof P0A2_WORLD_KIND; world_id: string; seed: number; engine_version: string; schema_version: number; rules_fingerprint: string;
  params_sha256: string; code_sha256: string; scenario: string; variant: string; t_sim: number; seq: number;
  /** World.snapshot() of prototypes/p0a2-24h (complete state: individuals, queue, log hash chain, ledger, statistics) */
  state: J;
  /** payload schema 2: constant save metadata and the event-chain commitment over every event emitted so far */
  save_meta: P0a2SaveMeta; chain: ChainState;
}
export interface P0a2Snapshot {
  schema: string; label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  t_sim: number; seq: number; payload: P0a2Payload; payload_sha256: string;
}

/** activity states of a worker that move it along the route nest entrance <-> source (fixed model travel time) */
const TRAVEL = new Set(['outbound', 'returning']);
/** states that move it between the nest interior and the entrance (fixed model in-nest move time) */
const TRANSIT = new Set(['to_entrance', 'from_entrance']);

export class P0a2ExperimentWorld {
  readonly worldId: string; readonly seed: number; readonly fingerprint = P0A2_RULES_FINGERPRINT;
  readonly world: World;
  private readonly meta: P0a2SaveMeta;
  private chain: ChainState;
  private constructor(worldId: string, w: World, chain: ChainState) { this.worldId = worldId; this.seed = w.seed; this.world = w; this.meta = p0a2SaveMetaOf(worldId, w.seed); this.chain = { ...chain }; }

  static create(worldId: string, seed: number): { world: P0a2ExperimentWorld; events: P0a2Event[] } {
    if (typeof worldId !== 'string' || !WORLD_ID_RE.test(worldId)) refuse('BAD_WORLD_ID', `world_id must match ${WORLD_ID_RE} (experiment worlds only)`);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) refuse('BAD_SEED', 'seed must be an integer in [0, 2^32)');
    const x = new P0a2ExperimentWorld(worldId, World.create(RAW, P0A2_SCENARIO, seed, { captureLog: true, variant: VARIANT }), chainStart({ world_kind: P0A2_SAVE_WORLD_KIND, world_id: worldId, seed, rules_fingerprint: P0A2_RULES_FINGERPRINT }));
    return { world: x, events: x.advanceTo(0).events };
  }

  tSim(): number { return this.world.t_now / 1000; }
  seqNo(): number { return this.world.logCount; }
  /** the exact instant of the world time (integer milliseconds) */
  nowExact(): ExactTime { return exactOfMs(this.world.t_now); }
  /** the event-chain commitment over every event emitted so far (copy) */
  chainState(): ChainState { return { ...this.chain }; }
  antIds(): string[] { return Object.keys(this.world.view().workers).sort(); }

  /**
   * Run every event at an instant <= t (world seconds; floored to the world's integer ms). maxEvents bounds the work
   * of one call: the world is advanced in 60 s slices and stops after the slice in which the bound was reached (the
   * world is then exactly at that slice end, every event up to it processed: a consistent boundary). Never skips.
   */
  advanceTo(t: number, maxEvents = Infinity): { events: P0a2Event[]; done: boolean } {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) refuse('BAD_TIME', 't must be a finite number >= 0');
    if (t < this.tSim()) refuse('TIME_BACKWARDS', `t ${t} is before the world time ${this.tSim()}`);
    return this.advanceMs(Math.max(this.world.t_now, Math.floor(t * 1000)), maxEvents);
  }

  /** advance to an integer world millisecond `end` (>= the world time); see advanceTo */
  private advanceMs(end: number, maxEvents: number): { events: P0a2Event[]; done: boolean } {
    const first = this.world.logCount;
    let done = true;
    if (maxEvents === Infinity || end === this.world.t_now) this.world.advanceTo(end);
    else for (let at = this.world.t_now; at < end;) {
      at = Math.min(end, at + 60_000); this.world.advanceTo(at);
      if (this.world.logCount - first >= maxEvents && at < end) { done = false; break; }
    }
    return { events: this.drain(first), done };
  }

  /** advanceTo with the end given as an exact instant (the Node verifier stops at a save's exact `now`); the instant
   *  must be a whole millisecond (the world's time grain), otherwise refused */
  advanceToExact(end: ExactTime, maxEvents = Infinity): { events: P0a2Event[]; done: boolean } {
    const ms = msOfExact(end);
    if (ms < this.world.t_now) refuse('TIME_BACKWARDS', `t ${ms / 1000} is before the world time ${this.tSim()}`);
    return this.advanceMs(ms, maxEvents);
  }

  private drain(first: number): P0a2Event[] {
    const lines = this.world.lines!.splice(0), out: P0a2Event[] = [];
    if (first + lines.length !== this.world.logCount || this.chain.count !== first) refuse('INTERNAL', 'log lines, log count and event chain disagree');
    let head = this.chain.head;
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]) as { t: number; r: number; q: number; id: string; k: string; a: string; p: J };
      const ev: P0a2Event = { seq: first + i, event_id: e.id, kind: e.k, t_sim: e.t / 1000, exact: exactOfMs(e.t), round: e.r, entity: e.a === 'env' ? null : e.a, data: { ...e.p, tie_q: e.q }, rng: null, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION, official: false, label: LABEL_ZH };
      head = chainNext(head, ev); out.push(ev);
    }
    this.chain = { algo: this.chain.algo, genesis: this.chain.genesis, head, count: this.chain.count + lines.length };
    return out;
  }

  payload(): P0a2Payload {
    return { world_kind: P0A2_WORLD_KIND, world_id: this.worldId, seed: this.seed, engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION, rules_fingerprint: this.fingerprint, params_sha256: P0A2_PARAMS_SHA, code_sha256: P0A2_CODE_SHA256, scenario: P0A2_SCENARIO, variant: VARIANT, t_sim: this.tSim(), seq: this.seqNo(), state: JSON.parse(this.world.snapshot()) as J, save_meta: p0a2SaveMetaOf(this.worldId, this.seed), chain: this.chainState() };
  }
  /** a snapshot at the current consistent boundary (between two advanceTo calls); a pure read */
  snapshot(): P0a2Snapshot {
    const payload = this.payload();
    return { schema: SNAPSHOT_SCHEMA, label: LABEL_ZH, official: false, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION, t_sim: payload.t_sim, seq: payload.seq, payload, payload_sha256: hashJson(payload) };
  }

  /** a NEW world from a snapshot; refuses (throws P0a2Refused) on any mismatch, never repairs or re-initialises */
  static restore(s: P0a2Snapshot): P0a2ExperimentWorld {
    if (!s || typeof s !== 'object') refuse('BAD_SNAPSHOT', 'not an object');
    const keys = Object.keys(s).sort().join();
    if (keys !== 'engine_version,label,official,payload,payload_sha256,rules_fingerprint,schema,schema_version,seed,seq,t_sim,world_id') refuse('BAD_SNAPSHOT', `unexpected fields ${keys}`);
    if (s.schema !== SNAPSHOT_SCHEMA) refuse('SCHEMA_MISMATCH', `schema ${String(s.schema)} is not ${SNAPSHOT_SCHEMA}`);
    if (s.schema_version === 1) refuse('SCHEMA_MISMATCH', `schema_version 1 snapshots carry no event-chain commitment and cannot be continued by this runtime (schema_version ${P0A2_SCHEMA_VERSION}); there is no migration path; the saved data is not changed and can still be exported`);
    if (s.schema_version !== P0A2_SCHEMA_VERSION) refuse('SCHEMA_MISMATCH', `schema_version ${String(s.schema_version)} is not ${P0A2_SCHEMA_VERSION}`);
    if (s.label !== LABEL_ZH || s.official !== false) refuse('NOT_EXPERIMENT', 'a snapshot must be labelled non-official (official:false)');
    if (s.engine_version !== P0A2_ENGINE_VERSION) refuse('ENGINE_MISMATCH', `engine_version ${String(s.engine_version)} is not ${P0A2_ENGINE_VERSION}`);
    let h: string;
    try { h = hashJson(s.payload); } catch (e) { return refuse('HASH_MISMATCH', `payload is not canonical JSON data (${(e as Error).message})`); }
    if (h !== s.payload_sha256) refuse('HASH_MISMATCH', 'payload_sha256 does not match the payload');
    const p = s.payload;
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== 'chain,code_sha256,engine_version,params_sha256,rules_fingerprint,save_meta,scenario,schema_version,seed,seq,state,t_sim,variant,world_id,world_kind') refuse('BAD_SNAPSHOT', 'payload fields');
    for (const k of ['world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq'] as const) if (p[k] !== s[k]) refuse('HEADER_MISMATCH', `${k} of the header and the payload differ`);
    if (p.world_kind !== P0A2_WORLD_KIND) refuse('BAD_SNAPSHOT', 'world_kind');
    if (s.rules_fingerprint !== P0A2_RULES_FINGERPRINT || p.params_sha256 !== P0A2_PARAMS_SHA || p.code_sha256 !== P0A2_CODE_SHA256 || p.scenario !== P0A2_SCENARIO || p.variant !== VARIANT) refuse('FINGERPRINT_MISMATCH', 'the snapshot was made under other rules, parameters or code than this runtime');
    if (!WORLD_ID_RE.test(p.world_id)) refuse('BAD_WORLD_ID', 'world_id');
    let w: World;
    try { w = World.restore(RAW, canon(p.state), { captureLog: true }); } catch (e) { return refuse('BAD_STATE', (e as Error).message); }
    if (w.seed !== s.seed || w.t_now / 1000 !== s.t_sim || w.logCount !== s.seq) refuse('BAD_STATE', 'seed, time or log position of the state disagree with the header');
    if (!w.conservation().ok) refuse('LEDGER_MISMATCH', 'food conservation or individual counts do not hold');
    const st = p.state as { workers?: Record<string, { pending: string | null }>; queue?: { id: string; a: string; t: number }[]; t_now?: number };
    const live = new Set((st.queue ?? []).map((e) => e.id));
    for (const [id, x] of Object.entries(st.workers ?? {})) if (!x.pending || !live.has(x.pending)) refuse('BAD_STATE', `${id}: its pending event is not in the queue`);
    if ((st.queue ?? []).some((e) => !(e.t > (st.t_now as number)))) refuse('BAD_STATE', 'a queued event is not after the world time');
    if (w.snapshot() !== canon(p.state)) refuse('BAD_STATE', 'state does not survive a restore round trip');
    // payload schema 2: save metadata and event-chain commitment (the head itself is checked only by recomputation)
    if (Array.isArray((p.save_meta as { lineage?: unknown } | null)?.lineage) && p.save_meta.lineage.length > 0) refuse('FORK_UNSUPPORTED', 'the snapshot records a fork; this runtime implements no fork (docs/save-format-v2.md §6)');
    if (canonicalJson(p.save_meta as never) !== canonicalJson(p0a2SaveMetaOf(p.world_id, p.seed) as never)) refuse('META_MISMATCH', 'save_meta does not match the world id, seed, parameters, scenario and variant (initial conditions / versions)');
    const cp = chainShapeProblem(p.chain);
    if (cp) refuse('CHAIN_MISMATCH', cp);
    if (p.chain.genesis !== chainStart({ world_kind: P0A2_SAVE_WORLD_KIND, world_id: p.world_id, seed: p.seed, rules_fingerprint: p.rules_fingerprint }).genesis) refuse('CHAIN_MISMATCH', 'chain genesis does not belong to this world, seed and rules');
    if (p.chain.count !== p.seq) refuse('CHAIN_MISMATCH', `chain count ${p.chain.count} != seq ${p.seq}`);
    return new P0a2ExperimentWorld(p.world_id, w, p.chain);
  }

  /** read-only copy of one worker's full record (follow): own physiology, traits, route memory, experienced contacts */
  antView(id: string): unknown { const v = this.world.view().workers[id]; return v ? { ...v, kind: 'p0a2_worker' } : null; }

  frame(): J {
    const w = this.world, m = w.m, t = w.t_now, v = w.view(), env = w.env;
    const day = dayOf(t), minute = (t - day * MS_PER_DAY) / 60_000, L = env.lightTimes(day);
    const workers = Object.keys(v.workers).sort().map((id) => {
      const x = v.workers[id];
      const span = TRAVEL.has(x.state) ? m.travel_ms : TRANSIT.has(x.state) ? m.move_ms : null;
      return { id, state: x.state, loc: x.loc, since_s: x.since / 1000, until_s: span === null ? null : (x.since + span) / 1000, crop_fill: x.crop / m.crop_cap, route: x.route };
    });
    const larvae = Object.keys(v.larvae).sort().map((id) => ({ id, gut_fill: v.larvae[id].gut / m.gut_cap }));
    const src = v.sources[SOURCE_ID];
    return {
      world_kind: P0A2_WORLD_KIND, status_zh: P0A2_STATUS_ZH, label: LABEL_ZH, official: false, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: P0A2_ENGINE_VERSION,
      t_sim: this.tSim(), seq: this.seqNo(), log: { count: w.logCount, hash: w.logHash },
      model: { scenario: P0A2_SCENARIO, variant: m.variant, variant_label: m.variant_label, variant_status: m.variant_status, day0_date: m.anchor.day0_date },
      layout: { source_id: SOURCE_ID, source_distance_cm: SOURCE_DISTANCE_CM, travel_s: m.travel_ms / 1000, move_s: m.move_ms / 1000 },
      workers, larvae, source: { id: SOURCE_ID, stock_portions: src.stock / 1_000_000 },
      env: { date: dateOfDay(m.anchor, day), light: env.light(t), temperature_c: env.airTemp(t), site_temperature_c: env.siteTemp(t), rh_percent: env.rh(t), synthetic: true,
        sun_altitude_deg: solarAltitude(m.site, m.anchor, dateOfDay(m.anchor, day), minute), before_solar_noon: minute < L.solar_noon },
    };
  }
}
