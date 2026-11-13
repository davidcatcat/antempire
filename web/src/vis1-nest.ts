/**
 * VIS-1 underground concept view — the DOM-free part (Node tests use it): where the concept diagram draws an in-nest
 * worker from its ENGINE state and the recorded instants of its passage move, and where the larvae lie. Chambers,
 * passage and all positions in them are 示意 (概念圖：巢室幾何尚未模擬); see vis1-underground.ts.
 */
import type { P0a2FrameMsg } from './experimental/worker-protocol.ts';
import { h01 } from './art-core.ts';
import { hash32 } from './game-model.ts';

type PW = P0a2FrameMsg['workers'][number];
const TAU = Math.PI * 2;
export interface UCam { x: number; y: number; s: number; w: number; h: number }
export interface UHit { id: string; sx: number; sy: number; r: number }
/** concept space: 100 × 62 units, y down, ground surface at y = 0 */
export const U_W = 100, U_H = 62, U_ANT = 2.6;
export interface Room { key: string; states: string[]; label: string; cx: number; cy: number; rx: number; ry: number }
export const ROOMS: Room[] = [
  { key: 'rest', states: ['resting'], label: '休息', cx: 22, cy: 34, rx: 19, ry: 8.4 },
  { key: 'idle', states: ['idle'], label: '巢內走動', cx: 50, cy: 46, rx: 14, ry: 6.2 },
  { key: 'brood', states: ['brood_care'], label: '育幼（幼蟲）', cx: 78, cy: 33, rx: 16, ry: 7.2 },
];
/** passage from the entrance (top) to the junction, then to each room (示意) */
export const PASSAGE: [number, number][] = [[50, -0.5], [48.6, 6], [51.4, 12], [49.6, 19], [50, 24]];
export const BRANCH: Record<string, [number, number][]> = {
  rest: [[50, 24], [42, 27], [36, 30]], idle: [[50, 24], [51, 32], [50, 40]], brood: [[50, 24], [58, 27], [66, 31]],
};
const lerpPath = (P: [number, number][], k: number): { x: number; y: number; a: number } => {
  const seg: number[] = []; let tot = 0;
  for (let i = 1; i < P.length; i++) { const l = Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]); seg.push(l); tot += l; }
  let s = Math.max(0, Math.min(1, k)) * tot;
  for (let i = 0; i < seg.length; i++) { if (s <= seg[i] || i === seg.length - 1) { const u = seg[i] ? Math.min(1, s / seg[i]) : 0, a = P[i], b = P[i + 1]; return { x: a[0] + (b[0] - a[0]) * u, y: a[1] + (b[1] - a[1]) * u, a: Math.atan2(b[1] - a[1], b[0] - a[0]) }; } s -= seg[i]; }
  return { x: P[P.length - 1][0], y: P[P.length - 1][1], a: 0 };
};
/** where the concept view draws a worker (concept units), from its ENGINE state; null when it is outside the nest */
export function undergroundSpot(w: PW, t: number, tau: number): { x: number; y: number; a: number; walking: boolean; interpolated: boolean } | null {
  if (w.loc === 'outside') return null;
  const h = hash32(w.id) >>> 0, r1 = h01(h, 1, 3, 5), r2 = h01(h, 2, 4, 6), r3 = h01(h, 7, 8, 9);
  if (w.state === 'to_entrance' || w.state === 'from_entrance') {
    const span = (w.until_s ?? w.since_s) - w.since_s, k = span > 0 ? Math.max(0, Math.min(1, (t - w.since_s) / span)) : 1;
    const path = [...PASSAGE].reverse(), kk = w.state === 'to_entrance' ? k : 1 - k, p = lerpPath(path, kk); // junction → entrance
    return { x: p.x + (r1 - 0.5) * 1.2, y: p.y, a: w.state === 'to_entrance' ? p.a : p.a + Math.PI, walking: k > 0 && k < 1, interpolated: k > 0 && k < 1 };
  }
  const room = ROOMS.find((R) => R.states.includes(w.state)) ?? ROOMS[1];
  const fx = (r1 - 0.5) * 1.55, floorY = (u: number) => room.cy + room.ry * Math.sqrt(Math.max(0, 1 - u * u)) * 0.62;
  if (w.state === 'idle') { // walking in the nest (engine state); the back-and-forth on the floor is 示意
    const ph = r2 * TAU, u = Math.sin(tau * (0.08 + r3 * 0.05) + ph) * 0.75, du = Math.cos(tau * (0.08 + r3 * 0.05) + ph);
    return { x: room.cx + u * room.rx, y: floorY(u) - r3 * 2.2, a: du >= 0 ? 0.08 : Math.PI - 0.08, walking: true, interpolated: false };
  }
  if (w.state === 'brood_care') { const u = (r1 - 0.5) * 1.5; return { x: room.cx + u * room.rx, y: floorY(u) - 2.6 - r2 * 1.5, a: Math.PI / 2 + (r3 - 0.5) * 0.9, walking: false, interpolated: false }; }
  const u = fx; return { x: room.cx + u * room.rx * 0.95, y: floorY(u) - 0.8 - r2 * room.ry * 0.75, a: r3 * TAU, walking: false, interpolated: false };
}
export function larvaSpot(i: number, n: number): { x: number; y: number } { const R = ROOMS[2], u = -0.7 + (1.4 * (i + 0.5)) / n; return { x: R.cx + u * R.rx, y: R.cy + R.ry * Math.sqrt(1 - u * u) * 0.6 }; }

