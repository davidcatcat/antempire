/**
 * P0-A2 phase 2 — INDIVIDUAL DECISIONS (design §4.4). Every function here receives ONLY one individual's own view, the
 * local view of its own location (or of one partner it actually touched), constants, and uniform draws. Nothing here
 * can reach colony totals, other individuals, the queue or the clock of day: this module imports types only (plus the
 * stateless deterministic power function of engine/clock/detmath.ts, rules update detmath-exp: `**` is
 * implementation-approximated and differs between engines), and the world hands it guarded views (world.ts guardView)
 * that throw on any field that is not a local signal. tests/p0a2-24h-proto.test.ts checks this file statically (no
 * colony-level identifier, type-only imports except that one named math import).
 *
 * There is NO time-of-day input and no table from hour to activity: the activity time distribution is an output.
 */
import { detPow } from '../../engine/clock/detmath.ts';
import type { CarerView, DecisionConsts, DonorView, ExitChoice, LarvaView, NeedView, NestChoice, PartnerView, Retention, SelfView, SiteView, SourceView } from './types.ts';

/** response threshold hill(s; θ, n) (mechanism: R234 etc., other species; form and values: game assumption) */
export const hill = (s: number, theta: number, n: number): number => (s <= 0 ? 0 : detPow(s, n) / (detPow(s, n) + detPow(theta, n)));

/** exit temperature factor f_T: 0 at or below zero_low, rising linearly to 1 at peak, falling linearly to 0 at
 *  zero_high (anchors: R190 P. pallidula, other species; straight lines: game assumption); no anchors (null) => 1 */
export function fT(T: number, c: DecisionConsts['f_t']): number {
  if (c === null) return 1;
  if (T <= c.zero_low || T >= c.zero_high) return 0;
  return T <= c.peak ? (T - c.zero_low) / (c.peak - c.zero_low) : (c.zero_high - T) / (c.zero_high - c.peak);
}

/** in the nest: start foraging, start brood care, walk about (idle) or rest. Stimuli: own crop emptiness + recruiting
 *  contacts experienced; begging larvae touched. u1..u3 uniform draws of the calling event's own stream. */
export function chooseInNest(self: SelfView, c: DecisionConsts, u1: number, u2: number, u3: number): NestChoice {
  const sForage = (1 - self.crop_fill) + c.recruit_contact_weight * self.recruit_contacts_recent;
  const pf = self.gain * hill(sForage, self.theta_forage, c.hill_n);
  // brood care feeds larvae from the worker's own crop: with nothing it may give (process 3, its own state only —
  // reference: crop > 0) there is nothing to give
  const pb = broodGivable(self, c) > 0 ? self.gain * hill(self.begging_recent, self.theta_brood, c.hill_n) : 0;
  const any = 1 - (1 - pf) * (1 - pb);
  if (u1 < any) return u2 * (pf + pb) < pf ? 'forage' : 'brood';
  return u3 < c.idle_probability ? 'idle' : 'rest';
}

/** at the nest entrance: leave or not, from the temperature and light at the entrance as the worker experiences them */
export function decideExit(self: SelfView, site: SiteView, c: DecisionConsts, u: number): ExitChoice {
  if (site.temp_c === null) return 'temp_unavailable';
  const T = site.temp_c + self.thermal_offset_c;
  if (T >= self.ctmax_c) return 'heat';
  const e = fT(T, c.f_t) * (site.light === 'day' ? 1 : c.light_factor_night);
  return u < e ? 'exit' : 'declined';
}

/** at a food source the worker reached itself: how much to take (µP), or turn back from heat */
export function decideAtSource(self: SelfView, here: SourceView): { take: number; heat: boolean } {
  if (here.temp_c !== null && here.temp_c + self.thermal_offset_c >= self.ctmax_c) return { take: 0, heat: true };
  return { take: Math.min(self.crop_room, here.food_here), heat: false };
}

// ---------------------------------------------------------------- the three food processes (Owner #188, 2026-11-12)
// (1) own metabolism / own need, (2) adult–adult trophallaxis, (3) adult→brood feeding. Each giving process has its OWN
// cap and its OWN retention setting in DecisionConsts (trophallaxis.*, brood.*); none reads colony stores, other
// individuals or the larvae count. Every transfer the world applies is min(offer, donor's crop, receiver's room), booked
// as the donor's loss and the receiver's gain in the same instant (exact integer µP; tests check it per individual).

/** (1) OWN NEED: the worker's own expected metabolic need (µP) under a retention formulation, computed ONLY from its
 *  own state — its own metabolic rate and, for 'own_interval', the interval between its own last two intakes at a
 *  source (its own experience). null => 0. Unknown interval (no two own intakes yet) => 0 (not filled). Formulations
 *  and values are game assumptions; mechanism direction for foragers only from R147 (Camponotus sanctus, other
 *  species; the 'hand over half' ratio is NOT used); for carers from general physiology (no data for this species). */
export function ownNeed(self: NeedView, r: Retention, c: DecisionConsts): number {
  if (r === null) return 0;
  const need_ms = r.kind === 'horizon' ? r.need_ms : self.forage_interval_ms === null ? 0 : r.factor * self.forage_interval_ms;
  return Math.ceil((c.own.metabolic_rate_per_day * need_ms) / c.own.day_ms);
}

/** (1)→(2) the Q2 candidate 'a returning forager keeps what it needs' (default OFF): the own need under the
 *  TROPHALLAXIS retention setting */
export function ownReserve(self: NeedView, c: DecisionConsts): number { return ownNeed(self, c.trophallaxis.retention, c); }

/** (2) trophallaxis offered by a returning forager to one nestmate it touched (µP): never above the trophallaxis cap,
 *  never below its own trophallaxis reserve, never above the partner's crop room */
export function decideTransfer(self: DonorView, partner: PartnerView, c: DecisionConsts): number {
  return Math.max(0, Math.min(c.trophallaxis.transfer_max, self.crop - ownReserve(self, c), partner.crop_room));
}

/** (3) what a carer may give to brood from its OWN crop (µP): its crop minus its own need under the BROOD retention
 *  setting (independent of the trophallaxis one); 0 when its own crop fill is below the carer's own minimum (if set).
 *  Reads only the carer's own state. Reference (both null): its whole crop */
export function broodGivable(self: CarerView, c: DecisionConsts): number {
  const b = c.brood;
  if (b.min_own_crop_fill !== null && self.crop_fill < b.min_own_crop_fill) return 0;
  return Math.max(0, self.crop - ownNeed(self, b.retention, c));
}

/** (3) feeding one larva the carer actually touched: triggered by the begging it perceived at THIS contact
 *  ('threshold': signal >= begging_threshold, reference; 'graded': with probability = signal, u = a uniform draw of the
 *  calling event's own stream — mechanism direction R210 Solenopsis invicta, other species: feeding rate rises with the
 *  larva's own deprivation; linear form is a game assumption); bolus = min(brood bolus, what the carer may give, the
 *  larva's room). The larva's need never creates food: nothing is given beyond the carer's own crop */
export function decideFeedLarva(self: CarerView, larva: LarvaView, c: DecisionConsts, u: number): number {
  const b = c.brood;
  if (b.trigger === 'threshold' ? larva.begging < b.begging_threshold : !(u < larva.begging)) return 0;
  return Math.max(0, Math.min(b.feed_bolus, broodGivable(self, c), larva.room));
}
