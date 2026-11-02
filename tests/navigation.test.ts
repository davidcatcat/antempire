/**
 * v2-review.14 (#8) individual route memory and local exploration. Test-only parameter overrides are used
 * ONLY inside the constructed fixtures below to make a branch happen; the game parameters are not changed.
 *  1. anti-god-view: a worker plans only over edges it has walked; a known site whose route the worker has
 *     never walked is not reachable "by shortcut" (F04 -> F05 is reached via F04, never via the unknown F08);
 *  2. local exploration: an explorer walks a remembered route to a remembered node and then takes exactly ONE
 *     edge it has never walked; it learns nothing beyond the node it reached;
 *  3. memory isolation: what A learns never appears in B's memory unless B walked it;
 *  4. pheromone following: a worker that never walked an edge can follow a trail it senses hop by hop, and
 *     learns the edges by walking them;
 *  5. signal loss: once the trail has decayed a naive worker cannot follow it, while a worker that walked it
 *     still can (its own memory);
 *  6. per-day audit on 20 seeds × 60 days of the game parameters: every edge walked was known before the day or
 *     justified by an exploration step, a local trail choice or following a recruiter's actual route; memory
 *     only grows by edges actually walked; every worker's day is one continuous walk out of and back into the
 *     nest with strictly increasing minutes (no teleporting, no two places at once);
 *  7. ecology consistency: plant / hemipteran / nectar production is identical with route memory on or off;
 *  8. switch off: no route memory is created (v2-review.12 behaviour; full proof in rules-isolation).
 */
import assert from 'node:assert/strict';
import { simulateDay, resolveBundle, type LegacyV2State, type SimEvent, type Worker } from '../engine/index.ts';
import { knownRoute, knownNodes, learnRoute, unknownExits } from '../engine/navigation.ts';
import { bundle, counter, fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const c = counter(), { ok } = c;
const wp = resolveBundle(bundle()).world;
const mem = (edges: string[]) => ({ origin: 'test', edges: Object.fromEntries(edges.map((e) => [e, { acquired: 'walked', first_day: 14, last_day: 14 }])), empty_sites: {} });
const edgesOf = (w: Any): Set<string> => new Set(Object.keys(w?.route_memory?.edges ?? {}));
const ek = (a: string, b: string) => [a, b].sort().join(':');

// 1. anti-god-view at the planning level
{
  const w = { id: 'T', route_memory: mem(['F01:N00', 'F01:F04', 'F04:F05']) } as Any as Worker;
  ok(knownRoute(w, 'N00', 'F05')?.join('>') === 'N00>F01>F04>F05', 'known route to F05 goes through F04 (the only way this worker knows), not the shorter unknown N00>F08>F05');
  ok(knownRoute(w, 'N00', 'F08') === null && knownRoute(w, 'N00', 'F10') === null, 'no route to places whose edges were never walked');
  ok(knownNodes(w, 'N00').join() === 'F01,F04,F05,N00', 'reachable places = remembered edges only');
  ok(unknownExits(w, wp, 'F05').join() === 'F08' && unknownExits(w, wp, 'N00').join() === 'F07,F08,F11,U00,U01', 'at a node the worker perceives only the exits of that node');
  const v = { id: 'V', route_memory: mem([]) } as Any as Worker;
  learnRoute(v, ['N00', 'U01', 'F10'], 'explore_depart', 15);
  ok(edgesOf(v).has('N00:U01') && edgesOf(v).has('F10:U01') && (v as Any).route_memory.edges['F10:U01'].acquired === 'explored', 'walking a route records each edge and how it was learned');
}

// Constructed day: workers forced to forage; one explorer with a chosen memory.
function day(seed: number, setup: (s: LegacyV2State) => void, edits: [string, string, number][] = []) {
  const b = bundle();
  setParam(b, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000);
  for (const [f, p, v] of edits) setParam(b, f, p, v);
  const s: LegacyV2State = fixture(); s.seed = seed;
  for (const w of s.population.workers) { (w as Any).route_memory = mem([]); w.known_sources = []; w.site_memory = {}; w.age_days = 20; }
  setup(s);
  return { before: structuredClone(s), out: simulateDay(s, b) };
}

// 2. local exploration: F04 -> F05 found only from F04's side; nothing learned beyond the reached node
{
  let viaF04 = 0, viaOther = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const { out } = day(seed, (s) => {
      const x = s.population.workers[0] as Any;
      x.route_memory = mem(['F01:N00', 'F01:F04']); x.known_sources = ['F04']; x.site_memory = { F04: { last_success_portions: 0, last_visit_day: 14 } };
    }, [[MAIN_SPECIES, 'scouting.scout_search_when_route_unproductive_probability', 1], [MAIN_SPECIES, 'scouting.scout_discovery_probability', 1]]);
    const id = fixture().population.workers[0].id;
    for (const e of out.events.filter((x) => x.type === 'exploration_step' && x.worker === id) as Any[]) {
      ok(['N00', 'F01', 'F04'].includes(e.from), 'exploration starts from a node the worker knows');
      ok(e.route.slice(0, -1).every((n: string, i: number, r: string[]) => i === 0 || ['F01:N00', 'F01:F04'].includes(ek(r[i - 1], n))), 'the way to the starting node uses remembered edges only');
      if (e.to === 'F05') { if (e.route.join('>') === 'N00>F01>F04>F05') viaF04++; else viaOther++; }
      const after = edgesOf(out.state.population.workers.find((w) => w.id === id));
      ok(after.size === 3 && after.has(ek(e.from, e.to)), 'exactly one new edge learned per exploration; nothing beyond the reached node');
    }
  }
  ok(viaF04 > 0 && viaOther === 0, `F05 discovered only from F04 (${viaF04} times), never through the unknown F08`);
}

// 3. memory isolation
{
  const { before, out } = day(7, (s) => { const a = s.population.workers[0] as Any; a.route_memory = mem(['F01:N00']); a.known_sources = ['F01']; }, [[MAIN_SPECIES, 'scouting.scout_discovery_probability', 0]]);
  const followedOrWalked = (id: string) => new Set(out.events.filter((e) => e.type === 'route_step' && e.worker === id).map((e) => ek(e.from as string, e.to as string)));
  for (const w of out.state.population.workers) {
    const b0 = edgesOf(before.population.workers.find((x) => x.id === w.id)), after = edgesOf(w), walked = followedOrWalked(w.id);
    ok([...after].every((e) => b0.has(e) || walked.has(e)), `${w.id}: every remembered edge was known before or walked by ${w.id} itself`);
  }
  const others = out.state.population.workers.slice(1).filter((w) => !out.events.some((e) => e.type === 'route_step' && e.worker === w.id));
  ok(others.length > 0 && others.every((w) => edgesOf(w).size === 0), 'workers that did not walk learned nothing from A');
}

// 4 & 5. pheromone following and signal loss
{
  const trail = (s: LegacyV2State) => { s.ecology.trail_by_edge = { 'F01:N00': 1 }; };
  const { out } = day(3, trail, [[MAIN_SPECIES, 'scouting.scout_discovery_probability', 0]]);
  const followers = out.events.filter((e) => e.type === 'local_trail_choice' && e.from === 'N00' && e.to === 'F01').map((e) => e.worker as string);
  ok(followers.length > 0, 'naive workers sense the trail at the nest and follow it');
  for (const id of followers) {
    const w = out.state.population.workers.find((x) => x.id === id) as Any;
    ok(w.route_memory.edges['F01:N00']?.acquired === 'trail_followed', `${id} learned N00:F01 by following the trail`);
    ok(out.events.some((e) => e.type === 'route_step' && e.worker === id && e.to === 'F01' && e.kind === 'trail_follow_depart'), `${id} physically walked it`);
  }
  // Next day: trail gone. A worker that walked it (learned by trail following) still knows the way; workers that
  // never walked it have nothing to go by.
  const s2: LegacyV2State = fixture(); s2.seed = 4; s2.ecology.trail_by_edge = {};
  for (const w of s2.population.workers) { (w as Any).route_memory = mem([]); w.known_sources = []; w.site_memory = {}; w.age_days = 20; }
  const veteran = s2.population.workers[0] as Any;
  veteran.route_memory = { origin: 'test', edges: { 'F01:N00': { acquired: 'trail_followed', first_day: 15, last_day: 15 } }, empty_sites: {} };
  veteran.known_sources = ['F01']; veteran.site_memory = { F01: { last_success_portions: 1, last_visit_day: 15 } };
  const b = bundle(); setParam(b, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000); setParam(b, MAIN_SPECIES, 'scouting.scout_discovery_probability', 0);
  const o2 = simulateDay(s2, b);
  ok(o2.events.some((e) => e.type === 'route_step' && e.worker === veteran.id && e.to === 'F01' && e.kind === 'foraging_depart'), 'with the trail gone the worker that walked it returns from its own memory');
  // A naive worker may still reach F01 when the veteran, after delivering, lays a fresh trail and recruits it
  // (local recruitment: the recruit walks the recruiter's route). Without that, nothing leads it there.
  const recruited = new Set(o2.events.filter((e) => e.type === 'local_recruitment').map((e) => e.to as string));
  const naive = s2.population.workers.slice(1).map((w) => w.id).filter((id) => !recruited.has(id));
  ok(naive.length > 0 && !o2.events.some((e) => e.type === 'route_step' && naive.includes(e.worker as string) && e.to === 'F01'), 'with the trail gone (and no exploration) naive, unrecruited workers cannot find F01: no social navigation survives the signal');
  ok(o2.events.filter((e) => e.type === 'local_recruitment').every((e) => o2.events.some((d) => d.type === 'trail_deposited' && d.worker === e.by)), 'any recruitment that day followed a fresh trail laid by the recruiter');
}

// 6. per-day audit with the game parameters
function audit(prev: LegacyV2State, out: Any, label: string) {
  const nest = 'N00';
  const ev: SimEvent[] = out.events;
  const justified = new Map<string, Set<string>>();
  const add = (w: string, e: string) => { if (!justified.has(w)) justified.set(w, new Set()); (justified.get(w) as Set<string>).add(e); };
  for (const e of ev as Any[]) {
    if (e.type === 'exploration_step') add(e.worker, ek(e.from, e.to));
    if (e.type === 'local_trail_choice') add(e.worker, ek(e.from, e.to));
    if (e.type === 'local_recruitment' || e.type === 'hunt_recruitment') for (let i = 1; i < e.physical_route.length; i++) add(e.to, ek(e.physical_route[i - 1], e.physical_route[i]));
    if (e.type === 'route_memory_initialized') for (const x of e.edges) add(e.worker, x);
  }
  for (const w of out.state.population.workers as Any[]) {
    const p = prev.population.workers.find((x) => x.id === w.id) as Any;
    const before = edgesOf(p), j = justified.get(w.id) ?? new Set<string>();
    const steps = (ev as Any[]).filter((e) => e.type === 'route_step' && e.worker === w.id).sort((a, b) => a.minute - b.minute);
    for (const st of steps) ok(before.has(ek(st.from, st.to)) || j.has(ek(st.from, st.to)), `${label} ${w.id}: walked ${st.from}->${st.to} only if known before or justified locally`);
    const walked = new Set(steps.map((st) => ek(st.from, st.to)));
    ok([...edgesOf(w)].every((e) => before.has(e) || walked.has(e) || (j.has(e) && !p?.route_memory)), `${label} ${w.id}: memory grows only by walked edges`);
    for (const e of walked) ok(edgesOf(w).has(e), `${label} ${w.id}: walked edge ${e} remembered`);
    if (steps.length) {
      ok(steps[0].from === nest && steps.at(-1).to === nest, `${label} ${w.id}: day starts and ends at the nest`);
      for (let i = 1; i < steps.length; i++) ok(steps[i].from === steps[i - 1].to && steps[i].minute > steps[i - 1].minute, `${label} ${w.id}: continuous walk, strictly increasing minutes (${steps[i - 1].minute}->${steps[i].minute})`);
    }
  }
}
let audited = 0, explorations = 0, discoveries = 0, trailSteps = 0;
for (let seed = 15032026; seed < 15032046; seed++) {
  let s: LegacyV2State = fixture(); s.seed = seed;
  const b = bundle();
  for (let d = 0; d < 60; d++) {
    const prev = structuredClone(s), out = simulateDay(s, b);
    audit(prev, out, `seed ${seed} Day${out.day}`); audited++;
    explorations += out.events.filter((e) => e.type === 'exploration_step').length;
    discoveries += out.events.filter((e) => e.type === 'discovery').length;
    trailSteps += out.events.filter((e) => e.type === 'local_trail_choice').length;
    s = out.state;
    if (!s.population.workers.length) break;
  }
}
ok(audited > 0 && explorations > 0, `audit covered ${audited} days with ${explorations} exploration steps`);

// 7. ecology consistency
{
  const on = bundle(), off = bundle(); (off.species[MAIN_SPECIES] as Any).navigation.individual_route_memory = false;
  let a: LegacyV2State = fixture(), b: LegacyV2State = fixture();
  for (let d = 0; d < 30; d++) {
    const x = simulateDay(a, on), y = simulateDay(b, off);
    const prod = (st: LegacyV2State) => JSON.stringify(Object.values(st.sources).map((src: Any) => [src.id, src.ecological_record?.gross_portions ?? src.ecological_record?.production_portions ?? null, src.host_plants ?? null, src.hemipteran_colonies ?? null]));
    ok(prod(x.state) === prod(y.state), `Day${x.day}: plant / hemipteran / nectar production identical with route memory on or off`);
    ok(JSON.stringify(x.state.climate) === JSON.stringify(y.state.climate), `Day${x.day}: weather identical`);
    a = x.state; b = y.state;
  }
}

// 8. switch off
{
  const off = bundle(); (off.species[MAIN_SPECIES] as Any).navigation.individual_route_memory = false;
  const o = simulateDay(fixture(), off);
  ok(o.state.population.workers.every((w) => !('route_memory' in w)) && !o.events.some((e) => e.type === 'route_memory_initialized' || e.type === 'exploration_step'), 'switch off: no route memory, no exploration events (v2-review.12)');
}
assert.ok(c.checks > 100);
console.log(JSON.stringify({ passed: true, checks: c.checks, audited_days: audited, explorations, discoveries, trail_steps: trailSteps }, null, 2));
