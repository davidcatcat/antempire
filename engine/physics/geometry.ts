/**
 * PH-1 (Issue #68): physical space for the physics layer. A physics geometry document (`antempire.physics-geometry.v1`)
 * is a LAYER on top of the P1-B shared world geometry (`antempire.world-geometry.v1`, docs/research-design-p1b-nest-space.md
 * §2): it does not redefine sites or route edges; a passage refers to a route edge by its canonical key
 * (`route_edge_ref`, sorted "a:b" as `edgeKey`), and its length must agree with that edge's recorded movement length
 * (P1-B §2.1.2: one source of movement length; check G9). It adds what P1-B leaves open: surfaces with elevation,
 * static obstacles, walkable lanes with usable widths, nest-entrance apertures, provenance on every feature.
 *
 * Status and limits (read before use):
 * - NOT imported by the simulation core (engine/day.ts and the modules it calls) nor by cli/ or web/. It changes no game
 *   output. Joining the day loop is a later rules-update PR (tests/physics-isolation.test.ts enforces this).
 * - The xitun garden geometry is mostly unknown (P1-B §1). Physics runs only on documents whose features are known;
 *   anything null is reported `unknown`, never filled in, and a renderer position (`derived_display`) is never accepted
 *   as physical geometry. The first documents are synthetic scenarios: `synthetic: true`, world id `synthetic-*`.
 * - Model of space (engineering approximation, Issue #68 principle 2): ants move on passage centre-lines (lanes); a
 *   passage has one usable width; obstacles are 2D footprints occupying a height range [base_z, base_z + height]
 *   (base_z null = every level, conservative). Any obstacle with a known height blocks a lane it reaches, however low:
 *   climbing over obstacles and up vertical faces is not modelled (ants can climb; this is a stated limit).
 * - 2.5D: every surface is flat or a planar ramp; a lane may change height only over a declared ramp. The lane-on-surface
 *   check (G6) is EXACT: each lane segment is cut at every surface-polygon edge, and on each piece both the lane and the
 *   surface are linear in the segment parameter, so matching heights at the two ends of a piece proves the whole piece.
 *
 * Units: mm. Pure; no platform APIs; no species or world names in code.
 */
import { dist, pointInPolygon, pointSegment2D, polygonArea, polygonIsSimple, polylineLength } from './vec.ts';
import type { Vec2, Vec3 } from './vec.ts';

export const PHYSICS_SCHEMA = 'antempire.physics-geometry.v1';
/** The P1-B shared geometry this document is a physics layer of. */
export const WORLD_GEOMETRY_SCHEMA = 'antempire.world-geometry.v1';
/** Provenance values (P1-B §2.3) plus `synthetic_scenario` for synthetic test worlds. */
export const PROVENANCE = ['synthetic_scenario', 'scenario_assumption', 'narrative_legacy', 'derived_display', 'literature_prior', 'real_world_reference', 'measured'] as const;
export type ProvenanceSource = (typeof PROVENANCE)[number];
export interface Provenance { source: ProvenanceSource; assumption: boolean; basis: string; note?: string; measurement_ref?: string | null }

export interface FlatElevation { kind: 'flat'; z_mm: number | null }
/** Planar ramp: z = z0 + g·((p − anchor)·direction), direction a unit vector in the plane. */
export interface RampElevation { kind: 'ramp'; anchor_mm: [number, number]; z0_mm: number; direction: [number, number]; gradient: number }
export interface Surface { id: string; material: string | null; polygon_mm: [number, number][]; elevation: FlatElevation | RampElevation; provenance: Provenance }
export type ObstacleShape = { type: 'circle'; center_mm: [number, number]; radius_mm: number } | { type: 'polygon'; points_mm: [number, number][] };
export interface Obstacle { id: string; kind: string; shape: ObstacleShape; base_z_mm: number | null; height_mm: number | null; provenance: Provenance }
export interface Passage { id: string; centerline_mm: [number, number, number][]; width_mm: number | null; route_edge_ref: string | null; provenance: Provenance }
export interface Entrance { id: string; passage_ref: string; position_mm: [number, number, number]; aperture_width_mm: number | null; aperture_height_mm: number | null; nest_ref: string | null; provenance: Provenance }
export interface PhysicsGeometry {
  schema: typeof PHYSICS_SCHEMA; layer_of: typeof WORLD_GEOMETRY_SCHEMA; world_geometry_ref: string | null;
  world_id: string; geometry_version: string; synthetic: boolean; synthetic_note?: string;
  frame: { units: 'mm'; axes: { x: string; y: string; z: string }; origin: string };
  surfaces: Surface[]; obstacles: Obstacle[]; passages: Passage[]; entrances: Entrance[];
}

/** Synthetic documents must use this world-id prefix (and only they may). */
export const SYNTHETIC_PREFIX = 'synthetic-';
/** Tolerance for "lies on" checks and height matching (mm, numerical). */
export const ON_TOLERANCE_MM = 1e-6;

const v2 = (a: [number, number]): Vec2 => ({ x: a[0], y: a[1] });
const v3 = (a: [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const zEq = (a: number, b: number) => Math.abs(a - b) <= ON_TOLERANCE_MM * Math.max(1, Math.abs(a), Math.abs(b));

/** Elevation of a surface at (x, y), or null when unknown. */
export function surfaceZ(s: Surface, p: Vec2): number | null {
  const e = s.elevation;
  if (e.kind === 'flat') return e.z_mm;
  return e.z0_mm + e.gradient * ((p.x - e.anchor_mm[0]) * e.direction[0] + (p.y - e.anchor_mm[1]) * e.direction[1]);
}
/** Surfaces under (x, y) whose elevation equals z (within tolerance). */
export function surfacesAt(g: PhysicsGeometry, p: Vec3): Surface[] {
  return g.surfaces.filter((s) => pointInPolygon({ x: p.x, y: p.y }, s.polygon_mm.map(v2)) && (() => { const z = surfaceZ(s, p); return z !== null && zEq(z, p.z); })());
}

/** Distance (2D) from point p to an obstacle's footprint boundary; negative inside. */
export function obstacleDistance(o: Obstacle, p: Vec2): number {
  if (o.shape.type === 'circle') return Math.hypot(p.x - o.shape.center_mm[0], p.y - o.shape.center_mm[1]) - o.shape.radius_mm;
  const poly = o.shape.points_mm.map(v2);
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) d = Math.min(d, pointSegment2D(p, poly[j], poly[i]).d);
  return pointInPolygon(p, poly) ? -d : d;
}

/** Parameters u ∈ [0,1] along ab where it meets segment cd (one value, or both ends of a collinear overlap). */
function crossParams(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number[] {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y, den = rx * sy - ry * sx;
  const qx = c.x - a.x, qy = c.y - a.y;
  if (den === 0) {
    if (qx * ry - qy * rx !== 0) return [];          // parallel, not collinear
    const rr = rx * rx + ry * ry; if (rr === 0) return [];
    const u0 = (qx * rx + qy * ry) / rr, u1 = ((d.x - a.x) * rx + (d.y - a.y) * ry) / rr;
    return [u0, u1].filter((u) => u >= 0 && u <= 1);
  }
  const u = (qx * sy - qy * sx) / den, v = (qx * ry - qy * rx) / den;
  return u >= -1e-12 && u <= 1 + 1e-12 && v >= -1e-12 && v <= 1 + 1e-12 ? [Math.max(0, Math.min(1, u))] : [];
}

/**
 * Closest approach of lane segment ab (2D) to an obstacle footprint: distance (≤ 0 when the segment touches, crosses or
 * starts inside it) and the segment parameter u of that approach (for a crossing: the first point where it enters).
 * Independent of polygon vertex order.
 */
export function segmentObstacleApproach(o: Obstacle, a: Vec2, b: Vec2): { d: number; u: number } {
  if (o.shape.type === 'circle') { const r = pointSegment2D(v2(o.shape.center_mm), a, b); return { d: r.d - o.shape.radius_mm, u: r.u }; }
  const poly = o.shape.points_mm.map(v2);
  if (pointInPolygon(a, poly)) return { d: 0, u: 0 };
  let first = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) for (const u of crossParams(a, b, poly[j], poly[i])) first = Math.min(first, u);
  if (first !== Infinity) return { d: 0, u: first };
  let best = { d: Infinity, u: 0 };
  for (const q of poly) { const r = pointSegment2D(q, a, b); if (r.d < best.d) best = { d: r.d, u: r.u }; }
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const ra = pointSegment2D(a, poly[j], poly[i]).d, rb = pointSegment2D(b, poly[j], poly[i]).d;
    if (ra < best.d) best = { d: ra, u: 0 };
    if (rb < best.d) best = { d: rb, u: 1 };
  }
  return best;
}
/** Distance-only form. */
export const segmentObstacleDistance = (o: Obstacle, a: Vec2, b: Vec2): number => segmentObstacleApproach(o, a, b).d;

/** Does the obstacle's height range reach a lane segment whose height runs from za to zb? (base_z null = every level) */
export function obstacleReachesLevel(o: Obstacle, za: number, zb: number): boolean {
  if (o.base_z_mm === null) return true;
  const top = o.height_mm === null ? Infinity : o.base_z_mm + o.height_mm;
  return Math.max(za, zb) >= o.base_z_mm - ON_TOLERANCE_MM && Math.min(za, zb) <= top + ON_TOLERANCE_MM;
}

/**
 * Exact lane-on-surface check for one passage (2.5D). Returns hard problems (off every surface, height mismatch, vertical
 * step) and unknowns (the only surface under a piece of lane has an unknown elevation).
 */
export function laneSurfaceStatus(g: PhysicsGeometry, p: Passage): { issues: string[]; unknown: string[] } {
  const issues: string[] = [], unknown = new Set<string>(), pts = p.centerline_mm.map(v3);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    if (Math.hypot(b.x - a.x, b.y - a.y) === 0) { if (b.z !== a.z) issues.push(`segment ${i} is vertical (climbing is not modelled)`); continue; }
    const us = new Set<number>([0, 1]);
    for (const s of g.surfaces) {
      const poly = s.polygon_mm.map(v2);
      for (let k = 0, j = poly.length - 1; k < poly.length; j = k++) for (const u of crossParams(a, b, poly[j], poly[k])) us.add(u);
    }
    const cuts = [...us].sort((x, y) => x - y);
    for (let k = 1; k < cuts.length; k++) {
      const u0 = cuts[k - 1], u1 = cuts[k];
      if (u1 - u0 <= 1e-12) continue;
      const at = (u: number): Vec3 => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u });
      const m = at((u0 + u1) / 2), q0 = at(u0), q1 = at(u1);
      const under = g.surfaces.filter((s) => pointInPolygon(m, s.polygon_mm.map(v2)));
      if (!under.length) { issues.push(`segment ${i} [${u0.toFixed(6)}, ${u1.toFixed(6)}] near (${m.x.toFixed(3)}, ${m.y.toFixed(3)}) is on no surface`); continue; }
      const match = under.some((s) => { const z0 = surfaceZ(s, q0), z1 = surfaceZ(s, q1); return z0 !== null && z1 !== null && zEq(z0, q0.z) && zEq(z1, q1.z); });
      if (match) continue;
      const nulls = under.filter((s) => surfaceZ(s, m) === null);
      if (nulls.length) nulls.forEach((s) => unknown.add(`surfaces/${s.id}/elevation`));
      else issues.push(`segment ${i} [${u0.toFixed(6)}, ${u1.toFixed(6)}] near (${m.x.toFixed(3)}, ${m.y.toFixed(3)}, ${m.z.toFixed(3)}) is not at the height of the surface under it (height changes only over a ramp)`);
    }
  }
  return { issues, unknown: [...unknown].sort() };
}

export interface GeometryIssue { code: string; ref: string; message: string }
export interface ValidateOptions {
  /** canonical keys of the route graph's edges (G8) */
  routeEdges?: ReadonlySet<string>;
  /** movement length of each route edge in mm (P1-B: length_cm × 10 × path_tortuosity) and the allowed difference (G9) */
  routeEdgeLengths?: { mm: ReadonlyMap<string, number>; tolerance_mm: number };
}
/**
 * Validate a physics geometry document (codes G1–G9). Returns every problem found; an empty list means the document
 * is structurally valid. Validity does not mean every feature is known: see `physicsReady`.
 */
export function validateGeometry(doc: unknown, opts: ValidateOptions = {}): GeometryIssue[] {
  const out: GeometryIssue[] = [], bad = (code: string, ref: string, message: string) => out.push({ code, ref, message });
  const g = doc as PhysicsGeometry;
  if (typeof doc !== 'object' || doc === null) return [{ code: 'G1', ref: '/', message: 'document is not an object' }];
  if (g.schema !== PHYSICS_SCHEMA || g.layer_of !== WORLD_GEOMETRY_SCHEMA) bad('G1', '/', `schema must be ${PHYSICS_SCHEMA}, layer_of ${WORLD_GEOMETRY_SCHEMA}`);
  if (typeof g.synthetic !== 'boolean') bad('G1', '/synthetic', 'synthetic must be true or false');
  if (typeof g.world_id !== 'string' || (g.synthetic === true) !== g.world_id.startsWith(SYNTHETIC_PREFIX)) bad('G1', '/world_id', `synthetic documents (and only they) use a world id starting with "${SYNTHETIC_PREFIX}"`);
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
    if (p.source !== 'measured' && p.assumption !== true) bad('G2', ref, 'only measured values may have assumption: false (CLAUDE.md §3)');
    if (p.source === 'synthetic_scenario' && g.synthetic !== true) bad('G1', ref, 'synthetic features require synthetic: true');
  }
  // G4 surfaces and obstacles
  const polyOk = (pts: unknown, ref: string) => {
    if (!Array.isArray(pts) || pts.length < 3 || !pts.every((q) => Array.isArray(q) && q.length === 2 && q.every(finite))) { bad('G4', ref, 'polygon needs ≥3 finite [x,y] points'); return false; }
    const poly = (pts as [number, number][]).map(v2);
    if (Math.abs(polygonArea(poly)) <= 0) { bad('G4', ref, 'degenerate polygon'); return false; }
    if (!polygonIsSimple(poly)) { bad('G4', ref, 'self-intersecting polygon'); return false; }
    return true;
  };
  const surfacesOk: boolean[] = [];
  for (const s of g.surfaces) {
    let good = polyOk(s.polygon_mm, `surfaces/${s.id}`);
    const e = s.elevation as unknown as { kind?: string; z_mm?: unknown; z0_mm?: unknown; gradient?: unknown; anchor_mm?: unknown[]; direction?: number[] } | undefined;
    if (!e || (e.kind !== 'flat' && e.kind !== 'ramp')) { bad('G4', `surfaces/${s.id}`, 'elevation must be flat or ramp'); good = false; }
    else if (e.kind === 'flat' && !(e.z_mm === null || finite(e.z_mm))) { bad('G4', `surfaces/${s.id}`, 'flat z_mm must be a number or null'); good = false; }
    else if (e.kind === 'ramp' && !(finite(e.z0_mm) && finite(e.gradient) && Array.isArray(e.anchor_mm) && e.anchor_mm.length === 2 && e.anchor_mm.every(finite) && Array.isArray(e.direction) && e.direction.length === 2 && e.direction.every(finite) && Math.abs(Math.hypot(e.direction[0], e.direction[1]) - 1) < 1e-9)) { bad('G4', `surfaces/${s.id}`, 'ramp needs anchor_mm, z0_mm, gradient and a unit direction'); good = false; }
    surfacesOk.push(good);
  }
  for (const o of g.obstacles) {
    if (o.shape?.type === 'circle') { if (!(Array.isArray(o.shape.center_mm) && o.shape.center_mm.length === 2 && o.shape.center_mm.every(finite) && finite(o.shape.radius_mm) && o.shape.radius_mm > 0)) bad('G4', `obstacles/${o.id}`, 'circle needs a centre and a positive radius'); }
    else if (o.shape?.type === 'polygon') polyOk(o.shape.points_mm, `obstacles/${o.id}`);
    else bad('G4', `obstacles/${o.id}`, 'shape must be circle or polygon');
    if (!(o.height_mm === null || (finite(o.height_mm) && o.height_mm > 0))) bad('G4', `obstacles/${o.id}`, 'height_mm must be positive or null');
    if (!(o.base_z_mm === null || finite(o.base_z_mm))) bad('G4', `obstacles/${o.id}`, 'base_z_mm must be a number or null');
  }
  // G5 passages; G6 lanes stay on surfaces; G8 route edge; G9 length agrees with the route edge
  const passageIds = new Set(g.passages.map((p) => p.id)), geomOk = surfacesOk.every(Boolean);
  for (const p of g.passages) {
    const ref = `passages/${p.id}`;
    if (!Array.isArray(p.centerline_mm) || p.centerline_mm.length < 2 || !p.centerline_mm.every((q) => Array.isArray(q) && q.length === 3 && q.every(finite))) { bad('G5', ref, 'centre-line needs ≥2 finite [x,y,z] points'); continue; }
    if (!(p.width_mm === null || (finite(p.width_mm) && p.width_mm > 0))) bad('G5', ref, 'width_mm must be positive or null');
    let repeated = false;
    for (let i = 1; i < p.centerline_mm.length; i++) if (dist(v3(p.centerline_mm[i - 1]), v3(p.centerline_mm[i])) === 0) { bad('G5', ref, `repeated point ${i}`); repeated = true; }
    if (p.route_edge_ref !== null) {
      const parts = typeof p.route_edge_ref === 'string' ? p.route_edge_ref.split(':') : [];
      if (parts.length !== 2 || !parts[0] || !parts[1] || parts[0] >= parts[1]) bad('G8', ref, `route_edge_ref ${p.route_edge_ref} is not a canonical edge key "a:b" with a < b (P1-B §2.4, edgeKey)`);
      else if (opts.routeEdges && !opts.routeEdges.has(p.route_edge_ref)) bad('G8', ref, `route_edge_ref ${p.route_edge_ref} is not an edge of the route graph`);
      else if (opts.routeEdgeLengths) {
        const L = opts.routeEdgeLengths.mm.get(p.route_edge_ref), lane = polylineLength(p.centerline_mm.map(v3));
        if (L === undefined) bad('G9', ref, `route edge ${p.route_edge_ref} has no recorded length: the lane cannot become a second length source (P1-B §2.1.2)`);
        else if (Math.abs(lane - L) > opts.routeEdgeLengths.tolerance_mm) bad('G9', ref, `lane length ${lane.toFixed(3)} mm differs from the route edge movement length ${L} mm`);
      }
    }
    if (geomOk && !repeated) for (const m of laneSurfaceStatus(g, p).issues) bad('G6', ref, m);
  }
  // G7 entrances lie on their passage (3D)
  for (const e of g.entrances) {
    const ref = `entrances/${e.id}`;
    if (!passageIds.has(e.passage_ref)) { bad('G7', ref, `passage ${e.passage_ref} does not exist`); continue; }
    if (!(e.aperture_width_mm === null || (finite(e.aperture_width_mm) && e.aperture_width_mm > 0))) bad('G7', ref, 'aperture_width_mm must be positive or null');
    if (!(e.aperture_height_mm === null || (finite(e.aperture_height_mm) && e.aperture_height_mm > 0))) bad('G7', ref, 'aperture_height_mm must be positive or null');
    if (!(Array.isArray(e.position_mm) && e.position_mm.length === 3 && e.position_mm.every(finite))) { bad('G7', ref, 'position_mm needs finite [x,y,z]'); continue; }
    const pts = (g.passages.find((p) => p.id === e.passage_ref) as Passage).centerline_mm.map(v3), q = v3(e.position_mm);
    let d = Infinity;
    for (let i = 1; i < pts.length; i++) d = Math.min(d, pointSegment3D(q, pts[i - 1], pts[i]));
    if (d > ON_TOLERANCE_MM) bad('G7', ref, 'entrance is not on its passage centre-line (3D)');
  }
  return out;
}

function pointSegment3D(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }, L2 = ab.x * ab.x + ab.y * ab.y + ab.z * ab.z;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z) / L2));
  return Math.hypot(p.x - (a.x + u * ab.x), p.y - (a.y + u * ab.y), p.z - (a.z + u * ab.z));
}

/**
 * True only when every quantity physics needs for this passage is known: width, the height of every obstacle the lane
 * comes near, every entrance aperture on it, and the elevation of every surface under it.
 */
export function physicsReady(g: PhysicsGeometry, passageId: string): { ready: boolean; unknown: string[] } {
  const p = g.passages.find((x) => x.id === passageId);
  if (!p) return { ready: false, unknown: [`passage ${passageId}`] };
  const unknown: string[] = [];
  if (p.width_mm === null) unknown.push(`passages/${p.id}/width_mm`);
  for (const o of nearObstacles(g, p, p.width_mm ?? Infinity)) if (o.obstacle.height_mm === null) unknown.push(`obstacles/${o.obstacle.id}/height_mm`);
  for (const e of g.entrances.filter((x) => x.passage_ref === p.id)) if (e.aperture_width_mm === null) unknown.push(`entrances/${e.id}/aperture_width_mm`);
  unknown.push(...laneSurfaceStatus(g, p).unknown);
  return { ready: unknown.length === 0, unknown };
}

/** Arc-length position (mm) of the point of a passage closest to point q (2D). */
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
/** Obstacles whose footprint (at the lane's level) comes within `reach` of the passage centre-line, with the closest approach. */
function nearObstacles(g: PhysicsGeometry, p: Passage, reach: number): NearObstacle[] {
  const pts = p.centerline_mm.map(v3), out: NearObstacle[] = [];
  for (const o of g.obstacles) {
    let best = { d: Infinity, s: 0 }, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const L = dist(pts[i - 1], pts[i]);
      if (obstacleReachesLevel(o, pts[i - 1].z, pts[i].z)) {
        const r = segmentObstacleApproach(o, pts[i - 1], pts[i]);
        if (r.d < best.d) best = { d: r.d, s: acc + r.u * L };
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
 * centre-line? Needs: passage width ≥ W; every obstacle footprint at the lane's level at least W/2 from the centre-line;
 * every entrance on the passage with aperture ≥ W. Returns 'unknown' when a needed quantity is null. Refuses (throws) an
 * invalid document: passability is never computed on geometry that fails validation. Lateral swerving inside a wide
 * passage is not modelled (stated limit): the lane is the centre-line.
 */
export function traverse(g: PhysicsGeometry, passageId: string, widthMm: number, opts: ValidateOptions = {}): Traversal {
  const issues = validateGeometry(g, opts);
  if (issues.length) throw Error(`PHYSICS: invalid geometry ${g.world_id}: ${issues.map((i) => `${i.code} ${i.ref}`).join('; ')}`);
  const p = g.passages.find((x) => x.id === passageId);
  if (!p) throw Error(`PHYSICS: passage ${passageId} not found`);
  if (!(widthMm > 0) || !Number.isFinite(widthMm)) throw Error(`PHYSICS: body width ${widthMm} mm must be positive and finite`);
  const ready = physicsReady(g, passageId), length_mm = polylineLength(p.centerline_mm.map(v3)), blocks: Traversal['blocks'] = [];
  if (p.width_mm !== null && p.width_mm < widthMm) blocks.push({ kind: 'passage_width', ref: `passages/${p.id}`, s_mm: 0, clearance_mm: p.width_mm, needed_mm: widthMm });
  for (const o of nearObstacles(g, p, widthMm / 2)) if (o.obstacle.height_mm !== null) blocks.push({ kind: 'obstacle', ref: `obstacles/${o.obstacle.id}`, s_mm: o.s_mm, clearance_mm: Math.max(0, o.distance_mm) * 2, needed_mm: widthMm });
  for (const e of g.entrances.filter((x) => x.passage_ref === p.id)) if (e.aperture_width_mm !== null && e.aperture_width_mm < widthMm) blocks.push({ kind: 'entrance', ref: `entrances/${e.id}`, s_mm: arcPositionOf(p, v2([e.position_mm[0], e.position_mm[1]])), clearance_mm: e.aperture_width_mm, needed_mm: widthMm });
  blocks.sort((a, b) => a.s_mm - b.s_mm || (a.ref < b.ref ? -1 : 1));
  return { passage: p.id, passable: blocks.length ? false : ready.ready ? true : 'unknown', length_mm, blocks, unknown: ready.unknown };
}

/** Per-segment slope of a passage (rise / horizontal run), for the motion layer and reports. Grades are not limited:
 *  how steep an ant can walk is not modelled (stated limit). */
export function passageSlopes(p: Passage): { segment: number; horizontal_mm: number; rise_mm: number; grade: number }[] {
  const pts = p.centerline_mm.map(v3);
  return pts.slice(1).map((b, i) => {
    const a = pts[i], h = Math.hypot(b.x - a.x, b.y - a.y);
    return { segment: i, horizontal_mm: h, rise_mm: b.z - a.z, grade: h === 0 ? Infinity : (b.z - a.z) / h };
  });
}
