/**
 * R2 acceptance matrix (docs/r2-acceptance-matrix.json; Owner #201 condition 5). BLOCKING, light (reads files only).
 *  1. the committed matrix validates (cli/r2-matrix.ts): statuses, blocker flags and reasons, reference IDs, test and
 *     asset paths, BLOCKING / CI registration, assumption flags, wiring probes against the candidate-world sources,
 *     condition coverage, verdict;
 *  2. the validator is not vacuous: each class of dishonest or incomplete row is rejected (mutation checks);
 *  3. the generated blocks in docs/r2-go-no-go.md and docs/r2-day0-official-spec.md quote the matrix verbatim;
 *  4. the report keeps the candidate / experiment status: verdict NO-GO while any row blocks, no claim that the official
 *     Day0 is established;
 *  5. Owner #212 Q2 a: relaxing completeness (M08 open ecology, M19 reproduction) never relaxes the non-relaxable
 *     requirements, and the 「尚未模擬」 list is quoted in the report and the spec;
 *  6. M43: the ONE list (generated Worker module = save_meta.not_simulated) matches the matrix, carries every listed row's
 *     disclosure, and the disclosure row is 已接入 only with its probes in the Worker save metadata and the viewer.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { type Matrix, GO_NO_GO_FILE, NON_RELAXABLE_MIN, NOT_SIMULATED_MODULE, SPEC_FILE, listed, loadMatrix, notSimulatedItems, referenceIds, renderBlockers, renderNotSimulated, renderNotSimulatedModule, staleBlocks, summarize, validateMatrix } from '../cli/r2-matrix.ts';
import { P0A2_NOT_SIMULATED } from '../prototypes/continuous-world/worker/not-simulated.ts';
import { p0a2SaveMetaOf } from '../prototypes/continuous-world/worker/p0a2-world.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const m = loadMatrix();

// 1. the committed matrix is valid
const errors = validateMatrix(m);
ok(errors.length === 0, `matrix validates:\n${errors.join('\n')}`);
const s = summarize(m);
ok(s.counts['已接入'] + s.counts['簡化代理'] + s.counts['未接入'] === m.rows.length, 'every row has exactly one status');
ok(referenceIds(fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8')).has('R94'), 'reference parser finds R94');

// 2. mutation checks: the validator rejects each kind of problem
const mutate = (why: string, f: (x: Matrix) => void, expect: RegExp) => {
  const x = structuredClone(m); f(x);
  const e = validateMatrix(x);
  ok(e.some((msg) => expect.test(msg)), `rejects ${why} (got: ${e.slice(0, 3).join(' / ') || 'no error'})`);
};
const row = (x: Matrix, mod: string) => { const r = x.rows.find((y) => y.module === mod); assert.ok(r, mod); return r; };
mutate('a missing test file', (x) => { row(x, 'clock_scheduler').tests.push('tests/does-not-exist.test.ts'); }, /does not exist/);
mutate('已接入 with no tests', (x) => { row(x, 'clock_scheduler').tests = []; }, /needs at least one test/);
// a row marked 已接入 (with tests) for a mechanism that is not wired still fails: the probe must be in the candidate world
mutate('已接入 claimed for a mechanism absent from the Worker world', (x) => { const r = row(x, 'queen_oviposition'); r.status = '已接入'; r.probe = { text: 'oviposit' }; }, /已接入 but "oviposit" is not found in the candidate world/);
mutate('已接入 with a file-scoped probe in the wrong file', (x) => { const r = row(x, 'brood_stages'); r.status = '已接入'; r.probe = { file: 'web/src/v62.ts', text: 'larva' }; }, /not found in the candidate world \(web\/src\/v62\.ts\)/);
mutate('已接入 with a probe file outside the candidate world', (x) => { const r = row(x, 'food_sources'); r.status = '已接入'; r.probe = { file: 'engine/ecology.ts', text: 'hemiptera' }; }, /is not a candidate-world source/);
mutate('未接入 while the probe is in the Worker world', (x) => { row(x, 'queen_oviposition').probe = { text: 'engine/clock/solar.ts' }; }, /marked 未接入 but/);
mutate('未接入 while one of probe.any is in the Worker world', (x) => { row(x, 'death_consumption').probe!.any = ['drainPool']; }, /marked 未接入 but "drainPool" appears/);
mutate('簡化代理 without an approximation range', (x) => { row(x, 'weather').limits = '沒有說明'; }, /近似範圍/);
mutate('簡化代理 food source without an approximation range', (x) => { row(x, 'food_sources').limits = '單一情境蜜露源，固定產出。'; }, /M07: 簡化代理 must state its approximation range/);
mutate('簡化代理 without a probe', (x) => { delete row(x, 'individual_behaviour').probe; }, /簡化代理 needs a wiring probe/);
// Owner #212 Q2 a: completeness relaxed, honesty and the non-relaxable requirements not
mutate('a 未接入 row that does not declare 「尚未模擬」', (x) => { row(x, 'open_ecology').player_view = '未顯示。'; }, /M08: 未接入 must declare in player_view/);
mutate('a non-relaxable row (conservation) unblocked while not 已接入', (x) => { row(x, 'energy_mass_ledger').blocks_r2 = false; }, /energy_mass_ledger is non-relaxable/);
mutate('a non-relaxable row (life state) unblocked while not 已接入', (x) => { row(x, 'death_consumption').blocks_r2 = false; }, /death_consumption is non-relaxable/);
mutate('the disclosure row unblocked while not 已接入', (x) => { const r = row(x, 'not_simulated_disclosure'); r.status = '簡化代理'; r.limits = '近似範圍：測試用'; r.blocks_r2 = false; }, /not_simulated_disclosure is non-relaxable/);
mutate('dropping a module from non_relaxable_modules', (x) => { x.non_relaxable_modules = x.non_relaxable_modules.filter((y) => y !== 'determinism'); }, /must contain determinism/);
mutate('exempting a non-relaxable module from the disclosure', (x) => { x.disclosure_exempt_modules.push('brood_stages'); }, /brood_stages cannot be exempt/);
mutate('the disclosure row 已接入 without viewer and save-metadata probes', (x) => { const r = row(x, 'not_simulated_disclosure'); r.status = '已接入'; r.probe = { file: 'web/experiment.html', text: '非正式' }; delete r.probe_all; }, /needs probe_all entries in a web\/ viewer file and in a Worker save-metadata file/);
mutate('the disclosure row 已接入 with only a viewer probe', (x) => { row(x, 'not_simulated_disclosure').probe_all = row(x, 'not_simulated_disclosure').probe_all!.filter((p) => p.file.startsWith('web/')); }, /needs probe_all entries in a web\/ viewer file and in a Worker save-metadata file/);
mutate('the disclosure row 已接入 with probe_all texts that are absent', (x) => { const r = row(x, 'not_simulated_disclosure'); r.status = '已接入'; r.probe = { file: 'web/experiment.html', text: '非正式' }; r.probe_all = [{ file: 'web/src/v62.ts', text: 'NO-SUCH-DISCLOSURE-PANEL' }, { file: 'prototypes/continuous-world/worker/p0a2-world.ts', text: 'not_simulated: { ...P0A2_NOT_SIMULATED' }]; }, /probe_all "NO-SUCH-DISCLOSURE-PANEL" is not found/);
// M43 wiring: the generated list must be the matrix's (a change of a disclosure without --write, or a list module that was
// removed, fails), every listed row needs a disclosure that says what it is, and no disclosure may read as wiring
mutate('a disclosure changed without regenerating the list module', (x) => { row(x, 'caste').disclosure_zh = '大工蟻：尚未模擬（改寫但未重產）'; }, /not-simulated\.ts is missing or is not the list this matrix generates/);
mutate('a 未接入 row dropped from the list (status changed without --write)', (x) => { const r = row(x, 'alarm'); r.status = '簡化代理'; r.limits = '近似範圍：測試用'; r.disclosure_zh = '警戒：簡化代理'; }, /not-simulated\.ts is missing or is not the list this matrix generates/);
mutate('a listed row without disclosure_zh', (x) => { delete row(x, 'open_ecology').disclosure_zh; }, /M08: a listed row .* needs disclosure_zh/);
mutate('a 未接入 disclosure that does not say 尚未模擬', (x) => { row(x, 'reproduction').disclosure_zh = '完整繁殖'; }, /M19: disclosure_zh of a 未接入 row must say 尚未模擬/);
mutate('a 簡化代理 disclosure that does not say 簡化代理', (x) => { row(x, 'weather').disclosure_zh = '天氣：合成'; }, /M05: disclosure_zh of a 簡化代理 row must say 簡化代理/);
mutate('a disclosure on a 已接入 row', (x) => { row(x, 'light').disclosure_zh = '光照：尚未模擬'; }, /M04: disclosure_zh is only for rows of the/);
mutate('a disclosure that contains an unwired mechanism\'s probe', (x) => { row(x, 'caste').disclosure_zh = 'major workers：尚未模擬'; }, /disclosure_zh of M18 contains this 未接入 probe "major"/);
mutate('an unknown reference ID', (x) => { row(x, 'species').evidence_refs.push('R99999'); }, /not defined in docs\/references\.md/);
mutate('a missing blocker flag', (x) => { (row(x, 'species') as unknown as Record<string, unknown>).blocks_r2 = 'yes'; }, /blocks_r2 must be a boolean/);
mutate('an empty blocker reason', (x) => { row(x, 'physics_collision').blocker_reason = ''; }, /blocker_reason/);
mutate('a missing status', (x) => { (row(x, 'species') as unknown as Record<string, unknown>).status = '部分'; }, /status/);
mutate('a non-measured basis without assumption:true', (x) => { row(x, 'food_sources').assumption.flagged = false; }, /flagged must be true/);
mutate('a test not registered as BLOCKING', (x) => { row(x, 'species').tests.push('tests/run-all.ts'); }, /must be tests\/<name>\.test\.ts/);
mutate('a missing required module', (x) => { x.rows = x.rows.filter((r) => r.module !== 'verifier'); }, /verifier appears 0 times/);
mutate('GO while rows block', (x) => { x.verdict = 'GO'; }, /verdict GO but the rows give NO-GO/);
mutate('an undefined Owner decision', (x) => { row(x, 'species').owner_decision = 'O-99'; }, /owner decision O-99/);
mutate('an uncovered R2 condition', (x) => { for (const r of x.rows) r.r2_conditions = r.r2_conditions.filter((c) => c !== 6); x.rows.forEach((r) => { if (r.r2_conditions.length === 0) r.r2_conditions = [1]; }); }, /condition 6 is covered by no row/);
mutate('a missing asset path', (x) => { row(x, 'species').existing_assets.push('species/not-a-file.json'); }, /asset .* does not exist/);

// stale 「尚未模擬」 list: a status change without --write makes both documents stale
{ const x = structuredClone(m); row(x, 'open_ecology').status = '簡化代理'; row(x, 'open_ecology').limits = '近似範圍：測試用'; const st = staleBlocks(x); ok(st.some((e) => /r2-go-no-go\.md: block not-simulated/.test(e)) && st.some((e) => /r2-day0-official-spec\.md: block not-simulated/.test(e)), `a changed 尚未模擬 list makes the documents stale (got: ${st.join(' / ')})`); }

// 3. the documents quote the matrix verbatim
const stale = staleBlocks(m);
ok(stale.length === 0, `generated blocks are current:\n${stale.join('\n')}`);
const report = fs.readFileSync(path.join(REPO_ROOT, GO_NO_GO_FILE), 'utf8');
for (const r of m.rows.filter((x) => x.blocks_r2)) ok(report.includes(`| ${r.id} |`), `go/no-go lists blocker ${r.id}`);
ok(report.includes(renderBlockers(m)), 'go/no-go blocker list equals the generated list');
ok(report.includes(renderNotSimulated(m)), 'go/no-go quotes the generated 尚未模擬 list');

// 4. candidate status is kept
ok(m.verdict === 'NO-GO' && s.blockers > 0, 'current verdict is NO-GO with explicit blockers');
ok(/判定：\*\*NO-GO\*\*/.test(report), 'the report states NO-GO');
ok(/候選／實驗世界/.test(report) && /候選／實驗世界/.test(fs.readFileSync(path.join(REPO_ROOT, SPEC_FILE), 'utf8')), 'both documents keep the 候選／實驗世界 label');
ok(!/正式 Day0 已(成立|啟用)/.test(report.replace(/不得宣稱正式 Day0 已(成立|啟用)/g, '')), 'the report does not claim the official Day0 is established');

// 5. Owner #212 Q2 a (2026-11-13): M08 / M19 no longer block, but are listed as 尚未模擬; the non-relaxable set holds
for (const mod of ['open_ecology', 'reproduction']) { const r = m.rows.find((y) => y.module === mod)!; ok(r.blocks_r2 === false && r.status === '未接入' && r.player_view.includes('尚未模擬') && renderNotSimulated(m).includes(`${r.id} `), `${mod}: not blocking, 未接入 and listed as 尚未模擬`); }
for (const mod of NON_RELAXABLE_MIN) { const r = m.rows.find((y) => y.module === mod)!; ok(r.status === '已接入' || r.blocks_r2, `${mod}: non-relaxable, blocks unless 已接入`); }
// 6. M43 (2026-11-13): the list is wired into the Worker save metadata and the viewer
{
  const d = m.rows.find((y) => y.module === 'not_simulated_disclosure')!;
  ok(d.status === '已接入' && d.probe_all!.some((p) => p.file === 'prototypes/continuous-world/worker/p0a2-world.ts') && d.probe_all!.some((p) => p.file.startsWith('web/')), 'M43 is 已接入 with probes in the Worker save metadata and the viewer');
  ok(fs.readFileSync(path.join(REPO_ROOT, NOT_SIMULATED_MODULE), 'utf8') === renderNotSimulatedModule(m), 'the generated list module is current');
  const items = notSimulatedItems(m), lst = m.rows.filter((r) => listed(m, r));
  ok(JSON.stringify(P0A2_NOT_SIMULATED.items) === JSON.stringify(items) && items.length === lst.length && lst.every((r) => items.some((i) => i.row === r.id && i.label_zh === r.disclosure_zh)), `the Worker list = every listed matrix row with its disclosure (${items.length})`);
  ok(m.rows.filter((r) => r.status === '未接入' && listed(m, r)).every((r) => items.some((i) => i.row === r.id && i.status === '未接入' && i.label_zh.includes('尚未模擬'))), 'every unwired mechanism is listed as 尚未模擬');
  for (const mod of ['open_ecology', 'reproduction', 'queen_oviposition', 'brood_stages', 'death_consumption', 'caste', 'chemistry_trail']) ok(items.some((i) => i.row === row(m, mod).id && i.status === '未接入'), `${mod} is on the 尚未模擬 list`);
  ok(items.find((i) => i.row === row(m, 'chemistry_trail').id)!.label_zh.includes('擴散尚未模擬'), 'the trail chemistry entry says 擴散尚未模擬 (#213 Q1 a)');
  const meta = p0a2SaveMetaOf('exp-m43', 1).not_simulated;
  ok(JSON.stringify(meta) === JSON.stringify(P0A2_NOT_SIMULATED) && meta.items !== P0A2_NOT_SIMULATED.items, 'P0-A2 save_meta.not_simulated is the generated list (a copy, not the shared object)');
}

console.log(JSON.stringify({ test: 'r2-acceptance-matrix', checks, verdict: m.verdict, counts: s.counts, blockers: s.blocker_ids }));
