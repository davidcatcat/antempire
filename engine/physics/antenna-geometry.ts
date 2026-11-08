/**
 * ANTENNA-GEO (Issue #172; Owner decisions 34, 36, 37; docs/antenna-geometry.md). ISOLATED geometry module: not imported
 * by the official pipeline (tests/physics-isolation.test.ts), not connected to any biological decision.
 *
 * What it provides (geometry and kinematics only):
 *  - frames: world ← body (pose x, y, θ from kinematics2d) ← head (origin = midpoint between the two antenna bases,
 *    placed on the body axis at head_origin_x_mm and rotated by head_yaw_rad); exact transforms and inverses;
 *  - left / right antenna bases at (0, ±torulus_halfspan_mm) in the head frame;
 *  - an elbowed, PLANAR two-link antenna: scape (length Ls) and funiculus (length Lf, treated as one rigid link). Joint
 *    angles: scape angle α measured in the head frame from the head's forward axis, positive OUTWARD (mirrored for the
 *    right antenna); elbow angle β = funiculus direction relative to the scape, positive outward. Ranges of motion are
 *    [α_min, α_max], [β_min, β_max]; reach envelope in closed form;
 *  - a KINEMATIC scanning model (sinusoidal joint trajectories) that is a model input for geometry and contact tests. It
 *    is NOT the display animation (web/src/display-motion.ts on PR #164) and it is NOT a perception model;
 *  - antenna_contact events (Owner decision 36) against static objects, other ants' bodies and other ants' antennae, by
 *    conservative advancement on the exact capsule gap, using the kinematics2d tolerances and time contract;
 *  - an adapter to the local-sensing contract (engine/physics/local-sensing.ts, unchanged): it expresses each exact
 *    antenna tip as the equivalent straight-antenna AntennaGeometry that the contract recomputes (antennaSensors).
 *
 * Contact classes (decision 36): this module emits ONLY `antenna_contact`. Body collision (`geometric_contact`) and solver
 * constraints (`constraint_active`) come from kinematics2d and are mapped by contactKindOf(); a body contact never
 * stands in for an antenna contact, and an antenna contact carries `recognition: null` (no recognition is modelled).
 *
 * Parameters (decision 37): mode 'species' requires sourced, non-assumption values for every parameter and refuses to
 * run otherwise (today: always, since no antenna measurements beyond scape length exist for the species); mode
 * 'candidate' must be chosen explicitly, every value must be labelled assumption:true with a basis, and the values are
 * checked against sourced morphology constraints supplied by the caller. Nothing is defaulted.
 *
 * The antenna is kinematic: it passes through what it touches (no deflection, no constraint response). Planar
 * projection: the real antenna moves in 3-D, so planar link lengths are upper bounds of the projected lengths.
 * Units: mm, s, rad. Pure and deterministic; no platform APIs.
 */
import type { Pose, Track, Static, Cap, P2 } from './kinematics2d.ts';
import { poseAt, twistAt, segIndexAt, capsuleAt, dimsOf, staticCaps, capGap, CONTACT_TOL_MM, CA_LEVEL_MM, SEP_RES_MM, CA_MAX_ITER, type KinEvent } from './kinematics2d.ts';
import { antennaSensors, type AntennaGeometry as SensingGeometry, type SensorPoint, type LocalSampleRequest, type AssumptionTag, type Basis } from './local-sensing.ts';
import { pointInPolygon } from './vec.ts';

export class AntennaRefused extends Error {
  readonly codes: string[];
  constructor(codes: string[]) { super(`ANTENNA_REFUSED: ${codes.join(', ')}`); this.name = 'AntennaRefused'; this.codes = codes; }
}

// ---------------------------------------------------------------- parameters
/** one parameter: value null = unknown (never defaulted) */
export interface Param { value: number | null; assumption: boolean; basis: Basis | null; source: string | null; note: string }
/** morphology / range-of-motion parameters (biological geometry) */
export const MORPH_KEYS = ['head_origin_x_mm', 'head_yaw_rad', 'torulus_halfspan_mm', 'scape_length_mm', 'funiculus_length_mm', 'antenna_radius_mm', 'scape_angle_min_rad', 'scape_angle_max_rad', 'elbow_angle_min_rad', 'elbow_angle_max_rad'] as const;
/** kinematic scanning-model parameters (NOT display animation, NOT perception) */
export const SCAN_KEYS = ['scan_scape_centre_rad', 'scan_scape_amplitude_rad', 'scan_elbow_centre_rad', 'scan_elbow_amplitude_rad', 'scan_frequency_hz', 'scan_phase_left_rad', 'scan_phase_right_rad', 'scan_elbow_phase_offset_rad'] as const;
export type MorphKey = typeof MORPH_KEYS[number];
export type ScanKey = typeof SCAN_KEYS[number];
export type AntennaParams = Record<MorphKey, Param>;
export type ScanParams = Record<ScanKey, Param>;
export type ParamMode = 'species' | 'candidate';
/** a sourced morphology constraint on one parameter (e.g. scape length within a published range) */
export interface MorphologyConstraint { id: string; param: MorphKey; min: number | null; max: number | null; source_ids: string[]; note: string }
export interface AntennaModelInput { mode: ParamMode; params: AntennaParams; scan: ScanParams; constraints: MorphologyConstraint[] }

/** resolved numbers (only produced after validation) */
export interface AntennaModel {
  mode: ParamMode;
  hx: number; hyaw: number; half: number; Ls: number; Lf: number; r: number;
  aMin: number; aMax: number; bMin: number; bMax: number;
  scan: { ac: number; aa: number; bc: number; ba: number; f: number; phL: number; phR: number; phB: number };
  /** labels attached to every output that depends on the model */
  tags: AssumptionTag[];
  constraint_report: { id: string; ok: boolean; detail: string }[];
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const BASES = new Set(['文獻支持', '一般生理學', '遊戲假設']);

/** Validates and resolves the parameters. Throws AntennaRefused with every problem found. */
export function resolveModel(input: AntennaModelInput): AntennaModel {
  const e: string[] = [];
  if (input?.mode !== 'species' && input?.mode !== 'candidate') throw new AntennaRefused(['MISSING:mode (species or candidate must be explicit)']);
  const all: [string, Param | undefined][] = [...MORPH_KEYS.map((k) => [k, input.params?.[k]] as [string, Param | undefined]), ...SCAN_KEYS.map((k) => [k, input.scan?.[k]] as [string, Param | undefined])];
  for (const [k, p] of all) {
    if (!p || typeof p !== 'object') { e.push(`MISSING:${k}`); continue; }
    if (p.value === null) { e.push(`NULL_PARAMETER:${k}`); continue; }
    if (!fin(p.value)) { e.push(`BAD_VALUE:${k}`); continue; }
    if (input.mode === 'species') {
      if (p.assumption !== false) e.push(`ASSUMPTION_IN_SPECIES_MODE:${k}`);
      if (!p.source) e.push(`UNSOURCED_IN_SPECIES_MODE:${k}`);
    } else {
      if (p.assumption !== true) e.push(`CANDIDATE_NOT_LABELLED:${k}`);
      if (!p.basis || !BASES.has(p.basis)) e.push(`MISSING_BASIS:${k}`);
    }
  }
  if (e.length) throw new AntennaRefused(e);
  const v = (k: MorphKey | ScanKey): number => ((input.params as Record<string, Param>)[k] ?? (input.scan as Record<string, Param>)[k]).value as number;
  const m: AntennaModel = {
    mode: input.mode, hx: v('head_origin_x_mm'), hyaw: v('head_yaw_rad'), half: v('torulus_halfspan_mm'), Ls: v('scape_length_mm'), Lf: v('funiculus_length_mm'), r: v('antenna_radius_mm'),
    aMin: v('scape_angle_min_rad'), aMax: v('scape_angle_max_rad'), bMin: v('elbow_angle_min_rad'), bMax: v('elbow_angle_max_rad'),
    scan: { ac: v('scan_scape_centre_rad'), aa: v('scan_scape_amplitude_rad'), bc: v('scan_elbow_centre_rad'), ba: v('scan_elbow_amplitude_rad'), f: v('scan_frequency_hz'), phL: v('scan_phase_left_rad'), phR: v('scan_phase_right_rad'), phB: v('scan_elbow_phase_offset_rad') },
    tags: all.map(([k, p]) => ({ name: `antenna.${k}`, assumption: (p as Param).assumption, basis: ((p as Param).basis ?? '遊戲假設') as Basis, note: (p as Param).note })),
    constraint_report: [],
  };
  if (!(m.Ls > 0)) e.push('BAD_GEOMETRY:scape_length_mm must be > 0');
  if (!(m.Lf > 0)) e.push('BAD_GEOMETRY:funiculus_length_mm must be > 0');
  if (!(m.r >= 0)) e.push('BAD_GEOMETRY:antenna_radius_mm must be >= 0');
  if (!(m.half >= 0)) e.push('BAD_GEOMETRY:torulus_halfspan_mm must be >= 0');
  if (!(m.aMin <= m.aMax)) e.push('BAD_RANGE:scape angle');
  if (!(m.bMin <= m.bMax)) e.push('BAD_RANGE:elbow angle');
  if (!(m.aMax - m.aMin < 2 * Math.PI && m.bMax - m.bMin < 2 * Math.PI)) e.push('BAD_RANGE:range of motion must be < 2π');
  const s = m.scan;
  if (!(s.aa >= 0 && s.ba >= 0 && s.f >= 0)) e.push('BAD_SCAN:amplitudes and frequency must be >= 0');
  if (!(s.ac - s.aa >= m.aMin && s.ac + s.aa <= m.aMax)) e.push('SCAN_OUTSIDE_RANGE:scape');
  if (!(s.bc - s.ba >= m.bMin && s.bc + s.ba <= m.bMax)) e.push('SCAN_OUTSIDE_RANGE:elbow');
  for (const c of input.constraints ?? []) {
    const x = (input.params[c.param]?.value ?? null) as number | null;
    const okc = x !== null && (c.min === null || x >= c.min) && (c.max === null || x <= c.max);
    const detail = `${c.param}=${x} in [${c.min ?? '-∞'}, ${c.max ?? '+∞'}] (${c.source_ids.join(',')})`;
    m.constraint_report.push({ id: c.id, ok: okc, detail });
    if (!okc) e.push(`MORPHOLOGY_CONFLICT:${c.id}:${detail}`);
  }
  if (e.length) throw new AntennaRefused(e);
  return m;
}

// ---------------------------------------------------------------- frames
/** a child frame expressed in its parent: origin (x, y) and x-axis angle th */
export interface Frame { x: number; y: number; th: number }
/** point in the child frame → parent frame */
export function toParent(f: Frame, p: P2): P2 { const c = Math.cos(f.th), s = Math.sin(f.th); return { x: f.x + c * p.x - s * p.y, y: f.y + s * p.x + c * p.y }; }
/** point in the parent frame → child frame (exact inverse of toParent up to rounding) */
export function fromParent(f: Frame, p: P2): P2 { const c = Math.cos(f.th), s = Math.sin(f.th), dx = p.x - f.x, dy = p.y - f.y; return { x: c * dx + s * dy, y: -s * dx + c * dy }; }
/** frame b (given in frame a) expressed in a's parent */
export function compose(a: Frame, b: Frame): Frame { const o = toParent(a, { x: b.x, y: b.y }); return { x: o.x, y: o.y, th: a.th + b.th }; }
/** head frame in the body frame */
export const headInBody = (m: AntennaModel): Frame => ({ x: m.hx, y: 0, th: m.hyaw });
/** head frame in the world frame for a body pose */
export const headInWorld = (pose: Pose, m: AntennaModel): Frame => compose({ x: pose.x, y: pose.y, th: pose.th }, headInBody(m));

// ---------------------------------------------------------------- antenna geometry
export type Side = 'left' | 'right';
export const SIDES: Side[] = ['left', 'right'];
const sgn = (side: Side) => (side === 'left' ? 1 : -1);
export interface Joints { scape_rad: number; elbow_rad: number }
export interface AntennaPoints { base: P2; elbow: P2; tip: P2 }

/** base, elbow and tip of one antenna in the HEAD frame */
export function antennaInHead(m: AntennaModel, side: Side, j: Joints): AntennaPoints {
  const s = sgn(side), a = s * j.scape_rad, b = s * (j.scape_rad + j.elbow_rad);
  const base = { x: 0, y: s * m.half };
  const elbow = { x: base.x + m.Ls * Math.cos(a), y: base.y + m.Ls * Math.sin(a) };
  return { base, elbow, tip: { x: elbow.x + m.Lf * Math.cos(b), y: elbow.y + m.Lf * Math.sin(b) } };
}
/** the same points in the WORLD frame for a body pose */
export function antennaInWorld(pose: Pose, m: AntennaModel, side: Side, j: Joints): AntennaPoints {
  const h = headInWorld(pose, m), p = antennaInHead(m, side, j);
  return { base: toParent(h, p.base), elbow: toParent(h, p.elbow), tip: toParent(h, p.tip) };
}
/** n points evenly spaced along the antenna's arc length (i = 1..n; the last is the tip) — used to study sampling */
export function antennaSamplePoints(pose: Pose, m: AntennaModel, side: Side, j: Joints, n: number): P2[] {
  if (!(Number.isInteger(n) && n >= 1)) throw new AntennaRefused(['BAD:sample count']);
  const w = antennaInWorld(pose, m, side, j), L = m.Ls + m.Lf, out: P2[] = [];
  for (let i = 1; i <= n; i++) {
    const s = (L * i) / n;
    if (s <= m.Ls) { const u = s / m.Ls; out.push({ x: w.base.x + (w.elbow.x - w.base.x) * u, y: w.base.y + (w.elbow.y - w.base.y) * u }); }
    else { const u = (s - m.Ls) / m.Lf; out.push(i === n ? { ...w.tip } : { x: w.elbow.x + (w.tip.x - w.elbow.x) * u, y: w.elbow.y + (w.tip.y - w.elbow.y) * u }); }
  }
  return out;
}
/** joints within the range of motion? */
export const jointsInRange = (m: AntennaModel, j: Joints): boolean => j.scape_rad >= m.aMin && j.scape_rad <= m.aMax && j.elbow_rad >= m.bMin && j.elbow_rad <= m.bMax;

/** Reach envelope (closed form): base-to-tip distance over the elbow range, and the max distance of any antenna point
 *  from the base. |tip − base|² = Ls² + Lf² + 2·Ls·Lf·cos β. */
export function reachEnvelope(m: AntennaModel): { tip_r_min_mm: number; tip_r_max_mm: number; beta_at_min: number; beta_at_max: number; any_point_r_max_mm: number } {
  const r = (b: number) => Math.sqrt(m.Ls * m.Ls + m.Lf * m.Lf + 2 * m.Ls * m.Lf * Math.cos(b));
  // cos β on [bMin, bMax]: maximum at the point closest to 0 (mod 2π), minimum at the point closest to ±π
  const wrap = (x: number) => { let y = x % (2 * Math.PI); if (y > Math.PI) y -= 2 * Math.PI; if (y < -Math.PI) y += 2 * Math.PI; return y; };
  const contains = (c: number) => { for (let k = -2; k <= 2; k++) { const x = c + 2 * Math.PI * k; if (x >= m.bMin && x <= m.bMax) return x; } return null; };
  const z = contains(0), p = contains(Math.PI);
  const cands = [m.bMin, m.bMax];
  const bMaxR = z ?? cands.reduce((a, b) => (Math.abs(wrap(a)) <= Math.abs(wrap(b)) ? a : b));
  const bMinR = p ?? cands.reduce((a, b) => (Math.abs(wrap(a)) >= Math.abs(wrap(b)) ? a : b));
  const rmax = r(bMaxR);
  return { tip_r_min_mm: r(bMinR), tip_r_max_mm: rmax, beta_at_min: bMinR, beta_at_max: bMaxR, any_point_r_max_mm: Math.max(rmax, m.Ls) };
}

// ---------------------------------------------------------------- kinematic scanning model
/** joint angles of one antenna at simulation time t (s): α = αc + Aα·sin(2πft + φ_side), β = βc + Aβ·sin(2πft + φ_side + φβ) */
export function scanJoints(m: AntennaModel, side: Side, t: number): Joints {
  const s = m.scan, w = 2 * Math.PI * s.f, ph = side === 'left' ? s.phL : s.phR;
  return { scape_rad: s.ac + s.aa * Math.sin(w * t + ph), elbow_rad: s.bc + s.ba * Math.sin(w * t + ph + s.phB) };
}
/** upper bounds of |dα/dt| and |dβ/dt| */
export const scanRateBounds = (m: AntennaModel) => ({ a: 2 * Math.PI * m.scan.f * m.scan.aa, b: 2 * Math.PI * m.scan.f * m.scan.ba });
/** upper bound of the speed of any antenna point relative to the head frame */
export const scanPointSpeedBound = (m: AntennaModel): number => { const r = scanRateBounds(m); return r.a * m.Ls + (r.a + r.b) * m.Lf; };
/** upper bound of the distance from the body centre to any antenna point */
export const antennaRadiusFromBody = (m: AntennaModel): number => Math.abs(m.hx) + m.half + m.Ls + m.Lf;

// ---------------------------------------------------------------- local-sensing adapter
/**
 * Expresses the exact antenna tip of each side as the equivalent straight-antenna geometry of the local-sensing contract
 * (tip = head front point [body centre + L/2 along the heading] + len·(cos, sin)(θ ± half-angle)). One request per side
 * (each side has its own equivalent geometry). Refuses when a tip cannot be expressed (left tip right of the body axis or
 * vice versa, or a tip exactly at the head front point). `deviation_mm` = distance between the contract's recomputed
 * point and the exact tip (rounding only). The equivalent length is NOT the antenna's morphological length.
 */
export function sensingRequests(base: Omit<LocalSampleRequest, 'pose' | 'geometry' | 'sensors'>, pose: Pose, body_length_mm: number, m: AntennaModel): { requests: LocalSampleRequest[]; exact: Record<Side, P2>; deviation_mm: Record<Side, number> } {
  if (!(fin(body_length_mm) && body_length_mm > 0)) throw new AntennaRefused(['MISSING:body_length_mm']);
  const fx = pose.x + Math.cos(pose.th) * (body_length_mm / 2), fy = pose.y + Math.sin(pose.th) * (body_length_mm / 2);
  const requests: LocalSampleRequest[] = [], exact = {} as Record<Side, P2>, deviation_mm = {} as Record<Side, number>;
  for (const side of SIDES) {
    const tip = antennaInWorld(pose, m, side, scanJoints(m, side, base.t_s)).tip;
    const dx = tip.x - fx, dy = tip.y - fy, len = Math.hypot(dx, dy);
    let ang = Math.atan2(dy, dx) - pose.th; ang = Math.atan2(Math.sin(ang), Math.cos(ang));
    const half = sgn(side) * ang;
    if (!(len > 0) || half < 0) throw new AntennaRefused([`TIP_NOT_REPRESENTABLE:${side}`]);
    const geometry: SensingGeometry = { body_length_mm, antenna_len_mm: len, antenna_half_angle_rad: half };
    const sensors: SensorPoint[] = antennaSensors(pose, geometry).filter((s) => s.id === `antenna_${side}`);
    exact[side] = tip; deviation_mm[side] = Math.hypot(sensors[0].x_mm - tip.x, sensors[0].y_mm - tip.y);
    requests.push({ ...base, pose: { x: pose.x, y: pose.y, th: pose.th }, geometry, sensors, tags: [...base.tags, ...m.tags, { name: 'antenna.sensing_adapter', assumption: true, basis: '遊戲假設', note: 'equivalent straight-antenna geometry from the head front; not a morphological length' }] });
  }
  return { requests, exact, deviation_mm };
}

// ---------------------------------------------------------------- contact classes (decision 36)
export type ContactKind = 'geometric_contact' | 'constraint_active' | 'antenna_contact';
/** maps a kinematics2d event to its decision-36 class (null for motion / solver-status events) */
export function contactKindOf(e: KinEvent | AntennaContactEvent): ContactKind | null {
  if ((e as AntennaContactEvent).kind === 'antenna_contact') return 'antenna_contact';
  const k = e as KinEvent;
  if (k.class === 'physical_contact') return 'geometric_contact';
  if (k.class === 'physical_constraint') return 'constraint_active';
  return null;
}

// ---------------------------------------------------------------- signed capsule gap
/** perpendicular distance from p to the supporting line of ab (|ab| > 0) */
const lineDist = (p: P2, a: P2, b: P2): number => Math.abs((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / Math.hypot(b.x - a.x, b.y - a.y);
/** do the cores cross properly (interiors intersect at one point)? */
function properCross(a: P2, b: P2, c: P2, d: P2): boolean {
  const o = (p: P2, q: P2, r: P2) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}
/**
 * SIGNED capsule gap: distance between cores minus the radii, and, when the cores cross, minus the penetration depth of
 * the two segments (distance from the origin to the boundary of their Minkowski difference, a parallelogram:
 * min of the four endpoint-to-other-line distances). Continuous, and its rate is bounded by the relative point speed,
 * so conservative advancement stays valid while an antenna passes through an object (the unsigned gap would sit at 0).
 */
export function signedCapGap(A: Cap, B: Cap): { g: number; cA: P2 } {
  const q = capGap(A, B);
  if (properCross(A.a, A.b, B.a, B.b)) {
    const depth = Math.min(lineDist(A.a, B.a, B.b), lineDist(A.b, B.a, B.b), lineDist(B.a, A.a, A.b), lineDist(B.b, A.a, A.b));
    return { g: -depth - A.r - B.r, cA: q.cA };
  }
  return { g: q.g, cA: q.cA };
}

// ---------------------------------------------------------------- antenna contact detection
export interface AntennaAgent { id: string; track: Track; model: AntennaModel }
export interface AntennaContactInput {
  agents: AntennaAgent[]; statics: Static[]; t0_s: number; horizon_s: number;
  /** which targets to test (all explicit) */
  targets: { statics: boolean; bodies: boolean; antennae: boolean };
}
export type Part = 'scape' | 'funiculus';
export interface AntennaContactEvent {
  t_s: number; kind: 'antenna_contact'; phase: 'start' | 'end';
  agent_id: string; side: Side; part: Part;
  target: { kind: 'static' | 'body' | 'antenna'; id: string; side?: Side; part?: Part };
  /** crossing bracket of the contact level θ (g(lo) on the other side of θ than g(hi)); t_s = bracket[1] */
  bracket_s: [number, number]; gap_mm: number; point: P2;
  param_mode: ParamMode;
  /** geometric touching only: nothing about what the ant recognises is modelled */
  recognition: null;
  detail?: string;
}
export interface SolverStatus { t_s: number; kind: 'solver_status'; ids: string[]; detail: string }
export interface AntennaContactResult {
  events: AntennaContactEvent[]; status: SolverStatus[];
  /** largest simulation time at which any track was read (≤ horizon: no future reads) */
  max_time_read_s: number;
  /** most negative gap seen at the solver iterates (the kinematic antenna passes through; deflection not modelled) */
  min_gap_at_iterates_mm: number;
  stats: { pairs: number; iterations: number; max_iterations: number };
}

interface Ant { id: string; tr: Track; m: AntennaModel; d: { h: number; r: number }; layer: string; Rb: number; Vj: number }
type Target = { kind: 'static'; id: string; caps: Cap[] } | { kind: 'body'; ant: Ant } | { kind: 'antenna'; ant: Ant; side: Side };

/** Finds antenna_contact intervals on [t0, H]. Pairs are independent (antennae are kinematic), so the result does not
 *  depend on array order; steps never depend on H (results to H₁ are a prefix of results to H₂ > H₁). */
export function detectAntennaContacts(input: AntennaContactInput): AntennaContactResult {
  const H = input.horizon_s, T0 = input.t0_s;
  if (!(fin(H) && fin(T0) && T0 <= H)) throw new AntennaRefused(['BAD:time interval']);
  if (!input.targets) throw new AntennaRefused(['MISSING:targets']);
  const ids = input.agents.map((a) => a.id), sids = input.statics.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new AntennaRefused(['DUPLICATE:agent id']);
  if (new Set(sids).size !== sids.length || sids.some((s) => ids.includes(s))) throw new AntennaRefused(['DUPLICATE:static id']);
  let maxRead = -Infinity;
  const readPose = (tr: Track, t: number): Pose => {
    if (t > H) throw new AntennaRefused([`FUTURE_READ:${tr.id}@${t}>${H}`]);
    if (t > maxRead) maxRead = t;
    return poseAt(tr, t);
  };
  const ants: Ant[] = [...input.agents].sort((a, b) => (a.id < b.id ? -1 : 1)).map((a) => {
    if (!a.model || (a.model.mode !== 'species' && a.model.mode !== 'candidate')) throw new AntennaRefused([`MISSING:model:${a.id}`]);
    if (a.track.id !== a.id) throw new AntennaRefused([`TRACK_ID_MISMATCH:${a.id}`]);
    const d = dimsOf(a.track.body, a.id);
    return { id: a.id, tr: a.track, m: a.model, d, layer: a.track.layer ?? '', Rb: antennaRadiusFromBody(a.model), Vj: scanPointSpeedBound(a.model) };
  });
  const statics = [...input.statics].sort((a, b) => (a.id < b.id ? -1 : 1));

  const antCaps = (a: Ant, side: Side, t: number): { scape: Cap; funiculus: Cap } => {
    const w = antennaInWorld(readPose(a.tr, t), a.m, side, scanJoints(a.m, side, t));
    return { scape: { a: w.base, b: w.elbow, r: a.m.r }, funiculus: { a: w.elbow, b: w.tip, r: a.m.r } };
  };
  const targetCaps = (g: Target, t: number): { cap: Cap; part?: Part }[] => {
    if (g.kind === 'static') return g.caps.map((cap) => ({ cap }));
    if (g.kind === 'body') return [{ cap: capsuleAt(readPose(g.ant.tr, t), g.ant.d) }];
    const c = antCaps(g.ant, g.side, t); return [{ cap: c.scape, part: 'scape' }, { cap: c.funiculus, part: 'funiculus' }];
  };
  const gapAt = (a: Ant, side: Side, g: Target, t: number) => {
    const c = antCaps(a, side, t), tc = targetCaps(g, t);
    let best = { g: Infinity, part: 'scape' as Part, tpart: undefined as Part | undefined, p: c.scape.a };
    for (const part of ['scape', 'funiculus'] as Part[]) for (const x of tc) { const q = signedCapGap(c[part], x.cap); if (q.g < best.g) best = { g: q.g, part, tpart: x.part, p: q.cA }; }
    return best;
  };
  const bodyBound = (a: Ant, t: number, R: number) => { const tw = twistAt(a.tr, t); return Math.hypot(tw.v, tw.vl) + Math.abs(tw.w) * R; };
  const nextBreak = (a: Ant, t: number) => { const s = a.tr.segs[segIndexAt(a.tr, t)]; return t < s.t0 ? s.t0 : s.t1; };
  const bound = (a: Ant, g: Target, t: number) => {
    let M = bodyBound(a, t, a.Rb) + a.Vj;
    if (g.kind === 'body') M += bodyBound(g.ant, t, g.ant.d.h);
    if (g.kind === 'antenna') M += bodyBound(g.ant, t, g.ant.Rb) + g.ant.Vj;
    return M;
  };
  const nb = (a: Ant, g: Target, t: number) => Math.min(nextBreak(a, t), g.kind === 'static' ? Infinity : nextBreak(g.ant, t));

  // pairs (sorted, deterministic): antenna × static, antenna × other body, antenna × other antenna (each unordered pair once)
  type Pair = { a: Ant; side: Side; g: Target; key: string };
  const pairs: Pair[] = [];
  for (const a of ants) for (const side of SIDES) {
    if (input.targets.statics) for (const s of statics) if ((s.layer ?? '') === a.layer) pairs.push({ a, side, g: { kind: 'static', id: s.id, caps: staticCaps(s) }, key: `${a.id}:${side}|${s.id}` });
    for (const b of ants) {
      if (b.id === a.id || b.layer !== a.layer) continue;
      if (input.targets.bodies) pairs.push({ a, side, g: { kind: 'body', ant: b }, key: `${a.id}:${side}|${b.id}:body` });
      if (input.targets.antennae && a.id < b.id) for (const s2 of SIDES) pairs.push({ a, side, g: { kind: 'antenna', ant: b, side: s2 }, key: `${a.id}:${side}|${b.id}:${s2}` });
    }
  }
  // an antenna wholly inside a polygon at the start would never touch an edge: refused
  for (const a of ants) for (const side of SIDES) for (const s of statics) if (s.kind === 'polygon' && input.targets.statics && (s.layer ?? '') === a.layer) {
    const w = antennaInWorld(readPose(a.tr, T0), a.m, side, scanJoints(a.m, side, T0));
    if (pointInPolygon(w.tip, s.pts) && pointInPolygon(w.base, s.pts)) throw new AntennaRefused([`ANTENNA_INSIDE_POLYGON_AT_START:${a.id}:${side}:${s.id}`]);
  }

  const events: AntennaContactEvent[] = [], status: SolverStatus[] = [];
  const stats = { pairs: pairs.length, iterations: 0, max_iterations: 0 };
  let minGap = Infinity;
  const θ = CONTACT_TOL_MM, λ = CA_LEVEL_MM, ρ = SEP_RES_MM, OUT = θ + 2 * ρ;
  for (const p of pairs) {
    const gap = (t: number) => gapAt(p.a, p.side, p.g, t);
    const bisect = (lo: number, hi: number): [number, number] => {
      const below = (t: number) => gap(t).g <= θ, bl = below(lo);
      for (let k = 0; k < 200; k++) { const mid = lo + (hi - lo) / 2; if (!(mid > lo && mid < hi)) break; if (below(mid) === bl) lo = mid; else hi = mid; }
      return [lo, hi];
    };
    const emit = (phase: 'start' | 'end', br: [number, number], detail?: string) => {
      const q = gap(br[1]);
      const tgt: AntennaContactEvent['target'] = p.g.kind === 'static' ? { kind: 'static', id: p.g.id } : p.g.kind === 'body' ? { kind: 'body', id: p.g.ant.id } : { kind: 'antenna', id: p.g.ant.id, side: p.g.side, part: q.tpart };
      events.push({ t_s: br[1], kind: 'antenna_contact', phase, agent_id: p.a.id, side: p.side, part: q.part, target: tgt, bracket_s: br, gap_mm: q.g, point: q.p, param_mode: p.a.m.mode, recognition: null, ...(detail ? { detail } : {}) });
    };
    let t = T0, prev = T0, iters = 0, inContact = false, lastLe = T0;
    for (;;) {
      if (t > H) break;
      const g = gap(t).g;
      if (g < minGap) minGap = g;
      if (!inContact && g <= θ) { emit('start', t === T0 ? [T0, T0] : bisect(prev, t), t === T0 ? 'in contact at t0' : undefined); inContact = true; lastLe = t; }
      else if (inContact && g > θ + ρ) { emit('end', bisect(lastLe, t)); inContact = false; }
      else if (inContact && g <= θ) lastLe = t;
      if (t >= H) break; // the horizon is a processed instant: nothing after it is read
      const M = bound(p.a, p.g, t), brk = nb(p.a, p.g, t);
      prev = t;
      if (M === 0) { if (brk === Infinity) break; t = brk; continue; }
      // out of contact: never cross λ within a step; in contact: never cross θ + 2ρ within a step
      let tn = t + (inContact ? OUT - g : g - λ) / M;
      if (tn >= brk) tn = brk;
      if (!(tn > t) || ++iters > CA_MAX_ITER) { status.push({ t_s: t, kind: 'solver_status', ids: [p.key], detail: 'conservative advancement iteration limit: pair abandoned from here' }); break; }
      t = tn;
    }
    stats.iterations += iters; stats.max_iterations = Math.max(stats.max_iterations, iters);
  }
  const key = (e: AntennaContactEvent) => `${e.agent_id}:${e.side}|${e.target.kind}:${e.target.id}:${e.target.side ?? ''}`;
  events.sort((x, y) => x.t_s - y.t_s || (x.phase === y.phase ? 0 : x.phase === 'end' ? -1 : 1) || (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
  status.sort((x, y) => x.t_s - y.t_s || (x.ids[0] < y.ids[0] ? -1 : 1));
  return { events, status, max_time_read_s: maxRead, min_gap_at_iterates_mm: minGap, stats };
}
