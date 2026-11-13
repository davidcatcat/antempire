/**
 * SAVE-2: one experiment-world session = the Worker client + the save store + the autosave controller.
 * The simulation runs only in the Worker; the store only persists snapshots the Worker produced. This module never
 * interprets the world beyond counting individuals for the save list, never changes the world, and never runs it.
 *  - snapshots are taken ONLY with the Worker's `snapshot` command, which the Worker answers between commands, i.e. at
 *    a consistent event boundary; taking one is a pure read (no random draw, no time step: tests/worker-runtime).
 *  - "已儲存" is reported only after the store's promote transaction completed (save-store.ts).
 *  - one writer per world (Web Locks); a second tab is read-only unless it takes over ("切換到此分頁").
 */
import { ExperimentWorkerClient } from './worker-client.ts';
import { ExperimentSaveStore, acquireWriterLock, type LoadResult, type SaveReceipt, type WorldListing, type WriterLock } from './save-store.ts';
import { AutosaveController, errR, newWorldId, okR, seedFromInput, summaryOf, verificationOf, type Result, type RuntimeInfo, type SaveReason, type SaveUiState } from './save-format.ts';

/** verification: what this viewer may claim (Owner ruling #200): '本機可玩' or '完整性檢查通過', always with '未經 Node 驗證'. */
export interface SessionState { world_id: string; name: string; seed: number; writer: boolean; readOnlyReason: string | null; recoveredNotice: string | null; sim_world_id: string; verification: string }

export class ExperimentSession {
  readonly client: ExperimentWorkerClient;
  readonly store: ExperimentSaveStore;
  private rtInfo: RuntimeInfo | null = null;
  current: SessionState | null = null;
  private lock: WriterLock | null = null;
  autosave: AutosaveController | null = null;
  lastReceipt: SaveReceipt | null = null;
  /** what the last open() restored (tests and the page: the world resumes exactly here) */
  lastLoad: { world_id: string; gen: number; t_sim: number; seq: number; recovered: boolean } | null = null;
  private timer: number | null = null;
  onSaveState: (s: SaveUiState, receipt: SaveReceipt | null) => void = () => {};
  onLockLost: () => void = () => {};
  /** a new or restored world is about to replace the Worker's world (the page resets its event view) */
  onWorldStart: () => void = () => {};
  /** a snapshot was restored: the next event will carry seq = `seq` */
  onRestored: (seq: number) => void = () => {};

  constructor(client: ExperimentWorkerClient, store: ExperimentSaveStore) { this.client = client; this.store = store; }

  /** What this Worker build expects of a snapshot. Read from a throw-away world the Worker creates and that is never
   *  saved or shown (the protocol has no separate info command). */
  async runtimeInfo(): Promise<RuntimeInfo> {
    if (this.rtInfo) return this.rtInfo;
    await this.client.init('exp-runtime-probe', 0);
    const r = await this.client.snapshot();
    const s = (r as { snapshot?: { rules_fingerprint: string; engine_version: string; schema_version: number } }).snapshot;
    if (!s) throw new Error('the Worker did not return a snapshot');
    this.rtInfo = { rules_fingerprint: s.rules_fingerprint, engine_version: s.engine_version, schema_version: s.schema_version };
    return this.rtInfo;
  }
  list(): Promise<WorldListing[]> { return this.runtimeInfo().then((rt) => this.store.listWorlds(rt)); }

  /** New game: new exp- world id, the player's or a fresh seed, experiment Day0 of the synthetic world, initial
   *  snapshot written immediately. Never overwrites (a duplicate id is refused by the store). */
  async newGame(name: string, seedInput: string): Promise<Result<{ seed: number; how: string; receipt: SaveReceipt }>> {
    const sd = await seedFromInput(seedInput);
    if (!sd) return errR('invalid_snapshot', '種子必須是 0～4294967295 的整數，或任意文字（會轉成整數）');
    await this.leave(false);
    await this.runtimeInfo();
    const id = newWorldId(), got = await acquireWriterLock(id, { onLost: () => this.lockLost() });
    if (got.mode !== 'writer') return errR('not_writer', got.reason);
    this.onWorldStart();
    const ini = await this.client.init(id, sd.seed);
    if (ini.type === 'error') { got.lock.release(); return errR('invalid_snapshot', `${ini.code}: ${ini.message}`); }
    const snap = await this.client.snapshot();
    if (snap.type !== 'snapshot') { got.lock.release(); return errR('invalid_snapshot', 'no snapshot'); }
    const r = await this.store.createWorld(got.lock, name.trim() || `實驗世界 ${new Date().toLocaleString('zh-TW')}`, snap.snapshot, summaryOf(snap.snapshot));
    if (!r.ok) { got.lock.release(); return r; }
    this.attach({ world_id: id, name, seed: sd.seed, writer: true, readOnlyReason: null, recoveredNotice: null, sim_world_id: id, verification: verificationOf({ loadable: true, integrity_checked: false }).text }, got.lock);
    this.lastReceipt = r.value; this.autosave!.state = { ...this.autosave!.state, status: 'saved', text: '已儲存', last_success_ms: Date.now(), reason: 'new_game' };
    this.onSaveState(this.autosave!.state, r.value);
    return okR({ seed: sd.seed, how: sd.how, receipt: r.value });
  }

  /** Open a saved world (latest recovery point, or one manual save). A second tab gets read-only unless `steal`. */
  async open(world_id: string, opts: { steal?: boolean; readOnly?: boolean; gen?: number } = {}): Promise<Result<LoadResult & { readOnly: string | null }>> {
    await this.leave(false);
    const rt = await this.runtimeInfo();
    let lock: WriterLock | null = null, readOnly: string | null = null;
    if (!opts.readOnly) {
      const got = await acquireWriterLock(world_id, { steal: opts.steal, onLost: () => this.lockLost() });
      if (got.mode === 'writer') lock = got.lock; else return errR('not_writer', got.reason);
    } else readOnly = '唯讀開啟：本分頁不會存檔';
    const ld = await this.store.loadLatest(world_id, rt, lock ?? undefined, opts.gen);
    if (!ld.ok) { lock?.release(); return ld; }
    this.onWorldStart();
    const r = await this.client.restore(ld.value.envelope);
    if (r.type === 'error') { lock?.release(); return errR('invalid_snapshot', `Worker 拒絕此快照（${r.code}）：${r.message}；存檔未被修改`); }
    this.onRestored(ld.value.envelope.seq);
    this.lastLoad = { world_id, gen: ld.value.gen, t_sim: ld.value.envelope.t_sim, seq: ld.value.envelope.seq, recovered: ld.value.recovered };
    const w = await this.store.getWorld(world_id);
    this.attach({ world_id, name: w?.name ?? world_id, seed: ld.value.envelope.seed, writer: !!lock, readOnlyReason: readOnly, recoveredNotice: ld.value.notice, sim_world_id: ld.value.envelope.world_id,
      // the store re-read and re-hashed the snapshot and the Worker's restore checked its structure and chain fields
      verification: verificationOf({ loadable: true, integrity_checked: true }).text }, lock);
    return okR({ ...ld.value, readOnly });
  }

  private attach(s: SessionState, lock: WriterLock | null) {
    this.current = s; this.lock = lock; this.lastReceipt = null;
    this.autosave = new AutosaveController({ now: () => Date.now(), save: (reason) => this.saveNow(reason), onState: (st) => this.onSaveState(st, this.lastReceipt) });
    if (this.timer === null) this.timer = setInterval(() => { void this.autosave?.tick(); }, 1000) as unknown as number;
  }
  private lockLost() {
    if (this.current) { this.current = { ...this.current, writer: false, readOnlyReason: '另一個分頁接手了這個世界；本分頁已轉為唯讀（不再存檔）' }; this.lock = null; }
    this.onLockLost();
  }
  /** the Worker committed events since the last save */
  markDirty() { this.autosave?.markDirty(); }
  /** Save one snapshot taken at the Worker's event boundary. Read-only tabs never write. */
  private async saveNow(reason: SaveReason): Promise<Result<unknown>> {
    // capture the lock before any await: leave() may clear this.lock while the snapshot is being taken
    const lock = this.lock;
    if (!this.current || !lock || !this.current.writer) return errR('not_writer', this.current?.readOnlyReason ?? '沒有開啟的世界');
    const snap = await this.client.snapshot();
    if (snap.type !== 'snapshot') return errR('invalid_snapshot', snap.type === 'error' ? `${snap.code}: ${snap.message}` : 'no snapshot');
    const r = await this.store.saveSnapshot(lock, snap.snapshot, summaryOf(snap.snapshot), reason === 'manual' ? 'manual' : 'auto');
    if (r.ok) this.lastReceipt = r.value;
    return r;
  }
  request(reason: SaveReason) { return this.autosave?.request(reason) ?? null; }

  /** Leave the world: pause, save before returning to the menu (writer only), release the lock. */
  async leave(save = true): Promise<Result<unknown> | null> {
    if (!this.current) return null;
    let r: Result<unknown> | null = null;
    const p = await this.client.pause(); void p; // NOT_RUNNING is fine
    if (save && this.current.writer) r = await (this.autosave?.request('menu') ?? Promise.resolve(null));
    // never release the writer lock while a save (in flight or queued) can still write with it
    await this.autosave?.settled();
    this.lock?.release(); this.lock = null; this.current = null; this.autosave = null;
    return r;
  }
  async rename(world_id: string, name: string): Promise<Result<true>> {
    const own = this.current?.world_id === world_id && this.lock ? this.lock : null;
    const got = own ? { mode: 'writer' as const, lock: own } : await acquireWriterLock(world_id);
    if (got.mode !== 'writer') return errR('not_writer', got.reason);
    try { const r = await this.store.renameWorld(got.lock, name); if (r.ok && this.current?.world_id === world_id) this.current = { ...this.current, name }; return r; } finally { if (!own) got.lock.release(); }
  }
  /** Delete step 2 (step 1 = store.prepareDelete, shown as an in-page confirmation). The open world cannot be deleted. */
  async remove(token: { world_id: string; nonce: string }): Promise<Result<true>> {
    if (this.current?.world_id === token.world_id) return errR('not_writer', '請先回到選單再刪除目前開啟的世界');
    const got = await acquireWriterLock(token.world_id);
    if (got.mode !== 'writer') return errR('not_writer', '另一個分頁正在使用這個世界');
    try { return await this.store.deleteWorld(got.lock, token); } finally { got.lock.release(); }
  }
}
