/**
 * The ONLY module allowed to use browser persistence (CLAUDE.md §9 SAVE exception; prototypes/continuous-world/
 * worker-boundary.json experimental_save_store). It stores snapshots of NON-OFFICIAL experiment worlds in the IndexedDB
 * database antempire-experiment-worlds and nothing else: no official data, no network, no other storage.
 *
 * Save = three transactions (docs/experimental-save-system.md §5):
 *   1. write   the new snapshot as `pending` under a fresh store generation; the latest pointer (slots) is untouched;
 *   2. verify  re-read it in a separate transaction and recompute SHA-256 + header identity;
 *   3. promote check the pointer is still what this writer expects, put the new generation first in `slots`, mark it
 *              `verified`, sweep older unkept records. Only when this transaction fires `complete` is the save reported.
 * Any failure leaves the previous verified snapshot as the latest. Loading walks `slots` newest first, skips (and, for a
 * writer, quarantines) corrupted snapshots and reports the recovery; it never creates a new world on failure.
 * Payloads are opaque: hashed and stored as canonical JSON text, never interpreted.
 */
import {
  type Result, type RuntimeInfo, type SnapshotEnvelope, type SnapshotRecord, type WorldRecord, type WorldSummary, type Compatibility,
  MigrationRegistry, LABEL, LOCK_PREFIX, RETAIN_VERIFIED, okR, errR, verifyEnvelope, headerOf, planPromote, sweepable, recordProblem,
  compatibility, buildExport, parseImport, simDayTime, defaultMigrations,
} from './save-format.ts';

export const DB_NAME = 'antempire-experiment-worlds';
const DB_VERSION = 1;
const W = 'worlds', S = 'snapshots';

// ---------- IndexedDB plumbing ----------

const req = <T>(r: IDBRequest<T>) => new Promise<T>((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
/** Resolves on the transaction's `complete` event; rejects on abort or error. */
const done = (tx: IDBTransaction) => new Promise<void>((res, rej) => {
  tx.oncomplete = () => res();
  tx.onabort = () => rej(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
  tx.onerror = () => { /* abort follows */ };
});
function classify(err: unknown): { code: 'quota_exceeded' | 'aborted' | 'write_failed'; message: string } {
  const name = (err as { name?: string })?.name ?? '', message = (err as { message?: string })?.message ?? String(err);
  if (name === 'QuotaExceededError' || /quota/i.test(message)) return { code: 'quota_exceeded', message };
  // An operation on a transaction that ended under us (explicit abort, page teardown) is an abort, not a write error.
  if (name === 'AbortError' || name === 'TransactionInactiveError') return { code: 'aborted', message };
  return { code: 'write_failed', message };
}
const range = (world_id: string) => IDBKeyRange.bound([world_id, -Infinity], [world_id, Infinity]);
const nowIso = () => new Date().toISOString();

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open('antempire-experiment-worlds', DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(W)) db.createObjectStore(W, { keyPath: 'world_id' });
      if (!db.objectStoreNames.contains(S)) db.createObjectStore(S, { keyPath: ['world_id', 'gen'] });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.onblocked = () => rej(new DOMException('database upgrade blocked by another tab', 'AbortError'));
  });
}

// ---------- single writer per world (Web Locks) ----------

/** Held while this tab is the only writer of a world. `held` turns false if another tab steals the lock. */
export class WriterLock {
  held = true; exclusive: boolean; head: number | null = null;
  readonly world_id: string; private readonly releaseFn: () => void;
  constructor(world_id: string, exclusive: boolean, release: () => void) { this.world_id = world_id; this.exclusive = exclusive; this.releaseFn = release; }
  release() { this.held = false; this.releaseFn(); }
}
export type LockOutcome = { mode: 'writer'; lock: WriterLock } | { mode: 'read_only'; reason: string };

/**
 * Become the single writer of `world_id`. Without `steal`, a second tab gets read_only. With `steal`, the current
 * holder loses the lock (its onLost runs, its later saves are refused) and this tab becomes the writer.
 * Browsers without Web Locks get a non-exclusive writer guarded only by the promote-time pointer check.
 */
export function acquireWriterLock(world_id: string, opts: { steal?: boolean; onLost?: () => void } = {}): Promise<LockOutcome> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return Promise.resolve({ mode: 'writer', lock: new WriterLock(world_id, false, () => {}) });
  return new Promise<LockOutcome>((resolve) => {
    let lockObj: WriterLock | null = null;
    const options: LockOptions = opts.steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true };
    locks.request(LOCK_PREFIX + world_id, options, async (l) => {
      if (!l) { resolve({ mode: 'read_only', reason: 'another tab is writing this world' }); return; }
      let release!: () => void; const hold = new Promise<void>((r) => { release = r; });
      lockObj = new WriterLock(world_id, true, release); resolve({ mode: 'writer', lock: lockObj });
      await hold;
    }).catch(() => { if (lockObj) { lockObj.held = false; opts.onLost?.(); } else resolve({ mode: 'read_only', reason: 'lock request failed' }); });
  });
}

// ---------- results ----------

export interface SaveReceipt { world_id: string; gen: number; seq: number; t_sim: number; saved_at: string; bytes: number; ms: { hash: number; write: number; verify: number; promote: number } }
export interface LoadResult { envelope: SnapshotEnvelope; gen: number; recovered: boolean; skipped: { gen: number; reason: string }[]; migrated_from: number | null; notice: string | null }
export interface WorldListing {
  world_id: string; name: string; seed: number; t_sim: number | null; sim_day: number | null; sim_clock: string | null;
  last_saved_at: string | null; queens: number | null; workers: number | null; compat: Compatibility | 'no_snapshot';
  verified_snapshots: number; quarantined: number; official: false; label: typeof LABEL;
}
export interface DeleteToken { world_id: string; nonce: string }

const ms = () => performance.now();

export class ExperimentSaveStore {
  private readonly db: IDBDatabase; private readonly migrations: MigrationRegistry;
  private readonly deleteTokens = new Map<string, string>();
  private constructor(db: IDBDatabase, migrations: MigrationRegistry) { this.db = db; this.migrations = migrations; }

  static async open(migrations: MigrationRegistry = defaultMigrations()): Promise<Result<ExperimentSaveStore>> {
    if (typeof indexedDB === 'undefined') return errR('unsupported', 'IndexedDB is not available (private mode or blocked storage)');
    try { return okR(new ExperimentSaveStore(await openDb(), migrations)); } catch (err) { const c = classify(err); return errR(c.code === 'quota_exceeded' ? c.code : 'unsupported', c.message); }
  }
  close() { this.db.close(); }

  /** Ask the browser not to evict the data. The browser may refuse; persistence is never guaranteed. */
  static async requestPersistence(): Promise<{ supported: boolean; persisted: boolean | null; usage: number | null; quota: number | null }> {
    const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!st?.persist) return { supported: false, persisted: null, usage: null, quota: null };
    let persisted: boolean | null = null, usage: number | null = null, quota: number | null = null;
    try { persisted = (await st.persisted()) || (await st.persist()); } catch { persisted = null; }
    try { const e = await st.estimate(); usage = e.usage ?? null; quota = e.quota ?? null; } catch { /* estimate unavailable */ }
    return { supported: true, persisted, usage, quota };
  }

  async getWorld(world_id: string): Promise<WorldRecord | undefined> {
    return req(this.db.transaction(W, 'readonly').objectStore(W).get(world_id) as IDBRequest<WorldRecord | undefined>);
  }

  async listWorlds(rt: RuntimeInfo): Promise<WorldListing[]> {
    const all = await req(this.db.transaction(W, 'readonly').objectStore(W).getAll() as IDBRequest<WorldRecord[]>);
    return all.map((w): WorldListing => {
      const dt = simDayTime(w.t_sim);
      return {
        world_id: w.world_id, name: w.name, seed: w.seed, t_sim: w.t_sim, sim_day: dt?.day ?? null, sim_clock: dt?.clock ?? null,
        last_saved_at: w.last_saved_at, queens: w.summary?.queens ?? null, workers: w.summary?.workers ?? null,
        compat: w.slots.length ? compatibility({ schema: 'antempire.experiment-world-snapshot.v1', rules_fingerprint: w.rules_fingerprint, schema_version: w.schema_version }, rt, this.migrations) : 'no_snapshot',
        verified_snapshots: w.slots.length, quarantined: w.quarantined.length, official: false, label: LABEL,
      };
    }).sort((a, b) => (b.last_saved_at ?? '').localeCompare(a.last_saved_at ?? '') || a.world_id.localeCompare(b.world_id));
  }

  /** "繼續遊戲": the world saved most recently (null when there is none). */
  async lastPlayed(): Promise<string | null> {
    const all = await req(this.db.transaction(W, 'readonly').objectStore(W).getAll() as IDBRequest<WorldRecord[]>);
    const withSave = all.filter((w) => w.slots.length && w.last_saved_at).sort((a, b) => b.last_saved_at!.localeCompare(a.last_saved_at!));
    return withSave[0]?.world_id ?? null;
  }

  /** New game: a new world_id that must not exist; the initial snapshot is written immediately. Never overwrites. */
  async createWorld(lock: WriterLock, name: string, initial: unknown, summary: WorldSummary = {}): Promise<Result<SaveReceipt>> {
    const v = await verifyEnvelope(initial);
    if (!v.ok) return v;
    const env = v.value.envelope;
    if (!lock.held || lock.world_id !== env.world_id) return errR('not_writer', 'this tab does not hold the writer lock for the new world');
    const rec: WorldRecord = {
      world_id: env.world_id, name: name.slice(0, 200), seed: env.seed, created_at: nowIso(), official: false, label: LABEL, next_gen: 1, slots: [], quarantined: [],
      last_saved_at: null, t_sim: null, seq: null, rules_fingerprint: env.rules_fingerprint, engine_version: env.engine_version, schema_version: env.schema_version, summary: { ...summary },
    };
    try { const tx = this.db.transaction(W, 'readwrite'); tx.objectStore(W).add(rec); await done(tx); } catch (err) {
      if ((err as { name?: string })?.name === 'ConstraintError') return errR('world_exists', `world ${env.world_id} already exists`);
      const c = classify(err); return errR(c.code, c.message);
    }
    lock.head = null;
    return this.commit(lock, env, v.value.payload_json, summary);
  }

  /** Autosave / manual save of the current world. Only the lock holder may write. */
  async saveSnapshot(lock: WriterLock, snapshot: unknown, summary?: WorldSummary): Promise<Result<SaveReceipt>> {
    const t0 = ms(); const v = await verifyEnvelope(snapshot);
    if (!v.ok) return v;
    if (!lock.held || lock.world_id !== v.value.envelope.world_id) return errR('not_writer', 'this tab is not the writer of this world (read-only or lock lost)');
    return this.commit(lock, v.value.envelope, v.value.payload_json, summary, ms() - t0);
  }

  private async commit(lock: WriterLock, env: SnapshotEnvelope, payload_json: string, summary?: WorldSummary, hashMs = 0): Promise<Result<SaveReceipt>> {
    const header = headerOf(env); let gen = 0; const t1 = ms(); let tx: IDBTransaction | undefined;
    const abandon = () => { try { tx?.abort(); } catch { /* already finished */ } };
    // 1. write pending (allocate a generation; the latest pointer is untouched)
    try {
      tx = this.db.transaction([W, S], 'readwrite'); const ws = tx.objectStore(W);
      const w = await req(ws.get(env.world_id) as IDBRequest<WorldRecord | undefined>);
      if (!w) { tx.abort(); return errR('unknown_world', `world ${env.world_id} does not exist`); }
      if (w.seed !== env.seed || w.rules_fingerprint !== env.rules_fingerprint) { tx.abort(); return errR('rules_mismatch', 'snapshot seed or rules differ from this world; a world never changes rules'); }
      gen = w.next_gen; ws.put({ ...w, next_gen: gen + 1 });
      const rec: SnapshotRecord = { world_id: env.world_id, gen, status: 'pending', written_at: nowIso(), header, payload_json, payload_sha256: env.payload_sha256 };
      tx.objectStore(S).put(rec);
      await done(tx);
    } catch (err) { abandon(); const c = classify(err); return errR(c.code, `write: ${c.message}`); }
    const t2 = ms();
    // 2. verify by re-reading in a separate transaction
    try {
      const rec = await req(this.db.transaction(S, 'readonly').objectStore(S).get([env.world_id, gen]) as IDBRequest<SnapshotRecord | undefined>);
      const problem = await recordProblem(rec, env.world_id, gen);
      if (problem) return errR('verify_failed', `re-read of generation ${gen}: ${problem}`);
      if (rec!.payload_json !== payload_json) return errR('verify_failed', `re-read of generation ${gen}: stored payload differs from what was written`);
    } catch (err) { const c = classify(err); return errR(c.code, `verify: ${c.message}`); }
    const t3 = ms(); let saved_at = '';
    // 3. promote: optimistic pointer check, move pointer, mark verified, sweep
    try {
      if (!lock.held) return errR('not_writer', 'writer lock lost before promote; the previous snapshot stays the latest');
      tx = this.db.transaction([W, S], 'readwrite'); const ws = tx.objectStore(W), ss = tx.objectStore(S);
      const w = await req(ws.get(env.world_id) as IDBRequest<WorldRecord | undefined>);
      if (!w) { tx.abort(); return errR('unknown_world', 'world deleted during save'); }
      const head = w.slots[0] ?? null;
      if (head !== lock.head) { tx.abort(); return errR('conflict', `latest snapshot changed under this writer (expected ${lock.head}, found ${head})`); }
      const q = w.quarantined.map((x) => x.gen), { slots } = planPromote(w.slots, q, gen, RETAIN_VERIFIED);
      saved_at = nowIso();
      ws.put({ ...w, slots, last_saved_at: saved_at, t_sim: env.t_sim, seq: env.seq, engine_version: env.engine_version, schema_version: env.schema_version, summary: summary ? { ...summary } : w.summary });
      const rec = await req(ss.get([env.world_id, gen]) as IDBRequest<SnapshotRecord>);
      ss.put({ ...rec, status: 'verified' });
      const keys = await req(ss.getAllKeys(range(env.world_id))) as [string, number][];
      for (const g of sweepable(keys.map((k) => k[1]), slots, q, gen)) ss.delete([env.world_id, g]);
      await done(tx);
    } catch (err) { abandon(); const c = classify(err); return errR(c.code, `promote: ${c.message}`); }
    lock.head = gen;
    const t4 = ms();
    return okR({ world_id: env.world_id, gen, seq: env.seq, t_sim: env.t_sim, saved_at, bytes: payload_json.length, ms: { hash: hashMs, write: t2 - t1, verify: t3 - t2, promote: t4 - t3 } });
  }

  /**
   * Load the newest usable snapshot. Corrupted ones are skipped and reported (recovered: true); with a writer lock they
   * are also quarantined. Version problems (newer schema, different rules, unknown schema) stop the load instead of
   * silently falling back. Migrations run on a copy; the stored snapshot is unchanged.
   */
  async loadLatest(world_id: string, rt: RuntimeInfo, lock?: WriterLock): Promise<Result<LoadResult>> {
    const w = await this.getWorld(world_id);
    if (!w) return errR('unknown_world', `world ${world_id} does not exist`);
    const skipped: { gen: number; reason: string }[] = [];
    for (const gen of w.slots) {
      const rec = await req(this.db.transaction(S, 'readonly').objectStore(S).get([world_id, gen]) as IDBRequest<SnapshotRecord | undefined>);
      const problem = await recordProblem(rec, world_id, gen);
      if (problem) { skipped.push({ gen, reason: problem }); continue; }
      const env = { ...rec!.header, payload: JSON.parse(rec!.payload_json) } as SnapshotEnvelope;
      const compat = compatibility(env, rt, this.migrations);
      if (compat === 'unknown_schema' || compat === 'newer_schema' || compat === 'rules_mismatch') return errR(compat, `generation ${gen}: ${compat}; the save is kept unchanged`);
      if (compat === 'no_migration_path') return errR('migration_failed', `generation ${gen}: no migration from schema v${env.schema_version}`);
      let out = env, migrated_from: number | null = null;
      if (compat === 'migratable') {
        const m = await this.migrations.migrate(env);
        if (!m.ok) return m;
        out = m.value.envelope; migrated_from = m.value.from;
      }
      if (skipped.length && lock?.held && lock.world_id === world_id) await this.quarantine(world_id, skipped);
      if (lock?.held && lock.world_id === world_id) lock.head = (await this.getWorld(world_id))?.slots[0] ?? null;
      const notice = skipped.length ? `最新存檔損壞，已回復到上一個已驗證的存檔（第 ${gen} 代；略過：${skipped.map((s) => `第 ${s.gen} 代 ${s.reason}`).join('、')}）` : null;
      return okR({ envelope: out, gen, recovered: skipped.length > 0, skipped, migrated_from, notice });
    }
    return errR('no_valid_snapshot', w.slots.length ? `no verified snapshot passed the checks (${skipped.map((s) => `${s.gen}: ${s.reason}`).join('; ')})` : 'this world has no verified snapshot');
  }

  private async quarantine(world_id: string, bad: { gen: number; reason: string }[]) {
    const tx = this.db.transaction(W, 'readwrite'), ws = tx.objectStore(W);
    const w = await req(ws.get(world_id) as IDBRequest<WorldRecord>);
    const gens = bad.map((b) => b.gen);
    ws.put({ ...w, slots: w.slots.filter((g) => !gens.includes(g)), quarantined: [...w.quarantined, ...bad.filter((b) => !w.quarantined.some((q) => q.gen === b.gen))] });
    await done(tx);
  }

  async renameWorld(lock: WriterLock, name: string): Promise<Result<true>> {
    if (!lock.held) return errR('not_writer', 'read-only tab');
    try {
      const tx = this.db.transaction(W, 'readwrite'), ws = tx.objectStore(W);
      const w = await req(ws.get(lock.world_id) as IDBRequest<WorldRecord | undefined>);
      if (!w) { tx.abort(); return errR('unknown_world', lock.world_id); }
      ws.put({ ...w, name: name.slice(0, 200) }); await done(tx); return okR(true);
    } catch (err) { const c = classify(err); return errR(c.code, c.message); }
  }

  /** Step 1 of deletion: a one-time token the page shows as an in-page confirmation (never window.confirm). */
  prepareDelete(world_id: string): DeleteToken { const nonce = crypto.randomUUID(); this.deleteTokens.set(world_id, nonce); return { world_id, nonce }; }
  /** Step 2: delete the world and all its snapshots in one transaction; needs the token and the writer lock. */
  async deleteWorld(lock: WriterLock, token: DeleteToken): Promise<Result<true>> {
    if (this.deleteTokens.get(token.world_id) !== token.nonce || token.world_id !== lock.world_id) return errR('confirmation_required', 'deletion needs the two-step confirmation');
    if (!lock.held) return errR('not_writer', 'another tab is writing this world');
    this.deleteTokens.delete(token.world_id);
    try {
      const tx = this.db.transaction([W, S], 'readwrite'); tx.objectStore(W).delete(lock.world_id); tx.objectStore(S).delete(range(lock.world_id));
      await done(tx); return okR(true);
    } catch (err) { const c = classify(err); return errR(c.code, c.message); }
  }

  /** Export the latest verified snapshot (no migration) as JSON text for a Blob download made by the page. */
  async exportWorld(world_id: string): Promise<Result<{ text: string; filename: string }>> {
    const w = await this.getWorld(world_id);
    if (!w) return errR('unknown_world', world_id);
    for (const gen of w.slots) {
      const rec = await req(this.db.transaction(S, 'readonly').objectStore(S).get([world_id, gen]) as IDBRequest<SnapshotRecord | undefined>);
      if (await recordProblem(rec, world_id, gen)) continue;
      const env = { ...rec!.header, payload: JSON.parse(rec!.payload_json) } as SnapshotEnvelope;
      const f = await buildExport(w, env, nowIso());
      return okR({ text: JSON.stringify(f), filename: `antempire-experiment-${world_id}-gen${gen}.json` });
    }
    return errR('no_valid_snapshot', 'nothing verified to export');
  }

  /** Import an exported world as a new local world. Refuses an existing world_id; never produces an official save. */
  async importWorld(text: string, rt: RuntimeInfo): Promise<Result<{ receipt: SaveReceipt; compat: Compatibility }>> {
    const p = await parseImport(text, rt, this.migrations);
    if (!p.ok) return p;
    const { file, compat } = p.value;
    if (await this.getWorld(file.world.world_id)) return errR('world_exists', `world ${file.world.world_id} already exists; delete it first or keep both by not importing`);
    const got = await acquireWriterLock(file.world.world_id);
    if (got.mode !== 'writer') return errR('not_writer', got.reason);
    try {
      const r = await this.createWorld(got.lock, file.world.name, file.snapshot, file.world.summary ?? {});
      return r.ok ? okR({ receipt: r.value, compat }) : r;
    } finally { got.lock.release(); }
  }
}
