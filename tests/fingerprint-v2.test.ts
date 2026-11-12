/**
 * Rules fingerprint v2 (Owner decision 52; docs/rules-fingerprint-v2.md). Everything that writes runs on TEMPORARY
 * copies; the real saves/ and journal/ must stay byte-identical.
 *  1. determinism and order independence;
 *  2. fixed encoding: CRLF / lone CR / BOM give the same v2 (v1 does not: documented weakness), invalid UTF-8 refused;
 *  3. UI / docs / tooling / prototype changes do not change v2; simulation source, parameter and input changes do;
 *  4. no self-reference: the registry and the fingerprint modules are never hashed, reaching them is an error;
 *     package imports and missing files are refused;
 *  5. compatibility: v1 still identifies the current registry version; Day14 has no frozen rules; a save frozen
 *     with v1 keeps advancing under v1; adopting a version with fingerprint_v2 switches to v2 from that day only
 *     (earlier commit-log entries keep v1); v2 then catches a change v1 cannot see; no return to v1;
 *     activation freezes v2 directly when the running registered version records one;
 *  6. npm run advance dry run on the real saves works and writes nothing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { advance } from '../cli/advance.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { FINGERPRINT_V2_SCHEMA, V2_NEVER_HASHED, fingerprintV2, groupHash, importSpecifiers, normalizeText, sourceClosure, v2Digest, v2Record, v2RecordProblems, type FingerprintV2 } from '../cli/lib/fingerprint-v2.ts';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';
import { readRegistry, registryProblems, type Registry, type RulesVersion } from '../cli/lib/rules-registry.ts';
import { readCommitLog } from '../cli/lib/save-transaction.ts';
import { ENGINE_VERSION } from '../engine/index.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const listFiles = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? listFiles(path.join(d, e.name)) : [path.join(d, e.name)]);
const snapReal = () => ['saves', 'journal'].flatMap((d) => listFiles(path.join(REPO_ROOT, d))).sort().map((f) => `${path.relative(REPO_ROOT, f)}:${sha(f)}`).join('\n');
const realBefore = snapReal();
const NOW = '2026-11-02T00:00:00.000Z';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-fpv2-'));
const SRC_DIRS = ['engine', 'cli', 'species', 'world', 'data', 'rules', 'web/src', 'docs'];
const repoCopy = () => { const d = fs.mkdtempSync(path.join(tmp, 'r-')); for (const x of SRC_DIRS) fs.cpSync(path.join(REPO_ROOT, x), path.join(d, x), { recursive: true }); fs.copyFileSync(path.join(REPO_ROOT, '.nvmrc'), path.join(d, '.nvmrc')); return d; };
const savesCopy = () => { const d = fs.mkdtempSync(path.join(tmp, 's-')); for (const x of ['saves', 'data', 'journal']) fs.cpSync(path.join(REPO_ROOT, x), path.join(d, x), { recursive: true }); return d; };
const edit = (root: string, rel: string, fn: (s: string) => string) => fs.writeFileSync(path.join(root, rel), fn(fs.readFileSync(path.join(root, rel), 'utf8')));
const shuffled = <T,>(xs: T[], seed: number) => { const a = [...xs]; let x = seed; for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) % 2147483648; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const world = (root: string) => readJson('saves/world-state.json', root).sim_engine_v2;

try {
  // 1. determinism, order independence
  const real = fingerprintV2(), again = fingerprintV2(), copy = fingerprintV2(repoCopy());
  ok(JSON.stringify(real) === JSON.stringify(again) && JSON.stringify(v2Record(real)) === JSON.stringify(v2Record(copy)), 'same content -> same v2 (twice, and in another directory)');
  ok(real.schema === FINGERPRINT_V2_SCHEMA && v2RecordProblems(v2Record(real)).length === 0 && real.engine_version === ENGINE_VERSION, 'v2 record is versioned, self-consistent and names ENGINE_VERSION');
  for (const k of ['source', 'params', 'data'] as const) ok(real.files[k].every((f, i, a) => i === 0 || a[i - 1] < f), `${k} file list in fixed (code unit) order`);
  const entries = real.files.source.map((f) => ({ path: f, bytes: fs.readFileSync(path.join(REPO_ROOT, f)) }));
  ok(groupHash([...entries].reverse()) === real.source && groupHash(shuffled(entries, 7)) === real.source && groupHash(shuffled(entries, 1234)) === real.source, 'group hash independent of input order');
  ok(JSON.stringify(sourceClosure(REPO_ROOT, ['cli/lib/load.ts', 'cli/lib/project-day.ts', 'engine/index.ts'])) === JSON.stringify(real.files.source), 'closure independent of entry-point order');
  ok(real.params === rulesFingerprint().params, 'v2 parameter hash equals the v1 parameter hash on an LF checkout (same files, same line format)');
  ok(real.files.source.includes('cli/lib/project-day.ts') && real.files.source.includes('engine/day.ts') && real.files.source.every((f) => !/^engine\/(clock|physics|scheduler)\//.test(f)), 'source = official pipeline closure; engine/clock, physics, scheduler (not imported by it) are outside');

  // 2. encoding
  {
    const r = repoCopy();
    for (const f of [...real.files.source, ...real.files.params, ...real.files.data]) edit(r, f, (s) => s.replace(/\n/g, '\r\n'));
    edit(r, 'engine/day.ts', (s) => '﻿' + s);
    ok(JSON.stringify(v2Record(fingerprintV2(r))) === JSON.stringify(v2Record(real)), 'CRLF checkout (+ BOM) gives the same v2');
    ok(rulesFingerprint(r).engine !== rulesFingerprint().engine, 'v1 is CRLF-sensitive (why v2 normalises; v1 is kept unchanged for existing history)');
    edit(r, 'engine/math.ts', (s) => s.replace(/\r\n/g, '\r'));
    ok(fingerprintV2(r).digest === real.digest, 'lone CR line ends give the same v2');
    ok(normalizeText(Buffer.from('a\r\nb\rc\n')) === 'a\nb\nc\n', 'normalisation: CRLF and CR -> LF');
    assert.throws(() => normalizeText(Buffer.from([0x61, 0xff, 0x62]), 'x'), /NOT_UTF8/); checks++;
    fs.writeFileSync(path.join(r, 'engine/math.ts'), Buffer.concat([fs.readFileSync(path.join(r, 'engine/math.ts')), Buffer.from([0xc3])]));
    assert.throws(() => fingerprintV2(r), /NOT_UTF8/); checks++;
  }

  // 3. non-simulation changes keep v2; simulation changes move it
  {
    const r = repoCopy(), base = fingerprintV2(r).digest;
    const nonSim = ['web/src/main.ts', 'docs/gm-rules.md', 'cli/advance.ts', 'cli/check-saves.ts', 'cli/web-export.ts', 'cli/lib/save-transaction.ts', 'cli/lib/fingerprint-v2.ts', 'cli/lib/rules-registry.ts', 'rules/registry.json', 'engine/physics/vec.ts', 'engine/clock/solar.ts', 'engine/scheduler/world-events.ts', 'engine/globals.d.ts'];
    for (const f of nonSim) {
      edit(r, f, (s) => (f.endsWith('.json') ? s.replace(/\n$/, ' \n') : s + '\n// edited\n'));
      ok(fingerprintV2(r).digest === base, `changing ${f} does not change v2`);
    }
    fs.mkdirSync(path.join(r, 'tests'), { recursive: true }); fs.writeFileSync(path.join(r, 'tests/new.test.ts'), 'export {};\n');
    ok(fingerprintV2(r).digest === base, 'adding a test file does not change v2');
  }
  {
    const sim: [string, keyof FingerprintV2, (s: string) => string][] = [
      ['engine/foraging.ts', 'source', (s) => s + '\n// comment: a content hash, not a semantic hash\n'],
      ['engine/types.ts', 'source', (s) => s + '\nexport type X = number;\n'],
      ['cli/lib/project-day.ts', 'source', (s) => s + '\n'],
      ['cli/lib/load.ts', 'source', (s) => s.replace("WORLD_FILE = 'world/xitun-garden.json'", "WORLD_FILE = 'world/xitun-garden.json' ")],
      ['species/pheidole-megacephala.json', 'params', (s) => s.replace(/\n$/, ' \n')],
      ['world/xitun-garden.json', 'params', (s) => s.replace(/\n$/, ' \n')],
      ['data/taichung-climatology-1991-2020.json', 'data', (s) => s.replace(/\n$/, ' \n')],
      ['.nvmrc', 'data', (s) => s.replace(/\d+\s*$/, (m) => String(Number(m.trim()) + 1) + '\n')],
      ['engine/day.ts', 'engine_version', (s) => s.replace(`ENGINE_VERSION = '${ENGINE_VERSION}'`, `ENGINE_VERSION = '${ENGINE_VERSION}-x'`)],
    ];
    for (const [f, field, fn] of sim) {
      const r = repoCopy(); edit(r, f, fn); const v = fingerprintV2(r);
      ok(v.digest !== real.digest && v[field] !== real[field], `changing ${f} changes v2 (${field})`);
    }
    const r = repoCopy();
    fs.writeFileSync(path.join(r, 'engine/new-mechanism.ts'), 'export const k = 1;\n');
    ok(fingerprintV2(r).digest === real.digest, 'an engine file nobody imports is outside v2');
    edit(r, 'engine/day.ts', (s) => "import { k } from './new-mechanism.ts';\n" + s);
    const v = fingerprintV2(r);
    ok(v.files.source.includes('engine/new-mechanism.ts') && v.digest !== real.digest, 'once imported by the pipeline it is hashed (deterministic rule, no list to forget)');
    edit(r, 'engine/new-mechanism.ts', (s) => s + '// x\n');
    ok(fingerprintV2(r).digest !== v.digest, '...and its later changes change v2');
  }

  // 4. self-reference and unhashed dependencies
  ok(['rules/registry.json', 'cli/lib/fingerprint.ts', 'cli/lib/fingerprint-v2.ts', 'cli/lib/rules-registry.ts'].every((f) => ![...real.files.source, ...real.files.params, ...real.files.data].includes(f)), 'registry and fingerprint modules are not hashed');
  ok([...real.files.source, ...real.files.params, ...real.files.data].every((f) => !V2_NEVER_HASHED.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))), 'no hashed file is in the never-hashed set');
  {
    const r = repoCopy(); edit(r, 'cli/lib/project-day.ts', (s) => "import { v2Digest } from './fingerprint-v2.ts';\n" + s);
    assert.throws(() => fingerprintV2(r), /SELF_REFERENCE/); checks++;
    const r2 = repoCopy(); edit(r2, 'engine/math.ts', (s) => "import x from 'left-pad';\n" + s);
    assert.throws(() => fingerprintV2(r2), /UNHASHED_DEPENDENCY/); checks++;
    const r3 = repoCopy(); edit(r3, 'engine/math.ts', (s) => "import { y } from './does-not-exist.ts';\n" + s);
    assert.throws(() => fingerprintV2(r3), /MISSING_SOURCE/); checks++;
    const r4 = repoCopy(); edit(r4, 'engine/math.ts', (s) => "// import { y } from './does-not-exist.ts';\n/* import z from 'pkg'; */\n" + s);
    ok(fingerprintV2(r4).files.source.join() === real.files.source.join(), 'commented-out imports are ignored');
    ok(importSpecifiers("import type { A } from './a.ts';\nexport * from './b.ts';\nimport './c.ts';\nconst m = await import('./d.ts');\nimport {\n  e,\n  f,\n} from '../e.ts';\nconst u = 'https://x.org/a';").join() === '../e.ts,./a.ts,./b.ts,./c.ts,./d.ts', 'import detector: type, re-export, side-effect, dynamic, multi-line');
  }

  // 5. compatibility with v1 history and adoption for the next day only
  const reg = readRegistry(), current = reg.versions.at(-1) as RulesVersion, v1 = rulesFingerprint(), V2 = v2Record(real);
  ok(registryProblems(reg, { ...v1, v2: V2 }, ENGINE_VERSION, (rel) => fs.existsSync(path.join(REPO_ROOT, rel))).length === 0, 'the current registry (v1-only entries) is consistent with the checkout seen with both fingerprints');
  ok(!current.fingerprint_v2 && current.fingerprint.engine === v1.engine && current.fingerprint.params === v1.params, `v1 still identifies the latest registered version ${current.rules_version} (this change registers no new version)`);
  ok(world(REPO_ROOT) === undefined && readJson('saves/main.json').simulation.latest_completed_day === 14, 'official Day14 save has no frozen fingerprint (frozen at Day15 activation); nothing in history is rewritten');
  {
    const cs = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli/check-saves.ts')], { encoding: 'utf8' });
    ok(cs.status === 0, 'npm run check:saves passes on the official Day14 saves: ' + (cs.stdout + cs.stderr).slice(-400));
  }
  const fakeV2 = (ev: string, seed: string): FingerprintV2 => { const f = { engine_version: ev, source: seed.repeat(64), params: real.params, data: real.data }; return { schema: FINGERPRINT_V2_SCHEMA, ...f, digest: v2Digest(f) }; };
  const F32 = { engine: 'a'.repeat(64), params: 'b'.repeat(64) }, V32 = fakeV2('test-v32', 'e');
  const entry = (id: string, fpx: typeof F32, prev: string, v2?: FingerprintV2): RulesVersion => ({ rules_version: id, tag: id, fingerprint: fpx, ...(v2 ? { fingerprint_v2: v2 } : {}), approved_in: 'test', golden: current.golden, previous: prev, save_schema: 'antempire.engine-v2', state_migration: null });
  const reg32: Registry = { ...reg, versions: [...reg.versions, entry('test-v32', F32, current.rules_version, V32)] };
  const run32 = { ...F32, v2: V32 };
  ok(registryProblems(reg32, run32, 'test-v32', () => true).length === 0, 'a registry entry with fingerprint_v2 validates');
  {
    const bad: Registry = { ...reg32, versions: [...reg32.versions, entry('test-v33', { engine: 'c'.repeat(64), params: 'd'.repeat(64) }, 'test-v32')] };
    ok(registryProblems(bad, { engine: 'c'.repeat(64), params: 'd'.repeat(64) }, 'test-v33', () => true).some((p) => p.includes('fingerprint_v2 missing')), 'after the first v2 entry every later entry must carry fingerprint_v2');
    const tampered: Registry = { ...reg, versions: [...reg.versions, entry('test-v32', F32, current.rules_version, { ...V32, source: 'f'.repeat(64) })] };
    ok(registryProblems(tampered, run32, 'test-v32', () => true).some((p) => p.includes('digest does not match')), 'a hand-edited fingerprint_v2 (digest not matching its fields) is detected');
    ok(registryProblems(reg32, { ...F32, v2: fakeV2('test-v32', '9') }, 'test-v32', () => true).some((p) => p.includes('not registered')), 'a checkout whose v1 matches but v2 differs is not the registered version');
    const dup: Registry = { ...reg, versions: [...reg.versions, entry('test-v32', current.fingerprint, current.rules_version, V32)] };
    ok(registryProblems(dup, { ...current.fingerprint, v2: V32 }, 'test-v32', () => true).some((p) => p.includes('duplicate v1')), 'two versions with the same v1 fingerprint are refused');
  }

  const root = savesCopy();
  advance({ root, confirm: true, expectDay: 15, now: NOW });
  const w15 = world(root);
  ok(!('schema' in w15.rules_fingerprint) && w15.rules_fingerprint.engine === v1.engine && w15.rules_fingerprint.activated_from_day === 15, 'Day15 activation under a v1-only registered version freezes v1 (unchanged behaviour)');
  ok(advance({ root, confirm: true, expectDay: 16, now: NOW }).written, 'a v1-frozen save keeps advancing with the v1 check while v2 is computed alongside');
  const dry = advance({ root, confirm: false, adoptRules: 'test-v32', testOverrides: { registry: reg32, fingerprint: run32 } });
  ok(!dry.written && /--adopt-rules test-v32 --confirm-advance --day 17/.test(dry.reason ?? ''), 'adoption dry run names the exact command and writes nothing');
  assert.throws(() => advance({ root, confirm: true, expectDay: 17, now: NOW, testOverrides: { registry: reg32, fingerprint: run32 } }), /RULES FROZEN.*--adopt-rules test-v32/); checks++;
  const r17 = advance({ root, confirm: true, expectDay: 17, now: NOW, adoptRules: 'test-v32', testOverrides: { registry: reg32, fingerprint: run32 } });
  const w17 = world(root), h = w17.rules_history.at(-1), log = readCommitLog(root)?.entries ?? [];
  ok(r17.written && w17.rules_fingerprint.schema === FINGERPRINT_V2_SCHEMA && w17.rules_fingerprint.digest === V32.digest && w17.rules_fingerprint.activated_from_day === 17, 'adoption freezes the v2 record from Day17');
  ok(h.event === 'adopted' && h.effective_from_day === 17 && h.from_fingerprint.engine === v1.engine && !('schema' in h.from_fingerprint) && h.to_fingerprint.digest === V32.digest, 'rules_history: v1 -> v2, effective Day17');
  ok(log.map((e) => e.day).join() === '15,16,17' && log.slice(0, 2).every((e) => 'engine' in e.rules_fingerprint && (e.rules_fingerprint as { engine: string }).engine === v1.engine) && 'digest' in log[2].rules_fingerprint && log[2].rules_adopted?.to === 'test-v32', 'commit log: Day15–16 keep their v1 record, Day17 records v2 (no retroactive change)');
  ok(fs.readFileSync(path.join(root, 'journal/v2-day-0017.md'), 'utf8').includes('v2 ' + V32.digest.slice(0, 12)), 'the Day17 journal names the v2 digest');
  ok(advance({ root, confirm: true, expectDay: 18, now: NOW, testOverrides: { registry: reg32, fingerprint: run32 } }).written, 'later days advance normally under v2');
  assert.throws(() => advance({ root, confirm: true, expectDay: 19, now: NOW, testOverrides: { registry: reg32, fingerprint: { ...F32, v2: fakeV2('test-v32', '9') } } }), /RULES FROZEN/); checks++;
  ok(true, 'v2-frozen save: a source change with the same v1 fingerprint (e.g. cli/lib/project-day.ts) is refused');
  assert.throws(() => advance({ root, confirm: true, expectDay: 19, now: NOW, testOverrides: { registry: reg32, fingerprint: F32 } }), /RULES FROZEN/); checks++;
  ok(true, 'v2-frozen save: a checkout without a v2 fingerprint is refused');
  {
    const reg33: Registry = { ...reg32, versions: [...reg32.versions, entry('test-v33', { engine: 'c'.repeat(64), params: 'd'.repeat(64) }, 'test-v32')] };
    assert.throws(() => advance({ root, confirm: true, expectDay: 19, now: NOW, adoptRules: 'test-v33', testOverrides: { registry: reg33, fingerprint: { engine: 'c'.repeat(64), params: 'd'.repeat(64) } } }), /V2_DOWNGRADE/); checks++;
    ok(world(root).rules_fingerprint.digest === V32.digest, 'no return from v2 to v1 (refused, nothing written)');
  }
  {
    const r = savesCopy(), withV2: Registry = { ...reg, versions: [...reg.versions.slice(0, -1), { ...current, fingerprint_v2: V2 }] };
    advance({ root: r, confirm: true, expectDay: 15, now: NOW, testOverrides: { registry: withV2, fingerprint: { ...v1, v2: V2 } } });
    const w = world(r);
    ok(w.rules_fingerprint.schema === FINGERPRINT_V2_SCHEMA && w.rules_fingerprint.digest === V2.digest && w.rules_history[0].fingerprint.digest === V2.digest && 'digest' in (readCommitLog(r)?.entries[0].rules_fingerprint ?? {}), 'if the running registered version records v2, Day15 activation freezes v2 directly');
  }

  // 6. real dry run
  const d = advance({ root: REPO_ROOT, confirm: false });
  ok(!d.written && /^dry run/.test(d.reason ?? '') && d.day === 15 && d.checks.every((c) => c.ok || c.level !== 'error'), 'npm run advance (dry run) on the official Day14 saves: all checks pass, nothing written');
  console.log(JSON.stringify({ test: 'fingerprint-v2', passed: true, checks, v2: V2, source_files: real.files.source.length, real_saves_unchanged: true }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  assert.equal(snapReal(), realBefore, 'REAL SAVES OR JOURNAL CHANGED');
}
