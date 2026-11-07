/**
 * C3a feeding rule (Codex 2026-11-07): per-compartment closure shows that no food appeared or vanished; it does not show that
 * each feed_queen followed the rule. A legal 0.28-portion sugar feeding changed to 0.33, with the nurse's crop, the queen's
 * account and the nest ledger edited to match, passed every check (reproduced here as F1 before the fix, both configurations).
 * The engine contract of C3a at each queen_contact, per food (engine/queen-feeding.ts nestRound):
 *   nurse holds none -> nothing; queen satiated by HER OWN known balance (≥ queen_satiation_days_of_need × daily need)
 *   -> one queen_feeding_refused; otherwise exactly one feed_queen of min(held, feed_max_portions_per_contact);
 *   contacts in ordinal order, ties by worker ID.
 * Both the engine check (checkQueenRound -> checkFeedingRule) and the independent reader (cli/lib/queen-round-replay.ts)
 * replay the crops and the queen's balance record by record. Configurations: C3a only, and C3a + C4a.
 * This validates the existing engineering rule; it is NOT a claim that P. megacephala workers feed queens by this formula
 * (candidate route, D). No threshold, bolus or contact probability is changed.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { colonySnapshot, checkColonyFood } from '../engine/transfers.ts';
import { checkQueenRound, queenRoundStart, expectedInitBasis } from '../engine/queen-feeding.ts';
import { checkLarvaRound, ensureBroodRecords, larvaRoundStart } from '../engine/larva-feeding.ts';
import { replayEngineColonyDay } from '../cli/lib/engine-transfers.ts';
import { replayQueenRound } from '../cli/lib/queen-round-replay.ts';
import { replayLarvaRound } from '../cli/lib/larva-round-replay.ts';
import { MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
const evidence: Record<string, unknown> = {};

interface Day { s0: Any; o: Any; c4a: boolean; raw: Any; sp: Any }
const engine = (d: Day, ev: Any[], after: Any): string => {
  const pre: Any = structuredClone(d.s0.colonies[0]), day0 = expectedInitBasis(d.s0) === 'day0_scenario';
  const had = d.c4a ? ensureBroodRecords(pre, day0, []) : null;
  try {
    checkColonyFood(colonySnapshot(pre, true, d.c4a), after, ev, 'timed');
    checkQueenRound(queenRoundStart(pre, !!d.s0.colonies[0].population.queens, expectedInitBasis(d.s0)), after, ev, d.sp);
    if (d.c4a) checkLarvaRound(larvaRoundStart(pre, d.sp, had as Set<string>, day0), after, ev, d.sp, Number(after.last_report.metabolic_factor));
    return '';
  } catch (e) { return String(e); }
};
const readers = (d: Day, ev: Any[], after: Any): string[] => [
  ...replayEngineColonyDay(d.s0.colonies[0], after, ev, d.o.day, new Set(Object.keys(d.s0.sources)), 'timed', true, d.c4a).errors,
  ...replayQueenRound(d.s0.colonies[0], after, ev, d.raw, d.s0).errors,
  ...(d.c4a ? replayLarvaRound(d.s0.colonies[0], after, ev, d.raw, d.s0, d.o.result.weather.nest_temp_model_c).errors : []),
];
const renumber = (d: Day, ev: Any[]) => { let n = 0; for (const e of ev) if (e.type === 'food_transfer') e.transfer_id = `FT-${d.o.day}-${d.s0.colonies[0].id}-${++n}`; };
/** Move `delta` sugar portions from the queen's account back into the nurse's crop and the nest ledger (end state and records). */
const shiftSugar = (ev: Any[], after: Any, worker: string, delta: number) => {
  const w = after.population.workers.find((x: Any) => x.id === worker); if (w) w.crop_cargo_sugar = r6((w.crop_cargo_sugar || 0) + delta);
  const q = after.population.queens[0]; q.body.known_balance.sugar = r6(q.body.known_balance.sugar - delta); after.stores.sugar = r6(after.stores.sugar + delta);
  const qn = ev.find((e) => e.type === 'queen_nutrition'); if (qn) qn.known_balance.sugar = q.body.known_balance.sugar;
};
/** A sugar feeding after which its nurse moves no more sugar that day (so the edit is invisible to closure). */
const quietSugarFeed = (d: Day) => { const ev = d.o.result.colonies[0].events; return ev.find((e: Any) => e.cause === 'feed_queen' && e.food_type === 'sugar' && e.portions === 0.28 && (d.o.state.colonies[0].population.workers.find((w: Any) => w.id === e.source.id)?.crop_cargo_sugar ?? 0) >= 0.05 && !ev.some((x: Any, i: number) => i > ev.indexOf(e) && x.type === 'food_transfer' && x.food_type === 'sugar' && (x.source.id === e.source.id || x.recipient.id === e.source.id))); };

for (const c4a of [false, true]) {
  const label = c4a ? 'C3a+C4a' : 'C3a only';
  const b: Any = structuredClone(loadBundle()); b.species[MAIN_SPECIES].queen_feeding.individual_queen_body_c3a = true; b.species[MAIN_SPECIES].larval_feeding.individual_larva_body_c4a = c4a;
  const raw = b.species[MAIN_SPECIES], sp = resolveBundle(b).species[MAIN_SPECIES] as Any;
  // real days; one run starts with a satiated queen so that refusals occur (a constructed start state, not a rule change)
  const days: Day[] = [];
  const run = (s0: Any, n: number) => { let s = s0; for (let k = 0; k < n; k++) { const o: Any = simulateWorldDay(s, b); days.push({ s0: s, o, c4a, raw, sp }); s = o.state; } };
  for (const f of ['A1', 'A3', 'A5']) run(buildDay0(f as Any, 3, '2027-03-21', b).state, 60);
  { let s: Any = buildDay0('A1' as Any, 3, '2027-09-23', b).state; s = simulateWorldDay(s, b).state; s.colonies[0].population.queens[0].body.known_balance = { sugar: 5, protein: 5 }; run(s, 30); }
  let feeds = 0, refusals = 0, bad = 0;
  for (const d of days) { const ev = d.o.result.colonies[0].events; feeds += ev.filter((e: Any) => e.cause === 'feed_queen').length; refusals += ev.filter((e: Any) => e.type === 'queen_feeding_refused').length; if (readers(d, ev, d.o.state.colonies[0]).length) bad++; }
  ok(bad === 0 && feeds > 0 && refusals > 0, `${label}: positive control — the readers accept all ${days.length} real days with ${feeds} feedings and ${refusals} refusals (the engine checks them while it runs)`);
  evidence[label] = { days: days.length, feedings: feeds, refusals };

  const forge = (name: string, d: Day | undefined, edit: (ev: Any[], after: Any) => void, engineWant = /QUEEN_FEEDING/) => {
    if (!d) { ok(true, `${label} ${name}: no suitable real day (not exercised; stated)`); return; }
    const ev: Any[] = structuredClone(d.o.result.colonies[0].events), after: Any = structuredClone(d.o.state.colonies[0]);
    ok(engine(d, ev, after) === '' && readers(d, ev, after).length === 0, `${label} ${name}: the unmodified day is accepted`);
    edit(ev, after);
    const e = engine(d, ev, after), r = readers(d, ev, after);
    ok(engineWant.test(e), `${label} ${name}: rejected by the engine (${e.slice(0, 120)})`);
    ok(r.length > 0, `${label} ${name}: rejected by the readers (${String(r[0]).slice(0, 120)})`);
  };
  const quiet = days.find((d) => d.o.day >= 3 && quietSugarFeed(d));
  forge('F1 overfeeding 0.28 -> 0.33 with crop, queen account and ledger edited (Codex case)', quiet, (ev, after) => { const f = ev.find((x) => x.transfer_id === quietSugarFeed(quiet as Day).transfer_id); f.portions = 0.33; f.nest_ledger_delta = -0.33; shiftSugar(ev, after, f.source.id, -0.05); });
  forge('F2 underfeeding 0.28 -> 0.20 with the state edited', quiet, (ev, after) => { const f = ev.find((x) => x.transfer_id === quietSugarFeed(quiet as Day).transfer_id); f.portions = 0.2; f.nest_ledger_delta = -0.2; shiftSugar(ev, after, f.source.id, 0.08); });
  forge('F3 a due feeding dropped (the queen is not satiated, the nurse holds sugar)', quiet, (ev, after) => { const f = ev.find((x) => x.transfer_id === quietSugarFeed(quiet as Day).transfer_id); ev.splice(ev.indexOf(f), 1); renumber(quiet as Day, ev); shiftSugar(ev, after, f.source.id, 0.28); });
  forge('F5 a refusal instead of a due feeding', quiet, (ev, after) => { const f = ev.find((x) => x.transfer_id === quietSugarFeed(quiet as Day).transfer_id), i = ev.indexOf(f); ev.splice(i, 1, { type: 'queen_feeding_refused', contact_event_id: f.contact.contact_event_id, worker: f.source.id, queen: f.recipient.id, food_type: 'sugar', ordinal: f.ordinal, reason: 'queen own known balance at the satiation threshold (D)', assumption: true }); renumber(quiet as Day, ev); shiftSugar(ev, after, f.source.id, 0.28); });
  // a satiated queen: a refusal turned into a feeding (crop, account and ledger edited to match)
  const satDay = days.find((d) => d.o.day >= 2 && d.o.result.colonies[0].events.some((e: Any) => e.type === 'queen_feeding_refused' && e.food_type === 'sugar' && !d.o.result.colonies[0].events.some((x: Any, i: number, a: Any[]) => i > a.indexOf(e) && x.type === 'food_transfer' && x.food_type === 'sugar' && (x.source.id === e.worker || x.recipient.id === e.worker)) && (d.o.state.colonies[0].population.workers.find((w: Any) => w.id === e.worker)?.crop_cargo_sugar ?? 0) >= 0.01));
  forge('F4 feeding a queen that her own balance shows satiated', satDay, (ev, after) => {
    const rf = ev.find((e) => e.type === 'queen_feeding_refused' && e.food_type === 'sugar' && !ev.some((x, i) => i > ev.indexOf(e) && x.type === 'food_transfer' && x.food_type === 'sugar' && (x.source.id === e.worker || x.recipient.id === e.worker))), held = after.population.workers.find((w: Any) => w.id === rf.worker).crop_cargo_sugar, a = r6(Math.min(held, 0.28));
    ev.splice(ev.indexOf(rf), 1, { type: 'food_transfer', schema: 'antempire.food-transfer.v1', transfer_id: 'tmp', day: (satDay as Day).o.day, colony: after.id, minute: null, ordinal: rf.ordinal, phase: 'nest_round', source: { kind: 'crop', id: rf.worker }, recipient: { kind: 'queen_body', id: rf.queen }, food_type: 'sugar', portions: a, cause: 'feed_queen', attribution: 'individual', nest_ledger_delta: -a, contact: { contact_event_id: rf.contact_event_id, worker: rf.worker, queen: rf.queen, location: 'queen' } });
    renumber(satDay as Day, ev); shiftSugar(ev, after, rf.worker, -a);
  });
  forge('F7 two refusals in one contact', satDay, (ev) => { const rf = ev.find((e) => e.type === 'queen_feeding_refused'); ev.splice(ev.indexOf(rf) + 1, 0, structuredClone(rf)); });
  // F8 (Codex review 2026-11-07): interleaving — a later contact recorded before an earlier contact's feeding, so that the
  // satiation judged at the later contact ignores the earlier feeding; the later refusal is turned into a feeding
  const nearSat: Day | undefined = (() => {
    const need = sp.nutrition.queen_sugar_daily, thr = sp.queen_feeding.queen_satiation_days_of_need * need;
    let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', b).state;
    for (let k = 0; k < 120; k++) {
      if (!s.colonies[0].population.queens?.[0] || !s.colonies[0].population.queen_alive) { s = simulateWorldDay(s, b).state; continue; }
      const t: Any = structuredClone(s); t.colonies[0].population.queens[0].body.known_balance = { sugar: Math.round((thr - 0.05) * 1e6) / 1e6, protein: 5 };
      const o: Any = simulateWorldDay(t, b), ev = o.result.colonies[0].events;
      const f1 = ev.find((e: Any) => e.cause === 'feed_queen' && e.food_type === 'sugar'), r2 = f1 && ev.find((e: Any, i: number) => i > ev.indexOf(f1) && e.type === 'queen_feeding_refused' && e.food_type === 'sugar' && !ev.some((x: Any, j: number) => j > i && x.type === 'food_transfer' && x.food_type === 'sugar' && (x.source.id === e.worker || x.recipient.id === e.worker)));
      if (k >= 1 && f1 && r2) return { s0: t, o, c4a, raw, sp };
      s = simulateWorldDay(s, b).state;
    }
    return undefined;
  })();
  forge('F8 interleaved records: a later contact before an earlier feeding, its refusal turned into a feeding', nearSat, (ev, after) => {
    const f1 = ev.find((e) => e.cause === 'feed_queen' && e.food_type === 'sugar'), rf = ev.find((e, i) => i > ev.indexOf(f1) && e.type === 'queen_feeding_refused' && e.food_type === 'sugar' && !ev.some((x, j) => j > i && x.type === 'food_transfer' && x.food_type === 'sugar' && (x.source.id === e.worker || x.recipient.id === e.worker)));
    const c2 = ev.find((e) => e.type === 'queen_contact' && e.contact_event_id === rf.contact_event_id);
    const held = (nearSat as Day).o.state.colonies[0].population.workers.find((w: Any) => w.id === rf.worker).crop_cargo_sugar, a = r6(Math.min(held, 0.28));
    ev.splice(ev.indexOf(rf), 1, { type: 'food_transfer', schema: 'antempire.food-transfer.v1', transfer_id: 'tmp', day: (nearSat as Day).o.day, colony: after.id, minute: null, ordinal: rf.ordinal, phase: 'nest_round', source: { kind: 'crop', id: rf.worker }, recipient: { kind: 'queen_body', id: rf.queen }, food_type: 'sugar', portions: a, cause: 'feed_queen', attribution: 'individual', nest_ledger_delta: -a, contact: { contact_event_id: rf.contact_event_id, worker: rf.worker, queen: rf.queen, location: 'queen' } });
    // move the later contact (and its new feeding) to just before the earlier feeding: contact1, contact2, feed1, feed2
    const fd2 = ev.find((e) => e.cause === 'feed_queen' && e.contact?.contact_event_id === rf.contact_event_id);
    ev.splice(ev.indexOf(c2), 1); ev.splice(ev.indexOf(fd2), 1);
    const at = ev.indexOf(f1); ev.splice(at, 0, c2); ev.splice(ev.indexOf(f1) + 1, 0, fd2);
    fd2.ordinal = c2.ordinal; // every time stays as recorded; only the order of the records changes
    renumber(nearSat as Day, ev); shiftSugar(ev, after, rf.worker, -a);
  });
  const twoContacts = days.find((d) => d.o.day >= 2 && d.o.result.colonies[0].events.filter((e: Any) => e.type === 'queen_contact').length >= 2);
  forge('F6 two contacts recorded out of ordinal order', twoContacts, (ev) => { const cs = ev.filter((e) => e.type === 'queen_contact'), i = ev.indexOf(cs[0]), j = ev.indexOf(cs[1]); [ev[i], ev[j]] = [ev[j], ev[i]]; }, /QUEEN_FEEDING|FOOD_TRANSFER/);
}

console.log(JSON.stringify({ test: 'c3a-feed-rule', checks, evidence, note: 'engineering check of the existing C3a feeding rule (candidate route, D); not a biological claim' }, null, 2));
