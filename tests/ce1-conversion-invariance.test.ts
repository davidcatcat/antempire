/**
 * CE1 conversion invariance (docs/garden-supply-demand-audit.md §4.2; RU-1 = v2-review.32; tools/ce1-conversion-invariance.ts).
 * Non-official Day0 experiment worlds; a diagnostic of the model's units, never a target (CLAUDE.md §7).
 *  1. the scaled set is exactly the parameters whose declared unit is game_portion (RU-1), all non-null, and it equals
 *     the game-portion entries of the audit registry for species / world (one vocabulary);
 *  2. every declared portion parameter × 2 (exact in binary floating point): 5 foundings × summer / winter × seed
 *     20270001, 90 days — no structural divergence; portion outputs = 2 × baseline and all other outputs equal, up to the
 *     engine's 6-decimal rounding (measured deviation bounded);
 *  3. the CE1 finding is reproduced (negative control: the test can see unit mixing): leaving
 *     site_choice.score_base_offset unscaled — the audit's original portion set — diverges structurally;
 *  4. the committed report (reports/ce1-conversion-invariance/ce1.json) is complete and its rows for the cases re-run
 *     here are identical to a fresh run; parameter files are not modified by the experiment.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { CE1_FINDING, FACTORS, HORIZON_DAYS, OUT_DIR, SEEDS, portionParams, runCase, scaledBundle } from '../tools/ce1-conversion-invariance.ts';
import { REGISTRY } from '../tools/garden-supply-demand-audit.ts';
import { SUPPORTED_FOUNDINGS } from '../cli/lib/day0.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, f))).digest('hex');
const PARAM_FILES = ['species/pheidole-megacephala.json', 'world/xitun-garden.json'], before = PARAM_FILES.map(sha);

// 1
const base = loadBundle(), params = portionParams(base);
ok(params.length > 0 && params.every((p) => typeof p.value === 'number'), `1: ${params.length} declared portion parameters, all numeric`);
const reg = new Set(REGISTRY.filter((e) => (e.file === 'world' || e.file === 'species') && /^game_portion/.test(e.unit)).map((e) => `${e.file === 'world' ? 'world' : 'species:pheidole-megacephala'}#${e.path}`));
const got = new Set(params.map((p) => `${p.file}#${p.path}`));
ok(reg.size === got.size && [...reg].every((x) => got.has(x)), '1: the scaled set equals the audit registry\'s game-portion parameters of species / world');
const finding = `${CE1_FINDING.file}#${CE1_FINDING.path}`;
ok(got.has(finding), '1: the CE1 finding is declared a portion quantity');
const s2 = scaledBundle(2, [], base);
ok(params.every((p) => { const n: Any = (p.file === 'world' ? s2.world : (s2.species as Any)[p.file.split(':')[1]]); return p.path.split('.').reduce((o: Any, k) => o[k], n).value === 2 * (p.value as number); }), '1: scaling multiplies exactly those values (copy; the loaded bundle is untouched)');

// 2 + 4
const report = readJson<Any>(`${OUT_DIR}/ce1.json`);
ok(report.experiments.length === FACTORS.length + 1 && report.experiments.every((e: Any) => e.total === SUPPORTED_FOUNDINGS.length * 4 * SEEDS.length && e.cases.length === e.total), '4: the committed report has every experiment with every case');
ok(JSON.stringify(report.scaled_parameters) === JSON.stringify(params.map((p) => ({ file: p.file, path: p.path, value: p.value, unit: p.unit }))), '4: the committed report scaled exactly the current declared portion parameters');
const row = (exp: string, f: string, season: string, seed: number) => report.experiments.find((e: Any) => e.id === exp).cases.find((c: Any) => c.founding === f && c.season === season && c.seed === seed);
for (const f of SUPPORTED_FOUNDINGS) for (const season of ['summer', 'winter'] as const) {
  const r = runCase(f, season, SEEDS[0], 2, s2, base, HORIZON_DAYS);
  ok(r.first_structural_divergence_day === null, `2: ${f}-${season}: no structural divergence in ${HORIZON_DAYS} days with every portion parameter × 2 (${r.first_divergence_sample.join(' | ')})`);
  ok(r.max_scaled_dev_portions <= 1e-4 && r.max_unscaled_dev <= 1e-3, `2: ${f}-${season}: deviations are rounding-sized (|S/2 − B| ≤ ${r.max_scaled_dev_portions} 份, |S − B| ≤ ${r.max_unscaled_dev})`);
  ok(JSON.stringify(r) === JSON.stringify(row('declared_k2', f, season, SEEDS[0])), `4: ${f}-${season} equals the committed report row`);
}
// 3
const audSet = scaledBundle(2, [finding], base);
const neg = runCase('A3', 'winter', SEEDS[0], 2, audSet, base, HORIZON_DAYS);
ok(neg.first_structural_divergence_day !== null, `3: leaving ${CE1_FINDING.path} unscaled diverges structurally (day ${neg.first_structural_divergence_day}: ${neg.first_divergence_sample[0]})`);
ok(JSON.stringify(neg) === JSON.stringify(row('audit_set_k2', 'A3', 'winter', SEEDS[0])), '4: the negative control equals the committed report row');
ok(report.experiments.find((e: Any) => e.id === 'audit_set_k2').invariant < report.experiments.find((e: Any) => e.id === 'declared_k2').invariant, '3: in the committed report the audit set diverges in more cases than the declared set');

ok(PARAM_FILES.map(sha).every((h, i) => h === before[i]), '4: parameter files unchanged');
console.log(JSON.stringify({ test: 'ce1-conversion-invariance', checks, declared_portion_parameters: params.length, summary: report.experiments.map((e: Any) => `${e.id}: ${e.invariant}/${e.total}`) }));
