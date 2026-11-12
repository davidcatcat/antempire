/**
 * Solver-agnostic physics TIME-BOUNDARY contract (docs/physics-time-contract.md §2). Any motion solver (PH-3b now, WP4
 * local-steer later) adopts it by supplying an adapter that runs ONE agent alone on a straight lane and reports its start
 * events, arrival events, arrival time, final mode and displacement. Imports nothing from engine/ or from any solver.
 *
 * Contract:
 *  C1 the horizon H is an instant at which events are processed, with zero duration for motion;
 *  C2 an agent whose start time equals H gets exactly one start event at H; if it is already at its goal it arrives once
 *     at H (final_mode 'arrived'); otherwise its final_mode is 'started_at_horizon' and it has no displacement;
 *  C3 an agent whose start time is after H never starts ('not_started', no events, no displacement);
 *  C4 'moving' = started before H, not arrived, free to move at H; an arrival is recorded at most once;
 *  C5 event times are computed from the exact inputs in one expression: rounding (e.g. 0.1 + 0.2 > 0.3) may never push
 *     a scheduled event past the horizon or delay it; an event whose exact time is t* is recorded within
 *     TIME_TOL(H) = 8·ε·max(1, H) of t*, and an exact t* = H is processed AT the horizon.
 */

export const TIME_TOL = (H: number) => 8 * Number.EPSILON * Math.max(1, Math.abs(H));

export interface TimeCase {
  id: string; note: string;
  lane_len_mm: number; s0_mm: number; goal_mm: number; speed_mm_s: number; start_t_s: number; horizon_s: number;
  /** the exact (decimal) arrival time the inputs describe, or null when the agent never arrives within H */
  exact_arrival_s: number | null;
  /** expected final mode */
  final_mode: 'arrived' | 'started_at_horizon' | 'not_started' | 'moving';
}
export interface TimeOutcome { start_events: number[]; arrive_events: number[]; arrival_t_s: number | null; final_mode: string; displacement_mm: number }
export type TimeAdapter = (c: TimeCase) => TimeOutcome | 'refused';

/** the cases (values are synthetic test inputs, not model parameters) */
export const TIME_CASES: TimeCase[] = [
  { id: 'start-at-H-at-goal', note: 'C2: starts exactly at the horizon on its goal', lane_len_mm: 10, s0_mm: 4, goal_mm: 4, speed_mm_s: 17, start_t_s: 3, horizon_s: 3, exact_arrival_s: 3, final_mode: 'arrived' },
  { id: 'start-at-H-not-at-goal', note: 'C2: starts exactly at the horizon away from its goal', lane_len_mm: 10, s0_mm: 1, goal_mm: 8, speed_mm_s: 17, start_t_s: 3, horizon_s: 3, exact_arrival_s: null, final_mode: 'started_at_horizon' },
  { id: 'start-at-H-offgrid', note: 'C2 with a horizon that is not a binary fraction', lane_len_mm: 10, s0_mm: 1, goal_mm: 8, speed_mm_s: 17, start_t_s: 0.3, horizon_s: 0.3, exact_arrival_s: null, final_mode: 'started_at_horizon' },
  { id: 'start-after-H', note: 'C3', lane_len_mm: 10, s0_mm: 1, goal_mm: 8, speed_mm_s: 17, start_t_s: 3.000000001, horizon_s: 3, exact_arrival_s: null, final_mode: 'not_started' },
  { id: 'start-after-H-at-goal', note: 'C3 even on its goal', lane_len_mm: 10, s0_mm: 4, goal_mm: 4, speed_mm_s: 17, start_t_s: 3.5, horizon_s: 3, exact_arrival_s: null, final_mode: 'not_started' },
  { id: 'at-goal-before-H', note: 'C4: on its goal at a start before H arrives once at its start time', lane_len_mm: 10, s0_mm: 4, goal_mm: 4, speed_mm_s: 17, start_t_s: 1.25, horizon_s: 3, exact_arrival_s: 1.25, final_mode: 'arrived' },
  { id: 'drift-0.1+0.2', note: 'C5: start 0.1 s + 0.2 mm at 1 mm/s = 0.3 s = H exactly; in floating point 0.1 + 0.2 > 0.3', lane_len_mm: 10, s0_mm: 0, goal_mm: 0.2, speed_mm_s: 1, start_t_s: 0.1, horizon_s: 0.3, exact_arrival_s: 0.3, final_mode: 'arrived' },
  { id: 'drift-3x0.1', note: 'C5: 0.3 mm at 0.1 mm/s from t = 0 arrives at 3 s = H exactly', lane_len_mm: 10, s0_mm: 0, goal_mm: 0.3, speed_mm_s: 0.1, start_t_s: 0, horizon_s: 3, exact_arrival_s: 3, final_mode: 'arrived' },
  { id: 'drift-0.7', note: 'C5: start 0.4 s + 0.3 mm at 1 mm/s = 0.7 s = H', lane_len_mm: 10, s0_mm: 0, goal_mm: 0.3, speed_mm_s: 1, start_t_s: 0.4, horizon_s: 0.7, exact_arrival_s: 0.7, final_mode: 'arrived' },
  { id: 'arrive-exactly-H-binary', note: 'C5: exactly representable arrival at H', lane_len_mm: 10, s0_mm: 1, goal_mm: 7, speed_mm_s: 2, start_t_s: 0, horizon_s: 3, exact_arrival_s: 3, final_mode: 'arrived' },
  { id: 'arrive-just-after-H', note: 'C4: exact arrival 1e-9 s after H is not an arrival', lane_len_mm: 10, s0_mm: 1, goal_mm: 7.000000002, speed_mm_s: 2, start_t_s: 0, horizon_s: 3, exact_arrival_s: null, final_mode: 'moving' },
  { id: 'arrive-before-H', note: 'C4: plain arrival before H, once', lane_len_mm: 10, s0_mm: 1, goal_mm: 8, speed_mm_s: 17, start_t_s: 0.1, horizon_s: 3, exact_arrival_s: 0.1 + 7 / 17, final_mode: 'arrived' },
  { id: 'reverse-dir-drift', note: 'C5 travelling towards s = 0', lane_len_mm: 10, s0_mm: 0.3, goal_mm: 0.1, speed_mm_s: 1, start_t_s: 0.1, horizon_s: 0.3, exact_arrival_s: 0.3, final_mode: 'arrived' },
];

/** run every case through the adapter; returns the failures (empty = contract met) and the number of checks */
export function checkTimeContract(adapter: TimeAdapter, label: string): { checks: number; refused: string[]; failures: string[]; rows: { id: string; arrival_t_s: number | null; final_mode: string }[] } {
  const failures: string[] = [], refused: string[] = [], rows: { id: string; arrival_t_s: number | null; final_mode: string }[] = [];
  let checks = 0;
  const ok = (c: boolean, why: string) => { checks++; if (!c) failures.push(`${label} ${why}`); };
  for (const c of TIME_CASES) {
    const o = adapter(c);
    if (o === 'refused') { refused.push(c.id); continue; }
    rows.push({ id: c.id, arrival_t_s: o.arrival_t_s, final_mode: o.final_mode });
    const H = c.horizon_s, tol = TIME_TOL(H);
    ok(o.final_mode === c.final_mode, `${c.id}: final_mode ${o.final_mode}, expected ${c.final_mode}`);
    if (c.start_t_s > H) ok(o.start_events.length === 0, `${c.id}: no start event after the horizon (got ${o.start_events})`);
    else ok(o.start_events.length === 1 && o.start_events[0] === c.start_t_s, `${c.id}: exactly one start event at ${c.start_t_s} (got ${o.start_events})`);
    ok(o.arrive_events.length <= 1, `${c.id}: at most one arrival (got ${o.arrive_events.length})`);
    if (c.exact_arrival_s === null) ok(o.arrive_events.length === 0 && o.arrival_t_s === null, `${c.id}: no arrival (got ${o.arrival_t_s})`);
    else {
      ok(o.arrival_t_s !== null && Math.abs(o.arrival_t_s - c.exact_arrival_s) <= tol && o.arrival_t_s <= H, `${c.id}: arrival at ${c.exact_arrival_s} within ${tol} s and ≤ H (got ${o.arrival_t_s})`);
      ok(o.arrive_events.length === 1 && o.arrive_events[0] === o.arrival_t_s, `${c.id}: one arrive event at the arrival time (got ${o.arrive_events})`);
    }
    if (c.final_mode === 'started_at_horizon' || c.final_mode === 'not_started' || c.s0_mm === c.goal_mm) ok(o.displacement_mm === 0, `${c.id}: no displacement (got ${o.displacement_mm} mm)`);
    if (c.final_mode === 'moving') ok(o.displacement_mm > 0, `${c.id}: a moving agent has moved`);
  }
  return { checks, refused, failures, rows };
}
