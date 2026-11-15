/**
 * Demo 2 performance tests (web/demo2-bench.html; Owner directive 2026-11-15, items 5 and 6) — a page of its own.
 *
 * Two kinds of test, never mixed:
 *  - 純渲染 (render): the Demo 2 scene plus N instances driven by the synthetic generator (bench-synth.ts). No Worker
 *    is started, no world exists, nothing is simulated. The whole screen is watermarked 「效能測試・合成資料，非模擬」.
 *  - 完整模擬 (sim): N ENGINE workers. A P0-A2 experiment world has a fixed 30 workers and this page changes no world
 *    parameter, so N workers = ceil(N / 30) INDEPENDENT colonies (different seeds, one Worker each, not interacting),
 *    the first N workers drawn through the same display director as Demo 2. It is NOT one colony of N ants; the
 *    watermark says so.
 * This page keeps nothing: it imports no session / save store, sends the Workers only scheduling commands
 * (init, step_until, set_speed, start) and terminates them after each case. It is NON-OFFICIAL and shows no engine
 * statistics. Every result records what really drew it (API from the backend object, GPU strings, classification);
 * software results are labelled 「軟體算繪，不是裝置結果」 (bench-report.ts).
 *
 * A full-simulation case stops itself and is reported as failed — instead of running out of memory — when frames
 * arrive too late, the page stops drawing, the JS heap nears its limit, a Worker fails, or start-up takes too long.
 */
import * as THREE from 'three';
import { ExperimentWorkerClient } from '../experimental/worker-client.ts';
import { isP0a2Frame, type EventMsg, type P0a2FrameMsg, type PacingMsg } from '../experimental/worker-protocol.ts';
import { VisModel, SEARCH_RADIUS_CM } from '../vis1-model.ts';
import { displayTime } from '../v62-model.ts';
import { MINOR_LEN_CM, MODEL_LEN } from '../three/ant-model.ts';
import { NestGraph, parseLayout } from './nest-graph.ts';
import { ColonyStage, type DrawnAnt } from './stage.ts';
import { corridor3, ground, source3 } from './surface.ts';
import { newGait, stepGait, type Gait } from './gait.ts';
import { RigLayer, rigMaterial } from './ant-rig.ts';
import { rigNodeMaterial, type RigNodeMaterial } from './ant-rig-tsl.ts';
import { buildScene, type Quality, type Scene2 } from './scene.ts';
import { synthPoint, SYNTH_LABEL_ZH } from './bench-synth.ts';
import { BENCH_SCHEMA, BENCH_SIZES, CLASS_LABEL_ZH, CLASS_RULE_ZH, MODE_LABEL_ZH, TABLE_HEAD, WORKERS_PER_WORLD, caseRow, adapterRecord, classifyGpu, frameStats, gpuLine, watchdog, webglStrings, worldsFor, type BenchCase, type BenchMode, type BenchResult, type GpuIdentity, type RendererApi, type SimStats, type WebGpuAdapterInfo } from './bench-report.ts';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = { canvas: $<HTMLCanvasElement>('scene'), mark: $('mark'), panel: $('panel'), gpu: $('gpu'), cls: $('cls'), mode: $<HTMLSelectElement>('mode'), n: $<HTMLSelectElement>('n'), one: $<HTMLButtonElement>('one'), all: $<HTMLButtonElement>('all'), stop: $<HTMLButtonElement>('stop'), progress: $('progress'), table: $('table'), json: $<HTMLTextAreaElement>('json'), copy: $<HTMLButtonElement>('copy'), fold: $<HTMLButtonElement>('fold'), back: $<HTMLAnchorElement>('back'), rule: $('rule') };
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const automated = navigator.webdriver === true || /HeadlessChrome/.test(navigator.userAgent);
const num = (k: string, d: number) => { const v = Number(q.get(k)); return q.get(k) !== null && Number.isFinite(v) && v > 0 ? v : d; };
const WARM_S = num('warm', 3), DUR_S = num('dur', 10), SPEED = num('speed', 5), START_T = num('t', 9 * 3600), SEED0 = num('seed0', 1), START_TIMEOUT_S = num('start_timeout', 240);
const narrow = innerWidth < 760;
const qParam = q.get('quality'), quality: Quality = qParam === 'high' || qParam === 'medium' || qParam === 'low' ? qParam : narrow || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'medium' : 'high';
const mag = num('mag', narrow ? 12 : 10), L = MINOR_LEN_CM * mag, SC = L / MODEL_LEN;
const wantWebGPU = q.get('renderer') === 'webgpu', offscreen = wantWebGPU && q.get('present') === 'offscreen';

// ---------- renderer and GPU identification ----------
let renderer: THREE.WebGLRenderer, api: RendererApi = 'webgl2', rendererNote = '', rigNode: RigNodeMaterial | null = null, offRT: THREE.RenderTarget | null = null, gpuLost = '';
let gpu: GpuIdentity;
/** WebGPU only: resolves when the work submitted so far has been executed (GPUQueue.onSubmittedWorkDone) */
let gpuDone: (() => Promise<unknown>) | null = null;
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);
async function makeRenderer() {
  let adapterInfo: WebGpuAdapterInfo | null = null;
  if (wantWebGPU) {
    type Adapter = Parameters<typeof adapterRecord>[0] & object;
    const g = (navigator as unknown as { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
    let adapter: Adapter | null = null; try { adapter = g ? await g.requestAdapter() : null; } catch { adapter = null; }
    if (adapter) {
      adapterInfo = adapterRecord(adapter);
      try {
        const G = await import('three/webgpu'), T = await import('three/tsl');
        const r = new G.WebGPURenderer({ canvas: ui.canvas, antialias: quality !== 'low' }); await r.init();
        if ((r.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true) { // the API in use comes from the backend object
          renderer = r as unknown as THREE.WebGLRenderer; api = 'webgpu'; rigNode = rigNodeMaterial(G, T);
          const dev = (r.backend as unknown as { device?: { lost: Promise<{ message: string }>; queue?: { onSubmittedWorkDone?: () => Promise<unknown> } } }).device;
          void dev?.lost.then((x) => { gpuLost = x.message || 'device lost'; });
          if (dev?.queue?.onSubmittedWorkDone) gpuDone = () => dev.queue!.onSubmittedWorkDone!();
        } else { r.dispose(); const c = ui.canvas.cloneNode(false) as HTMLCanvasElement; ui.canvas.replaceWith(c); ui.canvas = c; rendererNote = '要求了 WebGPU，但 three 改用了它的 WebGL 2 backend：本頁改用 WebGL 2 渲染器，結果記為 WebGL 2'; }
      } catch (e) { const c = ui.canvas.cloneNode(false) as HTMLCanvasElement; ui.canvas.replaceWith(c); ui.canvas = c; rendererNote = `要求了 WebGPU，但建立失敗（${(e as Error).message}）：結果記為 WebGL 2`; }
    } else rendererNote = g ? '要求了 WebGPU，但拿不到 adapter：結果記為 WebGL 2' : '要求了 WebGPU，但這個瀏覽器沒有 navigator.gpu：結果記為 WebGL 2';
  }
  if (api === 'webgl2') {
    renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
    gpu = { api, ...webglStrings(renderer.getContext()), webgpu_adapter: adapterInfo };
  } else {
    let gl: WebGL2RenderingContext | null = null; try { gl = document.createElement('canvas').getContext('webgl2'); } catch { gl = null; }
    gpu = { api, ...webglStrings(gl), webgpu_adapter: adapterInfo };
  }
  renderer.info.autoReset = false; renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.98;
  renderer.shadowMap.type = api === 'webgl2' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 2 : quality === 'medium' ? 1.5 : 1)); renderer.shadowMap.enabled = quality === 'high';
}
const rInfo = () => { const r = renderer.info.render as unknown as { calls: number; drawCalls?: number; triangles: number }; return { calls: r.drawCalls ?? r.calls, triangles: r.triangles }; };
function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false);
  if (offscreen && api === 'webgpu') { const pr = renderer.getPixelRatio(); if (!offRT) offRT = new THREE.RenderTarget(Math.round(w * pr), Math.round(h * pr), { depthBuffer: true }); else offRT.setSize(Math.round(w * pr), Math.round(h * pr)); }
  camera.aspect = w / h; camera.updateProjectionMatrix();
  // the Demo's default 完整剖面 framing (fixed for the whole test: the camera never moves)
  const tall = w < h, hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * camera.aspect), dist = Math.min(640, (tall ? 27 : 50) / Math.tan(hfov / 2)), el = ((tall ? 22 : 14) * Math.PI) / 180, az = ((tall ? 0 : -7) * Math.PI) / 180, tx = tall ? 4 : 8, ty = tall ? 0 : -10;
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * dist, ty + Math.sin(el) * dist, Math.cos(az) * Math.cos(el) * dist); camera.lookAt(tx, ty, 0);
}

// ---------- scene and instances ----------
let graph: NestGraph, world: Scene2;
const uTime = { value: 0 };
let hi: RigLayer, lo: RigLayer, blobs: THREE.InstancedMesh;
const CAP = Math.max(...BENCH_SIZES) + WORKERS_PER_WORLD;
const M4 = new THREE.Matrix4(), Qb = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3(), QI = new THREE.Quaternion();
function basis(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number, out: THREE.Quaternion) {
  X.set(fx, fy, fz); if (X.lengthSq() < 1e-9) X.set(1, 0, 0); X.normalize(); Y.set(ux, uy, uz);
  Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 0, 1); Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 1, 0); Z.crossVectors(X, Y); } }
  Z.normalize(); Y.crossVectors(Z, X).normalize(); return out.setFromRotationMatrix(M4.makeBasis(X, Y, Z));
}
function buildAll(raw: unknown) {
  graph = new NestGraph(parseLayout(raw), ground(0, 0));
  // scenery only: the route line of the display model for seed 1 (the same picture in both test modes)
  const vis = new VisModel(1, 200, 100);
  world = buildScene({ graph, corridor: corridor3(vis), source: source3(vis), searchRadius: SEARCH_RADIUS_CM }); world.setQuality(quality); world.demoProps.visible = false; scene.add(world.group);
  const sun = new THREE.DirectionalLight(0xffffff, 2.0), hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b4a2e, 0.95), lamp = new THREE.DirectionalLight(0xffeed8, 2.1), tgt = new THREE.Object3D();
  tgt.position.set(60, 0, -50); sun.position.set(60 + 250, 320, -50 + 180); sun.target = tgt; sun.castShadow = quality === 'high'; sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 110, bottom: -110, near: 10, far: 900 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
  lamp.position.set(10, 10, 200); lamp.target.position.set(10, -16, 0); scene.add(tgt, sun, hemi, lamp, lamp.target); scene.background = new THREE.Color(0x9fbdd0);
  const mat = rigNode ? rigNode.material as unknown as THREE.MeshStandardMaterial : rigMaterial(uTime);
  hi = new RigLayer('minor', 'hi', CAP, mat); lo = new RigLayer('minor', 'lo', CAP, mat); scene.add(hi.mesh, lo.mesh);
  const c = document.createElement('canvas'); c.width = c.height = 64; const g2 = c.getContext('2d')!, gr = g2.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }), CAP); blobs.frustumCulled = false; blobs.count = 0; blobs.renderOrder = 1; scene.add(blobs);
}
/** one instance into the hi / lo layer by its size on screen (the Demo's rule) */
let nh = 0, nl = 0, nb = 0, pxPerCm = 1;
function put(x: number, y: number, z: number, qt: THREE.Quaternion, g: Gait, crop: number, tone: number, seed: number, shadowBlob: boolean) {
  const dist = camera.position.distanceTo(V.set(x, y, z)), big = (L / Math.max(0.01, dist)) * pxPerCm > (quality === 'low' ? 34 : 18), layer = big ? hi : lo, i = big ? nh++ : nl++;
  M4.compose(V, qt, S.setScalar(SC)); layer.mesh.setMatrixAt(i, M4); layer.mesh.setColorAt(i, C.setRGB(tone, tone * 0.98, tone * 0.95));
  layer.anim.setXYZW(i, g.phase, g.walk, seed, g.act); layer.pose.setXYZW(i, crop, g.pitch, g.antUp, g.crouch); layer.xf.setXYZW(i, qt.x, qt.y, qt.z, qt.w); layer.scl.setX(i, SC);
  if (shadowBlob) { M4.compose(V.set(x, y + 0.05, z), QI, S.set(L * 0.95, 1, L * 0.6)); blobs.setMatrixAt(nb++, M4); }
}
const commit = () => { hi.commit(nh); lo.commit(nl); blobs.count = nb; blobs.instanceMatrix.needsUpdate = true; };

// ---------- the two instance sources ----------
interface Slot { gait: Gait; quat: THREE.Quaternion | null }
/** render-only: N synthetic instances (bench-synth.ts); no Worker, no world */
class SynthSource {
  private slots: Slot[] = []; private t = 0; readonly n: number;
  constructor(n: number) { this.n = n; for (let i = 0; i < n; i++) this.slots.push({ gait: newGait(), quat: null }); }
  draw(dt: number) {
    this.t += dt;
    for (let i = 0; i < this.n; i++) {
      const p = synthPoint(i, this.t, SEED0), y = ground(p.x, p.z), s = this.slots[i];
      stepGait(s.gait, { x: p.x, y, z: p.z, moving: p.moving, pose: p.moving ? 'walk' : 'stand' }, dt, L);
      const want = basis(p.fx, 0, p.fz, 0, 1, 0, Qb); if (!s.quat) s.quat = want.clone(); else s.quat.slerp(want, 1 - Math.exp(-dt * 11));
      put(p.x, y, p.z, s.quat, s.gait, p.crop, 0.9 + (i % 23) / 100, (i % 9973) / 9973, true);
    }
    return this.n;
  }
}
/** full simulation: ceil(N / 30) independent experiment worlds, each in its own Worker; the first N workers are drawn */
interface W { client: ExperimentWorkerClient; seed: number; frame: P0a2FrameMsg | null; pacing: PacingMsg | null; frameAt: number; lastT: number | null; vis: VisModel | null; stage: ColonyStage; slots: Map<string, Slot>; t0: number; wall0: number; msgs: number; events: number; err: string | null }
class SimSource {
  readonly worlds: W[] = []; readonly n: number; bytesSum = 0; bytesN = 0; lagging = false;
  constructor(n: number) {
    this.n = n;
    for (let i = 0; i < worldsFor(n); i++) {
      const w: W = { client: new ExperimentWorkerClient(), seed: SEED0 + i, frame: null, pacing: null, frameAt: 0, lastT: null, vis: null, stage: new ColonyStage(graph, L), slots: new Map(), t0: 0, wall0: 0, msgs: 0, events: 0, err: null };
      w.client.onState = (fr, p) => {
        if (!isP0a2Frame(fr)) return; w.frame = fr; w.pacing = p; w.frameAt = performance.now(); w.msgs++; if (p.lagging) this.lagging = true;
        if (w.msgs % 16 === 1) { this.bytesSum += JSON.stringify(fr).length + 120; this.bytesN++; } // size ESTIMATE from sampled frames
      };
      w.client.onEvents = (evs: EventMsg[]) => { w.events += evs.length; w.stage.onEvents(evs); };
      w.client.onProtocolError = (why) => { w.err = why; };
      this.worlds.push(w);
    }
  }
  /** scheduling only: init, fast-forward to the start instant, set the speed, start */
  async start(alive: () => boolean) {
    await Promise.all(this.worlds.map(async (w, i) => {
      const r = await w.client.init(`exp-demo2-bench-${i}`, w.seed, 'p0a2-colony'); if (r.type === 'error') throw new Error(`init: ${r.code} ${r.message}`);
      await w.client.stepUntil(START_T); await w.client.setSpeed(SPEED);
    }));
    if (!alive()) return;
    await Promise.all(this.worlds.map(async (w) => { await w.client.start(); w.vis = VisModel.of(w.frame!); w.t0 = w.frame!.t_sim; w.wall0 = performance.now(); w.msgs = 0; w.events = 0; }));
  }
  draw(dt: number, now: number) {
    let n = 0;
    for (const w of this.worlds) {
      if (!w.frame || !w.vis) continue;
      const run = !!w.pacing?.running, t = displayTime(w.frame.t_sim, run, w.pacing?.speed ?? SPEED, now - w.frameAt, w.lastT); w.lastT = run ? t : null;
      const drawn: DrawnAnt[] = w.stage.update(w.frame, w.vis, t, dt);
      for (const a of drawn) {
        if (n >= this.n) break; n++;
        let s = w.slots.get(a.id); if (!s) { s = { gait: newGait(), quat: null }; w.slots.set(a.id, s); }
        stepGait(s.gait, a, dt, L);
        const want = basis(a.fx, a.fy, a.fz, a.ux, a.uy, a.uz, Qb); if (!s.quat || s.gait.cut) s.quat = want.clone(); else s.quat.slerp(want, 1 - Math.exp(-dt * 11));
        put(a.x, a.y, a.z, s.quat, s.gait, Math.max(0, Math.min(1, a.crop)), 0.9 + (n % 23) / 100, (n % 9973) / 9973, a.realm === 'surface');
      }
    }
    return n;
  }
  /** wall seconds the newest frame of the slowest world is behind real-time pacing (queue backlog + Worker slowness) */
  lag(now: number) { let m = 0; for (const w of this.worlds) if (w.frame && w.wall0) m = Math.max(m, (now - w.wall0) / 1000 - (w.frame.t_sim - w.t0) / SPEED); return m; }
  error() { return this.worlds.find((w) => w.err || w.client.failure)?.err ?? this.worlds.find((w) => w.client.failure)?.client.failure?.message ?? null; }
  stop() { for (const w of this.worlds) w.client.terminate(); }
}

// ---------- frame loop ----------
let source: SynthSource | SimSource | null = null, drawnNow = 0, lastNow = performance.now(), lastFrameAt = performance.now();
const frameIv: number[] = [], cpuMs: number[] = []; let recording = false;
function tick(now: number) {
  const dt = Math.min(0.1, (now - lastNow) / 1000), iv = now - lastNow; lastNow = now; lastFrameAt = performance.now();
  const c0 = performance.now();
  uTime.value += dt; rigNode?.setTime(uTime.value);
  nh = nl = nb = 0; pxPerCm = ui.canvas.clientHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
  drawnNow = source instanceof SimSource ? source.draw(dt, performance.now()) : source ? source.draw(dt) : 0;
  commit();
  if (!gpuLost) {
    renderer.info.reset();
    if (offRT) renderer.setRenderTarget(offRT as unknown as THREE.WebGLRenderTarget);
    try { renderer.render(scene, camera); } catch (e) { gpuLost = (e as Error).message; }
  }
  if (recording) { frameIv.push(iv); cpuMs.push(performance.now() - c0); }
  // WebGPU submits work without waiting for it: a frame only counts once the GPU queue has finished it, otherwise the
  // "frame rate" would be the rate of requestAnimationFrame callbacks while unfinished frames pile up
  if (gpuDone && !gpuLost) void gpuDone().then(() => requestAnimationFrame(tick), (e) => { gpuLost = String((e as Error).message ?? e); requestAnimationFrame(tick); });
  else requestAnimationFrame(tick);
}

// ---------- running cases ----------
const heap = () => { const m = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory; return m ? { used: m.usedJSHeapSize / 1048576, limit: m.jsHeapSizeLimit / 1048576 } : null; };
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let cancelled = false, busy = false;
const cases: BenchCase[] = [];
function setMark(mode: BenchMode | null, n = 0) {
  const text = mode === 'render' ? SYNTH_LABEL_ZH : mode === 'sim' ? `效能測試・${worldsFor(n)} 個互不相干的獨立蟻群（不是一個 ${n} 隻的蟻群）・非正式實驗世界` : '效能測試頁・尚未執行';
  ui.mark.dataset.mode = mode ?? 'idle'; ui.mark.innerHTML = Array.from({ length: 14 }, () => `<span>${esc(text)}</span>`).join('');
}
function blank(mode: BenchMode, n: number): BenchCase {
  return { mode, n, status: 'failed', reason: null, warm_s: WARM_S, dur_s: DUR_S, frames: 0, fps_mean: 0, fps_p5_low: 0, frame_ms: { p50: NaN, p95: NaN, p99: NaN, max: NaN }, cpu_ms: { p50: NaN, p95: NaN }, draw_calls: 0, triangles: 0, heap_mb: null, heap_series_mb: [], quality, dpr: renderer.getPixelRatio(), canvas: [ui.canvas.width, ui.canvas.height], sim: null };
}
async function runCase(mode: BenchMode, n: number, say: (s: string) => void): Promise<BenchCase> {
  const out = blank(mode, n); setMark(mode, n);
  let sim: SimSource | null = null;
  const fail = (why: string) => { out.status = 'failed'; out.reason = why; return out; };
  try {
    if (gpuLost) return fail(`繪圖裝置遺失（${gpuLost}）`);
    if (mode === 'render') source = new SynthSource(n);
    else {
      sim = new SimSource(n); const t0 = performance.now(); let started = false, startErr: string | null = null;
      say(`啟動 ${sim.worlds.length} 個 Worker 並排程到開始時刻…`);
      void sim.start(() => !cancelled).then(() => { started = true; }, (e) => { startErr = (e as Error).message; });
      while (!started) {
        if (startErr) return fail(`啟動失敗：${startErr}`);
        if (cancelled) return fail('已取消');
        if ((performance.now() - t0) / 1000 > START_TIMEOUT_S) return fail(`啟動超過 ${START_TIMEOUT_S} 秒：停止`);
        const h = heap(), why = watchdog({ elapsed_s: 0, heap_mb: h?.used ?? null, heap_limit_mb: h?.limit ?? null, lag_s: 0, frame_gap_s: 0, worker_error: sim.error() }); if (why) return fail(why);
        await sleep(200);
      }
      source = sim; out.sim = { worlds: sim.worlds.length, drawn: 0, seeds: sim.worlds.map((w) => w.seed), start_s: Math.round((performance.now() - t0) / 100) / 10, msgs_per_s: 0, bytes_per_s_est: 0, frame_bytes_est: 0, sim_events_per_s: 0, ratio_requested: SPEED, ratio_achieved_mean: 0, ratio_achieved_min: 0, lag_s_max: 0 };
    }
    // warm-up, then the measured window; the watchdog runs through both
    const h0 = heap(); let hMax = h0?.used ?? 0, lagMax = 0, seriesAt = 0; const series: number[] = [];
    const phase = async (secs: number, label: string) => {
      const end = performance.now() + secs * 1000;
      while (performance.now() < end) {
        await sleep(250);
        const now = performance.now(), h = heap(), lag = sim ? sim.lag(now) : 0; if (h) hMax = Math.max(hMax, h.used); lagMax = Math.max(lagMax, lag);
        if (cancelled) return '已取消';
        const why = watchdog({ elapsed_s: 0, heap_mb: h?.used ?? null, heap_limit_mb: h?.limit ?? null, lag_s: lag, frame_gap_s: document.visibilityState === 'visible' ? (now - lastFrameAt) / 1000 : 0, worker_error: sim?.error() ?? null });
        if (why) return why;
        if (gpuLost) return `繪圖裝置遺失（${gpuLost}）`;
        if (label === '量測' && h && now - seriesAt >= 1000) { series.push(Math.round(h.used)); seriesAt = now; } // memory over time: one sample per second
        say(`${label} ${Math.max(0, (end - now) / 1000).toFixed(0)} 秒`);
      }
      return null;
    };
    let why = await phase(WARM_S, '暖機'); if (why) return fail(why);
    const snap = sim ? sim.worlds.map((w) => ({ t: w.frame!.t_sim, wall: performance.now(), msgs: w.msgs, events: w.events })) : [];
    if (sim) { sim.bytesSum = 0; sim.bytesN = 0; }
    frameIv.length = 0; cpuMs.length = 0; recording = true; const m0 = performance.now();
    why = await phase(DUR_S, '量測'); recording = false; if (why) return fail(why);
    const secs = (performance.now() - m0) / 1000, st = frameStats(frameIv, cpuMs), info = rInfo(), h1 = heap();
    Object.assign(out, st, { status: 'ok', draw_calls: info.calls, triangles: info.triangles, heap_mb: h0 && h1 ? { start: Math.round(h0.used), end: Math.round(h1.used), max: Math.round(hMax) } : null, heap_series_mb: series, canvas: [ui.canvas.width, ui.canvas.height] });
    if (st.frames < 2) return fail('量測期間畫面沒有更新（分頁可能在背景）');
    if (sim && out.sim) {
      const s = out.sim as SimStats, ratios = sim.worlds.map((w, i) => (w.frame!.t_sim - snap[i].t) / ((performance.now() - snap[i].wall) / 1000)), fb = sim.bytesN ? sim.bytesSum / sim.bytesN : 0;
      const msgs = sim.worlds.reduce((a, w, i) => a + w.msgs - snap[i].msgs, 0), evs = sim.worlds.reduce((a, w, i) => a + w.events - snap[i].events, 0);
      s.drawn = drawnNow; s.msgs_per_s = Math.round((msgs / secs) * 10) / 10; s.frame_bytes_est = Math.round(fb); s.bytes_per_s_est = Math.round((msgs / secs) * fb); s.sim_events_per_s = Math.round((evs / secs) * 10) / 10;
      s.ratio_achieved_mean = Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 100) / 100; s.ratio_achieved_min = Math.round(Math.min(...ratios) * 100) / 100; s.lag_s_max = Math.round(lagMax * 100) / 100;
      if (sim.lagging) out.reason = 'Worker 回報過 lagging（單步工作量超過預算，世界較慢到達目標時刻；事件不會被跳過）';
      if (s.drawn !== n) return fail(`只畫出 ${s.drawn} 隻引擎工蟻（要求 ${n}）`);
    }
    return out;
  } catch (e) { return fail(`例外：${(e as Error).message}`); }
  finally { recording = false; source = null; sim?.stop(); nh = nl = nb = 0; commit(); await sleep(400); }
}
function result(): BenchResult {
  const v = classifyGpu(gpu), mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
  return {
    schema: BENCH_SCHEMA, when_utc: new Date().toISOString(), page: 'web/demo2-bench.html', three: THREE.REVISION,
    gpu, gpu_class: v.class, gpu_rule: v.rule, measurement_class: v.class, label_zh: CLASS_LABEL_ZH[v.class],
    frame_pacing: gpuDone ? 'raf_after_gpu_queue_done' : 'raf',
    renderer_requested: wantWebGPU ? 'webgpu' : 'webgl2', renderer_api: api, renderer_note: rendererNote + (offscreen && api === 'webgpu' ? '（離屏繪圖：畫到 render target，沒有呈現到螢幕）' : ''),
    automated, user_agent: navigator.userAgent, viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio }, hardware_concurrency: navigator.hardwareConcurrency ?? null, device_memory_gb: mem ?? null,
    cases: cases.map((c) => ({ ...c })),
    notes_zh: [
      '純渲染＝合成資料，非模擬：沒有啟動任何 Worker，數字只代表繪圖與本頁的每幀工作。',
      `完整模擬＝每 ${WORKERS_PER_WORLD} 隻一個獨立的 P0-A2 候選世界（不同種子、各自的 Worker、互不相干），只畫前 N 隻；不是一個 N 隻的蟻群。沒有修改任何世界參數。`,
      'JS heap 只含本頁主執行緒（Chromium 才有）；不含各 Worker 的記憶體與尚未處理的訊息佇列。Worker→主執行緒位元組數是以抽樣狀態框的 JSON 長度估計。',
      gpuDone ? 'WebGPU：每一幀等 GPU 佇列執行完（onSubmittedWorkDone）才要求下一幀，幀時間包含 GPU 完成時間。' : 'WebGL 2：幀時間是 requestAnimationFrame 的間隔。',
      '模擬時間與畫面更新分開：畫面變慢不會改變任何事件；本頁只送排程指令（init、step_until、set_speed、start），不存檔。',
      v.class === 'software' ? '軟體算繪，不是裝置結果：不能代表任何手機或電腦的 GPU 效能。' : v.class === 'unknown' ? '瀏覽器沒有回報可辨識的 GPU 字串：不能當成真實 GPU 的結果。' : '依瀏覽器回報的字串判定為真實 GPU；請連同裝置型號一起回報。',
    ],
  };
}
function render() {
  const r = result();
  ui.table.innerHTML = cases.length ? `<table><tr>${TABLE_HEAD.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${cases.map((c) => `<tr class="${c.status}">${caseRow(c).map((x) => `<td>${esc(x)}</td>`).join('')}</tr>`).join('')}</table>` : '';
  ui.json.value = cases.length ? JSON.stringify(r) : '';
  document.body.classList.toggle('has-results', cases.length > 0);
  hooks.result = cases.length ? r : null;
}
async function runMatrix(list: { mode: BenchMode; n: number }[]) {
  if (busy) return; busy = true; cancelled = false; cases.length = 0; hooks.done = false; hooks.running = true;
  ui.one.disabled = ui.all.disabled = true; ui.stop.hidden = false; document.body.classList.add('running'); render();
  for (let i = 0; i < list.length; i++) {
    const { mode, n } = list[i], head = `(${i + 1}/${list.length}) ${MODE_LABEL_ZH[mode]} ${n} 隻`;
    const c = cancelled ? { ...blank(mode, n), status: 'skipped' as const, reason: '已取消' } : await runCase(mode, n, (s) => { ui.progress.textContent = `${head}：${s}`; hooks.progress = `${head}：${s}`; });
    cases.push(c); render();
  }
  setMark(null); busy = false; hooks.running = false; hooks.done = true;
  ui.one.disabled = ui.all.disabled = false; ui.stop.hidden = true; document.body.classList.remove('running', 'folded');
  ui.progress.textContent = `完成 ${cases.filter((c) => c.status === 'ok').length}／${cases.length} 項。下面的 JSON 可以整段複製貼回。`; hooks.progress = 'done';
}
const parseList = (s: string | null, all: readonly string[]) => (s ? s.split(',').map((x) => x.trim()).filter((x) => all.includes(x)) : [...all]);
function matrix(): { mode: BenchMode; n: number }[] {
  const sizes = parseList(q.get('sizes'), BENCH_SIZES.map(String)).map(Number), modes = parseList(q.get('modes'), ['render', 'sim']) as BenchMode[];
  return modes.flatMap((mode) => sizes.map((n) => ({ mode, n })));
}

const hooks: { ready: boolean; running: boolean; done: boolean; progress: string; result: BenchResult | null; gpu: () => GpuIdentity; run: (list: { mode: BenchMode; n: number }[]) => Promise<void>; state: () => unknown } = {
  ready: false, running: false, done: false, progress: '', result: null, gpu: () => gpu, run: (list) => runMatrix(list),
  state: () => ({ api, quality, drawn: drawnNow, hi: hi?.mesh.count ?? 0, lo: lo?.mesh.count ?? 0, mark: ui.mark.dataset.mode, mark_text: ui.mark.textContent, busy, calls: rInfo().calls }),
};
(window as unknown as { __bench: typeof hooks }).__bench = hooks;

async function main() {
  try { await makeRenderer(); } catch (e) { ui.progress.textContent = `無法建立繪圖環境（${(e as Error).message}）`; return; }
  const v = classifyGpu(gpu);
  ui.gpu.textContent = gpuLine(gpu) + (rendererNote ? `｜${rendererNote}` : ''); ui.cls.textContent = `${v.class}｜${CLASS_LABEL_ZH[v.class]}`; ui.cls.dataset.cls = v.class; ui.cls.title = v.rule;
  ui.rule.innerHTML = `<b>分類規則</b>（這次的依據：${esc(v.rule)}）<ol>${CLASS_RULE_ZH.map((s) => `<li>${esc(s.replace(/^\d+\.\s*/, ''))}</li>`).join('')}</ol>`;
  ui.n.innerHTML = BENCH_SIZES.map((n) => `<option value="${n}">${n} 隻</option>`).join('');
  const u = new URL('demo2.html', location.href); if (wantWebGPU) u.searchParams.set('renderer', 'webgpu'); ui.back.href = u.href;
  buildAll(await (await fetch('vendor/demo2/nest-layout.json')).json());
  resize(); addEventListener('resize', resize); setMark(null);
  requestAnimationFrame((t) => { lastNow = t; requestAnimationFrame(tick); });
  ui.one.onclick = () => void runMatrix([{ mode: ui.mode.value as BenchMode, n: Number(ui.n.value) }]);
  ui.all.onclick = () => void runMatrix(matrix());
  ui.stop.onclick = () => { cancelled = true; ui.progress.textContent = '取消中…'; };
  ui.fold.onclick = () => document.body.classList.toggle('folded');
  ui.copy.onclick = async () => { ui.json.select(); try { await navigator.clipboard.writeText(ui.json.value); ui.copy.textContent = '已複製'; } catch { document.execCommand('copy'); ui.copy.textContent = '已選取（請手動複製）'; } };
  ui.progress.textContent = `預設：暖機 ${WARM_S} 秒、每項量測 ${DUR_S} 秒、模擬 ${SPEED}×、畫質 ${quality}。量測中請不要切換分頁或鎖螢幕。`;
  hooks.ready = true;
  if (q.get('auto') === '1') void runMatrix(matrix());
}
main().catch((e) => { console.error(e); ui.progress.textContent = `載入失敗：${(e as Error).message}`; });
