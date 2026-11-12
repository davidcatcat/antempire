/**
 * WP5b PROTOTYPE (isolated; not imported by engine/, cli/ or web/; not a rules version). Design:
 * docs/od1b-cohort-life-time.md. Owner P0 (2026-11): background organisms keep living while pooled in a cohort.
 *
 * One representation-agnostic life-time step for individuals and cohorts:
 *   - a UNIT is either an individual (n = 1, an ID, exact physiology) or a cohort bin (n members with the same discrete
 *     state: region, stage, Erlang sub-stage, age bin and, in 'exact' reserve mode, the same reserve); a bin keeps the
 *     integer totals of reserve and chronological age and a roster of known IDs (with exact ages);
 *   - development is a distributed delay: each stage is k sub-stages (boxcar train); a member advances one sub-stage per
 *     day with probability p = min(1, k * max(0, T - T_lower) / DD_stage * f_nutrition), i.e. the stage duration in
 *     degree-days is (discrete) Erlang/negative-binomial with mean DD_stage;
 *   - every phase is the SAME per-member rule for both representations: a cohort bin draws Binomial / multivariate
 *     hypergeometric counts where an individual draws one Bernoulli, so a bin is an exact lumping of individuals
 *     whenever every member of the bin has the same state (exact reserve mode, daily age bins). Pooling the reserve, or
 *     wider age bins, is an approximation and its error is measured (lifetime-compare.ts), not assumed away.
 *   - 'deterministic' replaces every draw by its expectation (a mean-field, Lefkovitch/McKendrick-type projection); it is
 *     real-valued, has no IDs and is only used as a comparison reference, never for a ledger.
 * Every count change is a recorded birth / death / stage transition / migration; reserve food moves only between
 * recorded category accounts (stock, body, respiration sink, corpse, producer). Draws come from named streams keyed by
 * (day, phase, unit path, member index) via ledger.ts `draw`; storage order never matters.
 * This module holds NO biological value: every rate/amount is an input (see the fixtures and their labels).
 *
 * STATUS (issue #145, Owner 2026-11-08): lifeDay / LifeState is NOT an authoritative population ledger. It is kept as a
 * comparison engine (lifetime-compare.ts) and as the source of the per-member life rules (canFeed, devProb, canLay,
 * hazardOf). The single authoritative ledger is unified.ts; a LifeState is converted with migrateLifetime() and is then
 * superseded. Its promote/demote refuse observer causes (issue #144 fallback, view-guard.ts).
 */
import { draw } from './ledger.ts';
import { isViewCause, VIEW_REFUSAL } from './view-guard.ts';

// ---------------------------------------------------------------- per-member rules (issue #145: the single source of the
// life-time rules; lifeDay below and the unified ledger unified.ts both call these, so neither keeps its own copy)
/** feeding eligibility: a feeding stage with room for one meal */
export const canFeed = (P: LifeParams, sd: StageDef, reserve: number) => sd.feeds && reserve + P.meal <= P.crop_cap;
/** daily probability of advancing one Erlang sub-stage (degree-days above t_lower, slowed when hungry) */
export const devProb = (P: LifeParams, sd: StageDef, temp_c: number, hungry: boolean) =>
  Math.min(1, sd.substages * ((Math.max(0, temp_c - P.t_lower) / sd.dd_required!) * (hungry ? P.dev_factor_hungry : 1)));
/** reproduction eligibility */
export const canLay = (P: LifeParams, sd: StageDef, hungry: boolean, reserve: number) => sd.reproduces && !hungry && reserve >= P.egg_cost;
/** daily death probability: baseline + starvation + linear senescence after senescence_start */
export const hazardOf = (P: LifeParams, sd: StageDef, hungry: boolean, age: number) =>
  Math.min(1, sd.hazard + (hungry ? P.h_starve : 0) + (sd.senesces ? P.senescence_slope * Math.max(0, age - P.senescence_start) : 0));

export interface StageDef {
  name: string;
  feeds: boolean; reproduces: boolean; senesces: boolean;
  /** Erlang sub-stages (boxcars); 0 = terminal stage (no development) */
  substages: number;
  /** degree-days above t_lower to complete the stage; null for a terminal stage */
  dd_required: number | null;
  /** baseline daily death probability */
  hazard: number;
}
export interface LifeParams {
  stages: StageDef[];
  t_lower: number;
  /** reserve units taken in one meal; daily maintenance burn; reserve ceiling for feeding; reserve given to one egg */
  meal: number; burn: number; crop_cap: number; egg_cost: number;
  p_lay: number; h_starve: number; dev_factor_hungry: number;
  senescence_start: number; senescence_slope: number;
}
export interface Resolution {
  /** width of the chronological age bins of anonymous cohort members (1 = exact daily age) */
  age_bin_days: number;
  /** 'exact': a bin holds members with one reserve value (lossless); 'pooled': a bin holds only the reserve total */
  reserve: 'exact' | 'pooled';
  deterministic: boolean;
  /** newborns of an individual parent: an individual ('follow_parent') or always anonymous ('cohort') */
  newborn: 'follow_parent' | 'cohort';
}
export interface RosterMember { id: string; age: number }
export interface Unit {
  region: string; stage: number; sub: number;
  /** individual or daily bins: exact age (days); age_bin_days > 1: the bin index */
  age: number;
  id: string | null;
  n: number;
  /** total reserve of all members */
  reserve: number;
  /** exact reserve of every member (exact mode); null when pooled or for an individual */
  rkey: number | null;
  /** total chronological age of all members (exact) */
  age_sum: number;
  roster: RosterMember[];
}
export interface LifeState {
  schema: 'antempire.wp5b-lifetime.v1';
  seed: string; day: number; res: Resolution;
  units: Unit[];
  stocks: Record<string, number>;
  /** cumulative category balances that are not organisms or stocks */
  sinks: Record<string, number>;
  corpses: Record<string, number>;
  producers: Record<string, number>;
  retired: string[];
  /** set by unified-migrate.ts: converted into the unified ledger; no longer advanced (#145) */
  superseded_by?: string;
}
export interface Cause { kind: string; driver_event_ids: string[] }
export type LifeCommand =
  | { kind: 'promote'; key: string; region: string; stage: number; n: number; cause: Cause }
  | { kind: 'demote'; key: string; id: string; cause: Cause }
  | { kind: 'migrate'; key: string; region: string; stage: number; n: number; to: string; cause: Cause };
export interface DayInput { temp_c: number; inflow: Record<string, number>; commands: LifeCommand[] }

export type LedgerEffect = { region: string; stage: number; ledger: 'B' | 'D' | 'I' | 'E' | 'Ti' | 'To'; delta: number };
export interface MassMove { from: string; to: string; amount: number }
export interface LifeRecord {
  event_id: string; day: number;
  kind: 'produce' | 'feed' | 'burn' | 'birth' | 'develop' | 'transition' | 'death' | 'aging' | 'migration' | 'promote' | 'demote';
  region: string | null; stage: number | null; count: number;
  /** known IDs involved (born, retired, moved, promoted, demoted) */
  ids: string[]; anonymous: number;
  effects: LedgerEffect[]; mass: MassMove[];
  /** death / transition / migration: total chronological age of the members concerned; aging: see `aging` */
  age_sum: number | null;
  aging: { count: number; age_sum_before: number; age_sum_after: number } | null;
  hungry: boolean | null;
  /** promote: the restored state of each new individual and how it was obtained */
  restored: { id: string; from: 'roster' | 'sampled'; stage: number; sub: number; age: number; reserve: number; roll: number | null; rule: string }[] | null;
  /** demote: the individual's exact state before it entered the bin (lets the restoration error be measured) */
  demoted: { id: string; stage: number; sub: number; age: number; reserve: number } | null;
  cause: Cause | null; rng_stream: string | null;
}
export class LifeRefusal extends Error {
  code: string;
  constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.code = code; }
}
const refuse = (code: string, msg: string): never => { throw new LifeRefusal(code, msg); };

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** canonical key of a unit: individuals by ID, bins by their discrete state */
export const unitKey = (u: Unit) => (u.id !== null ? `#${u.id}` : `${u.region}|${u.stage}|${u.sub}|${u.age}|${u.rkey ?? '*'}`);
export const bodyAcct = (region: string, stage: number) => `body:${region}:${stage}`;
/** sum of k successive floor shares of `total` over n members (the last member takes the rest): exact integer split */
export function shareSum(total: number, n: number, k: number): number {
  let s = 0, t = total, m = n;
  for (let i = 0; i < k; i++) { const sh = m <= 1 ? t : Math.floor(t / m); s += sh; t -= sh; m--; }
  return s;
}

interface W extends Unit { path: string; hungry: boolean }
interface Cx { seed: string; day: number; res: Resolution; P: LifeParams; recs: LifeRecord[]; st: LifeState; retired: Set<string>; serial: number }

const perReserve = (u: Unit) => (u.id !== null ? u.reserve : u.rkey !== null ? u.rkey : u.reserve / u.n);
const perAge = (cx: Cx, u: Unit) => (u.id !== null || cx.res.age_bin_days === 1 ? u.age : u.age_sum / u.n);

function rec(cx: Cx, kind: LifeRecord['kind'], tag: string, over: Partial<LifeRecord>): LifeRecord {
  const r: LifeRecord = {
    event_id: `${cx.day}.${kind}.${tag}`, day: cx.day, kind, region: null, stage: null, count: 0, ids: [], anonymous: 0,
    effects: [], mass: [], age_sum: null, aging: null, hungry: null, restored: null, demoted: null, cause: null, rng_stream: null, ...over,
  };
  cx.recs.push(r);
  return r;
}
/** k of n by independent Bernoulli(p) draws (or the expectation n*p when deterministic) */
function binom(cx: Cx, n: number, p: number, stream: string, key: string): number {
  if (p <= 0 || n <= 0) return 0;
  if (cx.res.deterministic) return n * Math.min(1, p);
  if (p >= 1) return n;
  let k = 0;
  for (let j = 0; j < n; j++) if (draw(cx.seed, stream, `${cx.day}|${key}#${j}`) < p) k++;
  return k;
}
/** choose `pick` members uniformly from the pool of units (sequential multivariate hypergeometric); returns per-unit k */
function choose(cx: Cx, units: W[], pick: number, stream: string, key: string): number[] {
  const N = units.reduce((a, u) => a + u.n, 0);
  if (cx.res.deterministic) return units.map((u) => (N > 0 ? (u.n * pick) / N : 0));
  let rem = pick, left = N;
  return units.map((u) => {
    let k = 0;
    for (let j = 0; j < u.n; j++) { if (rem > 0 && draw(cx.seed, stream, `${cx.day}|${key}|${u.path}#${j}`) < rem / left) { k++; rem--; } left--; }
    return k;
  });
}
/** split k members off a unit: roster members by a uniform subset rule, then anonymous ones; reserve and age totals split
 *  exactly (equal reserve per member in exact mode; successive floor shares when pooled; exact roster ages). */
function partition(cx: Cx, u: W, k: number, stream: string): [W, W] {
  const empty = (side: string): W => ({ ...u, n: 0, reserve: 0, age_sum: 0, roster: [], path: u.path + side });
  if (k <= 0) return [empty('/a'), { ...u, path: u.path + '/b' }];
  if (k >= u.n) return [{ ...u, path: u.path + '/a' }, empty('/b')];
  if (cx.res.deterministic) {
    const f = k / u.n;
    return [{ ...u, n: k, reserve: u.reserve * f, age_sum: u.age_sum * f, path: u.path + '/a' }, { ...u, n: u.n - k, reserve: u.reserve * (1 - f), age_sum: u.age_sum * (1 - f), path: u.path + '/b' }];
  }
  const rA: RosterMember[] = [], rB: RosterMember[] = [];
  let kr = k, nr = u.n;
  for (const r of [...u.roster].sort((a, b) => byStr(a.id, b.id))) {
    if (draw(cx.seed, stream, `${cx.day}|${u.path}|${r.id}`) < kr / nr) { rA.push(r); kr--; } else rB.push(r);
    nr--;
  }
  const resA = u.rkey !== null ? k * u.rkey : shareSum(u.reserve, u.n, k);
  const rosterAge = (rs: RosterMember[]) => rs.reduce((a, r) => a + r.age, 0);
  const anonN = u.n - u.roster.length, anonAge = u.age_sum - rosterAge(u.roster);
  const ageA = cx.res.age_bin_days === 1 ? k * u.age : rosterAge(rA) + shareSum(anonAge, anonN, kr);
  return [
    { ...u, n: k, reserve: resA, age_sum: ageA, roster: rA, path: u.path + '/a' },
    { ...u, n: u.n - k, reserve: u.reserve - resA, age_sum: u.age_sum - ageA, roster: rB, path: u.path + '/b' },
  ];
}
const idsOf = (u: Unit) => (u.id !== null ? [u.id] : u.roster.map((r) => r.id)).sort(byStr);
const anonOf = (u: Unit) => (u.id !== null ? 0 : u.n - u.roster.length);
const nonEmpty = (xs: W[]) => xs.filter((u) => u.n > 0);
function needCause(c: Cause | undefined, what: string): Cause {
  if (!c || !c.kind || !Array.isArray(c.driver_event_ids) || c.driver_event_ids.length === 0) refuse('NO_CAUSE', `${what} needs a cause with driver event ids`);
  return c!;
}

// ---------------------------------------------------------------- representation commands
function promote(cx: Cx, ws: W[], c: Extract<LifeCommand, { kind: 'promote' }>): W[] {
  const cause = needCause(c.cause, 'promote');
  if (isViewCause(cause)) refuse(VIEW_REFUSAL, `${c.key}: a view action cannot promote (issue #144)`);
  if (cx.res.deterministic) refuse('NO_IDS_IN_MEAN_FIELD', 'a deterministic run has no members to promote');
  if (!Number.isSafeInteger(c.n) || c.n < 1) refuse('BAD_COUNT', `${c.n}`);
  const restored: NonNullable<LifeRecord['restored']> = [];
  const bins = () => ws.filter((u) => u.id === null && u.region === c.region && u.stage === c.stage && u.n > 0);
  if (bins().reduce((a, u) => a + u.n, 0) < c.n) refuse('INSUFFICIENT_COUNT', `${c.region}/${c.stage} has fewer than ${c.n} pooled members`);
  const out: W[] = [];
  const extract = (u: W, id: string, age: number, from: 'roster' | 'sampled', roll: number | null) => {
    const reserve = u.rkey !== null ? u.rkey : shareSum(u.reserve, u.n, 1);
    u.n -= 1; u.reserve -= reserve; u.age_sum -= age;
    out.push({ region: u.region, stage: u.stage, sub: u.sub, age, id, n: 1, reserve, rkey: null, age_sum: age, roster: [], path: `#${id}`, hungry: false });
    restored.push({ id, from, stage: u.stage, sub: u.sub, age, reserve, roll, rule: from === 'roster'
      ? `roster: stage/sub-stage from the bin, exact age from the roster, reserve ${u.rkey !== null ? 'exact (bin value)' : 'floor share of the pooled total'}`
      : `sampled: bin by named draw weighted by anonymous count; age ${cx.res.age_bin_days === 1 ? 'exact (daily bin)' : 'floor share of the anonymous age total'}; reserve ${u.rkey !== null ? 'exact (bin value)' : 'floor share of the pooled total'}` });
  };
  // 1) known IDs first (Owner: promotion uses the known-ID roster first), in ID order
  let left = c.n;
  const known = bins().flatMap((u) => u.roster.map((r) => ({ u, r }))).sort((a, b) => byStr(a.r.id, b.r.id));
  for (const { u, r } of known) {
    if (left === 0) break;
    u.roster = u.roster.filter((x) => x.id !== r.id);
    extract(u, r.id, r.age, 'roster', null); left--;
  }
  // 2) anonymous members: a recorded draw over the anonymous counts picks the bin; a new ID is minted
  for (let j = 0; left > 0; j++, left--) {
    const pool = bins().filter((u) => anonOf(u) > 0).sort((a, b) => byStr(unitKey(a), unitKey(b)));
    const tot = pool.reduce((a, u) => a + anonOf(u), 0);
    const roll = draw(cx.seed, 'promote', `${cx.day}|${c.key}#${j}`);
    let x = Math.floor(roll * tot), u = pool[0];
    for (const p of pool) { if (x < anonOf(p)) { u = p; break; } x -= anonOf(p); }
    const id = `M.${cx.day}.${c.key}.${j}`;
    if (cx.retired.has(id) || ws.some((w) => idsOf(w).includes(id))) refuse('DUPLICATE_ID', id);
    const anonAge = u.age_sum - u.roster.reduce((a, r) => a + r.age, 0);
    const age = cx.res.age_bin_days === 1 ? u.age : shareSum(anonAge, anonOf(u), 1);
    extract(u, id, age, 'sampled', roll);
  }
  rec(cx, 'promote', c.key, { region: c.region, stage: c.stage, count: c.n, ids: restored.map((r) => r.id).sort(byStr), restored, cause, rng_stream: 'promote' });
  return [...ws, ...out];
}
function demote(cx: Cx, ws: W[], c: Extract<LifeCommand, { kind: 'demote' }>): W[] {
  const cause = needCause(c.cause, 'demote');
  if (isViewCause(cause)) refuse(VIEW_REFUSAL, `${c.key}: a view action cannot demote (issue #144)`);
  const i = ws.find((u) => u.id === c.id) ?? refuse('UNKNOWN_INDIVIDUAL', c.id);
  if (cx.res.age_bin_days !== 1) refuse('ROSTER_NEEDS_DAILY_AGE_BINS', 'known IDs are kept only in daily age bins');
  const bin: W = { region: i.region, stage: i.stage, sub: i.sub, age: i.age, id: null, n: 1, reserve: i.reserve, rkey: cx.res.reserve === 'exact' ? i.reserve : null, age_sum: i.age, roster: [{ id: i.id!, age: i.age }], path: `#${i.id}>bin`, hungry: false };
  rec(cx, 'demote', c.key, { region: i.region, stage: i.stage, count: 1, ids: [i.id!], demoted: { id: i.id!, stage: i.stage, sub: i.sub, age: i.age, reserve: i.reserve }, cause });
  // aggregate exactly into the matching bin now, so later commands of the same day see one pooled bin
  const same = ws.find((u) => u.id === null && unitKey(u) === unitKey(bin));
  if (!same) return [...ws.filter((u) => u !== i), bin];
  same.n += 1; same.reserve += bin.reserve; same.age_sum += bin.age_sum; same.roster = [...same.roster, ...bin.roster];
  return ws.filter((u) => u !== i);
}
function migrate(cx: Cx, ws: W[], c: Extract<LifeCommand, { kind: 'migrate' }>): W[] {
  const cause = needCause(c.cause, 'migrate');
  if (c.to === c.region) refuse('NO_OP_MOVE', c.key);
  const pool = ws.filter((u) => u.region === c.region && u.stage === c.stage && u.n > 0);
  const N = pool.reduce((a, u) => a + u.n, 0);
  if (c.n > N) refuse('INSUFFICIENT_COUNT', `${c.region}/${c.stage} has ${N} < ${c.n}`);
  const ks = choose(cx, pool, c.n, 'migrate', c.key), out: W[] = [];
  let ids: string[] = [], anon = 0, mass = 0, ages = 0;
  pool.forEach((u, j) => {
    const [a, b] = partition(cx, u, ks[j], 'migrate-pick');
    out.push(b);
    if (a.n > 0) { ids = ids.concat(idsOf(a)); anon += anonOf(a); mass += a.reserve; ages += a.age_sum; out.push({ ...a, region: c.to }); }
  });
  rec(cx, 'migration', c.key, {
    region: c.region, stage: c.stage, count: c.n, ids: ids.sort(byStr), anonymous: anon, age_sum: ages, cause, rng_stream: 'migrate',
    effects: [{ region: c.region, stage: c.stage, ledger: 'E', delta: c.n }, { region: c.to, stage: c.stage, ledger: 'I', delta: c.n }],
    mass: [{ from: bodyAcct(c.region, c.stage), to: bodyAcct(c.to, c.stage), amount: mass }],
  });
  return [...ws.filter((u) => !pool.includes(u)), ...nonEmpty(out)];
}

// ---------------------------------------------------------------- the day
const sortW = (ws: W[]) => ws.sort((a, b) => byStr(a.path, b.path));
function toWork(u: Unit): W { return { ...structuredClone(u), path: unitKey(u), hungry: false }; }
function merge(cx: Cx, ws: W[]): Unit[] {
  const m = new Map<string, Unit>();
  for (const w of nonEmpty(ws)) {
    const { path: _p, hungry: _h, ...u } = w;
    const k = unitKey(u), have = m.get(k);
    if (!have) { m.set(k, { ...u, roster: [...u.roster] }); continue; }
    if (u.id !== null) refuse('DUPLICATE_ID', u.id);
    have.n += u.n; have.reserve += u.reserve; have.age_sum += u.age_sum; have.roster.push(...u.roster);
  }
  const out = [...m.values()].sort((a, b) => byStr(unitKey(a), unitKey(b)));
  for (const u of out) u.roster.sort((a, b) => byStr(a.id, b.id));
  if (!cx.res.deterministic) for (const u of out) if (!Number.isSafeInteger(u.n) || !Number.isSafeInteger(u.reserve) || u.reserve < 0) refuse('NOT_INTEGER', unitKey(u));
  return out;
}

/** Advance one day: atomic (works on a copy), canonical order, same rules for every representation. */
export function lifeDay(state: LifeState, P: LifeParams, input: DayInput): { state: LifeState; records: LifeRecord[] } {
  if (state.superseded_by) refuse('SUPERSEDED_BY_UNIFIED_LEDGER', `${state.superseded_by} (#145: one authoritative ledger)`);
  const st = structuredClone(state);
  const cx: Cx = { seed: st.seed, day: st.day, res: st.res, P, recs: [], st, retired: new Set(st.retired), serial: 0 };
  const det = st.res.deterministic;
  const S = P.stages;
  let ws = sortW(st.units.map(toWork));
  // 0. representation and migration commands (canonical: by key)
  const keys = new Set<string>();
  for (const c of [...input.commands].sort((a, b) => byStr(a.key, b.key))) {
    if (keys.has(c.key)) refuse('DUPLICATE_KEY', c.key); keys.add(c.key);
    ws = c.kind === 'promote' ? promote(cx, ws, c) : c.kind === 'demote' ? demote(cx, ws, c) : migrate(cx, ws, c);
  }
  ws = sortW(nonEmpty(ws));
  // 1. inflow from the (scenario) producer into each regional stock
  for (const r of Object.keys(input.inflow).sort(byStr)) {
    const a = input.inflow[r];
    if (!(a >= 0) || (!det && !Number.isSafeInteger(a))) refuse('BAD_AMOUNT', `${r}: ${a}`);
    st.stocks[r] = (st.stocks[r] ?? 0) + a; st.producers[`inflow:${r}`] = (st.producers[`inflow:${r}`] ?? 0) - a;
    rec(cx, 'produce', r, { region: r, mass: [{ from: `producer:inflow:${r}`, to: `stock:${r}`, amount: a }] });
  }
  // 2. feeding: members of feeding stages with room for a meal; meals limited by the regional stock; who eats is uniform
  const after2: W[] = [];
  for (const r of [...new Set(ws.map((u) => u.region))].sort(byStr)) {
    const here = ws.filter((u) => u.region === r);
    const elig = here.filter((u) => canFeed(P, S[u.stage], perReserve(u)));
    const N = elig.reduce((a, u) => a + u.n, 0), stock = st.stocks[r] ?? 0;
    const F = Math.min(N, det ? stock / P.meal : Math.floor(stock / P.meal));
    const ks = choose(cx, elig, F, 'feed', r);
    after2.push(...here.filter((u) => !elig.includes(u)));
    elig.forEach((u, j) => {
      const [a, b] = partition(cx, u, ks[j], 'feed-pick');
      after2.push(b);
      if (a.n > 0) {
        const amt = a.n * P.meal;
        a.reserve += amt; if (a.rkey !== null) a.rkey += P.meal; st.stocks[r] -= amt;
        rec(cx, 'feed', a.path, { region: r, stage: a.stage, count: a.n, ids: idsOf(a), anonymous: anonOf(a), mass: [{ from: `stock:${r}`, to: bodyAcct(r, a.stage), amount: amt }] });
        after2.push(a);
      }
    });
  }
  ws = sortW(nonEmpty(after2));
  // 3. maintenance burn; a member that cannot cover it is hungry (pooled bins: equal-share assumption)
  for (const u of ws) {
    if (!S[u.stage].feeds) continue;
    let amt: number;
    if (u.id !== null || u.rkey !== null) {
      const r = perReserve(u), b = Math.min(r, P.burn);
      u.hungry = r < P.burn; amt = u.n * b; if (u.rkey !== null) u.rkey -= b;
    } else if (u.reserve >= u.n * P.burn) { u.hungry = false; amt = u.n * P.burn; } else { u.hungry = true; amt = u.reserve; }
    u.reserve -= amt; st.sinks.respiration = (st.sinks.respiration ?? 0) + amt;
    rec(cx, 'burn', u.path, { region: u.region, stage: u.stage, count: u.n, hungry: u.hungry, mass: [{ from: bodyAcct(u.region, u.stage), to: 'sink:respiration', amount: amt }] });
  }
  // 4. reproduction: a fed reproductive member with reserve >= egg_cost lays one egg with probability p_lay
  const born: W[] = [], after4: W[] = [];
  for (const u of ws) {
    if (!canLay(P, S[u.stage], u.hungry, perReserve(u))) { after4.push(u); continue; }
    const L = binom(cx, u.n, P.p_lay, 'lay', u.path);
    const [a, b] = partition(cx, u, L, 'lay-pick');
    after4.push(b);
    if (a.n <= 0) continue;
    a.reserve -= a.n * P.egg_cost; if (a.rkey !== null) a.rkey -= P.egg_cost;
    after4.push(a);
    let baby: W, ids: string[] = [];
    if (a.id !== null && st.res.newborn === 'follow_parent') {
      const id = `B.${cx.day}.${a.id}`;
      if (cx.retired.has(id) || ws.some((w) => idsOf(w).includes(id))) refuse('DUPLICATE_ID', id);
      baby = { region: a.region, stage: 0, sub: 0, age: 0, id, n: 1, reserve: P.egg_cost, rkey: null, age_sum: 0, roster: [], path: `#${id}`, hungry: false };
      ids = [id];
    } else {
      baby = { region: a.region, stage: 0, sub: 0, age: 0, id: null, n: a.n, reserve: a.n * P.egg_cost, rkey: st.res.reserve === 'exact' && !det ? P.egg_cost : null, age_sum: 0, roster: [], path: `${a.path}>egg`, hungry: false };
    }
    born.push(baby);
    rec(cx, 'birth', a.path, {
      region: a.region, stage: 0, count: a.n, ids, anonymous: ids.length ? 0 : a.n, age_sum: 0, rng_stream: 'lay',
      effects: [{ region: a.region, stage: 0, ledger: 'B', delta: a.n }], mass: [{ from: bodyAcct(a.region, a.stage), to: bodyAcct(a.region, 0), amount: a.n * P.egg_cost }],
    });
  }
  ws = sortW([...nonEmpty(after4), ...born]);
  // 5. development: Erlang sub-stages driven by degree-days and nutrition
  const after5: W[] = [];
  for (const u of ws) {
    const sd = S[u.stage];
    if (sd.substages === 0 || sd.dd_required === null) { after5.push(u); continue; }
    const k = binom(cx, u.n, devProb(P, sd, input.temp_c, u.hungry), 'develop', u.path);
    const [a, b] = partition(cx, u, k, 'develop-pick');
    after5.push(b);
    if (a.n <= 0) continue;
    if (a.sub + 1 < sd.substages) {
      a.sub += 1;
      rec(cx, 'develop', a.path, { region: a.region, stage: a.stage, count: a.n, ids: idsOf(a), anonymous: anonOf(a), rng_stream: 'develop' });
    } else {
      rec(cx, 'transition', a.path, {
        region: a.region, stage: a.stage + 1, count: a.n, ids: idsOf(a), anonymous: anonOf(a), age_sum: a.age_sum, rng_stream: 'develop',
        effects: [{ region: a.region, stage: a.stage, ledger: 'To', delta: a.n }, { region: a.region, stage: a.stage + 1, ledger: 'Ti', delta: a.n }],
        mass: [{ from: bodyAcct(a.region, a.stage), to: bodyAcct(a.region, a.stage + 1), amount: a.reserve }],
      });
      a.stage += 1; a.sub = 0;
    }
    after5.push(a);
  }
  ws = sortW(nonEmpty(after5));
  // 6. mortality: baseline + starvation + senescence; the body stays in the region as a corpse account
  const after6: W[] = [];
  for (const u of ws) {
    const sd = S[u.stage];
    const k = binom(cx, u.n, hazardOf(P, sd, u.hungry, perAge(cx, u)), 'death', u.path);
    const [a, b] = partition(cx, u, k, 'death-pick');
    after6.push(b);
    if (a.n <= 0) continue;
    for (const id of idsOf(a)) cx.retired.add(id);
    st.corpses[a.region] = (st.corpses[a.region] ?? 0) + a.reserve;
    rec(cx, 'death', a.path, {
      region: a.region, stage: a.stage, count: a.n, ids: idsOf(a), anonymous: anonOf(a), age_sum: a.age_sum, hungry: a.hungry, rng_stream: 'death',
      effects: [{ region: a.region, stage: a.stage, ledger: 'D', delta: a.n }], mass: [{ from: bodyAcct(a.region, a.stage), to: `corpse:${a.region}`, amount: a.reserve }],
    });
  }
  ws = sortW(nonEmpty(after6));
  // 7. aging: every living member is one day older (individuals, roster members and anonymous members alike)
  const before = ws.reduce((a, u) => a + u.age_sum, 0), count = ws.reduce((a, u) => a + u.n, 0);
  const after7: W[] = [];
  for (const u of ws) {
    u.age_sum += u.n;
    u.roster = u.roster.map((r) => ({ id: r.id, age: r.age + 1 }));
    if (u.id !== null || st.res.age_bin_days === 1) { u.age += 1; after7.push(u); continue; }
    // wider bins: each anonymous member leaves its bin with probability 1/W (Lefkovitch-type class transition)
    const k = binom(cx, u.n, 1 / st.res.age_bin_days, 'age-bin', u.path);
    const [a, b] = partition(cx, u, k, 'age-bin-pick');
    a.age += 1;
    after7.push(a, b);
  }
  rec(cx, 'aging', 'all', { count, aging: { count, age_sum_before: before, age_sum_after: before + count } });
  // 8. merge identical anonymous bins; export with sorted arrays
  st.units = merge(cx, after7);
  st.retired = [...cx.retired].sort(byStr);
  st.day += 1;
  return { state: st, records: cx.recs };
}

// ---------------------------------------------------------------- statistics (observer side; never an input to any rule)
export interface CohortStats { n: number; by_stage: number[]; age_hist: Record<string, number>; reserve_mean: number | null; reserve_var_within_bins: 'unknown (pooled)' | number; known_ids: number }
export function stats(st: LifeState, nStages: number): CohortStats {
  const by = Array.from({ length: nStages }, () => 0), hist: Record<string, number> = {};
  let n = 0, res = 0, sq = 0, pooled = false, ids = 0;
  for (const u of st.units) {
    n += u.n; by[u.stage] += u.n; res += u.reserve; ids += idsOf(u).length;
    const k = String(u.age); hist[k] = (hist[k] ?? 0) + u.n;
    if (u.id === null && u.rkey === null) pooled = true; else sq += u.n * perReserve(u) ** 2;
  }
  const mean = n > 0 ? res / n : null;
  return { n, by_stage: by, age_hist: hist, reserve_mean: mean, reserve_var_within_bins: pooled ? 'unknown (pooled)' : n > 0 ? sq / n - (mean ?? 0) ** 2 : 0, known_ids: ids };
}
