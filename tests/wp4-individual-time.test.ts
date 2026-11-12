/**
 * Owner decision 40 (docs/wp4-individual-time.md), BLOCKING: the EXPERIMENTAL individual decision clock of
 * engine/physics/local-steer.ts (input.decision_clock = 'individual': every agent decides at its own start_t_s + k·dt).
 *  1. default unchanged: without the option the output is the common-grid baseline of PR #142 bit for bit (pinned run
 *     hashes recorded with the engine BEFORE this change; an explicit 'common_grid' equals the omitted field);
 *  2. reduction: when every agent starts at 0 both clocks give the identical run (same instants, same RNG keys);
 *  3. the time contract (T1, T3, T4, T5 of tests/lib/physics-time-contract-wp4.ts) holds with the individual clock, and
 *     every decision lies exactly on the agent's own start + k·dt (exact decimals), with starts between grid points,
 *     one ulp after a grid point, exactly at H and after H; with and without the spawn rule; dt 0.1 and 0.05;
 *  4. same-instant decisions and input order: every permutation of the input gives a bitwise-identical result;
 *  5. physics invariants under the individual clock across scenarios, seeds 1–3 and dt 0.1 / 0.05: 0 penetration
 *     (independent verifier), judge 0, independent contact_end check inside its bracket, determinism and permutation
 *     invariance; also the inflow control scenario K3 (spawn + exit);
 *  6. KNOWN DEFECT KEPT (time slicing): another agent's own instants split an agent's motion interval, and positions are
 *     accumulated per interval, so an agent far away (never perceived) changes another agent's coordinates at the
 *     floating-point level (~1e-14 mm). PINNED: measured, bounded, present in the baseline for off-grid starts too —
 *     the test fails (and this entry must be updated) when the cause is fixed;
 *  7. refusals: an unknown clock; 'none' (no decisions) with the individual clock.
 */
import assert from 'node:assert/strict';
import { steer2D, STEER_POLICIES, SteerRefused, type SteerInput, type SteerPolicyId, type SteerResult, type DecisionClock } from '../engine/physics/local-steer.ts';
import { exactSum } from '../engine/physics/exact-time.ts';
import { steerInput, runHash } from '../prototypes/local-steer/lib.ts';
import { scenarioById } from '../prototypes/local-steer/compare.ts';
import { controlScenario } from '../prototypes/local-steer/controls.ts';
import { tmRow, tmInput, decisionTimeViolations } from '../prototypes/local-steer/time-mode.ts';
import { checkPhysicsTimeContract, contractInput, type PhysicsTimeAdapter, type TCRun } from './lib/physics-time-contract-wp4.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DEC = STEER_POLICIES.filter((p) => p !== 'none') as Exclude<SteerPolicyId, 'none'>[];

// ---- 1. default unchanged (hashes recorded at 97bfcb5, before the individual clock existed)
const PINNED: Record<string, string> = {
  // 'none' (= PH-3b) re-pinned after #139 merged (integration): samples, final modes and every non-contact event are
  // unchanged; only the PH-3b contact events changed (θ-crossing episodes with bracket/err/confirmed fields; crossing-flank
  // 1,567 constraint-toggle starts/ends -> 1 episode). Old pins: head-on-2 6666829951c94f08, crossing-flank 71e67466ed21cb0b,
  // corridor-8 da2b0cbf2cabfe4b (stone a8fbf69acb502adc unchanged: no contact).
  'head-on-2 none': '10395429c462e644', 'head-on-2 A_free_direction 0.1': '68a284e3908135ab', 'head-on-2 A_free_direction 0.05': 'ce22f931fa270144', 'head-on-2 B_contact_decision 0.1': '62c1d792fd2b279a', 'head-on-2 B_contact_decision 0.05': '96ec7d9a28e5bcde', 'head-on-2 C_sidestep 0.1': '20f12b64722c50f5', 'head-on-2 C_sidestep 0.05': 'c973d8cdad8f7c49', 'head-on-2 N_no_yield 0.1': 'e51af25ee87aaea7', 'head-on-2 N_no_yield 0.05': '50c3e94327dddb04',
  'crossing-flank none': 'f3847d4acdeaede0', 'crossing-flank A_free_direction 0.1': 'bb5b88904eadb4cb', 'crossing-flank A_free_direction 0.05': 'c762edac15237ca0', 'crossing-flank B_contact_decision 0.1': 'f8a9e1472af39e80', 'crossing-flank B_contact_decision 0.05': 'bc0724cbacb1b65a', 'crossing-flank C_sidestep 0.1': '76a89d968a666bee', 'crossing-flank C_sidestep 0.05': '4eaffd2ae89b1783', 'crossing-flank N_no_yield 0.1': 'cf722152ccb50529', 'crossing-flank N_no_yield 0.05': '079195e46edbe7d2',
  'stone none': 'a8fbf69acb502adc', 'stone A_free_direction 0.1': '1cdad4f243946a90', 'stone A_free_direction 0.05': '1b1fd2bd0199cb50', 'stone B_contact_decision 0.1': '5db39d5c4c0fb8cd', 'stone B_contact_decision 0.05': '77eeb9e47b132f85', 'stone C_sidestep 0.1': 'b5b3cb2aea47ab92', 'stone C_sidestep 0.05': '58b9b5dcacc92090', 'stone N_no_yield 0.1': 'ac0dc2200d0cee8e', 'stone N_no_yield 0.05': '17872f0c3e5428fa',
  'corridor-8 none': '719df47ded31c8a5', 'corridor-8 A_free_direction 0.1': '1be856fe3dbf3464', 'corridor-8 A_free_direction 0.05': '5e3b88764f1a2cfa', 'corridor-8 B_contact_decision 0.1': '184fee22bc4d01e8', 'corridor-8 B_contact_decision 0.05': 'e691f8a37847a7ae', 'corridor-8 C_sidestep 0.1': '15bdfd26e7e18e06', 'corridor-8 C_sidestep 0.05': '5ffc63d89684b848', 'corridor-8 N_no_yield 0.1': '83d031a9af39c4f2', 'corridor-8 N_no_yield 0.05': '37307599ec14ee6a',
  'K2_inflow_stay A_free_direction': '5312dd8ca0e3fbeb', 'K2_inflow_stay B_contact_decision': '70052281df24ea60', 'K2_inflow_stay C_sidestep': 'd6b490553fd900bb', 'K2_inflow_stay N_no_yield': 'f208338dab5b38f5',
  'K3_inflow_exit A_free_direction': 'cd54349fb07c5563', 'K3_inflow_exit B_contact_decision': '43859f8e2b160664', 'K3_inflow_exit C_sidestep': '4d7536e914c73e26', 'K3_inflow_exit N_no_yield': '9d1eea680dcf46fa',
};
for (const [key, h] of Object.entries(PINNED)) {
  const [id, p, dt] = key.split(' ');
  let inp: SteerInput;
  if (/^K\d_/.test(id)) { const c = controlScenario(scenarioById('crossing-traffic-100'), id); inp = { ...steerInput(c.sc, p as SteerPolicyId, { seed: 1 }), control: c.control }; }
  else inp = steerInput(scenarioById(id), p as SteerPolicyId, { seed: 1, over: dt ? { decision_interval_s: Number(dt) } : {} });
  const r = steer2D(inp);
  ok(runHash(r) === h && r.decision_clock === undefined && r.stats.timeline_instants === undefined, `default clock unchanged: ${key} hash ${runHash(r)} = pinned ${h}; no new output field`);
  if (p !== 'none' && !/^K/.test(id)) ok(JSON.stringify(steer2D({ ...inp, decision_clock: 'common_grid' })) === JSON.stringify(r), `${key}: explicit 'common_grid' = omitted (whole result)`);
}

// ---- 2. reduction: every agent starts at 0 -> the individual clock gives the identical run
for (const id of ['head-on-2', 'stone', 'crossing', 'offset-block', 'pass-clear']) for (const p of DEC) for (const dt of [0.1, 0.05]) for (const seed of [1, 2]) {
  const a = tmInput(id, p, seed, dt, 'common_grid').input, b = tmInput(id, p, seed, dt, 'individual').input;
  ok(a.agents.every((x) => x.start_t_s === 0), `${id}: all start at 0`);
  const ra = steer2D(a), rb = steer2D(b);
  ok(runHash(ra) === runHash(rb) && rb.decision_clock === 'individual', `${id}/${p} dt ${dt} seed ${seed}: all starts at 0 -> individual = common (agents and events bit-identical)`);
}

// ---- 3. time contract with the individual clock
const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
const fromSteer = (r: SteerResult): TCRun => ({
  events: r.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class })),
  agents: Object.fromEntries(Object.entries(r.agents).map(([id, a]) => [id, { samples: a.samples, arrival_t_s: a.arrival_t_s, final_mode: a.final_mode, final_speed_mm_s: a.final_speed_mm_s, entered_t_s: a.present_from_t_s ?? null }])),
});
const ind = (inp: Omit<SteerInput, 'policy' | 'params' | 'seed'>, p: SteerPolicyId, dt: number, spawn: boolean, seed = 1) => steer2D({ ...inp, policy: p, params: { ...params, decision_interval_s: dt }, seed, control: spawn ? { spawn: true } : undefined, decision_clock: 'individual' });
for (const p of DEC) for (const dt of [0.1, 0.05]) for (const spawn of [false, true]) {
  // T1/T3/T4/T5 (the grid check T2 is replaced by the own-instant check below)
  const ad: PhysicsTimeAdapter = { name: `individual ${p} dt ${dt}${spawn ? ' spawn' : ''}`, grid: null, decisionClasses: ['behavioural_response'], spawn, run: (inp) => fromSteer(ind(inp, p, dt, spawn)) };
  checkPhysicsTimeContract(ad, ok);
  for (const H of [0.5, 0.35]) {
    const inp = { ...contractInput(H), policy: p, params: { ...params, decision_interval_s: dt }, seed: 1, control: spawn ? { spawn: true } : undefined, decision_clock: 'individual' as DecisionClock };
    const r = steer2D(inp);
    ok(decisionTimeViolations(inp, r, 'individual').length === 0, `${ad.name} H ${H}: every decision at the agent's own start + k·dt (${decisionTimeViolations(inp, r, 'individual').slice(0, 2)})`);
  }
}
// lone agent: decisions exactly at s, s + dt, s + 2dt, ... (exact decimals) before H; none at H; nothing after H
{
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 200, y: 0 }], width_mm: 10, layer: 'G' }];
  const BODY = { length_mm: 2, width_mm: 1 }, ulp03 = 0.1 + 0.2;
  const lone = (st: number) => ({ lanes, obstacles: [], agents: [{ id: 'M', lane: 'L', s_mm: 10, u_mm: 0, dir: 1 as const, start_t_s: st, goal_s_mm: 190, free_speed_mm_s: 1, body: BODY }], horizon_s: 1 });
  for (const p of DEC) for (const dt of [0.1, 0.05]) for (const spawn of [false, true]) {
    const tag = `${p}${spawn ? '/spawn' : ''} dt ${dt}`;
    for (const st of [0, 0.25, 0.3, ulp03, 0.31, 0.35, 0.123, 0.95, 0.999]) {
      const r = ind(lone(st), p, dt, spawn), dec = r.events.filter((e) => e.class === 'behavioural_response');
      const own: number[] = []; for (let k = 0; exactSum([1, st], [k, dt]) < 1; k++) own.push(exactSum([1, st], [k, dt]));
      const nDec = Object.values(r.stats.decisions).reduce((x, y) => x + y, 0);
      ok(nDec === own.length && r.stats.decision_instants === own.length, `${tag}: start ${st}: ${own.length} own decisions (got ${nDec}, instants ${r.stats.decision_instants})`);
      ok(Object.is(dec[0].t_s, st) && Object.is(r.events.find((e) => e.kind === 'start')!.t_s, st), `${tag}: start ${st}: first decision at exactly ${st}`);
      ok(r.stats.timeline_instants === own.length + (st > 0 ? 1 : 0), `${tag}: start ${st}: the time line is t = 0 plus the own instants only (${r.stats.timeline_instants})`);
      ok(Math.abs(r.agents.M.samples.at(-1)![1] - (10 + (1 - st))) <= 1e-9 && r.agents.M.samples.every((x) => x[0] > st || x[4] === 10), `${tag}: start ${st}: no motion before the start; displacement v·(H − start)`);
    }
    // FINDING (kept, documented): a start one ulp after a grid instant is its own first instant; whether its later own
    // instants keep the phase depends on the resolution of the instant: 0.30000000000000004 + 0.1 is the decimal
    // 0.40000000000000004, whose nearest double IS 0.4 (merged with the 0.3-start's clock); + 0.05 gives 0.35000000000000003
    // (≠ 0.35, phase kept). A phase below the resolution of the instant cannot survive (rounded once, exact decimals).
    const rU = ind(lone(ulp03), p, dt, spawn), rO = ind(lone(0.3), p, dt, spawn);
    const uDec = rU.events.filter((e) => e.class === 'behavioural_response').map((e) => e.t_s), oDec = rO.events.filter((e) => e.class === 'behavioural_response').map((e) => e.t_s);
    const merged = exactSum([1, ulp03], [1, dt]) === exactSum([1, 0.3], [1, dt]);
    ok(Object.is(uDec[0], ulp03) && Object.is(oDec[0], 0.3) && merged === (dt === 0.1), `${tag}: one ulp after the grid: first instant ${ulp03}; second ${exactSum([1, ulp03], [1, dt])} ${merged ? 'merges with' : 'stays apart from'} 0.3 + dt`);
    const rH = ind(lone(1), p, dt, spawn), rA = ind(lone(1.05), p, dt, spawn);
    ok(rH.agents.M.final_mode === 'started_at_horizon' && Object.keys(rH.stats.decisions).length === 0 && rH.agents.M.final_speed_mm_s === 0, `${tag}: start at H: started_at_horizon, no decision`);
    ok(rA.events.length === 0 && rA.agents.M.final_mode === (spawn ? 'not_entered' : 'not_started'), `${tag}: start after H: nothing (${rA.agents.M.final_mode})`);
  }
}

// ---- 4. same-instant decisions and input order (individual clock)
{
  const BODY = { length_mm: 2, width_mm: 1 }, ulp03 = 0.1 + 0.2;
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 200, y: 0 }], width_mm: 10, layer: 'G' }, { id: 'R', centerline_mm: [{ x: 200, y: 0 }, { x: 0, y: 0 }], width_mm: 10, layer: 'G' }];
  const mk = (id: string, lane: string, s: number, start: number, u: number) => ({ id, lane, s_mm: s, u_mm: u, dir: 1 as const, start_t_s: start, goal_s_mm: lane === 'L' ? 60 : 199, free_speed_mm_s: 20, body: BODY });
  const tie = [mk('P', 'L', 10, 0.25, 0), mk('Q', 'L', 12.2, 0.25, 0.4), mk('S', 'L', 14.4, 0.25, -0.4), mk('T', 'R', 183, 0.3, 0), mk('U', 'L', 7.8, ulp03, 0)];
  const perms = [[0, 1, 2, 3, 4], [4, 3, 2, 1, 0], [2, 0, 4, 1, 3], [1, 4, 0, 3, 2], [3, 2, 1, 4, 0]];
  for (const p of DEC) for (const spawn of [false, true]) for (const dt of [0.1, 0.05]) {
    const run = (order: number[]) => ind({ lanes, obstacles: [], agents: order.map((i) => tie[i]), horizon_s: 1.5 }, p, dt, spawn, 3);
    const ref = JSON.stringify(run(perms[0]));
    for (const order of perms.slice(1)) ok(JSON.stringify(run(order)) === ref, `individual ${p}${spawn ? '/spawn' : ''} dt ${dt}: order-invariant (input order ${order.join('')})`);
    const r = JSON.parse(ref) as SteerResult, inp = { lanes, obstacles: [], agents: tie, horizon_s: 1.5, policy: p, params: { ...params, decision_interval_s: dt }, seed: 3, decision_clock: 'individual' as DecisionClock };
    ok(decisionTimeViolations(inp, r, 'individual').length === 0, `individual ${p}${spawn ? '/spawn' : ''} dt ${dt}: every decision at its own start + k·dt`);
  }
}

// ---- 5. physics invariants under the individual clock, dt 0.1 / 0.05. head-on-2, crossing-flank and stone: seeds 1-3,
// with the reversed/shuffled-order replays on seed 1. The heavy scenes corridor-8 and K3: seed 1 only, rerun replay
// only (input-order invariance is covered by section 4 and the small scenes) so the blocking suite stays inside the CI
// time limit. The full seeds-1-3 matrix with order replays for every scene, incl. the 100-agent crossing and K2, is
// regenerated by prototypes/local-steer/time-mode.ts (out/time-mode.json); the baseline's own invariants are in
// tests/wp4-local-steer.test.ts.
const kept: string[] = [];
for (const id of ['head-on-2', 'crossing-flank', 'corridor-8', 'stone', 'K3_inflow_exit']) for (const p of DEC) for (const dt of [0.1, 0.05]) for (const seed of id === 'K3_inflow_exit' || id === 'corridor-8' ? [1] : [1, 2, 3]) {
  const heavy = id === 'K3_inflow_exit' || id === 'corridor-8';
  const r = tmRow(id, p, seed, dt, 'individual', { perm: seed === 1 && !heavy }), tag = `${id}/${p} dt ${dt} seed ${seed} individual`;
  ok(r.verify.pair_penetrations === 0 && r.verify.static_penetrations === 0, `${tag}: 0 penetration (verifier)`);
  if (typeof r.judge !== 'string') ok(r.judge.max_penetration_mm <= 1e-9 && r.judge.out_of_walkable_agent_instants === 0 && r.judge.obstacle_violation_agent_instants === 0, `${tag}: judge 0`);
  ok(r.contact_check.violations === 0 && r.contact_check.outside_bracket === 0, `${tag}: contact_end inside the independent bracket`);
  ok(r.decision_time_violations === 0, `${tag}: decision times (${r.decision_time_examples})`);
  ok(r.replay.rerun_identical && r.replay.reversed_identical !== false && r.replay.shuffled_identical !== false, `${tag}: determinism and input-order invariance`);
  if (r.fallback_intervals || r.unresolved) kept.push(`${tag}: fallback ${r.fallback_intervals}, unresolved ${r.unresolved}`);
}

// ---- 6. KNOWN DEFECT KEPT: time slicing by foreign instants (pinned measurement)
{
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 300, y: 0 }], width_mm: 10, layer: 'G' }, { id: 'F', centerline_mm: [{ x: 0, y: 500 }, { x: 300, y: 500 }], width_mm: 10, layer: 'G' }];
  const B = { length_mm: 2.5, width_mm: 0.8 };
  const count = (clock: DecisionClock | undefined) => {
    let n = 0, d = 0, mx = 0;
    for (let i = 0; i < 40; i++) {
      const M = { id: 'M', lane: 'L', s_mm: 10, u_mm: 0, dir: 1 as const, start_t_s: Number(((i * 0.0137) % 1).toFixed(4)), goal_s_mm: 290, free_speed_mm_s: Number((3 + ((i * 0.731) % 9)).toFixed(3)), body: B };
      const base = { lanes, obstacles: [], horizon_s: 3, policy: 'N_no_yield' as const, params, seed: 1, ...(clock ? { decision_clock: clock } : {}) };
      const alone = steer2D({ ...base, agents: [M] });
      for (const fs of [0.013, 0.123456789, 1.77, 2.5432]) {
        const r = steer2D({ ...base, agents: [M, { ...M, id: 'Z', lane: 'F', start_t_s: fs, free_speed_mm_s: 9.1 }] });
        n++; if (JSON.stringify(r.agents.M) !== JSON.stringify(alone.agents.M)) { d++; mx = Math.max(mx, Math.abs(r.agents.M.samples.at(-1)![1] - alone.agents.M.samples.at(-1)![1])); }
      }
    }
    return { n, d, mx };
  };
  const c = count(undefined), iv = count('individual');
  ok(iv.d > 0 && iv.mx > 0 && iv.mx < 1e-12, `KNOWN DEFECT (individual clock): a far agent's own instants change M's coordinates in ${iv.d}/${iv.n} runs, max ${iv.mx} mm (< 1e-12 mm). Fix path: docs/wp4-individual-time.md §5`);
  ok(c.mx < 1e-12 && iv.d > c.d, `baseline (common grid) is affected by off-grid start instants only: ${c.d}/${c.n} runs, max ${c.mx} mm (pre-existing; not changed here)`);
  console.error(`time slicing: common ${c.d}/${c.n} (max ${c.mx} mm), individual ${iv.d}/${iv.n} (max ${iv.mx} mm)`);
}

// ---- 7. refusals
const inp0 = steerInput(scenarioById('head-on-2'), 'A_free_direction', { seed: 1 });
assert.throws(() => steer2D({ ...inp0, decision_clock: 'per_agent' as unknown as DecisionClock }), SteerRefused); checks++;
assert.throws(() => steer2D({ ...steerInput(scenarioById('head-on-2'), 'none', { seed: 1 }), decision_clock: 'individual' }), SteerRefused); checks++;

if (kept.length) console.error(`kept (reported, not contract failures): ${kept.join('; ')}`);
console.log(JSON.stringify({ wp4_individual_time: 'pass', checks }));
