/**
 * #214 Q2/Q3 — design-check reference calculation for the brood physiology candidates
 * (docs/p0a2-brood-physiology-design.md). NON-OFFICIAL, design phase only:
 *  - not imported by engine/, cli/, web/, the P0-A2 prototype or the experiment Worker;
 *  - writes nothing; pure functions over (candidates, one larva's own state, its local temperature, its own feeding inputs);
 *  - floating-point, continuous time in days: it proves the equations and invariants are consistent. The P0-A2
 *    implementation must use integer µP / ms with carries so that chunk invariance is bit-exact (design §5.3).
 *
 * Locality (CLAUDE.md §2.1b): a larva's state changes only through `advance` (its own physiology over time at its own
 * local temperature) and `feed` (one actual feeding event delivered to THIS larva). No colony totals, no other larvae.
 */
import { hash32, rng } from '../../engine/rng.ts';

export type Stage = 'egg' | 'L1' | 'L2' | 'L3' | 'prepupa' | 'pupa' | 'adult' | 'dead';
export const STAGES: readonly Stage[] = ['egg', 'L1', 'L2', 'L3', 'prepupa', 'pupa'];
const FEEDING: ReadonlySet<Stage> = new Set(['L1', 'L2', 'L3']);
export type TempModel = 'flat' | 'linear_dd_A' | 'q10_refit';
export type Hazard = { family: 'H0' } | { family: 'H1'; tau_d: number } | { family: 'H2'; lambda_d: number; k: number };
export type Limit = 'none' | 'P' | 'E_growth' | 'E_deficit';

interface ParamEntry { value: number | null; sensitivity: { min: number; max: number } }
export interface Candidates { parameters: Record<string, ParamEntry>; stage_order: string[] }

/** a numeric parameter set (one corner of the sensitivity box, or the candidate values) */
export type Params = Record<string, number>;
export type Corner = 'value' | 'min' | 'max';
/** Demand-raising direction of each demand parameter (true = larger value raises demand). Used to build the low/high
 *  demand corners for the distinguishability check: the SAME candidate box, never a scale factor. */
export const DEMAND_DIRECTION: Record<string, boolean> = {
  mass_adult_minor_dry_ug: true, comp_protein_fraction_dry: true, protein_metamorphic_loss: true,
  protein_assim_liquid: false, protein_net_retention: false, maint_o2_25c: true, maint_q10: true,
  o2_mg_per_ml: true, sucrose_per_o2: true, growth_energy_per_protein: true, sugar_assim: false, mass_final_larva_fresh_mg: true,
};
/** parameter values at a corner; null candidate values fall back to their documented reference rule (design §6). */
export function params(c: Candidates, corner: Corner | 'demand_low' | 'demand_high' = 'value'): Params {
  const out: Params = {};
  for (const [k, e] of Object.entries(c.parameters)) {
    let v: number | null = e.value;
    if (corner === 'min') v = e.sensitivity.min; else if (corner === 'max') v = e.sensitivity.max;
    else if ((corner === 'demand_low' || corner === 'demand_high') && k in DEMAND_DIRECTION) v = (DEMAND_DIRECTION[k] === (corner === 'demand_high')) ? e.sensitivity.max : e.sensitivity.min;
    if (v !== null) out[k] = v;
  }
  out.protein_hatch_fraction ??= 0; // null → 0 (demand upper bound; C4 §3.1: reserve_at_hatch stays unknown)
  out.maint_l1_multiplier ??= 1;    // null → 1 (non-species stage effect not applied)
  return out;
}

const D28: Record<string, string> = { egg: 'dev_d28_egg', L1: 'dev_d28_l1', L2: 'dev_d28_l2', L3: 'dev_d28_l3', prepupa: 'dev_d28_prepupa', pupa: 'dev_d28_pupa' };
const GROUP: Record<string, 'egg' | 'larva' | 'pupa'> = { egg: 'egg', L1: 'larva', L2: 'larva', L3: 'larva', prepupa: 'larva', pupa: 'pupa' };

/** temperature shape φ_s(T), normalised so φ_s(28) = 1 (the Yuan anchor fixes the 28 °C rate; design §3.2) */
export function phi(p: Params, model: TempModel, stage: Stage, T: number): number {
  if (model === 'flat') return 1;
  const g = GROUP[stage];
  if (model === 'linear_dd_A') { const t0 = p[`temp_ld_t0_${g}_c`]; return Math.max(0, T - t0) / (28 - t0); }
  return Math.pow(p[`temp_q10_${g}`], (T - 28) / 10);
}
/** development rate (stage fraction per day) at full nutrition */
export const devRate = (p: Params, m: TempModel, s: Stage, T: number) => phi(p, m, s, T) / p[D28[s]];

/** stage-specific demand derived from the mass balance (design §4.2); pure arithmetic, no feeding involved */
export interface StageDemand { stage: Stage; mass_mg: number; maint_ug_d: number; protein_deposit_ug: number; protein_ingest_ug: number; growth_energy_ug: number }
export function demand(p: Params, T: number): StageDemand[] {
  const g = p.mass_dyar_ratio, M = p.mass_final_larva_fresh_mg;
  const ends = { L1: M / g / g, L2: M / g, L3: M };
  const start = { L1: M / g / g / g, L2: ends.L1, L3: ends.L2 };
  const mean: Record<string, number> = { egg: 0, L1: (start.L1 + ends.L1) / 2, L2: (start.L2 + ends.L2) / 2, L3: (start.L3 + ends.L3) / 2, prepupa: M, pupa: M };
  const adultP = p.mass_adult_minor_dry_ug * p.comp_protein_fraction_dry;
  const totalDeposit = adultP / (1 - p.protein_metamorphic_loss) - p.protein_hatch_fraction * adultP;
  const share: Record<string, number> = { L1: 1 / (g * g), L2: 1 / g - 1 / (g * g), L3: 1 - 1 / g };
  const specific = p.maint_o2_25c * p.o2_mg_per_ml * p.sucrose_per_o2 * 24 * Math.pow(p.maint_q10, (T - 25) / 10); // µg sugar-eq per mg fresh per day
  return STAGES.map((s) => {
    const dep = FEEDING.has(s) ? share[s] * totalDeposit : 0;
    const mult = s === 'pupa' ? p.maint_pupa_ratio : s === 'L1' ? p.maint_l1_multiplier : 1;
    return { stage: s, mass_mg: mean[s], maint_ug_d: s === 'egg' ? 0 : specific * mean[s] * mult, protein_deposit_ug: dep, protein_ingest_ug: dep / (p.protein_net_retention * p.protein_assim_liquid), growth_energy_ug: dep * p.growth_energy_per_protein };
  });
}

export interface Larva {
  id: string; t: number; stage: Stage; prog: number;
  gutS: number; gutP: number; resE: number; resP: number; struct: number;
  meconS: number; meconP: number; egestaS: number; egestaP: number; respired: number; corpseS: number; corpseP: number;
  fedS: number; fedP: number; unmet: number;
  limit_time: Record<Limit, number>; stage_entry: Partial<Record<Stage, number>>;
  bout: number; lambdaPrev: number; lambda: number; hazardDraw: number;
}
export interface Env { model: TempModel; temp: (t: number) => number; nextChange: (t: number) => number }
export const constantEnv = (model: TempModel, T: number): Env => ({ model, temp: () => T, nextChange: () => Infinity });
export interface Model { p: Params; d: Record<string, StageDemand>; absS: Record<string, number>; absP: Record<string, number>; hazard: Hazard; T0: number }

/** absorption capacity per stage (µg ingested per day at 28 °C): minimum that lets an ad-lib larva develop at the
 *  observed 28 °C rate (Yuan), times abs_margin (design §4.3) */
export function model(p: Params, hazard: Hazard): Model {
  const d28 = demand(p, 28), d: Record<string, StageDemand> = {}, absS: Record<string, number> = {}, absP: Record<string, number> = {};
  for (const x of d28) {
    d[x.stage] = x;
    if (!FEEDING.has(x.stage)) continue;
    const r = 1 / p[D28[x.stage]];
    absS[x.stage] = p.abs_margin * (x.maint_ug_d + x.growth_energy_ug * r) / p.sugar_assim;
    absP[x.stage] = p.abs_margin * x.protein_ingest_ug * r;
  }
  return { p, d, absS, absP, hazard, T0: 28 };
}

export function newEgg(id: string, seed: number, t = 0): Larva {
  const u = rng(hash32(`${seed}|larva-hazard|${id}`))();
  return { id, t, stage: 'egg', prog: 0, gutS: 0, gutP: 0, resE: 0, resP: 0, struct: 0, meconS: 0, meconP: 0, egestaS: 0, egestaP: 0, respired: 0, corpseS: 0, corpseP: 0,
    fedS: 0, fedP: 0, unmet: 0, limit_time: { none: 0, P: 0, E_growth: 0, E_deficit: 0 }, stage_entry: { egg: t }, bout: 0, lambdaPrev: 0, lambda: 0, hazardDraw: -Math.log(1 - u) };
}

const EPS = 1e-12;
/** advance one larva's own physiology to time t1 (piecewise-linear exact integration between breakpoints) */
export function advance(L: Larva, t1: number, env: Env, M: Model): void {
  const p = M.p;
  for (let guard = 0; L.t < t1 - EPS && guard < 100000; guard++) {
    if (L.stage === 'adult' || L.stage === 'dead') { L.t = t1; return; }
    const s = L.stage, T = env.temp(L.t), q = Math.pow(p.maint_q10, (T - M.T0) / 10);
    const r = devRate(p, env.model, s, T), fs = FEEDING.has(s), dm = M.d[s];
    const m = dm.maint_ug_d * q; // demand() is tabulated at 28 °C (= M.T0)
    flushGut(L, p);
    const kS = fs && L.gutS > 0 ? M.absS[s] * q : 0, kP = fs && L.gutP > 0 ? M.absP[s] * q : 0;
    const inS = kS * p.sugar_assim, inP = kP * p.protein_assim_liquid;
    const Pneed = fs ? dm.protein_deposit_ug / p.protein_net_retention : 0; // assimilated protein used per unit progress
    const Eneed = fs ? dm.growth_energy_ug : 0;
    const eDry = L.resE <= EPS, pDry = L.resP <= EPS;
    const maintPaid = eDry ? Math.min(m, inS) : m;
    const unmet = m - maintPaid;
    let rho = r, limit: Limit = 'none';
    if (fs && pDry && Pneed > 0 && inP / Pneed < rho) { rho = inP / Pneed; limit = 'P'; }
    if (fs && eDry && Eneed > 0 && (inS - maintPaid) / Eneed < rho) { rho = (inS - maintPaid) / Eneed; limit = 'E_growth'; }
    if (unmet > EPS) { limit = 'E_deficit'; if (fs) rho = 0; }
    if (!fs && unmet > EPS) rho = r; // non-feeding stages keep developing; the deficit acts only through the hazard (design §4.5)
    const dE = inS - maintPaid - rho * Eneed, dP = inP - rho * Pneed;
    const cands = [t1 - L.t, env.nextChange(L.t) - L.t];
    if (kS > 0) cands.push(L.gutS / kS);
    if (kP > 0) cands.push(L.gutP / kP);
    if (!eDry && dE < 0) cands.push(L.resE / -dE);
    if (!pDry && dP < 0) cands.push(L.resP / -dP);
    if (rho > 0) cands.push((1 - L.prog) / rho);
    const h = M.hazard;
    if (unmet > EPS && h.family === 'H1') cands.push(Math.max(0, h.tau_d - L.bout));
    if (unmet > EPS && h.family === 'H2') cands.push(Math.max(0, h.lambda_d * Math.pow(Math.max(0, L.hazardDraw - L.lambdaPrev), 1 / h.k) - L.bout));
    const dt = Math.max(0, Math.min(...cands));
    // apply the segment
    L.gutS -= kS * dt; L.gutP -= kP * dt;
    L.resE += dE * dt; L.resP += dP * dt;
    L.meconS += kS * (1 - p.sugar_assim) * dt; L.meconP += kP * (1 - p.protein_assim_liquid) * dt;
    L.struct += rho * Pneed * p.protein_net_retention * dt;
    L.respired += (maintPaid + rho * Eneed) * dt;
    L.egestaP += rho * Pneed * (1 - p.protein_net_retention) * dt; // assimilated but not retained protein → nitrogenous waste
    L.prog += rho * dt; L.unmet += unmet * dt; L.limit_time[limit] += dt; L.t += dt;
    flushGut(L, p);
    if (unmet > EPS) {
      L.bout += dt;
      if (h.family === 'H2') L.lambda = L.lambdaPrev + Math.pow(L.bout / h.lambda_d, h.k);
      const dies = (h.family === 'H1' && L.bout >= h.tau_d - 1e-9) || (h.family === 'H2' && L.lambda >= L.hazardDraw - 1e-9);
      if (dies) { die(L); return; }
    } else if (L.bout > 0) { L.lambdaPrev = L.lambda; L.bout = 0; } // hazard_recovery = 'retain' in the reference
    if (L.prog >= 1 - 1e-9) nextStage(L);
  }
}
/** float residue left in the gut at a breakpoint (≤ 1e-9 µg) is absorbed at once, split exactly as absorption splits
 *  it, so the per-larva ledgers stay closed (a float artefact of the reference, not physiology) */
function flushGut(L: Larva, p: Params): void {
  if (L.gutS !== 0 && L.gutS <= 1e-9) { L.resE += L.gutS * p.sugar_assim; L.meconS += L.gutS * (1 - p.sugar_assim); L.gutS = 0; }
  if (L.gutP !== 0 && L.gutP <= 1e-9) { L.resP += L.gutP * p.protein_assim_liquid; L.meconP += L.gutP * (1 - p.protein_assim_liquid); L.gutP = 0; }
}
function die(L: Larva): void {
  L.corpseS += L.gutS + L.resE + L.meconS; L.corpseP += L.gutP + L.resP + L.struct + L.meconP;
  L.gutS = L.resE = L.meconS = L.gutP = L.resP = L.struct = L.meconP = 0; L.stage = 'dead'; L.stage_entry.dead = L.t;
}
function nextStage(L: Larva): void {
  const i = STAGES.indexOf(L.stage); L.prog = 0;
  if (L.stage === 'L3') { // blind midgut opens at metamorphosis: meconium and undigested gut content are voided (design §4.3)
    L.egestaS += L.meconS + L.gutS; L.egestaP += L.meconP + L.gutP; L.meconS = L.meconP = L.gutS = L.gutP = 0;
  }
  L.stage = i + 1 < STAGES.length ? STAGES[i + 1] : 'adult'; L.stage_entry[L.stage] = L.t;
}
/** one actual feeding event delivered to THIS larva (amounts ingested, µg); booking first, then the transfer */
export function feed(L: Larva, t: number, sugar_ug: number, protein_ug: number, env: Env, M: Model): void {
  advance(L, t, env, M);
  if (!FEEDING.has(L.stage)) return; // a non-feeding stage cannot ingest; the caller keeps the food (no food is created or lost)
  L.gutS += sugar_ug; L.fedS += sugar_ug; L.gutP += protein_ug; L.fedP += protein_ug;
}
/** per-larva conservation residuals (µg): sugar-equivalent and protein ledgers, design §5.1 */
export function ledger(L: Larva): { sugar: number; protein: number } {
  return {
    sugar: L.fedS - (L.gutS + L.resE + L.meconS + L.egestaS + L.respired + L.corpseS),
    protein: L.fedP - (L.gutP + L.resP + L.struct + L.meconP + L.egestaP + L.corpseP),
  };
}
/** the larva's own next state-change time with no further feeding (for the P0-A2 event queue, design §5.2) */
export function predictNext(L: Larva, env: Env, M: Model, horizon: number): { t: number; what: string } | null {
  const c = structuredClone(L), s0 = c.stage; let had = c.resE > EPS;
  let t = c.t; const step = 1 / 1440, end = c.t + horizon;
  while (t < end - 1e-12) {
    const next = Math.min(end, t + step); advance(c, next, env, M); t = next;
    if (c.stage !== s0) return { t: c.stage === 'dead' ? (c.stage_entry.dead as number) : (c.stage_entry[c.stage] as number), what: c.stage === 'dead' ? 'death' : `stage:${c.stage}` };
    if (had && c.resE <= EPS) return { t: c.t, what: 'reserve_empty' }; // ±1 min in the reference; exact breakpoint in the implementation
    had ||= c.resE > EPS;
  }
  return null;
}
