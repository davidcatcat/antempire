/**
 * PR #44 supplementary review (Owner 2026-11-03) — CORRECT-BEHAVIOUR regression tests for three local-causality
 * questions on the individual activity timeline (engine/activity.ts, v2-review.20). Each section is a
 * counterfactual or a per-worker accounting check; on commit c87896f (first v20 draft) sections H, E, P and T fail,
 * which is the evidence that the defects existed (see reports/rules-update-v20-review.md §4c).
 *
 *  H  hunting: a worker that does not carry prey jointly walks home along ITS OWN outbound route (not the finder's);
 *     a joint transport follows a route known to a carrier that is actually there; per-worker route, position,
 *     minutes and energy agree with that route.
 *  E  exploration: what lies beyond a node the worker is not standing on comes only from the worker's own recorded
 *     observations (route_memory.perceived_exits), never from the world map. Counterfactual: adding an exit at a
 *     remote node does not change anything the worker does before it stands there.
 *  P  pheromone timing: a trail laid by a returning hunt finder exists on an edge only from the minute the finder has
 *     walked that edge; two workers deciding at the nest just before / just after that minute see different trails.
 *  T  trip planning: whether a trip "fits" the activity window does not depend on pheromone on edges the worker is not
 *     standing on (counterfactual on a remote edge's trail).
 *  G  a generic invariant over 8 seeds × 20 days: every local trail choice happens on an edge that carried a
 *     detectable trail at the start of the day or received a deposit no later than that minute.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { resolveBundle, simulateWorldDay } from '../engine/index.ts';
import { activityDay, edgeMinutes } from '../engine/activity.ts';
import { round } from '../engine/math.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ONLY = process.env.ISSUE44_ONLY; const want = (k: string) => !ONLY || ONLY === k;
// ISSUE44_SOFT=1 lists every failing check instead of stopping at the first (used to record the pre-fix evidence)
const SOFT = !!process.env.ISSUE44_SOFT, failed: string[] = [];
let checks = 0; const ok = (c: unknown, why: string) => { if (SOFT && !c) { failed.push(why); return; } assert.ok(c, why); checks++; };
const same = (x: unknown, y: unknown, why: string) => { try { assert.deepEqual(x, y, why); checks++; } catch (e) { if (!SOFT) throw e; failed.push(why); } };
const b = loadBundle(), rp = resolveBundle(b), SP = rp.species['pheidole-megacephala'], WP = rp.world;
const fresh = (seed = 1) => buildDay0('A1', seed, '2027-09-23', b).state;
const weather: Any = { nest_temp_model_c: 25, rain_mm: 0, daytime_air_temp_c: 28, soil_index: 0 };
const summary = (): Any => ({ extra_sugar_cost: 0, income: { sugar: 0, protein: 0 }, tasks: { forage: 0, nurse: 0, rest: 0, repair: 0, guard: 0 }, foraging_trips: 0, foraging_successes: 0, scouts: 0, recruited: 0, foraging_workers_by_macro: { sugar: new Set(), protein: new Set() } });
const mem = (route: string[], extra: Any = {}): Any => ({ origin: 'test', edges: Object.fromEntries(route.slice(1).map((x, j) => [[route[j], x].sort().join(':'), { acquired: 'walked', first_day: 0, last_day: 0 }])), empty_sites: {}, ...extra });
const forager = (w: Any, sites: string[], route: string[] | null) => Object.assign(w, { task: 'forage', known_sources: sites, site_memory: Object.fromEntries(sites.map((s) => [s, { last_success_portions: 1, last_visit_day: 0 }])), route_memory: route ? mem(route) : mem(['N00']) });
const run = (s: Any, p: Any, q: Any, learnDay = 1) => { const c = s.colonies[0], events: Any[] = [], sm = summary(); activityDay({ world: s, colony: c, sp: p, wp: q, weather, events, summary: sm, learnDay } as Any, c.population.workers); return { events, sm }; };
const segsOf = (ev: Any[], id: string) => ev.filter((e) => e.type === 'worker_activity' && e.worker === id).sort((x, y) => x.start - y.start || x.end - y.end);
const timeOf = (e: Any) => (typeof e.minute === 'number' ? e.minute : typeof e.start === 'number' ? e.start : null);
const legMinutes = (q: Any, p: Any, colony: Any, route: string[]) => round(route.slice(1).reduce((m, n, i) => m + edgeMinutes(p, q, colony, route[i], n).minutes, 0));
/** Expected walking minutes along `route` from minute t0 when each edge's speed depends on the trail laid on THAT edge
 *  up to the minute the walker enters it (rebuilt from the timed trail_deposited events). */
const edgeByEdge = (ev: Any[], q: Any, p: Any, route: string[], t0: number) => {
  let t = t0;
  for (let i = 1; i < route.length; i++) {
    const trail: Record<string, number> = {};
    for (const d of ev.filter((e) => e.type === 'trail_deposited' && typeof e.minute === 'number' && e.minute <= t + 1e-9)) trail[d.edge] = d.intensity;
    t = round(t + edgeMinutes(p, q, { trail_by_edge: trail } as Any, route[i - 1], route[i]).minutes);
  }
  return round(t - t0);
};
const RETURN_KINDS = new Set(['foraging_return', 'joint_prey_transport', 'explore_return', 'recruit_return']);

// ---------------------------------------------------------------- H: hunting — own return routes
/** Two (or three) workers reach F07: W001 directly (N00–F07, 600 cm), the others via X (N00–X–F07). */
const huntWorld = (o: { living: number; minTeam: number; capture: number; escape: number; lens: [number, number]; n?: number; window?: number }) => {
  const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
  s.ecology.insects_by_site.F07.living = o.living; s.sources.F07.batches = []; s.sources.F07.protein = 0;
  Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: o.capture, large_prey_escape_while_recruiting_probability: o.escape, large_prey_min_team: o.minTeam });
  p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; p.activity.continue_base = 0; p.activity.continue_crop_emptied_weight = 0; p.activity.continue_brood_need_weight = 0;
  if (o.window) p.foraging_activity.daily_window_minutes = o.window;
  q.prey.large_prey_fraction = 1;
  c.population.workers = c.population.workers.slice(0, o.n ?? 2);
  q.routes.edges = [['N00', 'F07'], ['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'F07:N00': 600, 'N00:X': o.lens[0], 'F07:X': o.lens[1] };
  c.population.workers.forEach((w: Any, i: number) => forager(w, ['F07'], i === 0 ? ['N00', 'F07'] : ['N00', 'X', 'F07']));
  return { s, p, q };
};
/** Per-worker check: the walk home after `after` follows `expected` (a reverse route), takes exactly its edge minutes,
 *  and the worker's outside minutes and the energy charged agree with the times actually walked. */
const checkReturn = (label: string, w: { s: Any; p: Any; q: Any }, ev: Any[], sm: Any, id: string, expected: string[], after: number) => {
  const segs = segsOf(ev, id), back = segs.filter((x) => RETURN_KINDS.has(x.action) && x.start >= after - 1e-9);
  ok(back.length >= 1, `${label}: ${id} walks home after minute ${after} (${segs.map((x) => `${x.action}@${x.place}`).join(' | ')})`);
  if (!back.length) return;
  const r = back[0], steps = ev.filter((e) => e.type === 'route_step' && e.worker === id && e.minute > r.start + 1e-9 && e.minute <= r.end + 1e-9);
  ok(r.place === expected.join('>'), `${label}: ${id} walks home along ${expected.join('>')} (walked ${r.place})`);
  ok(steps.map((e) => `${e.from}>${e.to}`).join(',') === expected.slice(1).map((n, i) => `${expected[i]}>${n}`).join(','), `${label}: ${id} route steps on the way home = its own route (${steps.map((e) => `${e.from}>${e.to}`).join(',')})`);
  // v2-review.20 (independent review): each edge's minutes come from the trail on that edge when the worker ENTERS it
  const minutes = edgeByEdge(ev, w.q, w.p, expected, r.start);
  ok(Math.abs(r.duration - minutes) < 1e-6, `${label}: ${id} walking home takes the ${minutes} min of its own route (took ${r.duration})`);
  const st = sm.activity.workers[id], last = segs.at(-1);
  ok(Math.abs(st.outside_minutes - (r.end - segs[0].start)) < 1e-6 || last.action === 'rest', `${label}: ${id} outside minutes ${st.outside_minutes} = departure..home ${round(r.end - segs[0].start)}`);
};
if (want('H')) {
  // H1 failed capture: nobody carries anything; each goes home its own way
  { const w = huntWorld({ living: 3, minTeam: 2, capture: 0, escape: 0, lens: [325, 325] }), { events: ev, sm } = run(w.s, w.p, w.q);
    const esc = ev.find((e) => e.type === 'prey_escaped' && e.reason === 'failed_capture');
    ok(esc && esc.participants.length === 2, 'H1 fixture: a two-worker short-range team fails to capture');
    if (esc) { checkReturn('H1', w, ev, sm, 'W001', ['F07', 'N00'], esc.minute); checkReturn('H1', w, ev, sm, 'W002', ['F07', 'X', 'N00'], esc.minute); } }
  // H2 the prey escapes while the finder recruits: the holder goes home its own way
  { const w = huntWorld({ living: 3, minTeam: 3, capture: 1, escape: 1, lens: [325, 325] }), { events: ev, sm } = run(w.s, w.p, w.q);
    const esc = ev.find((e) => e.type === 'prey_escaped' && e.reason === 'escaped_while_recruiting');
    ok(esc && esc.participants.includes('W002'), 'H2 fixture: the prey held by W002 escapes while W001 recruits');
    if (esc) checkReturn('H2', w, ev, sm, 'W002', ['F07', 'X', 'N00'], esc.minute); }
  // H3 joint transport by two late joiners, finder absent: the team carries the prey along a route a carrier walked
  { const w = huntWorld({ living: 3, minTeam: 2, capture: 1, escape: 0, lens: [400, 400], n: 3 }), { events: ev, sm } = run(w.s, w.p, w.q);
    const cap = ev.find((e) => e.type === 'insect_predation');
    ok(cap && !cap.team.includes('W001') && cap.team.length === 2, `H3 fixture: W002 and W003 (both via X) capture the held prey without the finder (${JSON.stringify(cap?.team)})`);
    if (cap) { for (const id of ['W002', 'W003']) checkReturn('H3', w, ev, sm, id, ['F07', 'X', 'N00'], cap.minute);
      const a = segsOf(ev, 'W002').find((x) => x.action === 'joint_prey_transport'), c3 = segsOf(ev, 'W003').find((x) => x.action === 'joint_prey_transport');
      ok(a && c3 && a.start === c3.start && a.end === c3.end && a.place === c3.place, 'H3: the joint carriers travel together (same route, same minutes)'); } }
  // H4 no time left to recruit: each member of the short-range team goes home its own way
  { const w0 = huntWorld({ living: 3, minTeam: 3, capture: 1, escape: 0, lens: [325, 325] }), c0 = w0.s.colonies[0];
    const L1 = legMinutes(w0.q, w0.p, c0, ['N00', 'F07']), L2 = legMinutes(w0.q, w0.p, c0, ['N00', 'X', 'F07']), ac = w0.p.activity;
    const window = Math.ceil(2 * Math.max(L1, L2) + ac.search_minutes + Math.max(ac.liquid_fill_minutes_full_crop, ac.protein_handling_minutes) + ac.unload_minutes + 0.5);
    const w = huntWorld({ living: 3, minTeam: 3, capture: 1, escape: 0, lens: [325, 325], window }), { events: ev, sm } = run(w.s, w.p, w.q);
    const esc = ev.find((e) => e.type === 'prey_escaped' && e.reason === 'insufficient_team_no_time_to_recruit');
    ok(esc && esc.participants.length === 2, `H4 fixture: window ${window} min leaves no time to recruit`);
    if (esc) { checkReturn('H4', w, ev, sm, 'W001', ['F07', 'N00'], esc.minute); checkReturn('H4', w, ev, sm, 'W002', ['F07', 'X', 'N00'], esc.minute); } }
  // energy: every outside minute charged once, per worker (the colony total equals Σ worker outside minutes × rate)
  for (const o of [{ living: 3, minTeam: 2, capture: 0, escape: 0, lens: [325, 325] }, { living: 3, minTeam: 2, capture: 1, escape: 0, lens: [400, 400], n: 3 }] as const) {
    const w = huntWorld(o as Any), { sm } = run(w.s, w.p, w.q), total = Object.values(sm.activity.workers).reduce((x: number, st: Any) => x + st.outside_minutes, 0);
    ok(Math.abs(sm.extra_sugar_cost - total * w.p.activity.active_minute_sugar_cost) < 1e-5, `H energy: charged ${sm.extra_sugar_cost} = Σ outside ${round(total)} × rate`);
  }
}

// ---------------------------------------------------------------- E: remote exits only from the worker's own observations
/** One worker in the nest, knows the edge N00–F01 only, nothing to forage, explores (probability 1). */
const exploreWorld = (seed: number, extraRemoteExit: boolean) => {
  const s = fresh(seed), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
  c.population.workers = c.population.workers.slice(0, 1); c.trail_by_edge = {};
  forager(c.population.workers[0], [], ['N00', 'F01']);
  p.scouting.scout_discovery_probability = 1; p.activity.continue_after_failure_probability = 0;
  q.routes.edges = [['N00', 'F01'], ['N00', 'F02'], ...(extraRemoteExit ? [['F01', 'Z']] : [])] as Any; q.routes.edge_length_cm = { 'F01:N00': 48 };
  return { s, p, q };
};
const firstArrivalAt = (ev: Any[], node: string) => ev.find((e) => e.type === 'route_step' && e.worker === 'W001' && e.to === node)?.minute as number | undefined;
if (want('E')) {
  // E1 counterfactual: an exit added at the remote node F01 must not change anything before the worker stands at F01
  let tested = 0;
  for (let seed = 1; seed <= 40 && tested < 3; seed++) {
    const A = run(...Object.values(exploreWorld(seed, false)) as [Any, Any, Any]).events, B = run(...Object.values(exploreWorld(seed, true)) as [Any, Any, Any]).events;
    const at = firstArrivalAt(A, 'F01');
    if (at === undefined) continue; // this seed explored from the nest (base N00), not via F01
    tested++;
    const before = (ev: Any[]) => ev.filter((e) => e.worker === 'W001' && timeOf(e) !== null && (timeOf(e) as number) < at - 1e-9).map((e) => JSON.stringify(e));
    same(before(B), before(A), `E1 seed ${seed}: identical behaviour before reaching F01 whether or not F01 has an extra exit (remote map not perceived)`);
  }
  ok(tested >= 1, `E1: ${tested} seeds explored through the remote node F01`);
  // E2 an exit is known only after the worker has stood at the node, and is then remembered (explicit memory)
  { const w = exploreWorld(1, true), c = w.s.colonies[0], wk: Any = c.population.workers[0];
    wk.known_sources = ['F01']; wk.site_memory = { F01: { last_success_portions: 1, last_visit_day: 0 } }; w.p.scouting.scout_discovery_probability = 0;
    const before = structuredClone(wk.route_memory.perceived_exits ?? null);
    run(w.s, w.p, w.q, 1);
    ok(before === null, 'E2: no exit observation before the visit');
    ok(JSON.stringify(wk.route_memory.perceived_exits?.F01) === JSON.stringify(['N00', 'Z']), `E2: after standing at F01 the worker has recorded its exits (${JSON.stringify(wk.route_memory.perceived_exits ?? null)})`);
    // the next day the world gains another exit at F01 that the worker has never perceived: from the nest it can plan only with what it recorded
    let planned = 0;
    for (let seed = 1; seed <= 40 && planned < 2; seed++) {
      const mk = (more: boolean) => { const x = exploreWorld(seed, true); x.s.colonies[0].population.workers[0].route_memory = structuredClone(wk.route_memory); if (more) x.q.routes.edges.push(['F01', 'Y']); return x; };
      const A = run(...Object.values(mk(false)) as [Any, Any, Any], 2).events, B = run(...Object.values(mk(true)) as [Any, Any, Any], 2).events;
      const at = firstArrivalAt(A, 'F01'); if (at === undefined) continue;
      planned++;
      const before = (ev: Any[]) => ev.filter((e) => e.worker === 'W001' && timeOf(e) !== null && (timeOf(e) as number) < at - 1e-9).map((e) => JSON.stringify(e));
      same(before(B), before(A), `E2 seed ${seed}: an exit added after the visit is not used before the worker stands at F01 again`);
      ok(A.some((e) => e.type === 'worker_activity' && e.worker === 'W001' && e.place === 'N00>F01>Z' && e.start < at), `E2 seed ${seed}: the remembered exit Z is planned from the nest (memory is used)`);
    }
    ok(planned >= 1, `E2: ${planned} seeds planned a trip through F01 from memory`);
  }
}

// ---------------------------------------------------------------- P: pheromone exists only after the edge was walked
/** W001 (finder) walks N00–X–F07 and finds a large prey alone; W002/W003 come back from an empty site and decide again at
 *  the nest at minutes chosen just before / just after the finder walks the last edge X–N00. Nobody can be recruited. */
const trailWorld = () => {
  const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
  s.ecology.insects_by_site.F07.living = 3; s.sources.F07.batches = []; s.sources.F07.protein = 0; c.trail_by_edge = {};
  Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: 2, large_prey_max_team: 1 });
  p.recruitment.recruitment_probability = 0; p.recruitment.follow_intermediate_source_probability = 0; p.scouting.scout_discovery_probability = 0; p.activity.continue_after_failure_probability = 1;
  q.prey.large_prey_fraction = 1;
  c.population.workers = c.population.workers.slice(0, 3);
  for (const id of ['F01', 'F08']) { Object.assign(s.sources[id], { host_alive: false, sugar: 0, protein: 0, batches: [] }); if (s.ecology.insects_by_site[id]) s.ecology.insects_by_site[id].living = 0; }
  const off = (cm: number) => (cm * 10) / (p.activity.trail_walking_speed_mm_s * p.activity.off_trail_speed_factor) / 60;
  const finderHome = 2 * 2 * off(300) + p.activity.search_minutes, fixed = p.activity.search_minutes + p.activity.rest_between_trips_minutes;
  const lenFor = (decideAt: number) => round(((decideAt - fixed) / 2) * 60 * p.activity.trail_walking_speed_mm_s * p.activity.off_trail_speed_factor / 10);
  q.routes.edges = [['N00', 'X'], ['X', 'F07'], ['N00', 'F01'], ['N00', 'F08']];
  q.routes.edge_length_cm = { 'N00:X': 300, 'F07:X': 300, 'F01:N00': lenFor(finderHome - 1), 'F08:N00': lenFor(finderHome + 1) };
  forager(c.population.workers[0], ['F07'], ['N00', 'X', 'F07']); forager(c.population.workers[1], ['F01'], ['N00', 'F01']); forager(c.population.workers[2], ['F08'], ['N00', 'F08']);
  return { s, p, q, finderHome: round(finderHome) };
};
if (want('P')) {
  const w = trailWorld(), { events: ev } = run(w.s, w.p, w.q);
  const alarm = ev.find((e) => e.type === 'local_alarm_signal'), home = ev.find((e) => e.type === 'long_range_recruitment_trail');
  ok(alarm && home && Math.abs(home.minute - w.finderHome) < 1e-6, `P fixture: the finder meets the prey at ${alarm?.minute} and reaches the nest at ${home?.minute} (expected ${w.finderHome})`);
  const decideMinute = (id: string) => { const s = segsOf(ev, id).find((x) => x.action === 'rest'); return s?.end; };
  const tA = decideMinute('W002'), tB = decideMinute('W003');
  ok(tA !== undefined && tB !== undefined && tA < w.finderHome && tB > w.finderHome, `P fixture: W002 decides at ${tA} (before the finder finishes X–N00 at ${w.finderHome}), W003 at ${tB} (after)`);
  // deposits carry their minute, and every edge is marked no earlier than the finder has walked it
  const deposits = ev.filter((e) => e.type === 'trail_deposited' && e.worker === 'W001').slice(0, 2); // the first hunt's trail home
  const walkedAt = (edge: string) => ev.find((e) => e.type === 'route_step' && e.worker === 'W001' && [e.from, e.to].sort().join(':') === edge && e.minute > (alarm?.minute ?? 0))?.minute;
  ok(deposits.length === 2 && deposits.every((d) => typeof d.minute === 'number' && d.minute >= (walkedAt(d.edge) ?? Infinity) - 1e-6), `P: the finder marks each edge when it has walked it (${JSON.stringify(deposits.map((d) => [d.edge, d.minute, walkedAt(d.edge)]))})`);
  const choiceBy = (id: string) => ev.find((e) => e.type === 'local_trail_choice' && e.worker === id);
  ok(!choiceBy('W002'), `P: W002 at ${tA} cannot sense a trail the finder has not laid yet on X–N00 (${JSON.stringify(choiceBy('W002') ?? null)})`);
  ok(choiceBy('W003')?.from === 'N00' && choiceBy('W003')?.to === 'X', `P: W003 at ${tB} senses the trail laid by the finder and follows it (${JSON.stringify(choiceBy('W003') ?? null)})`);
  // walking speed on an edge uses only trail laid before the walker set off (no trail from the future)
  const w3 = segsOf(ev, 'W003').find((x) => x.place?.startsWith('N00>X'));
  ok(w3 && Math.abs(ev.find((e) => e.type === 'route_step' && e.worker === 'W003' && e.to === 'X').minute - w3.start - round(300 * 10 / w.p.activity.trail_walking_speed_mm_s / 60)) < 1e-6, 'P: W003 walks N00–X at trail speed because the trail was already there when it set off');
}

// ---------------------------------------------------------------- T: planning does not read remote pheromone
if (want('T')) {
  const mk = (remoteTrail: boolean, window: number) => {
    const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
    c.population.workers = c.population.workers.slice(0, 1); forager(c.population.workers[0], ['F07'], ['N00', 'X', 'F07']);
    s.sources.F07.protein = 5; s.sources.F07.batches = [{ event_id: 'T', original_day: 0, protein: 5, age_days: 0, origin: 'test' }];
    q.routes.edges = [['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'N00:X': 300, 'F07:X': 300 };
    c.trail_by_edge = remoteTrail ? { 'F07:X': 1 } : {}; // the edge leaving the nest (N00–X) carries no trail in either world
    p.foraging_activity.daily_window_minutes = window;
    return { s, p, q };
  };
  const ac = SP.activity, base = ac.search_minutes + Math.max(ac.liquid_fill_minutes_full_crop, ac.protein_handling_minutes) + ac.unload_minutes;
  const offLeg = 2 * round(3000 / (ac.trail_walking_speed_mm_s * ac.off_trail_speed_factor) / 60), onFar = round(3000 / (ac.trail_walking_speed_mm_s * ac.off_trail_speed_factor) / 60) + round(3000 / ac.trail_walking_speed_mm_s / 60);
  const window = Math.floor((2 * offLeg + base + 2 * onFar + base) / 2); // between "fits with the remote trail" and "fits without"
  const first = (x: Any) => { const ev = run(x.s, x.p, x.q).events; return ev.filter((e) => e.worker === 'W001' && timeOf(e) === 0).map((e) => JSON.stringify(e)); };
  const A = first(mk(false, window)), B = first(mk(true, window));
  ok(2 * onFar + base <= window && window < 2 * offLeg + base, `T fixture: window ${window} min lies between ${round(2 * onFar + base)} and ${round(2 * offLeg + base)}`);
  same(B, A, 'T: the decision at the nest (depart or cancel) is the same whether or not a remote edge carries pheromone');
}

// ---------------------------------------------------------------- W: nobody is outside after the activity window
/** Every recorded activity of every worker ends inside the window (the reviewer's reproductions plus a sweep). */
const insideWindow = (ev: Any[], W: number) => ev.filter((e) => e.type === 'worker_activity' && e.end > W + 1e-6);
if (want('W')) {
  // independent review finding 1: a late joiner of a held prey walking home its own (longer) way after an escape
  let cases = 0;
  for (const [len, window, minTeam] of [[550, 54, 3], [500, 50, 3], [450, 48, 3], [550, 60, 3], [400, 44, 2], [600, 58, 3]] as const) {
    const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
    s.ecology.insects_by_site.F07.living = 3; s.sources.F07.batches = []; s.sources.F07.protein = 0;
    Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: minTeam });
    p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; p.foraging_activity.daily_window_minutes = window; q.prey.large_prey_fraction = 1;
    c.population.workers = c.population.workers.slice(0, 2);
    q.routes.edges = [['N00', 'F07'], ['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'F07:N00': 600, 'N00:X': len, 'F07:X': len };
    forager(c.population.workers[0], ['F07'], ['N00', 'F07']); forager(c.population.workers[1], ['F07'], ['N00', 'X', 'F07']);
    const { events: ev } = run(s, p, q), late = insideWindow(ev, window); cases++;
    ok(late.length === 0, `W hold (X edges ${len} cm, window ${window}, team ${minTeam}): nobody outside after the window (${JSON.stringify(late[0] ?? null)})`);
  }
  // independent review finding 2: following a chain of trail-marked junctions with unknown edge lengths
  for (const window of [80, 140, 280]) {
    const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
    c.population.workers = c.population.workers.slice(0, 1); forager(c.population.workers[0], [], null);
    p.scouting.scout_discovery_probability = 0; p.recruitment.follow_intermediate_source_probability = 1; p.foraging_activity.daily_window_minutes = window;
    const chain = ['N00', 'J1', 'J2', 'J3', 'J4', 'J5', 'J6'];
    q.routes.edges = chain.slice(1).map((n, i) => [chain[i], n]) as Any; q.routes.edge_length_cm = {};
    c.trail_by_edge = Object.fromEntries(chain.slice(1).map((n, i) => [[chain[i], n].sort().join(':'), 1]));
    const { events: ev } = run(s, p, q), late = insideWindow(ev, window); cases++;
    ok(ev.some((e) => e.type === 'local_trail_choice') && late.length === 0, `W trail chain (window ${window}): the follower is home inside the window (${JSON.stringify(late[0] ?? null)})`);
  }
  // re-review finding: the hunt/hold time checks left out unloading. Finder alone on an edge of unknown length (25 min),
  // one idle nestmate to recruit, window exactly = encounter + 3 legs + handling: unloading must still end inside it.
  { const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
    s.ecology.insects_by_site.F07.living = 3; s.sources.F07.batches = []; s.sources.F07.protein = 0; c.trail_by_edge = {};
    Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: 2 });
    p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; p.activity.continue_base = 0; p.activity.continue_crop_emptied_weight = 0; p.activity.continue_brood_need_weight = 0; q.prey.large_prey_fraction = 1;
    c.population.workers = c.population.workers.slice(0, 2);
    q.routes.edges = [['N00', 'F07']]; q.routes.edge_length_cm = {};
    const leg = q.routes.route_edge_minutes, window = leg + p.activity.search_minutes + 3 * leg + p.activity.protein_handling_minutes;
    p.foraging_activity.daily_window_minutes = window;
    forager(c.population.workers[0], ['F07'], ['N00', 'F07']);
    Object.assign(c.population.workers[1], { task: 'nurse', last_location: 'N00', age_days: 60 });
    const { events: ev } = run(s, p, q, 1), late = insideWindow(ev, window); cases++;
    ok(late.length === 0, `W unload (unknown-length edge, window ${window}): unloading ends inside the window (${JSON.stringify(late[0] ?? null)})`);
  }
  // and over real days
  let segs = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    let st = buildDay0('A1', seed, '2027-09-23', b).state;
    for (let d = 0; d < 20; d++) { const o = simulateWorldDay(st, b), ev: Any[] = o.result.colonies[0].events; segs += ev.filter((e) => e.type === 'worker_activity').length; assert.equal(insideWindow(ev, SP.foraging_activity.daily_window_minutes).length, 0, `W seed ${seed} day ${o.day}: activity after the window`); checks++; st = o.state; }
  }
  ok(cases === 10 && segs > 0, `W: ${cases} fixtures and ${segs} activity records over 120 colony-days end inside the window`);
}

// ---------------------------------------------------------------- S: walking speed is read on the edge the worker is on
if (want('S')) {
  // independent review finding 3: the finder marks F07–X on its way home; W002 (long way via Y) enters X–F07 after the
  // mark and must walk it at trail speed; W003 (short way via Y) enters it before the mark and walks it off-trail.
  const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
  s.ecology.insects_by_site.F07.living = 3; s.sources.F07.batches = []; s.sources.F07.protein = 0; c.trail_by_edge = {};
  Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: 9, large_prey_max_team: 1 });
  p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; q.prey.large_prey_fraction = 1;
  c.population.workers = c.population.workers.slice(0, 3);
  q.routes.edges = [['N00', 'X'], ['X', 'F07'], ['N00', 'Y'], ['Y', 'X'], ['N00', 'Z'], ['Z', 'X']];
  q.routes.edge_length_cm = { 'N00:X': 300, 'F07:X': 300, 'N00:Y': 600, 'X:Y': 600, 'N00:Z': 300, 'X:Z': 300 };
  forager(c.population.workers[0], ['F07'], ['N00', 'X', 'F07']); forager(c.population.workers[1], ['F07'], ['N00', 'Y', 'X', 'F07']); forager(c.population.workers[2], ['F07'], ['N00', 'Z', 'X', 'F07']);
  const { events: ev } = run(s, p, q);
  const mark = ev.find((e) => e.type === 'trail_deposited' && e.edge === 'F07:X' && e.worker === 'W001');
  const stepOn = (id: string) => { const i = ev.findIndex((e) => e.type === 'route_step' && e.worker === id && e.from === 'X' && e.to === 'F07'), x = ev[i]; const prev = ev.filter((e) => e.type === 'route_step' && e.worker === id && e.to === 'X' && e.minute <= x.minute).at(-1); return { enter: prev.minute, dur: round(x.minute - prev.minute) }; };
  const on = round(3000 / p.activity.trail_walking_speed_mm_s / 60), off = round(3000 / (p.activity.trail_walking_speed_mm_s * p.activity.off_trail_speed_factor) / 60);
  const a2 = stepOn('W002'), a3 = stepOn('W003');
  ok(mark && a2.enter > mark.minute && Math.abs(a2.dur - on) < 1e-6, `S: W002 enters X–F07 at ${a2.enter}, after the mark at ${mark?.minute}, and walks it at trail speed (${a2.dur} min; on-trail ${on})`);
  ok(mark && a3.enter < mark.minute && Math.abs(a3.dur - off) < 1e-6, `S: W003 enters X–F07 at ${a3.enter}, before the mark, and walks it off-trail (${a3.dur} min; off-trail ${off})`);
}

// ---------------------------------------------------------------- J: joint carriers learn the edges they carry along
if (want('J')) {
  const w = huntWorld({ living: 3, minTeam: 2, capture: 1, escape: 0, lens: [325, 325] }), { events: ev } = run(w.s, w.p, w.q);
  const joint = ev.find((e) => e.type === 'joint_prey_transport');
  const mem = (id: string) => Object.keys((w.s.colonies[0].population.workers.find((x: Any) => x.id === id) as Any).route_memory.edges);
  ok(joint && joint.carriers.some((x: Any) => x.worker === 'W002'), 'J fixture: W002 (came via X) carries the prey jointly with the finder along N00–F07');
  ok(mem('W002').includes('F07:N00'), `J: W002 has learned the edge F07–N00 it carried the prey along (${mem('W002').join(', ')})`);
}

// ---------------------------------------------------------------- G: generic invariant over real days
if (want('G')) {
  let choices = 0, days = 0;
  const limit = SP.recruitment.trail_min_detectable;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    let s = buildDay0('A1', seed, '2027-09-23', b).state;
    for (let d = 0; d < 20; d++) {
      const o = simulateWorldDay(s, b), ev: Any[] = o.result.colonies[0].events; days++;
      const atStart = new Set(ev.filter((e) => e.type === 'trail_decay' && e.to >= limit).map((e) => e.edge));
      for (const ch of ev.filter((e) => e.type === 'local_trail_choice' && typeof e.minute === 'number')) {
        const edge = [ch.from, ch.to].sort().join(':');
        const laid = ev.some((e) => e.type === 'trail_deposited' && e.edge === edge && typeof e.minute === 'number' && e.minute <= ch.minute + 1e-9);
        assert.ok(atStart.has(edge) || laid, `G seed ${seed} day ${o.day}: ${ch.worker} chose ${edge} at ${ch.minute} before any trail existed there`); choices++;
      }
      s = o.state;
    }
  }
  ok(days === 160 && choices > 0, `G: ${days} colony-days, ${choices} local trail choices all on an existing trail`);
  console.log(`G: ${days} colony-days, ${choices} local trail choices checked`);
}
if (SOFT && failed.length) { console.log(`issue44-locality: ${failed.length} FAILED checks:\n- ${failed.join('\n- ')}`); process.exitCode = 1; }
console.log(`issue44-locality: ${checks} checks passed`);
