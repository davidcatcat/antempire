/**
 * Runs every test script in its own Node process and prints a summary table.
 *   node tests/run-all.ts            -> all blocking tests (exit 1 if any fails)
 *   node tests/run-all.ts --known    -> also runs known pre-existing failures (reported, non-blocking)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';

export const BLOCKING = ['params-split', 'platform-purity', 'naturalism', 'foraging-physics', 'migration', 'local-ecology', 'scaling', 'multi-colony', 'golden', 'differential'];
export const KNOWN_PREEXISTING_FAILURES = ['local-ecology-orphan-queen'];

const run = (name: string) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tests', `${name}.test.ts`)], { encoding: 'utf8' });
  return { name, ok: r.status === 0, seconds: ((Date.now() - t) / 1000).toFixed(1), output: (r.stdout + r.stderr).trim() };
};
const results = BLOCKING.map(run);
const known = process.argv.includes('--known') ? KNOWN_PREEXISTING_FAILURES.map(run) : [];
for (const r of [...results, ...known]) console.log(`${r.ok ? 'PASS' : known.includes(r) ? 'KNOWN-FAIL' : 'FAIL'}  ${r.name.padEnd(28)} ${r.seconds}s`);
for (const r of results.filter((x) => !x.ok)) console.log(`\n--- ${r.name} ---\n${r.output.slice(-4000)}`);
if (results.some((x) => !x.ok)) process.exitCode = 1;
