/**
 * PH-3b benchmark (docs/physics-ph3b-solver2d.md §5): the isolated event-driven 2-D solver on the solver-compare scenarios,
 * graded by the SAME judge as Native and Rapier. Each scenario runs in its own child process (peak RSS per run).
 *   node prototypes/solver-compare/bench-ph3b.ts [--only id,id] [--no-judge-1000]
 *   node prototypes/solver-compare/bench-ph3b.ts --rapier-variants   (Rapier driving variants, same judge; not tuned)
 * Writes prototypes/solver-compare/out/ph3b-<id>.json and out/ph3b-summary.json. Measurements only; nothing is tuned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HERE, loadScenario } from './lib/spec.ts';
import { runPh3b, ph3bInput } from './lib/ph3b.ts';
import { judge } from './lib/judge.ts';
import { loadRapier, runRapier } from './lib/rapier.ts';
import { solve2D } from '../../engine/physics/solver2d.ts';
import { bruteForcePairs, gridPairs2D, sweepAndPrunePairs, type AABB, type BroadphaseKind } from '../../engine/physics/broadphase.ts';
import { lateralPacking } from '../../engine/physics/body2d.ts';
import { usableWidth } from '../../engine/physics/collision.ts';
import type { Trajectory } from './lib/traj.ts';

const SCEN = ['head-on-2', 'corridor-8', 'stone', 'crossing', 'crossing-traffic-100', 'crossing-traffic-1000'];
const hash = (t: Trajectory) => createHash('sha256').update(JSON.stringify({ a: t.agents, e: t.events })).digest('hex').slice(0, 16);

function one(id: string, judge1000: boolean) {
  const sc = loadScenario(id), n = sc.agents.length;
  const r = runPh3b(sc), h = hash(r.tr);
  const rev = hash(runPh3b(sc, { reverse_order: true }).tr);
  // broad-phase variants: identical trajectories? and the cost of each method on the solver's own window box sets
  const variants: Record<string, string> = {};
  for (const bp of (n <= 100 ? ['grid', 'sap', 'brute'] : ['grid', 'sap']) as BroadphaseKind[]) variants[bp] = hash(runPh3b(sc, { broadphase: bp }).tr);
  for (const w of [0.05, 1]) variants[`window_${w}`] = hash(runPh3b(sc, { window_s: w }).tr);
  const sets: { boxes: readonly AABB[]; keys: readonly number[] }[] = [];
  solve2D({ ...ph3bInput(sc), observe_windows: (_t, boxes, keys) => { sets.push({ boxes, keys }); } });
  const bpCost: Record<string, { ms: number; pairs: number }> = {};
  let ref: string | null = null, identical = true;
  for (const [name, f] of [['brute', (b: readonly AABB[], k: readonly number[]) => bruteForcePairs(b, k)], ['grid_8mm', (b: readonly AABB[], k: readonly number[]) => gridPairs2D(b, k, 8)], ['grid_2mm', (b: readonly AABB[], k: readonly number[]) => gridPairs2D(b, k, 2)], ['sap', (b: readonly AABB[], k: readonly number[]) => sweepAndPrunePairs(b, k)]] as const) {
    const t0 = performance.now(); let pairs = 0; const sig = createHash('sha256');
    for (const s of sets) { const p = f(s.boxes, s.keys); pairs += p.length; sig.update(p.join(',')); }
    bpCost[name] = { ms: performance.now() - t0, pairs };
    const d = sig.digest('hex'); if (ref === null) ref = d; else if (d !== ref) identical = false;
  }
  const doJudge = n < 1000 || judge1000;
  const j = doJudge ? judge(sc, r.tr, { occupancy2d: n <= 24 }) : null;
  // stalls: is a head-on stall forced by the geometry (no lateral arrangement fits) or by the given offsets u?
  const stalls = { head_on_pairs: 0, packing_infeasible: 0, packing_feasible_given_u_blocks: 0, packing_unknown: 0 };
  const byId = new Map(sc.agents.map((a) => [a.id, a]));
  const seen = new Set<string>();
  for (const e of r.res.events) {
    if (e.kind !== 'stop' || !e.detail || !/^contact with (\S+) would penetrate/.test(e.detail)) continue;
    const a = byId.get(e.agents[0])!, b = byId.get(/^contact with (\S+)/.exec(e.detail)![1])!;
    if (!b || a.passage !== b.passage || a.dir === b.dir) continue;
    const key = [a.id, b.id].sort().join('|'); if (seen.has(key)) continue; seen.add(key); stalls.head_on_pairs++;
    const p = sc.lanes.find((l) => l.passage.id === a.passage)!.passage, sa = r.res.agents[a.id].samples.at(-1)![4], sb = r.res.agents[b.id].samples.at(-1)![4], sm = (sa + sb) / 2;
    const W = Math.min(...[-1, -0.5, 0, 0.5, 1].map((k) => usableWidth(sc.geometry, p, sm + k * sc.body.length_mm.value / 2)));
    const pk = lateralPacking([{ s_mm: sm, length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value }, { s_mm: sm, length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value }], W);
    if (pk.feasible === null) stalls.packing_unknown++; else if (pk.feasible) stalls.packing_feasible_given_u_blocks++; else stalls.packing_infeasible++;
  }
  const kinds: Record<string, number> = {}, classes: Record<string, number> = {};
  for (const e of r.res.events) { kinds[e.kind] = (kinds[e.kind] ?? 0) + 1; classes[e.class] = (classes[e.class] ?? 0) + 1; }
  const arrived = Object.values(r.res.agents).filter((a) => a.arrival_t_s !== null).length;
  const modes: Record<string, number> = {}; for (const a of Object.values(r.res.agents)) modes[a.final_mode] = (modes[a.final_mode] ?? 0) + 1;
  const ru = process.resourceUsage();
  return {
    scenario: id, agents: n, horizon_s: sc.horizon_s, cost: r.cost, peak_rss_mb: ru.maxRSS / 1024, stats: r.res.stats, events_by_kind: kinds, events_by_class: classes, arrived, final_modes: modes,
    replay: { hash: h, input_order_reversed_identical: rev === h, variants_identical: Object.values(variants).every((x) => x === h), variants },
    broadphase: { windows: sets.length, identical_candidate_sets: identical, cost: bpCost, note: 'cost of the three methods on the solver\'s own window box sets; brute = O(N²) reference' },
    head_on_stalls: stalls,
    judge: j ? { overlap_pair_instants: j.overlap_pair_instants, overlap_between_instants: j.overlap_between_instants, max_penetration_mm: j.max_penetration_mm, max_penetration_between_mm: j.max_penetration_between_mm, out_of_walkable_agent_instants: j.out_of_walkable_agent_instants, max_out_of_walkable_mm: j.max_out_of_walkable_mm, obstacle_violation_agent_instants: j.obstacle_violation_agent_instants, max_obstacle_penetration_mm: j.max_obstacle_penetration_mm, body_contact_episodes: j.body_contact_episodes, body_contacts_only_between_instants: j.body_contacts_only_between_instants, occupancy2d: j.occupancy2d, instants: j.instants, judge_wall_ms: j.judge_wall_ms } : 'not run',
  };
}

/** Rapier driving variants (cheap, within solver-compare): default, 16 solver iterations, lateral translation locked
 *  (= the fixed-u assumption of PH-3b). Reported as measured; nothing is chosen for arrivals. */
async function rapierVariants() {
  if (!(await loadRapier())) return { not_run: 'Rapier not installed (npm ci in prototypes/solver-compare)' };
  const out: unknown[] = [];
  for (const id of ['head-on-2', 'corridor-8', 'crossing', 'crossing-traffic-100']) {
    const sc = loadScenario(id);
    for (const [name, o] of [['default', {}], ['iterations_16', { solver_iterations: 16 }], ['lateral_locked', { lateral_locked: true }]] as const) {
      const r = await runRapier(sc, { dt_s: sc.rapier.dt_s, ccd: false, ...o }), j = judge(sc, r.tr, { occupancy2d: sc.agents.length <= 24 });
      const arrived = Object.values(j.arrivals).filter((x) => x !== null).length;
      const row = { scenario: id, variant: name, dt_s: sc.rapier.dt_s, wall_ms: r.cost.wall_ms, arrived, agents: sc.agents.length, overlap_pair_instants: j.overlap_pair_instants, overlap_gt_1um: j.overlap_pair_instants_gt_coarse, max_penetration_mm: j.max_penetration_mm, overlap_between_instants: j.overlap_between_instants, out_of_walkable_gt_1um: j.out_of_walkable_gt_coarse, max_out_of_walkable_mm: j.max_out_of_walkable_mm, obstacle_violation_gt_1um: j.obstacle_violation_gt_coarse, body_contacts_only_between_instants: j.body_contacts_only_between_instants, params: r.params };
      console.log(JSON.stringify({ ...row, params: undefined })); out.push(row);
    }
  }
  return out;
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const args = process.argv.slice(2), at = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--rapier-variants')) { const v = await rapierVariants(); fs.writeFileSync(path.join(HERE, 'out', 'ph3b-rapier-variants.json'), JSON.stringify(v, null, 1) + '\n'); }
  else if (at('--one')) { console.log(JSON.stringify(one(at('--one')!, !args.includes('--no-judge-1000')))); }
  else {
    const out = path.join(HERE, 'out'); fs.mkdirSync(out, { recursive: true });
    const ids = at('--only')?.split(',') ?? SCEN, summary: unknown[] = [];
    for (const id of ids) {
      const t0 = Date.now(), p = spawnSync(process.execPath, [me, '--one', id, ...(args.includes('--no-judge-1000') ? ['--no-judge-1000'] : [])], { encoding: 'utf8', maxBuffer: 1 << 28 });
      if (p.status !== 0) { console.log(`${id}: FAILED (exit ${p.status})\n${p.stderr.slice(-2000)}`); summary.push({ scenario: id, failed: true, stderr: p.stderr.slice(-2000) }); continue; }
      const r = JSON.parse(p.stdout.trim().split('\n').at(-1)!);
      fs.writeFileSync(path.join(out, `ph3b-${id}.json`), JSON.stringify(r, null, 1) + '\n');
      const j = r.judge;
      console.log(`${id}: n=${r.agents} wall ${r.cost.wall_ms.toFixed(0)} ms cpu ${(r.cost.cpu_user_ms + r.cost.cpu_system_ms).toFixed(0)} ms peakRSS ${r.peak_rss_mb.toFixed(0)} MB batches ${r.stats.batches} events ${Object.values(r.events_by_kind as Record<string, number>).reduce((a, b) => a + b, 0)} arrived ${r.arrived} modes ${JSON.stringify(r.final_modes)} unresolved ${r.stats.unresolved} aborted ${r.stats.aborted} judge ${typeof j === 'string' ? j : `overlap ${j.overlap_pair_instants}/${j.overlap_between_instants} out ${j.out_of_walkable_agent_instants} obst ${j.obstacle_violation_agent_instants}`} replay-rev ${r.replay.input_order_reversed_identical} variants ${r.replay.variants_identical} bp ${JSON.stringify(r.broadphase.cost)} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
      summary.push(r);
    }
    fs.writeFileSync(path.join(out, 'ph3b-summary.json'), JSON.stringify(summary, null, 1) + '\n');
  }
}
