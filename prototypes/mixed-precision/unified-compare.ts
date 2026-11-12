/**
 * Error of coarse age bins in the unified ledger (#145 item 14: anonymous members may use coarse age bins, but the
 * distribution error must be measured). The same synthetic experiment as lifetime-compare.ts (SYNTH: game assumptions
 * for an unnamed synthetic insect, synthetic temperature) is run with exact ages and with 7-day bins (known IDs keep
 * exact ages inside the coarse run). Model output only; NOT biology and NOT a validation against nature.
 */
import { SYNTH, SCENARIOS, tempOf, type Scenario } from './lifetime-compare.ts';
import { unifiedDay, initialUnified, countOf, type Precision, type UState, type URecord } from './unified.ts';
import { sizeOf } from './members.ts';

export interface UMetrics { final_n: number; mean_n: number; births: number; deaths_adult: number; final_adults: number; adult_entries: number; respired: number }
export function unifiedInit(sc: Scenario, seed: string, precision: Precision, knownAdults = 0): UState {
  return initialUnified(seed, sc.init.map((g, j) => ({
    cohort: `K.init.${j}`, taxon: 'synthetic', colony_id: null, region: 'G', stage: g.stage, count: g.count, age: g.age, reserve: g.reserve,
    known: g.stage === 2 ? Array.from({ length: Math.min(knownAdults, g.count) }, (_, k) => `KNOWN.${j}.${k}`) : [],
  })), precision, { G: 0 });
}
export function runUnified(sc: Scenario, seed: string, precision: Precision, knownAdults = 0, onDay?: (b: UState, r: URecord[], a: UState) => void): UMetrics {
  let st = unifiedInit(sc, seed, precision, knownAdults);
  const m: UMetrics = { final_n: 0, mean_n: 0, births: 0, deaths_adult: 0, final_adults: 0, adult_entries: 0, respired: 0 };
  let sum = 0;
  for (let d = 0; d < sc.days; d++) {
    const out = unifiedDay(st, SYNTH.params, { temp_c: tempOf(st.day), inflow: { G: sc.inflow }, natural: [] });
    onDay?.(st, out.records, out.state);
    for (const r of out.records) {
      if (r.kind === 'birth') m.births += r.identity.count;
      if (r.kind === 'death' && r.stage === 2) m.deaths_adult += r.identity.count;
      if (r.kind === 'transition' && r.stage === 2) m.adult_entries += r.identity.count;
      if (r.kind === 'burn') m.respired += r.food_moves.reduce((a, x) => a + x.amount, 0);
    }
    st = out.state; sum += countOf(st);
  }
  m.final_n = countOf(st); m.mean_n = sum / sc.days;
  m.final_adults = st.groups.filter((g) => g.stage === 2).reduce((a, g) => a + sizeOf(g.members), 0);
  return m;
}
export interface CoarseRow { scenario: string; metric: string; exact_mean: number; exact_sd: number; coarse_mean: number; rel_err: number | null; z: number | null }
const ms = (xs: number[]) => { const mu = xs.reduce((a, b) => a + b, 0) / xs.length; return { mu, sd: xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1)) : 0 }; };
export function coarseError(seeds: string[], scenarios: Scenario[] = SCENARIOS, days?: number, binDays = 7): CoarseRow[] {
  const rows: CoarseRow[] = [];
  for (const sc0 of scenarios) {
    const sc = days ? { ...sc0, days } : sc0;
    const ex = seeds.map((s) => runUnified(sc, s, { reserve: 'exact', age_bin_days: 1, exact_age_colonies: [] }));
    const co = seeds.map((s) => runUnified(sc, s, { reserve: 'exact', age_bin_days: binDays, exact_age_colonies: [] }, 4));
    for (const k of Object.keys(ex[0]) as (keyof UMetrics)[]) {
      const a = ms(ex.map((x) => x[k])), b = ms(co.map((x) => x[k]));
      const se = Math.sqrt(a.sd ** 2 / ex.length + b.sd ** 2 / co.length), diff = b.mu - a.mu;
      rows.push({ scenario: sc.name, metric: k, exact_mean: a.mu, exact_sd: a.sd, coarse_mean: b.mu, rel_err: Math.abs(a.mu) > 1e-9 ? diff / a.mu : null, z: se > 0 ? diff / se : diff === 0 ? 0 : null });
    }
  }
  return rows;
}
