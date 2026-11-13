/**
 * #189 / #193 ruling 7 — the decision instant is the ACTUAL entry (or start), using only the local signals at that
 * instant; the no-entry-control path stays test-compatible (engine/physics/lane-flow.ts decision layer). Blocking.
 *  - probe: an oncoming body is outside the sensing radius at the grid instant 0.2 and blocks the way at 0.25; an agent
 *    entering (entry control) or starting (no entry control) at 0.25 decides AT 0.25 and sees it ('wait'); the same
 *    rule evaluated on the 0.2 state would have said 'go';
 *  - causality: the oncoming body's history before 0.25 and its plan after 0.25 do not change the first decision; a body
 *    that enters at 0.26 is not seen at 0.25; locality: a body just beyond the radius is not sensed; a body behind or a
 *    same-direction body ahead does not make it wait;
 *  - every decision's view = exactly the bodies on the lane within the radius at that instant (independent recomputation);
 *    own clock: decisions at anchor + k·interval exactly, anchor = actual entry / start, none at the horizon;
 *  - compatibility: without the decision layer the outputs (with and without entry control) are byte-identical to the
 *    digests pinned before the layer existed; with it both paths conserve agents and do not penetrate;
 *  - 'stop' + decisions: a stopped follower decides again at its next own instant (it is not frozen to the horizon).
 */
import assert from 'node:assert/strict';
import { laneFlow, poseAtFlow, decideGoUnlessOncoming, LaneFlowRefused, type LaneFlowInput, type FlowAgentSpec, type LaneFlowResult } from '../engine/physics/lane-flow.ts';
import { capsuleAt, capGap, dimsOf } from '../engine/physics/kinematics2d.ts';
import { decStr, dec, permutationsOf } from '../engine/physics/destinations.ts';
import { checkConservation, auditContacts, type Threshold } from '../engine/physics/candidate-metrics.ts';
import { exactSum } from '../engine/physics/exact-time.ts';
import { benchmarkSite, normalBenchmark, benchmarkInput, recordsOf } from '../prototypes/lane-flow/lib.ts';
import { compatDigests } from '../prototypes/lane-flow/compat.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const T = (value: number): Threshold => ({ value, assumption: true, basis: '遊戲假設', note: 'observer threshold (test)' });
const BODY = { length_mm: 2.5, width_mm: 0.8 }, R = 1.0, DT = 0.1;
const DECISION = { interval_s: DT, sensing_radius_mm: R, rule: 'go_unless_oncoming' as const };
const ag = (id: string, s: number, v: number, over: Partial<FlowAgentSpec> = {}): FlowAgentSpec => ({ id, dir: 1, s_mm: s, u_mm: 0, goal_s_mm: 55, start_t_s: 0, free_speed_mm_s: v, body: BODY, site: 'nest', ...over });
const run = (agents: FlowAgentSpec[], o: { entry: boolean; H?: number; mode?: 'slow' | 'stop'; decision?: boolean }): LaneFlowResult => laneFlow({ lane: { length_mm: 60, width_mm: 3 }, agents, horizon_s: o.H ?? 1, contact_response: o.mode ?? 'slow', arrival: 'leave_to_ledger', sites: [benchmarkSite()], ...(o.entry ? { entry: { control: true, retry_interval_s: DT } } : {}), ...(o.decision === false ? {} : { decision: DECISION }) });
const first = (r: LaneFlowResult, id: string) => r.decisions!.find((d) => d.agent === id && d.first)!;

// M (→) enters / starts at 0.25 at x = 10 (front 11.25). O (←, 20 mm/s): its front is 1.5 mm from M's front at 0.2
// (outside R = 1) and 0.5 mm at 0.25 (inside, and in M's swept probe).
const M = ag('M', 10, 10, { start_t_s: 0.25 }), O = ag('O', 60 - 18, 20, { dir: -1, goal_s_mm: 59 });
for (const entry of [false, true]) {
  const tag = entry ? 'entry control' : 'no entry control';
  const r = run([M, O], { entry }), d = first(r, 'M');
  ok(Object.is(d.t_s, 0.25) && d.kind === 'wait' && d.sensed.join() === 'O' && d.blocking.join() === 'O', `${tag}: M's first decision at exactly 0.25 sees O and waits (${json(d)})`);
  ok(r.decisions!.filter((x) => x.agent === 'M').every((x) => x.t_s >= 0.25) && (!entry || r.agents.M.present_from_t_s === 0.25), `${tag}: no decision of M before its actual ${entry ? 'entry' : 'start'}`);
  // the same rule on the 0.2 state would say go (the instant matters)
  const o2 = poseAtFlow(r.agents.O, 0.2)!, mPose = { x: 10, y: 0, th: 0 }, dims = dimsOf(BODY, 'M');
  const g2 = capGap(capsuleAt(mPose, dims), capsuleAt(o2, dims)).g;
  const v2 = { t_s: 0.2, self: { id: 'M', pose: mPose, dims }, sensed: g2 <= R ? [{ id: 'O', pose: o2, dims, gap_mm: g2 }] : [] };
  ok(g2 > R && decideGoUnlessOncoming(v2, R).kind === 'go', `${tag}: at the grid instant 0.2 O is ${g2.toFixed(3)} mm away (outside R) → the old pre-start rule would have said go`);
  // causality, past: O rests at its 0.25 pose and only starts at 0.25 → same first decision
  const rp = run([M, ag('O', 60 - 13, 20, { dir: -1, goal_s_mm: 59, start_t_s: 0.25 })], { entry });
  ok(json({ ...first(rp, 'M') }) === json(d), `${tag}: O's history before 0.25 does not change M's decision`);
  // causality, future: O's plan after 0.25 (a nearer goal) does not change it
  const rf = run([M, ag('O', 60 - 18, 20, { dir: -1, goal_s_mm: 50 })], { entry });
  ok(json(first(rf, 'M')) === json(d), `${tag}: O's future does not change M's decision`);
  // locality: O 1 mm further away at 0.25 (0.5 + 1 > R) → not sensed → go
  const rl = run([M, ag('O', 60 - 19, 20, { dir: -1, goal_s_mm: 59 })], { entry });
  ok(first(rl, 'M').kind === 'go' && first(rl, 'M').sensed.length === 0, `${tag}: a body beyond the sensing radius is not sensed (go)`);
  // a same-direction body just ahead (within R, in the probe) and one behind: go
  const rs = run([M, ag('A', 13.0, 5, { start_t_s: 0.25 }), ag('B', 7.0, 5, { start_t_s: 0.25 })], { entry });
  const ds = first(rs, 'M');
  ok(ds.kind === 'go' && ds.sensed.join() === 'A,B' && ds.blocking.join() === 'A', `${tag}: same-direction ahead (blocking, followed) and behind (sensed) → go (${json(ds)})`);
}
// entry control: a body entering at 0.26 right ahead of M is not part of M's 0.25 view
{
  const r = run([M, O, ag('Z', 13.0, 10, { start_t_s: 0.26 })], { entry: true });
  ok(json(first(r, 'M')) === json(first(run([M, O], { entry: true }), 'M')), 'a body that enters at 0.26 is not seen at 0.25');
}

// ---------------------------------------------------------------- every view is exactly the local state at that instant
for (const entry of [true, false]) {
  const sc = normalBenchmark(4, { directions: [1, -1] });
  const inp: LaneFlowInput = { ...benchmarkInput(sc, { horizon_s: 6, contact_response: 'slow', entry }), decision: DECISION };
  if (!entry) inp.agents = sc.agents.filter((a) => a.start_t_s === 0); // without entry control only non-overlapping start poses
  const r = laneFlow(inp), tag = entry ? 'benchmark + entry control' : 'benchmark, no entry control';
  let bad = 0, n = 0;
  const onLane = (id: string, t: number) => { const a = r.agents[id]; return a.present_from_t_s !== null && t >= a.present_from_t_s && (a.removed_t_s === null || t < a.removed_t_s); };
  for (const d of r.decisions!) {
    n++;
    const self = poseAtFlow(r.agents[d.agent], d.t_s)!, dims = dimsOf(BODY, 'x');
    const expect = Object.keys(r.agents).filter((id) => id !== d.agent && onLane(id, d.t_s) && capGap(capsuleAt(self, dims), capsuleAt(poseAtFlow(r.agents[id], d.t_s)!, dims)).g <= R).sort();
    if (json(expect) !== json([...d.sensed].sort())) bad++;
  }
  ok(n > 50 && bad === 0, `${tag}: ${n} decisions, each view = the bodies within R at that instant (${bad} mismatches)`);
  // own clock: anchor = actual entry / start; then anchor + k·DT exactly; none at H
  let clockBad = 0;
  for (const [id, a] of Object.entries(r.agents)) {
    const ts = r.decisions!.filter((d) => d.agent === id).map((d) => d.t_s);
    if (!ts.length) continue;
    const anchor = entry ? a.present_from_t_s! : a.scheduled_t_s;
    if (!ts.every((t, k) => decStr(dec(t)) === decStr(dec(exactSum([1, anchor], [k, DT])))) || ts.some((t) => t >= 6)) clockBad++;
  }
  ok(clockBad === 0, `${tag}: decisions at anchor + k·${DT} s exactly, none at the horizon`);
  const c = checkConservation(Object.keys(r.agents), r.transitions, r.initial_states);
  ok(c.ok, `${tag}: conservation with decisions`);
  const au = auditContacts(recordsOf(r, sc, { candidate: 'x', seed: 4, horizon_s: 6, dt_obs: 0.05, v_max_mm_s: 17 }).gaps, r.classification.contact_episodes.filter((e) => e.geometry === 'body_body').map((e) => ({ agents: e.ids, start_t_s: e.start_t_s, end_t_s: e.end_t_s })), { contact_tol_mm: T(1e-7), penetration_tol_mm: T(1e-9), time_slack_s: T(1e-9), episode_gap_slack_mm: T(1e-3) });
  ok(au.penetration.count === 0 && au.missed_contacts.count === 0, `${tag}: independent audit 0 penetration, 0 missed (${au.samples} samples)`);
  for (const p of permutationsOf(inp.agents, [5])) ok(json(laneFlow({ ...inp, agents: p })) === json(r), `${tag}: agent order does not matter`);
}

// ---------------------------------------------------------------- compatibility (no decision layer: unchanged output)
{
  const PINNED: Record<string, string> = {
    'normal seed 1 slow entry H12': 'f5062f826c381be7f276e496477c12eb6f8ad3bd5b832ec02c1bca22b3f4b7e0',
    'normal seed 2 stop entry H12': 'e94797df8a1d8bb37a67b9359d70aab3d870e584b867881e22c990c70c6a437d',
    'two-way seed 1 slow entry H8': '81edbdcadde79f976e62cdc1eff8709d616aaa862a8b16802f0bedecfab2a8ca',
    'no-entry slow H8': '1e9b9fff3883f427711e387034e276b182e4201ed49ceaa50f87ee041a053b4c',
    'no-entry stop H8': '736f6150862348c5e4cc6915f98f19e9af65ec0050193a262fdb2b5721b9f3a5',
  };
  const now = compatDigests();
  for (const [k, v] of Object.entries(PINNED)) ok(now[k] === v, `compat: '${k}' output byte-identical to the pre-decision-layer digest`);
  ok(!('decisions' in laneFlow(benchmarkInput(normalBenchmark(1), { horizon_s: 2, contact_response: 'slow' }))), 'without the layer the result carries no decisions field');
}

// ---------------------------------------------------------------- 'stop' with decisions: the stop is held only to the next own instant
{
  const ags = [ag('L', 30, 5), ag('F', 20, 10)];
  const frozen = run(ags, { entry: false, H: 8, mode: 'stop', decision: false }), dec2 = run(ags, { entry: false, H: 8, mode: 'stop' });
  ok(frozen.agents.F.arrival_t_s === null, 'stop without decisions: KIN-2D freeze to the horizon');
  ok(dec2.agents.F.arrival_t_s !== null && dec2.decisions!.filter((d) => d.agent === 'F').length > 20, `stop with decisions: F stops at contacts and re-decides (arrives at ${dec2.agents.F.arrival_t_s?.toFixed(3)} s)`);
  const bad = (f: () => unknown, why: string) => { try { f(); ok(false, why); } catch (e) { ok(e instanceof LaneFlowRefused, why); } };
  bad(() => laneFlow({ ...benchmarkInput(normalBenchmark(1), { horizon_s: 1, contact_response: 'slow' }), decision: { interval_s: 0, sensing_radius_mm: 1, rule: 'go_unless_oncoming' } }), 'a zero decision interval is refused');
  bad(() => laneFlow({ ...benchmarkInput(normalBenchmark(1), { horizon_s: 1, contact_response: 'slow' }), decision: { interval_s: 0.1, sensing_radius_mm: 1, rule: 'x' as 'go_unless_oncoming' } }), 'an unknown rule is refused');
}
console.log(JSON.stringify({ k189_entry_decision: 'pass', checks }, null, 2));
