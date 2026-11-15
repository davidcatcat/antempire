/**
 * Demo 2 — fixed display places inside the nest chambers (展示假設). Pure: no DOM, no Three.js, no engine import.
 *
 * The engine has no position for a larva, and no queen, egg, pupa or major worker at all. Where the brood pile, the
 * queens, the eggs, the pupae and the demo majors are DRAWN is a display arrangement on the floor of the chamber with
 * the matching role in the layout (data/demo2-nest-layout.json). Deterministic; antLen = drawn minor body length (cm).
 */
import type { NestGraph, Pos } from './nest-graph.ts';
import { hash32 } from '../game-model.ts';

const u01 = (key: string) => (hash32(key) >>> 0) / 4294967296;
const on = (g: NestGraph, chamberId: string, x: number, z: number): Pos => { const c = g.chamber(chamberId); return { edge: g.floorEdge(chamberId), s: Math.max(0.6, Math.min(c.x1 - c.x0 - 0.6, x - c.x0)), z: Math.max(g.backZ + 0.6, Math.min(g.faceZ - 0.8, z)) }; };
const first = (g: NestGraph, role: 'brood' | 'queen' | 'pupa' | 'rest' | 'entry' | 'exchange') => g.chambersOf(role)[0];

/** the i-th of n larvae on the brood-chamber floor: a pile of rows (engine: the larva exists; its place is display) */
export function larvaSpot(g: NestGraph, i: number, n: number, antLen: number): Pos {
  const c = first(g, 'brood'), cols = Math.max(1, Math.ceil(n / 2)), col = i % cols, row = Math.floor(i / cols), pitch = Math.max(0.9, antLen * 0.78);
  return on(g, c.id, (c.x0 + c.x1) / 2 + (col - (cols - 1) / 2) * pitch + (row % 2 ? pitch * 0.45 : 0), -1.5 + row * Math.max(0.9, antLen * 0.6));
}
/** where a carer stands next to a larva spot: on the side it arrives from (side = −1 west, +1 east) */
export function carerSpot(g: NestGraph, larva: Pos, side: -1 | 1, antLen: number): Pos {
  const c = first(g, 'brood'); return on(g, c.id, c.x0 + larva.s + side * antLen * 0.72, larva.z + 0.35);
}
/** demo queens: side by side in the middle of the queen chamber */
export function queenSpot(g: NestGraph, i: number, n: number, antLen: number): Pos {
  const c = first(g, 'queen'); return on(g, c.id, (c.x0 + c.x1) / 2 - 1 + (i - (n - 1) / 2) * antLen * 2.9, -1.3 + (i % 2) * 1.5);
}
/** demo eggs: one loose cluster on the queen-chamber floor, west of the queens */
export function eggSpot(g: NestGraph, i: number, seed: number, antLen: number): Pos {
  const c = first(g, 'queen'), a = u01(`egg|${seed}|${i}|a`) * Math.PI * 2, r = Math.sqrt(u01(`egg|${seed}|${i}|r`)) * antLen * 0.85;
  return on(g, c.id, c.x0 + (c.x1 - c.x0) * 0.2 + Math.cos(a) * r, -0.6 + Math.sin(a) * r * 0.8);
}
/** demo pupae: rows on the pupa-chamber floor */
export function pupaSpot(g: NestGraph, i: number, n: number, antLen: number): Pos {
  const c = first(g, 'pupa'), cols = Math.max(1, Math.ceil(n / 2)), col = i % cols, row = Math.floor(i / cols), pitch = Math.max(1.0, antLen * 0.8);
  return on(g, c.id, (c.x0 + c.x1) / 2 + (col - (cols - 1) / 2) * pitch + (row % 2 ? pitch * 0.4 : 0), -1.6 + row * Math.max(1.0, antLen * 0.7));
}
/** demo majors: one near the entrance passage, one in the food-exchange area, the others in the resting chambers */
export function majorSpot(g: NestGraph, i: number, seed: number, antLen: number): { pos: Pos; faceEast: boolean } {
  const roles = ['entry', 'exchange', 'rest', 'rest'] as const, list = g.chambersOf(roles[i % roles.length]), c = list[Math.floor(i / roles.length + (i % roles.length === 3 ? 1 : 0)) % list.length];
  const k = 0.25 + 0.5 * u01(`major|${seed}|${i}|x`);
  return { pos: on(g, c.id, c.x0 + (c.x1 - c.x0) * k, g.faceZ - 0.9 - antLen * 0.35 * (1 + (i % 2))), faceEast: u01(`major|${seed}|${i}|f`) < 0.5 };
}
