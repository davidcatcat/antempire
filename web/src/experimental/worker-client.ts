/**
 * The ONLY viewer module that may start the non-official experiment Worker (prototypes/continuous-world/worker-boundary.json
 * `worker_client_files`; CLAUDE.md §9 B). Message-only: it imports no engine or Worker code, runs no simulation, and
 * persists nothing. Every reply is checked to carry the non-official label before it is handed to the page.
 */
import { EXPERIMENT_LABEL, PROTOCOL_VERSION, type Command, type EventMsg, type FrameMsg, type PacingMsg, type Reply } from './worker-protocol.ts';

type Body<C> = C extends { req: number } ? Omit<C, 'req'> : never;
export type CommandBody = Body<Command>;
type Final = Extract<Reply, { type: 'ack' | 'error' | 'snapshot' }>;

export class ExperimentWorkerClient {
  private readonly worker: Worker;
  private req = 0;
  private readonly waiting = new Map<number, (r: Final) => void>();
  onEvents: (events: EventMsg[]) => void = () => {};
  onState: (frame: FrameMsg, pacing: PacingMsg, followed: unknown) => void = () => {};
  onProtocolError: (why: string) => void = () => {};

  constructor(url: URL = new URL('../../worker-dist/prototypes/continuous-world/worker/entry.js', import.meta.url)) {
    this.worker = new Worker(url, { type: 'module', name: 'antempire-experiment-world' });
    this.worker.onmessage = (e: MessageEvent<Reply>) => this.receive(e.data);
    this.worker.onerror = (e) => this.onProtocolError(`worker error: ${e.message}`);
  }

  private receive(r: Reply): void {
    if (!r || r.protocol !== PROTOCOL_VERSION || r.label !== EXPERIMENT_LABEL || r.official !== false) { this.onProtocolError('a reply without the non-official label was rejected'); return; }
    if (r.type === 'events') { if (r.events.some((e) => e.official !== false || e.label !== EXPERIMENT_LABEL)) { this.onProtocolError('an event without the non-official label was rejected'); return; } this.onEvents(r.events); return; }
    if (r.type === 'state') { this.onState(r.frame, r.pacing, r.followed); return; }
    if (r.type === 'ack' && r.frame) this.onState(r.frame, r.pacing, r.followed);
    const done = r.req === null ? undefined : this.waiting.get(r.req);
    if (done) { this.waiting.delete(r.req as number); done(r); }
  }

  /** send one command; resolves with its ack, snapshot or error (events and state arrive through the callbacks first) */
  send(body: CommandBody): Promise<Final> {
    const req = ++this.req;
    return new Promise((resolve) => { this.waiting.set(req, resolve); this.worker.postMessage({ ...body, req }); });
  }
  init(world_id: string, seed: number) { return this.send({ type: 'init', world_id, seed }); }
  start() { return this.send({ type: 'start' }); }
  pause() { return this.send({ type: 'pause' }); }
  resume() { return this.send({ type: 'resume' }); }
  setSpeed(speed: number) { return this.send({ type: 'set_speed', speed }); }
  stepUntil(t_sim: number) { return this.send({ type: 'step_until', t_sim }); }
  snapshot() { return this.send({ type: 'snapshot' }); }
  restore(snapshot: unknown) { return this.send({ type: 'restore', snapshot }); }
  follow(id: string | null) { return this.send({ type: 'follow', id }); }
  /** raw message (tests: an unknown command must be rejected) */
  sendRaw(m: unknown): void { this.worker.postMessage(m); }
  terminate(): void { this.worker.terminate(); }
}
