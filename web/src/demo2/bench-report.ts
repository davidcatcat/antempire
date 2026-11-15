/**
 * Demo 2 performance tests — GPU identification, result records and tables. Pure: no DOM, no Three.js, no Worker.
 * Used by the bench page (web/demo2-bench.html), the 效能 tab of Demo 2, the Node table tool (cli/demo2-bench-table.ts)
 * and the tests (tests/demo2-bench.test.ts).
 *
 * Two rules this module enforces (Owner directive 2026-11-15, items 5 and 6):
 *  1. A result says what REALLY drew it: the API comes from the renderer's backend object (never from what was asked
 *     for), and the GPU is classified `real_gpu | software | unknown` from the strings the browser reports.
 *  2. Software-rendered numbers are not device results. Every software result carries the label below, and results of
 *     different measurement classes (or different APIs) are never put into one table: `benchTable` throws.
 * A performance test measures the PAGE. It never changes a world, and its synthetic mode is not a simulation at all.
 */
export type GpuClass = 'real_gpu' | 'software' | 'unknown';
export type RendererApi = 'webgl2' | 'webgpu';
export interface WebGpuAdapterInfo { vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean | null }
export interface GpuIdentity {
  /** the API that actually draws (from the backend object) */
  api: RendererApi;
  /** WEBGL_debug_renderer_info strings; null when the browser does not expose them */
  webgl_unmasked_vendor: string | null; webgl_unmasked_renderer: string | null;
  /** gl.VENDOR / gl.RENDERER (usually generic); null when no WebGL context was available */
  webgl_vendor: string | null; webgl_renderer: string | null;
  /** WebGPU adapter info; null when WebGPU is not the API in use and no adapter was asked for */
  webgpu_adapter: WebGpuAdapterInfo | null;
}
export interface GpuVerdict { class: GpuClass; rule: string }

/** names that mean the picture is computed on the CPU */
export const SOFTWARE_PATTERNS: readonly { re: RegExp; name: string }[] = [
  { re: /swiftshader/i, name: 'SwiftShader' }, { re: /llvmpipe/i, name: 'llvmpipe' }, { re: /softpipe/i, name: 'Mesa softpipe' },
  { re: /lavapipe/i, name: 'lavapipe' }, { re: /\bwarp\b/i, name: 'WARP' }, { re: /basic render/i, name: 'Microsoft Basic Render Driver' },
  { re: /software/i, name: 'Software' },
];
/** strings a browser reports instead of the real GPU (masked): they say nothing about the hardware */
const MASKED = /^(|webkit|webkit webgl|mozilla|google inc\.?|apple|apple inc\.?|apple gpu|generic renderer|webgl|unknown)$/i;
export const CLASS_RULE_ZH = [
  '1. 使用中的 API 取自渲染器的 backend 物件（不是網址要求的）。',
  '2. WebGPU：adapter 的 isFallbackAdapter 為 true → software。',
  '3. 使用中 API 的字串（WebGL：UNMASKED_VENDOR／UNMASKED_RENDERER；WebGPU：adapter 的 vendor／architecture／device／description）出現 SwiftShader、llvmpipe、Mesa softpipe、lavapipe、WARP、Basic Render、Software → software。',
  '4. 字串被遮蔽或沒有提供（WebGL 沒有 WEBGL_debug_renderer_info 或只回報通用名稱；WebGPU adapter 資訊全空且 isFallbackAdapter 不是 false）→ unknown。',
  '5. 其餘 → real_gpu。',
] as const;
export const CLASS_LABEL_ZH: Record<GpuClass, string> = {
  software: '軟體算繪，不是裝置結果', real_gpu: '真實 GPU（依瀏覽器回報的字串）', unknown: '無法辨識 GPU（字串被遮蔽）：不能當成真實 GPU 的結果',
};
const soft = (s: string) => SOFTWARE_PATTERNS.find((p) => p.re.test(s))?.name ?? null;

/** the written rule (CLASS_RULE_ZH), applied to the strings of the API in use */
export function classifyGpu(id: GpuIdentity): GpuVerdict {
  if (id.api === 'webgpu') {
    const a = id.webgpu_adapter;
    if (!a) return { class: 'unknown', rule: 'WebGPU in use but no adapter info was recorded' };
    if (a.isFallbackAdapter === true) return { class: 'software', rule: 'WebGPU adapter isFallbackAdapter = true' };
    const text = [a.vendor, a.architecture, a.device, a.description].join(' '), hit = soft(text);
    if (hit) return { class: 'software', rule: `WebGPU adapter info names ${hit}` };
    if (text.trim() === '' && a.isFallbackAdapter !== false) return { class: 'unknown', rule: 'WebGPU adapter info is empty and isFallbackAdapter is not reported' };
    return { class: 'real_gpu', rule: a.isFallbackAdapter === false ? 'WebGPU adapter is not a fallback adapter and names no software renderer' : 'WebGPU adapter info names no software renderer' };
  }
  const v = id.webgl_unmasked_vendor, r = id.webgl_unmasked_renderer;
  // a software name in ANY reported WebGL string is decisive, masked or not
  const hit = soft([v ?? '', r ?? '', id.webgl_vendor ?? '', id.webgl_renderer ?? ''].join(' '));
  if (hit) return { class: 'software', rule: `WebGL renderer string names ${hit}` };
  if (r === null) return { class: 'unknown', rule: 'WEBGL_debug_renderer_info is not available: the renderer string is masked' };
  if (MASKED.test(r.trim())) return { class: 'unknown', rule: `UNMASKED_RENDERER is a generic name (「${r}」)` };
  return { class: 'real_gpu', rule: 'UNMASKED_RENDERER names a GPU and no software renderer' };
}
/** the WebGL part of a GpuIdentity, read from a context (structural type: this module has no DOM dependency) */
export interface GlLike { VENDOR: number; RENDERER: number; getExtension(name: string): unknown; getParameter(p: number): unknown }
export function webglStrings(gl: GlLike | null): Pick<GpuIdentity, 'webgl_unmasked_vendor' | 'webgl_unmasked_renderer' | 'webgl_vendor' | 'webgl_renderer'> {
  if (!gl) return { webgl_unmasked_vendor: null, webgl_unmasked_renderer: null, webgl_vendor: null, webgl_renderer: null };
  const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number; UNMASKED_RENDERER_WEBGL: number } | null;
  return { webgl_unmasked_vendor: ext ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : null, webgl_unmasked_renderer: ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : null, webgl_vendor: String(gl.getParameter(gl.VENDOR)), webgl_renderer: String(gl.getParameter(gl.RENDERER)) };
}
/** WebGPU adapter info as recorded (isFallbackAdapter lives on adapter.info in current browsers, on the adapter in older ones) */
export function adapterRecord(adapter: { info?: Partial<WebGpuAdapterInfo>; isFallbackAdapter?: boolean } | null): WebGpuAdapterInfo | null {
  if (!adapter) return null;
  const i = adapter.info ?? {}, fb = typeof i.isFallbackAdapter === 'boolean' ? i.isFallbackAdapter : typeof adapter.isFallbackAdapter === 'boolean' ? adapter.isFallbackAdapter : null;
  return { vendor: i.vendor ?? '', architecture: i.architecture ?? '', device: i.device ?? '', description: i.description ?? '', isFallbackAdapter: fb };
}
/** one line for the 效能 tab */
export function gpuLine(id: GpuIdentity): string {
  const a = id.webgpu_adapter;
  return [
    `API：${id.api === 'webgpu' ? 'WebGPU' : 'WebGL 2'}`,
    `WebGL UNMASKED_VENDOR：${id.webgl_unmasked_vendor ?? '（未提供）'}`, `UNMASKED_RENDERER：${id.webgl_unmasked_renderer ?? '（未提供）'}`,
    a ? `WebGPU adapter：${[a.vendor, a.architecture, a.device, a.description].filter(Boolean).join(' ') || '（空）'}｜isFallbackAdapter：${a.isFallbackAdapter === null ? '（未提供）' : a.isFallbackAdapter}` : 'WebGPU adapter：（未取得）',
  ].join('｜');
}

// ---------- result records ----------
export const BENCH_SCHEMA = 'antempire.demo2-bench.v1';
export const BENCH_SIZES = [30, 100, 300, 1000] as const;
export type BenchMode = 'render' | 'sim';
export const MODE_LABEL_ZH: Record<BenchMode, string> = { render: '純渲染（合成資料，非模擬）', sim: '完整模擬（引擎個體）' };
/** workers per P0-A2 experiment world (fixed by the world; the bench never changes a world's parameters) */
export const WORKERS_PER_WORLD = 30;
/** how many independent worlds a full-simulation case of n individuals needs */
export const worldsFor = (n: number) => Math.max(1, Math.ceil(n / WORKERS_PER_WORLD));
export interface Quantiles { p50: number; p95: number; p99: number; max: number }
export interface SimStats {
  /** independent, non-interacting colonies (one Worker each, different seeds) and the engine workers drawn */
  worlds: number; drawn: number; seeds: number[];
  start_s: number;
  /** Worker → main thread: state messages per second (all worlds), and bytes per second ESTIMATED from the JSON size of sampled frames */
  msgs_per_s: number; bytes_per_s_est: number; frame_bytes_est: number;
  /** engine events per second of wall clock (all worlds): the simulation's own step count (the core is event-driven) */
  sim_events_per_s: number;
  /** simulation seconds per wall second: asked for, and reached (mean and slowest world) */
  ratio_requested: number; ratio_achieved_mean: number; ratio_achieved_min: number;
  /** how late the newest frame of the slowest world is, in wall seconds (queue backlog + Worker slowness) */
  lag_s_max: number;
}
export interface BenchCase {
  mode: BenchMode; n: number; status: 'ok' | 'failed' | 'skipped'; reason: string | null;
  warm_s: number; dur_s: number; frames: number;
  fps_mean: number; fps_p5_low: number; frame_ms: Quantiles; cpu_ms: { p50: number; p95: number };
  draw_calls: number; triangles: number;
  /** JS heap of the page (Chromium only; null elsewhere). Worker heaps and the message queue are NOT included. */
  heap_mb: { start: number; end: number; max: number } | null; heap_series_mb: number[];
  quality: string; dpr: number; canvas: [number, number];
  sim: SimStats | null;
}
export interface BenchResult {
  schema: typeof BENCH_SCHEMA; when_utc: string; page: string; three: string;
  gpu: GpuIdentity; gpu_class: GpuClass; gpu_rule: string;
  /** = gpu_class; kept under this name so every record can be filtered the same way */
  measurement_class: GpuClass; label_zh: string;
  renderer_requested: RendererApi; renderer_api: RendererApi; renderer_note: string;
  /** how a frame is counted: rAF intervals (WebGL 2), or rAF after the GPU queue finished the previous frame (WebGPU) */
  frame_pacing: 'raf' | 'raf_after_gpu_queue_done';
  automated: boolean; user_agent: string; viewport: { w: number; h: number; dpr: number }; hardware_concurrency: number | null; device_memory_gb: number | null;
  cases: BenchCase[]; notes_zh: string[];
}
const r2 = (v: number) => Math.round(v * 100) / 100;
export function quantile(sorted: readonly number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
/** frame intervals (ms, rAF to rAF) and the page's own work per frame (ms) */
export function frameStats(intervals: readonly number[], cpu: readonly number[]) {
  const s = [...intervals].sort((a, b) => a - b), c = [...cpu].sort((a, b) => a - b), total = intervals.reduce((a, b) => a + b, 0);
  return {
    frames: intervals.length, fps_mean: total > 0 ? r2((intervals.length * 1000) / total) : 0, fps_p5_low: s.length ? r2(1000 / quantile(s, 0.95)) : 0,
    frame_ms: { p50: r2(quantile(s, 0.5)), p95: r2(quantile(s, 0.95)), p99: r2(quantile(s, 0.99)), max: r2(s[s.length - 1] ?? NaN) },
    cpu_ms: { p50: r2(quantile(c, 0.5)), p95: r2(quantile(c, 0.95)) },
  };
}

// ---------- when a full-simulation case must stop itself ----------
export interface Watch { elapsed_s: number; heap_mb: number | null; heap_limit_mb: number | null; lag_s: number; frame_gap_s: number; worker_error: string | null }
export const WATCH_LIMITS = { lag_s: 6, frame_gap_s: 5, heap_fraction: 0.7 } as const;
/** null = carry on; otherwise the reason the case is stopped and reported as failed (never left to run out of memory) */
export function watchdog(w: Watch): string | null {
  if (w.worker_error) return `Worker 失敗：${w.worker_error}`;
  if (w.heap_mb !== null && w.heap_limit_mb !== null && w.heap_mb > w.heap_limit_mb * WATCH_LIMITS.heap_fraction) return `JS heap ${w.heap_mb.toFixed(0)} MB 超過上限 ${w.heap_limit_mb.toFixed(0)} MB 的 ${WATCH_LIMITS.heap_fraction * 100}%：停止以免記憶體不足`;
  if (w.lag_s > WATCH_LIMITS.lag_s) return `狀態框落後 ${w.lag_s.toFixed(1)} 秒（> ${WATCH_LIMITS.lag_s} 秒）：主執行緒消化不了 Worker 的訊息，佇列在累積；停止以免記憶體不足`;
  if (w.frame_gap_s > WATCH_LIMITS.frame_gap_s) return `畫面 ${w.frame_gap_s.toFixed(1)} 秒沒有更新（> ${WATCH_LIMITS.frame_gap_s} 秒）：主執行緒被卡住；停止`;
  return null;
}

// ---------- tables ----------
export class MixedMeasurementError extends Error {
  constructor(what: string) { super(`拒絕合併／比較：${what}。軟體算繪、真實 GPU、無法辨識的結果不能放在同一張表；WebGL 2 與 WebGPU 的結果也要分開。`); this.name = 'MixedMeasurementError'; }
}
/** a result whose own fields disagree is refused (a software result relabelled by hand, a missing class, …) */
export function validateResult(r: BenchResult): void {
  if (r.schema !== BENCH_SCHEMA) throw new Error(`not a ${BENCH_SCHEMA} result`);
  const v = classifyGpu(r.gpu);
  if (v.class !== r.gpu_class || r.measurement_class !== r.gpu_class) throw new Error(`結果的 measurement_class（${r.measurement_class}）與它記錄的 GPU 字串分類（${v.class}）不一致`);
  if (r.gpu.api !== r.renderer_api) throw new Error('renderer_api 與 gpu.api 不一致');
  if (r.label_zh !== CLASS_LABEL_ZH[r.gpu_class]) throw new Error('label_zh 與分類不一致');
}
/** results that may share a table: same measurement class AND same API in use. Throws MixedMeasurementError otherwise. */
export function assertComparable(results: readonly BenchResult[]): void {
  for (const r of results) validateResult(r);
  const classes = new Set(results.map((r) => r.measurement_class)), apis = new Set(results.map((r) => r.renderer_api));
  if (classes.size > 1) throw new MixedMeasurementError(`量測類別不同（${[...classes].join('、')}）`);
  if (apis.size > 1) throw new MixedMeasurementError(`渲染 API 不同（${[...apis].join('、')}）`);
}
const cell = (v: number | null | undefined, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
export const TABLE_HEAD = ['模式', '隻數', '狀態', 'FPS 平均／p5 低', '幀時間 p50／p95／p99 ms', '主執行緒 ms/幀 p50', 'draw calls', '三角形', 'JS heap MB（始→終／最大）', '畫質／DPR／畫布', 'Worker→主 訊息/s｜KB/s（估）', '引擎事件/s', '模擬／真實（要求→達成 平均／最慢）'] as const;
export function caseRow(c: BenchCase): string[] {
  const s = c.sim;
  return [
    MODE_LABEL_ZH[c.mode] + (s ? `｜${s.worlds} 個獨立蟻群` : ''), String(c.n), c.status === 'ok' ? '完成' : c.status === 'skipped' ? `未執行：${c.reason ?? ''}` : `失敗：${c.reason ?? ''}`,
    c.status === 'ok' ? `${cell(c.fps_mean)}／${cell(c.fps_p5_low)}` : '—', c.status === 'ok' ? `${cell(c.frame_ms.p50)}／${cell(c.frame_ms.p95)}／${cell(c.frame_ms.p99)}` : '—',
    c.status === 'ok' ? cell(c.cpu_ms.p50) : '—', c.status === 'ok' ? String(c.draw_calls) : '—', c.status === 'ok' ? `${Math.round(c.triangles / 1000)}k` : '—',
    c.heap_mb ? `${cell(c.heap_mb.start, 0)}→${cell(c.heap_mb.end, 0)}／${cell(c.heap_mb.max, 0)}` : '—', `${c.quality}／${cell(c.dpr, 2)}／${c.canvas[0]}×${c.canvas[1]}`,
    s && c.status === 'ok' ? `${cell(s.msgs_per_s, 0)}｜${cell(s.bytes_per_s_est / 1024, 0)}` : '—', s && c.status === 'ok' ? cell(s.sim_events_per_s, 0) : '—', s && c.status === 'ok' ? `${cell(s.ratio_requested, 0)}×→${cell(s.ratio_achieved_mean, 2)}×／${cell(s.ratio_achieved_min, 2)}×` : '—',
  ];
}
/** a Markdown table of one or more results of ONE measurement class and ONE API (throws when they are mixed) */
export function benchTable(results: readonly BenchResult[]): string {
  if (!results.length) return '';
  assertComparable(results);
  const r0 = results[0], out: string[] = [];
  out.push(`**量測類別：${r0.measurement_class}（${r0.label_zh}）｜API：${r0.renderer_api === 'webgpu' ? 'WebGPU' : 'WebGL 2'}**`, '');
  for (const r of results) {
    out.push(`- ${r.when_utc}｜${gpuLine(r.gpu)}｜${r.viewport.w}×${r.viewport.h} @${r.viewport.dpr}${r.automated ? '｜自動化環境' : ''}`);
  }
  out.push('', `| ${TABLE_HEAD.join(' | ')} |`, `|${TABLE_HEAD.map(() => '---').join('|')}|`);
  for (const r of results) for (const c of r.cases) out.push(`| ${caseRow(c).map((x) => x.replace(/\|/g, '｜')).join(' | ')} |`);
  return out.join('\n');
}
