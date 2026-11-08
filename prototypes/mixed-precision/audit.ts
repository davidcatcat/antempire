/**
 * WP5 PROTOTYPE audit (isolated). An INDEPENDENT checker: it does not call the apply code. Given the state before a day,
 * the ledger records of that day and the state after, it recomputes every count, every food balance and every identity
 * from the records alone and compares them with the final state. Any organism or food that appears, disappears or moves
 * without a matching record is a violation. Returns the list of violations (empty = closed).
 */
import type { WorldState, LedgerRecord } from './ledger.ts';

const ckey = (r: string, t: string, s: string, c: string | null) => `${r}|${t}|${s}|${c ?? '-'}`;
const isPosInt = (x: number) => Number.isSafeInteger(x) && x > 0;

export function countsOf(st: WorldState): Map<string, number> {
  const m = new Map<string, number>();
  const add = (k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const i of st.individuals) add(ckey(i.region, i.taxon, i.stage, i.colony_id), 1);
  for (const c of st.cohorts) add(ckey(c.region, c.taxon, c.stage, c.colony_id), c.count);
  return m;
}
export function balancesOf(st: WorldState): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of st.individuals) for (const [k, v] of Object.entries(i.comp)) m.set(`org:${i.id}:${k}`, v);
  for (const c of st.cohorts) for (const [k, v] of Object.entries(c.comp)) m.set(`cohort:${c.cohort_id}:${k}`, v);
  for (const s of st.stocks) m.set(`stock:${s.stock_id}`, s.amount);
  for (const [k, v] of Object.entries(st.sinks)) m.set(`sink:${k}`, v);
  for (const [k, v] of Object.entries(st.producers)) m.set(`producer:${k}`, v);
  return m;
}
/** id -> places it occupies (more than one place is itself a violation) */
export function placesOf(st: WorldState): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const put = (id: string, where: string) => m.set(id, [...(m.get(id) ?? []), where]);
  for (const i of st.individuals) put(i.id, `individual@${i.region}`);
  for (const c of st.cohorts) for (const r of c.roster) put(r.id, `roster@${c.cohort_id}`);
  return m;
}
export const totalMass = (st: WorldState) => [...balancesOf(st).values()].reduce((a, b) => a + b, 0);
export const totalCount = (st: WorldState) => [...countsOf(st).values()].reduce((a, b) => a + b, 0);

export function auditDay(initial: WorldState, records: LedgerRecord[], final: WorldState): string[] {
  const v: string[] = [];
  const seen = new Set<string>();
  // ---- per-record shape rules
  const usedRecords = new Set(initial.used_scenario_records);
  for (const r of records) {
    if (seen.has(r.event_id)) v.push(`duplicate event_id ${r.event_id}`);
    seen.add(r.event_id);
    const e = r.ledger_effects, sum = (l: string) => e.filter((x) => x.ledger === l).reduce((a, x) => a + x.delta, 0);
    for (const x of e) if (!isPosInt(x.delta)) v.push(`${r.event_id}: ledger delta must be a positive integer`);
    if (r.kind === 'birth' && !(sum('B') === 1 && e.length === 1)) v.push(`${r.event_id}: birth must carry exactly one B`);
    if (r.kind === 'death' && !(sum('D') === 1 && e.length === 1)) v.push(`${r.event_id}: death must carry exactly one D`);
    if (r.kind === 'migration' || r.kind === 'transport') {
      // I2: every I pairs with an E of the same taxon/stage/colony in the same record, in a different region
      const g = new Map<string, number>();
      for (const x of e) { const k = `${x.taxon}|${x.stage}|${x.colony_id}`; g.set(k, (g.get(k) ?? 0) + (x.ledger === 'I' ? x.delta : x.ledger === 'E' ? -x.delta : NaN)); }
      if (e.length === 0 || [...g.values()].some((n) => n !== 0)) v.push(`${r.event_id}: I and E not paired`);
      if (r.source_region === r.destination_region) v.push(`${r.event_id}: move within one region`);
      if (!r.cause.kind || r.cause.driver_event_ids.length === 0) v.push(`${r.event_id}: crossing without a cause (I8)`);
      for (const m of r.food_moves) if (!(m.from.startsWith('cohort:') && m.to.startsWith('cohort:'))) v.push(`${r.event_id}: a move may only carry pooled shares cohort->cohort, saw ${m.from}->${m.to}`);
    }
    if (!['birth', 'death', 'migration', 'transport'].includes(r.kind) && e.length > 0) v.push(`${r.event_id}: ${r.kind} must not change any count`);
    if (r.kind === 'transport') {
      const s = r.scenario_source, rec = s && initial.scenario_records.find((x) => x.record_id === s.record_id);
      if (!s || !rec || !rec.scenario_id || !rec.source_ref || rec.scenario_id !== s.scenario_id) v.push(`${r.event_id}: transport without a registered scenario source (Q1)`);
      else {
        if (usedRecords.has(rec.record_id)) v.push(`${r.event_id}: scenario record ${rec.record_id} used twice`);
        usedRecords.add(rec.record_id);
        if (rec.from_region !== r.source_region || rec.to_region !== r.destination_region || rec.day !== r.t.day) v.push(`${r.event_id}: transport differs from its scenario record`);
      }
    }
    for (const m of r.food_moves) {
      if (!isPosInt(m.amount)) v.push(`${r.event_id}: food move must be a positive integer (${m.amount})`);
      if (m.from.startsWith('sink:') || m.to.startsWith('producer:')) v.push(`${r.event_id}: sinks are terminal and producers only give`);
      if (m.from.startsWith('producer:') && r.kind !== 'produce') v.push(`${r.event_id}: food from a producer outside a produce record`);
      if (r.kind === 'death' && !m.to.startsWith('stock:corpse.')) v.push(`${r.event_id}: a body's food must go to a corpse stock (I7)`);
      if (r.kind === 'promote' && !(m.from.startsWith('cohort:') && m.to.startsWith('org:'))) v.push(`${r.event_id}: promote moves cohort->org only`);
      if (r.kind === 'demote' && !(m.from.startsWith('org:') && m.to.startsWith('cohort:'))) v.push(`${r.event_id}: demote moves org->cohort only`);
    }
  }
  // ---- counts: final = initial + B - D + I - E for every region/taxon/stage/colony
  const exp = countsOf(initial);
  for (const r of records) for (const x of r.ledger_effects) {
    const k = ckey(x.region, x.taxon, x.stage, x.colony_id), s = x.ledger === 'B' || x.ledger === 'I' ? 1 : -1;
    exp.set(k, (exp.get(k) ?? 0) + s * x.delta);
  }
  const got = countsOf(final);
  for (const k of new Set([...exp.keys(), ...got.keys()])) if ((exp.get(k) ?? 0) !== (got.get(k) ?? 0)) v.push(`count ${k}: ledger says ${exp.get(k) ?? 0}, state has ${got.get(k) ?? 0}`);
  for (const c of final.cohorts) {
    if (!Number.isSafeInteger(c.count) || c.count < 0) v.push(`cohort ${c.cohort_id}: bad count ${c.count}`);
    if (c.roster.length > c.count) v.push(`cohort ${c.cohort_id}: roster ${c.roster.length} > count ${c.count}`);
    if (c.colony_id !== null && final.policy.non_demotable_colonies.includes(c.colony_id) && (c.count > 0 || c.roster.length > 0)) v.push(`cohort ${c.cohort_id}: focal-colony members pooled (Q2)`);
  }
  // ---- food: final balance = initial + in - out for every compartment; global sum constant
  const bal = balancesOf(initial);
  for (const r of records) for (const m of r.food_moves) { bal.set(m.from, (bal.get(m.from) ?? 0) - m.amount); bal.set(m.to, (bal.get(m.to) ?? 0) + m.amount); }
  const fb = balancesOf(final);
  for (const k of new Set([...bal.keys(), ...fb.keys()])) if ((bal.get(k) ?? 0) !== (fb.get(k) ?? 0)) v.push(`food ${k}: ledger says ${bal.get(k) ?? 0}, state has ${fb.get(k) ?? 0}`);
  for (const [k, x] of fb) {
    if (!Number.isSafeInteger(x)) v.push(`food ${k}: not an integer (${x})`);
    if (k.startsWith('producer:') ? x > 0 : x < 0) v.push(`food ${k}: wrong sign ${x}`);
  }
  if (totalMass(initial) !== totalMass(final)) v.push(`global mass ${totalMass(initial)} -> ${totalMass(final)}`);
  // ---- identity: final IDs = initial + born + minted - retired; one place each; retired never return
  const p0 = placesOf(initial), p1 = placesOf(final), retired0 = new Set(initial.retired);
  const born = new Set<string>(), minted = new Set<string>(), died = new Set<string>();
  for (const r of records) for (const id of r.identity.ids) {
    if (r.identity.action === 'born') born.add(id);
    if (r.identity.action === 'minted') minted.add(id);
    if (r.identity.action === 'retired') died.add(id);
  }
  for (const id of [...born, ...minted]) if (p0.has(id) || retired0.has(id)) v.push(`id ${id}: created but already existed`);
  const expIds = new Set([...p0.keys(), ...born, ...minted].filter((id) => !died.has(id)));
  for (const id of expIds) if (!p1.has(id)) v.push(`id ${id}: vanished without a death record`);
  for (const [id, where] of p1) {
    if (!expIds.has(id)) v.push(`id ${id}: appeared without a birth/promotion record`);
    if (where.length > 1) v.push(`id ${id}: in ${where.length} places (${where.join(', ')})`);
  }
  const retired1 = new Set(final.retired);
  for (const id of [...retired0, ...died]) if (!retired1.has(id)) v.push(`id ${id}: retirement lost`);
  for (const id of retired1) if (p1.has(id)) v.push(`id ${id}: retired but alive`);
  return v;
}
