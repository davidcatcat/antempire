/**
 * Three.js 3D prototype — where each simulated worker is drawn. Pure: no DOM, no Three.js, no engine import.
 *
 * Input: ONLY a P0-A2 frame from the experiment Worker (via web/src/experimental/worker-client.ts) and the display
 * time. The surface positions come from the SAME display model as the 2-D experiment page (VisModel in vis1-model.ts,
 * VIS-1), so the two renderers draw the same display path for the same trip:
 *  - outbound / returning: on the trip's display path (curved corridor, length = the engine route length); exactly at
 *    the nest / source at the recorded departure / arrival instants (engine), display interpolation in between
 *    (interpolated: true). The route LENGTH and timing are the engine's; its DIRECTION and shape are schematic.
 *  - feeding: at the source (engine); the spot around it is display arrangement (slot, widened with the magnification).
 *  - searching: search has no spatial model → the same schematic orbit around the nest as the 2-D page
 *    (schematic: true); the legs step because the engine says the worker is out searching, not because it goes anywhere.
 *  - in the nest: in the chamber of its engine-state group (nest3d.ts, schematic); to_entrance / from_entrance move
 *    along the drawn shaft with the engine's move timing (interpolated: true, path schematic).
 * No route, waypoint or position here is invented: with no frame there are no ants.
 */
import type { P0a2FrameMsg } from '../experimental/worker-protocol.ts';
import { VisModel } from '../vis1-model.ts';
import { hash32 } from '../game-model.ts';
import { groundHeight, to3, type Mound } from './terrain.ts';
import { CHAMBERS, alongPath, chamberOf, chamberSlot, shaftPath } from './nest3d.ts';

/** how one world's 2-D layout sits in the 3-D garden (main world: identity; benchmark worlds: offset + rotation) */
export interface WorldPlace { index: number; dx: number; dz: number; rot: number; cutaway: boolean }
export const MAIN_PLACE: WorldPlace = { index: 0, dx: 0, dz: 0, rot: 0, cutaway: true };

export type Where = 'route' | 'source' | 'search' | 'nest' | 'shaft';
export interface Ant3 {
  key: string; id: string; world: number; state: string;
  x: number; y: number; z: number;
  /** ground-plane heading: yaw = atan2(dz, dx); null = no recorded heading (the renderer keeps its last) */
  yaw: number | null; pitch: number;
  where: Where; moving: boolean; interpolated: boolean; schematic: boolean;
  /** hidden underground (benchmark worlds without a cut face): still rendered, never visible */
  buried: boolean;
}

const rot2 = (x: number, y: number, a: number) => ({ x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) });
/** 2-D layout point of world w → 3-D ground point */
export function place3(p: { x: number; y: number }, w: WorldPlace): { x: number; z: number } {
  const r = rot2(p.x, p.y, w.rot), q = to3(r); return { x: q.x + w.dx, z: q.z + w.dz };
}
/** the mound (entrance) of each world */
export const moundOf = (w: WorldPlace): Mound => ({ x: w.dx, z: w.dz });
/** the display corridor of a world in 3-D (every `step`-th polyline point; scenery keep-out and the schematic route line) */
export function corridorOf(vis: VisModel, w: WorldPlace, step = 10): { x: number; z: number }[] {
  const P = vis.corridor.line.pts, out: { x: number; z: number }[] = [];
  for (let i = 0; i < P.length; i += step) out.push(place3(P[i], w));
  if ((P.length - 1) % step !== 0) out.push(place3(P[P.length - 1], w));
  return out;
}
/** consecutive corridor points as keep-out segments */
export const segmentsOf = (pts: readonly { x: number; z: number }[]) => pts.slice(1).map((b, i) => ({ a: pts[i], b }));
/** display widening of the feeding spots around the source: the real-scale slots (≤ 3.4 cm) would make magnified ants
 *  overlap; the spot stays a display arrangement (示意) either way */
export const slotSpread = (antLen: number) => Math.max(1, antLen / 1.2);

/** a short slope sample along the heading so a walking ant pitches with the ground (display) */
function slopePitch(x: number, z: number, yaw: number, mounds: readonly Mound[]): number {
  const d = 0.6, cx = Math.cos(yaw) * d, cz = Math.sin(yaw) * d;
  return Math.atan2(groundHeight(x + cx, z + cz, mounds) - groundHeight(x - cx, z - cz, mounds), 2 * d);
}

/**
 * Every worker of one frame at display time t. vis = the display model of this frame's world (VisModel.of(frame)).
 * antLen = the drawn body length (cm), used only for slot spacing (display arrangement). mounds = all entrances.
 */
export function antsOf(f: P0a2FrameMsg, t: number, w: WorldPlace, antLen: number, mounds: readonly Mound[], vis: VisModel): Ant3[] {
  const out: Ant3[] = [], spread = slotSpread(antLen);
  // chamber membership by engine state, stable order (frame order)
  const members = new Map<string, string[]>();
  for (const k of f.workers) { const c = chamberOf(k.state); if (c) { const l = members.get(c.key) ?? []; l.push(k.id); members.set(c.key, l); } }
  for (const k of f.workers) {
    const base = { key: `${w.index}:${k.id}`, id: k.id, world: w.index, state: k.state };
    const p = vis.pose(k, t);
    if (p.where !== 'nest') {
      const q = place3({ x: p.x + (p.slot?.dx ?? 0) * spread, y: p.y + (p.slot?.dy ?? 0) * spread }, w);
      let yaw: number | null = null;
      if (p.heading !== null) { const d = rot2(Math.cos(p.heading), Math.sin(p.heading), w.rot), d3 = to3(d); yaw = Math.atan2(d3.z, d3.x); }
      const y = groundHeight(q.x, q.z, mounds);
      out.push({ ...base, x: q.x, y, z: q.z, yaw, pitch: yaw === null ? 0 : slopePitch(q.x, q.z, yaw, mounds), where: p.where, moving: p.walking, interpolated: p.interpolated, schematic: p.schematic, buried: false });
      continue;
    }
    // in the nest
    const h = hash32(`nest3|${k.id}`);
    if (!w.cutaway) {
      // benchmark world: no cut face; drawn (counted) just below its entrance, out of sight
      const a = ((h % 3600) / 3600) * Math.PI * 2, r = 1.5 + ((h >>> 12) % 50) / 10;
      out.push({ ...base, x: w.dx + Math.cos(a) * r, y: -6 - ((h >>> 20) % 30) / 10, z: w.dz + Math.sin(a) * r, yaw: a, pitch: 0, where: 'nest', moving: false, interpolated: false, schematic: true, buried: true });
      continue;
    }
    if ((k.state === 'to_entrance' || k.state === 'from_entrance') && k.until_s !== null && k.until_s > k.since_s) {
      const path = shaftPath(groundHeight(0, 0, mounds)), span = k.until_s - k.since_s, u = Math.max(0, Math.min(1, (t - k.since_s) / span));
      const along = alongPath(path, k.state === 'to_entrance' ? 1 - u : u);
      const sgn = k.state === 'to_entrance' ? -1 : 1, yaw = Math.atan2(sgn * along.dz, sgn * along.dx), pitch = Math.atan2(sgn * along.dy, Math.hypot(along.dx, along.dz));
      out.push({ ...base, x: along.x + w.dx, y: along.y, z: along.z + w.dz, yaw: Math.abs(along.dx) + Math.abs(along.dz) > 1e-6 ? yaw : null, pitch, where: 'shaft', moving: u > 0 && u < 1, interpolated: u > 0 && u < 1, schematic: true, buried: false });
      continue;
    }
    const c = chamberOf(k.state) ?? CHAMBERS[1], list = members.get(c.key) ?? [k.id], s = chamberSlot(c, list.indexOf(k.id), list.length, antLen, h);
    out.push({ ...base, x: s.x + w.dx, y: s.y, z: s.z + w.dz, yaw: s.yaw, pitch: 0, where: 'nest', moving: false, interpolated: false, schematic: true, buried: false });
  }
  return out;
}

/** micro-motion level per engine state (display only: how lively the in-place antenna / head / leg micro-movement is) */
export const ACTIVITY_LEVEL: Record<string, number> = {
  resting: 0.22, idle: 0.8, brood_care: 0.7, to_entrance: 0.55, from_entrance: 0.55, outbound: 0.6, returning: 0.6, searching: 1, feeding: 0.5,
};
