/**
 * Port of sim/test_naturalism.cjs (v6: 214 checks). No-god-mode regression. Never writes saves.
 * Two checks run per tracked insect death and one per physical scout visit in the 30-day trajectory, so the
 * exact count depends on the rules version: v6–v2-review.8 = 214 (18 insect deaths, 1 scout visit);
 * v2-review.9 (#10, simultaneous site-window hunting) to v2-review.13 = 213 (17 insect deaths, 2 scout visits);
 * v2-review.14 (#8, individual route memory) = 211 (17 insect deaths, 0 v12-style scout visits: exploration replaces
 * them and is checked separately below and in tests/navigation.test.ts);
 * v2-review.17 (activity timeline) = 212 (17 insect deaths; the exploration-reach check is split into two
 * checks because a worker may now walk to a place earlier the same day and explore beyond it);
 * v2-review.20 (Issue #43 local-causality fixes) = 214 (18 insect deaths; the trajectory changed, no check removed). The count must
 * equal the current version's expected value exactly; every assertion must pass.
 */
import { simulateDay, foragingTemperatureFactor, resolveSpecies } from '../engine/index.ts';
import { bundle, counter, fixture, MAIN_SPECIES, setParam, species } from './lib/harness.ts';

const LEGACY_CHECK_COUNT = 214;
const EXPECTED_CHECK_COUNT = 214; // v2-review.20 (18 insect deaths in the 30-day trajectory; v17–v19: 212)
const initial = fixture(), p = bundle(), sp = resolveSpecies(species(p));
const clone = structuredClone;
if (!(foragingTemperatureFactor(sp, 12) < foragingTemperatureFactor(sp, 20) && foragingTemperatureFactor(sp, 25) === 1)) throw Error('low temperature must suppress foraging');
const c = counter(), { ok, denied } = c;
const supportedTypes = new Set(['new_food_source', 'source_batch_consumed', 'food_delivered', 'insect_immigration', 'insect_natural_death', 'insect_population_birth', 'insect_background_death', 'physical_scout_visit', 'discovery', 'scouted_empty', 'nest_local_route_learning', 'local_contact_cue', 'local_brood_begging_contact', 'local_unloading_feedback', 'host_plant_death', 'hemipteran_colony_change', 'local_recruitment', 'route_step', 'route_timeout', 'trail_decay', 'trail_deposited', 'local_trail_choice', 'food_collected', 'trophallaxis', 'protein_cached_at_nest', 'live_prey_encounter', 'prey_escaped', 'local_alarm_signal', 'long_range_recruitment_trail', 'hunt_recruitment', 'joint_prey_transport', 'waiting_prey_joined', 'route_memory_initialized', 'worker_activity', 'forager_stopped', 'action_cancelled_no_time', 'no_route_cannot_depart', 'recruitment_no_nestmate', 'recruitment_failed', 'exploration_step', 'exploration_no_new_direction', 'exploration_found_nothing', 'insect_predation', 'hatch', 'pupation', 'eclosion', 'egg_laid', 'worker_death', 'brood_death', 'injury_recovery', 'queen_death']);
const anyState = (x: unknown) => x as any; // eslint-disable-line @typescript-eslint/no-explicit-any
const withOverride = anyState(clone(initial)); withOverride.force_food = { site: 'N00', sugar: 100 }; denied(() => simulateDay(withOverride, p));
const withDrama = anyState(clone(initial)); withDrama.make_sure_queen_survives = true; denied(() => simulateDay(withDrama, p));
const withForcedDeath = anyState(clone(initial)); withForcedDeath.target_worker_death = 'W007'; denied(() => simulateDay(withForcedDeath, p));
const injectEvents = anyState(clone(initial)); injectEvents.events = [{ type: 'meteor_revival' }]; denied(() => simulateDay(injectEvents, p));
denied(() => (simulateDay as any)(initial, p, { giveFood: true })); // eslint-disable-line @typescript-eslint/no-explicit-any
const sameButStarving = clone(initial); sameButStarving.colony.sugar = 0; sameButStarving.colony.protein = 0;
const x = simulateDay(initial, p), y = simulateDay(sameButStarving, p);
ok(JSON.stringify(x.summary.tasks) === JSON.stringify(y.summary.tasks), 'same prior feeding encounters and RNG must choose same tasks, even when hidden global stock is different');
for (const id of ['F01', 'F04', 'F05', 'F10']) ok(JSON.stringify(x.state.sources[id].ecological_record) === JSON.stringify(y.state.sources[id].ecological_record), 'hemipteran production independent of stored colony nutrients ' + id);

ok(JSON.stringify(initial) === JSON.stringify(fixture()), 'no state input mutation');
ok(JSON.stringify(x) === JSON.stringify(simulateDay(initial, p)), 'fixed-seed replay exact');
// A physically empty source population cannot produce a carcass from thin air.
const voidState = clone(initial); for (const loc of ['F07', 'F11']) { voidState.ecology.insects_by_site[loc].living = 0; voidState.sources[loc].batches = []; voidState.sources[loc].protein = 0; }
const noMigration = clone(p); setParam(noMigration, 'world', 'insects.insect_background_immigration_probability', 0); voidState.ecology.adjacent_garden_living_insects = 0;
const z = simulateDay(voidState, noMigration);
ok(z.events.every((e) => e.type !== 'new_food_source' && e.type !== 'insect_natural_death'), 'zero living insects and zero immigration => no new carcass');
// Orphan-brood regression: workers=0, queen=0 -> no warehouse consumption; larvae die within fixed assumption.
const orphan = clone(initial); orphan.population.workers = []; orphan.population.queen_alive = false; orphan.population.brood = orphan.population.brood.filter((b) => b.stage === 'larva'); orphan.colony.sugar = 8; orphan.colony.protein = 6;
let orphanState = orphan;
for (let day = 0; day < sp.brood_care.unattended_larva_max_days; day++) {
  const o = simulateDay(orphanState, p);
  ok(o.summary.consumed.sugar === 0 && o.summary.consumed.protein === 0, 'no workers cannot feed brood from warehouse'); // eslint-disable-line @typescript-eslint/no-explicit-any
  ok(o.state.colony.sugar === 8 && o.state.colony.protein === 6, 'untended stores cannot be consumed');
  orphanState = o.state;
}
ok(orphanState.population.brood.every((b) => b.stage !== 'larva'), 'orphan larvae die by bounded assumption');
let state = initial, insectDeaths = 0, carcasses = 0, workerDeaths = 0, scouts = 0;
for (let i = 0; i < 30; i++) {
  const before = state, out = simulateDay(state, p); const after = out.state;
  const sumInd = (type: string, pred: (e: any) => boolean = () => true) => out.events.filter((e: any) => e.type === type && pred(e)).reduce((n: number, e: any) => n + e.individuals, 0); // eslint-disable-line @typescript-eslint/no-explicit-any
  const immigrants = sumInd('insect_immigration');
  const neighborBirths = sumInd('insect_population_birth', (e) => e.site === 'adjacent_garden_habitat'); const neighborDeaths = sumInd('insect_background_death');
  ok(before.ecology.adjacent_garden_living_insects + neighborBirths - neighborDeaths - immigrants === after.ecology.adjacent_garden_living_insects, 'neighboring insects must conserve births, deaths and emigrants');
  ok(out.events.every((e) => supportedTypes.has(e.type)), 'no supernatural or unspecified event types Day' + out.day);
  for (const loc of ['F07', 'F11']) {
    const arrivals = sumInd('insect_immigration', (e) => e.site === loc);
    const deaths = out.events.filter((e) => (e.type === 'insect_natural_death' || e.type === 'insect_predation') && e.site === loc);
    const pre = before.ecology.insects_by_site[loc], post = after.ecology.insects_by_site[loc];
    const localBirths = sumInd('insect_population_birth', (e) => e.site === loc);
    ok(pre.living + localBirths + arrivals - deaths.length === post.living, 'local insect births/deaths/migration conservation ' + loc + ' Day' + out.day);
    for (const d of deaths) {
      const body = out.events.find((e) => e.type === 'new_food_source' && e.id === d.event_id && e.site === loc);
      ok(body && body.caused_by_event_id === d.event_id, 'each carcass has causal insect death ' + d.event_id);
      ok(after.sources[loc].batches.some((b) => b.event_id === d.event_id), 'each corpse in persistent source inventory ' + d.event_id);
    }
    insectDeaths += deaths.length;
  }
  const created = out.events.filter((e) => e.type === 'new_food_source');
  carcasses += created.length;
  ok(created.length === out.events.filter((e) => e.type === 'insect_natural_death' || e.type === 'insect_predation').length, 'no unconditional new food Day' + out.day);
  for (const d of out.events.filter((e) => e.type === 'worker_death')) ok(before.population.workers.some((w) => w.id === d.id), 'only previously alive ants can die');
  for (const v of out.events.filter((e) => e.type === 'physical_scout_visit')) { scouts++; ok(typeof v.via === 'string' && v.via.length > 0, 'a scout must physically traverse a known neighbor'); }
  workerDeaths += out.summary.worker_deaths;
  state = after;
}
// Isolated scout reachability proof: the targeted ant is NOT told where hidden food is.
// A high search rate is used only inside this QA fixture, never in the actual game.
// v2-review.14: exploration replaces the v2-review.12 scout visit. Worker 0 has walked N00–U01 (and knows that
// place); everyone else has walked nothing. An explorer can only step one edge beyond a place it knows.
const scoutFixture = clone(initial), searchSettings = clone(p);
for (const worker of scoutFixture.population.workers) { worker.known_sources = []; worker.age_days = 20; (worker as any).route_memory = { origin: 'qa', edges: {}, empty_sites: {} }; } // eslint-disable-line @typescript-eslint/no-explicit-any
scoutFixture.population.workers[0].known_sources = ['U01'];
(scoutFixture.population.workers[0] as any).route_memory.edges = { 'N00:U01': { acquired: 'walked', first_day: 14, last_day: 14 } }; // eslint-disable-line @typescript-eslint/no-explicit-any
setParam(searchSettings, MAIN_SPECIES, 'scouting.scout_discovery_probability', 1);
setParam(searchSettings, MAIN_SPECIES, 'task_allocation.forage_baseline_probability', 1000);
const forcedSearchTrial = simulateDay(scoutFixture, searchSettings);
const found = forcedSearchTrial.events.filter((e) => e.type === 'exploration_step');
const w0 = scoutFixture.population.workers[0].id, nestNeighbours = ['F01', 'F07', 'F08', 'F11', 'U00', 'U01'];
// v2-review.17: a worker may make several trips a day, so a place it walked to earlier the same day is known too.
// Invariant: every exploration step starts from the nest or a node THIS worker had walked to before departing.
const knownBefore = (e: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
  const seg = forcedSearchTrial.events.find((x: any) => x.type === 'worker_activity' && x.worker === e.worker && x.action === 'explore_depart' && x.end === e.minute) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const departed = seg ? seg.start : e.minute;
  return new Set(['N00', ...(e.worker === w0 ? ['U01'] : []), ...forcedSearchTrial.events.filter((x: any) => x.type === 'route_step' && x.worker === e.worker && x.minute <= departed).flatMap((x: any) => [x.from, x.to])]); // eslint-disable-line @typescript-eslint/no-explicit-any
};
ok(found.every((e) => knownBefore(e).has(e.from as string)) && found.filter((e) => e.from === 'N00').every((e) => nestNeighbours.includes(e.to as string)), 'exploration reaches ONLY places adjacent to a place the worker already knew (one edge beyond its own map)');
ok(found.filter((e) => e.to === 'F04' || e.to === 'F05').every((e) => knownBefore(e).has('F01') || knownBefore(e).has('F08')), 'remote F04/F05 only after the worker itself walked to a neighbouring place');
ok(found.length >= 1, 'explorers must actually traverse an edge under the high-search QA fixture');
ok(insectDeaths === carcasses, 'background food and prey originates from distinct tracked insect deaths');
const result = { passed: c.checks, expected_current: EXPECTED_CHECK_COUNT, legacy_v6_passed: LEGACY_CHECK_COUNT, days: 30, events_natural_only: true, seeded_replay: true, no_direct_interventions: true, insectDeaths, carcasses, workerDeaths, physicalScoutingEvents: scouts, canonical_save_changed: false };
console.log(JSON.stringify(result, null, 2));
if (c.checks !== EXPECTED_CHECK_COUNT) { console.error(`naturalism check count ${c.checks} != expected ${EXPECTED_CHECK_COUNT} (v6: ${LEGACY_CHECK_COUNT})`); process.exit(1); }
