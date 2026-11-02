/**
 * Recoverable commit of one game day (saves/main.json, saves/world-state.json, the day's journal and the
 * commit log) — a write-ahead, roll-forward transaction on an ordinary POSIX file system.
 *
 * WHAT IS GUARANTEED (and what is not)
 * - A file system cannot atomically replace several files at once; a sequence of renames is NOT a
 *   multi-file atomic transaction. Instead this module guarantees RECOVERABILITY: after any failure or
 *   abrupt termination, `recover()` returns the four files to exactly one of two states — the complete
 *   previous day (roll back) or the complete new day (roll forward) — or refuses with an explanation when
 *   it cannot prove which one is correct (e.g. a file was edited by something else). Never a silent mix.
 * - Each single file is replaced atomically (write tmp → fsync → rename → fsync dir), so no reader ever
 *   sees a half-written JSON file.
 * - The COMMIT POINT is the durable rename of `manifest.json` (state PREPARED) inside the pending
 *   transaction directory. Before it, recovery rolls back; after it, recovery rolls forward.
 * - While a transaction is pending, the set of saves may be mixed (e.g. world Day15, main Day14).
 *   Readers must check `pendingTransactions()` (or run `npm run check:saves`) and treat the saves as
 *   unusable until `npm run advance -- --recover` has run. Readers that only see the git repository are
 *   protected by check:saves in CI (mixed days, commit-log and journal hashes are checked).
 * - Only one advancing process at a time: an exclusive lock file (O_CREAT|O_EXCL). A stale lock (same host,
 *   process no longer alive) is only removed by an explicit `--recover`.
 *
 * LAYOUT (all under the save root)
 *   saves/.advance.lock                       exclusive lock (pid, host, time)          [git-ignored]
 *   saves/.txn/pending-day-NNNN/intent.json   pre-image hashes, written first           [git-ignored]
 *   saves/.txn/pending-day-NNNN/backup/*      byte copies of the previous version       [git-ignored]
 *   saves/.txn/pending-day-NNNN/staged/*      the complete new version                  [git-ignored]
 *   saves/.txn/pending-day-NNNN/manifest.json state PREPARED + all hashes (commit point)
 *   saves/.txn/committed-day-NNNN/            the last committed transaction (keeps the previous version)
 *   saves/commit-log.json                     confirmed versions: per day, sha256 of every file [committed to git]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCK_REL = 'saves/.advance.lock';
export const TXN_DIR_REL = 'saves/.txn';
export const COMMIT_LOG_REL = 'saves/commit-log.json';
export const TMP_SUFFIX = '.advance-tmp';
export const sha256 = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const pad = (day: number) => String(day).padStart(4, '0');
const encode = (rel: string) => rel.replace(/\//g, '__');

// ---------------------------------------------------------------------------------------------------
// File operations, injectable so tests can simulate errors, partial writes and abrupt termination.
// ---------------------------------------------------------------------------------------------------

/** Thrown by fault injection to simulate the process being killed: no cleanup code may run. */
export class InjectedCrash extends Error { constructor(at: string) { super('INJECTED CRASH at ' + at); } }
export type TransactionCode = 'LOCKED' | 'STALE_LOCK' | 'PENDING' | 'CONFLICT' | 'CORRUPT' | 'DUPLICATE_DAY' | 'TEMP_FILES';
export class TransactionError extends Error {
  code: TransactionCode;
  constructor(code: TransactionCode, message: string) { super(`${code}: ${message}`); this.code = code; }
}

export interface Io {
  /** Called before every durable step; fault injection hooks in here. */
  checkpoint(name: string): void;
  read(abs: string): Buffer;
  exists(abs: string): boolean;
  /** Write a NEW file durably (fails if it exists). */
  writeNew(abs: string, data: string | Buffer, step: string): void;
  rename(from: string, to: string): void;
  /** Hard link `from` to `to`; fails if `to` exists (atomic create-if-absent). */
  link(from: string, to: string): void;
  unlink(abs: string): void;
  mkdir(abs: string): void;
  mkdirp(abs: string): void;
  rmrf(abs: string): void;
  readdir(abs: string): string[];
  fsyncDir(abs: string): void;
}

export const nodeIo: Io = {
  checkpoint() {},
  read: (abs) => fs.readFileSync(abs),
  exists: (abs) => fs.existsSync(abs),
  writeNew(abs, data) {
    const fd = fs.openSync(abs, 'wx');
    try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  },
  rename: (a, b) => fs.renameSync(a, b),
  link: (a, b) => fs.linkSync(a, b),
  unlink: (abs) => fs.unlinkSync(abs),
  mkdir: (abs) => fs.mkdirSync(abs),
  mkdirp: (abs) => { fs.mkdirSync(abs, { recursive: true }); },
  rmrf: (abs) => fs.rmSync(abs, { recursive: true, force: true }),
  readdir: (abs) => (fs.existsSync(abs) ? fs.readdirSync(abs) : []),
  fsyncDir(abs) { const fd = fs.openSync(abs, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } },
};

export interface FaultPlan {
  /** Checkpoint name (exact, or a prefix ending with '*'). */
  at: string;
  /** crash: abrupt termination (no cleanup). error: the operation fails with `code` after writing `partial` of the data. kill: process.exit(137). */
  kind: 'crash' | 'error' | 'kill';
  code?: string;
  /** For 'error' on a write: fraction of the bytes written before failing (simulates a full disk). */
  partial?: number;
}

/** Io that injects ONE fault at the first matching checkpoint. */
export function faultyIo(plan: FaultPlan, base: Io = nodeIo): Io & { fired: () => boolean } {
  let fired = false, armedWrite: { code: string; partial: number } | null = null;
  const matches = (name: string) => (plan.at.endsWith('*') ? name.startsWith(plan.at.slice(0, -1)) : name === plan.at);
  return {
    ...base,
    fired: () => fired,
    checkpoint(name) {
      if (fired || !matches(name)) return;
      fired = true;
      if (plan.kind === 'kill') process.exit(137);
      if (plan.kind === 'crash') throw new InjectedCrash(name);
      armedWrite = { code: plan.code ?? 'EIO', partial: plan.partial ?? 0 };
    },
    writeNew(abs, data, step) {
      if (armedWrite) {
        const { code, partial } = armedWrite; armedWrite = null;
        const buf = typeof data === 'string' ? Buffer.from(data) : data;
        if (partial > 0) fs.writeFileSync(abs, buf.subarray(0, Math.floor(buf.length * partial)));
        throw Object.assign(new Error(`${code}: injected failure writing ${path.basename(abs)} (${step})`), { code });
      }
      base.writeNew(abs, data, step);
    },
    rename(a, b) { if (armedWrite) { const { code } = armedWrite; armedWrite = null; throw Object.assign(new Error(`${code}: injected failure renaming ${path.basename(a)}`), { code }); } base.rename(a, b); },
    link(a, b) { if (armedWrite) { const { code } = armedWrite; armedWrite = null; throw Object.assign(new Error(`${code}: injected failure linking ${path.basename(b)}`), { code }); } base.link(a, b); },
  };
}

/** Fixed clock for reproducible tests (ANTEMPIRE_NOW). Like fault injection, never allowed on the repository's own saves. */
export function nowFromEnv(root: string, repoRoot: string): string | undefined {
  const now = process.env.ANTEMPIRE_NOW;
  if (!now) return undefined;
  if (path.resolve(root) === path.resolve(repoRoot)) throw Error('ANTEMPIRE_NOW is only allowed with --root pointing at a temporary copy');
  if (Number.isNaN(Date.parse(now))) throw Error('ANTEMPIRE_NOW must be an ISO timestamp');
  return now;
}

/** Fault injection from the environment, for real-process kill tests. Never allowed on the repository's own saves. */
export function ioFromEnv(root: string, repoRoot: string): Io {
  const spec = process.env.ANTEMPIRE_FAULT;
  if (!spec) return nodeIo;
  if (path.resolve(root) === path.resolve(repoRoot)) throw Error('ANTEMPIRE_FAULT is only allowed with --root pointing at a temporary copy');
  const [kind, at] = spec.split('@');
  if (!['crash', 'error', 'kill'].includes(kind) || !at) throw Error('ANTEMPIRE_FAULT must look like kill@apply:saves/main.json');
  return faultyIo({ at, kind: kind as FaultPlan['kind'], code: 'ENOSPC', partial: 0.5 });
}

// ---------------------------------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------------------------------

export interface LockInfo { pid: number; host: string; started_at: string; purpose: string }

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readLock(root: string, io: Io = nodeIo): (LockInfo & { stale: boolean }) | null {
  const abs = path.join(root, LOCK_REL);
  if (!io.exists(abs)) return null;
  let info: LockInfo;
  try { info = JSON.parse(io.read(abs).toString('utf8')); } catch { return { pid: -1, host: '?', started_at: '?', purpose: 'unreadable lock file', stale: false }; }
  return { ...info, stale: info.host === os.hostname() && !pidAlive(info.pid) };
}

/** Acquire the exclusive advance lock or throw LOCKED / STALE_LOCK. Returns the release function. */
export function acquireLock(root: string, purpose: string, io: Io = nodeIo, now = new Date().toISOString()): () => void {
  const abs = path.join(root, LOCK_REL);
  const info: LockInfo = { pid: process.pid, host: os.hostname(), started_at: now, purpose };
  try { io.writeNew(abs, JSON.stringify(info, null, 2) + '\n', 'lock'); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const held = readLock(root, io);
    if (held?.stale) throw new TransactionError('STALE_LOCK', `stale advance lock from pid ${held.pid} (${held.started_at}, not running); a previous advance was interrupted — run: npm run advance -- --recover`);
    throw new TransactionError('LOCKED', `another advance is running (pid ${held?.pid} on ${held?.host}, since ${held?.started_at}); refusing`);
  }
  return () => { try { io.unlink(abs); } catch { /* already gone */ } };
}

// ---------------------------------------------------------------------------------------------------
// Commit log
// ---------------------------------------------------------------------------------------------------

export interface CommitEntry {
  day: number; date: string; committed_at: string; engine_version: string;
  /** #11: registered rules version of the running checkout (rules/registry.json); null if unregistered. */
  rules_version?: string | null;
  /** #11: present on the day a new approved rules version was adopted. */
  rules_adopted?: { from: string; to: string; effective_from_day: number };
  rules_fingerprint: { engine: string; params: string };
  files: Record<string, string>;     // rel -> sha256 of the committed bytes
  previous: Record<string, string | null>; // rel -> sha256 of what was replaced (null = newly created)
}
export interface CommitLog { schema: 'antempire.commit-log.v1'; note: string; entries: CommitEntry[] }

export function readCommitLog(root: string, io: Io = nodeIo): CommitLog | null {
  const abs = path.join(root, COMMIT_LOG_REL);
  return io.exists(abs) ? JSON.parse(io.read(abs).toString('utf8')) : null;
}

export function nextCommitLog(prev: CommitLog | null, entry: CommitEntry): CommitLog {
  return { schema: 'antempire.commit-log.v1', note: 'Confirmed game-day versions written by npm run advance. Each entry lists the sha256 of every file committed for that day; journals listed here are immutable history.', entries: [...(prev?.entries ?? []), entry] };
}

// ---------------------------------------------------------------------------------------------------
// Transaction
// ---------------------------------------------------------------------------------------------------

export interface TargetFile { rel: string; mode: 'replace' | 'create'; content: string }
interface ManifestTarget { rel: string; mode: 'replace' | 'create'; pre_sha256: string | null; staged_sha256: string }
interface Manifest { schema: 'antempire.save-transaction.v1'; state: 'PREPARED'; from_day: number; to_day: number; created_at: string; targets: ManifestTarget[] }
interface Intent { schema: 'antempire.save-transaction-intent.v1'; from_day: number; to_day: number; created_at: string; pid: number; targets: { rel: string; mode: 'replace' | 'create'; pre_sha256: string | null }[] }

const txnRoot = (root: string) => path.join(root, TXN_DIR_REL);
export function pendingTransactions(root: string, io: Io = nodeIo): string[] {
  return io.readdir(txnRoot(root)).filter((d) => d.startsWith('pending-day-')).sort();
}
export function leftoverTempFiles(root: string, io: Io = nodeIo): string[] {
  const out: string[] = [];
  for (const dir of ['saves', 'journal']) for (const f of io.readdir(path.join(root, dir))) if (f.endsWith(TMP_SUFFIX)) out.push(`${dir}/${f}`);
  return out;
}

const shaOf = (root: string, rel: string, io: Io) => { const abs = path.join(root, rel); return io.exists(abs) ? sha256(io.read(abs)) : null; };

function writeDurable(io: Io, abs: string, data: string | Buffer, step: string) {
  io.checkpoint(step);
  io.writeNew(abs, data, step);
  io.fsyncDir(path.dirname(abs));
}

/** Replace or create one target from its staged copy; idempotent; refuses if the target was changed by anyone else. */
function applyTarget(root: string, dir: string, t: ManifestTarget, io: Io) {
  const abs = path.join(root, t.rel), cur = shaOf(root, t.rel, io);
  if (cur === t.staged_sha256) return; // already applied (roll-forward resumed)
  if (cur !== t.pre_sha256) throw new TransactionError('CONFLICT', `${t.rel} changed outside the transaction (sha ${cur?.slice(0, 12)} is neither the previous ${t.pre_sha256?.slice(0, 12) ?? 'absent'} nor the new ${t.staged_sha256.slice(0, 12)} version); refusing to touch it`);
  const tmp = abs + TMP_SUFFIX;
  if (io.exists(tmp)) io.unlink(tmp);
  io.checkpoint('apply:' + t.rel);
  io.writeNew(tmp, io.read(path.join(dir, 'staged', encode(t.rel))), 'apply:' + t.rel);
  if (t.mode === 'create') { io.link(tmp, abs); io.unlink(tmp); } // link fails if the file appeared meanwhile
  else io.rename(tmp, abs);
  io.fsyncDir(path.dirname(abs));
}

function rollForward(root: string, dir: string, m: Manifest, io: Io) {
  for (const t of m.targets) {
    const staged = path.join(dir, 'staged', encode(t.rel));
    if (!io.exists(staged) || sha256(io.read(staged)) !== t.staged_sha256) throw new TransactionError('CORRUPT', `staged copy of ${t.rel} is missing or corrupted; cannot roll forward safely`);
  }
  for (const t of m.targets) applyTarget(root, dir, t, io);
  io.checkpoint('verify');
  for (const t of m.targets) if (shaOf(root, t.rel, io) !== t.staged_sha256) throw new TransactionError('CORRUPT', `${t.rel} does not match its staged version after apply`);
  // Keep exactly one completed transaction (= the previous confirmed version) on disk.
  io.checkpoint('finish');
  const done = path.join(txnRoot(root), `committed-day-${pad(m.to_day)}`);
  for (const d of io.readdir(txnRoot(root))) if (d.startsWith('committed-day-')) io.rmrf(path.join(txnRoot(root), d));
  io.rename(dir, done);
  io.fsyncDir(txnRoot(root));
}

export interface CommitPlan { fromDay: number; toDay: number; now: string; targets: TargetFile[]; expectedPre: Record<string, string | null> }

/**
 * Commit a fully validated day. Caller must hold the lock. `expectedPre` = sha256 of each target when the
 * caller read it (optimistic concurrency): if anything changed since, nothing is written.
 */
export function commitDay(root: string, plan: CommitPlan, io: Io = nodeIo): { files: string[] } {
  if (pendingTransactions(root, io).length) throw new TransactionError('PENDING', 'an unfinished transaction exists; run: npm run advance -- --recover');
  const targets = plan.targets.map((t) => ({ ...t, pre: shaOf(root, t.rel, io), staged_sha256: sha256(t.content) }));
  for (const t of targets) {
    if (t.pre !== (plan.expectedPre[t.rel] ?? null)) throw new TransactionError('CONFLICT', `${t.rel} changed after it was read; nothing written`);
    if (t.mode === 'create' && t.pre !== null) throw new TransactionError('DUPLICATE_DAY', `${t.rel} already exists; committed history is never overwritten`);
  }
  io.mkdirp(txnRoot(root));
  const dir = path.join(txnRoot(root), `pending-day-${pad(plan.toDay)}`);
  io.checkpoint('begin');
  io.mkdir(dir); // EEXIST if another transaction for this day exists
  let prepared = false;
  try {
    const intent: Intent = { schema: 'antempire.save-transaction-intent.v1', from_day: plan.fromDay, to_day: plan.toDay, created_at: plan.now, pid: process.pid, targets: targets.map((t) => ({ rel: t.rel, mode: t.mode, pre_sha256: t.pre })) };
    writeDurable(io, path.join(dir, 'intent.json'), JSON.stringify(intent, null, 2) + '\n', 'intent');
    io.mkdir(path.join(dir, 'backup')); io.mkdir(path.join(dir, 'staged'));
    for (const t of targets) if (t.pre !== null) writeDurable(io, path.join(dir, 'backup', encode(t.rel)), io.read(path.join(root, t.rel)), 'backup:' + t.rel);
    for (const t of targets) writeDurable(io, path.join(dir, 'staged', encode(t.rel)), t.content, 'stage:' + t.rel);
    const manifest: Manifest = { schema: 'antempire.save-transaction.v1', state: 'PREPARED', from_day: plan.fromDay, to_day: plan.toDay, created_at: plan.now, targets: targets.map((t) => ({ rel: t.rel, mode: t.mode, pre_sha256: t.pre, staged_sha256: t.staged_sha256 })) };
    writeDurable(io, path.join(dir, 'manifest.json' + TMP_SUFFIX), JSON.stringify(manifest, null, 2) + '\n', 'manifest');
    io.rename(path.join(dir, 'manifest.json' + TMP_SUFFIX), path.join(dir, 'manifest.json'));
    io.fsyncDir(dir);
    prepared = true; // ---- COMMIT POINT ----
    rollForward(root, dir, manifest, io);
    return { files: targets.map((t) => t.rel) };
  } catch (err) {
    if (err instanceof InjectedCrash) throw err; // simulated kill: nothing else runs
    if (!prepared) { try { io.rmrf(dir); } catch { /* recover() will roll back */ } throw err; }
    throw new TransactionError('PENDING', `day ${plan.toDay} is committed (manifest PREPARED) but applying it failed: ${(err as Error).message}. The saves may be mixed until recovery; run: npm run advance -- --recover`);
  }
}

export interface RecoveryReport { actions: string[]; state: 'clean' | 'rolled-back' | 'rolled-forward' }

/** Finish or undo interrupted transactions and remove temporary files. Caller must hold the lock. */
export function recoverTransactions(root: string, io: Io = nodeIo): RecoveryReport {
  const actions: string[] = [];
  let state: RecoveryReport['state'] = 'clean';
  const pending = pendingTransactions(root, io);
  if (pending.length > 1) throw new TransactionError('CORRUPT', `more than one pending transaction (${pending.join(', ')}); manual inspection required`);
  for (const name of pending) {
    const dir = path.join(txnRoot(root), name), manifestAbs = path.join(dir, 'manifest.json');
    if (io.exists(manifestAbs)) {
      const m: Manifest = JSON.parse(io.read(manifestAbs).toString('utf8'));
      if (m.state !== 'PREPARED') throw new TransactionError('CORRUPT', `${name}: unknown manifest state ${m.state}`);
      rollForward(root, dir, m, io);
      actions.push(`rolled forward ${name}: Day ${m.to_day} completed`); state = 'rolled-forward';
    } else {
      const intentAbs = path.join(dir, 'intent.json');
      if (io.exists(intentAbs)) {
        let intent: Intent | null = null;
        try { intent = JSON.parse(io.read(intentAbs).toString('utf8')); } catch { intent = null; } // torn intent = crash while writing it
        for (const t of intent?.targets ?? []) {
          if (shaOf(root, t.rel, io) !== t.pre_sha256) throw new TransactionError('CONFLICT', `${name} never reached its commit point, but ${t.rel} differs from its recorded previous version; manual inspection required`);
        }
      }
      io.rmrf(dir);
      actions.push(`rolled back ${name}: commit point never reached, previous day kept`); state = 'rolled-back';
    }
  }
  for (const rel of leftoverTempFiles(root, io)) { io.unlink(path.join(root, rel)); actions.push(`removed leftover temporary file ${rel}`); }
  return { actions, state };
}

/** Read-only consistency report of the commit log, journals and transaction state (for check:saves and advance). */
export function commitConsistency(root: string, main: { simulation: { latest_completed_day: number; latest_journal?: string } }, io: Io = nodeIo): { name: string; ok: boolean; level: 'error' | 'warning'; detail?: unknown }[] {
  const out: { name: string; ok: boolean; level: 'error' | 'warning'; detail?: unknown }[] = [];
  const add = (name: string, ok: boolean, detail?: unknown, level: 'error' | 'warning' = 'error') => out.push({ name, ok, level, ...(detail === undefined ? {} : { detail }) });
  const pending = pendingTransactions(root, io), temps = leftoverTempFiles(root, io), lock = readLock(root, io);
  add('transaction: no unfinished save transaction', pending.length === 0, pending.length ? { pending, fix: 'npm run advance -- --recover' } : undefined);
  add('transaction: no leftover temporary files', temps.length === 0, temps.length ? { temps, fix: 'npm run advance -- --recover' } : undefined);
  add('transaction: no advance lock held', !lock, lock ?? undefined, 'warning');
  const day = main.simulation.latest_completed_day, log = readCommitLog(root, io);
  if (!log) {
    add('commit log: absent only before the first transactional day (Day ≤ 14)', day <= 14, { day });
    const early = io.readdir(path.join(root, 'journal')).filter((f) => /^v2-day-\d{4}-narrative/.test(f) && Number(f.slice(7, 11)) >= 15);
    add('journal: narrative files only for committed days', early.length === 0, early.length ? early : undefined);
    return out;
  }
  const days = log.entries.map((e) => e.day);
  add('commit log: consecutive days', days.every((d, i) => i === 0 || d === days[i - 1] + 1), days);
  const last = log.entries.at(-1);
  add('commit log: last committed day = saves day', last?.day === day, { log: last?.day, saves: day });
  if (last) for (const [rel, h] of Object.entries(last.files)) if (rel !== COMMIT_LOG_REL) add(`commit log: ${rel} = last committed version`, shaOf(root, rel, io) === h, { expected: h.slice(0, 16), actual: shaOf(root, rel, io)?.slice(0, 16) ?? 'missing' });
  for (const e of log.entries) for (const [rel, h] of Object.entries(e.files)) if (rel.startsWith('journal/')) add(`journal: ${rel} present and unchanged since Day ${e.day} commit`, shaOf(root, rel, io) === h, { expected: h.slice(0, 16), actual: shaOf(root, rel, io)?.slice(0, 16) ?? 'missing' });
  const committed = new Set(log.entries.map((e) => e.day));
  const earlyNarratives = io.readdir(path.join(root, 'journal')).filter((f) => /^v2-day-\d{4}-narrative/.test(f) && Number(f.slice(7, 11)) >= 15 && !committed.has(Number(f.slice(7, 11))));
  add('journal: narrative files only for committed days', earlyNarratives.length === 0, earlyNarratives.length ? earlyNarratives : undefined);
  if (day >= 15) add('journal: latest_journal of main.json exists', !!main.simulation.latest_journal && io.exists(path.join(root, main.simulation.latest_journal)), main.simulation.latest_journal);
  return out;
}
