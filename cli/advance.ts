/**
 * 推進一個遊戲日（正式推進只在 Node 執行）。
 *
 *   npm run advance                                   # 預演 (dry run)：不取得鎖、不寫任何檔案
 *   npm run advance -- --confirm-advance --day 15     # 玩家明確要求推進 Day15 時才使用
 *   npm run advance -- --recover                      # 中斷後：完成或撤銷未完成的交易，不推進新的一天
 *   npm run advance -- --adopt-rules <版本> --confirm-advance --day N
 *                                                     # 玩家明確要求時：把凍結的規則換成登錄檔中緊接的下一個
 *                                                     # 已核准版本，並在同一筆交易中用新規則推進 Day N（#11）
 *   npm run advance -- --root <dir>                   # 對另一個存檔目錄（例如臨時副本）操作
 *   npm run advance -- --summary-out <file>           # 另存當日事件摘要（Markdown）
 *
 * 一個遊戲日 = 一筆交易：凍結的引擎跑一天 → 人口、幼體、糖蛋白、時間與日誌全部檢查 → 同時準備
 * saves/main.json、saves/world-state.json、journal/v2-day-NNNN.md、saves/commit-log.json →
 * 寫入暫存區並建立 PREPARED manifest（提交點）→ 套用 → 驗證。任何一步失敗都可由 --recover 回到
 * 「完整的前一天」或「完整的新一天」（見 cli/lib/save-transaction.ts 與 docs/save-transactions.md）。
 * 已提交的日誌是不可改寫的歷史；同一天不可推進第二次（--day 必須等於下一個遊戲日）。
 * 引擎與參數一律來自本工具所在的 checkout；--root 只決定存檔位置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadBundle, readJson, REPO_ROOT } from './lib/load.ts';
import { rulesFingerprint } from './lib/fingerprint.ts';
import { projectDaily, DEFAULT_REFS } from './lib/project-day.ts';
import { checkJournal, checkSaves, checkTransition, type Check } from './lib/conservation.ts';
import { daySummaryMarkdown } from './lib/day-summary.ts';
import { COMMIT_LOG_REL, InjectedCrash, TransactionError, acquireLock, commitConsistency, commitDay, ioFromEnv, nowFromEnv, leftoverTempFiles, nextCommitLog, nodeIo, pendingTransactions, readCommitLog, readLock, recoverTransactions, sha256, type Io } from './lib/save-transaction.ts';
import { ENGINE_VERSION, num } from '../engine/index.ts';
import { byFingerprint, planAdoption, readRegistry, RulesError, type Fingerprint, type Registry } from './lib/rules-registry.ts';

export interface AdvanceOptions {
  root: string; confirm: boolean; expectDay?: number; now?: string; summaryOut?: string; io?: Io;
  /** #11: switch the frozen rules to this registered version (Owner request only). */
  adoptRules?: string;
  /** Tests on temporary copies only: replace the checkout's fingerprint / the registry (refused for the real saves). */
  testOverrides?: { fingerprint?: Fingerprint; registry?: Registry };
}
export interface AdvanceResult { written: boolean; day: number; date: string; checks: Check[]; summary: string; journal: string; files: string[]; reason?: string }

const json = (x: unknown) => JSON.stringify(x, null, 2) + '\n';
const MAIN = 'saves/main.json', WORLD = 'saves/world-state.json';

/** Refuse to touch saves while an interrupted transaction, leftover temp files or a lock exist. */
function assertNoInterruptedState(root: string, io: Io, allowOwnLock: boolean) {
  const pending = pendingTransactions(root, io);
  if (pending.length) throw new TransactionError('PENDING', `unfinished save transaction ${pending.join(', ')}; saves may be mixed. Run: npm run advance -- --recover`);
  const temps = leftoverTempFiles(root, io);
  if (temps.length) throw new TransactionError('TEMP_FILES', `leftover temporary files ${temps.join(', ')}; run: npm run advance -- --recover`);
  if (!allowOwnLock) { const lock = readLock(root, io); if (lock) throw new TransactionError(lock.stale ? 'STALE_LOCK' : 'LOCKED', lock.stale ? `stale advance lock (pid ${lock.pid}); run: npm run advance -- --recover` : `another advance is running (pid ${lock.pid}); refusing`); }
}

export function advance(opts: AdvanceOptions): AdvanceResult {
  const root = path.resolve(opts.root), io = opts.io ?? nodeIo, now = opts.now ?? new Date().toISOString();
  if (opts.confirm && !Number.isInteger(opts.expectDay)) throw Error('--confirm-advance requires --day <N> (the game day you intend to create), so a repeated command cannot advance twice');
  // Writers hold the lock for the whole read-simulate-commit sequence; dry runs never lock or write.
  const release = opts.confirm ? acquireLock(root, `advance to Day ${opts.expectDay}`, io, now) : () => {};
  let crashed = false;
  try {
    assertNoInterruptedState(root, io, opts.confirm);
    const rawMain = io.read(path.join(root, MAIN)), rawWorld = io.read(path.join(root, WORLD));
    const main = JSON.parse(rawMain.toString('utf8')), world = JSON.parse(rawWorld.toString('utf8'));
    const consistency = commitConsistency(root, main, io).filter((c) => !c.ok && c.level === 'error');
    if (consistency.length) throw new TransactionError('CONFLICT', 'saves are not the last committed version: ' + consistency.map((c) => c.name).join('; '));
    if (opts.testOverrides && root === path.resolve(REPO_ROOT)) throw Error('test overrides are only allowed on a temporary copy (--root)');
    const bundle = loadBundle(), fp = opts.testOverrides?.fingerprint ?? rulesFingerprint(), registry = opts.testOverrides?.registry ?? readRegistry();
    const frozen = world.sim_engine_v2?.rules_fingerprint as Fingerprint | undefined;
    const adoption = opts.adoptRules ? planAdoption(registry, frozen, opts.adoptRules, fp) : undefined;
    const currentVersion = byFingerprint(registry, fp), frozenVersion = frozen ? byFingerprint(registry, frozen) : undefined;
    const frozenHint = currentVersion && frozenVersion && currentVersion.previous === frozenVersion.rules_version ? `The running engine is the next approved version ${currentVersion.rules_version} (frozen: ${frozenVersion.rules_version}); to switch, the Owner must request: npm run advance -- --adopt-rules ${currentVersion.rules_version} --confirm-advance --day N` : '';
    const before = { main: structuredClone(main), world: structuredClone(world) };
    const beforeChecks = checkSaves(main, world).filter((c) => !c.ok && c.level === 'error');
    if (beforeChecks.length) throw Error('Current saves fail conservation checks; refusing to advance: ' + beforeChecks.map((c) => c.name).join('; '));
    const climatology = world.sim_engine_v2 ? null : readJson('data/taichung-climatology-1991-2020.json', root);
    const expectedStart = world.sim_engine_v2 ? { sugar: world.sim_engine_v2.colony.sugar, protein: world.sim_engine_v2.colony.protein } : { sugar: num(bundle.world, 'day15_migration.starting_sugar'), protein: num(bundle.world, 'day15_migration.starting_protein') };
    const run = projectDaily(main, world, climatology, bundle, fp, DEFAULT_REFS, now, { rulesVersion: currentVersion?.rules_version ?? null, adopt: adoption, frozenHint });
    const day = run.report.day, journalRel: string = run.main.simulation.latest_journal;
    const checks = [...checkSaves(run.main, run.world), ...checkTransition(before, { main: run.main, world: run.world }, run.report, expectedStart)];
    const journal = run.journal + '\n' + daySummaryMarkdown(run.report, checks, { embedded: true });
    checks.push(...checkJournal({ main: run.main }, run.report, journalRel, journal));
    const journalExists = io.exists(path.join(root, journalRel));
    checks.push({ name: 'history: journal of the new day does not exist yet (committed history is never overwritten)', ok: !journalExists, level: 'error', ...(journalExists ? { detail: journalRel } : {}) });
    const summary = daySummaryMarkdown(run.report, checks);
    const result: AdvanceResult = { written: false, day, date: run.report.summary.date, checks, summary, journal, files: [] };
    if (opts.summaryOut) { fs.mkdirSync(path.dirname(path.resolve(opts.summaryOut)), { recursive: true }); fs.writeFileSync(path.resolve(opts.summaryOut), summary); }
    const errors = checks.filter((c) => !c.ok && c.level === 'error');
    if (errors.length) return { ...result, reason: 'checks failed; nothing written: ' + errors.map((c) => c.name).join('; ') };
    if (!opts.confirm) return { ...result, reason: `dry run (to create Day ${day}: npm run advance -- ${adoption ? `--adopt-rules ${adoption.to.rules_version} ` : ''}--confirm-advance --day ${day})` };
    if (opts.expectDay !== day) throw new TransactionError('DUPLICATE_DAY', `the next game day is Day ${day}, but --day ${opts.expectDay} was requested; refusing (a day is never advanced twice)`);

    const prevLog = readCommitLog(root, io);
    const files = { [WORLD]: json(run.world), [MAIN]: json(run.main), [journalRel]: journal };
    const entry = { day, date: run.report.summary.date, committed_at: now, engine_version: ENGINE_VERSION, rules_version: currentVersion?.rules_version ?? null, ...(adoption ? { rules_adopted: { from: adoption.from.rules_version, to: adoption.to.rules_version, effective_from_day: day } } : {}), rules_fingerprint: { engine: fp.engine, params: fp.params }, files: Object.fromEntries(Object.entries(files).map(([rel, text]) => [rel, sha256(text)])), previous: { [WORLD]: sha256(rawWorld), [MAIN]: sha256(rawMain), [journalRel]: null } };
    const logText = json(nextCommitLog(prevLog, entry));
    const logAbs = path.join(root, COMMIT_LOG_REL), preLog = io.exists(logAbs) ? sha256(io.read(logAbs)) : null;
    commitDay(root, {
      fromDay: day - 1, toDay: day, now,
      targets: [{ rel: WORLD, mode: 'replace', content: files[WORLD] }, { rel: MAIN, mode: 'replace', content: files[MAIN] }, { rel: journalRel, mode: 'create', content: journal }, { rel: COMMIT_LOG_REL, mode: preLog ? 'replace' : 'create', content: logText }],
      expectedPre: { [WORLD]: sha256(rawWorld), [MAIN]: sha256(rawMain), [journalRel]: null, [COMMIT_LOG_REL]: preLog },
    }, io);
    return { ...result, written: true, files: [WORLD, MAIN, journalRel, COMMIT_LOG_REL] };
  } catch (err) {
    crashed = err instanceof InjectedCrash;
    throw err;
  } finally {
    if (!crashed) release(); // a simulated kill leaves its lock behind, exactly like a real one
  }
}

/** Finish or undo an interrupted advance. Never creates a new game day. */
export function recover(root: string, io: Io = nodeIo, now = new Date().toISOString()): { actions: string[]; state: string } {
  root = path.resolve(root);
  const actions: string[] = [];
  const lock = readLock(root, io);
  if (lock && !lock.stale) throw new TransactionError('LOCKED', `an advance is running (pid ${lock.pid} on ${lock.host}); not recovering underneath it`);
  if (lock?.stale) { io.unlink(path.join(root, 'saves/.advance.lock')); actions.push(`removed stale lock of pid ${lock.pid} (${lock.started_at})`); }
  const release = acquireLock(root, 'recover', io, now);
  try {
    const r = recoverTransactions(root, io);
    return { actions: [...actions, ...r.actions], state: r.state };
  } finally { release(); }
}

if (import.meta.main) {
  const args = process.argv.slice(2), value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const root = path.resolve(value('--root') ?? REPO_ROOT);
  try {
    const io = ioFromEnv(root, REPO_ROOT), now = nowFromEnv(root, REPO_ROOT);
    if (args.includes('--recover')) {
      const r = recover(root, io, now);
      console.log(JSON.stringify(r, null, 2));
      console.error(r.state === 'rolled-forward' ? '交易已完成（roll forward）；沒有推進額外的一天。' : r.state === 'rolled-back' ? '未完成的交易已撤銷（roll back）；存檔維持前一天。' : '沒有需要復原的交易。');
    } else {
      const dayArg = value('--day');
      const r = advance({ root, confirm: args.includes('--confirm-advance'), expectDay: dayArg === undefined ? undefined : Number(dayArg), summaryOut: value('--summary-out'), io, now, adoptRules: value('--adopt-rules') });
      process.stdout.write(r.summary + '\n');
      for (const c of r.checks.filter((x) => !x.ok)) console.error(`${c.level.toUpperCase()}: ${c.name} ${JSON.stringify(c.detail)}`);
      console.error(r.written ? `已提交 Day ${r.day}（${r.date}）：${r.files.join('、')}。日誌已寫入且不可改寫。` : `未寫入任何檔案：${r.reason}`);
      if (r.checks.some((c) => !c.ok && c.level === 'error')) process.exitCode = 1;
    }
  } catch (err) {
    console.error(`推進／復原中止：${(err as Error).message}`);
    process.exitCode = err instanceof TransactionError || err instanceof RulesError ? 3 : 1;
  }
}
