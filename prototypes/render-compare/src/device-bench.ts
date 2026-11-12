/**
 * Device bench page (Owner decisions 49 / 50). One static page, opened on a real phone / desktop browser: "開始量測"
 * runs
 *   1. the matrix renderer A / B / C × {100, 1000, 5000} synthetic ants (示範 positions, NOT engine data) × DPR
 *      {device, 1} × speed {1×, fast 10×} — same scene, camera and fixed-step animation for A, B and C;
 *   2. the game-view bottleneck breakdown: the experiment replay (read-only engine record, 非正式) drawn as the game
 *      view draws it, per-layer ms from the LayeredRenderer, for the baseline and five presentation-only mitigations
 *      (static pre-composite, off-screen culling, décor LOD, dynamic DPR, pre-rotated atlas) and all of them;
 *   3. a long run (fps drift, heap growth).
 * and shows a result panel plus a copyable JSON report with device info and an explicit software-rendering flag.
 * Drawing only: nothing here runs the simulation or writes anything; every mitigation draws the same ants.
 */
import { LayeredRenderer, type FrameOptions, type RendererOptions } from '../../../web/src/render-canvas.ts';
import { recordedRoutes, type AntInput, type Camera } from '../../../web/src/render-scene.ts';
import { displayPositions, windowOf, type Experiment } from '../../../web/src/model.ts';
import { antFrame, buildDayIndex, laneOffset, nextWalkStart, rosterAtStart, siteSlot, walkIntervals, anyWalking, hash32, mulberry32 } from '../../../web/src/game-model.ts';
import { PixiAnts } from './pixi-ants.ts';
import * as S from './bench-stats.ts';

const BENCH_VERSION = '1.0.0', STEP = 1 / 60;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage'), canvas = $<HTMLCanvasElement>('scene'), above = $<HTMLCanvasElement>('above'), glHost = $('glHost'), hudText = $('hudText'), hudBar = $('hudBar');
let abort = false, interrupted = false;
document.addEventListener('visibilitychange', () => { if (document.hidden) interrupted = true; });
const raf = () => new Promise<number>((r) => requestAnimationFrame(r));
const heapMb = () => { const m = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory; return m ? +(m.usedJSHeapSize / 1048576).toFixed(2) : null; };
const longTaskSupported = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('longtask');
const longTasks: { start: number; dur: number }[] = [];
if (longTaskSupported) new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push({ start: e.startTime, dur: e.duration }); if (longTasks.length > 5000) longTasks.splice(0, 1000); }).observe({ type: 'longtask', buffered: false } as PerformanceObserverInit);

// ------------------------------------------------------------------ device info
function probeDevice() {
  const c = document.createElement('canvas'); let ver: string | null = 'webgl2';
  let gl = c.getContext('webgl2') as WebGL2RenderingContext | WebGLRenderingContext | null;
  if (!gl) { gl = c.getContext('webgl') as WebGLRenderingContext | null; ver = gl ? 'webgl1' : null; }
  let webgl: Record<string, unknown> = { version: null, vendor: null, renderer: null, unmasked_vendor: null, unmasked_renderer: null, debug_info_available: false };
  let timer = 'unavailable: no WebGL';
  if (gl) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    webgl = { version: ver, vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER), unmasked_vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null, unmasked_renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null, debug_info_available: !!dbg, max_texture_size: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
    timer = ver === 'webgl2' && gl.getExtension('EXT_disjoint_timer_query_webgl2') ? 'available (EXT_disjoint_timer_query_webgl2)' : 'unavailable: EXT_disjoint_timer_query_webgl2 not exposed by this browser';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
  const rs = (webgl.unmasked_renderer ?? webgl.renderer) as string | null, nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { platform?: string; mobile?: boolean } };
  const cls = S.classifyGpu(rs, navigator.userAgent, !!navigator.webdriver);
  return {
    userAgent: navigator.userAgent, platform: nav.userAgentData?.platform ?? navigator.platform ?? null, mobile: nav.userAgentData?.mobile ?? null,
    dpr: window.devicePixelRatio || 1, screen: { w: screen.width, h: screen.height, avail_w: screen.availWidth, avail_h: screen.availHeight },
    viewport: { w: innerWidth, h: innerHeight }, hardwareConcurrency: navigator.hardwareConcurrency ?? null, deviceMemory: nav.deviceMemory ?? null,
    webgl, software_rendering: cls.software, automation: cls.automation, environment: cls.environment, environment_reason: cls.reason,
    gpu_timer: timer, memory_api: heapMb() === null ? 'unavailable (performance.memory not exposed)' : 'performance.memory (Chromium, JS heap only)',
    longtask_api: longTaskSupported ? 'PerformanceObserver longtask' : 'unavailable',
  };
}

// ------------------------------------------------------------------ scenes (inputs are pure functions of the frame index)
interface Scene { kind: 'stress' | 'replay'; label: string; setup(R: LayeredRenderer): Camera; frame(k: number): AntInput[]; opts: FrameOptions; dt: number; onFrame?(R: LayeredRenderer): void }
const fitCam = (cx: number, cy: number, s: number): Camera => ({ cx, cy, s, w: canvas.clientWidth, h: canvas.clientHeight });

/** N synthetic sprites on circles in a 60 cm view (示範 positions); fast = the animation time advances FAST_FACTOR× */
function stressScene(n: number, speed: number): Scene {
  const r = mulberry32(99), ants = Array.from({ length: n }, (_, i) => ({ id: `S${i}`, cx: (r() - 0.5) * 50, cy: (r() - 0.5) * 50, rad: 2 + r() * 8, w: (0.2 + r() * 0.4) * (r() < 0.5 ? -1 : 1), p0: r() * 6.283 }));
  return {
    kind: 'stress', label: `${n} 隻示範合成精靈`, opts: { colourVariants: true, minAntPx: 26 }, dt: STEP * speed,
    setup(R) {
      R.setScene({ seed: 4242, places: [{ id: 'N00', name: '示範巢', bearing: null, distance_cm: null, kind: null, layout: null }], pos: { N00: { x: 0, y: 0, known: true } }, routes: [], sources: {}, weather: null });
      return fitCam(0, 0, Math.min(canvas.clientWidth, canvas.clientHeight) / 60);
    },
    frame(k) { const tt = k * STEP * speed; return ants.map((a) => { const ang = a.p0 + a.w * tt; return { id: a.id, x: a.cx + Math.cos(ang) * a.rad, y: a.cy + Math.sin(ang) * a.rad, vis: 'walking', moving: true, heading: ang + Math.sign(a.w) * Math.PI / 2 }; }); },
  };
}

/** the game view's drawing of the experiment replay (same frame options as web/src/game.ts; framing nest + busiest
 *  food site, as prototypes/render-compare replay); read-only engine record */
function replayScene(exp: Experiment): Scene {
  const pos = displayPositions(exp.map.places), routes = recordedRoutes(exp, pos);
  let day = 1, t = 0, idx = buildDayIndex(exp.days[0]), walks = walkIntervals(exp.days[0]), roster = rosterAtStart(exp, 1), R0: LayeredRenderer | null = null;
  const d = () => exp.days[day - 1], stateSources = () => (day === 1 ? exp.day0.state : exp.days[day - 2].end_state).sources;
  const minAntPx = () => Math.max(36, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.08));
  let cam: Camera = fitCam(0, 0, 4);
  return {
    kind: 'replay', label: '遊戲畫面（重播非正式實驗世界的引擎紀錄）', opts: { displayTurns: true, colourVariants: true, minAntPx: minAntPx() }, dt: STEP,
    setup(R) {
      R0 = R; day = 1; t = 0; idx = buildDayIndex(d()); walks = walkIntervals(d()); roster = rosterAtStart(exp, day);
      R.setScene({ seed: hash32(exp.spec.id), places: exp.map.places, pos, routes, sources: stateSources(), weather: d().weather });
      const counts = new Map<string, number>();
      for (const dd of exp.days) for (const e of dd.events) if (e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>')) { const [a, b] = e.place.split('>'); const f = a === 'N00' ? b : a; if (pos[f]?.known && f !== 'N00') counts.set(f, (counts.get(f) ?? 0) + 1); }
      const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N00', pts = [pos.N00, pos[top]], pad = 9;
      const bx0 = Math.min(...pts.map((p) => p.x)), bx1 = Math.max(...pts.map((p) => p.x)), by0 = Math.min(...pts.map((p) => p.y)), by1 = Math.max(...pts.map((p) => p.y));
      cam = fitCam((bx0 + bx1) / 2, (by0 + by1) / 2, Math.min(canvas.clientWidth / (bx1 - bx0 + 2 * pad), canvas.clientHeight / (by1 - by0 + 2 * pad)));
      return cam;
    },
    frame() {
      if (!anyWalking(walks, t)) { const nx = nextWalkStart(walks, d(), t); t = nx === null ? windowOf(d()) : Math.max(t, nx - 0.05); }
      t += STEP * 20 / 60;
      if (t >= windowOf(d())) { day = day % exp.days.length + 1; t = 0; idx = buildDayIndex(d()); walks = walkIntervals(d()); roster = rosterAtStart(exp, day); R0?.setEngineState(stateSources(), d().weather); }
      const L = Math.max(minAntPx(), 0.25 * cam.s);
      return roster.map((id) => {
        const f = antFrame(idx, d(), id, t, pos); let off: AntInput['displayOffset'];
        if (f.vis === 'walking' && f.heading !== null) { const o = laneOffset(id) * L * 0.55, h = -f.heading; off = { dx: -Math.sin(h) * o, dy: Math.cos(h) * o }; }
        else { const s = siteSlot(id), k = Math.min(1.4, L / 26); off = { dx: s.dx * k, dy: s.dy * k, heading: s.heading }; }
        return { id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: off };
      });
    },
  };
}

// ------------------------------------------------------------------ one measured run
interface RunCfg { renderer: S.RendererId; scene: Scene; maxDpr?: number; toggles: S.Toggles; warmS: number; measureS: number; label: string; progress: () => string; windowS?: number }
const GROUPS: Record<string, string[]> = { ground_chunks: ['ground', 'decals', 'shadows'], decor_and_objects: ['propsLow', 'propsHigh'], ants: ['antShadows', 'ants'], overlays: ['routes', 'lighting', 'weather', 'ui'] };

async function measure(cfg: RunCfg) {
  const t = cfg.toggles, opts: RendererOptions = { fixedQuality: 0, antSprites: cfg.renderer === 'B' || (cfg.renderer === 'A' && t.atlas) ? 'prerotated' : 'rotate', maxDpr: cfg.maxDpr, decorLod: t.decorLod1 ? 1 : undefined, cullOffscreen: t.cull, cacheStatic: t.cacheStatic };
  const R = new LayeredRenderer(canvas, opts); R.resize();
  const g2 = above.getContext('2d') as CanvasRenderingContext2D; above.hidden = cfg.renderer !== 'C';
  let pixi: PixiAnts | null = null, glc: HTMLCanvasElement | null = null;
  const gpu = { status: cfg.renderer === 'C' ? 'unavailable: EXT_disjoint_timer_query_webgl2 not exposed' : 'unavailable: Canvas 2D has no GPU timer query', samples: [] as number[] };
  const dprOf = () => canvas.width / Math.max(1, canvas.clientWidth);
  const sizeC = () => { if (!pixi) return; if (above.width !== canvas.width || above.height !== canvas.height) { above.width = canvas.width; above.height = canvas.height; } pixi.resize(canvas.clientWidth, canvas.clientHeight, dprOf()); };
  let pending: WebGLQuery[] = [];
  try {
    if (cfg.renderer === 'C') {
      glc = document.createElement('canvas'); glHost.appendChild(glc);
      pixi = await PixiAnts.create(glc, canvas.clientWidth, canvas.clientHeight, dprOf());
      opts.externalAnts = { draw: (layer, draws, info) => (pixi as PixiAnts).draw(layer, draws, info), above: g2 };
      // GPU time of the WebGL ant layer, where the browser exposes the disjoint timer query
      const gl = (pixi.renderer as unknown as { gl?: WebGL2RenderingContext }).gl, ext = gl?.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
      if (gl && ext) {
        gpu.status = 'measured: WebGL ant layer only (EXT_disjoint_timer_query_webgl2)';
        const rr = pixi.renderer as unknown as { render: (...a: unknown[]) => unknown }, orig = rr.render.bind(rr);
        rr.render = (...a: unknown[]) => { const q = gl.createQuery() as WebGLQuery; gl.beginQuery(ext.TIME_ELAPSED_EXT, q); const out = orig(...a); gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(q); return out; };
        const poll = () => { const keep: WebGLQuery[] = []; const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT); for (const q of pending) { if (gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) { if (!disjoint) gpu.samples.push(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(q); } else keep.push(q); } pending = keep.length > 20 ? keep.slice(-20) : keep; };
        (cfg.scene as Scene & { poll?: () => void }).poll = poll;
      }
    }
    let cam = cfg.scene.setup(R); sizeC(); R.warm(cam);
    const deviceDpr = R.dprNow(); // the renderer's own DPR (device DPR capped by the quality level and maxDpr)
    let dynDpr = deviceDpr; const dprSeen: number[] = [];
    const iv: number[] = [], js: number[] = [], layerSum: Record<string, number> = {}, recent: number[] = [];
    let k = 0, last = 0, t0 = 0, tm0 = 0, planned = 0, culled = 0, statics = 0;
    const windows: S.StabilityWindow[] = []; let wIv: number[] = [], wStart = 0;
    interrupted = false;
    const start = performance.now();
    for (;;) {
      const now = await raf();
      if (abort) break;
      const measuring = now - start >= cfg.warmS * 1000; if (measuring && !tm0) { tm0 = now; wStart = now; }
      if (measuring && now - tm0 >= cfg.measureS * 1000) break;
      const fms = last ? now - last : null; last = now;
      cam = { ...cam, w: canvas.clientWidth, h: canvas.clientHeight };
      t0 = performance.now();
      const ants = cfg.scene.frame(k++); sizeC();
      const draws = R.frame(cam, ants, cfg.scene.dt, fms, cfg.scene.opts);
      const jsMs = performance.now() - t0;
      (cfg.scene as Scene & { poll?: () => void }).poll?.();
      // dynamic DPR: decide on every 8 frames (also reacts within a short window at low fps)
      if (t.dynamicDpr && fms !== null) { recent.push(fms); if (recent.length >= 8) { const nd = S.nextDynamicDpr(dynDpr, recent, { min: 1, max: deviceDpr, window: 8 }); recent.length = 0; if (nd !== dynDpr) { dynDpr = nd; R.setDprCap(dynDpr); } } }
      if (measuring && fms !== null && tm0 !== now) {
        iv.push(fms); js.push(jsMs); planned += draws.length; culled += R.antStats.culled; statics += R.antStats.staticHits; dprSeen.push(R.dprNow());
        for (const [l, ms] of Object.entries(R.stats.lastMs)) layerSum[l] = (layerSum[l] ?? 0) + ms;
        if (cfg.windowS) { wIv.push(fms); if (now - wStart >= cfg.windowS * 1000) { const m = S.mean(wIv) as number; windows.push({ t_s: +((now - tm0) / 1000).toFixed(1), fps: +(1000 / m).toFixed(2), p95_ms: S.percentile(wIv, 0.95), heap_mb: heapMb() }); wIv = []; wStart = now; } }
      }
      if (k % 15 === 0) { const el = measuring ? (now - tm0) / 1000 : 0; hudText.textContent = `${cfg.progress()}｜${cfg.label}｜${measuring ? `量測 ${el.toFixed(0)}/${cfg.measureS} 秒` : '暖機'}`; }
    }
    const wall = tm0 ? last - tm0 : 0, lts = longTaskSupported ? longTasks.filter((x) => x.start >= tm0 && x.start <= last).map((x) => x.dur) : null;
    const sum = S.summarizeFrames(iv, js, wall, lts), n = Math.max(1, iv.length), layers: Record<string, number> = {};
    for (const [gname, ls] of Object.entries(GROUPS)) layers[gname] = +(ls.reduce((s, l) => s + (layerSum[l] ?? 0), 0) / n).toFixed(3);
    const layerTotal = Object.values(layers).reduce((s, x) => s + x, 0);
    layers.plan_and_other_js = +Math.max(0, (sum.cpu.js_ms_mean ?? 0) - layerTotal).toFixed(3);
    layers.other_non_js = +Math.max(0, (S.mean(iv) ?? 0) - (sum.cpu.js_ms_mean ?? 0)).toFixed(3);
    const heapEnd = heapMb();
    return {
      ...sum, canvas_px: [canvas.width, canvas.height], dpr_actual: +dprOf().toFixed(3), dpr_range: dprSeen.length ? [Math.min(...dprSeen), Math.max(...dprSeen)] : null,
      gpu: { status: gpu.samples.length ? gpu.status : gpu.status.startsWith('measured') ? 'unavailable: no query result (disjoint or not ready)' : gpu.status, ms_mean: gpu.samples.length ? +(S.mean(gpu.samples) as number).toFixed(3) : null, ms_p95: S.percentile(gpu.samples, 0.95) },
      memory: { status: heapEnd === null ? 'unavailable' : 'performance.memory usedJSHeapSize', heap_mb_end: heapEnd, ant_texture_mb_est: +((pixi ? pixi.textureBytes() : R.antTextureBytes()) / 1048576).toFixed(2), chunk_mb_est: +(R.chunkBytes() / 1048576).toFixed(2) },
      layers_ms: layers, ants_planned_per_frame: +(planned / n).toFixed(1), ants_culled_per_frame: +(culled / n).toFixed(1), static_cache_hits_per_frame: +(statics / n).toFixed(2),
      pre_rotated_buckets: R.antStats.buckets, webgl_renderer: pixi?.describe().gl ?? null, interrupted: interrupted || abort, windows, error: null as string | null,
    };
  } finally {
    if (pixi) { const gl = (pixi.renderer as unknown as { gl?: WebGL2RenderingContext }).gl; try { pixi.renderer.destroy(); } catch { /* ignore */ } gl?.getExtension('WEBGL_lose_context')?.loseContext(); }
    glc?.remove(); g2.setTransform(1, 0, 0, 1, 0, 0); g2.clearRect(0, 0, above.width, above.height);
  }
}

// ------------------------------------------------------------------ the whole run
async function loadExperiment(): Promise<Experiment | null> {
  try { const ix = await (await fetch('data/index.json')).json() as { experiments: { file: string }[] }; return await (await fetch('data/' + ix.experiments[0].file)).json() as Experiment; }
  catch { return null; }
}

async function runAll(mode: S.BenchMode) {
  const T = S.TIMING[mode], device = probeDevice(), cells = S.buildMatrix();
  const exp = await loadExperiment();
  // the replay draws what the engine recorded (often only a few ants on screen); the same garden with 1000 示範 ants
  // shows where the time goes under load
  const bdScenes: ['replay' | 'stress1000', () => Scene | null][] = [['replay', () => (exp ? replayScene(exp) : null)], ['stress1000', () => stressScene(1000, 1)]];
  const total = cells.length + bdScenes.length * S.BREAKDOWN_CONFIGS.length + 1; let done = 0;
  const prog = () => `${done + 1}/${total}`;
  const report = {
    schema: S.REPORT_SCHEMA, bench_version: BENCH_VERSION, generated_at: new Date().toISOString(), mode,
    measurement_class: device.software_rendering || device.automation ? 'software-or-automation: NOT a device result' : 'device',
    notes: ['壓力場景（matrix、stress1000）的螞蟻位置是示範合成資料，不是引擎資料。', '遊戲畫面場景重播非正式實驗世界的引擎紀錄（唯讀）。', '減負方案只改畫法；畫出的螞蟻、位置與事件不變。', 'CPU 以主執行緒 JavaScript 時間與 long task 估計，不是處理程序 CPU。', '軟體繪圖（SwiftShader 等）或自動化瀏覽器的數字不可當作手機效能。'],
    definitions: { fps_p1_low: '1000 / p99 frame interval', fps_p5_low: '1000 / p95 frame interval', busy_ratio: 'sum of JS ms in the frame callback / wall ms', longtask_ratio: 'sum of long-task ms / wall ms', fast: `animation time × ${S.FAST_FACTOR} per frame`, other_non_js: 'mean frame interval − mean JS ms (compositing, GPU, vsync wait)' },
    timing: T, device,
    matrix: [] as Record<string, unknown>[], breakdown: [] as Record<string, unknown>[],
    stability: { scene: 'replay (game view), renderer A, baseline', secs: T.stabilityS, windows: [] as S.StabilityWindow[], drift: S.drift([]) } as Record<string, unknown>,
    aborted: false, interrupted_cells: 0,
  };
  for (const c of cells) {
    if (abort) break;
    const label = `${c.renderer}・${c.n} 隻・DPR ${c.dpr === 'device' ? '裝置' : '1'}・${c.speed === 'fast' ? `快轉 ${S.FAST_FACTOR}×` : '1×'}・示範合成位置`;
    let row: Record<string, unknown>;
    try { row = await measure({ renderer: c.renderer, scene: stressScene(c.n, c.speed === 'fast' ? S.FAST_FACTOR : 1), maxDpr: c.dpr === '1' ? 1 : undefined, toggles: S.NO_TOGGLES, warmS: T.warmS, measureS: T.measureS, label, progress: prog }); delete row.windows; }
    catch (e) { row = { error: String((e as Error).message ?? e), gpu: { status: 'error', ms_mean: null }, memory: { status: 'error' } }; }
    report.matrix.push({ ...c, ...row }); done++; hudBar.style.width = `${(done / total) * 100}%`;
  }
  for (const [sid, mk] of bdScenes) for (const conf of S.BREAKDOWN_CONFIGS) {
    if (abort) break;
    let row: Record<string, unknown>; const sc = mk();
    if (!sc) row = { error: '無法載入實驗世界資料（data/）' };
    else try { row = await measure({ renderer: 'A', scene: sc, toggles: conf.toggles, warmS: T.warmS, measureS: T.breakdownS, label: `遊戲畫面瓶頸・${conf.label}`, progress: prog }); delete row.windows; }
    catch (e) { row = { error: String((e as Error).message ?? e) }; }
    report.breakdown.push({ scene: sid, config: conf.id, label: conf.label, toggles: conf.toggles, ...row }); done++; hudBar.style.width = `${(done / total) * 100}%`;
  }
  if (!abort) {
    const sc = exp ? replayScene(exp) : stressScene(1000, 1);
    try { const r = await measure({ renderer: 'A', scene: sc, toggles: S.NO_TOGGLES, warmS: T.warmS, measureS: T.stabilityS, windowS: T.stabilityWindowS, label: `長時間穩定性（${T.stabilityS} 秒）`, progress: prog }); const ws = r.windows; report.stability = { scene: exp ? 'replay (game view), renderer A, baseline' : 'stress 1000 (示範), renderer A', secs: T.stabilityS, windows: ws, drift: S.drift(ws), fps_mean: r.fps_mean, frame_ms: r.frame_ms, interrupted: r.interrupted }; }
    catch (e) { report.stability = { error: String(e), windows: [], drift: S.drift([]) }; }
    done++;
  }
  report.aborted = abort;
  report.interrupted_cells = [...report.matrix, ...report.breakdown].filter((r) => r.interrupted).length;
  return report;
}

// ------------------------------------------------------------------ result panel
const f1 = (x: unknown) => (typeof x === 'number' ? x.toFixed(1) : '—');
function render(report: Awaited<ReturnType<typeof runAll>>) {
  const d = report.device, flag = $('envFlag');
  flag.className = 'flag ' + (report.measurement_class === 'device' ? 'good' : 'bad');
  flag.textContent = report.measurement_class === 'device' ? `實機量測：${d.environment_reason}` : `注意：這不是實機效能結果。${d.environment_reason}。這些數字不可當作手機或一般電腦的效能。`;
  const wg = d.webgl as Record<string, unknown>;
  const kv: [string, string][] = [['GPU（WebGL）', String(wg.unmasked_renderer ?? wg.renderer ?? '無法取得')], ['螢幕', `${d.screen.w}×${d.screen.h}，DPR ${d.dpr}`], ['CPU 執行緒', String(d.hardwareConcurrency ?? '無法取得')], ['記憶體（GB）', String(d.deviceMemory ?? '無法取得')], ['GPU 計時', d.gpu_timer], ['記憶體量測', d.memory_api], ['模式', report.mode === 'quick' ? '快速' : '完整'], ['中斷', report.aborted ? '使用者停止' : report.interrupted_cells ? `${report.interrupted_cells} 個條件期間畫面曾被切走` : '無'], ['瀏覽器', d.userAgent]];
  $('deviceKv').innerHTML = kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  // matrix: rows n × dpr × speed, columns A / B / C
  const rows = new Map<string, Record<string, Record<string, unknown>>>();
  for (const m of report.matrix) { const key = `${m.n}|${m.dpr}|${m.speed}`; if (!rows.has(key)) rows.set(key, {}); (rows.get(key) as Record<string, Record<string, unknown>>)[m.renderer as string] = m; }
  const cell = (m?: Record<string, unknown>) => !m ? '<td>—</td>' : m.error ? '<td class="warn">錯誤</td>' : `<td${(m.fps_mean as number) < 30 ? ' class="warn"' : ''}>${f1(m.fps_mean)} / ${f1(m.fps_p5_low)}</td>`;
  $('matrixTable').innerHTML = '<thead><tr><th>條件</th><th>A 目前</th><th>B 圖集</th><th>C WebGL</th></tr></thead><tbody>' + [...rows].map(([k, r]) => { const [n, dpr, sp] = k.split('|'); return `<tr><td>${Number(n).toLocaleString()} 隻・DPR ${dpr === 'device' ? '裝置' : '1'}・${sp === 'fast' ? '快轉' : '1×'}</td>${cell(r.A)}${cell(r.B)}${cell(r.C)}</tr>`; }).join('') + '</tbody>';
  $('breakdownTable').innerHTML = '<thead><tr><th>方案</th><th>fps</th><th>p95 ms</th><th>地面</th><th>裝飾/物件</th><th>螞蟻</th><th>疊加層</th><th>其他 JS</th><th>其餘</th></tr></thead><tbody>' + report.breakdown.map((b) => { const l = (b.layers_ms ?? {}) as Record<string, number>, fm = (b.frame_ms ?? {}) as Record<string, number>; return b.error ? `<tr><td>${esc(String(b.label))}</td><td class="warn" colspan="8">${esc(String(b.error))}</td></tr>` : `<tr><td>${b.scene === 'replay' ? '' : '[1000 示範] '}${esc(String(b.label))}</td><td>${f1(b.fps_mean)}</td><td>${f1(fm.p95)}</td><td>${l.ground_chunks?.toFixed(2)}</td><td>${l.decor_and_objects?.toFixed(2)}</td><td>${l.ants?.toFixed(2)}</td><td>${l.overlays?.toFixed(2)}</td><td>${l.plan_and_other_js?.toFixed(2)}</td><td>${l.other_non_js?.toFixed(2)}</td></tr>`; }).join('') + '</tbody>';
  const st = report.stability as Record<string, unknown>, dr = (st.drift ?? {}) as S.Drift;
  $('stabilityKv').innerHTML = ([['時間', `${st.secs ?? '—'} 秒（${dr.windows} 個區段）`], ['fps 開始 → 結束', `${f1(dr.fps_first)} → ${f1(dr.fps_last)}（${dr.fps_change_pct ?? '—'}%）`], ['fps 漂移', `${dr.fps_drift_per_min ?? '—'} fps／分鐘`], ['記憶體成長', dr.heap_status === 'measured' ? `${dr.heap_first_mb} → ${dr.heap_last_mb} MB（${dr.heap_growth_mb_per_min} MB／分鐘）` : '無法取得（瀏覽器不提供）']] as [string, string][]).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  ($<HTMLTextAreaElement>('json')).value = JSON.stringify(report, null, 1);
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

// ------------------------------------------------------------------ controls
let lastReport: unknown = null;
async function start() {
  const mode = ($<HTMLInputElement>('modeFull')).checked ? 'full' : 'quick';
  abort = false; $('results').hidden = true; $('intro').hidden = true; stage.hidden = false; hudBar.style.width = '0';
  let lock: { release(): Promise<void> } | null = null;
  try { lock = await (navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } }).wakeLock?.request('screen') ?? null; } catch { lock = null; }
  await raf(); await raf();
  const report = await runAll(mode);
  const problems = S.validateReport(report);
  (report as Record<string, unknown>).schema_problems = problems;
  lastReport = report;
  try { await lock?.release(); } catch { /* ignore */ }
  stage.hidden = true; $('intro').hidden = false; $('results').hidden = false; render(report);
  $('results').scrollIntoView({ block: 'start' });
}
$('start').addEventListener('click', () => { void start().catch((e) => { stage.hidden = true; $('intro').hidden = false; $('startNote').textContent = '量測失敗：' + String((e as Error).message ?? e); }); });
$('again').addEventListener('click', () => { $('results').hidden = true; window.scrollTo(0, 0); });
$('stop').addEventListener('click', () => { abort = true; });
$('copy').addEventListener('click', () => {
  const ta = $<HTMLTextAreaElement>('json'), msg = $('copyMsg'), text = ta.value;
  const fallback = () => { ta.focus(); ta.select(); ta.setSelectionRange(0, text.length); let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; } msg.textContent = ok ? '已複製。' : '已選取全部文字，請用系統的「複製」。'; };
  try { navigator.clipboard.writeText(text).then(() => { msg.textContent = '已複製到剪貼簿。'; }, fallback); } catch { fallback(); }
});
// automation hook (headless verification only; reads, never writes)
(window as unknown as { __deviceBench: unknown }).__deviceBench = { report: () => lastReport, start: (mode: S.BenchMode) => { ($<HTMLInputElement>(mode === 'full' ? 'modeFull' : 'modeQuick')).checked = true; void start(); } };
