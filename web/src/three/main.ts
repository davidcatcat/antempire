/**
 * Three.js 3D prototype page (web/three.html) — Owner 2026-11-14, Issues #256 / #257.
 *
 * An INDEPENDENT viewer next to the Canvas 2D pages (index.html, experiment.html), which stay unchanged. The simulation
 * runs ONLY in the non-official experiment Web Worker; this page talks to it through web/src/experimental/worker-client.ts
 * and sends nothing but scheduling (init / step_until / start / pause / resume / set_speed) and observation (follow)
 * commands. It imports no engine, Worker or cli module; it writes nothing; drawing can never change an event.
 *
 * What is drawn (labelled on the page):
 *  - ENGINE: each worker's state, the instant it started, route length and travel timing, crop / gut fill, light state;
 *  - DISPLAY INTERPOLATION: positions between two recorded instants (route travel; moves to / from the entrance);
 *  - SCHEMATIC (示意): the route direction, the search spot, the nest chambers and slots, the whole garden scenery,
 *    the ants' magnification, the lighting direction, and the in-place micro-motion of resting ants.
 * Benchmark (100 / 1,000 ants): more INDEPENDENT P0-A2 worlds (other seeds, each in its own Worker) are added; their
 * nest positions and route directions are layout. Nothing is copied or invented.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ExperimentWorkerClient } from '../experimental/worker-client.ts';
import { isP0a2Frame, type P0a2FrameMsg, type PacingMsg } from '../experimental/worker-protocol.ts';
import { STATE_LABEL, P0_LIGHT_LABEL } from '../v62-p0a2-model.ts';
import { VisModel, SEARCH_RADIUS_CM } from '../vis1-model.ts';
import { CORRIDOR_BEARING_RAD } from '../vis1-path.ts';
import { cardHtml, hudStatus } from '../v62-p0a2-view.ts';
import { displayTime, fmtWorldTime } from '../v62-model.ts';
import { hash32 } from '../game-model.ts';
import { AntLayer, MINOR_LEN_CM, MODEL_LEN, antMaterial } from './ant-model.ts';
import { buildGarden, type Garden } from './garden.ts';
import { antsOf, ACTIVITY_LEVEL, MAIN_PLACE, corridorOf, moundOf, place3, segmentsOf, type Ant3, type WorldPlace } from './placement.ts';
import { newMotion, stepMotion, type Motion } from './motion.ts';
import { CHAMBERS, larvaSlot } from './nest3d.ts';
import { DIORAMA, FACE_Z, prng } from './terrain.ts';
import { BENCH_SIZES, measurementClass, summarise, worldsFor, type PerfSummary } from './perf.ts';

const q = new URLSearchParams(location.search);
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  canvas: $<HTMLCanvasElement>('scene'), badge: $('badge'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'),
  mag: $<HTMLInputElement>('mag'), magLabel: $('magLabel'), who: $<HTMLSelectElement>('who'), count: $<HTMLSelectElement>('count'),
  route: $<HTMLInputElement>('route'), perfBtn: $<HTMLButtonElement>('perfBtn'), perf: $('perf'), status: $('status'), time: $('time'),
  moreBtn: $<HTMLButtonElement>('moreBtn'), homeBtn: $<HTMLButtonElement>('homeBtn'), card: $('card'), aboutBtn: $<HTMLButtonElement>('aboutBtn'), about: $('about'), labels: $('labels'), toast: $('toast'), benchBtn: $<HTMLButtonElement>('benchBtn'),
};
const narrow = () => innerWidth < 640;
const START_T = Number(q.get('t') ?? 9 * 3600); // world time to open at (scheduling only: step_until)
const SEED = Number(q.get('seed') ?? 1);
const SPEEDS = [1, 2, 5, 10, 60];
const automated = navigator.webdriver === true || /HeadlessChrome/.test(navigator.userAgent);

// ---------- renderer / scene ----------
const lowQ = q.get('quality') === 'low' || (q.get('quality') !== 'high' && narrow() && (navigator.hardwareConcurrency ?? 8) <= 4);
const renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: !lowQ, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, lowQ ? 1.5 : 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.localClippingEnabled = true;
const glInfo = (() => { const gl = renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info'); return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER)); })();

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.3, 4000);
const controls = new OrbitControls(camera, ui.canvas);
controls.enableDamping = true; controls.dampingFactor = 0.09; controls.screenSpacePanning = false;
controls.minDistance = 1.2; controls.maxDistance = 900; controls.maxPolarAngle = Math.PI * 0.62;
controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

const sun = new THREE.DirectionalLight(0xffffff, 2.4);
sun.castShadow = true; sun.shadow.mapSize.set(lowQ ? 1024 : 2048, lowQ ? 1024 : 2048);
Object.assign(sun.shadow.camera, { left: -200, right: 200, top: 160, bottom: -160, near: 10, far: 900 }); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
const sunTarget = new THREE.Object3D(); sunTarget.position.set((DIORAMA.x0 + DIORAMA.x1) / 2, 0, (DIORAMA.z0 + DIORAMA.z1) / 2); scene.add(sunTarget); sun.target = sunTarget;
const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x6b4a2e, 0.9);
const lamp = new THREE.DirectionalLight(0xffe2b8, 1.6); lamp.position.set(10, 12, 200); lamp.target.position.set(10, -14, FACE_Z); // observer's lamp on the cut face (示意)
scene.add(sun, hemi, lamp, lamp.target);

let garden: Garden | null = null, routeObj: THREE.Object3D | null = null;
const extraEntrances = new THREE.Group(); scene.add(extraEntrances);

// ants
const uTime = { value: 0 };
const antMat = antMaterial(uTime);
const CAP = 1100;
const hiLayer = new AntLayer('hi', CAP, antMat), loLayer = new AntLayer('lo', CAP, antMat);
scene.add(hiLayer.mesh, loLayer.mesh);
const shadowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d')!; const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
const blobs = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }), CAP);
blobs.frustumCulled = false; blobs.count = 0; blobs.renderOrder = 1; scene.add(blobs);
const larvaMesh = new THREE.InstancedMesh(new THREE.TorusGeometry(0.32, 0.17, 10, 16, Math.PI * 1.25), new THREE.MeshStandardMaterial({ roughness: 0.45 }), 64);
larvaMesh.count = 0; larvaMesh.frustumCulled = false; scene.add(larvaMesh);
const ring = new THREE.Mesh(new THREE.RingGeometry(0.66, 0.7, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, depthWrite: false }));
ring.visible = false; ring.renderOrder = 2; scene.add(ring);

// ---------- worlds ----------
interface Feed { client: ExperimentWorkerClient; place: WorldPlace; seed: number; frame: P0a2FrameMsg | null; vis: VisModel | null; pacing: PacingMsg | null; frameAt: number; last: number | null; t: number; followed: unknown }
const feeds: Feed[] = [];
let speed = Number(q.get('speed') ?? 1), running = false;

function benchPlace(i: number): WorldPlace {
  const r = prng(9000 + i), dx = -50 + r() * 120, dz = -70 + r() * 56, bearing = (-10 + r() * 80) * Math.PI / 180;
  return { index: i, dx, dz, rot: bearing - CORRIDOR_BEARING_RAD, cutaway: false };
}
async function startFeed(i: number): Promise<Feed> {
  const seed = SEED + i, client = new ExperimentWorkerClient();
  const f: Feed = { client, place: i === 0 ? MAIN_PLACE : benchPlace(i), seed, frame: null, vis: null, pacing: null, frameAt: 0, last: null, t: 0, followed: null };
  client.onState = (fr, p, fol) => { if (!isP0a2Frame(fr)) return; f.frame = fr; if (!f.vis || !f.vis.matches(fr)) f.vis = VisModel.of(fr); f.pacing = p; f.frameAt = performance.now(); f.followed = fol; };
  client.onProtocolError = (why) => toast(`Worker：${why}`);
  const r = await client.init(`exp-three-${seed}`, seed, 'p0a2');
  if (r.type === 'error') throw new Error(`${r.code}: ${r.message}`);
  await client.stepUntil(START_T);
  await client.setSpeed(speed);
  if (running || i === 0) await client.start();
  if (!running && i !== 0) { /* stays unstarted until resume */ }
  return f;
}
async function setWorldCount(n: number): Promise<void> {
  // the extra worlds are independent: their Workers start (init + step_until) in parallel, then join in index order
  const add = await Promise.all(Array.from({ length: Math.max(0, n - feeds.length) }, (_, k) => startFeed(feeds.length + k)));
  for (const f of add) {
    feeds.push(f);
    if (f.place.index > 0) addExtraEntrance(f.place);
    if (!running && f.pacing?.running) await f.client.pause();
  }
  while (feeds.length > n) { const f = feeds.pop()!; f.client.terminate(); }
  if (n === 1) extraEntrances.clear();
}
function addExtraEntrance(p: WorldPlace) {
  const hole = new THREE.Mesh(new THREE.CircleGeometry(0.62, 18).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x140c07 }));
  hole.position.set(p.dx, 0.6, p.dz); extraEntrances.add(hole);
}

// ---------- display state ----------
let antCount = 30, mag = Number(q.get('mag') ?? (narrow() ? 18 : 14));
const motions = new Map<string, Motion>();
let selected: string | null = null, following: string | null = null, lastAnts: Ant3[] = [];
const bodyLen = () => MINOR_LEN_CM * mag;
const mounds = () => [moundOf(MAIN_PLACE)];

function toast(s: string) { ui.toast.textContent = s; ui.toast.hidden = false; clearTimeout((toast as unknown as { h: number }).h); (toast as unknown as { h: number }).h = window.setTimeout(() => { ui.toast.hidden = true; }, 3500); }

function setLight(f: P0a2FrameMsg) {
  const e = f.env, day = e.light === 'day', tw = e.light === 'civil_twilight';
  const alt = day ? Math.max(6, e.sun_altitude_deg) : tw ? 4 : 30, az = e.before_solar_noon ? 1 : -1; // azimuth: morning east, afternoon west (schematic)
  const a = alt * Math.PI / 180, dist = 500;
  sun.position.set(sunTarget.position.x + az * Math.cos(a) * dist * 0.8, Math.sin(a) * dist, sunTarget.position.z + Math.cos(a) * dist * 0.45);
  if (day) { sun.color.setHSL(0.11, 0.45, 0.5 + Math.min(0.42, alt / 120)); sun.intensity = 0.9 + Math.min(1.0, alt / 45); hemi.intensity = 0.85; hemi.color.set(0xcfe3ff); scene.background = new THREE.Color(0x9cb8cc); }
  else if (tw) { sun.color.set(0xffa66b); sun.intensity = 0.9; hemi.intensity = 0.6; hemi.color.set(0xd9a98a); scene.background = new THREE.Color(0x5b5470); }
  else { sun.color.set(0x9db4ff); sun.intensity = 0.55; hemi.intensity = 0.55; hemi.color.set(0x7f95c8); scene.background = new THREE.Color(0x1d2433); } // night: brightened for viewing (示意)
  scene.fog = new THREE.Fog(scene.background as THREE.Color, 600, 1600);
}

// ---------- per-frame ----------
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), QP = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3(), C = new THREE.Color(), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const frameIv: number[] = [], cpuMs: number[] = [];
let lastNow = performance.now(), followTarget: THREE.Vector3 | null = null;

function collectAnts(): Ant3[] {
  const out: Ant3[] = [];
  for (const f of feeds) {
    if (!f.frame) continue;
    const run = !!f.pacing?.running; f.t = displayTime(f.frame.t_sim, run, f.pacing?.speed ?? speed, performance.now() - f.frameAt, f.last); f.last = run ? f.t : null;
    for (const a of antsOf(f.frame, f.t, f.place, bodyLen(), mounds(), f.vis!)) { if (out.length >= antCount) break; out.push(a); }
    if (out.length >= antCount) break;
  }
  return out;
}

function tick(now: number) {
  const dtReal = Math.min(0.1, (now - lastNow) / 1000); frameIv.push(now - lastNow); lastNow = now; if (frameIv.length > 3000) frameIv.shift();
  const c0 = performance.now();
  if (running) uTime.value += dtReal; // micro-motion clock: frozen while the world is paused
  const ants = collectAnts(); lastAnts = ants;
  const L = bodyLen(), sc = L / MODEL_LEN, pxPerCm = (ui.canvas.clientHeight / 2) / Math.tan((camera.fov * Math.PI) / 360);
  let nh = 0, nl = 0, nb = 0;
  for (const a of ants) {
    let m = motions.get(a.key); if (!m) { m = newMotion(); motions.set(a.key, m); }
    stepMotion(m, { x: a.x, y: a.y, z: a.z, yaw: a.yaw, moving: a.moving, act: ACTIVITY_LEVEL[a.state] ?? 0.4 }, running ? dtReal : 0, L);
    V.set(a.x, a.y, a.z);
    Q.setFromAxisAngle(Y, -m.yaw); QP.setFromAxisAngle(Z, a.pitch); Q.multiply(QP);
    S.setScalar(sc); M4.compose(V, Q, S);
    const dist = camera.position.distanceTo(V), px = (L / Math.max(0.01, dist)) * pxPerCm, isSel = a.key === selected;
    const layer = px > 16 || isSel ? hiLayer : loLayer, i = layer === hiLayer ? nh++ : nl++;
    layer.mesh.setMatrixAt(i, M4);
    const h = hash32(a.key), tone = 0.9 + ((h % 1000) / 1000) * 0.22;
    if (isSel) C.setRGB(1.35, 1.2, 0.75); else C.setRGB(tone, tone * (0.97 + ((h >>> 10) % 100) / 2000), tone * 0.95);
    layer.mesh.setColorAt(i, C);
    layer.anim.setXYZW(i, m.phase, m.walk, (h % 9973) / 9973, m.act);
    if (!a.buried && (a.where !== 'shaft')) { M4.compose(V.set(a.x, a.y + 0.04, a.z), Q.identity(), S.set(L * 0.95, 1, L * 0.6)); blobs.setMatrixAt(nb++, M4); }
    if (isSel) { ring.visible = true; ring.position.set(a.x, a.y + 0.05, a.z); ring.scale.setScalar(L * 0.78); }
  }
  if (!ants.some((a) => a.key === selected)) ring.visible = false;
  for (const [layer, n] of [[hiLayer, nh], [loLayer, nl]] as const) { layer.mesh.count = n; layer.mesh.instanceMatrix.needsUpdate = true; layer.mesh.instanceColor!.needsUpdate = true; layer.anim.needsUpdate = true; }
  blobs.count = nb; blobs.instanceMatrix.needsUpdate = true;

  // larvae (engine: count and gut fill; placement schematic)
  const main = feeds[0]?.frame;
  if (main) {
    larvaMesh.count = main.larvae.length;
    main.larvae.forEach((lv, i) => {
      const s = larvaSlot(i, main.larvae.length), k = Math.max(0, Math.min(1, lv.gut_fill));
      M4.compose(V.set(s.x, s.y + 0.25 * L * 0.55, s.z), Q.setFromAxisAngle(Y, (hash32(lv.id) % 628) / 100), S.setScalar(L * 0.6)); larvaMesh.setMatrixAt(i, M4);
      larvaMesh.setColorAt(i, C.setRGB(0.78 + 0.2 * k, 0.74 + 0.2 * k, 0.62 + 0.18 * k));
    });
    larvaMesh.instanceMatrix.needsUpdate = true; if (larvaMesh.instanceColor) larvaMesh.instanceColor.needsUpdate = true;
  }

  // follow: keep the orbit target on the followed ant (camera moves by the same offset)
  if (following) {
    const a = ants.find((x) => x.key === following);
    if (a) {
      const want = new THREE.Vector3(a.x, a.y + L * 0.2, a.z);
      if (!followTarget) followTarget = controls.target.clone();
      const jump = followTarget.distanceTo(want) > 30, k = jump ? 1 - Math.exp(-dtReal * 3) : 1 - Math.exp(-dtReal * 10);
      const next = followTarget.clone().lerp(want, k), delta = next.clone().sub(controls.target);
      controls.target.add(delta); camera.position.add(delta); followTarget = next;
    }
  }
  controls.update();
  renderer.render(scene, camera);
  cpuMs.push(performance.now() - c0); if (cpuMs.length > 3000) cpuMs.shift();
  updateLabels(); updateHud();
  requestAnimationFrame(tick);
}

// chamber labels (HTML, projected)
const labelEls = new Map<string, HTMLElement>();
function updateLabels() {
  const f = feeds[0]?.frame; if (!f) return;
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight;
  const items: [string, THREE.Vector3, string][] = CHAMBERS.map((c) => [c.key, new THREE.Vector3(c.x, c.y + c.ry + 1.2, FACE_Z + 0.3), `${c.label} ${f.workers.filter((x) => c.states.includes(x.state)).length}`]);
  items.push(['face', new THREE.Vector3(-34, 4, FACE_Z + 0.3), '巢內剖面（示意：巢室＝引擎狀態分組）']);
  for (const [key, p, text] of items) {
    let el = labelEls.get(key); if (!el) { el = document.createElement('div'); el.className = 'lbl'; ui.labels.appendChild(el); labelEls.set(key, el); }
    const s = p.clone().project(camera), vis = s.z < 1 && Math.abs(s.x) < 1.1 && Math.abs(s.y) < 1.1 && camera.position.z > FACE_Z - 2;
    const dist = camera.position.distanceTo(p);
    el.hidden = !vis || dist > 420; if (el.hidden) continue;
    el.textContent = text; el.style.transform = `translate(${((s.x + 1) / 2) * w}px, ${((1 - s.y) / 2) * h}px) translate(-50%, -100%)`;
  }
}

let hudAt = 0;
function updateHud() {
  const now = performance.now(); if (now - hudAt < 250) return; hudAt = now;
  const f = feeds[0]?.frame; if (!f) return;
  const t = feeds[0].t, poses = feeds[0].vis!.poses(f, t);
  ui.status.textContent = hudStatus(f, poses);
  ui.time.textContent = `${fmtWorldTime(t)}（${f.env.date}）｜光照 ${P0_LIGHT_LABEL[f.env.light]}（引擎）｜${running ? `執行中 ${speed}×` : '已暫停'}｜畫出 ${lastAnts.length} 隻（${feeds.length} 個世界）`;
  setLight(f);
  if (!ui.perf.hidden) {
    const iv = frameIv.slice(-120), s = summarise(iv, cpuMs.slice(-120)), info = renderer.info.render, mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    ui.perf.textContent = `FPS ${s.fps_mean.toFixed(0)}（p5 低 ${s.fps_p5_low.toFixed(0)}）｜幀 p50 ${s.frame_ms.p50.toFixed(1)} / p95 ${s.frame_ms.p95.toFixed(1)} ms｜CPU ${s.cpu_ms.p50.toFixed(1)} ms｜draw ${info.calls}｜三角形 ${(info.triangles / 1000).toFixed(0)}k｜JS heap ${mem ? (mem.usedJSHeapSize / 1048576).toFixed(0) + ' MB' : '—'}｜近 ${hiLayer.mesh.count} / 遠 ${loLayer.mesh.count}\nGPU：${glInfo}｜DPR ${renderer.getPixelRatio().toFixed(2)}｜${measurementClass(glInfo, automated)}`;
  }
  if (selected) renderCard();
}

function renderCard() {
  const f = feeds[0]?.frame; if (!f || !selected) { ui.card.hidden = true; return; }
  const a = lastAnts.find((x) => x.key === selected);
  if (!a) { ui.card.hidden = true; return; }
  if (a.world !== 0) {
    ui.card.innerHTML = `<b>${a.id}</b>　<span class="muted">效能量測用的第 ${a.world + 1} 個獨立 P0-A2 世界（種子 ${SEED + a.world}）</span><br>活動：${STATE_LABEL[a.state] ?? a.state}（引擎狀態）<div class="row"><button id="followBtn" type="button">${following === a.key ? '取消追蹤' : '鏡頭追蹤'}</button><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
  } else {
    const pose = feeds[0].vis!.pose(f.workers.find((w) => w.id === a.id)!, feeds[0].t);
    ui.card.innerHTML = cardHtml(f, a.id, pose, following === a.key, following === a.key ? feeds[0].followed : null)
      + `<div class="muted">3D：${a.where === 'nest' ? '巢室與位置為示意（依引擎狀態分組）' : a.where === 'shaft' ? '巢口通道上的位置為顯示插值（依引擎的移動時間；通道形狀示意）' : a.schematic ? '畫面位置示意' : a.interpolated ? '兩個引擎紀錄點之間的顯示插值；方向示意' : '引擎紀錄點'}｜步態、轉身、原地微動作只是畫面</div>`;
  }
  ui.card.hidden = false;
  $('followBtn').onclick = () => void setFollow(following === a.key ? null : a.key);
  $('closeCard').onclick = () => { select(null); };
}

function select(key: string | null) {
  selected = key; if (!key) { ui.card.hidden = true; ring.visible = false; if (following) void setFollow(null); }
  else renderCard();
  syncWho();
}
async function setFollow(key: string | null) {
  following = key; followTarget = null;
  if (key) {
    selected = key; const a = lastAnts.find((x) => x.key === key);
    if (a) { // swing in close, keeping the current viewing direction
      const dir = camera.position.clone().sub(controls.target).normalize(), d = Math.max(bodyLen() * 9, 6);
      controls.target.set(a.x, a.y, a.z); camera.position.copy(controls.target).addScaledVector(dir, d);
    }
  }
  const main = feeds[0]; if (main) { const a = key ? lastAnts.find((x) => x.key === key) : null; await main.client.follow(a && a.world === 0 ? a.id : null).catch(() => {}); }
  renderCard(); syncWho();
}
function syncWho() {
  const f = feeds[0]?.frame; if (!f) return;
  if (ui.who.options.length !== f.workers.length + 1) {
    ui.who.innerHTML = '<option value="">追蹤螞蟻…</option>' + f.workers.map((w) => `<option value="0:${w.id}">${w.id}</option>`).join('');
  }
  ui.who.value = following ?? '';
}

// picking: nearest drawn ant on screen
function pick(sx: number, sy: number): string | null {
  const w = ui.canvas.clientWidth, h = ui.canvas.clientHeight; let best: string | null = null, bd = narrow() ? 34 : 26;
  for (const a of lastAnts) {
    if (a.buried) continue;
    const p = new THREE.Vector3(a.x, a.y + bodyLen() * 0.15, a.z).project(camera); if (p.z > 1) continue;
    const d = Math.hypot(((p.x + 1) / 2) * w - sx, ((1 - p.y) / 2) * h - sy); if (d < bd) { bd = d; best = a.key; }
  }
  return best;
}
let down: { x: number; y: number; t: number } | null = null;
ui.canvas.addEventListener('pointerdown', (e) => { down = { x: e.offsetX, y: e.offsetY, t: performance.now() }; });
ui.canvas.addEventListener('pointerup', (e) => {
  if (down && Math.hypot(e.offsetX - down.x, e.offsetY - down.y) < 6 && performance.now() - down.t < 500) { const k = pick(e.offsetX, e.offsetY); select(k); }
  down = null;
});

function resize() {
  const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

function homeCamera() {
  // closer than a whole-diorama view so the surface ants read at the default magnification (the far end of the
  // route is still in frame); the whole garden is one zoom-out away
  if (narrow()) { controls.target.set(16, -6, -10); camera.position.set(-2, 52, 98); } else { controls.target.set(20, -12, -8); camera.position.set(-14, 32, 80); }
  controls.update();
}

function setMag(v: number) {
  mag = v; ui.mag.value = String(v);
  ui.magLabel.textContent = `螞蟻放大 ×${v}（2.5 mm 畫成 ${(MINOR_LEN_CM * v * 10).toFixed(0)} mm；位置與路線長度不放大）`;
}

// ---------- benchmark ----------
export interface BenchRow { ants: number; worlds: number; drawn: number; summary: PerfSummary; draw_calls: number; triangles: number; js_heap_mb: number | null; hi: number; lo: number }
async function measure(seconds: number): Promise<{ s: PerfSummary; calls: number; tris: number; heap: number | null }> {
  const iv0 = frameIv.length, cp0 = cpuMs.length; frameIv.length = 0; cpuMs.length = 0; void iv0; void cp0;
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const info = renderer.info.render, mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  return { s: summarise(frameIv.slice(), cpuMs.slice()), calls: info.calls, tris: info.triangles, heap: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null };
}
async function runBench(sizes: readonly number[], warm: number, secs: number) {
  const rows: BenchRow[] = [], view = camera.position.clone(), tgt = controls.target.clone();
  ui.benchBtn.disabled = true;
  for (const n of sizes) {
    toast(`量測 ${n} 隻…`); await setCount(n);
    await new Promise((r) => setTimeout(r, warm * 1000));
    const m = await measure(secs);
    rows.push({ ants: n, worlds: feeds.length, drawn: lastAnts.length, summary: m.s, draw_calls: m.calls, triangles: m.tris, js_heap_mb: m.heap, hi: hiLayer.mesh.count, lo: loLayer.mesh.count });
  }
  camera.position.copy(view); controls.target.copy(tgt);
  const result = {
    schema: 'antempire.three-bench.v1', when_utc: new Date().toISOString(), page: 'web/three.html', three: THREE.REVISION,
    measurement_class: measurementClass(glInfo, automated), gpu_renderer: glInfo, user_agent: navigator.userAgent, dpr: renderer.getPixelRatio(),
    viewport: { w: innerWidth, h: innerHeight }, quality: lowQ ? 'low' : 'high', hardware_concurrency: navigator.hardwareConcurrency ?? null,
    device_memory_gb: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null, magnification: mag, warm_s: warm, measure_s: secs, rows,
    note: '100／1,000 隻＝多個獨立種子的 P0-A2 實驗世界（各在自己的 Worker），只畫前 N 隻；巢位置與路線方向為排版。軟體繪圖或自動化下的數字不是實機結果。',
  };
  (window as unknown as { __three: Record<string, unknown> }).__three.bench = result;
  ui.perf.hidden = false; ui.perf.textContent = JSON.stringify(result, null, 1);
  ui.benchBtn.disabled = false; toast('量測完成：結果在效能面板（可複製 JSON）');
  return result;
}
async function setCount(n: number) { antCount = n; ui.count.value = String(n); await setWorldCount(worldsFor(n)); }

// ---------- controls ----------
async function setRunning(on: boolean) {
  running = on;
  for (const f of feeds) {
    const p = f.pacing; if (!p) continue;
    if (on) { if (!p.started) await f.client.start(); else if (!p.running) await f.client.resume(); } else if (p.running) await f.client.pause();
  }
  ui.play.textContent = running ? '暫停' : '繼續';
}
ui.play.onclick = () => void setRunning(!running);
ui.speed.innerHTML = SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join('');
ui.speed.onchange = () => { speed = Number(ui.speed.value); for (const f of feeds) void f.client.setSpeed(speed); };
ui.mag.oninput = () => setMag(Number(ui.mag.value));
ui.who.onchange = () => void setFollow(ui.who.value || null);
ui.count.innerHTML = BENCH_SIZES.map((n) => `<option value="${n}">${n} 隻</option>`).join('');
ui.count.onchange = () => void setCount(Number(ui.count.value));
ui.route.onchange = () => { if (routeObj) routeObj.visible = ui.route.checked; };
ui.perfBtn.onclick = () => { ui.perf.hidden = !ui.perf.hidden; };
ui.aboutBtn.onclick = () => { ui.about.hidden = !ui.about.hidden; };
ui.benchBtn.onclick = () => void runBench(BENCH_SIZES, 4, 10);
ui.homeBtn.onclick = () => { if (following) void setFollow(null); homeCamera(); };
ui.moreBtn.onclick = () => { const on = document.body.classList.toggle('opts-open'); ui.moreBtn.setAttribute('aria-expanded', String(on)); };
ui.time.onclick = () => document.body.classList.toggle('status-open');

// ---------- start ----------
async function main() {
  resize(); setMag(mag);
  ui.badge.textContent = '載入中…';
  const f0 = await startFeed(0); feeds.push(f0); running = true;
  await new Promise<void>((r) => { const w = () => (f0.frame ? r() : setTimeout(w, 30)); w(); });
  // the corridor comes only from the frame (world seed + engine route length) through the shared VIS-1 display model
  const fr = f0.frame!, course = corridorOf(f0.vis!, MAIN_PLACE), src = place3(f0.vis!.corridor.source, MAIN_PLACE);
  garden = buildGarden({ mounds: mounds(), keepOut: { routes: segmentsOf(course), nests: [{ x: 0, z: 0 }], routeHalfWidth: 6, nestRadius: SEARCH_RADIUS_CM + 3 }, quality: lowQ ? 'low' : 'high', source: src });
  scene.add(garden.group);
  routeObj = garden.routeLine(course); routeObj.visible = ui.route.checked; scene.add(routeObj);
  antMat.clippingPlanes = null;
  setLight(fr); homeCamera();
  ui.speed.value = String(speed); ui.play.textContent = '暫停';
  ui.badge.textContent = `Three.js 3D 原型｜${fr.status_zh}｜種子 ${SEED}｜路線長度＝引擎參數 ${fr.layout.source_distance_cm} cm（方向示意）`;
  syncWho();
  requestAnimationFrame((t) => { lastNow = t; requestAnimationFrame(tick); });
  const n = Number(q.get('ants') ?? 30); if (n !== 30) await setCount(n);
  if (q.get('follow')) { await new Promise((r) => setTimeout(r, 400)); await setFollow(`0:${q.get('follow')}`); }
  hooks.ready = true;
  if (q.get('bench') === '1') void runBench(BENCH_SIZES, Number(q.get('warm') ?? 4), Number(q.get('secs') ?? 10));
}

// test / automation hooks (read-only views of the page; nothing reaches the simulation but the listed commands)
const hooks: Record<string, unknown> = {
  ready: false,
  three: THREE.REVISION,
  gl: () => glInfo,
  state: () => ({ worlds: feeds.length, ants: lastAnts.length, running, speed, mag, selected, following, hi: hiLayer.mesh.count, lo: loLayer.mesh.count, t: feeds[0]?.t ?? null, frame_t: feeds[0]?.frame?.t_sim ?? null, cam: camera.position.toArray(), target: controls.target.toArray() }),
  ants: () => lastAnts.map((a) => { const m = motions.get(a.key); return { ...a, drawn_yaw: m?.yaw ?? null, phase: m?.phase ?? null, walk: m?.walk ?? null }; }),
  frame: () => feeds[0]?.frame ?? null,
  screenOf: (key: string) => { const a = lastAnts.find((x) => x.key === key); if (!a) return null; const p = new THREE.Vector3(a.x, a.y, a.z).project(camera); return { x: ((p.x + 1) / 2) * ui.canvas.clientWidth, y: ((1 - p.y) / 2) * ui.canvas.clientHeight, z: p.z }; },
  select: (key: string | null) => select(key), follow: (key: string | null) => setFollow(key), setCount: (n: number) => setCount(n), setRunning: (on: boolean) => setRunning(on), setMag: (v: number) => setMag(v),
  setSpeed: (s: number) => { speed = s; ui.speed.value = String(s); return Promise.all(feeds.map((f) => f.client.setSpeed(s))); },
  view: (pos: number[], tgt: number[]) => { camera.position.fromArray(pos); controls.target.fromArray(tgt); controls.update(); },
  home: () => homeCamera(),
  bench: null as unknown,
  runBench: (sizes: number[], warm: number, secs: number) => runBench(sizes, warm, secs),
  uTime: () => uTime.value,
};
(window as unknown as { __three: Record<string, unknown> }).__three = hooks;
main().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; console.error(e); });
