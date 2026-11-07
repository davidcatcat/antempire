// Physics playback page (docs/physics-playback.md). Read-only: it fetches the exported JSON in ./data and draws it.
// It runs no solver and imports nothing from the engine. Positions come from motion.js (the solver's exact piecewise
// constant-velocity motion); there is no smoothing and no motion that is not in the data.
import { poseAt, eventTimes, lastEventAt } from './motion.js';

const $ = (id) => document.getElementById(id);
const KIND = {
  start: '出發', arrive: '抵達', contact_start: '接觸開始', contact_end: '接觸結束', stop: '停止', resume: '恢復', follow: '跟隨（減速）',
  free: '恢復自由速度', pass: '錯身', turn: '轉向', turn_blocked: '轉向受阻', stalled: '卡住（時間終點）', unresolved: '未解', record: '原生運動紀錄',
  obstruction: '受阻', follow_start: '跟隨開始', follow_end: '跟隨結束', blocked: '受阻', yield_start: '讓路（候選規則）', yield_hold: '讓路等待（候選規則）',
  yield_resume: '讓路後恢復（候選規則）', cross_wait: '交叉等待（候選規則）', cross_resume: '交叉後恢復（候選規則）',
};
const CLASS_VAR = { physical_contact: '--c-contact', physical_constraint: '--c-constraint', motion: '--c-motion', solver_status: '--c-status', behavioural_response: '--c-behaviour', native_motion_record: '--c-record' };
const PALETTE = ['#2f7d4f', '#1b5fae', '#b0452f', '#8a5a00', '#6d3fa0', '#0f7c86', '#a03a6c', '#4f6b00'];
const ROW_H = 26;

const st = { index: null, runs: new Map(), run: null, t: 0, playing: false, rate: 1, sel: -1, selPinned: false, cam: null, times: [], drawn: [], hi: new Set(), lastFrame: 0 };
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const fmtT = (t) => `${t.toFixed(6)} s`;  // display rounding only; the exact time is in the data

async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: ${r.status}`); return r.json(); }

// ------------------------------------------------------------------ loading
async function init() {
  st.index = await getJson('data/index.json');
  $('badge').textContent = st.index.label;
  const seen = new Set(), sc = $('scenario');
  for (const r of st.index.runs) if (!seen.has(r.scenario)) { seen.add(r.scenario); sc.add(new Option(`${r.scenario}：${r.title}`, r.scenario)); }
  sc.addEventListener('change', () => { fillSolvers(); loadRun(currentRunId()); });
  $('solver').addEventListener('change', () => loadRun(currentRunId()));
  fillSolvers();
  await loadRun(currentRunId());
}
function fillSolvers() {
  const s = $('solver'), kind = (s.value || '').split('--')[1]; s.innerHTML = '';
  for (const r of st.index.runs.filter((x) => x.scenario === $('scenario').value)) s.add(new Option(r.solver_label, r.run_id));
  const same = [...s.options].find((o) => o.value.split('--')[1] === kind); if (same) s.value = same.value;
}
const currentRunId = () => $('solver').value;
async function loadRun(id) {
  const meta = st.index.runs.find((r) => r.run_id === id);
  if (!st.runs.has(id)) st.runs.set(id, await getJson(meta.file));
  st.run = st.runs.get(id); st.t = 0; st.playing = false; st.sel = -1; st.selPinned = false; st.times = eventTimes(st.run);
  $('play').textContent = '播放';
  $('lenTxt').textContent = `${st.run.body.length_mm} mm`; $('widTxt').textContent = `${st.run.body.width_mm} mm`;
  fitAll(); renderAbout(); buildList(); syncSel(); draw();
}

// ------------------------------------------------------------------ camera
const canvas = $('view'), ctx = canvas.getContext('2d');
function size() {
  const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  return { w, h, dpr };
}
function fitBox(minX, minY, maxX, maxY) {
  const { w, h } = size(), bw = Math.max(maxX - minX, 1e-6), bh = Math.max(maxY - minY, 1e-6);
  st.cam = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, ppm: Math.min((w - 24) / bw, (h - 24) / bh) };
}
function fitAll() {
  const r = st.run, L = r.body.length_mm;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x, y) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); };
  for (const a of r.agents) for (const g of a.segments) { add(g.x0, g.y0); add(g.x1, g.y1); }
  const m = Math.max(3 * L, 0.06 * Math.max(maxX - minX, maxY - minY));
  minX -= m; minY -= m; maxX += m; maxY += m;
  // obstacles near the motion are part of the picture (the stone, the corridor walls)
  for (const o of r.obstacles) {
    const pts = o.kind === 'circle' ? [[o.center_mm[0] - o.radius_mm, o.center_mm[1] - o.radius_mm], [o.center_mm[0] + o.radius_mm, o.center_mm[1] + o.radius_mm]] : o.points_mm;
    const ox0 = Math.min(...pts.map((p) => p[0])), ox1 = Math.max(...pts.map((p) => p[0])), oy0 = Math.min(...pts.map((p) => p[1])), oy1 = Math.max(...pts.map((p) => p[1]));
    if (ox1 >= minX - 30 && ox0 <= maxX + 30 && oy1 >= minY - 30 && oy0 <= maxY + 30) { add(Math.max(ox0, minX - 30), Math.max(oy0, minY - 30)); add(Math.min(ox1, maxX + 30), Math.min(oy1, maxY + 30)); }
  }
  fitBox(minX, minY, maxX, maxY);
}
function focusHi() {
  const ids = st.hi.size ? [...st.hi] : st.run.agents.map((a) => a.id), L = st.run.body.length_mm;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const id of ids) { const p = poseAt(st.run.agents.find((a) => a.id === id), st.t); minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  const pad = 2.5 * L; fitBox(minX - pad, minY - pad, maxX + pad, maxY + pad);
}
const W2S = (x, y) => { const { w, h } = size(); return [w / 2 + (x - st.cam.cx) * st.cam.ppm, h / 2 - (y - st.cam.cy) * st.cam.ppm]; };

// ------------------------------------------------------------------ drawing
function capsulePath(cx, cy, heading, L, wd) {
  const r = wd / 2, hw = Math.max(L / 2 - r, 0), ex = Math.cos(heading), ey = Math.sin(heading);
  const [ax, ay] = W2S(cx - ex * hw, cy - ey * hw), [bx, by] = W2S(cx + ex * hw, cy + ey * hw), rp = r * st.cam.ppm;
  const ang = Math.atan2(by - ay, bx - ax);
  ctx.beginPath();
  ctx.arc(bx, by, rp, ang - Math.PI / 2, ang + Math.PI / 2);
  ctx.arc(ax, ay, rp, ang + Math.PI / 2, ang + 3 * Math.PI / 2);
  ctx.closePath();
  return { bx, by, ang, rp };
}
function draw() {
  const r = st.run; if (!r) return;
  const { w, h, dpr } = size();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css('--bg'); ctx.fillRect(0, 0, w, h);
  // lanes: band of the given width (edge colour underneath), joints round, ends flat
  for (const pass of [0, 1]) for (const l of r.lanes) {
    ctx.beginPath(); l.centerline_mm.forEach(([x, y], i) => { const [sx, sy] = W2S(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
    ctx.lineJoin = 'round'; ctx.lineCap = 'butt';
    ctx.lineWidth = l.width_mm * st.cam.ppm + (pass ? 0 : 2); ctx.strokeStyle = css(pass ? '--lane' : '--lane-edge'); ctx.stroke();
  }
  // obstacles / walls
  ctx.fillStyle = css('--wall');
  for (const o of r.obstacles) {
    ctx.beginPath();
    if (o.kind === 'circle') { const [x, y] = W2S(o.center_mm[0], o.center_mm[1]); ctx.arc(x, y, o.radius_mm * st.cam.ppm, 0, 2 * Math.PI); }
    else o.points_mm.forEach(([x, y], i) => { const [sx, sy] = W2S(x, y); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
    ctx.fill();
  }
  // bodies
  st.drawn = [];
  const L = r.body.length_mm, Wd = r.body.width_mm, showAll = st.cam.ppm * L > 18;
  r.agents.forEach((a, i) => {
    const p = poseAt(a, st.t), hi = st.hi.has(a.id), col = PALETTE[i % PALETTE.length];
    const { bx, by, ang, rp } = capsulePath(p.x, p.y, p.heading, L, Wd);
    ctx.globalAlpha = 0.85; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1;
    if (hi) { ctx.lineWidth = 3; ctx.strokeStyle = css('--ink'); ctx.stroke(); }
    // head: small mark at the front end
    const hx = bx + Math.cos(ang) * rp * 0.4, hy = by + Math.sin(ang) * rp * 0.4;
    ctx.beginPath(); ctx.arc(hx, hy, Math.max(1.5, rp * 0.45), 0, 2 * Math.PI); ctx.fillStyle = '#ffffff'; ctx.fill();
    const [sx, sy] = W2S(p.x, p.y);
    if (showAll || hi) { ctx.font = `${hi ? 600 : 500} 12px system-ui, sans-serif`; const lx = sx + 6, ly = sy - Math.max(8, rp + 4); ctx.fillStyle = css('--panel'); ctx.globalAlpha = 0.8; ctx.fillRect(lx - 2, ly - 11, ctx.measureText(a.id).width + 4, 14); ctx.globalAlpha = 1; ctx.fillStyle = css('--ink'); ctx.fillText(a.id, lx, ly); }
    st.drawn.push({ id: a.id, x: p.x, y: p.y, heading: p.heading, sx, sy, highlighted: hi });
  });
  drawScale(w, h);
  const lab = `${r.scenario.id}・${r.solver === 'ph3b' ? 'PH-3b' : '原生 PH-2'}・synthetic・非正式`;
  ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = css('--panel'); ctx.globalAlpha = 0.9; ctx.fillRect(4, 4, ctx.measureText(lab).width + 8, 18); ctx.globalAlpha = 1;
  ctx.fillStyle = css('--ink'); ctx.fillText(lab, 8, 17);
  drawTimeline(); updateNow();
}
function drawScale(w, h) {
  const target = 110 / st.cam.ppm, steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200];
  const mm = steps.reduce((b, s) => (s <= target ? s : b), steps[0]), px = mm * st.cam.ppm, x0 = 12, y0 = h - 14;
  ctx.fillStyle = css('--panel'); ctx.globalAlpha = 0.9; ctx.fillRect(x0 - 6, y0 - 12, px + 60, 22); ctx.globalAlpha = 1;
  ctx.strokeStyle = css('--ink'); ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.moveTo(x0, y0 - 5); ctx.lineTo(x0, y0 + 3); ctx.moveTo(x0 + px, y0 - 5); ctx.lineTo(x0 + px, y0 + 3); ctx.stroke();
  ctx.fillStyle = css('--ink'); ctx.font = '12px system-ui, sans-serif'; ctx.fillText(`${mm} mm`, x0 + px + 6, y0 + 4);
}

// ------------------------------------------------------------------ timeline (ticks = engine events)
const tl = $('timeline'), tctx = tl.getContext('2d');
function drawTimeline() {
  const dpr = window.devicePixelRatio || 1, w = tl.clientWidth, h = tl.clientHeight;
  if (tl.width !== Math.round(w * dpr)) { tl.width = Math.round(w * dpr); tl.height = Math.round(h * dpr); }
  tctx.setTransform(dpr, 0, 0, dpr, 0, 0); tctx.clearRect(0, 0, w, h);
  const H = st.run.horizon_s, X = (t) => 8 + (w - 16) * (t / H);
  tctx.fillStyle = css('--line'); tctx.fillRect(8, h / 2 - 2, w - 16, 4);
  for (const e of st.run.events) { tctx.fillStyle = css(CLASS_VAR[e.class] ?? '--c-status'); tctx.fillRect(Math.round(X(e.t)) - 0.5, 6, 1.5, h - 16); }
  tctx.fillStyle = css('--accent'); tctx.fillRect(X(st.t) - 1.5, 2, 3, h - 6);
  tctx.fillStyle = css('--muted'); tctx.font = '11px system-ui, sans-serif'; tctx.fillText('0', 8, h - 1); const ht = `${H} s`; tctx.fillText(ht, w - 8 - tctx.measureText(ht).width, h - 1);
}
function tlSeek(ev) { const rc = tl.getBoundingClientRect(), f = Math.min(1, Math.max(0, (ev.clientX - rc.left - 8) / (rc.width - 16))); setTime(f * st.run.horizon_s, false); }
tl.addEventListener('pointerdown', (ev) => { tl.setPointerCapture(ev.pointerId); pause(); tlSeek(ev); });
tl.addEventListener('pointermove', (ev) => { if (ev.buttons) tlSeek(ev); });

// ------------------------------------------------------------------ event list (virtualised)
const list = $('events');
function buildList() {
  list.innerHTML = ''; list.scrollTop = 0; const sp = document.createElement('div'); sp.style.height = `${st.run.events.length * ROW_H}px`; list.appendChild(sp);
  $('evcount').textContent = `（${st.run.events.length} 筆；點一下跳到該時刻）`;
  list.scrollTop = 0; renderRows();
}
function renderRows() {
  // keeps rows that stay in range (a row is never rebuilt while visible), adds the missing ones, drops the rest
  const E = st.run.events, top = list.scrollTop, n0 = Math.max(0, Math.floor(top / ROW_H) - 5), n1 = Math.min(E.length, Math.ceil((top + list.clientHeight) / ROW_H) + 5);
  const have = new Map();
  for (const el of [...list.querySelectorAll('.ev')]) { const i = Number(el.dataset.i); if (i < n0 || i >= n1) el.remove(); else have.set(i, el); }
  for (let i = n0; i < n1; i++) {
    const old = have.get(i);
    if (old) { old.classList.toggle('sel', i === st.sel); continue; }
    const e = E[i], d = document.createElement('div');
    d.className = `ev${i === st.sel ? ' sel' : ''}`; d.style.top = `${i * ROW_H}px`; d.dataset.i = String(i);
    d.title = `${fmtT(e.t)} ${e.kind} ${e.agents.join(', ')}${e.detail ? ` — ${e.detail}` : ''}`;
    d.innerHTML = `<span class="t"></span><span class="kd"></span> <span class="ag"></span> <span class="dt"></span>`;
    d.querySelector('.t').textContent = e.t.toFixed(6);
    const kd = d.querySelector('.kd'); kd.textContent = KIND[e.kind] ?? e.kind; kd.style.color = css(CLASS_VAR[e.class] ?? '--c-status');
    d.querySelector('.ag').textContent = e.agents.join('・');
    const dt = d.querySelector('.dt'); dt.textContent = e.detail ?? ''; dt.style.color = css('--muted');
    d.addEventListener('click', () => selectEvent(i));
    list.appendChild(d);
  }
}
list.addEventListener('scroll', renderRows);
function scrollToSel() {
  if (st.sel < 0) return; const y = st.sel * ROW_H;
  if (y < list.scrollTop || y > list.scrollTop + list.clientHeight - ROW_H) list.scrollTop = Math.max(0, y - list.clientHeight / 2);
  renderRows();
}

// ------------------------------------------------------------------ selection / time
function syncSel() {
  if (!st.selPinned) st.sel = lastEventAt(st.run, st.t);
  st.hi = new Set(st.sel >= 0 ? st.run.events[st.sel].agents : []);
}
function setTime(t, pinned) { st.t = Math.min(Math.max(0, t), st.run.horizon_s); st.selPinned = !!pinned && st.selPinned; syncSel(); scrollToSel(); draw(); }
function selectEvent(i) {
  pause(); st.t = st.run.events[i].t; st.sel = i; st.selPinned = true; st.hi = new Set(st.run.events[i].agents);
  if ($('follow').checked) focusHi();
  scrollToSel(); draw();
}
function stepEvent(d) {
  pause();
  const T = st.times; let k;
  if (d > 0) { k = T.findIndex((x) => x > st.t); if (k < 0) return; }
  else { k = -1; for (let j = T.length - 1; j >= 0; j--) if (T[j] < st.t) { k = j; break; } if (k < 0) { setTime(0, false); return; } }
  st.t = T[k]; st.selPinned = false; syncSel();
  if ($('follow').checked) focusHi();
  scrollToSel(); draw();
}
function pause() { st.playing = false; $('play').textContent = '播放'; }
function tick(now) {
  if (st.playing) {
    const dt = Math.min(0.1, (now - st.lastFrame) / 1000); st.lastFrame = now;
    st.t = Math.min(st.run.horizon_s, st.t + dt * st.rate); st.selPinned = false; syncSel();
    if (st.t >= st.run.horizon_s) pause();
    scrollToSel(); draw();
  }
  requestAnimationFrame(tick);
}
$('play').addEventListener('click', () => { if (st.playing) { pause(); return; } if (st.t >= st.run.horizon_s) st.t = 0; st.playing = true; st.lastFrame = performance.now(); $('play').textContent = '暫停'; });
$('prev').addEventListener('click', () => stepEvent(-1));
$('next').addEventListener('click', () => stepEvent(1));
$('rate').addEventListener('change', () => { st.rate = Number($('rate').value); });
$('zin').addEventListener('click', () => { st.cam.ppm *= 1.6; draw(); });
$('zout').addEventListener('click', () => { st.cam.ppm /= 1.6; draw(); });
$('fit').addEventListener('click', () => { fitAll(); draw(); });
$('focus').addEventListener('click', () => { focusHi(); draw(); });

// pan (drag) and zoom (wheel, pinch) — camera only, never the data
const ptrs = new Map(); let pinch0 = null;
canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (ptrs.size === 2) { const [p, q] = [...ptrs.values()]; pinch0 = { d: Math.hypot(p.x - q.x, p.y - q.y), ppm: st.cam.ppm }; } });
canvas.addEventListener('pointermove', (e) => {
  const prev = ptrs.get(e.pointerId); if (!prev) return;
  if (ptrs.size === 1) { st.cam.cx -= (e.clientX - prev.x) / st.cam.ppm; st.cam.cy += (e.clientY - prev.y) / st.cam.ppm; }
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (ptrs.size === 2 && pinch0) { const [p, q] = [...ptrs.values()]; st.cam.ppm = pinch0.ppm * Math.hypot(p.x - q.x, p.y - q.y) / Math.max(pinch0.d, 1); }
  draw();
});
const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch0 = null; };
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
canvas.addEventListener('wheel', (e) => {
  e.preventDefault(); const rc = canvas.getBoundingClientRect(), { w, h } = size();
  const mx = st.cam.cx + (e.clientX - rc.left - w / 2) / st.cam.ppm, my = st.cam.cy - (e.clientY - rc.top - h / 2) / st.cam.ppm, k = Math.exp(-e.deltaY * 0.0015);
  st.cam.ppm *= k; st.cam.cx = mx - (mx - st.cam.cx) / k; st.cam.cy = my - (my - st.cam.cy) / k; draw();
}, { passive: false });
window.addEventListener('resize', () => draw());

// ------------------------------------------------------------------ text panels
function updateNow() {
  const r = st.run, e = st.sel >= 0 ? r.events[st.sel] : null;
  $('clock').textContent = `t = ${fmtT(st.t)}`;
  const nextT = st.times.find((x) => x > st.t);
  $('now').innerHTML = '';
  const p = document.createElement('div');
  p.innerHTML = e ? `<span class="k"></span> <span class="d"></span>` : '<span class="d"></span>';
  if (e) { p.querySelector('.k').textContent = `目前事件 #${st.sel + 1}（${fmtT(e.t)}）：${KIND[e.kind] ?? e.kind}・${e.agents.join('・')}`; p.querySelector('.d').textContent = e.detail ? `— ${e.detail}` : ''; }
  else p.querySelector('.d').textContent = '尚未有事件';
  const q = document.createElement('div'); q.className = 'sub';
  q.textContent = nextT === undefined ? '之後沒有事件：每隻都依最後一段運動（或靜止）到時間終點。' : `下一個事件在 ${fmtT(nextT)}（再 ${nextT - st.t >= 1e-6 ? (nextT - st.t).toFixed(6) : (nextT - st.t).toExponential(3)} s）；在那之前每隻都是直線等速或靜止。`;
  $('now').append(p, q);
  // agents table: highlighted ones, or all when few
  const ids = r.agents.length <= 8 ? r.agents.map((a) => a.id) : [...st.hi];
  const rows = ids.map((id) => { const a = r.agents.find((x) => x.id === id), pz = poseAt(a, st.t); return [id, pz.moving ? '移動' : '靜止', pz.speed.toFixed(3), pz.s.toFixed(3), pz.u.toFixed(2), a.final_mode, a.arrival_t_s === null ? '—' : a.arrival_t_s.toFixed(3)]; });
  const tb = document.createElement('table');
  tb.innerHTML = '<thead><tr><th>個體</th><th>此刻</th><th>速度 mm/s</th><th>s mm</th><th>u mm</th><th>結束狀態</th><th>抵達 s</th></tr></thead><tbody></tbody>';
  for (const row of rows) { const tr = document.createElement('tr'); for (const c of row) { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); } if (st.hi.has(row[0])) tr.style.fontWeight = '600'; tb.tBodies[0].appendChild(tr); }
  $('agents').innerHTML = ''; $('agents').appendChild(tb);
}
function renderAbout() {
  const r = st.run, box = $('about'); box.innerHTML = '';
  const add = (tag, text) => { const el = document.createElement(tag); el.textContent = text; box.appendChild(el); return el; };
  add('p', `${r.scenario.title}（${r.scenario.id}，合成情境；檔案 ${r.scenario.source_file}）`);
  add('p', `情境值：${r.scenario.provenance.scenario_values}`);
  if (r.scenario.provenance.note) add('p', `說明：${r.scenario.provenance.note}`);
  add('p', `體長：${r.body.length_mm} mm — ${r.body.length_source}`);
  add('p', `碰撞寬：${r.body.width_mm} mm — ${r.body.width_source}`);
  add('p', `身體形狀：${r.body.shape}`);
  const ul = document.createElement('ul'); for (const n of [...r.solver_notes, r.motion_note]) { const li = document.createElement('li'); li.textContent = n; ul.appendChild(li); } box.appendChild(ul);
  add('p', `時間終點 ${r.horizon_s} s；解算器狀態 ${r.status}。速度來源：${[...new Set(r.agents.map((a) => a.speed_source))].join('；')}`);
}

// ------------------------------------------------------------------ hooks for the browser check (read-only)
window.playback = {
  ready: init().then(() => true),
  load: async (id) => { const meta = st.index.runs.find((x) => x.run_id === id); $('scenario').value = meta.scenario; fillSolvers(); $('solver').value = id; await loadRun(id); },
  setTime: (t) => setTime(t, false), selectEvent, stepEvent, fitAll: () => { fitAll(); draw(); },
  state: () => ({ run_id: st.run.run_id, t: st.t, sel: st.sel, drawn: st.drawn, highlighted: [...st.hi] }),
};
requestAnimationFrame(tick);
