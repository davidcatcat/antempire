/**
 * Exact control-time arithmetic for the WP4 decision layer (docs/wp4-local-avoidance.md §2b 時間契約). ISOLATED (only
 * the WP4 decision layer uses it; not in the official pipeline).
 *
 * Rule: a control time given as a double (a schedule, the decision interval, a dwell or wait duration, the horizon) means
 * its SHORTEST ROUND-TRIP DECIMAL — the number written in the JSON input. Sums and integer multiples of such times are
 * computed exactly on those decimals (BigInt) and rounded ONCE to the nearest double. So the decision instant
 * k × 0.1 for k = 3 is 0.3 (the double a schedule "0.3" also gives), never the binary product 3 * 0.1 =
 * 0.30000000000000004, and 0.1 + 0.2 is 0.3. A float rounding error can therefore never delay a scheduled event past an
 * instant it equals in the input. Comparisons are exact on the decimals (no tolerance).
 *
 * This is the producer-side rule the layered time contract (docs/p0a0-time-contract.md §3, §8) leaves to the producer
 * ("same instant is the producer's decision"); motion times inside an interval (contact, arrival) stay ordinary doubles.
 */

interface Dec { m: bigint; e: number }   // value = m · 10^(−e), e ≥ 0

/** the shortest round-trip decimal of a finite double */
export function decOf(x: number): Dec {
  if (!Number.isFinite(x)) throw new Error(`EXACT_TIME: ${x} is not a finite time`);
  const [mant, ex] = String(x).split('e');
  const neg = mant.startsWith('-'), body = neg ? mant.slice(1) : mant;
  const [ip, fp = ''] = body.split('.');
  let m = BigInt(ip + fp), e = fp.length - (ex ? Number(ex) : 0);
  if (e < 0) { m *= 10n ** BigInt(-e); e = 0; }
  return { m: neg ? -m : m, e };
}
const scale = (d: Dec, e: number) => d.m * 10n ** BigInt(e - d.e);
/** Σ coef_i · x_i on the decimals, exactly (common exponent) */
function sumDec(terms: readonly (readonly [number, number])[]): Dec {
  const ds = terms.map(([c, x]) => { if (!Number.isSafeInteger(c)) throw new Error(`EXACT_TIME: coefficient ${c} is not an integer`); return [BigInt(c), decOf(x)] as const; });
  const e = Math.max(0, ...ds.map(([, d]) => d.e));
  return { m: ds.reduce((s, [c, d]) => s + c * scale(d, e), 0n), e };
}
/** the nearest double to an exact decimal (ECMAScript string-to-number conversion) */
const toNum = (d: Dec) => Number(`${d.m}e-${d.e}`);

/** Σ coef_i · x_i, exact on the decimals, rounded once */
export const exactSum = (...terms: (readonly [number, number])[]): number => toNum(sumDec(terms));
/** decision-grid instant k · dt (integer k), exact on the decimal dt, rounded once */
export const gridTime = (k: number, dt: number): number => exactSum([k, dt]);
/** a + b, exact on the decimals, rounded once */
export const addTime = (a: number, b: number): number => exactSum([1, a], [1, b]);
/** sign of (Σ lhs − Σ rhs), exact on the decimals */
export function cmpExact(lhs: readonly (readonly [number, number])[], rhs: readonly (readonly [number, number])[]): -1 | 0 | 1 {
  const d = sumDec([...lhs, ...rhs.map(([c, x]) => [-c, x] as const)]);
  return d.m < 0n ? -1 : d.m > 0n ? 1 : 0;
}
