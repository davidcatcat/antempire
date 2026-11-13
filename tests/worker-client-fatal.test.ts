/**
 * Issue #224 regression: the experiment Worker client must end every pending command when the Worker fails or is
 * terminated, and the SAVE-2 session must surface that failure (and run its cleanup) instead of waiting forever.
 * Non-official experiment worlds only; nothing here touches saves/ or journal/.
 *
 * The REAL client (web/src/experimental/worker-client.ts) and the REAL session (web/src/experimental/session.ts) run
 * against a fake global `Worker` (fault injection; not a browser) whose normal path is backed by the REAL Worker
 * Runtime through an asynchronous, structured-cloned message queue, like postMessage.
 *  1. onerror with a pending command → the command rejects with WorkerClientError code WORKER_FATAL, the waiting table
 *     is empty, the Worker is terminated, later sends reject at once, late replies are ignored.
 *  2. onmessageerror → the same (WORKER_FATAL).
 *  3. terminate() with pending commands → all reject with WORKER_TERMINATED; later sends reject at once, nothing posted.
 *  4. normal path: the event stream, acks and snapshot through the client equal the Runtime's own replies (the fix does
 *     not change event sequences or replay).
 *  5. session: newGame / open / save / leave end with code 'worker_failed' (never a fabricated success), release the
 *     writer lock, write nothing to the store, and a Worker that dies after a successful new game leaves the stored
 *     world untouched (still exportable from the store, which needs no Worker).
 */
import assert from 'node:assert/strict';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
/** 'pending' when the promise has not settled within `ms` (the bug: it never settles) */
const settle = <T>(p: Promise<T>, ms = 3000): Promise<{ s: 'resolved'; v: T } | { s: 'rejected'; e: unknown } | { s: 'pending' }> =>
  Promise.race([p.then((v) => ({ s: 'resolved' as const, v }), (e: unknown) => ({ s: 'rejected' as const, e })), new Promise<{ s: 'pending' }>((r) => setTimeout(() => r({ s: 'pending' }), ms))]);
const tick = () => new Promise((r) => setTimeout(r, 0));

type Msg = Record<string, unknown>;
class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: ((e: { data: unknown }) => void) | null = null;
  posted: Msg[] = []; terminated = 0;
  /** behaviour: 'runtime' answers with the real Runtime; 'silent' never answers; failAt = the n-th message (1-based) fires onerror instead */
  mode: 'runtime' | 'silent' = 'runtime'; failAt: number | null = null; failWith: 'error' | 'messageerror' = 'error';
  readonly rt = new Runtime(() => 0);
  constructor(_url: unknown, _opts: unknown) { FakeWorker.all.push(this); }
  postMessage(m: Msg) {
    const c = structuredClone(m); this.posted.push(c);
    if (this.terminated) return;
    if (this.failAt !== null && this.posted.length >= this.failAt) { setTimeout(() => this.fail('injected failure'), 0); return; }
    if (this.mode === 'silent') return;
    setTimeout(() => { if (this.terminated) return; for (const r of this.rt.handle(c)) this.onmessage?.({ data: structuredClone(r) }); }, 0);
  }
  fail(message: string) { if (this.failWith === 'error') this.onerror?.({ message }); else this.onmessageerror?.({ data: null }); }
  terminate() { this.terminated++; }
}
(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;

// fake Web Locks (navigator.locks): held names are visible, so the tests can see the session release its writer lock
const held = new Set<string>();
const fakeLocks = {
  request(name: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (l: { name: string } | null) => Promise<void> | void): Promise<void> {
    if (held.has(name) && opts.ifAvailable) return Promise.resolve(cb(null));
    held.add(name);
    return Promise.resolve(cb({ name })).finally(() => held.delete(name));
  },
};
Object.defineProperty(globalThis.navigator, 'locks', { value: fakeLocks, configurable: true });

// web/src modules are DOM code checked by web/tsconfig.json: loaded through computed specifiers (as tests/save2-session)
interface Final { type: string; req: number | null; code?: string; message?: string; snapshot?: Record<string, unknown> }
interface ClientApi {
  onEvents: (ev: unknown[]) => void; onProtocolError: (why: string) => void;
  send(b: Msg): Promise<Final>; init(id: string, seed: number, kind?: string): Promise<Final>; snapshot(): Promise<Final>; stepUntil(t: number): Promise<Final>;
  restore(s: unknown): Promise<Final>; pause(): Promise<Final>; terminate(): void; readonly failure: { code: string; message: string } | null;
}
const clientModule = '../web/src/experimental/worker-client.ts', sessionModule = '../web/src/experimental/session.ts';
const CM = await import(clientModule) as { ExperimentWorkerClient: new () => ClientApi; WorkerClientError?: new (...a: never[]) => Error; isWorkerClientError?: (e: unknown) => boolean };
const { ExperimentWorkerClient } = CM;
const mk = () => { const c = new ExperimentWorkerClient(); const w = FakeWorker.all[FakeWorker.all.length - 1]; return { c, w }; };
const code = (r: { s: string; e?: unknown }) => r.s === 'rejected' ? (r.e as { code?: string }).code : undefined;
const pending = (c: ClientApi) => (c as unknown as { waiting: Map<number, unknown> }).waiting.size;

// 1. onerror (e.g. the module failed to load) while init is pending: issue #224's minimal repro
{
  const { c, w } = mk(); w.mode = 'silent';
  const errors: string[] = []; c.onProtocolError = (e) => errors.push(e);
  const p = c.init('exp-fatal', 7, 'p0a2'), q = c.snapshot();
  w.onerror!({ message: 'injected module load failure' });
  const [r, r2] = [await settle(p, 200), await settle(q, 200)];
  ok(r.s === 'rejected' && r2.s === 'rejected', `onerror: every pending command is rejected (init ${r.s}, snapshot ${r2.s})`);
  ok(code(r) === 'WORKER_FATAL' && code(r2) === 'WORKER_FATAL', `onerror: rejected with code WORKER_FATAL (${code(r)})`);
  ok(r.s === 'rejected' && (r.e as Error).name === 'WorkerClientError' && /injected module load failure/.test((r.e as Error).message), 'onerror: the error is a WorkerClientError carrying the cause');
  ok(pending(c) === 0, 'onerror: the waiting table is cleared');
  ok(errors.length === 1 && /injected module load failure/.test(errors[0]), 'onerror: onProtocolError is still notified once');
  ok(w.terminated >= 1, 'onerror: the failed Worker is terminated (no late world can keep running)');
  ok(c.failure?.code === 'WORKER_FATAL', 'onerror: the client reports its failed state');
  const before = w.posted.length, later = await settle(c.pause(), 200);
  ok(later.s === 'rejected' && code(later) === 'WORKER_FATAL' && w.posted.length === before, 'send after a fatal error rejects at once and posts nothing');
  // a reply that arrives after the failure is ignored: no fabricated ACK, no events handed to the page
  let evs = 0; c.onEvents = () => { evs++; };
  w.onmessage?.({ data: { protocol: 1, label: '非正式實驗世界／不屬於正式遊戲歷史', official: false, type: 'ack', req: 1, of: 'init' } });
  ok(evs === 0 && pending(c) === 0, 'late replies after a fatal error are ignored');
  w.onerror!({ message: 'second error' });
  ok(errors.length === 1, 'a second error after the failure is not reported again');
}

// 2. onmessageerror (a reply could not be deserialised: its command can never be answered)
{
  const { c, w } = mk(); w.mode = 'silent';
  const p = c.init('exp-msgerr', 1, 'synthetic');
  ok(typeof w.onmessageerror === 'function', 'messageerror: the client listens for it');
  w.onmessageerror?.({ data: null });
  const r = await settle(p, 200);
  ok(r.s === 'rejected' && code(r) === 'WORKER_FATAL' && pending(c) === 0, `messageerror: the pending command rejects with WORKER_FATAL (${r.s})`);
  ok((await settle(c.snapshot(), 200)).s === 'rejected', 'messageerror: later sends reject');
}

// 3. terminate() with pending commands
{
  const { c, w } = mk(); w.mode = 'silent';
  const ps = [c.init('exp-term', 2, 'synthetic'), c.stepUntil(10), c.snapshot()];
  c.terminate();
  const rs = await Promise.all(ps.map((p) => settle(p, 200)));
  ok(rs.every((r) => r.s === 'rejected' && code(r) === 'WORKER_TERMINATED'), `terminate: all pending commands reject with WORKER_TERMINATED (${rs.map((r) => r.s).join(',')})`);
  ok(pending(c) === 0 && w.terminated === 1, 'terminate: the waiting table is cleared and the Worker terminated once');
  const n = w.posted.length, later = await settle(c.pause(), 200);
  ok(later.s === 'rejected' && code(later) === 'WORKER_TERMINATED' && w.posted.length === n, 'send after terminate rejects at once and posts nothing');
  c.terminate();
  ok(w.terminated === 1, 'a second terminate is a no-op');
}

// 4. normal path: the client hands over exactly the Runtime's replies (events, acks, snapshot), in order
{
  const script: Msg[] = [{ type: 'init', world_id: 'exp-normal', seed: 4242, kind: 'synthetic' }, { type: 'step_until', t_sim: 6 * 3600 }, { type: 'snapshot' }, { type: 'step_until', t_sim: 12 * 3600 }, { type: 'snapshot' }];
  const ref = new Runtime(() => 0), refEvents: string[] = [], refFinal: string[] = [];
  script.forEach((m, i) => { for (const r of ref.handle({ ...m, req: i + 1 })) { if (r.type === 'events') refEvents.push(...r.events.map((e) => JSON.stringify(e))); else if (r.type !== 'state') refFinal.push(JSON.stringify(r)); } });
  const { c } = mk(); const got: string[] = []; c.onEvents = (ev) => got.push(...ev.map((e) => JSON.stringify(e)));
  const finals: string[] = [];
  for (const m of script) finals.push(JSON.stringify(await c.send(m)));
  ok(refEvents.length > 0 && got.length === refEvents.length && got.every((x, i) => x === refEvents[i]), `normal path: event sequence identical to the Runtime (${got.length} events)`);
  ok(finals.length === refFinal.length && finals.every((x, i) => x === refFinal[i]), 'normal path: acks and snapshots identical (incl. payload_sha256)');
  ok(pending(c) === 0 && c.failure === null, 'normal path: nothing left waiting, no failure');
}

// 5. session
{
  const { ExperimentSession } = await import(sessionModule) as { ExperimentSession: new (c: unknown, s: unknown) => {
    newGame(n: string, s: string, k?: string): Promise<{ ok: boolean; code?: string; message?: string }>;
    open(id: string, o?: Msg): Promise<{ ok: boolean; code?: string; message?: string }>;
    leave(save?: boolean): Promise<{ ok: boolean; code?: string } | null>;
    request(r: string): Promise<{ ok: boolean; code?: string }> | null;
    current: unknown; autosave: { state: { status: string } } | null;
  } };
  // a fake store: records every write; holds one stored world created from a real Worker snapshot
  const ref = new Runtime(() => 0); ref.handle({ type: 'init', req: 1, world_id: 'exp-stored', seed: 11, kind: 'synthetic' }); ref.handle({ type: 'step_until', req: 2, t_sim: 3600 });
  const storedSnap = (ref.handle({ type: 'snapshot', req: 3 }).find((r) => r.type === 'snapshot') as unknown as { snapshot: Record<string, unknown> }).snapshot;
  const storedJson = JSON.stringify(storedSnap);
  const mkStore = () => {
    const writes: string[] = [];
    return { writes, store: {
      getWorld: async (id: string) => id === 'exp-stored' ? { world_id: id, name: 'stored', engine_version: storedSnap.engine_version } : null,
      loadLatest: async () => ({ ok: true, value: { envelope: JSON.parse(storedJson), gen: 1, recovered: false, skipped: [], migrated_from: null, notice: null } }),
      createWorld: async (_l: unknown, _n: string, snap: { world_id: string }) => { writes.push(`create:${snap.world_id}`); return { ok: true, value: { world_id: snap.world_id, gen: 1 } }; },
      saveSnapshot: async () => { writes.push('save'); return { ok: true, value: { gen: 2 } }; },
      listWorlds: async () => [],
    } };
  };
  const session = (failAt: number | null, opts: { failWith?: 'error' | 'messageerror'; silent?: boolean } = {}) => {
    const { c, w } = mk(); w.failAt = failAt; if (opts.failWith) w.failWith = opts.failWith; if (opts.silent) w.mode = 'silent';
    const st = mkStore(); return { c, w, ...st, s: new ExperimentSession(c, st.store) };
  };
  // newGame: the Worker fails to load (first message), or dies at the new world's init after a good probe, or messageerror
  for (const [failAt, failWith, what] of [[1, 'error', 'load failure (probe)'], [3, 'error', 'error at the world init'], [4, 'messageerror', 'messageerror at the initial snapshot']] as const) {
    const { s, writes } = session(failAt, { failWith });
    const r = await settle(s.newGame('n', '5', 'synthetic'));
    ok(r.s === 'resolved' && !r.v.ok && r.v.code === 'worker_failed', `newGame (${what}): ends with worker_failed (${r.s}${r.s === 'resolved' ? ` ${r.v.code}` : ''})`);
    ok(writes.length === 0 && s.current === null && held.size === 0, `newGame (${what}): no world created, no session, writer lock released`);
  }
  { // terminate while newGame waits on a silent Worker
    const { s, c } = session(null, { silent: true });
    const p = s.newGame('n', '5', 'synthetic'); await tick(); await tick(); c.terminate();
    const r = await settle(p);
    ok(r.s === 'resolved' && !r.v.ok && r.v.code === 'worker_failed' && /WORKER_TERMINATED/.test(r.v.message ?? ''), `newGame + terminate: ends with worker_failed / WORKER_TERMINATED (${r.s})`);
  }
  { // open: the Worker dies at restore (message 3: probe init, probe snapshot, restore)
    const { s, writes } = session(3);
    const r = await settle(s.open('exp-stored'));
    ok(r.s === 'resolved' && !r.v.ok && r.v.code === 'worker_failed' && /存檔未被修改/.test(r.v.message ?? ''), `open: ends with worker_failed, says the save was not changed (${r.s})`);
    ok(writes.length === 0 && s.current === null && held.size === 0, 'open: nothing written, no session, writer lock released');
  }
  { // a working new game, then the Worker dies: manual save and leave fail cleanly; the stored world is untouched
    const { s, w, writes } = session(null);
    const r = await settle(s.newGame('n', '5', 'synthetic'));
    ok(r.s === 'resolved' && r.v.ok && writes.length === 1 && held.size === 1, 'normal newGame still works (initial snapshot written, lock held)');
    w.fail('worker crashed');
    const sv = await settle(s.request('manual')!);
    ok(sv.s === 'resolved' && !sv.v.ok && sv.v.code === 'worker_failed' && s.autosave?.state.status === 'failed', `save after the Worker died: worker_failed, autosave shows failed (${sv.s})`);
    const lv = await settle(s.leave(true));
    ok(lv.s === 'resolved' && lv.v !== null && !lv.v.ok && lv.v.code === 'worker_failed', `leave after the Worker died: returns the failed save (${lv.s})`);
    ok(s.current === null && held.size === 0 && writes.length === 1, 'leave: session cleared, lock released, no further write (the initial save stays as it was)');
    const again = await settle(s.newGame('n2', '6', 'synthetic'));
    ok(again.s === 'resolved' && !again.v.ok && again.v.code === 'worker_failed' && writes.length === 1, 'a new game on the failed client fails at once; no world is silently created');
  }
  { // a normal open still works
    const { s, writes } = session(null);
    const r = await settle(s.open('exp-stored'));
    ok(r.s === 'resolved' && r.v.ok && writes.length === 0, 'normal open still works');
    const lv = await settle(s.leave(false));
    ok(lv.s === 'resolved' && held.size === 0, 'normal leave releases the lock');
  }
}

console.log(JSON.stringify({ test: 'worker-client-fatal', checks }));
// the session's autosave interval timer keeps the event loop alive (browser page lifetime): end explicitly
process.exit(0);
