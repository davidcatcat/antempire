/**
 * PH-3b runner (docs/physics-ph3b-solver2d.md): the isolated event-driven 2-D solver engine/physics/solver2d.ts on the
 * common solver-compare spec, converted to the common trajectory format (lib/traj.ts) so the SAME judge (lib/judge.ts)
 * grades it. Body sizes, speeds and widths come only from the spec loader (lib/spec.ts, candidate files); lateral offsets
 * u stay at the spec start values for the whole run (the lateral steering model is unknown, null). No biological decision.
 */
import { solve2D, type Solver2DInput, type Solver2DResult, type StaticShape } from '../../../engine/physics/solver2d.ts';
import type { BroadphaseKind } from '../../../engine/physics/broadphase.ts';
import { obstacleReachesLevel } from '../../../engine/physics/geometry.ts';
import type { Scenario } from './spec.ts';
import type { Trajectory } from './traj.ts';

export interface Ph3bOptions { broadphase?: BroadphaseKind; window_s?: number; grid_cell_mm?: number; reverse_order?: boolean }

export function ph3bInput(sc: Scenario, o: Ph3bOptions = {}): Solver2DInput {
  const body = { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value };
  const obstacles: StaticShape[] = [];
  for (const ob of sc.obstacles) for (const l of sc.lanes) {
    if (!obstacleReachesLevel(ob, l.z_mm, l.z_mm) || obstacles.some((x) => x.id === ob.id && x.layer === l.layer)) continue;
    obstacles.push(ob.shape.type === 'circle' ? { id: ob.id, layer: l.layer, kind: 'circle', center_mm: { x: ob.shape.center_mm[0], y: ob.shape.center_mm[1] }, radius_mm: ob.shape.radius_mm } : { id: ob.id, layer: l.layer, kind: 'polygon', points_mm: ob.shape.points_mm.map(([x, y]) => ({ x, y })) });
  }
  const agents = sc.agents.map((a) => ({ id: a.id, lane: a.passage, s_mm: a.s_mm, u_mm: a.u_mm, dir: a.dir, start_t_s: a.start_t_s, goal_s_mm: a.goal_s_mm, free_speed_mm_s: a.free_speed_mm_s, body }));
  return {
    lanes: sc.lanes.map((l) => ({ id: l.passage.id, centerline_mm: l.passage.centerline_mm.map(([x, y]) => ({ x, y })), width_mm: l.passage.width_mm, layer: l.layer })),
    obstacles, agents: o.reverse_order ? [...agents].reverse() : agents, horizon_s: sc.horizon_s,
    broadphase: o.broadphase, window_s: o.window_s, grid_cell_mm: o.grid_cell_mm,
  };
}

export function toTrajectory(sc: Scenario, res: Solver2DResult): Trajectory {
  const agents: Trajectory['agents'] = {};
  for (const id of Object.keys(res.agents).sort()) { const a = res.agents[id]; agents[id] = { lane: a.lane, layer: a.layer, samples: a.samples, arrival_t_s: a.arrival_t_s, final_mode: a.final_mode }; }
  return {
    solver: 'ph3b', scenario: sc.id, lateral_dof: true,
    notes: ['PH-3b event-driven 2-D solver (engine/physics/solver2d.ts): capsule bodies, exact continuous contact, contact constraints only', 'lateral offsets u held at the spec start values (lateral steering model unknown, null)', 'NO biological decisions: no yield, side-step, crossing wait or turning back'],
    agents, events: res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class, source: 'ph3b solver2d', detail: e.detail })),
  };
}

export function runPh3b(sc: Scenario, o: Ph3bOptions = {}) {
  const input = ph3bInput(sc, o);
  const m0 = process.memoryUsage(), c0 = process.cpuUsage(), w0 = performance.now();
  const res = solve2D(input);
  const wall_ms = performance.now() - w0, cpu = process.cpuUsage(c0), m1 = process.memoryUsage();
  return { res, tr: toTrajectory(sc, res), cost: { wall_ms, cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000, heap_used_delta_mb: (m1.heapUsed - m0.heapUsed) / 2 ** 20, rss_mb: m1.rss / 2 ** 20 } };
}
