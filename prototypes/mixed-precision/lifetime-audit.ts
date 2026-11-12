/**
 * WP5b PROTOTYPE audit (isolated). INDEPENDENT of lifetime.ts's step code: given the state before a day, that day's
 * records and the state after, it recomputes counts, mass accounts, the age total and the set of known IDs from the
 * records alone and compares them with the final state. Design: docs/od1b-cohort-life-time.md §5.
 *   L1 shape: integer, non-negative counts and reserves; individuals have n = 1; daily bins hold age_sum = n * age and
 *      roster ages equal to the bin age; no duplicate ID; no ID that is both alive and retired.
 *   L2 counts: before + B - D + I - E + Ti - To = after, per (region, stage).
 *   L3 mass: before + recorded moves = after, per account (stock, body per region x stage, respiration, corpse,
 *      producer); the global total is constant.
 *   L4 life time: exactly one aging record per day; it ages every living member by exactly one day
 *      (count = population after the day; after - before = count; before = start total - age of the dead).
 *   L5 identity: known IDs change only by birth (new), sampled promotion (new, never seen), death (retired); a roster
 *      promotion keeps an ID; no resurrection.
 *   L6 per known ID: age advances by exactly one day; stage and sub-stage never go back.
 */
import type { LifeState, LifeRecord, Unit } from './lifetime.ts';

const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const isNat = (x: number) => Number.isSafeInteger(x) && x >= 0;
const body = (r: string, s: number) => `body:${r}:${s}`;

export function countsOf(st: LifeState): Map<string, number> {
  const m = new Map<string, number>();
  for (const u of st.units) m.set(`${u.region}|${u.stage}`, (m.get(`${u.region}|${u.stage}`) ?? 0) + u.n);
  return m;
}
export function accountsOf(st: LifeState): Map<string, number> {
  const m = new Map<string, number>(), add = (k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  for (const u of st.units) add(body(u.region, u.stage), u.reserve);
  for (const [r, v] of Object.entries(st.stocks)) add(`stock:${r}`, v);
  for (const [r, v] of Object.entries(st.corpses)) add(`corpse:${r}`, v);
  for (const [k, v] of Object.entries(st.sinks)) add(`sink:${k}`, v);
  for (const [k, v] of Object.entries(st.producers)) add(`producer:${k}`, v);
  return m;
}
export const lifeMass = (st: LifeState) => [...accountsOf(st).values()].reduce((a, b) => a + b, 0);
interface IdState { stage: number; sub: number; age: number }
export function idsOf(st: LifeState): Map<string, IdState> {
  const m = new Map<string, IdState>();
  for (const u of st.units) {
    if (u.id !== null) m.set(u.id, { stage: u.stage, sub: u.sub, age: u.age });
    for (const r of u.roster) m.set(r.id, { stage: u.stage, sub: u.sub, age: r.age });
  }
  return m;
}

function shape(st: LifeState, tag: string, v: string[]): void {
  const seen = new Set<string>(), retired = new Set(st.retired);
  const daily = st.res.age_bin_days === 1;
  for (const u of st.units as Unit[]) {
    const k = u.id !== null ? `#${u.id}` : `${u.region}|${u.stage}|${u.sub}|${u.age}`;
    if (!Number.isSafeInteger(u.n) || u.n < 1) v.push(`${tag} ${k}: count ${u.n} is not a positive integer`);
    if (!isNat(u.reserve)) v.push(`${tag} ${k}: reserve ${u.reserve} is not a non-negative integer`);
    if (!isNat(u.age_sum)) v.push(`${tag} ${k}: age_sum ${u.age_sum} is not a non-negative integer`);
    if (u.id !== null && (u.n !== 1 || u.roster.length > 0 || u.age_sum !== u.age)) v.push(`${tag} ${k}: an individual must have n = 1, no roster, age_sum = age`);
    if (u.id === null && u.roster.length > u.n) v.push(`${tag} ${k}: roster longer than the count`);
    if (u.id === null && u.rkey !== null && u.reserve !== u.n * u.rkey) v.push(`${tag} ${k}: exact bin reserve ${u.reserve} != n x ${u.rkey}`);
    if (u.id === null && daily && u.age_sum !== u.n * u.age) v.push(`${tag} ${k}: daily bin age_sum ${u.age_sum} != n x age ${u.age}`);
    for (const r of u.roster) if (daily && r.age !== u.age) v.push(`${tag} ${k}: roster ${r.id} age ${r.age} != bin age ${u.age}`);
    for (const id of u.id !== null ? [u.id] : u.roster.map((r) => r.id)) {
      if (seen.has(id)) v.push(`${tag}: DUPLICATE_ID ${id}`);
      if (retired.has(id)) v.push(`${tag}: ${id} is alive and retired (resurrection)`);
      seen.add(id);
    }
  }
}

export function auditLifeDay(before: LifeState, records: LifeRecord[], after: LifeState): string[] {
  const v: string[] = [];
  shape(before, 'before', v); shape(after, 'after', v);
  if (after.day !== before.day + 1) v.push(`day ${before.day} -> ${after.day} is not one day`);
  for (const r of records) if (r.day !== before.day) v.push(`${r.event_id}: record of day ${r.day} in day ${before.day}`);
  // L2 counts
  const cnt = countsOf(before);
  for (const r of records) {
    const known = r.ids.length + r.anonymous;
    if (['birth', 'death', 'transition', 'migration'].includes(r.kind) && known !== r.count) v.push(`${r.event_id}: count ${r.count} != ids ${r.ids.length} + anonymous ${r.anonymous}`);
    for (const e of r.effects) {
      if (!isNat(e.delta)) v.push(`${r.event_id}: effect delta ${e.delta}`);
      const k = `${e.region}|${e.stage}`, sgn = e.ledger === 'B' || e.ledger === 'I' || e.ledger === 'Ti' ? 1 : -1;
      cnt.set(k, (cnt.get(k) ?? 0) + sgn * e.delta);
    }
  }
  const ca = countsOf(after);
  for (const k of [...new Set([...cnt.keys(), ...ca.keys()])].sort(byStr)) if ((cnt.get(k) ?? 0) !== (ca.get(k) ?? 0)) v.push(`count ${k}: replayed ${cnt.get(k) ?? 0} != final ${ca.get(k) ?? 0}`);
  // L3 mass
  const acc = accountsOf(before);
  for (const r of records) for (const m of r.mass) {
    if (!isNat(m.amount)) v.push(`${r.event_id}: mass amount ${m.amount}`);
    acc.set(m.from, (acc.get(m.from) ?? 0) - m.amount); acc.set(m.to, (acc.get(m.to) ?? 0) + m.amount);
  }
  const aa = accountsOf(after);
  for (const k of [...new Set([...acc.keys(), ...aa.keys()])].sort(byStr)) if ((acc.get(k) ?? 0) !== (aa.get(k) ?? 0)) v.push(`mass ${k}: replayed ${acc.get(k) ?? 0} != final ${aa.get(k) ?? 0}`);
  if (lifeMass(before) !== lifeMass(after)) v.push(`global mass ${lifeMass(before)} -> ${lifeMass(after)}`);
  // L4 life time
  const aging = records.filter((r) => r.kind === 'aging');
  const sumAge = (st: LifeState) => st.units.reduce((a, u) => a + u.age_sum, 0), pop = (st: LifeState) => st.units.reduce((a, u) => a + u.n, 0);
  if (aging.length !== 1 || !aging[0].aging) v.push(`FROZEN_TIME: ${aging.length} aging records (exactly one per day required)`);
  else {
    const g = aging[0].aging, deadAge = records.filter((r) => r.kind === 'death').reduce((a, r) => a + (r.age_sum ?? NaN), 0);
    if (g.count !== pop(after)) v.push(`FROZEN_TIME: aging record ages ${g.count} members but ${pop(after)} are alive`);
    if (g.age_sum_after - g.age_sum_before !== g.count) v.push(`FROZEN_TIME: aging adds ${g.age_sum_after - g.age_sum_before} days to ${g.count} members`);
    if (g.age_sum_before !== sumAge(before) - deadAge) v.push(`age total before aging ${g.age_sum_before} != start ${sumAge(before)} - dead ${deadAge}`);
    if (g.age_sum_after !== sumAge(after)) v.push(`FROZEN_TIME: final age total ${sumAge(after)} != aged total ${g.age_sum_after}`);
  }
  // L5 identity
  const ib = idsOf(before), ia = idsOf(after), retiredBefore = new Set(before.retired);
  const alive = new Set(ib.keys());
  for (const r of records) {
    if (r.kind === 'birth' || (r.kind === 'promote' && r.restored)) {
      const fresh = r.kind === 'birth' ? r.ids : r.restored!.filter((x) => x.from === 'sampled').map((x) => x.id);
      for (const id of fresh) { if (alive.has(id) || retiredBefore.has(id) || ib.has(id)) v.push(`${r.event_id}: ${id} is not a new ID`); alive.add(id); }
      if (r.kind === 'promote') for (const x of r.restored!.filter((y) => y.from === 'roster')) if (!alive.has(x.id)) v.push(`${r.event_id}: roster promotion of ${x.id}, which is not alive`);
    }
    if (r.kind === 'death') for (const id of r.ids) { if (!alive.has(id)) v.push(`${r.event_id}: death of ${id}, which is not alive`); alive.delete(id); }
    if ((r.kind === 'demote' || r.kind === 'migration' || r.kind === 'feed' || r.kind === 'transition' || r.kind === 'develop') && r.ids.some((id) => !alive.has(id))) v.push(`${r.event_id}: names an ID that is not alive`);
  }
  const fin = [...ia.keys()].sort(byStr), rep = [...alive].sort(byStr);
  if (fin.join(',') !== rep.join(',')) v.push(`ID set: final [${fin.slice(0, 5)}...] != replayed [${rep.slice(0, 5)}...]`);
  const retiredAfter = new Set(after.retired);
  for (const id of retiredBefore) if (!retiredAfter.has(id)) v.push(`retired ${id} was un-retired`);
  for (const r of records.filter((x) => x.kind === 'death')) for (const id of r.ids) if (!retiredAfter.has(id)) v.push(`${id} died but is not retired`);
  // L6 per known ID
  for (const [id, a] of [...ib].sort(([p], [q]) => byStr(p, q))) {
    const b = ia.get(id);
    if (!b) continue;
    if (b.age !== a.age + 1) v.push(`FROZEN_TIME ${id}: age ${a.age} -> ${b.age} in one day`);
    if (b.stage < a.stage || (b.stage === a.stage && b.sub < a.sub)) v.push(`${id}: development went back (${a.stage}.${a.sub} -> ${b.stage}.${b.sub})`);
  }
  return v;
}
