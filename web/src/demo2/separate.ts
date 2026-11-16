/**
 * Demo 2 — display-only body separation (畫面). Pure: no DOM, no Three.js, no engine import.
 *
 * The P0-A2 world has no bodies and no contact (matrix row M21: 尚未模擬). So that two DRAWN ants are not drawn inside
 * each other, the drawn points of one instant are moved apart here. This is a drawing rule, not physics:
 *  - a body is a capsule along its heading (places.ts BODY);
 *  - the correction is a function of the positions of THAT instant only (no memory, no time step): the same world
 *    instant gives the same result at any frame rate, and it changes continuously as the ants move;
 *  - in the nest an ant is only moved along the depth of the cavity (z; clamped to the cavity depth), so it can never be
 *    pushed into the soil; on the surface it is moved sideways on the ground plane;
 *  - who gives way: mobility (walking 1, standing less, resting / static 0) — a resting ant is never moved.
 */
import { BODY } from './places.ts';

export interface Body {
  id: string; realm: 'surface' | 'nest'; x: number; y: number; z: number; fx: number; fy: number; fz: number;
  /** drawn body length (cm) */
  len: number;
  /** 0 = never moved … 1 = gives way fully */
  mob: number;
  /** allowed z range (nest) */
  zLo: number; zHi: number;
  /** a body this one is meant to touch (trophallaxis partner): no correction between the two */
  partner: string | null;
}
/** extra clearance kept between two bodies (× the smaller body length) */
export const CLEARANCE = 0.04;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** closest distance between the axes of two capsules, and the points where it is attained */
export function axisDistance(a: Body, b: Body, ax = a.x, ay = a.y, az = a.z, bx = b.x, by = b.y, bz = b.z): { d: number; px: number; py: number; pz: number } {
  const ha = BODY.half * a.len, hb = BODY.half * b.len, wx = ax - bx, wy = ay - by, wz = az - bz;
  const dab = a.fx * b.fx + a.fy * b.fy + a.fz * b.fz, da = a.fx * wx + a.fy * wy + a.fz * wz, db = b.fx * wx + b.fy * wy + b.fz * wz, den = 1 - dab * dab;
  let s = den > 1e-9 ? clamp((dab * db - da) / den, -ha, ha) : 0, t = clamp(db + dab * s, -hb, hb); s = clamp(dab * t - da, -ha, ha); t = clamp(db + dab * s, -hb, hb);
  const px = wx + a.fx * s - b.fx * t, py = wy + a.fy * s - b.fy * t, pz = wz + a.fz * s - b.fz * t;
  return { d: Math.hypot(px, py, pz), px, py, pz };
}
/** how deep two bodies are inside each other (cm; ≤ 0 = apart) */
export function penetration(a: Body, b: Body): number { return (a.len + b.len) * BODY.r - axisDistance(a, b).d; }

/**
 * Offsets (cm) that move the bodies of one instant apart. Jacobi iterations: every pass reads the positions of the pass
 * before, so the result does not depend on the order of the list.
 */
/** how much of the remaining overlap one pass removes */
const GAIN = 1;
export function separate(bodies: readonly Body[], passes = 8): Map<string, { x: number; z: number }> {
  const n = bodies.length, ox = new Float64Array(n), oz = new Float64Array(n), order = bodies.map((_, i) => i).sort((i, j) => (bodies[i].id < bodies[j].id ? -1 : 1));
  // the pairs that can touch at all (in id order, so the result does not depend on the order of the list)
  const pairs: number[] = [];
  for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
    const i = order[p], j = order[q], a = bodies[i], b = bodies[j];
    if (a.realm !== b.realm || a.mob + b.mob <= 0 || a.partner === b.id || b.partner === a.id) continue;
    const reach = (a.len + b.len) * (BODY.half + BODY.r + CLEARANCE) + 6;
    if (Math.abs(a.x - b.x) > reach || Math.abs(a.y - b.y) > reach || Math.abs(a.z - b.z) > reach) continue;
    pairs.push(i, j);
  }
  if (!pairs.length) return new Map();
  for (let pass = 0; pass < passes; pass++) {
    const dx = new Float64Array(n), dz = new Float64Array(n), cnt = new Uint16Array(n);
    for (let q = 0; q < pairs.length; q += 2) {
      const i = pairs[q], j = pairs[q + 1], a = bodies[i], b = bodies[j];
      const need = (a.len + b.len) * BODY.r + Math.min(a.len, b.len) * CLEARANCE, k = axisDistance(a, b, a.x + ox[i], a.y, a.z + oz[i], b.x + ox[j], b.y, b.z + oz[j]);
      if (k.d >= need) continue;
      // (two bodies that both hardly give way — beside the entrance, in a contact pose — are corrected only in proportion)
      const push = (need - k.d) * Math.min(1, 2.5 * Math.max(a.mob, b.mob)), sa = a.mob / (a.mob + b.mob), sb = 1 - sa; cnt[i]++; cnt[j]++;
      // Which side each of the two takes is decided by their UNCORRECTED centres (not by the closest points of the
      // capsules, which jump when a body turns, and not by the corrected positions, which would feed back): the side it
      // is already on; when the centres are level, a fixed side per pair (by id).
      // The weight goes linearly through zero where the order of the two changes, so the correction is continuous in
      // the positions — it never flips from one instant to the next.
      const bias = 0.2 * Math.min(a.len, b.len);
      if (a.realm === 'nest') {
        // along the cavity depth only
        const m = push * GAIN * clamp((a.z - b.z + bias) / bias, -1, 1);
        dz[i] += m * sa; dz[j] -= m * sb;
      } else {
        // on the ground plane, sideways to the heading of the first of the two
        const nx = -a.fz, nz = a.fx, l = Math.hypot(nx, nz) || 1, side = ((a.x - b.x) * nx + (a.z - b.z) * nz) / l, m = push * GAIN * clamp((side + bias) / bias, -1, 1);
        dx[i] += (nx / l) * m * sa; dz[i] += (nz / l) * m * sa; dx[j] -= (nx / l) * m * sb; dz[j] -= (nz / l) * m * sb;
      }
    }
    // a body pressed by several others takes the mean of their corrections (the sum would overshoot and oscillate)
    for (let i = 0; i < n; i++) { const b = bodies[i], c = Math.max(1, cnt[i]); ox[i] += dx[i] / c; oz[i] += dz[i] / c; if (b.realm === 'nest') { ox[i] = 0; oz[i] = clamp(b.z + oz[i], Math.min(b.zLo, b.z), Math.max(b.zHi, b.z)) - b.z; } }
  }
  const out = new Map<string, { x: number; z: number }>();
  for (let i = 0; i < n; i++) if (ox[i] !== 0 || oz[i] !== 0) out.set(bodies[i].id, { x: ox[i], z: oz[i] });
  return out;
}
