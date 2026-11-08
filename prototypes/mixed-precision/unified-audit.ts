/**
 * Independent audit of the OD-1 v2 unified ledger (isolated prototype). It never calls unifiedDay: it only compares two
 * states and the records between them.
 *   U1 shape: integers, known cohorts, no ID in two groups, no ID both alive and retired, view only shows living
 *      exact-state members
 *   U2 population: per (region, taxon, stage, colony): before + B - D + I - E + Ti - To = after
 *   U3 mass: every account (stock, body per region/stage, respiration, corpse, producer) before + moves = after
 *   U4 identity: alive_after = alive_before - retired + born; born IDs are new; retired IDs were alive; no resurrection
 *   U5 per member: exact age +1 per day; coarse bin +0/+1; stage and sub-stage never regress; cohort identity kept
 *   U6 aging: exactly one aging record, count = living members after the day
 *   U7 cohort identity: registry entries never change or disappear; new cohorts only by a recorded birth
 */
import { expand, sizeOf } from './members.ts';
import type { UState, URecord } from './unified.ts';

interface M { cohort: string; region: string; stage: number; sub: number; age_mode: string; age: number; reserve: number }
function members(st: UState): { map: Map<string, M>; dup: string[] } {
  const map = new Map<string, M>(), dup: string[] = [];
  for (const g of st.groups) for (const id of expand(g.members)) {
    if (map.has(id)) dup.push(id);
    map.set(id, { cohort: g.cohort_id, region: g.region, stage: g.stage, sub: g.sub, age_mode: g.age_mode, age: g.age, reserve: g.reserve });
  }
  return { map, dup };
}
function accounts(st: UState): Map<string, number> {
  const a = new Map<string, number>(), add = (k: string, v: number) => a.set(k, (a.get(k) ?? 0) + v);
  for (const [r, v] of Object.entries(st.stocks)) add(`stock:${r}`, v);
  for (const [r, v] of Object.entries(st.corpses)) add(`corpse:${r}`, v);
  for (const [k, v] of Object.entries(st.sinks)) add(`sink:${k}`, v);
  for (const [k, v] of Object.entries(st.producers)) add(`producer:${k}`, v);
  for (const g of st.groups) add(`body:${g.region}:${g.stage}`, g.reserve * sizeOf(g.members));
  return a;
}
function pop(st: UState): Map<string, number> {
  const reg = new Map(st.cohorts.map((c) => [c.cohort_id, c])), p = new Map<string, number>();
  for (const g of st.groups) {
    const c = reg.get(g.cohort_id); if (!c) continue;
    const k = `${g.region}|${c.taxon}|${g.stage}|${c.colony_id ?? '-'}`;
    p.set(k, (p.get(k) ?? 0) + sizeOf(g.members));
  }
  return p;
}
const isInt = (x: number) => Number.isSafeInteger(x);

export function shapeViolations(st: UState): string[] {
  const v: string[] = [];
  const reg = new Set(st.cohorts.map((c) => c.cohort_id));
  if (reg.size !== st.cohorts.length) v.push('U1 DUPLICATE_COHORT');
  for (const g of st.groups) {
    if (!reg.has(g.cohort_id)) v.push(`U1 UNKNOWN_COHORT ${g.cohort_id}`);
    for (const x of [g.stage, g.sub, g.age, g.reserve]) if (!isInt(x) || x < 0) v.push(`U1 NOT_NONNEG_INT ${g.cohort_id} ${x}`);
    if (sizeOf(g.members) < 1) v.push(`U1 EMPTY_GROUP ${g.cohort_id}`);
    if (g.age_mode !== 'exact' && g.age_mode !== 'bin') v.push(`U1 BAD_AGE_MODE ${g.age_mode}`);
  }
  const { map, dup } = members(st);
  for (const id of dup) v.push(`U1 DUPLICATE_ID ${id}`);
  for (const id of expand(st.retired)) if (map.has(id)) v.push(`U1 ALIVE_AND_RETIRED ${id}`);
  for (const id of expand(st.view.individual)) {
    const m = map.get(id);
    if (!m) v.push(`U1 VIEW_SHOWS_NON_MEMBER ${id}`); else if (m.age_mode !== 'exact') v.push(`U1 VIEW_SHOWS_COARSE ${id}`);
  }
  for (const [k, x] of Object.entries(st.stocks)) if (!isInt(x) || x < 0) v.push(`U1 BAD_STOCK ${k}`);
  return v;
}

export function auditUnifiedDay(before: UState, recs: URecord[], after: UState): string[] {
  const v: string[] = [...shapeViolations(before).map((x) => `before ${x}`), ...shapeViolations(after)];
  if (after.day !== before.day + 1) v.push(`DAY ${before.day} -> ${after.day}`);
  if (after.seed !== before.seed || JSON.stringify(after.precision) !== JSON.stringify(before.precision)) v.push('SEED_OR_PRECISION_CHANGED');
  // U2
  const p0 = pop(before), p1 = pop(after);
  for (const r of recs) for (const e of r.ledger_effects) {
    const k = `${e.region}|${e.taxon}|${e.stage}|${e.colony_id ?? '-'}`;
    const s = e.ledger === 'B' || e.ledger === 'I' || e.ledger === 'Ti' ? 1 : -1;
    p0.set(k, (p0.get(k) ?? 0) + s * e.delta);
  }
  for (const k of new Set([...p0.keys(), ...p1.keys()])) if ((p0.get(k) ?? 0) !== (p1.get(k) ?? 0)) v.push(`U2 COUNT ${k}: books ${p0.get(k) ?? 0}, state ${p1.get(k) ?? 0}`);
  // U3
  const a0 = accounts(before), a1 = accounts(after);
  let world0 = 0, world1 = 0;
  for (const x of a0.values()) world0 += x;
  for (const x of a1.values()) world1 += x;
  for (const r of recs) for (const m of r.food_moves) {
    if (!isInt(m.amount) || m.amount < 0) v.push(`U3 BAD_MOVE ${r.event_id}`);
    a0.set(m.from, (a0.get(m.from) ?? 0) - m.amount); a0.set(m.to, (a0.get(m.to) ?? 0) + m.amount);
  }
  for (const k of new Set([...a0.keys(), ...a1.keys()])) if ((a0.get(k) ?? 0) !== (a1.get(k) ?? 0)) v.push(`U3 MASS ${k}: books ${a0.get(k) ?? 0}, state ${a1.get(k) ?? 0}`);
  if (world0 !== world1) v.push(`U3 WORLD_TOTAL ${world0} -> ${world1}`);
  // U4
  const m0 = members(before).map, m1 = members(after).map, ret0 = new Set(expand(before.retired)), ret1 = new Set(expand(after.retired));
  const born = new Set<string>(), died = new Set<string>();
  for (const r of recs) {
    if (r.kind === 'birth') for (const id of expand(r.identity.members)) { if (m0.has(id) || ret0.has(id) || born.has(id)) v.push(`U4 REUSED_ID ${id}`); born.add(id); }
    if (r.kind === 'death') for (const id of expand(r.identity.members)) { if (!m0.has(id) && !born.has(id)) v.push(`U4 DEATH_OF_NON_MEMBER ${id}`); died.add(id); }
    if (r.kind === 'birth' && r.identity.count !== sizeOf(r.identity.members)) v.push(`U4 BIRTH_COUNT ${r.event_id}`);
  }
  for (const id of m0.keys()) if (!m1.has(id) && !died.has(id)) v.push(`U4 VANISHED ${id}`);
  for (const id of m1.keys()) if (!m0.has(id) && !born.has(id)) v.push(`U4 APPEARED ${id}`);
  for (const id of died) { if (m1.has(id)) v.push(`U4 DEAD_BUT_ALIVE ${id}`); if (!ret1.has(id)) v.push(`U4 NOT_RETIRED ${id}`); }
  for (const id of ret0) if (!ret1.has(id)) v.push(`U4 UNRETIRED ${id}`);
  for (const id of ret1) if (!ret0.has(id) && !died.has(id)) v.push(`U4 RETIRED_WITHOUT_DEATH ${id}`);
  // U5
  for (const [id, x] of m0) {
    const y = m1.get(id); if (!y) continue;
    if (y.cohort !== x.cohort) v.push(`U5 COHORT_CHANGED ${id}`);
    if (x.age_mode !== y.age_mode) v.push(`U5 AGE_MODE_CHANGED ${id}`);
    else if (x.age_mode === 'exact' && y.age !== x.age + 1) v.push(`U5 AGE ${id}: ${x.age} -> ${y.age}`);
    else if (x.age_mode === 'bin' && y.age !== x.age && y.age !== x.age + 1) v.push(`U5 AGE_BIN ${id}`);
    if (y.stage < x.stage || (y.stage === x.stage && y.sub < x.sub)) v.push(`U5 REGRESSED ${id}`);
  }
  // U6
  const ag = recs.filter((r) => r.kind === 'aging');
  if (ag.length !== 1) v.push(`U6 AGING_RECORDS ${ag.length}`); else if (ag[0].identity.count !== m1.size) v.push(`U6 AGING_COUNT ${ag[0].identity.count} != ${m1.size}`);
  // U7
  const c1 = new Map(after.cohorts.map((c) => [c.cohort_id, JSON.stringify(c)]));
  for (const c of before.cohorts) if (c1.get(c.cohort_id) !== JSON.stringify(c)) v.push(`U7 COHORT_IDENTITY_CHANGED ${c.cohort_id}`);
  const births = new Set(recs.filter((r) => r.kind === 'birth').map((r) => r.cohort_id));
  for (const c of after.cohorts) if (!before.cohorts.some((b) => b.cohort_id === c.cohort_id) && !births.has(c.cohort_id)) v.push(`U7 COHORT_WITHOUT_BIRTH ${c.cohort_id}`);
  return v;
}
