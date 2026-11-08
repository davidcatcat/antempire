/**
 * Natural-walk candidates A/B/C (Issue #157 Owner addendum; docs/physics-kinematics2d.md §7–§9). Checks: determinism and
 * per-agent named streams, limits always respected, time-correlated (not per-frame independent) heading control, model C
 * refuses to run without its synthetic field, motion is collision-checked by the independent checker, the pose streams
 * (`antempire.pose-stream.v1`) are reproduced byte-identically and labelled, and the R133 validation tables in the
 * document are reproduced verbatim (they are diagnostics, not targets: no assertion on agreement with R133).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { planWalk, validateParams, type WalkSpec } from '../engine/physics/natural-walk.ts';
import { runKinematics, Kin2DRefused } from '../engine/physics/kinematics2d.ts';
import { walkParams, trailAnt, body, trailField, LABEL } from '../prototypes/natural-walk/lib.ts';
import { serialised, DATA_DIR } from '../prototypes/natural-walk/export.ts';
import { allWalkTables } from '../prototypes/natural-walk/measure.ts';
import { toRecord, loadCandidates } from '../prototypes/kinematics2d/lib.ts';
import { checkRecord } from '../prototypes/kinematics2d-check/check.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);

// ---- parameters: every natural-walk value is labelled assumption:true
{
  const nw = loadCandidates().natural_walk;
  for (const grp of ['baseline', 'exploration']) for (const [k, v] of Object.entries(nw[grp] as Record<string, { assumption: boolean; basis: string }>)) ok(v.assumption === true && typeof v.basis === 'string', `${grp}.${k} assumption:true with basis`);
  ok(nw.fixed_before_validation === true, 'parameters declared fixed before validation');
}

// ---- determinism, per-agent streams
{
  const a = trailAnt('B', 3, 4), b = trailAnt('B', 3, 4), c = trailAnt('B', 4, 4);
  ok(json(a.plan) === json(b.plan) && json(a.res) === json(b.res), 'same seed → identical plan and run');
  ok(json(a.plan.track.segs) !== json(c.plan.track.segs), 'different seed → different path');
  const spec = (id: string): WalkSpec => ({ id, body: body(), start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed: 9, params: walkParams('B'), goal_heading_rad: 0, end_x_mm: 50, max_duration_s: 10, statics: [], field: null });
  ok(json(planWalk(spec('x')).track.segs) === json(planWalk(spec('x')).track.segs) && json(planWalk(spec('x')).track.segs) !== json(planWalk(spec('y')).track.segs), 'named stream per agent id');
}

// ---- limits respected; time correlation (no per-frame independent left/right draws)
for (const m of ['A', 'B', 'C'] as const) {
  const p = walkParams(m);
  let viol = 0;
  for (let i = 0; i < 10; i++) { const { plan } = trailAnt(m, 1, i); for (const s of plan.track.segs) if (Math.abs(s.tw.w) > p.max_turn_rate_rad_s * (1 + 1e-12) || (s.tw.v > 0 && Math.abs(s.tw.w) > p.max_curvature_per_mm * s.tw.v * (1 + 1e-12))) viol++; }
  ok(viol === 0, `model ${m}: turn-rate and curvature limits respected on every segment`);
}
{
  const { plan } = trailAnt('B', 2, 0), w = plan.track.segs.filter((s) => s.tw.v > 0).map((s) => s.tw.w), m = w.reduce((a, b) => a + b, 0) / w.length;
  let num = 0, den = 0; for (let i = 0; i + 1 < w.length; i++) { num += (w[i] - m) * (w[i + 1] - m); den += (w[i] - m) ** 2; }
  ok(num / den > 0.8, `B: angular rate is time-correlated (lag-1 autocorrelation ${(num / den).toFixed(3)} > 0.8; independent per-frame draws would give ≈ 0)`);
  ok(trailAnt('A', 2, 0).plan.track.segs.every((s) => s.tw.w === 0), 'A: straight baseline (ω = 0)');
}

// ---- refusals
assert.throws(() => planWalk({ id: 'c', body: body(), start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed: 1, params: walkParams('C'), goal_heading_rad: 0, end_x_mm: 10, max_duration_s: 5, statics: [], field: null }), Kin2DRefused); checks++;
assert.throws(() => validateParams({ ...walkParams('B'), ou_tau_s: null as unknown as number }), Kin2DRefused); checks++;
assert.throws(() => validateParams({ ...walkParams('B'), avoid_turn_rate_rad_s: 99 }), Kin2DRefused); checks++;
ok(trailField().synthetic === true, 'model C field is labelled synthetic');

// ---- pose streams: byte-identical regeneration, labels, schema; obstacle scene collision-checked independently
{
  const files = serialised();
  ok(Object.keys(files).sort().join(',') === 'exploration-B.json,obstacle-turn.json,straight-vs-natural.json,trail-following-C.json', 'four viewing scenes');
  for (const [name, text] of Object.entries(files)) {
    ok(fs.readFileSync(path.join(DATA_DIR, name), 'utf8') === text, `${name} reproduced byte-identically (rerun node prototypes/natural-walk/export.ts)`);
    const s = JSON.parse(text);
    ok(s.schema === 'antempire.pose-stream.v1' && s.label === LABEL && typeof s.seed === 'number' && typeof s.dt_record_s === 'number', `${name}: schema and label 隔離物理實驗・非正式`);
    for (const a of s.agents) {
      ok(a.samples.length > 10 && a.samples.every((q: Record<string, number>) => ['t', 'x_mm', 'y_mm', 'theta', 'v_mm_s', 'omega_rad_s'].every((k) => typeof q[k] === 'number')), `${name}/${a.id}: samples complete`);
      ok(!('head_yaw' in a.samples[0]) && !('antenna' in a.samples[0]), `${name}/${a.id}: no head/antenna angles in physics output`);
      if (a.sensor_samples) ok(a.sensor_samples.every((q: { synthetic: boolean }) => q.synthetic === true), `${name}/${a.id}: sensor samples labelled synthetic`);
    }
    if (s.chem_field) ok(s.chem_field.synthetic === true, `${name}: chem field synthetic`);
  }
  const obs = JSON.parse(files['obstacle-turn.json']);
  ok(obs.agents[0].events.some((e: { kind: string }) => e.kind === 'antenna_contact_pivot') && obs.agents[0].events.some((e: { kind: string }) => e.kind === 'arrive'), 'obstacle scene: the ant turns and continues to its end point');
  // rebuild the obstacle run and certify it independently
  const spec: WalkSpec = { id: 'ant-1', body: body(), start: { x: 0, y: 0, th: 0 }, t0_s: 0, seed: obs.seed, params: walkParams('B'), goal_heading_rad: 0, end_x_mm: 60, max_duration_s: 15, statics: obs.obstacles, field: null };
  const plan = planWalk(spec), input = { tracks: [plan.track], statics: obs.obstacles, horizon_s: plan.arrival_t_s as number }, res = runKinematics(input), chk = checkRecord(toRecord(input, res));
  ok(chk.violations.length === 0 && chk.uncertified === 0, `obstacle scene: independent checker clean (${chk.violations[0] ?? ''})`);
}

// ---- validation tables (diagnostics) reproduced verbatim in the document
{
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/physics-kinematics2d.md'), 'utf8');
  for (const [k, t] of Object.entries(allWalkTables())) ok(doc.includes(t), `docs/physics-kinematics2d.md contains the natural-walk ${k} table verbatim (rerun node prototypes/natural-walk/measure.ts)`);
}
console.log(JSON.stringify({ natural_walk: 'pass', checks }));
