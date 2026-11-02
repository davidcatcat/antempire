/**
 * v2-review.14 (#8): individual route memory and local exploration (species switch
 * navigation.individual_route_memory).
 *
 * The WORLD knows the whole route graph (world routes.topology.edges); a WORKER does not. A worker can
 * plan a route only over the edges it has physically walked (its own route memory). At the node where it
 * stands it perceives the edges leaving that node (and, separately, any detectable trail pheromone on them);
 * it never sees nodes or edges further away. Edges are learned only by walking them (routes.travel()).
 *
 * Abstraction limits (game assumptions, see docs/gm-rules.md v2-review.14):
 *  - memory is a set of walked edges plus how/when each was learned; there is no forgetting yet (no data for
 *    this species), so a learned edge stays usable after its pheromone has decayed;
 *  - a learned edge is remembered in both directions (the worker walked it out and back);
 *  - the worker does not remember metric distances; among remembered routes it takes the one with fewest edges.
 */
import { adjacencyOf, edgeKey } from './routes.ts';
import type { WorldParams } from './params.ts';
import type { ColonyState, SimEvent, Worker } from './types.ts';

export type EdgeAcquisition = 'walked' | 'trail_followed' | 'recruit_followed' | 'explored' | 'day14_history';
export interface EdgeMemory { acquired: EdgeAcquisition; first_day: number; last_day: number }
export interface RouteMemory {
  origin: string;
  edges: Record<string, EdgeMemory>;
  /** Sites this worker reached and found without any food source (dead host, nothing there), by day. */
  empty_sites: Record<string, number>;
}

const memoryOf = (w: Worker): RouteMemory | undefined => w.route_memory as RouteMemory | undefined;

/** How an edge walked in a trip of `kind` was learned. */
export function acquisitionOf(kind: string): EdgeAcquisition {
  if (kind.includes('recruit')) return 'recruit_followed';
  if (kind.startsWith('trail_follow')) return 'trail_followed';
  if (kind.startsWith('explore')) return 'explored';
  return 'walked';
}

/** Record the edges of a route the worker has just physically walked. */
export function learnRoute(worker: Worker, route: string[], kind: string, day: number): void {
  const mem = memoryOf(worker);
  if (!mem) return;
  for (let i = 1; i < route.length; i++) {
    const k = edgeKey(route[i - 1], route[i]), e = mem.edges[k];
    if (e) e.last_day = day;
    else mem.edges[k] = { acquired: acquisitionOf(kind), first_day: day, last_day: day };
  }
}

export const knowsEdge = (worker: Worker, a: string, b: string): boolean => !!memoryOf(worker)?.edges[edgeKey(a, b)];

/** Adjacency of the worker's own remembered edges (sorted for determinism). */
function ownAdjacency(worker: Worker): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const k of Object.keys(memoryOf(worker)?.edges ?? {}).sort()) {
    const [a, b] = k.split(':');
    (adj[a] ??= []).push(b); (adj[b] ??= []).push(a);
  }
  for (const n of Object.keys(adj)) adj[n].sort();
  return adj;
}

/** Fewest-edge route from `from` to `site` using ONLY the worker's remembered edges; null if it knows none. */
export function knownRoute(worker: Worker, from: string, site: string): string[] | null {
  if (from === site) return [from];
  const adj = ownAdjacency(worker), queue = [[from]], seen = new Set([from]);
  while (queue.length) {
    const route = queue.shift() as string[], at = route.at(-1) as string;
    for (const n of adj[at] ?? []) {
      if (seen.has(n)) continue;
      if (n === site) return [...route, n];
      seen.add(n); queue.push([...route, n]);
    }
  }
  return null;
}

/** Nodes the worker can reach from `from` over remembered edges, including `from` (sorted). */
export function knownNodes(worker: Worker, from: string): string[] {
  const adj = ownAdjacency(worker), seen = new Set([from]), queue = [from];
  while (queue.length) for (const n of adj[queue.shift() as string] ?? []) if (!seen.has(n)) { seen.add(n); queue.push(n); }
  return [...seen].sort();
}

/** Edges leaving `node` that the worker perceives on arrival there but has never walked (sorted). */
export function unknownExits(worker: Worker, wp: WorldParams, node: string): string[] {
  return [...(adjacencyOf(wp)[node] ?? [])].filter((n) => !knowsEdge(worker, node, n)).sort();
}

export const markEmpty = (worker: Worker, site: string, day: number): void => { const m = memoryOf(worker); if (m) m.empty_sites[site] = day; };
export const knownEmpty = (worker: Worker, site: string): boolean => site in (memoryOf(worker)?.empty_sites ?? {});

/**
 * Give every worker without a route memory one: the edges the official Day1–14 record shows THIS worker walked
 * (world day15_migration.worker_route_evidence, each with its citation), otherwise none. Workers eclosed in the
 * simulation start with none. Nothing is derived from the world map.
 */
export function ensureRouteMemory(colony: ColonyState, wp: WorldParams, day: number, events: SimEvent[]): void {
  const evidence = wp.route_evidence;
  for (const w of colony.population.workers) {
    if (w.route_memory) continue;
    // v2-review.15: Day14 route evidence belongs to the workers that lived in Day1–14, never to a worker that
    // eclosed in the simulation and happens to reuse a number (Day0 worlds number workers from W001).
    const rec = w.age_origin === 'born_after_v2_migration' ? undefined : evidence[w.id];
    const mem: RouteMemory = { origin: rec ? 'day14_history_evidence' : w.age_origin === 'born_after_v2_migration' ? 'eclosed_in_simulation' : 'no_recorded_route', edges: {}, empty_sites: {} };
    for (const k of rec?.edges ?? []) mem.edges[k] = { acquired: 'day14_history', first_day: 14, last_day: 14 };
    w.route_memory = mem;
    events.push({ type: 'route_memory_initialized', worker: w.id, origin: mem.origin, edges: Object.keys(mem.edges), evidence: rec?.citations ?? [], day, assumption: true });
  }
}
