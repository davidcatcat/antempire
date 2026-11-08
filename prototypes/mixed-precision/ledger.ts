/**
 * WP5 PROTOTYPE (isolated; not imported by engine/, cli/ or web/; not part of any rules version; engine fingerprint
 * untouched). Design: docs/od1-mixed-precision-open-ecology.md (OD-1, Owner Q1-Q3).
 *
 * One event ledger for a mixed-precision world:
 *   - individuals (focal colony always; other organisms promoted on demand) with ID, physiology and food compartments;
 *   - cohorts (one per region x taxon x stage x colony) with an integer count, pooled food compartments and a roster of
 *     known IDs (demoted individuals);
 *   - regions: fine garden cells and coarse outside patches (and a finite pool R0). An individual keeps everything when it
 *     changes region; only the spatial resolution of its position changes (Owner Q2).
 * Every change of count goes through a recorded birth / death / migration (E at source + I at destination) / transport
 * record; promotion and demotion change only the representation and must conserve count, food mass and identity.
 * Food is integer micro-portions (game unit, not mg). Determinism: commands are applied in a canonical order
 * (day, minute, kind, key) and every draw comes from a named stream keyed by the command key, so storage order of the
 * state arrays and of the command list never matters.
 * This module holds no biological value; every rate/amount is an input.
 */
import { decayStep, type Rational } from './decay.ts';

export type Resolution = 'fine' | 'coarse';
export interface RegionDef { id: string; resolution: Resolution; in_garden: boolean }
export type Comp = Record<string, number>;
export type Physio = Record<string, number | string | null>;
export interface Individual { id: string; taxon: string; stage: string; colony_id: string | null; region: string; physio: Physio; comp: Comp }
export interface RosterEntry { id: string; physio: Physio }
export interface Cohort { cohort_id: string; taxon: string; stage: string; colony_id: string | null; region: string; count: number; comp: Comp; roster: RosterEntry[]; next_serial: number }
export interface Stock { stock_id: string; region: string; amount: number; origin_event_id: string | null }
export type ScenarioSubject = { kind: 'cohort'; taxon: string; stage: string; colony_id: string | null; count: number } | { kind: 'individual'; id: string };
/** Q1: a human transport may only execute an explicit, sourced scenario record. There is no frequency parameter. */
export interface ScenarioRecord { record_id: string; scenario_id: string; source_ref: string; day: number; from_region: string; to_region: string; subject: ScenarioSubject }
export interface WorldState {
  schema: 'antempire.wp5-mixed-precision.v1';
  seed: string; day: number;
  regions: RegionDef[]; individuals: Individual[]; cohorts: Cohort[]; stocks: Stock[];
  /** cumulative amounts that left the modeled food pool (decomposition, wash-off); never an organism */
  sinks: Record<string, number>;
  /** cumulative production by MODELED producers, stored as negative balances (so the global sum is constant) */
  producers: Record<string, number>;
  retired: string[];
  scenario_records: ScenarioRecord[]; used_scenario_records: string[];
  policy: { non_demotable_colonies: string[] };
}

interface T { day: number; minute: number | null; key: string }
export interface Trigger { kind: string; driver_event_ids: string[] }
export type Command =
  | (T & { kind: 'birth'; parent: { individual: string } | { cohort: string }; taxon: string; stage: string; colony_id: string | null; as: 'individual' | 'cohort'; endowment: { from: string; comp: string; amount: number }[] })
  | (T & { kind: 'death'; subject: { individual: string } | { cohort: string }; cause: string })
  | (T & { kind: 'move'; individual: string; to: string; cause: Trigger })
  | (T & { kind: 'cohort_move'; cohort: string; n: number; to: string; cause: Trigger })
  | (T & { kind: 'transport'; record_id: string })
  | (T & { kind: 'promote'; cohort: string; trigger: Trigger })
  | (T & { kind: 'demote'; individual: string; trigger: Trigger })
  | (T & { kind: 'food_transfer'; from: string; to: string; amount: number; cause: string })
  | (T & { kind: 'produce'; producer: string; stock: string; region: string; amount: number })
  | (T & { kind: 'decay'; stock: string; decomposition: Rational; clear_below: number });

export type LedgerKind = 'B' | 'D' | 'I' | 'E';
export interface LedgerEffect { region: string; taxon: string; stage: string; colony_id: string | null; ledger: LedgerKind; delta: number }
export interface FoodMove { from: string; to: string; amount: number; cause: string }
export interface LedgerRecord {
  event_id: string; kind: Command['kind'] | 'migration';
  t: { day: number; minute: number | null; time_resolution: 'minute' | 'day' };
  source_region: string | null; destination_region: string | null;
  identity: { action: 'kept' | 'born' | 'retired' | 'promoted' | 'demoted' | 'minted' | 'none'; ids: string[]; anonymous: number };
  ledger_effects: LedgerEffect[]; food_moves: FoodMove[];
  cause: { kind: string; driver_event_ids: string[]; rule_id: string; rng_stream: string | null; roll: number | null };
  resolution_change: { from: Resolution; to: Resolution } | null;
  scenario_source: { scenario_id: string; record_id: string; source_ref: string } | null;
  /** birth: the living parent (I6), so the independent audit can check it existed, was alive and in the same region */
  parent?: { individual: string } | { cohort: string } | null;
  /** promote/demote: the cohort whose representation changed (the audit replays roster membership from it) */
  cohort_id?: string | null;
}
export class LedgerRefusal extends Error {
  code: string;
  constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.code = code; }
}
const refuse = (code: string, msg: string): never => { throw new LedgerRefusal(code, msg); };

// ---------------------------------------------------------------- deterministic named draws (no Math.random)
function fnv1a(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** One uniform draw in [0,1) for (seed, stream, key): independent of any other draw and of processing order. */
export function draw(seed: string, stream: string, key: string): number {
  let x = fnv1a(`${seed}|${stream}|${key}`);
  x = (x + 0x6d2b79f5) | 0; let t = Math.imul(x ^ (x >>> 15), 1 | x); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------- helpers
export const cohortId = (region: string, taxon: string, stage: string, colony: string | null) => `C|${region}|${taxon}|${stage}|${colony ?? '-'}`;
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const KIND_ORDER: Command['kind'][] = ['produce', 'food_transfer', 'birth', 'promote', 'move', 'cohort_move', 'transport', 'demote', 'death', 'decay'];
/** Canonical processing order: (day, minute; day-resolution commands first), kind, key. Never array position. */
export const canonicalOrder = (a: Command, b: Command) =>
  a.day - b.day || (a.minute ?? -1) - (b.minute ?? -1) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || byStr(a.key, b.key);
const isInt = (x: number) => Number.isSafeInteger(x);
const noColon = (s: string, what: string) => { if (!s || s.includes(':')) refuse('BAD_ID', `${what} '${s}' must be non-empty and contain no ':'`); };
/** Per-member share of a pooled compartment: floor(total/count); the last member takes everything (no remainder lost). */
export const shareOf = (total: number, count: number) => (count <= 1 ? total : Math.floor(total / count));

interface Ix { st: WorldState; ind: Map<string, Individual>; coh: Map<string, Cohort>; stk: Map<string, Stock>; reg: Map<string, RegionDef>; retired: Set<string> }
function index(st: WorldState): Ix {
  const ind = new Map<string, Individual>(), coh = new Map<string, Cohort>(), stk = new Map<string, Stock>(), reg = new Map<string, RegionDef>();
  for (const r of st.regions) { noColon(r.id, 'region'); reg.set(r.id, r); }
  for (const i of st.individuals) { noColon(i.id, 'id'); if (ind.has(i.id)) refuse('DUPLICATE_ID', i.id); ind.set(i.id, i); }
  for (const c of st.cohorts) { if (coh.has(c.cohort_id)) refuse('DUPLICATE_COHORT', c.cohort_id); coh.set(c.cohort_id, c); }
  for (const s of st.stocks) { noColon(s.stock_id, 'stock'); stk.set(s.stock_id, s); }
  return { st, ind, coh, stk, reg, retired: new Set(st.retired) };
}
function region(ix: Ix, id: string): RegionDef { return ix.reg.get(id) ?? refuse('UNKNOWN_REGION', id); }
function getCohort(ix: Ix, region: string, taxon: string, stage: string, colony: string | null): Cohort {
  const id = cohortId(region, taxon, stage, colony);
  let c = ix.coh.get(id);
  if (!c) { c = { cohort_id: id, taxon, stage, colony_id: colony, region, count: 0, comp: {}, roster: [], next_serial: 0 }; ix.coh.set(id, c); }
  return c;
}
/** Resolve a compartment address to a balance accessor. org:<id>:<comp> | cohort:<cohort_id>:<comp> | stock:<id> | sink:<name> */
function addr(ix: Ix, a: string, create = false): { get: () => number; add: (d: number) => void } {
  const p = a.indexOf(':'); const kind = a.slice(0, p), rest = a.slice(p + 1);
  if (kind === 'org' || kind === 'cohort') {
    const q = rest.lastIndexOf(':'); const id = rest.slice(0, q), comp = rest.slice(q + 1);
    const owner = kind === 'org' ? ix.ind.get(id) : ix.coh.get(id);
    if (!owner || q < 0 || !comp) return refuse('UNKNOWN_COMPARTMENT', a);
    return { get: () => owner.comp[comp] ?? 0, add: (d) => { owner.comp[comp] = (owner.comp[comp] ?? 0) + d; } };
  }
  if (kind === 'stock') {
    const s = ix.stk.get(rest);
    if (!s && !create) return refuse('UNKNOWN_COMPARTMENT', a);
    return { get: () => ix.stk.get(rest)?.amount ?? 0, add: (d) => { ix.stk.get(rest)!.amount += d; } };
  }
  if (kind === 'sink') return { get: () => ix.st.sinks[rest] ?? 0, add: (d) => { ix.st.sinks[rest] = (ix.st.sinks[rest] ?? 0) + d; } };
  return refuse('UNKNOWN_COMPARTMENT', a);
}
function move(ix: Ix, moves: FoodMove[], from: string, to: string, amount: number, cause: string): void {
  if (!isInt(amount) || amount < 0) refuse('BAD_AMOUNT', `${amount}`);
  if (amount === 0) return;
  if (from.startsWith('sink:')) refuse('SINK_IS_TERMINAL', from);
  const f = addr(ix, from), t = addr(ix, to);
  if (f.get() < amount) refuse('INSUFFICIENT', `${from} has ${f.get()} < ${amount}`);
  f.add(-amount); t.add(amount); moves.push({ from, to, amount, cause });
}
const eff = (c: { region: string; taxon: string; stage: string; colony_id: string | null }, ledger: LedgerKind, delta = 1): LedgerEffect =>
  ({ region: c.region, taxon: c.taxon, stage: c.stage, colony_id: c.colony_id, ledger, delta });
function needTrigger(tr: Trigger | undefined, what: string): Trigger {
  if (!tr || !tr.kind || !Array.isArray(tr.driver_event_ids) || tr.driver_event_ids.length === 0) refuse('NO_CAUSE', `${what} needs a cause with driver event ids`);
  return tr!;
}
/** Pick which member leaves a cohort: a roster ID or an anonymous member, by a named draw over the whole count. */
function pickMember(ix: Ix, c: Cohort, stream: string, key: string): { member: RosterEntry | null; roll: number } {
  if (c.count < 1) refuse('INSUFFICIENT_COUNT', `${c.cohort_id} is empty`);
  const roll = draw(ix.st.seed, stream, key);
  const k = Math.floor(roll * c.count);
  c.roster.sort((a, b) => byStr(a.id, b.id));
  return { member: k < c.roster.length ? c.roster.splice(k, 1)[0] : null, roll };
}
/** Release one member's share of every pooled compartment (floor(total/count); the last member takes the rest). */
function releaseShare(ix: Ix, c: Cohort, moves: FoodMove[], dest: (comp: string) => string, cause: string): void {
  for (const comp of Object.keys(c.comp).sort(byStr)) move(ix, moves, `cohort:${c.cohort_id}:${comp}`, dest(comp), shareOf(c.comp[comp], c.count), cause);
  c.count -= 1;
}
function takeMember(ix: Ix, c: Cohort, stream: string, key: string, moves: FoodMove[], dest: (comp: string) => string, cause: string): { id: string | null; physio: Physio; roll: number } {
  const { member, roll } = pickMember(ix, c, stream, key);
  releaseShare(ix, c, moves, dest, cause);
  return { id: member ? member.id : null, physio: member ? member.physio : {}, roll };
}

function rec(cmd: Command, kind: LedgerRecord['kind'], over: Partial<LedgerRecord>): LedgerRecord {
  return {
    event_id: `${cmd.day}.${cmd.key}`, kind, t: { day: cmd.day, minute: cmd.minute, time_resolution: cmd.minute === null ? 'day' : 'minute' },
    source_region: null, destination_region: null, identity: { action: 'none', ids: [], anonymous: 0 },
    ledger_effects: [], food_moves: [], cause: { kind: kind, driver_event_ids: [], rule_id: `wp5.${cmd.kind}`, rng_stream: null, roll: null },
    resolution_change: null, scenario_source: null, parent: null, cohort_id: null, ...over,
  };
}

/** Move a whole individual between regions: ID, physiology, colony and compartments are untouched (Owner Q2). */
function moveIndividual(ix: Ix, cmd: Command, i: Individual, to: string, cause: { kind: string; driver_event_ids: string[] }, kind: LedgerRecord['kind'], scen: LedgerRecord['scenario_source']): LedgerRecord {
  const from = region(ix, i.region), dest = region(ix, to);
  if (from.id === dest.id) refuse('NO_OP_MOVE', i.id);
  const out = rec(cmd, kind, {
    source_region: from.id, destination_region: dest.id, identity: { action: 'kept', ids: [i.id], anonymous: 0 },
    ledger_effects: [eff(i, 'E'), eff({ ...i, region: dest.id }, 'I')],
    cause: { kind: cause.kind, driver_event_ids: [...cause.driver_event_ids], rule_id: `wp5.${cmd.kind}`, rng_stream: null, roll: null },
    resolution_change: from.resolution !== dest.resolution ? { from: from.resolution, to: dest.resolution } : null, scenario_source: scen,
  });
  i.region = dest.id;
  return out;
}
function moveCohortMembers(ix: Ix, cmd: Command, c: Cohort, n: number, to: string, cause: { kind: string; driver_event_ids: string[] }, kind: LedgerRecord['kind'], scen: LedgerRecord['scenario_source']): LedgerRecord {
  const from = region(ix, c.region), dest = region(ix, to);
  if (c.region === to) refuse('NO_OP_MOVE', c.cohort_id);
  if (!isInt(n) || n < 1) refuse('BAD_COUNT', `${n}`);
  if (c.count < n) refuse('INSUFFICIENT_COUNT', `${c.cohort_id} has ${c.count} < ${n}`);
  const d = getCohort(ix, to, c.taxon, c.stage, c.colony_id), moves: FoodMove[] = [], ids: string[] = [];
  let anon = 0;
  for (let j = 0; j < n; j++) {
    const m = takeMember(ix, c, `${kind}`, `${cmd.key}#${j}`, moves, (comp) => `cohort:${d.cohort_id}:${comp}`, kind);
    d.count += 1;
    if (m.id) { d.roster.push({ id: m.id, physio: m.physio }); ids.push(m.id); } else anon++;
  }
  return rec(cmd, kind, {
    source_region: c.region, destination_region: to, identity: { action: 'kept', ids: ids.sort(byStr), anonymous: anon },
    ledger_effects: [eff(c, 'E', n), eff(d, 'I', n)], food_moves: moves,
    cause: { kind: cause.kind, driver_event_ids: [...cause.driver_event_ids], rule_id: `wp5.${cmd.kind}`, rng_stream: kind, roll: null },
    resolution_change: from.resolution !== dest.resolution ? { from: from.resolution, to: dest.resolution } : null, scenario_source: scen,
  });
}

/** Apply ONE command to an indexed state. Exported only so tests can build an order-dependent (broken) runner. */
export function applyCommand(ix: Ix, cmd: Command): LedgerRecord {
  const st = ix.st;
  if (cmd.day !== st.day) refuse('WRONG_DAY', `${cmd.key} day ${cmd.day} != ${st.day}`);
  noColon(cmd.key, 'key');
  switch (cmd.kind) {
    case 'produce': {
      // production only by a MODELED, living producer (a cohort with members or a living individual)
      const pid = cmd.producer;
      const alive = ix.ind.has(pid) || (ix.coh.get(pid)?.count ?? 0) > 0;
      if (!alive) refuse('NO_PRODUCER', `${pid} is not a living modeled producer`);
      if (!isInt(cmd.amount) || cmd.amount <= 0) refuse('BAD_AMOUNT', `${cmd.amount}`);
      region(ix, cmd.region);
      // production is local: the producer and the stock it feeds are in the stated region (model rule, not a number)
      const preg = ix.ind.get(pid)?.region ?? ix.coh.get(pid)!.region;
      if (preg !== cmd.region) refuse('PRODUCER_REGION_MISMATCH', `${pid} is in ${preg}, not ${cmd.region}`);
      if (ix.stk.has(cmd.stock) && ix.stk.get(cmd.stock)!.region !== cmd.region) refuse('STOCK_REGION_MISMATCH', `${cmd.stock} is not in ${cmd.region}`);
      if (!ix.stk.has(cmd.stock)) ix.stk.set(cmd.stock, { stock_id: cmd.stock, region: cmd.region, amount: 0, origin_event_id: `${cmd.day}.${cmd.key}` });
      st.producers[pid] = (st.producers[pid] ?? 0) - cmd.amount;
      ix.stk.get(cmd.stock)!.amount += cmd.amount;
      return rec(cmd, 'produce', { destination_region: cmd.region, food_moves: [{ from: `producer:${pid}`, to: `stock:${cmd.stock}`, amount: cmd.amount, cause: 'production' }] });
    }
    case 'food_transfer': {
      const moves: FoodMove[] = [];
      move(ix, moves, cmd.from, cmd.to, cmd.amount, cmd.cause);
      return rec(cmd, 'food_transfer', { food_moves: moves });
    }
    case 'birth': {
      // I6: a birth needs a living parent in the same region; the newborn's food comes only from recorded compartments
      const p = 'individual' in cmd.parent ? ix.ind.get(cmd.parent.individual) : ix.coh.get(cmd.parent.cohort);
      if (!p || ('count' in p && p.count < 1)) refuse('NO_PARENT', JSON.stringify(cmd.parent));
      const reg = p!.region, moves: FoodMove[] = [];
      let id: string | null = null, dest: (comp: string) => string;
      if (cmd.as === 'individual') {
        id = `B.${cmd.day}.${cmd.key}`;
        if (ix.ind.has(id) || ix.retired.has(id)) refuse('DUPLICATE_ID', id);
        ix.ind.set(id, { id, taxon: cmd.taxon, stage: cmd.stage, colony_id: cmd.colony_id, region: reg, physio: {}, comp: {} });
        dest = (comp) => `org:${id}:${comp}`;
      } else {
        const c = getCohort(ix, reg, cmd.taxon, cmd.stage, cmd.colony_id); c.count += 1;
        dest = (comp) => `cohort:${c.cohort_id}:${comp}`;
      }
      for (const e of cmd.endowment) move(ix, moves, e.from, dest(e.comp), e.amount, 'birth_endowment');
      return rec(cmd, 'birth', {
        destination_region: reg, identity: { action: 'born', ids: id ? [id] : [], anonymous: id ? 0 : 1 }, parent: structuredClone(cmd.parent),
        ledger_effects: [eff({ region: reg, taxon: cmd.taxon, stage: cmd.stage, colony_id: cmd.colony_id }, 'B')], food_moves: moves,
        cause: { kind: 'birth', driver_event_ids: [], rule_id: 'wp5.birth', rng_stream: null, roll: null },
      });
    }
    case 'death': {
      // I7: the body's food stays in the region as a corpse stock with this event as origin
      const moves: FoodMove[] = [], ev = `${cmd.day}.${cmd.key}`;
      const corpse = (reg: string) => (comp: string) => {
        const sid = `corpse.${cmd.day}.${cmd.key}.${comp}`;
        if (!ix.stk.has(sid)) ix.stk.set(sid, { stock_id: sid, region: reg, amount: 0, origin_event_id: ev });
        return `stock:${sid}`;
      };
      if ('individual' in cmd.subject) {
        const i = ix.ind.get(cmd.subject.individual) ?? refuse('UNKNOWN_INDIVIDUAL', cmd.subject.individual);
        const to = corpse(i.region);
        for (const comp of Object.keys(i.comp).sort(byStr)) move(ix, moves, `org:${i.id}:${comp}`, to(comp), i.comp[comp], 'death_body_to_corpse');
        ix.ind.delete(i.id); ix.retired.add(i.id);
        return rec(cmd, 'death', { source_region: i.region, identity: { action: 'retired', ids: [i.id], anonymous: 0 }, ledger_effects: [eff(i, 'D')], food_moves: moves, cause: { kind: cmd.cause, driver_event_ids: [], rule_id: 'wp5.death', rng_stream: null, roll: null } });
      }
      const c = ix.coh.get(cmd.subject.cohort) ?? refuse('UNKNOWN_COHORT', cmd.subject.cohort);
      const m = takeMember(ix, c, 'cohort_death', cmd.key, moves, corpse(c.region), 'death_body_to_corpse');
      if (m.id) ix.retired.add(m.id);
      return rec(cmd, 'death', { source_region: c.region, identity: { action: 'retired', ids: m.id ? [m.id] : [], anonymous: m.id ? 0 : 1 }, ledger_effects: [eff(c, 'D')], food_moves: moves, cause: { kind: cmd.cause, driver_event_ids: [], rule_id: 'wp5.death.cohort', rng_stream: 'cohort_death', roll: m.roll } });
    }
    case 'move': {
      const i = ix.ind.get(cmd.individual) ?? refuse('UNKNOWN_INDIVIDUAL', cmd.individual);
      return moveIndividual(ix, cmd, i, cmd.to, needTrigger(cmd.cause, 'move'), 'migration', null);
    }
    case 'cohort_move': {
      const c = ix.coh.get(cmd.cohort) ?? refuse('UNKNOWN_COHORT', cmd.cohort);
      return moveCohortMembers(ix, cmd, c, cmd.n, cmd.to, needTrigger(cmd.cause, 'cohort_move'), 'migration', null);
    }
    case 'transport': {
      // Q1: only an explicit, sourced scenario record, executed once, on its own day; it moves existing organisms only
      const r = st.scenario_records.find((x) => x.record_id === cmd.record_id);
      if (!r) return refuse('NO_SCENARIO_SOURCE', `transport ${cmd.key}: no scenario record '${cmd.record_id}'`);
      if (!r.scenario_id || !r.source_ref) refuse('NO_SCENARIO_SOURCE', `record ${r.record_id} lacks scenario_id/source_ref`);
      if (r.day !== cmd.day) refuse('SCENARIO_DAY_MISMATCH', r.record_id);
      if (st.used_scenario_records.includes(r.record_id)) refuse('SCENARIO_RECORD_USED', r.record_id);
      st.used_scenario_records.push(r.record_id);
      const scen = { scenario_id: r.scenario_id, record_id: r.record_id, source_ref: r.source_ref };
      const cause = { kind: 'human_transport', driver_event_ids: [`scenario:${r.scenario_id}:${r.record_id}`] };
      if (r.subject.kind === 'individual') {
        const i = ix.ind.get(r.subject.id) ?? refuse('UNKNOWN_INDIVIDUAL', r.subject.id);
        if (i.region !== r.from_region) refuse('SCENARIO_SOURCE_MISMATCH', `${i.id} is not in ${r.from_region}`);
        return moveIndividual(ix, cmd, i, r.to_region, cause, 'transport', scen);
      }
      const c = ix.coh.get(cohortId(r.from_region, r.subject.taxon, r.subject.stage, r.subject.colony_id));
      if (!c) return refuse('INSUFFICIENT_COUNT', `no cohort for record ${r.record_id}`);
      return moveCohortMembers(ix, cmd, c, r.subject.count, r.to_region, cause, 'transport', scen);
    }
    case 'promote': {
      const tr = needTrigger(cmd.trigger, 'promote');
      const c = ix.coh.get(cmd.cohort) ?? refuse('UNKNOWN_COHORT', cmd.cohort);
      const moves: FoodMove[] = [];
      const { member, roll } = pickMember(ix, c, 'promote', cmd.key);
      // a roster member keeps its ID; an anonymous member gets a new ID (the organism already existed in the count)
      const id = member ? member.id : `M.${c.cohort_id.replace(/\|/g, '.')}.${c.next_serial++}`;
      if (ix.ind.has(id) || ix.retired.has(id)) refuse('DUPLICATE_ID', id);
      ix.ind.set(id, { id, taxon: c.taxon, stage: c.stage, colony_id: c.colony_id, region: c.region, physio: member ? member.physio : {}, comp: {} });
      releaseShare(ix, c, moves, (comp) => `org:${id}:${comp}`, 'promotion_share');
      return rec(cmd, 'promote', { source_region: c.region, destination_region: c.region, identity: { action: member ? 'promoted' : 'minted', ids: [id], anonymous: 0 }, cohort_id: c.cohort_id, food_moves: moves, cause: { kind: tr.kind, driver_event_ids: [...tr.driver_event_ids], rule_id: 'wp5.promote', rng_stream: 'promote', roll } });
    }
    case 'demote': {
      const tr = needTrigger(cmd.trigger, 'demote');
      const i = ix.ind.get(cmd.individual) ?? refuse('UNKNOWN_INDIVIDUAL', cmd.individual);
      if (i.colony_id !== null && st.policy.non_demotable_colonies.includes(i.colony_id)) refuse('NON_DEMOTABLE', `${i.id} belongs to ${i.colony_id} (Owner Q2: focal colony stays individual)`);
      const c = getCohort(ix, i.region, i.taxon, i.stage, i.colony_id), moves: FoodMove[] = [];
      for (const comp of Object.keys(i.comp).sort(byStr)) move(ix, moves, `org:${i.id}:${comp}`, `cohort:${c.cohort_id}:${comp}`, i.comp[comp], 'demotion_pool');
      c.count += 1; c.roster.push({ id: i.id, physio: structuredClone(i.physio) });
      ix.ind.delete(i.id);
      return rec(cmd, 'demote', { source_region: i.region, destination_region: i.region, identity: { action: 'demoted', ids: [i.id], anonymous: 0 }, cohort_id: c.cohort_id, food_moves: moves, cause: { kind: tr.kind, driver_event_ids: [...tr.driver_event_ids], rule_id: 'wp5.demote', rng_stream: null, roll: null } });
    }
    case 'decay': {
      const s = ix.stk.get(cmd.stock) ?? refuse('UNKNOWN_STOCK', cmd.stock);
      const { flows } = decayStep(`stock:${s.stock_id}`, { stock: s.amount, inflows: [], decomposition: cmd.decomposition, other_sinks: [], clear_below: cmd.clear_below });
      const moves: FoodMove[] = [];
      for (const f of flows) move(ix, moves, f.from, f.to, f.amount, f.cause);
      return rec(cmd, 'decay', { source_region: s.region, food_moves: moves });
    }
  }
}

/** Rebuild the plain state from the index with every array sorted by ID (storage order never leaks into output). */
export function exportState(ix: Ix): WorldState {
  const st = ix.st;
  return {
    ...st,
    individuals: [...ix.ind.values()].sort((a, b) => byStr(a.id, b.id)),
    cohorts: [...ix.coh.values()].map((c) => ({ ...c, roster: [...c.roster].sort((a, b) => byStr(a.id, b.id)) })).sort((a, b) => byStr(a.cohort_id, b.cohort_id)),
    stocks: [...ix.stk.values()].sort((a, b) => byStr(a.stock_id, b.stock_id)),
    regions: [...st.regions].sort((a, b) => byStr(a.id, b.id)),
    retired: [...ix.retired].sort(byStr),
    used_scenario_records: [...st.used_scenario_records].sort(byStr),
    scenario_records: [...st.scenario_records].sort((a, b) => byStr(a.record_id, b.record_id)),
  };
}
export const indexState = (st: WorldState) => index(structuredClone(st));

/** Run one day: atomic (works on a copy; any refusal throws and leaves the input untouched), canonical order. */
export function runDay(state: WorldState, commands: Command[]): { state: WorldState; records: LedgerRecord[] } {
  const keys = new Set<string>();
  for (const c of commands) { if (keys.has(c.key)) refuse('DUPLICATE_KEY', c.key); keys.add(c.key); }
  const ix = indexState(state);
  const records = [...commands].sort(canonicalOrder).map((c) => applyCommand(ix, c));
  const out = exportState(ix); out.day += 1;
  return { state: out, records };
}

/** JSON with sorted object keys (for byte comparisons). */
export function canonicalJson(x: unknown): string {
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort(byStr).map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(x));
}
