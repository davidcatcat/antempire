/**
 * CHEM-2 sensitivity-grid PRE-REGISTRATION lock (Owner ruling #213 Q3 a; docs/chem2-sensitivity-prereg.md). BLOCKING.
 *  1. the pre-registration file is frozen: its SHA-256 equals the pinned value below (D6: any change needs a NEW version
 *     file; v1 stays). The doc quotes the same hash.
 *  2. the grid is exactly the ruled one: half-life {0,5,10,17,30,60} min (0 = λ = 0 baseline) × Q10 {off,1.5,2,3} ×
 *     {cool, hot} = 48 cells; scenarios, metrics, seeds and decision rules D1–D6 are present; status is an exploratory
 *     sensitivity range, never a calibration.
 *  3. bench equality: WHEN prototypes/chem2/bench.ts exists (CHEM-2, PR #205, is merged to main), its exported grid,
 *     reference temperature, weather, probes, deposit schedule, clock seed and sample step must equal this file.
 *     TODO(#205): until CHEM-2 is on main this check is inactive and the test says so in its output; it activates
 *     automatically once the bench file is present (no edit needed here).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const FILE = path.join(REPO_ROOT, 'prototypes/chem2-prereg/preregistration.v1.json');
const PINNED_SHA256 = '4e41bc25442ef71c31ff37f7ef510446ac72223d78acaa96aaddfc9317986b43';

// 1. frozen
const raw = fs.readFileSync(FILE, 'utf8');
ok(sha256Hex(raw) === PINNED_SHA256, `pre-registration v1 is frozen (sha256 ${sha256Hex(raw)}); a change needs a new version file (D6)`);
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/chem2-sensitivity-prereg.md'), 'utf8');
ok(doc.includes(PINNED_SHA256) && doc.includes('chem2-sens-prereg-v1'), 'the doc quotes the pinned hash and the version id');
ok(/探索性敏感度範圍/.test(doc) && /不是校準/.test(doc), 'the doc states: exploratory sensitivity range, not calibration');

// 2. content
const R = JSON.parse(raw);
ok(R.schema === 'antempire.chem2-prereg.v1' && R.id === 'chem2-sens-prereg-v1' && R.official === false, 'schema, id, non-official');
ok(R.status === 'exploratory_sensitivity_range' && /不是校準/.test(R.status_zh), 'status: exploratory sensitivity range, not calibration');
const G = R.grid;
assert.deepEqual(G.half_life_min.map((x: { label: string }) => x.label), ['0', '5', '10', '17', '30', '60']); checks++;
assert.deepEqual(G.half_life_min.map((x: { bench_value: number | null }) => x.bench_value), [null, 5, 10, 17, 30, 60]); checks++;
ok(/λ = 0/.test(G.half_life_min[0].meaning_zh), 'half-life "0" is the λ = 0 baseline (zero boundary), stated explicitly');
assert.deepEqual(G.q10.map((x: { label: string }) => x.label), ['off', '1.5', '2', '3']); checks++;
assert.deepEqual(G.q10.map((x: { bench_value: number | null }) => x.bench_value), [null, 1.5, 2, 3]); checks++;
assert.deepEqual(G.weather.map((w: { label: string; t_min_c: number; t_max_c: number }) => [w.label, w.t_min_c, w.t_max_c]), [['cool', 18, 24], ['hot', 26, 34]]); checks++;
ok(G.weather.every((w: { synthetic: boolean }) => w.synthetic === true), 'weather is labelled synthetic');
ok(G.cells_total === G.half_life_min.length * G.q10.length * G.weather.length && G.cells_total === 48, '48 cells');
ok(/不得省略/.test(G.degenerate_cells_rule_zh), 'degenerate (mathematically identical) cells are listed, never dropped');
assert.deepEqual(R.seeds.clock_seed, [11]); checks++;
assert.deepEqual(R.scenarios.main.map((s: { id: string }) => s.id), ['S1-laden', 'S1-explore', 'S3-ratio']); checks++;
ok(R.scenarios.secondary_fixed.length === 3, 'secondary scenarios fixed (S2, M2, S4)');
assert.deepEqual(R.probes_s_after_noon, [7200, 9000, 10800, 14400, 21600, 64800]); checks++;
assert.deepEqual(R.metrics.map((m: { id: string }) => m.id), ['M-read', 'M-residual', 'M-remain', 'M-ratio', 'M-zero']); checks++;
assert.deepEqual(R.decision_rules.map((d: { id: string }) => d.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6']); checks++;
ok(/補充/.test(R.decision_rules[4].zh) && /新版本/.test(R.decision_rules[4].zh), 'D5: supplementary runs are versioned separately');
ok(/不得/.test(R.decision_rules[3].zh) && /已校準/.test(R.decision_rules[3].zh), 'D4: no cell may be called best / calibrated');

// 3. bench equality (activates when CHEM-2 is on main)
const BENCH = path.join(REPO_ROOT, 'prototypes/chem2/bench.ts');
let benchCheck = 'inactive: prototypes/chem2/bench.ts not on this branch (TODO #205: activates automatically once CHEM-2 is merged)';
if (fs.existsSync(BENCH)) {
  // dynamic URL import: the module may not exist on this branch, so it is not a static (type-checked) dependency
  const B = await import(pathToFileURL(BENCH).href);
  assert.deepEqual(B.HALF_LIVES_MIN, G.half_life_min.map((x: { bench_value: number | null }) => x.bench_value)); checks++;
  assert.deepEqual(B.Q10S, G.q10.map((x: { bench_value: number | null }) => x.bench_value)); checks++;
  ok(B.T_REF_C === G.half_life_reference_temperature_c, 'bench reference temperature');
  assert.deepEqual(Object.entries(B.WEATHER).map(([k, w]) => [k, (w as { t_min_c: number }).t_min_c, (w as { t_max_c: number }).t_max_c]), G.weather.map((w: { label: string; t_min_c: number; t_max_c: number }) => [w.label, w.t_min_c, w.t_max_c])); checks++;
  assert.deepEqual(B.PROBES_S, R.probes_s_after_noon); checks++;
  assert.deepEqual([B.EXPLORE.from_s, B.EXPLORE.to_s, B.LADEN.from_s, B.LADEN.to_s], [...R.deposit_schedule_s_after_noon.explore, ...R.deposit_schedule_s_after_noon.laden]); checks++;
  const cfg = B.clockCfg();
  ok(R.seeds.clock_seed.includes(cfg.seed) && cfg.sample_step_min === R.fixed_setup.sample_step_min, 'bench clock seed and sample step');
  assert.deepEqual(B.ANCHOR, R.fixed_setup.anchor); checks++;
  assert.deepEqual(B.SITE, R.fixed_setup.site); checks++;
  assert.deepEqual(B.SHAPE, R.fixed_setup.temperature_shape); checks++;
  assert.deepEqual([B.COVER.t0_s, B.COVER.t1_s], R.fixed_setup.cover_s); checks++;
  benchCheck = 'active: prototypes/chem2/bench.ts grid equals the pre-registration';
}
console.log(JSON.stringify({ test: 'chem2-prereg', checks, bench_check: benchCheck }));
