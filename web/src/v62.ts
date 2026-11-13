/**
 * 《螞蟻帝國》V6-2 experiment mode (web/experiment.html): a continuously running NON-OFFICIAL experiment world.
 * The simulation runs ONLY in the experiment Web Worker (started by experimental/worker-client.ts); this page sends
 * scheduling / observation commands and draws what the Worker reports with the V6 layered renderer:
 *  - engine records: the Worker's frames (segment start / end points, activity, environment) and events (log);
 *  - display interpolation: an ant's point strictly between the two records of its straight segment (v62-model.poseAt),
 *    the display clock's small lead between frames, camera, zoom, leg motion and turning ease — drawing only;
 *  - 示意: ground texture (and optional litter), the fixed schematic light. The synthetic world has no obstacles.
 * World kinds: the P0-A2 24 h individual-behaviour world (default; candidate / experiment world, non-official, Owner
 * #201) and the synthetic test world (?world=synthetic, or a saved synthetic world). For P0-A2 (v62-p0a2-model.ts):
 *  - engine state: each worker's activity, location class, state start, crop fill, route; route travel end times; the
 *    light state the workers sense (scene light; sun altitude by the general method, bucketed; shadow direction 示意);
 *  - display interpolation: a travelling worker between the recorded ends of its route trip;
 *  - 示意: route direction (only its length is an engine parameter), a searching worker's point, the nest inset.
 * 「尚未模擬」 (Owner #212 Q2 a; matrix row M43): the top-bar button and panel show the list the Worker writes into the
 * world's save metadata (payload.save_meta.not_simulated, read from a snapshot, a pure read at an event boundary). The
 * page has no list of its own; a world whose save metadata has none says so.
 * Nothing here runs the simulation, fetches web/data, reads saves/ or journal/, or writes anything.
 */
import { ExperimentWorkerClient } from './experimental/worker-client.ts';
import { ExperimentSaveStore } from './experimental/save-store.ts';
import { ExperimentSession } from './experimental/session.ts';
import { notSimulatedOf, type NotSimulatedView, type SaveUiState } from './experimental/save-format.ts';
import { Menu } from './v62-menu.ts';
import { isP0a2Frame, type AnyFrameMsg, type EventMsg, type PacingMsg, type WorldKind } from './experimental/worker-protocol.ts';
import { LayeredRenderer } from './render-canvas.ts';
import { antLengthPx, worldToScreen, type Camera } from './render-scene.ts';
import { SCHEMATIC_LIGHT } from './art-core.ts';
import { hash32 } from './game-model.ts';
import { ACTIVITY_LABEL, DEFAULT_SPEED, EventDigest, FPS_CAPS, LIGHT_LABEL, MODE_LABEL, NEST_PLACE, V62_SPEEDS, antInputs, displayTime, fmtWorldTime, posesAt, scenePositions, type Pose } from './v62-model.ts';
import { P0A2_STATUS_LABEL, layoutOf, p0AntInputs, p0EventText, p0Light, p0Places, p0Poses, type P0Pose } from './v62-p0a2-model.ts';
import { cardHtml, drawInset, hudStatus, insetRect, type InsetHit } from './v62-p0a2-view.ts';
import { GardenRenderer, MINOR_LEN_CM } from './vis1-render.ts';
import { VisModel, SEARCH_RADIUS_CM, PATH_LABEL, UNDERGROUND_LABEL } from './vis1-model.ts';
import { UndergroundView, U_W, U_H, type UCam } from './vis1-underground.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const ui = { viewBtn: $<HTMLButtonElement>('viewBtn'), legendBtn: $<HTMLButtonElement>('legendBtn'), legend: $('legend'), ugLabel: $('ugLabel'), closeBtn: $<HTMLButtonElement>('closeBtn'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), fpsCap: $<HTMLSelectElement>('fpsCap'), follow: $<HTMLSelectElement>('follow'), time: $('time'), status: $('status'), card: $('card'), badge: $('badge'), info: $<HTMLButtonElement>('infoBtn'), about: $('about'), logBtn: $<HTMLButtonElement>('logBtn'), log: $('log'), home: $<HTMLButtonElement>('homeBtn'), zoomIn: $<HTMLButtonElement>('zoomIn'), zoomOut: $<HTMLButtonElement>('zoomOut'), decor: $<HTMLInputElement>('decor'), saveBtn: $<HTMLButtonElement>('saveBtn'), menuBtn: $<HTMLButtonElement>('menuBtn'), saveStatus: $('saveStatus'), notice: $('notice'), ro: $('roBanner'), nsBtn: $<HTMLButtonElement>('nsBtn'), notSim: $('notSim') };

const R = new LayeredRenderer(canvas);
/** VIS-1: the P0-A2 world is drawn by the garden renderer (drawing only; same canvas) */
const G = new GardenRenderer(canvas), UG = new UndergroundView();
let vis: VisModel | null = null, view: 'surface' | 'underground' = 'surface', zoomGoal: number | null = null, uTau = 0;
const ucam = { x: U_W / 2, y: U_H / 2 - 4, s: 10 };
const client = new ExperimentWorkerClient();
let frame: AnyFrameMsg | null = null, pacing: PacingMsg | null = null, frameAt = 0, followedView: unknown = null, lastDisplay: number | null = null;
let poses: Pose[] = [], p0poses: P0Pose[] = [], insetHits: InsetHit[] = [], sceneLight = '', selected: string | null = null, following: string | null = null, arenaR = 60;
let digest = new EventDigest(); const recent: EventMsg[] = [], protocolErrors: string[] = [];
/** the throw-away world the session uses to read the Worker's runtime info is never drawn or counted */
const PROBE = 'exp-runtime-probe';
let session: ExperimentSession | null = null, menu: Menu | null = null, tempMode = false, active = false;
let saveUi: SaveUiState | null = null;
/** the 「尚未模擬」 list of the world in the Worker (from its snapshot's save metadata; null before a world is entered) */
let disclosure: NotSimulatedView | null = null;
const cam = { x: 0, y: 0, s: 8 };
const stats = { frames: 0, intervals: [] as number[], drawMs: [] as number[], lastTs: 0, lastDraw: 0 };
let fpsCap = 60, topBarPx = 0, bottomBarPx = 0;

const minAntPx = () => Math.max(28, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.05));
const camera = (): Camera => ({ cx: cam.x, cy: cam.y, s: cam.s, w: canvas.clientWidth, h: canvas.clientHeight });
const S2W = (sx: number, sy: number) => [cam.x + (sx - canvas.clientWidth / 2) / cam.s, cam.y - (sy - canvas.clientHeight / 2) / cam.s] as const;

client.onEvents = (evs) => { if (evs[0]?.world_id === PROBE) return; session?.markDirty(); for (const e of evs) { digest.add(e); recent.push(e); } if (recent.length > 60) recent.splice(0, recent.length - 60); if (!ui.log.hidden) renderLog(); };
client.onState = (f, p, fol) => {
  if (f.world_id === PROBE) return; if (p.running && frame && f.t_sim !== frame.t_sim) session?.markDirty();
  frame = f; pacing = p; followedView = fol; frameAt = performance.now();
  arenaR = isP0a2Frame(f) ? f.layout.source_distance_cm * 0.62 : f.arena_radius_cm;
  // P0-A2: the scene light follows the world's light state (bucketed; re-baked only when the bucket changes)
  if (active && isP0a2Frame(f) && p0Light(f).label !== sceneLight) setScene();
  syncControls();
};
client.onProtocolError = (w) => { protocolErrors.push(w); ui.status.textContent = `協定錯誤：${w}`; };

function setScene() {
  if (isP0a2Frame(frame)) {
    const light = p0Light(frame); sceneLight = light.label;
    if (!vis || !vis.matches(frame)) { vis = VisModel.of(frame); G.resetMotion(); }
    G.setWorld(vis, light, nightOf(frame), ui.decor.checked);
    return;
  }
  sceneLight = '';
  R.setScene({ decor: ui.decor.checked, seed: hash32(frame?.world_id ?? 'exp'), places: [NEST_PLACE], pos: scenePositions(), routes: [], sources: {}, weather: null, light: SCHEMATIC_LIGHT });
  // no synchronous warm here: a toggle re-bakes chunks through the renderer's per-frame bake budget (the page stays responsive)
}
/** engine light state → night grade strength (drawing only) */
const nightOf = (f: { env: { light: string } }) => (f.env.light === 'night' ? 1 : f.env.light === 'civil_twilight' ? 0.45 : 0);
function homeCamera() {
  zoomGoal = null;
  if (isP0a2Frame(frame)) {
    if (view === 'underground') { const w = canvas.clientWidth, h = canvas.clientHeight, top = topBarPx + 40, bottom = h - bottomBarPx - 8; ucam.s = Math.min((w - 16) / (U_W + 6), Math.max(60, bottom - top) / (U_H + 14)); ucam.x = U_W / 2; ucam.y = U_H / 2 - 5 - ((top + bottom) / 2 - h / 2) / ucam.s; return; }
    // fit nest + display corridor + source between the top bar and the nest inset (display only)
    const C = (vis ?? VisModel.of(frame)).corridor, w = canvas.clientWidth, h = canvas.clientHeight, ins = insetRect(w, h, bottomBarPx), top = topBarPx + 8, bottom = ins.y - 8;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const p of C.line.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    const mx = w < 640 ? 24 : 14; x0 -= mx; x1 += mx; y0 -= 14; y1 += 14;
    cam.s = Math.min((w * 0.94) / (x1 - x0), Math.max(40, bottom - top) / (y1 - y0));
    cam.x = (x0 + x1) / 2; cam.y = (y0 + y1) / 2 - (h / 2 - (top + bottom) / 2) / cam.s;
    return;
  }
  cam.x = 0; cam.y = 0; cam.s = Math.min(canvas.clientWidth, canvas.clientHeight - bottomBarPx - topBarPx) / (arenaR * 2.2);
}
function resize() { R.resize(); if (isP0a2Frame(frame)) G.resize(); topBarPx = $('top').getBoundingClientRect().height; bottomBarPx = $('bottom').getBoundingClientRect().height; }

// ------------------------------------------------------------------ controls (scheduling / observation only)
function syncControls() {
  const running = !!pacing?.running;
  const label = !pacing?.started ? '開始' : running ? '暫停' : '繼續';
  if (ui.play.textContent !== label) ui.play.textContent = label;
  ui.play.setAttribute('aria-pressed', String(running));
  if (pacing && document.activeElement !== ui.speed && ui.speed.value !== String(pacing.speed) && [...ui.speed.options].some((o) => o.value === String(pacing!.speed))) ui.speed.value = String(pacing.speed);
  if (frame && ui.follow.options.length === 1) for (const a of isP0a2Frame(frame) ? frame.workers : frame.ants) ui.follow.add(new Option(a.id, a.id));
}
async function playPause() {
  if (!pacing) return;
  if (!pacing.started) await client.start(); else if (pacing.running) { await client.pause(); void session?.request('pause'); } else await client.resume();
  lastDisplay = null; syncControls();
}
const pct = (a: readonly number[], q: number) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return +b[Math.min(b.length - 1, Math.floor(b.length * q))].toFixed(2); };
const med = (a: readonly number[]) => pct(a, 0.5);
/** close-up: zoom so that an ant is drawn ≈ 80 px long at TRUE scale (display only) */
const CLOSE_UP_S = 80 / MINOR_LEN_CM;
function closeUp(id: string | null) {
  if (!isP0a2Frame(frame)) return;
  if (view === 'underground') { ucam.s = Math.min(120, ucam.s * 2.2); return; }
  const p = id ? p0poses.find((x) => x.id === id && x.vis !== 'in_nest') : undefined;
  if (p) { cam.x = p.x + (p.slot?.dx ?? 0); cam.y = p.y + (p.slot?.dy ?? 0); }
  zoomGoal = CLOSE_UP_S;
}
async function setFollow(id: string | null) {
  if (id && id !== following && isP0a2Frame(frame) && cam.s < CLOSE_UP_S * 0.5 && view === 'surface' && p0poses.some((x) => x.id === id && x.vis !== 'in_nest')) zoomGoal = CLOSE_UP_S * 0.75;
  following = id; selected = id ?? selected; ui.follow.value = id ?? '';
  await client.follow(id); // observation only: the Worker attaches a read-only copy of the ant to each frame
  renderCard();
}

// ------------------------------------------------------------------ drawing
function drawFrame(dt: number, fms: number | null) {
  if (!frame) return;
  const now = performance.now(), t = displayTime(frame.t_sim, !!pacing?.running, pacing?.speed ?? DEFAULT_SPEED, now - frameAt, lastDisplay);
  lastDisplay = pacing?.running ? t : null;
  if (isP0a2Frame(frame)) { drawP0(dt, fms, t); return; }
  poses = posesAt(frame, t);
  if (following) { const p = poses.find((x) => x.id === following); if (p && p.vis !== 'in_nest') { cam.x += (p.x - cam.x) * Math.min(1, dt * 6); cam.y += (p.y - cam.y) * Math.min(1, dt * 6); } }
  const c = camera(), L = antLengthPx(cam.s, minAntPx());
  const draws = R.frame(c, antInputs(poses), dt, fms, { uiBottom: bottomBarPx + 6, displayTurns: true, colourVariants: true, minAntPx: minAntPx() });
  const g = R.g;
  // arena boundary of the synthetic world (engine parameter arena_radius_cm) and the nest marker
  const [ox, oy] = worldToScreen(c, 0, 0);
  g.save(); g.setLineDash([6, 6]); g.strokeStyle = 'rgba(255,236,190,0.55)'; g.lineWidth = 1.5; g.beginPath(); g.arc(ox, oy, arenaR * cam.s, 0, Math.PI * 2); g.stroke(); g.restore();
  const sel = selected ? draws.find((d) => d.id === selected) : undefined;
  if (sel) { g.strokeStyle = following === selected ? '#9fe0ff' : '#ffe08a'; g.lineWidth = 2; g.beginPath(); g.arc(sel.sx, sel.sy, L * 0.62, 0, Math.PI * 2); g.stroke(); }
  g.font = '11px system-ui'; g.fillStyle = '#fff6dc'; for (const d of draws) g.fillText(d.id, d.sx + L * 0.45, d.sy - L * 0.4);
  drawHud(t);
}
/** P0-A2 world (VIS-1): garden surface (garden renderer) or the underground concept view, plus the nest inset */
let p0draws: { id: string; sx: number; sy: number; ex: number; ey: number }[] = [];
function drawP0(dt: number, fms: number | null, t: number) {
  const f = frame; if (!isP0a2Frame(f)) return;
  if (!vis || !vis.matches(f)) setScene();
  const V = vis!, vp = V.poses(f, t); p0poses = vp; poses = [];
  void fms;
  if (pacing?.running) uTau += dt;
  const fp = following ? vp.find((x) => x.id === following) : undefined;
  // follow: switch between the surface and the underground concept view with the followed worker's ENGINE location
  if (fp && fp.vis === 'in_nest' && view === 'surface') setView('underground');
  else if (fp && fp.vis !== 'in_nest' && view === 'underground') setView('surface');
  if (zoomGoal !== null && view === 'surface') { const k = 1 - Math.exp(-dt * 5); cam.s *= Math.pow(zoomGoal / cam.s, k); if (Math.abs(Math.log(zoomGoal / cam.s)) < 0.01) zoomGoal = null; }
  const w = canvas.clientWidth, h = canvas.clientHeight, narrow = w < 640, ins = insetRect(w, h, bottomBarPx), g = G.g;
  if (view === 'underground') {
    const uc: UCam = { ...ucam, w, h };
    if (fp && fp.vis === 'in_nest') { const hit = insetHits.find((x) => x.id === fp.id); if (hit) { const k = Math.min(1, dt * 4); ucam.x += ((hit.sx - w / 2) / ucam.s) * k; ucam.y += ((hit.sy - h / 2) / ucam.s) * k; } }
    g.setTransform(G.quality().dpr, 0, 0, G.quality().dpr, 0, 0);
    insetHits = UG.draw(g, uc, f, t, uTau, dt, selected, following, minAntPx(), nightOf(f));
    G.trace = ['ground', 'decals', 'shadows', 'propsLow', 'routes', 'antShadows', 'ants', 'propsHigh', 'lighting', 'weather', 'ui'];
    p0draws = [];
    ui.ugLabel.style.top = `${topBarPx + 6}px`;
    g.save(); g.textAlign = 'center'; g.strokeStyle = 'rgba(15,9,5,0.9)'; g.lineWidth = 4;
    const ty = topBarPx + 32 + (narrow ? 4 : 0);
    g.font = `${narrow ? 11 : 12}px system-ui`; g.fillStyle = '#f3ead6'; const sub = narrow ? '分組＝引擎狀態；巢室與位置＝示意' : '分組＝引擎狀態；巢室形狀、深度與室內位置＝示意；琥珀色＝嗉囊／幼蟲腸道量（引擎）；土層、根、石＝裝飾';
    g.strokeText(sub, w / 2, ty + 18); g.fillText(sub, w / 2, ty + 18); g.restore();
  } else {
    if (fp && fp.vis !== 'in_nest') { const tx = fp.x + (fp.slot?.dx ?? 0), ty = fp.y + (fp.slot?.dy ?? 0), k = Math.min(1, dt * 6); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    const c = camera(), sw = selected ? f.workers.find((x) => x.id === selected && (x.state === 'outbound' || x.state === 'returning')) : undefined;
    const draws = G.frame(c, vp, dt, { minAntPx: narrow ? 16 : 18, selected, following, running: !!pacing?.running, showIds: false, selectedPath: sw ? V.trip(sw).line : null });
    p0draws = draws;
    const lenPx = GardenRenderer.antLenPx(cam.s, narrow ? 16 : 18);
    g.save(); g.font = '12px system-ui'; g.fillStyle = '#fff6dc'; g.strokeStyle = 'rgba(20,12,6,0.75)'; g.lineWidth = 3; g.textBaseline = 'alphabetic';
    const label = (x: number, y: number, s: string, align: CanvasTextAlign = 'left') => { const tw = g.measureText(s).width, x0 = align === 'center' ? x - tw / 2 : x, cx = Math.max(8, Math.min(w - 8 - tw, x0)); g.textAlign = 'left'; g.strokeText(s, cx, y); g.fillText(s, cx, y); };
    const C = V.corridor, [nx, ny] = worldToScreen(c, C.nest.x, C.nest.y), [sx, sy] = worldToScreen(c, C.source.x, C.source.y), r0 = Math.max(18, 3.4 * cam.s);
    label(nx, ny + r0 + 14, narrow ? '巢口（P0-A2 實驗巢）' : '巢口（P0-A2 實驗巢；外觀示意）', 'center');
    label(sx, sy + Math.max(22, 9 * cam.s) + 14, narrow ? `蜜露源 ${f.layout.source_id}（情境）` : `蜜露源 ${f.layout.source_id}（情境；寄主植物與蚜蟲圖像＝示意）`, 'center');
    if (vp.some((p) => p.where === 'search')) { g.setLineDash([3, 6]); g.strokeStyle = 'rgba(255,236,190,0.5)'; g.lineWidth = 1.2; g.beginPath(); g.arc(nx, ny, SEARCH_RADIUS_CM * cam.s, 0, Math.PI * 2); g.stroke(); g.setLineDash([]); g.strokeStyle = 'rgba(20,12,6,0.75)'; g.lineWidth = 3; label(nx, ny - SEARCH_RADIUS_CM * cam.s - 6, '搜尋中（位置示意：搜尋沒有空間模型）', 'center'); }
    if (lenPx >= 30) { g.font = '11px system-ui'; for (const d of draws) if (d.sx > 0 && d.sy > 0 && d.sx < w && d.sy < h) label(d.sx + lenPx * 0.5, d.sy - lenPx * 0.45, d.id); }
    else if (selected) { const d = draws.find((x) => x.id === selected); if (d) { g.font = '11px system-ui'; label(d.sx + 12, d.sy - 10, d.id); } }
    // magnification (truthful) + scale bar + data-class chip, bottom left above the inset / bar
    const yb = (narrow ? ins.y : h - bottomBarPx) - 10, mag = lenPx / (MINOR_LEN_CM * cam.s);
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find((v) => v * cam.s >= 60) ?? 100, bar = nice * cam.s, bx = narrow ? 16 : 236, ly = yb - (narrow ? 44 : 28);
    g.fillStyle = 'rgba(20,14,8,0.62)'; g.beginPath(); g.roundRect(8, yb - (narrow ? 62 : 46), narrow ? w - 16 : Math.min(ins.x - 16, 560), narrow ? 58 : 42, 8); g.fill();
    g.font = '12px system-ui'; g.fillStyle = '#fff6dc'; g.textAlign = 'left';
    g.fillText(mag > 1.05 ? `螞蟻放大顯示 ×${mag.toFixed(1)}` : '螞蟻實際比例（小工蟻約 2.5 mm）', 16, ly);
    g.strokeStyle = '#fff6dc'; g.lineWidth = 2; const bxx = narrow ? w - 30 - bar : bx;
    g.beginPath(); g.moveTo(bxx, ly - 4); g.lineTo(bxx + bar, ly - 4); g.moveTo(bxx, ly - 8); g.lineTo(bxx, ly); g.moveTo(bxx + bar, ly - 8); g.lineTo(bxx + bar, ly); g.stroke();
    g.textAlign = narrow ? 'right' : 'left'; g.fillText(nice >= 1 ? `${nice} cm` : `${Math.round(nice * 10)} mm`, narrow ? bxx - 6 : bxx + bar + 6, ly);
    g.textAlign = 'left'; g.font = '11px system-ui'; g.fillStyle = '#e9dcc0';
    if (narrow) { g.fillText(PATH_LABEL, 16, yb - 26); g.fillText('地面景物＝裝飾（非障礙物、螞蟻不感知）', 16, yb - 10); }
    else g.fillText(`${PATH_LABEL}｜地面景物＝裝飾`, 16, yb - 10);
    g.restore();
    insetHits = drawInset(g, f, ins, selected, following);
  }
  setText('time', ui.time, `${fmtWorldTime(t)}（${f.env.date}）｜${pacing?.running ? `執行中 ${pacing.speed}×` : pacing?.started ? '已暫停' : '尚未開始'}${pacing?.lagging ? '（Worker 落後，事件照常逐一處理）' : ''}`);
  setText('status', ui.status, hudStatus(f, p0poses));
}
function setView(v: 'surface' | 'underground') {
  if (view === v) return; view = v; zoomGoal = null;
  ui.viewBtn.textContent = v === 'surface' ? '地下（概念圖）' : '回到地表'; ui.viewBtn.setAttribute('aria-pressed', String(v === 'underground'));
  ui.ugLabel.hidden = v !== 'underground'; ui.ugLabel.textContent = `${UNDERGROUND_LABEL}｜分組＝引擎狀態，位置＝示意`; insetHits = [];
  if (v === 'underground') homeCamera();
}
const hud: Record<string, string> = {};
const setText = (k: string, el: HTMLElement, v: string) => { if (hud[k] !== v) { hud[k] = v; el.textContent = v; } };
function drawHud(t: number) {
  if (!frame || isP0a2Frame(frame)) return;
  const out = poses.filter((p) => p.vis !== 'in_nest').length, walking = poses.filter((p) => p.vis === 'walking' && p.moving).length;
  setText('time', ui.time, `${fmtWorldTime(t)}｜${pacing?.running ? `執行中 ${pacing.speed}×` : pacing?.started ? '已暫停' : '尚未開始'}${pacing?.lagging ? '（Worker 落後，事件照常逐一處理）' : ''}`);
  setText('status', ui.status, `個體 ${frame.ants.length}（巢外 ${out}、行走 ${walking}、巢內 ${frame.ants.length - out}）｜事件 ${digest.count}｜光照 ${frame.env.light ? LIGHT_LABEL[frame.env.light] : '—'}｜氣溫 ${frame.env.temperature_c ?? '—'}°C（合成）`);
}
function renderCard() {
  const id = selected; if (!id || !frame) { ui.card.hidden = true; return; }
  if (isP0a2Frame(frame)) {
    const html = cardHtml(frame, id, p0poses.find((x) => x.id === id), following === id, following === id ? followedView : null);
    if (!html) { ui.card.hidden = true; return; }
    ui.card.hidden = false; ui.card.innerHTML = html;
    $('followBtn').onclick = () => void setFollow(following === id ? null : id);
    $('closeCard').onclick = () => { selected = null; void setFollow(null); };
    return;
  }
  const a = frame.ants.find((x) => x.id === id), p = poses.find((x) => x.id === id); if (!a) { ui.card.hidden = true; return; }
  const where = a.in_nest ? '在巢內（地表不畫位置）' : p?.interpolated ? `行走中（畫面位置＝兩個引擎紀錄點之間的顯示插值）` : `引擎紀錄點 (${a.from.x.toFixed(2)}, ${a.from.y.toFixed(2)}) cm`;
  const fv = following === id && followedView ? followedView as { bout_index?: number; memory?: unknown[] } : null;
  ui.card.hidden = false;
  ui.card.innerHTML = `<b>${id}</b>　<span class="muted">合成個體（不是本種行為模型）</span><br>活動：${ACTIVITY_LABEL[a.activity] ?? a.activity}（${fmtWorldTime(a.since_s)} → ${fmtWorldTime(a.until_s)}，引擎紀錄）<br>位置：${where}${a.to ? `<br>本段終點：(${a.to.x.toFixed(2)}, ${a.to.y.toFixed(2)}) cm` : ''}${fv ? `<br><span class="muted">追蹤中（Worker 唯讀副本）：第 ${fv.bout_index ?? '—'} 段、記憶點 ${fv.memory?.length ?? 0} 個</span>` : ''}<div class="row"><button id="followBtn" type="button">${following === id ? '取消追蹤' : '鏡頭追蹤'}</button><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
  $('followBtn').onclick = () => void setFollow(following === id ? null : id);
  $('closeCard').onclick = () => { selected = null; void setFollow(null); };
}
const escH = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** the 「尚未模擬」 button and panel: exactly the list in the world's save metadata (Owner #212 Q2 a) */
function renderNotSim() {
  const d = disclosure;
  ui.nsBtn.hidden = !d;
  if (!d) { ui.notSim.hidden = true; return; }
  ui.nsBtn.textContent = d.ok ? `尚未模擬 ${d.unwired.length} 項｜簡化代理 ${d.proxies.length} 項` : '尚未模擬：沒有清單';
  const li = (x: { row: string; label_zh: string }) => `<li data-row="${escH(x.row)}">${escH(x.label_zh)} <span class="src">（${escH(x.row)}）</span></li>`;
  ui.notSim.innerHTML = d.ok
    ? `<h2>這個世界尚未模擬什麼</h2><p>${escH(d.note_zh)}</p><h3>尚未模擬（${d.unwired.length} 項）</h3><ul id="nsUnwired">${d.unwired.map(li).join('')}</ul><h3>簡化代理（${d.proxies.length} 項）</h3><ul id="nsProxies">${d.proxies.map(li).join('')}</ul><p class="src">來源：此世界存檔中繼資料 <code>save_meta.not_simulated</code>（${escH(d.format)}；由 <code>${escH(d.source)}</code> 產生，與規則指紋一起版本化）。畫面不自帶清單，也不補上清單以外的機制；沒有列出的機制不代表已完整模擬。</p>`
    : `<h2>這個世界尚未模擬什麼</h2><p id="nsNone">${escH(d.reason)}</p>`;
}
let cardKey = '';
function renderLog() {
  ui.log.textContent = recent.slice().reverse().map((e) => `#${e.seq} ${fmtWorldTime(e.t_sim)} ${e.kind} ${e.entity ?? ''} ${e.engine_version.startsWith('experiment-p0a2') ? p0EventText(e) : e.kind === 'ant_bout_end' ? `${String(e.data.from)}→${String(e.data.to)}` : e.kind === 'env_hour' ? `${String(e.data.temperature_c)}°C（合成）` : e.kind === 'light_change' ? String(e.data.light) : ''}`).join('\n');
}

// ------------------------------------------------------------------ input (camera only)
function zoomAt(sx: number, sy: number, k: number) {
  zoomGoal = null;
  if (isP0a2Frame(frame)) {
    if (view === 'underground') { const w = canvas.clientWidth, h = canvas.clientHeight, ux = ucam.x + (sx - w / 2) / ucam.s, uy = ucam.y + (sy - h / 2) / ucam.s; ucam.s = Math.max(4, Math.min(120, ucam.s * k)); if (!following) { ucam.x = ux - (sx - w / 2) / ucam.s; ucam.y = uy - (sy - h / 2) / ucam.s; } return; }
    const [wx, wy] = S2W(sx, sy); cam.s = Math.max(2, Math.min(480, cam.s * k));
    if (!following) { const [nx, ny] = S2W(sx, sy); cam.x += wx - nx; cam.y += wy - ny; }
    return;
  }
  const fitS = Math.min(canvas.clientWidth, canvas.clientHeight) / (arenaR * 3);
  const [wx, wy] = S2W(sx, sy); cam.s = Math.max(fitS, Math.min(400, cam.s * k));
  if (!following) { const [nx, ny] = S2W(sx, sy); cam.x += wx - nx; cam.y += wy - ny; }
}
/** drawn ant records of the active renderer (P0-A2: garden renderer; synthetic: layered renderer) */
const currentDraws = (): readonly { id: string; sx: number; sy: number; ex: number; ey: number }[] => (isP0a2Frame(frame) ? p0draws : R.lastDraws());
function pick(sx: number, sy: number) {
  let best: string | null = null, bd = Math.max(22, antLengthPx(cam.s, minAntPx()) * 0.7);
  for (const d of currentDraws()) { const dd = Math.hypot(d.sx - sx, d.sy - sy); if (dd < bd) { bd = dd; best = d.id; } }
  if (isP0a2Frame(frame)) for (const h of insetHits) { const dd = Math.hypot(h.sx - sx, h.sy - sy); if (dd <= h.r && dd < bd) { bd = dd; best = h.id; } }
  selected = best; if (!best && following) void setFollow(null); renderCard();
}
function setupPointer() {
  const pts = new Map<number, { x: number; y: number }>(); let downAt = { x: 0, y: 0, t: 0 }, pinch0 = 0, s0 = 1;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); downAt = { x: e.offsetX, y: e.offsetY, t: performance.now() }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); s0 = cam.s; } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { const dx = e.offsetX - p.x, dy = e.offsetY - p.y; if (Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) > 4) { if (following) void setFollow(null); if (isP0a2Frame(frame) && view === 'underground') { ucam.x -= dx / ucam.s; ucam.y -= dy / ucam.s; } else { cam.x -= dx / cam.s; cam.y += dy / cam.s; } } }
    p.x = e.offsetX; p.y = e.offsetY;
    if (pts.size === 2 && pinch0 > 0) { const [a, b] = [...pts.values()]; zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, (s0 * Math.hypot(a.x - b.x, a.y - b.y)) / pinch0 / cam.s); }
  });
  const up = (e: PointerEvent) => {
    const wasTap = pts.size === 1 && Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) <= 4 && performance.now() - downAt.t < 500;
    pts.delete(e.pointerId); if (pts.size < 2) pinch0 = 0;
    if (wasTap) pick(e.offsetX, e.offsetY);
  };
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', (e) => { pts.delete(e.pointerId); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
}

// ------------------------------------------------------------------ loop (drawing only; the Worker paces the world)
function loop(now: number) {
  requestAnimationFrame(loop);
  if (stats.lastDraw && now - stats.lastDraw < 1000 / fpsCap - 2) return; // display frame-rate cap (drawing only)
  const fms = stats.lastDraw ? now - stats.lastDraw : null, dt = fms === null ? 0 : Math.min(0.1, fms / 1000);
  if (fms !== null) { stats.intervals.push(fms); if (stats.intervals.length > 600) stats.intervals.shift(); }
  stats.lastDraw = now; stats.frames++;
  if (!active) return;
  { const d0 = performance.now(); drawFrame(dt, fms); stats.drawMs.push(performance.now() - d0); if (stats.drawMs.length > 600) stats.drawMs.shift(); }
  renderSave();
  const key = `${selected}|${following}|${frame?.seq}`; if (key !== cardKey) { cardKey = key; renderCard(); }
}

async function init() {
  for (const m of V62_SPEEDS) ui.speed.add(new Option(`${m}×${m === 1 ? '（即時）' : ''}`, String(m), m === DEFAULT_SPEED, m === DEFAULT_SPEED));
  for (const f of FPS_CAPS) ui.fpsCap.add(new Option(`${f} fps`, String(f), f === 60, f === 60));
  ui.play.onclick = () => void playPause();
  ui.speed.onchange = () => void client.setSpeed(Number(ui.speed.value));
  ui.fpsCap.onchange = () => { fpsCap = Number(ui.fpsCap.value); };
  ui.follow.onchange = () => void setFollow(ui.follow.value === '' ? null : ui.follow.value);
  ui.info.onclick = () => { ui.about.hidden = !ui.about.hidden; ui.info.setAttribute('aria-expanded', String(!ui.about.hidden)); };
  ui.logBtn.onclick = () => { ui.log.hidden = !ui.log.hidden; if (!ui.log.hidden) renderLog(); };
  ui.nsBtn.onclick = () => { ui.notSim.hidden = !ui.notSim.hidden; ui.nsBtn.setAttribute('aria-expanded', String(!ui.notSim.hidden)); };
  ui.home.onclick = () => { void setFollow(null); homeCamera(); };
  ui.zoomIn.onclick = () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.5);
  ui.zoomOut.onclick = () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.5);
  ui.decor.onchange = () => setScene();
  ui.viewBtn.onclick = () => { if (following) void setFollow(null); setView(view === 'surface' ? 'underground' : 'surface'); };
  ui.legendBtn.onclick = () => { ui.legend.hidden = !ui.legend.hidden; ui.legendBtn.setAttribute('aria-expanded', String(!ui.legend.hidden)); };
  ui.closeBtn.onclick = () => closeUp(selected);
  setupPointer();
  window.addEventListener('resize', () => { resize(); });
  // the bottom bar grows when its status text wraps: keep the renderer margin and the nest inset above it
  // (bar heights only: no renderer resize, which would re-bake the scene whenever the status text wraps differently)
  new ResizeObserver(() => { const was = bottomBarPx; bottomBarPx = $('bottom').getBoundingClientRect().height; if (Math.abs(was - bottomBarPx) > 24 && isP0a2Frame(frame) && !following) homeCamera(); }).observe($('bottom'));
  resize();
  ui.saveBtn.onclick = () => { void session?.request('manual'); };
  ui.menuBtn.onclick = () => void toMenu();
  // extra save attempts when the page is hidden or unloaded (mobile may kill the page first: not the only mechanism)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void session?.request('hidden'); });
  window.addEventListener('pagehide', () => { void session?.request('pagehide'); });
  const q = new URLSearchParams(location.search);
  requestAnimationFrame(loop);
  if (q.has('seed')) { // temporary experiment (not saved): the P0-A2 PR 3 route, kept for the V6-2 tests
    tempMode = true; const seed = Number(q.get('seed')), kind: WorldKind = q.get('world') === 'synthetic' ? 'synthetic' : 'p0a2';
    const r = await client.init(`exp-v62-${seed}`, seed, kind);
    if (r.type === 'error') { ui.badge.textContent = `無法建立實驗世界：${r.code}`; return; }
    await enterWorld(q.get('autostart') !== '0');
    return;
  }
  const st = await ExperimentSaveStore.open();
  session = st.ok ? new ExperimentSession(client, st.value) : null;
  if (session) {
    session.onWorldStart = () => { digest = new EventDigest(); recent.length = 0; frame = null; p0poses = []; insetHits = []; p0draws = []; vis = null; };
    session.onRestored = (seq) => { digest.lastSeq = seq - 1; };
    session.onSaveState = (s) => { saveUi = s; };
    session.onLockLost = () => { ui.ro.hidden = false; ui.ro.textContent = session?.current?.readOnlyReason ?? '本分頁為唯讀'; };
  }
  menu = new Menu($('menu'), session, { enter: () => void enterWorld(true), message: (html, kind) => showNotice(html, kind) });
  menu.show(st.ok ? undefined : `無法使用本地儲存（${st.code}）：${st.message}`, st.ok ? 'info' : 'error');

}

/** Show the world view for the world now in the Worker (new, loaded or temporary) and start it at 1×. */
async function enterWorld(autostart: boolean) {
  // the scene must exist before the first drawn frame (the renderer bakes chunks from it): set it up, THEN activate
  const p0 = isP0a2Frame(frame);
  // VIS-1: the P0-A2 view opens on the garden surface with decoration on; the synthetic world keeps its plain ground
  ui.decor.checked = p0; ui.viewBtn.hidden = ui.closeBtn.hidden = !p0; view = 'underground'; setView('surface'); ui.ugLabel.hidden = true;
  setScene(); resize(); homeCamera();
  active = true; $('menu').hidden = true;
  selected = null; following = null; lastDisplay = null; ui.follow.length = 1; ui.card.hidden = true; ui.notice.hidden = true;
  const cur = session?.current;
  ui.ro.hidden = !cur || cur.writer; if (cur && !cur.writer) ui.ro.textContent = cur.readOnlyReason ?? '唯讀';
  ui.saveBtn.hidden = ui.menuBtn.hidden = tempMode; ui.saveStatus.hidden = tempMode;
  await client.setSpeed(DEFAULT_SPEED);
  // the 「尚未模擬」 list of THIS world, from its save metadata (a snapshot is a pure read at an event boundary)
  const snap = await client.snapshot();
  disclosure = snap.type === 'snapshot' ? notSimulatedOf(snap.snapshot) : { ok: false, reason: `無法讀取此世界的存檔中繼資料（${snap.type === 'error' ? snap.code : snap.type}）：「尚未模擬」清單未知，不得把畫面當成已模擬任何機制` }; ui.notSim.hidden = true; ui.nsBtn.setAttribute('aria-expanded', 'false'); renderNotSim();
  ui.badge.textContent = `${MODE_LABEL}｜${isP0a2Frame(frame) ? `${P0A2_STATUS_LABEL}｜P0-A2 24 小時個體行為世界` : '合成測試世界（不是螞蟻科學模型）'}｜${tempMode ? '臨時實驗（不存檔）' : `「${cur?.name ?? ''}」`}｜世界 ${frame?.world_id}｜種子 ${frame?.seed}｜規則指紋 ${frame?.rules_fingerprint.slice(0, 12)}…`;
  if (p0) G.warm(camera()); else R.warm(camera());
  if (autostart) await client.start();
  syncControls();
}
/** Back to the menu: pause, save (writer), release the lock. A failed save is reported, the last good save stays. */
async function toMenu() {
  if (!session) return;
  ui.menuBtn.disabled = true;
  const r = await session.leave(true);
  ui.menuBtn.disabled = false; active = false; frame = null; pacing = null; disclosure = null; renderNotSim();
  const failed = r && !r.ok ? r as { code: string; message: string } : null;
  menu?.show(failed ? `離開前的儲存失敗（${failed.code}）：${failed.message}。上一個成功的存檔仍保留。` : r ? '已儲存並回到選單。' : undefined, failed ? 'error' : 'info');
}
function showNotice(html: string, kind: string = 'info') { ui.notice.innerHTML = `${html} <button type="button" id="noticeClose" aria-label="關閉">✕</button>`; ui.notice.dataset.kind = kind; ui.notice.hidden = false; $('noticeClose').onclick = () => { ui.notice.hidden = true; }; }
const kb = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`;
function renderSave() {
  if (tempMode || !session?.current) return;
  const s = saveUi, rc = session.lastReceipt, cur = session.current;
  let t: string;
  if (!cur.writer) t = '唯讀：本分頁不存檔';
  else if (!s) t = '尚未儲存';
  else {
    const last = s.last_success_ms ? `上次成功儲存 ${new Date(s.last_success_ms).toLocaleTimeString('zh-TW', { hour12: false })}` : '尚無成功的儲存';
    const size = rc ? `｜${kb(rc.bytes)}、${(rc.ms.hash + rc.ms.write + rc.ms.verify + rc.ms.promote).toFixed(0)} ms（${rc.kind === 'manual' ? '手動' : '自動'}）` : '';
    t = s.status === 'saving' ? `正在儲存…｜${last}` : s.status === 'failed' ? `⚠ 儲存失敗（${s.last_error ?? ''}）— 上一個成功的存檔仍保留｜${last}` : s.status === 'saved' ? `已儲存｜${last}${size}` : `${s.text}｜${last}`;
  }
  t += `｜${cur.verification}`;
  if (ui.saveStatus.textContent !== t) { ui.saveStatus.textContent = t; ui.saveStatus.dataset.status = cur.writer ? s?.status ?? 'idle' : 'read_only'; }
  ui.saveBtn.disabled = !cur.writer;
}

/** Read-only hooks for the browser tests and measurements. The client is exposed so the tests can send the SAME
 *  scheduling / observation commands the buttons send; nothing here can change rules, parameters or individuals. */
(window as unknown as { __v62: unknown }).__v62 = {
  client, protocolErrors, session: () => session, saveUi: () => saveUi, active: () => active,
  frame: () => frame, pacing: () => pacing, followed: () => followedView,
  digest: () => ({ value: digest.value(), count: digest.count, lastSeq: digest.lastSeq, gaps: digest.gaps }),
  recent: () => recent.slice(),
  poses: () => poses.map((p) => ({ ...p })),
  p0poses: () => p0poses.map((p) => ({ ...p })),
  insetHits: () => insetHits.map((h) => ({ ...h })),
  sceneLight: () => sceneLight,
  disclosure: () => (disclosure ? JSON.parse(JSON.stringify(disclosure)) as NotSimulatedView : null),
  draws: () => currentDraws().map((d) => ({ id: d.id, ex: d.ex, ey: d.ey, sx: d.sx, sy: d.sy })),
  camera: () => camera(),
  state: () => ({ selected, following, fpsCap, cam: { ...cam }, quality: isP0a2Frame(frame) ? G.quality().level : R.quality().level, canvas_px: [canvas.width, canvas.height], layers: [...(isP0a2Frame(frame) ? G.trace : R.trace)], lastDisplay, view, ucam: { ...ucam }, garden: { ...G.stats, frameMs: undefined, frame_p50_ms: med(G.stats.frameMs), frame_p95_ms: pct(G.stats.frameMs, 0.95) } }),
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length, mean = n ? iv.reduce((s, x) => s + x, 0) / n : null; return { frames: stats.frames, samples: n, mean_ms: mean, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null, fps_mean: mean ? 1000 / mean : null }; },
  resetFps: () => { stats.intervals = []; stats.drawMs = []; stats.frames = 0; },
  drawCost: () => ({ samples: stats.drawMs.length, p50_ms: med(stats.drawMs), p95_ms: pct(stats.drawMs, 0.95) }),
  zoomAt: (sx: number, sy: number, k: number) => zoomAt(sx, sy, k),
  setView: (v: 'surface' | 'underground') => setView(v),
  closeUp: (id?: string) => closeUp(id ?? selected),
  corridor: () => (vis ? { nest: { ...vis.corridor.nest }, source: { ...vis.corridor.source }, route_cm: vis.corridor.route_cm, len: vis.corridor.line.len } : null),
  setFollow: (id: string | null) => setFollow(id),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
