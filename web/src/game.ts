/**
 * 《螞蟻帝國》V6 Game View: a continuously playing garden scene replaying the engine's recorded days, drawn by the
 * layered renderer (render-canvas.ts: 示意場景 ground, litter, stones, grass; engine places as sprites; ant sprites).
 * Read-only. Positions come from game-model.antFrame (= model.poseAt): recorded points, or display interpolation
 * between two of them. Leg motion, body turning and the arrangement of ants at one site are drawing only.
 * No event is ever created here; the end-of-day settlement (deaths, eclosions, egg laying) has no clock time in the
 * engine and is shown as a banner, never at a minute. The scenery is decorative (示意場景); the light is a fixed
 * schematic light (the replay has no time of day); weather is the engine's DAILY value.
 */
import { ACTION_LABEL, TASK_LABEL, NEST, assertKind, displayPositions, stateAt, windowOf, type Experiment, type ExperimentDay, type Place } from './model.ts';
import { antFrame, anyWalking, walkIntervals, buildDayIndex, gardenBounds, hash32, laneOffset, nextWalkStart, openingMoment, rosterAtStart, settlementSummary, simMinutesPerRealSecond, siteSlot, SPEEDS, type AntFrame, type Pos } from './game-model.ts';
import { LayeredRenderer } from './render-canvas.ts';
import { antLengthPx, recordedRoutes, type AntInput, type Camera } from './render-scene.ts';
import { SCHEMATIC_LIGHT } from './art-core.ts';
import { playbackDamp, smoothedContext, type ContextSampler, type RawSample } from './display-motion.ts';

interface Index { official: string; experiments: { id: string; file: string; title: string }[] }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const ui = { world: $<HTMLSelectElement>('world'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), skip: $<HTMLInputElement>('skip'), time: $('time'), clock: $<HTMLInputElement>('clock'), prevDay: $<HTMLButtonElement>('prevDay'), nextDay: $<HTMLButtonElement>('nextDay'), card: $('card'), banner: $('banner'), toast: $('toast'), counts: $('counts'), weather: $('weather'), info: $<HTMLButtonElement>('infoBtn'), about: $('about'), fit: $<HTMLButtonElement>('fit'), badge: $('badge'), layersBtn: $<HTMLButtonElement>('layersBtn'), layers: $('layers'), lEngine: $<HTMLInputElement>('layerEngine'), lLabels: $<HTMLInputElement>('layerLabels'), lRoutes: $<HTMLInputElement>('layerRoutes'), lIds: $<HTMLInputElement>('layerIds'), lChips: $<HTMLInputElement>('layerChips'), home: $<HTMLButtonElement>('homeBtn'), nextWalk: $<HTMLButtonElement>('nextWalkBtn') };

/** smallest drawn ant (CSS px), derived from the screen (8% of its short side, at least 36 px): ants are magnified to
 *  stay readable and the renderer labels the factor (放大顯示 ×N) */
const minAntPx = () => Math.max(36, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.08));
const R = new LayeredRenderer(canvas);
let index: Index, exp: Experiment, pos: Pos = {}, places: Place[] = [], bounds = { x0: 0, y0: 0, x1: 1, y1: 1 };
let day = 1, t = 0, playing = true, speed = 5, skip = true, settleUntil = 0, ended = false;
let idx = new Map<string, ExperimentDay>(), roster: string[] = [], walks: { start: number; end: number }[] = [];
let selected: string | null = null, following: string | null = null, frames: (AntFrame & { sx?: number; sy?: number })[] = [];
let focusPlace = NEST, preparedFor = 0;
const cam = { x: 0, y: 0, s: 4 };
const stats = { frames: 0, intervals: [] as number[], lastTs: 0 };
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
  ui.layersBtn.onclick = () => { ui.layers.hidden = !ui.layers.hidden; ui.layersBtn.setAttribute('aria-expanded', String(!ui.layers.hidden)); };
  ui.lChips.onchange = () => { ui.counts.hidden = ui.weather.hidden = !ui.lChips.checked; };
  ui.fit.onclick = () => { following = null; fitCamera(); R.warm(camera()); renderCard(); };
  ui.home.onclick = () => { following = null; homeCamera(); R.warm(camera()); renderCard(); };
  // jump to 3 simulated seconds before the next RECORDED walk start (nothing is skipped inside a walk)
  ui.nextWalk.onclick = () => { const d = exp.days[day - 1], n = walks.find((w) => w.start > t + 3 / 60 + 1e-9); if (n && n.start < windowOf(d)) { t = Math.max(t, n.start - 3 / 60); jumped(); } else toast('今日之後沒有紀錄的行走', performance.now()); };
  setupPointer();
  window.addEventListener('resize', resize); resize();
  // the bars can re-wrap after fonts / options load: keep their measured heights current
  new ResizeObserver(() => { bottomBarPx = $('bottom').getBoundingClientRect().height; topBarPx = $('top').getBoundingClientRect().height; }).observe(document.body);
  for (const id of ['top', 'bottom']) new ResizeObserver(() => { bottomBarPx = $('bottom').getBoundingClientRect().height; topBarPx = $('top').getBoundingClientRect().height; }).observe($(id));
  await openWorld(index.experiments[0].file);
  requestAnimationFrame(loop);
}

async function openWorld(file: string) {
  const e = assertKind(await load<Experiment>(file), 'experiment', file);
  exp = e; places = e.map.places; pos = displayPositions(places); bounds = gardenBounds(pos);
  R.setScene({ seed: hash32(e.spec.id), places, pos, routes: recordedRoutes(e, pos), sources: stateAt(e, 1, 0).sources, weather: e.days[0].weather, light: SCHEMATIC_LIGHT });
  ui.badge.textContent = `實驗世界・非正式｜重播引擎紀錄（${e.spec.founding}、${e.spec.season === 'autumn' ? '秋季' : e.spec.season}、種子 ${e.spec.seed}、${e.days.length} 日）｜引擎 ${e.engine_version}`;
  selected = null; following = null; ended = false;
  // opening: the first day with recorded walking, at its busiest walking window (engine record), framing the nest
  // and the food site those walks go to
  let open: { t: number; walkStart: number; focus: string } | null = null, openDay = 1;
  for (let k = 0; k < e.days.length && !open; k++) { open = openingMoment(e.days[k], pos); openDay = k + 1; }
  gotoDay(open ? openDay : 1);
  if (open) { t = open.t; focusPlace = open.focus; }
  homeCamera(); R.warm(camera()); renderCard(); renderAbout(); // bake the opening view before the first frame
}

function gotoDay(n: number) {
  if (!exp) return;
  day = Math.max(1, Math.min(exp.days.length, n)); t = 0; settleUntil = 0; ended = false;
  const d = exp.days[day - 1]; idx = buildDayIndex(d); walks = walkIntervals(d); roster = rosterAtStart(exp, day);
  R.setEngineState(stateAt(exp, day, 0).sources, d.weather); resetMicro();
  ui.clock.max = String(windowOf(d)); jumped();
}
// ------------------------------------------------------------------ display micro-motion context (engine data only)
/** actions whose record says the ant is searching / exploring (no known route) */
const EXPLORING = new Set(['search', 'explore_depart', 'explore_return']);
/** distance (cm) within which a recorded place counts as "near" for antenna probing (示意) */
const NEAR_CM = 2.5;
let ctxCache = new Map<string, ContextSampler>();
/** Context of one ant at display time τ (simulated seconds of the current day), from the engine record only: moving
 *  (model.poseAt), the recorded edge / site heading, nearness to the recorded places of its edge, searching action. */
function rawSample(id: string, tauS: number): RawSample {
  const d = exp.days[day - 1], f = antFrame(idx, d, id, Math.max(0, Math.min(windowOf(d), tauS / 60)), pos);
  const heading = f.vis === 'walking' && f.heading !== null ? -f.heading : siteSlot(id).heading;
  let near = 0;
  if (f.vis === 'at_site') near = 1;
  else if (f.vis === 'walking') { const dist = Math.min(...f.place.split('>').map((p) => pos[p]?.known ? Math.hypot(pos[p].x - f.x, pos[p].y - f.y) : Infinity)); near = Math.max(0, Math.min(1, 1 - dist / NEAR_CM)); }
  return { moving: f.moving ? 1 : 0, heading, near, explore: EXPLORING.has(f.action) ? 1 : 0 };
}
const contextOf = (id: string): ContextSampler => { let c = ctxCache.get(id); if (!c) { c = smoothedContext((tau) => rawSample(id, tau)); ctxCache.set(id, c); } return c; };
/** new day / world: the context data changed, so drop the samplers and the micro-motion memo */
function resetMicro() { ctxCache = new Map(); R.resetMicro(); }

/** a time jump resets the drawing-only motion state (heading ease, leg phase) so nothing is animated across it */
const jumped = () => R.resetMotion();

/** Opening view: a macro view around the nest entrance, nudged toward the food site the opening walks go to, so the
 *  workers leaving and arriving are seen close up. The field adapts to the screen: its short side shows MACRO_CM. */
const MACRO_CM = 24;
function homeCamera() {
  const a = pos[NEST], b = pos[focusPlace]?.known ? pos[focusPlace] : a;
  if (!a) return;
  const k = Math.min(0.3, 6 / Math.max(1e-9, Math.hypot(b.x - a.x, b.y - a.y)));
  cam.x = a.x + (b.x - a.x) * k; cam.y = a.y + (b.y - a.y) * k;
  cam.s = Math.min(canvas.clientWidth, canvas.clientHeight - bottomBarPx - 60) / MACRO_CM;
}
function fitCamera() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  cam.x = (bounds.x0 + bounds.x1) / 2; cam.y = (bounds.y0 + bounds.y1) / 2;
  cam.s = Math.min(w / (bounds.x1 - bounds.x0), h / (bounds.y1 - bounds.y0));
}
let bottomBarPx = 0, topBarPx = 0;
function resize() { R.resize(); bottomBarPx = $('bottom').getBoundingClientRect().height; topBarPx = $('top').getBoundingClientRect().height; if (exp && !following) homeCamera(); }
const S2W = (sx: number, sy: number) => [cam.x + (sx - canvas.clientWidth / 2) / cam.s, cam.y - (sy - canvas.clientHeight / 2) / cam.s] as const;
const camera = (): Camera => ({ cx: cam.x, cy: cam.y, s: cam.s, w: canvas.clientWidth, h: canvas.clientHeight });

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
  // drawing caches for the next day (engine-object sprites, light overlay) are prepared ahead of the day change
  if (preparedFor !== day && t > win * 0.6 && day < exp.days.length) { preparedFor = day; R.prepare(stateAt(exp, day + 1, 0).sources, exp.days[day].weather); }
  if (t >= win) {
    t = win; const s = settlementSummary(d);
    bannerText = `第 ${d.day} 日活動時段結束・日終結算（引擎沒有記錄這些事件的時刻）：工蟻死亡 ${s.deaths}、羽化 ${s.eclosions}、產卵 ${s.eggs}`;
    settleUntil = now + 2600;
  }
}

// ------------------------------------------------------------------ drawing
function drawFrame(dtReal: number, frameMs: number | null) {
  const d = exp.days[day - 1], c = camera(), L = antLengthPx(cam.s, minAntPx());
  frames = roster.map((id) => antFrame(idx, d, id, t, pos));
  const inputs: AntInput[] = frames.map((f) => {
    let off: AntInput['displayOffset'];
    if (f.vis === 'walking' && f.heading !== null) { const o = laneOffset(f.id) * L * 0.55, h = -f.heading; off = { dx: -Math.sin(h) * o, dy: Math.cos(h) * o }; }
    else { const s = siteSlot(f.id), k = Math.min(1.4, L / 26); off = { dx: s.dx * k, dy: s.dy * k, heading: s.heading }; }
    return { id: f.id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: off }; // no ω: the replay records none
  });
  const draws = R.frame(c, inputs, dtReal, frameMs, { uiBottom: bottomBarPx + 6, displayTurns: true, colourVariants: true, highlightEngine: ui.lEngine.checked, labels: ui.lLabels.checked, showRoutes: ui.lRoutes.checked, minAntPx: minAntPx(),
    micro: { tauS: t * 60, damp: playbackDamp(speed), context: contextOf } });
  const at = new Map(draws.map((x) => [x.id, x]));
  // screen position of ants the player can actually see (inside the canvas, not under the top / bottom bars)
  const onScreen = (x: number, y: number) => x >= 0 && x <= c.w && y >= topBarPx && y <= c.h - bottomBarPx;
  for (const f of frames) { const dr = at.get(f.id); f.sx = dr && onScreen(dr.sx, dr.sy) ? dr.sx : undefined; f.sy = f.sx !== undefined && dr ? dr.sy : undefined; }
  // selection ring and optional ant IDs (玩家視角 overlays)
  const g = R.g;
  const sel = selected ? at.get(selected) : undefined;
  if (sel) { g.strokeStyle = '#ffe08a'; g.lineWidth = 2; g.beginPath(); g.arc(sel.sx, sel.sy, L * 0.62, 0, Math.PI * 2); g.stroke(); }
  if (ui.lIds.checked) { g.font = '11px system-ui'; g.fillStyle = '#fff6dc'; for (const dr of draws) g.fillText(dr.id, dr.sx + L * 0.5, dr.sy - L * 0.4); }
}

const hudCache: Record<string, string> = {};
const setText = (k: string, el: HTMLElement, v: string) => { if (hudCache[k] !== v) { hudCache[k] = v; el.textContent = v; } };
function drawHud(now: number) {
  const d = exp.days[day - 1], win = windowOf(d), mm = Math.floor(t), ss = Math.floor((t - mm) * 60);
  const w = R.weatherDay();
  setText('time', ui.time, `第 ${d.day} 日（${d.date}）・活動時段 ${mm} 分 ${String(ss).padStart(2, '0')} 秒／${win} 分・${w.wet ? '地面潮濕（日值）' : d.weather.rain_mm > 0 ? '雨天（日值）' : '無雨（日值）'}`);
  if (document.activeElement !== ui.clock && Math.abs(Number(ui.clock.value) - t) > 0.05) ui.clock.value = String(t);
  const c = { walking: 0, at_site: 0, in_nest: 0, unknown_place: 0 }; for (const f of frames) c[f.vis]++;
  setText('counts', ui.counts, `在外 ${c.walking + c.at_site}・巢內 ${c.in_nest}${c.unknown_place ? `・在未記錄位置 ${c.unknown_place}` : ''}`);
  setText('weather', ui.weather, `氣溫 ${d.weather.air_temp_c.toFixed(1)}°C・巢溫 ${d.weather.nest_temp_c.toFixed(1)}°C・${w.label}・光源：示意固定`);
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
<li><b>引擎紀錄</b>：每隻螞蟻在每個時刻的所在地點、出發與抵達的分鐘、行動（出巢、搜尋、採集、回巢、卸貨、休息）與當日任務，來自 <code>web/data/${ui.world.value}</code>（引擎 ${exp.engine_version}）。食源上的半翅目群數（每群畫一簇）、寄主是否存活、天氣日值也是引擎紀錄。開場的日子與時刻取自紀錄中行走最密集的時段。</li>
<li><b>顯示插值</b>：螞蟻在兩個紀錄點之間沿直線前進的位置；同一路段同時出發的螞蟻左右錯開；停在同一地點的螞蟻圍成一圈排列；轉身與腳的擺動（步伐由移動距離驅動；轉向動作只在紀錄的路段方向改變時出現，是顯示插值，不是物理結果）。這些只為畫面，不寫回、不產生事件。</li>
<li><b>顯示動畫（示意）</b>：頭部小幅左右轉動、左右觸角各自的探索動作（掃動、向前探、點地、休息）與走↔停的步態過渡，依螞蟻 ID 的種子與模擬時間決定（可重播），只參考引擎紀錄的「是否在走、路段方向、是否接近紀錄地點、是否在搜尋」。<b>不是感覺事件</b>：畫面上的觸角位置不代表螞蟻聞到或碰到什麼，也不改變任何位置、方向、時間或事件；身體路徑仍是紀錄點之間的直線。播放倍速越高，微動作越弱（避免閃爍）。</li>
<li><b>示意場景</b>：土壤、落葉、石子、草、苔、植物與花的外觀與分布是以種子產生的裝飾（避開地點與紀錄路段），不是任何實際花園的測量。地點位置由「方位＋約距離」推得，非測量。光源是固定的示意光源（重播資料沒有時刻，不畫日夜）；天氣只顯示當日狀態（地面潮濕、陰天），不畫雨滴。螞蟻外形依物種鑑定特徵（12 節膝狀觸角含 3 節棍棒、兩節腹柄、並胸腹節刺；頭與柄節比例取自 Sarnat et al. 2015）；體色在文獻記載的淺褐至深褐範圍內依個體 ID 取固定變化（示意，不是個體實測）；不畫大工蟻（引擎未記錄階級），也不畫搬運姿勢（引擎沒有搬運紀錄）。螞蟻<b>放大顯示</b>（畫面左下角的 ×N；小工蟻約 2.5 mm）。</li>
<li><b>沒有畫出的</b>：巢內的活動（只計數）；位置未記錄地點的螞蟻；沒有時刻的日終結算（死亡、羽化、產卵只在橫幅顯示）。不會出現引擎沒有記錄的覓食、交哺、攻擊或死亡。</li>
<li><b>圖層</b>：「圖層」選單可打開引擎物件標示、地點代號、紀錄路段、螞蟻 ID、狀態列（玩家視角，螞蟻不知道這些）。</li>
<li><b>時間</b>：引擎目前以每日 360 分鐘活動時段簡化一天（不是 24 小時）。播放速度以實際時間倍數表示；「快轉」只跳過沒有螞蟻在外行走的時段，不改變任何紀錄。</li>
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
  const ns = Math.max(fitS * 0.6, Math.min(400, cam.s * k)); const [wx, wy] = S2W(sx, sy); cam.s = ns;
  if (!following) { const [nx, ny] = S2W(sx, sy); cam.x += wx - nx; cam.y += wy - ny; }
}
function pick(sx: number, sy: number) {
  let best: string | null = null, bd = Math.max(22, antLengthPx(cam.s, minAntPx()) * 0.7);
  for (const f of frames) if (f.sx !== undefined && (f.vis === 'walking' || f.vis === 'at_site')) { const dd = Math.hypot(f.sx - sx, (f.sy as number) - sy); if (dd < bd) { bd = dd; best = f.id; } }
  selected = best; if (!best) following = null; renderCard();
}

// ------------------------------------------------------------------ loop
function loop(now: number) {
  const dt = stats.lastTs ? Math.min(0.1, (now - stats.lastTs) / 1000) : 0, fms = stats.lastTs ? now - stats.lastTs : null;
  if (fms !== null) { stats.intervals.push(fms); if (stats.intervals.length > 600) stats.intervals.shift(); }
  stats.lastTs = now; stats.frames++;
  if (exp) {
    if (playing && !ended) advance(dt, now);
    if (following) { const f = frames.find((x) => x.id === following); if (f && (f.vis === 'walking' || f.vis === 'at_site')) { cam.x += (f.x - cam.x) * Math.min(1, dt * 6); cam.y += (f.y - cam.y) * Math.min(1, dt * 6); } }
    drawFrame(dt, fms); drawHud(now);
    const key = `${selected}|${following}|${frames.find((x) => x.id === selected)?.action}|${frames.find((x) => x.id === selected)?.place}|${day}`; if (key !== cardKey) { cardKey = key; renderCard(); }
  }
  requestAnimationFrame(loop);
}

/** Read-only hooks for the browser tests and the FPS measurement (nothing here can change the replay data). */
(window as unknown as { __game: unknown }).__game = {
  state: () => { const q = R.quality(); return { world: ui.world.value, day, t, playing, speed, skip, selected, following, ended, cam: { ...cam }, low_res: q.dprCap === 1 && (window.devicePixelRatio || 1) > 1, quality: q.level, canvas_px: [canvas.width, canvas.height], min_ant_px: minAntPx(), focus: focusPlace }; },
  ants: () => frames.map((f) => ({ id: f.id, vis: f.vis, moving: f.moving, x: f.x, y: f.y, sx: f.sx ?? null, sy: f.sy ?? null, place: f.place, action: f.action })),
  engineObjects: () => R.engineObjects().map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, source: o.source })),
  layers: () => [...R.trace],
  /** display micro-motion of the last frame (示意 display animation; read only) */
  micro: () => ({ detail: R.detailUsed(), ants: [...R.lastMicro()].map(([id, m]) => ({ id, headYaw: m.headYaw, L: { ...m.L }, R: { ...m.R } })) }),
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length; return { frames: stats.frames, samples: n, mean_ms: n ? iv.reduce((s, x) => s + x, 0) / n : null, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null, fps_mean: n ? 1000 / (iv.reduce((s, x) => s + x, 0) / n) : null }; },
  resetFps: () => { stats.intervals = []; stats.frames = 0; },
  gotoDay: (n: number) => gotoDay(n),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
