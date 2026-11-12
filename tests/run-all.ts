/**
 * Runs every test script in its own Node process and prints a summary table.
 *   node tests/run-all.ts            -> all blocking tests (exit 1 if any fails)
 *   node tests/run-all.ts --except a,b -> skip the named tests (CI runs those as separate steps)
 *   node tests/run-all.ts --shard k/n  -> run only shard k of n (CI runs the n shards as parallel jobs).
 *     The shards are a deterministic partition of the selected tests: every test is in exactly one shard
 *     (tests/run-all-shards.test.ts proves it), so sharding never skips or duplicates a test. Weights are
 *     approximate seconds used only to balance wall-clock time; they do not affect what is tested.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';

export const BLOCKING = ['params-split', 'platform-purity', 'naturalism', 'foraging-physics', 'migration', 'local-ecology', 'scaling', 'multi-colony', 'golden', 'differential', 'advance', 'nest-temperature', 'save-transaction', 'history-integrity', 'save-counters', 'rules-isolation', 'hunting', 'injury', 'crop-ledger', 'navigation', 'rules-registry', 'multi-colony-timeline', 'day0', 'death-diagnostics', 'activity', 'eval-methods', 'web', 'web-serve', 'issue43-timeline', 'issue44-locality', 'phase2-sensitivity', 'reproduction-measures', 'p0a-rain-allocation', 'issue51-input-manifest', 'issue50-brood-order', 'compartments', 'c2-engine-transfers', 'issue56-worker-order', 'issue61-trail-deposit', 'math-contracts', 'ph1-geometry', 'physics-isolation', 'mv1-kinematics', 'ph2-collision', 'physics-two-ant', 'me1-invariants', 'c3a-queen-feeding', 'source-flows-v26', 'rh-offsets-v27', 'c4a-a0-defect', 'c4a-larva-feeding', 'c3a-feed-rule', 'c4a-begging-prior', 'c4b-larva-development', 'c4b-form-properties', 'nurse-cue-local-v31', 'c4-causal-chain', 'physics-event-fixes', 'physics-p2d', 'physics-p2e', 'physics-2d-occupancy', 'solver-compare', 'ph3b-solver2d', 'physics-playback', 'web-v3-follow', 'web-v4-stats', 'web-v5-observer', 'p0a0-world-scheduler', 'scheduler-isolation', 'p0a0-time-contract', 'p0b-life-history', 'wp6-c4-next', 'clock-isolation', 'p0a1-24h-clock', 'p0a1-multi-colony-axis', 'web-v6-game', 'wp5-mixed-precision', 'fingerprint-v2', 'worker-boundary', 'worker-runtime', 'solar-xenv', 'save-contract', 'save-format', 'wp5-cohort-lifetime', 'wp5-camera-invariance', 'chem0-contract', 'chemistry-isolation', 'chem1-core', 'chem1b-sampling', 'web-v6-replay-ux', 'p0a2-24h-proto', 'ph3b-crossing-guard', 'kin2d-kinematics', 'natural-walk', 'r133-observer', 'kin2d-diagnosis', 'local-sensing', 'physics-shared-contract', 'antenna-geometry', 'physics-contact-constraint', 'kin2d-model-c-scenes', 'wp4-local-steer', 'physics-time-contract-wp4', 'wp4-individual-time', 'ph3b-contact-time', 'ph3b-contact-kinds', 'physics-destinations', 'run-all-shards', 'game-art-assets', 'render-system', 'web-v6-art-scene', 'web-v62-experiment', 'save2-session', 'render-atlas', 'device-bench', 'display-motion'];

/** approximate seconds per test (balancing only; unknown tests count as 10 s) */
export const SHARD_WEIGHTS: Record<string, number> = { 'rules-isolation': 455, 'wp4-local-steer': 411, 'physics-playback': 326, 'physics-p2e': 76, 'ph3b-solver2d': 56, golden: 50, 'ph2-collision': 43, 'c4-causal-chain': 34, 'issue50-brood-order': 26, 'physics-p2d': 24, 'death-diagnostics': 23, 'phase2-sensitivity': 21, 'crop-ledger': 20, 'source-flows-v26': 19, activity: 19, 'p0a2-24h-proto': 19, hunting: 18 };
/** Deterministic longest-first greedy partition of `names` into n shards (ties: lower shard index, then name order). */
export function shardPlan(names: readonly string[], n: number): string[][] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`bad shard count ${n}`);
  const w = (x: string) => SHARD_WEIGHTS[x] ?? 10;
  const order = [...names].sort((a, b) => w(b) - w(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards: string[][] = Array.from({ length: n }, () => []), load = new Array<number>(n).fill(0);
  for (const x of order) { let k = 0; for (let i = 1; i < n; i++) if (load[i] < load[k]) k = i; shards[k].push(x); load[k] += w(x); }
  return shards.map((s) => names.filter((x) => s.includes(x))); // keep the original BLOCKING order inside a shard
}

const run = (name: string) => {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'tests', `${name}.test.ts`)], { encoding: 'utf8' });
  return { name, ok: r.status === 0, seconds: ((Date.now() - t) / 1000).toFixed(1), output: (r.stdout + r.stderr).trim() };
};
const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(REPO_ROOT, 'tests', 'run-all.ts');
if (isMain) {
const exceptArg = process.argv.find((a, i) => process.argv[i - 1] === '--except');
const except = new Set((exceptArg ?? '').split(',').filter(Boolean));
const shardArg = process.argv.find((a, i) => process.argv[i - 1] === '--shard');
let selected = BLOCKING.filter((n) => !except.has(n));
if (shardArg) {
  const m = /^(\d+)\/(\d+)$/.exec(shardArg); if (!m) throw new Error(`--shard expects k/n, got ${shardArg}`);
  const k = Number(m[1]), n = Number(m[2]); if (k < 1 || k > n) throw new Error(`--shard ${shardArg} out of range`);
  selected = shardPlan(selected, n)[k - 1];
  console.log(`shard ${k}/${n}: ${selected.length} tests`);
}
const results = selected.map(run);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(28)} ${r.seconds}s`);
for (const r of results.filter((x) => !x.ok)) console.log(`\n--- ${r.name} ---\n${r.output.slice(-4000)}`);
if (results.some((x) => !x.ok)) process.exitCode = 1;
}
