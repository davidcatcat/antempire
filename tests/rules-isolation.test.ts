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
 *   v2-review.14 (individual route memory; switch off) -> reproduces tests/golden/v13-trace-sha256.json
 *   v2-review.15 (Day0 initialization; engine-only, declared day14_output_unchanged) -> the current engine with
 *                nothing undone reproduces tests/golden/v14-trace-sha256.json
 *   v2-review.16 (death diagnostics; diagnostics_only) -> removing only the added event fields (named output
 *                normaliser) reproduces tests/golden/v15-trace-sha256.json
 *   v2-review.17 (individual activity timeline; switch off, new parameters unused) -> reproduces
 *                tests/golden/v16-trace-sha256.json and the v16 Day0 golden
 *   v2-review.18 (lone-queen hazard from day 14; A4/A5 scenario files are not engine input) -> reproduces v17
 *   v2-review.19 (parameter source labels only) -> the current engine reproduces v18 unchanged
 *   v2-review.20 (Issue #43 local-causality fixes; switch activity.local_causality_v20 off) -> reproduces v19
 * Every step also undoes the output normalisers of its own and later diagnostics-only versions.
 * Each step undoes its own changes AND every later step's, so step N is compared with the engine as it was.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { simulateDay } from '../engine/index.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew } from './lib/scenarios.ts';
import { approvedChanges, revertChange, normaliseOutput } from './lib/approved-changes.ts';
import { DAY0_GOLDEN_CASES, traceDay0 } from './lib/day0-trace.ts';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import type { ParamBundle } from '../engine/index.ts';

const STEPS = [
  { version: 'antempire.v2-review.8-injured-worker-neutral-tasks', previousGolden: 'tests/golden/v7-trace-sha256.json' },
  { version: 'antempire.v2-review.9-simultaneous-site-hunting', previousGolden: 'tests/golden/v8-trace-sha256.json' },
  { version: 'antempire.v2-review.10-hunt-team-cap', previousGolden: 'tests/golden/v9-trace-sha256.json' },
  { version: 'antempire.v2-review.11-late-arrivals-join-waiting-prey', previousGolden: 'tests/golden/v10-trace-sha256.json' },
  { version: 'antempire.v2-review.12-injury-types', previousGolden: 'tests/golden/v11-trace-sha256.json' },
  { version: 'antempire.v2-review.13-egg-sugar-settles-crops', previousGolden: 'tests/golden/v12-trace-sha256.json' },
  { version: 'antempire.v2-review.14-individual-route-memory', previousGolden: 'tests/golden/v13-trace-sha256.json' },
  { version: 'antempire.v2-review.15-day0-initialization', previousGolden: 'tests/golden/v14-trace-sha256.json' },
  { version: 'antempire.v2-review.16-death-diagnostics', previousGolden: 'tests/golden/v15-trace-sha256.json' },
  { version: 'antempire.v2-review.17-activity-timeline', previousGolden: 'tests/golden/v16-trace-sha256.json' },
  { version: 'antempire.v2-review.18-founding-controls', previousGolden: 'tests/golden/v17-trace-sha256.json' },
  { version: 'antempire.v2-review.19-evaluation-corrections', previousGolden: 'tests/golden/v18-trace-sha256.json' },
  { version: 'antempire.v2-review.20-local-causality', previousGolden: 'tests/golden/v19-trace-sha256.json' },
];
const ORDER = STEPS.map((s) => s.version);
const results: Record<string, string> = {};
for (const step of STEPS) {
  const own = approvedChanges().filter((c) => c.rules_version === step.version);
  assert.ok(own.length > 0 && own.every((c) => ['param', 'param_removed', 'param_switch', 'param_added'].includes(c.kind) || (c.kind === 'param_metadata' && (c as { day14_output_unchanged?: boolean }).day14_output_unchanged === true) || (c.kind === 'engine' && ((c as { day14_output_unchanged?: boolean }).day14_output_unchanged === true || (c as { diagnostics_only?: boolean }).diagnostics_only === true))), `${step.version} must be a parameter/switch-only update for this check`);
  const changes = approvedChanges().filter((c) => ORDER.indexOf(c.rules_version) >= ORDER.indexOf(step.version));
  const revert = (b: ParamBundle) => { for (const c of [...changes].reverse()) revertChange(b, c); };
  const golden = readJson(step.previousGolden);
  for (const sc of SCENARIOS) {
    let state = readJson('tests/fixtures/day14-projection.json'); if (sc.seed) state.seed = sc.seed; sc.state(state);
    const bundle = loadBundle(); revert(bundle); applyNew(bundle, sc.params);
    let chain = '';
    for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, bundle); chain = crypto.createHash('sha256').update(chain + JSON.stringify(normaliseOutput([o.summary, o.events, o.state], changes))).digest('hex'); state = o.state; }
    assert.equal(chain, golden.scenarios[sc.name].sha256, `${step.version}: ${sc.name} differs from ${step.previousGolden} after undoing only its parameter changes`);
    results[`${step.version} -> ${sc.name}`] = 'identical';
  }
  // Day0 worlds exist from v2-review.15 on: the previous version's Day0 golden must be reproduced the same way.
  const day0Prev = step.previousGolden.replace('tests/golden/', 'tests/golden/day0-');
  if (fs.existsSync(path.join(REPO_ROOT, day0Prev))) {
    const g0 = readJson(day0Prev);
    for (const c of DAY0_GOLDEN_CASES.filter((x) => g0.cases[x.name])) { // foundings added later have no earlier golden
      const bundle = loadBundle(); revert(bundle);
      const got = traceDay0(c, { bundle, normalise: (x) => normaliseOutput(x, changes) });
      assert.ok(got.day0_sha256 === g0.cases[c.name].day0_sha256 && got.sha256 === g0.cases[c.name].sha256, `${step.version}: Day0 ${c.name} differs from ${day0Prev}`);
      results[`${step.version} -> day0 ${c.name}`] = 'identical';
    }
  }
}
console.log(JSON.stringify({ passed: true, compared: Object.keys(results).length, steps: STEPS }, null, 2));
