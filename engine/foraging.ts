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
import { ensureRouteMemory, knownEmpty, knownNodes, knownRoute, learnRoute, markEmpty, unknownExits } from './navigation.ts';
import { sourceSum, syncSource } from './ecology.ts';
import { handoff } from './nutrition.ts';
import { colonyDice, localSignals, nestContacts, nurseContact, rainActivity, selectTask } from './workers.ts';
import type { SpeciesParams, WorldParams } from './params.ts';
import type { ColonyState, ColonySummary, Macro, SimEvent, Source, Weather, Worker, WorldState } from './types.ts';

const knowledge = (colony: ColonyState, id: string) => colony.source_knowledge[id];
const macroOf = (src: Source): Macro => (src.type === 'carcass' ? 'protein' : 'sugar');

/**
 * A physical outbound walk. With v2-review.14 route memory on (`day` given) the worker learns every edge it has
 * just walked; otherwise this is exactly routes.travel().
 */
function walkRoute(sp: SpeciesParams, wp: WorldParams, worker: Worker, route: string[], events: SimEvent[], kind: string, offset: number, day: number | undefined): Trip | null {
  const trip = travel(sp, wp, worker, route, events, kind, offset);
  if (trip && day !== undefined) learnRoute(worker, route, kind, day);
  return trip;
}

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
function collect(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, source: Source, worker: Worker, weather: Weather, events: SimEvent[], onsite: Worker[] | null): { macro: Macro; load: number } | null {
  const fh = sp.food_handling;
  const g = colonyDice(world, colony, 'collect:' + worker.id + ':' + source.id);
  const rain = rainActivity(sp, weather);
  // Legacy sequential model only (onsite !== null); v2-review.9 hunts in huntWindow() before collection.
  if (onsite && source.type === 'carcass' && sourceSum(source) <= 1e-5) prey(world, sp, wp, source, worker, onsite, g, events);
  const presence = knowledge(colony, source.id)?.presence;
  if (presence === 'scouted_empty' || presence === 'potential' || sourceSum(source) <= 1e-5 || g() > rain * (source.type === 'carcass' ? fh.carcass_access_probability : fh.liquid_collection_probability)) return null;
  const macro = macroOf(source), min = fh[`crop_load_${macro}_min`], max = fh[`crop_load_${macro}_max`];
  const freeRoom = macro === 'sugar' ? Math.max(0, sp.trophallaxis.crop_capacity - (worker.crop_cargo_sugar || 0)) : Infinity;
  const load = round(Math.min(sourceSum(source), min + (max - min) * g(), freeRoom));
  if (load <= 0) return null;
  if (macro === 'sugar') source.sugar = round(source.sugar - load);
  else takeProtein(source, worker, load, events);
  events.push({ type: 'food_collected', worker: worker.id, site: source.id, macro, portions: load, location: source.id, assumption: true });
  return { macro, load };
}

/** Remove `load` protein portions from the site's batches in order, recording each batch it came from. */
function takeProtein(source: Source, worker: Worker, load: number, events: SimEvent[]): void {
  let needed = load;
  for (const batch of source.batches) {
    const take = Math.min(batch.protein, needed);
    batch.protein = round(batch.protein - take); needed = round(needed - take);
    if (take > 0) events.push({ type: 'source_batch_consumed', source_event_id: batch.event_id, location: source.id, worker: worker.id, quantity_portions: round(take) });
    if (needed <= 1e-6) break;
  }
  syncSource(source);
}

// ---------------------------------------------------------------------------------------------------
// v2-review.9 (#10): simultaneous site-window hunting (species switch predation.simultaneous_site_group_hunting).
// Mechanism directions from Dejean et al. 2007 (R98/R107, this species): a lone minor captures and retrieves
// small prey; for large prey the finder recruits nestmates within short range by alarm pheromone within
// seconds, the team spread-eagles the prey (each worker holds one appendage, so one hunt per worker at a
// time), the finder can also lay a trail back to the nest (long-range recruitment), and 2-10 workers retrieve
// the prey together. All numbers are game assumptions (see species predation.*).
// ---------------------------------------------------------------------------------------------------

/** A worker physically arriving at a site at one minute of the day. */
export interface Arrival { worker: Worker; route: string[]; arrive: number }
/** What one hunt participant ends up carrying, and the minute it leaves the site for the nest. */
export interface Carry { worker: Worker; route: string[]; load: number; home: number; recruited: boolean; event_id: string | null; led_by: string | null; walked_home?: boolean; waiting?: WaitingPrey }

/** One large-prey hunt in progress (v2-review.11). */
interface HuntState { finder: Arrival; g: Rng; large: boolean; minute: number; team: Arrival[]; recruits: Arrival[]; longRange: boolean; resolveAt: number; finderAtNest?: boolean }
/**
 * v2-review.11: a large prey whose finder went home to recruit. It stays at the site until the recruits arrive
 * (resolveAt); empty-handed workers arriving there by then join it (up to the team cap) and the hunt is
 * concluded with all of them when the recruits arrive. (With one nest and every route walked edge by edge,
 * other workers can reach the site only at that same minute, never in between.)
 */
export interface WaitingPrey { site: string; state: HuntState; joiners: Arrival[]; deferred: unknown[] }

export interface HuntContext {
  world: WorldState; colony: ColonyState; sp: SpeciesParams; wp: WorldParams; events: SimEvent[]; summary: ColonySummary;
  tripCost: () => void; byMacro: { sugar: Set<string>; protein: Set<string> };
  /** v2-review.11: living insects already being hunted by a waiting team, per site (not available to other hunts). */
  reserved?: Record<string, number>;
  /** v2-review.14: game day used to record walked edges in route memory (undefined = route memory off). */
  learnDay?: number;
}

/** Hunting is possible only at a carcass site whose carcass is empty on arrival and that holds living tracked insects. */
export const huntable = (world: WorldState, source: Source, reserved = 0): boolean => {
  const pop = world.ecology.insects_by_site[source.id];
  return source.type === 'carcass' && sourceSum(source) <= 1e-5 && !!pop && pop.living - reserved >= 1;
};
const byId = (a: Arrival, b: Arrival) => (a.worker.id < b.worker.id ? -1 : a.worker.id > b.worker.id ? 1 : 0);

/**
 * Finish a hunt at minute `at`: escape while recruiting (long-range hunts only), team check, capture, joint
 * retrieval. `joiners` arrived later at the waiting prey and take part like the rest of the team
 * (v2-review.11). Every member gets a Carry in `engaged`.
 */
function concludeHunt(ctx: HuntContext, source: Source, st: HuntState, at: number, joiners: Arrival[], engaged: Map<string, Carry>): void {
  const { world, sp, wp, events } = ctx, pr = sp.predation, { finder, g, large, recruits } = st;
  // A finder that found no idle nestmates stays at the nest (v2-review.11 waiting prey only).
  const all = [...st.team, ...joiners], present = st.finderAtNest ? all.filter((m) => m !== finder) : all;
  const escape = (reason: string) => events.push({ type: 'prey_escaped', site: source.id, worker: finder.worker.id, minute: at, reason, participants: present.map((m) => m.worker.id), assumption: true });
  const lock = (load: (a: Arrival) => number, eventId: string | null) => {
    for (const m of all) engaged.set(m.worker.id, { worker: m.worker, route: m.route, load: load(m), home: at, recruited: recruits.includes(m), event_id: eventId, led_by: recruits.includes(m) ? finder.worker.id : null });
    if (st.finderAtNest) Object.assign(engaged.get(finder.worker.id) as Carry, { walked_home: true, home: st.minute });
  };
  if (st.longRange) {
    if (g() < pr.large_prey_escape_while_recruiting_probability) { escape('escaped_while_recruiting'); lock(() => 0, null); return; }
    if (present.length < pr.large_prey_min_team) { escape(st.finderAtNest ? 'insufficient_team_no_recruits' : 'insufficient_team_after_recruitment'); lock(() => 0, null); return; }
  }
  if (g() > pr.live_prey_capture_probability) { escape('failed_capture'); lock(() => 0, null); return; }
  const pop = world.ecology.insects_by_site[source.id];
  pop.living--; pop.cumulative_deaths++;
  const quantity = large ? wp.prey.large_prey_protein : wp.prey.small_prey_protein, id = 'HUNT-D' + (world.sim_day + 1) + '-' + source.id + '-' + pop.cumulative_deaths;
  source.batches.push({ event_id: id, original_day: world.sim_day + 1, protein: quantity, age_days: 0, origin: 'captured existing tracked insect; prey-size assumption' });
  source.protein = round(source.batches.reduce((a, b) => a + b.protein, 0));
  events.push({ type: 'insect_predation', site: source.id, event_id: id, team: present.map((m) => m.worker.id), minute: at, size: large ? 'large' : 'small', count_after: pop.living, assumption: true });
  events.push({ type: 'new_food_source', id, site: source.id, protein_portions: quantity, caused_by_event_id: id, causal_basis: 'tracked live insect predation', assumption: true });
  // Joint retrieval: the whole prey is carried home by the team, shared equally (mass conserved exactly).
  const share = round(quantity / present.length), shares = new Map(present.map((m, i) => [m, i === present.length - 1 ? round(quantity - share * (present.length - 1)) : share]));
  for (const m of present) {
    takeProtein(source, m.worker, shares.get(m) as number, events);
    events.push({ type: 'food_collected', worker: m.worker.id, site: source.id, macro: 'protein', portions: shares.get(m), location: source.id, minute: at, prey_event_id: id, assumption: true });
  }
  events.push({ type: 'joint_prey_transport', site: source.id, event_id: id, minute: at, carriers: present.map((m) => ({ worker: m.worker.id, portions: shares.get(m) })), assumption: true });
  lock((m) => shares.get(m) ?? 0, id);
}

/**
 * One hunting window: every worker in `arrivals` reached `source` at the same minute (the engine's time
 * step is one route edge, far longer than the seconds-scale short-range recruitment), so they are present
 * together. Result does NOT depend on the order of `arrivals`. Each worker takes part in at most one hunt
 * per window (participation lock). Returns every participant, including long-range recruits (recruited:true),
 * who still have to walk home; workers not in the result did not hunt and collect normally.
 */
export function huntWindow(ctx: HuntContext, source: Source, arrivals: Arrival[], waiting?: WaitingPrey[]): Map<string, Carry> {
  const { world, colony, sp, wp, events, summary } = ctx, pr = sp.predation, nest = colony.nest_node;
  const engaged = new Map<string, Carry>();
  if (!arrivals.length) return engaged;
  const minute = arrivals[0].arrive;
  if (arrivals.some((a) => a.arrive !== minute || a.worker.last_location !== source.id || a.route.at(-1) !== source.id)) throw Error('NO_GOD_MODE: hunt window members must be at the site at the same minute');
  const members = [...arrivals].sort(byId);
  for (const finder of members) {
    if (engaged.has(finder.worker.id) || !huntable(world, source, ctx.reserved?.[source.id] ?? 0)) continue;
    const g = colonyDice(world, colony, 'hunt:' + finder.worker.id + ':' + source.id + ':' + minute);
    if (g() >= pr.live_prey_encounter_probability) continue;
    const large = g() < wp.prey.large_prey_fraction;
    const free = members.filter((m) => !engaged.has(m.worker.id));
    // Short-range recruitment: unengaged nestmates at the site in this window join a large-prey hunt, up to
    // predation.large_prey_max_team (v2-review.10: space around the prey limits the team). When more are
    // available, joiners are drawn at random; the others stay free to find prey of their own.
    let team: Arrival[] = [finder];
    if (large) {
      const others = free.filter((m) => m !== finder), room = pr.large_prey_max_team - 1;
      if (others.length <= room) team.push(...others);
      else for (let i = 0; i < room; i++) team.push(others.splice(Math.floor(g() * others.length), 1)[0]);
    }
    events.push({ type: 'live_prey_encounter', site: source.id, worker: finder.worker.id, minute, prey_size: large ? 'large' : 'small', co_located_team: free.map((m) => m.worker.id), assumption: true });
    let resolve = minute;
    const recruits: Arrival[] = [];
    const escape = (reason: string) => events.push({ type: 'prey_escaped', site: source.id, worker: finder.worker.id, minute: resolve, reason, participants: team.map((m) => m.worker.id), assumption: true });
    const lock = (load: (a: Arrival) => number, eventId: string | null) => {
      for (const m of team) engaged.set(m.worker.id, { worker: m.worker, route: m.route, load: load(m), home: resolve, recruited: recruits.includes(m), event_id: eventId, led_by: recruits.includes(m) ? finder.worker.id : null });
    };
    if (large && team.length < pr.large_prey_min_team) {
      events.push({ type: 'local_alarm_signal', site: source.id, worker: finder.worker.id, minute, short_range_joiners: team.slice(1).map((m) => m.worker.id), assumption: true });
      // Long-range recruitment: the finder walks home laying a trail and leads idle nestmates back; the prey
      // is unattended (or held by too few short-range joiners) meanwhile.
      const one = (finder.route.length - 1) * wp.routes.route_edge_minutes;
      if (minute + 3 * one > sp.foraging_activity.daily_window_minutes) { escape('insufficient_team_no_time_to_recruit'); lock(() => 0, null); continue; }
      goHome(wp, finder.worker, finder.route, events, 'hunt_recruit_trail_home', minute);
      depositTrail(colony, sp, finder.route, finder.worker, events);
      events.push({ type: 'long_range_recruitment_trail', worker: finder.worker.id, site: source.id, minute: minute + one, physical_route: finder.route, assumption: true });
      // Candidate followers in id order, so the result does not depend on how the population list is stored.
      const pool = colony.population.workers.filter((w) => w.last_location === nest && w.task !== 'forage' && w.task !== 'guard' && !w.recruited_today && w.age_days >= sp.task_allocation.newborn_nurse_days).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const n = Math.min(pool.length ? 1 + Math.floor(g() * Math.min(pool.length, sp.recruitment.recruitment_max_followers)) : 0, pr.large_prey_max_team - team.length);
      resolve = minute + 2 * one;
      if (!n && waiting) {
        // v2-review.11: no idle nestmate came; the finder stays at the nest but the prey still waits with any
        // short-range holders until the recruits would have arrived, and late arrivals can still join it.
        const w: WaitingPrey = { site: source.id, state: { finder, g, large, minute, team, recruits, longRange: true, resolveAt: resolve, finderAtNest: true }, joiners: [], deferred: [] };
        waiting.push(w);
        if (ctx.reserved) ctx.reserved[source.id] = (ctx.reserved[source.id] ?? 0) + 1;
        for (const m of team) engaged.set(m.worker.id, { worker: m.worker, route: m.route, load: 0, home: resolve, recruited: false, event_id: null, led_by: null, waiting: w });
        continue;
      }
      if (!n) { escape('insufficient_team_no_recruits'); lock(() => 0, null); Object.assign(engaged.get(finder.worker.id) as Carry, { walked_home: true, home: minute }); continue; }
      walkRoute(sp, wp, finder.worker, finder.route, events, 'hunt_recruit_lead', minute + one, ctx.learnDay);
      ctx.tripCost();
      for (let i = 0; i < n; i++) {
        const follower = pool.splice(Math.floor(g() * pool.length), 1)[0];
        if (!follower) break;
        if (!walkRoute(sp, wp, follower, finder.route, events, 'hunt_recruit_follow_trail', minute + one, ctx.learnDay)) continue;
        follower.recruited_today = true; summary.tasks[follower.task as keyof typeof summary.tasks]--; follower.task = 'forage'; summary.tasks.forage++; summary.recruited++; ctx.tripCost();
        events.push({ type: 'hunt_recruitment', by: finder.worker.id, to: follower.id, site: source.id, minute: minute + one, physical_route: finder.route, signal_dependent: true, assumption: true });
        const k = knowledge(colony, source.id);
        if (!follower.known_sources.includes(source.id)) follower.known_sources.push(source.id);
        if (!k.known_by.includes(follower.id)) k.known_by.push(follower.id);
        recruits.push({ worker: follower, route: finder.route, arrive: resolve });
      }
      team = [...team, ...recruits];
      const state: HuntState = { finder, g, large, minute, team, recruits, longRange: true, resolveAt: resolve };
      if (waiting) {
        // v2-review.11: the prey waits at the site; the hunt is concluded later on the carcass-trip clock.
        const w: WaitingPrey = { site: source.id, state, joiners: [], deferred: [] };
        waiting.push(w);
        if (ctx.reserved) ctx.reserved[source.id] = (ctx.reserved[source.id] ?? 0) + 1;
        for (const m of team) engaged.set(m.worker.id, { worker: m.worker, route: m.route, load: 0, home: resolve, recruited: recruits.includes(m), event_id: null, led_by: recruits.includes(m) ? finder.worker.id : null, waiting: w });
        continue;
      }
      concludeHunt(ctx, source, state, resolve, [], engaged);
      continue;
    }
    concludeHunt(ctx, source, { finder, g, large, minute, team, recruits, longRange: false, resolveAt: minute }, minute, [], engaged);
  }
  return engaged;
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

/**
 * v2-review.14 exploration: the worker walks a route it knows to one node it knows (possibly the nest), perceives
 * the edges leaving that node, takes one it has never walked, and perceives what is at the far end. It cannot
 * see further than that node. Exploring takes real walking time; finding nothing, a dead end or an empty site
 * are all normal outcomes. Returns a plan when food is found there (the worker then forages at that site).
 */
function explore(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, events: SimEvent[], day: number, tripCost: () => void): { plan: Plan | null; walked: boolean } {
  const g = colonyDice(world, colony, 'explore:' + worker.id), nest = colony.nest_node;
  if (g() >= sp.scouting.scout_discovery_probability) return { plan: null, walked: false };
  const bases = knownNodes(worker, nest), base = bases[Math.floor(g() * bases.length)];
  const toBase = knownRoute(worker, nest, base) as string[];
  const exits = unknownExits(worker, wp, base);
  if (!exits.length) {
    // Walked to a known place and perceived no unexplored direction there.
    if (base === nest) { events.push({ type: 'exploration_no_new_direction', worker: worker.id, node: base, minute: 0, assumption: true }); return { plan: null, walked: false }; }
    const trip = walkRoute(sp, wp, worker, toBase, events, 'explore_depart', 0, day);
    if (!trip) return { plan: null, walked: false };
    tripCost();
    events.push({ type: 'exploration_no_new_direction', worker: worker.id, node: base, minute: trip.arrive, assumption: true });
    goHome(wp, worker, toBase, events, 'explore_return', trip.arrive);
    return { plan: null, walked: true };
  }
  const next = exits[Math.floor(g() * exits.length)], route = [...toBase, next];
  const trip = walkRoute(sp, wp, worker, route, events, 'explore_depart', 0, day);
  if (!trip) { events.push({ type: 'route_timeout', worker: worker.id, site: next, assumption: true }); return { plan: null, walked: false }; }
  events.push({ type: 'exploration_step', worker: worker.id, from: base, to: next, minute: trip.arrive, route, assumption: true });
  const site = world.sources[next];
  // What the worker can perceive on arrival: food on the spot, living tracked insects, or hemipterans on a living host.
  const perceivable = !!site && (sourceSum(site) > 1e-5 || (world.ecology.insects_by_site[site.id]?.living ?? 0) > 0 || (site.type === 'honeydew' && site.host_alive !== false && ((site.hemipteran_colonies as number) ?? 0) > 0));
  if (site && perceivable) {
    // Food perceived on arrival: forage here now.
    const k = knowledge(colony, site.id);
    if (k.presence === 'potential') k.presence = 'confirmed_game_scenario'; // colony bookkeeping only
    events.push({ type: 'discovery', worker: worker.id, site: site.id, food_kind: site.type, minute: trip.arrive, assumption: true });
    if (!worker.known_sources.includes(site.id)) worker.known_sources.push(site.id);
    if (!k.known_by.includes(worker.id)) k.known_by.push(worker.id);
    return { plan: { worker, source: site, route, trip, g: colonyDice(world, colony, 'target:' + worker.id) }, walked: true };
  }
  tripCost();
  if (site && site.host_alive === false) {
    // A dead host plant: nothing will appear here (no regrowth in this model); this worker remembers it.
    markEmpty(worker, site.id, day);
    const k = knowledge(colony, site.id);
    if (k.presence === 'potential') k.presence = 'scouted_empty'; // colony bookkeeping only
    events.push({ type: 'scouted_empty', worker: worker.id, site: site.id, minute: trip.arrive, assumption: true });
  } else events.push({ type: 'exploration_found_nothing', worker: worker.id, node: next, minute: trip.arrive, ...(site ? { site_without_food_now: site.id } : {}), assumption: true });
  goHome(wp, worker, route, events, 'explore_return', trip.arrive);
  return { plan: null, walked: true };
}

/**
 * v2-review.14 trip planning from the worker's OWN memory: a known site is usable only over edges the worker has
 * walked. A worker with no usable site first follows trail pheromone it can sense at the nest (hop by hop), and
 * otherwise may explore. A worker whose own sites are unproductive may explore instead of going back.
 */
function planTripFromMemory(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, events: SimEvent[], summary: ColonySummary, day: number, tripCost: () => void): Plan | null {
  const sc = sp.site_choice, nest = colony.nest_node;
  const g = colonyDice(world, colony, 'target:' + worker.id); worker.site_memory ??= {};
  const memory = worker.site_memory;
  const known = worker.known_sources.map((id) => world.sources[id]).filter((src) => src && !knownEmpty(worker, src.id) && knownRoute(worker, nest, src.id));
  const best = Math.max(0, ...known.map((src) => memory[src.id]?.last_success_portions ?? 0));
  if (!known.length || (best < sp.scouting.unproductive_route_threshold_portions && g() < sp.scouting.scout_search_when_route_unproductive_probability)) {
    if (!known.length) {
      const trail = followLocalTrail(world, colony, sp, wp, worker, g, events, true);
      if (trail) return depart(world, colony, sp, wp, worker, events, trail.source, trail.route, 'trail_follow_depart', g, day);
    }
    const ex = explore(world, colony, sp, wp, worker, events, day, tripCost);
    if (ex.plan) return ex.plan;
    if (ex.walked || !known.length) { summary.scouts++; return null; }
  }
  const cues = localSignals(sp, worker), need = clamp((1 - cues.sugarSatiety) * sc.need_own_crop_weight + cues.peerSugarHunger * sc.need_peer_weight, 0, 1);
  const ranks = known.map((site) => {
    const macro = macroOf(site), prior = memory[site.id]?.last_success_portions ?? sc.default_prior_success_portions;
    const age = memory[site.id]?.last_visit_day ?? (world.sim_day - sc.default_last_visit_days_ago), penalty = prior === 0 && world.sim_day - age < sc.recent_failure_window_days ? sc.recent_failure_penalty : 1;
    const unload = worker.local_sensory?.unload_feedback?.[macro] ?? sp.local_signals.unload_feedback_default;
    const bias = macro === 'sugar' ? 1 + sc.sugar_hunger_priority_weight * need : 1 + sc.protein_begging_priority_weight * clamp(cues.broodBegging * sc.brood_begging_protein_weight + cues.proteinFeedback * sc.peer_protein_feedback_weight, 0, 1);
    return { site, score: (sc.score_base_offset + prior) * penalty * bias * (sc.unloading_memory_base + sc.unloading_success_memory_weight * unload) };
  }).sort((a, b) => b.score - a.score);
  const site = ranks[g() < sc.best_site_choice_probability ? 0 : Math.min(1, ranks.length - 1)].site;
  return depart(world, colony, sp, wp, worker, events, site, knownRoute(worker, nest, site.id) as string[], 'foraging_depart', g, day);
}

/** Walk to the chosen site; what is there becomes known only on arrival. */
function depart(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, events: SimEvent[], source: Source, route: string[], kind: string, g: Rng, day: number): Plan | null {
  const trip = walkRoute(sp, wp, worker, route, events, kind, 0, day);
  if (!trip) { events.push({ type: 'route_timeout', worker: worker.id, site: source.id, assumption: true }); return null; }
  const k = knowledge(colony, source.id);
  if (k.presence === 'potential') {
    k.presence = source.host_alive ? 'confirmed_game_scenario' : 'scouted_empty';
    events.push(source.host_alive ? { type: 'discovery', worker: worker.id, site: source.id, food_kind: source.type, assumption: true } : { type: 'scouted_empty', worker: worker.id, site: source.id, assumption: true });
  }
  if (source.host_alive === false) markEmpty(worker, source.id, day);
  if (!worker.known_sources.includes(source.id)) worker.known_sources.push(source.id);
  if (!k.known_by.includes(worker.id)) k.known_by.push(worker.id);
  return { worker, source, route, trip, g };
}

/** One colony's whole foraging day. Mutates world sources/insects (collection, predation) and the colony. */
export function forageDay(world: WorldState, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, weather: Weather, events: SimEvent[], summary: ColonySummary): void {
  const ft = sp.foraging_trips, rc = sp.recruitment, ls = sp.local_signals, nest = colony.nest_node;
  const tripCost = () => { summary.foraging_trips++; summary.extra_sugar_cost = round(summary.extra_sugar_cost + ft.foraging_trip_sugar_cost); };
  const byMacro = summary.foraging_workers_by_macro as { sugar: Set<string>; protein: Set<string> };
  // v2-review.14: individual route memory (switch navigation.individual_route_memory).
  const learnDay = sp.navigation.individual_route_memory ? world.sim_day + 1 : undefined;
  if (learnDay !== undefined) ensureRouteMemory(colony, wp, learnDay, events);
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
  for (const worker of foragers) { const plan = learnDay === undefined ? planTrip(world, colony, sp, wp, worker, events, summary) : planTripFromMemory(world, colony, sp, wp, worker, events, summary, learnDay, tripCost); if (plan) plans.push(plan); }

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

  /** v2-review.8 sequential model: each plan's whole day (collect, return, repeat trip, recruitment) in plan order. */
  const sequential = (list: Plan[], hunting: boolean) => {
    for (const plan of list) {
      const { worker, source, route, trip, g } = plan;
      if (worker.last_location !== source.id) continue;
      const nearby = hunting ? list.filter((q) => q.source.id === source.id && q.worker.last_location === source.id).map((q) => q.worker) : null;
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
        const again = walkRoute(sp, wp, worker, route, events, 'repeat_depart', trip.back, learnDay);
        if (again) {
          finalReturn = again.back; tripCost();
          const more = collect(world, colony, sp, wp, source, worker, weather, events, hunting ? [worker] : null);
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
          const follow = walkRoute(sp, wp, follower, route, events, 'recruit_follow_trail', finalReturn, learnDay);
          if (!follow) continue;
          follower.recruited_today = true; summary.tasks[follower.task as keyof typeof summary.tasks]--; follower.task = 'forage'; summary.tasks.forage++; summary.recruited++; tripCost();
          events.push({ type: 'local_recruitment', by: worker.id, to: follower.id, site: source.id, physical_route: route, signal_dependent: true, assumption: true });
          const k = knowledge(colony, source.id);
          if (!follower.known_sources.includes(source.id)) follower.known_sources.push(source.id);
          if (!k.known_by.includes(follower.id)) k.known_by.push(follower.id);
          const cargo = collect(world, colony, sp, wp, source, follower, weather, events, hunting ? [follower] : null);
          byMacro[macroOf(source)].add(follower.id);
          follower.site_memory ??= {}; follower.site_memory[source.id] = { last_success_portions: cargo?.load || 0, last_visit_day: world.sim_day + 1 };
          goHome(wp, follower, route, events, 'recruit_return', follow.arrive);
          if (cargo) unload(follower, source, route, cargo, g);
        }
      }
    }
  };

  /**
   * v2-review.9: every trip to a carcass site (first trip, repeat trip, recruited follower, long-range hunt
   * recruit) runs on one clock; all workers arriving at the same site in the same minute form ONE hunting
   * window. Within a minute, sites are taken in id order and workers in id order, so nothing depends on the
   * order of the population list or of the plans.
   */
  const timedCarcassTrips = (list: Plan[]) => {
    // v2-review.11 (species switch predation.late_arrivals_join_waiting_prey): a long-range hunt waits at the site
    // and workers arriving before the recruits join it.
    const lateJoin = sp.predation.late_arrivals_join_waiting_prey;
    const waitingList: WaitingPrey[] = [];
    const ctx: HuntContext = { world, colony, sp, wp, events, summary, tripCost, byMacro, ...(lateJoin ? { reserved: {} } : {}), ...(learnDay !== undefined ? { learnDay } : {}) };
    interface Visit { arrival: Arrival; source: Source; kind: 'first' | 'repeat' | 'follow'; plan: Plan }
    /** A marker that makes the clock stop at a waiting prey's resolution minute even if nobody else arrives. */
    interface Marker { arrival: { arrive: number }; source: Source; kind: 'resolve' }
    const queue: (Visit | Marker)[] = [];
    let clock = -Infinity;
    /** Every new arrival lies strictly in the future of the clock, so no window can be split. */
    const schedule = (item: Visit | Marker) => { if (item.arrival.arrive <= clock) throw Error('carcass clock: arrival scheduled at or before the current minute'); queue.push(item); };
    const legOf = (route: string[]) => (route.length - 1) * wp.routes.route_edge_minutes;
    const idOrder = (a: Worker, b: Worker) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const plan of list) if (plan.worker.last_location === plan.source.id) { tripCost(); schedule({ arrival: { worker: plan.worker, route: plan.route, arrive: plan.trip.arrive }, source: plan.source, kind: 'first', plan }); }
    const recruitFollowers = (plan: Plan, finalReturn: number) => {
      const { worker, source, route, g } = plan;
      if (!(g() < rc.recruitment_probability && fullTrail(colony, sp, route))) return;
      const possible = colony.population.workers.filter((w) => w.id !== worker.id && w.last_location === nest && w.task !== 'forage' && w.task !== 'guard' && !w.recruited_today && w.age_days >= sp.task_allocation.newborn_nurse_days).sort(idOrder);
      const n = possible.length ? 1 + Math.floor(g() * Math.min(possible.length, rc.recruitment_max_followers)) : 0;
      for (let i = 0; i < n; i++) {
        const follower = possible.splice(Math.floor(g() * possible.length), 1)[0];
        if (!follower) break;
        const follow = walkRoute(sp, wp, follower, route, events, 'recruit_follow_trail', finalReturn, learnDay);
        if (!follow) continue;
        follower.recruited_today = true; summary.tasks[follower.task as keyof typeof summary.tasks]--; follower.task = 'forage'; summary.tasks.forage++; summary.recruited++; tripCost();
        events.push({ type: 'local_recruitment', by: worker.id, to: follower.id, site: source.id, physical_route: route, signal_dependent: true, assumption: true });
        const k = knowledge(colony, source.id);
        if (!follower.known_sources.includes(source.id)) follower.known_sources.push(source.id);
        if (!k.known_by.includes(follower.id)) k.known_by.push(follower.id);
        schedule({ arrival: { worker: follower, route, arrive: follow.arrive }, source, kind: 'follow', plan });
      }
    };
    /** Long-range hunt recruits walk home with the team and unload. */
    const recruitHome = (carry: Carry, source: Source, minute: number) => {
      const r = carry.worker;
      byMacro.protein.add(r.id);
      r.site_memory ??= {}; r.site_memory[source.id] = { last_success_portions: carry.load, last_visit_day: world.sim_day + 1 };
      goHome(wp, r, carry.route, events, 'hunt_recruit_return', carry.home);
      if (carry.load > 0) unload(r, source, carry.route, { macro: 'protein', load: carry.load }, colonyDice(world, colony, 'hunt-unload:' + r.id + ':' + source.id + ':' + minute));
    };
    /** The rest of one visit: what it brings home, the walk back, unloading, then the plan's next step. */
    const finish = (v: Visit, carry: Carry | undefined, pre: Map<string, { macro: Macro; load: number } | null>, minute: number) => {
      const { worker, route } = v.arrival, source = v.source;
      const found = carry ? (carry.load > 0 ? { macro: 'protein' as Macro, load: carry.load } : null) : pre.has(worker.id) ? (pre.get(worker.id) as { macro: Macro; load: number } | null) : collect(world, colony, sp, wp, source, worker, weather, events, null);
      const leave = carry ? carry.home : minute, back = leave + legOf(route);
      byMacro[macroOf(source)].add(worker.id);
      worker.site_memory ??= {}; worker.site_memory[source.id] = { last_success_portions: found?.load || 0, last_visit_day: world.sim_day + 1 };
      if (!carry?.walked_home) goHome(wp, worker, route, events, v.kind === 'first' ? 'foraging_return' : v.kind === 'repeat' ? 'repeat_return' : 'recruit_return', leave);
      if (found) unload(worker, source, route, found, v.plan.g);
      if (v.kind === 'follow') return;
      if (v.kind === 'repeat') { recruitFollowers(v.plan, back); return; }
      if (!found) return;
      // First trip succeeded: optional repeated trip with explicit travel time, then local recruitment.
      if (v.plan.g() < ft.repeat_trip_probability && ft.max_trips_per_forager >= 2) {
        const again = walkRoute(sp, wp, worker, route, events, 'repeat_depart', back, learnDay);
        if (again) { tripCost(); schedule({ arrival: { worker, route, arrive: again.arrive }, source, kind: 'repeat', plan: v.plan }); return; }
      }
      recruitFollowers(v.plan, back);
    };
    /** Conclude a waiting prey at `minute`, then send its recruits home and finish every deferred visit. */
    const settle = (w: WaitingPrey, source: Source, minute: number) => {
      const carries = new Map<string, Carry>();
      (ctx.reserved as Record<string, number>)[w.site]--;
      waitingList.splice(waitingList.indexOf(w), 1);
      concludeHunt(ctx, source, w.state, minute, w.joiners, carries);
      for (const carry of carries.values()) if (carry.recruited) recruitHome(carry, source, w.state.minute);
      for (const d of w.deferred as Visit[]) finish(d, carries.get(d.arrival.worker.id), new Map(), minute);
    };
    while (queue.length) {
      const minute = Math.min(...queue.map((v) => v.arrival.arrive));
      clock = minute;
      const now = queue.filter((v) => v.arrival.arrive === minute);
      for (const v of now) queue.splice(queue.indexOf(v), 1);
      for (const site of [...new Set(now.map((v) => v.source.id))].sort()) {
        const visits = now.filter((v): v is Visit => v.source.id === site && v.kind !== 'resolve').sort((x, y) => idOrder(x.arrival.worker, y.arrival.worker));
        const source = world.sources[site];
        // Workers first take what is left of an existing carcass; those left empty-handed, if the carcass is now
        // empty, search for live prey together (one window).
        const pre = new Map<string, { macro: Macro; load: number } | null>();
        if (visits.length && sourceSum(source) > 1e-5) for (const v of visits) pre.set(v.arrival.worker.id, collect(world, colony, sp, wp, source, v.arrival.worker, weather, events, null));
        let searchers = visits.filter((v) => !pre.get(v.arrival.worker.id)).map((v) => v.arrival);
        const deferred = new Set<string>();
        if (lateJoin) {
          // v2-review.11: empty-handed arrivals join a prey that is waiting here for long-range recruits (up to the
          // team cap); the hunt is concluded when the recruits arrive.
          const here = waitingList.filter((w) => w.site === site && w.state.minute < minute && minute <= w.state.resolveAt).sort((x, y) => x.state.minute - y.state.minute || idOrder(x.state.finder.worker, y.state.finder.worker));
          for (const w of here) {
            const room = sp.predation.large_prey_max_team - (w.state.team.length + w.joiners.length), cands = [...searchers];
            let picked: Arrival[] = [];
            if (cands.length <= room) picked = cands;
            else { const g = colonyDice(world, colony, 'hunt-join:' + w.state.finder.worker.id + ':' + site + ':' + minute); for (let i = 0; i < room; i++) picked.push(cands.splice(Math.floor(g() * cands.length), 1)[0]); }
            if (picked.length) {
              events.push({ type: 'waiting_prey_joined', site, minute, finder: w.state.finder.worker.id, joiners: picked.map((m) => m.worker.id), assumption: true });
              w.joiners.push(...picked); searchers = searchers.filter((m) => !picked.includes(m));
              for (const m of picked) { deferred.add(m.worker.id); w.deferred.push(visits.find((v) => v.arrival === m) as Visit); }
            }
            if (minute === w.state.resolveAt) settle(w, source, minute);
          }
        }
        const before = waitingList.length;
        const hw = searchers.length && huntable(world, source, ctx.reserved?.[site] ?? 0) ? huntWindow(ctx, source, searchers, lateJoin ? waitingList : undefined) : new Map<string, Carry>();
        for (const w of waitingList.slice(before)) schedule({ arrival: { arrive: w.state.resolveAt }, source, kind: 'resolve' });
        for (const carry of hw.values()) if (carry.recruited && !carry.waiting) recruitHome(carry, source, minute);
        for (const v of visits) {
          if (deferred.has(v.arrival.worker.id)) continue;
          const carry = hw.get(v.arrival.worker.id);
          if (carry?.waiting) { carry.waiting.deferred.push(v); continue; }
          finish(v, carry, pre, minute);
        }
      }
    }
  };

  if (!sp.predation.simultaneous_site_group_hunting) sequential(plans, true);
  else {
    // Liquid-food plans keep the sequential order (nothing is hunted there); carcass trips run on the clock.
    sequential(plans.filter((q) => q.source.type !== 'carcass'), false);
    timedCarcassTrips(plans.filter((q) => q.source.type === 'carcass'));
  }
  for (const w of colony.population.workers) delete w.recruited_today;
}
