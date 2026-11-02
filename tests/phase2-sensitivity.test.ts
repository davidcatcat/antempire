/**
 * Phase 2 sensitivity data — lightweight CI checks (Owner 2026-11-02, PR #34 review fixes 4–7). The full yearly
 * sensitivity run (44 jobs × 80 seeds × 365 days) is NOT run here; instead:
 *  1. the committed results pass the validator: 44 jobs × 80 rows, every (season, seed) exactly once, no duplicate,
 *     row-level consistency, summaries recomputed, baseline rows identical to the v19 Day0 evaluation, engine and
 *     parameter fingerprints equal to the repository, per-job parameter hashes, tables regenerated identically;
 *  2. the file keeps every raw seed row in the compact layout (one row per line, no indentation);
 *  3. a few fixed seeds of non-baseline variants are re-run and must reproduce their stored rows exactly;
 *  4. the validator rejects corrupted data (dropped / duplicated row, edited summary, other fingerprint, baseline drift);
 *  5. batches: the merge refuses a missing, foreign-batch, stale-configuration, extra, unfinished or wrong-job shard,
 *     and a shard process exiting non-zero stops the run before any merge.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../cli/lib/load.ts';
import {
  OUT, dataDirs, runnableBundleFor, ROW_COLUMNS, ROWS_PER_JOB, assertShardsOk, jobs, mergeShards, seedRow, spawnShards, toObject, validate, validateCommitted, variantBundle, writeShard, type Job,
} from '../cli/reports/phase2-sensitivity.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

// 1–3 for EVERY committed data directory (v2-review.19 data are archived, never overwritten; later versions have their own)
let text = '', doc: Any = null;
const dirs = dataDirs();
ok(dirs.length >= 1, `sensitivity data directories: ${dirs.map((d) => path.basename(d)).join(', ')}`);
for (const dir of dirs) {
  const t = fs.readFileSync(path.join(dir, 'sensitivity.json'), 'utf8'), dc = JSON.parse(t), name = path.basename(dir);
  if (!doc) { text = t; doc = dc; }
  // 1. committed results
  const v = validateCommitted(dir);
  ok(v.ok, `${name}: committed sensitivity results validate:\n${v.errors.join('\n')}`);
  ok(v.checks.jobs === 44 && v.checks.rows === 44 * 80 && v.checks.season_seed_pairs_per_job === 80, `${name}: 44 × 80 rows (${JSON.stringify(v.checks)})`);
  ok(v.checks.baseline_rows_equal_day0_evaluation === '400/400', `${name}: baseline rows equal the ${dc.rules_tag} Day0 evaluation (${v.checks.baseline_rows_equal_day0_evaluation})`);
  ok(v.checks.summaries_recomputed === 44 && v.checks.variant_param_hashes_ok === 44 && v.checks.tables_regenerated_equal === true, `${name}: summaries, parameter hashes and tables recomputed`);
  // 2. layout: complete but compact
  const lines = t.split('\n');
  ok(lines.length < 5000, `${name}: compact layout: ${lines.length} lines (was > 100 000)`);
  ok(lines.filter((l) => l.startsWith('[') && l.replace(/,$/, '').endsWith(']')).length >= 44 * 80, `${name}: one raw seed row per line`);
  ok(!/^\s/m.test(t), `${name}: no indentation`);
  ok(dc.jobs.every((j: Any) => j.rows.every((r: Any[]) => r.length === ROW_COLUMNS.length)), `${name}: every row has every column`);
  // 3. fixed-seed reruns of non-baseline variants (and one grid cell), with the parameters of the version that produced
  // the data (archived v2-review.19 data: current engine with the later switches set back, which reproduces v19 exactly)
  const base = runnableBundleFor(dc);
  const RERUN: [string, string, number][] = [['caf0.25_rmin0.5_A4', 'winter', 20270003], ['caf0.5_rmin1_A5', 'spring', 20270010], ['caf0.75_rmin0.25_A1', 'autumn', 20270020], ['caf1_rmin0.5_A2', 'summer', 20270007]];
  for (const [id, season, seed] of RERUN) {
    const j = dc.jobs.find((x: Any) => x.id === id), stored = j.rows.map(toObject).find((r: Any) => r.season === season && r.seed === seed);
    const fresh = seedRow(j, season as Any, seed, variantBundle(j, base));
    assert.deepEqual(JSON.parse(JSON.stringify(fresh)), stored, `${name}: ${id} ${season} ${seed} reproduces`); checks++;
  }
}
void OUT;

// 4. the validator catches corruption
const day0Eval = readJson(`reports/day0-${doc.rules_tag}/evaluation.json`);
const bad = (mutate: (d: Any) => void, expect: RegExp, why: string) => {
  const d = JSON.parse(text); mutate(d);
  const r = validate(d, { day0Eval });
  ok(!r.ok && r.errors.some((e) => expect.test(e)), `${why}: ${r.errors.slice(0, 3).join(' | ') || 'NOT DETECTED'}`);
};
bad((d) => d.jobs[3].rows.pop(), /rows ≠ 80|distinct season\/seed/, 'dropped row');
bad((d) => { d.jobs[5].rows[1] = [...d.jobs[5].rows[0]]; }, /duplicate season\/seed/, 'duplicated row');
bad((d) => { d.summaries[d.jobs[0].id].all.queen_alive_365 += 1; }, /summaries differ/, 'edited summary');
bad((d) => { d.rules_fingerprint.engine = '0'.repeat(64); }, /fingerprint/, 'other engine fingerprint');
bad((d) => { d.jobs[7].variant_params_sha = 'x'; }, /parameter hash/, 'other parameter values');
bad((d) => { const j = d.jobs.find((x: Any) => x.id === 'caf0.5_rmin0.5_A3'); j.rows[0][ROW_COLUMNS.indexOf('trips')] += 1; }, /baseline .* differs from the Day0 evaluation/, 'baseline drift');
bad((d) => { d.jobs.pop(); }, /jobs 43|missing job/, 'missing job');

// 5. batches and shard failures (tiny synthetic job list; nothing is simulated)
const tiny: Job[] = jobs().slice(0, 5), fake = (j: Job) => ({ ...j, variant_params_sha: 'test', rows: [[j.id]] }), CFG = 'cfg-test';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2sens-'));
const batchDir = (name: string) => { const d = path.join(tmp, name); fs.mkdirSync(d); return d; };
const quiet = <T>(f: () => T): T => { const e = console.error; console.error = () => {}; try { return f(); } finally { console.error = e; } };
const make = (dir: string, batch: string, n: number, cfg = CFG) => quiet(() => { for (let i = 0; i < n; i++) writeShard(dir, batch, i, n, tiny, fake, cfg); });
const refused = (f: () => unknown, re: RegExp, why: string) => { let msg = ''; try { f(); } catch (e) { msg = String(e); } ok(/MERGE REFUSED/.test(msg) && re.test(msg), `${why}: ${msg.split('\n').slice(0, 3).join(' ') || 'NOT REFUSED'}`); };
{
  const d = batchDir('good'); make(d, 'B1', 2);
  const all = mergeShards(d, 'B1', 2, tiny, CFG);
  ok(all.map((j) => j.id).join() === tiny.map((j) => j.id).sort().join(), 'a complete batch merges');
  ok(!fs.readdirSync(d).some((f) => f.includes('.partial-')), 'shard files are written atomically (no partial file left)');
}
{ const d = batchDir('missing'); make(d, 'B2', 3); fs.rmSync(path.join(d, 'shard-1-of-3.json')); refused(() => mergeShards(d, 'B2', 3, tiny, CFG), /missing shards: shard-1-of-3/, 'missing shard'); }
{ const d = batchDir('foreign'); make(d, 'B3', 2); quiet(() => writeShard(d, 'OLD', 1, 2, tiny, fake, CFG)); refused(() => mergeShards(d, 'B3', 2, tiny, CFG), /batch OLD ≠ B3/, 'shard from another batch'); }
{ const d = batchDir('stale'); make(d, 'B4', 2); quiet(() => writeShard(d, 'B4', 0, 2, tiny, fake, 'cfg-old')); refused(() => mergeShards(d, 'B4', 2, tiny, CFG), /configuration hash differs/, 'shard made under another configuration'); }
{ const d = batchDir('extra'); make(d, 'B5', 2); quiet(() => writeShard(d, 'B5', 2, 3, tiny, fake, CFG)); refused(() => mergeShards(d, 'B5', 2, tiny, CFG), /not belonging to this 2-shard batch: shard-2-of-3/, 'stale shard of another split'); }
{ const d = batchDir('partial'); make(d, 'B6', 2); fs.writeFileSync(path.join(d, 'shard-0-of-2.json.partial-999'), '{'); refused(() => mergeShards(d, 'B6', 2, tiny, CFG), /unfinished shard files/, 'unfinished shard'); }
{
  const d = batchDir('wrongjobs'); make(d, 'B7', 2);
  const f = path.join(d, 'shard-0-of-2.json'), s = JSON.parse(fs.readFileSync(f, 'utf8')); s.jobs.push(s.jobs[0]); fs.writeFileSync(f, JSON.stringify(s));
  refused(() => mergeShards(d, 'B7', 2, tiny, CFG), /jobs .* ≠ expected|duplicate jobs/, 'shard with a duplicated job');
}
const statuses = await spawnShards((i) => ['-e', `process.exit(${i === 1 ? 3 : 0})`], 3);
let failMsg = ''; try { assertShardsOk(statuses); } catch (e) { failMsg = String(e); }
ok(/SHARD FAILURE/.test(failMsg) && /shard 1 exit 3/.test(failMsg) && !/shard 0/.test(failMsg), `a failed shard process stops the run: ${failMsg}`);
const okStatuses = await spawnShards(() => ['-e', 'process.exit(0)'], 2);
assertShardsOk(okStatuses); checks++;
fs.rmSync(tmp, { recursive: true });

ok(ROWS_PER_JOB === 80, 'rows per job = 4 seasons × 20 seeds');
console.log(`phase2-sensitivity: ${checks} checks passed`);
