/**
 * Codex review 2026-11-05 F2 (P2, #67): executable math contracts for the ME-0 documents. These are REFERENCE
 * implementations of the contracts as written in reports/math-ecology-literature-review.md §3 and
 * docs/math-ecology-architecture.md §7.1 — not engine code; the official engine's development parameters are untouched.
 * Engineering checks of internal consistency only: passing them says nothing about P. megacephala biology.
 *
 * Degree-day contract (linear rate, valid range only):
 *   time t in days; temperature T, lower threshold T0 and upper limit of the linear range T_lin_max in °C; K in °C·day.
 *   Form A (thermal sum):  H(t) = ∫ max(0, T(s) − T0) ds          [°C·day]; complete when H ≥ K.
 *   Form B (progress):     p(t) = ∫ max(0, T(s) − T0) / K ds      [dimensionless]; complete when p ≥ 1.
 *   r(T) = max(0, T − T0)/K has units 1/day. Below T0 nothing accumulates (r = 0; no development, no negative
 *   development). Above T_lin_max the linear form is NOT valid: the contract refuses to extrapolate (throws) instead of
 *   continuing the line past the optimum.
 * Q10: R(T) = R_ref·Q10^((T − T_ref)/10) has the units of R_ref; only R/R_ref is dimensionless.
 * Gillespie SSA: the joint density p(τ, j) = a_j·exp(−a0·τ) has units 1/time (a_j in 1/time; Σ_j ∫ p dτ = 1).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

type Contract = { T0: number; K: number; Tmax: number };
/** Piecewise-constant temperature: [duration_days, T_celsius][]. */
type Series = [number, number][];
const excess = (c: Contract, T: number) => {
  if (!Number.isFinite(T)) throw Error('temperature must be a number');
  if (T > c.Tmax) throw Error(`T=${T} °C is above the linear range (≤ ${c.Tmax} °C): the linear degree-day model is not valid there`);
  return Math.max(0, T - c.T0);
};
/** Form A: thermal sum H in °C·day, stepping each piece with step dt (days). Returns the completion time or null. */
function completeByThermalSum(c: Contract, s: Series, dt: number): number | null {
  let H = 0, t = 0;
  for (const [dur, T] of s) {
    const e = excess(c, T);
    for (let left = dur; left > 1e-15;) {
      const h = Math.min(dt, left);
      if (e > 0 && H + e * h >= c.K) return t + (c.K - H) / e; // exact crossing inside the step (rate constant within it)
      H += e * h; t += h; left -= h;
    }
  }
  return null;
}
/** Form B: progress p (dimensionless) with rate r = e/K (1/day), complete at p ≥ 1. */
function completeByProgress(c: Contract, s: Series, dt: number): number | null {
  let p = 0, t = 0;
  for (const [dur, T] of s) {
    const r = excess(c, T) / c.K;
    for (let left = dur; left > 1e-15;) {
      const h = Math.min(dt, left);
      if (r > 0 && p + r * h >= 1) return t + (1 - p) / r;
      p += r * h; t += h; left -= h;
    }
  }
  return null;
}
/** The ERRONEOUS contract as written before the fix (normalised rate accumulated to K), kept to show the 100× error. */
function completeAsWrittenBefore(c: Contract, s: Series): number | null {
  let acc = 0, t = 0;
  for (const [dur, T] of s) { const r = excess(c, T) / c.K; if (r > 0 && acc + r * dur >= c.K) return t + (c.K - acc) / r; acc += r * dur; t += dur; }
  return null;
}

// Hypothetical contract values for the tests (NOT P. megacephala values; this species has no published T0/K).
const C: Contract = { T0: 10, K: 100, Tmax: 32 };

// 1. Codex's worked example: T − T0 = 10 °C, K = 100 °C·day → 10 days (both forms); the old wording gives 1000 days.
for (const dt of [1, 0.25, 1 / 24, 1 / 1440]) {
  ok(close(completeByThermalSum(C, [[50, 20]], dt)!, 10), `constant T−T0=10, K=100: thermal sum completes at 10 d (dt=${dt})`);
  ok(close(completeByProgress(C, [[50, 20]], dt)!, 10), `constant T−T0=10, K=100: progress completes at 10 d (dt=${dt})`);
}
ok(close(completeAsWrittenBefore(C, [[5000, 20]])!, 1000), 'the pre-fix wording ("r = (T−T0)/K accumulated to K") gives 1000 d — a factor K error, now removed from the docs');

// 2. Constant T: closed form t = K/(T − T0) across temperatures in the linear range, both forms, several dt.
for (const T of [11, 15, 22.5, 28, 32]) for (const dt of [1, 0.1, 1 / 24]) {
  const want = C.K / (T - C.T0);
  ok(close(completeByThermalSum(C, [[1e4, T]], dt)!, want, 1e-9) && close(completeByProgress(C, [[1e4, T]], dt)!, want, 1e-9), `constant T=${T}: t = K/(T−T0) = ${want.toFixed(4)} d in both forms (dt=${dt})`);
}

// 3. T = T0 and T < T0: nothing accumulates (no development, never negative progress).
ok(completeByThermalSum(C, [[1e5, 10]], 1) === null && completeByProgress(C, [[1e5, 10]], 1) === null, 'T = T0: no accumulation, never completes');
ok(completeByThermalSum(C, [[1e5, 4]], 1) === null && completeByProgress(C, [[1e5, -5]], 1) === null, 'T < T0: no accumulation (r = 0, not negative)');
ok(close(completeByProgress(C, [[30, 5], [20, 20]], 1)!, 40), "a cold spell below T0 only delays: 30 d at 5 °C add nothing, then 10 of 20 d at 20 °C complete");

// 4. T > T0 within the linear range accumulates; above the linear range the contract refuses to extrapolate.
ok(close(completeByProgress(C, [[300, 10.5]], 1)!, 200), 'T just above T0 accumulates slowly: 0.5 °C excess needs 200 d');
assert.throws(() => completeByProgress(C, [[1, 35]], 1), /not valid/); checks++;
assert.throws(() => completeByThermalSum(C, [[1, 40]], 1), /not valid/); checks++;

// 5. Piecewise T: H = Σ max(0, T_i − T0)·Δt_i; the crossing lies inside the right piece; independent of dt.
const pw: Series = [[3, 18], [2, 8], [4, 25], [10, 14]]; // 3·8 = 24, +0, +4·15 = 60 → 84; then 16 more at 4/day → 4 d
for (const dt of [1, 0.5, 1 / 24, 0.37]) {
  const a = completeByThermalSum(C, pw, dt)!, b = completeByProgress(C, pw, dt)!;
  ok(close(a, 13) && close(b, 13), `piecewise series completes at 13 d in both forms (dt=${dt}: ${a}, ${b})`);
}

// 6. Equivalence of the two forms on random piecewise series (seeded LCG, deterministic).
let seed = 12345; const U = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
for (let k = 0; k < 200; k++) {
  const s: Series = Array.from({ length: 1 + Math.floor(U() * 12) }, () => [0.05 + U() * 5, 0 + U() * 32] as [number, number]);
  const dt = [1, 0.5, 1 / 24, 0.013][k % 4], a = completeByThermalSum(C, s, dt), b = completeByProgress(C, s, dt);
  assert.ok((a === null && b === null) || (a !== null && b !== null && close(a, b, 1e-9)), `random series ${k}: forms disagree (${a} vs ${b})`); checks++;
  // and the result is the same for a different step
  const a2 = completeByThermalSum(C, s, 0.7);
  assert.ok((a === null && a2 === null) || (a !== null && a2 !== null && close(a, a2, 1e-9)), `random series ${k}: depends on dt`); checks++;
}

// 7. Q10 units: R has the units of R_ref; R/R_ref is dimensionless and equals Q10 per +10 °C.
const q10 = (Rref: number, Q: number, T: number, Tref: number) => Rref * Q ** ((T - Tref) / 10);
const Rref_per_day = 0.4; // e.g. a rate in 1/day
ok(close(q10(Rref_per_day, 2, 35, 25) / Rref_per_day, 2) && close(q10(Rref_per_day, 2, 25, 25), Rref_per_day), 'Q10: R(T_ref) = R_ref (same units); R/R_ref = Q10 per +10 °C (dimensionless)');
ok(close(q10(Rref_per_day * 24, 2, 31, 25) / 24, q10(Rref_per_day, 2, 31, 25)), 'Q10: changing the time unit of R_ref (per day → per hour·24) changes R the same way: R carries R_ref’s units');

// 8. SSA density: ∫0^∞ Σ_j a_j·exp(−a0·τ) dτ = 1, so p(τ, j) has units 1/time; P(j) = a_j/a0; mean τ = 1/a0.
const a = [0.3, 1.2, 0.5], a0 = a.reduce((x, y) => x + y, 0);
let total = 0, mean = 0; const h = 1e-4;
for (let t = h / 2; t < 40 / a0; t += h) { const d = a0 * Math.exp(-a0 * t); total += d * h; mean += t * d * h; }
ok(close(total, 1, 1e-6) && close(mean, 1 / a0, 1e-6), `SSA: Σ_j ∫ a_j e^(−a0 τ) dτ = ${total.toFixed(8)} (a density in 1/time), mean waiting time 1/a0`);
ok(close(a[1] / a0, 0.6), 'SSA: P(next event is j) = a_j/a0 (dimensionless)');
// rescaling time by c multiplies the density by 1/c — the signature of a 1/time quantity
const c = 60, dens = (tau: number) => a0 * Math.exp(-a0 * tau), densMin = (tau: number) => (a0 / c) * Math.exp(-(a0 / c) * tau);
ok(close(densMin(5 * c), dens(5) / c), 'SSA: expressing time in minutes instead of hours divides the density by 60 (units 1/time)');

// 9. The documents state the corrected contracts (and no longer the erroneous ones).
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const lit = read('reports/math-ecology-literature-review.md').split('## 附錄：Codex 2026-11-05')[0] /* the correction log quotes the old wording */, arch = read('docs/math-ecology-architecture.md'), reg = read('docs/math-ecology-model-registry.md');
ok(!/累積到 K 完成/.test(lit), 'literature review: the "accumulate the normalised rate to K" wording is gone');
ok(/H ≥ K/.test(lit) && /p ≥ 1/.test(lit) && /1\/日/.test(lit), 'literature review: degree-day row states H ≥ K (°C·日) and p ≥ 1 with r in 1/日');
ok(/R\/R_ref/.test(lit) && /\/時間/.test(lit), 'literature review: Q10 row says only R/R_ref is dimensionless; SSA density is per time');
ok(/全因存活/.test(lit) && !/可以當作內在老化/.test(lit), 'literature review: Yuan KM is all-cause survival under lab conditions, not "intrinsic senescence"');
ok(/H ≥ K|p ≥ 1/.test(arch) && /全因/.test(arch), 'architecture: degree-day completion and all-cause baseline stated');
ok(/全因/.test(reg), 'registry: survival observation is all-cause');
console.log(JSON.stringify({ math_contracts: 'pass', checks, note: 'reference contracts only; hypothetical T0/K (not P. megacephala values); no engine parameter changed' }, null, 2));
