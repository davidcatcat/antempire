/**
 * P0-A1 — the 24-hour EVENT-TIME CONTRACT: four time frames and the conversions between them (docs/p0a1-24h-clock.md).
 *
 * Status: ISOLATED (tests/clock-isolation.test.ts). Not imported by the official day loop, cli/ or web/src; not in the
 * rules fingerprint. No behaviour, no species parameter, no random draw.
 *
 * The four frames
 *  1. WORLD time      (day, minute) of engine/scheduler/world-events.ts. Day k is the civil date `day0_date + k` in the
 *                     world's civil zone (Asia/Taipei, UTC+08:00, no daylight saving); minute 0 is local 00:00.
 *                     Nothing resets at 24:00: a day is a label of the continuous world clock.
 *  2. ECOLOGICAL time an environment / ecology producer's native time: minutes on a named clock anchored at 00:00 of a
 *                     world day, plus the RESOLUTION the source really has (day / hour / minute / second / exact).
 *  3. PHYSICS time    native seconds on a named physics clock anchored at a world instant (#117 NativeTime, unit 's').
 *  4. DISPLAY time    what a viewer may print: the civil date and the local clock TRUNCATED to the event's resolution,
 *                     plus the interval the event may lie in. Display is derived only; it is never an input.
 * Every conversion into the scheduler goes through #117's exactOf() (error-free); ordering is decided by the scheduler's
 * contract ('tick' or 'layered', a parameter — the choice is the Owner's). Display truncation is a floor of the exact
 * value, hence monotone: it can merge two instants into one printed time but can never reverse their order.
 */
import { type ExactTime, type NativeTime, type TimeOrder, type WorldTime, checkNative, checkTime, exactOf, MINUTES_PER_DAY, US_PER_DAY } from '../scheduler/world-events.ts';

export class ClockError extends Error { constructor(msg: string) { super(`CLOCK: ${msg}`); this.name = 'ClockError'; } }
export const clockFail = (msg: string): never => { throw new ClockError(msg); };

export type TimeFrame = 'world' | 'ecological' | 'physics' | 'display';
/** what a source really resolves: a value known only per day must never be drawn at a minute (AGENT-RULES, §8) */
export type Resolution = 'day' | 'hour' | 'minute' | 'second' | 'exact';
export const RESOLUTIONS: readonly Resolution[] = ['day', 'hour', 'minute', 'second', 'exact'];
/** the scheduler contract is a parameter of every clock run; 'tick' is the scheduler default (#116), 'layered' is the
 *  #117 recommendation and is NOT adopted here (Owner decision pending) */
export const DEFAULT_ORDER: TimeOrder = 'tick';

// ------------------------------------------------------------------ civil calendar (pure integer arithmetic, no Date)
/** days since 1970-01-01 of a proleptic Gregorian date (H. Hinnant's days_from_civil; exact for all safe integers) */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = y - (m <= 2 ? 1 : 0), era = Math.floor(yy / 400), yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
export function civilFromDays(z: number): { y: number; m: number; d: number } {
  const zz = z + 719468, era = Math.floor(zz / 146097), doe = zz - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
export function parseDate(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return clockFail(`date ${date} is not YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], z = daysFromCivil(y, mo, d), back = civilFromDays(z);
  if (back.y !== y || back.m !== mo || back.d !== d) clockFail(`date ${date} does not exist`);
  return z;
}
export const formatDate = (z: number) => { const c = civilFromDays(z); return `${pad(c.y, 4)}-${pad(c.m)}-${pad(c.d)}`; };

/** maps world days to civil dates: world day 0 = day0_date; the world minute IS local civil time in this zone */
export interface CalendarAnchor { day0_date: string; utc_offset_minutes: number; zone: string }
export function checkAnchor(a: CalendarAnchor): CalendarAnchor {
  if (!a || typeof a !== 'object') clockFail('calendar anchor missing');
  parseDate(a.day0_date);
  if (!Number.isInteger(a.utc_offset_minutes) || Math.abs(a.utc_offset_minutes) > 14 * 60) clockFail('utc_offset_minutes must be an integer within ±14 h');
  if (typeof a.zone !== 'string' || !a.zone) clockFail('zone label required');
  return { day0_date: a.day0_date, utc_offset_minutes: a.utc_offset_minutes, zone: a.zone };
}
export const dateOfDay = (a: CalendarAnchor, day: number): string => { if (!Number.isSafeInteger(day)) clockFail('day must be an integer'); return formatDate(parseDate(a.day0_date) + day); };
export const dayOfDate = (a: CalendarAnchor, date: string): number => parseDate(date) - parseDate(a.day0_date);
/** day of year 1..366 */
export const dayOfYear = (date: string): number => { const z = parseDate(date), y = civilFromDays(z).y; return z - daysFromCivil(y, 1, 1) + 1; };

/**
 * Julian Date (UT) of an exact world instant, split as an integer-ish day count + fraction to keep precision.
 * Bound: the returned double carries ~1e-10 day (~10 µs) rounding — far below the astronomical model accuracy (~1 min).
 */
export function julianDayOf(a: CalendarAnchor, x: ExactTime): number {
  const z = parseDate(a.day0_date) + x.day; // civil midnight (local) of the event's world day
  return (z + 2440587.5 - 2451545) + ((x.us + x.us_lo) / US_PER_DAY - a.utc_offset_minutes / MINUTES_PER_DAY) + 2451545;
}

// ------------------------------------------------------------------ ecological and physics native times
/** an ecological producer's time: `minute` minutes after 00:00 of world day `day` on clock `clock` (minute may exceed
 *  1440: the instant then lies on a later day, exactly — no reset at 24:00) */
export interface EcoTime { clock: string; day: number; minute: number; resolution: Resolution }
export function ecoNative(e: EcoTime): NativeTime {
  if (!RESOLUTIONS.includes(e.resolution)) clockFail(`unknown resolution ${e.resolution}`);
  if (e.resolution === 'day' && e.minute !== 0) clockFail('a day-resolution time must sit at 00:00 of its day');
  if (e.resolution === 'hour' && !(Number.isInteger(e.minute) && e.minute % 60 === 0)) clockFail(`hour-resolution time at minute ${e.minute} is not on an hour`);
  if (e.resolution === 'minute' && !Number.isInteger(e.minute)) clockFail(`minute-resolution time ${e.minute} is not a whole minute`);
  return checkNative({ clock: e.clock, unit: 'min', anchor: { day: e.day, minute: 0 }, t: e.minute }, `eco ${e.clock}`);
}
/** a physics producer's time: `seconds` after `anchor` (a world instant on the tick grid) on clock `clock` */
export function physicsNative(clock: string, anchor: WorldTime, seconds: number): NativeTime {
  return checkNative({ clock, unit: 's', anchor: checkTime(anchor), t: seconds }, `physics ${clock}`);
}

// ------------------------------------------------------------------ display time (derived, viewer only)
const MS_PER_DAY = 86_400_000;
/** floor(exact / 1000 µs) for an exact instant: correct for the real value us + us_lo (not its double sum) */
export function msFloor(x: ExactTime): number {
  const q0 = Math.floor(x.us / 1000), r = x.us - q0 * 1000; // r exact (q0*1000 is near x.us)
  if (r === 0 && x.us_lo < 0) return q0 - 1;
  return q0;
}
export interface DisplayTime {
  frame: 'display'; date: string; day: number;
  /** local clock text truncated to the resolution ('—' for a day-only value: no clock time may be shown) */
  clock_text: string; resolution: Resolution;
  /** [from, to) in ms since local 00:00 of `day` within which the true instant lies, as far as the source resolves it */
  interval_ms: [number, number];
  /** sort key: ms since 00:00 of day 0 (floor); non-decreasing in the exact instant */
  key_ms: number;
}
const RES_MS: Record<Resolution, number> = { day: MS_PER_DAY, hour: 3_600_000, minute: 60_000, second: 1000, exact: 1 };
export function displayOf(a: CalendarAnchor, x: ExactTime, resolution: Resolution): DisplayTime {
  if (!RESOLUTIONS.includes(resolution)) clockFail(`unknown resolution ${resolution}`);
  const ms = msFloor(x), step = RES_MS[resolution], from = Math.floor(ms / step) * step;
  const h = Math.floor(from / 3_600_000), mi = Math.floor((from % 3_600_000) / 60_000), s = Math.floor((from % 60_000) / 1000), mss = from % 1000;
  const clock_text = resolution === 'day' ? '—' : resolution === 'hour' ? `${pad(h)}時` : resolution === 'minute' ? `${pad(h)}:${pad(mi)}` : resolution === 'second' ? `${pad(h)}:${pad(mi)}:${pad(s)}` : `${pad(h)}:${pad(mi)}:${pad(s)}.${pad(mss, 3)}`;
  return { frame: 'display', date: dateOfDay(a, x.day), day: x.day, clock_text, resolution, interval_ms: [from, Math.min(MS_PER_DAY, from + step)], key_ms: x.day * MS_PER_DAY + ms };
}
/** convenience: native → exact → display */
export const displayOfNative = (a: CalendarAnchor, n: NativeTime, resolution: Resolution): DisplayTime => displayOf(a, exactOf(n), resolution);
