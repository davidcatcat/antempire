/**
 * Deterministic random streams. Every stochastic decision draws from a NAMED stream seeded by
 * sha256(`${seed}|${day}|${tag}`), so adding/removing one draw never shifts unrelated decisions.
 * Algorithms and constants are identical to the v6 engine (sim/day_engine.cjs).
 */
import { sha256, utf8 } from './sha256.ts';

export type Rng = () => number;

/** First 4 bytes of sha256(text) read as little-endian uint32 (== Buffer.readUInt32LE(0)). */
export function hash32(text: string): number {
  const d = sha256(utf8(text));
  return (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
}

/** mulberry32-style generator, verbatim from v6. */
export function rng(seed: number): Rng {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Named stream for the day being simulated (sim_day+1). */
export function dice(clock: { seed: number; sim_day: number }, tag: string): Rng {
  return rng(hash32(`${clock.seed}|${clock.sim_day + 1}|${tag}`));
}

/** Box–Muller standard normal (1e-12 guards log(0)); numerical constant, not a model parameter. */
export function normal(g: Rng): number {
  return Math.sqrt(-2 * Math.log(Math.max(1e-12, g()))) * Math.cos(2 * Math.PI * g());
}

/** Marsaglia–Tsang gamma sampler; the numeric constants belong to the algorithm, not the model. */
export function gamma(shape: number, scale: number, g: Rng): number {
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let k = 0; k < 10000; k++) {
    const x = normal(g);
    let v = 1 + c * x;
    if (v <= 0) continue;
    v = v * v * v;
    const u = g();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
  }
  throw Error('Gamma sampling failed');
}
