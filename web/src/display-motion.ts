/**
 * Display micro-motion (顯示動畫・示意): head yaw and independent left / right antenna movement, drawn ON TOP of an ant
 * whose body position and heading come only from the engine record (game view) or a physics export (prototype).
 *
 *  - Pure display: nothing here moves the body, changes a heading, creates an event or decides what an ant perceives.
 *    The drawn antenna positions are NOT sampling / contact events (real antenna sampling belongs to the physics +
 *    chemistry integration, PH-3b + CHEM, not to the viewer).
 *  - Time: every state is a function of the display time τ (simulated seconds) and the ant ID only. The memo caches in
 *    DisplayMotion are transparent (a fresh instance gives the same answer), so the result never depends on frame rate,
 *    frame order or how often it is asked.
 *  - Randomness: seeded per ant ID + named stream (hash), no unseeded generator, no wall clock.
 *  - Head yaw: a smooth non-periodic random curve (cubic B-spline through hashed knots, two incommensurate time scales)
 *    plus sparse event-driven glances (hashed slots) plus a lead into recorded / physical turns; soft-bounded.
 *  - Antennae: each side runs its own semi-Markov chain over modes sweep / probe / tap / rest (gamma-shaped seeded
 *    durations, no self-transition), each mode a smooth non-periodic curve; modes cross-fade over BLEND_S. Left and
 *    right use different streams, so they are not synchronized wipers.
 *  - Context (motion, turning, nearness to a recorded place / obstacle, exploring) comes from the caller's sampler,
 *    which must be a pure function of τ built from engine / physics data only.
 * Every number in MICRO is a display candidate assumption (示意／遊戲假設), listed in docs/game-art-style.md §5b. The
 * carpenter-ant antenna study (Camponotus, 非本種) is only the reason the two antennae are independent and multi-modal;
 * none of its angles or frequencies is used.
 */
import { h01, hash32 } from './art-core.ts';

/** Context at one display time, from engine / physics data only (0…1 except turn). */
export interface MicroContext {
  /** 0 = stationary … 1 = walking (smoothed over a short window by the caller) */
  motion: number;
  /** signed heading change ahead (rad, screen frame, + = toward the ant's right / clockwise); from recorded data */
  turn: number;
  /** 0 … 1 closeness to a recorded place or physical obstacle */
  near: number;
  /** 0 … 1 the record says the ant is searching / exploring (no known trail) */
  explore: number;
}
export type ContextSampler = (tauS: number) => MicroContext;
export type AntennaMode = 'sweep' | 'probe' | 'tap' | 'rest';
export const ANTENNA_MODES: readonly AntennaMode[] = ['sweep', 'probe', 'tap', 'rest'];
/** One antenna in the head frame: scape and funiculus angles measured from the head axis toward the OUTSIDE (rad);
 *  reach = top-view foreshortening of the funiculus (1 = held level, lower = tipped toward the ground). */
export interface AntennaPose { mode: AntennaMode; scape: number; fun: number; reach: number }
export interface MicroState { tauS: number; headYaw: number; L: AntennaPose; R: AntennaPose }

/** Display parameters — ALL 示意／遊戲假設 (none is a measurement of P. megacephala head or antenna motion). */
export const MICRO = {
  EPOCH_S: 6, BLEND_S: 0.18, CTX_GRID_S: 0.1, CTX_HALF_S: 0.3,
  neutral: { scape: 0.98, fun: 0.3, reach: 0.85 },
  head: { scaleS: [0.9, 0.31], weight: [0.75, 0.35], ampMoving: 0.035, ampStill: 0.075, ampExplore: 0.04, ampNear: 0.02,
    glanceSlotS: 0.4, glanceP: { moving: 0.06, still: 0.22, explore: 0.18, near: 0.12 }, glanceAmp: [0.05, 0.14], glanceDurS: [0.25, 0.7],
    turnGain: 0.35, turnMax: 0.12, max: 0.24 },
  lean: { gain: 0.5, max: 0.25 },
  modes: {
    sweep: { meanS: 1.1, scape: [0.98, 0.24], fun: [0.3, 0.4], reach: [0.84, 0.08], scaleS: 0.32 },
    probe: { meanS: 0.8, scape: [0.72, 0.07], fun: [0.02, 0.12], reach: [0.97, 0.02], scaleS: 0.22 },
    tap: { meanS: 0.7, scape: [0.92, 0.1], fun: [0.36, 0.16], reach: [0.88, 0.02], scaleS: 0.26, tapSlotS: 0.11, tapP: 0.5, tapDepth: 0.32, tapWidthS: 0.035 },
    rest: { meanS: 1.8, scape: [1.06, 0.03], fun: [0.5, 0.05], reach: [0.78, 0.02], scaleS: 1.2 },
  },
  durClampS: [0.2, 0.45 * 6],
} as const;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (x: number) => { const t = clamp(x, 0, 1); return t * t * (3 - 2 * t); };
/** Cubic uniform B-spline through hashed knots in [-1, 1]: smooth (C²), time-correlated, not periodic. */
export function bspline(seed: number, x: number): number {
  const i = Math.floor(x), f = x - i, k = (j: number) => h01(seed, i + j, 0x51, 0x7) * 2 - 1;
  const f2 = f * f, f3 = f2 * f;
  return (k(-1) * (1 - 3 * f + 3 * f2 - f3) + k(0) * (4 - 6 * f2 + 3 * f3) + k(1) * (1 + 3 * f + 3 * f2 - 3 * f3) + k(2) * f3) / 6 / 0.6;
}
/** mode switch weights from context (no self-transition); 示意 */
function modeWeights(c: MicroContext): Record<AntennaMode, number> {
  const m = clamp(c.motion, 0, 1), e = clamp(c.explore, 0, 1), n = clamp(c.near, 0, 1);
  return { sweep: 1 + 1.2 * e + 0.3 * (1 - m), probe: 0.4 + 1.4 * m * (1 - e) + 0.6 * n, tap: 0.2 + 0.8 * n + 0.6 * e + 0.4 * (1 - m), rest: 0.1 + 1.0 * (1 - m) * (1 - e) * (1 - n) };
}
interface Seg { start: number; mode: AntennaMode; gain: number }
interface Epoch { segs: Seg[] }
interface Glance { start: number; dur: number; amp: number }

/** Memo of the per-ant random processes. Transparent: results depend only on (antId, τ, sampler), never on the call
 *  history, so a fresh instance and a long-lived one agree exactly. clear() when the sampler's data change (new day). */
export class DisplayMotion {
  private raw = new Map<string, Epoch>();
  private glances = new Map<string, Glance | null>();
  private grid = new Map<string, MicroContext>();
  clear() { this.raw.clear(); this.glances.clear(); this.grid.clear(); }
  size() { return this.raw.size + this.glances.size + this.grid.size; }
  /** Context smoothed in time: a tent kernel (half-width CTX_HALF_S) over samples on a fixed absolute grid
   *  (CTX_GRID_S), so it is continuous in τ even where the record changes abruptly (departure, a new edge), and each
   *  grid sample is computed once. */
  ctxSmooth(id: string, tau: number, ctx: ContextSampler): MicroContext {
    const G = MICRO.CTX_GRID_S, W = MICRO.CTX_HALF_S, out = { motion: 0, turn: 0, near: 0, explore: 0 }; let ws = 0;
    for (let k = Math.ceil((tau - W) / G - 1e-9); k * G <= tau + W + 1e-9; k++) {
      const w = Math.max(0, 1 - Math.abs(tau - k * G) / W); if (w <= 0) continue;
      const key = `${id}|${k}`; let c = this.grid.get(key);
      if (!c) { c = ctx(k * G); this.grid.set(key, c); if (this.grid.size > 60000) this.grid.delete(this.grid.keys().next().value as string); }
      out.motion += w * c.motion; out.turn += w * c.turn; out.near += w * c.near; out.explore += w * c.explore; ws += w;
    }
    return { motion: out.motion / ws, turn: out.turn / ws, near: out.near / ws, explore: out.explore / ws };
  }

  /** Raw epoch e of one antenna: starts at e·EPOCH_S with a hashed mode, then seeded semi-Markov segments. */
  private rawEpoch(id: string, side: 'L' | 'R', e: number, ctx: ContextSampler): Epoch {
    const key = `${id}|${side}|${e}`; const have = this.raw.get(key); if (have) return have;
    const seed = hash32(`${id}|antenna|${side}|epoch|${e}`), E = MICRO.EPOCH_S, t0 = e * E, segs: Seg[] = [];
    let t = t0, j = 0, prev: AntennaMode | null = null;
    while (t < t0 + E) {
      const c = ctx(t), w = modeWeights(c), u = h01(seed, j, 1, 0);
      const opts = ANTENNA_MODES.filter((m) => m !== prev), tot = opts.reduce((s, m) => s + w[m], 0);
      let acc = 0, mode = opts[opts.length - 1];
      for (const m of opts) { acc += w[m] / tot; if (u < acc) { mode = m; break; } }
      const g = -Math.log(Math.max(1e-9, h01(seed, j, 2, 0))) - Math.log(Math.max(1e-9, h01(seed, j, 3, 0))); // gamma(k=2)
      const scale = mode === 'tap' ? 1 - 0.3 * clamp(c.near, 0, 1) : mode === 'rest' ? 0.6 + 0.8 * (1 - clamp(c.motion, 0, 1)) : 1;
      const dur = clamp((MICRO.modes[mode].meanS * scale * g) / 2, MICRO.durClampS[0], MICRO.durClampS[1]);
      segs.push({ start: t, mode, gain: 1 + 0.5 * clamp(c.explore, 0, 1) + 0.25 * clamp(c.near, 0, 1) });
      prev = mode; t += dur; j++;
    }
    const ep = { segs }; this.raw.set(key, ep); if (this.raw.size > 20000) this.raw.delete(this.raw.keys().next().value as string);
    return ep;
  }
  /** Segment active at τ with the segment before it (for the cross-fade). The first raw segment of an epoch is
   *  replaced by the segment that was running at the end of the previous epoch, so modes never jump at an epoch
   *  boundary; each raw epoch has ≥ 2 segments (durations ≤ 0.45 EPOCH_S), which keeps this non-recursive. */
  private segAt(id: string, side: 'L' | 'R', tau: number, ctx: ContextSampler): { cur: Seg; prev: Seg | null } {
    const e = Math.floor(tau / MICRO.EPOCH_S), r = this.rawEpoch(id, side, e, ctx).segs, rp = this.rawEpoch(id, side, e - 1, ctx).segs;
    const carried = rp[rp.length - 1];
    const beforeCarried = rp.length >= 3 ? rp[rp.length - 2] : (() => { const r2 = this.rawEpoch(id, side, e - 2, ctx).segs; return r2[r2.length - 1]; })();
    let i = r.length - 1; while (i > 0 && r[i].start > tau) i--;
    if (i === 0) return { cur: carried, prev: beforeCarried };
    return { cur: r[i], prev: i === 1 ? carried : r[i - 1] };
  }
  private glance(id: string, k: number, ctx: ContextSampler): Glance | null {
    const key = `${id}|${k}`; if (this.glances.has(key)) return this.glances.get(key) as Glance | null;
    const H = MICRO.head, seed = hash32(`${id}|head|glance`), start = (k + h01(seed, k, 1, 0) * 0.8) * H.glanceSlotS, c = ctx(start);
    const m = clamp(c.motion, 0, 1), p = H.glanceP.moving * m + H.glanceP.still * (1 - m) + H.glanceP.explore * clamp(c.explore, 0, 1) + H.glanceP.near * clamp(c.near, 0, 1);
    let g: Glance | null = null;
    if (h01(seed, k, 2, 0) < p) {
      const sgn = h01(seed, k, 3, 0) < 0.5 ? -1 : 1;
      g = { start, dur: H.glanceDurS[0] + (H.glanceDurS[1] - H.glanceDurS[0]) * h01(seed, k, 4, 0), amp: sgn * (H.glanceAmp[0] + (H.glanceAmp[1] - H.glanceAmp[0]) * h01(seed, k, 5, 0)) };
    }
    this.glances.set(key, g); if (this.glances.size > 40000) this.glances.delete(this.glances.keys().next().value as string);
    return g;
  }

  /** Head yaw (rad, + = toward the ant's right), soft-bounded by MICRO.head.max. */
  headYaw(id: string, tau: number, ctx: ContextSampler): number {
    const H = MICRO.head, c = this.ctxSmooth(id, tau, ctx), m = clamp(c.motion, 0, 1);
    const amp = H.ampMoving * m + H.ampStill * (1 - m) + H.ampExplore * clamp(c.explore, 0, 1) + H.ampNear * clamp(c.near, 0, 1);
    let y = amp * (H.weight[0] * bspline(hash32(`${id}|head|n0`), tau / H.scaleS[0]) + H.weight[1] * bspline(hash32(`${id}|head|n1`), tau / H.scaleS[1]));
    const k1 = Math.floor(tau / H.glanceSlotS);
    for (let k = k1 - Math.ceil(H.glanceDurS[1] / H.glanceSlotS) - 1; k <= k1; k++) {
      const g = this.glance(id, k, ctx); if (!g || tau < g.start || tau > g.start + g.dur) continue;
      const u = (tau - g.start) / g.dur; y += g.amp * (u < 0.3 ? smooth(u / 0.3) : 1 - smooth((u - 0.3) / 0.7)); // quick turn, slower return
    }
    y += clamp(c.turn * H.turnGain, -H.turnMax, H.turnMax);
    return H.max * Math.tanh(y / H.max);
  }

  private modePose(id: string, side: 'L' | 'R', s: Seg, tau: number): Omit<AntennaPose, 'mode'> {
    const P = MICRO.modes[s.mode], n = (stream: string, scale: number) => bspline(hash32(`${id}|antenna|${side}|${s.mode}|${stream}`), tau / scale);
    let reach = P.reach[0] + P.reach[1] * n('r', P.scaleS * 1.7);
    if (s.mode === 'tap') {
      const T = MICRO.modes.tap, seed = hash32(`${id}|antenna|${side}|taps`), k0 = Math.floor(tau / T.tapSlotS); let taps = 0;
      for (let k = k0 - 1; k <= k0 + 1; k++) if (h01(seed, k, 1, 0) < T.tapP) { const c = (k + 0.25 + 0.5 * h01(seed, k, 2, 0)) * T.tapSlotS; taps += Math.exp(-(((tau - c) / T.tapWidthS) ** 2)); }
      reach -= T.tapDepth * Math.min(1, taps);
    }
    return { scape: P.scape[0] + P.scape[1] * s.gain * n('s', P.scaleS), fun: P.fun[0] + P.fun[1] * s.gain * n('f', P.scaleS * 0.8), reach };
  }
  antenna(id: string, side: 'L' | 'R', tau: number, ctx: ContextSampler): AntennaPose {
    const { cur, prev } = this.segAt(id, side, tau, ctx), a = this.modePose(id, side, cur, tau);
    let out = a;
    const w = (tau - cur.start) / MICRO.BLEND_S;
    if (prev && w < 1) { const b = this.modePose(id, side, prev, tau), k = smooth(w); out = { scape: b.scape + (a.scape - b.scape) * k, fun: b.fun + (a.fun - b.fun) * k, reach: b.reach + (a.reach - b.reach) * k }; }
    // both antennae lean into a turn (common to both sides: + turn = toward the right = outward for R, inward for L)
    const lean = clamp(this.ctxSmooth(id, tau, ctx).turn * MICRO.lean.gain, -MICRO.lean.max, MICRO.lean.max) * (side === 'R' ? 1 : -1);
    return { mode: cur.mode, scape: clamp(out.scape + lean, 0.35, 1.5), fun: clamp(out.fun + lean, -0.45, 1.0), reach: clamp(out.reach, 0.45, 1) };
  }
  /** Full display state at τ. damp ∈ [0,1] scales every deviation from the neutral pose (e.g. at fast playback, where
   *  motion in simulated time would flicker); damp does not change the state machine. */
  state(id: string, tau: number, ctx: ContextSampler, damp = 1): MicroState {
    const N = MICRO.neutral, d = clamp(damp, 0, 1), f = (p: AntennaPose): AntennaPose => ({ mode: p.mode, scape: N.scape + (p.scape - N.scape) * d, fun: N.fun + (p.fun - N.fun) * d, reach: N.reach + (p.reach - N.reach) * d });
    return { tauS: tau, headYaw: this.headYaw(id, tau, ctx) * d, L: f(this.antenna(id, 'L', tau, ctx)), R: f(this.antenna(id, 'R', tau, ctx)) };
  }
}

/** Neutral pose (no micro-motion): what the "stiff" comparison draws. */
export const NEUTRAL_MICRO = (tau = 0): MicroState => ({ tauS: tau, headYaw: 0, L: { mode: 'rest', ...MICRO.neutral }, R: { mode: 'rest', ...MICRO.neutral } });

/** Damping of micro-motion amplitude by playback multiplier (simulated s per real s): at fast playback the motion is
 *  shown in simulated time and would flicker, so it fades (示意 display rule). */
export const playbackDamp = (mult: number) => (mult <= 1 ? 1 : 1 / (1 + 0.12 * (mult - 1)));

/** Build a context sampler from a raw per-time sampler of recorded data (moving 0/1, screen heading, near, explore).
 *  turn = mean heading change over a 0.8 s look-ahead (the head and antennae lead into a recorded turn); DisplayMotion
 *  smooths the result in time (ctxSmooth). */
export interface RawSample { moving: number; heading: number; near: number; explore: number }
export function smoothedContext(raw: (tauS: number) => RawSample): ContextSampler {
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  return (tau: number) => {
    const s0 = raw(tau), h0 = s0.heading, ahead = [0.3, 0.55, 0.8].map((o) => wrap(raw(tau + o).heading - h0));
    return { motion: s0.moving, near: s0.near, explore: s0.explore, turn: (ahead[0] + ahead[1] + ahead[2]) / 3 };
  };
}
