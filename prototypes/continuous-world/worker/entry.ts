/**
 * Browser entry of the NON-OFFICIAL experiment Worker (Owner decision #39; CLAUDE.md §9 B). Built by its own tsconfig
 * (lib WebWorker, include limited to this directory and the allowlisted engine modules) into web/worker-dist/
 * (gitignored). Started only by web/src/experimental/worker-client.ts.
 *
 * The wall clock (performance.now) and the timer are used ONLY for pacing: how far to advance per tick. They never
 * enter the simulation core. Nothing is persisted: no storage, network or file API is used here (tests/worker-boundary).
 */
import { Runtime } from './runtime.ts';
import type { Reply } from './protocol.ts';

interface WorkerScope {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(m: Reply): void;
  performance: { now(): number };
  setTimeout(f: () => void, ms: number): number;
}
const scope = globalThis as unknown as WorkerScope;
const rt = new Runtime(() => scope.performance.now());
/** real milliseconds between pacing ticks (display cadence only; results do not depend on it) */
const TICK_MS = 16;
let timer: number | null = null;

const post = (rs: Reply[]) => { for (const r of rs) scope.postMessage(r); };
const loop = () => {
  timer = null;
  if (!rt.isRunning()) return;
  post(rt.tick());
  timer = scope.setTimeout(loop, TICK_MS);
};
scope.onmessage = (e) => {
  post(rt.handle(e.data));
  if (rt.isRunning() && timer === null) timer = scope.setTimeout(loop, TICK_MS);
};
