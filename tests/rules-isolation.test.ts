/**
 * Each approved rules update must change ONLY what it lists in tests/golden/approved-rule-changes.json.
 * For parameter-only updates this is checked without the v6 engine: undo just that version's parameter
 * changes and the current engine must reproduce the previous version's golden trace hashes exactly.
 *   v2-review.8 (#13, injured-worker task weights) -> reproduces tests/golden/v7-trace-sha256.json
 *   v2-review.9 (#10, simultaneous site-window hunting; model switch off) -> reproduces tests/golden/v8-trace-sha256.json
 *   v2-review.10 (large-prey team cap; cap set back to no limit) -> reproduces tests/golden/v9-trace-sha256.json
 *   v2-review.11 (late arrivals join a waiting prey; switch off) -> reproduces tests/golden/v10-trace-sha256.json
 *   v2-review.12 (injury types; multipliers back to 1, migration switch off) -> reproduces tests/golden/v11-trace-sha256.json
 *   v2-review.13 (egg-laying sugar settles crops; switch off) -> reproduces tests/golden/v12-trace-sha256.json
 * Each step undoes its own changes AND every later step's, so step N is compared with the engine as it was.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { simulateDay } from '../engine/index.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew } from './lib/scenarios.ts';
import { approvedChanges, revertChange } from './lib/approved-changes.ts';
import type { ParamBundle } from '../engine/index.ts';

const STEPS = [
  { version: 'antempire.v2-review.8-injured-worker-neutral-tasks', previousGolden: 'tests/golden/v7-trace-sha256.json' },
  { version: 'antempire.v2-review.9-simultaneous-site-hunting', previousGolden: 'tests/golden/v8-trace-sha256.json' },
  { version: 'antempire.v2-review.10-hunt-team-cap', previousGolden: 'tests/golden/v9-trace-sha256.json' },
  { version: 'antempire.v2-review.11-late-arrivals-join-waiting-prey', previousGolden: 'tests/golden/v10-trace-sha256.json' },
  { version: 'antempire.v2-review.12-injury-types', previousGolden: 'tests/golden/v11-trace-sha256.json' },
  { version: 'antempire.v2-review.13-egg-sugar-settles-crops', previousGolden: 'tests/golden/v12-trace-sha256.json' },
];
const ORDER = STEPS.map((s) => s.version);
const results: Record<string, string> = {};
for (const step of STEPS) {
  const own = approvedChanges().filter((c) => c.rules_version === step.version);
  assert.ok(own.length > 0 && own.every((c) => ['param', 'param_removed', 'param_switch', 'param_added'].includes(c.kind)), `${step.version} must be a parameter/switch-only update for this check`);
  const changes = approvedChanges().filter((c) => ORDER.indexOf(c.rules_version) >= ORDER.indexOf(step.version));
  const revert = (b: ParamBundle) => { for (const c of [...changes].reverse()) revertChange(b, c); };
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
