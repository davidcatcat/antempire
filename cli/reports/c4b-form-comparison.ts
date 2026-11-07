/**
 * C4b candidate nutrition-response forms (Owner decision D4, 2026-11-07: no form is chosen; compare them under the same
 * conditions, analyse sensitivity, and report plainly whether the available data can identify one). Report only: no
 * engine change, no parameter change, nothing turned on. Uses the engine's own N(x) (engine/larva-development.ts) with
 * the species file's n_min and larva_days; θ and K are swept over TEST grids (they are null in the species file).
 *
 * Experiments at the reference temperature (temperature factor 1, so only N matters):
 *  E1 constant paid fraction x for every day -> days to pupation = larva_days / N(x)
 *  E2 Phillips 1933 pattern (R167): unfed (x = 0) for 14 days, then fully fed (x = 1)
 *  E3 Yuan 2026 condition (R94): ad libitum (x = 1)
 *  E4 variable partial feeding: x drawn daily from Uniform(a, b) (seeded) -> mean and SD of days to pupation
 * Writes reports/c4b-form-comparison.json.   node cli/reports/c4b-form-comparison.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../lib/load.ts';
import { resolveBundle } from '../../engine/index.ts';
import { nutritionFactor } from '../../engine/larva-development.ts';
import type { SpeciesParams } from '../../engine/params.ts';
import { rng } from '../../engine/rng.ts';

type Form = 'clamp_linear' | 'threshold' | 'saturating';
export const THETAS = [0.25, 0.5, 0.75], KS = [0.1, 0.5, 2];
export function variants(sp: SpeciesParams): { id: string; sp: SpeciesParams }[] {
  const mk = (form: Form, theta: number | null, k: number | null) => ({ ...sp, larval_development: { ...sp.larval_development, nutrition_response: form, threshold_theta: theta, saturation_k: k } }) as SpeciesParams;
  return [{ id: 'clamp_linear', sp: mk('clamp_linear', null, null) }, ...THETAS.map((t) => ({ id: `threshold θ=${t}`, sp: mk('threshold', t, null) })), ...KS.map((k) => ({ id: `saturating K=${k}`, sp: mk('saturating', null, k) }))];
}
/** days until progress ≥ 1 for a daily x sequence (temperature factor 1); fractional day by linear completion */
export function daysToPupation(sp: SpeciesParams, xs: (day: number) => number, maxDays = 2000): number | null {
  let p = 0;
  for (let d = 0; d < maxDays; d++) { const step = nutritionFactor(xs(d), sp) / sp.development.larva_days; if (p + step >= 1) return d + (1 - p) / step; p += step; }
  return null;
}

export function compare(sp: SpeciesParams) {
  const vs = variants(sp), nmin = sp.development.larva_min_nutrition_growth_factor, L = sp.development.larva_days;
  const grid = Array.from({ length: 11 }, (_, i) => i / 10);
  const E1 = vs.map((v) => ({ variant: v.id, N: grid.map((x) => +nutritionFactor(x, v.sp).toFixed(6)), days: grid.map((x) => { const d = daysToPupation(v.sp, () => x); return d === null ? null : +d.toFixed(3); }) }));
  const E2 = vs.map((v) => ({ variant: v.id, pupation_day: +(daysToPupation(v.sp, (d) => (d < 14 ? 0 : 1)) as number).toFixed(6) }));
  const E3 = vs.map((v) => ({ variant: v.id, larval_days: +(daysToPupation(v.sp, () => 1) as number).toFixed(6) }));
  const E4: { variant: string; range: [number, number]; mean: number; sd: number }[] = [];
  for (const [a, b] of [[0, 1], [0.2, 0.6], [0.4, 0.9]] as [number, number][]) for (const v of vs) {
    const ds: number[] = [];
    for (let rep = 0; rep < 2000; rep++) { const g = rng(1000 + rep); ds.push(daysToPupation(v.sp, () => a + (b - a) * g()) as number); }
    const m = ds.reduce((q, x) => q + x, 0) / ds.length, sd = Math.sqrt(ds.reduce((q, x) => q + (x - m) ** 2, 0) / (ds.length - 1));
    E4.push({ variant: v.id, range: [a, b], mean: +m.toFixed(3), sd: +sd.toFixed(3) });
  }
  const spread = (xs: number[]) => +(Math.max(...xs) - Math.min(...xs)).toFixed(9);
  return {
    schema: 'antempire.c4b-form-comparison.v1', note: 'Report only (Owner D4): no form chosen; θ and K are TEST grids (null in the species file). Temperature factor 1 (reference temperature).',
    inputs: { larva_days: L, n_min: nmin, n_min_basis: '遊戲假設 (species development.larva_min_nutrition_growth_factor)', larva_days_basis: '遊戲假設 (mechanism R94)', thetas: THETAS, ks: KS },
    E1_constant_x: { x: grid, rows: E1 },
    E2_phillips_unfed14_then_fed: { rows: E2, spread_days_across_forms: spread(E2.map((r) => r.pupation_day)) },
    E3_yuan_ad_libitum: { rows: E3, spread_days_across_forms: spread(E3.map((r) => r.larval_days)) },
    E4_variable_partial_feeding: { replicates: 2000, rows: E4 },
    identifiability: {
      endpoints_shared: 'every form has N(0) = n_min and N(1) = 1, so any feeding history made only of unfed days (x = 0) and fully fed days (x = 1) gives the same development under every form and every θ, K',
      phillips_1933: 'unfed then fed: x ∈ {0, 1} only -> cannot distinguish the forms (E2 spread across forms ≈ 0); it supports only the direction "no food, slower development; resumes when fed"',
      yuan_2026: 'ad libitum: x = 1 only -> cannot distinguish the forms (E3 spread 0)',
      conclusion: 'With the species data in hand the form is NOT identifiable. Distinguishing data would be development time under controlled PARTIAL rations (several intermediate x levels, per individual), which no species study in docs/references.md reports. n_min itself is a game assumption and fully determines the unfed rate under every form.',
    },
  };
}

if (import.meta.main) {
  const sp = resolveBundle(loadBundle()).species['pheidole-megacephala'];
  const out = compare(sp);
  fs.writeFileSync(path.join(REPO_ROOT, 'reports', 'c4b-form-comparison.json'), JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify({ E2_spread: out.E2_phillips_unfed14_then_fed.spread_days_across_forms, E3_spread: out.E3_yuan_ad_libitum.spread_days_across_forms, E4: out.E4_variable_partial_feeding.rows.filter((r) => r.range[0] === 0.2) }, null, 1));
}
