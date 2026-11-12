/**
 * KIN-2D ↔ PH-3b SHARED PHYSICS INTERFACE CONTRACT, phase 1 (docs/physics-shared-contract.md). ISOLATED: not imported
 * by the official pipeline (tests/physics-isolation.test.ts). Common types for pose, body geometry, motion and contact
 * events, obstacles, time, error bounds and a replayable run record, plus ADAPTERS that translate a shared scenario into
 * each solver's own input and each solver's own result into the shared record. The adapters only translate: neither
 * solver is changed (engine/physics/solver2d.ts is byte-identical to main; kinematics2d.ts is untouched).
 * Acceleration is a RESERVED extension: its fields exist, are documented and must be null / inactive; neither solver
 * models acceleration (velocity changes are instantaneous in both).
 * Pure and deterministic; no platform APIs.
 */
import { runKinematics, poseAt, type KinInput, type KinResult, type Static, type Track, type Seg } from './kinematics2d.ts';
import { solve2D, type Solver2DInput, type Solver2DResult, ACTIVE_TOL_MM, HIT_TOL_MM } from './solver2d.ts';
import { CONTACT_TOL_MM, CA_LEVEL_MM } from './kinematics2d.ts';

export const SHARED_SCHEMA = 'antempire.physics-run.v1' as const;
export type SolverId = 'kin2d' | 'ph3b';
export interface SharedXY { x_mm: number; y_mm: number }
export interface SharedPose { t_s: number; x_mm: number; y_mm: number; heading_rad: number }
/** rigid capsule (PH-3a contract, shared by both solvers): core segment of length max(0, L − w) along the heading, radius w/2 */
export interface SharedBody { shape: 'capsule'; length_mm: number; width_mm: number }
export interface SharedTime { unit: 's'; t0_s: number; horizon_s: number }
export type SharedObstacle =
  | { id: string; layer: string; kind: 'disc'; center: SharedXY; radius_mm: number }
  | { id: string; layer: string; kind: 'polygon'; points: SharedXY[] };
export interface SharedLane { id: string; layer: string; centerline: SharedXY[]; width_mm: number }
export interface SharedAgentSpec {
  id: string; body: SharedBody; lane: string; dir: 1 | -1; s_mm: number; goal_s_mm: number; u_mm: number;
  start_t_s: number; speed_mm_s: number;
}
/** RESERVED extension (not active in either solver). Kept so a later model with real acceleration has a slot; values
 *  must be null until species or physical evidence exists — never invented. */
export interface AccelerationExtension { active: false; max_accel_mm_s2: null; max_decel_mm_s2: null; max_angular_accel_rad_s2: null; note: string }
export const ACCELERATION_RESERVED: AccelerationExtension = { active: false, max_accel_mm_s2: null, max_decel_mm_s2: null, max_angular_accel_rad_s2: null, note: '保留欄位：兩個求解器的速度都是瞬間改變；本種無起步／停止加速度資料，不得填值' };
export interface SharedScenario {
  schema: 'antempire.physics-scenario.v1'; id: string; time: SharedTime;
  lanes: SharedLane[]; obstacles: SharedObstacle[]; agents: SharedAgentSpec[];
  /** KIN-2D has no lanes: if true, each lane's two side edges become wall segments for KIN-2D (PH-3b always uses them) */
  lane_edges_as_walls: boolean;
  acceleration: AccelerationExtension;
}
export interface SharedMotionEvent { t_s: number; agent: string; kind: 'start' | 'arrive' | 'stop' | 'resume' | 'follow' | 'free' | 'turn' | 'turn_blocked' | 'pass' | 'stalled'; detail: string | null }
export interface SharedContactEvent { t_s: number; kind: 'contact_start' | 'contact_end' | 'stop_on_contact' | 'geometry_stop'; ids: string[]; bracket_s: [number, number] | null; detail: string | null }
/** numerical resolution each solver guarantees (not model parameters) */
export interface ErrorBounds { contact_gap_mm: [number, number]; position_mm: number; sample_interp_mm: number; note: string }
export interface SharedAgentOut { id: string; layer: string; body: SharedBody; samples: SharedPose[]; arrival_t_s: number | null; stopped_at_s: number | null }
export interface SharedRunRecord {
  schema: typeof SHARED_SCHEMA; solver: SolverId; scenario_id: string; time: SharedTime;
  agents: SharedAgentOut[]; motion_events: SharedMotionEvent[]; contact_events: SharedContactEvent[];
  obstacles: SharedObstacle[]; error_bounds: ErrorBounds; event_count: number; acceleration: AccelerationExtension;
}
/** what each solver can express; the comparison runs only where both are true */
export interface MotionCapabilities { straight: boolean; polyline_lane_instant_turn: boolean; arc: boolean; in_place_rotation: boolean; lateral_steering: boolean; reverse_or_turn_back: boolean; speed_follow_after_contact: boolean; freeze_on_contact: boolean; disc_obstacle: boolean; polygon_obstacle: boolean; wall_segment: boolean; acceleration: boolean }
export const CAPABILITIES: Record<SolverId, MotionCapabilities> = {
  kin2d: { straight: true, polyline_lane_instant_turn: false, arc: true, in_place_rotation: true, lateral_steering: true, reverse_or_turn_back: true, speed_follow_after_contact: false, freeze_on_contact: true, disc_obstacle: true, polygon_obstacle: true, wall_segment: true, acceleration: false },
  ph3b: { straight: true, polyline_lane_instant_turn: true, arc: false, in_place_rotation: false, lateral_steering: false, reverse_or_turn_back: false, speed_follow_after_contact: true, freeze_on_contact: false, disc_obstacle: true, polygon_obstacle: true, wall_segment: false, acceleration: false },
};
export const ERROR_BOUNDS: Record<SolverId, ErrorBounds> = {
  kin2d: { contact_gap_mm: [CA_LEVEL_MM, CONTACT_TOL_MM], position_mm: 1e-9, sample_interp_mm: 0, note: '保守前進：接觸時 g ∈ (λ, θ]；姿態為解析解（直線段的線性內插是精確的）' },
  ph3b: { contact_gap_mm: [-HIT_TOL_MM, ACTIVE_TOL_MM], position_mm: 1e-9, sample_interp_mm: 0, note: '凸間距的精確首根；直線平移，事件之間線性內插是精確的' },
};

export class SharedRefused extends Error { constructor(m: string) { super(`SHARED_REFUSED: ${m}`); this.name = 'SharedRefused'; } }

export function validateScenario(s: SharedScenario): string[] {
  const e: string[] = [];
  if (s.schema !== 'antempire.physics-scenario.v1') e.push('schema');
  if (!(s.time && s.time.unit === 's' && s.time.t0_s === 0 && s.time.horizon_s > 0 && Number.isFinite(s.time.horizon_s))) e.push('time');
  const a = s.acceleration;
  if (!a || a.active !== false || a.max_accel_mm_s2 !== null || a.max_decel_mm_s2 !== null || a.max_angular_accel_rad_s2 !== null) e.push('acceleration is reserved: must be inactive with null values');
  const lanes = new Map(s.lanes.map((l) => [l.id, l]));
  for (const g of s.agents) {
    if (!lanes.has(g.lane)) e.push(`${g.id}: unknown lane`);
    if (!(g.body && g.body.shape === 'capsule' && g.body.length_mm > 0 && g.body.width_mm > 0)) e.push(`${g.id}: body`);
    if (!(g.speed_mm_s > 0)) e.push(`${g.id}: speed`);
  }
  return e;
}

// ---------------------------------------------------------------- lane geometry (shared convention = body2d.laneBodyPose)
function laneGeom(l: SharedLane) {
  const pts = l.centerline;
  if (pts.length !== 2) return null; // KIN-2D adapter: straight lanes only (PH-3b's instantaneous joint turn has no KIN-2D equivalent)
  const a = pts[0], b = pts[1], len = Math.hypot(b.x_mm - a.x_mm, b.y_mm - a.y_mm), t = { x: (b.x_mm - a.x_mm) / len, y: (b.y_mm - a.y_mm) / len };
  return { a, len, t, n: { x: -t.y, y: t.x } };
}

// ---------------------------------------------------------------- adapters: scenario → solver input
export function toPH3bInput(s: SharedScenario): Solver2DInput {
  const e = validateScenario(s); if (e.length) throw new SharedRefused(e.join('; '));
  return {
    lanes: s.lanes.map((l) => ({ id: l.id, centerline_mm: l.centerline.map((p) => ({ x: p.x_mm, y: p.y_mm })), width_mm: l.width_mm, layer: l.layer })),
    obstacles: s.obstacles.map((o) => (o.kind === 'disc' ? { id: o.id, layer: o.layer, kind: 'circle' as const, center_mm: { x: o.center.x_mm, y: o.center.y_mm }, radius_mm: o.radius_mm } : { id: o.id, layer: o.layer, kind: 'polygon' as const, points_mm: o.points.map((p) => ({ x: p.x_mm, y: p.y_mm })) })),
    agents: s.agents.map((g) => ({ id: g.id, lane: g.lane, s_mm: g.s_mm, u_mm: g.u_mm, dir: g.dir, start_t_s: g.start_t_s, goal_s_mm: g.goal_s_mm, free_speed_mm_s: g.speed_mm_s, body: { length_mm: g.body.length_mm, width_mm: g.body.width_mm } })),
    horizon_s: s.time.horizon_s,
  };
}
export function toKin2DInput(s: SharedScenario): KinInput {
  const e = validateScenario(s); if (e.length) throw new SharedRefused(e.join('; '));
  const lanes = new Map(s.lanes.map((l) => [l.id, l]));
  const tracks: Track[] = s.agents.map((g) => {
    const l = lanes.get(g.lane) as SharedLane, G = laneGeom(l);
    if (!G) throw new SharedRefused(`${g.id}: lane ${l.id} is a polyline; KIN-2D has no instantaneous joint turn (not comparable)`);
    const e2 = { x: G.t.x * g.dir, y: G.t.y * g.dir }, th = Math.atan2(G.t.y * g.dir, G.t.x * g.dir);
    const p0 = { x: G.a.x_mm + G.t.x * g.s_mm + G.n.x * g.u_mm, y: G.a.y_mm + G.t.y * g.s_mm + G.n.y * g.u_mm, th };
    const T = Math.abs(g.goal_s_mm - g.s_mm) / g.speed_mm_s, t1 = g.start_t_s + T;
    const p1 = { x: p0.x + e2.x * Math.abs(g.goal_s_mm - g.s_mm), y: p0.y + e2.y * Math.abs(g.goal_s_mm - g.s_mm), th };
    const segs: Seg[] = [];
    if (g.start_t_s > 0) segs.push({ t0: 0, t1: g.start_t_s, p0, tw: { v: 0, vl: 0, w: 0 }, label: 'wait' });
    segs.push({ t0: g.start_t_s, t1, p0, tw: { v: g.speed_mm_s, vl: 0, w: 0 }, label: 'straight' });
    segs.push({ t0: t1, t1: Infinity, p0: p1, tw: { v: 0, vl: 0, w: 0 }, label: 'hold' });
    return { id: g.id, body: { length_mm: g.body.length_mm, width_mm: g.body.width_mm }, layer: l.layer, segs };
  });
  const statics: Static[] = s.obstacles.map((o) => (o.kind === 'disc' ? { id: o.id, layer: o.layer, kind: 'disc' as const, c: { x: o.center.x_mm, y: o.center.y_mm }, r: o.radius_mm } : { id: o.id, layer: o.layer, kind: 'polygon' as const, pts: o.points.map((p) => ({ x: p.x_mm, y: p.y_mm })) }));
  if (s.lane_edges_as_walls) for (const l of s.lanes) {
    const G = laneGeom(l); if (!G) throw new SharedRefused(`lane ${l.id}: polyline edges not converted`);
    for (const side of [1, -1]) {
      const off = { x: G.n.x * side * (l.width_mm / 2), y: G.n.y * side * (l.width_mm / 2) };
      statics.push({ id: `${l.id}:edge${side > 0 ? 'L' : 'R'}`, layer: l.layer, kind: 'segment', a: { x: G.a.x_mm + off.x, y: G.a.y_mm + off.y }, b: { x: G.a.x_mm + G.t.x * G.len + off.x, y: G.a.y_mm + G.t.y * G.len + off.y } });
    }
  }
  return { tracks, statics, horizon_s: s.time.horizon_s };
}

// ---------------------------------------------------------------- adapters: solver result → shared record
const bodyOf = (g: SharedAgentSpec): SharedBody => ({ ...g.body });
export function fromKin2D(s: SharedScenario, input: KinInput, res: KinResult): SharedRunRecord {
  const agents: SharedAgentOut[] = s.agents.map((g) => {
    const ex = res.executed[g.id], tr: Track = { id: g.id, body: ex.body, segs: [...ex.segs, { t0: ex.segs[ex.segs.length - 1].t1, t1: Infinity, p0: res.final[g.id], tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] };
    const times = [...new Set([0, ...ex.segs.flatMap((q) => [q.t0, q.t1]).filter((t) => Number.isFinite(t) && t <= s.time.horizon_s)])].sort((a, b) => a - b);
    const samples = times.map((t) => { const p = poseAt(tr, t); return { t_s: t, x_mm: p.x, y_mm: p.y, heading_rad: p.th }; });
    const planned = input.tracks.find((t) => t.id === g.id) as Track, moveEnd = planned.segs.find((q) => q.label === 'straight')?.t1 ?? null;
    const arrival = moveEnd !== null && moveEnd <= s.time.horizon_s && (ex.stopped_at_s === null || ex.stopped_at_s >= moveEnd) ? moveEnd : null;
    return { id: g.id, layer: planned.layer ?? '', body: bodyOf(g), samples, arrival_t_s: arrival, stopped_at_s: arrival === null ? ex.stopped_at_s : null };
  });
  const motion: SharedMotionEvent[] = [];
  for (const a of agents) { const g = s.agents.find((x) => x.id === a.id) as SharedAgentSpec; motion.push({ t_s: g.start_t_s, agent: a.id, kind: 'start', detail: null }); if (a.arrival_t_s !== null) motion.push({ t_s: a.arrival_t_s, agent: a.id, kind: 'arrive', detail: null }); }
  const contacts: SharedContactEvent[] = res.events.filter((e) => e.kind === 'contact_start' || e.kind === 'contact_end' || e.kind === 'stop_on_contact').map((e) => ({ t_s: e.t_s, kind: e.kind as SharedContactEvent['kind'], ids: [...e.ids], bracket_s: e.bracket_s ?? null, detail: e.detail ?? null }));
  return finish(s, 'kin2d', agents, motion, contacts, res.events.length);
}
export function fromPH3b(s: SharedScenario, res: Solver2DResult): SharedRunRecord {
  const agents: SharedAgentOut[] = s.agents.map((g) => {
    const a = res.agents[g.id];
    const samples = a.samples.map(([t, x, y, h]) => ({ t_s: t, x_mm: x, y_mm: y, heading_rad: h }));
    const stop = res.events.find((e) => e.kind === 'stop' && e.agents[0] === g.id);
    return { id: g.id, layer: a.layer, body: bodyOf(g), samples, arrival_t_s: a.arrival_t_s, stopped_at_s: a.arrival_t_s === null && stop ? stop.t_s : null };
  });
  const motion: SharedMotionEvent[] = [], contacts: SharedContactEvent[] = [];
  for (const e of res.events) {
    if (e.kind === 'contact_start' || e.kind === 'contact_end') contacts.push({ t_s: e.t_s, kind: e.kind, ids: [...e.agents].sort(), bracket_s: null, detail: e.detail });
    else if (e.kind === 'stop' && e.detail && e.detail.startsWith('static geometry')) contacts.push({ t_s: e.t_s, kind: 'geometry_stop', ids: [e.agents[0], e.detail.replace('static geometry ', '')], bracket_s: null, detail: e.detail });
    else if (['start', 'arrive', 'stop', 'resume', 'follow', 'free', 'turn', 'turn_blocked', 'pass', 'stalled'].includes(e.kind)) motion.push({ t_s: e.t_s, agent: e.agents[0], kind: e.kind as SharedMotionEvent['kind'], detail: e.detail });
  }
  return finish(s, 'ph3b', agents, motion, contacts, res.stats.events_processed);
}
function finish(s: SharedScenario, solver: SolverId, agents: SharedAgentOut[], motion: SharedMotionEvent[], contacts: SharedContactEvent[], n: number): SharedRunRecord {
  const ord = (a: { t_s: number }, b: { t_s: number }) => a.t_s - b.t_s;
  return { schema: SHARED_SCHEMA, solver, scenario_id: s.id, time: { ...s.time }, agents, motion_events: motion.sort(ord), contact_events: contacts.sort(ord), obstacles: s.obstacles, error_bounds: ERROR_BOUNDS[solver], event_count: n, acceleration: ACCELERATION_RESERVED };
}

/** pose of an agent at t from the shared samples (linear between samples; exact for both solvers' straight motion) */
export function sharedPoseAt(a: SharedAgentOut, t: number): SharedPose {
  const S = a.samples;
  if (t <= S[0].t_s) return { ...S[0], t_s: t };
  for (let i = 1; i < S.length; i++) if (t <= S[i].t_s) {
    const p = S[i - 1], q = S[i], f = q.t_s === p.t_s ? 1 : (t - p.t_s) / (q.t_s - p.t_s);
    return { t_s: t, x_mm: p.x_mm + f * (q.x_mm - p.x_mm), y_mm: p.y_mm + f * (q.y_mm - p.y_mm), heading_rad: f < 1 ? p.heading_rad : q.heading_rad };
  }
  return { ...S[S.length - 1], t_s: t };
}

/** run a shared scenario on both solvers (each through its own unchanged entry point) */
export function runBoth(s: SharedScenario): { kin2d: SharedRunRecord; ph3b: SharedRunRecord } {
  const ki = toKin2DInput(s), pi = toPH3bInput(s);
  return { kin2d: fromKin2D(s, ki, runKinematics(ki)), ph3b: fromPH3b(s, solve2D(pi)) };
}

// ================================================================ SHARED PHYSICAL CONTACT CONSTRAINT CONTRACT
/**
 * Owner decision 42 (docs/physics-contact-constraint.md). ONE physical principle for what happens when a body reaches
 * another body or an obstacle, shared by KIN-2D and PH-3b (each keeps its current response as a comparison baseline):
 *  1. no penetration: the gap g between any two touching shapes never becomes negative;
 *  2. the contact response is a VELOCITY CONSTRAINT consistent with the local geometry: for every touching pair the
 *     relative normal velocity at the closest points must not compress the contact (ġ ≥ 0);
 *  3. the executed velocity is the constrained velocity CLOSEST to the commanded one (Euclidean projection in the
 *     solver's velocity coordinates):
 *       - if the command does not compress any contact, it is executed unchanged;
 *       - if motion along the obstacle boundary is possible, the result slides (the tangential part is kept);
 *       - if no motion direction is feasible, the result is zero (stop);
 *  4. NO PUSHING: neither solver has masses or forces, so a body is never driven by another body. In a pair, only a body
 *     whose own commanded motion closes the gap yields; it yields to the other body's EXECUTED motion (a follower may
 *     match a leader's speed). If both bodies close the gap, each removes its own closing part (both treat the contact
 *     as stationary). This is a physical non-penetration rule, NOT a social "following" behaviour.
 * The rows below are the generic form: a·x ≥ b on a solver's velocity vector x. The reference projector solves
 *   min ‖x − x₀‖²  s.t.  aᵢ·x ≥ bᵢ
 * EXACTLY by enumerating active sets (KKT: multipliers ≥ 0, all rows satisfied). It is a REFERENCE (small row counts),
 * not an optimised solver; above max_rows it refuses instead of approximating.
 * PH-3b mapping (1-D lane speed): one row per follower, −v ≥ −v_leader, gives v = min(v_cmd, v_leader) — PH-3b's
 * existing follow rule is exactly this projection (tested). KIN-2D mapping: engine/physics/kinematics2d-contact.ts.
 */
export interface ConstraintRow { id: string; a: number[]; b: number }
export type ProjectionStatus = 'free' | 'constrained' | 'stopped' | 'infeasible' | 'too_many_rows';
export interface ProjectionResult { x: number[]; status: ProjectionStatus; active: string[]; multipliers: number[]; max_violation: number; subsets_tried: number }
export const PROJECTION_TOL = 1e-12;
export const PROJECTION_MAX_ROWS = 12;
const dot = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
/** Gaussian elimination with partial pivoting; null if (numerically) singular */
function solveLinear(M: number[][], r: number[]): number[] | null {
  const n = r.length, A = M.map((row, i) => [...row, r[i]]);
  const scale = Math.max(1e-300, ...M.flat().map(Math.abs));
  for (let c = 0; c < n; c++) {
    let p = c; for (let i = c + 1; i < n; i++) if (Math.abs(A[i][c]) > Math.abs(A[p][c])) p = i;
    if (Math.abs(A[p][c]) <= 1e-12 * scale) return null;
    [A[c], A[p]] = [A[p], A[c]];
    for (let i = 0; i < n; i++) if (i !== c) { const f = A[i][c] / A[c][c]; for (let k = c; k <= n; k++) A[i][k] -= f * A[c][k]; }
  }
  return A.map((row, i) => row[n] / row[i]);
}
/** exact Euclidean projection of x0 onto {x : aᵢ·x ≥ bᵢ} (reference implementation; deterministic) */
export function projectVelocity(x0: number[], rows: ConstraintRow[], opts: { max_rows?: number; tol?: number } = {}): ProjectionResult {
  const tol = opts.tol ?? PROJECTION_TOL, maxRows = opts.max_rows ?? PROJECTION_MAX_ROWS, n = x0.length;
  for (const r of rows) if (r.a.length !== n || !r.a.every(Number.isFinite) || !Number.isFinite(r.b)) throw new SharedRefused(`constraint row ${r.id}: bad dimension or value`);
  const sorted = [...rows].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const viol = (x: number[]) => Math.max(0, ...sorted.map((r) => r.b - dot(r.a, x)));
  const nx0 = Math.hypot(...x0), rowTol = (r: ConstraintRow) => tol * Math.max(1, Math.abs(r.b), Math.hypot(...r.a) * Math.max(1, nx0));
  if (sorted.every((r) => dot(r.a, x0) >= r.b - rowTol(r))) return { x: [...x0], status: 'free', active: [], multipliers: [], max_violation: viol(x0), subsets_tried: 0 };
  if (sorted.length > maxRows) return { x: x0.map(() => 0), status: 'too_many_rows', active: [], multipliers: [], max_violation: NaN, subsets_tried: 0 };
  const m = sorted.length;
  let best: { x: number[]; S: number[]; mu: number[]; d: number } | null = null, tried = 0;
  // subsets in a fixed order: by size, then by bit pattern (deterministic)
  const masks = Array.from({ length: (1 << m) - 1 }, (_, i) => i + 1).sort((p, q) => popcount(p) - popcount(q) || p - q);
  for (const mask of masks) {
    if (popcount(mask) > n) continue; // more active rows than dimensions are linearly dependent
    const S = [...Array(m).keys()].filter((i) => mask & (1 << i)); tried++;
    const G = S.map((i) => S.map((j) => dot(sorted[i].a, sorted[j].a))), rhs = S.map((i) => sorted[i].b - dot(sorted[i].a, x0));
    const mu = solveLinear(G, rhs); if (!mu) continue;
    if (mu.some((u) => u < -tol * Math.max(1, nx0))) continue;
    const x = x0.map((v, k) => v + S.reduce((s, i, j) => s + mu[j] * sorted[i].a[k], 0));
    if (!sorted.every((r) => dot(r.a, x) >= r.b - rowTol(r))) continue;
    const d = Math.hypot(...x.map((v, k) => v - x0[k]));
    if (!best || d < best.d - tol * Math.max(1, nx0)) best = { x, S, mu, d };
  }
  if (!best) return { x: x0.map(() => 0), status: 'infeasible', active: [], multipliers: [], max_violation: NaN, subsets_tried: tried };
  const stopped = Math.hypot(...best.x) <= tol * Math.max(1, nx0);
  return { x: stopped ? best.x.map(() => 0) : best.x, status: stopped ? 'stopped' : 'constrained', active: best.S.map((i) => sorted[i].id), multipliers: best.mu, max_violation: viol(best.x), subsets_tried: tried };
}
function popcount(x: number): number { let c = 0; while (x) { c += x & 1; x >>>= 1; } return c; }
/** PH-3b form of the same rule (1-D lane speed): the follower's speed after projection onto v ≤ v_leader */
export function laneFollowProjection(v_cmd: number, v_leader_exec: number): number { return projectVelocity([v_cmd], [{ id: 'leader', a: [-1], b: -v_leader_exec }]).x[0]; }

/** which contact-response model a run used (the comparison keeps both KIN-2D responses) */
export type ContactResponse = 'kin2d_freeze_baseline' | 'kin2d_projected' | 'ph3b_speed_follow';

/** KIN-2D 'project' contact mode result → shared record. Arrival is read from the EXECUTED motion (a constrained body
 *  may be slower than planned; it does not inherit the planned arrival time). Structural type: the module
 *  kinematics2d-contact.ts imports this file, so only its result shape is named here. */
export interface ProjectedKinLike { executed: KinResult['executed']; final: KinResult['final']; events: { t_s: number; kind: string; ids: string[]; bracket_s?: [number, number]; detail?: string }[]; stats: Record<string, number> }
export function fromKin2DProjected(s: SharedScenario, input: KinInput, res: ProjectedKinLike): SharedRunRecord {
  const lanes = new Map(s.lanes.map((l) => [l.id, l]));
  const agents: SharedAgentOut[] = s.agents.map((g) => {
    const ex = res.executed[g.id], last = ex.segs[ex.segs.length - 1], tr: Track = { id: g.id, body: ex.body, segs: [...ex.segs, { t0: last.t1, t1: Infinity, p0: res.final[g.id], tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }] };
    const times = [...new Set([0, ...ex.segs.flatMap((q) => [q.t0, q.t1]).filter((t) => Number.isFinite(t) && t <= s.time.horizon_s)])].sort((a, b) => a - b);
    const samples = times.map((t) => { const p = poseAt(tr, t); return { t_s: t, x_mm: p.x, y_mm: p.y, heading_rad: p.th }; });
    // progress along the (straight) lane direction; arrival = first executed time the goal distance is reached
    const G = laneGeom(lanes.get(g.lane) as SharedLane) as NonNullable<ReturnType<typeof laneGeom>>, e2 = { x: G.t.x * g.dir, y: G.t.y * g.dir }, p0 = poseAt(tr, ex.segs[0].t0), need = Math.abs(g.goal_s_mm - g.s_mm);
    const prog = (t: number) => { const p = poseAt(tr, t); return (p.x - p0.x) * e2.x + (p.y - p0.y) * e2.y; };
    let arrival: number | null = null;
    for (const q of ex.segs) {
      if (!(q.t1 > q.t0) || prog(q.t1) < need - 1e-9) continue;
      let lo = q.t0, hi = q.t1; if (prog(lo) >= need - 1e-9) { arrival = lo; break; }
      for (let k = 0; k < 200; k++) { const m = lo + (hi - lo) / 2; if (!(m > lo && m < hi)) break; if (prog(m) >= need - 1e-9) hi = m; else lo = m; }
      arrival = hi; break;
    }
    const planned = input.tracks.find((t) => t.id === g.id) as Track;
    // not arrived: the first time a contact constraint stopped it (a later command end does not erase that stop)
    const stop = res.events.find((e) => e.kind === 'stop_on_contact' && e.ids[0] === g.id);
    return { id: g.id, layer: planned.layer ?? '', body: bodyOf(g), samples, arrival_t_s: arrival, stopped_at_s: arrival === null ? (stop ? stop.t_s : ex.stopped_at_s) : null };
  });
  const motion: SharedMotionEvent[] = [];
  for (const a of agents) { const g = s.agents.find((x) => x.id === a.id) as SharedAgentSpec; motion.push({ t_s: g.start_t_s, agent: a.id, kind: 'start', detail: null }); if (a.arrival_t_s !== null) motion.push({ t_s: a.arrival_t_s, agent: a.id, kind: 'arrive', detail: null }); }
  for (const e of res.events) if (e.kind === 'constrained' || e.kind === 'constraint_free') motion.push({ t_s: e.t_s, agent: e.ids[0], kind: e.kind === 'constrained' ? 'follow' : 'free', detail: e.detail ?? null });
  const contacts: SharedContactEvent[] = res.events.filter((e) => e.kind === 'contact_start' || e.kind === 'contact_end' || e.kind === 'stop_on_contact').map((e) => ({ t_s: e.t_s, kind: e.kind as SharedContactEvent['kind'], ids: [...e.ids], bracket_s: e.bracket_s ?? null, detail: e.detail ?? null }));
  return finish(s, 'kin2d', agents, motion, contacts, res.events.length);
}
