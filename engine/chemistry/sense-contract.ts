/**
 * CHEM-2 (#133) -> CHEM-3 (#134): the BEHAVIOUR-COUPLING CONTRACT. How an individual may read a chemical field.
 *
 * Status: ISOLATED contract + reference implementation; NOT wired into any world, controller or physics module.
 *
 * Rules (docs/chemical-ecology-engine.md §15.5):
 *  1. An individual reads only through a LocalChemSense bound to (ChemRealtimeReader, its own agent id, a pose source
 *     owned by the physics side). It never holds a ChemStore: a store, snapshot, ledger, provenance or historical read
 *     is refused (GLOBAL_ACCESS_REFUSED / NOT_A_REALTIME_READER).
 *  2. The sensing position is NOT an argument: it is the individual's own pose at the sensing time, as the pose source
 *     says (PH-3b in CHEM-3; body centre stands in for the antennae, evidence D). A request that names a position,
 *     another agent, a sensor, a phase or a past instant is refused (REQUEST_KEY_NOT_ALLOWED).
 *  3. Time: only the latest committed state (CHEM-1b): a sensing time after it is FUTURE_SAMPLE, before it STALE_SAMPLE
 *     (the reader enforces both; the phase is always 'local_sensing').
 *  4. The radius is bounded by the channel (RADIUS_ABOVE_BOUND); a point read (r = 0) on a plane must use the mean
 *     density (exposure is 0 by definition there).
 *  5. The reading is scalar: no cell keys, no provenance, no other agents' ids.
 *  6. Response functions are SLOTS with provenance (threshold, gain, exponent): no value exists for the focal species
 *     (no dose-response data), so all default to null and a slot with a null parameter is OFF (returns null, never a
 *     guessed number). Forms follow the research doc's choice-function axis C (C-a linear above threshold, D;
 *     C-b Deneubourg-type power, C); they produce a per-option attractiveness only — combining options into a choice
 *     is CHEM-3's decision operator, not chemistry.
 */
import { validateProvenance, type ChemTime, type ParamProvenance, type Sensor } from './contract.ts';
import { ChemRefused, type ChemCommit, type ChemRealtimeReader, type SampleResult } from './core.ts';

export const CHEM_SENSE_CONTRACT_VERSION = 'antempire.chem-sense-contract.v1';

/** the individual's own pose at an instant, from the physics side (never from the individual's request) */
export type AgentPose = { kind: 'edge'; layer: string; edge_id: string; s_mm: number } | { kind: 'point'; layer: string; x_mm: number; y_mm: number };
export interface PoseSource { poseAt(agent_id: string, t: ChemTime): AgentPose | null }

export type SenseMeasure = 'exposure' | 'mean_density_per_mm2';
/** the ONLY request form: no position, no agent, no sensor, no phase */
export interface SenseRequest { signal_id: string; time: ChemTime; radius_mm: number; measure: SenseMeasure }
export const SENSE_REQUEST_KEYS = ['measure', 'radius_mm', 'signal_id', 'time'] as const;

export interface LocalChemReading {
  view: 'agent_local'; read_kind: 'realtime_latest_committed';
  signal_id: string; agent_id: string;
  sensing_time: ChemTime; state_commit: ChemCommit;
  measure: SenseMeasure; value: number;
  /** the channel's threshold comparison (null while the threshold is null) */
  detectable: boolean | null;
}
export interface LocalChemSense {
  readonly kind: 'chem_local_sense';
  readonly agent_id: string;
  read(req: SenseRequest): LocalChemReading;
}

/** members a real-time reader must not have (anything that reads beyond one local sample, or writes) */
const GLOBAL_MEMBERS = ['snapshot', 'ledger', 'provenance', 'sampleHistorical', 'deposit', 'advance', 'channels', 'cells', 'horizon'];

/** bind a sense to one individual. `reader` must be exactly a ChemStore.realtimeReader() (frozen, two methods). */
export function createLocalSense(reader: ChemRealtimeReader, poses: PoseSource, agent_id: string): LocalChemSense {
  const e: string[] = [];
  const r = reader as unknown as Record<string, unknown>;
  if (!r || typeof r !== 'object') e.push('NOT_A_REALTIME_READER');
  else {
    if (GLOBAL_MEMBERS.some((k) => k in r)) e.push('GLOBAL_ACCESS_REFUSED');
    if (r.kind !== 'chem_realtime_reader' || !Object.isFrozen(r) || typeof r.sampleLocal !== 'function' || typeof r.latestCommitted !== 'function') e.push('NOT_A_REALTIME_READER');
    else { const keys = Object.keys(r).sort(); if (keys.join(',') !== 'kind,latestCommitted,sampleLocal') e.push('NOT_A_REALTIME_READER'); }
  }
  if (!poses || typeof poses.poseAt !== 'function') e.push('MISSING:pose_source');
  if (!(typeof agent_id === 'string' && agent_id.length)) e.push('MISSING:agent_id');
  if (e.length) throw new ChemRefused([...new Set(e)]);
  const read = (req: SenseRequest): LocalChemReading => {
    const q = req as unknown as Record<string, unknown>, errs: string[] = [];
    if (!q || typeof q !== 'object') throw new ChemRefused(['BAD:request']);
    for (const k of Object.keys(q)) if (!(SENSE_REQUEST_KEYS as readonly string[]).includes(k)) errs.push(`REQUEST_KEY_NOT_ALLOWED:${k}`);
    if (req.measure !== 'exposure' && req.measure !== 'mean_density_per_mm2') errs.push('BAD:measure');
    if (errs.length) throw new ChemRefused(errs);
    const pose = poses.poseAt(agent_id, req.time);
    if (!pose) throw new ChemRefused(['NO_POSE']);
    const sensor: Sensor = pose.kind === 'edge' ? { kind: 'edge', edge_id: pose.edge_id, s_mm: pose.s_mm, radius_mm: req.radius_mm } : { kind: 'disc', x_mm: pose.x_mm, y_mm: pose.y_mm, radius_mm: req.radius_mm };
    if (pose.kind === 'point' && req.measure === 'exposure' && req.radius_mm === 0) throw new ChemRefused(['EXPOSURE_AT_ZERO_RADIUS']);
    const s: SampleResult = reader.sampleLocal({ signal_id: req.signal_id, agent_id, layer: pose.layer, time: req.time, phase: 'local_sensing', sensor });
    const v = req.measure === 'exposure' ? s.exposure : s.mean_density_per_mm2;
    if (v === null) throw new ChemRefused(['MEASURE_UNAVAILABLE_ON_BACKEND']);
    return { view: 'agent_local', read_kind: s.read_kind, signal_id: s.signal_id, agent_id, sensing_time: { ...s.sensing_time }, state_commit: { seq: s.state_commit.seq, time: { ...s.state_commit.time } }, measure: req.measure, value: v, detectable: s.detectable };
  };
  return Object.freeze({ kind: 'chem_local_sense' as const, agent_id, read });
}

// ------------------------------------------------------------------ response-function slots (CHEM-3 fills them)

export type ResponseForm = 'linear_above_threshold' | 'deneubourg_power';
export interface ResponseSlots {
  version: typeof CHEM_SENSE_CONTRACT_VERSION;
  form: ResponseForm;
  /** reading below which the response is 0 (linear_above_threshold) / additive constant k of (k + x)^n (deneubourg_power) */
  threshold: ParamProvenance;
  /** multiplier of the response */
  gain: ParamProvenance;
  /** n of (k + x)^n; must be null for linear_above_threshold */
  exponent: ParamProvenance;
  /** evidence level of the FORM (C-a: D; C-b: C) — the numbers carry their own */
  form_evidence: 'C' | 'D';
  sources: string[];
}
/** all-null slots (OFF): the default for the focal species — there is no dose-response measurement */
export function responseSlotsOff(form: ResponseForm = 'linear_above_threshold'): ResponseSlots {
  const nul = (n: string): ParamProvenance => ({ value: null, assumption: true, basis: '遊戲假設', evidence_level: 'D', sources: [], note: `${n}: no dose-response data for the focal species; OFF` });
  return { version: CHEM_SENSE_CONTRACT_VERSION, form, threshold: nul('threshold'), gain: nul('gain'), exponent: nul('exponent'), form_evidence: form === 'deneubourg_power' ? 'C' : 'D', sources: form === 'deneubourg_power' ? ['R102'] : [] };
}
export function validateResponseSlots(s: ResponseSlots): string[] {
  const e: string[] = [];
  if (!s || s.version !== CHEM_SENSE_CONTRACT_VERSION) return ['BAD:response_version'];
  if (s.form !== 'linear_above_threshold' && s.form !== 'deneubourg_power') e.push('BAD:response_form');
  e.push(...validateProvenance(s.threshold, 'threshold'), ...validateProvenance(s.gain, 'gain'), ...validateProvenance(s.exponent, 'exponent'));
  if (s.form === 'linear_above_threshold' && s.exponent?.value !== null) e.push('EXPONENT_NOT_IN_FORM');
  if (s.form_evidence !== (s.form === 'deneubourg_power' ? 'C' : 'D')) e.push('BAD:form_evidence');
  for (const [n, p] of [['threshold', s.threshold], ['gain', s.gain], ['exponent', s.exponent]] as const) if (p && p.value !== null && !(Number.isFinite(p.value) && p.value >= 0)) e.push(`BAD:${n}`);
  return e;
}
export interface ResponseValue { value: number | null; off: string[] }
/** the per-option attractiveness of one reading; null (OFF) while any parameter the form uses is null */
export function evaluateResponse(s: ResponseSlots, reading: Pick<LocalChemReading, 'value'>): ResponseValue {
  const e = validateResponseSlots(s); if (e.length) throw new ChemRefused(e);
  const used = s.form === 'linear_above_threshold' ? ['threshold', 'gain'] as const : ['threshold', 'gain', 'exponent'] as const;
  const off = used.filter((k) => s[k].value === null).map((k) => `OFF:${k}`);
  if (off.length) return { value: null, off };
  const x = reading.value, k = s.threshold.value as number, g = s.gain.value as number;
  return { value: s.form === 'linear_above_threshold' ? g * Math.max(0, x - k) : g * Math.pow(k + x, s.exponent.value as number), off: [] };
}
