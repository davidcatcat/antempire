/**
 * P0-A2 colony-members CANDIDATE world (docs/colony-candidate-world.md; Owner #202, #219, #222): the P0-A2 24-hour
 * individual-behaviour world PLUS the colony members it does not have — queens, major workers, eggs and pupae — as
 * ENGINE individuals. 候選／實驗，預設關閉: a world of this kind exists only when `init` names kind 'p0a2-colony'
 * (save world kind `p0a2-colony-v1`); the default P0-A2 world (p0a2-world.ts, `p0a2-24h-v1`) is not changed by this file
 * and does not import it. Non-official like every Worker world (LABEL_ZH, official:false; Owner #201).
 *
 * Composition, not a second implementation: this world HOLDS one unchanged P0a2ExperimentWorld (the 30 minor workers
 * and 8 larvae of the prototype, with every rule, parameter and random stream of the default kind) and one colony roster
 * (engine/colony/roster.ts). The two never interact in this version — no rule moves food, information or individuals
 * between them — so the minors' and larvae's events are exactly those of the default world for the same seed (checked
 * event by event in tests/p0a2-colony-world.test.ts).
 *
 * What the roster individuals do: NOTHING that is not evidenced and implemented. Queens, majors, eggs and pupae are
 * created by events at t = 0 and stay `in_nest`. Oviposition, feeding, metabolism, caste-specific behaviour, development
 * and death are 尚未模擬 (CQ-1 candidate ports null) and labelled per individual in the frame and in save_meta.
 *
 * Initial conditions: the candidate scenario scenarios/day0-budding-candidate.json (BUD-CAND-2, Owner #202 provisional
 * specification, NOT the #201 GO) through its own sampler rules (engine/day0/founding-sampler.ts: one named SHA-256
 * stream per field of the world seed). Which sampled values are applied and which are only recorded is fixed in
 * colonyCompositionOf below and in p0a2-colony-params.json (every item labelled assumption:true).
 *
 * Events and seq: the roster events come first (seq 0 … K-1, all at t = 0), then the base world's events with
 * seq = K + their base seq. Each event carries this kind's own rules fingerprint and engine version and advances this
 * kind's own event chain (chain.ts), so the Node verifier (cli/verify-save.ts, world-kinds.ts) recomputes a save of this
 * kind with this same module.
 */
import rawParams from './p0a2-colony-params.json' with { type: 'json' };
import { LABEL_ZH, P0A2_PARAMS_SHA, P0A2_RULES_FINGERPRINT, P0A2_SCHEMA_VERSION, P0a2ExperimentWorld, P0a2Refused, SNAPSHOT_SCHEMA, p0a2SaveMetaOf, type P0a2Event, type P0a2SaveMeta, type P0a2Snapshot } from './p0a2-world.ts';
import { COLONY_SCENARIO } from './p0a2-colony-scenario.ts';
import { P0A2_COLONY_CODE_FILES, P0A2_COLONY_CODE_SHA256 } from './p0a2-colony-code-hash.ts';
import { canonicalJson, hashJson } from './sha256.ts';
import { chainNext, chainShapeProblem, chainStart, type ChainState } from './chain.ts';
import { DAY0_PRNG_ID, drawValue, unitDraw } from '../../../engine/day0/founding-sampler.ts';
import { INDIVIDUAL_NOT_SIMULATED, buildRoster, restoreRoster, rosterAudit, rosterCounts, rosterIndividuals, rosterParams, rosterSnapshot, type RosterIndividual, type RosterState } from '../../../engine/colony/roster.ts';
import type { MemberEvent } from '../../../engine/colony/members.ts';
import type { ExactTime } from '../../../engine/scheduler/world-events.ts';
import type { NotSimulatedList } from './not-simulated.ts';

type J = { [k: string]: unknown };

/** bump on any change of what this adapter emits or stores (the code hash also changes with every module it runs) */
export const P0A2_COLONY_ENGINE_VERSION = 'experiment-p0a2-colony/1';
/** every engine version of this world kind starts with this (the Worker routes a snapshot of any version here) */
export const P0A2_COLONY_ENGINE_FAMILY = 'experiment-p0a2-colony/';
export const P0A2_COLONY_ENGINE_HISTORY: Readonly<Record<string, string>> = Object.freeze({
  'experiment-p0a2-colony/1': '蟻群成員候選世界第一版：P0-A2 世界＋蟻后、大工蟻、卵、蛹的引擎個體（全程在巢內；生理、行為、發育與死亡尚未模擬）',
});
export const P0A2_COLONY_SCHEMA_VERSION = P0A2_SCHEMA_VERSION;
/** the runtime / protocol world kind (init command, payload.world_kind, frame.colony.world_kind) */
export const P0A2_COLONY_WORLD_KIND = 'p0a2-colony';
/** the save-format world kind (payload.save_meta.world_kind; the Node verifier's registry id, world-kinds.ts) */
export const P0A2_COLONY_SAVE_WORLD_KIND = 'p0a2-colony-v1';
export const P0A2_COLONY_STATUS_ZH = '候選／實驗世界，非正式｜蟻群成員候選（預設關閉）：蟻后、大工蟻、卵、蛹是引擎個體，其生理、行為、發育與死亡尚未模擬';

const refuse = (code: string, msg: string): never => { throw new P0a2Refused(code, msg); };
const PARAMS: J = rawParams as J;
const ROSTER_P = rosterParams(PARAMS.roster);
type Spec = { distribution: string; value?: number; min?: number; max?: number } | null;
/** the generated scenario extract (p0a2-colony-scenario.ts); a field the scenario does not have is null */
export interface ColonyScenarioExtract { file: string; id: string; schema: string; status: string; activated: boolean; checksum: string; checksum_algorithm: string; prng: { id: string; stream_namespace: string }; order: readonly string[]; brood_level: string; major_fraction_isolated: boolean; fields: Record<string, Spec> }
const SC = COLONY_SCENARIO as unknown as ColonyScenarioExtract;
if (SC.prng.id !== DAY0_PRNG_ID) throw Error(`p0a2-colony: scenario PRNG ${SC.prng.id} is not the sampler's ${DAY0_PRNG_ID}`);
if ((PARAMS.scenario as J).id !== SC.id || (PARAMS.scenario as J).file !== SC.file) throw Error('p0a2-colony: the parameter file names another scenario than the generated extract');

/** this kind's parameters: the base world's parameter file, this candidate's parameter file and the WHOLE scenario file */
export const P0A2_COLONY_PARAMS_SHA = hashJson({ base_params_sha256: P0A2_PARAMS_SHA, colony_params_sha256: hashJson(PARAMS), scenario_checksum: SC.checksum });
export const P0A2_COLONY_RULES_FINGERPRINT = hashJson({ engine_version: P0A2_COLONY_ENGINE_VERSION, schema_version: P0A2_COLONY_SCHEMA_VERSION, world_kind: P0A2_COLONY_WORLD_KIND, base_rules_fingerprint: P0A2_RULES_FINGERPRINT, params_sha256: P0A2_COLONY_PARAMS_SHA, code_sha256: P0A2_COLONY_CODE_SHA256, code_files: [...P0A2_COLONY_CODE_FILES], scenario_id: SC.id, scenario_checksum: SC.checksum });

/** one field of a scenario at this seed: its own named stream, drawn once (the sampler's own rule); null = the
 *  scenario has no such field */
const draw = (sc: ColonyScenarioExtract, seed: number, field: string): number | null => { const f = sc.fields[field]; return f ? drawValue(f, unitDraw(seed, sc.prng.stream_namespace, field)) : null; };

export interface ColonyComposition {
  /** the scenario's sampled values for this seed (equal to founding-sampler's sampleInitialConditions(...).draws) */
  draws: Record<string, number | null>;
  /** what this world actually contains */
  applied: { queens: number; minor_workers: number; major_workers: number; eggs: number; larvae: number; pupae: number };
  /** sampled values that are recorded but NOT applied, with what is used instead and why */
  not_applied: { field: string; scenario_value: number | null; used: number | null; reason_zh: string }[];
}
/**
 * The composition of the candidate world for a seed, given the P0-A2 prototype group it extends (its minor workers and
 * larvae: initial conditions of the base world, read once at creation — not a quantity any individual reads).
 *  - queens: the scenario's sampled count;
 *  - majors: round(f × minors ÷ (1 − f)) with the scenario's isolated fraction candidate f and the ACTUAL minors of the
 *    base world (the scenario's own formula); no fraction field in the scenario → 0 majors;
 *  - eggs / pupae: round(ratio × actual minors) at the scenario's default brood level; a missing ratio → 0;
 *  - minors and larvae: the base world's own (the scenario's sampled minor count and larva ratio are recorded only).
 */
export const colonyCompositionOf = (seed: number, baseMinors: number, baseLarvae: number): ColonyComposition => compositionFrom(SC, seed, baseMinors, baseLarvae);
/** colonyCompositionOf for a given scenario extract (the runtime always uses its own generated extract) */
export function compositionFrom(sc: ColonyScenarioExtract, seed: number, baseMinors: number, baseLarvae: number): ColonyComposition {
  if (!Number.isSafeInteger(baseMinors) || baseMinors < 0 || !Number.isSafeInteger(baseLarvae) || baseLarvae < 0) throw Error('p0a2-colony: the base group must be non-negative integers');
  const draws: Record<string, number | null> = {};
  for (const k of sc.order) if (k in sc.fields) draws[k] = draw(sc, seed, k);
  const f = draws.major_fraction ?? null;
  if (f !== null && !(f >= 0 && f < 1)) throw Error('p0a2-colony: major_fraction must be in [0, 1)');
  const per = (k: string) => (draws[k] === null || draws[k] === undefined ? 0 : Math.round((draws[k] as number) * baseMinors));
  const queens = draws.queens ?? null;
  if (queens === null || !Number.isSafeInteger(queens) || queens < 0) throw Error('p0a2-colony: the scenario gives no queen count');
  const applied = { queens, minor_workers: baseMinors, major_workers: f === null ? 0 : Math.round((f * baseMinors) / (1 - f)), eggs: per('eggs_per_minor'), larvae: baseLarvae, pupae: per('pupae_per_minor') };
  const not_applied = [
    { field: 'minor_workers', scenario_value: draws.minor_workers ?? null, used: baseMinors, reason_zh: '小工蟻沿用 P0-A2 原型世界的實驗群；改變小工蟻數會改變 P0-A2 核心世界的行為，須另開規則更新' },
    { field: 'larvae_per_minor', scenario_value: (draws.larvae_per_minor ?? null) === null ? null : per('larvae_per_minor'), used: baseLarvae, reason_zh: '幼蟲沿用 P0-A2 原型世界的幼蟲（與工蟻的育幼／交哺有交互作用）；scenario_value 是情境比例乘上實際小工蟻數的幼蟲數' },
    { field: 'carried_brood_progress', scenario_value: draws.carried_brood_progress ?? null, used: null, reason_zh: '隨行幼體的階段進度未套用到個體（stage_progress = null）：本版沒有發育模型' },
  ];
  return { draws, applied, not_applied };
}

/** the candidate's 「尚未模擬／簡化代理」 list: the base world's list (generated from docs/r2-acceptance-matrix.json) with
 *  the wording of the rows this candidate touches replaced. NO status changes: an individual that exists but whose
 *  physiology, behaviour and development are not simulated is still 未接入. */
const NOT_SIMULATED_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  M09: '初始蟻群（本種多后群體的分巢遷入單位，#202）：尚未模擬完整；本候選世界只依候選情境抽出蟻后數與大工蟻比例候選，並帶入中等幼體負載的卵與蛹（全部是遊戲假設）；小工蟻與幼蟲仍是 P0-A2 原型實驗群的 30 隻與 8 隻，不是情境的 50～500 隻',
  M15: '蟻后營養與產卵：尚未模擬；蟻后是引擎個體（全程在巢內，有自己的帳本），但不進食、不代謝、不產卵、不死亡；世界中的卵是初始情境帶入的，不是產下的',
  M16: '幼體發育（卵—幼蟲—蛹—成蟻）：尚未模擬；卵與蛹是引擎個體但不發育、不孵化、不羽化；幼蟲只被餵食與代謝，不發育、不化蛹',
  M18: '大工蟻（小工蟻／大工蟻階級）：尚未模擬其工作、能量與行為；大工蟻是引擎個體，全程留在巢內（標示的遊戲假設 major_behaviour = in_nest_only），不覓食、不交哺、不育幼；大工蟻比例是隔離的候選值，不是實測',
});
export function colonyNotSimulatedOf(list: NotSimulatedList): NotSimulatedList {
  for (const row of Object.keys(NOT_SIMULATED_OVERRIDES)) if (!list.items.some((x) => x.row === row)) throw Error(`p0a2-colony: the base list has no row ${row}`);
  return {
    format: list.format, source: `${list.source} + prototypes/continuous-world/worker/p0a2-colony-world.ts (candidate wording of ${Object.keys(NOT_SIMULATED_OVERRIDES).join(', ')})`,
    note_zh: `${list.note_zh}｜蟻群成員候選世界：蟻后、大工蟻、卵、蛹以引擎個體存在，但它們的生理、行為、發育與死亡都尚未模擬`,
    items: list.items.map((x) => ({ row: x.row, status: x.status, label_zh: NOT_SIMULATED_OVERRIDES[x.row] ?? x.label_zh })),
  };
}

export interface P0a2ColonySaveMeta extends Omit<P0a2SaveMeta, 'world_kind' | 'initial'> {
  world_kind: typeof P0A2_COLONY_SAVE_WORLD_KIND;
  initial: { world_id: string; seed: number; t_sim: 0; params_sha256: string; base_params_sha256: string; scenario: string; variant: string; how: string };
  /** the candidate's own initial conditions: scenario identity and checksum, PRNG, the seed's draws, what was applied */
  colony: {
    candidate: true; default_off: true; status_zh: string;
    scenario: { file: string; id: string; schema: string; status: string; activated: boolean; checksum: string; checksum_algorithm: string; brood_level: string };
    prng: { id: string; stream_namespace: string; stream_key: string; seed: number };
    composition: ColonyComposition;
    assumptions: J; major_behaviour: string;
    /** SHA-256 of the roster's canonical initial state (what a verifier rebuilds from seed + rules) */
    roster_sha256: string;
  };
}

export interface P0a2ColonyPayload {
  world_kind: typeof P0A2_COLONY_WORLD_KIND; world_id: string; seed: number; engine_version: string; schema_version: number; rules_fingerprint: string;
  params_sha256: string; code_sha256: string; t_sim: number; seq: number;
  /** the complete snapshot of the unchanged base P0-A2 world (its own envelope, hash, state, chain) */
  base: P0a2Snapshot;
  /** the colony roster (engine/colony/roster.ts state) */
  colony: J;
  save_meta: P0a2ColonySaveMeta; chain: ChainState;
}
export interface P0a2ColonySnapshot {
  schema: string; label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  t_sim: number; seq: number; payload: P0a2ColonyPayload; payload_sha256: string;
}

const ZERO_EXACT = { day: 0, us: 0, us_lo: 0 };
/** memo of a pure function of the seed (the base world's initial group); bounded */
const BASE_GROUPS = new Map<number, { minors: number; larvae: number }>();

export class P0a2ColonyWorld {
  readonly worldId: string; readonly seed: number; readonly fingerprint = P0A2_COLONY_RULES_FINGERPRINT;
  /** the unchanged base P0-A2 world */
  readonly base: P0a2ExperimentWorld;
  private readonly roster: RosterState;
  /** number of roster events (they precede every base event: seq = rosterEvents + base seq) */
  private readonly rosterEvents: number;
  private readonly meta: P0a2ColonySaveMeta;
  private chain: ChainState;
  private constructor(base: P0a2ExperimentWorld, roster: RosterState, chain: ChainState) {
    this.worldId = base.worldId; this.seed = base.seed; this.base = base; this.roster = roster; this.rosterEvents = roster.log.count; this.chain = { ...chain };
    this.meta = P0a2ColonyWorld.saveMetaOf(base.worldId, base.seed);
  }

  /** minor workers and larvae of the base world for a seed (its initial conditions; the same for every seed today, read
   *  from a fresh base world so that no number is repeated here) */
  private static baseGroup(seed: number): { minors: number; larvae: number } {
    const have = BASE_GROUPS.get(seed); if (have) return have;
    const v = P0a2ExperimentWorld.create('exp-colony-base-probe', seed).world.world.view();
    const g = { minors: Object.keys(v.workers).length, larvae: Object.keys(v.larvae).length };
    if (BASE_GROUPS.size >= 64) BASE_GROUPS.clear();
    BASE_GROUPS.set(seed, g);
    return g;
  }
  /** the trusted initial roster of a seed (state + creating events): depends only on the seed and this build's rules */
  static initialRoster(seed: number): { state: RosterState; events: MemberEvent[]; composition: ColonyComposition } {
    const g = P0a2ColonyWorld.baseGroup(seed), composition = colonyCompositionOf(seed, g.minors, g.larvae);
    const r = buildRoster(seed, ROSTER_P, { queens: composition.applied.queens, majors: composition.applied.major_workers, eggs: composition.applied.eggs, pupae: composition.applied.pupae }, 0);
    return { ...r, composition };
  }
  static saveMetaOf(worldId: string, seed: number): P0a2ColonySaveMeta {
    const b = p0a2SaveMetaOf(worldId, seed), r = P0a2ColonyWorld.initialRoster(seed);
    return {
      format: b.format, world_kind: P0A2_COLONY_SAVE_WORLD_KIND,
      initial: { world_id: worldId, seed, t_sim: 0, params_sha256: P0A2_COLONY_PARAMS_SHA, base_params_sha256: b.initial.params_sha256, scenario: b.initial.scenario, variant: b.initial.variant, how: 'P0a2ColonyWorld.create(world_id, seed): the unchanged P0-A2 world of this seed plus the colony roster sampled from the candidate scenario with the same seed (this runtime\'s own parameter files and scenario extract)' },
      species: b.species, environment: b.environment, lineage: [],
      not_simulated: colonyNotSimulatedOf(b.not_simulated),
      colony: {
        candidate: true, default_off: true, status_zh: P0A2_COLONY_STATUS_ZH,
        scenario: { file: SC.file, id: SC.id, schema: SC.schema, status: SC.status, activated: SC.activated, checksum: SC.checksum, checksum_algorithm: SC.checksum_algorithm, brood_level: SC.brood_level },
        prng: { id: SC.prng.id, stream_namespace: SC.prng.stream_namespace, stream_key: '${seed}|${stream_namespace}|${field}', seed },
        composition: r.composition,
        assumptions: JSON.parse(JSON.stringify(PARAMS.parameters)) as J, major_behaviour: ROSTER_P.major_behaviour,
        roster_sha256: hashJson(JSON.parse(rosterSnapshot(r.state))),
      },
    };
  }

  private stamp(seq: number, e: { event_id: string; kind: string; t_sim: number; exact: { day: number; us: number; us_lo: number }; round: number; entity: string | null; data: J }): P0a2Event {
    return { seq, event_id: e.event_id, kind: e.kind, t_sim: e.t_sim, exact: e.exact, round: e.round, entity: e.entity, data: e.data, rng: null, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: P0A2_COLONY_ENGINE_VERSION, schema_version: P0A2_COLONY_SCHEMA_VERSION, official: false, label: LABEL_ZH };
  }
  /** append events to this kind's chain (their seq must continue the chain) */
  private commit(events: P0a2Event[]): P0a2Event[] {
    let head = this.chain.head, n = this.chain.count;
    for (const ev of events) { if (ev.seq !== n) refuse('INTERNAL', 'event seq and event chain disagree'); head = chainNext(head, ev); n++; }
    this.chain = { algo: this.chain.algo, genesis: this.chain.genesis, head, count: n };
    return events;
  }
  /** base events as events of this kind: same content, seq shifted behind the roster events, this kind's versions */
  private rebase(events: P0a2Event[]): P0a2Event[] { return this.commit(events.map((e) => this.stamp(this.rosterEvents + e.seq, e))); }

  static create(worldId: string, seed: number): { world: P0a2ColonyWorld; events: P0a2Event[] } {
    const b = P0a2ExperimentWorld.create(worldId, seed);
    const r = P0a2ColonyWorld.initialRoster(seed);
    const x = new P0a2ColonyWorld(b.world, r.state, chainStart({ world_kind: P0A2_COLONY_SAVE_WORLD_KIND, world_id: worldId, seed, rules_fingerprint: P0A2_COLONY_RULES_FINGERPRINT }));
    const own = x.commit(r.events.map((e, i) => x.stamp(i, { event_id: `colony:${e.id}`, kind: e.k, t_sim: e.t / 1000, exact: ZERO_EXACT, round: 0, entity: e.a, data: { ...e.p, scenario_id: SC.id, assumption: true, initial_reserve_known: false, not_simulated: true } })));
    return { world: x, events: [...own, ...x.rebase(b.events)] };
  }

  tSim(): number { return this.base.tSim(); }
  seqNo(): number { return this.rosterEvents + this.base.seqNo(); }
  nowExact(): ExactTime { return this.base.nowExact(); }
  chainState(): ChainState { return { ...this.chain }; }
  /** individuals that can be followed: the base world's workers, then the roster individuals */
  antIds(): string[] { const r = rosterIndividuals(this.roster); return [...this.base.antIds(), ...[...r.queens, ...r.majors, ...r.eggs, ...r.pupae].map((x) => x.id)]; }

  advanceTo(t: number, maxEvents = Infinity): { events: P0a2Event[]; done: boolean } { const r = this.base.advanceTo(t, maxEvents); return { events: this.rebase(r.events), done: r.done }; }
  advanceToExact(end: ExactTime, maxEvents = Infinity): { events: P0a2Event[]; done: boolean } { const r = this.base.advanceToExact(end, maxEvents); return { events: this.rebase(r.events), done: r.done }; }

  /** accounting of both parts (STATISTICS ONLY): the base world's food conservation and the roster's ledgers / records */
  conservation(): { ok: boolean; base: ReturnType<P0a2ExperimentWorld['world']['conservation']>; roster: ReturnType<typeof rosterAudit> } {
    const food = this.base.world.conservation(), roster = rosterAudit(this.roster);
    return { ok: food.ok && roster.ok, base: food, roster };
  }

  payload(): P0a2ColonyPayload {
    return { world_kind: P0A2_COLONY_WORLD_KIND, world_id: this.worldId, seed: this.seed, engine_version: P0A2_COLONY_ENGINE_VERSION, schema_version: P0A2_COLONY_SCHEMA_VERSION, rules_fingerprint: this.fingerprint, params_sha256: P0A2_COLONY_PARAMS_SHA, code_sha256: P0A2_COLONY_CODE_SHA256, t_sim: this.tSim(), seq: this.seqNo(), base: this.base.snapshot(), colony: JSON.parse(rosterSnapshot(this.roster)) as J, save_meta: JSON.parse(JSON.stringify(this.meta)) as P0a2ColonySaveMeta, chain: this.chainState() };
  }
  /** a snapshot at the current consistent boundary; a pure read */
  snapshot(): P0a2ColonySnapshot {
    const payload = this.payload();
    return { schema: SNAPSHOT_SCHEMA, label: LABEL_ZH, official: false, world_id: this.worldId, seed: this.seed, rules_fingerprint: this.fingerprint, engine_version: P0A2_COLONY_ENGINE_VERSION, schema_version: P0A2_COLONY_SCHEMA_VERSION, t_sim: payload.t_sim, seq: payload.seq, payload, payload_sha256: hashJson(payload) };
  }

  /** a NEW world from a snapshot; refuses (throws P0a2Refused) on any mismatch, never repairs or re-initialises */
  static restore(s: P0a2ColonySnapshot): P0a2ColonyWorld {
    if (!s || typeof s !== 'object') refuse('BAD_SNAPSHOT', 'not an object');
    const keys = Object.keys(s).sort().join();
    if (keys !== 'engine_version,label,official,payload,payload_sha256,rules_fingerprint,schema,schema_version,seed,seq,t_sim,world_id') refuse('BAD_SNAPSHOT', `unexpected fields ${keys}`);
    if (s.schema !== SNAPSHOT_SCHEMA) refuse('SCHEMA_MISMATCH', `schema ${String(s.schema)} is not ${SNAPSHOT_SCHEMA}`);
    if (s.schema_version !== P0A2_COLONY_SCHEMA_VERSION) refuse('SCHEMA_MISMATCH', `schema_version ${String(s.schema_version)} is not ${P0A2_COLONY_SCHEMA_VERSION}`);
    if (s.label !== LABEL_ZH || s.official !== false) refuse('NOT_EXPERIMENT', 'a snapshot must be labelled non-official (official:false)');
    if (s.engine_version !== P0A2_COLONY_ENGINE_VERSION) refuse('ENGINE_MISMATCH', `engine_version ${String(s.engine_version)} is not ${P0A2_COLONY_ENGINE_VERSION}${typeof s.engine_version === 'string' && s.engine_version in P0A2_COLONY_ENGINE_HISTORY ? ` (an older colony-candidate rules version: ${P0A2_COLONY_ENGINE_HISTORY[s.engine_version]}; it cannot be continued or re-hashed under the current rules; the saved data is not changed and can still be exported)` : ''}`);
    let h: string;
    try { h = hashJson(s.payload); } catch (e) { return refuse('HASH_MISMATCH', `payload is not canonical JSON data (${(e as Error).message})`); }
    if (h !== s.payload_sha256) refuse('HASH_MISMATCH', 'payload_sha256 does not match the payload');
    const p = s.payload;
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== 'base,chain,code_sha256,colony,engine_version,params_sha256,rules_fingerprint,save_meta,schema_version,seed,seq,t_sim,world_id,world_kind') refuse('BAD_SNAPSHOT', 'payload fields');
    for (const k of ['world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq'] as const) if (p[k] !== s[k]) refuse('HEADER_MISMATCH', `${k} of the header and the payload differ`);
    if (p.world_kind !== P0A2_COLONY_WORLD_KIND) refuse('BAD_SNAPSHOT', 'world_kind');
    if (s.rules_fingerprint !== P0A2_COLONY_RULES_FINGERPRINT || p.params_sha256 !== P0A2_COLONY_PARAMS_SHA || p.code_sha256 !== P0A2_COLONY_CODE_SHA256) refuse('FINGERPRINT_MISMATCH', 'the snapshot was made under other rules, parameters, scenario or code than this runtime');
    // the base world: every check of the default kind's own restore (state, queue, ledger, its chain shape, its save_meta)
    const base = P0a2ExperimentWorld.restore(p.base);
    if (base.worldId !== p.world_id || base.seed !== p.seed || base.tSim() !== p.t_sim) refuse('BASE_MISMATCH', 'the base world of the snapshot is not this world at this time (world id, seed or time differ)');
    // the roster: structurally valid, reconciled, and — this version has no roster dynamics — exactly the trusted initial
    // roster of the seed (anything else was not produced by these rules)
    let roster: RosterState;
    try { roster = restoreRoster(canonicalJson(p.colony)); } catch (e) { return refuse('BAD_COLONY', (e as Error).message); }
    const init = P0a2ColonyWorld.initialRoster(p.seed);
    if (rosterSnapshot(roster) !== rosterSnapshot(init.state)) refuse('COLONY_MISMATCH', 'the colony roster is not the roster these rules create for this seed (individuals, ledgers or records were altered)');
    if (roster.log.count + base.seqNo() !== p.seq) refuse('BAD_STATE', 'seq is not the roster events plus the base world\'s events');
    if (!base.world.conservation().ok || !rosterAudit(roster).ok) refuse('LEDGER_MISMATCH', 'food conservation, ledgers or individual counts do not hold');
    if (Array.isArray((p.save_meta as { lineage?: unknown } | null)?.lineage) && p.save_meta.lineage.length > 0) refuse('FORK_UNSUPPORTED', 'the snapshot records a fork; this runtime implements no fork (docs/save-format-v2.md §6)');
    if (canonicalJson(p.save_meta) !== canonicalJson(P0a2ColonyWorld.saveMetaOf(p.world_id, p.seed))) refuse('META_MISMATCH', 'save_meta does not match the world id, seed, parameters and scenario (initial conditions / versions)');
    const cp = chainShapeProblem(p.chain);
    if (cp) refuse('CHAIN_MISMATCH', cp);
    if (p.chain.genesis !== chainStart({ world_kind: P0A2_COLONY_SAVE_WORLD_KIND, world_id: p.world_id, seed: p.seed, rules_fingerprint: p.rules_fingerprint }).genesis) refuse('CHAIN_MISMATCH', 'chain genesis does not belong to this world, seed and rules');
    if (p.chain.count !== p.seq) refuse('CHAIN_MISMATCH', `chain count ${p.chain.count} != seq ${p.seq}`);
    return new P0a2ColonyWorld(base, roster, p.chain);
  }

  /** read-only copy of one individual's record (follow): a base worker as the base world reports it, or a roster
   *  individual with its 「尚未模擬」 field keys */
  antView(id: string): unknown {
    const b = this.base.antView(id);
    if (b) return { ...(b as J), caste: 'minor', caste_source: 'p0a2_prototype' };
    const r = rosterIndividuals(this.roster), x = [...r.queens, ...r.majors, ...r.eggs, ...r.pupae].find((i) => i.id === id);
    return x ? { ...individualMsg(x), kind: 'p0a2_colony_member', member_kind: x.kind, physiology_at_s: this.tSim() } : null;
  }

  /** the viewer's state frame: the base world's frame (same fields; every worker marked caste 'minor') plus `colony`,
   *  the roster individuals as engine individuals with their per-field 「尚未模擬」 keys. Observation only. */
  frame(): J {
    const f = this.base.frame(), r = rosterIndividuals(this.roster), c = rosterCounts(this.roster);
    const workers = (f.workers as J[]).map((w) => ({ ...w, caste: 'minor' }));
    return {
      ...f, status_zh: P0A2_COLONY_STATUS_ZH, rules_fingerprint: this.fingerprint, engine_version: P0A2_COLONY_ENGINE_VERSION, seq: this.seqNo(), workers,
      colony: {
        world_kind: P0A2_COLONY_WORLD_KIND, save_world_kind: P0A2_COLONY_SAVE_WORLD_KIND, candidate: true, status_zh: P0A2_COLONY_STATUS_ZH,
        scenario: { id: SC.id, checksum: SC.checksum, brood_level: SC.brood_level, status: SC.status },
        assumptions: { major_behaviour: ROSTER_P.major_behaviour, major_fraction: this.meta.colony.composition.draws.major_fraction ?? null, major_fraction_isolated: SC.major_fraction_isolated, all_counts_are_assumptions: true },
        counts: { queens: c.queens, minor_workers: workers.length, major_workers: c.majors, eggs: c.eggs, larvae: (f.larvae as unknown[]).length, pupae: c.pupae },
        queens: r.queens.map(individualMsg), majors: r.majors.map(individualMsg), eggs: r.eggs.map(individualMsg), pupae: r.pupae.map(individualMsg),
        not_simulated_fields: { ...INDIVIDUAL_NOT_SIMULATED },
      },
    };
  }
}

/** a roster individual in protocol units (seconds) */
function individualMsg(x: RosterIndividual): J {
  return { id: x.id, kind: x.kind, caste: x.caste, caste_source: x.caste_source, stage: x.stage, state: x.state, loc: x.loc, since_s: x.since / 1000, until_s: null, alive: x.alive, origin: x.origin, mother_queen_id: x.mother_queen_id, caste_fate: x.caste_fate, stage_progress: x.stage_progress, crop_fill: x.crop_fill, initial_reserve: x.initial_reserve, eggs_laid: x.eggs_laid, last_oviposition_s: x.last_oviposition === null ? null : x.last_oviposition / 1000, ledger: x.ledger, not_simulated: x.not_simulated };
}
