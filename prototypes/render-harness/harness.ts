/**
 * Render harness (PR B): drives the layered renderer standalone, without the game view.
 *  ?mode=replay        — real experiment replay (web/data, read only): positions via game-model.antFrame (= model.poseAt)
 *  ?mode=stress&n=N    — N synthetic sprites on circles (示意 synthetic, NOT engine data) for the frame-rate budget
 * Exposes window.__harness for the Playwright bench: fps, quality, layer trace, a no-mutation check and a
 * position check (drawn engine positions = affine image of model.poseAt recomputed independently).
 */
import { LayeredRenderer } from '../../web/src/render-canvas.ts';
import { recordedRoutes, worldToScreen, type AntInput, type Camera } from '../../web/src/render-scene.ts';
import { displayPositions, poseAt, windowOf, type Experiment } from '../../web/src/model.ts';
import { antFrame, buildDayIndex, laneOffset, nextWalkStart, rosterAtStart, siteSlot, walkIntervals, anyWalking, hash32, mulberry32 } from '../../web/src/game-model.ts';

const qs = new URLSearchParams(location.search), mode = qs.get('mode') ?? 'replay', N = Number(qs.get('n') ?? 100);
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
  R.setScene({ seed: hash32(exp.spec.id), places: exp.map.places, pos, routes, sources: stateSources(), weather: d().weather });
  let idx = buildDayIndex(d()), walks = walkIntervals(d()), roster = rosterAtStart(exp, day);
  const n = pos.N00; fitCam(n.x, n.y, Math.min(canvas.clientWidth, canvas.clientHeight) / 100);
  R.warm(cam);
  const step = (now: number) => {
    const dt = stats.last ? Math.min(0.1, (now - stats.last) / 1000) : 0, fms = stats.last ? now - stats.last : null; stats.last = now; if (fms !== null) { stats.intervals.push(fms); if (stats.intervals.length > 900) stats.intervals.shift(); }
    if (!anyWalking(walks, t)) { const nx = nextWalkStart(walks, d(), t); t = nx === null ? windowOf(d()) : Math.max(t, nx - 0.05); }
    t += dt * 20 / 60;
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
    const draws = R.frame(cam, ants, dt, fms, { highlightEngine: qs.has('highlight'), labels: qs.has('labels'), showRoutes: qs.has('routes') });
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
  const places = [{ id: 'N00', name: '示意巢', bearing: null, distance_cm: null, kind: null, layout: null }];
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
    hud.innerHTML = `<b>繪圖器壓力測試</b>・${draws.length} 個合成精靈（示意 synthetic，非引擎資料）・品質 ${R.quality().level}`;
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

(window as unknown as { __harness: unknown }).__harness = {
  ready: () => stats.intervals.length > 30,
  fps: () => { const iv = [...stats.intervals].sort((a, b) => a - b), n = iv.length, m = n ? iv.reduce((s, x) => s + x, 0) / n : 0; return { samples: n, fps_mean: n ? 1000 / m : null, p50_ms: n ? iv[Math.floor(n * 0.5)] : null, p95_ms: n ? iv[Math.floor(n * 0.95)] : null }; },
  reset: () => { stats.intervals = []; longFrames.length = 0; },
  longFrames: () => longFrames,
  info: () => ({ quality: R.quality(), stats: { ...R.stats }, trace: [...R.trace], engineObjects: R.engineObjects().map((o) => ({ id: o.id, kind: o.kind, source: o.source })), weather: R.weatherDay(), checks: { ...checks, mutation: checks.mutation.slice(0, 5), position: checks.position.slice(0, 5), mutationCount: checks.mutation.length, positionErrors: checks.position.length }, canvas: [canvas.width, canvas.height] }),
};
main().catch((e) => { hud.textContent = '錯誤：' + (e as Error).message; throw e; });
