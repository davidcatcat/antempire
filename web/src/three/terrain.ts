/**
 * Three.js 3D prototype (Owner 2026-11-14) — pure scene layout: no DOM, no Three.js, no engine import.
 *
 * Units: centimetres. 3-D axes: +X east, +Y up, +Z south (toward the viewer's default position); the 2-D display
 * layout of the P0-A2 model (x east, y north; web/src/v62-p0a2-model.ts) maps to (X = x, Z = −y).
 *
 * EVERYTHING here is SCENERY (示意): the P0-A2 candidate world models no garden geometry, no ground height, no leaves,
 * stones or plants, and no position inside the nest. The terrain only gives the ants something to stand on; it never
 * feeds back into the simulation (the page cannot send anything but scheduling / observation commands to the Worker).
 * Random placement uses a seeded hash PRNG so the scenery is identical on every load (no Math.random).
 */

/** the diorama block: ground top surface over [x0, x1] × [z0, z1]; the front cut face is at z = z1 */
export const DIORAMA = { x0: -80, x1: 280, z0: -260, z1: 8, bottom: -46 } as const;
/** the front cut face (the soil cross-section where the schematic nest chambers are shown) */
export const FACE_Z = DIORAMA.z1;

/** mulberry32: small deterministic PRNG for scenery placement (display only) */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (ix: number, iz: number, s: number) => {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(s, 2147483647)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
const smooth = (t: number) => t * t * (3 - 2 * t);
/** 2-D value noise in [0, 1] */
export function vnoise(x: number, z: number, s = 0): number {
  const ix = Math.floor(x), iz = Math.floor(z), fx = smooth(x - ix), fz = smooth(z - iz);
  const a = hash2(ix, iz, s), b = hash2(ix + 1, iz, s), c = hash2(ix, iz + 1, s), d = hash2(ix + 1, iz + 1, s);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}
/** fractal value noise in about [−0.5, 0.5] */
export function fbm(x: number, z: number, oct = 4, s = 0): number {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += amp * (vnoise(x * f, z * f, s + i * 17) - 0.5); f *= 2.03; amp *= 0.5; }
  return v;
}

/** the nest entrances drawn in the scene (main world at the origin; extra benchmark worlds elsewhere) */
export interface Mound { x: number; z: number }
const moundLift = (dx: number, dz: number) => { const r = Math.hypot(dx, dz); return r > 7 ? 0 : 0.9 * Math.exp(-((r - 2.6) ** 2) / 3.2) - (r < 0.9 ? 0.5 * (1 - r / 0.9) : 0); };

/** ground height (cm) at (x, z): gentle undulation + fine roughness + the excavated-soil ring around the entrance(s) */
export function groundHeight(x: number, z: number, mounds: readonly Mound[] = [{ x: 0, z: 0 }]): number {
  let h = fbm(x * 0.012, z * 0.012, 3, 11) * 6 + fbm(x * 0.09, z * 0.09, 3, 29) * 0.9;
  for (const m of mounds) h += moundLift(x - m.x, z - m.z);
  return h;
}

/** distance (cm) from (x, z) to the segment a→b (2-D, ground plane) */
export function distToSegment(x: number, z: number, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const vx = b.x - a.x, vz = b.z - a.z, L2 = vx * vx + vz * vz;
  const k = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / L2)) : 0;
  return Math.hypot(x - (a.x + vx * k), z - (a.z + vz * k));
}

/** keep-out zones for scenery (so leaves and stones do not cover the drawn route or the entrance): display only */
export interface KeepOut { routes: { a: { x: number; z: number }; b: { x: number; z: number } }[]; nests: Mound[]; routeHalfWidth: number; nestRadius: number }
export const isClear = (x: number, z: number, k: KeepOut) =>
  k.nests.every((n) => Math.hypot(x - n.x, z - n.z) > k.nestRadius) && k.routes.every((r) => distToSegment(x, z, r.a, r.b) > k.routeHalfWidth);

/** maps the P0-A2 2-D display layout point (x east, y north) to the 3-D ground plane */
export const to3 = (p: { x: number; y: number }) => ({ x: p.x, z: -p.y });
