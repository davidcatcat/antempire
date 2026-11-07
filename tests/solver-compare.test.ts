/**
 * Issue #101 (PH-Rapier-2) step 1: the native side of the solver comparison and the common judge. Offline: needs no npm
 * install (Rapier is exercised only when prototypes/solver-compare/node_modules is present, and then only for replay).
 * Checks: the spec refuses unknown sizes and 2.5D; the native runner on all four scenarios converts to the common format
 * with u = 0 (no lateral DOF) and replays; the judge finds a contact that falls between two samples (positive control,
 * never 0 because nothing was sampled there); every native 2-D overlap lies in a section wide enough for both, i.e. it is
 * the missing lateral coordinate, not a native exclusion failure; no native body enters a wall, stone or leaves its band.
 */
import assert from 'node:assert/strict';
import { loadScenario, ScenarioRefused, type ScenarioFile } from '../prototypes/solver-compare/lib/spec.ts';
import { nativeReport } from '../prototypes/solver-compare/run.ts';
import { judge } from '../prototypes/solver-compare/lib/judge.ts';
import { loadRapier, runRapier } from '../prototypes/solver-compare/lib/rapier.ts';
import type { Trajectory } from '../prototypes/solver-compare/lib/traj.ts';
import fs from 'node:fs';
import { scenarioPath, listScenarios } from '../prototypes/solver-compare/lib/spec.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const file = (id: string): ScenarioFile => JSON.parse(fs.readFileSync(scenarioPath(id), 'utf8'));

// ---- spec: unknowns refuse, 2.5D refuses, values come from the candidate files
{
  const f = file('head-on-2');
  const bad = structuredClone(f); bad.body.width = { ...bad.body.width, path: 'castes.minor.effective_collision_width_mm.value' };
  assert.throws(() => loadScenario(bad), (e: unknown) => e instanceof ScenarioRefused && /unknown values are never defaulted/.test(String(e))); checks++;
  const bad2 = structuredClone(f); bad2.agents![0].speed = { file: 'motion', path: 'individual_cv.value', why: 'null in file' };
  assert.throws(() => loadScenario(bad2), ScenarioRefused); checks++;
  const ml = structuredClone(f); ml.refs.geometry = 'scenarios/physics/multi-level.geometry.json'; ml.agents = [{ ...f.agents![0], passage: 'P-ramp', s_mm: 1, goal_s_mm: 5 }];
  assert.throws(() => loadScenario(ml), (e: unknown) => /2\.5D/.test(String(e))); checks++;
  const sc = loadScenario('head-on-2');
  ok(sc.body.length_mm.value === 2.5 && sc.body.width_mm.value === 0.8 && sc.body.contact_reach_mm.value === 1.0, 'body values picked from the candidate files (2.5 / 0.8 / 1.0 mm)');
  ok(sc.body.width_mm.basis === '遊戲假設' && sc.body.length_mm.basis === '文獻支持', `provenance labels carried (${sc.body.width_mm.basis}, ${sc.body.length_mm.basis})`);
  ok(sc.agents[0].free_speed_mm_s === 18.5 && sc.agents[1].free_speed_mm_s === 15.5, 'speeds from the motion candidates (R133)');
}

// ---- every scenario file has the schema's required keys and no others (top level; the loader checks the values)
{
  const schema = JSON.parse(fs.readFileSync(new URL('../prototypes/solver-compare/scenario.schema.json', import.meta.url), 'utf8'));
  for (const id of listScenarios()) {
    const f = file(id) as unknown as Record<string, unknown>;
    ok(schema.required.every((k: string) => k in f) && Object.keys(f).every((k) => k in schema.properties), `${id}: top-level keys match scenario.schema.json`);
    loadScenario(id); checks++;
  }
}
// ---- judge positive control: two fast bodies cross between two samples; instants show nothing, the swept judge finds it
{
  const sc = loadScenario('crossing');
  const tr: Trajectory = { solver: 'native', scenario: 'control', lateral_dof: true, notes: [], events: [], agents: {
    E: { lane: 'P-east-west', layer: 'z=0', arrival_t_s: null, final_mode: 'x', samples: [[0, 240, 0, 0, 240, 0], [1, 260, 0, 0, 260, 0]] },
    N: { lane: 'P-north-south', layer: 'z=0', arrival_t_s: null, final_mode: 'x', samples: [[0, 250, -10, Math.PI / 2, 240, 0], [1, 250, 10, Math.PI / 2, 260, 0]] },
  } };
  const j = judge({ ...sc, horizon_s: 1 }, tr);
  ok(j.overlap_pair_instants === 0 && j.overlap_between_instants === 1 && j.body_contacts_only_between_instants === 1 && j.max_penetration_between_mm > 0.7, `contact between two samples is found (instants ${j.overlap_pair_instants}, between ${j.overlap_between_instants}, depth ${j.max_penetration_between_mm})`);
  // fronts approach along the diagonal: gap = √2·(9.15 − 20 t) − 0.8 → first touch at t = (9.15 − 0.8/√2)/20
  const tc = (9.15 - 0.8 / Math.SQRT2) / 20;
  ok(Math.abs(j.first_body_contact_t_s! - tc) < 1e-9, `swept contact time ${j.first_body_contact_t_s} = analytic ${tc}`);
}

// ---- Owner P2 (2026-11-07): an arrival after the simulated horizon is not an arrival
{
  const sc = loadScenario('crossing');
  const mk = (t: number | null): Trajectory => ({ solver: 'native', scenario: 'horizon', lateral_dof: true, notes: [], events: [], agents: {
    E: { lane: 'P-east-west', layer: 'z=0', arrival_t_s: t, final_mode: 'x', samples: [[0, 200, 0, 0, 200, 0], [1, 210, 0, 0, 210, 0]] } } });
  const late = judge({ ...sc, horizon_s: 1 }, mk(1.1)), edge = judge({ ...sc, horizon_s: 1 }, mk(1)), early = judge({ ...sc, horizon_s: 1 }, mk(0.5));
  ok(late.arrivals.E === null && late.arrivals_after_horizon_excluded.join() === 'E', 'judge: an arrival at 1.1 s with horizon 1 s is not counted, and is listed as excluded');
  ok(edge.arrivals.E === 1 && early.arrivals.E === 0.5 && edge.arrivals_after_horizon_excluded.length === 0, 'judge: arrivals at or before the horizon are kept (1 s, 0.5 s)');
}

// ---- native runner on the four comparison scenarios
for (const id of ['head-on-2', 'corridor-8', 'stone', 'crossing']) {
  const sc = loadScenario(id), r = nativeReport(sc, { dense: id === 'head-on-2' ? 0.002 : null });
  ok(r.lateral_dof === false && r.notes.some((n) => /no lateral degree of freedom/.test(n)), `${id}: native labelled 1-D (u = 0)`);
  ok(r.replay.rerun_identical, `${id}: native rerun identical`);
  const j = r.judge;
  ok(j.obstacle_violation_agent_instants === 0 && j.out_of_walkable_agent_instants === 0, `${id}: native bodies never enter an obstacle or leave the lane band (${j.obstacle_violation_agent_instants}, ${j.out_of_walkable_agent_instants})`);
  ok(j.overlap_pair_instants === j.overlap_pair_instants_wide_section && j.overlap_between_instants === j.overlap_between_instants_wide_section, `${id}: every native 2-D overlap (u = 0) is in a section wide enough for both — the missing lateral coordinate (${j.overlap_pair_instants}/${j.overlap_pair_instants_wide_section}, ${j.overlap_between_instants}/${j.overlap_between_instants_wide_section})`);
  if (r.judge_dense) ok(r.judge_dense.overlap_pair_instants + r.judge_dense.overlap_between_instants >= 1 === (j.overlap_pair_instants + j.overlap_between_instants >= 1), `${id}: dense sampling agrees with the swept judge on whether overlaps occur`);
  for (const [aid, e] of Object.entries(r.solo_arrival_minus_analytic_s ?? {})) ok(id === 'stone' ? e === null : e !== null && Math.abs(e) < 1e-9, id === 'stone' ? `stone: ${aid} alone never arrives (the stone blocks the lane)` : `${id}: ${aid} alone arrives at distance/speed (error ${e})`);
  console.error(`${id}: native arrivals ${JSON.stringify(r.arrivals)} overlaps ${j.overlap_pair_instants}+${j.overlap_between_instants} body contacts ${j.body_contact_episodes} events ${JSON.stringify(r.events.by_class)}`);
}
{
  const r = nativeReport(loadScenario('stone'));
  ok(Object.values(r.arrivals).every((t) => t === null) && Object.values(r.final_modes).every((m) => m === 'blocked' || m === 'unresolved'), `stone: on the native lane model neither ant passes the stone; stops are reported (${JSON.stringify(r.final_modes)})`);
  ok(r.notes.some((n) => /ignored by the native solver for: S2/.test(n)), 'stone: S2 lateral offset recorded as ignored by the native solver');
}

// ---- Rapier (only if installed in the sub-project): runs, replays bit-identically, has no behavioural events
const R = await loadRapier();
if (R) {
  const sc = loadScenario('head-on-2'), a = await runRapier(sc, { dt_s: 1 / 120, ccd: false }), b = await runRapier(sc, { dt_s: 1 / 120, ccd: false });
  ok(JSON.stringify(a.tr.agents) === JSON.stringify(b.tr.agents), 'Rapier head-on: rerun identical');
  ok(a.tr.lateral_dof && a.tr.events.every((e) => e.class !== 'behavioural_response'), 'Rapier: lateral DOF, no behavioural responses');
  // Owner P2 counterexample: the step count was Math.round(H/dt), so H = 1, dt = 0.4 ran to 1.2 s and could count an arrival
  // after the horizon (dt = 0.3 stopped at 0.9 s). Now the steps end exactly at H and no counted arrival exceeds it.
  const solo = await runRapier(sc, { dt_s: 1 / 120, ccd: false, only: ['W2'] }), tStar = solo.tr.agents.W2.arrival_t_s as number;
  ok(tStar !== null && tStar < sc.horizon_s, `Rapier solo W2 arrives at ${tStar} s within the scenario horizon`);
  for (const dt of [0.3, 0.4, 0.07, 1 / 120]) for (const H of [tStar - 0.5 * dt, tStar - 0.05, tStar + 0.05, tStar + 0.6 * dt]) {
    const r = await runRapier({ ...sc, horizon_s: H }, { dt_s: dt, ccd: false, only: ['W2'] }), t = r.tr.agents.W2.arrival_t_s, last = r.tr.agents.W2.samples.at(-1)![0];
    ok(Math.abs(r.cost.simulated_until_s - H) < 1e-12 && Math.abs(last - H) < 1e-12 && r.tr.agents.W2.samples.every((q) => q[0] <= H + 1e-12), `Rapier dt=${dt.toFixed(4)} H=${H.toFixed(4)}: steps end exactly at the horizon (last sample ${last.toFixed(6)})`);
    ok(t === null || t <= H, `Rapier dt=${dt.toFixed(4)} H=${H.toFixed(4)}: no counted arrival after the horizon (${t})`);
    if (H < tStar - 0.04) ok(t === null, `Rapier dt=${dt.toFixed(4)} H=${H.toFixed(4)} < solo arrival ${tStar.toFixed(4)}: not arrived`);
  }
} else console.error('Rapier not installed in prototypes/solver-compare: Rapier checks skipped (native side and judge fully checked)');
console.log(JSON.stringify({ solver_compare: 'pass', checks, rapier: R ? 'checked' : 'skipped (not installed)' }, null, 2));
