/**
 * P0-A0 time contract — MEASUREMENT of candidate world-time contracts (docs/p0a0-time-contract.md).
 *
 * Status: ISOLATED analysis code (tests/scheduler-isolation.test.ts). Given events with their exact instants (from
 * world-events.ts exactOf), it reports what a candidate contract would do to their order: an integer tick of 60 µs,
 * 1 µs, 1 ns (or any ratio), or the layered order (exact instant). Nothing here schedules, draws or decides anything.
 *
 * "Merged pair": two events with DIFFERENT exact instants put into one batch (their order is lost: a handler sees a set).
 * "Id-order flip": a merged pair whose canonical-id order is the reverse of the true order (a consumer that walks a
 * batch by id, as engine/activity.ts walks ties by kind / worker id, would process them in the wrong causal order).
 * Pure quantisation of exact instants is monotone, so it can merge but never invert distinct batches; inversions come
 * from rounding delays separately (world-events.ts addMinutes) and are counted by the scheduler's own detector.
 */
import { type ExactTime, US_PER_DAY, nearestDiv, compareExact } from './world-events.ts';

/** a candidate contract: an integer tick (num/den ticks per µs) or the layered order (exact instant, no tick) */
export interface TimeContract { name: string; kind: 'tick' | 'layered'; ticks_per_us: readonly [number, number] | null }
export const tickContract = (name: string, num: number, den: number): TimeContract => {
  if (!(Number.isSafeInteger(num) && num > 0 && Number.isSafeInteger(den) && den > 0)) throw Error(`TIME_CONTRACT: tick ratio ${num}/${den} must be positive integers`);
  if (!Number.isSafeInteger((US_PER_DAY * num) / den) || (US_PER_DAY * num) / den >= 2 ** 51) throw Error(`TIME_CONTRACT: ${name} has more ticks per day than can be held exactly`);
  return { name, kind: 'tick', ticks_per_us: [num, den] };
};
export const CANDIDATE_CONTRACTS: readonly TimeContract[] = [
  tickContract('tick 60 µs', 1, 60), tickContract('tick 1 µs', 1, 1), tickContract('tick 1 ns', 1000, 1),
  { name: 'layered', kind: 'layered', ticks_per_us: null },
];

export interface TimedItem { id: string; exact: ExactTime; entities: readonly string[] }
export interface ContractResult {
  contract: string; events: number; distinct_instants: number; batches: number;
  merged_batches: number; events_in_merged_batches: number; merged_pairs: number; merged_pairs_shared_entity: number;
  id_order_flips: number; max_key_error_us: number; smallest_merged_gap_us: number | null;
}

/** the tick key of an exact instant: nearest tick (ties up); a tick that is 24:00 belongs to the next day */
export function tickKey(x: ExactTime, ratio: readonly [number, number]): { day: number; q: number } {
  const perDay = (US_PER_DAY * ratio[0]) / ratio[1];
  const q = nearestDiv(x.us, x.us_lo, ratio[0], ratio[1]);
  return q >= perDay ? { day: x.day + 1, q: q - perDay } : { day: x.day, q };
}
const gapUs = (a: ExactTime, b: ExactTime) => ((b.day - a.day) * US_PER_DAY + (b.us - a.us)) + (b.us_lo - a.us_lo);

export function evaluateContract(items: readonly TimedItem[], c: TimeContract): ContractResult {
  const keyed = items.map((it) => {
    if (c.kind === 'layered') return { it, kd: it.exact.day, kq: 0, err: 0 };
    const k = tickKey(it.exact, c.ticks_per_us!);
    const keyUs = ((k.day - it.exact.day) * US_PER_DAY + (k.q * c.ticks_per_us![1]) / c.ticks_per_us![0] - it.exact.us) - it.exact.us_lo;
    return { it, kd: k.day, kq: k.q, err: Math.abs(keyUs) };
  });
  const sameKey = (a: (typeof keyed)[number], b: (typeof keyed)[number]) => a.kd === b.kd && (c.kind === 'layered' ? compareExact(a.it.exact, b.it.exact) === 0 : a.kq === b.kq);
  keyed.sort((a, b) => a.kd - b.kd || a.kq - b.kq || compareExact(a.it.exact, b.it.exact) || (a.it.id < b.it.id ? -1 : a.it.id > b.it.id ? 1 : 0));
  const r: ContractResult = { contract: c.name, events: items.length, distinct_instants: 0, batches: 0, merged_batches: 0, events_in_merged_batches: 0, merged_pairs: 0, merged_pairs_shared_entity: 0, id_order_flips: 0, max_key_error_us: 0, smallest_merged_gap_us: null };
  for (let i = 0; i < keyed.length; i++) { r.max_key_error_us = Math.max(r.max_key_error_us, keyed[i].err); if (i === 0 || compareExact(keyed[i].it.exact, keyed[i - 1].it.exact) !== 0) r.distinct_instants++; }
  for (let i = 0; i < keyed.length;) {
    let j = i + 1; while (j < keyed.length && sameKey(keyed[j], keyed[i])) j++;
    r.batches++;
    const g = keyed.slice(i, j).map((x) => x.it);
    let distinct = 1; for (let k = 1; k < g.length; k++) if (compareExact(g[k].exact, g[k - 1].exact) !== 0) distinct++;
    if (distinct > 1) {
      r.merged_batches++; r.events_in_merged_batches += g.length;
      for (let a = 0; a < g.length; a++) for (let b = a + 1; b < g.length; b++) {
        const o = compareExact(g[a].exact, g[b].exact); if (o === 0) continue;
        r.merged_pairs++;
        if (g[a].entities.some((e) => g[b].entities.includes(e))) r.merged_pairs_shared_entity++;
        if ((g[a].id < g[b].id) !== (o < 0)) r.id_order_flips++;
        const gap = Math.abs(gapUs(g[a].exact, g[b].exact)); if (r.smallest_merged_gap_us === null || gap < r.smallest_merged_gap_us) r.smallest_merged_gap_us = gap;
      }
    }
    i = j;
  }
  return r;
}
