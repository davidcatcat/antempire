/**
 * Rules update v2-review.17 evidence (diagnostic, not a target): Day0 founding A1 (and A2) × 4 seasons × the 20
 * fixed seeds of PR #28, 365 days, under
 *  - v16: activity.individual_timeline = false (the previous model);
 *  - v17: the timeline with the world's recorded edge lengths (the new rules);
 *  - v17-legacy-edges: the timeline but every edge 25 min (separates "timeline" from "recorded distances");
 *  - v17-tortuosity-3: walking paths 3× the recorded straight-line distances;
 *  - sensitivity: each new game-assumption parameter halved and doubled (one at a time).
 * The timeline draws different random streams than v16, so the same seed is a different path: compare
 * distributions over seeds, never one seed against itself as a causal effect.
 *   node cli/reports/compare-v16-v17.ts [outFile]
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { DAY0_SEEDS, runDay0 } from './day0-evaluation.ts';
import { SEASONS, type FoundingId } from '../lib/day0.ts';
import type { ParamBundle } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala';
const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const variant = (edit: (b: ParamBundle) => void) => { const b = loadBundle(); edit(b); return b; };
const setSp = (k: string, f: (v: number) => number) => (b: ParamBundle) => { const n = (b.species[SP] as Any).activity[k]; n.value = f(n.value); };
const VARIANTS: [string, ParamBundle][] = [
  ['v16 (timeline off)', variant((b) => { (b.species[SP] as Any).activity.individual_timeline = false; })],
  ['v17', variant(() => {})],
  ['v17 legacy 25-min edges', variant((b) => { delete (b.world as Any).routes.edge_length_cm; })],
  ['v17 tortuosity 3', variant((b) => { (b.world as Any).routes.path_tortuosity.value = 3; })],
];
const SENS = ['off_trail_speed_factor', 'search_minutes', 'liquid_fill_minutes_full_crop', 'unload_minutes', 'rest_between_trips_minutes', 'continue_base', 'continue_crop_emptied_weight', 'continue_after_failure_probability', 'recruit_min_crop_fill_fraction'];
for (const k of SENS) for (const [lab, f] of [['×0.5', (v: number) => v * 0.5], ['×2', (v: number) => (k.startsWith('continue') || k.startsWith('recruit') ? Math.min(1, v * 2) : v * 2)]] as const) VARIANTS.push([`v17 ${k} ${lab}`, variant(setSp(k, f))]);

function summarise(name: string, b: ParamBundle, foundings: FoundingId[]): Any {
  const rows: Any = {};
  for (const f of foundings) for (const season of SEASONS) {
    const runs = DAY0_SEEDS.map((seed) => runDay0(f, season, seed, b));
    rows[`${f}/${season}`] = {
      queen_alive_365: runs.filter((r) => r.checkpoints[365]?.queen).length,
      colony_end: runs.filter((r) => r.colony_end_day !== null).length,
      workers_365_median: med(runs.map((r) => r.checkpoints[365]?.workers ?? 0)),
      workers_90_median: med(runs.map((r) => r.checkpoints[90]?.workers ?? 0)),
      sugar_income_median: +med(runs.map((r) => r.totals.income.sugar)).toFixed(2),
      protein_income_median: +med(runs.map((r) => r.totals.income.protein)).toFixed(2),
      trips_per_active_forager_day: (() => { const t = runs.reduce((a, r) => a + r.totals.trips, 0), d = runs.reduce((a, r) => a + (r.activity?.active_worker_days ?? 0), 0); return d ? +(t / d).toFixed(3) : null; })(),
      eclosions_total: runs.reduce((a, r) => a + r.totals.eclosion, 0),
    };
  }
  const all = Object.values(rows) as Any[];
  return { variant: name, queen_alive_365_total: all.reduce((a, r) => a + r.queen_alive_365, 0), runs: all.length * 20, rows };
}

if (import.meta.main) {
  const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(REPO_ROOT, 'reports/rules-update-v17-activity.json');
  const t = Date.now(), results: Any[] = [];
  for (const [name, b] of VARIANTS) { results.push(summarise(name, b, name.startsWith('v17 ') && !name.includes('edges') && !name.includes('tortuosity') ? ['A1'] : ['A1', 'A2', 'A3'])); console.error(name, results.at(-1).queen_alive_365_total, '/', results.at(-1).runs, ((Date.now() - t) / 1000).toFixed(0) + 's'); }
  fs.writeFileSync(out, JSON.stringify({ schema: 'antempire.rules-update-v17-evidence.v1', diagnostic_not_target: true, seeds: DAY0_SEEDS, note: 'same seed = different random path between v16 and v17; compare distributions', results }, null, 1) + '\n');
  console.log(out);
}
