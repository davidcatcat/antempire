/**
 * P0-A2 phase 2 — the ENVIRONMENT of the experiment world as pure functions of world time. It reads only the scenario
 * (calendar anchor, site, synthetic hourly temperature profile) and never any colony state (CLAUDE.md §2.2).
 *  - light: NOAA solar times (engine/clock/solar.ts, R390; general method)
 *  - air temperature: the scenario's 24 hourly values (synthetic: true, assumption: true) are instants at hour starts;
 *    linear in between (the same reading as engine/clock/weather-input.ts uses for hourly observations); every day
 *    repeats the profile. A synthetic hourly series is NOT fed to WeatherSeries, which accepts hourly data only as
 *    observations (that check is kept: synthetic must not pose as observed).
 *  - relative humidity: vapour pressure held at the daily-mean value, e_s from FAO-56 (R391; game assumption on the
 *    constant e_a). Computed and logged for observation only; no decision reads it (M8 desiccation 尚未模擬).
 *  - rain: unknown (null) in every scenario; no rain event is produced and no rain effect applied.
 */
import { type LightState, type LightTimes, lightStateAt, lightTimes } from '../../engine/clock/solar.ts';
import { dateOfDay } from '../../engine/clock/time-frames.ts';
import { saturationVapourKPa } from '../../engine/clock/weather-input.ts';
import type { Model } from './params.ts';

export const MS_PER_DAY = 86_400_000, MS_PER_HOUR = 3_600_000;
export const dayOf = (t: number) => Math.floor(t / MS_PER_DAY);
export const hourOfDay = (t: number) => Math.floor((t - dayOf(t) * MS_PER_DAY) / MS_PER_HOUR);

export class Environment {
  readonly m: Model;
  #light = new Map<number, LightTimes>();
  readonly #ea: number | null;
  constructor(m: Model) {
    this.m = m;
    const mean = m.hourly_temp_c.reduce((a, b) => a + b, 0) / 24;
    this.#ea = m.rh_mean_percent === null ? null : (m.rh_mean_percent / 100) * saturationVapourKPa(mean);
  }
  lightTimes(day: number): LightTimes {
    let L = this.#light.get(day);
    if (!L) { L = lightTimes(this.m.site, this.m.anchor, dateOfDay(this.m.anchor, day)); this.#light.set(day, L); }
    return L;
  }
  light(t: number): LightState { const d = dayOf(t); return lightStateAt(this.lightTimes(d), (t - d * MS_PER_DAY) / 60_000); }
  /** air temperature (°C) at instant t; never null for a complete scenario profile (a profile with gaps is refused) */
  airTemp(t: number): number | null {
    const p = this.m.hourly_temp_c, x = (t - dayOf(t) * MS_PER_DAY) / MS_PER_HOUR, h = Math.floor(x), f = x - h;
    const a = p[h], b = p[(h + 1) % 24];
    if (typeof a !== 'number' || typeof b !== 'number') return null;
    return f === 0 ? a : a + (b - a) * f;
  }
  /** temperature at a worker's site outside the nest (or at the entrance) */
  siteTemp(t: number): number | null { const T = this.airTemp(t); return T === null ? null : T + this.m.surface_offset_c; }
  rh(t: number): number | null {
    const T = this.airTemp(t); if (T === null || this.#ea === null) return null;
    return Math.min(100, (100 * this.#ea) / saturationVapourKPa(T));
  }
}
