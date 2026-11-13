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
import { JUMP_HINT, dayRecordSummary, daySummary, jumpNote, minuteAtFraction, nextActivityJump, summaryHtml, timelineMarks } from './replay-ux.ts';
import { antFrame, anyWalking, walkIntervals, buildDayIndex, gardenBounds, hash32, laneOffset, nextWalkStart, openingMoment, rosterAtStart, settlementSummary, simMinutesPerRealSecond, siteSlot, SPEEDS, type AntFrame, type Pos } from './game-model.ts';
import { LayeredRenderer } from './render-canvas.ts';
import { antLengthPx, recordedRoutes, type AntInput, type Camera } from './render-scene.ts';
import { SCHEMATIC_LIGHT } from './art-core.ts';
import { playbackDamp, smoothedContext, type ContextSampler, type RawSample } from './display-motion.ts';
import { antPxAt, closeUpCapPx, maxScaleFor, type AntScale } from './zoom-scale.ts';

interface Index { official: string; experiments: { id: string; file: string; title: string }[] }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('scene');
const ui = { world: $<HTMLSelectElement>('world'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), skip: $<HTMLInputElement>('skip'), time: $('time'), clock: $<HTMLInputElement>('clock'), prevDay: $<HTMLButtonElement>('prevDay'), nextDay: $<HTMLButtonElement>('nextDay'), card: $('card'), banner: $('banner'), toast: $('toast'), counts: $('counts'), weather: $('weather'), info: $<HTMLButtonElement>('infoBtn'), about: $('about'), fit: $<HTMLButtonElement>('fit'), badge: $('badge'), layersBtn: $<HTMLButtonElement>('layersBtn'), layers: $('layers'), lEngine: $<HTMLInputElement>('layerEngine'), lLabels: $<HTMLInputElement>('layerLabels'), lRoutes: $<HTMLInputElement>('layerRoutes'), lIds: $<HTMLInputElement>('layerIds'), lChips: $<HTMLInputElement>('layerChips'), home: $<HTMLButtonElement>('homeBtn') };

/** drawn ant length (CSS px) at the home view, derived from the screen (8% of its short side, at least 36 px): ants are
 *  magnified to stay readable and the renderer labels the factor (放大顯示 ×N) */
const homeAntPx = () => Math.max(36, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.08));
/** the magnification is fixed at the home view and kept while zooming, so ants scale with the map (zoom-scale.ts) */
let antScale: AntScale | null = null;
const minAntPx = () => (antScale ? antPxAt(antScale, cam.s) : homeAntPx());
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
  setupPointer(); setupReplayUx(); setupMoreMenu();
  window.addEventListener('resize', resize); resize();
  // the bars can re-wrap after fonts / options load: keep their measured heights current
  const barsChanged = () => {
    const b = $('bottom').getBoundingClientRect().height, tp = $('top').getBoundingClientRect().height;
    if (b === bottomBarPx && tp === topBarPx) return;
    bottomBarPx = b; topBarPx = tp; barVars(); if (exp && homeView && !following) { homeCamera(); R.warm(camera()); } // keep the opening framed above the controls
  };
  new ResizeObserver(barsChanged).observe(document.body);
  for (const id of ['top', 'bottom']) new ResizeObserver(barsChanged).observe($(id));
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
  ui.clock.max = String(windowOf(d)); jumped(); replayDayChanged();
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
 *  workers leaving and arriving are seen close up. The field adapts to the UNOBSCURED part of the canvas (between the
 *  top bar and the bottom control panel): its short side shows MACRO_CM and the framed point sits at its centre, so the
 *  nest and the opening walks are not hidden under the controls (drawing only; camera, not data). */
const MACRO_CM = 24;
/** the camera still shows the home view (no pan / zoom / fit / follow since): bar re-wraps then re-frame it */
let homeView = false;
const visibleBand = () => { const h = canvas.clientHeight, top = Math.min(topBarPx, h), bottom = Math.max(top + 1, h - bottomBarPx); return { top, bottom }; };
function homeCamera() {
  const a = pos[NEST], b = pos[focusPlace]?.known ? pos[focusPlace] : a;
  if (!a) return;
  const k = Math.min(0.3, 6 / Math.max(1e-9, Math.hypot(b.x - a.x, b.y - a.y))), v = visibleBand(), h = canvas.clientHeight;
  cam.s = Math.max(1e-6, Math.min(canvas.clientWidth, v.bottom - v.top)) / MACRO_CM;
  cam.x = a.x + (b.x - a.x) * k;
  cam.y = a.y + (b.y - a.y) * k - (h / 2 - (v.top + v.bottom) / 2) / cam.s; // framed point at the centre of the unobscured band
  antScale = { homeS: cam.s, homePx: homeAntPx() };
  homeView = true;
}
function fitCamera() {
  homeView = false;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  cam.x = (bounds.x0 + bounds.x1) / 2; cam.y = (bounds.y0 + bounds.y1) / 2;
  cam.s = Math.min(w / (bounds.x1 - bounds.x0), h / (bounds.y1 - bounds.y0));
}
let bottomBarPx = 0, topBarPx = 0;
function resize() { R.resize(); bottomBarPx = $('bottom').getBoundingClientRect().height; topBarPx = $('top').getBoundingClientRect().height; barVars(); if (exp && !following) homeCamera(); }
/** bar heights as CSS variables, so the 更多 panel, the jump hint and the summary sit between the bars (layout only) */
function barVars() { const s = document.documentElement.style; s.setProperty('--bar-bottom', `${bottomBarPx}px`); s.setProperty('--bar-top', `${topBarPx}px`); }
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
    else { const s = siteSlot(f.id), k = L / 26; /* the ring at a site scales with the ants */ off = { dx: s.dx * k, dy: s.dy * k, heading: s.heading }; }
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
/** a toast; with `tag`, a highlighted label (e.g. 「跳轉（非連續播放）」) precedes the message */
function toast(msg: string, now: number, tag?: string, ms = 1800) {
  if (tag) { const b = document.createElement('b'); b.className = 'jump-label'; b.textContent = tag; ui.toast.replaceChildren(b, document.createTextNode(msg)); }
  else ui.toast.textContent = msg;
  toastUntil = now + ms;
}
function syncButtons() { ui.play.textContent = ended ? '重新播放' : playing ? '暫停' : '播放'; ui.play.setAttribute('aria-pressed', String(playing)); }

function renderCard() {
  if (!selected || !exp) { ui.card.hidden = true; return; }
  const d = exp.days[day - 1], f = frames.find((x) => x.id === selected), task = d.tasks?.[selected];
  if (!f) { ui.card.hidden = true; return; }
  const where = f.vis === 'walking' ? `行走中 ${f.place.replace('>', ' → ')}（畫面位置＝兩個引擎紀錄點之間的插值）` : f.vis === 'at_site' ? `在 ${f.place}（引擎紀錄點）` : f.vis === 'in_nest' ? '在巢內（地表看不到）' : `在位置未記錄的地點 ${f.place}（不畫在花園上）`;
  ui.card.hidden = false;
  ui.card.innerHTML = `<b>${selected}</b>　<span class="muted">熱帶大頭家蟻・小工蟻（引擎尚未模擬大工蟻）</span><br>現在：${ACTION_LABEL[f.action] ?? f.action}${f.segStart !== null ? `（本段 ${f.segStart.toFixed(1)}–${(f.segEnd as number).toFixed(1)} 分，引擎紀錄）` : ''}<br>位置：${where}<br>今日紀錄任務：${task ? `${TASK_LABEL[task.task] ?? task.task}；出巢 ${task.trips} 趟、成功 ${task.successes}` : '—'}<div class="row"><button id="followBtn" type="button">${following === selected ? '取消追蹤' : '鏡頭追蹤'}</button><a href="analysis.html">在分析模式查看完整紀錄</a><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
  $('followBtn').onclick = () => { following = following === selected ? null : selected; homeView = false; renderCard(); };
  $('closeCard').onclick = () => { selected = null; following = null; renderCard(); };
}
let cardKey = '';

function renderAbout() {
  ui.about.innerHTML = `<button type="button" class="about-close touch" id="aboutClose">關閉</button><h2>畫面上的東西從哪裡來</h2><ul>
<li><b>引擎紀錄</b>：每隻螞蟻在每個時刻的所在地點、出發與抵達的分鐘、行動（出巢、搜尋、採集、回巢、卸貨、休息）與當日任務，來自 <code>web/data/${ui.world.value}</code>（引擎 ${exp.engine_version}）。食源上的半翅目群數（每群畫一簇）、寄主是否存活、天氣日值也是引擎紀錄。開場的日子與時刻取自紀錄中行走最密集的時段。</li>
<li><b>顯示插值</b>：螞蟻在兩個紀錄點之間沿直線前進的位置；同一路段同時出發的螞蟻左右錯開；停在同一地點的螞蟻圍成一圈排列；轉身與腳的擺動（步伐由移動距離驅動；轉向動作只在紀錄的路段方向改變時出現，是顯示插值，不是物理結果）。這些只為畫面，不寫回、不產生事件。</li>
<li><b>顯示動畫（示意）</b>：頭部小幅左右轉動、左右觸角各自的探索動作（掃動、向前探、點地、休息）與走↔停的步態過渡，依螞蟻 ID 的種子與模擬時間決定（可重播），只參考引擎紀錄的「是否在走、路段方向、是否接近紀錄地點、是否在搜尋」。<b>不是感覺事件</b>：畫面上的觸角位置不代表螞蟻聞到或碰到什麼，也不改變任何位置、方向、時間或事件；身體路徑仍是紀錄點之間的直線。播放倍速越高，微動作越弱（避免閃爍）。</li>
<li><b>示意場景</b>：土壤、落葉、石子、草、苔、植物與花的外觀與分布是以種子產生的裝飾（避開地點與紀錄路段），不是任何實際花園的測量。地點位置由「方位＋約距離」推得，非測量。光源是固定的示意光源（重播資料沒有時刻，不畫日夜）；天氣只顯示當日狀態（地面潮濕、陰天），不畫雨滴。螞蟻外形依物種鑑定特徵（兩節腹柄、並胸腹節刺；頭與柄節比例取自 Sarnat et al. 2015）；觸角畫成 12 節膝狀、末 3 節棍棒，這是屬特徵的描述，repo 尚無可取得的引用（<b>待核對</b>，見 docs/game-art-style.md）；體色在文獻記載的淺褐至深褐範圍內依個體 ID 取固定變化（示意，不是個體實測）；不畫大工蟻（引擎未記錄階級），也不畫搬運姿勢（引擎沒有搬運紀錄）。螞蟻<b>放大顯示</b>（畫面左下角的 ×N；小工蟻約 2.5 mm）。</li>
<li><b>沒有畫出的</b>：巢內的活動（只計數）；位置未記錄地點的螞蟻；沒有時刻的日終結算（死亡、羽化、產卵只在橫幅顯示）。不會出現引擎沒有記錄的覓食、交哺、攻擊或死亡。</li>
<li><b>圖層</b>：「圖層」選單可打開引擎物件標示、地點代號、紀錄路段、螞蟻 ID、狀態列（玩家視角，螞蟻不知道這些）。</li>
<li><b>時間</b>：引擎目前以每日 360 分鐘活動時段簡化一天（不是 24 小時）。播放速度以實際時間倍數表示；「快轉」只跳過沒有螞蟻在外行走的時段，不改變任何紀錄。</li>
<li><b>跳轉與日摘要</b>：時間軸下方的標記是引擎紀錄的行走時段（worker_activity）。「下一段活動」（快捷鍵 N）是<b>跳轉</b>，不是連續播放：第 1 次按停在下一段紀錄的行走開始前約 3 秒，再按到行走開始的那一刻，再按到下一段行走前約 3 秒；正在行走時也可以跳，畫面會標示「跳轉」與略過的時間、沒有連續播完的行走段數。不跳過任何行走的開始，只改變觀看的時刻。「日摘要」（快捷鍵 S）不是連續播放：列出引擎紀錄的人口、死亡與出生、覓食、存量變化與個體任務，每個數字都標明來源欄位，紀錄中沒有的量顯示「引擎未記錄」；有分鐘紀錄的事件列出紀錄的時刻，沒有分鐘紀錄的事件只列為日層級，不放在任何時間點；回到連續播放時恢復原本的觀看位置。快捷鍵在輸入框或選單有焦點時不作用，也不使用 Ctrl／Cmd 組合鍵。</li>
<li><b>窄螢幕</b>：控制列只保留播放、速度、下一段活動、日摘要、「更多」與時間軸；標籤、全景、巢口近景、換日與其他控制收在「更多」裡。</li>
<li><b>這是非正式的實驗世界</b>，不是正式 Day14 遊戲；觀察者只觀察，不干預。</li></ul>`;
  $('aboutClose').onclick = () => { ui.about.hidden = true; ui.info.setAttribute('aria-expanded', 'false'); };
}

// ------------------------------------------------------------------ input
function setupPointer() {
  const pts = new Map<number, { x: number; y: number }>(); let downAt = { x: 0, y: 0, t: 0 }, pinch0 = 0, s0 = 1;
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.offsetX, y: e.offsetY }); downAt = { x: e.offsetX, y: e.offsetY, t: performance.now() }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); s0 = cam.s; } });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    if (pts.size === 1) { const dx = e.offsetX - p.x, dy = e.offsetY - p.y; if (Math.hypot(e.offsetX - downAt.x, e.offsetY - downAt.y) > 4) { following = null; homeView = false; cam.x -= dx / cam.s; cam.y += dy / cam.s; } }
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
  homeView = false;
  const fitS = Math.min(canvas.clientWidth / (bounds.x1 - bounds.x0), canvas.clientHeight / (bounds.y1 - bounds.y0));
  const maxS = antScale ? Math.min(400, maxScaleFor(antScale, closeUpCapPx(canvas.clientWidth, canvas.clientHeight, antScale.homePx))) : 400;
  const ns = Math.max(Math.min(fitS * 0.6, maxS), Math.min(maxS, cam.s * k)); const [wx, wy] = S2W(sx, sy); cam.s = ns;
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
  // day-summary mode (日摘要，非連續播放) does not advance time and does not render the canvas
  if (exp && !replay.summary) {
    if (playing && !ended) advance(dt, now);
    if (following) { const f = frames.find((x) => x.id === following); if (f && (f.vis === 'walking' || f.vis === 'at_site')) { cam.x += (f.x - cam.x) * Math.min(1, dt * 6); cam.y += (f.y - cam.y) * Math.min(1, dt * 6); } }
    drawFrame(dt, fms); drawHud(now);
    const key = `${selected}|${following}|${frames.find((x) => x.id === selected)?.action}|${frames.find((x) => x.id === selected)?.place}|${day}`; if (key !== cardKey) { cardKey = key; renderCard(); }
  }
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ replay navigation (Issue #148)
// Each control only changes the VIEWING position or the display mode; none creates an event or changes engine time.
const rx = { next: $<HTMLButtonElement>('nextAct'), mode: $<HTMLButtonElement>('modeBtn'), marks: $('marks'), summary: $('summary') };
const replay = { summary: false, saved: null as { day: number; t: number; playing: boolean } | null, lastJump: null as (ReturnType<typeof jumpNote> & { walkStart: number; target: number }) | null };
function jumpToNextActivity() {
  if (!exp || replay.summary) return;
  const d = exp.days[day - 1], r = nextActivityJump(walks, d, t), now = performance.now();
  if (r.kind === 'none') { toast(r.reason, now); return; }
  const gap = r.walkStart - r.target, note = jumpNote(walks, t, r), sk = Math.round(note.skippedMin * 60);
  t = r.target; settleUntil = 0; ended = false; jumped(); syncButtons();
  replay.lastJump = { ...note, walkStart: r.walkStart, target: r.target };
  const skipped = `略過觀看時間 ${Math.floor(sk / 60)} 分 ${sk % 60} 秒`, cut = note.inProgress ? `；此刻進行中的 ${note.inProgress} 段行走沒有連續播完` : '';
  const step = note.stage === 'lead' ? '（停在開始前約 3 秒；再按到開始那一刻）' : '（到行走開始的那一刻；再按到下一段行走前）';
  toast(`下一段活動：引擎紀錄的行走${gap > 1e-9 ? `在 ${Math.round(gap * 60)} 秒後` : '在此刻'}開始（${r.walksStarting} 段）${step}；${skipped}${cut}`, now, '跳轉（非連續播放）', 3200);
  showJumpHintOnce();
}
// Q1 (Issue #191): the first explicit jump of this page view shows how the three landing steps work (inline hint; the
// button tooltip says the same). Kept in memory only: the game view writes no browser storage.
let hintTimer = 0, hintShown = false;
function showJumpHintOnce() {
  if (hintShown) return;
  hintShown = true;
  $('jumpHintText').textContent = JUMP_HINT; $('jumpHint').hidden = false;
  clearTimeout(hintTimer); hintTimer = window.setTimeout(() => { $('jumpHint').hidden = true; }, 15000);
}
function renderMarks() {
  const d = exp.days[day - 1];
  rx.marks.innerHTML = timelineMarks(walks, windowOf(d)).map((m) => `<i style="left:${(m.left * 100).toFixed(4)}%;width:${(m.width * 100).toFixed(4)}%" data-start="${m.start}" data-end="${m.end}"></i>`).join('');
  rx.marks.title = `引擎紀錄的行走時段（worker_activity）：第 ${d.day} 日 ${walks.length} 段；點選或拖曳可跳到該時刻`;
}
function renderSummary() { rx.summary.innerHTML = summaryHtml(daySummary(exp.days[day - 1], walks), 30, dayRecordSummary(exp, day, ui.world.value)); }
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
  placeMore();
}
/** Keyboard shortcuts N (next activity) and S (day summary, Issue #191 Q3): single letters with no Ctrl / Cmd / Alt
 *  combination (no clash with browser shortcuts), ignored while a form control (input, select, textarea, editable
 *  text) has focus or during IME composition; Esc closes the 更多 panel and the hint. */
function setupReplayUx() {
  rx.next.onclick = jumpToNextActivity;
  rx.mode.onclick = () => setMode(!replay.summary);
  $('jumpHintClose').onclick = () => { $('jumpHint').hidden = true; };
  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement | null, tag = el?.tagName;
    if (e.key === 'Escape') { setMoreOpen(false); $('jumpHint').hidden = true; return; }
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); jumpToNextActivity(); }
    else if ((e.key === 's' || e.key === 'S') && !e.repeat) { e.preventDefault(); setMode(!replay.summary); }
  });
  // tap or drag on the marks strip scrubs the viewing minute (touch and mouse); display only
  let scrubbing = false;
  const seek = (e: PointerEvent) => { const r = rx.marks.getBoundingClientRect(); t = minuteAtFraction((e.clientX - r.left) / r.width, windowOf(exp.days[day - 1])); settleUntil = 0; ended = false; jumped(); };
  rx.marks.addEventListener('pointerdown', (e) => { if (!exp || replay.summary) return; scrubbing = true; rx.marks.setPointerCapture(e.pointerId); seek(e); });
  rx.marks.addEventListener('pointermove', (e) => { if (scrubbing) seek(e); });
  const end = () => { scrubbing = false; }; rx.marks.addEventListener('pointerup', end); rx.marks.addEventListener('pointercancel', end);
}

// ------------------------------------------------------------------ narrow-screen 更多 panel (Issue #191 Q5)
// On narrow screens the [data-more] controls (labels, panorama, home, world / layers / info / analysis, and day stepping
// during playback) are moved into the 更多 panel, so the bars keep only the core controls and cover less of the garden.
// The same nodes are moved back on wide screens (ids and handlers unchanged). Layout only: nothing reads or writes data.
const narrowMq = window.matchMedia('(max-width: 600px)');
const moreUi = { btn: $<HTMLButtonElement>('moreBtn'), panel: $('morePanel'), items: $('moreItems') };
const moreNodes = [...document.querySelectorAll<HTMLElement>('[data-more]')].map((el) => { const ph = document.createComment(`more:${el.id || el.className}`); el.before(ph); return { el, ph, kind: el.dataset.more }; });
function placeMore() {
  const narrow = narrowMq.matches, inMenu = (k: string | undefined) => narrow && (k === 'always' || (k === 'playback' && !replay.summary));
  for (const m of moreNodes) if (!inMenu(m.kind) && m.ph.nextSibling !== m.el) m.ph.after(m.el);
  for (const m of moreNodes) if (inMenu(m.kind)) moreUi.items.append(m.el); // in document order
  if (!narrow) setMoreOpen(false);
}
function setMoreOpen(open: boolean) {
  if (moreUi.panel.hidden === !open) return;
  moreUi.panel.hidden = !open; moreUi.btn.setAttribute('aria-expanded', String(open)); moreUi.btn.textContent = open ? '收合' : '更多';
}
function setupMoreMenu() {
  placeMore(); narrowMq.addEventListener('change', placeMore);
  moreUi.btn.onclick = () => setMoreOpen(moreUi.panel.hidden);
  // choosing a panel / view / page from the menu closes it (day stepping and toggles keep it open)
  moreUi.items.addEventListener('click', (e) => { const b = (e.target as HTMLElement).closest('button, a'); if (b && !['prevDay', 'nextDay'].includes(b.id)) setMoreOpen(false); });
  canvas.addEventListener('pointerdown', () => setMoreOpen(false));
}

/** Read-only hooks for the browser tests and the FPS measurement (nothing here can change the replay data). */
(window as unknown as { __game: unknown }).__game = {
  state: () => { const q = R.quality(); return { world: ui.world.value, day, t, playing, speed, skip, mode: replay.summary ? 'summary' : 'playback', selected, following, ended, cam: { ...cam }, low_res: q.dprCap === 1 && (window.devicePixelRatio || 1) > 1, quality: q.level, canvas_px: [canvas.width, canvas.height], min_ant_px: minAntPx(), focus: focusPlace }; },
  ants: () => frames.map((f) => ({ id: f.id, vis: f.vis, moving: f.moving, x: f.x, y: f.y, sx: f.sx ?? null, sy: f.sy ?? null, place: f.place, action: f.action })),
  /** unobscured canvas band (CSS px, between the bars) and the screen points of the nest and the opening focus site */
  view: () => { const v = visibleBand(), w = canvas.clientWidth, h = canvas.clientHeight, sc = (p: { x: number; y: number } | undefined) => (p ? [w / 2 + (p.x - cam.x) * cam.s, h / 2 - (p.y - cam.y) * cam.s] : null); return { w, h, top: v.top, bottom: v.bottom, home: homeView, nest: sc(pos[NEST]), focus: focusPlace, focus_xy: sc(pos[focusPlace]?.known ? pos[focusPlace] : undefined) }; },
  engineObjects: () => R.engineObjects().map((o) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, source: o.source })),
  layers: () => [...R.trace],
  /** display micro-motion of the last frame (示意 display animation; read only) */
  micro: () => ({ detail: R.detailUsed(), ants: [...R.lastMicro()].map(([id, m]) => ({ id, headYaw: m.headYaw, L: { ...m.L }, R: { ...m.R } })) }),
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length; return { frames: stats.frames, samples: n, mean_ms: n ? iv.reduce((s, x) => s + x, 0) / n : null, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null, fps_mean: n ? 1000 / (iv.reduce((s, x) => s + x, 0) / n) : null }; },
  resetFps: () => { stats.intervals = []; stats.frames = 0; },
  gotoDay: (n: number) => gotoDay(n),
  /** the last explicit jump (Issue #191 Q2) and the 更多 panel state (Q5) */
  lastJump: () => (replay.lastJump ? { ...replay.lastJump } : null),
  more: () => ({ narrow: narrowMq.matches, open: !moreUi.panel.hidden, items: moreNodes.filter((m) => m.el.parentElement === moreUi.items).map((m) => m.el.id || m.el.className) }),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
