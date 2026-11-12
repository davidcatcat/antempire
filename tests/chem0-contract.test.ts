/**
 * CHEM-0 (#131) contract tests: the public chemistry contract (engine/chemistry/contract.ts) accepts a correctly
 * labelled channel / deposit / sample and REJECTS each listed defect (missing provenance, wrong units, a chemical
 * identity without evidence, a true mass without a chemical, merged mechanisms, unbounded or cross-layer sensing,
 * CHC at a distance, a non-assumption number without species evidence ...). Also checks that the existing official
 * trail parameters are still labelled game assumptions and that the contract does not relabel them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import {
  CHEM_CONTRACT_VERSION, LEGACY_TRAIL_PARAMS, compareChemTime, validateChannel, validateDeposit, validateProvenance, validateSampleQuery,
  type ChannelSpec, type ChemClock, type DepositEvent, type Domain, type ParamProvenance, type SampleQuery,
} from '../engine/chemistry/contract.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const has = (errs: string[], code: string) => errs.some((e) => e === code || e.startsWith(code));

const synth = (value: number | null, note = 'synthetic candidate, not a species concentration'): ParamProvenance => ({ value, assumption: true, basis: '遊戲假設', evidence_level: 'D', sources: [], note });
const trail: ChannelSpec = {
  signal_id: 'trail.M1', mechanism: 'trail_recruitment', model_variant: 'M1', variant_role: null, chemical_identity: null,
  units: { quantity: 'normalized_activity', length: 'mm', time: 's' }, backend: 'surface_edge', spatial_support: { kind: 'surface_edge', bin_mm: 5 },
  perception_rule: { mode: 'on_support', max_radius_mm: 3, near_contact_mm: null, same_layer_only: true, threshold: synth(null) },
  time_rule: { kind: 'analytic_exponential', unit: 's', lambda_per_s: synth(0, 'lambda = 0 baseline'), same_instant: 'visible_if_round_not_later' },
  evidence_level: 'C', assumption: true, sources: ['R21', 'R102'], note: 'mechanism: C (M1 candidate); numbers: D',
};
const plane: ChannelSpec = { ...clone(trail), signal_id: 'trail.M1.2d', backend: 'sparse_2d', spatial_support: { kind: 'sparse_2d', cell_mm: 2, isotropic_diffusion: false }, perception_rule: { ...clone(trail.perception_rule), mode: 'bounded_radius' } };
const chc: ChannelSpec = {
  ...clone(trail), signal_id: 'chc.profile', mechanism: 'chc_recognition', model_variant: 'chc_contact_candidate', backend: 'contact', spatial_support: { kind: 'contact' },
  perception_rule: { mode: 'antennal_contact', max_radius_mm: null, near_contact_mm: null, same_layer_only: true, threshold: synth(null) },
  time_rule: { kind: 'none', unit: 's', lambda_per_s: null, same_instant: 'visible_if_round_not_later' }, evidence_level: 'B', sources: ['R700', 'R110'],
};
const alarm: ChannelSpec = {
  ...clone(trail), signal_id: 'alarm.short', mechanism: 'short_range_alarm', model_variant: 'alarm_candidate', backend: 'point_exposure', spatial_support: { kind: 'point_exposure', max_radius_mm: null },
  perception_rule: { mode: 'bounded_radius', max_radius_mm: 100, near_contact_mm: null, same_layer_only: true, threshold: synth(null) }, evidence_level: 'A', sources: ['R98'],
};
const clock: ChemClock = { name: 'chem.test', anchor: { day: 0, minute: 600 } };
const edges: Domain = { backend: 'surface_edge', edges: [{ id: 'E1', length_mm: 60, layer: 'surface' }] };
const planeDom: Domain = { backend: 'sparse_2d', bounds_mm: { x0: 0, y0: 0, x1: 100, y1: 100 }, layers: ['surface'] };
const dep: DepositEvent = {
  deposit_id: 'd1', signal_id: 'trail.M1', origin_agent: 'w1', source_worker_id: 'w1', origin_event_id: 'ph3b:w1:seg3',
  time: { clock: 'chem.test', unit: 's', t_s: 12.5, round: 0 }, layer: 'surface', substrate: null,
  where: { kind: 'edge_segment', edge_id: 'E1', s0_mm: 10, s1_mm: 30 }, amount: 1, cause: 'laden_return', units: { quantity: 'normalized_activity', length: 'mm', time: 's' },
};
const q: SampleQuery = { signal_id: 'trail.M1', agent_id: 'w2', layer: 'surface', time: { clock: 'chem.test', unit: 's', t_s: 20, round: 0 }, phase: 'local_sensing', sensor: { kind: 'edge', edge_id: 'E1', s_mm: 20, radius_mm: 2 } };

// ---- the correct cases pass
ok(CHEM_CONTRACT_VERSION === 'antempire.chem-contract.v1', 'contract version');
for (const c of [trail, plane, chc, alarm]) ok(validateChannel(c).length === 0, `valid channel ${c.signal_id}: ${validateChannel(c).join(',')}`);
ok(validateDeposit(dep, trail, clock, edges).length === 0, `valid deposit: ${validateDeposit(dep, trail, clock, edges).join(',')}`);
ok(validateSampleQuery(q, trail, clock).length === 0, `valid sample: ${validateSampleQuery(q, trail, clock).join(',')}`);
const dep2d: DepositEvent = { ...clone(dep), signal_id: 'trail.M1.2d', where: { kind: 'segment2d', x0_mm: 1, y0_mm: 1, x1_mm: 9, y1_mm: 5 } };
ok(validateDeposit(dep2d, plane, clock, planeDom).length === 0, 'valid 2D deposit');

// ---- each channel defect is rejected with its code
const chanCases: [string, (c: ChannelSpec) => void, string][] = [
  ['missing identity field', (c) => { delete (c as Partial<ChannelSpec>).chemical_identity; }, 'MISSING:chemical_identity'],
  ['identity without evidence', (c) => { c.chemical_identity = { compound: 'hypothetical', evidence_level: 'B', sources: [] }; }, 'IDENTITY_WITHOUT_EVIDENCE'],
  ['identity with B evidence', (c) => { c.chemical_identity = { compound: 'hypothetical', evidence_level: 'B', sources: ['R00'] }; }, 'IDENTITY_WITHOUT_EVIDENCE'],
  ['true mass without identity', (c) => { c.units.quantity = 'mass_ng'; }, 'TRUE_AMOUNT_WITHOUT_IDENTITY'],
  ['time in minutes', (c) => { (c.units as { time: string }).time = 'min'; }, 'BAD_UNITS:length_or_time'],
  ['length in edge units', (c) => { (c.units as { length: string }).length = 'edge'; }, 'BAD_UNITS:length_or_time'],
  ['lambda per minute rule', (c) => { (c.time_rule as { unit: string }).unit = 'min'; }, 'BAD_UNITS:time_rule'],
  ['lambda without provenance', (c) => { c.time_rule.lambda_per_s = null; }, 'MISSING_PROVENANCE:lambda_per_s'],
  ['negative lambda', (c) => { c.time_rule.lambda_per_s!.value = -0.01; }, 'BAD:lambda_per_s'],
  ['non-assumption lambda without species evidence', (c) => { c.time_rule.lambda_per_s!.assumption = false; }, 'UNSUPPORTED_NON_ASSUMPTION:lambda_per_s'],
  ['B evidence without source', (c) => { c.time_rule.lambda_per_s!.evidence_level = 'B'; }, 'EVIDENCE_WITHOUT_SOURCE:lambda_per_s'],
  ['threshold missing', (c) => { delete (c.perception_rule as Partial<typeof c.perception_rule>).threshold; }, 'MISSING_PROVENANCE:threshold'],
  ['unbounded radius', (c) => { c.perception_rule.max_radius_mm = null; }, 'UNBOUNDED_RADIUS'],
  ['infinite radius', (c) => { c.perception_rule.max_radius_mm = Infinity; }, 'UNBOUNDED_RADIUS'],
  ['cross-layer perception', (c) => { (c.perception_rule as { same_layer_only: boolean }).same_layer_only = false; }, 'CROSS_LAYER_PERCEPTION'],
  ['trail on a contact backend', (c) => { c.backend = 'contact'; c.spatial_support = { kind: 'contact' }; }, 'MECHANISM_BACKEND_MISMATCH'],
  ['support differs from backend', (c) => { c.spatial_support = { kind: 'sparse_2d', cell_mm: 1, isotropic_diffusion: false }; }, 'SUPPORT_BACKEND_MISMATCH'],
  ['forced isotropic diffusion', (c) => { c.backend = 'sparse_2d'; c.perception_rule.mode = 'bounded_radius'; c.spatial_support = { kind: 'sparse_2d', cell_mm: 1, isotropic_diffusion: true as false }; }, 'BAD:sparse_2d_support'],
  ['same-instant by array order', (c) => { (c.time_rule as { same_instant: string }).same_instant = 'array_order'; }, 'BAD:same_instant'],
  ['M2 without role', (c) => { c.model_variant = 'M2'; }, 'M2_WITHOUT_ROLE'],
  ['role without M2', (c) => { c.variant_role = 'F'; }, 'ROLE_WITHOUT_M2'],
  ['missing assumption flag', (c) => { delete (c as Partial<ChannelSpec>).assumption; }, 'MISSING_ASSUMPTION:channel'],
  ['bad evidence level', (c) => { (c as { evidence_level: string }).evidence_level = 'E'; }, 'BAD_EVIDENCE_LEVEL:channel'],
];
for (const [name, mutate, code] of chanCases) { const c = clone(trail); mutate(c); const errs = validateChannel(c); ok(has(errs, code), `channel defect "${name}" -> ${code} (got ${errs.join(',')})`); }
// CHC: contact only, never a field, never decaying
for (const [name, mutate, code] of [
  ['CHC at a distance', (c: ChannelSpec) => { c.perception_rule.mode = 'bounded_radius'; c.perception_rule.max_radius_mm = 50; }, 'CHC_NOT_CONTACT'],
  ['CHC with radius', (c: ChannelSpec) => { c.perception_rule.max_radius_mm = 10; }, 'CHC_WITH_RADIUS'],
  ['CHC near-contact gap too large', (c: ChannelSpec) => { c.perception_rule.near_contact_mm = 5; }, 'CHC_NEAR_CONTACT_TOO_FAR'],
  ['CHC as a surface field', (c: ChannelSpec) => { c.backend = 'surface_edge'; c.spatial_support = { kind: 'surface_edge', bin_mm: 5 }; }, 'MECHANISM_BACKEND_MISMATCH'],
  ['CHC with decay', (c: ChannelSpec) => { c.time_rule.kind = 'analytic_exponential'; }, 'CONTACT_WITH_DECAY'],
] as const) { const c = clone(chc); mutate(c); ok(has(validateChannel(c), code), `CHC defect "${name}" -> ${code}`); }
{ const c = clone(alarm); c.backend = 'surface_edge'; c.spatial_support = { kind: 'surface_edge', bin_mm: 5 }; ok(has(validateChannel(c), 'MECHANISM_BACKEND_MISMATCH'), 'alarm merged into the trail field is rejected'); }
{ const c = clone(alarm); c.perception_rule.mode = 'antennal_contact'; ok(has(validateChannel(c), 'CONTACT_MODE_FOR_FIELD'), 'alarm sensed by contact mode is rejected'); }

// ---- each deposit defect is rejected
const depCases: [string, (d: DepositEvent) => void, string][] = [
  ['missing origin_event_id', (d) => { d.origin_event_id = ''; }, 'MISSING_PROVENANCE:origin_event_id'],
  ['missing origin_agent', (d) => { (d as Partial<DepositEvent>).origin_agent = undefined; }, 'MISSING_PROVENANCE:origin_agent'],
  ['missing deposit_id', (d) => { d.deposit_id = ''; }, 'MISSING_PROVENANCE:deposit_id'],
  ['missing cause', (d) => { d.cause = ''; }, 'MISSING_PROVENANCE:cause'],
  ['worker id differs from origin agent', (d) => { d.source_worker_id = 'w9'; }, 'SOURCE_WORKER_MISMATCH'],
  ['time in minutes', (d) => { (d.time as { unit: string }).unit = 'min'; }, 'BAD_UNITS:time'],
  ['wrong clock', (d) => { d.time.clock = 'world'; }, 'WRONG_CLOCK'],
  ['negative time', (d) => { d.time.t_s = -1; }, 'BAD:t_s'],
  ['fractional round', (d) => { d.time.round = 0.5; }, 'BAD:round'],
  ['unit quantity mismatch', (d) => { d.units.quantity = 'mass_ng'; }, 'BAD_UNITS:quantity'],
  ['edge-fraction location', (d) => { d.where = { kind: 'edge_point', edge_id: 'E1', s_mm: 0.5 * 600 }; }, 'OUT_OF_BOUNDS:s_mm'],
  ['unknown edge', (d) => { d.where = { kind: 'edge_point', edge_id: 'E9', s_mm: 1 }; }, 'OUT_OF_BOUNDS:edge'],
  ['cross-layer deposit', (d) => { d.layer = 'underground'; }, 'CROSS_LAYER_DEPOSIT'],
  ['negative amount', (d) => { d.amount = -1; }, 'BAD:amount'],
  ['zero amount (signal from nothing is not a deposit)', (d) => { d.amount = 0; }, 'BAD:amount'],
  ['NaN amount', (d) => { d.amount = NaN; }, 'BAD:amount'],
  ['empty segment', (d) => { d.where = { kind: 'edge_segment', edge_id: 'E1', s0_mm: 5, s1_mm: 5 }; }, 'EMPTY_SEGMENT'],
  ['2D point on an edge backend', (d) => { d.where = { kind: 'point2d', x_mm: 1, y_mm: 1 }; }, 'WHERE_KIND_MISMATCH'],
];
for (const [name, mutate, code] of depCases) { const d = clone(dep); mutate(d); const errs = validateDeposit(d, trail, clock, edges); ok(has(errs, code), `deposit defect "${name}" -> ${code} (got ${errs.join(',')})`); }
{ const d = clone(dep2d); d.where = { kind: 'point2d', x_mm: 101, y_mm: 1 }; ok(has(validateDeposit(d, plane, clock, planeDom), 'OUT_OF_BOUNDS:xy_mm'), '2D out of bounds rejected'); }
ok(has(validateDeposit({ ...clone(dep), signal_id: 'chc.profile' }, chc, clock, edges), 'NOT_A_FIELD_CHANNEL'), 'nothing can be deposited into the CHC contact channel');

// ---- each sampling defect is rejected (no global read, no other layer, no unbounded radius)
const qCases: [string, (x: SampleQuery) => void, string][] = [
  ['radius above the bound', (x) => { x.sensor.radius_mm = 4; }, 'RADIUS_ABOVE_BOUND'],
  ['sample in the physics/source phase', (x) => { x.phase = 'physics_and_sources'; }, 'SAMPLE_BEFORE_COMMIT'],
  ['sample during the chemistry commit', (x) => { x.phase = 'chemistry_commit'; }, 'SAMPLE_BEFORE_COMMIT'],
  ['sample during the chemistry update', (x) => { x.phase = 'chemistry_update'; }, 'SAMPLE_BEFORE_COMMIT'],
  ['sample in the behaviour phase', (x) => { x.phase = 'behaviour_decision'; }, 'SAMPLE_OUTSIDE_SENSING_PHASE'],
  ['sample without a phase', (x) => { delete (x as Partial<SampleQuery>).phase; }, 'MISSING:phase'],
  ['global read (infinite radius)', (x) => { x.sensor.radius_mm = Infinity; }, 'UNBOUNDED_RADIUS'],
  ['NaN radius', (x) => { x.sensor.radius_mm = NaN; }, 'UNBOUNDED_RADIUS'],
  ['no agent', (x) => { x.agent_id = ''; }, 'MISSING:agent_id'],
  ['no layer', (x) => { x.layer = ''; }, 'MISSING:layer'],
  ['time in minutes', (x) => { (x.time as { unit: string }).unit = 'min'; }, 'BAD_UNITS:time'],
  ['disc sensor on an edge channel', (x) => { x.sensor = { kind: 'disc', x_mm: 1, y_mm: 1, radius_mm: 1 }; }, 'SENSOR_KIND_MISMATCH'],
];
for (const [name, mutate, code] of qCases) { const x = clone(q); mutate(x); ok(has(validateSampleQuery(x, trail, clock), code), `sample defect "${name}" -> ${code}`); }
ok(has(validateSampleQuery({ ...clone(q), signal_id: 'chc.profile' }, chc, clock), 'RADIUS_ABOVE_BOUND') && has(validateSampleQuery({ ...clone(q), signal_id: 'chc.profile' }, chc, clock), 'NOT_A_FIELD_CHANNEL'), 'CHC cannot be sampled as a field');

// ---- provenance rules
ok(validateProvenance(synth(null), 'x').length === 0, 'unknown value stays null and is valid');
ok(validateProvenance({ value: 0.07, assumption: false, basis: '文獻支持', evidence_level: 'A', sources: ['R21'], note: 'direct' }, 'x').length === 0, 'non-assumption allowed only with A + source + 文獻支持');
ok(has(validateProvenance({ value: 0.07, assumption: false, basis: '文獻支持', evidence_level: 'C', sources: ['R102'], note: '' }, 'x'), 'UNSUPPORTED_NON_ASSUMPTION'), 'a model (C) number cannot be a non-assumption');
ok(has(validateProvenance(undefined, 'x'), 'MISSING_PROVENANCE'), 'missing provenance');

// ---- same-instant order is (t_s, round), never array order
const T = (t_s: number, round: number) => ({ clock: 'c', unit: 's' as const, t_s, round });
ok(compareChemTime(T(1, 0), T(1, 1)) < 0 && compareChemTime(T(1, 1), T(2, 0)) < 0 && compareChemTime(T(3, 2), T(3, 2)) === 0, 'chem time order');

// ---- legacy official parameters stay game assumptions, not concentrations
const sp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'species/pheidole-megacephala.json'), 'utf8')) as { recruitment: Record<string, { value: number; assumption: boolean; basis: string }> };
for (const [k, v] of Object.entries(LEGACY_TRAIL_PARAMS)) {
  const p = sp.recruitment[k];
  ok(p && p.assumption === true && p.basis === '遊戲假設' && v.is_concentration === false && v.basis === '遊戲假設', `${k} is a game assumption (value ${p?.value}) and not a concentration`);
}
ok(sp.recruitment.trail_daily_retention.value === 0.55, 'official retention unchanged by CHEM-0');

// ---- the docs carry the contract (and the matrix rows)
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/chemical-ecology-engine.md'), 'utf8');
for (const s of ['chemical_identity', 'normalized_activity', 'visible_if_round_not_later', 'sampleLocal', 'CHEM-1', 'CHEM-5', '#103', 'trail_daily_retention']) ok(doc.includes(s), `docs/chemical-ecology-engine.md mentions ${s}`);
const research = fs.readFileSync(path.join(REPO_ROOT, 'docs/research-pheromone-models-2026-11.md'), 'utf8');
for (const s of ['CHEM-0', 'Experiment 3', 'Gellert', 'Boissard', 'van Oudenhove', 'Fournier']) ok(research.includes(s), `research doc CHEM-0 audit mentions ${s}`);

console.log(JSON.stringify({ test: 'chem0-contract', checks }));
