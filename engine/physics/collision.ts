/**
 * PH-2 / PH-3 (Issue #68), first working version: local collision, contact and mechanical limits for ants moving on
 * PH-1 lanes with MV-1 kinematics. Event-driven and exact in time (no fixed step, so nothing can tunnel).
 *
 * Three kinds of interaction are kept apart (Issue #68):
 *  A. Physical obstruction — two bodies cannot occupy the same space. On one lane a body is the interval
 *     [s − L/2, s + L/2] (L = body length) with a width w. Two bodies may overlap along the lane only where the usable
 *     width (passage width, narrowed by obstacles at the lane's level) is ≥ wA + wB; elsewhere they obstruct. Across
 *     lanes a body is a disc of radius L/2 (bounding circle of the capsule; conservative).
 *  B. Biological contact — an EVENT with time and position: the two bodies come within antennal reach. A contact does
 *     not imply any behaviour. On a lane wider than wA + wB + 2·reach the lateral offset of the two ants is not modelled,
 *     so the contact is marked `certain: false` (possible, not certain).
 *  C. Mechanical interaction — an ant's effective width is max(body width, carried load width); a passage section or a
 *     nest-entrance aperture narrower than that stops it. A carried object has exactly one holder (no double carrying).
 *
 * Responses — local encounter rules (v1, Issue #68 follow-up). Every rule uses only what each ant can sense itself: its
 * own position (inside or outside a narrow part, by touch), its own load, and the ant it is touching. Values come from
 * scenarios/physics/<species>.interaction-candidates.json via `SimConfig.encounter`; none is a P. megacephala
 * measurement (no traffic study exists for any Pheidole; see docs/references.md R380–R387):
 *  - same direction in a single-file section: the rear ant cannot pass; it walks no faster than the ant in front
 *    (a physical consequence, not a slow-down factor; no overtaking also observed in Atta, R381);
 *  - head-on where two cannot pass ('single file'): both stand still for the time lost per contact (other species:
 *    0.24–0.80 s, R108/R380/R381), then one gives way by stepping back out of the narrow part and waiting beside it
 *    until the other has passed:
 *      · laden priority (optional rule; Atta colombica, outbound ants gave way to laden ants in 294/300 encounters, R381;
 *        not seen in Lasius niger, R380): an unladen ant gives way to one carrying a load;
 *      · entry yield (Lasius niger, the ant arriving at the narrow part gave way to the one coming out of it in 202/211
 *        encounters with contact, R380): the ant whose body is not yet wholly inside gives way;
 *      · both wholly inside (no study observed this): each ant independently turns back with a per-contact probability
 *        (game assumption; null → reported `unresolved`); both at the entry: even chance (game assumption);
 *      · an ant backed into by a nestmate that is giving way turns back too (chain back-out; game assumption).
 *    The outcome draws come from a named stream keyed by the pair, the encounter number and the seed, never array order.
 *    NOT strictly local (disclosed engineering proxies/solvers, see interaction-candidates `rules`): 'wholly inside' is
 *    measured against the section that is single-file for the PAIR of widths (a geometric proxy for 'already in the narrow
 *    part'); when the drawn yielder has no wide place behind it the other gives way (pairwise step); several ants waiting
 *    abreast at an entry are released in a drawn order, only an ant not blocked ahead going first (coordinating solver);
 *    the back-out target is computed in advance (equivalent to walking back until the passage widens).
 *    Extension beyond the source: in L. niger the yielder 'does not move until the ant in the entrance has completely
 *    entered the bottleneck' (R380) — it waits in place; here a single-file passage leaves no room to wait beside, so the
 *    yielder steps back out to the nearest wide place (possibly far: a long back-out is a model consequence).
 *  - across lanes (crossing): an ant that has the other in its forward half stops (local: the other is ahead of its
 *    antennae); if both do, an even draw decides; if the stopped ant is pressed by the other, it backs off until it is
 *    out of antennal reach of the LINE the other is heading along (its conflict region; PH-P1-A — not just out of reach
 *    of the other's present position), and the other waits until it has done so; it walks on from the earliest instant
 *    at which walking would not bring it within antennal reach of the other, given the other's present velocity
 *    (game assumptions; no crossing study found). Two progress invariants stop the run with an error if a pair repeats
 *    a press or a release without either ant having moved or turned (no near-zero-time yield loop).
 *  - Contact geometry (PH-P1-B): across lanes every contact, touch and release is decided by `discEncounter` from
 *    |r + v·τ|² = R² — one geometry for scheduling and handling; an exact tangent (graze) is no contact.
 *  - Time (PH-P2-B/C, PH-P2D): event times and positions come from the start of each motion record, its velocity and the
 *    elapsed time, never from per-step accumulation; the clock stops only at event instants (a broadphase window end is
 *    not an evaluation instant); events at one instant (within SAME_INSTANT) are handled in a fixed total order
 *    (KIND_ORDER, ids, data). A pressed back-out ant's speed-up is the boundary event of its front (PH-P2D).
 *  - Turning around takes no time; backing out is at the ant's own free speed; passing abreast in a wide section costs no
 *    time; spontaneous U-turns (rare: ≈1 % per bridge crossing in L. humile, R108) are not modelled; no slow-down from
 *    load, slope or temperature (no species data; stated limits).
 *  - Cost: every event step re-evaluates all agents and all broadphase pairs, so wall time grows roughly with N² on dense
 *    lattices (measured 250/500/1000 ants: ≈0.75/1.8/7.9 s for 5 simulated s); an event queue with local invalidation is
 *    the next step for 10⁴ ants. Narrow-section boundaries are precomputed per distinct pair of widths, analytically (Codex physics review F2).
 *  - A configuration this version cannot resolve (e.g. a backing-out ant blocked from behind) is reported as an
 *    `unresolved` event and the ants involved stop: never an overlap, never a silent fix.
 *
 * Broadphase: uniform grid over conservative per-window reach discs (exactly equivalent to brute force; tested).
 * The module moves bodies only. It never reads or changes food, crops, brood or population (Issue #68: contact →
 * behaviour → nutrition is a later chain; this is the contact end of it).
 */
import type { Vec3 } from './vec.ts';
import { type PhysicsGeometry, type Passage, obstacleDistance, obstacleReachesLevel, physicsReady, validateGeometry, arcPositionOf, ON_TOLERANCE_MM } from './geometry.ts';
import { type MotionInterval, positionAt, headingAt, vertexArcs, laneLength, passageOf, T_EPS, S_EPS } from './kinematics.ts';
import { hash32, rng } from '../rng.ts';

export const COLLISION_MODEL_REF = 'PH-2 v1: lane bodies (interval along lane + width), discs across lanes, antennal-reach contact, local encounter rules (entry yield / laden priority / contact time loss; non-species candidates)';
/** Numerical hysteresis for leaving a contact (mm): not a model parameter. */
const CONTACT_EXIT_EPS = 1e-6;
/** Distance kept outside a narrow-section boundary when backing out (mm): numerical, not a model parameter. */
const EDGE_EPS = 1e-6;
/** Cross-lane bodies count as on one height layer a little before the checker's |dz| ≤ L limit, so that an ant meeting
 *  another by changing height is stopped while the two are still apart (mm; numerical, not a model parameter). */
const LEVEL_EPS = 1e-6;
/** Same-instant tolerance (s) at clock value t (PH-P2-B): 16 ulps of t — candidates for one mathematical instant computed by
 *  different formulas differ by rounding only. Scale-aware and numerical, not a model parameter; far below T_EPS. */
export const SAME_INSTANT = (t: number): number => 16 * Number.EPSILON * Math.max(1, Math.abs(t));
/** Length tolerance (mm) for coordinates of magnitude `scale` (PH-P1-B, PH-P2-C): 64 ulps of the coordinate scale, the
 *  rounding a planar relative position can carry. Numerical, not a model parameter. */
export const LEN_TOL = (scale: number): number => 64 * Number.EPSILON * Math.max(1, Math.abs(scale));

/**
 * PH-P1-B: the ONE planar contact geometry used to trigger AND to handle every cross-lane contact, touch and release.
 * Two discs with relative position r (mm) and constant relative velocity v (mm/s) are within distance R at time τ when
 * |r + v·τ|² < R², i.e. A·τ² + 2h·τ + (|r|² − R²) < 0 with A = |v|², h = r·v. The interval is decided by the miss distance
 * b = |r × v| / |v| (the closest approach of the centres), which does not depend on the time at which r is taken (r + v·τ
 * has the same cross product with v), so neither does the decision:
 *  - b < R − tol: the discs are within R for the open interval (τ_in, τ_out) (may already have begun: τ_in < 0);
 *  - b ≥ R − tol (an exact tangent within rounding, or a miss): no encounter — a graze is NOT a contact or a touch;
 *  - v = 0: within R for all time when |r| < R − tol, otherwise never.
 * tol = LEN_TOL(scale): `scale` is the magnitude of the coordinates r was computed from. Returns null when there is no
 * encounter. Times are relative to the instant r was taken.
 */
export function discEncounter(rx: number, ry: number, vx: number, vy: number, R: number, scale: number): { t_in: number; t_out: number } | null {
  if (!(R > 0)) throw Error(`PHYSICS: contact radius ${R} must be positive`);
  const tol = LEN_TOL(Math.max(scale, R)), Ri = R - tol, A = vx * vx + vy * vy, r2 = rx * rx + ry * ry;
  if (A === 0) return r2 < Ri * Ri ? { t_in: -Infinity, t_out: Infinity } : null;
  const h = rx * vx + ry * vy, cr = rx * vy - ry * vx;
  if (!(cr * cr < A * Ri * Ri)) return null;                       // b ≥ R − tol: tangent (graze) or miss
  const sq = Math.sqrt(A * R * R - cr * cr);                        // = |v|·sqrt(R² − b²) > 0
  const q = h >= 0 ? -(h + sq) : -(h - sq);                         // numerically stable roots of A τ² + 2h τ + (r² − R²)
  const t1 = q / A, t2 = (r2 - R * R) / q;
  return t1 <= t2 ? { t_in: t1, t_out: t2 } : { t_in: t2, t_out: t1 };
}

/**
 * PH-P1-A: the earliest instant τ ≥ now (relative to the instant r was taken) from which a standing ant w can walk on
 * without coming within distance R of another ant o — the crossing waiter's release. While w stands, the relative position
 * o − w is r + v_o·τ; once w walks from τ the relative velocity is u = v_o − v_w. Released at τ when
 * discEncounter(r + v_o·τ, u, R) is empty or already over (the same geometry as every contact). The predicate can only
 * switch where |r + v_o τ| = R, where the miss distance for u equals R, or where (r + v_o τ)·u = 0; it is evaluated
 * between consecutive switch points (never on them), so rounding at a switch point cannot flip the decision.
 * Returns null when no such instant exists for the present motions (re-evaluated when either motion changes).
 */
export function releaseTime(rx: number, ry: number, vox: number, voy: number, vwx: number, vwy: number, R: number, scale: number, now: number): number | null {
  const ux = vox - vwx, uy = voy - vwy, U = Math.hypot(ux, uy);
  const P = (τ: number) => { const e = discEncounter(rx + vox * τ, ry + voy * τ, ux, uy, R, scale); return e === null || e.t_out <= 0; };
  if (P(now)) return now;
  if (vox === 0 && voy === 0) return null;                          // nothing changes while w stands
  const cand: number[] = [], add = (τ: number) => { if (Number.isFinite(τ) && τ > now) cand.push(τ); };
  const A = vox * vox + voy * voy, B = 2 * (rx * vox + ry * voy), C0 = rx * rx + ry * ry - R * R, D = B * B - 4 * A * C0;
  if (D >= 0) { const q = -(B + (B >= 0 ? 1 : -1) * Math.sqrt(D)) / 2; add(q / A); if (q !== 0) add(C0 / q); }
  const c0 = rx * uy - ry * ux, c1 = vox * uy - voy * ux;          // cross(r(τ), u) = c0 + c1·τ
  if (c1 !== 0) { add((R * U - c0) / c1); add((-R * U - c0) / c1); }
  const d0 = rx * ux + ry * uy, d1 = vox * ux + voy * uy;          // r(τ)·u = d0 + d1·τ
  if (d1 !== 0) add(-d0 / d1);
  const xs = [...new Set(cand)].sort((x, y) => x - y);
  let lo = now;
  for (const hi of [...xs, Infinity]) {
    const mid = Number.isFinite(hi) ? (lo + hi) / 2 : lo + Math.max(1, Math.abs(lo));
    if (P(mid)) return lo;
    lo = hi;
  }
  return null;
}

/** State recorded when an ant w backs off out of the heading line of an ant o that pressed it (PH-P1-A). */
export interface PressRecord { wS: number; oS: number; dir: number; hx: number; hy: number }
/**
 * PH-P1-A progress invariant (press): true when o presses w again although w still stands where it backed off out of o's
 * heading line (same arc length), o walks in the same direction with the same heading, and o is not behind the point
 * where it pressed. Geometrically o cannot reach w then (w is out of reach of every point o can walk through), so a
 * repeat means a yield loop without progress.
 */
export function pressWithoutProgress(rec: PressRecord, now: PressRecord): boolean {
  return Math.abs(now.wS - rec.wS) <= S_EPS && now.dir === rec.dir && Math.abs(now.hx - rec.hx) <= 1e-12 && Math.abs(now.hy - rec.hy) <= 1e-12 && (now.oS - rec.oS) * now.dir >= -S_EPS;
}
/**
 * PH-P1-A progress invariant (release): true when y, released because walking on could not bring it within reach of o,
 * touches o again with neither motion changed since the release (y still on the motion record that began at the release,
 * o on the same record at the same velocity).
 */
export function releaseWithoutProgress(rec: { t: number; oT: number; oV: number }, now: { yT: number; oT: number; oV: number }): boolean {
  return now.yT === rec.t && now.oT === rec.oT && now.oV === rec.oV;
}

export interface PhysBody { length_mm: number; width_mm: number; contact_reach_mm: number }
export interface PhysObject { id: string; width_mm: number; holder: string | null }
export interface SimAgentSpec {
  id: string; passage: string; s_mm: number; dir: 1 | -1; start_t_s: number;
  free_speed_mm_s: number; goal_s_mm: number; body: PhysBody; load: string | null;
}
/** Local encounter rules and their candidate values (from the interaction-candidates file; never hard-coded here). */
export interface EncounterRules {
  /** 'entry_yield' (Lasius niger, R380) or 'laden_priority' (Atta colombica, R381; falls back to entry yield when both or neither is laden) */
  priority: 'entry_yield' | 'laden_priority';
  /** probability that the ant not yet wholly inside gives way to the one inside (else the inside one gives way) */
  entry_yield_probability: number;
  /** probability that an unladen ant gives way to a laden one (laden_priority only) */
  laden_yield_probability: number;
  /** how long both ants stand in a head-on contact before one gives way (s): a contact DURATION, not the literature's
   *  'time lost per contact' (a regression slope that already includes giving way; using it here would count twice); null = 0 */
  contact_pause_s: number | null;
  /** both wholly inside: per-contact probability that an ant turns back; null = no rule → `unresolved` */
  inside_turn_back_probability: number | null;
}
export interface SimConfig {
  geometry: PhysicsGeometry; agents: SimAgentSpec[]; objects?: PhysObject[];
  horizon_s: number; seed: number;
  encounter: EncounterRules;
  /** broadphase window (s): only how far ahead the pair set reaches. Any positive value gives the same events: event times
   *  and positions come from motion-record starts (PH-P2-C), and a window end is never an evaluation instant (PH-P2-B,
   *  PH-P2D) — the clock stops only at event instants. Tested by window-split tests incl. boundary-aligned windows
   *  (tests/physics-event-fixes.test.ts, tests/physics-p2d.test.ts); an engineering test, not a proof for every geometry. */
  window_s?: number;
  /** spacing (mm) of the numerical scan that remains: the back-out target. Narrow-section boundaries are analytic and
   *  do not use it (Codex physics review F2). */
  boundary_step_mm?: number;
}
export type PhysEventKind = 'start' | 'arrive' | 'contact_start' | 'contact_end' | 'obstruction' | 'follow_start' | 'follow_end' | 'yield_start' | 'yield_hold' | 'yield_resume' | 'cross_wait' | 'cross_resume' | 'blocked' | 'unresolved';
export interface PhysEvent {
  t_s: number; kind: PhysEventKind; agent: string; other: string | null; passage: string; s_mm: number;
  position_mm: [number, number, number]; certain: boolean | null; detail: string | null; model_ref: string;
}
type Mode = 'idle' | 'free' | 'follow' | 'retreat' | 'yield_wait' | 'cross_wait' | 'blocked' | 'arrived' | 'unresolved';
export interface SimResult {
  intervals: Record<string, MotionInterval[]>;
  events: PhysEvent[];
  final: Record<string, { s_mm: number; mode: Mode; t_s: number }>;
  stats: { windows: number; steps: number; pair_evaluations: number; t_end_s: number };
}

// ---------------------------------------------------------------- geometry helpers

/** Usable width (mm) of a passage at arc length s: the passage width, narrowed by obstacles at the lane's level. */
export function usableWidth(g: PhysicsGeometry, p: Passage, s: number): number {
  const q = positionAt(p, s);
  let w = p.width_mm ?? 0;
  for (const o of g.obstacles) if (obstacleReachesLevel(o, q.z, q.z)) w = Math.min(w, 2 * Math.max(0, obstacleDistance(o, q)));
  return w;
}

/**
 * Sections [a, b] of a passage where the usable width is < T (Codex physics review f61db12, F2: found analytically, not by
 * sampling). Along each centre-line segment the lane point moves linearly, so every place where "usable width < T" can
 * switch is a root of a known equation: the circle |q − c| = r + T/2, the polygon's vertex discs and edge strips at T/2,
 * the polygon's edges (inside / outside), and the obstacle's height range on a sloped segment. Between consecutive
 * candidate points the predicate is constant and is evaluated once with usableWidth itself (the same definition the
 * exclusion checker uses), so a narrowing of any length is found. `_step` is kept for the API and is not used.
 */
export function narrowSections(g: PhysicsGeometry, p: Passage, T: number, _step = 0.01): [number, number][] {
  const L = laneLength(p), f = (s: number) => usableWidth(g, p, s) < T, d = T / 2, cuts: number[] = [0, L];
  const pts = p.centerline_mm.map(([x, y, z]) => ({ x, y, z }));
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const A = pts[i - 1], B = pts[i], Ls = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    if (Ls === 0) continue;
    const dx = B.x - A.x, dy = B.y - A.y, dz = B.z - A.z, add = (u: number) => { if (u > 0 && u < 1 && Number.isFinite(u)) cuts.push(acc + u * Ls); };
    const lin = (c0: number, c1: number) => { if (c1 !== 0) add(-c0 / c1); };                       // c0 + c1·u = 0
    const disc = (cx: number, cy: number, R: number) => {                                            // |A + u·D − c| = R
      const ex = A.x - cx, ey = A.y - cy, a = dx * dx + dy * dy, b = 2 * (ex * dx + ey * dy), c = ex * ex + ey * ey - R * R;
      if (a === 0) return; const D = b * b - 4 * a * c; if (D < 0) return; const r = Math.sqrt(D); add((-b - r) / (2 * a)); add((-b + r) / (2 * a));
    };
    for (const o of g.obstacles) {
      if (o.base_z_mm !== null) {                                                                    // height range on a slope
        const top = o.height_mm === null ? Infinity : o.base_z_mm + o.height_mm;
        if (dz !== 0) { lin(A.z - (o.base_z_mm - ON_TOLERANCE_MM), dz); if (Number.isFinite(top)) lin(A.z - (top + ON_TOLERANCE_MM), dz); }
      }
      if (o.shape.type === 'circle') { disc(o.shape.center_mm[0], o.shape.center_mm[1], o.shape.radius_mm + d); continue; }
      const poly = o.shape.points_mm;
      for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) {
        const P = { x: poly[j][0], y: poly[j][1] }, Q = { x: poly[k][0], y: poly[k][1] }, ex = Q.x - P.x, ey = Q.y - P.y, el = Math.hypot(ex, ey);
        disc(P.x, P.y, d);                                                                           // vertex discs
        if (el === 0) continue;
        const nx = -ey / el, ny = ex / el;
        lin(nx * (A.x - P.x) + ny * (A.y - P.y) - d, nx * dx + ny * dy);                             // edge strip ±T/2
        lin(nx * (A.x - P.x) + ny * (A.y - P.y) + d, nx * dx + ny * dy);
        lin(((A.x - P.x) * ex + (A.y - P.y) * ey) / (el * el), (dx * ex + dy * ey) / (el * el));     // strip ends (projection 0, 1)
        lin(((A.x - P.x) * ex + (A.y - P.y) * ey) / (el * el) - 1, (dx * ex + dy * ey) / (el * el));
        lin(nx * (A.x - P.x) + ny * (A.y - P.y), nx * dx + ny * dy);                                 // crossing the edge's line (inside/outside)
      }
    }
    acc += Ls;
    cuts.push(acc);
  }
  const xs = [...new Set(cuts.filter((x) => x >= 0 && x <= L))].sort((a, b) => a - b), out: [number, number][] = [];
  for (let i = 1; i < xs.length; i++) {
    const a = xs[i - 1], b = xs[i];
    if (!(b > a) || !f((a + b) / 2)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - a) <= 1e-12) last[1] = b; else out.push([a, b]);
  }
  return out;
}

// ---------------------------------------------------------------- broadphase

export interface ReachDisc { id: string; x: number; y: number; r: number }
/** Pairs (sorted ids) of discs that overlap, via a uniform grid of the given cell size. Same result as bruteForcePairs. */
export function gridPairs(items: readonly ReachDisc[], cell: number): [string, string][] {
  if (!(cell > 0)) throw Error('PHYSICS: grid cell must be positive');
  const grid = new Map<string, number[]>();
  items.forEach((it, i) => {
    for (let gx = Math.floor((it.x - it.r) / cell); gx <= Math.floor((it.x + it.r) / cell); gx++)
      for (let gy = Math.floor((it.y - it.r) / cell); gy <= Math.floor((it.y + it.r) / cell); gy++) {
        const k = `${gx},${gy}`, l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
      }
  });
  const seen = new Set<string>(), out: [string, string][] = [];
  for (const l of grid.values()) for (let a = 0; a < l.length; a++) for (let b = a + 1; b < l.length; b++) {
    const A = items[l[a]], B = items[l[b]], key = A.id < B.id ? `${A.id}\u0000${B.id}` : `${B.id}\u0000${A.id}`;
    if (seen.has(key)) continue; seen.add(key);
    if (Math.hypot(A.x - B.x, A.y - B.y) <= A.r + B.r) out.push(A.id < B.id ? [A.id, B.id] : [B.id, A.id]);
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
}
export function bruteForcePairs(items: readonly ReachDisc[]): [string, string][] {
  const out: [string, string][] = [];
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const A = items[a], B = items[b];
    if (Math.hypot(A.x - B.x, A.y - B.y) <= A.r + B.r) out.push(A.id < B.id ? [A.id, B.id] : [B.id, A.id]);
  }
  return out.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
}

// ---------------------------------------------------------------- object registry (no double carrying)

export function pickUp(objects: readonly PhysObject[], objectId: string, agentId: string): PhysObject[] {
  const o = objects.find((x) => x.id === objectId);
  if (!o) throw Error(`PHYSICS: object ${objectId} does not exist (objects are never created here)`);
  if (o.holder !== null && o.holder !== agentId) throw Error(`PHYSICS: object ${objectId} is already carried by ${o.holder} (no double carrying)`);
  if (objects.some((x) => x.id !== objectId && x.holder === agentId)) throw Error(`PHYSICS: ${agentId} already carries another object`);
  return objects.map((x) => (x.id === objectId ? { ...x, holder: agentId } : x));
}
export function drop(objects: readonly PhysObject[], objectId: string, agentId: string): PhysObject[] {
  const o = objects.find((x) => x.id === objectId);
  if (!o || o.holder !== agentId) throw Error(`PHYSICS: ${agentId} does not hold ${objectId}`);
  return objects.map((x) => (x.id === objectId ? { ...x, holder: null } : x));
}

// ---------------------------------------------------------------- simulation

interface RT {
  id: string; spec: SimAgentSpec; p: Passage; L: number; w: number; reach: number; free: number; travel: 1 | -1;
  s: number; v: number; mode: Mode; partner: string | null; retreat_s: number | null;
  /** backing out across lanes (then waits for the other to clear) / standing still until the other has made room */
  crossRetreat: boolean; waitRoom: boolean;
  /** standing still after a head-on contact until this time (contact time loss); null when not held */
  holdUntil: number | null;
  /** backing out behind another ant moving the same way in single file: walks no faster than it */
  pressOn: string | null;
  open: { t: number; s: number; v: number; cause: string | null; ref: string | null };
  ivs: MotionInterval[];
}
const sgn = (x: number): -1 | 0 | 1 => (x > 0 ? 1 : x < 0 ? -1 : 0);
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function simulate(cfg: SimConfig): SimResult {
  const g = cfg.geometry, H = cfg.window_s ?? 1, step = cfg.boundary_step_mm ?? 0.01;
  const issues = validateGeometry(g);
  if (issues.length) throw Error(`PHYSICS: invalid geometry: ${issues.map((i) => `${i.code} ${i.ref}`).join('; ')}`);
  if (!(cfg.horizon_s > 0) || !(H > 0)) throw Error('PHYSICS: horizon and window must be positive');
  // objects: every load must exist and be held by exactly that agent; nothing is created
  const objects = (cfg.objects ?? []).map((o) => ({ ...o }));
  const ids = new Set<string>();
  for (const a of cfg.agents) { if (ids.has(a.id)) throw Error(`PHYSICS: duplicate agent ${a.id}`); ids.add(a.id); }
  const loads = new Map<string, string>();
  for (const a of cfg.agents) if (a.load !== null) {
    const o = objects.find((x) => x.id === a.load);
    if (!o) throw Error(`PHYSICS: ${a.id} carries unknown object ${a.load}`);
    if (loads.has(a.load)) throw Error(`PHYSICS: object ${a.load} carried by both ${loads.get(a.load)} and ${a.id} (no double carrying)`);
    if (o.holder !== a.id) throw Error(`PHYSICS: object ${a.load} holder is ${o.holder}, not ${a.id}`);
    loads.set(a.load, a.id);
  }
  for (const o of objects) if (o.holder !== null && loads.get(o.id) !== o.holder) throw Error(`PHYSICS: object ${o.id} holder ${o.holder} does not carry it`);

  // canonical agent order: by id (never input order)
  const rts: RT[] = [...cfg.agents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((sp) => {
    const p = passageOf(g, sp.passage), Lp = laneLength(p);
    const ready = physicsReady(g, p.id);
    if (!ready.ready) throw Error(`PHYSICS: passage ${p.id} has unknown geometry: ${ready.unknown.join(', ')}`);
    if (!(sp.free_speed_mm_s > 0) || !(sp.body.length_mm > 0) || !(sp.body.width_mm > 0) || !(sp.body.contact_reach_mm >= 0)) throw Error(`PHYSICS: ${sp.id} needs positive speed, body length and width, non-negative reach`);
    if (sp.s_mm < 0 || sp.s_mm > Lp || sp.goal_s_mm < 0 || sp.goal_s_mm > Lp || (sp.goal_s_mm - sp.s_mm) * sp.dir < 0) throw Error(`PHYSICS: ${sp.id} start/goal inconsistent with passage ${p.id} and direction`);
    const lw = sp.load === null ? 0 : objects.find((o) => o.id === sp.load)!.width_mm;
    return { id: sp.id, spec: sp, p, L: sp.body.length_mm, w: Math.max(sp.body.width_mm, lw), reach: sp.body.contact_reach_mm, free: sp.free_speed_mm_s, travel: sp.dir, s: sp.s_mm, v: 0, mode: 'idle', partner: null, retreat_s: null, crossRetreat: false, waitRoom: false, holdUntil: null, pressOn: null, open: { t: 0, s: sp.s_mm, v: 0, cause: 'not_started', ref: null }, ivs: [] };
  });
  const byId = new Map(rts.map((a) => [a.id, a]));
  const events: PhysEvent[] = [];
  const stats = { windows: 0, steps: 0, pair_evaluations: 0, t_end_s: 0 };
  const enc = cfg.encounter;
  if (!enc || !['entry_yield', 'laden_priority'].includes(enc.priority)) throw Error('PHYSICS: encounter rules required (see interaction-candidates)');
  for (const [k, v] of [['entry_yield_probability', enc.entry_yield_probability], ['laden_yield_probability', enc.laden_yield_probability]] as const) if (!(v >= 0 && v <= 1)) throw Error(`PHYSICS: encounter.${k} must be in [0, 1]`);
  if (enc.inside_turn_back_probability !== null && !(enc.inside_turn_back_probability > 0 && enc.inside_turn_back_probability < 1)) throw Error('PHYSICS: inside_turn_back_probability must be in (0, 1) or null (at 1 both always turn back and never decide)');
  if (enc.contact_pause_s !== null && !(enc.contact_pause_s >= 0 && Number.isFinite(enc.contact_pause_s))) throw Error('PHYSICS: contact_pause_s must be ≥ 0 or null');
  // named outcome streams: keyed by the sorted pair, the n-th encounter of that pair, and a tag — never array order
  const encounterNo = new Map<string, number>();
  const nextEncounter = (a: string, b: string) => { const k = pairKey(a, b), n = (encounterNo.get(k) ?? 0) + 1; encounterNo.set(k, n); return n; };
  const draw = (tag: string, a: string, b: string, n: number, extra = '') => { const [x, y] = a < b ? [a, b] : [b, a]; return rng(hash32(`${cfg.seed}|physics.encounter.${tag}|${x}|${y}|${n}|${extra}`))(); };

  // narrow sections per (passage, threshold), cached
  const secCache = new Map<string, [number, number][]>();
  const sections = (p: Passage, T: number) => { const k = `${p.id}|${T}`; let v = secCache.get(k); if (!v) { v = narrowSections(g, p, T, step); secCache.set(k, v); } return v; };
  const narrowAt = (p: Passage, T: number, s: number) => sections(p, T).some(([a, b]) => a <= s + 1e-9 && b >= s - 1e-9);
  const narrowOver = (p: Passage, T: number, lo: number, hi: number) => sections(p, T).some(([a, b]) => a < hi - 1e-9 && b > lo + 1e-9);
  const sectionAt = (p: Passage, T: number, s: number) => sections(p, T).find(([a, b]) => a <= s + 1e-9 && b >= s - 1e-9) ?? null;
  // every boundary an agent's leading edge may cross (all pair thresholds and its own width) for re-check events
  const widths = [...new Set(rts.map((a) => a.w))].sort((a, b) => a - b);
  const boundaries = new Map<string, number[]>();
  for (const a of rts) {
    const key = `${a.p.id}|${a.w}`;
    if (boundaries.has(key)) continue;
    const Ts = [a.w, ...widths.map((w) => a.w + w)];
    boundaries.set(key, [...new Set(Ts.flatMap((T) => sections(a.p, T).flat()))].sort((x, y) => x - y));
  }
  const entranceBlocksOf = (a: RT) => g.entrances.filter((e) => e.passage_ref === a.p.id && e.aperture_width_mm !== null && e.aperture_width_mm < a.w).map((e) => ({ id: e.id, s: arcPositionOf(a.p, { x: e.position_mm[0], y: e.position_mm[1] }), ap: e.aperture_width_mm as number }));

  const eCache = new Map<string, { id: string; s: number; ap: number }[]>();
  const entranceBlocks = (a: RT) => { let v = eCache.get(a.id); if (!v) { v = entranceBlocksOf(a); eCache.set(a.id, v); } return v; };
  const pos = (a: RT) => positionAt(a.p, a.s);
  const ev = (t: number, kind: PhysEventKind, a: RT, other: RT | null, detail: string | null, certain: boolean | null = null) => {
    const q = pos(a), o = other ? pos(other) : q, m: [number, number, number] = [(q.x + o.x) / 2, (q.y + o.y) / 2, (q.z + o.z) / 2];
    events.push({ t_s: t, kind, agent: a.id, other: other?.id ?? null, passage: a.p.id, s_mm: a.s, position_mm: m, certain, detail, model_ref: COLLISION_MODEL_REF });
  };
  // ---- trajectory records (MV-1 MotionInterval format)
  const close = (a: RT, t: number) => {
    const o = a.open;
    if (t - o.t > T_EPS || Math.abs(a.s - o.s) > S_EPS) {
      const moving = o.v !== 0, dir = (moving ? sgn(o.v) : a.travel) as 1 | -1, st = positionAt(a.p, o.s), en = positionAt(a.p, a.s);
      const h = moving ? headingAt(a.p, o.s, dir) : null;
      a.ivs.push({ agent: a.id, passage: a.p.id, kind: moving ? 'move' : o.cause === null ? 'stop' : 'wait', cause: moving ? (o.cause === 'free' ? null : o.cause) : o.cause, cause_ref: o.ref, t_start_s: o.t, t_end_s: t, s_start_mm: o.s, s_end_mm: a.s, distance_mm: Math.abs(a.s - o.s), speed_mm_s: Math.abs(o.v), dir, heading: h ? [h.x, h.y, h.z] : null, start_mm: [st.x, st.y, st.z], end_mm: [en.x, en.y, en.z], model_ref: COLLISION_MODEL_REF });
    }
  };
  const setMotion = (a: RT, t: number, v: number, cause: string | null, ref: string | null) => {
    if (a.open.v === v && a.open.cause === cause && a.open.ref === ref) { a.v = v; return; }
    close(a, t); a.open = { t, s: a.s, v, cause, ref }; a.v = v;
  };
  const split = (a: RT, t: number) => { close(a, t); a.open = { ...a.open, t, s: a.s }; };
  const modeMotion = (a: RT, t: number) => {
    if (a.holdUntil !== null && a.holdUntil > t + T_EPS && !terminal(a)) return setMotion(a, t, 0, 'contact', a.partner);
    switch (a.mode) {
      case 'free': return setMotion(a, t, a.travel * a.free, 'free', null);
      case 'retreat': return setMotion(a, t, -a.travel * a.free, 'yield_back_out', a.partner);
      case 'yield_wait': return setMotion(a, t, 0, 'yield', a.partner);
      case 'cross_wait': return setMotion(a, t, 0, 'yield', a.partner);
      case 'blocked': return setMotion(a, t, 0, 'blocked', a.partner);
      case 'unresolved': return setMotion(a, t, 0, 'unresolved', a.partner);
      case 'arrived': return setMotion(a, t, 0, null, null);
      case 'idle': return setMotion(a, t, 0, 'not_started', null);
      case 'follow': return; // set by resolveFollow
    }
  };
  // ---- geometry of a pair on one lane
  const M = (a: RT, b: RT) => (a.L + b.L) / 2;
  const C = (a: RT, b: RT) => (a.L + b.L) / 2 + Math.max(a.reach, b.reach);
  const lateralCertain = (a: RT, b: RT) => usableWidth(g, a.p, a.s) < a.w + b.w + 2 * Math.max(a.reach, b.reach);
  /** the narrow region two touching or overlapping lane bodies share (null when they do not touch) */
  const overlap = (a: RT, b: RT): [number, number] | null => { const lo = Math.max(a.s - a.L / 2, b.s - b.L / 2), hi = Math.min(a.s + a.L / 2, b.s + b.L / 2); return hi >= lo - 1e-9 ? [lo, hi] : null; };
  const pinched = (a: RT, b: RT) => { const o = overlap(a, b); return !!o && (o[1] - o[0] <= 1e-9 ? narrowAt(a.p, a.w + b.w, (o[0] + o[1]) / 2) : narrowOver(a.p, a.w + b.w, o[0], o[1])); };
  /**
   * For two bodies that are just touching (gap = M): is the stretch they are about to share narrow? The shared stretch
   * grows from the touch point only on the side(s) of the body or bodies that are moving into the other, so a body
   * standing just outside a narrow part is not 'pinched' by one coming out of it.
   */
  const pinchedAhead = (a: RT, b: RT) => {
    const [lo, hi] = a.s < b.s ? [a, b] : [b, a], c = lo.s + lo.L / 2, d = 1e-6;
    const left = hi.v < 0 ? c - d : c, right = lo.v > 0 ? c + d : c;
    return left === right ? narrowAt(a.p, a.w + b.w, c) : narrowOver(a.p, a.w + b.w, left, right);
  };
  const sameLane = (a: RT, b: RT) => a.p.id === b.p.id;
  const terminal = (a: RT) => a.mode === 'arrived' || a.mode === 'blocked' || a.mode === 'unresolved';

  // ---- follow resolution: a follower walks no faster than the body in front of it (chains resolved in order)
  const resolveFollow = (t: number) => {
    for (let iter = 0; iter <= rts.length; iter++) {
      let changed = false;
      for (const f of rts) {
        if (f.mode !== 'follow') continue;
        if (f.holdUntil !== null && f.holdUntil > t + T_EPS) continue;     // standing still after a contact
        const ld = byId.get(f.partner!)!, gap = Math.abs(ld.s - f.s), m = f.travel, mm = M(f, ld);
        const ahead = (ld.s - f.s) * m > 0, touching = gap >= mm - 1e-9, vAlong = ld.v * m;
        const end = (why: string) => { f.mode = 'free'; f.partner = null; ev(t, 'follow_end', f, ld, why); modeMotion(f, t); changed = true; };
        if (touching && !ahead) { end('nothing in front any more'); continue; }
        // same directional test as the touch rule: is the stretch just ahead of the follower's front narrow for the pair?
        const fr = f.s + m * f.L / 2, ahead1 = m > 0 ? [fr, fr + 1e-6] : [fr - 1e-6, fr];
        if (touching && !narrowOver(f.p, f.w + ld.w, ahead1[0], ahead1[1])) { end('wide enough to pass'); continue; }
        if (touching && vAlong >= f.free) { end('front ant walks at least as fast'); continue; }
        // still overlapping (held at a narrow entry) or touching in a single-file section: never faster than the body in front
        const nv = touching ? m * Math.max(0, Math.min(f.free, vAlong)) : 0;
        if (f.v !== nv || (f.open.cause !== 'follow' && f.open.cause !== 'blocked_by')) { setMotion(f, t, nv, nv === 0 ? 'blocked_by' : 'follow', ld.id); changed = true; }
      }
      // backing out behind another ant moving the same way: no faster than it while they touch in single file
      for (const r of rts) {
        if (r.mode !== 'retreat' || !r.pressOn || (r.holdUntil !== null && r.holdUntil > t + T_EPS)) continue;
        // PH-P2D (#100): 'still pressed' is decided by the stretch the pair is about to share — just ahead of the contact
        // point (r's front in its walking direction m) — the same directional test as the follow release above. The old
        // closed test (pinched, ±1e-9 mm) still called the pair pinched AT the section boundary, so the scheduled boundary
        // event of r's front released nothing and the speed-up waited for the next unrelated event or a window end.
        const f = byId.get(r.pressOn)!, m = -r.travel, cpt = r.s + m * r.L / 2, ahead = m > 0 ? [cpt, cpt + 1e-6] : [cpt - 1e-6, cpt];
        const touching = Math.abs(f.s - r.s) <= M(r, f) + 1e-9 && (f.s - r.s) * m > 0 && narrowOver(r.p, r.w + f.w, ahead[0], ahead[1]);
        if (!touching || f.v * m >= r.free) { r.pressOn = null; if (r.v !== m * r.free) { modeMotion(r, t); changed = true; } continue; }
        const nv = m * Math.max(0, Math.min(r.free, f.v * m));
        if (r.v !== nv) { setMotion(r, t, nv, 'yield_back_out', r.partner); changed = true; }
      }
      if (!changed) return;
    }
  };

  // ---- stuck detection: a standing waiter whose partner has stopped for good, or a ring of standing waiters, can never
  // move again in this version: report it as `unresolved` (never a silent wait)
  const WAIT_MODES = new Set<Mode>(['follow', 'yield_wait', 'cross_wait']);
  /** whom a standing ant is waiting for: a waiting mode's partner, or the ant a standing backing-out ant is pressed behind */
  const waitPartner = (a: RT): string | null => (a.v !== 0 ? null : WAIT_MODES.has(a.mode) && a.partner ? a.partner : a.mode === 'retreat' && a.pressOn && !(a.holdUntil !== null) ? a.pressOn : null);
  const detectStuck = (t: number) => {
    for (let changed = true; changed;) {
      changed = false;
      for (const a of rts) {
        const wp = waitPartner(a);
        if (!wp) continue;
        const p = byId.get(wp)!;
        if (terminal(p)) { unresolved(t, a, p, `waits for ${p.id}, which has stopped for good (${p.mode})`); changed = true; continue; }
        const ring: RT[] = [a];
        let q = p;
        while (waitPartner(q) && !ring.includes(q)) { ring.push(q); q = byId.get(waitPartner(q)!)!; }
        if (q === a && ring.length > 1 && ring.every((r) => r.mode === 'follow' && sameLane(r, a))) {
          // a ring of ants all waiting abreast at the entry of a narrow part: one of them goes first (even chance, a
          // per-ant rank drawn for this instant; game assumption) and the others wait for it — a queue, not a deadlock
          const rank = (x: RT) => rng(hash32(`${cfg.seed}|physics.encounter.queue|${x.id}|ring|${t.toFixed(9)}`))();
          // only an ant whose way ahead is not blocked (a touching body in single file that is not moving away) can go first
          const blockedAhead = (r: RT) => rts.some((o) => o !== r && sameLane(o, r) && (o.s - r.s) * r.travel > 0 && o.v * r.travel <= 0 && Math.abs(o.s - r.s) <= M(r, o) + 1e-7 && (() => { const fr = r.s + r.travel * r.L / 2; return narrowOver(r.p, r.w + o.w, Math.min(fr, fr + r.travel * 1e-6), Math.max(fr, fr + r.travel * 1e-6)); })());
          const free = ring.filter((r) => !blockedAhead(r));
          if (!free.length) { for (let i = 0; i < ring.length; i++) if (!terminal(ring[i])) unresolved(t, ring[i], ring[(i + 1) % ring.length], `mutual wait, every ant blocked ahead (${ring.map((r) => r.id).join(' → ')})`); changed = true; continue; }
          const first = [...free].sort((x, y) => rank(y) - rank(x) || (x.id < y.id ? -1 : 1))[0];
          first.mode = 'free'; first.partner = null; modeMotion(first, t);
          ev(t, 'follow_end', first, null, `queue at the entry of a narrow part (${ring.map((r) => r.id).join(', ')}): ${free.length > 1 ? 'goes first by even chance (named stream physics.encounter.queue; game assumption)' : 'the only one not blocked ahead goes first'}`);
          for (const r of ring) if (r !== first) { r.partner = first.id; setMotion(r, t, 0, 'blocked_by', first.id); }
          changed = true; continue;
        }
        if (q === a && ring.length > 1) { for (let i = 0; i < ring.length; i++) if (!terminal(ring[i])) unresolved(t, ring[i], ring[(i + 1) % ring.length], `mutual wait (${ring.map((r) => r.id).join(' → ')} → ${a.id})`); changed = true; }
      }
    }
  };

  // ---- event prediction
  interface Cand { t: number; kind: string; a: string; b: string | null; data?: number }
  const intrinsic = (a: RT, t: number, out: Cand[]) => {
    if (a.mode === 'idle') { out.push({ t: Math.max(t, a.spec.start_t_s), kind: 'start', a: a.id, b: null }); return; }
    if (a.holdUntil !== null) { out.push({ t: Math.max(t, a.holdUntil), kind: 'hold_end', a: a.id, b: null }); return; }
    if (a.v === 0) return;
    const m = sgn(a.v), lead = a.s + m * a.L / 2;
    // PH-P2-C: the time at which the centre reaches arc length x is computed from the motion record's start (anchor) —
    // the same value whichever step (window) asks — and is never earlier than now
    const tAt = (x: number) => Math.max(t, a.open.t + (x - a.open.s) / a.v);
    const at = (x: number, kind: string, data?: number) => { const dt = (x - a.s) / a.v; if (dt > T_EPS || (dt >= 0 && Math.abs(x - a.s) > S_EPS)) out.push({ t: tAt(x), kind, a: a.id, b: null, data }); };
    if (a.mode === 'retreat') at(a.retreat_s!, 'retreat_done');
    else if (m === a.travel) at(a.spec.goal_s_mm, 'arrive');
    for (const x of vertexArcs(a.p)) if ((x - a.s) * m > S_EPS) at(x, 'vertex');
    // boundaries ahead of the leading edge, and one the edge is standing on when it starts to move (checked once per motion piece)
    for (const b of boundaries.get(`${a.p.id}|${a.w}`)!) {
      const dx = (b - lead) * m;
      if (dx > S_EPS) out.push({ t: tAt(b - m * a.L / 2), kind: 'boundary', a: a.id, b: null, data: b });
      else if (dx > -1e-7 && !boundaryDone.has(`${a.id}|${b}|${a.open.t}|${a.open.v}`)) out.push({ t, kind: 'boundary', a: a.id, b: null, data: b });
    }
    // own-width blocks: passage too narrow for this body/load, or an entrance aperture
    for (const [s0, s1] of sections(a.p, a.w)) { const edge = m > 0 ? s0 : s1, dx = (edge - lead) * m; if (dx > -S_EPS) { out.push({ t: dx > 0 ? tAt(edge - m * a.L / 2) : t, kind: 'wall', a: a.id, b: null, data: edge }); } }
    for (const e of entranceBlocks(a)) { const dx = (e.s - lead) * m; if (dx > -S_EPS) out.push({ t: dx > 0 ? tAt(e.s - m * a.L / 2) : t, kind: 'aperture', a: a.id, b: null, data: e.s }); }
  };
  const inContact = new Set<string>();
  const boundaryDone = new Set<string>();
  /** arc length of a at time T on its current motion record (PH-P2-C: from the record's start, never accumulated) */
  const sAt = (a: RT, T: number) => (a.open.v === 0 ? a.s : a.open.s + a.open.v * (T - a.open.t));
  const pairCands = (a: RT, b: RT, t: number, out: Cand[]) => {
    stats.pair_evaluations++;
    const key = pairKey(a.id, b.id);
    // PH-P2-C: a pair's event times are solved at a reference instant that does not depend on the step asking — the later
    // of the two motion records' starts — and are never earlier than now. Window boundaries therefore cannot move them.
    const tref = Math.max(a.open.t, b.open.t), sh = t - tref;
    if (sameLane(a, b)) {
      const d0 = b.s - a.s, rate = b.v - a.v, gap = Math.abs(d0), grate = gap <= S_EPS ? Math.abs(rate) : sgn(d0) * rate;   // at a centre crossing (|d0| ≤ S_EPS, sign is rounding) the pair is separating: never a stall
      const sig = gap <= S_EPS ? sgn(rate) : sgn(d0), gRef = sig * (sAt(b, tref) - sAt(a, tref));
      /** when the (signed-consistent) gap reaches `target`, solved from the reference instant */
      const when = (target: number) => (grate === 0 ? Infinity : Math.max(t, tref + (target - gRef) / grate));
      const c = C(a, b), mm = M(a, b);
      if (!inContact.has(key) && gap > c + S_EPS && grate < 0) out.push({ t: when(c), kind: 'contact_start', a: a.id, b: b.id });
      if (inContact.has(key) && grate > 0 && gap < c + CONTACT_EXIT_EPS) out.push({ t: when(c + CONTACT_EXIT_EPS), kind: 'contact_end', a: a.id, b: b.id });
      // a contact whose end was not scheduled (independent review of cdd0258, P2-a): end it now, never keep a stale one
      else if (inContact.has(key) && gap >= c + CONTACT_EXIT_EPS) out.push({ t, kind: 'contact_end', a: a.id, b: b.id });
      if (gap > mm + S_EPS && grate < 0) out.push({ t: when(mm), kind: 'touch', a: a.id, b: b.id });
      // already touching and still closing in a single-file stretch (e.g. a faster ant behind one that just started to back out)
      else if (Math.abs(gap - mm) <= 1e-7 && grate < 0 && pinchedAhead(a, b)) out.push({ t, kind: 'touch', a: a.id, b: b.id });
      // overlapping bodies sliding past each other: an event when their centres cross (re-evaluation point)
      // (also from exactly touching: in a wide lane two bodies may then overlap and pass — review of cdd0258, P2-a)
      if (gap <= mm + S_EPS && gap > S_EPS && grate < 0) out.push({ t: when(0), kind: 'centre', a: a.id, b: b.id });
      // a follower waiting for room (overlapping) gets an event when the room opens
      for (const [f, l] of [[a, b], [b, a]] as const) if (f.mode === 'follow' && f.partner === l.id && gap < mm - S_EPS && grate > 0) out.push({ t: when(mm), kind: 'room', a: f.id, b: l.id });
      // a backed-out ant resumes when the other has passed it (other's centre M beyond it, on its back side)
      for (const [y, p] of [[a, b], [b, a]] as const) if (y.mode === 'yield_wait' && y.partner === p.id) {
        const rel = (p.s - y.s) * y.travel, rrate = (p.v - y.v) * y.travel, relRef = (sAt(p, tref) - sAt(y, tref)) * y.travel;
        if (rel > -(mm + CONTACT_EXIT_EPS) && rrate < 0) out.push({ t: Math.max(t, tref + (-(mm + CONTACT_EXIT_EPS) - relRef) / rrate), kind: 'passed', a: y.id, b: p.id });
      }
    } else {
      // all planar and height quantities at the reference instant; τ below is relative to it, `sh` is now
      const pa = positionAt(a.p, sAt(a, tref)), pb = positionAt(b.p, sAt(b, tref));
      const ha = a.v ? headingAt(a.p, sAt(a, tref), sgn(a.v) as 1 | -1) : { x: 0, y: 0, z: 0 }, hb = b.v ? headingAt(b.p, sAt(b, tref), sgn(b.v) as 1 | -1) : { x: 0, y: 0, z: 0 };
      const abs = (τ: number) => Math.max(t, tref + τ);
      // Codex physics review f61db12, F1: bodies on different lanes interact only while on one height layer
      // (|dz| ≤ max(L) + LEVEL_EPS; stated simplification). dz changes linearly until the next event (vertices are events),
      // so the layer window [lo, hi] is exact; planar events are kept only inside it.
      const H = Math.max(a.L, b.L) + LEVEL_EPS, dz0 = pb.z - pa.z, dzr = hb.z * Math.abs(b.v) - ha.z * Math.abs(a.v);
      let lo = sh, hi = Infinity, off = false;
      if (dzr === 0) { if (Math.abs(dz0) > H - 1e-9) off = true; }   // a pair resting exactly on the layer edge is off it (as for the checker's |dz| ≤ L): no window-dependent flip on rounding
      else { const t1 = (-H - dz0) / dzr, t2 = (H - dz0) / dzr; lo = Math.max(sh, Math.min(t1, t2)); hi = Math.max(t1, t2); if (!(hi > lo + T_EPS)) off = true; }   // a layer stay shorter than T_EPS counts as off (no zero-time touch/release loop at the layer edge)
      // independent review of cdd0258, P2-b: a crossing waiter is released when the other is off its height layer — but only
      // if it stays off when the waiter walks on (a stopped waiter can let the other leave the layer for an instant and
      // walking would bring them back: that is no release). Otherwise the planar 'cleared' rule below still applies.
      const offNow = off || lo > sh + T_EPS;
      const offIfWalking = (y: RT, p: RT) => {
        const hy = headingAt(y.p, y.s, y.travel), hp = p === b ? hb : ha, d0 = pos(p).z - pos(y).z, r = hp.z * Math.abs(p.v) - hy.z * y.free;
        if (r === 0) return Math.abs(d0) > H;
        const t1 = (-H - d0) / r, t2 = (H - d0) / r, l = Math.max(0, Math.min(t1, t2)), h = Math.max(t1, t2);
        return !(h > l + T_EPS) || l > T_EPS;
      };
      for (const [y, p] of [[a, b], [b, a]] as const) if (y.mode === 'cross_wait' && y.partner === p.id && !y.waitRoom && offNow) {
        if (offIfWalking(y, p)) { out.push({ t, kind: 'cleared', a: y.id, b: p.id, data: 1 }); continue; }   // data 1: released by height, not by planar distance
        // not yet: while y stands, only p's height changes (linearly); re-evaluate when |dz| has grown past the layer limit
        // with the margin a walking y would need — so the release never waits for a window boundary
        const hy = headingAt(y.p, y.s, y.travel), hp = p === b ? hb : ha, d0 = (p === b ? pb : pa).z - (y === a ? pa : pb).z, pr = hp.z * Math.abs(p.v), r = pr - hy.z * y.free;
        const sg = d0 !== 0 ? Math.sign(d0) : Math.sign(pr), grow = sg * pr;
        if (grow > 0) { const need = H + Math.max(0, -sg * r) * 2 * T_EPS + 1e-12, tau = (need - sg * d0) / grow; if (tau > sh && Number.isFinite(tau)) out.push({ t: abs(tau), kind: 'relevel', a: a.id, b: b.id }); }
      }
      // leaving the layer later is a re-evaluation point (no state change by itself)
      if (!off && Number.isFinite(hi) && hi > sh + T_EPS) out.push({ t: abs(hi), kind: 'relevel', a: a.id, b: b.id });
      if (off && inContact.has(key)) out.push({ t, kind: 'contact_end', a: a.id, b: b.id });
      if (!off) {
      const dpx = pb.x - pa.x, dpy = pb.y - pa.y, dvx = hb.x * Math.abs(b.v) - ha.x * Math.abs(a.v), dvy = hb.y * Math.abs(b.v) - ha.y * Math.abs(a.v);
      // PH-P1-B: every planar decision below uses discEncounter (|r + v τ| < R) at the reference instant — contact start
      // (R = C), contact end (R = C + exit hysteresis), touch (R = M) and the crossing release — so the condition that
      // schedules an event is the condition that handles it, a graze (exact tangent) is neither, and no decision depends
      // on the step at which it is evaluated.
      const scale = Math.max(Math.abs(pa.x), Math.abs(pa.y), Math.abs(pb.x), Math.abs(pb.y));
      const encR = (R: number) => discEncounter(dpx, dpy, dvx, dvy, R, scale);
      const insideNow = (e: { t_in: number; t_out: number } | null) => !!e && e.t_in <= sh && sh < e.t_out;
      const c = C(a, b), mm = M(a, b);
      if (!inContact.has(key)) {
        const ce = encR(c);
        if (ce) { const st = Math.max(ce.t_in, lo), en = Math.min(ce.t_out, hi); if (st < en && en > sh) out.push({ t: abs(st), kind: 'contact_start', a: a.id, b: b.id }); }
      } else {
        const xe = encR(c + CONTACT_EXIT_EPS), end = Math.min(insideNow(xe) ? xe!.t_out : sh, hi);
        if (Number.isFinite(end)) out.push({ t: abs(end), kind: 'contact_end', a: a.id, b: b.id });
      }
      const me = encR(mm);
      if (lo > sh + T_EPS) {
        // the pair reaches one height layer later: if their footprints already overlap then, the ant cannot be put
        // anywhere consistent (vertical approach is not modelled) — stopped and reported, never passed through
        if (me && me.t_in <= lo + T_EPS && me.t_out > lo + T_EPS && lo < hi) out.push({ t: abs(lo), kind: 'layer_overlap', a: a.id, b: b.id });
        else if (me && me.t_in > lo && me.t_in < hi) out.push({ t: abs(me.t_in), kind: 'disc_touch', a: a.id, b: b.id });
      } else if (me) {
        // on the layer now: the bodies reach distance M at τ_in; if τ_in is now or past (touching within rounding) and the
        // pair is still closing (before the midpoint of the interval), the touch is handled now
        if (me.t_in > sh) { if (me.t_in < hi) out.push({ t: abs(me.t_in), kind: 'disc_touch', a: a.id, b: b.id }); }
        else if (sh < (me.t_in + me.t_out) / 2 && hi > sh + T_EPS) out.push({ t, kind: 'disc_touch', a: a.id, b: b.id });
      }
      for (const [y, p] of [[a, b], [b, a]] as const) if (y.mode === 'cross_wait' && y.partner === p.id && !y.waitRoom) {
        // local resume (on one layer): the other is out of antennal reach (distance ≥ C) and not approaching; off the layer
        // the release above applies
        // PH-P1-A: 'out of reach and not approaching' is decided for the motion y would START now: y walks on at the earliest
        // instant from which walking (at its free speed along its heading) would not bring it within C + exit margin of p,
        // given p's present velocity (sensed locally; game assumption). The old rule (release at p's closest approach to
        // the STANDING y) let y walk into p again after 1e-6 mm when the reach was 0, a near-zero-time yield loop.
        const py = y === a ? pa : pb, pp = p === a ? pa : pb, hp = p === a ? ha : hb, hy = headingAt(y.p, y.s, y.travel);
        const tr = releaseTime(pp.x - py.x, pp.y - py.y, hp.x * Math.abs(p.v), hp.y * Math.abs(p.v), hy.x * y.free, hy.y * y.free, C(y, p) + CONTACT_EXIT_EPS, scale, sh);
        if (tr !== null) out.push({ t: abs(tr), kind: 'cleared', a: y.id, b: p.id, data: 2 });   // data 2: release decided by the scheduled prediction
      }
      }
    }
  };

  /**
   * PH-P1-A: arc length behind y (opposite to its walking direction) where y's centre is at least `need` (planar) from the
   * line o is heading along — the half-line from o's centre in o's walking direction, i.e. the conflict region o's body
   * sweeps while it walks straight on. Backing off only out of antennal reach of o's current POSITION (the old rule) let
   * o touch y again after a step of the size of the reach (≈ 2e-6 mm when the reach is 0), so the two could repeat the
   * yield hundreds of thousands of times. o's heading is sensed by touch (game assumption; o's route and goal are NOT
   * used). Numerical scan (boundary_step_mm) + bisection, as before; null when y's lane ends first.
   */
  const backOffFromLine = (y: RT, o: RT, need: number): number | null => {
    const m = (sgn(y.v) || y.travel) as 1 | -1, Lp = laneLength(y.p), po = pos(o), ho = headingAt(o.p, o.s, sgn(o.v) as 1 | -1), hl = Math.hypot(ho.x, ho.y);
    const ux = hl > 0 ? ho.x / hl : 0, uy = hl > 0 ? ho.y / hl : 0;
    const f = (s: number) => {
      const q = positionAt(y.p, s), dx = q.x - po.x, dy = q.y - po.y, lam = dx * ux + dy * uy;
      return (lam <= 0 ? Math.hypot(dx, dy) : Math.abs(dx * uy - dy * ux)) >= need;
    };
    let prev = y.s;
    for (let k = 1; ; k++) {
      const s = y.s - m * k * step;
      if (s < 0 || s > Lp) return null;
      if (f(s)) { let lo = prev, hi = s; for (let i = 0; i < 80; i++) { const mid = (lo + hi) / 2; if (f(mid)) hi = mid; else lo = mid; } return hi; }
      prev = s;
    }
  };
  /**
   * PH-P1-A progress invariant: after y has backed off out of o's heading line, o cannot touch y again while y stands
   * there and o walks on along the same line (a sub-ray of the one y left). A second press of the same pair is therefore
   * legal only if y has moved since, or o has turned (another heading or direction) or is behind the point where it
   * pressed. Anything else is a yield loop without progress and stops the run with an error, never a silent repeat.
   */
  const releaseLog = new Map<string, { t: number; oT: number; oV: number }>();   // t: the release instant (= y's new motion record start)
  const pressLog = new Map<string, PressRecord & { t: number }>();
  const checkPressProgress = (t: number, w: RT, o: RT) => {
    const k = `${w.id}|${o.id}`, rec = pressLog.get(k), h = headingAt(o.p, o.s, sgn(o.v) as 1 | -1);
    if (rec && pressWithoutProgress(rec, { wS: w.s, oS: o.s, dir: sgn(o.v), hx: h.x, hy: h.y }))
      throw Error(`PHYSICS: no event progress at t=${t} s: ${w.id} is pressed again by ${o.id} (last at t=${rec.t} s) while standing where it backed off out of ${o.id}'s heading line, and ${o.id} has not turned (crossing yield loop; PH-P1-A invariant)`);
  };
  /**
   * Where x steps back to when it gives way: just outside the single-file section (threshold T) that contains `at`, on the
   * side it came from, at a place wide enough to wait beside the passage. Local: the ant walks back until the passage
   * widens (it feels the walls). null when there is no such place (narrow up to the passage end, or another pinch).
   */
  const backOutPlan = (x: RT, T: number, at: number): { target: number; dist: number } | null => {
    const sec = sectionAt(x.p, T, at);
    if (!sec) return null;
    const m = (sgn(x.v) || x.travel) as 1 | -1, back = m > 0 ? sec[0] : sec[1], Lp = laneLength(x.p);
    if ((m > 0 && back <= 1e-9) || (m < 0 && back >= Lp - 1e-9)) return null;
    const target = back - m * (EDGE_EPS + x.L / 2);
    if (target < 0 || target > Lp) return null;
    if (narrowOver(x.p, T, target - x.L / 2, target + x.L / 2)) return null;
    if ((target - x.s) * m > 0) return null;
    return { target, dist: Math.abs(x.s - target) };
  };
  // ---- event handling
  // Same-instant priority (PH-P2-B): at one instant events are handled by kind (KIND_ORDER: motion bookkeeping, then
  // releases, then contact bookkeeping before obstruction handling), then by agent id, other id, data and time — a total
  // order that never depends on array or insertion order.
  const candOrder = (x: Cand, y: Cand) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) || (x.a < y.a ? -1 : x.a > y.a ? 1 : 0) || ((x.b ?? '') < (y.b ?? '') ? -1 : (x.b ?? '') > (y.b ?? '') ? 1 : 0) || (x.data ?? -Infinity) - (y.data ?? -Infinity) || x.t - y.t;
  const KIND_ORDER = ['vertex', 'hold_end', 'start', 'arrive', 'retreat_done', 'wall', 'aperture', 'passed', 'cleared', 'room', 'centre', 'contact_end', 'contact_start', 'boundary', 'touch', 'disc_touch', 'layer_overlap', 'relevel'];
  const unresolved = (t: number, x: RT, y: RT, why: string) => {
    for (const z of [x, y]) if (!terminal(z)) { z.mode = 'unresolved'; z.partner = z === x ? y.id : x.id; z.holdUntil = null; modeMotion(z, t); }
    ev(t, 'unresolved', x, y, why);
  };
  const handle = (c: Cand, t: number) => {
    const a = byId.get(c.a)!, b = c.b ? byId.get(c.b)! : null;
    switch (c.kind) {
      case 'vertex': if (a.v !== 0) split(a, t); return;
      case 'hold_end': if (a.holdUntil !== null) { a.holdUntil = null; if (!terminal(a)) modeMotion(a, t); } return;
      case 'start': if (a.mode === 'idle') {
        // Codex physics review F3: an ant already at its goal arrives at its start time and never moves
        if (Math.abs(a.spec.goal_s_mm - a.s) <= S_EPS) { a.s = a.spec.goal_s_mm; a.mode = 'arrived'; modeMotion(a, t); ev(t, 'start', a, null, null); ev(t, 'arrive', a, null, 'already at its goal'); return; }
        a.mode = 'free'; modeMotion(a, t); ev(t, 'start', a, null, null);
      } return;
      case 'arrive': if (a.mode === 'free' || a.mode === 'follow') { a.s = a.spec.goal_s_mm; a.mode = 'arrived'; a.partner = null; modeMotion(a, t); ev(t, 'arrive', a, null, null); } return;
      case 'retreat_done': if (a.mode === 'retreat') {
        const p = byId.get(a.partner!)!;
        if (a.crossRetreat) {
          a.s = a.retreat_s!; a.crossRetreat = false; a.mode = 'cross_wait'; modeMotion(a, t); ev(t, 'cross_wait', a, p, 'backed off out of the line the other is heading along; waits until the other is out of reach and not approaching');
          if (p.mode === 'cross_wait' && p.partner === a.id && p.waitRoom) { p.mode = 'free'; p.partner = null; p.waitRoom = false; modeMotion(p, t); ev(t, 'cross_resume', p, a, 'room made'); }
          return;
        }
        a.s = a.retreat_s!; a.mode = 'yield_wait'; modeMotion(a, t); ev(t, 'yield_hold', a, p, `waiting at s=${a.s.toFixed(6)} outside the narrow section`);
        if ((p.s - a.s) * a.travel <= -M(a, p)) { a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'yield_resume', a, p, 'the other had already passed'); }
      } return;
      case 'wall': case 'aperture': if (!terminal(a) && a.v !== 0) {
        a.mode = 'blocked'; a.partner = null; modeMotion(a, t);
        ev(t, 'blocked', a, null, c.kind === 'wall' ? `passage narrower than effective width ${a.w} mm (body ${a.spec.body.width_mm} mm${a.spec.load ? `, load ${a.spec.load}` : ''})` : `entrance aperture narrower than effective width ${a.w} mm${a.spec.load ? ` (load ${a.spec.load})` : ''}`);
      } return;
      case 'passed': if (a.mode === 'yield_wait' && a.partner === b!.id) { a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'yield_resume', a, b, null); } return;
      case 'cleared': if (a.mode === 'cross_wait' && a.partner === b!.id && !a.waitRoom && (c.data === 1 || c.data === 2)) {
        // data 1: the other is off the height layer; data 2: walking on from now cannot bring the two within reach (both
        // decided by the scheduler from the present motions, so the handler does not re-test them with another tolerance)
        a.mode = 'free'; a.partner = null; modeMotion(a, t); ev(t, 'cross_resume', a, b, null);
        if (c.data === 2) releaseLog.set(`${a.id}|${b!.id}`, { t, oT: b!.open.t, oV: b!.v });
      } return;
      case 'room': case 'centre': return; // velocities are re-resolved after every step
      case 'contact_start': { const k = pairKey(a.id, b!.id); if (!inContact.has(k)) { inContact.add(k); ev(t, 'contact_start', a, b, null, sameLane(a, b!) ? lateralCertain(a, b!) : null); } return; }
      case 'contact_end': { const k = pairKey(a.id, b!.id); if (inContact.delete(k)) ev(t, 'contact_end', a, b, null); return; }
      case 'boundary': {
        // the leading edge of a reaches a narrow-section boundary: a body beside it that covers that point must not be
        // squeezed into the narrow part together with it. If both edges arrive at the same point together, the named
        // stream decides who waits (never array order).
        if (a.v === 0) return;
        const bnd = c.data as number, m = sgn(a.v);
        boundaryDone.add(`${a.id}|${bnd}|${a.open.t}|${a.open.v}`);
        for (const o of rts) {
          if (o === a || !sameLane(a, o)) continue;
          if (o.mode === 'follow' && o.partner === a.id) {
            // o is already waiting for a. Fine only if o's body ends at the boundary; if it reaches into the narrow part,
            // a would squeeze in beside it: report, never overlap
            const oFar = o.s + m * o.L / 2;
            if ((oFar - bnd) * m > 1e-9 && Math.abs(o.s - a.s) < M(a, o) - S_EPS && narrowAt(a.p, a.w + o.w, bnd + m * EDGE_EPS)) { unresolved(t, a, o, 'would enter a narrow section beside an ant that is waiting for it'); return; }
            continue;
          }
          if (Math.abs(o.s - a.s) >= M(a, o) - S_EPS) continue;               // not beside a
          if (!(o.s - o.L / 2 <= bnd + 1e-9 && bnd - 1e-9 <= o.s + o.L / 2)) continue;
          if (!narrowAt(a.p, a.w + o.w, bnd + m * EDGE_EPS)) continue;
          const oLead = o.s + sgn(o.v || o.travel) * o.L / 2, together = sgn(o.v) === m && Math.abs(oLead - bnd) <= 1e-9;
          // arriving together: who goes first is an even chance, drawn as a per-ant rank for this entry and instant so that
          // three or more ants arriving together get one consistent order (pairwise coin flips could form a ring)
          const rank = (x: RT) => rng(hash32(`${cfg.seed}|physics.encounter.queue|${x.id}|${bnd}|${t.toFixed(9)}`))();
          const waiter = together && rank(o) < rank(a) ? o : a, other = waiter === a ? o : a;
          if (waiter.mode === 'retreat') { unresolved(t, waiter, other, 'backing-out ant squeezed against another body'); return; }
          waiter.mode = 'follow'; waiter.partner = other.id;
          ev(t, 'obstruction', waiter, other, `abreast at the entry of a narrow section: waits for room${together ? ' (arrived together; order by named stream physics.encounter.queue)' : ''}`);
          ev(t, 'follow_start', waiter, other, null);
          setMotion(waiter, t, 0, 'blocked_by', other.id);
          if (waiter === a) return;
        }
        return;
      }
      case 'touch': {
        if (!b || !(Math.abs(Math.abs(a.s - b.s) - M(a, b)) <= 1e-7 ? pinchedAhead(a, b) : pinched(a, b))) return;   // wide here: they pass beside each other
        const [lo, hi] = a.s < b.s ? [a, b] : [b, a];
        ev(t, 'obstruction', lo, hi, `bodies touch in a section narrower than ${(a.w + b.w).toFixed(3)} mm`);
        // an ant that is giving way (backing out) backs into a nestmate facing the same way: that one turns back too
        // (chain back-out; local: it is pushed by the body in front of it; game assumption)
        for (const [r, o] of [[lo, hi], [hi, lo]] as const) if (r.mode === 'retreat' && !r.crossRetreat && sgn(r.v) === -r.travel && (o.s - r.s) * sgn(r.v) > 0) {
          if (sgn(o.v) === sgn(r.v)) { if (r.pressOn !== o.id) { r.pressOn = o.id; ev(t, 'follow_start', r, o, `backing out behind ${o.mode === 'retreat' ? 'another backing-out ant' : 'an ant walking the same way'}: no faster than it (single file)`); } return; }
          if (o.travel !== r.travel || !['free', 'follow', 'yield_wait'].includes(o.mode)) { unresolved(t, r, o, `backing-out ant blocked by ${o.id} (${o.mode})`); return; }
          const passer = byId.get(r.partner!)!, plan = backOutPlan(o, o.w + Math.max(r.w, passer.w), o.s + o.travel * o.L / 2);
          if (!plan) { unresolved(t, r, o, 'chain back-out: no wide place behind'); return; }
          o.mode = 'retreat'; o.partner = passer.id; o.retreat_s = plan.target; modeMotion(o, t);
          ev(t, 'yield_start', o, r, `turns back ${plan.dist.toFixed(6)} mm because ${r.id}, giving way to ${passer.id}, backs into it (chain back-out; game assumption)`);
          return;
        }
        if (lo.v > 0 && hi.v < 0) {
          // head-on where two cannot pass: decide locally who gives way, after the time lost per contact
          if (!['free', 'follow'].includes(lo.mode) || !['free', 'follow'].includes(hi.mode)) { unresolved(t, lo, hi, `head-on while ${lo.mode}/${hi.mode}`); return; }
          const T = a.w + b.w, touchS = lo.s + lo.L / 2, sec = sectionAt(a.p, T, touchS);
          const n = nextEncounter(lo.id, hi.id);
          const wholly = (x: RT) => !!sec && x.s - x.L / 2 >= sec[0] - 1e-9 && x.s + x.L / 2 <= sec[1] + 1e-9;
          const laden = (x: RT) => x.spec.load !== null;
          let y: RT | null = null, rule = '', rounds = 1;
          if (enc.priority === 'laden_priority' && laden(lo) !== laden(hi)) {
            const unl = laden(lo) ? hi : lo, ld = unl === lo ? hi : lo;
            y = draw('laden', lo.id, hi.id, n) < enc.laden_yield_probability ? unl : ld;
            rule = `laden priority (Atta colombica R381; non-species candidate, p=${enc.laden_yield_probability}): ${y === unl ? 'the unladen ant gives way' : 'the laden ant gives way'}`;
          } else if (wholly(lo) !== wholly(hi)) {
            const entering = wholly(lo) ? hi : lo, inside = entering === lo ? hi : lo;
            y = draw('entry', lo.id, hi.id, n) < enc.entry_yield_probability ? entering : inside;
            rule = `entry yield (Lasius niger R380; non-species candidate, p=${enc.entry_yield_probability}): ${y === entering ? 'the ant not yet inside gives way' : 'the ant inside gives way'}`;
          } else if (!wholly(lo) && !wholly(hi)) {
            y = draw('even', lo.id, hi.id, n) < 0.5 ? lo : hi;
            rule = 'both at the entry: even chance (no study; game assumption)';
          } else {
            const p = enc.inside_turn_back_probability;
            if (p === null) { unresolved(t, lo, hi, 'head-on with both wholly inside a single-file section: no studied rule and inside_turn_back_probability is null'); return; }
            for (rounds = 1; rounds <= 10000; rounds++) {
              const tl = draw('inside', lo.id, hi.id, n, `${lo.id}#${rounds}`) < p, th = draw('inside', lo.id, hi.id, n, `${hi.id}#${rounds}`) < p;
              if (tl !== th) { y = tl ? lo : hi; break; }
            }
            if (!y) { unresolved(t, lo, hi, 'no turn-back decision after 10000 contacts'); return; }
            rule = `both wholly inside: each turns back with probability ${p} per contact (no study; game assumption); decided at contact ${rounds}`;
          }
          let other = y === lo ? hi : lo, plan = backOutPlan(y, T, touchS);
          if (!plan) {
            const alt = backOutPlan(other, T, touchS);
            if (!alt) { unresolved(t, lo, hi, 'head-on with no wide place behind either ant'); return; }
            rule += `; ${y.id} has no wide place behind it, so ${other.id} gives way`;
            [y, other] = [other, y]; plan = alt;
          }
          const hold = (enc.contact_pause_s ?? 0) * rounds;
          y.mode = 'retreat'; y.partner = other.id; y.retreat_s = plan.target;
          if (other.mode === 'follow') { other.mode = 'free'; other.partner = null; }
          if (hold > 0) { y.holdUntil = t + hold; other.holdUntil = t + hold; }
          modeMotion(y, t); modeMotion(other, t);
          ev(t, 'yield_start', y, other, `${rule}; gives way by stepping back ${plan.dist.toFixed(6)} mm out of the narrow part${hold > 0 ? `; both stand ${hold.toFixed(3)} s for the contact${rounds > 1 ? `s (${rounds} × ${enc.contact_pause_s} s)` : ` (${enc.contact_pause_s} s, non-species candidate)`}` : '; contact time loss not modelled'}`);
          return;
        }
        // same direction, or one standing: the one closing in from behind follows
        const rear = lo.v > 0 ? lo : hi;
        const front = rear === lo ? hi : lo;
        if (rear.mode === 'retreat' || sgn(rear.v) !== rear.travel) { unresolved(t, rear, front, 'backing-out ant blocked from behind'); return; }
        if (rear.mode === 'follow' && rear.partner === front.id) return;
        rear.mode = 'follow'; rear.partner = front.id; ev(t, 'follow_start', rear, front, null);
        return;
      }
      case 'relevel': return; // a pair leaves a height layer: re-evaluation point only
      case 'layer_overlap': {
        if (!b || terminal(a) && terminal(b)) return;
        ev(t, 'obstruction', a, b, 'reaches the same height layer while the footprints overlap');
        unresolved(t, a, b, 'reaches the same height layer as the other ant while their footprints already overlap (vertical approach is not modelled)');
        return;
      }
      case 'disc_touch': {
        if (!b) return;
        ev(t, 'obstruction', a, b, 'bodies touch across lanes');
        const pa = pos(a), pb = pos(b);
        // local: an ant 'has the other ahead' when the other is in the forward half of its antennae
        const ahead = (x: RT, q: Vec3, r: Vec3) => { if (x.v === 0) return false; const h = headingAt(x.p, x.s, sgn(x.v) as 1 | -1); return h.x * (r.x - q.x) + h.y * (r.y - q.y) > 1e-12; };
        const ha = ahead(a, pa, pb), hb = ahead(b, pb, pa);
        // a waiting ant pressed by the one it waits for backs off out of antennal reach; the other waits until it has
        for (const [w, o] of [[a, b], [b, a]] as const) if (w.mode === 'cross_wait' && w.partner === o.id && !w.waitRoom && (o === a ? ha : hb)) {
          checkPressProgress(t, w, o);
          const back = backOffFromLine(w, o, C(w, o) + 2 * CONTACT_EXIT_EPS);
          if (back === null) { unresolved(t, w, o, 'pressed at a crossing with no room to back off out of the line the other is heading along'); return; }
          const h = headingAt(o.p, o.s, sgn(o.v) as 1 | -1);
          pressLog.set(`${w.id}|${o.id}`, { wS: back, oS: o.s, dir: sgn(o.v), hx: h.x, hy: h.y, t });
          w.mode = 'retreat'; w.crossRetreat = true; w.retreat_s = back; modeMotion(w, t);
          o.mode = 'cross_wait'; o.partner = w.id; o.waitRoom = true; modeMotion(o, t);
          ev(t, 'yield_start', w, o, `pressed by the ant it waits for: backs off ${Math.abs(w.s - back).toFixed(6)} mm until it is out of antennal reach of the line the other is heading along (sensed by touch; game assumption); the other waits`);
          return;
        }
        if (!ha && !hb) return;                                    // neither is moving towards the other
        if (a.mode === 'retreat' || b.mode === 'retreat') { unresolved(t, a, b, 'backing-out ant blocked across lanes'); return; }
        let y: RT, why: string;
        if (ha && hb) { y = draw('cross', a.id, b.id, nextEncounter(a.id, b.id)) < 0.5 ? a : b; why = 'both have the other ahead: even chance (no study; game assumption)'; }
        else { y = ha ? a : b; why = 'it has the other ahead of its antennae (local; game assumption)'; }
        const other = y === a ? b : a;
        if (terminal(other)) { unresolved(t, y, other, `blocked across lanes by an ant that has stopped for good (${other.mode})`); return; }
        // PH-P1-A progress invariant: y was released from waiting for `other` because walking on could not bring them within
        // reach; touching it again with neither motion changed since is a yield loop without progress — stop with an error
        const rel = releaseLog.get(`${y.id}|${other.id}`);
        if (rel && releaseWithoutProgress(rel, { yT: y.open.t, oT: other.open.t, oV: other.v })) throw Error(`PHYSICS: no event progress at t=${t} s: ${y.id} touches ${other.id} again after being released at t=${rel.t} s with neither motion changed (crossing release loop; PH-P1-A invariant)`);
        y.mode = 'cross_wait'; y.partner = other.id; modeMotion(y, t);
        ev(t, 'cross_wait', y, other, `stops: ${why}`);
        return;
      }
    }
  };

  // ---- initial state checks: no body starts where it does not fit; no two bodies start in mutually exclusive positions
  for (const a of rts) if (narrowOver(a.p, a.w, a.s - a.L / 2, a.s + a.L / 2)) throw Error(`PHYSICS: ${a.id} starts in a section narrower than its width ${a.w} mm`);
  for (let i = 0; i < rts.length; i++) for (let j = i + 1; j < rts.length; j++) {
    const a = rts[i], b = rts[j];
    if (sameLane(a, b) ? (Math.abs(a.s - b.s) < M(a, b) - S_EPS && pinched(a, b)) : (a.p.id !== b.p.id && Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y) < M(a, b) - S_EPS && Math.abs(pos(a).z - pos(b).z) <= Math.max(a.L, b.L))) throw Error(`PHYSICS: ${a.id} and ${b.id} start in the same space`);
    const gap = sameLane(a, b) ? Math.abs(a.s - b.s) : Math.hypot(pos(a).x - pos(b).x, pos(a).y - pos(b).y);
    if (gap <= C(a, b) && (sameLane(a, b) || Math.abs(pos(a).z - pos(b).z) <= Math.max(a.L, b.L) + LEVEL_EPS)) inContact.add(pairKey(a.id, b.id));
  }

  // ---- main loop
  let t = 0, lastT = -1, sameT = 0;
  const vmax = Math.max(...rts.map((a) => a.free));
  // PH-P2D (#100) / PH-P2-B: the clock stops ONLY at event instants. A broadphase window end is not an evaluation step:
  // when no candidate lies at or before it, the window is extended (pairs re-collected from the positions at the current
  // event instant, with a larger reach) and the SAME instant is evaluated again — nothing is moved and nothing is
  // handled at a window end. So every tolerance-based 'now' test (touching within 1e-7 mm, a boundary under the front,
  // an event 'already passed') is only ever evaluated at an event instant, whatever window_s is.
  let wEnd = Math.min(H, cfg.horizon_s), wStart = 0, pairs: (readonly [RT, RT])[] = [], pairKeys = new Set<string>(), pairsAt = -1;
  const collectPairs = () => {
    stats.windows++;
    // broadphase: any pair that can come within contact range in [from, wEnd + SAME_INSTANT] (conservative reach discs;
    // the SAME_INSTANT margin covers every candidate that can join a same-instant group). `from` is the later of now and
    // the previous window end: no event lies between them, so every motion is unchanged there and the disc centres are
    // the analytic positions at `from` (sAt; nothing is moved).
    const from = Math.max(t, wStart), span = wEnd + SAME_INSTANT(wEnd) - from;
    const discs: ReachDisc[] = rts.map((a) => { const q = positionAt(a.p, sAt(a, from)); return { id: a.id, x: q.x, y: q.y, r: vmax * span + a.L / 2 + a.reach }; });
    pairs = gridPairs(discs, Math.max(1e-6, 2 * Math.max(...discs.map((d) => d.r)))).map(([x, y]) => [byId.get(x)!, byId.get(y)!] as const);
    pairKeys = new Set(pairs.map(([x, y]) => pairKey(x.id, y.id))); pairsAt = wEnd;
  };
  // a waiting ant is always evaluated with the ant it waits for, however far apart: its release must not depend on the
  // broadphase window (independent review of cdd0258: with small windows the pair dropped out and the waiter was stuck)
  const withPartners = () => { const out = [...pairs]; const seen = new Set(pairKeys); const add = (x: RT, y: RT) => { const k = pairKey(x.id, y.id); if (!seen.has(k)) { seen.add(k); out.push(x.id < y.id ? [x, y] as const : [y, x] as const); } };
    for (const x of rts) if (x.partner && !terminal(x)) add(x, byId.get(x.partner)!);
    // pairs in contact too: their contact_end must come at its own time, not when the broadphase next picks them up
    for (const k of inContact) { const [i, j] = k.split('|'); const x = byId.get(i), y = byId.get(j); if (x && y) add(x, y); }
    return out; };
  while (t < cfg.horizon_s && rts.some((a) => !terminal(a))) {
    if (pairsAt !== wEnd) collectPairs();
    const cands: Cand[] = [];
    for (const a of rts) intrinsic(a, t, cands);
    for (const [a, b] of withPartners()) pairCands(a, b, t, cands);
    let tmin = Infinity;
    for (const c of cands) if (c.t < tmin) tmin = c.t;
    if (!(tmin <= wEnd)) {
      if (wEnd >= cfg.horizon_s) {
        // nothing more before the horizon: move to it without handling anything (an event after it is not handled)
        for (const a of rts) if (a.open.v !== 0) a.s = a.open.s + a.open.v * (cfg.horizon_s - a.open.t);
        t = cfg.horizon_s; break;
      }
      wStart = wEnd; wEnd = Math.min(wEnd + H, cfg.horizon_s);   // extend the broadphase window; the clock does not move
      continue;
    }
    stats.steps++;
    const tn = Math.max(t, tmin);
    // PH-P2-C: positions are computed from the start of the current motion record (anchor), its velocity and the
    // elapsed time — never accumulated step by step
    for (const a of rts) if (a.open.v !== 0) a.s = a.open.s + a.open.v * (tn - a.open.t);
    t = tn;
    // events at one instant: within SAME_INSTANT(t) of the earliest (a few ulps: different formulas for one instant)
    const due = cands.filter((c) => c.t <= tn + SAME_INSTANT(tn)).sort(candOrder);
    for (const c of due) handle(c, t);
    resolveFollow(t);
    detectStuck(t);
    if (stats.steps > 1e7) throw Error('PHYSICS: event budget exceeded (Zeno or runaway)');
    if (t === lastT) { if (++sameT > 10000) throw Error(`PHYSICS: more than 10000 steps at t=${t} s (a rule loop without progress)`); } else { lastT = t; sameT = 0; }
    // the run ends at the event that stopped the last ant, not at the end of the window (review of cdd0258, P3-1)
    if (rts.every((x) => terminal(x))) break;
  }
  stats.t_end_s = t;
  for (const a of rts) close(a, t);
  const final: SimResult['final'] = {};
  for (const a of rts) final[a.id] = { s_mm: a.s, mode: a.mode, t_s: t };
  const intervals: Record<string, MotionInterval[]> = {};
  for (const a of rts) intervals[a.id] = a.ivs;
  return { intervals, events, final, stats };
}

/**
 * Independent check of a simulation result (tests): samples every trajectory at every record boundary and every dt and
 * verifies that no two bodies are in mutually exclusive positions (21 samples per overlap region), no body is in a section
 * too narrow for it (21 samples per body), and no body straddles an entrance narrower than it. Returns violations.
 */
export function checkExclusion(cfg: SimConfig, res: SimResult, dt: number): string[] {
  const g = cfg.geometry, out: string[] = [], specs = new Map(cfg.agents.map((a) => [a.id, a]));
  const width = (id: string) => { const a = specs.get(id)!; const o = a.load ? cfg.objects!.find((x) => x.id === a.load)! : null; return Math.max(a.body.width_mm, o?.width_mm ?? 0); };
  const times = new Set<number>();
  for (const ivs of Object.values(res.intervals)) for (const r of ivs) { times.add(r.t_start_s); times.add(r.t_end_s); }
  for (let t = 0; t <= res.stats.t_end_s; t += dt) times.add(t);
  const sAt = (id: string, t: number) => { const ivs = res.intervals[id]; for (const r of ivs) if (t >= r.t_start_s - 1e-12 && t <= r.t_end_s + 1e-12) { const f = r.t_end_s === r.t_start_s ? 1 : (t - r.t_start_s) / (r.t_end_s - r.t_start_s); return r.s_start_mm + (r.s_end_mm - r.s_start_mm) * Math.max(0, Math.min(1, f)); } return ivs.length ? ivs[ivs.length - 1].s_end_mm : specs.get(id)!.s_mm; };
  const ids = [...specs.keys()].sort();
  for (const t of [...times].sort((a, b) => a - b)) {
    const S = new Map(ids.map((id) => [id, sAt(id, t)]));
    for (const id of ids) {
      const a = specs.get(id)!, p = passageOf(g, a.passage), s = S.get(id)!, Lb = a.body.length_mm, Lp = laneLength(p);
      for (let k = 0; k <= 20; k++) { const x = s - Lb / 2 + 1e-6 + ((Lb - 2e-6) * k) / 20; if (x >= 0 && x <= Lp && usableWidth(g, p, x) < width(id) - 1e-9) { out.push(`t=${t}: ${id} is in a section narrower than its width at s=${x}`); break; } }
      for (const e of g.entrances) if (e.passage_ref === a.passage && e.aperture_width_mm !== null && e.aperture_width_mm < width(id) - 1e-9) {
        const se = arcPositionOf(p, { x: e.position_mm[0], y: e.position_mm[1] });
        if (s - Lb / 2 < se - 1e-6 && se + 1e-6 < s + Lb / 2) out.push(`t=${t}: ${id} is passing entrance ${e.id} (aperture ${e.aperture_width_mm} mm) with width ${width(id)} mm`);
      }
    }
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = specs.get(ids[i])!, B = specs.get(ids[j])!, sa = S.get(A.id)!, sb = S.get(B.id)!, mm = (A.body.length_mm + B.body.length_mm) / 2;
      if (A.passage === B.passage) {
        if (Math.abs(sa - sb) >= mm - 1e-6) continue;
        const p = passageOf(g, A.passage), lo = Math.max(sa - A.body.length_mm / 2, sb - B.body.length_mm / 2), hi = Math.min(sa + A.body.length_mm / 2, sb + B.body.length_mm / 2);
        for (let k = 0; k <= 20; k++) { const x = lo + ((hi - lo) * k) / 20; if (usableWidth(g, p, x) < width(A.id) + width(B.id) - 1e-6) { out.push(`t=${t}: ${A.id} and ${B.id} overlap at s=${x.toFixed(6)} where the passage is too narrow for both`); break; } }
      } else {
        const pa = positionAt(passageOf(g, A.passage), sa), pb = positionAt(passageOf(g, B.passage), sb);
        if (Math.abs(pa.z - pb.z) > Math.max(A.body.length_mm, B.body.length_mm)) continue;
        if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < mm - 1e-6) out.push(`t=${t}: ${A.id} and ${B.id} discs overlap across lanes`);
      }
    }
  }
  return out;
}
