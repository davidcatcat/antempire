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

// ---------------------------------------------------------------- lane region (exact)
/*
 * LANE REGION (geometric convention, PH-3a r2; Owner P2 2026-11-07): the set of points within W/2 of the centerline,
 * with FLAT ends at the lane's two extremities = the union of one W-wide rectangle per straight segment and one disk of
 * radius W/2 at every interior vertex (a constant-width trail; round joints). Consecutive collinear segments are merged
 * first, so a vertex on a straight line is not a joint. The region beyond a lane end belongs to the node there (junction,
 * nest entrance), which this module does not model.
 * EXACT containment of a capsule C (axis S, radius r) in the closed region U: C ⊆ U ⟺ the axis midpoint is in U and no
 * point of ∂U is closer than r to S. (C is connected; a part of C outside U would make int C meet ∂U.) ∂U is computed
 * once per lane: every edge of every rectangle and every joint circle, minus the parts lying in the OPEN interior of
 * another piece; the remaining pieces are segments and circular arcs, and segment–segment / segment–arc distances are
 * exact. Former version: a body across a joint (even a collinear one) or a bend was reported 'not_checked' and counted
 * as a violation, so legal geometry was rejected.
 */
type Rect = { kind: 'rect'; a: Vec2; t: Vec2; n: Vec2; len: number; h: number };
type Disk = { kind: 'disk'; c: Vec2; R: number };
type Piece = Rect | Disk;
type Bnd = { kind: 'seg'; p: Vec2; q: Vec2 } | { kind: 'arc'; c: Vec2; R: number; th0: number; th1: number };
const TAU = 2 * Math.PI;
// cache keyed by the lane object AND checked against a content signature: a lane edited in place (narrowed, moved)
// is recomputed, never served from a stale entry (Owner P2 2026-11-07)
const regionCache = new WeakMap<Lane2, { sig: string; pieces: Piece[]; boundary: Bnd[] }>();
// String() keeps NaN / ±Infinity distinct (JSON.stringify would write all of them as null)
const laneSig = (l: Lane2) => [l.width_mm, ...l.centerline_mm.flatMap((p) => [p.x, p.y])].map((v) => String(v)).join('|');
/** offset used to tell an internal seam (lane on both sides) from a real edge: the contract tolerance */
const SEAM_DELTA_MM = OCC_TOL_MM;
/** a boundary point closer than this to another piece's edge is not 'covered' by that piece; the seam test decides */
const COVER_EPS = OCC_TOL_MM / 2;

/** open interval of τ ∈ ℝ with lo < f0 + τ f1 < hi (null if empty) */
function linOpen(f0: number, f1: number, lo: number, hi: number): [number, number] | null {
  if (f1 === 0) return f0 > lo && f0 < hi ? [-Infinity, Infinity] : null;
  let a = (lo - f0) / f1, b = (hi - f0) / f1; if (a > b) [a, b] = [b, a];
  return a < b ? [a, b] : null;
}
/** open set of θ with cos(θ − β) > k, as intervals inside [0, 2π) */
function cosArc(beta: number, k: number): [number, number][] {
  if (k >= 1) return [];
  if (k < -1) return [[0, TAU]];
  const w = Math.acos(k), lo = ((beta - w) % TAU + TAU) % TAU, hi = lo + 2 * w;
  return hi <= TAU ? [[lo, hi]] : [[lo, TAU], [0, hi - TAU]];
}
const intersectIv = (A: [number, number][], B: [number, number][]) => { const out: [number, number][] = []; for (const [a0, a1] of A) for (const [b0, b1] of B) { const lo = Math.max(a0, b0), hi = Math.min(a1, b1); if (lo < hi) out.push([lo, hi]); } return out; };
/** closed complement of a union of open intervals within [d0, d1]; pieces shorter than eps dropped */
function complementIv(open: [number, number][], d0: number, d1: number, eps: number): [number, number][] {
  const iv = open.map(([a, b]) => [Math.max(a, d0), Math.min(b, d1)] as [number, number]).filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = []; let cur = d0;
  for (const [a, b] of iv) { if (a > cur + eps) out.push([cur, a]); cur = Math.max(cur, b); }
  if (d1 > cur + eps) out.push([cur, d1]);
  return out;
}
const pt = (p: Vec2, d: Vec2, k: number): Vec2 => ({ x: p.x + d.x * k, y: p.y + d.y * k });

/** parameters where p + τ d crosses a boundary of K (each constraint separately; over-splitting is harmless) */
function segBreaks(p: Vec2, d: Vec2, K: Piece): number[] {
  const out: number[] = [];
  if (K.kind === 'rect') {
    const a0 = (p.x - K.a.x) * K.t.x + (p.y - K.a.y) * K.t.y, a1 = d.x * K.t.x + d.y * K.t.y, n0 = (p.x - K.a.x) * K.n.x + (p.y - K.a.y) * K.n.y, n1 = d.x * K.n.x + d.y * K.n.y;
    if (a1 !== 0) out.push(-a0 / a1, (K.len - a0) / a1);
    if (n1 !== 0) out.push((-K.h - n0) / n1, (K.h - n0) / n1);
  } else {
    const ex = p.x - K.c.x, ey = p.y - K.c.y, A = d.x * d.x + d.y * d.y, B = 2 * (ex * d.x + ey * d.y), C = ex * ex + ey * ey - K.R * K.R, D = B * B - 4 * A * C;
    if (A > 0 && D >= 0) out.push((-B - Math.sqrt(D)) / (2 * A), (-B + Math.sqrt(D)) / (2 * A));
  }
  return out;
}
/** angles where the circle c + R e(θ) crosses a boundary of K, in [0, 2π) */
function arcBreaks(c: Vec2, R: number, K: Piece): number[] {
  const out: number[] = [], add = (beta: number, k: number) => { if (k >= -1 && k <= 1) { const w = Math.acos(k); for (const th of [beta - w, beta + w]) out.push(((th % TAU) + TAU) % TAU); } };
  if (K.kind === 'rect') {
    const at = Math.atan2(K.t.y, K.t.x), an = Math.atan2(K.n.y, K.n.x), A0 = (c.x - K.a.x) * K.t.x + (c.y - K.a.y) * K.t.y, N0 = (c.x - K.a.x) * K.n.x + (c.y - K.a.y) * K.n.y;
    add(at, -A0 / R); add(at, (K.len - A0) / R); add(an, (-K.h - N0) / R); add(an, (K.h - N0) / R);
  } else {
    const dx = c.x - K.c.x, dy = c.y - K.c.y, dd = Math.hypot(dx, dy);
    if (dd > 0) add(Math.atan2(dy, dx) + Math.PI, -(K.R * K.R - R * R - dd * dd) / (2 * R * dd));
  }
  return out;
}
/** split [a, b] at the given points strictly inside it (pieces shorter than 1e-12 dropped) */
function splitAt(a: number, b: number, at: number[]): [number, number][] {
  const cuts = [a, ...at.filter((x) => x > a + 1e-12 && x < b - 1e-12).sort((x, y) => x - y), b], out: [number, number][] = [];
  for (let i = 1; i < cuts.length; i++) if (cuts[i] - cuts[i - 1] > 1e-12) out.push([cuts[i - 1], cuts[i]]);
  return out;
}
function laneRegion(l: Lane2): { pieces: Piece[]; boundary: Bnd[] } {
  const sig = laneSig(l), hit = regionCache.get(l); if (hit && hit.sig === sig) return hit;
  const h = (l.width_mm as number) / 2, raw = laneSegments(l), segs: typeof raw = [];
  for (const g of raw) {
    const last = segs[segs.length - 1];
    if (last && Math.abs(last.t.x * g.t.y - last.t.y * g.t.x) <= 1e-12 && last.t.x * g.t.x + last.t.y * g.t.y > 0) { const len = last.len + g.len; segs[segs.length - 1] = { ...last, b: g.b, len }; }
    else segs.push(g);
  }
  const pieces: Piece[] = segs.map((g) => ({ kind: 'rect', a: g.a, t: g.t, n: g.n, len: g.len, h }) as Rect);
  for (let i = 1; i < segs.length; i++) pieces.push({ kind: 'disk', c: segs[i].a, R: h });
  const boundary: Bnd[] = [];
  const inU = (q: Vec2) => pieces.some((K) => inPiece(q, K, 0));
  const segOpenIn = (p: Vec2, d: Vec2, K: Piece): [number, number] | null => {   // τ-interval of p + τ d in int K
    if (K.kind === 'rect') {
      // interior shrunk by COVER_EPS: a point within rounding distance of K's edge is NOT treated as covered; the seam
      // test decides (two coincident antiparallel bands must not erase each other's sides)
      const al = linOpen((p.x - K.a.x) * K.t.x + (p.y - K.a.y) * K.t.y, d.x * K.t.x + d.y * K.t.y, COVER_EPS, K.len - COVER_EPS);
      const la = linOpen((p.x - K.a.x) * K.n.x + (p.y - K.a.y) * K.n.y, d.x * K.n.x + d.y * K.n.y, -K.h + COVER_EPS, K.h - COVER_EPS);
      if (!al || !la) return null; const lo = Math.max(al[0], la[0]), hi = Math.min(al[1], la[1]); return lo < hi ? [lo, hi] : null;
    }
    const Rin = K.R - COVER_EPS, ex = p.x - K.c.x, ey = p.y - K.c.y, A = d.x * d.x + d.y * d.y, B = 2 * (ex * d.x + ey * d.y), C = ex * ex + ey * ey - Rin * Rin, D = B * B - 4 * A * C;
    if (A === 0 || D <= 0 || Rin <= 0) return null; const sq = Math.sqrt(D); return [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  };
  const arcOpenIn = (c: Vec2, R: number, K: Piece): [number, number][] => {        // θ-set of c + R e(θ) in int K
    if (K.kind === 'rect') {
      const at = Math.atan2(K.t.y, K.t.x), an = Math.atan2(K.n.y, K.n.x);
      const A0 = (c.x - K.a.x) * K.t.x + (c.y - K.a.y) * K.t.y, N0 = (c.x - K.a.x) * K.n.x + (c.y - K.a.y) * K.n.y;
      // A0 + R cos(θ − at) ∈ (0, len), N0 + R cos(θ − an) ∈ (−h, h)
      const e = COVER_EPS;
      let s4 = cosArc(at, (e - A0) / R); s4 = intersectIv(s4, cosArc(at + Math.PI, (A0 - K.len + e) / R));
      s4 = intersectIv(s4, cosArc(an + Math.PI, (N0 - K.h + e) / R)); return intersectIv(s4, cosArc(an, (-K.h + e - N0) / R));
    }
    const dx = c.x - K.c.x, dy = c.y - K.c.y, dd = Math.hypot(dx, dy);
    if (dd === 0) return [];
    // |d + R e|² < K.R² ⟺ cos(θ − ∠d) < (K.R² − R² − dd²) / (2 R dd)
    const Rin = K.R - COVER_EPS; if (Rin <= 0) return [];
    return cosArc(Math.atan2(dy, dx) + Math.PI, -(Rin * Rin - R * R - dd * dd) / (2 * R * dd));
  };
  pieces.forEach((P, i) => {
    const others = pieces.filter((_, j) => j !== i);
    if (P.kind === 'rect') {
      const c = [pt(pt(P.a, P.n, P.h), P.t, 0), pt(pt(P.a, P.n, P.h), P.t, P.len), pt(pt(P.a, P.n, -P.h), P.t, P.len), pt(pt(P.a, P.n, -P.h), P.t, 0)];
      for (let e = 0; e < 4; e++) {
        const p = c[e], q = c[(e + 1) % 4], d = { x: q.x - p.x, y: q.y - p.y };
        const cov = others.map((K) => segOpenIn(p, d, K)).filter((x): x is [number, number] => x !== null);
        const len = Math.hypot(d.x, d.y), nrm = { x: -d.y / len, y: d.x / len }, brk = others.flatMap((K) => segBreaks(p, d, K));
        for (const [a, b] of complementIv(cov, 0, 1, 1e-12)) for (const [u, v] of splitAt(a, b, brk)) {
          const m = pt(p, d, (u + v) / 2);
          if (inU(pt(m, nrm, SEAM_DELTA_MM)) && inU(pt(m, nrm, -SEAM_DELTA_MM))) continue;   // internal seam: lane on both sides
          boundary.push({ kind: 'seg', p: pt(p, d, u), q: pt(p, d, v) });
        }
      }
    } else {
      const cov = others.flatMap((K) => arcOpenIn(P.c, P.R, K));
      const free = complementIv(cov, 0, TAU, 1e-12);
      if (free.length > 1 && free[0][0] === 0 && free[free.length - 1][1] === TAU) { const last = free.pop()!; free[0] = [last[0], free[0][1] + TAU]; }
      const brk = others.flatMap((K) => arcBreaks(P.c, P.R, K));
      for (const [a, b] of free) {
        const extra = brk.flatMap((x) => [x, x + TAU]);   // free arcs may be unwrapped past 2π
        for (const [u, v] of splitAt(a, b, extra)) {
          const th = (u + v) / 2, e = { x: Math.cos(th), y: Math.sin(th) }, m = pt(P.c, e, P.R);
          if (inU(pt(m, e, SEAM_DELTA_MM)) && inU(pt(m, e, -SEAM_DELTA_MM))) continue;
          boundary.push({ kind: 'arc', c: P.c, R: P.R, th0: u, th1: v });
        }
      }
    }
  });
  const out = { sig, pieces, boundary }; regionCache.set(l, out); return out;
}
const inArc = (phi: number, th0: number, th1: number) => (((phi - th0) % TAU) + TAU) % TAU <= th1 - th0 + 1e-15;
function pointArcDist(p: Vec2, c: Vec2, R: number, th0: number, th1: number): number {
  const dx = p.x - c.x, dy = p.y - c.y, d = Math.hypot(dx, dy);
  if (d > 0 && inArc(Math.atan2(dy, dx), th0, th1)) return Math.abs(d - R);
  if (d === 0) return R;
  const e = (th: number) => Math.hypot(p.x - c.x - R * Math.cos(th), p.y - c.y - R * Math.sin(th));
  return Math.min(e(th0), e(th1));
}
/** exact distance from segment AB to an arc (candidates: endpoints both ways, crossings, the foot of the centre) */
function segArcDist(A: Vec2, B: Vec2, arc: Extract<Bnd, { kind: 'arc' }>): number {
  const { c, R, th0, th1 } = arc, end = (th: number) => ({ x: c.x + R * Math.cos(th), y: c.y + R * Math.sin(th) });
  let best = Math.min(pointArcDist(A, c, R, th0, th1), pointArcDist(B, c, R, th0, th1), pointSegment2D(end(th0), A, B).d, pointSegment2D(end(th1), A, B).d);
  const d = { x: B.x - A.x, y: B.y - A.y }, ex = A.x - c.x, ey = A.y - c.y, a2 = d.x * d.x + d.y * d.y;
  if (a2 > 0) {
    const b2 = 2 * (ex * d.x + ey * d.y), c2 = ex * ex + ey * ey - R * R, D = b2 * b2 - 4 * a2 * c2;
    if (D >= 0) for (const tau of [(-b2 - Math.sqrt(D)) / (2 * a2), (-b2 + Math.sqrt(D)) / (2 * a2)]) if (tau >= 0 && tau <= 1) { const x = pt(A, d, tau); if (inArc(Math.atan2(x.y - c.y, x.x - c.x), th0, th1)) best = 0; }
    const tq = Math.min(1, Math.max(0, -(ex * d.x + ey * d.y) / a2)); best = Math.min(best, pointArcDist(pt(A, d, tq), c, R, th0, th1));
  }
  return best;
}
const inPiece = (p: Vec2, K: Piece, tol: number) => {
  if (K.kind === 'disk') return Math.hypot(p.x - K.c.x, p.y - K.c.y) <= K.R + tol;
  const al = (p.x - K.a.x) * K.t.x + (p.y - K.a.y) * K.t.y, la = (p.x - K.a.x) * K.n.x + (p.y - K.a.y) * K.n.y;
  return al >= -tol && al <= K.len + tol && Math.abs(la) <= K.h + tol;
};

/**
 * Is a capsule inside the lane region (exact; see LANE REGION above)? Unknown width: not checked (never accepted).
 * A body extending past a lane END is outside THIS region (the part beyond lies in the node); checkOccupancy2D reports
 * such bodies as not_checked, not as violations.
 */
export function capsuleInLane(l: Lane2, c: Capsule, tol = OCC_TOL_MM): { inside: boolean; checked: boolean; why?: string } {
  if (typeof l.width_mm !== 'number') return { inside: false, checked: false, why: `lane ${l.id} width unknown` };
  const { pieces, boundary } = laneRegion(l), mid = { x: (c.a.x + c.b.x) / 2, y: (c.a.y + c.b.y) / 2 };
  if (!pieces.some((K) => inPiece(mid, K, tol))) return { inside: false, checked: true, why: 'body centre outside the lane region' };
  let dmin = Infinity;
  for (const b of boundary) dmin = Math.min(dmin, b.kind === 'seg' ? segmentSegment2D(c.a, c.b, b.p, b.q) : segArcDist(c.a, c.b, b));
  return dmin >= c.r - tol ? { inside: true, checked: true } : { inside: false, checked: true, why: `lane edge ${dmin} mm from the body axis < radius ${c.r} mm (protrudes ${c.r - dmin} mm)` };
}

export interface OccupancyViolation { kind: 'outside_lane' | 'overlap'; ids: string[]; detail: string }
export interface OccupancyResult {
  /** true: proven legal; false: at least one violation; null: no violation found but some body could not be checked */
  valid: boolean | null;
  violations: OccupancyViolation[];
  /** bodies the contract cannot judge (unknown lane width; body extending past a lane end into the node): NOT violations */
  not_checked: { ids: string[]; detail: string }[];
}
/**
 * 2-D occupancy contract for one instant: every body lies inside its lane region, and no two bodies of the SAME layer
 * (default: same lane) overlap. An exclusion proof for the given lateral positions. Bodies that cannot be judged are
 * listed separately (not_checked) and make the result null, never false: they are not evidence of a violation.
 */
export function checkOccupancy2D(lanes: Lane2[], bodies: LaneBody[], tol = OCC_TOL_MM): OccupancyResult {
  const byId = new Map(lanes.map((l) => [l.id, l])), violations: OccupancyViolation[] = [], not_checked: OccupancyResult['not_checked'] = [];
  const caps = bodies.map((b) => { const l = byId.get(b.lane); if (!l) throw Error(`BODY2D: lane ${b.lane} unknown`); return { b, l, c: capsuleOf(laneBodyPose(l, b), b.body) }; });
  for (const { b, l, c } of [...caps].sort((x, y) => (x.b.id < y.b.id ? -1 : 1))) {
    const half = (b.body.length_mm as number) / 2, total = laneLength2(l);
    if (b.s_mm - half < -tol || b.s_mm + half > total + tol) { not_checked.push({ ids: [b.id], detail: `body extends past an end of lane ${l.id} (s ${b.s_mm} ± ${half} mm, lane 0–${total} mm) into the node: node geometry not modelled` }); continue; }
    const r = capsuleInLane(l, c, tol);
    if (!r.checked) not_checked.push({ ids: [b.id], detail: r.why ?? '' }); else if (!r.inside) violations.push({ kind: 'outside_lane', ids: [b.id], detail: r.why ?? '' });
  }
  const sorted = [...caps].sort((x, y) => (x.b.id < y.b.id ? -1 : 1));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const p = sorted[i], q = sorted[j];
    if ((p.b.layer ?? p.b.lane) !== (q.b.layer ?? q.b.lane)) continue;
    const g = capsuleGap(p.c, q.c);
    if (g < -tol) violations.push({ kind: 'overlap', ids: [p.b.id, q.b.id], detail: `interpenetration ${(-g).toExponential(3)} mm` });
  }
  return { valid: violations.length ? false : not_checked.length ? null : true, violations, not_checked };
}

export interface PackItem { s_mm: number; length_mm: number | null; width_mm: number | null }
/** largest n for which lateralPacking searches exhaustively (n! orderings, pruned); larger inputs return null */
export const PACK_EXACT_MAX = 9;
/**
 * Exact lateral packing on ONE straight section: can bodies at arc positions sᵢ (heading along the section, so all
 * parallel) be given lateral offsets uᵢ so that every capsule lies in the band (|uᵢ| ≤ W/2 − rᵢ) and no two overlap?
 * Two parallel capsules with axis intervals whose along-gap is d need |uᵢ − uⱼ| ≥ sᵢⱼ = √max(0, (rᵢ + rⱼ)² − d²).
 * Former criterion Σwᵢ ≤ W (Owner P2 2026-11-07) is exact only when every pair's AXES overlap along the lane (d = 0); for
 * bodies offset along the lane the rounded ends need less lateral room, and Σw wrongly rejected legal arrangements.
 * Search: any feasible assignment sorted by u gives an ordering; for a fixed ordering the least placement
 * u_k = max(−h_k, max_{j before k} u_j + s_jk) is optimal (difference constraints), so trying every ordering (depth-first,
 * pruned when a body cannot fit) is exact. Returns a witness when feasible; null with a reason when sizes or the width are
 * unknown or n > PACK_EXACT_MAX.
 */
export function lateralPacking(items: PackItem[], laneWidth: number | null, tol = OCC_TOL_MM): { feasible: boolean | null; u: number[] | null; why?: string } {
  if (typeof laneWidth !== 'number') return { feasible: null, u: null, why: 'lane width unknown' };
  if (items.some((b) => typeof b.length_mm !== 'number' || typeof b.width_mm !== 'number')) return { feasible: null, u: null, why: 'body size unknown' };
  const n = items.length;
  if (n > PACK_EXACT_MAX) return { feasible: null, u: null, why: `n = ${n} > ${PACK_EXACT_MAX}: exhaustive search not attempted` };
  const r = items.map((b) => (b.width_mm as number) / 2), hw = items.map((b) => Math.max(0, (b.length_mm as number) - (b.width_mm as number)) / 2);
  const hmax = r.map((ri) => laneWidth / 2 - ri);
  if (hmax.some((x) => x < -tol)) return { feasible: false, u: null };
  // touching within tol is contact, not overlap (as in checkOccupancy2D); half the tolerance keeps the witness inside it after rounding
  const sep = (i: number, j: number) => { const d = Math.max(0, Math.abs(items[i].s_mm - items[j].s_mm) - hw[i] - hw[j]), rr = r[i] + r[j] - tol / 2; return d >= rr ? 0 : Math.sqrt(rr * rr - d * d); };
  const S = items.map((_, i) => items.map((_, j) => (i === j ? 0 : sep(i, j))));
  const u = new Array<number>(n), used = new Array<boolean>(n).fill(false), order: number[] = [];
  const dfs = (): boolean => {
    if (order.length === n) return true;
    for (let k = 0; k < n; k++) if (!used[k]) {
      let x = -hmax[k]; for (const j of order) x = Math.max(x, u[j] + S[j][k]);
      if (x > hmax[k] + tol) continue;
      used[k] = true; order.push(k); u[k] = x;
      if (dfs()) return true;
      used[k] = false; order.pop();
    }
    return false;
  };
  return dfs() ? { feasible: true, u: [...u] } : { feasible: false, u: null };
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
