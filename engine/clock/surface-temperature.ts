/**
 * SURF-0 — simple ground / contact-substrate surface-temperature CANDIDATE model (Owner ruling #213 Q2 b, 2026-11-13;
 * docs/surface-temperature-model.md).
 *
 * WHAT IT IS: a model value, never a measurement. It estimates the temperature of a thin surface layer of a substrate
 * patch from (1) air temperature (any function of world day + minute, e.g. WeatherSeries.temperature of the P0-A1
 * clock), (2) the solar altitude of ./solar.ts, (3) a shade fraction and (4) a few substrate / sky coefficients that the
 * CALLER passes with their provenance (candidate values: prototypes/surface-temp/params.json). The air temperature is
 * kept in every output record as the comparison proxy (the CHEM-2 bench uses air temperature as its surrogate).
 *
 * MODEL (all coefficients are inputs; none is written here):
 *   G      = k_sky · max(0, 910·sin α − 30)                  clear-sky global horizontal irradiance, W m⁻² (Kasten &
 *                                                            Czeplak 1980 form, R931 via R932 eq. 17), scaled by a sky
 *                                                            clearness scenario factor k_sky ∈ [0, 1]
 *   S_abs  = (1 − albedo) · G · (1 − shade · (1 − diffuse))  shade removes the direct part only
 *   h_r    = 4 ε σ (T_air + 273.15)³                         linearised long-wave exchange with surroundings at air
 *                                                            temperature (so: NO night sky cooling unless an explicit
 *                                                            offset is given; null = not modelled)
 *   T_tgt  = T_air + (1 − g) · S_abs / (h_c + h_r) − night_offset·[α ≤ 0]
 *   T_s    : first-order relaxation toward T_tgt with time constant τ, implicit Euler on a fixed step Δ:
 *            T_s(t+Δ) = (T_s(t) + (Δ/τ)·T_tgt(t+Δ)) / (1 + Δ/τ)  (a convex combination: unconditionally stable, bounded)
 * NOT modelled: wind (h_c is a constant), clouds (only k_sky), rain wetting / evaporation / dew, soil moisture, sub-surface
 * conduction profile (only the fraction g), slope / aspect, neighbouring-object shading geometry (only `shade`).
 *
 * DETERMINISM: only IEEE basic operations, Math.max / Math.min / Math.abs and ./solar.ts (which uses ./detmath.ts) — no
 * Math.exp / log / pow / sin / cos, so this module is bit-identical across conforming engines FOR THE SAME AIR-TEMPERATURE
 * INPUT. WeatherSeries.temperature itself still uses Math.sin / Math.exp (not cross-environment verified); a caller in the
 * Worker graph must account for that.
 *
 * ISOLATION (CLAUDE.md §2.2): reads no colony, individual or behaviour state; nothing official imports it; opt-in only
 * (tests/clock-isolation.test.ts, tests/surface-temp.test.ts). Pure functions, no randomness, no wall clock.
 */
import { type SolarSite, solarAltitude } from './solar.ts';
import { type CalendarAnchor, clockFail, dateOfDay } from './time-frames.ts';
import { detSin } from './detmath.ts';

export const SURFACE_TEMP_MODEL_VERSION = 'surf-0.v1';
const RAD = Math.PI / 180;

/** one coefficient with its provenance (CLAUDE.md §3); `value` null = unknown / not modelled */
export interface Coef { value: number | null; assumption: boolean; basis: string; sources: string[]; note: string }
export interface SurfaceParams {
  /** Kasten–Czeplak clear-sky GHI form: G = a·sin α − b (W m⁻²) */
  ghi_a_wm2: Coef; ghi_b_wm2: Coef;
  sky_clearness: Coef; albedo: Coef; diffuse_fraction: Coef; ground_flux_fraction: Coef;
  h_conv_wm2k: Coef; emissivity: Coef; stefan_boltzmann: Coef; tau_min: Coef;
  /** K subtracted from the target at night (sun at or below the horizon); null = not modelled (target = air) */
  night_offset_k: Coef;
}
export interface SurfaceScenario {
  anchor: CalendarAnchor; site: SolarSite;
  /** fraction of the direct beam blocked over the patch, 0 = open sun, 1 = full shade (a scenario value, not measured) */
  shade: number;
  /** integration step, minutes (must divide 1440) */
  step_min: number;
  first_day: number; last_day: number;
}
export type AirTemp = (day: number, minute: number) => number | null;
export interface SurfaceRecord {
  day: number; minute: number;
  /** comparison proxy: the air temperature given as input (°C) */
  air_temp_proxy_c: number | null;
  /** model value (°C); null when the air temperature is unknown */
  surface_temp_model_c: number | null;
  /** steady-state target of this instant (°C) */
  target_c: number | null;
  solar_altitude_deg: number; ghi_model_wm2: number;
  kind: 'model'; measured: false; label: '模型值（非實測）'; reinitialised: boolean;
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const val = (c: Coef, name: string) => { if (!c || !fin(c.value)) clockFail(`surface model: ${name} needs a finite value`); return c.value as number; };
export function checkParams(p: SurfaceParams): void {
  const in01 = (x: number, n: string) => { if (!(x >= 0 && x <= 1)) clockFail(`surface model: ${n} must be in [0, 1]`); };
  for (const k of Object.keys(p) as (keyof SurfaceParams)[]) {
    const c = p[k];
    if (!c || typeof c.basis !== 'string' || !c.basis || !Array.isArray(c.sources) || typeof c.note !== 'string') clockFail(`surface model: ${k} lacks provenance`);
    if (k !== 'night_offset_k' && !fin(c.value)) clockFail(`surface model: ${k} needs a finite value`);
  }
  in01(val(p.sky_clearness, 'sky_clearness'), 'sky_clearness'); in01(val(p.albedo, 'albedo'), 'albedo');
  in01(val(p.diffuse_fraction, 'diffuse_fraction'), 'diffuse_fraction'); in01(val(p.ground_flux_fraction, 'ground_flux_fraction'), 'ground_flux_fraction');
  in01(val(p.emissivity, 'emissivity'), 'emissivity');
  for (const k of ['ghi_a_wm2', 'h_conv_wm2k', 'stefan_boltzmann', 'tau_min'] as const) if (!(val(p[k], k) > 0)) clockFail(`surface model: ${k} must be > 0`);
  if (!(val(p.ghi_b_wm2, 'ghi_b_wm2') >= 0)) clockFail('surface model: ghi_b_wm2 must be >= 0');
  if (p.night_offset_k.value !== null && !(fin(p.night_offset_k.value) && p.night_offset_k.value >= 0)) clockFail('surface model: night_offset_k must be null or >= 0');
}

/** clear-sky GHI form scaled by sky clearness (W m⁻²), 0 when the form is negative */
export function ghiModel(p: SurfaceParams, altitude_deg: number): number {
  if (!(altitude_deg > 0)) return 0;
  const g = val(p.ghi_a_wm2, 'ghi_a_wm2') * detSin(altitude_deg * RAD) - val(p.ghi_b_wm2, 'ghi_b_wm2');
  return g > 0 ? val(p.sky_clearness, 'sky_clearness') * g : 0;
}
/** steady-state surface target (°C) for an air temperature, solar altitude and shade fraction */
export function targetC(p: SurfaceParams, air_c: number, altitude_deg: number, shade: number): { target_c: number; ghi: number } {
  const ghi = ghiModel(p, altitude_deg);
  const sAbs = (1 - val(p.albedo, 'albedo')) * ghi * (1 - shade * (1 - val(p.diffuse_fraction, 'diffuse_fraction')));
  const tk = air_c + 273.15, hr = 4 * val(p.emissivity, 'emissivity') * val(p.stefan_boltzmann, 'stefan_boltzmann') * tk * tk * tk;
  const night = !(altitude_deg > 0) && p.night_offset_k.value !== null ? p.night_offset_k.value : 0;
  return { target_c: air_c + ((1 - val(p.ground_flux_fraction, 'ground_flux_fraction')) * sAbs) / (val(p.h_conv_wm2k, 'h_conv_wm2k') + hr) - night, ghi };
}

/** run the candidate over [first_day 00:00, last_day 24:00) on a fixed step. The state starts at the first known air
 *  temperature (a spin-up assumption: start at night); an unknown air temperature makes the record null and the next
 *  known one re-initialises the state (flagged), so nothing is invented across a gap. */
export function runSurface(p: SurfaceParams, sc: SurfaceScenario, air: AirTemp): SurfaceRecord[] {
  checkParams(p);
  if (!(sc.shade >= 0 && sc.shade <= 1)) clockFail('surface model: shade must be in [0, 1]');
  if (!(Number.isInteger(sc.step_min) && sc.step_min >= 1 && 1440 % sc.step_min === 0)) clockFail('surface model: step_min must divide 1440');
  if (!(Number.isSafeInteger(sc.first_day) && Number.isSafeInteger(sc.last_day) && sc.first_day <= sc.last_day)) clockFail('surface model: need first_day <= last_day');
  const r = sc.step_min / val(p.tau_min, 'tau_min'), out: SurfaceRecord[] = [];
  let ts: number | null = null;
  for (let day = sc.first_day; day <= sc.last_day; day++) {
    const date = dateOfDay(sc.anchor, day);
    for (let m = 0; m < 1440; m += sc.step_min) {
      const a = air(day, m), alt = solarAltitude(sc.site, sc.anchor, date, m);
      if (a === null || !fin(a)) { ts = null; out.push({ day, minute: m, air_temp_proxy_c: null, surface_temp_model_c: null, target_c: null, solar_altitude_deg: alt, ghi_model_wm2: ghiModel(p, alt), kind: 'model', measured: false, label: '模型值（非實測）', reinitialised: false }); continue; }
      const { target_c, ghi } = targetC(p, a, alt, sc.shade);
      const prev: number | null = ts, re = prev === null;
      ts = prev === null ? a : (prev + r * target_c) / (1 + r);
      out.push({ day, minute: m, air_temp_proxy_c: a, surface_temp_model_c: ts, target_c, solar_altitude_deg: alt, ghi_model_wm2: ghi, kind: 'model', measured: false, label: '模型值（非實測）', reinitialised: re });
    }
  }
  return out;
}
