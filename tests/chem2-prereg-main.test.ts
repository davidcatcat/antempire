/**
 * CHEM-2 sensitivity MAIN ANALYSIS (Owner ruling #213 Q3 a; docs/chem2-sensitivity-prereg.md,
 * docs/chem2-sensitivity-main-results.md). BLOCKING.
 *  1. the committed report (reports/chem2-prereg-main/main-analysis.{json,md}) regenerates byte-identically from
 *     prototypes/chem2-prereg/main-analysis.ts, and references the FROZEN pre-registration hash;
 *  2. D1: the 48 main cells are present in each main scenario, in the registered order half-life → Q10 → weather,
 *     built here from preregistration.v1.json; S3 (20), S2 (4), S1-M2 (18), S4 (1) are present;
 *  3. equivalence flags: every flag points to the first earlier cell whose readings and residual are bitwise identical
 *     in an INDEPENDENT bench run, every cell with such a twin is flagged, and every mathematically equivalent cell
 *     (λ = 0 rows, Q10 OFF cool/hot) is flagged;
 *  4. D2 checks are computed for every cell and agree with an independent recomputation; negative samples fail;
 *  5. D3 is recomputed; D4: no "best" / "calibrated" language outside the disclaimer; non-official header.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';
import { buildReport, d2Single, OUT_DIR, PREREG_PATH } from '../prototypes/chem2-prereg/main-analysis.ts';
import { crossingRun, singleTrail, singleTrailM2 } from '../prototypes/chem2/bench.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
/** the value pinned in tests/chem2-prereg.test.ts (frozen v1) */
const PINNED_SHA256 = '4e41bc25442ef71c31ff37f7ef510446ac72223d78acaa96aaddfc9317986b43';
const bitEq = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
type Cell = { index: number; cell_id: string; half_life_min: string; q10: string; weather: 'cool' | 'hot'; M_read: number[]; M_residual: number; deposited: number; M_zero: number; math_equivalent_class: string | null; bitwise_identical_to: string | null; d2: { pass: boolean; reasons: string[]; checks: { id: string; applies: boolean; pass: boolean }[] } };

// 1. regeneration + frozen hash
const preregRaw = fs.readFileSync(path.join(REPO_ROOT, PREREG_PATH), 'utf8');
const R = JSON.parse(preregRaw);
ok(sha256Hex(preregRaw) === PINNED_SHA256, 'pre-registration v1 unchanged');
const gen = buildReport(), again = buildReport();
ok(gen.json === again.json && gen.md === again.md, 'reporter is deterministic within a process');
const onDiskJson = fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'main-analysis.json'), 'utf8');
const onDiskMd = fs.readFileSync(path.join(REPO_ROOT, OUT_DIR, 'main-analysis.md'), 'utf8');
ok(onDiskJson === gen.json, 'main-analysis.json regenerates byte-identically (re-run node prototypes/chem2-prereg/main-analysis.ts --write)');
ok(onDiskMd === gen.md, 'main-analysis.md regenerates byte-identically');
const J = JSON.parse(onDiskJson);
ok(J.prereg.sha256 === PINNED_SHA256 && J.prereg.id === 'chem2-sens-prereg-v1' && onDiskMd.includes(PINNED_SHA256), 'report references the frozen pre-registration hash');
ok(/^[0-9a-f]{40}$/.test(J.code.base_commit) && onDiskMd.includes(J.code.base_commit), 'report records the code base commit');
ok(J.code.sources.some((s: { path: string }) => s.path === 'prototypes/chem2/bench.ts') && J.code.sources.some((s: { path: string }) => s.path === 'engine/chemistry/kinetics.ts')
  && J.code.sources.every((s: { path: string; sha256: string }) => sha256Hex(fs.readFileSync(path.join(REPO_ROOT, s.path), 'utf8')) === s.sha256), 'source lock covers the bench and the chemistry and matches the files');
ok(J.official === false && /非正式/.test(J.status_zh) && /不是校準/.test(J.status_zh) && /不代表本種/.test(J.status_zh), 'header: non-official, not a calibration, not focal-species values');
const mdHead = onDiskMd.split('\n').slice(0, 4).join('\n');
ok(/非正式/.test(mdHead) && /不是校準/.test(mdHead) && /不代表本種/.test(mdHead), 'md header: non-official / not a calibration / not focal-species values');
ok(J.temperature_input === R.fixed_setup.temperature_input && J.temperature_input === 'air_temp_c_surrogate' && /SURF-0/.test(J.temperature_input_zh) && /未接入/.test(J.temperature_input_zh), 'temperature input: air-temperature proxy; SURF-0 not connected');
ok(J.clock_seed === 11 && JSON.stringify(J.probes_s_after_noon) === JSON.stringify(R.probes_s_after_noon), 'seed and probes as registered');

// 2. D1: cells and order from the pre-registration
const order: string[] = [];
for (const h of R.grid.half_life_min) for (const q of R.grid.q10) for (const w of R.grid.weather) order.push(`hl=${h.label};q10=${q.label};${w.label}`);
ok(order.length === 48, '48 registered cells');
assert.deepEqual(Object.keys(J.main), ['S1-laden', 'S1-explore']); checks++;
for (const sid of ['S1-laden', 'S1-explore']) {
  const cells: Cell[] = J.main[sid];
  assert.deepEqual(cells.map((c) => c.cell_id), order, `${sid}: 48 cells in the registered order`); checks++;
  ok(cells.every((c, i) => c.index === i && c.M_read.length === R.probes_s_after_noon.length), `${sid}: every cell has every probe reading`);
  const mdRows = onDiskMd.split(`## ${sid}（`)[1].split('\n## ')[0].split('\n').filter((l) => /^\| \d+ \|/.test(l));
  ok(mdRows.length === 48 && mdRows.every((l, i) => l.startsWith(`| ${i + 1} |`)), `${sid}: md table expands all 48 cells`);
}
const s3order = R.grid.half_life_min.filter((h: { bench_value: number | null }) => h.bench_value !== null).flatMap((h: { label: string }) => R.grid.q10.map((q: { label: string }) => `hl=${h.label};q10=${q.label}`));
assert.deepEqual(J['S3-ratio'].map((x: { cell_id: string }) => x.cell_id), s3order); checks++;
ok(J.secondary['S2-crossing'].length === 4 && J.secondary['S1-M2'].length === 18 && typeof J.secondary['S4-rain-off'].cell_id === 'string', 'secondary scenarios present (4, 18, 1)');
assert.deepEqual(J.secondary['S2-crossing'].map((c: { cell_id: string }) => c.cell_id), ['hl=0;q10=off;cool', 'hl=17;q10=off;cool', 'hl=17;q10=2;cool', 'hl=17;q10=2;hot']); checks++;

// 3. equivalence flags, against an independent bench run
const hv = (l: string) => R.grid.half_life_min.find((x: { label: string }) => x.label === l).bench_value as number | null;
const qv = (l: string) => R.grid.q10.find((x: { label: string }) => x.label === l).bench_value as number | null;
for (const [sid, part] of [['S1-laden', 'laden'], ['S1-explore', 'explore']] as const) {
  const cells: Cell[] = J.main[sid];
  const fresh = cells.map((c) => singleTrail(hv(c.half_life_min), qv(c.q10), c.weather, part));
  ok(cells.every((c, i) => bitEq(c.M_read, fresh[i].values) && Object.is(c.M_residual, fresh[i].residual)), `${sid}: committed readings equal an independent run bitwise`);
  for (let i = 0; i < cells.length; i++) {
    const twin = fresh.findIndex((f, j) => j < i && bitEq(f.values, fresh[i].values) && Object.is(f.residual, fresh[i].residual));
    ok(cells[i].bitwise_identical_to === (twin < 0 ? null : cells[twin].cell_id), `${sid} ${cells[i].cell_id}: flag equals the actual first bitwise twin`);
  }
  const mathEq = cells.filter((c) => c.half_life_min === '0' || c.q10 === 'off');
  ok(mathEq.length === 18 && mathEq.every((c) => c.math_equivalent_class !== null), `${sid}: 18 cells in the registered equivalence classes`);
  ok(mathEq.filter((c) => c.bitwise_identical_to !== null).length === 12, `${sid}: 7 λ = 0 cells + 5 Q10-OFF hot cells carry a bitwise flag`);
  ok(cells.filter((c) => c.half_life_min === '0').slice(1).every((c) => c.bitwise_identical_to === 'hl=0;q10=off;cool'), `${sid}: λ = 0 row flagged against its first cell`);
  const flags = onDiskMd.split(`## ${sid}（`)[1].split('\n## ')[0].split('逐位元相同').length - 1;
  ok(flags === cells.filter((c) => c.bitwise_identical_to !== null).length, `${sid}: md shows every 「逐位元相同」 flag`);
}

// 4. D2 computed and recomputed
const ids = ['nan_or_negative', 'ledger_residual', 'no_increase_after_last_deposit', 'lambda0_constant_after_last_deposit', 'q10_off_weather_bitwise'];
for (const [sid, last, n] of [['S1-laden', R.deposit_schedule_s_after_noon.laden[1], 45], ['S1-explore', R.deposit_schedule_s_after_noon.explore[1], 15]] as const) {
  const cells: Cell[] = J.main[sid];
  for (const c of cells) {
    assert.deepEqual(c.d2.checks.map((k) => k.id), ids); checks++;
    const v = c.M_read, after = v.filter((_, i) => R.probes_s_after_noon[i] >= last);
    const pair = cells.filter((e) => e.half_life_min === c.half_life_min && e.q10 === 'off');
    const expect = [
      v.every((x) => !Number.isNaN(x) && x >= 0),
      Math.abs(c.M_residual) <= 1e-9 * c.deposited,
      after.every((x, i) => i === 0 || x <= after[i - 1]),
      c.half_life_min !== '0' || after.every((x) => Object.is(x, after[0])),
      c.q10 !== 'off' || (pair.length === 2 && bitEq(pair[0].M_read, pair[1].M_read)),
    ];
    ok(c.d2.checks.every((k, i) => k.pass === expect[i]) && c.d2.pass === expect.every(Boolean), `${sid} ${c.cell_id}: D2 recomputed`);
    ok(c.d2.checks[3].applies === (c.half_life_min === '0') && c.d2.checks[4].applies === (c.q10 === 'off'), `${sid} ${c.cell_id}: D2 applicability`);
    ok(c.deposited === n, `${sid}: deposits as registered (${n})`);
    ok(c.M_zero === v.filter((x) => x === 0 || Math.abs(x) < 1e-12).length, `${sid} ${c.cell_id}: M-zero recomputed (underflow kept)`);
  }
  ok(J.summary[sid].d2_failures.length === cells.filter((c) => !c.d2.pass).length, `${sid}: every D2 failure is listed`);
}
// negative samples: the checks do fail
const neg = (v: number[], res: number, l0 = false) => d2Single(v, [7200, 9000], 7200, res, 45, l0, true).filter((k) => k.applies && !k.pass).map((k) => k.id);
assert.deepEqual(neg([0.1, NaN], 0), ['nan_or_negative']); checks++;
assert.deepEqual(neg([0.1, -1e-30], 0), ['nan_or_negative']); checks++;
assert.deepEqual(neg([0.1, 0.05], 1e-6), ['ledger_residual']); checks++;
assert.deepEqual(neg([0.1, 0.2], 0), ['no_increase_after_last_deposit']); checks++;
assert.deepEqual(neg([0.1, 0.05], 0, true), ['lambda0_constant_after_last_deposit']); checks++;
// secondary: recomputed against independent runs
for (const c of J.secondary['S2-crossing']) {
  const r = crossingRun(hv(c.half_life_min), qv(c.q10), c.weather);
  ok((Object.keys(r.probes) as (keyof typeof r.probes)[]).every((k) => bitEq(c.M_read[k], r.probes[k])) && c.d2.checks.length > 0 && c.d2.pass === c.d2.checks.every((k: { applies: boolean; pass: boolean }) => !k.applies || k.pass), `S2 ${c.cell_id}: readings and D2 present`);
}
for (const c of J.secondary['S1-M2']) {
  const r = singleTrailM2(c.half_life_F_min, c.lambdaE_over_lambdaF, c.q10, c.weather);
  ok(bitEq(c.E, r.E) && bitEq(c.F, r.F) && c.d2.checks.length === 8, `M2 ${c.cell_id}: readings and D2 present`);
}
const s4 = J.secondary['S4-rain-off'];
ok(s4.rain_mm === 5 && s4.rain_intervals_s.length === 1 && s4.rain_timing_known === true && s4.bitwise_identical === (bitEq(s4.dry, s4.wet_washoff_null) && Object.is(s4.residual.dry, s4.residual.wet)), 'S4: a real rain interval exists and the bitwise comparison is recorded as computed');

// 5. D3 and D4
const i16 = R.probes_s_after_noon.indexOf(14400);
for (const x of J['S3-ratio']) {
  const L: Cell[] = J.main['S1-laden'];
  const hot = L.find((c) => c.cell_id === `${x.cell_id};hot`)!, cool = L.find((c) => c.cell_id === `${x.cell_id};cool`)!;
  ok(Object.is(x.M_ratio, hot.M_read[i16] / cool.M_read[i16]) && x.D3 === (Math.abs(x.M_ratio - 1) > 0.1 ? '溫度敏感' : '溫度不敏感'), `S3 ${x.cell_id}: ratio and D3 recomputed`);
}
const banned = /最佳|已校準|校準值|best|calibrated|optimal|推薦|建議採用/i;
const offending = [...onDiskMd.split('\n'), ...onDiskJson.split('\n')].filter((l) => banned.test(l) && !/不從網格挑出/.test(l));
ok(offending.length === 0, `D4: no best / calibrated language outside the disclaimer (${offending.slice(0, 3).join(' / ')})`);

console.log(JSON.stringify({ test: 'chem2-prereg-main', checks, d2_failures: { laden: J.summary['S1-laden'].d2_failures.length, explore: J.summary['S1-explore'].d2_failures.length }, s3_d3: J.summary['S3-ratio'].D3_counts }));
