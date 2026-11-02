/**
 * `npm run advance` tested ONLY on temporary copies (the real saves/ and journal/ must stay byte-identical):
 *  1. dry run writes nothing (no lock, no transaction directory, no journal);
 *  2. Day14 -> Day15 with --confirm-advance --day 15: saves, journal and commit log committed together, in the
 *     repo's JSON format; conservation and commit consistency pass; result identical to the current engine
 *     and main/world byte-identical to projectDaily called directly (v6 equivalence: tests/differential.test.ts);
 *  3. Day15 -> Day20 chain with the frozen rules fingerprint: every day's saved engine state equals a direct
 *     engine call on the previous saved state; every journal exists and matches the commit log;
 *  4. --day must equal the next game day; a tampered fingerprint is refused; nothing is written in either case;
 *  5. the real saves/ and journal/ are unchanged.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { advance } from '../cli/advance.ts';
import { checkSaves } from '../cli/lib/conservation.ts';
import { commitConsistency, readCommitLog } from '../cli/lib/save-transaction.ts';
import { rulesFingerprint } from '../cli/lib/fingerprint.ts';
import { projectDaily, DEFAULT_REFS } from '../cli/lib/project-day.ts';
import { byFingerprint, readRegistry } from '../cli/lib/rules-registry.ts';
import { REPO_ROOT, readJson, loadBundle } from '../cli/lib/load.ts';
import { migrationState, simulateDay } from '../engine/index.ts';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const realSaves = ['saves/main.json', 'saves/world-state.json'].map((f) => [f, sha(path.join(REPO_ROOT, f))]);
const listDir = (d: string) => fs.readdirSync(d).sort().join(',');
const journalBefore = listDir(path.join(REPO_ROOT, 'journal')), savesBefore = listDir(path.join(REPO_ROOT, 'saves'));
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'antempire-advance-'));
for (const d of ['saves', 'data', 'journal']) fs.cpSync(path.join(REPO_ROOT, d), path.join(tmp, d), { recursive: true });
const snapshot = () => ['saves', 'journal'].map((d) => listDir(path.join(tmp, d)) + ':' + fs.readdirSync(path.join(tmp, d)).filter((f) => fs.statSync(path.join(tmp, d, f)).isFile()).map((f) => sha(path.join(tmp, d, f))).join()).join('|');
try {
  const now = '2026-11-01T00:00:00.000Z';
  // 1. dry run
  const h0 = snapshot(), dry = advance({ root: tmp, confirm: false, now });
  ok(!dry.written && snapshot() === h0 && !fs.existsSync(path.join(tmp, 'saves/.txn')) && !fs.existsSync(path.join(tmp, 'saves/.advance.lock')), 'dry run writes nothing (no lock, no transaction, no journal)');
  ok(dry.day === 15 && dry.checks.every((c) => c.ok), 'dry run computes Day15 and every check (saves, transition, journal) passes');
  assert.throws(() => advance({ root: tmp, confirm: true, now }), /requires --day/); checks++;
  assert.throws(() => advance({ root: tmp, confirm: true, expectDay: 16, now }), /DUPLICATE_DAY/); checks++;
  ok(snapshot() === h0, 'wrong or missing --day writes nothing');

  // 2. Day14 -> Day15
  const m14 = readJson('saves/main.json', tmp), w14 = readJson('saves/world-state.json', tmp);
  const r15 = advance({ root: tmp, confirm: true, expectDay: 15, now });
  ok(r15.written && r15.files.join() === 'saves/world-state.json,saves/main.json,journal/v2-day-0015.md,saves/commit-log.json', 'Day15 commits world, main, journal and commit log together');
  const mainText = fs.readFileSync(path.join(tmp, 'saves/main.json'), 'utf8'), worldText = fs.readFileSync(path.join(tmp, 'saves/world-state.json'), 'utf8');
  const m15 = JSON.parse(mainText), w15 = JSON.parse(worldText);
  ok(mainText === JSON.stringify(m15, null, 2) + '\n' && worldText === JSON.stringify(w15, null, 2) + '\n', 'save format: 2-space JSON + trailing newline (same as v6 runner)');
  ok(m15.simulation.latest_completed_day === 15 && m15.simulation.elapsed_sim_hours === 360 && w15.time.scientific_clock.day === 15 && w15.time.scientific_clock.calendar_date === '2026-11-14', 'clock advanced exactly one day to 2026-11-14');
  ok(w15.sim_engine_v2?.schema === 'antempire.engine-v2' && w15.sim_engine_v2.rules_fingerprint.activated_from_day === 15, 'engine state persisted with frozen rules fingerprint');
  const journal15 = fs.readFileSync(path.join(tmp, 'journal/v2-day-0015.md'), 'utf8');
  ok(m15.simulation.latest_journal === 'journal/v2-day-0015.md' && journal15 === r15.journal && journal15.startsWith('# 🐜《螞蟻帝國》Day 15｜2026-11-14'), 'latest_journal points at the committed Day15 journal');
  ok(journal15.split('\n').filter((l) => l.startsWith('- {"type":')).length === w15.day_log_latest.events.length && journal15.includes('## 當日事件整理（自動產生）'), 'journal records every engine event plus the readable summary');
  const errs = [...checkSaves(m15, w15), ...commitConsistency(tmp, m15)].filter((c) => !c.ok && c.level === 'error');
  ok(errs.length === 0, 'conservation and commit consistency of the committed Day15: ' + JSON.stringify(errs));
  ok(!fs.existsSync(path.join(tmp, 'saves/.advance.lock')) && fs.readdirSync(path.join(tmp, 'saves/.txn')).join() === 'committed-day-0015', 'lock released; only the committed transaction (previous version) remains');
  const direct = simulateDay(migrationState(m14, w14, readJson('data/taichung-climatology-1991-2020.json', tmp), loadBundle()), loadBundle());
  ok(JSON.stringify(w15.day_log_latest.events) === JSON.stringify(direct.events) && JSON.stringify(w15.sim_engine_v2.population) === JSON.stringify(direct.state.population) && JSON.stringify(w15.sim_engine_v2.colony) === JSON.stringify(direct.state.colony), 'saved Day15 = direct engine result');
  // The save mapping itself is pinned against v6 by tests/differential.test.ts (approved changes undone);
  // here the committed Day15 must equal the current mapping called directly, byte for byte.
  {
    const fpNow = rulesFingerprint(), ref = projectDaily(m14, w14, readJson('data/taichung-climatology-1991-2020.json', tmp), loadBundle(), fpNow, DEFAULT_REFS, now, { rulesVersion: byFingerprint(readRegistry(), fpNow)?.rules_version ?? null });
    ok(JSON.stringify(ref.main, null, 2) + '\n' === mainText && JSON.stringify(ref.world, null, 2) + '\n' === worldText && journal15.startsWith(ref.journal), 'Day15 main/world byte-identical to projectDaily called directly; its journal draft starts the committed journal');
  }

  // 3. Day16..Day20; each saved engine state = direct engine call on the previous one
  for (let d = 16; d <= 20; d++) {
    const { rules_history: history, ...prev } = readJson('saves/world-state.json', tmp).sim_engine_v2; // #11 bookkeeping is not engine input
    const r = advance({ root: tmp, confirm: true, expectDay: d, now });
    ok(r.written && r.day === d && r.checks.every((c) => c.ok || c.level === 'warning'), `Day${d} committed with all error-level checks passing`);
    const saved = readJson('saves/world-state.json', tmp), expected = simulateDay(prev, loadBundle());
    const { rules_history: savedHistory, ...savedState } = saved.sim_engine_v2;
    ok(JSON.stringify(savedHistory) === JSON.stringify(history), `Day${d}: rules history carried over unchanged (no adoption)`);
    ok(JSON.stringify(savedState) === JSON.stringify(expected.state) && JSON.stringify(saved.day_log_latest.events) === JSON.stringify(expected.events), `Day${d} saved engine state = direct engine result`);
  }
  const log = readCommitLog(tmp);
  ok(log?.entries.map((e) => e.day).join() === '15,16,17,18,19,20', 'commit log has one entry per committed day');
  ok(commitConsistency(tmp, readJson('saves/main.json', tmp)).every((c) => c.ok || c.level === 'warning'), 'all six journals present and unchanged; saves = last committed version');

  // 4. tampered fingerprint -> refused, nothing written
  const w = readJson('saves/world-state.json', tmp); w.sim_engine_v2.rules_fingerprint.params = 'tampered';
  fs.writeFileSync(path.join(tmp, 'saves/world-state.json'), JSON.stringify(w, null, 2) + '\n');
  const h1 = snapshot();
  assert.throws(() => advance({ root: tmp, confirm: true, expectDay: 21, now }), /CONFLICT|RULES FROZEN/); checks++;
  ok(snapshot() === h1 && !fs.existsSync(path.join(tmp, 'saves/.advance.lock')), 'edited saves (not the last committed version) are refused and nothing is written');
  // Even if the commit log is edited to match, the frozen rules fingerprint still refuses the day.
  const logAbs = path.join(tmp, 'saves/commit-log.json'), lg = JSON.parse(fs.readFileSync(logAbs, 'utf8'));
  lg.entries.at(-1).files['saves/world-state.json'] = sha(path.join(tmp, 'saves/world-state.json'));
  fs.writeFileSync(logAbs, JSON.stringify(lg, null, 2) + '\n');
  const h2 = snapshot();
  assert.throws(() => advance({ root: tmp, confirm: true, expectDay: 21, now }), /RULES FROZEN/); checks++;
  ok(snapshot() === h2 && !fs.existsSync(path.join(tmp, 'saves/.advance.lock')) && !fs.readdirSync(path.join(tmp, 'saves/.txn')).some((d) => d.startsWith('pending')), 'changed rules fingerprint is refused; nothing written, lock released');
  console.log(JSON.stringify({ passed: true, checks, days_committed_on_temp_copy: 6, real_saves_unchanged: true }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [f, h] of realSaves) assert.equal(sha(path.join(REPO_ROOT, f)), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(listDir(path.join(REPO_ROOT, 'journal')), journalBefore, 'REAL journal/ changed');
  assert.equal(listDir(path.join(REPO_ROOT, 'saves')), savesBefore, 'REAL saves/ gained or lost files');
}
