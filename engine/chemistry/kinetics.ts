/**
 * CHEM-2 (#133) — environment-coupled decay kinetics of a field channel (docs/chemical-ecology-engine.md §15).
 *
 * Status: ISOLATED and OPT-IN. Nothing official imports engine/chemistry (tests/chemistry-isolation.test.ts). A store
 * channel without `kinetics`, or with every environment term disabled, keeps the CHEM-1 formula bit for bit.
 *
 * Model. The loss hazard of a cell in zone z is
 *     h_z(τ) = λ_ref · f_T(T_z(τ)) + w_rain · 1[raining_z(τ)]
 * and a cell decays analytically as C(t) = C(t_ref) · exp(−∫_{t_ref}^{t} h_z(τ) dτ). The integral is EXACT for the
 * environment trace as given (temperature piecewise linear between knots, rain piecewise constant), so the result
 * depends only on (t_ref, t): how advance() is partitioned can never change a value (bitwise; cells still move their
 * reference time only when a deposit enters them, exactly as in CHEM-1).
 *  - λ_ref: the channel's time_rule.lambda_per_s, read as the rate AT the reference temperature t_ref_c.
 *  - f_T(T) = Q10^((T − t_ref_c)/10) — general-physiology form (一般生理學); NO value for the focal species exists, so
 *    q10 is null by default and the term is OFF (f_T ≡ 1). Mechanism direction (warmer substrate -> faster trail loss)
 *    is other-species evidence only (R35, R36, van Oudenhove 2011/2012: Tapinoma nigerrimum, Aphaenogaster senilis —
 *    非本種); their curves are NOT copied.
 *  - rain wash-off w_rain (1/s while raining): no evidence for any number; null by default (OFF).
 *  - humidity and substrate: no functional form with evidence exists; the slots must stay null (refused otherwise).
 *  - diffusion / spreading: the CHEM-0 contract fixes `isotropic_diffusion: false` and #130 forbids assuming isotropic
 *    surface diffusion; the slot must stay null (DIFFUSION_NOT_IN_CHEM0_CONTRACT) until an Owner decision changes the
 *    contract.
 * The environment arrives as DATA (EnvTrace), built outside chemistry from the world clock's environment events
 * (prototypes/chem2/env-trace.ts); chemistry imports no clock module and reads no colony state.
 */
import { validateProvenance, type ParamProvenance } from './contract.ts';

export const CHEM_KINETICS_VERSION = 'antempire.chem-kinetics.v1';

/** what a temperature trace measures. The P0-A1 clock gives AIR temperature at the site; using it for a trail on the
 *  ground is a surrogate (遊戲假設 D): R35/R36 concern SUBSTRATE temperature. */
export type EnvQuantity = 'air_temp_c_surrogate' | 'substrate_temp_c';
export interface EnvTraceProvenance {
  /** as the weather input says (observation / forecast / synthetic_climatology), or a test fixture */
  kind: 'observation' | 'forecast' | 'synthetic_climatology' | 'synthetic_test';
  synthetic: boolean; assumption: boolean;
  /** e.g. 'P0-A1 weather_sample events' */
  source: string;
  /** how the trace was made from the source (sampling step, interpolation) */
  method: string;
}
/** temperature, piecewise linear between knots (strictly increasing t_s); a null value = unknown (never guessed) */
export interface TempTrace { quantity: EnvQuantity; knots: { t_s: number; value: number | null }[]; provenance: EnvTraceProvenance }
/** rain intervals [t0_s, t1_s) on the chemistry clock; timing_known false = a wet period with unknown timing */
export interface RainTrace { timing_known: boolean; intervals: { event_id: string; t0_s: number; t1_s: number }[]; provenance: EnvTraceProvenance }
export type ZoneSelector =
  | { kind: 'all' }
  | { kind: 'edges'; edge_ids: string[] }
  | { kind: 'rect'; x0_mm: number; y0_mm: number; x1_mm: number; y1_mm: number };
export interface EnvZone { zone_id: string; selector: ZoneSelector; temperature: TempTrace | null; rain: RainTrace | null }
/** the environment of a store, on the store's chemistry clock, covering [t0_s, t1_s]; every cell lies in exactly one zone */
export interface EnvTrace { clock: string; t0_s: number; t1_s: number; zones: EnvZone[] }

export interface TemperatureTerm {
  form: 'q10';
  /** null -> term OFF */
  q10: ParamProvenance;
  /** temperature at which the channel's λ applies (°C) */
  t_ref_c: ParamProvenance;
  /** what the channel reads; must equal the trace's quantity */
  input: EnvQuantity;
}
export interface KineticsSpec {
  version: typeof CHEM_KINETICS_VERSION;
  temperature: TemperatureTerm | null;
  /** 1/s while raining; null -> OFF */
  rain_washoff_per_s: ParamProvenance;
  /** no evidence-backed form: value must be null */
  humidity: ParamProvenance;
  /** no evidence-backed form: value must be null */
  substrate: ParamProvenance;
  /** CHEM-0 contract: value must be null */
  diffusion_mm2_per_s: ParamProvenance;
}

/** the disabled-everything spec: every slot null with provenance (a channel with it behaves exactly like CHEM-1) */
export function kineticsOff(note = 'term OFF: no evidence for a value'): KineticsSpec {
  const nul = (n: string): ParamProvenance => ({ value: null, assumption: true, basis: '遊戲假設', evidence_level: 'D', sources: [], note: `${n}: ${note}` });
  return { version: CHEM_KINETICS_VERSION, temperature: null, rain_washoff_per_s: nul('rain wash-off'), humidity: nul('humidity'), substrate: nul('substrate'), diffusion_mm2_per_s: nul('diffusion') };
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const temperatureOn = (k: KineticsSpec): boolean => !!k.temperature && k.temperature.q10.value !== null;
export const rainOn = (k: KineticsSpec): boolean => k.rain_washoff_per_s.value !== null;
/** an environment term is ON (otherwise the channel keeps the CHEM-1 formula, bitwise) */
export const kineticsActive = (k: KineticsSpec | undefined): boolean => !!k && (temperatureOn(k) || rainOn(k));

/** structural check of a channel's kinetics (pure; [] = valid) */
export function validateKinetics(k: KineticsSpec, trueAmount: boolean): string[] {
  const e: string[] = [];
  if (!k || k.version !== CHEM_KINETICS_VERSION) return ['BAD:kinetics_version'];
  for (const [n, p] of [['rain_washoff_per_s', k.rain_washoff_per_s], ['humidity', k.humidity], ['substrate', k.substrate], ['diffusion_mm2_per_s', k.diffusion_mm2_per_s]] as const) e.push(...validateProvenance(p, n));
  if (k.humidity?.value !== null) e.push('NO_FUNCTIONAL_FORM:humidity');
  if (k.substrate?.value !== null) e.push('NO_FUNCTIONAL_FORM:substrate');
  if (k.diffusion_mm2_per_s?.value !== null) e.push('DIFFUSION_NOT_IN_CHEM0_CONTRACT');
  const w = k.rain_washoff_per_s?.value;
  if (w !== null && w !== undefined && !(finite(w) && w >= 0)) e.push('BAD:rain_washoff_per_s');
  if (k.temperature) {
    const t = k.temperature;
    if (t.form !== 'q10') e.push('BAD:temperature_form');
    if (t.input !== 'air_temp_c_surrogate' && t.input !== 'substrate_temp_c') e.push('BAD:temperature_input');
    e.push(...validateProvenance(t.q10, 'q10'), ...validateProvenance(t.t_ref_c, 't_ref_c'));
    if (t.q10.value !== null && !(finite(t.q10.value) && t.q10.value > 0)) e.push('BAD:q10');
    if (t.q10.value !== null && !finite(t.t_ref_c.value)) e.push('MISSING:t_ref_c');
  }
  // with a true amount every sink needs its own account; this module lumps them into one hazard
  if (trueAmount && kineticsActive(k)) e.push('SINKS_NOT_SEPARATED_FOR_TRUE_AMOUNT');
  return e;
}

/** structural check of an environment trace (pure; [] = valid) */
export function validateEnvTrace(env: EnvTrace, clockName: string): string[] {
  const e: string[] = [];
  if (!env) return ['MISSING:environment'];
  if (env.clock !== clockName) e.push('ENV_WRONG_CLOCK');
  if (!(finite(env.t0_s) && finite(env.t1_s) && env.t0_s <= env.t1_s)) e.push('BAD:env_coverage');
  if (!Array.isArray(env.zones) || !env.zones.length) e.push('MISSING:env_zones');
  const ids = new Set<string>();
  for (const z of env.zones ?? []) {
    if (!z.zone_id || ids.has(z.zone_id)) e.push(`BAD_ZONE_ID:${z.zone_id}`); ids.add(z.zone_id);
    const s = z.selector;
    if (!s || !['all', 'edges', 'rect'].includes(s.kind)) e.push(`BAD_SELECTOR:${z.zone_id}`);
    else if (s.kind === 'rect' && !([s.x0_mm, s.y0_mm, s.x1_mm, s.y1_mm].every(finite) && s.x1_mm > s.x0_mm && s.y1_mm > s.y0_mm)) e.push(`BAD_RECT:${z.zone_id}`);
    else if (s.kind === 'edges' && !(Array.isArray(s.edge_ids) && s.edge_ids.length)) e.push(`BAD_EDGES:${z.zone_id}`);
    const T = z.temperature;
    if (T) {
      if (!T.provenance || !T.provenance.source || !T.provenance.method) e.push(`MISSING_PROVENANCE:temperature:${z.zone_id}`);
      if (T.provenance && T.provenance.kind !== 'observation' && !(T.provenance.synthetic || T.provenance.assumption)) e.push(`UNLABELLED_NON_OBSERVATION:${z.zone_id}`);
      const k = T.knots;
      if (!Array.isArray(k) || k.length < 2) e.push(`BAD_KNOTS:${z.zone_id}`);
      else {
        for (let i = 0; i < k.length; i++) {
          if (!finite(k[i].t_s) || (i > 0 && !(k[i].t_s > k[i - 1].t_s))) { e.push(`KNOTS_NOT_INCREASING:${z.zone_id}`); break; }
          if (!(k[i].value === null || finite(k[i].value))) { e.push(`BAD_KNOT_VALUE:${z.zone_id}`); break; }
        }
        if (!(k[0].t_s <= env.t0_s && k[k.length - 1].t_s >= env.t1_s)) e.push(`TEMPERATURE_DOES_NOT_COVER:${z.zone_id}`);
      }
    }
    const R = z.rain;
    if (R) {
      if (!R.provenance || !R.provenance.source) e.push(`MISSING_PROVENANCE:rain:${z.zone_id}`);
      let last = -Infinity;
      for (const iv of [...(R.intervals ?? [])].sort((a, b) => a.t0_s - b.t0_s)) {
        if (!(finite(iv.t0_s) && finite(iv.t1_s) && iv.t1_s > iv.t0_s)) { e.push(`BAD_RAIN_INTERVAL:${z.zone_id}`); break; }
        if (iv.t0_s < last) { e.push(`RAIN_OVERLAP:${z.zone_id}`); break; }
        last = iv.t1_s;
      }
    }
  }
  return e;
}

interface ZoneRt {
  id: string; sel: ZoneSelector;
  /** knot times, f_T at knots (u = ln f_T), prefix Θ(knot_i) = ∫_{knot_0}^{knot_i} f_T dτ */
  kt: number[]; ku: number[]; kv: (number | null)[]; prefix: number[];
  /** rain: interval starts / ends (sorted) and prefix of raining time at each interval end */
  r0: number[]; r1: number[]; rprefix: number[]; rainKnown: boolean;
}

/** (e^{b} − e^{a})/(b − a) · Δ computed without cancellation: Δ·e^{a}·expm1(b−a)/(b−a) */
const expSegment = (dt: number, a: number, b: number): number => { const x = b - a; return x === 0 ? dt * Math.exp(a) : dt * Math.exp(a) * (Math.expm1(x) / x); };

/** Runtime of one channel's kinetics on a store's environment. Pure functions of the config after construction. */
export class KineticsRuntime {
  readonly lambdaRef: number; readonly tempOn: boolean; readonly washoff: number;
  private readonly zones: ZoneRt[];
  private readonly t0: number; private readonly t1: number;

  constructor(spec: KineticsSpec, lambdaRef: number, env: EnvTrace) {
    this.lambdaRef = lambdaRef; this.tempOn = temperatureOn(spec); this.washoff = spec.rain_washoff_per_s.value ?? 0;
    this.t0 = env.t0_s; this.t1 = env.t1_s;
    const k = this.tempOn ? Math.log(spec.temperature!.q10.value as number) / 10 : 0, tref = this.tempOn ? spec.temperature!.t_ref_c.value as number : 0;
    this.zones = env.zones.map((z) => {
      const kt: number[] = [], ku: number[] = [], kv: (number | null)[] = [], prefix: number[] = [];
      if (this.tempOn && z.temperature) {
        for (const p of z.temperature.knots) { kt.push(p.t_s); kv.push(p.value); ku.push(p.value === null ? NaN : k * (p.value - tref)); }
        prefix.push(0);
        for (let i = 1; i < kt.length; i++) prefix.push(prefix[i - 1] + expSegment(kt[i] - kt[i - 1], ku[i - 1], ku[i]));
      }
      const iv = [...(z.rain?.intervals ?? [])].sort((a, b) => a.t0_s - b.t0_s), rprefix: number[] = [];
      let acc = 0; for (const x of iv) { acc += x.t1_s - x.t0_s; rprefix.push(acc); }
      return { id: z.zone_id, sel: z.selector, kt, ku, kv, prefix, r0: iv.map((x) => x.t0_s), r1: iv.map((x) => x.t1_s), rprefix, rainKnown: z.rain ? z.rain.timing_known : false };
    });
  }

  /** zone index of an edge bin or plane cell centre; -1 = none, -2 = more than one (both refused by the store) */
  zoneOf(edge_id: string | null, x: number, y: number): number {
    let hit = -1;
    this.zones.forEach((z, i) => {
      const s = z.sel, m = s.kind === 'all' || (s.kind === 'edges' && edge_id !== null && s.edge_ids.includes(edge_id)) || (s.kind === 'rect' && edge_id === null && x >= s.x0_mm && x < s.x1_mm && y >= s.y0_mm && y < s.y1_mm);
      if (m) hit = hit === -1 ? i : -2;
    });
    return hit;
  }

  /** problems of a zone that this channel would use (missing traces for an enabled term) */
  zoneErrors(i: number): string[] {
    const z = this.zones[i], e: string[] = [];
    if (this.tempOn && !z.kt.length) e.push(`ENV_TERM_WITHOUT_TRACE:temperature:${z.id}`);
    if (this.washoff > 0 && !z.rainKnown) e.push(`ENV_RAIN_TIMING_UNKNOWN:${z.id}`);
    return e;
  }

  /** errors for evaluating the hazard up to t in zone i (coverage, unknown values) */
  coverageErrors(i: number, t: number): string[] {
    if (!(t >= this.t0 && t <= this.t1)) return ['ENV_TRACE_NOT_COVERED'];
    if (this.tempOn && !Number.isFinite(this.theta(i, t))) return [`ENV_VALUE_UNKNOWN:temperature:${this.zones[i].id}`];
    return [];
  }

  /** Θ_z(t) = ∫_{knot_0}^{t} f_T dτ (exact for the piecewise-linear trace) */
  private theta(i: number, t: number): number {
    const z = this.zones[i], kt = z.kt;
    let lo = 0, hi = kt.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (kt[m] <= t) lo = m; else hi = m; }
    if (t === kt[lo]) return z.prefix[lo];
    const a = z.kv[lo], b = z.kv[lo + 1];
    if (a === null || b === null) return NaN;
    const f = (t - kt[lo]) / (kt[lo + 1] - kt[lo]), ut = z.ku[lo] + (z.ku[lo + 1] - z.ku[lo]) * f;
    return z.prefix[lo] + expSegment(t - kt[lo], z.ku[lo], ut);
  }
  /** raining time in [r0_first, t] */
  private rained(i: number, t: number): number {
    const z = this.zones[i];
    let lo = -1, hi = z.r0.length;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (z.r0[m] <= t) lo = m; else hi = m; }
    if (lo < 0) return 0;
    return (lo > 0 ? z.rprefix[lo - 1] : 0) + Math.min(t, z.r1[lo]) - z.r0[lo];
  }

  /** ∫_{from}^{to} h dτ in zone i (to >= from; callers check coverage first) */
  hazard(i: number, from: number, to: number): number {
    const decay = this.tempOn ? this.lambdaRef * (this.theta(i, to) - this.theta(i, from)) : this.lambdaRef * (to - from);
    return this.washoff > 0 ? decay + this.washoff * (this.rained(i, to) - this.rained(i, from)) : decay;
  }

  /** instantaneous hazard at t (diagnostic: reports and tests only) */
  rateAt(i: number, t: number): number {
    const z = this.zones[i];
    let f = 1;
    if (this.tempOn) {
      let lo = 0; while (lo + 1 < z.kt.length && z.kt[lo + 1] <= t) lo++;
      const hi = Math.min(lo + 1, z.kt.length - 1), w = hi === lo ? 0 : (t - z.kt[lo]) / (z.kt[hi] - z.kt[lo]);
      f = Math.exp(z.ku[lo] + (z.ku[hi] - z.ku[lo]) * w);
    }
    const raining = z.r0.some((a, k) => t >= a && t < z.r1[k]);
    return this.lambdaRef * f + (raining ? this.washoff : 0);
  }
}
