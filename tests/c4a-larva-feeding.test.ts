/**
 * C4a (v2-review.28; docs/design-c4-larval-nutrition.md §5, §7.0 D1–D8; Issue #81): each larva's own account, fed only in
 * the C3a nest round. Checked here (A0 stays in tests/c4a-a0-defect.test.ts as the switch-off evidence):
 *   D1  the switch is refused without C3a;
 *   A1  far-larva counterfactual: larvae added at ANOTHER place leave every original larva's intake, begging, account,
 *       development and survival bit-identical; control: the same larvae added at the SAME place change the contacts
 *       (D7 dilution, reported);
 *   A2  a larva's begging is a function of its own start signal and its own intake only (functional check over all larvae);
 *       two states that differ only in colony quantities give equal begging for larvae with equal own records;
 *   A3  the nest round and the larval metabolism are invariant to the order of population.workers and population.brood
 *       (by ID); the full day is NOT (Issue #56, settleCrops / foraging order) — counted and reported, not hidden;
 *   A4  every feed_larva has its contact, place and time; A6 the three independent readers agree on real days;
 *   A5  static: the C4a module reads no colony total, gap, fraction or count; runtime: see A2;
 *   A10 hatch records (D2a): inherited = the egg's lay_egg record, null when not recorded, reserve_at_hatch null;
 *   A11 no account grows without a transfer; D5 pupae keep the account, eclosion metabolizes it; D8 first-seen bases;
 *   N1–N16 counterexamples, each rejected by the engine check AND by an independent reader.
 * Engineering correctness only, not biological validation. The threshold and bolus are game assumptions; the contact rule
 * and the dilution are candidate mechanisms; the known balance overstates the true shortfall (reserve unknown, null).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { colonySnapshot, checkColonyFood, bindFoodTransfers } from '../engine/transfers.ts';
import { checkQueenRound, queenRoundStart, nestRound, expectedInitBasis } from '../engine/queen-feeding.ts';
import { checkLarvaRound, ensureBroodRecords, larvaMetabolism, larvaRoundStart } from '../engine/larva-feeding.ts';
import { replayEngineColonyDay } from '../cli/lib/engine-transfers.ts';
import { replayQueenRound } from '../cli/lib/queen-round-replay.ts';
import { replayLarvaRound } from '../cli/lib/larva-round-replay.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const bundleWith = (over: Record<string, unknown> = {}, qf: Record<string, unknown> = {}) => { const b: Any = structuredClone(loadBundle()); Object.assign(b.species[MAIN_SPECIES].queen_feeding, { individual_queen_body_c3a: true }, qf); Object.assign(b.species[MAIN_SPECIES].larval_feeding, { individual_larva_body_c4a: true }, over); return b; };
const B = bundleWith(), BQ = bundleWith({}, { store_is_queen_location: true, route_c_self_feed: true });
const spOf = (b: Any) => resolveBundle(b).species[MAIN_SPECIES] as Any;
const SP = spOf(B);
const evidence: Record<string, unknown> = {};

// ---------------------------------------------------------------- D1: C4a needs C3a
{
  const b: Any = structuredClone(loadBundle()); b.species[MAIN_SPECIES].larval_feeding.individual_larva_body_c4a = true;
  let msg = ''; try { resolveBundle(b); } catch (e) { msg = String(e); }
  ok(/requires queen_feeding\.individual_queen_body_c3a/.test(msg), `D1: C4a on with C3a off is refused when the parameters are read (${msg.slice(0, 120)})`);
  ok(spOf(loadBundle()).larval_feeding.individual_larva_body_c4a === false, 'A7: the switch is off by default');
}

// ---------------------------------------------------------------- real C4a days (engine accepts every one, or throws)
interface Day { before: Any; world: Any; after: Any; events: Any[]; day: number; sources: Set<string>; temp: number; raw: Any; sp: Any }
const rawSpecies = (b: Any) => b.species[MAIN_SPECIES];
const readerErrors = (d: Day) => [
  ...replayEngineColonyDay(d.before, d.after, d.events, d.day, d.sources, 'timed', true, true).errors,
  ...replayQueenRound(d.before, d.after, d.events, d.raw, d.world).errors,
  ...replayLarvaRound(d.before, d.after, d.events, d.raw, d.world, d.temp).errors,
];
const days: Day[] = [];
const tally = { colony_days: 0, contacts: 0, feeds: { sugar: 0, protein: 0 }, hatch: 0, hatch_with_record: 0, eclosion_with_account: 0, deaths_with_account: 0, death_transfers: 0, larva_metabolism: 0, queenless_round_days: 0, reader_errors: 0 };
const run = (s0: Any, b: Any, n: number) => {
  let s = s0;
  for (let k = 0; k < n; k++) {
    const o: Any = simulateWorldDay(s, b), c0 = s.colonies[0], c1 = o.state.colonies[0], ev = o.result.colonies[0].events;
    const d: Day = { before: c0, world: { sim_day: s.sim_day, migration_log: s.migration_log ?? [] }, after: c1, events: ev, day: o.day, sources: new Set(Object.keys(s.sources)), temp: o.result.weather.nest_temp_model_c, raw: rawSpecies(b), sp: spOf(b) };
    const errs = readerErrors(d); if (errs.length) { tally.reader_errors++; if (tally.reader_errors < 3) console.error(errs.slice(0, 4)); }
    tally.colony_days++;
    for (const e of ev) {
      if (e.type === 'larva_contact') tally.contacts++;
      if (e.cause === 'feed_larva') tally.feeds[e.food_type as 'sugar' | 'protein']++;
      if (e.type === 'larva_hatch_nutrition') { tally.hatch++; if (e.inherited) tally.hatch_with_record++; }
      if (e.cause === 'brood_body_at_eclosion') tally.eclosion_with_account++;
      if (e.type === 'brood_death' && c0.population.brood.find((x: Any) => x.id === e.id)?.body) tally.deaths_with_account++;
      if (e.cause === 'death_body_to_corpse') tally.death_transfers++;
      if (e.cause === 'larva_metabolism') tally.larva_metabolism++;
    }
    if (!c0.population.queen_alive && ev.some((e: Any) => e.type === 'larva_contact')) tally.queenless_round_days++;
    days.push(d); s = o.state;
  }
  return s;
};
for (const f of ['A1', 'A2', 'A3', 'A4', 'A5']) for (const season of ['2027-03-21', '2027-09-23']) run(buildDay0(f as Any, 3, season, B).state, B, 90);
run(buildDay0('A5' as Any, 4, '2027-06-21', BQ).state, BQ, 60); // store at the queen's place, route C on
const day14 = legacyToWorldState(fixture() as Any, legacyColonyMeta(B.world.scenario_colonies as Any));
run(day14, B, 30);
// targeted real days: a nest round with no living queen (D1: the round still serves the larvae) and larvae that die
{
  let s: Any = buildDay0('A1' as Any, 3, '2027-09-23', B).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 3; k++) s = simulateWorldDay(s, B).state;
  const queenless = structuredClone(s); queenless.colonies[0].population.queen_alive = false;
  run(queenless, B, 5);
  const starving = structuredClone(s); starving.colonies[0].stores.protein_gap_days = 40; starving.colonies[0].stores.protein = 0; // L3 still reads the colony gap (C4c fixes it); with an empty store the workers' own protein demand keeps it open
  run(starving, B, 5);
}
ok(tally.queenless_round_days > 0, `D1: without a living queen the nest round still serves the larvae (${tally.queenless_round_days} days; store -> brood)`);
ok(tally.deaths_with_account > 0, `larvae with an account die and the readers check that their whole balance leaves with the body (${tally.deaths_with_account} deaths, ${tally.death_transfers} with a non-zero balance and a death_body_to_corpse record; a zero balance writes no transfer, C2 rule)`);
ok(tally.reader_errors === 0, `A6: the C2, nest-round and larva readers accept all ${tally.colony_days} real C4a colony-days`);
ok(tally.contacts > 0 && tally.feeds.sugar > 0 && tally.feeds.protein > 0, `real days contain larva contacts (${tally.contacts}) and sugar (${tally.feeds.sugar}) and protein (${tally.feeds.protein}) feedings`);
ok(tally.hatch_with_record > 0 && tally.eclosion_with_account > 0 && tally.larva_metabolism > 0, `real days contain hatches with an egg record (${tally.hatch_with_record}), eclosions with an account (${tally.eclosion_with_account}) and larval metabolism (${tally.larva_metabolism})`);
evidence.real_days = tally;

// ---------------------------------------------------------------- D8: first-seen bases
{
  const d0: Any = simulateWorldDay(buildDay0('A2' as Any, 1, '2027-09-23', B).state, B), init = d0.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized');
  ok(init.length > 0 && init.every((e: Any) => e.reserve_basis === 'day0_scenario' && e.egg_investment === null), `D8: Day0 brood on day 0 is recorded day0_scenario with egg_investment null (${init.length} records)`);
  const m: Any = simulateWorldDay(day14, B), mi = m.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized');
  ok(mi.length > 0 && mi.every((e: Any) => e.reserve_basis === 'unknown_at_migration'), `D8: Day14 migrated brood is recorded unknown_at_migration (${mi.length})`);
  ok(m.state.colonies[0].population.brood.filter((b: Any) => b.body).every((b: Any) => b.body.reserve_at_hatch === null), 'D8 / A10: every account has reserve_at_hatch null');
  // an egg the engine laid while the switch was off, then the switch is turned on
  const off: Any = loadBundle(); let s: Any = buildDay0('A1' as Any, 1, '2027-03-21', off).state;
  for (let k = 0; k < 40 && !s.colonies[0].population.brood.some((b: Any) => b.stage === 'egg' && b.origin === 'v2_scenario_laying'); k++) s = simulateWorldDay(s, off).state;
  const on: Any = simulateWorldDay(s, B), engineEgg = on.result.colonies[0].events.find((e: Any) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'egg' && s.colonies[0].population.brood.find((b: Any) => b.id === e.id)?.origin === 'v2_scenario_laying');
  ok(engineEgg?.reserve_basis === 'egg_laid_before_switch', `D8: an engine-laid egg from before the switch is egg_laid_before_switch (${engineEgg?.reserve_basis})`);
}

// ---------------------------------------------------------------- A10 / D2a: hatch inherits the lay_egg record exactly
{
  const hatchDays = days.filter((d) => d.events.some((e) => e.type === 'larva_hatch_nutrition' && e.inherited));
  let n = 0, eggTouched = 0;
  for (const d of hatchDays) for (const e of d.events.filter((x) => x.type === 'larva_hatch_nutrition')) {
    const egg = d.before.population.brood.find((b: Any) => b.id === e.larva);
    ok(JSON.stringify(e.inherited) === JSON.stringify(egg?.egg_investment ?? null) && e.reserve_at_hatch === null, `A10: hatch of ${e.larva} inherits its egg's record ${JSON.stringify(egg?.egg_investment)} with reserve_at_hatch null`);
    n++;
    eggTouched += d.events.filter((x) => x.type === 'food_transfer' && (x.source.kind === 'egg' || x.source.id === `egg:${e.larva}`)).length;
  }
  ok(n > 0 && eggTouched === 0, `A10 (a): ${n} hatches; no transfer ever leaves an egg:<id> account (the C2 egg ledger is unchanged; no larva_yolk)`);
  const laidDay = days.find((d) => d.events.some((e) => e.type === 'egg_laid'));
  const egg = laidDay?.after.population.brood.find((b: Any) => b.id === laidDay.events.find((e) => e.type === 'egg_laid').id);
  ok(egg?.reserve_basis === 'egg_laid_with_record' && egg.egg_investment.sugar === SP.nutrition.egg_laying_sugar_cost && egg.egg_investment.protein === SP.nutrition.egg_laying_protein_cost, `D2a: an egg laid with the switch on records exactly its lay_egg cost ${JSON.stringify(egg?.egg_investment)}`);
}

// ---------------------------------------------------------------- A1: far larvae counterfactual (switch on)
const addLarvae = (s0: Any, n: number, location: string) => {
  const s = structuredClone(s0), br = s.colonies[0].population.brood;
  for (let i = 0; i < n; i++) br.push({ id: `ZZ${location.toUpperCase()}${String(i).padStart(3, '0')}`, stage: 'larva', laid_on_day: null, age_days: null, progress: 0.1, begging_signal: 0.9, location, origin: 'test: an added larva' });
  return s;
};
{
  // a state with larvae and nurses feeding them (after several days so accounts exist)
  // the first day of a fixed run on which at least two larvae have accounts (no search over seeds)
  let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', B).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 2; k++) s = simulateWorldDay(s, B).state;
  const larvaIds = s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva').map((b: Any) => b.id);
  ok(larvaIds.length > 0, `A1 setup: ${larvaIds.length} larvae`);
  let base = s, far = addLarvae(s, 20, 'brood_far'), near = addLarvae(s, 20, 'brood');
  let sameAll = true, nearChanged = 0, nearContacts = { base: 0, near: 0 };
  for (let k = 0; k < 10; k++) {
    const a: Any = simulateWorldDay(base, B), f: Any = simulateWorldDay(far, B), n: Any = simulateWorldDay(near, B);
    const pick = (o: Any) => { const m = new Map(o.state.colonies[0].population.brood.map((b: Any) => [b.id, b])); return larvaIds.map((id: string) => JSON.stringify(m.get(id) ?? null)); };
    const own = (o: Any) => o.result.colonies[0].events.filter((e: Any) => (e.type === 'larva_contact' || e.cause === 'feed_larva' || e.type === 'larva_nutrition' || e.type === 'brood_death' || e.type === 'pupation') && larvaIds.includes(e.larva ?? e.recipient?.id ?? e.id)).map((e: Any) => JSON.stringify({ ...e, transfer_id: undefined, contact_event_id: undefined, contact: undefined, larvae_at_place: undefined }));
    if (JSON.stringify(pick(a)) !== JSON.stringify(pick(f)) || JSON.stringify(own(a)) !== JSON.stringify(own(f))) sameAll = false;
    const cnt = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.type === 'larva_contact' && larvaIds.includes(e.larva)).length;
    nearContacts.base += cnt(a); nearContacts.near += cnt(n);
    if (JSON.stringify(pick(a)) !== JSON.stringify(pick(n))) nearChanged++;
    ok(f.result.colonies[0].events.filter((e: Any) => e.type === 'larva_contact' && String(e.larva).startsWith('ZZBROOD_FAR')).length === 0, `A1 day ${a.day}: no nurse meets a larva at the other place`);
    base = a.state; far = f.state; near = n.state;
  }
  ok(sameAll, 'A1: with C4a on, 20 untouched larvae at ANOTHER place leave every original larva (state, contacts, feedings, metabolism, begging, development, survival) bit-identical over 10 days');
  ok(nearContacts.near < nearContacts.base, `A1 control (D7, candidate dilution): 20 larvae at the SAME place cut the contacts with the original larvae ${nearContacts.base} -> ${nearContacts.near}; their states differ on ${nearChanged}/10 days (reported, not a target)`);
  evidence.A1 = { original_larvae: larvaIds.length, far_identical: sameAll, same_place_contacts: nearContacts, same_place_days_changed: nearChanged };
}

// ---------------------------------------------------------------- A2 / A5 runtime: begging from own records only
{
  let fit = 0, zeroIntake = 0;
  for (const d of days) for (const e of d.events.filter((x) => x.type === 'larva_nutrition')) {
    const want = Math.round((SP.local_signals.larva_begging_previous_weight * e.begging_before + SP.local_signals.larva_begging_shortfall_weight * Math.min(1, Math.max(0, 1 - e.intake_portions.protein / e.need_portions.protein)) + Number.EPSILON) * 1e6) / 1e6;
    assert.equal(e.begging_signal, want, `A2: ${e.larva} on day ${d.day}`); fit++;
    if (e.intake_portions.protein === 0) zeroIntake++;
  }
  ok(fit > 100 && zeroIntake > 0, `A2: for all ${fit} larva-days the begging is a function of the larva's own start signal and its own intake (${zeroIntake} with no protein intake)`);
  // two states with very different colony quantities; larvae with equal own records end equal
  let s: Any = buildDay0('A1' as Any, 3, '2027-09-23', B).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 2; k++) s = simulateWorldDay(s, B).state;
  const rich = structuredClone(s), poor = structuredClone(s);
  rich.colonies[0].stores.protein_gap_days = 0; poor.colonies[0].stores.protein_gap_days = 30; poor.colonies[0].stores.sugar_gap_days = 30;
  const r: Any = simulateWorldDay(rich, B), p: Any = simulateWorldDay(poor, B);
  const recs = (o: Any) => new Map(o.result.colonies[0].events.filter((e: Any) => e.type === 'larva_nutrition').map((e: Any) => [e.larva, e]));
  const R = recs(r), P = recs(p); let compared = 0;
  for (const [id, e] of R as Map<string, Any>) { const q: Any = P.get(id); if (q && JSON.stringify(q.intake_portions) === JSON.stringify(e.intake_portions) && q.begging_before === e.begging_before) { ok(q.begging_signal === e.begging_signal && JSON.stringify(q.fed_balance) === JSON.stringify(e.fed_balance), `A5 runtime: ${id} with equal own records ends equal although the colony gap days differ (0 vs 30)`); compared++; } }
  ok(compared > 0, `A5 runtime: ${compared} larvae compared`);
}

// ---------------------------------------------------------------- A5 static
{
  const src = fs.readFileSync(new URL('../engine/larva-feeding.ts', import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  for (const banned of ['protein_gap_days', 'sugar_gap_days', 'stress_days', 'pFraction', 'sFraction', 'ratios', 'stores.protein', 'summary', 'population.workers.length', 'brood.length']) ok(!src.includes(banned), `A5 static: engine/larva-feeding.ts does not reference ${banned}`);
  const storeUses = src.split('\n').filter((l) => l.includes('stores.'));
  ok(storeUses.length === 1 && /colony\.stores\.sugar = round\(colony\.stores\.sugar - a\)/.test(storeUses[0]), 'A5 static: the only store use is the sugar ledger debit of a feeding from a crop (bookkeeping, never a decision input)');
}

// ---------------------------------------------------------------- A3: order invariance of the C4a path
{
  let s: Any = buildDay0('A5' as Any, 5, '2027-03-21', B).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 2; k++) s = simulateWorldDay(s, B).state;
  const once = (rev: boolean) => {
    const w: Any = structuredClone(s), c = w.colonies[0];
    if (rev) { c.population.workers.reverse(); c.population.brood.reverse(); }
    const ev: Any[] = []; bindFoodTransfers(ev, w.sim_day + 1, c.id);
    ensureBroodRecords(c, false, ev); const r = nestRound(w, c, SP, ev); larvaMetabolism(c, SP, 1, r.larvae?.intake ?? new Map(), ev);
    return JSON.stringify([...c.population.brood].sort((a: Any, b: Any) => (a.id < b.id ? -1 : 1)).map((b: Any) => [b.id, b.body, b.begging_signal]));
  };
  ok(once(false) === once(true), 'A3: the nest round and the larval metabolism give every larva the same result by ID when workers and brood are reversed');
  const full = (rev: boolean) => { const w: Any = structuredClone(s); if (rev) { w.colonies[0].population.workers.reverse(); w.colonies[0].population.brood.reverse(); } const o: Any = simulateWorldDay(w, B); return JSON.stringify([...o.state.colonies[0].population.brood].sort((a: Any, b: Any) => (a.id < b.id ? -1 : 1)).map((b: Any) => [b.id, b.body, b.begging_signal, b.progress])); };
  evidence.A3_full_day_order_dependent = full(false) !== full(true);
  ok(true, `A3 (reported, Issue #56): over a FULL day the larval results ${evidence.A3_full_day_order_dependent ? 'DO' : 'do not'} depend on the array order — the C4a path does not, the remaining dependence comes from the existing order-dependent steps (settleCrops, foraging), known violations`);
}

// ---------------------------------------------------------------- N1–N16: counterexamples rejected by engine and reader
const target = days.find((d) => d.day >= 3 && d.before.population.queen_alive && d.events.filter((e) => e.cause === 'feed_larva').length >= 2 && d.events.some((e) => e.type === 'larva_hatch_nutrition' && e.inherited))
  ?? days.find((d) => d.day >= 3 && d.events.filter((e) => e.cause === 'feed_larva').length >= 2) as Day;
ok(!!target, `a day with larval feedings for the counterexamples (day ${target?.day})`);
const engineErr = (d: Day, events: Any[], after: Any = d.after) => {
  const pre: Any = structuredClone(d.before), day0 = expectedInitBasis(d.world) === 'day0_scenario';
  const had = ensureBroodRecords(pre, day0, []);
  try {
    checkColonyFood(colonySnapshot(pre, true, true), after, events, 'timed');
    checkQueenRound(queenRoundStart(pre, true, expectedInitBasis(d.world)), after, events, d.sp);
    checkLarvaRound(larvaRoundStart(pre, d.sp, had, day0), after, events, d.sp, Number(d.after.last_report?.metabolic_factor));
    return '';
  } catch (e) { return String(e); }
};
ok(engineErr(target, target.events) === '', `the unmodified day ${target.day} is accepted by the engine checks`);
ok(readerErrors(target).length === 0, 'the unmodified day is accepted by the readers');
const forge = (name: string, edit: (ev: Any[], after: Any) => void) => {
  const ev: Any[] = structuredClone(target.events), after: Any = structuredClone(target.after); edit(ev, after);
  const e = engineErr(target, ev, after), r = readerErrors({ ...target, events: ev, after });
  ok(e !== '', `${name}: rejected by the engine (${e.slice(0, 110)})`);
  ok(r.length > 0, `${name}: rejected by the readers (${String(r[0]).slice(0, 110)})`);
};
const feeds = (ev: Any[]) => ev.filter((e) => e.cause === 'feed_larva');
const contactOf = (ev: Any[], f: Any) => ev.find((e) => e.type === 'larva_contact' && e.contact_event_id === f.contact.contact_event_id);
forge('N1 feed_larva without a contact', (ev) => { const f = feeds(ev)[0]; ev.splice(ev.indexOf(contactOf(ev, f)), 1); });
forge('N2 feeding a different larva than the contact', (ev, after) => { const f = feeds(ev)[0], other = after.population.brood.find((b: Any) => b.body && b.stage === 'larva' && b.id !== f.recipient.id); if (other) { f.recipient.id = other.id; } else f.recipient.id = 'NOBODY'; });
forge('N3 contact with a larva at another place', (ev) => { const c = contactOf(ev, feeds(ev)[0]); c.larva_location = 'brood_far'; });
forge('N4 contact before the nurse reaches the brood', (ev) => { const f = feeds(ev)[0], c = contactOf(ev, f); c.ordinal = 1.0; f.ordinal = 1.0; });
forge('N5 a bolus above the fixed size', (ev, after) => { const f = feeds(ev).find((x) => x.food_type === 'protein') ?? feeds(ev)[0]; f.portions = Math.round((f.portions + 0.5) * 1e6) / 1e6; const l = after.population.brood.find((b: Any) => b.id === f.recipient.id); if (l?.body) l.body.fed_balance[f.food_type] = Math.round((l.body.fed_balance[f.food_type] + 0.5) * 1e6) / 1e6; });
forge('N6 two boluses of one food in one contact', (ev) => { const f = feeds(ev)[0], i = ev.indexOf(f); ev.splice(i + 1, 0, { ...structuredClone(f), transfer_id: f.transfer_id + 'b' }); });
forge('N7 a contact records a begging signal other than the larva\'s own', (ev) => { const c = contactOf(ev, feeds(ev)[0]); c.begging_signal = Math.round(((c.begging_signal + 0.31) % 1) * 1e6) / 1e6; });
forge('N8 begging updated from something other than its own intake', (ev, after) => { const e = ev.find((x) => x.type === 'larva_nutrition'), l = after.population.brood.find((b: Any) => b.id === e.larva); e.begging_signal = Math.round(((e.begging_signal + 0.2) % 1) * 1e6) / 1e6; if (l) l.begging_signal = e.begging_signal; });
forge('N9 a larva pays more metabolism than its own balance (null reserve read as 0 / inheritance spent)', (ev, after) => { const m = ev.find((x) => x.cause === 'larva_metabolism'); m.portions = Math.round((m.portions + 0.05) * 1e6) / 1e6; const l = after.population.brood.find((b: Any) => b.id === m.source.id); if (l?.body) l.body.fed_balance[m.food_type] = Math.max(0, Math.round((l.body.fed_balance[m.food_type] - 0.05) * 1e6) / 1e6); });
forge('N10 an account grows without a transfer (A11)', (_ev, after) => { const l = after.population.brood.find((b: Any) => b.body); l.body.fed_balance.protein = Math.round((l.body.fed_balance.protein + 0.1) * 1e6) / 1e6; });
forge('N17 a nurse walks store -> brood while the queen is alive (skips the queen leg)', (ev) => { const m = ev.find((e) => e.type === 'nest_move' && e.to === 'brood'); const first = ev.find((e) => e.type === 'nest_move' && e.worker === m.worker); ev.splice(ev.indexOf(first), 1); m.from = 'store'; });
forge('N18 a second walk to the brood in one round', (ev) => { const m = ev.find((e) => e.type === 'nest_move' && e.to === 'brood'); ev.splice(ev.indexOf(m) + 1, 0, { ...structuredClone(m), from: 'brood' }); });
// independent review of the C4a draft (not Codex): the bolus is fixed, not only bounded, and a due bolus cannot be skipped
const shift = (ev: Any[], after: Any, f: Any, d: number) => { // move d portions of f back from the larva to the nurse in the end state and the downstream records
  const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
  const w = after.population.workers.find((x: Any) => x.id === f.source.id), l = after.population.brood.find((x: Any) => x.id === f.recipient.id);
  if (w) { if (f.food_type === 'sugar') w.crop_cargo_sugar = r6((w.crop_cargo_sugar || 0) + d); }
  if (f.food_type === 'sugar') after.stores.sugar = r6(after.stores.sugar + d);
  if (l?.body) l.body.fed_balance[f.food_type] = Math.max(0, r6(l.body.fed_balance[f.food_type] - d));
};
forge('N19 a smaller bolus than the fixed size (sugar 0.025 -> 0.01)', (ev, after) => { const f = feeds(ev).find((x) => x.food_type === 'sugar' && x.portions >= 0.02) ?? feeds(ev)[0]; const d = Math.round((f.portions - 0.01) * 1e6) / 1e6; f.portions = 0.01; shift(ev, after, f, d); });
forge('N20 a due bolus dropped (the larva begs, the nurse holds food, nothing is given)', (ev, after) => { const f = feeds(ev).find((x) => x.food_type === 'sugar') ?? feeds(ev)[0]; ev.splice(ev.indexOf(f), 1); shift(ev, after, f, f.portions); });
forge('N21 two larva_nutrition records for one larva (the wrong one first)', (ev) => { const e = ev.find((x) => x.type === 'larva_nutrition'); ev.splice(ev.indexOf(e), 0, { ...structuredClone(e), begging_signal: 0 }); });
forge('N22 a larva_nutrition record for an individual that was not a larva', (ev) => { const e = ev.find((x) => x.type === 'larva_nutrition'); ev.push({ ...structuredClone(e), larva: target.before.population.workers[0].id }); });
forge('N11 reserve_at_hatch filled in', (_ev, after) => { const l = after.population.brood.find((b: Any) => b.body); l.body.reserve_at_hatch = 0.05; });
const hatchDay = days.find((d) => d.day >= 3 && d.events.some((e) => e.type === 'larva_hatch_nutrition' && e.inherited));
if (hatchDay) {
  const forgeH = (name: string, edit: (ev: Any[], after: Any) => void) => {
    const ev: Any[] = structuredClone(hatchDay.events), after: Any = structuredClone(hatchDay.after); edit(ev, after);
    const e = engineErr(hatchDay, ev, after), r = readerErrors({ ...hatchDay, events: ev, after });
    ok(e !== '', `${name}: rejected by the engine (${e.slice(0, 110)})`); ok(r.length > 0, `${name}: rejected by the readers (${String(r[0]).slice(0, 110)})`);
  };
  ok(engineErr(hatchDay, hatchDay.events) === '' && readerErrors(hatchDay).length === 0, `the unmodified hatch day ${hatchDay.day} is accepted`);
  const h = (ev: Any[]) => ev.find((e) => e.type === 'larva_hatch_nutrition' && e.inherited);
  forgeH('N12 inheritance different from the egg\'s lay_egg record', (ev, after) => { const x = h(ev); x.inherited.protein = Math.round((x.inherited.protein + 0.01) * 1e6) / 1e6; const l = after.population.brood.find((b: Any) => b.id === x.larva); if (l?.body?.egg_investment) l.body.egg_investment.protein = x.inherited.protein; });
  forgeH('N13 two hatch records for one larva', (ev) => { const x = h(ev); ev.splice(ev.indexOf(x) + 1, 0, structuredClone(x)); });
  forgeH('N14 hatch record with a reserve that is not null', (ev) => { h(ev).reserve_at_hatch = 0; });
  forgeH('N15 a larva_yolk transfer (D2a: record only)', (ev) => { const x = h(ev); ev.push({ type: 'food_transfer', schema: 'antempire.food-transfer.v1', transfer_id: `FT-${hatchDay.day}-${hatchDay.after.id}-999`, day: hatchDay.day, colony: hatchDay.after.id, minute: null, phase: 'nest_settlement', source: { kind: 'egg', id: x.larva }, recipient: { kind: 'larva_yolk', id: x.larva }, food_type: 'protein', portions: 0.01, cause: 'hatch_inherit', attribution: 'engine_rule' }); });
}
// N16 needs a hatch of an egg without a record (Day0 / migrated / laid before the switch)
const nullHatch = days.find((d) => d.day >= 1 && d.events.some((e) => e.type === 'larva_hatch_nutrition' && e.inherited === null));
if (nullHatch) {
  const ev: Any[] = structuredClone(nullHatch.events), after: Any = structuredClone(nullHatch.after), x = ev.find((e) => e.type === 'larva_hatch_nutrition' && e.inherited === null);
  x.inherited = { sugar: 0.1, protein: 0.1 };
  const l = after.population.brood.find((b: Any) => b.id === x.larva); if (l?.body) l.body.egg_investment = { sugar: 0.1, protein: 0.1 };
  ok(engineErr(nullHatch, ev, after) !== '', 'N16 an inheritance written for an egg without a record: rejected by the engine');
  ok(readerErrors({ ...nullHatch, events: ev, after }).length > 0, 'N16: rejected by the readers');
} else ok(true, 'N16: no hatch of an unrecorded egg among the real days (not exercised; stated)');

console.log(JSON.stringify({ test: 'c4a-larva-feeding', checks, evidence, note: 'engineering correctness of the C4a ledger and its locality; not a biological result; threshold and bolus are game assumptions; contact rule and dilution are candidate mechanisms' }, null, 2));
