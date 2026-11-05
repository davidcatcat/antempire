/**
 * C3a (v2-review.25; docs/design-c3-queen-feeding.md §8–§12): the queen's own nutrition compartment, fed only by local,
 * ordinal-timed events. Checked here:
 *   - real C3a days (Day0 A1–A5 × two seasons; the Day14 fixture as a migrated queen; route C on and off) are accepted by
 *     the engine (it throws otherwise) and by both independent readers (C2 replay with c3a, nest-round replay);
 *   - T2 no local event, no food; T4 every feeding has its contact; P1 one nest round is invariant to the worker array
 *     order (by ID); T5 switch off = v2-review.24 (golden and rules-isolation tests);
 *   - N1–N16: each counterexample is rejected by the engine check AND by the readers;
 *   - before C3a (switch off) the queen's food is taken from the colony pool with attribution unknown and no contact
 *     (A08) — accepted by C2 then; that is the defect C3a starts to remove.
 * Engineering correctness only. Routes B1 and C are CANDIDATES, not established mechanisms of P. megacephala; the
 * queen's deficit under the migrated (null) reserve is a conservative bound (D), not a result.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta, type WorldState } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { colonySnapshot, checkColonyFood, bindFoodTransfers } from '../engine/transfers.ts';
import { checkQueenRound, queenRoundStart, nestRound, ensureQueens } from '../engine/queen-feeding.ts';
import { replayEngineColonyDay } from '../cli/lib/engine-transfers.ts';
import { replayQueenRound } from '../cli/lib/queen-round-replay.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const bundleWith = (over: Record<string, unknown> = {}) => { const b: Any = structuredClone(loadBundle()); Object.assign(b.species[MAIN_SPECIES].queen_feeding, { individual_queen_body_c3a: true }, over); return b; };
const B = bundleWith(), BC = bundleWith({ store_is_queen_location: true });
const spOf = (b: Any) => resolveBundle(b).species[MAIN_SPECIES] as Any;
const SP = spOf(B), SPC = spOf(BC);

interface Day { before: Any; after: Any; events: Any[]; day: number; sources: Set<string>; sp: Any; raw: Any }
const engineAccepts = (d: Day) => { try { checkColonyFood(colonySnapshot(d.before, true), d.after, d.events, 'timed'); checkQueenRound(queenRoundStart(d.before), d.after, d.events, d.sp); return true; } catch (e) { return String(e); } };
const readerErrors = (d: Day) => [...replayEngineColonyDay(d.before, d.after, d.events, d.day, d.sources, 'timed', true).errors, ...replayQueenRound(d.before, d.after, d.events, d.raw).errors];

// ---------------------------------------------------------------- real C3a days
const days: Day[] = [];
let colonyDays = 0, contacts = 0, feeds = { sugar: 0, protein: 0 }, takes = 0, selfFeeds = 0, unfedNoIncrease = 0, migrated = 0;
const run = (s: WorldState, b: Any, sp: Any, n: number) => {
  for (let k = 0; k < n; k++) {
    const before = structuredClone(s.colonies[0]), o: Any = simulateWorldDay(s, b), after = o.state.colonies[0], ev = o.result.colonies[0].events;
    const d: Day = { before, after, events: ev, day: o.day, sources: new Set(Object.keys(s.sources)), sp, raw: b.species[MAIN_SPECIES] };
    if (before.population.queens) {
      const r = readerErrors(d);
      assert.equal(r.length, 0, `real day ${o.day}: the readers reject (${r.slice(0, 2).join(' | ')})`);
      colonyDays++;
      const intake = ev.filter((e: Any) => e.type === 'food_transfer' && (e.cause === 'feed_queen' || e.cause === 'queen_self_feed'));
      contacts += ev.filter((e: Any) => e.type === 'queen_contact').length; takes += ev.filter((e: Any) => e.type === 'food_transfer' && e.cause === 'take_from_cache').length;
      for (const e of intake) e.cause === 'feed_queen' ? feeds[e.food_type as 'sugar' | 'protein']++ : selfFeeds++;
      // T2: a day with no contact and no self-feeding never raises the queen's known balance
      if (!intake.length && after.population.queens) { const q0 = before.population.queens[0].body.known_balance, q1 = after.population.queens[0].body.known_balance; ok(q1.sugar <= q0.sugar && q1.protein <= q0.protein, `T2 day ${o.day}: no intake event, the queen's balance only falls`); unfedNoIncrease++; }
      if (after.population.queens?.[0]?.body.basis === 'unknown_at_migration') migrated++;
      if (days.length < 400 || (after.population.queens?.[0]?.body.basis === 'unknown_at_migration' && migrated <= 20) || (sp === SPC && selfFeeds < 40)) days.push(d);
    }
    s = o.state;
    if (!s.colonies[0].population.queen_alive && !s.colonies[0].population.workers.length) break;
  }
};
for (const sc of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const season of ['2027-03-21', '2027-09-23']) run(buildDay0(sc as Any, 1, season, B).state, B, SP, 40);
for (const sc of ['A1', 'A5']) run(buildDay0(sc as Any, 2, '2027-06-21', BC).state, BC, SPC, 30);
{ const lg: Any = fixture(); run(legacyToWorldState(lg, legacyColonyMeta(B.world.scenario_colonies as Any)), B, SP, 20); }
ok(colonyDays > 300 && contacts > 0 && feeds.sugar > 0 && feeds.protein > 0 && takes > 0 && selfFeeds > 0 && migrated > 0, `real C3a days accepted by the engine and both readers: ${colonyDays} colony-days, ${contacts} contacts, feedings ${JSON.stringify(feeds)}, ${takes} takes from the store, ${selfFeeds} self-feedings (route C, store at the queen), ${migrated} migrated-queen days`);
ok(unfedNoIncrease > 0, `T2 checked on ${unfedNoIncrease} days without any intake event`);
ok(days.every((d) => d.events.filter((e) => e.type === 'food_transfer' && e.cause === 'feed_queen').every((f) => d.events.some((c) => c.type === 'queen_contact' && c.contact_event_id === f.contact.contact_event_id && c.worker === f.source.id))), 'T4 every feed_queen names a contact of the same worker');
// the migrated queen: unknown reserve null, known balance started at 0
{ const d = days.find((x) => x.after.population.queens?.[0]?.body.basis === 'unknown_at_migration'); ok(d && d.after.population.queens[0].body.unknown_initial_reserve === null, 'N12 base case: the Day14 (migrated) queen keeps unknown_initial_reserve null'); }

// ---------------------------------------------------------------- before C3a: the queen eats from the colony pool (A08)
{
  const b: Any = structuredClone(loadBundle()); let s: Any = buildDay0('A5' as Any, 1, '2027-09-23', b).state, ev: Any[] = [], pooled: Any[] = [];
  for (let k = 0; k < 10 && !pooled.length; k++) { const o: Any = simulateWorldDay(s, b); ev = o.result.colonies[0].events; pooled = ev.filter((e: Any) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.attribution === 'unknown'); s = o.state; }
  ok(pooled.length > 0 && !ev.some((e: Any) => e.type === 'queen_contact' || (e.type === 'food_transfer' && e.recipient.kind === 'queen_body')), 'before C3a (switch off): the queen\'s share is eaten from the colony pool, attribution unknown, with no contact — and C2 accepts it (the A08 defect)');
}

// ---------------------------------------------------------------- P1: one nest round is invariant to the worker array order
{
  const s0: Any = buildDay0('A3' as Any, 3, '2027-09-23', B).state, c = s0.colonies[0];
  ensureQueens(s0, c, SP, []);
  for (const w of c.population.workers) w.task = 'nurse';
  c.population.workers[0].crop_cargo_sugar = 0.5; c.stores.sugar += 0.5; c.stores.protein = 1; // the store holds less than all nurses would take: arrival order decides who gets it
  const runRound = (reverse: boolean) => { const s: Any = structuredClone(s0), col = s.colonies[0]; if (reverse) col.population.workers.reverse(); const ev: Any[] = []; bindFoodTransfers(ev, s.sim_day + 1, col.id); nestRound(s, col, SP, ev); const byId = col.population.workers.map((w: Any) => [w.id, w.crop_cargo_sugar ?? 0, w.crop_cargo_protein_liquid ?? 0]).sort(); return JSON.stringify([byId, col.population.queens, col.stores, ev.filter((e) => e.type !== 'nest_move').map((e) => [e.type, e.cause ?? '', e.worker ?? e.source?.id, e.ordinal, e.portions ?? null]).sort()]); };
  ok(runRound(false) === runRound(true) && /take_from_cache/.test(runRound(false)) && /feed_queen/.test(runRound(false)), 'P1: one nest round gives the same result, by worker ID, when the worker array is reversed (arrivals from ID streams, ties by ID)');
}

// ---------------------------------------------------------------- N1–N16 counterexamples
const renumber = (d: Day) => { let n = 0; for (const e of d.events) if (e.type === 'food_transfer') e.transfer_id = `FT-${d.day}-${d.after.id}-${++n}`; };
const both = (name: string, pick: (d: Day) => boolean, mutate: (d: Day) => void) => {
  const d0 = days.find(pick); assert.ok(d0, `no sample day for ${name}`);
  const d = structuredClone(d0) as Day; d.sources = d0.sources; d.sp = d0.sp; d.raw = d0.raw;
  assert.equal(engineAccepts(d), true, `${name}: the unmutated sample must be accepted`);
  mutate(d);
  const eng = engineAccepts(d), rd = readerErrors(d);
  ok(eng !== true, `${name}: the engine rejects (${String(eng).slice(0, 140)})`);
  ok(rd.length > 0, `${name}: the readers reject (${rd[0] ?? 'ACCEPTED'})`);
};
const tx = (d: Day, cause: string, food?: string) => d.events.find((e) => e.type === 'food_transfer' && e.cause === cause && (!food || e.food_type === food));
const has = (cause: string, food?: string) => (d: Day) => !!tx(d, cause, food);
const queen = (d: Day) => d.after.population.queens[0];
const worker = (d: Day, id: string) => d.after.population.workers.find((w: Any) => w.id === id);

both('N1 liquid protein fed with no take_from_cache behind it', (d) => { const f = tx(d, 'feed_queen', 'protein'); return !!f && d.events.some((e) => e.cause === 'take_from_cache' && e.recipient?.id === f.source.id); }, (d) => {
  const f = tx(d, 'feed_queen', 'protein'), t = d.events.find((e) => e.cause === 'take_from_cache' && e.recipient.id === f.source.id);
  d.events.splice(d.events.indexOf(t), 1); d.after.stores.protein += t.portions; const w = worker(d, f.source.id); if (w) w.crop_cargo_protein_liquid = Math.max(0, (w.crop_cargo_protein_liquid ?? 0) - t.portions); renumber(d);
});
both('N2 takes less than it feeds', (d) => { const f = tx(d, 'feed_queen', 'protein'); return !!f && f.portions > 0.01; }, (d) => { const f = tx(d, 'feed_queen', 'protein'); f.portions = +(f.portions + 0.2).toFixed(6); queen(d).body.known_balance.protein = +(queen(d).body.known_balance.protein + 0.2).toFixed(6); });
both('N3 the same holding fed twice in one contact', has('feed_queen', 'sugar'), (d) => { const f = tx(d, 'feed_queen', 'sugar'); d.events.splice(d.events.indexOf(f) + 1, 0, structuredClone(f)); renumber(d); });
both('N4 fed by a worker that does not exist', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); const c = d.events.find((e) => e.contact_event_id === f.contact.contact_event_id && e.type === 'queen_contact'); f.source.id = 'W9999'; c.worker = 'W9999'; f.contact.worker = 'W9999'; });
both('N5 fed to a queen that is not the colony\'s', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); f.recipient.id = 'Q999'; d.events.find((e) => e.type === 'queen_contact' && e.contact_event_id === f.contact.contact_event_id).queen = 'Q999'; });
both('N6 worker and queen at different places', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); d.events.find((e) => e.type === 'queen_contact' && e.contact_event_id === f.contact.contact_event_id).worker_location = 'brood'; });
both('N7 delivered before the worker arrived', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); const c = d.events.find((e) => e.type === 'queen_contact' && e.contact_event_id === f.contact.contact_event_id); c.ordinal = 0.0001; f.ordinal = 0.0001; for (const e of d.events) if (e.type === 'food_transfer' && e.phase === 'nest_round') e.ordinal = Math.min(e.ordinal, 0.0001); });
both('N8 a worker feeds after its death', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); d.events.splice(d.events.findIndex((e) => e.type === 'queen_contact' && e.contact_event_id === f.contact.contact_event_id), 0, { type: 'worker_death', id: f.source.id }); });
both('N9 the queen\'s balance grows with no event', () => true, (d) => { queen(d).body.known_balance.sugar = +(queen(d).body.known_balance.sugar + 0.1).toFixed(6); });
both('N10 protein fed from a crop that holds no liquid protein', (d) => { const f = tx(d, 'feed_queen', 'sugar'); return !!f && !(worker(d, f.source.id)?.crop_cargo_protein_liquid) && !d.before.population.workers.find((w: Any) => w.id === f.source.id)?.crop_cargo_protein_liquid && !d.events.some((e) => e.cause === 'take_from_cache' && e.recipient?.id === f.source.id); }, (d) => {
  const f = tx(d, 'feed_queen', 'sugar'); f.food_type = 'protein'; delete f.nest_ledger_delta; const q = queen(d).body.known_balance; q.sugar = +(q.sugar - f.portions).toFixed(6); q.protein = +(q.protein + f.portions).toFixed(6); });
both('N11 solid protein handed over as if by trophallaxis (cache -> queen without a crop)', has('feed_queen'), (d) => { const f = tx(d, 'feed_queen'); f.source = { kind: 'cache', id: d.after.nest_node }; });
both('N12 the migrated queen\'s unknown reserve turned into 0', (d) => d.after.population.queens[0].body.basis === 'unknown_at_migration', (d) => { queen(d).body.unknown_initial_reserve = 0; });
both('N13 self-feeding where the food is not', has('queen_self_feed'), (d) => { tx(d, 'queen_self_feed').contact.food_location = 'store'; });
both('N14 a crop above the shared capacity', has('take_from_cache'), (d) => { const t = tx(d, 'take_from_cache'), w = worker(d, t.recipient.id); const extra = +(SP.trophallaxis.crop_capacity + 0.05 - (w.crop_cargo_sugar ?? 0) - (w.crop_cargo_protein_liquid ?? 0)).toFixed(6); t.portions = +(t.portions + extra).toFixed(6); w.crop_cargo_protein_liquid = +((w.crop_cargo_protein_liquid ?? 0) + extra).toFixed(6); d.after.stores.protein = +(d.after.stores.protein - extra).toFixed(6); });
both('N15 the old colony metabolism takes from the queen\'s body', (d) => !!d.events.find((e) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.food_type === 'sugar'), (d) => { const m = d.events.find((e) => e.type === 'food_transfer' && e.cause === 'metabolism' && e.food_type === 'sugar'); m.source = { kind: 'queen_body', id: d.after.queen_id }; });
both('N16 the queen spends more than she has eaten', has('queen_metabolism', 'sugar'), (d) => { const m = tx(d, 'queen_metabolism', 'sugar'); m.portions = +(m.portions + 1).toFixed(6); queen(d).body.known_balance.sugar = +(queen(d).body.known_balance.sugar - 1).toFixed(6); });

console.log(JSON.stringify({ c3a_queen_feeding: 'pass', checks, colony_days: colonyDays, contacts, feedings: feeds, takes_from_store: takes, self_feedings: selfFeeds, migrated_queen_days: migrated, note: 'engineering checks only; routes B1/C are candidates, not established mechanisms of P. megacephala; laying and survival unchanged (C3b/C3c)' }, null, 2));
