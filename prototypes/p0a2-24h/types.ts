/**
 * P0-A2 phase 2 — types of the isolated 24-hour individual-behaviour prototype (docs/p0a2-24h-prototype.md).
 * NON-OFFICIAL experiment world only. Pure data types; no platform API.
 *
 * Units: time = integer milliseconds since experiment Day0 00:00 local time (the world minute IS local civil time, as in
 * engine/clock/time-frames.ts); food = integer micro-portions (µP, 1e-6 of a game portion) so conservation is exact.
 */
import type { LightState } from '../../engine/clock/solar.ts';

export type EvidenceClass = 'this_species' | 'other_species_extrapolated' | 'game_assumption';
export const EVIDENCE_CLASSES: readonly EvidenceClass[] = ['this_species', 'other_species_extrapolated', 'game_assumption'];

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** activity state of one worker (design §4.3, reduced: no cleaning / repair, no sheltering — 尚未模擬) */
export type WorkerState = 'resting' | 'idle' | 'brood_care' | 'to_entrance' | 'outbound' | 'searching' | 'feeding' | 'returning';
export const WORKER_STATES: readonly WorkerState[] = ['resting', 'idle', 'brood_care', 'to_entrance', 'outbound', 'searching', 'feeding', 'returning'];
/** where a worker is: inside the nest (contactable by nestmates), moving inside the nest, or outside the nest */
export type Loc = 'nest' | 'nest_transit' | 'outside';

/** one contact the worker itself experienced (design §4.4: every stimulus traces back to a contact) */
export interface ContactRec { t: number; from: string; loaded: boolean; route: string | null }
/** one larva the worker itself touched, with the begging signal it perceived at that contact */
export interface BegRec { t: number; larva: string; signal: number }

export interface Worker {
  id: string;
  state: WorkerState; loc: Loc; since: number;
  /** own crop content (µP) */
  crop: number;
  /** last instant metabolism and time budgets were booked up to */
  last: number;
  /** remainder of the integer metabolism division (keeps booking exact whatever the event spacing) */
  carry: number;
  consumed: number;
  /** metabolic need not met because the crop was empty (µP; diagnostic, not food) */
  debt: number;
  /** individual traits (drawn once at Day0 from the worker's own named stream) */
  theta_forage: number; theta_brood: number; gain: number; thermal_offset_c: number; ctmax_c: number;
  /** route memory: the food source this worker walked to itself or was recruited to by contact; null = none */
  route: string | null;
  /** whether the current / last trip filled the crop to the recruitment level (only meaningful while returning) */
  trip_loaded: boolean;
  contacts: ContactRec[]; begging: BegRec[];
  /** id of this worker's one live event (others in the queue are stale and skipped) */
  pending: string | null;
  /** counter for canonical event ids of this worker */
  n: number;
}
export interface Larva { id: string; gut: number; last: number; carry: number; consumed: number; deficit: number }
export interface Source { id: string; stock: number; produced: number; taken: number; n: number }

/** a queued event: exact instant t (ms), round r (causal depth inside one instant), canonical id, kind, actor, payload */
export interface QEvent { t: number; r: number; id: string; k: string; a: string; p: { [k: string]: Json } }

export interface Stats {
  /** time spent in each state per local hour of day (ms, all days pooled) — colony-level STATISTICS only */
  occ: Record<WorkerState, number[]>;
  exits_by_hour: number[]; declines_by_hour: number[]; returns_by_hour: number[];
  temp_unavailable: number; heat_refusals: number; searches_found: number; searches_failed: number;
  trophallaxis_events: number; larva_feeds: number;
  /** events that shared their exact instant and round with an event of another actor (processed in canonical-id
   *  order; the same-instant contest rule is open — design §4.1, P0-A1 §7) */
  same_instant_events: number;
}

export interface WorldState {
  schema: string; official: false; params_sha: string; scenario: string; seed: number;
  /** the instant the world has been advanced to (every event with t <= t_now has run) */
  t_now: number;
  workers: Record<string, Worker>; larvae: Record<string, Larva>; sources: Record<string, Source>;
  ledger: { initial: number; produced: number };
  log: { count: number; hash: string };
  stats: Stats;
  /** live pending events, sorted by (t, r, id) */
  queue: QEvent[];
  /** (t, r) of the last processed event and its actor, for the same-instant diagnostic */
  last_key: { t: number; r: number; a: string } | null;
}

// ------------------------------------------------------------------ decision inputs (LOCAL ONLY — CLAUDE.md §2.1/§2.1b)
/** what a worker knows about itself: its own physiology, traits, memory and the contacts it experienced */
export interface SelfView {
  crop: number; crop_room: number; crop_fill: number;
  theta_forage: number; theta_brood: number; gain: number; thermal_offset_c: number; ctmax_c: number;
  has_route: boolean;
  /** contacts by loaded returning foragers it experienced within the contact window */
  recruit_contacts_recent: number;
  /** begging larvae it touched within the contact window */
  begging_recent: number;
}
/** what a worker senses at the nest entrance or outside, at its own location and instant */
export interface SiteView { temp_c: number | null; light: LightState }
/** what a worker senses at a food source it reached itself */
export interface SourceView { food_here: number; temp_c: number | null }
/** what a forager perceives of a nestmate it actually touched (crop distension) */
export interface PartnerView { crop_room: number }
/** what a worker perceives of a larva it actually touched */
export interface LarvaView { begging: number; room: number }

/** species / scenario constants handed to decisions (not colony state) */
export interface DecisionConsts {
  hill_n: number; recruit_contact_weight: number; idle_probability: number;
  f_t: { zero_low: number; peak: number; zero_high: number }; light_factor_night: number;
  transfer_max: number; feed_bolus: number; begging_threshold: number;
}
export type NestChoice = 'forage' | 'brood' | 'idle' | 'rest';
export type ExitChoice = 'exit' | 'declined' | 'temp_unavailable' | 'heat';
