/**
 * PH-1 (Issue #68): small, exact geometry primitives for the physics layer. Units: millimetres (mm) everywhere in
 * engine/physics; route-level data in centimetres is converted explicitly by the caller (never mixed here).
 * Pure functions, no platform APIs (engine/ must run in a browser).
 */
export interface Vec2 { x: number; y: number }
export interface Vec3 { x: number; y: number; z: number }

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale = (a: Vec3, k: number): Vec3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const norm = (a: Vec3): number => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3): number => norm(sub(a, b));
export const dist2D = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });

/** 3D length of a polyline (mm). */
export function polylineLength(pts: Vec3[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Point at arc length s along a polyline (clamped to [0, length]); also returns the segment index. */
export function pointAt(pts: Vec3[], s: number): { p: Vec3; seg: number } {
  if (s <= 0) return { p: { ...pts[0] }, seg: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = dist(pts[i - 1], pts[i]);
    if (acc + l >= s) return { p: lerp(pts[i - 1], pts[i], l === 0 ? 0 : (s - acc) / l), seg: i - 1 };
    acc += l;
  }
  return { p: { ...pts[pts.length - 1] }, seg: pts.length - 2 };
}

/** Closest distance in the horizontal plane from point p to segment ab, and the parameter u ∈ [0,1] of the closest point. */
export function pointSegment2D(p: Vec2, a: Vec2, b: Vec2): { d: number; u: number } {
  const abx = b.x - a.x, aby = b.y - a.y, L2 = abx * abx + aby * aby;
  const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2));
  return { d: Math.hypot(p.x - (a.x + u * abx), p.y - (a.y + u * aby)), u };
}

/** Do segments ab and cd intersect (2D, including touching)? */
export function segmentsIntersect2D(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const on = (p: Vec2, q: Vec2, r: Vec2) => Math.min(p.x, r.x) <= q.x && q.x <= Math.max(p.x, r.x) && Math.min(p.y, r.y) <= q.y && q.y <= Math.max(p.y, r.y);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, c, b)) || (o2 === 0 && on(a, d, b)) || (o3 === 0 && on(c, a, d)) || (o4 === 0 && on(c, b, d));
}

/** Minimum 2D distance between segments ab and cd (0 when they intersect). */
export function segmentSegment2D(a: Vec2, b: Vec2, c: Vec2, d: Vec2): number {
  if (segmentsIntersect2D(a, b, c, d)) return 0;
  return Math.min(pointSegment2D(a, c, d).d, pointSegment2D(b, c, d).d, pointSegment2D(c, a, b).d, pointSegment2D(d, a, b).d);
}

/** Even–odd point-in-polygon test (2D). Points on the boundary count as inside. */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (pointSegment2D(p, poly[j], poly[i]).d < 1e-9) return true;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Signed area of a polygon (2D); |area| > 0 means non-degenerate. */
export function polygonArea(poly: Vec2[]): number {
  let A = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) A += (poly[j].x * poly[i].y - poly[i].x * poly[j].y);
  return A / 2;
}

/** True if no two non-adjacent edges of the polygon intersect. */
export function polygonIsSimple(poly: Vec2[]): boolean {
  const n = poly.length;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (j === i + 1 || (i === 0 && j === n - 1)) continue;
    if (segmentsIntersect2D(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false;
  }
  return true;
}
