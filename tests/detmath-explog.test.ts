/**
 * Rules update detmath-exp (Owner ruling #190 scheme A extended to exp / log / **): engine/clock/detmath.ts detExp,
 * detLog, detPow, detPowInt. BLOCKING, Node only (the live Node vs Chromium page / Worker sweep is
 * tests/browser/detmath-xenv.check.cjs; the P0-A2 Node vs Worker identity is tests/browser/worker-runtime.check.cjs).
 *  1. special cases (NaN, ±∞, ±0, subnormals, overflow / underflow thresholds, 1) and exactly-known values;
 *  2. ACCURACY against an independent high-precision reference (BigInt fixed point, 256 fractional bits: ln by the
 *     atanh series, exp by ln 2 reduction + Taylor series) over deterministic samples: max error < 1 ulp (fdlibm's own
 *     bound), with the fraction of correctly rounded results recorded;
 *  3. detPowInt is binary exponentiation (n = 2 is exactly x·x); detPow special cases and its documented error bound;
 *  4. source: detmath.ts uses no implementation-approximated Math function and no ** (only + − × ÷, Math.sqrt / abs /
 *     floor / round / trunc and DataView bit access);
 *  5. recorded, not asserted (engine-specific): how often the running engine's own Math.exp / Math.log agree.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { detExp, detLog, detPow, detPowInt } from '../engine/clock/detmath.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const same = (a: number, b: number) => Object.is(a, b);

// ------------------------------------------------------------------ 1. special cases
for (const [x, want] of [[NaN, NaN], [Infinity, Infinity], [-Infinity, 0], [0, 1], [-0, 1], [709.782712893384, 1.7976931348622732e308], [709.7827128933841, Infinity], [1000, Infinity],
  [-745.1332191019411, 5e-324], [-745.1332191019412, 0], [-1000, 0], [1e-30, 1], [-1e-30, 1], [5e-324, 1]] as const) ok(same(detExp(x), want), `detExp(${x}) = ${want} (got ${detExp(x)})`);
ok(detExp(-740) > 0 && detExp(-740) < 2.2250738585072014e-308, `detExp(-740) is subnormal (${detExp(-740)})`);
ok(same(detExp(1), 2.7182818284590455), 'detExp(1) = 2.7182818284590455: fdlibm e_exp.c returns e rounded 1 ulp high (Math.E = 2.718281828459045); kept, not special-cased (a port, not a new algorithm)');
for (const [x, want] of [[NaN, NaN], [Infinity, Infinity], [-Infinity, NaN], [0, -Infinity], [-0, -Infinity], [-1, NaN], [-5e-324, NaN], [1, 0], [2, 0.6931471805599453], [0.5, -0.6931471805599453],
  [5e-324, -744.4400719213812], [1.7976931348623157e308, 709.782712893384], [1024, 6.931471805599453]] as const) ok(same(detLog(x), want), `detLog(${x}) = ${want} (got ${detLog(x)})`);
ok(same(detLog(1), 0) && !same(detLog(1), -0), 'detLog(1) = +0');
ok([-1074, -1022, -1, 1, 10, 1023].every((k) => Math.abs(detLog(2 ** k) - k * Math.LN2) <= Math.abs(k * Math.LN2) * 2.3e-16), 'detLog(2^k) ≈ k·ln 2 for subnormal, normal and the largest exponents');

// ------------------------------------------------------------------ 2. accuracy vs a BigInt high-precision reference
const P = 256n, ONE = 1n << P;
const dv = new DataView(new ArrayBuffer(8));
/** finite non-zero double → [M, q] with value = M · 2^q exactly (M a signed integer, |M| < 2^53) */
function decompose(d: number): [bigint, bigint] {
  dv.setFloat64(0, d);
  const hi = dv.getUint32(0), lo = dv.getUint32(4), e = (hi >>> 20) & 0x7ff, sign = hi >>> 31 ? -1n : 1n;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0) return [sign * m, -1074n];
  m |= 1n << 52n; return [sign * m, BigInt(e) - 1075n];
}
const divRound = (a: bigint, b: bigint) => (a >= 0n ? (2n * a + b) / (2n * b) : -((-2n * a + b) / (2n * b)));
/** ln m for a fixed-point m in [1, 2] (scale 2^P): 2·atanh((m−1)/(m+1)) */
function lnFixed(m: bigint): bigint {
  const s = divRound((m - ONE) * ONE, m + ONE), s2 = (s * s) >> P;
  let term = s, sum = 0n;
  for (let k = 1n; term !== 0n; k += 2n) { sum += term / k; term = (term * s2) >> P; }
  return 2n * sum;
}
const LN2 = lnFixed(2n * ONE); // atanh series at s = 1/3
/** ln d (d > 0 finite) in fixed point 2^P */
function refLn(d: number): bigint {
  const [M, q] = decompose(d); let e = q, m = M;
  while (m >= (1n << 53n)) { m >>= 1n; e += 1n; }
  while (m < (1n << 52n)) { m <<= 1n; e -= 1n; }
  const mf = m << (P - 52n); // m·2^-52 in [1, 2)
  return (e + 52n) * LN2 + lnFixed(mf);
}
/** exp x as [E, k] with exp x = E · 2^(k − P) */
function refExp(x: number): [bigint, bigint] {
  const [M, q] = decompose(x); const X = q >= 0n ? (M << q) << P : (M << P) >> -q; // x in fixed point (exact for |x| ≥ 2^-200)
  const k = divRound(X, LN2), r = X - k * LN2;
  let term = ONE, sum = 0n;
  for (let n = 1n; term !== 0n; n++) { sum += term; term = divRound(term * r, n * ONE); }
  return [sum, k];
}
/** error of a double d against a reference value R · 2^(s) in ulps of d (exact rational arithmetic, 2^-20 ulp resolution) */
function ulpErr(d: number, R: bigint, s: bigint): number {
  const [M, q] = decompose(d); const F = 20n, sh = s - q + F;
  const ref = sh >= 0n ? R << sh : divRound(R, 1n << -sh);
  return Number((M << F) - ref) / 2 ** 20;
}
let seed = 0x2545f491; const u = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const stats = { exp: { n: 0, max: 0, correctly_rounded: 0 }, log: { n: 0, max: 0, correctly_rounded: 0 } };
const expIn = [...Array.from({ length: 3000 }, () => (u() - 0.5) * 1400), ...Array.from({ length: 2000 }, () => (u() - 0.5) * 2), ...Array.from({ length: 2000 }, () => (u() - 0.5) * 60), 1, -1, 0.5, 700, -700, 1e-5, -1e-5];
for (const x of expIn) {
  const d = detExp(x); if (!(d >= 2.2250738585072014e-308) || !Number.isFinite(d)) continue; // normal results only
  const [E, k] = refExp(x), e = Math.abs(ulpErr(d, E, k - P));
  stats.exp.n++; stats.exp.max = Math.max(stats.exp.max, e); if (e <= 0.5) stats.exp.correctly_rounded++;
}
const logIn = [...Array.from({ length: 3000 }, () => 10 ** ((u() - 0.5) * 600)), ...Array.from({ length: 3000 }, () => 1 - u()), ...Array.from({ length: 1000 }, () => 1 + (u() - 0.5) * 1e-5), ...Array.from({ length: 500 }, () => u() * 1e-310), 3, 10, 0.1, Math.E];
for (const x of logIn) {
  if (!(x > 0) || x === 1) continue;
  const d = detLog(x), e = Math.abs(ulpErr(d, refLn(x), -P));
  stats.log.n++; stats.log.max = Math.max(stats.log.max, e); if (e <= 0.5) stats.log.correctly_rounded++;
}
ok(stats.exp.n > 6000 && stats.exp.max < 1, `detExp vs high-precision reference: ${stats.exp.n} inputs, max error ${stats.exp.max.toFixed(3)} ulp (< 1), ${(100 * stats.exp.correctly_rounded / stats.exp.n).toFixed(2)} % correctly rounded`);
ok(stats.log.n > 7000 && stats.log.max < 1, `detLog vs high-precision reference: ${stats.log.n} inputs, max error ${stats.log.max.toFixed(3)} ulp (< 1), ${(100 * stats.log.correctly_rounded / stats.log.n).toFixed(2)} % correctly rounded`);
// the reference itself: known values
ok(Math.abs(ulpErr(0.6931471805599453, LN2, -P)) < 0.5 && Math.abs(ulpErr(2.302585092994046, refLn(10), -P)) < 0.5, 'reference: ln 2 and ln 10 round to the IEEE doubles');
{ const [E, k] = refExp(1); ok(Math.abs(ulpErr(Math.E, E, k - P)) < 0.5 && Math.abs(ulpErr(detExp(1), E, k - P)) < 1, 'reference: e rounds to Math.E; detExp(1) (fdlibm) is within 1 ulp'); }

// ------------------------------------------------------------------ 3. detPowInt / detPow
let sq = 0; for (let i = 0; i < 20000; i++) { const x = (u() - 0.5) * 1e3; if (same(detPowInt(x, 2), x * x)) sq++; }
ok(sq === 20000, 'detPowInt(x, 2) === x·x exactly (the P0-A2 hill coefficient n = 2)');
ok(same(detPowInt(3, 0), 1) && same(detPowInt(0, 0), 1) && same(detPowInt(2, 10), 1024) && same(detPowInt(2, -2), 0.25) && same(detPowInt(10, 3), 1000) && same(detPowInt(-2, 3), -8), 'detPowInt: x^0 = 1, exact small powers, negative exponents and bases');
assert.throws(() => detPowInt(2, 0.5)); assert.throws(() => detPowInt(2, NaN)); checks += 2;
ok(same(detPow(NaN, 2), NaN) && same(detPow(2, NaN), NaN) && same(detPow(0, 0.5), 0) && same(detPow(0, -0.5), Infinity) && same(detPow(-2, 0.5), NaN) && same(detPow(3, 2), 9), 'detPow special cases (NaN, 0, negative base with non-integer exponent, integer exponent → detPowInt)');
let powMax = 0; for (let i = 0; i < 5000; i++) { const x = u() * 100 + 1e-3, y = (u() - 0.5) * 8; const d = detPow(x, y), r = Math.exp(y * Math.log(x)); const bound = (Math.abs(y * Math.log(x)) + 2) * 2 ** -52; powMax = Math.max(powMax, Math.abs(d - r) / Math.abs(r) / bound); }
ok(powMax <= 1, `detPow(x, y) for non-integer y stays within its documented relative bound (|y·ln x| + 2)·2^-52 (worst ${powMax.toFixed(3)} of the bound)`);

// ------------------------------------------------------------------ 4. source
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/clock/detmath.ts'), 'utf8'));
ok(!/Math\.(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|log|log2|log10|log1p|exp|expm1|pow|hypot|cbrt|random)\b|\*\*/.test(src), 'detmath.ts: no implementation-approximated Math function, no **');
ok([...src.matchAll(/Math\.(\w+)/g)].every((m) => ['sqrt', 'abs', 'round', 'floor', 'trunc'].includes(m[1])), `detmath.ts uses only Math.sqrt / abs / round / floor / trunc (${[...new Set([...src.matchAll(/Math\.(\w+)/g)].map((m) => m[1]))].join(', ')})`);

// ------------------------------------------------------------------ 5. recorded: the running engine's own Math.*
let eqE = 0, eqL = 0; for (const x of expIn) if (same(detExp(x), Math.exp(x))) eqE++; for (const x of logIn) if (same(detLog(x), Math.log(x))) eqL++;
console.log(JSON.stringify({ test: 'detmath-explog', checks, accuracy_ulp: { detExp: stats.exp, detLog: stats.log }, same_as_this_engine_math: { exp: `${eqE}/${expIn.length}`, log: `${eqL}/${logIn.length}`, engine: `node ${process.version} ${process.platform}-${process.arch}` } }));
