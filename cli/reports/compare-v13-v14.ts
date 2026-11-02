/**
 * Rules-update evidence for v2-review.14 (#8): individual route memory and local exploration. Same fixed seeds
 * and states, v2-review.13 rules (switch navigation.individual_route_memory off; proven identical to v13 by
 * tests/rules-isolation.test.ts) vs v14. Besides the 28 standard scenarios it runs diagnostic-only worlds:
 * forced exploration, doubled walking time per edge, and extra dead-end branches; and it reports the winter window
 * (Day 45–105 of the 20 baseline runs) separately. Diagnostic only: never touches saves/ or journal/; nothing tuned.
 * Writes reports/rules-update-v14-route-memory.json.   node cli/reports/compare-v13-v14.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateDay, ENGINE_VERSION, type ParamBundle } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { SCENARIOS, applyNew, type Scenario } from '../../tests/lib/scenarios.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala';
const initial = readJson('tests/fixtures/day14-projection.json');
const setSp = (b: ParamBundle, p: string, v: number) => { let n: Any = b.species[SP]; for (const k of p.split('.')) n = n[k]; n.value = v; };
const EXTRA: (Scenario & { world?: (b: ParamBundle) => void })[] = [
  ...[15032026, 15032031, 15032036, 15032041].map((seed) => ({ name: `explore-extreme-60-seed-${seed}`, seed, days: 60, state: () => {}, params: [] as [string, number][], world: (b: ParamBundle) => { setSp(b, 'scouting.scout_discovery_probability', 1); setSp(b, 'scouting.scout_search_when_route_unproductive_probability', 1); } })),
  ...[15032026, 15032031, 15032036, 15032041].map((seed) => ({ name: `long-edges-50min-60-seed-${seed}`, seed, days: 60, state: () => {}, params: [] as [string, number][], world: (b: ParamBundle) => { (b.world as Any).routes.route_edge_minutes.value = 50; } })),
  ...[15032026, 15032031, 15032036, 15032041].map((seed) => ({ name: `dead-end-branches-60-seed-${seed}`, seed, days: 60, state: () => {}, params: [] as [string, number][], world: (b: ParamBundle) => { (b.world as Any).routes.topology.edges.push(['N00', 'X01'], ['N00', 'X02'], ['F01', 'X03'], ['F08', 'X04'], ['U00', 'X05']); } })),
];
function run(version: 'v13' | 'v14', sc: (typeof EXTRA)[number]) {
  const b = loadBundle(); (b.species[SP] as Any).navigation.individual_route_memory = version === 'v14'; applyNew(b, sc.params); sc.world?.(b);
  let s = structuredClone(initial); if (sc.seed) s.seed = sc.seed; sc.state(s);
  const n: Record<string, number> = {}, add = (k: string, v = 1) => { n[k] = (n[k] || 0) + v; };
  let out: Any, firstExtinct: number | null = null;
  for (let d = 0; d < sc.days; d++) {
    out = simulateDay(s, b);
    const winter = d >= 30 && d < 90 ? 'winter_' : null;
    for (const e of out.events as Any[]) {
      if (e.type === 'exploration_step' || e.type === 'physical_scout_visit') { add('exploration_trips'); if (winter) add(winter + 'exploration_trips'); }
      if (e.type === 'route_step' && (e.kind === 'explore_depart' || e.kind === 'scout')) add('exploration_edges_walked_out');
      if (e.type === 'discovery') { add('discoveries'); if (winter) add(winter + 'discoveries'); }
      if (e.type === 'scouted_empty') add('scouted_empty');
      if (e.type === 'exploration_found_nothing' || e.type === 'exploration_no_new_direction') add('exploration_nothing');
      if (e.type === 'local_trail_choice') add('trail_following_steps');
      if (e.type === 'route_timeout') add('route_timeouts');
    }
    add('foraging_worker_days', out.summary.tasks.forage); add('foraging_trips', out.summary.foraging_trips); add('foraging_successes', out.summary.foraging_successes);
    add('sugar_income', out.summary.income.sugar); add('protein_income', out.summary.income.protein); add('eggs_laid', out.summary.eggs_laid);
    if (winter) { add('winter_sugar_income', out.summary.income.sugar); add('winter_protein_income', out.summary.income.protein); }
    add('workers_not_home_at_day_end', out.state.population.workers.filter((w: Any) => w.last_location !== 'N00').length);
    if (firstExtinct === null && out.summary.population.queen === 0 && out.summary.population.workers === 0) firstExtinct = out.day;
    s = out.state;
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  const ws = out.state.population.workers as Any[];
  const union = new Set<string>(); for (const w of ws) for (const k of Object.keys(w.route_memory?.edges ?? {})) union.add(k);
  return { final_day: out.day, queen: out.summary.population.queen, workers: out.summary.population.workers, brood: out.summary.population.eggs + out.summary.population.larvae + out.summary.population.pupae, first_extinct_day: firstExtinct,
    mean_known_edges_per_worker: version === 'v14' && ws.length ? r4(ws.reduce((a, w) => a + Object.keys(w.route_memory?.edges ?? {}).length, 0) / ws.length) : null,
    colony_union_known_edges: version === 'v14' ? union.size : null,
    return_home_rate: n.foraging_trips ? r4(1 - (n.workers_not_home_at_day_end || 0) / n.foraging_trips) : null,
    ...Object.fromEntries(Object.entries(n).map(([k, v]) => [k, r4(v)])) };
}
const rows = [...SCENARIOS, ...EXTRA].map((sc) => ({ scenario: sc.name, days: sc.days, v13: run('v13', sc), v14: run('v14', sc) }));
const base = rows.filter((r) => r.scenario.startsWith('baseline-seed-'));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return (s[9] + s[10]) / 2; };
const total = (v: 'v13' | 'v14', k: string, rs = base) => Math.round(rs.reduce((a, r) => a + ((r[v] as Any)[k] || 0), 0) * 1e4) / 1e4;
const KEYS = ['exploration_trips', 'exploration_edges_walked_out', 'discoveries', 'scouted_empty', 'exploration_nothing', 'trail_following_steps', 'route_timeouts', 'foraging_worker_days', 'foraging_trips', 'foraging_successes', 'sugar_income', 'protein_income', 'eggs_laid', 'winter_exploration_trips', 'winter_discoveries', 'winter_sugar_income', 'winter_protein_income', 'workers_not_home_at_day_end'];
const agg = (v: 'v13' | 'v14') => ({ extinct_by_day134: base.filter((r) => r[v].first_extinct_day !== null).length, day134_workers_min_median_max: [Math.min(...base.map((r) => r[v].workers)), median(base.map((r) => r[v].workers)), Math.max(...base.map((r) => r[v].workers))], day134_brood_median: median(base.map((r) => r[v].brood)), day134_queens_alive: base.filter((r) => r[v].queen > 0).length, mean_known_edges_per_worker_day134: v === 'v14' ? Math.round(base.reduce((a, r) => a + (r.v14.mean_known_edges_per_worker ?? 0), 0) / 20 * 1e4) / 1e4 : null, ...Object.fromEntries(KEYS.map((k) => [k, total(v, k)])) });
const doc = { schema: 'antempire.rules-update.v14-route-memory', v14_engine: ENGINE_VERSION, v13_rules: 'current engine with navigation.individual_route_memory=false (proven identical to v2-review.13 by tests/rules-isolation.test.ts)', official_day14_advanced: false, game_assumptions: true, note: 'Diagnostic, not a target; nothing was tuned. winter_* = Day 45–105 (sim days 30–89 of each 120-day run). return_home_rate = 1 - (workers not at the nest at day end)/(trips). Extra scenarios (explore-extreme, long-edges, dead-end-branches) are diagnostic worlds only, never game parameters.', summary_20_seeds: { v13: agg('v13'), v14: agg('v14') }, scenarios: rows };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v14-route-memory.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify(doc.summary_20_seeds, null, 1));
for (const r of rows.filter((x) => !x.scenario.startsWith('baseline'))) console.log(r.scenario.padEnd(36), 'v13', JSON.stringify([r.v13.queen, r.v13.workers, r.v13.brood, (r.v13 as Any).discoveries ?? 0, Math.round(((r.v13 as Any).sugar_income ?? 0) * 10) / 10]), 'v14', JSON.stringify([r.v14.queen, r.v14.workers, r.v14.brood, (r.v14 as Any).discoveries ?? 0, Math.round(((r.v14 as Any).sugar_income ?? 0) * 10) / 10, r.v14.mean_known_edges_per_worker]));
