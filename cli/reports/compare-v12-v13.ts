/**
 * Rules-update evidence for v2-review.13 (bug fix: egg-laying sugar also leaves worker crops). Runs the 20 fixed
 * seeds × Day15–134 and every diagnostic scenario with the fix switch off (v2-review.12, proven identical by
 * tests/rules-isolation.test.ts) and on, and counts days on which crops exceeded the sugar ledger.
 * Writes reports/rules-update-v13-egg-crop-settle.json. Diagnostic only: never touches saves/ or journal/.
 *   node cli/reports/compare-v12-v13.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateDay, ENGINE_VERSION } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { SCENARIOS, applyNew } from '../../tests/lib/scenarios.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const initial = readJson('tests/fixtures/day14-projection.json');
function run(on: boolean, sc: (typeof SCENARIOS)[number]) {
  const b = loadBundle(); (b.species['pheidole-megacephala'] as Any).nutrition.egg_laying_settles_crops = on; applyNew(b, sc.params);
  let s = structuredClone(initial); if (sc.seed) s.seed = sc.seed; sc.state(s);
  let crop_above_ledger_days = 0, sugar = 0, protein = 0, eggs = 0, trophallaxis = 0, firstExtinct: number | null = null, out: Any;
  for (let d = 0; d < sc.days; d++) {
    out = simulateDay(s, b);
    if (out.state.population.workers.reduce((a: number, w: Any) => a + (w.crop_cargo_sugar || 0), 0) > out.state.colony.sugar + 1e-6) crop_above_ledger_days++;
    sugar += out.summary.income.sugar; protein += out.summary.income.protein; eggs += out.summary.eggs_laid; trophallaxis += out.events.filter((e: Any) => e.type === 'trophallaxis').length;
    if (firstExtinct === null && out.summary.population.queen === 0 && out.summary.population.workers === 0) firstExtinct = out.day;
    s = out.state;
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return { queen: out.summary.population.queen, workers: out.summary.population.workers, first_extinct_day: firstExtinct, eggs_laid: eggs, sugar_income: r4(sugar), protein_income: r4(protein), trophallaxis_events: trophallaxis, crop_above_ledger_days };
}
const rows = SCENARIOS.map((sc) => ({ scenario: sc.name, days: sc.days, v12: run(false, sc), v13: run(true, sc) }));
const base = rows.filter((r) => r.scenario.startsWith('baseline-seed-'));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return (s[9] + s[10]) / 2; };
const agg = (v: 'v12' | 'v13') => ({ extinct_by_day134: base.filter((r) => r[v].first_extinct_day !== null).length, day134_workers_min_median_max: [Math.min(...base.map((r) => r[v].workers)), median(base.map((r) => r[v].workers)), Math.max(...base.map((r) => r[v].workers))], day134_queens_alive: base.filter((r) => r[v].queen > 0).length, eggs_laid: base.reduce((a, r) => a + r[v].eggs_laid, 0), sugar_income: Math.round(base.reduce((a, r) => a + r[v].sugar_income, 0) * 1e4) / 1e4, protein_income: Math.round(base.reduce((a, r) => a + r[v].protein_income, 0) * 1e4) / 1e4, crop_above_ledger_days: base.reduce((a, r) => a + r[v].crop_above_ledger_days, 0) });
const doc = { schema: 'antempire.rules-update.v13-egg-crop-settle', v13_engine: ENGINE_VERSION, official_day14_advanced: false, note: 'Diagnostic, not a target; nothing was tuned.', summary_20_seeds: { v12: agg('v12'), v13: agg('v13') }, scenarios: rows };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v13-egg-crop-settle.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify(doc.summary_20_seeds, null, 2));
for (const r of rows.filter((x) => !x.scenario.startsWith('baseline'))) console.log(r.scenario.padEnd(28), JSON.stringify([r.v12.queen, r.v12.workers, r.v12.crop_above_ledger_days]), JSON.stringify([r.v13.queen, r.v13.workers, r.v13.crop_above_ledger_days]));
