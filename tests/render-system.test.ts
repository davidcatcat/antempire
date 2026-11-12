/**
 * Layered renderer (PR B) — the drawing system stays a read-only view of the engine record:
 *  1. render modules import only viewer modules, use no unseeded randomness / clock-free state, no storage or network,
 *     do not run the engine and create no engine events;
 *  2. the layer order is the fixed 11-layer order of docs/game-art-style.md §4 and the canvas renderer draws exactly it;
 *  3. world → screen is affine: every drawn ant's engine anchor is exactly the affine image of model.poseAt (sampled
 *     over the real replays); ants in the nest / at unrecorded places are not drawn; inputs are never mutated;
 *  4. turning gaits only with an authoritative ω (the replay has none); the heading ease is bounded (display only);
 *  5. décor is deterministic and kept clear of engine places AND of recorded route segments; it is all 示意 and never a
 *     food-like kind; the engine-object registry lists only engine places with recorded positions;
 *  6. weather is a daily day state (never rain streaks); quality only steps down, on sustained (not isolated) slowness;
 *  7. the game view is not wired yet (PR C); the harness and its measured results exist.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { displayPositions, poseAt, windowOf, type Experiment } from '../web/src/model.ts';
import { antFrame, buildDayIndex, rosterAtStart, gardenBounds, walkIntervals } from '../web/src/game-model.ts';
import { groundField, valueNoise, LAYERS, CLEAR_PLACE_CM, CLEAR_ROUTE_CM, DECOR_CELL_CM, MAX_TURN_RATE, decorCell, decorRadiusCm, distToSegment, engineRegistry, isClear, keepAtLod, nextQuality, planAnts, recordedRoutes, screenToWorld, weatherState, worldToScreen, type AntInput, type AntLook, type Camera } from '../web/src/render-scene.ts';
import { walkCycles } from '../web/src/art-ant.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SRC = path.join(REPO_ROOT, 'web', 'src');

// 1. isolation
const files = fs.readdirSync(SRC).filter((f) => /^render-.*\.ts$/.test(f)).sort();
ok(files.join() === 'render-canvas.ts,render-scene.ts', `render modules: ${files.join()}`);
for (const f of files) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8'), body = code.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) ok(m[1].startsWith('./'), `${f} imports only viewer modules (${m[1]})`);
  ok(!/Math\.random|Date\.now|new Date/.test(code), `${f}: no unseeded randomness, no wall clock`);
  ok(!/localStorage|sessionStorage|fetch\(|XMLHttpRequest|WebSocket/.test(code), `${f}: no storage or network`);
  ok(!/engine\/|cli\/|simulateWorldDay|simulateDay|initializeDay0/.test(body), `${f}: does not touch the engine`);
  ok(!/events\.push|\.events\s*=|type:\s*'(food_collected|trophallaxis|worker_death|insect_predation|food_delivered|route_step|worker_activity)'/.test(code), `${f}: creates no engine events`);
}

// 2. layer order
ok(LAYERS.join() === 'ground,decals,shadows,propsLow,routes,antShadows,ants,propsHigh,lighting,weather,ui', 'the 11-layer order of the style spec');
const canvasCode = fs.readFileSync(path.join(SRC, 'render-canvas.ts'), 'utf8');
ok(/for \(const layer of LAYERS\) \{[^}]*draw\[layer\]\(\)/.test(canvasCode) && LAYERS.every((l) => new RegExp(`\\b${l}: \\(\\) =>`).test(canvasCode)), 'the canvas renderer draws every layer, in LAYERS order, from one loop');
ok(!/rainStreak|splash\(/.test(canvasCode), 'the renderer never draws rain streaks or splashes (no rain minute in the engine)');

// camera is affine
const cam: Camera = { cx: 3.5, cy: -7, s: 6.25, w: 800, h: 600 };
for (const [x, y] of [[0, 0], [12.5, -40], [-90, 33]]) { const [sx, sy] = worldToScreen(cam, x, y), [bx, by] = screenToWorld(cam, sx, sy); ok(Math.abs(bx - x) < 1e-9 && Math.abs(by - y) < 1e-9, 'screenToWorld inverts worldToScreen'); }
{ const a = worldToScreen(cam, 1, 2), b = worldToScreen(cam, 9, -4), m = worldToScreen(cam, 5, -1); ok(Math.abs((a[0] + b[0]) / 2 - m[0]) < 1e-9 && Math.abs((a[1] + b[1]) / 2 - m[1]) < 1e-9, 'midpoints are preserved (affine, no perspective)'); }

// 3–5 on every exported replay
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object') { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const index = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web', 'data', 'index.json'), 'utf8'));
let anchors = 0, decorItems = 0;
for (const meta of index.experiments) {
  const exp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web', 'data', meta.file), 'utf8')) as Experiment, pos = displayPositions(exp.map.places);
  const routes = recordedRoutes(exp, pos);
  ok(routes.length > 0 && routes.every(([a, b]) => Object.values(pos).some((p) => p.known && p.x === a.x && p.y === a.y) && Object.values(pos).some((p) => p.known && p.x === b.x && p.y === b.y)), `${meta.id}: recorded routes join known places`);
  for (const d of exp.days.filter((_, i) => i % 3 === 0)) {
    const sources = (d.day === 1 ? exp.day0.state : exp.days[d.day - 2].end_state).sources, reg = engineRegistry(exp.map.places, pos, sources);
    ok(reg.length > 0 && reg.every((o) => o.source === 'engine' && pos[o.id]?.known && o.x === pos[o.id].x && o.y === pos[o.id].y && (o.kind !== 'honeydew' || o.colonies === (sources[o.id]?.hemipteran_colonies ?? null))), `${meta.id} D${d.day}: registry = engine places with recorded positions and engine state`);
    const idx = buildDayIndex(d), roster = rosterAtStart(exp, d.day), win = windowOf(d), c: Camera = { cx: pos.N00.x, cy: pos.N00.y, s: 7.5, w: 1000, h: 700 };
    let look: ReadonlyMap<string, AntLook> = new Map();
    const times = [...Array.from({ length: 13 }, (_, k) => (win * k) / 12), ...walkIntervals(d).slice(0, 60).flatMap((w) => [w.start + (w.end - w.start) * 0.3, (w.start + w.end) / 2])].sort((x, y) => x - y);
    for (const t of times) {
      const ants: AntInput[] = deepFreeze(roster.map((id) => { const f = antFrame(idx, d, id, t, pos); return { id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: { dx: 3, dy: -2, heading: 1 } }; }));
      const before = JSON.stringify(ants), prevBefore = JSON.stringify([...look]);
      const plan = planAnts(c, ants, look, 0.05, walkCycles);
      assert.equal(JSON.stringify(ants), before, 'planAnts does not mutate its input frames'); assert.equal(JSON.stringify([...look]), prevBefore, 'planAnts does not mutate the previous look map');
      for (const dr of plan.draws) {
        const p = poseAt(d, dr.id, t, pos), [ex, ey] = worldToScreen(c, p.x, p.y), a = ants.find((x) => x.id === dr.id) as AntInput; anchors++;
        assert.ok(dr.ex === ex && dr.ey === ey && dr.sx === ex + 3 && dr.sy === ey - 2, `${dr.id} t=${t}: drawn anchor = affine(poseAt); offset is the caller's display arrangement`);
        assert.ok(a.vis === 'walking' || a.vis === 'at_site', `${dr.id}: only visible ants are drawn`);
        assert.ok(dr.gait === (a.moving ? 'walk' : 'idle'), `${dr.id}: replay (no ω) → walk / idle only`);
        const p0 = look.get(dr.id); if (p0) assert.ok(Math.abs(Math.atan2(Math.sin(dr.heading - p0.h), Math.cos(dr.heading - p0.h))) <= MAX_TURN_RATE * 0.05 + 1e-9, 'heading ease bounded (display only)');
      }
      ok(plan.draws.length === ants.filter((a) => a.vis === 'walking' || a.vis === 'at_site').length, 'in-nest and unrecorded-place ants are not drawn');
      look = plan.look;
    }
    // décor: every cell over the garden, clear of places and routes
    const ob = { places: reg.map((o) => ({ x: o.x, y: o.y, radiusCm: o.radiusCm })), routes }, b = gardenBounds(pos, 30);
    if (d.day === 1) for (let i = Math.floor(b.x0 / DECOR_CELL_CM); i <= Math.floor(b.x1 / DECOR_CELL_CM); i++) for (let j = Math.floor(b.y0 / DECOR_CELL_CM); j <= Math.floor(b.y1 / DECOR_CELL_CM); j++) {
      const cell = decorCell(1234, i, j, ob); assert.equal(JSON.stringify(cell), JSON.stringify(decorCell(1234, i, j, ob)), 'décor cell deterministic');
      for (const it of cell) {
        decorItems++; const r = decorRadiusCm(it);
        assert.ok(it.schematic === true && ['leaf', 'twig', 'pebble', 'grass', 'moss', 'debris'].includes(it.kind), 'décor is 示意 and never a food-like kind');
        assert.ok(ob.places.every((p) => Math.hypot(it.x - p.x, it.y - p.y) >= p.radiusCm + CLEAR_PLACE_CM + r) && routes.every(([p, q]) => distToSegment(it.x, it.y, p, q) >= CLEAR_ROUTE_CM + r), `décor ${it.kind} at ${it.x.toFixed(1)},${it.y.toFixed(1)} keeps clear of places and routes`);
      }
    }
  }
}
ok(anchors > 500 && decorItems > 500, `sampled ${anchors} drawn anchors, ${decorItems} décor items`);
ok(!isClear(0, 0, 0.1, { places: [{ x: 0, y: 0, radiusCm: 1 }], routes: [] }) && !isClear(5, 0.5, 0.1, { places: [], routes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] }) && isClear(5, 9, 0.1, { places: [], routes: [[{ x: 0, y: 0 }, { x: 10, y: 0 }]] }), 'clearance test rejects items on places / routes');

// 4. turning only with ω
{
  const c: Camera = { cx: 0, cy: 0, s: 10, w: 400, h: 400 }, a = (omega?: number | null): AntInput[] => [{ id: 'X', x: 0, y: 0, vis: 'walking', moving: true, heading: 0, omega }];
  const p1 = planAnts(c, a(), new Map(), 0.016, walkCycles), prev = new Map([['X', { h: 0, phase: 0, sx: 190, sy: 200 }]]);
  ok(p1.draws[0].gait === 'walk', 'no ω → walk');
  ok(planAnts(c, a(1.2), prev, 0.016, walkCycles).draws[0].gait === 'curveR' && planAnts(c, a(-1.2), prev, 0.016, walkCycles).draws[0].gait === 'curveL', 'authoritative ω while moving → curved gait');
  ok(planAnts(c, [{ ...a(1.2)[0], moving: false, vis: 'at_site' }], new Map([['X', { h: 0, phase: 0, sx: 200, sy: 200 }]]), 0.016, walkCycles).draws[0].gait === 'pivotR', 'authoritative ω while stationary → pivot');
}

// ground continuity: the world-space ground field is continuous (bounded slope, so no step at any chunk edge) and
// non-periodic (no repeat at the old tile / chunk scales), and décor density varies strongly across the garden
{
  let maxSlope = 0; for (let k = 0; k < 4000; k++) { const x = (k * 37.3) % 700 - 350, y = (k * 91.7) % 700 - 350, a = groundField(7, x, y), b = groundField(7, x + 0.01, y); maxSlope = Math.max(maxSlope, Math.abs(a.tone - b.tone) / 0.01); }
  ok(maxSlope < 0.1, `ground field is continuous (max |d tone / dx| ${maxSlope.toFixed(4)} per cm)`);
  for (const P of [8, 16, 32, 36, 64, 128]) { let d = 0, n = 0; for (let k = 0; k < 400; k++) { const x = k * 3.1, y = k * 1.7; d += Math.abs(valueNoise(3, x, y, 60) - valueNoise(3, x + P, y, 60)); n++; } ok(d / n > 0.01, `no repeat at a ${P} cm period (mean |f(x) − f(x+${P})| ${(d / n).toFixed(3)})`); }
  const ob = { places: [], routes: [] }, counts: number[] = []; for (let i = -25; i < 25; i++) for (let j = -25; j < 25; j++) counts.push(decorCell(99, i, j, ob).filter((x) => x.kind === 'leaf').length);
  const bare = counts.filter((c) => c === 0).length / counts.length, dense = counts.filter((c) => c >= 12).length / counts.length;
  ok(bare > 0.2 && dense > 0.05, `leaf litter is clustered: ${(bare * 100).toFixed(0)}% bare cells, ${(dense * 100).toFixed(0)}% cells with ≥ 12 leaves`);
  const sizes = Array.from({ length: 40 }, (_, i) => decorCell(5, i, 3, ob)).flat().filter((x) => x.kind === 'leaf').map((x) => x.sizeMm).sort((a, b) => a - b);
  ok(sizes.length > 30 && sizes[Math.floor(sizes.length / 2)] < (sizes[0] + sizes[sizes.length - 1]) / 2, 'leaf sizes are skewed small (median below mid-range)');
}

// 6. weather and quality
for (const w of [{ air_temp_c: 25, nest_temp_c: 25, rain_mm: 0, wet: false }, { air_temp_c: 25, nest_temp_c: 25, rain_mm: 5.2, wet: true }]) { const s = weatherState(w); ok(s.rainStreaks === false && /日值/.test(s.label) && s.wet === w.wet && s.overcast === w.rain_mm > 0, 'weather = labelled daily state, never rain streaks'); }
ok(nextQuality(0, Array(60).fill(30)) === 1 && nextQuality(1, Array(60).fill(10)) === 1 && nextQuality(3, Array(60).fill(90)) === 3, 'quality steps down on sustained slowness and never up');
ok(nextQuality(0, [...Array(50).fill(16.7), ...Array(10).fill(200)]) === 0, 'isolated spikes do not lower quality');
ok(keepAtLod({ kind: 'debris', x: 0, y: 0, rot: 0, sizeMm: 10, seed: 1, schematic: true }, 1) === false && keepAtLod({ kind: 'leaf', x: 0, y: 0, rot: 0, sizeMm: 30, seed: 1, schematic: true }, 1), 'décor LOD drops only small items');

// 7. not wired yet; harness present
const game = fs.readFileSync(path.join(SRC, 'game.ts'), 'utf8');
ok(!/from '\.\/render-/.test(game), 'the game view is not wired to the renderer yet (PR C)');
const H = path.join(REPO_ROOT, 'prototypes', 'render-harness');
ok(fs.existsSync(path.join(H, 'harness.ts')) && fs.existsSync(path.join(H, 'bench.cjs')), 'standalone harness exists');
ok(/^prototypes\/render-harness\/screenshots\/$/m.test(fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8')) && /mkdirSync\(OUT/.test(fs.readFileSync(path.join(H, 'bench.cjs'), 'utf8')), 'bench screenshots are generated into the git-ignored screenshots/ folder, not committed');
const res = JSON.parse(fs.readFileSync(path.join(H, 'results.json'), 'utf8'));
ok(['desktop', 'pixel7', 'pixel7-cpu4x'].every((p) => ['replay', 'stress100', 'stress1000'].every((m) => res.rows.some((r: { profile: string; mode: string; fps_mean: number }) => r.profile === p && r.mode === m && r.fps_mean > 0))), 'measured results for 3 profiles × 3 modes are committed');
ok(Array.isArray(res.seams) && res.seams.length >= 4 && res.seams.every((x: { max_seam_ratio: number; ordinary_column_p99_ratio: number; periodic_amp: number; seams: number }) => x.seams > 0 && x.max_seam_ratio <= 1.6 && x.max_seam_ratio <= x.ordinary_column_p99_ratio + 0.2 && x.periodic_amp <= 0.04), 'browser seam check: chunk boundaries are no steeper than ordinary columns and no visible periodic repeat');
ok(res.rows.filter((r: { mode: string; positions_checked?: number }) => r.mode === 'replay').every((r: { positions_checked?: number }) => (r.positions_checked ?? 0) > 0), 'browser replay runs checked drawn positions against poseAt');

console.log(JSON.stringify({ test: 'render-system', passed: true, checks, anchors, decorItems }));
