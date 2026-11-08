/**
 * P0-A1 — sub-daily weather INPUT for an isolated, non-official Day0 experiment world (docs/p0a1-24h-clock.md §4).
 *
 * Environment only: no function here takes, reads or returns any colony / worker / brood state (CLAUDE.md §2.2;
 * tests/clock-isolation.test.ts). Provenance follows docs/weather-data-policy.md: observation, forecast and synthetic
 * climatology are kept apart; synthetic data carry synthetic: true; a missing value stays null (never 0).
 *
 * What is general method and what is assumption
 *  - Temperature within a day: Parton–Logan-TYPE curve (sine by day, exponential decay by night; R247, bibliography
 *    only). The three shape coefficients are NULL by default: without them no sub-daily temperature is produced. Any
 *    values passed in are a caller's scenario (assumption: true, 遊戲假設). The parameterisation below (peak at solar
 *    noon + a, minimum at sunrise + c, night branch rescaled so it ends exactly at the next minimum) is THIS
 *    implementation's choice and may differ from the original paper (not read).
 *  - Relative humidity: RH = 100 e_a / e_s(T), e_s by FAO-56 eq. 11 (R391, general physics). e_a is not observed: it is
 *    taken from the daily mean RH at the daily mean temperature and interpolated linearly between 12:00 anchors of
 *    consecutive days (遊戲假設: keeps RH continuous across 24:00). RH is capped at 100 % (supersaturation not modelled).
 *  - Rain timing from a daily total: unknown (design doc §8 `rain.synthetic.*` null). Without a caller's timing
 *    scenario no rain events are produced and raining(t) is null (unknown) on a wet day. With one, events are drawn
 *    from named streams and their amounts allocated in integer nanometres (10⁻⁶ mm) so daily totals are conserved
 *    exactly (design doc §7.3; Owner 2026-11-03: events continuous across midnight, daily totals settled at 00:00).
 */
import { hash32, rng } from '../rng.ts';
import { type CalendarAnchor, clockFail, dateOfDay, dayOfDate, parseDate } from './time-frames.ts';
import { type LightTimes, type SolarSite, lightTimes } from './solar.ts';

export type WeatherKind = 'observation' | 'forecast' | 'synthetic_climatology';
export interface WeatherProvenance {
  kind: WeatherKind; synthetic: boolean; assumption: boolean; source: string;
  station_id: string | null; source_url: string | null;
  issued_at: string | null; valid_from: string | null; valid_to: string | null;
  generator: string | null; rng_stream: string | null;
}
export interface HourlyObservation { temp_c: (number | null)[]; rh_percent: (number | null)[]; rain_mm: (number | null)[] }
export interface DailyWeatherInput {
  date: string; provenance: WeatherProvenance;
  t_min_c: number | null; t_max_c: number | null; t_mean_c: number | null;
  rh_mean_percent: number | null;
  /** daily total; null = unknown (a 0 % rain probability is NOT 0 mm) */
  rain_mm: number | null;
  /** only for kind 'observation' in this version: 24 values per field, hour h covers [h:00, h+1:00) */
  hourly: HourlyObservation | null;
}
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const nullOr = (v: unknown, f: (x: number) => boolean) => v === null || (num(v) && f(v as number));

/** refuses anything that would blur the line between observed, forecast and synthetic data */
export function checkDailyInput(d: DailyWeatherInput): DailyWeatherInput {
  parseDate(d.date);
  const p = d.provenance, w = `weather ${d.date}`;
  if (!p || typeof p !== 'object') clockFail(`${w}: provenance missing`);
  if (!(typeof p.source === 'string' && p.source.length > 0)) clockFail(`${w}: provenance.source required`);
  if (p.kind === 'observation') {
    if (p.synthetic !== false || p.assumption !== false) clockFail(`${w}: an observation is not synthetic and not an assumption`);
    if (!p.station_id) clockFail(`${w}: an observation needs station_id`);
    if (p.generator !== null || p.rng_stream !== null || p.issued_at !== null) clockFail(`${w}: an observation has no generator, stream or issue time`);
  } else if (p.kind === 'forecast') {
    if (p.synthetic !== false) clockFail(`${w}: a forecast is not synthetic data`);
    if (!p.issued_at || !p.valid_from || !p.valid_to) clockFail(`${w}: a forecast needs issued_at, valid_from, valid_to`);
    if (d.hourly !== null) clockFail(`${w}: hourly forecast input is not supported in this version`);
  } else if (p.kind === 'synthetic_climatology') {
    if (p.synthetic !== true || p.assumption !== true) clockFail(`${w}: synthetic data must carry synthetic: true and assumption: true`);
    if (!p.generator) clockFail(`${w}: synthetic data must name its generator`);
    if (d.hourly !== null) clockFail(`${w}: synthetic hourly series must not pose as observations`);
  } else clockFail(`${w}: provenance.kind must be observation, forecast or synthetic_climatology`);
  if (!nullOr(d.t_min_c, () => true) || !nullOr(d.t_max_c, () => true) || !nullOr(d.t_mean_c, () => true)) clockFail(`${w}: temperatures must be finite or null`);
  if (d.t_min_c !== null && d.t_max_c !== null && !(d.t_min_c <= d.t_max_c)) clockFail(`${w}: t_min > t_max`);
  if (d.t_mean_c !== null && d.t_min_c !== null && d.t_max_c !== null && !(d.t_min_c <= d.t_mean_c && d.t_mean_c <= d.t_max_c)) clockFail(`${w}: t_mean outside [t_min, t_max]`);
  if (!nullOr(d.rh_mean_percent, (x) => x >= 0 && x <= 100)) clockFail(`${w}: rh_mean_percent must be in [0, 100] or null`);
  if (!nullOr(d.rain_mm, (x) => x >= 0)) clockFail(`${w}: rain_mm must be >= 0 or null`);
  if (d.hourly !== null) {
    const h = d.hourly;
    for (const k of ['temp_c', 'rh_percent', 'rain_mm'] as const) if (!Array.isArray(h[k]) || h[k].length !== 24 || !h[k].every((v) => nullOr(v, (x) => (k === 'rain_mm' ? x >= 0 : k === 'rh_percent' ? x >= 0 && x <= 100 : true)))) clockFail(`${w}: hourly.${k} must be 24 finite values or null`);
  }
  return d;
}

/** a world-level adapter for the engine's synthetic daily weather (engine/weather.ts calcWeather); reads no colony */
export interface SyntheticDailyWeatherLike { date: string; kind: string; air_temp_c: number; daily_max_air_temp_c: number; daily_min_air_temp_c: number; relative_humidity_model_percent: number; rain_mm: number }
export function fromSyntheticDaily(w: SyntheticDailyWeatherLike, generator: string, rngStream: string): DailyWeatherInput {
  if (!/synthetic/.test(w.kind)) clockFail(`weather ${w.date}: kind ${w.kind} is not synthetic; use an observation or forecast record`);
  return checkDailyInput({
    date: w.date, t_min_c: w.daily_min_air_temp_c, t_max_c: w.daily_max_air_temp_c, t_mean_c: w.air_temp_c, rh_mean_percent: w.relative_humidity_model_percent, rain_mm: w.rain_mm, hourly: null,
    provenance: { kind: 'synthetic_climatology', synthetic: true, assumption: true, source: `synthetic climatology (${w.kind})`, station_id: null, source_url: null, issued_at: null, valid_from: null, valid_to: null, generator, rng_stream: rngStream },
  });
}

// ------------------------------------------------------------------ temperature (Parton–Logan-type, coefficients null)
/** scenario coefficients; null = unknown (no sub-daily temperature is produced) */
export interface TemperatureShape { peak_lag_after_noon_h: number; night_decay_b: number; min_lag_after_sunrise_h: number }
export const TEMPERATURE_SHAPE_DEFAULT: TemperatureShape | null = null;
export function checkShape(s: TemperatureShape): TemperatureShape {
  if (!s || !num(s.peak_lag_after_noon_h) || !num(s.night_decay_b) || !num(s.min_lag_after_sunrise_h)) clockFail('temperature shape needs three finite coefficients');
  if (!(s.night_decay_b > 0)) clockFail('night_decay_b must be > 0');
  return s;
}
export type ValueSource = 'observation_hourly' | 'reconstructed_from_daily' | 'unavailable';
export interface TempValue { value: number | null; source: ValueSource; reason: string | null }

interface DayCtx { input: DailyWeatherInput; light: LightTimes }
/**
 * Continuous temperature function on world minutes across days. Inputs are keyed by world day; a value needing a day
 * that is missing (or a null min/max) is null with a reason. Midnight is not a joint: the night branch runs from
 * sunset of day d to the minimum of day d+1 in ONE piece.
 */
export class WeatherSeries {
  readonly anchor: CalendarAnchor; readonly site: SolarSite; readonly shape: TemperatureShape | null;
  private days = new Map<number, DayCtx>();
  constructor(anchor: CalendarAnchor, site: SolarSite, inputs: readonly DailyWeatherInput[], shape: TemperatureShape | null) {
    this.anchor = anchor; this.site = site; this.shape = shape === null ? null : checkShape(shape);
    for (const d of inputs) {
      const day = dayOfDate(anchor, checkDailyInput(d).date);
      if (this.days.has(day)) clockFail(`two weather inputs for ${d.date}`);
      this.days.set(day, { input: d, light: lightTimes(site, anchor, d.date) });
    }
    if (this.shape) for (const [day, c] of this.days) {
      const s = this.shape, tMin = c.light.sunrise + 60 * s.min_lag_after_sunrise_h, tPeak = c.light.solar_noon + 60 * s.peak_lag_after_noon_h;
      if (!(tMin < tPeak && tPeak <= c.light.sunset)) clockFail(`temperature shape on ${dateOfDay(anchor, day)}: need sunrise+c < noon+a <= sunset`);
    }
  }
  input(day: number): DailyWeatherInput | null { return this.days.get(day)?.input ?? null; }
  light(day: number): LightTimes | null { return this.days.get(day)?.light ?? null; }
  daysCovered(): number[] { return [...this.days.keys()].sort((a, b) => a - b); }

  /** temperature at an instant: day + minute (minute in [0, 1440)) */
  temperature(day: number, minute: number): TempValue {
    const c = this.days.get(day);
    if (!c) return { value: null, source: 'unavailable', reason: 'no input for this day' };
    if (c.input.hourly) return this.hourlyAt(day, minute, 'temp_c');
    if (!this.shape) return { value: null, source: 'unavailable', reason: 'temperature shape coefficients are null (R247 not read)' };
    const s = this.shape;
    const tMinAt = (k: number) => this.days.get(k)!.light.sunrise + 60 * s.min_lag_after_sunrise_h;
    // which branch: before today's minimum → night branch of day-1; after today's sunset → night branch of today
    if (minute < tMinAt(day)) return this.night(day - 1, minute + 1440);
    if (minute >= c.light.sunset) return this.night(day, minute);
    return this.dayBranch(day, minute);
  }
  /** observed hourly values are instants at hour starts; between two of them, linear interpolation (labelled observation-based) */
  private hourlyAt(day: number, minute: number, k: 'temp_c' | 'rh_percent'): TempValue {
    const i = Math.floor(minute / 60), f = (minute - 60 * i) / 60, a = this.days.get(day)!.input.hourly![k][i];
    if (a === null) return { value: null, source: 'unavailable', reason: 'hourly observation missing' };
    if (f === 0) return { value: a, source: 'observation_hourly', reason: null };
    const b = i + 1 < 24 ? this.days.get(day)!.input.hourly![k][i + 1] : this.days.get(day + 1)?.input.hourly?.[k][0] ?? null;
    if (b === null) return { value: null, source: 'unavailable', reason: 'next hourly observation missing' };
    return { value: a + (b - a) * f, source: 'observation_hourly', reason: null };
  }
  private minMax(day: number): [number, number] | null { const i = this.days.get(day)?.input; return i && i.t_min_c !== null && i.t_max_c !== null ? [i.t_min_c, i.t_max_c] : null; }
  private dayBranch(day: number, minute: number): TempValue {
    const mm = this.minMax(day); if (!mm) return { value: null, source: 'unavailable', reason: 'daily min/max unknown' };
    const s = this.shape!, L = this.days.get(day)!.light;
    const tMin = L.sunrise + 60 * s.min_lag_after_sunrise_h, tPeak = L.solar_noon + 60 * s.peak_lag_after_noon_h;
    const x = Math.min(1, (minute - tMin) / (2 * (tPeak - tMin)));
    return { value: mm[0] + (mm[1] - mm[0]) * Math.sin(Math.PI * x), source: 'reconstructed_from_daily', reason: null };
  }
  /** night branch of day d evaluated at minute m (minutes since 00:00 of day d; may exceed 1440) */
  private night(d: number, m: number): TempValue {
    if (!this.days.has(d) || !this.days.has(d + 1)) return { value: null, source: 'unavailable', reason: 'night needs the previous and next day inputs' };
    const next = this.minMax(d + 1); if (!next) return { value: null, source: 'unavailable', reason: 'next-day minimum unknown' };
    const L = this.days.get(d)!.light, ts = this.dayBranch(d, L.sunset);
    if (ts.value === null) return ts;
    const s = this.shape!, end = 1440 + this.days.get(d + 1)!.light.sunrise + 60 * s.min_lag_after_sunrise_h, Z = end - L.sunset, n = m - L.sunset;
    const eb = Math.exp(-s.night_decay_b), w = (Math.exp(-s.night_decay_b * n / Z) - eb) / (1 - eb);
    return { value: next[0] + (ts.value - next[0]) * w, source: 'reconstructed_from_daily', reason: null };
  }

  /** relative humidity at an instant (FAO-56 e_s; e_a interpolated between 12:00 anchors — 遊戲假設) */
  relativeHumidity(day: number, minute: number): TempValue {
    const c = this.days.get(day);
    if (!c) return { value: null, source: 'unavailable', reason: 'no input for this day' };
    if (c.input.hourly) return this.hourlyAt(day, minute, 'rh_percent');
    const T = this.temperature(day, minute); if (T.value === null) return { value: null, source: 'unavailable', reason: `temperature unavailable: ${T.reason}` };
    const k = minute < 720 ? day - 1 : day, f = (minute + (minute < 720 ? 1440 : 0) - 720) / 1440;
    const ea0 = this.actualVapour(k), ea1 = this.actualVapour(k + 1);
    if (ea0 === null || ea1 === null) return { value: null, source: 'unavailable', reason: 'daily mean RH or temperature unknown on an anchoring day' };
    return { value: Math.min(100, (100 * (ea0 + (ea1 - ea0) * f)) / saturationVapourKPa(T.value)), source: 'reconstructed_from_daily', reason: null };
  }
  private actualVapour(day: number): number | null {
    const i = this.days.get(day)?.input; if (!i || i.rh_mean_percent === null) return null;
    const tm = i.t_mean_c ?? (i.t_min_c !== null && i.t_max_c !== null ? (i.t_min_c + i.t_max_c) / 2 : null);
    return tm === null ? null : (i.rh_mean_percent / 100) * saturationVapourKPa(tm);
  }
}
/** FAO-56 eq. 11 (R391): saturation vapour pressure in kPa at air temperature T (°C) */
export const saturationVapourKPa = (T: number) => 0.6108 * Math.exp((17.27 * T) / (T + 237.3));

// ------------------------------------------------------------------ rain events
export const NM_PER_MM = 1_000_000;
/** caller's timing scenario for synthetic events from a daily total; every value is 遊戲假設 (design doc §8 null) */
export interface RainTimingScenario { events_per_rain_day: number; duration_min: [number, number]; assumption: true; basis: '遊戲假設'; label: string }
export function checkRainScenario(s: RainTimingScenario): RainTimingScenario {
  if (!s || s.assumption !== true || s.basis !== '遊戲假設' || !s.label) clockFail('a rain timing scenario must be labelled assumption: true, basis 遊戲假設');
  if (!(Number.isInteger(s.events_per_rain_day) && s.events_per_rain_day >= 1)) clockFail('events_per_rain_day must be an integer >= 1');
  const [lo, hi] = s.duration_min; if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 1 && hi >= lo)) clockFail('duration_min must be integers 1 <= lo <= hi');
  return s;
}
export interface RainSegment { day: number; start_min: number; end_min: number; amount_nm: number }
export interface RainEvent {
  id: string; day: number; start_min: number; /** end as minutes after 00:00 of `day` (may exceed 1440) */ end_min: number;
  segments: RainSegment[]; amount_nm: number;
  timing: 'hourly_observation' | 'synthetic_scenario'; resolution: 'hour' | 'minute';
  synthetic: boolean; assumption: boolean; provenance_kind: WeatherKind; rng_stream: string | null;
}
export interface RainRecord { kind: 'truncated_next_day_budget' | 'truncated_next_day_unknown' | 'truncated_horizon' | 'truncated_rounding' | 'dropped_no_budget' | 'daily_hourly_mismatch'; event: string | null; day: number; detail: string; amount_nm: number }
export interface DailyRain { day: number; date: string; /** the input daily total (null: unknown) */ input_nm: number | null; /** what the events of this day must sum to (= input unless a daily_hourly_mismatch is recorded) */ settled_nm: number | null; rounding_residual_nm: number; timing: 'hourly_observation' | 'synthetic_scenario' | 'unknown' | 'dry_known' }
export interface RainPlan { events: RainEvent[]; days: DailyRain[]; records: RainRecord[] }

/** largest-remainder split of an integer total by integer weights (ties to the lower index) */
export function splitInteger(total: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(Number.isSafeInteger(total) && total >= 0) || !weights.every((w) => Number.isSafeInteger(w) && w >= 0) || !(sum > 0 && Number.isSafeInteger(sum))) return clockFail('splitInteger: integer total >= 0 and non-negative integer weights with a positive sum');
  // BigInt: total * weight can exceed 2^53 (nm totals x nm weights)
  const T = BigInt(total), S = BigInt(sum);
  const parts = weights.map((w) => (T * BigInt(w)) / S), rem = weights.map((w, i) => T * BigInt(w) - parts[i] * S);
  let left = T - parts.reduce((a, b) => a + b, 0n);
  for (const { i } of rem.map((r, i) => ({ i, r })).sort((a, b) => (b.r > a.r ? 1 : b.r < a.r ? -1 : a.i - b.i))) { if (left <= 0n) break; parts[i]++; left--; }
  return parts.map(Number);
}
const toNm = (mm: number) => { const exact = mm * NM_PER_MM, n = Math.round(exact); return { nm: n, residual: Math.round((exact - n) * 1000) / 1000 }; };

/**
 * Rain events for days [first, last] of the series. Days are processed in order: rain carried past 00:00 from day d−1
 * is charged to day d's budget first (truncated and recorded if the budget is short or unknown); the rest of day d's
 * total goes to day d's own events in proportion to their in-day minutes (largest remainder). Every day's settled
 * total therefore equals its input total in integer nm, exactly. Events beyond `last` are cut at its 24:00 (recorded).
 */
export function planRain(series: WeatherSeries, first: number, last: number, seed: number, scenario: RainTimingScenario | null): RainPlan {
  if (scenario) checkRainScenario(scenario);
  const events: RainEvent[] = [], days: DailyRain[] = [], records: RainRecord[] = [];
  let carry: { ev: RainEvent; after_min: number; amount_nm: number }[] = [];
  for (let day = first; day <= last; day++) {
    const input = series.input(day), date = dateOfDay(series.anchor, day);
    const D = input && input.rain_mm !== null ? toNm(input.rain_mm) : null;
    // 1. carry-in from yesterday
    if (carry.length) {
      const need = carry.reduce((a, c) => a + c.amount_nm, 0), budget = D === null ? 0 : D.nm;
      const got = need <= budget ? carry.map((c) => c.amount_nm) : splitInteger(budget, carry.map((c) => c.amount_nm));
      carry.forEach((c, i) => {
        const mins = got[i] === c.amount_nm ? c.after_min : Math.ceil((c.after_min * got[i]) / c.amount_nm);
        if (got[i] < c.amount_nm) records.push({ kind: D === null ? 'truncated_next_day_unknown' : 'truncated_next_day_budget', event: c.ev.id, day, detail: `ends ${mins} min after 00:00 instead of ${c.after_min}`, amount_nm: c.amount_nm - got[i] });
        c.ev.end_min = 1440 * (day - c.ev.day) + mins;
        if (got[i] > 0) c.ev.segments.push({ day, start_min: 0, end_min: mins, amount_nm: got[i] });
        c.ev.amount_nm = c.ev.segments.reduce((a, s) => a + s.amount_nm, 0);
      });
    }
    const carried = carry.reduce((a, c) => a + (c.ev.segments.find((s) => s.day === day)?.amount_nm ?? 0), 0);
    carry = [];
    // 2. today's own events
    const own: RainEvent[] = [];
    if (input?.hourly) {
      const r = input.hourly.rain_mm;
      for (let h = 0; h < 24;) {
        if (!(r[h] !== null && r[h]! > 0)) { h++; continue; }
        let e = h; const amounts: number[] = [];
        while (e < 24 && r[e] !== null && r[e]! > 0) { amounts.push(toNm(r[e]!).nm); e++; }
        own.push({ id: `rain.${date}.h${String(h).padStart(2, '0')}`, day, start_min: 60 * h, end_min: 60 * e, amount_nm: 0, segments: amounts.map((a, k) => ({ day, start_min: 60 * (h + k), end_min: 60 * (h + k + 1), amount_nm: a })), timing: 'hourly_observation', resolution: 'hour', synthetic: false, assumption: false, provenance_kind: input.provenance.kind, rng_stream: null });
        h = e;
      }
      for (const ev of own) ev.amount_nm = ev.segments.reduce((a, s) => a + s.amount_nm, 0);
      const sumH = own.reduce((a, e) => a + e.amount_nm, 0);
      if (D !== null && D.nm !== sumH + carried) records.push({ kind: 'daily_hourly_mismatch', event: null, day, detail: `daily ${D.nm} nm vs hourly ${sumH} nm + carried ${carried} nm; settlement follows the hourly events`, amount_nm: D.nm - sumH - carried });
      days.push({ day, date, input_nm: D === null ? null : D.nm, settled_nm: sumH + carried, rounding_residual_nm: D === null ? 0 : D.residual, timing: 'hourly_observation' });
      events.push(...own);
      continue;
    }
    const remaining = D === null ? 0 : D.nm - carried;
    if (D !== null && remaining > 0 && scenario) {
      const stream = `${seed}|p0a1|rain|${date}`, g = rng(hash32(stream)), [lo, hi] = scenario.duration_min;
      const drawn = Array.from({ length: scenario.events_per_rain_day }, (_, k) => ({ k, start: Math.floor(g() * 1440), dur: lo + Math.floor(g() * (hi - lo + 1)) }));
      const inDay = drawn.map((x) => Math.min(1440, x.start + x.dur) - x.start);
      const amounts = splitInteger(remaining, inDay);
      drawn.forEach((x, i) => {
        const ev: RainEvent = { id: `rain.${date}.s${x.k}`, day, start_min: x.start, end_min: x.start + x.dur, amount_nm: 0, segments: [], timing: 'synthetic_scenario', resolution: 'minute', synthetic: true, assumption: true, provenance_kind: input!.provenance.kind, rng_stream: stream };
        if (amounts[i] === 0) { records.push({ kind: 'dropped_no_budget', event: ev.id, day, detail: 'no rain left in the day budget for this event', amount_nm: 0 }); return; }
        ev.segments.push({ day, start_min: x.start, end_min: x.start + inDay[i], amount_nm: amounts[i] });
        const after = x.start + x.dur - 1440;
        if (after > 0) {
          const amt = Math.floor((amounts[i] * after) / inDay[i]);
          if (day === last) { ev.end_min = 1440; records.push({ kind: 'truncated_horizon', event: ev.id, day, detail: `cut at 24:00 of the last day (${after} min beyond)`, amount_nm: amt }); }
          else if (amt === 0) { ev.end_min = 1440; records.push({ kind: 'truncated_rounding', event: ev.id, day, detail: `the ${after} min after 00:00 carry less than 1 nm: cut at 24:00`, amount_nm: 0 }); }
          else carry.push({ ev, after_min: after, amount_nm: amt });
        }
        ev.amount_nm = amounts[i]; own.push(ev);
      });
    } else if (D !== null && remaining < 0) clockFail('internal: carried rain exceeds the day budget');
    const timing: DailyRain['timing'] = D === null ? 'unknown' : D.nm === 0 ? 'dry_known' : scenario ? 'synthetic_scenario' : 'unknown';
    days.push({ day, date, input_nm: D === null ? null : D.nm, settled_nm: D === null ? null : D.nm > 0 && !scenario ? null : D.nm, rounding_residual_nm: D === null ? 0 : D.residual, timing });
    events.push(...own);
  }
  // events without any rain in a later segment are already closed; final amounts are the segment sums
  for (const e of events) e.amount_nm = e.segments.reduce((a, s) => a + s.amount_nm, 0);
  return { events, days, records };
}
