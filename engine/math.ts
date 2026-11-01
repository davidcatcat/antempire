/** Numeric helpers shared by all engine modules. Pure; no platform APIs. */

/** Save precision: 6 decimal places. Must equal world param model.unit_precision (validated in params.ts). */
export const UNIT_DECIMALS = 6;

/** Round to 6 decimals exactly as the v6 engine did: Math.round((x+EPSILON)*1e6)/1e6. */
export const round = (x: number): number => Math.round((x + Number.EPSILON) * 1e6) / 1e6;

/** clamp(x,a,b) = Math.min(b, Math.max(a, x)) — operand order preserved from v6. */
export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

export const clone = <T>(x: T): T => structuredClone(x);

/** Days in month m (1–12) of year y, proleptic Gregorian, UTC. */
export function monthDays(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Calendar date (YYYY-MM-DD) one day after `isoDate`. */
export function nextDate(isoDate: string): string {
  const date = new Date(isoDate + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}
