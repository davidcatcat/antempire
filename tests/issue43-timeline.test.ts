/**
 * Issue #43 (Codex independent review) — CORRECT-BEHAVIOUR regression tests for F02–F05 on the individual activity
 * timeline (engine/activity.ts). These assertions describe what the engine must do; they FAIL on main 1b2b463
 * (v2-review.19) and pass from v2-review.20 on. The original "defect exists" probes are kept separately in
 * tests/issue43/defect-probes.ts (evidence, not part of the suite).
 *  F02 a worker standing in the nest cannot be influenced by the state of a remote host it has not reached;
 *  F03 a worker interrupted while searching (short-range prey recruitment) never has two activities at once;
 *  F04 a late arrival may join a prey already held for recruits even when no OTHER unreserved prey is there;
 *  F05 every outside minute is charged exactly once: extra_sugar_cost = Σ outside minutes × active_minute_sugar_cost.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { resolveBundle, simulateWorldDay } from '../engine/index.ts';
import { activityDay } from '../engine/activity.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ONLY = process.env.ISSUE43_ONLY; const want = (k: string) => !ONLY || ONLY === k; // run one section: ISSUE43_ONLY=F03
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle(), rp = resolveBundle(b), SP = rp.species['pheidole-megacephala'], WP = rp.world;
const fresh = (seed = 1) => buildDay0('A1', seed, '2027-09-23', b).state;
const weather: Any = { nest_temp_model_c: 25, rain_mm: 0, daytime_air_temp_c: 28, soil_index: 0 };
const summary = (): Any => ({ extra_sugar_cost: 0, income: { sugar: 0, protein: 0 }, tasks: { forage: 0, nurse: 0, rest: 0, repair: 0, guard: 0 }, foraging_trips: 0, foraging_successes: 0, scouts: 0, recruited: 0, foraging_workers_by_macro: { sugar: new Set(), protein: new Set() } });
const overlaps = (events: Any[]) => {
  const by = new Map<string, Any[]>();
  for (const e of events.filter((x) => x.type === 'worker_activity')) by.set(e.worker, [...(by.get(e.worker) ?? []), e]);
  const bad: Any[] = [];
  for (const [, s] of by) { s.sort((x, y) => x.start - y.start || x.end - y.end); for (let i = 1; i < s.length; i++) if (s[i].start < s[i - 1].end - 1e-6) bad.push([s[i - 1], s[i]]); }
  return bad;
};

// ---------------------------------------------------------------- F02: no remote perception before arrival
if (want('F02')) {
  const run = (hostAlive: boolean) => {
    const s = fresh(), c = s.colonies[0], p = structuredClone(SP);
    c.population.workers = c.population.workers.slice(0, 1);
    const w = c.population.workers[0];
    Object.assign(w, { task: 'forage', known_sources: [], site_memory: {}, route_memory: { origin: 'test', edges: {}, empty_sites: {} } });
    c.trail_by_edge = { 'F01:N00': 1 };
    s.sources.F01.host_alive = hostAlive;
    p.scouting.scout_discovery_probability = 0; // trail following only (no exploration)
    const events: Any[] = [];
    activityDay({ world: s, colony: c, sp: p, wp: WP, weather, events, summary: summary(), learnDay: 1 } as Any, c.population.workers);
    return events;
  };
  const alive = run(true), dead = run(false);
  const firstStep = (ev: Any[]) => ev.find((e) => e.type === 'route_step');
  ok(firstStep(alive) && firstStep(dead), `F02: the worker leaves the nest along the trail whether or not the remote host lives (alive ${!!firstStep(alive)}, dead ${!!firstStep(dead)})`);
  if (firstStep(alive) && firstStep(dead)) {
    assert.deepEqual({ ...firstStep(dead) }, { ...firstStep(alive) }, 'F02: identical first step (same edge, same minute) — the remote state is not perceived from the nest'); checks++;
    const timeOf = (e: Any) => (typeof e.minute === 'number' ? e.minute : typeof e.start === 'number' ? e.start : null);
    const before = (ev: Any[]) => ev.filter((e) => e.worker === 'W001' && timeOf(e) !== null && timeOf(e) < firstStep(alive).minute).map((e) => JSON.stringify(e));
    assert.deepEqual(before(dead), before(alive), 'F02: everything the worker does before reaching F01 is identical'); checks++;
    ok(dead.some((e) => e.type === 'scouted_empty' && e.minute === firstStep(dead).minute), 'F02: the dead host is perceived only on arrival at F01');
  }
}

// ---------------------------------------------------------------- F03 / F04: hunting with different arrival times
const huntRun = (living: number, minTeam: number, lengths: [number, number]) => {
  const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP);
  s.ecology.insects_by_site.F07.living = living; s.sources.F07.batches = []; s.sources.F07.protein = 0;
  Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: minTeam });
  p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0;
  q.prey.large_prey_fraction = 1;
  c.population.workers = c.population.workers.slice(0, 2);
  const routes = [['N00', 'F07'], ['N00', 'X', 'F07']];
  q.routes.edges = [['N00', 'F07'], ['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'F07:N00': 600, 'N00:X': lengths[0], 'F07:X': lengths[1] };
  for (let i = 0; i < 2; i++) { const w = c.population.workers[i]; w.task = 'forage'; w.known_sources = ['F07']; w.site_memory = { F07: { last_success_portions: 1, last_visit_day: 0 } }; w.route_memory = { origin: 'test', edges: Object.fromEntries(routes[i].slice(1).map((x, j) => [[routes[i][j], x].sort().join(':'), { acquired: 'walked', first_day: 0, last_day: 0 }])), empty_sites: {} } as Any; }
  const events: Any[] = []; activityDay({ world: s, colony: c, sp: p, wp: q, weather, events, summary: summary(), learnDay: 1 } as Any, c.population.workers);
  return events;
};
if (want('F03')) {
  const ev = huntRun(3, 2, [325, 325]);
  ok(ev.some((e) => e.type === 'insect_predation'), 'F03 fixture: the short-range team captures the prey');
  const bad = overlaps(ev);
  ok(bad.length === 0, `F03: no worker has two overlapping activities (found ${bad.length}: ${JSON.stringify(bad[0] ?? null)})`);
  const cut = ev.find((e) => e.type === 'worker_activity' && e.action === 'search' && e.outcome === 'interrupted_by_prey_recruitment');
  ok(!!cut, 'F03: the interrupted search segment is closed at the interruption and says so');
}
if (want('F04')) {
  const ev = huntRun(1, 3, [360, 360]);
  ok(ev.some((e) => e.type === 'live_prey_encounter'), 'F04 fixture: the first worker finds the last living prey and holds it');
  ok(ev.some((e) => e.type === 'waiting_prey_joined' && (e.joiners as string[]).includes('W002')), 'F04: the later worker joins the held prey even though no other unreserved prey is there');
  ok(overlaps(ev).length === 0, 'F04: no overlapping activities while waiting');
}

// ---------------------------------------------------------------- F05: every outside minute charged once
if (want('F05')) {
  let days = 0, longRange = 0, worst = 0, overlapDays = 0, recruitChecks = 0;
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
    let s = buildDay0('A1', seed, '2027-09-23', b).state;
    for (let d = 0; d < 30; d++) {
      const o = simulateWorldDay(s, b), r: Any = o.result.colonies[0], ac = r.summary.activity;
      if (ac) {
        const expected = ac.outside_minutes * SP.activity.active_minute_sugar_cost, actual = r.summary.extra_sugar_cost;
        // per-trip rounding to 1e-6: tolerance = trips × 1e-6
        const tol = (ac.trips + 2) * 1.5e-6, diff = Math.abs(expected - actual);
        worst = Math.max(worst, diff - tol); days++;
        if (r.events.some((e: Any) => e.type === 'long_range_recruitment_trail')) longRange++;
        // one activity at a time for every worker, every day (F03 and R11b would both show up here)
        const bad = overlaps(r.events); assert.equal(bad.length, 0, `seed ${seed} day ${o.day}: overlapping activities ${JSON.stringify(bad[0] ?? null)}`); overlapDays++;
        // R11b: a recruited follower is in the nest (no outside activity in progress) at the recruitment minute
        for (const rec of r.events.filter((e: Any) => e.type === 'local_recruitment')) {
          const busy = r.events.find((e: Any) => e.type === 'worker_activity' && e.worker === rec.to && e.action !== 'rest' && e.start < rec.minute - 1e-6 && e.end > rec.minute + 1e-6);
          assert.ok(!busy, `R11b seed ${seed} day ${o.day}: ${rec.to} recruited at ${rec.minute} while busy with ${JSON.stringify(busy)}`); recruitChecks++;
        }
        assert.ok(diff <= tol, `F05 seed ${seed} day ${o.day}: extra_sugar_cost ${actual} ≠ outside ${ac.outside_minutes} × rate = ${expected}`);
      }
      s = o.state;
    }
  }
  ok(days > 0 && longRange > 0, `F05: ${days} colony-days checked, ${longRange} with long-range prey recruitment (the branch that skipped the charge)`);
  ok(overlapDays === days && recruitChecks > 0, `F03/R11b: ${overlapDays} colony-days without overlaps; ${recruitChecks} recruitments with the follower in the nest`);
}
console.log(`issue43-timeline: ${checks} checks passed`);
