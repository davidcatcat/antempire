/**
 * PH-3a (2-D occupancy contract; docs/physics-2d-occupancy-contract.md): exact, pure 2-D geometry of ant bodies for the
 * ISOLATED physics experiments. Not used by simulate() or by the daily simulation (tests/physics-isolation.test.ts).
 *
 *  - A body is a CAPSULE: the segment of length max(0, L − w) along the heading, inflated by radius w/2 (L = body length,
 *    w = effective collision width, both from the body-candidate files). The capsule outline is a MODEL ASSUMPTION
 *    (game assumption): the real outline of a P. megacephala worker is not a capsule, and antennae / legs are excluded.
 *  - A body in a lane has an arc coordinate s, a lateral offset u (left of the travel direction of the centerline is
 *    positive) and a direction. The lane has a centerline polyline and a width W. The 1-D model of PH-2 has no u; this
 *    module is the contract a solver with lateral positions must satisfy. HOW ants choose u is NOT modelled here (no
 *    species data; candidate models only).
 *  - Only bodies in the same collidable space interact (same layer); the caller decides which pairs share a space.
 *  - Unknown sizes are refused, never defaulted.
 * Units: mm, s. All functions are exact up to floating point; tolerances are explicit arguments or named constants.
 */
import { type Vec2, pointSegment2D, segmentSegment2D } from './vec.ts';

/** length tolerance of the contract checks (mm): numerical, far below any body size; not a model parameter */
export const OCC_TOL_MM = 1e-9;

export interface Capsule { a: Vec2; b: Vec2; r: number }
export interface BodySize { length_mm: number | null; width_mm: number | null }
export interface Pose2 { x: number; y: number; heading_rad: number }

/** Capsule of a body at a pose. Refuses unknown or non-positive sizes (unknowns are never defaulted). */
export function capsuleOf(pose: Pose2, body: BodySize): Capsule {
  const L = body.length_mm, w = body.width_mm;
  if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0) || !(w > 0)) throw Error(`BODY2D: body size unknown or not positive (length ${L}, width ${w})`);
  const half = Math.max(0, L - w) / 2, cx = Math.cos(pose.heading_rad), cy = Math.sin(pose.heading_rad);
  return { a: { x: pose.x - cx * half, y: pose.y - cy * half }, b: { x: pose.x + cx * half, y: pose.y + cy * half }, r: w / 2 };
}

/** Exact separation of two capsules: segment–segment distance minus both radii (negative = interpenetration depth). */
export const capsuleGap = (p: Capsule, q: Capsule): number => segmentSegment2D(p.a, p.b, q.a, q.b) - p.r - q.r;

/** Do two capsules overlap by more than tol? Touching (gap within ±tol) is contact, not overlap. */
export const capsulesOverlap = (p: Capsule, q: Capsule, tol = OCC_TOL_MM): boolean => capsuleGap(p, q) < -tol;

// ---------------------------------------------------------------- lanes (centerline + width), straight segments
export interface Lane2 { id: string; centerline_mm: Vec2[]; width_mm: number | null }
export interface LaneBody { id: string; lane: string; s_mm: number; u_mm: number; dir: 1 | -1; body: BodySize; layer?: string }

function laneSegments(l: Lane2) {
  const out: { a: Vec2; b: Vec2; s0: number; len: number; t: Vec2; n: Vec2 }[] = [];
  let s0 = 0;
  for (let i = 1; i < l.centerline_mm.length; i++) {
    const a = l.centerline_mm[i - 1], b = l.centerline_mm[i], len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    const t = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
    out.push({ a, b, s0, len, t, n: { x: -t.y, y: t.x } }); s0 += len;
  }
  if (!out.length) throw Error(`BODY2D: lane ${l.id} has no length`);
  return out;
}
export const laneLength2 = (l: Lane2): number => laneSegments(l).reduce((q, s) => q + s.len, 0);

/** Pose of a lane body: centerline point at s, offset u along the left normal, heading along the travel direction. */
export function laneBodyPose(l: Lane2, b: LaneBody): Pose2 {
  const segs = laneSegments(l), total = segs[segs.length - 1].s0 + segs[segs.length - 1].len;
  if (!(b.s_mm >= -OCC_TOL_MM && b.s_mm <= total + OCC_TOL_MM)) throw Error(`BODY2D: ${b.id} s=${b.s_mm} outside lane ${l.id} [0, ${total}]`);
  const seg = segs.find((g) => b.s_mm <= g.s0 + g.len + OCC_TOL_MM) ?? segs[segs.length - 1], f = b.s_mm - seg.s0;
  const c = { x: seg.a.x + seg.t.x * f + seg.n.x * b.u_mm, y: seg.a.y + seg.t.y * f + seg.n.y * b.u_mm };
  return { x: c.x, y: c.y, heading_rad: Math.atan2(seg.t.y * b.dir, seg.t.x * b.dir) };
}

/**
 * Is a capsule inside a STRAIGHT lane segment's band (|lateral offset| + r ≤ W/2 at both axis ends, along-lane extent
 * within the segment)? For a straight band the lateral offset is affine along the axis, so checking the two axis ends is
 * exact. Polyline lanes: each body must lie within one straight segment (bodies across a bend are reported as
 * 'not checked', never silently accepted).
 */
export function capsuleInLane(l: Lane2, c: Capsule, tol = OCC_TOL_MM): { inside: boolean; checked: boolean; why?: string } {
  if (typeof l.width_mm !== 'number') return { inside: false, checked: false, why: `lane ${l.id} width unknown` };
  const W2 = l.width_mm / 2;
  for (const g of laneSegments(l)) {
    const along = (p: Vec2) => (p.x - g.a.x) * g.t.x + (p.y - g.a.y) * g.t.y, lat = (p: Vec2) => (p.x - g.a.x) * g.n.x + (p.y - g.a.y) * g.n.y;
    const sa = along(c.a), sb = along(c.b);
    if (Math.min(sa, sb) - c.r < -tol || Math.max(sa, sb) + c.r > g.len + tol) continue;   // not (entirely) within this segment
    const ok = Math.abs(lat(c.a)) + c.r <= W2 + tol && Math.abs(lat(c.b)) + c.r <= W2 + tol;
    return ok ? { inside: true, checked: true } : { inside: false, checked: true, why: `lateral extent ${Math.max(Math.abs(lat(c.a)), Math.abs(lat(c.b))) + c.r} mm > half width ${W2} mm` };
  }
  return { inside: false, checked: false, why: 'body spans a bend or a lane end: not checked by the straight-band contract' };
}

export interface OccupancyViolation { kind: 'outside_lane' | 'not_checked' | 'overlap'; ids: string[]; detail: string }
/**
 * 2-D occupancy contract for one instant: every body lies inside its lane band, and no two bodies of the SAME layer
 * (default: same lane) overlap. Unlike the 1-D pairwise width test this is an exclusion proof for the given lateral
 * positions: a state that cannot be laid out side by side fails here whatever the u values.
 */
export function checkOccupancy2D(lanes: Lane2[], bodies: LaneBody[], tol = OCC_TOL_MM): OccupancyViolation[] {
  const byId = new Map(lanes.map((l) => [l.id, l])), out: OccupancyViolation[] = [];
  const caps = bodies.map((b) => { const l = byId.get(b.lane); if (!l) throw Error(`BODY2D: lane ${b.lane} unknown`); return { b, l, c: capsuleOf(laneBodyPose(l, b), b.body) }; });
  for (const { b, l, c } of caps) { const r = capsuleInLane(l, c, tol); if (!r.inside) out.push({ kind: r.checked ? 'outside_lane' : 'not_checked', ids: [b.id], detail: r.why ?? '' }); }
  const sorted = [...caps].sort((x, y) => (x.b.id < y.b.id ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const p = sorted[i], q = sorted[j];
    if ((p.b.layer ?? p.b.lane) !== (q.b.layer ?? q.b.lane)) continue;
    const g = capsuleGap(p.c, q.c);
    if (g < -tol) out.push({ kind: 'overlap', ids: [p.b.id, q.b.id], detail: `interpenetration ${(-g).toExponential(3)} mm` });
  }
  return out;
}

/**
 * Exact lateral packing on a straight section: can bodies whose along-lane extents share a common point be placed
 * side by side (parallel, non-overlapping, inside the band)? For parallel capsules of widths wᵢ in a band of width W the
 * answer is Σwᵢ ≤ W (stack them edge to edge). Returns the feasibility and, when feasible, one witness assignment of u.
 */
export function lateralPacking(widths: number[], laneWidth: number | null, tol = OCC_TOL_MM): { feasible: boolean | null; u: number[] | null; need: number } {
  const need = widths.reduce((q, w) => q + w, 0);
  if (typeof laneWidth !== 'number') return { feasible: null, u: null, need };            // unknown width: unknown
  if (need > laneWidth + tol) return { feasible: false, u: null, need };
  const u: number[] = []; let edge = -laneWidth / 2;
  for (const w of widths) { u.push(edge + w / 2); edge += w; }
  return { feasible: true, u, need };
}

/**
 * Continuous (swept) contact for two capsules translating with constant velocities over [0, horizon] (no rotation):
 * the first time their gap reaches 0 (a closest approach within tol counts as touching). The gap g(t) = dist(A, B + t·(v_q − v_p)) − r_p − r_q is CONVEX in t
 * (distance between convex sets under a linear relative translation), so: find its minimum on [0, horizon] by ternary
 * search; if the minimum stays above tol there is no contact; otherwise bisect [0, t_min] for the first root. No step
 * size, no tunnelling at any speed, and grazing approaches terminate. Already overlapping at t = 0 returns 0.
 */
export function sweptCapsuleContact(p: Capsule, vp: Vec2, q: Capsule, vq: Vec2, horizon_s: number, tol = OCC_TOL_MM): number | null {
  const at = (c: Capsule, v: Vec2, t: number): Capsule => ({ a: { x: c.a.x + v.x * t, y: c.a.y + v.y * t }, b: { x: c.b.x + v.x * t, y: c.b.y + v.y * t }, r: c.r });
  const g = (t: number) => capsuleGap(at(p, vp, t), at(q, vq, t));
  if (g(0) <= 0) return 0;
  let lo = 0, hi = horizon_s;
  for (let k = 0; k < 200 && hi - lo > 1e-15 * Math.max(1, horizon_s); k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) <= g(m2)) hi = m2; else lo = m1; }
  const tmin = (lo + hi) / 2, gmin = Math.min(g(tmin), g(horizon_s)), tAtMin = g(tmin) <= g(horizon_s) ? tmin : horizon_s;
  if (gmin > tol) return null;                                   // never closer than tol: no contact
  if (gmin > 0) return tAtMin;                                   // grazing within tol: touching at the closest approach
  // the first root of g = 0 (not of g = tol: the contact time is not advanced by tol / v_rel)
  let a = 0, b = tAtMin;                                          // g(a) > 0, g(b) <= 0; convexity: g decreasing on [0, b]
  for (let k = 0; k < 200 && b - a > 1e-15 * Math.max(1, b); k++) { const m = (a + b) / 2; if (g(m) <= 0) b = m; else a = m; }
  return b;
}

/** Distance from a point to a capsule surface (negative inside); exposed for checks and antenna-reach tests. */
export const pointCapsuleGap = (p: Vec2, c: Capsule): number => pointSegment2D(p, c.a, c.b).d - c.r;
