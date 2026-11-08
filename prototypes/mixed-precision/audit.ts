/**
 * WP5 PROTOTYPE audit (isolated). An INDEPENDENT checker: it does not call the apply code. Given the state before a day,
 * the ledger records of that day and the state after, it recomputes every count, every food balance and every identity
 * from the records alone and compares them with the final state. Any organism or food that appears, disappears or moves
 * without a matching record is a violation. Returns the list of violations (empty = closed).
 *
 * Balance identities (counts, compartments, global mass, ID sets) are NECESSARY but not SUFFICIENT: two individuals can
 * swap regions, or an unknown "producer" can book a balancing negative account, and every total still closes (Codex
 * R13-03, R13-04). So the audit also REPLAYS the records in canonical order and rebuilds, per ID, where it is, whether it
 * is an individual or a roster member of which cohort, and its physiology snapshot; every crossing must be explained by a
 * migration/transport record whose source, destination, identity and food moves match the replayed state, and every
 * produce/birth must come from a modeled organism that is alive (not retired, not absent) at that event time.
 */
import type { WorldState, LedgerRecord, LedgerEffect } from './ledger.ts';

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
  replay(initial, records, final, v);
  return v;
}

// ---------------------------------------------------------------- replay (location, representation, physiology, sources)
// Contracts duplicated from the ledger's documented format (not imported: the audit must not share the apply code).
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const cid = (r: string, t: string, s: string, c: string | null) => `C|${r}|${t}|${s}|${c ?? '-'}`;
const KIND_RANK: Record<string, number> = { produce: 0, food_transfer: 1, birth: 2, promote: 3, move: 4, cohort_move: 5, transport: 6, demote: 7, death: 8, decay: 9 };
const cmdKind = (r: LedgerRecord) => (r.kind === 'migration' ? (r.cause.rule_id === 'wp5.cohort_move' ? 'cohort_move' : 'move') : r.kind);
const keyOf = (r: LedgerRecord) => (r.event_id.startsWith(`${r.t.day}.`) ? r.event_id.slice(`${r.t.day}.`.length) : r.event_id);
function stable(x: unknown): string {
  const norm = (v: unknown): unknown => Array.isArray(v) ? v.map(norm) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v as object).sort(byStr).map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v;
  return JSON.stringify(norm(x));
}
interface RInd { region: string; taxon: string; stage: string; colony_id: string | null; physio: string }
interface RCoh { region: string; taxon: string; stage: string; colony_id: string | null; count: number; roster: Map<string, string> }
const sameKind = (a: { taxon: string; stage: string; colony_id: string | null }, b: { taxon: string; stage: string; colony_id: string | null }) =>
  a.taxon === b.taxon && a.stage === b.stage && a.colony_id === b.colony_id;

function replay(initial: WorldState, records: LedgerRecord[], final: WorldState, v: string[]): void {
  const regions = new Map(initial.regions.map((r) => [r.id, r]));
  const ind = new Map<string, RInd>(), coh = new Map<string, RCoh>(), retired = new Set(initial.retired);
  const stk = new Map<string, { region: string; origin: string | null }>();
  for (const i of initial.individuals) ind.set(i.id, { region: i.region, taxon: i.taxon, stage: i.stage, colony_id: i.colony_id, physio: stable(i.physio) });
  for (const c of initial.cohorts) coh.set(c.cohort_id, { region: c.region, taxon: c.taxon, stage: c.stage, colony_id: c.colony_id, count: c.count, roster: new Map(c.roster.map((x) => [x.id, stable(x.physio)])) });
  for (const s of initial.stocks) stk.set(s.stock_id, { region: s.region, origin: s.origin_event_id });
  const getCoh = (e: { region: string; taxon: string; stage: string; colony_id: string | null }) => {
    const id = cid(e.region, e.taxon, e.stage, e.colony_id);
    let c = coh.get(id);
    if (!c) { c = { region: e.region, taxon: e.taxon, stage: e.stage, colony_id: e.colony_id, count: 0, roster: new Map() }; coh.set(id, c); }
    return { id, c };
  };
  const inRoster = (id: string) => { for (const c of coh.values()) if (c.roster.has(id)) return true; return false; };
  const known = (id: string) => ind.has(id) || retired.has(id) || inRoster(id);
  const exists = (a: string) => {
    const p = a.indexOf(':'), kind = a.slice(0, p), rest = a.slice(p + 1);
    if (kind === 'org' || kind === 'cohort') { const q = rest.lastIndexOf(':'); const id = rest.slice(0, q); return q > 0 && (kind === 'org' ? ind.has(id) : coh.has(id)); }
    if (kind === 'stock') return stk.has(rest);
    return kind === 'sink';
  };
  const resOf = (r: string | null) => (r === null ? undefined : regions.get(r)?.resolution);
  const sorted = records.map((r, n) => ({ r, n })).sort((a, b) =>
    a.r.t.day - b.r.t.day || (a.r.t.minute ?? -1) - (b.r.t.minute ?? -1) || (KIND_RANK[cmdKind(a.r)] ?? 99) - (KIND_RANK[cmdKind(b.r)] ?? 99) || byStr(keyOf(a.r), keyOf(b.r)) || a.n - b.n).map((x) => x.r);

  for (const r of sorted) {
    const err = (m: string) => v.push(`${r.event_id}: ${m}`);
    const when = `day ${r.t.day} minute ${r.t.minute ?? '(day)'}`;
    const ids = r.identity.ids, fm = r.food_moves;
    if (!(cmdKind(r) in KIND_RANK)) { err(`unknown record kind ${r.kind}`); continue; }
    for (const reg of [r.source_region, r.destination_region]) if (reg !== null && !regions.has(reg)) err(`unknown region ${reg}`);
    // every food source must exist BEFORE the event (producers are checked by the produce rule below)
    for (const m of fm) if (!m.from.startsWith('producer:') && !exists(m.from)) err(`food taken from ${m.from}, which does not exist at ${when}`);
    const only = (from: (a: string) => boolean, to: (a: string) => boolean, what: string) => { for (const m of fm) if (!from(m.from) || !to(m.to)) err(`${what}; saw ${m.from}->${m.to}`); };
    switch (cmdKind(r)) {
      case 'produce': {
        if (fm.length !== 1 || !fm[0].from.startsWith('producer:') || !fm[0].to.startsWith('stock:')) { err('a produce record must be exactly one producer -> stock move'); break; }
        if (r.identity.action !== 'none' || ids.length > 0) err('a produce record creates no organism');
        const pid = fm[0].from.slice('producer:'.length), sid = fm[0].to.slice('stock:'.length);
        const pi = ind.get(pid), pc = coh.get(pid);
        let preg: string | null = null;
        if (pi) preg = pi.region;
        else if (pc && pc.count > 0) preg = pc.region;
        else if (retired.has(pid)) err(`producer ${pid} is retired (dead) at ${when}`);
        else if (pc) err(`producer cohort ${pid} has no living member at ${when}`);
        else if (inRoster(pid)) err(`producer ${pid} is a pooled roster member, not a modeled producer`);
        else err(`producer ${pid} is not a modeled organism (no such individual or cohort) at ${when}`);
        if (preg !== null && preg !== r.destination_region) err(`producer ${pid} is in ${preg}, but the produce record puts the food in ${r.destination_region}`);
        const s = stk.get(sid);
        if (!s) stk.set(sid, { region: r.destination_region ?? '?', origin: r.event_id });
        else if (s.region !== r.destination_region) err(`stock ${sid} is in ${s.region}, not ${r.destination_region}`);
        break;
      }
      case 'birth': {
        const b = r.ledger_effects[0], p = r.parent;
        if (!b) break; // shape rule already reported
        if (b.region !== r.destination_region) err(`birth effect in ${b.region} but destination ${r.destination_region}`);
        if (!p) err('birth without a recorded parent (I6)');
        else {
          const pid = 'individual' in p ? p.individual : p.cohort;
          const alive = 'individual' in p ? ind.get(pid) : (coh.get(pid)?.count ?? 0) > 0 ? coh.get(pid) : undefined;
          if (!alive) err(`parent ${pid} is not a living modeled organism at ${when}${retired.has(pid) ? ' (retired)' : ''}`);
          else if (alive.region !== b.region) err(`parent ${pid} is in ${alive.region}, the newborn in ${b.region} (I6: same region)`);
        }
        if (ids.length === 1 && r.identity.anonymous === 0) {
          if (known(ids[0])) err(`newborn ${ids[0]} already exists or existed`);
          else ind.set(ids[0], { region: b.region, taxon: b.taxon, stage: b.stage, colony_id: b.colony_id, physio: stable({}) });
          only(() => true, (a) => a.startsWith(`org:${ids[0]}:`), 'a newborn individual is endowed only into its own compartments');
        } else if (ids.length === 0 && r.identity.anonymous === 1) {
          const { id, c } = getCoh(b); c.count += 1;
          only(() => true, (a) => a.startsWith(`cohort:${id}:`), 'a cohort birth is endowed only into its own cohort');
        } else err('a birth creates exactly one organism');
        break;
      }
      case 'death': {
        const d = r.ledger_effects[0];
        if (!d) break;
        if (d.region !== r.source_region) err(`death effect in ${d.region} but source ${r.source_region}`);
        const corpseRegion = r.source_region ?? '?';
        if (ids.length === 1 && ind.has(ids[0])) {
          const i = ind.get(ids[0])!;
          if (i.region !== d.region || !sameKind(i, d)) err(`death of ${ids[0]} booked in ${d.region}|${d.taxon}|${d.stage}|${d.colony_id}, but it is ${i.region}|${i.taxon}|${i.stage}|${i.colony_id}`);
          only((a) => a.startsWith(`org:${ids[0]}:`), () => true, 'an individual death moves only its own compartments');
          ind.delete(ids[0]); retired.add(ids[0]);
        } else {
          const id = cid(d.region, d.taxon, d.stage, d.colony_id), c = coh.get(id);
          if (!c || c.count < 1) { err(`death in ${id}, which has no living member at ${when}`); break; }
          if (ids.length === 1) { if (!c.roster.delete(ids[0])) err(`dead ${ids[0]} is not a living individual or a roster member of ${id}`); retired.add(ids[0]); }
          else if (!(ids.length === 0 && r.identity.anonymous === 1 && c.count - c.roster.size >= 1)) err(`cohort death must take one roster ID or one anonymous member of ${id}`);
          c.count -= 1;
          only((a) => a.startsWith(`cohort:${id}:`), () => true, 'a cohort death moves only that cohort\'s share');
        }
        for (const m of fm) {
          const sid = m.to.slice('stock:'.length), s = stk.get(sid);
          if (!s) stk.set(sid, { region: corpseRegion, origin: r.event_id });
          else if (s.origin !== r.event_id || s.region !== corpseRegion) err(`corpse stock ${sid} reused or in another region`);
        }
        break;
      }
      case 'move': case 'cohort_move': case 'transport': {
        const src = r.source_region, dst = r.destination_region;
        const E = r.ledger_effects.filter((x) => x.ledger === 'E'), I = r.ledger_effects.filter((x) => x.ledger === 'I');
        if (E.length !== 1 || I.length !== 1 || r.ledger_effects.length !== 2) { err('a crossing carries exactly one E and one I'); break; }
        const e: LedgerEffect = E[0], i: LedgerEffect = I[0], n = e.delta;
        if (e.region !== src || i.region !== dst) err(`effects E@${e.region}/I@${i.region} differ from the record's ${src} -> ${dst}`);
        if (!sameKind(e, i) || e.delta !== i.delta) err('E and I describe different organisms');
        const rc = resOf(src) !== resOf(dst) ? { from: resOf(src), to: resOf(dst) } : null;
        if (stable(r.resolution_change) !== stable(rc)) err(`resolution_change ${stable(r.resolution_change)} does not match ${src} -> ${dst}`);
        if (r.identity.action !== 'kept') err('a crossing keeps identity');
        const scen = r.kind === 'transport' && r.scenario_source ? initial.scenario_records.find((x) => x.record_id === r.scenario_source!.record_id) : undefined;
        const single = ids.length === 1 && r.identity.anonymous === 0 && ind.has(ids[0]);
        if (single) {
          const o = ind.get(ids[0])!;
          if (n !== 1) err(`an individual crossing moves exactly one organism, booked ${n}`);
          if (o.region !== src) err(`${ids[0]} is in ${o.region}, not in the record's source ${src}`);
          if (!sameKind(o, e)) err(`${ids[0]} is ${o.taxon}|${o.stage}|${o.colony_id}, the effects book ${e.taxon}|${e.stage}|${e.colony_id}`);
          if (fm.length > 0) err('an individual crossing must not move food (compartments travel with the organism)');
          if (scen && !(scen.subject.kind === 'individual' && scen.subject.id === ids[0])) err(`transport moved ${ids[0]}, the scenario record names another subject`);
          o.region = dst ?? o.region;
        } else {
          const sId = cid(e.region, e.taxon, e.stage, e.colony_id), sc = coh.get(sId);
          if (!sc || sc.count < n) { err(`${sId} holds ${sc?.count ?? 0} < ${n} at ${when}`); break; }
          if (ids.length + r.identity.anonymous !== n) err(`identity lists ${ids.length} IDs + ${r.identity.anonymous} anonymous, but ${n} crossed`);
          if (r.identity.anonymous > sc.count - sc.roster.size) err(`${r.identity.anonymous} anonymous members crossed, ${sId} has only ${sc.count - sc.roster.size}`);
          const { id: dId, c: dc } = getCoh(i);
          for (const id of ids) {
            const ph = sc.roster.get(id);
            if (ph === undefined) { err(`${id} crossed from ${sId} but is not on its roster${ind.has(id) ? ' (it is an individual)' : ''}`); continue; }
            sc.roster.delete(id); dc.roster.set(id, ph);
          }
          sc.count -= n; dc.count += n;
          only((a) => a.startsWith(`cohort:${sId}:`), (a) => a.startsWith(`cohort:${dId}:`), `a cohort crossing moves only pooled shares ${sId} -> ${dId}`);
          if (scen && !(scen.subject.kind === 'cohort' && sameKind(scen.subject, e) && scen.subject.count === n)) err('transport moved organisms other than its scenario record subject');
        }
        break;
      }
      case 'promote': {
        const id0 = r.cohort_id, c = id0 ? coh.get(id0) : undefined;
        if (!id0 || !c) { err('promote without a known cohort'); break; }
        if (c.count < 1) { err(`promote from ${id0}, which has no member at ${when}`); break; }
        if (r.source_region !== c.region || r.destination_region !== c.region) err('promotion changes representation only, in the cohort\'s own region');
        if (ids.length !== 1) { err('promote yields exactly one ID'); break; }
        const id = ids[0];
        let physio = stable({});
        if (r.identity.action === 'promoted') { const ph = c.roster.get(id); if (ph === undefined) err(`${id} is not on ${id0}'s roster`); else { physio = ph; c.roster.delete(id); } }
        else if (r.identity.action === 'minted') { if (known(id)) err(`minted ${id} already exists or existed`); if (c.count - c.roster.size < 1) err(`no anonymous member of ${id0} to mint`); }
        else err(`promote identity action ${r.identity.action}`);
        c.count -= 1;
        ind.set(id, { region: c.region, taxon: c.taxon, stage: c.stage, colony_id: c.colony_id, physio });
        only((a) => a.startsWith(`cohort:${id0}:`), (a) => a.startsWith(`org:${id}:`), `promotion moves only ${id0}'s share into ${id}`);
        break;
      }
      case 'demote': {
        const id = ids[0], o = id !== undefined ? ind.get(id) : undefined;
        if (ids.length !== 1 || !o) { err(`demote of ${id ?? '(none)'}, which is not a living individual at ${when}`); break; }
        if (r.source_region !== o.region || r.destination_region !== o.region) err(`${id} is in ${o.region}; demotion happens in place`);
        if (o.colony_id !== null && initial.policy.non_demotable_colonies.includes(o.colony_id)) err(`${id} belongs to non-demotable colony ${o.colony_id} (Q2)`);
        const { id: dId, c } = getCoh(o);
        if (r.cohort_id !== dId) err(`demote names cohort ${r.cohort_id}, ${id} belongs in ${dId}`);
        c.roster.set(id, o.physio); c.count += 1; ind.delete(id);
        only((a) => a.startsWith(`org:${id}:`), (a) => a.startsWith(`cohort:${dId}:`), `demotion pools only ${id} into ${dId}`);
        break;
      }
      default:
        if (ids.length > 0 || r.identity.action !== 'none') err(`${r.kind} must not touch identity`);
    }
    // every food destination must exist AFTER the event (new stocks only from produce / death, recorded above)
    for (const m of fm) if (!exists(m.to)) err(`food put into ${m.to}, which does not exist after ${when}`);
  }

  // ---- compare the replayed world with the final state, ID by ID
  for (const f of final.individuals) {
    const o = ind.get(f.id);
    if (!o) { v.push(`id ${f.id}: is an individual in the state, the replay does not have it as one`); continue; }
    if (o.region !== f.region) v.push(`id ${f.id}: replay puts it in ${o.region}, state has ${f.region} (moved without a matching migration/transport record)`);
    if (!sameKind(o, f)) v.push(`id ${f.id}: taxon/stage/colony changed without a record`);
    if (o.physio !== stable(f.physio)) v.push(`id ${f.id}: physiology ${stable(f.physio)} differs from the replayed ${o.physio}`);
  }
  const fIds = new Set(final.individuals.map((x) => x.id));
  for (const [id, o] of ind) if (!fIds.has(id)) v.push(`id ${id}: replay has it as an individual in ${o.region}, the state does not`);
  const fCoh = new Map(final.cohorts.map((c) => [c.cohort_id, c]));
  for (const c of final.cohorts) if (c.cohort_id !== cid(c.region, c.taxon, c.stage, c.colony_id)) v.push(`cohort ${c.cohort_id}: id does not match its region/taxon/stage/colony`);
  for (const id of new Set([...coh.keys(), ...fCoh.keys()])) {
    const o = coh.get(id), f = fCoh.get(id);
    if ((o?.count ?? 0) !== (f?.count ?? 0)) v.push(`cohort ${id}: replay count ${o?.count ?? 0}, state ${f?.count ?? 0}`);
    const fr = new Map((f?.roster ?? []).map((x) => [x.id, stable(x.physio)]));
    for (const [rid, ph] of o?.roster ?? []) {
      if (!fr.has(rid)) v.push(`cohort ${id}: replay has ${rid} on the roster, the state does not`);
      else if (fr.get(rid) !== ph) v.push(`cohort ${id}: roster physiology of ${rid} ${fr.get(rid)} differs from the replayed ${ph}`);
    }
    for (const rid of fr.keys()) if (!o?.roster.has(rid)) v.push(`cohort ${id}: ${rid} is on the state roster without a record putting it there`);
  }
  const fStk = new Map(final.stocks.map((s) => [s.stock_id, s]));
  for (const [id, s] of fStk) {
    const o = stk.get(id);
    if (!o) v.push(`stock ${id}: appeared without a produce/death record`);
    else if (o.region !== s.region || o.origin !== s.origin_event_id) v.push(`stock ${id}: region/origin ${s.region}/${s.origin_event_id} differ from the replayed ${o.region}/${o.origin}`);
  }
  for (const id of stk.keys()) if (!fStk.has(id)) v.push(`stock ${id}: vanished without a record`);
  for (const id of final.retired) if (!retired.has(id)) v.push(`id ${id}: retired without a death record`);
}
