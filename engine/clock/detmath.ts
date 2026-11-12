/**
 * Cross-environment deterministic trigonometry for engine/clock (Owner decision #190, ruled in #193, 2026-11-12; scheme A
 * of docs/solar-cross-env-check.md §6).
 *
 * WHY: ECMAScript leaves Math.sin / cos / tan / asin / acos / atan "implementation-approximated". Measured (PR #169,
 * docs/solar-cross-env-check.md §3): Node 22 and Chromium 153 give light times differing by 1–320 ulp on 2–4 % of inputs,
 * and C1 / C3 / C4 there show such a difference can change event batching, 'tick' labels and the light state at a
 * boundary. So these functions use ONLY IEEE-754 basic operations (+, −, ×, ÷), which ECMAScript requires to be correctly
 * rounded, plus Math.sqrt (correctly rounded by specification), Math.round / Math.abs (exact) and literal constants.
 * Every operation has one exactly specified result, so any conforming engine returns the same bits for the same input
 * (verified Node vs Chromium on x86-64: prototypes/solar-xenv; ARM64 NOT verified). No tolerance anywhere.
 *
 * Algorithms (classic fdlibm / Sun Microsystems 1993 designs; coefficients are its published minimax values written as
 * decimal literals, which every engine parses to the same double):
 *  - sin / cos: Cody–Waite reduction x = k·(π/2) + r with π/2 split into three parts (the first two with 33 significant
 *    bits so k·P1 and k·P2 are exact for |k| < 2^20), then the fdlibm kernel polynomials on |r| ≤ π/4;
 *  - tan = sin / cos (only used away from the poles);
 *  - asin / acos: fdlibm rational approximation R(z) = z·P(z)/Q(z); for |x| ≥ 0.5 the half-angle sqrt form
 *    (asin x = π/2 − 2·asin √((1−|x|)/2)), so the result stays well conditioned as |x| → 1 (where 1−|x| is exact).
 * Accuracy: a few ulp of the true value (far below the ~1 min accuracy of the NOAA method that uses it). Engineering
 * code, not a model parameter. Pure functions; no state.
 */

// π/2 = PIO2_1 + PIO2_2 + PIO2_3 (+ < 1e-31); PIO2_1, PIO2_2 have 33 significant bits (fdlibm e_rem_pio2.c)
const PIO2_1 = 1.57079632673412561417e+00, PIO2_2 = 6.07710050630396597660e-11, PIO2_3 = 2.02226624871116645580e-21;
const INV_PIO2 = 6.36619772367581382433e-01; // 2/π rounded
/** largest |x| accepted: k = round(x·2/π) stays < 2^20 so k·PIO2_1 and k·PIO2_2 are exact */
export const DET_TRIG_MAX_ARG = 1.6e6;

// fdlibm k_sin.c / k_cos.c minimax coefficients on [−π/4, π/4]
const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03, S3 = -1.98412698298579493134e-04,
  S4 = 2.75573137070700676789e-06, S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03, C3 = 2.48015872894767294178e-05,
  C4 = -2.75573143513906633035e-07, C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

function kSin(x: number): number {
  const z = x * x, v = z * x, r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
  return x + v * (S1 + z * r);
}
function kCos(x: number): number {
  const z = x * x, r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))), hz = 0.5 * z, w = 1 - hz;
  return w + (((1 - w) - hz) + z * r);
}
/** Cody–Waite reduction: x = k·π/2 + r, |r| ≲ π/4; returns [k mod 4, r] */
function reduce(x: number): [number, number] {
  if (!Number.isFinite(x) || !(Math.abs(x) <= DET_TRIG_MAX_ARG)) throw Error(`detmath: trigonometric argument ${x} outside ±${DET_TRIG_MAX_ARG}`);
  const k = Math.round(x * INV_PIO2);
  const r = ((x - k * PIO2_1) - k * PIO2_2) - k * PIO2_3;
  return [((k % 4) + 4) % 4, r];
}
/** sin x (radians), deterministic across conforming ECMAScript engines */
export function detSin(x: number): number {
  const [q, r] = reduce(x);
  return q === 0 ? kSin(r) : q === 1 ? kCos(r) : q === 2 ? -kSin(r) : -kCos(r);
}
/** cos x (radians), deterministic across conforming ECMAScript engines */
export function detCos(x: number): number {
  const [q, r] = reduce(x);
  return q === 0 ? kCos(r) : q === 1 ? -kSin(r) : q === 2 ? -kCos(r) : kSin(r);
}
/** tan x = sin x / cos x (radians; callers stay away from the poles) */
export function detTan(x: number): number {
  const [q, r] = reduce(x), s = kSin(r), c = kCos(r);
  return q % 2 === 0 ? s / c : -c / s;
}

// fdlibm e_asin.c / e_acos.c rational approximation of (asin(√z)/√z − 1)/z ... as R(z) = z·P(z)/Q(z)
const PS0 = 1.66666666666666657415e-01, PS1 = -3.25565818622400915405e-01, PS2 = 2.01212532134862925881e-01,
  PS3 = -4.00555345006794114027e-02, PS4 = 7.91534994289814532176e-04, PS5 = 3.47933107596021167570e-05;
const QS1 = -2.40339491173441421878e+00, QS2 = 2.02094576023350569471e+00, QS3 = -6.88283971605453293030e-01, QS4 = 7.70381505559019352791e-02;
const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17, PI = 3.14159265358979311600e+00;
function R(z: number): number {
  const p = z * (PS0 + z * (PS1 + z * (PS2 + z * (PS3 + z * (PS4 + z * PS5))))), q = 1 + z * (QS1 + z * (QS2 + z * (QS3 + z * QS4)));
  return p / q;
}
/** asin x (radians); NaN outside [−1, 1] (as Math.asin); deterministic across conforming ECMAScript engines */
export function detAsin(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  const ax = Math.abs(x);
  if (ax < 0.5) return x + x * R(x * x);
  const t = (1 - ax) * 0.5, s = Math.sqrt(t);     // 1 − |x| is exact for |x| ≥ 0.5 (Sterbenz)
  const y = PIO2_HI - (2 * (s + s * R(t)) - PIO2_LO);
  return x < 0 ? -y : y;
}
/** acos x (radians); NaN outside [−1, 1] (as Math.acos); deterministic across conforming ECMAScript engines */
export function detAcos(x: number): number {
  if (!(x >= -1 && x <= 1)) return NaN;
  if (Math.abs(x) < 0.5) return PIO2_HI - (x - (PIO2_LO - x * R(x * x)));
  if (x < 0) { const z = (1 + x) * 0.5, s = Math.sqrt(z); return PI - 2 * (s + (R(z) * s - PIO2_LO)); }
  const z = (1 - x) * 0.5, s = Math.sqrt(z);
  return 2 * (s + s * R(z));
}
