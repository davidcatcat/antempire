/**
 * #9 work package C — evidence for the multi-colony world timeline. Two parts:
 *  A. the CURRENT engine (official rules, unchanged): two identical colonies whose only difference is their
 *     position in colonies[]; the colony processed first collects more food in most seeds. Recorded as evidence
 *     of the defect (the assertion is that the bias EXISTS, so the test documents it rather than hides it);
 *  B. the PROTOTYPE (prototypes/multi-colony-timeline/timeline.ts, not used by the engine):
 *     1. permutation invariance: shuffling the arrivals or swapping the colony order changes nothing;
 *     2. time order: whoever arrives first takes first; nothing is taken before its arrival minute;
 *     3. simultaneous arrivals: neutral sharing, exact conservation, stock never negative;
 *     4. the sequential (current) resolution reproduces the order bias on the same inputs;
 *     5. species differences only through parameters (a faster walker arrives earlier and takes first);
 *     6. a foreign chemical mark is sensed only by a worker that actually reached that site.
 */
import assert from 'node:assert/strict';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta, type WorldState } from '../engine/index.ts';
import { loadBundle, readJson } from '../cli/lib/load.ts';
import { resolveTimeline, sequentialByColony, arrivalMinute, type Arrival } from '../prototypes/multi-colony-timeline/timeline.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

// A. current engine order bias (10 days, 20 seeds)
const b = loadBundle(), meta = legacyColonyMeta(b.world.scenario_colonies as Any), fx = readJson('tests/fixtures/day14-projection.json');
function twoColonies(seed: number, order: 'AB' | 'BA'): WorldState {
  const s = structuredClone(fx); s.seed = seed;
  const w = legacyToWorldState(s, meta), A = w.colonies[0], B = structuredClone(A);
  Object.assign(B, { id: 'B', queen_id: 'B-Q', rng_namespace: 'B|', worker_id_prefix: 'B-W', egg_id_prefix: 'B-E' });
  B.population.workers = B.population.workers.map((x: Any) => ({ ...x, id: 'B-' + x.id }));
  B.population.brood = B.population.brood.map((x: Any) => ({ ...x, id: 'B-' + x.id }));
  for (const k of Object.values(B.source_knowledge) as Any[]) k.known_by = k.known_by.map((id: string) => 'B-' + id);
  w.colonies = order === 'AB' ? [A, B] : [B, A];
  return w;
}
let firstAhead = 0, firstBehind = 0, sumAdvantage = 0;
const seedsRows: Any[] = [];
for (let seed = 15032026; seed < 15032046; seed++) {
  const inc: Record<string, Record<string, number>> = {};
  for (const order of ['AB', 'BA'] as const) {
    let w = twoColonies(seed, order); const tot: Record<string, number> = { MAIN: 0, B: 0 };
    for (let d = 0; d < 10; d++) { const o = simulateWorldDay(w, b); for (const c of o.result.colonies) tot[c.colony_id] += c.summary.income.sugar + c.summary.income.protein; w = o.state; }
    inc[order] = tot;
  }
  const adv = (inc.AB.MAIN - inc.AB.B) + (inc.BA.B - inc.BA.MAIN);
  if (adv > 1e-9) firstAhead++; else if (adv < -1e-9) firstBehind++;
  sumAdvantage += adv; seedsRows.push({ seed, first_position_advantage_portions: Math.round(adv * 1e3) / 1e3 });
}
ok(firstAhead > firstBehind, `current engine: the colony processed first collects more in ${firstAhead}/20 seeds (defect #9 documented, not fixed here)`);

// B. prototype
function rng(seed: number) { let x = seed >>> 0; return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; }; }
function randomArrivals(seed: number): { arrivals: Arrival[]; stock: Record<string, number> } {
  const g = rng(seed), sites = ['F01', 'F07', 'F08'], arrivals: Arrival[] = [];
  for (const colony of ['A', 'B', 'C']) for (let i = 0; i < 6; i++) arrivals.push({ colony, worker: 'W' + i, site: sites[Math.floor(g() * 3)], minute: 25 * (1 + 2 * Math.floor(g() * 3)), capacity: Math.round((0.2 + g() * 0.5) * 1e4) / 1e4 });
  return { arrivals, stock: { F01: Math.round(g() * 2 * 1e4) / 1e4, F07: Math.round(g() * 2 * 1e4) / 1e4, F08: Math.round(g() * 2 * 1e4) / 1e4 } };
}
const norm = (r: ReturnType<typeof resolveTimeline>) => JSON.stringify({ t: [...r.takes].sort((a, b) => (a.colony + a.worker + a.minute).localeCompare(b.colony + b.worker + b.minute)), e: r.encounters, s: r.stock_after });
for (let seed = 1; seed <= 200; seed++) {
  const { arrivals, stock } = randomArrivals(seed), g = rng(seed + 999);
  const shuffled = [...arrivals].sort(() => g() - 0.5), reversed = [...arrivals].reverse();
  const r = resolveTimeline(arrivals, stock);
  ok(norm(r) === norm(resolveTimeline(shuffled, stock)) && norm(r) === norm(resolveTimeline(reversed, stock)), `seed ${seed}: result independent of arrival / colony order`);
  // relabel colonies A<->B: outcomes swap exactly
  const swap = (c: string) => (c === 'A' ? 'B' : c === 'B' ? 'A' : c);
  const rs = resolveTimeline(arrivals.map((a) => ({ ...a, colony: swap(a.colony) })), stock);
  const byC = (x: ReturnType<typeof resolveTimeline>, c: string) => Math.round(x.takes.filter((t) => t.colony === c).reduce((s, t) => s + t.taken, 0) * 1e6);
  ok(byC(r, 'A') === byC(rs, 'B') && byC(r, 'B') === byC(rs, 'A'), `seed ${seed}: relabelling colonies swaps their outcomes exactly`);
  for (const site of Object.keys(stock)) {
    const taken = r.takes.filter((t) => t.site === site).reduce((s, t) => s + t.taken, 0);
    ok(Math.abs(taken + r.stock_after[site] - stock[site]) < 1e-9 && r.stock_after[site] >= -1e-12, `seed ${seed} ${site}: exact conservation, stock never negative`);
  }
  ok(r.takes.every((t) => arrivals.some((a) => a.colony === t.colony && a.worker === t.worker && a.site === t.site && a.minute === t.minute)), `seed ${seed}: every take happens at its own arrival minute (no earlier)`);
}
{
  const r = resolveTimeline([{ colony: 'A', worker: 'a', site: 'S', minute: 75, capacity: 1 }, { colony: 'B', worker: 'b', site: 'S', minute: 25, capacity: 1 }], { S: 1.2 });
  ok(r.takes.find((t) => t.colony === 'B')?.taken === 1 && Math.abs((r.takes.find((t) => t.colony === 'A')?.taken ?? 0) - 0.2) < 1e-9, 'the earlier arrival takes first even if its colony is listed second');
  const s = resolveTimeline([{ colony: 'A', worker: 'a', site: 'S', minute: 25, capacity: 1 }, { colony: 'B', worker: 'b', site: 'S', minute: 25, capacity: 1 }], { S: 1 });
  ok(s.takes.every((t) => t.taken === 0.5) && s.encounters.length === 1 && s.encounters[0].colonies.join() === 'A,B', 'same minute, same capacity: equal shares and a recorded encounter (no fighting modelled)');
  const seq = sequentialByColony([{ colony: 'A', worker: 'a', site: 'S', minute: 25, capacity: 1 }, { colony: 'B', worker: 'b', site: 'S', minute: 25, capacity: 1 }], ['A', 'B'], { S: 1 });
  ok(seq.takes.find((t) => t.colony === 'A')?.taken === 1 && seq.takes.find((t) => t.colony === 'B')?.taken === 0, 'the current sequential resolution gives everything to the colony listed first (the #9 defect)');
  const fast = arrivalMinute(2, 25, 2), slow = arrivalMinute(2, 25, 1);
  const sp = resolveTimeline([{ colony: 'slow', worker: 'x', site: 'S', minute: slow, capacity: 1 }, { colony: 'fast', worker: 'y', site: 'S', minute: fast, capacity: 1 }], { S: 1 });
  ok(fast < slow && sp.takes.find((t) => t.colony === 'fast')?.taken === 1, 'a species parameter (walking speed) makes the faster colony arrive and take first; no species names in code');
  const m = resolveTimeline([{ colony: 'A', worker: 'a', site: 'S', minute: 25, capacity: 0.1 }, { colony: 'A', worker: 'b', site: 'T', minute: 25, capacity: 0.1 }], { S: 1, T: 1 }, { S: [{ colony: 'B', intensity: 0.7 }] });
  ok(m.marks_sensed.length === 1 && m.marks_sensed[0].worker === 'a' && m.marks_sensed[0].site === 'S', "a foreign mark is sensed only by the worker that reached that site (no broadcast to the colony)");
}
console.log(JSON.stringify({ passed: true, checks, current_engine_order_bias: { first_listed_colony_ahead: firstAhead, behind: firstBehind, mean_advantage_portions_per_10_days: Math.round(sumAdvantage / 20 * 1e3) / 1e3 }, seeds: seedsRows }, null, 2));
