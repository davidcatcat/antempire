/**
 * Render harness (PR B): drives the layered renderer standalone, without the game view.
 *  ?mode=replay        — real experiment replay (web/data, read only): positions via game-model.antFrame (= model.poseAt)
 *  ?mode=stress&n=N    — N synthetic sprites on circles (示範 synthetic, NOT engine data) for the frame-rate budget
 * Exposes window.__harness for the Playwright bench: fps, quality, layer trace, a no-mutation check and a
 * position check (drawn engine positions = affine image of model.poseAt recomputed independently).
 */
import { LayeredRenderer } from '../../web/src/render-canvas.ts';
import { recordedRoutes, worldToScreen, type AntInput, type Camera } from '../../web/src/render-scene.ts';
import { displayPositions, poseAt, windowOf, type Experiment } from '../../web/src/model.ts';
import { antFrame, buildDayIndex, laneOffset, nextWalkStart, rosterAtStart, siteSlot, walkIntervals, anyWalking, hash32, mulberry32 } from '../../web/src/game-model.ts';

const qs = new URLSearchParams(location.search), mode = qs.get('mode') ?? 'replay', N = Number(qs.get('n') ?? 100), view = qs.get('view') ?? 'walks';
const minAntPx = () => (Math.min(canvas.clientWidth, canvas.clientHeight) < 600 ? 34 : 48);
const canvas = document.getElementById('scene') as HTMLCanvasElement, hud = document.getElementById('hud') as HTMLElement;
const R = new LayeredRenderer(canvas);
const stats = { intervals: [] as number[], last: 0 };
const longFrames: { ms: number; prev: Record<string, number>; bakes: number }[] = [];
let prevSnap: Record<string, number> = {}, prevBakes = 0;
const checks = { mutation: [] as string[], position: [] as string[], positionsChecked: 0, framesChecked: 0 };
let cam: Camera = { cx: 0, cy: 0, s: 4, w: 1, h: 1 };
const fitCam = (cx: number, cy: number, s: number) => { cam = { cx, cy, s, w: canvas.clientWidth, h: canvas.clientHeight }; };

async function main() {
  R.resize();
  if (mode === 'stress') return stress();
  const index = await (await fetch('/web/data/index.json')).json() as { experiments: { file: string }[] };
  const exp = await (await fetch('/web/data/' + index.experiments[0].file)).json() as Experiment;
  const pos = displayPositions(exp.map.places), routes = recordedRoutes(exp, pos);
  let day = 1, t = 0;
  const d = () => exp.days[day - 1];
  const stateSources = () => (day === 1 ? exp.day0.state : exp.days[day - 2].end_state).sources;
  R.setScene({ seed: hash32(exp.spec.id), places: exp.map.places, pos, routes, sources: stateSources(), weather: d().weather, decor: !qs.has('groundonly') });
  let idx = buildDayIndex(d()), walks = walkIntervals(d()), roster = rosterAtStart(exp, day);
  // default view: the nest and the food site with the most recorded walks (where ants are seen); ?view=full = 全景
  const counts = new Map<string, number>(); for (const dd of exp.days) for (const e of dd.events) if (e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>')) { const [a, b] = e.place.split('>'); const f = a === 'N00' ? b : a; if (pos[f]?.known && f !== 'N00') counts.set(f, (counts.get(f) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N00', pts = view === 'full' ? Object.values(pos).filter((p) => p.known) : [pos.N00, pos[top]];
  const bx0 = Math.min(...pts.map((p) => p.x)), bx1 = Math.max(...pts.map((p) => p.x)), by0 = Math.min(...pts.map((p) => p.y)), by1 = Math.max(...pts.map((p) => p.y)), pad = view === 'full' ? 15 : 9;
  fitCam((bx0 + bx1) / 2, (by0 + by1) / 2, Math.min(canvas.clientWidth / (bx1 - bx0 + 2 * pad), canvas.clientHeight / (by1 - by0 + 2 * pad)));
  let prepared = 0;
  R.warm(cam);
  const step = (now: number) => {
    const dt = stats.last ? Math.min(0.1, (now - stats.last) / 1000) : 0, fms = stats.last ? now - stats.last : null; stats.last = now; if (fms !== null) { stats.intervals.push(fms); if (stats.intervals.length > 900) stats.intervals.shift(); }
    if (!anyWalking(walks, t)) { const nx = nextWalkStart(walks, d(), t); t = nx === null ? windowOf(d()) : Math.max(t, nx - 0.05); }
    t += dt * 20 / 60;
    if (prepared !== day && t > windowOf(d()) * 0.6) { prepared = day; const nd = day % exp.days.length + 1; R.prepare((nd === 1 ? exp.day0.state : exp.days[nd - 2].end_state).sources, exp.days[nd - 1].weather); }
    if (t >= windowOf(d())) { day = day % exp.days.length + 1; t = 0; idx = buildDayIndex(d()); walks = walkIntervals(d()); roster = rosterAtStart(exp, day); R.setEngineState(stateSources(), d().weather); }
    fitCam(cam.cx, cam.cy, cam.s);
    const L = Math.max(26, 0.25 * cam.s);
    const ants: AntInput[] = roster.map((id) => {
      const f = antFrame(idx, d(), id, t, pos);
      let off: AntInput['displayOffset'];
      if (f.vis === 'walking' && f.heading !== null) { const o = laneOffset(id) * L * 0.55, h = -f.heading; off = { dx: -Math.sin(h) * o, dy: Math.cos(h) * o }; }
      else { const s = siteSlot(id), k = Math.min(1.4, L / 26); off = { dx: s.dx * k, dy: s.dy * k, heading: s.heading }; }
      return { id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: off };
    });
    const before = JSON.stringify(ants);
    if (fms !== null && fms > 40 && longFrames.length < 40) longFrames.push({ ms: fms, prev: prevSnap, bakes: prevBakes });
    const draws = R.frame(cam, ants, dt, fms, { highlightEngine: qs.has('highlight'), labels: qs.has('labels'), showRoutes: qs.has('routes'), minAntPx: view === 'full' ? 26 : minAntPx() });
    // checks: inputs unchanged; drawn engine anchor = affine image of poseAt on the FULL day (independent of antFrame)
    if (JSON.stringify(ants) !== before) checks.mutation.push(`day ${day} t ${t}`);
    checks.framesChecked++;
    for (const dr of draws) {
      const p = poseAt(d(), dr.id, t, pos), [ex, ey] = worldToScreen(cam, p.x, p.y); checks.positionsChecked++;
      if (Math.abs(ex - dr.ex) > 1e-6 || Math.abs(ey - dr.ey) > 1e-6) checks.position.push(`${dr.id} day ${day} t ${t.toFixed(3)}`);
    }
    prevSnap = { ...R.stats.lastMs }; prevBakes = R.stats.bakedThisFrame;
    hud.innerHTML = `<b>繪圖器測試頁</b>・重播引擎紀錄（非正式實驗世界）・第 ${day} 日 ${t.toFixed(1)} 分・畫出 ${draws.length} 隻・${R.weatherDay().label}・品質 ${R.quality().level}`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stress() {
  const places = [{ id: 'N00', name: '示範巢', bearing: null, distance_cm: null, kind: null, layout: null }];
  const pos = { N00: { x: 0, y: 0, known: true } };
  R.setScene({ seed: 4242, places, pos, routes: [], sources: {}, weather: null });
  fitCam(0, 0, Math.min(canvas.clientWidth, canvas.clientHeight) / 60); R.warm(cam);
  const r = mulberry32(99), ants = Array.from({ length: N }, (_, i) => ({ id: `S${i}`, cx: (r() - 0.5) * 50, cy: (r() - 0.5) * 50, rad: 2 + r() * 8, w: (0.2 + r() * 0.4) * (r() < 0.5 ? -1 : 1), p0: r() * 6.283 }));
  let tt = 0;
  const step = (now: number) => {
    const dt = stats.last ? Math.min(0.1, (now - stats.last) / 1000) : 0, fms = stats.last ? now - stats.last : null; stats.last = now; if (fms !== null) { stats.intervals.push(fms); if (stats.intervals.length > 900) stats.intervals.shift(); }
    tt += dt; fitCam(0, 0, cam.s);
    const input: AntInput[] = ants.map((a) => { const ang = a.p0 + a.w * tt; return { id: a.id, x: a.cx + Math.cos(ang) * a.rad, y: a.cy + Math.sin(ang) * a.rad, vis: 'walking', moving: true, heading: qs.has('norot') ? 0 : ang + Math.sign(a.w) * Math.PI / 2 }; });
    const draws = R.frame(cam, input, dt, fms);
    hud.innerHTML = `<b>繪圖器壓力測試</b>・${draws.length} 個合成精靈（示範 synthetic，非引擎資料）・品質 ${R.quality().level}`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

(window as unknown as { __harness: unknown }).__harness = {
  ready: () => stats.intervals.length > 30,
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length, m = n ? iv.reduce((s, x) => s + x, 0) / n : 0; return { samples: n, fps_mean: n ? 1000 / m : null, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null }; },
  reset: () => { stats.intervals = []; longFrames.length = 0; },
  longFrames: () => longFrames,
  /** luminance step across chunk boundaries vs between ordinary neighbouring columns/rows, and the strongest
   *  periodicity of the column / row mean luminance (normalised autocorrelation at lags 24..W/2 px) */
  seamCheck: () => {
    const g = canvas.getContext('2d') as CanvasRenderingContext2D, W = canvas.width, H = canvas.height, d = g.getImageData(0, 0, W, H).data, k = W / canvas.clientWidth;
    const lum = (x: number, y: number) => { const q = (y * W + x) * 4; return 0.3 * d[q] + 0.59 * d[q + 1] + 0.11 * d[q + 2]; };
    const y0 = Math.round(H * 0.08), y1 = Math.round(H * 0.92), x0 = Math.round(W * 0.03), x1 = Math.round(W * 0.97);
    const colStep = (x: number) => { let s = 0; for (let y = y0; y < y1; y++) s += Math.abs(lum(x, y) - lum(x - 1, y)); return s / (y1 - y0); };
    const rowStep = (y: number) => { let s = 0; for (let x = x0; x < x1; x++) s += Math.abs(lum(x, y) - lum(x, y - 1)); return s / (x1 - x0); };
    let inner = 0, n = 0; for (let x = x0 + 1; x < x1; x += 3) { inner += colStep(x); n++; } inner /= n;
    let innerR = 0, m = 0; for (let y = y0 + 1; y < y1; y += 3) { innerR += rowStep(y); m++; } innerR /= m;
    const all: number[] = []; for (let x = x0 + 1; x < x1; x++) all.push(colStep(x) / inner); all.sort((a2, b2) => a2 - b2);
    const p99 = all[Math.floor(all.length * 0.99)];
    const b = R.chunkBoundaries(), seamsX = b.xs.map((x) => colStep(Math.round(x * k))), seamsY = b.ys.map((y) => rowStep(Math.round(y * k)));
    const meanL: number[] = []; const prof = (len: number, f: (i: number) => number) => { const v = Array.from({ length: len }, (_, i) => f(i)), mu = v.reduce((a, c) => a + c, 0) / len; meanL.push(mu); return v.map((x) => x - mu); };
    const relStd = (v: number[], mu: number) => Math.sqrt(v.reduce((a, c) => a + c * c, 0) / v.length) / (mu || 1);
    const colMean = prof(x1 - x0, (i) => { let s = 0; for (let y = y0; y < y1; y += 2) s += lum(x0 + i, y); return s; }), rowMean = prof(y1 - y0, (i) => { let s = 0; for (let x = x0; x < x1; x += 2) s += lum(x, y0 + i); return s; });
    const ac = (v: number[]) => { const v0 = v.reduce((a, c) => a + c * c, 0) || 1, r = (L: number) => { let s = 0; for (let i = 0; i + L < v.length; i++) s += v[i] * v[i + L]; return s / v0 * v.length / (v.length - L); }; let L0 = 1; while (L0 < v.length / 2 && r(L0) > 0) L0++; let best = 0, lag = 0; for (let L = L0; L < v.length / 2; L++) { const x = r(L); if (x > best) { best = x; lag = L; } } return { r: best, lag, decorrelated_at: L0 }; }; // strongest repeat AFTER the profile first decorrelates
    return { inner_col: inner, inner_row: innerR, seams_x: seamsX, seams_y: seamsY, max_seam_ratio: Math.max(0, ...seamsX.map((v) => v / inner), ...seamsY.map((v) => v / innerR)), ordinary_column_p99_ratio: p99, periodicity_col: ac(colMean), periodicity_row: ac(rowMean),
      /** relative amplitude of the strongest repeat = r × (std of the mean profile ÷ mean luminance); < 0.01 = invisible */
      periodic_amp: Math.max(ac(colMean).r * relStd(colMean, meanL[0]), ac(rowMean).r * relStd(rowMean, meanL[1])) };
  },
  info: () => ({ quality: R.quality(), stats: { ...R.stats }, trace: [...R.trace], engineObjects: R.engineObjects().map((o) => ({ id: o.id, kind: o.kind, source: o.source })), weather: R.weatherDay(), checks: { ...checks, mutation: checks.mutation.slice(0, 5), position: checks.position.slice(0, 5), mutationCount: checks.mutation.length, positionErrors: checks.position.length }, canvas: [canvas.width, canvas.height] }),
};
main().catch((e) => { hud.textContent = '錯誤：' + (e as Error).message; throw e; });
