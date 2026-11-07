/**
 * Worker decisions from LOCAL information only (CLAUDE.md §2.1): own crop fill, nestmates actually met,
 * larvae actually touched, own route memory. Nothing here may read the nest food ledger (stores);
 * tests/local-ecology.test.ts checks this file statically.
 */
import { clamp, round } from './math.ts';
import { dice } from './rng.ts';
import type { SpeciesParams } from './params.ts';
import type { ColonyState, SimEvent, Task, Weather, Worker, WorldState } from './types.ts';

export const TASKS: readonly Task[] = ['forage', 'nurse', 'rest', 'repair', 'guard'];

/** A colony-scoped random stream (namespace '' for the legacy main colony). */
export function colonyDice(world: { seed: number; sim_day: number }, colony: ColonyState, tag: string) {
  return dice(world, colony.rng_namespace + tag);
}

/** Low-temperature activity gate, linear between the species' cold limit and full-activity temperature. */
export function foragingTemperatureFactor(sp: SpeciesParams, airC: number): number {
  const f = sp.foraging_activity, minC = f.foraging_cold_limit_c, fullC = f.foraging_full_activity_c, floor = f.foraging_cold_min_multiplier;
  return round(clamp(floor + (1 - floor) * clamp((airC - minC) / (fullC - minC), 0, 1), floor, 1));
}

export interface LocalCues { sugarSatiety: number; peerSugarHunger: number; broodBegging: number; proteinFeedback: number }

export function localSignals(sp: SpeciesParams, worker: Worker): LocalCues {
  const c = worker.local_sensory || {}, d = sp.local_signals;
  return {
    sugarSatiety: clamp(c.own_crop_sugar_fill ?? d.default_own_crop_sugar_fill, 0, 1),
    peerSugarHunger: clamp(c.peer_sugar_hunger ?? d.default_peer_sugar_hunger, 0, 1),
    broodBegging: clamp(c.direct_brood_begging ?? d.default_direct_brood_begging, 0, 1),
    proteinFeedback: clamp(c.peer_protein_request ?? d.default_peer_protein_request, 0, 1),
  };
}

/** Rain suppression multiplier shared by task choice and collection success. */
export function rainActivity(sp: SpeciesParams, weather: Weather): number {
  return clamp(1 - weather.rain_mm * sp.foraging_activity.rain_suppression_fraction, sp.foraging_activity.min_rain_activity_multiplier, 1);
}

/** Weighted task lottery, then ONE cold-weather activity gate for foragers (v6 order of draws). */
export function selectTask(world: WorldState, colony: ColonyState, sp: SpeciesParams, worker: Worker, weather: Weather): Task {
  const t = sp.task_allocation;
  const g = colonyDice(world, colony, 'task:' + worker.id), age = worker.age_days, v = localSignals(sp, worker);
  const injured = worker.injured ? t.injured_task_forage_multiplier : 1, young = age < t.newborn_nurse_days;
  const hunger = clamp((1 - v.sugarSatiety) * t.hunger_own_crop_weight + v.peerSugarHunger * t.hunger_peer_weight, 0, 1);
  const forageBias = t.forage_baseline_probability * (1 + t.hunger_forage_boost * hunger) * injured * (young ? t.newborn_forage_multiplier : 1) * rainActivity(sp, weather);
  const care = t.nurse_baseline_probability * (1 + t.brood_begging_nurse_boost * v.broodBegging) * (young ? t.newborn_nurse_multiplier : 1),
    rest = t.rest_baseline_probability * (worker.injured ? t.injured_rest_multiplier : 1),
    repair = t.maintenance_baseline_probability * (1 + t.soil_wetness_repair_boost * weather.soil_index),
    guard = t.defence_baseline_probability;
  const entries: [Task, number][] = [['forage', forageBias], ['nurse', care], ['rest', rest], ['repair', repair], ['guard', guard]];
  const total = entries.reduce((x, a) => x + a[1], 0);
  let roll = g() * total;
  for (const [task, weight] of entries) {
    roll -= weight;
    if (roll <= 0) return task === 'forage' && g() >= foragingTemperatureFactor(sp, weather.daytime_air_temp_c) ? 'rest' : task;
  }
  return 'rest';
}

/** In-nest encounters: each worker at the nest may meet ONE random nestmate and update its impressions. */
export function nestContacts(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[]): void {
  const workers = colony.population.workers, ls = sp.local_signals;
  for (const worker of workers) {
    const g = colonyDice(world, colony, 'nest_contact:' + worker.id);
    const peers = worker.last_location === colony.nest_node ? workers.filter((w) => w.id !== worker.id && w.last_location === colony.nest_node) : [];
    if (peers.length && g() < ls.local_peer_contact_probability) {
      const peer = peers[Math.floor(g() * peers.length)], mem = (worker.local_sensory ??= {}), ret = ls.local_signal_smoothing;
      mem.peer_sugar_hunger = round(ret * (mem.peer_sugar_hunger ?? ls.default_peer_sugar_hunger) + (1 - ret) * (1 - localSignals(sp, peer).sugarSatiety));
      mem.peer_protein_request = round(ret * (mem.peer_protein_request ?? ls.default_peer_protein_request) + (1 - ret) * (peer.local_sensory?.direct_brood_begging || ls.default_direct_brood_begging));
      events.push({ type: 'local_contact_cue', worker: worker.id, peer: peer.id, peer_crop_fill: round(localSignals(sp, peer).sugarSatiety), assumption: true });
    }
  }
}

/**
 * The brood chamber: the one in-nest place where larvae lie (C4a gives each larva a `location`; a larva without one — before
 * C4a, or C4a off — is treated as lying here).
 */
export const BROOD_PLACE = 'brood';

/**
 * Nurses physically touch one larva and carry away only that larva's begging signal.
 * v2-review.31 (local_signals.nurse_cue_same_place_v31, CLAUDE.md §2.1): with the switch on a nurse can touch only larvae at
 * its own place — it must be in the nest (last_location === nest_node), and only larvae in the brood chamber (BROOD_PLACE, the
 * one in-nest place today) can be drawn; a nurse elsewhere touches no larva. Same stream and same ID-ordered draw, so when every
 * larva is in the brood chamber and the nurse is in the nest the result equals the switch-off draw bit for bit.
 */
export function nurseContact(world: WorldState, colony: ColonyState, sp: SpeciesParams, worker: Worker, events: SimEvent[]): void {
  const samePlace = sp.local_signals.nurse_cue_same_place_v31, inNest = worker.last_location === colony.nest_node;
  const larvae = colony.population.brood.filter((b) => b.stage === 'larva' && (!samePlace || (inNest && (b.location ?? BROOD_PLACE) === BROOD_PLACE))), g = colonyDice(world, colony, 'nurse_contact:' + worker.id);
  // v2-review.21 (Issue #50): the uniform draw picks among the larvae in id order, so WHICH larva a draw reaches does not
  // depend on where the larvae sit in the stored brood array (v2-review.20 indexed the array as stored).
  if (sp.brood_care.daily_care_snapshot_v21) larvae.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  if (larvae.length && g() < sp.local_signals.nurse_larva_contact_probability) {
    const brood = larvae[Math.floor(g() * larvae.length)];
    worker.local_sensory ??= {};
    worker.local_sensory.direct_brood_begging = round(brood.begging_signal ?? sp.local_signals.default_larva_begging_contact_signal);
    events.push({ type: 'local_brood_begging_contact', worker: worker.id, larva: brood.id, signal: brood.begging_signal ?? sp.local_signals.default_larva_begging_contact_signal, ...(samePlace ? { worker_location: worker.last_location, larva_location: brood.location ?? BROOD_PLACE } : {}) });
  }
}
