/**
 * Each approved rules update must change ONLY what it lists in tests/golden/approved-rule-changes.json.
 * For parameter-only updates this is checked without the v6 engine: undo just that version's parameter
 * changes and the current engine must reproduce the previous version's golden trace hashes exactly.
 *   v2-review.8 (#13, injured-worker task weights) -> reproduces tests/golden/v7-trace-sha256.json
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { simulateDay } from '../engine/index.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew } from './lib/scenarios.ts';
import { approvedChanges } from './lib/approved-changes.ts';
import type { ParamBundle } from '../engine/index.ts';

const STEPS = [{ version: 'antempire.v2-review.8-injured-worker-neutral-tasks', previousGolden: 'tests/golden/v7-trace-sha256.json' }];
const results: Record<string, string> = {};
for (const step of STEPS) {
  const changes = approvedChanges().filter((c) => c.rules_version === step.version);
  assert.ok(changes.length > 0 && changes.every((c) => c.kind === 'param' || c.kind === 'param_removed'), `${step.version} must be a parameter-only update for this check`);
  const revert = (b: ParamBundle) => { for (const c of changes) if (c.kind === 'param') { let n: any = c.file?.startsWith('world') ? b.world : b.species[(c.file as string).split(':')[1]]; for (const k of (c.path as string).split('.')) n = n[k]; n.value = c.from; } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const golden = readJson(step.previousGolden);
  for (const sc of SCENARIOS) {
    let state = readJson('tests/fixtures/day14-projection.json'); if (sc.seed) state.seed = sc.seed; sc.state(state);
    const bundle = loadBundle(); revert(bundle); applyNew(bundle, sc.params);
    let chain = '';
    for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, bundle); chain = crypto.createHash('sha256').update(chain + JSON.stringify([o.summary, o.events, o.state])).digest('hex'); state = o.state; }
    assert.equal(chain, golden.scenarios[sc.name].sha256, `${step.version}: ${sc.name} differs from ${step.previousGolden} after undoing only its parameter changes`);
    results[`${step.version} -> ${sc.name}`] = 'identical';
  }
}
console.log(JSON.stringify({ passed: true, compared: Object.keys(results).length, steps: STEPS }, null, 2));
