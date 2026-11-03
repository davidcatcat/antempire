/**
 * Issue #51 (Issue #49 N3 / #43 R12): every input the Day0 evaluation actually reads is in the input manifest and the
 * configuration hash, and a change to it makes committed research data invalid until the input is restored.
 * All mutations happen in an ISOLATED COPY of the repository (a temp directory); the real files are never touched.
 *  1  the manifest is derived from actual reads: the climatology and every scenario file the initializer reads are in
 *     it (with sha256, schema and source); no hand-written list;
 *  2  the climatology is a real input: January 17 → 27 °C changes the Day0 state (Codex: prior_air_temp_c 17.04 → 27.04);
 *  3  Codex's case: January 17 → 27 °C changes configHash; the committed data fail validation; restored → pass again;
 *  4  the same for other needed inputs (garden, seasons, a founding file); an UNRELATED data file changes nothing;
 *  5  data written before Issue #51 (v19, v20) are not rewritten: without the later re-verification
 *     (provenance-attestation.json) they report a provenance gap; with it, a changed input still invalidates them;
 *  6  data with a v2 manifest (as future runs write it) are invalidated by a climate change and pass when restored.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { day0DataInputs } from '../cli/lib/input-manifest.ts';
import { ATTESTATION, configHash, dataDirs, inputManifest, validate, validateCommitted } from '../cli/reports/phase2-sensitivity.ts';
import { readJson } from '../cli/lib/load.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const CLIMATE = 'data/taichung-climatology-1991-2020.json';

// isolated copy of everything the evaluation and its validator read
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-issue51-'));
for (const d of ['cli', 'engine', 'species', 'world', 'scenarios', 'data', 'rules', 'tests/golden']) fs.cpSync(path.join(REPO_ROOT, d), path.join(tmp, d), { recursive: true });
fs.mkdirSync(path.join(tmp, 'reports'));
for (const d of fs.readdirSync(path.join(REPO_ROOT, 'reports')).filter((x) => /^phase2-sensitivity(-v\d+)?$|^day0-v\d+$/.test(x))) fs.cpSync(path.join(REPO_ROOT, 'reports', d), path.join(tmp, 'reports', d), { recursive: true, filter: (f) => !f.includes('/.work') });
const edit = (rel: string, fn: (j: Any) => void) => { const p = path.join(tmp, rel), orig = fs.readFileSync(p, 'utf8'), j = JSON.parse(orig); fn(j); fs.writeFileSync(p, JSON.stringify(j, null, 2)); return () => fs.writeFileSync(p, orig); };
const dirsTmp = () => dataDirs().map((d) => path.join(tmp, 'reports', path.basename(d)));
const allValid = () => dirsTmp().map((d) => validateCommitted(d, tmp));

try {
  // 1 manifest from actual reads
  const inputs = day0DataInputs(tmp), man = inputManifest(tmp);
  ok(inputs.includes(CLIMATE) && inputs.includes('scenarios/day0/garden.json') && inputs.includes('scenarios/day0/seasons.json') && inputs.some((f) => f.startsWith('scenarios/day0/founding-')), `1: the initializer's actual reads include the climatology and the scenarios (${inputs.join(', ')})`);
  ok(man.data[CLIMATE]?.sha256 && man.data[CLIMATE].schema === 'antempire.taichung.climate_normals.v1' && man.data[CLIMATE].source, '1: the climatology is recorded with sha256, schema and source');
  ok(Object.keys(man.code).includes('cli/lib/day0.ts') && Object.keys(man.code).includes('cli/reports/day0-evaluation.ts'), '1: code = the import closure of the evaluation script');

  // 2 the climatology is a real input of Day0
  const prior = (root: string) => (buildDay0('A1', 1, '2027-01-15', loadBundle(root), root).state as Any).climate.prior_air_temp_c;
  const p0 = prior(tmp);
  const restoreJan = edit(CLIMATE, (j) => { j.monthly_climatology[0].mean_air_temperature_c = 27; });
  const p1 = prior(tmp);
  ok(Math.abs(p0 - 17.039557) < 1e-6 && Math.abs(p1 - 27.039557) < 1e-6, `2: January 17 → 27 °C moves the Day0 prior_air_temp_c ${p0} → ${p1}`);
  restoreJan();

  // 3 Codex's case
  const cfg0 = configHash(undefined, tmp), base = allValid();
  ok(base.every((v) => v.ok), `3: committed data valid before the change (${base.map((v) => v.errors[0] ?? 'ok').join(' | ')})`);
  const undo = edit(CLIMATE, (j) => { j.monthly_climatology[0].mean_air_temperature_c = 27; });
  const cfg1 = configHash(undefined, tmp), changed = allValid();
  ok(cfg1 !== cfg0, '3: configHash changes when only the climatology changes');
  ok(changed.every((v) => !v.ok && v.errors.some((e) => /taichung-climatology/.test(e))), `3: every committed dataset is now invalid (${changed.map((v) => v.errors.find((e) => /climatology/.test(e)) ?? 'NOT DETECTED').join(' | ')})`);
  undo();
  ok(configHash(undefined, tmp) === cfg0 && allValid().every((v) => v.ok), '3: restoring the input restores the hash and validity');

  // 4 other needed inputs; an unrelated data file
  for (const [rel, fn] of [['scenarios/day0/garden.json', (j: Any) => { j.__test_change = 1; }], ['scenarios/day0/seasons.json', (j: Any) => { j.__test_change = 1; }], ['scenarios/day0/founding-A3.json', (j: Any) => { j.__test_change = 1; }]] as const) {
    const u = edit(rel, fn), h = configHash(undefined, tmp), v = allValid(); u();
    ok(h !== cfg0 && v.every((x) => !x.ok), `4: changing ${rel} changes configHash and invalidates the data`);
  }
  const unrelated = fs.readdirSync(path.join(tmp, 'data')).find((f) => f.endsWith('.json') && `data/${f}` !== CLIMATE && !inputs.includes(`data/${f}`)) as string;
  const u2 = edit(`data/${unrelated}`, (j) => { j.__test_change = 1; });
  ok(configHash(undefined, tmp) === cfg0 && allValid().every((v) => v.ok), `4: changing an unrelated data file (data/${unrelated}) changes nothing`);
  u2();

  // 5 legacy data: attestation required, never rewritten
  for (const d of dirsTmp()) {
    const att = path.join(d, ATTESTATION), saved = fs.readFileSync(att, 'utf8'), a = JSON.parse(saved);
    ok(/LATER RE-VERIFICATION/.test(a.statement) && a.verified_by.rows_rerun === a.verified_by.rows_equal && a.verified_by.rows_rerun === 400, `5: ${path.basename(d)} attestation is a later re-verification with 400/400 baseline rows reproduced`);
    fs.rmSync(att);
    const v = validateCommitted(d, tmp);
    ok(!v.ok && v.errors.some((e) => /provenance gap/.test(e)), `5: without it ${path.basename(d)} reports a provenance gap (${v.errors[0]})`);
    fs.writeFileSync(att, saved);
    const orig = fs.readFileSync(path.join(REPO_ROOT, 'reports', path.basename(d), 'sensitivity.json'));
    ok(Buffer.compare(orig, fs.readFileSync(path.join(d, 'sensitivity.json'))) === 0, `5: ${path.basename(d)}/sensitivity.json is not rewritten`);
  }

  // 6 v2-manifest data (as written from now on)
  const d0 = dirsTmp().at(-1) as string, doc = JSON.parse(fs.readFileSync(path.join(d0, 'sensitivity.json'), 'utf8'));
  doc.input_manifest = inputManifest(tmp);
  const opts = { root: tmp, day0Eval: readJson(`reports/day0-${doc.rules_tag}/evaluation.json`, tmp), tables: fs.readFileSync(path.join(d0, 'sensitivity-tables.md'), 'utf8') };
  ok(validate(doc, opts).ok, '6: a dataset recording the v2 manifest validates');
  const u3 = edit(CLIMATE, (j) => { j.monthly_climatology[0].mean_air_temperature_c = 27; });
  const v6 = validate(doc, opts);
  ok(!v6.ok && v6.errors.some((e) => /input data changed.*taichung-climatology/.test(e)), `6: a climate change invalidates it (${v6.errors[0]})`);
  u3();
  ok(validate(doc, opts).ok, '6: restored → valid');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log(`issue51-input-manifest: ${checks} checks passed`);
