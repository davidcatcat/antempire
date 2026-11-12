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
const PH3B_PENDING = { startedAtHorizon: { final_mode: 'moving' } };   // fixed by PR #139: remove when merged

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
  // #139 drift cases (docs/physics-time-contract.md §2.5 on that branch): an exact arrival at H is processed (a derived
  // motion time, so #139's tolerance TIME_TOL(H) = 8·ε·max(1, H) applies; scheduled times above are checked bit-exact)
  const BODY_S = { length_mm: 0.05, width_mm: 0.02 }, dlane = [{ id: 'P', centerline_mm: [{ x: -1, y: 0 }, { x: 11, y: 0 }], width_mm: 2, layer: 'z' }];
  for (const [label, s0, goal, v, st, H] of [['0.1 + 0.2', 1, 1.2, 1, 0.1, 0.3], ['3 × 0.1', 1, 1.3, 0.1, 0, 3], ['0.4 + 0.3', 1, 1.3, 1, 0.4, 0.7], ['reverse 0.1 + 0.2', 1.3, 1.1, 1, 0.1, 0.3]] as const) for (const spawn of [false, true]) {
    const r = steer2D({ lanes: dlane, obstacles: [], horizon_s: H, agents: [{ id: 'A', lane: 'P', s_mm: s0, u_mm: 0, dir: goal >= s0 ? 1 : -1, start_t_s: st, goal_s_mm: goal, free_speed_mm_s: v, body: BODY_S }], policy: p, params, seed: 1, control: spawn ? { spawn: true } : undefined });
    ok(r.agents.A.arrival_t_s !== null && r.agents.A.arrival_t_s <= H && H - r.agents.A.arrival_t_s <= 8 * Number.EPSILON * Math.max(1, H) && r.agents.A.final_mode === 'arrived' && r.events.filter((e) => e.kind === 'arrive').length === 1, `${p}${spawn ? '/spawn' : ''}: drift case ${label}: exact arrival at H = ${H} processed, within #139's TIME_TOL(H) and ≤ H (${r.agents.A.arrival_t_s}, ${r.agents.A.final_mode})`);
  }
  ok(mid.stats.decision_instants === 5, `${p}: the entry instant is not counted as a grid decision instant (${mid.stats.decision_instants})`);
}

// ---- Owner decision 23: the first decision is at the agent's actual start instant, with or without the spawn rule; later
// decisions on the common grid g_k after the start (遊戲假設). Policies that decide (all but 'none').
{
  const DEC = STEER_POLICIES.filter((x) => x !== 'none');
  const BODY = { length_mm: 2, width_mm: 1 };
  const twoLanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 200, y: 0 }], width_mm: 10, layer: 'G' }, { id: 'R', centerline_mm: [{ x: 200, y: 0 }, { x: 0, y: 0 }], width_mm: 10, layer: 'G' }];
  type Sp = { id: string; lane: string; s: number; start: number; goal: number; v: number; u?: number };
  const mk = (x: Sp) => ({ id: x.id, lane: x.lane, s_mm: x.s, u_mm: x.u ?? 0, dir: 1 as const, start_t_s: x.start, goal_s_mm: x.goal, free_speed_mm_s: x.v, body: BODY });
  const run = (p: SteerPolicyId, sp: Sp[], H: number, o: { dt?: number; spawn?: boolean; order?: number[] } = {}) => {
    const ags = sp.map(mk), order = o.order ?? ags.map((_, i) => i);
    return steer2D({ lanes: twoLanes, obstacles: [], agents: order.map((i) => ags[i]), horizon_s: H, policy: p, params: { ...params, decision_interval_s: o.dt ?? 0.1 }, seed: 3, control: o.spawn ? { spawn: true } : undefined });
  };
  const nDec = (r: SteerResult) => Object.values(r.stats.decisions).reduce((x, y) => x + y, 0);
  const mEv = (r: SteerResult, id = 'M') => r.events.filter((e) => e.agents.includes(id));
  /** up to its start an agent is at most a resting body at its start pose (without spawn, as in PH-3b) */
  const restsUntil = (smp: SteerResult['agents'][string]['samples'], st: number, s0: number) => smp.filter((x) => x[0] <= st).every((x) => x[4] === s0);
  // probe: M starts at 0.25 (dt 0.1); the oncoming O is 0.8 mm ahead of M's front at 0.2 (outside the 0.5 mm sensing
  // radius) and 0.3 mm at 0.25 (inside). Deciding at 0.2 (the old rule without spawn) would read a state from before M
  // exists on its path and walk M into O; deciding at 0.25 sees O.
  const O: Sp = { id: 'O', lane: 'R', s: 200 - 14.8, start: 0, goal: 199, v: 10 }, M: Sp = { id: 'M', lane: 'L', s: 10, start: 0.25, goal: 100, v: 20 };
  for (const p of DEC) for (const spawn of [false, true]) {
    const tag = `${p}${spawn ? '/spawn' : ''}`;
    const r = run(p, [O, M], 0.5, { spawn }), ev0 = mEv(r).filter((e) => e.class === 'behavioural_response')[0];
    ok(mEv(r).every((e) => e.t_s >= 0.25) && restsUntil(r.agents.M.samples, 0.25, 10), `${tag}: nothing of M before its start 0.25`);
    ok(Object.is(ev0.t_s, 0.25) && (p === 'N_no_yield' ? ev0.kind === 'go' : ev0.kind !== 'go'), `${tag}: first decision of M at exactly 0.25 and it sees O there (${ev0.kind}@${ev0.t_s})`);
    // causality, past: O with a different history (resting at its 0.25 pose from 0, starting there at 0.25) -> same first decision
    const rp = run(p, [{ ...O, s: 200 - 12.3, start: 0.25 }, M], 0.5, { spawn }), evp = mEv(rp).filter((e) => e.class === 'behavioural_response')[0];
    ok(evp.kind === ev0.kind && evp.detail === ev0.detail && Object.is(evp.t_s, 0.25), `${tag}: M's first decision does not depend on O's history before 0.25 (${evp.kind} vs ${ev0.kind})`);
    // causality, future: O's goal changes only what happens after 0.25 -> same first decision; a body entering at 0.26
    // (spawn) right next to M is not seen at 0.25
    const rf = run(p, [{ ...O, goal: 200 - 12 }, M], 0.5, { spawn }), evf = mEv(rf).filter((e) => e.class === 'behavioural_response')[0];
    ok(evf.kind === ev0.kind && evf.detail === ev0.detail && Object.is(evf.t_s, 0.25), `${tag}: M's first decision does not depend on O's future (${evf.kind})`);
    if (spawn) {
      const rz = run(p, [O, M, { id: 'Z', lane: 'L', s: 7.6, start: 0.26, goal: 100, v: 20, u: 0 }], 0.5, { spawn }), evz = mEv(rz).filter((e) => e.class === 'behavioural_response' && e.agents[0] === 'M')[0];
      ok(evz.kind === ev0.kind && evz.detail === ev0.detail, `${tag}: a body entering at 0.26 does not change M's decision at 0.25`);
    }
  }
  // boundaries and the later schedule: a lone agent decides once at its start and then at every grid instant g_k with
  // start < g_k < H; exact decimal starts (no snapping, no drift); start on the grid, one ulp after it, at H, after H
  const lone = (st: number): Sp => ({ id: 'M', lane: 'L', s: 10, start: st, goal: 190, v: 1 });
  const ulp03 = 0.1 + 0.2;   // 0.30000000000000004: one ulp after the grid instant 0.3, a different instant
  for (const p of DEC) for (const spawn of [false, true]) for (const [dt, q] of [[0.1, 10], [0.05, 20]] as const) {
    const H = 1, tag = `${p}${spawn ? '/spawn' : ''} dt ${dt}`;
    for (const st of [0, 0.25, 0.3, ulp03, 0.31, 0.35, 0.45, 0.7, 0.95, 0.123, 0.999]) {
      const r = run(p, [lone(st)], H, { dt, spawn }), a = r.agents.M;
      const later = Array.from({ length: Math.round(H * q) }, (_, k) => k / q).filter((g) => g > st && g < H).length;
      ok(restsUntil(a.samples, st, 10) && a.samples.some((x) => Object.is(x[0], st)) && (!spawn || Object.is(a.samples[0][0], st)) && Object.is(r.events.find((e) => e.kind === 'start')!.t_s, st), `${tag}: start ${st} recorded at exactly ${st}`);
      ok(nDec(r) === 1 + later, `${tag}: start ${st}: first decision at the start + ${later} grid decisions after it (got ${nDec(r)})`);
      ok(Object.is(mEv(r).find((e) => e.class === 'behavioural_response')!.t_s, st), `${tag}: start ${st}: first decision event at exactly ${st}`);
      ok(r.stats.decision_instants === Math.round(H * q), `${tag}: start ${st}: grid decision instants unchanged by the start (${r.stats.decision_instants})`);
      // first motion begins at the start: displacement at H = v · (H − start) (free lane), within float rounding
      ok(Math.abs(a.samples.at(-1)![1] - (10 + (H - st))) <= 1e-9, `${tag}: start ${st}: displacement from the start instant`);
    }
    const rOn = run(p, [lone(0.3)], H, { dt, spawn }), rUlp = run(p, [lone(ulp03)], H, { dt, spawn });
    ok(nDec(rUlp) === nDec(rOn) && rUlp.agents.M.samples.some((x) => Object.is(x[0], ulp03)) && !rOn.agents.M.samples.some((x) => Object.is(x[0], ulp03)), `${tag}: one ulp after the grid is its own instant (its first decision replaces the grid decision at 0.3, which is before it)`);
    const rH = run(p, [lone(H)], H, { dt, spawn }), rA = run(p, [lone(1.05)], H, { dt, spawn });
    ok(rH.agents.M.final_mode === 'started_at_horizon' && nDec(rH) === 0 && rH.agents.M.final_speed_mm_s === 0, `${tag}: start at H: started_at_horizon, no decision`);
    ok(nDec(rA) === 0 && rA.events.length === 0 && rA.agents.M.final_mode === (spawn ? 'not_entered' : 'not_started'), `${tag}: start after H: no decision, no event (${rA.agents.M.final_mode})`);
  }
  // decision order / tie policy: several agents deciding at the same off-grid start instant (and one on the grid) close
  // enough to perceive each other; every permutation of the input gives a bitwise-identical result
  const tie: Sp[] = [{ id: 'P', lane: 'L', s: 10, start: 0.25, goal: 60, v: 20, u: 0 }, { id: 'Q', lane: 'L', s: 12.2, start: 0.25, goal: 60, v: 20, u: 0.4 }, { id: 'S', lane: 'L', s: 14.4, start: 0.25, goal: 60, v: 20, u: -0.4 }, { id: 'T', lane: 'R', s: 200 - 17, start: 0.3, goal: 199, v: 20, u: 0 }, { id: 'U', lane: 'L', s: 7.8, start: ulp03, goal: 60, v: 20, u: 0 }];
  const perms = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2], [3, 2, 1, 4, 0]];
  for (const p of DEC) for (const spawn of [false, true]) for (const dt of [0.1, 0.05]) {
    const ref = JSON.stringify(run(p, tie, 1.5, { dt, spawn, order: perms[0] }));
    for (const order of perms.slice(1)) ok(JSON.stringify(run(p, tie, 1.5, { dt, spawn, order })) === ref, `${p}${spawn ? '/spawn' : ''} dt ${dt}: same-instant decisions order-invariant (input order ${order.join('')})`);
    const r = JSON.parse(ref) as SteerResult;
    ok(['P', 'Q', 'S'].every((id) => Object.is(r.events.find((e) => e.agents[0] === id && e.class === 'behavioural_response')!.t_s, 0.25)), `${p}${spawn ? '/spawn' : ''} dt ${dt}: the three same-instant agents first decide at 0.25`);
  }
}
console.log(JSON.stringify({ physics_time_contract_wp4: 'pass', checks, adapters: summaries.map((s) => `${s.adapter}: ${s.checks}${s.pending_pinned.length ? ` (pending pinned: ${s.pending_pinned.join(',')})` : ''}`) }, null, 2));
