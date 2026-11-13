/**
 * LANE-FLOW benchmarks (Issue #189 / #193 ruling 5). ISOLATED scenario generators for engine/physics/lane-flow.ts; not
 * imported by the official pipeline (tests/physics-isolation.test.ts).
 *
 *  - timedInflowScenario: the NORMAL benchmark — agents already on the lane at t = 0 with a seeded, non-overlapping
 *    initial spatial distribution (front-to-rear gap = min_gap + Exp(mean_extra), lateral offset uniform in a band),
 *    plus a TIME-BASED inflow per direction: agent k enters at t0 + k·interval_s (exact decimals, destinations.timedInflow).
 *    Family 'timed_inflow_comparison' (#158). Every number is a scenario input with provenance; the inflow interval is a
 *    GAME ASSUMPTION (no traffic-flow measurement exists for the species; same candidates as #158 / WP4 K2–K3).
 *  - pointSourceStress: the EXTREME / counterexample — n agents (e.g. 1,000) scheduled at ONE entry point at ONE instant.
 *    Family 'simultaneous_entry_stress': behavioural conclusions are not allowed (no colony departs this way). With entry
 *    control the agents enter one at a time as the entry pose frees; without it the start poses overlap and the run is
 *    refused (that refusal is the counterexample).
 * Deterministic: a named RNG stream per (seed, purpose, index); never Math.random. Units: mm, s.
 */
import { hash32, rng } from '../rng.ts';
import { capsuleAt, capGap, dimsOf, type BodyDims } from './kinematics2d.ts';
import { timedInflow, type TrafficFamily } from './destinations.ts';
import type { FlowAgentSpec, LaneSpec } from './lane-flow.ts';

export class BenchmarkRefused extends Error { constructor(m: string) { super(`LANE_FLOW_BENCHMARK_REFUSED: ${m}`); this.name = 'BenchmarkRefused'; } }

export type Basis = '文獻支持' | '一般生理學' | '遊戲假設';
export interface Prov { assumption: true; basis: Basis; source_ids: string[]; note: string }
/** every scenario number and where it comes from (required keys; checked) */
export const INFLOW_PROVENANCE_KEYS = ['body_length_mm', 'body_width_mm', 'speed_mm_s', 'inflow_interval_s', 'initial_gap', 'lateral_band_mm', 'lane', 'goal_and_site'] as const;
export type InflowProvenance = Record<typeof INFLOW_PROVENANCE_KEYS[number], Prov>;

export interface InflowSpec {
  lane: LaneSpec; body: BodyDims; speed_mm_s: number; goal_s_mm: number; site: string;
  directions: (1 | -1)[];
  /** initial spatial distribution per direction: count, front-to-rear gap = min_gap_mm + Exp(mean = mean_extra_gap_mm) */
  initial: { count_per_direction: number; min_gap_mm: number; mean_extra_gap_mm: number };
  /** time-based inflow per direction: count agents, one every interval_s from t0_s */
  inflow: { count_per_direction: number; interval_s: number; t0_s: number };
  /** lateral offset u ~ U(−band, band) (world y) */
  lateral_half_band_mm: number;
  seed: number;
  provenance: InflowProvenance;
  /** optional individual free-speed variation: speed = speed_mm_s + sd·z (z standard normal, seeded), clipped to
   *  [0.5, 1.5]·speed_mm_s. No individual speed data exist for the species: needs provenance.speed_variation (遊戲假設). */
  speed_variation?: { sd_mm_s: number; provenance: Prov };
}
export interface Scenario { family: TrafficFamily; agents: FlowAgentSpec[]; provenance: InflowProvenance | null; note: string }

function checkProv(p: InflowProvenance | undefined): void {
  if (!p) throw new BenchmarkRefused('provenance is required');
  for (const k of INFLOW_PROVENANCE_KEYS) {
    const v = p[k];
    if (!v || v.assumption !== true || !['文獻支持', '一般生理學', '遊戲假設'].includes(v.basis) || !Array.isArray(v.source_ids) || typeof v.note !== 'string') throw new BenchmarkRefused(`provenance.${k} must be labelled assumption: true with a basis, source ids and a note`);
    if (v.basis === '文獻支持' && v.source_ids.length === 0) throw new BenchmarkRefused(`provenance.${k}: 文獻支持 needs a source id`);
  }
}

/** the normal benchmark (ruling 5) */
export function timedInflowScenario(spec: InflowSpec): Scenario {
  checkProv(spec.provenance);
  const { lane, body } = spec, d = dimsOf(body, 'benchmark'), L = body.length_mm as number, w = body.width_mm as number;
  if (!(spec.speed_mm_s > 0)) throw new BenchmarkRefused('speed must be positive');
  if (!(spec.lateral_half_band_mm >= 0 && spec.lateral_half_band_mm + w / 2 <= lane.width_mm / 2)) throw new BenchmarkRefused('lateral band must keep the body inside the lane walls');
  if (!(spec.initial.min_gap_mm > 0 && spec.initial.mean_extra_gap_mm >= 0)) throw new BenchmarkRefused('initial gaps: min_gap > 0, mean_extra ≥ 0');
  const sEntry = L / 2, agents: FlowAgentSpec[] = [];
  const draw = (purpose: string, dir: number, k: number) => rng(hash32(`${spec.seed}|lane-flow.${purpose}|${dir}|${k}`))();
  const lateral = (purpose: string, dir: number, k: number) => (2 * draw(purpose, dir, k) - 1) * spec.lateral_half_band_mm;
  const SV = spec.speed_variation ?? null;
  if (SV && (!(SV.sd_mm_s >= 0) || SV.provenance?.assumption !== true || SV.provenance.basis !== '遊戲假設')) throw new BenchmarkRefused('speed_variation needs sd ≥ 0 and provenance labelled assumption: true, 遊戲假設 (no individual speed data)');
  const speedOf = (id: string) => {
    if (!SV) return spec.speed_mm_s;
    const u1 = rng(hash32(`${spec.seed}|lane-flow.speed1|${id}`))(), u2 = rng(hash32(`${spec.seed}|lane-flow.speed2|${id}`))();
    const z = Math.sqrt(-2 * Math.log(1 - u1)) * Math.cos(2 * Math.PI * u2);
    return Math.min(1.5 * spec.speed_mm_s, Math.max(0.5 * spec.speed_mm_s, spec.speed_mm_s + SV.sd_mm_s * z));
  };
  const mk = (id: string, dir: 1 | -1, s: number, u: number, t: number): FlowAgentSpec => ({ id, dir, s_mm: s, u_mm: u, goal_s_mm: spec.goal_s_mm, start_t_s: t, free_speed_mm_s: speedOf(id), body, site: spec.site });
  const xOf = (dir: number, s: number) => (dir > 0 ? s : lane.length_mm - s);
  const placed: { x: number; y: number; th: number }[] = [];
  const clear = (p: { x: number; y: number; th: number }) => placed.every((q) => capGap(capsuleAt(p, d), capsuleAt(q, d)).g > spec.initial.min_gap_mm);
  // initial occupants: from the goal side back toward the entry (the leading ant is nearest the goal), never on the entry pose
  for (const dir of [...spec.directions].sort()) {
    let s = spec.goal_s_mm - L / 2 - spec.initial.min_gap_mm;
    for (let k = 0; k < spec.initial.count_per_direction; k++) {
      let p = null as null | { x: number; y: number; th: number };
      for (let tries = 0; tries < 200 && s - L / 2 > sEntry + L / 2; tries++) {
        const cand = { x: xOf(dir, s), y: lateral(`initial_u_try${tries}`, dir, k), th: dir > 0 ? 0 : Math.PI };
        if (clear(cand)) { p = cand; break; }
        s -= 0.25 * L; // move back a quarter body length and try again (deterministic)
      }
      if (!p) throw new BenchmarkRefused(`cannot place initial agent ${k} of direction ${dir} without overlap: lane too short or too dense`);
      placed.push(p); agents.push(mk(`i${dir > 0 ? 'E' : 'W'}${String(k).padStart(3, '0')}`, dir, s, p.y, 0));
      const gap = spec.initial.min_gap_mm - spec.initial.mean_extra_gap_mm * Math.log(1 - draw('initial_gap', dir, k));
      s -= L + gap;
    }
  }
  // time-based inflow per direction (exact decimal times; agent k of arm a at t0 + k·interval)
  const arms = spec.directions.map((dir) => (dir > 0 ? 'E' : 'W'));
  for (const x of timedInflow(arms, spec.inflow.count_per_direction, spec.inflow.interval_s, spec.inflow.t0_s)) {
    const dir: 1 | -1 = x.arm === 'E' ? 1 : -1, k = Number(x.agent.split('#')[1]);
    agents.push(mk(`f${x.arm}${String(k).padStart(4, '0')}`, dir, sEntry, lateral('inflow_u', dir, k), x.t));
  }
  return { family: 'timed_inflow_comparison', agents, provenance: spec.provenance, note: 'normal benchmark: seeded initial spatial distribution + time-based inflow (game assumptions; no species traffic data)' };
}

/** the extreme counterexample (ruling 5): n agents at one entry point at one instant */
export function pointSourceStress(o: { n: number; t0_s: number; dir: 1 | -1; body: BodyDims; speed_mm_s: number; goal_s_mm: number; site: string }): Scenario {
  if (!Number.isInteger(o.n) || o.n < 1) throw new BenchmarkRefused('n must be a positive integer');
  const s = (o.body.length_mm as number) / 2;
  const agents = Array.from({ length: o.n }, (_, k): FlowAgentSpec => ({ id: `p${String(k).padStart(4, '0')}`, dir: o.dir, s_mm: s, u_mm: 0, goal_s_mm: o.goal_s_mm, start_t_s: o.t0_s, free_speed_mm_s: o.speed_mm_s, body: o.body, site: o.site }));
  return { family: 'simultaneous_entry_stress', agents, provenance: null, note: `stress / counterexample: ${o.n} agents at one point at t = ${o.t0_s} s; no behavioural conclusion` };
}
