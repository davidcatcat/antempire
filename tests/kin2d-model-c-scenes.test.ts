/**
 * Model C in every scene (Owner decision 46; docs/kin2d-model-c-scenes.md) and the preserved failure record (Owner
 * decisions 41/46). Blocking.
 *  - every scene declares its chemical field; scenes without a chemical signal use the explicit zero-signal field;
 *    no field at all → model C refuses (no fallback);
 *  - C on the zero-signal field is bit-identical to B (same seeds); with the ridge present it differs;
 *  - the data files regenerate byte-identically; the document tables are reproduced verbatim;
 *  - the original model-C failure record (§8 of docs/physics-kinematics2d.md), the O-R133 operator, the diagnosis and the
 *    PR A pose streams are byte-identical (SHA-256 pinned). Diagnostics, not targets: no assertion on biology.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { serialised, sceneDefs, runOne, scenesTable, identityTable, SCENES_DIR } from '../prototypes/natural-walk/scenes-c.ts';
import { allWalkTables } from '../prototypes/natural-walk/measure.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const file = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p));

// ---- preserved records (byte-identical)
{
  const kd = file('docs/physics-kinematics2d.md').toString('utf8'), s8 = kd.slice(kd.indexOf('## 8. 與 R133'), kd.indexOf('## 9. 姿態串流'));
  ok(sha(s8) === 'd7376d3e523e154778c94e040a7aca627e8c553d97010f36b700c9c8bf340da5', 'original model-C failure record (§8) byte-identical');
  ok(sha(allWalkTables().validation) === '50fc605da358a755c685487a14dca059addc5f8b49e34120a8313b580d26dc30' && s8.includes(allWalkTables().validation), 'the §8 validation table still recomputes to the same bytes');
  ok(sha(file('docs/kin2d-model-c-diagnosis.md')) === 'ab9602dd4e1213fd25076dbcdb0fed76ef395a6f24976ce86f7e1c5629f61f79', 'model-C diagnosis document byte-identical');
  ok(sha(file('docs/kin2d-r133-observation-operator.md')) === '6d8b12c8cd170677579b89d538d23e070bc6369dd53698267e062b1c088d9c6c', 'pre-registered O-R133 operator byte-identical (no threshold, sampling or dead-band change)');
  const streams: Record<string, string> = { 'exploration-B.json': 'cd0420498687f28adcfe13cf7bc06b89c78568d9e697ac7ce02c8488798875dd', 'obstacle-turn.json': 'cb6558e4d6d7dc13156c0691286f488aa992d48ea0b798f8637af06ba7b92af6', 'straight-vs-natural.json': '4e836a0267b43037607c461cb5d4d39cce414af7b495923bc64f7105c6e14dd0', 'trail-following-C.json': '1a2f19d75e16e94b3ca9cb75e5520676821658a09db7fcf91417262517a4af47' };
  for (const [f, h] of Object.entries(streams)) ok(sha(file(`prototypes/natural-walk/data/${f}`)) === h, `PR A pose stream ${f} byte-identical`);
}
// ---- every scene declares its field; no invented attractive field
for (const sc of sceneDefs()) {
  const c = sc.variants.filter((v) => v.model === 'C');
  ok(c.some((v) => v.field.kind === 'absent'), `${sc.id}: model C also run with no field (control)`);
  if (sc.scene_signal === 'none') ok(c.every((v) => v.field.kind !== 'gaussian_ridge') && c.some((v) => v.field.kind === 'zero_signal'), `${sc.id}: no chemical signal in the scene → explicit zero-signal field, no ridge`);
  else ok(c.some((v) => v.field.kind === 'gaussian_ridge') && c.some((v) => v.field.kind === 'zero_signal'), `${sc.id}: signal present, with a zero-signal control`);
}
// ---- zero signal ≡ B; absent refuses; present differs (spot checks; the full counts are in the table)
for (const sc of sceneDefs()) for (const seed of [100, 207]) for (const i of [0, 3]) {
  const b = runOne(sc, sc.variants.find((v) => v.label === 'B')!, seed, i), z = runOne(sc, sc.variants.find((v) => v.label === 'C／零訊號')!, seed, i), a = runOne(sc, sc.variants.find((v) => v.label === 'C／無訊號')!, seed, i);
  ok(JSON.stringify(b.plan!.track.segs) === JSON.stringify(z.plan!.track.segs) && JSON.stringify(b.res) === JSON.stringify(z.res), `${sc.id}/${seed}/${i}: C on the zero-signal field is bit-identical to B`);
  ok(z.plan!.sensing?.synthetic === true && z.plan!.sensor_samples.every((s) => s.left.c === 0 && s.right.c === 0 && s.state_commit_t_s === s.t), `${sc.id}/${seed}/${i}: zero field sensed through the contract (values 0, state commit = sensing time)`);
  ok(a.refused !== null && /needs a \(synthetic\) field/.test(a.refused), `${sc.id}/${seed}/${i}: no field → model C refuses (no fallback)`);
  if (sc.scene_signal === 'present') { const r = runOne(sc, sc.variants.find((v) => v.label === 'C／訊號存在')!, seed, i); ok(JSON.stringify(r.plan!.track.segs) !== JSON.stringify(b.plan!.track.segs), `${sc.id}/${seed}/${i}: with the signal present C differs from B`); }
}
// ---- data reproducible; tables verbatim
{
  const files = serialised();
  for (const [name, text] of Object.entries(files)) ok(fs.readFileSync(path.join(SCENES_DIR, name), 'utf8') === text, `model-c-scenes/${name} regenerates byte-identically`);
  ok(fs.readdirSync(SCENES_DIR).sort().join(',') === Object.keys(files).sort().join(','), 'no stray files in model-c-scenes/');
  const summary = JSON.parse(files['summary.json']);
  ok(summary.scenes.every((s: { c_zero_vs_b_bit_identical: string }) => s.c_zero_vs_b_bit_identical === '75/75'), 'summary: C (zero signal) = B in 75/75 plans of every scene');
  for (const f of Object.keys(files).filter((n) => n !== 'summary.json')) { const s = JSON.parse(files[f]); ok(s.label === '隔離物理實驗・非正式' && s.chem_field && s.chem_field.synthetic === true, `${f}: labelled non-official, field labelled synthetic`); }
  const doc = file('docs/kin2d-model-c-scenes.md').toString('utf8');
  ok(doc.includes(scenesTable(summary)) && doc.includes(identityTable(summary)), 'docs/kin2d-model-c-scenes.md contains both tables verbatim (rerun node prototypes/natural-walk/scenes-c.ts)');
}
console.log(JSON.stringify({ kin2d_model_c_scenes: 'pass', checks }));
