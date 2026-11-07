/**
 * Issue #101 (PH-Rapier-2) step 1 CLI — native analytic solver vs Rapier 2D on a common synthetic scenario, judged by the
 * same 2-D contract (lib/judge.ts). Isolated experiment: writes only prototypes/solver-compare/out/.
 *
 *   node prototypes/solver-compare/run.ts --scenario <id> [--solver native|rapier|both] [--dt 0.008333] [--sweep-dt]
 *        [--ccd] [--dense 0.002|0] [--traj]
 * Scenarios: prototypes/solver-compare/scenarios/<id>.json. Rapier needs `npm ci` in prototypes/solver-compare.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { HERE, loadScenario, listScenarios, type Scenario } from './lib/spec.ts';
import { runNative, toTrajectory } from './lib/native.ts';
import { runRapier, loadRapier } from './lib/rapier.ts';
import { judge, CONTACT_TOL_MM } from './lib/judge.ts';
import type { Trajectory } from './lib/traj.ts';
import { OCC_TOL_MM } from '../../engine/physics/body2d.ts';

export const hashTraj = (t: Trajectory) => createHash('sha256').update(JSON.stringify({ a: t.agents, e: t.events })).digest('hex').slice(0, 16);
const SMALL = 24;
const arrSummary = (a: Record<string, number | null>) => { const v = Object.values(a); return v.length <= 8 ? `arrivals ${JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, x]) => [k, x === null ? null : +x.toFixed(4)])))}` : `arrived ${v.filter((x) => x !== null).length}/${v.length}`; };
const counts = (t: Trajectory) => { const k: Record<string, number> = {}, c: Record<string, number> = {}; for (const e of t.events) { k[e.kind] = (k[e.kind] ?? 0) + 1; c[e.class] = (c[e.class] ?? 0) + 1; } return { by_kind: k, by_class: c }; };
const analytic = (sc: Scenario) => Object.fromEntries(sc.agents.map((a) => [a.id, a.start_t_s + Math.abs(a.goal_s_mm - a.s_mm) / a.free_speed_mm_s]));
const scenarioInfo = (sc: Scenario) => ({
  id: sc.id, title: sc.title, agents: sc.agents.length, horizon_s: sc.horizon_s, seed: sc.seed, refs: sc.file.refs,
  body: sc.body, encounter: sc.encounter, encounter_provenance: sc.encounter_provenance, lanes: sc.lanes.map((l) => ({ id: l.passage.id, width_mm: l.passage.width_mm, layer: l.layer })),
  obstacles: sc.obstacles.map((o) => o.id), obstacles_not_at_level: sc.obstacles_not_at_level, unused_passages: sc.unused_passages, provenance: sc.file.provenance,
  tolerances: { overlap_mm: OCC_TOL_MM, touching_mm: CONTACT_TOL_MM, note: 'numerical, not model parameters' },
});

export function nativeReport(sc: Scenario, o: { dense?: number | null; traj?: boolean } = {}) {
  const small = sc.agents.length <= SMALL, dense = o.dense === undefined ? (small ? 0.002 : null) : o.dense;
  const run1 = runNative(sc), tr = toTrajectory(sc, run1.res), run2 = runNative(sc), tr2 = toTrajectory(sc, run2.res);
  const j = judge(sc, tr, { occupancy2d: small });
  const jd = dense ? judge(sc, tr, { dense_dt_s: dense, occupancy2d: false }) : null;
  const hasU = sc.agents.some((a) => a.u_mm !== 0);
  const jSpecU = hasU && small ? judge(sc, toTrajectory(sc, run1.res, { u: 'spec' }), { occupancy2d: true }) : null;
  const other = toTrajectory(sc, runNative(sc, sc.seed + 1).res);
  const solo = small ? Object.fromEntries(sc.agents.map((a) => { const s1 = { ...sc, agents: [a] }; const t = toTrajectory(s1, runNative(s1).res).agents[a.id].arrival_t_s; return [a.id, t === null || t > sc.horizon_s ? null : t - analytic(sc)[a.id]]; })) : null;
  return {
    solver: 'native', model: 'engine/physics/collision.ts simulate() — PH-1 lanes, MV-1 piecewise-constant kinematics, PH-2 encounter rules; event-driven, exact event times',
    lateral_dof: false, lateral_note: 'native 1-D model: u = 0 imposed (no lateral coordinate); the 2-D judge therefore sees every wide-lane pass as bodies on one centre-line',
    scenario: scenarioInfo(sc), cost: run2.cost, cost_first_run: run1.cost, cost_note: 'cost = second (warm) run; cost_first_run includes module warm-up',
    replay: { rerun_identical: hashTraj(tr) === hashTraj(tr2), hash: hashTraj(tr), seed_plus_1_identical: hashTraj(other) === hashTraj(tr) },
    events: counts(tr), arrivals: j.arrivals, final_modes: Object.fromEntries(Object.entries(tr.agents).map(([k, v]) => [k, v.final_mode])),
    solo_arrival_minus_analytic_s: solo,
    judge: j, judge_dense: jd ? { dense_dt_s: dense, ...jd } : null, judge_u_held_at_spec: jSpecU,
    notes: tr.notes, trajectory: o.traj === true && small ? tr : null,
  };
}

export async function rapierReport(sc: Scenario, o: { dt?: number; ccd?: boolean; dense?: number | null; traj?: boolean; sweep?: number[] } = {}) {
  const small = sc.agents.length <= SMALL, dt = o.dt ?? sc.rapier.dt_s, ccd = o.ccd ?? sc.rapier.ccd, dense = o.dense === undefined ? (small ? 0.002 : null) : o.dense;
  const one = async (dts: number) => {
    const r1 = await runRapier(sc, { dt_s: dts, ccd }), r2 = await runRapier(sc, { dt_s: dts, ccd }), rr = await runRapier(sc, { dt_s: dts, ccd, reverse_order: true });
    const j = judge(sc, r1.tr, { occupancy2d: small }), jd = dense ? judge(sc, r1.tr, { dense_dt_s: dense }) : null;
    const an = analytic(sc);
    const solo = small ? Object.fromEntries(await Promise.all(sc.agents.map(async (a) => { const t = (await runRapier(sc, { dt_s: dts, ccd, only: [a.id] })).tr.agents[a.id].arrival_t_s; return [a.id, t === null || t > sc.horizon_s ? null : t - an[a.id]] as const; }))) : null;
    return { dt_s: dts, ccd, params: r1.params, cost: r2.cost, cost_first_run: r1.cost, cost_note: 'cost = second (warm) run of the same dt; cost_first_run may include WASM warm-up', replay: { rerun_identical: hashTraj(r1.tr) === hashTraj(r2.tr), creation_order_reversed_identical: hashTraj(r1.tr) === hashTraj(rr.tr), hash: hashTraj(r1.tr), seed_note: 'no random draw in the Rapier run: the scenario seed has no effect' }, events: counts(r1.tr), arrivals: j.arrivals, solo_arrival_minus_analytic_s: solo, judge: j, judge_dense: jd ? { dense_dt_s: dense, ...jd } : null, tr: r1.tr };
  };
  const main = await one(dt);
  const sweep = [];
  for (const d of o.sweep ?? []) { const s = d === dt ? main : await one(d); const { tr: _t, ...rest } = s; sweep.push(rest); }
  const { tr, ...rest } = main;
  return {
    solver: 'rapier', model: 'Rapier 2D (deterministic-compat) dynamic capsules; velocity towards goal each step; contacts by Rapier; NO biological decisions',
    lateral_dof: true, biology_note: 'Rapier run has NO yield, give-way, crossing wait, contact pause, recruitment or perception; every native behavioural_response has no counterpart here',
    scenario: scenarioInfo(sc), ...rest, dt_sweep: sweep.length ? sweep : null, notes: tr.notes, trajectory: o.traj === true && small ? tr : null,
  };
}

async function main() {
  const args = process.argv.slice(2), arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; }, flag = (k: string) => args.includes(k);
  const id = arg('--scenario');
  if (!id) { console.error(`usage: node prototypes/solver-compare/run.ts --scenario <${listScenarios().join('|')}> [--solver native|rapier|both] [--dt s] [--sweep-dt] [--ccd] [--dense s|0] [--traj]`); process.exit(2); }
  const sc = loadScenario(id), solver = arg('--solver') ?? 'both', dt = arg('--dt') ? Number(arg('--dt')) : undefined, denseArg = arg('--dense'), dense = denseArg === undefined ? undefined : Number(denseArg) || null;
  const outDir = path.join(HERE, 'out'); fs.mkdirSync(outDir, { recursive: true });
  const write = (name: string, x: unknown) => { const p = path.join(outDir, name); fs.writeFileSync(p, JSON.stringify(x, null, 1) + '\n'); return path.relative(process.cwd(), p); };
  if (solver === 'native' || solver === 'both') {
    const r = nativeReport(sc, { dense, traj: flag('--traj') });
    console.log(`native  ${sc.id}: wall ${r.cost.wall_ms.toFixed(1)} ms, ${arrSummary(r.arrivals)}, overlaps(instants/between) ${r.judge.overlap_pair_instants}/${r.judge.overlap_between_instants} max ${r.judge.max_penetration_mm.toExponential(3)}/${r.judge.max_penetration_between_mm.toExponential(3)} mm, (wide-section ${r.judge.overlap_pair_instants_wide_section}), out-of-lane ${r.judge.out_of_walkable_agent_instants}/>1µm ${r.judge.out_of_walkable_gt_coarse} max ${r.judge.max_out_of_walkable_mm.toExponential(2)} mm (junction n/c ${r.judge.junction_not_checked_agent_instants}), obstacle ${r.judge.obstacle_violation_agent_instants}, body contacts ${r.judge.body_contact_episodes}, reach contacts ${r.judge.reach_contact_episodes}, replay ${r.replay.rerun_identical} → ${write(`${sc.id}-native.json`, r)}`);
  }
  if (solver === 'rapier' || solver === 'both') {
    if (!(await loadRapier())) { console.log(`rapier  ${sc.id}: NOT RUN — @dimforge/rapier2d-deterministic-compat is not installed in prototypes/solver-compare (npm ci there)`); return; }
    const r = await rapierReport(sc, { dt, ccd: flag('--ccd') ? true : undefined, dense, traj: flag('--traj'), sweep: flag('--sweep-dt') ? [1 / 60, 1 / 120, 1 / 240] : undefined });
    console.log(`rapier  ${sc.id} dt=${r.dt_s.toFixed(6)}: wall ${r.cost.wall_ms.toFixed(1)} ms, ${arrSummary(r.arrivals)}, overlaps(instants/between) ${r.judge.overlap_pair_instants}/${r.judge.overlap_between_instants} max ${r.judge.max_penetration_mm.toExponential(3)} mm (wide-section ${r.judge.overlap_pair_instants_wide_section}), out-of-lane ${r.judge.out_of_walkable_agent_instants}/>1µm ${r.judge.out_of_walkable_gt_coarse} max ${r.judge.max_out_of_walkable_mm.toExponential(2)} mm (junction n/c ${r.judge.junction_not_checked_agent_instants}), obstacle ${r.judge.obstacle_violation_agent_instants} (max ${r.judge.max_obstacle_penetration_mm.toExponential(3)} mm), body contacts ${r.judge.body_contact_episodes} (only between instants ${r.judge.body_contacts_only_between_instants}), rapier events ${r.cost.raw_collision_events}, replay ${r.replay.rerun_identical}, order-reversed ${r.replay.creation_order_reversed_identical} → ${write(`${sc.id}-rapier.json`, r)}`);
    for (const s of r.dt_sweep ?? []) console.log(`   sweep dt=${s.dt_s.toFixed(6)}: wall ${s.cost.wall_ms.toFixed(1)} ms, ${arrSummary(s.arrivals)}, overlaps ${s.judge.overlap_pair_instants}/${s.judge.overlap_between_instants} max ${s.judge.max_penetration_mm.toExponential(3)} mm, obstacle ${s.judge.obstacle_violation_agent_instants}, contacts-only-between ${s.judge.body_contacts_only_between_instants}`);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
