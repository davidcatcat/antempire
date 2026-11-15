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
import { isP0a2Frame, type EventMsg, type P0a2FrameMsg, type PacingMsg } from '../experimental/worker-protocol.ts';
import { STATE_LABEL, P0_LIGHT_LABEL, P0A2_STATUS_LABEL } from '../v62-p0a2-model.ts';
import { VisModel, SEARCH_RADIUS_CM } from '../vis1-model.ts';
import { displayTime, fmtWorldTime, clockOf } from '../v62-model.ts';
import { hash32 } from '../game-model.ts';
import { MINOR_LEN_CM, MODEL_LEN } from '../three/ant-model.ts';
import { summarise, measurementClass } from '../three/perf.ts';
import { NestGraph, parseLayout, type P3, type Pos } from './nest-graph.ts';
import { ColonyStage, CLASS_LABEL, STAGE_DISCONTINUITIES, CATCHUP_MAX_S, type DrawnAnt } from './stage.ts';
import { BLOCK, corridor3, ground, source3 } from './surface.ts';
import { roster, CASTES, CASTE_LABEL, DEMO_BADGE, NATURAL_BADGE, DEMO_FOOD_PROPS, DEMO_ROUTINE_LABEL, type Individual, type Mode, type Roster } from './feed.ts';
import { eggSpot, larvaSpot, majorSpot, pupaSpot, queenSpot } from './places.ts';
import { newGait, stepGait, type Gait } from './gait.ts';
import { MORPHS, RigLayer, rigMaterial, larvaGeometry, pupaGeometry, eggGeometry, type RigCaste } from './ant-rig.ts';
import { buildScene, type Quality, type Scene2 } from './scene.ts';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('scene'), badge: $('modeBadge'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), hud: $('hud'),
  viewFull: $<HTMLButtonElement>('viewFull'), viewSurface: $<HTMLButtonElement>('viewSurface'), viewUnder: $<HTMLButtonElement>('viewUnder'), modeBtn: $<HTMLButtonElement>('modeBtn'),
  followBtn: $<HTMLButtonElement>('followBtn'), sideBtn: $<HTMLButtonElement>('sideBtn'), card: $('card'), labels: $('labels'), toast: $('toast'), fatal: $('fatal'),
  stats: $('pane-stats'), legend: $('pane-legend'), notsim: $('pane-notsim'), perf: $('pane-perf'), worldInfo: $('worldInfo'), saveBtn: $<HTMLButtonElement>('saveBtn'), saveStatus: $('saveStatus'),
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

// ---------- renderer (WebGL 2; see docs/demo2.md for the WebGPU decision) ----------
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
const gaits = new Map<string, Gait>(), quats = new Map<string, THREE.Quaternion>();
const M4 = new THREE.Matrix4(), Qa = new THREE.Quaternion(), Qb = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color(), X = new THREE.Vector3(), Y = new THREE.Vector3(), Z = new THREE.Vector3();

function basis(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number, out: THREE.Quaternion): THREE.Quaternion {
  X.set(fx, fy, fz); if (X.lengthSq() < 1e-9) X.set(1, 0, 0); X.normalize(); Y.set(ux, uy, uz);
  Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 0, 1); Z.crossVectors(X, Y); if (Z.lengthSq() < 1e-6) { Y.set(0, 1, 0); Z.crossVectors(X, Y); } }
  Z.normalize(); Y.crossVectors(Z, X).normalize();
  return out.setFromRotationMatrix(M4.makeBasis(X, Y, Z));
}
/** how far the body is set below the walk line inside the nest so the feet touch the drawn floor (cm; display) */
const NEST_FOOT_DROP = 0.3;

function buildMeshes() {
  rigMat = rigMaterial(uTime);
  layers.minorHi = new RigLayer('minor', 'hi', 256, rigMat); layers.minorLo = new RigLayer('minor', 'lo', 256, rigMat);
  layers.major = new RigLayer('major', 'hi', 32, rigMat); layers.queen = new RigLayer('queen', 'hi', 8, rigMat);
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
  gr.addColorStop(0, hex(c.clone().multiplyScalar(0.86))); gr.addColorStop(0.42, hex(c.clone().lerp(new THREE.Color(0xffffff), 0.25))); gr.addColorStop(0.6, hex(c.clone().lerp(new THREE.Color(0x3a322a), 0.75))); gr.addColorStop(1, '#241e18');
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
  if (v === 'surface') return narrow() ? mk(22, 0, -14, 50, -10, Math.min(260, fit(30))) : mk(48, 0, -26, 46, -12, Math.min(260, fit(84)));
  if (v === 'under') return narrow() ? mk(5, -19, 0, 4, 0, Math.min(230, fit(24))) : mk(5, -17, 0, 3, 0, Math.min(260, fit(47)));
  return narrow() ? mk(5, -15, 0, 12, -4, Math.min(240, fit(26))) : mk(8, -10, 0, 14, -7, Math.min(260, fit(50)));
}
let tween: { from: Cam; to: Cam; t: number; dur: number } | null = null, userBusy = false, followAdjust = 0;
function goView(v: View, instant = false) {
  view = v; for (const [b, k] of [[ui.viewFull, 'full'], [ui.viewSurface, 'surface'], [ui.viewUnder, 'under']] as const) b.setAttribute('aria-pressed', String(k === v));
  if (following) setFollow(null);
  const to = viewCam(v);
  if (instant) { camera.position.copy(to.pos); controls.target.copy(to.tgt); controls.update(); tween = null; return; }
  tween = { from: { pos: camera.position.clone(), tgt: controls.target.clone() }, to, t: 0, dur: 0.9 };
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
    }
  }
  // keep the view on the block
  controls.target.x = Math.max(BLOCK.x0, Math.min(BLOCK.x1, controls.target.x)); controls.target.z = Math.max(BLOCK.z0, Math.min(BLOCK.z1 + 2, controls.target.z)); controls.target.y = Math.max(BLOCK.bottom, Math.min(40, controls.target.y));
  controls.update();
}
let followRealm: 'surface' | 'nest' | null = null;
function setFollow(id: string | null) {
  following = id; followRealm = null; tween = null;
  ui.followBtn.setAttribute('aria-pressed', String(!!id)); ui.followBtn.textContent = id ? `停止跟隨 ${id}` : '跟隨螞蟻';
  if (id) {
    selected = id; const a = drawn.find((x) => x.id === id);
    if (a) { const dir = camera.position.clone().sub(controls.target).normalize(), d = Math.max(antLen() * 11, 20); controls.target.set(a.x, a.y, a.z); camera.position.copy(controls.target).addScaledVector(dir, d); followRealm = a.realm; followAdjust = 1.6; }
  }
  void client.follow(id).catch(() => {}); // observation only: the Worker sends this worker's own record with each frame
  renderCard();
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

function place(layer: RigLayer, i: number, p: P3, qt: THREE.Quaternion, scale: number, color: THREE.Color, g: Gait, crop: number, seed: number) {
  M4.compose(V.set(p.x, p.y, p.z), qt, S.setScalar(scale)); layer.mesh.setMatrixAt(i, M4); layer.mesh.setColorAt(i, color);
  layer.anim.setXYZW(i, g.phase, g.walk, seed, g.act); layer.pose.setXYZW(i, crop, g.pitch, g.antUp, g.crouch);
}
const floorPoint = (pos: Pos): P3 => { const p = graph.point(pos); return { x: p.x, y: p.y - NEST_FOOT_DROP, z: p.z }; };

function drawStatics(dtAnim: number) {
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
  // 展示情境 only: demo queens, majors, eggs, pupae (示範資料; in-place idle micro-motion only)
  let nq = 0, nm = 0, ne = 0, np = 0;
  const demo = rost.individuals.filter((x) => x.source === 'demo'), count = (c: string) => demo.filter((x) => x.caste === c).length;
  for (const d of demo) {
    const g = gaits.get(d.id) ?? newGait(); gaits.set(d.id, g); const seed = (hash32(d.id) % 9973) / 9973, sel = d.id === selected;
    if (d.caste === 'queen' || d.caste === 'major') {
      const spot = d.caste === 'queen' ? { pos: queenSpot(graph, d.index, count('queen'), L), faceEast: d.index % 2 === 0 } : majorSpot(graph, d.index, demoSeed, L), p = floorPoint(spot.pos);
      stepGait(g, { ...p, moving: false, pose: d.caste === 'queen' ? 'rest' : 'stand' }, dtAnim, L); if (d.caste === 'queen') g.crouch = 0.2;
      const layer = d.caste === 'queen' ? layers.queen : layers.major, tone = d.caste === 'queen' ? 0.92 : 0.98;
      place(layer, d.caste === 'queen' ? nq++ : nm++, p, basis(spot.faceEast ? 1 : -1, 0, 0.12 * (seed - 0.5), 0, 1, 0, Qa), sc * MORPHS[d.caste as RigCaste].scale, sel ? C.setRGB(1.4, 1.25, 0.8) : C.setRGB(tone, tone * 0.97, tone * 0.94), g, d.caste === 'queen' ? 0.6 : 0, seed);
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
  statics = out;
}

function tick(now: number) {
  const dtWall = Math.min(1, (now - lastNow) / 1000), dtReal = Math.min(0.1, dtWall); frameIv.push(now - lastNow); lastNow = now; if (frameIv.length > 600) frameIv.shift();
  const c0 = performance.now(), dtAnim = running ? dtReal : 0;
  if (frame && vis) {
    const run = !!pacing?.running; tNow = displayTime(frame.t_sim, run, pacing?.speed ?? speed, performance.now() - frameAt, lastT); lastT = run ? tNow : null;
    uTime.value += dtAnim; // micro-motion clock: frozen while the world is paused
    drawn = stage.update(frame, vis, tNow, dtAnim);
    const L = antLen(), sc = L / MODEL_LEN, pxPerCm = ui.canvas.clientHeight / 2 / Math.tan((camera.fov * Math.PI) / 360);
    let nh = 0, nl = 0, nb = 0;
    for (const a of drawn) {
      let g = gaits.get(a.id); if (!g) { g = newGait(); gaits.set(a.id, g); }
      stepGait(g, a, dtAnim, L);
      const depth = a.realm === 'nest' ? Math.min(1, Math.max(0, (ground(0, 0) - a.y) / 2)) * NEST_FOOT_DROP : 0, p = { x: a.x - a.ux * depth, y: a.y - a.uy * depth, z: a.z - a.uz * depth };
      const want = basis(a.fx, a.fy, a.fz, a.ux, a.uy, a.uz, Qb); let qt = quats.get(a.id);
      if (!qt || g.cut) { qt = want.clone(); quats.set(a.id, qt); } else if (dtAnim > 0) qt.slerp(want, 1 - Math.exp(-dtAnim * 11));
      const dist = camera.position.distanceTo(V.set(p.x, p.y, p.z)), px = (L / Math.max(0.01, dist)) * pxPerCm, sel = a.id === selected, hi = px > (quality === 'low' ? 34 : 18) || sel;
      const h = hash32(a.id), tone = 0.9 + ((h % 1000) / 1000) * 0.22;
      if (sel) C.setRGB(1.4, 1.25, 0.78); else C.setRGB(tone, tone * (0.97 + ((h >>> 10) % 100) / 2000), tone * 0.95);
      place(hi ? layers.minorHi : layers.minorLo, hi ? nh++ : nl++, p, qt, sc, C, g, Math.max(0, Math.min(1, a.crop)), (h % 9973) / 9973);
      if (a.realm === 'surface') { M4.compose(V.set(a.x, a.y + 0.05, a.z), Qa.identity(), S.set(L * 0.95, 1, L * 0.6)); blobs.setMatrixAt(nb++, M4); }
    }
    layers.minorHi.commit(nh); layers.minorLo.commit(nl); blobs.count = nb; blobs.instanceMatrix.needsUpdate = true;
    drawStatics(dtAnim);
    // the planned display route of the selected worker inside the nest (display)
    const plan = selected ? stage.plannedRoute(selected, tNow) : [];
    planLine.visible = plan.length > 1; if (planLine.visible) { planLine.geometry.dispose(); planLine.geometry = new THREE.BufferGeometry().setFromPoints(plan.map((p) => new THREE.Vector3(p.x, p.y + 0.25, p.z + 0.1))); planLine.computeLineDistances(); }
  }
  stepCamera(dtWall); // camera moves follow the wall clock (a slow frame must not stretch a view change)
  if (renderOn) renderer.render(scene, camera);
  cpuMs.push(performance.now() - c0); if (cpuMs.length > 600) cpuMs.shift();
  updateLabels(); updateHud(now);
  // automatic quality: step down when the frame rate stays low (never while a level is forced by ?quality=)
  if (!qualityLocked && frameIv.length > 90 && quality !== 'low') {
    const fps = 1000 / (frameIv.slice(-90).reduce((a, b) => a + b, 0) / 90);
    if (fps < 24) { if (!lowFpsSince) lowFpsSince = now; else if (now - lowFpsSince > 3000) { applyQuality(quality === 'high' ? 'medium' : 'low'); lowFpsSince = 0; frameIv.length = 0; toast(`畫面更新偏慢：已自動降低畫質為「${QUALITY_LABEL[quality]}」（只影響繪圖，不影響模擬）`); } } else lowFpsSince = 0;
  }
  requestAnimationFrame(tick);
}
const QUALITY_LABEL: Record<Quality, string> = { high: '高', medium: '中', low: '低' };

// ---------- labels (HTML overlay, projected) ----------
const labelEls = new Map<string, HTMLElement>();
function updateLabels() {
  if (!frame || !rost || !world) return;
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight, items: { key: string; p: P3; text: string; cls: string; face: boolean }[] = [];
  const ns = (c: 'queen' | 'major' | 'egg' | 'pupa') => rost!.missing.includes(c), n = (c: 'queen' | 'major' | 'egg' | 'pupa') => rost!.counts[c];
  const part = (c: 'queen' | 'egg' | 'pupa') => ns(c) ? (mode === 'demo' ? `${CASTE_LABEL[c]} ${n(c).demo}（示範資料）` : `${CASTE_LABEL[c]}：尚未模擬`) : `${CASTE_LABEL[c]} ${n(c).engine}（引擎）`;
  for (const c of graph.layout.chambers) {
    const here = drawn.filter((a) => a.place === c.id).length; let text = `${c.label_zh}${here ? ` ${here}` : ''}`, cls = '';
    if (c.role === 'brood') text += `｜幼蟲 ${rost.counts.larva.engine}（引擎）`;
    if (c.role === 'queen') { text += `｜${part('queen')}・${part('egg')}`; cls = ns('queen') ? (mode === 'demo' ? 'demo' : 'ns') : ''; }
    if (c.role === 'pupa') { text += `｜${part('pupa')}`; cls = ns('pupa') ? (mode === 'demo' ? 'demo' : 'ns') : ''; }
    items.push({ key: `ch-${c.id}`, p: { x: (c.x0 + c.x1) / 2, y: c.floor + c.height + 0.9, z: graph.faceZ }, text, cls, face: true });
  }
  items.push({ key: 'face', p: { x: -24, y: -7, z: graph.faceZ }, text: `巢體幾何＝展示假設${ns('major') ? (mode === 'demo' ? `｜大工蟻 ${n('major').demo}（示範資料）` : '｜大工蟻：尚未模擬') : ''}`, cls: ns('major') && mode !== 'demo' ? 'ns' : mode === 'demo' ? 'demo' : '', face: true });
  items.push({ key: 'entrance', p: { x: 0, y: ground(0, 0) + 3.2, z: 0 }, text: '巢口', cls: '', face: false });
  items.push({ key: 'host', p: world.anchors.hostPlant, text: `蜜露來源（引擎）存量 ${frame.source.stock_portions.toFixed(1)} 份｜寄主植物外形＝裝飾`, cls: '', face: false });
  if (mode === 'demo') { items.push({ key: 'nectar', p: world.anchors.nectar, text: DEMO_FOOD_PROPS[0].label_zh, cls: 'demo', face: false }); items.push({ key: 'insect', p: world.anchors.insect, text: DEMO_FOOD_PROPS[1].label_zh, cls: 'demo', face: false }); }
  for (const a of drawn) if (a.pose === 'troph' && a.partner && a.id < a.partner) items.push({ key: `tr-${a.id}`, p: { x: a.x, y: a.y + antLen() * 0.9, z: a.z }, text: '交哺（引擎事件）', cls: 'act', face: true });
  for (const a of drawn) if (a.pose === 'brood' && a.partner && stage.fedNow(a.partner, tNow)) items.push({ key: `br-${a.id}`, p: { x: a.x, y: a.y + antLen() * 0.9, z: a.z }, text: '餵幼蟲（引擎事件）', cls: 'act', face: true });
  const selA = drawn.find((a) => a.id === selected), selS = statics.find((s) => s.ind.id === selected);
  if (selA) items.push({ key: 'pin', p: { x: selA.x, y: selA.y + antLen() * (selA.realm === 'nest' ? 1.0 : 0.9), z: selA.z }, text: `▼ ${selA.id}`, cls: 'pin', face: false });
  else if (selS) items.push({ key: 'pin', p: { x: selS.p.x, y: selS.p.y + antLen() * 0.9, z: selS.p.z }, text: `▼ ${selS.ind.id}`, cls: 'pin', face: false });
  const off = camera.position.clone().sub(controls.target), dist = off.length(), frontal = off.z / dist, seen = new Set<string>();
  for (const it of items) {
    let el = labelEls.get(it.key); if (!el) { el = document.createElement('div'); ui.labels.appendChild(el); labelEls.set(it.key, el); }
    seen.add(it.key);
    const s = V.set(it.p.x, it.p.y, it.p.z).project(camera), on = s.z < 1 && Math.abs(s.x) < 1.05 && Math.abs(s.y) < 1.05 && (!it.face || (frontal > 0.45 && dist < 330)) && (it.cls === 'pin' || dist < 420);
    el.className = `lbl ${it.cls}`; if (el.textContent !== it.text) el.textContent = it.text;
    el.hidden = !on; if (!on) continue;
    el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px) translate(-50%, -100%)`;
  }
  for (const [k, el] of labelEls) if (!seen.has(k)) el.hidden = true;
}

// ---------- HUD and panels ----------
let hudAt = 0, tab = 'stats';
function updateHud(now: number) {
  if (now - hudAt < 300) return; hudAt = now;
  if (!frame) return;
  setLight(frame);
  const out = drawn.filter((a) => a.realm === 'surface').length, temp = frame.env.temperature_c === null ? '—' : frame.env.temperature_c.toFixed(1);
  ui.hud.textContent = `${fmtWorldTime(tNow)}（${frame.env.date}）｜光照 ${P0_LIGHT_LABEL[frame.env.light]}・氣溫 ${temp}°C（合成）｜${running ? `執行中 ${speed}×` : '已暫停'}｜種子 ${frame.seed}｜工蟻 巢外 ${out}・巢內 ${drawn.length - out}｜${P0A2_STATUS_LABEL}`;
  if (selected) renderCard();
  if (!document.body.classList.contains('side-closed')) { if (tab === 'stats') renderStats(); else if (tab === 'perf') renderPerf(); else if (tab === 'saves') renderSaveStatus(); }
}
function renderStats() {
  if (!frame || !rost) return;
  const by = new Map<string, number>(); for (const w of frame.workers) by.set(w.state, (by.get(w.state) ?? 0) + 1);
  const places = new Map<string, number>(); for (const a of drawn) { const k = a.realm === 'surface' ? a.place : a.place === 'tunnel' ? '通道' : graph.chamber(a.place).label_zh; places.set(k, (places.get(k) ?? 0) + 1); }
  const row = (c: typeof CASTES[number]) => { const k = rost!.counts[c], miss = rost!.missing.includes(c); return `<tr><td>${CASTE_LABEL[c]}</td><td class="n">${miss ? '<span class="tag none">尚未模擬</span>' : k.engine}</td><td class="n">${mode === 'demo' ? k.demo : '—'}</td></tr>`; };
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
<h2>沒有畫的東西</h2><ul><li>費洛蒙：尚未模擬，畫面不畫任何氣味路徑；黃色虛線只是「顯示路線」（長度＝引擎路線長度，方向示意）。</li><li>固體食物搬運、其他食物種類（花蜜、昆蟲屍體）：引擎尚未模擬；只在展示情境當不可取食的道具。</li><li>身體碰撞與巢口容量：尚未模擬；畫面上的錯位只是顯示。</li></ul>
<h2>已列出的畫面跳位</h2><ul>${STAGE_DISCONTINUITIES.map((d) => `<li>${esc(d.label_zh)}</li>`).join('')}</ul>
<h2>巢體幾何的來源</h2><div class="muted">${esc(prov.what_is_assumed_zh)}<br>${esc(prov.scale_note_zh)}<br>${esc(prov.literature_direction_zh)}</div>
<h2>階級外形</h2><div class="muted">${Object.values(MORPHS).map((m) => esc(m.note_zh)).join('；')}。幼蟲、蛹、卵的外形為一般形態示意。</div>`;
}
function renderNotSim() {
  const d = disclosure;
  ui.notsim.innerHTML = !d ? '<div class="muted">讀取中…</div>' : !d.ok ? `<div>${esc(d.reason)}</div>` : `<div class="muted">${esc(d.note_zh)}（來源：${esc(d.source)}；清單取自此世界的存檔中繼資料）</div><h2>尚未模擬（未接入）${d.unwired.length} 項</h2><ul>${d.unwired.map((x) => `<li>${esc(x.label_zh)}</li>`).join('')}</ul><h2>簡化代理 ${d.proxies.length} 項</h2><ul>${d.proxies.map((x) => `<li>${esc(x.label_zh)}</li>`).join('')}</ul>`;
}
function renderPerf() {
  const s = summarise(frameIv.slice(-240), cpuMs.slice(-240)), info = renderer.info.render, mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  ui.perf.innerHTML = `<h2>繪圖後端</h2><div>${esc(backend)}</div><div class="muted">GPU：${esc(glInfo)}</div>
<h2>畫面</h2><table><tr><td>FPS（平均／p5 低）</td><td class="n">${s.fps_mean.toFixed(0)}／${s.fps_p5_low.toFixed(0)}</td></tr><tr><td>幀時間 p50／p95</td><td class="n">${s.frame_ms.p50.toFixed(1)}／${s.frame_ms.p95.toFixed(1)} ms</td></tr><tr><td>本頁 CPU p50</td><td class="n">${s.cpu_ms.p50.toFixed(1)} ms</td></tr><tr><td>draw calls</td><td class="n">${info.calls}</td></tr><tr><td>三角形</td><td class="n">${(info.triangles / 1000).toFixed(0)}k</td></tr><tr><td>畫質／DPR</td><td class="n">${QUALITY_LABEL[quality]}${qualityLocked ? '（固定）' : '（自動）'}／${renderer.getPixelRatio().toFixed(2)}</td></tr><tr><td>JS heap</td><td class="n">${mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : '—'}</td></tr></table>
<div class="row">畫質 <span class="seg">${(['high', 'medium', 'low'] as const).map((k) => `<button type="button" data-q="${k}" aria-pressed="${quality === k}">${QUALITY_LABEL[k]}</button>`).join('')}</span></div>
<div class="muted">量測類別：${measurementClass(glInfo, automated)}。軟體繪圖或自動化環境的數字不是實機結果。模擬時間與畫面更新分開：畫面變慢不會改變任何事件。</div>`;
  ui.perf.querySelectorAll<HTMLButtonElement>('button[data-q]').forEach((b) => { b.onclick = () => { applyQuality(b.dataset.q as Quality); renderPerf(); }; });
}
function renderCard() {
  if (!frame || !selected) { ui.card.hidden = true; return; }
  const a = drawn.find((x) => x.id === selected), w = frame.workers.find((x) => x.id === selected), st = statics.find((x) => x.ind.id === selected);
  let html = '';
  if (a && w) {
    const place = a.realm === 'surface' ? a.place : a.place === 'tunnel' ? '通道' : graph.chamber(a.place).label_zh;
    html = `<b>${esc(a.id)}</b>　<span class="tag engine">引擎個體</span>小工蟻
<br>活動：${esc(STATE_LABEL[w.state] ?? w.state)}（引擎狀態）
<br>開始：${clockOf(w.since_s)}${w.until_s !== null ? `　預定結束：${clockOf(w.until_s)}（引擎固定時長）` : ''}
<br>嗉囊：${(w.crop_fill * 100).toFixed(0)}%（引擎；腹部脹大＝嗉囊量）　路線記憶：${w.route ? '有（引擎）' : '無'}
<br>位置：${esc(place)}${a.realm === 'nest' ? '（展示假設）' : ''}${a.pose === 'troph' ? `　正在與 ${esc(a.partner)} 交哺（引擎事件；畫面演出）` : a.pose === 'brood' && a.partner ? `　正在照顧 ${esc(a.partner)}（引擎事件；畫面演出）` : ''}
<br><span class="muted">畫面位置類別：${esc(CLASS_LABEL[a.cls])}｜步態、轉身、觸角與姿勢只是畫面</span>`;
  } else if (st) {
    const d = st.ind, ch = st.chamber ? graph.chamber(st.chamber).label_zh : '';
    html = d.source === 'engine'
      ? `<b>${esc(d.id)}</b>　<span class="tag engine">引擎個體</span>${CASTE_LABEL[d.caste]}<br>腸道量：${((d.fill ?? 0) * 100).toFixed(0)}%（引擎）${stage.fedNow(d.id, tNow) ? '　正在被餵食（引擎事件；畫面演出）' : ''}<br>位置：${esc(ch)}（展示假設）<br><span class="muted">幼蟲只被餵食與代謝；發育、化蛹、羽化尚未模擬</span>`
      : `<b>${esc(d.id)}</b>　<span class="tag demo">示範資料</span>${CASTE_LABEL[d.caste]}<br>動作：${esc(d.state ?? '')}<br>位置：${esc(ch)}（展示假設）<br><span class="muted">${DEMO_BADGE}：引擎尚未模擬這個階級；此個體不存檔、不影響任何引擎個體</span>`;
  } else { ui.card.hidden = true; return; }
  const canFollow = !!(a && w);
  const full = `${html}<div class="row">${canFollow ? `<button id="cardFollow" type="button">${following === selected ? '停止跟隨' : '跟隨這隻'}</button>` : ''}<button id="cardClose" type="button" aria-label="關閉">關閉</button></div>`;
  ui.card.hidden = false;
  if (full === cardHtmlNow) return; // unchanged: keep the buttons in place (a tap must not land on a replaced node)
  cardHtmlNow = full; ui.card.innerHTML = full;
  if (canFollow) $('cardFollow').onclick = () => setFollow(following === selected ? null : selected);
  $('cardClose').onclick = () => select(null);
}
let cardHtmlNow = '';
function select(id: string | null) { cardHtmlNow = ''; selected = id; if (!id) { ui.card.hidden = true; if (following) setFollow(null); } else renderCard(); }

// picking: nearest drawn individual on screen
function pick(sx: number, sy: number): string | null {
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight, frontal = camera.position.z > graph.faceZ; let best: string | null = null, bd = narrow() ? 36 : 26;
  const test = (id: string, x: number, y: number, z: number, nest: boolean) => { if (nest && !frontal) return; const p = V.set(x, y, z).project(camera); if (p.z > 1) return; const d = Math.hypot(((p.x + 1) / 2) * w - sx, ((1 - p.y) / 2) * h - sy); if (d < bd) { bd = d; best = id; } };
  for (const a of drawn) test(a.id, a.x, a.y + antLen() * 0.15, a.z, a.realm === 'nest');
  for (const s of statics) test(s.ind.id, s.p.x, s.p.y, s.p.z, true);
  return best;
}
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }

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
function onWorldStart() { frame = null; pacing = null; lastT = null; drawn = []; statics = []; gaits.clear(); quats.clear(); stage?.reset(antLen()); eventsSeen = 0; disclosure = null; selected = null; following = null; ui.card.hidden = true; }
async function afterWorldReady(startAt: number | null) {
  if (startAt !== null && (frame?.t_sim ?? 0) < startAt) await client.stepUntil(startAt);
  await new Promise<void>((r) => { const w = () => (frame ? r() : setTimeout(w, 20)); w(); });
  vis = VisModel.of(frame!); rost = roster(mode, frame!, demoSeed);
  if (!world) { world = buildScene({ graph, corridor: corridor3(vis), source: source3(vis), searchRadius: SEARCH_RADIUS_CM }); scene.add(world.group); applyQuality(quality); }
  setLight(frame!); setMode(mode);
  const snap = await client.snapshot();
  disclosure = snap.type === 'snapshot' ? notSimulatedOf(snap.snapshot) : { ok: false, reason: '無法讀取此世界的存檔中繼資料：「尚未模擬」清單未知，不得把畫面當成已模擬任何機制' };
  renderNotSim(); renderLegend(); renderWorldInfo();
  await client.setSpeed(speed);
  if (q.get('autostart') !== '0') { await client.start().catch(() => {}); running = true; } else running = false;
  syncPlay();
}
function renderWorldInfo() {
  const cur = session?.current;
  ui.worldInfo.innerHTML = frame ? `世界 ${esc(frame.world_id)}｜種子 ${frame.seed}｜規則指紋 ${esc(frame.rules_fingerprint.slice(0, 12))}…<br>${tempMode ? '臨時世界（網址帶 seed：不存檔）' : cur ? `「${esc(cur.name)}」｜${cur.writer ? '本分頁可存檔' : esc(cur.readOnlyReason ?? '唯讀')}｜${esc(cur.verification)}` : '未連結存檔'}` : '';
  ui.saveBtn.disabled = tempMode || !cur?.writer;
}
function renderSaveStatus() {
  if (tempMode) { ui.saveStatus.textContent = '臨時世界不存檔'; return; }
  const s = saveUi; ui.saveStatus.textContent = !s ? '尚未儲存' : s.status === 'saving' ? '正在儲存…' : s.status === 'failed' ? `儲存失敗（${s.last_error ?? ''}）— 上一個成功的存檔仍保留` : s.last_success_ms ? `已儲存 ${new Date(s.last_success_ms).toLocaleTimeString('zh-TW', { hour12: false })}` : s.text;
}
async function newWorld(seedText: string) {
  if (!session) return;
  ui.restartBtn.disabled = true; toast('建立新世界…');
  const r = await session.newGame(`Demo 2・${new Date().toLocaleString('zh-TW', { hour12: false })}`, seedText, 'p0a2');
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
  const p0 = rows.filter((w) => w.engine_version.startsWith('experiment-p0a2-24h/'));
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
  if (!webgl2Available()) { fatal('這個瀏覽器或裝置無法使用 WebGL 2，Demo 2 的 3D 畫面無法顯示。'); return; }
  try { renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: quality !== 'low', powerPreference: 'high-performance' }); } catch (e) { fatal(`無法建立 WebGL 繪圖環境（${esc((e as Error).message)}）。`); return; }
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.98; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); glInfo = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); }
  backend = `WebGL 2（three r${THREE.REVISION} WebGLRenderer）｜WebGPU：此瀏覽器${'gpu' in navigator ? '有提供' : '未提供'}，本頁目前不使用（見 docs/demo2.md）`;
  ui.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); toast('繪圖環境遺失（WebGL context lost）：請重新整理頁面；模擬與存檔不受影響', 10000); });
  controls = new OrbitControls(camera, ui.canvas);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.screenSpacePanning = true; controls.minDistance = 4; controls.maxDistance = 420;
  controls.minPolarAngle = 0.12; controls.maxPolarAngle = Math.PI * 0.53; controls.minAzimuthAngle = -1.15; controls.maxAzimuthAngle = 1.15; controls.zoomToCursor = true;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }; controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE };
  controls.addEventListener('start', () => { userBusy = true; tween = null; }); controls.addEventListener('end', () => { userBusy = false; });
  sun.shadow.mapSize.set(2048, 2048); Object.assign(sun.shadow.camera, { left: -150, right: 150, top: 110, bottom: -110, near: 10, far: 900 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
  scene.add(sunTarget); sun.target = sunTarget; lamp.position.set(10, 10, 200); lamp.target.position.set(10, -16, 0); scene.add(sun, hemi, lamp, lamp.target);
  resize(); addEventListener('resize', resize);

  const raw = await (await fetch('vendor/demo2/nest-layout.json')).json();
  graph = new NestGraph(parseLayout(raw), ground(0, 0)); stage = new ColonyStage(graph, antLen());
  buildMeshes();

  client.onState = (fr, p, fol) => { if (!isP0a2Frame(fr) || fr.world_id === 'exp-runtime-probe') return; if (p.running && frame && fr.t_sim !== frame.t_sim) session?.markDirty(); frame = fr; pacing = p; frameAt = performance.now(); followedView = fol; if (rost && mode === 'natural' && rost.counts.minor.engine !== fr.workers.length) rost = roster(mode, fr, demoSeed); else if (rost) rost = roster(mode, fr, demoSeed); };
  client.onEvents = (evs: EventMsg[]) => { if (evs[0]?.world_id === 'exp-runtime-probe') return; eventsSeen += evs.length; stage.onEvents(evs); session?.markDirty(); };
  client.onProtocolError = (why) => toast(`Worker：${why}`, 8000);

  ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join(''); ui.seedIn.value = String(DEFAULT_SEED);
  goView('full', true); requestAnimationFrame((t) => { lastNow = t; requestAnimationFrame(tick); });

  if (tempMode) { // ?seed=N: a temporary, unsaved world (tests and quick looks)
    const seed = Number(q.get('seed')), r = await client.init(`exp-demo2-${seed}`, seed, 'p0a2');
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
        try { const id = await st.value.lastPlayed(), row = id ? rows.find((w) => w.world_id === id) : null; if (row && row.compat === 'compatible' && row.engine_version.startsWith('experiment-p0a2-24h/')) resumed = await openWorld(row.world_id); } catch { resumed = false; }
      }
      if (!resumed) await newWorld(String(DEFAULT_SEED));
      if (!frame) { tempMode = true; session = null; onWorldStart(); await client.init(`exp-demo2-${DEFAULT_SEED}`, DEFAULT_SEED, 'p0a2'); await afterWorldReady(START_T); toast('無法使用存檔（可能另一個分頁正在使用）：改用不存檔的臨時世界', 7000); }
    } else { tempMode = true; toast(`無法使用本機存檔（${st.code}）：改用不存檔的臨時世界`, 7000); await client.init(`exp-demo2-${DEFAULT_SEED}`, DEFAULT_SEED, 'p0a2'); await afterWorldReady(START_T); }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void session?.request('hidden'); });
    addEventListener('pagehide', () => { void session?.request('pagehide'); });
  }
  void refreshSaveList();
  if (q.get('follow')) setFollow(q.get('follow'));
  if (q.get('view')) goView(q.get('view') as View, true);
  if (q.get('panel')) openSide(q.get('panel')!);
  hooks.ready = true;
}

// ---------- controls ----------
function openSide(t: string | null) {
  const closed = t === null; document.body.classList.toggle('side-closed', closed); ui.sideBtn.setAttribute('aria-expanded', String(!closed));
  if (t) { tab = t; document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === t))); for (const k of ['stats', 'legend', 'notsim', 'saves', 'perf']) $(`pane-${k}`).hidden = k !== t; if (t === 'stats') renderStats(); if (t === 'perf') renderPerf(); if (t === 'saves') { renderSaveStatus(); void refreshSaveList(); } }
}
ui.sideBtn.onclick = () => openSide(document.body.classList.contains('side-closed') ? tab : null);
document.querySelectorAll<HTMLButtonElement>('#tabs button').forEach((b) => { b.onclick = () => openSide(b.dataset.tab!); });
ui.play.onclick = () => void setRunning(!running);
ui.speed.onchange = () => void setSpeed(Number(ui.speed.value));
ui.viewFull.onclick = () => goView('full'); ui.viewSurface.onclick = () => goView('surface'); ui.viewUnder.onclick = () => goView('under');
ui.modeBtn.onclick = () => setMode(mode === 'demo' ? 'natural' : 'demo');
ui.followBtn.onclick = () => { if (following) setFollow(null); else { const id = selected && drawn.some((a) => a.id === selected) ? selected : interestingAnt(); if (id) setFollow(id); } };
ui.saveBtn.onclick = async () => { const r = await session?.request('manual'); renderSaveStatus(); toast(r && r.ok ? '已儲存（引擎快照；示範資料與鏡頭不存）' : '儲存未完成'); void refreshSaveList(); };
ui.restartBtn.onclick = () => { if (tempMode || !session) { location.search = `?seed=${encodeURIComponent(ui.seedIn.value || String(DEFAULT_SEED))}`; return; } void newWorld(ui.seedIn.value || String(DEFAULT_SEED)); };
ui.resetDemoBtn.onclick = () => { demoSeed = DEFAULT_SEED; for (const k of [...gaits.keys()]) if (k.startsWith('demo-')) gaits.delete(k); setMode('demo'); toast('展示情境已重設（示範資料回到固定種子的初始排列；引擎世界不受影響）'); };
ui.importBtn.onclick = () => ui.importFile.click();
ui.importFile.onchange = async () => { const f = ui.importFile.files?.[0]; ui.importFile.value = ''; if (!f || !session) return; const text = await f.text(), r = await session.store.importWorld(text, await session.runtimeForImport(text)); toast(r.ok ? '已匯入：可在清單中載入' : `匯入失敗（${r.code}）：${r.message}`, 6000); void refreshSaveList(); };
let down: { x: number; y: number; t: number } | null = null;
ui.canvas.addEventListener('pointerdown', (e) => { down = { x: e.offsetX, y: e.offsetY, t: performance.now() }; });
ui.canvas.addEventListener('pointerup', (e) => { if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 7 && performance.now() - down.t < 500) select(pick(e.offsetX, e.offsetY)); down = null; });

// test / automation hooks: read-only views of the page; only scheduling / observation commands reach the Worker
const hooks: Record<string, unknown> = {
  ready: false, three: THREE.REVISION,
  backend: () => backend, gl: () => glInfo,
  state: () => ({ running, speed, mode, view, quality, selected, following, mag, t: tNow, frame_t: frame?.t_sim ?? null, seed: frame?.seed ?? null, world_id: frame?.world_id ?? null, temp: tempMode, ants: drawn.length, hi: layers.minorHi?.mesh.count ?? 0, lo: layers.minorLo?.mesh.count ?? 0, queens: layers.queen?.mesh.count ?? 0, majors: layers.major?.mesh.count ?? 0, eggs: eggMesh?.count ?? 0, pupae: pupaMesh?.count ?? 0, larvae: larvaMesh?.count ?? 0, uTime: uTime.value, cam: camera.position.toArray(), target: controls?.target.toArray(), events: eventsSeen, stats: { ...stage.stats }, save: saveUi, calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, followed: followedView !== null }),
  ants: () => drawn.map((a) => ({ ...a, phase: gaits.get(a.id)?.phase ?? null, walk: gaits.get(a.id)?.walk ?? null })),
  roster: () => rost, statics: () => statics.map((s) => ({ id: s.ind.id, caste: s.ind.caste, source: s.ind.source, ...s.p })),
  frame: () => frame, sdf: (x: number, y: number) => graph.sdf(x, y), faceZ: () => graph.faceZ,
  screenOf: (id: string) => { const a = drawn.find((x) => x.id === id) ?? statics.map((s) => ({ id: s.ind.id, ...s.p })).find((x) => x.id === id); if (!a) return null; const p = new THREE.Vector3(a.x, a.y, a.z).project(camera); return { x: ((p.x + 1) / 2) * ui.canvas.clientWidth, y: ((1 - p.y) / 2) * ui.canvas.clientHeight, z: p.z }; },
  select: (id: string | null) => select(id), follow: (id: string | null) => setFollow(id), setRunning: (on: boolean) => setRunning(on), setSpeed: (s: number) => setSpeed(s),
  setView: (v: View, instant = true) => goView(v, instant), setMode: (m: Mode) => setMode(m), setQuality: (k: Quality) => applyQuality(k), openSide: (t: string | null) => openSide(t),
  setRender: (on: boolean) => { renderOn = on; },
  /** scheduling only: run the world to t (paused pages then show exactly the frame's instant) */
  stepUntil: async (t: number) => { await client.stepUntil(t); },
  /** the drawn workers for the latest frame at ITS instant (a paused page shows exactly this; no wait for a repaint) */
  sampleNow: () => { if (!frame || !vis) return null; tNow = frame.t_sim; drawn = stage.update(frame, vis, tNow, 0); return { t: tNow, ants: drawn.map((a) => ({ id: a.id, state: a.state, realm: a.realm, x: a.x, y: a.y, z: a.z, place: a.place, pose: a.pose, absorbed: a.absorbed })) }; },
  save: async () => { const r = await session?.request('manual'); return r ? (r.ok ? { ok: true } : { ok: false, code: r.code, message: r.message }) : { ok: false, code: 'no_session', message: '' }; },
  view: (pos: number[], tgt: number[]) => { tween = null; camera.position.fromArray(pos); controls.target.fromArray(tgt); controls.update(); },
  perf: () => ({ ...summarise(frameIv.slice(-240), cpuMs.slice(-240)), calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, quality, dpr: renderer.getPixelRatio(), gl: glInfo, measurement_class: measurementClass(glInfo, automated), scene_triangles: world?.triangles() ?? 0 }),
};
(window as unknown as { __demo2: Record<string, unknown> }).__demo2 = hooks;
main().catch((e) => { console.error(e); fatal(`載入失敗：${esc((e as Error).message)}`); });
