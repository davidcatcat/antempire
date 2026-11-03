/**
 * PH-1 (Issue #68): physical-space geometry, validation and passability on SYNTHETIC scenarios (scenarios/physics/*).
 * Engineering tests only: they show the geometry and the passability rule are correct on declared synthetic worlds;
 * they say nothing about the real (mostly unknown) garden geometry or about ant biology.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { validateGeometry, traverse, physicsReady, passageSlopes, surfacesAt } from '../engine/physics/geometry.ts';
import { polylineLength, segmentsIntersect2D } from '../engine/physics/vec.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const dir = path.join(REPO_ROOT, 'scenarios/physics');
const load = (n: string): PhysicsGeometry => JSON.parse(fs.readFileSync(path.join(dir, `${n}.geometry.json`), 'utf8'));
const body = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.body-candidates.json'), 'utf8'));
const [minorLo, minorHi] = body.castes.minor.effective_collision_width_mm.candidate_range as [number, number];
const [majorLo, majorHi] = body.castes.major.effective_collision_width_mm.candidate_range as [number, number];
const codes = (d: unknown, o?: Any) => validateGeometry(d, o).map((i) => i.code);
const mut = (n: string, f: (d: Any) => void) => { const d = structuredClone(load(n)) as Any; f(d); return d; };

// --- every synthetic scenario is valid, labelled synthetic, and does not claim the official world
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.geometry.json')).map((f) => f.replace('.geometry.json', '')).sort();
ok(names.join(',') === 'crossing,multi-level,narrow-corridor,nest-entrance,open-plane,stone-road', `scenarios present: ${names}`);
for (const n of names) {
  const g = load(n), issues = validateGeometry(g);
  ok(issues.length === 0, `${n}: valid (${JSON.stringify(issues)})`);
  ok(g.synthetic === true && g.world_id.startsWith('synthetic-'), `${n}: labelled synthetic`);
}
// body candidates: values with literature support are the ones Yuan 2026 reports; the collision widths are unknown
ok(body.castes.minor.body_length_mm.value === 2.5 && body.castes.major.head_width_mm.value === 1.3, 'body: literature values (Yuan 2026)');
ok(body.castes.minor.effective_collision_width_mm.value === null && body.castes.minor.effective_collision_width_mm.assumption === true, 'body: minor collision width is unknown (candidate range only)');

// --- open plane: any body passes; length exact
{ const g = load('open-plane'); for (const w of [minorLo, majorHi, 10]) { const t = traverse(g, 'P-open', w); ok(t.passable === true && t.blocks.length === 0 && t.length_mm === 500, `open: width ${w} passes, 500 mm`); } }

// --- stone in the road: the straight lane is blocked at the stone; the detour passes and is longer
{
  const g = load('stone-road');
  for (const w of [minorLo, majorHi]) {
    const s = traverse(g, 'P-straight', w), d = traverse(g, 'P-detour', w);
    ok(s.passable === false && s.blocks[0].ref === 'obstacles/O-stone' && Math.abs(s.blocks[0].s_mm - 250) < 1e-6, `stone: straight lane blocked at s=250 mm for width ${w} (${JSON.stringify(s.blocks)})`);
    ok(d.passable === true, `stone: detour passes for width ${w}`);
    ok(d.length_mm > s.length_mm, `stone: detour ${d.length_mm.toFixed(3)} mm is longer than the straight lane ${s.length_mm} mm`);
  }
  // a body cannot pass through the stone by being thin: even a 0.01 mm body is blocked (the lane crosses the footprint)
  ok(traverse(g, 'P-straight', 0.01).passable === false, 'stone: no width passes through a footprint');
}

// --- narrow corridor (1.0 mm): a minor-sized body passes; two abreast or a major cannot
{
  const g = load('narrow-corridor');
  ok(traverse(g, 'P-corridor', minorLo).passable === true && traverse(g, 'P-corridor', minorHi).passable === true, `corridor: one minor (${minorLo}–${minorHi} mm) passes`);
  // whether two minors can walk abreast (and so pass each other) depends on the UNKNOWN collision width: at the low
  // candidate (2 × 0.5 = 1.0 mm) they exactly fit, at the high candidate they do not. Reported, not resolved.
  ok(traverse(g, 'P-corridor', 2 * minorLo).passable === true, `corridor: two minors abreast at the low width candidate (${2 * minorLo} mm) exactly fit`);
  const two = traverse(g, 'P-corridor', 2 * minorHi);
  ok(two.passable === false && two.blocks.some((b) => b.kind === 'passage_width'), `corridor: two minors abreast at the high width candidate (${2 * minorHi} mm) do not fit`);
  const maj = traverse(g, 'P-corridor', majorLo);
  ok(maj.passable === false && maj.blocks.some((b) => b.ref.startsWith('obstacles/O-wall')), `corridor: a major (head ${majorLo} mm) is blocked by the walls (${JSON.stringify(maj.blocks.map((b) => b.ref))})`);
}

// --- crossing: both lanes pass and they actually cross
{
  const g = load('crossing'), a = g.passages[0].centerline_mm, b = g.passages[1].centerline_mm;
  ok(traverse(g, 'P-east-west', minorHi).passable === true && traverse(g, 'P-north-south', minorHi).passable === true, 'crossing: both lanes pass');
  ok(segmentsIntersect2D({ x: a[0][0], y: a[0][1] }, { x: a[1][0], y: a[1][1] }, { x: b[0][0], y: b[0][1] }, { x: b[1][0], y: b[1][1] }), 'crossing: the lanes intersect');
}

// --- nest entrance (aperture 1.6 mm): workers pass, a 3 mm prey load does not
{
  const g = load('nest-entrance');
  ok(traverse(g, 'P-entry', minorHi).passable === true, 'entrance: minor passes');
  ok(traverse(g, 'P-entry', majorLo).passable === true, 'entrance: major head width passes');
  const load3 = traverse(g, 'P-entry', 3.0);
  ok(load3.passable === false && load3.blocks.length === 1 && load3.blocks[0].ref === 'entrances/E-nest' && Math.abs(load3.blocks[0].s_mm - 100) < 1e-6, `entrance: a 3 mm load is stopped at the entrance (s=100 mm) (${JSON.stringify(load3.blocks)})`);
}

// --- 2.5D: the ramp is walkable with grade 0.2 and its 3D length counts the climb; a cliff is not
{
  const g = load('multi-level'), p = g.passages[0], sl = passageSlopes(p);
  ok(Math.abs(sl[1].grade - 0.2) < 1e-12 && sl[0].grade === 0 && sl[2].grade === 0, `multi-level: grades ${sl.map((s) => s.grade)}`);
  ok(Math.abs(traverse(g, 'P-ramp', minorHi).length_mm - (50 + Math.hypot(100, 20) + 50)) < 1e-9, 'multi-level: 3D length includes the ramp');
  ok(surfacesAt(g, { x: 150, y: 0, z: 10 }).length === 1 && surfacesAt(g, { x: 150, y: 0, z: 0 }).length === 0, 'multi-level: mid-ramp elevation is 10 mm');
  const cliff = mut('multi-level', (d) => { d.passages.push({ ...d.passages[0], id: 'P-cliff', centerline_mm: [[50, 5, 0], [99, 5, 0], [99, 5, 20], [250, 5, 20]] }); });
  ok(codes(cliff).includes('G6'), 'multi-level: a vertical jump with no ramp is rejected (G6)');
  const off = mut('multi-level', (d) => { d.passages[0].centerline_mm[3] = [350, 0, 20]; });
  ok(codes(off).includes('G6'), 'multi-level: a lane leaving every surface is rejected (G6)');
}

// --- unknown stays unknown: a null width or obstacle height makes passability 'unknown', never true
{
  const w = mut('open-plane', (d) => { d.passages[0].width_mm = null; });
  ok(validateGeometry(w).length === 0 && traverse(w, 'P-open', minorLo).passable === 'unknown' && physicsReady(w, 'P-open').unknown.includes('passages/P-open/width_mm'), 'unknown width -> passable unknown');
  const h = mut('stone-road', (d) => { d.obstacles[0].height_mm = null; });
  const t = traverse(h, 'P-straight', minorLo);
  ok(t.passable === 'unknown' && t.unknown.includes('obstacles/O-stone/height_mm'), `unknown obstacle height -> unknown (${JSON.stringify(t)})`);
  const a = mut('nest-entrance', (d) => { d.entrances[0].aperture_width_mm = null; });
  ok(traverse(a, 'P-entry', 3.0).passable === 'unknown', 'unknown aperture -> unknown, not passable');
}

// --- negative validation fixtures
ok(codes(mut('open-plane', (d) => { d.passages[0].provenance.source = 'derived_display'; })).includes('G2'), 'a renderer-derived position is rejected (G2)');
ok(codes(mut('open-plane', (d) => { delete d.surfaces[0].provenance; })).includes('G2'), 'missing provenance is rejected (G2)');
ok(codes(mut('open-plane', (d) => { d.world_id = 'xitun-garden'; })).includes('G1'), 'a synthetic document claiming the official world is rejected (G1)');
ok(codes(mut('open-plane', (d) => { d.synthetic = false; })).includes('G1'), 'synthetic features in a non-synthetic document are rejected (G1)');
ok(codes(mut('open-plane', (d) => { d.frame.units = 'cm'; })).includes('G1'), 'non-mm units are rejected (G1)');
ok(codes(mut('stone-road', (d) => { d.passages[1].id = 'P-straight'; })).includes('G3'), 'duplicate ids are rejected (G3)');
ok(codes(mut('open-plane', (d) => { d.surfaces[0].polygon_mm = [[0, 0], [10, 10], [10, 0], [0, 10]]; })).includes('G4'), 'a self-intersecting polygon is rejected (G4)');
ok(codes(mut('open-plane', (d) => { d.passages[0].width_mm = -1; })).includes('G5'), 'a negative width is rejected (G5)');
ok(codes(mut('nest-entrance', (d) => { d.entrances[0].position_mm = [100, 5, 0]; })).includes('G7'), 'an entrance off its passage is rejected (G7)');
ok(codes(mut('open-plane', (d) => { d.passages[0].route_edge_ref = 'N00:F99'; }), { routeEdges: new Set(['F01:N00']) }).includes('G8'), 'a passage tied to an edge that is not in the route graph is rejected (G8)');
assert.throws(() => traverse(load('open-plane'), 'P-open', 0), /positive/); checks++;
ok(polylineLength([{ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }]) === 5, 'polyline length');

console.log(JSON.stringify({ ph1_geometry: 'pass', checks, scenarios: names }, null, 2));
