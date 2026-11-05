/**
 * v2-review.17 (Owner work package 1): individual activity timeline and autonomous foraging loop
 * (species switch activity.individual_timeline; false = the v2-review.16 day of one planned trip plus an
 * optional repeat).
 *
 * Every worker that goes out has its own clock. One event queue holds what each worker does next; events are
 * processed in time order (ties: event kind, then worker id), so who is where at a given minute — who can
 * receive food at the nest, who stands at a site when a prey is found — follows from the simulated times.
 * A forager's day is a loop it decides itself:
 *
 *   decide at the nest -> walk its own remembered route (or follow trail / explore) -> arrive -> search ->
 *   collect or hunt -> walk home -> unload to nestmates actually at the nest -> mark the trail -> maybe recruit
 *   nestmates at the nest -> decide again from its own crop, the unloading it just experienced and what it
 *   sensed (or stop).
 *
 * The number of trips per day is therefore an outcome. Every action costs simulated time computed from the
 * world's edge lengths (when the world records them) and the species walking speed, or from the old fixed
 * minutes per edge when a length is unknown. Nothing here reads the nest food ledger, the world map beyond
 * the edges leaving the node a worker stands on, or anything a worker has not sensed.
 *
 * A computation limit (activity.safety_max_actions_per_worker_day) only guards against an infinite loop; it
 * is not a biological rule and reaching it throws.
 */
import { clamp, round } from './math.ts';
import type { Rng } from './rng.ts';
import { foodTransfer } from './transfers.ts';
import { adjacencyOf, edgeKey } from './routes.ts';
import { depositTrail, fullTrail, followLocalTrail } from './trails.ts';
import { knownEmpty, knownNodes, knownRoute, learnRoute, markEmpty, perceiveExits, rememberedUnknownExits, unknownExits } from './navigation.ts';
import { sourceSum } from './ecology.ts';
import { handoff } from './nutrition.ts';
import { colonyDice, localSignals, rainActivity } from './workers.ts';
import { takeProtein } from './foraging.ts';
import type { SpeciesParams, WorldParams } from './params.ts';
import type { ColonyState, ColonySummary, Macro, SimEvent, Source, Weather, Worker, WorldState } from './types.ts';

const macroOf = (src: Source): Macro => (src.type === 'carcass' ? 'protein' : 'sugar');
const idOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface WorkerActivityStats {
  trips: number; successes: number; outside_minutes: number; travel_minutes: number; search_minutes: number; handling_minutes: number;
  prey_holding_minutes: number; unload_minutes: number; explorations: number; cancelled_no_time: number; no_route: number;
  recruited_by: string | null; recruits_led: number; stop_reason: string | null;
}
const newStats = (): WorkerActivityStats => ({ trips: 0, successes: 0, outside_minutes: 0, travel_minutes: 0, search_minutes: 0, handling_minutes: 0, prey_holding_minutes: 0, unload_minutes: 0, explorations: 0, cancelled_no_time: 0, no_route: 0, recruited_by: null, recruits_led: 0, stop_reason: null });

interface Agent { w: Worker; actions: number; token: number; stats: WorkerActivityStats; state: 'nest' | 'out' | 'done'; hold?: PreyHold; departed?: number; restFrom?: number; busyUntil?: number; openSearch?: { ev: SimEvent; end: number }; pendingLearn?: { at: number; route: string[]; kind: string }[]; trip?: Trip }
interface Trip { site: string; route: string[]; kind: 'forage' | 'explore' | 'explore_base' | 'trail' | 'recruit' | 'hunt_recruit'; leftAt: number; recruiter?: string }
interface Cargo { macro: Macro; load: number; source: string; prey_event_id?: string }
type Kind = 'trail' | 'step' | 'home' | 'arrive' | 'resolve' | 'searched' | 'recruit' | 'decide';
/** v2-review.20 only: 'trail' = a mark laid on one edge; 'step' = a walking worker enters its next edge. At the same
 *  minute marks are applied first, then edges are entered (so a mark laid at that minute is felt), then the rest. */
const KIND_ORDER: Record<Kind, number> = { trail: -2, step: -1, home: 0, arrive: 1, resolve: 2, searched: 3, recruit: 4, decide: 5 };
/** v2-review.20 (PR #44 independent review): a walk proceeds one edge at a time on the event clock. */
interface WalkPlan { route: string[]; i: number; t0: number; kind: string; learn: boolean; final: Omit<QEvent, 't'> | null; deposit?: boolean; cause?: string; announce?: SimEvent }
interface QEvent { t: number; kind: Kind; id: string; token: number; trip?: Trip; cargo?: Cargo | null; hold?: PreyHold; afterFailure?: boolean; g?: Rng; edge?: [string, string]; walk?: WalkPlan; seq?: number; cause?: string; walkedFrom?: number }
/** A large prey waiting at a site for long-range recruits (v9/v11 semantics on the continuous clock). */
interface PreyHold { site: string; finder: string; large: boolean; g: Rng; minute: number; resolveAt: number; holders: string[]; recruits: string[]; joiners: string[]; finderComes: boolean; route: string[]; since: Record<string, number>; seq?: number }

export interface ActivityContext {
  world: WorldState; colony: ColonyState; sp: SpeciesParams; wp: WorldParams; weather: Weather; events: SimEvent[]; summary: ColonySummary; learnDay: number;
}

/** Minutes to walk one edge: recorded length / speed (on a detectable trail at full speed), or the legacy fixed minutes when the length is unknown. */
export function edgeMinutes(sp: SpeciesParams, wp: WorldParams, colony: ColonyState, a: string, b: string): { minutes: number; basis: 'length' | 'unknown_length_legacy_minutes' } {
  const key = edgeKey(a, b), len = wp.routes.edge_length_cm[key];
  if (len === undefined) return { minutes: wp.routes.route_edge_minutes, basis: 'unknown_length_legacy_minutes' };
  const onTrail = (colony.trail_by_edge[key] || 0) >= sp.recruitment.trail_min_detectable;
  const speed = sp.activity.trail_walking_speed_mm_s * (onTrail ? 1 : sp.activity.off_trail_speed_factor);
  return { minutes: round((len * 10 * wp.routes.path_tortuosity) / speed / 60), basis: 'length' };
}

/** v2-review.20 (PR #44 review): minutes to walk one edge as used for PLANNING (does a trip fit the activity window,
 *  how long a held prey waits). It reads no pheromone: a worker cannot sense trail on an edge it is not on. It uses
 *  the off-trail speed, the slowest the walk can actually be, so a planned trip never ends later than planned. */
export function edgePlanMinutes(sp: SpeciesParams, wp: WorldParams, a: string, b: string): number {
  const len = wp.routes.edge_length_cm[edgeKey(a, b)];
  if (len === undefined) return wp.routes.route_edge_minutes;
  return round((len * 10 * wp.routes.path_tortuosity) / (sp.activity.trail_walking_speed_mm_s * sp.activity.off_trail_speed_factor) / 60);
}

export function activityDay(ctx: ActivityContext, foragers: Worker[]): void {
  const { world, colony, sp, wp, weather, events, summary, learnDay } = ctx, ac = sp.activity, nest = colony.nest_node, W = sp.foraging_activity.daily_window_minutes;
  /** v2-review.20 switch (Issue #43 F02–F05, R11); false reproduces v2-review.19 for the isolation proof only. */
  const V20 = ac.local_causality_v20;
  /** v2-review.23 switch (Codex Issue #61 R3-05; requires V20): a worker carrying food home marks each edge of its walk home
   *  at the minute it has walked that edge, while it is on it (queue event 'trail'); nothing is written for a remote edge
   *  after it has reached the nest. false = v2-review.22: the whole return route marked at the minute of arrival at the nest. */
  const V23 = V20 && ac.local_trail_deposit_v23;
  const agents = new Map<string, Agent>();
  for (const w of [...colony.population.workers].sort((a, b) => idOrder(a.id, b.id))) agents.set(w.id, { w, actions: 0, token: 0, stats: newStats(), state: 'nest' });
  const queue: QEvent[] = [];
  let clock = 0;
  const push = (e: QEvent) => {
    if (e.t < clock - 1e-9) throw Error('activity clock: event scheduled in the past');
    let i = queue.length;
    while (i > 0) { const q = queue[i - 1]; if (q.t < e.t || (q.t === e.t && (KIND_ORDER[q.kind] < KIND_ORDER[e.kind] || (KIND_ORDER[q.kind] === KIND_ORDER[e.kind] && q.id <= e.id)))) break; i--; }
    queue.splice(i, 0, e);
  };
  const dice = (a: Agent, purpose: string): Rng => {
    if (++a.actions > ac.safety_max_actions_per_worker_day) throw Error(`COMPUTATION LIMIT (not biology): ${a.w.id} exceeded activity.safety_max_actions_per_worker_day`);
    return colonyDice(world, colony, `act:${a.w.id}:${a.actions}:${purpose}`);
  };
  const seg = (a: Agent, start: number, end: number, place: string, action: string, outcome?: string): SimEvent => { const ev: SimEvent = { type: 'worker_activity', worker: a.w.id, start: round(start), end: round(end), duration: round(end - start), place, action, ...(outcome ? { outcome } : {}), assumption: true }; events.push(ev); return ev; };
  /** v2-review.20 (Issue #43 F03): an activity bout cut short is closed at the interruption, and only the minutes
   *  actually spent are counted. Used when a searching worker is pulled into a short-range prey team. */
  const interruptSearch = (a: Agent, t: number, why: string) => {
    const o = a.openSearch; a.openSearch = undefined;
    if (!o || t >= o.end - 1e-9) return;
    const unspent = round(o.end - t);
    o.ev.end = round(t); o.ev.duration = round(t - (o.ev.start as number)); o.ev.outcome = why;
    a.stats.search_minutes = round(a.stats.search_minutes - unspent);
  };
  /** A rest in the nest is recorded when it ends (it may be cut short by a recruiter). */
  const rest = (a: Agent, t: number) => { a.restFrom = t; };
  const endRest = (a: Agent, t: number, outcome?: string) => { if (a.restFrom !== undefined) { if (t > a.restFrom) seg(a, a.restFrom, t, nest, 'rest', outcome); a.restFrom = undefined; } };
  /** Rest, then decide again — unless the activity window closes before the rest is over. */
  const restThenDecide = (a: Agent, t: number, afterFailure: boolean) => {
    const next = round(t + ac.rest_between_trips_minutes);
    if (next > W) { stop(a, t, 'activity_window_closed'); return; }
    rest(a, t); push({ t: next, kind: 'decide', id: a.w.id, token: a.token, ...(afterFailure ? { afterFailure } : {}) });
  };
  const reserved: Record<string, number> = {};
  /** Workers currently searching each site (between their arrival and the end of their search). */
  const searchingAt = new Map<string, Set<Agent>>();
  const holds: PreyHold[] = [];
  const lateJoin = sp.predation.late_arrivals_join_waiting_prey;
  const knowledge = (id: string) => colony.source_knowledge[id];

  /** Walk `route` edge by edge from minute t0; returns arrival minute. Edges are learned as they are walked. */
  const walk = (a: Agent, route: string[], t0: number, kind: string, learn: boolean, edgeEnds?: number[]): number => {
    let t = t0;
    for (let i = 1; i < route.length; i++) {
      t = round(t + edgeMinutes(sp, wp, colony, route[i - 1], route[i]).minutes);
      edgeEnds?.push(t);
      events.push({ type: 'route_step', worker: a.w.id, from: route[i - 1], to: route[i], minute: t, kind, assumption: true });
    }
    // v2-review.20 (Issue #43 R11): a route is learned when the worker has walked it (at arrival), not at departure.
    if (learn) { if (V20) (a.pendingLearn ??= []).push({ at: t, route, kind }); else learnRoute(a.w, route, kind, learnDay); }
    a.w.last_location = `transit:${route[0]}>${route.at(-1)}`;
    a.stats.travel_minutes = round(a.stats.travel_minutes + (t - t0));
    seg(a, t0, t, route.join('>'), kind);
    return t;
  };
  const flushLearning = (a: Agent, now: number) => {
    if (!a.pendingLearn?.length) return;
    const keep: NonNullable<Agent['pendingLearn']> = [];
    // v2-review.20 (PR #44 review): having walked the route, the worker has stood at each of its nodes and recorded the
    // exits it perceived there (its own observation memory; the world map is not consulted later from elsewhere).
    for (const p of a.pendingLearn) if (p.at <= now + 1e-9) { learnRoute(a.w, p.route, p.kind, learnDay); for (const n of p.route) perceiveExits(a.w, wp, n); } else keep.push(p);
    a.pendingLearn = keep;
  };
  /**
   * v2-review.20 (PR #44 independent review): walk `route` from minute t0 one edge at a time on the event clock. The
   * minutes for an edge are computed when the worker ENTERS it, from the trail on that edge at that minute (the
   * edge it is on), so pheromone laid by others after it set off counts once it is there, and nothing about an edge
   * ahead is read in advance. `final` is pushed at arrival. v2-review.19: the whole walk is computed at departure.
   */
  const go = (a: Agent, route: string[], t0: number, kind: string, learn: boolean, final: Omit<QEvent, 't'> | null, opt: { deposit?: boolean; cause?: string; announce?: SimEvent } = {}) => {
    if (!V20) { const at = walk(a, route, t0, kind, learn); if (final) push({ t: at, ...final } as QEvent); return; }
    a.w.last_location = `transit:${route[0]}>${route.at(-1)}`;
    if (route.length < 2) { if (final) push({ t: t0, ...final } as QEvent); return; }
    push({ t: t0, kind: 'step', id: a.w.id, token: -1, walk: { route, i: 0, t0, kind, learn, final, ...opt } });
  };
  const step = (a: Agent, t: number, wk: WalkPlan) => {
    const from = wk.route[wk.i], to = wk.route[wk.i + 1], end = round(t + edgeMinutes(sp, wp, colony, from, to).minutes);
    events.push({ type: 'route_step', worker: a.w.id, from, to, minute: end, kind: wk.kind, assumption: true });
    if (wk.deposit) push({ t: end, kind: 'trail', id: a.w.id, token: -1, edge: [from, to], ...(V23 ? { cause: wk.cause ?? 'hunt_recruit', walkedFrom: t } : {}) });
    if (wk.i + 2 < wk.route.length) { push({ t: end, kind: 'step', id: a.w.id, token: -1, walk: { ...wk, i: wk.i + 1 } }); return; }
    if (wk.learn) (a.pendingLearn ??= []).push({ at: end, route: wk.route, kind: wk.kind });
    a.stats.travel_minutes = round(a.stats.travel_minutes + (end - wk.t0));
    seg(a, wk.t0, end, wk.route.join('>'), wk.kind);
    if (wk.announce) events.push({ ...wk.announce, minute: round(end) });
    if (wk.final) push({ t: end, ...wk.final } as QEvent);
  };
  const legOf = (route: string[]) => { let m = 0; for (let i = 1; i < route.length; i++) m += edgeMinutes(sp, wp, colony, route[i - 1], route[i]).minutes; return round(m); };
  /** Walking minutes used for planning: v2-review.20 reads no pheromone (edgePlanMinutes); v2-review.19 read the trail on every edge. */
  const planLeg = (route: string[]) => { if (!V20) return legOf(route); let m = 0; for (let i = 1; i < route.length; i++) m += edgePlanMinutes(sp, wp, route[i - 1], route[i]); return round(m); };
  /** Can a full trip along `route` (out, search, longest handling, back, unload) still end inside today's window? */
  const fits = (route: string[], t: number) => t + 2 * planLeg(route) + ac.search_minutes + Math.max(ac.liquid_fill_minutes_full_crop, ac.protein_handling_minutes) + ac.unload_minutes <= W + 1e-9;
  /** v2-review.20 (PR #44 review): the outbound trip a worker actually walked, so it goes home along its OWN route. */
  const ownTrip = (m: Agent, fallback: Trip): Trip => (V20 && m.trip ? { ...m.trip, kind: 'forage', leftAt: fallback.leftAt } : fallback);
  const stop = (a: Agent, t: number, reason: string) => { a.state = 'done'; a.stats.stop_reason = reason; events.push({ type: 'forager_stopped', worker: a.w.id, minute: round(t), reason, assumption: true }); };
  const cancelNoTime = (a: Agent, t: number, what: string) => { a.stats.cancelled_no_time++; events.push({ type: 'action_cancelled_no_time', worker: a.w.id, minute: round(t), action: what, assumption: true }); stop(a, t, 'no_time_left_in_activity_window'); };
  const startTrip = (a: Agent, t: number, trip: Trip, walkKind: string) => {
    a.state = 'out'; a.departed = t; a.stats.trips++; summary.foraging_trips++;
    go(a, trip.route, t, walkKind, true, { kind: 'arrive', id: a.w.id, token: a.token, trip });
  };
  const goHome = (a: Agent, t: number, trip: Trip, cargo: Cargo | null, kind: string, learn = false) => {
    // v2-review.23 (R3-05): whether to mark is the worker's own state when it sets off home — it carries food it collected
    // (the same condition under which v2-review.22 marked at the nest); each mark is laid on the edge it is walking.
    go(a, [...trip.route].reverse(), t, kind, learn, { kind: 'home', id: a.w.id, token: a.token, trip, cargo }, V23 && cargo ? { deposit: true, cause: 'laden_return' } : {});
  };

  // ---- decisions at the nest -------------------------------------------------------------------------
  const knownSites = (w: Worker) => w.known_sources.map((id) => world.sources[id]).filter((s) => s && !knownEmpty(w, s.id) && knownRoute(w, nest, s.id));
  const chooseSite = (a: Agent, g: Rng): Source => {
    const sc = sp.site_choice, w = a.w, memory = (w.site_memory ??= {}), cues = localSignals(sp, w);
    const need = clamp((1 - cues.sugarSatiety) * sc.need_own_crop_weight + cues.peerSugarHunger * sc.need_peer_weight, 0, 1);
    const ranks = knownSites(w).map((site) => {
      const macro = macroOf(site), prior = memory[site.id]?.last_success_portions ?? sc.default_prior_success_portions;
      const age = memory[site.id]?.last_visit_day ?? (world.sim_day - sc.default_last_visit_days_ago), penalty = prior === 0 && world.sim_day + 1 - age < sc.recent_failure_window_days ? sc.recent_failure_penalty : 1;
      const unload = w.local_sensory?.unload_feedback?.[macro] ?? sp.local_signals.unload_feedback_default;
      const bias = macro === 'sugar' ? 1 + sc.sugar_hunger_priority_weight * need : 1 + sc.protein_begging_priority_weight * clamp(cues.broodBegging * sc.brood_begging_protein_weight + cues.proteinFeedback * sc.peer_protein_feedback_weight, 0, 1);
      return { site, score: (sc.score_base_offset + prior) * penalty * bias * (sc.unloading_memory_base + sc.unloading_success_memory_weight * unload) };
    }).sort((x, y) => y.score - x.score || idOrder(x.site.id, y.site.id));
    return ranks[g() < sc.best_site_choice_probability ? 0 : Math.min(1, ranks.length - 1)].site;
  };
  /** Local exploration from the worker's own map (v2-review.14 rule on the timeline). */
  const explore = (a: Agent, t: number, g: Rng): boolean => {
    const w = a.w, bases = knownNodes(w, nest), base = bases[Math.floor(g() * bases.length)], toBase = knownRoute(w, nest, base) as string[];
    // v2-review.20 (PR #44 review, R11c): the exits of the node it stands on (the nest) are perceived now; beyond a
    // remote node the worker knows only the exits it recorded itself when it stood there (none recorded = unknown,
    // so it walks there to look). v2-review.19 read the remote node's exits from the world map.
    let exits: string[];
    if (!V20) exits = unknownExits(w, wp, base);
    else if (base === nest) { perceiveExits(w, wp, nest); exits = unknownExits(w, wp, nest); }
    else exits = rememberedUnknownExits(w, base) ?? [];
    if (!exits.length) {
      // The worker perceives the exits only where it stands: at the nest now, or after walking to the base node.
      if (base === nest) { events.push({ type: 'exploration_no_new_direction', worker: w.id, node: base, minute: round(t), assumption: true }); return false; }
      if (!fits(toBase, t)) { cancelNoTime(a, t, 'explore'); return true; }
      a.stats.explorations++; summary.scouts++;
      startTrip(a, t, { site: base, route: toBase, kind: 'explore_base', leftAt: t }, 'explore_depart');
      return true;
    }
    const next = exits[Math.floor(g() * exits.length)], route = [...toBase, next];
    if (!fits(route, t)) { cancelNoTime(a, t, 'explore'); return true; }
    a.stats.explorations++; summary.scouts++;
    startTrip(a, t, { site: next, route, kind: 'explore', leftAt: t }, 'explore_depart');
    return true;
  };
  /**
   * v2-review.20 (Issue #43 F02): following a pheromone trail one edge at a time. At the node where it stands the
   * worker senses only the trail strength on the edges leaving that node and chooses the next edge by it; what lies
   * at the far end (a living host, food, an empty site) is perceived only on arrival (`arriveOnTrail`). Nothing about
   * a node the worker has not reached enters the decision. Returns false when no detectable edge leaves this node.
   */
  const trailStep = (a: Agent, path: string[], t: number, g: Rng): boolean => {
    const at = path.at(-1) as string, trails = colony.trail_by_edge, limit = sp.recruitment.trail_min_detectable, seen = new Set(path);
    const neighbors = (adjacencyOf(wp)[at] || []).filter((n) => !seen.has(n) && (trails[edgeKey(at, n)] || 0) >= limit);
    if (!neighbors.length || path.length - 1 >= sp.recruitment.trail_follow_max_hops) return false;
    const sum = neighbors.reduce((x, n) => x + trails[edgeKey(at, n)], 0);
    let draw = g() * sum, next = neighbors.at(-1) as string;
    for (const n of neighbors) { draw -= trails[edgeKey(at, n)]; if (draw <= 0) { next = n; break; } }
    events.push({ type: 'local_trail_choice', worker: a.w.id, from: at, to: next, local_signal: trails[edgeKey(at, next)], minute: round(t), assumption: true });
    const route = [...path, next];
    if (at === nest) {
      if (!fits(route, t)) { cancelNoTime(a, t, 'trail_follow'); return true; }
      startTrip(a, t, { site: next, route, kind: 'trail', leftAt: t }, 'trail_follow_depart');
      return true;
    }
    // already outside: walk on along the next edge only if that edge, a search, the longest handling, the whole way
    // home from there and unloading still fit the window (PR #44 independent review: the old test let it overrun)
    if (t + planLeg([at, next]) + ac.search_minutes + Math.max(ac.liquid_fill_minutes_full_crop, ac.protein_handling_minutes) + planLeg(route) + ac.unload_minutes > W + 1e-9) return false;
    go(a, [at, next], t, 'trail_follow', true, { kind: 'arrive', id: a.w.id, token: a.token, trip: { site: next, route, kind: 'trail', leftAt: a.departed ?? t } });
    return true;
  };
  /** On arrival at a trail node: perceive this node only, then stay (search), walk on, or turn home. */
  const arriveOnTrail = (a: Agent, t: number, trip: Trip): boolean => {
    const w = a.w, site = world.sources[trip.site], g = dice(a, 'trail_node');
    const live = !!site && site.host_alive !== false && !knownEmpty(w, site.id);
    if (site && site.host_alive === false) { markEmpty(w, site.id, learnDay); const k = knowledge(site.id); if (k.presence === 'potential') k.presence = 'scouted_empty'; events.push({ type: 'scouted_empty', worker: w.id, site: site.id, minute: round(t), assumption: true }); }
    if (live) {
      const seen = new Set(trip.route), more = (adjacencyOf(wp)[trip.site] || []).some((n) => !seen.has(n) && (colony.trail_by_edge[edgeKey(trip.site, n)] || 0) >= sp.recruitment.trail_min_detectable);
      if (more && g() < sp.recruitment.follow_intermediate_source_probability && trailStep(a, trip.route, t, g)) return true;
      return false; // stay: the normal arrival (search, collection) follows
    }
    if (trailStep(a, trip.route, t, g)) return true;
    events.push({ type: 'trail_lost', worker: w.id, node: trip.site, minute: round(t), route: trip.route, assumption: true });
    goHome(a, t, trip, null, 'foraging_return');
    return true;
  };
  const decide = (a: Agent, t: number, afterFailure: boolean) => {
    const w = a.w, g = dice(a, 'decide');
    const known = knownSites(w), memory = (w.site_memory ??= {});
    const best = Math.max(0, ...known.map((s) => memory[s.id]?.last_success_portions ?? 0));
    // Search instead of revisiting: (1) nothing known; (2) all own sites unproductive in memory — right after an
    // empty trip the worker that chose to go on searches, otherwise with the scouting probability; (3) the worker's
    // OWN sugar need (its crop and the hunger it met in nestmates) is high but every productive site it knows gives
    // protein: it searches with probability need × the scouting probability (no new parameter).
    const unproductive = best < sp.scouting.unproductive_route_threshold_portions;
    const cues = localSignals(sp, w), sugarNeed = clamp((1 - cues.sugarSatiety) * sp.site_choice.need_own_crop_weight + cues.peerSugarHunger * sp.site_choice.need_peer_weight, 0, 1);
    const onlyProtein = known.length > 0 && known.every((s) => macroOf(s) === 'protein');
    const searchInstead = !known.length || (unproductive && (afterFailure || g() < sp.scouting.scout_search_when_route_unproductive_probability)) || (onlyProtein && g() < sugarNeed * sp.scouting.scout_search_when_route_unproductive_probability);
    if (searchInstead) {
      if (!known.length && V20 && trailStep(a, [nest], t, g)) return;
      if (!known.length && !V20) {
        const trail = followLocalTrail(world, colony, sp, wp, w, g, events, true);
        if (trail) {
          if (!fits(trail.route, t)) { cancelNoTime(a, t, 'trail_follow'); return; }
          startTrip(a, t, { site: trail.source.id, route: trail.route, kind: 'trail', leftAt: t }, 'trail_follow_depart');
          return;
        }
      }
      if (g() < sp.scouting.scout_discovery_probability && explore(a, t, g)) return;
      if (!known.length) { a.stats.no_route++; events.push({ type: 'no_route_cannot_depart', worker: w.id, minute: round(t), assumption: true }); stop(a, t, 'no_known_route_and_no_exploration'); return; }
    }
    const site = chooseSite(a, g), route = knownRoute(w, nest, site.id) as string[];
    if (!fits(route, t)) { cancelNoTime(a, t, 'forage'); return; }
    startTrip(a, t, { site: site.id, route, kind: 'forage', leftAt: t }, 'foraging_depart');
  };

  // ---- at the site -----------------------------------------------------------------------------------
  const arrive = (a: Agent, t: number, trip: Trip) => {
    const w = a.w, site = world.sources[trip.site];
    w.last_location = trip.site;
    if (V20) a.trip = trip;
    if (V20 && trip.kind === 'trail' && arriveOnTrail(a, t, trip)) return;
    if (V20 && trip.kind === 'explore_base') {
      // v2-review.20: standing at the base node now, the worker perceives its exits (recorded on arrival) and may walk
      // on along one it has never walked, if the whole way home still fits the window.
      const exits = unknownExits(w, wp, trip.site), g = dice(a, 'explore_node');
      if (exits.length) {
        const next = exits[Math.floor(g() * exits.length)], route = [...trip.route, next];
        if (t + planLeg([trip.site, next]) + planLeg(route) + ac.search_minutes + Math.max(ac.liquid_fill_minutes_full_crop, ac.protein_handling_minutes) + ac.unload_minutes <= W + 1e-9) {
          go(a, [trip.site, next], t, 'explore', true, { kind: 'arrive', id: w.id, token: a.token, trip: { site: next, route, kind: 'explore', leftAt: trip.leftAt } });
          return;
        }
      }
    }
    if (trip.kind === 'explore_base') { events.push({ type: 'exploration_no_new_direction', worker: w.id, node: trip.site, minute: round(t), assumption: true }); goHome(a, t, trip, null, 'explore_return'); return; }
    if (trip.kind === 'explore') {
      events.push({ type: 'exploration_step', worker: w.id, from: trip.route.at(-2), to: trip.site, minute: round(t), route: trip.route, assumption: true });
      const perceivable = !!site && (sourceSum(site) > 1e-5 || (world.ecology.insects_by_site[site.id]?.living ?? 0) > 0 || (site.type === 'honeydew' && site.host_alive !== false && ((site.hemipteran_colonies as number) ?? 0) > 0));
      if (!site || !perceivable) {
        if (site && site.host_alive === false) { markEmpty(w, site.id, learnDay); const k = knowledge(site.id); if (k.presence === 'potential') k.presence = 'scouted_empty'; events.push({ type: 'scouted_empty', worker: w.id, site: site.id, minute: round(t), assumption: true }); }
        else events.push({ type: 'exploration_found_nothing', worker: w.id, node: trip.site, minute: round(t), ...(site ? { site_without_food_now: site.id } : {}), assumption: true });
        goHome(a, t, trip, null, 'explore_return');
        return;
      }
      const k = knowledge(site.id);
      if (k.presence === 'potential') k.presence = 'confirmed_game_scenario';
      events.push({ type: 'discovery', worker: w.id, site: site.id, food_kind: site.type, minute: round(t), assumption: true });
    } else if (site) {
      const k = knowledge(site.id);
      if (k.presence === 'potential') { k.presence = site.host_alive ? 'confirmed_game_scenario' : 'scouted_empty'; events.push(site.host_alive ? { type: 'discovery', worker: w.id, site: site.id, food_kind: site.type, minute: round(t), assumption: true } : { type: 'scouted_empty', worker: w.id, site: site.id, minute: round(t), assumption: true }); }
      if (site.host_alive === false) markEmpty(w, site.id, learnDay);
    }
    if (!site) { goHome(a, t, trip, null, 'foraging_return'); return; }
    if (!w.known_sources.includes(site.id)) w.known_sources.push(site.id);
    const k = knowledge(site.id); if (!k.known_by.includes(w.id)) k.known_by.push(w.id);
    if (trip.kind === 'recruit' || trip.kind === 'hunt_recruit') return; // recruits are handled by their leader's event
    const end = round(t + ac.search_minutes);
    a.stats.search_minutes = round(a.stats.search_minutes + ac.search_minutes);
    a.openSearch = { ev: seg(a, t, end, site.id, 'search'), end };
    (searchingAt.get(site.id) ?? searchingAt.set(site.id, new Set()).get(site.id) as Set<Agent>).add(a);
    (summary.foraging_workers_by_macro as { sugar: Set<string>; protein: Set<string> })[macroOf(site)].add(w.id);
    push({ t: end, kind: 'searched', id: w.id, token: a.token, trip });
  };
  /** Liquid or carcass collection by ONE worker that has searched the site. */
  const collect = (a: Agent, t: number, trip: Trip, g: Rng): boolean => {
    const site = world.sources[trip.site], fh = sp.food_handling, w = a.w;
    if (sourceSum(site) <= 1e-5) return false;
    if (g() > rainActivity(sp, weather) * (site.type === 'carcass' ? fh.carcass_access_probability : fh.liquid_collection_probability)) return false;
    const macro = macroOf(site), min = fh[`crop_load_${macro}_min`], max = fh[`crop_load_${macro}_max`];
    const freeRoom = macro === 'sugar' ? Math.max(0, sp.trophallaxis.crop_capacity - (w.crop_cargo_sugar || 0)) : Infinity;
    const load = round(Math.min(sourceSum(site), min + (max - min) * g(), freeRoom));
    if (load <= 0) return false;
    if (macro === 'sugar') site.sugar = round(site.sugar - load); else takeProtein(site, w, load, events);
    const handling = macro === 'sugar' ? round(ac.liquid_fill_minutes_full_crop * load / sp.trophallaxis.crop_capacity) : ac.protein_handling_minutes;
    events.push({ type: 'food_collected', worker: w.id, site: site.id, macro, portions: load, location: site.id, minute: round(t), assumption: true });
    foodTransfer(events, { minute: round(t), phase: 'foraging', source: { kind: 'source', id: site.id }, recipient: { kind: 'in_transit', id: w.id }, food_type: macro, portions: load, cause: 'collect', attribution: 'individual' });
    a.stats.handling_minutes = round(a.stats.handling_minutes + handling);
    seg(a, t, t + handling, site.id, 'collect', `${macro} ${load}`);
    goHome(a, round(t + handling), trip, { macro, load, source: site.id }, trip.kind === 'recruit' ? 'recruit_return' : 'foraging_return');
    return true;
  };
  const searching = (site: string) => [...(searchingAt.get(site) ?? [])].filter((x) => x.state === 'out' && !x.hold);
  const searched = (a: Agent, t: number, trip: Trip) => {
    searchingAt.get(trip.site)?.delete(a); a.openSearch = undefined;
    const site = world.sources[trip.site], g = dice(a, 'site');
    if (collect(a, t, trip, g)) return;
    const pop = world.ecology.insects_by_site[site.id];
    if (site.type === 'carcass' && sourceSum(site) <= 1e-5 && pop && (V20 || pop.living - (reserved[site.id] ?? 0) >= 1)) {
      // Late arrival at a prey already held for recruits (v2-review.11 switch). v2-review.20 (Issue #43 F04): joining
      // an EXISTING hold does not need another unreserved prey; the reservation only limits NEW encounters.
      const hold = lateJoin ? holds.find((h) => h.site === site.id && h.minute < t && t <= h.resolveAt) : undefined;
      // v2-review.20 (PR #44 independent review): a worker joins only if, after the hold is resolved and the prey handled,
      // it can still walk home along its own route inside the window (otherwise it would be out after the window closes).
      const lateOk = (h: PreyHold) => !V20 || h.resolveAt + ac.protein_handling_minutes + planLeg(ownTrip(a, trip).route) + ac.unload_minutes <= W + 1e-9;
      if (hold && !lateOk(hold)) { a.stats.cancelled_no_time++; events.push({ type: 'action_cancelled_no_time', worker: a.w.id, minute: round(t), action: 'join_waiting_prey', assumption: true }); }
      else if (hold && hold.holders.length + hold.joiners.length + hold.recruits.length + (hold.finderComes ? 1 : 0) < sp.predation.large_prey_max_team) {
        hold.joiners.push(a.w.id); a.hold = hold; hold.since[a.w.id] = t;
        events.push({ type: 'waiting_prey_joined', site: site.id, minute: round(t), finder: hold.finder, joiners: [a.w.id], assumption: true });
        return;
      }
      if ((!V20 || pop.living - (reserved[site.id] ?? 0) >= 1) && g() < sp.predation.live_prey_encounter_probability) { hunt(a, t, trip, g); return; }
    }
    (a.w.site_memory ??= {})[site.id] = { last_success_portions: 0, last_visit_day: learnDay };
    goHome(a, t, trip, null, 'foraging_return');
  };

  // ---- predation on the continuous clock (v9–v11 rules) ----------------------------------------------
  const capture = (site: Source, members: Agent[], t: number, large: boolean, g: Rng, finder: string, route: string[]): void => {
    const pr = sp.predation, pop = world.ecology.insects_by_site[site.id];
    // v2-review.20 (PR #44 review): without prey each worker walks home along its own outbound route; `route` is the
    // route of the team carrying a captured prey together (chosen by the caller from a carrier that walked it).
    if (g() > pr.live_prey_capture_probability) { events.push({ type: 'prey_escaped', site: site.id, worker: finder, minute: round(t), reason: 'failed_capture', participants: members.map((m) => m.w.id), assumption: true }); for (const m of members) { m.hold = undefined; (m.w.site_memory ??= {})[site.id] = { last_success_portions: 0, last_visit_day: learnDay }; goHome(m, t, ownTrip(m, { site: site.id, route, kind: 'forage', leftAt: t }), null, 'foraging_return'); } return; }
    pop.living--; pop.cumulative_deaths++;
    const quantity = large ? wp.prey.large_prey_protein : wp.prey.small_prey_protein, id = 'HUNT-D' + (world.sim_day + 1) + '-' + site.id + '-' + pop.cumulative_deaths;
    site.batches.push({ event_id: id, original_day: world.sim_day + 1, protein: quantity, age_days: 0, origin: 'captured existing tracked insect; prey-size assumption' });
    site.protein = round(site.batches.reduce((x, b) => x + b.protein, 0));
    events.push({ type: 'insect_predation', site: site.id, event_id: id, team: members.map((m) => m.w.id), minute: round(t), size: large ? 'large' : 'small', count_after: pop.living, assumption: true });
    events.push({ type: 'new_food_source', id, site: site.id, protein_portions: quantity, caused_by_event_id: id, causal_basis: 'tracked live insect predation', assumption: true });
    foodTransfer(events, { minute: round(t), phase: 'foraging', source: { kind: 'insect', id: id }, recipient: { kind: 'source', id: site.id }, food_type: 'protein', portions: quantity, cause: 'prey_kill', attribution: 'individual', basis: 'tracked live insect killed by the hunters; becomes carcass food at the site (portion size: game assumption)' });
    const share = round(quantity / members.length), loads = members.map((_, i) => (i === members.length - 1 ? round(quantity - share * (members.length - 1)) : share));
    if (members.length > 1) events.push({ type: 'joint_prey_transport', site: site.id, event_id: id, minute: round(t), carriers: members.map((m, i) => ({ worker: m.w.id, portions: loads[i] })), assumption: true });
    members.forEach((m, i) => {
      const load = loads[i];
      takeProtein(site, m.w, load, events);
      events.push({ type: 'food_collected', worker: m.w.id, site: site.id, macro: 'protein', portions: load, location: site.id, minute: round(t), prey_event_id: id, assumption: true });
      foodTransfer(events, { minute: round(t), phase: 'foraging', source: { kind: 'source', id: site.id }, recipient: { kind: 'in_transit', id: m.w.id }, food_type: 'protein', portions: load, cause: 'collect', attribution: 'individual', contact: { prey_event_id: id } });
      m.hold = undefined;
      m.stats.handling_minutes = round(m.stats.handling_minutes + ac.protein_handling_minutes);
      seg(m, t, t + ac.protein_handling_minutes, site.id, 'prey_handling', `protein ${load}`);
      // v2-review.20 (PR #44 independent review): a carrier walking the team's route learns the edges it walks there
      goHome(m, round(t + ac.protein_handling_minutes), { site: site.id, route, kind: 'forage', leftAt: t }, { macro: 'protein', load, source: site.id, prey_event_id: id }, members.length > 1 ? 'joint_prey_transport' : 'foraging_return', V20 && members.length > 1);
    });

  };
  const hunt = (a: Agent, t: number, trip: Trip, g: Rng) => {
    const pr = sp.predation, site = world.sources[trip.site], large = g() < wp.prey.large_prey_fraction;
    const free = searching(site.id).filter((x) => x !== a).sort((x, y) => idOrder(x.w.id, y.w.id));
    events.push({ type: 'live_prey_encounter', site: site.id, worker: a.w.id, minute: round(t), prey_size: large ? 'large' : 'small', co_located_team: [a.w.id, ...free.map((x) => x.w.id)], assumption: true });
    let team: Agent[] = [a];
    if (large) {
      // Short-range recruitment (seconds): workers searching this site now join, up to the team cap.
      const room = pr.large_prey_max_team - 1;
      if (free.length <= room) team.push(...free); else { const pool = [...free]; for (let i = 0; i < room; i++) team.push(pool.splice(Math.floor(g() * pool.length), 1)[0]); }
      for (const m of team) if (m !== a) { if (V20) interruptSearch(m, t, 'interrupted_by_prey_recruitment'); m.token++; m.hold = undefined; searchingAt.get(site.id)?.delete(m); }
    }
    if (!large || team.length >= pr.large_prey_min_team) { capture(site, team, t, large, g, a.w.id, trip.route); return; }
    // Long-range recruitment: the finder walks home laying a trail and leads idle nestmates back.
    events.push({ type: 'local_alarm_signal', site: site.id, worker: a.w.id, minute: round(t), short_range_joiners: team.slice(1).map((m) => m.w.id), assumption: true });
    const leg = planLeg(trip.route);
    // v2-review.20 (independent re-review): carrying the prey home ends with unloading, which must also fit the window
    const unloadAfterHunt = V20 ? ac.unload_minutes : 0;
    if (t + 3 * leg + ac.protein_handling_minutes + unloadAfterHunt > W) {
      events.push({ type: 'prey_escaped', site: site.id, worker: a.w.id, minute: round(t), reason: 'insufficient_team_no_time_to_recruit', participants: team.map((m) => m.w.id), assumption: true });
      for (const m of team) goHome(m, t, ownTrip(m, trip), null, 'foraging_return');
      return;
    }
    const resolveAt = round(t + 2 * leg);
    // v2-review.20 (PR #44 independent review): a short-range joiner stays to hold the prey only if it can still walk
    // home along its OWN route inside the window after the hold is resolved and the prey handled; otherwise it leaves now.
    let holders = team.slice(1);
    if (V20) holders = holders.filter((m) => {
      if (resolveAt + ac.protein_handling_minutes + planLeg(ownTrip(m, trip).route) + ac.unload_minutes <= W + 1e-9) return true;
      m.stats.cancelled_no_time++; events.push({ type: 'action_cancelled_no_time', worker: m.w.id, minute: round(t), action: 'hold_prey', assumption: true });
      goHome(m, t, ownTrip(m, trip), null, 'foraging_return');
      return false;
    });
    const hold: PreyHold = { site: site.id, finder: a.w.id, large, g, minute: t, resolveAt, holders: holders.map((m) => m.w.id), recruits: [], joiners: [], finderComes: false, route: trip.route, since: Object.fromEntries(holders.map((m) => [m.w.id, t])), ...(V20 ? { seq: 0 } : {}) };
    holds.push(hold); reserved[site.id] = (reserved[site.id] ?? 0) + 1;
    for (const m of holders) m.hold = hold;
    a.token++;
    if (V20) {
      // v2-review.20 (PR #44 review): the finder lays the trail as it walks home; each edge carries the mark from the
      // minute the finder has walked it (v2-review.19 marked the whole route at the encounter, before it was walked).
      go(a, [...trip.route].reverse(), t, 'hunt_recruit_trail_home', false, { kind: 'home', id: a.w.id, token: a.token, trip: { ...trip, kind: 'hunt_recruit' }, cargo: null, hold },
        { deposit: true, cause: 'hunt_recruit', announce: { type: 'long_range_recruitment_trail', worker: a.w.id, site: site.id, physical_route: trip.route, assumption: true } });
      push({ t: hold.resolveAt, kind: 'resolve', id: a.w.id, token: -1, hold, seq: 0 });
    } else {
      const home = walk(a, [...trip.route].reverse(), t, 'hunt_recruit_trail_home', false);
      depositTrail(colony, sp, trip.route, a.w, events);
      events.push({ type: 'long_range_recruitment_trail', worker: a.w.id, site: site.id, minute: round(home), physical_route: trip.route, assumption: true });
      push({ t: home, kind: 'home', id: a.w.id, token: a.token, trip: { ...trip, kind: 'hunt_recruit' }, cargo: null, hold });
      push({ t: hold.resolveAt, kind: 'resolve', id: a.w.id, token: -1, hold });
    }
  };
  /** The finder of a large prey reached the nest: idle nestmates there follow it back. */
  const leadHuntRecruits = (a: Agent, t: number, hold: PreyHold) => {
    const pr = sp.predation, g = hold.g;
    const pool = [...agents.values()].filter((x) => x !== a && x.state !== 'out' && !((x.busyUntil ?? -1) > t) && x.w.last_location === nest && x.w.task !== 'guard' && x.w.age_days >= sp.task_allocation.newborn_nurse_days).sort((x, y) => idOrder(x.w.id, y.w.id));
    const room = pr.large_prey_max_team - 1 - hold.holders.length;
    const n = Math.min(pool.length ? 1 + Math.floor(g() * Math.min(pool.length, sp.recruitment.recruitment_max_followers)) : 0, room);
    if (!n) {
      a.state = 'nest'; restThenDecide(a, t, true);
      // v2-review.11 switch on: the prey still waits with its holders until the recruits would have arrived; off: it escapes now.
      if (!lateJoin) { for (const q of queue) if (q.kind === 'resolve' && q.hold === hold) q.t = t; queue.sort((x, y) => x.t - y.t || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || idOrder(x.id, y.id)); }
      return;
    }
    // The finder and its recruits walk the marked route together; they arrive when the prey is resolved.
    if (V20) {
      // v2-review.20 (PR #44 independent review): they walk edge by edge on the clock; the hold is resolved by the
      // finder's arrival event (no arrival time is computed in advance). resolveAt is only the planned upper bound.
      hold.finderComes = true; hold.resolveAt = round(t + planLeg(hold.route)); hold.seq = (hold.seq ?? 0) + 1; a.hold = hold; a.state = 'out'; a.departed = t; a.stats.trips++; summary.foraging_trips++;
      a.trip = { site: hold.site, route: hold.route, kind: 'hunt_recruit', leftAt: t };
      go(a, hold.route, t, 'hunt_recruit_lead', true, { kind: 'resolve', id: a.w.id, token: -1, hold, seq: hold.seq });
      for (let i = 0; i < n; i++) {
        const f = pool.splice(Math.floor(g() * pool.length), 1)[0];
        endRest(f, t, 'interrupted_by_recruitment');
        f.departed = t; f.state = 'out'; f.hold = hold; f.token++; f.trip = { site: hold.site, route: hold.route, kind: 'hunt_recruit', leftAt: t }; f.stats.trips++; f.stats.recruited_by = a.w.id; a.stats.recruits_led++; summary.foraging_trips++; summary.recruited++;
        if (f.w.task !== 'forage') { summary.tasks[f.w.task as keyof typeof summary.tasks]--; f.w.task = 'forage'; summary.tasks.forage++; }
        events.push({ type: 'hunt_recruitment', by: a.w.id, to: f.w.id, site: hold.site, minute: round(t), physical_route: hold.route, signal_dependent: true, assumption: true });
        hold.recruits.push(f.w.id);
        go(f, hold.route, t, 'hunt_recruit_follow_trail', true, null);
      }
      return;
    }
    const arrive = walk(a, hold.route, t, 'hunt_recruit_lead', true);
    hold.finderComes = true; hold.resolveAt = arrive; a.hold = hold; a.state = 'out'; a.departed = t; a.stats.trips++; summary.foraging_trips++; hold.since[a.w.id] = arrive;
    if (V20) a.trip = { site: hold.site, route: hold.route, kind: 'hunt_recruit', leftAt: t };
    for (let i = 0; i < n; i++) {
      const f = pool.splice(Math.floor(g() * pool.length), 1)[0];
      endRest(f, t, 'interrupted_by_recruitment');
      walk(f, hold.route, t, 'hunt_recruit_follow_trail', true);
      f.departed = t; hold.since[f.w.id] = arrive; f.state = 'out'; f.hold = hold; f.token++; if (V20) f.trip = { site: hold.site, route: hold.route, kind: 'hunt_recruit', leftAt: t }; f.stats.trips++; f.stats.recruited_by = a.w.id; a.stats.recruits_led++; summary.foraging_trips++; summary.recruited++;
      if (f.w.task !== 'forage') { summary.tasks[f.w.task as keyof typeof summary.tasks]--; f.w.task = 'forage'; summary.tasks.forage++; }
      events.push({ type: 'hunt_recruitment', by: a.w.id, to: f.w.id, site: hold.site, minute: round(t), physical_route: hold.route, signal_dependent: true, assumption: true });
      hold.recruits.push(f.w.id);
    }
    // move the resolve marker to the real arrival minute
    for (const q of queue) if (q.kind === 'resolve' && q.hold === hold) q.t = arrive;
    queue.sort((x, y) => x.t - y.t || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || idOrder(x.id, y.id));
  };
  const resolveHold = (hold: PreyHold, t: number) => {
    holds.splice(holds.indexOf(hold), 1); reserved[hold.site]--;
    const pr = sp.predation, site = world.sources[hold.site];
    const ids = [...hold.holders, ...hold.joiners, ...hold.recruits, ...(hold.finderComes ? [hold.finder] : [])];
    const members = ids.map((id) => agents.get(id) as Agent).filter((m) => m.hold === hold);
    for (const m of members) { const from = hold.since[m.w.id] ?? t; m.stats.prey_holding_minutes = round(m.stats.prey_holding_minutes + Math.max(0, t - from)); if (t > from) seg(m, from, t, hold.site, 'hold_prey'); m.w.last_location = hold.site; }
    const escape = (reason: string) => {
      events.push({ type: 'prey_escaped', site: hold.site, worker: hold.finder, minute: round(t), reason, participants: members.map((m) => m.w.id), assumption: true });
      for (const m of members) { m.hold = undefined; goHome(m, t, ownTrip(m, { site: hold.site, route: hold.route, kind: 'forage', leftAt: t }), null, 'foraging_return'); }
    };
    if (hold.g() < pr.large_prey_escape_while_recruiting_probability) { escape('escaped_while_recruiting'); return; }
    if (members.length < pr.large_prey_min_team) { escape(hold.finderComes ? 'insufficient_team_after_recruitment' : 'insufficient_team_no_recruits'); return; }
    // v2-review.20 (PR #44 review): the team carries the prey home together along a route one of its carriers walked:
    // the finder's marked route when the finder is among them, otherwise the route of the carrier that has been at
    // the prey longest (ties: worker id). Model assumption (game rule); v2-review.19 always used the finder's route.
    let teamRoute = hold.route;
    if (V20 && !members.some((m) => m.w.id === hold.finder)) {
      const first = [...members].sort((x, y) => (hold.since[x.w.id] ?? t) - (hold.since[y.w.id] ?? t) || idOrder(x.w.id, y.w.id))[0];
      teamRoute = first.trip?.route ?? hold.route;
    }
    capture(site, members, t, hold.large, hold.g, hold.finder, teamRoute);
  };

  // ---- back at the nest --------------------------------------------------------------------------------
  const home = (a: Agent, t: number, trip: Trip, cargo: Cargo | null, hold?: PreyHold) => {
    const w = a.w, ls = sp.local_signals;
    w.last_location = nest;
    a.stats.outside_minutes = round(a.stats.outside_minutes + (t - (a.departed ?? t)));
    // v2-review.20 (Issue #43 F05): every outside interval is charged here exactly once, before any branch
    // (the finder of a large prey returning to recruit used to skip this charge).
    if (V20) { summary.extra_sugar_cost = round(summary.extra_sugar_cost + round((t - (a.departed ?? t)) * ac.active_minute_sugar_cost)); a.departed = t; }
    if (hold && hold.finder === w.id && !hold.finderComes) { leadHuntRecruits(a, t, hold); return; }
    a.state = 'nest';
    if (!V20) summary.extra_sugar_cost = round(summary.extra_sugar_cost + round((t - (a.departed ?? t)) * ac.active_minute_sugar_cost));
    if (!cargo) { restThenDecide(a, t, true); return; }
    const g = dice(a, 'unload');
    const transfer = handoff(colony, sp, w, cargo.macro, cargo.load, events, g, cargo.source, t);
    summary.income[cargo.macro] = round(summary.income[cargo.macro] + cargo.load); summary.foraging_successes++; a.stats.successes++;
    (summary.foraging_workers_by_macro as { sugar: Set<string>; protein: Set<string> })[cargo.macro].add(w.id);
    (w.site_memory ??= {})[cargo.source] = { last_success_portions: cargo.load, last_visit_day: learnDay };
    w.local_sensory ??= {}; w.local_sensory.unload_feedback ??= { sugar: ls.unload_feedback_default, protein: ls.unload_feedback_default };
    const ease = clamp(ls.unload_ease_base + ls.unload_ease_contact_weight * (transfer.count / Math.max(1, sp.trophallaxis.max_trophallaxis_contacts)), 0, 1);
    w.local_sensory.unload_feedback[cargo.macro] = round(ls.unload_feedback_previous_weight * w.local_sensory.unload_feedback[cargo.macro] + ls.unload_feedback_today_weight * ease);
    w.local_sensory.last_food_kind = cargo.macro; w.local_sensory.last_unloading_ease = round(ease);
    events.push({ type: 'local_unloading_feedback', worker: w.id, site: cargo.source, macro: cargo.macro, encountered_nestmates: transfer.count, ease: round(ease), minute: round(t), assumption: true });
    const done = round(t + ac.unload_minutes); a.busyUntil = done;
    a.stats.unload_minutes = round(a.stats.unload_minutes + ac.unload_minutes);
    seg(a, t, done, nest, 'unload', `${cargo.macro} ${cargo.load}, ${transfer.count} contacts`);
    // v2-review.23 (R3-05): the marks were laid edge by edge on the walk home (goHome); none is written here.
    if (!V23) depositTrail(colony, sp, trip.route, w, events, V20 ? t : undefined);
    // v2-review.20 (Issue #43 R11): recruitment and the next decision happen when unloading ENDS (minute `done`),
    // with the nestmates actually in the nest at that minute; nothing is committed for the future at minute t.
    if (V20) push({ t: done, kind: 'recruit', id: w.id, token: a.token, trip, cargo, g });
    else recruitAfterUnloading(a, done, trip, cargo, g);
  };
  const recruitAfterUnloading = (a: Agent, done: number, trip: Trip, cargo: Cargo, g: Rng) => {
    const w = a.w;
    // Recruitment (Dejean et al. 2005: a scout that has filled its crop recruits at the nest): only workers
    // physically at the nest and not out, along a trail they can sense, and only after a successful trip.
    // Mailleux et al. 2000/2006 (Lasius niger, other ant, mechanism only): a forager lays trail and recruits only
    // if it filled its crop to its desired volume; a partial load is brought home without recruiting.
    const filled = cargo.macro === 'sugar' ? cargo.load / sp.trophallaxis.crop_capacity >= ac.recruit_min_crop_fill_fraction : true;
    // v2-review.20 (PR #44 independent review): the recruiter does not read the trail on the edges of its route from the
    // nest; it has just marked them itself (v2-review.19 checked every edge, which was always true after its own mark).
    if (filled && g() < sp.recruitment.recruitment_probability && (V20 || fullTrail(colony, sp, trip.route)) && !cargo.prey_event_id) {
      const pool = [...agents.values()].filter((x) => x !== a && x.state !== 'out' && !((x.busyUntil ?? -1) > done) && x.w.last_location === nest && x.w.task !== 'guard' && x.w.age_days >= sp.task_allocation.newborn_nurse_days).sort((x, y) => idOrder(x.w.id, y.w.id));
      const n = pool.length ? 1 + Math.floor(g() * Math.min(pool.length, sp.recruitment.recruitment_max_followers)) : 0;
      if (!n) events.push({ type: 'recruitment_no_nestmate', worker: w.id, site: cargo.source, minute: round(done), assumption: true });
      for (let i = 0; i < n; i++) {
        const f = pool.splice(Math.floor(g() * pool.length), 1)[0];
        if (!fits(trip.route, done)) { events.push({ type: 'recruitment_failed', by: w.id, to: f.w.id, reason: 'no_time_left', minute: round(done), assumption: true }); break; }
        endRest(f, done, 'interrupted_by_recruitment');
        f.token++; f.state = 'out'; f.departed = done; f.stats.trips++; f.stats.recruited_by = w.id; a.stats.recruits_led++; summary.foraging_trips++; summary.recruited++;
        if (f.w.task !== 'forage') { summary.tasks[f.w.task as keyof typeof summary.tasks]--; f.w.task = 'forage'; summary.tasks.forage++; }
        events.push({ type: 'local_recruitment', by: w.id, to: f.w.id, site: cargo.source, physical_route: trip.route, minute: round(done), signal_dependent: true, assumption: true });
        go(f, trip.route, done, 'recruit_follow_trail', true, { kind: 'arrive', id: f.w.id, token: f.token, trip: { site: cargo.source, route: trip.route, kind: 'forage', leftAt: done, recruiter: w.id } });
      }
    }
    // Decide again from what THIS worker sensed (Greenwald et al. 2018, Baltiansky et al. 2023, Camponotus — other
    // ants, mechanism only): after unloading, the forager's chance to leave again rises the more its OWN crop was
    // emptied by the nestmates it met (hungry nestmates take more). Protein is cached, not passed by mouth, so a
    // protein carrier uses the larval begging / protein requests it has itself sensed instead.
    const cues = localSignals(sp, w), crop = clamp((w.crop_cargo_sugar || 0) / sp.trophallaxis.crop_capacity, 0, 1);
    const drive = cargo.macro === 'sugar' ? ac.continue_crop_emptied_weight * (1 - crop) : ac.continue_brood_need_weight * clamp(cues.broodBegging * sp.site_choice.brood_begging_protein_weight + cues.proteinFeedback * sp.site_choice.peer_protein_feedback_weight, 0, 1);
    const p = clamp(ac.continue_base + drive, 0, 1);
    if (g() < p) restThenDecide(a, done, false);
    else stop(a, done, 'own_motivation_after_unloading');
  };

  // ---- run the day ---------------------------------------------------------------------------------------
  for (const w of foragers) { const a = agents.get(w.id) as Agent; push({ t: 0, kind: 'decide', id: w.id, token: a.token }); }
  while (queue.length) {
    const e = queue.shift() as QEvent; clock = e.t;
    if (e.kind === 'trail') { depositTrail(colony, sp, e.edge as [string, string], (agents.get(e.id) as Agent).w, events, e.t, V23 ? { cause: e.cause as string, walked_from: e.walkedFrom as number } : undefined); continue; }
    if (e.kind === 'step') { step(agents.get(e.id) as Agent, e.t, e.walk as WalkPlan); continue; }
    if (e.kind === 'resolve' && e.seq !== undefined && e.seq !== (e.hold as PreyHold).seq) continue; // superseded by the finder's arrival
    if (e.kind === 'resolve') { for (const x of agents.values()) if (x.hold === e.hold) flushLearning(x, e.t); if (holds.includes(e.hold as PreyHold)) resolveHold(e.hold as PreyHold, e.t); continue; }
    const a = agents.get(e.id) as Agent;
    flushLearning(a, e.t);
    if (e.token !== a.token) continue; // superseded (joined a prey hold, recruited)
    if (e.kind === 'decide') {
      endRest(a, e.t);
      if (a.state === 'done') continue;
      const g = dice(a, 'continue_after_failure');
      if (e.afterFailure && g() >= ac.continue_after_failure_probability) { stop(a, e.t, 'gave_up_after_unsuccessful_trip'); continue; }
      decide(a, e.t, !!e.afterFailure);
    } else if (e.kind === 'arrive') arrive(a, e.t, e.trip as Trip);
    else if (e.kind === 'searched') { if (!a.hold) searched(a, e.t, e.trip as Trip); }
    else if (e.kind === 'home') home(a, e.t, e.trip as Trip, e.cargo ?? null, e.hold);
    else if (e.kind === 'recruit') recruitAfterUnloading(a, e.t, e.trip as Trip, e.cargo as Cargo, e.g as Rng);
  }
  // Every worker ends the day in the nest; the activity record of each forager is complete.
  for (const a of agents.values()) {
    flushLearning(a, Infinity);
    if (a.w.last_location !== nest) throw Error(`activity day ended with ${a.w.id} outside the nest (${a.w.last_location})`);
    if (a.stats.trips === 0 && a.state !== 'done') a.stats.stop_reason ??= a.w.task === 'forage' ? 'did_not_depart' : 'in_nest_task';
  }
  const per: Record<string, WorkerActivityStats & { task: string }> = {};
  for (const a of agents.values()) per[a.w.id] = { task: a.w.task, ...a.stats };
  const sum = (k: keyof WorkerActivityStats) => round([...agents.values()].reduce((x, a) => x + (a.stats[k] as number), 0));
  summary.activity = { window_minutes: W, trips: sum('trips'), successes: sum('successes'), outside_minutes: sum('outside_minutes'), travel_minutes: sum('travel_minutes'), search_minutes: sum('search_minutes'), handling_minutes: sum('handling_minutes'), prey_holding_minutes: sum('prey_holding_minutes'), unload_minutes: sum('unload_minutes'), cancelled_no_time: sum('cancelled_no_time'), no_route: sum('no_route'), explorations: sum('explorations'), workers: per };
}

/** Edges of the world map whose length is recorded (others use the legacy minutes): for reports and tests. */
export function edgeLengthCoverage(wp: WorldParams): { known: string[]; unknown: string[] } {
  const all = [...new Set(wp.routes.edges.map(([a, b]) => edgeKey(a, b)))].sort();
  void adjacencyOf;
  return { known: all.filter((k) => wp.routes.edge_length_cm[k] !== undefined), unknown: all.filter((k) => wp.routes.edge_length_cm[k] === undefined) };
}
