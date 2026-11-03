/**
 * Issue #43 DEFECT PROBES (evidence, not part of the test suite). Adapted from the Codex review appendix. Each probe
 * runs twice: with activity.local_causality_v20 = false (v2-review.19 behaviour) and = true (v2-review.20). It
 * prints whether the defect is PRESENT; it does not assert, so it documents the before/after state.
 *   node tests/issue43/defect-probes.ts
 * The correct-behaviour regression assertions are in tests/issue43-timeline.test.ts.
 */
import { loadBundle } from '../../cli/lib/load.ts';
import { buildDay0 } from '../../cli/lib/day0.ts';
import { resolveBundle, simulateWorldDay } from '../../engine/index.ts';
import { activityDay } from '../../engine/activity.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const weather: Any = { nest_temp_model_c: 25, rain_mm: 0, daytime_air_temp_c: 28, soil_index: 0 };
const summary = (): Any => ({ extra_sugar_cost: 0, income: { sugar: 0, protein: 0 }, tasks: { forage: 0, nurse: 0, rest: 0, repair: 0, guard: 0 }, foraging_trips: 0, foraging_successes: 0, scouts: 0, recruited: 0, foraging_workers_by_macro: { sugar: new Set(), protein: new Set() } });
const out: Any = {};
for (const v20 of [false, true]) {
  const b = loadBundle(); (b.species['pheidole-megacephala'] as Any).activity.local_causality_v20 = v20;
  const rp = resolveBundle(b), SP = rp.species['pheidole-megacephala'], WP = rp.world, fresh = () => buildDay0('A1', 1, '2027-09-23', b).state;
  const r: Any = {};
  { // F02
    const steps = [true, false].map((alive) => { const s = fresh(), c = s.colonies[0], p = structuredClone(SP); c.population.workers = c.population.workers.slice(0, 1); Object.assign(c.population.workers[0], { task: 'forage', known_sources: [], site_memory: {}, route_memory: { origin: 'probe', edges: {}, empty_sites: {} } }); c.trail_by_edge = { 'F01:N00': 1 }; s.sources.F01.host_alive = alive; p.scouting.scout_discovery_probability = 0; const e: Any[] = []; activityDay({ world: s, colony: c, sp: p, wp: WP, weather, events: e, summary: summary(), learnDay: 1 } as Any, c.population.workers); return e.filter((x) => x.type === 'route_step').length; });
    r.F02_remote_host_changes_departure = steps[0] > 0 && steps[1] === 0;
  }
  const hunt = (living: number, minTeam: number, len: number) => { const s = fresh(), c = s.colonies[0], p = structuredClone(SP), q = structuredClone(WP); s.ecology.insects_by_site.F07.living = living; s.sources.F07.batches = []; s.sources.F07.protein = 0; Object.assign(p.predation, { live_prey_encounter_probability: 1, live_prey_capture_probability: 1, large_prey_escape_while_recruiting_probability: 0, large_prey_min_team: minTeam }); p.recruitment.recruitment_probability = 0; p.activity.continue_after_failure_probability = 0; q.prey.large_prey_fraction = 1; c.population.workers = c.population.workers.slice(0, 2); const routes = [['N00', 'F07'], ['N00', 'X', 'F07']]; q.routes.edges = [['N00', 'F07'], ['N00', 'X'], ['X', 'F07']]; q.routes.edge_length_cm = { 'F07:N00': 600, 'N00:X': len, 'F07:X': len }; for (let i = 0; i < 2; i++) { const w = c.population.workers[i]; w.task = 'forage'; w.known_sources = ['F07']; w.site_memory = { F07: { last_success_portions: 1, last_visit_day: 0 } }; w.route_memory = { origin: 'probe', edges: Object.fromEntries(routes[i].slice(1).map((x, j) => [[routes[i][j], x].sort().join(':'), { acquired: 'walked', first_day: 0, last_day: 0 }])), empty_sites: {} } as Any; } const e: Any[] = []; activityDay({ world: s, colony: c, sp: p, wp: q, weather, events: e, summary: summary(), learnDay: 1 } as Any, c.population.workers); return e; };
  { const e = hunt(3, 2, 325), s = e.filter((x) => x.type === 'worker_activity' && x.worker === 'W002').sort((x, y) => x.start - y.start); r.F03_overlapping_activities = s.some((x, i) => i > 0 && x.start < s[i - 1].end - 1e-6); }
  { const e = hunt(1, 3, 360); r.F04_late_arrival_cannot_join_last_prey = !e.some((x) => x.type === 'waiting_prey_joined'); }
  { let s = buildDay0('A1', 4, '2027-09-23', b).state, miss = false; for (let d = 0; d < 3; d++) { const o = simulateWorldDay(s, b), cr: Any = o.result.colonies[0], ac = cr.summary.activity; if (ac && Math.abs(ac.outside_minutes * SP.activity.active_minute_sugar_cost - cr.summary.extra_sugar_cost) > 1e-4) miss = true; s = o.state; } r.F05_energy_not_charged_seed4_first3days = miss; }
  out[v20 ? 'v20_switch_on' : 'v19_behaviour_switch_off'] = r;
}
console.log(JSON.stringify(out, null, 1));
