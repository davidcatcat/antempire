/**
 * ME-1 (Issue #66; v2-review.24): population flow, lifetimes, event time, numeric and parameter domains, RNG inputs.
 * Engine checks (engine/invariants.ts) and the independent reader (cli/lib/population-replay.ts) must both
 *  - accept every real engine colony-day (Day0 scenarios A1–A5 × two seasons, the Day14 fixture with two seeds), and
 *  - reject every counterexample below (each invariant has at least one that breaks only it).
 * The old engine checked the population only by counts (engine/day.ts: workers + deaths = before + eclosions); an
 * ID swap keeps every count and passed it — shown below, then rejected by the new checks.
 * Engineering/mathematical correctness only; none of this is a scientific validation.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta, type WorldState } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { checkPopulationDay, populationSnapshot, checkColonyDomain, checkEventDomain, checkParamDomain, checkRngInputs } from '../engine/invariants.ts';
import { replayPopulationDay, domainErrors, paramDomainErrors } from '../cli/lib/population-replay.ts';
import { sourceLedgerDay } from '../cli/lib/source-ledger.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle(), rp = resolveBundle(b), sp: Any = rp.species[MAIN_SPECIES], cap = sp.trophallaxis.crop_capacity;
const throws = (f: () => void, re: RegExp) => { try { f(); return false; } catch (e) { return re.test(String(e)); } };

// ---------------------------------------------------------------- real days: both sides accept
interface Day { before: Any; after: Any; events: Any[] }
const days: Day[] = [];
let colonyDays = 0, worldDays = 0, flows = { deaths: 0, eclosions: 0, laid: 0, brood_deaths: 0 }, deleted = { overflow: 0, expired: 0 };
const ledgerDays: { start: Any; end: Any; result: Any }[] = [];
const run = (s: WorldState, n: number) => {
  for (let d = 0; d < n; d++) {
    const befores = s.colonies.map((c) => structuredClone(c)), o: Any = simulateWorldDay(s, b);
    const sl = sourceLedgerDay(s, o.state, o.result, rp.world);
    assert.ok(sl.ok, `real day ${o.day}: source ledger does not close (${sl.errors.slice(0, 2).join(' | ')})`);
    worldDays++; deleted.overflow += sl.deleted_without_event.overflow; deleted.expired += sl.deleted_without_event.expired;
    if (ledgerDays.length < 40 && (sl.deleted_without_event.overflow > 0 || sl.deleted_without_event.expired > 0 || o.result.colonies.some((c: Any) => c.events.some((e: Any) => e.type === 'food_transfer' && e.source?.kind === 'source')))) ledgerDays.push({ start: structuredClone(s), end: o.state, result: o.result });
    for (const [i, r] of o.result.colonies.entries()) {
      const after = o.state.colonies.find((c: Any) => c.id === r.colony_id), rep = replayPopulationDay(befores[i], after, r.events), dom = domainErrors(after, r.events, cap);
      assert.ok(rep.ok, `real day ${o.day} ${r.colony_id}: reader rejects (${rep.errors.slice(0, 2).join(' | ')})`);
      assert.ok(dom.length === 0, `real day ${o.day} ${r.colony_id}: domain (${dom.slice(0, 2).join(' | ')})`);
      colonyDays++; flows.deaths += rep.flow.workers.deaths; flows.eclosions += rep.flow.workers.eclosions; flows.laid += rep.flow.brood.laid; flows.brood_deaths += rep.flow.brood.deaths;
      if (days.length < 300 && r.events.some((e: Any) => ['eclosion', 'worker_death', 'egg_laid', 'brood_death'].includes(e.type))) days.push({ before: befores[i], after, events: r.events });
    }
    s = o.state;
    if (s.colonies.every((c) => !c.population.queen_alive && !c.population.workers.length)) break;
  }
};
for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const season of ['2027-03-21', '2027-09-23']) run(buildDay0(sc as Any, 1, season, b).state, 60);
const meta = legacyColonyMeta(b.world.scenario_colonies as Any);
for (const seed of [15032026, 15032027]) { const lg: Any = fixture(); lg.seed = seed; run(legacyToWorldState(lg, meta), 60); }
ok(colonyDays > 600 && flows.deaths > 0 && flows.eclosions > 0 && flows.laid > 0, `real days: ${colonyDays} colony-days accepted by the engine (it would throw) and the reader; flows seen: ${JSON.stringify(flows)}`);
ok(worldDays > 100, `source ledger: ${worldDays} world-days close (start + production + remains + kills − washoff − decay − deletions − collected = end)`);
ok(deleted.overflow > 0 && deleted.expired > 0, `source ledger: food deleted WITHOUT an event is now visible — capacity overflow ${deleted.overflow.toFixed(3)} and expired carcass protein ${deleted.expired.toFixed(3)} game portions (architecture §9 item 1; old code, not fixed here)`);
ok(paramDomainErrors('species', sp).length === 0 && paramDomainErrors('world', rp.world).length === 0, `the shipped parameters are in their declared domains (${[...paramDomainErrors('species', sp), ...paramDomainErrors('world', rp.world)].slice(0, 2)})`);

// ---------------------------------------------------------------- counterexamples: population flow and lifetimes
const pick = (pred: (d: Day) => boolean) => { const d = days.find(pred); assert.ok(d, 'no sample day for a counterexample'); return structuredClone(d!) as Day; };
const both = (name: string, d: Day, mutate: (d: Day) => void) => {
  mutate(d);
  const eng = throws(() => checkPopulationDay(populationSnapshot(d.before), d.after, d.events), /POPULATION/), rep = replayPopulationDay(d.before, d.after, d.events);
  ok(eng, `POP ${name}: the engine rejects`); ok(!rep.ok, `POP ${name}: the reader rejects (${rep.errors[0] ?? 'ACCEPTED'})`);
};
const withWorkers = (d: Day) => d.before.population.workers.length > 1 && d.after.population.workers.length > 1;
const surviving = (d: Day) => d.after.population.workers.find((w: Any) => d.before.population.workers.some((x: Any) => x.id === w.id));
both('a worker vanishes without a death event', pick(withWorkers), (d) => { d.after.population.workers.splice(d.after.population.workers.indexOf(surviving(d)), 1); });
both('a worker appears without an eclosion event', pick(withWorkers), (d) => { d.after.population.workers.push({ ...structuredClone(surviving(d)), id: 'W9999' }); });
both('a worker death recorded twice', pick((d) => d.events.some((e) => e.type === 'worker_death')), (d) => { const e = d.events.find((x) => x.type === 'worker_death'); d.events.push(structuredClone(e)); });
both('a death of a worker that did not exist', pick(withWorkers), (d) => { d.events.push({ type: 'worker_death', id: 'W8888' }); });
both('an eclosion that reuses a living worker ID', pick((d) => d.events.some((e) => e.type === 'eclosion')), (d) => { const e = d.events.find((x) => x.type === 'eclosion'); e.new_worker_id = d.before.population.workers[0].id; });
both('an egg with an already used number', pick((d) => d.events.some((e) => e.type === 'egg_laid')), (d) => { const e = d.events.find((x) => x.type === 'egg_laid'), egg = d.after.population.brood.find((x: Any) => x.id === e.id), old = `${d.after.egg_id_prefix}${String(0).padStart(d.after.id_number_width, '0')}`; e.id = old; if (egg) egg.id = old; });
both('an ID counter goes backwards', pick(withWorkers), (d) => { d.after.next_worker_number = d.before.next_worker_number - 1; });
both('queen alive after her death event', pick((d) => d.before.population.queen_alive), (d) => { d.events.push({ type: 'queen_death', id: d.after.queen_id }); });
both('queen dead without a death event', pick((d) => d.before.population.queen_alive && d.after.population.queen_alive), (d) => { d.after.population.queen_alive = false; });
const wasNotEgg = (d: Day) => (x: Any) => d.before.population.brood.some((y: Any) => y.id === x.id && y.stage !== 'egg');
both('a brood stage goes backwards', pick((d) => d.after.population.brood.some(wasNotEgg(d))), (d) => { d.after.population.brood.find(wasNotEgg(d)).stage = 'egg'; });
both('a surviving worker ages two days', pick(withWorkers), (d) => { surviving(d).age_days += 1; });
// causal order within the day (ID-EVENT-TIME): every set and count is right, only the order is impossible
both('a new worker dies before it ecloses', pick((d) => d.events.some((e) => e.type === 'eclosion')), (d) => { const i = d.events.findIndex((x) => x.type === 'eclosion'); d.events.splice(i, 0, { type: 'worker_death', id: d.events[i].new_worker_id }); d.after.population.workers = d.after.population.workers.filter((w: Any) => w.id !== d.events[i + 1].new_worker_id); });
both('an egg is laid after the queen died', pick((d) => d.events.some((e) => e.type === 'egg_laid') && d.before.population.queen_alive), (d) => { d.events.splice(d.events.findIndex((x) => x.type === 'egg_laid'), 0, { type: 'queen_death', id: d.after.queen_id }); d.after.population.queen_alive = false; });
both('brood vanishes without an event', pick((d) => d.after.population.brood.length > 0), (d) => { d.after.population.brood.pop(); });
// the gap the old count identity left: an ID swap keeps every count
{
  const d = pick(withWorkers), w = surviving(d);
  w.id = 'W7777';
  const counts = d.after.population.workers.length + d.events.filter((e) => e.type === 'worker_death').length === d.before.population.workers.length + d.events.filter((e) => e.type === 'eclosion').length;
  ok(counts, 'POP ID swap: the old count identity (engine/day.ts) still holds — it could not see this');
  ok(throws(() => checkPopulationDay(populationSnapshot(d.before), d.after, d.events), /POPULATION/) && !replayPopulationDay(d.before, d.after, d.events).ok, 'POP ID swap: rejected by the new engine check and the reader');
}

// ---------------------------------------------------------------- counterexamples: world-side source ledger (reader only)
const ledger = (name: string, pick: (d: Any) => boolean, mutate: (d: Any) => void) => {
  const d0 = ledgerDays.find(pick); assert.ok(d0, `no sample day for ${name}`);
  const d = structuredClone(d0); mutate(d);
  const l = sourceLedgerDay(d.start, d.end, d.result, rp.world);
  ok(!l.ok, `SOURCES ${name}: the reader rejects (${l.errors[0] ?? 'ACCEPTED'})`);
};
const sugarSite = (d: Any) => Object.values(d.end.sources).find((x: Any) => x.type !== 'carcass') as Any;
const carcassSite = (d: Any) => Object.values(d.end.sources).find((x: Any) => x.type === 'carcass' && x.batches.some((y: Any) => y.protein > 0)) as Any;
ledger('sugar appears at a source without production or event', (d) => !!sugarSite(d), (d) => { sugarSite(d).sugar += 0.5; });
ledger('sugar vanishes from a source without collection', (d) => !!sugarSite(d) && sugarSite(d).sugar > 0.5, (d) => { sugarSite(d).sugar -= 0.5; });
ledger('the ecological record does not start from the stock the source held', (d) => !!sugarSite(d), (d) => { sugarSite(d).ecological_record.stock_before += 1; });
ledger('growth above capacity', (d) => !!sugarSite(d), (d) => { const x = sugarSite(d); x.ecological_record.stock_after = x.capacity + 1; x.sugar = x.capacity + 1; });
ledger('carcass protein appears without remains or a kill', (d) => !!carcassSite(d), (d) => { const x = carcassSite(d); x.batches.find((y: Any) => y.protein > 0).protein += 0.5; x.protein += 0.5; });
ledger('a collection recorded but the source keeps its food', (d) => d.result.colonies.some((c: Any) => c.events.some((e: Any) => e.type === 'food_transfer' && e.source?.kind === 'source')), (d) => { for (const c of d.result.colonies) { const e = c.events.find((x: Any) => x.type === 'food_transfer' && x.source?.kind === 'source'); if (e) { e.portions += 1; break; } } });
ledger('a source that disappears', () => true, (d) => { delete d.end.sources[Object.keys(d.end.sources)[0]]; });
ledger('a negative rainfall', () => true, (d) => { d.result.weather.rain_mm = -1; });

// ---------------------------------------------------------------- counterexamples: state and event domains
const domain = (name: string, mutate: (c: Any, ev: Any[]) => void, evOnly = false) => {
  const d = structuredClone(days[0]); mutate(d.after, d.events);
  const eng = evOnly ? throws(() => checkEventDomain(d.after.id, d.events), /EVENT_DOMAIN/) : throws(() => checkColonyDomain(d.after, cap), /DOMAIN/);
  ok(eng, `DOMAIN ${name}: the engine rejects`); ok(domainErrors(d.after, d.events, cap).length > 0, `DOMAIN ${name}: the reader rejects`);
};
domain('a NaN store', (c) => { c.stores.sugar = NaN; });
domain('a negative protein store', (c) => { c.stores.protein = -0.1; });
domain('a crop above its capacity', (c) => { c.population.workers[0].crop_cargo_sugar = cap + 0.1; });
domain('a fractional age', (c) => { c.population.workers[0].age_days = 1.5; });
domain('an infinite brood progress', (c) => { if (!c.population.brood.length) c.population.brood.push({ id: 'E9999', stage: 'egg', progress: 0, age_days: 0 }); c.population.brood[0].progress = Infinity; });
domain('a negative trail', (c) => { c.trail_by_edge['X:Y'] = -1; });
domain('half a gap day', (c) => { c.stores.sugar_gap_days = 0.5; });
domain('an event probability of 1.5', (_c, ev) => { ev.push({ type: 'worker_death', id: 'x', probability: 1.5 }); }, true);
domain('negative portions in an event', (_c, ev) => { ev.push({ type: 'food_collected', portions: -0.1 }); }, true);
domain('an event at minute 1500', (_c, ev) => { ev.push({ type: 'trail_deposited', minute: 1500 }); }, true);
domain('a NaN inside an event', (_c, ev) => { ev.push({ type: 'x', detail: { a: NaN } }); }, true);

// ---------------------------------------------------------------- counterexamples: parameter domain (units by name)
const param = (name: string, mutate: (p: Any) => void, expectReject = true) => {
  const p = structuredClone(sp); mutate(p);
  const eng = throws(() => checkParamDomain('species', p), /PARAMS/), rd = paramDomainErrors('species', p).length > 0;
  ok(eng === expectReject && rd === expectReject, `PARAMS ${name}: engine ${eng ? 'rejects' : 'accepts'}, reader ${rd ? 'rejects' : 'accepts'} (expected ${expectReject ? 'reject' : 'accept'})`);
};
param('a probability of 1.2', (p) => { p.recruitment.recruitment_probability = 1.2; });
param('a negative number of days', (p) => { p.development.egg_days = -1; });
param('2000 minutes', (p) => { p.foraging_activity.daily_window_minutes = 2000; });
param('a minimum above its maximum', (p) => { p.food_handling.crop_load_sugar_min = p.food_handling.crop_load_sugar_max + 0.1; });
param('Q10 of 0', (p) => { p.metabolism.q10 = 0; });
param('a NaN parameter', (p) => { p.nutrition.worker_sugar_daily = NaN; });
param('a hazard cap of 1.1', (p) => { p.starvation.worker_starvation_hazard_cap = 1.1; });
param('a negative task weight', (p) => { p.task_allocation.forage_baseline_probability = -1; });
param('a task weight of 1000 (legal: relative weight, misnamed "probability")', (p) => { p.task_allocation.forage_baseline_probability = 1000; }, false);
{
  const w = structuredClone(rp.world) as Any; w.climate.rainfall_gamma_shape = 0.5;
  ok(throws(() => checkParamDomain('world', w), /PARAMS/) && paramDomainErrors('world', w).length > 0, 'PARAMS a rainfall Gamma shape of 0.5 (sampler needs ≥ 1): both reject');
}

// ---------------------------------------------------------------- RNG inputs and replay
{
  const s0 = buildDay0('A1' as Any, 1, '2027-09-23', b).state;
  ok(throws(() => checkRngInputs({ ...s0, seed: 1.5 } as Any), /RNG/) && throws(() => checkRngInputs({ ...s0, sim_day: -1 } as Any), /RNG/), 'RNG: a fractional seed or a negative day is rejected');
  ok(throws(() => simulateWorldDay({ ...structuredClone(s0), seed: 1.5 } as Any, b), /RNG/), 'RNG: the engine refuses to run a day with a fractional seed');
  const a = JSON.stringify(simulateWorldDay(structuredClone(s0), b)), z = JSON.stringify(simulateWorldDay(structuredClone(s0), b));
  ok(a === z, 'RNG: the same input gives a byte-identical day (replay)');
  ok(JSON.stringify(simulateWorldDay({ ...structuredClone(s0), seed: s0.seed + 1 }, b).result) !== JSON.stringify(simulateWorldDay(structuredClone(s0), b).result), 'RNG: another seed gives another day (the seed is used)');
}

console.log(JSON.stringify({ me1_invariants: 'pass', checks, colony_days: colonyDays, world_days: worldDays, flows, source_food_deleted_without_event: { overflow: +deleted.overflow.toFixed(6), expired: +deleted.expired.toFixed(6) }, note: 'engineering/mathematical checks only, not scientific validation; array-order invariance is Issue #56 (known violated, not asserted here)' }, null, 2));
