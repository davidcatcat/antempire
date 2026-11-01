/**
 * Rules-update evidence for v2-review.8 (#13): injured workers get neutral task weights (forage ×1.0, rest ×1.0
 * instead of ×0.75 / ×1.5). Runs the 20 fixed seeds × Day15–134 with v7 parameters (only the #13 changes
 * undone) and with the current v8 parameters, and the extreme scenarios, tracking injured workers explicitly.
 * Writes reports/rules-update-v8-injured-workers.json. Diagnostic only: never touches saves/ or journal/.
 *   node cli/reports/compare-v7-v8.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateDay, ENGINE_VERSION } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { SCENARIOS, applyNew } from '../../tests/lib/scenarios.ts';
import { approvedChanges } from '../../tests/lib/approved-changes.ts';
import type { ParamBundle } from '../../engine/index.ts';

const V8 = 'antempire.v2-review.8-injured-worker-neutral-tasks';
const revertV8 = (b: ParamBundle) => { for (const c of approvedChanges().filter((x) => x.rules_version === V8 && x.kind === 'param')) { let n: any = b.species[(c.file as string).split(':')[1]]; for (const k of (c.path as string).split('.')) n = n[k]; n.value = c.from; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
const initial = readJson('tests/fixtures/day14-projection.json');
const injuredIds = initial.population.workers.filter((w: any) => w.injured).map((w: any) => w.id); // eslint-disable-line @typescript-eslint/no-explicit-any

function run(version: 'v7' | 'v8', sc: (typeof SCENARIOS)[number]) {
  const b = loadBundle(); if (version === 'v7') revertV8(b); applyNew(b, sc.params);
  let s = structuredClone(initial); if (sc.seed) s.seed = sc.seed; sc.state(s);
  const inj = new Set<string>(s.population.workers.filter((w: any) => w.injured).map((w: any) => w.id)); // eslint-disable-line @typescript-eslint/no-explicit-any
  let injuredForageDays = 0, injuredWorkerDays = 0, healthyForageDays = 0, healthyWorkerDays = 0, injuredDeaths = 0, recoveries = 0, sugarIncome = 0, proteinIncome = 0, eggs = 0, firstExtinct: number | null = null;
  const deathDay: Record<string, number> = {};
  let out: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let d = 0; d < sc.days; d++) {
    const injuredBefore = new Map<string, boolean>(s.population.workers.map((w: any) => [w.id, !!w.injured])); // eslint-disable-line @typescript-eslint/no-explicit-any
    out = simulateDay(s, b);
    // Task of the day is read from the workers alive at the end of the day (workers dying that day are not counted).
    for (const w of out.state.population.workers) {
      const was = injuredBefore.get(w.id); if (was === undefined) continue;
      if (was) { injuredWorkerDays++; if (w.task === 'forage') injuredForageDays++; } else { healthyWorkerDays++; if (w.task === 'forage') healthyForageDays++; }
    }
    for (const e of out.events) { if (e.type === 'worker_death' && inj.has(e.id)) { injuredDeaths++; deathDay[e.id] = out.day; } if (e.type === 'injury_recovery') recoveries++; }
    sugarIncome += out.summary.income.sugar; proteinIncome += out.summary.income.protein; eggs += out.summary.eggs_laid;
    if (firstExtinct === null && out.summary.population.queen === 0 && out.summary.population.workers === 0) firstExtinct = out.day;
    s = out.state;
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return { final_day: out.day, queen: out.summary.population.queen, workers: out.summary.population.workers, first_extinct_day: firstExtinct, eggs_laid: eggs, sugar_income: r4(sugarIncome), protein_income: r4(proteinIncome), injured_initial: inj.size, injured_worker_days: injuredWorkerDays, injured_forage_fraction: injuredWorkerDays ? r4(injuredForageDays / injuredWorkerDays) : null, healthy_forage_fraction: healthyWorkerDays ? r4(healthyForageDays / healthyWorkerDays) : null, injured_deaths: injuredDeaths, injury_recoveries: recoveries };
}
const rows = SCENARIOS.map((sc) => ({ scenario: sc.name, days: sc.days, v7: run('v7', sc), v8: run('v8', sc) }));
const base = rows.filter((r) => r.scenario.startsWith('baseline-seed-'));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2; };
const agg = (v: 'v7' | 'v8') => ({ extinct_by_day134: base.filter((r) => r[v].first_extinct_day !== null).length, day134_workers_min_median_max: [Math.min(...base.map((r) => r[v].workers)), median(base.map((r) => r[v].workers)), Math.max(...base.map((r) => r[v].workers))], day134_queens_alive: base.filter((r) => r[v].queen > 0).length, mean_injured_forage_fraction: Math.round(base.reduce((a, r) => a + (r[v].injured_forage_fraction ?? 0), 0) / base.length * 1e4) / 1e4, mean_healthy_forage_fraction: Math.round(base.reduce((a, r) => a + (r[v].healthy_forage_fraction ?? 0), 0) / base.length * 1e4) / 1e4, injured_deaths_total: base.reduce((a, r) => a + r[v].injured_deaths, 0), injury_recoveries_total: base.reduce((a, r) => a + r[v].injury_recoveries, 0), sugar_income_total: Math.round(base.reduce((a, r) => a + r[v].sugar_income, 0) * 1e4) / 1e4, protein_income_total: Math.round(base.reduce((a, r) => a + r[v].protein_income, 0) * 1e4) / 1e4 });
const doc = { schema: 'antempire.rules-update.v8-injured-workers', v8_engine: ENGINE_VERSION, v7_parameters: 'current engine with only the #13 parameter changes undone (proven identical to v7 by tests/rules-isolation.test.ts)', official_day14_advanced: false, game_assumptions: true, injured_workers_in_fixture: injuredIds, note: 'Diagnostic, not a target; nothing was tuned. Fractions = worker-days with task=forage / worker-days, counted over workers alive at the end of each day.', summary_20_seeds: { v7: agg('v7'), v8: agg('v8') }, scenarios: rows };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v8-injured-workers.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify(doc.summary_20_seeds, null, 2));
for (const r of rows) console.log(r.scenario.padEnd(28), 'v7', JSON.stringify([r.v7.queen, r.v7.workers, r.v7.injured_forage_fraction, r.v7.injured_deaths]), 'v8', JSON.stringify([r.v8.queen, r.v8.workers, r.v8.injured_forage_fraction, r.v8.injured_deaths]));
