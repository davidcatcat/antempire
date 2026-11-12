/**
 * World-kind registry (Owner ruling #200, option C; docs/save-format-v2.md §5). Pure TypeScript.
 *
 * A world kind is one versioned deterministic core that the browser Worker runs and that the Node verifier
 * (cli/verify-save.ts) recomputes with — the SAME module, never a second implementation. A save names its kind in
 * payload.save_meta.world_kind; the verifier refuses kinds it does not have. Another world (for example the P0-A2
 * world) plugs in by adding one entry that satisfies WorldKind; nothing else in the verifier changes.
 */
import { ENGINE_VERSION, ExperimentWorld, RULES_FINGERPRINT, SCHEMA_VERSION, WORLD_KIND, type ExperimentSnapshot } from './core.ts';
import { DEFAULT_PARAMS } from './params.ts';
import { hashJson } from './sha256.ts';
import type { ChainState } from './chain.ts';
import type { ExactTime } from '../../../engine/scheduler/world-events.ts';

/** what the verifier needs of a running world */
export interface VerifiableWorld {
  advanceToExact(end: ExactTime, maxBatches?: number): { events: unknown[]; done: boolean };
  nowExact(): ExactTime;
  seqNo(): number;
  chainState(): ChainState;
  snapshot(): { payload: unknown; payload_sha256: string; t_sim: number; seq: number };
}
export interface WorldKind {
  /** payload.save_meta.world_kind */
  id: string;
  engine_version: string;
  schema_version: number;
  /** the only rules this kind implements: a save with another fingerprint cannot be recomputed by it */
  rules_fingerprint: string;
  /** hash of this build's own parameters (the trusted initial conditions use these, never the file's) */
  params_sha256: string;
  create(worldId: string, seed: number): { world: VerifiableWorld; events: unknown[] };
  /** structural validation + restore; throws on any problem and changes nothing */
  restore(snapshot: unknown): VerifiableWorld;
}

export const SYNTHETIC_WORLD: WorldKind = {
  id: WORLD_KIND, engine_version: ENGINE_VERSION, schema_version: SCHEMA_VERSION, rules_fingerprint: RULES_FINGERPRINT,
  params_sha256: hashJson(DEFAULT_PARAMS),
  create: (worldId, seed) => ExperimentWorld.create(worldId, seed),
  restore: (s) => ExperimentWorld.restore(s as ExperimentSnapshot),
};

export const WORLD_KINDS: Readonly<Record<string, WorldKind>> = Object.freeze({ [SYNTHETIC_WORLD.id]: SYNTHETIC_WORLD });
