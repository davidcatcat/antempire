/**
 * 《螞蟻帝國》read-only viewer (MVP). Draws ONLY what the exported files contain (web/data/*.json): the official
 * Day14 snapshot (static) and engine-generated experimental Day0 replays. It never runs the simulation, never
 * writes anything, and every position between two recorded points is a display interpolation (model.poseAt).
 */
import { ACTION_LABEL, NEST, assertKind, REASON_LABEL, TASK_LABEL, describeEvent, displayPositions, eventsUntil, exploredEdges, poseAt, segmentsOf, stateAtStart, taskOf, trailScale, type Experiment, type Official, type Place, type Link, stateAt, isSettled, windowOf, SETTLEMENT_STEP, dayTimeline, eventJump, eventWorkers, followStatus, type EventJump } from './model.ts';

type Pos = Record<string, { x: number; y: number; known: boolean }>;
interface Index { official: string; experiments: { id: string; file: string; title: string }[] }
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('map'), ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
const ui = { mode: $<HTMLSelectElement>('mode'), day: $<HTMLInputElement>('day'), minute: $<HTMLInputElement>('minute'), play: $<HTMLButtonElement>('play'), speed: $<HTMLSelectElement>('speed'), time: $('timeLabel'), badge: $('badge'), info: $('info'), events: $('events'), nest: $('nest'), weather: $('weather'), view: $<HTMLSelectElement>('view'), ovTrail: $<HTMLInputElement>('ovTrail'), ovExplored: $<HTMLInputElement>('ovExplored'), ovFood: $<HTMLInputElement>('ovFood'), ovLabels: $<HTMLInputElement>('ovLabels'), ovTask: $<HTMLInputElement>('ovTask'), legend: $('legend'), timeline: $('timeline'), follow: $<HTMLButtonElement>('follow'), who: $<HTMLSelectElement>('who'), followMsg: $('followMsg'), jump: $('jump'), evMine: $<HTMLInputElement>('evMine') };

/** Canvas colours come from the page's CSS tokens so both light and dark themes stay readable. */
const tok = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
let index: Index, official: Official | null = null, exp: Experiment | null = null, pos: Pos = {}, places: Place[] = [], links: Link[] = [];
let selected: string | null = null, playing = false, last = 0, modeRequest = 0;
/** V3 follow camera: the followed worker (null = free camera), and the last event jump (shown until the next one). */
let whoKey = '', following: string | null = null, followNote = '', lastJump: (EventJump & { event: string; type: string }) | null = null, eventsKey = '';
const cam = { x: 0, y: 0, scale: 3 };

async function load<T>(file: string): Promise<T> { const r = await fetch('data/' + file); if (!r.ok) throw Error('cannot load ' + file); return r.json() as Promise<T>; }

async function init() {
  index = await load<Index>('index.json');
  ui.mode.innerHTML = `<option value="official">正式遊戲 Day14（唯讀快照）</option>` + index.experiments.map((e) => `<option value="${e.id}">${e.title}</option>`).join('');
  ui.mode.onchange = () => switchMode(ui.mode.value);
  ui.day.oninput = () => { ui.minute.value = '0'; draw(); };
  ui.follow.onclick = () => { if (following) stopFollow('已取消追蹤'); else if (selected && exp) { following = selected; followNote = ''; draw(); } };
  ui.evMine.onchange = () => draw();
  // picker: on a phone the ants gathered at the nest are too close together to tap one by one
  ui.who.onchange = () => { selected = ui.who.value || null; draw(); };
  // the event list and the jump panel are re-rendered only when their content changes, so a click is never lost
  ui.events.onclick = (e) => { const b = (e.target as HTMLElement).closest('button[data-ev]') as HTMLElement | null; if (b) jumpTo(Number(b.dataset.ev)); };
  ui.jump.onclick = (e) => { const b = (e.target as HTMLElement).closest('button[data-w]') as HTMLElement | null; if (b) { selected = b.dataset.w as string; draw(); } };
  ui.minute.oninput = () => draw();
  ui.play.onclick = () => { playing = !playing; ui.play.textContent = playing ? '暫停' : '播放'; last = performance.now(); if (playing) requestAnimationFrame(tick); };
  for (const el of [ui.ovTrail, ui.ovExplored, ui.ovFood, ui.ovLabels, ui.ovTask, ui.view]) el.onchange = () => draw();
  setupPanZoom();
  window.addEventListener('resize', () => { fit(); draw(); });
  await switchMode('official');
}

async function switchMode(id: string) {
  playing = false; ui.play.textContent = '播放'; selected = null; following = null; whoKey = ''; followNote = ''; lastJump = null; eventsKey = ''; ui.jump.hidden = true;
  const req = ++modeRequest; // a slower earlier load must never overwrite the world chosen later
  if (id === 'official') {
    const o = official ?? assertKind(await load<Official>(index.official), 'official', index.official);
    if (req !== modeRequest) return;
    official = o; exp = null;
    places = official.map.places; links = official.map.links;
    ui.badge.className = 'badge official'; ui.badge.textContent = `正式遊戲 Day${official.day}（${official.calendar_date}）唯讀快照：沒有逐分鐘紀錄，因此不播放動畫`;
    ui.timeline.hidden = true;
  } else {
    const meta = index.experiments.find((e) => e.id === id) as Index['experiments'][number];
    const e = assertKind(await load<Experiment>(meta.file), 'experiment', meta.file);
    if (req !== modeRequest) return;
    exp = e; places = exp.map.places; links = exp.map.links;
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
    if (pts.size === 1) {
      // dragging the map is a manual camera move: it ends following (a tap that barely moves does not)
      if (following && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) >= 6) stopFollow('拖曳地圖：已手動取消追蹤');
      cam.x -= ((e.clientX - p.x) * dpr) / cam.scale; cam.y += ((e.clientY - p.y) * dpr) / cam.scale;
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) { const [a, b] = [...pts.values()]; cam.scale = scale0 * Math.hypot(a.x - b.x, a.y - b.y) / pinch0; }
    draw();
  };
  canvas.onpointerup = (e) => { const p = pts.get(e.pointerId); pts.delete(e.pointerId); if (p && downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) < 6) pick(e); };
  // a touch that the browser cancels must not stay in the pointer set (it would turn the next drag into a pinch)
  canvas.onpointercancel = (e) => { pts.delete(e.pointerId); downAt = null; };
  canvas.onwheel = (e) => { e.preventDefault(); cam.scale *= e.deltaY < 0 ? 1.15 : 1 / 1.15; draw(); };
}

/** Ants to draw now: [id, x, y]. Official: every living worker at its recorded day-end place. Experiment: engine poses. */
function ants(): { id: string; x: number; y: number; interpolated: boolean; injured: boolean; task: string | null; trayAt?: string }[] {
  if (official && !exp) {
    const alive = official.workers.filter((w) => w.status === 'alive');
    return alive.map((w, i) => { const at = pos[w.location_at_day_end ?? NEST] ?? pos[NEST], a = (i / Math.max(1, alive.length)) * Math.PI * 2; return { id: w.id, x: at.x + Math.cos(a) * 4, y: at.y + Math.sin(a) * 4, interpolated: false, injured: !!w.injured_preexisting, task: null }; });
  }
  if (!exp) return [];
  const day = Number(ui.day.value), d = exp.days[day - 1], t = Number(ui.minute.value), s = stateAt(exp, day, t);
  const inNest = s.workers.filter((w) => poseAt(d, w.id, t, pos).place === NEST);
  return s.workers.map((w) => {
    const p = poseAt(d, w.id, t, pos), task = taskOf(d, s, w.id).task;
    if (p.place === NEST) { const i = inNest.indexOf(w), a = (i / Math.max(1, inNest.length)) * Math.PI * 2; return { id: w.id, x: p.x + Math.cos(a) * 4, y: p.y + Math.sin(a) * 4, interpolated: false, injured: w.injured, task }; }
    const end = p.place.split('>').pop() as string, start = p.place.split('>')[0];
    // a walk touching a place with no recorded position is drawn at that tray slot (no invented garden position)
    const tray = pos[end]?.known === false ? end : pos[start]?.known === false ? start : undefined;
    return { id: w.id, x: p.x, y: p.y, interpolated: p.interpolated && !tray, injured: w.injured, task, ...(tray ? { trayAt: tray } : {}) };
  });
}

/** Map symbol class of a place: from the world's recorded kind or the engine source type only. */
function placeKind(p: Place, srcType?: string): 'nest' | 'honeydew' | 'nectar' | 'carcass' | 'other' {
  if (p.id === NEST) return 'nest';
  if (p.kind?.includes('honeydew') || srcType === 'honeydew') return 'honeydew';
  if (p.kind?.includes('nectar') || srcType === 'nectar') return 'nectar';
  if (p.kind?.includes('carcass') || p.kind?.includes('detritus') || srcType === 'carcass') return 'carcass';
  return 'other';
}
const PLACE_LABEL = { nest: '主巢入口', honeydew: '蜜露（半翅目）', nectar: '花蜜', carcass: '屍體／碎屑（蛋白）', other: '其他地點' } as const;

/** Legend: what every colour and line means, and where the drawn value comes from. */
function renderLegend() {
  const sw = (v: string) => `<span class="sw" style="background:var(${v})"></span>`;
  const rows: string[] = [`<div class="row">${(Object.keys(PLACE_LABEL) as (keyof typeof PLACE_LABEL)[]).map((k) => `<span>${sw(`--place-${k}`)}${PLACE_LABEL[k]}</span>`).join('')}</div>`];
  if (exp) {
    const s = stateAtStart(exp, Number(ui.day.value)), tr = trailScale(s);
    if (ui.ovTrail.checked) rows.push(`<div class="row"><span><span class="bar" style="border-top-width:3px;border-color:rgba(var(--trail),0.4)"></span><span class="bar" style="border-top-width:8px;border-color:rgba(var(--trail),0.9)"></span>費洛蒙：線越粗越濃＝引擎在<b>本日開始時</b>記錄的路段強度（遊戲單位，非化學濃度）；本日最強 ${tr.max.toFixed(2)}，${tr.edges} 條路段有訊號。畫面不在一天之內衰減或移動它。</span></div>`);
    if (ui.ovExplored.checked) rows.push(`<div class="row"><span><span class="bar" style="border-top-width:5px;border-color:rgba(var(--explored),0.55)"></span>已探索路段：本日開始時存活工蟻記得的路段聯集（玩家視角；個別螞蟻只知道自己走過的）</span></div>`);
    if (ui.ovTask.checked) rows.push(`<div class="row">${Object.entries(TASK_LABEL).map(([k, v]) => `<span>${sw(`--task-${k}`)}${v}</span>`).join('')}</div><div class="note">顏色＝引擎記錄的<b>當日任務摘要</b>（日終的最後紀錄；不是逐分鐘的目前任務：被招募前也已顯示為覓食）</div>`);
  } else rows.push('<div class="note">正式快照沒有費洛蒙與任務的引擎紀錄，所以不畫這些圖層。</div>');
  if (ui.ovFood.checked) rows.push('<div class="row"><span><span class="bar" style="border-top-width:6px;border-color:var(--ink)"></span>食物存量：地點旁的長條＝引擎的現存量（糖或蛋白，份）</span></div>');
  rows.push(`<div class="row"><span><span class="sw" style="background:var(--ant)"></span>工蟻</span><span><span class="sw" style="background:var(--muted)"></span>受傷</span><span><span class="sw" style="background:transparent;border:1px solid var(--muted)"></span>外圈＝兩個紀錄點之間（顯示插值）</span></div>`);
  ui.legend.innerHTML = rows.join('');
}

function draw() {
  const W = canvas.width, H = canvas.height, dpr = window.devicePixelRatio || 1;
  const INK = tok('--ink', '#2f2a22'), LINK = tok('--link', '#b9ad8f'), MUTED = tok('--muted', '#8c8270'), ANT = tok('--ant', '#1d1d1d'), SEL = tok('--select', '#d62828'), TRAIL = tok('--trail', '196,76,32'), EXPL = tok('--explored', '46,125,90');
  ctx.fillStyle = tok('--ground', '#e9e2cf'); ctx.fillRect(0, 0, W, H);
  if (ui.view.value === 'nest') { drawNest(); renderPanels(); renderLegend(); return; }
  const drawnAnts = ants();
  applyFollow(drawnAnts);
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
    ctx.fillStyle = tok(`--place-${placeKind(p, src?.type)}`, '#9a917d');
    ctx.beginPath(); ctx.arc(S.sx, S.sy, r, 0, Math.PI * 2); ctx.fill();
    if (ui.ovFood.checked && src) { const amt = src.type === 'carcass' ? src.protein : src.sugar; ctx.fillStyle = INK; ctx.fillRect(S.sx + r + 2 * dpr, S.sy - 3 * dpr, Math.min(60, amt * 8) * dpr, 6 * dpr); }
    if (ui.ovLabels.checked) {
      const wide = cam.scale / dpr > 5 && q.known, label = wide ? `${p.id} ${p.name ?? ''}` : p.id;
      ctx.fillStyle = INK; ctx.font = `${12 * dpr}px system-ui`;
      if (p.id === NEST) ctx.fillText(label, S.sx - ctx.measureText(label).width / 2, S.sy + r + 14 * dpr); else ctx.fillText(label, S.sx + r + 3 * dpr, S.sy - 6 * dpr);
    }
  }
  // ants
  for (const a of drawnAnts) {
    const S = a.trayAt ? trayScreen(a.trayAt) : toScreen(a.x, a.y), sel = a.id === selected;
    ctx.fillStyle = sel ? SEL : ui.ovTask.checked && exp && a.task ? tok(`--task-${a.task}`, ANT) : a.injured ? MUTED : ANT;
    ctx.beginPath(); ctx.ellipse(S.sx, S.sy, (sel ? 5 : 3.5) * dpr, (sel ? 3.2 : 2.3) * dpr, 0, 0, Math.PI * 2); ctx.fill();
    if (a.interpolated) { ctx.strokeStyle = MUTED; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.arc(S.sx, S.sy, 6 * dpr, 0, Math.PI * 2); ctx.stroke(); }
    if (sel) { ctx.fillStyle = SEL; ctx.font = `bold ${12 * dpr}px system-ui`; ctx.fillText(a.id === following ? `${a.id}（追蹤中）` : a.id, S.sx + 7 * dpr, S.sy + 4 * dpr); if (a.id === following) { ctx.strokeStyle = SEL; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.beginPath(); ctx.arc(S.sx, S.sy, 11 * dpr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); } }
  }
  // follow badge (on the canvas, so it is visible wherever the panels are scrolled)
  if (following || followNote) { const msg = following ? `追蹤 ${following}${followNote.includes('插值') ? '｜顯示插值位置' : followNote.includes('位置未知') ? '｜位置未知' : ''}` : followNote; ctx.font = `${12 * dpr}px system-ui`; const w = ctx.measureText(msg).width + 16 * dpr; ctx.fillStyle = tok('--panel', '#f7f3ea'); ctx.globalAlpha = 0.92; ctx.fillRect(8 * dpr, 8 * dpr, w, 22 * dpr); ctx.globalAlpha = 1; ctx.fillStyle = following ? SEL : INK; ctx.fillText(msg, 16 * dpr, 23 * dpr); }
  // scale bar
  const bar = 20 * cam.scale; ctx.fillStyle = INK; ctx.fillRect(12 * dpr, H - 18 * dpr, bar, 3 * dpr); ctx.font = `${11 * dpr}px system-ui`; ctx.fillText('20 cm（示意比例：方位＋約距離，非測量）', 12 * dpr, H - 24 * dpr);
  renderPanels(); renderLegend();
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
  else if (exp) { const day = Number(ui.day.value), d = exp.days[day - 1], t = Number(ui.minute.value), s0 = stateAt(exp, day, t); queen = s0.queen_alive; workers = s0.workers.filter((w) => poseAt(d, w.id, t, pos).place === NEST).map((w) => w.id); brood = s0.brood; }
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
    updateWho(alive.map((x) => x.id));
    setEvents('official', '<p class="note">正式 Day1～14 沒有引擎事件時間軸，所以沒有可跳轉的事件。</p>');
    ui.follow.disabled = true; ui.follow.textContent = '追蹤個體'; ui.followMsg.textContent = w ? '正式快照沒有逐分鐘位置，無法追蹤' : '';
    return;
  }
  if (!exp) return;
  const day = Number(ui.day.value), d = exp.days[day - 1], t = Number(ui.minute.value), s = stateAt(exp, day, t), wmin = windowOf(d), settled = isSettled(d, t);
  ui.minute.max = String(wmin + SETTLEMENT_STEP);
  ui.time.textContent = settled ? `Day${d.day}（${d.date}）日終結算後：死亡、羽化、產卵與發育已套用（引擎沒有記錄這些事件的時刻）` : `Day${d.day}（${d.date}）第 ${t.toFixed(0)} 分鐘／活動時窗 ${wmin} 分鐘｜蟻群名冊為本日開始時`;
  ui.weather.textContent = `氣溫 ${d.weather.air_temp_c.toFixed(1)}°C｜巢溫 ${d.weather.nest_temp_c.toFixed(1)}°C｜${d.weather.wet ? `雨 ${d.weather.rain_mm.toFixed(1)} mm` : '無雨'}`;
  const stage = (st: string) => s.brood.filter((b) => b.stage === st).length;
  ui.nest.innerHTML = `<b>蟻后</b> ${s.queen_alive ? '存活' : '已死亡'}　<b>工蟻</b> ${s.workers.length}　<b>卵／幼蟲／蛹</b> ${stage('egg')}／${stage('larva')}／${stage('pupa')}<br><b>巢內存糧</b> 糖 ${s.stores.sugar.toFixed(2)}、蛋白 ${s.stores.protein.toFixed(2)} 份（一日開始時）<br><b>今日</b> 收入 糖 ${d.income.sugar.toFixed(2)}／蛋白 ${d.income.protein.toFixed(2)}；產卵 ${d.eggs_laid}；羽化 ${d.eclosions}；工蟻死亡 ${d.worker_deaths}`;
  const w = s.workers.find((x) => x.id === selected);
  if (w) {
    const p = poseAt(d, w.id, t, pos), seg = p.segment, task = d.tasks?.[w.id], mine = eventsUntil(d, t).filter((e) => e.worker === w.id || e.by === w.id || e.to === w.id).slice(-8);
    const segs = segmentsOf(d, w.id).filter((x) => (x.start as number) <= t);
    ui.info.innerHTML = `<h3>${w.id}</h3><p>物種：熱帶大頭家蟻（小工蟻；引擎尚未模擬大工蟻）｜年齡 ${w.age_days} 日${w.injured ? `｜受傷（${w.injury_type ?? '類型未記錄'}）` : ''}</p>
      <p>今日紀錄任務（日摘要，不是逐分鐘的目前任務）：${TASK_LABEL[task?.task ?? w.task] ?? task?.task ?? w.task}；出巢 ${task?.trips ?? 0} 趟、成功 ${task?.successes ?? 0}${task?.stop_reason && (p.action === 'in_nest' || t >= wmin) ? `；停止原因 ${REASON_LABEL[task.stop_reason] ?? task.stop_reason}` : ''}</p>
      <p>現在：${ACTION_LABEL[p.action] ?? p.action} @ ${p.place}${seg ? `（${(seg.start as number).toFixed(1)}–${(seg.end as number).toFixed(1)} 分）` : ''}${p.interpolated ? '<span class="tag">位置為顯示插值</span>' : ''}</p>
      <p>位置：${placeText(p.place, p.x, p.y, p.interpolated)}</p>
      <p>嗉囊糖（一日開始）：${w.crop_sugar.toFixed(2)} 份｜記得的地點：${w.known_sources.join('、') || '無'}｜走過的路段：${w.route_edges.join('、') || '無'}</p>
      <p>今日到目前為止的行動：${segs.length ? segs.map((x) => `${(x.start as number).toFixed(0)}′ ${ACTION_LABEL[x.action as string] ?? x.action}`).join(' → ') : '在巢內（沒有外出紀錄）'}</p>
      <p>最近事件：${mine.map(describeEvent).join('；') || '—'}</p>`;
  } else {
    const st = selected ? followStatus(exp, day, t, selected, pos) : null;
    ui.info.innerHTML = st?.kind === 'dead' ? `<h3>${selected}</h3><p>已於 Day${st.day} 日終結算死亡（引擎沒有記錄死亡時刻），此後不再畫出。</p>`
      : st?.kind === 'not_present' ? `<h3>${selected}</h3><p>此時不在蟻群中${st.eclosion_day ? `：Day${st.eclosion_day} 日終結算時羽化，之後才畫出` : ''}。</p>`
      : '<p class="note">點選地圖上的工蟻查看資料。黑點＝工蟻；外圈＝正在兩個紀錄點之間（顯示插值）。</p>';
  }
  // event timeline: the whole day, in recorded order; future rows dimmed; each row jumps to its recorded time
  const rows = dayTimeline(d).filter((r) => !ui.evMine.checked || !selected || eventWorkers(r.e).includes(selected));
  const shown = rows.filter((r) => r.t <= t || (settled && r.t === Infinity)).length;
  setEvents(`${exp.spec.id}|${day}|${ui.evMine.checked ? selected : ''}|${shown}|${lastJump?.event ?? ''}`, rows.map((r) => {
    const past = r.t <= t || (settled && r.t === Infinity), cur = lastJump?.event === `${day}:${r.i}`;
    return `<button type="button" class="ev${past ? '' : ' future'}${cur ? ' current' : ''}" data-ev="${r.i}">${r.t === Infinity ? '日終（無時刻）' : r.t.toFixed(1) + '′'} ${describeEvent(r.e)}</button>`;
  }).join('') || '<p class="note">這一天沒有符合的事件。</p>');
  updateFollowUI(day, t);
  updateWho(s.workers.map((x) => x.id));
}

/** The worker picker lists exactly the workers drawn now (re-rendered only when that list changes). */
function updateWho(ids: string[]) {
  const key = ids.join(',');
  if (key !== whoKey) { whoKey = key; ui.who.innerHTML = `<option value="">選擇工蟻…（${ids.length} 隻）</option>` + ids.map((id) => `<option value="${id}">${id}</option>`).join(''); }
  ui.who.value = selected && ids.includes(selected) ? selected : '';
  ui.who.disabled = !ids.length;
}

/** A place in words: the recorded place ID, its schematic coordinates when it has a recorded bearing+distance, or
 *  「位置未知」 when it has none — never an invented coordinate. */
function placeText(place: string, x: number, y: number, interpolated: boolean) {
  const ends = place.split('>');
  if (ends.some((id) => pos[id]?.known === false)) return `${place}｜位置未知（${ends.filter((id) => pos[id]?.known === false).join('、')} 沒有記錄方位與距離，不在地圖比例上）`;
  return `${place}｜示意座標 東 ${x.toFixed(1)}、北 ${y.toFixed(1)} cm（方位＋約距離推得，非測量）${interpolated ? '；兩個紀錄點之間的顯示插值，不是實際量到的位置' : ''}`;
}

function setEvents(key: string, html: string) { if (key !== eventsKey) { eventsKey = key; ui.events.innerHTML = html; } }

function stopFollow(note: string) { following = null; followNote = note; draw(); }

/** Follow camera: centre on the followed worker's DRAWN position each frame. Ends (with the reason) when the worker
 *  dies or is not in the colony; holds still (「位置未知」) while it is at a place with no recorded position. */
function applyFollow(drawn: ReturnType<typeof ants>) {
  if (!following || !exp) return;
  const st = followStatus(exp, Number(ui.day.value), Number(ui.minute.value), following, pos);
  if (st.kind === 'dead') { followNote = `${following} 於 Day${st.day} 日終結算死亡（無時刻紀錄），追蹤結束`; following = null; return; }
  if (st.kind === 'not_present') { followNote = `${following} 此時不在蟻群中${st.eclosion_day ? `（Day${st.eclosion_day} 羽化）` : ''}，追蹤結束`; following = null; return; }
  if (st.kind === 'unknown_position') { followNote = `位置未知：${st.place} 沒有記錄座標，鏡頭停在原處`; return; }
  const a = drawn.find((x) => x.id === following);
  if (a && !a.trayAt) { cam.x = a.x; cam.y = a.y; }
  followNote = st.interpolated ? '追蹤中：鏡頭跟隨的是兩個紀錄點之間的顯示插值位置' : `追蹤中：${st.place}（引擎紀錄點）`;
}

function updateFollowUI(day: number, t: number) {
  const st = selected && exp ? followStatus(exp, day, t, selected, pos) : null;
  ui.follow.disabled = !following && !(st && (st.kind === 'visible' || st.kind === 'unknown_position'));
  ui.follow.textContent = following ? `取消追蹤 ${following}` : selected ? `追蹤個體 ${selected}` : '追蹤個體';
  ui.followMsg.textContent = followNote;
}

/** Event jump: go to the event's recorded minute (or the day's settlement step when the engine recorded none), pause,
 *  centre on its recorded place when that place has a position, and offer the workers it names for selection. */
function jumpTo(i: number) {
  if (!exp) return;
  const day = Number(ui.day.value), d = exp.days[day - 1], e = d.events[i]; if (!e) return;
  const j = eventJump(d, e, pos);
  playing = false; ui.play.textContent = '播放';
  if (following) { following = null; followNote = '跳到事件：已取消追蹤'; }
  ui.day.value = String(j.day); ui.minute.value = String(j.t);
  if (j.place.known && j.place.place) { cam.x = pos[j.place.place].x; cam.y = pos[j.place.place].y; }
  lastJump = { ...j, event: `${day}:${i}`, type: e.type };
  const present = new Set(stateAt(exp, j.day, j.t).workers.map((w) => w.id));
  const first = j.workers.find((w) => present.has(w)); if (first) selected = first;
  const when = j.timed ? `Day${j.day} 第 ${(j.minute as number).toFixed(2)} 分（引擎紀錄的時刻）` : `Day${j.day} 日終結算（引擎沒有記錄這個事件的時刻，不顯示分鐘）`;
  const where = j.place.known ? `${j.place.place}（示意位置：方位＋約距離，非測量）` : j.place.place ? `位置未知：${j.place.place} 沒有記錄方位與距離` : '位置未知：這個事件沒有記錄地點，鏡頭不移動';
  ui.jump.hidden = false;
  ui.jump.innerHTML = `<div><b>${describeEvent(e)}</b></div><div>時間：${when}</div><div>地點：${where}</div>${j.workers.length ? `<div class="chips">相關工蟻：${j.workers.map((w) => `<button type="button" data-w="${w}"${present.has(w) ? '' : ' disabled title="此時不在蟻群中"'}>${w}</button>`).join('')}</div>` : ''}`;
  draw();
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
  const d = exp.days[Number(ui.day.value) - 1], max = windowOf(d) + SETTLEMENT_STEP;
  let t = Number(ui.minute.value) + dt * Number(ui.speed.value);
  if (t > max) { if (Number(ui.day.value) < exp.days.length) { ui.day.value = String(Number(ui.day.value) + 1); t = 0; } else { t = max; playing = false; ui.play.textContent = '播放'; } }
  ui.minute.value = String(t); draw();
  if (playing) requestAnimationFrame(tick);
}

/** Read-only hook for automated browser checks: on-screen ant positions (CSS px). Changes nothing. */
(window as unknown as { antempireViewer: unknown }).antempireViewer = {
  antsOnScreen: () => { const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect(); return ants().map((a) => { const S = a.trayAt ? trayScreen(a.trayAt) : toScreen(a.x, a.y); return { id: a.id, x: r.left + S.sx / dpr, y: r.top + S.sy / dpr, interpolated: a.interpolated, task: a.task }; }); },
  selected: () => selected,
  following: () => following,
  followNote: () => followNote,
  camera: () => ({ ...cam }),
  lastJump: () => lastJump,
  placeOnScreen: (id: string) => { const dpr = window.devicePixelRatio || 1, r = canvas.getBoundingClientRect(); if (!pos[id]) return null; const S = screenOf(id); return { x: r.left + S.sx / dpr, y: r.top + S.sy / dpr, known: pos[id].known }; },
  canvasCentre: () => { const r = canvas.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; },
  state: () => ({ mode: exp ? exp.spec.id : 'official', official: !exp, day: exp ? Number(ui.day.value) : null, minute: exp ? Number(ui.minute.value) : null, workers: exp ? stateAt(exp, Number(ui.day.value), Number(ui.minute.value)).workers.map((w) => w.id) : (official?.workers.filter((w) => w.status === 'alive').map((w) => w.id) ?? []), info: ui.info.textContent ?? '' }),
};

init().catch((e) => { ui.badge.textContent = '載入失敗：' + (e as Error).message; });
