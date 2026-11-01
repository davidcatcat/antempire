/**
 * Rules-update evidence for v2-review.10: large-prey team cap (predation.large_prey_max_team = 10). Runs the 20
 * fixed seeds × Day15–134 and every diagnostic scenario with the v9 rules (cap set back to no limit; proven
 * identical to v9 by tests/rules-isolation.test.ts) and with v10, counting every hunting outcome and team size.
 * Writes reports/rules-update-v10-hunt-team-cap.json. Diagnostic only: never touches saves/ or journal/.
 *   node cli/reports/compare-v9-v10.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { simulateDay, ENGINE_VERSION, type SimEvent } from '../../engine/index.ts';
import { REPO_ROOT, readJson, loadBundle } from '../lib/load.ts';
import { SCENARIOS, applyNew } from '../../tests/lib/scenarios.ts';
import { approvedChanges, revertChange } from '../../tests/lib/approved-changes.ts';

const V10 = 'antempire.v2-review.10-hunt-team-cap';
const initial = readJson('tests/fixtures/day14-projection.json');
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Encounters whose co-located team left out another worker that arrived at the same site in the same minute.
 * `explained`: that worker had taken carcass food at the site that day, or was in another hunt team there
 * (participation lock). `unexplained`: neither (the v8 processing-order defect of #10).
 */
function splitWindows(events: SimEvent[]): { raw: number; unexplained: number } {
  const arrival = new Map<string, number>(), ev = events as Any[];
  let raw = 0, unexplained = 0;
  for (const e of ev) {
    if (e.type === 'route_step') arrival.set(e.worker + '>' + e.to, e.minute);
    if (e.type !== 'live_prey_encounter') continue;
    const m = e.minute ?? arrival.get(e.worker + '>' + e.site), team = new Set<string>(e.co_located_team);
    const others = ev.filter((x) => x.type === 'route_step' && x.to === e.site && x.minute === m && x.worker !== e.worker && !team.has(x.worker)).map((x) => x.worker as string);
    if (!others.length) continue;
    raw++;
    const explained = (w: string) => ev.some((y) => y.type === 'food_collected' && y.worker === w && y.site === e.site && y.prey_event_id === undefined) || ev.some((y) => (y.type === 'insect_predation' || y.type === 'prey_escaped') && y.site === e.site && y !== e && ((y.team ?? y.participants) || []).includes(w));
    if (others.some((w) => !explained(w))) unexplained++;
  }
  return { raw, unexplained };
}

function run(version: 'v9' | 'v10', sc: (typeof SCENARIOS)[number]) {
  const b = loadBundle(); if (version === 'v9') for (const c of approvedChanges().filter((x) => x.rules_version === V10)) revertChange(b, c);
  applyNew(b, sc.params);
  let s = structuredClone(initial); if (sc.seed) s.seed = sc.seed; sc.state(s);
  const n: Record<string, number> = {}, add = (k: string, v = 1) => { n[k] = (n[k] || 0) + v; };
  let teamSizes = 0, maxTeam = 0, sugar = 0, protein = 0, eggs = 0, firstExtinct: number | null = null, out: Any;
  for (let d = 0; d < sc.days; d++) {
    out = simulateDay(s, b);
    for (const e of out.events as Any[]) {
      if (e.type === 'live_prey_encounter') add('encounters_' + e.prey_size);
      if (e.type === 'insect_predation') { add('captures_' + e.size); if (e.size === 'large') { teamSizes += e.team.length; maxTeam = Math.max(maxTeam, e.team.length); } }
      if (e.type === 'prey_escaped') add('escaped_' + e.reason);
      if (e.type === 'hunt_recruitment') add('long_range_recruits');
      if (e.type === 'joint_prey_transport') add('joint_transports');
      if (e.type === 'insect_natural_death') add('insect_natural_deaths');
    }
    const sw = splitWindows(out.events); add('encounters_missing_simultaneous_worker_raw', sw.raw); add('encounters_missing_simultaneous_worker_unexplained', sw.unexplained);
    sugar += out.summary.income.sugar; protein += out.summary.income.protein; eggs += out.summary.eggs_laid;
    if (firstExtinct === null && out.summary.population.queen === 0 && out.summary.population.workers === 0) firstExtinct = out.day;
    s = out.state;
  }
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return { final_day: out.day, queen: out.summary.population.queen, workers: out.summary.population.workers, first_extinct_day: firstExtinct, eggs_laid: eggs, sugar_income: r4(sugar), protein_income: r4(protein), mean_large_capture_team: n.captures_large ? r4(teamSizes / n.captures_large) : null, max_large_capture_team: maxTeam, ...n };
}
const rows = SCENARIOS.map((sc) => ({ scenario: sc.name, days: sc.days, v9: run('v9', sc), v10: run('v10', sc) }));
const base = rows.filter((r) => r.scenario.startsWith('baseline-seed-'));
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return (s[Math.floor((s.length - 1) / 2)] + s[Math.floor(s.length / 2)]) / 2; };
const total = (v: 'v9' | 'v10', k: string) => Math.round(base.reduce((a, r) => a + ((r[v] as Any)[k] || 0), 0) * 1e4) / 1e4;
const KEYS = ['encounters_small', 'encounters_large', 'captures_small', 'captures_large', 'escaped_failed_capture', 'escaped_insufficient_local_team', 'escaped_escaped_while_recruiting', 'escaped_insufficient_team_no_recruits', 'escaped_insufficient_team_no_time_to_recruit', 'escaped_insufficient_team_after_recruitment', 'long_range_recruits', 'joint_transports', 'encounters_missing_simultaneous_worker_raw', 'encounters_missing_simultaneous_worker_unexplained', 'insect_natural_deaths', 'eggs_laid', 'sugar_income', 'protein_income'];
const agg = (v: 'v9' | 'v10') => ({ extinct_by_day134: base.filter((r) => r[v].first_extinct_day !== null).length, day134_workers_min_median_max: [Math.min(...base.map((r) => r[v].workers)), median(base.map((r) => r[v].workers)), Math.max(...base.map((r) => r[v].workers))], day134_queens_alive: base.filter((r) => r[v].queen > 0).length, ...Object.fromEntries(KEYS.map((k) => [k, total(v, k)])) });
const doc = { schema: 'antempire.rules-update.v10-hunt-team-cap', v10_engine: ENGINE_VERSION, v9_rules: 'current engine with only the v2-review.10 cap undone (no limit; proven identical to v9 by tests/rules-isolation.test.ts)', official_day14_advanced: false, game_assumptions: true, note: 'Diagnostic, not a target; nothing was tuned. encounters_missing_simultaneous_worker_* count encounters whose co-located team left out another worker that arrived at the same site in the same minute; _unexplained excludes workers that took carcass food there or were in another hunt team there (participation lock). The unexplained ones are the v8 processing-order defect of #10.', summary_20_seeds: { v9: agg('v9'), v10: agg('v10') }, max_large_capture_team_all_scenarios: { v9: Math.max(...rows.map((r) => r.v9.max_large_capture_team)), v10: Math.max(...rows.map((r) => r.v10.max_large_capture_team)) }, scenarios: rows };
fs.writeFileSync(path.join(REPO_ROOT, 'reports/rules-update-v10-hunt-team-cap.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify({ ...doc.summary_20_seeds, max_team: doc.max_large_capture_team_all_scenarios }, null, 2));
for (const r of rows) console.log(r.scenario.padEnd(28), 'v9', JSON.stringify([r.v9.queen, r.v9.workers, (r.v9 as Any).captures_small ?? 0, (r.v9 as Any).captures_large ?? 0, r.v9.mean_large_capture_team, r.v9.protein_income]), 'v10', JSON.stringify([r.v10.queen, r.v10.workers, (r.v10 as Any).captures_small ?? 0, (r.v10 as Any).captures_large ?? 0, r.v10.mean_large_capture_team, r.v10.protein_income]));
