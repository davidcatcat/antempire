/**
 * Reference implementation for the P0-A rain-event design (docs/research-design-p0a-24h-clock.md §7.3). NOT engine
 * code: it fixes the arithmetic the future engine must follow, and tests/p0a-rain-allocation.test.ts checks it.
 *
 * Units (corrected 2026-11-03): the internal integer unit is 10⁻⁶ mm = 1 nm (NOT 1 µm; 1 µm = 10⁻³ mm). A daily
 * rainfall D (mm) stored with six decimals is exactly D_nm = round(D × 10⁶) integer nanometres. Event shares are
 * allocated with the largest-remainder method so that the integer parts sum EXACTLY to D_nm. If D carries more
 * precision than 10⁻⁶ mm, the difference is reported as rounding_residual_nm (never silently dropped).
 */
export const NM_PER_MM = 1_000_000; // 10⁻⁶ mm = 1 nm

export interface Allocation { total_nm: number; parts_nm: number[]; rounding_residual_nm: number }

/** Split daily rain D (mm) into events with the given non-negative weights (largest-remainder method). */
export function allocateRain(dailyMm: number, weights: number[]): Allocation {
  if (!(dailyMm >= 0) || !weights.length || weights.some((w) => !(w >= 0)) || weights.every((w) => w === 0)) throw new RangeError('allocateRain: need D >= 0 and non-negative weights with a positive sum');
  const exact = dailyMm * NM_PER_MM, total = Math.round(exact), residual = exact - total;
  const sum = weights.reduce((a, b) => a + b, 0), raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map(Math.floor);
  let left = total - parts.reduce((a, b) => a + b, 0);
  // hand out the remaining units to the largest fractional parts; ties by lower index (deterministic)
  const order = raw.map((r, i) => ({ i, f: r - Math.floor(r) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; parts[i]++; left--; }
  return { total_nm: total, parts_nm: parts, rounding_residual_nm: Math.round(residual * 1000) / 1000 };
}

/** An event running past midnight: the part after 00:00 belongs to the next day's budget. Minutes are clock minutes. */
export function splitAtMidnight(startMin: number, endMin: number, amountNm: number): { today_nm: number; next_day_nm: number } {
  if (endMin <= 1440) return { today_nm: amountNm, next_day_nm: 0 };
  const today = Math.floor((amountNm * (1440 - startMin)) / (endMin - startMin));
  return { today_nm: today, next_day_nm: amountNm - today };
}
