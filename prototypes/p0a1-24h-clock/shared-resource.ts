/**
 * P0-A1 / Issue #9 option A — several colonies on ONE world event axis, sharing a resource (isolated experiment;
 * docs/p0a1-24h-clock.md §7). Not a behaviour model and not wired into the official day loop.
 *
 * Every colony's events are root events on the same WorldScheduler as the environment clock, each on its own native
 * clock (seconds or minutes, its own anchor). The scheduler orders them by exact time; it never runs one colony's day
 * before another's. Each scheduler batch reaches this observer as ONE set (ClockRun.foreign). Arrivals at one resource
 * at the SAME exact instant are a contest whose outcome is undecided biology: the observer records an explicit
 * `contest_unresolved` event with the participants as a set and NO winner — no array order, id order, equal split or
 * random rotation decides it (no contest rule exists; Owner / literature decision). Nothing is consumed here.
 * Arrivals in one tick-merged batch with DIFFERENT exact instants are not simultaneous and are not a contest.
 */
import type { BatchContext, EventSpec, ExactTime, JsonValue, NativeTime, StepOutput, WorldEvent } from '../../engine/scheduler/world-events.ts';

export interface Arrival { colony: string; individual: string; resource: string; seq: number; native: NativeTime }
export const arrivalSpec = (world: string, a: Arrival): EventSpec => ({
  kind: 'resource_arrival', key: `${a.colony}.${a.individual}.${a.resource}.${a.seq}`, native: a.native,
  scope: { world, colony: a.colony, individual: a.individual }, source: { world, colony: a.colony, individual: a.individual }, target: null,
  payload: { resource: a.resource },
});
const exactKey = (x: ExactTime) => `${x.day}|${x.us}|${x.us_lo}`;

export interface Visit { id: string; colony: string; individual: string; resource: string; exact: ExactTime; simultaneous_with: number }
export interface Contest { id: string; resource: string; exact: ExactTime; participants: { colony: string; individual: string; arrival: string }[]; resolution: 'unresolved'; rule: null }

export class SharedResourceObserver {
  visits: Visit[] = []; contests: Contest[] = []; batchesSeen = 0; mergedBatches = 0;
  readonly hook = (batch: readonly Readonly<WorldEvent>[], ctx: BatchContext): StepOutput | void => {
    this.batchesSeen++; if (ctx.distinct_instants > 1) this.mergedBatches++;
    const children: NonNullable<StepOutput['children']> = [];
    const groups = new Map<string, Readonly<WorldEvent>[]>();
    for (const e of batch) {
      if (e.kind === 'contest_unresolved') { const p = e.payload as Record<string, JsonValue>; this.contests.push({ id: e.id, resource: p.resource as string, exact: { ...e.exact }, participants: (p.participants as Contest['participants']).map((x) => ({ ...x })), resolution: 'unresolved', rule: null }); continue; }
      if (e.kind !== 'resource_arrival') throw Error(`shared-resource observer: unexpected ${e.kind}`);
      // simultaneity = identical exact instant at the same resource (never the tick label)
      const k = `${(e.payload as Record<string, JsonValue>).resource}#${exactKey(e.exact)}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(e);
    }
    for (const g of groups.values()) {
      const resource = (g[0].payload as Record<string, JsonValue>).resource as string;
      for (const e of g) this.visits.push({ id: e.id, colony: e.scope.colony!, individual: e.scope.individual!, resource, exact: { ...e.exact }, simultaneous_with: g.length - 1 });
      if (g.length < 2) continue;
      // the participants are a SET: listed in a canonical order only so the record is deterministic; the order means nothing
      const participants = g.map((e) => ({ colony: e.scope.colony!, individual: e.scope.individual!, arrival: e.id })).sort((a, b) => (a.arrival < b.arrival ? -1 : 1));
      const cause = participants[0].arrival; // the cause field must name one event of the batch: a label, not a winner
      children.push({ cause, spec: { kind: 'contest_unresolved', key: `${resource}.n${g.length}`, native: g[0].native, scope: { world: g[0].scope.world, colony: null, individual: null }, source: null, target: null,
        payload: { resource, participants, resolution: 'unresolved', rule: null, note: 'simultaneous arrivals at one resource; no contest rule exists (no array-order, id, equal-split or random-rotation winner)' } } });
    }
    return children.length ? { children } : undefined;
  };
}
