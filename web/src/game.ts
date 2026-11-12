/**
 * 《螞蟻帝國》V6 Game View (phase 1): a continuously playing garden scene replaying the engine's recorded day.
 * Read-only. Positions come from game-model.antFrame (= model.poseAt): recorded points, or display interpolation
 * between two of them. Leg swing, body turning and the arrangement of ants standing at one site are drawing only.
 * No event is ever created here; the end-of-day settlement (deaths, eclosions, egg laying) has no clock time in the
 * engine and is shown as a banner, never at a minute. The scenery is decorative (示意場景).
 */
import { ACTION_LABEL, TASK_LABEL, NEST, assertKind, displayPositions, stateAt, windowOf, type Experiment, type ExperimentDay, type Place } from './model.ts';
import { daySummary, minuteAtFraction, nextActivityJump, summaryHtml, timelineMarks } from './replay-ux.ts';
import { antFrame, anyWalking, walkIntervals, buildDayIndex, gardenBounds, hash32, laneOffset, nextWalkStart, rosterAtStart, sceneDecor, settlementSummary, simMinutesPerRealSecond, siteSlot, SPEEDS, type AntFrame, type Decor, type Pos } from './game-model.ts';

interface Index { official: string; experiments: { id: string; file: string; title: string }[] }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene'), ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const ui = { world: $<HTMLSelectElement>('world'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), skip: $<HTMLInputElement>('skip'), time: $('time'), clock: $<HTMLInputElement>('clock'), prevDay: $<HTMLButtonElement>('prevDay'), nextDay: $<HTMLButtonElement>('nextDay'), labels: $<HTMLInputElement>('labels'), card: $('card'), banner: $('banner'), toast: $('toast'), counts: $('counts'), weather: $('weather'), info: $<HTMLButtonElement>('infoBtn'), about: $('about'), fit: $<HTMLButtonElement>('fit'), badge: $('badge') };

const SIM_ANT_LEN_CM = 0.25; // drawing only: body length is not an engine value (species body size is null)
const MIN_ANT_PX = 26;       // ants are drawn enlarged when zoomed out (labelled 放大顯示)
let index: Index, exp: Experiment, pos: Pos = {}, places: Place[] = [], decor: Decor | null = null, bounds = { x0: 0, y0: 0, x1: 1, y1: 1 }, sceneB = { x0: 0, y0: 0, x1: 1, y1: 1 };
let day = 1, t = 0, playing = true, speed = 20, skip = true, settleUntil = 0, ended = false;
let idx = new Map<string, ExperimentDay>(), roster: string[] = [], walks: { start: number; end: number }[] = [];
let selected: string | null = null, following: string | null = null, frames: AntFrame[] = [];
const cam = { x: 0, y: 0, s: 4 };
/** per-ant drawing state (heading easing, leg phase); reset on any time jump so nothing is "animated" across a jump */
const look = new Map<string, { h: number; phase: number; x: number; y: number }>();
const stats = { frames: 0, t0: 0, intervals: [] as number[], lastTs: 0 };
const bootTs = performance.now();
let toastUntil = 0, bannerText = '';

async function load<T>(file: string): Promise<T> { const r = await fetch('data/' + file); if (!r.ok) throw Error('cannot load ' + file); return r.json() as Promise<T>; }

async function init() {
  index = await load<Index>('index.json');
  ui.world.innerHTML = index.experiments.map((e) => `<option value="${e.file}">${e.title.replace('實驗世界：', '')}</option>`).join('');
  for (const m of SPEEDS) ui.speed.insertAdjacentHTML('beforeend', `<option value="${m}"${m === speed ? ' selected' : ''}>${m}× 實際速度</option>`);
  ui.world.onchange = () => void openWorld(ui.world.value);
  // restarting after the end goes through gotoDay(1) so the day's roster, route index and walks are rebuilt (R13-01)
  ui.play.onclick = () => { if (ended) gotoDay(1); playing = !playing; syncButtons(); };
  ui.speed.onchange = () => { speed = Number(ui.speed.value); };
  ui.skip.onchange = () => { skip = ui.skip.checked; };
  ui.clock.oninput = () => { t = Number(ui.clock.value); settleUntil = 0; ended = false; jumped(); };
  ui.prevDay.onclick = () => gotoDay(day - 1);
  ui.nextDay.onclick = () => gotoDay(day + 1);
  ui.info.onclick = () => { ui.about.hidden = !ui.about.hidden; ui.info.setAttribute('aria-expanded', String(!ui.about.hidden)); };
  ui.fit.onclick = () => { following = null; fitCamera(); renderCard(); };
  setupPointer(); setupReplayUx();
  window.addEventListener('resize', resize); resize();
  await openWorld(index.experiments[0].file);
  requestAnimationFrame(loop);
}

async function openWorld(file: string) {
  const e = assertKind(await load<Experiment>(file), 'experiment', file);
  exp = e; places = e.map.places; pos = displayPositions(places); bounds = gardenBounds(pos); sceneB = gardenBounds(pos, 90);
  const known = Object.values(pos).filter((p) => p.known);
  decor = sceneDecor(hash32(e.spec.id), sceneB, known); sceneCache = null;
  ui.badge.textContent = `實驗世界・非正式｜重播引擎紀錄（${e.spec.founding}、${e.spec.season === 'autumn' ? '秋季' : e.spec.season}、種子 ${e.spec.seed}、${e.days.length} 日）｜引擎 ${e.engine_version}`;
  selected = null; following = null; ended = false; homeCamera(); gotoDay(1); renderCard(); renderAbout();
}

function gotoDay(n: number) {
  if (!exp) return;
  day = Math.max(1, Math.min(exp.days.length, n)); t = 0; settleUntil = 0; ended = false;
  const d = exp.days[day - 1]; idx = buildDayIndex(d); walks = walkIntervals(d); roster = rosterAtStart(exp, day);
  ui.clock.max = String(windowOf(d)); jumped(); replayDayChanged();
}
const jumped = () => { look.clear(); };

/** Opening view: the nest and the nearer food sources (about 50 cm around the nest entrance). */
function homeCamera() {
  const n = pos[NEST]; cam.x = n?.x ?? 0; cam.y = n?.y ?? 0;
  cam.s = Math.min(canvas.clientWidth, canvas.clientHeight) / 100;
}
function fitCamera() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  cam.x = (bounds.x0 + bounds.x1) / 2; cam.y = (bounds.y0 + bounds.y1) / 2;
  cam.s = Math.min(w / (bounds.x1 - bounds.x0), h / (bounds.y1 - bounds.y0));
}
/** Render resolution: device pixel ratio capped at 2; lowered to 1 if frames stay slow (drawing only, never data). */
let maxDpr = 2, lowRes = false;
function resize() {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr); canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); if (exp && !following) homeCamera(); sceneCache = null;
}
const W2S = (x: number, y: number) => [canvas.clientWidth / 2 + (x - cam.x) * cam.s, canvas.clientHeight / 2 - (y - cam.y) * cam.s] as const;
const S2W = (sx: number, sy: number) => [cam.x + (sx - canvas.clientWidth / 2) / cam.s, cam.y - (sy - canvas.clientHeight / 2) / cam.s] as const;

// ------------------------------------------------------------------ time
function advance(dtReal: number, now: number) {
  const d = exp.days[day - 1], win = windowOf(d);
  if (settleUntil) { if (now >= settleUntil) { settleUntil = 0; if (day < exp.days.length) gotoDay(day + 1); else { ended = true; playing = false; syncButtons(); } } return; }
  if (skip && !anyWalking(walks, t)) {
    const n = nextWalkStart(walks, d, t), lead = 3 / 60; // land 3 simulated seconds before the walk starts
    const target = n === null ? win : Math.max(t, n - lead);
    if (target - t > 0.5) { toast(`快轉：跳過 ${Math.round(target - t)} 分鐘沒有螞蟻在外行走的時段`, now); t = target; jumped(); }
  }
  t += dtReal * simMinutesPerRealSecond(speed);
  if (t >= win) {
    t = win; const s = settlementSummary(d);
    bannerText = `第 ${d.day} 日活動時段結束・日終結算（引擎沒有記錄這些事件的時刻）：工蟻死亡 ${s.deaths}、羽化 ${s.eclosions}、產卵 ${s.eggs}`;
    settleUntil = now + 2600;
  }
}

// ------------------------------------------------------------------ drawing
let sceneCache: { canvas: HTMLCanvasElement; ppc: number } | null = null;
const SOIL_DARK = '#6e5338';
const CACHE_CAP = 1600;
type Rect = { x0: number; y0: number; x1: number; y1: number };
/** Paint the decorative scenery (world cm → target px via X/Y, ppc px per cm), skipping items outside `cull`. */
function paintDecor(g: CanvasRenderingContext2D, X: (x: number) => number, Y: (y: number) => number, ppc: number, cull: Rect) {
  const d = decor as Decor, inside = (x: number, y: number, m: number) => x > cull.x0 - m && x < cull.x1 + m && y > cull.y0 - m && y < cull.y1 + m;
  for (const s of d.speckles) if (inside(s.x, s.y, 1)) { g.fillStyle = s.dark ? 'rgba(60,42,26,0.35)' : 'rgba(200,170,130,0.30)'; g.beginPath(); g.arc(X(s.x), Y(s.y), Math.max(0.6, s.r * ppc), 0, 7); g.fill(); }
  for (const l of d.leaves) if (inside(l.x, l.y, 5)) {
    g.save(); g.translate(X(l.x), Y(l.y)); g.rotate(l.rot); const L = l.len * ppc;
    g.fillStyle = `hsl(${24 + l.hue * 22}, ${35 + l.hue * 20}%, ${26 + l.hue * 14}%)`; g.beginPath(); g.ellipse(0, 0, L / 2, L / 5, 0, 0, 7); g.fill();
    g.strokeStyle = 'rgba(40,25,10,0.45)'; g.lineWidth = Math.max(0.5, ppc * 0.05); g.beginPath(); g.moveTo(-L / 2, 0); g.lineTo(L / 2, 0); g.stroke(); g.restore();
  }
  for (const p of d.pebbles) if (inside(p.x, p.y, 3)) { const r = p.r * ppc; g.fillStyle = `hsl(30, 8%, ${48 + p.tone * 25}%)`; g.beginPath(); g.ellipse(X(p.x), Y(p.y), r, r * 0.8, p.tone * 3, 0, 7); g.fill(); g.fillStyle = 'rgba(255,255,255,0.18)'; g.beginPath(); g.ellipse(X(p.x) - r * 0.3, Y(p.y) - r * 0.3, r * 0.35, r * 0.25, 0, 0, 7); g.fill(); }
  for (const tf of d.tufts) if (inside(tf.x, tf.y, 7)) {
    const x = X(tf.x), y = Y(tf.y);
    for (let i = 0; i < tf.n; i++) { const a = -Math.PI / 2 + (i / (tf.n - 1) - 0.5) * 1.6 + tf.lean, h = tf.h * ppc * (0.7 + ((i * 37) % 10) / 30); g.strokeStyle = i % 2 ? '#5f8a3a' : '#79a04a'; g.lineWidth = Math.max(0.8, ppc * 0.18); g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a) * h * 0.5, y + Math.sin(a) * h * 0.5, x + Math.cos(a + tf.lean * 0.4) * h, y + Math.sin(a) * h); g.stroke(); }
  }
}
function soilBase(g: CanvasRenderingContext2D, w: number, h: number) {
  const grad = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
  grad.addColorStop(0, '#957555'); grad.addColorStop(1, SOIL_DARK); g.fillStyle = grad; g.fillRect(0, 0, w, h);
}
function buildScene() {
  const b = sceneB, W = b.x1 - b.x0, H = b.y1 - b.y0, ppc = CACHE_CAP / Math.max(W, H);
  const c = document.createElement('canvas'); c.width = Math.ceil(W * ppc); c.height = Math.ceil(H * ppc);
  const g = c.getContext('2d') as CanvasRenderingContext2D; soilBase(g, c.width, c.height);
  paintDecor(g, (x) => (x - b.x0) * ppc, (y) => (b.y1 - y) * ppc, ppc, b);
  sceneCache = { canvas: c, ppc };
}
/** Zoomed out: one cached bitmap of the whole scenery. Zoomed in past the cache resolution: the visible items are
 *  drawn as vectors (sharp at any zoom). Either way the scenery is decorative only. */
function drawScene() {
  const dpr = canvas.width / canvas.clientWidth, w = canvas.clientWidth, h = canvas.clientHeight;
  if (!sceneCache) buildScene();
  const c = sceneCache as { canvas: HTMLCanvasElement; ppc: number };
  ctx.fillStyle = SOIL_DARK; ctx.fillRect(0, 0, w, h);
  const [sx, sy] = W2S(sceneB.x0, sceneB.y1);
  ctx.imageSmoothingEnabled = true; ctx.drawImage(c.canvas, sx, sy, (sceneB.x1 - sceneB.x0) * cam.s, (sceneB.y1 - sceneB.y0) * cam.s);
  if (cam.s * dpr > c.ppc * 1.4) {
    const [ax, ay] = S2W(0, h), [bx, by] = S2W(w, 0);
    ctx.save(); ctx.globalAlpha = 1; paintDecor(ctx, (x) => W2S(x, 0)[0], (y) => W2S(0, y)[1], cam.s, { x0: ax, y0: ay, x1: bx, y1: by }); ctx.restore();
  }
  if (exp.days[day - 1].weather.wet) { ctx.fillStyle = 'rgba(30,40,60,0.18)'; ctx.fillRect(0, 0, w, h); }
}

function drawPlaces() {
  const s = stateAt(exp, day, t);
  for (const p of places) {
    const q = pos[p.id]; if (!q?.known) continue;
    const [x, y] = W2S(q.x, q.y), u = Math.max(cam.s, 4.5); // u = px per cm, floored so icons stay readable
    if (p.id === NEST) drawNest(x, y, u);
    else if (p.kind === 'honeydew') { const src = s.sources[p.id]; drawPlant(x, y, u, hash32(p.id), src?.host_alive !== false, Math.min(14, Math.max(0, (src?.hemipteran_colonies ?? 0) * 3))); }
    else if (p.kind === 'nectar') drawFlower(x, y, u, hash32(p.id));
    else if (p.kind === 'carcass') drawCarcass(x, y, u, hash32(p.id));
    if (ui.labels.checked) { ctx.fillStyle = 'rgba(255,248,230,0.95)'; ctx.font = '12px system-ui'; ctx.fillText(p.id, x + 4.5 * u, y - 3 * u); }
  }
}
function drawNest(x: number, y: number, u: number) {
  const r = mulberryLike(7);
  ctx.fillStyle = 'rgba(70,48,28,0.35)'; ctx.beginPath(); ctx.ellipse(x, y, 4.2 * u, 3.6 * u, 0, 0, 7); ctx.fill();
  for (let i = 0; i < 46; i++) { const a = r() * 7, d = (1 + r() * 2.8) * u; ctx.fillStyle = r() < 0.5 ? '#b08a62' : '#9a7650'; ctx.beginPath(); ctx.arc(x + Math.cos(a) * d, y + Math.sin(a) * d, (0.18 + r() * 0.28) * u, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#1e140c'; ctx.beginPath(); ctx.ellipse(x, y, 0.75 * u, 0.6 * u, 0.3, 0, 7); ctx.fill();
}
function drawPlant(x: number, y: number, u: number, seed: number, alive: boolean, aphids: number) {
  const r = mulberryLike(seed);
  ctx.strokeStyle = alive ? '#4d6b2a' : '#7a6a48'; ctx.lineWidth = Math.max(1.5, 0.35 * u); ctx.beginPath(); ctx.arc(x, y, 0.5 * u, 0, 7); ctx.stroke();
  for (let i = 0; i < 6; i++) { const a = (i / 6) * 6.283 + r() * 0.5, L = (2.2 + r() * 1.6) * u; ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = alive ? (i % 2 ? '#5e9a3a' : '#4f8a30') : '#8c7a52'; ctx.beginPath(); ctx.ellipse(L / 2, 0, L / 2, L / 4.2, 0, 0, 7); ctx.fill(); ctx.strokeStyle = 'rgba(20,50,10,0.5)'; ctx.lineWidth = 0.8; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(L, 0); ctx.stroke(); ctx.restore(); }
  for (let i = 0; i < aphids; i++) { const a = r() * 6.283, d = (0.6 + r() * 1.2) * u; ctx.fillStyle = '#c8e08a'; ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * d, y + Math.sin(a) * d, 0.22 * u, 0.15 * u, a, 0, 7); ctx.fill(); }
}
function drawFlower(x: number, y: number, u: number, seed: number) {
  const r = mulberryLike(seed);
  for (let i = 0; i < 4; i++) { const a = r() * 6.283, L = 2.4 * u; ctx.save(); ctx.translate(x, y); ctx.rotate(a); ctx.fillStyle = '#4f8a30'; ctx.beginPath(); ctx.ellipse(L / 2, 0, L / 2, L / 5, 0, 0, 7); ctx.fill(); ctx.restore(); }
  for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.283; ctx.fillStyle = '#f4e6b0'; ctx.beginPath(); ctx.ellipse(x + Math.cos(a) * 0.9 * u, y + Math.sin(a) * 0.9 * u, 0.8 * u, 0.5 * u, a, 0, 7); ctx.fill(); }
  ctx.fillStyle = '#d9a21e'; ctx.beginPath(); ctx.arc(x, y, 0.55 * u, 0, 7); ctx.fill();
}
function drawCarcass(x: number, y: number, u: number, seed: number) {
  const a = mulberryLike(seed)() * 6.283; ctx.save(); ctx.translate(x, y); ctx.rotate(a);
  ctx.strokeStyle = '#3a2a1a'; ctx.lineWidth = Math.max(1, 0.12 * u);
  for (const k of [-1, 1]) for (const f of [-0.5, 0, 0.5]) { ctx.beginPath(); ctx.moveTo(f * u, 0); ctx.lineTo((f + 0.3) * u, k * 1.2 * u); ctx.lineTo((f + 0.6) * u, k * 1.0 * u); ctx.stroke(); }
  ctx.fillStyle = '#4a3420'; ctx.beginPath(); ctx.ellipse(-0.2 * u, 0, 1.3 * u, 0.7 * u, 0, 0, 7); ctx.fill();
  ctx.fillStyle = '#5a4028'; ctx.beginPath(); ctx.arc(1.25 * u, 0, 0.42 * u, 0, 7); ctx.fill(); ctx.restore();
}
function mulberryLike(seed: number) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let q = a; q = Math.imul(q ^ (q >>> 15), q | 1); q ^= q + Math.imul(q ^ (q >>> 7), q | 61); return ((q ^ (q >>> 14)) >>> 0) / 4294967296; }; }

/** A Pheidole megacephala minor worker seen from above: head with mandibles and elbowed antennae, narrow mesosoma,
 *  two-node waist (petiole + postpetiole), darker gaster, six legs. Legs swing in a tripod gait only while the ant
 *  moves (the swing follows distance travelled); this is drawing, not data. Local +x = forward. */
function drawAnt(x: number, y: number, ang: number, L: number, phase: number, moving: boolean, sel: boolean) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
  ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.beginPath(); ctx.ellipse(-0.02 * L + 0.03 * L, 0.05 * L, 0.5 * L, 0.13 * L, 0, 0, 7); ctx.fill();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  // legs: coxa on the mesosoma, femur out, tibia to the foot; tripod = (front L, mid R, hind L) vs the other three
  ctx.strokeStyle = '#7a4a22'; ctx.lineWidth = Math.max(0.8, L * 0.032);
  const att = [0.17, 0.11, 0.05], foot = [[0.36, 0.28], [0.1, 0.36], [-0.2, 0.33]], knee = [[0.26, 0.2], [0.1, 0.24], [-0.04, 0.22]];
  for (let i = 0; i < 3; i++) for (const side of [-1, 1]) {
    const grp = (i === 1) === (side === 1) ? 0 : Math.PI, sw = moving ? Math.sin(phase + grp) : 0, lift = moving ? Math.max(0, Math.cos(phase + grp)) : 0;
    const fx = (foot[i][0] + sw * 0.09) * L, fy = side * (foot[i][1] - lift * 0.03) * L, kx = (knee[i][0] + sw * 0.04) * L, ky = side * knee[i][1] * L;
    ctx.beginPath(); ctx.moveTo(att[i] * L, side * 0.03 * L); ctx.lineTo(kx, ky); ctx.lineTo(fx, fy); ctx.stroke();
  }
  // antennae: scape back-out, funiculus forward (geniculate); a slight twitch while walking
  const tw = moving ? Math.sin(phase * 0.7) * 0.025 * L : 0;
  ctx.lineWidth = Math.max(0.7, L * 0.026);
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(0.4 * L, side * 0.05 * L); ctx.lineTo(0.47 * L, side * 0.17 * L); ctx.lineTo(0.66 * L + tw * side, side * 0.13 * L); ctx.stroke(); }
  const blob = (cx: number, rx: number, ry: number, col: string) => { ctx.fillStyle = col; ctx.beginPath(); ctx.ellipse(cx * L, 0, rx * L, ry * L, 0, 0, 7); ctx.fill(); };
  blob(-0.29, 0.17, 0.125, '#4c2812');  // gaster
  blob(-0.08, 0.045, 0.045, '#8d5426'); // postpetiole
  blob(-0.01, 0.034, 0.03, '#8d5426');  // petiole
  blob(0.12, 0.13, 0.055, '#a8652c');   // mesosoma
  blob(0.33, 0.105, 0.095, '#934f1e');  // head
  ctx.strokeStyle = '#5a3010'; ctx.lineWidth = Math.max(0.7, L * 0.03);
  for (const side of [-1, 1]) { ctx.beginPath(); ctx.moveTo(0.42 * L, side * 0.035 * L); ctx.quadraticCurveTo(0.48 * L, side * 0.03 * L, 0.47 * L, 0); ctx.stroke(); } // mandibles
  ctx.fillStyle = 'rgba(255,225,180,0.35)'; ctx.beginPath(); ctx.ellipse(-0.33 * L, -0.045 * L, 0.06 * L, 0.028 * L, -0.2, 0, 7); ctx.fill();
  ctx.fillStyle = '#1a0d05'; for (const side of [-1, 1]) { ctx.beginPath(); ctx.arc(0.35 * L, side * 0.07 * L, Math.max(0.5, 0.016 * L), 0, 7); ctx.fill(); } // eyes
  if (sel) { ctx.strokeStyle = '#ffe08a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.ellipse(0.04 * L, 0, 0.66 * L, 0.46 * L, 0, 0, 7); ctx.stroke(); }
  ctx.restore();
}

function drawAnts(dtReal: number) {
  const d = exp.days[day - 1], L = Math.max(MIN_ANT_PX, SIM_ANT_LEN_CM * cam.s);
  frames = roster.map((id) => antFrame(idx, d, id, t, pos));
  for (const f of frames) {
    if (f.vis === 'in_nest' || f.vis === 'unknown_place') { look.delete(f.id); continue; }
    let [x, y] = W2S(f.x, f.y), target = 0;
    if (f.vis === 'walking' && f.heading !== null) { target = -f.heading; const o = laneOffset(f.id) * L * 0.55; x += -Math.sin(target) * o; y += Math.cos(target) * o; }
    else { const s = siteSlot(f.id); x += s.dx * Math.min(1.4, L / MIN_ANT_PX); y += s.dy * Math.min(1.4, L / MIN_ANT_PX); target = s.heading; }
    const st = look.get(f.id) ?? { h: target, phase: hash32(f.id) % 7, x, y };
    // turning is drawn as an ease toward the current direction (≤ 8 rad/s on screen); position is never eased
    let dh = Math.atan2(Math.sin(target - st.h), Math.cos(target - st.h)); const maxTurn = 8 * dtReal;
    if (f.vis === 'walking' || look.has(f.id)) st.h += Math.max(-maxTurn, Math.min(maxTurn, dh)); else st.h = target;
    const moved = Math.hypot(x - st.x, y - st.y);
    if (f.moving) st.phase += Math.min(moved / Math.max(4, L * 0.35) * 3.14, 14 * 6.283 * dtReal); // leg swing follows travelled distance, capped
    st.x = x; st.y = y; look.set(f.id, st);
    drawAnt(x, y, st.h, L, st.phase, f.moving, f.id === selected);
    (f as AntFrame & { sx?: number; sy?: number }).sx = x; (f as AntFrame & { sx?: number; sy?: number }).sy = y;
    if (ui.labels.checked) { ctx.fillStyle = '#fff6dc'; ctx.font = '11px system-ui'; ctx.fillText(f.id, x + L * 0.6, y - L * 0.4); }
  }
}

const hudCache: Record<string, string> = {};
const setText = (k: string, el: HTMLElement, v: string) => { if (hudCache[k] !== v) { hudCache[k] = v; el.textContent = v; } };
function drawHud(now: number) {
  const d = exp.days[day - 1], win = windowOf(d), mm = Math.floor(t), ss = Math.floor((t - mm) * 60);
  setText('time', ui.time, `第 ${d.day} 日（${d.date}）・活動時段 ${mm} 分 ${String(ss).padStart(2, '0')} 秒／${win} 分`);
  if (document.activeElement !== ui.clock && Math.abs(Number(ui.clock.value) - t) > 0.05) ui.clock.value = String(t);
  const c = { walking: 0, at_site: 0, in_nest: 0, unknown_place: 0 }; for (const f of frames) c[f.vis]++;
  setText('counts', ui.counts, `在外 ${c.walking + c.at_site}・巢內 ${c.in_nest}${c.unknown_place ? `・在未記錄位置 ${c.unknown_place}` : ''}`);
  setText('weather', ui.weather, `氣溫 ${d.weather.air_temp_c.toFixed(1)}°C・巢溫 ${d.weather.nest_temp_c.toFixed(1)}°C・${d.weather.rain_mm > 0 ? `雨 ${d.weather.rain_mm} mm（日值）` : '無雨'}${d.weather.wet ? '・地面潮濕' : ''}`);
  const bh = !settleUntil && !ended; if (ui.banner.hidden !== bh) ui.banner.hidden = bh; setText('banner', ui.banner, ended ? `重播結束：${exp.days.length} 日的引擎紀錄已播完。按「重新播放」從第 1 日開始。` : bannerText);
  const th = now > toastUntil; if (ui.toast.hidden !== th) ui.toast.hidden = th;
  if (ui.prevDay.disabled !== (day <= 1)) ui.prevDay.disabled = day <= 1; if (ui.nextDay.disabled !== (day >= exp.days.length)) ui.nextDay.disabled = day >= exp.days.length;
}
function toast(msg: string, now: number) { ui.toast.textContent = msg; toastUntil = now + 1800; }
function syncButtons() { ui.play.textContent = ended ? '重新播放' : playing ? '暫停' : '播放'; ui.play.setAttribute('aria-pressed', String(playing)); }

function renderCard() {
  if (!selected || !exp) { ui.card.hidden = true; return; }
  const d = exp.days[day - 1], f = frames.find((x) => x.id === selected), task = d.tasks?.[selected];
  if (!f) { ui.card.hidden = true; return; }
  const where = f.vis === 'walking' ? `行走中 ${f.place.replace('>', ' → ')}（畫面位置＝兩個引擎紀錄點之間的插值）` : f.vis === 'at_site' ? `在 ${f.place}（引擎紀錄點）` : f.vis === 'in_nest' ? '在巢內（地表看不到）' : `在位置未記錄的地點 ${f.place}（不畫在花園上）`;
  ui.card.hidden = false;
  ui.card.innerHTML = `<b>${selected}</b>　<span class="muted">熱帶大頭家蟻・小工蟻（引擎尚未模擬大工蟻）</span><br>現在：${ACTION_LABEL[f.action] ?? f.action}${f.segStart !== null ? `（本段 ${f.segStart.toFixed(1)}–${(f.segEnd as number).toFixed(1)} 分，引擎紀錄）` : ''}<br>位置：${where}<br>今日紀錄任務：${task ? `${TASK_LABEL[task.task] ?? task.task}；出巢 ${task.trips} 趟、成功 ${task.successes}` : '—'}<div class="row"><button id="followBtn" type="button">${following === selected ? '取消追蹤' : '鏡頭追蹤'}</button><a href="analysis.html">在分析模式查看完整紀錄</a><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
  $('followBtn').onclick = () => { following = following === selected ? null : selected; renderCard(); };
  $('closeCard').onclick = () => { selected = null; following = null; renderCard(); };
}
let cardKey = '';

function renderAbout() {
  ui.about.innerHTML = `<h2>畫面上的東西從哪裡來</h2><ul>
<li><b>引擎紀錄</b>：每隻螞蟻在每個時刻的所在地點、出發與抵達的分鐘、行動（出巢、搜尋、採集、回巢、卸貨、休息）與當日任務，來自 <code>web/data/${ui.world.value}</code>（引擎 ${exp.engine_version}）。食源上的蚜蟲群數、寄主是否存活、天氣日值也是引擎紀錄。</li>
<li><b>顯示插值</b>：螞蟻在兩個紀錄點之間沿直線前進的位置；同一路段同時出發的螞蟻左右錯開幾個像素；停在同一地點的螞蟻圍成一圈排列；轉身與腳的擺動。這些只為畫面，不寫回、不產生事件。</li>
<li><b>示意場景</b>：土壤、落葉、石子、草叢、植物與花的外觀是以種子產生的裝飾，不是任何實際花園的測量。地點位置由「方位＋約距離」推得，非測量。螞蟻外形為示意，縮小時放大顯示（引擎中的體長是 null）。</li>
<li><b>沒有畫出的</b>：巢內的活動（只計數）；位置未記錄地點的螞蟻；沒有時刻的日終結算（死亡、羽化、產卵只在橫幅顯示）。不會出現引擎沒有記錄的覓食、交哺、攻擊或死亡。</li>
<li><b>時間</b>：引擎目前以每日 360 分鐘活動時段簡化一天（不是 24 小時；24 小時時鐘仍在開發）。播放速度以實際時間倍數表示；「快轉」只跳過沒有螞蟻在外行走的時段，不改變任何紀錄。</li>
<li><b>跳轉與日摘要</b>：時間軸下方的標記是引擎紀錄的行走時段（worker_activity）；「下一段活動」（快捷鍵 N）跳到下一段紀錄的行走開始前約 3 秒，不跳過任何行走的開始；兩者都只改變觀看的時刻。「日摘要」不是連續播放：有分鐘紀錄的事件列出紀錄的時刻，沒有分鐘紀錄的事件只列為日層級，不放在任何時間點；回到連續播放時恢復原本的觀看位置。</li>
<li><b>這是非正式的實驗世界</b>，不是正式 Day14 遊戲；觀察者只觀察，不干預。</li></ul>`;
}

// ------------------------------------------------------------------ input
function setupPointer() {
  const pts = new Map<number, { x: number; y: number }>(); let downAt = { x: 0, y: 0, t: 0 }, pinch0 = 0, s0 = 1;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); downAt = { x: e.offsetX, y: e.offsetY, t: performance.now() }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); s0 = cam.s; } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { const dx = e.offsetX - p.x, dy = e.offsetY - p.y; if (Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) > 4) { following = null; cam.x -= dx / cam.s; cam.y += dy / cam.s; } }
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
function zoomAt(sx: number, sy: number, k: number) {
  const fitS = Math.min(canvas.clientWidth / (bounds.x1 - bounds.x0), canvas.clientHeight / (bounds.y1 - bounds.y0));
  const ns = Math.max(fitS * 0.6, Math.min(160, cam.s * k)); const [wx, wy] = S2W(sx, sy); cam.s = ns;
  if (!following) { const [nx, ny] = S2W(sx, sy); cam.x += wx - nx; cam.y += wy - ny; }
}
function pick(sx: number, sy: number) {
  let best: string | null = null, bd = 22;
  for (const f of frames as (AntFrame & { sx?: number; sy?: number })[]) if (f.sx !== undefined && (f.vis === 'walking' || f.vis === 'at_site')) { const dd = Math.hypot(f.sx - sx, (f.sy as number) - sy); if (dd < bd) { bd = dd; best = f.id; } }
  selected = best; if (!best) following = null; renderCard();
}

// ------------------------------------------------------------------ loop
function loop(now: number) {
  const dt = stats.lastTs ? Math.min(0.1, (now - stats.lastTs) / 1000) : 0;
  if (stats.lastTs) { stats.intervals.push(now - stats.lastTs); if (stats.intervals.length > 600) stats.intervals.shift(); }
  stats.lastTs = now; stats.frames++;
  if (!lowRes && stats.intervals.length >= 120 && now - bootTs > 4000) { const r = stats.intervals.slice(-120), m = r.reduce((a, b) => a + b, 0) / r.length; if (m > 30 && (window.devicePixelRatio || 1) > 1) { lowRes = true; maxDpr = 1; resize(); } }
  if (exp && !replay.summary) {
    if (playing && !ended) advance(dt, now);
    if (following) { const f = frames.find((x) => x.id === following); if (f && (f.vis === 'walking' || f.vis === 'at_site')) { cam.x += (f.x - cam.x) * Math.min(1, dt * 6); cam.y += (f.y - cam.y) * Math.min(1, dt * 6); } }
    drawScene(); drawPlaces(); drawAnts(dt); drawHud(now);
    const key = `${selected}|${following}|${frames.find((x) => x.id === selected)?.action}|${frames.find((x) => x.id === selected)?.place}|${day}`; if (key !== cardKey) { cardKey = key; renderCard(); }
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ replay navigation (Issue #148)
// Each control only changes the VIEWING position or the display mode; none creates an event or changes engine time.
const rx = { next: $<HTMLButtonElement>('nextAct'), mode: $<HTMLButtonElement>('modeBtn'), marks: $('marks'), summary: $('summary') };
const replay = { summary: false, saved: null as { day: number; t: number; playing: boolean } | null };
function jumpToNextActivity() {
  if (!exp || replay.summary) return;
  const d = exp.days[day - 1], r = nextActivityJump(walks, d, t), now = performance.now();
  if (r.kind === 'none') { toast(r.reason, now); return; }
  const gap = r.walkStart - r.target;
  t = r.target; settleUntil = 0; ended = false; jumped(); syncButtons();
  toast(`跳到下一段活動：引擎紀錄的行走${gap > 1e-9 ? `在 ${Math.round(gap * 60)} 秒後` : '在此刻'}開始（${r.walksStarting} 段）`, now);
}
function renderMarks() {
  const d = exp.days[day - 1];
  rx.marks.innerHTML = timelineMarks(walks, windowOf(d)).map((m) => `<i style="left:${(m.left * 100).toFixed(4)}%;width:${(m.width * 100).toFixed(4)}%" data-start="${m.start}" data-end="${m.end}"></i>`).join('');
  rx.marks.title = `引擎紀錄的行走時段（worker_activity）：第 ${d.day} 日 ${walks.length} 段；點選或拖曳可跳到該時刻`;
}
function renderSummary() { rx.summary.innerHTML = summaryHtml(daySummary(exp.days[day - 1], walks)); }
function replayDayChanged() { renderMarks(); if (replay.summary) renderSummary(); }
function setMode(summary: boolean) {
  if (summary === replay.summary || !exp) return;
  if (summary) { replay.saved = { day, t, playing }; playing = false; replay.summary = true; renderSummary(); }
  else {
    replay.summary = false; const s = replay.saved; replay.saved = null;
    if (s) { if (s.day !== day) gotoDay(s.day); t = s.t; playing = s.playing; jumped(); }
  }
  document.body.classList.toggle('summary-mode', replay.summary); rx.summary.hidden = !replay.summary;
  rx.mode.textContent = replay.summary ? '回到連續播放' : '日摘要'; rx.mode.setAttribute('aria-pressed', String(replay.summary)); syncButtons();
}
function setupReplayUx() {
  rx.next.onclick = jumpToNextActivity;
  rx.mode.onclick = () => setMode(!replay.summary);
  window.addEventListener('keydown', (e) => {
    const tag = (e.target as HTMLElement | null)?.tagName;
    if (e.ctrlKey || e.metaKey || e.altKey || tag === 'SELECT' || tag === 'TEXTAREA') return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); jumpToNextActivity(); }
  });
  // tap or drag on the marks strip scrubs the viewing minute (touch and mouse); display only
  let scrubbing = false;
  const seek = (e: PointerEvent) => { const r = rx.marks.getBoundingClientRect(); t = minuteAtFraction((e.clientX - r.left) / r.width, windowOf(exp.days[day - 1])); settleUntil = 0; ended = false; jumped(); };
  rx.marks.addEventListener('pointerdown', (e) => { if (!exp || replay.summary) return; scrubbing = true; rx.marks.setPointerCapture(e.pointerId); seek(e); });
  rx.marks.addEventListener('pointermove', (e) => { if (scrubbing) seek(e); });
  const end = () => { scrubbing = false; }; rx.marks.addEventListener('pointerup', end); rx.marks.addEventListener('pointercancel', end);
}

/** Read-only hooks for the browser tests and the FPS measurement (nothing here can change the replay data). */
(window as unknown as { __game: unknown }).__game = {
  state: () => ({ world: ui.world.value, day, t, playing, speed, skip, mode: replay.summary ? 'summary' : 'playback', selected, following, ended, cam: { ...cam }, low_res: lowRes, canvas_px: [canvas.width, canvas.height] }),
  ants: () => (frames as (AntFrame & { sx?: number; sy?: number })[]).map((f) => ({ id: f.id, vis: f.vis, moving: f.moving, x: f.x, y: f.y, sx: f.sx ?? null, sy: f.sy ?? null, place: f.place, action: f.action })),
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length; return { frames: stats.frames, samples: n, mean_ms: n ? iv.reduce((s, x) => s + x, 0) / n : null, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null, fps_mean: n ? 1000 / (iv.reduce((s, x) => s + x, 0) / n) : null }; },
  resetFps: () => { stats.intervals = []; stats.frames = 0; },
  gotoDay: (n: number) => gotoDay(n),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
