/**
 * 《螞蟻帝國》read-only viewer (MVP). Draws ONLY what the exported files contain (web/data/*.json): the official
 * Day14 snapshot (static) and engine-generated experimental Day0 replays. It never runs the simulation, never
 * writes anything, and every position between two recorded points is a display interpolation (model.poseAt).
 */
import { ACTION_LABEL, NEST, REASON_LABEL, TASK_LABEL, describeEvent, displayPositions, eventsUntil, exploredEdges, poseAt, segmentsOf, stateAtStart, type Experiment, type Official, type Place, type Link } from './model.ts';

type Pos = Record<string, { x: number; y: number; known: boolean }>;
interface Index { official: string; experiments: { id: string; file: string; title: string }[] }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map'), ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const ui = { mode: $<HTMLSelectElement>('mode'), day: $<HTMLInputElement>('day'), minute: $<HTMLInputElement>('minute'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), time: $('timeLabel'), badge: $('badge'), info: $('info'), events: $('events'), nest: $('nest'), weather: $('weather'), view: $<HTMLSelectElement>('view'), ovTrail: $<HTMLInputElement>('ovTrail'), ovExplored: $<HTMLInputElement>('ovExplored'), ovFood: $<HTMLInputElement>('ovFood'), ovLabels: $<HTMLInputElement>('ovLabels'), timeline: $('timeline') };

/** Canvas colours come from the page's CSS tokens so both light and dark themes stay readable. */
const tok = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
let index: Index, official: Official | null = null, exp: Experiment | null = null, pos: Pos = {}, places: Place[] = [], links: Link[] = [];
let selected: string | null = null, playing = false, last = 0;
const cam = { x: 0, y: 0, scale: 3 };

async function load<T>(file: string): Promise<T> { const r = await fetch('data/' + file); if (!r.ok) throw Error('cannot load ' + file); return r.json() as Promise<T>; }

async function init() {
  index = await load<Index>('index.json');
  ui.mode.innerHTML = `<option value="official">正式遊戲 Day14（唯讀快照）</option>` + index.experiments.map((e) => `<option value="${e.id}">${e.title}</option>`).join('');
  ui.mode.onchange = () => switchMode(ui.mode.value);
  ui.day.oninput = () => { ui.minute.value = '0'; draw(); };
  ui.minute.oninput = () => draw();
  ui.play.onclick = () => { playing = !playing; ui.play.textContent = playing ? '暫停' : '播放'; last = performance.now(); if (playing) requestAnimationFrame(tick); };
  for (const el of [ui.ovTrail, ui.ovExplored, ui.ovFood, ui.ovLabels, ui.view]) el.onchange = () => draw();
  setupPanZoom();
  window.addEventListener('resize', () => { fit(); draw(); });
  await switchMode('official');
}

async function switchMode(id: string) {
  playing = false; ui.play.textContent = '播放'; selected = null;
  if (id === 'official') {
    official ??= await load<Official>(index.official); exp = null;
    places = official.map.places; links = official.map.links;
    ui.badge.className = 'badge official'; ui.badge.textContent = `正式遊戲 Day${official.day}（${official.calendar_date}）唯讀快照：沒有逐分鐘紀錄，因此不播放動畫`;
    ui.timeline.hidden = true;
  } else {
    const meta = index.experiments.find((e) => e.id === id) as Index['experiments'][number];
    exp = await load<Experiment>(meta.file); places = exp.map.places; links = exp.map.links;
    ui.badge.className = 'badge experiment'; ui.badge.textContent = `${meta.title}｜非正式、不寫入存檔｜引擎 ${exp.engine_version}`;
    ui.timeline.hidden = false; ui.day.min = '1'; ui.day.max = String(exp.days.length); ui.day.value = '1'; ui.minute.value = '0';
  }
  pos = displayPositions(places); fit(); draw();
}

function fit() {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
  const xs = Object.values(pos).map((p) => p.x), ys = Object.values(pos).map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs) + 40, h = Math.max(...ys) - Math.min(...ys) + 50;
  cam.scale = Math.min(r.width / w, r.height / h) * dpr; cam.x = (Math.max(...xs) + Math.min(...xs)) / 2; cam.y = (Math.max(...ys) + Math.min(...ys)) / 2 - 5;
}
const toScreen = (x: number, y: number) => ({ sx: canvas.width / 2 + (x - cam.x) * cam.scale, sy: canvas.height / 2 - (y - cam.y) * cam.scale });
/** Places without a recorded position sit in a screen-anchored tray (bottom-left), never on the map scale. */
function trayScreen(id: string) { const dpr = window.devicePixelRatio || 1, unknown = Object.entries(pos).filter(([, p]) => !p.known).map(([k]) => k).sort(), i = unknown.indexOf(id); return { sx: (28 + i * 70) * dpr, sy: canvas.height - 64 * dpr }; }
const screenOf = (id: string) => (pos[id]?.known === false ? trayScreen(id) : toScreen(pos[id].x, pos[id].y));
const toWorld = (sx: number, sy: number) => ({ x: (sx - canvas.width / 2) / cam.scale + cam.x, y: -(sy - canvas.height / 2) / cam.scale + cam.y });

function setupPanZoom() {
  const pts = new Map<number, { x: number; y: number }>(); let downAt: { x: number; y: number } | null = null, pinch0 = 0, scale0 = 1;
  canvas.onpointerdown = (e) => { canvas.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); downAt = { x: e.clientX, y: e.clientY }; if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); scale0 = cam.scale; } };
  canvas.onpointermove = (e) => {
    const p = pts.get(e.pointerId); if (!p) return; const dpr = window.devicePixelRatio || 1;
    if (pts.size === 1) { cam.x -= ((e.clientX - p.x) * dpr) / cam.scale; cam.y += ((e.clientY - p.y) * dpr) / cam.scale; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; cam.scale = scale0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0; }
    draw();
  };
  canvas.onpointerup = (e) => { const p = pts.get(e.pointerId); pts.delete(e.pointerId); if (p && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) pick(e); };
  canvas.onwheel = (e) => { e.preventDefault(); cam.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15; draw(); };
}

/** Ants to draw now: [id, x, y]. Official: every living worker at its recorded day-end place. Experiment: engine poses. */
function ants(): { id: string; x: number; y: number; interpolated: boolean; injured: boolean; trayAt?: string }[] {
  if (official && !exp) {
    const alive = official.workers.filter((w) => w.status === 'alive');
    return alive.map((w, i) => { const at = pos[w.location_at_day_end ?? NEST] ?? pos[NEST], a = (i / Math.max(1, alive.length)) * Math.PI * 2; return { id: w.id, x: at.x + Math.cos(a) * 4, y: at.y + Math.sin(a) * 4, interpolated: false, injured: !!w.injured_preexisting }; });
  }
  if (!exp) return [];
  const day = Number(ui.day.value), d = exp.days[day - 1], s = stateAtStart(exp, day), t = Number(ui.minute.value);
  const inNest = s.workers.filter((w) => poseAt(d, w.id, t, pos).place === NEST);
  return s.workers.map((w) => {
    const p = poseAt(d, w.id, t, pos);
    if (p.place === NEST) { const i = inNest.indexOf(w), a = (i / Math.max(1, inNest.length)) * Math.PI * 2; return { id: w.id, x: p.x + Math.cos(a) * 4, y: p.y + Math.sin(a) * 4, interpolated: false, injured: w.injured }; }
    const end = p.place.split('>').pop() as string, start = p.place.split('>')[0];
    // a walk touching a place with no recorded position is drawn at that tray slot (no invented garden position)
    const tray = pos[end]?.known === false ? end : pos[start]?.known === false ? start : undefined;
    return { id: w.id, x: p.x, y: p.y, interpolated: p.interpolated && !tray, injured: w.injured, ...(tray ? { trayAt: tray } : {}) };
  });
}

function draw() {
  const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
  const INK = tok('--ink', '#2f2a22'), LINK = tok('--link', '#b9ad8f'), MUTED = tok('--muted', '#8c8270'), ANT = tok('--ant', '#1d1d1d'), SEL = tok('--select', '#d62828'), TRAIL = tok('--trail', '196,76,32'), EXPL = tok('--explored', '46,125,90');
  ctx.fillStyle = tok('--ground', '#e9e2cf'); ctx.fillRect(0, 0, W, H);
  if (ui.view.value === 'nest') { drawNest(); renderPanels(); return; }
  const day = exp ? Number(ui.day.value) : 0, s = exp ? stateAtStart(exp, day) : null, explored = s ? exploredEdges(s) : new Set<string>();
  // links
  for (const l of links) {
    const a = pos[l.from], b = pos[l.to]; if (!a || !b) continue;
    const A = screenOf(l.from), B = screenOf(l.to), key = [l.from, l.to].sort().join(':'), trail = s?.trails[key] ?? 0;
    ctx.setLineDash(a.known && b.known ? [] : [6 * dpr, 6 * dpr]);
    ctx.strokeStyle = LINK; ctx.lineWidth = 1.5 * dpr; ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke();
    if (ui.ovExplored.checked && explored.has(key)) { ctx.strokeStyle = `rgba(${EXPL},0.55)`; ctx.lineWidth = 5 * dpr; ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke(); }
    if (ui.ovTrail.checked && trail > 0) { ctx.strokeStyle = `rgba(${TRAIL},${Math.min(0.9, 0.25 + trail / 3)})`; ctx.lineWidth = (2 + trail * 2) * dpr; ctx.beginPath(); ctx.moveTo(A.sx, A.sy); ctx.lineTo(B.sx, B.sy); ctx.stroke(); }
  }
  ctx.setLineDash([]);
  // unknown-position tray (screen-anchored, not on the map scale)
  const unknown = Object.entries(pos).filter(([, p]) => !p.known).map(([id]) => id).sort();
  if (unknown.length) { const a = trayScreen(unknown[0]), b = trayScreen(unknown[unknown.length - 1]); ctx.strokeStyle = MUTED; ctx.setLineDash([3 * dpr, 3 * dpr]); ctx.strokeRect(a.sx - 16 * dpr, a.sy - 16 * dpr, b.sx - a.sx + 60 * dpr, 32 * dpr); ctx.setLineDash([]); ctx.fillStyle = MUTED; ctx.font = `${11 * dpr}px system-ui`; ctx.fillText('位置未記錄（不在地圖比例上）', a.sx - 16 * dpr, a.sy - 20 * dpr); }
  // places
  for (const p of places) {
    const q = pos[p.id], S = q.known ? toScreen(q.x, q.y) : trayScreen(p.id), src = s?.sources[p.id], r = (p.id === NEST ? 9 : 7) * dpr;
    ctx.fillStyle = p.id === NEST ? '#6d4c2f' : p.kind?.includes('honeydew') || src?.type === 'honeydew' ? '#5f9e4a' : p.kind?.includes('nectar') || src?.type === 'nectar' ? '#e3b23c' : p.kind?.includes('carcass') || p.kind?.includes('detritus') || src?.type === 'carcass' ? '#8b5a3c' : '#a39b88';
    ctx.beginPath(); ctx.arc(S.sx, S.sy, r, 0, Math.PI * 2); ctx.fill();
    if (ui.ovFood.checked && src) { const amt = src.type === 'carcass' ? src.protein : src.sugar; ctx.fillStyle = INK; ctx.fillRect(S.sx + r + 2 * dpr, S.sy - 3 * dpr, Math.min(60, amt * 8) * dpr, 6 * dpr); }
    if (ui.ovLabels.checked) {
      const wide = cam.scale / dpr > 5 && q.known, label = wide ? `${p.id} ${p.name ?? ''}` : p.id;
      ctx.fillStyle = INK; ctx.font = `${12 * dpr}px system-ui`;
      if (p.id === NEST) ctx.fillText(label, S.sx - ctx.measureText(label).width / 2, S.sy + r + 14 * dpr); else ctx.fillText(label, S.sx + r + 3 * dpr, S.sy - 6 * dpr);
    }
  }
  // ants
  for (const a of ants()) {
    const S = a.trayAt ? trayScreen(a.trayAt) : toScreen(a.x, a.y), sel = a.id === selected;
    ctx.fillStyle = sel ? SEL : a.injured ? MUTED : ANT;
    ctx.beginPath(); ctx.ellipse(S.sx, S.sy, (sel ? 5 : 3.5) * dpr, (sel ? 3.2 : 2.3) * dpr, 0, 0, Math.PI * 2); ctx.fill();
    if (a.interpolated) { ctx.strokeStyle = MUTED; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.arc(S.sx, S.sy, 6 * dpr, 0, Math.PI * 2); ctx.stroke(); }
    if (sel) { ctx.fillStyle = SEL; ctx.font = `bold ${12 * dpr}px system-ui`; ctx.fillText(a.id, S.sx + 7 * dpr, S.sy + 4 * dpr); }
  }
  // scale bar
  const bar = 20 * cam.scale; ctx.fillStyle = INK; ctx.fillRect(12 * dpr, H - 18 * dpr, bar, 3 * dpr); ctx.font = `${11 * dpr}px system-ui`; ctx.fillText('20 cm（示意比例：方位＋約距離，非測量）', 12 * dpr, H - 24 * dpr);
  renderPanels();
}

/** Nest view: the engine has NO nest geometry yet, so this draws only the individuals that exist, grouped by kind,
 *  without chambers or tunnels (a non-spatial roster, labelled as such). */
function drawNest() {
  const dpr = window.devicePixelRatio || 1, W = canvas.width;
  ctx.fillStyle = '#5a4632'; ctx.fillRect(0, 0, W, canvas.height);
  ctx.fillStyle = '#f3ead8'; ctx.font = `${13 * dpr}px system-ui`;
  ctx.fillText('巢內（非空間名冊）', 14 * dpr, 52 * dpr);
  ctx.font = `${11 * dpr}px system-ui`; ctx.fillText('引擎目前沒有巢室與通道結構，只畫出實際存在的個體。', 14 * dpr, 70 * dpr);
  let queen: boolean, workers: string[], brood: { id: string; stage: string }[];
  if (official && !exp) { queen = official.queen.status !== 'dead'; workers = official.workers.filter((w) => w.status === 'alive' && (w.location_at_day_end ?? NEST) === NEST).map((w) => w.id); brood = official.brood.filter((b) => b.living); }
  else if (exp) { const day = Number(ui.day.value), d = exp.days[day - 1], s0 = stateAtStart(exp, day), t = Number(ui.minute.value); queen = s0.queen_alive; workers = s0.workers.filter((w) => poseAt(d, w.id, t, pos).place === NEST).map((w) => w.id); brood = s0.brood; }
  else return;
  const row = (y: number, title: string, items: string[], draw: (x: number, y: number) => void) => {
    ctx.fillStyle = '#f3ead8'; ctx.font = `bold ${12 * dpr}px system-ui`; ctx.fillText(`${title}（${items.length}）`, 14 * dpr, y);
    items.forEach((id, i) => { const x = 20 * dpr + (i % 12) * 34 * dpr, yy = y + 18 * dpr + Math.floor(i / 12) * 30 * dpr; draw(x, yy); ctx.fillStyle = '#d8ccb4'; ctx.font = `${9 * dpr}px system-ui`; ctx.fillText(id, x - 8 * dpr, yy + 16 * dpr); });
    return y + 30 * dpr + Math.ceil(Math.max(1, items.length) / 12) * 30 * dpr;
  };
  let y = 100 * dpr;
  y = row(y, '蟻后', queen ? ['Q'] : [], (x, yy) => { ctx.fillStyle = '#e0a458'; ctx.beginPath(); ctx.ellipse(x, yy, 9 * dpr, 5 * dpr, 0, 0, Math.PI * 2); ctx.fill(); });
  y = row(y, '巢內工蟻', workers, (x, yy) => { ctx.fillStyle = '#111'; ctx.beginPath(); ctx.ellipse(x, yy, 5 * dpr, 3 * dpr, 0, 0, Math.PI * 2); ctx.fill(); });
  for (const [st, label, color] of [['egg', '卵', '#fffbe8'], ['larva', '幼蟲', '#f3e3c0'], ['pupa', '蛹', '#e8d2a6']] as const) {
    y = row(y, label, brood.filter((b) => b.stage === st).map((b) => b.id), (x, yy) => { ctx.fillStyle = color; ctx.beginPath(); ctx.ellipse(x, yy, (st === 'egg' ? 3 : st === 'larva' ? 5 : 6) * dpr, (st === 'egg' ? 2 : 3.5) * dpr, 0, 0, Math.PI * 2); ctx.fill(); });
  }
}

function renderPanels() {
  if (official && !exp) {
    const alive = official.workers.filter((w) => w.status === 'alive'), dead = official.workers.filter((w) => w.status !== 'alive');
    ui.weather.textContent = `${official.calendar_date}｜正式快照`;
    ui.nest.innerHTML = `<b>蟻后</b> ${official.queen.id}（${official.queen.status}）<br><b>幼體</b> ${official.brood.filter((b) => b.living).map((b) => `${b.id}·${b.stage}`).join('、') || '無'}<br><b>存活工蟻</b> ${alive.length}　<b>已死亡</b> ${dead.map((w) => `${w.id}（${w.cause_of_death ?? '原因未記錄'}）`).join('、')}`;
    const w = official.workers.find((x) => x.id === selected);
    ui.info.innerHTML = w ? `<h3>${w.id}</h3><p>狀態：${w.status}${w.injured_preexisting ? '｜帶有舊傷' : ''}</p><p>Day${w.last_recorded_day} 經過地點：${w.site_sequence.join(' → ') || '—'}；日終在 ${w.location_at_day_end ?? '—'}</p><p>紀錄的活動：${w.activity.join('；')}</p><p class="note">正式歷史只有日終狀態與敘述，沒有逐分鐘位置。</p>` : '<p class="note">點選地圖上的工蟻查看資料。</p>';
    ui.events.innerHTML = '<p class="note">正式 Day1～14 沒有引擎事件時間軸。</p>';
    return;
  }
  if (!exp) return;
  const day = Number(ui.day.value), d = exp.days[day - 1], s = stateAtStart(exp, day), t = Number(ui.minute.value), wmin = d.window_minutes ?? 360;
  ui.minute.max = String(wmin);
  ui.time.textContent = `Day${d.day}（${d.date}）第 ${t.toFixed(0)} 分鐘／活動時窗 ${wmin} 分鐘`;
  ui.weather.textContent = `氣溫 ${d.weather.air_temp_c.toFixed(1)}°C｜巢溫 ${d.weather.nest_temp_c.toFixed(1)}°C｜${d.weather.wet ? `雨 ${d.weather.rain_mm.toFixed(1)} mm` : '無雨'}`;
  const stage = (st: string) => s.brood.filter((b) => b.stage === st).length;
  ui.nest.innerHTML = `<b>蟻后</b> ${s.queen_alive ? '存活' : '已死亡'}　<b>工蟻</b> ${s.workers.length}　<b>卵／幼蟲／蛹</b> ${stage('egg')}／${stage('larva')}／${stage('pupa')}<br><b>巢內存糧</b> 糖 ${s.stores.sugar.toFixed(2)}、蛋白 ${s.stores.protein.toFixed(2)} 份（一日開始時）<br><b>今日</b> 收入 糖 ${d.income.sugar.toFixed(2)}／蛋白 ${d.income.protein.toFixed(2)}；產卵 ${d.eggs_laid}；羽化 ${d.eclosions}；工蟻死亡 ${d.worker_deaths}`;
  const w = s.workers.find((x) => x.id === selected);
  if (w) {
    const p = poseAt(d, w.id, t, pos), seg = p.segment, task = d.tasks?.[w.id], mine = eventsUntil(d, t).filter((e) => e.worker === w.id || e.by === w.id || e.to === w.id).slice(-8);
    const segs = segmentsOf(d, w.id).filter((x) => (x.start as number) <= t);
    ui.info.innerHTML = `<h3>${w.id}</h3><p>物種：熱帶大頭家蟻（小工蟻；引擎尚未模擬大工蟻）｜年齡 ${w.age_days} 日${w.injured ? `｜受傷（${w.injury_type ?? '類型未記錄'}）` : ''}</p>
      <p>今日任務：${TASK_LABEL[task?.task ?? w.task] ?? task?.task ?? w.task}；出巢 ${task?.trips ?? 0} 趟、成功 ${task?.successes ?? 0}${task?.stop_reason && (p.action === 'in_nest' || t >= wmin) ? `；停止原因 ${REASON_LABEL[task.stop_reason] ?? task.stop_reason}` : ''}</p>
      <p>現在：${ACTION_LABEL[p.action] ?? p.action} @ ${p.place}${seg ? `（${(seg.start as number).toFixed(1)}–${(seg.end as number).toFixed(1)} 分）` : ''}${p.interpolated ? '<span class="tag">位置為顯示插值</span>' : ''}</p>
      <p>嗉囊糖（一日開始）：${w.crop_sugar.toFixed(2)} 份｜記得的地點：${w.known_sources.join('、') || '無'}｜走過的路段：${w.route_edges.join('、') || '無'}</p>
      <p>今日到目前為止的行動：${segs.length ? segs.map((x) => `${(x.start as number).toFixed(0)}′ ${ACTION_LABEL[x.action as string] ?? x.action}`).join(' → ') : '在巢內（沒有外出紀錄）'}</p>
      <p>最近事件：${mine.map(describeEvent).join('；') || '—'}</p>`;
  } else ui.info.innerHTML = '<p class="note">點選地圖上的工蟻查看資料。黑點＝工蟻；外圈＝正在兩個紀錄點之間（顯示插值）。</p>';
  const evs = eventsUntil(d, t).slice(-30).reverse();
  ui.events.innerHTML = evs.map((e) => `<div>${typeof e.minute === 'number' ? (e.minute as number).toFixed(0) + '′' : '日終'} ${describeEvent(e)}</div>`).join('') || '<p class="note">到目前為止沒有事件。</p>';
}

function pick(e: PointerEvent) {
  const r = canvas.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, sx = (e.clientX - r.left) * dpr, sy = (e.clientY - r.top) * dpr;
  let best: string | null = null, bd = 14 * dpr;
  for (const a of ants()) { const S = a.trayAt ? trayScreen(a.trayAt) : toScreen(a.x, a.y), dd = Math.hypot(S.sx - sx, S.sy - sy); if (dd < bd) { bd = dd; best = a.id; } }
  selected = best; draw();
  void toWorld;
}

function tick(now: number) {
  if (!playing || !exp) return;
  const dt = (now - last) / 1000; last = now;
  const d = exp.days[Number(ui.day.value) - 1], max = d.window_minutes ?? 360;
  let t = Number(ui.minute.value) + dt * Number(ui.speed.value);
  if (t > max) { if (Number(ui.day.value) < exp.days.length) { ui.day.value = String(Number(ui.day.value) + 1); t = 0; } else { t = max; playing = false; ui.play.textContent = '播放'; } }
  ui.minute.value = String(t); draw();
  if (playing) requestAnimationFrame(tick);
}

/** Read-only hook for automated browser checks: on-screen ant positions (CSS px). Changes nothing. */
(window as unknown as { antempireViewer: unknown }).antempireViewer = {
  antsOnScreen: () => { const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect(); return ants().map((a) => { const S = a.trayAt ? trayScreen(a.trayAt) : toScreen(a.x, a.y); return { id: a.id, x: r.left + S.sx / dpr, y: r.top + S.sy / dpr, interpolated: a.interpolated }; }); },
  selected: () => selected,
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
