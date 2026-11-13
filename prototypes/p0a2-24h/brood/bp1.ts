/**
 * BP-1 — configuration of the brood-physiology research candidate and the BroodHook the P0-A2 world receives
 * (WorldOptions.brood). ISOLATED, DEFAULT-OFF: nothing in the P0-A2 core or the experiment Worker imports this file;
 * only Node tests and the report tool build a hook and pass it in explicitly.
 *
 * Inputs (both passed in by the caller, never read here):
 *  - the brood candidate file (antempire.brood-physiology.candidates.v1; design docs/p0a2-brood-physiology-design.md);
 *  - the BP-1 variants file (bp1-variants.json: Owner-ruled choices and labelled assumption values per variant).
 * Every numeric input is resolved once into an explicit, JSON configuration (stored in the world state with its
 * SHA-256): a snapshot restores only under the identical configuration. A candidate needing a null value refuses to
 * activate (Owner #222 Q6 / Q7: null thresholds, rates, shapes and CVs are not silently given defaults).
 * Two documented reference rules of the design (§6) are applied and recorded in the configuration: protein_hatch_fraction
 * null → 0 (the demand upper bound) and maint_l1_multiplier null → 1 (the non-species stage effect not applied).
 */
import { detPow } from '../../../engine/clock/detmath.ts';
import { sha256Hex } from '../../../engine/sha256.ts';
import { makePortionBridge, rationalFromDecimal } from '../../../engine/units/mass-energy.ts';
import { canon } from '../canon.ts';
import type { BroodHook, Json } from '../types.ts';
import {
  type BpLarva, type HazardSpec, type PhysModel, type Stage, type StageConst, type TempModel, type Variance, BP1_PHYSIOLOGY_VERSION, PROG, STAGES,
  advance, contactOf, feedLiquid, ledgerProblem, newLarva, summary,
} from './physiology.ts';

export const BP1_VERSION = 'p0a2-bp1/1';
export const BP1_CONFIG_SCHEMA = 'antempire.p0a2-bp1.config.v1';
export const BP1_VARIANTS_SCHEMA = 'antempire.p0a2-bp1.variants.v1';
export const BP1_LABEL_ZH = '研究候選（隔離、預設關閉；非正式）';
const fail = (m: string): never => { throw Error(`BP1_CONFIG: ${m}`); };
const NUM_KEYS = ['dev_d28_egg', 'dev_d28_l1', 'dev_d28_l2', 'dev_d28_l3', 'dev_d28_prepupa', 'dev_d28_pupa', 'temp_ld_t0_egg_c', 'temp_ld_t0_larva_c', 'temp_ld_t0_pupa_c', 'temp_q10_egg', 'temp_q10_larva', 'temp_q10_pupa',
  'mass_adult_minor_dry_ug', 'mass_final_larva_fresh_mg', 'mass_dyar_ratio', 'comp_protein_fraction_dry', 'protein_metamorphic_loss', 'protein_assim_liquid', 'protein_net_retention',
  'maint_o2_25c', 'maint_pupa_ratio', 'maint_q10', 'o2_mg_per_ml', 'sucrose_per_o2', 'growth_energy_per_protein', 'sugar_assim', 'abs_margin'] as const;
/** linear_dd_B lower thresholds: written in the candidate file's notes of temp_ld_t0_* (P0-B fit B, incl. Phillips) */
const LD_B_RE = /B[^0-9]*?(\d+\.\d+)/;
const CHOICES: Record<string, readonly unknown[]> = {
  temperature_model: ['flat', 'linear_dd_A', 'linear_dd_B', 'q10_refit'], nutrition_gate: ['N-d'], protein_catabolism: [false], maintenance_mass: ['actual', 'stage_mean'],
  hazard_family: ['H0', 'H1', 'H2', 'H3'], hazard_recovery: ['retain', 'reset'], variance_model: ['S0', 'M1', 'M2'], solid_protein_enabled: [false, true], init_stage: ['egg', 'L1'],
};
const REFUSED: Record<string, Record<string, string>> = {
  temperature_model: { briere: 'briere needs Tmax (temp_tmax_c = null): not offered (#222 Q3)' },
  nutrition_gate: { 'N-a': 'N-a is not implemented in BP-1', 'N-b': 'N-b is not implemented in BP-1', 'N-c': 'N-c is not implemented in BP-1' },
  protein_catabolism: { true: 'protein_catabolism true needs a C / N / energy and excreta budget with evidence (#222 Q5): refused' },
};

type Entry = { value: unknown; evidence_class?: string; assumption?: boolean; basis?: string; sources?: string[]; ruling?: string };
/** labelling problems of a variants file (empty = complete) */
export function variantsProblems(v: any): string[] {
  const p: string[] = [];
  if (v?.schema !== BP1_VARIANTS_SCHEMA || v?.official !== false) p.push('schema / official:false');
  const sections: [string, Record<string, Entry>][] = [['base.choices', v?.base?.choices ?? {}], ['base.values', v?.base?.values ?? {}]];
  for (const [n, va] of Object.entries<any>(v?.variants ?? {})) {
    if (!va.label || !va.status || !va.group) p.push(`${n}: label, status and group required`);
    sections.push([`${n}.choices`, va.choices ?? {}], [`${n}.values`, va.values ?? {}]);
    for (const k of Object.keys(va.choices ?? {})) if (!(k in v.base.choices)) p.push(`${n}: unknown choice ${k}`);
    for (const k of Object.keys(va.values ?? {})) if (!(k in v.base.values)) p.push(`${n}: unknown value ${k}`);
  }
  for (const [sec, o] of sections) for (const [k, e] of Object.entries(o)) {
    if (!e || typeof e !== 'object' || !('value' in e)) { p.push(`${sec}.${k}: not a labelled entry`); continue; }
    if (sec.endsWith('choices')) { if (typeof e.ruling !== 'string' || !e.ruling) p.push(`${sec}.${k}: ruling required`); continue; }
    if (e.assumption !== true) p.push(`${sec}.${k}: assumption must be true`);
    if (!['this_species', 'other_species_extrapolated', 'general_physiology', 'game_assumption'].includes(e.evidence_class ?? '')) p.push(`${sec}.${k}: evidence_class`);
    if (typeof e.basis !== 'string' || !e.basis) p.push(`${sec}.${k}: basis required`);
    if (!Array.isArray(e.sources) || !e.sources.every((s) => /^R\d+$/.test(s))) p.push(`${sec}.${k}: sources must be R ids`);
  }
  return p;
}

/** the resolved, self-contained configuration of one variant (JSON; stored in the world state) */
export function bp1Config(candidates: any, variants: any, name: string): { [k: string]: Json } {
  const vp = variantsProblems(variants); if (vp.length) fail(vp.join('; '));
  if (candidates?.schema !== 'antempire.brood-physiology.candidates.v1' || candidates?.official !== false) fail('candidate file schema');
  const va = variants.variants?.[name]; if (!va) fail(`unknown BP-1 variant ${name}`);
  const choice = (k: string): any => (va.choices?.[k] ?? variants.base.choices[k]).value;
  const value = (k: string): any => (va.values?.[k] ?? variants.base.values[k]).value;
  const ch: Record<string, Json> = {};
  for (const k of Object.keys(variants.base.choices)) {
    const x = choice(k), refused = REFUSED[k]?.[String(x)];
    if (refused) fail(refused);
    if (CHOICES[k] && !CHOICES[k].includes(x)) fail(`${k} = ${JSON.stringify(x)} is not offered by BP-1`);
    ch[k] = x as Json;
  }
  const P = candidates.parameters, cand: Record<string, number> = {};
  for (const k of NUM_KEYS) { const x = P[k]?.value; if (typeof x !== 'number' || !Number.isFinite(x)) fail(`candidate ${k} must be a number`); cand[k] = x; }
  for (const g of ['egg', 'larva', 'pupa']) {
    const b = LD_B_RE.exec(String(P[`temp_ld_t0_${g}_c`]?.note ?? ''));
    cand[`temp_ld_b_t0_${g}_c`] = Number((b ?? fail(`linear_dd_B value of temp_ld_t0_${g}_c not found in the candidate note`))[1]);
  }
  // null rules of the design (§6), recorded; any other needed null refuses below
  const nullRules: Record<string, Json> = {
    protein_hatch_fraction: P.protein_hatch_fraction?.value === null ? 'null → 0（需求上界；設計 §6）' : fail('protein_hatch_fraction is no longer null: BP-1 must be revised'),
    maint_l1_multiplier: P.maint_l1_multiplier?.value === null ? 'null → 1（非本種齡期效應不套用；設計 §6）' : fail('maint_l1_multiplier is no longer null: BP-1 must be revised'),
  };
  const vals: Record<string, Json> = {};
  for (const k of Object.keys(variants.base.values)) vals[k] = value(k) as Json;
  const need = (k: string, why: string) => { if (vals[k] === null || vals[k] === undefined) fail(`${why} needs ${k}, which is null (unknown values are not given defaults; #222 Q6 / Q7)`); };
  if (ch.hazard_family === 'H1') need('h1_tau_d', 'H1');
  if (ch.hazard_family === 'H2') { need('h2_lambda_d', 'H2'); need('h2_k', 'H2'); }
  if (ch.hazard_family === 'H3') need('h3_debt_fraction', 'H3');
  if (ch.variance_model !== 'S0') for (const k of ['cv_egg', 'cv_larva', 'cv_pupa']) need(k, ch.variance_model as string);
  if (ch.solid_protein_enabled === true) need('protein_assim_solid', 'the solid-protein candidate');
  need('sugar_bridge_mg_per_portion', 'feeding through the legacy-portion bridge');
  if (typeof vals.nest_temp_c !== 'number' || !Number.isFinite(vals.nest_temp_c)) fail('nest_temp_c must be a number');
  if (!Number.isSafeInteger(vals.step_ms) || (vals.step_ms as number) < 1000 || 86_400_000 % (vals.step_ms as number) !== 0) fail('step_ms must be an integer >= 1000 dividing one day');
  return {
    schema: BP1_CONFIG_SCHEMA, version: BP1_VERSION, physiology: BP1_PHYSIOLOGY_VERSION, variant: name, group: va.group, label: va.label, status: va.status,
    candidate_file_sha256: sha256Hex(canon(candidates)), variants_file_sha256: sha256Hex(canon(variants)),
    choices: ch, values: vals, candidate_values: cand, null_rules: nullRules, assumption: true, official: false,
  };
}

const rat = (x: number | string) => { const r = rationalFromDecimal(String(x), 9); return { num: r.num, den: r.den }; };
const D28: Record<string, string> = { egg: 'dev_d28_egg', L1: 'dev_d28_l1', L2: 'dev_d28_l2', L3: 'dev_d28_l3', prepupa: 'dev_d28_prepupa', pupa: 'dev_d28_pupa' };
const GROUP: Record<string, 'egg' | 'larva' | 'pupa'> = { egg: 'egg', L1: 'larva', L2: 'larva', L3: 'larva', prepupa: 'larva', pupa: 'pupa' };

/** temperature shape φ_s(T), normalised so φ_s(28) = 1 (the R94 anchor fixes the 28 °C rate; design §3.2) */
export function phi(c: Record<string, number>, model: TempModel, stage: Stage, T: number): number {
  const g = GROUP[stage];
  if (model === 'flat') return 1;
  if (model === 'linear_dd_A' || model === 'linear_dd_B') { const t0 = model === 'linear_dd_A' ? c[`temp_ld_t0_${g}_c`] : c[`temp_ld_b_t0_${g}_c`]; return Math.max(0, T - t0) / (28 - t0); }
  return detPow(c[`temp_q10_${g}`], (T - 28) / 10);
}

/** the integer physiology model of a configuration (design §4.2 mass balance; same equations as the reference model) */
export function physModelOf(cfg: any): PhysModel {
  const c = cfg.candidate_values as Record<string, number>, ch = cfg.choices, v = cfg.values, T = v.nest_temp_c as number, tm = ch.temperature_model as TempModel;
  const g = c.mass_dyar_ratio, M = c.mass_final_larva_fresh_mg * 1e6; // ng
  const ends = { L1: M / g / g, L2: M / g, L3: M }, start = { L1: M / g / g / g, L2: M / g / g, L3: M / g };
  const mean: Record<string, number> = { egg: 0, L1: (start.L1 + ends.L1) / 2, L2: (start.L2 + ends.L2) / 2, L3: (start.L3 + ends.L3) / 2, prepupa: M, pupa: M };
  const adultP = c.mass_adult_minor_dry_ug * c.comp_protein_fraction_dry * 1000; // ng
  const depTotal = adultP / (1 - c.protein_metamorphic_loss); // − protein_hatch_fraction (null → 0) × adultP
  const share: Record<string, number> = { L1: 1 / (g * g), L2: 1 / g - 1 / (g * g), L3: 1 - 1 / g };
  // maintenance, ng sugar per ng fresh mass per day: mL O₂ g⁻¹ h⁻¹ × mg/mL × mg sucrose / mg O₂ × 24 h → mg/g/d = 1e-3 ng/ng/d
  const spec = (Tc: number) => c.maint_o2_25c * c.o2_mg_per_ml * c.sucrose_per_o2 * 24 * detPow(c.maint_q10, (Tc - 25) / 10) / 1000;
  const q = detPow(c.maint_q10, (T - 28) / 10);
  const stages: Record<string, StageConst> = {};
  for (const s of STAGES) {
    const feeding = s === 'L1' || s === 'L2' || s === 'L3', dep = feeding ? share[s] * depTotal : 0, r28 = 1 / c[D28[s]];
    const mult = s === 'pupa' ? c.maint_pupa_ratio : 1;
    const maint28 = s === 'egg' ? 0 : spec(28) * mean[s] * mult, growthE = dep * c.growth_energy_per_protein, ingestP = dep / (c.protein_net_retention * c.protein_assim_liquid);
    const absS = feeding ? (c.abs_margin * (maint28 + growthE * r28)) / c.sugar_assim * q : 0, absP = feeding ? c.abs_margin * ingestP * r28 * q : 0;
    stages[s] = {
      dev_per_day: Math.round((PROG * phi(c, tm, s, T)) / c[D28[s]]), abs_s: Math.round(absS), abs_p: Math.round(absP), abs_solid: Math.round(absP),
      p_need: Math.round(dep / c.protein_net_retention), e_need: Math.round(growthE), mean_mass: Math.round(mean[s]), maint_mult: mult,
    };
  }
  const hz = ch.hazard_family as string;
  const hazard: HazardSpec = hz === 'H1' ? { family: 'H1', tau_d: v.h1_tau_d } : hz === 'H2' ? { family: 'H2', lambda_d: v.h2_lambda_d, k: v.h2_k } : hz === 'H3' ? { family: 'H3', debt_fraction: v.h3_debt_fraction } : { family: 'H0' };
  const variance: Variance = ch.variance_model === 'S0' ? { model: 'S0' } : { model: ch.variance_model, cv: { egg: v.cv_egg, larva: v.cv_larva, pupa: v.cv_pupa } };
  const mgToNgPerPortion = (x: string) => { const r = rationalFromDecimal(x, 9); return { num: r.num * 1_000_000 / gcdN(r.den, 1_000_000), den: r.den / gcdN(r.den, 1_000_000) }; };
  const sugarBridge = makePortionBridge({ id: `bp1-sugar-${v.sugar_bridge_mg_per_portion}`, target: 'sugar', per_portion: mgToNgPerPortion(String(v.sugar_bridge_mg_per_portion)), evidence: `BP-1 sugar bridge ${v.sugar_bridge_mg_per_portion} mg sugar / legacy portion (bp1-variants.json; audit candidate range ∩ candidate liquid route)`, sources: ['R132', 'R951'] });
  const proteinBridge = v.liquid_protein_mg_per_portion === null ? null : makePortionBridge({ id: `bp1-protein-${v.liquid_protein_mg_per_portion}`, target: 'protein', per_portion: mgToNgPerPortion(String(v.liquid_protein_mg_per_portion)), evidence: `BP-1 COUNTERFACTUAL liquid protein ${v.liquid_protein_mg_per_portion} mg / legacy portion: P0-A2 has no protein source`, sources: [] });
  return {
    version: BP1_PHYSIOLOGY_VERSION, step_ms: v.step_ms, temp_c: T, temp_model: tm, stages, maint_per_ng_day: spec(T), maintenance_mass: ch.maintenance_mass,
    hatch_mass: Math.round(start.L1), final_mass: Math.round(M), dep_total: Math.round(depTotal),
    assim_s: rat(c.sugar_assim), assim_p: rat(c.protein_assim_liquid), assim_solid: ch.solid_protein_enabled ? rat(v.protein_assim_solid) : null, retention: rat(c.protein_net_retention),
    hazard, recovery: ch.hazard_recovery, h3_debt_ng: hz === 'H3' ? Math.round(v.h3_debt_fraction * adultP) : null, variance,
    solid: { enabled: ch.solid_protein_enabled === true, instars: ch.solid_protein_instars as Stage[] }, sugar_bridge: sugarBridge, protein_bridge: proteinBridge, protein_catabolism: false,
  };
}
function gcdN(a: number, b: number): number { while (b) [a, b] = [b, a % b]; return a; }

/** the BroodHook of one variant: what the P0-A2 world calls (one larva at a time) */
export function bp1Hook(candidates: any, variants: any, name: string): BroodHook & { model: PhysModel } {
  const config = bp1Config(candidates, variants, name), m = physModelOf(config), init = config.choices as { init_stage: Stage };
  const L = (bp: Json) => bp as unknown as BpLarva;
  return {
    version: BP1_VERSION, config, config_sha: sha256Hex(canon(config)), model: m,
    init(id, seed, t, initGutUp) {
      const x = newLarva(m, id, seed, t, init.init_stage);
      if (initGutUp > 0) { if (init.init_stage === 'egg') fail('an egg cannot hold the initial legacy gut content'); feedLiquid(x, m, t, seed, initGutUp, false); }
      return x as unknown as Json;
    },
    book(bp, t, seed) { advance(L(bp), m, t, seed); },
    contact(bp, gutCapUp) { return contactOf(L(bp), m, gutCapUp); },
    feed(bp, t, seed, up) { return feedLiquid(L(bp), m, t, seed, up) as unknown as { [k: string]: Json }; },
    bridgedUp(bp) { return L(bp).bridged_up; },
    census(bp) { const x = L(bp), out = { ...summary(x), transitions: x.unlogged.map((r) => ({ ...r })) } as unknown as { [k: string]: Json }; x.unlogged = []; return out; },
    problem(bp) { return ledgerProblem(L(bp)); },
    project(bp, t, seed) { const c = JSON.parse(JSON.stringify(bp)) as BpLarva; advance(c, m, t, seed); return summary(c) as unknown as Json; },
  };
}
