/**
 * Named random streams for the non-official experiment world.
 *
 * Each stream is a mulberry32 generator (same algorithm as engine/rng.ts, which the Worker may not import because it
 * pulls in engine/sha256.ts, outside the allowlist). A stream's state is ONE uint32 plus a draw counter, so a snapshot
 * holds its exact position and a restored stream continues with the identical next draw. Streams are named by entity
 * (e.g. `ant/w03`), so draws of one ant never shift draws of another, whatever the processing order of a batch.
 * Seed of a stream = first 4 bytes (little-endian) of sha256(`${seed}|${world_id}|${name}`).
 */
import { sha256, utf8 } from './sha256.ts';

export interface StreamState { state: number; draws: number }

export function streamSeed(seed: number, worldId: string, name: string): number {
  const d = sha256(utf8(`${seed}|${worldId}|${name}`));
  return (d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24)) >>> 0;
}

/** one mulberry32 step: returns the new state and the draw in [0, 1) */
export function nextDraw(state: number): { state: number; u: number } {
  const x = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(x ^ (x >>> 15), 1 | x);
  t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
  return { state: x >>> 0, u: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/**
 * A draw cursor over a COPY of a stream state: draws never touch the stored stream until the caller commits
 * `cursor.result()`. This keeps a batch atomic: if anything throws, no stream has moved.
 */
export class DrawCursor {
  private s: number; private n: number; readonly name: string; readonly from: number; readonly values: number[] = [];
  constructor(name: string, st: StreamState) { this.name = name; this.s = st.state >>> 0; this.n = st.draws; this.from = st.draws; }
  u(): number { const r = nextDraw(this.s); this.s = r.state; this.n++; this.values.push(r.u); return r.u; }
  result(): StreamState { return { state: this.s, draws: this.n }; }
}
