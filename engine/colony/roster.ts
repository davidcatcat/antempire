/**
 * Colony roster of the P0-A2 colony-members CANDIDATE world (docs/colony-candidate-world.md; Owner #202, #219, #222).
 * 候選／實驗，預設關閉 — it is used only by the opt-in world kind `p0a2-colony-v1`
 * (prototypes/continuous-world/worker/p0a2-colony-world.ts); the default P0-A2 world does not import it.
 *
 * What it is: the initial-scenario individuals that the P0-A2 core does not have — queens and major workers (CQ-1
 * members: own id, own event counter, own hash chain, own ledger slot; ./members.ts) and inert brood items (eggs,
 * pupae) — as ENGINE STATE with an engine state field (`in_nest`), created by events at the scenario start.
 *
 * What it is NOT (CLAUDE.md §3: nothing invented; everything below is 尚未模擬 and labelled per individual):
 *  - no physiology: every CQ-1 candidate port is null (ROSTER_PORTS = NULL_PORTS) → no oviposition, no metabolism, no
 *    caste fate; no food reaches a roster individual; nobody dies. The ledgers start at 0, which records only that
 *    nothing was credited — the real initial body reserve is UNKNOWN (reported as null, never as a measured 0);
 *  - no behaviour: a major is `in_nest` for the whole run (`major_behaviour: 'in_nest_only'`, a labelled assumption
 *    switch). The other declared value `as_minor` (majors follow the minor decision rules) is NOT implemented and is
 *    refused: no caste-specific rule and no evidence that majors decide like minors is cited in this repository;
 *  - no development: an egg stays an egg and a pupa stays a pupa (BP-1 is not wired here); stage progress, mother queen
 *    and caste fate of the carried brood are unknown (null / 'undetermined').
 *
 * §2.1 / §2.1b: there is no decision here at all, so nothing can read a colony total. The counts are INPUTS of the
 * builder (initial conditions of the scenario), not something an individual reads. Each record depends only on its own
 * id and on the instant it was added: adding or removing any other individual changes none of its bytes.
 * §4: castes come from the parameter object (`worker_castes`), never from a species name.
 * Pure and deterministic: no platform API, no wall clock, no random draw (the roster draws nothing at all).
 */
import { NULL_PORTS, addQueen, addWorker, audit, canon, memberParams, newMembers, restore as restoreMembers, snapshot as membersSnapshot, zero, type MemberEvent, type MemberParams, type MembersState, type Ports } from './members.ts';
import { sha256Hex } from '../sha256.ts';

export const ROSTER_SCHEMA = 'antempire.colony-roster.v1';
export const ROSTER_PARAMS_SCHEMA = 'antempire.colony-roster.params.v1';
/** every physiology candidate OFF: the roster of this version never lays, metabolises or decides a caste fate */
export const ROSTER_PORTS: Ports = NULL_PORTS;

export type MajorBehaviour = 'in_nest_only' | 'as_minor';
export const MAJOR_BEHAVIOURS: readonly MajorBehaviour[] = ['in_nest_only', 'as_minor'];
/** the values of `major_behaviour` this version can run (the other one is declared and refused) */
export const IMPLEMENTED_MAJOR_BEHAVIOURS: readonly MajorBehaviour[] = ['in_nest_only'];
export type BroodStage = 'egg' | 'pupa';
export const BROOD_STAGES: readonly BroodStage[] = ['egg', 'pupa'];

export interface RosterParams {
  schema: typeof ROSTER_PARAMS_SCHEMA;
  members: MemberParams;
  major_behaviour: MajorBehaviour;
  /** id labels (pure labels, no biological meaning): `${prefix}${number padded to width}` */
  ids: { queen: string; major: string; egg: string; pupa: string; width: number };
}
const PREFIX_RE = /^[A-Za-z]{1,8}$/;
export function rosterParams(raw: unknown): RosterParams {
  const r = raw as { schema?: unknown; members?: unknown; major_behaviour?: { value?: unknown }; ids?: Record<string, unknown> };
  if (!r || r.schema !== ROSTER_PARAMS_SCHEMA) throw Error(`ROSTER: params schema must be ${ROSTER_PARAMS_SCHEMA}`);
  const mb = r.major_behaviour?.value;
  if (!MAJOR_BEHAVIOURS.includes(mb as MajorBehaviour)) throw Error(`ROSTER: major_behaviour must be one of ${MAJOR_BEHAVIOURS.join(', ')}`);
  if (!IMPLEMENTED_MAJOR_BEHAVIOURS.includes(mb as MajorBehaviour)) throw Error(`ROSTER: major_behaviour ${String(mb)} is declared but NOT implemented (caste-specific behaviour is not simulated; only ${IMPLEMENTED_MAJOR_BEHAVIOURS.join(', ')} can run)`);
  const ids = r.ids ?? {}, names = ['queen', 'major', 'egg', 'pupa'] as const;
  for (const k of names) if (typeof ids[k] !== 'string' || !PREFIX_RE.test(ids[k] as string)) throw Error(`ROSTER: ids.${k} must match ${PREFIX_RE}`);
  if (new Set(names.map((k) => ids[k])).size !== names.length) throw Error('ROSTER: id prefixes must differ');
  if (!Number.isSafeInteger(ids.width) || (ids.width as number) < 1 || (ids.width as number) > 6) throw Error('ROSTER: ids.width must be an integer 1..6');
  return { schema: ROSTER_PARAMS_SCHEMA, members: memberParams(r.members), major_behaviour: mb as MajorBehaviour, ids: { queen: ids.queen as string, major: ids.major as string, egg: ids.egg as string, pupa: ids.pupa as string, width: ids.width as number } };
}

/** how many individuals of each kind the scenario brings (INPUTS: initial conditions, decided outside this module) */
export interface RosterCounts { queens: number; majors: number; eggs: number; pupae: number }

/** an inert, accounted brood item of the initial scenario. Not a CQ-1 `Brood` (that one exists only through an
 *  oviposition event of a living queen): the mother and the laying event of carried brood are unknown → null. */
export interface BroodItem {
  id: string; kind: 'brood_item'; stage: BroodStage; alive: true;
  added_t: number; origin: 'initial_scenario';
  mother_queen_id: null; laid_event_id: null; caste_fate: 'undetermined';
  /** progress inside the stage: not applied in this version (the scenario's sampled value is only recorded in the save metadata) */
  stage_progress: null;
  /** own event counter and own hash chain (independent of every other individual) */
  n: number; chain: string;
}
/** engine state of a roster individual: in the nest since `since` (ms). The model has no in-nest coordinates. */
export interface Placement { state: 'in_nest'; loc: 'nest'; since: number }

export interface RosterState {
  schema: typeof ROSTER_SCHEMA; official: false; seed: number;
  major_behaviour: MajorBehaviour;
  /** queens and major workers (CQ-1 members with their own ledgers and chains) */
  members: MembersState;
  items: Record<string, BroodItem>;
  placement: Record<string, Placement>;
  /** roster log: count and hash chain over every roster event in creation order */
  log: { count: number; hash: string };
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');
const needCount = (n: number, what: string) => { if (!Number.isSafeInteger(n) || n < 0) throw Error(`ROSTER: ${what} must be a non-negative integer`); };
/** ids of the roster individuals a count vector creates (deterministic labels) */
export function rosterIds(P: RosterParams, c: RosterCounts): { queens: string[]; majors: string[]; eggs: string[]; pupae: string[] } {
  const mk = (prefix: string, n: number) => { if (String(n).length > P.ids.width) throw Error(`ROSTER: ${n} individuals do not fit the id width ${P.ids.width}`); return Array.from({ length: n }, (_, i) => `${prefix}${pad(i + 1, P.ids.width)}`); };
  return { queens: mk(P.ids.queen, c.queens), majors: mk(P.ids.major, c.majors), eggs: mk(P.ids.egg, c.eggs), pupae: mk(P.ids.pupa, c.pupae) };
}

/**
 * The roster at instant t (ms) and the events that created it, in the fixed order queens, majors, eggs, pupae.
 * Draws nothing. A major needs the major caste enabled in the parameter object (otherwise refused, never re-labelled).
 */
export function buildRoster(seed: number, P: RosterParams, counts: RosterCounts, t: number): { state: RosterState; events: MemberEvent[] } {
  for (const k of ['queens', 'majors', 'eggs', 'pupae'] as const) needCount(counts[k], k);
  if (!Number.isSafeInteger(t) || t < 0) throw Error('ROSTER: time must be a non-negative integer ms');
  const ids = rosterIds(P, counts), members = newMembers(seed), events: MemberEvent[] = [];
  const s: RosterState = { schema: ROSTER_SCHEMA, official: false, seed, major_behaviour: P.major_behaviour, members, items: {}, placement: {}, log: { count: 0, hash: '' } };
  const log = (e: MemberEvent) => { events.push(e); s.log.count++; s.log.hash = sha256Hex(`${s.log.hash}\n${canon(e)}`); };
  const place = (id: string) => { s.placement[id] = { state: 'in_nest', loc: 'nest', since: t }; };
  for (const id of ids.queens) { log(addQueen(members, id, t, zero())); place(id); }
  for (const id of ids.majors) { log(addWorker(members, P.members, id, t, 'major', zero())); place(id); }
  const item = (id: string, stage: BroodStage) => {
    if (id in s.items || id in members.queens || id in members.workers) throw Error(`ROSTER: duplicate id ${id}`);
    const e: MemberEvent = { id: `${id}#0`, t, k: 'brood_item_added', a: id, p: { stage, origin: 'initial_scenario', mother_queen_id: null, laid_event_id: null, caste_fate: 'undetermined', stage_progress: null } };
    s.items[id] = { id, kind: 'brood_item', stage, alive: true, added_t: t, origin: 'initial_scenario', mother_queen_id: null, laid_event_id: null, caste_fate: 'undetermined', stage_progress: null, n: 1, chain: sha256Hex(`\n${canon(e)}`) };
    log(e); place(id);
  };
  for (const id of ids.eggs) item(id, 'egg');
  for (const id of ids.pupae) item(id, 'pupa');
  return { state: s, events };
}

/** counts of the roster as it is (STATISTICS ONLY — never an input of any individual) */
export function rosterCounts(s: RosterState): RosterCounts {
  const items = Object.values(s.items);
  return { queens: Object.keys(s.members.queens).length, majors: Object.values(s.members.workers).filter((w) => w.caste === 'major').length, eggs: items.filter((x) => x.stage === 'egg').length, pupae: items.filter((x) => x.stage === 'pupa').length };
}
/** accounting check (STATISTICS ONLY): CQ-1 ledgers reconcile exactly, every individual has exactly one placement, no
 *  brood was created by a queen (no oviposition in this version) and nobody died */
export function rosterAudit(s: RosterState): { ok: boolean; ledgers_balanced: boolean; placed: boolean; no_laid_brood: boolean; no_deaths: boolean; counts: RosterCounts } {
  const ids = [...Object.keys(s.members.queens), ...Object.keys(s.members.workers), ...Object.keys(s.items)].sort();
  const placed = canon(ids) === canon(Object.keys(s.placement).sort()) && new Set(ids).size === ids.length;
  const ledgers_balanced = audit(s.members).balanced, no_laid_brood = Object.keys(s.members.brood).length === 0 && Object.values(s.members.queens).every((q) => q.eggs_laid === 0);
  const no_deaths = s.members.deaths.length === 0;
  return { ok: placed && ledgers_balanced && no_laid_brood && no_deaths, ledgers_balanced, placed, no_laid_brood, no_deaths, counts: rosterCounts(s) };
}

export const rosterSnapshot = (s: RosterState): string => canon(s);
/** a roster from its canonical snapshot; refuses anything malformed, never repairs */
export function restoreRoster(text: string): RosterState {
  const s = JSON.parse(text) as RosterState;
  if (!s || s.schema !== ROSTER_SCHEMA || s.official !== false) throw Error('ROSTER: not a non-official colony-roster snapshot');
  if (!IMPLEMENTED_MAJOR_BEHAVIOURS.includes(s.major_behaviour)) throw Error('ROSTER: major_behaviour of the snapshot is not implemented');
  if (typeof s.members !== 'object' || s.members === null || typeof s.items !== 'object' || s.items === null || typeof s.placement !== 'object' || s.placement === null) throw Error('ROSTER: snapshot fields');
  restoreMembers(membersSnapshot(s.members));
  if (s.members.seed !== s.seed) throw Error('ROSTER: seed of the members differs');
  for (const [k, x] of Object.entries(s.items)) {
    if (x.id !== k || x.kind !== 'brood_item' || !BROOD_STAGES.includes(x.stage) || x.alive !== true || x.origin !== 'initial_scenario' || x.mother_queen_id !== null || x.laid_event_id !== null || x.caste_fate !== 'undetermined' || x.stage_progress !== null) throw Error(`ROSTER: brood item ${k} is not an inert initial-scenario item`);
  }
  for (const [k, p] of Object.entries(s.placement)) if (p.state !== 'in_nest' || p.loc !== 'nest' || !Number.isSafeInteger(p.since) || p.since < 0) throw Error(`ROSTER: placement of ${k}`);
  if (!rosterAudit(s).ok) throw Error('ROSTER: ledgers, placements or life records do not reconcile');
  if (rosterSnapshot(s) !== text) throw Error('ROSTER: snapshot is not canonical');
  return s;
}

// ------------------------------------------------------------------ per-individual 「尚未模擬」 labels
/** what is NOT simulated (or unknown) about a roster individual, by field key (CLAUDE.md §1, §3, §8) */
export const INDIVIDUAL_NOT_SIMULATED: Readonly<Record<string, string>> = Object.freeze({
  oviposition: '產卵：尚未模擬（產卵候選為 null，不會產下任何卵；世界中的卵是初始情境帶入的）',
  feeding: '被餵食／交哺：尚未模擬（沒有任何食物轉移到此個體）',
  metabolism: '代謝與能量消耗：尚未模擬（代謝接口為 null，不扣帳）',
  initial_reserve: '初始體內儲備：未知（null）；帳本從 0 起算只表示「沒有記入任何食物」，不是實測值',
  movement: '巢內位置與移動：尚未模擬（只有引擎狀態 in_nest，沒有座標；畫面上的位置是示意）',
  death: '死亡風險：尚未模擬（不會死亡）',
  behaviour: '階級特有行為（任務、招募、搬運、防衛）：尚未模擬；大工蟻全程留在巢內是標示的遊戲假設（major_behaviour = in_nest_only）',
  crop: '嗉囊內容：未知（null）',
  development: '發育（孵化、化蛹、羽化）：尚未模擬；階段不會改變',
  stage_progress: '階段內進度：未套用（null）',
  mother: '母后：未知（初始情境帶入，不是在模型中產下）',
  caste_fate: '階級命運：未決定（undetermined；階級分化尚未模擬）',
  care: '被照護（舔舐、搬運、餵食）：尚未模擬',
});
export const QUEEN_NOT_SIMULATED: readonly string[] = ['oviposition', 'feeding', 'metabolism', 'initial_reserve', 'movement', 'death'];
export const MAJOR_NOT_SIMULATED: readonly string[] = ['behaviour', 'feeding', 'metabolism', 'initial_reserve', 'crop', 'movement', 'death'];
export const EGG_NOT_SIMULATED: readonly string[] = ['development', 'stage_progress', 'mother', 'caste_fate', 'care', 'metabolism', 'death'];
export const PUPA_NOT_SIMULATED: readonly string[] = ['development', 'stage_progress', 'mother', 'caste_fate', 'care', 'metabolism', 'death'];

// ------------------------------------------------------------------ observation copy (data only; no rendering here)
/** one roster individual as an observer sees it (a copy; times in integer ms). Fields that do not apply or are unknown are null. */
export interface RosterIndividual {
  id: string; kind: 'queen' | 'worker' | 'brood';
  caste: 'major' | null; caste_source: 'initial_scenario' | null; stage: BroodStage | null;
  state: 'in_nest'; loc: 'nest'; since: number; alive: boolean; origin: 'initial_scenario';
  mother_queen_id: null; caste_fate: 'undetermined' | null; stage_progress: null;
  /** unknown, not empty: null */
  crop_fill: null; initial_reserve: null;
  eggs_laid: number | null; last_oviposition: number | null;
  /** own ledger slot (queens and majors): what was credited to and is held by this individual (integers) */
  ledger: { have: { sugar_ug: number; protein_ug: number; energy_uj: number }; received: { sugar_ug: number; protein_ug: number; energy_uj: number } } | null;
  not_simulated: string[];
}
/** a copy with a fixed key order (a restored state has sorted keys; the observation copy must not depend on that) */
const amt = (a: { sugar_ug: number; protein_ug: number; energy_uj: number }) => ({ sugar_ug: a.sugar_ug, protein_ug: a.protein_ug, energy_uj: a.energy_uj });
const byId = <T extends { id: string }>(a: T[]): T[] => a.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
export function rosterIndividuals(s: RosterState): { queens: RosterIndividual[]; majors: RosterIndividual[]; eggs: RosterIndividual[]; pupae: RosterIndividual[] } {
  const common = (id: string) => ({ id, state: s.placement[id].state, loc: s.placement[id].loc, since: s.placement[id].since, origin: 'initial_scenario' as const, mother_queen_id: null, stage_progress: null, crop_fill: null, initial_reserve: null });
  const queens = Object.values(s.members.queens).map((q): RosterIndividual => ({ ...common(q.id), kind: 'queen', caste: null, caste_source: null, stage: null, alive: q.alive, caste_fate: null, eggs_laid: q.eggs_laid, last_oviposition: q.last_oviposition_t, ledger: { have: amt(q.ledger.have), received: amt(q.ledger.received) }, not_simulated: [...QUEEN_NOT_SIMULATED] }));
  const majors = Object.values(s.members.workers).filter((w) => w.caste === 'major').map((w): RosterIndividual => ({ ...common(w.id), kind: 'worker', caste: 'major', caste_source: 'initial_scenario', stage: null, alive: w.alive, caste_fate: null, eggs_laid: null, last_oviposition: null, ledger: { have: amt(w.ledger.have), received: amt(w.ledger.received) }, not_simulated: [...MAJOR_NOT_SIMULATED] }));
  const brood = (stage: BroodStage, ns: readonly string[]) => Object.values(s.items).filter((x) => x.stage === stage).map((x): RosterIndividual => ({ ...common(x.id), kind: 'brood', caste: null, caste_source: null, stage, alive: x.alive, caste_fate: x.caste_fate, eggs_laid: null, last_oviposition: null, ledger: null, not_simulated: [...ns] }));
  return { queens: byId(queens), majors: byId(majors), eggs: byId(brood('egg', EGG_NOT_SIMULATED)), pupae: byId(brood('pupa', PUPA_NOT_SIMULATED)) };
}
