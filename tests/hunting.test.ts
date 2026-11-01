/**
 * v2-review.9 (#10) simultaneous site-window hunting. Test-only parameter overrides (encounter / prey size /
 * capture / escape probabilities forced to 0 or 1) are used ONLY inside these fixtures to make each branch
 * happen; the game parameters are not changed. Checks:
 *  1. team composition and outcome do not depend on the order in which simultaneous arrivals are processed;
 *  2. a worker takes part in at most one hunt per window (participation lock), small prey is hunted alone;
 *  3. large prey with too few workers: long-range recruitment along a real trail, with walking times (called
 *     directly, without a waiting list, huntWindow concludes the hunt at once as in v2-review.10; the waiting-prey
 *     path of v2-review.11 is checked at day level in 9);
 *     escape while waiting, no recruits, no time left;
 *  4. time consistency: every team member is at the site at the event minute and walks home afterwards;
 *  5. joint retrieval conserves the captured prey exactly and every carried portion traces to its HUNT batch;
 *  6. whole-day level: reversing the colony's worker order leaves every hunt identical; multi-day run keeps
 *     the lock and the time consistency on every day;
 *  7. a leftover carcass is taken first; only workers left empty-handed then hunt, as one window;
 *  8. v2-review.10 team cap (predation.large_prey_max_team): teams never exceed it, joiners are drawn at
 *     random but independent of arrival order, workers left out can hunt their own prey, long-range
 *     recruitment stops at the cap, and a cap below large_prey_min_team is rejected;
 *  9. v2-review.11: a large prey waiting for long-range recruits is joined by empty-handed workers that reach
 *     the site by the time the recruits arrive; the hunt is concluded with all of them at that minute (fixed
 *     seeds, forced test-only probabilities); with the switch off nobody joins.
 */
import assert from 'node:assert/strict';
import { huntWindow, simulateDay, routeTo, legacyView, legacyColonyMeta, resolveBundle, type Arrival, type HuntContext, type LegacyV2State, type SimEvent, type Worker } from '../engine/index.ts';
import { bundle, counter, fixture, MAIN_SPECIES, setParam } from './lib/harness.ts';

const c = counter(), { ok } = c;
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SITE = 'F07';
const forced = (o: { encounter?: number; large?: number; capture?: number; escape?: number; team?: number; cap?: number }) => {
  const b = bundle();
  setParam(b, MAIN_SPECIES, 'predation.live_prey_encounter_probability', o.encounter ?? 1);
  setParam(b, 'world', 'prey.large_prey_fraction', o.large ?? 1);
  setParam(b, MAIN_SPECIES, 'predation.live_prey_capture_probability', o.capture ?? 1);
  setParam(b, MAIN_SPECIES, 'predation.large_prey_escape_while_recruiting_probability', o.escape ?? 0);
  if (o.team !== undefined) setParam(b, MAIN_SPECIES, 'predation.large_prey_min_team', o.team);
  if (o.cap !== undefined) setParam(b, MAIN_SPECIES, 'predation.large_prey_max_team', o.cap);
  return b;
};
const worker = (id: string, at: string, task = 'forage'): Worker => ({ id, last_location: at, known_sources: [SITE], crop_cargo_sugar: 0, age_days: 20, injured: false, task });

/** A Day14 fixture whose F07 carcass is empty and holds 10 living insects; `hunters` stand at F07, `idle` at the nest. */
function scene(hunters: string[], idle: string[] = []) {
  const s: LegacyV2State = fixture();
  s.sources[SITE].batches = []; s.sources[SITE].protein = 0; s.ecology.insects_by_site[SITE].living = 10;
  s.population.workers = [...hunters.map((id) => worker(id, SITE)), ...idle.map((id) => worker(id, 'N00', 'rest'))];
  const meta = legacyColonyMeta(resolveBundle(bundle()).world.scenario_colonies);
  const world = legacyView(s, meta, (s.ecology.trail_by_edge ??= {})), colony = world.colonies[0];
  return { s, world, colony };
}
function run(b: Any, hunters: string[], idle: string[] = [], order: (a: Arrival[]) => Arrival[] = (a) => a, arrive?: number) {
  const rp = resolveBundle(b), sp = rp.species[MAIN_SPECIES], wp = rp.world;
  const { s, world, colony } = scene(hunters, idle);
  const route = routeTo(wp, 'N00', SITE) as string[], one = (route.length - 1) * wp.routes.route_edge_minutes;
  const events: SimEvent[] = [], summary: Any = { tasks: { forage: hunters.length, nurse: 0, repair: 0, rest: idle.length, guard: 0 }, recruited: 0, foraging_trips: 0, extra_sugar_cost: 0 };
  const ctx: HuntContext = { world, colony, sp, wp, events, summary, tripCost: () => { summary.foraging_trips++; }, byMacro: { sugar: new Set(), protein: new Set() } };
  const arrivals = order(colony.population.workers.filter((w) => w.last_location === SITE).map((w) => ({ worker: w, route, arrive: arrive ?? one })));
  const out = huntWindow(ctx, world.sources[SITE], arrivals);
  return { out, events, s, world, sp, wp, one, route, summary };
}
const shape = (r: ReturnType<typeof run>) => JSON.stringify({ out: [...r.out.entries()].sort().map(([id, v]) => [id, v.load, v.home, v.recruited, v.event_id, v.led_by, !!v.walked_home]), events: r.events, src: r.s.sources[SITE], pop: r.s.ecology.insects_by_site[SITE] });
const teams = (ev: SimEvent[]) => ev.filter((e) => e.type === 'insect_predation').map((e) => e.team as string[]);

// 1. order independence (the #10 reproduction: H0, H1, H2 arrive together at F07)
const large = forced({});
const fwd = run(large, ['H0', 'H1', 'H2']), rev = run(large, ['H0', 'H1', 'H2'], [], (a) => [...a].reverse());
ok(shape(fwd) === shape(rev), 'reversed processing order gives byte-identical hunt events, shares and source state');
ok(JSON.stringify(teams(fwd.events)) === JSON.stringify([['H0', 'H1', 'H2']]), 'one large prey, team = all three simultaneous workers (was [H0,H1,H2] then [H1,H2] then [H2] under v8)');
{
  const rot = run(large, ['H0', 'H1', 'H2'], [], (a) => [a[1], a[2], a[0]]);
  ok(shape(rot) === shape(fwd), 'any permutation of the arrivals gives the same result');
}
// 2. participation lock, small prey alone
{
  const small = run(forced({ large: 0 }), ['H0', 'H1', 'H2']);
  const t = teams(small.events);
  ok(t.length === 3 && t.every((x) => x.length === 1), 'small prey: each finder captures alone (Dejean 2007: single workers retrieve prey >9x their weight)');
  const all = t.flat(); ok(new Set(all).size === all.length, 'no worker is in two teams of the same window');
  ok(small.s.ecology.insects_by_site[SITE].living === 7, 'three tracked insects removed, one per capture');
}
{
  const ids = fwd.events.filter((e) => e.type === 'insect_predation' || e.type === 'prey_escaped').flatMap((e) => (e.team ?? e.participants) as string[]);
  ok(new Set(ids).size === ids.length && fwd.out.size === 3, 'large-prey window: each worker locked into exactly one hunt');
  ok(!fwd.events.some((e) => e.type === 'live_prey_encounter' && e.worker !== 'H0'), 'workers absorbed into a hunt do not start a second one in the same window');
}
// 5. joint retrieval conserves mass and traces every portion
{
  const q = fwd.wp.prey.large_prey_protein, carried = [...fwd.out.values()].reduce((a, v) => a + v.load, 0);
  ok(Math.abs(carried - q) < 1e-9, 'team carries the whole captured prey; shares sum exactly to large_prey_protein');
  ok(fwd.s.sources[SITE].protein === 0 && fwd.s.sources[SITE].batches.every((b) => b.protein === 0), 'nothing left behind, nothing created');
  const id = teams(fwd.events).length && (fwd.events.find((e) => e.type === 'insect_predation') as Any).event_id;
  for (const [wid, v] of fwd.out) {
    ok(fwd.events.some((e) => e.type === 'source_batch_consumed' && e.worker === wid && e.source_event_id === id && e.quantity_portions === v.load), 'carried share of ' + wid + ' consumed from the HUNT batch');
    ok(fwd.events.some((e) => e.type === 'food_collected' && e.worker === wid && e.prey_event_id === id && e.minute === v.home), 'food_collected for ' + wid + ' with minute and prey id');
  }
  const jt = fwd.events.find((e) => e.type === 'joint_prey_transport') as Any;
  ok(jt && jt.carriers.length === 3 && jt.minute === fwd.one, 'joint_prey_transport lists every carrier and the minute');
}
// 3. long-range recruitment
{
  const r = run(forced({}), ['H0'], ['N1', 'N2', 'N3']), one = r.one;
  const alarm = r.events.find((e) => e.type === 'local_alarm_signal') as Any, trail = r.events.filter((e) => e.type === 'trail_deposited' && e.worker === 'H0');
  ok(alarm && alarm.minute === one && trail.length === r.route.length - 1, 'lone finder raises the alarm, then lays a trail on every edge home');
  ok(r.events.some((e) => e.type === 'route_step' && e.worker === 'H0' && e.to === 'N00' && e.kind === 'hunt_recruit_trail_home' && e.minute === 2 * one), 'finder physically walks home (arrives minute 2x)');
  const rec = r.events.filter((e) => e.type === 'hunt_recruitment') as Any[];
  ok(rec.length >= 1 && rec.every((e) => e.minute === 2 * one && ['N1', 'N2', 'N3'].includes(e.to)), 'only idle nestmates physically at the nest are recruited, when the finder is back');
  for (const e of rec) ok(r.events.some((s) => s.type === 'route_step' && s.worker === e.to && s.to === SITE && s.kind === 'hunt_recruit_follow_trail' && s.minute === 3 * one), 'recruit ' + e.to + ' walks the trail and arrives at minute 3x');
  const pred = r.events.find((e) => e.type === 'insect_predation') as Any;
  ok(pred && pred.minute === 3 * one && pred.team.length === 1 + rec.length && pred.team[0] === 'H0', 'capture happens when the recruits arrive; team = finder + recruits');
  ok(r.summary.recruited === rec.length && rec.every((e) => r.s.population.workers.find((w) => w.id === e.to)?.task === 'forage'), 'recruits switch to foraging and are counted');
  ok([...r.out.values()].every((v) => v.home === 3 * one) && [...r.out.values()].filter((v) => v.recruited).every((v) => v.led_by === 'H0'), 'whole team leaves together; recruits are led by H0');
}
{
  const esc = run(forced({ escape: 1 }), ['H0'], ['N1']);
  ok(esc.events.some((e) => e.type === 'prey_escaped' && e.reason === 'escaped_while_recruiting' && e.minute === 3 * esc.one) && esc.s.ecology.insects_by_site[SITE].living === 10, 'prey may escape while the finder recruits (new game-assumption parameter); no insect removed');
  ok([...esc.out.values()].every((v) => v.load === 0), 'nobody carries anything after an escape');
}
{
  const none = run(forced({}), ['H0'], []);
  ok(none.events.some((e) => e.type === 'prey_escaped' && e.reason === 'insufficient_team_no_recruits'), 'no idle nestmate at the nest: prey escapes');
  const h = none.out.get('H0') as Any; ok(h.walked_home && h.home === none.one && h.load === 0, 'finder already walked home; it is not teleported back');
}
{
  const late = run(forced({}), ['H0'], ['N1'], (a) => a, 300);
  ok(late.events.some((e) => e.type === 'prey_escaped' && e.reason === 'insufficient_team_no_time_to_recruit') && !late.events.some((e) => e.type === 'hunt_recruitment'), 'no recruitment when the round trip would not fit the daily window');
}
{
  const two = run(forced({}), ['H0', 'H1'], ['N1']);
  ok(!two.events.some((e) => e.type === 'hunt_recruitment') && teams(two.events)[0]?.length === 2, 'two co-located workers: short-range recruitment suffices, no trip home');
}
{
  const failed = run(forced({ capture: 0 }), ['H0', 'H1']);
  ok(failed.events.some((e) => e.type === 'prey_escaped' && e.reason === 'failed_capture') && failed.s.ecology.insects_by_site[SITE].living === 10, 'failed capture leaves the insect alive (capture probability unchanged: separate item)');
}

// 6. whole-day level, order independence and per-day invariants
function day(reverse: boolean) {
  const b = forced({}); setParam(b, MAIN_SPECIES, 'scouting.scout_discovery_probability', 0); setParam(b, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000);
  const s: LegacyV2State = fixture();
  s.sources[SITE].batches = []; s.sources[SITE].protein = 0; s.ecology.insects_by_site[SITE].living = 10;
  for (const w of s.population.workers) { w.known_sources = [SITE]; w.age_days = 20; w.site_memory = {}; }
  if (reverse) s.population.workers.reverse();
  return simulateDay(s, b).events.filter((e) => ['live_prey_encounter', 'insect_predation', 'prey_escaped', 'joint_prey_transport', 'hunt_recruitment'].includes(e.type));
}
{
  const a = day(false), r = day(true);
  ok(a.some((e) => e.type === 'insect_predation'), 'whole-day fixture produces hunts');
  ok(JSON.stringify(a) === JSON.stringify(r), 'reversing the colony worker order leaves every hunt event identical');
}
function invariants(events: SimEvent[], label: string) {
  const busy = new Map<string, string>();
  for (const e of events.filter((x) => x.type === 'insect_predation' || (x.type === 'prey_escaped' && x.participants))) {
    for (const id of (e.team ?? e.participants) as string[]) {
      const key = id + '@' + e.site + '@' + e.minute;
      ok(!busy.has(key), `${label}: ${id} in one hunt only at ${e.site} minute ${e.minute}`); busy.set(key, e.type);
      ok(events.some((s) => s.type === 'route_step' && s.worker === id && s.to === e.site && (s.minute as number) <= (e.minute as number)), `${label}: ${id} arrived at ${e.site} by minute ${e.minute}`);
      ok(events.some((s) => s.type === 'route_step' && s.worker === id && s.from === e.site && (s.minute as number) > (e.minute as number)), `${label}: ${id} leaves ${e.site} after minute ${e.minute}`);
    }
  }
  for (const e of events.filter((x) => x.type === 'joint_prey_transport') as Any[]) {
    const born = events.find((x) => x.type === 'new_food_source' && x.id === e.event_id) as Any;
    ok(born && Math.abs(e.carriers.reduce((a: number, k: Any) => a + k.portions, 0) - born.protein_portions) < 1e-9, `${label}: joint transport carries exactly the captured prey ${e.event_id}`);
  }
}
let hunts = 0, recruitHunts = 0;
{
  let s: LegacyV2State = fixture();
  const b = bundle();
  for (let d = 0; d < 120; d++) { const o = simulateDay(s, b); invariants(o.events, 'Day' + o.day); hunts += o.events.filter((e) => e.type === 'insect_predation').length; recruitHunts += o.events.filter((e) => e.type === 'hunt_recruitment').length; s = o.state; }
  ok(hunts > 0, 'game parameters: the 120-day baseline has hunts to check (' + hunts + ')');
}
// 7. leftover carcass: workers take it first; only the empty-handed ones then search for live prey together
{
  const b = forced({}); setParam(b, MAIN_SPECIES, 'scouting.scout_discovery_probability', 0); setParam(b, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000); setParam(b, MAIN_SPECIES, 'food_handling.carcass_access_probability', 1);
  const s: LegacyV2State = fixture();
  s.sources[SITE].batches = [{ event_id: 'TEST-LEFTOVER', original_day: 14, protein: 0.1, age_days: 0, origin: 'test fixture leftover' } as Any]; s.sources[SITE].protein = 0.1; s.ecology.insects_by_site[SITE].living = 10;
  for (const w of s.population.workers) { w.known_sources = [SITE]; w.age_days = 20; w.site_memory = {}; }
  const ev = simulateDay(s, b).events;
  const took = ev.filter((e) => e.type === 'source_batch_consumed' && e.source_event_id === 'TEST-LEFTOVER').map((e) => e.worker as string);
  const first = ev.find((e) => e.type === 'insect_predation') as Any;
  ok(took.length === 1 && first && !first.team.includes(took[0]), 'the worker who took the leftover carcass is not counted in the hunt of the same window');
  ok(first.team.length >= 2 && first.minute === Math.min(...ev.filter((e) => e.type === 'route_step' && e.to === SITE).map((e) => e.minute as number)), 'the empty-handed workers hunt together in the same window');
}
// 8. team cap
{
  const ids = Array.from({ length: 15 }, (_, i) => 'K' + String(i).padStart(2, '0'));
  const cap = run(forced({}), ids), t = teams(cap.events), max = cap.sp.predation.large_prey_max_team;
  ok(max === 10, 'game parameter large_prey_max_team = 10 (upper end of the 2-10 retrieving workers in Dejean 2007)');
  ok(t.length >= 2 && t.every((x) => x.length <= max) && t[0].length === max, '15 workers at one large prey: first team is capped at 10, the rest form their own hunt');
  const all = t.flat(); ok(new Set(all).size === all.length, 'capped teams never share a worker');
  ok(shape(run(forced({}), ids, [], (a) => [...a].reverse())) === shape(cap), 'random choice of joiners is independent of arrival order');
  const two = run(forced({ cap: 2 }), ['H0', 'H1', 'H2']);
  const inTeam = new Set(teams(two.events).flat()), left = ['H0', 'H1', 'H2'].filter((id) => !inTeam.has(id));
  ok(teams(two.events).length === 1 && teams(two.events)[0].length === 2 && left.length === 1, 'cap = 2: two workers take the prey, one is left out');
  ok(two.events.some((e) => e.type === 'live_prey_encounter' && e.worker === left[0]), 'the worker left out is free to encounter prey of its own in the same window');
  const lr = run(forced({ cap: 2 }), ['H0'], ['N1', 'N2', 'N3']);
  ok(lr.events.filter((e) => e.type === 'hunt_recruitment').length <= 1 && teams(lr.events).every((x) => x.length <= 2), 'long-range recruitment stops at the cap');
  const bad = bundle(); setParam(bad, MAIN_SPECIES, 'predation.large_prey_max_team', 1);
  assert.throws(() => resolveBundle(bad), /large_prey_max_team/);
  const frac = bundle(); setParam(frac, MAIN_SPECIES, 'predation.large_prey_max_team', 2.5);
  assert.throws(() => resolveBundle(frac), /large_prey_max_team/);
  ok(true, 'a cap below large_prey_min_team or a non-integer cap is rejected');
}
// 9. late arrivals join a waiting prey
function lateDays(on: boolean) {
  const b = forced({ encounter: 0.5, team: 3 }); setParam(b, MAIN_SPECIES, 'scouting.scout_discovery_probability', 0); setParam(b, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000);
  (b.species[MAIN_SPECIES] as Any).predation.late_arrivals_join_waiting_prey = on;
  const out: SimEvent[][] = [];
  for (let seed = 1; seed <= 40; seed++) {
    const s: LegacyV2State = fixture(); s.seed = seed;
    s.sources[SITE].batches = []; s.sources[SITE].protein = 0; s.ecology.insects_by_site[SITE].living = 10;
    for (const w of s.population.workers) { w.known_sources = [SITE]; w.age_days = 20; w.site_memory = {}; }
    out.push(simulateDay(s, b).events);
  }
  return out;
}
let joinedEvents = 0;
{
  const days = lateDays(true), edge = resolveBundle(bundle()).world.routes.route_edge_minutes;
  for (const [i, ev] of days.entries()) {
    invariants(ev, 'late-join seed ' + (i + 1));
    for (const j of ev.filter((e) => e.type === 'waiting_prey_joined') as Any[]) {
      joinedEvents++;
      ok(j.joiners.every((id: string) => ev.some((e) => e.type === 'route_step' && e.worker === id && e.to === SITE && e.minute === j.minute)), 'joiners physically arrive at the site at the joining minute');
      ok(ev.some((e) => e.type === 'long_range_recruitment_trail' && e.worker === j.finder && e.minute === j.minute - edge), 'the prey was waiting: its finder went home to recruit one leg before');
      const end = ev.find((e) => (e.type === 'insect_predation' || e.type === 'prey_escaped') && e.minute === j.minute && ((e.team ?? e.participants) as string[]).includes(j.finder)) as Any;
      ok(end && j.joiners.every((id: string) => (end.team ?? end.participants).includes(id)), 'the hunt is concluded at that minute with the finder, its recruits and the joiners');
      ok(((end.team ?? end.participants) as string[]).length <= resolveBundle(bundle()).species[MAIN_SPECIES].predation.large_prey_max_team, 'joining respects the team cap');
    }
  }
  ok(joinedEvents > 0, 'the fixed seeds produce late joiners to check (' + joinedEvents + ')');
  ok(lateDays(false).every((ev) => !ev.some((e) => e.type === 'waiting_prey_joined')), 'switch off (v2-review.10): nobody joins a waiting prey');
}
console.log(JSON.stringify({ passed: true, checks: c.checks, late_joins: joinedEvents, baseline_120d_hunts: hunts, baseline_120d_hunt_recruitments: recruitHunts }, null, 2));
