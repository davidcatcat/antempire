/**
 * LOCAL CHEMICAL SENSING CONTRACT (KIN-2D follow-up; docs/kin2d-local-sensing.md). ISOLATED: not imported by the official
 * pipeline (tests/physics-isolation.test.ts). A replaceable, LOCAL sampling interface between a walking controller and a
 * chemical field:
 *  - the request names the agent, the SENSING time, the sensor points (antenna tips DERIVED from the agent's actual
 *    body pose and a declared antenna geometry; the contract recomputes and rejects any other point), the spatial layer,
 *    the signal channel, a bounded sensing range, the declared source and the assumption tags;
 *  - no whole-field read exists: implementations keep the field private and expose only local reads;
 *  - UNIFIED CAUSAL READ CONTRACT (Owner decision 43), names aligned with CHEM-1b (engine/chemistry/core.ts on branch
 *    claude/ant-empire-engine-refactor-i45q93-chem1b-sampling, commit aba070a):
 *      * sampleLocal(reader, request) is the ONLY real-time entry point. It reads the LATEST committed state, and the
 *        sensing time must equal that state's commit time: FUTURE_SAMPLE if the sensing instant is not yet committed,
 *        STALE_SAMPLE once a later state exists. Result: read_kind 'realtime_latest_committed', with sensing_time and
 *        state_commit {seq, time} recorded separately. Decision code holds only a RealtimeSensingReader (latestCommitted
 *        + local read; no history, no commit/advance), mirroring CHEM-1b ChemRealtimeReader.
 *      * sampleHistorical(source, capability, query) is a separate DIAGNOSTIC entry point (replay / diagnosis /
 *        reconstruction). It needs an unforgeable DiagnosticCapability (createDiagnosticCapability), the query has no
 *        agent (it is not a sensing act), and the result has view 'diagnostic_history' / decision_use 'forbidden';
 *        assertRealtime() — called on every decision path — refuses it.
 *      * committing a state (advance) is a SCHEDULER capability, never given to the sensing agent.
 *  - no silent fallback: the request must name the source of the reader it is sent to; a missing signal is an error
 *    (SensingRefused 'MISSING_SIGNAL'), never replaced by another source;
 *  - every result carries its source, so experiment output records where each value came from.
 * Implementations: SyntheticChemicalField (tests and replayable synthetic experiments; labelled synthetic; a static
 * Gaussian ridge or an explicit ZERO-signal control field; its scheduler commits states with advance()) and
 * ChemLocalFieldAdapter (DECLARATION ONLY: maps the request onto the CHEM-1b ChemRealtimeReader names; CHEM is not
 * integrated and nothing here constructs a CHEM store).
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
/** a point on the simulation clock: seconds and same-instant round (= CHEM ChemTime without clock/unit) */
export interface SimTime { t_s: number; round: number }
/** one committed state: the instant whose commit produced it and a monotone commit sequence number (= CHEM ChemCommit) */
export interface StateCommit { seq: number; time: SimTime }
export interface LocalSampleRequest {
  agent_id: string;
  /** SENSING time (s) and same-instant round (CHEM ChemTime.round; 0 for the synthetic field) */
  t_s: number; round: number;
  /** the agent's actual body pose at t_s and its antenna geometry: the sensor points must be derived from these */
  pose: XYPose; geometry: AntennaGeometry;
  sensors: SensorPoint[];
  layer: string; channel: string;
  /** sensing radius around each sensor point (mm); 0 = point sample; bounded by the reader's max_range_mm */
  range_mm: number;
  /** the source the caller expects; must equal the reader's source (no silent swap) */
  source: SensingSource;
  tags: AssumptionTag[];
}
export interface SensedValue { sensor: SensorPoint['id']; x_mm: number; y_mm: number; value: number; detectable: boolean | null }
/** REAL-TIME result (= CHEM-1b SampleResult names): the only result type a decision path accepts (assertRealtime) */
export interface LocalSampleResult {
  view: 'agent_local'; read_kind: 'realtime_latest_committed'; agent_id: string;
  /** = sensing_time (kept for compatibility) */
  t_s: number; round: number;
  sensing_time: SimTime;
  /** the committed state that was read: always the latest commit; its time equals sensing_time */
  state_commit: StateCommit;
  layer: string; channel: string; source: SensingSource; synthetic: boolean; values: SensedValue[];
}
/** what real-time decision code holds (= CHEM-1b ChemRealtimeReader): the latest commit and a local read, nothing else */
export interface RealtimeSensingReader {
  readonly kind: 'realtime_sensing_reader';
  readonly source: SensingSource;
  readonly synthetic: boolean;
  readonly id: string;
  readonly max_range_mm: number;
  /** the LATEST committed state of this channel and layer; null = nothing committed */
  latestCommitted(channel: string, layer: string): StateCommit | null;
  /** raw local read of the latest committed state; called ONLY through sampleLocal(), which enforces the contract */
  read(req: LocalSampleRequest, state: StateCommit): SensedValue[] | null;
}
/** backward-compatible name for the real-time reader */
export type LocalChemSampler = RealtimeSensingReader;

// ---------------------------------------------------------------- diagnostic history (separate API)
export type DiagnosticPurpose = 'replay' | 'diagnosis' | 'reconstruction';
declare const DIAGNOSTIC_BRAND: unique symbol;
/** unforgeable token for historical reads (= CHEM-1b ChemDiagnosticCapability): only createDiagnosticCapability() makes
 *  one (checked at run time by identity); real-time decision code never receives it */
export interface DiagnosticCapability { readonly kind: 'sensing_diagnostic'; readonly purpose: DiagnosticPurpose; readonly [DIAGNOSTIC_BRAND]: true }
const DIAGNOSTIC_CAPS = new WeakSet<object>();
export function createDiagnosticCapability(purpose: DiagnosticPurpose): DiagnosticCapability {
  if (purpose !== 'replay' && purpose !== 'diagnosis' && purpose !== 'reconstruction') throw new SensingRefused(['BAD:diagnostic_purpose']);
  const cap = Object.freeze({ kind: 'sensing_diagnostic', purpose }) as DiagnosticCapability;
  DIAGNOSTIC_CAPS.add(cap);
  return cap;
}
/** historical query (= CHEM-1b HistoricalSampleQuery): no agent and no pose — it is not a sensing act */
export interface HistoricalSampleQuery { channel: string; layer: string; at: SimTime; points: { id: string; x_mm: number; y_mm: number }[]; range_mm: number; source: SensingSource; purpose: DiagnosticPurpose }
export interface HistoricalSampleResult {
  view: 'diagnostic_history'; decision_use: 'forbidden'; purpose: DiagnosticPurpose;
  channel: string; layer: string; at: SimTime;
  /** the first commit whose time ≥ at; exact_commit_instant = its time equals `at` */
  covered_by_commit: StateCommit; exact_commit_instant: boolean; queried_at_horizon: SimTime;
  source: SensingSource; synthetic: boolean; values: { id: string; x_mm: number; y_mm: number; value: number }[];
}
/** a source that keeps its committed history (diagnostic only; never handed to decision code) */
export interface HistoricalSensingSource {
  readonly source: SensingSource; readonly synthetic: boolean; readonly id: string; readonly max_range_mm: number;
  latestCommitted(channel: string, layer: string): StateCommit | null;
  commitCovering(channel: string, layer: string, at: SimTime): StateCommit | null;
  readAt(q: HistoricalSampleQuery): number[] | null;
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

/** total order on the simulation clock: negative if a is before b (= CHEM compareChemTime) */
export function compareTime(a: SimTime, b: SimTime): number { return a.t_s !== b.t_s ? (a.t_s < b.t_s ? -1 : 1) : a.round - b.round; }
const timeOk = (c: SimTime | null | undefined): c is SimTime => !!c && fin(c.t_s) && Number.isInteger(c.round) && c.round >= 0;
const commitOk = (c: StateCommit | null): c is StateCommit => !!c && Number.isInteger(c.seq) && c.seq >= 0 && timeOk(c.time);

/** THE REAL-TIME entry point: validates the contract, then reads the LATEST committed state locally. The sensing time
 *  must equal the latest commit (FUTURE_SAMPLE before it is committed, STALE_SAMPLE once a later state exists). */
export function sampleLocal(reader: RealtimeSensingReader, q: LocalSampleRequest): LocalSampleResult {
  const e = validateRequest(q);
  let c: StateCommit | null = null;
  if (!e.length) {
    if (q.source !== reader.source) e.push(`SOURCE_MISMATCH:${q.source}->${reader.source}`);
    if (q.range_mm > reader.max_range_mm) e.push('RANGE_ABOVE_BOUND');
    c = reader.latestCommitted(q.channel, q.layer);
    if (c === null) e.push('MISSING_SIGNAL:nothing_committed');
    else if (!commitOk(c)) e.push('BAD_STATE_COMMIT');
    else { const d = compareTime({ t_s: q.t_s, round: q.round }, c.time); if (d > 0) e.push('FUTURE_SAMPLE'); else if (d < 0) e.push('STALE_SAMPLE'); }
  }
  if (e.length) throw new SensingRefused(e);
  const st = { seq: (c as StateCommit).seq, time: { t_s: (c as StateCommit).time.t_s, round: (c as StateCommit).time.round } };
  const values = reader.read(q, st);
  if (values === null || values.length !== q.sensors.length || values.some((v, i) => v.sensor !== q.sensors[i].id || !fin(v.value))) throw new SensingRefused([`MISSING_SIGNAL:${reader.id}`]);
  return { view: 'agent_local', read_kind: 'realtime_latest_committed', agent_id: q.agent_id, t_s: q.t_s, round: q.round, sensing_time: { t_s: q.t_s, round: q.round }, state_commit: st, layer: q.layer, channel: q.channel, source: reader.source, synthetic: reader.synthetic, values };
}

/** DIAGNOSTIC historical query (replay / diagnosis / reconstruction only): the committed state at a past instant `at`
 *  ≤ the latest commit. Needs a DiagnosticCapability; the result is marked decision_use 'forbidden'. */
export function sampleHistorical(src: HistoricalSensingSource, cap: DiagnosticCapability, q: HistoricalSampleQuery): HistoricalSampleResult {
  if (!cap || typeof cap !== 'object' || !DIAGNOSTIC_CAPS.has(cap)) throw new SensingRefused(['NO_DIAGNOSTIC_CAPABILITY']);
  const e: string[] = [];
  if (!q || typeof q !== 'object') throw new SensingRefused(['MISSING:query']);
  if ('agent_id' in (q as object) || 'pose' in (q as object)) e.push('HISTORICAL_QUERY_IS_NOT_A_SENSING_ACT');
  if (q.purpose !== cap.purpose) e.push('PURPOSE_MISMATCH');
  if (!str(q.channel)) e.push('MISSING:channel');
  if (!str(q.layer)) e.push('MISSING:layer');
  if (!timeOk(q.at)) e.push('MISSING:at');
  if (!(fin(q.range_mm) && q.range_mm >= 0)) e.push('UNBOUNDED_RANGE');
  if (!Array.isArray(q.points) || !q.points.length || !q.points.every((p) => str(p?.id) && fin(p.x_mm) && fin(p.y_mm))) e.push('MISSING:points');
  if (!e.length) {
    if (q.source !== src.source) e.push(`SOURCE_MISMATCH:${q.source}->${src.source}`);
    if (q.range_mm > src.max_range_mm) e.push('RANGE_ABOVE_BOUND');
    const h = src.latestCommitted(q.channel, q.layer);
    if (h === null) e.push('MISSING_SIGNAL:nothing_committed');
    else if (compareTime(q.at, h.time) > 0) e.push('FUTURE_SAMPLE');
  }
  if (e.length) throw new SensingRefused(e);
  const h = src.latestCommitted(q.channel, q.layer) as StateCommit, cov = src.commitCovering(q.channel, q.layer, q.at), vals = src.readAt(q);
  if (!cov || !vals || vals.length !== q.points.length || !vals.every(fin)) throw new SensingRefused([`MISSING_SIGNAL:${src.id}`]);
  return { view: 'diagnostic_history', decision_use: 'forbidden', purpose: q.purpose, channel: q.channel, layer: q.layer, at: { ...q.at }, covered_by_commit: { seq: cov.seq, time: { ...cov.time } }, exact_commit_instant: compareTime(cov.time, q.at) === 0, queried_at_horizon: { ...h.time }, source: src.source, synthetic: src.synthetic, values: q.points.map((p, i) => ({ id: p.id, x_mm: p.x_mm, y_mm: p.y_mm, value: vals[i] })) };
}

/** every real-time decision path calls this on each sensing result: only sampleLocal() results pass */
export function assertRealtime(r: unknown): asserts r is LocalSampleResult {
  const x = r as { view?: unknown; read_kind?: unknown; sensing_time?: unknown; state_commit?: unknown } | null;
  if (!x || x.view !== 'agent_local' || x.read_kind !== 'realtime_latest_committed' || !x.sensing_time || !x.state_commit) throw new SensingRefused(['NOT_REALTIME:diagnostic_or_unknown_result']);
}

// ---------------------------------------------------------------- SyntheticChemicalField
/** SYNTHETIC field: Gaussian ridge around a polyline (no diffusion, no decay; NOT a pheromone model) */
export interface SyntheticRidge { synthetic: true; kind: 'gaussian_ridge'; polyline: { x: number; y: number }[]; sigma_mm: number; peak: number }
/** SYNTHETIC ZERO-SIGNAL control field: a committed channel whose value is exactly 0 everywhere (Owner decision 46: a
 *  scene without a chemical signal is run against this explicit control, never against an invented attractive field) */
export interface SyntheticZero { synthetic: true; kind: 'zero_signal' }
export type SyntheticStaticField = SyntheticRidge | SyntheticZero;
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
/** a STATIC synthetic field on one channel and layer. It has no deposits, decay or diffusion, so every committed state
 *  has the same values; states are still COMMITTED one instant at a time by its scheduler (advance), exactly like a CHEM
 *  store, so the real-time contract (sensing time = latest commit) is the same for both. */
export interface SyntheticFieldConfig { id: string; channel: string; layer: string; field: SyntheticStaticField; max_range_mm: number }
export class SyntheticChemicalField implements HistoricalSensingSource {
  readonly source = 'synthetic' as const;
  readonly synthetic = true;
  readonly id: string;
  readonly max_range_mm: number;
  readonly #cfg: SyntheticFieldConfig;
  readonly #commits: StateCommit[] = [];
  constructor(cfg: SyntheticFieldConfig) {
    const f = cfg.field;
    const okField = !!f && f.synthetic === true && (f.kind === 'zero_signal' || (f.kind === 'gaussian_ridge' && fin(f.sigma_mm) && f.sigma_mm > 0 && fin(f.peak) && Array.isArray(f.polyline)));
    if (!okField) throw new SensingRefused(['BAD:synthetic_field']);
    if (!(fin(cfg.max_range_mm) && cfg.max_range_mm >= 0)) throw new SensingRefused(['BAD:synthetic_config']);
    this.#cfg = { ...cfg, field: f.kind === 'zero_signal' ? { synthetic: true, kind: 'zero_signal' } : { ...f, polyline: f.polyline.map((p) => ({ ...p })) } }; this.id = cfg.id; this.max_range_mm = cfg.max_range_mm;
  }
  /** the field kind (observer metadata; not the field itself) */
  get kind(): SyntheticStaticField['kind'] { return this.#cfg.field.kind; }
  /** SCHEDULER capability: commit the state of instant `to` (never backwards; same instant twice is a no-op) */
  advance(to: SimTime): StateCommit {
    if (!timeOk(to)) throw new SensingRefused(['BAD:advance_time']);
    const last = this.#commits.at(-1);
    if (last && compareTime(to, last.time) < 0) throw new SensingRefused(['ADVANCE_BACKWARDS']);
    if (!last || compareTime(to, last.time) > 0) this.#commits.push({ seq: this.#commits.length, time: { t_s: to.t_s, round: to.round } });
    const c = this.#commits.at(-1) as StateCommit; return { seq: c.seq, time: { ...c.time } };
  }
  latestCommitted(channel: string, layer: string): StateCommit | null {
    const c = this.#commits.at(-1);
    return channel === this.#cfg.channel && layer === this.#cfg.layer && c ? { seq: c.seq, time: { ...c.time } } : null;
  }
  commitCovering(channel: string, layer: string, at: SimTime): StateCommit | null {
    if (channel !== this.#cfg.channel || layer !== this.#cfg.layer) return null;
    const c = this.#commits.find((k) => compareTime(k.time, at) >= 0); return c ? { seq: c.seq, time: { ...c.time } } : null;
  }
  #value(x: number, y: number): number { const f = this.#cfg.field; return f.kind === 'zero_signal' ? 0 : ridgeValue(f, { x, y }); }
  /** the capability handed to real-time decision code: latestCommitted + read, nothing else (frozen) */
  realtimeReader(): RealtimeSensingReader {
    const self = this;
    return Object.freeze({
      kind: 'realtime_sensing_reader' as const, source: this.source, synthetic: this.synthetic, id: this.id, max_range_mm: this.max_range_mm,
      latestCommitted: (channel: string, layer: string) => self.latestCommitted(channel, layer),
      read: (q: LocalSampleRequest, st: StateCommit): SensedValue[] | null => {
        const c = self.#commits.at(-1);
        if (!c || c.seq !== st.seq) return null;
        return q.sensors.map((s) => ({ sensor: s.id, x_mm: s.x_mm, y_mm: s.y_mm, value: self.#value(s.x_mm, s.y_mm), detectable: null }));
      },
    });
  }
  /** diagnostic history: point values of the committed state covering `at` (static field: the same values) */
  readAt(q: HistoricalSampleQuery): number[] | null {
    if (q.range_mm !== 0 || !this.commitCovering(q.channel, q.layer, q.at)) return null;
    return q.points.map((p) => this.#value(p.x_mm, p.y_mm));
  }
}

// ---------------------------------------------------------------- CHEM-1b real-time reader adapter (declaration; NOT integrated)
/** structural mirror of the CHEM-1b names (engine/chemistry/contract.ts + core.ts on the CHEM-1b branch: SampleQuery,
 *  ChemTime, ChemCommit, Sensor 'disc', SampleResult, ChemRealtimeReader). Declared here so this module does not import
 *  an unmerged module. */
export interface ChemTimeLike { clock: string; unit: 's'; t_s: number; round: number }
export interface ChemCommitLike { seq: number; time: ChemTimeLike }
export interface ChemSampleQueryLike { signal_id: string; agent_id: string; layer: string; time: ChemTimeLike; phase: 'local_sensing'; sensor: { kind: 'disc'; x_mm: number; y_mm: number; radius_mm: number } }
export interface ChemSampleResultLike { view: 'agent_local'; read_kind?: 'realtime_latest_committed'; exposure: number; detectable: boolean | null; state_commit?: ChemCommitLike }
/** CHEM-1b ChemRealtimeReader: latestCommitted() + sampleLocal(q). CHEM refuses any read not exactly at its latest commit
 *  (FUTURE_SAMPLE / STALE_SAMPLE); this adapter enforces the same rule before calling it and surfaces any CHEM refusal as
 *  MISSING_SIGNAL. CHEM's historical API (sampleHistorical with a ChemDiagnosticCapability) is NOT wrapped here: decision
 *  code never needs it. */
export interface ChemRealtimeReaderLike { readonly kind: 'chem_realtime_reader'; latestCommitted(): ChemCommitLike | null; sampleLocal(q: ChemSampleQueryLike): ChemSampleResultLike }
export class ChemLocalFieldAdapter implements RealtimeSensingReader {
  readonly kind = 'realtime_sensing_reader' as const;
  readonly source = 'chem_local_field' as const;
  readonly synthetic = false;
  /** CHEM-0/1/1b are under review; this adapter is a declared seam, not wired into any run */
  static readonly integrated = false;
  readonly id: string;
  readonly max_range_mm: number;
  readonly #reader: ChemRealtimeReaderLike; readonly #clock: string; readonly #channels: Set<string>;
  constructor(id: string, reader: ChemRealtimeReaderLike, clock: string, channels: string[], max_range_mm: number) { this.id = id; this.max_range_mm = max_range_mm; this.#reader = reader; this.#clock = clock; this.#channels = new Set(channels); }
  latestCommitted(channel: string): StateCommit | null { const c = this.#reader.latestCommitted(); return this.#channels.has(channel) && c ? { seq: c.seq, time: { t_s: c.time.t_s, round: c.time.round } } : null; }
  read(q: LocalSampleRequest, st: StateCommit): SensedValue[] | null {
    try {
      return q.sensors.map((s) => {
        const r = this.#reader.sampleLocal({ signal_id: q.channel, agent_id: q.agent_id, layer: q.layer, time: { clock: this.#clock, unit: 's', t_s: q.t_s, round: q.round }, phase: 'local_sensing', sensor: { kind: 'disc', x_mm: s.x_mm, y_mm: s.y_mm, radius_mm: q.range_mm } });
        if (r.state_commit && r.state_commit.seq !== st.seq) throw new SensingRefused(['STATE_CHANGED_DURING_READ']);
        return { sensor: s.id, x_mm: s.x_mm, y_mm: s.y_mm, value: r.exposure, detectable: r.detectable };
      });
    } catch (err) {
      // surfaced as an error with CHEM's own codes; never replaced by another source
      const codes = (err as { codes?: unknown }).codes;
      throw new SensingRefused([`MISSING_SIGNAL:${this.id}`, ...(Array.isArray(codes) ? codes.map(String) : [String((err as Error)?.message ?? err)])]);
    }
  }
}
