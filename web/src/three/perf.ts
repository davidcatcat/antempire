/**
 * Three.js 3D prototype — frame statistics (pure). Measures the PAGE only; it never runs or changes the simulation.
 * Software rendering (SwiftShader, llvmpipe, …) or automation is flagged: such numbers are NOT device results.
 */
export interface PerfSummary {
  frames: number; seconds: number; fps_mean: number; fps_p5_low: number;
  frame_ms: { p50: number; p95: number; p99: number; max: number };
  cpu_ms: { p50: number; p95: number };
}
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const r2 = (v: number) => Math.round(v * 100) / 100;
/** frame intervals (ms, rAF to rAF) and per-frame CPU time of the page's own work (ms) */
export function summarise(intervals: readonly number[], cpu: readonly number[]): PerfSummary {
  const s = [...intervals].sort((a, b) => a - b), c = [...cpu].sort((a, b) => a - b), total = intervals.reduce((a, b) => a + b, 0);
  return {
    frames: intervals.length, seconds: r2(total / 1000), fps_mean: total > 0 ? r2((intervals.length * 1000) / total) : 0,
    fps_p5_low: s.length ? r2(1000 / quantile(s, 0.95)) : 0,
    frame_ms: { p50: r2(quantile(s, 0.5)), p95: r2(quantile(s, 0.95)), p99: r2(quantile(s, 0.99)), max: r2(s[s.length - 1] ?? NaN) },
    cpu_ms: { p50: r2(quantile(c, 0.5)), p95: r2(quantile(c, 0.95)) },
  };
}
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render|lavapipe/i;
/** "device" only when a hardware GPU renderer is reported and the page is not automated */
export function measurementClass(renderer: string | null, automated: boolean): 'device' | 'NOT a device result' {
  return !renderer || SOFTWARE.test(renderer) || automated ? 'NOT a device result' : 'device';
}
/** benchmark sizes required by the Owner (2026-11-14) and the number of independent 30-worker worlds each needs */
export const BENCH_SIZES = [30, 100, 1000] as const;
export const worldsFor = (n: number, perWorld = 30) => Math.max(1, Math.ceil(n / perWorld));
