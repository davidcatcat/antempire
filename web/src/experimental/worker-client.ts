/**
 * The ONLY viewer module that may start the non-official experiment Worker (prototypes/continuous-world/worker-boundary.json
 * `worker_client_files`; CLAUDE.md §9 B). Message-only: it imports no engine or Worker code, runs no simulation, and
 * persists nothing. Every reply is checked to carry the non-official label before it is handed to the page.
 */
import { EXPERIMENT_LABEL, PROTOCOL_VERSION, type AnyFrameMsg, type Command, type EventMsg, type PacingMsg, type Reply, type WorldKind } from './worker-protocol.ts';

type Body<C> = C extends { req: number } ? Omit<C, 'req'> : never;
export type CommandBody = Body<Command>;
type Final = Extract<Reply, { type: 'ack' | 'error' | 'snapshot' }>;

/** Why the client can no longer deliver replies (issue #224). Never a Worker reply: no ACK or snapshot is invented. */
export type WorkerClientErrorCode = 'WORKER_FATAL' | 'WORKER_TERMINATED';
/** Rejection of a command whose reply can never arrive: the Worker failed (error / messageerror) or was terminated. */
export class WorkerClientError extends Error {
  readonly code: WorkerClientErrorCode;
  constructor(code: WorkerClientErrorCode, message: string) { super(`${code}: ${message}`); this.name = 'WorkerClientError'; this.code = code; }
}
export const isWorkerClientError = (e: unknown): e is WorkerClientError => e instanceof WorkerClientError;

export class ExperimentWorkerClient {
  private readonly worker: Worker;
  private req = 0;
  private readonly waiting = new Map<number, { resolve: (r: Final) => void; reject: (e: WorkerClientError) => void }>();
  private failed: WorkerClientError | null = null;
  onEvents: (events: EventMsg[]) => void = () => {};
  onState: (frame: AnyFrameMsg, pacing: PacingMsg, followed: unknown) => void = () => {};
  onProtocolError: (why: string) => void = () => {};

  constructor(url: URL = new URL('../../worker-dist/prototypes/continuous-world/worker/entry.js', import.meta.url)) {
    this.worker = new Worker(url, { type: 'module', name: 'antempire-experiment-world' });
    this.worker.onmessage = (e: MessageEvent<Reply>) => this.receive(e.data);
    // A Worker error (module load failure, uncaught exception) or an undeserialisable reply means the pending commands
    // can never be answered: end them all, stop the Worker and refuse further commands (issue #224).
    this.worker.onerror = (e) => {
      if (this.failed) return;
      // a module Worker whose script failed to load fires a plain Event (no message)
      const why = `worker error: ${(e as Partial<ErrorEvent>).message || '(no message: e.g. the Worker script failed to load)'}`;
      this.onProtocolError(why); this.fail('WORKER_FATAL', why);
    };
    this.worker.onmessageerror = () => { if (this.failed) return; this.onProtocolError('a Worker reply could not be deserialised'); this.fail('WORKER_FATAL', 'a Worker reply could not be deserialised'); };
  }

  /** the failure that ended this client (null while it works); a failed client never recovers: the page starts a new one */
  get failure(): WorkerClientError | null { return this.failed; }

  private fail(code: WorkerClientErrorCode, message: string): void {
    this.failed = new WorkerClientError(code, message);
    this.worker.terminate();
    const all = [...this.waiting.values()]; this.waiting.clear();
    for (const w of all) w.reject(this.failed);
  }

  private receive(r: Reply): void {
    if (this.failed) return; // a late message from a failed or terminated Worker is ignored
    if (!r || r.protocol !== PROTOCOL_VERSION || r.label !== EXPERIMENT_LABEL || r.official !== false) { this.onProtocolError('a reply without the non-official label was rejected'); return; }
    if (r.type === 'events') { if (r.events.some((e) => e.official !== false || e.label !== EXPERIMENT_LABEL)) { this.onProtocolError('an event without the non-official label was rejected'); return; } this.onEvents(r.events); return; }
    if (r.type === 'state') { this.onState(r.frame, r.pacing, r.followed); return; }
    if (r.type === 'ack' && r.frame) this.onState(r.frame, r.pacing, r.followed);
    const done = r.req === null ? undefined : this.waiting.get(r.req);
    if (done) { this.waiting.delete(r.req as number); done.resolve(r); }
  }

  /** send one command; resolves with its ack, snapshot or error (events and state arrive through the callbacks first).
   *  Rejects with a WorkerClientError when the Worker failed or was terminated before the reply (at once if it already had). */
  send(body: CommandBody): Promise<Final> {
    if (this.failed) return Promise.reject(this.failed);
    const req = ++this.req;
    return new Promise((resolve, reject) => {
      this.waiting.set(req, { resolve, reject });
      try { this.worker.postMessage({ ...body, req }); } catch (e) { this.waiting.delete(req); reject(e); }
    });
  }
  /** kind omitted = the Worker's default (synthetic); the experiment page passes it explicitly */
  init(world_id: string, seed: number, kind?: WorldKind) { return this.send(kind ? { type: 'init', world_id, seed, kind } : { type: 'init', world_id, seed }); }
  start() { return this.send({ type: 'start' }); }
  pause() { return this.send({ type: 'pause' }); }
  resume() { return this.send({ type: 'resume' }); }
  setSpeed(speed: number) { return this.send({ type: 'set_speed', speed }); }
  stepUntil(t_sim: number) { return this.send({ type: 'step_until', t_sim }); }
  snapshot() { return this.send({ type: 'snapshot' }); }
  restore(snapshot: unknown) { return this.send({ type: 'restore', snapshot }); }
  follow(id: string | null) { return this.send({ type: 'follow', id }); }
  /** raw message (tests: an unknown command must be rejected) */
  sendRaw(m: unknown): void { if (this.failed) throw this.failed; this.worker.postMessage(m); }
  /** stop the Worker; every pending command rejects with WORKER_TERMINATED, later commands reject at once */
  terminate(): void { if (!this.failed) this.fail('WORKER_TERMINATED', 'the Worker was terminated'); }
}
