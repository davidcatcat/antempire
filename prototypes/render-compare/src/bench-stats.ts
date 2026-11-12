/**
 * Pure parts of the device bench (Owner decisions 49 / 50): statistics, drift, the measurement matrix, the dynamic-DPR
 * controller, software-renderer detection and the report schema. No DOM, no timers: Node tests import this file
 * (tests/device-bench.test.ts). Drawing / measurement code lives in device-bench.ts.
 *
 * Definitions (fixed, so reports from different devices compare):
 *  - percentile: nearest rank, p in [0, 1]: sorted[ceil(p·n) − 1] (p = 0 → minimum); null for no samples
 *  - fps_mean = 1000 / mean frame interval (= frames / wall time over the window)
 *  - low-percentile fps: fps_p1_low = 1000 / p99 frame interval, fps_p5_low = 1000 / p95 frame interval
 *  - busy_ratio = Σ JS time spent in our frame callback / wall time (a main-thread CPU proxy, not process CPU)
 *  - longtask_ratio = Σ long-task duration (PerformanceObserver 'longtask', ≥ 50 ms tasks) / wall time
 *  - drift: least-squares slope of the per-window fps (fps per minute) and heap (MB per minute) against time
 */

export const REPORT_SCHEMA = 'antempire.device-bench.v1';
export const RENDERERS = ['A', 'B', 'C'] as const;
export const COUNTS = [100, 1000, 5000] as const;
export const DPRS = ['device', '1'] as const;
export const SPEEDS = ['1x', 'fast'] as const;
/** fast-forward = the synthetic animation advances this many fixed steps of time per drawn frame (示範 time) */
export const FAST_FACTOR = 10;
export type RendererId = typeof RENDERERS[number];
export type BenchMode = 'quick' | 'full';
export interface Cell { renderer: RendererId; n: number; dpr: typeof DPRS[number]; speed: typeof SPEEDS[number] }
export interface Timing { warmS: number; measureS: number; breakdownS: number; stabilityS: number; stabilityWindowS: number }

export const TIMING: Record<BenchMode, Timing> = {
  quick: { warmS: 0.5, measureS: 2, breakdownS: 2, stabilityS: 20, stabilityWindowS: 5 },
  full: { warmS: 1.5, measureS: 6, breakdownS: 6, stabilityS: 300, stabilityWindowS: 10 },
};

/** The full matrix renderer × n × DPR × speed (36 cells), in a fixed order; renderers interleaved innermost so a slow
 *  drift of the device (heat, battery saver) hits A, B and C alike. */
export function buildMatrix(): Cell[] {
  const out: Cell[] = [];
  for (const n of COUNTS) for (const dpr of DPRS) for (const speed of SPEEDS) for (const renderer of RENDERERS) out.push({ renderer, n, dpr, speed });
  return out;
}

/** mitigation configurations of the game-view breakdown (presentation only: the same ants and events are drawn) */
export interface Toggles { cacheStatic: boolean; cull: boolean; decorLod1: boolean; dynamicDpr: boolean; atlas: boolean }
export const NO_TOGGLES: Toggles = { cacheStatic: false, cull: false, decorLod1: false, dynamicDpr: false, atlas: false };
export const BREAKDOWN_CONFIGS: { id: string; label: string; toggles: Toggles }[] = [
  { id: 'baseline', label: '基準（目前遊戲畫面設定）', toggles: { ...NO_TOGGLES } },
  { id: 'cacheStatic', label: '地面／裝飾預先合成（chunk 預烘焙成整幅）', toggles: { ...NO_TOGGLES, cacheStatic: true } },
  { id: 'cull', label: '只畫可見範圍的螞蟻（剔除畫面外）', toggles: { ...NO_TOGGLES, cull: true } },
  { id: 'decorLod1', label: '裝飾 LOD（省略最小的落葉碎屑）', toggles: { ...NO_TOGGLES, decorLod1: true } },
  { id: 'dynamicDpr', label: '動態解析度（DPR 隨幀時間調整）', toggles: { ...NO_TOGGLES, dynamicDpr: true } },
  { id: 'atlas', label: '預旋轉圖集（批次貼圖）', toggles: { ...NO_TOGGLES, atlas: true } },
  { id: 'all', label: '全部開啟', toggles: { cacheStatic: true, cull: true, decorLod1: true, dynamicDpr: true, atlas: true } },
];

export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), k = Math.ceil(Math.min(1, Math.max(0, p)) * s.length) - 1;
  return s[Math.max(0, k)];
}
export const mean = (v: readonly number[]): number | null => (v.length ? v.reduce((s, x) => s + x, 0) / v.length : null);
const r2 = (x: number | null, d = 2) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

export interface FrameSummary {
  frames: number; wall_ms: number; fps_mean: number | null; fps_p1_low: number | null; fps_p5_low: number | null;
  frame_ms: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  cpu: { js_ms_mean: number | null; js_ms_p95: number | null; busy_ratio: number | null; longtask_supported: boolean; longtask_count: number; longtask_ms: number; longtask_ratio: number | null };
}
/** intervals = rAF-to-rAF frame intervals (ms); jsMs = time inside our frame callback per frame (ms); wallMs = window
 *  length; longTasks = durations (ms) of long tasks observed in the window (null = API not supported) */
export function summarizeFrames(intervals: readonly number[], jsMs: readonly number[], wallMs: number, longTasks: readonly number[] | null): FrameSummary {
  const m = mean(intervals), p95 = percentile(intervals, 0.95), p99 = percentile(intervals, 0.99), lt = longTasks ?? [];
  const ltMs = lt.reduce((s, x) => s + x, 0), js = jsMs.reduce((s, x) => s + x, 0);
  return {
    frames: intervals.length, wall_ms: r2(wallMs, 1) ?? 0,
    fps_mean: m ? r2(1000 / m) : null, fps_p1_low: p99 ? r2(1000 / p99) : null, fps_p5_low: p95 ? r2(1000 / p95) : null,
    frame_ms: { p50: r2(percentile(intervals, 0.5)), p95: r2(p95), p99: r2(p99), max: r2(intervals.length ? Math.max(...intervals) : null) },
    cpu: { js_ms_mean: r2(mean(jsMs), 3), js_ms_p95: r2(percentile(jsMs, 0.95), 3), busy_ratio: wallMs > 0 ? r2(js / wallMs, 4) : null, longtask_supported: longTasks !== null, longtask_count: lt.length, longtask_ms: r2(ltMs, 1) ?? 0, longtask_ratio: longTasks !== null && wallMs > 0 ? r2(ltMs / wallMs, 4) : null },
  };
}

/** least-squares slope dy/dx; null for < 2 distinct x */
export function slope(xs: readonly number[], ys: readonly number[]): number | null {
  const n = Math.min(xs.length, ys.length); if (n < 2) return null;
  const mx = xs.slice(0, n).reduce((s, x) => s + x, 0) / n, my = ys.slice(0, n).reduce((s, y) => s + y, 0) / n;
  let sxx = 0, sxy = 0; for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); }
  return sxx > 0 ? sxy / sxx : null;
}
export interface StabilityWindow { t_s: number; fps: number | null; p95_ms: number | null; heap_mb: number | null }
export interface Drift { windows: number; fps_first: number | null; fps_last: number | null; fps_change_pct: number | null; fps_drift_per_min: number | null; heap_status: 'measured' | 'unavailable'; heap_first_mb: number | null; heap_last_mb: number | null; heap_growth_mb_per_min: number | null }
export function drift(ws: readonly StabilityWindow[]): Drift {
  const f = ws.filter((w) => w.fps !== null) as (StabilityWindow & { fps: number })[], h = ws.filter((w) => w.heap_mb !== null) as (StabilityWindow & { heap_mb: number })[];
  const fpsSlope = slope(f.map((w) => w.t_s / 60), f.map((w) => w.fps)), heapSlope = slope(h.map((w) => w.t_s / 60), h.map((w) => w.heap_mb));
  const a = f[0]?.fps ?? null, b = f[f.length - 1]?.fps ?? null;
  return { windows: ws.length, fps_first: a, fps_last: b, fps_change_pct: a && b !== null ? r2((b - a) / a * 100) : null, fps_drift_per_min: r2(fpsSlope, 3),
    heap_status: h.length ? 'measured' : 'unavailable', heap_first_mb: h[0]?.heap_mb ?? null, heap_last_mb: h[h.length - 1]?.heap_mb ?? null, heap_growth_mb_per_min: r2(heapSlope, 3) };
}

/** Dynamic DPR step (drawing only): lower by `step` while the 75th percentile frame time of the last window exceeds
 *  the budget, raise by `step` (up to the device DPR) when it stays under `upFrac`·budget; hysteresis between. */
export function nextDynamicDpr(cur: number, recentMs: readonly number[], o: { min: number; max: number; budgetMs?: number; step?: number; window?: number; upFrac?: number }): number {
  const budget = o.budgetMs ?? 18, step = o.step ?? 0.25, win = o.window ?? 30, up = o.upFrac ?? 0.7;
  if (recentMs.length < win) return cur;
  const p75 = percentile(recentMs.slice(-win), 0.75) as number;
  const q = (x: number) => Math.min(o.max, Math.max(o.min, Math.round(x / step) * step));
  if (p75 > budget) return q(cur - step);
  if (p75 < budget * up) return q(cur + step);
  return q(cur);
}

/** Classify the WebGL renderer string: software rasterisers must never be reported as device GPU performance. */
export function classifyGpu(renderer: string | null, ua: string, webdriver: boolean): { software: boolean; automation: boolean; reason: string; environment: 'device-gpu' | 'software-rendering' | 'no-webgl' | 'automation' } {
  const r = (renderer ?? '').toLowerCase(), automation = webdriver || /headlesschrome/i.test(ua);
  const sw = ['swiftshader', 'llvmpipe', 'softpipe', 'software', 'microsoft basic render', 'lavapipe'].find((k) => r.includes(k));
  if (renderer === null) return { software: true, automation, reason: '無法建立 WebGL（可能停用硬體加速或瀏覽器不支援）', environment: 'no-webgl' };
  if (sw) return { software: true, automation, reason: `WebGL 由軟體繪圖（${sw}）執行，不是實體 GPU`, environment: 'software-rendering' };
  if (automation) return { software: false, automation, reason: '自動化／無頭瀏覽器，不是一般使用者裝置', environment: 'automation' };
  return { software: false, automation, reason: '看起來使用實體 GPU（依 WebGL renderer 字串判斷）', environment: 'device-gpu' };
}

/** schema check of a finished report; returns a list of problems (empty = valid) */
export function validateReport(r: unknown): string[] {
  const e: string[] = [], o = r as Record<string, unknown>;
  const isNum = (x: unknown) => x === null || (typeof x === 'number' && Number.isFinite(x));
  if (!o || typeof o !== 'object') return ['report is not an object'];
  if (o.schema !== REPORT_SCHEMA) e.push('schema');
  if (o.mode !== 'quick' && o.mode !== 'full') e.push('mode');
  if (typeof o.measurement_class !== 'string') e.push('measurement_class');
  const d = o.device as Record<string, unknown> | undefined;
  if (!d) e.push('device'); else {
    for (const k of ['userAgent', 'dpr', 'screen', 'hardwareConcurrency', 'deviceMemory', 'webgl', 'software_rendering', 'environment']) if (!(k in d)) e.push(`device.${k}`);
    if (typeof d.software_rendering !== 'boolean') e.push('device.software_rendering type');
    if (o.measurement_class === 'device' && d.software_rendering === true) e.push('software rendering reported as a device result');
  }
  const m = o.matrix as Record<string, unknown>[] | undefined;
  if (!Array.isArray(m)) e.push('matrix'); else m.forEach((c, i) => {
    if (!RENDERERS.includes(c.renderer as RendererId)) e.push(`matrix[${i}].renderer`);
    if (!COUNTS.includes(c.n as typeof COUNTS[number])) e.push(`matrix[${i}].n`);
    if (!DPRS.includes(c.dpr as typeof DPRS[number])) e.push(`matrix[${i}].dpr`);
    if (!SPEEDS.includes(c.speed as typeof SPEEDS[number])) e.push(`matrix[${i}].speed`);
    if (c.error === null || c.error === undefined) checkSummary(c, `matrix[${i}]`, e, isNum);
    const g = c.gpu as Record<string, unknown> | undefined, mem = c.memory as Record<string, unknown> | undefined;
    if (!g || typeof g.status !== 'string' || !isNum(g.ms_mean)) e.push(`matrix[${i}].gpu`);
    if (!mem || typeof mem.status !== 'string') e.push(`matrix[${i}].memory`);
  });
  const b = o.breakdown as Record<string, unknown>[] | undefined;
  if (!Array.isArray(b)) e.push('breakdown'); else b.forEach((c, i) => { if (c.error === null || c.error === undefined) { checkSummary(c, `breakdown[${i}]`, e, isNum); if (!c.layers_ms || typeof c.layers_ms !== 'object') e.push(`breakdown[${i}].layers_ms`); } });
  const s = o.stability as Record<string, unknown> | undefined;
  if (!s || !Array.isArray(s.windows) || !s.drift) e.push('stability');
  return e;
}
function checkSummary(c: Record<string, unknown>, at: string, e: string[], isNum: (x: unknown) => boolean) {
  for (const k of ['fps_mean', 'fps_p1_low', 'fps_p5_low']) if (!isNum(c[k])) e.push(`${at}.${k}`);
  const f = c.frame_ms as Record<string, unknown> | undefined; if (!f || !['p50', 'p95', 'p99'].every((k) => isNum(f[k]))) e.push(`${at}.frame_ms`);
  const cpu = c.cpu as Record<string, unknown> | undefined; if (!cpu || !isNum(cpu.busy_ratio)) e.push(`${at}.cpu`);
  // low-percentile fps never above the mean (p99 interval ≥ mean interval is not guaranteed for tiny samples, so only
  // the order p1 ≤ p5 is a hard invariant)
  if (typeof c.fps_p1_low === 'number' && typeof c.fps_p5_low === 'number' && c.fps_p1_low > c.fps_p5_low + 1e-9) e.push(`${at}: p1 low > p5 low`);
}
