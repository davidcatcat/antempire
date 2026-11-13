/**
 * RU-2 (v2-review.33, Owner #219; docs/garden-supply-demand-audit.md §0 item 9, §5): the three declared-but-unused
 * parameters are proven dead and marked 「未實作」 (values unchanged, not removed — see docs/ru2-dead-params.md for why).
 *  1. static: no code in engine/ (all subdirectories) or cli/ names them (comments and strings removed);
 *  2. dynamic: setting each of them to 0 and to 3× its value leaves the full output byte-identical — Day0 worlds
 *     (initializer + daily outputs) and Day14-fixture daily outputs;
 *  3. marks: each carries implementation.status 「未實作」, engine_reads false, the rules version and evidence; its value,
 *     unit and every other field are unchanged; every registered species / world parameter the audit finds unread
 *     is either marked or explicitly listed with a reason (no silent dead parameter);
 *  4. compatibility: the v2-review.32 parameter files (rebuilt without the marks by bundleAtVersion, equal byte for byte
 *     to the registered v32 parameter fingerprint) still load, resolve and give identical output.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { REPO_ROOT, loadBundle, readJson, ruleFiles } from '../cli/lib/load.ts';
import { manifestHash } from '../cli/lib/fingerprint.ts';
import { bundleAtVersion } from '../cli/lib/rules-version.ts';
import { resolveBundle, simulateDay, type ParamBundle } from '../engine/index.ts';
import { traceDay0, type Day0Case } from './lib/day0-trace.ts';
import { codeOnly } from './lib/static.ts';
import { audit } from '../tools/garden-supply-demand-audit.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
export const DEAD = [
  { file: 'world', path: 'plants.new_plant_event_probability' },
  { file: 'world', path: 'honeydew.honeydew_daily_replenish' },
  { file: 'species:pheidole-megacephala', path: 'nutrition.brood_protein_min_fraction' },
] as const;
const nodeOf = (b: ParamBundle, file: string, p: string): Any => p.split('.').reduce((o: Any, k) => o[k], file === 'world' ? b.world : (b.species as Any)[file.split(':')[1]]);

// 1 static
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []);
const code = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli'))].map((f) => [path.relative(REPO_ROOT, f), codeOnly(path.relative(REPO_ROOT, f))] as const);
for (const d of DEAD) {
  const name = d.path.split('.').pop() as string;
  const hits = code.filter(([, c]) => c.includes(name)).map(([f]) => f);
  ok(hits.length === 0, `1: ${d.path} is named by no code in engine/ or cli/ (${hits.join(', ')})`);
}
ok(code.some(([, c]) => c.includes('honeydew_per_colony_per_day')), '1: the detector does see parameters the engine does read (positive control)');

// 2 dynamic
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
const CASES: Day0Case[] = [
  { name: 'A1-summer', founding: 'A1', season: 'summer', seed: 20270001, days: 45 },
  { name: 'A3-winter', founding: 'A3', season: 'winter', seed: 20270002, days: 45 },
  { name: 'A5-spring', founding: 'A5', season: 'spring', seed: 20270001, days: 45 },
];
function day14Trace(bundle: ParamBundle, days = 30): string {
  let state = readJson<Any>('tests/fixtures/day14-projection.json'), chain = '';
  for (let d = 0; d < days; d++) { const o = simulateDay(state, bundle); chain = sha(chain + JSON.stringify([o.summary, o.events, o.state])); state = o.state; }
  return chain;
}
const base = loadBundle();
const ref = { day0: CASES.map((c) => traceDay0(c, { bundle: base })), day14: day14Trace(base) };
for (const d of DEAD) for (const mult of [0, 3]) {
  const b = loadBundle(), node = nodeOf(b, d.file, d.path); node.value = node.value * mult;
  const got = CASES.map((c) => traceDay0(c, { bundle: b }));
  ok(JSON.stringify(got) === JSON.stringify(ref.day0), `2: ${d.path} × ${mult}: Day0 worlds (3 cases × 45 days, incl. warm-up) byte-identical`);
  ok(day14Trace(b) === ref.day14, `2: ${d.path} × ${mult}: Day14-fixture 30-day output byte-identical`);
}

// 3 marks
const prev = bundleAtVersion('antempire.v2-review.32-param-units', { forHash: true });
for (const d of DEAD) {
  const n = nodeOf(base, d.file, d.path), old = nodeOf(prev, d.file, d.path);
  ok(n.implementation?.status === '未實作' && n.implementation.engine_reads === false && n.implementation.since_rules_version === 'antempire.v2-review.33-dead-params' && /tests\/ru2-dead-params\.test\.ts/.test(n.implementation.evidence) && n.implementation.note.length > 0, `3: ${d.path} is marked 未實作 with version and evidence`);
  const { implementation, ...rest } = n; void implementation;
  ok(JSON.stringify(rest) === JSON.stringify(old), `3: ${d.path}: value, unit and every other field unchanged from v2-review.32`);
}
const UNREAD_ALLOWED: Record<string, string> = {
  'day15_migration.hidden_honeydew_sites.F04.listed_production': 'retired Day15 migration record (#194); its description already states it is unused; outside the three RU-2 parameters (#219)',
  'day15_migration.hidden_honeydew_sites.F05.listed_production': 'same',
  'day15_migration.hidden_honeydew_sites.F10.listed_production': 'same',
};
for (const x of audit().registry.filter((r: Any) => r.flags.includes('NOT_READ_BY_ENGINE'))) {
  const marked = DEAD.some((d) => d.path === x.path);
  ok(marked || x.path in UNREAD_ALLOWED, `3: unread parameter ${x.path} is marked 未實作 or listed with a reason`);
  if (marked) ok(x.flags.includes('MARKED_NOT_IMPLEMENTED'), `3: the audit shows ${x.path} as marked`);
}

// 4 compatibility with the v32 parameter files
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ru2-v32-'));
  const files = ruleFiles().params;
  for (const f of files) {
    const [kind] = f.split('/'), obj = kind === 'world' ? prev.world : (prev.species as Any)[JSON.parse(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')).species_id];
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true }); fs.writeFileSync(path.join(tmp, f), JSON.stringify(obj, null, 2) + '\n');
  }
  const v32 = readJson<Any>('rules/registry.json').versions.find((v: Any) => v.rules_version === 'antempire.v2-review.32-param-units');
  ok(manifestHash(files, tmp) === v32.fingerprint.params, '4: the rebuilt v32 parameter files hash to the registered v32 parameter fingerprint');
  fs.rmSync(tmp, { recursive: true, force: true });
  resolveBundle(prev); checks++;
  ok(JSON.stringify(CASES.map((c) => traceDay0(c, { bundle: prev }))) === JSON.stringify(ref.day0) && day14Trace(prev) === ref.day14, '4: unmarked (v32) parameter files load, resolve and give identical output');
}
console.log(JSON.stringify({ test: 'ru2-dead-params', checks, dead: DEAD.map((d) => d.path) }));
