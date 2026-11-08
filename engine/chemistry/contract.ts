/**
 * CHEM-0 (#131) — public contract of the chemical-ecology layer (docs/chemical-ecology-engine.md).
 *
 * Status: ISOLATED. Pure types plus small pure validators; no DOM / Node API, no randomness, no clock. The official
 * day loop (engine/*.ts top level), cli/ and web/src must not import engine/chemistry (tests/chemistry-isolation.test.ts).
 *
 * What this contract fixes (and what it does NOT):
 *  - three separate mechanisms: trail recruitment on an edge / surface, short-range alarm as local exposure events,
 *    CHC recognition by antennal contact only. They never share a field.
 *  - every channel states chemical_identity (null unless an identified molecule with direct evidence exists — none
 *    exists for the focal species), units (normalized activity is NOT a mass), evidence level A/B/C/D, assumption,
 *    spatial support, perception rule and time rule.
 *  - individuals read only a bounded local sample (radius or contact) on their own layer at the closed horizon.
 *  - deposits are visible only once the store's horizon has been closed past them (deposit-before-sense);
 *    same-instant visibility is decided by (t_s, round), never by array order.
 *  - it fixes no biological number. Every number in a channel is a candidate with provenance.
 */

export const CHEM_CONTRACT_VERSION = 'antempire.chem-contract.v1';

/** A = focal species, direct observation; B = other species / general insect knowledge; C = competing mathematical
 *  model; D = untested model assumption (docs/research-pheromone-models-2026-11.md). */
export type EvidenceLevel = 'A' | 'B' | 'C' | 'D';
export type Basis = '文獻支持' | '一般生理學' | '遊戲假設';
export type Mechanism = 'trail_recruitment' | 'short_range_alarm' | 'chc_recognition';
/** surface_edge: per edge, binned along its length (mm). sparse_2d: sparse cells on a plane (mm). point_exposure:
 *  short-lived local exposure events around a source (alarm, CHEM-4). contact: no field at all (CHC, CHEM-4). */
export type Backend = 'surface_edge' | 'sparse_2d' | 'point_exposure' | 'contact';
/** normalized_activity: dimensionless model quantity; positivity and audit only, NO chemical mass conservation claim.
 *  mass_ng / molecules: a true amount; then every sink (adsorption, volatilisation, degradation, wash-off) must be
 *  accounted for. No true-amount channel exists for the focal species (no chemical measurement). */
export type QuantityUnit = 'normalized_activity' | 'mass_ng' | 'molecules';
export const TRUE_AMOUNT_UNITS: readonly QuantityUnit[] = ['mass_ng', 'molecules'];

/** Provenance of one number. A value without evidence stays null (CLAUDE.md §3). */
export interface ParamProvenance {
  value: number | null;
  assumption: boolean;
  basis: Basis;
  evidence_level: EvidenceLevel;
  /** reference ids (docs/references.md) or [] */
  sources: string[];
  /** e.g. 'synthetic candidate, not a species concentration' */
  note: string;
}

export interface ChemicalIdentity {
  /** e.g. a compound name; must come with a direct (A) chemical identification for this species */
  compound: string;
  evidence_level: EvidenceLevel;
  sources: string[];
}

export interface SignalUnits { quantity: QuantityUnit; length: 'mm'; time: 's' }

export type SpatialSupport =
  | { kind: 'surface_edge'; bin_mm: number }
  | { kind: 'sparse_2d'; cell_mm: number; isotropic_diffusion: false }
  | { kind: 'point_exposure'; max_radius_mm: number | null }
  | { kind: 'contact' };

export interface PerceptionRule {
  /** on_support: along the edge the agent stands on; bounded_radius: 2D disc; antennal_contact: only a PH-3b contact */
  mode: 'on_support' | 'bounded_radius' | 'antennal_contact';
  /** hard upper bound of a sample radius (mm); null only for antennal_contact */
  max_radius_mm: number | null;
  /** CHC: optional near-contact gap (Gellert 2022 says "contact- or near contact"); null = contact only */
  near_contact_mm: number | null;
  /** always true: a sensor never reads another layer */
  same_layer_only: true;
  /** detection threshold of the sensor, a candidate (no dose-response data for the focal species) */
  threshold: ParamProvenance;
}

export interface TimeRule {
  /** CHEM-1: analytic C(t) = C(t0)·exp(-λ (t - t0)); 'none' for contact (no field) */
  kind: 'analytic_exponential' | 'none';
  unit: 's';
  /** λ in 1/s; λ = 0 is the mandatory baseline */
  lambda_per_s: ParamProvenance | null;
  /** deposit at (t, r) is visible to a sample at (t', r') iff (t, r) <= (t', r') AND the horizon has been closed to (t', r') */
  same_instant: 'visible_if_round_not_later';
}

export interface ChannelSpec {
  signal_id: string;
  mechanism: Mechanism;
  /** 'M1' single signal, 'M2' dual signal, 'lambda0' baseline flag lives in time_rule; candidates for alarm / CHC */
  model_variant: 'M1' | 'M2' | 'alarm_candidate' | 'chc_contact_candidate' | 'synthetic';
  /** for M2: 'E' (exploration) or 'F' (foraging); otherwise null */
  variant_role: 'E' | 'F' | null;
  chemical_identity: ChemicalIdentity | null;
  units: SignalUnits;
  backend: Backend;
  spatial_support: SpatialSupport;
  perception_rule: PerceptionRule;
  time_rule: TimeRule;
  evidence_level: EvidenceLevel;
  assumption: boolean;
  sources: string[];
  note: string;
}

/** Time on a named chemistry clock in seconds. Mapping to the layered world time (P0-A0/P0-A1): the clock is anchored
 *  at a world time, and engine/clock physicsNative(clock, anchor, t_s) -> exactOf gives the exact instant. */
export interface ChemTime { clock: string; unit: 's'; t_s: number; round: number }
export interface ChemClock { name: string; anchor: { day: number; minute: number } }

export type Where =
  | { kind: 'edge_point'; edge_id: string; s_mm: number }
  | { kind: 'edge_segment'; edge_id: string; s0_mm: number; s1_mm: number }
  | { kind: 'point2d'; x_mm: number; y_mm: number }
  | { kind: 'segment2d'; x0_mm: number; y0_mm: number; x1_mm: number; y1_mm: number };

export interface DepositEvent {
  /** unique id of this deposit */
  deposit_id: string;
  signal_id: string;
  /** agent that deposits (a worker id, or a synthetic agent id) */
  origin_agent: string;
  /** = origin_agent for a real worker; null for a synthetic agent */
  source_worker_id: string | null;
  /** upstream event the deposit derives from (PH-3b segment / activity event); one deposit per (signal, origin_agent, origin_event_id) */
  origin_event_id: string;
  time: ChemTime;
  layer: string;
  substrate: string | null;
  where: Where;
  amount: number;
  /** free label of the cause (e.g. 'laden_return'); never a colony-level quantity */
  cause: string;
  units: SignalUnits;
}

export type Sensor =
  | { kind: 'edge'; edge_id: string; s_mm: number; radius_mm: number }
  | { kind: 'disc'; x_mm: number; y_mm: number; radius_mm: number };

export interface SampleQuery { signal_id: string; agent_id: string; layer: string; time: ChemTime; sensor: Sensor }

export interface EdgeDomain { backend: 'surface_edge'; edges: { id: string; length_mm: number; layer: string }[] }
export interface PlaneDomain { backend: 'sparse_2d'; bounds_mm: { x0: number; y0: number; x1: number; y1: number }; layers: string[] }
export type Domain = EdgeDomain | PlaneDomain;

/** Existing official parameters (species/pheidole-megacephala.json, recruitment.*): game assumptions of the daily,
 *  dimensionless single-signal model. They are NOT concentrations, NOT half-lives and must not be relabelled. */
export const LEGACY_TRAIL_PARAMS = {
  trail_daily_retention: { quantity: 'dimensionless daily retention factor', is_concentration: false, basis: '遊戲假設' },
  trail_deposit_per_success: { quantity: 'normalized activity per delivery', is_concentration: false, basis: '遊戲假設' },
  trail_min_detectable: { quantity: 'normalized activity threshold', is_concentration: false, basis: '遊戲假設' },
  trail_max_strength: { quantity: 'normalized activity cap', is_concentration: false, basis: '遊戲假設' },
} as const;

// ---------------------------------------------------------------- validators (pure; return error codes, [] = valid)

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const LEVELS = new Set(['A', 'B', 'C', 'D']);
const BASES = new Set(['文獻支持', '一般生理學', '遊戲假設']);

export function validateProvenance(p: ParamProvenance | null | undefined, what: string): string[] {
  if (!p) return [`MISSING_PROVENANCE:${what}`];
  const e: string[] = [];
  if (!(p.value === null || finite(p.value))) e.push(`BAD_VALUE:${what}`);
  if (typeof p.assumption !== 'boolean') e.push(`MISSING_ASSUMPTION:${what}`);
  if (!BASES.has(p.basis)) e.push(`BAD_BASIS:${what}`);
  if (!LEVELS.has(p.evidence_level)) e.push(`BAD_EVIDENCE_LEVEL:${what}`);
  if (!Array.isArray(p.sources)) e.push(`MISSING_SOURCES:${what}`);
  if (typeof p.note !== 'string') e.push(`MISSING_NOTE:${what}`);
  // a number is "not an assumption" only with direct species evidence and a source
  if (p.assumption === false && !(p.evidence_level === 'A' && p.sources.length > 0 && p.basis === '文獻支持')) e.push(`UNSUPPORTED_NON_ASSUMPTION:${what}`);
  if (p.evidence_level !== 'D' && p.sources.length === 0) e.push(`EVIDENCE_WITHOUT_SOURCE:${what}`);
  return e;
}

export function validateChannel(c: ChannelSpec): string[] {
  const e: string[] = [];
  if (!nonEmpty(c.signal_id)) e.push('MISSING:signal_id');
  if (!['trail_recruitment', 'short_range_alarm', 'chc_recognition'].includes(c.mechanism)) e.push('BAD:mechanism');
  if (!LEVELS.has(c.evidence_level)) e.push('BAD_EVIDENCE_LEVEL:channel');
  if (typeof c.assumption !== 'boolean') e.push('MISSING_ASSUMPTION:channel');
  if (!Array.isArray(c.sources)) e.push('MISSING_SOURCES:channel');
  if (c.chemical_identity === undefined) e.push('MISSING:chemical_identity');
  else if (c.chemical_identity !== null && !(c.chemical_identity.evidence_level === 'A' && c.chemical_identity.sources.length > 0)) e.push('IDENTITY_WITHOUT_EVIDENCE');
  if (!c.units || c.units.length !== 'mm' || c.units.time !== 's') e.push('BAD_UNITS:length_or_time');
  if (c.units && !['normalized_activity', 'mass_ng', 'molecules'].includes(c.units.quantity)) e.push('BAD_UNITS:quantity');
  // a true amount needs a measured identity: without a chemical, "ng" would be a made-up mass
  if (c.units && TRUE_AMOUNT_UNITS.includes(c.units.quantity) && c.chemical_identity === null) e.push('TRUE_AMOUNT_WITHOUT_IDENTITY');
  if (c.model_variant === 'M2' && c.variant_role === null) e.push('M2_WITHOUT_ROLE');
  if (c.model_variant !== 'M2' && c.variant_role !== null) e.push('ROLE_WITHOUT_M2');
  // mechanism <-> backend <-> perception are tied: the three mechanisms are never merged
  const want: Record<Mechanism, Backend[]> = { trail_recruitment: ['surface_edge', 'sparse_2d'], short_range_alarm: ['point_exposure'], chc_recognition: ['contact'] };
  if (want[c.mechanism] && !want[c.mechanism].includes(c.backend)) e.push(`MECHANISM_BACKEND_MISMATCH:${c.mechanism}/${c.backend}`);
  if (!c.spatial_support || c.spatial_support.kind !== c.backend) e.push('SUPPORT_BACKEND_MISMATCH');
  else if (c.spatial_support.kind === 'surface_edge' && !(finite(c.spatial_support.bin_mm) && c.spatial_support.bin_mm > 0)) e.push('BAD:bin_mm');
  else if (c.spatial_support.kind === 'sparse_2d' && (!(finite(c.spatial_support.cell_mm) && c.spatial_support.cell_mm > 0) || c.spatial_support.isotropic_diffusion !== false)) e.push('BAD:sparse_2d_support');
  const p = c.perception_rule;
  if (!p) e.push('MISSING:perception_rule');
  else {
    if (p.same_layer_only !== true) e.push('CROSS_LAYER_PERCEPTION');
    if (c.mechanism === 'chc_recognition') {
      if (p.mode !== 'antennal_contact') e.push('CHC_NOT_CONTACT');
      if (p.max_radius_mm !== null) e.push('CHC_WITH_RADIUS');
      if (p.near_contact_mm !== null && !(finite(p.near_contact_mm) && p.near_contact_mm >= 0 && p.near_contact_mm <= 1)) e.push('CHC_NEAR_CONTACT_TOO_FAR');
    } else {
      if (p.mode === 'antennal_contact') e.push('CONTACT_MODE_FOR_FIELD');
      if (!(finite(p.max_radius_mm) && p.max_radius_mm > 0)) e.push('UNBOUNDED_RADIUS');
      if (c.backend === 'surface_edge' && p.mode !== 'on_support') e.push('EDGE_NEEDS_ON_SUPPORT');
      if (c.backend !== 'surface_edge' && p.mode === 'on_support') e.push('ON_SUPPORT_OFF_EDGE');
    }
    e.push(...validateProvenance(p.threshold, 'threshold'));
  }
  const t = c.time_rule;
  if (!t) e.push('MISSING:time_rule');
  else {
    if (t.unit !== 's') e.push('BAD_UNITS:time_rule');
    if (t.same_instant !== 'visible_if_round_not_later') e.push('BAD:same_instant');
    if (c.backend === 'contact') { if (t.kind !== 'none') e.push('CONTACT_WITH_DECAY'); }
    else if (t.kind !== 'analytic_exponential') e.push('BAD:time_rule_kind');
    else {
      e.push(...validateProvenance(t.lambda_per_s, 'lambda_per_s'));
      const l = t.lambda_per_s?.value;
      if (!(finite(l) && l >= 0)) e.push('BAD:lambda_per_s');
    }
  }
  return e;
}

export function validateTime(t: ChemTime | undefined, clock: ChemClock): string[] {
  if (!t) return ['MISSING:time'];
  const e: string[] = [];
  if (t.unit !== 's') e.push('BAD_UNITS:time');
  if (t.clock !== clock.name) e.push('WRONG_CLOCK');
  if (!(finite(t.t_s) && t.t_s >= 0)) e.push('BAD:t_s');
  if (!(Number.isSafeInteger(t.round) && t.round >= 0)) e.push('BAD:round');
  return e;
}

const whereLength = (w: Where): number => w.kind === 'edge_segment' ? Math.abs(w.s1_mm - w.s0_mm) : w.kind === 'segment2d' ? Math.hypot(w.x1_mm - w.x0_mm, w.y1_mm - w.y0_mm) : 0;
export { whereLength };

/** Structural check of one deposit against its channel and the domain (no store state: duplicates and the horizon
 *  are checked by the store). */
export function validateDeposit(d: DepositEvent, c: ChannelSpec, clock: ChemClock, domain: Domain): string[] {
  const e: string[] = [];
  for (const k of ['deposit_id', 'signal_id', 'origin_agent', 'origin_event_id', 'layer', 'cause'] as const) if (!nonEmpty(d[k])) e.push(`MISSING_PROVENANCE:${k}`);
  if (d.source_worker_id !== null && d.source_worker_id !== d.origin_agent) e.push('SOURCE_WORKER_MISMATCH');
  if (d.signal_id !== c.signal_id) e.push('WRONG_CHANNEL');
  if (c.backend === 'contact' || c.backend === 'point_exposure') e.push('NOT_A_FIELD_CHANNEL');
  if (!d.units || d.units.length !== 'mm' || d.units.time !== 's') e.push('BAD_UNITS:length_or_time');
  else if (d.units.quantity !== c.units.quantity) e.push('BAD_UNITS:quantity');
  e.push(...validateTime(d.time, clock));
  if (!(finite(d.amount) && d.amount > 0)) e.push('BAD:amount');
  const w = d.where;
  if (!w) { e.push('MISSING:where'); return e; }
  if (domain.backend !== c.backend) e.push('DOMAIN_BACKEND_MISMATCH');
  if (domain.backend === 'surface_edge') {
    if (w.kind !== 'edge_point' && w.kind !== 'edge_segment') { e.push('WHERE_KIND_MISMATCH'); return e; }
    const edge = domain.edges.find((x) => x.id === w.edge_id);
    if (!edge) { e.push('OUT_OF_BOUNDS:edge'); return e; }
    if (edge.layer !== d.layer) e.push('CROSS_LAYER_DEPOSIT');
    const ss = w.kind === 'edge_point' ? [w.s_mm] : [w.s0_mm, w.s1_mm];
    if (!ss.every(finite)) e.push('BAD:s_mm');
    else if (ss.some((s) => s < 0 || s > edge.length_mm)) e.push('OUT_OF_BOUNDS:s_mm');
    if (w.kind === 'edge_segment' && w.s0_mm === w.s1_mm) e.push('EMPTY_SEGMENT');
  } else {
    if (w.kind !== 'point2d' && w.kind !== 'segment2d') { e.push('WHERE_KIND_MISMATCH'); return e; }
    if (!domain.layers.includes(d.layer)) e.push('CROSS_LAYER_DEPOSIT');
    const b = domain.bounds_mm, pts = w.kind === 'point2d' ? [[w.x_mm, w.y_mm]] : [[w.x0_mm, w.y0_mm], [w.x1_mm, w.y1_mm]];
    if (!pts.flat().every(finite)) e.push('BAD:xy_mm');
    else if (pts.some(([x, y]) => x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1)) e.push('OUT_OF_BOUNDS:xy_mm');
    if (w.kind === 'segment2d' && whereLength(w) === 0) e.push('EMPTY_SEGMENT');
  }
  return e;
}

/** A sample is local by construction: a position, the agent's own layer, a finite radius no larger than the channel's
 *  bound. There is no query form that reads the whole field (that is the observer snapshot, never an agent input). */
export function validateSampleQuery(q: SampleQuery, c: ChannelSpec, clock: ChemClock): string[] {
  const e: string[] = [];
  if (!nonEmpty(q.agent_id)) e.push('MISSING:agent_id');
  if (q.signal_id !== c.signal_id) e.push('WRONG_CHANNEL');
  if (!nonEmpty(q.layer)) e.push('MISSING:layer');
  e.push(...validateTime(q.time, clock));
  const s = q.sensor, max = c.perception_rule.max_radius_mm;
  if (!s) { e.push('MISSING:sensor'); return e; }
  if (!(finite(s.radius_mm) && s.radius_mm >= 0)) e.push('UNBOUNDED_RADIUS');
  else if (max === null || s.radius_mm > max) e.push('RADIUS_ABOVE_BOUND');
  if (c.backend === 'surface_edge' && s.kind !== 'edge') e.push('SENSOR_KIND_MISMATCH');
  if (c.backend === 'sparse_2d' && s.kind !== 'disc') e.push('SENSOR_KIND_MISMATCH');
  if (c.backend === 'contact' || c.backend === 'point_exposure') e.push('NOT_A_FIELD_CHANNEL');
  if (s.kind === 'edge' && !finite(s.s_mm)) e.push('BAD:s_mm');
  if (s.kind === 'disc' && !(finite(s.x_mm) && finite(s.y_mm))) e.push('BAD:xy_mm');
  return e;
}

/** lexicographic order of (t_s, round): the only same-instant order the contract uses */
export const compareChemTime = (a: ChemTime, b: ChemTime): number => a.t_s - b.t_s || a.round - b.round;
