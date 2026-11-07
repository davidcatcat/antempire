/**
 * Runs every test script in its own Node process and prints a summary table.
 *   node tests/run-all.ts            -> all blocking tests (exit 1 if any fails)
 *   node tests/run-all.ts --except a,b -> skip the named tests (CI runs those as separate steps)
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';

export const BLOCKING = ['params-split', 'platform-purity', 'naturalism', 'foraging-physics', 'migration', 'local-ecology', 'scaling', 'multi-colony', 'golden', 'differential', 'advance', 'nest-temperature', 'save-transaction', 'history-integrity', 'save-counters', 'rules-isolation', 'hunting', 'injury', 'crop-ledger', 'navigation', 'rules-registry', 'multi-colony-timeline', 'day0', 'death-diagnostics', 'activity', 'eval-methods', 'web', 'web-serve', 'issue43-timeline', 'issue44-locality', 'phase2-sensitivity', 'reproduction-measures', 'p0a-rain-allocation', 'issue51-input-manifest', 'issue50-brood-order', 'compartments', 'c2-engine-transfers', 'issue56-worker-order', 'issue61-trail-deposit', 'math-contracts', 'ph1-geometry', 'physics-isolation', 'mv1-kinematics', 'ph2-collision', 'physics-two-ant', 'me1-invariants', 'c3a-queen-feeding', 'source-flows-v26', 'rh-offsets-v27', 'c4a-a0-defect', 'c4a-larva-feeding', 'c3a-feed-rule', 'c4a-begging-prior', 'c4b-larva-development', 'c4b-form-properties'];

const run = (name: string) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tests', `${name}.test.ts`)], { encoding: 'utf8' });
  return { name, ok: r.status === 0, seconds: ((Date.now() - t) / 1000).toFixed(1), output: (r.stdout + r.stderr).trim() };
};
const exceptArg = process.argv.find((a, i) => process.argv[i - 1] === '--except');
const except = new Set((exceptArg ?? '').split(',').filter(Boolean));
const results = BLOCKING.filter((n) => !except.has(n)).map(run);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.seconds}s`);
for (const r of results.filter((x) => !x.ok)) console.log(`\n--- ${r.name} ---\n${r.output.slice(-4000)}`);
if (results.some((x) => !x.ok)) process.exitCode = 1;
