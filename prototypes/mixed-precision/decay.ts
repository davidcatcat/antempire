/**
 * WP5 PROTOTYPE (isolated; not imported by engine/, cli/ or web/; not part of any rules version).
 * Issue #80 candidate: a mass-conserving food-stock decay step with explicit sources and sinks.
 * docs/od1-mixed-precision-open-ecology.md §6.
 *
 * Contract (exact, integer micro-portions):
 *   next - prev = sum(inflows) - sum(outflows)
 * There is no "expiry deletion": a stock is only reduced by a recorded outflow. When the remainder falls
 * below `clear_below` it leaves through an explicit `remainder_cleared` flow to the decomposition sink
 * (a recorded sink, not a silent delete). Every rate is a rational number num/den so the arithmetic is exact.
 * All rates and the threshold are model inputs (game assumptions until a source exists); this module holds no values.
 */

export interface Rational { num: number; den: number }
export interface Flow { from: string; to: string; amount: number; cause: string }
export interface DecayInput {
  /** stock before this step, integer micro-portions */
  stock: number;
  /** recorded sources that add to the stock this step (e.g. a new corpse with its death event id) */
  inflows: { source: string; amount: number; cause: string }[];
  /** fraction decomposed per step (leaves the edible pool to `sink:decomposition`) */
  decomposition: Rational;
  /** other recorded sinks, each a MODELED consumer or a named physical loss (rain wash-off); never an invented organism */
  other_sinks: { to: string; rate: Rational; cause: string }[];
  /** a remainder strictly below this (and > 0) is cleared by an explicit flow; 0 disables */
  clear_below: number;
}

const isInt = (x: number) => Number.isSafeInteger(x);
function checkRate(r: Rational, what: string): void {
  if (!isInt(r.num) || !isInt(r.den) || r.den <= 0 || r.num < 0 || r.num > r.den) throw new Error(`decay: bad rate ${what} ${r.num}/${r.den}`);
}

/**
 * One decay step for one stock. All sinks are computed from the SAME post-inflow stock (simultaneous, so the order of
 * `other_sinks` does not matter), floor division; the sum of rates must not exceed 1.
 */
export function decayStep(stockAddr: string, input: DecayInput): { flows: Flow[]; next: number } {
  if (!isInt(input.stock) || input.stock < 0) throw new Error('decay: stock must be a non-negative integer');
  checkRate(input.decomposition, 'decomposition');
  for (const s of input.other_sinks) checkRate(s.rate, s.to);
  const flows: Flow[] = [];
  let s1 = input.stock;
  for (const f of [...input.inflows].sort((a, b) => (a.source < b.source ? -1 : a.source > b.source ? 1 : 0))) {
    if (!isInt(f.amount) || f.amount <= 0) throw new Error('decay: inflow must be a positive integer');
    flows.push({ from: f.source, to: stockAddr, amount: f.amount, cause: f.cause });
    s1 += f.amount;
  }
  const sinks = [{ to: 'sink:decomposition', rate: input.decomposition, cause: 'decomposition' }, ...input.other_sinks]
    .sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));
  // total rate must be <= 1: compare sum(num_i/den_i) <= 1 exactly via a common denominator (BigInt)
  let N = 0n, D = 1n;
  for (const s of sinks) { N = N * BigInt(s.rate.den) + BigInt(s.rate.num) * D; D *= BigInt(s.rate.den); }
  if (N > D) throw new Error('decay: sum of sink rates exceeds 1');
  let out = 0;
  for (const s of sinks) {
    const a = Number((BigInt(s1) * BigInt(s.rate.num)) / BigInt(s.rate.den));
    if (a > 0) { flows.push({ from: stockAddr, to: s.to, amount: a, cause: s.cause }); out += a; }
  }
  let next = s1 - out;
  if (input.clear_below > 0 && next > 0 && next < input.clear_below) {
    flows.push({ from: stockAddr, to: 'sink:decomposition', amount: next, cause: 'remainder_cleared' });
    next = 0;
  }
  return { flows, next };
}

/** Closure check: next - prev = sum(in) - sum(out) for the stock, every amount a positive integer. Returns violations. */
export function decayClosure(stockAddr: string, prev: number, next: number, flows: Flow[]): string[] {
  const v: string[] = [];
  let net = 0;
  for (const f of flows) {
    if (!isInt(f.amount) || f.amount <= 0) v.push(`non-positive or fractional flow ${f.cause} ${f.amount}`);
    if (f.to === stockAddr) net += f.amount;
    if (f.from === stockAddr) net -= f.amount;
    if (f.to === stockAddr && f.from === stockAddr) v.push('self flow');
  }
  if (!isInt(next) || next < 0) v.push(`stock not a non-negative integer: ${next}`);
  if (next - prev !== net) v.push(`closure: next-prev=${next - prev} but sum(in)-sum(out)=${net}`);
  return v;
}
