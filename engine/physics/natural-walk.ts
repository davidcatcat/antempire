/**
 * NATURAL-WALK candidates (Issue #157 Owner addendum, "PR A: natural walking kinematics"; docs/physics-kinematics2d.md §7).
 * ISOLATED: not imported by the official pipeline (tests/physics-isolation.test.ts). Builds KIN-2D plans (constant-twist
 * segments, engine/physics/kinematics2d.ts) from a LOCAL controller; physics (collision, stops) is then checked by
 * runKinematics, never by the controller. Three CANDIDATE motion models, none validated for this species:
 *  - A: straight baseline (ω = 0, constant speed).
 *  - B: time-correlated heading control: the angular rate is ω = ζ − k_h·wrap(θ − θ_goal) + (avoidance), where ζ is an
 *       Ornstein–Uhlenbeck process (correlation time τ, stationary SD σ), sampled EXACTLY at control instants
 *       t_k = t0 + k·Δc and held constant in between (so each control interval is an exact circular arc). θ_goal is the
 *       ant's own remembered travel direction (local; 0 gain = exploration). No per-frame independent left/right draws,
 *       no fixed sine wave.
 *  - C: B + bilateral chemical sensing at two antenna-tip points of a SYNTHETIC field (until CHEM integration the field
 *       is synthetic and labelled so): ω += g_c·(c_L − c_R)/(c_L + c_R + c_floor) (tropotaxis candidate; mechanism from
 *       other species only).
 *  - all models: obstacle sensing ONLY by antenna-tip contact (a tip inside an obstacle); candidate response: stop
 *    forward motion and turn in place away from the touching side until both tips are clear.
 *  - limits: |ω| ≤ ω_max and, while moving, |ω| ≤ κ_max·v (clamped; clamps are counted).
 * Randomness: one named stream per agent: rng(hash32(`${seed}|kin2d.walk|${agent id}`)). Pure and deterministic.
 * Every numeric parameter is a scenario input labelled assumption:true by the caller's parameter file; nothing here is a
 * species value.
 */
import { advancePose, capGap, capsuleAt, dimsOf, staticCaps, Kin2DRefused, type BodyDims, type Pose, type Seg, type Static, type Track, type Twist, type P2 } from './kinematics2d.ts';
import { hash32, rng } from '../rng.ts';
import { antennaTipPoints, antennaSensors, ridgeValue, sampleLocal, SyntheticChemicalField, type AntennaGeometry, type AssumptionTag, type LocalChemSampler, type SensingSource, type SyntheticRidge } from './local-sensing.ts';

export type WalkModel = 'A' | 'B' | 'C';
export interface WalkParams {
  model: WalkModel;
  speed_mm_s: number;
  control_dt_s: number;
  max_turn_rate_rad_s: number;
  max_curvature_per_mm: number;
  /** B/C: OU correlation time (s) and stationary SD (rad/s) of the noise part of the angular rate */
  ou_tau_s: number; ou_sigma_rad_s: number;
  /** B/C: gain (1/s) of the correction toward the ant's own remembered heading (0 = none: exploration) */
  heading_gain_per_s: number;
  /** antenna geometry used for sensing (tips): length from the head front and half-angle from the body axis */
  antenna_len_mm: number; antenna_half_angle_rad: number;
  /** C: chemical steering gain (rad/s) and floor of the normaliser */
  chem_gain_rad_s: number; chem_floor: number;
  /** obstacle avoidance by antenna contact: turn-in-place rate (rad/s), must be ≤ max_turn_rate */
  avoid_turn_rate_rad_s: number;
}
/** SYNTHETIC chemical field: Gaussian ridge around a polyline (no diffusion, no decay; NOT a pheromone model) */
export type SyntheticField = SyntheticRidge;
export interface WalkSpec {
  id: string; body: BodyDims; start: Pose; t0_s: number; seed: number; params: WalkParams;
  /** heading the ant remembers as its travel direction (local memory) */
  goal_heading_rad: number;
  /** stop the plan when the centre first reaches x ≥ end_x_mm (trail end), or at t0 + max_duration_s */
  end_x_mm: number | null; max_duration_s: number;
  statics: Static[]; field: SyntheticField | null; layer?: string;
  /** C: the local chemical sampler (docs/kin2d-local-sensing.md). Omitted: a SyntheticChemicalField built from `field`.
   *  Model C reads chemistry ONLY through sampleLocal() of this contract. */
  sampler?: LocalChemSampler; chem_channel?: string;
}
export interface SensorSample { t: number; left: { x_mm: number; y_mm: number; c: number }; right: { x_mm: number; y_mm: number; c: number }; synthetic: boolean; source: SensingSource }
export interface WalkEvent { t: number; kind: string; detail: string }
export interface WalkPlan {
  track: Track; sensor_samples: SensorSample[]; events: WalkEvent[]; clamps: { turn_rate: number; curvature: number }; arrival_t_s: number | null;
  /** where the chemical values came from (model C); null for A/B */
  sensing: { source: SensingSource; sampler_id: string; channel: string; layer: string; synthetic: boolean } | null;
}
/** assumption tags sent with every model-C sensing request */
export const MODEL_C_SENSING_TAGS: readonly AssumptionTag[] = [
  { name: 'antenna_geometry', assumption: true, basis: '遊戲假設', note: '觸角長度與半角是候選值；本種無資料' },
  { name: 'point_sensing', assumption: true, basis: '遊戲假設', note: '在觸角尖端點取樣（範圍 0 mm）' },
  { name: 'bilateral_comparison', assumption: true, basis: '遊戲假設', note: '機制方向只有非本種證據（R810，Camponotus pennsylvanicus）；數值無資料' },
];

/** synthetic ridge value (observer / test use; the controller reads chemistry only through sampleLocal) */
export function fieldValue(f: SyntheticField, p: P2): number { return ridgeValue(f, p); }
const wrapPi = (x: number) => { let y = x % (2 * Math.PI); if (y <= -Math.PI) y += 2 * Math.PI; if (y > Math.PI) y -= 2 * Math.PI; return y; };
export const antennaGeometry = (body: BodyDims, p: WalkParams): AntennaGeometry => ({ body_length_mm: body.length_mm as number, antenna_len_mm: p.antenna_len_mm, antenna_half_angle_rad: p.antenna_half_angle_rad });
export function antennaTips(pose: Pose, body: BodyDims, p: WalkParams): { left: P2; right: P2 } { return antennaTipPoints(pose, antennaGeometry(body, p)); }
function pointInStatic(q: P2, s: Static): boolean {
  if (s.kind === 'polygon') {
    let inside = false;
    for (let i = 0, j = s.pts.length - 1; i < s.pts.length; j = i++) { const a = s.pts[i], b = s.pts[j]; if ((a.y > q.y) !== (b.y > q.y) && q.x < ((b.x - a.x) * (q.y - a.y)) / (b.y - a.y) + a.x) inside = !inside; }
    if (inside) return true;
  }
  const pc = { a: q, b: q, r: 0 };
  return staticCaps(s).some((c) => capGap(pc, c).g <= 0);
}

export function validateParams(p: WalkParams): void {
  const pos = ['speed_mm_s', 'control_dt_s', 'max_turn_rate_rad_s', 'max_curvature_per_mm', 'ou_tau_s', 'antenna_len_mm', 'avoid_turn_rate_rad_s'] as const;
  for (const k of pos) if (!(typeof p[k] === 'number' && p[k] > 0 && Number.isFinite(p[k]))) throw new Kin2DRefused(`walk param ${k} must be a positive number (unknowns are never defaulted)`);
  for (const k of ['ou_sigma_rad_s', 'heading_gain_per_s', 'chem_gain_rad_s', 'chem_floor', 'antenna_half_angle_rad'] as const) if (!(typeof p[k] === 'number' && p[k] >= 0)) throw new Kin2DRefused(`walk param ${k} must be ≥ 0`);
  if (p.avoid_turn_rate_rad_s > p.max_turn_rate_rad_s) throw new Kin2DRefused('avoid turn rate exceeds the turn-rate limit');
}

/** Standard normal from the agent's stream (Box–Muller, two uniforms per draw; deterministic). */
function normal(r: () => number): number { const u1 = 1 - r(), u2 = r(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); }

/** Build the plan of one walking agent (closed-loop local controller). */
export function planWalk(spec: WalkSpec): WalkPlan {
  const p = spec.params; validateParams(p); dimsOf(spec.body, spec.id);
  if (spec.params.model === 'C' && !spec.field && !spec.sampler) throw new Kin2DRefused(`${spec.id}: model C needs a (synthetic) field`);
  const geom = antennaGeometry(spec.body, p), layer = spec.layer ?? 'default', channel = spec.chem_channel ?? 'synthetic_trail';
  const sampler: LocalChemSampler | null = p.model !== 'C' ? null : spec.sampler ?? new SyntheticChemicalField({ id: `${spec.id}:synthetic-ridge`, channel, layer, field: spec.field as SyntheticField, committed_through_s: spec.t0_s + spec.max_duration_s, max_range_mm: 0 });
  const R = rng(hash32(`${spec.seed}|kin2d.walk|${spec.id}`));
  const segs: Seg[] = [], sensor: SensorSample[] = [], events: WalkEvent[] = [];
  const clamps = { turn_rate: 0, curvature: 0 };
  const a = Math.exp(-p.control_dt_s / p.ou_tau_s), b = p.ou_sigma_rad_s * Math.sqrt(1 - a * a);
  let zeta = p.model === 'A' ? 0 : p.ou_sigma_rad_s * normal(R); // stationary start
  let pose: Pose = { ...spec.start }, avoiding = 0, arrival: number | null = null;
  const tEnd = spec.t0_s + spec.max_duration_s;
  events.push({ t: spec.t0_s, kind: 'start', detail: `model ${p.model}` });
  for (let k = 0; ; k++) {
    const t = spec.t0_s + k * p.control_dt_s, t1 = Math.min(spec.t0_s + (k + 1) * p.control_dt_s, tEnd);
    if (!(t1 > t)) break;
    const tips = antennaTips(pose, spec.body, p);
    const touchL = spec.statics.some((s) => pointInStatic(tips.left, s)), touchR = spec.statics.some((s) => pointInStatic(tips.right, s));
    let v = p.speed_mm_s, w = 0;
    if (touchL || touchR) {
      const dir = touchL && !touchR ? -1 : touchR && !touchL ? 1 : (avoiding !== 0 ? avoiding : (zeta >= 0 ? 1 : -1));
      if (avoiding === 0) events.push({ t, kind: 'antenna_contact_pivot', detail: `turn ${dir > 0 ? 'left' : 'right'} in place (candidate response)` });
      avoiding = dir; v = 0; w = dir * p.avoid_turn_rate_rad_s;
    } else {
      if (avoiding !== 0) events.push({ t, kind: 'resume', detail: 'antenna tips clear' });
      avoiding = 0;
      if (p.model !== 'A') {
        w = zeta - p.heading_gain_per_s * wrapPi(pose.th - spec.goal_heading_rad);
        if (p.model === 'C') {
          const r = sampleLocal(sampler as LocalChemSampler, { agent_id: spec.id, t_s: t, round: 0, pose, geometry: geom, sensors: antennaSensors(pose, geom), layer, channel, range_mm: 0, source: (sampler as LocalChemSampler).source, tags: [...MODEL_C_SENSING_TAGS] });
          const cL = r.values[0].value, cR = r.values[1].value;
          w += (p.chem_gain_rad_s * (cL - cR)) / (cL + cR + p.chem_floor);
          sensor.push({ t, left: { x_mm: r.values[0].x_mm, y_mm: r.values[0].y_mm, c: cL }, right: { x_mm: r.values[1].x_mm, y_mm: r.values[1].y_mm, c: cR }, synthetic: r.synthetic, source: r.source });
        }
      }
      const cap = Math.min(p.max_turn_rate_rad_s, p.max_curvature_per_mm * v);
      if (Math.abs(w) > cap) { if (p.max_turn_rate_rad_s <= p.max_curvature_per_mm * v) clamps.turn_rate++; else clamps.curvature++; w = Math.sign(w) * cap; }
    }
    const tw: Twist = { v, vl: 0, w };
    let tSegEnd = t1;
    let next = advancePose(pose, tw, t1 - t);
    if (spec.end_x_mm !== null && pose.x < spec.end_x_mm && next.x >= spec.end_x_mm) {
      // arrival inside this interval: bisection on the closed form (x is monotone here only if heading stays within ±π/2;
      // bisection still returns a crossing time within float resolution)
      let lo = t, hi = t1;
      for (let i = 0; i < 200; i++) { const m = lo + (hi - lo) / 2; if (!(m > lo && m < hi)) break; if (advancePose(pose, tw, m - t).x >= spec.end_x_mm) hi = m; else lo = m; }
      tSegEnd = hi; next = advancePose(pose, tw, hi - t); arrival = hi;
    }
    segs.push({ t0: t, t1: tSegEnd, p0: pose, tw, label: v === 0 ? 'pivot' : p.model === 'A' ? 'straight' : 'arc' });
    pose = next;
    if (arrival !== null) { events.push({ t: arrival, kind: 'arrive', detail: `x ≥ ${spec.end_x_mm} mm` }); break; }
    if (p.model !== 'A') zeta = a * zeta + b * normal(R);
  }
  const tLast = segs.length ? segs[segs.length - 1].t1 : spec.t0_s;
  segs.push({ t0: tLast, t1: Infinity, p0: pose, tw: { v: 0, vl: 0, w: 0 }, label: 'hold' });
  return { track: { id: spec.id, body: spec.body, layer: spec.layer, segs }, sensor_samples: sensor, events, clamps, arrival_t_s: arrival, sensing: sampler ? { source: sampler.source, sampler_id: sampler.id, channel, layer, synthetic: sampler.synthetic } : null };
}
