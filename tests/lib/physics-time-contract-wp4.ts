/**
 * Solver-agnostic PHYSICS EVENT TIME-BOUNDARY CONTRACT checks (Owner, unified contract; docs/wp4-local-avoidance.md §2b 時間契約).
 *
 * The checks take a solver ADAPTER (run one input, return normalised events / agents), so the same contract is applied to
 * PH-3b (engine/physics/solver2d.ts, the reference) and to every WP4 local-steer policy (engine/physics/local-steer.ts).
 * NOTE: a parallel branch off main adds tests/lib/physics-time-contract.ts for PH-3b. This file is named -wp4 only to
 * avoid a merge conflict; both expose an adapter-based check and must be UNIFIED into one helper when both are merged.
 *
 * Contract (the clauses checked here):
 *  T1  scheduled inputs keep their exact time: an agent scheduled to start (or, with a spawn rule, to enter) at t starts at
 *      exactly t (bit-identical double), never at a nearby grid value (e.g. 0.3, not 3 × 0.1 = 0.30000000000000004), and
 *      does not move before t. Two schedules that differ by one ulp stay two distinct instants.
 *  T2  a decision grid (if the solver has one) is k × dt for integer k, evaluated as the correctly rounded value of the
 *      decimal product (k·p)/q with dt = p/q, never by accumulation or by the binary product k * dt. Every decision-type
 *      event lies on that grid or on an agent's own start / entry instant.
 *  T3  the horizon H is an instant: events at exactly H are processed (start, arrival on the goal, arrival reached exactly
 *      at H), but no positive duration remains: an agent starting at H records its start once and is NOT displaced.
 *      Nothing is recorded after H.
 *  T4  final_mode describes the state at H after the events at H. Cross-module definition: 'started_at_horizon' = the agent
 *      started exactly at H, is not on its goal, and has had zero elapsed time (final speed 0: no motion has happened).
 *      'moving' = it moved over a positive-length interval ending at H and its speed at H is > 0.
 *  T5  determinism (rerun identical) and order / permutation invariance (reversed and shuffled agent arrays identical).
 *
 * Known pending differences are declared by the adapter (`pending`) and PINNED: the check asserts the current (deviating)
 * value, so the test fails — and the pending entry must be removed — as soon as the solver is fixed.
 */
import type { Sample, Solver2DInput, SolverAgent } from '../../engine/physics/solver2d.ts';

export interface TCEvent { t_s: number; kind: string; agents: string[]; class: string }
export interface TCAgent { samples: Sample[]; arrival_t_s: number | null; final_mode: string; final_speed_mm_s: number; entered_t_s: number | null }
export interface TCRun { events: TCEvent[]; agents: Record<string, TCAgent> }
export interface PhysicsTimeAdapter {
  name: string;
  run(input: Solver2DInput): TCRun;
  /** the decision interval as an exact decimal fraction p/q (null = no decision grid) */
  grid: { p: number; q: number } | null;
  /** event classes that are taken at decision instants (checked against the grid) */
  decisionClasses: string[];
  /** true: an agent is absent until its scheduled start (spawn rule) */
  spawn: boolean;
  /** pinned known differences from the contract (each must flip when the solver is fixed) */
  pending?: { startedAtHorizon?: { final_mode: string; final_speed_mm_s: number } };
}
export interface TCSummary { adapter: string; checks: number; pending_pinned: string[] }

export const TC_BODY = { length_mm: 2.5, width_mm: 0.8 };
export const TC_SPEED = 10;
const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 300, y: 0 }], width_mm: 10, layer: 'G' }];
const ag = (id: string, s: number, start: number, goal: number): SolverAgent => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: TC_SPEED, body: TC_BODY });

/** grid instant k of dt = p/q: the correctly rounded quotient of two exact integers (independent of the solvers' code) */
export const gridAt = (k: number, g: { p: number; q: number }) => (k * g.p) / g.q;

/**
 * The shared world: one straight lane, agents 20 mm apart (never within sensing or contact range of each other).
 * [id, s, start, goal, expectation]
 */
export function contractCases(H: number) {
  return [
    ['S03', 10, 0.3, 40, 'start'],                 // scheduled 0.3 (= 3 × 0.1 on a 0.1 grid)
    ['S025', 30, 0.25, 60, 'start'],               // between grid instants of a 0.1 grid
    ['SULP', 50, 0.1 + 0.2, 80, 'start'],          // 0.30000000000000004: one ulp after S03, a distinct instant
    ['SX', 70, 0.3, 100, 'start'],                 // same instant as S03 (one batch)
    ['A04', 90, 0.3, 91, 'arrive'],                // starts 0.3, 1 mm to go → arrives 0.4
    ['G03', 110, 0.3, 110, 'arrive_at_start'],     // starts ON its goal at 0.3 → arrives at 0.3
    ['AH', 130, 0, 130 + TC_SPEED * H, 'arrive_at_h'],  // reaches its goal exactly at the horizon
    ['HZ', 170, H, 200, 'start_at_h'],             // starts exactly at H, not on its goal
    ['HG', 210, H, 210, 'arrive_at_start'],        // starts exactly at H on its goal → arrives at H once
    ['LATE', 250, H + 0.1, 270, 'late'],           // scheduled after the horizon
  ] as const;
}
export const contractInput = (H: number): Solver2DInput => ({ lanes, obstacles: [], agents: contractCases(H).map(([id, s, st, goal]) => ag(id, s, st, goal)), horizon_s: H });

const canon = (r: TCRun) => JSON.stringify({ events: r.events.map((e) => [e.t_s, e.kind, e.agents, e.class]), agents: Object.keys(r.agents).sort().map((k) => [k, r.agents[k]]) });

export function checkPhysicsTimeContract(ad: PhysicsTimeAdapter, ok: (c: unknown, why: string) => void): TCSummary {
  let checks = 0; const pinned: string[] = [];
  const chk = (c: unknown, why: string) => { ok(c, `[time contract/${ad.name}] ${why}`); checks++; };
  for (const H of [0.5, 0.35]) {
    const inp = contractInput(H), res = ad.run(inp);
    const startsOf = (id: string) => res.events.filter((e) => e.kind === 'start' && e.agents[0] === id);
    const arrivesOf = (id: string) => res.events.filter((e) => e.kind === 'arrive' && e.agents[0] === id);
    // T3: nothing after H
    chk(res.events.every((e) => e.t_s <= H), `H ${H}: no event after the horizon`);
    chk(Object.values(res.agents).every((a) => a.samples.every((s) => s[0] <= H)), `H ${H}: no record after the horizon`);
    for (const [id, s0, st, goal, kind] of contractCases(H)) {
      const a = res.agents[id], lbl = `H ${H} ${id} (start ${st})`;
      if (kind === 'late') {
        chk(startsOf(id).length === 0 && a.arrival_t_s === null && (ad.spawn ? a.entered_t_s === null : true), `${lbl}: scheduled after H → never started`);
        continue;
      }
      // T1: exact start (and entry) time, recorded once; no motion before it
      const se = startsOf(id);
      chk(se.length === 1 && Object.is(se[0].t_s, st), `${lbl}: start recorded once at exactly ${st} (got ${se.map((e) => e.t_s)})`);
      if (ad.spawn) chk(Object.is(a.entered_t_s, st) && a.samples.length > 0 && Object.is(a.samples[0][0], st), `${lbl}: entered at exactly ${st} (got ${a.entered_t_s}); first record at entry`);
      chk(a.samples.every((s) => s[0] > st || s[4] === s0), `${lbl}: not displaced at or before its start`);
      if (kind === 'start') {
        chk(a.arrival_t_s === null && a.final_mode === 'moving' && a.final_speed_mm_s === TC_SPEED, `${lbl}: moving at H (${a.final_mode})`);
        const last = a.samples.at(-1)!;
        chk(Object.is(last[0], H) && Math.abs(last[4] - (s0 + TC_SPEED * (H - st))) <= 1e-9, `${lbl}: displacement at H = v·(H − start) (${last[4] - s0})`);
      }
      if (kind === 'arrive') {
        const exp = st + (goal - s0) / TC_SPEED;
        if (exp <= H) chk(arrivesOf(id).length === 1 && Math.abs(a.arrival_t_s! - exp) <= 1e-12 && a.arrival_t_s! >= st, `${lbl}: arrives once at the analytic time ${exp} (${a.arrival_t_s})`);
        else chk(arrivesOf(id).length === 0 && a.final_mode === 'moving', `${lbl}: analytic arrival ${exp} > H → still moving at H (${a.final_mode})`);
      }
      if (kind === 'arrive_at_start') chk(arrivesOf(id).length === 1 && Object.is(a.arrival_t_s, st) && a.final_mode === 'arrived', `${lbl}: on its goal → arrives once at exactly its start ${st} (${a.arrival_t_s}, ${a.final_mode})`);
      if (kind === 'arrive_at_h') chk(arrivesOf(id).length === 1 && Object.is(a.arrival_t_s, H) && a.final_mode === 'arrived', `${lbl}: reaches its goal exactly at H → arrives once at H (${a.arrival_t_s})`);
      if (kind === 'start_at_h') {
        // T3 + T4: started at H, never displaced, final state 'started_at_horizon' with speed 0
        chk(arrivesOf(id).length === 0 && a.samples.every((s) => s[4] === s0), `${lbl}: started at H, no displacement, no arrival`);
        const pend = ad.pending?.startedAtHorizon;
        if (pend) {
          chk(a.final_mode === pend.final_mode && a.final_speed_mm_s === pend.final_speed_mm_s && pend.final_mode !== 'started_at_horizon', `${lbl}: KNOWN PENDING — final state is still '${pend.final_mode}' at ${pend.final_speed_mm_s} mm/s (contract: 'started_at_horizon', 0). Remove the pending entry when the solver is fixed (got '${a.final_mode}', ${a.final_speed_mm_s})`);
          if (!pinned.includes('started_at_horizon')) pinned.push('started_at_horizon');
        } else chk(a.final_mode === 'started_at_horizon' && a.final_speed_mm_s === 0, `${lbl}: final state 'started_at_horizon', speed 0 (got '${a.final_mode}', ${a.final_speed_mm_s})`);
      }
    }
    // T1: one-ulp-apart schedules stay distinct instants; equal schedules share one instant
    const t = (id: string) => startsOf(id)[0]?.t_s;
    chk(t('S03') !== t('SULP') && t('S03') === t('SX'), `H ${H}: 0.3 and 0.1 + 0.2 are distinct instants; equal schedules coincide`);
    // T2: decision-type events lie on the exact grid or on the agent's own start / entry instant
    if (ad.grid) {
      const g = ad.grid, starts = new Map(contractCases(H).map(([id, , st]) => [id as string, st as number]));
      const onGrid = (x: number) => { const k = Math.round((x * g.q) / g.p); return Object.is(gridAt(k, g), x); };
      const dec = res.events.filter((e) => ad.decisionClasses.includes(e.class));
      chk(dec.length > 0, `H ${H}: decision events exist`);
      for (const e of dec) chk(onGrid(e.t_s) || Object.is(e.t_s, starts.get(e.agents[0])), `H ${H}: decision ${e.kind}/${e.agents[0]} at ${e.t_s} is on the exact grid k·${g.p}/${g.q} or at its own start`);
    }
    // T5: determinism and permutation invariance
    const h = canon(res);
    chk(canon(ad.run(inp)) === h, `H ${H}: rerun identical`);
    chk(canon(ad.run({ ...inp, agents: [...inp.agents].reverse() })) === h, `H ${H}: reversed agent order identical`);
    const sh = [...inp.agents]; for (let i = sh.length - 1; i > 0; i--) { const j = (i * 7 + 3) % (i + 1); [sh[i], sh[j]] = [sh[j], sh[i]]; }
    chk(canon(ad.run({ ...inp, agents: sh })) === h, `H ${H}: shuffled agent order identical`);
  }
  return { adapter: ad.name, checks, pending_pinned: pinned };
}
