/**
 * CI runs the BLOCKING tests as parallel shards (tests/run-all.ts --shard k/n). This proves the shards are a
 * partition: for every n, the union of the n shards equals the selected tests exactly, with no test in two shards
 * and none missing — so sharding can never skip a test. Also checks the CI workflow uses a consistent n.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { BLOCKING, shardPlan } from './run-all.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const except = new Set(['golden', 'naturalism']);
const selected = BLOCKING.filter((n) => !except.has(n));
ok(new Set(BLOCKING).size === BLOCKING.length, 'BLOCKING has no duplicates');
for (const list of [BLOCKING, selected]) for (let n = 1; n <= 6; n++) {
  const plan = shardPlan(list, n), flat = plan.flat();
  ok(plan.length === n, `n=${n}: ${n} shards`);
  ok(flat.length === list.length && new Set(flat).size === flat.length, `n=${n}: no test in two shards`);
  ok([...list].sort().join() === [...flat].sort().join(), `n=${n}: union of shards = the selected tests`);
  ok(JSON.stringify(shardPlan(list, n)) === JSON.stringify(plan), `n=${n}: deterministic`);
}
// a test that is not in the weight table still lands in exactly one shard
const extra = [...selected, 'zz-new-test-without-weight'];
ok(shardPlan(extra, 3).flat().filter((x) => x === 'zz-new-test-without-weight').length === 1, 'unknown test assigned once');
// CI: every shard index 1..n of one n is run, together with the same --except list as test:rest
const ci = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const m = /shard:\s*\[([0-9,\s]+)\]/.exec(ci); ok(m, 'ci.yml has a shard matrix');
const ks = m![1].split(',').map((x) => Number(x.trim())); const n = ks.length;
ok(ks.join() === Array.from({ length: n }, (_, i) => i + 1).join(), `ci.yml matrix covers shards 1..${n}`);
ok(ci.includes(`--shard \${{ matrix.shard }}/${n}`), `ci.yml runs --shard k/${n}`);
ok(ci.includes('--except golden,naturalism --shard'), 'shards use the same --except list as test:rest');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
ok(pkg.scripts['test:rest'] === 'node tests/run-all.ts --except golden,naturalism', 'test:rest unchanged');
console.log(JSON.stringify({ test: 'run-all-shards', checks, ci_shards: n, shard_sizes: shardPlan(selected, n).map((s) => s.length) }));
