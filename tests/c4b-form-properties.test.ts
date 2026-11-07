/**
 * C4b candidate nutrition-response forms (Owner D4, 2026-11-07): mathematical properties and identifiability, on the
 * engine's own N(x) (engine/larva-development.ts). No form is chosen; θ and K are TEST grids (null in the species file).
 *  1. domain: x ∈ [0, 1] (paid fraction; clamped by ownPaidFraction), N(x) ∈ [n_min, 1] for every form and grid value;
 *  2. endpoints: N(1) = 1 for every form; N(0) = n_min for every form EXCEPT the legal threshold θ = 0, where x ≥ 0 always
 *     holds so N ≡ 1 (Owner P2 2026-11-07 counterexample to the former 'every form has N(0) = n_min');
 *  3. monotone non-decreasing in x; clamp_linear and saturating continuous; threshold has one jump of size 1 − n_min at θ;
 *     saturating concave (so with variable rations its mean rate exceeds clamp_linear's at the same mean ration: Jensen);
 *  4. identifiability: any feeding history with x ∈ {0, 1} only (Phillips 1933 pattern, Yuan 2026 ad libitum) gives the
 *     SAME pupation time under every form except θ = 0 -> those data cannot distinguish the others; a history with an
 *     unfed day separates θ = 0 (Phillips' direction excludes it); partial rations separate the forms
 *     strongly (reports/c4b-form-comparison.json must equal a fresh computation).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { resolveBundle } from '../engine/index.ts';
import { nutritionFactor, ownPaidFraction } from '../engine/larva-development.ts';
import { variants, daysToPupation, compare } from '../cli/reports/c4b-form-comparison.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sp = resolveBundle(loadBundle()).species['pheidole-megacephala'], nmin = sp.development.larva_min_nutrition_growth_factor;
ok(sp.larval_development.nutrition_response === null && sp.larval_development.threshold_theta === null && sp.larval_development.saturation_k === null, 'shipped: no form chosen, θ and K null (Owner D4)');
const xs = Array.from({ length: 1001 }, (_, i) => i / 1000);
for (const v of variants(sp)) {
  const N = xs.map((x) => nutritionFactor(x, v.sp));
  ok(N.every((n) => n >= nmin - 1e-15 && n <= 1 + 1e-15), `${v.id}: N(x) ∈ [n_min, 1]`);
  ok(Math.abs(N[1000] - 1) < 1e-12, `${v.id}: N(1) = 1`);
  if (v.id === 'threshold θ=0') { ok(N.every((n) => n === 1), 'threshold θ=0 (legal bound): N ≡ 1, so N(0) = 1 ≠ n_min — an unfed larva develops at the full rate'); continue; }
  ok(Math.abs(N[0] - nmin) < 1e-15, `${v.id}: N(0) = n_min`);
  ok(N.every((n, i) => i === 0 || n >= N[i - 1] - 1e-15), `${v.id}: non-decreasing`);
  const jumps = N.map((n, i) => (i ? n - N[i - 1] : 0)).filter((d) => d > 0.05);
  if (v.id.startsWith('threshold')) ok(jumps.length === 1 && Math.abs(jumps[0] - (1 - nmin)) < 1e-12, `${v.id}: one jump of 1 − n_min at θ (discontinuous)`);
  else ok(jumps.length === 0, `${v.id}: continuous (no step > 0.05 on a 0.001 grid)`);
  if (v.id.startsWith('saturating')) ok(N.every((n, i) => i === 0 || i === 1000 || n >= (N[i - 1] + N[i + 1]) / 2 - 1e-12), `${v.id}: concave`);
}
ok(ownPaidFraction({ sugar: 5, protein: 5 }, { sugar: 1, protein: 1 }) === 1 && ownPaidFraction({ sugar: 0, protein: 1 }, { sugar: 1, protein: 1 }) === 0, 'x is clamped to [0, 1] and is the worse of the two foods');
// identifiability
const endpointsOnly = [(d: number) => (d < 14 ? 0 : 1), () => 1, (d: number) => (d % 3 === 0 ? 0 : 1), (d: number) => (d < 5 || (d > 9 && d < 12) ? 0 : 1)];
ok(variants(sp).some((v) => v.id === 'threshold θ=0') && variants(sp).some((v) => v.id === 'threshold θ=1'), 'the θ grid includes both legal bounds 0 and 1');
const notTheta0 = () => variants(sp).filter((v) => v.id !== 'threshold θ=0'), theta0 = variants(sp).find((v) => v.id === 'threshold θ=0')!.sp;
for (const [i, h] of endpointsOnly.entries()) { const ds = notTheta0().map((v) => daysToPupation(v.sp, h) as number); ok(Math.max(...ds) - Math.min(...ds) < 1e-9, `feeding history ${i} with x ∈ {0, 1} only: every form except θ = 0 gives the same pupation time (${ds[0].toFixed(3)} d) — not identifiable from such data`);
  const z = daysToPupation(theta0, h) as number, hasUnfed = Array.from({ length: 40 }, (_, d) => h(d)).includes(0);
  ok(hasUnfed ? Math.abs(z - ds[0]) > 1 : Math.abs(z - ds[0]) < 1e-9, `feeding history ${i}: threshold θ = 0 ${hasUnfed ? 'is separated' : 'is not separated'} (${z.toFixed(3)} d vs ${ds[0].toFixed(3)} d)`); }
ok(Math.abs((daysToPupation(theta0, (d) => (d < 14 ? 0 : 1)) as number) - sp.development.larva_days) < 1e-9, 'Phillips pattern under θ = 0: no slowdown when unfed (pupation at larva_days) — contradicts the Phillips direction, so those data exclude θ = 0');
const partial = variants(sp).map((v) => daysToPupation(v.sp, () => 0.3) as number);
ok(Math.max(...partial) / Math.min(...partial) > 5, `a constant partial ration x = 0.3 separates the forms (${Math.min(...partial).toFixed(1)}–${Math.max(...partial).toFixed(1)} days): only partial-ration data could identify the form`);
const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'reports', 'c4b-form-comparison.json'), 'utf8'));
ok(JSON.stringify(committed) === JSON.stringify(JSON.parse(JSON.stringify(compare(sp)))), 'reports/c4b-form-comparison.json equals a fresh computation (node cli/reports/c4b-form-comparison.ts)');
console.log(JSON.stringify({ passed: true, checks }));
