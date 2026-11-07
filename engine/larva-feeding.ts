/**
 * C4a (docs/design-c4-larval-nutrition.md §3, §3.1, §4.1, §4.2, §7.0 D1–D8; v2-review.28; switch
 * larval_feeding.individual_larva_body_c4a, which requires the C3a switch — D1).
 *
 * Every larva has its own nutrition account (`body`):
 *   fed_balance      what it was actually fed (feed_larva) − the metabolism it paid (larva_metabolism); known part only
 *   egg_investment   what its egg received when it was laid (C2 lay_egg), or null when that was not recorded (D2a: an
 *                    ACCOUNTING record — no embryonic use is simulated, it is not spendable, nothing reads it as food)
 *   reserve_at_hatch the reserve still usable at hatch: always null (unknown; never spent, filled in or read as 0)
 *   reserve_basis    egg_laid_with_record | egg_laid_before_switch | day0_scenario | unknown_at_migration (D8)
 * Because the reserve is unknown, the known balance OVERSTATES the larva's true shortfall (stated bound, not a result).
 *
 * The larva gets food only in the C3a nest round (same ordinal time, same named places; no second contact system):
 *   nest_move     a nurse walks to the brood place (from the queen, or from the store when there is no living queen)
 *   larva_contact the nurse meets ONE larva at that place, drawn uniformly among the larvae there in ID order from a stream
 *                 named by the nurse's ID (never by array position, Issue #56); larvae at another place cannot be met
 *   feed_larva    if THAT larva's begging signal (start of the round) is at or above the threshold, the nurse gives one
 *                 fixed bolus of each food it holds (sugar, liquid protein; at most one each per contact) from its own crop
 *                 (D4; R210 Solenopsis invicta, non-species: signal sets the feeding frequency, bolus size fixed; the
 *                 threshold and the bolus are game assumptions)
 * After the colony settlement the larva pays its own metabolism from fed_balance (D3; the colony pool no longer pays the
 * larval share); a shortfall is its own, recorded, and never borrowed from the colony. Its begging signal is then updated
 * from its OWN protein intake today against its OWN need (D6: protein only, as before). Development (L2) and starvation
 * death (L3) keep the old colony-wide formulas until C4b / C4c; their inputs change because the colony pool no longer
 * holds the larval share (reported in the diagnostics).
 *
 * Hatch (D2a): one larva_hatch_nutrition event records what the egg received (or null) and reserve_at_hatch null; no
 * transfer, no larva_yolk compartment, the egg:<id> account is unchanged. Pupation (D5): the balance stays with the
 * individual; at eclosion it is recorded as metabolized (brood_body_at_eclosion; engine rule, game assumption). A brood
 * item that dies takes its balance with the body (death_body_to_corpse -> loss:brood_corpse; a sink until C5).
 *
 * No worker, larva or queen reads any colony total, count, ratio or gap here (CLAUDE.md §2.1, §2.1b).
 */
import { clamp, round } from './math.ts';
import { BROOD_PLACE, colonyDice } from './workers.ts';
import { foodTransfer } from './transfers.ts';
import type { SpeciesParams } from './params.ts';
import { ownPaidFraction } from './larva-development.ts';
import type { Brood, ColonyState, LarvaBody, LarvaReserveBasis, SimEvent, Worker, WorldState } from './types.ts';

export { BROOD_PLACE };
type Food = { sugar: number; protein: number };
const FOODS = ['sugar', 'protein'] as const;
const larvaNeed = (sp: SpeciesParams, factor: number): Food => ({ sugar: round(sp.nutrition.larva_sugar_daily * factor), protein: round(sp.nutrition.larva_protein_daily * factor) });
const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
/** The larva's begging signal as it is at the start of the round (a larva that has never been updated has the prior). */
export const beggingNow = (b: Brood, sp: SpeciesParams): number => b.begging_signal ?? sp.local_signals.default_larva_begging_prior;

/** The basis a brood item gets when the switch first sees it without a record (D8). Day 0 of a world built by Day0
 *  initialization: day0_scenario; an egg the engine itself laid (its own origin label) before the switch:
 *  egg_laid_before_switch; anything else (Day14 migration, a world switched on later): unknown_at_migration. */
export const firstSeenBasis = (b: Brood, day0: boolean): LarvaReserveBasis =>
  day0 ? 'day0_scenario' : b.stage === 'egg' && b.origin === 'v2_scenario_laying' ? 'egg_laid_before_switch' : 'unknown_at_migration';

/** Gives every egg and larva without a C4a record one (D8), with an event; returns the IDs that had one before.
 *  v2-review.29 (`firstSeenPrior` a number, switch larval_feeding.first_seen_begging_prior_v29): a first-seen larva's begging
 *  is set to that explicit prior (default_larva_begging_prior, a game assumption, not a measured hunger); the old value —
 *  computed by the old rule from the colony protein fraction, or the migration default — is kept in the event only. */
export function ensureBroodRecords(colony: ColonyState, day0: boolean, events: SimEvent[], firstSeenPrior: number | null = null): Set<string> {
  const had = new Set<string>();
  for (const b of [...colony.population.brood].sort(byId)) {
    if (b.stage === 'egg') {
      if (b.reserve_basis !== undefined) { had.add(b.id); continue; }
      b.egg_investment = null; b.reserve_basis = firstSeenBasis(b, day0);
      events.push({ type: 'brood_nutrition_record_initialized', id: b.id, stage: 'egg', egg_investment: null, reserve_basis: b.reserve_basis, note: 'egg present when the C4a switch first applied: what it received at laying is not recorded (null)', assumption: true });
    } else if (b.stage === 'larva') {
      if (b.body) { had.add(b.id); continue; }
      b.body = { fed_balance: { sugar: 0, protein: 0 }, egg_investment: null, reserve_at_hatch: null, reserve_basis: firstSeenBasis(b, day0) };
      b.location ??= BROOD_PLACE;
      const prior = firstSeenPrior === null ? null : { legacy_begging_signal: b.begging_signal ?? null, begging_signal_set: firstSeenPrior, begging_basis: 'v2-review.29: explicit prior local_signals.default_larva_begging_prior (game assumption, not a measured hunger); the old value is kept here for tracing only' };
      if (firstSeenPrior !== null) b.begging_signal = firstSeenPrior;
      events.push({ type: 'brood_nutrition_record_initialized', id: b.id, stage: 'larva', location: b.location, fed_balance: { sugar: 0, protein: 0 }, egg_investment: null, reserve_at_hatch: null, reserve_basis: b.body.reserve_basis, ...(prior ?? {}), note: 'larva present when the C4a switch first applied: its account starts at 0 (D8); its reserve is unknown (null), so the known balance overstates its shortfall', assumption: true });
    } else had.add(b.id);
  }
  return had;
}

/** The record a laid egg gets (switch on): exactly what lay_egg moved into egg:<id>. */
export function recordEggInvestment(egg: Brood, investment: Food): void { egg.egg_investment = { sugar: round(investment.sugar), protein: round(investment.protein) }; egg.reserve_basis = 'egg_laid_with_record'; }

/** At hatch (D2a): the larva's account starts at 0; the egg's record moves into it; one event; no transfer. */
export function hatchRecord(b: Brood, events: SimEvent[]): void {
  const inherited = b.egg_investment === undefined ? null : b.egg_investment, basis: LarvaReserveBasis = b.reserve_basis ?? 'unknown_at_migration';
  b.body = { fed_balance: { sugar: 0, protein: 0 }, egg_investment: inherited === null ? null : { ...inherited }, reserve_at_hatch: null, reserve_basis: basis };
  delete b.egg_investment; delete b.reserve_basis;
  b.location ??= BROOD_PLACE;
  events.push({ type: 'larva_hatch_nutrition', larva: b.id, inherited: inherited === null ? null : { ...inherited }, reserve_at_hatch: null, reserve_basis: basis, fed_balance: { sugar: 0, protein: 0 }, location: b.location, note: 'accounting record only (D2a): what the egg received at laying; how much of it remains usable at hatch is unknown (null) and is never spent, filled in or read as 0; no embryonic use is simulated', assumption: true });
}

/** A brood item with an account leaves the brood (eclosion: metabolized, D5; death: with the body to the corpse sink). */
export function closeBroodBody(colony: ColonyState, b: Brood, how: 'eclosion' | 'death', events: SimEvent[]): void {
  if (!b.body) return;
  for (const f of FOODS) {
    const a = round(b.body.fed_balance[f]);
    if (how === 'eclosion') foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'larva_body', id: b.id }, recipient: { kind: 'metabolized', id: colony.id }, food_type: f, portions: a, cause: 'brood_body_at_eclosion', attribution: 'engine_rule', contact: { brood: b.id }, basis: 'D5 (game assumption): the known balance left at pupation stays with the individual and is recorded as metabolized at eclosion (its fate in the adult is C5)' });
    else foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'larva_body', id: b.id }, recipient: { kind: 'loss', id: 'brood_corpse' }, food_type: f, portions: a, cause: 'death_body_to_corpse', attribution: 'engine_rule', contact: { brood: b.id }, basis: 'a dead larva or pupa takes its known balance with the body (sink until C5 models corpses)' });
  }
}

export interface BroodLegResult { intake: Map<string, Food>; fed: Food; contacts: number }
/**
 * The brood leg of the nest round (ordinal 2 + u; u is the nurse's own C3a draw): walk to the brood place, meet one larva
 * there, maybe feed it. `from` is where the nurse is (the queen, or the store when there is no living queen); its
 * departure is 1.5 + u from the queen, 0.5 + u from the store.
 */
export function broodLeg(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[], nurses: { w: Worker; u: number }[], from: string): BroodLegResult {
  const lf = sp.larval_feeding, out: BroodLegResult = { intake: new Map(), fed: { sugar: 0, protein: 0 }, contacts: 0 }, day = world.sim_day + 1;
  const bolus: Food = { sugar: lf.feed_bolus_sugar_portions, protein: lf.feed_bolus_protein_portions };
  const here = colony.population.brood.filter((b) => b.stage === 'larva' && b.body && b.location === BROOD_PLACE).sort(byId);
  for (const { w, u } of nurses) events.push({ type: 'nest_move', worker: w.id, from, to: BROOD_PLACE, depart_ordinal: round(from === 'queen' ? 1.5 + u : 0.5 + u), arrive_ordinal: round(2 + u), time_scale: 'ordinal_nest_round', assumption: true });
  let n = 0;
  for (const { w, u } of nurses) {
    if (!here.length) continue;
    const t = round(2 + u), larva = here[Math.floor(colonyDice(world, colony, 'c4a_larva_contact:' + w.id)() * here.length)];
    const begging = round(beggingNow(larva, sp)), id = `LC-${day}-${colony.id}-${++n}`;
    events.push({ type: 'larva_contact', contact_event_id: id, worker: w.id, larva: larva.id, location: BROOD_PLACE, worker_location: BROOD_PLACE, larva_location: larva.location, ordinal: t, begging_signal: begging, feed_threshold_assumption: lf.feed_begging_threshold, larvae_at_place: here.length, time_scale: 'ordinal_nest_round', note: 'one larva drawn uniformly among the larvae at the same place (ID order, stream c4a_larva_contact:<worker>); more larvae at a place means fewer contacts each (D7 candidate dilution, reported)', assumption: true });
    out.contacts++;
    if (begging < lf.feed_begging_threshold) continue;
    for (const f of FOODS) {
      const held = f === 'sugar' ? w.crop_cargo_sugar || 0 : w.crop_cargo_protein_liquid || 0, a = round(Math.min(held, bolus[f]));
      if (a <= 0) continue;
      if (f === 'sugar') { w.crop_cargo_sugar = round(held - a); colony.stores.sugar = round(colony.stores.sugar - a); } else w.crop_cargo_protein_liquid = round(held - a);
      const body = larva.body as LarvaBody; body.fed_balance[f] = round(body.fed_balance[f] + a);
      const got = out.intake.get(larva.id) ?? { sugar: 0, protein: 0 }; got[f] = round(got[f] + a); out.intake.set(larva.id, got); out.fed[f] = round(out.fed[f] + a);
      foodTransfer(events, { minute: null, ordinal: t, phase: 'nest_round', source: { kind: 'crop', id: w.id }, recipient: { kind: 'larva_body', id: larva.id }, food_type: f, portions: a, cause: 'feed_larva', attribution: 'individual', ...(f === 'sugar' ? { nest_ledger_delta: round(-a) } : {}), contact: { contact_event_id: id, worker: w.id, larva: larva.id, location: BROOD_PLACE }, basis: 'D4: begging at or above the threshold -> one fixed bolus of each food the nurse holds (R210 S. invicta, non-species; bolus and threshold game assumptions)' });
    }
  }
  return out;
}

/** Each larva pays its own metabolism from fed_balance, then updates its begging from its own intake and need (D3, D6). */
export function larvaMetabolism(colony: ColonyState, sp: SpeciesParams, factor: number, intake: Map<string, Food>, events: SimEvent[]): { paid: Food; fraction: Map<string, number> } {
  const ls = sp.local_signals, need = larvaNeed(sp, factor), paidAll = { sugar: 0, protein: 0 }, fraction = new Map<string, number>();
  for (const b of [...colony.population.brood].filter((x) => x.stage === 'larva' && x.body).sort(byId)) {
    const body = b.body as LarvaBody, paid = { sugar: 0, protein: 0 }, shortfall = { sugar: 0, protein: 0 }, got = intake.get(b.id) ?? { sugar: 0, protein: 0 };
    for (const f of FOODS) {
      const a = round(Math.min(need[f], body.fed_balance[f]));
      body.fed_balance[f] = round(body.fed_balance[f] - a); paid[f] = a; shortfall[f] = round(need[f] - a); paidAll[f] = round(paidAll[f] + a);
      foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'larva_body', id: b.id }, recipient: { kind: 'metabolized', id: colony.id }, food_type: f, portions: a, cause: 'larva_metabolism', attribution: 'individual', contact: { larva: b.id }, basis: 'the larva\'s own metabolism from what it was fed (known balance only; the unknown reserve is never spent)' });
    }
    fraction.set(b.id, ownPaidFraction(paid, need)); // C4b reads this (own record only)
    const proteinShortfall = need.protein > 0 ? clamp(1 - got.protein / need.protein, 0, 1) : 0, before = beggingNow(b, sp);
    b.begging_signal = round(clamp(ls.larva_begging_previous_weight * before + ls.larva_begging_shortfall_weight * proteinShortfall, 0, 1));
    events.push({ type: 'larva_nutrition', larva: b.id, need_portions: { ...need }, intake_portions: { ...got }, paid_portions: paid, shortfall_portions: shortfall, fed_balance: { ...body.fed_balance }, reserve_at_hatch: null, reserve_basis: body.reserve_basis, begging_before: round(before), own_protein_shortfall_fraction: round(proteinShortfall), begging_signal: b.begging_signal, note: 'begging from the larva\'s own protein intake today against its own need (D6); development and starvation still use the old colony-wide rules (C4b/C4c). The reserve is unknown, so the known shortfall overstates the true one.', assumption: true });
  }
  return { paid: paidAll, fraction };
}

/** Start-of-day facts the C4a check needs (taken after the day's records are ensured, before the round). */
export interface LarvaRoundStart {
  workers: Set<string>; had: Set<string>; day0: boolean;
  /** crops at the start of the day (sugar, liquid protein); the check replays every transfer from here (review of the C4a draft) */
  crops: Map<string, Food>;
  brood: Map<string, { stage: string; progress?: number; location?: string; begging: number; beggingRaw?: number; body?: LarvaBody; egg_investment?: Food | null; reserve_basis?: LarvaReserveBasis; origin?: string }>;
}
export const larvaRoundStart = (colony: ColonyState, sp: SpeciesParams, had: Set<string>, day0: boolean): LarvaRoundStart => ({
  workers: new Set(colony.population.workers.map((w) => w.id)), had, day0,
  crops: new Map(colony.population.workers.map((w) => [w.id, { sugar: w.crop_cargo_sugar || 0, protein: w.crop_cargo_protein_liquid || 0 }])),
  brood: new Map(colony.population.brood.map((b) => [b.id, { stage: b.stage, progress: b.progress, location: b.location, begging: beggingNow(b, sp), beggingRaw: b.begging_signal, body: b.body ? structuredClone(b.body) : undefined, egg_investment: b.egg_investment === undefined ? undefined : b.egg_investment === null ? null : { ...b.egg_investment }, reserve_basis: b.reserve_basis, origin: b.origin }])),
});

/**
 * Engine check of a C4a day (A2, A4, A10, A11 in the engine; amounts and closure are C2's checkColonyFood). Throws LARVA_FEEDING.
 *   - records: every egg and larva lacking one at the start got exactly one initialization, with the basis the world and
 *     its own origin give; nothing else was initialized; reserve_at_hatch is null everywhere; a basis never changes;
 *   - contacts: a nurse present at the start, at the brood place on [arrival, departure), one per nurse; a larva that was
 *     a larva at the start with an account, at that same place;
 *   - feedings: each names an earlier contact of the same nurse and larva, at most one per contact and food, within the
 *     bolus, only when that larva's start-of-round begging was at or above the threshold;
 *   - metabolism: each larva pays exactly min(own need, own balance) per food, once; begging is recomputed from its own
 *     intake (the feed_larva records) and need — never from a colony quantity;
 *   - hatch: one record per hatch event, inheriting exactly the egg's start record; an egg laid today records exactly its
 *     lay_egg transfers; an egg's record never changes;
 *   - eclosion / death: the whole balance leaves with the individual.
 */
export function checkLarvaRound(start: LarvaRoundStart, colony: ColonyState, events: SimEvent[], sp: SpeciesParams, factor: number): void {
  const fail = (m: string) => { throw Error(`LARVA_FEEDING ${colony.id}: ${m}`); };
  const lf = sp.larval_feeding, need = larvaNeed(sp, factor), ls = sp.local_signals;
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  // records created today
  const inits = events.filter((e) => e.type === 'brood_nutrition_record_initialized');
  const initOf = new Map<string, SimEvent>();
  for (const e of inits) { const id = String(e.id); if (initOf.has(id)) fail(`brood ${id} initialized twice`); initOf.set(id, e); }
  for (const [id, b] of start.brood) {
    if (b.stage === 'pupa') { if (initOf.has(id)) fail(`pupa ${id} got a nutrition record`); continue; }
    const e = initOf.get(id);
    if (start.had.has(id)) { if (e) fail(`brood ${id} already had a record and was initialized again`); continue; }
    if (!e) fail(`brood ${id} (${b.stage}) has no record and no initialization event`);
    const ev = e as SimEvent, want = start.day0 ? 'day0_scenario' : b.stage === 'egg' && b.origin === 'v2_scenario_laying' ? 'egg_laid_before_switch' : 'unknown_at_migration';
    // v2-review.29: with the switch on a first-seen larva carries the explicit prior (and the event its old value); off, neither
    const v29 = sp.larval_feeding.first_seen_begging_prior_v29, pr = sp.local_signals.default_larva_begging_prior;
    if (b.stage === 'larva' && v29 && (ev.begging_signal_set !== pr || b.beggingRaw !== pr || !('legacy_begging_signal' in ev))) fail(`larva ${id}: first-seen begging ${JSON.stringify(b.beggingRaw)} / event ${JSON.stringify(ev.begging_signal_set)}; v2-review.29 sets the explicit prior ${pr} and records the old value`);
    if (b.stage === 'larva' && !v29 && ('begging_signal_set' in ev || 'legacy_begging_signal' in ev)) fail(`larva ${id}: a begging prior was set although first_seen_begging_prior_v29 is off`);
    if (ev.stage !== b.stage || ev.reserve_basis !== want || ev.egg_investment !== null || (b.stage === 'larva' && (!eq(ev.fed_balance, { sugar: 0, protein: 0 }) || ev.reserve_at_hatch !== null))) fail(`brood ${id} initialized as ${JSON.stringify(ev).slice(0, 200)}; the rules give ${b.stage} / ${want} / null / 0`);
    const rec = b.stage === 'larva' ? b.body : { egg_investment: b.egg_investment, reserve_basis: b.reserve_basis };
    if (b.stage === 'larva' ? !(b.body && b.body.reserve_basis === want && b.body.egg_investment === null && b.body.fed_balance.sugar === 0 && b.body.fed_balance.protein === 0) : !(b.egg_investment === null && b.reserve_basis === want)) fail(`brood ${id} record ${JSON.stringify(rec)} does not match its initialization`);
  }
  for (const id of initOf.keys()) if (!start.brood.has(id)) fail(`initialization for ${id}, which was not brood at the start`);
  // moves of the brood leg (from the events; the C3a check validates the whole move sequence)
  const atBrood = new Map<string, number>(), leaveBrood = new Map<string, number>();
  for (const e of events) if (e.type === 'nest_move') {
    const w = String(e.worker);
    if (e.to === BROOD_PLACE) { if (atBrood.has(w)) fail(`${w} walks to the brood twice`); atBrood.set(w, Number(e.arrive_ordinal)); }
    else if (e.from === BROOD_PLACE) { if (!atBrood.has(w) || leaveBrood.has(w)) fail(`${w} leaves the brood without being there`); leaveBrood.set(w, Number(e.depart_ordinal)); }
  }
  const deathAt = new Map<string, number>();
  events.forEach((e, i) => { if (e.type === 'worker_death' && !deathAt.has(String(e.id))) deathAt.set(String(e.id), i); });
  const contacts = new Map<string, { worker: string; larva: string; ordinal: number }>(), contactBy = new Set<string>(), fedKey = new Set<string>();
  const intake = new Map<string, Food>();
  // crops replayed transfer by transfer from the start of the day: what a nurse holds at its contact decides the bolus (D4:
  // exactly min(held, bolus) of each food it holds, when the larva's start-of-round begging is at or above the threshold)
  const held = new Map([...start.crops].map(([k, v]) => [k, { ...v }])), heldAtContact = new Map<string, Food>();
  const bolusOf = (f: 'sugar' | 'protein') => (f === 'sugar' ? lf.feed_bolus_sugar_portions : lf.feed_bolus_protein_portions);
  events.forEach((e, i) => {
    if (e.type === 'larva_contact') {
      const id = String(e.contact_event_id), w = String(e.worker), l = String(e.larva), b = start.brood.get(l);
      if (contacts.has(id)) fail(`contact ${id} recorded twice`);
      if (contactBy.has(w)) fail(`nurse ${w} contacts two larvae in one round`); contactBy.add(w);
      if (!start.workers.has(w)) fail(`contact ${id}: ${w} was not present at the start`);
      if (!b || b.stage !== 'larva' || !b.body) fail(`contact ${id}: ${l} was not a larva with an account at the start`);
      const bb = b as { location?: string; begging: number };
      if (e.location !== BROOD_PLACE || e.worker_location !== BROOD_PLACE || e.larva_location !== bb.location || bb.location !== BROOD_PLACE) fail(`contact ${id}: nurse at ${e.worker_location}, larva ${l} at ${bb.location}, contact at ${e.location} — not one place`);
      const t = Number(e.ordinal);
      if (!(atBrood.has(w) && t >= (atBrood.get(w) as number) && t < (leaveBrood.get(w) ?? Infinity))) fail(`contact ${id} at ${t}: ${w} is not at the brood (${atBrood.get(w)}..${leaveBrood.get(w)})`);
      if ((deathAt.get(w) ?? Infinity) < i) fail(`contact ${id} after the death of ${w}`);
      if (e.begging_signal !== round(bb.begging)) fail(`contact ${id}: records begging ${e.begging_signal}, the larva's start-of-round signal is ${bb.begging}`);
      contacts.set(id, { worker: w, larva: l, ordinal: t }); heldAtContact.set(id, { ...(held.get(w) ?? { sugar: 0, protein: 0 }) });
    } else if (e.type === 'food_transfer' && (e.cause === 'feed_larva' || (e.recipient as { kind?: string })?.kind === 'larva_body' || (e.source as { kind?: string })?.kind === 'larva_body')) {
      const x = e as unknown as { transfer_id: string; cause: string; ordinal: number; source: { kind: string; id: string }; recipient: { kind: string; id: string }; food_type: 'sugar' | 'protein'; portions: number; contact?: Record<string, unknown> };
      if (x.cause !== 'feed_larva') return;
      const before = held.get(x.source.id)?.[x.food_type] ?? 0;
      if (x.portions !== round(Math.min(before, bolusOf(x.food_type)))) fail(`${x.transfer_id}: feeds ${x.portions} ${x.food_type}; the nurse holds ${before}, so the fixed bolus gives min(held, ${bolusOf(x.food_type)}) = ${round(Math.min(before, bolusOf(x.food_type)))}`);
      const c = contacts.get(String(x.contact?.contact_event_id));
      if (!c) fail(`${x.transfer_id}: feed_larva without an earlier larva_contact (${x.contact?.contact_event_id})`);
      const cc = c as { worker: string; larva: string; ordinal: number };
      if (cc.worker !== x.source.id || cc.larva !== x.recipient.id) fail(`${x.transfer_id}: feeds ${x.source.id} -> ${x.recipient.id}, its contact is ${cc.worker} with ${cc.larva}`);
      if (x.ordinal < cc.ordinal || !(x.ordinal < (leaveBrood.get(x.source.id) ?? Infinity))) fail(`${x.transfer_id}: at ${x.ordinal}, outside the contact (${cc.ordinal}..${leaveBrood.get(x.source.id)})`);
      const k = `${x.contact?.contact_event_id}:${x.food_type}`; if (fedKey.has(k)) fail(`${x.transfer_id}: a second ${x.food_type} bolus in one contact`); fedKey.add(k);
      const bolus = x.food_type === 'sugar' ? lf.feed_bolus_sugar_portions : lf.feed_bolus_protein_portions;
      if (x.portions > bolus + 1e-9) fail(`${x.transfer_id}: ${x.portions} > the bolus ${bolus}`);
      if ((start.brood.get(cc.larva) as { begging: number }).begging < lf.feed_begging_threshold) fail(`${x.transfer_id}: fed although ${cc.larva}'s begging ${(start.brood.get(cc.larva) as { begging: number }).begging} is below the threshold ${lf.feed_begging_threshold}`);
      const g = intake.get(cc.larva) ?? { sugar: 0, protein: 0 }; g[x.food_type] = round(g[x.food_type] + x.portions); intake.set(cc.larva, g);
    }
    if (e.type === 'food_transfer') {
      const x = e as unknown as { source: { kind: string; id: string }; recipient: { kind: string; id: string }; food_type: 'sugar' | 'protein'; portions: number };
      for (const [r, sign] of [[x.source, -1], [x.recipient, 1]] as const) if (r.kind === 'crop') { const h = held.get(r.id) ?? { sugar: 0, protein: 0 }; h[x.food_type] = round(h[x.food_type] + sign * x.portions); held.set(r.id, h); }
    }
  });
  // a contact with a larva begging at or above the threshold gives one bolus of each food the nurse holds (none is skipped)
  for (const [id, c] of contacts) {
    if ((start.brood.get(c.larva) as { begging: number }).begging < lf.feed_begging_threshold) continue;
    const h = heldAtContact.get(id) as Food;
    for (const f of FOODS) if (round(Math.min(h[f], bolusOf(f))) > 0 && !fedKey.has(`${id}:${f}`)) fail(`contact ${id}: ${c.larva} begs at or above the threshold and ${c.worker} holds ${h[f]} ${f}, but no ${f} bolus was given`);
  }
  // metabolism and begging: each larva that was a larva with an account at the start
  const paid = new Map<string, Food>(), outOf = new Map<string, { eclosion: Food; death: Food }>();
  for (const e of events) if (e.type === 'food_transfer') {
    const x = e as unknown as { transfer_id: string; cause: string; source: { kind: string; id: string }; food_type: 'sugar' | 'protein'; portions: number };
    if (x.cause === 'larva_metabolism') { const p = paid.get(x.source.id) ?? { sugar: 0, protein: 0 }; if (p[x.food_type]) fail(`${x.transfer_id}: ${x.source.id} pays ${x.food_type} twice`); p[x.food_type] = x.portions; paid.set(x.source.id, p); }
    else if (x.cause === 'brood_body_at_eclosion' || x.cause === 'death_body_to_corpse') { const o = outOf.get(x.source.id) ?? { eclosion: { sugar: 0, protein: 0 }, death: { sugar: 0, protein: 0 } }; o[x.cause === 'death_body_to_corpse' ? 'death' : 'eclosion'][x.food_type] = round(o[x.cause === 'death_body_to_corpse' ? 'death' : 'eclosion'][x.food_type] + x.portions); outOf.set(x.source.id, o); }
  }
  const nutrition = new Map<string, SimEvent>();
  for (const e of events) if (e.type === 'larva_nutrition') { const id = String(e.larva); if (nutrition.has(id)) fail(`two larva_nutrition records for ${id}`); nutrition.set(id, e); }
  for (const id of nutrition.keys()) { const b = start.brood.get(id); if (!b || b.stage !== 'larva' || !b.body) fail(`larva_nutrition record for ${id}, which was not a larva with an account at the start`); }
  const endBrood = new Map(colony.population.brood.map((b) => [b.id, b]));
  const deaths = new Set(events.filter((e) => e.type === 'brood_death').map((e) => String(e.id))), eclosed = new Set(events.filter((e) => e.type === 'eclosion').map((e) => String(e.source_brood_id)));
  for (const [id, b] of start.brood) {
    if (b.stage !== 'larva' || !b.body) { if (nutrition.has(id) || paid.has(id)) fail(`${id} (${b.stage}) has a larva metabolism record`); continue; }
    const before = { sugar: round(b.body.fed_balance.sugar + (intake.get(id)?.sugar ?? 0)), protein: round(b.body.fed_balance.protein + (intake.get(id)?.protein ?? 0)) };
    const p = paid.get(id) ?? { sugar: 0, protein: 0 }, ev = nutrition.get(id);
    for (const f of FOODS) if (p[f] !== round(Math.min(need[f], before[f]))) fail(`larva ${id} paid ${p[f]} ${f}; the rule gives min(need ${need[f]}, own balance ${before[f]}) = ${round(Math.min(need[f], before[f]))}`);
    if (!ev) { fail(`larva ${id} has no larva_nutrition record`); continue; }
    const got = intake.get(id) ?? { sugar: 0, protein: 0 }, short = need.protein > 0 ? clamp(1 - got.protein / need.protein, 0, 1) : 0;
    const want = round(clamp(ls.larva_begging_previous_weight * b.begging + ls.larva_begging_shortfall_weight * short, 0, 1));
    if (ev.begging_signal !== want || !eq(ev.intake_portions, got)) fail(`larva ${id}: begging ${ev.begging_signal} from intake ${JSON.stringify(ev.intake_portions)}; its own records give ${want} from ${JSON.stringify(got)}`);
    const after = { sugar: round(before.sugar - p.sugar), protein: round(before.protein - p.protein) }, e = endBrood.get(id);
    if (e) { if (!eq(e.body?.fed_balance, after) || e.begging_signal !== want) fail(`larva ${id}: end account ${JSON.stringify(e.body?.fed_balance)} / begging ${e.begging_signal}, the day gives ${JSON.stringify(after)} / ${want}`); }
    else if (deaths.has(id)) { const o = outOf.get(id)?.death ?? { sugar: 0, protein: 0 }; if (!eq(o, after)) fail(`larva ${id} died with ${JSON.stringify(after)}; ${JSON.stringify(o)} left with the body`); }
    else fail(`larva ${id} with an account vanished without death`);
  }
  // pupae with an account (D5): unchanged until eclosion, then the whole balance is metabolized
  for (const [id, b] of start.brood) if (b.stage === 'pupa' && b.body) {
    const e = endBrood.get(id), o = outOf.get(id);
    if (e) { if (!eq(e.body, b.body) || o) fail(`pupa ${id}: account changed (${JSON.stringify(b.body?.fed_balance)} -> ${JSON.stringify(e.body?.fed_balance)})`); }
    else if (eclosed.has(id)) { if (!eq(o?.eclosion ?? { sugar: 0, protein: 0 }, b.body.fed_balance)) fail(`pupa ${id} eclosed with ${JSON.stringify(b.body.fed_balance)}; ${JSON.stringify(o?.eclosion)} was recorded as metabolized`); }
    else if (deaths.has(id)) { if (!eq(o?.death ?? { sugar: 0, protein: 0 }, b.body.fed_balance)) fail(`pupa ${id} died with ${JSON.stringify(b.body.fed_balance)}; ${JSON.stringify(o?.death)} left with the body`); }
  }
  // hatch records (D2a)
  const hatched = events.filter((e) => e.type === 'hatch').map((e) => String(e.id)), hatchRec = new Map<string, SimEvent>();
  for (const e of events) if (e.type === 'larva_hatch_nutrition') { if (hatchRec.has(String(e.larva))) fail(`two hatch records for ${e.larva}`); hatchRec.set(String(e.larva), e); }
  for (const id of hatchRec.keys()) if (!hatched.includes(id)) fail(`hatch record for ${id}, which did not hatch today`);
  for (const id of hatched) {
    const e = hatchRec.get(id), b0 = start.brood.get(id), b1 = endBrood.get(id);
    if (!e) { fail(`larva ${id} hatched without a hatch record`); continue; }
    const inherited = b0?.egg_investment ?? null, basis = b0?.reserve_basis;
    if (!eq(e.inherited, inherited) || e.reserve_at_hatch !== null || e.reserve_basis !== basis) fail(`hatch record of ${id}: inherited ${JSON.stringify(e.inherited)} / reserve ${JSON.stringify(e.reserve_at_hatch)} / ${e.reserve_basis}; its egg's record is ${JSON.stringify(inherited)} / null / ${basis}`);
    if (b1 && !eq(b1.body, { fed_balance: { sugar: 0, protein: 0 }, egg_investment: inherited, reserve_at_hatch: null, reserve_basis: basis })) fail(`hatched larva ${id} has the account ${JSON.stringify(b1.body)}`);
  }
  // egg records: an egg laid today records exactly its lay_egg transfers; a start egg's record never changes
  const laid = new Map<string, Food>();
  for (const e of events) if (e.type === 'food_transfer' && e.cause === 'lay_egg') { const x = e as unknown as { recipient: { id: string }; food_type: 'sugar' | 'protein'; portions: number }; const g = laid.get(x.recipient.id) ?? { sugar: 0, protein: 0 }; g[x.food_type] = round(g[x.food_type] + x.portions); laid.set(x.recipient.id, g); }
  // Codex review of d9cd0cd (P2): every field C4a owns is carried unchanged unless a recorded event changes it — the place
  // (it decides tomorrow's contacts), the account's record fields and the begging signal. Allowed changes: a hatch (the
  // hatch rule gives the place 'brood' when the egg had none and moves the egg record into the account), the larva's own
  // begging and balance update (checked above). Nothing else may move a larva or rewrite where its record came from.
  const hatchedToday = new Set(hatched);
  for (const b of colony.population.brood) {
    const s0 = start.brood.get(b.id);
    if (!s0) { if (b.location !== undefined || b.body || b.begging_signal !== undefined) fail(`egg ${b.id} laid today carries a place, an account or a begging signal`); continue; }
    const wantPlace = s0.location ?? (hatchedToday.has(b.id) ? BROOD_PLACE : undefined);
    if (b.location !== wantPlace) fail(`${b.id}: place ${JSON.stringify(s0.location)} -> ${JSON.stringify(b.location)} without any event that moves brood`);
    if (s0.body) { const rec = (x: LarvaBody) => JSON.stringify([x.egg_investment, x.reserve_at_hatch, x.reserve_basis]); if (!b.body || rec(b.body) !== rec(s0.body)) fail(`${b.id}: account record ${rec(s0.body)} -> ${b.body ? rec(b.body) : 'removed'} without an event`); }
    if (!(s0.stage === 'larva' && s0.body) && b.begging_signal !== s0.beggingRaw) fail(`${b.id} (${s0.stage}): begging ${JSON.stringify(s0.beggingRaw)} -> ${JSON.stringify(b.begging_signal)}; only a larva with an account updates its own`);
  }
  for (const b of colony.population.brood) {
    if (b.body && b.body.reserve_at_hatch !== null) fail(`${b.id}: reserve_at_hatch ${JSON.stringify(b.body.reserve_at_hatch)} (it is unknown: always null)`);
    if (b.body) for (const f of FOODS) if (!(b.body.fed_balance[f] >= 0)) fail(`${b.id}: fed_balance ${f} ${b.body.fed_balance[f]}`);
    const s0 = start.brood.get(b.id);
    if (b.body && s0?.body && b.body.reserve_basis !== s0.body.reserve_basis) fail(`${b.id}: reserve basis changed ${s0.body.reserve_basis} -> ${b.body.reserve_basis}`);
    if (b.stage === 'egg') {
      if (!s0) { if (!eq(b.egg_investment, laid.get(b.id) ?? null) || b.reserve_basis !== 'egg_laid_with_record') fail(`egg ${b.id} laid today records ${JSON.stringify(b.egg_investment)} / ${b.reserve_basis}; lay_egg moved ${JSON.stringify(laid.get(b.id))}`); }
      else if (!eq(b.egg_investment, s0.egg_investment) || b.reserve_basis !== s0.reserve_basis) fail(`egg ${b.id}: record changed ${JSON.stringify(s0.egg_investment)} -> ${JSON.stringify(b.egg_investment)}`);
    }
    if (b.stage !== 'egg' && (b.egg_investment !== undefined || b.reserve_basis !== undefined)) fail(`${b.id} (${b.stage}) still carries an egg record outside its account`);
  }
}
