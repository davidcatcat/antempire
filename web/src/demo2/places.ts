/**
 * Demo 2 — fixed display places inside the nest chambers (展示假設). Pure: no DOM, no Three.js, no engine import.
 *
 * The engine has no position for a larva, a queen, an egg, a pupa or a major worker, and no resting place for a worker.
 * Where they are DRAWN is a display arrangement in the chamber with the matching role (data/demo2-nest-layout.json).
 * Deterministic (seeded hashes only); antLen = drawn minor body length (cm).
 *
 * Arrangement rules (畫面選擇, round 4 — "no rows, no identical facings, nothing drawn inside something else"):
 *  - brood piles (larvae, pupae, eggs) are seeded scatters with a minimum spacing, not rows; each item has its own yaw;
 *  - resting / standing places are packed irregularly along a chamber: every place has a seeded position, depth and
 *    heading, and no two places of a chamber overlap when seen from the front (their x-extents are disjoint per tier);
 *    a second tier of places is on the back wall of the chamber (the ant rests on the wall, seen from above);
 *  - majors and queens stand in reserved stretches of the floor, so resting places never coincide with them.
 */
import type { NestGraph, Pos } from './nest-graph.ts';
import { hash32 } from '../game-model.ts';
import { penetration, type Body } from './separate.ts';

const u01 = (key: string) => (hash32(key) >>> 0) / 4294967296;
const on = (g: NestGraph, chamberId: string, x: number, z: number): Pos => { const c = g.chamber(chamberId); return { edge: g.floorEdge(chamberId), s: Math.max(0.6, Math.min(c.x1 - c.x0 - 0.6, x - c.x0)), z: Math.max(g.backZ + 0.6, Math.min(g.faceZ - 0.8, z)) }; };
const first = (g: NestGraph, role: 'brood' | 'queen' | 'pupa' | 'rest' | 'entry' | 'exchange') => g.chambersOf(role)[0];

/** body model used for every "do two drawn bodies overlap" rule and test: a capsule along the heading
 *  (half-length and radius as fractions of the drawn body length; legs and antennae are not part of it). 畫面選擇 */
export const BODY = { half: 0.33, r: 0.13 } as const;

/** seeded scatter of n points in an ellipse (half-axes ax, az) with a minimum spacing dmin: point i depends only on the
 *  points before it (adding an item never moves the others). Unit: cm, relative to the pile centre. */
const scatterCache = new Map<string, { x: number; z: number }[]>();
export function scatter(key: string, n: number, ax: number, az: number, dmin: number): { x: number; z: number }[] {
  const ck = `${key}|${ax.toFixed(3)}|${az.toFixed(3)}|${dmin.toFixed(3)}`; let out = scatterCache.get(ck);
  if (!out) { out = []; scatterCache.set(ck, out); if (scatterCache.size > 64) scatterCache.delete(scatterCache.keys().next().value!); }
  for (let i = out.length; i < n; i++) {
    let best = { x: 0, z: 0 }, bestD = -1;
    for (let j = 0; j < 40; j++) {
      const a = u01(`${key}|${i}|${j}|a`) * Math.PI * 2, r = Math.sqrt(u01(`${key}|${i}|${j}|r`)), grow = 1 + Math.floor(j / 12) * 0.25, p = { x: Math.cos(a) * r * ax * grow, z: Math.sin(a) * r * az };
      let d = Infinity; for (const q of out) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
      if (d >= dmin) { best = p; bestD = d; break; }
      if (d > bestD) { best = p; bestD = d; }
    }
    out.push(best);
  }
  return out;
}

/** the i-th of n larvae on the brood-chamber floor: an irregular pile (engine: the larva exists; its place is display) */
export function larvaSpot(g: NestGraph, i: number, n: number, antLen: number): Pos {
  const c = first(g, 'brood'), d = Math.max(0.75, antLen * 0.5), ax = Math.min((c.x1 - c.x0) / 2 - 3.2, Math.max(1.5, d * 0.62 * Math.sqrt(Math.max(1, n)) * 1.5)), p = scatter('larva', Math.max(n, i + 1), ax, 0.95, d)[i];
  return on(g, c.id, (c.x0 + c.x1) / 2 + p.x, -1.55 + p.z);
}
/** where a carer stands next to a larva spot: on the side it arrives from (side = −1 west, +1 east), in front of the pile */
export function carerSpot(g: NestGraph, larva: Pos, side: -1 | 1, antLen: number): Pos {
  const c = first(g, 'brood'), k = u01(`carer|${larva.s.toFixed(3)}|${side}`); return on(g, c.id, c.x0 + larva.s + side * antLen * (0.5 + 0.3 * k), larva.z + antLen * (0.42 + 0.14 * k));
}
/** queens: in the back of the queen chamber, lying obliquely side by side (the chamber is not deep enough for bodies this
 *  long to lie across it), heads alternately one way and the other, each with its own small deviation — not a row of
 *  identical bodies */
export function queenPlace(g: NestGraph, i: number, n: number, antLen: number): { pos: Pos; yaw: number } {
  const c = first(g, 'queen'), w = c.x1 - c.x0, lo = c.x0 + w * 0.2, pitch = Math.min(antLen * 2.9, (w * 0.76) / Math.max(1, n));
  const slant = (u01('queen|slant') < 0.5 ? 1 : -1) * (0.5 + (u01(`queen|${i}|yaw`) - 0.5) * 0.16), yaw = slant + (i % 2 ? Math.PI : 0);
  return { pos: on(g, c.id, lo + pitch * (i + 0.5) + (u01(`queen|${i}|x`) - 0.5) * 0.3, -1.15 + (u01(`queen|${i}|z`) - 0.5) * 0.1), yaw };
}
export const queenSpot = (g: NestGraph, i: number, n: number, antLen: number): Pos => queenPlace(g, i, n, antLen).pos;
/** eggs: one loose cluster at the west end of the queen-chamber floor */
export function eggSpot(g: NestGraph, i: number, seed: number, antLen: number): Pos {
  const c = first(g, 'queen'), a = u01(`egg|${seed}|${i}|a`) * Math.PI * 2, r = Math.sqrt(u01(`egg|${seed}|${i}|r`)) * antLen * 0.6;
  return on(g, c.id, c.x0 + (c.x1 - c.x0) * 0.1 + Math.cos(a) * r * 0.7, -1.9 + Math.sin(a) * r * 0.6);
}
/** pupae: an irregular pile on the pupa-chamber floor */
export function pupaSpot(g: NestGraph, i: number, n: number, antLen: number): Pos {
  const c = first(g, 'pupa'), d = Math.max(0.85, antLen * 0.56), ax = Math.min((c.x1 - c.x0) / 2 - 2.2, Math.max(1.5, d * 0.62 * Math.sqrt(Math.max(1, n)) * 1.5)), p = scatter('pupa', Math.max(n, i + 1), ax, 0.95, d)[i];
  return on(g, c.id, (c.x0 + c.x1) / 2 + p.x, -1.6 + p.z);
}
/** majors: one in the entry chamber, one in the pupa chamber, the others in the brood chamber — each at one end of
 *  the floor (a reserved stretch: no resting place there). The seed only chooses which way it faces. */
export function majorSpot(g: NestGraph, i: number, seed: number, antLen: number): { pos: Pos; faceEast: boolean; yaw: number } {
  const roles = ['entry', 'pupa', 'brood', 'brood'] as const, list = g.chambersOf(roles[i % roles.length]), c = list[Math.floor(i / roles.length + (i % roles.length === 3 ? 1 : 0)) % list.length];
  const east = i % roles.length === 3 ? !(u01(`major|2|end`) < 0.5) : u01(`major|${i % roles.length}|end`) < 0.5, lap = Math.floor(i / roles.length) * 1.7 * antLen, x = east ? c.x1 - MAJOR_RESERVE * antLen - lap : c.x0 + MAJOR_RESERVE * antLen + lap, faceEast = u01(`major|${seed}|${i}|f`) < 0.5;
  return { pos: on(g, c.id, x, -1.3 + (u01(`major|${i}|z`) - 0.5) * 0.8), faceEast, yaw: (faceEast ? 0 : Math.PI) + (u01(`major|${seed}|${i}|y`) - 0.5) * 0.9 };
}
/** half-width of the floor stretch reserved around a major (× antLen) */
export const MAJOR_RESERVE = 1.15;
/** least width of a corridor between two groups of resting places (× antLen; a body is 2·BODY.r wide) */
export const CORRIDOR_BODY = 0.34;
/** depth (z, cm) from which a worker walks straight in to its standing / resting place, and straight out again */
export const PLACE_FRONT_Z = 1.15;

export interface Place {
  id: string; chamber: string;
  /** the floor point under the place */
  pos: Pos;
  /** heading: on the floor an angle in the floor plane (0 = +x, π/2 = +z); on the wall an angle in the wall plane (π/2 = up) */
  yaw: number;
  /** wall tier: the ant is on the back wall, `lift` cm above the floor (0 = floor tier) */
  wall: boolean; lift: number;
}
const placeCache = new Map<string, Place[]>();
/**
 * Irregular standing / resting places of a chamber. Floor tier: seeded x, depth (back part of the floor) and heading;
 * wall tier (only when `wall`): on the back wall above the floor tier. Within a tier the front-view extents
 * [x − e, x + e], e = BODY.half·|cos yaw| + BODY.r (+ gap), never intersect; the wall tier is above the floor tier.
 */
export function chamberPlaces(g: NestGraph, chamberId: string, antLen: number, wall: boolean): Place[] {
  const ck = `${chamberId}|${antLen.toFixed(4)}|${wall}`, hit = placeCache.get(ck); if (hit) return hit;
  if (!wall) { const loose = standPlaces(g, chamberId, antLen, ck); placeCache.set(ck, loose); return loose; }
  const c = g.chamber(chamberId), k = g.floorEdge(chamberId), w = c.x1 - c.x0, out: Place[] = [], gap = 0.06 * antLen;
  const reserved: [number, number][] = [];
  for (let i = 0; i < 4; i++) { const m = majorSpot(g, i, 0, antLen); if (g.edges[m.pos.edge].chamber === chamberId) reserved.push([m.pos.s - MAJOR_RESERVE * antLen, m.pos.s + MAJOR_RESERVE * antLen]); }
  // The floor tier is filled from one end to the other with seeded headings and seeded, uneven gaps, in groups of one or
  // two with a wider CORRIDOR between groups: dense enough for the whole colony, never evenly spaced. A wall place sits
  // at the back of a corridor, so an ant going to or from the wall walks between the resting ants, not through them.
  const zLo = g.backZ + 0.75, zHi = -0.35, ext = (yaw: number) => antLen * (BODY.half * Math.abs(Math.cos(yaw)) + BODY.r), corridors: number[] = [];
  const dir = u01(`${ck}|dir`) < 0.5 ? 1 : -1, lo = 0.7, hi = w - 0.7; let edge = dir > 0 ? lo : hi, group = 0, size = 1 + Math.floor(u01(`${ck}|g0`) * 2);
  for (let j = 0; j < 200; j++) {
    // headings: any direction, with more of them across the chamber than along it (a body seen end-on takes less room)
    const q = u01(`${ck}|${j}|q`), yaw = q < 0.8 ? (u01(`${ck}|${j}|s`) < 0.5 ? 1 : -1) * (Math.PI / 2 + (u01(`${ck}|${j}|y`) - 0.5) * 1.3) : u01(`${ck}|${j}|y`) * Math.PI * 2, e = ext(yaw);
    const corridor = group >= size, free = corridor ? antLen * (CORRIDOR_BODY + 0.12 * u01(`${ck}|${j}|c`)) : gap + antLen * 0.5 * u01(`${ck}|${j}|g`) ** 3; let sPos = edge + dir * (free + e), cAt = corridor ? edge + dir * free / 2 : null;
    for (const r of reserved) if (sPos + e > r[0] && sPos - e < r[1]) { sPos = dir > 0 ? r[1] + e + free : r[0] - e - free; cAt = corridor ? sPos - dir * (e + free / 2) : null; }
    if (sPos - e < lo || sPos + e > hi) break;
    if (corridor) { group = 0; size = 1 + Math.floor(u01(`${ck}|${j}|n`) * 2); if (cAt !== null) corridors.push(cAt); }
    edge = sPos + dir * e; group++; out.push({ id: `${chamberId}:f${j}`, chamber: chamberId, pos: { edge: k, s: sPos, z: zLo + u01(`${ck}|${j}|z`) * (zHi - zLo) }, yaw, wall: false, lift: 0 });
  }
  // the wall tier: above the floor tier (legs included), inside the dome, lift ∈ [0.8, 0.92] body lengths, head up or head down
  corridors.forEach((cs, j) => {
    const lift = antLen * (0.8 + 0.12 * u01(`${ck}|wall|${j}|l`)), yaw = (u01(`${ck}|wall|${j}|s`) < 0.5 ? 1 : -1) * (Math.PI / 2 + (u01(`${ck}|wall|${j}|y`) - 0.5) * 0.9), top = lift + antLen * (BODY.half + BODY.r) + 0.3;
    if (Math.abs(cs - w / 2) < (w / 2 + 0.6) * Math.sqrt(Math.max(0, 1 - (top / c.height) ** 2)) - 0.5) out.push({ id: `${chamberId}:w${j}`, chamber: chamberId, pos: { edge: k, s: cs, z: g.backZ + 0.06 }, yaw, wall: true, lift });
  });
  placeCache.set(ck, out); if (placeCache.size > 64) placeCache.delete(placeCache.keys().next().value!);
  return out;
}
/**
 * Standing places (not resting): scattered over the back and middle of the floor, any heading; no two bodies overlap
 * (they may stand one behind the other — only resting places are kept apart in the front view).
 */
function standPlaces(g: NestGraph, chamberId: string, antLen: number, ck: string): Place[] {
  const c = g.chamber(chamberId), k = g.floorEdge(chamberId), w = c.x1 - c.x0, out: Place[] = [], c0 = g.point({ edge: k, s: 0, z: 0 });
  const bodyOf = (id: string, s: number, z: number, yaw: number, len: number): Body => ({ id, realm: 'nest', x: c0.x + s, y: c0.y, z, fx: Math.cos(yaw), fy: 0, fz: Math.sin(yaw), len, mob: 0, zLo: z, zHi: z, partner: null });
  const taken: Body[] = [];
  for (let i = 0; i < 4; i++) { const m = majorSpot(g, i, 0, antLen); if (g.edges[m.pos.edge].chamber === chamberId) for (const yaw of [m.yaw, m.yaw + 0.45, m.yaw - 0.45]) taken.push(bodyOf(`m${i}`, m.pos.s, m.pos.z, yaw, antLen * 1.6)); }
  for (let j = 0; j < 400 && out.length < 24; j++) {
    const s = 1.3 + u01(`${ck}|stand|${j}|x`) * (w - 2.6), z = g.backZ + 0.8 + u01(`${ck}|stand|${j}|z`) * (0.1 - g.backZ - 0.8), yaw = u01(`${ck}|stand|${j}|y`) * Math.PI * 2, b = bodyOf(`s${j}`, s, z, yaw, antLen);
    if (taken.some((t) => penetration(t, b) > -0.12 * antLen)) continue;
    taken.push(b); out.push({ id: `${chamberId}:s${j}`, chamber: chamberId, pos: { edge: k, s, z }, yaw, wall: false, lift: 0 });
  }
  return out;
}
/** the unit forward / up of an ant standing at a place */
export function placeFrame(p: Place): { f: { x: number; y: number; z: number }; u: { x: number; y: number; z: number } } {
  return p.wall ? { f: { x: Math.cos(p.yaw), y: Math.sin(p.yaw), z: 0 }, u: { x: 0, y: 0, z: 1 } } : { f: { x: Math.cos(p.yaw), y: 0, z: Math.sin(p.yaw) }, u: { x: 0, y: 1, z: 0 } };
}
