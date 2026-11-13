/**
 * BP-1 — per-larva brood physiology as an ISOLATED, DEFAULT-OFF research candidate inside P0-A2 (Owner #222 Q1–Q8 all A,
 * #219 Q1 mg / J; docs/p0a2-brood-physiology-design.md §2–§5, docs/owner-decisions-2026-11-13b.md).
 * NON-OFFICIAL experiment world only. Not reached by the experiment Worker (the Worker runs the reference P0-A2 world,
 * which never receives a brood hook); tests/bp1-brood.test.ts checks that the Worker graph does not contain this folder.
 *
 * What it is: pure functions over ONE larva's own state (CLAUDE.md §2.1b). A larva changes only through
 *   advance(L, m, t)            its own physiology on the absolute integer time grid up to t, at its own nest temperature;
 *   feedLiquid / feedMass / feedSolid   one completed transfer event delivered to THIS larva by a carer that touched it.
 * Nothing here reads a colony total, another larva, a store or a map.
 *
 * Units (shared mass / energy contract, engine/units/mass-energy.ts; docs/mass-energy-contract.md): sugar and protein
 * in integer ng (one Ledger per food per larva), energy in integer µJ (one Ledger per larva; sugar is burned with
 * `oxidise` through the versioned record sugar_energy_density@v1). Legacy game portions (µP) enter ONLY through a
 * versioned PortionBridge (assumption:true) at the feeding transfer; raw µP and converted ng are both returned for the
 * log. There is no other portion ↔ mass constant here.
 *
 * Time: the physiology runs on an ABSOLUTE grid of `step_ms` (integer ms; grid instants k·step_ms of the world axis).
 * advance(L, t) processes every grid instant g with L.grid < g <= t, in a fixed order inside one instant:
 *   absorption → maintenance → growth / development → stage change → deficit and hazard (death).
 * Every rate is accrued with an integer carry (accrue / scaleWithCarry of the contract), so the state at a grid instant
 * does not depend on when (or how often) the larva was booked in between: booking at a contact, at the daily census or
 * after a snapshot / restore gives bit-identical results (tests: event-split and snapshot-restore byte identity).
 * A feed at t enters the gut at t; its absorption starts at the next grid instant. This fixed-step scheme replaces the
 * exact breakpoint integration of the floating-point reference (design §5.3): an implementation choice, documented;
 * the time resolution is one step (default 1 min).
 *
 * Randomness: each larva has its OWN streams (hash32 of seed | purpose | larva id | stage), drawn only at its own stage
 * entry (threshold, M1 / M2) or once at creation (hazard draw E ~ Exp(1)). Adding or removing other larvae, or splitting
 * events, never changes a larva's draws.
 *
 * Deterministic math: only IEEE-exact Math members; exp / log / pow go through engine/clock/detmath.ts.
 */
import { detCos, detLog, detPow } from '../../../engine/clock/detmath.ts';
import { hash32, rng } from '../../../engine/rng.ts';
import {
  type EnergyLedger, type Ledger, type PortionBridge, type ProteinLedger, type SugarLedger, SUGAR_ENERGY_V1,
  assertConserved, bridgeFromPortions, bridgeToPortions, createLedger, inflow, microPortions, outflow, oxidise, poolOf,
  proteinNg, rational, scaleWithCarry, sugarNg, transfer,
} from '../../../engine/units/mass-energy.ts';

export const BP1_PHYSIOLOGY_VERSION = 'p0a2-bp1-physiology/1';
export type Stage = 'egg' | 'L1' | 'L2' | 'L3' | 'prepupa' | 'pupa' | 'adult' | 'dead';
export const STAGES: readonly Stage[] = ['egg', 'L1', 'L2', 'L3', 'prepupa', 'pupa'];
export const FEEDING: readonly Stage[] = ['L1', 'L2', 'L3'];
export type Limit = 'none' | 'P' | 'E_growth' | 'E_deficit';
export const LIMITS: readonly Limit[] = ['none', 'P', 'E_growth', 'E_deficit'];
/** progress units of one stage at threshold 1 (integer; a stage is complete when prog >= thr) */
export const PROG = 1_000_000_000;
const MS_PER_DAY = 86_400_000;
const fail = (m: string): never => { throw Error(`BP1: ${m}`); };
const isFeeding = (s: Stage) => s === 'L1' || s === 'L2' || s === 'L3';

// ------------------------------------------------------------------------------------------------ resolved model
export type TempModel = 'flat' | 'linear_dd_A' | 'linear_dd_B' | 'q10_refit';
export type HazardSpec = { family: 'H0' } | { family: 'H1'; tau_d: number } | { family: 'H2'; lambda_d: number; k: number } | { family: 'H3'; debt_fraction: number };
export type Variance = { model: 'S0' } | { model: 'M1' | 'M2'; cv: { egg: number; larva: number; pupa: number } };
/** per-stage integer constants at the larva's (constant) nest temperature, derived once from the candidate values */
export interface StageConst {
  /** development rate, progress units per day at full nutrition */ dev_per_day: number;
  /** absorption capacity of the gut, ng ingested per day (sugar, liquid protein, solid protein) */ abs_s: number; abs_p: number; abs_solid: number;
  /** assimilated protein used and sugar burned per full stage (progress PROG) — N-d stoichiometric gate */ p_need: number; e_need: number;
  /** stage-mean fresh mass (ng), for the stage-mean maintenance comparison */ mean_mass: number;
  /** maintenance multiplier of the stage (pupa ratio; L1 multiplier is null in the candidates → 1, design §6) */ maint_mult: number;
}
export interface PhysModel {
  version: typeof BP1_PHYSIOLOGY_VERSION;
  step_ms: number; temp_c: number; temp_model: TempModel;
  stages: Record<string, StageConst>;
  /** maintenance: ng sugar per day per ng fresh mass at the nest temperature (float, IEEE products only) */
  maint_per_ng_day: number;
  maintenance_mass: 'actual' | 'stage_mean';
  /** fresh mass (ng) at hatch and at the end of L3, and the total protein deposit of the larval period (ng) */
  hatch_mass: number; final_mass: number; dep_total: number;
  /** assimilation / retention fractions as exact rationals (num / den) */
  assim_s: { num: number; den: number }; assim_p: { num: number; den: number }; assim_solid: { num: number; den: number } | null; retention: { num: number; den: number };
  hazard: HazardSpec; recovery: 'retain' | 'reset';
  /** H3 threshold: unmet maintenance (ng sugar) >= debt_fraction × adult structural protein (ng); null unless H3 */
  h3_debt_ng: number | null;
  variance: Variance;
  solid: { enabled: boolean; instars: Stage[] };
  /** the versioned legacy-portion bridges of the liquid fed in P0-A2 (sugar; protein only if the liquid carries any) */
  sugar_bridge: PortionBridge<'sugar'> | null; protein_bridge: PortionBridge<'protein'> | null;
  protein_catabolism: false;
}

// ------------------------------------------------------------------------------------------------ per-larva state
export interface Transition { t: number; from: Stage; to: Stage }
export interface BpLarva {
  id: string; v: typeof BP1_PHYSIOLOGY_VERSION;
  stage: Stage; prog: number; thr: number;
  /** last grid instant processed */ grid: number;
  sugar: SugarLedger; protein: ProteinLedger; energy: EnergyLedger;
  /** integer remainders of every accrual / conversion (part of the state; saved with it) */
  carry: Record<string, number>;
  /** time (ms) spent under each development limit (feeding stages) or with unpaid maintenance (all stages) */
  limit_ms: Record<Limit, number>;
  /** cumulative unpaid maintenance (ng sugar), total and current deficit time, longest bout (ms) */
  unmet_ng: number; deficit_ms: number; bout_ms: number; max_bout_ms: number;
  /** H2 cumulative hazard (Λ), its value at the end of the last bout, the own Exp(1) draw; H3 debt since last reset */
  lambda: number; lambda_prev: number; hazard_draw: number; debt_ng: number;
  stage_entry: Partial<Record<Stage, number>>;
  /** raw legacy µP received through the bridge (the world's µP books count this as having left the µP domain) */
  bridged_up: number;
  feeds: number;
  /** transitions not yet logged by the world's daily census (drained by the caller) */
  unlogged: Transition[];
  /** death cause (diagnostic); null while alive */ death: string | null;
}

const draws = (seed: number, purpose: string, id: string, stage = '') => rng(hash32(`${seed}|bp1-${purpose}|${id}|${stage}`));

/** standard normal by Box–Muller with deterministic log / cos (u1 in (0, 1]) */
function normal(g: () => number): number { const u1 = 1 - g(), u2 = g(); return Math.sqrt(-2 * detLog(u1)) * detCos(2 * Math.PI * u2); }
/** Gamma(shape, scale) by Marsaglia–Tsang (shape >= 1 here: shape = 1 / CV², CV <= 0.15 → shape >= 44); algorithm constants */
export function gammaDet(shape: number, scale: number, g: () => number): number {
  if (!(shape >= 1)) fail(`gamma shape ${shape} < 1 not supported`);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let k = 0; k < 10_000; k++) {
    const x = normal(g), v0 = 1 + c * x; if (v0 <= 0) continue;
    const v = v0 * v0 * v0, u = 1 - g();
    if (u < 1 - 0.0331 * x * x * x * x || detLog(u) < 0.5 * x * x + d * (1 - v + detLog(v))) return d * v * scale;
  }
  return fail('gamma sampler did not converge');
}
/** stage threshold θ (S0: 1; M1: Gamma(mean 1, CV); M2: Erlang mean of n = round(1/CV²) Exp(1)) from the larva's own stream */
export function thresholdOf(m: PhysModel, seed: number, id: string, stage: Stage): number {
  const va = m.variance;
  if (va.model === 'S0') return PROG;
  const cv = stage === 'egg' ? va.cv.egg : stage === 'pupa' ? va.cv.pupa : va.cv.larva;
  const g = draws(seed, 'threshold', id, stage);
  let theta: number;
  if (va.model === 'M1') { const shape = 1 / (cv * cv); theta = gammaDet(shape, 1 / shape, g); }
  else { const n = Math.max(1, Math.round(1 / (cv * cv))); let s = 0; for (let i = 0; i < n; i++) s += -detLog(1 - g()); theta = s / n; }
  return Math.max(1, Math.round(theta * PROG));
}

export function newLarva(m: PhysModel, id: string, seed: number, t: number, stage: Stage): BpLarva {
  if (!STAGES.includes(stage)) fail(`initial stage ${stage}`);
  if (!Number.isSafeInteger(t) || t < 0) fail('creation instant must be an integer ms >= 0');
  const u = draws(seed, 'hazard', id)();
  return {
    id, v: BP1_PHYSIOLOGY_VERSION, stage, prog: 0, thr: thresholdOf(m, seed, id, stage), grid: Math.floor(t / m.step_ms) * m.step_ms,
    sugar: createLedger('sugar'), protein: createLedger('protein'), energy: createLedger('energy'),
    carry: {}, limit_ms: { none: 0, P: 0, E_growth: 0, E_deficit: 0 }, unmet_ng: 0, deficit_ms: 0, bout_ms: 0, max_bout_ms: 0,
    lambda: 0, lambda_prev: 0, hazard_draw: -detLog(1 - u), debt_ng: 0, stage_entry: { [stage]: t }, bridged_up: 0, feeds: 0, unlogged: [], death: null,
  };
}

// ------------------------------------------------------------------------------------------------ helpers
const c0 = (L: BpLarva, k: string) => L.carry[k] ?? 0;
/** floor(x · num/den + carry) with the carry stored under key k */
function scaled(L: BpLarva, k: string, x: number, r: { num: number; den: number }): number {
  const o = scaleWithCarry(x, rational(r.num, r.den), c0(L, k)); L.carry[k] = o.carry; return o.value;
}
/** a per-day integer rate accrued over one step, with the carry stored under key k */
const accrueStep = (L: BpLarva, k: string, perDay: number, stepMs: number) => scaled(L, k, stepMs, { num: perDay, den: MS_PER_DAY });
const S = (L: BpLarva, pool: string) => poolOf(L.sugar, pool) as number;
const P = (L: BpLarva, pool: string) => poolOf(L.protein, pool) as number;
/** current fresh mass (ng) used for maintenance: Q8 A from its own deposited structural protein (linear between hatch and
 *  final larval mass — game assumption), or the stage-mean comparison */
export function freshMass(L: BpLarva, m: PhysModel): number {
  if (L.stage === 'egg') return 0;
  if (m.maintenance_mass === 'stage_mean') return m.stages[L.stage].mean_mass;
  const st = P(L, 'structure');
  return m.hatch_mass + Math.floor((st * (m.final_mass - m.hatch_mass)) / m.dep_total);
}
/** Growth is charged IN ADVANCE (ceiling): progress dp costs dp·need/PROG ng, paid from a prepaid remainder
 *  `L.carry[k]` (numerator units, 0 <= prepaid < PROG) and then whole ng from the pool. So no progress is ever made
 *  without the material it needs (a floor carry would let the first ng of progress through on credit), and
 *  Σ ng paid · PROG = Σ dp·need + prepaid exactly. affordable = largest dp with dp·need <= prepaid + have·PROG. */
function affordable(have: number, need: number, prepaid: number): number {
  if (need <= 0) return Number.MAX_SAFE_INTEGER;
  return Number((BigInt(have) * BigInt(PROG) + BigInt(prepaid)) / BigInt(need));
}
function charge(L: BpLarva, k: string, dp: number, need: number): number {
  const cost = BigInt(dp) * BigInt(need), pre = BigInt(c0(L, k));
  if (cost <= pre) { L.carry[k] = Number(pre - cost); return 0; }
  const r = cost - pre, n = (r + BigInt(PROG) - 1n) / BigInt(PROG);
  L.carry[k] = Number(n * BigInt(PROG) - r);
  return Number(n);
}

// ------------------------------------------------------------------------------------------------ physiology
/** advance the larva's own physiology to t (every grid instant <= t); never backwards */
export function advance(L: BpLarva, m: PhysModel, t: number, seed: number): void {
  if (!Number.isSafeInteger(t)) fail('t must be an integer ms');
  const last = Math.floor(t / m.step_ms) * m.step_ms;
  if (last < L.grid) return; // already booked up to a later grid instant than t's (t inside the same step)
  if (L.stage === 'adult' || L.stage === 'dead') { L.grid = last; return; }
  for (let g = L.grid + m.step_ms; g <= last; g += m.step_ms) { step(L, m, g, seed); L.grid = g; if (!STAGES.includes(L.stage)) { L.grid = last; return; } }
}

function step(L: BpLarva, m: PhysModel, g: number, seed: number): void {
  const s = L.stage, k = m.stages[s], dt = m.step_ms, feeding = isFeeding(s);
  // 1. absorption (gut → reserve × assimilation, the rest → meconium; blind midgut, voided at metamorphosis)
  if (feeding) {
    const absorb = (pool: string, cap: number, ck: string, ak: string, ass: { num: number; den: number }, food: 'sugar' | 'protein') => {
      const led = food === 'sugar' ? L.sugar : L.protein, have = poolOf(led as Ledger<number>, pool) as number;
      const want = accrueStep(L, ck, cap, dt); const take = Math.min(want, have); if (take === 0) return;
      const a = scaled(L, ak, take, ass);
      transfer(led as Ledger<number>, pool, 'reserve', a); transfer(led as Ledger<number>, pool, 'meconium', take - a);
    };
    absorb('gut', k.abs_s, 'abs_s', 'ass_s', m.assim_s, 'sugar');
    absorb('gut', k.abs_p, 'abs_p', 'ass_p', m.assim_p, 'protein');
    if (m.assim_solid) absorb('gut_solid', k.abs_solid, 'abs_solid', 'ass_solid', m.assim_solid, 'protein');
  }
  // 2. maintenance from the reserve (sugar; protein_catabolism false: protein is never burned)
  // In deficit = its maintenance runs (rate > 0) and its sugar reserve is exhausted after paying what it could. The state
  // does not depend on whether this step's integer accrual happened to be 0 ng (low rates accrue 1 ng only every few
  // steps); the unpaid amount itself is accrued exactly (unmet_ng).
  let unmet = 0, deficit = false;
  if (s !== 'egg') {
    const rate = Math.floor(m.maint_per_ng_day * freshMass(L, m) * k.maint_mult);
    const need = accrueStep(L, 'maint', rate, dt), paid = Math.min(need, S(L, 'reserve'));
    if (paid > 0) { const o = oxidise(L.sugar, 'reserve', sugarNg(paid), L.energy, 'released', SUGAR_ENERGY_V1, c0(L, 'ox_m')); L.carry.ox_m = o.carry; outflow(L.energy, 'released', 'maintenance', o.value); }
    unmet = need - paid; deficit = rate > 0 && S(L, 'reserve') === 0;
  }
  // 3. development: non-feeding stages by temperature only; feeding stages through the N-d stoichiometric gate
  const dp = scaled(L, 'dev', dt, { num: k.dev_per_day, den: MS_PER_DAY });
  let limit: Limit = deficit ? 'E_deficit' : 'none';
  if (feeding) {
    let dpf = 0;
    if (!deficit) {
      const maxP = affordable(P(L, 'reserve'), k.p_need, c0(L, 'grow_p')), maxE = affordable(S(L, 'reserve'), k.e_need, c0(L, 'grow_e'));
      dpf = Math.min(dp, maxP, maxE);
      if (dpf < dp) limit = maxP <= maxE ? 'P' : 'E_growth';
      if (dpf > 0) {
        const cp = charge(L, 'grow_p', dpf, k.p_need), ce = charge(L, 'grow_e', dpf, k.e_need);
        if (cp > 0) { const kept = scaled(L, 'ret', cp, m.retention); transfer(L.protein, 'reserve', 'structure', proteinNg(kept)); outflow(L.protein, 'reserve', 'excreted:nitrogenous', proteinNg(cp - kept)); }
        if (ce > 0) { const o = oxidise(L.sugar, 'reserve', sugarNg(ce), L.energy, 'released', SUGAR_ENERGY_V1, c0(L, 'ox_g')); L.carry.ox_g = o.carry; outflow(L.energy, 'released', 'growth_cost', o.value); }
      }
    }
    L.prog += dpf;
  } else L.prog += dp;
  L.limit_ms[limit] += dt;
  // 4. stage change at this grid instant (excess progress is not carried into the next stage: ≤ one step)
  if (L.prog >= L.thr) {
    if (s === 'L3') for (const pool of ['gut', 'meconium']) {
      const a = S(L, pool); if (a > 0) outflow(L.sugar, pool, 'egested:meconium', sugarNg(a));
    }
    if (s === 'L3') for (const pool of ['gut', 'gut_solid', 'meconium']) { const a = P(L, pool); if (a > 0) outflow(L.protein, pool, 'egested:meconium', proteinNg(a)); }
    const next: Stage = STAGES[STAGES.indexOf(s) + 1] ?? 'adult';
    L.unlogged.push({ t: g, from: s, to: next }); L.stage = next; L.prog = 0; L.stage_entry[next] = g;
    L.thr = next === 'adult' ? PROG : thresholdOf(m, seed, L.id, next);
  }
  // 5. deficit bookkeeping and hazard (H0: diagnostics only, never lethal)
  L.unmet_ng += unmet;
  if (deficit) {
    L.deficit_ms += dt; L.bout_ms += dt; L.debt_ng += unmet; if (L.bout_ms > L.max_bout_ms) L.max_bout_ms = L.bout_ms;
    const h = m.hazard;
    if (h.family === 'H2') L.lambda = L.lambda_prev + detPow(L.bout_ms / (h.lambda_d * MS_PER_DAY), h.k);
    const dies = (h.family === 'H1' && L.bout_ms >= Math.round(h.tau_d * MS_PER_DAY)) || (h.family === 'H2' && L.lambda >= L.hazard_draw) || (h.family === 'H3' && L.debt_ng >= (m.h3_debt_ng as number));
    if (dies && L.stage !== 'adult') die(L, g, h.family);
  } else if (L.bout_ms > 0) {
    // the deficit ended (refeeding): keep the accumulated hazard (Owner #222 Q6 A) or reset it (comparison)
    if (m.recovery === 'retain') L.lambda_prev = L.lambda; else { L.lambda_prev = 0; L.lambda = 0; L.debt_ng = 0; }
    L.bout_ms = 0;
  }
}

function die(L: BpLarva, g: number, cause: string): void {
  for (const pool of ['gut', 'reserve', 'meconium']) { const a = S(L, pool); if (a > 0) transfer(L.sugar, pool, 'corpse', sugarNg(a)); }
  for (const pool of ['gut', 'gut_solid', 'reserve', 'structure', 'meconium']) { const a = P(L, pool); if (a > 0) transfer(L.protein, pool, 'corpse', proteinNg(a)); }
  L.unlogged.push({ t: g, from: L.stage, to: 'dead' }); L.stage = 'dead'; L.stage_entry.dead = g; L.death = `${cause}: starvation hazard (research candidate)`;
}

// ------------------------------------------------------------------------------------------------ feeding (completed transfers only)
/** a mass feed delivered to THIS larva (source = the transfer's named origin); only feeding stages ingest */
export function feedMass(L: BpLarva, m: PhysModel, t: number, seed: number, sugar: number, protein: number, source: string): void {
  advance(L, m, t, seed);
  if (!isFeeding(L.stage)) fail(`${L.id} (${L.stage}) cannot ingest: the carer keeps the food`);
  if (sugar > 0) inflow(L.sugar, source, 'gut', sugarNg(sugar));
  if (protein > 0) inflow(L.protein, source, 'gut', proteinNg(protein));
  L.feeds++;
}
/** the P0-A2 liquid feed: `up` legacy µP from the carer's crop, converted at the transfer by the versioned bridges */
export function feedLiquid(L: BpLarva, m: PhysModel, t: number, seed: number, up: number, countAsFeed = true): { raw_up: number; sugar_ng: number; protein_ng: number; sugar_bridge: string | null; protein_bridge: string | null; assumption: true } {
  advance(L, m, t, seed);
  if (!isFeeding(L.stage)) fail(`${L.id} (${L.stage}) cannot ingest: the carer keeps the food`);
  const bridge = m.sugar_bridge ?? fail('no sugar bridge: the candidate cannot accept legacy-portion food');
  const sb = bridgeFromPortions(bridge, microPortions(up), c0(L, 'bridge_s')); L.carry.bridge_s = sb.carry;
  const sTag = `bridge:${bridge.id}@${bridge.version}`;
  if (sb.value > 0) inflow(L.sugar, sTag, 'gut', sb.value);
  let pv = 0, pTag: string | null = null;
  if (m.protein_bridge) {
    const pb = bridgeFromPortions(m.protein_bridge, microPortions(up), c0(L, 'bridge_p')); L.carry.bridge_p = pb.carry; pv = pb.value;
    pTag = `bridge:${m.protein_bridge.id}@${m.protein_bridge.version}`;
    if (pv > 0) inflow(L.protein, pTag, 'gut', pb.value);
  }
  L.bridged_up += up; if (countAsFeed) L.feeds++;
  return { raw_up: up, sugar_ng: sb.value, protein_ng: pv, sugar_bridge: sTag, protein_bridge: pTag, assumption: true };
}
/** ISOLATED, DEFAULT-OFF candidate (#222 Q2): solid protein placed on a larva; only the configured instars (L3) accept */
export function feedSolid(L: BpLarva, m: PhysModel, t: number, seed: number, protein: number, source: string): boolean {
  if (!m.solid.enabled || !m.assim_solid) fail('solid protein candidate is off (or protein_assim_solid is null)');
  advance(L, m, t, seed);
  if (!m.solid.instars.includes(L.stage)) return false; // not accepted: the carer keeps it (nothing created or lost)
  inflow(L.protein, source, 'gut_solid', proteinNg(protein)); L.feeds++;
  return true;
}

// ------------------------------------------------------------------------------------------------ what a carer perceives at a contact
/** the larva's own begging signal and room (µP) for one liquid of the bridged composition: 1 − gut fill, where the gut
 *  capacity is the legacy capacity (µP) expressed through the same bridges; non-feeding stages do not beg (0, 0) */
export function contactOf(L: BpLarva, m: PhysModel, gutCapUp: number): { begging: number; room: number; contactable: boolean } {
  if (L.stage === 'adult' || L.stage === 'dead') return { begging: 0, room: 0, contactable: false };
  const sb = m.sugar_bridge;
  if (!isFeeding(L.stage) || !sb) return { begging: 0, room: 0, contactable: true };
  const per = (b: PortionBridge<'sugar' | 'protein'> | null) => (b ? bridgeFromPortions(b, microPortions(gutCapUp)).value : 0);
  const cap = per(sb) + per(m.protein_bridge), held = S(L, 'gut') + P(L, 'gut');
  if (cap <= 0) return { begging: 0, room: 0, contactable: true };
  const free = Math.max(0, cap - held);
  // room in µP of the bridged liquid (floor): the inverse bridge of the free solute mass, per unit of liquid composition
  const room = m.protein_bridge ? Math.floor((free * gutCapUp) / cap) : bridgeToPortions(sb, sugarNg(free)).value;
  return { begging: Math.max(0, 1 - held / cap), room: Math.min(room, gutCapUp), contactable: true };
}

// ------------------------------------------------------------------------------------------------ checks and summaries
/** per-larva integer conservation (every ledger closes, every pool >= 0); returns a problem or null */
export function ledgerProblem(L: BpLarva): string | null {
  try { assertConserved(L.sugar); assertConserved(L.protein); assertConserved(L.energy); } catch (e) { return `${L.id}: ${(e as Error).message}`; }
  if (L.stage === 'dead' && ['gut', 'reserve', 'meconium'].some((p) => S(L, p) !== 0)) return `${L.id}: a dead larva holds living sugar pools`;
  return null;
}
const tot = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
/** compact summary of one larva for logs, reports and observers (copies only) */
export function summary(L: BpLarva): { [k: string]: unknown } {
  return {
    id: L.id, stage: L.stage, prog: L.prog, thr: L.thr, stage_entry: { ...L.stage_entry },
    sugar_ng: { ...L.sugar.pools }, protein_ng: { ...L.protein.pools },
    fed_sugar_ng: tot(L.sugar.sources), fed_protein_ng: tot(L.protein.sources), energy_uj: { ...L.energy.sinks },
    unmet_ng: L.unmet_ng, deficit_ms: L.deficit_ms, max_bout_ms: L.max_bout_ms, limit_ms: { ...L.limit_ms },
    lambda: L.lambda, feeds: L.feeds, bridged_up: L.bridged_up, death: L.death,
  };
}
