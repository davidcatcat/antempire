/**
 * P0-A2 phase 2 — INDIVIDUAL DECISIONS (design §4.4). Every function here receives ONLY one individual's own view, the
 * local view of its own location (or of one partner it actually touched), constants, and uniform draws. Nothing here
 * can reach colony totals, other individuals, the queue or the clock of day: this module imports types only, and the
 * world hands it guarded views (world.ts guardView) that throw on any field that is not a local signal.
 * tests/p0a2-24h-proto.test.ts checks this file statically (no colony-level identifier, type-only imports).
 *
 * There is NO time-of-day input and no table from hour to activity: the activity time distribution is an output.
 */
import type { DecisionConsts, ExitChoice, LarvaView, NestChoice, PartnerView, SelfView, SiteView, SourceView } from './types.ts';

/** response threshold hill(s; θ, n) (mechanism: R234 etc., other species; form and values: game assumption) */
export const hill = (s: number, theta: number, n: number): number => (s <= 0 ? 0 : s ** n / (s ** n + theta ** n));

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
  // brood care feeds larvae from the worker's own crop: with an empty crop there is nothing to give
  const pb = self.crop > 0 ? self.gain * hill(self.begging_recent, self.theta_brood, c.hill_n) : 0;
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

/** Q2 candidate (Owner #188 / #193; default OFF): the part of its own crop a returning forager keeps for its OWN
 *  expected metabolic need until its next feeding opportunity, computed ONLY from its own state — its own metabolic
 *  rate and, for 'own_interval', the interval between its own last two intakes at a source (its own experience). No
 *  colony store, no nestmate, no larva is read. Mechanism direction only from R147 (Camponotus sanctus, other species:
 *  foragers do not hand over their whole crop); the 'hand over half' ratio is NOT used; formulations and values are
 *  game assumptions. null retention (reference) => 0. Unknown interval (no two own intakes yet) => 0 (not filled). */
export function ownReserve(self: SelfView, c: DecisionConsts): number {
  const r = c.retention;
  if (r === null) return 0;
  const need_ms = r.kind === 'horizon' ? r.need_ms : self.forage_interval_ms === null ? 0 : r.factor * self.forage_interval_ms;
  return Math.ceil((c.metabolic_rate_per_day * need_ms) / c.day_ms);
}

/** trophallaxis offered by a returning forager to one nestmate it touched (µP); with the Q2 candidate on, it never
 *  offers below its own reserve (ownReserve) */
export function decideTransfer(self: SelfView, partner: PartnerView, c: DecisionConsts): number {
  return Math.max(0, Math.min(c.transfer_max, self.crop - ownReserve(self, c), partner.crop_room));
}

/** feeding one larva the worker touched: only when the larva's begging (perceived at the contact) reaches the threshold */
export function decideFeedLarva(self: SelfView, larva: LarvaView, c: DecisionConsts): number {
  if (larva.begging < c.begging_threshold) return 0;
  return Math.max(0, Math.min(c.feed_bolus, self.crop, larva.room));
}
