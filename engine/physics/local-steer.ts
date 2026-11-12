/**
 * WP4 (docs/wp4-local-avoidance.md): ISOLATED candidate local-behaviour models (obstacle avoidance, waiting, backing off,
 * side-stepping) on top of the PH-3b body/contact physics. NOT used by simulate(), the daily loop, Day0, cli/ or web/
 * (tests/physics-isolation.test.ts, tests/wp4-local-steer.test.ts). Nothing here is a species rule: Pheidole has no
 * study of narrow-trail traffic, head-on encounters or lateral steering; every behavioural number is a candidate
 * (assumption: true, basis given by the caller's candidate file) and may be null — a policy that needs a null value is
 * refused, never defaulted.
 *
 * Policies (pluggable, chosen by id):
 *  - 'none'               the PH-3b solver itself (solve2D), returned unchanged: the baseline (u fixed, no decisions).
 *  - 'A_free_direction'   every decision instant: the most forward direction among the candidate probe directions that
 *                         is free within the sensing radius (ties between left and right by a named RNG draw); none free
 *                         → wait. Memoryless.
 *  - 'B_contact_decision' go forward; when a nestmate blocks the way within the sensing radius, draw one of
 *                         wait / back off / re-route (probabilities from the candidate file); a static obstacle → re-route.
 *                         Re-route is excluded when the local geometry is too narrow for two bodies (rule D).
 *  - 'C_sidestep'         go forward; when blocked and there is room, step aside on one side (chosen once per encounter
 *                         by a named RNG draw, switched only when that side closes) until the way ahead is free.
 *  - 'N_no_yield'         CONTROL, not a candidate behaviour: always straight ahead, never waits, yields, backs off or
 *                         steps aside (Pheidole has no yielding literature); a body ahead stops it inelastically
 *                         until the next decision instant (PH-3b stop-on-contact on the same decision grid as A–C, so
 *                         the control scenarios below apply to it as well). No random draws.
 *  Rule D (all of A–C and N): when an agent makes no forward progress for stall_window_s it REPORTS a blockage with a local
 *  diagnosis (static geometry closes every direction / passage too narrow for two bodies / blocked by nestmates / static
 *  piece ahead / way ahead free — the stall is the agent's own waiting or backing off); when the
 *  static geometry alone closes every direction it stops for good (geometry never changes).
 *
 * Perception (local only): an agent perceives the bodies (capsules and their body axis orientation, not their velocity,
 * goal or intention) and static pieces whose capsule gap to its own body is ≤ sensing_radius_mm, plus body contact.
 * A probe "direction d is free" = translating its own capsule by sensing_radius_mm along d, against the perceived bodies
 * held where they are and the perceived static pieces, hits nothing (exact continuous test, solver2d.pairFirstHit).
 * No global map, no other agent's intention, no colony quantity.
 *
 * Time contract (docs/wp4-local-avoidance.md §2b 時間契約): decision instants are the common grid g_k = k·decision_interval_s
 * evaluated EXACTLY on the decimal interval (exact-time.ts: g_3 = 0.3 for 0.1, never 3 * 0.1 = 0.30000000000000004), plus
 * each agent's exact start instant (under the spawn rule: its entry instant) — its first decision, with or without the
 * spawn rule (Owner decision 23); no other agent decides there; later decisions are on the common grid. Control-time
 * sums (exit dwell, B wait / re-route limits, stall window) are exact on the decimals too. Scheduled inputs are never
 * snapped to the grid. The horizon H is an instant with no positive duration left (see below).
 * final_mode = the state at H after the events at H: 'started_at_horizon' = started exactly at H, not on its goal, zero
 * elapsed time, no displacement (its reported speed is 0: no decision at H); 'moving' = started before H, not arrived, free to move at H.
 * (PH-3b on this branch still reports 'moving' for a start at H — fixed by PR #139 — pinned in tests/physics-time-contract-wp4.test.ts.)
 *
 * Motion and physics (between decision instants — the grid, entry instants, plus each agent's start time):
 *  - the body axis stays parallel to its lane in its travel direction (geometric convention: no body-rotation model);
 *    a chosen direction is a translation (forward, diagonal, sideways or backwards) at the agent's free speed;
 *  - straight lanes only (a bend is refused, as PH-3b refuses offset bodies at joints);
 *  - each agent's static set is its own lane's band INCLUDING the two end edges (walls) and the obstacles on its layer;
 *  - non-penetration is exact: within a decision interval every agent translates on [a_i, b_i]; b_i is lowered to the first
 *    time-of-impact with static geometry, its goal, or another body (piecewise exact continuous contact, pairFirstHit),
 *    for the agent(s) moving INTO the contact (normal test); iterated Jacobi-style over all candidate pairs until no stop
 *    time changes (order-independent). If that does not settle within a cap, nobody moves in that interval (safe,
 *    counted as `fallback_intervals`). Contacts are inelastic: a stopped agent waits for the next decision instant.
 *  - arrival (same horizon semantics as PH-3b, which processes every event with t <= horizon): an agent arrives at the
 *    first instant t <= horizon_s at which its forward coordinate reaches its goal — inside an interval, exactly at an
 *    interval end (including the horizon itself), or at its start time when it starts on its goal (zero remaining
 *    distance). Arrival is recorded exactly once; an arrived agent no longer moves or decides.
 *    The horizon itself is processed as a final zero-length instant (no decision, no motion): exit and entry rules, then an
 *    agent whose start time equals the horizon is started (as in PH-3b) and, if on its goal, arrives there once; one not
 *    on its goal ends as 'started_at_horizon'.
 *  - contact: a contact starts when an agent is stopped by a body (inelastic stop) and ends at the first instant the
 *    capsule gap exceeds CONTACT_TOL_MM (= PH-3b ACTIVE_TOL_MM), solved exactly on the piecewise-constant-velocity motion
 *    of both bodies within the interval (the gap is convex in time on each piece; bisection), never at a time before the
 *    motion that opens the gap. The event carries the final bisection bracket `bracket_s` [lo, hi] (gap ≤ tol at lo,
 *    > tol at hi; recorded time = hi). A contact that ends because a body LEAVES the road (control exit below) is not a
 *    physical separation: it is emitted as `contact_end_estimated` with usable_as_cause = false.
 *  - a stop computed against another body's planned path that turns out not to touch (that body stopped earlier) is a
 *    `conservative stop` (stats.stops_conservative), never a contact stop.
 * Control scenario boundaries (input.control, scenario rules, NOT ant behaviour; default off):
 *  - spawn: an agent is absent from the road until it enters at its entry pose (s_mm, u_mm) at EXACTLY its scheduled
 *    start_t_s if that pose is free then (gap > CONTACT_TOL_MM to every present body; ties by schedule, then id), else at
 *    the first later grid instant (or H) at which it is free; it makes its first decision at its entry instant (other
 *    agents keep their decisions until the next grid instant); absent agents are not perceived and are no obstacle.
 *  - exit: an arrived agent leaves the road (removed) at the first grid instant (or H) at which the exit of its goal end
 *    (lane, direction) holds fewer than `capacity` agents; each removed agent occupies the exit for `dwell_s`; until then
 *    it stays at its goal as an obstacle. Order: arrival time, then id.
 * Determinism: agents in id order; decisions read only the state at the decision instant and named RNG streams keyed by
 * (seed, stream, agent id, decision index) — independent of input order. Units: mm, s, mm/s.
 *
 * EXPERIMENTAL individual decision clock (input.decision_clock = 'individual'; Owner decision 40; docs/wp4-individual-time.md).
 * Opt-in, isolated, default off: without it the code path and the output are the common-grid baseline above, bit for bit.
 * With it every agent has its own clock: it decides ONLY at start_t_s + k·dt (k = 0, 1, …; exact on the decimals; with the
 * spawn rule a blocked entry is retried, and an arrived agent tries the exit, at these own instants too). The time line is
 * the union of all own instants plus H; between two of its instants every agent keeps the decision in effect (motion and
 * the exact contact physics are the same code as the baseline). RNG key of a decision: (seed, stream, agent id, own index
 * k), so an agent's draws do not depend on the other agents' clocks (when every agent starts at 0 the own index equals the
 * grid index: both clocks then give the same run, tested). Rule D's stall window counts the agent's own periods.
 * dt remains a model assumption (遊戲假設), not a measured decision interval of a real ant.
 */
import type { Vec2 } from './vec.ts';
import { segmentSegment2D } from './vec.ts';
import { type Capsule, capsuleGap, laneBoundary, OCC_TOL_MM } from './body2d.ts';
import { solve2D, pairFirstHit, Solver2DRefused, HIT_TOL_MM, ACTIVE_TOL_MM, type Solver2DInput, type Solver2DResult, type Sample } from './solver2d.ts';
import { type AABB, broadphasePairs } from './broadphase.ts';
import { hash32, rng } from '../rng.ts';
import { gridTime, addTime, exactSum, cmpExact } from './exact-time.ts';

/** RNG key of a decision: the grid index k, or `k|entry` for a first decision at an off-grid start / entry instant after grid instant k; individual clock: the agent's own instant index k */
type Epoch = number | string;

export const STEER_POLICIES = ['none', 'A_free_direction', 'B_contact_decision', 'C_sidestep', 'N_no_yield'] as const;
export type SteerPolicyId = (typeof STEER_POLICIES)[number];

/** behavioural candidate parameters; null = unknown (a policy that needs it is refused). Provenance lives with the caller. */
export interface SteerParams {
  sensing_radius_mm: number | null;
  decision_interval_s: number | null;
  /** probe directions, degrees off the travel direction (0 = straight; each > 0 is tried on both sides) */
  probe_angles_deg: number[] | null;
  /** a body ahead whose axis points within this angle of mine is a same-direction nestmate (B, C follow it) */
  same_heading_max_deg: number | null;
  stall_window_s: number | null;
  stall_progress_mm: number | null;
  /** B */
  p_wait: number | null; p_back: number | null; p_reroute: number | null;
  wait_s: number | null; back_distance_mm: number | null; reroute_max_s: number | null;
}
/** control-scenario boundary rules (scenario assumptions, not behaviour); omitted = off */
export interface SteerControl { spawn?: boolean; exit?: { capacity: number; dwell_s: number } | null }
/**
 * Decision clock (Owner decision 40; docs/wp4-individual-time.md). 'common_grid' (default, the baseline of PR #142): first
 * decision at the agent's own start, later decisions on the shared grid g_k = k·dt. 'individual' (ISOLATED EXPERIMENTAL
 * mode, opt-in, not integrated anywhere): every agent decides only at its own instants start_t_s + k·dt (k = 0, 1, …,
 * exact on the decimals), no shared grid. In both modes dt is a MODEL ASSUMPTION (a discretisation of a continuous
 * behaviour), not a measured decision interval of a real ant.
 */
export type DecisionClock = 'common_grid' | 'individual';
export const DECISION_CLOCKS: readonly DecisionClock[] = ['common_grid', 'individual'];
export interface SteerInput extends Solver2DInput { policy: SteerPolicyId; params: SteerParams; seed: number; control?: SteerControl; decision_clock?: DecisionClock }

export type SteerEventClass = 'physical_contact' | 'physical_constraint' | 'motion' | 'solver_status' | 'behavioural_response';
export interface SteerEvent {
  t_s: number; kind: string; agents: string[]; class: SteerEventClass; detail: string | null;
  /** contact_end: final bisection bracket [lo, hi] (gap ≤ CONTACT_TOL_MM at lo, > at hi; t_s = hi) */
  bracket_s?: [number, number];
  /** contact_end_estimated: false — the end is a boundary rule (a body left the road), not a physical separation.
   *  'none' baseline: the PH-3b event's own flag (true once the contact event is confirmed; docs/physics-time-contract.md) */
  usable_as_cause?: boolean;
  /** 'none' baseline only: the PH-3b contact event's own error bound / confirmation instant / exactness / contact kind, passed through unchanged */
  err_s?: number; err_clamped?: boolean; confirmed_t_s?: number; exact?: boolean; contact_kind?: string;
}
export interface SteerAgentOut {
  lane: string; layer: string; samples: Sample[]; arrival_t_s: number | null; final_mode: string; final_speed_mm_s: number;
  stop_cause: string | null; geometry_stop_s_mm: number | null; blocked_reports: number;
  /** control spawn: scheduled start and the instant it entered the road (null = never entered) */
  scheduled_start_t_s?: number; present_from_t_s?: number | null;
  /** control exit: the instant it left the road (null = still on the road at the horizon) */
  removed_t_s?: number | null;
}
export interface SteerResult {
  policy: SteerPolicyId; agents: Record<string, SteerAgentOut>; events: SteerEvent[];
  stats: {
    decision_instants: number; decisions: Record<string, number>; probes: number; pair_hit_evals: number; physics_rounds_max: number;
    fallback_intervals: number; stops_contact: number; stops_static: number; contacts: number; arrived: number; stalled: number;
    blocked_reports: Record<string, number>; geometry_halts: number; unresolved: number; t_end_s: number;
    /** stops against another body's planned path that did not touch; contact ends exact / estimated (body removed);
     *  control: agents entered / removed, decision instants an entry was blocked */
    stops_conservative: number; contact_ends_exact: number; contact_ends_estimated: number; entered: number; exited: number; entry_blocked_instants: number;
    /** individual decision clock only: instants of the time line before H (union of all own instants); absent otherwise */
    timeline_instants?: number;
  };
  /** 'none' only: the untouched PH-3b result */
  ph3b?: Solver2DResult;
  /** present only for the experimental individual decision clock (absent = the common-grid baseline, unchanged output) */
  decision_clock?: 'individual';
}

/** contact membership tolerance: a contact ends when the capsule gap first exceeds this (the PH-3b value) */
export const CONTACT_TOL_MM = ACTIVE_TOL_MM;

/** numerical tolerance (mm) for reaching the goal exactly at an interval end (floating-point rounding of the time grid) */
export const GOAL_TOL_MM = 1e-12;

export class SteerRefused extends Error { constructor(m: string) { super(`STEER_REFUSED: ${m}`); this.name = 'SteerRefused'; } }

// ---------------------------------------------------------------- helpers
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const rot = (v: Vec2, deg: number): Vec2 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const ZERO: Vec2 = { x: 0, y: 0 };
const sameVec = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
function closestPts(p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): [Vec2, Vec2] {
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y }, d2 = { x: q2.x - p2.x, y: q2.y - p2.y }, r = { x: p1.x - p2.x, y: p1.y - p2.y };
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a === 0 && e === 0) return [p1, p2];
  if (a === 0) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dot(d1, r);
    if (e === 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [{ x: p1.x + d1.x * s, y: p1.y + d1.y * s }, { x: p2.x + d2.x * t, y: p2.y + d2.y * t }];
}

/**
 * First time τ ∈ [0, T] at which two translating capsules touch on the way to a penetration deeper than HIT_TOL_MM
 * WITHIN [0, T]; null if none. pairFirstHit looks over an unbounded horizon, so for a pair already touching (gap ≈ 0)
 * that slides with a tiny relative velocity it reports τ = 0 for a penetration that would only happen long after T;
 * the gap is convex in τ, so its minimum over [τ, T] (ternary search) decides whether the touch leads to a penetration
 * inside this piece. Penetration is therefore never deeper than HIT_TOL_MM (< OCC_TOL_MM) at any instant.
 */
export function boundedHit(P: Capsule, vP: Vec2, Q: Capsule, vQ: Vec2, T: number): { tau: number; overlapping: boolean } | null {
  const h = pairFirstHit(P, vP, Q, vQ);
  if (!h) return null;
  if (h.overlapping) return h;
  if (h.tau > T) return null;
  const g = (t: number) => capsuleGap({ a: add(P.a, vP, t), b: add(P.b, vP, t), r: P.r }, { a: add(Q.a, vQ, t), b: add(Q.b, vQ, t), r: Q.r });
  if (g(T) < -HIT_TOL_MM) return h;
  let lo = h.tau, hi = T;
  for (let k = 0; k < 100 && hi - lo > 1e-15 * Math.max(1, hi); k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) <= g(m2)) hi = m2; else lo = m1; }
  return Math.min(g(T), g((lo + hi) / 2)) < -HIT_TOL_MM ? h : null;
}

interface Piece { c: Capsule; id: string }
type DecisionKind = 'go' | 'follow' | 'sidestep' | 'wait' | 'back_off' | 'reroute' | 'halt_geometry' | 'not_started';
interface Decision { kind: DecisionKind; w: Vec2; detail: string }
interface Ag {
  k: number; id: string; lane: string; layerName: string; layer: number;
  a0: Vec2; t: Vec2; n: Vec2; len: number; W: number;
  f: Vec2; left: Vec2; heading: number; dir: 1 | -1; v0: number; goal: number; start: number; hw: number; r: number; half: number;
  statics: Piece[];
  c: Vec2; started: boolean; arrived: number | null; eff: Vec2; lastKey: string;
  samples: Sample[]; stopCause: string | null; halted: boolean;
  // policy state
  mode: 'go' | 'wait' | 'back' | 'side'; until: number; backLeft: number; side: 1 | -1 | 0; sideSince: number;
  // rule D
  progress: number[]; stalledSince: number | null; reported: boolean; reports: number;
  // control boundaries: on the road now; scheduled start; entry and removal instants
  present: boolean; sched: number; entered: number | null; removed: number | null; entryBlocked: boolean;
  /** started exactly at the horizon (no decision, no motion by the horizon) */
  atHorizonStart: boolean;
  /** individual decision clock only: own instant index k, the next own instant sched + k·dt, the RNG key of this instant */
  dk: number; nextT: number; ep: Epoch;
  /** the decision in effect until the agent's next decision instant ('goal': it starts on its goal); held = stopped by a
   *  contact / static piece since that decision (inelastic: it waits for its next decision instant) */
  cur: Decision | 'goal' | null; held: boolean;
}

/** policy params the policy needs (null → refused) */
const NEEDS: Record<Exclude<SteerPolicyId, 'none'>, (keyof SteerParams)[]> = {
  A_free_direction: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'stall_window_s', 'stall_progress_mm'],
  B_contact_decision: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'same_heading_max_deg', 'stall_window_s', 'stall_progress_mm', 'p_wait', 'p_back', 'p_reroute', 'wait_s', 'back_distance_mm', 'reroute_max_s'],
  C_sidestep: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'same_heading_max_deg', 'stall_window_s', 'stall_progress_mm'],
  N_no_yield: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'stall_window_s', 'stall_progress_mm'],
};

export function steer2D(input: SteerInput): SteerResult {
  if (!(STEER_POLICIES as readonly string[]).includes(input.policy)) throw new SteerRefused(`unknown policy ${input.policy}`);
  if (input.policy === 'none') {
    if (input.decision_clock === 'individual') throw new SteerRefused("'none' is the PH-3b solver itself: it takes no decisions, so it has no decision clock");
    if (input.control && (input.control.spawn || input.control.exit)) throw new SteerRefused("'none' is the PH-3b solver itself: it has no spawn / exit control rules (use N_no_yield as the no-yield control)");
    // the baseline IS PH-3b: no decision layer, nothing re-implemented
    // stats.contacts = contact EPISODES (PH-3b stats.contact_episodes), as for A/B/C (one count per contact_start).
    // PH-3b's own stats.contacts counts velocity-constraint switch-ons (solver state: 1,567 for one sliding contact in
    // crossing-flank), which is not comparable with the candidates' column (docs/wp4-local-avoidance.md §4.2).
    const res = solve2D(input);
    const agents: Record<string, SteerAgentOut> = {};
    for (const id of Object.keys(res.agents).sort()) { const a = res.agents[id]; agents[id] = { ...a, blocked_reports: 0 }; }
    const stalled = res.stats.stalled;
    return { policy: 'none', agents, events: res.events.map((e) => ({ ...e })), ph3b: res, stats: { decision_instants: 0, decisions: {}, probes: 0, pair_hit_evals: res.stats.pair_hit_evals, physics_rounds_max: 0, fallback_intervals: 0, stops_contact: res.events.filter((e) => e.kind === 'stop' && /^contact/.test(e.detail ?? '')).length, stops_static: res.events.filter((e) => e.kind === 'stop' && /static geometry/.test(e.detail ?? '')).length, contacts: res.stats.contact_episodes, arrived: res.stats.arrived, stalled, blocked_reports: {}, geometry_halts: 0, unresolved: res.stats.unresolved, t_end_s: res.stats.t_end_s, stops_conservative: 0, contact_ends_exact: res.events.filter((e) => e.kind === 'contact_end').length, contact_ends_estimated: 0, entered: 0, exited: 0, entry_blocked_instants: 0 } };
  }
  return runPolicy(input);
}

function runPolicy(input: SteerInput): SteerResult {
  const P = input.params, policy = input.policy as Exclude<SteerPolicyId, 'none'>;
  for (const k of NEEDS[policy]) { const v = P[k]; if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new SteerRefused(`${policy} needs ${k}, which is null (unknown; never defaulted)`); }
  const H = input.horizon_s;
  if (!(H > 0) || !Number.isFinite(H)) throw new SteerRefused('horizon must be a positive finite number');
  const RHO = P.sensing_radius_mm!, DT = P.decision_interval_s!, ANG = [...new Set(P.probe_angles_deg!.map(Math.abs))].sort((x, y) => x - y);
  if (!(RHO > 0) || !(DT > 0)) throw new SteerRefused('sensing radius and decision interval must be positive');
  if (ANG.some((x) => !(x >= 0 && x <= 180))) throw new SteerRefused('probe angles must lie in [0, 180] degrees');
  const SAME = P.same_heading_max_deg === null ? null : Math.cos((P.same_heading_max_deg * Math.PI) / 180);
  if (policy === 'B_contact_decision') {
    const s = P.p_wait! + P.p_back! + P.p_reroute!;
    if (![P.p_wait!, P.p_back!, P.p_reroute!].every((p) => p >= 0) || Math.abs(s - 1) > 1e-12) throw new SteerRefused('B: p_wait + p_back + p_reroute must be probabilities summing to 1');
  }
  const STALL_K = Math.max(1, Math.round(P.stall_window_s! / DT)), STALL_MM = P.stall_progress_mm!;
  const CTL = input.control ?? {}, SPAWN = CTL.spawn === true, EXIT = CTL.exit ?? null;
  if (input.decision_clock !== undefined && !DECISION_CLOCKS.includes(input.decision_clock)) throw new SteerRefused(`unknown decision clock ${String(input.decision_clock)}`);
  const IND = input.decision_clock === 'individual';
  if (EXIT && (!Number.isInteger(EXIT.capacity) || EXIT.capacity < 1 || !(EXIT.dwell_s > 0) || !Number.isFinite(EXIT.dwell_s))) throw new SteerRefused('exit control: capacity must be an integer >= 1 and dwell_s a positive finite number');
  const draw = (stream: string, id: string, epoch: Epoch, extra = '') => rng(hash32(`${input.seed}|steer.${policy}.${stream}|${id}|${epoch}|${extra}`))();

  // ---- lanes (straight only) and layers
  const layerIds = new Map<string, number>(), laneMap = new Map<string, { a0: Vec2; t: Vec2; n: Vec2; len: number; W: number; layer: number; layerName: string; bnd: Piece[] }>();
  for (const l of input.lanes) {
    if (laneMap.has(l.id)) throw new SteerRefused(`duplicate lane ${l.id}`);
    if (typeof l.width_mm !== 'number' || !(l.width_mm > 0)) throw new SteerRefused(`lane ${l.id} width unknown (never defaulted)`);
    if (!layerIds.has(l.layer)) layerIds.set(l.layer, layerIds.size);
    const pts = l.centerline_mm;
    const a0 = pts[0], b0 = pts[pts.length - 1], len = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    const t = { x: (b0.x - a0.x) / len, y: (b0.y - a0.y) / len }, straight = len > 0 && pts.every((p) => Math.abs((p.x - a0.x) * t.y - (p.y - a0.y) * t.x) <= 1e-9);
    const bnd: Piece[] = straight ? laneBoundary({ id: l.id, centerline_mm: pts.map((p) => ({ x: p.x, y: p.y })), width_mm: l.width_mm }).filter((b): b is Extract<typeof b, { kind: 'seg' }> => b.kind === 'seg').map((b) => ({ c: { a: b.p, b: b.q, r: 0 }, id: `${b.end ? 'lane-end' : 'lane-edge'}:${l.id}` })) : [];
    laneMap.set(l.id, { a0, t, n: { x: -t.y, y: t.x }, len: straight ? len : NaN, W: l.width_mm, layer: layerIds.get(l.layer)!, layerName: l.layer, bnd });
  }
  const obsByLayer = new Map<number, Piece[]>();
  const polys: { id: string; layer: number; pts: Vec2[] }[] = [];
  for (const o of input.obstacles) {
    const L = layerIds.get(o.layer); if (L === undefined) continue;
    const S = obsByLayer.get(L) ?? []; obsByLayer.set(L, S);
    if (o.kind === 'circle') { if (!(o.radius_mm > 0)) throw new SteerRefused(`obstacle ${o.id} radius`); S.push({ c: { a: o.center_mm, b: o.center_mm, r: o.radius_mm }, id: o.id }); }
    else { const p = o.points_mm; if (p.length < 3) throw new SteerRefused(`obstacle ${o.id} polygon`); for (let i = 0; i < p.length; i++) S.push({ c: { a: p[i], b: p[(i + 1) % p.length], r: 0 }, id: o.id }); polys.push({ id: o.id, layer: L, pts: p }); }
  }
  const insidePoly = (p: Vec2, Q: Vec2[]) => { let ins = false; for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) { const a = Q[i], b = Q[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };

  // ---- agents, canonical id order
  const specs = [...input.agents].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (let i = 1; i < specs.length; i++) if (specs[i].id === specs[i - 1].id) throw new SteerRefused(`duplicate agent id ${specs[i].id}`);
  const N = specs.length;
  const A: Ag[] = specs.map((sp, k) => {
    const ln = laneMap.get(sp.lane); if (!ln) throw new SteerRefused(`${sp.id}: lane ${sp.lane} unknown`);
    if (!Number.isFinite(ln.len)) throw new SteerRefused(`${sp.id}: lane ${sp.lane} has a bend; the steering candidates handle straight lanes only (body rotation at a bend is not modelled)`);
    const L = sp.body.length_mm, w = sp.body.width_mm;
    if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0) || !(w > 0)) throw new SteerRefused(`${sp.id}: body size unknown (never invented)`);
    if (!(sp.free_speed_mm_s > 0) || !Number.isFinite(sp.free_speed_mm_s)) throw new SteerRefused(`${sp.id}: free speed must be positive`);
    if (!(sp.s_mm >= 0 && sp.s_mm <= ln.len && sp.goal_s_mm >= 0 && sp.goal_s_mm <= ln.len) || (sp.goal_s_mm - sp.s_mm) * sp.dir < 0) throw new SteerRefused(`${sp.id}: start/goal inconsistent with lane ${sp.lane}`);
    if (!(sp.start_t_s >= 0) || !Number.isFinite(sp.start_t_s)) throw new SteerRefused(`${sp.id}: start time`);
    const f = { x: ln.t.x * sp.dir, y: ln.t.y * sp.dir }, c = add(add(ln.a0, ln.t, sp.s_mm), ln.n, sp.u_mm);
    return {
      k, id: sp.id, lane: sp.lane, layerName: ln.layerName, layer: ln.layer, a0: ln.a0, t: ln.t, n: ln.n, len: ln.len, W: ln.W,
      f, left: { x: -f.y, y: f.x }, heading: Math.atan2(f.y, f.x), dir: sp.dir, v0: sp.free_speed_mm_s, goal: sp.goal_s_mm, start: sp.start_t_s,
      hw: Math.max(0, L - w) / 2, r: w / 2, half: L / 2, statics: [...ln.bnd, ...(obsByLayer.get(ln.layer) ?? [])],
      c, started: false, arrived: null, eff: ZERO, lastKey: '', samples: [], stopCause: null, halted: false,
      mode: 'go', until: 0, backLeft: 0, side: 0, sideSince: 0, progress: [], stalledSince: null, reported: false, reports: 0,
      present: !SPAWN, sched: sp.start_t_s, entered: SPAWN ? null : 0, removed: null, entryBlocked: false, atHorizonStart: false, cur: null, held: false,
      dk: 0, nextT: sp.start_t_s, ep: 0,
    };
  });
  const capOf = (a: Ag, c = a.c): Capsule => ({ a: add(c, a.f, -a.hw), b: add(c, a.f, a.hw), r: a.r });
  const sOf = (a: Ag, c = a.c) => dot({ x: c.x - a.a0.x, y: c.y - a.a0.y }, a.t);
  const uOf = (a: Ag, c = a.c) => dot({ x: c.x - a.a0.x, y: c.y - a.a0.y }, a.n);
  const fwdOf = (a: Ag, c = a.c) => sOf(a, c) * a.dir;
  const sample = (a: Ag, t: number) => {
    const last = a.samples[a.samples.length - 1];
    if (last && last[0] === t && last[1] === a.c.x && last[2] === a.c.y) return;
    a.samples.push([t, a.c.x, a.c.y, a.heading, sOf(a), uOf(a)]);
  };
  for (const a of A) {
    const c0 = capOf(a);
    for (const p of a.statics) { const g = capsuleGap(c0, p.c); if (g < -OCC_TOL_MM) throw new SteerRefused(`${a.id}: start pose penetrates ${p.id} by ${-g} mm`); }
    for (const q of polys) if (q.layer === a.layer && insidePoly(a.c, q.pts)) throw new SteerRefused(`${a.id}: starts inside obstacle ${q.id}`);
    if (a.present) sample(a, 0);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (A[i].present && A[j].present && A[i].layer === A[j].layer && Math.abs(A[i].c.x - A[j].c.x) <= A[i].half + A[j].half && Math.abs(A[i].c.y - A[j].c.y) <= A[i].half + A[j].half) {
    const g = capsuleGap(capOf(A[i]), capOf(A[j])); if (g < -OCC_TOL_MM) throw new SteerRefused(`${A[i].id} and ${A[j].id} overlap at t = 0 by ${-g} mm`);
  }

  const events: SteerEvent[] = [];
  const stats: SteerResult['stats'] = { decision_instants: 0, decisions: {}, probes: 0, pair_hit_evals: 0, physics_rounds_max: 0, fallback_intervals: 0, stops_contact: 0, stops_static: 0, contacts: 0, arrived: 0, stalled: 0, blocked_reports: {}, geometry_halts: 0, unresolved: 0, t_end_s: H, stops_conservative: 0, contact_ends_exact: 0, contact_ends_estimated: 0, entered: 0, exited: 0, entry_blocked_instants: 0 };
  const exitLog = new Map<string, number[]>();   // exit (lane|dir) → removal instants
  const ev = (t: number, kind: string, ids: number[], cls: SteerEventClass, detail: string | null = null) => events.push({ t_s: t, kind, agents: ids.map((i) => A[i].id), class: cls, detail });
  const activeContacts = new Map<number, number>();   // pair key → contact start time
  const pkey = (i: number, j: number) => (i < j ? i * N + j : j * N + i);

  // ---- perception (local)
  interface Percept { bodies: { j: number; cap: Capsule; e: Vec2 }[]; statics: Piece[]; contact: boolean }
  const perceive = (a: Ag, nbr: number[]): Percept => {
    const me = capOf(a), out: Percept = { bodies: [], statics: [], contact: false };
    for (const j of nbr) { const b = A[j], cb = capOf(b), g = capsuleGap(me, cb); if (g <= RHO) { out.bodies.push({ j, cap: cb, e: b.f }); if (g <= CONTACT_TOL_MM) out.contact = true; } }
    for (const p of a.statics) if (capsuleGap(me, p.c) <= RHO) out.statics.push(p);
    return out;
  };
  /** first hit along unit direction d within dist against the percept (bodies held still); null = free */
  const probe = (a: Ag, pc: Percept, d: Vec2, dist: number, bodies = true): { at: number; what: 'body' | 'static'; j: number; id: string } | null => {
    stats.probes++;
    const me = capOf(a);
    let best: { at: number; what: 'body' | 'static'; j: number; id: string } | null = null;
    if (bodies) for (const b of pc.bodies) { const h = boundedHit(me, d, b.cap, ZERO, dist); if (h && h.tau < dist && (!best || h.tau < best.at)) best = { at: h.tau, what: 'body', j: b.j, id: A[b.j].id }; }
    for (const p of pc.statics) { const h = boundedHit(me, d, p.c, ZERO, dist); if (h && h.tau < dist && (!best || h.tau < best.at)) best = { at: h.tau, what: 'static', j: -1, id: p.id }; }
    return best;
  };
  /** the most forward free direction: candidates by increasing |angle|; both sides of an angle free → named RNG draw (or a preferred side) */
  const freeDir = (a: Ag, pc: Percept, epoch: Epoch, minAng: number, pref: 1 | -1 | 0, stream: string): { ang: number; d: Vec2 } | null => {
    for (const g of ANG) {
      if (g < minAng) continue;
      if (g === 0) { if (!probe(a, pc, a.f, RHO)) return { ang: 0, d: a.f }; continue; }
      const L = rot(a.f, g), R = rot(a.f, -g), lf = !probe(a, pc, L, RHO), rf = !probe(a, pc, R, RHO);
      if (lf && rf) { const side = pref !== 0 ? pref : draw(stream, a.id, epoch, String(g)) < 0.5 ? 1 : -1; return side > 0 ? { ang: g, d: L } : { ang: -g, d: R }; }
      if (pref !== 0 && ((pref > 0 && !lf) || (pref < 0 && !rf))) continue;          // committed side closed at this angle: try wider
      if (lf) return { ang: g, d: L };
      if (rf) return { ang: -g, d: R };
    }
    return null;
  };
  /** rule D: local diagnosis of a blockage (geometry within the sensing radius only) */
  type Diagnosis = 'static_closed' | 'too_narrow_for_two' | 'blocked_by_nestmates' | 'static_ahead' | 'way_ahead_free';
  const diagnose = (a: Ag, pc: Percept, ahead: { what: 'body' | 'static'; j: number } | null): Diagnosis => {
    const blockerJ = ahead && ahead.what === 'body' ? ahead.j : -1;
    const statOnly: Percept = { bodies: [], statics: pc.statics, contact: false };
    let anyFree = !probe(a, statOnly, a.f, RHO, false);
    for (const g of ANG) if (!anyFree && g > 0 && g <= 90) anyFree = !probe(a, statOnly, rot(a.f, g), RHO, false) || !probe(a, statOnly, rot(a.f, -g), RHO, false);
    if (!anyFree) return 'static_closed';
    if (blockerJ >= 0) {
      const room = (s: 1 | -1) => { const h = probe(a, statOnly, s > 0 ? a.left : { x: -a.left.x, y: -a.left.y }, RHO, false); return h ? h.at : Infinity; };
      const wl = room(1) + room(-1) + 2 * a.r;                  // local free width (both walls sensed) or ∞
      return wl < 2 * a.r + 2 * A[blockerJ].r ? 'too_narrow_for_two' : 'blocked_by_nestmates';
    }
    return ahead ? 'static_ahead' : 'way_ahead_free';
  };

  // ---- decisions
  const decide = (a: Ag, pc: Percept, t0: number, epoch: Epoch): Decision => {
    const v = a.v0, wv = (d: Vec2) => ({ x: d.x * v, y: d.y * v });
    if (a.halted) return { kind: 'halt_geometry', w: ZERO, detail: 'static geometry closes every direction within the sensing radius (rule D)' };
    const ahead = probe(a, pc, a.f, RHO);
    const sameHeading = (j: number) => SAME !== null && dot(A[j].f, a.f) >= SAME;
    if (policy === 'N_no_yield') return { kind: 'go', w: wv(a.f), detail: 'no-yield control: straight ahead, never yields or steps aside' };
    if (policy === 'A_free_direction') {
      const fd = freeDir(a, pc, epoch, 0, 0, 'tie');
      if (!fd) return { kind: 'wait', w: ZERO, detail: `no free direction within ${RHO} mm (${ahead ? `${ahead.what} ${ahead.id} ahead` : 'sides closed'})` };
      return fd.ang === 0 ? { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' } : { kind: 'sidestep', w: wv(fd.d), detail: `most forward free direction ${fd.ang}°` };
    }
    if (policy === 'C_sidestep') {
      if (!ahead) { a.side = 0; return { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' }; }
      if (ahead.what === 'body' && sameHeading(ahead.j)) { a.side = 0; return { kind: 'follow', w: wv(a.f), detail: `same-direction nestmate ${ahead.id} ahead: follow` }; }
      let fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side, 'side');
      if (!fd && a.side !== 0) fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side > 0 ? -1 : 1, 'side');
      if (!fd) return { kind: 'wait', w: ZERO, detail: `${ahead.what} ${ahead.id} ahead, no room to step aside within ${RHO} mm` };
      a.side = fd.ang > 0 ? 1 : -1;
      return { kind: 'sidestep', w: wv(fd.d), detail: `${ahead.what} ${ahead.id} ahead: step aside ${fd.ang}°` };
    }
    // ---- B: wait / back off / re-route, chosen on contact
    if (a.mode === 'wait') { if (t0 < a.until) return { kind: 'wait', w: ZERO, detail: `waiting until ${a.until} s` }; a.mode = 'go'; }
    if (a.mode === 'back') {
      if (a.backLeft > 1e-9) { const rear = { x: -a.f.x, y: -a.f.y }, h = probe(a, pc, rear, Math.min(RHO, a.backLeft)); if (!h) return { kind: 'back_off', w: wv(rear), detail: `backing off, ${a.backLeft.toFixed(3)} mm left` }; }
      a.mode = 'go';
    }
    if (a.mode === 'side') {
      if (!ahead || cmpExact([[1, t0]], [[1, a.sideSince], [1, P.reroute_max_s!]]) >= 0) { a.mode = 'go'; a.side = 0; }
      else { const fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side, 'side'); if (fd) return { kind: 'reroute', w: wv(fd.d), detail: `re-routing ${fd.ang}° around ${ahead.what} ${ahead.id}` }; a.mode = 'go'; a.side = 0; }
    }
    if (!ahead) return { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' };
    if (ahead.what === 'body' && sameHeading(ahead.j)) return { kind: 'follow', w: wv(a.f), detail: `same-direction nestmate ${ahead.id} ahead: follow` };
    const startSide = () => { const fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, 0, 'side'); if (!fd) return null; a.mode = 'side'; a.side = fd.ang > 0 ? 1 : -1; a.sideSince = t0; return { kind: 'reroute' as const, w: wv(fd.d), detail: `re-route ${fd.ang}° around ${ahead.what} ${ahead.id}` }; };
    if (ahead.what === 'static') return startSide() ?? { kind: 'wait', w: ZERO, detail: `static ${ahead.id} ahead, no free direction` };
    const narrow = diagnose(a, pc, ahead) !== 'blocked_by_nestmates';
    const pw = P.p_wait!, pb = P.p_back!, pr = narrow ? 0 : P.p_reroute!, x = draw('action', a.id, epoch) * (pw + pb + pr);
    if (pw + pb + pr > 0 && x >= pw + pb) { const s = startSide(); if (s) return s; }
    if (pw + pb + pr > 0 && x >= pw && x < pw + pb) { a.mode = 'back'; a.backLeft = P.back_distance_mm!; const rear = { x: -a.f.x, y: -a.f.y }; if (!probe(a, pc, rear, Math.min(RHO, a.backLeft))) return { kind: 'back_off', w: wv(rear), detail: `contact with ${ahead.id}: back off ${P.back_distance_mm} mm${narrow ? ' (too narrow to pass)' : ''}` }; a.mode = 'go'; }
    a.mode = 'wait'; a.until = addTime(t0, P.wait_s!);
    return { kind: 'wait', w: ZERO, detail: `contact with ${ahead.id}: wait ${P.wait_s} s${narrow ? ' (too narrow to pass)' : ''}` };
  };

  // ---- physics of one decision interval: exact non-penetration with inelastic stops
  const hitPair = (i: number, j: number, aT: number[], bT: number[], w: Vec2[], c0: Vec2[]): number | null => {
    const P1 = A[i], P2 = A[j], pts = [...new Set([0, aT[i], bT[i], aT[j], bT[j]])].sort((x, y) => x - y);
    const posAt = (x: number, tau: number) => add(c0[x], w[x], Math.min(Math.max(tau, aT[x]), bT[x]) - aT[x]);
    const velIn = (x: number, p: number) => (p >= aT[x] && p < bT[x] ? w[x] : ZERO);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1], vi = velIn(i, p), vj = velIn(j, p);
      if (sameVec(vi, ZERO) && sameVec(vj, ZERO)) continue;
      stats.pair_hit_evals++;
      const h = boundedHit(capOf(P1, posAt(i, p)), vi, capOf(P2, posAt(j, p)), vj, q - p);
      if (!h) continue;
      if (h.overlapping) { stats.unresolved++; return p; }
      return p + h.tau;
    }
    return null;
  };

  // ---- the time line (docs/wp4-local-avoidance.md §2b 時間契約): the decision grid g_k = k · decision_interval_s, evaluated
  // exactly on the decimal interval (exact-time.ts: 3 × 0.1 = 0.3, never 0.30000000000000004), plus — with the spawn rule —
  // every scheduled entry instant at its exact value, plus the horizon H as a final zero-length instant (PH-3b processes
  // every event with t <= H): at H the boundary rules, starts and zero-distance arrivals are applied; no decision, no motion.
  const grid = (k: number) => gridTime(k, DT);
  // Owner decision 23: every agent's FIRST decision is at its actual start instant (with the spawn rule: its scheduled
  // entry instant; without it: its start_t_s), never at an earlier grid instant (which would be before it exists on its
  // path) nor a later one. Off-grid start / entry instants are therefore instants of the time line; only the agents that
  // start there decide there. After that first decision every agent decides on the common grid g_k (the next one after
  // its start) — 遊戲假設: one shared grid for all agents, no per-agent phase.
  const schedTimes = [...new Set(A.map((a) => (SPAWN ? a.sched : a.start)).filter((t) => t < H))].sort((x, y) => x - y);
  let kNext = 0, si = 0;   // next grid index to process; next entry instant
  for (let t0 = 0; ;) {
    const final = t0 >= H, isGrid = !IND && !final && t0 === grid(kNext);
    // individual decision clock: the agents whose own instant sched + k·dt is t0 act now (decide / enter / try the exit);
    // their clock advances to k + 1. Only agents that still need instants count (not removed; not arrived unless an exit
    // rule may remove them).
    const needs = (a: Ag) => a.removed === null && (a.arrived === null || (EXIT !== null && a.present));
    const mine: boolean[] = IND ? A.map((a) => !final && needs(a) && a.nextT === t0) : [];
    if (IND) for (const a of A) if (mine[a.k]) { a.ep = a.dk; a.dk++; a.nextT = exactSum([1, a.sched], [a.dk, DT]); }
    // RNG key of decisions at this instant: the grid index, or (first decision at an entry instant) the preceding one + 'entry'
    const epoch: Epoch = isGrid ? kNext : `${kNext - 1}|entry`;
    if (isGrid) { kNext++; stats.decision_instants++; }
    while (si < schedTimes.length && schedTimes[si] <= t0) si++;
    const gEnd = IND ? NaN : Math.min(H, grid(kNext));   // end of the current decision period (common grid)
    const t1 = final ? H : IND ? A.reduce((m, a) => (needs(a) && a.nextT < m ? a.nextT : m), H) : Math.min(gEnd, si < schedTimes.length ? schedTimes[si] : Infinity), span = t1 - t0;
    if (!final && !(t1 > t0)) throw new SteerRefused(`decision interval ${DT} s is below the time resolution at t = ${t0} s`);
    // control boundaries: exits at decision-grid instants and at H (they free road space), then entries — each agent tries
    // at its own exact scheduled instant; one whose entry pose is occupied retries at the following grid instants and at H
    if (EXIT && (IND || isGrid || final)) {
      const out = A.filter((a) => a.present && a.arrived !== null && (!IND || final || mine[a.k])).sort((p, q) => p.arrived! - q.arrived! || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
      for (const a of out) {
        const xk = `${a.lane}|${a.dir}`, held = exitLog.get(xk) ?? []; exitLog.set(xk, held);
        // a slot taken at t is occupied while t + dwell_s > t0 (exact on the decimals: 0.1 + 0.2 frees the slot at 0.3)
        const occ = held.filter((t) => cmpExact([[1, t], [1, EXIT.dwell_s]], [[1, t0]]) > 0).length;
        if (occ >= EXIT.capacity) continue;
        held.push(t0); a.present = false; a.removed = t0; stats.exited++;
        ev(t0, 'exit', [a.k], 'motion', `left the road into the exit ${xk} (occupancy ${occ + 1}/${EXIT.capacity}, dwell ${EXIT.dwell_s} s; control scenario boundary, assumption)`);
        for (const [ck] of [...activeContacts].sort((p, q) => p[0] - q[0])) {
          const i = Math.floor(ck / N), j = ck % N; if (i !== a.k && j !== a.k) continue;
          activeContacts.delete(ck); stats.contact_ends_estimated++;
          events.push({ t_s: t0, kind: 'contact_end_estimated', agents: [A[i].id, A[j].id], class: 'physical_contact', detail: `${a.id} left the road by the exit rule at this instant: not a physical separation (control boundary; not usable as a biological cause)`, usable_as_cause: false });
        }
      }
    }
    if (SPAWN) {
      const due = A.filter((a) => !a.present && a.entered === null && (IND ? mine[a.k] || (final && a.sched <= t0) : a.sched === t0 || (a.sched < t0 && (isGrid || final)))).sort((p, q) => p.sched - q.sched || (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
      const tried = new Set<string>();
      for (const a of due) {
        const pk = `${a.layer}|${a.c.x}|${a.c.y}`, me = capOf(a);
        let free = !tried.has(pk);
        tried.add(pk);
        if (free) for (const b of A) if (b !== a && b.present && b.layer === a.layer && Math.abs(b.c.x - a.c.x) <= a.half + b.half + 1 && Math.abs(b.c.y - a.c.y) <= a.half + b.half + 1 && capsuleGap(me, capOf(b)) <= CONTACT_TOL_MM) { free = false; break; }
        if (!free) { stats.entry_blocked_instants++; if (!a.entryBlocked) { a.entryBlocked = true; ev(t0, 'entry_blocked', [a.k], 'solver_status', 'entry pose occupied: waits off the road (control scenario boundary)'); } continue; }
        a.present = true; a.entered = t0; a.start = t0; stats.entered++; sample(a, t0);
      }
    }
    if (final) {
      // agents starting exactly at the horizon are started (as in PH-3b); one already on its goal arrives at H, once; one not
      // on its goal ends as 'started_at_horizon' (zero elapsed time: no decision, no displacement)
      for (const a of A) {
        if (!a.present || a.arrived !== null || a.start > H) continue;
        if (!a.started) { a.started = true; ev(a.start, 'start', [a.k], 'motion', SPAWN ? `entered the road at its entry pose (scheduled ${a.sched} s; control scenario boundary)` : null); a.atHorizonStart = true; }
        if (a.goal * a.dir - fwdOf(a) <= 0) { sample(a, H); a.eff = ZERO; a.arrived = H; stats.arrived++; ev(H, 'arrive', [a.k], 'motion'); }
      }
      break;
    }
    // neighbour candidates: boxes covering perception and the largest possible motion in this interval
    const boxes: AABB[] = A.map((a) => { const m = a.half + RHO + (a.arrived === null ? a.v0 * span : 0); return { minX: a.c.x - m, minY: a.c.y - m, maxX: a.c.x + m, maxY: a.c.y + m }; });
    const pairs = broadphasePairs('grid', boxes, A.map((a) => a.layer), 8).filter((key) => A[Math.floor(key / N)].present && A[key % N].present);
    const nb: number[][] = A.map(() => []);
    for (const key of pairs) { const i = Math.floor(key / N), j = key % N; nb[i].push(j); nb[j].push(i); }
    // decisions (read the state at t0 only): at a grid instant every agent on the road that has started by t0; at an
    // off-grid start / entry instant only the agents that start (enter) now — their first decision; everyone else keeps the
    // decision in effect (a held agent stays stopped until its next decision instant). An agent that starts after t0 has
    // not decided yet and does not move before its own start instant (Owner decision 23).
    const deciders = A.filter((a) => a.present && a.arrived === null && (IND ? mine[a.k] && a.start <= t0 : isGrid ? a.start <= t0 : a.start === t0));
    if (IND && deciders.length) stats.decision_instants++;
    if (IND) stats.timeline_instants = (stats.timeline_instants ?? 0) + 1;
    for (const a of deciders) {
      a.held = false;
      // zero remaining distance (only possible for an agent that starts on its goal: an arrival inside or at the end of an
      // interval is recorded there): it arrives at its start instant, without a decision
      if (a.goal * a.dir - fwdOf(a) <= 0) { a.cur = 'goal'; continue; }
      const d = decide(a, perceive(a, nb[a.k]), t0, IND ? a.ep : epoch);
      a.cur = d; stats.decisions[d.kind] = (stats.decisions[d.kind] ?? 0) + 1;
    }
    // agents that move (or arrive) in this interval: on the road, a decision in effect, started (or starting before t1)
    const live = A.filter((a) => a.present && a.arrived === null && a.cur !== null && a.start < t1);
    const w: Vec2[] = A.map(() => ZERO), aT = A.map(() => 0), bT = A.map(() => 0), dec: (Decision | null)[] = A.map(() => null);
    const atGoal: boolean[] = A.map(() => false);
    /** absolute instants of the interval: the start offset is the agent's exact start time; the full span ends at exactly t1 */
    const absA = (x: number) => (A[x].start > t0 ? A[x].start : t0);
    const absT = (x: number, tau: number) => (tau === span ? t1 : tau === aT[x] ? absA(x) : t0 + tau);
    for (const a of live) {
      const x = a.k;
      aT[x] = Math.max(0, a.start - t0);
      if (a.cur === 'goal') { atGoal[x] = true; bT[x] = aT[x]; continue; }
      const d = a.cur as Decision;
      dec[x] = d; w[x] = a.held ? ZERO : d.w; bT[x] = sameVec(w[x], ZERO) ? aT[x] : span;
    }
    const c0 = A.map((a) => a.c);
    // static geometry and goal
    const cause: (string | null)[] = A.map(() => null), causeKind: ('static' | 'goal' | 'body' | null)[] = A.map(() => null), causeJ: number[] = A.map(() => -1);
    for (const a of live) {
      const x = a.k; if (atGoal[x] || bT[x] === aT[x]) continue;
      const me = capOf(a);
      for (const p of a.statics) { const h = boundedHit(me, w[x], p.c, ZERO, span - aT[x]); if (h) { const tb = aT[x] + (h.overlapping ? 0 : h.tau); if (tb < bT[x]) { bT[x] = tb; cause[x] = `static geometry ${p.id}`; causeKind[x] = 'static'; } } }
      const along = dot(w[x], a.f);
      if (along > 0) {
        // reached inside the interval, or at its end up to GOAL_TOL_MM (the time grid k·dt and the end time are rounded)
        const rem = a.goal * a.dir - fwdOf(a), tg = aT[x] + rem / along;
        if (tg <= bT[x] || (bT[x] === span && rem - along * (span - aT[x]) <= GOAL_TOL_MM)) { bT[x] = Math.max(aT[x], Math.min(tg, span)); cause[x] = 'goal'; causeKind[x] = 'goal'; }
      }
    }
    // bodies: Jacobi iteration on the stop times
    let changed = new Set<number>(live.filter((a) => bT[a.k] > aT[a.k]).map((a) => a.k)), rounds = 0, fallback = false;
    const pairList = pairs.map((key) => [Math.floor(key / N), key % N] as [number, number]);
    while (changed.size) {
      if (++rounds > 4 * N + 20) { fallback = true; break; }
      const prop = new Map<number, { b: number; why: string; o: number }>();
      for (const [i, j] of pairList) {
        if (!changed.has(i) && !changed.has(j)) continue;
        if (bT[i] === aT[i] && bT[j] === aT[j]) continue;
        const h = hitPair(i, j, aT, bT, w, c0); if (h === null) continue;
        // who moves INTO the contact at h
        const pi = add(c0[i], w[i], Math.min(Math.max(h, aT[i]), bT[i]) - aT[i]), pj = add(c0[j], w[j], Math.min(Math.max(h, aT[j]), bT[j]) - aT[j]);
        const ci = capOf(A[i], pi), cj = capOf(A[j], pj), [qa, qb] = closestPts(ci.a, ci.b, cj.a, cj.b), dd = Math.hypot(qb.x - qa.x, qb.y - qa.y);
        const nrm = dd > 0 ? { x: (qb.x - qa.x) / dd, y: (qb.y - qa.y) / dd } : null;
        const movI = h >= aT[i] && h < bT[i], movJ = h >= aT[j] && h < bT[j];
        const inI = movI && (!nrm || dot(nrm, w[i]) > 1e-12 * Math.hypot(w[i].x, w[i].y)), inJ = movJ && (!nrm || -dot(nrm, w[j]) > 1e-12 * Math.hypot(w[j].x, w[j].y));
        const resp: number[] = inI || inJ ? [...(inI ? [i] : []), ...(inJ ? [j] : [])] : [...(movI ? [i] : []), ...(movJ ? [j] : [])];
        for (const x of resp) { const o = x === i ? j : i, cur = prop.get(x); if (h < bT[x] && (!cur || h < cur.b || (h === cur.b && o < cur.o))) prop.set(x, { b: h, why: `contact with ${A[o].id} would penetrate`, o }); }
      }
      changed = new Set();
      for (const [x, p] of [...prop].sort((u, v) => u[0] - v[0])) if (p.b < bT[x]) { bT[x] = p.b; cause[x] = p.why; causeKind[x] = 'body'; causeJ[x] = p.o; changed.add(x); }
    }
    stats.physics_rounds_max = Math.max(stats.physics_rounds_max, rounds);
    if (fallback) { stats.fallback_intervals++; stats.unresolved++; ev(t0, 'unresolved', live.map((a) => a.k).slice(0, 5), 'solver_status', 'contact stop times did not settle: nobody moves in this interval (safe fallback)'); for (const a of live) { bT[a.k] = aT[a.k]; cause[a.k] = 'physics fallback (nobody moves)'; causeKind[a.k] = 'body'; } }

    // apply motion, records and events
    const posAt = (x: number, t: number) => add(c0[x], w[x], Math.min(Math.max(t - t0, aT[x]), bT[x]) - aT[x]);
    /** the stop cause as recorded: a body stop that does not touch (the other body stopped earlier than its planned path) is conservative */
    const stopWhy = (x: number, t: number): { why: string | null; conservative: boolean } => {
      const j = causeJ[x];
      if (causeKind[x] !== 'body' || j < 0) return { why: cause[x], conservative: false };
      const g = capsuleGap(capOf(A[x], posAt(x, t)), capOf(A[j], posAt(j, t)));
      return g > CONTACT_TOL_MM ? { why: `conservative stop: the planned path of ${A[j].id} would be hit, but ${A[j].id} stopped earlier (gap ${g} mm at this instant; no contact)`, conservative: true } : { why: cause[x], conservative: false };
    };
    const bodyStops: [number, number, number][] = [];   // (agent, other body, stop time) of this interval
    for (const a of live) {
      const x = a.k, tA = absA(x);
      if (!a.started) { a.started = true; ev(a.start, 'start', [x], 'motion', SPAWN ? `entered the road at its entry pose (scheduled ${a.sched} s; control scenario boundary)` : null); }
      if (atGoal[x]) { sample(a, tA); a.eff = ZERO; a.arrived = tA; stats.arrived++; ev(tA, 'arrive', [x], 'motion'); continue; }
      const d = dec[x]!, moved = bT[x] > aT[x];
      const key = `${d.kind}|${d.w.x}|${d.w.y}`;
      let named = false;
      if (key !== a.lastKey) { ev(tA, d.kind, [x], 'behavioural_response', d.detail); a.lastKey = key; named = true; }
      const vStart = moved ? d.w : ZERO;
      if (!sameVec(vStart, a.eff)) {
        sample(a, tA);
        if (!named) {
          if (moved) ev(tA, 'resume', [x], 'physical_constraint', `${d.kind}: way free again at this decision instant`);
          else { const sw = stopWhy(x, tA).why; ev(tA, 'stop', [x], 'physical_constraint', sw ?? 'no motion'); a.stopCause = sw; }
        } else if (!moved && cause[x]) a.stopCause = stopWhy(x, tA).why;
      }
      a.eff = vStart;
      if (moved) {
        a.c = add(c0[x], d.w, bT[x] - aT[x]);
        const tb = absT(x, bT[x]);
        // the goal reached inside the interval OR exactly at its end (incl. the horizon): arrival, recorded once
        if (causeKind[x] === 'goal') { sample(a, tb); a.eff = ZERO; a.arrived = tb; stats.arrived++; ev(tb, 'arrive', [x], 'motion'); }
        else if (bT[x] < span) {
          sample(a, tb); a.eff = ZERO;
          const sw = stopWhy(x, tb);
          ev(tb, 'stop', [x], 'physical_constraint', sw.why); a.stopCause = sw.why;
          if (causeKind[x] === 'static') stats.stops_static++; else if (sw.conservative) stats.stops_conservative++; else stats.stops_contact++;
          if (causeKind[x] === 'body' && causeJ[x] >= 0 && !sw.conservative) bodyStops.push([x, causeJ[x], tb]);
        }
      } else if (causeKind[x] === 'goal') { sample(a, tA); a.eff = ZERO; a.arrived = tA; stats.arrived++; ev(tA, 'arrive', [x], 'motion'); }
      // stopped short of its decided motion: held (inelastic) until its next decision instant
      if (a.arrived === null && !sameVec(w[x], ZERO) && sameVec(a.eff, ZERO)) a.held = true;
    }
    // contacts: the exact first separation time from the piecewise motion of both bodies in this interval
    /** first t in [from, t1] at which the gap of i and j exceeds CONTACT_TOL_MM, with its bisection bracket [lo, hi]
     *  (gap <= tol at lo, > tol at hi; t = hi); null if it never does in this interval */
    const firstSeparation = (i: number, j: number, from: number): { t: number; lo: number; hi: number } | null => {
      const gapAt = (t: number) => capsuleGap(capOf(A[i], posAt(i, t)), capOf(A[j], posAt(j, t)));
      const pts = [...new Set([from, t1, ...[i, j].flatMap((x) => [absA(x), absT(x, bT[x])]).filter((p) => p > from && p < t1)])].sort((p, q) => p - q);
      for (let k = 0; k + 1 < pts.length; k++) {
        const p = pts[k], q = pts[k + 1], mid = (p + q) / 2;
        const still = (x: number) => !(mid - t0 > aT[x] && mid - t0 < bT[x]);
        if (still(i) && still(j)) continue;                // gap constant on this piece
        if (gapAt(p) > CONTACT_TOL_MM) return { t: p, lo: p, hi: p };   // (only at `from` for a contact that did not start touching)
        if (!(gapAt(q) > CONTACT_TOL_MM)) continue;       // convex on the piece: <= tol at both ends -> <= tol throughout
        let lo = p, hi = q;
        for (let n = 0; n < 200 && hi - lo > 1e-15 * Math.max(1, hi); n++) { const m = (lo + hi) / 2; if (gapAt(m) > CONTACT_TOL_MM) hi = m; else lo = m; }
        return { t: hi, lo, hi };
      }
      return null;
    };
    const endContact = (key: number, ts: number) => {
      const i = Math.floor(key / N), j = key % N, sep = firstSeparation(i, j, Math.max(t0, ts));
      if (sep === null) return null;
      activeContacts.delete(key); stats.contact_ends_exact++;
      events.push({ t_s: sep.t, kind: 'contact_end', agents: [A[i].id, A[j].id], class: 'physical_contact', detail: `gap first exceeds ${CONTACT_TOL_MM} mm (exact, from the piecewise motion of both bodies)`, bracket_s: [sep.lo, sep.hi] });
      return sep.t;
    };
    // 1) contacts already open at t0 (a separation before a new stop of the same pair ends the old contact)
    const endedAt = new Map<number, number>();
    for (const [key, ts] of [...activeContacts].sort((p, q) => p[0] - q[0])) { const te = endContact(key, ts); if (te !== null) endedAt.set(key, te); }
    // 2) body stops start a contact unless the pair is in contact at that instant already. A stop computed against the
    //    other body's planned path is conservative when that body itself stopped earlier (stop times only decrease in the
    //    Jacobi iteration): if the bodies do not touch at the stop instant (gap > CONTACT_TOL_MM) it is no contact.
    const fresh: number[] = [];
    for (const [x, j, tb] of bodyStops) {
      const key = pkey(x, j), te = endedAt.get(key);
      if (activeContacts.has(key) || (te !== undefined && te > tb)) continue;
      if (capsuleGap(capOf(A[x], posAt(x, tb)), capOf(A[j], posAt(j, tb))) > CONTACT_TOL_MM) continue;
      endedAt.delete(key); activeContacts.set(key, tb); fresh.push(key); stats.contacts++;
      ev(tb, 'contact_start', [Math.min(x, j), Math.max(x, j)], 'physical_contact', null);
    }
    // 3) contacts started in this interval that already separate in it
    for (const key of fresh.sort((p, q) => p - q)) endContact(key, activeContacts.get(key)!);
    // rule D (at the end of each decision period): progress over the stall window, local diagnosis, report once per episode
    // individual clock: at the end of the agent's own decision period (its next own instant) or at H
    if (IND || t1 === gEnd) for (const a of A) {
      if (IND && !(a.nextT === t1 || t1 === H)) continue;
      if (!a.present || a.arrived !== null || !a.started) continue;
      a.progress.push(fwdOf(a)); if (a.progress.length > STALL_K + 1) a.progress.shift();
      if (a.progress.length <= STALL_K) continue;
      const prog = a.progress[a.progress.length - 1] - a.progress[0];
      if (prog >= STALL_MM) { a.stalledSince = null; a.reported = false; continue; }
      if (a.stalledSince === null) a.stalledSince = exactSum([1, t1], [-STALL_K, DT]);
      if (!a.reported) {
        const pc = perceive(a, nb[a.k]), ahead = probe(a, pc, a.f, RHO), why = diagnose(a, pc, ahead);
        a.reported = true; a.reports++; stats.blocked_reports[why] = (stats.blocked_reports[why] ?? 0) + 1;
        ev(t1, 'blocked_report', [a.k], 'solver_status', `${why}: forward progress ${prog.toFixed(4)} mm in ${gridTime(STALL_K, DT)} s${ahead ? ` (${ahead.what} ${ahead.id} ahead)` : ''}`);
        if (why === 'static_closed' && !a.halted) { a.halted = true; stats.geometry_halts++; }
      }
    }
    t0 = t1;
  }
  events.sort((p, q) => p.t_s - q.t_s);   // stable: same-time events keep their generation order
  const agents: Record<string, SteerAgentOut> = {};
  for (const a of A) {
    if (a.present) sample(a, H);
    const moving = !sameVec(a.eff, ZERO);
    const mode = a.removed !== null ? 'exited' : a.arrived !== null ? 'arrived' : SPAWN && a.entered === null ? 'not_entered' : !a.started ? 'not_started' : a.atHorizonStart ? 'started_at_horizon' : a.halted ? 'halted_geometry' : a.stalledSince !== null ? 'stalled' : moving ? 'moving' : 'waiting_or_stopped';
    if (mode === 'stalled' || mode === 'halted_geometry') { stats.stalled++; events.push({ t_s: H, kind: 'stalled', agents: [a.id], class: 'solver_status', detail: `${mode} since ${a.stalledSince} s${a.stopCause ? `; last stop: ${a.stopCause}` : ''}` }); }
    agents[a.id] = { lane: a.lane, layer: a.layerName, samples: a.samples, arrival_t_s: a.arrived, final_mode: mode, final_speed_mm_s: Math.hypot(a.eff.x, a.eff.y), stop_cause: a.stopCause, geometry_stop_s_mm: null, blocked_reports: a.reports };
    if (SPAWN) Object.assign(agents[a.id], { scheduled_start_t_s: a.sched, present_from_t_s: a.entered });
    if (EXIT) agents[a.id].removed_t_s = a.removed;
  }
  return IND ? { policy, agents, events, stats, decision_clock: 'individual' } : { policy, agents, events, stats };
}

/** re-export so callers can tell refusals apart */
export { Solver2DRefused };
/** exact segment distance used by verifiers (re-export, no new geometry) */
export const axisDistance = segmentSegment2D;
