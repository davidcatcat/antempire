/**
 * P0-B life history and temperature: isolated sensitivity analysis (Issues #83, #84). REPORT ONLY.
 * No engine change, no parameter change, nothing switched on; the official day loop never imports this file
 * (tests/p0b-life-history.test.ts checks that). docs/p0b-life-history-evidence-matrix.md quotes the tables verbatim.
 *
 * Parts
 *  A. What the CURRENT engine does: the official developBrood() / workerSurvival() are called on a throw-away synthetic
 *     colony (constant nest temperature, full ration, workers present) to measure stage days, egg->adult days and the
 *     within-cohort emergence spread; worker lifespan is also computed exactly from the species hazard formula.
 *  B. Candidate temperature-rate models for mean development (fitted here from the species data points typed in below):
 *     legacy Q10 (engine), linear degree-day (Fluker+Chang+Yuan; all six points), per-stage Q10 refit, Briere-1 with an
 *     assumed Tmax (not identifiable from the data).
 *  C. Candidate cohort-spread models: per-stage Gamma thresholds (equivalent in distribution to an Erlang distributed
 *     delay with k = 1/CV^2; checked numerically), plus a persistent individual factor. All CV / sigma values are TEST
 *     values (game assumptions), not parameters.
 *  D. Lifespan: engine hazard vs Yuan 2026 Table S3 and Gompertz fits; temperature scaling with Q10_life (null for this
 *     species; 1.93 is a non-species S. invicta value used only as a sensitivity case).
 *  E. Queen oviposition: the engine's stationary eggs/day vs Chang 1985.
 *
 * Determinism: every random draw comes from a named stream sha256(`${seed}|${day}|p0b:${individual id}:${purpose}`)
 * (engine/rng.ts), so results depend on (seed, id, purpose) only, never on array order or processing order.
 * Survival is NOT a correctness criterion here; brood mortality is not simulated (every egg is followed to emergence).
 *
 *   node cli/reports/p0b-life-history.ts          writes reports/p0b-life-history/{summary.json, seed-NN.json, tables.md}
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../lib/load.ts';
import { resolveBundle } from '../../engine/index.ts';
import { developBrood } from '../../engine/brood.ts';
import { workerSurvival } from '../../engine/queen.ts';
import { clamp } from '../../engine/math.ts';
import { dice, gamma, normal, type Rng } from '../../engine/rng.ts';
import type { SpeciesParams } from '../../engine/params.ts';
import type { Brood, ColonyState, ColonySummary, SimEvent, WorldState } from '../../engine/types.ts';

export const OUT_DIR = path.join(REPO_ROOT, 'reports', 'p0b-life-history');
export const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
export const COHORT = 255; // Yuan 2026 (R94) 24-h egg batch size, used as the cohort size (no mortality is simulated)
export const TEMPS = [20, 21, 22, 24, 26, 26.5, 28, 30, 32];
const HORIZON = 365; // days; emergence later than this is reported as not emerged
const STAGES = ['egg', 'larva', 'pupa'] as const;
type Stage = typeof STAGES[number];
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
const f2 = (x: number | null) => (x === null || !Number.isFinite(x) ? '—' : x.toFixed(2));

// ---------------------------------------------------------------------------------------------------------------------
// Species data points (days; larva includes the prepupa). Copied from reports/phase3-lifecycle/fits.py (same provenance
// notes); Yuan values re-checked against the full text on 2026-11-08.
export const DATA = [
  { id: 'Fluker1969_R166', T: 21.0, egg: 21.0, larva: 30.0, pupa: 21.0, total: 72.0, estimator: 'range midpoints (66-78)', set: 'fcy' },
  { id: 'Phillips1933C_R167', T: 23.6, egg: 18.0, larva: 27.0, pupa: 20.5, total: 65.5, estimator: 'class mean', set: 'phillips' },
  { id: 'Phillips1933B_R167', T: 25.6, egg: 17.0, larva: 23.5, pupa: 19.0, total: 59.5, estimator: 'class mean', set: 'phillips' },
  { id: 'Phillips1933A_R167', T: 27.0, egg: 12.0, larva: 20.0, pupa: 20.0, total: 52.0, estimator: 'class mean', set: 'phillips' },
  { id: 'Chang1985_R136', T: 26.5, egg: 8.5, larva: 16.5, pupa: 9.0, total: 36.0, estimator: 'average minimum (34-38)', set: 'fcy' },
  { id: 'Yuan2026_R94', T: 28.0, egg: 7.69, larva: 15.99, pupa: 5.05, total: 28.73, estimator: 'mean of milestone days (n=52 adults)', set: 'fcy' },
] as const;

// ---------------------------------------------------------------------------------------------------------------------
// B. Temperature-rate models: rate_s(T) in stage fractions per day
const linfit = (xs: number[], ys: number[]) => {
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
  return { a: my - (sxy / sxx) * mx, b: sxy / sxx };
};
export function fitDegreeDay(points: readonly { T: number; d: number }[]) { const { a, b } = linfit(points.map((p) => p.T), points.map((p) => 1 / p.d)); return { T0: -a / b, K: 1 / b }; }
export function fitQ10(points: readonly { T: number; d: number }[]) { const { a, b } = linfit(points.map((p) => (p.T - 25) / 10), points.map((p) => Math.log(p.d))); return { D25: Math.exp(a), Q10: Math.exp(-b) }; }
const briereShape = (T: number, Tmin: number, Tmax: number) => (T > Tmin && T < Tmax ? T * (T - Tmin) * Math.sqrt(Tmax - T) : 0);
/** Briere-1 r = a T (T - Tmin) sqrt(Tmax - T) with Tmax GIVEN (assumption); Tmin on a 0.01 grid, a by least squares on rates */
export function fitBriere(points: readonly { T: number; d: number }[], Tmax: number) {
  let best = { sse: Infinity, Tmin: NaN, a: NaN };
  const top = Math.min(...points.map((p) => p.T));
  for (let i = 0; i / 100 < top; i++) {
    const Tmin = i / 100, f = points.map((p) => briereShape(p.T, Tmin, Tmax)), r = points.map((p) => 1 / p.d);
    const a = f.reduce((s, x, j) => s + x * r[j], 0) / f.reduce((s, x) => s + x * x, 0);
    const sse = f.reduce((s, x, j) => s + (a * x - r[j]) ** 2, 0);
    if (sse < best.sse - 1e-15) best = { sse, Tmin, a };
  }
  return best;
}
const pts = (set: 'fcy' | 'all', s: Stage) => DATA.filter((d) => set === 'all' || d.set === 'fcy').map((d) => ({ T: d.T, d: d[s] }));

export interface TempModel { id: string; label: string; basis: string; rate: (s: Stage, T: number) => number; params: Record<string, unknown> }
export const BRIERE_TMAX = [33, 35, 38];
export function tempModels(sp: SpeciesParams): TempModel[] {
  const dev = sp.development;
  const legacy: TempModel = {
    id: 'engine_q10_legacy', label: '現行引擎 Q10', basis: '遊戲假設（species development.*）',
    rate: (s, T) => clamp(Math.pow(dev.q10, (T - dev.reference_c) / 10), dev.min_temp_factor, dev.max_temp_factor) / dev[`${s}_days`],
    params: { q10: dev.q10, reference_c: dev.reference_c, clamp: [dev.min_temp_factor, dev.max_temp_factor], days_at_reference: { egg: dev.egg_days, larva: dev.larva_days, pupa: dev.pupa_days } },
  };
  const dd = (set: 'fcy' | 'all', id: string, label: string): TempModel => {
    const p = Object.fromEntries(STAGES.map((s) => [s, fitDegreeDay(pts(set, s))])) as Record<Stage, { T0: number; K: number }>;
    return { id, label, basis: '機制：一般生理學（線性度日，R170）；數值：本種資料擬合（R166/R136/R94' + (set === 'all' ? '/R167' : '') + '），21～28°C 以外為外推', rate: (s, T) => Math.max(0, T - p[s].T0) / p[s].K, params: Object.fromEntries(STAGES.map((s) => [s, { T0: r4(p[s].T0), K: r4(p[s].K) }])) };
  };
  const q = Object.fromEntries(STAGES.map((s) => [s, fitQ10(pts('fcy', s))])) as Record<Stage, { D25: number; Q10: number }>;
  const q10: TempModel = { id: 'q10_refit_fcy', label: '分階段 Q10 重擬合', basis: '機制：一般生理學（指數）；數值：本種資料擬合（R166/R136/R94）；無低溫門檻', rate: (s, T) => Math.pow(q[s].Q10, (T - 25) / 10) / q[s].D25, params: Object.fromEntries(STAGES.map((s) => [s, { D25: r4(q[s].D25), Q10: r4(q[s].Q10) }])) };
  const briere = BRIERE_TMAX.map((Tmax): TempModel => {
    const p = Object.fromEntries(STAGES.map((s) => [s, fitBriere(pts('fcy', s), Tmax)])) as unknown as Record<Stage, { Tmin: number; a: number }>;
    return { id: `briere_fcy_tmax${Tmax}`, label: `Brière-1（Tmax=${Tmax}°C 假設）`, basis: '機制：一般方法（R221）；Tmax：遊戲假設（本種無 28°C 以上資料，不可辨識）；Tmin、a：本種資料擬合', rate: (s, T) => p[s].a * briereShape(T, p[s].Tmin, Tmax), params: { Tmax_assumption: Tmax, ...Object.fromEntries(STAGES.map((s) => [s, { Tmin: r4(p[s].Tmin), a: Number(p[s].a.toExponential(6)) }])) } };
  });
  return [legacy, dd('fcy', 'dd_fcy', '線性度日（候選 A：Fluker+Chang+Yuan）'), dd('all', 'dd_all6', '線性度日（候選 B：六點含 Phillips）'), q10, ...briere];
}

// ---------------------------------------------------------------------------------------------------------------------
// C. Cohort-spread models (all values are TEST values = game assumptions; species file has none of them)
export interface SpreadModel { id: string; label: string; sigmaInd: number; cv: Record<Stage, number> | null }
export const SPREADS: SpreadModel[] = [
  { id: 'none', label: '無個體差異（現行引擎）', sigmaInd: 0, cv: null },
  { id: 'theta_lo', label: '階段門檻 Gamma，CV 卵 0.06／幼蟲 0.04／蛹 0.04', sigmaInd: 0, cv: { egg: 0.06, larva: 0.04, pupa: 0.04 } },
  { id: 'theta_hi', label: '階段門檻 Gamma，CV 0.10', sigmaInd: 0, cv: { egg: 0.1, larva: 0.1, pupa: 0.1 } },
  { id: 'z036_theta_lo', label: '持久因子 σ=0.036＋theta_lo', sigmaInd: 0.036, cv: { egg: 0.06, larva: 0.04, pupa: 0.04 } },
  { id: 'z10_theta_hi', label: '持久因子 σ=0.10＋theta_hi', sigmaInd: 0.1, cv: { egg: 0.1, larva: 0.1, pupa: 0.1 } },
];
export const ERLANG_K = 100; // = 1/0.10^2, for the M1(theta_hi) == M2(Erlang) distribution check

/** Named stream: depends only on (seed, individual id, purpose). Day 0 of the clock is not used by anything else. */
const stream = (seed: number, id: string, purpose: string): Rng => dice({ seed, sim_day: -1 }, `p0b:${id}:${purpose}`);
export const cohortIds = (n = COHORT) => Array.from({ length: n }, (_, i) => `E${String(i + 1).padStart(4, '0')}`);

export interface Draws { lay: number; zNormal: number; theta: Record<string, Record<Stage, number>>; erlang: Record<Stage, number> }
/** All random quantities of one individual; one stream per purpose, drawn once (never re-drawn per day). */
export function drawIndividual(seed: number, id: string): Draws {
  const lay = stream(seed, id, 'lay_time_in_24h_window')();
  const zNormal = normal(stream(seed, id, 'persistent_factor'));
  const theta: Draws['theta'] = {};
  for (const sm of SPREADS) if (sm.cv) {
    const g = stream(seed, id, `stage_threshold:${sm.id}`);
    theta[sm.id] = Object.fromEntries(STAGES.map((s) => { const k = 1 / sm.cv![s] ** 2; return [s, gamma(k, 1 / k, g)]; })) as Record<Stage, number>;
  }
  const ge = stream(seed, id, `erlang_k${ERLANG_K}`);
  const erlang = Object.fromEntries(STAGES.map((s) => { let t = 0; for (let j = 0; j < ERLANG_K; j++) t += -Math.log(1 - ge()) / ERLANG_K; return [s, t]; })) as Record<Stage, number>;
  return { lay, zNormal, theta, erlang };
}

/** Egg->adult time at constant T: stage s ends when integral of rate_s / (z * theta_s) reaches 1. */
export function emergence(d: Draws, tm: TempModel, sm: SpreadModel | 'erlang', T: number): number {
  const z = sm === 'erlang' ? 1 : Math.exp(sm.sigmaInd * d.zNormal);
  let t = 0;
  for (const s of STAGES) {
    const r = tm.rate(s, T);
    if (!(r > 0)) return Infinity;
    const th = sm === 'erlang' ? d.erlang[s] : sm.cv ? d.theta[sm.id][s] : 1;
    t += (z * th) / r;
  }
  return t;
}
/** Yuan observation operator: laid at u in [0,1) of a 24-h window, checked once a day; first-seen day counted from the window start. */
export const observedDay = (layOffset: number, t: number) => Math.ceil(layOffset + t);

export function stats(xs: number[]) {
  const fin = xs.filter(Number.isFinite), n = fin.length;
  if (!n) return { n_emerged: 0, n_not_emerged: xs.length, mean: null, sd: null, min: null, max: null };
  const m = fin.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(fin.reduce((a, x) => a + (x - m) ** 2, 0) / n);
  return { n_emerged: n, n_not_emerged: xs.length - n, mean: r4(m), sd: r4(sd), min: r4(Math.min(...fin)), max: r4(Math.max(...fin)) };
}
const histogram = (days: number[]) => { const h = new Map<number, number>(); for (const x of days) if (Number.isFinite(x) && x <= HORIZON) h.set(x, (h.get(x) ?? 0) + 1); return [...h.entries()].sort((a, b) => a[0] - b[0]); };

/** Per-id results for one seed; `ids` order is irrelevant to every value (permutation-invariance test). */
export function cohortById(seed: number, ids: string[], tm: TempModel, sm: SpreadModel | 'erlang', T: number): Map<string, { t: number; observed_day: number }> {
  const out = new Map<string, { t: number; observed_day: number }>();
  for (const id of ids) { const d = drawIndividual(seed, id), t = emergence(d, tm, sm, T); out.set(id, { t, observed_day: Number.isFinite(t) && t <= HORIZON ? observedDay(d.lay, t) : Infinity }); }
  return out;
}

export function seedRun(seed: number, models: TempModel[]) {
  const ids = cohortIds(), draws = new Map(ids.map((id) => [id, drawIndividual(seed, id)] as const));
  const rows: unknown[] = [];
  for (const tm of models) for (const sm of SPREADS) for (const T of TEMPS) {
    const ts = ids.map((id) => { const t = emergence(draws.get(id)!, tm, sm, T); return t <= HORIZON ? t : Infinity; });
    const obs = ids.map((id, i) => (Number.isFinite(ts[i]) ? observedDay(draws.get(id)!.lay, ts[i]) : Infinity));
    rows.push({ temp_model: tm.id, spread: sm.id, T, intrinsic_days: stats(ts), yuan_operator_day: stats(obs), yuan_operator_histogram: histogram(obs) });
  }
  const erl = ids.map((id) => emergence(draws.get(id)!, models.find((m) => m.id === 'dd_fcy')!, 'erlang', 28));
  return { seed, rows, erlang_check_dd_fcy_28C: { erlang_k: ERLANG_K, intrinsic_days: stats(erl) } };
}

// ---------------------------------------------------------------------------------------------------------------------
// A. The official engine, measured on a synthetic colony
function syntheticColony(nEggs: number, ids?: string[]): ColonyState {
  const eggs: Brood[] = (ids ?? cohortIds(nEggs)).map((id) => ({ id, stage: 'egg', laid_on_day: 0, age_days: 0, progress: 0, origin: 'p0b synthetic cohort' }) as Brood);
  return {
    id: 'P0B', rng_namespace: 'p0b-engine:', worker_id_prefix: 'W', next_worker_number: 1, id_number_width: 4, egg_id_prefix: 'E', nest_node: 'nest', queen_id: 'Q',
    stores: { sugar: 0, protein: 0, sugar_gap_days: 0, protein_gap_days: 0, stress_days: 0 },
    population: { queen_alive: true, workers: [{ id: 'C0001', alive: true, age_days: 10, injured: false, task: 'nurse', known_sources: [], last_location: 'nest' }], brood: eggs },
  } as unknown as ColonyState;
}
const emptySummary = () => ({ brood_deaths: 0, hatchings: 0, pupations: 0, eclosions: 0 }) as unknown as ColonySummary;
/** Official developBrood at constant nest temperature, full ration, workers present. Returns per-egg event days. */
export function engineCohort(sp: SpeciesParams, seed: number, T: number, ids?: string[]) {
  const colony = syntheticColony(COHORT, ids), day: Record<string, { hatch?: number; pupation?: number; eclosion?: number }> = {};
  for (const b of colony.population.brood) day[b.id] = {};
  for (let d = 1; d <= HORIZON && Object.values(day).some((x) => x.eclosion === undefined); d++) {
    const events: SimEvent[] = [];
    developBrood({ seed, sim_day: d - 1 } as WorldState, colony, sp, { nest_temp_model_c: T } as never, { sFraction: 1, pFraction: 1 }, events, emptySummary());
    for (const e of events as { type: string; id?: string; source_brood_id?: string }[]) {
      if (e.type === 'hatch') day[e.id!].hatch = d; else if (e.type === 'pupation') day[e.id!].pupation = d; else if (e.type === 'eclosion') day[e.source_brood_id!].eclosion = d;
    }
  }
  return day;
}
export function engineDevelopment(sp: SpeciesParams) {
  return TEMPS.map((T) => {
    const perSeed = SEEDS.map((seed) => engineCohort(sp, seed, T));
    const all = perSeed.flatMap((x) => Object.values(x));
    const ecl = all.map((x) => x.eclosion ?? Infinity), uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    const first = Object.values(perSeed[0])[0];
    const f = clamp(Math.pow(sp.development.q10, (T - sp.development.reference_c) / 10), sp.development.min_temp_factor, sp.development.max_temp_factor);
    return {
      T, temperature_factor: r4(f), continuous_approx_total_days: r4((sp.development.egg_days + sp.development.larva_days + sp.development.pupa_days) / f),
      egg_days: first.hatch!, larva_days: first.pupation! - first.hatch!, pupa_days: first.eclosion! - first.pupation!, egg_to_adult_days: first.eclosion!,
      distinct_eclosion_days_all_seeds: uniq(ecl), distinct_hatch_days_all_seeds: uniq(all.map((x) => x.hatch ?? Infinity)), within_cohort_range_days: Math.max(...ecl) - Math.min(...ecl), individuals: all.length,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// D. Lifespan
export const YUAN_S3 = { census_days: [0, 14, 28, 42, 56, 70, 84, 98], minor: [104, 73, 35, 24, 9, 1, 1, 0], soldier: [14, 12, 11, 11, 8, 6, 1, 0] };
const yuanMean = (n: number[]) => n.slice(0, -1).reduce((a, x, i) => a + ((YUAN_S3.census_days[i] + YUAN_S3.census_days[i + 1]) / 2) * (x - n[i + 1]), 0) / n[0];
export const GOMPERTZ = { minor: { A: 0.0245, B: 0.02 }, soldier: { A: 0.0025, B: 0.044 } }; // reports/phase3-lifecycle/fits-output.txt (interval-censored grid MLE on S3)
const gompS = (A: number, B: number, t: number) => Math.exp((-A / B) * (Math.exp(B * t) - 1));
/** mean and median of a continuous survival curve by 0.001-day trapezoid integration up to 2000 d */
function curveMeanMedian(S: (t: number) => number) { let m = 0, med: number | null = null; const h = 0.001; for (let i = 0; i < 2e6; i++) { const a = S(i * h), b = S((i + 1) * h); m += ((a + b) / 2) * h; if (med === null && b <= 0.5) med = (i + 1) * h; if (b < 1e-12) break; } return { mean: r4(m), median: med === null ? null : r4(med) }; }
/** Engine natural hazard (no injury, no starvation), exact: on day k after eclosion (k = 0 is the eclosion day) the worker's age is k. */
export function engineLifespanExact(sp: SpeciesParams) {
  const L = sp.worker_lifespan; let S = 1, mean = 0, median: number | null = null; const at: Record<number, number> = {};
  for (let k = 0; k < 5000 && S > 1e-15; k++) {
    if (YUAN_S3.census_days.includes(k)) at[k] = r4(S);
    const h = clamp(L.natural_daily_base_hazard + Math.max(0, k - L.age_risk_from_days) * L.age_hazard_slope, 0, L.adult_total_daily_hazard_cap);
    mean += S; S *= 1 - h; // lifespan convention: death on day k counts as k+1 days (the eclosion day is day 0)
    if (median === null && S <= 0.5) median = k + 1;
  }
  return { mean_days: r4(mean), median_days: median, survival_at_census: at, temperature_dependence: 'none (age_days only)' };
}
/** Official workerSurvival on a synthetic cohort (ages incremented as foraging.ts does before survival). */
export function engineLifespanEmpirical(sp: SpeciesParams, seed: number, n = 300) {
  const colony = syntheticColony(0); colony.population.workers = Array.from({ length: n }, (_, i) => ({ id: `W${String(i + 1).padStart(4, '0')}`, alive: true, age_days: 0, injured: false, task: 'nurse', known_sources: [], last_location: 'nest' }) as never);
  const deathDay: number[] = [];
  for (let k = 0; colony.population.workers.length && k < 5000; k++) {
    if (k > 0) for (const w of colony.population.workers) w.age_days++;
    const before = new Set(colony.population.workers.map((w) => w.id));
    workerSurvival({ seed, sim_day: k } as WorldState, colony, sp, [], emptySummary());
    const after = new Set(colony.population.workers.map((w) => w.id));
    for (const id of before) if (!after.has(id)) deathDay.push(k + 1);
  }
  return deathDay;
}
export const Q10_LIFE = [1, 1.93];
export function lifespan(sp: SpeciesParams) {
  const exact = engineLifespanExact(sp);
  const emp = SEEDS.map((seed) => engineLifespanEmpirical(sp, seed)), pooled = emp.flat();
  const gm = { minor: curveMeanMedian((t) => gompS(GOMPERTZ.minor.A, GOMPERTZ.minor.B, t)), soldier: curveMeanMedian((t) => gompS(GOMPERTZ.soldier.A, GOMPERTZ.soldier.B, t)) };
  const yuanFrac = (n: number[]) => Object.fromEntries(YUAN_S3.census_days.map((d, i) => [d, r4(n[i] / n[0])]));
  const gompAt = (c: 'minor' | 'soldier') => Object.fromEntries(YUAN_S3.census_days.map((d) => [d, r4(gompS(GOMPERTZ[c].A, GOMPERTZ[c].B, d))]));
  const byT = TEMPS.map((T) => ({ T, engine_mean: exact.mean_days, ...Object.fromEntries(Q10_LIFE.flatMap((q) => (['minor', 'soldier'] as const).map((c) => [`gompertz_${c}_q10_${q}`, r4(gm[c].mean * Math.pow(q, (28 - T) / 10))]))) }));
  return {
    engine_exact: exact,
    engine_official_empirical: { seeds: SEEDS.length, workers_per_seed: 300, mean_days: r4(pooled.reduce((a, b) => a + b, 0) / pooled.length), per_seed_mean: emp.map((x) => r4(x.reduce((a, b) => a + b, 0) / x.length)) },
    yuan_s3: { minor: { n: 104, survival_at_census: yuanFrac(YUAN_S3.minor), reported_mean: 26.25, recomputed_mean: r4(yuanMean(YUAN_S3.minor)), reported_km_median: 28 }, soldier: { n: 14, survival_at_census: yuanFrac(YUAN_S3.soldier), reported_mean: 56, recomputed_mean: r4(yuanMean(YUAN_S3.soldier)), reported_km_median: 70 } },
    gompertz: { minor: { ...GOMPERTZ.minor, ...gm.minor, survival_at_census: gompAt('minor') }, soldier: { ...GOMPERTZ.soldier, ...gm.soldier, survival_at_census: gompAt('soldier') } },
    ratio_engine_to_yuan_minor_mean: r4(exact.mean_days / 26.25), ratio_engine_to_yuan_all_mean: r4(exact.mean_days / 29.78),
    by_temperature_mean_days: byT,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// E. Queen oviposition (engine, stationary, adequate nutrition, brood count held fixed)
export function oviposition(sp: SpeciesParams) {
  const q = sp.queen_laying, rows: unknown[] = [];
  for (const T of TEMPS) for (const brood of [0, 30, 60, 91]) {
    const temp = Math.min(1, Math.max(0, Math.pow(q.laying_temperature_q10, (T - q.laying_reference_c) / 10)));
    const p0 = clamp(q.base_laying_probability * temp * (1 - q.existing_brood_pressure * brood), 0, q.laying_probability_cap), p1 = clamp(p0 * q.previous_laying_penalty, 0, q.laying_probability_cap);
    const pi = p0 / (1 + p0 - p1), eggsPerLayingDay = q.max_eggs_per_day >= 2 ? 1 + q.second_egg_given_laying_probability : 1;
    rows.push({ T, brood, laying_day_fraction: r4(pi), eggs_per_day: r4(pi * eggsPerLayingDay) });
  }
  return { rows, brood_count_where_probability_reaches_zero: r4(1 / q.existing_brood_pressure), chang1985_eggs_per_queen_day: { low: r4(97 / 31), high: r4(292 / 31), reported_average: 6, batch_size_range: [2, 82], max_interval_days: 8 } };
}

// ---------------------------------------------------------------------------------------------------------------------
export function runAnalysis() {
  const bundle = loadBundle(), sp = resolveBundle(bundle).species['pheidole-megacephala'];
  const models = tempModels(sp);
  const perSeed = SEEDS.map((seed) => seedRun(seed, models));
  const agg = [] as { temp_model: string; spread: string; T: number; mean_of_means: number | null; mean_sd: number | null; sd_min: number | null; sd_max: number | null; pooled_min: number | null; pooled_max: number | null; intrinsic_mean: number | null; intrinsic_sd_mean: number | null; not_emerged: number }[];
  for (const tm of models) for (const sm of SPREADS) for (const T of TEMPS) {
    const rs = perSeed.map((p) => (p.rows as { temp_model: string; spread: string; T: number; intrinsic_days: ReturnType<typeof stats>; yuan_operator_day: ReturnType<typeof stats> }[]).find((r) => r.temp_model === tm.id && r.spread === sm.id && r.T === T)!);
    const y = rs.map((r) => r.yuan_operator_day), it = rs.map((r) => r.intrinsic_days), ok = y.every((s) => s.mean !== null);
    const avg = (xs: number[]) => r4(xs.reduce((a, b) => a + b, 0) / xs.length);
    agg.push({ temp_model: tm.id, spread: sm.id, T, mean_of_means: ok ? avg(y.map((s) => s.mean!)) : null, mean_sd: ok ? avg(y.map((s) => s.sd!)) : null, sd_min: ok ? Math.min(...y.map((s) => s.sd!)) : null, sd_max: ok ? Math.max(...y.map((s) => s.sd!)) : null, pooled_min: ok ? Math.min(...y.map((s) => s.min!)) : null, pooled_max: ok ? Math.max(...y.map((s) => s.max!)) : null, intrinsic_mean: ok ? avg(it.map((s) => s.mean!)) : null, intrinsic_sd_mean: ok ? avg(it.map((s) => s.sd!)) : null, not_emerged: y.reduce((a, s) => a + s.n_not_emerged, 0) });
  }
  const erl = perSeed.map((p) => p.erlang_check_dd_fcy_28C.intrinsic_days), thetaHi = agg.find((a) => a.temp_model === 'dd_fcy' && a.spread === 'theta_hi' && a.T === 28)!;
  const summary = {
    schema: 'antempire.p0b-life-history.v1',
    status: 'REPORT ONLY: no engine, parameter, save or golden change; nothing enabled. Survival is not a correctness criterion. Isolated synthetic runs, 非正式.',
    seeds: SEEDS, cohort_size: COHORT, temperatures_c: TEMPS, horizon_days: HORIZON,
    rng: 'engine/rng.ts dice({seed, sim_day: -1}, `p0b:${id}:${purpose}`): one named stream per individual and purpose',
    observation_operator: 'Yuan 2026: lay time Uniform[0,1) day in a 24-h window (game assumption: distribution not reported); one check per day; day counted from the window start (convention not reported; the other convention is 1 day less)',
    data_points: DATA,
    temp_models: models.map((m) => ({ id: m.id, label: m.label, basis: m.basis, params: m.params })),
    spread_models: SPREADS.map((s) => ({ ...s, basis: s.cv ? '遊戲假設（測試值；theta_lo、σ=0.036 為 docs/research-design-p0b-development-variance.md §3.2 的條件式數量級，不是實證上限）' : '現行引擎' })),
    engine_development: engineDevelopment(sp),
    cohort_aggregate: agg,
    erlang_equivalence_dd_fcy_28C: { erlang_k: ERLANG_K, erlang_mean_of_means: r4(erl.reduce((a, s) => a + s.mean!, 0) / erl.length), erlang_mean_sd: r4(erl.reduce((a, s) => a + s.sd!, 0) / erl.length), theta_hi_mean_of_means: thetaHi.intrinsic_mean, theta_hi_mean_sd: thetaHi.intrinsic_sd_mean },
    lifespan: lifespan(sp),
    oviposition: oviposition(sp),
  };
  return { summary, perSeed, tables: tables(summary) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown tables quoted verbatim by the doc (between <!-- p0b:NAME --> markers)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Summary = Record<string, any>;
function tables(s: Summary): Record<string, string> {
  const t: Record<string, string> = {};
  const obs: Record<number, string> = { 21: 'Fluker 72（66～78，範圍中點）', 26.5: 'Chang 34～38（平均最短）', 28: 'Yuan 28.73 ± 2.83（24～34）' };
  const obsVal: Record<number, number> = { 21: 72, 26.5: 36, 28: 28.73 };
  t.engine_development = ['| 巢溫 °C | 溫度係數 | 卵 | 幼蟲 | 蛹 | 卵→成蟲（日步長，實測引擎） | 連續近似 Σ天數/係數 | 本種觀測 | 引擎相對觀測 | 同批羽化日（20 種子×255 粒） |', '|---|---|---|---|---|---|---|---|---|---|',
    ...s.engine_development.map((r: any) => `| ${r.T} | ${r.temperature_factor} | ${r.egg_days} | ${r.larva_days} | ${r.pupa_days} | ${r.egg_to_adult_days} | ${f2(r.continuous_approx_total_days)} | ${obs[r.T] ?? '—'} | ${obsVal[r.T] ? ((r.egg_to_adult_days / obsVal[r.T] - 1) * 100).toFixed(1) + '%' : '—'} | ${r.distinct_eclosion_days_all_seeds.join('、')}（全距 ${r.within_cohort_range_days} 日） |`)].join('\n');
  const tm = s.temp_models as { id: string; label: string; params: any }[];
  t.fits = ['| 模型 | 卵 | 幼蟲（含前蛹） | 蛹 |', '|---|---|---|---|',
    ...tm.filter((m) => m.id.startsWith('dd_')).map((m) => `| ${m.label} | T0 ${m.params.egg.T0.toFixed(2)}、K ${m.params.egg.K.toFixed(1)} | T0 ${m.params.larva.T0.toFixed(2)}、K ${m.params.larva.K.toFixed(1)} | T0 ${m.params.pupa.T0.toFixed(2)}、K ${m.params.pupa.K.toFixed(1)} |`),
    ...tm.filter((m) => m.id === 'q10_refit_fcy').map((m) => `| ${m.label} | D25 ${m.params.egg.D25.toFixed(2)}、Q10 ${m.params.egg.Q10.toFixed(2)} | D25 ${m.params.larva.D25.toFixed(2)}、Q10 ${m.params.larva.Q10.toFixed(2)} | D25 ${m.params.pupa.D25.toFixed(2)}、Q10 ${m.params.pupa.Q10.toFixed(2)} |`),
    ...tm.filter((m) => m.id.startsWith('briere')).map((m) => `| ${m.label} | Tmin ${m.params.egg.Tmin.toFixed(2)} | Tmin ${m.params.larva.Tmin.toFixed(2)} | Tmin ${m.params.pupa.Tmin.toFixed(2)} |`)].join('\n');
  const agg = s.cohort_aggregate as any[], find = (m: string, sp: string, T: number) => agg.find((a) => a.temp_model === m && a.spread === sp && a.T === T);
  t.temp_models = [`| 模型 | ${TEMPS.map((T) => `${T}°C`).join(' | ')} |`, `|---|${TEMPS.map(() => '---').join('|')}|`,
    ...tm.map((m) => `| ${m.label} | ${TEMPS.map((T) => { const a = find(m.id, 'none', T); return a.intrinsic_mean === null ? `> ${HORIZON}` : f2(a.intrinsic_mean); }).join(' | ')} |`)].join('\n');
  const spreadT = [20, 24, 28, 32];
  t.spread = ['| 溫度模型 | 個體差異模型 | ' + spreadT.map((T) => `${T}°C 平均｜SD（種子間範圍）｜全距`).join(' | ') + ' |', '|---|---|' + spreadT.map(() => '---').join('|') + '|',
    ...['engine_q10_legacy', 'dd_fcy'].flatMap((m) => (s.spread_models as { id: string }[]).map((sm) => `| ${m} | ${sm.id} | ` + spreadT.map((T) => { const a = find(m, sm.id, T); return a.mean_of_means === null ? `未羽化（> ${HORIZON} 日）` : `${f2(a.mean_of_means)}｜${f2(a.mean_sd)}（${f2(a.sd_min)}～${f2(a.sd_max)}）｜${a.pooled_min}～${a.pooled_max}`; }).join(' | ') + ' |')),
    `| Yuan 2026（R94）觀測 | — | — | — | 28.73｜2.83（n＝52）｜24～34 | — |`].join('\n');
  const e = s.erlang_equivalence_dd_fcy_28C;
  t.erlang = ['| 實作（dd_fcy，28°C，內在羽化時間，20 種子平均） | 平均 | SD |', '|---|---|---|', `| M1 階段門檻 Gamma，CV 0.10 | ${f2(e.theta_hi_mean_of_means)} | ${f2(e.theta_hi_mean_sd)} |`, `| M2 Erlang 分布延遲，k＝${e.erlang_k} | ${f2(e.erlang_mean_of_means)} | ${f2(e.erlang_mean_sd)} |`].join('\n');
  const L = s.lifespan, cd = YUAN_S3.census_days;
  t.lifespan = ['| 來源 | 平均（日） | 中位（日） | ' + cd.slice(1).map((d) => `S(${d})`).join(' | ') + ' |', '|---|---|---|' + cd.slice(1).map(() => '---').join('|') + '|',
    `| 現行引擎（公式精確計算，無傷無飢餓，與溫度無關） | ${f2(L.engine_exact.mean_days)} | ${L.engine_exact.median_days} | ${cd.slice(1).map((d) => f2(L.engine_exact.survival_at_census[d])).join(' | ')} |`,
    `| 現行引擎（官方 workerSurvival，20 種子×300 隻） | ${f2(L.engine_official_empirical.mean_days)} | — | ${cd.slice(1).map(() => '—').join(' | ')} |`,
    `| Yuan S3 小工蟻（n＝104，28°C） | ${f2(L.yuan_s3.minor.recomputed_mean)}（論文 26.25） | 28（KM，論文） | ${cd.slice(1).map((d) => f2(L.yuan_s3.minor.survival_at_census[d])).join(' | ')} |`,
    `| Yuan S3 兵蟻（n＝14，28°C） | ${f2(L.yuan_s3.soldier.recomputed_mean)}（論文 56） | 70（KM，論文） | ${cd.slice(1).map((d) => f2(L.yuan_s3.soldier.survival_at_census[d])).join(' | ')} |`,
    `| Gompertz 小工蟻 A=${L.gompertz.minor.A}、B=${L.gompertz.minor.B} | ${f2(L.gompertz.minor.mean)} | ${f2(L.gompertz.minor.median)} | ${cd.slice(1).map((d) => f2(L.gompertz.minor.survival_at_census[d])).join(' | ')} |`,
    `| Gompertz 兵蟻 A=${L.gompertz.soldier.A}、B=${L.gompertz.soldier.B} | ${f2(L.gompertz.soldier.mean)} | ${f2(L.gompertz.soldier.median)} | ${cd.slice(1).map((d) => f2(L.gompertz.soldier.survival_at_census[d])).join(' | ')} |`,
    '', `引擎平均／Yuan 小工蟻平均＝${f2(L.ratio_engine_to_yuan_minor_mean)}；引擎平均／Yuan 全部非繁殖成蟲平均 29.78＝${f2(L.ratio_engine_to_yuan_all_mean)}。`].join('\n');
  t.lifespan_T = ['| 巢溫 °C | 現行引擎 | Gompertz 小工蟻，Q10_life＝1 | Gompertz 小工蟻，Q10_life＝1.93（非本種） | Gompertz 兵蟻，Q10_life＝1 | Gompertz 兵蟻，Q10_life＝1.93（非本種） |', '|---|---|---|---|---|---|',
    ...L.by_temperature_mean_days.map((r: any) => `| ${r.T} | ${f2(r.engine_mean)} | ${f2(r.gompertz_minor_q10_1)} | ${f2(r['gompertz_minor_q10_1.93'])} | ${f2(r.gompertz_soldier_q10_1)} | ${f2(r['gompertz_soldier_q10_1.93'])} |`)].join('\n');
  const O = s.oviposition, ovT = [20, 24, 28, 32];
  t.oviposition = ['| 巢內幼體數 | ' + ovT.map((T) => `${T}°C 卵／日`).join(' | ') + ' |', '|---|' + ovT.map(() => '---').join('|') + '|',
    ...[0, 30, 60, 91].map((b) => `| ${b} | ${ovT.map((T) => O.rows.find((r: any) => r.T === T && r.brood === b).eggs_per_day.toFixed(3)).join(' | ')} |`),
    `| Chang 1985（R136，單后，26～27°C） | 31 日 97～292 粒＝${O.chang1985_eggs_per_queen_day.low.toFixed(2)}～${O.chang1985_eggs_per_queen_day.high.toFixed(2)} 粒／日（作者：平均 6） | | | |`].join('\n');
  return t;
}

if (import.meta.main) {
  const { summary, perSeed, tables: tb } = runAnalysis();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 1) + '\n');
  for (const p of perSeed) fs.writeFileSync(path.join(OUT_DIR, `seed-${String(p.seed).padStart(2, '0')}.json`), JSON.stringify(p) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'tables.md'), Object.entries(tb).map(([k, v]) => `<!-- p0b:${k} -->\n${v}\n<!-- /p0b:${k} -->`).join('\n\n') + '\n');
  console.log(tb.engine_development + '\n\n' + tb.temp_models + '\n\n' + tb.spread + '\n\n' + tb.erlang + '\n\n' + tb.lifespan + '\n\n' + tb.oviposition);
}
