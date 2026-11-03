/**
 * MV-1 / MV-2 (Issue #69): kinematics on PH-1 synthetic lanes. Engineering tests: ds/dt = v, analytic event times,
 * waits delaying arrival, units, slope, no teleport, Δt convergence, persistent individual speed trait, event order by
 * speed and not by array order, and consistency with the engine's existing route-level walking time.
 * Passing says the maths is right; it does not validate ant biology (see the motion-candidates file for evidence).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';
import { polylineLength, dist } from '../engine/physics/vec.ts';
import {
  type AgentKinematics, type MotionInterval, type SpeedModel, type WorldEvent,
  walk, wait, stateAt, summarize, checkTrajectory, timeToReach, passageOf, positionAt, vertexArcs,
  mmPerS_from_cmPerMin, cmPerMin_from_mmPerS, mm_from_cm, minutes_from_s,
  legSpeed, individualSpeedFactor, individualSpeed, orderEvents,
} from '../engine/physics/kinematics.ts';
import { edgePlanMinutes } from '../engine/activity.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const throws = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, re, why); checks++; };
const dir = path.join(REPO_ROOT, 'scenarios/physics');
const geo = (n: string): PhysicsGeometry => JSON.parse(fs.readFileSync(path.join(dir, `${n}.geometry.json`), 'utf8'));
const cand = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.motion-candidates.json'), 'utf8'));
const model: SpeedModel = {
  trail_speed_mm_s: { outbound: cand.trail_speed_mm_s.outbound.value, returning: cand.trail_speed_mm_s.returning.value, pooled: cand.trail_speed_mm_s.pooled.value },
  off_trail_factor: cand.off_trail_factor.value, individual_cv: cand.individual_cv.value,
};
const agent = (id: string, passage: string, s = 0, d: 1 | -1 = 1, t = 0, v = 17): AgentKinematics => ({ id, passage, s_mm: s, dir: d, t_s: t, state: 'stopped', speed_mm_s: 0, base_speed_mm_s: v });

// ---- 1. constant speed: analytic arrival, ds/dt = v, one record on a straight lane
const open = geo('open-plane'), Po = passageOf(open, 'P-open'), Lo = vertexArcs(Po).at(-1)!;
{
  const r = walk(Po, agent('A', 'P-open'), Lo, 17);
  ok(r.intervals.length === 1 && near(r.agent.t_s, 500 / 17) && r.agent.s_mm === 500 && r.agent.state === 'stopped', 'straight 500 mm at 17 mm/s arrives at 500/17 s');
  for (const t of [0, 1, 7.3, 15, 29]) { const st = stateAt(r.intervals, t)!; ok(near(st.s_mm, Math.min(500, 17 * t)), `s(${t}) = v·t`); }
  const h = r.intervals[0].heading!; ok(near(h[0], 1) && near(h[1], 0) && near(h[2], 0), 'heading east');
  ok(checkTrajectory(Po, r.intervals, 17).length === 0, 'consistent trajectory');
  const sm = summarize(r.intervals, 17);
  ok(near(sm.path_length_mm, 500) && near(sm.displacement_mm, 500) && near(sm.mean_moving_speed_mm_s!, 17) && near(sm.trip_speed_mm_s!, 17) && near(sm.added_time_s!, 0), 'free walk: moving speed = trip speed, no added time');
  const a0 = agent('A', 'P-open'); walk(Po, a0, Lo, 17); ok(a0.s_mm === 0 && a0.t_s === 0, 'walk() does not mutate its input (pure)');
  ok(JSON.stringify(walk(Po, agent('A', 'P-open'), Lo, 17)) === JSON.stringify(r), 'replay: same input → identical output');
}
// ---- 2. polyline: split at vertices, constant heading inside each record, path length vs displacement
const stone = geo('stone-road'), Pd = passageOf(stone, 'P-detour');
{
  const L = vertexArcs(Pd).at(-1)!, r = walk(Pd, agent('B', 'P-detour'), L, 17);
  ok(r.intervals.length === Pd.centerline_mm.length - 1, `detour split at every vertex (${r.intervals.length} records)`);
  ok(near(L, polylineLength(Pd.centerline_mm.map(([x, y, z]) => ({ x, y, z })))), 'arc length = polyline length');
  for (const iv of r.intervals) {
    const d = dist({ x: iv.start_mm[0], y: iv.start_mm[1], z: iv.start_mm[2] }, { x: iv.end_mm[0], y: iv.end_mm[1], z: iv.end_mm[2] });
    ok(near(d, iv.distance_mm, 1e-9), 'inside a record the walk is a straight line (constant heading)');
  }
  const sm = summarize(r.intervals, 17);
  ok(sm.displacement_mm < sm.path_length_mm - 1 && near(sm.displacement_mm, Math.hypot(Pd.centerline_mm.at(-1)![0] - Pd.centerline_mm[0][0], Pd.centerline_mm.at(-1)![1] - Pd.centerline_mm[0][1])) && near(sm.path_length_mm, L), `route length ${sm.path_length_mm.toFixed(3)} > displacement ${sm.displacement_mm}`);
  ok(checkTrajectory(Pd, r.intervals, 17).length === 0, 'detour trajectory consistent');
  const back = walk(Pd, agent('B2', 'P-detour', L, -1), 0, 17);
  ok(near(back.agent.t_s, r.agent.t_s) && back.intervals.every((iv) => iv.s_end_mm <= iv.s_start_mm) && checkTrajectory(Pd, back.intervals, 17).length === 0, 'dir −1 walks the same lane back in the same time');
}
// ---- 3. zero speed, invalid input
throws(() => walk(Po, agent('A', 'P-open'), 100, 0), /positive/, 'zero walking speed is refused (use wait)');
throws(() => walk(Po, agent('A', 'P-open'), 100, Infinity), /finite/, 'infinite speed refused');
throws(() => walk(Po, agent('A', 'P-open', 200), 100, 17), /backwards/, 'cannot walk against its direction');
throws(() => walk(Po, agent('A', 'P-open'), 600, 17), /outside/, 'target off the passage refused');
throws(() => walk(Po, agent('A', 'P-stone'), 100, 17), /not P-open|is on/, 'agent on another passage refused');
throws(() => wait(Po, agent('A', 'P-open'), -1, 'yield'), /≥ 0/, 'negative wait refused');
ok(timeToReach(0, 10, 0) === Infinity && timeToReach(5, 5, 0) === 0, 'timeToReach: v=0 never arrives, zero distance takes no time');
// ---- 4. sudden stop, wait, resume: waiting delays arrival by exactly the wait
{
  let a = agent('C', 'P-open'); const traj: MotionInterval[] = [];
  let r = walk(Po, a, Lo, 17, { until_s: 10 }); a = r.agent; traj.push(...r.intervals);
  ok(near(a.s_mm, 170) && a.state === 'moving' && a.speed_mm_s === 17, 'stopped by until_s at s = v·t');
  r = wait(Po, a, 2.5, 'yield', 'D'); a = r.agent; traj.push(...r.intervals);
  ok(a.state === 'waiting' && a.speed_mm_s === 0 && near(a.t_s, 12.5) && a.s_mm === 170, 'waiting: zero speed, position held, clock advances');
  r = walk(Po, a, Lo, 17); a = r.agent; traj.push(...r.intervals);
  ok(near(a.t_s, 500 / 17 + 2.5), `arrival delayed by exactly the 2.5 s wait (${a.t_s})`);
  const sm = summarize(traj, 17);
  ok(near(sm.waiting_time_s, 2.5) && near(sm.moving_time_s, 500 / 17) && near(sm.mean_moving_speed_mm_s!, 17) && near(sm.trip_speed_mm_s!, 500 / (500 / 17 + 2.5)) && near(sm.added_time_s!, 2.5), 'moving speed unchanged, trip speed lower, added time = wait');
  ok(checkTrajectory(Po, traj, 17).length === 0, 'walk–wait–walk is contiguous (no teleport)');
  ok(near(stateAt(traj, 11)!.s_mm, 170) && stateAt(traj, 11)!.kind === 'wait', 'state during the wait');
  const st = wait(Po, agent('E', 'P-open'), 1, null);
  ok(st.intervals[0].kind === 'stop' && st.agent.state === 'stopped', 'a stop without a cause is a stop, not a wait');
}
// ---- 5. checkTrajectory catches teleport, wrong speed, overspeed, moving wait
{
  const good = walk(Po, agent('F', 'P-open'), 200, 17, { until_s: 5 }).intervals.concat(walk(Po, { ...agent('F', 'P-open', 85, 1, 5) }, 200, 17).intervals);
  ok(checkTrajectory(Po, good, 17).length === 0, 'reference trajectory clean');
  const tele = structuredClone(good); tele[1].s_start_mm += 3; tele[1].distance_mm -= 3; tele[1].t_start_s += 3 / 17;
  ok(checkTrajectory(Po, tele, 17).some((m) => /teleport/.test(m)), 'teleport detected');
  const fast = structuredClone(good); fast[0].speed_mm_s = 30;
  ok(checkTrajectory(Po, fast, 40).some((m) => /v·Δt/.test(m)), 'distance ≠ speed × time detected');
  ok(checkTrajectory(Po, good, 10).some((m) => /vmax/.test(m)), 'overspeed detected');
  const gap = structuredClone(good); gap[1].t_start_s += 1; gap[1].t_end_s += 1;
  ok(checkTrajectory(Po, gap, 17).some((m) => /gap/.test(m)), 'time gap detected');
}
// ---- 6. units: mm, s; conversions; agreement with the engine's existing route-level walking time
ok(near(mmPerS_from_cmPerMin(cmPerMin_from_mmPerS(17)), 17) && near(cmPerMin_from_mmPerS(17), 102) && mm_from_cm(1) === 10 && minutes_from_s(60) === 1, 'unit conversions (17 mm/s = 102 cm/min)');
{
  // engine/activity.ts edgePlanMinutes: len_cm·10·tortuosity / (trail speed · off-trail factor) / 60 minutes
  const sp = readJson('species/pheidole-megacephala.json') as Any, wp = { routes: { edge_length_cm: { 'A:B': 50 }, path_tortuosity: 1, route_edge_minutes: 99 } } as Any;
  const spv = { activity: { trail_walking_speed_mm_s: sp.activity.trail_walking_speed_mm_s.value, off_trail_speed_factor: sp.activity.off_trail_speed_factor.value } } as Any;
  const engineMin = edgePlanMinutes(spv, wp, 'A', 'B');
  const lane = { id: 'L', centerline_mm: [[0, 0, 0], [mm_from_cm(50), 0, 0]], width_mm: 10, route_edge_ref: 'A:B', provenance: open.passages[0].provenance } as Any;
  const v = legSpeed(model, 'unknown', false)!;
  const physMin = minutes_from_s(walk(lane, agent('G', 'L'), mm_from_cm(50), v).agent.t_s);
  ok(near(physMin, engineMin, 1e-6), `50 cm edge off-trail: physics ${physMin} min = engine ${engineMin} min (same units, same speed)`);
  ok(cand.trail_speed_mm_s.pooled.value === sp.activity.trail_walking_speed_mm_s.value && cand.off_trail_factor.value === sp.activity.off_trail_speed_factor.value, 'candidate pooled speed and off-trail factor equal the engine species parameters (no second, conflicting value)');
}
// ---- 7. slope: distance is along the 3D lane; speed does not change with slope (not modelled; stated)
{
  const ml = geo('multi-level'), Pr = passageOf(ml, 'P-ramp'), L = vertexArcs(Pr).at(-1)!;
  ok(near(L, 50 + Math.hypot(100, 20) + 50), `3D lane length on the ramp (${L})`);
  const r = walk(Pr, agent('H', 'P-ramp'), L, 17);
  ok(near(r.agent.t_s, L / 17), 'time = 3D length / speed');
  const ramp = r.intervals[1]; ok(ramp.heading![2] > 0 && near(ramp.heading![2], 20 / Math.hypot(100, 20)), 'heading climbs on the ramp');
  ok(near(positionAt(Pr, L).z, 20) && near(r.intervals.at(-1)!.end_mm[2], 20), 'ends on the upper level (z = 20 mm)');
  ok(r.intervals.every((iv) => iv.model_ref.includes('slope') && iv.model_ref.includes('not modelled')), 'records state that slope/temperature effects are not modelled');
}
// ---- 8. Δt convergence: event times are analytic; a fixed-step integrator converges to them as Δt → 0
{
  const exact = walk(Po, agent('I', 'P-open', 0, 1, 0), 123.4, 17).agent.t_s;
  let prevErr = Infinity;
  for (const dt of [1, 0.1, 0.01, 0.001]) {
    let s = 0, t = 0; while (s < 123.4) { s += 17 * dt; t += dt; }   // naive fixed step: arrival detected at the first sample at/after the goal
    const err = t - exact;
    ok(err >= -1e-9 && err <= dt + 1e-9 && err <= prevErr + 1e-12, `fixed step Δt=${dt}: arrival error ${err.toExponential(2)} ≤ Δt and shrinking`);
    prevErr = err;
    // sampling the analytic trajectory at any Δt never shows the ant past the goal or jumping more than v·Δt
    const tr = walk(Po, agent('I', 'P-open'), 123.4, 17).intervals; let last = 0;
    for (let k = 0; k * dt <= exact + dt; k++) { const st = stateAt(tr, Math.min(k * dt, exact))!; ok(st.s_mm <= 123.4 + 1e-9 && st.s_mm - last <= 17 * dt + 1e-9, `Δt=${dt} sample ${k}: no overshoot, no jump`); last = st.s_mm; if (k > 30) break; }
  }
}
// ---- 9. MV-2 speed model: direction-dependent candidates, unknown stays unknown, persistent individual trait
ok(legSpeed(model, 'outbound', true) === 18.5 && legSpeed(model, 'returning', true) === 15.5 && legSpeed(model, 'unknown', true) === 17, 'leg speeds: outbound 18.5, returning 15.5, pooled 17 mm/s (Vázquez 2020)');
ok(legSpeed(model, 'outbound', false) === 18.5 * 0.5, 'off-trail uses the engine off-trail factor (game assumption)');
ok(legSpeed({ ...model, trail_speed_mm_s: { ...model.trail_speed_mm_s, returning: null } }, 'returning', true) === null && legSpeed({ ...model, off_trail_factor: null }, 'outbound', false) === null, 'unknown values give null, not a substitute number');
ok(cand.individual_cv.value === null && individualSpeedFactor(1, 'W001', null) === 1 && individualSpeed(model, 1, 'W001', 'outbound', true) === 18.5, 'individual variation unknown → no invented variation');
{
  const cv = cand.individual_cv.sensitivity_candidates[1] as number, ids = Array.from({ length: 20000 }, (_, i) => `W${i}`);
  const f = ids.map((id) => individualSpeedFactor(7, id, cv)), mean = f.reduce((a, b) => a + b, 0) / f.length;
  const sd = Math.sqrt(f.reduce((a, b) => a + (b - mean) ** 2, 0) / (f.length - 1));
  ok(Math.abs(mean - 1) < 0.01 && Math.abs(sd / mean - cv) < 0.01 && f.every((x) => x > 0), `trait: mean ${mean.toFixed(4)}, CV ${(sd / mean).toFixed(4)} (target ${cv}), all positive`);
  ok(individualSpeedFactor(7, 'W42', cv) === f[42] && individualSpeedFactor(7, 'W42', cv) === individualSpeedFactor(7, 'W42', cv), 'trait is persistent for the same individual');
  const rev = [...ids].reverse().map((id) => individualSpeedFactor(7, id, cv)).reverse();
  ok(JSON.stringify(rev) === JSON.stringify(f), 'trait does not depend on the order individuals are processed');
  ok(individualSpeedFactor(8, 'W42', cv) !== f[42], 'a different seed gives a different draw');
}
// ---- 10. speed decides world event order; order never depends on array order
{
  const A = walk(Po, agent('A-out', 'P-open'), Lo, legSpeed(model, 'outbound', true)!), B = walk(Po, agent('B-ret', 'P-open'), Lo, legSpeed(model, 'returning', true)!);
  const evs: WorldEvent[] = [{ t_s: B.agent.t_s, kind: 'arrive', agent: 'B-ret', ref: 'P-open:end' }, { t_s: A.agent.t_s, kind: 'arrive', agent: 'A-out', ref: 'P-open:end' }];
  const o = orderEvents(evs);
  ok(o[0].agent === 'A-out' && o[0].t_s < o[1].t_s, `faster ant arrives first (${o[0].t_s.toFixed(3)} s < ${o[1].t_s.toFixed(3)} s)`);
  const delayedA = walk(Po, wait(Po, agent('A-out', 'P-open'), 6, 'yield', 'X').agent, Lo, 18.5);
  ok(orderEvents([{ ...evs[1], t_s: delayedA.agent.t_s }, evs[0]])[0].agent === 'B-ret', 'a 6 s wait (> the 5.23 s speed advantage) reverses the arrival order');
  const tie: WorldEvent[] = [{ t_s: 3, kind: 'arrive', agent: 'Z', ref: null }, { t_s: 3, kind: 'arrive', agent: 'A', ref: null }, { t_s: 3, kind: 'contact', agent: 'M', ref: 'Q' }, { t_s: 1, kind: 'wait', agent: 'Y', ref: null }];
  const canon = JSON.stringify(orderEvents(tie));
  for (const p of [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]]) ok(JSON.stringify(orderEvents(p.map((i) => tie[i]))) === canon, `event order invariant to input permutation ${p}`);
}
// ---- 11. evidence labels of the candidate file
ok(cand.trail_speed_mm_s.outbound.basis === '文獻支持' && /Vázquez/.test(cand.trail_speed_mm_s.outbound.source) && cand.trail_speed_mm_s.conditions.length >= 4, 'speed candidates cite Vázquez 2020 with conditions');
ok(/不把方向差異解釋為負重/.test(cand.trail_speed_mm_s.direction_difference), 'direction difference explicitly NOT attributed to load');
ok(cand.off_trail_factor.basis === '遊戲假設' && Object.keys(cand.not_modelled).sort().join() === 'crowding,load,slope,temperature', 'off-trail factor labelled game assumption; slope/temperature/load/crowding declared not modelled');

console.log(JSON.stringify({ mv1_kinematics: 'pass', checks }, null, 2));
