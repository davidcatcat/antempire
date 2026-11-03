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
import { engineTransfers, replayEngineColonyDay } from '../cli/lib/engine-transfers.ts';
import { dayTransfers, replayColonyDay, toMicro } from '../cli/lib/compartments.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';
import { bindFoodTransfers, foodTransfer } from '../engine/transfers.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle();
const ONLY = process.env.C2_ONLY;

// ---------------------------------------------------------------- E: real engine, every colony-day replayed
const stats = { colony_days: 0, transfers: 0, by_cause: {} as Record<string, number>, unattributed: { sugar: 0, protein: 0 }, c1_evidence_limited_days_fully_checked: 0, c1_agree_days: 0 };
const ids = new Set<string>();
const sig = (x: Any, amount: number) => `${x.cause}|${x.source.kind}:${x.source.id}|${x.recipient.kind}:${x.recipient.id}|${x.food_type}|${amount}`;
const samples: { before: Any; after: Any; events: Any[]; day: number; sources: Set<string> }[] = [];
const sourceIds = (w: Any) => new Set<string>(Object.keys(w.sources));
function runWorld(s: WorldState, n: number, label: string, collect = true): string[] {
  const seqs: string[] = [];
  ids.clear(); // transfer ids are unique within one world (FT-<day>-<colony>-<n>)
  for (let d = 0; d < n; d++) {
    const befores = s.colonies.map((c) => structuredClone(c)), o: Any = simulateWorldDay(s, b);
    for (const [i, r] of o.result.colonies.entries()) {
      const before = befores[i], after = o.state.colonies.find((c: Any) => c.id === r.colony_id);
      const rep = replayEngineColonyDay(before, after, r.events, o.day, sourceIds(s));
      seqs.push(JSON.stringify(engineTransfers(r.events)));
      if (!collect) continue;
      assert.ok(rep.ok, `E ${label} day ${o.day} ${r.colony_id}: ${rep.errors.slice(0, 3).join(' | ')}`); checks++;
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
  const coll = (site: string) => [{ type: 'food_transfer', transfer_id: 'FT-1-C-1', colony: 'C', source: { kind: 'source', id: site }, recipient: { kind: 'in_transit', id: 'W1' }, food_type: 'sugar', portions: 0.5 }] as Any;
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
    const ev: Any[] = [{ type: 'food_transfer', transfer_id: 'FT-1-' + w.colonies[0].id + '-1', colony: w.colonies[0].id, cause: 'collect', source: { kind: 'source', id: site }, recipient: { kind: 'in_transit', id: 'B-W90' }, food_type: 'sugar', portions: 0.5 }];
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

// ---------------------------------------------------------------- T: determinism
if (!ONLY || ONLY.includes('T')) {
  const a = runWorld(buildDay0('A1' as Any, 7, '2027-09-23', b).state, 20, 'T', false), z = runWorld(buildDay0('A1' as Any, 7, '2027-09-23', b).state, 20, 'T', false);
  ok(JSON.stringify(a) === JSON.stringify(z) && a.join('').length > 1000, 'T: the same input gives a byte-identical food_transfer sequence');
}
console.log(JSON.stringify({ checks, engine_version: ENGINE_VERSION, ...stats, note: 'engineering checks only; F01/A08 remain (metabolism, eggs and overflow still taken from the colony ledger, attribution unknown); worker-array order of settlement draws and contact choice is Issue #56' }, null, 2));
