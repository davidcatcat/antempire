/**
 * CQ-1 — colony members: queens (multi-queen), workers (minor / major castes), brood provenance.
 * docs/colony-members-cq1.md. Owner 2026-11-13 (#219, #222): data structures, individual events, own death records,
 * per-member metabolism interface, brood mother / caste-fate fields, save and viewer shape — numbers stay null / isolated.
 *
 * ISOLATED MODULE: NOT wired into the P0-A2 world, the experiment Worker or the official engine. Nothing official
 * imports it (tests/colony-members.test.ts checks this). It is a pure, deterministic library: no platform API, no wall
 * clock, no hidden randomness; Math only through IEEE-exact members (worker-boundary deterministic_math rule).
 *
 * Rules held here (CLAUDE.md):
 *  §2.1b  a queen lays only from HER OWN view (her own ledger, her own time since her last laying); a brood item's caste
 *         fate is decided only from ITS OWN view. No colony total, count or ratio is passed to any candidate.
 *  §3     every rate / cost / threshold is an injected candidate port; the default is null = 「尚未模擬」. This module
 *         contains NO biological number.
 *  §4     castes are enabled by the parameter object (`worker_castes`), never by a species name.
 *  multi-queen: each queen has her own id, own event counter, own random stream rng(hash32(seed|queenId|ovi|n)), own
 *         ledger and own hash chain — adding / removing / killing another queen cannot change them.
 *  no brood from nothing: every egg is created only by an `oviposition` event of a LIVING queen and its provisioning is
 *         moved out of that queen's ledger (exact integer conservation); an egg with zero cost is refused.
 *
 * Units (provisional, binding to the MEC-0 mass / energy contract is a follow-up — docs/colony-members-cq1.md §5):
 * time = integer ms of experiment time; sugar / protein = integer µg; energy = integer µJ. All amounts are safe integers.
 */
import { hash32, rng, type Rng } from '../rng.ts';
import { sha256Hex } from '../sha256.ts';

export const MEMBERS_SCHEMA = 'antempire.colony-members.v1';
export const MEMBER_PARAMS_SCHEMA = 'antempire.colony-members.params.v1';

// ------------------------------------------------------------------ amounts
/** integer mass / energy amount (provisional names; MEC-0 binding is a follow-up) */
export interface Amount { sugar_ug: number; protein_ug: number; energy_uj: number }
export const AMOUNT_KEYS = ['sugar_ug', 'protein_ug', 'energy_uj'] as const;
export const zero = (): Amount => ({ sugar_ug: 0, protein_ug: 0, energy_uj: 0 });
const isAmount = (a: unknown): a is Amount => typeof a === 'object' && a !== null && AMOUNT_KEYS.every((k) => Number.isSafeInteger((a as Record<string, unknown>)[k]) && ((a as Record<string, number>)[k]) >= 0);
function needAmount(a: unknown, what: string): Amount {
  if (!isAmount(a)) throw Error(`CQ1: ${what} must be non-negative safe integers {sugar_ug, protein_ug, energy_uj}`);
  return { sugar_ug: a.sugar_ug, protein_ug: a.protein_ug, energy_uj: a.energy_uj };
}
const add = (a: Amount, b: Amount): Amount => ({ sugar_ug: a.sugar_ug + b.sugar_ug, protein_ug: a.protein_ug + b.protein_ug, energy_uj: a.energy_uj + b.energy_uj });
const sub = (a: Amount, b: Amount): Amount => ({ sugar_ug: a.sugar_ug - b.sugar_ug, protein_ug: a.protein_ug - b.protein_ug, energy_uj: a.energy_uj - b.energy_uj });
const minA = (a: Amount, b: Amount): Amount => ({ sugar_ug: Math.min(a.sugar_ug, b.sugar_ug), protein_ug: Math.min(a.protein_ug, b.protein_ug), energy_uj: Math.min(a.energy_uj, b.energy_uj) });
const isZero = (a: Amount) => a.sugar_ug === 0 && a.protein_ug === 0 && a.energy_uj === 0;

/** one member's own ledger: what it holds now and its own cumulative flows (all from its own events) */
export interface Ledger {
  have: Amount;
  /** set once when the member enters the scenario (Day0 initial state) or the egg is laid (moved from the mother) */
  initial: Amount;
  /** credited by food_received events (a local transfer with a source event id) */
  received: Amount;
  /** debited by metabolism_booked events */
  metabolised: Amount;
  /** metabolic demand not met because the ledger was empty (diagnostic, not food) */
  deficit: Amount;
  /** moved out into eggs (queens only) */
  to_eggs: Amount;
}
const newLedger = (initial: Amount): Ledger => ({ have: { ...initial }, initial: { ...initial }, received: zero(), metabolised: zero(), deficit: zero(), to_eggs: zero() });

// ------------------------------------------------------------------ members
export type WorkerCaste = 'minor' | 'major';
export const WORKER_CASTES: readonly WorkerCaste[] = ['minor', 'major'];
/** brood caste fate: 'undetermined' until a caste-differentiation candidate fires (reproductive fates: 尚未模擬) */
export type CasteFate = 'undetermined' | WorkerCaste;
/** how a worker's caste is known: given by the scenario's initial state, developed in the model from a brood item whose
 *  fate was decided, the species has a single worker caste (params), or the fate was never decided (caste null) */
export type CasteSource = 'initial_scenario' | 'developed_in_model' | 'single_caste_params' | 'fate_not_modelled';
export type MemberKind = 'queen' | 'worker' | 'brood';
/** metabolism port key per member type (a worker of unknown caste has its own key — it is NOT treated as a minor) */
export type MetabolicType = 'queen' | 'worker_minor' | 'worker_major' | 'worker_unknown';
export const METABOLIC_TYPES: readonly MetabolicType[] = ['queen', 'worker_minor', 'worker_major', 'worker_unknown'];

interface MemberBase {
  id: string; alive: boolean;
  /** instant the member entered the world (scenario start, laying or eclosion) */
  added_t: number;
  /** last instant metabolism was booked up to (null = never booked) */
  metab_t: number | null;
  /** last instant of any own event (own events are monotonic in time) */
  last_t: number;
  ledger: Ledger;
  /** own event counter and own hash chain (independent of every other member) */
  n: number; chain: string;
}
export interface Queen extends MemberBase {
  kind: 'queen';
  origin: 'initial_scenario';
  /** own egg counter (egg ids are `${queenId}.egg${k}`) */
  eggs_laid: number;
  last_oviposition_t: number | null;
}
export interface Worker extends MemberBase {
  kind: 'worker';
  caste: WorkerCaste | null; caste_source: CasteSource;
  /** mother queen id (null = initial scenario worker of unknown mother) */
  mother_queen_id: string | null;
}
/** brood item: only the provenance / fate record. Development stages, larval feeding and brood physiology belong to the
 *  P0-A2 larvae log / BP-1 and are 尚未模擬 here. */
export interface Brood extends MemberBase {
  kind: 'brood';
  mother_queen_id: string;
  laid_event_id: string;
  caste_fate: CasteFate;
  /** the event that set the fate (null while undetermined) and the candidate id that produced it */
  caste_fate_event_id: string | null; caste_fate_candidate: string | null;
}
export type Member = Queen | Worker | Brood;

export interface DeathRecord { id: string; kind: MemberKind; t: number; cause: string; event_id: string; ledger_at_death: Amount }

export interface MemberEvent { id: string; t: number; k: string; a: string; p: { [k: string]: unknown } }

export interface MembersState {
  schema: typeof MEMBERS_SCHEMA; official: false; seed: number;
  queens: Record<string, Queen>; workers: Record<string, Worker>; brood: Record<string, Brood>;
  deaths: DeathRecord[];
  /** global log: count and hash chain over events in application order (the members' own chains are order-free) */
  log: { count: number; hash: string };
}

// ------------------------------------------------------------------ parameters (from a parameter file; no species names)
export interface MemberParams {
  schema: typeof MEMBER_PARAMS_SCHEMA;
  /** which worker castes exist in this species: a monomorphic species sets major.enabled = false */
  worker_castes: { minor: { enabled: boolean }; major: { enabled: boolean } };
}
export function memberParams(raw: unknown): MemberParams {
  const r = raw as { schema?: unknown; worker_castes?: { minor?: { enabled?: unknown }; major?: { enabled?: unknown } } };
  if (!r || r.schema !== MEMBER_PARAMS_SCHEMA) throw Error(`CQ1: params schema must be ${MEMBER_PARAMS_SCHEMA}`);
  const mi = r.worker_castes?.minor?.enabled, ma = r.worker_castes?.major?.enabled;
  if (typeof mi !== 'boolean' || typeof ma !== 'boolean') throw Error('CQ1: worker_castes.minor/major.enabled must be booleans');
  if (!mi && !ma) throw Error('CQ1: at least one worker caste must be enabled');
  return { schema: MEMBER_PARAMS_SCHEMA, worker_castes: { minor: { enabled: mi }, major: { enabled: ma } } };
}
export const enabledCastes = (P: MemberParams): WorkerCaste[] => WORKER_CASTES.filter((c) => P.worker_castes[c].enabled);

// ------------------------------------------------------------------ own views (the ONLY inputs of candidates)
/** what a queen knows of HERSELF: her own reserve and flows, her own age and time since her own last laying */
export interface QueenOwnView { have: Amount; received: Amount; deficit: Amount; age_ms: number; since_last_oviposition_ms: number | null }
/** what a brood item has of ITSELF: its own reserve (provisioning + what it was fed) and its own age */
export interface BroodOwnView { have: Amount; received: Amount; age_ms: number }
/** what a member's own metabolism sees: its type and the interval being booked (no state of anyone else) */
export interface MetabolismView { type: MetabolicType; from_t: number; to_t: number }

export function queenOwnView(q: Queen, t: number): QueenOwnView {
  return { have: { ...q.ledger.have }, received: { ...q.ledger.received }, deficit: { ...q.ledger.deficit }, age_ms: t - q.added_t, since_last_oviposition_ms: q.last_oviposition_t === null ? null : t - q.last_oviposition_t };
}
export function broodOwnView(b: Brood, t: number): BroodOwnView {
  return { have: { ...b.ledger.have }, received: { ...b.ledger.received }, age_ms: t - b.added_t };
}

// ------------------------------------------------------------------ candidate ports (default null = 尚未模擬)
export type EvidenceClass = 'literature_this_species' | 'literature_other_species' | 'general_physiology' | 'game_assumption' | 'test_only';
interface PortMeta { id: string; assumption: true; evidence: EvidenceClass }
/** eggs a queen requests in one oviposition event, from her own view and her own stream (non-negative integer) */
export interface OvipositionPort extends PortMeta { eggs(view: QueenOwnView, u: Rng): number }
/** provisioning moved from the queen into one egg (must be > 0 in at least one component: no free eggs) */
export interface EggCostPort extends PortMeta { cost(view: QueenOwnView): Amount }
/** caste fate of a brood item from its own view and its own stream; null = not decided at this call */
export interface CasteFatePort extends PortMeta { fate(view: BroodOwnView, u: Rng): WorkerCaste | null }
/** metabolic demand of one member over [from_t, to_t]. MUST be additive: D(a,c) = D(a,b) + D(b,c) for a <= b <= c, so
 *  booking is invariant under event splitting (the port carries any rounding in absolute time, not per call) */
export interface MetabolismPort extends PortMeta { demand(view: MetabolismView): Amount }
export interface Ports {
  oviposition: OvipositionPort | null;
  egg_cost: EggCostPort | null;
  caste_fate: CasteFatePort | null;
  metabolism: Record<MetabolicType, MetabolismPort | null>;
}
/** the reference: every candidate OFF (no eggs, no fate, no metabolism booked) — everything 尚未模擬 */
export const NULL_PORTS: Ports = Object.freeze({ oviposition: null, egg_cost: null, caste_fate: null, metabolism: Object.freeze({ queen: null, worker_minor: null, worker_major: null, worker_unknown: null }) }) as Ports;

/** 尚未模擬 items for save metadata / viewer labels (CLAUDE.md §1 minimum-credible version) */
export const NOT_SIMULATED: readonly { key: string; zh: string }[] = [
  { key: 'oviposition_rate', zh: '產卵速率與營養→產卵關係（尚未模擬；候選預設關閉）' },
  { key: 'egg_cost', zh: '每粒卵的糖／蛋白／能量成本（尚未模擬；null）' },
  { key: 'caste_differentiation', zh: '大小工蟻階級分化門檻（尚未模擬；null）' },
  { key: 'metabolism_rates', zh: '蟻后、小工蟻、大工蟻的代謝數值（尚未模擬；接口已建立）' },
  { key: 'brood_development', zh: '卵→幼蟲→蛹→成蟲發育（由 P0-A2 幼體紀錄／BP-1 負責；本模組尚未接入）' },
  { key: 'death_hazard', zh: '蟻后與工蟻的死亡風險機制（尚未模擬；本模組只記錄死亡事件）' },
  { key: 'reproductive_castes', zh: '新蟻后／雄蟻生產、婚飛、收養與分巢（尚未模擬）' },
  { key: 'major_behaviour', zh: '大工蟻的任務閾值、招募、搬運與防衛行為（尚未模擬）' },
];

// ------------------------------------------------------------------ canonical JSON
export function canon(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw Error('CQ1: non-finite number in canonical JSON'); return JSON.stringify(v + 0); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  throw Error(`CQ1: ${typeof v} is not JSON data`);
}

// ------------------------------------------------------------------ state and events
const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
export function newMembers(seed: number): MembersState {
  if (!Number.isSafeInteger(seed)) throw Error('CQ1: seed must be a safe integer');
  return { schema: MEMBERS_SCHEMA, official: false, seed, queens: {}, workers: {}, brood: {}, deaths: [], log: { count: 0, hash: '' } };
}
const exists = (s: MembersState, id: string) => id in s.queens || id in s.workers || id in s.brood;
export function member(s: MembersState, id: string): Member | null { return s.queens[id] ?? s.workers[id] ?? s.brood[id] ?? null; }
function needTime(t: number) { if (!Number.isSafeInteger(t) || t < 0) throw Error(`CQ1: time ${t} must be a non-negative integer ms`); }

/** append one event of member m: member chain + global chain */
function emit(s: MembersState, m: MemberBase, t: number, k: string, p: { [k: string]: unknown }): MemberEvent {
  if (t < m.last_t) throw Error(`CQ1: ${m.id} event at ${t} before its last event ${m.last_t}`);
  const e: MemberEvent = { id: `${m.id}#${m.n}`, t, k, a: m.id, p };
  const c = canon(e);
  m.n++; m.last_t = t; m.chain = sha256Hex(`${m.chain}\n${c}`);
  s.log.count++; s.log.hash = sha256Hex(`${s.log.hash}\n${c}`);
  return e;
}
const base = (id: string, t: number, initial: Amount): MemberBase => ({ id, alive: true, added_t: t, metab_t: null, last_t: t, ledger: newLedger(initial), n: 0, chain: '' });

/** a queen of the scenario's initial state (Day0). Her initial reserve is a scenario input (its values are assumptions of
 *  the scenario, not of this module). */
export function addQueen(s: MembersState, id: string, t: number, initial: Amount): MemberEvent {
  needTime(t); if (!ID_RE.test(id) || exists(s, id)) throw Error(`CQ1: bad or duplicate member id ${id}`);
  const q: Queen = { ...base(id, t, needAmount(initial, 'initial')), kind: 'queen', origin: 'initial_scenario', eggs_laid: 0, last_oviposition_t: null };
  s.queens[id] = q;
  return emit(s, q, t, 'queen_added', { origin: q.origin, initial: q.ledger.initial });
}
/** a worker of the scenario's initial state; caste null = morphology unknown (never re-labelled as major later) */
export function addWorker(s: MembersState, P: MemberParams, id: string, t: number, caste: WorkerCaste | null, initial: Amount): MemberEvent {
  needTime(t); if (!ID_RE.test(id) || exists(s, id)) throw Error(`CQ1: bad or duplicate member id ${id}`);
  if (caste !== null && !P.worker_castes[caste].enabled) throw Error(`CQ1: caste ${caste} is not enabled in the parameter file`);
  const w: Worker = { ...base(id, t, needAmount(initial, 'initial')), kind: 'worker', caste, caste_source: 'initial_scenario', mother_queen_id: null };
  s.workers[id] = w;
  return emit(s, w, t, 'worker_added', { caste, caste_source: w.caste_source, initial: w.ledger.initial });
}

/** food actually moved INTO member `id` by a local transfer event elsewhere (e.g. trophallaxis); `source_event` names it */
export function receiveFood(s: MembersState, id: string, t: number, amount: Amount, source_event: string): MemberEvent {
  needTime(t); const m = member(s, id); if (!m) throw Error(`CQ1: unknown member ${id}`);
  if (!m.alive) throw Error(`CQ1: dead member ${id} cannot receive food`);
  if (typeof source_event !== 'string' || source_event.length === 0) throw Error('CQ1: food must name its source event');
  const a = needAmount(amount, 'amount');
  m.ledger.have = add(m.ledger.have, a); m.ledger.received = add(m.ledger.received, a);
  return emit(s, m, t, 'food_received', { amount: a, source_event });
}

export const metabolicType = (m: Member): MetabolicType | null => m.kind === 'queen' ? 'queen' : m.kind === 'worker' ? (m.caste === 'minor' ? 'worker_minor' : m.caste === 'major' ? 'worker_major' : 'worker_unknown') : null;

/** book member `id`'s own metabolism up to t through the port for its type; null port = not booked (尚未模擬).
 *  Brood metabolism belongs to the brood-physiology work (BP-1) and is not booked here. */
export function bookMetabolism(s: MembersState, ports: Ports, id: string, t: number): MemberEvent | null {
  needTime(t); const m = member(s, id); if (!m) throw Error(`CQ1: unknown member ${id}`);
  const type = metabolicType(m); if (type === null || !m.alive) return null;
  const port = ports.metabolism[type]; if (port === null) return null;
  const from = m.metab_t ?? m.added_t; if (t < from) throw Error(`CQ1: metabolism of ${id} booked backwards`);
  if (t === from) return null;
  const demand = needAmount(port.demand({ type, from_t: from, to_t: t }), `metabolism ${port.id}`);
  const paid = minA(m.ledger.have, demand), short = sub(demand, paid);
  m.ledger.have = sub(m.ledger.have, paid); m.ledger.metabolised = add(m.ledger.metabolised, paid); m.ledger.deficit = add(m.ledger.deficit, short);
  m.metab_t = t;
  return emit(s, m, t, 'metabolism_booked', { candidate: port.id, from_t: from, demand, paid, deficit: short });
}

/** one oviposition opportunity of queen `qid` at t (scheduled by the integrating world). Returns null and creates
 *  nothing when the queen is dead or the oviposition candidate is OFF. Eggs are limited by HER OWN reserve: each egg's
 *  provisioning is moved from her ledger into the egg's ledger. */
export function oviposit(s: MembersState, ports: Ports, qid: string, t: number): MemberEvent | null {
  needTime(t); const q = s.queens[qid]; if (!q) throw Error(`CQ1: unknown queen ${qid}`);
  if (!q.alive || ports.oviposition === null) return null;
  if (ports.egg_cost === null) throw Error('CQ1: an oviposition candidate needs an egg-cost candidate (no brood from nothing)');
  const u = rng(hash32(`${s.seed}|${qid}|ovi|${q.n}`));
  const view = queenOwnView(q, t);
  const req = ports.oviposition.eggs(view, u);
  if (!Number.isSafeInteger(req) || req < 0) throw Error(`CQ1: oviposition ${ports.oviposition.id} returned ${req}`);
  const cost = needAmount(ports.egg_cost.cost(queenOwnView(q, t)), `egg cost ${ports.egg_cost.id}`);
  if (isZero(cost)) throw Error('CQ1: an egg must cost something (no brood from nothing)');
  let afford = req;
  for (const k of AMOUNT_KEYS) if (cost[k] > 0) afford = Math.min(afford, Math.floor(q.ledger.have[k] / cost[k]));
  const eggs = Array.from({ length: afford }, (_, i) => `${qid}.egg${q.eggs_laid + i}`);
  for (const id of eggs) if (exists(s, id)) throw Error(`CQ1: egg id ${id} already exists`);
  const e = emit(s, q, t, 'oviposition', { candidate: ports.oviposition.id, cost_candidate: ports.egg_cost.id, requested: req, laid: afford, limited_by_own_reserve: afford < req, cost_each: cost, eggs });
  for (const id of eggs) {
    q.eggs_laid++;
    q.ledger.have = sub(q.ledger.have, cost); q.ledger.to_eggs = add(q.ledger.to_eggs, cost);
    const b: Brood = { ...base(id, t, cost), kind: 'brood', mother_queen_id: qid, laid_event_id: e.id, caste_fate: 'undetermined', caste_fate_event_id: null, caste_fate_candidate: null };
    s.brood[id] = b;
    emit(s, b, t, 'egg_laid', { mother_queen_id: qid, laid_event_id: e.id, provisioning: cost });
  }
  if (afford > 0) q.last_oviposition_t = t;
  return e;
}

/** a caste-fate opportunity of brood item `bid` (scheduled by the integrating world at its own sensitive window).
 *  Null candidate / already decided / dead → nothing. A fate for a caste the parameter file disables is an error. */
export function decideCasteFate(s: MembersState, P: MemberParams, ports: Ports, bid: string, t: number): MemberEvent | null {
  needTime(t); const b = s.brood[bid]; if (!b) throw Error(`CQ1: unknown brood ${bid}`);
  if (!b.alive || b.caste_fate !== 'undetermined' || ports.caste_fate === null) return null;
  const u = rng(hash32(`${s.seed}|${bid}|caste|${b.n}`));
  const f = ports.caste_fate.fate(broodOwnView(b, t), u);
  if (f === null) return null;
  if (!WORKER_CASTES.includes(f) || !P.worker_castes[f].enabled) throw Error(`CQ1: caste fate ${String(f)} is not enabled in the parameter file`);
  const e = emit(s, b, t, 'caste_fate_set', { fate: f, candidate: ports.caste_fate.id });
  b.caste_fate = f; b.caste_fate_event_id = e.id; b.caste_fate_candidate = ports.caste_fate.id;
  return e;
}

/** brood item `bid` becomes an adult worker (called when the brood-development model — not this module — says so).
 *  The worker keeps the id, the mother queen id and the ledger. */
export function eclose(s: MembersState, P: MemberParams, bid: string, t: number): MemberEvent {
  needTime(t); const b = s.brood[bid]; if (!b) throw Error(`CQ1: unknown brood ${bid}`);
  if (!b.alive) throw Error(`CQ1: dead brood ${bid} cannot eclose`);
  const castes = enabledCastes(P);
  let caste: WorkerCaste | null, src: CasteSource;
  if (b.caste_fate !== 'undetermined') { caste = b.caste_fate; src = 'developed_in_model'; }
  else if (castes.length === 1) { caste = castes[0]; src = 'single_caste_params'; }
  else { caste = null; src = 'fate_not_modelled'; }
  const e = emit(s, b, t, 'eclosion', { caste, caste_source: src, mother_queen_id: b.mother_queen_id });
  const w: Worker = { id: b.id, alive: true, added_t: t, metab_t: b.metab_t === null ? null : t, last_t: t, ledger: b.ledger, n: b.n, chain: b.chain, kind: 'worker', caste, caste_source: src, mother_queen_id: b.mother_queen_id };
  delete s.brood[bid]; s.workers[w.id] = w;
  return e;
}

/** record the death of member `id`. The CAUSE comes from a death model outside this module (hazards are 尚未模擬);
 *  the body's ledger stays recorded in the death record (no mass disappears). */
export function recordDeath(s: MembersState, id: string, t: number, cause: string): MemberEvent {
  needTime(t); const m = member(s, id); if (!m) throw Error(`CQ1: unknown member ${id}`);
  if (!m.alive) throw Error(`CQ1: ${id} is already dead`);
  if (typeof cause !== 'string' || cause.length === 0) throw Error('CQ1: a death needs a cause');
  const e = emit(s, m, t, 'death', { cause, ledger_at_death: m.ledger.have });
  m.alive = false;
  s.deaths.push({ id, kind: m.kind, t, cause, event_id: e.id, ledger_at_death: { ...m.ledger.have } });
  return e;
}

// ------------------------------------------------------------------ audit (STATISTICS ONLY — never an input of any member)
/** exact integer reconciliation: initial + received = have + metabolised (eggs move mass between members) */
export function audit(s: MembersState): { inflow: Amount; held: Amount; metabolised: Amount; balanced: boolean } {
  let inflow = zero(), held = zero(), met = zero(), toEggs = zero(), eggInit = zero();
  for (const m of [...Object.values(s.queens), ...Object.values(s.workers), ...Object.values(s.brood)] as Member[]) {
    inflow = add(inflow, m.ledger.received); held = add(held, m.ledger.have); met = add(met, m.ledger.metabolised);
    const fromMother = (m.kind === 'brood') || (m.kind === 'worker' && m.mother_queen_id !== null);
    if (fromMother) eggInit = add(eggInit, m.ledger.initial); else inflow = add(inflow, m.ledger.initial);
    toEggs = add(toEggs, m.ledger.to_eggs);
  }
  const balanced = canon(add(held, met)) === canon(inflow) && canon(toEggs) === canon(eggInit);
  return { inflow, held, metabolised: met, balanced };
}

// ------------------------------------------------------------------ save / restore
export function snapshot(s: MembersState): string { return canon(s); }
export function restore(text: string): MembersState {
  const s = JSON.parse(text) as MembersState;
  if (s.schema !== MEMBERS_SCHEMA || s.official !== false) throw Error('CQ1: not a non-official colony-members snapshot');
  for (const [k, m] of Object.entries({ ...s.queens, ...s.workers, ...s.brood })) {
    if (m.id !== k) throw Error(`CQ1: snapshot member key ${k} != id`);
    for (const f of ['have', 'initial', 'received', 'metabolised', 'deficit', 'to_eggs'] as const) needAmount(m.ledger[f], `${k}.${f}`);
  }
  for (const b of Object.values(s.brood)) if (!(b.mother_queen_id in s.queens)) throw Error(`CQ1: brood ${b.id} names an unknown mother`);
  if (snapshot(s) !== text) throw Error('CQ1: snapshot is not canonical');
  return s;
}

// ------------------------------------------------------------------ viewer data shape (data only; no rendering here)
export interface ViewerMember { id: string; kind: MemberKind; alive: boolean; caste: WorkerCaste | null; caste_source: CasteSource | null; caste_fate: CasteFate | null; queen_id: string | null; mother_queen_id: string | null }
export interface ViewerData {
  schema: 'antempire.colony-members.viewer.v1'; label_zh: string;
  members: ViewerMember[];
  candidates: { oviposition: string | null; egg_cost: string | null; caste_fate: string | null; metabolism: Record<MetabolicType, string | null> };
  not_simulated: { key: string; zh: string }[];
}
export function viewerData(s: MembersState, ports: Ports): ViewerData {
  const rows: ViewerMember[] = [];
  for (const q of Object.values(s.queens)) rows.push({ id: q.id, kind: 'queen', alive: q.alive, caste: null, caste_source: null, caste_fate: null, queen_id: q.id, mother_queen_id: null });
  for (const w of Object.values(s.workers)) rows.push({ id: w.id, kind: 'worker', alive: w.alive, caste: w.caste, caste_source: w.caste_source, caste_fate: null, queen_id: null, mother_queen_id: w.mother_queen_id });
  for (const b of Object.values(s.brood)) rows.push({ id: b.id, kind: 'brood', alive: b.alive, caste: null, caste_source: null, caste_fate: b.caste_fate, queen_id: null, mother_queen_id: b.mother_queen_id });
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const metabolism = Object.fromEntries(METABOLIC_TYPES.map((k) => [k, ports.metabolism[k]?.id ?? null])) as Record<MetabolicType, string | null>;
  return {
    schema: 'antempire.colony-members.viewer.v1', label_zh: '非正式實驗世界／研究候選（CQ-1，尚未接入世界）', members: rows,
    candidates: { oviposition: ports.oviposition?.id ?? null, egg_cost: ports.egg_cost?.id ?? null, caste_fate: ports.caste_fate?.id ?? null, metabolism },
    not_simulated: NOT_SIMULATED.map((x) => ({ ...x })),
  };
}
