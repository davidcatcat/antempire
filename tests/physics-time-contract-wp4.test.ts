/**
 * Physics event time-boundary contract (Owner's unified contract; docs/wp4-local-avoidance.md §2b 時間契約), BLOCKING.
 * The solver-agnostic checks (tests/lib/physics-time-contract-wp4.ts) are applied to PH-3b (solve2D, the reference) and to
 * every WP4 local-steer policy, without and with the spawn control rule, on two decision intervals. PH-3b's one known
 * difference ('moving' for an agent that starts exactly at the horizon) is PINNED as pending: it flips — and the pending
 * entry must be removed — when the separate PH-3b fix lands. Then local-steer specifics: exact control-time arithmetic,
 * exit dwell, blocked entry retry, first decision at an entry instant.
 */
import assert from 'node:assert/strict';
import { solve2D, type Solver2DInput } from '../engine/physics/solver2d.ts';
import { steer2D, STEER_POLICIES, type SteerControl, type SteerPolicyId, type SteerResult } from '../engine/physics/local-steer.ts';
import { gridTime, addTime, exactSum, cmpExact, decOf } from '../engine/physics/exact-time.ts';
import { checkPhysicsTimeContract, TC_BODY, type PhysicsTimeAdapter, type TCRun } from './lib/physics-time-contract-wp4.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
const PH3B_PENDING = { startedAtHorizon: { final_mode: 'moving', final_speed_mm_s: 10 } };

const fromSteer = (r: SteerResult): TCRun => ({
  events: r.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class })),
  agents: Object.fromEntries(Object.entries(r.agents).map(([id, a]) => [id, { samples: a.samples, arrival_t_s: a.arrival_t_s, final_mode: a.final_mode, final_speed_mm_s: a.final_speed_mm_s, entered_t_s: a.present_from_t_s ?? null }])),
});
const adapters: PhysicsTimeAdapter[] = [{
  name: 'PH-3b solve2D', grid: null, decisionClasses: [], spawn: false, pending: PH3B_PENDING,
  run: (inp: Solver2DInput) => { const r = solve2D(inp); return { events: r.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class })), agents: Object.fromEntries(Object.entries(r.agents).map(([id, a]) => [id, { samples: a.samples, arrival_t_s: a.arrival_t_s, final_mode: a.final_mode, final_speed_mm_s: a.final_speed_mm_s, entered_t_s: null }])) }; },
}];
for (const p of STEER_POLICIES) for (const [dt, q] of [[0.1, 10], [0.05, 20]] as const) for (const spawn of [false, true]) {
  if (p === 'none' && (spawn || dt !== 0.1)) continue;   // 'none' is PH-3b itself: no decision grid, no control rules
  const control: SteerControl | undefined = spawn ? { spawn: true } : undefined;
  adapters.push({
    name: `local-steer ${p} dt ${dt}${spawn ? ' spawn' : ''}`, grid: p === 'none' ? null : { p: 1, q }, decisionClasses: ['behavioural_response'], spawn,
    pending: p === 'none' ? PH3B_PENDING : undefined,
    run: (inp) => fromSteer(steer2D({ ...inp, policy: p as SteerPolicyId, params: { ...params, decision_interval_s: dt }, seed: 1, control })),
  });
}
const summaries = adapters.map((ad) => checkPhysicsTimeContract(ad, ok));
ok(summaries.filter((s) => s.pending_pinned.includes('started_at_horizon')).map((s) => s.adapter).join(',') === 'PH-3b solve2D,local-steer none dt 0.1', 'only PH-3b (and none = PH-3b) carry the pending started_at_horizon difference');

// ---- exact control-time arithmetic (engine/physics/exact-time.ts)
ok(gridTime(3, 0.1) === 0.3 && 3 * 0.1 !== 0.3, 'grid 3 × 0.1 = 0.3 exactly (the binary product is 0.30000000000000004)');
ok(gridTime(7, 0.05) === 0.35 && gridTime(0, 0.1) === 0 && gridTime(10, 0.1) === 1, 'grid 7 × 0.05 = 0.35; 0; 10 × 0.1 = 1');
for (let k = 0; k <= 5000; k++) ok(gridTime(k, 0.05) === (k * 5) / 100 && gridTime(k, 0.1) === k / 10, `grid k = ${k} is the correctly rounded decimal product`);
ok(addTime(0.1, 0.2) === 0.3 && 0.1 + 0.2 !== 0.3, '0.1 + 0.2 = 0.3 on the decimals');
ok(exactSum([1, 1.3], [-10, 0.1]) === 0.3, 'stall start 1.3 − 10 × 0.1 = 0.3');
ok(cmpExact([[1, 0.1], [1, 0.2]], [[1, 0.3]]) === 0 && cmpExact([[1, 0.1 + 0.2]], [[1, 0.3]]) === 1 && cmpExact([[1, 0.25]], [[1, 0.3]]) === -1, 'exact comparisons, no tolerance; one ulp is still a different instant');
ok(decOf(1e-7).m === 1n && decOf(1e-7).e === 7 && decOf(1.5e21).e === 0 && decOf(-0.3).m === -3n, 'decimal parse of exponent forms and negatives');

// ---- local-steer specifics
const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 200, y: 0 }], width_mm: 10, layer: 'G' }];
const ag = (id: string, s: number, start: number, goal: number, u = 0) => ({ id, lane: 'L', s_mm: s, u_mm: u, dir: 1 as const, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: 10, body: TC_BODY });
for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
  // exit dwell: C arrives 0.05 and takes the single exit slot at the grid instant 0.1 for dwell 0.2; B (arrived 0.1) leaves at
  // exactly 0.3 = 0.1 + 0.2 (before: 0.30000000000000004, the binary product 3 × 0.1)
  const ex = steer2D({ lanes, obstacles: [], agents: [ag('B', 19, 0, 20), ag('C', 19.5, 0, 20, 3)], horizon_s: 1, policy: p, params, seed: 1, control: { exit: { capacity: 1, dwell_s: 0.2 } } });
  ok(ex.agents.C.removed_t_s === 0.1 && ex.agents.B.removed_t_s === 0.3, `${p}: exit slot freed at exactly 0.1 + 0.2 = 0.3 (B left at ${ex.agents.B.removed_t_s})`);
  // blocked entry: X enters at 0 and walks off the entry pose; Y (scheduled 0.05, same pose) waits off the road and retries
  // at the grid instants; it enters at the first one at which the pose is free (X has moved > 2.5 mm + tol: after 0.25 s) = 0.3
  const be = steer2D({ lanes, obstacles: [], agents: [ag('X', 10, 0, 100), ag('Y', 10, 0.05, 100)], horizon_s: 0.6, policy: p, params, seed: 1, control: { spawn: true } });
  ok(be.agents.X.present_from_t_s === 0 && be.agents.Y.present_from_t_s === 0.3 && be.events.some((e) => e.kind === 'entry_blocked' && e.agents[0] === 'Y' && e.t_s === 0.05), `${p}: blocked entry tried at 0.05, entered at the exact grid instant 0.3 (${be.agents.Y.present_from_t_s})`);
  // entry between grid instants: first decision at the entry instant itself (no snapping, no waiting for the grid)
  const mid = steer2D({ lanes, obstacles: [], agents: [ag('M', 10, 0.25, 100)], horizon_s: 0.5, policy: p, params, seed: 1, control: { spawn: true } });
  const mev = mid.events.filter((e) => e.agents[0] === 'M').map((e) => `${e.kind}@${e.t_s}`);
  ok(mev[0] === 'start@0.25' && mev[1] === 'go@0.25' && mid.agents.M.samples[0][0] === 0.25 && Math.abs(mid.agents.M.samples.at(-1)![4] - 12.5) <= 1e-12, `${p}: entered at 0.25, first decision there, 2.5 mm by H (${mev.join(',')})`);
  ok(mid.stats.decision_instants === 5, `${p}: the entry instant is not counted as a grid decision instant (${mid.stats.decision_instants})`);
}
console.log(JSON.stringify({ physics_time_contract_wp4: 'pass', checks, adapters: summaries.map((s) => `${s.adapter}: ${s.checks}${s.pending_pinned.length ? ` (pending pinned: ${s.pending_pinned.join(',')})` : ''}`) }, null, 2));
