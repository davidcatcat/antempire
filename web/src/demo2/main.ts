/**
 * Demo 2 page (web/demo2.html) — one operable world: the garden surface and the nest cross-section in the same 3-D
 * scene, the same individual (same id) from chamber → tunnel → entrance → surface → food and back.
 *
 * NON-OFFICIAL experiment world (P0-A2 candidate). The simulation runs ONLY in the experiment Web Worker; this page
 * talks to it through web/src/experimental/worker-client.ts (and the SAVE-2 session / save store for local saves) and
 * sends nothing but scheduling (init / step_until / start / pause / resume / set_speed), observation (follow,
 * snapshot) and restore-of-a-verified-snapshot commands. It imports no engine, Worker or cli module. Rendering, zoom,
 * view, follow, quality and the 展示情境 toggle can never change an event: none of them is sent to the Worker.
 *
 * Data categories on screen (legend panel):
 *  引擎        worker state and instants, crop / gut fill, route length, trophallaxis and larva-feeding events, light;
 *  顯示插值    positions between two engine instants (route trips; moves to / from the entrance);
 *  展示假設    the fixed nest geometry, every in-nest position and walk, the garden scenery, the ants' magnification;
 *  示範資料    queens, major workers, eggs, pupae and the inert food props — ONLY in 展示情境 mode, never saved.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ExperimentWorkerClient } from '../experimental/worker-client.ts';
import { ExperimentSession } from '../experimental/session.ts';
import { ExperimentSaveStore } from '../experimental/save-store.ts';
import { notSimulatedOf, type NotSimulatedView, type SaveUiState } from '../experimental/save-format.ts';
import { isP0a2Frame, type EventMsg, type P0a2FrameMsg, type PacingMsg, type WorldKind } from '../experimental/worker-protocol.ts';
import { STATE_LABEL, P0_LIGHT_LABEL, P0A2_STATUS_LABEL } from '../v62-p0a2-model.ts';
import { VisModel, SEARCH_RADIUS_CM } from '../vis1-model.ts';
import { displayTime, fmtWorldTime, clockOf } from '../v62-model.ts';
import { hash32 } from '../game-model.ts';
import { MINOR_LEN_CM, MODEL_LEN } from '../three/ant-model.ts';
import { summarise, measurementClass } from '../three/perf.ts';
import { NestGraph, parseLayout, type P3, type Pos } from './nest-graph.ts';
import { ColonyStage, CLASS_LABEL, STAGE_DISCONTINUITIES, CATCHUP_MAX_S, type DrawnAnt } from './stage.ts';
import { BLOCK, corridor3, ground, source3 } from './surface.ts';
import { roster, colonyOf, CASTES, CASTE_LABEL, DEMO_BADGE, NATURAL_BADGE, DEMO_FOOD_PROPS, DEMO_ROUTINE_LABEL, type Individual, type Mode, type Roster } from './feed.ts';
import { eggSpot, larvaSpot, majorSpot, pupaSpot, queenPlace } from './places.ts';
import type { Body } from './separate.ts';
import { POSE_TARGET, gaitPhase, stanceAmp, strideCm, type PoseValues } from './gait.ts';
import { CLOCK_WRAP_S } from './rig-params.ts';
import { placeLabels, type LabelBox } from './labels.ts';
import { MORPHS, RigLayer, rigMaterial, larvaGeometry, pupaGeometry, eggGeometry, type RigCaste } from './ant-rig.ts';
import { rigNodeMaterial, type RigNodeMaterial } from './ant-rig-tsl.ts';
import { buildScene, type Quality, type Scene2 } from './scene.ts';
import { Hd2dPipeline, PIXEL_FACTORS, type Hd2dEffects } from './hd2d.ts';
import { nextShot, tourMayRun, TOUR_IDLE_S, TOUR_REASON_ZH, type TourCue, type TourShot } from './tour.ts';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('scene'), badge: $('modeBadge'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), hud: $('hud'),
  viewFull: $<HTMLButtonElement>('viewFull'), viewSurface: $<HTMLButtonElement>('viewSurface'), viewUnder: $<HTMLButtonElement>('viewUnder'), modeBtn: $<HTMLButtonElement>('modeBtn'),
  followBtn: $<HTMLButtonElement>('followBtn'), sideBtn: $<HTMLButtonElement>('sideBtn'), card: $('card'), labels: $('labels'), lblLegend: $('lblLegend'), top: $('top'), side: $('side'), toast: $('toast'), fatal: $('fatal'),
  stats: $('pane-stats'), legend: $('pane-legend'), notsim: $('pane-notsim'), perf: $('pane-perf'), worldInfo: $('worldInfo'), saveBtn: $<HTMLButtonElement>('saveBtn'), saveStatus: $('saveStatus'),
  more: $('more'), moreBtn: $<HTMLButtonElement>('moreBtn'), tourBtn: $<HTMLButtonElement>('tourBtn'), perfBtn: $<HTMLButtonElement>('perfBtn'), tourChip: $<HTMLButtonElement>('tourChip'), statusRow: $('statusRow'), peek: $('peek'), grip: $('grip'), peekText: $('peekText'), paneAnt: $('pane-ant'),
  seedIn: $<HTMLInputElement>('seedIn'), restartBtn: $<HTMLButtonElement>('restartBtn'), resetDemoBtn: $<HTMLButtonElement>('resetDemoBtn'), demoInfo: $('demoInfo'), saveList: $('saveList'), importBtn: $<HTMLButtonElement>('importBtn'), importFile: $<HTMLInputElement>('importFile'),
};
const narrow = () => innerWidth < 760;
const START_T = Number(q.get('t') ?? 9 * 3600); // world time a NEW world is fast-forwarded to (scheduling only: step_until)
/** default seed of a new Demo world: the reproducible identification seed of Owner ruling #202 (not a chosen seed) */
const DEFAULT_SEED = 20261113;
const SPEEDS = [1, 2, 5, 10, 30, 60];
const automated = navigator.webdriver === true || /HeadlessChrome/.test(navigator.userAgent);
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
function toast(s: string, ms = 3800) { ui.toast.textContent = s; ui.toast.hidden = false; clearTimeout(toastH); toastH = window.setTimeout(() => { ui.toast.hidden = true; }, ms); }
let toastH = 0;
function fatal(html: string) { ui.fatal.innerHTML = `<div>${html}<br><a class="btn" href="experiment.html">改開 2D 實驗頁</a></div>`; ui.fatal.hidden = false; }

// ---------- renderer: WebGL 2 by default; `?renderer=webgpu` opts into three's WebGPURenderer (docs/demo2.md) ----------
/** what actually draws: 'webgl2' = THREE.WebGLRenderer; 'webgpu' = WebGPURenderer on a real WebGPU backend;
 *  'webgpu-webgl2' = WebGPURenderer on ITS WebGL 2 backend (only with ?backend=webgl2: the node-material path, not WebGPU) */
type RendererKind = 'webgl2' | 'webgpu' | 'webgpu-webgl2';
let rendererKind: RendererKind = 'webgl2', rendererNote = '', rigNode: RigNodeMaterial | null = null;
const wantWebGPU = q.get('renderer') === 'webgpu', forceNodeGL = wantWebGPU && q.get('backend') === 'webgl2';
/** verification only (`?renderer=webgpu&present=offscreen`): draw into a texture instead of the canvas and read it back
 *  (headless Chromium's software WebGPU cannot present to a canvas; see docs/demo2.md) */
const offscreen = wantWebGPU && q.get('present') === 'offscreen';
let offRT: THREE.RenderTarget | null = null;
// ---------- picture style: 標準 (default) or the opt-in HD-2D post-processing look (WebGL 2 only; display only) ----------
type Style = 'standard' | 'hd2d';
let style: Style = q.get('style') === 'hd2d' ? 'hd2d' : 'standard', hd2d: Hd2dPipeline | null = null;
let pxFactor = (PIXEL_FACTORS as readonly number[]).includes(Number(q.get('px'))) ? Number(q.get('px')) : 3;
/** post effects that are on (auto quality switches depth of field off first, then bloom) */
const fx: Hd2dEffects = { dof: q.get('dof') !== '0', bloom: q.get('bloom') !== '0' };
const HD2D_ONLY_WEBGL2 = 'HD-2D 目前僅 WebGL 2';
const hd2dActive = () => style === 'hd2d' && hd2d !== null;
const fxText = () => hd2dActive() ? [`像素化 ${pxFactor === 1 ? '關' : `${pxFactor}×`}`, fx.dof ? '景深' : null, fx.bloom ? '泛光' : null, '色調', '暗角', '加密草葉', '浮塵', '光束（依引擎光照；夜間不畫）'].filter(Boolean).join('、') : '無（標準畫面）';
function setStyle(st: Style) {
  if (st === 'hd2d' && rendererKind !== 'webgl2') { style = 'standard'; toast(`${HD2D_ONLY_WEBGL2}：這個渲染器維持標準畫面`, 6000); }
  else style = st;
  world?.setStyle(style === 'hd2d'); if (renderer) resize(); perfCtlNow = ''; if (tab === 'perf' && !document.body.classList.contains('side-closed')) renderPerf();
}
function setPixelFactor(f: number) { pxFactor = f; if (renderer) resize(); perfCtlNow = ''; if (tab === 'perf' && !document.body.classList.contains('side-closed')) renderPerf(); }
/** draw calls and triangles of the last frame, whichever renderer runs */
const rInfo = () => { const r = renderer.info.render as unknown as { calls: number; drawCalls?: number; triangles: number }; return { calls: r.drawCalls ?? r.calls, triangles: r.triangles }; };
/** the WebGPU device was lost (or a draw failed): stop drawing, say so, offer the WebGL 2 page. The world keeps running. */
let gpuLost = false;
function webgpuLost(why: string) {
  if (gpuLost) return; gpuLost = true;
  rendererNote = `WebGPU 裝置遺失或無法在這個環境呈現畫面（${why || '沒有訊息'}）：畫面已停止更新；模擬與存檔不受影響`;
  const u = new URL(location.href); u.searchParams.delete('renderer'); u.searchParams.delete('backend'); u.searchParams.delete('present');
  ui.fatal.innerHTML = `<div>${esc(rendererNote)}<br><a class="btn" href="${esc(u.href)}">改用 WebGL 2 重新載入</a></div>`; ui.fatal.hidden = false;
}
/** a fresh canvas in place of the current one (a canvas that already gave out a context cannot serve another renderer) */
function swapCanvas() { const c = ui.canvas.cloneNode(false) as HTMLCanvasElement; ui.canvas.replaceWith(c); ui.canvas = c; bindCanvas(); }
function webgl2Available(): boolean { try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; } }
let renderer: THREE.WebGLRenderer, glInfo = '', backend = '';
const qParam = q.get('quality') as Quality | null, qualityLocked = qParam === 'high' || qParam === 'medium' || qParam === 'low';
let quality: Quality = qualityLocked ? qParam! : narrow() || (navigator.hardwareConcurrency ?? 8) <= 4 ? 'medium' : 'high';
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.5, 3000);
let controls: OrbitControls;
const sun = new THREE.DirectionalLight(0xffffff, 2.2), hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b4a2e, 0.95), lamp = new THREE.DirectionalLight(0xffeed8, 2.1);
const sunTarget = new THREE.Object3D(); sunTarget.position.set(60, 0, -50);

// ---------- world / display state ----------
const client = new ExperimentWorkerClient();
/** New Demo worlds are the candidate world 'p0a2-colony' (queens / majors / eggs / pupae as ENGINE individuals, static;
 *  docs/colony-candidate-world.md). `?world=p0a2` starts the plain P0-A2 world (those castes then 尚未模擬 / demo). */
const worldKind: WorldKind = q.get('world') === 'p0a2' ? 'p0a2' : 'p0a2-colony';
const PROBE_ID = 'exp-runtime-probe';
const isDemoWorld = (engine_version: string) => engine_version.startsWith('experiment-p0a2-');
let session: ExperimentSession | null = null, tempMode = q.has('seed');
let frame: P0a2FrameMsg | null = null, pacing: PacingMsg | null = null, frameAt = 0, lastT: number | null = null, tNow = 0, followedView: unknown = null;
let vis: VisModel | null = null, graph: NestGraph, stage: ColonyStage, world: Scene2 | null = null;
let running = false, speed = Number(q.get('speed') ?? 1), mode: Mode = q.get('mode') === 'demo' ? 'demo' : 'natural', demoSeed = DEFAULT_SEED, rost: Roster | null = null;
let mag = Number(q.get('mag') ?? (narrow() ? 12 : 10));
const antLen = () => MINOR_LEN_CM * mag;
let drawn: DrawnAnt[] = [], selected: string | null = null, following: string | null = null, disclosure: NotSimulatedView | null = null, saveUi: SaveUiState | null = null;
let eventsSeen = 0;
type View = 'full' | 'surface' | 'under';
let view: View = 'full';
/** static individuals drawn this frame (larvae and demo individuals): for picking and the card */
interface StaticDraw { ind: Individual; p: P3; chamber: string }
let statics: StaticDraw[] = [];

// ---------- meshes ----------
const uTime = { value: 0 };
let rigMat: THREE.MeshStandardMaterial;
const layers = {} as Record<'minorHi' | 'minorLo' | 'major' | 'queen', RigLayer>;
let larvaMesh: THREE.InstancedMesh, pupaMesh: THREE.InstancedMesh, eggMesh: THREE.InstancedMesh, blobs: THREE.InstancedMesh, planLine: THREE.Line;
/** wall-clock seconds for scenery only (grass sway); everything about an ant follows simulated time */
let sceneClock = 0;
const M4 = new THREE.Matrix4(), Qa = new THREE.Quaternion(), Qb = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();

function basis(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number, out: THREE.Quaternion): THREE.Quaternion {
  X.set(fx, fy, fz); if (X.lengthSq() < 1e-9) X.set(1, 0, 0); X.normalize(); Y.set(ux, uy, uz);
  Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 0, 1); Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 1, 0); Z.crossVectors(X, Y); } }
  Z.normalize(); Y.crossVectors(Z, X).normalize();
  return out.setFromRotationMatrix(M4.makeBasis(X, Y, Z));
}
/** how far the body is set below the walk line inside the nest so the feet touch the drawn floor (cm; display) */
const NEST_FOOT_DROP = 0.3;
/** what the viewer is told about the drawn motion (round 4): all of it is a display rule; evidence labels in docs/demo2.md §動作 */
const MOTION_NOTES = [
  '引擎沒有步行運動學、身體接觸與觸角接觸（整合矩陣 M21、M22：尚未模擬）。六足步態、轉向、觸角擺動、互相避讓、休息時的排列，全部是畫面規則，不是模擬結果，也不回寫引擎。',
  '步態：交替三腳步態，著地的腳不動、身體往前；步伐相位只跟「畫面上走過的距離」走，站著就不踏步。步長每隻略有不同（固定種子）。',
  '轉向：身體不會瞬間掉頭；大角度先原地轉身再走，轉彎與岔路會放慢。引擎時刻（出發、抵達）不變。',
  '觸角：行走時左右交替探索，休息時靜止。只有引擎有事件的接觸（交哺、接觸或餵食幼蟲）才畫成觸角朝向對方（姿勢是畫面演出；引擎記錄的是事件，不是觸角接觸）。兩隻只是在畫面上錯身而過時，不畫任何觸角接觸姿勢。',
  '避讓：兩隻螞蟻的身體不畫在一起——巢內只沿剖面深度錯開，不會被推進土裡；休息中的螞蟻不被推動。巢口一次只容一隻通過的瞬間仍可能重疊。',
  '休息與堆放：休息位置、朝向、幼蟲／蛹／卵堆都是固定種子的不規則排列（展示假設），部分休息位置在巢室後壁上。',
  '同一個世界時刻，不論畫面更新率或播放速度，畫出來的姿勢相同；暫停時完全靜止。',
];

function buildMeshes() {
  rigMat = rigNode ? rigNode.material as unknown as THREE.MeshStandardMaterial : rigMaterial(uTime); // same rig, GLSL or TSL (rig-params.ts)
  layers.minorHi = new RigLayer('minor', 'hi', 256, rigMat); layers.minorLo = new RigLayer('minor', 'lo', 256, rigMat);
  layers.major = new RigLayer('major', 'hi', 32, rigMat); layers.queen = new RigLayer('queen', 'hi', 32, rigMat);
  for (const l of Object.values(layers)) scene.add(l.mesh);
  const soft = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 });
  larvaMesh = new THREE.InstancedMesh(larvaGeometry(), soft, 96); pupaMesh = new THREE.InstancedMesh(pupaGeometry(), soft, 96); eggMesh = new THREE.InstancedMesh(eggGeometry(), soft, 256);
  for (const m of [larvaMesh, pupaMesh, eggMesh]) { m.count = 0; m.frustumCulled = false; m.setColorAt(0, C.setRGB(1, 1, 1)); scene.add(m); }
  const c = document.createElement('canvas'); c.width = c.height = 64; const g2 = c.getContext('2d')!, gr = g2.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.5)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, 64, 64);
  blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }), 256);
  blobs.frustumCulled = false; blobs.count = 0; blobs.renderOrder = 1; scene.add(blobs);
  planLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: 0xffe08a, dashSize: 0.6, gapSize: 0.5, transparent: true, opacity: 0.85, depthTest: false })); planLine.visible = false; planLine.renderOrder = 3; scene.add(planLine);
}

function setLight(f: P0a2FrameMsg) {
  const e = f.env, day = e.light === 'day', tw = e.light === 'civil_twilight', alt = day ? Math.max(8, e.sun_altitude_deg) : tw ? 5 : 32, az = e.before_solar_noon ? 1 : -1, a = (alt * Math.PI) / 180, dist = 500;
  sun.position.set(sunTarget.position.x + az * Math.cos(a) * dist * 0.8, Math.sin(a) * dist, sunTarget.position.z + Math.cos(a) * dist * 0.45);
  let bg: number;
  if (day) { sun.color.setHSL(0.11, 0.42, 0.5 + Math.min(0.42, alt / 120)); sun.intensity = 1.0 + Math.min(1.1, alt / 42); hemi.intensity = 0.95; hemi.color.set(0xcfe3ff); bg = 0x9fbdd0; }
  else if (tw) { sun.color.set(0xffa66b); sun.intensity = 0.95; hemi.intensity = 0.65; hemi.color.set(0xd9a98a); bg = 0x5b5470; }
  else { sun.color.set(0x9db4ff); sun.intensity = 0.55; hemi.intensity = 0.6; hemi.color.set(0x7f95c8); bg = 0x1d2433; } // night: brightened for viewing (示意)
  skyTint(bg);
}

/** background: a vertical gradient from the sky colour of the engine's light state down to a neutral studio floor */
let skyCanvas: HTMLCanvasElement, skyTex: THREE.CanvasTexture, skyNow = -1;
function skyTint(bg: number) {
  if (bg === skyNow) return; skyNow = bg;
  if (!skyCanvas) { skyCanvas = document.createElement('canvas'); skyCanvas.width = 4; skyCanvas.height = 256; skyTex = new THREE.CanvasTexture(skyCanvas); skyTex.colorSpace = THREE.SRGBColorSpace; scene.background = skyTex; }
  const g2 = skyCanvas.getContext('2d')!, c = new THREE.Color(bg), hex = (k: THREE.Color) => `#${k.getHexString()}`, gr = g2.createLinearGradient(0, 0, 0, 256);
  gr.addColorStop(0, hex(c.clone().multiplyScalar(0.86))); gr.addColorStop(0.42, hex(c.clone().lerp(new THREE.Color(0xffffff), 0.25))); gr.addColorStop(0.6, hex(c.clone().lerp(new THREE.Color(0x7d7a58), 0.7))); gr.addColorStop(1, hex(c.clone().lerp(new THREE.Color(0x5f5a40), 0.85)));
  g2.fillStyle = gr; g2.fillRect(0, 0, 4, 256); skyTex.needsUpdate = true;
}
function applyQuality(qn: Quality) {
  quality = qn;
  renderer.setPixelRatio(Math.min(devicePixelRatio, qn === 'high' ? 2 : qn === 'medium' ? 1.5 : 1));
  renderer.shadowMap.enabled = qn === 'high'; sun.castShadow = qn === 'high';
  world?.setQuality(qn); resize();
  scene.traverse((o) => { const m = (o as THREE.Mesh).material as THREE.Material | undefined; if (m) m.needsUpdate = true; });
}

// ---------- camera: views, tween, follow ----------
interface Cam { pos: THREE.Vector3; tgt: THREE.Vector3 }
function viewCam(v: View): Cam {
  const aspect = innerWidth / Math.max(1, innerHeight), hfov = 2 * Math.atan(Math.tan((camera.fov * Math.PI) / 360) * aspect), fit = (halfW: number) => halfW / Math.tan(hfov / 2);
  const mk = (tx: number, ty: number, tz: number, el: number, az: number, dist: number): Cam => { const e = (el * Math.PI) / 180, a = (az * Math.PI) / 180; return { tgt: new THREE.Vector3(tx, ty, tz), pos: new THREE.Vector3(tx + Math.sin(a) * Math.cos(e) * dist, ty + Math.sin(e) * dist, tz + Math.cos(a) * Math.cos(e) * dist) }; };
  // portrait: 完整剖面 and 地下 fit the whole nest (its bounds from the layout) into the width; the soil wall extends
  // far below and beside the block (scene.ts), so no empty void shows under it
  const nb = graph.bounds(0), cx = (nb.x0 + nb.x1) / 2, half = (nb.x1 - nb.x0) / 2 + 1, tall = aspect < 1, vh = (d: number) => d * Math.tan((camera.fov * Math.PI) / 360);
  // Portrait: the nest is much wider than the screen. The default shows the entrance and the central chambers large
  // enough to read the ants (the rest is one sideways drag away; the legend line says so), tilted so the garden surface
  // fills the upper part and the soil wall the rest (it extends far below and beside the block: no void).
  void cx; void half;
  if (v === 'surface') return tall ? mk(22, 0, -14, 50, -10, Math.min(300, fit(34))) : mk(48, 0, -26, 46, -12, Math.min(260, fit(84)));
  if (v === 'under') { const d = fit(tall ? 23 : 47); return tall ? mk(4, -(0.5 - 0.27) * 2 * vh(d), 0, 3, 0, d) : mk(5, -17, 0, 3, 0, Math.min(640, d)); }
  { const d = fit(tall ? 27 : 50); return tall ? mk(4, (0.53 - 0.5) * 2 * vh(d), 0, 22, 0, d) : mk(8, -10, 0, 14, -7, Math.min(640, d)); }
}
let tween: { from: Cam; to: Cam; t: number; dur: number } | null = null, userBusy = false, followAdjust = 0;
function goView(v: View, instant = false, dur = 0.9) {
  view = v; for (const [b, k] of [[ui.viewFull, 'full'], [ui.viewSurface, 'surface'], [ui.viewUnder, 'under']] as const) b.setAttribute('aria-pressed', String(k === v));
  if (following) setFollow(null);
  const to = viewCam(v);
  if (instant) { camera.position.copy(to.pos); controls.target.copy(to.tgt); controls.update(); tween = null; return; }
  tween = { from: { pos: camera.position.clone(), tgt: controls.target.clone() }, to, t: 0, dur };
}
const smooth = (k: number) => k * k * (3 - 2 * k);
function stepCamera(dt: number) {
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / tween.dur); const k = smooth(tween.t);
    camera.position.lerpVectors(tween.from.pos, tween.to.pos, k); controls.target.lerpVectors(tween.from.tgt, tween.to.tgt, k);
    if (tween.t >= 1) tween = null;
  }
  if (following) {
    const a = drawn.find((x) => x.id === following);
    if (a) {
      const want = V.set(a.x, a.y + antLen() * 0.2, a.z), gap = controls.target.distanceTo(want), k = gap > 30 ? 1 - Math.exp(-dt * 3) : 1 - Math.exp(-dt * 9);
      const delta = want.clone().sub(controls.target).multiplyScalar(k); controls.target.add(delta); camera.position.add(delta);
      // underground the cut is seen from the front and nearly level; on the surface from above (unless the user is turning the view)
      if (followRealm !== a.realm) { followRealm = a.realm; followAdjust = 1.6; }
      if (followAdjust > 0 && !userBusy) {
        followAdjust -= dt; const off = camera.position.clone().sub(controls.target), sph = new THREE.Spherical().setFromVector3(off), kk = 1 - Math.exp(-dt * 3.2);
        const phi = a.realm === 'nest' ? (84 * Math.PI) / 180 : (50 * Math.PI) / 180, th = a.realm === 'nest' ? Math.max(-0.2, Math.min(0.2, sph.theta)) : sph.theta;
        sph.phi += (phi - sph.phi) * kk; sph.theta += (th - sph.theta) * kk; camera.position.copy(controls.target).add(off.setFromSpherical(sph));
      }
      // 自動導覽 moves in slowly instead of jumping to the worker (camera only)
      if (tourFollows() && !userBusy) { const off = camera.position.clone().sub(controls.target), len = off.length(), want = Math.max(antLen() * 14, 26); camera.position.copy(controls.target).add(off.setLength(len + (want - len) * (1 - Math.exp(-dt * 1.4)))); }
    }
  }
  // keep the view on the block
  const rest = !tween && !following && !userBusy; if (rest) { restPos.copy(camera.position); restTgt.copy(controls.target); restQuat.copy(camera.quaternion); }
  controls.target.x = Math.max(BLOCK.x0, Math.min(BLOCK.x1, controls.target.x)); controls.target.z = Math.max(BLOCK.z0, Math.min(BLOCK.z1 + 2, controls.target.z)); controls.target.y = Math.max(BLOCK.bottom - 120, Math.min(40, controls.target.y));
  controls.update();
  // A camera at rest stays bit-identical. OrbitControls rebuilds position and target from spherical coordinates on
  // every update, which moves the last floating-point digit each frame (measured: about 1e-14 cm per frame). When
  // nothing is moving the camera and the update changed it by less than REST_EPS_CM, the values are put back.
  // Anything larger — the damping tail of a drag or a zoom, the clamp above — is real motion and is kept.
  if (rest && camera.position.distanceToSquared(restPos) < REST_EPS_CM * REST_EPS_CM && controls.target.distanceToSquared(restTgt) < REST_EPS_CM * REST_EPS_CM) { camera.position.copy(restPos); controls.target.copy(restTgt); camera.quaternion.copy(restQuat); }
}
/** below this change per frame (cm) a camera nobody is moving is at rest: five orders of magnitude above the float
 *  noise of an update, and far below anything visible (at the closest zoom one pixel is about 0.003 cm) */
const REST_EPS_CM = 1e-9;
const restPos = new THREE.Vector3(), restTgt = new THREE.Vector3(), restQuat = new THREE.Quaternion();
let followRealm: 'surface' | 'nest' | null = null;
/** the worker the Worker was last asked to report with each frame (observation only); 自動導覽 never changes it */
let observed: string | null = null;
/** byTour = the idle camera tour is following (or letting go of) a worker: CAMERA ONLY, nothing is sent to the Worker */
function setFollow(id: string | null, byTour = false) {
  if (!byTour && tour) endTour();
  following = id; followRealm = null; tween = null;
  ui.followBtn.setAttribute('aria-pressed', String(!!id)); ui.followBtn.textContent = id ? `停止跟隨 ${id}` : '跟隨螞蟻';
  if (id) {
    if (selected !== id) cardNow.btn = ''; selected = id; userSel = !byTour; const a = drawn.find((x) => x.id === id);
    if (a && !byTour) { const dir = camera.position.clone().sub(controls.target).normalize(), d = Math.max(antLen() * 11, 20); controls.target.set(a.x, a.y, a.z); camera.position.copy(controls.target).addScaledVector(dir, d); followRealm = a.realm; followAdjust = 1.6; }
  }
  // observation only: the Worker sends this worker's own record with each frame (never for a tour follow)
  if (!byTour && (id !== null || observed !== null)) { observed = id; void client.follow(id).catch(() => {}); }
  renderCard();
}
/** 下一隻／上一隻 while following: the next worker id in order */
function stepFollow(dir: 1 | -1) {
  const ids = drawn.map((a) => a.id).sort(), i = following ? ids.indexOf(following) : -1; if (!ids.length) return;
  setFollow(ids[(i + dir + ids.length) % ids.length]);
}

// ---------- 自動導覽: idle camera tour (camera only; web/src/demo2/tour.ts decides the shots from engine states / events) ----------
const tourParam = q.get('tour');
/** on by default; under automation only when asked for (`?tour=<idle seconds>`), so checks keep their own camera */
let tourOn = tourParam !== null ? tourParam !== '0' : !automated;
const tourIdle = Number(tourParam) > 0 ? Number(tourParam) : TOUR_IDLE_S;
let tour: { k: number; shot: TourShot; until: number } | null = null, tourLast: string | null = null, lastInput = performance.now(), userSel = false;
const tourCues: TourCue[] = [], tourLog: ({ k: number; t_sim: number } & TourShot)[] = [];
const tourFollows = () => tour !== null && tour.shot.kind === 'follow' && following === tour.shot.id;
function endTour() { tour = null; ui.tourChip.hidden = true; }
/** any input hands the camera back: the tour stops where it is (a followed worker stays selected, the camera stops following) */
function stopTour() { if (!tour) return; const wasFollow = tourFollows(); endTour(); tween = null; /* an overview move in progress stops too */ if (wasFollow) setFollow(null, true); }
function userInput() { lastInput = performance.now(); stopTour(); }
for (const ev of ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const) addEventListener(ev, userInput, { capture: true, passive: true });
function syncTourBtn() { ui.tourBtn.setAttribute('aria-pressed', String(tourOn)); ui.tourBtn.textContent = `自動導覽：${tourOn ? '開' : '關'}`; ui.tourBtn.title = `沒有操作 ${tourIdle} 秒後，鏡頭自動巡覽並跟隨正在活動的個體（只動鏡頭，不影響模擬）`; }
function stepTour(now: number) {
  if (!frame || !hooks.ready) return;
  const may = tourMayRun({ on: tourOn, idle_s: (now - lastInput) / 1000, need_idle_s: tourIdle, running, userFollowing: !!following && !tourFollows(), userSelected: userSel && !!selected, sheetOpen: narrow() && sheet !== 'peek' });
  if (!may) { stopTour(); return; }
  if (tour && now < tour.until) return;
  const k = tour ? tour.k + 1 : 0, shot = nextShot(k, frame.seed, frame.t_sim, frame.workers, tourCues, tourLast);
  tour = { k, shot, until: now + shot.hold_s * 1000 }; tourLog.push({ k, t_sim: frame.t_sim, ...shot }); if (tourLog.length > 64) tourLog.shift();
  if (shot.kind === 'view') { if (following) setFollow(null, true); selected = null; userSel = false; hideCard(); goView(shot.view, false, 2.4); }
  else { tourLast = shot.id; setFollow(shot.id, true); }
  ui.tourChip.hidden = false;
}
/** the worker the 「跟隨螞蟻」 button picks when none is selected: one that is about to leave or is on a trip (engine state) */
function interestingAnt(): string | null {
  if (!frame) return null;
  const rank = ['to_entrance', 'outbound', 'feeding', 'returning', 'searching', 'from_entrance', 'idle', 'brood_care', 'resting'];
  return [...frame.workers].sort((a, b) => rank.indexOf(a.state) - rank.indexOf(b.state) || a.since_s - b.since_s || (a.id < b.id ? -1 : 1))[0]?.id ?? null;
}

// ---------- per frame ----------
const frameIv: number[] = [], cpuMs: number[] = [];
/** automation only: skip the GPU draw (software rendering is slow); the world, the display director and the camera run on */
let renderOn = true;
let lastNow = performance.now(), lowFpsSince = 0;

/** one rig instance. Everything is a value of THIS simulated instant (stage.ts / gait.ts): gait phase from the odometer,
 *  stance amplitude from the stride, pose values from the display pose — nothing is integrated per rendered frame. */
function place(layer: RigLayer, i: number, p: P3, qt: THREE.Quaternion, scale: number, color: THREE.Color, phase: number, walk: number, amp: number, pv: PoseValues, crop: number, seed: number) {
  M4.compose(V.set(p.x, p.y, p.z), qt, S.setScalar(scale)); layer.mesh.setMatrixAt(i, M4); layer.mesh.setColorAt(i, color);
  layer.anim.setXYZW(i, phase % (Math.PI * 4), walk, seed, pv.act); layer.pose.setXYZW(i, crop, pv.pitch, pv.antUp, pv.crouch); layer.xf.setXYZW(i, qt.x, qt.y, qt.z, qt.w); layer.scl.setX(i, scale);
  layer.more.setXYZW(i, pv.legs, pv.scan, pv.conv, amp);
}
const floorPoint = (pos: Pos): P3 => { const p = graph.point(pos); return { x: p.x, y: p.y - NEST_FOOT_DROP, z: p.z }; };

function drawStatics() {
  if (!frame || !rost) return;
  const L = antLen(), sc = L / MODEL_LEN, larvae = rost.individuals.filter((x) => x.caste === 'larva'), out: StaticDraw[] = [];
  const brood = graph.chambersOf('brood')[0].id, qc = graph.chambersOf('queen')[0].id, pc = graph.chambersOf('pupa')[0].id;
  // larvae (engine: they exist and have a gut fill; the place in the brood chamber is display)
  larvae.forEach((lv, i) => {
    const p = floorPoint(larvaSpot(graph, i, larvae.length, L)), k = Math.max(0, Math.min(1, lv.fill ?? 0)), fed = stage.fedNow(lv.id, tNow), s = L * 0.62 * (fed ? 1.08 : 1);
    M4.compose(V.set(p.x, p.y + 0.02, p.z), Qa.setFromAxisAngle(Y.set(0, 1, 0), (hash32(lv.id) % 628) / 100), S.setScalar(s)); larvaMesh.setMatrixAt(i, M4);
    larvaMesh.setColorAt(i, lv.id === selected ? C.setRGB(1.25, 1.1, 0.6) : C.setRGB(0.8 + 0.16 * k, 0.76 + 0.17 * k, 0.62 + 0.2 * k)); out.push({ ind: lv, p, chamber: brood });
  });
  larvaMesh.count = larvae.length; larvaMesh.instanceMatrix.needsUpdate = true; larvaMesh.instanceColor!.needsUpdate = true;
  // queens, majors, eggs, pupae: ENGINE individuals when the world supplies them (candidate world; the engine has no
  // nest coordinates and they do not move: static in their chamber, in-place micro-motion only), otherwise — 展示情境
  // only — labelled demo individuals (示範資料)
  let nq = 0, nm = 0, ne = 0, np = 0; const bodies: Body[] = [];
  const demo = rost.individuals.filter((x) => x.caste !== 'minor' && x.caste !== 'larva'), count = (c: string) => demo.filter((x) => x.caste === c).length;
  for (const d of demo) {
    const seed = (hash32(d.id) % 9973) / 9973, sel = d.id === selected;
    if (d.caste === 'queen' || d.caste === 'major') {
      const spot = d.caste === 'queen' ? queenPlace(graph, d.index, count('queen'), L) : majorSpot(graph, d.index, demoSeed, L), p = floorPoint(spot.pos), fx = Math.cos(spot.yaw), fz = Math.sin(spot.yaw);
      const layer = d.caste === 'queen' ? layers.queen : layers.major, tone = d.caste === 'queen' ? 0.92 : 0.98, k = MORPHS[d.caste as RigCaste].scale;
      // static engine individuals (the engine has no place or movement for them): standing still, in-place micro-motion only
      const pv = d.caste === 'queen' ? { ...POSE_TARGET.rest, crouch: 0.2, legs: 1 } : POSE_TARGET.stand;
      place(layer, d.caste === 'queen' ? nq++ : nm++, p, basis(fx, 0, fz, 0, 1, 0, Qa), sc * k, sel ? C.setRGB(1.4, 1.25, 0.8) : C.setRGB(tone, tone * 0.97, tone * 0.94), gaitPhase(d.id, 0, L * k), 0, stanceAmp(strideCm(d.id, L * k), L * k), pv, d.caste === 'queen' ? 0.6 : 0, seed);
      const gp = graph.point(spot.pos); bodies.push({ id: d.id, realm: 'nest', x: gp.x, y: gp.y, z: gp.z, fx, fy: 0, fz, len: L * k, mob: 0, zLo: gp.z, zHi: gp.z, partner: null });
      out.push({ ind: d, p: { x: p.x, y: p.y + L * 0.3, z: p.z }, chamber: graph.edges[spot.pos.edge].chamber ?? '' });
    } else if (d.caste === 'egg') {
      const p = floorPoint(eggSpot(graph, d.index, demoSeed, L)); M4.compose(V.set(p.x, p.y + L * 0.04 + (d.index % 3) * L * 0.035, p.z), Qa.setFromAxisAngle(Y.set(0, 1, 0), seed * 6.28), S.setScalar(L * 0.2)); eggMesh.setMatrixAt(ne, M4); eggMesh.setColorAt(ne++, sel ? C.setRGB(1.3, 1.2, 0.7) : C.setRGB(0.97, 0.96, 0.9)); out.push({ ind: d, p, chamber: qc });
    } else if (d.caste === 'pupa') {
      const p = floorPoint(pupaSpot(graph, d.index, count('pupa'), L)); M4.compose(V.set(p.x, p.y + 0.02, p.z), Qa.setFromAxisAngle(Y.set(0, 1, 0), seed * 6.28), S.setScalar(L * 0.82)); pupaMesh.setMatrixAt(np, M4); pupaMesh.setColorAt(np++, sel ? C.setRGB(1.3, 1.2, 0.7) : C.setRGB(0.95, 0.9 - 0.12 * seed, 0.78 - 0.2 * seed)); out.push({ ind: d, p, chamber: pc });
    }
  }
  layers.queen.commit(nq); layers.major.commit(nm);
  eggMesh.count = ne; eggMesh.instanceMatrix.needsUpdate = true; if (eggMesh.instanceColor) eggMesh.instanceColor.needsUpdate = true;
  pupaMesh.count = np; pupaMesh.instanceMatrix.needsUpdate = true; if (pupaMesh.instanceColor) pupaMesh.instanceColor.needsUpdate = true;
  statics = out; stage.setStatics(bodies);
}

function tick(now: number) {
  const dtWall = Math.min(1, (now - lastNow) / 1000), dtReal = Math.min(0.1, dtWall); frameIv.push(now - lastNow); lastNow = now; if (frameIv.length > 600) frameIv.shift();
  const c0 = performance.now(), dtAnim = running ? dtReal : 0;
  if (frame && vis) {
    const run = !!pacing?.running; tNow = displayTime(frame.t_sim, run, pacing?.speed ?? speed, performance.now() - frameAt, lastT); lastT = run ? tNow : null;
    // micro-motion clock = SIMULATED time (wrapped): the same world instant draws the same pose at any frame rate or speed
    uTime.value = tNow % CLOCK_WRAP_S; rigNode?.setTime(uTime.value); sceneClock += dtAnim;
    drawn = stage.update(frame, vis, tNow, dtAnim);
    const L = antLen(), sc = L / MODEL_LEN, pxPerCm = ui.canvas.clientHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
    let nh = 0, nl = 0, nb = 0;
    for (const a of drawn) {
      const depth = a.realm === 'nest' ? Math.min(1, Math.max(0, (ground(0, 0) - a.y) / 2)) * NEST_FOOT_DROP : 0, p = { x: a.x - a.ux * depth, y: a.y - a.uy * depth, z: a.z - a.uz * depth };
      const qt = basis(a.fx, a.fy, a.fz, a.ux, a.uy, a.uz, Qb); // the director's frame as it is: turning is bounded there, in simulated time
      const dist = camera.position.distanceTo(V.set(p.x, p.y, p.z)), px = (L / Math.max(0.01, dist)) * pxPerCm, sel = a.id === selected, hi = px > (quality === 'low' ? 34 : 18) || sel;
      const h = hash32(a.id), tone = 0.9 + ((h % 1000) / 1000) * 0.22;
      if (sel) C.setRGB(1.4, 1.25, 0.78); else C.setRGB(tone, tone * (0.97 + ((h >>> 10) % 100) / 2000), tone * 0.95);
      place(hi ? layers.minorHi : layers.minorLo, hi ? nh++ : nl++, p, qt, sc, C, a.phase, a.walk, a.amp, a.pv, Math.max(0, Math.min(1, a.crop)), (h % 9973) / 9973);
      if (a.realm === 'surface') { M4.compose(V.set(a.x, a.y + 0.05, a.z), Qa.identity(), S.set(L * 0.95, 1, L * 0.6)); blobs.setMatrixAt(nb++, M4); }
    }
    layers.minorHi.commit(nh); layers.minorLo.commit(nl); blobs.count = nb; blobs.instanceMatrix.needsUpdate = true;
    drawStatics();
    // the planned display route of the selected worker inside the nest (display)
    const plan = selected ? stage.plannedRoute(selected, tNow) : [];
    planLine.visible = plan.length > 1; if (planLine.visible) { planLine.geometry.dispose(); planLine.geometry = new THREE.BufferGeometry().setFromPoints(plan.map((p) => new THREE.Vector3(p.x, p.y + 0.25, p.z + 0.1))); planLine.computeLineDistances(); }
  }
  stepTour(now);
  stepCamera(dtWall); // camera moves follow the wall clock (a slow frame must not stretch a view change)
  if (renderOn && !gpuLost) {
    if (offRT) renderer.setRenderTarget(offRT as unknown as THREE.WebGLRenderTarget);
    renderer.info.reset(); // draw calls / triangles of the whole frame (the HD-2D chain draws several passes)
    if (hd2dActive()) {
      // focus plane: the followed ant, else the camera target (distance along the view direction)
      const fa = following ? drawn.find((x) => x.id === following) : null, fp = fa ? V.set(fa.x, fa.y, fa.z) : V.copy(controls.target);
      const focus = Math.max(camera.near * 2, fp.sub(camera.position).dot(camera.getWorldDirection(X)));
      if (frame && world) world.setAtmosphere(frame.env.light, Y.copy(sun.position).sub(sunTarget.position).normalize(), sun.color, sceneClock);
      hd2d!.render(scene, camera, focus, frame?.env.light ?? 'day', fx);
    } else if (rendererKind === 'webgl2') { renderer.setRenderTarget(null); renderer.render(scene, camera); }
    else try { renderer.render(scene, camera); } catch (e) { webgpuLost((e as Error).message); } // a lost WebGPU device must not stop the page
  }
  cpuMs.push(performance.now() - c0); if (cpuMs.length > 600) cpuMs.shift();
  updateLabels(); updateHud(now);
  // automatic quality: step down when the frame rate stays low (never while a level is forced by ?quality=)
  if (!qualityLocked && frameIv.length > 90 && (quality !== 'low' || (hd2dActive() && (fx.dof || fx.bloom)))) {
    const fps = 1000 / (frameIv.slice(-90).reduce((a, b) => a + b, 0) / 90);
    if (fps < 24) { if (!lowFpsSince) lowFpsSince = now; else if (now - lowFpsSince > 3000) {
      lowFpsSince = 0; frameIv.length = 0;
      // HD-2D: drop the post effects first (depth of field, then bloom), then the quality level
      if (hd2dActive() && fx.dof) { fx.dof = false; perfCtlNow = ''; toast('畫面更新偏慢：已自動關閉 HD-2D 的景深（只影響繪圖，不影響模擬）'); }
      else if (hd2dActive() && fx.bloom) { fx.bloom = false; perfCtlNow = ''; toast('畫面更新偏慢：已自動關閉 HD-2D 的泛光（只影響繪圖，不影響模擬）'); }
      else { applyQuality(quality === 'high' ? 'medium' : 'low'); toast(`畫面更新偏慢：已自動降低畫質為「${QUALITY_LABEL[quality]}」（只影響繪圖，不影響模擬）`); }
    } } else lowFpsSince = 0;
  }
  requestAnimationFrame(tick);
}
const QUALITY_LABEL: Record<Quality, string> = { high: '高', medium: '中', low: '低' };
/** what has and has not been verified about the WebGPU path (shown in the 效能 tab; docs/demo2.md) */
const WEBGPU_STATUS = 'WebGPU 路徑目前只在軟體 WebGPU（無頭 Chromium＋SwiftShader）上以離屏繪圖驗證過（著色器、螞蟻關節、instancing、draw call 數）；畫面直接呈現到螢幕、以及真實 GPU，都未在真實 GPU 的 WebGPU 上驗證，待 Owner 實機確認。';

// ---------- labels (HTML overlay, projected) ----------
const labelEls = new Map<string, HTMLElement>();
function updateLabels() {
  if (!frame || !rost || !world) return;
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight, items: { key: string; p: P3; text: string; cls: string; face: boolean; prio: number }[] = [];
  const ns = (c: 'queen' | 'major' | 'egg' | 'pupa') => rost!.missing.includes(c), n = (c: 'queen' | 'major' | 'egg' | 'pupa') => rost!.counts[c];
  // Narrow screens use SHORT labels: chamber name + counts, with ※ for "engine individual whose physiology and behaviour
  // are 尚未模擬" (explained by the one-line legend under the scene). The full wording stays on wide screens, in the
  // tap card and in the stats panel.
  const compact = narrow(); let marked = false;
  const SHORT: Record<'queen' | 'major' | 'egg' | 'pupa', string> = { queen: '后', major: '大工蟻', egg: '卵', pupa: '蛹' };
  // an engine individual of the candidate world exists in the engine, but its physiology / behaviour is 尚未模擬
  const eng = (c: 'queen' | 'major' | 'egg' | 'pupa') => { if (compact) { marked = true; return `${SHORT[c]} ${n(c).engine}${NS_MARK}`; } return `${CASTE_LABEL[c]} ${n(c).engine}（引擎個體；生理與行為尚未模擬）`; };
  const part = (c: 'queen' | 'major' | 'egg' | 'pupa') => ns(c) ? (mode === 'demo' ? (compact ? `${SHORT[c]} ${n(c).demo}（示範）` : `${CASTE_LABEL[c]} ${n(c).demo}（示範資料）`) : (compact ? `${SHORT[c]}：未模擬` : `${CASTE_LABEL[c]}：尚未模擬`)) : eng(c);
  for (const c of graph.layout.chambers) {
    const here = drawn.filter((a) => a.place === c.id).length; let text = `${c.label_zh}${here ? ` ${here}` : ''}`, cls = '';
    if (c.role === 'brood') text += compact ? `｜幼蟲 ${rost.counts.larva.engine}` : `｜幼蟲 ${rost.counts.larva.engine}（引擎）`;
    if (c.role === 'queen') { text += compact ? `｜${part('queen')} ${part('egg')}` : `｜${part('queen')}・${part('egg')}`; cls = ns('queen') ? (mode === 'demo' ? 'demo' : 'ns') : ''; }
    if (c.role === 'pupa') { text += `｜${part('pupa')}`; cls = ns('pupa') ? (mode === 'demo' ? 'demo' : 'ns') : ''; }
    items.push({ key: `ch-${c.id}`, p: { x: (c.x0 + c.x1) / 2, y: c.floor + c.height + 0.9, z: graph.faceZ }, text, cls, face: true, prio: 50 });
  }
  items.push({ key: 'face', p: { x: -24, y: -7, z: graph.faceZ }, text: compact ? `巢體＝展示假設｜${part('major')}` : `巢體幾何＝展示假設${ns('major') ? (mode === 'demo' ? `｜大工蟻 ${n('major').demo}（示範資料）` : '｜大工蟻：尚未模擬') : `｜${eng('major')}`}`, cls: ns('major') && mode !== 'demo' ? 'ns' : mode === 'demo' ? 'demo' : '', face: true, prio: 40 });
  items.push({ key: 'entrance', p: { x: 0, y: ground(0, 0) + 3.2, z: 0 }, text: '巢口', cls: '', face: false, prio: 60 });
  items.push({ key: 'host', p: world.anchors.hostPlant, text: compact ? `蜜露來源（引擎）${frame.source.stock_portions.toFixed(1)} 份` : `蜜露來源（引擎）存量 ${frame.source.stock_portions.toFixed(1)} 份｜寄主植物外形＝裝飾`, cls: '', face: false, prio: 30 });
  if (mode === 'demo') { items.push({ key: 'nectar', p: world.anchors.nectar, text: compact ? '花蜜（示範道具）' : DEMO_FOOD_PROPS[0].label_zh, cls: 'demo', face: false, prio: 20 }); items.push({ key: 'insect', p: world.anchors.insect, text: compact ? '昆蟲屍體（示範道具）' : DEMO_FOOD_PROPS[1].label_zh, cls: 'demo', face: false, prio: 20 }); }
  for (const a of drawn) if (a.pose === 'troph' && a.partner && a.id < a.partner) items.push({ key: `tr-${a.id}`, p: { x: a.x, y: a.y + antLen() * 0.9, z: a.z }, text: '交哺（引擎事件）', cls: 'act', face: true, prio: 80 });
  for (const a of drawn) if (a.pose === 'brood' && a.partner && stage.fedNow(a.partner, tNow)) items.push({ key: `br-${a.id}`, p: { x: a.x, y: a.y + antLen() * 0.9, z: a.z }, text: '餵幼蟲（引擎事件）', cls: 'act', face: true, prio: 80 });
  const selA = drawn.find((a) => a.id === selected), selS = statics.find((s) => s.ind.id === selected);
  if (selA) items.push({ key: 'pin', p: { x: selA.x, y: selA.y + antLen() * (selA.realm === 'nest' ? 1.0 : 0.9), z: selA.z }, text: `▼ ${selA.id}`, cls: 'pin', face: false, prio: 100 });
  else if (selS) items.push({ key: 'pin', p: { x: selS.p.x, y: selS.p.y + antLen() * 0.9, z: selS.p.z }, text: `▼ ${selS.ind.id}`, cls: 'pin', face: false, prio: 100 });
  const off = camera.position.clone().sub(controls.target), dist = off.length(), frontal = off.z / dist, seen = new Set<string>();
  // one-line legend under the scene (narrow screens): what ※ means, and that the nest can be dragged sideways
  const partial = compact && !nestOnScreen().inside, legend = [marked ? `${NS_MARK}＝引擎個體，生理與行為尚未模擬` : '', partial ? '左右拖曳可看其他巢室' : ''].filter(Boolean).join('｜');
  if (ui.lblLegend.textContent !== legend) ui.lblLegend.textContent = legend; ui.lblLegend.hidden = !legend;
  const boxes: LabelBox[] = [], els = new Map<string, HTMLElement>(), rightLimit = !compact && !document.body.classList.contains('side-closed') ? ui.side.getBoundingClientRect().left - 4 : w - 2;
  for (const it of items) {
    let el = labelEls.get(it.key); if (!el) { el = document.createElement('div'); ui.labels.appendChild(el); labelEls.set(it.key, el); }
    seen.add(it.key);
    const s = V.set(it.p.x, it.p.y, it.p.z).project(camera), on = s.z < 1 && Math.abs(s.x) < 1.05 && Math.abs(s.y) < 1.05 && (!it.face || (frontal > 0.45 && dist < 700)) && (it.cls === 'pin' || dist < 700);
    el.className = `lbl ${it.cls}`; if (el.textContent !== it.text) el.textContent = it.text;
    el.hidden = !on; if (!on) continue;
    const ax = ((s.x + 1) / 2) * w; if (ax > rightLimit) { el.hidden = true; continue; } // under the open side panel (wide screens)
    boxes.push({ key: it.key, x: ax, y: ((1 - s.y) / 2) * h, w: el.offsetWidth, h: el.offsetHeight, prio: it.prio }); els.set(it.key, el);
  }
  // collision avoidance: labels never overlap each other, stay below the top bar and above the legend / the open sheet
  const placed = placeLabels(boxes, { left: 2, top: ui.top.getBoundingClientRect().bottom + 2, right: rightLimit, bottom: ui.canvas.clientHeight - Math.max(pill ? PILL_ZONE_PX : 0, sheetPx() + (legend ? ui.lblLegend.offsetHeight + 4 : 2)) });
  const got = new Set(placed.map((p) => p.key));
  for (const p of placed) els.get(p.key)!.style.transform = `translate(${Math.round(p.left)}px, ${Math.round(p.top)}px)`;
  for (const [k, el] of els) if (!got.has(k)) el.hidden = true;
  for (const [k, el] of labelEls) if (!seen.has(k)) el.hidden = true;
}
const NS_MARK = '※';
/** the height of the bottom sheet covering the scene (narrow screens with the panel open), else 0 */
const sheetPx = () => narrow() ? coverNow : 0;
/** phone bottom sheet: closed ('peek': only a small floating pill with key counts), half, full; the selected
 *  individual's compact card lies on the bottom edge, or on top of the open sheet */
type Sheet = 'peek' | 'half' | 'full';
const CARD_PX = 56, PILL_ZONE_PX = 52;
let sheet: Sheet = 'peek', sheetNow = 0, coverNow = 0, pill = false;
function sheetTarget(s: Sheet): number { return s === 'peek' ? 0 : s === 'half' ? Math.round(innerHeight * 0.46) : Math.max(120, Math.round(innerHeight - ui.top.getBoundingClientRect().bottom - 28)) /* the grip's 44 px tap area stays below the bar */; }
/** CSS variables the layout reads: --sheet = the sheet's height, --cover = what the sheet and the compact card cover
 *  (labels and the legend stay above it; the scene is framed into the rest), --top = bottom of the top bar */
function chromeVars(dragPx?: number) {
  const nw = narrow(), safe = parseFloat(getComputedStyle(ui.side).paddingBottom) || 0, card = nw && !ui.card.hidden && sheet !== 'full';
  sheetNow = nw ? dragPx ?? sheetTarget(sheet) : 0;
  const cardBottom = sheetNow > 0 ? sheetNow : safe; coverNow = card ? cardBottom + CARD_PX : sheetNow;
  pill = nw && sheet === 'peek' && dragPx === undefined && !card; document.body.classList.toggle('pill', pill);
  const st = document.body.style; st.setProperty('--sheet', `${sheetNow}px`); st.setProperty('--cover', `${coverNow}px`); st.setProperty('--card-bottom', `${cardBottom}px`); st.setProperty('--top', `${Math.round(ui.top.getBoundingClientRect().bottom)}px`);
}
function layoutChrome(dragPx?: number) { chromeVars(dragPx); if (renderer) reframe(); }
function setSheet(s: Sheet) {
  sheet = s; document.body.classList.toggle('side-closed', s === 'peek'); document.body.classList.toggle('sheet-full', s === 'full'); ui.sideBtn.setAttribute('aria-expanded', String(s !== 'peek'));
  layoutChrome();
}
const sceneBottom = () => ui.canvas.clientHeight - sheetPx();
/** do all chamber ends and tops project inside the visible scene (below the top bar, above the sheet)? */
function nestOnScreen() {
  const w = ui.canvas.clientWidth, h = sceneBottom(), top = ui.top.getBoundingClientRect().bottom; let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const c of graph.layout.chambers) for (const [x, y] of [[c.x0, c.floor], [c.x1, c.floor], [(c.x0 + c.x1) / 2, c.floor + c.height]]) { const p = new THREE.Vector3(x, y, graph.faceZ).project(camera), sx = ((p.x + 1) / 2) * w, sy = ((1 - p.y) / 2) * ui.canvas.clientHeight; x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
  return { inside: x0 >= 0 && x1 <= w && y0 >= top && y1 <= h, box: [Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1)], w, h, top: Math.round(top) };
}

// ---------- HUD and panels ----------
let hudAt = 0, tab = 'stats', hudOpen = false;
function updateHud(now: number) {
  if (now - hudAt < 300) return; hudAt = now;
  if (!frame) return;
  setLight(frame);
  const out = drawn.filter((a) => a.realm === 'surface').length, temp = frame.env.temperature_c === null ? '—' : frame.env.temperature_c.toFixed(1);
  // narrow screens: ONE short status line (the 非正式 chip above carries the status label); a tap expands it
  const short = `第 ${Math.floor(tNow / 86400)} 天 ${clockOf(tNow)}｜${P0_LIGHT_LABEL[frame.env.light]} ${temp}°C（合成）｜${running ? `${speed}×` : '暫停'}`;
  const text = !narrow() ? `${fmtWorldTime(tNow)}（${frame.env.date}）｜光照 ${P0_LIGHT_LABEL[frame.env.light]}・氣溫 ${temp}°C（合成）｜${running ? `執行中 ${speed}×` : '已暫停'}｜種子 ${frame.seed}｜工蟻 巢外 ${out}・巢內 ${drawn.length - out}｜${P0A2_STATUS_LABEL}`
    : hudOpen ? `${short}｜${frame.env.date}｜種子 ${frame.seed}｜巢外 ${out}・巢內 ${drawn.length - out}｜${P0A2_STATUS_LABEL}` : short;
  if (ui.hud.textContent !== text) ui.hud.textContent = text;
  const peek = `▲ 巢外 ${out}・巢內 ${drawn.length - out}`; // phone: key counts on the pill that opens the sheet
  if (ui.peekText.textContent !== peek) ui.peekText.textContent = peek;
  if (selected) renderCard();
  if (!document.body.classList.contains('side-closed')) { if (tab === 'stats') renderStats(); else if (tab === 'perf') renderPerf(); else if (tab === 'saves') renderSaveStatus(); }
}
function renderStats() {
  if (!frame || !rost) return;
  const by = new Map<string, number>(); for (const w of frame.workers) by.set(w.state, (by.get(w.state) ?? 0) + 1);
  const places = new Map<string, number>(); for (const a of drawn) { const k = a.realm === 'surface' ? a.place : a.place === 'tunnel' ? '通道' : graph.chamber(a.place).label_zh; places.set(k, (places.get(k) ?? 0) + 1); }
  const row = (c: typeof CASTES[number]) => { const k = rost!.counts[c], miss = rost!.missing.includes(c); return `<tr><td>${CASTE_LABEL[c]}${!miss && colonyOf(frame!) && c !== 'minor' && c !== 'larva' ? '<br><span class="muted">候選世界・數量為假設；生理與行為尚未模擬</span>' : ''}</td><td class="n">${miss ? '<span class="tag none">尚未模擬</span>' : k.engine}</td><td class="n">${mode === 'demo' ? k.demo : '—'}</td></tr>`; };
  const st = stage.stats;
  ui.stats.innerHTML = `<h2>生命階段與階級</h2><table><tr><th></th><th class="n">引擎</th><th class="n">示範資料</th></tr>${CASTES.map(row).join('')}</table>
<div class="muted">${mode === 'demo' ? `${DEMO_BADGE}：示範個體只在本模式顯示，${DEMO_ROUTINE_LABEL}；不存檔、不影響引擎。` : `${NATURAL_BADGE}：引擎沒有的階級不畫，巢室標示「尚未模擬」。`}</div>
<h2>工蟻行為狀態（引擎）</h2><table>${Object.keys(STATE_LABEL).map((s) => `<tr><td>${STATE_LABEL[s]}</td><td class="n">${by.get(s) ?? 0}</td></tr>`).join('')}</table>
<h2>畫面位置（展示假設／顯示）</h2><table>${[...places].sort((a, b) => b[1] - a[1]).map(([k, n]) => `<tr><td>${esc(k)}</td><td class="n">${n}</td></tr>`).join('')}</table>
<h2>本頁開啟後觀察到的引擎事件</h2><table><tr><td>交哺（有食物轉移）</td><td class="n">${st.troph_events}</td></tr><tr><td>　其中畫面演出</td><td class="n">${st.troph_shown}</td></tr><tr><td>餵食幼蟲</td><td class="n">${st.larva_feeds}</td></tr><tr><td>　育幼探視畫面演出</td><td class="n">${st.larva_visits_shown}</td></tr><tr><td>事件總數</td><td class="n">${eventsSeen}</td></tr></table>
<div class="muted">交哺與餵食的時刻、對象與量是引擎事件；畫面只在巢內路徑與時間允許時演出（顯示），未演出的事件仍然發生。</div>
<h2>環境（引擎；天氣為合成情境）</h2><div>蜜露來源存量 ${frame.source.stock_portions.toFixed(2)} 份｜路線長度 ${frame.layout.source_distance_cm} cm｜氣溫 ${frame.env.temperature_c?.toFixed(1) ?? '—'}°C｜相對濕度 ${frame.env.rh_percent?.toFixed(0) ?? '—'}%</div>`;
}
function renderLegend() {
  const L = graph.layout, prov = L.provenance as Record<string, string>;
  ui.legend.innerHTML = `<h2>畫面上的四類資料</h2><ul>
<li><span class="tag engine">引擎</span>工蟻的活動狀態與開始時刻、出發／抵達時刻、嗉囊量（腹部脹大程度）、路線記憶、幼蟲腸道量、交哺與餵幼蟲事件（誰、何時、多少）、路線長度 ${frame?.layout.source_distance_cm ?? 200} cm、光照與合成氣溫。</li>
<li><span class="tag interp">顯示插值</span>兩個引擎紀錄點之間的位置：地表路線上的行走（出發／抵達時刻＝引擎，路徑形狀＝示意）；走向巢口／從巢口回巢內（起訖時刻＝引擎，巢內路線＝展示假設）。插值不寫回引擎、不產生事件。</li>
<li><span class="tag assume">展示假設</span>${esc(L.label_zh)}。巢內每個位置與走法：引擎沒有巢內座標，狀態改變後工蟻沿通道走到新狀態的位置，每段走動最長 ${CATCHUP_MAX_S} 秒（模擬時間）；途中演出交哺時先走到對象旁，合計上限 ${2 * CATCHUP_MAX_S + 6} 秒；休息的工蟻站定不走；「巢內走動」的閒逛路線、同通道的前後錯位（避讓）、步態、轉身、觸角與姿勢都只是畫面。螞蟻放大 ${mag} 倍（2.5 mm 畫成 ${(MINOR_LEN_CM * mag * 10).toFixed(0)} mm），通道也依放大後體型畫寬；路線長度不放大。花園景物（土、石、草、落葉、磚、盆栽、寄主植物外形）是裝飾，不是障礙物。搜尋中的位置是示意（搜尋沒有空間模型）。</li>
<li><span class="tag demo">示範資料</span>只在「展示情境」模式：蟻后 2（Owner #202 暫定 2～3）、大工蟻、卵、蛹與兩個不可取食的食物道具。固定種子、可重現、${esc(DEMO_ROUTINE_LABEL)}；不存檔、不送進 Worker。自然模式完全不畫。</li></ul>
<h2>畫面效果（HD-2D 風格，選用）</h2><div class="muted">「效能」分頁可切換「畫面風格：標準／HD-2D」。HD-2D 只改繪圖：降低內部解析度再放大（像素化）、景深（焦點＝鏡頭目標或跟隨的螞蟻）、泛光、色調、暗角，以及加密的草葉、落葉與地被葉、空中的浮塵、光束。這些全部是<b>畫面效果／裝飾</b>：不是生物、不是食物來源、螞蟻不感知；沒有加入任何蝴蝶、螢火蟲、其他昆蟲或會被當成蜜源的花。光線方向與顏色仍然依引擎的光照狀態（日／曙暮光／夜），夜間不畫光束；HD-2D 不會改變時間。${HD2D_ONLY_WEBGL2}。</div>
<h2>沒有畫的東西</h2><ul><li>費洛蒙：尚未模擬，畫面不畫任何氣味路徑；黃色虛線只是「顯示路線」（長度＝引擎路線長度，方向示意）。</li><li>固體食物搬運、其他食物種類（花蜜、昆蟲屍體）：引擎尚未模擬；只在展示情境當不可取食的道具。</li><li>身體碰撞與巢口容量：尚未模擬；畫面上的錯位只是顯示。</li></ul>
<h2>已列出的畫面跳位</h2><ul>${STAGE_DISCONTINUITIES.map((d) => `<li>${esc(d.label_zh)}</li>`).join('')}</ul>
<h2>動作都是畫面，不是引擎</h2><ul>${MOTION_NOTES.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>巢體幾何的來源</h2><div class="muted">${esc(prov.what_is_assumed_zh)}<br>${esc(prov.scale_note_zh)}<br>${esc(prov.literature_direction_zh)}</div>
<h2>階級外形</h2><div class="muted">${Object.values(MORPHS).map((m) => esc(m.note_zh)).join('；')}。幼蟲、蛹、卵的外形為一般形態示意。</div>`;
}
function renderNotSim() {
  const d = disclosure;
  ui.notsim.innerHTML = !d ? '<div class="muted">讀取中…</div>' : !d.ok ? `<div>${esc(d.reason)}</div>` : `<div class="muted">${esc(d.note_zh)}（來源：${esc(d.source)}；清單取自此世界的存檔中繼資料）</div><h2>尚未模擬（未接入）${d.unwired.length} 項</h2><ul>${d.unwired.map((x) => `<li>${esc(x.label_zh)}</li>`).join('')}</ul><h2>簡化代理 ${d.proxies.length} 項</h2><ul>${d.proxies.map((x) => `<li>${esc(x.label_zh)}</li>`).join('')}</ul>`;
}
function renderPerf() {
  const s = summarise(frameIv.slice(-240), cpuMs.slice(-240)), info = rInfo(), mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const nums = `<table><tr><td>FPS（平均／p5 低）</td><td class="n">${s.fps_mean.toFixed(0)}／${s.fps_p5_low.toFixed(0)}</td></tr><tr><td>幀時間 p50／p95</td><td class="n">${s.frame_ms.p50.toFixed(1)}／${s.frame_ms.p95.toFixed(1)} ms</td></tr><tr><td>本頁 CPU p50</td><td class="n">${s.cpu_ms.p50.toFixed(1)} ms</td></tr><tr><td>draw calls</td><td class="n">${info.calls}</td></tr><tr><td>三角形</td><td class="n">${(info.triangles / 1000).toFixed(0)}k</td></tr><tr><td>畫質／DPR</td><td class="n">${QUALITY_LABEL[quality]}${qualityLocked ? '（固定）' : '（自動）'}／${renderer.getPixelRatio().toFixed(2)}</td></tr><tr><td>JS heap</td><td class="n">${mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : '—'}</td></tr></table>`;
  // the controls are rebuilt only when they change (a click must not land on a replaced button); the numbers every time
  const ctl = `<h2>繪圖後端</h2><div id="backendNow">${esc(backend)}</div><div class="muted">GPU：${esc(glInfo)}</div>${rendererNote ? `<div class="tag none" style="white-space:normal">${esc(rendererNote)}</div>` : ''}
<div class="row">渲染器 <span class="seg"><button type="button" data-r="webgl2" aria-pressed="${rendererKind === 'webgl2'}">WebGL 2（預設）</button><button type="button" data-r="webgpu" aria-pressed="${rendererKind !== 'webgl2'}">WebGPU（實驗）</button></span></div>
<div class="muted">${WEBGPU_STATUS}切換會重新載入頁面（世界由存檔接續；臨時世界會重開）。兩種渲染器畫的是同一份引擎狀態與同一份顯示位置，只有繪圖方式不同。</div>
<h2>畫面</h2><div id="perfNums"></div>
<div class="row">畫面風格 <span class="seg"><button type="button" data-style="standard" aria-pressed="${style === 'standard'}">標準</button><button type="button" data-style="hd2d" aria-pressed="${style === 'hd2d'}" ${rendererKind === 'webgl2' ? '' : 'disabled'}>HD-2D</button></span>${rendererKind === 'webgl2' ? '' : `<span class="tag none">${HD2D_ONLY_WEBGL2}</span>`}</div>
<div class="row" ${style === 'hd2d' ? '' : 'hidden'}>像素化 <span class="seg">${PIXEL_FACTORS.map((k) => `<button type="button" data-px="${k}" aria-pressed="${pxFactor === k}">${k === 1 ? '關' : `${k}×`}</button>`).join('')}</span><label><input type="checkbox" id="fxDof" ${fx.dof ? 'checked' : ''}> 景深</label><label><input type="checkbox" id="fxBloom" ${fx.bloom ? 'checked' : ''}> 泛光</label></div>
<div class="muted" id="fxNow">作用中的畫面效果：${fxText()}。HD-2D 只是畫面效果：同一份引擎狀態、同一份顯示位置；光線方向與顏色仍依引擎的光照狀態。</div>
<div class="row">畫質 <span class="seg">${(['high', 'medium', 'low'] as const).map((k) => `<button type="button" data-q="${k}" aria-pressed="${quality === k}">${QUALITY_LABEL[k]}</button>`).join('')}</span></div>
<div class="muted">量測類別：${measurementClass(glInfo, automated)}。軟體繪圖或自動化環境的數字不是實機結果。模擬時間與畫面更新分開：畫面變慢不會改變任何事件。</div>`;
  if (ctl !== perfCtlNow) {
    perfCtlNow = ctl; ui.perf.innerHTML = ctl;
    ui.perf.querySelectorAll<HTMLButtonElement>('button[data-r]').forEach((b) => { b.onclick = () => { const u = new URL(location.href); if (b.dataset.r === 'webgpu') u.searchParams.set('renderer', 'webgpu'); else { u.searchParams.delete('renderer'); u.searchParams.delete('backend'); } u.searchParams.set('panel', 'perf'); location.href = u.href; }; });
    ui.perf.querySelectorAll<HTMLButtonElement>('button[data-style]').forEach((b) => { b.onclick = () => setStyle(b.dataset.style as Style); });
    ui.perf.querySelectorAll<HTMLButtonElement>('button[data-px]').forEach((b) => { b.onclick = () => setPixelFactor(Number(b.dataset.px)); });
    const cd = ui.perf.querySelector<HTMLInputElement>('#fxDof'), cb = ui.perf.querySelector<HTMLInputElement>('#fxBloom');
    if (cd) cd.onchange = () => { fx.dof = cd.checked; perfCtlNow = ''; renderPerf(); }; if (cb) cb.onchange = () => { fx.bloom = cb.checked; perfCtlNow = ''; renderPerf(); };
    ui.perf.querySelectorAll<HTMLButtonElement>('button[data-q]').forEach((b) => { b.onclick = () => { applyQuality(b.dataset.q as Quality); renderPerf(); }; });
  }
  $('perfNums').innerHTML = nums;
}
let perfCtlNow = '';
function renderCard() {
  if (!frame || !selected) { hideCard(); return; }
  const a = drawn.find((x) => x.id === selected), w = frame.workers.find((x) => x.id === selected), st = statics.find((x) => x.ind.id === selected);
  let html = '', sum = '';
  if (a && w) {
    const place = a.realm === 'surface' ? a.place : a.place === 'tunnel' ? '通道' : graph.chamber(a.place).label_zh;
    sum = `<b>${esc(a.id)}</b> 小工蟻・${esc(STATE_LABEL[w.state] ?? w.state)}<br><span class="muted">${tourFollows() && tour!.shot.kind === 'follow' ? `自動導覽：選取時${TOUR_REASON_ZH[tour!.shot.reason]}` : `嗉囊 ${(w.crop_fill * 100).toFixed(0)}%（引擎）｜${esc(place)}`}</span>`;
    html = `<b>${esc(a.id)}</b>　<span class="tag engine">引擎個體</span>小工蟻
<br>活動：${esc(STATE_LABEL[w.state] ?? w.state)}（引擎狀態）
<br>開始：${clockOf(w.since_s)}${w.until_s !== null ? `　預定結束：${clockOf(w.until_s)}（引擎固定時長）` : ''}
<br>嗉囊：${(w.crop_fill * 100).toFixed(0)}%（引擎；腹部脹大＝嗉囊量）　路線記憶：${w.route ? '有（引擎）' : '無'}
<br>位置：${esc(place)}${a.realm === 'nest' ? '（展示假設）' : ''}${a.pose === 'troph' ? `　正在與 ${esc(a.partner)} 交哺（引擎事件；畫面演出）` : a.pose === 'brood' && a.partner ? `　正在照顧 ${esc(a.partner)}（引擎事件；畫面演出）` : ''}
<br><span class="muted">畫面位置類別：${esc(CLASS_LABEL[a.cls])}｜步態、轉身、觸角與姿勢只是畫面</span>`;
  } else if (st) {
    const d = st.ind, ch = st.chamber ? graph.chamber(st.chamber).label_zh : '';
    sum = `<b>${esc(d.id)}</b> ${CASTE_LABEL[d.caste]}・${d.source === 'engine' ? '引擎個體' : '示範資料'}<br><span class="muted">${esc(ch)}${d.source === 'engine' && d.caste === 'larva' ? `｜腸道 ${((d.fill ?? 0) * 100).toFixed(0)}%（引擎）` : d.notes ? '｜生理與行為尚未模擬' : ''}</span>`;
    html = d.source === 'engine' && d.caste === 'larva'
      ? `<b>${esc(d.id)}</b>　<span class="tag engine">引擎個體</span>${CASTE_LABEL[d.caste]}<br>腸道量：${((d.fill ?? 0) * 100).toFixed(0)}%（引擎）${stage.fedNow(d.id, tNow) ? '　正在被餵食（引擎事件；畫面演出）' : ''}<br>位置：${esc(ch)}（展示假設）<br><span class="muted">幼蟲只被餵食與代謝；發育、化蛹、羽化尚未模擬</span>`
      : d.notes ? `<b>${esc(d.id)}</b>　<span class="tag engine">引擎個體</span><span class="tag assume">候選世界・數量為情境假設</span>${CASTE_LABEL[d.caste]}<br>狀態：${esc(d.state ?? '')}<br>位置：${esc(ch)}（展示假設；引擎沒有巢內座標）<br>此個體<b>尚未模擬</b>的項目（${d.notes.length}）：<ul style="margin:2px 0;padding-left:18px">${d.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul><span class="muted">原地微動作只是畫面</span>`
      : `<b>${esc(d.id)}</b>　<span class="tag demo">示範資料</span>${CASTE_LABEL[d.caste]}<br>動作：${esc(d.state ?? '')}<br>位置：${esc(ch)}（展示假設）<br><span class="muted">${DEMO_BADGE}：引擎尚未模擬這個階級；此個體不存檔、不影響任何引擎個體</span>`;
  } else { hideCard(); return; }
  const canFollow = !!(a && w), fol = canFollow && following === selected;
  // three parts, each rewritten only when it changes (a tap must not land on a replaced button):
  // .sum = the phone's two-line summary, .detail = the full card (wide screens; phones show it in the sheet's 個體 tab), .row = buttons
  const [sumEl, detailEl, rowEl] = ui.card.children as unknown as HTMLElement[];
  if (ui.card.hidden) { ui.card.hidden = false; layoutChrome(); }
  if (sum !== cardNow.sum) { cardNow.sum = sum; sumEl.innerHTML = sum; }
  if (html !== cardNow.detail) { cardNow.detail = html; detailEl.innerHTML = html; ui.paneAnt.innerHTML = html; }
  const btn = `${selected}|${canFollow}|${fol}`;
  if (btn === cardNow.btn) return;
  cardNow.btn = btn;
  rowEl.innerHTML = `${fol ? '<button id="cardPrev" type="button" aria-label="上一隻">◀<span class="wide-only"> 上一隻</span></button><button id="cardNext" type="button" aria-label="下一隻">▶<span class="wide-only"> 下一隻</span></button>' : ''}${canFollow ? `<button id="cardFollow" type="button" aria-pressed="${fol}">${fol ? '停止<span class="wide-only">跟隨</span>' : '跟隨<span class="wide-only">這隻</span>'}</button>` : ''}<button id="cardDetail" type="button">詳情</button><button id="cardClose" type="button" aria-label="關閉">關閉</button>`;
  if (canFollow) $('cardFollow').onclick = () => setFollow(following === selected ? null : selected);
  if (fol) { $('cardPrev').onclick = () => stepFollow(-1); $('cardNext').onclick = () => stepFollow(1); }
  $('cardDetail').onclick = () => openSide('ant');
  sumEl.onclick = () => { if (narrow()) openSide('ant'); };
  $('cardClose').onclick = () => select(null);
}
const NO_ANT_HTML = '<div class="muted">還沒有選取個體：點一下畫面上的螞蟻、幼蟲、蟻后、卵或蛹。</div>';
const cardNow = { sum: '', detail: '', btn: '' };
function hideCard() { if (!ui.card.hidden) { ui.card.hidden = true; layoutChrome(); } if (cardNow.detail !== '' || ui.paneAnt.innerHTML === '') { cardNow.sum = cardNow.detail = cardNow.btn = ''; ui.paneAnt.innerHTML = NO_ANT_HTML; } }
function select(id: string | null) { cardNow.btn = ''; selected = id; userSel = !!id; if (!id) { hideCard(); if (following) setFollow(null); if (tab === 'ant' && narrow() && sheet !== 'peek') openSide(null); } else renderCard(); }

// picking: nearest drawn individual on screen
function pick(sx: number, sy: number): string | null {
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight, frontal = camera.position.z > graph.faceZ; let best: string | null = null, bd = narrow() ? 36 : 26;
  const test = (id: string, x: number, y: number, z: number, nest: boolean) => { if (nest && !frontal) return; const p = V.set(x, y, z).project(camera); if (p.z > 1) return; const d = Math.hypot(((p.x + 1) / 2) * w - sx, ((1 - p.y) / 2) * h - sy); if (d < bd) { bd = d; best = id; } };
  for (const a of drawn) test(a.id, a.x, a.y + antLen() * 0.15, a.z, a.realm === 'nest');
  for (const s of statics) test(s.ind.id, s.p.x, s.p.y, s.p.z, true);
  return best;
}
function resize() { chromeVars(); const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); if (hd2d) { const pr = renderer.getPixelRatio(); hd2d.setSize(Math.round(w * pr), Math.round(h * pr), pxFactor); } if (offscreen && rendererKind === 'webgpu') { const pr = renderer.getPixelRatio(); if (!offRT) offRT = new THREE.RenderTarget(Math.round(w * pr), Math.round(h * pr), { depthBuffer: true }); else offRT.setSize(Math.round(w * pr), Math.round(h * pr)); } reframe(); }
/** the camera's part of a layout change: the scene is framed into the part the sheet leaves free (no buffer is reallocated) */
function reframe() { const w = innerWidth, h = innerHeight, sh = sheetPx(); camera.aspect = w / h; if (sh > 0) camera.setViewOffset(w, h, 0, Math.round(sh / 2), w, h); else camera.clearViewOffset(); camera.updateProjectionMatrix(); }

// ---------- mode (自然 / 展示情境) ----------
function setMode(m: Mode) {
  mode = m; document.body.classList.toggle('demo', m === 'demo'); ui.badge.textContent = m === 'demo' ? DEMO_BADGE : NATURAL_BADGE;
  ui.modeBtn.setAttribute('aria-pressed', String(m === 'demo')); ui.modeBtn.textContent = m === 'demo' ? '回到自然模式' : '展示情境';
  if (world) world.demoProps.visible = m === 'demo';
  if (frame) rost = roster(mode, frame, demoSeed);
  if (selected && rost && !rost.individuals.some((x) => x.id === selected)) select(null);
  ui.demoInfo.textContent = m === 'demo' ? `示範種子 ${demoSeed}（固定、可重現）` : '目前是自然模式（沒有示範個體）';
  if (tab === 'stats') renderStats();
}

// ---------- world lifecycle (Worker scheduling + SAVE-2 session) ----------
function onWorldStart() { frame = null; pacing = null; lastT = null; drawn = []; statics = []; stage?.reset(antLen()); eventsSeen = 0; disclosure = null; selected = null; following = null; userSel = false; endTour(); tourCues.length = 0; tourLog.length = 0; tourLast = null; hideCard(); }
async function afterWorldReady(startAt: number | null) {
  if (startAt !== null && (frame?.t_sim ?? 0) < startAt) await client.stepUntil(startAt);
  await new Promise<void>((r) => { const w = () => (frame ? r() : setTimeout(w, 20)); w(); });
  vis = VisModel.of(frame!); rost = roster(mode, frame!, demoSeed);
  if (!world) { world = buildScene({ graph, corridor: corridor3(vis), source: source3(vis), searchRadius: SEARCH_RADIUS_CM }); scene.add(world.group); applyQuality(quality); }
  setLight(frame!); setMode(mode); world.setStyle(style === 'hd2d');
  const snap = await client.snapshot();
  disclosure = snap.type === 'snapshot' ? notSimulatedOf(snap.snapshot) : { ok: false, reason: '無法讀取此世界的存檔中繼資料：「尚未模擬」清單未知，不得把畫面當成已模擬任何機制' };
  renderNotSim(); renderLegend(); renderWorldInfo();
  await client.setSpeed(speed);
  if (q.get('autostart') !== '0') { await client.start().catch(() => {}); running = true; } else running = false;
  syncPlay();
}
function renderWorldInfo() {
  const cur = session?.current;
  const col = frame ? colonyOf(frame) : null;
  ui.worldInfo.innerHTML = frame ? `${col ? `候選世界 p0a2-colony（${esc(col.status_zh)}）：蟻后 ${col.queens.length}、大工蟻 ${col.majors.length}、卵 ${col.eggs.length}、蛹 ${col.pupae.length} 是引擎個體，數量全部是情境假設（情境 ${esc(col.scenario.id)}）；牠們在引擎中不進食、不產卵、不發育、不移動（尚未模擬）` : 'P0-A2 世界：只有小工蟻與幼蟲（蟻后、大工蟻、卵、蛹尚未模擬）'}<br>世界 ${esc(frame.world_id)}｜種子 ${frame.seed}｜規則指紋 ${esc(frame.rules_fingerprint.slice(0, 12))}…<br>${tempMode ? '臨時世界（網址帶 seed：不存檔）' : cur ? `「${esc(cur.name)}」｜${cur.writer ? '本分頁可存檔' : esc(cur.readOnlyReason ?? '唯讀')}｜${esc(cur.verification)}` : '未連結存檔'}` : '';
  ui.saveBtn.disabled = tempMode || !cur?.writer;
}
function renderSaveStatus() {
  if (tempMode) { ui.saveStatus.textContent = '臨時世界不存檔'; return; }
  const s = saveUi; ui.saveStatus.textContent = !s ? '尚未儲存' : s.status === 'saving' ? '正在儲存…' : s.status === 'failed' ? `儲存失敗（${s.last_error ?? ''}）— 上一個成功的存檔仍保留` : s.last_success_ms ? `已儲存 ${new Date(s.last_success_ms).toLocaleTimeString('zh-TW', { hour12: false })}` : s.text;
}
async function newWorld(seedText: string) {
  if (!session) return;
  ui.restartBtn.disabled = true; toast('建立新世界…');
  const r = await session.newGame(`Demo 2・${new Date().toLocaleString('zh-TW', { hour12: false })}`, seedText, worldKind);
  ui.restartBtn.disabled = false;
  if (!r.ok) { toast(`無法建立新世界（${r.code}）：${r.message}`, 6000); return; }
  await afterWorldReady(START_T); goView(view, true); void session.request('manual'); void refreshSaveList();
  toast(`新世界：種子 ${r.value.seed}（${r.value.how}）`);
}
async function openWorld(id: string, steal = false): Promise<boolean> {
  if (!session) return false;
  const r = await session.open(id, { steal });
  if (!r.ok) { toast(`無法載入（${r.code}）：${r.message}`, 6000); return false; }
  await afterWorldReady(null); goView(view, true); void refreshSaveList();
  toast(`已載入存檔：${fmtWorldTime(frame!.t_sim)}，從這裡繼續`);
  return true;
}
async function refreshSaveList() {
  if (!session) { ui.saveList.textContent = tempMode ? '臨時世界（網址帶 seed）不使用存檔。' : '無法使用本機存檔。'; return; }
  let rows; try { rows = await session.list(); } catch { ui.saveList.textContent = '無法讀取存檔清單'; return; }
  const p0 = rows.filter((w) => isDemoWorld(w.engine_version));
  ui.saveList.innerHTML = p0.length ? p0.map((w) => `<div class="row" style="border-bottom:1px solid rgba(243,234,214,0.1);padding-bottom:5px"><span style="flex:1 1 150px">${esc(w.name)}<br><span class="muted">種子 ${w.seed}｜${w.sim_day !== null ? `第 ${w.sim_day} 天 ${esc(w.sim_clock ?? '')}` : '—'}｜${w.compat === 'compatible' ? '可載入' : esc(String(w.compat))}${w.world_id === session!.current?.world_id ? '｜目前開啟' : ''}</span></span><button type="button" data-open="${esc(w.world_id)}" ${w.compat !== 'compatible' || w.world_id === session!.current?.world_id ? 'disabled' : ''}>載入</button><button type="button" data-export="${esc(w.world_id)}">匯出</button></div>`).join('') : '還沒有存檔。';
  ui.saveList.querySelectorAll<HTMLButtonElement>('button[data-open]').forEach((b) => { b.onclick = () => void openWorld(b.dataset.open!); });
  ui.saveList.querySelectorAll<HTMLButtonElement>('button[data-export]').forEach((b) => { b.onclick = async () => { const r = await session!.store.exportWorld(b.dataset.export!); if (!r.ok) { toast(`匯出失敗（${r.code}）：${r.message}`); return; } const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([r.value.text], { type: 'application/json' })); a.download = r.value.filename; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }; });
}

async function setRunning(on: boolean) {
  const p = pacing; if (!p) return;
  if (on) { if (!p.started) await client.start(); else if (!p.running) await client.resume(); } else if (p.running) { await client.pause(); void session?.request('pause'); }
  running = on; syncPlay();
}
function syncPlay() { ui.play.textContent = running ? '暫停' : '繼續'; ui.speed.value = String(speed); }
async function setSpeed(s: number) { speed = s; ui.speed.value = String(s); await client.setSpeed(s); }

// ---------- start ----------
async function main() {
  if (wantWebGPU) {
    // opt-in: three's WebGPURenderer, only on a REAL WebGPU backend (never reported as WebGPU when three falls back to WebGL 2)
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<{ info?: { vendor?: string; architecture?: string; description?: string } } | null> } }).gpu;
    let adapter: { info?: { vendor?: string; architecture?: string; description?: string } } | null = null;
    if (!forceNodeGL) { try { adapter = gpu ? await gpu.requestAdapter() : null; } catch { adapter = null; } }
    if (adapter || forceNodeGL) {
      try {
        const G = await import('three/webgpu'), T = await import('three/tsl');
        const r = new G.WebGPURenderer({ canvas: ui.canvas, antialias: quality !== 'low', forceWebGL: forceNodeGL });
        await r.init();
        const real = (r.backend as unknown as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
        if (real || forceNodeGL) {
          renderer = r as unknown as THREE.WebGLRenderer; rendererKind = real ? 'webgpu' : 'webgpu-webgl2'; rigNode = rigNodeMaterial(G, T);
          if (real) void (r.backend as unknown as { device?: { lost: Promise<{ message: string }> } }).device?.lost.then((i) => webgpuLost(i.message));
          glInfo = real ? `WebGPU adapter：${[adapter?.info?.vendor, adapter?.info?.architecture, adapter?.info?.description].filter(Boolean).join(' ') || '（瀏覽器未提供 adapter 資訊）'}` : '（three WebGPURenderer 的 WebGL 2 backend）';
        } else { r.dispose(); swapCanvas(); rendererNote = 'WebGPU 初始化後 three 改用了它的 WebGL 2 backend：本頁已改回 WebGL 2 渲染器（不是 WebGPU）'; }
      } catch (e) { swapCanvas(); rendererNote = `WebGPU 渲染器建立失敗（${(e as Error).message}）：已改用 WebGL 2`; }
    } else rendererNote = gpu ? '這個瀏覽器有 navigator.gpu 但拿不到 WebGPU adapter：已改用 WebGL 2' : '這個瀏覽器沒有提供 WebGPU（navigator.gpu）：已改用 WebGL 2';
    if (rendererNote) toast(rendererNote, 9000);
  }
  if (rendererKind === 'webgl2') {
    if (!webgl2Available()) { fatal('這個瀏覽器或裝置無法使用 WebGL 2，Demo 2 的 3D 畫面無法顯示。'); return; }
    try { renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: quality !== 'low', powerPreference: 'high-performance' }); } catch (e) { fatal(`無法建立 WebGL 繪圖環境（${esc((e as Error).message)}）。`); return; }
    const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); glInfo = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  }
  renderer.info.autoReset = false;
  if (rendererKind === 'webgl2') hd2d = new Hd2dPipeline(renderer); else if (style === 'hd2d') { style = 'standard'; rendererNote = rendererNote || `${HD2D_ONLY_WEBGL2}（已改用標準畫面）`; }
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.98; renderer.shadowMap.type = rendererKind === 'webgl2' ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  backend = rendererKind === 'webgpu' ? `WebGPU（three r${THREE.REVISION} WebGPURenderer；實際 backend＝WebGPU）｜實驗` : rendererKind === 'webgpu-webgl2' ? `three r${THREE.REVISION} WebGPURenderer 的 WebGL 2 backend（node material 路徑；不是 WebGPU）` : `WebGL 2（three r${THREE.REVISION} WebGLRenderer）｜WebGPU：此瀏覽器${'gpu' in navigator ? '有提供' : '未提供'}${wantWebGPU ? '（要求了 WebGPU，但已退回 WebGL 2）' : '，可在此面板切換（實驗）'}`;
  ui.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('繪圖環境遺失（WebGL context lost）：請重新整理頁面；模擬與存檔不受影響', 10000); });
  controls = new OrbitControls(camera, ui.canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.screenSpacePanning = true; controls.minDistance = 4; controls.maxDistance = 700;
  controls.minPolarAngle = 0.12; controls.maxPolarAngle = Math.PI * 0.53; controls.minAzimuthAngle = -1.15; controls.maxAzimuthAngle = 1.15; controls.zoomToCursor = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }; controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.addEventListener('start', () => { userBusy = true; tween = null; }); controls.addEventListener('end', () => { userBusy = false; });
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 110, bottom: -110, near: 10, far: 900 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
  scene.add(sunTarget); sun.target = sunTarget; lamp.position.set(10, 10, 200); lamp.target.position.set(10, -16, 0); scene.add(sun, hemi, lamp, lamp.target);
  resize(); addEventListener('resize', resize);

  const raw = await (await fetch('vendor/demo2/nest-layout.json')).json();
  graph = new NestGraph(parseLayout(raw), ground(0, 0)); stage = new ColonyStage(graph, antLen());
  buildMeshes();

  client.onState = (fr, p, fol) => { if (!isP0a2Frame(fr) || fr.world_id === PROBE_ID) return; if (p.running && frame && fr.t_sim !== frame.t_sim) session?.markDirty(); frame = fr; pacing = p; frameAt = performance.now(); followedView = fol; if (rost) rost = roster(mode, fr, demoSeed); };
  client.onEvents = (evs: EventMsg[]) => { if (evs[0]?.world_id === PROBE_ID) return; eventsSeen += evs.length; stage.onEvents(evs); noteCues(evs); session?.markDirty(); };
  client.onProtocolError = (why) => toast(`Worker：${why}`, 8000);

  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join(''); ui.seedIn.value = String(DEFAULT_SEED);
  goView('full', true); requestAnimationFrame((t) => { lastNow = t; requestAnimationFrame(tick); });

  if (tempMode) { // ?seed=N: a temporary, unsaved world (tests and quick looks)
    const seed = Number(q.get('seed')), r = await client.init(`exp-demo2-${seed}`, seed, worldKind);
    if (r.type === 'error') { fatal(`無法建立實驗世界：${esc(r.code)} ${esc(r.message)}`); return; }
    await afterWorldReady(START_T);
  } else {
    const st = await ExperimentSaveStore.open();
    if (st.ok) {
      session = new ExperimentSession(client, st.value);
      session.onWorldStart = onWorldStart; session.onSaveState = (s) => { saveUi = s; };
      session.onLockLost = () => { toast('另一個分頁接手了這個世界：本分頁改為唯讀（不再存檔）', 8000); renderWorldInfo(); };
      let resumed = false;
      // The session reads what each world kind expects of a snapshot from throw-away probe worlds in the SAME Worker
      // (session.ts runtimeInfo). All probes must run BEFORE the demo world exists: list() runs them once (cached).
      let rows: Awaited<ReturnType<ExperimentSession['list']>> = [];
      try { rows = await session.list(); } catch { rows = []; }
      if (!q.has('new')) { // continue the world this browser played last (SAVE-2), if it is a loadable P0-A2 world
        try { const id = await st.value.lastPlayed(), row = id ? rows.find((w) => w.world_id === id) : null; if (row && row.compat === 'compatible' && isDemoWorld(row.engine_version)) resumed = await openWorld(row.world_id); } catch { resumed = false; }
      }
      if (!resumed) await newWorld(String(DEFAULT_SEED));
      if (!frame) { tempMode = true; session = null; onWorldStart(); await client.init(`exp-demo2-${DEFAULT_SEED}`, DEFAULT_SEED, worldKind); await afterWorldReady(START_T); toast('無法使用存檔（可能另一個分頁正在使用）：改用不存檔的臨時世界', 7000); }
    } else { tempMode = true; toast(`無法使用本機存檔（${st.code}）：改用不存檔的臨時世界`, 7000); await client.init(`exp-demo2-${DEFAULT_SEED}`, DEFAULT_SEED, worldKind); await afterWorldReady(START_T); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void session?.request('hidden'); });
    addEventListener('pagehide', () => { void session?.request('pagehide'); });
  }
  void refreshSaveList();
  if (q.get('follow')) setFollow(q.get('follow'));
  if (q.get('view')) goView(q.get('view') as View, true);
  if (q.get('panel')) openSide(q.get('panel')!);
  hooks.ready = true;
}

/** engine events the tour may point the camera at: who passed food to a nestmate, who fed a larva (read only) */
function noteCues(evs: readonly EventMsg[]) {
  for (const e of evs) {
    if (!e.entity) continue; const d = e.data as { touched?: { amount: number }[]; larvae?: { fed: number }[] };
    if (Array.isArray(d.touched) && d.touched.some((x) => x.amount > 0)) tourCues.push({ id: e.entity, kind: 'troph', t_sim: e.t_sim });
    if (Array.isArray(d.larvae) && d.larvae.some((x) => x.fed > 0)) tourCues.push({ id: e.entity, kind: 'larva_feed', t_sim: e.t_sim });
  }
  if (tourCues.length > 32) tourCues.splice(0, tourCues.length - 32);
}

// ---------- controls ----------
function openSide(t: string | null) {
  // wide screens: the side panel opens / closes; phones: the sheet goes to its peek row (closed) or at least half
  if (t === null) { setSheet('peek'); return; }
  if (sheet === 'peek') setSheet('half'); // the scene is re-framed into the part the sheet leaves free
  openTab(t);
}
function openTab(t: string) {
  { tab = t; document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === t))); for (const k of ['ant', 'stats', 'legend', 'notsim', 'saves', 'perf']) $(`pane-${k}`).hidden = k !== t; if (t === 'stats') renderStats(); if (t === 'perf') renderPerf(); if (t === 'saves') { renderSaveStatus(); void refreshSaveList(); } }
}
const openTabName = () => (tab === 'ant' && (!selected || !narrow()) ? 'stats' : tab);
ui.sideBtn.onclick = () => openSide(document.body.classList.contains('side-closed') ? openTabName() : null);
ui.perfBtn.onclick = () => openSide('perf');
// phone: the 更多 menu (展示情境, 跟隨, 自動導覽, 面板, 畫面與效能); it closes after a choice or a tap outside
const setMore = (on: boolean) => { document.body.classList.toggle('more-open', on); ui.moreBtn.setAttribute('aria-expanded', String(on)); };
ui.moreBtn.onclick = () => setMore(!document.body.classList.contains('more-open'));
ui.more.addEventListener('click', () => setMore(false));
addEventListener('pointerdown', (e) => { if (document.body.classList.contains('more-open') && !(e.target as HTMLElement).closest('#more, #moreBtn')) setMore(false); }, true);
// phone: the status row is one short line; a tap (or Enter) expands / collapses it
const toggleHud = () => { if (!narrow()) return; hudOpen = !hudOpen; document.body.classList.toggle('hud-open', hudOpen); ui.hud.setAttribute('aria-expanded', String(hudOpen)); hudAt = 0; updateHud(performance.now()); layoutChrome(); };
ui.statusRow.onclick = toggleHud; ui.hud.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') toggleHud(); };
ui.tourBtn.onclick = () => { tourOn = !tourOn; syncTourBtn(); toast(tourOn ? `自動導覽已開啟：沒有操作 ${tourIdle} 秒後開始（只動鏡頭，不影響模擬）` : '自動導覽已關閉'); };
ui.tourChip.onclick = () => stopTour(); syncTourBtn();
/** phone: the floating 面板 pill (sheet closed) and the grip on top of the open sheet: tap = open / close, drag = closed / half / full */
function bindSheetHandle(el: HTMLElement) {
  let d: { y: number; h: number; moved: boolean } | null = null;
  el.addEventListener('pointerdown', (e) => { if (!narrow()) return; d = { y: e.clientY, h: sheetNow, moved: false }; el.setPointerCapture(e.pointerId); });
  el.addEventListener('pointermove', (e) => {
    if (!d) return; const dy = d.y - e.clientY; if (!d.moved && Math.abs(dy) > 6) { d.moved = true; document.body.classList.add('dragging'); document.body.classList.remove('side-closed'); openTab(openTabName()); }
    if (d.moved) layoutChrome(Math.max(1, Math.min(sheetTarget('full'), d.h + dy)));
  });
  const end = () => {
    if (!d) return; const was = d; d = null; document.body.classList.remove('dragging');
    if (!was.moved) { openSide(sheet === 'peek' ? openTabName() : null); return; }
    const near = (['peek', 'half', 'full'] as const).map((k) => [k, Math.abs(sheetTarget(k) - sheetNow)] as const).sort((x, y) => x[1] - y[1])[0][0];
    if (near === 'peek') openSide(null); else { setSheet(near); openSide(openTabName()); }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('keydown', (e) => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) openSide(sheet === 'peek' ? openTabName() : null); });
}
bindSheetHandle(ui.peek); bindSheetHandle(ui.grip);
chromeVars(); hideCard();
document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => { b.onclick = () => openSide(b.dataset.tab!); });
ui.play.onclick = () => void setRunning(!running);
ui.speed.onchange = () => void setSpeed(Number(ui.speed.value));
ui.viewFull.onclick = () => goView('full'); ui.viewSurface.onclick = () => goView('surface'); ui.viewUnder.onclick = () => goView('under');
ui.modeBtn.onclick = () => setMode(mode === 'demo' ? 'natural' : 'demo');
ui.followBtn.onclick = () => { if (following) setFollow(null); else { const id = selected && drawn.some((a) => a.id === selected) ? selected : interestingAnt(); if (id) setFollow(id); } };
ui.saveBtn.onclick = async () => { const r = await session?.request('manual'); renderSaveStatus(); toast(r && r.ok ? '已儲存（引擎快照；示範資料與鏡頭不存）' : '儲存未完成'); void refreshSaveList(); };
ui.restartBtn.onclick = () => { if (tempMode || !session) { location.search = `?seed=${encodeURIComponent(ui.seedIn.value || String(DEFAULT_SEED))}`; return; } void newWorld(ui.seedIn.value || String(DEFAULT_SEED)); };
ui.resetDemoBtn.onclick = () => { demoSeed = DEFAULT_SEED; setMode('demo'); toast('展示情境已重設（示範資料回到固定種子的初始排列；引擎世界不受影響）'); };
ui.importBtn.onclick = () => ui.importFile.click();
ui.importFile.onchange = async () => { const f = ui.importFile.files?.[0]; ui.importFile.value = ''; if (!f || !session) return; const text = await f.text(), r = await session.store.importWorld(text, await session.runtimeForImport(text)); toast(r.ok ? '已匯入：可在清單中載入' : `匯入失敗（${r.code}）：${r.message}`, 6000); void refreshSaveList(); };
let down: { x: number; y: number; t: number } | null = null;
function bindCanvas() {
  ui.canvas.addEventListener('pointerdown', (e) => { down = { x: e.offsetX, y: e.offsetY, t: performance.now() }; });
  ui.canvas.addEventListener('pointerup', (e) => { if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 7 && performance.now() - down.t < 500) select(pick(e.offsetX, e.offsetY)); down = null; });
}
bindCanvas();

// test / automation hooks: read-only views of the page; only scheduling / observation commands reach the Worker
const hooks: Record<string, unknown> = {
  ready: false, three: THREE.REVISION,
  backend: () => backend, gl: () => glInfo,
  state: () => ({ running, speed, mode, view, quality, selected, following, mag, t: tNow, frame_t: frame?.t_sim ?? null, seed: frame?.seed ?? null, world_id: frame?.world_id ?? null, temp: tempMode, ants: drawn.length, hi: layers.minorHi?.mesh.count ?? 0, lo: layers.minorLo?.mesh.count ?? 0, queens: layers.queen?.mesh.count ?? 0, majors: layers.major?.mesh.count ?? 0, eggs: eggMesh?.count ?? 0, pupae: pupaMesh?.count ?? 0, larvae: larvaMesh?.count ?? 0, uTime: uTime.value, cam: camera.position.toArray(), target: controls?.target.toArray(), events: eventsSeen, stats: { ...stage.stats }, save: saveUi, calls: rInfo().calls, triangles: rInfo().triangles, renderer: rendererKind, rendererNote, followed: followedView !== null }),
  ants: () => drawn.map((a) => ({ ...a })),
  roster: () => rost, statics: () => statics.map((s) => ({ id: s.ind.id, caste: s.ind.caste, source: s.ind.source, ...s.p })),
  frame: () => frame, sdf: (x: number, y: number) => graph.sdf(x, y), faceZ: () => graph.faceZ,
  screenOf: (id: string) => { const a = drawn.find((x) => x.id === id) ?? statics.map((s) => ({ id: s.ind.id, ...s.p })).find((x) => x.id === id); if (!a) return null; const p = new THREE.Vector3(a.x, a.y, a.z).project(camera); return { x: ((p.x + 1) / 2) * ui.canvas.clientWidth, y: ((1 - p.y) / 2) * ui.canvas.clientHeight, z: p.z }; },
  select: (id: string | null) => select(id), follow: (id: string | null) => setFollow(id), setRunning: (on: boolean) => setRunning(on), setSpeed: (s: number) => setSpeed(s),
  setView: (v: View, instant = true) => goView(v, instant), setMode: (m: Mode) => setMode(m), setQuality: (k: Quality) => applyQuality(k), openSide: (t: string | null) => openSide(t),
  setRender: (on: boolean) => { renderOn = on; },
  setStyle: (st: Style) => setStyle(st), setPixelFactor: (f: number) => setPixelFactor(f), setFx: (d: boolean, b: boolean) => { fx.dof = d; fx.bloom = b; perfCtlNow = ''; },
  style: () => ({ style, active: hd2dActive(), px: pxFactor, fx: { ...fx }, text: fxText(), low: hd2d ? [hd2d.lowW, hd2d.lowH] : null, scene: world?.styleState() ?? null, light: frame?.env.light ?? null, buf: [ui.canvas.width, ui.canvas.height], renderer: rendererKind }),
  /** verification only: the offscreen WebGPU image as a JPEG data URL (linear → sRGB here; no tone mapping) */
  grab: async (q2 = 0.8) => {
    if (!offRT) return null;
    const w = offRT.width, h = offRT.height, px = await (renderer as unknown as { readRenderTargetPixelsAsync(rt: unknown, x: number, y: number, w: number, h: number): Promise<Uint8Array> }).readRenderTargetPixelsAsync(offRT, 0, 0, w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; const g2 = c.getContext('2d')!, img = g2.createImageData(w, h), lut = new Uint8ClampedArray(256); for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * Math.pow(i / 255, 1 / 2.2));
    let lit = 0; for (let i = 0; i < w * h * 4; i += 4) { img.data[i] = lut[px[i]]; img.data[i + 1] = lut[px[i + 1]]; img.data[i + 2] = lut[px[i + 2]]; img.data[i + 3] = 255; if (px[i] + px[i + 1] + px[i + 2] > 24) lit++; }
    g2.putImageData(img, 0, 0); return { url: c.toDataURL('image/jpeg', q2), w, h, lit_fraction: lit / (w * h) };
  },
  nestOnScreen: () => nestOnScreen(),
  /** phone layout: the sheet state and the part of the page height the scene keeps (below the top bar, above the sheet) */
  layout: () => { const top = ui.top.getBoundingClientRect().bottom; return { narrow: narrow(), sheet, sheet_px: sheetPx(), top_px: top, scene_fraction: (innerHeight - top - sheetPx()) / innerHeight, hud_open: hudOpen }; },
  setSheet: (s: Sheet) => { if (s === 'peek') openSide(null); else { setSheet(s); openSide(openTabName()); } },
  /** 自動導覽 (camera only): whether it is on / running, the current shot and the shots so far */
  tour: () => ({ on: tourOn, idle_s: tourIdle, idle_for_s: (performance.now() - lastInput) / 1000, active: tour !== null, k: tour?.k ?? null, shot: tour?.shot ?? null, follows: tourFollows(), observed, cues: tourCues.length, log: tourLog.map((x) => ({ ...x })) }),
  setTour: (on: boolean) => { tourOn = on; syncTourBtn(); if (!on) stopTour(); },
  /** screen rectangles of the visible in-scene labels and of the legend line */
  labelRects: () => [...labelEls.entries()].filter(([, el]) => !el.hidden).map(([key, el]) => { const r = el.getBoundingClientRect(); return { key, text: el.textContent, left: r.left, top: r.top, w: r.width, h: r.height }; }),
  /** does the soil (block or its extension wall) cover the bottom corners and bottom centre of the visible scene? */
  soilAtBottom: () => [0.02, 0.5, 0.98].every((u) => { const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(u * 2 - 1, 1 - (2 * (sceneBottom() - 2)) / ui.canvas.clientHeight), camera); const o = ray.ray.origin, d = ray.ray.direction; if (d.z >= 0) return false; const k = (graph.faceZ - o.z) / d.z, y = o.y + d.y * k, x = o.x + d.x * k; return k > 0 && y < ground(Math.max(BLOCK.x0, Math.min(BLOCK.x1, x)), graph.faceZ) && y > BLOCK.bottom - 700 && x > BLOCK.x0 - 900 && x < BLOCK.x1 + 900; }),
  antPx: () => { const a = drawn.find((x) => x.realm === 'nest'); if (!a) return 0; const d = camera.position.distanceTo(new THREE.Vector3(a.x, a.y, a.z)); return (antLen() / d) * (ui.canvas.clientHeight / 2 / Math.tan((camera.fov * Math.PI) / 360)); },
  /** scheduling only: run the world to t (paused pages then show exactly the frame's instant) */
  stepUntil: async (t: number) => { await client.stepUntil(t); },
  /** the drawn workers for the latest frame at ITS instant (a paused page shows exactly this; no wait for a repaint) */
  sampleNow: () => { if (!frame || !vis) return null; tNow = frame.t_sim; drawn = stage.update(frame, vis, tNow, 0); return { t: tNow, ants: drawn.map((a) => ({ id: a.id, state: a.state, realm: a.realm, x: a.x, y: a.y, z: a.z, place: a.place, pose: a.pose, absorbed: a.absorbed })) }; },
  save: async () => { const r = await session?.request('manual'); return r ? (r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message }) : { ok: false, code: 'no_session', message: '' }; },
  view: (pos: number[], tgt: number[]) => { tween = null; camera.position.fromArray(pos); controls.target.fromArray(tgt); controls.update(); },
  perf: () => ({ ...summarise(frameIv.slice(-240), cpuMs.slice(-240)), ...rInfo(), renderer: rendererKind, backend, quality, dpr: renderer.getPixelRatio(), gl: glInfo, measurement_class: measurementClass(glInfo, automated), scene_triangles: world?.triangles() ?? 0 }),
};
(window as unknown as { __demo2: Record<string, unknown> }).__demo2 = hooks;
main().catch((e) => { console.error(e); fatal(`載入失敗：${esc((e as Error).message)}`); });
