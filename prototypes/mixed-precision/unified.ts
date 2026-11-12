/**
 * OD-1 v2 UNIFIED LEDGER (isolated prototype; not imported by engine/, cli/ or web/; not a rules version).
 * Design: docs/od1c-unified-ledger-camera-invariance.md. Owner decisions 2026-11-08: issue #144 (the camera must not
 * change any fate; distribution-only equality is not accepted) and issue #145 (one authoritative ledger; stable IDs and
 * cohort identities; stage is a field; exact is the default precision; known IDs keep exact age next to coarse bins).
 *
 * Representation:
 *   - every living organism is a MEMBER with a stable ID: a known ID, or a latent ID `<cohort_id>#<ordinal>` that is
 *     fixed when the member is created (birth, initial fixture, migration) and never depends on how it is stored;
 *   - a COHORT is a stable identity (birth cohort: taxon, colony, origin event). Its ID never encodes the stage, the
 *     region or any other mutable field; stage changes are recorded `transition` events;
 *   - a GROUP is a storage row: members of one cohort with identical authoritative state (region, stage, Erlang
 *     sub-stage, age mode, age, exact reserve). Grouping is only compression: every rule acts per member, and every
 *     draw is keyed by (seed, process, day, member ID), so any split or merge of groups gives the same outcome;
 *   - the VIEW (`view.individual`, which members the observer shows as individuals) is player-side state: no rule reads
 *     it. A view promote/demote only moves a member between "shown as an individual" and "shown in its cohort"; it
 *     never changes an authoritative field, a draw or a record (issue #144 invariant, tests C1-C4);
 *   - precision: reserve is always exact (pooled reserve is refused: #145 item 11, the reserve-histogram option is a
 *     separate study). Age is exact for known IDs and for colonies in `exact_age_colonies`; other members may use
 *     coarse age bins (#145 item 14). The observer cannot change a member's precision (VIEW_CANNOT_CHANGE_PRECISION).
 * Records use the OD-1 names (event_id, ledger_effects, food_moves, identity, cause) and are aggregated by the
 * pre-event authoritative state, so they too are independent of grouping and of the view.
 * The life rules come from lifetime.ts (canFeed, devProb, canLay, hazardOf): lifetime.ts computes, this module books.
 * This module holds NO biological value: every rate/amount is an input.
 */
import { draw } from './ledger.ts';
import { canFeed, devProb, canLay, hazardOf, type LifeParams } from './lifetime.ts';
import { isViewCause } from './view-guard.ts';
import { compress, expand, cmpId, latentId, sizeOf, type MemberSet } from './members.ts';

export interface CohortIdentity {
  cohort_id: string; taxon: string; colony_id: string | null;
  origin: { kind: 'initial' | 'birth' | 'migrated_od1' | 'migrated_lifetime'; event_id: string | null; legacy_id: string | null };
}
export type AgeMode = 'exact' | 'bin';
export interface Group {
  cohort_id: string; region: string; stage: number; sub: number;
  /** 'exact': age in days; 'bin': coarse age-bin index (bin width = precision.age_bin_days) */
  age_mode: AgeMode; age: number;
  /** exact reserve of EACH member (integer game units) */
  reserve: number;
  members: MemberSet;
}
export interface Precision { reserve: 'exact'; age_bin_days: number; exact_age_colonies: string[] }
export interface UState {
  schema: 'antempire.wp5-unified-ledger.v2'; authoritative: true;
  seed: string; day: number; precision: Precision;
  cohorts: CohortIdentity[]; groups: Group[];
  /** edible food by region */
  stocks: Record<string, number>;
  /** non-edible stocks carried over from OD-1 v1 (corpses, ...): kept, not used by these rules */
  inert_stocks: Record<string, { region: string; amount: number; origin_event_id: string | null }>;
  sinks: Record<string, number>; corpses: Record<string, number>; producers: Record<string, number>;
  retired: MemberSet;
  migrated_from: { schema: string; fingerprint: string; alias: Record<string, string> }[];
  /** PLAYER VIEW (non-authoritative; 玩家視角): members shown as individuals. No rule reads it. */
  view: { individual: MemberSet };
}
export interface Cause { kind: string; driver_event_ids: string[] }
export interface MigrateCmd { kind: 'migrate'; key: string; region: string; stage: number; n: number; to: string; cause: Cause }
export interface UDayInput { temp_c: number; inflow: Record<string, number>; natural: MigrateCmd[] }
export interface ViewOp { op: 'promote' | 'demote'; id: string }

export type ULedger = 'B' | 'D' | 'I' | 'E' | 'Ti' | 'To';
export interface UEffect { region: string; taxon: string; stage: number; colony_id: string | null; ledger: ULedger; delta: number }
export interface UMove { from: string; to: string; amount: number; cause: string }
export type UKind = 'produce' | 'feed' | 'burn' | 'birth' | 'develop' | 'transition' | 'death' | 'aging' | 'age_bin' | 'migration' | 'legacy_migration';
export interface URecord {
  event_id: string; kind: UKind;
  t: { day: number; minute: null; time_resolution: 'day' };
  cohort_id: string | null; region: string | null; stage: number | null;
  identity: { action: 'born' | 'retired' | 'kept' | 'none' | 'migrated'; members: MemberSet; count: number };
  ledger_effects: UEffect[]; food_moves: UMove[];
  cause: { kind: string; driver_event_ids: string[]; rule_id: string; rng_stream: string | null };
  parents: MemberSet | null;
  stage_change: { from: number; to: number } | null;
  note: string | null;
}
export class URefusal extends Error {
  code: string;
  constructor(code: string, msg: string) { super(`${code}: ${msg}`); this.code = code; }
}
const refuse = (code: string, msg: string): never => { throw new URefusal(code, msg); };
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export const SCHEMA = 'antempire.wp5-unified-ledger.v2' as const;
/** #145 item 11: exact is the default and the only authoritative reserve precision; daily (exact) ages by default */
export const defaultPrecision = (): Precision => ({ reserve: 'exact', age_bin_days: 1, exact_age_colonies: [] });
export const bodyAcct = (region: string, stage: number) => `body:${region}:${stage}`;
export const groupKey = (g: Omit<Group, 'members'>) => `${g.cohort_id}|${g.region}|${g.stage}|${g.sub}|${g.age_mode}|${g.age}|${g.reserve}`;

// ---------------------------------------------------------------- normal form (grouping is compression only)
export function normalizeGroups(groups: { g: Omit<Group, 'members'>; ids: string[] }[]): Group[] {
  const m = new Map<string, { g: Omit<Group, 'members'>; ids: string[] }>();
  for (const x of groups) {
    if (x.ids.length === 0) continue;
    const k = groupKey(x.g), have = m.get(k);
    if (have) have.ids.push(...x.ids); else m.set(k, { g: { ...x.g }, ids: [...x.ids] });
  }
  return [...m.entries()].sort((a, b) => byStr(a[0], b[0])).map(([, x]) => ({ ...x.g, members: compress(x.ids) }));
}
/** the authoritative part of a state: everything except the player view (what the #144 invariant compares) */
export function authoritative(st: UState): Omit<UState, 'view'> { const { view: _v, ...a } = st; return a; }
export function aliveIds(st: UState): string[] { return st.groups.flatMap((g) => expand(g.members)); }

function checkState(st: UState): void {
  if (st.schema !== SCHEMA || st.authoritative !== true) refuse('NOT_UNIFIED_STATE', `schema ${st.schema}`);
  if (st.precision.reserve !== 'exact') refuse('PRECISION_POOLED_NOT_AUTHORITATIVE', 'pooled reserve is not an authoritative precision (#145 item 11)');
  if (!Number.isSafeInteger(st.precision.age_bin_days) || st.precision.age_bin_days < 1) refuse('BAD_PRECISION', `age_bin_days ${st.precision.age_bin_days}`);
  const reg = new Set(st.cohorts.map((c) => c.cohort_id));
  if (reg.size !== st.cohorts.length) refuse('DUPLICATE_COHORT', 'cohort registry');
  for (const g of st.groups) if (!reg.has(g.cohort_id)) refuse('UNKNOWN_COHORT', g.cohort_id);
}
/** members of colonies in exact_age_colonies always have exact age; other new members follow the bin width */
const newAgeMode = (st: UState, colony: string | null): AgeMode =>
  st.precision.age_bin_days === 1 || (colony !== null && st.precision.exact_age_colonies.includes(colony)) ? 'exact' : 'bin';

// ---------------------------------------------------------------- player view (never authoritative)
/**
 * Apply observer actions. Only `view` changes; authoritative fields are returned untouched (same values). A member is
 * shown as an individual only if it already has exact state: a coarse-age member would need an age that does not exist,
 * so the view may not raise its precision (VIEW_CANNOT_CHANGE_PRECISION).
 */
export function applyView(st: UState, ops: ViewOp[]): UState {
  checkState(st);
  const out = structuredClone(st);
  const shown = new Set(expand(out.view.individual));
  const where = new Map<string, Group>();
  for (const g of out.groups) for (const id of expand(g.members)) where.set(id, g);
  for (const o of ops) {
    const g = where.get(o.id) ?? refuse('VIEW_UNKNOWN_MEMBER', `${o.id} is not a living member`);
    if (o.op === 'promote') {
      if (g.age_mode !== 'exact') refuse('VIEW_CANNOT_CHANGE_PRECISION', `${o.id} has a coarse age bin; the view cannot create an exact age (#144 fallback)`);
      shown.add(o.id);
    } else {
      if (!shown.has(o.id)) refuse('VIEW_NOT_PROMOTED', o.id);
      shown.delete(o.id);
    }
  }
  out.view = { individual: compress(shown) };
  return out;
}

// ---------------------------------------------------------------- the day
interface W { g: Omit<Group, 'members'>; ids: string[]; hungry: boolean; repr: 'individual' | 'cohort' }
interface Acc { rec: URecord; ids: string[]; parents: string[]; moves: Map<string, UMove>; effects: Map<string, UEffect> }
interface Cx { st: UState; P: LifeParams; day: number; seed: string; acc: Map<string, Acc>; reg: Map<string, CohortIdentity> }

/** one draw for one member in one process on one day: identical whether the member is stored alone or in a group */
const memberDraw = (cx: Cx, process: string, id: string, extra = '') => draw(cx.seed, process, `${cx.day}|${extra}${id}`);

function acc(cx: Cx, kind: UKind, key: string, init: Partial<URecord>): Acc {
  const event_id = `${cx.day}.${kind}.${key}`;
  let a = cx.acc.get(event_id);
  if (!a) {
    a = { rec: { event_id, kind, t: { day: cx.day, minute: null, time_resolution: 'day' }, cohort_id: null, region: null, stage: null,
      identity: { action: 'none', members: [], count: 0 }, ledger_effects: [], food_moves: [], cause: { kind, driver_event_ids: [], rule_id: `od1v2.${kind}`, rng_stream: null },
      parents: null, stage_change: null, note: null, ...init }, ids: [], parents: [], moves: new Map(), effects: new Map() };
    cx.acc.set(event_id, a);
  }
  return a;
}
function addMove(a: Acc, from: string, to: string, amount: number, cause: string) {
  const k = `${from}>${to}>${cause}`, m = a.moves.get(k);
  if (m) m.amount += amount; else a.moves.set(k, { from, to, amount, cause });
}
function addEffect(cx: Cx, a: Acc, cohort: string, region: string, stage: number, ledger: ULedger, delta: number) {
  const c = cx.reg.get(cohort)!;
  const k = `${region}|${c.taxon}|${stage}|${c.colony_id ?? '-'}|${ledger}`, e = a.effects.get(k);
  if (e) e.delta += delta; else a.effects.set(k, { region, taxon: c.taxon, stage, colony_id: c.colony_id, ledger, delta });
}
function finish(cx: Cx): URecord[] {
  return [...cx.acc.values()].map((a) => {
    const r = a.rec;
    r.identity = { ...r.identity, members: compress(a.ids), count: a.ids.length };
    if (a.parents.length) r.parents = compress(a.parents);
    r.food_moves = [...a.moves.values()].filter((m) => m.amount !== 0).sort((x, y) => byStr(`${x.from}>${x.to}>${x.cause}`, `${y.from}>${y.to}>${y.cause}`));
    r.ledger_effects = [...a.effects.values()].sort((x, y) => byStr(`${x.region}|${x.taxon}|${x.stage}|${x.colony_id}|${x.ledger}`, `${y.region}|${y.taxon}|${y.stage}|${y.colony_id}|${y.ledger}`));
    return r;
  }).sort((x, y) => byStr(x.event_id, y.event_id));
}
/** split one work group by a per-member predicate (member order inside a group never matters) */
function split(w: W, pick: (id: string) => boolean): [W, W] {
  const a: string[] = [], b: string[] = [];
  for (const id of w.ids) (pick(id) ? a : b).push(id);
  return [{ ...w, g: { ...w.g }, ids: a }, { ...w, g: { ...w.g }, ids: b }];
}
const nonEmpty = (ws: W[]) => ws.filter((w) => w.ids.length > 0);
/** storage layout for the step: members shown by the observer are stored as singleton groups (the 'individual'
 *  representation), the rest as pooled groups. Rules below never read `repr`; it only changes the layout. */
function materialize(st: UState): W[] {
  const shown = new Set(expand(st.view.individual)), out: W[] = [];
  for (const g of st.groups) {
    const { members: _m, ...gg } = g, pooled: string[] = [];
    for (const id of expand(g.members)) {
      if (shown.has(id)) out.push({ g: { ...gg }, ids: [id], hungry: false, repr: 'individual' }); else pooled.push(id);
    }
    if (pooled.length) out.push({ g: { ...gg }, ids: pooled, hungry: false, repr: 'cohort' });
  }
  return out;
}
/** rank members by a named per-member draw (ties by ID): the first k are chosen; independent of grouping */
function rankPick(cx: Cx, ids: string[], k: number, process: string, extra: string): Set<string> {
  const keyed = ids.map((id) => ({ id, u: memberDraw(cx, process, id, extra) }));
  keyed.sort((x, y) => x.u - y.u || cmpId(x.id, y.id));
  return new Set(keyed.slice(0, k).map((x) => x.id));
}

/**
 * Advance one day (atomic: works on a copy). `layout` is a test hook that re-splits the storage arbitrarily before the
 * step; the result must not depend on it (tests C3).
 */
export function unifiedDay(state: UState, P: LifeParams, input: UDayInput, layout?: (ws: { ids: string[] }[]) => string[][]): { state: UState; records: URecord[] } {
  checkState(state);
  const st = structuredClone(state);
  const cx: Cx = { st, P, day: st.day, seed: st.seed, acc: new Map(), reg: new Map(st.cohorts.map((c) => [c.cohort_id, c])) };
  const S = P.stages;
  let ws = materialize(st);
  if (layout) ws = ws.flatMap((w) => layout([w]).map((ids) => ({ ...w, g: { ...w.g }, ids })));
  for (const w of ws) if (w.g.stage < 0 || w.g.stage >= S.length) refuse('UNKNOWN_STAGE', `${w.g.stage}`);

  // 0. natural migrations (inputs; canonical order by key). Who leaves: the n lowest per-member draws.
  const keys = new Set<string>();
  for (const c of [...input.natural].sort((a, b) => byStr(a.key, b.key))) {
    if (keys.has(c.key)) refuse('DUPLICATE_KEY', c.key); keys.add(c.key);
    if (!c.cause || !c.cause.kind || !c.cause.driver_event_ids?.length) refuse('NO_CAUSE', `${c.key} needs a cause with driver event ids`);
    if (isViewCause(c.cause)) refuse('VIEW_IS_NOT_A_NATURAL_EVENT', `${c.key}: the observer cannot move organisms`);
    if (c.to === c.region) refuse('NO_OP_MOVE', c.key);
    const pool = ws.filter((w) => w.g.region === c.region && w.g.stage === c.stage);
    const all = pool.flatMap((w) => w.ids);
    if (!Number.isSafeInteger(c.n) || c.n < 1 || c.n > all.length) refuse('INSUFFICIENT_COUNT', `${c.region}/${c.stage} has ${all.length}, asked ${c.n}`);
    const chosen = rankPick(cx, all, c.n, 'migrate', `${c.key}|`);
    const next: W[] = ws.filter((w) => !pool.includes(w));
    for (const w of pool) {
      const [go, stay] = split(w, (id) => chosen.has(id));
      next.push(stay);
      if (!go.ids.length) continue;
      const a = acc(cx, 'migration', `${c.key}|${groupKey(w.g)}`, { cohort_id: w.g.cohort_id, region: c.region, stage: w.g.stage, identity: { action: 'kept', members: [], count: 0 },
        cause: { kind: c.cause.kind, driver_event_ids: [...c.cause.driver_event_ids], rule_id: 'od1v2.migrate', rng_stream: 'migrate' } });
      a.ids.push(...go.ids);
      addEffect(cx, a, w.g.cohort_id, c.region, w.g.stage, 'E', go.ids.length);
      addEffect(cx, a, w.g.cohort_id, c.to, w.g.stage, 'I', go.ids.length);
      addMove(a, bodyAcct(c.region, w.g.stage), bodyAcct(c.to, w.g.stage), go.ids.length * w.g.reserve, 'migration');
      go.g.region = c.to; next.push(go);
    }
    ws = nonEmpty(next);
  }
  // 1. inflow from the scenario producer into each regional stock (input)
  for (const r of Object.keys(input.inflow).sort(byStr)) {
    const amt = input.inflow[r];
    if (!Number.isSafeInteger(amt) || amt < 0) refuse('BAD_AMOUNT', `${r}: ${amt}`);
    st.stocks[r] = (st.stocks[r] ?? 0) + amt; st.producers[`inflow:${r}`] = (st.producers[`inflow:${r}`] ?? 0) - amt;
    const a = acc(cx, 'produce', r, { region: r, note: 'inflow amount is a scenario input (free_input)' });
    addMove(a, `producer:inflow:${r}`, `stock:${r}`, amt, 'production');
  }
  // 2. feeding: eligible members of each region; meals limited by the stock; eaters = lowest per-member 'feed' draws
  {
    const next: W[] = [];
    const regions = [...new Set(ws.map((w) => w.g.region))].sort(byStr);
    for (const r of regions) {
      const here = ws.filter((w) => w.g.region === r);
      const elig = here.filter((w) => canFeed(P, S[w.g.stage], w.g.reserve));
      next.push(...here.filter((w) => !elig.includes(w)));
      const all = elig.flatMap((w) => w.ids), stock = st.stocks[r] ?? 0;
      const F = Math.min(all.length, Math.floor(stock / P.meal));
      const eaters = rankPick(cx, all, F, 'feed', `${r}|`);
      for (const w of elig) {
        const [eat, rest] = split(w, (id) => eaters.has(id));
        next.push(rest);
        if (!eat.ids.length) continue;
        const a = acc(cx, 'feed', groupKey(w.g), { cohort_id: w.g.cohort_id, region: r, stage: w.g.stage, identity: { action: 'kept', members: [], count: 0 }, cause: { kind: 'feed', driver_event_ids: [], rule_id: 'od1v2.feed', rng_stream: 'feed' } });
        a.ids.push(...eat.ids);
        addMove(a, `stock:${r}`, bodyAcct(r, w.g.stage), eat.ids.length * P.meal, 'meal');
        st.stocks[r] -= eat.ids.length * P.meal;
        eat.g.reserve += P.meal; next.push(eat);
      }
    }
    ws = nonEmpty(next);
  }
  // 3. maintenance burn (per member; a member that cannot cover it is hungry today)
  for (const w of ws) {
    if (!S[w.g.stage].feeds) continue;
    const b = Math.min(w.g.reserve, P.burn);
    const a = acc(cx, 'burn', groupKey(w.g), { cohort_id: w.g.cohort_id, region: w.g.region, stage: w.g.stage, identity: { action: 'kept', members: [], count: 0 } });
    a.ids.push(...w.ids);
    addMove(a, bodyAcct(w.g.region, w.g.stage), 'sink:respiration', w.ids.length * b, 'maintenance');
    st.sinks.respiration = (st.sinks.respiration ?? 0) + w.ids.length * b;
    w.hungry = w.g.reserve < P.burn; w.g.reserve -= b;
  }
  // 4. reproduction: each eligible member lays one egg with p_lay (per-member draw); eggs get latent IDs in the birth
  //    cohort of (day, region, taxon, colony), ordinals by parent ID order (independent of grouping)
  {
    const layers: { id: string; w: W }[] = [], next: W[] = [];
    for (const w of ws) {
      if (!canLay(P, S[w.g.stage], w.hungry, w.g.reserve)) { next.push(w); continue; }
      const [lay, rest] = split(w, (id) => memberDraw(cx, 'lay', id) < P.p_lay);
      next.push(rest);
      if (!lay.ids.length) continue;
      for (const id of lay.ids) layers.push({ id, w });
      lay.g.reserve -= P.egg_cost; next.push(lay);
    }
    const byCohort = new Map<string, { id: string; w: W }[]>();
    for (const l of layers) {
      const c = cx.reg.get(l.w.g.cohort_id)!;
      for (const s of [l.w.g.region, c.taxon, c.colony_id ?? '-']) if (s.includes('#') || s.includes('|')) refuse('BAD_ID', s);
      const k = `K.${cx.day}.${l.w.g.region}.${c.taxon}.${c.colony_id ?? '-'}`;
      (byCohort.get(k) ?? byCohort.set(k, []).get(k)!).push(l);
    }
    for (const [k, ls] of [...byCohort.entries()].sort((a, b) => byStr(a[0], b[0]))) {
      if (cx.reg.has(k)) refuse('DUPLICATE_COHORT', k);
      const p0 = cx.reg.get(ls[0].w.g.cohort_id)!;
      const ev = `${cx.day}.birth.${k}`;
      const ident: CohortIdentity = { cohort_id: k, taxon: p0.taxon, colony_id: p0.colony_id, origin: { kind: 'birth', event_id: ev, legacy_id: null } };
      cx.reg.set(k, ident); st.cohorts.push(ident);
      ls.sort((a, b) => cmpId(a.id, b.id));
      const region = ls[0].w.g.region;
      const eggs = ls.map((_, j) => latentId(k, j));
      const a = acc(cx, 'birth', k, { cohort_id: k, region, stage: 0, identity: { action: 'born', members: [], count: 0 }, cause: { kind: 'birth', driver_event_ids: [], rule_id: 'od1v2.birth', rng_stream: 'lay' } });
      a.ids.push(...eggs); a.parents.push(...ls.map((l) => l.id));
      addEffect(cx, a, k, region, 0, 'B', eggs.length);
      for (const l of ls) addMove(a, bodyAcct(region, l.w.g.stage), bodyAcct(region, 0), P.egg_cost, 'egg_provisioning');
      next.push({ g: { cohort_id: k, region, stage: 0, sub: 0, age_mode: newAgeMode(st, p0.colony_id), age: 0, reserve: P.egg_cost }, ids: eggs, hungry: false, repr: 'cohort' });
    }
    ws = nonEmpty(next);
  }
  // 5. development: Erlang sub-stages; per-member draw against devProb; the last sub-stage is a recorded transition
  {
    const next: W[] = [];
    for (const w of ws) {
      const sd = S[w.g.stage];
      if (sd.substages === 0 || sd.dd_required === null) { next.push(w); continue; }
      const p = devProb(P, sd, input.temp_c, w.hungry);
      const [adv, rest] = split(w, (id) => p >= 1 || (p > 0 && memberDraw(cx, 'develop', id) < p));
      next.push(rest);
      if (!adv.ids.length) continue;
      if (w.g.sub + 1 < sd.substages) {
        const a = acc(cx, 'develop', groupKey(w.g), { cohort_id: w.g.cohort_id, region: w.g.region, stage: w.g.stage, identity: { action: 'kept', members: [], count: 0 }, cause: { kind: 'develop', driver_event_ids: [], rule_id: 'od1v2.develop', rng_stream: 'develop' } });
        a.ids.push(...adv.ids); adv.g.sub += 1;
      } else {
        const a = acc(cx, 'transition', groupKey(w.g), { cohort_id: w.g.cohort_id, region: w.g.region, stage: w.g.stage + 1, identity: { action: 'kept', members: [], count: 0 }, stage_change: { from: w.g.stage, to: w.g.stage + 1 }, cause: { kind: 'develop', driver_event_ids: [], rule_id: 'od1v2.transition', rng_stream: 'develop' } });
        a.ids.push(...adv.ids);
        addEffect(cx, a, w.g.cohort_id, w.g.region, w.g.stage, 'To', adv.ids.length);
        addEffect(cx, a, w.g.cohort_id, w.g.region, w.g.stage + 1, 'Ti', adv.ids.length);
        addMove(a, bodyAcct(w.g.region, w.g.stage), bodyAcct(w.g.region, w.g.stage + 1), adv.ids.length * w.g.reserve, 'stage_transition');
        adv.g.stage += 1; adv.g.sub = 0;
      }
      next.push(adv);
    }
    ws = nonEmpty(next);
  }
  // 6. mortality: per-member draw against hazardOf; coarse-age members use the bin midpoint (an approximation whose
  //    error is measured, unified-compare.ts); the body stays in the region as a corpse account; the ID retires
  const died: string[] = [];
  {
    const W_ = st.precision.age_bin_days, next: W[] = [];
    for (const w of ws) {
      const sd = S[w.g.stage];
      const age = w.g.age_mode === 'exact' ? w.g.age : w.g.age * W_ + (W_ - 1) / 2;
      const h = hazardOf(P, sd, w.hungry, age);
      const [die, live] = split(w, (id) => h >= 1 || (h > 0 && memberDraw(cx, 'death', id) < h));
      next.push(live);
      if (!die.ids.length) continue;
      const a = acc(cx, 'death', `${groupKey(w.g)}|${w.hungry ? 'hungry' : 'fed'}`, { cohort_id: w.g.cohort_id, region: w.g.region, stage: w.g.stage, identity: { action: 'retired', members: [], count: 0 },
        cause: { kind: w.hungry ? 'death.hungry' : 'death', driver_event_ids: [], rule_id: 'od1v2.death', rng_stream: 'death' } });
      a.ids.push(...die.ids); died.push(...die.ids);
      addEffect(cx, a, w.g.cohort_id, w.g.region, w.g.stage, 'D', die.ids.length);
      addMove(a, bodyAcct(w.g.region, w.g.stage), `corpse:${w.g.region}`, die.ids.length * w.g.reserve, 'death_body_to_corpse');
      st.corpses[w.g.region] = (st.corpses[w.g.region] ?? 0) + die.ids.length * w.g.reserve;
    }
    ws = nonEmpty(next);
  }
  // 7. aging: every living member is one day older (exact), or leaves its coarse bin with probability 1/W (per member)
  {
    const W_ = st.precision.age_bin_days, next: W[] = [];
    let count = 0;
    for (const w of ws) {
      count += w.ids.length;
      if (w.g.age_mode === 'exact') { w.g.age += 1; next.push(w); continue; }
      const [up, stay] = split(w, (id) => memberDraw(cx, 'age-bin', id) < 1 / W_);
      next.push(stay);
      if (!up.ids.length) continue;
      const a = acc(cx, 'age_bin', groupKey(w.g), { cohort_id: w.g.cohort_id, region: w.g.region, stage: w.g.stage, identity: { action: 'kept', members: [], count: 0 }, cause: { kind: 'aging', driver_event_ids: [], rule_id: 'od1v2.age_bin', rng_stream: 'age-bin' } });
      a.ids.push(...up.ids); up.g.age += 1; next.push(up);
    }
    acc(cx, 'aging', 'all', { note: 'every living member is one day older (exact) or took its coarse-bin draw' });
    ws = next;
    const recs = finish(cx);
    // the aging record lists no IDs (all living members): its count is the number of members it aged
    const ag = recs.find((r) => r.kind === 'aging')!; ag.identity = { action: 'kept', members: [], count };
    st.groups = normalizeGroups(ws.map((w) => ({ g: w.g, ids: w.ids })));
    st.cohorts.sort((x, y) => byStr(x.cohort_id, y.cohort_id));
    st.retired = compress([...expand(st.retired), ...died]);
    const alive = new Set(aliveIds(st));
    st.view = { individual: compress(expand(st.view.individual).filter((id) => alive.has(id))) };
    st.day += 1;
    return { state: st, records: recs };
  }
}

// ---------------------------------------------------------------- construction helpers
export interface InitGroup { cohort: string; taxon: string; colony_id: string | null; region: string; stage: number; count: number; age: number; reserve: number; known?: string[] }
/** build an initial state: `count` members per entry, known IDs first (exact age), the rest latent `<cohort>#k` */
export function initialUnified(seed: string, groups: InitGroup[], precision: Precision = defaultPrecision(), stocks: Record<string, number> = {}): UState {
  const st: UState = { schema: SCHEMA, authoritative: true, seed, day: 1, precision, cohorts: [], groups: [], stocks: { ...stocks }, inert_stocks: {}, sinks: {}, corpses: {}, producers: {}, retired: [], migrated_from: [], view: { individual: [] } };
  const rows: { g: Omit<Group, 'members'>; ids: string[] }[] = [];
  for (const x of groups) {
    if (!st.cohorts.some((c) => c.cohort_id === x.cohort)) st.cohorts.push({ cohort_id: x.cohort, taxon: x.taxon, colony_id: x.colony_id, origin: { kind: 'initial', event_id: null, legacy_id: null } });
    const known = x.known ?? [];
    if (known.length) rows.push({ g: { cohort_id: x.cohort, region: x.region, stage: x.stage, sub: 0, age_mode: 'exact', age: x.age, reserve: x.reserve }, ids: [...known] });
    const anon = x.count - known.length, mode = newAgeMode(st, x.colony_id);
    const start = rows.filter((r) => r.g.cohort_id === x.cohort).reduce((a, r) => a + r.ids.filter((id) => id.startsWith(`${x.cohort}#`)).length, 0);
    rows.push({ g: { cohort_id: x.cohort, region: x.region, stage: x.stage, sub: 0, age_mode: mode, age: mode === 'exact' ? x.age : Math.floor(x.age / precision.age_bin_days), reserve: x.reserve },
      ids: Array.from({ length: anon }, (_, j) => latentId(x.cohort, start + j)) });
  }
  st.cohorts.sort((a, b) => byStr(a.cohort_id, b.cohort_id));
  st.groups = normalizeGroups(rows);
  checkState(st);
  return st;
}
export const countOf = (st: UState) => st.groups.reduce((a, g) => a + sizeOf(g.members), 0);
