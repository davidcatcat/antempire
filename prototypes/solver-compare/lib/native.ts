/**
 * Native runner (Issue #101): engine/physics/collision.ts simulate() on the common spec, converted to the common
 * trajectory format. The native PH-2 model is ONE-DIMENSIONAL along each lane: it has no lateral coordinate. The
 * conversion imposes u = 0 (every body on its lane's centre-line) — `lateral_dof: false`. A non-zero u in the spec is
 * IGNORED by the native solver and listed in `notes`. Biological decisions (yield, crossing wait, contact pause …) are
 * the native encounter rules from the interaction-candidates file; they appear as `behavioural_response` events.
 */
import { simulate, type SimConfig, type SimResult, type PhysEventKind } from '../../../engine/physics/collision.ts';
import type { Scenario } from './spec.ts';
import { type Trajectory, type TrajEvent, type EventClass, type Sample, laneFrames, poseOn } from './traj.ts';

const CLASS: Record<PhysEventKind, EventClass> = {
  start: 'motion', arrive: 'motion', contact_start: 'physical_contact', contact_end: 'physical_contact', obstruction: 'physical_contact',
  follow_start: 'physical_constraint', follow_end: 'physical_constraint', blocked: 'physical_constraint',
  yield_start: 'behavioural_response', yield_hold: 'behavioural_response', yield_resume: 'behavioural_response', cross_wait: 'behavioural_response', cross_resume: 'behavioural_response',
  unresolved: 'solver_status',
};

export function nativeConfig(sc: Scenario, seed = sc.seed): SimConfig {
  const body = { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value, contact_reach_mm: sc.body.contact_reach_mm.value };
  return {
    geometry: sc.geometry, encounter: sc.encounter, horizon_s: sc.horizon_s, seed,
    agents: sc.agents.map((a) => ({ id: a.id, passage: a.passage, s_mm: a.s_mm, dir: a.dir, start_t_s: a.start_t_s, free_speed_mm_s: a.free_speed_mm_s, goal_s_mm: a.goal_s_mm, body, load: null })),
  };
}

export function toTrajectory(sc: Scenario, res: SimResult, opts: { u?: 'zero' | 'spec' } = {}): Trajectory {
  const frames = laneFrames(sc), uMode = opts.u ?? 'zero';
  const notes = ['native PH-2 is 1-D along each lane: no lateral degree of freedom; converted with u = 0 (centre-line) unless stated'];
  if (uMode === 'spec') notes.push('this conversion holds each body at its spec start offset u for the whole run (a display choice for the judge, not computed by the native solver)');
  const ignored = sc.agents.filter((a) => a.u_mm !== 0).map((a) => a.id);
  if (ignored.length && uMode === 'zero') notes.push(`spec lateral offsets ignored by the native solver for: ${ignored.slice(0, 20).join(', ')}${ignored.length > 20 ? ` … (${ignored.length})` : ''}`);
  const agents: Trajectory['agents'] = {};
  for (const a of sc.agents) {
    const f = frames.get(a.passage)!, u = uMode === 'spec' ? a.u_mm : 0, out: Sample[] = [];
    const push = (t: number, s: number, dir: 1 | -1) => { const p = poseOn(f, s, u, dir); const last = out[out.length - 1]; if (last && last[0] === t && last[4] === s) return; out.push([t, p.x, p.y, p.heading, s, u]); };
    push(0, a.s_mm, a.dir);
    for (const r of res.intervals[a.id]) { push(r.t_start_s, r.s_start_mm, a.dir); push(r.t_end_s, r.s_end_mm, a.dir); }
    const arr = res.events.find((e) => e.kind === 'arrive' && e.agent === a.id);
    agents[a.id] = { lane: a.passage, layer: a.layer, samples: out, arrival_t_s: arr ? arr.t_s : null, final_mode: res.final[a.id].mode };
  }
  const events: TrajEvent[] = res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.other ? [e.agent, e.other] : [e.agent], class: CLASS[e.kind], source: 'native engine (collision.ts simulate)', detail: e.detail }));
  return { solver: 'native', scenario: sc.id, lateral_dof: false, notes, agents, events };
}

export function runNative(sc: Scenario, seed = sc.seed) {
  const cfg = nativeConfig(sc, seed);
  const m0 = process.memoryUsage(), c0 = process.cpuUsage(), w0 = performance.now();
  const res = simulate(cfg);
  const wall_ms = performance.now() - w0, cpu = process.cpuUsage(c0), m1 = process.memoryUsage();
  return { res, cost: { wall_ms, cpu_user_ms: cpu.user / 1000, cpu_system_ms: cpu.system / 1000, heap_used_delta_mb: (m1.heapUsed - m0.heapUsed) / 2 ** 20, rss_mb: m1.rss / 2 ** 20, steps: res.stats.steps, pair_evaluations: res.stats.pair_evaluations, t_end_s: res.stats.t_end_s } };
}
