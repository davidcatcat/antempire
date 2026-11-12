/**
 * Issues #144 and #145 (Owner 2026-11-08): the camera must not change any organism's fate (distribution-only equality
 * is NOT accepted), and there is ONE authoritative ledger. Isolated prototype prototypes/mixed-precision/; not engine.
 *   R. reproduction on the legacy representations (3cad90e): lifetime.ts and the OD-1 v1 ledger give an organism a
 *      different random path as an individual than as a cohort member, so a promote/demote changes fates (R1, R2:
 *      pinned defects). Fallback: both now REFUSE observer causes for promote/demote (VIEW_CANNOT_CHANGE_RESOLUTION).
 *   C. the unified ledger (unified.ts): with any random view schedule (promote/demote of random members, several per
 *      day) and the same natural events, every day's authoritative state, every ledger record and every member's fate
 *      are BYTE-IDENTICAL to the run without a camera (many seeds, three scenarios, natural migrations); arbitrary
 *      re-splitting of storage groups and storage order do not matter; view actions conserve identity and change no
 *      authoritative byte; the view cannot raise a coarse member's precision.
 *   L. one ledger (#145): stable member IDs; cohort IDs never encode the stage (stage is a field, transitions are
 *      recorded); lifetime.ts supplies the rules and keeps no second copy in unified.ts; OD-1 v1 cohorts (stage in ID)
 *      and lifetime.ts states migrate with conservation and are then superseded (refused by their old step); dual
 *      presence is detected; no double counting.
 *   A. the independent audit (unified-audit.ts) catches deliberately broken states.
 *   P. precision: exact is the default; pooled reserve is refused; known IDs keep exact age next to coarse bins.
 *   E. coarse age bins: distribution error vs exact ages is MEASURED and printed (model output; no target).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lifeDay, LifeRefusal, type LifeState, type LifeCommand } from '../prototypes/mixed-precision/lifetime.ts';
import { SYNTH, SCENARIOS, tempOf, initialState as lifeInit } from '../prototypes/mixed-precision/lifetime-compare.ts';
import { runDay, cohortId, canonicalJson, draw, LedgerRefusal, type WorldState, type Command } from '../prototypes/mixed-precision/ledger.ts';
import { isViewCause } from '../prototypes/mixed-precision/view-guard.ts';
import { unifiedDay, applyView, authoritative, aliveIds, countOf, defaultPrecision, URefusal, type UState, type URecord, type MigrateCmd, type Precision } from '../prototypes/mixed-precision/unified.ts';
import { auditUnifiedDay, shapeViolations } from '../prototypes/mixed-precision/unified-audit.ts';
import { migrateOd1, migrateLifetime, checkSingleAuthority } from '../prototypes/mixed-precision/unified-migrate.ts';
import { unifiedInit, coarseError } from '../prototypes/mixed-precision/unified-compare.ts';
import { expand, compress, sizeOf } from '../prototypes/mixed-precision/members.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refused = (f: () => unknown, cls: new (...a: never[]) => Error, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof cls && (e as Error & { code: string }).code === code, `${why}: expected ${code}, got ${(e as Error).message}`); return; }
  assert.fail(`${why}: expected refusal ${code}`);
};
const VIEW = (what: string) => ({ kind: 'camera_focus', driver_event_ids: [`view:${what}`] });
const NATURAL = (what: string) => ({ kind: 'interaction_need', driver_event_ids: [`contact.${what}`] });

// ---------------------------------------------------------------- R1. lifetime.ts (pinned defect + fallback)
function r1World(seed: string): LifeState {
  const roster = Array.from({ length: 8 }, (_, j) => ({ id: `K${j}`, age: 25 }));
  return {
    schema: 'antempire.wp5b-lifetime.v1', seed, day: 1, res: { age_bin_days: 1, reserve: 'exact', deterministic: false, newborn: 'cohort' },
    units: [{ region: 'G', stage: 2, sub: 0, age: 25, id: null, n: 40, reserve: 160, rkey: 4, age_sum: 1000, roster }],
    stocks: { G: 0 }, sinks: {}, corpses: {}, producers: {}, retired: [],
  };
}
function r1Fates(seed: string, cause: { kind: string; driver_event_ids: string[] } | null): Record<string, number | null> {
  let st = r1World(seed);
  const death: Record<string, number | null> = Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`K${j}`, null]));
  let focused: string | null = null;
  for (let d = 0; d < 30; d++) {
    const cmds: LifeCommand[] = [];
    if (cause && st.day === 3) { const u = st.units.find((x) => x.roster.length > 0); if (u) { focused = u.roster[0].id; cmds.push({ kind: 'promote', key: 'p', region: 'G', stage: 2, n: 1, cause }); } }
    if (cause && st.day === 6 && focused && st.units.some((u) => u.id === focused)) cmds.push({ kind: 'demote', key: 'd', id: focused, cause });
    const out = lifeDay(st, SYNTH.params, { temp_c: tempOf(st.day), inflow: { G: 90 }, commands: cmds });
    for (const r of out.records) if (r.kind === 'death') for (const id of r.ids) if (id in death) death[id] = st.day;
    st = out.state;
  }
  return death;
}
{
  let differs = 0, first = '';
  for (let s = 1; s <= 10; s++) {
    const seed = `issue144-r1-${s}`, a = r1Fates(seed, null), b = r1Fates(seed, NATURAL('r1'));
    for (const id of Object.keys(a)) if (a[id] !== b[id]) { differs++; if (!first) first = `${seed} ${id}: death day ${a[id]} without, ${b[id]} with a promote/demote cycle`; }
  }
  console.log(`R1 lifetime.ts (legacy): ${differs} known-ID death days differ across 10 seeds after one promote/demote cycle; first: ${first}`);
  ok(differs > 0, 'DEFECT pinned: in lifetime.ts a promote/demote cycle changes the fate of the promoted organism (path depends on representation)');
  refused(() => r1Fates('issue144-r1-1', VIEW('r1')), LifeRefusal, 'VIEW_CANNOT_CHANGE_RESOLUTION', 'fallback: lifetime.ts refuses a view-driven promotion');
  const st = { ...r1World('x'), units: [...r1World('x').units, { region: 'G', stage: 2, sub: 0, age: 25, id: 'I1', n: 1, reserve: 4, rkey: null, age_sum: 25, roster: [] }] };
  refused(() => lifeDay(st, SYNTH.params, { temp_c: 24, inflow: {}, commands: [{ kind: 'demote', key: 'd', id: 'I1', cause: VIEW('d') }] }), LifeRefusal, 'VIEW_CANNOT_CHANGE_RESOLUTION', 'fallback: lifetime.ts refuses a view-driven demotion');
}
// ---------------------------------------------------------------- R2. OD-1 v1 ledger.ts (pinned defect + fallback)
function r2World(seed: string): WorldState {
  return {
    schema: 'antempire.wp5-mixed-precision.v1', seed, day: 1, regions: [{ id: 'G', resolution: 'fine', in_garden: true }], individuals: [],
    cohorts: [{ cohort_id: cohortId('G', 'aphid', 'adult', null), taxon: 'aphid', stage: 'adult', colony_id: null, region: 'G', count: 6, comp: { body: 60 },
      roster: Array.from({ length: 6 }, (_, j) => ({ id: `A${j}`, physio: {} })), next_serial: 0 }],
    stocks: [], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [], policy: { non_demotable_colonies: [] },
  };
}
{
  const C = cohortId('G', 'aphid', 'adult', null);
  const dead = (seed: string, trig: { kind: string; driver_event_ids: string[] } | null) => {
    let st = r2World(seed); const out: string[] = [];
    for (let d = 1; d <= 4; d++) {
      const cmds: Command[] = [{ day: d, minute: null, key: `nat${d}`, kind: 'death', subject: { cohort: C }, cause: 'predation' }];
      if (trig && d === 2) cmds.push({ day: d, minute: null, key: 'p', kind: 'promote', cohort: C, trigger: trig });
      if (trig && d === 3 && st.individuals[0]) cmds.push({ day: d, minute: null, key: 'd', kind: 'demote', individual: st.individuals[0].id, trigger: trig });
      const r = runDay(st, cmds); st = r.state;
      for (const x of r.records) if (x.kind === 'death') out.push(...x.identity.ids);
    }
    return out.join(',');
  };
  let differs = 0, first = '';
  for (let s = 1; s <= 10; s++) { const a = dead(`issue144-r2-${s}`, null), b = dead(`issue144-r2-${s}`, NATURAL('r2')); if (a !== b) { differs++; if (!first) first = `issue144-r2-${s}: natural deaths retire [${a}] without, [${b}] with a promote/demote cycle`; } }
  console.log(`R2 ledger.ts v1 (legacy): ${differs}/10 seeds retire different IDs; first: ${first}`);
  ok(differs > 0, 'DEFECT pinned: in the OD-1 v1 ledger a promote/demote cycle changes which member a later natural death retires');
  refused(() => dead('issue144-r2-1', VIEW('r2')), LedgerRefusal, 'VIEW_CANNOT_CHANGE_RESOLUTION', 'fallback: ledger.ts refuses a view-driven promotion');
  for (const c of [VIEW('x'), { kind: 'zoom', driver_event_ids: ['a'] }, { kind: 'follow.ant', driver_event_ids: ['a'] }, { kind: 'contact', driver_event_ids: ['camera:7'] }]) ok(isViewCause(c), `view cause detected: ${JSON.stringify(c)}`);
  for (const c of [NATURAL('x'), { kind: 'contact_with_focal', driver_event_ids: ['contact.1'] }, { kind: 'no_interaction', driver_event_ids: ['reviewed'] }]) ok(!isViewCause(c), `natural cause not mistaken for a view: ${c.kind}`);
}

// ---------------------------------------------------------------- C. camera invariance of the unified ledger
const P = SYNTH.params;
/** natural migrations (identical in both runs): a fixed schedule of nymph dispersal G -> H and back */
function naturalEvents(st: UState): MigrateCmd[] {
  const out: MigrateCmd[] = [];
  const n = (r: string, s: number) => st.groups.filter((g) => g.region === r && g.stage === s).reduce((a, g) => a + sizeOf(g.members), 0);
  if (st.day % 4 === 0 && n('G', 1) >= 3) out.push({ kind: 'migrate', key: `out${st.day}`, region: 'G', stage: 1, n: 3, to: 'H', cause: { kind: 'dispersal', driver_event_ids: [`synthetic.disperse.${st.day}`] } });
  if (st.day % 6 === 0 && n('H', 2) >= 1) out.push({ kind: 'migrate', key: `back${st.day}`, region: 'H', stage: 2, n: 1, to: 'G', cause: { kind: 'return', driver_event_ids: [`synthetic.return.${st.day}`] } });
  return out;
}
/** a random camera: 0-5 promote/demote actions per day on random living members (own seed, not the world's) */
function camera(st: UState, camSeed: string): { op: 'promote' | 'demote'; id: string }[] {
  const ops: { op: 'promote' | 'demote'; id: string }[] = [];
  const exact = st.groups.filter((g) => g.age_mode === 'exact').flatMap((g) => expand(g.members));
  const shown = new Set(expand(st.view.individual));
  const k = Math.floor(draw(camSeed, 'cam-k', `${st.day}`) * 6);
  for (let j = 0; j < k; j++) {
    const u = draw(camSeed, 'cam-op', `${st.day}|${j}`);
    if (u < 0.6) { const c = exact.filter((id) => !shown.has(id)); if (c.length) { const id = c[Math.floor(draw(camSeed, 'cam-id', `${st.day}|${j}`) * c.length)]; ops.push({ op: 'promote', id }); shown.add(id); } }
    else { const c = [...shown].sort(); if (c.length) { const id = c[Math.floor(draw(camSeed, 'cam-id', `${st.day}|${j}`) * c.length)]; ops.push({ op: 'demote', id }); shown.delete(id); } }
  }
  return ops;
}
/** per-member fate table from the records: every event a member took part in, by day */
function fates(recs: URecord[], into: Map<string, string[]>): void {
  for (const r of recs) {
    for (const id of expand(r.identity.members)) (into.get(id) ?? into.set(id, []).get(id)!).push(`${r.t.day}:${r.kind}${r.stage_change ? `>${r.stage_change.to}` : ''}`);
    for (const id of expand(r.parents ?? [])) (into.get(id) ?? into.set(id, []).get(id)!).push(`${r.t.day}:lay`);
  }
}
interface Run { daily: string[]; fate: string; views: number; shownDays: number; audits: number }
function runU(init: UState, days: number, inflow: number, camSeed: string | null, layoutSeed: string | null = null): Run {
  let st = init; const daily: string[] = [], fate = new Map<string, string[]>();
  let views = 0, shownDays = 0, audits = 0;
  for (let d = 0; d < days; d++) {
    if (camSeed) {
      const ops = camera(st, camSeed); views += ops.length;
      const before = canonicalJson(authoritative(st)), ids = canonicalJson(aliveIds(st).sort());
      st = applyView(st, ops);
      assert.equal(canonicalJson(authoritative(st)), before, 'a view action changed an authoritative byte');
      assert.equal(canonicalJson(aliveIds(st).sort()), ids, 'a view action changed the set of identities');
      if (st.view.individual.length) shownDays++;
    }
    const layout = layoutSeed ? (ws: { ids: string[] }[]) => {
      const ids = ws[0].ids, parts: string[][] = [[]];
      ids.forEach((id, j) => { if (j > 0 && draw(layoutSeed, 'layout', `${d}|${id}`) < 0.35) parts.push([]); parts[parts.length - 1].push(id); });
      return parts.reverse();
    } : undefined;
    const out = unifiedDay(st, P, { temp_c: tempOf(st.day), inflow: { G: inflow }, natural: naturalEvents(st) }, layout);
    const v = auditUnifiedDay(st, out.records, out.state);
    assert.deepEqual(v, [], `audit day ${st.day}: ${v.slice(0, 3).join(' | ')}`); audits++;
    fates(out.records, fate);
    st = out.state;
    daily.push(canonicalJson(out.records), canonicalJson(authoritative(st)));
  }
  return { daily, fate: canonicalJson([...fate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))), views, shownDays, audits };
}
{
  let pairs = 0, viewOps = 0, members = 0;
  const seeds = Array.from({ length: 6 }, (_, i) => `issue144-c-${i + 1}`);
  for (const sc of SCENARIOS) for (const seed of seeds) {
    const init = unifiedInit(sc, seed, defaultPrecision());
    const plain = runU(init, 30, sc.inflow, null);
    for (const cam of [`cam-a-${seed}`, `cam-b-${seed}`]) {
      const watched = runU(init, 30, sc.inflow, cam);
      ok(watched.views > 0 && watched.shownDays > 0, `${sc.name}/${seed}/${cam}: the camera actually promoted members (${watched.views} actions)`);
      for (let d = 0; d < plain.daily.length; d++) if (plain.daily[d] !== watched.daily[d]) assert.fail(`#144 VIOLATION ${sc.name}/${seed}/${cam}: ${d % 2 ? 'state' : 'records'} differ on day ${Math.floor(d / 2) + 1}`);
      ok(plain.fate === watched.fate, `${sc.name}/${seed}/${cam}: every member's fate identical with and without the camera`);
      pairs++; viewOps += watched.views;
    }
    members += JSON.parse(plain.fate).length;
  }
  console.log(`C1 unified ledger: ${pairs} camera/no-camera pairs (3 scenarios x 6 seeds x 2 random cameras, 30 days, natural migrations), ${viewOps} view actions, ${members} member fates: all byte-identical`);
  // control: the comparison is not vacuous - another seed changes the bytes
  {
    const init = unifiedInit(SCENARIOS[0], 'ctl', defaultPrecision());
    const a = runU(init, 10, 240, null), b = runU({ ...init, seed: 'ctl-2' }, 10, 240, null);
    ok(a.fate !== b.fate && a.daily.some((x, d) => x !== b.daily[d]), 'control: another seed gives other fates (the comparison can fail)');
  }
  // C2. coarse precision: known IDs may be shown, coarse members may not; invariance holds there too
  const coarse: Precision = { reserve: 'exact', age_bin_days: 7, exact_age_colonies: [] };
  for (const seed of ['issue144-c-coarse-1', 'issue144-c-coarse-2']) {
    const init = unifiedInit(SCENARIOS[1], seed, coarse, 4);
    const plain = runU(init, 25, SCENARIOS[1].inflow, null), watched = runU(init, 25, SCENARIOS[1].inflow, `cam-${seed}`);
    ok(watched.views > 0 && plain.daily.every((x, d) => x === watched.daily[d]) && plain.fate === watched.fate, `coarse ${seed}: identical with a camera on the known IDs (${watched.views} actions)`);
    const binMember = init.groups.find((g) => g.age_mode === 'bin')!;
    refused(() => applyView(init, [{ op: 'promote', id: expand(binMember.members)[0] }]), URefusal, 'VIEW_CANNOT_CHANGE_PRECISION', 'the view cannot give a coarse-age member an exact age');
  }
  // C3. arbitrary re-splitting of storage groups (individual / cohort layouts) gives the same bytes
  for (const seed of seeds.slice(0, 3)) {
    const init = unifiedInit(SCENARIOS[0], seed, defaultPrecision());
    const a = runU(init, 25, SCENARIOS[0].inflow, null), b = runU(init, 25, SCENARIOS[0].inflow, null, `layout-${seed}`);
    ok(a.daily.every((x, d) => x === b.daily[d]) && a.fate === b.fate, `${seed}: random storage re-splitting does not change any byte`);
  }
  // C4. storage order of groups and cohorts does not matter
  {
    const init = unifiedInit(SCENARIOS[0], 'order', defaultPrecision());
    const shuffled = { ...structuredClone(init), groups: [...init.groups].reverse(), cohorts: [...init.cohorts].reverse() };
    const x = unifiedDay(init, P, { temp_c: 24, inflow: { G: 240 }, natural: [] }), y = unifiedDay(shuffled, P, { temp_c: 24, inflow: { G: 240 }, natural: [] });
    ok(canonicalJson(x) === canonicalJson(y), 'storage order of groups and cohorts does not change the output');
  }
  // C5. view refusals and the observer cannot act as a natural event
  {
    const init = unifiedInit(SCENARIOS[0], 'v', defaultPrecision());
    refused(() => applyView(init, [{ op: 'promote', id: 'nobody' }]), URefusal, 'VIEW_UNKNOWN_MEMBER', 'unknown member');
    refused(() => applyView(init, [{ op: 'demote', id: aliveIds(init)[0] }]), URefusal, 'VIEW_NOT_PROMOTED', 'demote of a member not shown');
    refused(() => unifiedDay(init, P, { temp_c: 24, inflow: {}, natural: [{ kind: 'migrate', key: 'm', region: 'G', stage: 1, n: 1, to: 'H', cause: VIEW('m') }] }), URefusal, 'VIEW_IS_NOT_A_NATURAL_EVENT', 'a camera cause cannot move organisms');
    const shown = applyView(init, [{ op: 'promote', id: aliveIds(init)[3] }]);
    ok(sizeOf(shown.view.individual) === 1 && canonicalJson(authoritative(shown)) === canonicalJson(authoritative(init)), 'promotion is view-only: identity and every authoritative byte conserved');
  }
}

// ---------------------------------------------------------------- L. one authoritative ledger (#145)
{
  // L1. stable cohort identity; stage is a field; transitions recorded; a member keeps its cohort from egg to adult
  let st = unifiedInit(SCENARIOS[0], 'issue145-l1', defaultPrecision());
  const eggIds = new Set(st.groups.filter((g) => g.stage === 0).flatMap((g) => expand(g.members)));
  const cohortOf = (s: UState, id: string) => s.groups.find((g) => expand(g.members).includes(id))?.cohort_id;
  const firstCohort = new Map([...eggIds].map((id) => [id, cohortOf(st, id)]));
  let transitions = 0;
  for (let d = 0; d < 30; d++) {
    const out = unifiedDay(st, P, { temp_c: tempOf(st.day), inflow: { G: 240 }, natural: [] });
    transitions += out.records.filter((r) => r.kind === 'transition' && r.stage_change).length;
    st = out.state;
  }
  const adultsFromEggs = [...eggIds].filter((id) => st.groups.some((g) => g.stage === 2 && expand(g.members).includes(id)));
  ok(adultsFromEggs.length > 0 && adultsFromEggs.every((id) => cohortOf(st, id) === firstCohort.get(id)), `${adultsFromEggs.length} initial eggs became adults and kept their cohort ID`);
  ok(transitions > 0, `stage transitions are recorded events (${transitions})`);
  const stageNames = P.stages.map((s) => s.name);
  ok(st.cohorts.every((c) => !stageNames.some((n) => c.cohort_id.split('.').includes(n))) && st.cohorts.every((c) => !('stage' in c)), 'no cohort ID or cohort identity carries a stage');
  // L2. lifetime.ts is the only copy of the life rules (unified.ts books, lifetime.ts computes)
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const usrc = strip(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/mixed-precision/unified.ts'), 'utf8'));
  ok(/from '\.\/lifetime\.ts'/.test(usrc) && !/P\.(t_lower|senescence_slope|senescence_start|h_starve|dev_factor_hungry|crop_cap)/.test(usrc) && !/dd_required\s*[)/]/.test(usrc), 'unified.ts uses the lifetime.ts rules and keeps no copy of them');
}
{
  // L3. OD-1 v1 -> unified: stage-in-ID cohorts become stable identities; conservation; no double counting
  const v1: WorldState = {
    schema: 'antempire.wp5-mixed-precision.v1', seed: 'issue145-l3', day: 5, regions: [{ id: 'G', resolution: 'fine', in_garden: true }],
    individuals: [{ id: 'X-moth-1', taxon: 'moth', stage: 'nymph', colony_id: null, region: 'G', physio: { age_d: 12 }, comp: { body: 9 } }],
    cohorts: [
      { cohort_id: cohortId('G', 'aphid', 'adult', null), taxon: 'aphid', stage: 'adult', colony_id: null, region: 'G', count: 10, comp: { body: 47 }, roster: [{ id: 'R2', physio: {} }, { id: 'R1', physio: {} }, { id: 'R3', physio: {} }], next_serial: 0 },
      { cohort_id: cohortId('G', 'aphid', 'nymph', null), taxon: 'aphid', stage: 'nymph', colony_id: null, region: 'G', count: 6, comp: { body: 18 }, roster: [], next_serial: 0 },
    ],
    stocks: [{ stock_id: 'honeydew', region: 'G', amount: 100, origin_event_id: null }, { stock_id: 'corpse.4.x.body', region: 'G', amount: 7, origin_event_id: '4.x' }],
    sinks: { decomposition: 3 }, producers: { plant: -110 }, retired: ['Z9'], scenario_records: [], used_scenario_records: [], policy: { non_demotable_colonies: [] },
  };
  const opts = { stages: ['egg', 'nymph', 'adult'], reserve_comp: 'body', edible_stocks: ['honeydew'],
    ages: { [cohortId('G', 'aphid', 'adult', null)]: { days: 30, basis: '遊戲假設 (test fixture)' }, [cohortId('G', 'aphid', 'nymph', null)]: { days: 9, basis: '遊戲假設 (test fixture)' } } };
  const m = migrateOd1(v1, opts);
  const u = m.state;
  ok(countOf(u) === 17 && aliveIds(u).length === new Set(aliveIds(u)).size, 'v1 -> unified: 10 + 6 + 1 organisms, each exactly once');
  for (const id of ['R1', 'R2', 'R3', 'X-moth-1']) ok(aliveIds(u).filter((x) => x === id).length === 1, `known ID ${id} kept exactly once`);
  ok(Object.values(m.alias).every((id) => !/egg|nymph|adult/.test(id)), `new cohort IDs carry no stage: ${Object.values(m.alias).join(', ')}`);
  const stageCount = (s: number) => u.groups.filter((g) => g.stage === s).reduce((a, g) => a + sizeOf(g.members), 0);
  ok(stageCount(2) === 10 && stageCount(1) === 7, 'per-stage counts agree with the v1 cohorts (no contradictory counts)');
  const adultRes = u.groups.filter((g) => g.stage === 2).reduce((a, g) => a + g.reserve * sizeOf(g.members), 0);
  ok(adultRes === 47 && u.stocks.G === 100 && u.inert_stocks['corpse.4.x.body'].amount === 7, 'pooled reserve split exactly (47 over 10); edible and inert stocks carried');
  ok(expand(u.retired).includes('Z9') && shapeViolations(u).length === 0, 'retired IDs carried; migrated state passes the shape audit');
  ok(m.records.some((r) => r.note?.includes('approximation')), 'the pooled-reserve split is recorded as an approximation');
  refused(() => runDay(m.superseded, []), LedgerRefusal, 'SUPERSEDED_BY_UNIFIED_LEDGER', 'the superseded v1 state can no longer be advanced');
  ok(checkSingleAuthority(u, [m.superseded]).length === 0, 'a superseded snapshot recorded in migrated_from is not a second authority');
  const dual = checkSingleAuthority(u, [v1]);
  ok(dual.some((x) => x === 'DUAL_PRESENCE R1') && dual.some((x) => x.startsWith('UNMIGRATED_LEGACY_POPULATION')), `an un-superseded v1 copy is reported as dual presence (${dual.length} findings)`);
  refused(() => migrateOd1(m.superseded, opts), URefusal, 'MIGRATION_ALREADY_SUPERSEDED', 'a state migrates once');
  refused(() => migrateOd1(v1, { ...opts, ages: {} }), URefusal, 'MIGRATION_AGE_UNKNOWN', 'unknown v1 ages are not invented');
  refused(() => migrateOd1(v1, { ...opts, stages: ['egg', 'adult'] }), URefusal, 'MIGRATION_UNKNOWN_STAGE', 'unknown stage name');
  refused(() => migrateOd1({ ...v1, individuals: [{ ...v1.individuals[0], comp: { body: 9, gut: 1 } }] }, opts), URefusal, 'MIGRATION_UNMAPPED_COMPARTMENT', 'no silent loss of an unmapped compartment');
  // the migrated world runs and closes under the audit; population is counted once
  let st = u; const P1 = { ...P };
  for (let d = 0; d < 10; d++) {
    const out = unifiedDay(st, P1, { temp_c: tempOf(st.day), inflow: { G: 60 }, natural: [] });
    const v = auditUnifiedDay(st, out.records, out.state); assert.deepEqual(v, [], v.join(' | ')); checks++;
    st = out.state;
  }
  ok(checkSingleAuthority(st, [m.superseded]).length === 0, 'after 10 unified days the population is still booked in one ledger only');
}
{
  // L4. lifetime.ts state -> unified (lossless in exact mode); pooled / mean-field refused; old step refused
  let ls = lifeInit(SCENARIOS[0], 'cohort-exact', 'issue145-l4');
  ls = { ...ls, units: [...ls.units, { region: 'G', stage: 2, sub: 0, age: 25, id: 'IND1', n: 1, reserve: 4, rkey: null, age_sum: 25, roster: [] }] };
  for (let d = 0; d < 8; d++) ls = lifeDay(ls, P, { temp_c: tempOf(ls.day), inflow: { G: 240 }, commands: [] }).state;
  const n0 = ls.units.reduce((a, x) => a + x.n, 0);
  const m = migrateLifetime(ls, { taxon: 'synthetic', colony_id: null });
  ok(countOf(m.state) === n0 && aliveIds(m.state).includes('IND1'), `lifetime -> unified: ${n0} members, individual ID kept`);
  ok(m.state.groups.every((g) => g.age_mode === 'exact'), 'daily age bins migrate as exact ages');
  refused(() => lifeDay(m.superseded, P, { temp_c: 24, inflow: {}, commands: [] }), LifeRefusal, 'SUPERSEDED_BY_UNIFIED_LEDGER', 'the superseded lifetime state can no longer be advanced');
  refused(() => migrateLifetime(lifeInit(SCENARIOS[0], 'cohort-pooled', 'p'), { taxon: 's', colony_id: null }), URefusal, 'MIGRATION_POOLED_RESERVE', 'pooled reserve has no exact members to migrate');
  refused(() => migrateLifetime(lifeInit(SCENARIOS[0], 'mean-field', 'p'), { taxon: 's', colony_id: null }), URefusal, 'MIGRATION_MEAN_FIELD', 'a mean-field projection has no members');
  let st = m.state;
  for (let d = 0; d < 5; d++) { const out = unifiedDay(st, P, { temp_c: tempOf(st.day), inflow: { G: 240 }, natural: [] }); assert.deepEqual(auditUnifiedDay(st, out.records, out.state), []); checks++; st = out.state; }
}

// ---------------------------------------------------------------- A. broken variants are caught
{
  const s0 = unifiedInit(SCENARIOS[0], 'issue145-a', { reserve: 'exact', age_bin_days: 7, exact_age_colonies: [] }, 3);
  const out = unifiedDay(s0, P, { temp_c: 24, inflow: { G: 240 }, natural: [] });
  assert.deepEqual(auditUnifiedDay(s0, out.records, out.state), []); checks++;
  const caught = (why: string, f: (s: UState, r: URecord[]) => void, pat: RegExp) => {
    const s = structuredClone(out.state), r = structuredClone(out.records); f(s, r);
    const v = auditUnifiedDay(s0, r, s); ok(v.some((x) => pat.test(x)), `BROKEN variant caught: ${why} (${v.slice(0, 2).join(' | ')})`);
  };
  const big = (s: UState) => s.groups.reduce((a, g) => (sizeOf(g.members) > sizeOf(a.members) ? g : a));
  caught('a member vanishes without a death record', (s) => { const g = big(s); g.members = compress(expand(g.members).slice(1)); }, /U4 VANISHED|U2 COUNT/);
  caught('a retired ID is alive again', (s) => { s.groups[0].members = compress([...expand(s.groups[0].members), 'Z.dead']); s.retired = compress([...expand(s.retired), 'Z.dead']); }, /ALIVE_AND_RETIRED/);
  caught('one ID in two groups (two ledgers)', (s) => { const id = expand(s.groups[0].members)[0]; s.groups[1].members = compress([...expand(s.groups[1].members), id]); }, /DUPLICATE_ID/);
  caught('mass leak', (s) => { big(s).reserve += 1; }, /U3 MASS/);
  caught('forged aging count', (_s, r) => { r.find((x) => x.kind === 'aging')!.identity.count += 1; }, /U6/);
  caught('frozen exact age of a known ID', (s) => { for (const g of s.groups) if (g.age_mode === 'exact' && expand(g.members).some((id) => id.startsWith('KNOWN'))) g.age -= 1; }, /U5 AGE/);
  caught('a member changes cohort (stage-in-ID style re-filing)', (s) => { s.cohorts.push({ cohort_id: 'C|G|synthetic|adult|-', taxon: 'synthetic', colony_id: null, origin: { kind: 'initial', event_id: null, legacy_id: null } }); big(s).cohort_id = 'C|G|synthetic|adult|-'; }, /U5 COHORT_CHANGED|U7/);
  caught('the view shows a coarse-age member', (s) => { const g = s.groups.find((x) => x.age_mode === 'bin')!; s.view.individual = compress([expand(g.members)[0]]); }, /VIEW_SHOWS_COARSE/);
  caught('an invented birth', (s) => { s.groups.push({ ...s.groups[0], members: ['GHOST'] }); }, /U4 APPEARED/);
}

// ---------------------------------------------------------------- P. precision (#145 items 11 and 14)
{
  ok(defaultPrecision().reserve === 'exact' && defaultPrecision().age_bin_days === 1, 'exact is the default precision');
  const s = unifiedInit(SCENARIOS[0], 'p', defaultPrecision());
  refused(() => unifiedDay({ ...s, precision: { ...s.precision, reserve: 'pooled' as 'exact' } }, P, { temp_c: 24, inflow: {}, natural: [] }), URefusal, 'PRECISION_POOLED_NOT_AUTHORITATIVE', 'pooled reserve is not an authoritative precision');
  // known IDs keep exact age inside a coarse-bin cohort; a colony listed in exact_age_colonies is born exact
  let st = unifiedInit(SCENARIOS[0], 'p-coexist', { reserve: 'exact', age_bin_days: 7, exact_age_colonies: [] }, 4);
  const known = expand(st.groups.filter((g) => g.age_mode === 'exact').flatMap((g) => g.members));
  const age0 = new Map(known.map((id) => [id, st.groups.find((g) => expand(g.members).includes(id))!.age]));
  ok(known.length === 4 && st.groups.some((g) => g.age_mode === 'bin' && g.cohort_id === st.groups.find((x) => x.age_mode === 'exact')!.cohort_id), 'known IDs (exact) and anonymous coarse bins coexist in the same cohort');
  for (let d = 0; d < 20; d++) { const out = unifiedDay(st, P, { temp_c: tempOf(st.day), inflow: { G: 240 }, natural: [] }); assert.deepEqual(auditUnifiedDay(st, out.records, out.state), []); st = out.state; }
  const alive = known.filter((id) => aliveIds(st).includes(id));
  ok(alive.every((id) => st.groups.find((g) => expand(g.members).includes(id))!.age === age0.get(id)! + 20), `${alive.length} surviving known IDs aged exactly 20 days inside a 7-day-bin world`);
  const colonyWorld = unifiedInit(SCENARIOS[2], 'p-col', { reserve: 'exact', age_bin_days: 7, exact_age_colonies: ['FOCAL'] });
  const cw = { ...colonyWorld, cohorts: colonyWorld.cohorts.map((c) => ({ ...c, colony_id: 'FOCAL' })) };
  let cst: UState = cw;
  for (let d = 0; d < 10; d++) cst = unifiedDay(cst, P, { temp_c: 24, inflow: { G: 60 }, natural: [] }).state;
  const bornGroups = cst.groups.filter((g) => cst.cohorts.find((c) => c.cohort_id === g.cohort_id)!.origin.kind === 'birth');
  ok(bornGroups.length > 0 && bornGroups.every((g) => g.age_mode === 'exact'), `members of a colony in exact_age_colonies are born with exact age in a coarse world (${bornGroups.length} groups)`);
}

// ---------------------------------------------------------------- E. coarse-bin distribution error (measured, no target)
{
  const rows = coarseError(Array.from({ length: 6 }, (_, i) => `issue145-e-${i + 1}`), SCENARIOS, 40);
  ok(rows.length === 21 && rows.every((r) => Number.isFinite(r.exact_mean) && Number.isFinite(r.coarse_mean)), 'coarse-bin error table computed');
  for (const r of rows) console.log(`E ${r.scenario} ${r.metric}: exact ${r.exact_mean.toFixed(1)} ± ${r.exact_sd.toFixed(1)}, 7-day bins ${r.coarse_mean.toFixed(1)} [${r.rel_err === null ? '—' : (100 * r.rel_err).toFixed(0) + '%'}; z ${r.z === null ? '—' : r.z.toFixed(1)}]`);
}

console.log(JSON.stringify({ wp5_camera_invariance: 'pass', checks }, null, 2));
