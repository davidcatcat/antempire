/**
 * Event-chain commitment of the experiment Worker (Owner ruling #200, option C; docs/save-format-v2.md §3).
 * Pure TypeScript (no DOM, no Node): the same code runs in the browser Worker and in the Node verifier.
 *
 * Definition (antempire.event-chain.v1), all hashes lower-case hex SHA-256 of UTF-8 text:
 *   genesis = SHA-256( "antempire.event-chain.v1" + "\n" + canonicalJson({ world_kind, world_id, seed, rules_fingerprint }) )
 *   head_0  = genesis, count_0 = 0
 *   head_k+1 = SHA-256( head_k + "\n" + canonicalJson(event_k) ), count_k+1 = count_k + 1
 * where event_k is the k-th committed event record exactly as the Worker emits it (including seq = k). Events are
 * committed in emission order: by exact instant, and inside one instant by canonical event id (core.ts prepare()).
 *
 * The chain is a COMMITMENT, not a proof: anyone can recompute a self-consistent head over invented events. Only a
 * recomputation from trusted initial conditions with the same rules (cli/verify-save.ts) can show that a head is the
 * one these rules produce.
 */
import { canonicalJson, sha256Hex } from './sha256.ts';

export const CHAIN_ALGO = 'antempire.event-chain.v1';
export interface ChainState { algo: typeof CHAIN_ALGO; genesis: string; head: string; count: number }
export interface ChainContext { world_kind: string; world_id: string; seed: number; rules_fingerprint: string }

const HEX64 = /^[0-9a-f]{64}$/;
export const chainGenesis = (c: ChainContext): string =>
  sha256Hex(`${CHAIN_ALGO}\n${canonicalJson({ world_kind: c.world_kind, world_id: c.world_id, seed: c.seed, rules_fingerprint: c.rules_fingerprint })}`);
export const chainStart = (c: ChainContext): ChainState => { const g = chainGenesis(c); return { algo: CHAIN_ALGO, genesis: g, head: g, count: 0 }; };
/** the next head after committing one event record */
export const chainNext = (head: string, event: unknown): string => sha256Hex(`${head}\n${canonicalJson(event)}`);
/** a new state after committing `events` in order (the input state is not changed) */
export function chainAppend(s: ChainState, events: readonly unknown[]): ChainState {
  let head = s.head; for (const e of events) head = chainNext(head, e);
  return { algo: s.algo, genesis: s.genesis, head, count: s.count + events.length };
}
/** shape problems of a stored chain state, or null (the head itself can only be checked by recomputation) */
export function chainShapeProblem(x: unknown): string | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return 'chain is not an object';
  const c = x as Record<string, unknown>;
  if (Object.keys(c).sort().join() !== 'algo,count,genesis,head') return `chain fields ${Object.keys(c).sort().join()}`;
  if (c.algo !== CHAIN_ALGO) return `chain algo ${String(c.algo)} is not ${CHAIN_ALGO}`;
  if (typeof c.genesis !== 'string' || !HEX64.test(c.genesis) || typeof c.head !== 'string' || !HEX64.test(c.head)) return 'chain genesis / head must be 64 lower-case hex';
  if (!Number.isSafeInteger(c.count) || (c.count as number) < 0) return 'chain count must be an integer >= 0';
  if (c.count === 0 && c.head !== c.genesis) return 'an empty chain must have head = genesis';
  return null;
}
