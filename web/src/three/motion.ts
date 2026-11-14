/**
 * Three.js 3D prototype — per-ant DISPLAY motion state. Pure: no DOM, no Three.js, no engine import.
 *
 * Nothing here moves an ant: the position always comes from placement.ts (engine state + display interpolation).
 * This module only decides how the drawn body looks while it is at that position:
 *  - gait phase advances with the distance the drawn position actually moved (stride = a fixed fraction of the drawn
 *    body length, so feet stay planted at any magnification) — when the engine says the ant stands, the legs stand;
 *  - a DISPLAY TURN eases the drawn heading toward the recorded heading only when the recorded heading changes
 *    (Owner decision 20); the legs step in place while the body turns;
 *  - a jump between unrelated positions (e.g. nest chamber → surface when the engine state changes) is a cut, not a
 *    walk: no gait phase, the heading snaps.
 * The in-place micro-motion (antennae, head, gaster, small leg shifts) is computed in the vertex shader from a per-ant
 * seed and the activity level of the engine state (placement.ts ACTIVITY_LEVEL); it never changes the position.
 */
export const STRIDE_PER_BODY = 0.55;
export const TURN_RATE = 5.5; // rad / s of display time, the fastest drawn turn
export const CUT_CM = 12; // a per-frame displacement larger than this is a cut (state change), not walking

export interface Motion { yaw: number; target: number; phase: number; walk: number; act: number; x: number; y: number; z: number; init: boolean }
export const newMotion = (): Motion => ({ yaw: 0, target: 0, phase: 0, walk: 0, act: 0.3, x: 0, y: 0, z: 0, init: false });

const wrap = (a: number) => { let d = a % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

export interface MotionInput { x: number; y: number; z: number; yaw: number | null; moving: boolean; act: number }
/**
 * Advance one ant's display state by dtReal seconds of wall time (animation smoothing) given the new drawn position.
 * bodyLen = drawn body length (cm). Returns the same object (mutated).
 */
export function stepMotion(m: Motion, a: MotionInput, dtReal: number, bodyLen: number): Motion {
  const dist = Math.hypot(a.x - m.x, a.y - m.y, a.z - m.z), stride = Math.max(1e-6, STRIDE_PER_BODY * bodyLen);
  if (!m.init || dist > CUT_CM) {
    m.x = a.x; m.y = a.y; m.z = a.z; if (a.yaw !== null) { m.yaw = a.yaw; m.target = a.yaw; } m.walk = a.moving ? 1 : 0; m.act = a.act; m.init = true; return m;
  }
  if (a.yaw !== null && Math.abs(wrap(a.yaw - m.target)) > 1e-6) m.target = a.yaw; // a recorded heading change
  const dYaw = wrap(m.target - m.yaw), maxTurn = TURN_RATE * dtReal, turn = Math.abs(dYaw) <= maxTurn ? dYaw : Math.sign(dYaw) * maxTurn;
  m.yaw = wrap(m.yaw + turn);
  const turning = Math.abs(turn) > 1e-4;
  m.phase = (m.phase + (dist / stride) * Math.PI * 2 + Math.abs(turn) * 1.6) % (Math.PI * 2 * 1024);
  const want = a.moving && dist > 1e-6 ? 1 : turning ? 0.6 : 0, k = 1 - Math.exp(-dtReal * 8);
  m.walk += (want - m.walk) * k;
  m.act += (a.act - m.act) * (1 - Math.exp(-dtReal * 2));
  m.x = a.x; m.y = a.y; m.z = a.z;
  return m;
}
