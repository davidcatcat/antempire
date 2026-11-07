/**
 * Common trajectory format for both solvers (Issue #101). Per agent: time-stamped samples [t, x, y, heading, s, u]; the
 * motion between two consecutive samples of ONE agent is a straight translation at constant velocity (exact for the
 * native piecewise-constant MV-1 records; for Rapier it is the integrator's own straight step x += v·dt). Per event:
 * kind, time, agents, source and class — physical contact events are kept apart from behavioural responses.
 */
import type { Lane2 } from '../../../engine/physics/body2d.ts';
import type { Scenario } from './spec.ts';

export type Sample = [t: number, x: number, y: number, heading: number, s: number, u: number];
export type EventClass = 'physical_contact' | 'physical_constraint' | 'behavioural_response' | 'motion' | 'solver_status';
export interface TrajEvent { t_s: number; kind: string; agents: string[]; class: EventClass; source: string; detail?: string | null }
export interface AgentTraj { lane: string; layer: string; samples: Sample[]; arrival_t_s: number | null; final_mode: string }
export interface Trajectory {
  solver: 'native' | 'rapier' | 'ph3b'; scenario: string;
  /** native: false — the 1-D lane model has no lateral coordinate, u = 0 is imposed when converting */
  lateral_dof: boolean;
  notes: string[];
  agents: Record<string, AgentTraj>;
  events: TrajEvent[];
}

/** Straight lane frame (the runners accept only single-segment passages). */
export interface LaneFrame { id: string; a: { x: number; y: number }; t: { x: number; y: number }; n: { x: number; y: number }; length: number; width: number; lane2: Lane2 }
export function laneFrames(sc: Scenario): Map<string, LaneFrame> {
  const m = new Map<string, LaneFrame>();
  for (const { passage: p } of sc.lanes) {
    if (p.centerline_mm.length !== 2) throw Error(`SOLVER_COMPARE: passage ${p.id} has a bend; this step handles straight passages only (bends are 'not checked' by the 2-D contract)`);
    const [a, b] = p.centerline_mm, len = Math.hypot(b[0] - a[0], b[1] - a[1]), t = { x: (b[0] - a[0]) / len, y: (b[1] - a[1]) / len };
    m.set(p.id, { id: p.id, a: { x: a[0], y: a[1] }, t, n: { x: -t.y, y: t.x }, length: len, width: p.width_mm as number, lane2: { id: p.id, centerline_mm: [{ x: a[0], y: a[1] }, { x: b[0], y: b[1] }], width_mm: p.width_mm } });
  }
  return m;
}
export const poseOn = (f: LaneFrame, s: number, u: number, dir: 1 | -1) => ({ x: f.a.x + f.t.x * s + f.n.x * u, y: f.a.y + f.t.y * s + f.n.y * u, heading: Math.atan2(f.t.y * dir, f.t.x * dir) });
export const project = (f: LaneFrame, x: number, y: number) => ({ s: (x - f.a.x) * f.t.x + (y - f.a.y) * f.t.y, u: (x - f.a.x) * f.n.x + (y - f.a.y) * f.n.y });

/** Position of an agent at time t: linear between its own samples, held before the first and after the last. */
export function posAt(samples: Sample[], t: number, hint = { i: 0 }): { x: number; y: number; heading: number } {
  const n = samples.length;
  if (t <= samples[0][0]) return { x: samples[0][1], y: samples[0][2], heading: samples[0][3] };
  if (t >= samples[n - 1][0]) return { x: samples[n - 1][1], y: samples[n - 1][2], heading: samples[n - 1][3] };
  let i = Math.min(hint.i, n - 2);
  if (samples[i][0] > t) i = 0;
  while (i < n - 2 && samples[i + 1][0] < t) i++;
  hint.i = i;
  const p = samples[i], q = samples[i + 1], f = q[0] === p[0] ? 1 : (t - p[0]) / (q[0] - p[0]);
  return { x: p[1] + (q[1] - p[1]) * f, y: p[2] + (q[2] - p[2]) * f, heading: f < 1 ? p[3] : q[3] };
}
