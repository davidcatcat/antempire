/**
 * 《螞蟻帝國》V6-2 experiment mode (web/experiment.html): a continuously running NON-OFFICIAL experiment world.
 * The simulation runs ONLY in the experiment Web Worker (started by experimental/worker-client.ts); this page sends
 * scheduling / observation commands and draws what the Worker reports with the V6 layered renderer:
 *  - engine records: the Worker's frames (segment start / end points, activity, environment) and events (log);
 *  - display interpolation: an ant's point strictly between the two records of its straight segment (v62-model.poseAt),
 *    the display clock's small lead between frames, camera, zoom, leg motion and turning ease — drawing only;
 *  - 示意: ground texture (and optional litter), the fixed schematic light. The synthetic world has no obstacles.
 * Nothing here runs the simulation, fetches web/data, reads saves/ or journal/, or writes anything.
 */
import { ExperimentWorkerClient } from './experimental/worker-client.ts';
import type { EventMsg, FrameMsg, PacingMsg } from './experimental/worker-protocol.ts';
import { LayeredRenderer } from './render-canvas.ts';
import { antLengthPx, worldToScreen, type Camera } from './render-scene.ts';
import { SCHEMATIC_LIGHT } from './art-core.ts';
import { hash32 } from './game-model.ts';
import { ACTIVITY_LABEL, DEFAULT_SPEED, EventDigest, FPS_CAPS, LIGHT_LABEL, MODE_LABEL, NEST_PLACE, V62_SPEEDS, antInputs, displayTime, fmtWorldTime, posesAt, scenePositions, type Pose } from './v62-model.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const ui = { play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), fpsCap: $<HTMLSelectElement>('fpsCap'), follow: $<HTMLSelectElement>('follow'), time: $('time'), status: $('status'), card: $('card'), badge: $('badge'), info: $<HTMLButtonElement>('infoBtn'), about: $('about'), logBtn: $<HTMLButtonElement>('logBtn'), log: $('log'), home: $<HTMLButtonElement>('homeBtn'), zoomIn: $<HTMLButtonElement>('zoomIn'), zoomOut: $<HTMLButtonElement>('zoomOut'), decor: $<HTMLInputElement>('decor') };

const R = new LayeredRenderer(canvas);
const client = new ExperimentWorkerClient();
let frame: FrameMsg | null = null, pacing: PacingMsg | null = null, frameAt = 0, followedView: unknown = null, lastDisplay: number | null = null;
let poses: Pose[] = [], selected: string | null = null, following: string | null = null, arenaR = 60;
const digest = new EventDigest(), recent: EventMsg[] = [], protocolErrors: string[] = [];
const cam = { x: 0, y: 0, s: 8 };
const stats = { frames: 0, intervals: [] as number[], lastTs: 0, lastDraw: 0 };
let fpsCap = 60, topBarPx = 0, bottomBarPx = 0;

const minAntPx = () => Math.max(28, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.05));
const camera = (): Camera => ({ cx: cam.x, cy: cam.y, s: cam.s, w: canvas.clientWidth, h: canvas.clientHeight });
const S2W = (sx: number, sy: number) => [cam.x + (sx - canvas.clientWidth / 2) / cam.s, cam.y - (sy - canvas.clientHeight / 2) / cam.s] as const;

client.onEvents = (evs) => { for (const e of evs) { digest.add(e); recent.push(e); } if (recent.length > 60) recent.splice(0, recent.length - 60); if (!ui.log.hidden) renderLog(); };
client.onState = (f, p, fol) => { frame = f; pacing = p; followedView = fol; frameAt = performance.now(); arenaR = f.arena_radius_cm; syncControls(); };
client.onProtocolError = (w) => { protocolErrors.push(w); ui.status.textContent = `協定錯誤：${w}`; };

function setScene() {
  R.setScene({ decor: ui.decor.checked, seed: hash32(frame?.world_id ?? 'exp'), places: [NEST_PLACE], pos: scenePositions(), routes: [], sources: {}, weather: null, light: SCHEMATIC_LIGHT });
  // no synchronous warm here: a toggle re-bakes chunks through the renderer's per-frame bake budget (the page stays responsive)
}
function homeCamera() { cam.x = 0; cam.y = 0; cam.s = Math.min(canvas.clientWidth, canvas.clientHeight - bottomBarPx - topBarPx) / (arenaR * 2.2); }
function resize() { R.resize(); topBarPx = $('top').getBoundingClientRect().height; bottomBarPx = $('bottom').getBoundingClientRect().height; }

// ------------------------------------------------------------------ controls (scheduling / observation only)
function syncControls() {
  const running = !!pacing?.running;
  const label = !pacing?.started ? '開始' : running ? '暫停' : '繼續';
  if (ui.play.textContent !== label) ui.play.textContent = label;
  ui.play.setAttribute('aria-pressed', String(running));
  if (pacing && document.activeElement !== ui.speed && ui.speed.value !== String(pacing.speed) && [...ui.speed.options].some((o) => o.value === String(pacing!.speed))) ui.speed.value = String(pacing.speed);
  if (frame && ui.follow.options.length === 1) for (const a of frame.ants) ui.follow.add(new Option(a.id, a.id));
}
async function playPause() {
  if (!pacing) return;
  if (!pacing.started) await client.start(); else if (pacing.running) await client.pause(); else await client.resume();
  lastDisplay = null; syncControls();
}
async function setFollow(id: string | null) {
  following = id; selected = id ?? selected; ui.follow.value = id ?? '';
  await client.follow(id); // observation only: the Worker attaches a read-only copy of the ant to each frame
  renderCard();
}

// ------------------------------------------------------------------ drawing
function drawFrame(dt: number, fms: number | null) {
  if (!frame) return;
  const now = performance.now(), t = displayTime(frame.t_sim, !!pacing?.running, pacing?.speed ?? DEFAULT_SPEED, now - frameAt, lastDisplay);
  lastDisplay = pacing?.running ? t : null;
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
const hud: Record<string, string> = {};
const setText = (k: string, el: HTMLElement, v: string) => { if (hud[k] !== v) { hud[k] = v; el.textContent = v; } };
function drawHud(t: number) {
  if (!frame) return;
  const out = poses.filter((p) => p.vis !== 'in_nest').length, walking = poses.filter((p) => p.vis === 'walking' && p.moving).length;
  setText('time', ui.time, `${fmtWorldTime(t)}｜${pacing?.running ? `執行中 ${pacing.speed}×` : pacing?.started ? '已暫停' : '尚未開始'}${pacing?.lagging ? '（Worker 落後，事件照常逐一處理）' : ''}`);
  setText('status', ui.status, `個體 ${frame.ants.length}（巢外 ${out}、行走 ${walking}、巢內 ${frame.ants.length - out}）｜事件 ${digest.count}｜光照 ${frame.env.light ? LIGHT_LABEL[frame.env.light] : '—'}｜氣溫 ${frame.env.temperature_c ?? '—'}°C（合成）`);
}
function renderCard() {
  const id = selected; if (!id || !frame) { ui.card.hidden = true; return; }
  const a = frame.ants.find((x) => x.id === id), p = poses.find((x) => x.id === id); if (!a) { ui.card.hidden = true; return; }
  const where = a.in_nest ? '在巢內（地表不畫位置）' : p?.interpolated ? `行走中（畫面位置＝兩個引擎紀錄點之間的顯示插值）` : `引擎紀錄點 (${a.from.x.toFixed(2)}, ${a.from.y.toFixed(2)}) cm`;
  const fv = following === id && followedView ? followedView as { bout_index?: number; memory?: unknown[] } : null;
  ui.card.hidden = false;
  ui.card.innerHTML = `<b>${id}</b>　<span class="muted">合成個體（不是本種行為模型）</span><br>活動：${ACTIVITY_LABEL[a.activity] ?? a.activity}（${fmtWorldTime(a.since_s)} → ${fmtWorldTime(a.until_s)}，引擎紀錄）<br>位置：${where}${a.to ? `<br>本段終點：(${a.to.x.toFixed(2)}, ${a.to.y.toFixed(2)}) cm` : ''}${fv ? `<br><span class="muted">追蹤中（Worker 唯讀副本）：第 ${fv.bout_index ?? '—'} 段、記憶點 ${fv.memory?.length ?? 0} 個</span>` : ''}<div class="row"><button id="followBtn" type="button">${following === id ? '取消追蹤' : '鏡頭追蹤'}</button><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
  $('followBtn').onclick = () => void setFollow(following === id ? null : id);
  $('closeCard').onclick = () => { selected = null; void setFollow(null); };
}
let cardKey = '';
function renderLog() {
  ui.log.textContent = recent.slice().reverse().map((e) => `#${e.seq} ${fmtWorldTime(e.t_sim)} ${e.kind} ${e.entity ?? ''} ${e.kind === 'ant_bout_end' ? `${String(e.data.from)}→${String(e.data.to)}` : e.kind === 'env_hour' ? `${String(e.data.temperature_c)}°C（合成）` : e.kind === 'light_change' ? String(e.data.light) : ''}`).join('\n');
}

// ------------------------------------------------------------------ input (camera only)
function zoomAt(sx: number, sy: number, k: number) {
  const fitS = Math.min(canvas.clientWidth, canvas.clientHeight) / (arenaR * 3);
  const [wx, wy] = S2W(sx, sy); cam.s = Math.max(fitS, Math.min(400, cam.s * k));
  if (!following) { const [nx, ny] = S2W(sx, sy); cam.x += wx - nx; cam.y += wy - ny; }
}
function pick(sx: number, sy: number) {
  let best: string | null = null, bd = Math.max(22, antLengthPx(cam.s, minAntPx()) * 0.7);
  for (const d of R.lastDraws()) { const dd = Math.hypot(d.sx - sx, d.sy - sy); if (dd < bd) { bd = dd; best = d.id; } }
  selected = best; if (!best && following) void setFollow(null); renderCard();
}
function setupPointer() {
  const pts = new Map<number, { x: number; y: number }>(); let downAt = { x: 0, y: 0, t: 0 }, pinch0 = 0, s0 = 1;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); downAt = { x: e.offsetX, y: e.offsetY, t: performance.now() }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); s0 = cam.s; } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { const dx = e.offsetX - p.x, dy = e.offsetY - p.y; if (Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) > 4) { if (following) void setFollow(null); cam.x -= dx / cam.s; cam.y += dy / cam.s; } }
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
  drawFrame(dt, fms);
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
  ui.home.onclick = () => { void setFollow(null); homeCamera(); };
  ui.zoomIn.onclick = () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1.5);
  ui.zoomOut.onclick = () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, 1 / 1.5);
  ui.decor.onchange = () => setScene();
  setupPointer();
  window.addEventListener('resize', () => { resize(); });
  resize();
  const q = new URLSearchParams(location.search), seed = Number(q.get('seed') ?? '1');
  const r = await client.init(`exp-v62-${seed}`, seed);
  if (r.type === 'error') { ui.badge.textContent = `無法建立實驗世界：${r.code}`; return; }
  ui.badge.textContent = `${MODE_LABEL}｜合成世界 ${frame?.world_id}｜種子 ${frame?.seed}｜規則指紋 ${frame?.rules_fingerprint.slice(0, 12)}…`;
  await client.setSpeed(DEFAULT_SPEED);
  setScene(); homeCamera(); R.warm(camera());
  if (q.get('autostart') !== '0') await client.start();
  syncControls();
  requestAnimationFrame(loop);
}

/** Read-only hooks for the browser tests and measurements. The client is exposed so the tests can send the SAME
 *  scheduling / observation commands the buttons send; nothing here can change rules, parameters or individuals. */
(window as unknown as { __v62: unknown }).__v62 = {
  client, protocolErrors,
  frame: () => frame, pacing: () => pacing, followed: () => followedView,
  digest: () => ({ value: digest.value(), count: digest.count, lastSeq: digest.lastSeq, gaps: digest.gaps }),
  recent: () => recent.slice(),
  poses: () => poses.map((p) => ({ ...p })),
  draws: () => R.lastDraws().map((d) => ({ id: d.id, ex: d.ex, ey: d.ey, sx: d.sx, sy: d.sy })),
  camera: () => camera(),
  state: () => ({ selected, following, fpsCap, cam: { ...cam }, quality: R.quality().level, canvas_px: [canvas.width, canvas.height], layers: [...R.trace], lastDisplay }),
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length, mean = n ? iv.reduce((s, x) => s + x, 0) / n : null; return { frames: stats.frames, samples: n, mean_ms: mean, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null, fps_mean: mean ? 1000 / mean : null }; },
  resetFps: () => { stats.intervals = []; stats.frames = 0; },
  zoomAt: (sx: number, sy: number, k: number) => zoomAt(sx, sy, k),
  setFollow: (id: string | null) => setFollow(id),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
