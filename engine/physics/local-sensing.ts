/**
 * LOCAL CHEMICAL SENSING CONTRACT (KIN-2D follow-up; docs/kin2d-local-sensing.md). ISOLATED: not imported by the official
 * pipeline (tests/physics-isolation.test.ts). A replaceable, LOCAL sampling interface between a walking controller and a
 * chemical field:
 *  - the request names the agent, the simulation time, the sensor points (antenna tips DERIVED from the agent's actual
 *    body pose and a declared antenna geometry; the contract recomputes and rejects any other point), the spatial layer,
 *    the signal channel, a bounded sensing range, the declared source and the assumption tags;
 *  - no whole-field read exists: implementations keep the field private and expose only sample();
 *  - no future read: t_s must be ≤ the time through which the source has committed its deposits;
 *  - no silent fallback: the request must name the source of the sampler it is sent to; a missing signal is an error
 *    (SensingRefused 'MISSING_SIGNAL'), never replaced by another source;
 *  - every result carries its source, so experiment output records where each value came from.
 * Implementations: SyntheticChemicalField (tests and replayable synthetic experiments; labelled synthetic) and
 * ChemLocalFieldAdapter (DECLARATION ONLY: maps the request onto the CHEM-1 sampleLocal query names; CHEM is not
 * integrated — CHEM-0/1 are under review — and nothing here constructs a CHEM store).
 * Pure and deterministic; no platform APIs.
 */

export class SensingRefused extends Error {
  readonly codes: string[];
  constructor(codes: string[]) { super(`SENSING_REFUSED: ${codes.join(', ')}`); this.name = 'SensingRefused'; this.codes = codes; }
}

export type SensingSource = 'synthetic' | 'chem_local_field';
export type Basis = '文獻支持' | '一般生理學' | '遊戲假設';
export interface AssumptionTag { name: string; assumption: boolean; basis: Basis; note: string }
export interface XYPose { x: number; y: number; th: number }
/** antenna geometry used for sensing: tips at the head front (body centre + L/2 along the heading), each antenna of
 *  length antenna_len_mm at ±half_angle from the body axis. Values are scenario inputs (game assumptions). */
export interface AntennaGeometry { body_length_mm: number; antenna_len_mm: number; antenna_half_angle_rad: number }
export interface SensorPoint { id: 'antenna_left' | 'antenna_right'; x_mm: number; y_mm: number }
export interface LocalSampleRequest {
  agent_id: string;
  /** simulation time (s) and same-instant round (CHEM ChemTime.round; 0 for the synthetic field) */
  t_s: number; round: number;
  /** the agent's actual body pose at t_s and its antenna geometry: the sensor points must be derived from these */
  pose: XYPose; geometry: AntennaGeometry;
  sensors: SensorPoint[];
  layer: string; channel: string;
  /** sensing radius around each sensor point (mm); 0 = point sample; bounded by the sampler's max_range_mm */
  range_mm: number;
  /** the source the caller expects; must equal the sampler's source (no silent swap) */
  source: SensingSource;
  tags: AssumptionTag[];
}
export interface SensedValue { sensor: SensorPoint['id']; x_mm: number; y_mm: number; value: number; detectable: boolean | null }
export interface LocalSampleResult { view: 'agent_local'; agent_id: string; t_s: number; round: number; layer: string; channel: string; source: SensingSource; synthetic: boolean; values: SensedValue[] }
export interface LocalChemSampler {
  readonly source: SensingSource;
  readonly synthetic: boolean;
  readonly id: string;
  readonly max_range_mm: number;
  /** time (s, round) through which deposits are committed on this channel and layer; null = nothing committed */
  committedThrough(channel: string, layer: string): { t_s: number; round: number } | null;
  /** raw local read; called ONLY through sampleLocal() below, which enforces the contract */
  read(req: LocalSampleRequest): SensedValue[] | null;
}

/** antenna tips from the body pose (the expression the natural-walk controller has always used) */
export function antennaTipPoints(pose: XYPose, g: AntennaGeometry): { left: { x: number; y: number }; right: { x: number; y: number } } {
  const L = g.body_length_mm, hx = pose.x + Math.cos(pose.th) * (L / 2), hy = pose.y + Math.sin(pose.th) * (L / 2);
  const tip = (s: number) => ({ x: hx + Math.cos(pose.th + s * g.antenna_half_angle_rad) * g.antenna_len_mm, y: hy + Math.sin(pose.th + s * g.antenna_half_angle_rad) * g.antenna_len_mm });
  return { left: tip(1), right: tip(-1) };
}
export function antennaSensors(pose: XYPose, g: AntennaGeometry): SensorPoint[] {
  const t = antennaTipPoints(pose, g);
  return [{ id: 'antenna_left', x_mm: t.left.x, y_mm: t.left.y }, { id: 'antenna_right', x_mm: t.right.x, y_mm: t.right.y }];
}

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const str = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const BASES = new Set(['文獻支持', '一般生理學', '遊戲假設']);

/** structural validation of a request (pure; [] = valid) */
export function validateRequest(q: LocalSampleRequest): string[] {
  const e: string[] = [];
  if (!q || typeof q !== 'object') return ['MISSING:request'];
  if (!str(q.agent_id)) e.push('MISSING:agent_id');
  if (!fin(q.t_s)) e.push('MISSING:t_s');
  if (!(Number.isInteger(q.round) && q.round >= 0)) e.push('MISSING:round');
  if (!str(q.layer)) e.push('MISSING:layer');
  if (!str(q.channel)) e.push('MISSING:channel');
  if (q.source !== 'synthetic' && q.source !== 'chem_local_field') e.push('MISSING:source');
  if (!(fin(q.range_mm) && q.range_mm >= 0)) e.push('UNBOUNDED_RANGE');
  if (!Array.isArray(q.tags) || q.tags.length === 0 || !q.tags.every((t) => str(t?.name) && typeof t.assumption === 'boolean' && BASES.has(t.basis) && typeof t.note === 'string')) e.push('MISSING:assumption_tags');
  const g = q.geometry, p = q.pose;
  if (!g || !(fin(g.body_length_mm) && g.body_length_mm > 0 && fin(g.antenna_len_mm) && g.antenna_len_mm > 0 && fin(g.antenna_half_angle_rad) && g.antenna_half_angle_rad >= 0)) e.push('MISSING:antenna_geometry');
  if (!p || !(fin(p.x) && fin(p.y) && fin(p.th))) e.push('MISSING:pose');
  if (!Array.isArray(q.sensors) || q.sensors.length === 0) e.push('MISSING:sensors');
  else if (!e.includes('MISSING:antenna_geometry') && !e.includes('MISSING:pose')) {
    // sensors must be exactly the antenna tips of the actual pose (no arbitrary or remote points)
    const want = antennaSensors(p, g);
    for (const s of q.sensors) { const w = want.find((x) => x.id === s?.id); if (!w || w.x_mm !== s.x_mm || w.y_mm !== s.y_mm) e.push(`SENSOR_NOT_FROM_POSE:${s?.id}`); }
  }
  return e;
}

/** THE sampling entry point: validates the contract, then reads locally from the given sampler */
export function sampleLocal(sampler: LocalChemSampler, q: LocalSampleRequest): LocalSampleResult {
  const e = validateRequest(q);
  if (!e.length) {
    if (q.source !== sampler.source) e.push(`SOURCE_MISMATCH:${q.source}->${sampler.source}`);
    if (q.range_mm > sampler.max_range_mm) e.push('RANGE_ABOVE_BOUND');
    const c = sampler.committedThrough(q.channel, q.layer);
    if (c === null) e.push('MISSING_SIGNAL:nothing_committed');
    else if (q.t_s > c.t_s || (q.t_s === c.t_s && q.round > c.round)) e.push('FUTURE_SAMPLE');
  }
  if (e.length) throw new SensingRefused(e);
  const values = sampler.read(q);
  if (values === null || values.length !== q.sensors.length || values.some((v, i) => v.sensor !== q.sensors[i].id || !fin(v.value))) throw new SensingRefused([`MISSING_SIGNAL:${sampler.id}`]);
  return { view: 'agent_local', agent_id: q.agent_id, t_s: q.t_s, round: q.round, layer: q.layer, channel: q.channel, source: sampler.source, synthetic: sampler.synthetic, values };
}

// ---------------------------------------------------------------- SyntheticChemicalField
/** SYNTHETIC field: Gaussian ridge around a polyline (no diffusion, no decay; NOT a pheromone model) */
export interface SyntheticRidge { synthetic: true; kind: 'gaussian_ridge'; polyline: { x: number; y: number }[]; sigma_mm: number; peak: number }
/** ridge value at a point (the expression the natural-walk controller has always used) */
export function ridgeValue(f: SyntheticRidge, p: { x: number; y: number }): number {
  let d = Infinity;
  for (let i = 0; i + 1 < f.polyline.length; i++) {
    const a = f.polyline[i], b = f.polyline[i + 1], dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    const u = L2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    d = Math.min(d, Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy));
  }
  return f.peak * Math.exp(-(d * d) / (2 * f.sigma_mm * f.sigma_mm));
}
export interface SyntheticFieldConfig { id: string; channel: string; layer: string; field: SyntheticRidge; committed_through_s: number; max_range_mm: number }
/** point-sampled synthetic ridge on one channel and layer, declared committed through committed_through_s */
export class SyntheticChemicalField implements LocalChemSampler {
  readonly source = 'synthetic' as const;
  readonly synthetic = true;
  readonly id: string;
  readonly max_range_mm: number;
  readonly #cfg: SyntheticFieldConfig;
  constructor(cfg: SyntheticFieldConfig) {
    if (!(cfg.field && cfg.field.synthetic === true && fin(cfg.field.sigma_mm) && cfg.field.sigma_mm > 0 && fin(cfg.field.peak))) throw new SensingRefused(['BAD:synthetic_field']);
    if (!(fin(cfg.max_range_mm) && cfg.max_range_mm >= 0) || !(typeof cfg.committed_through_s === 'number' && !Number.isNaN(cfg.committed_through_s))) throw new SensingRefused(['BAD:synthetic_config']);
    this.#cfg = { ...cfg, field: { ...cfg.field, polyline: cfg.field.polyline.map((p) => ({ ...p })) } }; this.id = cfg.id; this.max_range_mm = cfg.max_range_mm;
  }
  committedThrough(channel: string, layer: string): { t_s: number; round: number } | null {
    return channel === this.#cfg.channel && layer === this.#cfg.layer ? { t_s: this.#cfg.committed_through_s, round: Number.MAX_SAFE_INTEGER } : null;
  }
  /** point value at each sensor (range 0); a positive range is refused by the bound (max_range_mm = 0) */
  read(q: LocalSampleRequest): SensedValue[] {
    return q.sensors.map((s) => ({ sensor: s.id, x_mm: s.x_mm, y_mm: s.y_mm, value: ridgeValue(this.#cfg.field, { x: s.x_mm, y: s.y_mm }), detectable: null }));
  }
}

// ---------------------------------------------------------------- CHEM LocalField adapter (declaration; NOT integrated)
/** structural mirror of the CHEM-1 query/result names (engine/chemistry/contract.ts on the CHEM-1 branch: SampleQuery,
 *  ChemTime, Sensor 'disc', SampleResult). Declared here so this module does not import an unmerged module. */
export interface ChemTimeLike { clock: string; unit: 's'; t_s: number; round: number }
export interface ChemSampleQueryLike { signal_id: string; agent_id: string; layer: string; time: ChemTimeLike; phase: 'local_sensing'; sensor: { kind: 'disc'; x_mm: number; y_mm: number; radius_mm: number } }
export interface ChemSampleResultLike { view: 'agent_local'; exposure: number; detectable: boolean | null }
/** CHEM-1 ChemStore exposes `get horizon(): ChemTime | null` and `sampleLocal(q)`; it refuses any read not exactly at its
 *  closed horizon (FUTURE_SAMPLE / STALE_SAMPLE), which this adapter surfaces as MISSING_SIGNAL errors. */
export interface ChemStoreLike { sampleLocal(q: ChemSampleQueryLike): ChemSampleResultLike; readonly horizon: ChemTimeLike | null }
/** maps a contract request onto CHEM sampleLocal queries (one disc per sensor point). Every CHEM refusal (FUTURE_SAMPLE,
 *  CROSS_LAYER_SAMPLE, OUT_OF_BOUNDS, unknown channel …) becomes MISSING_SIGNAL: there is no fallback to any other source. */
export class ChemLocalFieldAdapter implements LocalChemSampler {
  readonly source = 'chem_local_field' as const;
  readonly synthetic = false;
  /** CHEM-0/1 are under review; this adapter is a declared seam, not wired into any run */
  static readonly integrated = false;
  readonly id: string;
  readonly max_range_mm: number;
  readonly #store: ChemStoreLike; readonly #clock: string; readonly #channels: Set<string>;
  constructor(id: string, store: ChemStoreLike, clock: string, channels: string[], max_range_mm: number) { this.id = id; this.max_range_mm = max_range_mm; this.#store = store; this.#clock = clock; this.#channels = new Set(channels); }
  committedThrough(channel: string): { t_s: number; round: number } | null { const h = this.#store.horizon; return this.#channels.has(channel) && h ? { t_s: h.t_s, round: h.round } : null; }
  read(q: LocalSampleRequest): SensedValue[] | null {
    try {
      return q.sensors.map((s) => {
        const r = this.#store.sampleLocal({ signal_id: q.channel, agent_id: q.agent_id, layer: q.layer, time: { clock: this.#clock, unit: 's', t_s: q.t_s, round: q.round }, phase: 'local_sensing', sensor: { kind: 'disc', x_mm: s.x_mm, y_mm: s.y_mm, radius_mm: q.range_mm } });
        return { sensor: s.id, x_mm: s.x_mm, y_mm: s.y_mm, value: r.exposure, detectable: r.detectable };
      });
    } catch (err) {
      // surfaced as an error with CHEM's own codes; never replaced by another source
      const codes = (err as { codes?: unknown }).codes;
      throw new SensingRefused([`MISSING_SIGNAL:${this.id}`, ...(Array.isArray(codes) ? codes.map(String) : [String((err as Error)?.message ?? err)])]);
    }
  }
}
