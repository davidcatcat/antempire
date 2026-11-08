/**
 * WP4 local-steer candidates (docs/wp4-local-avoidance.md), BLOCKING:
 *  1. no penetration — every candidate (and the baseline) in every playback scenario: the independent sample-based verifier
 *     (bodies, lane side edges, obstacles; exact convex minimum between records) and the common solver-compare judge
 *     (per-instant + swept overlaps, obstacles, lane bands, 2-D occupancy contract) report 0 violations; also the
 *     100-agent crossing with the verifier. A positive control shows the verifier does catch an overlap;
 *  2. determinism (same input + seed → identical output) and permutation invariance (reversed / shuffled agent arrays);
 *  3. 'none' is exactly the PH-3b solver output (deep-equal agents and events);
 *  4. locality: an agent far away (another lane, out of reach) does not change anyone else's trajectory or draws;
 *  5. failures are kept: head-on in the 1.0 mm corridor is reported (rule D: too narrow for two) and stalls are recorded;
 *  6. refusals: unknown policy, a needed parameter that is null, a bent lane;
 *  7. isolation: the official pipeline does not import the module; no platform API, no unseeded randomness, no species branch;
 *  8. event timing (R13-05/06): analytic arrivals (on a decision-grid point, off-grid, initially at the goal, at the horizon,
 *     recorded once, same as PH-3b) and contacts (the other body starting late, separation across decision boundaries,
 *     positive duration = analytic value); for every candidate and scenario: arrival recorded once at the goal, never
 *     missed; contact_end ≥ contact_start, the gap stays within CONTACT_TOL_MM at every motion record before the end
 *     (the end is never before the separating motion begins) and has just exceeded it at the end.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { steer2D, STEER_POLICIES, SteerRefused, CONTACT_TOL_MM, type SteerResult, type SteerInput, type SteerPolicyId } from '../engine/physics/local-steer.ts';
import { capsuleGap, type Capsule } from '../engine/physics/body2d.ts';
import { solve2D } from '../engine/physics/solver2d.ts';
import { ph3bInput } from '../prototypes/solver-compare/lib/ph3b.ts';
import { judge } from '../prototypes/solver-compare/lib/judge.ts';
import { steerInput, runSteer, verify, runHash, toTrajectory } from '../prototypes/local-steer/lib.ts';
import { scenarioById } from '../prototypes/local-steer/compare.ts';
import { checkContacts, motionFromSamples, type CkMotion } from '../prototypes/local-steer/contact-check.ts';
import { controlScenario, runControl, CONTROL_POLICIES } from '../prototypes/local-steer/controls.ts';
import { CONV_DT } from '../prototypes/local-steer/convergence.ts';
import { DATA_DIR } from '../prototypes/physics-playback/export.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const timing = { arrivals: 0, contacts: 0 };
/** event-timing invariants of one run (R13-05/06), from the run's own records only */
function timingInvariants(inp: SteerInput, res: SteerResult, label: string) {
  const spec = new Map(inp.agents.map((a) => [a.id, a]));
  const capAt = (id: string, t: number): Capsule => {
    const S = res.agents[id].samples, sp = spec.get(id)!;
    let k = 0; while (k + 1 < S.length && S[k + 1][0] <= t) k++;
    const p = S[k], q = S[k + 1], f = q && q[0] > p[0] ? (t - p[0]) / (q[0] - p[0]) : 0;
    const x = q ? p[1] + (q[1] - p[1]) * f : p[1], y = q ? p[2] + (q[2] - p[2]) * f : p[2], h = p[3];
    const hw = Math.max(0, sp.body.length_mm! - sp.body.width_mm!) / 2, d = { x: Math.cos(h) * hw, y: Math.sin(h) * hw };
    return { a: { x: x - d.x, y: y - d.y }, b: { x: x + d.x, y: y + d.y }, r: sp.body.width_mm! / 2 };
  };
  const gap = (i: string, j: string, t: number) => capsuleGap(capAt(i, t), capAt(j, t));
  // arrivals: once, at the goal; an agent that is not arrived never reached its goal at any record
  for (const [id, a] of Object.entries(res.agents)) {
    const sp = spec.get(id)!, arr = res.events.filter((e) => e.kind === 'arrive' && e.agents[0] === id);
    ok(arr.length <= 1, `${label}/${id}: arrival recorded at most once`);
    if (a.arrival_t_s !== null) {
      timing.arrivals++;
      ok(arr.length === 1 && arr[0].t_s === a.arrival_t_s && a.arrival_t_s <= inp.horizon_s, `${label}/${id}: arrival event = arrival_t_s ≤ horizon`);
      const at = a.samples.filter((s) => s[0] === a.arrival_t_s).at(-1)!;
      ok(at && Math.abs((at[4] - sp.goal_s_mm) * sp.dir) <= 1e-9 && (a.final_mode === 'arrived' || (a.final_mode === 'exited' && a.removed_t_s! >= a.arrival_t_s!)), `${label}/${id}: at the goal on arrival (then arrived or left by the exit)`);
      ok(a.samples.every((s) => s[0] <= a.arrival_t_s! || (s[1] === at[1] && s[2] === at[2])), `${label}/${id}: no motion after arrival`);
    } else {
      ok(arr.length === 0 && (sp.start_t_s > inp.horizon_s || a.samples.every((s) => (sp.goal_s_mm - s[4]) * sp.dir > 1e-12)), `${label}/${id}: not arrived → not started by the horizon, or never at its goal (no missed arrival)`);
    }
  }
  // contacts: matched start/end per pair
  const open = new Map<string, number>();
  const episode = (i: string, j: string, ts: number, te: number | null) => {
    timing.contacts++;
    const end = te ?? inp.horizon_s, recs = [...new Set([ts, ...res.agents[i].samples.map((s) => s[0]), ...res.agents[j].samples.map((s) => s[0])])].filter((t) => t >= ts && t < end);
    if (te !== null) ok(te >= ts, `${label}/${i}-${j}: contact_end ${te} ≥ contact_start ${ts}`);
    for (const r of recs) ok(gap(i, j, r) <= CONTACT_TOL_MM + 1e-12, `${label}/${i}-${j}: still in contact at record ${r} (start ${ts}, end ${te}): gap ${gap(i, j, r)}`);
    if (te !== null) {
      ok(gap(i, j, te) > CONTACT_TOL_MM / 2, `${label}/${i}-${j}: gap has opened at contact_end ${te} (${gap(i, j, te)})`);
      ok(te - 1e-9 < ts || gap(i, j, te - 1e-9) <= CONTACT_TOL_MM + 1e-12, `${label}/${i}-${j}: contact_end is the first separation (to 1e-9 s)`);
    }
  };
  for (const e of res.events) {
    if (e.kind !== 'contact_start' && e.kind !== 'contact_end' && e.kind !== 'contact_end_estimated') continue;
    const key = e.agents.join('|');
    if (e.kind === 'contact_start') { ok(!open.has(key), `${label}/${key}: no nested contact_start`); open.set(key, e.t_s); }
    else if (e.kind === 'contact_end_estimated') {
      // a body left the road (control exit): not a physical separation, flagged, at that body's removal instant
      ok(open.has(key) && e.usable_as_cause === false && e.agents.some((id) => res.agents[id].removed_t_s === e.t_s), `${label}/${key}: contact_end_estimated is flagged and at a removal instant`);
      open.delete(key);
    }
    else { ok(open.has(key), `${label}/${key}: contact_end has a start`); ok(Array.isArray(e.bracket_s) && e.bracket_s[1] === e.t_s && e.bracket_s[0] <= e.t_s, `${label}/${key}: contact_end carries its bisection bracket`); episode(e.agents[0], e.agents[1], open.get(key)!, e.t_s); open.delete(key); }
  }
  for (const [key, ts] of open) { const [i, j] = key.split('|'); episode(i, j, ts, null); }
}

const SMALL = ['head-on-2', 'offset-block', 'pass-clear', 'pass-graze', 'crossing', 'crossing-flank', 'stone', 'corridor-8'];

// 1 + 3: no penetration everywhere; 'none' = PH-3b
for (const id of SMALL) {
  const sc = scenarioById(id);
  const base = solve2D(ph3bInput(sc));
  for (const p of STEER_POLICIES) {
    const res = runSteer(sc, p).res, v = verify(sc, res);
    ok(v.pair_penetrations === 0 && v.static_penetrations === 0 && v.min_pair_gap_mm >= -1e-9 && v.min_static_gap_mm >= -1e-9, `${id}/${p}: verifier finds no penetration (min pair ${v.min_pair_gap_mm}, static ${v.min_static_gap_mm})`);
    const j = judge(sc, toTrajectory(sc, res), { occupancy2d: true });
    ok(j.overlap_pair_instants === 0 && j.overlap_between_instants === 0, `${id}/${p}: judge finds no body overlap`);
    ok(j.obstacle_violation_agent_instants === 0 && j.out_of_walkable_agent_instants === 0, `${id}/${p}: judge finds no obstacle or lane-band violation`);
    ok(j.occupancy2d!.overlap === 0, `${id}/${p}: 2-D occupancy contract finds no overlap`);
    ok(res.stats.unresolved === 0 && res.stats.fallback_intervals === 0, `${id}/${p}: nothing unresolved`);
    if (p === 'none') {
      assert.deepEqual(res.events, base.events.map((e) => ({ ...e }))); checks++;
      for (const aid of Object.keys(base.agents)) { assert.deepEqual(res.agents[aid].samples, base.agents[aid].samples); ok(res.agents[aid].final_mode === base.agents[aid].final_mode && res.agents[aid].arrival_t_s === base.agents[aid].arrival_t_s, `${id}: none = PH-3b agent ${aid}`); }
      ok(res.ph3b !== undefined && JSON.stringify(res.ph3b.stats) === JSON.stringify(base.stats), `${id}: none carries the PH-3b stats unchanged`);
    } else {
      timingInvariants(steerInput(sc, p), res, `${id}/${p}`);
      // every recorded motion change is named by an event of that agent (no unexplained motion)
      for (const [aid, a] of Object.entries(res.agents)) {
        const own = new Set(res.events.filter((e) => e.agents.includes(aid)).map((e) => e.t_s));
        for (let k = 1; k + 1 < a.samples.length; k++) ok(own.has(a.samples[k][0]), `${id}/${p}/${aid}: record at ${a.samples[k][0]} has an event`);
      }
    }
  }
}
// positive control: the verifier catches an overlap planted in a trajectory
{
  const sc = scenarioById('pass-clear'), res = runSteer(sc, 'A_free_direction').res;
  const bad: SteerResult = JSON.parse(JSON.stringify(res));
  const ids = Object.keys(bad.agents).sort(), b0 = bad.agents[ids[1]].samples;
  bad.agents[ids[0]].samples = b0.map((s) => [s[0], s[1], s[2] + 0.3, s[3] + Math.PI, s[4], s[5]]);   // B's path shifted 0.3 mm
  const v = verify(sc, bad);
  ok(v.pair_penetrations > 0 && v.max_pair_penetration_mm > 0.4, 'positive control: verifier finds a planted overlap');
}

// 1 (large) + 2: 100-agent crossing: no penetration, deterministic, permutation invariant
{
  const sc = scenarioById('crossing-traffic-100');
  for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
    const r1 = runSteer(sc, p).res, v = verify(sc, r1), h = runHash(r1);
    ok(v.pair_penetrations === 0 && v.static_penetrations === 0, `crossing-traffic-100/${p}: no penetration (min pair ${v.min_pair_gap_mm})`);
    ok(runHash(runSteer(sc, p).res) === h, `crossing-traffic-100/${p}: rerun identical`);
    ok(runHash(runSteer(sc, p, { order: 'reversed' }).res) === h, `crossing-traffic-100/${p}: reversed input identical`);
    ok(runHash(runSteer(sc, p, { order: 'shuffled' }).res) === h, `crossing-traffic-100/${p}: shuffled input identical`);
    // A–C draw from named streams (the seed must matter); the no-yield control N has no draws (the seed must not matter)
    if (p === 'N_no_yield') ok(runHash(runSteer(sc, p, { seed: 2 }).res) === h, `crossing-traffic-100/${p}: no random draws (seed 2 identical)`);
    else ok(runHash(runSteer(sc, p, { seed: 2 }).res) !== h, `crossing-traffic-100/${p}: the seed is used (seed 2 differs)`);
    ok(r1.stats.stalled + r1.stats.arrived <= 100 && r1.stats.decision_instants === 400, `crossing-traffic-100/${p}: bookkeeping`);
    timingInvariants(steerInput(sc, p), r1, `crossing-traffic-100/${p}`);
  }
  const none = runSteer(sc, 'none').res;
  ok(runHash(none) === runHash(runSteer(sc, 'none', { order: 'shuffled' }).res), 'crossing-traffic-100/none: shuffled input identical');
  ok(JSON.stringify(none.events) === JSON.stringify(solve2D(ph3bInput(sc)).events), 'crossing-traffic-100: none = PH-3b events');
}
for (const id of ['corridor-8', 'stone', 'crossing']) for (const p of STEER_POLICIES) {
  const sc = scenarioById(id), h = runHash(runSteer(sc, p).res);
  ok(runHash(runSteer(sc, p, { order: 'reversed' }).res) === h && runHash(runSteer(sc, p, { order: 'shuffled' }).res) === h, `${id}/${p}: permutation invariant`);
}

// 4: locality — a far agent on another lane changes nothing for the others
{
  const sc = scenarioById('head-on-2');
  for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
    const base = steer2D(steerInput(sc, p));
    const inp = steerInput(sc, p);
    inp.lanes = [...inp.lanes, { id: 'far-lane', centerline_mm: [{ x: 0, y: 1000 }, { x: 100, y: 1000 }], width_mm: 10, layer: inp.lanes[0].layer }];
    inp.agents = [...inp.agents, { ...inp.agents[0], id: 'Z-far', lane: 'far-lane', s_mm: 5, u_mm: 0, dir: 1, goal_s_mm: 95 }];
    const more = steer2D(inp);
    for (const aid of Object.keys(base.agents)) assert.deepEqual(more.agents[aid].samples, base.agents[aid].samples);
    ok(JSON.stringify(more.events.filter((e) => !e.agents.includes('Z-far'))) === JSON.stringify(base.events), `${p}: a far agent changes nobody else's events`);
    ok(more.agents['Z-far'].arrival_t_s !== null, `${p}: the far agent walks its free lane`);
  }
}

// 5: failures are kept and reported
{
  const sc = scenarioById('head-on-2');
  for (const p of ['A_free_direction', 'C_sidestep'] as const) {
    const res = runSteer(sc, p).res;
    ok(res.stats.arrived === 0 && res.stats.stalled === 2, `head-on-2/${p}: both stall in the 1.0 mm corridor (kept, not hidden)`);
    ok((res.stats.blocked_reports.too_narrow_for_two ?? 0) === 2 && res.events.filter((e) => e.kind === 'blocked_report' && /^too_narrow_for_two/.test(e.detail ?? '')).length === 2, `head-on-2/${p}: rule D reports 'too narrow for two'`);
    ok(res.events.filter((e) => e.kind === 'stalled').length === 2, `head-on-2/${p}: stalled events at the horizon`);
  }
  const b = runSteer(sc, 'B_contact_decision').res;
  const narrowDecisions = b.events.filter((e) => e.class === 'behavioural_response' && /too narrow to pass/.test(e.detail ?? ''));
  ok(narrowDecisions.length > 0 && narrowDecisions.every((e) => e.kind === 'back_off' || e.kind === 'wait'), 'head-on-2/B: where too narrow for two, only wait / back off (re-route excluded)');
  const none = runSteer(sc, 'none').res;
  ok(none.events.filter((e) => e.kind === 'stalled').length === 2, 'head-on-2/none: PH-3b stalls kept');
}

// 6: refusals
{
  const sc = scenarioById('head-on-2');
  const refused = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof SteerRefused; } };
  ok(refused(() => steer2D({ ...steerInput(sc, 'A_free_direction'), policy: 'keep_right' as never })), 'unknown policy refused');
  for (const p of ['A_free_direction', 'B_contact_decision', 'C_sidestep'] as const) ok(refused(() => steer2D(steerInput(sc, p, { over: { sensing_radius_mm: null } }))), `${p}: null sensing radius refused`);
  ok(refused(() => steer2D(steerInput(sc, 'B_contact_decision', { over: { p_back: null } }))), 'B: null p_back refused');
  ok(!refused(() => steer2D(steerInput(sc, 'A_free_direction', { over: { p_back: null } }))), 'A does not need p_back');
  ok(refused(() => steer2D(steerInput(sc, 'B_contact_decision', { over: { p_wait: 0.5 } }))), 'B: probabilities must sum to 1');
  const bent = steerInput(sc, 'C_sidestep');
  bent.lanes = bent.lanes.map((l) => ({ ...l, centerline_mm: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 10 }] }));
  ok(refused(() => steer2D(bent)), 'a bent lane is refused (no body-rotation model)');
}

// 8: event timing — analytic cases (R13-05 arrival at an interval end; R13-06 contact end from the actual separation)
{
  const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 10, layer: 'G' }], body = { length_mm: 2.5, width_mm: 0.8 };
  const ag = (id: string, s: number, start: number, goal: number) => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1 as const, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: 10, body });
  const run = (policy: SteerPolicyId, agents: ReturnType<typeof ag>[], horizon_s: number, dt: number) => { const inp: SteerInput = { lanes, obstacles: [], agents, horizon_s, policy, params: { ...params, decision_interval_s: dt }, seed: 1 }; return { inp, res: steer2D(inp) }; };
  const near = (x: number | null, y: number, tol = 1e-12) => x !== null && Math.abs(x - y) <= tol;
  // arrivals: [label, start s, start time, goal, horizon, dt, expected arrival (null = none)]
  const cases: [string, number, number, number, number, number, number | null][] = [
    ['on a decision-grid point', 10, 0, 11, 0.4, 0.1, 0.1],
    ['off grid', 10, 0, 11.1, 0.4, 0.1, 0.11],
    ['on grid, late start', 10, 0.05, 11, 0.4, 0.1, 0.15],
    ['initially at the goal', 10, 0, 10, 0.4, 0.1, 0],
    ['initially at the goal, late start', 10, 0.05, 10, 0.4, 0.1, 0.05],
    ['exactly at the horizon (on grid)', 10, 0, 14, 0.4, 0.1, 0.4],
    ['exactly at the horizon (horizon off grid)', 10, 0, 13.5, 0.35, 0.1, 0.35],
    ['just beyond the horizon', 10, 0, 14.001, 0.4, 0.1, null],
    ['start after the horizon', 10, 0.5, 10, 0.4, 0.1, null],
  ];
  for (const p of STEER_POLICIES) for (const [label, s0, st, goal, H, dt, exp] of cases) {
    const { inp, res } = run(p, [ag('A', s0, st, goal)], H, dt), a = res.agents.A;
    ok(exp === null ? a.arrival_t_s === null : near(a.arrival_t_s, exp), `${p}: arrival ${label}: expected ${exp}, got ${a.arrival_t_s}`);
    ok(res.events.filter((e) => e.kind === 'arrive').length === (exp === null ? 0 : 1), `${p}: arrival ${label} recorded exactly ${exp === null ? 0 : 1} time(s)`);
    ok(exp === null || (a.final_mode === 'arrived' && !res.events.some((e) => e.kind === 'stop')), `${p}: arrival ${label}: final mode arrived, no stop event`);
    const ph = solve2D({ lanes, obstacles: [], agents: inp.agents, horizon_s: H });
    ok(exp === null ? ph.agents.A.arrival_t_s === null : near(ph.agents.A.arrival_t_s, exp), `PH-3b reference: arrival ${label} = ${ph.agents.A.arrival_t_s}`);
    timingInvariants(inp, res, `arrival ${label}/${p}`);
  }
  // contacts: A (s 10) follows B (s 13.1, starting late); A stops on touching B at (13.1 − 2.5 − 10)/10 = 0.06 s and the
  // contact lasts until B's own motion opens the gap beyond CONTACT_TOL_MM: end = B start + (tol − gap at stop)/10 mm/s
  for (const p of ['B_contact_decision', 'C_sidestep'] as const) for (const [bStart, dt] of [[0.15, 0.2], [0.25, 0.2], [0.33, 0.1], [0.07, 0.05], [0.41, 0.2]] as const) {
    const { inp, res } = run(p, [ag('A', 10, 0, 90), ag('B', 13.1, bStart, 90)], 0.5, dt), lbl = `${p}: B starts at ${bStart}, decision interval ${dt}`;
    const cs = res.events.filter((e) => e.kind === 'contact_start'), ce = res.events.filter((e) => e.kind === 'contact_end');
    ok(cs.length === 1 && ce.length === 1, `${lbl}: one contact episode (${cs.length}/${ce.length})`);
    const ts = cs[0].t_s, sA = res.agents.A.samples.find((s) => s[0] === ts)!, g0 = sA ? 13.1 - sA[4] - 2.5 : NaN;
    ok(near(ts, 0.06, 1e-9), `${lbl}: contact starts at 0.06 s (${ts})`);
    const expEnd = bStart + (CONTACT_TOL_MM - g0) / 10;
    ok(near(ce[0].t_s, expEnd, 1e-12), `${lbl}: contact ends at B's start + (tol − gap)/v = ${expEnd} (${ce[0].t_s})`);
    ok(ce[0].t_s >= bStart && ce[0].t_s - ts > 0 && near(ce[0].t_s - ts, expEnd - 0.06, 1e-9), `${lbl}: positive contact duration ${ce[0].t_s - ts} = analytic ${expEnd - 0.06}`);
    timingInvariants(inp, res, lbl);
  }
  // control: B starts exactly on A's decision instant → both move at the same speed, the gap never opens: no contact_end
  for (const p of ['B_contact_decision', 'C_sidestep'] as const) {
    const { inp, res } = run(p, [ag('A', 10, 0, 90), ag('B', 13.1, 0.2, 90)], 0.5, 0.2);
    ok(res.events.filter((e) => e.kind === 'contact_start').length === 1 && !res.events.some((e) => e.kind === 'contact_end'), `${p}: lockstep after a contact keeps the contact open`);
    timingInvariants(inp, res, `${p}: lockstep`);
  }
}

// 13 (R15, Codex): the horizon instant itself — PH-3b processes every event with t <= horizon, so an agent starting at
//   t = horizon is started there, and one starting ON its goal arrives exactly once at t = horizon (final mode arrived).
//   Each case is compared with PH-3b (solve2D) on the same input, start and arrive events and arrival time, every policy.
{
  const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 10, layer: 'G' }], body = { length_mm: 2.5, width_mm: 0.8 };
  const ag = (id: string, s: number, start: number, goal: number) => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1 as const, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: 10, body });
  const se = (evs: { t_s: number; kind: string; agents: string[] }[]) => evs.filter((e) => e.kind === 'start' || e.kind === 'arrive').map((e) => `${e.kind}:${e.agents.join('|')}@${e.t_s}`).join(',');
  // [label, start s, start time, goal, horizon]
  const cases: [string, number, number, number, number][] = [
    ['on its goal, start = horizon (on grid)', 10, 0.4, 10, 0.4],
    ['on its goal, start = horizon (horizon off grid)', 10, 0.35, 10, 0.35],
    ['not on its goal, start = horizon', 10, 0.4, 14, 0.4],
    ['on its goal, start > horizon', 10, 0.5, 10, 0.4],
    ['not on its goal, start > horizon', 10, 0.5, 14, 0.4],
    ['on its goal, start < horizon (on grid)', 10, 0.3, 10, 0.4],
    ['on its goal, start < horizon (off grid)', 10, 0.37, 10, 0.4],
    ['not on its goal, start just before the horizon', 10, 0.39, 14, 0.4],
  ];
  for (const [label, s0, st, goal, H] of cases) {
    const agents = [ag('A', s0, st, goal), ag('Z', 50, 0, 60)];
    const ph = solve2D({ lanes, obstacles: [], agents, horizon_s: H }), ref = se(ph.events);
    for (const p of STEER_POLICIES) for (const control of [undefined, { exit: { capacity: 1, dwell_s: 0.5 } }]) {
      if (p === 'none' && control) continue;
      const inp: SteerInput = { lanes, obstacles: [], agents, horizon_s: H, policy: p, params, seed: 1, control }, res = steer2D(inp), a = res.agents.A, lbl = `horizon: ${label}/${p}${control ? '/exit' : ''}`;
      ok(se(res.events) === ref, `${lbl}: start/arrive events = PH-3b (${se(res.events)} vs ${ref})`);
      ok(a.arrival_t_s === ph.agents.A.arrival_t_s, `${lbl}: arrival ${a.arrival_t_s} = PH-3b ${ph.agents.A.arrival_t_s}`);
      ok(res.events.filter((e) => e.kind === 'arrive' && e.agents[0] === 'A').length === (ph.agents.A.arrival_t_s === null ? 0 : 1), `${lbl}: arrival recorded once (or never)`);
      if (ph.agents.A.final_mode === 'arrived') ok(a.final_mode === 'arrived' || (control && a.final_mode === 'exited'), `${lbl}: final mode arrived (${a.final_mode})`);
      if (st === H && goal !== s0) ok(a.final_mode === (p === 'none' ? 'moving' : 'started_at_horizon') && a.samples.every((x) => x[4] === s0), `${lbl}: started at the horizon without motion (${a.final_mode})`);
      if (st > H) ok(a.final_mode === 'not_started' && a.arrival_t_s === null, `${lbl}: not started`);
      timingInvariants(inp, res, lbl);
    }
  }
  // control spawn (scenario rule, no PH-3b counterpart): entry at exactly the scheduled instant (time contract: never
  // snapped to the decision grid), the horizon included; on the goal → arrives exactly once at the entry instant; a
  // schedule after the horizon never enters
  for (const p of STEER_POLICIES.filter((x) => x !== 'none')) for (const control of [{ spawn: true }, { spawn: true, exit: { capacity: 1, dwell_s: 0.5 } }]) {
    for (const [label, st, goal, H, entry] of [['scheduled = horizon, on goal', 0.4, 10, 0.4, 0.4], ['scheduled = horizon (off grid), on goal', 0.35, 10, 0.35, 0.35], ['scheduled = horizon, not on goal', 0.4, 14, 0.4, 0.4], ['scheduled between the last grid instant and the horizon, on goal', 0.37, 10, 0.4, 0.37], ['scheduled after the horizon', 0.5, 10, 0.4, null]] as const) {
      const inp: SteerInput = { lanes, obstacles: [], agents: [ag('A', 10, st, goal)], horizon_s: H, policy: p, params, seed: 1, control }, res = steer2D(inp), a = res.agents.A, lbl = `horizon spawn: ${label}/${p}${control.exit ? '/exit' : ''}`;
      ok(a.present_from_t_s === entry, `${lbl}: entered at ${entry} (${a.present_from_t_s})`);
      // an agent that entered (and arrived) before H leaves by the exit rule at the horizon instant (exits are processed at H)
      const atGoal = goal === 10 && entry !== null;
      ok(se(res.events) === (entry === null ? '' : `start:A@${entry}${atGoal ? `,arrive:A@${entry}` : ''}`), `${lbl}: events ${se(res.events)}`);
      ok(a.arrival_t_s === (atGoal ? entry : null) && a.final_mode === (entry === null ? 'not_entered' : atGoal ? (control.exit && entry < H ? 'exited' : 'arrived') : 'started_at_horizon'), `${lbl}: arrival ${a.arrival_t_s}, mode ${a.final_mode}`);
      timingInvariants(inp, res, lbl);
    }
  }
}

// 7: isolation
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/local-steer.ts'), 'utf8'));
  ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(src), 'local-steer: no unseeded randomness or clock');
  ok(!/pheidole|megacephala/i.test(src), 'local-steer: no species-specific branch');
  ok(!/from\s+['"](node:|fs|path)/.test(src), 'local-steer: no platform API');
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js|mjs|cjs)$/.test(e.name) ? [path.join(d, e.name)] : []) : [];
  const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
  for (const f of official) ok(!/local-steer/.test(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference local-steer`);
  const others = fs.readdirSync(path.join(REPO_ROOT, 'engine/physics')).filter((f) => f.endsWith('.ts') && f !== 'local-steer.ts');
  for (const f of others) ok(!/local-steer/.test(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics', f), 'utf8')), `engine/physics/${f} does not depend on local-steer (PH-3b unchanged)`);
}
// 9 (R14-A): the INDEPENDENT contact_end checker (prototypes/local-steer/contact-check.ts: no engine import, own geometry)
//   over every candidate and the no-yield control in every scenario: each recorded contact_end lies inside the bracket of
//   the physical separation instant computed from the motion segments, the bracket width (error bound) is finite and small,
//   open contacts never separate, and the checker catches planted errors.
const motionOf = (sc: ReturnType<typeof scenarioById>, res: SteerResult) => motionFromSamples(res.agents, res.events, { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value }, sc.horizon_s);
const bracketStats = { episodes: 0, exact: 0, max_err_s: 0 };
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'prototypes/local-steer/contact-check.ts'), 'utf8');
  ok(!/from\s+['"][^'"]*engine\//.test(src) && !/from\s+['"]\.\/lib/.test(src), 'contact-check imports nothing from engine/ or the runner (independent code)');
  for (const id of [...SMALL, 'crossing-traffic-100']) for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
    const sc = scenarioById(id), res = runSteer(sc, p).res, c = checkContacts(motionOf(sc, res));
    ok(c.violations === 0, `${id}/${p}: independent check finds no contact_end outside its bracket (${c.problems.slice(0, 2).join('; ')})`);
    ok(c.list.every((e) => e.end_kind !== 'contact_end' || (e.inside === true && e.err_s !== null && e.err_s >= 0 && e.err_s < 1e-6)), `${id}/${p}: every exact contact_end bracketed, error bound < 1 µs`);
    ok(c.estimated === 0 && !res.events.some((e) => e.kind === 'contact_end_estimated'), `${id}/${p}: no estimated ends without a control exit`);
    ok(c.episodes === res.stats.contacts && c.exact === res.stats.contact_ends_exact, `${id}/${p}: checker sees every contact episode`);
    bracketStats.episodes += c.episodes; bracketStats.exact += c.exact; bracketStats.max_err_s = Math.max(bracketStats.max_err_s, c.max_err_s ?? 0);
    // every stop called a contact stop really touches; a conservative stop does not (left open in R13, fixed here)
    for (const e of res.events.filter((x) => x.kind === 'stop' && /^contact with |^conservative stop/.test(x.detail ?? ''))) {
      const other = /^contact with (\S+)/.exec(e.detail!)?.[1] ?? /planned path of (\S+)/.exec(e.detail!)![1], m = motionOf(sc, res);
      const one = checkContacts({ ...m, events: [{ t: e.t_s, kind: 'contact_start', agents: [e.agents[0], other] }, { t: e.t_s, kind: 'contact_end', agents: [e.agents[0], other] }] });
      const touching = !/gap \S+ mm at contact_start/.test(one.problems.join(' '));
      ok(/^contact with/.test(e.detail!) ? touching : !touching, `${id}/${p}: stop at ${e.t_s} (${e.detail!.slice(0, 40)}…) ${/^contact/.test(e.detail!) ? 'touches' : 'does not touch'}`);
    }
  }
  // the exported playback files (the segments the page draws) pass the same check
  for (const f of fs.readdirSync(DATA_DIR).filter((n) => /--steer-/.test(n))) {
    const run = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
    const c = checkContacts({ horizon_s: run.horizon_s, body: run.body, agents: run.agents.map((a: { id: string; segments: CkMotion['agents'][number]['segments']; final: { x: number; y: number; heading: number } | null; present_from_t_s?: number | null; removed_t_s?: number | null }) => ({ id: a.id, segments: a.segments, final: a.final, present_from: a.present_from_t_s === undefined ? 0 : a.present_from_t_s === null ? Infinity : a.present_from_t_s, present_until: a.removed_t_s ?? null })), events: run.events });
    ok(c.violations === 0 && run.contact_end_check?.violations === 0 && run.events.filter((e: { kind: string; check_s?: number[] }) => e.kind === 'contact_end').every((e: { t: number; check_s?: number[] }) => e.check_s && e.check_s[0] <= e.t && e.t <= e.check_s[1]), `playback ${f}: every contact_end inside the recorded independent bracket`);
  }
  // positive controls: a contact_end moved by 1 ms, a deleted contact_end (the contact claimed open), a removed flag
  const sc = scenarioById('corridor-8'), res = runSteer(sc, 'C_sidestep').res, m = motionOf(sc, res);
  const k = m.events.findIndex((e) => e.kind === 'contact_end');
  ok(k >= 0, 'corridor-8/C has a contact_end to perturb');
  ok(checkContacts({ ...m, events: m.events.map((e, i) => (i === k ? { ...e, t: e.t + 1e-3, bracket_s: undefined } : e)) }).violations > 0, 'positive control: a contact_end shifted by 1 ms is caught');
  ok(checkContacts({ ...m, events: m.events.filter((_, i) => i !== k) }).violations > 0, 'positive control: a missing contact_end (claimed still in contact) is caught');
  ok(checkContacts({ ...m, events: m.events.map((e, i) => (i === k ? { ...e, kind: 'contact_end_estimated' } : e)) }).violations > 0, 'positive control: an exact end relabelled as estimated (no removal, flag missing) is caught');
}

// 10 (R14-A): contact_end_estimated — a contact that ends because a body LEAVES the road (control exit) is flagged, never
//   presented as a physical separation; the checker accepts it only at that body's removal instant
{
  const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 10, layer: 'G' }], body = { length_mm: 2.5, width_mm: 0.8 };
  const ag = (id: string, s: number, goal: number) => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1 as const, start_t_s: 0, goal_s_mm: goal, free_speed_mm_s: 10, body });
  for (const p of ['B_contact_decision', 'C_sidestep', 'N_no_yield'] as const) for (const [cap, dwell] of [[1, 0.35], [1, 1], [2, 0.5]] as const) {
    // C (beside, u = 3) reaches the goal line at 0.05 s and B at 0.1 s; at the decision instant 0.1 s C takes the exit
    // first (earlier arrival); B waits at its goal as an obstacle until a slot frees; A (behind) touches B at 0.75 s
    const inp: SteerInput = { lanes, obstacles: [], agents: [ag('A', 10, 20), ag('B', 19, 20), ag('C', 30, 40)], horizon_s: 2, policy: p, params, seed: 1, control: { exit: { capacity: cap, dwell_s: dwell } } };
    inp.agents[2] = { ...inp.agents[2], s_mm: 19.5, goal_s_mm: 20, u_mm: 3 };     // another arrival on the same exit, beside
    const res = steer2D(inp), lbl = `${p}: exit capacity ${cap}, dwell ${dwell}`;
    const est = res.events.filter((e) => e.kind === 'contact_end_estimated');
    ok(res.agents.B.removed_t_s !== null && res.agents.B.removed_t_s! >= res.agents.B.arrival_t_s!, `${lbl}: B leaves the road after arriving`);
    ok(est.every((e) => e.usable_as_cause === false && /not a physical separation/.test(e.detail ?? '')), `${lbl}: estimated ends are flagged not usable as a cause`);
    const c = checkContacts(motionFromSamples(res.agents, res.events, body, 2));
    ok(c.violations === 0 && c.estimated === est.length && c.list.filter((x) => x.end_kind === 'contact_end_estimated').every((x) => x.usable_as_cause === false), `${lbl}: checker accepts the estimated ends as estimated (${c.problems.join('; ')})`);
    // exit occupancy never exceeds the capacity
    const rem = Object.values(res.agents).map((a) => a.removed_t_s).filter((t): t is number => typeof t === 'number').sort((x, y) => x - y);
    ok(rem.every((t) => rem.filter((u) => u <= t && u + dwell > t).length <= cap), `${lbl}: exit occupancy ≤ capacity`);
    timingInvariants(inp, res, lbl);
    if (p !== 'N_no_yield' || cap !== 1 || dwell !== 1) continue;
    ok(est.length === 1 && est[0].agents.join('|') === 'A|B' && est[0].t_s === res.agents.B.removed_t_s, `${lbl}: the A–B contact ends (estimated) exactly when B leaves (${JSON.stringify(est)})`);
    ok(!res.events.some((e) => e.kind === 'contact_end' && e.agents.join('|') === 'A|B'), `${lbl}: no exact contact_end is invented for A–B`);
  }
  // a refusal: 'none' (PH-3b itself) has no control boundaries
  const sc = scenarioById('head-on-2');
  let refused = false; try { steer2D({ ...steerInput(sc, 'none'), control: { spawn: true } }); } catch (e) { refused = e instanceof SteerRefused; }
  ok(refused, "'none' refuses control boundaries");
}

// 11 (R14-B): control scenarios — finite exit, time-staggered inflow, no-yield control: zero penetration, independent
//   contact check clean, spawn / exit semantics, determinism. Arrivals are NOT asserted (one column, never a target).
{
  const base = scenarioById('crossing-traffic-100');
  for (const variant of ['K0_lattice_stay', 'K1_lattice_exit', 'K2_inflow_stay', 'K3_inflow_exit']) {
    const { sc, control } = controlScenario(base, variant);
    for (const p of CONTROL_POLICIES) {
      const { input, res } = runControl(sc, control, p, 1), v = verify(sc, res), lbl = `${variant}/${p}`;
      ok(v.pair_penetrations === 0 && v.static_penetrations === 0 && v.min_pair_gap_mm >= -1e-9, `${lbl}: no penetration (min pair gap ${v.min_pair_gap_mm} mm)`);
      ok(res.stats.unresolved === 0 && res.stats.fallback_intervals === 0, `${lbl}: nothing unresolved`);
      const c = checkContacts(motionOf(sc, res));
      ok(c.violations === 0 && c.estimated === res.stats.contact_ends_estimated, `${lbl}: independent contact check clean (${c.problems.slice(0, 2).join('; ')})`);
      ok(control.exit ? true : res.stats.contact_ends_estimated === 0, `${lbl}: estimated ends only with an exit`);
      timingInvariants(input, res, lbl);
      for (const [id, a] of Object.entries(res.agents)) {
        if (control.spawn) {
          const from = a.present_from_t_s;
          ok(from === null ? a.samples.length === 0 : from! >= a.scheduled_start_t_s! && a.samples[0][0] === from, `${lbl}/${id}: absent before entry, enters at/after its schedule`);
        }
        if (control.exit && a.removed_t_s !== null && a.removed_t_s !== undefined) ok(a.arrival_t_s !== null && a.removed_t_s >= a.arrival_t_s && a.samples.at(-1)![0] <= a.removed_t_s, `${lbl}/${id}: leaves only after arriving; no motion record after leaving`);
      }
      if (control.spawn) {
        // the entry pose was free at entry: no present body within CONTACT_TOL_MM (checked from the records)
        const m = motionOf(sc, res), entries = Object.entries(res.agents).filter(([, a]) => typeof a.present_from_t_s === 'number');
        let bad = 0;
        for (const [id, a] of entries) for (const [jd, b] of Object.entries(res.agents)) {
          // b is on the road when a enters: entered earlier, or at the same instant but processed first (schedule, then id);
          // exits are processed before entries at a decision instant
          const first = b.present_from_t_s! < a.present_from_t_s! || (b.present_from_t_s === a.present_from_t_s && (b.scheduled_start_t_s! < a.scheduled_start_t_s! || (b.scheduled_start_t_s === a.scheduled_start_t_s && jd < id)));
          if (jd === id || typeof b.present_from_t_s !== 'number' || !first || (b.removed_t_s ?? Infinity) <= a.present_from_t_s!) continue;
          const one = checkContacts({ ...m, events: [{ t: a.present_from_t_s!, kind: 'contact_start', agents: [id, jd] }] });
          if (!/gap \S+ mm at contact_start/.test(one.problems.join(' '))) bad++;
        }
        ok(bad === 0, `${lbl}: every entry pose was free when the agent entered (${bad} violations)`);
      }
      if (p === 'N_no_yield') {
        ok(Object.values(res.agents).every((a) => a.samples.every((s) => Math.abs(s[5] - a.samples[0][5]) <= 1e-9)), `${lbl}: N never moves sideways`);
        ok(res.events.filter((e) => e.class === 'behavioural_response').every((e) => e.kind === 'go'), `${lbl}: N only goes straight`);
      }
    }
    // determinism and permutation invariance of the control rules (K3 has both)
    if (variant === 'K3_inflow_exit') for (const p of CONTROL_POLICIES) {
      const h = runHash(runControl(sc, control, p, 1).res);
      const rev = { ...sc, agents: [...sc.agents].reverse() };
      ok(runHash(runControl(sc, control, p, 1).res) === h && runHash(runControl(rev, control, p, 1).res) === h, `${variant}/${p}: rerun and reversed input identical`);
    }
  }
}

// 12 (R14-A convergence sanity): the decision interval halved / doubled — every run stays penetration-free and its
//   contact ends stay inside the independent brackets; a separation driven by motion alone (the other body starting
//   late) has the SAME physical end time on every decision grid
{
  for (const id of ['head-on-2', 'corridor-8', 'stone']) for (const p of STEER_POLICIES.filter((x) => x !== 'none')) for (const dt of CONV_DT) {
    const sc = scenarioById(id), res = runSteer(sc, p, { over: { decision_interval_s: dt } }).res, v = verify(sc, res), c = checkContacts(motionOf(sc, res));
    ok(v.pair_penetrations === 0 && v.static_penetrations === 0 && c.violations === 0, `${id}/${p}/dt ${dt}: no penetration, contact ends bracketed`);
  }
  const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 10, layer: 'G' }], body = { length_mm: 2.5, width_mm: 0.8 };
  const ag = (id: string, s: number, start: number) => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1 as const, start_t_s: start, goal_s_mm: 90, free_speed_mm_s: 10, body });
  for (const p of ['C_sidestep', 'N_no_yield'] as const) {
    const ends = [0.0125, 0.025, 0.05].map((dt) => steer2D({ lanes, obstacles: [], agents: [ag('A', 10, 0), ag('B', 13.1, 0.33)], horizon_s: 0.5, policy: p, params: { ...params, decision_interval_s: dt }, seed: 1 }).events.filter((e) => e.kind === 'contact_end').map((e) => e.t_s));
    ok(ends.every((e) => e.length === 1) && Math.max(...ends.map((e) => e[0])) - Math.min(...ends.map((e) => e[0])) <= 1e-12, `${p}: motion-driven separation instant independent of the decision interval (${ends.join(' / ')})`);
  }
}
ok(timing.arrivals > 0 && timing.contacts > 0, `timing invariants exercised (${timing.arrivals} arrivals, ${timing.contacts} contact episodes)`);
console.log(JSON.stringify({ wp4_local_steer: 'pass', checks, timing, independent_contact_check: bracketStats }, null, 2));
