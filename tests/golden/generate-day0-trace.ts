/**
 * Generates tests/golden/day0-<tag>-trace-sha256.json with the CURRENT engine (rules-update PRs only).
 *   node tests/golden/generate-day0-trace.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../../cli/lib/load.ts';
import { RULES_TAG } from '../../cli/reports/winter-multiseed.ts';
import { ENGINE_VERSION } from '../../engine/index.ts';
import { DAY0_GOLDEN_CASES, traceDay0 } from '../lib/day0-trace.ts';

const out: Record<string, ReturnType<typeof traceDay0>> = {};
for (const c of DAY0_GOLDEN_CASES) out[c.name] = traceDay0(c);
const doc = { schema: 'antempire.day0-golden-trace.v1', generated_from: { engine_version: ENGINE_VERSION, scenarios: 'scenarios/day0/*.json', climatology: 'data/taichung-climatology-1991-2020.json', params: 'species/*.json + world/xitun-garden.json' }, method: 'h_0 = sha256(JSON.stringify([day0 state, warm-up events])); h_d = sha256(h_{d-1} + JSON.stringify([result, state]))', cases: out };
const rel = `tests/golden/day0-${RULES_TAG}-trace-sha256.json`;
fs.writeFileSync(path.join(REPO_ROOT, rel), JSON.stringify(doc, null, 2) + '\n');
console.log(`wrote ${rel} (${Object.keys(out).length} cases)`);
