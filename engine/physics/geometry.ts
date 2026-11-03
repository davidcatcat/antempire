/**
 * PH-1 (Issue #68): physical space for the physics layer: a 2.5D extension of the P1-B shared geometry schema
 * (`antempire.world-geometry.v1`, docs/research-design-p1b-nest-space.md §2) with surfaces, static obstacles,
 * walkable passages (lane centre-lines with widths), nest entrances and provenance on every feature.
 *
 * Status and limits (read before use):
 * - This module is NOT imported by the simulation core (engine/day.ts and the modules it calls). It changes no game
 *   output. Joining the day loop is a later rules-update PR (tests/physics-isolation.test.ts enforces this).
 * - The xitun garden geometry is mostly unknown (P1-B §1). Physics runs only on documents whose features are all known;
 *   anything null is reported `unknown`, never filled in, and a renderer position (`derived_display`) is never
 *   accepted as physical geometry. The first documents are synthetic scenarios, labelled `synthetic: true`.
 * - Model of space (engineering approximation, Issue #68 principle 2): ants move on passage centre-lines (lanes);
 *   a passage has a usable width; obstacles are 2D footprints (circle / simple polygon) taller than an ant unless
 *   declared otherwise. 2.5D: every surface has an elevation (flat) or a planar ramp; a lane may change height only
 *   over a declared ramp. Climbing vertical faces is not modelled (ants can climb; this is a stated limit).
 *
 * Units: mm (lengths), degrees only in reports. Pure; no platform APIs.
 */
import { dist, pointInPolygon, pointSegment2D, polygonArea, polygonIsSimple, polylineLength, segmentsIntersect2D } from './vec.ts';
import type { Vec2, Vec3 } from './vec.ts';

export const GEOMETRY_SCHEMA = 'antempire.world-geometry.v1';
export const PHYSICS_SCHEMA = 'antempire.physics-geometry.v1';
/** Provenance values (P1-B §2.3) plus `synthetic_scenario` for synthetic test worlds. */
export const PROVENANCE = ['synthetic_scenario', 'scenario_assumption', 'narrative_legacy', 'derived_display', 'literature_prior', 'real_world_reference', 'measured'] as const;
export type ProvenanceSource = (typeof PROVENANCE)[number];
export interface Provenance { source: ProvenanceSource; assumption: boolean; basis: string; note?: string; measurement_ref?: string | null }

export interface FlatElevation { kind: 'flat'; z_mm: number | null }
/** Planar ramp: z = z0 + g·((p − anchor)·direction), direction a unit vector in the plane. */
export interface RampElevation { kind: 'ramp'; anchor_mm: [number, number]; z0_mm: number; direction: [number, number]; gradient: number }
export interface Surface { id: string; material: string | null; polygon_mm: [number, number][]; elevation: FlatElevation | RampElevation; provenance: Provenance }
export type ObstacleShape = { type: 'circle'; center_mm: [number, number]; radius_mm: number } | { type: 'polygon'; points_mm: [number, number][] };
export interface Obstacle { id: string; kind: string; shape: ObstacleShape; height_mm: number | null; provenance: Provenance }
export interface Passage { id: string; centerline_mm: [number, number, number][]; width_mm: number | null; route_edge_ref: string | null; provenance: Provenance }
export interface Entrance { id: string; passage_ref: string; position_mm: [number, number, number]; aperture_width_mm: number | null; aperture_height_mm: number | null; nest_ref: string | null; provenance: Provenance }
export interface PhysicsGeometry {
  schema: typeof GEOMETRY_SCHEMA; physics_schema: typeof PHYSICS_SCHEMA; world_id: string; geometry_version: string;
  synthetic: boolean; synthetic_note?: string;
  frame: { units: 'mm'; axes: { x: string; y: string; z: string }; origin: string };
  surfaces: Surface[]; obstacles: Obstacle[]; passages: Passage[]; entrances: Entrance[];
}

/** World ids that are real (official) worlds: a synthetic document may never claim them. */
export const OFFICIAL_WORLD_IDS: ReadonlySet<string> = new Set(['xitun-garden']);
/** Tolerance for "lies on" checks (mm). */
export const ON_TOLERANCE_MM = 1e-6;
/** Spacing of the samples used to check that a lane segment stays on surfaces (mm). */
export const SURFACE_SAMPLE_MM = 0.5;

const v2 = (a: [number, number]): Vec2 => ({ x: a[0], y: a[1] });
const v3 = (a: [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Elevation of a surface at (x, y), or null when unknown. */
export function surfaceZ(s: Surface, p: Vec2): number | null {
  const e = s.elevation;
  if (e.kind === 'flat') return e.z_mm;
  return e.z0_mm + e.gradient * ((p.x - e.anchor_mm[0]) * e.direction[0] + (p.y - e.anchor_mm[1]) * e.direction[1]);
}
/** Surfaces under (x, y) whose elevation equals z (within tolerance). */
export function surfacesAt(g: PhysicsGeometry, p: Vec3): Surface[] {
  return g.surfaces.filter((s) => pointInPolygon({ x: p.x, y: p.y }, s.polygon_mm.map(v2)) && (() => { const z = surfaceZ(s, p); return z !== null && Math.abs(z - p.z) <= 1e-6 * Math.max(1, Math.abs(z)); })());
}

/** Distance (2D) from point p to an obstacle's footprint boundary; negative inside. */
export function obstacleDistance(o: Obstacle, p: Vec2): number {
  if (o.shape.type === 'circle') return Math.hypot(p.x - o.shape.center_mm[0], p.y - o.shape.center_mm[1]) - o.shape.radius_mm;
  const poly = o.shape.points_mm.map(v2);
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, pointSegment2D(p, poly[j], poly[i]).d);
  return pointInPolygon(p, poly) ? -d : d;
}
/** Minimum 2D distance from segment ab to an obstacle footprint (≤ 0 when the segment touches or crosses it). */
export function segmentObstacleDistance(o: Obstacle, a: Vec2, b: Vec2): number {
  if (o.shape.type === 'circle') return pointSegment2D(v2(o.shape.center_mm), a, b).d - o.shape.radius_mm;
  const poly = o.shape.points_mm.map(v2);
  if (pointInPolygon(a, poly) || pointInPolygon(b, poly)) return -1;
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    if (segmentsIntersect2D(a, b, poly[j], poly[i])) return 0;
    d = Math.min(d, pointSegment2D(poly[i], a, b).d, pointSegment2D(a, poly[j], poly[i]).d, pointSegment2D(b, poly[j], poly[i]).d);
  }
  return d;
}

export interface GeometryIssue { code: string; ref: string; message: string }
/**
 * Validate a physics geometry document (codes G1–G8). Returns every problem found; an empty list means the document
 * is structurally valid. Validity does not mean every feature is known: see `physicsReady`.
 */
export function validateGeometry(doc: unknown, opts: { routeEdges?: ReadonlySet<string> } = {}): GeometryIssue[] {
  const out: GeometryIssue[] = [], bad = (code: string, ref: string, message: string) => out.push({ code, ref, message });
  const g = doc as PhysicsGeometry;
  if (typeof doc !== 'object' || doc === null) return [{ code: 'G1', ref: '/', message: 'document is not an object' }];
  if (g.schema !== GEOMETRY_SCHEMA || g.physics_schema !== PHYSICS_SCHEMA) bad('G1', '/', `schema must be ${GEOMETRY_SCHEMA} + ${PHYSICS_SCHEMA}`);
  if (typeof g.synthetic !== 'boolean') bad('G1', '/synthetic', 'synthetic must be true or false');
  if (g.frame?.units !== 'mm') bad('G1', '/frame/units', 'physics geometry is in millimetres');
  const lists = ['surfaces', 'obstacles', 'passages', 'entrances'] as const;
  for (const k of lists) if (!Array.isArray(g[k])) { bad('G1', `/${k}`, 'missing list'); return out; }
  // G2 provenance; G3 unique ids
  const ids = new Set<string>();
  for (const k of lists) for (const f of g[k] as { id: string; provenance: Provenance }[]) {
    const ref = `${k}/${f.id}`;
    if (typeof f.id !== 'string' || !f.id) bad('G3', ref, 'id missing');
    else if (ids.has(f.id)) bad('G3', ref, 'duplicate id'); else ids.add(f.id);
    const p = f.provenance;
    if (!p || !(PROVENANCE as readonly string[]).includes(p.source) || typeof p.assumption !== 'boolean' || typeof p.basis !== 'string') { bad('G2', ref, 'provenance {source, assumption, basis} required'); continue; }
    if (p.source === 'derived_display') bad('G2', ref, 'a display-derived position is not physical geometry (Issue #68 principle 5)');
    if (p.source === 'measured' && !p.measurement_ref) bad('G2', ref, 'measured values need a measurement_ref');
    if (p.source === 'synthetic_scenario' && g.synthetic !== true) bad('G1', ref, 'synthetic features require synthetic: true');
  }
  if (g.synthetic === true && OFFICIAL_WORLD_IDS.has(g.world_id)) bad('G1', '/world_id', `a synthetic document may not claim the official world ${g.world_id}`);
  // G4 surfaces and obstacle polygons
  const polyOk = (pts: unknown, ref: string) => {
    if (!Array.isArray(pts) || pts.length < 3 || !pts.every((q) => Array.isArray(q) && q.length === 2 && q.every(finite))) { bad('G4', ref, 'polygon needs ≥3 finite [x,y] points'); return false; }
    const poly = (pts as [number, number][]).map(v2);
    if (Math.abs(polygonArea(poly)) <= 0) { bad('G4', ref, 'degenerate polygon'); return false; }
    if (!polygonIsSimple(poly)) { bad('G4', ref, 'self-intersecting polygon'); return false; }
    return true;
  };
  for (const s of g.surfaces) {
    polyOk(s.polygon_mm, `surfaces/${s.id}`);
    const e = s.elevation;
    if (!e || (e.kind !== 'flat' && e.kind !== 'ramp')) bad('G4', `surfaces/${s.id}`, 'elevation must be flat or ramp');
    else if (e.kind === 'flat' && !(e.z_mm === null || finite(e.z_mm))) bad('G4', `surfaces/${s.id}`, 'flat z_mm must be a number or null');
    else if (e.kind === 'ramp' && !(finite(e.z0_mm) && finite(e.gradient) && e.direction?.length === 2 && Math.abs(Math.hypot(e.direction[0], e.direction[1]) - 1) < 1e-9)) bad('G4', `surfaces/${s.id}`, 'ramp needs z0_mm, gradient and a unit direction');
  }
  for (const o of g.obstacles) {
    if (o.shape?.type === 'circle') { if (!(o.shape.center_mm?.every(finite) && finite(o.shape.radius_mm) && o.shape.radius_mm > 0)) bad('G4', `obstacles/${o.id}`, 'circle needs a centre and a positive radius'); }
    else if (o.shape?.type === 'polygon') polyOk(o.shape.points_mm, `obstacles/${o.id}`);
    else bad('G4', `obstacles/${o.id}`, 'shape must be circle or polygon');
    if (!(o.height_mm === null || (finite(o.height_mm) && o.height_mm > 0))) bad('G4', `obstacles/${o.id}`, 'height_mm must be positive or null');
  }
  // G5 passages; G6 lanes stay on surfaces (2.5D: no height change except over a ramp)
  const passageIds = new Set(g.passages.map((p) => p.id));
  for (const p of g.passages) {
    const ref = `passages/${p.id}`;
    if (!Array.isArray(p.centerline_mm) || p.centerline_mm.length < 2 || !p.centerline_mm.every((q) => Array.isArray(q) && q.length === 3 && q.every(finite))) { bad('G5', ref, 'centre-line needs ≥2 finite [x,y,z] points'); continue; }
    if (!(p.width_mm === null || (finite(p.width_mm) && p.width_mm > 0))) bad('G5', ref, 'width_mm must be positive or null');
    for (let i = 1; i < p.centerline_mm.length; i++) if (dist(v3(p.centerline_mm[i - 1]), v3(p.centerline_mm[i])) === 0) bad('G5', ref, `repeated point ${i}`);
    if (p.route_edge_ref !== null && (typeof p.route_edge_ref !== 'string' || !/^[^:]+:[^:]+$/.test(p.route_edge_ref) || (opts.routeEdges && !opts.routeEdges.has(p.route_edge_ref)))) bad('G8', ref, `route_edge_ref ${p.route_edge_ref} is not an edge of the route graph`);
    const pts = p.centerline_mm.map(v3);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], n = Math.max(1, Math.ceil(dist(a, b) / SURFACE_SAMPLE_MM));
      for (let k = 0; k <= n; k++) {
        const q = { x: a.x + (b.x - a.x) * (k / n), y: a.y + (b.y - a.y) * (k / n), z: a.z + (b.z - a.z) * (k / n) };
        if (!surfacesAt(g, q).length) { bad('G6', ref, `point (${q.x.toFixed(2)}, ${q.y.toFixed(2)}, ${q.z.toFixed(2)}) on segment ${i} is not on any surface at that height (height changes only over a ramp)`); k = n + 1; i = pts.length; }
      }
    }
  }
  // G7 entrances lie on their passage
  for (const e of g.entrances) {
    const ref = `entrances/${e.id}`;
    if (!passageIds.has(e.passage_ref)) { bad('G7', ref, `passage ${e.passage_ref} does not exist`); continue; }
    if (!(e.aperture_width_mm === null || (finite(e.aperture_width_mm) && e.aperture_width_mm > 0))) bad('G7', ref, 'aperture_width_mm must be positive or null');
    const pts = (g.passages.find((p) => p.id === e.passage_ref) as Passage).centerline_mm.map(v3), q = v3(e.position_mm);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, pointSegment2D(q, pts[i - 1], pts[i]).d);
    if (d > ON_TOLERANCE_MM) bad('G7', ref, 'entrance is not on its passage centre-line');
  }
  return out;
}

/** True only when every quantity physics needs for this passage is known (no null width, obstacle height or aperture). */
export function physicsReady(g: PhysicsGeometry, passageId: string): { ready: boolean; unknown: string[] } {
  const p = g.passages.find((x) => x.id === passageId);
  if (!p) return { ready: false, unknown: [`passage ${passageId}`] };
  const unknown: string[] = [];
  if (p.width_mm === null) unknown.push(`passages/${p.id}/width_mm`);
  for (const o of nearObstacles(g, p, p.width_mm ?? Infinity)) if (o.obstacle.height_mm === null) unknown.push(`obstacles/${o.obstacle.id}/height_mm`);
  for (const e of g.entrances.filter((x) => x.passage_ref === p.id)) if (e.aperture_width_mm === null) unknown.push(`entrances/${e.id}/aperture_width_mm`);
  return { ready: unknown.length === 0, unknown };
}

/** Arc-length position (mm) of the point of a passage closest to point q. */
export function arcPositionOf(p: Passage, q: Vec2): number {
  const pts = p.centerline_mm.map(v3);
  let best = { d: Infinity, s: 0 }, acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const r = pointSegment2D(q, pts[i - 1], pts[i]), L = dist(pts[i - 1], pts[i]);
    if (r.d < best.d) best = { d: r.d, s: acc + r.u * L };
    acc += L;
  }
  return best.s;
}

interface NearObstacle { obstacle: Obstacle; distance_mm: number; s_mm: number }
/** Obstacles whose footprint comes within `reach` of the passage centre-line, with the closest approach. */
function nearObstacles(g: PhysicsGeometry, p: Passage, reach: number): NearObstacle[] {
  const pts = p.centerline_mm.map(v3), out: NearObstacle[] = [];
  for (const o of g.obstacles) {
    let best = { d: Infinity, s: 0 }, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const d = segmentObstacleDistance(o, pts[i - 1], pts[i]), L = dist(pts[i - 1], pts[i]);
      if (d < best.d) {
        const anchor = o.shape.type === 'circle' ? v2(o.shape.center_mm) : v2(o.shape.points_mm[0]);
        best = { d, s: acc + pointSegment2D(anchor, pts[i - 1], pts[i]).u * L };
      }
      acc += L;
    }
    if (best.d < reach) out.push({ obstacle: o, distance_mm: best.d, s_mm: best.s });
  }
  return out.sort((a, b) => a.s_mm - b.s_mm || (a.obstacle.id < b.obstacle.id ? -1 : 1));
}

export interface Traversal {
  passage: string; passable: boolean | 'unknown'; length_mm: number;
  /** what stops a body of this width, in order along the passage */
  blocks: { kind: 'passage_width' | 'obstacle' | 'entrance'; ref: string; s_mm: number; clearance_mm: number; needed_mm: number }[];
  unknown: string[];
}
/**
 * Can a body of effective width `widthMm` (body, or a carried load if wider: Issue #68 PH-4) travel the passage along its
 * centre-line? Needs: passage width ≥ W; every obstacle footprint at least W/2 from the centre-line; every entrance on the
 * passage with aperture ≥ W. Returns 'unknown' when a needed quantity is null. Lateral swerving inside a wide passage is
 * not modelled (stated limit): the lane is the centre-line.
 */
export function traverse(g: PhysicsGeometry, passageId: string, widthMm: number): Traversal {
  const p = g.passages.find((x) => x.id === passageId);
  if (!p) throw Error(`PHYSICS: passage ${passageId} not found`);
  if (!(widthMm > 0)) throw Error(`PHYSICS: body width ${widthMm} mm must be positive`);
  const ready = physicsReady(g, passageId), length_mm = polylineLength(p.centerline_mm.map(v3)), blocks: Traversal['blocks'] = [];
  if (p.width_mm !== null && p.width_mm < widthMm) blocks.push({ kind: 'passage_width', ref: `passages/${p.id}`, s_mm: 0, clearance_mm: p.width_mm, needed_mm: widthMm });
  for (const o of nearObstacles(g, p, widthMm / 2)) if (o.obstacle.height_mm !== null) blocks.push({ kind: 'obstacle', ref: `obstacles/${o.obstacle.id}`, s_mm: o.s_mm, clearance_mm: Math.max(0, o.distance_mm) * 2, needed_mm: widthMm });
  for (const e of g.entrances.filter((x) => x.passage_ref === p.id)) if (e.aperture_width_mm !== null && e.aperture_width_mm < widthMm) blocks.push({ kind: 'entrance', ref: `entrances/${e.id}`, s_mm: arcPositionOf(p, v2([e.position_mm[0], e.position_mm[1]])), clearance_mm: e.aperture_width_mm, needed_mm: widthMm });
  blocks.sort((a, b) => a.s_mm - b.s_mm || (a.ref < b.ref ? -1 : 1));
  return { passage: p.id, passable: blocks.length ? false : ready.ready ? true : 'unknown', length_mm, blocks, unknown: ready.unknown };
}

/** Per-segment slope of a passage (rise / horizontal run), for the motion layer and reports. */
export function passageSlopes(p: Passage): { segment: number; horizontal_mm: number; rise_mm: number; grade: number }[] {
  const pts = p.centerline_mm.map(v3);
  return pts.slice(1).map((b, i) => {
    const a = pts[i], h = Math.hypot(b.x - a.x, b.y - a.y);
    return { segment: i, horizontal_mm: h, rise_mm: b.z - a.z, grade: h === 0 ? Infinity : (b.z - a.z) / h };
  });
}
