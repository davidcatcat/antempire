/**
 * Local chemical sensing contract (engine/physics/local-sensing.ts; docs/kin2d-local-sensing.md). Blocking.
 *  - model C reads chemistry only through sampleLocal(); its outputs are bit-identical to before the refactor (digest
 *    recorded before the change; the §8 tables and pose streams are also checked verbatim by natural-walk.test.ts);
 *  - requests carry agent, time, pose-derived antenna points, layer, channel, range, source and assumption tags;
 *  - no whole-field read, no future read, no silent fallback from CHEM to synthetic, source recorded in the output.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { walkDigest } from './lib-walk-digest.ts';
import { planWalk, type WalkSpec } from '../engine/physics/natural-walk.ts';
import { sampleLocal, antennaSensors, SyntheticChemicalField, ChemLocalFieldAdapter, SensingRefused, type LocalChemSampler, type LocalSampleRequest, type ChemSampleQueryLike, type ChemStoreLike } from '../engine/physics/local-sensing.ts';
import { trailAnt, walkParams, trailField, body } from '../prototypes/natural-walk/lib.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (f: () => unknown, code: string, why: string) => { try { f(); } catch (e) { ok(e instanceof SensingRefused && e.codes.some((c) => c.startsWith(code)), `${why} (${(e as Error).message})`); return; } ok(false, `${why}: no refusal`); };
const json = (x: unknown) => JSON.stringify(x);

// ---- bit-identical outputs (digest recorded before the refactor at b8a3fe6b…, 750 runs)
{
  const d = walkDigest();
  ok(d.runs === 750 && d.digest === 'b8a3fe6b08c66556e4f06629396d814d7d1c9cf4fd5d6184b42cd9f11095f63f', `natural-walk outputs bit-identical to before the sensing refactor (got ${d.digest})`);
}
// ---- model C goes through the contract only
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/natural-walk.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const body_ = src.slice(src.indexOf('export function planWalk'));
  ok(body_.includes('sampleLocal(') && !/fieldValue\(|ridgeValue\(|\.polyline|sigma_mm/.test(body_), 'planWalk reads chemistry only via sampleLocal (no direct field evaluation)');
  const { plan } = trailAnt('C', 3, 2);
  ok(plan.sensing?.source === 'synthetic' && plan.sensing.synthetic === true && plan.sensor_samples.length > 0 && plan.sensor_samples.every((s) => s.source === 'synthetic' && s.synthetic === true), 'model C output records its source (synthetic)');
  ok(trailAnt('B', 3, 2).plan.sensing === null, 'model B has no chemical sensing');
  // a spying sampler sees every request; results identical to the default synthetic sampler
  const reqs: LocalSampleRequest[] = [];
  const spec0 = trailAnt('C', 3, 2).spec;
  const inner = new SyntheticChemicalField({ id: 'spy', channel: 'synthetic_trail', layer: 'default', field: trailField(), committed_through_s: spec0.t0_s + spec0.max_duration_s, max_range_mm: 0 });
  const spy: LocalChemSampler = { source: inner.source, synthetic: inner.synthetic, id: 'spy', max_range_mm: 0, committedThrough: (c, l) => inner.committedThrough(c, l), read: (q) => { reqs.push(q); return inner.read(q); } };
  const p2 = planWalk({ ...spec0, sampler: spy });
  ok(json(p2.track.segs) === json(plan.track.segs) && json(p2.sensor_samples.map((s) => [s.left, s.right])) === json(plan.sensor_samples.map((s) => [s.left, s.right])), 'injected sampler gives the identical plan');
  ok(reqs.length === plan.sensor_samples.length, 'one contract request per control step');
  ok(reqs.every((q) => q.agent_id === spec0.id && q.layer === 'default' && q.channel === 'synthetic_trail' && q.range_mm === 0 && q.source === 'synthetic' && q.tags.length >= 3 && q.tags.every((t) => t.assumption === true && t.basis === '遊戲假設') && q.t_s <= spec0.t0_s + spec0.max_duration_s), 'requests carry agent, time ≤ committed, layer, channel, range, source and assumption tags');
  ok(reqs.every((q) => json(q.sensors) === json(antennaSensors(q.pose, q.geometry)) && q.geometry.body_length_mm === body().length_mm), 'sensor points are the antenna tips of the actual pose');
}
// ---- no whole-field read
{
  const f = new SyntheticChemicalField({ id: 's', channel: 'ch', layer: 'L', field: trailField(), committed_through_s: 10, max_range_mm: 0 });
  ok(!('field' in f) && !Object.keys(f).some((k) => /field|cfg|polyline/.test(k)) && json(f).indexOf('polyline') < 0, 'the synthetic field is not readable as a whole (private)');
}
// ---- refusals
{
  const f = new SyntheticChemicalField({ id: 's', channel: 'ch', layer: 'L', field: trailField(), committed_through_s: 5, max_range_mm: 0 });
  const geometry = { body_length_mm: 2.5, antenna_len_mm: 1, antenna_half_angle_rad: 0.5 }, pose = { x: 10, y: 0.3, th: 0.1 };
  const base: LocalSampleRequest = { agent_id: 'a', t_s: 1, round: 0, pose, geometry, sensors: antennaSensors(pose, geometry), layer: 'L', channel: 'ch', range_mm: 0, source: 'synthetic', tags: [{ name: 'x', assumption: true, basis: '遊戲假設', note: '' }] };
  const r = sampleLocal(f, base);
  ok(r.source === 'synthetic' && r.synthetic === true && r.values.length === 2 && r.values[0].value > 0, 'valid request returns a local, labelled result');
  refuses(() => sampleLocal(f, { ...base, t_s: 5.5 }), 'FUTURE_SAMPLE', 'sample after the committed time is refused');
  refuses(() => sampleLocal(f, { ...base, source: 'chem_local_field' }), 'SOURCE_MISMATCH', 'a CHEM request sent to the synthetic field is refused (no silent swap)');
  refuses(() => sampleLocal(f, { ...base, sensors: [{ ...base.sensors[0], x_mm: base.sensors[0].x_mm + 5 }, base.sensors[1]] }), 'SENSOR_NOT_FROM_POSE', 'a sensor point not derived from the pose is refused');
  refuses(() => sampleLocal(f, { ...base, range_mm: 3 }), 'RANGE_ABOVE_BOUND', 'range above the sampler bound is refused');
  refuses(() => sampleLocal(f, { ...base, range_mm: Infinity }), 'UNBOUNDED_RANGE', 'unbounded range refused');
  refuses(() => sampleLocal(f, { ...base, tags: [] }), 'MISSING:assumption_tags', 'missing assumption tags refused');
  refuses(() => sampleLocal(f, { ...base, agent_id: '' }), 'MISSING:agent_id', 'missing agent refused');
  refuses(() => sampleLocal(f, { ...base, channel: 'other' }), 'MISSING_SIGNAL', 'unknown channel is a missing signal (error)');
  refuses(() => sampleLocal(f, { ...base, layer: 'other' }), 'MISSING_SIGNAL', 'other layer is a missing signal (error)');
}
// ---- CHEM LocalField adapter (declaration; fake store with the CHEM-1 names). Not integrated.
{
  ok(ChemLocalFieldAdapter.integrated === false, 'CHEM adapter declared, not integrated');
  const seen: ChemSampleQueryLike[] = [];
  const store = (h: { t_s: number; round: number } | null, fail: string[] | null): ChemStoreLike => ({
    get horizon() { return h ? { clock: 'chem', unit: 's' as const, ...h } : null; },
    sampleLocal(q) { seen.push(q); if (fail) { const e = new Error('CHEM_REFUSED') as Error & { codes: string[] }; e.codes = fail; throw e; } return { view: 'agent_local', exposure: Math.max(0, 1 - Math.abs(q.sensor.y_mm)), detectable: null }; },
  });
  const geometry = { body_length_mm: 2.5, antenna_len_mm: 1, antenna_half_angle_rad: 0.5 }, pose = { x: 10, y: 0.3, th: 0.1 };
  const req: LocalSampleRequest = { agent_id: 'w1', t_s: 2, round: 1, pose, geometry, sensors: antennaSensors(pose, geometry), layer: 'ground', channel: 'trail', range_mm: 0.2, source: 'chem_local_field', tags: [{ name: 'x', assumption: true, basis: '遊戲假設', note: '' }] };
  const ad = new ChemLocalFieldAdapter('chem', store({ t_s: 2, round: 1 }, null), 'chem', ['trail'], 0.5);
  const r = sampleLocal(ad, req), q = seen[0];
  ok(r.source === 'chem_local_field' && r.synthetic === false && r.values.length === 2, 'adapter result labelled chem_local_field, not synthetic');
  ok(q.signal_id === 'trail' && q.agent_id === 'w1' && q.layer === 'ground' && q.phase === 'local_sensing' && q.time.t_s === 2 && q.time.round === 1 && q.time.unit === 's' && q.sensor.kind === 'disc' && q.sensor.radius_mm === 0.2 && q.sensor.x_mm === req.sensors[0].x_mm, 'request mapped onto the CHEM-1 SampleQuery names');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', store({ t_s: 1, round: 0 }, null), 'chem', ['trail'], 0.5), req), 'FUTURE_SAMPLE', 'CHEM horizon before the sample time: future read refused');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', store({ t_s: 2, round: 1 }, ['CROSS_LAYER_SAMPLE']), 'chem', ['trail'], 0.5), req), 'MISSING_SIGNAL', 'a CHEM refusal is an error, not a fallback');
  refuses(() => sampleLocal(new ChemLocalFieldAdapter('chem', store(null, null), 'chem', ['trail'], 0.5), req), 'MISSING_SIGNAL', 'nothing committed in CHEM is an error');
  // model C with a failing CHEM sampler and a synthetic field present: must throw, never silently use the field
  const spec: WalkSpec = { ...trailAnt('C', 1, 0).spec, sampler: new ChemLocalFieldAdapter('chem', store({ t_s: 60, round: 0 }, ['OUT_OF_BOUNDS:sensor']), 'chem', ['synthetic_trail'], 0.5) };
  ok(spec.field !== null, 'precondition: the synthetic field is present in the spec');
  refuses(() => planWalk(spec), 'MISSING_SIGNAL', 'model C with a failing CHEM sampler stops with an error (no fallback to the synthetic field)');
  const ok2 = planWalk({ ...spec, sampler: new ChemLocalFieldAdapter('chem', store({ t_s: 60, round: Number.MAX_SAFE_INTEGER }, null), 'chem', ['synthetic_trail'], 0.5) });
  ok(ok2.sensing?.source === 'chem_local_field' && ok2.sensor_samples.every((s) => s.source === 'chem_local_field' && s.synthetic === false), 'with a CHEM sampler, the output records chem_local_field');
}
ok(walkParams('C').model === 'C', 'parameters load');
console.log(JSON.stringify({ local_sensing: 'pass', checks }));
