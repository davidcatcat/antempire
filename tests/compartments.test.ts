/**
 * Work package C1 (docs/design-wpc-food-compartments.md §6) after Issue #49 N2: food_transfer records are replayed
 * COMPARTMENT BY COMPARTMENT from the start snapshot (cli/lib/compartments.ts replayTransfers); a ledger total that
 * happens to close is not accepted as proof of the transfer path. Diagnostic only; the engine is unchanged.
 *  N2  Issue #49 Appendix B: one collection + one delivery credit the crop ONCE; the old double-credit path is rejected.
 *  S   synthetic sequences: several carriers at once, multiple sources, two-worker trophallaxis, trophallaxis without the
 *      donor holding food (no contact possible), trophallaxis away from the nest, sugar and protein carried separately,
 *      carrier dies in transit, unloading missing, the same event input twice, transport across a day boundary,
 *      a source holding too little.
 *  E   the current engine (v2-review.20 on main): 5 foundings × 4 seasons × 45 days; every colony-day replayed —
 *      physical transfers verified, nest ledger exact, the unattributed (F01/A08) use reported per food type.
 *  T8  replay determinism; transfer ids unique across all days.
 * The v19 run of the first C1 version (858 colony-days, totals only) is history: it did not check the transfer path and
 * is NOT evidence for this version.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { ENGINE_VERSION, simulateWorldDay } from '../engine/index.ts';
import { dayTransfers, replayColonyDay, replayTransfers, type Compartments, type FoodTransfer } from '../cli/lib/compartments.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const C = { id: 'C1', nest_node: 'N00' }, U = 1_000_000;
/** Replay a synthetic event list with explicit start/end compartments (sources checked). */
const synth = (events: Any[], start: Compartments, end: Compartments, ledgerStart = { sugar: 0, protein: 0 }, ledgerEnd = { sugar: 0, protein: 0 }, summary: Any = {}) => {
  const { transfers, ledger } = dayTransfers(events, summary, C, 1);
  const workerOrder = Object.keys(start).filter((k) => k.startsWith('crop:')).map((k) => k.slice(5)).sort();
  return { transfers, ledger, r: replayTransfers(start, transfers, ledger, end, { nest: 'N00', colony: 'C1', workerOrder, ledgerStart, ledgerEnd, checkSources: true }) };
};
const comp = (x: Record<string, [number, number]>): Compartments => Object.fromEntries(Object.entries(x).map(([k, [s, p]]) => [k, { sugar: s * U, protein: p * U }]));

// ---------------------------------------------------------------- N2: Issue #49 Appendix B
{
  const events = [{ type: 'food_collected', worker: 'W1', site: 'F1', macro: 'sugar', portions: 1, minute: 1 }, { type: 'food_delivered', worker: 'W1', site: 'F1', macro: 'sugar', portions: 1, minute: 2 }];
  const { transfers, r } = synth(events, comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0] }), { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
  const credits = transfers.filter((x) => x.recipient.kind === 'crop').reduce((a, x) => a + x.amount_microportions, 0);
  ok(credits === U, `N2: the crop is credited once (${credits} µp, was 2,000,000)`);
  ok(transfers[0].recipient.kind === 'in_transit' && transfers[1].source.kind === 'in_transit', 'N2: collection goes source → in_transit, unloading in_transit → crop');
  ok(r.physical_verified && r.replayed['crop:W1'].sugar === U, `N2: replay verifies every compartment (${r.errors.join('; ')})`);
  ok(new Set(transfers.map((x) => x.transfer_id)).size === transfers.length && transfers.every((x) => /^FT-1-C1-\d+$/.test(x.transfer_id)), 'N2: global transfer ids');
  // the first C1 version's path (collect straight into the crop AND unload into the crop) must be rejected by the replay
  const old: FoodTransfer[] = transfers.map((x) => ({ ...x, ...(x.cause === 'collect' ? { recipient: { kind: 'crop' as const, id: 'W1' } } : {}), ...(x.cause === 'unload' ? { source: { kind: 'external' as const, id: 'in_transit:W1' } } : {}) }));
  const bad = replayTransfers(comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), old, [], comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0] }), { nest: 'N00', colony: 'C1', workerOrder: ['W1'], ledgerStart: { sugar: 0, protein: 0 }, ledgerEnd: { sugar: 0, protein: 0 }, checkSources: true });
  ok(!bad.physical_verified, `N2: the double-credit path is rejected (${bad.errors.slice(0, 2).join('; ')})`);
}

// ---------------------------------------------------------------- S: synthetic sequences
const col = (w: string, site: string, macro: string, p: number, m: number) => ({ type: 'food_collected', worker: w, site, macro, portions: p, minute: m });
const del = (w: string, site: string, macro: string, p: number, m: number) => ({ type: 'food_delivered', worker: w, site, macro, portions: p, minute: m, location: 'N00' });
const tro = (from: string, to: string, p: number, location = 'N00') => ({ type: 'trophallaxis', from, to, macro: 'sugar', portions: p, location });
{ // several carriers at once from two sources, interleaved; sugar and protein separately
  const ev = [col('W1', 'F1', 'sugar', 0.5, 1), col('W2', 'F1', 'sugar', 0.25, 1.5), col('W3', 'F7', 'protein', 0.75, 2), { type: 'protein_cached_at_nest', worker: 'W3', site: 'F7', portions: 0.75 }, del('W3', 'F7', 'protein', 0.75, 9), del('W2', 'F1', 'sugar', 0.25, 10), del('W1', 'F1', 'sugar', 0.5, 11)];
  const { r, transfers, ledger } = synth(ev, comp({ 'source:F1': [2, 0], 'source:F7': [0, 3], 'crop:W1': [0, 0], 'crop:W2': [0, 0], 'crop:W3': [0, 0], 'cache:N00': [0, 0] }), comp({ 'source:F1': [1.25, 0], 'source:F7': [0, 2.25], 'crop:W1': [0.5, 0], 'crop:W2': [0.25, 0], 'crop:W3': [0, 0], 'cache:N00': [0, 0.75] }), { sugar: 0, protein: 0 }, { sugar: 0.75 * U, protein: 0.75 * U });
  ok(r.physical_verified, `S multi-carrier / multi-source / sugar+protein: verified (${r.errors.join('; ')})`);
  ok(transfers.filter((x) => x.cause === 'unload' && x.food_type === 'protein').length === 1 && transfers.find((x) => x.food_type === 'protein' && x.cause === 'unload')?.event_ids.length === 2, 'S: protein caching logged by two engine events is ONE transfer (no second income)');
  ok(ledger.filter((x) => x.direction === 'in').length === 3, 'S: three ledger entries for three deliveries (accounting, kept apart from transfers)');
}
{ // two-worker trophallaxis inside a handoff (engine logs trophallaxis BEFORE food_delivered; the unload comes first)
  const ev = [col('W1', 'F1', 'sugar', 1, 1), tro('W1', 'W2', 0.4), tro('W1', 'W3', 0.1), del('W1', 'F1', 'sugar', 1, 5)];
  const { r, transfers } = synth(ev, comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0], 'crop:W2': [0, 0], 'crop:W3': [0, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [0.5, 0], 'crop:W2': [0.4, 0], 'crop:W3': [0.1, 0] }), { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
  ok(r.physical_verified, `S trophallaxis: verified (${r.errors.join('; ')})`);
  ok(transfers.map((x) => x.cause).join() === 'collect,unload,trophallaxis,trophallaxis', `S trophallaxis: unloading precedes the handoff's trophallaxis (${transfers.map((x) => x.cause).join()})`);
  ok(transfers.filter((x) => x.cause === 'trophallaxis').every((x) => x.contact_evidence === 'trophallaxis_event_only'), 'S trophallaxis: contact evidence is stated as the trophallaxis event itself (no separate contact event)');
}
const rejected = (name: string, ev: Any[], start: Compartments, end: Compartments, re: RegExp, ls = { sugar: 0, protein: 0 }, le = { sugar: 0, protein: 0 }) => {
  const { r } = synth(ev, start, end, ls, le);
  ok(!r.physical_verified && r.errors.some((e) => re.test(e)), `S ${name}: rejected (${r.errors.slice(0, 2).join('; ') || 'NOT DETECTED'})`);
};
rejected('trophallaxis without food in the donor (no possible contact)', [tro('W1', 'W2', 0.3)], comp({ 'crop:W1': [0, 0], 'crop:W2': [0, 0] }), comp({ 'crop:W1': [0, 0], 'crop:W2': [0.3, 0] }), /cannot give/);
rejected('trophallaxis away from the nest', [tro('W1', 'W2', 0.3, 'F1')], comp({ 'crop:W1': [1, 0], 'crop:W2': [0, 0] }), comp({ 'crop:W1': [0.7, 0], 'crop:W2': [0.3, 0] }), /not where both workers are/);
rejected('carrier dies in transit', [col('W1', 'F1', 'sugar', 1, 1), { type: 'worker_death', id: 'W1' }], comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [0, 0] }), /still in transit/);
rejected('unloading missing', [col('W1', 'F1', 'protein', 1, 1)], comp({ 'source:F1': [0, 1], 'cache:N00': [0, 0] }), comp({ 'source:F1': [0, 0], 'cache:N00': [0, 0] }), /still in transit/);
rejected('the same delivery input twice', [col('W1', 'F1', 'sugar', 1, 1), del('W1', 'F1', 'sugar', 1, 2), del('W1', 'F1', 'sugar', 1, 2)], comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0] }), /in_transit:W1 holds 0/, { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
rejected('the same collection input twice', [col('W1', 'F1', 'sugar', 1, 1), col('W1', 'F1', 'sugar', 1, 1), del('W1', 'F1', 'sugar', 1, 2)], comp({ 'source:F1': [2, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [1, 0], 'crop:W1': [1, 0] }), /still in transit|source:F1: replay/, { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
rejected('a source holding too little', [col('W1', 'F1', 'sugar', 1, 1), del('W1', 'F1', 'sugar', 1, 2)], comp({ 'source:F1': [0.5, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0] }), /source:F1 holds 500000/);
rejected('food appearing without a transfer', [], comp({ 'crop:W1': [0, 0] }), comp({ 'crop:W1': [0.2, 0] }), /appeared without a transfer/);
{ // transport across a day boundary: day 1 ends with the load in transit (the end snapshot carries it), day 2 delivers it.
  // SYNTHETIC ONLY: the engine itself never ends a day with a worker outside (activityDay throws), so colonyCompartments
  // never contains in_transit; this checks that the replay API would carry such a load correctly if a future clock allows it.
  const d1 = synth([col('W1', 'F1', 'sugar', 1, 359)], comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [0, 0], 'in_transit:W1': [1, 0] }));
  const d2 = synth([del('W1', 'F1', 'sugar', 1, 3)], comp({ 'source:F1': [0, 0], 'crop:W1': [0, 0], 'in_transit:W1': [1, 0] }), comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0], 'in_transit:W1': [0, 0] }), { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
  ok(d1.r.physical_verified && d2.r.physical_verified, `S cross-day transport: carried in transit over the day boundary, delivered once (${[...d1.r.errors, ...d2.r.errors].join('; ')})`);
  const lost = synth([del('W1', 'F1', 'sugar', 1, 3)], comp({ 'crop:W1': [0, 0] }), comp({ 'crop:W1': [1, 0] }), { sugar: 0, protein: 0 }, { sugar: U, protein: 0 });
  ok(!lost.r.physical_verified, 'S cross-day transport: a delivery whose load was never carried in is rejected');
}
{ // unattributed settlement: labelled unknown, checked at pool level only, never given an invented source
  const summary = { mass_ledger: { metabolized: { sugar: 0.3, protein: 0 }, storage_overflow_not_retained: { sugar: 0, protein: 0 } } };
  const { r, transfers } = synth([], comp({ 'crop:W1': [0.5, 0], 'nest_unlocated:C1': [0.5, 0] }), comp({ 'crop:W1': [0.2, 0], 'nest_unlocated:C1': [0.5, 0] }), { sugar: U, protein: 0 }, { sugar: 0.7 * U, protein: 0 }, summary);
  const m = transfers.find((x) => x.cause === 'metabolism');
  ok(m?.attribution === 'unknown' && m.source.kind === 'colony_ledger_aggregate', 'S settlement: metabolism has attribution unknown and the aggregate as its source');
  ok(r.physical_verified && r.unattributed.sugar === 0.3 * U && r.unattributed_by_compartment['crop:W1']?.sugar === 0.3 * U, `S settlement: replayed with the engine's rule; the 0.3 taken from W1's crop is reported as unattributed (${JSON.stringify(r.unattributed_by_compartment)})`);
  ok(r.engine_abstractions_used.includes('settlement_from_crops_in_worker_array_order'), 'S settlement: the engine abstraction it relied on is reported');
}
// ---------------------------------------------------------------- R: independent review of f7aba02 (reproductions)
{ // C: the engine moved 0.3 W1 -> W3 and settlement then drained W3; the record says W1 -> W2. C': the trophallaxis record is missing.
  const summary = { mass_ledger: { metabolized: { sugar: 0.3, protein: 0 }, storage_overflow_not_retained: { sugar: 0, protein: 0 } } };
  const start = comp({ 'crop:W1': [1, 0], 'crop:W2': [0, 0], 'crop:W3': [0, 0], 'nest_unlocated:C1': [0, 0] });
  const end = comp({ 'crop:W1': [0.4, 0], 'crop:W2': [0, 0], 'crop:W3': [0.3, 0], 'nest_unlocated:C1': [0, 0] }); // engine: W1 gave 0.3 to W3, metabolism took 0.3 from W1 (array order)
  const right = synth([tro('W1', 'W3', 0.3)], start, end, { sugar: U, protein: 0 }, { sugar: 0.7 * U, protein: 0 }, summary);
  ok(right.r.physical_verified, `R: the true path (W1 -> W3, then settlement in array order) is verified (${right.r.errors.join('; ')})`);
  const wrong = synth([tro('W1', 'W2', 0.3)], start, end, { sugar: U, protein: 0 }, { sugar: 0.7 * U, protein: 0 }, summary);
  ok(!wrong.r.physical_verified && wrong.r.errors.some((e) => /crop:W(2|3)/.test(e)), `R (repro C): a trophallaxis credited to the wrong worker is rejected (${wrong.r.errors.slice(0, 2).join('; ')})`);
  const missing = synth([], start, end, { sugar: U, protein: 0 }, { sugar: 0.7 * U, protein: 0 }, summary);
  ok(!missing.r.physical_verified, `R (repro C'): a missing trophallaxis is rejected (${missing.r.errors.slice(0, 2).join('; ')})`);
}
{ // B: an extra transfer from an untracked 'external' source, and ledger entries that disagree with the transfers
  const { transfers, ledger } = dayTransfers([col('W1', 'F1', 'sugar', 1, 1), del('W1', 'F1', 'sugar', 1, 2)], {}, C, 1);
  const extra: FoodTransfer = { ...transfers[1], transfer_id: 'FT-X', source: { kind: 'external', id: 'x' } };
  const r1 = replayTransfers(comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), [...transfers, extra], ledger, comp({ 'source:F1': [0, 0], 'crop:W1': [2, 0] }), { nest: 'N00', colony: 'C1', workerOrder: ['W1'], ledgerStart: { sugar: 0, protein: 0 }, ledgerEnd: { sugar: U, protein: 0 }, checkSources: true });
  ok(!r1.physical_verified && r1.errors.some((e) => /cannot come from external/.test(e)), `R (repro B): food from an untracked source is rejected (${r1.errors[0]})`);
  const r2 = replayTransfers(comp({ 'source:F1': [1, 0], 'crop:W1': [0, 0] }), transfers, [], comp({ 'source:F1': [0, 0], 'crop:W1': [1, 0] }), { nest: 'N00', colony: 'C1', workerOrder: ['W1'], ledgerStart: { sugar: 0, protein: 0 }, ledgerEnd: { sugar: 0, protein: 0 }, checkSources: true });
  ok(!r2.physical_verified && r2.errors.some((e) => /ledger records 0/.test(e)), `R (repro B): an unload with no ledger entry is rejected (${r2.errors[0]})`);
}
rejected('trophallaxis to a worker carrying a load outside (repro D)', [col('W2', 'F1', 'sugar', 0.2, 1), tro('W1', 'W2', 0.3)], comp({ 'source:F1': [1, 0], 'crop:W1': [1, 0], 'crop:W2': [0, 0] }), comp({ 'source:F1': [0.8, 0], 'crop:W1': [0.7, 0], 'crop:W2': [0.3, 0], 'in_transit:W2': [0.2, 0] }), /while carrying a load outside/);
{ // E: a dead worker's crop sugar stays in the nest ledger — replayed exactly, and reported as an engine abstraction
  const { r } = synth([{ type: 'worker_death', id: 'W2' }], comp({ 'crop:W1': [0, 0], 'crop:W2': [0.4, 0], 'nest_unlocated:C1': [0.1, 0] }), comp({ 'crop:W1': [0, 0], 'nest_unlocated:C1': [0.5, 0] }), { sugar: 0.5 * U, protein: 0 }, { sugar: 0.5 * U, protein: 0 });
  ok(r.physical_verified && r.dead_worker_crops_to_ledger.includes('crop:W2') && r.engine_abstractions_used.includes('dead_worker_crop_kept_in_nest_ledger'), `R (repro E): the dead worker's crop goes to the unlocated nest sugar by an explicit transfer, reported as an engine abstraction (${r.errors.join('; ')})`);
  ok(r.resolved.some((x) => x.cause === 'death' && x.amount_microportions === 0.4 * U), 'R (repro E): the death transfer records the amount moved');
}

// ---------------------------------------------------------------- E: the current engine, every colony-day replayed
const b = loadBundle();
let days = 0, troph = 0, deaths = 0;
const unattributed = { sugar: 0, protein: 0 };
const allIds = new Set<string>();
const runDays = (sc: string, seed: number, season: string, n: number, collect = true) => {
  let s: Any = buildDay0(sc as Any, seed, season, b).state; const out: Any[] = [];
  for (let d = 0; d < n; d++) {
    const before = structuredClone(s.colonies[0]), o: Any = simulateWorldDay(s, b), after = o.state.colonies[0], r = o.result.colonies[0];
    const rep = replayColonyDay(before, after, r.events, r.summary, o.day);
    out.push(rep.transfers);
    if (collect) {
      days++;
      assert.ok(rep.physical_verified && rep.ledger_only_closed, `E ${sc}/${seed}/${season} day ${o.day}: ${rep.errors.slice(0, 3).join(' | ')}`); checks++;
      for (const x of rep.transfers) { assert.ok(!allIds.has(x.transfer_id), `T8: transfer id ${x.transfer_id} reused`); allIds.add(x.transfer_id); if (x.cause === 'trophallaxis') troph++; if (x.attribution === 'unknown') unattributed[x.food_type] += x.amount_microportions; }
      deaths += rep.dead_worker_crops_to_ledger.length;
      assert.equal(rep.sources_checked, false, 'real engine days: sources are not balance-checked (stated in the result)'); checks++;
    }
    s = o.state;
    if (!after.population.queen_alive && !after.population.workers.length) break;
  }
  return out;
};
for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const [seed, season] of [[1, '2027-09-23'], [2, '2027-03-21'], [3, '2027-06-21'], [4, '2027-12-22']] as const) { allIds.clear(); runDays(sc, seed, season, 45); }
ok(days > 600 && troph > 500, `E (${ENGINE_VERSION}): ${days} colony-days, every transfer replayed per compartment and the nest ledger exact; ${troph} trophallaxis transfers; ${deaths} dead workers' crops kept in the ledger (engine abstraction)`);
// T8 replay determinism
const a = JSON.stringify(runDays('A1', 7, '2027-09-23', 20, false)), z = JSON.stringify(runDays('A1', 7, '2027-09-23', 20, false));
ok(a === z && a.length > 100, 'T8: the same input gives a byte-identical food_transfer sequence');
console.log(JSON.stringify({ checks, engine_version: ENGINE_VERSION, colony_days: days, trophallaxis_transfers: troph, known_defect_F01_A08: { note: 'nest-settlement use (metabolism, eggs, overflow) with attribution unknown: the engine takes it from the aggregate ledger; C2–C5 must give every use an individual source', unattributed_microportions: unattributed } }, null, 2));
