/**
 * #214 Q2/Q3 design checks built on reference-model.ts (NON-OFFICIAL; writes nothing). Produces the tables quoted in
 * docs/p0a2-brood-physiology-design.md between `<!-- bp:<key> -->` markers; tests/brood-physiology.test.ts checks the
 * doc quotes them verbatim. Diagnostics, not targets: no value here was chosen to make any table look a certain way.
 */
import { type Candidates, type Env, type Hazard, type Larva, type Model, type Params, advance, constantEnv, demand, feed, model, newEgg, params, predictNext } from './reference-model.ts';

const FEEDING = new Set(['L1', 'L2', 'L3']);
const f2 = (x: number) => x.toFixed(2), f1 = (x: number) => x.toFixed(1);

/** drive one larva with a per-day ration (µg/day, delivered in 24 equal hourly portions; also exactly at stage entry) */
export function drive(L: Larva, env: Env, M: Model, until: number, ration: (stage: string, t: number) => { s: number; p: number }): Larva {
  let lastFeed = -Infinity;
  while (L.t < until && L.stage !== 'adult' && L.stage !== 'dead') {
    const nx = predictNext(L, env, M, 1 / 24);
    const target = Math.min(until, nx && nx.what.startsWith('stage') ? nx.t : L.t + 1 / 24);
    advance(L, target, env, M);
    if (FEEDING.has(L.stage) && L.t - lastFeed >= 1 / 24 - 1e-9) {
      const r = ration(L.stage, L.t); if (r.s > 0 || r.p > 0) feed(L, L.t, r.s / 24, r.p / 24, env, M); lastFeed = L.t;
    } else if (FEEDING.has(L.stage) && L.stage_entry[L.stage as 'L1'] === L.t) {
      const r = ration(L.stage, L.t); if (r.s > 0 || r.p > 0) feed(L, L.t, r.s / 24, r.p / 24, env, M);
    }
  }
  if (L.t < until) advance(L, until, env, M);
  return L;
}

/** demand-matched daily ration at 28 °C (µg ingested per day) for a feeding stage: sugar covers maintenance + growth
 *  energy (+ the reserve the non-feeding prepupa and pupa will burn, accrued during L3); protein covers deposition */
export function balancedRation(p: Params): Record<string, { s: number; p: number }> {
  const d = Object.fromEntries(demand(p, 28).map((x) => [x.stage, x]));
  const later = d.prepupa.maint_ug_d * p.dev_d28_prepupa + d.pupa.maint_ug_d * p.dev_d28_pupa;
  const D: Record<string, number> = { L1: p.dev_d28_l1, L2: p.dev_d28_l2, L3: p.dev_d28_l3 };
  const out: Record<string, { s: number; p: number }> = {};
  for (const s of ['L1', 'L2', 'L3']) out[s] = { s: (d[s].maint_ug_d + d[s].growth_energy_ug / D[s] + (s === 'L3' ? later / D[s] : 0)) / p.sugar_assim, p: d[s].protein_ingest_ug / D[s] };
  return out;
}

export type Diet = 'balanced' | 'protein_half' | 'sugar_half' | 'sugar_only' | 'protein_only';
export const DIETS: readonly Diet[] = ['balanced', 'protein_half', 'sugar_half', 'sugar_only', 'protein_only'];
/** same total mass per day as the balanced ration, only the composition differs (no demand scaling anywhere) */
export function runDiet(c: Candidates, corner: 'value' | 'demand_low' | 'demand_high', diet: Diet, hazard: Hazard = { family: 'H0' }): Larva {
  const p = params(c, corner), M = model(p, hazard), env = constantEnv('flat', 28), R = balancedRation(p);
  return drive(newEgg('E0001', 1), env, M, 45, (s) => {
    const r = R[s], tot = r.s + r.p;
    switch (diet) {
      case 'balanced': return r;
      case 'protein_half': return { s: r.s + r.p / 2, p: r.p / 2 }; // half the protein mass replaced by sugar
      case 'sugar_half': return { s: r.s / 2, p: r.p + r.s / 2 };   // half the sugar mass replaced by protein
      case 'sugar_only': return { s: tot, p: 0 };
      case 'protein_only': return { s: 0, p: tot };
    }
  });
}
/** ad-lib anchor run: food never limits (gut never empties) */
export function runAdLib(c: Candidates, model_: 'flat' | 'linear_dd_A' | 'q10_refit', T: number): Larva {
  const p = params(c), M = model(p, { family: 'H0' });
  return drive(newEgg('E0001', 1), constantEnv(model_, T), M, 400, () => ({ s: 24_000, p: 24_000 }));
}
/** Phillips 1933 shaped history (R167, thesis p. 29): 25 °C (77 °F cabinet), unfed for `withheld_d` days, then ad lib.
 *  Phillips withheld food from the whole colony; when each larva stopped being fed, and at which instar, was not recorded.
 *  "Unfed from hatch" is this model's assumption (an upper bound on the larva's own unfed time), not the source's. */
export function runPhillips(c: Candidates, model_: 'flat' | 'linear_dd_A' | 'q10_refit', withheld_d: 14 | 21): Larva {
  const p = params(c), M = model(p, { family: 'H0' }), env = constantEnv(model_, 25), L = newEgg('E0001', 1);
  let hatch = Infinity;
  return drive(L, env, M, 400, (s, t) => { if (s === 'L1' && hatch === Infinity) hatch = t; return t - hatch < withheld_d - 1e-9 ? { s: 0, p: 0 } : { s: 24_000, p: 24_000 }; });
}
/** R167 p. 29 treatment groups, kept separate (#226): the 2-week repeat and the accidental 3-week colony */
export const PHILLIPS_OBSERVED: Readonly<Record<14 | 21, string>> = {
  14: '重複試驗 2 週組：幼蟲期 32～36；恢復→化蛹未記錄',
  21: '意外 3 週組：第 38 日仍未長成（起算點未記錄）；恢復後 8 日化蛹（重複試驗 3 週組：工蟻死亡、替補工蟻吃掉幼蟲，無資料）',
};

const larvalTime = (L: Larva) => (L.stage_entry.pupa ?? NaN) - (L.stage_entry.L1 ?? NaN);
const reach = (L: Larva) => L.stage === 'adult' ? `成蟲（第 ${f2(L.stage_entry.adult as number)} 日）` : `第 45 日仍在 ${L.stage}`;

export function tables(c: Candidates): Record<string, string> {
  const out: Record<string, string> = {};
  // demand at 28 °C (central candidate values) + totals for the three corners
  const rows = ['| 階段 | 28°C 階段長（日） | 平均鮮重（mg） | 維持（µg 糖當量／日） | 蛋白沉積（µg） | 蛋白攝入（µg，液態） | 成長能量（µg 糖當量） |', '|---|---|---|---|---|---|---|'];
  const p = params(c);
  for (const x of demand(p, 28)) rows.push(`| ${x.stage} | ${f2(p[`dev_d28_${x.stage.toLowerCase()}`])} | ${x.mass_mg.toFixed(3)} | ${f2(x.maint_ug_d)} | ${f2(x.protein_deposit_ug)} | ${f2(x.protein_ingest_ug)} | ${f2(x.growth_energy_ug)} |`);
  out.demand_28 = rows.join('\n');
  const tot = ['| 參數組 | 幼蟲期蛋白攝入（µg） | 幼蟲期糖攝入（µg，含前蛹＋蛹的儲備） | 蛋白：糖（攝入質量比） | L3 每日糖（µg／日） | L3 每日蛋白（µg／日） |', '|---|---|---|---|---|---|'];
  for (const k of ['value', 'demand_low', 'demand_high'] as const) {
    const q = params(c, k), R = balancedRation(q), D = { L1: q.dev_d28_l1, L2: q.dev_d28_l2, L3: q.dev_d28_l3 } as Record<string, number>;
    const P = ['L1', 'L2', 'L3'].reduce((a, s) => a + R[s].p * D[s], 0), S = ['L1', 'L2', 'L3'].reduce((a, s) => a + R[s].s * D[s], 0);
    tot.push(`| ${k === 'value' ? '候選值' : k === 'demand_low' ? '需求下角（全部取低需求端）' : '需求上角（全部取高需求端）'} | ${f1(P)} | ${f1(S)} | ${f2(P / S)} | ${f2(R.L3.s)} | ${f2(R.L3.p)} |`);
  }
  out.demand_totals = tot.join('\n');
  // anchor
  const an = ['| 溫度形狀 | 巢溫 | 卵→成蟲（日） | 孵化→化蛹（含前蛹，日） | 蛹期（日） |', '|---|---|---|---|---|'];
  for (const [m, T] of [['flat', 28], ['linear_dd_A', 28], ['q10_refit', 28], ['linear_dd_A', 25], ['linear_dd_A', 21], ['q10_refit', 21]] as const) {
    const L = runAdLib(c, m, T);
    an.push(`| ${m} | ${T}°C | ${f2(L.stage_entry.adult as number)} | ${f2(larvalTime(L))} | ${f2((L.stage_entry.adult as number) - (L.stage_entry.pupa as number))} |`);
  }
  out.anchor = an.join('\n');
  // distinguishability
  const di = ['| 參數組 | 飼料（同總質量） | 結果 | 幼蟲期受蛋白限制（日） | 成長受能量限制（日） | 維持未付（日） | 未付維持量（µg 糖當量） |', '|---|---|---|---|---|---|---|'];
  for (const k of ['value', 'demand_low', 'demand_high'] as const) for (const d of DIETS) {
    const L = runDiet(c, k, d);
    di.push(`| ${k} | ${d} | ${reach(L)} | ${f2(L.limit_time.P)} | ${f2(L.limit_time.E_growth)} | ${f2(L.limit_time.E_deficit)} | ${f2(L.unmet)} |`);
  }
  out.distinguish = di.join('\n');
  // Phillips 1933 shape
  const ph = ['| 停食（日；模型自孵化起） | 溫度形狀 | 孵化→化蛹（含前蛹，日） | 恢復餵食→化蛹（日） | 本種觀察（R167 p.29，25°C，整巢停食；同一處理組） |', '|---|---|---|---|---|'];
  for (const w of [14, 21] as const) for (const m of ['flat', 'linear_dd_A', 'q10_refit'] as const) {
    const L = runPhillips(c, m, w);
    ph.push(`| ${w} | ${m} | ${f2(larvalTime(L))} | ${f2((L.stage_entry.pupa as number) - ((L.stage_entry.L1 as number) + w))} | ${PHILLIPS_OBSERVED[w]} |`);
  }
  out.phillips = ph.join('\n');
  return out;
}
export const renderAll = (c: Candidates) => Object.entries(tables(c)).map(([k, v]) => `<!-- bp:${k} -->\n${v}\n<!-- /bp:${k} -->`).join('\n\n');
