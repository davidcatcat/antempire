/**
 * Demo 2 — the numbers of the ant joint rig (display only). Pure: no DOM, no Three.js, no engine import.
 *
 * ONE source for both shader implementations of the rig: the GLSL vertex shader of the WebGL 2 renderer (ant-rig.ts)
 * and the TSL node graph of the opt-in WebGPU renderer (ant-rig-tsl.ts) take every amplitude, frequency, phase and
 * pivot from here, so the two renderers bend the same joints by the same amounts. The CPU side (gait phase, walk
 * weight, pose values: gait.ts) is shared as code. Amplitudes are radians or model units; frequencies are rad per
 * second of the micro-motion clock (frozen while the world is paused).
 */
export const RIG = {
  /** quasi-periodic noise qn(t, s) = Σ amp_i · sin(t · freq_i + s · phase_i) */
  qn: { amp: [0.5, 0.3, 0.2], freq: [1, 1.6180339, 2.4142136], phase: [6.2831, 2.71828, 4.1231] },
  headPivot: [0.245, 0.205, 0],
  act: { base: 0.55, mod: 0.45, freq: 0.13, seed: 0.9 },
  body: { bob: 0.006, idleBob: 0.003, idleFreq: 0.7, idleSeed: 0.3, drop: 0.04 },
  head: { yaw: 0.07, yawFreq: 0.55, yawSeed: 0.11, nod: 0.05, nodFreq: 0.8, nodSeed: 0.37, walk: 0.02 },
  gaster: { idle: 0.045, idleFreq: 0.35, idleSeed: 0.5, walk: 0.03, pitch: 0.12, cropX: 0.1, cropYZ: 0.36 },
  leg: { swing: 0.42, idle: 0.06, idleFreq: 0.23, idleSeed: 0.173, lift: 0.09, idleLift: 0.02, idleLiftFreq: 0.31, idleLiftSeed: 0.29, idleGate: 0.55 },
  antenna: { yaw: 0.24, yawFreq: 1.3, yawSeed: 0.43, walkYaw: 0.12, nod: 0.2, nodFreq: 0.97, nodSeed: 0.71, nodSeed0: 0.2, walkNod: 0.05, up: 0.45 },
} as const;
/** the cuticle material of the rigged castes, the same under both renderers */
export const CUTICLE = { roughness: 0.36, metalness: 0.05 } as const;
/** a number as a GLSL float literal (always with a decimal point) */
export const glf = (v: number) => (Number.isInteger(v) ? `${v}.0` : String(v));
