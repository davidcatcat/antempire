/**
 * WP5 complexity probe (NOT a test, NOT engine). Measures the prototype ledger's cost per simulated day on THIS machine
 * for synthetic workloads. The workload sizes (events per individual, cohorts, patches) are engineering assumptions for a
 * cost estimate, not biology. Usage: node prototypes/mixed-precision/bench.ts
 */
import { performance } from 'node:perf_hooks';
import { runDay, cohortId, canonicalJson, type WorldState, type Command } from './ledger.ts';
import { auditDay } from './audit.ts';

function build(nFocal: number, patches: number, taxa: number, stages: number): WorldState {
  const regions = [{ id: 'G', resolution: 'fine' as const, in_garden: true }, ...Array.from({ length: patches }, (_, p) => ({ id: `P${p}`, resolution: 'coarse' as const, in_garden: false }))];
  const individuals = Array.from({ length: nFocal }, (_, i) => ({ id: `W${i}`, taxon: 'ant', stage: 'worker', colony_id: 'F', region: 'G', physio: { age_d: 10, hunger_days: 0 }, comp: { crop_sugar: 1_000_000, body_protein: 500_000 } }));
  const cohorts = [];
  for (const r of regions) for (let t = 0; t < taxa; t++) for (let s = 0; s < stages; s++) cohorts.push({ cohort_id: cohortId(r.id, `tx${t}`, `st${s}`, null), taxon: `tx${t}`, stage: `st${s}`, colony_id: null, region: r.id, count: 1000, comp: { body: 10_000_000 }, roster: [], next_serial: 0 });
  return { schema: 'antempire.wp5-mixed-precision.v1', seed: 'bench', day: 1, regions, individuals, cohorts, stocks: [{ stock_id: 'food.G', region: 'G', amount: 1e12, origin_event_id: null }], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [], policy: { non_demotable_colonies: ['F'] } };
}
/** per focal individual: 18 food transfers + 1 exit + 1 return (~20/day, cf. ~20 events/worker/day measured on the current engine);
 *  per cohort: 1 birth, 1 death, 1 migration; promotions: 5% of focal size, demoted again the same day. */
function commands(s: WorldState, nFocal: number): Command[] {
  const c: Command[] = []; let k = 0; const key = () => `k${k++}`;
  for (let i = 0; i < nFocal; i++) {
    for (let j = 0; j < 9; j++) {
      c.push({ day: s.day, minute: 10 + j, key: key(), kind: 'food_transfer', from: 'stock:food.G', to: `org:W${i}:crop_sugar`, amount: 7, cause: 'collect' });
      c.push({ day: s.day, minute: 10 + j, key: key(), kind: 'food_transfer', from: `org:W${i}:crop_sugar`, to: `org:W${(i + 1) % nFocal}:crop_sugar`, amount: 3, cause: 'trophallaxis' });
    }
    c.push({ day: s.day, minute: 100, key: key(), kind: 'move', individual: `W${i}`, to: 'P0', cause: { kind: 'foraging_trip', driver_event_ids: ['x'] } });
    c.push({ day: s.day, minute: 200, key: key(), kind: 'move', individual: `W${i}`, to: 'G', cause: { kind: 'return_to_nest', driver_event_ids: ['x'] } });
  }
  for (const co of s.cohorts) {
    c.push({ day: s.day, minute: null, key: key(), kind: 'birth', parent: { cohort: co.cohort_id }, taxon: co.taxon, stage: co.stage, colony_id: null, as: 'cohort', endowment: [{ from: `cohort:${co.cohort_id}:body`, comp: 'body', amount: 10 }] });
    c.push({ day: s.day, minute: null, key: key(), kind: 'death', subject: { cohort: co.cohort_id }, cause: 'cohort_hazard' });
    const to = co.region === 'G' ? 'P0' : 'G';
    c.push({ day: s.day, minute: 50, key: key(), kind: 'cohort_move', cohort: co.cohort_id, n: 1, to, cause: { kind: 'dispersal', driver_event_ids: ['x'] } });
  }
  return c;
}
const rows = [];
for (const [nFocal, patches, taxa, stages] of [[10, 12, 6, 3], [100, 12, 6, 3], [1000, 12, 6, 3], [1000, 50, 10, 4]] as const) {
  const s = build(nFocal, patches, taxa, stages), cmds = commands(s, nFocal);
  runDay(s, cmds); // warm-up
  const reps = nFocal >= 1000 ? 3 : 10; let tRun = 0, tAudit = 0;
  for (let r = 0; r < reps; r++) {
    const a = performance.now(); const out = runDay(s, cmds); const b = performance.now(); const v = auditDay(s, out.records, out.state); const c = performance.now();
    if (v.length) throw new Error(v[0]); tRun += b - a; tAudit += c - b;
  }
  const bytes = canonicalJson(s).length;
  rows.push({ focal: nFocal, cohorts: s.cohorts.length, commands_per_day: cmds.length, ms_run_per_day: +(tRun / reps).toFixed(1), ms_audit_per_day: +(tAudit / reps).toFixed(1), state_json_kB: +(bytes / 1024).toFixed(1), bytes_per_focal_individual: Math.round(canonicalJson(s.individuals[0]).length), bytes_per_cohort: Math.round(canonicalJson(s.cohorts[0]).length) });
}
console.log(JSON.stringify(rows, null, 1));
