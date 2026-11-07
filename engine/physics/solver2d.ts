/**
 * PH-3b (docs/physics-ph3b-solver2d.md): an ISOLATED, event-driven 2-D multi-agent physics solver for ant bodies in
 * lanes. Not used by simulate() or by the daily simulation (tests/physics-isolation.test.ts); the official pipeline never
 * imports it.
 *
 * Model (physical constraints only):
 *  - every agent has a real 2-D pose: lane arc position s, a lateral offset u that stays AS GIVEN (how ants steer
 *    sideways is an unknown candidate model, null — never chosen here), a travel direction and a heading along its lane
 *    segment; its body is the PH-3a capsule (body2d.ts) of the given length and width. Unknown sizes are refused.
 *  - motion is piecewise constant: each agent moves forward along its lane at a speed v ∈ [0, free speed]. Between two
 *    events every body translates in a straight line, so each pair's gap is a convex function of time.
 *  - CONTINUOUS collision detection, no time step: the next contact time of a pair is computed exactly (pairFirstHit:
 *    four point–capsule features, each convex in time, first root by bisection on its decreasing branch), for candidate
 *    pairs from a broad phase over conservative swept boxes (broadphase.ts).
 *  - at an event every touching pair (gap ≤ ACTIVE_TOL_MM) is a contact constraint dg/dt ≥ 0 (with constant velocities
 *    and a convex gap this keeps g ≥ 0 until the next event). Velocities are the GREATEST solution of the constraints
 *    (v ≤ free speed): a body that would penetrate stops; a follower keeps the leader's speed; sliding past is allowed.
 *    This greatest fixed point is unique, so the result never depends on array order or on which contact is handled first.
 *  - static geometry (lane edges with round joints, circle and polygon obstacles on the agent's layer) is precomputed per
 *    agent: the first route position where its body would touch the geometry is an explicit stop.
 *  - at a lane joint the heading turns instantly about the body centre (the pose convention of body2d.laneBodyPose, a
 *    geometric convention); the turn is checked against lane edges, obstacles and other bodies by conservative advancement
 *    over the turning angle and is refused (the body waits at the joint) if it would penetrate.
 *  - different layers (2.5D levels) never collide.
 *  - NO biological decision: no yielding, no side-step, no attack, no trophallaxis, no turning back. A body that cannot
 *    advance waits; if nothing ever frees it, it is reported stalled at the horizon.
 * Determinism: agents are processed in id order; event times are functions of the two agents' motion records only, so
 * they do not depend on the broad-phase window, the grid cell or any output sampling; same-instant events are processed
 * together and resolved by the order-independent velocity solve.
 * Units: mm, s, mm/s. Tolerances are numerical, not model parameters.
 */
import type { Vec2 } from './vec.ts';
import { type BodySize, type Capsule, type Lane2, type Bnd, capsuleGap, laneBoundary, pointInLaneRegion, segArcDist, OCC_TOL_MM } from './body2d.ts';
import { segmentSegment2D } from './vec.ts';
import { type AABB, type BroadphaseKind, broadphasePairs } from './broadphase.ts';

/** a pass whose closest approach stays within this of touching is not a contact (mm; numerical, < OCC_TOL_MM) */
export const HIT_TOL_MM = 1e-10;
/** a pair with gap ≤ this is in contact and constrained; it leaves contact when the gap exceeds it (mm; numerical) */
export const ACTIVE_TOL_MM = 1e-7;
/** |n·e| below this counts as tangential (dimensionless; numerical) */
export const NORMAL_EPS = 1e-12;

export class Solver2DRefused extends Error { constructor(m: string) { super(`SOLVER2D_REFUSED: ${m}`); this.name = 'Solver2DRefused'; } }

export interface SolverLane { id: string; centerline_mm: Vec2[]; width_mm: number | null; layer: string }
export type StaticShape = { id: string; layer: string; kind: 'circle'; center_mm: Vec2; radius_mm: number } | { id: string; layer: string; kind: 'polygon'; points_mm: Vec2[] };
export interface SolverAgent { id: string; lane: string; s_mm: number; u_mm: number; dir: 1 | -1; start_t_s: number; goal_s_mm: number; free_speed_mm_s: number; body: BodySize }
export interface Solver2DInput {
  lanes: SolverLane[]; obstacles: StaticShape[]; agents: SolverAgent[]; horizon_s: number;
  /** broad-phase method (default grid) and its numerical settings; they change cost, never the trajectories */
  broadphase?: BroadphaseKind; window_s?: number; grid_cell_mm?: number;
  /** contact tolerance (numerical; default ACTIVE_TOL_MM). Sliding contacts are re-evaluated each time the gap reopens by
   *  this much, so it sets the resolution of the piecewise-constant approximation of a sliding contact */
  active_tol_mm?: number;
  /** safety caps (solver_status 'aborted' when reached) */
  max_batches?: number; max_same_instant_batches?: number;
  /** read-only observer of every broad-phase window (box sets), for measuring broad-phase cost; never alters the run */
  observe_windows?: (t_s: number, boxes: readonly AABB[], keys: readonly number[]) => void;
}
export type Sample = [t: number, x: number, y: number, heading: number, s: number, u: number];
export type EventClass = 'physical_contact' | 'physical_constraint' | 'motion' | 'solver_status';
export interface SolverEvent { t_s: number; kind: string; agents: string[]; class: EventClass; detail: string | null }
export interface AgentOut { lane: string; layer: string; samples: Sample[]; arrival_t_s: number | null; final_mode: string; final_speed_mm_s: number; stop_cause: string | null; geometry_stop_s_mm: number | null }
export interface Solver2DResult {
  agents: Record<string, AgentOut>; events: SolverEvent[];
  stats: {
    batches: number; events_processed: number; queue_pushes: number; stale_pops: number; pair_hit_evals: number; windows: number;
    candidate_pairs_total: number; candidate_pairs_max: number; velocity_solves: number; max_component: number; max_same_instant_batches: number;
    contacts: number; releases: number; passes: number; turns: number; turn_blocked: number; stalled: number; arrived: number; unresolved: number;
    aborted: string | null; t_end_s: number;
  };
}

// ---------------------------------------------------------------- small vector helpers
const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const dotv = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const crossv = (a: Vec2, b: Vec2) => a.x * b.y - a.y * b.x;
function psd(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x, aby = b.y - a.y, L2 = abx * abx + aby * aby;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2));
  return Math.hypot(p.x - (a.x + u * abx), p.y - (a.y + u * aby));
}
/** closest points of segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection §5.1.9) */
function closestSegSeg(p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): [Vec2, Vec2] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2), a = dotv(d1, d1), e = dotv(d2, d2), f = dotv(d2, r);
  let s: number, t: number;
  if (a === 0 && e === 0) return [p1, p2];
  if (a === 0) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dotv(d1, r);
    if (e === 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dotv(d1, d2), den = a * e - b * b;
      s = den !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [{ x: p1.x + d1.x * s, y: p1.y + d1.y * s }, { x: p2.x + d2.x * t, y: p2.y + d2.y * t }];
}

// ---------------------------------------------------------------- exact continuous contact (translation)
/**
 * Point p + d·τ against segment AB: D(τ) = distance, convex in τ. Returns its minimum over τ ≥ 0 and where it is attained:
 * the minimiser of a convex piecewise function is a stationary point of a piece (closest approach to A, to B, root of the
 * signed line distance) or a breakpoint (projection crossing A or B), all evaluated with the exact distance.
 */
function featureMin(p: Vec2, d: Vec2, A: Vec2, B: Vec2): [number, number] {
  const D = (t: number) => psd({ x: p.x + d.x * t, y: p.y + d.y * t }, A, B);
  let best = D(0), arg = 0;
  const dd = dotv(d, d);
  if (dd === 0) return [best, 0];
  const cand: number[] = [dotv(sub(A, p), d) / dd, dotv(sub(B, p), d) / dd];
  const AB = sub(B, A), L2 = dotv(AB, AB);
  if (L2 > 0) {
    const s0 = dotv(sub(p, A), AB) / L2, s1 = dotv(d, AB) / L2;
    if (s1 !== 0) cand.push(-s0 / s1, (1 - s0) / s1);
    const c0 = crossv(AB, sub(p, A)), c1 = crossv(AB, d);
    if (c1 !== 0) cand.push(-c0 / c1);
  }
  for (const t of cand) if (t > 0 && Number.isFinite(t)) { const v = D(t); if (v < best || (v === best && t < arg)) { best = v; arg = t; } }
  return [best, arg];
}
/**
 * First time τ ≥ 0 at which two translating capsules touch (gap reaches 0) on the way to a real penetration (closest
 * approach deeper than HIT_TOL_MM); null when they never penetrate. Q moves relative to P with w = vQ − vP. Exact: before
 * the first touch the axes do not intersect, so the axis distance is the minimum of the four endpoint–segment distances;
 * each is convex in τ, and its first root of D = R on its decreasing branch is found by bisection. The bisection interval
 * depends only on the two capsules and velocities, so the result does not depend on any horizon or sampling.
 */
export function pairFirstHit(P: Capsule, vP: Vec2, Q: Capsule, vQ: Vec2, tolHit = HIT_TOL_MM): { tau: number; overlapping: boolean } | null {
  const R = P.r + Q.r, w = { x: vQ.x - vP.x, y: vQ.y - vP.y }, mw = { x: -w.x, y: -w.y };
  if (segmentSegment2D(P.a, P.b, Q.a, Q.b) < R - tolHit) return { tau: 0, overlapping: true };
  if (w.x === 0 && w.y === 0) return null;
  let best: number | null = null;
  const feats: [Vec2, Vec2, Vec2, Vec2][] = [[Q.a, w, P.a, P.b], [Q.b, w, P.a, P.b], [P.a, mw, Q.a, Q.b], [P.b, mw, Q.a, Q.b]];
  for (const [p, d, A, B] of feats) {
    const [dmin, tmin] = featureMin(p, d, A, B);
    if (dmin >= R - tolHit) continue;
    const D = (t: number) => psd({ x: p.x + d.x * t, y: p.y + d.y * t }, A, B);
    let tau: number;
    if (D(0) <= R) tau = 0;
    else {
      let lo = 0, hi = tmin;                                 // D(lo) > R ≥ D(hi), D decreasing on [0, tmin]
      for (let k = 0; k < 200 && hi - lo > 1e-15 * Math.max(1, hi); k++) { const m = (lo + hi) / 2; if (D(m) <= R) hi = m; else lo = m; }
      tau = hi;
    }
    if (best === null || tau < best) best = tau;
  }
  return best === null ? null : { tau: best, overlapping: false };
}

// ---------------------------------------------------------------- lanes
interface Seg { a: Vec2; t: Vec2; n: Vec2; s0: number; len: number }
function laneSegs(cl: Vec2[], id: string): Seg[] {
  const raw: Seg[] = []; let s0 = 0;
  for (let i = 1; i < cl.length; i++) {
    const a = cl[i - 1], b = cl[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    raw.push({ a, t, n: { x: -t.y, y: t.x }, s0, len }); s0 += len;
  }
  if (!raw.length) throw new Solver2DRefused(`lane ${id} has no length`);
  // merge collinear consecutive segments (as body2d does): a vertex on a straight line is not a joint
  const out: Seg[] = [];
  for (const g of raw) {
    const last = out[out.length - 1];
    if (last && Math.abs(crossv(last.t, g.t)) <= 1e-12 && dotv(last.t, g.t) > 0) out[out.length - 1] = { ...last, len: g.s0 + g.len - last.s0 };
    else out.push(g);
  }
  return out;
}
const segAt = (segs: Seg[], s: number): number => { for (let k = 0; k < segs.length; k++) if (s <= segs[k].s0 + segs[k].len) return k; return segs.length - 1; };
const poseOf = (g: Seg, s: number, u: number): Vec2 => ({ x: g.a.x + g.t.x * (s - g.s0) + g.n.x * u, y: g.a.y + g.t.y * (s - g.s0) + g.n.y * u });
const capsuleAt = (c: Vec2, e: Vec2, hw: number, r: number): Capsule => ({ a: { x: c.x - e.x * hw, y: c.y - e.y * hw }, b: { x: c.x + e.x * hw, y: c.y + e.y * hw }, r });
const rotCapsule = (c: Vec2, th: number, hw: number, r: number): Capsule => capsuleAt(c, { x: Math.cos(th), y: Math.sin(th) }, hw, r);
/** the next floating-point number above x (x ≥ 0) */
const nextUp = (x: number) => x + Math.max(Math.abs(x) * Number.EPSILON, Number.MIN_VALUE);
const wrapPi = (x: number) => { let y = x % (2 * Math.PI); if (y <= -Math.PI) y += 2 * Math.PI; if (y > Math.PI) y -= 2 * Math.PI; return y; };

// ---------------------------------------------------------------- static geometry of an agent's layer
interface StaticSet { caps: { c: Capsule; id: string }[]; arcs: { arc: Extract<Bnd, { kind: 'arc' }>; id: string }[] }
/** clearance of a capsule to the static set (axis distance − radius, minimum over pieces) */
function staticClearance(S: StaticSet, c: Capsule): { g: number; id: string | null } {
  let g = Infinity, id: string | null = null;
  for (const x of S.caps) { const v = capsuleGap(c, x.c); if (v < g) { g = v; id = x.id; } }
  for (const x of S.arcs) { const v = segArcDist(c.a, c.b, x.arc) - c.r; if (v < g) { g = v; id = x.id; } }
  return { g, id };
}
/**
 * Conservative advancement over a parameter λ ∈ [0, 1] for a gap function that is K-Lipschitz in λ. Each step moves by
 * (gap + tol)/K, so between two samples the gap stays > −tol (no violation can be skipped). Returns the first sample λ
 * with gap ≤ −tol/2 (a penetration is starting there; everything before it has gap > −tol), or null if none.
 */
function advanceClear(gap: (lam: number) => number, K: number, tol: number, maxIter = 2_000_000): number | null {
  if (!(K > 0)) return gap(0) <= -tol / 2 ? 0 : null;
  let lam = 0, it = 0;
  for (;;) {
    const g = gap(lam);
    if (g <= -tol / 2) return lam;
    if (lam >= 1) return null;
    lam = Math.min(1, lam + (g + tol) / K);
    if (++it > maxIter) throw Error('SOLVER2D: conservative advancement did not terminate (report as defect)');
  }
}

// ---------------------------------------------------------------- runtime agent
type Mode = 'waiting' | 'active' | 'arrived';
interface RT {
  k: number; id: string; spec: SolverAgent; laneIdx: number; layer: number; segs: Seg[]; u: number; dir: 1 | -1; v0: number;
  goal: number; start: number; hw: number; r: number; half: number;
  seg: number; sRef: number; tRef: number; v: number; mode: Mode;
  /** first route position where the body would touch static geometry (precomputed), with its cause */
  geoStop: { s: number; cause: string } | null;
  capped: string | null;
  turnBlocked: { blockers: number[]; cause: string } | null;
  ver: number; samples: Sample[]; arrival: number | null; stopCause: string | null; started: boolean; justStarted: boolean;
}

type QKind = 'start' | 'goal' | 'geo' | 'vertex' | 'retry' | 'contact' | 'release' | 'pass';
const KIND_RANK: Record<QKind, number> = { start: 0, goal: 1, geo: 2, vertex: 3, retry: 4, release: 5, contact: 6, pass: 7 };
interface QE { t: number; kind: QKind; a: number; b: number; va: number; vb: number; vp: number }
const qLess = (x: QE, y: QE) => x.t < y.t || (x.t === y.t && (KIND_RANK[x.kind] < KIND_RANK[y.kind] || (KIND_RANK[x.kind] === KIND_RANK[y.kind] && (x.a < y.a || (x.a === y.a && x.b < y.b)))));
class Heap {
  h: QE[] = [];
  push(e: QE) { const h = this.h; h.push(e); let i = h.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (!qLess(h[i], h[p])) break; [h[i], h[p]] = [h[p], h[i]]; i = p; } }
  peek(): QE | undefined { return this.h[0]; }
  pop(): QE | undefined {
    const h = this.h; if (!h.length) return undefined; const top = h[0], last = h.pop()!;
    if (h.length) { h[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < h.length && qLess(h[l], h[m])) m = l; if (r < h.length && qLess(h[r], h[m])) m = r; if (m === i) break; [h[i], h[m]] = [h[m], h[i]]; i = m; } }
    return top;
  }
  get size() { return this.h.length; }
}

export function solve2D(input: Solver2DInput): Solver2DResult {
  const H = input.horizon_s;
  if (!(H > 0) || !Number.isFinite(H)) throw new Solver2DRefused('horizon must be a positive finite number');
  const ACT = input.active_tol_mm ?? ACTIVE_TOL_MM;
  if (!(ACT > HIT_TOL_MM) || !(ACT < 1e-3)) throw new Solver2DRefused('active_tol_mm must lie in (HIT_TOL_MM, 1e-3)');
  const WIN = input.window_s ?? 0.25, CELL = input.grid_cell_mm ?? 8, BP: BroadphaseKind = input.broadphase ?? 'grid';
  if (!(WIN > 0)) throw new Solver2DRefused('window_s must be positive');
  const maxBatches = input.max_batches ?? 5_000_000, maxSame = input.max_same_instant_batches ?? 10_000;
  // ---- lanes, layers, static geometry
  const laneIds = new Map<string, number>(), layerIds = new Map<string, number>();
  const lanes = input.lanes.map((l, i) => {
    if (laneIds.has(l.id)) throw new Solver2DRefused(`duplicate lane ${l.id}`);
    if (typeof l.width_mm !== 'number' || !(l.width_mm > 0)) throw new Solver2DRefused(`lane ${l.id} width unknown (never defaulted)`);
    laneIds.set(l.id, i); if (!layerIds.has(l.layer)) layerIds.set(l.layer, layerIds.size);
    const lane2: Lane2 = { id: l.id, centerline_mm: l.centerline_mm.map((p) => ({ x: p.x, y: p.y })), width_mm: l.width_mm };
    const segs = laneSegs(lane2.centerline_mm, l.id);
    const bnd = laneBoundary(lane2).filter((b) => !(b.kind === 'seg' && b.end));
    return { spec: l, lane2, segs, layer: layerIds.get(l.layer)!, bnd };
  });
  const obsByLayer = new Map<number, StaticSet>();
  for (const o of input.obstacles) {
    const L = layerIds.get(o.layer); if (L === undefined) continue;
    const S = obsByLayer.get(L) ?? { caps: [], arcs: [] }; obsByLayer.set(L, S);
    if (o.kind === 'circle') { if (!(o.radius_mm > 0)) throw new Solver2DRefused(`obstacle ${o.id} radius`); S.caps.push({ c: { a: o.center_mm, b: o.center_mm, r: o.radius_mm }, id: o.id }); }
    else { const P = o.points_mm; if (P.length < 3) throw new Solver2DRefused(`obstacle ${o.id} polygon`); for (let i = 0; i < P.length; i++) S.caps.push({ c: { a: P[i], b: P[(i + 1) % P.length], r: 0 }, id: o.id }); }
  }
  const polygons = input.obstacles.filter((o): o is Extract<StaticShape, { kind: 'polygon' }> => o.kind === 'polygon');
  const insidePoly = (p: Vec2, P: Vec2[]) => { let ins = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const a = P[i], b = P[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };

  // ---- agents (canonical id order)
  const specs = [...input.agents].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (let i = 1; i < specs.length; i++) if (specs[i].id === specs[i - 1].id) throw new Solver2DRefused(`duplicate agent id ${specs[i].id}`);
  const N = specs.length;
  const A: RT[] = specs.map((sp, k) => {
    const li = laneIds.get(sp.lane); if (li === undefined) throw new Solver2DRefused(`${sp.id}: lane ${sp.lane} unknown`);
    const L = sp.body.length_mm, w = sp.body.width_mm;
    if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0) || !(w > 0) || !Number.isFinite(L) || !Number.isFinite(w)) throw new Solver2DRefused(`${sp.id}: body size unknown or not positive (length ${L}, width ${w}); sizes come only from the candidate files and are never invented`);
    if (!(sp.free_speed_mm_s > 0) || !Number.isFinite(sp.free_speed_mm_s)) throw new Solver2DRefused(`${sp.id}: free speed must be positive`);
    if (sp.dir !== 1 && sp.dir !== -1) throw new Solver2DRefused(`${sp.id}: dir must be ±1`);
    const ln = lanes[li], segs = ln.segs, total = segs[segs.length - 1].s0 + segs[segs.length - 1].len;
    if (!(sp.s_mm >= 0 && sp.s_mm <= total && sp.goal_s_mm >= 0 && sp.goal_s_mm <= total) || (sp.goal_s_mm - sp.s_mm) * sp.dir < 0) throw new Solver2DRefused(`${sp.id}: start/goal inconsistent with lane ${sp.lane} (0–${total} mm, dir ${sp.dir})`);
    if (!(sp.start_t_s >= 0) || !Number.isFinite(sp.start_t_s)) throw new Solver2DRefused(`${sp.id}: start time`);
    const r = w / 2, hw = Math.max(0, L - w) / 2;
    // a joint the route crosses: an offset body would jump sideways under the laneBodyPose convention; how a body with u ≠ 0
    // follows a bend is a lateral-steering question (unknown, null) → refused, not invented
    const lo = Math.min(sp.s_mm, sp.goal_s_mm), hi = Math.max(sp.s_mm, sp.goal_s_mm);
    if (sp.u_mm !== 0 && segs.some((g, i) => i > 0 && g.s0 > lo && g.s0 < hi)) throw new Solver2DRefused(`${sp.id}: u = ${sp.u_mm} ≠ 0 and the route crosses a lane joint; following a bend with a lateral offset is not modelled (lateral steering model unknown)`);
    // at a joint the body already faces the segment it moves into
    const seg = sp.dir < 0 ? segAt(segs, sp.s_mm) : (() => { for (let i = segs.length - 1; i >= 0; i--) if (sp.s_mm >= segs[i].s0) return i; return 0; })();
    return { k, id: sp.id, spec: sp, laneIdx: li, layer: ln.layer, segs, u: sp.u_mm, dir: sp.dir, v0: sp.free_speed_mm_s, goal: sp.goal_s_mm, start: sp.start_t_s, hw, r, half: L / 2, seg, sRef: sp.s_mm, tRef: 0, v: 0, mode: 'waiting', geoStop: null, capped: null, turnBlocked: null, ver: 0, samples: [], arrival: null, stopCause: null, started: false, justStarted: false };
  });
  const headingOf = (a: RT, seg = a.seg) => Math.atan2(a.segs[seg].t.y * a.dir, a.segs[seg].t.x * a.dir);
  const eOf = (a: RT, seg = a.seg): Vec2 => ({ x: a.segs[seg].t.x * a.dir, y: a.segs[seg].t.y * a.dir });
  const sAt = (a: RT, t: number) => (a.v === 0 ? a.sRef : a.sRef + a.dir * a.v * (t - a.tRef));
  const centreAt = (a: RT, t: number) => poseOf(a.segs[a.seg], sAt(a, t), a.u);
  const capAt = (a: RT, t: number): Capsule => capsuleAt(centreAt(a, t), eOf(a), a.hw, a.r);
  const velOf = (a: RT): Vec2 => { const e = eOf(a); return { x: e.x * a.v, y: e.y * a.v }; };
  const staticOf = (a: RT): StaticSet => {
    const ln = lanes[a.laneIdx], ob = obsByLayer.get(a.layer) ?? { caps: [], arcs: [] };
    return { caps: [...ln.bnd.filter((b): b is Extract<Bnd, { kind: 'seg' }> => b.kind === 'seg').map((b) => ({ c: { a: b.p, b: b.q, r: 0 }, id: `lane-edge:${ln.spec.id}` })), ...ob.caps], arcs: ln.bnd.filter((b): b is Extract<Bnd, { kind: 'arc' }> => b.kind === 'arc').map((arc) => ({ arc, id: `lane-joint-edge:${ln.spec.id}` })) };
  };

  // ---- static route precompute: first position where the body would penetrate static geometry
  for (const a of A) {
    const S = staticOf(a);
    const c0 = capAt(a, 0), cl0 = staticClearance(S, c0);
    if (cl0.g < -OCC_TOL_MM) throw new Solver2DRefused(`${a.id}: start pose penetrates ${cl0.id} by ${-cl0.g} mm`);
    const cen0 = centreAt(a, 0);
    // exact lane region (bands, round joints, seams): the body centre must lie in it and no edge may be closer than the
    // radius (checked just above); a body reaching past a lane END lies partly in the node there (not modelled, allowed)
    if (!pointInLaneRegion(lanes[a.laneIdx].lane2, cen0)) throw new Solver2DRefused(`${a.id}: body centre outside the region of lane ${a.spec.lane}`);
    for (const P of polygons) if (layerIds.get(P.layer) === a.layer && insidePoly(cen0, P.points_mm)) throw new Solver2DRefused(`${a.id}: starts inside obstacle ${P.id}`);
    let s = a.spec.s_mm, seg = a.seg;
    for (;;) {
      const g = a.segs[seg], e = eOf(a, seg);
      const segEnd = a.dir > 0 ? g.s0 + g.len : g.s0, isLast = a.dir > 0 ? seg === a.segs.length - 1 : seg === 0;
      const runEnd = (a.goal - segEnd) * a.dir <= 0 || isLast ? a.goal : segEnd, dist = (runEnd - s) * a.dir;
      const cap = capsuleAt(poseOf(g, s, a.u), e, a.hw, a.r);
      let hit: { d: number; id: string } | null = null;
      for (const x of S.caps) { const h = pairFirstHit(cap, e, x.c, { x: 0, y: 0 }); if (h && h.tau <= dist && (!hit || h.tau < hit.d)) hit = { d: h.tau, id: x.id }; }
      if (S.arcs.length && dist > 0) {
        const gapArc = (lam: number) => { const c = capsuleAt(poseOf(g, s + a.dir * dist * lam, a.u), e, a.hw, a.r); let m = Infinity; for (const x of S.arcs) m = Math.min(m, segArcDist(c.a, c.b, x.arc) - c.r); return m; };
        const lam = advanceClear(gapArc, dist, HIT_TOL_MM);
        if (lam !== null && (!hit || lam * dist < hit.d)) hit = { d: lam * dist, id: S.arcs[0].id };
      }
      if (hit) { a.geoStop = { s: s + a.dir * hit.d, cause: `static geometry ${hit.id}` }; break; }
      if (runEnd === a.goal) break;
      // turning at the joint: instant rotation about the centre, checked by conservative advancement over the angle
      const th1 = headingOf(a, seg), nseg = seg + a.dir, th2 = headingOf(a, nseg), dth = wrapPi(th2 - th1), cen = poseOf(g, segEnd, a.u);
      const gapRot = (lam: number) => staticClearance(S, rotCapsule(cen, th1 + dth * lam, a.hw, a.r)).g;
      const rl = advanceClear(gapRot, a.hw * Math.abs(dth), HIT_TOL_MM);
      if (rl !== null) { a.geoStop = { s: segEnd, cause: `turn at the joint blocked by static geometry ${staticClearance(S, rotCapsule(cen, th1 + dth * rl, a.hw, a.r)).id}` }; break; }
      s = segEnd; seg = nseg;
    }
  }

  // ---- initial legality between bodies (same layer): refuse an overlapping start
  {
    const boxes = A.map((a) => { const c = centreAt(a, 0); return { minX: c.x - a.half, minY: c.y - a.half, maxX: c.x + a.half, maxY: c.y + a.half }; });
    for (const key of broadphasePairs(BP, boxes, A.map((a) => a.layer), CELL)) {
      const i = Math.floor(key / N), j = key % N, g = capsuleGap(capAt(A[i], 0), capAt(A[j], 0));
      if (g < -OCC_TOL_MM) throw new Solver2DRefused(`${A[i].id} and ${A[j].id} overlap at t = 0 by ${-g} mm`);
    }
  }

  // ---- event machinery
  const events: SolverEvent[] = [];
  const stats: Solver2DResult['stats'] = { batches: 0, events_processed: 0, queue_pushes: 0, stale_pops: 0, pair_hit_evals: 0, windows: 0, candidate_pairs_total: 0, candidate_pairs_max: 0, velocity_solves: 0, max_component: 0, max_same_instant_batches: 0, contacts: 0, releases: 0, passes: 0, turns: 0, turn_blocked: 0, stalled: 0, arrived: 0, unresolved: 0, aborted: null, t_end_s: 0 };
  const ev = (t: number, kind: string, ids: number[], cls: EventClass, detail: string | null = null) => events.push({ t_s: t, kind, agents: ids.map((i) => A[i].id), class: cls, detail });
  const heap = new Heap();
  const push = (e: QE) => { heap.push(e); stats.queue_pushes++; };
  const pkey = (i: number, j: number) => (i < j ? i * N + j : j * N + i);
  const pairVer = new Map<number, number>(), active = new Set<number>(), activeAdj: Set<number>[] = A.map(() => new Set());
  let cand = new Set<number>(), nb: number[][] = A.map(() => []);
  const processedContacts = new Set<string>();
  const sample = (a: RT, t: number) => {
    const c = centreAt(a, t), s = sAt(a, t), h = headingOf(a), last = a.samples[a.samples.length - 1];
    if (last && last[0] === t && last[1] === c.x && last[2] === c.y && last[3] === h) return;
    a.samples.push([t, c.x, c.y, h, s, a.u]);
  };
  for (const a of A) sample(a, 0);

  /** own next event of an agent (start, goal, static-geometry stop, joint) */
  const ownEvent = (a: RT) => {
    if (a.mode === 'waiting') { push({ t: a.start, kind: 'start', a: a.k, b: -1, va: a.ver, vb: 0, vp: 0 }); return; }
    if (a.mode !== 'active' || a.v === 0) return;
    const g = a.segs[a.seg], isLast = a.dir > 0 ? a.seg === a.segs.length - 1 : a.seg === 0;
    const targets: [number, QKind][] = [[a.goal, 'goal']];
    if (a.geoStop) targets.push([a.geoStop.s, 'geo']);
    if (!isLast) targets.push([a.dir > 0 ? g.s0 + g.len : g.s0, 'vertex']);
    let best: [number, QKind] | null = null;
    for (const [s, kind] of targets) { const d = (s - a.sRef) * a.dir; if (d < 0) continue; if (!best || d < (best[0] - a.sRef) * a.dir || (d === (best[0] - a.sRef) * a.dir && KIND_RANK[kind] < KIND_RANK[best[1]])) best = [s, kind]; }
    if (!best) return;
    push({ t: a.tRef + ((best[0] - a.sRef) * a.dir) / a.v, kind: best[1], a: a.k, b: -1, va: a.ver, vb: 0, vp: 0 });
  };
  /** pair events: contact (inactive), release (active), pass (same lane); all from the two motion records only */
  const pairEvents = (i: number, j: number, now: number) => {
    if (i > j) [i, j] = [j, i];
    const P = A[i], Q = A[j], key = i * N + j, vp = pairVer.get(key) ?? 0, T0 = Math.max(P.tRef, Q.tRef);
    if (P.layer !== Q.layer) return;
    const cP = capAt(P, T0), cQ = capAt(Q, T0), vP = velOf(P), vQ = velOf(Q);
    if (active.has(key)) {
      if (vP.x === vQ.x && vP.y === vQ.y) return;
      // release: the first (floating-point) time at which the SAME gap evaluation as the contact-membership test exceeds
      // ACTIVE_TOL_MM; the gap is convex in time and ≤ the threshold now, so its sublevel set is an interval
      const G = (t: number) => capsuleGap(capAt(P, t), capAt(Q, t)) - ACT;
      let lo = T0, hi = T0 + 1e-9, k = 0; while (G(hi) <= 0 && k++ < 200) hi = T0 + (hi - T0) * 2;
      if (G(hi) <= 0) return;
      for (let m = 0; m < 200 && hi - lo > 1e-15 * Math.max(1, hi); m++) { const x = (lo + hi) / 2; if (G(x) <= 0) lo = x; else hi = x; }
      let tr = hi; for (let m = 0; G(tr) <= 0 && m < 64; m++) tr = nextUp(tr);
      if (tr >= now) push({ t: tr, kind: 'release', a: i, b: j, va: P.ver, vb: Q.ver, vp });
    } else {
      stats.pair_hit_evals++;
      const h = pairFirstHit(cP, vP, cQ, vQ);
      if (h) {
        let tc = T0 + h.tau;
        if (h.overlapping || tc < now - 1e-12 * Math.max(1, now)) { stats.unresolved++; ev(now, 'unresolved', [i, j], 'solver_status', h.overlapping ? 'pair found overlapping when scheduled' : `missed contact at ${tc} < now ${now}`); tc = now; }
        push({ t: Math.max(tc, now), kind: 'contact', a: i, b: j, va: P.ver, vb: Q.ver, vp });
      }
    }
    if (P.laneIdx === Q.laneIdx) {
      const d0 = sAt(P, T0) - sAt(Q, T0), rate = P.dir * P.v - Q.dir * Q.v;
      if (rate !== 0 && d0 !== 0) { const tau = -d0 / rate; if (tau > 0) { const tp = T0 + tau; if (tp >= now) push({ t: tp, kind: 'pass', a: i, b: j, va: P.ver, vb: Q.ver, vp }); } }
    }
  };
  /** conservative swept box of an agent over [tw, tw + WIN]: its centre path at up to free speed, inflated by L/2 */
  const boxOf = (a: RT, tw: number): AABB => {
    const s0 = sAt(a, tw);
    let s1 = s0;
    if (a.mode !== 'arrived' && !a.capped) {
      s1 = s0 + a.dir * a.v0 * WIN;
      const lim = a.geoStop ? ((a.geoStop.s - a.goal) * a.dir < 0 ? a.geoStop.s : a.goal) : a.goal;
      if ((s1 - lim) * a.dir > 0) s1 = lim;
      if ((s1 - s0) * a.dir < 0) s1 = s0;
    }
    const lo = Math.min(s0, s1), hi = Math.max(s0, s1), pts: Vec2[] = [];
    for (let k = 0; k < a.segs.length; k++) {
      const g = a.segs[k], x0 = Math.max(lo, g.s0), x1 = Math.min(hi, g.s0 + g.len);
      if (x0 <= x1) pts.push(poseOf(g, x0, a.u), poseOf(g, x1, a.u));
    }
    if (!pts.length) pts.push(centreAt(a, tw));
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
    const m = a.half + 1e-9;
    return { minX: minX - m, minY: minY - m, maxX: maxX + m, maxY: maxY + m };
  };
  const windowUpdate = (tw: number) => {
    stats.windows++;
    const boxes = A.map((a) => boxOf(a, tw)), keys = A.map((a) => a.layer);
    input.observe_windows?.(tw, boxes, keys);
    const pairs = broadphasePairs(BP, boxes, keys, CELL);
    const next = new Set<number>(pairs), nnb: number[][] = A.map(() => []);
    for (const key of pairs) { const i = Math.floor(key / N), j = key % N; nnb[i].push(j); nnb[j].push(i); }
    for (const key of active) if (!next.has(key)) { stats.unresolved++; const i = Math.floor(key / N), j = key % N; ev(tw, 'unresolved', [i, j], 'solver_status', 'active contact outside the broad-phase candidates'); next.add(key); nnb[i].push(j); nnb[j].push(i); }
    for (const l of nnb) l.sort((x, y) => x - y);
    stats.candidate_pairs_total += next.size; stats.candidate_pairs_max = Math.max(stats.candidate_pairs_max, next.size);
    const added = pairs.filter((k) => !cand.has(k));
    cand = next; nb = nnb;
    for (const key of added) { pairVer.set(key, (pairVer.get(key) ?? 0) + 1); pairEvents(Math.floor(key / N), key % N, tw); }
  };

  // ---- velocity solve: greatest velocities with v ≤ free speed and dg/dt ≥ 0 for every touching pair
  const solveComponents = (seeds: number[], t: number): number[] => {
    const seen = new Set<number>(), changed: number[] = [];
    for (const s0 of [...seeds].sort((x, y) => x - y)) {
      if (seen.has(s0)) continue;
      const comp: number[] = [], stack = [s0]; seen.add(s0);
      while (stack.length) { const x = stack.pop()!; comp.push(x); for (const y of activeAdj[x]) if (!seen.has(y)) { seen.add(y); stack.push(y); } }
      comp.sort((x, y) => x - y);
      stats.velocity_solves++; stats.max_component = Math.max(stats.max_component, comp.length);
      const v = new Map<number, number>(), cap = new Map<number, number>();
      for (const x of comp) { const a = A[x]; const c = a.mode === 'active' && !a.capped && !a.turnBlocked ? a.v0 : 0; v.set(x, c); cap.set(x, c); }
      // constraints v_x ≤ c·v_y (y ≥ 0) or v_x ≤ 0 (y = −1); `o` is the contact partner (for the reported cause)
      const cons: { x: number; y: number; c: number; o: number }[] = [];
      for (const x of comp) for (const y of activeAdj[x]) if (x < y) {
        const P = A[x], Q = A[y], cp = capAt(P, t), cq = capAt(Q, t), [p, q] = closestSegSeg(cp.a, cp.b, cq.a, cq.b), d = Math.hypot(q.x - p.x, q.y - p.y);
        if (d === 0) { stats.unresolved++; ev(t, 'unresolved', [x, y], 'solver_status', 'body axes intersect: contact normal undefined'); cons.push({ x, y: -1, c: 0, o: y }, { x: y, y: -1, c: 0, o: x }); continue; }
        // n points from x to y; dg/dt = n·(e_y v_y − e_x v_x) = Aq·v_y − B·v_x must be ≥ 0
        const n = { x: (q.x - p.x) / d, y: (q.y - p.y) / d }, B = dotv(n, eOf(P)), Aq = dotv(n, eOf(Q));
        const pos = (z: number) => z > NORMAL_EPS, neg = (z: number) => z < -NORMAL_EPS;
        if (pos(B)) {
          if (pos(Aq)) cons.push({ x, y, c: Aq / B, o: y });               // x follows y
          else { cons.push({ x, y: -1, c: 0, o: y }); if (neg(Aq)) cons.push({ x: y, y: -1, c: 0, o: x }); }   // x stops (head-on: both)
        } else if (neg(B)) { if (neg(Aq)) cons.push({ x: y, y: x, c: B / Aq, o: x }); }   // y follows x
        else if (neg(Aq)) cons.push({ x: y, y: -1, c: 0, o: x });
      }
      // greatest fixed point of v_x = min(cap_x, min c·v_y): relaxation in product form (Bellman–Ford); a contracting cycle
      // (product of factors < 1) has the greatest solution 0
      const relax = () => { const ch: number[] = []; for (const k of cons) { const nv = k.y < 0 ? 0 : k.c * v.get(k.y)!; if (nv < v.get(k.x)!) { v.set(k.x, nv); ch.push(k.x); } } return ch; };
      let rounds = 0, ch = relax();
      while (ch.length) {
        if (++rounds > comp.length + 1) for (const x of ch) v.set(x, 0);
        if (rounds > 4 * comp.length + 10) { stats.unresolved++; ev(t, 'unresolved', comp.slice(0, 5), 'solver_status', 'velocity solve did not settle'); break; }
        ch = relax();
      }
      const causeOf = (x: number): string | null => {
        const a = A[x], nv = v.get(x)!;
        if (nv >= a.v0) return null;
        if (a.mode === 'waiting') return 'not started';
        if (a.mode === 'arrived') return 'arrived';
        if (a.capped) return a.capped;
        if (a.turnBlocked) return a.turnBlocked.cause;
        const k = cons.find((q) => q.x === x && (q.y < 0 ? nv === 0 : q.c * v.get(q.y)! === nv));
        return k ? (k.y < 0 ? `contact with ${A[k.o].id} would penetrate` : `following ${A[k.y].id}`) : nv === 0 ? 'contracting contact cycle' : null;
      };
      for (const x of comp) {
        const a = A[x], nv = v.get(x)!;
        if (nv === a.v) {
          if (a.justStarted && nv === 0) { a.stopCause = causeOf(x); ev(t, 'stop', [x], 'physical_constraint', `cannot move at its start: ${a.stopCause}`); }
          a.justStarted = false; continue;
        }
        const old = a.v; a.sRef = sAt(a, t); a.tRef = t; a.v = nv; a.ver++; sample(a, t); changed.push(x);
        const why = causeOf(x);
        if (nv === 0) { a.stopCause = why; ev(t, 'stop', [x], 'physical_constraint', why); }
        else if (old === 0 && a.started) ev(t, 'resume', [x], 'physical_constraint', nv < a.v0 ? `at ${nv} mm/s, ${why}` : null);
        else if (nv < a.v0) ev(t, 'follow', [x], 'physical_constraint', `at ${nv} mm/s, ${why}`);
        else if (old > 0) ev(t, 'free', [x], 'physical_constraint', null);
        if (nv > 0) { a.started = true; a.stopCause = null; }
        a.justStarted = false;
      }
    }
    return changed;
  };

  // ---- turning at a joint (instant rotation about the centre); joint check for all agents turning at this instant
  const tryTurns = (turners: number[], t: number): { done: number[]; blocked: Map<number, number[]> } => {
    const R = new Set(turners), blocked = new Map<number, number[]>();
    const th = new Map<number, [number, number, Vec2]>();
    for (const x of turners) { const a = A[x], th1 = headingOf(a), th2 = headingOf(a, a.seg + a.dir); th.set(x, [th1, wrapPi(th2 - th1), centreAt(a, t)]); }
    // rounds: every turner not yet blocked is checked against the others' current status (turning or held), until stable
    for (let again = true; again;) {
      again = false;
      for (const x of turners) {
        if (blocked.has(x)) continue;
        const a = A[x], [th1, dth, cen] = th.get(x)!, by: number[] = [];
        for (const y of nb[x]) {
          const b = A[y]; if (b.layer !== a.layer) continue;
          const yRot = R.has(y) && !blocked.has(y) ? th.get(y)! : null, cb0 = capAt(b, t);
          const gap = (lam: number) => capsuleGap(rotCapsule(cen, th1 + dth * lam, a.hw, a.r), yRot ? rotCapsule(yRot[2], yRot[0] + yRot[1] * lam, b.hw, b.r) : cb0);
          const K = a.hw * Math.abs(dth) + (yRot ? b.hw * Math.abs(yRot[1]) : 0);
          if (advanceClear(gap, K, OCC_TOL_MM / 2) !== null) by.push(y);
        }
        if (by.length) { blocked.set(x, by); again = true; }
      }
    }
    return { done: turners.filter((x) => !blocked.has(x)), blocked };
  };
  /** retry of a blocked turn: when every moving blocker has left the turning disc; stationary blockers: on their next change */
  const scheduleRetry = (x: number, t: number, blockers: number[]) => {
    const a = A[x], cen = centreAt(a, t);
    let tr = -Infinity, stationary = false;
    for (const y of blockers) {
      const b = A[y], cb = capAt(b, t), lim = a.half + b.r;
      if (b.v === 0) { stationary = true; continue; }
      const vb = velOf(b), d = { x: -vb.x, y: -vb.y }, D = (tau: number) => psd({ x: cen.x + d.x * tau, y: cen.y + d.y * tau }, cb.a, cb.b);
      const [, tmin] = featureMin(cen, d, cb.a, cb.b);
      let lo = tmin, hi = Math.max(tmin, 1e-9) * 2, k = 0; while (D(hi) < lim && k++ < 200) hi *= 2;
      for (let m = 0; m < 200 && hi - lo > 1e-15 * Math.max(1, hi); m++) { const q = (lo + hi) / 2; if (D(q) < lim) lo = q; else hi = q; }
      tr = Math.max(tr, t + hi);
    }
    a.turnBlocked!.blockers = blockers;
    if (!stationary && tr > -Infinity) push({ t: tr, kind: 'retry', a: x, b: -1, va: a.ver, vb: 0, vp: 0 });
  };
  const turnBlockedSet = new Set<number>();

  // ---- main loop
  windowUpdate(0);
  for (const a of A) ownEvent(a);
  let nextWin = WIN, lastT = -1, sameCount = 0;
  const processBatch = (t: number, batch: QE[]) => {
    const affected = new Set<number>(), turners: number[] = [], retries = new Set<number>(), firedPairs: number[] = [];
    const ver0 = new Map<number, number>();
    for (const e of batch) { ver0.set(e.a, A[e.a].ver); if (e.b >= 0) ver0.set(e.b, A[e.b].ver); }
    batch.sort((x, y) => (qLess(x, y) ? -1 : qLess(y, x) ? 1 : 0));
    for (const e of batch) {
      stats.events_processed++;
      const a = A[e.a];
      switch (e.kind) {
        case 'start': a.mode = 'active'; a.justStarted = true; ev(t, 'start', [e.a], 'motion'); affected.add(e.a); break;
        case 'goal': a.sRef = a.goal; a.tRef = t; a.v = 0; a.mode = 'arrived'; a.arrival = t; a.ver++; sample(a, t); stats.arrived++; ev(t, 'arrive', [e.a], 'motion'); affected.add(e.a); break;
        case 'geo': a.sRef = a.geoStop!.s; a.tRef = t; a.v = 0; a.capped = a.geoStop!.cause; a.ver++; sample(a, t); a.stopCause = a.capped; ev(t, 'stop', [e.a], 'physical_constraint', a.capped); affected.add(e.a); break;
        case 'vertex': { const g = a.segs[a.seg]; a.sRef = a.dir > 0 ? g.s0 + g.len : g.s0; a.tRef = t; a.ver++; turners.push(e.a); affected.add(e.a); break; }
        case 'retry': retries.add(e.a); break;
        case 'contact': {
          const k = `${e.a}|${e.b}|${pairVer.get(pkey(e.a, e.b))}|${e.va}|${e.vb}`;
          if (processedContacts.has(k)) throw Error(`SOLVER2D: contact ${k} executed twice (defect)`);
          processedContacts.add(k); affected.add(e.a); affected.add(e.b); firedPairs.push(pkey(e.a, e.b)); break;
        }
        case 'release': affected.add(e.a); affected.add(e.b); firedPairs.push(pkey(e.a, e.b)); break;
        case 'pass': { stats.passes++; ev(t, 'pass', [e.a, e.b], 'motion', `lateral offsets ${A[e.a].u} / ${A[e.b].u} mm`); break; }
      }
    }
    // retries of blocked turns
    for (const x of retries) { const a = A[x]; if (a.turnBlocked) { turners.push(x); affected.add(x); } }
    if (turners.length) {
      const uniq = [...new Set(turners)].sort((x, y) => x - y);
      const { done, blocked } = tryTurns(uniq, t);
      for (const x of done) {
        const a = A[x]; sample(a, t); a.seg += a.dir; a.ver++; stats.turns++; sample(a, t);
        if (a.turnBlocked) { a.turnBlocked = null; turnBlockedSet.delete(x); ev(t, 'turn', [x], 'motion', 'after waiting at the joint'); } else ev(t, 'turn', [x], 'motion', null);
      }
      for (const [x, by] of blocked) {
        const a = A[x];
        if (!a.turnBlocked) { stats.turn_blocked++; a.turnBlocked = { blockers: [], cause: `turn at the joint would penetrate ${by.map((y) => A[y].id).join(', ')}` }; a.sRef = sAt(a, t); a.tRef = t; a.v = 0; a.ver++; sample(a, t); a.stopCause = a.turnBlocked.cause; turnBlockedSet.add(x); ev(t, 'turn_blocked', [x], 'physical_constraint', a.turnBlocked.cause); }
        scheduleRetry(x, t, by);
      }
    }
    // contact membership of every candidate pair of an affected agent
    const membershipChanged: number[] = [];
    for (const x of [...affected].sort((p, q) => p - q)) {
      const cx = capAt(A[x], t);
      for (const y of nb[x]) {
        if (A[y].layer !== A[x].layer) continue;
        const key = pkey(x, y), g = capsuleGap(cx, capAt(A[y], t)), on = g <= ACT, was = active.has(key);
        if (on === was) continue;
        const i = Math.min(x, y), j = Math.max(x, y);
        if (on) { active.add(key); activeAdj[i].add(j); activeAdj[j].add(i); stats.contacts++; ev(t, 'contact_start', [i, j], 'physical_contact', g < -OCC_TOL_MM ? `overlap ${-g} mm (defect)` : null); if (g < -OCC_TOL_MM) stats.unresolved++; }
        else { active.delete(key); activeAdj[i].delete(j); activeAdj[j].delete(i); stats.releases++; ev(t, 'contact_end', [i, j], 'physical_contact'); }
        pairVer.set(key, (pairVer.get(key) ?? 0) + 1); membershipChanged.push(key);
      }
    }
    const seeds = new Set(affected); for (const key of membershipChanged) { seeds.add(Math.floor(key / N)); seeds.add(key % N); }
    for (const x of seeds) if (!ver0.has(x)) ver0.set(x, A[x].ver);
    const changed = solveComponents([...seeds], t);
    for (const x of changed) if (!ver0.has(x)) ver0.set(x, -1);
    // re-schedule: own and pair events of every agent whose motion record changed; pairs whose contact state changed or
    // whose event fired
    const moved = [...ver0].filter(([x, v0]) => A[x].ver !== v0).map(([x]) => x).sort((p, q) => p - q);
    const redo = new Set<number>([...membershipChanged, ...firedPairs]);
    for (const x of moved) { ownEvent(A[x]); for (const y of nb[x]) redo.add(pkey(x, y)); }
    for (const key of [...redo].sort((p, q) => p - q)) pairEvents(Math.floor(key / N), key % N, t);
    // a blocked turn retries when one of its blockers changes its motion
    if (moved.length && turnBlockedSet.size) {
      const ch = new Set(moved);
      for (const x of [...turnBlockedSet].sort((p, q) => p - q)) if (A[x].turnBlocked!.blockers.some((y) => ch.has(y))) push({ t, kind: 'retry', a: x, b: -1, va: A[x].ver, vb: 0, vp: 0 });
    }
  };

  for (;;) {
    if (stats.batches >= maxBatches) { stats.aborted = `max_batches ${maxBatches} reached`; break; }
    const top = heap.peek();
    const tNext = top ? top.t : Infinity;
    if (nextWin <= H && nextWin <= tNext) { windowUpdate(nextWin); nextWin = (stats.windows) * WIN; continue; }
    if (!top || top.t > H) break;
    const t = top.t, batch: QE[] = [];
    const inBatch = new Set<string>();
    while (heap.size && heap.peek()!.t === t) {
      const e = heap.pop()!, a = A[e.a];
      let valid = e.va === a.ver;
      if (e.b >= 0) { const b = A[e.b], key = pkey(e.a, e.b); valid = valid && e.vb === b.ver && e.vp === (pairVer.get(key) ?? 0) && cand.has(key); }
      if (e.kind === 'retry') valid = !!a.turnBlocked;
      if (e.kind === 'start') valid = valid && a.mode === 'waiting';
      const bk = `${e.kind}|${e.a}|${e.b}`;
      if (valid && !inBatch.has(bk)) { inBatch.add(bk); batch.push(e); } else stats.stale_pops++;
    }
    if (!batch.length) continue;
    if (t === lastT) { if (++sameCount > maxSame) { stats.aborted = `more than ${maxSame} batches at t = ${t} (Zeno guard)`; break; } } else { lastT = t; sameCount = 0; }
    stats.max_same_instant_batches = Math.max(stats.max_same_instant_batches, sameCount + 1);
    stats.batches++;
    processBatch(t, batch);
  }
  stats.t_end_s = H;
  const agents: Record<string, AgentOut> = {};
  for (const a of A) {
    sample(a, H);
    const mode = a.mode === 'arrived' ? 'arrived' : a.mode === 'waiting' ? 'not_started' : a.v > 0 ? 'moving' : a.capped ? 'stopped_by_geometry' : a.turnBlocked ? 'waiting_at_joint' : 'stopped_by_contact';
    if (mode.startsWith('stopped') || mode === 'waiting_at_joint') { stats.stalled++; ev(H, 'stalled', [a.k], 'solver_status', `${mode}${a.stopCause ? `: ${a.stopCause}` : ''}`); }
    agents[a.id] = { lane: a.spec.lane, layer: input.lanes[a.laneIdx].layer, samples: a.samples, arrival_t_s: a.arrival, final_mode: mode, final_speed_mm_s: a.v, stop_cause: a.stopCause, geometry_stop_s_mm: a.geoStop ? a.geoStop.s : null };
  }
  return { agents, events, stats };
}
