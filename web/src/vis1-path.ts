/**
 * VIS-1 (P0-A2 experiment view) — DISPLAY paths of travelling workers. Pure and DOM-free (Node tests use it).
 * Non-official experiment world (Owner #201). Nothing here runs, steps or changes the simulation.
 *
 * What the engine records for a route trip (P0-A2): the state (outbound / returning), the departure instant since_s and
 * the arrival instant until_s (fixed model travel time = route length / trail walking speed), and the route LENGTH
 * (source_distance_mm). It records NO geometry: the route direction and shape are not modelled (matrix M22: walking
 * kinematics not simulated). So on screen:
 *  - departure / arrival instants and the end points (nest entrance, honeydew source) = ENGINE;
 *  - the path SHAPE between them = DISPLAY INTERPOLATION (示意), generated here by a documented curve generator (no repo
 *    kinematics model is used: the natural-walk / kin2d / wp4 modules are physics experiments of other worlds and need
 *    a 2-D world the P0-A2 model does not have);
 *  - the ant covers the displayed path at constant speed so it is EXACTLY at the start at since_s and EXACTLY at the
 *    end at until_s (bit-identical end points), never before or after.
 * Curve generator (遊戲假設 / 示意, deterministic):
 *  1. a shared corridor per world (seed = world seed): the chord nest → source bent by five half-sine harmonics
 *     (amplitudes ≤ 7 % of the chord); the corridor arc length is made EQUAL to the engine route length by choosing the
 *     chord (so the displayed walking speed equals the engine's length / travel time). The corridor is NOT a pheromone
 *     trail (trail chemistry is not simulated) — it is a drawing choice so that trips look like one garden route.
 *  2. a per-trip deviation (seed = ant id + departure instant): long-wave lateral offsets (≤ 0.8 cm) plus a fine
 *     wobble (cubic B-spline noise, amplitude 0.05 cm, wavelength ≈ 1.5 cm). Every term vanishes at both ends.
 *  The same ant and trip therefore always give the same curve (same replay → same picture); nothing is random per frame.
 */
import { h01 } from './art-core.ts';
import { bspline } from './display-motion.ts';
import { hash32 } from './game-model.ts';

export interface Pt { x: number; y: number }
/** sampled polyline with cumulative arc length (cm) */
export interface Polyline { pts: Pt[]; cum: number[]; len: number }

/** samples per corridor / trip path (resolution ≈ 0.25 cm on a 200 cm route) */
export const PATH_SAMPLES = 800;
/** bearing of the chord nest → source on screen (示意: the model has no direction) */
export const CORRIDOR_BEARING_RAD = Math.PI / 7;
const CORR_HARM = [0.055, -0.03, 0.018, 0.01, -0.006];
const TRIP_DEV_CM = 0.8, WOBBLE_CM = 0.05, WOBBLE_LAMBDA_CM = 1.5;

function polyline(pts: Pt[]): Polyline {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, cum, len: cum[cum.length - 1] };
}
/** lateral profile of the corridor at u ∈ [0, 1] (fraction of the chord), per unit chord */
function corridorLateral(seed: number, u: number): number {
  let s = 0;
  CORR_HARM.forEach((a, i) => { const sign = h01(seed, i, 17, 3) < 0.5 ? -1 : 1, amp = a * (0.6 + 0.8 * h01(seed, i, 29, 5)); s += sign * amp * Math.sin((i + 1) * Math.PI * u); });
  return s;
}
export interface Corridor { seed: number; nest: Pt; source: Pt; chord: number; route_cm: number; line: Polyline; bearing: number }
/** The world's shared display corridor: nest at the origin; source placed so that the corridor arc length = route_cm. */
export function makeCorridor(worldSeed: number, route_cm: number, bearing = CORRIDOR_BEARING_RAD): Corridor {
  const seed = hash32(`corridor|${worldSeed}`) >>> 0;
  const unit: Pt[] = [];
  for (let i = 0; i <= PATH_SAMPLES; i++) { const u = i / PATH_SAMPLES; unit.push({ x: u, y: corridorLateral(seed, u) }); }
  const rho = polyline(unit).len, chord = route_cm / rho, c = Math.cos(bearing), s = Math.sin(bearing);
  const pts = unit.map((p, i) => i === 0 ? { x: 0, y: 0 } : { x: chord * (p.x * c - p.y * s), y: chord * (p.x * s + p.y * c) });
  const source = pts[PATH_SAMPLES];
  return { seed, nest: { x: 0, y: 0 }, source: { x: source.x, y: source.y }, chord, route_cm, line: polyline(pts), bearing };
}
/** point and unit normal of a polyline at arc length s */
export function atArc(L: Polyline, s: number): { p: Pt; tx: number; ty: number; i: number } {
  const n = L.pts.length - 1;
  if (s <= 0) { const d = Math.hypot(L.pts[1].x - L.pts[0].x, L.pts[1].y - L.pts[0].y) || 1; return { p: L.pts[0], tx: (L.pts[1].x - L.pts[0].x) / d, ty: (L.pts[1].y - L.pts[0].y) / d, i: 0 }; }
  if (s >= L.len) { const d = Math.hypot(L.pts[n].x - L.pts[n - 1].x, L.pts[n].y - L.pts[n - 1].y) || 1; return { p: L.pts[n], tx: (L.pts[n].x - L.pts[n - 1].x) / d, ty: (L.pts[n].y - L.pts[n - 1].y) / d, i: n }; }
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L.cum[m] <= s) lo = m; else hi = m; }
  const seg = L.cum[hi] - L.cum[lo] || 1, k = (s - L.cum[lo]) / seg, a = L.pts[lo], b = L.pts[hi];
  // tangent: blend of the neighbouring segment directions (smooth heading; no corner flips between samples)
  const dir = (j: number) => { const j0 = Math.max(0, Math.min(n - 1, j)), d = Math.hypot(L.pts[j0 + 1].x - L.pts[j0].x, L.pts[j0 + 1].y - L.pts[j0].y) || 1; return [(L.pts[j0 + 1].x - L.pts[j0].x) / d, (L.pts[j0 + 1].y - L.pts[j0].y) / d]; };
  const d0 = dir(lo - 1), d1 = dir(lo), d2 = dir(lo + 1), w = k;
  let tx = (d0[0] * (1 - w) + d1[0] + d2[0] * w), ty = (d0[1] * (1 - w) + d1[1] + d2[1] * w); const tn = Math.hypot(tx, ty) || 1; tx /= tn; ty /= tn;
  return { p: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }, tx, ty, i: lo };
}

/** per-trip lateral deviation (cm) at corridor fraction u, for arc position sCm (wobble); vanishes at u = 0 and 1 */
function tripLateral(seed: number, u: number, sCm: number): number {
  let d = 0;
  for (let i = 1; i <= 4; i++) d += (h01(seed, i, 41, 9) * 2 - 1) * (TRIP_DEV_CM / i) * Math.sin(i * Math.PI * u);
  const env = Math.min(1, u * 40, (1 - u) * 40); // the wobble fades within the first / last 2.5 % (entrance, source)
  return d + WOBBLE_CM * env * bspline(seed, sCm / WOBBLE_LAMBDA_CM);
}
export interface TripPath { key: string; from: Pt; to: Pt; line: Polyline; t0: number; t1: number; schematicStart: boolean }
/** Display path of one trip. outbound: nest → source along the corridor; returning: source → nest (the corridor run
 *  backwards). `startOverride` (returning after a failed search: the search area is 示意) bends the path in from a
 *  schematic start point instead of the source. */
export function tripPath(C: Corridor, antId: string, t0: number, t1: number, dir: 'outbound' | 'returning', startOverride?: Pt): TripPath {
  const key = `${antId}|${t0}|${dir}`, seed = hash32(`trip|${key}`) >>> 0, base = C.line, n = base.pts.length - 1;
  const pts: Pt[] = [];
  if (startOverride) {
    // schematic search area → nest: a gently bent chord (no corridor), ends exact
    const a = startOverride, b = C.nest, d = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) / d, ny = (b.x - a.x) / d;
    for (let i = 0; i <= n; i++) { const u = i / n, off = d * 0.08 * (h01(seed, 1, 1, 1) * 2 - 1) * Math.sin(Math.PI * u) + tripLateral(seed, u, u * d); pts.push(i === 0 ? { x: a.x, y: a.y } : i === n ? { x: b.x, y: b.y } : { x: a.x + (b.x - a.x) * u + nx * off, y: a.y + (b.y - a.y) * u + ny * off }); }
  } else {
    for (let i = 0; i <= n; i++) {
      const j = dir === 'outbound' ? i : n - i, P = base.pts[j];
      if (i === 0 || i === n) { pts.push({ x: P.x, y: P.y }); continue; }
      const q = atArc(base, base.cum[j]), u = j / n, off = tripLateral(seed, u, base.cum[j]);
      pts.push({ x: P.x - q.ty * off, y: P.y + q.tx * off });
    }
  }
  const line = polyline(pts);
  return { key, from: pts[0], to: pts[n], line, t0, t1, schematicStart: !!startOverride };
}
export interface PathPose { x: number; y: number; heading: number; dist_cm: number; k: number; interpolated: boolean }
/** Pose on a trip path at display time t: k ≤ 0 → exactly the start, k ≥ 1 → exactly the end (record instants); between
 *  them constant speed along the displayed path (display interpolation). heading = path tangent (world rad, y north). */
export function poseOnTrip(P: TripPath, t: number): PathPose {
  const span = P.t1 - P.t0, k = span > 0 ? (t - P.t0) / span : 1;
  if (k <= 0) { const a = atArc(P.line, 0); return { x: P.from.x, y: P.from.y, heading: Math.atan2(a.ty, a.tx), dist_cm: 0, k: 0, interpolated: false }; }
  if (k >= 1) { const a = atArc(P.line, P.line.len); return { x: P.to.x, y: P.to.y, heading: Math.atan2(a.ty, a.tx), dist_cm: P.line.len, k: 1, interpolated: false }; }
  const s = k * P.line.len, a = atArc(P.line, s);
  return { x: a.p.x, y: a.p.y, heading: Math.atan2(a.ty, a.tx), dist_cm: s, k, interpolated: true };
}

/** Schematic search loop (search has NO spatial model): a closed wandering loop that starts and ends at the nest
 *  entrance, walked at the trail speed from since_s on (repeats while the engine state stays 'searching'). 示意. */
export function searchLoop(antId: string, since: number, radiusCm: number): Polyline {
  const seed = hash32(`search|${antId}|${since}`) >>> 0, pts: Pt[] = [], n = 400, a0 = h01(seed, 3, 3, 3) * Math.PI * 2;
  for (let i = 0; i <= n; i++) {
    const u = i / n, r = radiusCm * Math.sin(Math.PI * u) * (0.55 + 0.45 * Math.abs(bspline(seed, u * 4))), ang = a0 + (u - 0.5) * 2.2 + 0.5 * bspline(seed + 7, u * 3);
    pts.push(i === 0 || i === n ? { x: 0, y: 0 } : { x: r * Math.cos(ang) + WOBBLE_CM * 2 * bspline(seed + 11, u * 60), y: r * Math.sin(ang) + WOBBLE_CM * 2 * bspline(seed + 13, u * 60) });
  }
  return polyline(pts);
}
export function poseOnLoop(L: Polyline, since: number, t: number, speedCmS: number): PathPose {
  const d = Math.max(0, (t - since) * speedCmS), s = d % L.len, a = atArc(L, s);
  return { x: a.p.x, y: a.p.y, heading: Math.atan2(a.ty, a.tx), dist_cm: d, k: s / L.len, interpolated: false };
}

/** Display stride λ (body lengths per gait cycle; 示意 drawing parameter, NOT a species stride — docs/visual-p0-scene-
 *  spec §6.1 suggests 0.5–0.8, default 0.6). The art kit's leg sweep (art-ant STRIDE: 0.2 body length per cycle) is
 *  scaled by ART_STRIDE_SCALE so a stance foot stays planted at the drawn size. */
export const STRIDE_BODY_LENGTHS = 0.6;
export const ART_STRIDE_SCALE = STRIDE_BODY_LENGTHS / 0.2;
/** Gait phase advance (cycles) for a displayed ground distance: proportional to the distance walked at the drawn scale
 *  (stance feet do not slide), never negative. Temporal anti-aliasing: above `aliasCycles` per drawn frame (step rate
 *  > frame rate / 5) the leg swing amplitude is reduced (`amp` < 1, a phase-averaged look) instead of strobing; above
 *  `maxCycles` the phase advance is capped (`capped`). Drawing only. */
export function gaitAdvance(dDistCm: number, drawnLenCm: number, maxCycles = 0.45, aliasCycles = 0.2): { cycles: number; capped: boolean; amp: number } {
  const c = Math.max(0, dDistCm) / (STRIDE_BODY_LENGTHS * Math.max(1e-6, drawnLenCm)), amp = c > aliasCycles ? Math.max(0.25, aliasCycles / c) : 1;
  return c > maxCycles ? { cycles: maxCycles, capped: true, amp } : { cycles: c, capped: false, amp };
}
