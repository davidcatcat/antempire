/**
 * P0-A1 24-hour clock (docs/p0a1-24h-clock.md) on NON-OFFICIAL Day0 experiment worlds only.
 *  1. four time frames: civil calendar, ecological / physics native times, display; conversions exact or bounded, and
 *     never reordering (display is a monotone floor; labels a monotone rounding; order by the scheduler contract);
 *  2. light: NOAA-equation sunrise / sunset / civil twilight for the Xitun representative point — self-consistency and
 *     an INDEPENDENT almanac algorithm; ordering dawn < sunrise < noon < sunset < dusk;
 *  3. weather input provenance (observation / forecast / synthetic kept apart; synthetic: true; null stays null);
 *  4. Parton–Logan-type temperature: null coefficients → no sub-daily temperature; for a GRID of coefficient values
 *     (test fixtures, not parameters) the curve is continuous at sunrise, sunset and 24:00, hits the daily min/max,
 *     stays within bounds; RH ≤ 100 and continuous across 24:00;
 *  5. rain events: daily totals conserved exactly in nm, across midnight, under truncation, for many seeds;
 *  6. the run: monotone clock, every event executed exactly once, verifyLog, light cycle, nothing resets at 24:00,
 *     snapshot/restore mid-day = continuous, input-permutation and seed invariance, both scheduler contracts;
 *  7. a Day0 experiment world from the engine's synthetic climatology (4 seasons × 2 seeds); saves untouched.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { hash32, rng } from '../engine/rng.ts';
import { type TimeOrder, type WorldEvent, WorldScheduler, compareExact, exactOf, labelOf, verifyLog, compareTime } from '../engine/scheduler/world-events.ts';
import { ClockError, civilFromDays, dateOfDay, dayOfDate, dayOfYear, daysFromCivil, displayOf, ecoNative, formatDate, msFloor, parseDate, physicsNative, type CalendarAnchor } from '../engine/clock/time-frames.ts';
import { CIVIL_TWILIGHT_ALTITUDE_DEG, SUNRISE_ALTITUDE_DEG, lightTimes, lightStateAt, solarAltitude, type SolarSite } from '../engine/clock/solar.ts';
import { type DailyWeatherInput, type RainTimingScenario, type TemperatureShape, WeatherSeries, checkDailyInput, fromSyntheticDaily, planRain, saturationVapourKPa, splitInteger } from '../engine/clock/weather-input.ts';
import { type ClockWorldConfig, ClockRun, environmentSpecs } from '../engine/clock/environment.ts';
import { allocateRain } from '../reports/p0a-24h-clock/rain-allocation.ts';
import { SCENARIO, day0Config, day0DailyWeather } from '../prototypes/p0a1-24h-clock/day0-environment.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, (e: unknown) => e instanceof Error && re.test(e.message), why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const guarded = ['saves/main.json', 'saves/world-state.json', 'saves/commit-log.json'].filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => [f, sha(path.join(REPO_ROOT, f))]);
const journalBefore = fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join();

const ANCHOR: CalendarAnchor = { day0_date: '2027-06-21', utc_offset_minutes: 480, zone: 'Asia/Taipei' };
const SITE: SolarSite = { latitude_deg: SCENARIO.representative_point.latitude_deg.value, longitude_deg: SCENARIO.representative_point.longitude_deg.value };
const SYN = (date: string) => ({ kind: 'synthetic_climatology' as const, synthetic: true, assumption: true, source: 'test fixture', station_id: null, source_url: null, issued_at: null, valid_from: null, valid_to: null, generator: 'tests/p0a1-24h-clock fixture', rng_stream: `fixture|${date}` });
/** synthetic daily inputs (test fixtures; synthetic: true) for world days 0..n-1 */
function fixtureInputs(anchor: CalendarAnchor, n: number, seed: number, rain: (d: number) => number | null): DailyWeatherInput[] {
  const g = rng(hash32(`fixture|${seed}`));
  return Array.from({ length: n }, (_, d) => {
    const date = dateOfDay(anchor, d), tmin = 15 + 10 * g(), tmax = tmin + 2 + 10 * g();
    return { date, provenance: SYN(date), t_min_c: tmin, t_max_c: tmax, t_mean_c: (tmin + tmax) / 2, rh_mean_percent: 50 + 40 * g(), rain_mm: rain(d), hourly: null };
  });
}
const SHAPE_GRID: TemperatureShape[] = [];
for (const a of [0, 1, 2.5]) for (const b of [0.5, 2, 4]) for (const c of [-0.5, 0, 1]) SHAPE_GRID.push({ peak_lag_after_noon_h: a, night_decay_b: b, min_lag_after_sunrise_h: c });
const RAIN_FIXTURE = (k: number, lo: number, hi: number): RainTimingScenario => ({ events_per_rain_day: k, duration_min: [lo, hi], assumption: true, basis: '遊戲假設', label: 'test fixture' });
const cfgOf = (o: Partial<ClockWorldConfig> = {}): ClockWorldConfig => ({ world: 'p0a1test', official: false, anchor: ANCHOR, site: SITE, order: 'tick', sample_step_min: 60, first_day: 1, last_day: 4, seed: 7, temperature_shape: SHAPE_GRID[13], rain_timing: RAIN_FIXTURE(3, 20, 600), ...o });
function fullRun(cfg: ClockWorldConfig, inputs: DailyWeatherInput[]) {
  const r = new ClockRun(cfg, inputs);
  for (let d = cfg.first_day; d <= cfg.last_day; d++) r.closeDay(d);
  return r;
}
const diag: Record<string, unknown> = {};
const logKey = (r: ClockRun) => JSON.stringify(r.scheduler.log.map((l) => [l.id, l.exact, l.round, l.state]));

try {
  // ------------------------------------------------------------ 1. time frames
  {
    const g = rng(11);
    let rt = true; for (let i = 0; i < 3000; i++) { const z = Math.floor((g() - 0.5) * 2e6), c = civilFromDays(z); if (!(daysFromCivil(c.y, c.m, c.d) === z && (c.y < 0 || parseDate(formatDate(z)) === z))) rt = false; }
    ok(rt, 'civil date ↔ day number round trip (3000 random days)');
    ok(daysFromCivil(1970, 1, 1) === 0 && formatDate(daysFromCivil(2000, 2, 29)) === '2000-02-29' && dayOfYear('2027-12-31') === 365 && dayOfYear('2028-12-31') === 366, 'calendar anchors: epoch, leap day, day-of-year');
    refuses(() => parseDate('2027-02-29'), /does not exist/, 'a non-existent date is refused');
    ok(dateOfDay(ANCHOR, 0) === '2027-06-21' && dateOfDay(ANCHOR, 11) === '2027-07-02' && dayOfDate(ANCHOR, '2027-07-02') === 11, 'world day ↔ civil date');
    refuses(() => ecoNative({ clock: 'e', day: 0, minute: 30, resolution: 'hour' }), /not on an hour/, 'hour resolution must sit on an hour');
    refuses(() => ecoNative({ clock: 'e', day: 0, minute: 12.5, resolution: 'minute' }), /whole minute/, 'minute resolution must be a whole minute');
    refuses(() => ecoNative({ clock: 'e', day: 0, minute: 5, resolution: 'day' }), /00:00/, 'a day-only value sits at 00:00 (never drawn at a minute)');
    // ecological minute 1500 on day 2 is exactly 01:00 of day 3: no reset, exact carry
    const x = exactOf(ecoNative({ clock: 'e', day: 2, minute: 1500, resolution: 'minute' }));
    ok(x.day === 3 && x.us === 3_600_000_000 && x.us_lo === 0, 'eco time past 24:00 carries exactly into the next day');
    const p = exactOf(physicsNative('ph', { day: 2, minute: 1439.5 }, 45));
    ok(p.day === 3 && p.us === 15_000_000, 'physics seconds anchored at 23:59:30 cross midnight exactly');
    // display: floor is monotone and its interval contains the true instant
    const items = Array.from({ length: 4000 }, (_, i) => exactOf(physicsNative(`c${i % 3}`, { day: Math.floor(g() * 3), minute: Math.floor(g() * 1439) }, g() * 120))).sort(compareExact);
    let mono = true, inside = true;
    for (let i = 0; i < items.length; i++) {
      for (const res of ['exact', 'second', 'minute', 'hour', 'day'] as const) {
        const d = displayOf(ANCHOR, items[i], res), tms = (items[i].us + items[i].us_lo) / 1000;
        if (!(d.interval_ms[0] <= tms + 1e-9 && tms < d.interval_ms[1] + 1e-9) || d.day !== items[i].day) inside = false;
        if (i && d.key_ms < displayOf(ANCHOR, items[i - 1], res).key_ms) mono = false;
      }
    }
    ok(mono, 'display keys never decrease along the exact order (5 resolutions × 4000 instants)');
    ok(inside, 'every display interval contains its true instant');
    ok(msFloor({ day: 0, us: 5000, us_lo: -1e-12 }) === 4 && msFloor({ day: 0, us: 5000, us_lo: 1e-12 }) === 5, 'display floor is exact for the real value us + us_lo (not the rounded double)');
    ok(displayOf(ANCHOR, exactOf(ecoNative({ clock: 'e', day: 1, minute: 0, resolution: 'day' })), 'day').clock_text === '—', 'a day-only value shows no clock time');
  }

  // ------------------------------------------------------------ 2. light (general astronomical method)
  {
    const almanac = (date: string, rising: boolean, zenith: number) => {
      // independent: "Almanac for Computers" (US Naval Observatory 1990) sunrise algorithm — a different, coarser method
      const R = Math.PI / 180, N = dayOfYear(date), lng = SITE.longitude_deg / 15, t = N + ((rising ? 6 : 18) - lng) / 24;
      const M = 0.9856 * t - 3.289;
      const L = (((M + 1.916 * Math.sin(M * R) + 0.02 * Math.sin(2 * M * R) + 282.634) % 360) + 360) % 360;
      let RA = (((Math.atan(0.91764 * Math.tan(L * R)) / R) % 360) + 360) % 360;
      RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
      const sinDec = 0.39782 * Math.sin(L * R), cosDec = Math.cos(Math.asin(sinDec));
      const cosH = (Math.cos(zenith * R) - sinDec * Math.sin(SITE.latitude_deg * R)) / (cosDec * Math.cos(SITE.latitude_deg * R));
      const H = (rising ? 360 - Math.acos(cosH) / R : Math.acos(cosH) / R) / 15;
      const UT = ((((H + RA - 0.06571 * t - 6.622) - lng) % 24) + 24) % 24;
      return ((UT + 8) % 24) * 60;
    };
    let maxDiff = 0, maxAlt = 0, longest = { d: '', len: 0 }, shortest = { d: '', len: 1e9 };
    for (let k = 0; k < 365; k++) {
      const date = formatDate(daysFromCivil(2027, 1, 1) + k), t = lightTimes(SITE, ANCHOR, date);
      ok(t.civil_dawn < t.sunrise && t.sunrise < t.solar_noon && t.solar_noon < t.sunset && t.sunset < t.civil_dusk, `light order on ${date}`);
      for (const [m, alt] of [[t.sunrise, SUNRISE_ALTITUDE_DEG], [t.sunset, SUNRISE_ALTITUDE_DEG], [t.civil_dawn, CIVIL_TWILIGHT_ALTITUDE_DEG], [t.civil_dusk, CIVIL_TWILIGHT_ALTITUDE_DEG]] as const) maxAlt = Math.max(maxAlt, Math.abs(solarAltitude(SITE, ANCHOR, date, m) - alt));
      for (const [m, rising, z] of [[t.sunrise, true, 90.833], [t.sunset, false, 90.833], [t.civil_dawn, true, 96], [t.civil_dusk, false, 96]] as const) maxDiff = Math.max(maxDiff, Math.abs(m - almanac(date, rising, z)));
      const len = t.sunset - t.sunrise; if (len > longest.len) longest = { d: date, len }; if (len < shortest.len) shortest = { d: date, len };
    }
    diag.altitude_error_deg = maxAlt; diag.almanac_max_diff_min = +maxDiff.toFixed(3); diag.longest_day = longest.d; diag.shortest_day = shortest.d;
    ok(maxAlt < 1e-6, `self-consistency: solar altitude at every computed transition equals its threshold (max error ${maxAlt.toExponential(1)}°)`);
    ok(maxDiff < 1, `independent almanac algorithm agrees within 1 min on every transition of 2027 (max ${maxDiff.toFixed(2)} min)`);
    ok(/^2027-06-(19|20|21|22|23)$/.test(longest.d) && /^2027-12-(19|20|21|22|23)$/.test(shortest.d), `longest day near the June solstice (${longest.d}), shortest near the December solstice (${shortest.d})`);
    const eq = lightTimes(SITE, ANCHOR, '2027-03-20'); ok(eq.sunset - eq.sunrise > 720 && eq.sunset - eq.sunrise < 735, `equinox: day slightly longer than 12 h because of refraction (${(eq.sunset - eq.sunrise).toFixed(1)} min)`);
    // representative-point sensitivity: ±0.1° in latitude or longitude
    let sens = 0;
    for (const date of ['2027-03-20', '2027-06-21', '2027-09-23', '2027-12-22']) {
      const b = lightTimes(SITE, ANCHOR, date);
      for (const [dl, dg] of [[0.1, 0], [-0.1, 0], [0, 0.1], [0, -0.1]]) { const s2 = lightTimes({ latitude_deg: SITE.latitude_deg + dl, longitude_deg: SITE.longitude_deg + dg }, ANCHOR, date); sens = Math.max(sens, Math.abs(s2.sunrise - b.sunrise), Math.abs(s2.sunset - b.sunset)); }
    }
    diag.point_sensitivity_min = +sens.toFixed(3);
    ok(sens < 0.5, `±0.1° of the representative point moves sunrise/sunset by < 0.5 min (max ${sens.toFixed(2)} min)`);
    const t = lightTimes(SITE, ANCHOR, '2027-06-21');
    ok(lightStateAt(t, 0) === 'night' && lightStateAt(t, t.civil_dawn) === 'civil_twilight' && lightStateAt(t, t.sunrise) === 'day' && lightStateAt(t, t.sunset) === 'civil_twilight' && lightStateAt(t, t.civil_dusk) === 'night', 'light state boundaries belong to the later state');
    refuses(() => lightTimes({ latitude_deg: 80, longitude_deg: 0 }, ANCHOR, '2027-06-21'), /72/, 'outside the stated accuracy range the method is refused');
  }

  // ------------------------------------------------------------ 3. provenance
  {
    const base = fixtureInputs(ANCHOR, 1, 1, () => 0)[0];
    const obs = { ...base, provenance: { ...SYN(base.date), kind: 'observation' as const, synthetic: false, assumption: false, station_id: 'C0F9X0', generator: null, rng_stream: null } };
    ok(checkDailyInput(obs) === obs, 'a well-formed observation passes');
    refuses(() => checkDailyInput({ ...obs, provenance: { ...obs.provenance, synthetic: true } }), /not synthetic/, 'an observation marked synthetic is refused');
    refuses(() => checkDailyInput({ ...obs, provenance: { ...obs.provenance, station_id: null } }), /station_id/, 'an observation without a station is refused');
    refuses(() => checkDailyInput({ ...base, provenance: { ...base.provenance, synthetic: false } }), /synthetic: true/, 'synthetic data without synthetic: true is refused');
    refuses(() => checkDailyInput({ ...base, hourly: { temp_c: Array(24).fill(20), rh_percent: Array(24).fill(70), rain_mm: Array(24).fill(0) } }), /pose as observations/, 'a synthetic hourly series cannot pose as an observation');
    refuses(() => checkDailyInput({ ...base, provenance: { ...base.provenance, kind: 'forecast', synthetic: false, generator: null } }), /issued_at/, 'a forecast needs its issue time and validity');
    refuses(() => checkDailyInput({ ...base, t_min_c: 30, t_max_c: 20, t_mean_c: 25 }), /t_min > t_max/, 't_min > t_max refused');
    refuses(() => checkDailyInput({ ...base, rain_mm: -1 }), /rain_mm/, 'negative rain refused');
    refuses(() => fromSyntheticDaily({ date: base.date, kind: 'observation', air_temp_c: 20, daily_max_air_temp_c: 25, daily_min_air_temp_c: 15, relative_humidity_model_percent: 70, rain_mm: 0 }, 'g', 's'), /not synthetic/, 'the synthetic adapter refuses a non-synthetic record');
    const unknown = { ...base, rain_mm: null };
    const run = fullRun(cfgOf({ first_day: 0, last_day: 0, rain_timing: null }), [checkDailyInput(unknown)]);
    ok(run.days[0].rain.input_nm === null && run.days[0].raining_at_close === null && run.plan.events.length === 0, 'unknown daily rain stays null: no events, raining is unknown, never 0 mm');
  }

  // ------------------------------------------------------------ 4. temperature and RH
  {
    const inputs = fixtureInputs(ANCHOR, 6, 3, () => 0);
    const nullSeries = new WeatherSeries(ANCHOR, SITE, inputs, null);
    ok([0, 300, 720, 1200].every((m) => { const v = nullSeries.temperature(2, m); return v.value === null && /null/.test(v.reason!); }), 'coefficients null → no sub-daily temperature (with the reason)');
    ok(nullSeries.relativeHumidity(2, 600).value === null, 'and no reconstructed RH either');
    for (const s of SHAPE_GRID) {
      const ser = new WeatherSeries(ANCHOR, SITE, inputs, s);
      for (let d = 1; d <= 4; d++) {
        const L = ser.light(d)!, I = ser.input(d)!, N = ser.input(d + 1)!, P = ser.input(d - 1)!;
        const T = (day: number, m: number) => ser.temperature(day, m).value!;
        const tMin = L.sunrise + 60 * s.min_lag_after_sunrise_h, tPeak = L.solar_noon + 60 * s.peak_lag_after_noon_h, eps = 1e-6;
        ok(Math.abs(T(d, tMin) - I.t_min_c!) < 1e-9 && Math.abs(T(d, tPeak) - I.t_max_c!) < 1e-9, `daily min and max reached exactly (shape ${JSON.stringify(s)}, day ${d})`);
        ok(Math.abs(T(d, tMin - eps) - T(d, tMin)) < 1e-3 && Math.abs(T(d, L.sunset - eps) - T(d, L.sunset)) < 1e-3, 'continuous at the minimum and at sunset');
        ok(Math.abs(T(d, 1440 - eps) - T(d + 1, 0)) < 1e-3, 'continuous across 24:00 (one night branch, no reset)');
        let inB = true, mono = true, prev = Infinity;
        for (let m = 0; m < 1440; m += 7) {
          const v = T(d, m), lo = Math.min(I.t_min_c!, N.t_min_c!, P.t_min_c!) - 1e-9, hi = Math.max(I.t_max_c!, P.t_max_c!) + 1e-9;
          if (!(v >= lo && v <= hi)) inB = false;
          if (m >= L.sunset) { if (v > prev + 1e-12) mono = false; prev = v; }
        }
        ok(inB, 'temperature stays within the neighbouring daily extremes');
        ok(mono, 'the night branch decreases monotonically towards the next minimum');
        for (const m of [0, 330, 720, 1080, 1439]) { const rh = ser.relativeHumidity(d, m).value!; ok(rh > 0 && rh <= 100, `RH in (0, 100] (${rh.toFixed(1)})`); }
        ok(Math.abs(ser.relativeHumidity(d, 1440 - eps).value! - ser.relativeHumidity(d + 1, 0).value!) < 1e-2, 'RH continuous across 24:00');
      }
    }
    ok(Math.abs(saturationVapourKPa(24.5) - 3.075) < 0.001, 'FAO-56 eq. 11 reproduces its worked example e°(24.5 °C) = 3.075 kPa');
    refuses(() => new WeatherSeries(ANCHOR, SITE, inputs, { peak_lag_after_noon_h: 9, night_decay_b: 2, min_lag_after_sunrise_h: 0 }), /sunset/, 'a peak after sunset is refused, not clipped');
    // observed hourly values pass through unchanged
    const hourly = fixtureInputs(ANCHOR, 3, 9, () => 0).map((x) => ({ ...x, provenance: { ...SYN(x.date), kind: 'observation' as const, synthetic: false, assumption: false, station_id: 'TEST', generator: null, rng_stream: null }, hourly: { temp_c: Array.from({ length: 24 }, (_, h) => 20 + h / 10), rh_percent: Array.from({ length: 24 }, () => 80), rain_mm: Array.from({ length: 24 }, (_, h) => (h === 3 || h === 4 ? 0.5 : 0)) } }));
    const hs = new WeatherSeries(ANCHOR, SITE, hourly, null);
    ok(hs.temperature(1, 600).value === 21 && hs.temperature(1, 600).source === 'observation_hourly', 'an observed hourly value is used as is, labelled observation');
    ok(Math.abs(hs.temperature(1, 630).value! - 21.05) < 1e-12 && hs.relativeHumidity(1, 630).value === 80 && hs.temperature(1, 1439).source === 'observation_hourly', 'between observed hours: linear interpolation, across 24:00 into the next day\'s 00:00 value');
  }

  // ------------------------------------------------------------ 5. rain conservation
  {
    ok(JSON.stringify(splitInteger(123456, [1, 1, 1])) === JSON.stringify(allocateRain(0.123456, [1, 1, 1]).parts_nm), 'integer split equals the #42 reference allocation (0.123456 mm in thirds)');
    const g = rng(5);
    for (let i = 0; i < 300; i++) { const total = Math.floor(g() * 5e8), w = Array.from({ length: 1 + Math.floor(g() * 6) }, () => 1 + Math.floor(g() * 1440)); const p = splitInteger(total, w); ok(p.reduce((a, b) => a + b, 0) === total && p.every((x, k) => Math.abs(x - (total * w[k]) / w.reduce((a, b) => a + b, 0)) < 1), 'largest remainder: exact sum, each part within 1 nm of its share'); }
    ok(splitInteger(1e9, [1e9, 3e8]).reduce((a, b) => a + b, 0) === 1e9, 'no overflow when nm totals meet nm weights');
    let crossings = 0, truncations = 0;
    for (let seed = 0; seed < 40; seed++) {
      const amounts = (d: number) => [0, 12.3, 0.123456, 0, 55.5, 0.000001, 7, 0][(d + seed) % 8];
      const inputs = fixtureInputs(ANCHOR, 8, seed, amounts);
      const plan = planRain(new WeatherSeries(ANCHOR, SITE, inputs, null), 0, 7, seed, RAIN_FIXTURE(1 + (seed % 3), 30, 900));
      for (const d of plan.days) {
        const fromEvents = plan.events.flatMap((e) => e.segments).filter((s) => s.day === d.day).reduce((a, s) => a + s.amount_nm, 0);
        ok(d.settled_nm === fromEvents && d.settled_nm === d.input_nm, `seed ${seed} day ${d.day}: events sum to the daily total exactly (${fromEvents} nm)`);
      }
      for (const e of plan.events) {
        ok(e.start_min < e.end_min && e.segments.every((s) => s.start_min < s.end_min && s.end_min <= 1440 && s.start_min >= 0), `event ${e.id} has positive length and day-bounded segments`);
        const mins = e.segments.reduce((a, s) => a + (s.day - e.day) * 0 + s.end_min - s.start_min, 0);
        ok(mins === e.end_min - e.start_min, `event ${e.id}: segment minutes = event duration (${mins})`);
        if (e.end_min > 1440) crossings++;
      }
      truncations += plan.records.filter((r) => r.kind.startsWith('truncated')).length;
    }
    diag.rain_crossings = crossings; diag.rain_truncations = truncations;
    ok(crossings > 10 && truncations > 5, `the sweep exercises midnight crossings (${crossings}) and truncations (${truncations})`);
    const noScen = planRain(new WeatherSeries(ANCHOR, SITE, fixtureInputs(ANCHOR, 3, 1, () => 4), null), 0, 2, 1, null);
    ok(noScen.events.length === 0 && noScen.days.every((d) => d.timing === 'unknown' && d.settled_nm === null && d.input_nm === 4e6), 'without a timing scenario a wet day keeps its total but gets no invented timing');
    refuses(() => planRain(new WeatherSeries(ANCHOR, SITE, fixtureInputs(ANCHOR, 2, 1, () => 1), null), 0, 1, 1, { ...RAIN_FIXTURE(1, 5, 5), assumption: false } as unknown as RainTimingScenario), /assumption: true/, 'an unlabelled timing scenario is refused');
    // hourly observations: hour-resolution events; daily/hourly mismatch is recorded, not hidden
    const hourly = fixtureInputs(ANCHOR, 2, 9, () => 1.2).map((x) => ({ ...x, provenance: { ...SYN(x.date), kind: 'observation' as const, synthetic: false, assumption: false, station_id: 'TEST', generator: null, rng_stream: null }, hourly: { temp_c: Array(24).fill(20), rh_percent: Array(24).fill(80), rain_mm: Array.from({ length: 24 }, (_, h) => (h === 3 || h === 4 ? 0.5 : h === 23 ? 0.1 : 0)) } }));
    const hp = planRain(new WeatherSeries(ANCHOR, SITE, hourly, null), 0, 1, 1, null);
    ok(hp.events.length === 4 && hp.events.every((e) => e.resolution === 'hour' && !e.synthetic && e.start_min % 60 === 0), 'hourly observations give hour-resolution, non-synthetic events');
    ok(hp.records.filter((r) => r.kind === 'daily_hourly_mismatch').length === 2 && hp.days.every((d) => d.settled_nm === 1.1e6), 'daily 1.2 mm vs hourly 1.1 mm: recorded as a mismatch, settlement follows the events');
  }

  // ------------------------------------------------------------ 6. the run
  for (const order of ['tick', 'layered'] as TimeOrder[]) {
    const inputs = fixtureInputs(ANCHOR, 7, 21, (d) => [0, 30, 4, 0, 18, 0, 2][d]);
    const cfg = cfgOf({ order, first_day: 1, last_day: 5, rain_timing: RAIN_FIXTURE(2, 60, 900) });
    const r = fullRun(cfg, inputs);
    const a = r.scheduler.audit();
    ok(a.pending === 0 && a.cancelled === 0 && a.executed === a.total && a.logged === a.total, `${order}: every event executed exactly once (${a.total})`);
    verifyLog(r.scheduler.log, [], { order }); ok(true, `${order}: independent log check`);
    const tr = r.scheduler.timeReport(); ok(tr.merges.length === 0 && tr.inversions.length === 0, `${order}: no tick merges or inversions among environment events`);
    let mono = true; const L = r.scheduler.log; for (let i = 1; i < L.length; i++) if (compareExact(L[i].exact, L[i - 1].exact) < 0 || compareTime(L[i].at, L[i - 1].at) < 0) mono = false;
    ok(mono, `${order}: the clock is monotone in exact time and in world label`);
    const light = L.filter((l) => l.kind.startsWith('light_')).map((l) => l.kind.replace('light_', ''));
    ok(light.join() === Array(5).fill('civil_dawn,sunrise,sunset,civil_dusk').join(), `${order}: light cycle in order every day`);
    ok(r.days.every((d) => d.light_at_close === 'night' && d.rain.conserved === true), `${order}: every day closes at night with rain conserved`);
    ok(r.days.some((d) => d.raining_at_close === true), `${order}: a rain event runs across midnight (raining at a day close)`);
    // nothing resets at 24:00: rain active at a close is still active at the next day's 00:00 and ends later
    const wetClose = r.days.find((d) => d.raining_at_close)!;
    const ends = L.filter((l) => l.kind === 'rain_end' && l.exact.day === wetClose.day + 1);
    ok(ends.length > 0 && ends.every((l) => r.scheduler.get(l.id)!.native.anchor.day <= wetClose.day), `${order}: the crossing event ends on day ${wetClose.day + 1}, as one event started on its own day`);
    ok(r.days.every((d) => d.executed_by_kind.weather_sample === 24), `${order}: 24 hourly samples per day`);
    // snapshot / restore mid-day equals the continuous run (at 13:37, at 00:00, and inside a rain event)
    const rainMid = r.plan.events.find((e) => e.end_min - e.start_min > 2)!;
    for (const cut of [{ day: 2, minute: 817 }, { day: 3, minute: 0 }, { day: rainMid.day, minute: rainMid.start_min + 1 }]) {
      const p1 = new ClockRun(cfg, inputs);
      for (let d = cfg.first_day; d < cut.day; d++) p1.closeDay(d);
      p1.runUntil(cut);
      const snap = JSON.parse(JSON.stringify(p1.snapshot()));
      const p2 = new ClockRun(cfg, inputs, snap);
      for (let d = cut.day; d <= cfg.last_day; d++) p2.closeDay(d);
      const joined = JSON.stringify([...p1.scheduler.log, ...p2.scheduler.log].map((l) => [l.id, l.exact, l.round, l.state]));
      ok(joined === logKey(r) && JSON.stringify(p2.days) === JSON.stringify(r.days) && JSON.stringify(p2.state) === JSON.stringify(r.state), `${order}: snapshot at d${cut.day}+${cut.minute}min and restore = continuous run`);
    }
    refuses(() => new ClockRun({ ...cfg, order: order === 'tick' ? 'layered' : 'tick' }, inputs, r.snapshot()), /another world or time contract/, `${order}: a snapshot cannot be restored under the other contract`);
    // permutation of the input order: identical log
    for (let k = 0; k < 5; k++) {
      const p = new ClockRun(cfg, inputs), specs = environmentSpecs(cfg, p.series, p.plan), gk = rng(100 + k);
      for (let i = specs.length - 1; i > 0; i--) { const j = Math.floor(gk() * (i + 1)); [specs[i], specs[j]] = [specs[j], specs[i]]; }
      p.scheduler = new WorldScheduler(cfg.world, { day: cfg.first_day, minute: 0 }, { order });
      for (const s of specs) p.scheduler.schedule(s);
      for (let d = cfg.first_day; d <= cfg.last_day; d++) p.closeDay(d);
      ok(logKey(p) === logKey(r) && JSON.stringify(p.days) === JSON.stringify(r.days), `${order}: shuffled scheduling order ${k} gives the identical log and day records`);
    }
    // seed invariance: light and weather samples do not depend on the seed; rain timing does, its totals do not
    const r2 = fullRun({ ...cfg, seed: 8 }, inputs);
    const envPart = (x: ClockRun) => JSON.stringify(x.scheduler.log.filter((l) => !l.kind.startsWith('rain')).map((l) => [l.id, l.exact]));
    ok(envPart(r2) === envPart(r), `${order}: light and weather samples are seed-invariant`);
    ok(JSON.stringify(r2.plan.events.map((e) => e.start_min)) !== JSON.stringify(r.plan.events.map((e) => e.start_min)) && r2.days.every((d, i) => d.rain.from_events_nm === r.days[i].rain.from_events_nm), `${order}: another seed moves the synthetic rain but not the daily totals`);
    ok(logKey(fullRun(cfg, inputs)) === logKey(r), `${order}: replay is identical`);
    // four frames on one scheduler: physics seconds (anchored before midnight) interleave with ecological minutes by exact time
    const q = new ClockRun(cfg, inputs); const seen: Readonly<WorldEvent>[] = []; q.other = (e) => { seen.push(e); };
    const g = rng(77), phys: number[] = [];
    for (let i = 0; i < 200; i++) phys.push(Math.round(g() * 7200 * 1000) / 1000 + 0.0005);
    phys.forEach((t, i) => q.scheduler.schedule({ kind: 'physics_probe', key: `p${i}`, native: physicsNative('ph.test', { day: 2, minute: 1380 }, t), scope: { world: cfg.world, colony: null, individual: null }, source: null, target: null }));
    for (let d = cfg.first_day; d <= cfg.last_day; d++) q.closeDay(d);
    const QL = q.scheduler.log; let ordered = true, disp = true;
    for (let i = 1; i < QL.length; i++) {
      if (compareExact(QL[i].exact, QL[i - 1].exact) < 0) ordered = false;
      if (displayOf(ANCHOR, QL[i].exact, 'exact').key_ms < displayOf(ANCHOR, QL[i - 1].exact, 'exact').key_ms) disp = false;
      const lab = labelOf(QL[i].exact, order); if (compareTime(lab, QL[i].at) !== 0) ordered = false;
    }
    ok(seen.length === 200 && ordered && disp, `${order}: physics seconds across 24:00 and ecological minutes share one exact order; display and labels never reverse it`);
    ok(q.scheduler.timeReport().merges.length === 0 && q.scheduler.timeReport().inversions.length === 0, `${order}: no quantisation merge or inversion (events ≥ 0.5 ms apart)`);
    ok(JSON.stringify(q.days.map((d) => d.rain)) === JSON.stringify(r.days.map((d) => d.rain)), `${order}: foreign events do not change the environment settlement`);
  }
  refuses(() => new ClockRun({ ...cfgOf(), official: true as unknown as false }, fixtureInputs(ANCHOR, 6, 1, () => 0)), /non-official/, 'the clock refuses to run as the official world');
  refuses(() => { const r = new ClockRun(cfgOf(), fixtureInputs(ANCHOR, 6, 1, () => 0)); r.closeDay(2); }, /still pending|days must be run in order/, 'days close in order (day 1 cannot be skipped)');
  {
    const r = new ClockRun(cfgOf(), fixtureInputs(ANCHOR, 6, 1, () => 0)); r.closeDay(1);
    refuses(() => r.closeDay(1), /already closed/, 'a closed day cannot be closed (re-run) again');
  }

  // ------------------------------------------------------------ 7. Day0 experiment world (synthetic climatology)
  for (const season of ['spring', 'summer', 'autumn', 'winter'] as const) for (const seed of [1, 2]) {
    const { start, inputs } = day0DailyWeather(season, seed, 6);
    ok(inputs.every((i) => i.provenance.synthetic === true && i.provenance.kind === 'synthetic_climatology'), `${season}/${seed}: Day0 world weather is labelled synthetic`);
    for (const shape of [null, SHAPE_GRID[4]]) {
      const r = new ClockRun(day0Config(start, seed, 1, 5, 'tick', shape, RAIN_FIXTURE(2, 30, 600)), inputs);
      for (let d = 1; d <= 5; d++) r.closeDay(d);
      ok(r.days.every((d) => d.rain.conserved === true) && r.scheduler.audit().pending === 0, `${season}/${seed}/${shape ? 'shape' : 'null'}: rain conserved, all events executed`);
      ok(r.scheduler.log.filter((l) => l.kind === 'weather_sample').every((l) => { const p = r.scheduler.get(l.id)!.payload as Record<string, unknown>; return p.synthetic === true && (shape ? typeof p.temp_c === 'number' || (l.at.day === 1 && /previous and next day/.test(p.temp_reason as string)) : p.temp_c === null); }), 'every sample carries synthetic: true; temperature only with a shape scenario (null before the first sunrise: no previous-day input, with the reason)');
    }
  }
  ok(SCENARIO.official === false && SCENARIO.temperature_shape.value === null && SCENARIO.rain_timing.value === null, 'the scenario file keeps unknown coefficients null and is non-official');

  for (const [f, h] of guarded) ok(sha(path.join(REPO_ROOT, f)) === h, `${f} untouched`);
  ok(fs.readdirSync(path.join(REPO_ROOT, 'journal')).sort().join() === journalBefore, 'journal/ untouched');
} catch (e) {
  if (e instanceof ClockError) console.error('CLOCK ERROR', e.message);
  throw e;
}
console.log(JSON.stringify({ test: 'p0a1-24h-clock', checks, ...diag }));
