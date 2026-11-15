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
 * 'p0a2-colony' is an OPT-IN candidate (default off; docs/colony-candidate-world.md): the same P0-A2 world plus queens,
 * major workers, eggs and pupae as engine individuals whose physiology, behaviour, development and death are NOT
 * simulated. Its state frame is a P0-A2 frame (world_kind 'p0a2') that also carries `colony`; nothing starts it unless
 * init names this kind.
 */
export const PROTOCOL_VERSION = 'antempire.experiment-worker-protocol.v1';
export const EXPERIMENT_LABEL = '非正式實驗世界／不屬於正式遊戲歷史';

export type WorldKind = 'synthetic' | 'p0a2' | 'p0a2-colony';
export const WORLD_KINDS: readonly WorldKind[] = ['synthetic', 'p0a2', 'p0a2-colony'];

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
/**
 * One colony-roster individual of the 'p0a2-colony' candidate world (a queen, a major worker, an egg or a pupa): ENGINE
 * state, not a display prop. Every field that is unknown or does not apply is null (never a made-up value).
 * `not_simulated` lists the field keys of this individual that the engine does NOT simulate; their player-facing labels
 * are in P0a2ColonyMsg.not_simulated_fields. The model has no in-nest coordinates: any drawn position is illustrative.
 */
export interface ColonyIndividualMsg {
  id: string; kind: 'queen' | 'worker' | 'brood';
  /** 'major' for a major worker; null for queens and brood */
  caste: 'major' | null; caste_source: 'initial_scenario' | null;
  /** 'egg' | 'pupa' for brood; null otherwise (larvae are the P0-A2 larvae of P0a2FrameMsg.larvae) */
  stage: 'egg' | 'pupa' | null;
  /** engine state: in the nest since since_s (world seconds); there is no scheduled end (until_s null) */
  state: 'in_nest'; loc: 'nest'; since_s: number; until_s: null; alive: boolean;
  origin: 'initial_scenario'; mother_queen_id: null; caste_fate: 'undetermined' | null; stage_progress: null;
  /** unknown (not empty): null */
  crop_fill: null; initial_reserve: null;
  /** queens only: eggs laid in the model (0: oviposition is not simulated) and the time of the last laying */
  eggs_laid: number | null; last_oviposition_s: number | null;
  /** queens and majors: own ledger slot (integers; 0 = nothing was credited, not a measured reserve) */
  ledger: { have: { sugar_ug: number; protein_ug: number; energy_uj: number }; received: { sugar_ug: number; protein_ug: number; energy_uj: number } } | null;
  not_simulated: string[];
}
/** the colony part of a 'p0a2-colony' frame (candidate, default off). counts are player-view statistics only. */
export interface P0a2ColonyMsg {
  world_kind: 'p0a2-colony'; save_world_kind: string; candidate: true; status_zh: string;
  scenario: { id: string; checksum: string; brood_level: string; status: string };
  /** labelled assumptions of this world (all counts are assumptions; major_fraction is the isolated candidate value of this seed) */
  assumptions: { major_behaviour: 'in_nest_only' | 'as_minor'; major_fraction: number | null; major_fraction_isolated: boolean; all_counts_are_assumptions: true };
  counts: { queens: number; minor_workers: number; major_workers: number; eggs: number; larvae: number; pupae: number };
  queens: ColonyIndividualMsg[]; majors: ColonyIndividualMsg[]; eggs: ColonyIndividualMsg[]; pupae: ColonyIndividualMsg[];
  /** field key -> 「尚未模擬」 label (zh-TW) for the keys used in ColonyIndividualMsg.not_simulated */
  not_simulated_fields: Record<string, string>;
}
/** state frame of the P0-A2 world: ENGINE state only (no coordinates: the model has none except the route length) */
export interface P0a2FrameMsg {
  world_kind: 'p0a2'; status_zh: string; label: string; official: false; world_id: string; seed: number; rules_fingerprint: string; engine_version: string;
  t_sim: number; seq: number; log: { count: number; hash: string };
  model: { scenario: string; variant: string; variant_label: string; variant_status: string; day0_date: string };
  layout: { source_id: string; source_distance_cm: number; travel_s: number; move_s: number };
  /** until_s: end of the current fixed-duration movement (route travel or in-nest move), else null */
  /** caste: present only in the 'p0a2-colony' candidate world (every P0-A2 worker is a minor) */
  workers: { id: string; state: string; loc: 'nest' | 'nest_transit' | 'outside'; since_s: number; until_s: number | null; crop_fill: number; route: string | null; caste?: 'minor' }[];
  larvae: { id: string; gut_fill: number }[];
  /** player view (observation only; no worker reads it) */
  source: { id: string; stock_portions: number };
  env: { date: string; light: 'night' | 'civil_twilight' | 'day'; temperature_c: number | null; site_temperature_c: number | null; rh_percent: number | null; synthetic: true; sun_altitude_deg: number; before_solar_noon: boolean };
  /** only in the 'p0a2-colony' candidate world: queens, majors, eggs and pupae as engine individuals */
  colony?: P0a2ColonyMsg;
}
export type AnyFrameMsg = FrameMsg | P0a2FrameMsg;
export const isP0a2Frame = (f: AnyFrameMsg | null | undefined): f is P0a2FrameMsg => !!f && (f as P0a2FrameMsg).world_kind === 'p0a2';
/** a P0-A2 frame of the colony-members candidate world (it carries `colony`) */
export const isP0a2ColonyFrame = (f: AnyFrameMsg | null | undefined): f is P0a2FrameMsg & { colony: P0a2ColonyMsg } => isP0a2Frame(f) && !!f.colony && f.colony.world_kind === 'p0a2-colony';
export interface PacingMsg { running: boolean; started: boolean; speed: number; lagging: boolean }
interface Envelope { protocol: string; label: string; official: false }
export type Reply =
  | (Envelope & { type: 'ack'; req: number; cmd: CommandType; frame: AnyFrameMsg | null; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'error'; req: number | null; cmd: string | null; code: string; message: string })
  | (Envelope & { type: 'events'; events: EventMsg[] })
  | (Envelope & { type: 'state'; frame: AnyFrameMsg; pacing: PacingMsg; followed: unknown })
  | (Envelope & { type: 'snapshot'; req: number; snapshot: unknown });
