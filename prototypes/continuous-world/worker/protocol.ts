/**
 * Message protocol between the viewer (web/src/experimental/worker-client.ts) and the non-official experiment Worker
 * (prototypes/continuous-world/worker/entry.ts). Self-contained (imports nothing) because web/src may not import the
 * Worker directory and the Worker may not import web/: the file exists twice, byte-identical
 * (prototypes/continuous-world/worker/protocol.ts and web/src/experimental/worker-protocol.ts; checked by
 * tests/worker-runtime.test.ts).
 *
 * Commands change only SCHEDULING (start / pause / resume / set_speed / step_until) or OBSERVATION (follow, snapshot).
 * None can change a rule, a parameter, a seed of a running world, an individual or an event. init creates a new
 * isolated experiment world; restore replaces it with a verified snapshot (or is refused and changes nothing).
 */
export const PROTOCOL_VERSION = 'antempire.experiment-worker-protocol.v1';
export const EXPERIMENT_LABEL = '非正式實驗世界／不屬於正式遊戲歷史';

export type Command =
  | { type: 'init'; req: number; world_id: string; seed: number }
  | { type: 'start'; req: number }
  | { type: 'pause'; req: number }
  | { type: 'resume'; req: number }
  | { type: 'set_speed'; req: number; speed: number }
  | { type: 'step_until'; req: number; t_sim: number }
  | { type: 'snapshot'; req: number }
  | { type: 'restore'; req: number; snapshot: unknown }
  | { type: 'follow'; req: number; id: string | null };
export type CommandType = Command['type'];
export const COMMAND_TYPES: readonly CommandType[] = ['init', 'start', 'pause', 'resume', 'set_speed', 'step_until', 'snapshot', 'restore', 'follow'];

/** simulation speed: world seconds per real second (pacing only) */
export const MIN_SPEED = 0.1, MAX_SPEED = 86_400;

export interface ExactTimeMsg { day: number; us: number; us_lo: number }
export interface VecMsg { x: number; y: number }
export interface EventMsg {
  seq: number; event_id: string; kind: string; t_sim: number; exact: ExactTimeMsg; round: number; entity: string | null;
  data: Record<string, unknown>; rng: { stream: string; from_draw: number; values: number[] } | null;
  world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  official: false; label: string;
}
export interface FrameMsg {
  label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; t_sim: number; seq: number;
  ants: { id: string; activity: 'resting' | 'walking' | 'pausing'; since_s: number; until_s: number; from: VecMsg; to: VecMsg | null; in_nest: boolean }[];
  env: { date: string | null; light: 'night' | 'civil_twilight' | 'day' | null; temperature_c: number | null; temperature_synthetic: true };
  arena_radius_cm: number;
}
export interface PacingMsg { running: boolean; started: boolean; speed: number; lagging: boolean }
interface Envelope { protocol: string; label: string; official: false }
export type Reply =
  | (Envelope & { type: 'ack'; req: number; cmd: CommandType; frame: FrameMsg | null; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'error'; req: number | null; cmd: string | null; code: string; message: string })
  | (Envelope & { type: 'events'; events: EventMsg[] })
  | (Envelope & { type: 'state'; frame: FrameMsg; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'snapshot'; req: number; snapshot: unknown });
