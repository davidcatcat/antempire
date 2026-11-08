/**
 * P0-A1 prototype — the 24-hour environment clock on a NON-OFFICIAL Day0 experiment world (docs/p0a1-24h-clock.md).
 * Experimental only: writes nothing (stdout only), no save, no journal, no game day, not the official world.
 *
 * Daily weather comes from the engine's synthetic climatology (engine/weather.ts calcWeather; synthetic: true) for the
 * Day0 experiment world built by cli/lib/day0.ts. Only the world's seed and climate memory are used; the colony of that
 * Day0 state is never read. Sub-daily temperature needs shape coefficients, which are null (R247 not read): pass
 * --shape a,b,c only as a labelled scenario. Rain timing likewise needs --rain-events K --rain-dur lo,hi (scenario).
 *
 *   node prototypes/p0a1-24h-clock/day0-environment.ts [--season summer] [--seed 1] [--days 4] [--order layered|tick]  (default layered)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcWeather, nextClimate } from '../../engine/weather.ts';
import { resolveBundle } from '../../engine/params.ts';
import { loadBundle } from '../../cli/lib/load.ts';
import { buildDay0, seasonStart, type Season } from '../../cli/lib/day0.ts';
import type { TimeOrder } from '../../engine/scheduler/world-events.ts';
import { type ClockWorldConfig, ClockRun } from '../../engine/clock/environment.ts';
import { type DailyWeatherInput, type RainTimingScenario, type TemperatureShape, fromSyntheticDaily } from '../../engine/clock/weather-input.ts';
import { DEFAULT_ORDER } from '../../engine/clock/time-frames.ts';
import { CIVIL_TWILIGHT_ALTITUDE_DEG, SUNRISE_ALTITUDE_DEG } from '../../engine/clock/solar.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCENARIO = JSON.parse(fs.readFileSync(path.join(ROOT, 'scenarios/p0a1-clock/xitun-day0-clock.json'), 'utf8'));
if (SCENARIO.light.sunrise_altitude_deg.value !== SUNRISE_ALTITUDE_DEG || SCENARIO.light.civil_twilight_altitude_deg.value !== CIVIL_TWILIGHT_ALTITUDE_DEG) throw Error('scenario light thresholds disagree with engine/clock/solar.ts');

/** synthetic daily weather of world days 1..n of the Day0 experiment world (world-level only) */
export function day0DailyWeather(season: Season, seed: number, n: number): { start: string; inputs: DailyWeatherInput[] } {
  const start = seasonStart(season), bundle = loadBundle(), wp = resolveBundle(bundle).world;
  const day0 = buildDay0('A1', seed, start, bundle);
  let climate = day0.state.climate; const inputs: DailyWeatherInput[] = [];
  for (let k = 1; k <= n; k++) {
    const date = new Date(Date.parse(start + 'T00:00:00Z') + k * 86_400_000).toISOString().slice(0, 10);
    const w = calcWeather({ seed: day0.state.seed, sim_day: k - 1, climate }, wp, date);
    inputs.push(fromSyntheticDaily(w, 'engine/weather.ts calcWeather (Taichung 1991–2020 synthetic climatology)', `${day0.state.seed}|${k}|weather`));
    climate = nextClimate(climate, w);
  }
  return { start, inputs };
}
export function day0Config(start: string, seed: number, firstDay: number, lastDay: number, order: TimeOrder, shape: TemperatureShape | null, rain: RainTimingScenario | null, step = SCENARIO.weather_sample_step_min.value as number): ClockWorldConfig {
  return {
    world: SCENARIO.world, official: false, order, sample_step_min: step, first_day: firstDay, last_day: lastDay, seed,
    anchor: { day0_date: start, utc_offset_minutes: SCENARIO.calendar.utc_offset_minutes.value, zone: SCENARIO.calendar.zone },
    site: { latitude_deg: SCENARIO.representative_point.latitude_deg.value, longitude_deg: SCENARIO.representative_point.longitude_deg.value },
    temperature_shape: shape, rain_timing: rain,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
  const season = arg('season', 'summer') as Season, seed = Number(arg('seed', '1')), days = Number(arg('days', '4')), order = arg('order', DEFAULT_ORDER) as TimeOrder;
  const sh = arg('shape', ''), re = arg('rain-events', ''), rd = arg('rain-dur', '30,180').split(',').map(Number);
  const shape: TemperatureShape | null = sh ? (([a, b, c]) => ({ peak_lag_after_noon_h: a, night_decay_b: b, min_lag_after_sunrise_h: c }))(sh.split(',').map(Number)) : null;
  const rain: RainTimingScenario | null = re ? { events_per_rain_day: Number(re), duration_min: [rd[0], rd[1]], assumption: true, basis: '遊戲假設', label: 'command-line scenario' } : null;
  const { start, inputs } = day0DailyWeather(season, seed, days + 1);
  const run = new ClockRun(day0Config(start, seed, 1, days, order, shape, rain), inputs);
  for (let d = 1; d <= days; d++) run.closeDay(d);
  console.log(JSON.stringify({
    label: '非正式 Day0 實驗世界（synthetic: true）；不是正式歷史', season, seed, order, day0_date: start,
    scenario: { temperature_shape: shape ?? 'null (no sub-daily temperature)', rain_timing: rain ?? 'null (wet days: timing unknown)' },
    days: run.days, rain_records: run.plan.records, audit: run.scheduler.audit(), time_report: { merges: run.scheduler.timeReport().merges.length, inversions: run.scheduler.timeReport().inversions.length },
  }, null, 2));
}
