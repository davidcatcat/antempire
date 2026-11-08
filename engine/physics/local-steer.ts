/**
 * WP4 (docs/wp4-local-avoidance.md): ISOLATED candidate local-behaviour models (obstacle avoidance, waiting, backing off,
 * side-stepping) on top of the PH-3b body/contact physics. NOT used by simulate(), the daily loop, Day0, cli/ or web/
 * (tests/physics-isolation.test.ts, tests/wp4-local-steer.test.ts). Nothing here is a species rule: Pheidole has no
 * study of narrow-trail traffic, head-on encounters or lateral steering; every behavioural number is a candidate
 * (assumption: true, basis given by the caller's candidate file) and may be null — a policy that needs a null value is
 * refused, never defaulted.
 *
 * Policies (pluggable, chosen by id):
 *  - 'none'               the PH-3b solver itself (solve2D), returned unchanged: the baseline (u fixed, no decisions).
 *  - 'A_free_direction'   every decision instant: the most forward direction among the candidate probe directions that
 *                         is free within the sensing radius (ties between left and right by a named RNG draw); none free
 *                         → wait. Memoryless.
 *  - 'B_contact_decision' go forward; when a nestmate blocks the way within the sensing radius, draw one of
 *                         wait / back off / re-route (probabilities from the candidate file); a static obstacle → re-route.
 *                         Re-route is excluded when the local geometry is too narrow for two bodies (rule D).
 *  - 'C_sidestep'         go forward; when blocked and there is room, step aside on one side (chosen once per encounter
 *                         by a named RNG draw, switched only when that side closes) until the way ahead is free.
 *  Rule D (all of A–C): when an agent makes no forward progress for stall_window_s it REPORTS a blockage with a local
 *  diagnosis (static geometry closes every direction / passage too narrow for two bodies / blocked by nestmates / static
 *  piece ahead / way ahead free — the stall is the agent's own waiting or backing off); when the
 *  static geometry alone closes every direction it stops for good (geometry never changes).
 *
 * Perception (local only): an agent perceives the bodies (capsules and their body axis orientation, not their velocity,
 * goal or intention) and static pieces whose capsule gap to its own body is ≤ sensing_radius_mm, plus body contact.
 * A probe "direction d is free" = translating its own capsule by sensing_radius_mm along d, against the perceived bodies
 * held where they are and the perceived static pieces, hits nothing (exact continuous test, solver2d.pairFirstHit).
 * No global map, no other agent's intention, no colony quantity.
 *
 * Motion and physics (between decision instants — a common grid k·decision_interval_s, plus each agent's start time):
 *  - the body axis stays parallel to its lane in its travel direction (geometric convention: no body-rotation model);
 *    a chosen direction is a translation (forward, diagonal, sideways or backwards) at the agent's free speed;
 *  - straight lanes only (a bend is refused, as PH-3b refuses offset bodies at joints);
 *  - each agent's static set is its own lane's band INCLUDING the two end edges (walls) and the obstacles on its layer;
 *  - non-penetration is exact: within a decision interval every agent translates on [a_i, b_i]; b_i is lowered to the first
 *    time-of-impact with static geometry, its goal, or another body (piecewise exact continuous contact, pairFirstHit),
 *    for the agent(s) moving INTO the contact (normal test); iterated Jacobi-style over all candidate pairs until no stop
 *    time changes (order-independent). If that does not settle within a cap, nobody moves in that interval (safe,
 *    counted as `fallback_intervals`). Contacts are inelastic: a stopped agent waits for the next decision instant.
 * Determinism: agents in id order; decisions read only the state at the decision instant and named RNG streams keyed by
 * (seed, stream, agent id, decision index) — independent of input order. Units: mm, s, mm/s.
 */
import type { Vec2 } from './vec.ts';
import { segmentSegment2D } from './vec.ts';
import { type Capsule, capsuleGap, laneBoundary, OCC_TOL_MM } from './body2d.ts';
import { solve2D, pairFirstHit, Solver2DRefused, HIT_TOL_MM, type Solver2DInput, type Solver2DResult, type Sample } from './solver2d.ts';
import { type AABB, broadphasePairs } from './broadphase.ts';
import { hash32, rng } from '../rng.ts';

export const STEER_POLICIES = ['none', 'A_free_direction', 'B_contact_decision', 'C_sidestep'] as const;
export type SteerPolicyId = (typeof STEER_POLICIES)[number];

/** behavioural candidate parameters; null = unknown (a policy that needs it is refused). Provenance lives with the caller. */
export interface SteerParams {
  sensing_radius_mm: number | null;
  decision_interval_s: number | null;
  /** probe directions, degrees off the travel direction (0 = straight; each > 0 is tried on both sides) */
  probe_angles_deg: number[] | null;
  /** a body ahead whose axis points within this angle of mine is a same-direction nestmate (B, C follow it) */
  same_heading_max_deg: number | null;
  stall_window_s: number | null;
  stall_progress_mm: number | null;
  /** B */
  p_wait: number | null; p_back: number | null; p_reroute: number | null;
  wait_s: number | null; back_distance_mm: number | null; reroute_max_s: number | null;
}
export interface SteerInput extends Solver2DInput { policy: SteerPolicyId; params: SteerParams; seed: number }

export type SteerEventClass = 'physical_contact' | 'physical_constraint' | 'motion' | 'solver_status' | 'behavioural_response';
export interface SteerEvent { t_s: number; kind: string; agents: string[]; class: SteerEventClass; detail: string | null }
export interface SteerAgentOut {
  lane: string; layer: string; samples: Sample[]; arrival_t_s: number | null; final_mode: string; final_speed_mm_s: number;
  stop_cause: string | null; geometry_stop_s_mm: number | null; blocked_reports: number;
}
export interface SteerResult {
  policy: SteerPolicyId; agents: Record<string, SteerAgentOut>; events: SteerEvent[];
  stats: {
    decision_instants: number; decisions: Record<string, number>; probes: number; pair_hit_evals: number; physics_rounds_max: number;
    fallback_intervals: number; stops_contact: number; stops_static: number; contacts: number; arrived: number; stalled: number;
    blocked_reports: Record<string, number>; geometry_halts: number; unresolved: number; t_end_s: number;
  };
  /** 'none' only: the untouched PH-3b result */
  ph3b?: Solver2DResult;
}

export class SteerRefused extends Error { constructor(m: string) { super(`STEER_REFUSED: ${m}`); this.name = 'SteerRefused'; } }

// ---------------------------------------------------------------- helpers
const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Vec2, b: Vec2) => a.x * b.x + a.y * b.y;
const rot = (v: Vec2, deg: number): Vec2 => { const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r); return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }; };
const ZERO: Vec2 = { x: 0, y: 0 };
const sameVec = (a: Vec2, b: Vec2) => a.x === b.x && a.y === b.y;
function closestPts(p1: Vec2, q1: Vec2, p2: Vec2, q2: Vec2): [Vec2, Vec2] {
  const d1 = { x: q1.x - p1.x, y: q1.y - p1.y }, d2 = { x: q2.x - p2.x, y: q2.y - p2.y }, r = { x: p1.x - p2.x, y: p1.y - p2.y };
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  let s: number, t: number;
  if (a === 0 && e === 0) return [p1, p2];
  if (a === 0) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
  else {
    const c = dot(d1, r);
    if (e === 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
    else {
      const b = dot(d1, d2), den = a * e - b * b;
      s = den !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); } else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
    }
  }
  return [{ x: p1.x + d1.x * s, y: p1.y + d1.y * s }, { x: p2.x + d2.x * t, y: p2.y + d2.y * t }];
}

/**
 * First time τ ∈ [0, T] at which two translating capsules touch on the way to a penetration deeper than HIT_TOL_MM
 * WITHIN [0, T]; null if none. pairFirstHit looks over an unbounded horizon, so for a pair already touching (gap ≈ 0)
 * that slides with a tiny relative velocity it reports τ = 0 for a penetration that would only happen long after T;
 * the gap is convex in τ, so its minimum over [τ, T] (ternary search) decides whether the touch leads to a penetration
 * inside this piece. Penetration is therefore never deeper than HIT_TOL_MM (< OCC_TOL_MM) at any instant.
 */
export function boundedHit(P: Capsule, vP: Vec2, Q: Capsule, vQ: Vec2, T: number): { tau: number; overlapping: boolean } | null {
  const h = pairFirstHit(P, vP, Q, vQ);
  if (!h) return null;
  if (h.overlapping) return h;
  if (h.tau > T) return null;
  const g = (t: number) => capsuleGap({ a: add(P.a, vP, t), b: add(P.b, vP, t), r: P.r }, { a: add(Q.a, vQ, t), b: add(Q.b, vQ, t), r: Q.r });
  if (g(T) < -HIT_TOL_MM) return h;
  let lo = h.tau, hi = T;
  for (let k = 0; k < 100 && hi - lo > 1e-15 * Math.max(1, hi); k++) { const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3; if (g(m1) <= g(m2)) hi = m2; else lo = m1; }
  return Math.min(g(T), g((lo + hi) / 2)) < -HIT_TOL_MM ? h : null;
}

interface Piece { c: Capsule; id: string }
type DecisionKind = 'go' | 'follow' | 'sidestep' | 'wait' | 'back_off' | 'reroute' | 'halt_geometry' | 'not_started';
interface Decision { kind: DecisionKind; w: Vec2; detail: string }
interface Ag {
  k: number; id: string; lane: string; layerName: string; layer: number;
  a0: Vec2; t: Vec2; n: Vec2; len: number; W: number;
  f: Vec2; left: Vec2; heading: number; dir: 1 | -1; v0: number; goal: number; start: number; hw: number; r: number; half: number;
  statics: Piece[];
  c: Vec2; started: boolean; arrived: number | null; eff: Vec2; lastKey: string;
  samples: Sample[]; stopCause: string | null; halted: boolean;
  // policy state
  mode: 'go' | 'wait' | 'back' | 'side'; until: number; backLeft: number; side: 1 | -1 | 0; sideSince: number;
  // rule D
  progress: number[]; stalledSince: number | null; reported: boolean; reports: number;
}

/** policy params the policy needs (null → refused) */
const NEEDS: Record<Exclude<SteerPolicyId, 'none'>, (keyof SteerParams)[]> = {
  A_free_direction: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'stall_window_s', 'stall_progress_mm'],
  B_contact_decision: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'same_heading_max_deg', 'stall_window_s', 'stall_progress_mm', 'p_wait', 'p_back', 'p_reroute', 'wait_s', 'back_distance_mm', 'reroute_max_s'],
  C_sidestep: ['sensing_radius_mm', 'decision_interval_s', 'probe_angles_deg', 'same_heading_max_deg', 'stall_window_s', 'stall_progress_mm'],
};

export function steer2D(input: SteerInput): SteerResult {
  if (!(STEER_POLICIES as readonly string[]).includes(input.policy)) throw new SteerRefused(`unknown policy ${input.policy}`);
  if (input.policy === 'none') {
    // the baseline IS PH-3b: no decision layer, nothing re-implemented
    const res = solve2D(input);
    const agents: Record<string, SteerAgentOut> = {};
    for (const id of Object.keys(res.agents).sort()) { const a = res.agents[id]; agents[id] = { ...a, blocked_reports: 0 }; }
    const stalled = res.stats.stalled;
    return { policy: 'none', agents, events: res.events.map((e) => ({ ...e })), ph3b: res, stats: { decision_instants: 0, decisions: {}, probes: 0, pair_hit_evals: res.stats.pair_hit_evals, physics_rounds_max: 0, fallback_intervals: 0, stops_contact: res.events.filter((e) => e.kind === 'stop' && /^contact/.test(e.detail ?? '')).length, stops_static: res.events.filter((e) => e.kind === 'stop' && /static geometry/.test(e.detail ?? '')).length, contacts: res.stats.contacts, arrived: res.stats.arrived, stalled, blocked_reports: {}, geometry_halts: 0, unresolved: res.stats.unresolved, t_end_s: res.stats.t_end_s } };
  }
  return runPolicy(input);
}

function runPolicy(input: SteerInput): SteerResult {
  const P = input.params, policy = input.policy as Exclude<SteerPolicyId, 'none'>;
  for (const k of NEEDS[policy]) { const v = P[k]; if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) throw new SteerRefused(`${policy} needs ${k}, which is null (unknown; never defaulted)`); }
  const H = input.horizon_s;
  if (!(H > 0) || !Number.isFinite(H)) throw new SteerRefused('horizon must be a positive finite number');
  const RHO = P.sensing_radius_mm!, DT = P.decision_interval_s!, ANG = [...new Set(P.probe_angles_deg!.map(Math.abs))].sort((x, y) => x - y);
  if (!(RHO > 0) || !(DT > 0)) throw new SteerRefused('sensing radius and decision interval must be positive');
  if (ANG.some((x) => !(x >= 0 && x <= 180))) throw new SteerRefused('probe angles must lie in [0, 180] degrees');
  const SAME = P.same_heading_max_deg === null ? null : Math.cos((P.same_heading_max_deg * Math.PI) / 180);
  if (policy === 'B_contact_decision') {
    const s = P.p_wait! + P.p_back! + P.p_reroute!;
    if (![P.p_wait!, P.p_back!, P.p_reroute!].every((p) => p >= 0) || Math.abs(s - 1) > 1e-12) throw new SteerRefused('B: p_wait + p_back + p_reroute must be probabilities summing to 1');
  }
  const STALL_K = Math.max(1, Math.round(P.stall_window_s! / DT)), STALL_MM = P.stall_progress_mm!;
  const draw = (stream: string, id: string, epoch: number, extra = '') => rng(hash32(`${input.seed}|steer.${policy}.${stream}|${id}|${epoch}|${extra}`))();

  // ---- lanes (straight only) and layers
  const layerIds = new Map<string, number>(), laneMap = new Map<string, { a0: Vec2; t: Vec2; n: Vec2; len: number; W: number; layer: number; layerName: string; bnd: Piece[] }>();
  for (const l of input.lanes) {
    if (laneMap.has(l.id)) throw new SteerRefused(`duplicate lane ${l.id}`);
    if (typeof l.width_mm !== 'number' || !(l.width_mm > 0)) throw new SteerRefused(`lane ${l.id} width unknown (never defaulted)`);
    if (!layerIds.has(l.layer)) layerIds.set(l.layer, layerIds.size);
    const pts = l.centerline_mm;
    const a0 = pts[0], b0 = pts[pts.length - 1], len = Math.hypot(b0.x - a0.x, b0.y - a0.y);
    const t = { x: (b0.x - a0.x) / len, y: (b0.y - a0.y) / len }, straight = len > 0 && pts.every((p) => Math.abs((p.x - a0.x) * t.y - (p.y - a0.y) * t.x) <= 1e-9);
    const bnd: Piece[] = straight ? laneBoundary({ id: l.id, centerline_mm: pts.map((p) => ({ x: p.x, y: p.y })), width_mm: l.width_mm }).filter((b): b is Extract<typeof b, { kind: 'seg' }> => b.kind === 'seg').map((b) => ({ c: { a: b.p, b: b.q, r: 0 }, id: `${b.end ? 'lane-end' : 'lane-edge'}:${l.id}` })) : [];
    laneMap.set(l.id, { a0, t, n: { x: -t.y, y: t.x }, len: straight ? len : NaN, W: l.width_mm, layer: layerIds.get(l.layer)!, layerName: l.layer, bnd });
  }
  const obsByLayer = new Map<number, Piece[]>();
  const polys: { id: string; layer: number; pts: Vec2[] }[] = [];
  for (const o of input.obstacles) {
    const L = layerIds.get(o.layer); if (L === undefined) continue;
    const S = obsByLayer.get(L) ?? []; obsByLayer.set(L, S);
    if (o.kind === 'circle') { if (!(o.radius_mm > 0)) throw new SteerRefused(`obstacle ${o.id} radius`); S.push({ c: { a: o.center_mm, b: o.center_mm, r: o.radius_mm }, id: o.id }); }
    else { const p = o.points_mm; if (p.length < 3) throw new SteerRefused(`obstacle ${o.id} polygon`); for (let i = 0; i < p.length; i++) S.push({ c: { a: p[i], b: p[(i + 1) % p.length], r: 0 }, id: o.id }); polys.push({ id: o.id, layer: L, pts: p }); }
  }
  const insidePoly = (p: Vec2, Q: Vec2[]) => { let ins = false; for (let i = 0, j = Q.length - 1; i < Q.length; j = i++) { const a = Q[i], b = Q[j]; if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) ins = !ins; } return ins; };

  // ---- agents, canonical id order
  const specs = [...input.agents].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (let i = 1; i < specs.length; i++) if (specs[i].id === specs[i - 1].id) throw new SteerRefused(`duplicate agent id ${specs[i].id}`);
  const N = specs.length;
  const A: Ag[] = specs.map((sp, k) => {
    const ln = laneMap.get(sp.lane); if (!ln) throw new SteerRefused(`${sp.id}: lane ${sp.lane} unknown`);
    if (!Number.isFinite(ln.len)) throw new SteerRefused(`${sp.id}: lane ${sp.lane} has a bend; the steering candidates handle straight lanes only (body rotation at a bend is not modelled)`);
    const L = sp.body.length_mm, w = sp.body.width_mm;
    if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0) || !(w > 0)) throw new SteerRefused(`${sp.id}: body size unknown (never invented)`);
    if (!(sp.free_speed_mm_s > 0) || !Number.isFinite(sp.free_speed_mm_s)) throw new SteerRefused(`${sp.id}: free speed must be positive`);
    if (!(sp.s_mm >= 0 && sp.s_mm <= ln.len && sp.goal_s_mm >= 0 && sp.goal_s_mm <= ln.len) || (sp.goal_s_mm - sp.s_mm) * sp.dir < 0) throw new SteerRefused(`${sp.id}: start/goal inconsistent with lane ${sp.lane}`);
    if (!(sp.start_t_s >= 0) || !Number.isFinite(sp.start_t_s)) throw new SteerRefused(`${sp.id}: start time`);
    const f = { x: ln.t.x * sp.dir, y: ln.t.y * sp.dir }, c = add(add(ln.a0, ln.t, sp.s_mm), ln.n, sp.u_mm);
    return {
      k, id: sp.id, lane: sp.lane, layerName: ln.layerName, layer: ln.layer, a0: ln.a0, t: ln.t, n: ln.n, len: ln.len, W: ln.W,
      f, left: { x: -f.y, y: f.x }, heading: Math.atan2(f.y, f.x), dir: sp.dir, v0: sp.free_speed_mm_s, goal: sp.goal_s_mm, start: sp.start_t_s,
      hw: Math.max(0, L - w) / 2, r: w / 2, half: L / 2, statics: [...ln.bnd, ...(obsByLayer.get(ln.layer) ?? [])],
      c, started: false, arrived: null, eff: ZERO, lastKey: '', samples: [], stopCause: null, halted: false,
      mode: 'go', until: 0, backLeft: 0, side: 0, sideSince: 0, progress: [], stalledSince: null, reported: false, reports: 0,
    };
  });
  const capOf = (a: Ag, c = a.c): Capsule => ({ a: add(c, a.f, -a.hw), b: add(c, a.f, a.hw), r: a.r });
  const sOf = (a: Ag, c = a.c) => dot({ x: c.x - a.a0.x, y: c.y - a.a0.y }, a.t);
  const uOf = (a: Ag, c = a.c) => dot({ x: c.x - a.a0.x, y: c.y - a.a0.y }, a.n);
  const fwdOf = (a: Ag, c = a.c) => sOf(a, c) * a.dir;
  const sample = (a: Ag, t: number) => {
    const last = a.samples[a.samples.length - 1];
    if (last && last[0] === t && last[1] === a.c.x && last[2] === a.c.y) return;
    a.samples.push([t, a.c.x, a.c.y, a.heading, sOf(a), uOf(a)]);
  };
  for (const a of A) {
    const c0 = capOf(a);
    for (const p of a.statics) { const g = capsuleGap(c0, p.c); if (g < -OCC_TOL_MM) throw new SteerRefused(`${a.id}: start pose penetrates ${p.id} by ${-g} mm`); }
    for (const q of polys) if (q.layer === a.layer && insidePoly(a.c, q.pts)) throw new SteerRefused(`${a.id}: starts inside obstacle ${q.id}`);
    sample(a, 0);
  }
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) if (A[i].layer === A[j].layer && Math.abs(A[i].c.x - A[j].c.x) <= A[i].half + A[j].half && Math.abs(A[i].c.y - A[j].c.y) <= A[i].half + A[j].half) {
    const g = capsuleGap(capOf(A[i]), capOf(A[j])); if (g < -OCC_TOL_MM) throw new SteerRefused(`${A[i].id} and ${A[j].id} overlap at t = 0 by ${-g} mm`);
  }

  const events: SteerEvent[] = [];
  const stats: SteerResult['stats'] = { decision_instants: 0, decisions: {}, probes: 0, pair_hit_evals: 0, physics_rounds_max: 0, fallback_intervals: 0, stops_contact: 0, stops_static: 0, contacts: 0, arrived: 0, stalled: 0, blocked_reports: {}, geometry_halts: 0, unresolved: 0, t_end_s: H };
  const ev = (t: number, kind: string, ids: number[], cls: SteerEventClass, detail: string | null = null) => events.push({ t_s: t, kind, agents: ids.map((i) => A[i].id), class: cls, detail });
  const activeContacts = new Map<number, number>();   // pair key → contact start time
  const pkey = (i: number, j: number) => (i < j ? i * N + j : j * N + i);

  // ---- perception (local)
  interface Percept { bodies: { j: number; cap: Capsule; e: Vec2 }[]; statics: Piece[]; contact: boolean }
  const perceive = (a: Ag, nbr: number[]): Percept => {
    const me = capOf(a), out: Percept = { bodies: [], statics: [], contact: false };
    for (const j of nbr) { const b = A[j], cb = capOf(b), g = capsuleGap(me, cb); if (g <= RHO) { out.bodies.push({ j, cap: cb, e: b.f }); if (g <= 1e-7) out.contact = true; } }
    for (const p of a.statics) if (capsuleGap(me, p.c) <= RHO) out.statics.push(p);
    return out;
  };
  /** first hit along unit direction d within dist against the percept (bodies held still); null = free */
  const probe = (a: Ag, pc: Percept, d: Vec2, dist: number, bodies = true): { at: number; what: 'body' | 'static'; j: number; id: string } | null => {
    stats.probes++;
    const me = capOf(a);
    let best: { at: number; what: 'body' | 'static'; j: number; id: string } | null = null;
    if (bodies) for (const b of pc.bodies) { const h = boundedHit(me, d, b.cap, ZERO, dist); if (h && h.tau < dist && (!best || h.tau < best.at)) best = { at: h.tau, what: 'body', j: b.j, id: A[b.j].id }; }
    for (const p of pc.statics) { const h = boundedHit(me, d, p.c, ZERO, dist); if (h && h.tau < dist && (!best || h.tau < best.at)) best = { at: h.tau, what: 'static', j: -1, id: p.id }; }
    return best;
  };
  /** the most forward free direction: candidates by increasing |angle|; both sides of an angle free → named RNG draw (or a preferred side) */
  const freeDir = (a: Ag, pc: Percept, epoch: number, minAng: number, pref: 1 | -1 | 0, stream: string): { ang: number; d: Vec2 } | null => {
    for (const g of ANG) {
      if (g < minAng) continue;
      if (g === 0) { if (!probe(a, pc, a.f, RHO)) return { ang: 0, d: a.f }; continue; }
      const L = rot(a.f, g), R = rot(a.f, -g), lf = !probe(a, pc, L, RHO), rf = !probe(a, pc, R, RHO);
      if (lf && rf) { const side = pref !== 0 ? pref : draw(stream, a.id, epoch, String(g)) < 0.5 ? 1 : -1; return side > 0 ? { ang: g, d: L } : { ang: -g, d: R }; }
      if (pref !== 0 && ((pref > 0 && !lf) || (pref < 0 && !rf))) continue;          // committed side closed at this angle: try wider
      if (lf) return { ang: g, d: L };
      if (rf) return { ang: -g, d: R };
    }
    return null;
  };
  /** rule D: local diagnosis of a blockage (geometry within the sensing radius only) */
  type Diagnosis = 'static_closed' | 'too_narrow_for_two' | 'blocked_by_nestmates' | 'static_ahead' | 'way_ahead_free';
  const diagnose = (a: Ag, pc: Percept, ahead: { what: 'body' | 'static'; j: number } | null): Diagnosis => {
    const blockerJ = ahead && ahead.what === 'body' ? ahead.j : -1;
    const statOnly: Percept = { bodies: [], statics: pc.statics, contact: false };
    let anyFree = !probe(a, statOnly, a.f, RHO, false);
    for (const g of ANG) if (!anyFree && g > 0 && g <= 90) anyFree = !probe(a, statOnly, rot(a.f, g), RHO, false) || !probe(a, statOnly, rot(a.f, -g), RHO, false);
    if (!anyFree) return 'static_closed';
    if (blockerJ >= 0) {
      const room = (s: 1 | -1) => { const h = probe(a, statOnly, s > 0 ? a.left : { x: -a.left.x, y: -a.left.y }, RHO, false); return h ? h.at : Infinity; };
      const wl = room(1) + room(-1) + 2 * a.r;                  // local free width (both walls sensed) or ∞
      return wl < 2 * a.r + 2 * A[blockerJ].r ? 'too_narrow_for_two' : 'blocked_by_nestmates';
    }
    return ahead ? 'static_ahead' : 'way_ahead_free';
  };

  // ---- decisions
  const decide = (a: Ag, pc: Percept, t0: number, epoch: number): Decision => {
    const v = a.v0, wv = (d: Vec2) => ({ x: d.x * v, y: d.y * v });
    if (a.halted) return { kind: 'halt_geometry', w: ZERO, detail: 'static geometry closes every direction within the sensing radius (rule D)' };
    const ahead = probe(a, pc, a.f, RHO);
    const sameHeading = (j: number) => SAME !== null && dot(A[j].f, a.f) >= SAME;
    if (policy === 'A_free_direction') {
      const fd = freeDir(a, pc, epoch, 0, 0, 'tie');
      if (!fd) return { kind: 'wait', w: ZERO, detail: `no free direction within ${RHO} mm (${ahead ? `${ahead.what} ${ahead.id} ahead` : 'sides closed'})` };
      return fd.ang === 0 ? { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' } : { kind: 'sidestep', w: wv(fd.d), detail: `most forward free direction ${fd.ang}°` };
    }
    if (policy === 'C_sidestep') {
      if (!ahead) { a.side = 0; return { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' }; }
      if (ahead.what === 'body' && sameHeading(ahead.j)) { a.side = 0; return { kind: 'follow', w: wv(a.f), detail: `same-direction nestmate ${ahead.id} ahead: follow` }; }
      let fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side, 'side');
      if (!fd && a.side !== 0) fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side > 0 ? -1 : 1, 'side');
      if (!fd) return { kind: 'wait', w: ZERO, detail: `${ahead.what} ${ahead.id} ahead, no room to step aside within ${RHO} mm` };
      a.side = fd.ang > 0 ? 1 : -1;
      return { kind: 'sidestep', w: wv(fd.d), detail: `${ahead.what} ${ahead.id} ahead: step aside ${fd.ang}°` };
    }
    // ---- B: wait / back off / re-route, chosen on contact
    if (a.mode === 'wait') { if (t0 < a.until) return { kind: 'wait', w: ZERO, detail: `waiting until ${a.until} s` }; a.mode = 'go'; }
    if (a.mode === 'back') {
      if (a.backLeft > 1e-9) { const rear = { x: -a.f.x, y: -a.f.y }, h = probe(a, pc, rear, Math.min(RHO, a.backLeft)); if (!h) return { kind: 'back_off', w: wv(rear), detail: `backing off, ${a.backLeft.toFixed(3)} mm left` }; }
      a.mode = 'go';
    }
    if (a.mode === 'side') {
      if (!ahead || t0 - a.sideSince >= P.reroute_max_s!) { a.mode = 'go'; a.side = 0; }
      else { const fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, a.side, 'side'); if (fd) return { kind: 'reroute', w: wv(fd.d), detail: `re-routing ${fd.ang}° around ${ahead.what} ${ahead.id}` }; a.mode = 'go'; a.side = 0; }
    }
    if (!ahead) return { kind: 'go', w: wv(a.f), detail: 'straight ahead is free' };
    if (ahead.what === 'body' && sameHeading(ahead.j)) return { kind: 'follow', w: wv(a.f), detail: `same-direction nestmate ${ahead.id} ahead: follow` };
    const startSide = () => { const fd = freeDir(a, pc, epoch, ANG.find((g) => g > 0) ?? 0, 0, 'side'); if (!fd) return null; a.mode = 'side'; a.side = fd.ang > 0 ? 1 : -1; a.sideSince = t0; return { kind: 'reroute' as const, w: wv(fd.d), detail: `re-route ${fd.ang}° around ${ahead.what} ${ahead.id}` }; };
    if (ahead.what === 'static') return startSide() ?? { kind: 'wait', w: ZERO, detail: `static ${ahead.id} ahead, no free direction` };
    const narrow = diagnose(a, pc, ahead) !== 'blocked_by_nestmates';
    const pw = P.p_wait!, pb = P.p_back!, pr = narrow ? 0 : P.p_reroute!, x = draw('action', a.id, epoch) * (pw + pb + pr);
    if (pw + pb + pr > 0 && x >= pw + pb) { const s = startSide(); if (s) return s; }
    if (pw + pb + pr > 0 && x >= pw && x < pw + pb) { a.mode = 'back'; a.backLeft = P.back_distance_mm!; const rear = { x: -a.f.x, y: -a.f.y }; if (!probe(a, pc, rear, Math.min(RHO, a.backLeft))) return { kind: 'back_off', w: wv(rear), detail: `contact with ${ahead.id}: back off ${P.back_distance_mm} mm${narrow ? ' (too narrow to pass)' : ''}` }; a.mode = 'go'; }
    a.mode = 'wait'; a.until = t0 + P.wait_s!;
    return { kind: 'wait', w: ZERO, detail: `contact with ${ahead.id}: wait ${P.wait_s} s${narrow ? ' (too narrow to pass)' : ''}` };
  };

  // ---- physics of one decision interval: exact non-penetration with inelastic stops
  const hitPair = (i: number, j: number, aT: number[], bT: number[], w: Vec2[], c0: Vec2[]): number | null => {
    const P1 = A[i], P2 = A[j], pts = [...new Set([0, aT[i], bT[i], aT[j], bT[j]])].sort((x, y) => x - y);
    const posAt = (x: number, tau: number) => add(c0[x], w[x], Math.min(Math.max(tau, aT[x]), bT[x]) - aT[x]);
    const velIn = (x: number, p: number) => (p >= aT[x] && p < bT[x] ? w[x] : ZERO);
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1], vi = velIn(i, p), vj = velIn(j, p);
      if (sameVec(vi, ZERO) && sameVec(vj, ZERO)) continue;
      stats.pair_hit_evals++;
      const h = boundedHit(capOf(P1, posAt(i, p)), vi, capOf(P2, posAt(j, p)), vj, q - p);
      if (!h) continue;
      if (h.overlapping) { stats.unresolved++; return p; }
      return p + h.tau;
    }
    return null;
  };

  let epoch = 0;
  for (let t0 = 0; t0 < H; epoch++) {
    const t1 = Math.min(H, (epoch + 1) * DT), span = t1 - t0;
    stats.decision_instants++;
    // agents that exist as moving deciders in this interval: started (or starting before t1), not arrived
    const live = A.filter((a) => a.arrived === null && a.start < t1);
    // neighbour candidates: boxes covering perception and the largest possible motion in this interval
    const boxes: AABB[] = A.map((a) => { const m = a.half + RHO + (a.arrived === null ? a.v0 * span : 0); return { minX: a.c.x - m, minY: a.c.y - m, maxX: a.c.x + m, maxY: a.c.y + m }; });
    const pairs = broadphasePairs('grid', boxes, A.map((a) => a.layer), 8);
    const nb: number[][] = A.map(() => []);
    for (const key of pairs) { const i = Math.floor(key / N), j = key % N; nb[i].push(j); nb[j].push(i); }
    // decisions (read the state at t0 only)
    const w: Vec2[] = A.map(() => ZERO), aT = A.map(() => 0), bT = A.map(() => 0), dec: (Decision | null)[] = A.map(() => null);
    for (const a of live) {
      const x = a.k;
      aT[x] = Math.max(0, a.start - t0);
      const d = decide(a, perceive(a, nb[x]), t0, epoch);
      dec[x] = d; w[x] = d.w; bT[x] = sameVec(d.w, ZERO) ? aT[x] : span;
      stats.decisions[d.kind] = (stats.decisions[d.kind] ?? 0) + 1;
    }
    const c0 = A.map((a) => a.c);
    // static geometry and goal
    const cause: (string | null)[] = A.map(() => null), causeKind: ('static' | 'goal' | 'body' | null)[] = A.map(() => null), causeJ: number[] = A.map(() => -1);
    for (const a of live) {
      const x = a.k; if (bT[x] === aT[x]) continue;
      const me = capOf(a);
      for (const p of a.statics) { const h = boundedHit(me, w[x], p.c, ZERO, span - aT[x]); if (h) { const tb = aT[x] + (h.overlapping ? 0 : h.tau); if (tb < bT[x]) { bT[x] = tb; cause[x] = `static geometry ${p.id}`; causeKind[x] = 'static'; } } }
      const along = dot(w[x], a.f);
      if (along > 0) { const tg = aT[x] + (a.goal * a.dir - fwdOf(a)) / along; if (tg <= bT[x]) { bT[x] = Math.max(aT[x], tg); cause[x] = 'goal'; causeKind[x] = 'goal'; } }
    }
    // bodies: Jacobi iteration on the stop times
    let changed = new Set<number>(live.filter((a) => bT[a.k] > aT[a.k]).map((a) => a.k)), rounds = 0, fallback = false;
    const pairList = pairs.map((key) => [Math.floor(key / N), key % N] as [number, number]);
    while (changed.size) {
      if (++rounds > 4 * N + 20) { fallback = true; break; }
      const prop = new Map<number, { b: number; why: string; o: number }>();
      for (const [i, j] of pairList) {
        if (!changed.has(i) && !changed.has(j)) continue;
        if (bT[i] === aT[i] && bT[j] === aT[j]) continue;
        const h = hitPair(i, j, aT, bT, w, c0); if (h === null) continue;
        // who moves INTO the contact at h
        const pi = add(c0[i], w[i], Math.min(Math.max(h, aT[i]), bT[i]) - aT[i]), pj = add(c0[j], w[j], Math.min(Math.max(h, aT[j]), bT[j]) - aT[j]);
        const ci = capOf(A[i], pi), cj = capOf(A[j], pj), [qa, qb] = closestPts(ci.a, ci.b, cj.a, cj.b), dd = Math.hypot(qb.x - qa.x, qb.y - qa.y);
        const nrm = dd > 0 ? { x: (qb.x - qa.x) / dd, y: (qb.y - qa.y) / dd } : null;
        const movI = h >= aT[i] && h < bT[i], movJ = h >= aT[j] && h < bT[j];
        const inI = movI && (!nrm || dot(nrm, w[i]) > 1e-12 * Math.hypot(w[i].x, w[i].y)), inJ = movJ && (!nrm || -dot(nrm, w[j]) > 1e-12 * Math.hypot(w[j].x, w[j].y));
        const resp: number[] = inI || inJ ? [...(inI ? [i] : []), ...(inJ ? [j] : [])] : [...(movI ? [i] : []), ...(movJ ? [j] : [])];
        for (const x of resp) { const o = x === i ? j : i, cur = prop.get(x); if (h < bT[x] && (!cur || h < cur.b || (h === cur.b && o < cur.o))) prop.set(x, { b: h, why: `contact with ${A[o].id} would penetrate`, o }); }
      }
      changed = new Set();
      for (const [x, p] of [...prop].sort((u, v) => u[0] - v[0])) if (p.b < bT[x]) { bT[x] = p.b; cause[x] = p.why; causeKind[x] = 'body'; causeJ[x] = p.o; changed.add(x); }
    }
    stats.physics_rounds_max = Math.max(stats.physics_rounds_max, rounds);
    if (fallback) { stats.fallback_intervals++; stats.unresolved++; ev(t0, 'unresolved', live.map((a) => a.k).slice(0, 5), 'solver_status', 'contact stop times did not settle: nobody moves in this interval (safe fallback)'); for (const a of live) { bT[a.k] = aT[a.k]; cause[a.k] = 'physics fallback (nobody moves)'; causeKind[a.k] = 'body'; } }

    // apply motion, records and events
    for (const a of live) {
      const x = a.k, d = dec[x]!, tA = t0 + aT[x], moved = bT[x] > aT[x];
      if (!a.started) { a.started = true; ev(a.start, 'start', [x], 'motion'); }
      const key = `${d.kind}|${d.w.x}|${d.w.y}`;
      let named = false;
      if (key !== a.lastKey) { ev(tA, d.kind, [x], 'behavioural_response', d.detail); a.lastKey = key; named = true; }
      const vStart = moved ? d.w : ZERO;
      if (!sameVec(vStart, a.eff)) {
        sample(a, tA);
        if (!named) {
          if (moved) ev(tA, 'resume', [x], 'physical_constraint', `${d.kind}: way free again at this decision instant`);
          else { ev(tA, 'stop', [x], 'physical_constraint', cause[x] ?? 'no motion'); a.stopCause = cause[x]; }
        } else if (!moved && cause[x]) a.stopCause = cause[x];
      }
      a.eff = vStart;
      if (moved) {
        a.c = add(c0[x], d.w, bT[x] - aT[x]);
        if (bT[x] < span) {
          const tb = t0 + bT[x];
          sample(a, tb); a.eff = ZERO;
          if (causeKind[x] === 'goal') { a.arrived = tb; stats.arrived++; ev(tb, 'arrive', [x], 'motion'); }
          else {
            ev(tb, 'stop', [x], 'physical_constraint', cause[x]); a.stopCause = cause[x];
            if (causeKind[x] === 'static') stats.stops_static++; else stats.stops_contact++;
            const j = causeJ[x];
            if (causeKind[x] === 'body' && j >= 0 && !activeContacts.has(pkey(x, j))) { activeContacts.set(pkey(x, j), tb); stats.contacts++; ev(tb, 'contact_start', [Math.min(x, j), Math.max(x, j)], 'physical_contact', null); }
          }
        }
      }
    }
    // contacts that opened up during the interval end at its start (the separating motion was chosen at t0)
    for (const [key, ts] of [...activeContacts].sort((p, q) => p[0] - q[0])) {
      const i = Math.floor(key / N), j = key % N, g = capsuleGap(capOf(A[i]), capOf(A[j]));
      if (g > 1e-7) { activeContacts.delete(key); ev(Math.max(t0, ts), 'contact_end', [i, j], 'physical_contact', 'gap opened in this decision interval (time = its start, or the contact start if later)'); }
    }
    // rule D: progress over the stall window, local diagnosis, report once per episode
    for (const a of live) {
      if (a.arrived !== null || !a.started) continue;
      a.progress.push(fwdOf(a)); if (a.progress.length > STALL_K + 1) a.progress.shift();
      if (a.progress.length <= STALL_K) continue;
      const prog = a.progress[a.progress.length - 1] - a.progress[0];
      if (prog >= STALL_MM) { a.stalledSince = null; a.reported = false; continue; }
      if (a.stalledSince === null) a.stalledSince = t1 - STALL_K * DT;
      if (!a.reported) {
        const pc = perceive(a, nb[a.k]), ahead = probe(a, pc, a.f, RHO), why = diagnose(a, pc, ahead);
        a.reported = true; a.reports++; stats.blocked_reports[why] = (stats.blocked_reports[why] ?? 0) + 1;
        ev(t1, 'blocked_report', [a.k], 'solver_status', `${why}: forward progress ${prog.toFixed(4)} mm in ${STALL_K * DT} s${ahead ? ` (${ahead.what} ${ahead.id} ahead)` : ''}`);
        if (why === 'static_closed' && !a.halted) { a.halted = true; stats.geometry_halts++; }
      }
    }
    t0 = t1;
  }
  events.sort((p, q) => p.t_s - q.t_s);   // stable: same-time events keep their generation order
  const agents: Record<string, SteerAgentOut> = {};
  for (const a of A) {
    sample(a, H);
    const moving = !sameVec(a.eff, ZERO);
    const mode = a.arrived !== null ? 'arrived' : !a.started ? 'not_started' : a.halted ? 'halted_geometry' : a.stalledSince !== null ? 'stalled' : moving ? 'moving' : 'waiting_or_stopped';
    if (mode === 'stalled' || mode === 'halted_geometry') { stats.stalled++; events.push({ t_s: H, kind: 'stalled', agents: [a.id], class: 'solver_status', detail: `${mode} since ${a.stalledSince} s${a.stopCause ? `; last stop: ${a.stopCause}` : ''}` }); }
    agents[a.id] = { lane: a.lane, layer: a.layerName, samples: a.samples, arrival_t_s: a.arrived, final_mode: mode, final_speed_mm_s: Math.hypot(a.eff.x, a.eff.y), stop_cause: a.stopCause, geometry_stop_s_mm: null, blocked_reports: a.reports };
  }
  return { policy, agents, events, stats };
}

/** re-export so callers can tell refusals apart */
export { Solver2DRefused };
/** exact segment distance used by verifiers (re-export, no new geometry) */
export const axisDistance = segmentSegment2D;
