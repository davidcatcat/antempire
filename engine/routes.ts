/**
 * Physical garden space: an undirected graph of walkable route edges (world parameter
 * routes.topology.edges). Workers move edge by edge; time per edge is world routes.route_edge_minutes
 * and the daily activity window is the species' foraging_activity.daily_window_minutes.
 */
import { round } from './math.ts';
import type { SpeciesParams, WorldParams } from './params.ts';
import type { SimEvent, Worker } from './types.ts';

export type Adjacency = Record<string, string[]>;
const cache = new WeakMap<object, Adjacency>();

/** Adjacency lists in edge-insertion order (identical to the v6 module-level build). */
export function adjacencyOf(wp: WorldParams): Adjacency {
  let adj = cache.get(wp.routes.edges);
  if (!adj) {
    adj = {};
    for (const [a, b] of wp.routes.edges) { (adj[a] ??= []).push(b); (adj[b] ??= []).push(a); }
    cache.set(wp.routes.edges, adj);
  }
  return adj;
}

export const edgeKey = (a: string, b: string): string => [a, b].sort().join(':');

/** Breadth-first shortest route from the colony's nest node to `site`; null if unreachable. */
export function routeTo(wp: WorldParams, nest: string, site: string): string[] | null {
  const adjacency = adjacencyOf(wp);
  if (!adjacency[site]) return null;
  const queue = [[nest]], visited = new Set([nest]);
  while (queue.length) {
    const route = queue.shift() as string[], from = route.at(-1) as string;
    if (from === site) return route;
    for (const next of adjacency[from] ?? []) if (!visited.has(next)) { visited.add(next); queue.push([...route, next]); }
  }
  return null;
}

export const routeEdges = (route: string[]): string[] => route.slice(1).map((n, i) => edgeKey(route[i], n));

export interface Trip { arrive: number; back: number; one: number }

/** Walk outbound along `route`; null (no teleporting) if the round trip does not fit today's window. */
export function travel(sp: SpeciesParams, wp: WorldParams, worker: Worker, route: string[], events: SimEvent[], kind: string, offset = 0): Trip | null {
  const edgeMinutes = wp.routes.route_edge_minutes;
  const one = (route.length - 1) * edgeMinutes, arrive = one + offset, back = arrive + one;
  if (back > sp.foraging_activity.daily_window_minutes) return null;
  for (let i = 1; i < route.length; i++) events.push({ type: 'route_step', worker: worker.id, from: route[i - 1], to: route[i], minute: round(offset + i * edgeMinutes), kind, assumption: true });
  worker.last_location = route.at(-1) as string;
  return { arrive, back, one };
}

/** Walk back to the first node of `route` (the nest). */
export function goHome(wp: WorldParams, worker: Worker, route: string[], events: SimEvent[], kind: string, depart: number): void {
  const edgeMinutes = wp.routes.route_edge_minutes;
  for (let i = route.length - 1; i > 0; i--) events.push({ type: 'route_step', worker: worker.id, from: route[i], to: route[i - 1], minute: round(depart + (route.length - i) * edgeMinutes), kind, assumption: true });
  worker.last_location = route[0];
}
