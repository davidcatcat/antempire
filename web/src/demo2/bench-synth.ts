/**
 * Demo 2 performance tests — the SYNTHETIC motion generator of the render-only test. Pure: no DOM, no Three.js, no
 * Worker, no engine import, no clock, no unseeded randomness.
 *
 * 合成資料，非模擬. These points are NOT ants of any world: each index walks a fixed ellipse with pauses, a pure
 * function of (index, seed, time). They exist only to give the renderer N moving instances to draw. Nothing here is
 * read from, or sent to, a simulation; the bench page never shows them next to engine statistics and never saves them.
 */
export const SYNTH_LABEL_ZH = '效能測試・合成資料，非模擬';
/** where the synthetic instances walk (cm, scene coordinates on the garden surface near the nest entrance) */
export const SYNTH_AREA = { x0: -50, x1: 90, z0: -90, z1: -6 } as const;
/** walking speed of a synthetic instance (cm/s of bench time): a display number, not a measured ant speed */
export const SYNTH_SPEED_CM_S = 2;
export interface SynthPoint { x: number; z: number; fx: number; fz: number; moving: boolean; crop: number }

/** mulberry32 step: a hash of (seed, index, salt) in [0, 1) */
export function synthUnit(seed: number, i: number, salt: number): number {
  let a = (seed ^ Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** instance i at bench time t (s): on its ellipse, walking 80 % of each cycle and standing 20 % */
export function synthPoint(i: number, t: number, seed: number): SynthPoint {
  const u = (k: number) => synthUnit(seed, i, k), A = SYNTH_AREA;
  const rx = 5 + u(2) * 16, rz = 4 + u(3) * 12, cx = A.x0 + rx + u(0) * (A.x1 - A.x0 - 2 * rx), cz = A.z0 + rz + u(1) * (A.z1 - A.z0 - 2 * rz);
  const dir = u(4) < 0.5 ? 1 : -1, cycle = 14 + u(5) * 16, walk = cycle * 0.8, tt = t + u(6) * cycle, n = Math.floor(tt / cycle), f = tt - n * cycle;
  const walked = (n * walk + Math.min(f, walk)) * SYNTH_SPEED_CM_S, a = u(7) * 6.283185307179586 + (dir * walked) / ((rx + rz) / 2);
  const tx = -Math.sin(a) * rx * dir, tz = Math.cos(a) * rz * dir, l = Math.hypot(tx, tz) || 1;
  return { x: cx + Math.cos(a) * rx, z: cz + Math.sin(a) * rz, fx: tx / l, fz: tz / l, moving: f < walk, crop: u(8) };
}
