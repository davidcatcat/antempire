/**
 * Work package C1 (docs/design-wpc-food-compartments.md §6): food compartments and food_transfer bookkeeping over the
 * engine's existing output. Diagnostic only — the engine is unchanged (cli/lib/compartments.ts is not read by the
 * simulation; the rules fingerprint and golden outputs are identical). Checks:
 *  T3  every colony-day: food held by the colony (crops + unlocated nest sugar + nest protein cache) at the end equals
 *      the start + deliveries − metabolism − egg costs − overflow, EXACTLY in integer micro-portions;
 *  —   the compartments cover the nest ledger exactly and none is negative (crops are a subset of the ledger);
 *  —   every trophallaxis is an individual→individual transfer with its contact event;
 *  T8  replay: the same input gives a byte-identical transfer sequence.
 * It also REPORTS (does not hide) how much of the colony's food use the engine still takes from the aggregate ledger
 * with no individual source (Issue #43 F01/A08). Those are defects to be removed by C2–C5, not accepted behaviour.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { colonyCompartments, colonyConservation, dayTransfers, totalOf, toMicro, type FoodTransfer } from '../cli/lib/compartments.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle();
const runDays = (sc: string, seed: number, season: string, days: number) => {
  let s: Any = buildDay0(sc as Any, seed, season, b).state; const out: { transfers: FoodTransfer[]; conserved: boolean; detail: Any }[] = [];
  for (let d = 0; d < days; d++) {
    const c0 = s.colonies[0], start = colonyCompartments(c0);
    ok(totalOf(start, 'sugar') === toMicro(c0.stores.sugar) && totalOf(start, 'protein') === toMicro(c0.stores.protein), `${sc}/${seed} day ${d}: compartments cover the ledger exactly`);
    const o: Any = simulateWorldDay(s, b), c = o.state.colonies[0], r = o.result.colonies[0];
    const transfers = dayTransfers(r.events, r.summary, c, o.day), k = colonyConservation(start, colonyCompartments(c), transfers);
    out.push({ transfers, conserved: k.ok, detail: k.detail });
    s = o.state;
    if (!c.population.queen_alive && !c.population.workers.length) break;
  }
  return out;
};
let days = 0, troph = 0, aggregateOut = { sugar: 0, protein: 0 }, individualOut = { sugar: 0, protein: 0 };
for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const [seed, season] of [[1, '2027-09-23'], [2, '2027-03-21'], [3, '2027-06-21'], [4, '2027-12-22']] as const) {
  for (const day of runDays(sc, seed, season, 45)) {
    days++;
    assert.ok(day.conserved, `T3 ${sc}/${seed}: colony food not conserved in micro-portions ${JSON.stringify(day.detail)}`); checks++;
    for (const x of day.transfers) {
      if (x.cause === 'trophallaxis') { troph++; assert.ok(x.individual_attribution === 'individual' && x.source.kind === 'crop' && x.recipient.kind === 'crop' && x.contact_event_id, `trophallaxis is crop→crop with a contact ${JSON.stringify(x)}`); checks++; }
      if (x.source.kind === 'colony_ledger_aggregate') aggregateOut[x.food_type] += x.amount_microportions;
      else if (x.recipient.kind === 'loss' || x.recipient.kind === 'egg') individualOut[x.food_type] += x.amount_microportions;
    }
  }
}
ok(days > 600 && troph > 0, `T3: ${days} colony-days conserved exactly; ${troph} trophallaxis transfers individual→individual`);
// T8 replay
const a = JSON.stringify(runDays('A1', 7, '2027-09-23', 20).map((d) => d.transfers)), b2 = JSON.stringify(runDays('A1', 7, '2027-09-23', 20).map((d) => d.transfers));
ok(a === b2 && a.length > 100, 'T8: the same input gives a byte-identical food_transfer sequence');
// Report (not a target): share of the colony's food use with no individual source — F01/A08, removed by C2–C5
const share = (f: 'sugar' | 'protein') => { const tot = aggregateOut[f] + individualOut[f]; return tot ? Math.round((aggregateOut[f] / tot) * 1000) / 10 : null; };
console.log(JSON.stringify({ checks, colony_days: days, trophallaxis_transfers: troph, known_defect_F01_A08: { note: 'food used by metabolism, eggs and overflow with NO individual source (aggregate ledger); C2–C5 must bring this to 0', sugar_percent: share('sugar'), protein_percent: share('protein') } }, null, 2));
