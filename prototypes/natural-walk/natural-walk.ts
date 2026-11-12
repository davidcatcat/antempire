/**
 * Natural-walk viewing page (PR B: head, antennae and gait display animation). Four comparison scenes; the BODY
 * trajectory (position, heading, speed, ω) of every ant comes from an antempire.pose-stream.v1 file — the physics
 * export of PR A — or, until that exists, from a clearly labelled placeholder (示意・待 PR A 物理資料). Head yaw,
 * antennae and the leg animation are display animation (display-motion.ts / art-ant.ts), drawn on top and never fed
 * back. Read-only: nothing is written, no event is created.
 */
import { DisplayMotion, NEUTRAL_MICRO, smoothedContext, MICRO, type MicroState } from '../../web/src/display-motion.ts';
import { CYCLE_ADVANCE, WALK_FRAMES, antPalette, selectGait } from '../../web/src/art-ant.ts';
import { drawAntDetail } from '../../web/src/art-raster.ts';
import { SCHEMATIC_LIGHT, withLight } from '../../web/src/art-core.ts';
import { SCENES, asCircle, asPolygon, chemBand, cumulativeDistance, distanceAt, isPlaceholder, rawFromStream, sampleAt, slotOf, validatePoseStream, type PoseAgent, type PoseStream, type SceneSlot } from './pose-stream.ts';

const BODY_MM = 2.5;          // reference minor-worker length (R93, R94) — drawing scale only
const MIN_ANT_PX = 16;        // below this the ant is magnified and labelled ×N
const WALK_BLEND_S = 0.12;    // same display blend constant as the game view (示意)
const PAL = antPalette(2);
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

interface Loaded { stream: PoseStream; file: string; source: 'physics' | 'placeholder' }
interface Track { agent: PoseAgent; cum: number[]; walkW: Float64Array }
interface Panel {
  slot: SceneSlot; el: HTMLElement; canvas: HTMLCanvasElement; g: CanvasRenderingContext2D; hud: HTMLElement;
  data: Loaded | null; agent: PoseAgent | null; tracks: Track[]; duration: number;
  zoom: number; follow: boolean; motion: DisplayMotion; last: { t: number; lanes: { model: string; micro: MicroState | null; x: number; y: number; theta: number; v: number; omega: number; interpolated: boolean; event: string | null }[] } | null;
}

async function tryJson(url: string): Promise<unknown | null> {
  try { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) return null; return await r.json(); } catch { return null; }
}
/** Data for each scene: (0) data/compare/<slot>.json — the same scene run once per model with PR A's code (default
 *  set), (1) data/index.json listing PR A's exports, (2) data/<slot>.json, (3) the placeholder. */
const DATA_SET = new URLSearchParams(location.search).get('set') === 'original' ? 'original' : 'compare';
async function loadAll(): Promise<Map<SceneSlot, Loaded>> {
  const out = new Map<SceneSlot, Loaded>(), take = (s: unknown, file: string) => {
    const bad = validatePoseStream(s); if (bad.length) { console.warn(`skip ${file}: ${bad.join('; ')}`); return; }
    const st = s as PoseStream, slot = slotOf(st); if (!slot || out.has(slot)) return;
    out.set(slot, { stream: st, file, source: isPlaceholder(st) ? 'placeholder' : 'physics' });
  };
  if (DATA_SET === 'compare') for (const sc of SCENES) { const s = await tryJson(`data/compare/${sc.slot}.json`); if (s) take(s, `data/compare/${sc.slot}.json`); }
  const idx = await tryJson('data/index.json') as { files?: string[] } | null;
  for (const f of idx?.files ?? []) take(await tryJson('data/' + f), 'data/' + f);
  for (const sc of SCENES) if (!out.has(sc.slot)) { const s = await tryJson(`data/${sc.slot}.json`); if (s) take(s, `data/${sc.slot}.json`); }
  for (const sc of SCENES) if (!out.has(sc.slot)) { const s = await tryJson(`data/placeholder/${sc.slot}.json`); if (s) take(s, `data/placeholder/${sc.slot}.json`); }
  return out;
}

/** display walk weight per recorded sample: exponential blend toward moving (v > 0.5 mm/s), computed once from the
 *  data (so it is a function of t, not of the frame rate) */
function walkWeights(a: PoseAgent): Float64Array {
  const W = new Float64Array(a.samples.length); let w = a.samples[0].v_mm_s > 0.5 ? 1 : 0;
  for (let i = 0; i < a.samples.length; i++) { const dt = i ? a.samples[i].t - a.samples[i - 1].t : 0, m = a.samples[i].v_mm_s > 0.5 ? 1 : 0; w += (m - w) * (1 - Math.exp(-dt / WALK_BLEND_S)); W[i] = w; }
  return W;
}
const walkWAt = (k: Track, t: number) => { const s = sampleAt(k.agent, t), i = s.index, A = k.agent.samples; if (!s.interpolated) return k.walkW[i]; const f = (t - A[i].t) / (A[i + 1].t - A[i].t); return k.walkW[i] + (k.walkW[i + 1] - k.walkW[i]) * f; };

let t = 0, playing = true, speed = 0.5, lastTs = 0, artOn = true;
/** element classes the Owner asked to keep apart (labels used on every lane) */
const CLS = { phys: '物理資料', art: '美術插值', cand: '未驗證候選模型' } as const;
const MODEL_LABEL: Record<string, string> = { A: '模型 A・直線基準', B: '模型 B・自然行走候選', C: '模型 C・化學場候選' };
const laneLabel = (m: string) => `${MODEL_LABEL[m] ?? `模型 ${m}`}：身體＝${CLS.phys}${m === 'C' ? `｜${CLS.cand}（未通過 R133 生物驗證）` : ''}`;
const frames: number[] = [];
const panels: Panel[] = [];

function makePanel(slot: SceneSlot, data: Loaded | null): Panel {
  const sc = SCENES.find((x) => x.slot === slot)!, el = document.createElement('section'); el.className = 'scene'; el.dataset.slot = slot;
  const src = !data ? '<span class="tag bad">沒有資料</span>' : data.source === 'placeholder' ? '<span class="tag ph">身體軌跡：示意・待 PR A 物理資料</span>' : `<span class="tag phys">身體軌跡：PR A 物理資料（模型 ${data.stream.model}、種子 ${data.stream.seed}）</span>`;
  const models = [...new Set((data?.stream.agents ?? []).map((a) => a.model ?? data?.stream.model ?? '?'))];
  const tags = `${src}<span class="tag phys">身體位置・方向・實際轉向：${CLS.phys}</span><span class="tag disp">頭・觸角：${CLS.art}</span><span class="tag disp">六足步態：${CLS.art}（相位由物理位移驅動）</span>${models.includes('C') ? `<span class="tag cand">模型 C：${CLS.cand}（未通過 R133 生物驗證）</span>` : ''}`;
  el.innerHTML = `<header><h2>${sc.title}</h2>${tags}</header>
    <div class="wrap"><canvas></canvas><div class="zoom"><button data-z="-1" aria-label="縮小">－</button><button data-z="1" aria-label="放大">＋</button><button data-f aria-label="跟隨或全景">全景</button></div></div>
    <p class="note">${(data?.stream.agents.length ?? 0) > 1 ? `同一場景、同一隻（同 ID、同種子）以模型 ${models.join('／')} 各跑一次並排（PR A 物理程式產生，互不影響）${models.includes('C') ? '' : '；本場景沒有化學場，PR A 不執行模型 C'}。每列的身體軌跡與轉向都是${CLS.phys}；頭、觸角與步態是${CLS.art}。` : sc.note}${data ? `　<span class="muted">${data.stream.label}｜${data.file}</span>` : ''}</p><div class="hud muted"></div>`;
  const canvas = $<HTMLCanvasElement>('canvas', el); if ((data?.stream.agents.length ?? 0) > 1) canvas.style.height = `${Math.max(300, 150 * (data?.stream.agents.length ?? 1))}px`;
  const agent = data?.stream.agents[0] ?? null;
  const tracks = (data?.stream.agents ?? []).map((a) => ({ agent: a, cum: cumulativeDistance(a), walkW: walkWeights(a) }));
  const p: Panel = { slot, el, canvas, g: canvas.getContext('2d') as CanvasRenderingContext2D, hud: $('.hud', el), data, agent, tracks, duration: tracks.length ? Math.max(...tracks.map((k) => k.agent.samples[k.agent.samples.length - 1].t)) : 1, zoom: 3, follow: true, motion: new DisplayMotion(), last: null };
  for (const b of el.querySelectorAll<HTMLButtonElement>('button[data-z]')) b.onclick = () => { p.zoom = Math.max(0, Math.min(6, p.zoom + Number(b.dataset.z))); p.follow = true; syncFollow(p); };
  $<HTMLButtonElement>('button[data-f]', el).onclick = () => { p.follow = !p.follow; syncFollow(p); };
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); p.zoom = Math.max(0, Math.min(6, p.zoom - Math.sign(e.deltaY) * 0.5)); p.follow = true; syncFollow(p); }, { passive: false });
  return p;
}
const syncFollow = (p: Panel) => { $<HTMLButtonElement>('button[data-f]', p.el).textContent = p.follow ? '全景' : '跟隨'; };

/** px per mm: zoom 0 = whole trajectory fits, each step ×2 (following the ant) */
function camera(p: Panel, A: PoseAgent['samples'], w: number, h: number, x: number, y: number) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const s of A) { x0 = Math.min(x0, s.x_mm); x1 = Math.max(x1, s.x_mm); y0 = Math.min(y0, s.y_mm); y1 = Math.max(y1, s.y_mm); }
  for (const ob of p.data?.stream.obstacles ?? []) { const o = asCircle(ob); if (o) { x0 = Math.min(x0, o.x_mm - o.r_mm); x1 = Math.max(x1, o.x_mm + o.r_mm); y0 = Math.min(y0, o.y_mm - o.r_mm); y1 = Math.max(y1, o.y_mm + o.r_mm); } }
  const fit = Math.min(w / (x1 - x0 + 12), h / (y1 - y0 + 12)), s = fit * 2 ** p.zoom;
  const cx = p.follow && p.zoom > 0 ? x : (x0 + x1) / 2, cy = p.follow && p.zoom > 0 ? y : (y0 + y1) / 2;
  return { s, w2s: (wx: number, wy: number): [number, number] => [w / 2 + (wx - cx) * s, h / 2 - (wy - cy) * s] };
}

function drawPanel(p: Panel, tg: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1), cw = p.canvas.clientWidth, ch = p.canvas.clientHeight;
  if (p.canvas.width !== Math.round(cw * dpr) || p.canvas.height !== Math.round(ch * dpr)) { p.canvas.width = Math.round(cw * dpr); p.canvas.height = Math.round(ch * dpr); }
  const g = p.g; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#5a4330'; g.fillRect(0, 0, cw, ch);
  if (!p.agent || !p.data) { g.fillStyle = '#f1e6d4'; g.fillText('沒有資料', 12, 20); return; }
  const st = p.data.stream, T = p.duration, tt = tg % (T + 1.5), tc = Math.min(tt, T);
  // several models → one lane each (same scene, same ant ID / seed); one body → the placeholder's stiff-vs-art pair in
  // scene ①, otherwise a single lane. 美術插值 off = neutral head / antennae, 12-frame gait, hard walk/stop switch.
  const k0 = p.tracks[0], mdl = (k: Track) => k.agent.model ?? st.model, n = p.tracks.length, artOff = `｜${CLS.art}關閉（頭觸角不動、12 格步態）`;
  const views: { y0: number; h: number; natural: boolean; label: string; track: Track }[] = n > 1
    ? p.tracks.map((k, i) => ({ y0: (ch / n) * i, h: ch / n, natural: artOn, track: k, label: laneLabel(mdl(k)) + (artOn ? '' : artOff) }))
    : p.slot === 'straight'
      ? [{ y0: 0, h: ch / 2, natural: false, track: k0, label: `同一身體：${CLS.art}關閉` }, { y0: ch / 2, h: ch / 2, natural: artOn, track: k0, label: `同一身體：${CLS.art}${artOn ? '開啟（頭、左右觸角、連續步態）' : '關閉'}` }]
      : [{ y0: 0, h: ch, natural: artOn, label: artOn ? '' : artOff.slice(1), track: k0 }];
  const lanes: { model: string; micro: MicroState | null; x: number; y: number; theta: number; v: number; omega: number; interpolated: boolean; event: string | null }[] = [];
  for (const v of views) {
    const ag = v.track.agent, ps = sampleAt(ag, tc);
    g.save(); g.beginPath(); g.rect(0, v.y0, cw, v.h); g.clip(); g.translate(0, v.y0);
    const cam = camera(p, ag.samples, cw, v.h, ps.x_mm, ps.y_mm), mm = cam.s;
    // 1 mm / 10 mm grid (scale reference, 示意 ground)
    const step = mm * 10 >= 24 ? 10 : 50; g.strokeStyle = 'rgba(255,240,220,0.06)'; g.lineWidth = 1;
    const [ox, oy] = cam.w2s(0, 0);
    for (let x = ((ox % (step * mm)) + step * mm) % (step * mm); x < cw; x += step * mm) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, v.h); g.stroke(); }
    for (let y = ((oy % (step * mm)) + step * mm) % (step * mm); y < v.h; y += step * mm) { g.beginPath(); g.moveTo(0, y); g.lineTo(cw, y); g.stroke(); }
    // chem field (player view of the physics data)
    const cf = chemBand(st.chem_field);
    if (cf) { g.strokeStyle = 'rgba(255,214,120,0.16)'; g.lineWidth = 2 * cf.halfWidth * mm; g.lineCap = 'round'; g.beginPath(); cf.points.forEach(([x, y], i) => { const [sx, sy] = cam.w2s(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); g.stroke(); }
    for (const ob of st.obstacles) {
      const o = asCircle(ob), q = asPolygon(ob);
      if (o) { const [sx, sy] = cam.w2s(o.x_mm, o.y_mm), r = o.r_mm * mm, gr = g.createRadialGradient(sx - r * 0.3, sy - r * 0.35, r * 0.1, sx, sy, r); gr.addColorStop(0, '#a29a90'); gr.addColorStop(1, '#4d463f'); g.fillStyle = gr; g.beginPath(); g.arc(sx, sy, r, 0, Math.PI * 2); g.fill(); }
      else if (q) { g.fillStyle = '#6d6259'; g.beginPath(); q.points_mm.forEach(([x, y], i) => { const [sx, sy] = cam.w2s(x, y); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }); g.closePath(); g.fill(); }
    }
    // recorded body trajectory so far (physics data)
    g.strokeStyle = 'rgba(160,220,255,0.55)'; g.lineWidth = 1.2; g.setLineDash([3, 3]); g.beginPath();
    for (let i = 0; i < ag.samples.length && ag.samples[i].t <= tc; i += 2) { const s = ag.samples[i], [sx, sy] = cam.w2s(s.x_mm, s.y_mm); if (i) g.lineTo(sx, sy); else g.moveTo(sx, sy); }
    g.stroke(); g.setLineDash([]);
    // the ant: body pose from the data, display animation on top
    // physics sensor points (model C, synthetic) at the latest recorded time — physics output, not display
    const ss = (ag.sensor_samples ?? []) as { t: number; left?: { x_mm: number; y_mm: number }; right?: { x_mm: number; y_mm: number } }[];
    let sk = -1; for (let i = 0; i < ss.length && ss[i].t <= tc; i++) sk = i;
    if (sk >= 0) for (const q of [ss[sk].left, ss[sk].right]) if (q) { const [sx, sy] = cam.w2s(q.x_mm, q.y_mm); g.strokeStyle = 'rgba(120,230,255,0.9)'; g.lineWidth = 1.2; g.beginPath(); g.arc(sx, sy, 3, 0, Math.PI * 2); g.stroke(); }
    const L = Math.max(MIN_ANT_PX, BODY_MM * mm), [ax, ay] = cam.w2s(ps.x_mm, ps.y_mm), heading = -ps.theta;
    const moving = ps.v_mm_s > 0.5, cycles = distanceAt(ag, v.track.cum, tc) / ((CYCLE_ADVANCE / 100) * BODY_MM);
    const gait = selectGait({ moving, speedBL: ps.v_mm_s / BODY_MM, omega: -ps.omega_rad_s });
    let micro = NEUTRAL_MICRO(tc), phi = Math.floor(cycles * WALK_FRAMES) / WALK_FRAMES, w = moving ? 1 : 0;
    let shown: MicroState | null = null;
    if (v.natural) { micro = p.motion.state(`${st.scenario_id}|${ag.id}`, tc, smoothedContext((tau) => rawFromStream(st, ag, tau))); phi = cycles; w = walkWAt(v.track, tc); shown = micro; }
    withLight(SCHEMATIC_LIGHT, () => drawAntDetail(g, L, ax, ay, heading, gait, phi, w, micro, PAL));
    const evs = ag.events.filter((e) => e.t <= tc), ev = evs[evs.length - 1];
    lanes.push({ model: mdl(v.track), micro: shown, x: ps.x_mm, y: ps.y_mm, theta: ps.theta, v: ps.v_mm_s, omega: ps.omega_rad_s, interpolated: ps.interpolated, event: ev ? `${ev.kind}@${ev.t.toFixed(2)}` : null });
    g.font = '12px system-ui'; g.fillStyle = mdl(v.track) === 'C' && n > 1 ? '#ffb38a' : '#f6e7cf';
    if (v.label) g.fillText(v.label, 8, 16);
    if (n > 1 || views.length > 1) { g.strokeStyle = 'rgba(0,0,0,0.5)'; g.beginPath(); g.moveTo(0, v.h - 0.5); g.lineTo(cw, v.h - 0.5); g.stroke(); }
    const mag = L / (BODY_MM * mm); g.fillText(`${mag > 1.05 ? `螞蟻放大顯示 ×${mag.toFixed(1)}・` : '實際比例・'}格線 ${step} mm`, 8, v.h - 8);
    g.restore();
  }
  p.last = { t: tc, lanes };
  const deg = (r: number) => (r * 180 / Math.PI).toFixed(1);
  p.hud.innerHTML = `t ${tc.toFixed(2)} s${skAny(p, tc) ? '｜藍圈＝模型 C 的合成感測點（物理輸出，不是美術插值）' : ''}<br>` + lanes.map((l) =>
    `<b>${l.model}</b>　${CLS.phys}：v ${l.v.toFixed(1)} mm/s、ω ${l.omega.toFixed(2)} rad/s${l.interpolated ? '（兩筆紀錄間插值）' : ''}${l.event ? `、事件 ${l.event}` : ''}` +
    (l.micro ? `｜${CLS.art}：頭 ${deg(l.micro.headYaw)}°、左觸角 ${l.micro.L.mode}、右觸角 ${l.micro.R.mode}` : `｜${CLS.art}：關閉`)).join('<br>');
}

const skAny = (p: Panel, tc: number) => p.tracks.some((k) => (k.agent.sensor_samples ?? []).some((x) => (x as { t: number }).t <= tc));

function loop(now: number) {
  const dt = lastTs ? Math.min(0.1, (now - lastTs) / 1000) : 0; if (lastTs) { frames.push(now - lastTs); if (frames.length > 600) frames.shift(); } lastTs = now;
  if (playing) t += dt * speed;
  for (const p of panels) drawPanel(p, t);
  $('#clock').textContent = `播放時間 ${t.toFixed(2)} s（${speed}× 實際速度）`;
  requestAnimationFrame(loop);
}

async function init() {
  const data = await loadAll(), root = $('#scenes');
  for (const sc of SCENES) { const p = makePanel(sc.slot, data.get(sc.slot) ?? null); panels.push(p); root.appendChild(p.el); }
  const anyPh = [...data.values()].some((d) => d.source === 'placeholder');
  $('#status').innerHTML = anyPh ? '<b>注意：</b>部分身體軌跡是<b>示意・待 PR A 物理資料</b>（簡單運動學曲線，不是物理模擬）。PR A 的檔案放進 <code>prototypes/natural-walk/data/</code> 後自動取代。'
    : DATA_SET === 'compare' ? '身體軌跡全部是 PR A 物理輸出：同一場景以模型 A／B／C 各跑一次並排（由 PR A 程式 6fe6f26 原樣產生）。模型 C 是<b>未驗證候選模型</b>（未通過 R133 生物驗證）。' : '身體軌跡全部是 PR A 原始匯出的四個情境。';
  $<HTMLButtonElement>('#play').onclick = () => { playing = !playing; $('#play').textContent = playing ? '暫停' : '播放'; };
  $<HTMLSelectElement>('#speed').onchange = (e) => { speed = Number((e.target as HTMLSelectElement).value); };
  $<HTMLButtonElement>('#restart').onclick = () => { t = 0; };
  $<HTMLInputElement>('#art').onchange = (e) => { artOn = (e.target as HTMLInputElement).checked; };
  $<HTMLSelectElement>('#set').value = DATA_SET; $<HTMLSelectElement>('#set').onchange = (e) => { location.search = (e.target as HTMLSelectElement).value === 'original' ? '?set=original' : ''; };
  requestAnimationFrame(loop);
  (window as unknown as { __nw: unknown }).__nw = {
    ready: () => panels.length === 4,
    info: () => panels.map((p) => ({ slot: p.slot, file: p.data?.file ?? null, source: p.data?.source ?? null, model: p.data?.stream.model ?? null, last: p.last })),
    setTime: (x: number) => { t = x; }, setArt: (on: boolean) => { artOn = on; ($('#art') as HTMLInputElement).checked = on; }, pause: () => { playing = false; $('#play').textContent = '播放'; },
    setZoom: (slot: string, z: number) => { const p = panels.find((x) => x.slot === slot); if (p) { p.zoom = z; p.follow = true; } },
    fps: () => { const iv = [...frames].sort((a, b) => a - b), n = iv.length; return { samples: n, mean_ms: n ? iv.reduce((s, x) => s + x, 0) / n : null, fps_mean: n ? 1000 / (iv.reduce((s, x) => s + x, 0) / n) : null }; },
    resetFps: () => { frames.length = 0; },
    params: () => MICRO,
  };
}
init().catch((e) => { $('#status').textContent = '載入失敗：' + (e as Error).message; });
