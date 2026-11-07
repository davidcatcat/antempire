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
 *   v2-review.21 (Issue #50 brood care snapshot; switch brood_care.daily_care_snapshot_v21 off) -> reproduces v20
 *   v2-review.22 (C2 engine food transfers; diagnostics_only) -> removing the food_transfer events reproduces v21
 *   v2-review.23 (Issue #61 R3-05 local trail deposition; switch activity.local_trail_deposit_v23 off) -> reproduces v22
 *   v2-review.24 (ME-1 runtime invariants; checks only, day14_output_unchanged) -> reproduces v23 unchanged
 *   v2-review.25 (C3a queen body; switch queen_feeding.individual_queen_body_c3a off) -> reproduces v24
 *   v2-review.26 (Issue #80 source flows; switch source_flows.record_source_flows_v26 off) -> reproduces v25
 *   v2-review.27 (Issue #82 humidity offsets; switch weather_rules.rh_offsets_balanced_v27 off) -> reproduces v26
 *   v2-review.28 (C4a larva body; switch larval_feeding.individual_larva_body_c4a off) -> reproduces v27
 *   v2-review.29 (C4a first-seen begging prior; switch larval_feeding.first_seen_begging_prior_v29 off) -> reproduces v28
 *   v2-review.30 (C4b larva development; switch larval_development.individual_development_c4b off) -> reproduces v29
 *   v2-review.31 (nurse cue same place; switch local_signals.nurse_cue_same_place_v31 off) -> reproduces v30
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
  { version: 'antempire.v2-review.21-brood-care-snapshot', previousGolden: 'tests/golden/v20-trace-sha256.json' },
  { version: 'antempire.v2-review.22-engine-food-transfers', previousGolden: 'tests/golden/v21-trace-sha256.json' },
  { version: 'antempire.v2-review.23-local-trail-deposit', previousGolden: 'tests/golden/v22-trace-sha256.json' },
  { version: 'antempire.v2-review.24-me1-invariants', previousGolden: 'tests/golden/v23-trace-sha256.json' },
  { version: 'antempire.v2-review.25-c3a-queen-body', previousGolden: 'tests/golden/v24-trace-sha256.json' },
  { version: 'antempire.v2-review.26-source-flows', previousGolden: 'tests/golden/v25-trace-sha256.json' },
  { version: 'antempire.v2-review.27-rh-offsets', previousGolden: 'tests/golden/v26-trace-sha256.json' },
  { version: 'antempire.v2-review.28-c4a-larva-body', previousGolden: 'tests/golden/v27-trace-sha256.json' },
  { version: 'antempire.v2-review.29-c4a-begging-prior', previousGolden: 'tests/golden/v28-trace-sha256.json' },
  { version: 'antempire.v2-review.30-c4b-larva-development', previousGolden: 'tests/golden/v29-trace-sha256.json' },
  { version: 'antempire.v2-review.31-nurse-cue-same-place', previousGolden: 'tests/golden/v30-trace-sha256.json' },
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
