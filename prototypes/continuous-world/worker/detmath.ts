/**
 * Cross-platform deterministic math for the experiment world's ants.
 *
 * ECMAScript leaves Math.sin / cos / log / exp / hypot / ** "implementation-approximated": measured on 2026-11-08,
 * Node 22 (V8 12.4) and Playwright Chromium 153 differ by 1 ulp on several percent of inputs (tests/browser/
 * worker-runtime.check.cjs). One ulp can flip a branch (e.g. an arena-edge test) and then two environments diverge. The
 * ant rules therefore use only IEEE-754 basic operations (+, -, *, /), which ECMAScript requires to be correctly
 * rounded, and Math.sqrt (correctly rounded on V8's x86-64 / ARM64 targets; the cross-check measures it).
 * Engineering code, not a model parameter.
 */
const SQRT_HALF = 0.7071067811865476;
const LN2_HI = 0.6931471803691238, LN2_LO = 1.9082149292705877e-10; // ln 2 split so k * LN2_HI is exact for |k| < 2^20
/** natural log of x > 0 via 2^k range reduction and the atanh series (basic operations only; a few ulp of ln x) */
export function detLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) throw Error(`detLog: x must be finite and > 0 (got ${x})`);
  let k = 0, m = x;
  while (m < SQRT_HALF) { m *= 2; k--; }
  while (m > 2 * SQRT_HALF) { m /= 2; k++; }
  const s = (m - 1) / (m + 1), s2 = s * s;
  let p = 0;
  for (let n = 15; n >= 0; n--) p = p * s2 + 1 / (2 * n + 1);
  return k * LN2_HI + (k * LN2_LO + 2 * s * p);
}
/** a uniformly distributed unit vector from a uniform [0,1) source, by rejection in the unit disc (no trigonometry) */
export function unitVector(u: () => number): { x: number; y: number } {
  for (let i = 0; i < 1000; i++) {
    const a = 2 * u() - 1, b = 2 * u() - 1, r2 = a * a + b * b;
    if (r2 > 0 && r2 <= 1) { const r = Math.sqrt(r2); return { x: a / r, y: b / r }; }
  }
  throw Error('unitVector: rejection sampling did not terminate');
}
export const norm = (x: number, y: number): number => Math.sqrt(x * x + y * y);
