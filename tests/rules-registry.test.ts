/**
 * #11 rules version registry. The registry keeps every approved rules version and its golden evidence:
 *  1. CI guard: the current checkout's rules fingerprint is the latest APPROVED registry entry, every entry keeps
 *     its golden traces, versions form one chain (no gaps, no duplicates);
 *  2. the old versions' golden traces are still on disk (old rules evidence is kept).
 * #194: the legacy Day14 saves and `npm run advance` are retired. The former checks of Day15 activation, the frozen
 * rules in an official save and `--adopt-rules` (old items 2-6) tested that retired official-world protocol and are
 * gone; how the new official Day0 world records and adopts rules versions is defined with R2.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { fingerprintV2, v2Record } from '../cli/lib/fingerprint-v2.ts';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { readRegistry, registryProblems, type Registry } from '../cli/lib/rules-registry.ts';
import { ENGINE_VERSION } from '../engine/index.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const listDir = (d: string) => fs.readdirSync(d).sort().join(',');
const journalBefore = listDir(path.join(REPO_ROOT, 'journal'));

// 1. CI guard on the real registry
const reg = readRegistry(), fp = { ...rulesFingerprint(), v2: v2Record(fingerprintV2()) };
const problems = registryProblems(reg, fp, ENGINE_VERSION, (rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
ok(problems.length === 0, 'registry consistent with the checkout: ' + problems.join('; '));
ok(registryProblems(reg, { engine: 'f'.repeat(64), params: fp.params }, ENGINE_VERSION, () => true).some((p) => p.includes('not registered')), 'an unregistered engine change is detected');
const current = reg.versions.at(-1) as Registry['versions'][number];

try {
  // 2. old evidence kept
  ok(reg.versions.every((v) => fs.existsSync(path.join(REPO_ROOT, v.golden.traces))), 'every registered version keeps its golden traces');
  console.log(JSON.stringify({ passed: true, checks, registered_versions: reg.versions.map((v) => v.tag), current: current.rules_version }, null, 2));
} finally {
  assert.equal(listDir(path.join(REPO_ROOT, 'journal')), journalBefore, 'REAL journal/ changed');
}
