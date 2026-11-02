/**
 * v2-review.17 individual activity timeline (engine/activity.ts). For every worker and every day the record
 * worker -> time -> place -> action -> duration -> outcome is rebuilt from the events and audited:
 *  1. a worker is never in two places at once (its activity segments never overlap);
 *  2. it leaves the nest only from the nest, and only after it has come back from the previous trip;
 *  3. it collects only at a site it has reached and before it walks away;
 *  4. it unloads only at the nest after walking back, each load exactly once, the same portions it collected;
 *  5. nothing outlasts the daily activity window;
 *  6. a recruit leaves only when its recruiter is back at the nest, along the recruiter's route;
 *  7. food is never counted twice: collected = delivered = colony income, per day.
 * Runs on Day0 worlds (A1–A3, 4 seasons, 5 seeds, 60 days) and on the Day14 fixture (20 seeds, 40 days).
 * Plus: travel time from recorded lengths, unknown lengths keep the legacy minutes, trips per day are an outcome
 * (abundant food at the nest vs food only far away), the computation limit is a guard, switch off = old model.
 */
import assert from 'node:assert/strict';
import { simulateWorldDay, simulateDay, resolveBundle, type SimEvent, type WorldState, type ParamBundle, type LegacyV2State } from '../engine/index.ts';
import { edgeMinutes } from '../engine/activity.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0, seasonStart, SEASONS, SUPPORTED_FOUNDINGS } from '../cli/lib/day0.ts';
import { fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const EPS = 1e-6;
const DEPART = /depart|recruit_follow_trail|hunt_recruit_follow_trail|hunt_recruit_lead/;
const RETURN = /return|joint_prey_transport|hunt_recruit_trail_home/;

let audited = 0, segments = 0, maxTrips = 0;
function audit(ev: SimEvent[], summary: Any, W: number, nest: string, label: string): void {
  const byWorker = new Map<string, Any[]>();
  for (const e of ev.filter((x) => x.type === 'worker_activity') as Any[]) (byWorker.get(e.worker) ?? byWorker.set(e.worker, []).get(e.worker) as Any[]).push(e);
  for (const [id, segs] of byWorker) {
    segs.sort((a, b) => a.start - b.start || a.end - b.end);
    let where = nest, end = 0, trips = 0;
    for (const s of segs) {
      assert.ok(s.start >= end - EPS, `${label} ${id}: overlapping actions at ${s.start} (previous ended ${end})`); // 1
      assert.ok(s.end <= W + EPS && s.end >= s.start - EPS, `${label} ${id}: action ${s.action} outside the window`); // 5
      if (s.place.includes('>')) {
        const route = s.place.split('>');
        assert.equal(route[0], where, `${label} ${id}: ${s.action} starts at ${route[0]} but the worker is at ${where}`); // 2
        if (DEPART.test(s.action)) { assert.equal(where, nest, `${label} ${id}: departs while not at the nest`); trips++; }
        if (RETURN.test(s.action)) assert.equal(route.at(-1), nest, `${label} ${id}: return walk does not end at the nest`);
        where = route.at(-1) as string;
      } else assert.equal(s.place, where, `${label} ${id}: ${s.action} at ${s.place} but the worker is at ${where}`);
      end = s.end; segments++;
    }
    assert.equal(where, nest, `${label} ${id}: day ends outside the nest`);
    maxTrips = Math.max(maxTrips, trips);
    // 3: each collection happens at a place the worker stands on at that minute
    for (const c of ev.filter((x) => x.type === 'food_collected' && x.worker === id) as Any[]) {
      const at = segs.filter((s) => s.start <= c.minute + EPS && s.end >= c.minute - EPS && !s.place.includes('>'));
      const arrived = segs.some((s) => s.place.includes('>') && s.place.endsWith('>' + c.site) && s.end <= c.minute + EPS);
      assert.ok(arrived && (at.some((s) => s.place === c.site) || segs.some((s) => s.place === c.site && Math.abs(s.start - c.minute) < EPS)), `${label} ${id}: collected at ${c.site} minute ${c.minute} without being there`);
    }
    // 4: deliveries match collections one to one, after a walk home
    const got = (ev.filter((x) => x.type === 'food_collected' && x.worker === id) as Any[]).map((x) => `${x.macro}:${x.portions}`).sort();
    const gave = (ev.filter((x) => x.type === 'food_delivered' && x.worker === id) as Any[]).map((x) => `${x.macro}:${x.portions}`).sort();
    assert.deepEqual(gave, got, `${label} ${id}: delivered loads differ from collected loads`);
    for (const u of segs.filter((s) => s.action === 'unload')) assert.ok(u.place === nest && segs.some((s) => RETURN.test(s.action) && Math.abs(s.end - u.start) < EPS), `${label} ${id}: unloads without having walked home`);
  }
  // 6: recruits leave from the nest when the recruiter has finished unloading there
  for (const r of ev.filter((x) => x.type === 'local_recruitment') as Any[]) {
    const lead = (byWorker.get(r.by) ?? []).find((s) => s.action === 'unload' && Math.abs(s.end - r.minute) < EPS);
    const follow = (byWorker.get(r.to) ?? []).find((s) => s.action === 'recruit_follow_trail' && Math.abs(s.start - r.minute) < EPS);
    assert.ok(lead && follow && follow.place === r.physical_route.join('>'), `${label}: recruitment ${r.by} -> ${r.to} out of order or off the recruiter's route`);
  }
  // 6b: long-range hunt recruits leave with the finder when it is back at the nest
  for (const r of ev.filter((x) => x.type === 'hunt_recruitment') as Any[]) {
    const home = (byWorker.get(r.by) ?? []).find((s) => s.action === 'hunt_recruit_trail_home' && Math.abs(s.end - r.minute) < EPS);
    const follow = (byWorker.get(r.to) ?? []).find((s) => s.action === 'hunt_recruit_follow_trail' && Math.abs(s.start - r.minute) < EPS);
    assert.ok(home && follow && follow.place === r.physical_route.join('>'), `${label}: hunt recruitment ${r.by} -> ${r.to} before the finder was home`);
  }
  // 7: no double counting
  const sumOf = (type: string, macro: string) => (ev.filter((x) => x.type === type && x.macro === macro) as Any[]).reduce((a, x) => a + x.portions, 0);
  for (const m of ['sugar', 'protein']) {
    assert.ok(Math.abs(sumOf('food_collected', m) - sumOf('food_delivered', m)) < 1e-6 && Math.abs(sumOf('food_delivered', m) - summary.income[m]) < 1e-5, `${label}: ${m} collected / delivered / income differ`);
  }
  audited++;
}

const b = loadBundle(), W = resolveBundle(b).species[MAIN_SPECIES].foraging_activity.daily_window_minutes;
// Day0 worlds
for (const f of SUPPORTED_FOUNDINGS) for (const season of SEASONS) for (const seed of [20270001, 20270002, 20270003, 20270004, 20270005]) {
  let s: WorldState = buildDay0(f, seed, seasonStart(season), b).state;
  for (let d = 0; d < 60; d++) {
    const o = simulateWorldDay(s, b), c = o.result.colonies[0];
    audit(c.events, c.summary, W, s.colonies[0].nest_node, `${f}/${season}/${seed} day ${o.state.sim_day}`);
    s = o.state;
    if (!s.colonies[0].population.workers.length) break;
  }
}
// Day14 fixture (legacy adapter)
for (let seed = 15032026; seed < 15032046; seed++) {
  let s: LegacyV2State = fixture(); s.seed = seed;
  for (let d = 0; d < 40; d++) { const o = simulateDay(s, b); audit(o.events, o.summary, W, 'N00', `day14 seed ${seed} day ${o.day}`); s = o.state; if (!s.population.workers.length) break; }
}
ok(audited > 1000 && segments > 10000, `time audit: ${audited} colony-days, ${segments} activity segments, every check passed`);

// Travel time: recorded length / speed; unknown length keeps the legacy minutes
{
  const rp = resolveBundle(b), sp = rp.species[MAIN_SPECIES], wp = rp.world, col: Any = { trail_by_edge: {} };
  const off = edgeMinutes(sp, wp, col, 'N00', 'F01'), on = edgeMinutes(sp, wp, { trail_by_edge: { 'F01:N00': 1 } } as Any, 'N00', 'F01'), unk = edgeMinutes(sp, wp, col, 'N00', 'U01');
  ok(Math.abs(on.minutes - 48 * 10 / 17 / 60) < 1e-5 && Math.abs(off.minutes - on.minutes / sp.activity.off_trail_speed_factor) < 1e-5, `N00–F01 48 cm: ${on.minutes} min on trail, ${off.minutes} min off trail`);
  ok(unk.basis === 'unknown_length_legacy_minutes' && unk.minutes === wp.routes.route_edge_minutes, 'an edge without a recorded length keeps routes.route_edge_minutes (not invented)');
}

// Trips per day are an outcome: plenty of honeydew next to the nest vs the same food only behind unknown-length edges
function tripsPerForager(edit: (bb: ParamBundle) => void, far: boolean): number {
  const bb = loadBundle(); edit(bb);
  let trips = 0, foragers = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    let s: WorldState = buildDay0('A1', seed, '2027-09-23', bb).state;
    for (const w of s.colonies[0].population.workers) { w.known_sources = [far ? 'F10' : 'F01']; (w as Any).route_memory = { origin: 'test', edges: far ? { 'N00:U01': { acquired: 'walked', first_day: 0, last_day: 0 }, 'F10:U01': { acquired: 'walked', first_day: 0, last_day: 0 } } : { 'F01:N00': { acquired: 'walked', first_day: 0, last_day: 0 } }, empty_sites: {} }; }
    const src = s.sources[far ? 'F10' : 'F01']; src.host_alive = true; src.sugar = 50; src.capacity = 50;
    const o = simulateWorldDay(s, bb), per = (o.result.colonies[0].summary as Any).activity.workers as Record<string, Any>;
    for (const w of Object.values(per)) if (w.trips > 0) { trips += w.trips; foragers++; }
    s = o.state;
  }
  return foragers ? trips / foragers : 0;
}
const near = tripsPerForager(() => {}, false), far = tripsPerForager(() => {}, true);
ok(near > 2 && far < near, `trips per active forager are an outcome of distance and behaviour: near food ${near.toFixed(2)}, far food ${far.toFixed(2)} (no fixed daily count)`);
ok(maxTrips > 2, `some workers make more than the old maximum of 2 trips in a day (max ${maxTrips})`);

// Computation limit is a guard, not biology
{
  const bb = loadBundle(); setParam(bb, MAIN_SPECIES, 'activity.safety_max_actions_per_worker_day', 1);
  const s = buildDay0('A1', 20270001, '2027-09-23', bb).state;
  for (const w of s.colonies[0].population.workers) { w.known_sources = ['F01']; (w as Any).route_memory = { origin: 'test', edges: { 'F01:N00': { acquired: 'walked', first_day: 0, last_day: 0 } }, empty_sites: {} }; }
  setParam(bb, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000);
  assert.throws(() => simulateWorldDay(s, bb), /COMPUTATION LIMIT \(not biology\)/); checks++;
}
// Switch off: no activity records (old planned-trip model)
{
  const bb = loadBundle(); (bb.species[MAIN_SPECIES] as Any).activity.individual_timeline = false;
  const o = simulateWorldDay(buildDay0('A1', 20270001, '2027-09-23', bb).state, bb);
  ok(!o.result.colonies[0].events.some((e) => e.type === 'worker_activity') && (o.result.colonies[0].summary as Any).activity === undefined, 'switch off: the v2-review.16 model runs (no activity timeline)');
}
console.log(JSON.stringify({ passed: true, checks, audited_colony_days: audited, activity_segments: segments, max_trips_by_one_worker_in_a_day: maxTrips, trips_per_forager_near: +near.toFixed(3), trips_per_forager_far: +far.toFixed(3) }, null, 2));
