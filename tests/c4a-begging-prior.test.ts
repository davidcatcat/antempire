/**
 * v2-review.29 (switch larval_feeding.first_seen_begging_prior_v29, requires C4a): the begging signal a larva carries when C4a
 * first sees it. In v28, a larva that existed before the switch keeps its old begging_signal, which the old rule computed from
 * the COLONY protein fraction (engine/nutrition.ts, L1) — or the Day14 migration default 0.25. That value is the first-day
 * input of the C4a feeding decision, so the first day still depends on a colony quantity (CLAUDE.md §2.1b).
 *   BEFORE (v29 off): two worlds that differ only in the colony protein store on the last pre-switch day give the same larvae
 *     different first-day begging; Day14 migrated larvae start at 0.25 < threshold 0.3, so none can be fed on day 1.
 *   AFTER (v29 on): a first-seen larva starts from the explicit prior default_larva_begging_prior (0.3, game assumption, NOT a
 *     measured hunger); its old value is kept in the initialization event only. Once only; larvae with C4a history are never
 *     reset; reserve_at_hatch stays null; egg_investment is not rewritten. Engine and reader check it separately.
 * Because the prior equals the feeding threshold (both 0.3), switching on makes every contacted first-seen larva eligible on
 * day 1: a behaviour change (reported as a counterfactual, a model choice for the Owner), not a refactor.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta } from '../engine/index.ts';
import { resolveBundle } from '../engine/params.ts';
import { checkLarvaRound, ensureBroodRecords, larvaRoundStart } from '../engine/larva-feeding.ts';
import { expectedInitBasis } from '../engine/queen-feeding.ts';
import { replayLarvaRound } from '../cli/lib/larva-round-replay.ts';
import { fixture, MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const evidence: Record<string, unknown> = {};
const bundle = (c3a: boolean, c4a: boolean, v29: boolean) => { const b: Any = structuredClone(loadBundle()); const s = b.species[MAIN_SPECIES]; s.queen_feeding.individual_queen_body_c3a = c3a; s.larval_feeding.individual_larva_body_c4a = c4a; s.larval_feeding.first_seen_begging_prior_v29 = v29; return b; };
const C3A = bundle(true, false, false), OFF = bundle(true, true, false), ON = bundle(true, true, true);
const SP = resolveBundle(ON).species[MAIN_SPECIES] as Any, PRIOR = SP.local_signals.default_larva_begging_prior, THRESHOLD = SP.larval_feeding.feed_begging_threshold;
const firstDay = (s: Any, b: Any) => simulateWorldDay(s, b) as Any;
const contacts = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.type === 'larva_contact');
const feeds = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.cause === 'feed_larva').length;

// ---------------------------------------------------------------- parameters
{ let m = ''; try { resolveBundle(bundle(true, false, true)); } catch (e) { m = String(e); } ok(/requires larval_feeding\.individual_larva_body_c4a/.test(m), 'the v29 switch is refused without C4a'); }
ok(resolveBundle(loadBundle()).species[MAIN_SPECIES].larval_feeding.first_seen_begging_prior_v29 === false, 'the v29 switch is off by default');
ok(PRIOR === THRESHOLD, `stated: the prior (${PRIOR}) equals the feeding threshold (${THRESHOLD}), so switching v29 on changes first-day eligibility`);

// ---------------------------------------------------------------- mid-run switch: two worlds differing only in a colony quantity
const preSwitch = (() => {
  let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', C3A).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva').length < 3; k++) s = simulateWorldDay(s, C3A).state;
  const rich = structuredClone(s), poor = structuredClone(s); rich.colonies[0].stores.protein = 5; poor.colonies[0].stores.protein = 0;
  return { rich: simulateWorldDay(rich, C3A).state, poor: simulateWorldDay(poor, C3A).state }; // one more old-rule day: begging from the colony fraction
})();
const larvaIds = preSwitch.rich.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva').map((b: Any) => b.id).filter((id: string) => preSwitch.poor.colonies[0].population.brood.some((b: Any) => b.id === id));
const begOf = (s: Any) => new Map(s.colonies[0].population.brood.map((b: Any) => [b.id, b.begging_signal]));
{
  const R = begOf(preSwitch.rich), P = begOf(preSwitch.poor), differ = larvaIds.filter((id: string) => R.get(id) !== P.get(id));
  ok(larvaIds.length > 0 && differ.length > 0, `BEFORE setup: after one old-rule day, ${differ.length}/${larvaIds.length} larvae carry different begging only because the colony protein store differed (${larvaIds.map((id: string) => `${R.get(id)} vs ${P.get(id)}`).join(', ')})`);
  const off = { rich: firstDay(preSwitch.rich, OFF), poor: firstDay(preSwitch.poor, OFF) }, on = { rich: firstDay(preSwitch.rich, ON), poor: firstDay(preSwitch.poor, ON) };
  const initOf = (o: Any) => new Map(o.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'larva').map((e: Any) => [e.id, e]));
  const startBeg = (s: Any, b: Any) => { const pre = structuredClone(s.colonies[0]); ensureBroodRecords(pre, false, [], b === ON ? PRIOR : null); return begOf({ colonies: [pre] }); };
  const offR = startBeg(preSwitch.rich, OFF), offP = startBeg(preSwitch.poor, OFF), onR = startBeg(preSwitch.rich, ON), onP = startBeg(preSwitch.poor, ON);
  ok(larvaIds.some((id: string) => offR.get(id) !== offP.get(id)), 'BEFORE (v29 off): on the first C4a day the begging that enters the feeding decision of the same first-seen larvae differs between the two worlds — it still carries the colony quantity');
  ok(larvaIds.every((id: string) => onR.get(id) === PRIOR && onP.get(id) === PRIOR), `AFTER (v29 on): every first-seen larva starts from the explicit prior ${PRIOR} in both worlds`);
  const ir = initOf(on.rich), ip = initOf(on.poor);
  ok(larvaIds.every((id: string) => (ir.get(id) as Any)?.legacy_begging_signal === preSwitch.rich.colonies[0].population.brood.find((b: Any) => b.id === id)?.begging_signal && (ip.get(id) as Any)?.legacy_begging_signal === preSwitch.poor.colonies[0].population.brood.find((b: Any) => b.id === id)?.begging_signal), 'AFTER: the old value is kept in the initialization event (tracing only)');
  ok([...initOf(off.rich).values()].every((e: Any) => !('legacy_begging_signal' in e) && !('begging_signal_set' in e)), 'v29 off: the initialization event is the v28 one (no prior fields)');
  const contactBeg = (o: Any) => new Map(contacts(o).map((e: Any) => [e.larva, e.begging_signal]));
  const cR = contactBeg(on.rich), cP = contactBeg(on.poor);
  ok([...cR.keys()].filter((id) => cP.has(id)).every((id) => cR.get(id) === PRIOR && cP.get(id) === PRIOR), 'AFTER: a first-seen larva met on day 1 shows the prior at contact in both worlds');
  evidence.mid_switch = { larvae: larvaIds.length, begging_rich_poor_before: larvaIds.map((id: string) => [offR.get(id), offP.get(id)]), first_day_feedings: { off: { rich: feeds(off.rich), poor: feeds(off.poor) }, on: { rich: feeds(on.rich), poor: feeds(on.poor) } } };
  // once only; never reset afterwards; no field of the account rewritten
  const d2: Any = simulateWorldDay(on.rich.state, ON);
  ok(!d2.result.colonies[0].events.some((e: Any) => e.type === 'brood_nutrition_record_initialized' && larvaIds.includes(e.id)), 'once only: day 2 initializes none of them again');
  const day1 = new Map(on.rich.state.colonies[0].population.brood.map((b: Any) => [b.id, b])), nut2 = new Map(d2.result.colonies[0].events.filter((e: Any) => e.type === 'larva_nutrition').map((e: Any) => [e.larva, e]));
  ok(larvaIds.every((id: string) => !nut2.has(id) || (nut2.get(id) as Any).begging_before === (day1.get(id) as Any)?.begging_signal), 'day 2: each larva updates its begging from its own day-1 value (not reset to the prior)');
  ok(on.rich.state.colonies[0].population.brood.filter((b: Any) => b.body).every((b: Any) => b.body.reserve_at_hatch === null && (larvaIds.includes(b.id) ? b.body.egg_investment === null : true)), 'reserve_at_hatch stays null; first-seen larvae keep egg_investment null');
}

// ---------------------------------------------------------------- switching v29 on in a world whose larvae already have C4a history
{
  let s: Any = buildDay0('A1' as Any, 3, '2027-03-21', OFF).state;
  for (let k = 0; k < 200 && s.colonies[0].population.brood.filter((b: Any) => b.stage === 'larva' && b.body).length < 2; k++) s = simulateWorldDay(s, OFF).state;
  const before = new Map(s.colonies[0].population.brood.filter((b: Any) => b.body).map((b: Any) => [b.id, b.begging_signal]));
  const a: Any = simulateWorldDay(s, OFF), c: Any = simulateWorldDay(s, ON);
  ok(!c.result.colonies[0].events.some((e: Any) => e.type === 'brood_nutrition_record_initialized' && before.has(e.id)), 'larvae with C4a history are not initialized again when v29 is switched on');
  const strip = (o: Any) => JSON.stringify([o.result.colonies[0].events.filter((e: Any) => e.type !== 'brood_nutrition_record_initialized'), o.state.colonies[0].population.brood.filter((b: Any) => before.has(b.id))]);
  ok(strip(a) === strip(c), 'and their contacts, feedings, accounts and begging are identical to v29 off (only first-seen brood is affected)');
}

// ---------------------------------------------------------------- Day14 migration and Day0
{
  const d14 = legacyToWorldState(fixture() as Any, legacyColonyMeta(ON.world.scenario_colonies as Any));
  const off: Any = firstDay(d14, OFF), on: Any = firstDay(d14, ON);
  const lowOff = contacts(off).filter((e: Any) => e.begging_signal < THRESHOLD).length, lowOn = contacts(on).filter((e: Any) => e.begging_signal < THRESHOLD).length;
  ok(contacts(off).length > 0 && lowOff === contacts(off).length, `BEFORE Day14: all ${contacts(off).length} first-day contacts meet migrated larvae begging below the threshold (migration default 0.25), so none is eligible`);
  ok(lowOn === 0, `AFTER Day14: first-day contacts carry the prior ${PRIOR}, all eligible (${feeds(off)} -> ${feeds(on)} feedings on day 1; counterfactual, reported)`);
  ok(on.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'larva').every((e: Any) => e.legacy_begging_signal === 0.25 && e.reserve_basis === 'unknown_at_migration'), 'Day14: the old value 0.25 is recorded, basis unknown_at_migration');
  evidence.day14 = { contacts_day1: contacts(off).length, feedings_day1: { off: feeds(off), on: feeds(on) } };
  const d0 = buildDay0('A2' as Any, 1, '2027-09-23', ON).state, z0: Any = firstDay(d0, OFF), z1: Any = firstDay(d0, ON);
  ok(z1.result.colonies[0].events.filter((e: Any) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'larva').every((e: Any) => e.legacy_begging_signal === PRIOR), 'Day0: carried larvae already start at the prior (initialization uses default_larva_begging_prior), the recorded old value equals it');
  const strip = (o: Any) => JSON.stringify([o.result.colonies[0].events.map((e: Any) => (e.type === 'brood_nutrition_record_initialized' ? { ...e, legacy_begging_signal: undefined, begging_signal_set: undefined, begging_basis: undefined } : e)), o.state.colonies[0].population]);
  ok(strip(z0) === strip(z1), 'Day0 day 0: apart from the added event fields, v29 on and off are identical (no behaviour change for Day0 worlds)');
}

// ---------------------------------------------------------------- counterexamples (engine and reader)
{
  const d14 = legacyToWorldState(fixture() as Any, legacyColonyMeta(ON.world.scenario_colonies as Any)), o: Any = firstDay(d14, ON), raw = ON.species[MAIN_SPECIES];
  const engine = (ev: Any[], startColony: Any, prior: number | null) => { const pre = structuredClone(startColony), had = ensureBroodRecords(pre, expectedInitBasis(d14) === 'day0_scenario', [], prior); try { checkLarvaRound(larvaRoundStart(pre, SP, had, false), o.state.colonies[0], ev, SP, Number(o.state.colonies[0].last_report.metabolic_factor)); return ''; } catch (e) { return String(e); } };
  const reader = (ev: Any[]) => replayLarvaRound(d14.colonies[0], o.state.colonies[0], ev, raw, d14, o.result.weather.nest_temp_model_c).errors;
  const ev0 = o.result.colonies[0].events;
  ok(engine(ev0, d14.colonies[0], PRIOR) === '' && reader(ev0).length === 0, 'the unmodified v29 day is accepted by the engine check and the reader');
  const init = (ev: Any[]) => ev.find((e: Any) => e.type === 'brood_nutrition_record_initialized' && e.stage === 'larva');
  { const ev = structuredClone(ev0); init(ev).begging_signal_set = 0.9; ok(/first-seen begging/.test(engine(ev, d14.colonies[0], PRIOR)) && reader(ev).length > 0, 'P1 a prior other than default_larva_begging_prior: rejected by engine and reader'); }
  { const ev = structuredClone(ev0); init(ev).legacy_begging_signal = 0.77; ok(reader(ev).length > 0, 'P2 an old value that is not the state\'s: rejected by the reader (the engine writes the record itself)'); }
  ok(/first-seen begging/.test(engine(ev0, d14.colonies[0], null)), 'P3 the old (colony-derived) value kept as the start-of-round begging while v29 is on: rejected by the engine');
  { const ev = structuredClone(ev0); for (const e of ev) if (e.type === 'brood_nutrition_record_initialized') { delete e.legacy_begging_signal; delete e.begging_signal_set; delete e.begging_basis; } ok(/first-seen begging/.test(engine(ev, d14.colonies[0], PRIOR)) && reader(ev).length > 0, 'P4 the prior applied without its record: rejected by engine and reader'); }
}

console.log(JSON.stringify({ test: 'c4a-begging-prior', checks, evidence, note: 'v2-review.29 candidate fix; the prior is a game assumption, not a measured hunger; first-day eligibility changes (model choice for the Owner)' }, null, 2));
