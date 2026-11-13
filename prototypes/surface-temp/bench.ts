/**
 * SURF-0 bench (Owner ruling #213 Q2 b) — NON-OFFICIAL, synthetic, deterministic. Prints Markdown tables to the
 * terminal (`node prototypes/surface-temp/bench.ts`); writes nothing. Used by tests/surface-temp.test.ts.
 *
 * Compares the air-temperature proxy (the CHEM-2 surrogate) with the SURF-0 surface-temperature candidate on the same
 * synthetic cool / hot days as the CHEM-2 bench (18–24 °C, 26–34 °C; NOT Taichung climatology), for shade 0 / 0.5 / 1
 * and a small sensitivity sweep of the game-assumption coefficients. Every number printed is a MODEL VALUE (模型值，
 * 非實測). No colony state exists here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Coef, type SurfaceParams, type SurfaceRecord, runSurface } from '../../engine/clock/surface-temperature.ts';
import { type CalendarAnchor, dateOfDay } from '../../engine/clock/time-frames.ts';
import { type DailyWeatherInput, type TemperatureShape, WeatherSeries } from '../../engine/clock/weather-input.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PARAMS_FILE = path.join(HERE, 'params.json');
export function loadParams(): SurfaceParams { return JSON.parse(fs.readFileSync(PARAMS_FILE, 'utf8')).coefficients as SurfaceParams; }
export const withCoef = (p: SurfaceParams, k: keyof SurfaceParams, value: number | null): SurfaceParams => ({ ...p, [k]: { ...p[k], value } as Coef });

export const ANCHOR: CalendarAnchor = { day0_date: '2027-07-01', utc_offset_minutes: 480, zone: 'Asia/Taipei' };
/** Xitun, Taichung representative point (as the P0-A1 / CHEM-2 benches; a site, not a measured garden position) */
export const SITE = { latitude_deg: 24.17, longitude_deg: 120.64 };
export const SHAPE: TemperatureShape = { peak_lag_after_noon_h: 2, night_decay_b: 2, min_lag_after_sunrise_h: 0 };
export const WEATHER = { cool: { t_min_c: 18, t_max_c: 24 }, hot: { t_min_c: 26, t_max_c: 34 } } as const;
export type WeatherName = keyof typeof WEATHER;
/** days 0..3 have inputs; the run covers days 1..2 (night branches need neighbours) */
export function series(w: WeatherName): WeatherSeries {
  const { t_min_c, t_max_c } = WEATHER[w];
  const inputs: DailyWeatherInput[] = [0, 1, 2, 3].map((d) => { const date = dateOfDay(ANCHOR, d); return { date, provenance: { kind: 'synthetic_climatology', synthetic: true, assumption: true, source: 'SURF-0 bench fixture (synthetic day)', station_id: null, source_url: null, issued_at: null, valid_from: null, valid_to: null, generator: 'prototypes/surface-temp/bench.ts', rng_stream: null }, t_min_c, t_max_c, t_mean_c: (t_min_c + t_max_c) / 2, rh_mean_percent: 75, rain_mm: 0, hourly: null }; });
  return new WeatherSeries(ANCHOR, SITE, inputs, SHAPE);
}
export function run(w: WeatherName, shade: number, p: SurfaceParams = loadParams(), step_min = 5): SurfaceRecord[] {
  const s = series(w);
  return runSurface(p, { anchor: ANCHOR, site: SITE, shade, step_min, first_day: 1, last_day: 2 }, (d, m) => s.temperature(d, m).value);
}
export const at = (rs: SurfaceRecord[], day: number, minute: number) => rs.find((r) => r.day === day && r.minute === minute)!;
export const PROBES = [360, 540, 720, 780, 900, 1080, 1260];
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const f1 = (x: number | null) => (x === null ? 'null' : x.toFixed(1));

function main() {
  const L: string[] = [];
  L.push('### 氣溫代理 vs SURF-0 地表模型值（第 2 日；°C；模型值，非實測）', '');
  L.push(`| 天氣 | 遮蔭 | 量 | ${PROBES.map(hhmm).join(' | ')} |`, `|${'---|'.repeat(PROBES.length + 3)}`);
  for (const w of ['cool', 'hot'] as const) {
    const base = run(w, 0);
    L.push(`| ${w} | — | 氣溫代理 | ${PROBES.map((m) => f1(at(base, 2, m).air_temp_proxy_c)).join(' | ')} |`);
    for (const sh of [0, 0.5, 1]) { const r = run(w, sh); L.push(`| ${w} | ${sh} | 地表模型 | ${PROBES.map((m) => f1(at(r, 2, m).surface_temp_model_c)).join(' | ')} |`); }
  }
  L.push('', '### 遊戲假設係數敏感度（熱天、遮蔭 0、第 2 日 13:00 地表模型值 − 氣溫代理，K）', '', '| 係數 | 值 | ΔT |', '|---|---|---|');
  const sens: [keyof SurfaceParams, number[]][] = [['albedo', [0.1, 0.2, 0.35]], ['ground_flux_fraction', [0.1, 0.3, 0.5]], ['h_conv_wm2k', [5, 10, 20]], ['tau_min', [10, 30, 90]], ['sky_clearness', [0.3, 0.6, 1]]];
  for (const [k, vs] of sens) for (const v of vs) { const r = at(run('hot', 0, withCoef(loadParams(), k, v)), 2, 780); L.push(`| ${k} | ${v} | ${(r.surface_temp_model_c! - r.air_temp_proxy_c!).toFixed(1)} |`); }
  console.log(L.join('\n'));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
