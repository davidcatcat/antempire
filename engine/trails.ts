/**
 * One colony's pheromone trails on route edges (single-signal model; species parameters
 * recruitment.trail_*). Trails belong to the colony, so different colonies never read each other's.
 */
import { round } from './math.ts';
import { adjacencyOf, edgeKey, routeEdges } from './routes.ts';
import type { Rng } from './rng.ts';
import type { SpeciesParams, WorldParams } from './params.ts';
import type { ColonyState, SimEvent, Source, Worker } from './types.ts';
import { knownEmpty } from './navigation.ts';

export function decayTrails(colony: ColonyState, sp: SpeciesParams, events: SimEvent[]): void {
  const trails = colony.trail_by_edge, r = sp.recruitment.trail_daily_retention, limit = sp.recruitment.trail_min_detectable;
  for (const [edge, old] of Object.entries(trails)) {
    const v = round(old * r);
    if (v < limit) delete trails[edge]; else trails[edge] = v;
    events.push({ type: 'trail_decay', edge, from: old, to: v, assumption: true });
  }
}

/** A worker who successfully delivered food marks every edge it walked. `minute` (v2-review.20, activity timeline):
 *  the minute the marks exist from; recorded in the event so that every later trail reading can be checked against it. */
export function depositTrail(colony: ColonyState, sp: SpeciesParams, route: string[], worker: Worker, events: SimEvent[], minute?: number, local?: { cause: string; walked_from: number }): void {
  const trails = colony.trail_by_edge;
  for (const edge of routeEdges(route)) {
    const before = trails[edge] || 0;
    trails[edge] = round(Math.min(sp.recruitment.trail_max_strength, before + sp.recruitment.trail_deposit_per_success));
    // v2-review.23 (Codex Issue #61 R3-05): a mark laid by a worker on the edge it is walking also records how much it
    // added (`deposited`, after the cap), why it marked (`cause`) and the minutes it was on that edge (`walked_from`..`minute`).
    events.push({ type: 'trail_deposited', edge, worker: worker.id, intensity: trails[edge], ...(minute === undefined ? {} : { minute: round(minute) }), ...(local ? { deposited: round(trails[edge] - before), cause: local.cause, walked_from: round(local.walked_from), on_edge: true } : {}), assumption: true });
  }
}

/** True only if every edge of the route still carries a detectable signal. */
export function fullTrail(colony: ColonyState, sp: SpeciesParams, route: string[] | null): boolean {
  return !!route && routeEdges(route).every((k) => (colony.trail_by_edge[k] || 0) >= sp.recruitment.trail_min_detectable);
}

/**
 * A worker without a known source follows detectable trail edges outward from the nest, choosing each
 * hop by local signal strength only (it senses only the edges leaving the node it stands on). Returns the
 * first non-empty source reached, or null. The route is learned only when the worker walks it.
 */
export function followLocalTrail(world: { sources: Record<string, Source> }, colony: ColonyState, sp: SpeciesParams, wp: WorldParams, worker: Worker, g: Rng, events: SimEvent[], ownPerception = false): { source: Source; route: string[] } | null {
  const adjacency = adjacencyOf(wp), trails = colony.trail_by_edge, limit = sp.recruitment.trail_min_detectable;
  let at = colony.nest_node;
  const path = [at], seen = new Set([at]);
  for (let hop = 0; hop < sp.recruitment.trail_follow_max_hops; hop++) {
    const neighbors = (adjacency[at] || []).filter((n) => !seen.has(n) && (trails[edgeKey(at, n)] || 0) >= limit);
    if (!neighbors.length) return null;
    const sum = neighbors.reduce((a, n) => a + trails[edgeKey(at, n)], 0);
    let draw = g() * sum, next = neighbors.at(-1) as string;
    for (const n of neighbors) { draw -= trails[edgeKey(at, n)]; if (draw <= 0) { next = n; break; } }
    events.push({ type: 'local_trail_choice', worker: worker.id, from: at, to: next, local_signal: trails[edgeKey(at, next)], assumption: true });
    at = next; path.push(at); seen.add(at);
    const source = world.sources[at];
    // v2-review.14 (ownPerception): whether this node has food is judged from what the worker perceives on
    // arrival and its own memory, not from the colony's bookkeeping flag.
    if (!source || (ownPerception ? source.host_alive === false || knownEmpty(worker, at) : colony.source_knowledge[at]?.presence === 'scouted_empty')) continue;
    const outgoing = (adjacency[at] || []).filter((n) => !seen.has(n) && (trails[edgeKey(at, n)] || 0) >= limit);
    if (outgoing.length && g() < sp.recruitment.follow_intermediate_source_probability) continue;
    return { source, route: path };
  }
  return null;
}
