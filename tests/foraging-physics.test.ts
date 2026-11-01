/** Port of sim/test_foraging_physics.cjs (v6: 2149 checks). Model-structure regressions; no save edits. */
import assert from 'node:assert/strict';
import { simulateDay, routeTo, travel, goHome, decayTrails, depositTrail, fullTrail, handoff, settleCrops, prey, legacyView, legacyColonyMeta, resolveBundle, type Worker, type LegacyV2State } from '../engine/index.ts';
import { bundle, counter, fixture, MAIN_SPECIES } from './lib/harness.ts';

const LEGACY_CHECK_COUNT = 2149;
const p = bundle(), rp = resolveBundle(p), sp = rp.species[MAIN_SPECIES], wp = rp.world, initial = fixture();
const meta = legacyColonyMeta(wp.scenario_colonies), nest = meta.nest_node;
const view = (s: LegacyV2State) => legacyView(s, meta, (s.ecology.trail_by_edge ??= {}));
const c = counter(), { ok } = c;
const make = () => structuredClone(initial);
const w = (id: string, site?: string): Worker => ({ id, last_location: site || nest, known_sources: [], crop_cargo_sugar: 0, age_days: 0, injured: false, task: 'rest' });
const r = (site: string) => routeTo(wp, nest, site) as string[];
ok(r('F04').join('>') === 'N00>F01>F04', 'physical route needs intermediary');
ok(r('F10').join('>') === 'N00>U01>F10', 'route requires U01');
const state = make(), worker = w('W200'), peer = w('W201');
state.population.workers = [worker, peer];
const world = view(state), colony = world.colonies[0];
ok(!fullTrail(colony, sp, r('F04')), 'no initial pheromone from empty world');
const log: any[] = []; depositTrail(colony, sp, ['N00', 'F01', 'F04'], worker, log); // eslint-disable-line @typescript-eslint/no-explicit-any
ok(fullTrail(colony, sp, r('F04')), 'a successful route makes local edges available');
ok(log.filter((e) => e.type === 'trail_deposited').length === 2, 'two physical edge deposits');
for (let i = 0; i < 10; i++) decayTrails(colony, sp, log);
ok(!fullTrail(colony, sp, r('F04')), 'unreinforced pheromone dissipates');
const t = travel(sp, wp, worker, r('F04'), log, 'test');
ok(t && worker.last_location === 'F04' && t.arrive > 0, 'outbound requires simulated travel');
const rejected = travel(sp, wp, worker, r('F04'), log, 'timeout', 1e9);
ok(rejected === null, 'unreachable schedule cannot teleport');
goHome(wp, worker, r('F04'), log, 'return', (t as { arrive: number }).arrive);
ok(worker.last_location === 'N00', 'return completes physical journey');
const handoffLog: any[] = [], massBefore = state.colony.sugar; const transfer = handoff(colony, sp, worker, 'sugar', 0.5, handoffLog, () => 0, 'F01'); // eslint-disable-line @typescript-eslint/no-explicit-any
ok(transfer.count >= 1 && handoffLog.some((e) => e.type === 'trophallaxis'), 'must actually exchange between co-located nestmates');
ok(Math.abs(state.colony.sugar - massBefore - 0.5) < 0.00001, 'no extra trophallaxis mass credited');
ok(Math.abs((worker.crop_cargo_sugar as number) + (peer.crop_cargo_sugar as number) - 0.5) < 0.00001, 'individual cargo is a subset of same transported mass');
settleCrops(colony, 0.5);
ok((worker.crop_cargo_sugar as number) + (peer.crop_cargo_sugar as number) === 0, 'feeding removes held cargo bookkeeping');
const noPeer = make(), noPeerWorld = view(noPeer), solo = w('SOLO', 'F07'), localSite = noPeer.sources.F07, ev: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
noPeer.ecology.insects_by_site.F07.living = 0; const before = localSite.protein;
ok(!prey(noPeerWorld, sp, wp, localSite, solo, [solo], () => 0, ev), 'no prey can be captured with zero living insects');
ok(localSite.protein === before, 'no phantom food from empty habitat');
noPeer.ecology.insects_by_site.F07.living = 2; const seq = (a: number[]) => { let i = 0; return () => a[Math.min(i++, a.length - 1)]; };
const largeSolo = prey(noPeerWorld, sp, wp, localSite, solo, [solo], seq([0, 0, 0]), ev);
ok(largeSolo === false && noPeer.ecology.insects_by_site.F07.living === 2, 'large prey escapes if lone worker');
const remote = w('REMOTE', 'N00');
ok(!prey(noPeerWorld, sp, wp, localSite, solo, [solo, remote], seq([0, 0, 0]), ev), 'remote nest ant cannot count as physically present');
const mate = w('MATE', 'F07');
ok(prey(noPeerWorld, sp, wp, localSite, solo, [solo, mate], seq([0, 0, 0]), ev), 'physically co-located team can capture large prey');
ok(noPeer.ecology.insects_by_site.F07.living === 1, 'one actual living insect removed');
const pred = ev.find((e) => e.type === 'insect_predation'), food = ev.find((e) => e.type === 'new_food_source');
ok(pred && food && pred.event_id === food.caused_by_event_id, 'predation directly causes food batch with recorded ID');
const independent = make(); independent.colony.sugar = 0; independent.colony.protein = 0;
ok(JSON.stringify(simulateDay(initial, p).state.ecology.insects_by_site) === JSON.stringify(simulateDay(independent, p).state.ecology.insects_by_site), 'same environmental births independent of ant stores');
let sim = make(), delivered = 0, pheromone = 0, trophallaxis = 0, hunts = 0, allEvents = 0;
for (let day = 0; day < 60; day++) {
  const out = simulateDay(sim, p), events = out.events;
  assert.deepEqual(out, simulateDay(sim, p), 'deterministic rerun Day ' + out.day);
  const ratios = out.summary.ratios;
  ok(Number.isFinite(ratios.sugar) && Number.isFinite(ratios.protein), 'nutrition diagnostic ratios numeric and finite');
  for (const receipt of events.filter((e) => e.type === 'food_delivered')) {
    ok(events.some((c) => c.type === 'food_collected' && c.worker === receipt.worker && c.site === receipt.site && c.macro === receipt.macro && c.portions === receipt.portions), 'each delivery backed by collection');
    ok(events.some((t) => t.type === 'route_step' && t.worker === receipt.worker && t.to === 'N00'), 'each delivery backed by actual nest return');
  }
  for (const e of events.filter((e) => e.type === 'trophallaxis')) { ok(e.location === 'N00' && (e.portions as number) > 0, 'trophallaxis at nest positive only'); }
  for (const e of events.filter((e) => e.type === 'insect_predation')) { ok(events.some((n) => n.type === 'new_food_source' && n.caused_by_event_id === e.event_id), 'prey mass has tracked source'); }
  delivered += events.filter((e) => e.type === 'food_delivered').length; pheromone += events.filter((e) => e.type === 'trail_deposited').length; trophallaxis += events.filter((e) => e.type === 'trophallaxis').length; hunts += events.filter((e) => e.type === 'insect_predation').length; allEvents += events.length;
  ok(out.state.population.workers.every((a) => a.last_location === 'N00'), 'all completed same-day trips returned; no ant teleported outside');
  ok(out.state.population.workers.reduce((a, w) => a + (w.crop_cargo_sugar || 0), 0) <= out.state.colony.sugar + 1e-4, 'worker crop remains included in ledger only once');
  for (const w of out.state.population.workers) ok((w.crop_cargo_sugar || 0) <= sp.trophallaxis.crop_capacity + 1e-4, 'crop capacity enforced');
  sim = out.state;
}
ok(delivered > 0 && pheromone > 0 && trophallaxis > 0, 'multi-day history exhibits routes, trails and real handoffs');
console.log(JSON.stringify({ checks: c.checks, legacy_v6_checks: LEGACY_CHECK_COUNT, days: 60, delivered, pheromone_deposits: pheromone, trophallaxis_contacts: trophallaxis, live_hunts: hunts, events: allEvents, source_provenance: 'tracked', official_save_advanced: false }, null, 2));
if (c.checks !== LEGACY_CHECK_COUNT) { console.error(`check count ${c.checks} != v6 ${LEGACY_CHECK_COUNT}`); process.exit(1); }
