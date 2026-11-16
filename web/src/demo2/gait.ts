/**
 * Demo 2 — how a drawn ant LOOKS at its drawn point (畫面, display only). Pure: no DOM, no Three.js, no engine import.
 *
 * The P0-A2 world has no walking kinematics, no body contact and no antennation (matrix rows M21 / M22: 尚未模擬).
 * Everything here is a drawing rule, never physics. Every value is a FUNCTION of simulated time and of the distance
 * the drawn point has walked — nothing is integrated per rendered frame — so the same world instant gives the same
 * pose at any frame rate and any playback speed, and a paused world is perfectly still.
 *  - gait phase = phase0(ant) + 2π · odometer / stride(ant): legs cycle only as far as the drawn point moved (a standing
 *    ant's legs stand); stride and starting phase vary a little per individual (seeded), so no two ants are in lockstep;
 *  - legs: alternating tripod (R890: observed in Linepithema humile, 非本種 — the pattern is borrowed, no number is);
 *    a stance foot stays where it was put down: its tip moves back in the body frame by exactly the body's advance
 *    (footTip below is the CPU form of the leg rule the two shader rigs implement from rig-params.ts);
 *  - pose values (head pitch, antenna raise, crouch, activity, antenna scan / convergence, stride-pose weight) blend
 *    from the previous display pose over POSE_BLEND_S of simulated time.
 */
import type { Pose } from './stage.ts';
import { hash32 } from '../game-model.ts';
import { RIG } from './rig-params.ts';

/** stride (body lengths walked per full leg cycle). 畫面選擇: bounded by what the drawn legs can reach, not a species value */
export const STRIDE_PER_BODY = 0.5;
/** per-individual spread of the stride (± fraction) and of the starting phase (seeded by the ant id; 畫面選擇) */
export const STRIDE_SPREAD = 0.12;
/** model-space body length of the ant geometry (web/src/three/ant-model.ts MODEL_LEN; checked by the tests) */
export const MODEL_LEN = 0.95;
export const POSE_BLEND_S = 0.6;
/** how long after a stop the small in-place leg shifts fade in, and a resting ant's legs settle to neutral (s, simulated) */
export const SETTLE_S = 2.0;
/** seeded 0..1 with a finishing mix (ids that differ in one character must not get neighbouring values) */
const u01 = (key: string) => { let h = hash32(key) >>> 0; h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return (h >>> 0) / 4294967296; };

/** this ant's stride in cm at drawn body length L, and its starting phase */
export const strideCm = (id: string, L: number) => STRIDE_PER_BODY * L * (1 - STRIDE_SPREAD + 2 * STRIDE_SPREAD * u01(`stride|${id}`));
export const phase0 = (id: string) => u01(`phase|${id}`) * Math.PI * 2;
/** gait phase (rad) of an ant that has walked `odo` cm in total */
export const gaitPhase = (id: string, odo: number, L: number) => phase0(id) + (odo / strideCm(id, L)) * Math.PI * 2;
/** stance amplitude A in model units for a stride given in cm at drawn body length L (A = stride / 4) */
export const stanceAmp = (stride_cm: number, L: number) => (stride_cm / L) * MODEL_LEN / 4;

export interface PoseValues { pitch: number; antUp: number; crouch: number; act: number; scan: number; conv: number; legs: number }
/** display targets per pose. scan = exploratory antenna sweeps; conv = antennae toward a partner / larva; legs = how much
 *  of the frozen stride pose the legs keep (a resting ant's legs settle to neutral) */
export const POSE_TARGET: Record<Pose, PoseValues> = {
  walk: { pitch: 0, antUp: 0.15, crouch: 0, act: 0.6, scan: 1, conv: 0, legs: 1 },
  stand: { pitch: 0.04, antUp: 0.05, crouch: 0, act: 0.75, scan: 0.55, conv: 0, legs: 1 },
  rest: { pitch: 0.14, antUp: -0.75, crouch: 1, act: 0.14, scan: 0, conv: 0, legs: 0 },
  feed: { pitch: 0.5, antUp: -0.3, crouch: 0.45, act: 0.5, scan: 0.15, conv: 0.3, legs: 1 },
  troph: { pitch: -0.12, antUp: 0.6, crouch: 0, act: 0.95, scan: 0.1, conv: 1, legs: 1 },
  brood: { pitch: 0.42, antUp: 0.1, crouch: 0.3, act: 0.85, scan: 0.1, conv: 0.8, legs: 1 },
};
const smooth = (k: number) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
/** the pose values `since` seconds (simulated) after the display pose changed from `prev` to `cur` */
export function poseValues(prev: Pose, cur: Pose, since: number): PoseValues {
  const a = POSE_TARGET[prev], b = POSE_TARGET[cur], k = smooth(since / POSE_BLEND_S), ks = smooth(since / SETTLE_S), mix = (x: number, y: number, w: number) => x + (y - x) * w;
  return { pitch: mix(a.pitch, b.pitch, k), antUp: mix(a.antUp, b.antUp, k), crouch: mix(a.crouch, b.crouch, ks), act: mix(a.act, b.act, k), scan: mix(a.scan, b.scan, k), conv: mix(a.conv, b.conv, k), legs: mix(a.legs, b.legs, ks) };
}

/** leg table: hips of the fore / mid / hind legs (model units; = ant-model.ts) and the tripod group of each of the six legs
 *  (index 0..2 = +z side fore, mid, hind; 3..5 = −z side) */
export const HIPS: readonly [number, number, number][] = [[0.19, 0.145, 0.035], [0.115, 0.135, 0.04], [0.045, 0.135, 0.04]];
export const tripodGroup = (leg: number) => { const side = leg < 3 ? 1 : -1, pair = leg % 3; return pair === 1 ? (side > 0 ? 1 : 0) : side > 0 ? 0 : 1; };
/** is this leg in stance at gait phase ph */
export function legCycle(leg: number, ph: number): { cyc: number; stance: boolean } { const c = (ph + tripodGroup(leg) * Math.PI) / (Math.PI * 2), cyc = c - Math.floor(c); return { cyc, stance: cyc < 0.5 }; }
/**
 * Model-space tarsus tip of one leg at gait phase ph (the leg rule of the rigs; rig-params.ts RIG.leg):
 * stance — the tip goes straight back from +A to −A; swing — forward again with a lift. legs = stride-pose weight.
 */
export function footTip(leg: number, ph: number, A: number, legs = 1): { x: number; y: number; z: number; stance: boolean } {
  const side = leg < 3 ? 1 : -1, pair = leg % 3, { cyc, stance } = legCycle(leg, ph), hip = HIPS[pair], r = RIG.leg.reach[pair];
  let D: number, lift: number;
  if (stance) { D = A * (1 - 4 * cyc); lift = 0; } else { const u = (cyc - 0.5) * 2; D = -A * Math.cos(Math.PI * u); lift = RIG.leg.lift * Math.sin(Math.PI * u); }
  return { x: hip[0] + r[0] + D * legs, y: lift * legs, z: (hip[2] + r[1]) * side, stance };
}
