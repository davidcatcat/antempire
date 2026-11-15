/**
 * Demo 2 — where a worker OUTSIDE the nest is drawn. Pure: no DOM, no Three.js, no engine import.
 *
 * The surface positions come from the SAME display model as the 2-D experiment page and the 3-D prototype (VisModel,
 * vis1-model.ts): outbound / returning on the trip's display path (exactly at the nest entrance / the source at the
 * engine's departure / arrival instants, display interpolation between), feeding at the source (engine) in a display
 * slot, searching on the schematic search loop (search has no spatial model).
 * Demo 2 adds ONE display rule: the garden block ends at the soil cut just in front of the entrance, so every surface
 * point is FOLDED back at that edge (y → −2·FOLD_CM − y for y < −FOLD_CM; a mirror, so the drawn point stays
 * continuous and keeps its distance to the entrance within 2·FOLD_CM). Only the schematic search loop ever reaches the
 * edge; the route (engine length) lies behind it.
 */
import type { P0a2FrameMsg } from '../experimental/worker-protocol.ts';
import type { VisModel } from '../vis1-model.ts';
import { groundHeight } from '../three/terrain.ts';

/** the garden block of Demo 2 (cm): ground over [x0, x1] × [z0, z1]; the soil cut (front face) is at z = z1 */
export const BLOCK = { x0: -78, x1: 216, z0: -150, z1: 2.4, bottom: -44 } as const;
/** the surface fold line (2-D y, north positive): 1.2 cm in front of the entrance, 1.2 cm behind the cut face */
export const FOLD_CM = 1.2;
export const MOUNDS = [{ x: 0, z: 0 }] as const;
export const ground = (x: number, z: number) => groundHeight(x, z, MOUNDS);

/** fold a 2-D display point / heading at the cut edge */
export function fold(p: { x: number; y: number }, heading: number | null): { x: number; y: number; heading: number | null; folded: boolean } {
  if (p.y >= -FOLD_CM) return { x: p.x, y: p.y, heading, folded: false };
  return { x: p.x, y: -2 * FOLD_CM - p.y, heading: heading === null ? null : Math.atan2(-Math.sin(heading), Math.cos(heading)), folded: true };
}
/** display widening of the feeding spots around the source (the real-scale slots would make magnified ants overlap) */
export const slotSpread = (antLen: number) => Math.max(1, antLen / 1.2);

type PW = P0a2FrameMsg['workers'][number];
export interface SurfacePose {
  x: number; y: number; z: number;
  /** unit forward on the ground (null = no recorded heading) */
  fx: number | null; fy: number; fz: number;
  where: 'route' | 'source' | 'search'; moving: boolean; interpolated: boolean; schematic: boolean; dist_cm: number;
}
/** the drawn surface pose of a worker whose engine state is outside (outbound, searching, feeding, returning) */
export function surfacePose(vis: VisModel, w: PW, t: number, antLen: number): SurfacePose {
  const p = vis.pose(w, t), sp = slotSpread(antLen);
  const f = fold({ x: p.x + (p.slot?.dx ?? 0) * sp, y: p.y + (p.slot?.dy ?? 0) * sp }, p.heading);
  const x = f.x, z = -f.y, y = ground(x, z);
  let fx: number | null = null, fy = 0, fz = 0;
  if (f.heading !== null) {
    const hx = Math.cos(f.heading), hz = -Math.sin(f.heading), d = 0.6, slope = (ground(x + hx * d, z + hz * d) - ground(x - hx * d, z - hz * d)) / (2 * d), l = Math.hypot(1, slope);
    fx = hx / l; fy = slope / l; fz = hz / l;
  }
  return { x, y, z, fx, fy, fz, where: p.where as SurfacePose['where'], moving: p.walking, interpolated: p.interpolated, schematic: p.schematic, dist_cm: p.dist_cm };
}
/** the display corridor (the drawn foraging route) in 3-D ground coordinates */
export function corridor3(vis: VisModel, step = 8): { x: number; y: number; z: number }[] {
  const P = vis.corridor.line.pts, out: { x: number; y: number; z: number }[] = [];
  for (let i = 0; i < P.length; i += step) { const f = fold(P[i], null); out.push({ x: f.x, y: ground(f.x, -f.y), z: -f.y }); }
  const f = fold(P[P.length - 1], null); out.push({ x: f.x, y: ground(f.x, -f.y), z: -f.y });
  return out;
}
/** the source point in 3-D */
export function source3(vis: VisModel): { x: number; y: number; z: number } { const s = vis.corridor.source; return { x: s.x, y: ground(s.x, -s.y), z: -s.y }; }
