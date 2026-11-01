/**
 * Generates tests/golden/<tag>-trace-sha256.json with the CURRENT engine (run only in a rules-update PR,
 * after the behaviour change has been reviewed). Pure refactors must leave this file unchanged.
 *   node tests/golden/generate-trace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { RULES_TAG } from '../../cli/reports/winter-multiseed.ts';
import { ENGINE_VERSION } from '../../engine/index.ts';
import { SCENARIOS } from '../lib/scenarios.ts';
import { traceScenario } from '../lib/trace.ts';

const out: Record<string, { days: number; final_day: number; sha256: string }> = {};
for (const sc of SCENARIOS) out[sc.name] = traceScenario(sc);
const doc = { schema: 'antempire.golden-trace.v1', generated_from: { engine: 'engine/ (TypeScript)', params: 'species/*.json + world/xitun-garden.json', fixture: 'tests/fixtures/day14-projection.json', engine_version: ENGINE_VERSION }, method: 'per scenario: h_0="" ; h_d = sha256(h_{d-1} + JSON.stringify([summary, events, state])) ; recorded h_days', scenarios: out };
fs.writeFileSync(path.join(REPO_ROOT, `tests/golden/${RULES_TAG}-trace-sha256.json`), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote tests/golden/${RULES_TAG}-trace-sha256.json (${Object.keys(out).length} scenarios)`);
