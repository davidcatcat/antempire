/**
 * WP5b (OD-1b, docs/od1b-cohort-life-time.md): background organisms keep living while pooled in a cohort.
 * Counterexample tests for the ISOLATED prototype prototypes/mixed-precision/. Not engine behaviour.
 *   K0. DEFECT on the PR #126 ledger (a689e02): an individual demoted into a cohort keeps a frozen physiology snapshot;
 *       after 10 simulated days in the pool it is promoted back with the same age. This section characterises the
 *       defect (it must stay reproducible) and shows that auditLifeTimeContinuity now catches it.
 *   K1. the life-time cohort (lifetime.ts): the same demote -> 10 days -> promote cycle now ages, develops and feeds the
 *       pooled organism; the known ID comes back from the roster first; every day closes under the independent audit.
 *   K2. deliberately FROZEN variants (bins skip aging; aging record dropped; roster ages frozen; aging record forged)
 *       are caught; the honest step passes.
 *   K3. conservation: every representation, scenario and seed closes daily (counts, mass accounts, age total, IDs).
 *   K4. BROKEN variants: resurrection, duplicate ID, vanished member, invented birth, mass leak, stage regression.
 *   K5. promotion / demotion: roster first; sampled members get a new ID with the roll recorded; exact mode restores the
 *       demoted state exactly, pooled mode restores the floor share (error recorded, totals exact); refusals.
 *   K6. determinism and storage-order invariance.
 *   K7. individual vs cohort: the exact lumping agrees with individuals within Monte Carlo error over fixed seeds; the
 *       pooled reserve shows a detectable aggregation bias (a finding, reported in docs §6; not a target).
 *   K8. mean-field: real-valued projection conserves mass; no IDs.
 */
import assert from 'node:assert/strict';
import {
  runDay, cohortId, canonicalJson, draw, type WorldState,
} from '../prototypes/mixed-precision/ledger.ts';
import { auditLifeTimeContinuity } from '../prototypes/mixed-precision/audit.ts';
import { lifeDay, LifeRefusal, type LifeState, type LifeParams, type LifeRecord, type Unit, type LifeCommand } from '../prototypes/mixed-precision/lifetime.ts';
import { auditLifeDay, lifeMass } from '../prototypes/mixed-precision/lifetime-audit.ts';
import { runOnce, compare, initialState, SCENARIOS, SYNTH, MODES, tempOf } from '../prototypes/mixed-precision/lifetime-compare.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const trig = (kind: string) => ({ kind, driver_event_ids: [`contact.${kind}`] });

// ---------------------------------------------------------------- K0. frozen life time in the PR #126 cohort
function legacyWorld(): WorldState {
  return {
    schema: 'antempire.wp5-mixed-precision.v1', seed: 'wp5b-k0', day: 1,
    regions: [{ id: 'G', resolution: 'fine', in_garden: true }],
    individuals: [{ id: 'X-moth-1', taxon: 'moth', stage: 'larva', colony_id: null, region: 'G', physio: { age_d: 30 }, comp: { body: 900 } }],
    cohorts: [], stocks: [], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [],
    policy: { non_demotable_colonies: ['FOCAL'] },
  };
}
{
  let s = legacyWorld();
  const pooled = cohortId('G', 'moth', 'larva', null);
  s = runDay(s, [{ day: 1, minute: null, key: 'dem', kind: 'demote', individual: 'X-moth-1', trigger: trig('no_interaction') }]).state;
  for (let d = 2; d <= 10; d++) s = runDay(s, []).state;
  const back = runDay(s, [{ day: 11, minute: null, key: 'pro', kind: 'promote', cohort: pooled, trigger: trig('contact_with_focal') }]).state;
  const x = back.individuals.find((i) => i.id === 'X-moth-1');
  ok(x, 'the known ID comes back from the roster');
  // the defect: 10 days passed (day 1 -> day 11) but nothing about the organism advanced
  ok(x!.physio.age_d === 30, 'DEFECT reproduced: a pooled individual does not age (age_d still 30 after 10 days)');
  ok(x!.stage === 'larva', 'DEFECT reproduced: a pooled larva does not develop');
  ok(back.day - legacyWorld().day === 11, 'eleven days elapsed in the world clock');
  // K0b: the continuity check catches the frozen roster
  const pooledDay2 = runDay(legacyWorld(), [{ day: 1, minute: null, key: 'dem', kind: 'demote', individual: 'X-moth-1', trigger: trig('no_interaction') }]).state;
  const v = auditLifeTimeContinuity(pooledDay2, s);
  ok(v.length === 1 && v[0].startsWith('FROZEN_TIME X-moth-1'), `frozen roster caught: ${v.join(' | ')}`);
  const honest = structuredClone(s); honest.cohorts[0].roster[0].physio.age_d = 30 + (s.day - pooledDay2.day);
  ok(auditLifeTimeContinuity(pooledDay2, honest).length === 0, 'control: an organism that aged with the clock passes');
}

// ---------------------------------------------------------------- fixtures for the life-time cohort (TEST VALUES, not biology)
const TP: LifeParams = { ...structuredClone(SYNTH.params), stages: SYNTH.params.stages.map((x) => ({ ...x, hazard: 0 })), h_starve: 0, senescence_slope: 0 };
const closedDay = (a: LifeState, out: { state: LifeState; records: LifeRecord[] }, why: string) => {
  const v = auditLifeDay(a, out.records, out.state); assert.deepEqual(v, [], `${why}: ${v.slice(0, 4).join(' | ')}`); checks++; return out.state;
};
const caughtDay = (a: LifeState, r: LifeRecord[], b: LifeState, why: string, pat?: RegExp) => {
  const v = auditLifeDay(a, r, b); ok(v.length > 0 && (!pat || v.some((x) => pat.test(x))), `BROKEN variant must be caught: ${why} (${v.slice(0, 2).join(' | ')})`);
};
const refusedL = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof LifeRefusal && e.code === code, `${why}: expected ${code}, got ${(e as Error).message}`); return; }
  assert.fail(`${why}: expected refusal ${code}`);
};
const cause = (k: string) => ({ kind: k, driver_event_ids: [`contact.${k}`] });
function lifeWorld(reserve: 'exact' | 'pooled'): LifeState {
  return {
    schema: 'antempire.wp5b-lifetime.v1', seed: 'wp5b-k', day: 1, res: { age_bin_days: 1, reserve, deterministic: false, newborn: 'cohort' },
    units: [
      { region: 'G', stage: 1, sub: 0, age: 30, id: 'X1', n: 1, reserve: 5, rkey: null, age_sum: 30, roster: [] },
      { region: 'G', stage: 1, sub: 0, age: 30, id: null, n: 9, reserve: reserve === 'exact' ? 18 : 23, rkey: reserve === 'exact' ? 2 : null, age_sum: 270, roster: [] },
      { region: 'G', stage: 2, sub: 0, age: 40, id: null, n: 6, reserve: reserve === 'exact' ? 24 : 25, rkey: reserve === 'exact' ? 4 : null, age_sum: 240, roster: [] },
    ],
    stocks: { G: 1000 }, sinks: {}, corpses: {}, producers: {}, retired: [],
  };
}
const ids = (st: LifeState) => st.units.flatMap((u) => (u.id !== null ? [u.id] : u.roster.map((r) => r.id))).sort();
const findId = (st: LifeState, id: string) => st.units.find((u) => u.id === id || u.roster.some((r) => r.id === id));

// ---------------------------------------------------------------- K1. life time continues in the cohort
for (const mode of ['exact', 'pooled'] as const) {
  let st = lifeWorld(mode);
  const day = (cmds: LifeCommand[], temp = 50) => { const out = lifeDay(st, TP, { temp_c: temp, inflow: { G: 30 }, commands: cmds }); st = closedDay(st, out, `K1 ${mode} day ${st.day}`); return out.records; };
  day([{ kind: 'demote', key: 'dem', id: 'X1', cause: cause('no_interaction') }]);
  const pooled = findId(st, 'X1')!;
  ok(pooled.id === null && pooled.roster.some((r) => r.id === 'X1' && r.age === 31), `${mode}: X1 is a roster member of a bin and aged on the day it was pooled`);
  for (let d = 0; d < 9; d++) day([]);
  const recs = day([{ kind: 'promote', key: 'pro', region: 'G', stage: 2, n: 1, cause: cause('contact_with_focal') }]);
  const pr = recs.find((r) => r.kind === 'promote')!;
  ok(pr.restored![0].id === 'X1' && pr.restored![0].from === 'roster', `${mode}: promotion takes the known ID first (roster), not an anonymous member`);
  const x = st.units.find((u) => u.id === 'X1')!;
  ok(x && x.age === 41, `${mode}: X1 aged 11 days over 11 days (30 -> ${x?.age})`);
  ok(x.stage === 2, `${mode}: X1 developed nymph -> adult while pooled (test temperature drives p = 1 per sub-stage per day)`);
  ok(st.day === 12, 'eleven days elapsed');
}

// ---------------------------------------------------------------- K2. frozen-time variants are caught
{
  const a = initialState(SCENARIOS[1], 'cohort-pooled', 'k2');
  const out = lifeDay(a, SYNTH.params, { temp_c: tempOf(1), inflow: { G: 60 }, commands: [] });
  closedDay(a, out, 'K2 honest day');
  // (a) the PR #126 behaviour transplanted: bins skip aging, the aging record still claims everyone aged
  const frozen = structuredClone(out.state);
  for (const u of frozen.units) if (u.id === null) { u.age -= 1; u.age_sum -= u.n; }
  caughtDay(a, out.records, frozen, 'bins skip aging', /FROZEN_TIME/);
  // (b) same, and the aging record is forged to count only what was aged
  const forged = structuredClone(out.records); const g = forged.find((r) => r.kind === 'aging')!.aging!;
  const agedOnly = frozen.units.filter((u) => u.id !== null).reduce((s, u) => s + u.n, 0); g.count = agedOnly; g.age_sum_after = g.age_sum_before + agedOnly;
  caughtDay(a, forged, frozen, 'aging record forged to match the frozen bins', /FROZEN_TIME/);
  // (c) no aging record at all
  caughtDay(a, out.records.filter((r) => r.kind !== 'aging'), out.state, 'aging record dropped', /FROZEN_TIME/);
  // (d) a roster member's age frozen while its bin aged
  let m = lifeWorld('pooled');
  m = closedDay(m, lifeDay(m, TP, { temp_c: 50, inflow: { G: 30 }, commands: [{ kind: 'demote', key: 'd', id: 'X1', cause: cause('no_interaction') }] }), 'K2d pool');
  const o2 = lifeDay(m, TP, { temp_c: 24, inflow: { G: 30 }, commands: [] });
  const fr = structuredClone(o2.state); const u = fr.units.find((x) => x.roster.length > 0)!;
  const aged = u.age; u.roster[0].age -= 1;
  caughtDay(m, o2.records, fr, `roster age frozen inside an aged bin (bin age ${aged})`);
}

// ---------------------------------------------------------------- K3. conservation in every representation
for (const sc of SCENARIOS) for (const mode of MODES.filter((x) => x !== 'mean-field')) for (const seed of ['c1', 'c2', 'c3']) {
  let bad: string[] = [], days = 0, m0 = NaN, mEnd = NaN;
  runOnce({ ...sc, days: 25 }, mode, seed, (b, r, a) => { days++; if (Number.isNaN(m0)) m0 = lifeMass(b) - 0; mEnd = lifeMass(a); const v = auditLifeDay(b, r, a); if (v.length) bad = bad.concat(v.slice(0, 2)); });
  assert.deepEqual(bad, [], `K3 ${sc.name}/${mode}/${seed}: ${bad.slice(0, 3).join(' | ')}`); checks++;
  ok(days === 25 && m0 === mEnd, `K3 ${sc.name}/${mode}/${seed}: global mass constant over 25 days`);
}

// ---------------------------------------------------------------- K4. broken variants are caught
{
  let st = lifeWorld('pooled');
  st = closedDay(st, lifeDay(st, TP, { temp_c: 24, inflow: { G: 30 }, commands: [{ kind: 'demote', key: 'd', id: 'X1', cause: cause('no_interaction') }] }), 'K4 setup');
  const hz = { ...TP, stages: TP.stages.map((x) => ({ ...x, hazard: 1 })) };
  const out = lifeDay(st, hz, { temp_c: 24, inflow: { G: 30 }, commands: [] });
  const after = closedDay(st, out, 'K4 everyone dies');
  ok(after.units.length === 0 && after.retired.includes('X1') && (after.corpses.G ?? 0) > 0, 'deaths retire IDs and leave the body as a corpse account');
  // resurrection: X1 re-appears the next day without a record
  const nxt = lifeDay(after, TP, { temp_c: 24, inflow: { G: 0 }, commands: [] });
  const res = structuredClone(nxt.state); res.units.push({ region: 'G', stage: 2, sub: 0, age: 33, id: 'X1', n: 1, reserve: 0, rkey: null, age_sum: 33, roster: [] });
  caughtDay(after, nxt.records, res, 'resurrection of a retired ID', /resurrection|ID set|count/);
  const base = lifeWorld('pooled');
  const o = lifeDay(base, TP, { temp_c: 24, inflow: { G: 30 }, commands: [] });
  const dup = structuredClone(o.state); dup.units.push({ ...structuredClone(dup.units.find((u) => u.id === 'X1')!), region: 'H' });
  caughtDay(base, o.records, dup, 'duplicate ID', /DUPLICATE_ID/);
  const van = structuredClone(o.state); const b1 = van.units.find((u) => u.id === null && u.n > 2)!; b1.n -= 1; b1.age_sum -= b1.age;
  caughtDay(base, o.records, van, 'a member vanishes without a death record', /count/);
  const inv = structuredClone(o.state); const b2 = inv.units.find((u) => u.id === null)!; b2.n += 1; b2.age_sum += b2.age;
  caughtDay(base, o.records, inv, 'a member appears without a birth record', /count/);
  const leak = structuredClone(o.state); leak.units.find((u) => u.reserve > 0)!.reserve -= 1;
  caughtDay(base, o.records, leak, 'one reserve unit disappears', /mass/);
  const back = structuredClone(o.state); const xu = back.units.find((u) => u.id === 'X1')!; xu.sub = 0; xu.stage = 0;
  caughtDay(base, o.records, back, 'development goes back', /went back|count/);
}

// ---------------------------------------------------------------- K5. promotion / demotion
{
  for (const mode of ['exact', 'pooled'] as const) {
    let st = lifeWorld(mode);
    const recs: LifeRecord[] = [];
    const go = (cmds: LifeCommand[]) => { const out = lifeDay(st, TP, { temp_c: 9, inflow: { G: 0 }, commands: cmds }); recs.push(...out.records); st = closedDay(st, out, `K5 ${mode}`); };
    go([{ kind: 'demote', key: 'a', id: 'X1', cause: cause('no_interaction') }, { kind: 'promote', key: 'b', region: 'G', stage: 1, n: 3, cause: cause('contact_with_focal') }]);
    const dem = recs.find((r) => r.kind === 'demote')!.demoted!, pro = recs.find((r) => r.kind === 'promote')!.restored!;
    ok(pro[0].id === 'X1' && pro[0].from === 'roster' && pro.slice(1).every((r) => r.from === 'sampled' && r.roll !== null && /^M\.1\.b\./.test(r.id)), `${mode}: roster first, then sampled members with a recorded roll and a new ID`);
    ok(pro[0].stage === dem.stage && pro[0].sub === dem.sub && pro[0].age === dem.age, `${mode}: discrete state and exact age restored from the bin and roster`);
    if (mode === 'exact') ok(pro[0].reserve === dem.reserve, 'exact: the demoted reserve comes back exactly (lossless lumping)');
    else ok(pro[0].reserve === Math.floor((5 + 23) / 10) && dem.reserve === 5, `pooled: the reserve comes back as the floor share ${pro[0].reserve} (demoted ${dem.reserve}); error recorded, totals exact`);
  }
  const st = lifeWorld('pooled');
  refusedL(() => lifeDay(st, TP, { temp_c: 24, inflow: {}, commands: [{ kind: 'promote', key: 'p', region: 'G', stage: 1, n: 1, cause: { kind: 'x', driver_event_ids: [] } }] }), 'NO_CAUSE', 'promotion without a driver event');
  refusedL(() => lifeDay(st, TP, { temp_c: 24, inflow: {}, commands: [{ kind: 'promote', key: 'p', region: 'G', stage: 2, n: 7, cause: cause('c') }] }), 'INSUFFICIENT_COUNT', 'cannot promote more members than the bins hold (no organism from nowhere)');
  refusedL(() => lifeDay({ ...st, res: { ...st.res, age_bin_days: 7 } }, TP, { temp_c: 24, inflow: {}, commands: [{ kind: 'demote', key: 'd', id: 'X1', cause: cause('c') }] }), 'ROSTER_NEEDS_DAILY_AGE_BINS', 'known IDs are not dropped into wide age bins');
  refusedL(() => lifeDay(initialState(SCENARIOS[0], 'mean-field', 'mf'), SYNTH.params, { temp_c: 24, inflow: {}, commands: [{ kind: 'promote', key: 'p', region: 'G', stage: 2, n: 1, cause: cause('c') }] }), 'NO_IDS_IN_MEAN_FIELD', 'no promotion out of a deterministic projection');
  refusedL(() => lifeDay(st, TP, { temp_c: 24, inflow: {}, commands: [{ kind: 'migrate', key: 'm', region: 'G', stage: 2, n: 99, to: 'H', cause: cause('c') }] }), 'INSUFFICIENT_COUNT', 'cannot emigrate more than exist');
  // migration keeps IDs, counts and body mass (E at source, I at destination)
  const out = lifeDay(st, TP, { temp_c: 24, inflow: { G: 0 }, commands: [{ kind: 'migrate', key: 'm', region: 'G', stage: 1, n: 10, to: 'H', cause: cause('dispersal') }] });
  closedDay(st, out, 'K5 migration');
  ok(out.state.units.filter((u) => u.region === 'H').reduce((a, u) => a + u.n, 0) === 10 && findId(out.state, 'X1')!.region === 'H', 'migration moves the whole stage including the individual, keeping its ID');
}

// ---------------------------------------------------------------- K6. determinism and storage-order invariance
{
  const a = initialState(SCENARIOS[1], 'mixed', 'k6');
  const shuffle = <T,>(xs: T[], salt: string) => { const b = [...xs]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(draw('k6', salt, String(i)) * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
  let s1 = a, s2 = structuredClone(a);
  for (let d = 0; d < 12; d++) {
    const cmds: LifeCommand[] = d === 4 ? [{ kind: 'promote', key: 'p', region: 'G', stage: 2, n: 3, cause: cause('c') }] : [];
    s1 = lifeDay(s1, SYNTH.params, { temp_c: tempOf(d), inflow: { G: 60 }, commands: cmds }).state;
    const sh = structuredClone(s2); sh.units = shuffle(sh.units, `u${d}`).map((u: Unit) => ({ ...u, roster: shuffle(u.roster, `r${d}`) }));
    s2 = lifeDay(sh, SYNTH.params, { temp_c: tempOf(d), inflow: { G: 60 }, commands: [...cmds].reverse() }).state;
  }
  ok(canonicalJson(s1) === canonicalJson(s2), 'storage order of units and rosters never changes the outcome');
  ok(canonicalJson(runOnce(SCENARIOS[2], 'individual', 'z')) === canonicalJson(runOnce(SCENARIOS[2], 'individual', 'z')), 'same seed, same result');
  ok(ids(s1).length > 0 && new Set(ids(s1)).size === ids(s1).length, 'IDs unique');
}

// ---------------------------------------------------------------- K7. individual vs cohort (fixed seeds; tolerance is statistical, not tuned)
{
  const seeds = Array.from({ length: 8 }, (_, i) => `k7-${i}`);
  const rows = compare(SCENARIOS.slice(0, 2).map((s) => ({ ...s, days: 30 })), seeds, ['individual', 'cohort-exact', 'cohort-pooled']);
  const ex = rows.filter((r) => r.mode === 'cohort-exact' && r.z !== null);
  const worst = Math.max(...ex.map((r) => Math.abs(r.z!)));
  ok(ex.length > 20 && worst < 4, `cohort-exact agrees with individuals within Monte Carlo error (max |z| = ${worst.toFixed(2)} over ${ex.length} metric comparisons)`);
  // finding (docs §6): pooling the reserve biases the run only when food limits (scarce); in the first 30 days of 'rich'
  // the population is not yet food-limited and the pooled run stays within Monte Carlo error
  const pooledScarce = rows.find((r) => r.mode === 'cohort-pooled' && r.scenario === 'scarce' && r.metric === 'births')!;
  ok(Math.abs(pooledScarce.z!) > 4, `pooled reserve under food limitation: detectable bias in births (scarce, z = ${pooledScarce.z!.toFixed(1)}; rel ${(pooledScarce.rel_err! * 100).toFixed(0)}%)`);
  const richPooled = rows.filter((r) => r.mode === 'cohort-pooled' && r.scenario === 'rich' && r.z !== null);
  const worstRich = Math.max(...richPooled.map((r) => Math.abs(r.z!)));
  ok(worstRich < 4, `pooled reserve without food limitation (rich, days 1-30): within Monte Carlo error (max |z| = ${worstRich.toFixed(2)})`);
}

// ---------------------------------------------------------------- K8. mean-field
{
  let st = initialState(SCENARIOS[1], 'mean-field', 'mf');
  const m0 = lifeMass(st);
  for (let d = 0; d < 30; d++) st = lifeDay(st, SYNTH.params, { temp_c: tempOf(st.day), inflow: { G: 60 }, commands: [] }).state;
  ok(Math.abs(lifeMass(st) - m0) < 1e-6 * Math.max(1, Math.abs(m0)) + 1e-6, 'mean-field conserves mass (real-valued)');
  ok(st.units.every((u) => u.id === null && u.roster.length === 0), 'mean-field has no IDs');
  ok(st.units.some((u) => !Number.isInteger(u.n)), 'mean-field counts are expectations (not integers): never fed to a ledger');
}

console.log(JSON.stringify({ wp5_cohort_lifetime: 'pass', checks }, null, 2));
