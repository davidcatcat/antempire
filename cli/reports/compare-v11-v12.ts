/**
 * Rules-update evidence for v2-review.12: injury types. Migrates the REAL Day14 saves (read only; nothing is
 * written) with the v11 rules (migration switch off, every repair multiplier 1) and with v12, then runs the 20
 * fixed seeds × Day15–134 from each and compares day by day. Also lists the type each injured worker gets.
 * Writes reports/rules-update-v12-injury-types.json. Diagnostic only: never touches saves/ or journal/.
 *   node cli/reports/compare-v11-v12.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { migrationState, simulateDay, ENGINE_VERSION } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { approvedChanges, revertChange } from '../../tests/lib/approved-changes.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const V12 = 'antempire.v2-review.12-injury-types';
const main = readJson('saves/main.json'), world = readJson('saves/world-state.json'), clim = readJson('data/taichung-climatology-1991-2020.json');
const bundles = { v11: loadBundle(), v12: loadBundle() };
for (const ch of approvedChanges().filter((x) => x.rules_version === V12)) revertChange(bundles.v11, ch);
const strip = (st: Any) => { const c = structuredClone(st); for (const w of c.population.workers) { delete w.injury_type; delete w.injury_body_part; delete w.injury_record; } return c; };
const rows: Any[] = [];
// What-if for the Owner decision only (NOT a rule): unrecorded old injuries treated as permanent.
const whatIf = loadBundle(); (whatIf.species['pheidole-megacephala'] as Any).worker_lifespan.injury_repair_multiplier_unknown.value = 0;
const whatIfRows: Any[] = [];
for (let seed = 15032026; seed < 15032046; seed++) {
  const r: Any = { seed };
  let differingSummaryDays = 0, differingStateDaysIgnoringInjuryFields = 0;
  const st: Any = { v11: migrationState(main, world, clim, bundles.v11), v12: migrationState(main, world, clim, bundles.v12) };
  st.v11.seed = st.v12.seed = seed;
  const recoveries: Any = { v11: 0, v12: 0 }, injuredDeaths: Any = { v11: 0, v12: 0 };
  const injured = new Set(st.v12.population.workers.filter((w: Any) => w.injured).map((w: Any) => w.id));
  let last: Any = {};
  for (let d = 0; d < 120; d++) {
    const o: Any = { v11: simulateDay(st.v11, bundles.v11), v12: simulateDay(st.v12, bundles.v12) };
    if (JSON.stringify(o.v11.summary) !== JSON.stringify(o.v12.summary)) differingSummaryDays++;
    if (JSON.stringify(o.v11.state) !== JSON.stringify(strip(o.v12.state))) differingStateDaysIgnoringInjuryFields++;
    for (const v of ['v11', 'v12']) for (const e of o[v].events) { if (e.type === 'injury_recovery') recoveries[v]++; if (e.type === 'worker_death' && injured.has(e.id)) injuredDeaths[v]++; }
    st.v11 = o.v11.state; st.v12 = o.v12.state; last = o;
  }
  Object.assign(r, { day134_workers: { v11: last.v11.summary.population.workers, v12: last.v12.summary.population.workers }, injury_recoveries: recoveries, injured_worker_deaths: injuredDeaths, differing_summary_days: differingSummaryDays, differing_state_days_ignoring_injury_fields: differingStateDaysIgnoringInjuryFields });
  rows.push(r);
}
for (let seed = 15032026; seed < 15032046; seed++) {
  let st: Any = migrationState(main, world, clim, whatIf); st.seed = seed;
  let recoveries = 0, deaths = 0, out: Any;
  const injured = new Set(st.population.workers.filter((w: Any) => w.injured).map((w: Any) => w.id));
  for (let d = 0; d < 120; d++) { out = simulateDay(st, whatIf); for (const e of out.events) { if (e.type === 'injury_recovery') recoveries++; if (e.type === 'worker_death' && injured.has(e.id)) deaths++; } st = out.state; }
  whatIfRows.push({ seed, day134_workers: out.summary.population.workers, injury_recoveries: recoveries, injured_worker_deaths: deaths, still_injured_day134: out.state.population.workers.filter((w: Any) => w.injured).map((w: Any) => w.id) });
}
const types = Object.fromEntries(migrationState(main, world, clim, bundles.v12).population.workers.filter((w: Any) => w.injured).map((w: Any) => [w.id, { injury_type: w.injury_type, body_part: w.injury_body_part, record: w.injury_record }]));
const doc = { schema: 'antempire.rules-update.v12-injury-types', v12_engine: ENGINE_VERSION, v11_rules: 'current engine with only the v2-review.12 changes undone (proven identical to v11 by tests/rules-isolation.test.ts and to v6 migration by tests/differential.test.ts)', official_day14_advanced: false, saves_written: false, game_assumptions: true, day15_injury_types: types, all_20_seeds_identical_outcomes: rows.every((r) => r.differing_summary_days === 0 && r.differing_state_days_ignoring_injury_fields === 0), seeds: rows, what_if_unknown_permanent_not_a_rule: { note: 'diagnostic for the pending Owner decision only; injury_repair_multiplier_unknown = 0 instead of 1; no parameter was changed', seeds: whatIfRows } };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v12-injury-types.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify({ types, all_identical: doc.all_20_seeds_identical_outcomes, recoveries: rows.reduce((a, r) => [a[0] + r.injury_recoveries.v11, a[1] + r.injury_recoveries.v12], [0, 0]), injured_deaths: rows.reduce((a, r) => [a[0] + r.injured_worker_deaths.v11, a[1] + r.injured_worker_deaths.v12], [0, 0]), what_if: { recoveries: whatIfRows.reduce((a, r) => a + r.injury_recoveries, 0), injured_deaths: whatIfRows.reduce((a, r) => a + r.injured_worker_deaths, 0), day134_workers_median: [...whatIfRows.map((r) => r.day134_workers)].sort((x, y) => x - y)[10], v12_day134_workers_median: [...rows.map((r) => r.day134_workers.v12)].sort((x, y) => x - y)[10] } }, null, 2));
