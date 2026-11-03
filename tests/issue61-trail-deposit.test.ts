/**
 * Codex Issue #61 R3-05 (v2-review.23, switch activity.local_trail_deposit_v23): pheromone is laid only by a worker that
 * is on the edge, at the minute it has walked it. v2-review.22 marked the whole return route at the minute the worker
 * reached the nest, so a remote edge received trail while the worker was already unloading inside the nest.
 *
 *  A  Appendix A (Issue #61): A1 / autumn / seed 1, day 16, W002 walked F10–U01 at 99.442363 and the trail appeared at
 *     124.442363 (unloading in the nest). Same start state of day 16: with the switch OFF the defect reproduces (evidence
 *     of the old model, NOT a correctness pass); with it ON W002 marks F10–U01 at the minute it has walked it.
 *  L  locality invariant over real days (5 foundings x 4 seasons x 2 seeds x 20 days): every mark is laid by a worker on
 *     that edge — the same worker has a route_step on that edge ending at exactly the mark's minute, entered at
 *     `walked_from`; no mark is written at the nest for a remote edge; `deposited` reconstructs `intensity`.
 *  N  normal foraging (fixture): each edge of the return walk is marked once, far edge first, at the minute the forager
 *     finished it; the far edge's mark is earlier than the unloading.
 *  E  empty return (fixture): a forager that finds nothing walks home and marks nothing.
 *  J  joint prey transport (fixture): every carrier marks each edge it carries along, at its own walking minutes.
 *  R  recruitment and trail use (both switch settings): every edge after the first of a walk is walked at the speed given
 *     by the trail laid on that edge up to the minute it was entered (no trail from the future); a nestmate recruited at
 *     the end of unloading sets off when the recruiter has already marked every edge of the route on its walk home.
 *  D  deposit decision (real days): only walks home with collected food (cause laden_return) or the recruiting hunt
 *     finder (hunt_recruit) mark; outbound walks, explorations, recruits and empty returns do not.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { resolveBundle, simulateWorldDay } from '../engine/index.ts';
import { activityDay, edgeMinutes } from '../engine/activity.ts';
import { round } from '../engine/math.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ONLY = process.env.ISSUE61_ONLY; const want = (k: string) => !ONLY || ONLY === k;
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle(), rp = resolveBundle(b), SP = rp.species['pheidole-megacephala'], WP = rp.world;
const bundleWith = (on: boolean) => { const x: Any = structuredClone(b); x.species['pheidole-megacephala'].activity.local_trail_deposit_v23 = on; return x; };
const B_ON = bundleWith(true), B_OFF = bundleWith(false);
const spWith = (on: boolean) => { const p: Any = structuredClone(SP); p.activity.local_trail_deposit_v23 = on; return p; };
const ekey = (a: string, c: string) => [a, c].sort().join(':');
const weather: Any = { nest_temp_model_c: 25, rain_mm: 0, daytime_air_temp_c: 28, soil_index: 0 };
const summary = (): Any => ({ extra_sugar_cost: 0, income: { sugar: 0, protein: 0 }, tasks: { forage: 0, nurse: 0, rest: 0, repair: 0, guard: 0 }, foraging_trips: 0, foraging_successes: 0, scouts: 0, recruited: 0, foraging_workers_by_macro: { sugar: new Set(), protein: new Set() } });
const mem = (route: string[]): Any => ({ origin: 'test', edges: Object.fromEntries(route.slice(1).map((x, j) => [ekey(route[j], x), { acquired: 'walked', first_day: 0, last_day: 0 }])), empty_sites: {} });
const forager = (w: Any, sites: string[], route: string[]) => Object.assign(w, { task: 'forage', known_sources: sites, site_memory: Object.fromEntries(sites.map((s) => [s, { last_success_portions: 1, last_visit_day: 0 }])), route_memory: mem(route) });
const run = (s: Any, p: Any, q: Any) => { const c = s.colonies[0], events: Any[] = []; activityDay({ world: s, colony: c, sp: p, wp: q, weather, events, summary: summary(), learnDay: 1 } as Any, c.population.workers); return events; };
const deposits = (ev: Any[]) => ev.filter((e) => e.type === 'trail_deposited' && typeof e.minute === 'number');
const unloads = (ev: Any[], id: string) => ev.filter((e) => e.type === 'worker_activity' && e.worker === id && e.action === 'unload');
const stepEnding = (ev: Any[], d: Any) => ev.find((e) => e.type === 'route_step' && e.worker === d.worker && ekey(e.from, e.to) === d.edge && Math.abs(e.minute - d.minute) < 1e-9);

/** The locality invariant used by L, N, J (switch on): returns the number of marks checked. */
const checkLocal = (ev: Any[], nest: string, where: string) => {
  let n = 0;
  const before: Record<string, number> = {};
  // a decayed edge below the detectable limit is removed from the colony's trails (engine/trails.ts decayTrails)
  for (const e of ev) if (e.type === 'trail_decay') before[e.edge] = e.to >= SP.recruitment.trail_min_detectable ? e.to : 0;
  for (const d of ev.filter((e) => e.type === 'trail_deposited')) {
    assert.ok(typeof d.minute === 'number' && d.on_edge === true && typeof d.walked_from === 'number' && typeof d.deposited === 'number', `${where}: mark ${JSON.stringify(d)} carries minute, walked_from, deposited, on_edge`);
    assert.ok(d.cause === 'laden_return' || d.cause === 'hunt_recruit', `${where}: mark cause ${d.cause}`);
    const s = stepEnding(ev, d);
    assert.ok(s, `${where}: ${d.worker} marked ${d.edge} at ${d.minute} without having just walked it`);
    // entered at walked_from: either the end of its previous step (which ended at this edge's start node) or the start of the walk
    const prevStep = ev.filter((e) => e.type === 'route_step' && e.worker === d.worker && Math.abs(e.minute - d.walked_from) < 1e-9).at(-1);
    assert.ok(d.walked_from < d.minute && (!prevStep || prevStep.to === s.from || prevStep === s), `${where}: ${d.worker} entered ${d.edge} at ${d.walked_from} (previous step ${JSON.stringify(prevStep ?? null)})`);
    // no mark on a remote edge while the marker is unloading in the nest
    const remote = !d.edge.split(':').includes(nest);
    if (remote) assert.ok(!unloads(ev, d.worker).some((u: Any) => d.minute >= u.start - 1e-9 && d.minute < u.end - 1e-9), `${where}: ${d.worker} marked remote ${d.edge} at ${d.minute} while unloading in the nest`);
    const prev = before[d.edge] ?? 0;
    assert.ok(Math.abs(round(prev + d.deposited) - d.intensity) < 1e-9 && d.deposited >= 0 && d.deposited <= SP.recruitment.trail_deposit_per_success + 1e-12, `${where}: ${d.edge} ${prev} + ${d.deposited} != ${d.intensity}`);
    before[d.edge] = d.intensity; n++;
  }
  return n;
};

// ---------------------------------------------------------------- A: Appendix A, W002 on F10–U01
if (want('A')) {
  // days 0..15 under v2-review.22 so that day 16 starts from the state Codex used
  let s = buildDay0('A1', 1, '2027-09-23', b).state;
  for (let d = 0; d < 15; d++) s = simulateWorldDay(s, B_OFF).state;
  const off = simulateWorldDay(structuredClone(s), B_OFF), on = simulateWorldDay(structuredClone(s), B_ON);
  ok(off.day === 16 && on.day === 16, `A fixture: day ${off.day}`);
  const evOff: Any[] = off.result.colonies[0].events, evOn: Any[] = on.result.colonies[0].events;
  const wOff = deposits(evOff).find((e) => e.worker === 'W002' && e.edge === 'F10:U01');
  const walkOff = evOff.filter((e) => e.type === 'route_step' && e.worker === 'W002' && ekey(e.from, e.to) === 'F10:U01' && e.minute <= (wOff?.minute ?? 0)).at(-1);
  // OLD MODEL evidence (defect present with the switch off; this is not a correctness test)
  ok(wOff && walkOff && Math.abs(walkOff.minute - 99.442363) < 1e-6 && Math.abs(wOff.minute - 124.442363) < 1e-6 && unloads(evOff, 'W002').some((u: Any) => Math.abs(u.start - wOff.minute) < 1e-9),
    `A (switch off, old model): W002 walked F10–U01 at ${walkOff?.minute} and the trail appeared at ${wOff?.minute}, while it unloaded in the nest`);
  // CORRECTNESS with the switch on: W002's mark on F10–U01 at the minute it has walked it
  const wOn = deposits(evOn).filter((e) => e.worker === 'W002' && e.edge === 'F10:U01');
  const walkOn = evOn.filter((e) => e.type === 'route_step' && e.worker === 'W002' && ekey(e.from, e.to) === 'F10:U01');
  ok(wOn.length > 0 && wOn.every((d) => stepEnding(evOn, d) && d.cause === 'laden_return'), `A (switch on): every W002 mark on F10–U01 is at the end of its own step on that edge (${JSON.stringify(wOn.map((d) => [d.minute, d.walked_from]))}; steps ${JSON.stringify(walkOn.map((e) => e.minute))})`);
  ok(wOn.some((d) => Math.abs(d.minute - 99.442363) < 1e-6), `A (switch on): W002 marks F10–U01 at 99.442363, when it has walked it (not at 124.442363 in the nest)`);
  ok(!wOn.some((d) => unloads(evOn, 'W002').some((u: Any) => d.minute >= u.start - 1e-9 && d.minute < u.end - 1e-9)), 'A (switch on): no W002 mark on F10–U01 while unloading');
  checks += checkLocal(evOn, s.colonies[0].nest_node, 'A');
}

// ---------------------------------------------------------------- L: locality invariant over real days
if (want('L')) {
  let days = 0, marks = 0, laden = 0, hunt = 0;
  for (const founding of ['A1', 'A2', 'A3', 'A4', 'A5'] as Any[]) for (const date of ['2027-03-21', '2027-06-21', '2027-09-23', '2027-12-22']) for (const seed of [1, 2]) {
    let s = buildDay0(founding, seed, date, B_ON).state;
    for (let d = 0; d < 20; d++) {
      const o = simulateWorldDay(s, B_ON);
      for (const c of o.result.colonies) { const ev: Any[] = c.events; marks += checkLocal(ev, s.colonies[0].nest_node, `L ${founding} ${date} seed ${seed} day ${o.day}`); laden += ev.filter((e) => e.type === 'trail_deposited' && e.cause === 'laden_return').length; hunt += ev.filter((e) => e.type === 'trail_deposited' && e.cause === 'hunt_recruit').length; }
      s = o.state; days++;
    }
  }
  ok(days === 800 && marks > 0 && laden > 0, `L: ${days} colony-days, ${marks} marks all laid on the edge being walked (${laden} laden returns, ${hunt} hunt recruiters)`);
  console.log(`L: ${days} colony-days, ${marks} marks (${laden} laden_return, ${hunt} hunt_recruit)`);
}

// ---------------------------------------------------------------- fixtures N, E, R
/** One or two foragers; F01 at the end of N00–X–Y–F01 (300 cm per edge). */
const lineWorld = (o: { sugar: number; n?: number; recruit?: number }) => {
  const s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0], q: Any = structuredClone(WP);
  q.routes.edges = [['N00', 'X'], ['X', 'Y'], ['Y', 'F01']]; q.routes.edge_length_cm = { 'N00:X': 300, 'X:Y': 300, 'F01:Y': 300 };
  c.trail_by_edge = {};
  c.population.workers = c.population.workers.slice(0, o.n ?? 1);
  forager(c.population.workers[0], ['F01'], ['N00', 'X', 'Y', 'F01']);
  for (const w of c.population.workers.slice(1)) Object.assign(w, { task: 'forage', known_sources: [], site_memory: {}, route_memory: mem(['N00']) });
  const src: Any = s.sources.F01; src.sugar = o.sugar; src.protein = 0; if (o.sugar === 0) src.host_alive = true;
  return { s, c, q };
};
if (want('N')) {
  const w = lineWorld({ sugar: 5 }), p = spWith(true); p.recruitment.recruitment_probability = 0; p.activity.continue_base = 0; p.activity.continue_crop_emptied_weight = 0; p.activity.continue_brood_need_weight = 0;
  const ev = run(w.s, p, w.q), mine = deposits(ev).filter((e) => e.worker === 'W001'), u = unloads(ev, 'W001')[0];
  ok(u, 'N fixture: W001 collected sugar and unloaded');
  const firstTrip = mine.filter((d) => d.minute <= u.start + 1e-9);
  ok(firstTrip.map((d) => d.edge).join(',') === 'F01:Y,X:Y,N00:X', `N: the return walk marks the far edge first, then the middle, then the nest edge (${firstTrip.map((d) => d.edge).join(',')})`);
  ok(firstTrip[0].minute < firstTrip[1].minute && firstTrip[1].minute < firstTrip[2].minute && Math.abs(firstTrip[2].minute - u.start) < 1e-9 && firstTrip[0].minute < u.start, `N: marks at ${firstTrip.map((d) => d.minute).join(', ')}; unloading starts at ${u.start}`);
  checks += checkLocal(ev, 'N00', 'N');
  // the same fixture with the switch off: the whole route at the minute of arrival (old model, for the difference only)
  const w0 = lineWorld({ sugar: 5 }), p0 = spWith(false); Object.assign(p0.recruitment, { recruitment_probability: 0 }); Object.assign(p0.activity, { continue_base: 0, continue_crop_emptied_weight: 0, continue_brood_need_weight: 0 });
  const ev0 = run(w0.s, p0, w0.q), u0 = unloads(ev0, 'W001')[0], old = deposits(ev0).filter((e) => e.worker === 'W001' && e.minute <= u0.start + 1e-9);
  ok(old.length === 3 && old.every((d) => Math.abs(d.minute - u0.start) < 1e-9), `N (switch off, old model): all three edges marked at ${u0.start}, the minute of arrival`);
}
if (want('E')) {
  const w = lineWorld({ sugar: 0 }), p = spWith(true); p.activity.continue_after_failure_probability = 0;
  const ev = run(w.s, p, w.q);
  ok(ev.some((e) => e.type === 'route_step' && e.worker === 'W001' && e.to === 'N00'), 'E fixture: W001 walked home');
  ok(!unloads(ev, 'W001').length, 'E fixture: W001 had nothing to unload');
  ok(deposits(ev).length === 0, `E: an empty return marks nothing (${deposits(ev).length} marks)`);
}
if (want('D')) {
  // real days: outbound walks, explorations and recruits following a trail do not mark; returns home do only when the
  // worker carries collected food (an empty return is a 'foraging_return' walk without marks)
  const RETURN = new Set(['foraging_return', 'recruit_return', 'joint_prey_transport', 'hunt_recruit_trail_home']);
  let walkSteps = 0, markedSteps = 0, emptyReturnSteps = 0;
  for (const seed of [1, 2, 3]) {
    let s = buildDay0('A1', seed, '2027-06-21', B_ON).state;
    for (let d = 0; d < 15; d++) {
      const o = simulateWorldDay(s, B_ON), ev: Any[] = o.result.colonies[0].events;
      const marked = new Set(deposits(ev).map((x) => stepEnding(ev, x)));
      for (const st of ev.filter((e) => e.type === 'route_step')) {
        walkSteps++;
        if (marked.has(st)) { markedSteps++; assert.ok(RETURN.has(st.kind), `D seed ${seed} day ${o.day}: ${st.worker} marked on a ${st.kind} walk`); }
        else if (st.kind === 'foraging_return') emptyReturnSteps++;
      }
      s = o.state;
    }
  }
  ok(markedSteps > 0 && walkSteps > markedSteps && emptyReturnSteps > 0, `D: ${markedSteps} of ${walkSteps} walked edges marked; ${emptyReturnSteps} return edges walked without food carried no mark`);
  console.log(`D: ${markedSteps}/${walkSteps} walked edges marked, ${emptyReturnSteps} empty-return edges unmarked`);
}
if (want('R')) {
  // W001 forages; W002 (no known source) decides at the nest while W001 is between Y and the nest: with the switch on it
  // senses nothing on N00–X (W001 has not walked it yet) but the remote marks exist in the colony state. Every walking
  // minute equals the speed from the trail laid on that edge up to the minute the edge was entered.
  const speedCheck = (ev: Any[], q: Any, p: Any, where: string) => {
    let n = 0;
    const steps = ev.filter((e) => e.type === 'route_step');
    for (const st of steps) {
      // a walk's next edge is entered at the minute its previous edge ended (same walk kind, consecutive nodes); the
      // first edge of a walk has no such step and is skipped
      const i = steps.indexOf(st), prev = steps.slice(0, i).filter((e) => e.worker === st.worker).at(-1);
      if (!prev || prev.to !== st.from || prev.kind !== st.kind) continue;
      const entered = prev.minute, trail: Record<string, number> = {};
      for (const d of deposits(ev)) if (d.minute <= entered + 1e-9) trail[d.edge] = d.intensity;
      const want = edgeMinutes(p, q, { trail_by_edge: trail } as Any, st.from, st.to).minutes;
      assert.ok(Math.abs(st.minute - entered - want) < 1e-6, `${where}: ${st.worker} walked ${st.from}–${st.to} entered ${entered} in ${round(st.minute - entered)} min; trail laid by then gives ${want}`);
      n++;
    }
    return n;
  };
  for (const on of [true, false]) {
    const w = lineWorld({ sugar: 5, n: 3 }), p = spWith(on); p.recruitment.recruitment_probability = 1;
    const ev = run(w.s, p, w.q);
    const n = speedCheck(ev, w.q, p, `R switch ${on}`);
    ok(n > 0, `R (switch ${on}): ${n} walked edges each at the speed of the trail laid on it by the minute it was entered`);
    const recruits = ev.filter((e) => e.type === 'local_recruitment');
    if (on) {
      ok(recruits.length > 0, 'R fixture: W001 recruited a nestmate at the end of unloading');
      for (const r of recruits) {
        // the recruit sets off when unloading ends; by then every edge of the route has been marked on the walk home
        const marks = deposits(ev).filter((d) => d.worker === r.by && d.minute <= r.minute + 1e-9).map((d) => d.edge);
        ok(['F01:Y', 'X:Y', 'N00:X'].every((x) => marks.includes(x)), `R: when ${r.to} is recruited at ${r.minute}, the recruiter has marked ${marks.join(',')}`);
      }
    }
  }
}
// ---------------------------------------------------------------- J: joint prey transport
if (want('J')) {
  const s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0], p = spWith(true), q: Any = structuredClone(WP);
  s.ecology.insects_by_site.F07.living = 3; s.sources.F07.batches = []; s.sources.F07.protein = 0; c.trail_by_edge = {};
  Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: 2, large_prey_max_team: 3 });
  p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; p.activity.continue_base = 0; q.prey.large_prey_fraction = 1;
  c.population.workers = c.population.workers.slice(0, 2);
  q.routes.edges = [['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'N00:X': 300, 'F07:X': 300 };
  forager(c.population.workers[0], ['F07'], ['N00', 'X', 'F07']); forager(c.population.workers[1], ['F07'], ['N00', 'X', 'F07']);
  const ev = run(s, p, q), joint = ev.find((e) => e.type === 'joint_prey_transport');
  ok(joint && joint.carriers.length === 2, `J fixture: two workers carry one prey jointly (${JSON.stringify(joint?.carriers ?? null)})`);
  for (const cr of joint.carriers) {
    const mine = deposits(ev).filter((d) => d.worker === cr.worker && d.cause === 'laden_return');
    ok(mine.map((d) => d.edge).join(',') === 'F07:X,N00:X' && mine.every((d) => stepEnding(ev, d)?.kind === 'joint_prey_transport'), `J: carrier ${cr.worker} marks F07–X then N00–X while carrying (${JSON.stringify(mine.map((d) => [d.edge, d.minute]))})`);
  }
  checks += checkLocal(ev, 'N00', 'J');
}
console.log(`issue61-trail-deposit: ${checks} checks passed`);
