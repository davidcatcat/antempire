/**
 * KIN-2D (Issue #157; docs/physics-kinematics2d.md): an ISOLATED 2-D rigid-body kinematics module for ant bodies with a
 * real orientation. Not used by simulate(), not used by the daily simulation and not imported by solver2d.ts or any
 * official module (tests/physics-isolation.test.ts). It does not read food, crops, brood or populations.
 *
 * Model (physical / geometric only; every motion parameter is a scenario input, never a species value):
 *  - a body is a rigid CAPSULE (segment of length max(0, L − w) along the heading, inflated by w/2; same contract as
 *    body2d.ts PH-3a). Its pose is (x, y, θ) of the body centre; the collision shape ROTATES with θ (no sprite-only turn).
 *  - motion is a piecewise-constant body-frame TWIST: forward speed v, lateral speed vl (left +), angular rate ω.
 *    With a constant twist the centre moves on an exact circular arc of curvature κ = ω / v (straight line if ω = 0,
 *    turn in place if v = vl = 0). Poses are evaluated in CLOSED FORM from the segment's start pose (no stepping).
 *  - breakpoints (segment times) are fixed when the plan is built; the solver never re-accumulates time.
 *  - continuous collision detection against walls / discs / polygons and other bodies, INCLUDING rotation, by
 *    CONSERVATIVE ADVANCEMENT on the exact capsule distance g(t): within one segment every point of the core segment
 *    moves at most M = hypot(v, vl) + |ω|·h (h = half core length), so |dg/dt| ≤ M_A + M_B and a step of (g − λ)/M can
 *    never cross the level λ. Guarantee: g(t) > λ − (float noise) for every t before a reported contact; at the
 *    reported contact time g ≤ θ. No time step, no tunnelling.
 *  - response at contact (a PHYSICAL CONSTRAINT, not a behaviour): a body whose own motion does not clearly increase the
 *    gap (own gap rate ≤ SEPARATING_RATE) is stopped and holds its pose until the horizon; a body moving away keeps its
 *    plan. What an ant does after a contact (wait, back off, turn, antennate) is unknown for this species and is NOT
 *    modelled. Restarts exist only as explicit plan segments.
 *  - the horizon is a processed instant of zero length: events at t ≤ H are processed, nothing moves after H; plan
 *    events within TIME_TOL(H) after H count as at H (time contract principle 5). Results up to H₁ are a prefix of the
 *    results up to H₂ > H₁.
 *  - determinism and input-order invariance: pairs are keyed by sorted ids; simultaneous contacts are resolved together
 *    with the pre-response velocities (Jacobi), so array order never matters.
 * Units: mm, s, rad. Tolerances below are NUMERICAL, not model parameters.
 */

export interface P2 { x: number; y: number }
export interface Pose { x: number; y: number; th: number }
/** body-frame twist: forward speed v (mm/s), lateral speed vl (mm/s, left +), angular rate w (rad/s, CCW +) */
export interface Twist { v: number; vl: number; w: number }
export interface BodyDims { length_mm: number | null; width_mm: number | null }
/** one constant-twist segment on [t0, t1); t1 may be Infinity (hold to the end) */
export interface Seg { t0: number; t1: number; p0: Pose; tw: Twist; label: string }
export interface Track { id: string; body: BodyDims; layer?: string; segs: Seg[] }

/** contact band: a pair is "in contact" when gap ≤ CONTACT_TOL_MM (numerical; same size as PH-3b ACTIVE_TOL_MM) */
export const CONTACT_TOL_MM = 1e-7;
/** conservative-advancement target level λ = θ/2: before a reported contact the gap never goes below λ */
export const CA_LEVEL_MM = 5e-8;
/** while in contact, the level that triggers a re-press (another constraint response) */
export const CA_CONTACT_LEVEL_MM = 2.5e-8;
/** separation resolution ρ: a contact ends only when the gap exceeds θ + ρ (time contract §3) */
export const SEP_RES_MM = 1e-9;
/** a body keeps moving at a contact only if its own gap rate exceeds this (mm/s): numerical, "clearly separating" */
export const SEPARATING_RATE_MM_S = 1e-6;
/** conservative-advancement iteration cap per pair query (solver_status event when reached; bodies then stop) */
export const CA_MAX_ITER = 200000;
export const TIME_TOL = (H: number): number => 8 * Number.EPSILON * Math.max(1, Math.abs(H));
export const SAME_INSTANT = (t: number): number => 16 * Number.EPSILON * Math.max(1, Math.abs(t));

export class Kin2DRefused extends Error { constructor(m: string) { super(`KIN2D_REFUSED: ${m}`); this.name = 'Kin2DRefused'; } }

// ---------------------------------------------------------------- closed-form constant-twist motion
/** sin(x)/x, accurate near 0 (series error < x⁴/120 below |x| < 1e-4) */
export function sinc(x: number): number { return Math.abs(x) < 1e-4 ? 1 - (x * x) / 6 : Math.sin(x) / x; }

/** Pose after time tau from p0 under a constant body-frame twist (exact; stable for ω → 0). */
export function advancePose(p0: Pose, tw: Twist, tau: number): Pose {
  if (tau === 0) return { x: p0.x, y: p0.y, th: p0.th };
  const phi = tw.w * tau;
  const S = tau * sinc(phi);                                  // sin(φ)/ω
  const C = tau * Math.sin(phi / 2) * sinc(phi / 2);          // (1 − cos φ)/ω
  const dx = tw.v * S - tw.vl * C, dy = tw.v * C + tw.vl * S;
  const c = Math.cos(p0.th), s = Math.sin(p0.th);
  return { x: p0.x + c * dx - s * dy, y: p0.y + s * dx + c * dy, th: p0.th + phi };
}

export function segIndexAt(tr: Track, t: number): number {
  const segs = tr.segs;
  let lo = 0, hi = segs.length - 1;
  if (t <= segs[0].t0) return 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
  return lo;
}
export function poseAt(tr: Track, t: number): Pose { const s = tr.segs[segIndexAt(tr, t)]; return advancePose(s.p0, s.tw, Math.max(0, t - s.t0)); }
export function twistAt(tr: Track, t: number): Twist { return tr.segs[segIndexAt(tr, t)].tw; }

// ---------------------------------------------------------------- plan builder (motion primitives)
export interface Limits {
  /** each limit: number = checked; null = unknown (reported as unchecked, never defaulted) */
  max_speed_mm_s: number | null; max_turn_rate_rad_s: number | null; max_curvature_per_mm: number | null;
  /** turning in place (v = 0, ω ≠ 0) allowed? null = unknown */
  pivot_allowed: boolean | null; max_accel_mm_s2: number | null; max_ang_accel_rad_s2: number | null;
}

/** Builds a plan of constant-twist segments. Each primitive fixes its end time ONCE (t1 = t0 + duration). */
export class PlanBuilder {
  private segs: Seg[] = []; private t: number; private p: Pose;
  readonly id: string; readonly body: BodyDims; readonly layer?: string;
  constructor(id: string, body: BodyDims, start: Pose, t0 = 0, layer?: string) { this.id = id; this.body = body; this.layer = layer; this.t = t0; this.p = { ...start }; }
  private push(tw: Twist, dur: number, label: string): this {
    if (!(dur >= 0) || !Number.isFinite(dur)) throw new Kin2DRefused(`${this.id}: bad duration ${dur} (${label})`);
    if (dur === 0) return this;
    const t1 = this.t + dur, seg: Seg = { t0: this.t, t1, p0: this.p, tw, label };
    this.segs.push(seg); this.p = advancePose(this.p, tw, dur); this.t = t1; return this;
  }
  /** straight run of length len at speed v */
  straight(len: number, v: number): this { if (!(v > 0)) throw new Kin2DRefused(`${this.id}: straight needs v > 0`); return this.push({ v, vl: 0, w: 0 }, len / v, 'straight'); }
  /** constant-curvature arc of path length len, curvature kappa (1/mm, left +) at speed v */
  arc(len: number, kappa: number, v: number): this { if (!(v > 0)) throw new Kin2DRefused(`${this.id}: arc needs v > 0`); return this.push({ v, vl: 0, w: kappa * v }, len / v, 'arc'); }
  /** arc turning by dth (rad, left +) on radius R at speed v */
  arcAngle(dth: number, R: number, v: number): this { if (!(R > 0)) throw new Kin2DRefused(`${this.id}: radius must be > 0`); return this.arc(Math.abs(dth) * R, Math.sign(dth) / R, v); }
  /** turn in place by dth (rad) at angular speed |w| */
  pivot(dth: number, wAbs: number): this { if (!(wAbs > 0)) throw new Kin2DRefused(`${this.id}: pivot needs |w| > 0`); return this.push({ v: 0, vl: 0, w: Math.sign(dth) * wAbs }, Math.abs(dth) / wAbs, 'pivot'); }
  /** sidestep (lateral translation, left +) of length len at lateral speed vl > 0 */
  sidestep(len: number, vl: number): this { if (!(vl > 0)) throw new Kin2DRefused(`${this.id}: sidestep needs vl > 0`); return this.push({ v: 0, vl: Math.sign(len) * vl, w: 0 }, Math.abs(len) / vl, 'sidestep'); }
  /** stop for dur seconds */
  stop(dur: number): this { return this.push({ v: 0, vl: 0, w: 0 }, dur, 'stop'); }
  /** stop until an absolute time (no accumulation: the next segment starts exactly at tAbs) */
  stopUntil(tAbs: number): this { if (tAbs < this.t) throw new Kin2DRefused(`${this.id}: stopUntil in the past`); if (tAbs > this.t) { this.segs.push({ t0: this.t, t1: tAbs, p0: this.p, tw: { v: 0, vl: 0, w: 0 }, label: 'stop' }); this.t = tAbs; } return this; }
  /** general constant twist for dur seconds */
  twist(tw: Twist, dur: number, label = 'twist'): this { return this.push({ ...tw }, dur, label); }
  build(): Track {
    const segs = [...this.segs, { t0: this.t, t1: Infinity, p0: this.p, tw: { v: 0, vl: 0, w: 0 }, label: 'hold' }];
    return { id: this.id, body: this.body, layer: this.layer, segs };
  }
}

/** Check a plan against candidate limits. Unknown (null) limits are reported as unchecked, never assumed. */
export function checkLimits(tr: Track, lim: Limits): { violations: string[]; unchecked: string[] } {
  const violations: string[] = [], unchecked = new Set<string>();
  let prev: Twist | null = null;
  for (const s of tr.segs) {
    const sp = Math.hypot(s.tw.v, s.tw.vl), aw = Math.abs(s.tw.w);
    if (lim.max_speed_mm_s === null) unchecked.add('max_speed_mm_s'); else if (sp > lim.max_speed_mm_s * (1 + 1e-12)) violations.push(`${tr.id}@${s.t0}: speed ${sp} > ${lim.max_speed_mm_s}`);
    if (lim.max_turn_rate_rad_s === null) unchecked.add('max_turn_rate_rad_s'); else if (aw > lim.max_turn_rate_rad_s * (1 + 1e-12)) violations.push(`${tr.id}@${s.t0}: turn rate ${aw} > ${lim.max_turn_rate_rad_s}`);
    if (aw > 0 && sp === 0) { if (lim.pivot_allowed === null) unchecked.add('pivot_allowed'); else if (!lim.pivot_allowed) violations.push(`${tr.id}@${s.t0}: turn in place not allowed`); }
    if (aw > 0 && sp > 0) { if (lim.max_curvature_per_mm === null) unchecked.add('max_curvature_per_mm'); else if (aw / sp > lim.max_curvature_per_mm * (1 + 1e-12)) violations.push(`${tr.id}@${s.t0}: curvature ${aw / sp} > ${lim.max_curvature_per_mm}`); }
    if (prev && (prev.v !== s.tw.v || prev.vl !== s.tw.vl)) { if (lim.max_accel_mm_s2 === null) unchecked.add('max_accel_mm_s2 (instantaneous speed change: acceleration not modelled)'); else violations.push(`${tr.id}@${s.t0}: instantaneous speed change with finite acceleration limit`); }
    if (prev && prev.w !== s.tw.w) { if (lim.max_ang_accel_rad_s2 === null) unchecked.add('max_ang_accel_rad_s2 (instantaneous turn-rate change: angular acceleration not modelled)'); else violations.push(`${tr.id}@${s.t0}: instantaneous turn-rate change with finite angular acceleration limit`); }
    prev = s.tw;
  }
  return { violations, unchecked: [...unchecked].sort() };
}

// ---------------------------------------------------------------- geometry
export interface Cap { a: P2; b: P2; r: number }
export function dimsOf(body: BodyDims, id: string): { h: number; r: number } {
  const L = body.length_mm, w = body.width_mm;
  if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0) || !(w > 0)) throw new Kin2DRefused(`${id}: unknown or non-positive body size (never defaulted)`);
  return { h: Math.max(0, L - w) / 2, r: w / 2 };
}
export function capsuleAt(pose: Pose, d: { h: number; r: number }): Cap {
  const c = Math.cos(pose.th) * d.h, s = Math.sin(pose.th) * d.h;
  return { a: { x: pose.x - c, y: pose.y - s }, b: { x: pose.x + c, y: pose.y + s }, r: d.r };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** Closest points between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection §5.1.9), 2-D. */
export function segSegClosest(p1: P2, q1: P2, p2: P2, q2: P2): { d: number; c1: P2; c2: P2 } {
  const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d2x = q2.x - p2.x, d2y = q2.y - p2.y, rx = p1.x - p2.x, ry = p1.y - p2.y;
  const a = d1x * d1x + d1y * d1y, e = d2x * d2x + d2y * d2y, f = d2x * rx + d2y * ry;
  let s: number, t: number;
  if (a === 0 && e === 0) { s = 0; t = 0; }
  else if (a === 0) { s = 0; t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry;
    if (e === 0) { t = 0; s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y, den = a * e - b * b;
      s = den > 0 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  const c1 = { x: p1.x + d1x * s, y: p1.y + d1y * s }, c2 = { x: p2.x + d2x * t, y: p2.y + d2y * t };
  // segments that cross: Ericson's routine returns the closest pair of the supporting lines, which coincide here
  if (crosses(p1, q1, p2, q2)) return { d: 0, c1, c2: c1 };
  return { d: Math.hypot(c1.x - c2.x, c1.y - c2.y), c1, c2 };
}
function crosses(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

/** Static obstacles: a wall segment (optionally thick: radius r), a disc, or a polygon (edges; interior checked at start). */
export type Static = { id: string; layer?: string; kind: 'segment'; a: P2; b: P2; r?: number } | { id: string; layer?: string; kind: 'disc'; c: P2; r: number } | { id: string; layer?: string; kind: 'polygon'; pts: P2[] };
/** static obstacles as capsules (polygon → its edges, radius 0) */
export function staticCaps(s: Static): Cap[] {
  if (s.kind === 'segment') return [{ a: s.a, b: s.b, r: s.r ?? 0 }];
  if (s.kind === 'disc') return [{ a: s.c, b: s.c, r: s.r }];
  return s.pts.map((p, i) => ({ a: p, b: s.pts[(i + 1) % s.pts.length], r: 0 }));
}
function inPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function capGap(A: Cap, B: Cap): { g: number; cA: P2; cB: P2 } { const q = segSegClosest(A.a, A.b, B.a, B.b); return { g: q.d - A.r - B.r, cA: q.c1, cB: q.c2 }; }

// ---------------------------------------------------------------- swept occupancy (two-sided bound)
/**
 * Conservative swept occupancy of a body over [t0, t1]: capsules at sample times, each inflated by δ. Let S be the exact
 * swept region. Then S ⊆ ∪ caps (every core point moves ≤ M·Δt/2 from the nearer sample) and ∪ caps ⊆ S ⊕ δ (each
 * sample capsule lies in S). The sample count is chosen so that δ ≤ maxErr_mm; samples include every breakpoint.
 */
export function sweptOccupancy(tr: Track, t0: number, t1: number, maxErr_mm: number): { caps: Cap[]; delta_mm: number } {
  const d = dimsOf(tr.body, tr.id), caps: Cap[] = []; let delta = 0;
  const cuts = [t0, ...tr.segs.map((s) => s.t0).filter((t) => t > t0 && t < t1), t1];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k + 1], tw = twistAt(tr, a), M = Math.hypot(tw.v, tw.vl) + Math.abs(tw.w) * d.h;
    const n = M === 0 ? 1 : Math.max(1, Math.ceil((M * (b - a)) / (2 * maxErr_mm)));
    const dl = M === 0 ? 0 : (M * (b - a)) / (2 * n); delta = Math.max(delta, dl);
    for (let i = 0; i <= n; i++) { const t = i === n ? b : a + ((b - a) * i) / n; const c = capsuleAt(poseAt(tr, t), d); caps.push({ a: c.a, b: c.b, r: c.r + dl }); }
  }
  return { caps, delta_mm: delta };
}

// ---------------------------------------------------------------- continuous collision (conservative advancement)
interface Mover { tr: Track; d: { h: number; r: number }; frozenAt: number | null; frozenPose: Pose | null }
const moverPose = (m: Mover, t: number): Pose => (m.frozenAt !== null && t >= m.frozenAt ? (m.frozenPose as Pose) : poseAt(m.tr, t));
const moverTwist = (m: Mover, t: number): Twist => (m.frozenAt !== null && t >= m.frozenAt ? { v: 0, vl: 0, w: 0 } : twistAt(m.tr, t));
const moverBound = (m: Mover, t: number): number => { const tw = moverTwist(m, t); return Math.hypot(tw.v, tw.vl) + Math.abs(tw.w) * m.d.h; };
/** next time strictly after t at which the mover's twist changes (Infinity if none) */
function moverNextBreak(m: Mover, t: number): number {
  if (m.frozenAt !== null && t >= m.frozenAt) return Infinity;
  const i = segIndexAt(m.tr, t), s = m.tr.segs[i];
  let nb = t < s.t0 ? s.t0 : s.t1;
  if (m.frozenAt !== null && m.frozenAt > t && m.frozenAt < nb) nb = m.frozenAt;
  return nb;
}
/** world velocity of a material point p of a mover at time t */
function pointVel(m: Mover, t: number, p: P2): P2 {
  const tw = moverTwist(m, t), pose = moverPose(m, t), c = Math.cos(pose.th), s = Math.sin(pose.th);
  const vx = c * tw.v - s * tw.vl, vy = s * tw.v + c * tw.vl, rx = p.x - pose.x, ry = p.y - pose.y;
  return { x: vx - tw.w * ry, y: vy + tw.w * rx };
}

type Other = { kind: 'body'; m: Mover } | { kind: 'static'; caps: Cap[]; id: string };
function pairGap(A: Mover, B: Other, t: number): { g: number; cA: P2; cB: P2 } {
  const ca = capsuleAt(moverPose(A, t), A.d);
  if (B.kind === 'body') return capGap(ca, capsuleAt(moverPose(B.m, t), B.m.d));
  let best = { g: Infinity, cA: ca.a, cB: ca.a };
  for (const c of B.caps) { const q = capGap(ca, c); if (q.g < best.g) best = q; }
  return best;
}

export interface CAResult { t: number; g: number; status: 'contact' | 'none' | 'iteration_limit'; iters: number; prev_t: number }
/**
 * Conservative advancement of one pair from t to the horizon H toward level `level`, stopping when g ≤ stopAt.
 * Steps never depend on H (prefix property); the reported time is an iterate ≤ H.
 */
function advance(A: Mover, B: Other, t: number, H: number, level: number, stopAt: number): CAResult {
  let iters = 0, prev = t;
  for (;;) {
    if (t > H) return { t: Infinity, g: Infinity, status: 'none', iters, prev_t: prev };
    const g = pairGap(A, B, t).g;
    if (g <= stopAt) return { t, g, status: 'contact', iters, prev_t: prev };
    const M = moverBound(A, t) + (B.kind === 'body' ? moverBound(B.m, t) : 0);
    const nb = Math.min(moverNextBreak(A, t), B.kind === 'body' ? moverNextBreak(B.m, t) : Infinity);
    prev = t;
    if (M === 0) { if (nb === Infinity) return { t: Infinity, g: Infinity, status: 'none', iters, prev_t: prev }; t = nb; continue; }
    let tn = t + (g - level) / M;
    if (tn >= nb) tn = nb;
    if (!(tn > t) || ++iters > CA_MAX_ITER) return { t, g, status: 'iteration_limit', iters, prev_t: prev };
    t = tn;
  }
}

/** Bisection for a crossing of `level` by g on [lo, hi] given g(lo) and g(hi) on opposite sides (bracket of floats). */
function bisectCrossing(A: Mover, B: Other, lo: number, hi: number, level: number): [number, number] {
  const gl = pairGap(A, B, lo).g - level;
  for (let k = 0; k < 200; k++) {
    const mid = lo + (hi - lo) / 2;
    if (!(mid > lo && mid < hi)) break;
    const gm = pairGap(A, B, mid).g - level;
    if ((gm > 0) === (gl > 0)) lo = mid; else hi = mid;
  }
  return [lo, hi];
}

// ---------------------------------------------------------------- multi-body run
export interface KinEvent {
  t_s: number; kind: 'contact_start' | 'contact_end' | 'stop_on_contact' | 'repress' | 'plan_segment' | 'solver_status';
  ids: string[]; class: 'physical_contact' | 'physical_constraint' | 'motion' | 'solver_status';
  /** contact_start: crossing bracket of θ found by bisection between the last CA iterates (g(lo) > θ ≥ g(hi)) */
  bracket_s?: [number, number]; gap_mm?: number; detail?: string;
}
export interface KinInput { tracks: Track[]; statics: Static[]; horizon_s: number }
export interface KinResult {
  events: KinEvent[];
  /** executed motion: each body's segments clipped to H, with stops applied (the record the independent checker reads) */
  executed: Record<string, { body: BodyDims; segs: Seg[]; stopped_at_s: number | null; stop_cause: string | null }>;
  final: Record<string, Pose>;
  stats: { pair_queries: number; ca_iterations: number; max_ca_iterations: number; contact_batches: number };
}

const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Run all tracks against each other and the statics up to the horizon. Pure; independent of input array order. */
export function runKinematics(input: KinInput): KinResult {
  const H = input.horizon_s;
  if (!(H >= 0) || !Number.isFinite(H)) throw new Kin2DRefused('bad horizon');
  if (input.tracks.length === 0) throw new Kin2DRefused('no tracks');
  const ids = input.tracks.map((t) => t.id);
  if (new Set(ids).size !== ids.length) throw new Kin2DRefused('duplicate track id');
  const sids = input.statics.map((s) => s.id);
  if (new Set(sids).size !== sids.length || sids.some((s) => ids.includes(s))) throw new Kin2DRefused('duplicate static id');
  const movers = new Map<string, Mover>();
  const tStart = Math.min(...input.tracks.map((t) => (t.segs.length ? t.segs[0].t0 : Infinity)));
  for (const tr0 of [...input.tracks].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (tr0.segs.length === 0) throw new Kin2DRefused(`${tr0.id}: empty plan`);
    // a body that starts later is stationary at its start pose until then (explicit hold, not an assumed motion)
    const tr: Track = tr0.segs[0].t0 > tStart ? { ...tr0, segs: [{ t0: tStart, t1: tr0.segs[0].t0, p0: tr0.segs[0].p0, tw: { v: 0, vl: 0, w: 0 }, label: 'not_started' }, ...tr0.segs] } : tr0;
    for (let i = 1; i < tr.segs.length; i++) if (tr.segs[i].t0 !== tr.segs[i - 1].t1) throw new Kin2DRefused(`${tr.id}: segments not contiguous`);
    movers.set(tr.id, { tr, d: dimsOf(tr.body, tr.id), frozenAt: null, frozenPose: null });
  }
  const statics = [...input.statics].sort((a, b) => (a.id < b.id ? -1 : 1));
  const order = [...movers.keys()];
  const sameLayer = (a?: string, b?: string) => (a ?? '') === (b ?? '');
  // pairs: body–body (a < b), body–static
  type Pair = { key: string; A: Mover; B: Other; ids: string[]; inContact: boolean; cache: { ver: string; res: CAResult; from: number } | null; lastLe: number | null };
  const pairs: Pair[] = [];
  for (let i = 0; i < order.length; i++) {
    const A = movers.get(order[i]) as Mover;
    for (let j = i + 1; j < order.length; j++) { const B = movers.get(order[j]) as Mover; if (sameLayer(A.tr.layer, B.tr.layer)) pairs.push({ key: pairKey(A.tr.id, B.tr.id), A, B: { kind: 'body', m: B }, ids: [A.tr.id, B.tr.id], inContact: false, cache: null, lastLe: null }); }
    for (const s of statics) if (sameLayer(A.tr.layer, s.layer)) pairs.push({ key: pairKey(A.tr.id, s.id), A, B: { kind: 'static', caps: staticCaps(s), id: s.id }, ids: [A.tr.id, s.id], inContact: false, cache: null, lastLe: null });
  }
  // initial legality: no overlap, no body inside a polygon
  const t0 = tStart;
  for (const p of pairs) {
    const g = pairGap(p.A, p.B, Math.max(t0, p.A.tr.segs[0].t0)).g;
    if (g < -1e-9) throw new Kin2DRefused(`${p.key}: overlapping at start (gap ${g})`);
  }
  for (const s of statics) if (s.kind === 'polygon') for (const m of movers.values()) if (sameLayer(m.tr.layer, s.layer) && inPolygon(poseAt(m.tr, m.tr.segs[0].t0), s.pts)) throw new Kin2DRefused(`${m.tr.id} starts inside polygon ${s.id}`);

  const events: KinEvent[] = [];
  const stats = { pair_queries: 0, ca_iterations: 0, max_ca_iterations: 0, contact_batches: 0 };
  const version = (p: Pair) => `${p.A.frozenAt}|${p.B.kind === 'body' ? p.B.m.frozenAt : '-'}|${p.inContact}`;
  // plan events (motion class): every segment start ≤ H (+ TIME_TOL(H)), recorded from the plan (stops are added below)
  const planEvents: KinEvent[] = [];
  for (const m of movers.values()) for (const s of m.tr.segs) if (s.t0 <= H + TIME_TOL(H) && s.label !== 'hold' && s.label !== 'not_started') planEvents.push({ t_s: s.t0, kind: 'plan_segment', ids: [m.tr.id], class: 'motion', detail: `${s.label} v=${s.tw.v} vl=${s.tw.vl} w=${s.tw.w}` });

  let now = t0;
  for (let batch = 0; ; batch++) {
    // next event of every pair, from `now` (cached results stay valid while neither side changed)
    let tMin = Infinity;
    const res = new Map<string, CAResult>();
    for (const p of pairs) {
      const ver = version(p);
      let r: CAResult;
      if (p.cache && p.cache.ver === ver && p.cache.res.t >= now) r = p.cache.res;
      else {
        stats.pair_queries++;
        r = p.inContact ? advanceContact(p, now) : advance(p.A, p.B, now, H, CA_LEVEL_MM, CONTACT_TOL_MM);
        stats.ca_iterations += r.iters; stats.max_ca_iterations = Math.max(stats.max_ca_iterations, r.iters);
        p.cache = { ver, res: r, from: now };
      }
      res.set(p.key, r);
      if (r.status !== 'none' && r.t < tMin) tMin = r.t;
    }
    if (tMin === Infinity || tMin > H) break;
    stats.contact_batches++;
    const T = tMin, batchPairs = pairs.filter((p) => { const r = res.get(p.key) as CAResult; return r.status !== 'none' && r.t <= T + SAME_INSTANT(T); });
    // classify, using pre-response velocities at T (Jacobi: independent of order)
    const toStop = new Map<string, string[]>();
    const stopFor = (id: string, why: string) => { const l = toStop.get(id) ?? []; l.push(why); toStop.set(id, l); };
    for (const p of batchPairs) {
      const r = res.get(p.key) as CAResult;
      if (r.status === 'iteration_limit') {
        events.push({ t_s: r.t, kind: 'solver_status', ids: p.ids, class: 'solver_status', gap_mm: r.g, detail: 'conservative advancement iteration limit: bodies stopped conservatively' });
        stopFor(p.A.tr.id, `limit:${p.key}`); if (p.B.kind === 'body') stopFor(p.B.m.tr.id, `limit:${p.key}`);
        continue;
      }
      if (r.g > CONTACT_TOL_MM + SEP_RES_MM) { // in-contact pair separated
        const lo = p.lastLe ?? r.prev_t, br = bisectCrossing(p.A, p.B, lo, r.t, CONTACT_TOL_MM);
        events.push({ t_s: br[1], kind: 'contact_end', ids: p.ids, class: 'physical_contact', bracket_s: br, gap_mm: r.g, detail: `confirmed at ${r.t} (gap > θ + ρ)` });
        p.inContact = false; p.lastLe = null; continue;
      }
      if (!p.inContact) {
        const gPrev = pairGap(p.A, p.B, r.prev_t).g;
        const br: [number, number] = gPrev > CONTACT_TOL_MM ? bisectCrossing(p.A, p.B, r.prev_t, r.t, CONTACT_TOL_MM) : [r.t, r.t];
        events.push({ t_s: br[1], kind: 'contact_start', ids: p.ids, class: 'physical_contact', bracket_s: br, gap_mm: r.g, detail: `CA iterate ${r.t}` });
        p.inContact = true;
      } else events.push({ t_s: r.t, kind: 'repress', ids: p.ids, class: 'physical_constraint', gap_mm: r.g });
      p.lastLe = r.t;
      const q = pairGap(p.A, p.B, r.t), dx = q.cB.x - q.cA.x, dy = q.cB.y - q.cA.y, n = Math.hypot(dx, dy);
      const nx = n > 0 ? dx / n : 0, ny = n > 0 ? dy / n : 0;
      const vA = pointVel(p.A, r.t, q.cA), rateA = -(nx * vA.x + ny * vA.y);
      if (n === 0 || rateA <= SEPARATING_RATE_MM_S) { if (moverBound(p.A, r.t) > 0) stopFor(p.A.tr.id, p.key); }
      if (p.B.kind === 'body') { const vB = pointVel(p.B.m, r.t, q.cB), rateB = nx * vB.x + ny * vB.y; if ((n === 0 || rateB <= SEPARATING_RATE_MM_S) && moverBound(p.B.m, r.t) > 0) stopFor(p.B.m.tr.id, p.key); }
    }
    for (const [id, why] of [...toStop.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const m = movers.get(id) as Mover;
      if (m.frozenAt !== null) continue;
      m.frozenPose = poseAt(m.tr, T); m.frozenAt = T;
      events.push({ t_s: T, kind: 'stop_on_contact', ids: [id], class: 'physical_constraint', detail: [...new Set(why)].sort().join(',') });
    }
    now = T;
    if (batch > 100000) { events.push({ t_s: T, kind: 'solver_status', ids: [], class: 'solver_status', detail: 'batch cap reached' }); break; }
  }

  // executed record
  const executed: KinResult['executed'] = {}, final: Record<string, Pose> = {};
  for (const id of order) {
    const m = movers.get(id) as Mover, end = m.frozenAt !== null ? Math.min(m.frozenAt, H) : H, segs: Seg[] = [];
    for (const s of m.tr.segs) {
      if (s.t0 > end) break;
      const t1 = Math.min(s.t1, end);
      if (t1 > s.t0 || (s.t0 === end && segs.length === 0)) segs.push({ ...s, t1 });
    }
    if (m.frozenAt !== null && m.frozenAt <= H) segs.push({ t0: m.frozenAt, t1: H, p0: m.frozenPose as Pose, tw: { v: 0, vl: 0, w: 0 }, label: 'stopped_on_contact' });
    const stopEv = events.find((e) => e.kind === 'stop_on_contact' && e.ids[0] === id);
    executed[id] = { body: m.tr.body, segs, stopped_at_s: m.frozenAt !== null && m.frozenAt <= H ? m.frozenAt : null, stop_cause: stopEv?.detail ?? null };
    final[id] = moverPose(m, H);
  }
  const KIND = ['contact_end', 'contact_start', 'repress', 'stop_on_contact', 'solver_status', 'plan_segment'];
  const all = [...events, ...planEvents.filter((e) => { const m = movers.get(e.ids[0]) as Mover; return m.frozenAt === null || e.t_s <= m.frozenAt; })];
  all.sort((a, b) => a.t_s - b.t_s || KIND.indexOf(a.kind) - KIND.indexOf(b.kind) || (a.ids.join('|') < b.ids.join('|') ? -1 : a.ids.join('|') > b.ids.join('|') ? 1 : 0));
  return { events: all, executed, final, stats };

  /** in contact: advance toward the lower contact level; report separation (g > θ + ρ) or a re-press (g ≤ CA_CONTACT_LEVEL + (θ − λ)/2) */
  function advanceContact(p: Pair, from: number): CAResult {
    let t = from, iters = 0, prev = from;
    const press = CA_CONTACT_LEVEL_MM + (CA_LEVEL_MM - CA_CONTACT_LEVEL_MM) / 2;
    // first step: we are at the processed contact instant; the gap is in the band. Move strictly forward.
    for (;;) {
      if (t > H) return { t: Infinity, g: Infinity, status: 'none', iters, prev_t: prev };
      const g = pairGap(p.A, p.B, t).g;
      if (t > from && g > CONTACT_TOL_MM + SEP_RES_MM) return { t, g, status: 'contact', iters, prev_t: prev };
      if (t > from && g <= press) return { t, g, status: 'contact', iters, prev_t: prev };
      if (g <= CONTACT_TOL_MM) p.lastLe = t;
      const M = moverBound(p.A, t) + (p.B.kind === 'body' ? moverBound(p.B.m, t) : 0);
      const nb = Math.min(moverNextBreak(p.A, t), p.B.kind === 'body' ? moverNextBreak(p.B.m, t) : Infinity);
      prev = t;
      if (M === 0) { if (nb === Infinity) return { t: Infinity, g: Infinity, status: 'none', iters, prev_t: prev }; t = nb; continue; }
      let tn = t + Math.max(g - CA_CONTACT_LEVEL_MM, 0) / M;
      if (tn >= nb) tn = nb;
      if (!(tn > t) || ++iters > CA_MAX_ITER) return { t, g, status: 'iteration_limit', iters, prev_t: prev };
      t = tn;
    }
  }
}

/** Minimum gap of a static capsule set to a body over a time grid (diagnostic only; the solver never uses sampling). */
export function gapToStatics(tr: Track, statics: Static[], t: number): number {
  const c = capsuleAt(poseAt(tr, t), dimsOf(tr.body, tr.id));
  let g = Infinity;
  for (const s of statics) for (const k of staticCaps(s)) g = Math.min(g, capGap(c, k).g);
  return g;
}
