/**
 * Issue #144 (Owner P0, formal integration blocker): the camera must not change any organism's fate.
 * Same world + seed + params + natural events, with and without observation-driven promote/demote: every
 * authoritative outcome (who dies, develops, reproduces, when) must be IDENTICAL, not merely equal in distribution.
 *   R1. reproduction on the life-time cohort (lifetime.ts, 3cad90e): a view-driven promote -> demote cycle changes
 *       the fate of the very organism that was looked at.
 *   R2. reproduction on the OD-1 v1 ledger (ledger.ts, a689e02): a view-driven promotion changes which roster member a
 *       later natural cohort death retires.
 */
import assert from 'node:assert/strict';
import { lifeDay, type LifeState, type LifeCommand } from '../prototypes/mixed-precision/lifetime.ts';
import { SYNTH, tempOf } from '../prototypes/mixed-precision/lifetime-compare.ts';
import { runDay, cohortId, type WorldState, type Command } from '../prototypes/mixed-precision/ledger.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const VIEW = (what: string) => ({ kind: 'camera_focus', driver_event_ids: [`view:${what}`] });

// ---------------------------------------------------------------- R1. lifetime.ts: fate of a looked-at organism
/** a pooled bin of 40 adults with 8 known roster IDs (exact reserve, daily age bins = the lossless cohort mode) */
function r1World(seed: string): LifeState {
  const roster = Array.from({ length: 8 }, (_, j) => ({ id: `K${j}`, age: 25 }));
  return {
    schema: 'antempire.wp5b-lifetime.v1', seed, day: 1, res: { age_bin_days: 1, reserve: 'exact', deterministic: false, newborn: 'cohort' },
    units: [{ region: 'G', stage: 2, sub: 0, age: 25, id: null, n: 40, reserve: 160, rkey: 4, age_sum: 1000, roster }],
    stocks: { G: 0 }, sinks: {}, corpses: {}, producers: {}, retired: [],
  };
}
/** fate of every known ID: day of death (null = alive at the end) */
function r1Fates(seed: string, view: (st: LifeState) => LifeCommand[]): Record<string, number | null> {
  let st = r1World(seed);
  const death: Record<string, number | null> = Object.fromEntries(Array.from({ length: 8 }, (_, j) => [`K${j}`, null]));
  for (let d = 0; d < 30; d++) {
    const out = lifeDay(st, SYNTH.params, { temp_c: tempOf(st.day), inflow: { G: 90 }, commands: view(st) });
    for (const r of out.records) if (r.kind === 'death') for (const id of r.ids) if (id in death) death[id] = st.day;
    st = out.state;
  }
  return death;
}
{
  let differs = 0, firstDiff = '';
  for (let s = 1; s <= 10; s++) {
    const seed = `issue144-r1-${s}`;
    const plain = r1Fates(seed, () => []);
    // the camera looks at the first living known ID on day 3 and looks away on day 6
    let focused: string | null = null;
    const watched = r1Fates(seed, (st) => {
      if (st.day === 3) { const u = st.units.find((x) => x.roster.length > 0); if (!u) return []; focused = u.roster[0].id; return [{ kind: 'promote', key: 'cam', region: 'G', stage: 2, n: 1, cause: VIEW('promote') }]; }
      if (st.day === 6 && focused && st.units.some((u) => u.id === focused)) return [{ kind: 'demote', key: 'cam', id: focused, cause: VIEW('demote') }];
      return [];
    });
    for (const id of Object.keys(plain)) if (plain[id] !== watched[id]) { differs++; if (!firstDiff) firstDiff = `${seed} ${id}: death day ${plain[id]} without camera, ${watched[id]} with camera`; }
  }
  console.log(`R1 lifetime.ts: ${differs} known-ID fates differ across 10 seeds; first: ${firstDiff}`);
  ok(differs === 0, `#144 camera changed fates on lifetime.ts: ${firstDiff}`);
}

// ---------------------------------------------------------------- R2. ledger.ts v1: a later natural death hits another member
function r2World(seed: string): WorldState {
  return {
    schema: 'antempire.wp5-mixed-precision.v1', seed, day: 1,
    regions: [{ id: 'G', resolution: 'fine', in_garden: true }], individuals: [],
    cohorts: [{ cohort_id: cohortId('G', 'aphid', 'adult', null), taxon: 'aphid', stage: 'adult', colony_id: null, region: 'G', count: 6, comp: { body: 60 },
      roster: Array.from({ length: 6 }, (_, j) => ({ id: `A${j}`, physio: {} })), next_serial: 0 }],
    stocks: [], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [], policy: { non_demotable_colonies: [] },
  };
}
{
  const C = cohortId('G', 'aphid', 'adult', null);
  const natural = (day: number): Command[] => [{ day, minute: null, key: `nat${day}`, kind: 'death', subject: { cohort: C }, cause: 'predation' }];
  let differs = 0, firstDiff = '';
  for (let s = 1; s <= 10; s++) {
    const seed = `issue144-r2-${s}`;
    const dead = (camera: boolean) => {
      let st = r2World(seed); const out: string[] = [];
      for (let d = 1; d <= 4; d++) {
        const cmds: Command[] = [...natural(d)];
        if (camera && d === 2) cmds.push({ day: d, minute: null, key: 'cam', kind: 'promote', cohort: C, trigger: VIEW('promote') });
        if (camera && d === 3 && st.individuals[0]) cmds.push({ day: d, minute: null, key: 'camd', kind: 'demote', individual: st.individuals[0].id, trigger: VIEW('demote') });
        const r = runDay(st, cmds); st = r.state;
        for (const x of r.records) if (x.kind === 'death') out.push(...x.identity.ids);
      }
      return out.join(',');
    };
    const a = dead(false), b = dead(true);
    if (a !== b) { differs++; if (!firstDiff) firstDiff = `${seed}: natural deaths retire [${a}] without camera, [${b}] with camera`; }
  }
  console.log(`R2 ledger.ts: ${differs}/10 seeds retire different IDs; first: ${firstDiff}`);
  ok(differs === 0, `#144 camera changed fates on ledger.ts: ${firstDiff}`);
}

console.log(`wp5-camera-invariance: ${checks} checks passed`);
