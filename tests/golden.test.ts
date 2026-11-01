/**
 * GOLDEN TEST (byte-for-byte).
 *  1. Regenerates the v6 20-seed winter report and the v6 single-seed report with the TypeScript engine
 *     into a temporary directory and compares every file BYTE-FOR-BYTE with the committed reports/.
 *  2. Replays 28 scenarios (20 seeds × 120 days, no-food, sugar-only, abundant, orphan, workerless,
 *     high-search, 100 and 1000 workers) and compares the hash chain of the FULL daily output
 *     (summary + events + state) with tests/golden/v6-trace-sha256.json, generated from sim/day_engine.cjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { simulateDay } from '../engine/index.ts';
import { generateWinterMultiseed } from '../cli/reports/winter-multiseed.ts';
import { generateSingleSeed120 } from '../cli/reports/single-seed-120.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { SCENARIOS, applyNew } from './lib/scenarios.ts';

const failures: string[] = [], results: Record<string, string> = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-golden-'));
try {
  generateWinterMultiseed(tmp); generateSingleSeed120(tmp);
  for (const f of ['day15-134-v6-20seeds-daily.csv', 'day15-134-v6-20seeds-weekly.csv', 'day15-134-v6-20seeds-analysis.json', 'day15-134-v6-daily.csv', 'day15-134-v6-weekly.csv', 'day15-134-v6-analysis.json']) {
    const same = Buffer.compare(fs.readFileSync(path.join(tmp, f)), fs.readFileSync(path.join(REPO_ROOT, 'reports', f))) === 0;
    results['reports/' + f] = same ? 'byte-identical' : 'DIFFERENT';
    if (!same) failures.push('reports/' + f);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

const golden = readJson('tests/golden/v6-trace-sha256.json'), initial = readJson('tests/fixtures/day14-projection.json');
for (const sc of SCENARIOS) {
  let state = structuredClone(initial); if (sc.seed) state.seed = sc.seed; sc.state(state);
  const bundle = loadBundle(); applyNew(bundle, sc.params);
  let chain = '';
  for (let d = 0; d < sc.days; d++) { const o = simulateDay(state, bundle); chain = crypto.createHash('sha256').update(chain + JSON.stringify([o.summary, o.events, o.state])).digest('hex'); state = o.state; }
  const expected = golden.scenarios[sc.name];
  const same = !!expected && expected.sha256 === chain && expected.final_day === state.sim_day;
  results['trace/' + sc.name] = same ? `identical (${sc.days} days)` : `DIFFERENT expected ${expected?.sha256} got ${chain}`;
  if (!same) failures.push('trace/' + sc.name);
}
if (Object.keys(golden.scenarios).length !== SCENARIOS.length) failures.push('scenario count mismatch with golden file');
console.log(JSON.stringify({ passed: failures.length === 0, compared: Object.keys(results).length, failures, results }, null, 2));
if (failures.length) process.exitCode = 1;
