/**
 * Synthetic daily weather from the Taichung 1991–2020 monthly climatology (world-level, one per day).
 * Never reads any colony. Formulas and operand order are identical to v6 calcWeather().
 */
import { clamp, monthDays, round } from './math.ts';
import { dice, gamma, normal } from './rng.ts';
import type { WorldParams } from './params.ts';
import type { ClimateState, MonthlyClimate, Weather } from './types.ts';

/** Any non-leap year: only month lengths are used when converting monthly rain to rain-day priors. */
const NON_LEAP_REFERENCE_YEAR = 2025;
/** Bisection settings for solving the rain-day scale; numerical method, not a model parameter. */
const RAIN_PRIOR_BISECTION = { lo: 0, hi: 100, iterations: 70 };

type Row = MonthlyClimate & { prior?: number };

/** Linear interpolation between mid-month climatology values. */
export function monthInterp(rows: Row[], y: number, m: number, day: number, key: keyof Row): number {
  let a: number, b: number, n: number;
  if (day >= 15) { a = rows[m - 1][key] as number; b = rows[m % 12][key] as number; n = (day - 15) / monthDays(y, m); }
  else {
    const prev = m === 1 ? 12 : m - 1;
    a = rows[prev - 1][key] as number; b = rows[m - 1][key] as number;
    n = (monthDays(m === 1 ? y - 1 : y, prev) - 15 + day) / monthDays(m === 1 ? y - 1 : y, prev);
  }
  return a + (b - a) * n;
}

/** Monthly rain-day probabilities scaled so the expected annual count equals climate.annual_rain_days. */
export function rainPriors(climate: ClimateState, wp: WorldParams): number[] {
  const c = wp.climate, rows = climate.monthly;
  const weights = rows.map((x, i) => Math.pow(x.mean_monthly_precipitation_mm / monthDays(NON_LEAP_REFERENCE_YEAR, i + 1), c.rain_prior_month_weight_exponent));
  let lo = RAIN_PRIOR_BISECTION.lo, hi = RAIN_PRIOR_BISECTION.hi;
  for (let i = 0; i < RAIN_PRIOR_BISECTION.iterations; i++) {
    const mid = (lo + hi) / 2;
    const n = weights.reduce((sum, w, i) => sum + monthDays(NON_LEAP_REFERENCE_YEAR, i + 1) * Math.min(c.rain_probability_daily_cap, mid * w), 0);
    if (n < c.annual_rain_days) lo = mid; else hi = mid;
  }
  return weights.map((w) => Math.min(c.rain_probability_daily_cap, (lo + hi) / 2 * w));
}

export function calcWeather(world: { seed: number; sim_day: number; climate: ClimateState }, wp: WorldParams, date: string): Weather {
  const c = wp.climate, s = world.climate;
  const [y, m, day] = date.split('-').map(Number), rows = s.monthly;
  const prior = rainPriors(s, wp), rainProb = monthInterp(rows.map((x, i) => ({ ...x, prior: prior[i] })), y, m, day, 'prior');
  const cw = c.wet_persistence;
  const pWet = s.prior_wet ? rainProb + cw * (1 - rainProb) : rainProb * (1 - cw);
  const g = dice(world, 'weather');
  const wet = g() < pWet;
  const tempMean = monthInterp(rows, y, m, day, 'mean_air_temperature_c');
  const anomaly = round(c.temperature_ar * s.temp_anomaly_c + c.temperature_daily_sigma_c * normal(g));
  const wetOffset = c.wet_day_temperature_offset_c;
  const airTemp = round(tempMean + anomaly - wetOffset * (Number(wet) - rainProb));
  const highNormal = monthInterp(rows, y, m, day, 'mean_daily_maximum_air_temperature_c'), lowNormal = monthInterp(rows, y, m, day, 'mean_daily_minimum_air_temperature_c');
  const maxAirTemp = round(Math.max(airTemp, highNormal + anomaly - wetOffset * (Number(wet) - rainProb)));
  const minAirTemp = round(Math.min(airTemp, lowNormal + anomaly - wetOffset * (Number(wet) - rainProb)));
  const rh = round(clamp(monthInterp(rows, y, m, day, 'mean_relative_humidity_percent') + (wet ? c.rh_wet_offset_percent : c.rh_dry_offset_percent) + c.rh_anomaly_coefficient * anomaly, 0, 100));
  const rainMean = monthInterp(rows, y, m, day, 'mean_monthly_precipitation_mm') / monthDays(y, m) / Math.max(0.001, rainProb);
  const rain = wet ? round(gamma(c.rainfall_gamma_shape, rainMean / c.rainfall_gamma_shape, g)) : 0;
  const soil = round(clamp(s.soil_index * c.soil_persistence + rain * c.soil_rain_gain_per_mm - c.soil_daily_loss, 0, 1));
  const shade = round(clamp(s.shade_index * c.soil_shade_persistence + rain * c.soil_shade_rain_gain_per_mm - c.soil_shade_daily_loss, 0, 1));
  // v6 behaviour preserved: reads prior_nest_temp_c, but the state only ever stores prior_nest_temp_model_c,
  // so nest temperature memory always starts from yesterday's AIR temperature. Reported in the PR, not fixed.
  const memory = wp.nest_microclimate.nest_temp_memory;
  const nestTemp = round((s.prior_nest_temp_c ?? s.prior_air_temp_c) * memory + airTemp * (1 - memory));
  return {
    day: world.sim_day + 1, date, kind: 'synthetic_climatology_game_assumption_not_real_weather', wet,
    air_temp_c: airTemp, daytime_air_temp_c: maxAirTemp, daily_max_air_temp_c: maxAirTemp, daily_min_air_temp_c: minAirTemp,
    daytime_proxy_basis: 'synthetic_daily_air_maximum_NOT_measured_ground_surface', nest_temp_model_c: nestTemp,
    relative_humidity_model_percent: rh, rain_mm: rain, soil_index: soil, shade_index: shade, temperature_anomaly_c: anomaly,
    rain_probability_model: round(pWet),
  };
}

/** Climate memory carried to tomorrow (v6 key order: spread old, then these keys). */
export function nextClimate(s: ClimateState, weather: Weather): ClimateState {
  return { ...s, prior_wet: weather.wet, prior_air_temp_c: weather.air_temp_c, prior_nest_temp_model_c: weather.nest_temp_model_c, temp_anomaly_c: weather.temperature_anomaly_c, soil_index: weather.soil_index, shade_index: weather.shade_index };
}
