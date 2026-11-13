/**
 * LANE-FLOW prototype helpers (docs/physics-lane-flow.md): loads scenarios/physics/lane-flow-benchmark.candidates.json
 * and builds LaneFlowInput objects for the benchmarks. Isolated physics experiment, NOT official.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { timedInflowScenario, pointSourceStress, type InflowSpec, type Scenario } from '../../engine/physics/lane-flow-benchmarks.ts';
import type { LaneFlowInput, ContactResponse } from '../../engine/physics/lane-flow.ts';
import type { SiteSpec } from '../../engine/physics/destinations.ts';
import { poseAtFlow, type LaneFlowResult } from '../../engine/physics/lane-flow.ts';
import { capsuleAt, capGap, dimsOf } from '../../engine/physics/kinematics2d.ts';
import type { CandidateRunRecords, GapSample, PoseSample } from '../../engine/physics/candidate-metrics.ts';

export const LABEL = '隔離物理實驗・整合候選・非正式（非本種／假設）';
export const BENCHMARK_PATH = 'scenarios/physics/lane-flow-benchmark.candidates.json';
export const loadBenchmarkFile = (): any => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, BENCHMARK_PATH), 'utf8'));

export function benchmarkSite(c = loadBenchmarkFile()): SiteSpec {
  return { ...c.site, provenance: { assumption: true, basis: '遊戲假設', candidate_boundary: true, source_ids: [], note: c.provenance.goal_and_site.note } };
}
export function inflowSpec(seed: number, over: Partial<InflowSpec> = {}, c = loadBenchmarkFile()): InflowSpec {
  return { lane: c.lane, body: c.body, speed_mm_s: c.speed_mm_s, goal_s_mm: c.goal_s_mm, site: c.site.id, directions: [1], initial: c.initial, inflow: c.inflow, lateral_half_band_mm: c.lateral_half_band_mm, seed, provenance: c.provenance, ...over };
}
export function benchmarkInput(sc: Scenario, o: { horizon_s: number; contact_response: ContactResponse; entry?: boolean }, c = loadBenchmarkFile()): LaneFlowInput {
  return { lane: c.lane, agents: sc.agents, horizon_s: o.horizon_s, contact_response: o.contact_response, arrival: 'leave_to_ledger', sites: [benchmarkSite(c)], ...(o.entry === false ? {} : { entry: { control: true, retry_interval_s: c.entry_retry_interval_s } }) };
}
export const normalBenchmark = (seed: number, over: Partial<InflowSpec> = {}) => timedInflowScenario(inflowSpec(seed, over));
export function stressBenchmark(n: number, c = loadBenchmarkFile()): Scenario {
  return pointSourceStress({ n, t0_s: 0, dir: 1, body: c.body, speed_mm_s: c.speed_mm_s, goal_s_mm: c.goal_s_mm, site: c.site.id });
}

// ---------------------------------------------------------------- records for engine/physics/candidate-metrics.ts
/**
 * Generic records of one run. Gaps are the OBSERVER's own evaluation (closed-form poses from the executed pieces) on a
 * time grid of `dt_obs` plus every reported contact start / end, only for pairs that are both on the lane.
 */
export function recordsOf(r: LaneFlowResult, sc: Scenario, o: { candidate: string; seed: number | null; horizon_s: number; dt_obs: number; v_max_mm_s: number }): CandidateRunRecords {
  const ids = Object.keys(r.agents).sort(), body = new Map(sc.agents.map((a) => [a.id, dimsOf(a.body, a.id)]));
  const samples: PoseSample[] = [];
  for (const id of ids) for (const [t, x, y, th] of r.agents[id].samples) samples.push({ agent: id, t, x_mm: x, y_mm: y, th });
  const ts = new Set<number>(Array.from({ length: Math.round(o.horizon_s / o.dt_obs) + 1 }, (_, i) => Math.min(o.horizon_s, i * o.dt_obs)));
  for (const e of r.classification.contact_episodes) { ts.add(e.start_t_s); if (e.end_t_s !== null) ts.add(e.end_t_s); }
  const onLane = (id: string, t: number) => { const a = r.agents[id]; return a.present_from_t_s !== null && t >= a.present_from_t_s && (a.removed_t_s === null || t < a.removed_t_s); };
  const gaps: GapSample[] = [];
  for (const t of [...ts].sort((a, b) => a - b)) {
    const here = ids.filter((id) => onLane(id, t)).map((id) => ({ id, p: poseAtFlow(r.agents[id], t)! }));
    for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) {
      const a = here[i], b = here[j];
      if (Math.abs(a.p.x - b.p.x) > 10) continue; // far apart along the lane: cannot be within any tolerance used here
      gaps.push({ t, a: a.id, b: b.id, gap_mm: capGap(capsuleAt(a.p, body.get(a.id)!), capsuleAt(b.p, body.get(b.id)!)).g });
    }
  }
  return {
    candidate: o.candidate, seed: o.seed, family: sc.family, agents: ids, samples,
    episodes: r.classification.contact_episodes.filter((e) => e.geometry === 'body_body').map((e) => ({ agents: e.ids, start_t_s: e.start_t_s, end_t_s: e.end_t_s })),
    gaps, arrivals: ids.filter((id) => r.agents[id].arrival_t_s !== null).map((id) => ({ agent: id, t: r.agents[id].arrival_t_s! })),
    site_events: r.ledger.events,
    entries: ids.map((id) => ({ agent: id, scheduled_t: r.agents[id].scheduled_t_s, entered_t: r.agents[id].present_from_t_s })),
    transitions: r.transitions, initial_states: r.initial_states, v_max_mm_s: o.v_max_mm_s, window_s: [0, o.horizon_s],
  };
}
