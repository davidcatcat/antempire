/**
 * Save transaction & recovery (cli/lib/save-transaction.ts, cli/advance.ts). TEMPORARY COPIES ONLY.
 *
 *  A. Fault matrix: Day14 -> Day15 interrupted at EVERY durable step, both as an abrupt crash (no cleanup
 *     code runs) and as a disk-full write error (half the bytes written). Afterwards the four files are
 *     either byte-identical to Day14 or (after recovery) byte-identical to a clean Day15 commit — never mixed
 *     once recovery has run. Before the commit point recovery rolls back; after it, rolls forward.
 *  B. Real abrupt termination: the CLI is killed (exit 137) mid-apply; check:saves flags the mixed state;
 *     a normal advance refuses (stale lock); `--recover` completes Day15; advancing Day15 again is refused.
 *  C. Concurrency: two CLI processes asking for Day15 at the same time -> exactly one commits.
 *  D. Duplicate day: restoring the Day14 saves after Day15 was committed is refused (commit log + journal).
 *  E. Corrupted staging area and an external edit while pending -> recovery refuses and changes nothing.
 *  F. Leftover temporary files block advancing until recovery removes them.
 * Finally the repository's real saves/ and journal/ are verified unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { advance, recover } from '../cli/advance.ts';
import { checkSaves } from '../cli/lib/conservation.ts';
import { commitConsistency, faultyIo, InjectedCrash, pendingTransactions, readLock, LOCK_REL, TMP_SUFFIX } from '../cli/lib/save-transaction.ts';
import { REPO_ROOT, readJson } from '../cli/lib/load.ts';

const NOW = '2026-11-01T00:00:00.000Z';
const FILES = ['saves/main.json', 'saves/world-state.json', 'journal/v2-day-0015.md', 'saves/commit-log.json'];
const sha = (abs: string) => (fs.existsSync(abs) ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : 'absent');
const listDir = (d: string) => fs.readdirSync(d).sort().join(',');
const realBefore = { main: sha(path.join(REPO_ROOT, 'saves/main.json')), world: sha(path.join(REPO_ROOT, 'saves/world-state.json')), journal: listDir(path.join(REPO_ROOT, 'journal')), saves: listDir(path.join(REPO_ROOT, 'saves')) };
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-txn-'));
const template = path.join(work, 'template');
for (const d of ['saves', 'data', 'journal']) fs.cpSync(path.join(REPO_ROOT, d), path.join(template, d), { recursive: true });
let n = 0;
const fresh = () => { const dir = path.join(work, `case-${n++}`); fs.cpSync(template, dir, { recursive: true }); return dir; };
const state = (root: string) => FILES.map((f) => sha(path.join(root, f))).join('|');
const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid as number;
const markLockDead = (root: string) => { const abs = path.join(root, LOCK_REL); const l = JSON.parse(fs.readFileSync(abs, 'utf8')); l.pid = deadPid(); fs.writeFileSync(abs, JSON.stringify(l)); };
const consistent = (root: string) => { const m = readJson('saves/main.json', root), w = readJson('saves/world-state.json', root); return [...checkSaves(m, w), ...commitConsistency(root, m)].filter((c) => !c.ok && c.level === 'error'); };
const cli = (root: string, args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli/advance.ts'), '--root', root, ...args], { encoding: 'utf8', env: { ...process.env, ANTEMPIRE_NOW: NOW, ...env } });

try {
  // Reference states.
  const day14 = state(template);
  const ref = fresh(); advance({ root: ref, confirm: true, expectDay: 15, now: NOW });
  const day15 = state(ref);
  ok(day15 !== day14 && consistent(ref).length === 0, 'clean reference Day15 commit is consistent');

  // ---------------- A. fault matrix ----------------
  const steps = ['begin', 'intent', 'backup:saves/world-state.json', 'backup:saves/main.json', 'stage:saves/world-state.json', 'stage:saves/main.json', 'stage:journal/v2-day-0015.md', 'stage:saves/commit-log.json', 'manifest', 'apply:saves/world-state.json', 'apply:saves/main.json', 'apply:journal/v2-day-0015.md', 'apply:saves/commit-log.json', 'verify', 'finish'];
  const commitPoint = steps.indexOf('apply:saves/world-state.json'); // first step after the PREPARED manifest rename
  const matrix: { step: string; kind: string; after_fault: string; after_recovery: string }[] = [];
  for (const [i, step] of steps.entries()) for (const kind of ['crash', 'error'] as const) {
    const root = fresh(), io = faultyIo(kind === 'crash' ? { at: step, kind } : { at: step, kind, code: 'ENOSPC', partial: 0.5 });
    let thrown: unknown = null;
    try { advance({ root, confirm: true, expectDay: 15, now: NOW, io }); } catch (err) { thrown = err; }
    ok(io.fired() && thrown, `${kind}@${step}: fault fired and advance did not report success`);
    if (kind === 'crash') ok(thrown instanceof InjectedCrash, `${kind}@${step}: simulated kill propagates without cleanup`);
    const afterFault = state(root), pending = pendingTransactions(root).length;
    if (kind === 'error' && i < commitPoint) ok(afterFault === day14 && pending === 0 && !fs.existsSync(path.join(root, LOCK_REL)), `error@${step}: before the commit point everything is rolled back immediately`);
    if (afterFault !== day14 && afterFault !== day15) ok(consistent(root).length > 0, `${kind}@${step}: a mixed state is flagged by check:saves`);
    if (pending || fs.existsSync(path.join(root, LOCK_REL))) {
      assert.throws(() => advance({ root, confirm: true, expectDay: 15, now: NOW }), /LOCKED|STALE_LOCK|PENDING|TEMP_FILES/); checks++;
      if (fs.existsSync(path.join(root, LOCK_REL))) markLockDead(root); // the crashed process is gone
      recover(root, undefined, NOW);
    } else if (fs.readdirSync(path.join(root, 'saves')).some((f) => f.endsWith(TMP_SUFFIX))) recover(root, undefined, NOW);
    const final = state(root);
    const expected = i < commitPoint ? day14 : day15;
    ok(final === expected, `${kind}@${step}: after recovery the files are exactly ${i < commitPoint ? 'Day14' : 'Day15'}`);
    ok(pendingTransactions(root).length === 0 && !fs.existsSync(path.join(root, LOCK_REL)) && consistent(root).length === 0, `${kind}@${step}: recovered state is consistent, no pending transaction, no lock`);
    if (final === day14) { advance({ root, confirm: true, expectDay: 15, now: NOW }); ok(state(root) === day15, `${kind}@${step}: re-running Day15 after roll back gives the reference bytes`); }
    else { assert.throws(() => advance({ root, confirm: true, expectDay: 15, now: NOW }), /DUPLICATE_DAY/); checks++; ok(state(root) === day15, `${kind}@${step}: Day15 cannot be advanced twice`); }
    matrix.push({ step, kind, after_fault: afterFault === day14 ? 'Day14' : afterFault === day15 ? 'Day15' : 'MIXED/pending', after_recovery: final === day14 ? 'Day14 (rolled back)' : 'Day15 (rolled forward)' });
  }

  // ---------------- B. real kill of the CLI process ----------------
  {
    const root = fresh();
    const killed = cli(root, ['--confirm-advance', '--day', '15'], { ANTEMPIRE_FAULT: 'kill@apply:saves/main.json' });
    ok(killed.status === 137, 'CLI killed mid-apply (exit 137)');
    ok(readJson('saves/world-state.json', root).time.scientific_clock.day === 15 && readJson('saves/main.json', root).simulation.latest_completed_day === 14, 'kill left a genuinely mixed state (world Day15, main Day14)');
    const check = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli/check-saves.ts'), root], { encoding: 'utf8' });
    ok(check.status === 1 && /FAIL\s+transaction: no unfinished save transaction/.test(check.stdout), 'check:saves fails on the mixed state and names the unfinished transaction');
    ok(readLock(root)?.stale === true, 'the killed process left a stale lock');
    const refused = cli(root, ['--confirm-advance', '--day', '15']);
    ok(refused.status === 3 && /STALE_LOCK/.test(refused.stderr), 'normal advance refuses while the interrupted transaction is unresolved');
    const rec = cli(root, ['--recover']);
    ok(rec.status === 0 && /rolled forward/.test(rec.stdout), '--recover rolls the committed day forward');
    ok(state(root) === day15 && consistent(root).length === 0, 'after recovery the files are exactly the reference Day15');
    const again = cli(root, ['--confirm-advance', '--day', '15']);
    ok(again.status === 3 && /DUPLICATE_DAY/.test(again.stderr), 'asking for Day15 again is refused');
    const kill2 = fresh();
    ok(cli(kill2, ['--confirm-advance', '--day', '15'], { ANTEMPIRE_FAULT: 'kill@stage:saves/main.json' }).status === 137 && cli(kill2, ['--recover']).status === 0 && state(kill2) === day14, 'kill before the commit point -> --recover rolls back to Day14');
    const guard = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli/advance.ts'), '--confirm-advance', '--day', '15'], { encoding: 'utf8', env: { ...process.env, ANTEMPIRE_FAULT: 'kill@apply:saves/main.json' } });
    ok(guard.status !== 0 && /only allowed with --root/.test(guard.stderr), 'fault injection is refused on the repository\'s own saves');
  }

  // ---------------- C. two processes at once ----------------
  {
    const root = fresh();
    const runOne = () => new Promise<{ status: number | null; err: string }>((resolve) => { const p = spawn(process.execPath, [path.join(REPO_ROOT, 'cli/advance.ts'), '--root', root, '--confirm-advance', '--day', '15'], { env: { ...process.env, ANTEMPIRE_NOW: NOW } }); let err = ''; p.stderr.on('data', (d) => (err += d)); p.on('close', (status) => resolve({ status, err })); });
    const results = await Promise.all([runOne(), runOne(), runOne()]);
    const winners = results.filter((r) => r.status === 0), losers = results.filter((r) => r.status !== 0);
    ok(winners.length === 1 && losers.length === 2 && losers.every((r) => r.status === 3 && /LOCKED|DUPLICATE_DAY/.test(r.err)), 'three concurrent advances: exactly one commits, the others are refused');
    const log = readJson('saves/commit-log.json', root);
    ok(log.entries.length === 1 && log.entries[0].day === 15 && readJson('saves/main.json', root).simulation.latest_completed_day === 15 && consistent(root).length === 0, 'exactly one Day15 committed, consistent');
    const root2 = fresh(); fs.writeFileSync(path.join(root2, LOCK_REL), JSON.stringify({ pid: process.pid, host: os.hostname(), started_at: NOW, purpose: 'test' }));
    assert.throws(() => advance({ root: root2, confirm: true, expectDay: 15, now: NOW }), /LOCKED/); checks++;
    assert.throws(() => recover(root2, undefined, NOW), /LOCKED/); checks++;
    ok(state(root2) === day14, 'a live lock blocks both advance and recover; nothing written');
  }

  // ---------------- D. duplicate day via restored saves ----------------
  {
    const root = fresh(); advance({ root, confirm: true, expectDay: 15, now: NOW });
    for (const f of ['saves/main.json', 'saves/world-state.json']) fs.copyFileSync(path.join(template, f), path.join(root, f));
    assert.throws(() => advance({ root, confirm: true, expectDay: 15, now: NOW }), /CONFLICT/); checks++;
    ok(sha(path.join(root, 'journal/v2-day-0015.md')) === sha(path.join(ref, 'journal/v2-day-0015.md')), 'restored Day14 saves cannot re-run Day15; the committed Day15 journal is untouched');
    assert.throws(() => advance({ root, confirm: false, now: NOW }), /CONFLICT/); checks++;
    ok(state(root) !== day15 && sha(path.join(root, 'saves/commit-log.json')) === sha(path.join(ref, 'saves/commit-log.json')), 'even a dry run refuses saves that are not the last committed version');
    // Without a commit log (e.g. log also rolled back by hand) the existing Day15 journal still blocks re-creation.
    fs.rmSync(path.join(root, 'saves/commit-log.json'));
    const dry = advance({ root, confirm: false, now: NOW });
    ok(!dry.written && dry.checks.some((c) => !c.ok && c.name.startsWith('history: journal of the new day does not exist')), 'the existing Day15 journal is reported and blocks the day');
    const before = state(root), confirmed = advance({ root, confirm: true, expectDay: 15, now: NOW });
    ok(!confirmed.written && /checks failed/.test(confirmed.reason ?? '') && state(root) === before, 'a confirmed advance is refused too; nothing written');
  }

  // ---------------- E. corrupted staging / external edit while pending ----------------
  {
    const root = fresh();
    try { advance({ root, confirm: true, expectDay: 15, now: NOW, io: faultyIo({ at: 'apply:saves/main.json', kind: 'crash' }) }); } catch { /* crash */ }
    markLockDead(root);
    const [txn] = pendingTransactions(root), staged = path.join(root, 'saves/.txn', txn, 'staged', 'saves__main.json');
    fs.appendFileSync(staged, ' ');
    const before = state(root);
    assert.throws(() => recover(root, undefined, NOW), /CORRUPT/); checks++;
    ok(state(root) === before && pendingTransactions(root).length === 1, 'corrupted staged copy: recovery refuses and changes nothing');
    const root2 = fresh();
    try { advance({ root: root2, confirm: true, expectDay: 15, now: NOW, io: faultyIo({ at: 'apply:saves/main.json', kind: 'crash' }) }); } catch { /* crash */ }
    markLockDead(root2);
    fs.writeFileSync(path.join(root2, 'saves/main.json'), fs.readFileSync(path.join(root2, 'saves/main.json'), 'utf8').replace('"save_id"', '"save_id_edited"'));
    const before2 = state(root2);
    assert.throws(() => recover(root2, undefined, NOW), /CONFLICT/); checks++;
    ok(state(root2) === before2, 'a file edited outside the transaction is never overwritten by recovery');
  }

  // ---------------- F. leftover temporary files ----------------
  {
    const root = fresh(); fs.writeFileSync(path.join(root, 'saves/main.json' + TMP_SUFFIX), '{"half":');
    assert.throws(() => advance({ root, confirm: true, expectDay: 15, now: NOW }), /TEMP_FILES/); checks++;
    const r = recover(root, undefined, NOW);
    ok(r.actions.some((a) => a.includes('leftover temporary file')) && !fs.existsSync(path.join(root, 'saves/main.json' + TMP_SUFFIX)) && state(root) === day14, 'recovery removes leftover temp files without touching the saves');
    advance({ root, confirm: true, expectDay: 15, now: NOW }); ok(state(root) === day15, 'after cleanup Day15 commits normally');
  }

  console.log(JSON.stringify({ passed: true, checks, fault_cases: matrix.length, commit_point_after: steps[commitPoint - 1], matrix }, null, 2));
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  assert.equal(sha(path.join(REPO_ROOT, 'saves/main.json')), realBefore.main, 'REAL saves/main.json changed');
  assert.equal(sha(path.join(REPO_ROOT, 'saves/world-state.json')), realBefore.world, 'REAL saves/world-state.json changed');
  assert.equal(listDir(path.join(REPO_ROOT, 'journal')), realBefore.journal, 'REAL journal/ changed');
  assert.equal(listDir(path.join(REPO_ROOT, 'saves')), realBefore.saves, 'REAL saves/ gained or lost files');
}
