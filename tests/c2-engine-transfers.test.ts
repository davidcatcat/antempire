/**
 * Work package C2 (v2-review.22): the engine records every movement of food between compartments as a food_transfer
 * event and checks per-compartment closure every day (engine/transfers.ts). These tests check those records with an
 * INDEPENDENT reader (cli/lib/engine-transfers.ts) and try to break them.
 *  E  real engine, every founding × season × 2 seeds × 60 days (and the Day14 projection): the cli replay of the
 *     engine's own transfers reproduces every compartment exactly; ids unique; trophallaxis causality; phase order;
 *     the C1 reconstruction from ordinary events agrees with the engine's foraging-phase transfers; the days on
 *     which C1 could not check trophallaxis (settlement emptied crops) are fully checked here.
 *  M  two colonies sharing the world's sources: each colony-day replays; transfer ids carry the colony.
 *  F  fault injection on real days: wrong recipient, missing / duplicated transfer, amount off by 1 µp, wrong crop in
 *     a settlement draw, missing death transfer, wrong attribution, trophallaxis outside its unloading; both the cli
 *     reader and the engine's own check (checkColonyFood) must reject; the engine's world-wide source check
 *     (checkSources) must reject a collection credited to the wrong site.
 *  R  Issue #61 R3-08: transfers through compartments that do not exist (Appendix A and variants) are rejected by the
 *     engine's colony check, its world source check and the reader.
 *  T  replay determinism: the same input gives a byte-identical transfer sequence.
 * The diagnostics-only claim (removing the transfers gives v2-review.21 byte for byte) is proven in
 * tests/rules-isolation.test.ts (normaliser food_transfer_events_v22).
 * Engineering checks only: this is NOT a scientific validation, and F01/A08 remain (metabolism, eggs, overflow are
 * still taken from the colony ledger: attribution 'unknown').
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { ENGINE_VERSION, simulateWorldDay, checkColonyFood, colonySnapshot, checkSources, sourceSnapshot, legacyToWorldState, legacyColonyMeta, type WorldState, type ParamBundle } from '../engine/index.ts';
import { engineTransfers, replayEngineColonyDay, replayEngineSourcesDay, speciesFoodTiming } from '../cli/lib/engine-transfers.ts';
import { dayTransfers, replayColonyDay, toMicro } from '../cli/lib/compartments.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';
import { bindFoodTransfers, foodTransfer } from '../engine/transfers.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle();
const ONLY = process.env.C2_ONLY;

// ---------------------------------------------------------------- E: real engine, every colony-day replayed
const stats = { source_days: 0, timed_days: 0, colony_days: 0, transfers: 0, by_cause: {} as Record<string, number>, unattributed: { sugar: 0, protein: 0 }, c1_evidence_limited_days_fully_checked: 0, c1_agree_days: 0 };
const ids = new Set<string>();
const sig = (x: Any, amount: number) => `${x.cause}|${x.source.kind}:${x.source.id}|${x.recipient.kind}:${x.recipient.id}|${x.food_type}|${amount}`;
const samples: { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> }[] = [];
const sourceIds = (w: Any) => new Set<string>(Object.keys(w.sources));
function runWorld(s: WorldState, n: number, label: string, collect = true): string[] {
  const seqs: string[] = [];
  ids.clear(); // transfer ids are unique within one world (FT-<day>-<colony>-<n>)
  for (let d = 0; d < n; d++) {
    const befores = s.colonies.map((c) => structuredClone(c)), o: Any = simulateWorldDay(s, b);
    if (collect) { const se = replayEngineSourcesDay(o.state.sources, o.result.colonies.map((r: Any) => ({ id: r.colony_id, events: r.events, timing: speciesFoodTiming(b.species[MAIN_SPECIES]) }))); assert.deepEqual(se, [], `E ${label} day ${o.day}: the reader's source time replay rejects a real day: ${se.slice(0, 2).join(' | ')}`); checks++; stats.source_days++; }
    for (const [i, r] of o.result.colonies.entries()) {
      const before = befores[i], after = o.state.colonies.find((c: Any) => c.id === r.colony_id);
      const rep = replayEngineColonyDay(before, after, r.events, o.day, sourceIds(s));
      seqs.push(JSON.stringify(engineTransfers(r.events)));
      if (!collect) continue;
      assert.ok(rep.ok, `E ${label} day ${o.day} ${r.colony_id}: ${rep.errors.slice(0, 3).join(' | ')}`); checks++;
      // Codex F1: every real colony-day with foraging is timed and passes the time-causality check (no legacy untimed day here)
      assert.ok(rep.time_validation === 'timed' || rep.time_validation === 'no_foraging', `E ${label} day ${o.day}: time validation ${rep.time_validation}`);
      if (rep.time_validation === 'timed') stats.timed_days++;
      stats.colony_days++; stats.transfers += rep.transfers;
      for (const [c, k] of Object.entries(rep.by_cause)) stats.by_cause[c] = (stats.by_cause[c] ?? 0) + k;
      for (const v of Object.values(rep.unattributed_by_cause)) { stats.unattributed.sugar += v.sugar; stats.unattributed.protein += v.protein; }
      for (const x of engineTransfers(r.events)) { assert.ok(!ids.has(x.transfer_id), `transfer id ${x.transfer_id} reused`); ids.add(x.transfer_id); }
      // C1 (reconstruction from ordinary events) vs C2 (engine records): the foraging-phase physical transfers agree
      const c1 = dayTransfers(r.events, r.summary, after, o.day).transfers.filter((x) => x.phase === 'foraging').map((x) => sig(x, x.amount_microportions)).sort();
      const c2 = engineTransfers(r.events).filter((x) => x.phase === 'foraging' && x.cause !== 'prey_kill').map((x) => sig(x, toMicro(x.portions))).sort();
      assert.deepEqual(c2, c1, `E ${label} day ${o.day}: engine foraging transfers differ from the C1 reconstruction`); checks++; stats.c1_agree_days++;
      const c1rep = replayColonyDay(before, after, r.events, r.summary, o.day, true);
      if (c1rep.evidence_limited_compartments.length) stats.c1_evidence_limited_days_fully_checked++;
      if (samples.length < 400 && engineTransfers(r.events).some((x) => x.cause === 'trophallaxis')) samples.push({ before, after, events: r.events, day: o.day, sources: sourceIds(s) });
    }
    s = o.state;
    if (s.colonies.every((c) => !c.population.queen_alive && !c.population.workers.length)) break;
  }
  return seqs;
}
if (!ONLY || ONLY.includes('E')) {
  for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const season of ['2027-03-21', '2027-06-21', '2027-09-23', '2027-12-22']) for (const seed of [1, 2]) runWorld(buildDay0(sc as Any, seed, season, b).state, 60, `${sc}/${season}/${seed}`);
  const meta = legacyColonyMeta(b.world.scenario_colonies as Any);
  for (const seed of [15032026, 15032027]) { const lg: Any = fixture(); lg.seed = seed; runWorld(legacyToWorldState(lg, meta), 60, `day14/${seed}`); }
  ok(stats.colony_days > 2000 && (stats.by_cause.trophallaxis ?? 0) > 1000 && (stats.by_cause.metabolism ?? 0) > 1000, `E (${ENGINE_VERSION}): ${stats.colony_days} colony-days replayed exactly from the engine's own records (${stats.transfers} transfers)`);
  ok(stats.c1_evidence_limited_days_fully_checked > 100, `E: ${stats.c1_evidence_limited_days_fully_checked} colony-days that C1 could not fully check (settlement emptied crops) are fully checked from the engine's records`);
}

// ---------------------------------------------------------------- M: two colonies, shared sources
if (!ONLY || ONLY.includes('M')) {
  const meta = legacyColonyMeta(b.world.scenario_colonies as Any), base = legacyToWorldState(fixture(), meta), OTHER = 'structural-test-species-b';
  const two: ParamBundle = structuredClone(b); two.species[OTHER] = { ...structuredClone(b.species[MAIN_SPECIES]), species_id: OTHER };
  const second: Any = structuredClone(base.colonies[0]);
  Object.assign(second, { id: 'B', species_id: OTHER, nest_node: 'U00', queen_id: 'B-Q001', rng_namespace: 'B|', worker_id_prefix: 'B-W', egg_id_prefix: 'B-E', next_worker_number: 1, next_egg_number: 1, trail_by_edge: {} });
  second.population.workers = second.population.workers.slice(0, 5).map((w: Any, i: number) => ({ ...w, id: `B-W9${i}`, known_sources: [], last_location: 'U00', site_memory: {} }));
  second.population.brood = []; second.source_knowledge = Object.fromEntries(Object.keys(base.sources).map((id) => [id, { presence: 'potential', known_by: [] }])); delete second.last_report;
  let s: WorldState = { ...structuredClone(base), colonies: [structuredClone(base.colonies[0]), second] }, days = 0;
  for (let d = 0; d < 40; d++) {
    const befores = s.colonies.map((c) => structuredClone(c)), o: Any = simulateWorldDay(s, two);
    { const se = replayEngineSourcesDay(o.state.sources, o.result.colonies.map((r: Any) => ({ id: r.colony_id, events: r.events, timing: 'timed' as const }))); assert.deepEqual(se, [], `M day ${o.day}: the reader's source time replay rejects a real two-colony day: ${se.slice(0, 2).join(' | ')}`); checks++; }
    for (const [i, r] of o.result.colonies.entries()) {
      const rep = replayEngineColonyDay(befores[i], o.state.colonies[i], r.events, o.day, sourceIds(s));
      assert.ok(rep.ok, `M day ${o.day} ${r.colony_id}: ${rep.errors.slice(0, 3).join(' | ')}`); checks++;
      assert.ok(engineTransfers(r.events).every((x) => x.transfer_id.startsWith(`FT-${o.day}-${r.colony_id}-`) && x.colony === r.colony_id), 'M: transfer ids carry their colony'); checks++;
    }
    days++; s = o.state;
  }
  ok(days === 40, 'M: two colonies sharing sources, 40 days, every colony-day replays and the engine source check passed every day');
}

// ---------------------------------------------------------------- F: fault injection
if (!ONLY || ONLY.includes('F')) {
  if (!samples.length) runWorld(buildDay0('A1' as Any, 1, '2027-09-23', b).state, 60, 'F-samples');
  const engineRejects = (s: { before: Any; after: Any; events: Any[] }) => { try { checkColonyFood(colonySnapshot(s.before), s.after, s.events); return false; } catch (e) { return /FOOD_TRANSFER/.test(String(e)); } };
  const both = (name: string, s: { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> }, cliOnly = false) => {
    const rep = replayEngineColonyDay(s.before, s.after, s.events, s.day, s.sources);
    ok(!rep.ok, `F ${name}: the cli reader rejects (${rep.errors[0]})`);
    if (!cliOnly) ok(engineRejects(s), `F ${name}: the engine's own check rejects`);
  };
  const mutate = (s: (typeof samples)[number], f: (xs: Any[], events: Any[]) => boolean) => { const events = structuredClone(s.events); const xs = events.filter((e: Any) => e.type === 'food_transfer'); return f(xs, events) ? { ...s, events } : null; };
  const pick = (f: (xs: Any[], events: Any[]) => boolean) => { for (const s of samples) { const m = mutate(s, f); if (m) return m; } return null; };
  // the unmodified samples pass both
  ok(samples.every((s) => replayEngineColonyDay(s.before, s.after, s.events, s.day, s.sources).ok && !engineRejects(s)), `F: ${samples.length} unmodified sample days pass both checks`);
  const injections: [string, (xs: Any[], events: Any[]) => boolean, boolean?][] = [
    ['trophallaxis credited to another worker', (xs) => { const t = xs.find((x) => x.cause === 'trophallaxis'); const other = t && xs.find((x) => x.recipient.kind === 'crop' && x.recipient.id !== t.recipient.id && x.recipient.id !== t.source.id); if (!t || !other) return false; t.recipient.id = other.recipient.id; return true; }],
    ['trophallaxis transfer missing', (xs) => { const t = xs.find((x) => x.cause === 'trophallaxis'); if (!t) return false; t.type = 'removed'; return true; }],
    ['the same unload recorded twice', (xs, ev) => { const t = xs.find((x) => x.cause === 'unload'); if (!t) return false; ev.splice(ev.indexOf(t) + 1, 0, structuredClone(t)); return true; }],
    ['unload amount off by 1 µp', (xs) => { const t = xs.find((x) => x.cause === 'unload'); if (!t) return false; t.portions = Math.round(t.portions * 1e6 + 1) / 1e6; return true; }],
    ['settlement draw from the wrong crop', (xs) => { const t = xs.find((x) => x.cause === 'metabolism' && x.source.kind === 'crop'); const other = t && xs.find((x) => x.recipient.kind === 'crop' && x.recipient.id !== t.source.id); if (!t || !other) return false; t.source.id = other.recipient.id; return true; }],
    ['unload into another worker\'s crop', (xs) => { const t = xs.find((x) => x.cause === 'unload' && x.recipient.kind === 'crop'); const other = t && xs.find((x) => x.recipient.kind === 'crop' && x.recipient.id !== t.recipient.id); if (!t || !other) return false; t.recipient.id = other.recipient.id; return true; }],
    ['metabolism attributed to an individual', (xs) => { const t = xs.find((x) => x.cause === 'metabolism'); if (!t) return false; t.attribution = 'individual'; return true; }, true],
    ['trophallaxis outside its unloading (minute changed)', (xs) => { const t = xs.find((x) => x.cause === 'trophallaxis'); if (!t) return false; t.minute = (t.minute ?? 0) + 7; return true; }, true],
    ['trophallaxis away from the nest', (xs) => { const t = xs.find((x) => x.cause === 'trophallaxis'); if (!t) return false; t.contact.recipient_location = 'F01'; return true; }, true],
  ];
  // independent review of 31cf796: food type is part of the engine check (sugar relabelled as protein through a crop)
  injections.push(['sugar collected and unloaded relabelled as protein', (xs) => { const u = xs.find((x) => x.cause === 'unload' && x.recipient.kind === 'crop'); const c = u && xs.find((x) => x.cause === 'collect' && x.recipient.id === u.source.id && x.food_type === 'sugar'); if (!u || !c) return false; u.food_type = 'protein'; c.food_type = 'protein'; return true; }]);
  for (const [name, f, cliOnly] of injections) { const m = pick(f); assert.ok(m, `F ${name}: no sample day to inject into`); both(name, m as Any, cliOnly); }
  // missing death transfer: needs a day on which a worker with sugar in its crop died
  let deathDay: Any = null;
  for (const sc of ['A1', 'A2', 'A3']) { if (deathDay) break; let s: Any = buildDay0(sc as Any, 3, '2027-12-22', b).state; for (let d = 0; d < 120 && !deathDay; d++) { const before = structuredClone(s.colonies[0]), o: Any = simulateWorldDay(s, b); if (engineTransfers(o.result.colonies[0].events).some((x) => x.cause === 'death_crop_to_nest_ledger')) deathDay = { before, after: o.state.colonies[0], events: o.result.colonies[0].events, day: o.day, sources: sourceIds(s) }; s = o.state; } }
  ok(deathDay, 'F: found a day on which a worker died with sugar in its crop');
  const noDeath = mutate(deathDay, (xs) => { const t = xs.find((x) => x.cause === 'death_crop_to_nest_ledger'); t.type = 'removed'; return true; });
  both('death transfer missing', noDeath as Any);
  // a bound transfer list rejects a negative or non-finite amount instead of dropping it
  for (const bad of [-0.1, Number.NaN]) {
    const ev: Any[] = []; bindFoodTransfers(ev, 1, 'C'); let t = '';
    try { foodTransfer(ev, { minute: null, phase: 'nest_settlement', source: { kind: 'cache', id: 'N' }, recipient: { kind: 'metabolized', id: 'C' }, food_type: 'protein', portions: bad, cause: 'metabolism', attribution: 'unknown' }); } catch (e) { t = String(e); }
    ok(/invalid amount/.test(t) && ev.length === 0, `F: a transfer of ${bad} portions throws instead of being dropped`);
  }
  // world-wide source check (synthetic world of two sites)
  const world: Any = { sources: { S1: { id: 'S1', sugar: 2, protein: 0 }, S2: { id: 'S2', sugar: 3, protein: 0 } }, colonies: [{ id: 'C', population: { workers: [{ id: 'W1' }] } }] };
  const start = sourceSnapshot(world);
  world.sources.S1.sugar = 1.5;
  const coll = (site: string) => [{ type: 'food_transfer', schema: 'antempire.food-transfer.v1', day: 1, transfer_id: 'FT-1-C-1', colony: 'C', phase: 'foraging', cause: 'collect', attribution: 'individual', minute: 1, source: { kind: 'source', id: site }, recipient: { kind: 'in_transit', id: 'W1' }, food_type: 'sugar', portions: 0.5 }] as Any;
  let threw = ''; try { checkSources(start, world, [coll('S1')]); } catch (e) { threw = String(e); }
  ok(threw === '', 'F: a correctly sourced collection passes the engine source check');
  threw = ''; try { checkSources(start, world, [coll('S2')]); } catch (e) { threw = String(e); }
  ok(/FOOD_TRANSFER: source:S1/.test(threw), `F: a collection credited to the wrong site is rejected by the engine source check (${threw.slice(0, 90)})`);
}

// ---------------------------------------------------------------- R: Issue #61 R3-08 (phantom compartments)
// Before the fix (5d5c9d6) Appendix A was ACCEPTED by the engine's colony check, the world source check and the reader
// (reports/issue61/appendix-a-before-fix-5d5c9d6.txt). Now every one of them must reject it.
if (!ONLY || ONLY.includes('R')) {
  const engineThrows = (f: () => void) => { try { f(); return ''; } catch (e) { return String(e); } };
  { // Appendix A, verbatim: real source S1 loses 0.5 protein to a worker and a nest that do not exist
    const w0: Any = buildDay0('A1' as Any, 1, '2027-09-23', b).state, c: Any = structuredClone(w0.colonies[0]);
    const base = { type: 'food_transfer', schema: 'antempire.food-transfer.v1', day: 1, colony: c.id, minute: 1, phase: 'foraging', food_type: 'protein', portions: 0.5, attribution: 'individual' };
    const ev: Any[] = [
      { ...base, transfer_id: `FT-1-${c.id}-1`, cause: 'collect', source: { kind: 'source', id: 'S1' }, recipient: { kind: 'in_transit', id: 'NONEXISTENT_WORKER' } },
      { ...base, transfer_id: `FT-1-${c.id}-2`, cause: 'unload', source: { kind: 'in_transit', id: 'NONEXISTENT_WORKER' }, recipient: { kind: 'cache', id: 'NONEXISTENT_NEST' } },
    ];
    const t1 = engineThrows(() => checkColonyFood(colonySnapshot(c), c, ev));
    ok(/NONEXISTENT_WORKER|NONEXISTENT_NEST/.test(t1) && /R3-08/.test(t1), `R Appendix A: the engine colony check rejects (${t1.slice(0, 120)})`);
    const cli = replayEngineColonyDay(c, c, ev, 1, new Set(['S1']));
    ok(!cli.ok && cli.errors.some((e) => /NONEXISTENT_WORKER/.test(e)) && cli.errors.some((e) => /NONEXISTENT_NEST/.test(e)), `R Appendix A: the reader rejects (${cli.errors[0]})`);
    const w: Any = { sources: { S1: { id: 'S1', sugar: 0, protein: 1 } } }, st = sourceSnapshot(w); w.sources.S1.protein = 0.5;
    const t2 = engineThrows(() => checkSources(st, w, [ev]));
    ok(/not in the world/.test(t2), `R Appendix A: the world source check rejects transfers of a colony that is not in the world (${t2.slice(0, 100)})`);
    const w2: Any = { sources: { S1: { id: 'S1', sugar: 0, protein: 1 } }, colonies: [c] }, st2 = sourceSnapshot(w2); w2.sources.S1.protein = 0.5;
    const t3 = engineThrows(() => checkSources(st2, w2, [ev]));
    ok(/NONEXISTENT_WORKER/.test(t3) && /R3-08/.test(t3), `R Appendix A: the world source check rejects a collection by a worker that does not exist (${t3.slice(0, 100)})`);
  }
  // variants on a real engine day: one illegal compartment at a time, amounts kept balanced so only the id is wrong
  const day = samples.find((x) => engineTransfers(x.events).some((t) => t.cause === 'unload' && t.recipient.kind === 'cache') && engineTransfers(x.events).some((t) => t.cause === 'metabolism'));
  assert.ok(day, 'R: a sample day with a protein unload and metabolism'); checks++;
  const vary = (name: string, f: (xs: Any[]) => boolean) => {
    const events = structuredClone((day as Any).events), xs = events.filter((e: Any) => e.type === 'food_transfer');
    assert.ok(f(xs), `R ${name}: injection applies`);
    const t = engineThrows(() => checkColonyFood(colonySnapshot((day as Any).before), (day as Any).after, events));
    const rep = replayEngineColonyDay((day as Any).before, (day as Any).after, events, (day as Any).day, (day as Any).sources);
    ok(/FOOD_TRANSFER/.test(t), `R ${name}: the engine rejects (${t.slice(0, 110)})`);
    ok(!rep.ok, `R ${name}: the reader rejects (${rep.errors[0]})`);
  };
  vary('protein unloaded into the cache of a nest that does not exist', (xs) => { const u = xs.find((x) => x.cause === 'unload' && x.recipient.kind === 'cache'); u.recipient.id = 'N99'; return true; });
  vary('trophallaxis into the crop of a worker that does not exist', (xs) => { const t = xs.find((x) => x.cause === 'trophallaxis'); t.recipient.id = 'W999'; return true; });
  vary('metabolism charged to another colony', (xs) => { const t = xs.find((x) => x.cause === 'metabolism'); t.recipient.id = 'C9'; return true; });
  vary('unlocated sugar of another colony', (xs) => { const t = xs.find((x) => x.source.kind === 'nest_unlocated') ?? xs.find((x) => x.cause === 'metabolism'); t.source = { kind: 'nest_unlocated', id: 'C9' }; return true; });
  vary('storage overflow into an unknown sink', (xs) => { const t = xs.find((x) => x.cause === 'metabolism'); t.recipient = { kind: 'loss', id: 'somewhere' }; t.cause = 'storage_overflow'; return true; });
  vary('a transfer recorded for another colony', (xs) => { xs[0].colony = 'C9'; return true; });
  { // an egg that was not laid / a kill that did not happen
    const eggDay = samples.find((x) => engineTransfers(x.events).some((t) => t.cause === 'lay_egg'));
    if (eggDay) { const events = structuredClone(eggDay.events); events.filter((e: Any) => e.type === 'food_transfer' && e.cause === 'lay_egg').forEach((e: Any) => { e.recipient.id = 'E999999'; });
      ok(/R3-08/.test(engineThrows(() => checkColonyFood(colonySnapshot(eggDay.before), eggDay.after, events))) && !replayEngineColonyDay(eggDay.before, eggDay.after, events, eggDay.day, eggDay.sources).ok, 'R egg that was not laid: engine and reader reject'); }
  }
  { // the reader also rejects a source the world does not have
    const events = structuredClone((day as Any).events), c = events.find((e: Any) => e.type === 'food_transfer' && e.cause === 'collect');
    c.source.id = 'NOT_A_SITE';
    ok(!replayEngineColonyDay((day as Any).before, (day as Any).after, events, (day as Any).day, (day as Any).sources).ok, 'R unknown source: the reader rejects');
  }
  { // two colonies: a collection credited to a worker of the OTHER colony is rejected by the world source check
    const meta = legacyColonyMeta(b.world.scenario_colonies as Any), base = legacyToWorldState(fixture(), meta), second: Any = structuredClone(base.colonies[0]);
    Object.assign(second, { id: 'B', nest_node: 'U00', rng_namespace: 'B|', worker_id_prefix: 'B-W', egg_id_prefix: 'B-E' }); second.population.workers = second.population.workers.slice(0, 3).map((w: Any, i: number) => ({ ...w, id: `B-W9${i}` }));
    const w: Any = { ...structuredClone(base), colonies: [structuredClone(base.colonies[0]), second] }, site = Object.keys(w.sources)[0]; w.sources[site].sugar = 1; const st = sourceSnapshot(w);
    w.sources[site].sugar = Math.round((w.sources[site].sugar - 0.5) * 1e6) / 1e6;
    const ev: Any[] = [{ type: 'food_transfer', schema: 'antempire.food-transfer.v1', day: 1, transfer_id: 'FT-1-' + w.colonies[0].id + '-1', colony: w.colonies[0].id, phase: 'foraging', attribution: 'individual', minute: 1, cause: 'collect', source: { kind: 'source', id: site }, recipient: { kind: 'in_transit', id: 'B-W90' }, food_type: 'sugar', portions: 0.5 }];
    const t = engineThrows(() => checkSources(st, w, [ev, []]));
    ok(/B-W90/.test(t), `R two colonies: a collection by a worker of the other colony is rejected (${t.slice(0, 100)})`);
  }
}

// ---------------------------------------------------------------- R2: independent review of 7ae0967 (counterexamples)
// Each injection keeps every amount balanced, so only the new rule can reject it; before this fix both the engine and
// the reader ACCEPTED 1b (a worker eclosing in today's settlement credited at a foraging minute), the duplicated kill and
// the misdirected unload.
if (!ONLY || ONLY.includes('R')) {
  const engineThrows = (f: () => void) => { try { f(); return ''; } catch (e) { return String(e); } };
  const renumber = (events: Any[], day: number, colony: string) => { let i = 0; for (const e of events) if (e.type === 'food_transfer') e.transfer_id = `FT-${day}-${colony}-${++i}`; };
  type Day = { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> };
  const findDay = (pred: (d: Day) => boolean): Day | null => {
    for (const sc of ['A1', 'A4', 'A5']) for (const seed of [1, 2, 3]) {
      let s: Any = buildDay0(sc as Any, seed, '2027-09-23', b).state;
      for (let d = 0; d < 60; d++) { const before = structuredClone(s.colonies[0]), src = sourceIds(s), o: Any = simulateWorldDay(s, b); const x = { before, after: o.state.colonies[0], events: o.result.colonies[0].events, day: o.day, sources: src }; if (pred(x)) return x; s = o.state; }
    }
    return null;
  };
  const both = (x: Day, events: Any[], name: string, engineRe: RegExp, readerRe: RegExp) => {
    const t = engineThrows(() => checkColonyFood(colonySnapshot(x.before), x.after, events));
    const rep = replayEngineColonyDay(x.before, x.after, events, x.day, x.sources);
    // C2_R2_PROBE=1 only records what each check does (used to record that the checks of 7ae0967 accepted these)
    if (process.env.C2_R2_PROBE) { console.log(JSON.stringify({ probe: name, engine_colony_check: t ? 'rejects' : 'ACCEPTS', reader: rep.ok ? 'ACCEPTS' : 'rejects', reader_errors: rep.errors.slice(0, 2) })); return; }
    ok(engineRe.test(t), `R2 ${name}: the engine rejects (${t.slice(0, 140)})`);
    ok(!rep.ok && rep.errors.some((e) => readerRe.test(e)), `R2 ${name}: the reader rejects (${rep.errors.find((e) => readerRe.test(e)) ?? rep.errors[0]})`);
  };
  { // 1b: a trophallaxis at a foraging minute credited to a worker that ecloses only in today's settlement
    const xs = (d: Day) => engineTransfers(d.events) as Any[];
    const pick = (d: Day) => {
      const born = d.after.population.workers.map((w: Any) => w.id).filter((id: string) => !d.before.population.workers.some((w: Any) => w.id === id));
      if (!born.length) return null;
      const t = xs(d).find((x) => x.cause === 'trophallaxis' && xs(d).some((m) => m.cause === 'metabolism' && m.source.kind === 'crop' && m.source.id === x.recipient.id && m.portions >= x.portions));
      return t ? { born: born[0], t } : null;
    };
    const day = findDay((d) => !!pick(d));
    assert.ok(day, 'R2 1b: a day with an eclosion, and a trophallaxis whose recipient later pays metabolism from its crop'); checks++;
    const p = pick(day as Day) as Any, events = structuredClone((day as Day).events);
    const T = events.find((e: Any) => e.transfer_id === p.t.transfer_id), R = T.recipient.id, a = T.portions;
    T.recipient = { kind: 'crop', id: p.born };
    const draw = events.find((e: Any) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.source.kind === 'crop' && e.source.id === R);
    draw.portions = Math.round((draw.portions - a) * 1e6) / 1e6;
    events.splice(events.indexOf(draw), 0, { ...structuredClone(draw), source: { kind: 'crop', id: p.born }, portions: a });
    if (!(draw.portions > 0)) events.splice(events.indexOf(draw), 1);
    renumber(events, (day as Day).day, (day as Day).before.id);
    both(day as Day, events, `1b (${p.born} ecloses in the settlement, credited at minute ${T.minute})`, new RegExp(`${p.born}.*R3-08`), new RegExp(`crop:${p.born} is not a compartment`));
  }
  { // 4a78ee4 review: 1b again, but the forged trophallaxis declares itself a settlement record (left in its place)
    const xs = (d: Day) => engineTransfers(d.events) as Any[];
    const day = findDay((d) => d.after.population.workers.some((w: Any) => !d.before.population.workers.some((v: Any) => v.id === w.id)) && xs(d).some((x) => x.cause === 'trophallaxis' && xs(d).some((m) => m.cause === 'metabolism' && m.source.kind === 'crop' && m.source.id === x.recipient.id && m.portions >= x.portions))) as Day;
    const born = day.after.population.workers.map((w: Any) => w.id).find((id: string) => !day.before.population.workers.some((w: Any) => w.id === id));
    const events = structuredClone(day.events), all = events.filter((e: Any) => e.type === 'food_transfer');
    const T = all.find((x: Any) => x.cause === 'trophallaxis' && all.some((m: Any) => m.cause === 'metabolism' && m.source.kind === 'crop' && m.source.id === x.recipient.id && m.portions >= x.portions));
    const R = T.recipient.id, a = T.portions; T.recipient = { kind: 'crop', id: born }; T.phase = 'nest_settlement'; T.minute = null; // untimed, so only the phase rule can reject it
    const draw = events.find((e: Any) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.source.kind === 'crop' && e.source.id === R);
    draw.portions = Math.round((draw.portions - a) * 1e6) / 1e6;
    events.splice(events.indexOf(draw), 0, { ...structuredClone(draw), source: { kind: 'crop', id: born }, portions: a });
    if (!(draw.portions > 0)) events.splice(events.indexOf(draw), 1);
    renumber(events, day.day, day.before.id);
    both(day, events, `1b with the forged record labelled nest_settlement (${born})`, /belongs to foraging/, /not a settlement cause|is not a compartment|belongs to phase foraging/);
  }
  { // kills: one-shot, at the kill's site, with exactly its carcass's protein
    const day = findDay((d) => engineTransfers(d.events).some((x) => x.cause === 'prey_kill') && Object.keys(d.before).length > 0);
    assert.ok(day, 'R2 kills: a day with a prey kill'); checks++;
    const kill = (events: Any[]) => events.find((e: Any) => e.type === 'food_transfer' && e.cause === 'prey_kill');
    { const events = structuredClone((day as Day).events), k = kill(events); events.splice(events.indexOf(k) + 1, 0, structuredClone(k)); renumber(events, (day as Day).day, (day as Day).before.id);
      both(day as Day, events, 'the same kill credited twice', /second time/, /credited twice/); }
    { const events = structuredClone((day as Day).events), k = kill(events), other = [...(day as Day).sources].find((id) => id !== k.recipient.id); k.recipient.id = other;
      both(day as Day, events, `a kill credited to another site (${other})`, /the kill was at/, /happened at/); }
    { const events = structuredClone((day as Day).events), k = kill(events); k.portions = Math.round(k.portions * 2 * 1e6) / 1e6;
      both(day as Day, events, 'a kill credited with more protein than its carcass', /carcass holds/, /its carcass is/); }
    { const events = structuredClone((day as Day).events), k = kill(events); k.food_type = 'sugar';
      both(day as Day, events, 'a kill recorded as sugar', /yields protein/, /yields protein/); }
    { const events = structuredClone((day as Day).events), k = kill(events); events.splice(events.indexOf(k), 1); renumber(events, (day as Day).day, (day as Day).before.id);
      both(day as Day, events, 'a kill with no prey_kill transfer', /no prey_kill/, /no prey_kill/); }
  }
  { // holder pairing (reviewer's 2c): part of W's transit load goes straight into R's crop instead of W's crop followed by
    // the trophallaxis W -> R of that amount (balanced: every crop ends as before)
    const xsOf = (d: Any) => engineTransfers(d.events) as Any[];
    const day = samples.find((d) => xsOf(d).some((u, i) => u.cause === 'unload' && u.recipient.kind === 'crop' && xsOf(d)[i + 1]?.cause === 'trophallaxis' && xsOf(d)[i + 1].source.id === u.source.id && xsOf(d)[i + 1].portions < u.portions)) as Day;
    assert.ok(day, 'R2 holder: a sugar unload followed by a trophallaxis from the same worker'); checks++;
    const events = structuredClone(day.events), xs = events.filter((e: Any) => e.type === 'food_transfer');
    const i = xs.findIndex((u: Any, j: number) => u.cause === 'unload' && u.recipient.kind === 'crop' && xs[j + 1]?.cause === 'trophallaxis' && xs[j + 1].source.id === u.source.id && xs[j + 1].portions < u.portions);
    const U = xs[i], T = xs[i + 1], R = T.recipient.id;
    U.portions = Math.round((U.portions - T.portions) * 1e6) / 1e6;
    events.splice(events.indexOf(T), 1, { ...structuredClone(U), recipient: { kind: 'crop', id: R }, portions: T.portions });
    renumber(events, day.day, day.before.id);
    both(day, events, `part of ${U.source.id}'s transit load unloaded into the crop of ${R}`, /unloads the transit load/, /is unloaded into the crop of/);
  }
}

// ---------------------------------------------------------------- S: Codex review of 1bdba72, F1 (runtime record schema)
// Records come from JSON; TypeScript types prove nothing at run time. Every malformed record must be rejected by BOTH the
// engine and the independent reader, with a message that names the record. Codex's reproduction (A1, seed 1, 2027-09-23,
// day 5, every foraging transfer relabelled phase 'invalid_phase', amounts and states untouched) was ACCEPTED by the
// reader of 1bdba72 and rejected by the engine (reports/issue61/codex-f1-phase-before-1bdba72.txt).
if (!ONLY || ONLY.includes('S')) {
  const engineThrows = (f: () => void) => { try { f(); return ''; } catch (e) { return String(e); } };
  type Day = { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> };
  const dayN = (n: number, sc = 'A1', seed = 1): Day => {
    let s: Any = buildDay0(sc as Any, seed, '2027-09-23', b).state;
    for (;;) { const before = structuredClone(s.colonies[0]), src = sourceIds(s), o: Any = simulateWorldDay(s, b); if (o.day === n) return { before, after: o.state.colonies[0], events: o.result.colonies[0].events, day: o.day, sources: src }; s = o.state; }
  };
  const renumber = (events: Any[], d: Day) => { let i = 0; for (const e of events) if (e.type === 'food_transfer') e.transfer_id = `FT-${d.day}-${d.before.id}-${++i}`; };
  const probe = (d: Day, name: string, mutate: (events: Any[]) => void, engineRe: RegExp, readerRe: RegExp) => {
    const events = structuredClone(d.events); mutate(events);
    const t = engineThrows(() => checkColonyFood(colonySnapshot(d.before), d.after, events));
    // the reader must return a located error, never crash on a malformed record
    let rep: Any, crash = '';
    try { rep = replayEngineColonyDay(d.before, d.after, events, d.day, d.sources); } catch (e) { crash = String(e); rep = { ok: false, errors: [] }; }
    if (process.env.C2_R2_PROBE) { console.log(JSON.stringify({ probe: 'S ' + name, engine_colony_check: t ? (/FOOD_TRANSFER/.test(t) ? 'rejects' : 'CRASHES ' + t.slice(0, 80)) : 'ACCEPTS', reader: crash ? 'CRASHES ' + crash.slice(0, 80) : rep.ok ? 'ACCEPTS' : 'rejects', reader_errors: rep.errors.slice(0, 2) })); return; }
    ok(!crash, `S ${name}: the reader does not crash (${crash.slice(0, 120)})`);
    ok(/FOOD_TRANSFER/.test(t), `S ${name}: the engine rejects with a located FOOD_TRANSFER error, not a crash (${t.slice(0, 120)})`);
    ok(engineRe.test(t), `S ${name}: the engine rejects (${t.slice(0, 150)})`);
    ok(!rep.ok && rep.errors.some((e: string) => readerRe.test(e)), `S ${name}: the reader rejects (${rep.errors.find((e: string) => readerRe.test(e)) ?? rep.errors[0]})`);
  };
  const d5 = dayN(5), forage = (events: Any[]) => events.filter((e: Any) => e.type === 'food_transfer' && e.phase === 'foraging');
  assert.ok(forage(d5.events).length >= 2, 'S fixture: day 5 has foraging transfers'); checks++;
  // Codex F1, verbatim
  probe(d5, "Codex F1: every foraging transfer relabelled 'invalid_phase'", (ev) => forage(ev).forEach((x: Any) => { x.phase = 'invalid_phase'; }), /phase/, /phase/);
  // phase values that are not one of the two defined phases
  const first = (ev: Any[]) => forage(ev)[0];
  probe(d5, 'missing phase', (ev) => { delete first(ev).phase; }, /phase/, /phase/);
  probe(d5, 'null phase', (ev) => { first(ev).phase = null; }, /phase/, /phase/);
  probe(d5, 'empty-string phase', (ev) => { first(ev).phase = ''; }, /phase/, /phase/);
  probe(d5, 'phase of the wrong type (number)', (ev) => { first(ev).phase = 1; }, /phase/, /phase/);
  probe(d5, 'phase of the wrong type (object)', (ev) => { first(ev).phase = { phase: 'foraging' }; }, /phase/, /phase/);
  // cause/phase mismatch and illegal order across phases
  probe(d5, 'a collect declared nest_settlement', (ev) => { const c = ev.find((e: Any) => e.type === 'food_transfer' && e.cause === 'collect'); c.phase = 'nest_settlement'; c.minute = null; }, /belongs to foraging/, /belongs to phase foraging/);
  probe(d5, 'a settlement record declared foraging', (ev) => { const m = ev.find((e: Any) => e.type === 'food_transfer' && e.phase === 'nest_settlement'); m.phase = 'foraging'; }, /belongs to nest_settlement|recorded in phase foraging/, /belongs to phase nest_settlement/);
  probe(d5, 'a foraging record placed after the settlement began', (ev) => {
    const xs = ev.filter((e: Any) => e.type === 'food_transfer'), lastF = forage(ev).at(-1), lastS = xs.at(-1);
    ev.splice(ev.indexOf(lastF), 1); ev.splice(ev.indexOf(lastS) + 1, 0, lastF); renumber(ev, d5);
  }, /day order/, /after the nest settlement began/);
  // an invalid phase must not open the end-of-day roster: a worker that ecloses in today's settlement credited at a
  // foraging minute under phase 'invalid_phase' (the R2 1b case; on 1bdba72 the reader used the end roster for it)
  {
    const xs = (d: Day) => engineTransfers(d.events) as Any[];
    let d: Day | null = null;
    outer: for (const sc of ['A1', 'A4', 'A5']) for (const seed of [1, 2, 3]) {
      let s: Any = buildDay0(sc as Any, seed, '2027-09-23', b).state;
      for (let k = 0; k < 60; k++) { const before = structuredClone(s.colonies[0]), src = sourceIds(s), o: Any = simulateWorldDay(s, b); const x = { before, after: o.state.colonies[0], events: o.result.colonies[0].events, day: o.day, sources: src };
        if (x.after.population.workers.some((w: Any) => !x.before.population.workers.some((v: Any) => v.id === w.id)) && xs(x).some((t) => t.cause === 'trophallaxis' && xs(x).some((m) => m.cause === 'metabolism' && m.source.kind === 'crop' && m.source.id === t.recipient.id && m.portions >= t.portions))) { d = x; break outer; } s = o.state; }
    }
    assert.ok(d, 'S fixture: a day with an eclosion and a trophallaxis recipient paying metabolism'); checks++;
    const dd = d as Day, born = dd.after.population.workers.map((w: Any) => w.id).find((id: string) => !dd.before.population.workers.some((w: Any) => w.id === id));
    probe(dd, `an invalid phase used to credit ${born}, who exists only at the end of the day`, (ev) => {
      const all = ev.filter((e: Any) => e.type === 'food_transfer');
      const T = all.find((x: Any) => x.cause === 'trophallaxis' && all.some((m: Any) => m.cause === 'metabolism' && m.source.kind === 'crop' && m.source.id === x.recipient.id && m.portions >= x.portions));
      const R = T.recipient.id, a = T.portions; T.recipient = { kind: 'crop', id: born }; T.phase = 'invalid_phase';
      const draw = ev.find((e: Any) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.source.kind === 'crop' && e.source.id === R);
      draw.portions = Math.round((draw.portions - a) * 1e6) / 1e6;
      ev.splice(ev.indexOf(draw), 0, { ...structuredClone(draw), source: { kind: 'crop', id: born }, portions: a });
      if (!(draw.portions > 0)) ev.splice(ev.indexOf(draw), 1);
      renumber(ev, dd);
    }, /phase/, /phase/);
  }
  // other fields of the record: cause, kinds, ids, food type, amount, colony
  probe(d5, 'unknown cause', (ev) => { first(ev).cause = 'teleport'; }, /cause/, /cause/);
  probe(d5, 'missing source', (ev) => { delete first(ev).source; }, /source/, /source/);
  probe(d5, 'recipient of an unknown kind', (ev) => { first(ev).recipient = { kind: 'pocket', id: 'W001' }; }, /pocket|kind/, /pocket|kind/);
  probe(d5, 'worker id of the wrong type', (ev) => { const c = ev.find((e: Any) => e.type === 'food_transfer' && e.cause === 'collect'); c.recipient = { kind: 'in_transit', id: 7 }; }, /id/, /id/);
  probe(d5, 'unknown food type', (ev) => { first(ev).food_type = 'fat'; }, /food_type|fat/, /food_type|fat|cannot hold/);
  probe(d5, 'amount given as a string', (ev) => { first(ev).portions = '0.5'; }, /portions|amount/, /portions|amount/);
  probe(d5, 'colony field missing', (ev) => { delete first(ev).colony; }, /colony/, /colony/);
  // independent review of 9888217 (all accepted by at least one checker there, or crashed)
  probe(d5, 'negative foraging minute', (ev) => { first(ev).minute = -5; }, /minute/, /minute/);
  probe(d5, 'foraging minute beyond the day', (ev) => { first(ev).minute = 1e9; }, /minute/, /minute/);
  probe(d5, 'a settlement record with a minute', (ev) => { const m = ev.find((e: Any) => e.type === 'food_transfer' && e.phase === 'nest_settlement'); m.minute = 7; }, /minute/, /minute/);
  probe(d5, 'undefined attribution', (ev) => { first(ev).attribution = 'someone'; }, /attribution/, /attribution/);
  probe(d5, 'wrong schema', (ev) => { first(ev).schema = 'v0'; }, /schema/, /schema/);
  probe(d5, 'day given as a string', (ev) => { first(ev).day = '5'; }, /day/, /day/);
  probe(d5, 'a transfer_id used twice', (ev) => { const xs = ev.filter((e: Any) => e.type === 'food_transfer'); xs[1].transfer_id = xs[0].transfer_id; }, /used twice/, /expected FT-/);
  probe(d5, 'a record that is an array', (ev) => { const i = ev.indexOf(first(ev)); ev[i] = Object.assign([], first(ev)); }, /array/, /not an object/);
  probe(d5, 'a source given as an array', (ev) => { const f = first(ev); f.source = Object.assign([], f.source); }, /source missing or not an object/, /source missing or not an object/);
  probe(d5, 'portions with seven decimals', (ev) => { first(ev).portions = Math.round(first(ev).portions * 1e6) / 1e6 + 1e-7; }, /six decimals/, /six-decimal/);
  probe(d5, 'a phantom transfer of less than one micro-portion', (ev) => { const u = ev.find((e: Any) => e.type === 'food_transfer' && e.cause === 'unload'); ev.splice(ev.indexOf(u) + 1, 0, { ...structuredClone(u), portions: 5e-10 }); renumber(ev, d5); }, /micro-portion/, /six-decimal portion/);
  probe(d5, 'an attribution that does not belong to the cause', (ev) => { const c = ev.find((e: Any) => e.type === 'food_transfer' && e.cause === 'collect'); c.attribution = 'engine_rule'; }, /must have attribution individual/, /must have attribution individual/);
  probe(d5, 'a null element in the event list', (ev) => { ev.splice(1, 0, null); }, /not an event object/, /not an event object/);
  probe(d5, "cause 'toString' (prototype name)", (ev) => { first(ev).cause = 'toString'; }, /unknown cause "toString"/, /unknown cause "toString"/);
  // the world source check alone (it runs alone when the colony check is not defined): cause, phase and path are its own
  {
    const world: Any = { sources: { S1: { id: 'S1', sugar: 2, protein: 0 } }, colonies: [{ id: 'C', population: { workers: [{ id: 'W1' }] } }] }, st = sourceSnapshot(world);
    world.sources.S1.sugar = 1.5;
    const rec = (extra: Any) => [{ type: 'food_transfer', schema: 'antempire.food-transfer.v1', day: 1, transfer_id: 'FT-1-C-1', colony: 'C', phase: 'foraging', cause: 'collect', attribution: 'individual', minute: 1, source: { kind: 'source', id: 'S1' }, recipient: { kind: 'in_transit', id: 'W1' }, food_type: 'sugar', portions: 0.5, ...extra }] as Any;
    const t0 = engineThrows(() => checkSources(st, world, [rec({})]));
    ok(t0 === '', `S world check: a correct collection passes (${t0.slice(0, 100)})`);
    for (const [name, extra] of [['collect relabelled nest_settlement', { phase: 'nest_settlement', minute: null }], ['collect relabelled metabolism', { cause: 'metabolism', attribution: 'unknown' }], ['collect relabelled trophallaxis', { cause: 'trophallaxis' }]] as [string, Any][]) {
      const t = engineThrows(() => checkSources(st, world, [rec(extra)]));
      if (process.env.C2_R2_PROBE) { console.log(JSON.stringify({ probe: 'S world check: ' + name, engine_world_check: t ? (/FOOD_TRANSFER/.test(t) ? 'rejects' : 'CRASHES') : 'ACCEPTS' })); continue; }
      ok(/FOOD_TRANSFER/.test(t), `S world check: ${name} is rejected (${t.slice(0, 120)})`);
    }
  }
}

// ---------------------------------------------------------------- TC: Codex reviews 2026-11-04/05, F1 (P2) — time causality
// A closing end balance does not prove the transfers could happen in that order. Each case below was ACCEPTED by both
// validators before this fix (evidence: Codex probe on 81c0e89; reproduced in reports/c2-time-causality-p2-1.md) and
// must now be rejected by BOTH the engine (checkColonyFood → checkTimedCausality) and the independent reader.
if (!ONLY || ONLY.includes('C')) {
  type Day = { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> };
  const findDay = (pred: (ev: Any[]) => boolean, sc = 'A1', seed = 1, season = '2027-09-23', maxDays = 60): Day => {
    let s: Any = buildDay0(sc as Any, seed, season, b).state;
    for (let d = 0; d < maxDays; d++) { const before = structuredClone(s.colonies[0]), src = sourceIds(s), o: Any = simulateWorldDay(s, b); if (pred(o.result.colonies[0].events)) return { before, after: o.state.colonies[0], events: o.result.colonies[0].events, day: o.day, sources: src }; s = o.state; }
    throw Error('no such day');
  };
  const fx = (ev: Any[]) => ev.filter((e) => e.type === 'food_transfer' && e.phase === 'foraging');
  const engineMsg = (d: Day, ev: Any[]) => { try { checkColonyFood(colonySnapshot(d.before), d.after, ev, 'timed'); return ''; } catch (e) { return String(e); } };
  const both = (d: Day, name: string, mutate: (ev: Any[]) => Any[], expect: 'reject' | 'accept', engineRe = /FOOD_TRANSFER/, readerRe = /./) => {
    const ev = mutate(structuredClone(d.events)), t = engineMsg(d, ev), rep = replayEngineColonyDay(d.before, d.after, ev, d.day, d.sources, speciesFoodTiming(b.species[MAIN_SPECIES]));
    if (process.env.C2_R2_PROBE) { console.log(JSON.stringify({ probe: 'TC ' + name, engine: t ? 'rejects' : 'ACCEPTS', reader: rep.ok ? 'ACCEPTS' : 'rejects', time_validation: rep.time_validation, engine_error: t.slice(0, 160), reader_errors: rep.errors.slice(0, 2) })); return; }
    if (expect === 'reject') {
      ok(engineRe.test(t), `TC ${name}: the engine rejects (${t.slice(0, 160) || 'ACCEPTED'})`);
      ok(!rep.ok && rep.errors.some((e: string) => readerRe.test(e)), `TC ${name}: the reader rejects (${rep.errors[0] ?? 'ACCEPTED'})`);
    } else {
      ok(t === '', `TC ${name}: the engine accepts (${t.slice(0, 160)})`);
      ok(rep.ok, `TC ${name}: the reader accepts (${rep.errors.slice(0, 2).join(' | ')})`);
    }
    return rep;
  };
  // Codex's own example day: A1, seed 1, autumn equinox, day 5 (two collects and two unloads of one worker)
  const d5 = findDay((ev) => fx(ev).length === 4 && fx(ev).some((x) => x.cause === 'unload'), 'A1', 1, '2027-09-23', 5);
  ok(d5.day === 5, `Codex example day is day ${d5.day}`);
  both(d5, 'unmodified day', (ev) => ev, 'accept');
  both(d5, 'Codex probe: collects at minute 1000, unloads at minute 0 (ids, amounts, order unchanged)', (ev) => { for (const x of fx(ev)) { if (x.cause === 'collect') x.minute = 1000; if (x.cause === 'unload') x.minute = 0; } return ev; }, 'reject', /go back in time|has not arrived/, /^time:/);
  both(d5, 'an unload stamped 1 minute before its own collect', (ev) => { const xs = fx(ev), u = xs.find((x) => x.cause === 'unload'), c = xs.find((x) => x.cause === 'collect' && x.recipient.id === u.source.id); u.minute = c.minute - 1; return ev; }, 'reject', /go back in time|has not arrived/, /^time:/);
  both(d5, 'valid sequence with every timestamp shifted so that unloads come first (tampered timestamps)', (ev) => { const xs = fx(ev); const ms = xs.map((x) => x.minute).reverse(); xs.forEach((x, i) => (x.minute = ms[i])); return ev; }, 'reject', /go back in time|has not arrived/, /^time:/);
  both(d5, 'same worker, same minute: unload listed before its collect (ids renumbered)', (ev) => { const xs = fx(ev), c = xs[0], u = xs[1]; u.minute = c.minute; const ic = ev.indexOf(c), iu = ev.indexOf(u); [ev[ic], ev[iu]] = [ev[iu], ev[ic]]; let i = 0; for (const e of ev) if (e.type === 'food_transfer') e.transfer_id = `FT-${d5.day}-${d5.before.id}-${++i}`; return ev; }, 'reject', /holds 0|has not arrived/, /holds 0|^time:/);
  both(d5, 'same worker, same minute, collect then unload in that order (legal: the tie rule is the order of the acts)', (ev) => { const xs = fx(ev); xs[1].minute = xs[0].minute; return ev; }, 'accept');
  both(d5, 'an unload with no earlier collect (the collect removed, amounts otherwise unchanged)', (ev) => { const c = fx(ev).find((x) => x.cause === 'collect'); return ev.filter((e) => e !== c); }, 'reject', /holds 0|has not arrived|transit/, /holds 0|^time:|id/);
  both(d5, 'array order changed, end balance still closes', (ev) => { const xs = fx(ev), ic = ev.indexOf(xs[0]), iu = ev.indexOf(xs[1]); [ev[ic], ev[iu]] = [ev[iu], ev[ic]]; return ev; }, 'reject', /holds 0/, /holds 0|expected/);
  both(d5, 'one record made untimed (minute null) among timed ones', (ev) => { fx(ev).find((x) => x.cause === 'collect').minute = null; return ev; }, 'reject', /minute null on a timed day/, /^time:.*minute null/);
  both(d5, 'one unload made untimed (minute null): null is not minute 0', (ev) => { fx(ev).find((x) => x.cause === 'unload').minute = null; return ev; }, 'reject', /minute null on a timed day/, /^time:.*minute null/);
  // the timing mode comes from the rules, not the records: nulling EVERY minute of a timed day does not make it a legacy day
  both(d5, 'every foraging minute set to null on a timed day (would otherwise pass as an untimed legacy day)', (ev) => { for (const x of fx(ev)) x.minute = null; return ev; }, 'reject', /minute null on a timed day/, /^time:.*minute null/);
  ok(speciesFoodTiming(b.species[MAIN_SPECIES]) === 'timed', 'TC the main species runs the individual timeline: the reader derives "timed" from the species parameters');
  // the legacy planned-trip path (individual timeline off): collects/unloads carry no minute, hunt windows do. Its time
  // order is NOT validated (stated limit) — the array-order replay still applies — and the mode must be stated by the rules.
  {
    const lb: Any = structuredClone(b); lb.species[MAIN_SPECIES].activity.individual_timeline = false;
    let s: Any = buildDay0('A1' as Any, 1, '2027-09-23', lb).state, legacyDays = 0, mixedDays = 0, rejectedAsTimed = 0;
    for (let d = 0; d < 30; d++) {
      const before = structuredClone(s.colonies[0]), src = sourceIds(s), o: Any = simulateWorldDay(s, lb), ev = o.result.colonies[0].events, xs = fx(ev);
      const rep = replayEngineColonyDay(before, o.state.colonies[0], ev, o.day, src, speciesFoodTiming(lb.species[MAIN_SPECIES]));
      if (xs.length) {
        ok(rep.ok && rep.time_validation === 'untimed_legacy', `TC legacy day ${o.day}: the reader accepts and reports time NOT validated (${rep.time_validation}; ${rep.errors[0] ?? ''})`); legacyDays++;
        if (xs.some((x: Any) => x.minute === null) && xs.some((x: Any) => x.minute !== null)) mixedDays++;
        const asTimed = replayEngineColonyDay(before, o.state.colonies[0], ev, o.day, src, 'timed');
        if (xs.some((x: Any) => x.minute === null)) { ok(!asTimed.ok && /^time:.*minute null/.test(asTimed.errors.join('\n')), `TC legacy day ${o.day} read as timed: rejected`); rejectedAsTimed++; }
        const u = xs.find((x: Any) => x.cause === 'unload'), c = u && xs.find((x: Any) => x.cause === 'collect' && x.recipient.id === u.source.id);
        if (u && c && ev.indexOf(c) < ev.indexOf(u) && legacyDays < 4) {
          const sw = structuredClone(ev), a = ev.indexOf(c), z = ev.indexOf(u); [sw[a], sw[z]] = [sw[z], sw[a]];
          const t = (() => { try { checkColonyFood(colonySnapshot(before), o.state.colonies[0], sw, 'untimed_legacy'); return ''; } catch (e) { return String(e); } })();
          ok(/FOOD_TRANSFER/.test(t) && !replayEngineColonyDay(before, o.state.colonies[0], sw, o.day, src, 'untimed_legacy').ok, `TC legacy day ${o.day}: an unload listed before its collect is still rejected by the array-order replay (engine and reader)`);
        }
      }
      s = o.state;
    }
    if (process.env.C2_TC_SHOW) console.log(`legacy=${legacyDays} mixed=${mixedDays} asTimedRejected=${rejectedAsTimed}`);
    ok(legacyDays > 5, `TC ${legacyDays} legacy days with foraging records checked (${mixedDays} of them mix timed hunt records with untimed collects/unloads; ${rejectedAsTimed} rejected when read as timed)`);
  }
  // a day with a trophallaxis: the donor's crop gives sugar that its own unload brought; stamping the trophallaxis before
  // that unload must be rejected
  const dT = findDay((ev) => fx(ev).some((x) => x.cause === 'trophallaxis'));
  both(dT, 'trophallaxis stamped before the unload that filled the donor’s crop', (ev) => { const t = fx(ev).find((x) => x.cause === 'trophallaxis'), u = fx(ev).filter((x) => x.cause === 'unload' && x.source.id === t.source.id && x.minute <= t.minute).at(-1); t.minute = u.minute - 0.5; return ev; }, 'reject', /go back in time|has not arrived/, /^time:/);
  // independent review of ed32299, N1: a carcass collected before the kill that made it (sources are not time-replayed,
  // so the kill → carcass link is checked directly). Day 21 of A1 seed 1: kill at F11, four collects name it.
  const dK = findDay((ev) => fx(ev).some((x) => x.cause === 'prey_kill') && fx(ev).some((x) => x.cause === 'collect' && x.contact?.prey_event_id));
  const killOf = (ev: Any[]) => fx(ev).find((x) => x.cause === 'prey_kill');
  both(dK, 'unmodified hunting day', (ev) => ev, 'accept');
  both(dK, 'the kill and its predation event moved after the carcass collects (minute 1440)', (ev) => { const k = killOf(ev); k.minute = 1440; ev.find((e) => e.type === 'insect_predation' && e.event_id === k.source.id).minute = 1440; return ev; }, 'reject', /before its kill/, /^time:.*before the kill/);
  both(dK, 'only the prey_kill record moved (the kill event stays)', (ev) => { killOf(ev).minute = 1440; return ev; }, 'reject', /insect_predation|before its kill/, /^time:/);
  both(dK, 'a carcass collect stamped 1 minute before its kill', (ev) => { const k = killOf(ev), c = fx(ev).find((x) => x.cause === 'collect' && x.contact?.prey_event_id === k.source.id); c.minute = k.minute - 1; return ev; }, 'reject', /before its kill|go back in time|has not arrived/, /^time:/);
  both(dK, 'a collect naming a prey that was never killed', (ev) => { const c = fx(ev).find((x) => x.cause === 'collect' && x.contact?.prey_event_id); c.contact.prey_event_id = 'HUNT-NOPE'; return ev; }, 'reject', /no prey_kill record/, /^time:.*no kill/);
  // independent review of af6779c: the same violation with the optional prey tag removed. The kill adds carcass protein
  // to a shared source; untagged collects of it before the kill must be caught by the time-ordered SOURCE replay
  // (engine checkSources; reader replayEngineSourcesDay), whatever the tags say.
  {
    let sw: Any = buildDay0('A1' as Any, 1, '2027-09-23', b).state, o: Any;
    for (let d = 0; d < 60; d++) { o = simulateWorldDay(sw, b); if (fx(o.result.colonies[0].events).some((x) => x.cause === 'prey_kill')) break; sw = o.state; }
    const ev0 = o.result.colonies[0].events, kill = fx(ev0).find((x) => x.cause === 'prey_kill');
    // the source holdings at the start of foraging (input to the engine's check): end + collected − credited
    const startSrc = sourceSnapshot(o.state);
    for (const x of fx(ev0)) { const m = toMicro(x.portions); if (x.source.kind === 'source') startSrc.get(x.source.id)![x.food_type as 'sugar' | 'protein'] += m; if (x.recipient.kind === 'source') startSrc.get(x.recipient.id)![x.food_type as 'sugar' | 'protein'] -= m; }
    const engineThrows = (f: () => void) => { try { f(); return ''; } catch (e) { return String(e); } };
    const srcBoth = (name: string, ev: Any[], expect: 'reject' | 'accept') => {
      const t = engineThrows(() => checkSources(startSrc, o.state, [ev], ['timed'])), se = replayEngineSourcesDay(o.state.sources, [{ id: o.result.colonies[0].colony_id, events: ev, timing: 'timed' }]);
      if (expect === 'accept') { ok(t === '', `TC sources ${name}: the engine accepts (${t.slice(0, 140)})`); ok(se.length === 0, `TC sources ${name}: the reader accepts (${se[0]})`); }
      else { ok(/FOOD_TRANSFER/.test(t), `TC sources ${name}: the engine's source check rejects (${t.slice(0, 160) || 'ACCEPTED'})`); ok(se.length > 0, `TC sources ${name}: the reader's source replay rejects (${se[0] ?? 'ACCEPTED'})`); }
    };
    srcBoth('unmodified hunting day', structuredClone(ev0), 'accept');
    for (const strip of ['prey_event_id', 'contact'] as const) {
      const ev = structuredClone(ev0);
      for (const x of fx(ev)) if (x.contact?.prey_event_id) { if (strip === 'contact') delete x.contact; else delete x.contact.prey_event_id; }
      fx(ev).find((x) => x.transfer_id === kill.transfer_id).minute = 1440; ev.find((e: Any) => e.type === 'insect_predation' && e.event_id === kill.source.id).minute = 1440;
      srcBoth(`carcass collects untagged (${strip} removed), kill moved to minute 1440`, ev, 'reject');
    }
  }
  // Codex review 2026-11-05 (latest) N1 (P2): replayEngineSourcesDay used directly must validate its own input — never
  // [] for illegal input, never a TypeError (reports/c2-time-causality-p2-1/source-input-*.txt)
  {
    const rec = (): Any => ({ type: 'food_transfer', schema: 'antempire.food-transfer.v1', transfer_id: 'FT-1-C1-1', day: 1, colony: 'C1', minute: 1, phase: 'foraging', cause: 'collect', attribution: 'individual', source: { kind: 'source', id: 'F01' }, recipient: { kind: 'in_transit', id: 'W1' }, food_type: 'sugar', portions: 1 });
    const end = { F01: { sugar: 10, protein: 0 } };
    const call = (events: Any, endS: Any = end, colonies?: Any) => { try { return { r: replayEngineSourcesDay(endS, colonies ?? [{ id: 'C1', events, timing: 'timed' }]), crash: '' }; } catch (e) { return { r: [] as string[], crash: String(e) }; } };
    const v0 = call([rec()]);
    ok(v0.crash === '' && v0.r.length === 0, `TC source input: a valid collect is accepted (${v0.r[0] ?? v0.crash})`);
    const bad: [string, Any, Any?, Any?, RegExp?][] = [
      ['events = null', null, undefined, undefined, /events is null, not an array/],
      ['portions = -1', [{ ...rec(), portions: -1 }], undefined, undefined, /portions -1 is not a positive/],
      ['unknown source id', [{ ...rec(), source: { kind: 'source', id: 'DOES_NOT_EXIST' } }], undefined, undefined, /not a food source of this world/],
      ['recipient deleted', [(() => { const x = rec(); delete x.recipient; return x; })()], undefined, undefined, /recipient missing/],
      ['null event in the list', [null], undefined, undefined, /not an event object/],
      ['colony list not an array', null, end, 'nope', /not an array/],
      ['end source with a negative amount', [rec()], { F01: { sugar: 10, protein: -3 } }, undefined, /not a non-negative number/],
      ['end source table not an object', [rec()], null, undefined, /not an object/],
      ['collect into a crop (not a source path)', [{ ...rec(), recipient: { kind: 'crop', id: 'W1' } }], undefined, undefined, /not a collection or a kill/],
      ['record of another colony', [{ ...rec(), colony: 'C9' }], undefined, undefined, /recorded for colony C9/],
      ['undefined timing', null, end, [{ id: 'C1', events: [rec()], timing: 'sometimes' }], /timing/],
      // independent review of c00d6a9 (P3): fail-open on overflow, sub-micro amounts, unreadable values, holes
      ['portions too large for exact arithmetic (1e303)', [{ ...rec(), portions: 1e303 }], undefined, undefined, /too large|below one micro/],
      ['end amount too large (1e303)', [rec()], { F01: { sugar: 1e303, protein: 0 } }, undefined, /exact micro-portion range/],
      ['sub-micro portions (1e-9)', [{ ...rec(), portions: 1e-9 }], undefined, undefined, /below one micro-portion/],
      ['BigInt portions', [{ ...rec(), portions: 10n }], undefined, undefined, /portions 10n/],
      ['a hole in the colony list', null, end, [, ], /hole/],
      ['a throwing getter', null, end, [{ id: 'C1', timing: 'timed', get events(): Any { throw Error('boom'); } }], /cannot be read/],
    ];
    { const big = call({ length: 1, x: 'y'.repeat(5_000_000) }); ok(big.crash === '' && big.r.length > 0 && big.r.every((m) => m.length < 400), `TC source input: a huge invalid input gives a bounded message (${big.r[0]?.length} chars)`); }
    { const many = call(Array.from({ length: 1000 }, () => null)); ok(many.r.length <= 51 && /more input errors/.test(many.r.at(-1) ?? ''), `TC source input: errors are capped (${many.r.length} lines)`); }
    for (const [name, events, endS, colonies, re] of bad) {
      const v = call(events, endS === undefined ? end : endS, colonies);
      ok(v.crash === '' && v.r.length > 0 && (!re || v.r.some((m) => re.test(m))), `TC source input: ${name} is reported, not accepted or crashed (${v.crash || v.r[0] || 'ACCEPTED'})`);
    }
  }
  // different workers' records may interleave in any list order: a legal day with two foragers, the list regrouped
  // worker by worker (each worker's own records keep their order and minutes; ids renumbered) must still be accepted
  const two = findDay((ev) => { const ws = new Set(fx(ev).filter((x) => x.cause === 'collect').map((x) => x.recipient.id)); return ws.size >= 2 && !fx(ev).some((x) => x.cause === 'trophallaxis'); }, 'A1', 1, '2027-09-23', 60);
  both(two, 'two workers’ records regrouped by worker (list no longer in global time order; each worker in order)', (ev) => {
    const xs = fx(ev), w = (x: Any) => (x.source.kind === 'in_transit' ? x.source.id : x.recipient.id), byW = [...new Set(xs.map(w))].sort().reverse();
    const regrouped = byW.flatMap((id) => xs.filter((x) => w(x) === id)), firstIdx = ev.indexOf(xs[0]);
    const rest = ev.filter((e) => !xs.includes(e)); rest.splice(firstIdx, 0, ...regrouped);
    let i = 0; for (const e of rest) if (e.type === 'food_transfer') e.transfer_id = `FT-${two.day}-${two.before.id}-${++i}`;
    ok(!process.env.C2_R2_PROBE && regrouped.some((x, k) => k > 0 && x.minute < regrouped[k - 1].minute) || !!process.env.C2_R2_PROBE, 'the regrouped list is not in global time order (so the test is not trivial)');
    return rest;
  }, 'accept');
}
// ---------------------------------------------------------------- T: determinism
if (!ONLY || ONLY.includes('T')) {
  const a = runWorld(buildDay0('A1' as Any, 7, '2027-09-23', b).state, 20, 'T', false), z = runWorld(buildDay0('A1' as Any, 7, '2027-09-23', b).state, 20, 'T', false);
  ok(JSON.stringify(a) === JSON.stringify(z) && a.join('').length > 1000, 'T: the same input gives a byte-identical food_transfer sequence');
}
console.log(JSON.stringify({ checks, engine_version: ENGINE_VERSION, ...stats, note: 'engineering checks only; F01/A08 remain (metabolism, eggs and overflow still taken from the colony ledger, attribution unknown); worker-array order of settlement draws and contact choice is Issue #56' }, null, 2));
