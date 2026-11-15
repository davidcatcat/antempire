/**
 * Demo 2 — how a drawn ant LOOKS at its drawn point (display only). Pure: no DOM, no Three.js, no engine import.
 *
 * Nothing here moves an ant: the point always comes from stage.ts (engine state + display interpolation).
 *  - gait phase advances ONLY with the distance the drawn point actually moved (stride = a fixed fraction of the
 *    drawn body length, so stance feet stay planted at any magnification): a standing ant's legs stand;
 *  - walk weight, activity level and the pose values (head pitch, antenna raise, crouch) ease toward their targets so a
 *    stop reads as a deceleration into a stance and a pose change is not a pop;
 *  - a displacement larger than CUT_CM in one drawn frame is a cut (engine-defined discontinuity), not a walk;
 *  - paused (dtReal = 0): nothing changes.
 * Pose targets per display pose: feeding / tending a larva = head down; trophallaxis = head level, antennae forward;
 * resting = crouched, antennae lowered. The gaster distension shows the ENGINE crop fill.
 */
import type { Pose } from './stage.ts';

export const STRIDE_PER_BODY = 0.55;
export const CUT_CM = 12;
export interface PoseTarget { pitch: number; antUp: number; crouch: number; act: number }
export const POSE_TARGET: Record<Pose, PoseTarget> = {
  walk: { pitch: 0, antUp: 0.15, crouch: 0, act: 0.6 },
  stand: { pitch: 0.04, antUp: 0, crouch: 0, act: 0.75 },
  rest: { pitch: 0.14, antUp: -0.75, crouch: 1, act: 0.16 },
  feed: { pitch: 0.5, antUp: -0.3, crouch: 0.45, act: 0.5 },
  troph: { pitch: -0.12, antUp: 0.75, crouch: 0, act: 0.95 },
  brood: { pitch: 0.42, antUp: 0.1, crouch: 0.3, act: 0.85 },
};
export interface Gait { phase: number; walk: number; act: number; pitch: number; antUp: number; crouch: number; x: number; y: number; z: number; init: boolean; cut: boolean }
export const newGait = (): Gait => ({ phase: 0, walk: 0, act: 0.3, pitch: 0, antUp: 0, crouch: 0, x: 0, y: 0, z: 0, init: false, cut: false });
/** advance one ant's display look by dtReal wall seconds given its new drawn point; returns the same object */
export function stepGait(m: Gait, p: { x: number; y: number; z: number; moving: boolean; pose: Pose }, dtReal: number, bodyLen: number): Gait {
  const T = POSE_TARGET[p.pose], dist = Math.hypot(p.x - m.x, p.y - m.y, p.z - m.z);
  if (!m.init || dist > CUT_CM) { Object.assign(m, { x: p.x, y: p.y, z: p.z, walk: p.moving ? 1 : 0, act: T.act, pitch: T.pitch, antUp: T.antUp, crouch: T.crouch, cut: m.init, init: true }); return m; }
  m.cut = false;
  if (dtReal <= 0) { m.x = p.x; m.y = p.y; m.z = p.z; return m; }
  m.phase = (m.phase + (dist / Math.max(1e-6, STRIDE_PER_BODY * bodyLen)) * Math.PI * 2) % (Math.PI * 2 * 1024);
  const k = (rate: number) => 1 - Math.exp(-dtReal * rate), want = p.moving && dist > 1e-7 ? 1 : 0;
  m.walk += (want - m.walk) * k(8); m.act += (T.act - m.act) * k(2.5); m.pitch += (T.pitch - m.pitch) * k(4); m.antUp += (T.antUp - m.antUp) * k(4); m.crouch += (T.crouch - m.crouch) * k(3);
  m.x = p.x; m.y = p.y; m.z = p.z;
  return m;
}
