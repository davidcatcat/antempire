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
 * World kinds: 'synthetic' (the small synthetic test world; default when init names none) and 'p0a2' (the P0-A2
 * 24-hour individual-behaviour world, a candidate / experiment world, non-official). restore picks the kind from the
 * snapshot's engine_version.
 */
export const PROTOCOL_VERSION = 'antempire.experiment-worker-protocol.v1';
export const EXPERIMENT_LABEL = '非正式實驗世界／不屬於正式遊戲歷史';

export type WorldKind = 'synthetic' | 'p0a2';
export const WORLD_KINDS: readonly WorldKind[] = ['synthetic', 'p0a2'];

export type Command =
  | { type: 'init'; req: number; world_id: string; seed: number; kind?: WorldKind }
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
/** state frame of the P0-A2 world: ENGINE state only (no coordinates: the model has none except the route length) */
export interface P0a2FrameMsg {
  world_kind: 'p0a2'; status_zh: string; label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; engine_version: string;
  t_sim: number; seq: number; log: { count: number; hash: string };
  model: { scenario: string; variant: string; variant_label: string; variant_status: string; day0_date: string };
  layout: { source_id: string; source_distance_cm: number; travel_s: number; move_s: number };
  /** until_s: end of the current fixed-duration movement (route travel or in-nest move), else null */
  workers: { id: string; state: string; loc: 'nest' | 'nest_transit' | 'outside'; since_s: number; until_s: number | null; crop_fill: number; route: string | null }[];
  larvae: { id: string; gut_fill: number }[];
  /** player view (observation only; no worker reads it) */
  source: { id: string; stock_portions: number };
  env: { date: string; light: 'night' | 'civil_twilight' | 'day'; temperature_c: number | null; site_temperature_c: number | null; rh_percent: number | null; synthetic: true; sun_altitude_deg: number; before_solar_noon: boolean };
}
export type AnyFrameMsg = FrameMsg | P0a2FrameMsg;
export const isP0a2Frame = (f: AnyFrameMsg | null | undefined): f is P0a2FrameMsg => !!f && (f as P0a2FrameMsg).world_kind === 'p0a2';
export interface PacingMsg { running: boolean; started: boolean; speed: number; lagging: boolean }
interface Envelope { protocol: string; label: string; official: false }
export type Reply =
  | (Envelope & { type: 'ack'; req: number; cmd: CommandType; frame: AnyFrameMsg | null; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'error'; req: number | null; cmd: string | null; code: string; message: string })
  | (Envelope & { type: 'events'; events: EventMsg[] })
  | (Envelope & { type: 'state'; frame: AnyFrameMsg; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'snapshot'; req: number; snapshot: unknown });
