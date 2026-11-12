/**
 * Render comparison page (Issue #159, Owner decision 25). One scene, one animation, one camera, three ant drawers:
 *   ?r=A  Canvas 2D LayeredRenderer, one rotated atlas blit per ant (current)
 *   ?r=B  Canvas 2D LayeredRenderer + pre-rotated sprite atlas (antSprites: 'prerotated')
 *   ?r=C  LayeredRenderer for every other layer + PixiJS/WebGL batched sprites for the two ant layers (pixi-ants.ts),
 *         layers above the ants on a transparent 2D overlay, so the 11-layer stacking order is unchanged
 * Modes:
 *   ?mode=replay        real experiment replay (web/data, read only): positions via game-model.antFrame (= model.poseAt),
 *                       game-view frame options (colour variants, display turns, min ant px from the screen)
 *   ?mode=stress&n=N    N synthetic sprites on circles (示範 synthetic positions, NOT engine data), 60 cm view
 *   ?mode=probe         24 isolated synthetic sprites at fixed positions / headings for pixel sampling (示範)
 * The animation advances by a FIXED step per frame (1/60 s), so frame k has identical inputs in A, B and C; the
 * renderer never feeds anything back (input hash per frame is exposed and compared by bench.cjs).
 */
import { LayeredRenderer, type RendererOptions } from '../../../web/src/render-canvas.ts';
import { recordedRoutes, worldToScreen, type AntInput, type Camera } from '../../../web/src/render-scene.ts';
import { displayPositions, poseAt, windowOf, type Experiment } from '../../../web/src/model.ts';
import { antFrame, buildDayIndex, laneOffset, nextWalkStart, rosterAtStart, siteSlot, walkIntervals, anyWalking, hash32, mulberry32 } from '../../../web/src/game-model.ts';
import { PixiAnts } from './pixi-ants.ts';

const qs = new URLSearchParams(location.search), which = (qs.get('r') ?? 'A') as 'A' | 'B' | 'C', mode = qs.get('mode') ?? 'replay', N = Number(qs.get('n') ?? 100);
const fixedQuality = Number(qs.get('q') ?? 1) as 0 | 1 | 2 | 3, STEP = 1 / 60;
const canvas = document.getElementById('scene') as HTMLCanvasElement, glCanvas = document.getElementById('gl') as HTMLCanvasElement, above = document.getElementById('above') as HTMLCanvasElement, hud = document.getElementById('hud') as HTMLElement;
let pixi: PixiAnts | null = null;
const opts: RendererOptions = { fixedQuality, recordBlits: true, antSprites: which === 'B' ? 'prerotated' : 'rotate', rotSheetPx: qs.has('sheet') ? Number(qs.get('sheet')) : undefined, atlasBudgetBytes: qs.has('budget') ? Number(qs.get('budget')) * 1048576 : undefined };
if (which === 'C') { glCanvas.hidden = false; above.hidden = false; }
let R: LayeredRenderer;
const st = { intervals: [] as number[], cpu: [] as number[], antMs: [] as number[], last: 0, frames: 0, hash: 2166136261 >>> 0, hashFrames: 0, ready: false, error: null as string | null };
const checks = { position: [] as string[], positionsChecked: 0, anchor: [] as string[], anchorsChecked: 0, maxBucketErr: 0, mutation: 0 };
let cam: Camera = { cx: 0, cy: 0, s: 4, w: 1, h: 1 };
const fit = (cx: number, cy: number, s: number) => { cam = { cx, cy, s, w: canvas.clientWidth, h: canvas.clientHeight }; };
const dprOf = () => canvas.width / Math.max(1, canvas.clientWidth);
function sizeOverlays() {
  if (which !== 'C' || !pixi) return;
  if (above.width !== canvas.width || above.height !== canvas.height) { above.width = canvas.width; above.height = canvas.height; }
  pixi.resize(canvas.clientWidth, canvas.clientHeight, dprOf());
}
const mix = (s: string) => { for (let i = 0; i < s.length; i++) { st.hash ^= s.charCodeAt(i); st.hash = Math.imul(st.hash, 16777619) >>> 0; } };

/** one measured frame: draw, time it, check it */
function measured(now: number, ants: AntInput[], frameOpts: Parameters<LayeredRenderer['frame']>[4], expect?: (id: string) => [number, number]) {
  const fms = st.last ? now - st.last : null; st.last = now; if (fms !== null) { st.intervals.push(fms); if (st.intervals.length > 4000) st.intervals.shift(); }
  if (st.hashFrames < 10) { mix(JSON.stringify(ants)); st.hashFrames++; }
  const before = st.frames % 30 === 0 ? JSON.stringify(ants) : null;
  sizeOverlays();
  const t0 = performance.now(), draws = R.frame(cam, ants, STEP, fms, frameOpts), t1 = performance.now();
  st.cpu.push(t1 - t0); st.antMs.push((R.stats.lastMs.antShadows ?? 0) + (R.stats.lastMs.ants ?? 0)); if (st.cpu.length > 4000) { st.cpu.shift(); st.antMs.shift(); }
  if (before !== null && JSON.stringify(ants) !== before) checks.mutation++;
  st.frames++;
  if (st.frames % 10 === 0) {
    // drawn engine anchor = affine image of the position (replay: poseAt recomputed independently); the blit / sprite
    // anchor = the planned screen position (display offset included); heading within the bucket tolerance
    const anchors = which === 'C' ? (pixi as PixiAnts).anchors : R.blits;
    const plan = new Map(draws.map((d) => [d.id, d]));
    for (const d of draws) if (expect) { const [ex, ey] = expect(d.id); checks.positionsChecked++; if (Math.abs(ex - d.ex) > 1e-6 || Math.abs(ey - d.ey) > 1e-6) checks.position.push(`${d.id} f${st.frames}`); }
    for (const b of anchors) {
      const d = plan.get(b.id); checks.anchorsChecked++; if (!d) { checks.anchor.push(`${b.id}: no plan`); continue; }
      if (Math.abs(b.ax - d.sx) > 1e-6 || Math.abs(b.ay - d.sy) > 1e-6) checks.anchor.push(`${b.id} f${st.frames} anchor`);
      const e = Math.abs(Math.atan2(Math.sin(b.heading - d.heading), Math.cos(b.heading - d.heading))); checks.maxBucketErr = Math.max(checks.maxBucketErr, e);
      if (e > (b.n ? Math.PI / b.n : 0) + 1e-9) checks.anchor.push(`${b.id} f${st.frames} heading ${e}`);
    }
  }
  return draws;
}

async function init() {
  R = new LayeredRenderer(canvas, opts);
  R.resize();
  if (which === 'C') {
    pixi = await PixiAnts.create(glCanvas, canvas.clientWidth, canvas.clientHeight, dprOf());
    opts.externalAnts = { draw: (layer, draws, info) => (pixi as PixiAnts).draw(layer, draws, info), above: above.getContext('2d') as CanvasRenderingContext2D };
    sizeOverlays();
  }
  if (mode === 'stress') return stress();
  if (mode === 'probe') return probe();
  return replay();
}

async function replay() {
  const index = await (await fetch('/web/data/index.json')).json() as { experiments: { file: string }[] };
  const exp = await (await fetch('/web/data/' + index.experiments[0].file)).json() as Experiment;
  const pos = displayPositions(exp.map.places), routes = recordedRoutes(exp, pos);
  let day = 1, t = 0;
  const d = () => exp.days[day - 1], stateSources = () => (day === 1 ? exp.day0.state : exp.days[day - 2].end_state).sources;
  R.setScene({ seed: hash32(exp.spec.id), places: exp.map.places, pos, routes, sources: stateSources(), weather: d().weather });
  let idx = buildDayIndex(d()), walks = walkIntervals(d()), roster = rosterAtStart(exp, day);
  const counts = new Map<string, number>(); for (const dd of exp.days) for (const e of dd.events) if (e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>')) { const [a, b] = e.place.split('>'); const f = a === 'N00' ? b : a; if (pos[f]?.known && f !== 'N00') counts.set(f, (counts.get(f) ?? 0) + 1); }
  const top = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'N00', pts = [pos.N00, pos[top]];
  const bx0 = Math.min(...pts.map((p) => p.x)), bx1 = Math.max(...pts.map((p) => p.x)), by0 = Math.min(...pts.map((p) => p.y)), by1 = Math.max(...pts.map((p) => p.y)), pad = 9;
  fit((bx0 + bx1) / 2, (by0 + by1) / 2, Math.min(canvas.clientWidth / (bx1 - bx0 + 2 * pad), canvas.clientHeight / (by1 - by0 + 2 * pad)));
  R.warm(cam);
  const minAntPx = () => Math.max(36, Math.round(Math.min(canvas.clientWidth, canvas.clientHeight) * 0.08)); // = game.ts
  const step = (now: number) => {
    if (!anyWalking(walks, t)) { const nx = nextWalkStart(walks, d(), t); t = nx === null ? windowOf(d()) : Math.max(t, nx - 0.05); }
    t += STEP * 20 / 60;
    if (t >= windowOf(d())) { day = day % exp.days.length + 1; t = 0; idx = buildDayIndex(d()); walks = walkIntervals(d()); roster = rosterAtStart(exp, day); R.setEngineState(stateSources(), d().weather); }
    fit(cam.cx, cam.cy, cam.s);
    const L = Math.max(minAntPx(), 0.25 * cam.s);
    const ants: AntInput[] = roster.map((id) => {
      const f = antFrame(idx, d(), id, t, pos); let off: AntInput['displayOffset'];
      if (f.vis === 'walking' && f.heading !== null) { const o = laneOffset(id) * L * 0.55, h = -f.heading; off = { dx: -Math.sin(h) * o, dy: Math.cos(h) * o }; }
      else { const s = siteSlot(id), k = Math.min(1.4, L / 26); off = { dx: s.dx * k, dy: s.dy * k, heading: s.heading }; }
      return { id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: off };
    });
    const draws = measured(now, ants, { displayTurns: true, colourVariants: true, minAntPx: minAntPx() }, (id) => { const p = poseAt(d(), id, t, pos); return worldToScreen(cam, p.x, p.y); });
    hud.textContent = `繪圖比較 ${which}・重播引擎紀錄（非正式實驗世界）・第 ${day} 日 ${t.toFixed(1)} 分・畫出 ${draws.length} 隻`;
    st.ready = st.intervals.length > 30; requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function stress() {
  const places = [{ id: 'N00', name: '示範巢', bearing: null, distance_cm: null, kind: null, layout: null }];
  R.setScene({ seed: 4242, places, pos: { N00: { x: 0, y: 0, known: true } }, routes: [], sources: {}, weather: null });
  fit(0, 0, Math.min(canvas.clientWidth, canvas.clientHeight) / 60); R.warm(cam);
  const r = mulberry32(99), ants = Array.from({ length: N }, (_, i) => ({ id: `S${i}`, cx: (r() - 0.5) * 50, cy: (r() - 0.5) * 50, rad: 2 + r() * 8, w: (0.2 + r() * 0.4) * (r() < 0.5 ? -1 : 1), p0: r() * 6.283 }));
  let tt = 0;
  const step = (now: number) => {
    tt += STEP; fit(0, 0, cam.s);
    const input: AntInput[] = ants.map((a) => { const ang = a.p0 + a.w * tt; return { id: a.id, x: a.cx + Math.cos(ang) * a.rad, y: a.cy + Math.sin(ang) * a.rad, vis: 'walking', moving: true, heading: ang + Math.sign(a.w) * Math.PI / 2 }; });
    const draws = measured(now, input, { colourVariants: true, minAntPx: 26 }, (id) => { const a = input[Number(id.slice(1))]; return worldToScreen(cam, a.x, a.y); });
    hud.textContent = `繪圖比較 ${which}・${draws.length} 個合成精靈（示範 synthetic，非引擎資料）`;
    st.ready = st.intervals.length > 30; requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** isolated sprites for pixel sampling: frame 0 without ants, frame 1 with ants (dt 0: drawn heading = input) */
let probeOut: unknown = null;
function probe() {
  const places = [{ id: 'N00', name: '示範巢', bearing: null, distance_cm: null, kind: null, layout: null }];
  R.setScene({ seed: 4242, places, pos: { N00: { x: -1000, y: -1000, known: true } }, routes: [], sources: {}, weather: null, decor: false });
  fit(0, 0, Math.min(canvas.clientWidth, canvas.clientHeight) / 40); R.warm(cam);
  const r = mulberry32(159), cols = 6, rows = 4, L = 48, ants: AntInput[] = [];
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const k = j * cols + i, [x, y] = [(i - (cols - 1) / 2) * (cam.w / cols) / cam.s, -((j - (rows - 1) / 2) * (cam.h / rows) / cam.s)];
    ants.push({ id: `P${k}`, x, y, vis: 'walking', moving: false, heading: k < 12 ? (k * Math.PI) / 6 + 0.01 : r() * Math.PI * 2 });
  }
  const composite = () => { const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; const g = c.getContext('2d') as CanvasRenderingContext2D; g.drawImage(canvas, 0, 0); if (which === 'C') { g.drawImage(glCanvas, 0, 0); g.drawImage(above, 0, 0); } return g.getImageData(0, 0, c.width, c.height).data; };
  const run = () => {
    sizeOverlays(); R.resetMotion();
    R.frame(cam, [], 0, null, { minAntPx: L, colourVariants: true }); const bg = composite();
    R.resetMotion(); const draws = R.frame(cam, ants, 0, null, { minAntPx: L, colourVariants: true }); const fg = composite();
    const D = dprOf(), W = canvas.width, out = [];
    for (const d of draws) {
      // ant pixels = |fg − bg| above a threshold inside a 0.8 L window; weighted centroid + principal axis
      let m = 0, mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0; const R0 = Math.ceil(0.8 * L * D), cx = Math.round(d.sx * D), cy = Math.round(d.sy * D);
      for (let y = cy - R0; y <= cy + R0; y++) for (let x = cx - R0; x <= cx + R0; x++) {
        const q = (y * W + x) * 4, v = Math.abs(fg[q] - bg[q]) + Math.abs(fg[q + 1] - bg[q + 1]) + Math.abs(fg[q + 2] - bg[q + 2]); if (v < 24) continue;
        const X = x + 0.5 - d.sx * D, Y = y + 0.5 - d.sy * D; m += v; mx += v * X; my += v * Y; sxx += v * X * X; syy += v * Y * Y; sxy += v * X * Y;
      }
      mx /= m; my /= m; const cxx = sxx / m - mx * mx, cyy = syy / m - my * my, cxy = sxy / m - mx * my, axis = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
      out.push({ id: d.id, heading: d.heading, centroid: [mx / D, my / D], axis, mass: m });
    }
    probeOut = { L, dpr: D, ants: out, blits: (which === 'C' ? (pixi as PixiAnts).anchors : R.blits).map((b) => ({ ...b })), draws: draws.map((d) => ({ id: d.id, sx: d.sx, sy: d.sy, ex: d.ex, ey: d.ey, heading: d.heading })) };
    st.ready = true;
  };
  requestAnimationFrame(() => requestAnimationFrame(() => { run(); setTimeout(run, 300); }));
}

const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null; };
(window as unknown as { __cmp: unknown }).__cmp = {
  ready: () => st.ready, error: () => st.error,
  reset: () => { st.intervals = []; st.cpu = []; st.antMs = []; },
  fps: () => { const iv = st.intervals, n = iv.length, m = n ? iv.reduce((s, x) => s + x, 0) / n : 0; return { samples: n, fps_mean: n ? 1000 / m : null, p50_ms: q(iv, 0.5), p95_ms: q(iv, 0.95), p99_ms: q(iv, 0.99), max_ms: n ? Math.max(...iv) : null, cpu_mean_ms: st.cpu.length ? st.cpu.reduce((s, x) => s + x, 0) / st.cpu.length : null, cpu_p95_ms: q(st.cpu, 0.95), ant_layers_mean_ms: st.antMs.length ? st.antMs.reduce((s, x) => s + x, 0) / st.antMs.length : null }; },
  info: () => ({ renderer: which, mode, n: N, frames: st.frames, input_hash: st.hash, hash_frames: st.hashFrames, quality: R.quality().level, canvas: [canvas.width, canvas.height], dpr: dprOf(),
    heap: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null,
    ant_texture_bytes: which === 'C' ? (pixi as PixiAnts).textureBytes() : R.antTextureBytes(), chunk_bytes: R.chunkBytes(), ant_stats: { ...R.antStats }, layer_ms: { ...R.stats.layerMs }, pixi: pixi?.describe() ?? null,
    checks: { ...checks, position: checks.position.slice(0, 5), anchor: checks.anchor.slice(0, 5), positionErrors: checks.position.length, anchorErrors: checks.anchor.length } }),
  probe: () => probeOut,
};
init().catch((e) => { st.error = String((e as Error).stack ?? e); hud.textContent = '錯誤：' + (e as Error).message; });
