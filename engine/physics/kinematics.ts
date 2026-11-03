/**
 * MV-1 / MV-2 (Issue #69): individual kinematics along passage lanes (PH-1 geometry).
 *
 * Model (stated, not hidden):
 *  - An ant is a point on a passage centre-line at arc length s (mm), with a direction of travel (+1 / -1 along the
 *    centre-line), a current speed v (mm/s) and a state: moving / stopped / waiting.
 *  - Speed is PIECEWISE CONSTANT. Between two changes of speed the motion is exact: s(t) = s0 + dir·v·(t − t0),
 *    i.e. ds/dt = v(t). Every change of speed or state starts a new MotionInterval, and move intervals are also split at
 *    centre-line vertices so the 3D heading is constant inside every record. There is no fixed time step, so there is
 *    nothing to tunnel through: event times are computed analytically (time = distance / speed).
 *  - Distances are 3D arc length along the lane. Slope does NOT change speed (no species data; see the motion-candidates
 *    file); temperature does not change speed here either (not modelled in MV-1; stated in every record's model_ref).
 *  - Waiting and stopping are states with zero speed and a cause. Why an ant waits (yielding, a blocked lane …) is
 *    decided elsewhere (PH-2 collision layer or behaviour); this module only makes the time cost real.
 *
 * Units: mm, seconds, mm/s. Conversions to the route layer (cm, minutes) are explicit functions below.
 * Pure, deterministic, browser-safe. Not imported by the official day loop (tests/physics-isolation.test.ts).
 */
import { type Vec3, dist, lerp, norm, scale, sub } from './vec.ts';
import { type Passage, type PhysicsGeometry } from './geometry.ts';
import { hash32, rng, normal } from '../rng.ts';

export type MotionState = 'moving' | 'stopped' | 'waiting';
/** Travel direction relative to the nest, as used by the speed model (Vázquez et al. 2020 measured outbound/returning). */
export type TravelLeg = 'outbound' | 'returning' | 'unknown';

/** Time tolerance (s) and length tolerance (mm) for continuity checks: numerical, not model parameters. */
export const T_EPS = 1e-9;
export const S_EPS = 1e-9;

export const mmPerS_from_cmPerMin = (v: number): number => (v * 10) / 60;
export const cmPerMin_from_mmPerS = (v: number): number => (v * 60) / 10;
export const mm_from_cm = (x: number): number => x * 10;
export const minutes_from_s = (t: number): number => t / 60;

export interface AgentKinematics {
  id: string;
  passage: string;
  /** arc length along the passage centre-line (mm) */
  s_mm: number;
  /** +1 = increasing arc length, -1 = decreasing */
  dir: 1 | -1;
  t_s: number;
  state: MotionState;
  speed_mm_s: number;
  /** this individual's free walking speed on the current leg (mm/s), from the speed model */
  base_speed_mm_s: number;
}

export interface MotionInterval {
  agent: string;
  passage: string;
  kind: 'move' | 'wait' | 'stop';
  /** null for free walking; otherwise why the ant is not walking freely (e.g. 'yield', 'blocked', 'follow') */
  cause: string | null;
  /** another agent or object that caused it (local contact only; null when none) */
  cause_ref: string | null;
  t_start_s: number;
  t_end_s: number;
  s_start_mm: number;
  s_end_mm: number;
  /** distance actually walked (mm) = |s_end − s_start| */
  distance_mm: number;
  speed_mm_s: number;
  dir: 1 | -1;
  /** unit 3D heading of the walk (null when not moving) */
  heading: [number, number, number] | null;
  start_mm: [number, number, number];
  end_mm: [number, number, number];
  model_ref: string;
}

export const MODEL_REF = 'MV-1 piecewise-constant speed on PH-1 lanes; slope and temperature effects not modelled';

const tuple = (v: Vec3): [number, number, number] => [v.x, v.y, v.z];
const v3 = (p: [number, number, number]): Vec3 => ({ x: p[0], y: p[1], z: p[2] });

/**
 * Per-passage lane geometry (vertices and cumulative arc lengths), memoised by object identity. Geometry documents are
 * treated as immutable once loaded (mutating a passage after use would leave a stale cache; tests clone instead).
 * The memo changes no result, only speed.
 */
const laneCache = new WeakMap<Passage, { pts: Vec3[]; arcs: number[] }>();
function lane(p: Passage): { pts: Vec3[]; arcs: number[] } {
  let c = laneCache.get(p);
  if (!c) {
    const pts = p.centerline_mm.map(v3), arcs = [0];
    for (let i = 1; i < pts.length; i++) arcs.push(arcs[i - 1] + dist(pts[i - 1], pts[i]));
    c = { pts, arcs }; laneCache.set(p, c);
  }
  return c;
}

/** Cumulative arc length at each centre-line vertex (a fresh copy). */
export function vertexArcs(p: Passage): number[] {
  return lane(p).arcs.slice();
}
/** Total lane length (mm). */
export function laneLength(p: Passage): number {
  const a = lane(p).arcs; return a[a.length - 1];
}

/** 3D position at arc length s (clamped). */
export function positionAt(p: Passage, s: number): Vec3 {
  const { pts, arcs } = lane(p), L = arcs[arcs.length - 1];
  const x = Math.max(0, Math.min(L, s));
  for (let i = 1; i < pts.length; i++) if (x <= arcs[i] || i === pts.length - 1) {
    const l = arcs[i] - arcs[i - 1];
    return lerp(pts[i - 1], pts[i], l === 0 ? 0 : (x - arcs[i - 1]) / l);
  }
  return { ...pts[0] };
}

/** Unit heading of travel from arc length s in direction dir (uses the segment the ant is about to walk). */
export function headingAt(p: Passage, s: number, dir: 1 | -1): Vec3 {
  const { pts, arcs } = lane(p);
  let seg = 0;
  for (let i = 1; i < pts.length; i++) { seg = i - 1; if (dir > 0 ? s < arcs[i] - S_EPS : s <= arcs[i] + S_EPS) break; }
  const d = sub(pts[seg + 1], pts[seg]), n = norm(d);
  return n === 0 ? { x: 0, y: 0, z: 0 } : scale(d, dir / n);
}

export function passageOf(g: PhysicsGeometry, id: string): Passage {
  const p = g.passages.find((x) => x.id === id);
  if (!p) throw Error(`PHYSICS: passage ${id} not found`);
  return p;
}

/** Analytic time to walk from s0 to s1 at constant speed v (s). Infinity when v = 0 and the distance is positive. */
export function timeToReach(s0: number, s1: number, v: number): number {
  if (!(v >= 0) || !Number.isFinite(v)) throw Error(`PHYSICS: speed ${v} mm/s must be a finite non-negative number`);
  const d = Math.abs(s1 - s0);
  if (d <= S_EPS) return 0;
  return v === 0 ? Infinity : d / v;
}

/**
 * Walk the agent towards arc length `target_s` at constant speed v, stopping early at time `until_s` if given.
 * Returns the move intervals (split at centre-line vertices) and the updated agent. Pure: the input agent is not mutated.
 */
export function walk(p: Passage, a: AgentKinematics, target_s: number, v: number, opts: { until_s?: number; cause?: string | null; cause_ref?: string | null } = {}): { agent: AgentKinematics; intervals: MotionInterval[] } {
  if (p.id !== a.passage) throw Error(`PHYSICS: agent ${a.id} is on ${a.passage}, not ${p.id}`);
  const arcs = vertexArcs(p), L = arcs[arcs.length - 1];
  if (target_s < -S_EPS || target_s > L + S_EPS) throw Error(`PHYSICS: target ${target_s} mm outside passage ${p.id} [0, ${L}]`);
  const goal = Math.max(0, Math.min(L, target_s));
  if ((goal - a.s_mm) * a.dir < -S_EPS) throw Error(`PHYSICS: agent ${a.id} cannot walk backwards (target ${goal}, at ${a.s_mm}, dir ${a.dir}); turn first`);
  if (!(v > 0) || !Number.isFinite(v)) throw Error(`PHYSICS: walking speed ${v} mm/s must be positive and finite (use wait() for zero speed)`);
  const until = opts.until_s ?? Infinity;
  if (until < a.t_s - T_EPS) throw Error(`PHYSICS: until ${until} s is before the agent clock ${a.t_s} s`);
  // the full walk ends at t_end; if until comes first, the ant stops where it is at `until`
  const t_full = a.t_s + timeToReach(a.s_mm, goal, v);
  const t_end = Math.min(t_full, until);
  const s_end = t_end === t_full ? goal : a.s_mm + a.dir * v * (t_end - a.t_s);
  // split at vertices strictly between s_start and s_end
  const cuts = arcs.filter((x) => (x - a.s_mm) * a.dir > S_EPS && (s_end - x) * a.dir > S_EPS);
  if (a.dir < 0) cuts.reverse();
  const stops = [...cuts, s_end];
  const intervals: MotionInterval[] = [];
  let s = a.s_mm, t = a.t_s;
  for (const sNext of stops) {
    const dt = Math.abs(sNext - s) / v;
    if (Math.abs(sNext - s) <= S_EPS) continue;
    const h = headingAt(p, s, a.dir);
    intervals.push({
      agent: a.id, passage: p.id, kind: 'move', cause: opts.cause ?? null, cause_ref: opts.cause_ref ?? null,
      t_start_s: t, t_end_s: sNext === s_end ? t_end : t + dt, s_start_mm: s, s_end_mm: sNext, distance_mm: Math.abs(sNext - s), speed_mm_s: v, dir: a.dir,
      heading: tuple(h), start_mm: tuple(positionAt(p, s)), end_mm: tuple(positionAt(p, sNext)), model_ref: MODEL_REF,
    });
    t = sNext === s_end ? t_end : t + dt; s = sNext;
  }
  return { agent: { ...a, s_mm: s_end, t_s: t_end, state: t_end === t_full ? 'stopped' : 'moving', speed_mm_s: t_end === t_full ? 0 : v }, intervals };
}

/** Stand still for `duration_s` (state 'waiting' when there is a cause such as yielding, 'stopped' otherwise). */
export function wait(p: Passage, a: AgentKinematics, duration_s: number, cause: string | null, cause_ref: string | null = null): { agent: AgentKinematics; intervals: MotionInterval[] } {
  if (!(duration_s >= 0) || !Number.isFinite(duration_s)) throw Error(`PHYSICS: wait duration ${duration_s} s must be finite and ≥ 0`);
  if (duration_s === 0) return { agent: { ...a, speed_mm_s: 0 }, intervals: [] };
  const pos = tuple(positionAt(p, a.s_mm)), kind = cause === null ? 'stop' : 'wait';
  return {
    agent: { ...a, t_s: a.t_s + duration_s, speed_mm_s: 0, state: cause === null ? 'stopped' : 'waiting' },
    intervals: [{ agent: a.id, passage: p.id, kind, cause, cause_ref, t_start_s: a.t_s, t_end_s: a.t_s + duration_s, s_start_mm: a.s_mm, s_end_mm: a.s_mm, distance_mm: 0, speed_mm_s: 0, dir: a.dir, heading: null, start_mm: pos, end_mm: pos, model_ref: MODEL_REF }],
  };
}

/** Exact state at time t from a contiguous trajectory (linear inside each interval: speed is constant there). */
export function stateAt(traj: MotionInterval[], t: number): { s_mm: number; speed_mm_s: number; kind: MotionInterval['kind'] } | null {
  for (const r of traj) if (t >= r.t_start_s - T_EPS && t <= r.t_end_s + T_EPS) {
    const f = r.t_end_s === r.t_start_s ? 1 : Math.max(0, Math.min(1, (t - r.t_start_s) / (r.t_end_s - r.t_start_s)));
    return { s_mm: r.s_start_mm + (r.s_end_mm - r.s_start_mm) * f, speed_mm_s: r.speed_mm_s, kind: r.kind };
  }
  return null;
}

export interface TripSummary {
  agent: string;
  /** distance walked along the lane (mm) */
  path_length_mm: number;
  /** straight-line 3D distance between the start and end points (mm); ≤ path length */
  displacement_mm: number;
  moving_time_s: number;
  waiting_time_s: number;
  stopped_time_s: number;
  total_time_s: number;
  /** path length / moving time: the speed while actually walking */
  mean_moving_speed_mm_s: number | null;
  /** path length / total time: includes waits and stops */
  trip_speed_mm_s: number | null;
  /** total time minus the time the same path would take at the free base speed (waits, stops, slower walking) */
  added_time_s: number | null;
}

export function summarize(traj: MotionInterval[], free_speed_mm_s: number | null): TripSummary {
  if (!traj.length) throw Error('PHYSICS: empty trajectory');
  let path = 0, mt = 0, wt = 0, st = 0;
  for (const r of traj) {
    const dt = r.t_end_s - r.t_start_s;
    if (r.kind === 'move') { path += r.distance_mm; mt += dt; } else if (r.kind === 'wait') wt += dt; else st += dt;
  }
  const total = traj[traj.length - 1].t_end_s - traj[0].t_start_s;
  return {
    agent: traj[0].agent, path_length_mm: path, displacement_mm: dist(v3(traj[0].start_mm), v3(traj[traj.length - 1].end_mm)),
    moving_time_s: mt, waiting_time_s: wt, stopped_time_s: st, total_time_s: total,
    mean_moving_speed_mm_s: mt > 0 ? path / mt : null, trip_speed_mm_s: total > 0 ? path / total : null,
    added_time_s: free_speed_mm_s && free_speed_mm_s > 0 ? total - path / free_speed_mm_s : null,
  };
}

/**
 * Physical consistency of a trajectory (used by tests and by the collision layer): contiguous in time and space (no
 * teleport), non-negative durations, distance = speed × duration, positions on the passage, speed ≤ vmax.
 * Returns a list of violations (empty = consistent).
 */
export function checkTrajectory(p: Passage, traj: MotionInterval[], vmax_mm_s: number): string[] {
  const out: string[] = [], L = vertexArcs(p).at(-1)!;
  traj.forEach((r, i) => {
    const dt = r.t_end_s - r.t_start_s, tag = `${r.agent}#${i}`;
    if (dt < -T_EPS) out.push(`${tag}: negative duration`);
    if (Math.abs(Math.abs(r.s_end_mm - r.s_start_mm) - r.speed_mm_s * dt) > 1e-6 * Math.max(1, r.distance_mm)) out.push(`${tag}: |Δs| ≠ v·Δt`);
    if (Math.abs(r.distance_mm - Math.abs(r.s_end_mm - r.s_start_mm)) > S_EPS) out.push(`${tag}: distance mismatch`);
    if ((r.s_end_mm - r.s_start_mm) * r.dir < -S_EPS) out.push(`${tag}: moved against its heading`);
    if (r.s_start_mm < -S_EPS || r.s_end_mm > L + S_EPS || r.s_end_mm < -S_EPS || r.s_start_mm > L + S_EPS) out.push(`${tag}: off the passage`);
    if (r.speed_mm_s > vmax_mm_s + 1e-12) out.push(`${tag}: speed ${r.speed_mm_s} > vmax ${vmax_mm_s}`);
    if (r.kind !== 'move' && r.speed_mm_s !== 0) out.push(`${tag}: ${r.kind} with non-zero speed`);
    if (i > 0) {
      const q = traj[i - 1];
      if (q.passage === r.passage && Math.abs(q.t_end_s - r.t_start_s) > T_EPS) out.push(`${tag}: time gap/overlap ${q.t_end_s} → ${r.t_start_s}`);
      if (q.passage === r.passage && Math.abs(q.s_end_mm - r.s_start_mm) > S_EPS) out.push(`${tag}: teleport ${q.s_end_mm} → ${r.s_start_mm} mm`);
    }
  });
  return out;
}

// ---------------------------------------------------------------- MV-2: speed model

/** Candidate speed model (from scenarios/physics/<species>.motion-candidates.json; NOT the species parameter file). */
export interface SpeedModel {
  /** free walking speed on a detectable trail, by leg (mm/s); null = unknown */
  trail_speed_mm_s: { outbound: number | null; returning: number | null; pooled: number | null };
  /** multiplier off a detectable trail (the engine's existing activity.off_trail_speed_factor; game assumption) */
  off_trail_factor: number | null;
  /** coefficient of variation of the persistent individual speed trait; null = unknown → no individual variation */
  individual_cv: number | null;
}

/**
 * Population mean free speed for a leg (mm/s). 'unknown' leg uses the pooled value. Returns null when a needed value is
 * unknown — callers must not substitute a number.
 */
export function legSpeed(m: SpeedModel, leg: TravelLeg, onTrail: boolean): number | null {
  const base = leg === 'outbound' ? m.trail_speed_mm_s.outbound : leg === 'returning' ? m.trail_speed_mm_s.returning : m.trail_speed_mm_s.pooled;
  if (base === null) return null;
  if (onTrail) return base;
  return m.off_trail_factor === null ? null : base * m.off_trail_factor;
}

/**
 * Persistent individual speed multiplier (dimensionless, mean 1): drawn ONCE per individual from a named stream keyed by
 * (seed, agent id), so it does not depend on array order or on how many other ants exist. Log-normal with the given CV
 * (keeps speed positive). individual_cv null → 1 for everyone (variation unknown, not invented).
 */
export function individualSpeedFactor(seed: number, agentId: string, individual_cv: number | null): number {
  if (individual_cv === null || individual_cv === 0) return 1;
  if (!(individual_cv > 0) || !Number.isFinite(individual_cv)) throw Error(`PHYSICS: individual_cv ${individual_cv} must be ≥ 0`);
  const sigma2 = Math.log(1 + individual_cv * individual_cv), z = normal(rng(hash32(`${seed}|physics.individual_speed|${agentId}`)));
  return Math.exp(Math.sqrt(sigma2) * z - sigma2 / 2);
}

/** An individual's free walking speed on a leg (mm/s), or null when the model lacks a needed value. */
export function individualSpeed(m: SpeedModel, seed: number, agentId: string, leg: TravelLeg, onTrail: boolean): number | null {
  const v = legSpeed(m, leg, onTrail);
  return v === null ? null : v * individualSpeedFactor(seed, agentId, m.individual_cv);
}

// ---------------------------------------------------------------- event ordering

export interface WorldEvent { t_s: number; kind: string; agent: string; ref: string | null }
/**
 * Canonical order of world events: by time, then kind, then agent id, then ref. Never by array or insertion order, so
 * the same set of events always replays in the same order (tests: array-order invariance).
 */
export function orderEvents<E extends WorldEvent>(events: readonly E[]): E[] {
  return [...events].sort((a, b) => a.t_s - b.t_s || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0) || ((a.ref ?? '') < (b.ref ?? '') ? -1 : (a.ref ?? '') > (b.ref ?? '') ? 1 : 0));
}
