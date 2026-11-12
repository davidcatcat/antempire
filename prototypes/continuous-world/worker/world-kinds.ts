/**
 * World-kind registry (Owner ruling #200, option C; docs/save-format-v2.md §5). Pure TypeScript.
 *
 * A world kind is one versioned deterministic core that the browser Worker runs and that the Node verifier
 * (cli/verify-save.ts) recomputes with — the SAME module, never a second implementation. A save names its kind in
 * payload.save_meta.world_kind; the verifier refuses kinds it does not have. Another world plugs in by adding one entry
 * that satisfies WorldKind; nothing else in the verifier changes.
 *
 * Registered: 'synthetic-v1' (core.ts, the synthetic test world) and 'p0a2-24h-v1' (p0a2-world.ts, the P0-A2 24 h
 * individual-behaviour world: candidate / experiment world, non-official).
 */
import { ENGINE_VERSION, ExperimentWorld, RULES_FINGERPRINT, SCHEMA_VERSION, WORLD_KIND, type ExperimentSnapshot } from './core.ts';
import { DEFAULT_PARAMS } from './params.ts';
import { hashJson } from './sha256.ts';
import { P0A2_ENGINE_VERSION, P0A2_PARAMS_SHA, P0A2_RULES_FINGERPRINT, P0A2_SAVE_WORLD_KIND, P0A2_SCHEMA_VERSION, P0a2ExperimentWorld, type P0a2Snapshot } from './p0a2-world.ts';
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

/** the P0-A2 world: params_sha256 is the SHA-256 of this build's prototypes/p0a2-24h/params.json (canonical) */
export const P0A2_WORLD: WorldKind = {
  id: P0A2_SAVE_WORLD_KIND, engine_version: P0A2_ENGINE_VERSION, schema_version: P0A2_SCHEMA_VERSION, rules_fingerprint: P0A2_RULES_FINGERPRINT,
  params_sha256: P0A2_PARAMS_SHA,
  create: (worldId, seed) => P0a2ExperimentWorld.create(worldId, seed),
  restore: (s) => P0a2ExperimentWorld.restore(s as P0a2Snapshot),
};

export const WORLD_KINDS: Readonly<Record<string, WorldKind>> = Object.freeze({ [SYNTHETIC_WORLD.id]: SYNTHETIC_WORLD, [P0A2_WORLD.id]: P0A2_WORLD });
