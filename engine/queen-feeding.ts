/**
 * C3a (docs/design-c3-queen-feeding.md §9, §10, §12; v2-review.25; switch queen_feeding.individual_queen_body_c3a).
 *
 * The queen gets food only through local events that have a source, an ordinal time and a place:
 *   take_from_cache  a nurse at the protein store sucks the liquid part of solid protein into its crop (route B1, candidate)
 *   nest_move        the nurse walks store -> queen
 *   queen_contact    nurse and queen at the same place
 *   feed_queen       trophallaxis crop -> queen_body (sugar, or liquid protein), one per contact and food
 *   queen_self_feed  the queen eats protein that lies where she is (route C, candidate; only when store and queen share a place)
 *   return_to_cache  liquid protein a nurse still holds after the queen goes back to the store at the end of the round
 *                    (design §4 'put back'; D): crops hold liquid protein only within the round, never into the next day
 * and pays her own metabolism from what she has eaten (known_balance); a shortfall is HER deficit only (recorded, not
 * used: laying and survival keep the old rules until C3b/C3c).
 *
 * TRANSITIONAL MODEL (D): three named nest places (store, queen, brood) and an ORDINAL time within one nest round (each
 * nurse draws its arrival from a stream named by its own ID; ties by ID — never by array position, Issue #56). This is not
 * nest geometry and not physical contact. The interface (worker ID, queen ID, place, contact event ID, ordinal, holding,
 * transfer) is the contract a later physics contact system must fill (docs/design-c3-queen-feeding.md §14); C3a does not
 * read any physics module.
 *
 * Decisions: a nurse takes from the store it stands at (it perceives only that store's food — one store per nest), without
 * any signal of the queen's need (D: every nurse at the nest visits the queen each day); the queen refuses by her own known
 * balance. No colony total, count or ratio is read. The candidate routes are NOT established natural mechanisms of P. megacephala (Sanders et al.
 * 1992: "The feeding of protein to queens by workers was not observed").
 */
import { round } from './math.ts';
import { colonyDice } from './workers.ts';
import { foodTransfer } from './transfers.ts';
import type { SpeciesParams } from './params.ts';
import type { ColonyState, QueenRecord, SimEvent, Worker, WorldState } from './types.ts';

/** Food a worker holds in its crop, both kinds (shared capacity, §12.3). Without C3a the liquid protein is absent (0). */
export const cropHeld = (w: Worker): number => (w.crop_cargo_sugar || 0) + (w.crop_cargo_protein_liquid || 0);

export const QUEEN_PLACE = 'queen';
export const storePlace = (sp: SpeciesParams): string => (sp.queen_feeding.store_is_queen_location ? QUEEN_PLACE : 'store');
const dailyNeed = (sp: SpeciesParams) => ({ sugar: sp.nutrition.queen_sugar_daily, protein: sp.nutrition.queen_protein_daily });

/**
 * The colony's queen record, created once (C3a on). A Day0 experiment world on its first day: basis day0_scenario, unknown
 * reserve not_applicable, known reserve k × her daily need (k a D assumption, swept). Any other world (Day14 migration,
 * or a Day0 world switched on later): basis unknown_at_migration, unknown reserve null, known balance 0 — the null is
 * never spent, filled in or read as 0 (§12.4). Recorded as an event; no food appears from nowhere after day 0.
 */
/** The initialization mode a queen record created on this world-day must have, from the world itself (never from an event):
 *  day0_scenario only on day 0 of a world built by Day0 initialization; otherwise unknown_at_migration (Codex R7-01). */
export const expectedInitBasis = (world: { sim_day: number; migration_log?: unknown[] }): 'day0_scenario' | 'unknown_at_migration' =>
  world.sim_day === 0 && (world.migration_log ?? []).some((m) => (m as { type?: string }).type === 'day0_initialization') ? 'day0_scenario' : 'unknown_at_migration';
export function ensureQueens(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[]): void {
  if (colony.population.queens) return;
  const day0 = expectedInitBasis(world) === 'day0_scenario';
  const k = sp.queen_feeding.day0_initial_reserve_days_of_need, need = dailyNeed(sp);
  const q: QueenRecord = {
    id: colony.queen_id, location: QUEEN_PLACE,
    body: day0 ? { unknown_initial_reserve: 'not_applicable', known_balance: { sugar: round(k * need.sugar), protein: round(k * need.protein) }, basis: 'day0_scenario' }
      : { unknown_initial_reserve: null, known_balance: { sugar: 0, protein: 0 }, basis: 'unknown_at_migration' },
    days_unfed: 0, days_without_worker_contact: 0, shortfall_today: { sugar: 0, protein: 0 },
  };
  colony.population.queens = [q];
  events.push({ type: 'queen_body_initialized', queen: q.id, basis: q.body.basis, unknown_initial_reserve: q.body.unknown_initial_reserve, known_balance: { ...q.body.known_balance }, reserve_days_of_need_assumption: day0 ? k : null, assumption: true });
}

export interface RoundResult { taken_from_cache: number; returned_to_cache: number; fed: { sugar: number; protein: number }; self_fed: number; contacts: number }

/** One nest round (ordinal time) before the old settlement (§12.1 D). Returns what left the old ledger scope. */
export function nestRound(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[]): RoundResult {
  const out: RoundResult = { taken_from_cache: 0, returned_to_cache: 0, fed: { sugar: 0, protein: 0 }, self_fed: 0, contacts: 0 };
  const q = colony.population.queens?.[0], qf = sp.queen_feeding, nest = colony.nest_node, cap = sp.trophallaxis.crop_capacity;
  if (!q || !colony.population.queen_alive) return out;
  const store = storePlace(sp), need = dailyNeed(sp), day = world.sim_day + 1;
  const satiated = (f: 'sugar' | 'protein') => q.body.known_balance[f] >= qf.queen_satiation_days_of_need * need[f];
  // nurses at the nest take part; each draws its own arrival (stream named by its ID), ties by ID (not array order)
  const nurses = colony.population.workers.filter((w) => w.task === 'nurse' && w.last_location === nest)
    .map((w) => ({ w, u: round(colonyDice(world, colony, 'c3a_nest_round:' + w.id)()) }))
    .sort((a, b) => a.u - b.u || (a.w.id < b.w.id ? -1 : a.w.id > b.w.id ? 1 : 0));
  let intake = 0, n = 0;
  // at the store (ordinal u): route B1 — the nurse sees the solid protein only because it stands at it
  for (const { w, u } of nurses) {
    if (qf.route_b1) {
      const a = round(Math.min(qf.take_from_cache_max_portions, Math.max(0, cap - cropHeld(w)), colony.stores.protein));
      if (a > 0) {
        w.crop_cargo_protein_liquid = round((w.crop_cargo_protein_liquid || 0) + a); colony.stores.protein = round(colony.stores.protein - a); out.taken_from_cache = round(out.taken_from_cache + a);
        foodTransfer(events, { minute: null, ordinal: u, phase: 'nest_round', source: { kind: 'cache', id: nest }, recipient: { kind: 'crop', id: w.id }, food_type: 'protein', portions: a, cause: 'take_from_cache', attribution: 'individual', nest_ledger_delta: round(-a), contact: { worker: w.id, location: store }, basis: 'candidate route B1 (D: 1 portion of solid gives 1 portion of liquid)' });
      }
    }
    events.push({ type: 'nest_move', worker: w.id, from: store, to: QUEEN_PLACE, depart_ordinal: round(u + 0.5), arrive_ordinal: round(1 + u), time_scale: 'ordinal_nest_round', assumption: true });
  }
  // at the queen (ordinal 1 + u): contact, then at most one feeding per contact and food
  for (const { w, u } of nurses) {
    const t = round(1 + u), contactId = `QC-${day}-${colony.id}-${++n}`;
    events.push({ type: 'queen_contact', contact_event_id: contactId, worker: w.id, queen: q.id, location: QUEEN_PLACE, worker_location: QUEEN_PLACE, queen_location: q.location, ordinal: t, time_scale: 'ordinal_nest_round', assumption: true });
    out.contacts++;
    for (const f of ['sugar', 'protein'] as const) {
      const held = f === 'sugar' ? w.crop_cargo_sugar || 0 : w.crop_cargo_protein_liquid || 0;
      if (held <= 0) continue;
      if (satiated(f)) { events.push({ type: 'queen_feeding_refused', contact_event_id: contactId, worker: w.id, queen: q.id, food_type: f, ordinal: t, reason: 'queen own known balance at the satiation threshold (D)', assumption: true }); continue; }
      const a = round(Math.min(held, qf.feed_max_portions_per_contact));
      if (a <= 0) continue;
      if (f === 'sugar') { w.crop_cargo_sugar = round(held - a); colony.stores.sugar = round(colony.stores.sugar - a); } else w.crop_cargo_protein_liquid = round(held - a);
      q.body.known_balance[f] = round(q.body.known_balance[f] + a); out.fed[f] = round(out.fed[f] + a); intake++;
      foodTransfer(events, { minute: null, ordinal: t, phase: 'nest_round', source: { kind: 'crop', id: w.id }, recipient: { kind: 'queen_body', id: q.id }, food_type: f, portions: a, cause: 'feed_queen', attribution: 'individual', ...(f === 'sugar' ? { nest_ledger_delta: round(-a) } : {}), contact: { contact_event_id: contactId, worker: w.id, queen: q.id, location: QUEEN_PLACE } });
    }
  }
  // route C: the queen eats protein that lies where she is (only if the store is her place, D), at the end of the round
  if (qf.route_c_self_feed && store === q.location && !satiated('protein')) {
    const a = round(Math.min(qf.self_feed_max_portions, colony.stores.protein));
    if (a > 0) {
      colony.stores.protein = round(colony.stores.protein - a); q.body.known_balance.protein = round(q.body.known_balance.protein + a); out.self_fed = a; intake++;
      events.push({ type: 'queen_encounter_food', queen: q.id, location: q.location, food_location: store, ordinal: 2, assumption: true });
      foodTransfer(events, { minute: null, ordinal: 2, phase: 'nest_round', source: { kind: 'cache', id: nest }, recipient: { kind: 'queen_body', id: q.id }, food_type: 'protein', portions: a, cause: 'queen_self_feed', attribution: 'individual', nest_ledger_delta: round(-a), contact: { queen: q.id, location: q.location, food_location: store }, basis: 'candidate route C (Chang 1985: the queen can forage for herself)' });
    }
  }
  // put back (ordinal 3 + u): liquid protein still held goes back to the store; the crop is empty of it after the round
  if (store !== QUEEN_PLACE) for (const { w, u } of nurses) if ((w.crop_cargo_protein_liquid || 0) > 0) events.push({ type: 'nest_move', worker: w.id, from: QUEEN_PLACE, to: store, depart_ordinal: round(2.5 + u), arrive_ordinal: round(3 + u), time_scale: 'ordinal_nest_round', assumption: true });
  for (const { w, u } of nurses) {
    const a = round(w.crop_cargo_protein_liquid || 0);
    if (a <= 0) continue;
    w.crop_cargo_protein_liquid = 0; colony.stores.protein = round(colony.stores.protein + a); out.returned_to_cache = round(out.returned_to_cache + a);
    foodTransfer(events, { minute: null, ordinal: round(3 + u), phase: 'nest_round', source: { kind: 'crop', id: w.id }, recipient: { kind: 'cache', id: nest }, food_type: 'protein', portions: a, cause: 'return_to_cache', attribution: 'individual', nest_ledger_delta: a, contact: { worker: w.id, location: store }, basis: 'unfed liquid protein put back at the store at the end of the round (design §4; D)' });
  }
  for (const { w } of nurses) if (w.crop_cargo_protein_liquid === 0) delete w.crop_cargo_protein_liquid;
  q.days_unfed = intake > 0 ? 0 : q.days_unfed + 1;
  q.days_without_worker_contact = out.contacts > 0 ? 0 : q.days_without_worker_contact + 1;
  return out;
}

/** The queen pays her own metabolism from known_balance only (after the old colony metabolism, which no longer has her share). */
export function queenMetabolism(colony: ColonyState, sp: SpeciesParams, metabolicFactor: number, events: SimEvent[]): { sugar: number; protein: number } {
  const q = colony.population.queens?.[0], paid = { sugar: 0, protein: 0 };
  if (!q || !colony.population.queen_alive) return paid;
  const need = dailyNeed(sp);
  for (const f of ['sugar', 'protein'] as const) {
    const want = round(need[f] * metabolicFactor), got = round(Math.min(want, q.body.known_balance[f]));
    q.body.known_balance[f] = round(q.body.known_balance[f] - got); q.shortfall_today[f] = round(want - got); paid[f] = got;
    foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'queen_body', id: q.id }, recipient: { kind: 'metabolized', id: colony.id }, food_type: f, portions: got, cause: 'queen_metabolism', attribution: 'individual', contact: { queen: q.id }, basis: 'the queen\'s own metabolism from what she has eaten (known balance only; the unknown reserve is never spent)' });
  }
  events.push({ type: 'queen_nutrition', queen: q.id, need_portions: { sugar: round(need.sugar * metabolicFactor), protein: round(need.protein * metabolicFactor) }, paid_portions: paid, shortfall_portions: { ...q.shortfall_today }, known_balance: { ...q.body.known_balance }, unknown_initial_reserve: q.body.unknown_initial_reserve, basis: q.body.basis, days_unfed: q.days_unfed, days_without_worker_contact: q.days_without_worker_contact, note: 'C3a records the queen\'s own deficit only; laying and survival still use the old colony-wide rules (C3b/C3c). Under unknown_at_migration the known-only bound overstates the deficit (D).', assumption: true });
  return paid;
}

/** Start-of-day facts the round check needs (taken before the day). */
export interface QueenRoundStart { workers: Set<string>; had_record: boolean; expected_init_basis: 'day0_scenario' | 'unknown_at_migration'; crops: Map<string, { sugar: number; protein: number }>; queen: { id: string; alive: boolean; unknown: QueenRecord['body']['unknown_initial_reserve'] | undefined; basis: string | undefined } }
/** Start-of-day facts; `hadRecord`: whether the queen record existed before this day's ensureQueens (Codex R6-01). */
export const queenRoundStart = (colony: ColonyState, hadRecord: boolean, expectedBasis: 'day0_scenario' | 'unknown_at_migration'): QueenRoundStart => ({ workers: new Set(colony.population.workers.map((w) => w.id)), had_record: hadRecord, expected_init_basis: expectedBasis, crops: new Map(colony.population.workers.map((w) => [w.id, { sugar: w.crop_cargo_sugar || 0, protein: w.crop_cargo_protein_liquid || 0 }])), queen: { id: colony.queen_id, alive: colony.population.queen_alive, unknown: colony.population.queens?.[0]?.body.unknown_initial_reserve, basis: colony.population.queens?.[0]?.body.basis } });

/**
 * Engine check of a C3a day (N4–N8, N12, N13, N14, N16; the amounts and paths are C2's checkColonyFood). Throws QUEEN_FEEDING.
 *   - a contact names a worker present at the start (the round precedes deaths and eclosions) and the living queen of
 *     this colony, at one place where both are; one contact per worker per round; the worker arrived there no later;
 *   - every feed_queen names a contact of the same worker and queen, at or after it, at most one per contact and food;
 *   - a take_from_cache happens at the store before the worker leaves it;
 *   - a self-feed happens where the queen is and the food is;
 *   - no round transfer after the worker's death event; crops within the shared capacity;
 *   - the unknown reserve never changes (null stays null); known balances never negative; a migrated queen has null.
 */
export function checkQueenRound(start: QueenRoundStart, colony: ColonyState, events: SimEvent[], sp: SpeciesParams): void {
  const fail = (m: string) => { throw Error(`QUEEN_FEEDING ${colony.id}: ${m}`); };
  const q = colony.population.queens?.[0];
  if (!q) fail('C3a is on but the colony has no queen record');
  const queen = q as QueenRecord, store = storePlace(sp);
  if (queen.id !== colony.queen_id) fail(`queen record ${queen.id} is not the colony's queen ${colony.queen_id}`);
  if (start.queen.unknown !== undefined && queen.body.unknown_initial_reserve !== start.queen.unknown) fail(`the unknown initial reserve changed from ${JSON.stringify(start.queen.unknown)} to ${JSON.stringify(queen.body.unknown_initial_reserve)} (it is never spent or filled in)`);
  if (queen.body.basis === 'unknown_at_migration' && queen.body.unknown_initial_reserve !== null) fail(`a migrated queen's unknown reserve is ${JSON.stringify(queen.body.unknown_initial_reserve)}, not null`);
  for (const f of ['sugar', 'protein'] as const) { const v = queen.body.known_balance[f]; if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail(`queen known balance ${f} = ${v}`); }
  for (const w of colony.population.workers) if (cropHeld(w) > sp.trophallaxis.crop_capacity + 1e-9) fail(`worker ${w.id} holds ${cropHeld(w)} > crop capacity ${sp.trophallaxis.crop_capacity} (sugar + liquid protein share one crop)`);
  const arrive = new Map<string, number>(), depart = new Map<string, number>(), contacts = new Map<string, { worker: string; queen: string; ordinal: number }>();
  const deathAt = new Map<string, number>();
  events.forEach((e, i) => { if (e.type === 'worker_death' && !deathAt.has(String(e.id))) deathAt.set(String(e.id), i); });
  const fed = new Set<string>(), took = new Set<string>();
  // the queen record's creation (review of 888515c, P2): a migrated queen starts with an unknown (null) reserve and a known
  // balance of 0; a Day0 queen on day 0 with k × her daily need — nothing else may appear from nowhere
  // Codex review of 9d2933f (R6-01): a record created today needs exactly one initialization event of this colony's queen;
  // a record that already existed needs none
  const inits = events.filter((e) => e.type === 'queen_body_initialized');
  if (!start.had_record && (inits.length !== 1 || inits[0].queen !== colony.queen_id)) fail(`the queen record was created today with ${inits.length} initialization event(s) (needs exactly one, for ${colony.queen_id})`);
  if (start.had_record && inits.length) fail(`an initialization event for a queen record that already existed`);
  // Codex review of 9d2933f (R6-02): the shared crop capacity holds after EVERY transfer, not only at the end of the day
  const cap = sp.trophallaxis.crop_capacity, held = new Map([...start.crops].map(([k, v]) => [k, { ...v }]));
  for (const e of events) if (e.type === 'food_transfer') {
    const x = e as unknown as { transfer_id: string; source: { kind: string; id: string }; recipient: { kind: string; id: string }; food_type: 'sugar' | 'protein'; portions: number };
    for (const [r, sign] of [[x.source, -1], [x.recipient, 1]] as const) {
      if (r.kind !== 'crop') continue;
      const h = held.get(r.id) ?? { sugar: 0, protein: 0 }; h[x.food_type] = round(h[x.food_type] + sign * x.portions); held.set(r.id, h);
      if (h.sugar < -1e-9 || h.protein < -1e-9 || h.sugar + h.protein > cap + 1e-9) fail(`${x.transfer_id}: crop of ${r.id} holds sugar ${h.sugar} + liquid protein ${h.protein} after it (shared capacity ${cap})`);
    }
  }
  for (const e of events) if (e.type === 'queen_body_initialized') {
    const kb = e.known_balance as { sugar: number; protein: number }, k = sp.queen_feeding.day0_initial_reserve_days_of_need, need = dailyNeed(sp);
    const want = e.basis === 'unknown_at_migration' ? { sugar: 0, protein: 0, unknown: null } : e.basis === 'day0_scenario' ? { sugar: round(k * need.sugar), protein: round(k * need.protein), unknown: 'not_applicable' } : null;
    if (!want || kb?.sugar !== want.sugar || kb?.protein !== want.protein || e.unknown_initial_reserve !== want.unknown) fail(`queen record created with ${JSON.stringify(e)}, the rules give ${JSON.stringify(want)}`);
    // Codex review of 1a4c6af (R7-01): the mode comes from the world, not from the event; event and record must agree with it
    if (e.basis !== start.expected_init_basis) fail(`queen record initialized as ${e.basis}; this world-day allows only ${start.expected_init_basis}`);
    if (queen.body.basis !== e.basis) fail(`queen record has basis ${queen.body.basis}, its initialization event says ${e.basis}`);
  }
  // the participants are nurses at the nest (read from the state, not from the events' own fields; a worker that died later
  // in the day is not in the end state and cannot be checked here — stated limit)
  const nestOf = new Map(colony.population.workers.map((w) => [w.id, w]));
  for (const w of colony.population.workers) if ((w.crop_cargo_protein_liquid || 0) > 0) fail(`worker ${w.id} still holds ${w.crop_cargo_protein_liquid} liquid protein after the nest round (it is put back)`);
  // moves first (a take at the store is written before the move): out store -> queen, optionally back queen -> store
  const back = new Map<string, number>(), leaveQueen = new Map<string, number>();
  for (const e of events) if (e.type === 'nest_move') {
    const w = String(e.worker), ww = nestOf.get(w);
    if (!start.workers.has(w)) fail(`nest_move of ${w}, who was not in the nest round`);
    if (ww && (ww.task !== 'nurse' || ww.last_location !== colony.nest_node)) fail(`nest_move of ${w}, task ${ww.task} at ${ww.last_location}: only nurses at the nest take part`);
    if (!(Number(e.arrive_ordinal) >= Number(e.depart_ordinal))) fail(`nest_move of ${w} arrives before it leaves`);
    if (!depart.has(w)) {
      if (e.from !== store || e.to !== QUEEN_PLACE) fail(`first nest_move of ${w} is ${e.from} -> ${e.to}`);
      depart.set(w, Number(e.depart_ordinal)); arrive.set(w, Number(e.arrive_ordinal));
    } else if (!back.has(w) && e.from === QUEEN_PLACE && e.to === store && Number(e.depart_ordinal) >= (arrive.get(w) as number)) { back.set(w, Number(e.arrive_ordinal)); leaveQueen.set(w, Number(e.depart_ordinal)); }
    else fail(`worker ${w} moves ${e.from} -> ${e.to} a further time in one round`);
  }
  events.forEach((e, i) => {
    if (e.type === 'queen_contact') {
      const w = String(e.worker), id = String(e.contact_event_id);
      if (contacts.has(id)) fail(`contact ${id} recorded twice`);
      if ([...contacts.values()].some((c) => c.worker === w)) fail(`worker ${w} contacts the queen twice in one round`);
      if (!start.workers.has(w)) fail(`contact ${id}: worker ${w} did not exist at the start of the round`);
      if (e.queen !== colony.queen_id || !start.queen.alive) fail(`contact ${id}: queen ${e.queen} is not this colony's living queen`);
      if (e.location !== e.worker_location || e.location !== e.queen_location || e.queen_location !== queen.location) fail(`contact ${id}: worker at ${e.worker_location}, queen at ${e.queen_location}, contact at ${e.location} — not one place`);
      if (!(arrive.has(w) && Number(e.ordinal) >= (arrive.get(w) as number))) fail(`contact ${id} at ${e.ordinal}: worker ${w} has not arrived at the queen (arrival ${arrive.get(w)})`);
      // Codex review of 9d2933f (R6-03): present at the queen only on [arrival, departure back to the store)
      if (!(Number(e.ordinal) < (leaveQueen.get(w) ?? Infinity))) fail(`contact ${id} at ${e.ordinal}: worker ${w} left the queen at ${leaveQueen.get(w)}`);
      if ((deathAt.get(w) ?? Infinity) < i) fail(`contact ${id} after the death of ${w}`);
      contacts.set(id, { worker: w, queen: String(e.queen), ordinal: Number(e.ordinal) });
    } else if (e.type === 'food_transfer' && e.phase === 'nest_round') {
      const x = e as unknown as { transfer_id: string; cause: string; ordinal: number; source: { kind: string; id: string }; recipient: { kind: string; id: string }; food_type: string; contact?: Record<string, unknown> };
      const holder = x.source.kind === 'crop' ? x.source.id : x.recipient.kind === 'crop' ? x.recipient.id : null;
      if (holder && (deathAt.get(holder) ?? Infinity) < i) fail(`${x.transfer_id}: ${x.cause} by ${holder} after its death`);
      if (x.cause === 'take_from_cache') {
        if (took.has(x.recipient.id)) fail(`${x.transfer_id}: ${x.recipient.id} takes from the store twice`); took.add(x.recipient.id);
        if (x.contact?.location !== store) fail(`${x.transfer_id}: take_from_cache at ${x.contact?.location}, the store is at ${store}`);
        if (!(depart.has(x.recipient.id) && x.ordinal < (depart.get(x.recipient.id) as number))) fail(`${x.transfer_id}: taken at ${x.ordinal}, after ${x.recipient.id} left the store (${depart.get(x.recipient.id)})`);
      } else if (x.cause === 'feed_queen') {
        const c = contacts.get(String(x.contact?.contact_event_id));
        if (!c) fail(`${x.transfer_id}: feed_queen without an earlier queen_contact (${x.contact?.contact_event_id})`);
        const cc = c as { worker: string; queen: string; ordinal: number };
        if (cc.worker !== x.source.id || cc.queen !== x.recipient.id) fail(`${x.transfer_id}: feeds ${x.source.id} -> ${x.recipient.id}, its contact is ${cc.worker} with ${cc.queen}`);
        if (x.ordinal < cc.ordinal) fail(`${x.transfer_id}: delivered at ${x.ordinal}, before its contact at ${cc.ordinal}`);
        if (!(x.ordinal < (leaveQueen.get(x.source.id) ?? Infinity))) fail(`${x.transfer_id}: delivered at ${x.ordinal}, after ${x.source.id} left the queen (${leaveQueen.get(x.source.id)})`);
        const k = `${x.contact?.contact_event_id}:${x.food_type}`; if (fed.has(k)) fail(`${x.transfer_id}: a second ${x.food_type} feeding in one contact`); fed.add(k);
      } else if (x.cause === 'return_to_cache') {
        const w = x.source.id, at = store === QUEEN_PLACE ? arrive.get(w) : back.get(w);
        if (x.contact?.location !== store) fail(`${x.transfer_id}: put back at ${x.contact?.location}, the store is at ${store}`);
        if (at === undefined || x.ordinal < at) fail(`${x.transfer_id}: put back at ${x.ordinal}, before ${w} is back at the store (${at})`);
      } else if (x.cause === 'queen_self_feed') {
        if (!sp.queen_feeding.route_c_self_feed) fail(`${x.transfer_id}: self-feeding while route C is off`);
        if (x.contact?.location !== queen.location || x.contact?.food_location !== x.contact?.location || store !== queen.location) fail(`${x.transfer_id}: the queen at ${x.contact?.location} eats food at ${x.contact?.food_location} (store at ${store})`);
      }
    }
  });
}
