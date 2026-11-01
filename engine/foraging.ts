/**
 * Foraging of one colony: scouting, site choice from personal memory, physical travel, collection at
 * the site, group predation on tracked live insects, return, unloading, trail marking and local
 * recruitment. Workers never read the nest food ledger here (checked by tests/local-ecology.test.ts);
 * delivering food goes through nutrition.handoff().
 */
import { clamp, round } from './math.ts';
import type { Rng } from './rng.ts';
import { goHome, routeTo, travel, type Trip } from './routes.ts';
import { decayTrails, depositTrail, followLocalTrail, fullTrail } from './trails.ts';
import { sourceSum, syncSource } from './ecology.ts';
import { handoff } from './nutrition.ts';
import { colonyDice, localSignals, nestContacts, nurseContact, rainActivity, selectTask } from './workers.ts';
import type { SpeciesParams, WorldParams } from './params.ts';
import type { ColonyState, ColonySummary, Macro, SimEvent, Source, Weather, Worker, WorldState } from './types.ts';

const knowledge = (colony: ColonyState, id: string) => colony.source_knowledge[id];
const macroOf = (src: Source): Macro => (src.type === 'carcass' ? 'protein' : 'sugar');

/** A worker whose own routes are unproductive may scout ONE unknown site adjacent to a site it knows. */
function discover(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, events: SimEvent[]): string | null {
  const g = colonyDice(world, colony, 'scout:' + worker.id);
  const options = Object.values(world.sources).filter((src) => knowledge(colony, src.id)?.presence === 'potential' && !worker.known_sources.includes(src.id) && Array.isArray(src.access_from) && src.access_from.some((id) => worker.known_sources.includes(id)));
  if (!options.length || g() >= sp.scouting.scout_discovery_probability) return null;
  const site = options[Math.floor(g() * options.length)], route = routeTo(wp, colony.nest_node, site.id);
  if (!route) return null;
  const trip = travel(sp, wp, worker, route, events, 'scout');
  if (!trip) return null;
  events.push({ type: 'physical_scout_visit', worker: worker.id, site: site.id, via: (site.access_from as string[]).find((id) => worker.known_sources.includes(id)), route, arrival_minute: trip.arrive, assumption: true });
  goHome(wp, worker, route, events, 'scout_return', trip.arrive);
  const k = knowledge(colony, site.id);
  worker.known_sources.push(site.id); k.known_by.push(worker.id);
  if (site.host_alive === true) { k.presence = 'confirmed_game_scenario'; events.push({ type: 'discovery', worker: worker.id, site: site.id, food_kind: site.type, assumption: true }); }
  else { k.presence = 'scouted_empty'; events.push({ type: 'scouted_empty', worker: worker.id, site: site.id, assumption: true }); }
  return site.id;
}

/**
 * Capture of a TRACKED living insect at the site. Large prey needs at least
 * predation.large_prey_min_team workers physically at the same node. Removes one insect from the world
 * population and creates a carcass batch with a causal ID.
 */
export function prey(world: WorldState, sp: SpeciesParams, wp: WorldParams, site: Source, worker: Worker, siteTeam: Worker[], g: Rng, events: SimEvent[]): boolean {
  const pop = world.ecology.insects_by_site[site.id];
  if (!pop || pop.living < 1 || g() >= sp.predation.live_prey_encounter_probability) return false;
  const large = g() < wp.prey.large_prey_fraction;
  const team = [...new Set(siteTeam.filter((w) => w.last_location === site.id).map((w) => w.id))];
  if (worker.last_location !== site.id) throw Error('NO_GOD_MODE: prey hunter not at prey site');
  if (!team.includes(worker.id)) team.unshift(worker.id);
  events.push({ type: 'live_prey_encounter', site: site.id, worker: worker.id, prey_size: large ? 'large' : 'small', co_located_team: team, assumption: true });
  if (large && team.length < sp.predation.large_prey_min_team) {
    events.push({ type: 'local_alarm_signal', site: site.id, worker: worker.id, assumption: true });
    events.push({ type: 'prey_escaped', site: site.id, reason: 'insufficient_local_team', assumption: true });
    return false;
  }
  if (g() > sp.predation.live_prey_capture_probability) { events.push({ type: 'prey_escaped', site: site.id, reason: 'failed_capture', assumption: true }); return false; }
  pop.living--; pop.cumulative_deaths++;
  const quantity = large ? wp.prey.large_prey_protein : wp.prey.small_prey_protein, id = 'HUNT-D' + (world.sim_day + 1) + '-' + site.id + '-' + pop.cumulative_deaths;
  site.batches.push({ event_id: id, original_day: world.sim_day + 1, protein: quantity, age_days: 0, origin: 'captured existing tracked insect; prey-size assumption' });
  site.protein = round(site.batches.reduce((a, b) => a + b.protein, 0));
  events.push({ type: 'insect_predation', site: site.id, event_id: id, team, size: large ? 'large' : 'small', count_after: pop.living, assumption: true });
  events.push({ type: 'new_food_source', id, site: site.id, protein_portions: quantity, caused_by_event_id: id, causal_basis: 'tracked live insect predation', assumption: true });
  return true;
}

/** Collection at the site the worker physically reached. Returns the crop/mandible load or null. */
function collect(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, source: Source, worker: Worker, weather: Weather, events: SimEvent[], onsite: Worker[]): { macro: Macro; load: number } | null {
  const fh = sp.food_handling;
  const g = colonyDice(world, colony, 'collect:' + worker.id + ':' + source.id);
  const rain = rainActivity(sp, weather);
  if (source.type === 'carcass' && sourceSum(source) <= 1e-5) prey(world, sp, wp, source, worker, onsite, g, events);
  const presence = knowledge(colony, source.id)?.presence;
  if (presence === 'scouted_empty' || presence === 'potential' || sourceSum(source) <= 1e-5 || g() > rain * (source.type === 'carcass' ? fh.carcass_access_probability : fh.liquid_collection_probability)) return null;
  const macro = macroOf(source), min = fh[`crop_load_${macro}_min`], max = fh[`crop_load_${macro}_max`];
  const freeRoom = macro === 'sugar' ? Math.max(0, sp.trophallaxis.crop_capacity - (worker.crop_cargo_sugar || 0)) : Infinity;
  const load = round(Math.min(sourceSum(source), min + (max - min) * g(), freeRoom));
  if (load <= 0) return null;
  if (macro === 'sugar') source.sugar = round(source.sugar - load);
  else {
    let needed = load;
    for (const batch of source.batches) {
      const take = Math.min(batch.protein, needed);
      batch.protein = round(batch.protein - take); needed = round(needed - take);
      if (take > 0) events.push({ type: 'source_batch_consumed', source_event_id: batch.event_id, location: source.id, worker: worker.id, quantity_portions: round(take) });
      if (needed <= 1e-6) break;
    }
    syncSource(source);
  }
  events.push({ type: 'food_collected', worker: worker.id, site: source.id, macro, portions: load, location: source.id, assumption: true });
  return { macro, load };
}

interface Plan { worker: Worker; source: Source; route: string[]; trip: Trip; g: Rng }

/** Choose a destination from the worker's OWN known sources and memories; otherwise scout or follow trails. */
function planTrip(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, events: SimEvent[], summary: ColonySummary): Plan | null {
  const sc = sp.site_choice;
  const g = colonyDice(world, colony, 'target:' + worker.id); worker.site_memory ??= {};
  const memory = worker.site_memory;
  const knownList = () => worker.known_sources.map((id) => world.sources[id]).filter((src) => src && knowledge(colony, src.id)?.presence !== 'scouted_empty');
  let known = knownList();
  const best = Math.max(0, ...known.map((src) => memory[src.id]?.last_success_portions ?? 0));
  if (!known.length || (best < sp.scouting.unproductive_route_threshold_portions && g() < sp.scouting.scout_search_when_route_unproductive_probability)) {
    discover(world, colony, sp, wp, worker, events); known = knownList();
  }
  let chosen: { source: Source; route?: string[] } | null = null;
  if (known.length) {
    const cues = localSignals(sp, worker), need = clamp((1 - cues.sugarSatiety) * sc.need_own_crop_weight + cues.peerSugarHunger * sc.need_peer_weight, 0, 1);
    const ranks = known.map((site) => {
      const macro = macroOf(site), prior = memory[site.id]?.last_success_portions ?? sc.default_prior_success_portions;
      const age = memory[site.id]?.last_visit_day ?? (world.sim_day - sc.default_last_visit_days_ago), penalty = prior === 0 && world.sim_day - age < sc.recent_failure_window_days ? sc.recent_failure_penalty : 1;
      const unload = worker.local_sensory?.unload_feedback?.[macro] ?? sp.local_signals.unload_feedback_default;
      const bias = macro === 'sugar' ? 1 + sc.sugar_hunger_priority_weight * need : 1 + sc.protein_begging_priority_weight * clamp(cues.broodBegging * sc.brood_begging_protein_weight + cues.proteinFeedback * sc.peer_protein_feedback_weight, 0, 1);
      return { site, score: (sc.score_base_offset + prior) * penalty * bias * (sc.unloading_memory_base + sc.unloading_success_memory_weight * unload) };
    }).sort((a, b) => b.score - a.score);
    chosen = { source: ranks[g() < sc.best_site_choice_probability ? 0 : Math.min(1, ranks.length - 1)].site };
  } else chosen = followLocalTrail(world, colony, sp, wp, worker, g, events);
  if (!chosen) { summary.scouts++; return null; }
  const route = chosen.route || routeTo(wp, colony.nest_node, chosen.source.id);
  if (!route) { summary.scouts++; return null; }
  const trip = travel(sp, wp, worker, route, events, 'foraging_depart');
  if (!trip) { events.push({ type: 'route_timeout', worker: worker.id, site: chosen.source.id, assumption: true }); return null; }
  // Hidden source viability becomes known ONLY AFTER the worker physically arrives.
  const k = knowledge(colony, chosen.source.id);
  if (k.presence === 'potential') {
    k.presence = chosen.source.host_alive ? 'confirmed_game_scenario' : 'scouted_empty';
    events.push(chosen.source.host_alive ? { type: 'discovery', worker: worker.id, site: chosen.source.id, food_kind: chosen.source.type, assumption: true } : { type: 'scouted_empty', worker: worker.id, site: chosen.source.id, assumption: true });
  }
  if (!worker.known_sources.includes(chosen.source.id)) worker.known_sources.push(chosen.source.id);
  if (!k.known_by.includes(worker.id)) k.known_by.push(worker.id);
  return { worker, source: chosen.source, route, trip, g };
}

/** One colony's whole foraging day. Mutates world sources/insects (collection, predation) and the colony. */
export function forageDay(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, weather: Weather, events: SimEvent[], summary: ColonySummary): void {
  const ft = sp.foraging_trips, rc = sp.recruitment, ls = sp.local_signals, nest = colony.nest_node;
  const tripCost = () => { summary.foraging_trips++; summary.extra_sugar_cost = round(summary.extra_sugar_cost + ft.foraging_trip_sugar_cost); };
  const byMacro = summary.foraging_workers_by_macro as { sugar: Set<string>; protein: Set<string> };
  decayTrails(colony, sp, events);
  nestContacts(world, colony, sp, events);
  const foragers: Worker[] = [];
  for (const worker of colony.population.workers) {
    worker.task = selectTask(world, colony, sp, worker, weather); worker.age_days++;
    summary.tasks[worker.task as keyof typeof summary.tasks] = (summary.tasks[worker.task as keyof typeof summary.tasks] || 0) + 1;
    if (worker.task === 'nurse') nurseContact(world, colony, sp, worker, events);
    if (worker.task === 'forage' && worker.last_location === nest) foragers.push(worker);
  }
  // Plan all departures first and move every forager to its site BEFORE any group capture, so prey
  // teams form ONLY from independent workers who actually reached the same node.
  const plans: Plan[] = [];
  for (const worker of foragers) { const plan = planTrip(world, colony, sp, wp, worker, events, summary); if (plan) plans.push(plan); }

  const unload = (worker: Worker, source: Source, route: string[], found: { macro: Macro; load: number }, g: Rng) => {
    const transfer = handoff(colony, sp, worker, found.macro, found.load, events, g, source.id);
    summary.income[found.macro] = round(summary.income[found.macro] + found.load); summary.foraging_successes++;
    worker.local_sensory ??= {}; worker.local_sensory.unload_feedback ??= { sugar: ls.unload_feedback_default, protein: ls.unload_feedback_default };
    const ease = clamp(ls.unload_ease_base + ls.unload_ease_contact_weight * (transfer.count / Math.max(1, sp.trophallaxis.max_trophallaxis_contacts)), 0, 1);
    worker.local_sensory.unload_feedback[found.macro] = round(ls.unload_feedback_previous_weight * worker.local_sensory.unload_feedback[found.macro] + ls.unload_feedback_today_weight * ease);
    worker.local_sensory.last_food_kind = found.macro; worker.local_sensory.last_unloading_ease = round(ease);
    events.push({ type: 'local_unloading_feedback', worker: worker.id, site: source.id, macro: found.macro, encountered_nestmates: transfer.count, ease: round(ease), assumption: true });
    depositTrail(colony, sp, route, worker, events);
  };

  for (const plan of plans) {
    const { worker, source, route, trip, g } = plan;
    if (worker.last_location !== source.id) continue;
    const nearby = plans.filter((q) => q.source.id === source.id && q.worker.last_location === source.id).map((q) => q.worker);
    tripCost();
    const found = collect(world, colony, sp, wp, source, worker, weather, events, nearby);
    byMacro[macroOf(source)].add(worker.id);
    (worker.site_memory as Record<string, { last_success_portions: number; last_visit_day: number }>)[source.id] = { last_success_portions: found?.load || 0, last_visit_day: world.sim_day + 1 };
    goHome(wp, worker, route, events, 'foraging_return', trip.arrive);
    if (!found) continue;
    unload(worker, source, route, found, g);
    // Optional repeated trip with explicit travel time, never free instantaneous collection.
    let finalReturn = trip.back;
    if (g() < ft.repeat_trip_probability && ft.max_trips_per_forager >= 2) {
      const again = travel(sp, wp, worker, route, events, 'repeat_depart', trip.back);
      if (again) {
        finalReturn = again.back; tripCost();
        const more = collect(world, colony, sp, wp, source, worker, weather, events, [worker]);
        (worker.site_memory as Record<string, { last_success_portions: number; last_visit_day: number }>)[source.id] = { last_success_portions: more?.load || 0, last_visit_day: world.sim_day + 1 };
        goHome(wp, worker, route, events, 'repeat_return', again.arrive);
        if (more) unload(worker, source, route, more, g);
      }
    }
    // Local recruitment: only idle nestmates physically at the nest, along a still-detectable trail.
    if (g() < rc.recruitment_probability && fullTrail(colony, sp, route)) {
      const possible = colony.population.workers.filter((w) => w.id !== worker.id && w.last_location === nest && w.task !== 'forage' && w.task !== 'guard' && !w.recruited_today && w.age_days >= sp.task_allocation.newborn_nurse_days);
      const n = possible.length ? 1 + Math.floor(g() * Math.min(possible.length, rc.recruitment_max_followers)) : 0;
      for (let i = 0; i < n; i++) {
        const follower = possible.splice(Math.floor(g() * possible.length), 1)[0];
        if (!follower) break;
        const follow = travel(sp, wp, follower, route, events, 'recruit_follow_trail', finalReturn);
        if (!follow) continue;
        follower.recruited_today = true; summary.tasks[follower.task as keyof typeof summary.tasks]--; follower.task = 'forage'; summary.tasks.forage++; summary.recruited++; tripCost();
        events.push({ type: 'local_recruitment', by: worker.id, to: follower.id, site: source.id, physical_route: route, signal_dependent: true, assumption: true });
        const k = knowledge(colony, source.id);
        if (!follower.known_sources.includes(source.id)) follower.known_sources.push(source.id);
        if (!k.known_by.includes(follower.id)) k.known_by.push(follower.id);
        const cargo = collect(world, colony, sp, wp, source, follower, weather, events, [follower]);
        byMacro[macroOf(source)].add(follower.id);
        follower.site_memory ??= {}; follower.site_memory[source.id] = { last_success_portions: cargo?.load || 0, last_visit_day: world.sim_day + 1 };
        goHome(wp, follower, route, events, 'recruit_return', follow.arrive);
        if (cargo) unload(follower, source, route, cargo, g);
      }
    }
  }
  for (const w of colony.population.workers) delete w.recruited_today;
}
