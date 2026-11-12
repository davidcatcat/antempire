/**
 * Local chemical sensing contract (engine/physics/local-sensing.ts; docs/kin2d-local-sensing.md). Blocking.
 *  - model C reads chemistry only through sampleLocal(); its outputs are bit-identical to before the refactor (digest
 *    recorded before the change; the §8 tables and pose streams are also checked verbatim by natural-walk.test.ts);
 *  - requests carry agent, time, pose-derived antenna points, layer, channel, range, source and assumption tags;
 *  - no whole-field read, no future read, no silent fallback from CHEM to synthetic, source recorded in the output;
 *  - unified causal read contract (Owner decision 43; names aligned with CHEM-1b): real time reads only the latest
 *    committed state, exactly at the sensing instant (FUTURE_SAMPLE / STALE_SAMPLE); historical reads only through the
 *    diagnostic sampleHistorical() with an unforgeable capability, refused by assertRealtime(); sensing time and state
 *    commit recorded separately; decision code holds a reader without history or commit capability.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { walkDigest } from './lib-walk-digest.ts';
import { planWalk, type WalkSpec } from '../engine/physics/natural-walk.ts';
import { committedThrough, chemSensorValue, ChemHistoryAdapter, sampleLocal, sampleHistorical, assertRealtime, createDiagnosticCapability, antennaSensors, SyntheticChemicalField, ChemLocalFieldAdapter, SensingRefused, type LocalChemSampler, type LocalSampleRequest, type ChemSampleQueryLike, type ChemRealtimeReaderLike, type DiagnosticCapability, type HistoricalSampleQuery, type SimTime } from '../engine/physics/local-sensing.ts';
import { trailAnt, walkParams, trailField, body } from '../prototypes/natural-walk/lib.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (f: () => unknown, code: string, why: string) => { try { f(); } catch (e) { ok(e instanceof SensingRefused && e.codes.some((c) => c.startsWith(code)), `${why} (${(e as Error).message})`); return; } ok(false, `${why}: no refusal`); };
const json = (x: unknown) => JSON.stringify(x);

// ---- bit-identical outputs (digest recorded before the refactor at b8a3fe6b…, 750 runs)
{
  const d = walkDigest();
  ok(d.runs === 750 && d.digest === 'b8a3fe6b08c66556e4f06629396d814d7d1c9cf4fd5d6184b42cd9f11095f63f', `natural-walk outputs bit-identical to before the sensing refactor (got ${d.digest})`);
}
// ---- model C goes through the contract only, with real-time reads only
{
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/natural-walk.ts'), 'utf8'), src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body_ = src.slice(src.indexOf('export function planWalk'));
  ok(body_.includes('sampleLocal(') && !/fieldValue\(|ridgeValue\(|\.polyline|sigma_mm/.test(body_), 'planWalk reads chemistry only via sampleLocal (no direct field evaluation)');
  ok(!/sampleHistorical|createDiagnosticCapability|readAt\(|commitCovering/.test(src) && /assertRealtime\(r\)/.test(src), 'natural-walk decisions use only sampleLocal + assertRealtime (no historical API)');
  const { plan } = trailAnt('C', 3, 2);
  ok(plan.sensing?.source === 'synthetic' && plan.sensing.synthetic === true && plan.sensor_samples.length > 0 && plan.sensor_samples.every((s) => s.source === 'synthetic' && s.synthetic === true), 'model C output records its source (synthetic)');
  ok(plan.sensor_samples.every((s, k) => s.state_commit_t_s === s.t && s.state_commit_seq === k), 'every sample read the state committed at its own sensing instant (one commit per control step)');
  ok(trailAnt('B', 3, 2).plan.sensing === null, 'model B has no chemical sensing');
  // a spying reader sees every request; results identical to the default synthetic sampler
  const reqs: LocalSampleRequest[] = [];
  const spec0 = trailAnt('C', 3, 2).spec;
  const inner = new SyntheticChemicalField({ id: 'spy', channel: 'synthetic_trail', layer: 'default', field: trailField(), max_range_mm: 0 }), ir = inner.realtimeReader();
  const spy: LocalChemSampler = { kind: 'realtime_sensing_reader', source: ir.source, synthetic: ir.synthetic, id: 'spy', max_range_mm: 0, latestCommitted: (c, l) => ir.latestCommitted(c, l), read: (q, st) => { reqs.push(q); return ir.read(q, st); } };
  const p2 = planWalk({ ...spec0, sampler: spy, scheduler: inner });
  ok(json(p2.track.segs) === json(plan.track.segs) && json(p2.sensor_samples.map((s) => [s.left, s.right])) === json(plan.sensor_samples.map((s) => [s.left, s.right])), 'injected reader gives the identical plan');
  ok(reqs.length === plan.sensor_samples.length, 'one contract request per control step');
  ok(reqs.every((q) => q.agent_id === spec0.id && q.layer === 'default' && q.channel === 'synthetic_trail' && q.range_mm === 0 && q.source === 'synthetic' && q.tags.length >= 3 && q.tags.every((t) => t.assumption === true && t.basis === '遊戲假設') && q.t_s >= spec0.t0_s), 'requests carry agent, sensing time, layer, channel, range, source and assumption tags');
  ok(reqs.every((q) => json(q.sensors) === json(antennaSensors(q.pose, q.geometry)) && q.geometry.body_length_mm === body().length_mm), 'sensor points are the antenna tips of the actual pose');
  const lone = new SyntheticChemicalField({ id: 'lone', channel: 'synthetic_trail', layer: 'default', field: trailField(), max_range_mm: 0 });
  refuses(() => planWalk({ ...spec0, sampler: lone.realtimeReader() }), 'MISSING_SIGNAL', 'injected reader without a scheduler: nothing committed → error (no silent read)');
  const fixed = new SyntheticChemicalField({ id: 'fixed', channel: 'synthetic_trail', layer: 'default', field: trailField(), max_range_mm: 0 }); fixed.advance({ t_s: 0, round: 0 });
  refuses(() => planWalk({ ...spec0, sampler: fixed.realtimeReader() }), 'FUTURE_SAMPLE', 'state committed only at t0: the next control instant is not committed → refused');
}
// ---- no whole-field read; the decision-side reader has no history or commit capability
{
  const f = new SyntheticChemicalField({ id: 's', channel: 'ch', layer: 'L', field: trailField(), max_range_mm: 0 });
  ok(!('field' in f) && !Object.keys(f).some((k) => /field|cfg|polyline|commits/.test(k)) && json(f).indexOf('polyline') < 0, 'the synthetic field is not readable as a whole (private)');
  const r = f.realtimeReader();
  ok(Object.isFrozen(r) && !('advance' in r) && !('readAt' in r) && Object.keys(r).sort().join(',') === 'id,kind,latestCommitted,max_range_mm,read,source,synthetic', 'real-time reader: latestCommitted + read only (no history, no commit), frozen');
}
// ---- refusals and the causal read rule
{
  const f = new SyntheticChemicalField({ id: 's', channel: 'ch', layer: 'L', field: trailField(), max_range_mm: 0 }), rd = f.realtimeReader();
  const geometry = { body_length_mm: 2.5, antenna_len_mm: 1, antenna_half_angle_rad: 0.5 }, pose = { x: 10, y: 0.3, th: 0.1 };
  const base: LocalSampleRequest = { agent_id: 'a', t_s: 1, round: 0, pose, geometry, sensors: antennaSensors(pose, geometry), layer: 'L', channel: 'ch', range_mm: 0, source: 'synthetic', tags: [{ name: 'x', assumption: true, basis: '遊戲假設', note: '' }] };
  refuses(() => sampleLocal(rd, base), 'MISSING_SIGNAL', 'nothing committed yet → missing signal');
  f.advance({ t_s: 0.5, round: 0 });
  refuses(() => sampleLocal(rd, base), 'FUTURE_SAMPLE', 'sensing instant later than the latest commit (not yet committed) → refused');
  f.advance({ t_s: 1, round: 0 });
  const r = sampleLocal(rd, base);
  ok(r.view === 'agent_local' && r.read_kind === 'realtime_latest_committed' && r.source === 'synthetic' && r.synthetic === true && r.values.length === 2 && r.values[0].value > 0, 'valid request returns a local, labelled real-time result');
  ok(r.sensing_time.t_s === 1 && r.state_commit.seq === 1 && r.state_commit.time.t_s === 1, 'sensing time and state commit recorded separately (CHEM-1b names)');
  ok(JSON.stringify(committedThrough(rd, 'ch', 'L')) === JSON.stringify({ t_s: 1, round: 0 }) && committedThrough(rd, 'x', 'L') === null, 'committedThrough = latestCommitted()?.time');
  refuses(() => sampleLocal(rd, { ...base, t_s: 0.5 }), 'STALE_SAMPLE', 'sensing an older instant once a later state exists → STALE (history only via the diagnostic API)');
  refuses(() => f.advance({ t_s: 0.9, round: 0 }), 'ADVANCE_BACKWARDS', 'commits never go backwards');
  refuses(() => sampleLocal(rd, { ...base, source: 'chem_local_field' }), 'SOURCE_MISMATCH', 'a CHEM request sent to the synthetic field is refused (no silent swap)');
  refuses(() => sampleLocal(rd, { ...base, sensors: [{ ...base.sensors[0], x_mm: base.sensors[0].x_mm + 5 }, base.sensors[1]] }), 'SENSOR_NOT_FROM_POSE', 'a sensor point not derived from the pose is refused');
  refuses(() => sampleLocal(rd, { ...base, range_mm: 3 }), 'RANGE_ABOVE_BOUND', 'range above the sampler bound is refused');
  refuses(() => sampleLocal(rd, { ...base, range_mm: Infinity }), 'UNBOUNDED_RANGE', 'unbounded range refused');
  refuses(() => sampleLocal(rd, { ...base, tags: [] }), 'MISSING:assumption_tags', 'missing assumption tags refused');
  refuses(() => sampleLocal(rd, { ...base, agent_id: '' }), 'MISSING:agent_id', 'missing agent refused');
  refuses(() => sampleLocal(rd, { ...base, channel: 'other' }), 'MISSING_SIGNAL', 'unknown channel is a missing signal (error)');
  refuses(() => sampleLocal(rd, { ...base, layer: 'other' }), 'MISSING_SIGNAL', 'other layer is a missing signal (error)');
  // diagnostic history: separate API, capability required, not a sensing act, unusable by real-time decisions
  const cap = createDiagnosticCapability('diagnosis');
  const hq: HistoricalSampleQuery = { channel: 'ch', layer: 'L', at: { t_s: 0.7, round: 0 }, points: base.sensors.map((s) => ({ id: s.id, x_mm: s.x_mm, y_mm: s.y_mm })), range_mm: 0, source: 'synthetic', purpose: 'diagnosis' };
  const h = sampleHistorical(f, cap, hq);
  ok(h.view === 'diagnostic_history' && h.decision_use === 'forbidden' && h.covered_by_commit.seq === 1 && h.exact_commit_instant === false && h.queried_at_horizon.t_s === 1 && h.values[0].value === r.values[0].value, 'historical query: diagnostic-marked, records the covering commit and the horizon');
  refuses(() => assertRealtime(h), 'NOT_REALTIME', 'a historical result is refused by the real-time guard');
  assertRealtime(r); checks++;
  refuses(() => sampleHistorical(f, { kind: 'sensing_diagnostic', purpose: 'diagnosis' } as unknown as DiagnosticCapability, hq), 'NO_DIAGNOSTIC_CAPABILITY', 'a forged capability is refused');
  refuses(() => sampleHistorical(f, cap, { ...hq, purpose: 'replay' }), 'PURPOSE_MISMATCH', 'purpose must match the capability');
  refuses(() => sampleHistorical(f, cap, { ...hq, agent_id: 'a' } as HistoricalSampleQuery), 'HISTORICAL_QUERY_IS_NOT_A_SENSING_ACT', 'a historical query carrying an agent is refused');
  refuses(() => sampleHistorical(f, cap, { ...hq, at: { t_s: 2, round: 0 } }), 'FUTURE_SAMPLE', 'historical query after the latest commit refused');
  { const e = sampleHistorical(f, cap, { ...hq, at: { t_s: 0.1, round: 0 } }); ok(e.covered_by_commit.seq === 0 && e.covered_by_commit.time.t_s === 0.5 && !e.exact_commit_instant, 'an instant before the first commit is covered by the first commit (CHEM-1b covered_by_commit rule)'); }
  // zero-signal control field
  const z = new SyntheticChemicalField({ id: 'z', channel: 'ch', layer: 'L', field: { synthetic: true, kind: 'zero_signal' }, max_range_mm: 0 }); z.advance({ t_s: 1, round: 0 });
  const rz = sampleLocal(z.realtimeReader(), base);
  ok(z.kind === 'zero_signal' && rz.values.every((v) => v.value === 0) && rz.synthetic === true, 'explicit zero-signal field returns exactly 0 and is labelled synthetic');
}
// ---- CHEM-1b real-time reader adapter (declaration; fake reader with the CHEM-1b names). Not integrated.
{
  ok(ChemLocalFieldAdapter.integrated === false, 'CHEM adapter declared, not integrated');
  const seen: ChemSampleQueryLike[] = [];
  // fake CHEM-1b ChemRealtimeReader; `hz` is its latest commit (moved by a fake scheduler where needed)
  const fake = (get: () => SimTime | null, fail: string[] | null): ChemRealtimeReaderLike => ({
    kind: 'chem_realtime_reader',
    latestCommitted() { const h = get(); return h ? { seq: Math.round(h.t_s * 1000) + h.round, time: { clock: 'chem', unit: 's' as const, ...h } } : null; },
    sampleLocal(q) { seen.push(q); if (fail) { const e = new Error('CHEM_REFUSED') as Error & { codes: string[] }; e.codes = fail; throw e; } return { view: 'agent_local', read_kind: 'realtime_latest_committed', exposure: q.sensor.radius_mm === 0 ? 0 : Math.max(0, 1 - Math.abs(q.sensor.y_mm)), mean_density_per_mm2: 0.25 + q.sensor.x_mm / 1000, detectable: null }; },
  });
  const at = (h: SimTime | null) => () => h;
  const geometry = { body_length_mm: 2.5, antenna_len_mm: 1, antenna_half_angle_rad: 0.5 }, pose = { x: 10, y: 0.3, th: 0.1 };
  const req: LocalSampleRequest = { agent_id: 'w1', t_s: 2, round: 1, pose, geometry, sensors: antennaSensors(pose, geometry), layer: 'ground', channel: 'trail', range_mm: 0.2, source: 'chem_local_field', tags: [{ name: 'x', assumption: true, basis: '遊戲假設', note: '' }] };
  const ad = new ChemLocalFieldAdapter('chem', fake(at({ t_s: 2, round: 1 }), null), 'chem', ['trail'], 0.5);
  const r = sampleLocal(ad, req), q = seen[0];
  ok(r.source === 'chem_local_field' && r.synthetic === false && r.values.length === 2 && r.state_commit.seq === 2001 && r.sensing_time.round === 1, 'adapter result labelled chem_local_field, state commit carried over');
  ok(r.values[0].value === Math.max(0, 1 - Math.abs(req.sensors[0].y_mm)), 'disc sample (radius > 0) uses CHEM exposure');
  { seen.length = 0; const rp = sampleLocal(ad, { ...req, range_mm: 0 }); ok(rp.values[0].value === 0.25 + req.sensors[0].x_mm / 1000 && seen[0].sensor.radius_mm === 0, 'point sample (radius 0) uses CHEM mean_density_per_mm2 (exposure is 0 by definition)'); }
  ok(chemSensorValue({ exposure: 0, mean_density_per_mm2: null }, 0) === null, 'point sample without a density is a missing signal, not 0');
  ok(q.signal_id === 'trail' && q.agent_id === 'w1' && q.layer === 'ground' && q.phase === 'local_sensing' && q.time.t_s === 2 && q.time.round === 1 && q.time.unit === 's' && q.sensor.kind === 'disc' && q.sensor.radius_mm === 0.2 && q.sensor.x_mm === req.sensors[0].x_mm, 'request mapped onto the CHEM-1b SampleQuery names');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', fake(at({ t_s: 1, round: 0 }), null), 'chem', ['trail'], 0.5), req), 'FUTURE_SAMPLE', 'CHEM latest commit before the sensing instant: not yet committed → refused (same rule as CHEM)');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', fake(at({ t_s: 3, round: 0 }), null), 'chem', ['trail'], 0.5), req), 'STALE_SAMPLE', 'CHEM has a later commit → stale (same rule as CHEM)');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', fake(at({ t_s: 2, round: 1 }), ['CROSS_LAYER_SAMPLE']), 'chem', ['trail'], 0.5), req), 'MISSING_SIGNAL', 'a CHEM refusal is an error, not a fallback');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', fake(at(null), null), 'chem', ['trail'], 0.5), req), 'MISSING_SIGNAL', 'nothing committed in CHEM is an error');
  // model C with a CHEM reader: the scheduler (not the agent) moves CHEM's commit to each control instant
  let hz: SimTime | null = null;
  const sched = { advance: (to: SimTime) => { hz = { ...to }; } };
  const spec: WalkSpec = { ...trailAnt('C', 1, 0).spec, sampler: new ChemLocalFieldAdapter('chem', fake(() => hz, ['OUT_OF_BOUNDS:sensor']), 'chem', ['synthetic_trail'], 0.5), scheduler: sched };
  ok(spec.field !== null, 'precondition: the synthetic field is present in the spec');
  refuses(() => planWalk(spec), 'MISSING_SIGNAL', 'model C with a failing CHEM reader stops with an error (no fallback to the synthetic field)');
  hz = null;
  const ok2 = planWalk({ ...spec, sampler: new ChemLocalFieldAdapter('chem', fake(() => hz, null), 'chem', ['synthetic_trail'], 0.5) });
  ok(ok2.sensing?.source === 'chem_local_field' && ok2.sensor_samples.every((s) => s.source === 'chem_local_field' && s.synthetic === false && s.state_commit_t_s === s.t), 'with a CHEM reader and a scheduler, the output records chem_local_field and the commit per sensing instant');
}
// ---- CHEM-1b history adapter (diagnostic side; fake store, capability object supplied by the caller as CHEM would)
{
  const chemCap = Object.freeze({ kind: 'chem_diagnostic', purpose: 'diagnosis' });
  const calls: unknown[] = [];
  const store = { latestCommitted: () => ({ seq: 7, time: { clock: 'chem', unit: 's' as const, t_s: 5, round: 0 } }), sampleHistorical: (cap: unknown, q: { purpose: string; sensor: { radius_mm: number } }) => { calls.push([cap, q]); return { view: 'diagnostic_history' as const, decision_use: 'forbidden' as const, exposure: 0, mean_density_per_mm2: 0.5, covered_by_commit: { seq: 3, time: { clock: 'chem', unit: 's' as const, t_s: 2, round: 0 } } }; } };
  const hz = new ChemHistoryAdapter('chem-h', store, chemCap, 'chem', ['trail'], 0.5);
  const res = sampleHistorical(hz, createDiagnosticCapability('diagnosis'), { channel: 'trail', layer: 'ground', at: { t_s: 1.5, round: 0 }, points: [{ id: 'p', x_mm: 1, y_mm: 2 }], range_mm: 0, source: 'chem_local_field', purpose: 'diagnosis' });
  ok(res.view === 'diagnostic_history' && res.covered_by_commit.seq === 3 && res.values[0].value === 0.5 && res.queried_at_horizon.t_s === 5 && (calls[0] as unknown[])[0] === chemCap && ((calls[0] as unknown[])[1] as { purpose: string }).purpose === 'diagnosis', 'CHEM history adapter: ChemStore.sampleHistorical(CHEM capability, {..., purpose}) with the point density');
  ok(ChemHistoryAdapter.integrated === false && !('read' in hz), 'history adapter is declaration-only and has no real-time read');
}
ok(walkParams('C').model === 'C', 'parameters load');
console.log(JSON.stringify({ local_sensing: 'pass', checks }));
