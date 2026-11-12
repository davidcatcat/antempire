/**
 * Compatibility and migration into the OD-1 v2 unified ledger (isolated prototype; issue #145 item 12).
 *   - migrateOd1(v1): OD-1 v1 (ledger.ts) cohorts have the STAGE inside the cohort ID (`C|region|taxon|stage|colony`).
 *     Each v1 cohort becomes a stable cohort identity `K.v1.<n>` (alias recorded; stage becomes a field); roster IDs
 *     are kept as known members (exact age); anonymous members get latent IDs `K.v1.<n>#k`; v1 individuals become
 *     known members of their own cohort `K.v1.i.<id>`. The pooled reserve compartment is split by the OD-1 rule
 *     (successive floor shares, the last member takes the rest) and recorded as an approximation.
 *   - migrateLifetime(ls): a lifetime.ts LifeState (a second population ledger until now) is converted: individuals
 *     keep IDs, roster members keep exact ages, anonymous bin members get latent IDs. Pooled or mean-field states are
 *     refused (no exact per-member reserve exists to convert).
 * Both return the legacy state marked `superseded_by` (ledger.ts runDay and lifetime.ts lifeDay refuse it), and record
 * the legacy fingerprint in `migrated_from`. checkSingleAuthority() reports any organism alive in a legacy state that
 * has NOT been superseded by this unified state (dual presence).
 * Unknown legacy quantities are not invented: v1 has no age and no Erlang sub-stage, so ages must be supplied with a
 * basis label (otherwise MIGRATION_AGE_UNKNOWN), and sub-stage 0 is recorded as a migration assumption.
 */
import { canonicalJson, type WorldState } from './ledger.ts';
import type { LifeState } from './lifetime.ts';
import { compress, expand, latentId } from './members.ts';
import { SCHEMA, URefusal, defaultPrecision, normalizeGroups, aliveIds, type UState, type Group, type CohortIdentity, type URecord, type Precision } from './unified.ts';

const refuse = (code: string, msg: string): never => { throw new URefusal(code, msg); };
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fnv(s: string, h = 0x811c9dc5): number { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }
/** content fingerprint of a legacy state (without its superseded_by mark) */
export function fingerprint(x: unknown): string {
  const { superseded_by: _s, ...rest } = x as Record<string, unknown>;
  const j = canonicalJson(rest);
  return fnv(j).toString(16).padStart(8, '0') + fnv(j, 0x2545f491).toString(16).padStart(8, '0');
}
const emptyUnified = (seed: string, day: number, precision: Precision): UState => ({
  schema: SCHEMA, authoritative: true, seed, day, precision, cohorts: [], groups: [], stocks: {}, inert_stocks: {}, sinks: {}, corpses: {}, producers: {},
  retired: [], migrated_from: [], view: { individual: [] },
});
function migrationRecord(day: number, tag: string, ids: string[], note: string): URecord {
  return { event_id: `${day}.legacy_migration.${tag}`, kind: 'legacy_migration', t: { day, minute: null, time_resolution: 'day' }, cohort_id: null, region: null, stage: null,
    identity: { action: 'migrated', members: compress(ids), count: ids.length }, ledger_effects: [], food_moves: [], cause: { kind: 'legacy_migration', driver_event_ids: [], rule_id: 'od1v2.migrate_legacy', rng_stream: null },
    parents: null, stage_change: null, note };
}
const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);
/** successive floor shares of `t` over n members (OD-1 v1 shareOf rule): member j gets the j-th share */
function shares(t: number, n: number): number[] {
  const out: number[] = []; let left = t;
  for (let m = n; m >= 1; m--) { const s = m <= 1 ? left : Math.floor(left / m); out.push(s); left -= s; }
  return out;
}

export interface Od1MigrationOptions {
  /** v1 stage names in stage-index order (the life-history parameter file's order) */
  stages: string[];
  /** the v1 compartment that is the life-time reserve; any other non-zero compartment is refused */
  reserve_comp: string;
  /** age in days of each v1 cohort (by v1 cohort_id) and individual (by ID), with the basis of the value */
  ages: Record<string, { days: number; basis: string }>;
  /** v1 stock IDs that are edible food of their region; other stocks are carried as inert */
  edible_stocks: string[];
  precision?: Precision;
}
export function migrateOd1(v1: WorldState & { superseded_by?: string }, o: Od1MigrationOptions): { state: UState; records: URecord[]; alias: Record<string, string>; superseded: WorldState & { superseded_by: string } } {
  if (v1.schema !== 'antempire.wp5-mixed-precision.v1') refuse('MIGRATION_WRONG_SCHEMA', v1.schema);
  if (v1.superseded_by) refuse('MIGRATION_ALREADY_SUPERSEDED', v1.superseded_by);
  const P = o.precision ?? defaultPrecision();
  const st = emptyUnified(v1.seed, v1.day, P), recs: URecord[] = [], alias: Record<string, string> = {};
  const rows: { g: Omit<Group, 'members'>; ids: string[] }[] = [];
  const stageOf = (s: string) => { const k = o.stages.indexOf(s); return k >= 0 ? k : refuse('MIGRATION_UNKNOWN_STAGE', s); };
  const ageOf = (key: string, physio?: Record<string, unknown>) => {
    const a = o.ages[key];
    if (a && Number.isSafeInteger(a.days) && a.days >= 0 && a.basis) return a.days;
    if (physio && Number.isSafeInteger(physio.age_d)) return physio.age_d as number;
    return refuse('MIGRATION_AGE_UNKNOWN', `${key}: v1 has no age; supply one with a basis label`);
  };
  const reserveOf = (key: string, comp: Record<string, number>) => {
    for (const [k, x] of Object.entries(comp)) if (k !== o.reserve_comp && x !== 0) refuse('MIGRATION_UNMAPPED_COMPARTMENT', `${key}: ${k}=${x}`);
    return comp[o.reserve_comp] ?? 0;
  };
  const mode = (colony: string | null, known: boolean) => known || P.age_bin_days === 1 || (colony !== null && P.exact_age_colonies.includes(colony)) ? 'exact' as const : 'bin' as const;
  const ageField = (m: 'exact' | 'bin', days: number) => (m === 'exact' ? days : Math.floor(days / P.age_bin_days));
  let before = 0, beforeN = 0;
  // cohorts (sorted by v1 ID; the ordinal makes the new ID independent of storage order)
  [...v1.cohorts].sort((a, b) => byStr(a.cohort_id, b.cohort_id)).forEach((c, j) => {
    const id = `K.v1.${j}`; alias[c.cohort_id] = id;
    st.cohorts.push({ cohort_id: id, taxon: c.taxon, colony_id: c.colony_id, origin: { kind: 'migrated_od1', event_id: null, legacy_id: c.cohort_id } });
    before += total(c.comp); beforeN += c.count;
    if (c.count < c.roster.length) refuse('MIGRATION_BAD_COHORT', `${c.cohort_id}: roster larger than count`);
    if (c.count === 0) { if (total(c.comp) !== 0) refuse('MIGRATION_MASS_WITHOUT_MEMBERS', c.cohort_id); return; }
    const res = reserveOf(c.cohort_id, c.comp), stage = stageOf(c.stage), days = ageOf(c.cohort_id);
    const known = [...c.roster].sort((a, b) => byStr(a.id, b.id)).map((r) => r.id);
    const ids = [...known, ...Array.from({ length: c.count - known.length }, (_, k) => latentId(id, k))];
    const sh = shares(res, ids.length);
    ids.forEach((mid, k) => {
      const m = mode(c.colony_id, k < known.length);
      rows.push({ g: { cohort_id: id, region: c.region, stage, sub: 0, age_mode: m, age: ageField(m, days), reserve: sh[k] }, ids: [mid] });
    });
    recs.push(migrationRecord(v1.day, id, ids, `v1 ${c.cohort_id} -> ${id}; stage '${c.stage}' is now a field; reserve ${res} split by successive floor shares (approximation: v1 kept only the pooled total); sub-stage 0 (assumption: v1 has none); age ${days} d (${o.ages[c.cohort_id]?.basis})`));
  });
  for (const i of [...v1.individuals].sort((a, b) => byStr(a.id, b.id))) {
    const id = `K.v1.i.${i.id}`; alias[i.id] = id;
    st.cohorts.push({ cohort_id: id, taxon: i.taxon, colony_id: i.colony_id, origin: { kind: 'migrated_od1', event_id: null, legacy_id: i.id } });
    before += total(i.comp); beforeN += 1;
    const days = ageOf(i.id, i.physio as Record<string, unknown>);
    rows.push({ g: { cohort_id: id, region: i.region, stage: stageOf(i.stage), sub: 0, age_mode: 'exact', age: days, reserve: reserveOf(i.id, i.comp) }, ids: [i.id] });
    recs.push(migrationRecord(v1.day, id, [i.id], `v1 individual ${i.id} -> known member of ${id}; physiology other than age is not carried (v1 physio is free-form)`));
  }
  for (const s of v1.stocks) {
    before += s.amount;
    if (o.edible_stocks.includes(s.stock_id)) st.stocks[s.region] = (st.stocks[s.region] ?? 0) + s.amount;
    else st.inert_stocks[s.stock_id] = { region: s.region, amount: s.amount, origin_event_id: s.origin_event_id };
  }
  st.sinks = { ...v1.sinks }; st.producers = { ...v1.producers }; before += total(v1.sinks) + total(v1.producers);
  st.retired = compress(v1.retired);
  st.groups = normalizeGroups(rows);
  st.cohorts.sort((a, b) => byStr(a.cohort_id, b.cohort_id));
  const after = st.groups.reduce((a, g) => a + g.reserve * expand(g.members).length, 0) + total(st.stocks) + Object.values(st.inert_stocks).reduce((a, s) => a + s.amount, 0) + total(st.sinks) + total(st.producers);
  if (after !== before) refuse('MIGRATION_MASS_MISMATCH', `${before} -> ${after}`);
  if (aliveIds(st).length !== beforeN) refuse('MIGRATION_COUNT_MISMATCH', `${beforeN} -> ${aliveIds(st).length}`);
  const fp = fingerprint(v1);
  st.migrated_from.push({ schema: v1.schema, fingerprint: fp, alias });
  return { state: st, records: recs, alias, superseded: { ...structuredClone(v1), superseded_by: `${SCHEMA}:${fp}` } };
}

export interface LifetimeMigrationOptions { taxon: string; colony_id: string | null; exact_age_colonies?: string[] }
export function migrateLifetime(ls: LifeState & { superseded_by?: string }, o: LifetimeMigrationOptions): { state: UState; records: URecord[]; alias: Record<string, string>; superseded: LifeState & { superseded_by: string } } {
  if (ls.schema !== 'antempire.wp5b-lifetime.v1') refuse('MIGRATION_WRONG_SCHEMA', ls.schema);
  if (ls.superseded_by) refuse('MIGRATION_ALREADY_SUPERSEDED', ls.superseded_by);
  if (ls.res.deterministic) refuse('MIGRATION_MEAN_FIELD', 'a deterministic projection has no members');
  const P: Precision = { reserve: 'exact', age_bin_days: ls.res.age_bin_days, exact_age_colonies: o.exact_age_colonies ?? [] };
  const st = emptyUnified(ls.seed, ls.day, P), recs: URecord[] = [], alias: Record<string, string> = {};
  const rows: { g: Omit<Group, 'members'>; ids: string[] }[] = [];
  const cohort = (id: string, legacy: string): CohortIdentity => ({ cohort_id: id, taxon: o.taxon, colony_id: o.colony_id, origin: { kind: 'migrated_lifetime', event_id: null, legacy_id: legacy } });
  const binKey = (u: LifeState['units'][number]) => `${u.region}|${u.stage}|${u.sub}|${u.age}|${u.rkey ?? '*'}`;
  let j = 0, before = 0, beforeN = 0;
  for (const u of [...ls.units].sort((a, b) => byStr(a.id ?? binKey(a), b.id ?? binKey(b)))) {
    before += u.reserve; beforeN += u.n;
    if (u.id !== null) {
      const id = `K.lt.i.${u.id}`; alias[`#${u.id}`] = id; st.cohorts.push(cohort(id, `#${u.id}`));
      rows.push({ g: { cohort_id: id, region: u.region, stage: u.stage, sub: u.sub, age_mode: 'exact', age: u.age, reserve: u.reserve }, ids: [u.id] });
      continue;
    }
    if (u.rkey === null) refuse('MIGRATION_POOLED_RESERVE', `${binKey(u)}: no exact per-member reserve (pooled is not an authoritative precision, #145 item 11)`);
    const rkey = u.rkey!;
    const id = `K.lt.${j++}`; alias[binKey(u)] = id; st.cohorts.push(cohort(id, binKey(u)));
    for (const r of u.roster) rows.push({ g: { cohort_id: id, region: u.region, stage: u.stage, sub: u.sub, age_mode: 'exact', age: r.age, reserve: rkey }, ids: [r.id] });
    const anon = u.n - u.roster.length;
    const m = P.age_bin_days === 1 || (o.colony_id !== null && P.exact_age_colonies.includes(o.colony_id)) ? 'exact' : 'bin';
    if (m === 'exact' && P.age_bin_days !== 1) refuse('MIGRATION_AGE_UNKNOWN', `${binKey(u)}: anonymous members only have a coarse bin`);
    rows.push({ g: { cohort_id: id, region: u.region, stage: u.stage, sub: u.sub, age_mode: m, age: u.age, reserve: rkey }, ids: Array.from({ length: anon }, (_, k) => latentId(id, k)) });
    recs.push(migrationRecord(ls.day, id, [...u.roster.map((r) => r.id), ...Array.from({ length: anon }, (_, k) => latentId(id, k))], `lifetime bin ${binKey(u)} -> ${id} (lossless: exact reserve ${u.rkey})`));
  }
  st.stocks = { ...ls.stocks }; st.sinks = { ...ls.sinks }; st.corpses = { ...ls.corpses }; st.producers = { ...ls.producers };
  before += total(ls.stocks) + total(ls.sinks) + total(ls.corpses) + total(ls.producers);
  st.retired = compress(ls.retired);
  st.groups = normalizeGroups(rows);
  st.cohorts.sort((a, b) => byStr(a.cohort_id, b.cohort_id));
  const after = st.groups.reduce((a, g) => a + g.reserve * expand(g.members).length, 0) + total(st.stocks) + total(st.sinks) + total(st.corpses) + total(st.producers);
  if (after !== before) refuse('MIGRATION_MASS_MISMATCH', `${before} -> ${after}`);
  if (aliveIds(st).length !== beforeN) refuse('MIGRATION_COUNT_MISMATCH', `${beforeN} -> ${aliveIds(st).length}`);
  const fp = fingerprint(ls);
  st.migrated_from.push({ schema: ls.schema, fingerprint: fp, alias });
  return { state: st, records: recs, alias, superseded: { ...structuredClone(ls), superseded_by: `${SCHEMA}:${fp}` } };
}

/** IDs alive in a legacy state (individuals and roster members; anonymous legacy members have no ID to compare) */
function legacyIds(x: WorldState | LifeState): string[] {
  if (x.schema === 'antempire.wp5-mixed-precision.v1') return [...x.individuals.map((i) => i.id), ...x.cohorts.flatMap((c) => c.roster.map((r) => r.id))];
  return x.units.flatMap((u) => (u.id !== null ? [u.id] : u.roster.map((r) => r.id)));
}
const legacyCount = (x: WorldState | LifeState) => (x.schema === 'antempire.wp5-mixed-precision.v1' ? x.individuals.length + x.cohorts.reduce((a, c) => a + c.count, 0) : x.units.reduce((a, u) => a + u.n, 0));
/**
 * Single-authority check (#145): a legacy state may coexist with the unified state only as a superseded snapshot that
 * this unified state recorded in migrated_from. Otherwise any organism alive in both is a DUAL_PRESENCE; a live legacy
 * state with anonymous members is reported as UNMIGRATED_LEGACY_POPULATION (they could be counted twice).
 */
export function checkSingleAuthority(u: UState, legacy: ((WorldState | LifeState) & { superseded_by?: string })[]): string[] {
  const v: string[] = [], alive = new Set(aliveIds(u)), fps = new Set(u.migrated_from.map((m) => m.fingerprint));
  for (const x of legacy) {
    const fp = fingerprint(x);
    if (x.superseded_by && fps.has(fp) && x.superseded_by === `${SCHEMA}:${fp}`) continue;
    if (x.superseded_by) { v.push(`FOREIGN_SUPERSEDED ${fp}: superseded by another ledger`); continue; }
    for (const id of legacyIds(x)) if (alive.has(id)) v.push(`DUAL_PRESENCE ${id}`);
    const anon = legacyCount(x) - legacyIds(x).length;
    if (legacyCount(x) > 0) v.push(`UNMIGRATED_LEGACY_POPULATION ${x.schema} ${fp}: ${legacyCount(x)} organisms (${anon} anonymous) still on a live second ledger`);
  }
  return v;
}
