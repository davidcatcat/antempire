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

// ───────────────────────── exp / log / pow (rules update, Owner ruling #190 scheme A extended to exp/log) ─────────────────────────
// WHY: Math.exp / Math.log / ** are "implementation-approximated" too. Measured on PR #209 (head 8592c8a): a P0-A2 world
// advanced in a Chromium Worker logged rh_percent 1 ulp away from the same world advanced in Node (Math.exp in
// saturationVapourKPa), so the save failed Node verification. detExp / detLog are line-by-line ports of fdlibm 5.3
// e_exp.c / e_log.c (Sun Microsystems 1993): the same reductions, the same minimax coefficients, the same operation
// order, using only +, −, ×, ÷ and exact bit access to the IEEE-754 representation (DataView, big-endian, which is
// fully specified). Scaling by 2^k is an exact multiplication by a power of two built from its bit pattern.
// Special cases (as fdlibm / Math.*): see the function comments. Accuracy (fdlibm's own bound): < 1 ulp.
// Verified: tests/detmath-explog.test.ts (special cases, reference values with a BigInt high-precision reference, ulp
// statistics against Math.* of the running engine) and tests/browser/detmath-xenv.check.cjs (Node vs live Chromium page
// and module Worker, bit equality over the sweep).

const BITS = new DataView(new ArrayBuffer(8));
const hiWord = (x: number): number => { BITS.setFloat64(0, x); return BITS.getInt32(0); };
const loWord = (x: number): number => { BITS.setFloat64(0, x); return BITS.getUint32(4); };
const withHi = (x: number, hi: number): number => { BITS.setFloat64(0, x); BITS.setInt32(0, hi | 0); return BITS.getFloat64(0); };
/** 2^k for −1022 ≤ k ≤ 1023, exactly (built from the bit pattern) */
const pow2 = (k: number): number => { BITS.setUint32(0, (k + 1023) << 20); BITS.setUint32(4, 0); return BITS.getFloat64(0); };

// fdlibm e_exp.c constants
const E_O_THRESHOLD = 7.09782712893383973096e+02, E_U_THRESHOLD = -7.45133219101941108420e+02;
const LN2HI = [6.93147180369123816490e-01, -6.93147180369123816490e-01], LN2LO = [1.90821492927058770002e-10, -1.90821492927058770002e-10];
const HALF = [0.5, -0.5], INVLN2 = 1.44269504088896338700e+00, HUGE = 1.0e+300, TWOM1000 = 9.33263618503218878990e-302;
const EP1 = 1.66666666666666019037e-01, EP2 = -2.77777777770155933842e-03, EP3 = 6.61375632143793436117e-05,
  EP4 = -1.65339022054652515390e-06, EP5 = 4.13813679705723846039e-08;

/**
 * e^x, deterministic across conforming ECMAScript engines (fdlibm e_exp.c).
 * Special cases: NaN → NaN; +∞ → +∞; −∞ → +0; x > 709.782712893384 → +∞ (overflow); x < −745.1332191019411 → +0
 * (underflow); results below 2^−1022 are subnormal (rounded once, as fdlibm); |x| < 2^−28 → 1 + x.
 */
export function detExp(x: number): number {
  let hx = hiWord(x);
  const xsb = (hx >>> 31) & 1;
  hx &= 0x7fffffff;
  let hi = 0, lo = 0, k = 0;
  if (hx >= 0x40862e42) {                  // |x| ≥ 709.78…
    if (hx >= 0x7ff00000) {
      if (((hx & 0xfffff) | loWord(x)) !== 0) return x + x; // NaN
      return xsb === 0 ? x : 0;           // exp(±∞) = {∞, 0}
    }
    if (x > E_O_THRESHOLD) return HUGE * HUGE;      // overflow → +∞
    if (x < E_U_THRESHOLD) return TWOM1000 * TWOM1000; // underflow → +0
  }
  if (hx > 0x3fd62e42) {                   // |x| > 0.5 ln 2
    if (hx < 0x3ff0a2b2) { hi = x - LN2HI[xsb]; lo = LN2LO[xsb]; k = 1 - xsb - xsb; }  // and |x| < 1.5 ln 2
    else { k = Math.trunc(INVLN2 * x + HALF[xsb]); hi = x - k * LN2HI[0]; lo = k * LN2LO[0]; } // k·LN2HI exact
    x = hi - lo;
  } else if (hx < 0x3e300000) {            // |x| < 2^−28
    if (HUGE + x > 1) return 1 + x;
  } else k = 0;
  const t = x * x, c = x - t * (EP1 + t * (EP2 + t * (EP3 + t * (EP4 + t * EP5))));
  if (k === 0) return 1 - ((x * c) / (c - 2.0) - x);
  const y = 1 - ((lo - (x * c) / (2.0 - c)) - hi);
  // fdlibm adds k to the exponent field of y; for a normal result that is exactly y·2^k
  if (k >= -1021) return k === 1024 ? y * 2 * pow2(1023) : y * pow2(k);
  return y * pow2(k + 1000) * TWOM1000;
}

// fdlibm e_log.c constants
const L_LN2_HI = 6.93147180369123816490e-01, L_LN2_LO = 1.90821492927058770002e-10, TWO54 = 1.80143985094819840000e+16;
const LG1 = 6.666666666666735130e-01, LG2 = 3.999999999940941908e-01, LG3 = 2.857142874366239149e-01, LG4 = 2.222219843214978396e-01,
  LG5 = 1.818357216161805012e-01, LG6 = 1.531383769920937332e-01, LG7 = 1.479819860511658591e-01;

/**
 * natural logarithm ln x, deterministic across conforming ECMAScript engines (fdlibm e_log.c).
 * Special cases: ±0 → −∞; x < 0 → NaN; NaN → NaN; +∞ → +∞; 1 → +0; subnormal x is scaled by 2^54 first (exact).
 */
export function detLog(x: number): number {
  let hx = hiWord(x);
  const lx = loWord(x);
  let k = 0;
  if (hx < 0x00100000) {                   // x < 2^−1022 (incl. negatives, ±0, subnormals)
    if (((hx & 0x7fffffff) | lx) === 0) return -Infinity; // log(±0) = −∞
    if (hx < 0) return NaN;               // log(negative) = NaN
    k -= 54; x *= TWO54; hx = hiWord(x);  // subnormal: scale up (exact)
  }
  if (hx >= 0x7ff00000) return x + x;     // +∞ or NaN
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  let i = (hx + 0x95f64) & 0x100000;
  x = withHi(x, hx | (i ^ 0x3ff00000));   // normalise x or x/2 into [√2/2, √2)
  k += i >> 20;
  const f = x - 1.0;
  if ((0x000fffff & (2 + hx)) < 3) {       // |f| < 2^−20
    if (f === 0) { if (k === 0) return 0; return k * L_LN2_HI + k * L_LN2_LO; }
    const R = f * f * (0.5 - 0.33333333333333333 * f);
    if (k === 0) return f - R;
    return k * L_LN2_HI - ((R - k * L_LN2_LO) - f);
  }
  const s = f / (2.0 + f), dk = k, z = s * s;
  i = hx - 0x6147a;
  const w = z * z, j = 0x6b851 - hx;
  const t1 = w * (LG2 + w * (LG4 + w * LG6)), t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  i |= j;
  const R = t2 + t1;
  if (i > 0) {
    const hfsq = 0.5 * f * f;
    if (k === 0) return f - (hfsq - s * (hfsq + R));
    return dk * L_LN2_HI - ((hfsq - (s * (hfsq + R) + dk * L_LN2_LO)) - f);
  }
  if (k === 0) return f - s * (f - R);
  return dk * L_LN2_HI - ((s * (f - R) - dk * L_LN2_LO) - f);
}

/**
 * x^n for an integer n (|n| ≤ 2^31 − 1) by binary exponentiation (squarings and products in a fixed order; each step is
 * a correctly rounded IEEE multiplication, so the result is the same in every conforming engine). n = 2 gives exactly
 * x·x. Error ≲ (number of multiplications) ulp. n < 0 → 1 / x^|n|. Throws for a non-integer n (use detPow).
 */
export function detPowInt(x: number, n: number): number {
  if (!Number.isInteger(n) || Math.abs(n) > 0x7fffffff) throw Error(`detPowInt: exponent ${n} is not an integer in ±(2^31−1)`);
  let e = Math.abs(n), b = x, r = 1;
  while (e > 0) { if (e % 2 === 1) r *= b; e = Math.floor(e / 2); if (e > 0) b *= b; }
  return n < 0 ? 1 / r : r;
}

/**
 * x^y: integer y → detPowInt; otherwise, for x > 0, detExp(y·detLog(x)) (deterministic; NOT a port of fdlibm e_pow.c —
 * relative error up to about |y·ln x|·2^−53 plus 1 ulp, adequate for model curves); x = 0, y > 0 → 0; x < 0 with
 * non-integer y → NaN; any NaN → NaN.
 */
export function detPow(x: number, y: number): number {
  if (Number.isNaN(x) || Number.isNaN(y)) return NaN;
  if (Number.isInteger(y) && Math.abs(y) <= 0x7fffffff) return detPowInt(x, y);
  if (x === 0) return y > 0 ? 0 : Infinity;
  if (x < 0) return NaN;
  return detExp(y * detLog(x));
}
