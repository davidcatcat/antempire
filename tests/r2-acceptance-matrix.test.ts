/**
 * R2 acceptance matrix (docs/r2-acceptance-matrix.json; Owner #201 condition 5). BLOCKING, light (reads files only).
 *  1. the committed matrix validates (cli/r2-matrix.ts): statuses, blocker flags and reasons, reference IDs, test and
 *     asset paths, BLOCKING / CI registration, assumption flags, wiring probes against the candidate-world sources,
 *     condition coverage, verdict;
 *  2. the validator is not vacuous: each class of dishonest or incomplete row is rejected (mutation checks);
 *  3. the generated blocks in docs/r2-go-no-go.md and docs/r2-day0-official-spec.md quote the matrix verbatim;
 *  4. the report keeps the candidate / experiment status: verdict NO-GO while any row blocks, no claim that the official
 *     Day0 is established.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { type Matrix, GO_NO_GO_FILE, SPEC_FILE, loadMatrix, referenceIds, renderBlockers, staleBlocks, summarize, validateMatrix } from '../cli/r2-matrix.ts';

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
mutate('已接入 claimed for a mechanism absent from the Worker world', (x) => { const r = row(x, 'individual_behaviour'); r.status = '已接入'; }, /not found in the candidate world/);
mutate('未接入 while the probe is in the Worker world', (x) => { row(x, 'species').probe = { text: 'engine/clock/solar.ts' }; }, /marked 未接入 but/);
mutate('簡化代理 without an approximation range', (x) => { row(x, 'weather').limits = '沒有說明'; }, /近似範圍/);
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

// 3. the documents quote the matrix verbatim
const stale = staleBlocks(m);
ok(stale.length === 0, `generated blocks are current:\n${stale.join('\n')}`);
const report = fs.readFileSync(path.join(REPO_ROOT, GO_NO_GO_FILE), 'utf8');
for (const r of m.rows.filter((x) => x.blocks_r2)) ok(report.includes(`| ${r.id} |`), `go/no-go lists blocker ${r.id}`);
ok(report.includes(renderBlockers(m)), 'go/no-go blocker list equals the generated list');

// 4. candidate status is kept
ok(m.verdict === 'NO-GO' && s.blockers > 0, 'current verdict is NO-GO with explicit blockers');
ok(/判定：\*\*NO-GO\*\*/.test(report), 'the report states NO-GO');
ok(/候選／實驗世界/.test(report) && /候選／實驗世界/.test(fs.readFileSync(path.join(REPO_ROOT, SPEC_FILE), 'utf8')), 'both documents keep the 候選／實驗世界 label');
ok(!/正式 Day0 已(成立|啟用)/.test(report.replace(/不得宣稱正式 Day0 已(成立|啟用)/g, '')), 'the report does not claim the official Day0 is established');

console.log(JSON.stringify({ test: 'r2-acceptance-matrix', checks, verdict: m.verdict, counts: s.counts, blockers: s.blocker_ids }));
