/**
 * #11 rules version registry and safe rules upgrade. Everything that writes runs on TEMPORARY copies of the
 * saves; the real saves/ and journal/ must stay byte-identical.
 *  1. CI guard: the current checkout's rules fingerprint is the latest APPROVED registry entry, every entry keeps
 *     its golden traces, versions form one chain (no gaps, no duplicates);
 *  2. Day15 activation records the registered rules version in sim_engine_v2.rules_history;
 *  3. with a newer approved version running, a normal advance is refused (RULES FROZEN, with the exact
 *     --adopt-rules hint) and writes nothing;
 *  4. refused adoptions write nothing: unregistered version, running checkout differs from the target, skipping
 *     a version, wrong --day, saves without frozen rules (Day14);
 *  5. --adopt-rules <next> --confirm-advance --day N switches the frozen rules and advances Day N in ONE
 *     transaction: rules_history gains {from,to,effective_from_day:N}, the commit log records the adoption,
 *     later days run normally under the new rules, the old checkout is then refused;
 *  6. a fault during the adoption transaction recovers to exactly the old version (no half-adopted state);
 *  7. the old version's golden traces are still on disk (old rules evidence is kept).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { advance, recover } from '../cli/advance.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';
import { readRegistry, registryProblems, type Registry } from '../cli/lib/rules-registry.ts';
import { faultyIo, pendingTransactions, readCommitLog, LOCK_REL } from '../cli/lib/save-transaction.ts';
import { ENGINE_VERSION } from '../engine/index.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const realSaves = ['saves/main.json', 'saves/world-state.json'].map((f) => [f, sha(path.join(REPO_ROOT, f))]);
const listDir = (d: string) => fs.readdirSync(d).sort().join(',');
const journalBefore = listDir(path.join(REPO_ROOT, 'journal'));
const NOW = '2026-11-02T00:00:00.000Z';

// 1. CI guard on the real registry
const reg = readRegistry(), fp = rulesFingerprint();
const problems = registryProblems(reg, fp, ENGINE_VERSION, (rel) => fs.existsSync(path.join(REPO_ROOT, rel)));
ok(problems.length === 0, 'registry consistent with the checkout: ' + problems.join('; '));
ok(registryProblems(reg, { engine: 'f'.repeat(64), params: fp.params }, ENGINE_VERSION, () => true).some((p) => p.includes('not registered')), 'an unregistered engine change is detected');
const current = reg.versions.at(-1) as Registry['versions'][number];

// Fake successors for the protocol tests (same engine code; only the identity differs).
const F13 = { engine: 'a'.repeat(64), params: 'b'.repeat(64) }, F14 = { engine: 'c'.repeat(64), params: 'd'.repeat(64) };
const next = (id: string, fpx: typeof F13, prev: string) => ({ rules_version: id, tag: id, fingerprint: fpx, approved_in: 'test', golden: current.golden, previous: prev, save_schema: 'antempire.engine-v2', state_migration: null });
const reg13: Registry = { ...reg, versions: [...reg.versions, next('test-v13', F13, current.rules_version)] };
const reg14: Registry = { ...reg13, versions: [...reg13.versions, next('test-v14', F14, 'test-v13')] };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-rules-'));
const fresh = () => { const d = fs.mkdtempSync(path.join(tmp, 'c-')); for (const x of ['saves', 'data', 'journal']) fs.cpSync(path.join(REPO_ROOT, x), path.join(d, x), { recursive: true }); return d; };
const snap = (root: string) => ['saves', 'journal'].map((d) => listDir(path.join(root, d)) + ':' + fs.readdirSync(path.join(root, d)).filter((f) => fs.statSync(path.join(root, d, f)).isFile()).map((f) => sha(path.join(root, d, f))).join()).join('|');
const refused = (fn: () => unknown, re: RegExp, root: string, why: string) => { const h = snap(root); assert.throws(fn, re); checks++; ok(snap(root) === h && !fs.existsSync(path.join(root, LOCK_REL)) && pendingTransactions(root).length === 0, why + ' — nothing written, no lock, no pending transaction'); };
const world = (root: string) => readJson('saves/world-state.json', root).sim_engine_v2;

try {
  const root = fresh();
  // 4a. Day14 saves have no frozen rules: nothing to adopt.
  refused(() => advance({ root, confirm: true, expectDay: 15, now: NOW, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: F13 } }), /NOT_ACTIVE/, root, 'adopting before Day15 activation is refused');

  // 2. Day15 activation
  advance({ root, confirm: true, expectDay: 15, now: NOW });
  const h15 = world(root).rules_history;
  ok(Array.isArray(h15) && h15.length === 1 && h15[0].event === 'activated' && h15[0].rules_version === current.rules_version && h15[0].effective_from_day === 15, `Day15 activation records ${current.rules_version} in rules_history`);
  ok(readCommitLog(root)?.entries.at(-1)?.rules_version === current.rules_version, 'commit log names the rules version of each day');

  // 3. newer approved checkout: normal advance refused with the exact hint
  refused(() => advance({ root, confirm: true, expectDay: 16, now: NOW, testOverrides: { registry: reg13, fingerprint: F13 } }), /RULES FROZEN.*--adopt-rules test-v13/, root, 'normal advance with a newer approved checkout is refused and names the adoption command');

  // 4. refused adoptions
  refused(() => advance({ root, confirm: true, expectDay: 16, now: NOW, adoptRules: 'nope', testOverrides: { registry: reg13, fingerprint: F13 } }), /UNREGISTERED/, root, 'unregistered version refused');
  refused(() => advance({ root, confirm: true, expectDay: 16, now: NOW, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: current.fingerprint } }), /CHECKOUT_MISMATCH/, root, 'adopting a version that is not the running checkout is refused');
  refused(() => advance({ root, confirm: true, expectDay: 16, now: NOW, adoptRules: 'test-v14', testOverrides: { registry: reg14, fingerprint: F14 } }), /SKIPPED_VERSION/, root, 'skipping an approved version is refused');
  refused(() => advance({ root, confirm: true, expectDay: 17, now: NOW, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: F13 } }), /DUPLICATE_DAY/, root, 'adoption with the wrong --day is refused');
  refused(() => advance({ root, confirm: true, expectDay: 16, now: NOW, adoptRules: current.rules_version, testOverrides: { registry: reg13, fingerprint: current.fingerprint } }), /ALREADY_ACTIVE/, root, 'adopting the already frozen version is refused');
  assert.throws(() => advance({ root: REPO_ROOT, confirm: false, testOverrides: { registry: reg13 } }), /temporary copy/); checks++;
  {
    const h = snap(root), dry = advance({ root, confirm: false, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: F13 } });
    ok(!dry.written && snap(root) === h && /--adopt-rules test-v13 --confirm-advance --day 16/.test(dry.reason ?? ''), 'dry run of an adoption writes nothing and prints the exact command');
  }

  // 6. fault during the adoption transaction -> back to exactly the old version
  {
    const r = fresh(); advance({ root: r, confirm: true, expectDay: 15, now: NOW });
    const before = snap(r);
    for (const step of ['manifest', 'apply:saves/world-state.json', 'apply:saves/commit-log.json']) {
      const rr = fresh(); fs.rmSync(path.join(rr, 'saves'), { recursive: true }); fs.rmSync(path.join(rr, 'journal'), { recursive: true });
      fs.cpSync(path.join(r, 'saves'), path.join(rr, 'saves'), { recursive: true }); fs.cpSync(path.join(r, 'journal'), path.join(rr, 'journal'), { recursive: true });
      const io = faultyIo({ at: step, kind: 'crash' });
      assert.throws(() => advance({ root: rr, confirm: true, expectDay: 16, now: NOW, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: F13 }, io })); checks++;
      const lock = path.join(rr, LOCK_REL); if (fs.existsSync(lock)) { const l = JSON.parse(fs.readFileSync(lock, 'utf8')); l.pid = 2 ** 22 + 12345; fs.writeFileSync(lock, JSON.stringify(l)); }
      recover(rr, undefined, NOW);
      const w = world(rr), adopted = w.rules_history.length === 2;
      if (step === 'manifest') ok(!adopted && snap(rr) === before && w.rules_fingerprint.engine === current.fingerprint.engine, `crash@${step} (before the commit point): recovery restores exactly the old version`);
      else ok(adopted && w.rules_fingerprint.engine === F13.engine && w.rules_history[1].effective_from_day === 16 && readJson('saves/main.json', rr).simulation.latest_completed_day === 16, `crash@${step} (after the commit point): recovery completes the adoption and Day16 together`);
      ok(pendingTransactions(rr).length === 0 && !fs.existsSync(lock), `crash@${step}: no pending transaction or lock after recovery`);
    }
  }

  // 5. successful adoption
  const r16 = advance({ root, confirm: true, expectDay: 16, now: NOW, adoptRules: 'test-v13', testOverrides: { registry: reg13, fingerprint: F13 } });
  const w16 = world(root);
  ok(r16.written && w16.rules_fingerprint.engine === F13.engine && w16.rules_fingerprint.params === F13.params && w16.rules_fingerprint.activated_from_day === 16, 'adoption switches the frozen fingerprint, effective from Day16');
  ok(w16.rules_history.length === 2 && w16.rules_history[1].event === 'adopted' && w16.rules_history[1].from_version === current.rules_version && w16.rules_history[1].to_version === 'test-v13' && w16.rules_history[1].effective_from_day === 16, 'rules_history records from, to and the effective day');
  const e16 = readCommitLog(root)?.entries.at(-1) as NonNullable<ReturnType<typeof readCommitLog>>['entries'][number];
  ok(e16.day === 16 && e16.rules_adopted?.from === current.rules_version && e16.rules_adopted?.to === 'test-v13' && e16.rules_adopted?.effective_from_day === 16, 'commit log records the adoption with Day16 in the same transaction');
  const r17 = advance({ root, confirm: true, expectDay: 17, now: NOW, testOverrides: { registry: reg13, fingerprint: F13 } });
  ok(r17.written && world(root).rules_history.length === 2, 'later days advance normally under the adopted rules; history unchanged');
  refused(() => advance({ root, confirm: true, expectDay: 18, now: NOW, testOverrides: { registry: reg13, fingerprint: current.fingerprint } }), /RULES FROZEN/, root, 'the old checkout can no longer advance the adopted save');

  // 7. old evidence kept
  ok(reg.versions.every((v) => fs.existsSync(path.join(REPO_ROOT, v.golden.traces))), 'every registered version keeps its golden traces');
  console.log(JSON.stringify({ passed: true, checks, registered_versions: reg.versions.map((v) => v.tag), current: current.rules_version, real_saves_unchanged: true }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [f, h] of realSaves) assert.equal(sha(path.join(REPO_ROOT, f)), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(listDir(path.join(REPO_ROOT, 'journal')), journalBefore, 'REAL journal/ changed');
}
