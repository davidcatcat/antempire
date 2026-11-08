/**
 * P0-A1 — astronomical light state for a fixed representative point (docs/p0a1-24h-clock.md §3).
 *
 * GENERAL METHOD, not a biological parameter: the NOAA Global Monitoring Laboratory solar-calculator equations (based
 * on Meeus, Astronomical Algorithms; R390). NOAA states sunrise/sunset are "theoretically accurate to within a minute"
 * between ±72° latitude; observed times vary with atmospheric conditions. Sunrise / sunset use a solar altitude of
 * −0.833° (standard refraction + solar semi-diameter), civil twilight −6°. Refraction near the horizon, terrain and
 * buildings of the (fictional) garden are NOT modelled.
 *
 * The event times are found by iterating the hour-angle equation with the solar position evaluated AT the event
 * (not at noon), so the altitude at the returned instant equals the threshold to < 1e-6° (tested); the remaining error
 * is the model's own (~1 min). Pure functions: no colony, no random draw, no clock.
 */
import { type CalendarAnchor, clockFail, julianDayOf, parseDate } from './time-frames.ts';

const RAD = Math.PI / 180, DEG = 180 / Math.PI;
const mod360 = (x: number) => ((x % 360) + 360) % 360;

export interface SolarSite { latitude_deg: number; longitude_deg: number }
export function checkSite(s: SolarSite): SolarSite {
  if (!s || !(Math.abs(s.latitude_deg) <= 72) || !(Math.abs(s.longitude_deg) <= 180)) clockFail('site latitude must be within ±72° (NOAA accuracy range) and longitude within ±180°');
  return { latitude_deg: s.latitude_deg, longitude_deg: s.longitude_deg };
}

/** solar declination (deg) and equation of time (min) at Julian Date jd (NOAA spreadsheet equations) */
export function solarPosition(jd: number): { declination_deg: number; equation_of_time_min: number } {
  const T = (jd - 2451545) / 36525;
  const L0 = mod360(280.46646 + T * (36000.76983 + T * 0.0003032));
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T) + Math.sin(3 * M * RAD) * 0.000289;
  const omega = 125.04 - 1934.136 * T;
  const lambda = L0 + C - 0.00569 - 0.00478 * Math.sin(omega * RAD);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eot = 4 * DEG * (y * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD) - 0.5 * y * y * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
  return { declination_deg: decl, equation_of_time_min: eot };
}

/** geometric solar altitude (deg, no refraction) at `minute` minutes after local 00:00 of `date` */
export function solarAltitude(site: SolarSite, a: CalendarAnchor, date: string, minute: number): number {
  const day = parseDate(date) - parseDate(a.day0_date);
  const jd = julianDayOf(a, { day, us: minute * 60_000_000, us_lo: 0 });
  const { declination_deg: d, equation_of_time_min: eot } = solarPosition(jd);
  const tst = minute + eot + 4 * site.longitude_deg - a.utc_offset_minutes; // true solar time (min)
  const ha = tst / 4 - 180;
  const phi = site.latitude_deg * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(d * RAD) + Math.cos(phi) * Math.cos(d * RAD) * Math.cos(ha * RAD)) * DEG;
}

/** local minute (may be < 0 or >= 1440 near the date line; not for Taichung) at which the sun crosses `altitude_deg`,
 *  rising or setting, on `date`; null if it never does (cannot happen within ±72° for the thresholds used here) */
export function crossingMinute(site: SolarSite, a: CalendarAnchor, date: string, altitude_deg: number, rising: boolean): number | null {
  const s = checkSite(site), day = parseDate(date) - parseDate(a.day0_date), phi = s.latitude_deg * RAD;
  let m = 720; // first guess: local noon
  for (let i = 0; i < 6; i++) {
    const { declination_deg: d, equation_of_time_min: eot } = solarPosition(julianDayOf(a, { day, us: m * 60_000_000, us_lo: 0 }));
    const cosH = (Math.sin(altitude_deg * RAD) - Math.sin(phi) * Math.sin(d * RAD)) / (Math.cos(phi) * Math.cos(d * RAD));
    if (!(cosH >= -1 && cosH <= 1)) return null;
    const H = Math.acos(cosH) * DEG, noon = 720 - 4 * s.longitude_deg - eot + a.utc_offset_minutes;
    m = noon + (rising ? -4 * H : 4 * H);
  }
  return m;
}

/** the four light transitions of a civil date, local minutes (computed, general method; see header for accuracy) */
export interface LightTimes { date: string; civil_dawn: number; sunrise: number; solar_noon: number; sunset: number; civil_dusk: number }
export const SUNRISE_ALTITUDE_DEG = -0.833, CIVIL_TWILIGHT_ALTITUDE_DEG = -6;
export function lightTimes(site: SolarSite, a: CalendarAnchor, date: string): LightTimes {
  const day = parseDate(date) - parseDate(a.day0_date);
  const f = (alt: number, rising: boolean) => { const m = crossingMinute(site, a, date, alt, rising); if (m === null) return clockFail(`no ${rising ? 'rising' : 'setting'} crossing of ${alt}° on ${date}`); return m; };
  const { equation_of_time_min: eot } = solarPosition(julianDayOf(a, { day, us: 720 * 60_000_000, us_lo: 0 }));
  const t: LightTimes = { date, civil_dawn: f(CIVIL_TWILIGHT_ALTITUDE_DEG, true), sunrise: f(SUNRISE_ALTITUDE_DEG, true), solar_noon: 720 - 4 * site.longitude_deg - eot + a.utc_offset_minutes, sunset: f(SUNRISE_ALTITUDE_DEG, false), civil_dusk: f(CIVIL_TWILIGHT_ALTITUDE_DEG, false) };
  if (!(0 <= t.civil_dawn && t.civil_dawn < t.sunrise && t.sunrise < t.solar_noon && t.solar_noon < t.sunset && t.sunset < t.civil_dusk && t.civil_dusk < 1440)) clockFail(`light times of ${date} are not ordered inside one civil day`);
  return t;
}

export type LightState = 'night' | 'civil_twilight' | 'day';
/** the light state at local minute m of a date (by the computed transitions; boundaries belong to the later state) */
export function lightStateAt(t: LightTimes, m: number): LightState {
  if (m < t.civil_dawn || m >= t.civil_dusk) return 'night';
  if (m < t.sunrise || m >= t.sunset) return 'civil_twilight';
  return 'day';
}
