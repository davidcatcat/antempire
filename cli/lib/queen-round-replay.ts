/**
 * C3a independent reader of one colony-day's nest round (docs/design-c3-queen-feeding.md §4, §8 N4–N8, N12, N13, N16):
 * written separately from engine/queen-feeding.ts checkQueenRound. Amounts, paths and closure are the C2 reader's job
 * (cli/lib/engine-transfers.ts replayEngineColonyDay with c3a = true); this reader checks who, where and when.
 * Method: one timeline per worker (store presence [−∞, depart], queen presence [arrive, ∞)), built from the nest_move
 * events; every round act is then placed on its actor's timeline. Never throws; at most 50 messages.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface QueenRoundReplay { ok: boolean; errors: string[]; contacts: number; feedings: { sugar: number; protein: number }; self_feedings: number }

/** `world`: the world before the day (sim_day, migration_log) — the trusted source of the initialization mode (Codex R7-01). */
export function replayQueenRound(start: Any, end: Any, events: Any[], species: Any, world?: { sim_day: number; migration_log?: Any[] }): QueenRoundReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const out: QueenRoundReplay = { ok: true, errors, contacts: 0, feedings: { sugar: 0, protein: 0 }, self_feedings: 0 };
  const qf = species?.queen_feeding ?? {};
  const storeAt = qf.store_is_queen_location === true ? 'queen' : 'store';
  const ev: Any[] = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const present = new Set<string>((start?.population?.workers ?? []).map((w: Any) => w.id));
  const q0 = start?.population?.queens?.[0], q1 = end?.population?.queens?.[0];
  // the queen record: unknown reserve untouched; a migrated queen's is null; known balances finite and ≥ 0
  if (!q1) err('no queen record at the end of a C3a day');
  else {
    if (q1.id !== end.queen_id) err(`queen record ${q1.id} ≠ colony queen ${end.queen_id}`);
    if (q0 && q0.body.unknown_initial_reserve !== q1.body.unknown_initial_reserve) err(`unknown reserve ${JSON.stringify(q0.body.unknown_initial_reserve)} -> ${JSON.stringify(q1.body.unknown_initial_reserve)}`);
    if (q1.body.basis === 'unknown_at_migration' && q1.body.unknown_initial_reserve !== null) err(`migrated queen with unknown reserve ${JSON.stringify(q1.body.unknown_initial_reserve)} (must stay null)`);
    if (q1.body.basis === 'day0_scenario' && q1.body.unknown_initial_reserve !== 'not_applicable') err('a Day0 queen must have unknown reserve not_applicable');
    for (const f of ['sugar', 'protein']) { const v = q1.body.known_balance?.[f]; if (!(typeof v === 'number' && Number.isFinite(v) && v >= 0)) err(`queen known ${f} = ${v}`); }
  }
  const cap = Number(species?.trophallaxis?.crop_capacity?.value ?? species?.trophallaxis?.crop_capacity);
  for (const w of end?.population?.workers ?? []) { const h = (Number(w.crop_cargo_sugar) || 0) + (Number(w.crop_cargo_protein_liquid) || 0); if (h - cap > 1e-9) err(`${w.id}: crop ${h} above the shared capacity ${cap}`); }
  // R6-01: a record created today (none at the start) needs exactly one initialization event, for this colony's queen
  const initEv = ev.filter((x) => x.type === 'queen_body_initialized');
  if (!q0 && q1 && (initEv.length !== 1 || initEv[0].queen !== end.queen_id)) err(`queen record created with ${initEv.length} initialization event(s); exactly one for ${end.queen_id} is required`);
  if (q0 && initEv.length) err('an initialization event for a queen record that already existed');
  // R7-01: which initialization a new record may have is decided by the world, not by the event or the record themselves
  if (!q0 && q1) {
    if (!world || typeof world.sim_day !== 'number') err('a queen record was created but no world context (sim_day, migration_log) was given to decide its initialization');
    else {
      const allowed = world.sim_day === 0 && (world.migration_log ?? []).some((m: Any) => m?.type === 'day0_initialization') ? 'day0_scenario' : 'unknown_at_migration';
      for (const e of initEv) if (e.basis !== allowed) err(`initialization claims ${e.basis}; on world day ${world.sim_day} only ${allowed} is possible`);
      if (q1.body.basis !== allowed) err(`queen record basis ${q1.body.basis}; this world-day allows only ${allowed}`);
    }
  }
  // R6-02: crops replayed transfer by transfer from the start of the day; every step within [0, capacity] for both foods
  { const hold = new Map<string, number[]>((start?.population?.workers ?? []).map((w: Any) => [w.id, [Number(w.crop_cargo_sugar) || 0, Number(w.crop_cargo_protein_liquid) || 0]]));
    for (const e of ev) if (e.type === 'food_transfer') for (const [r, sg] of [[e.source, -1], [e.recipient, 1]] as [Any, number][]) {
      if (r?.kind !== 'crop') continue;
      const h = hold.get(r.id) ?? [0, 0], i = e.food_type === 'protein' ? 1 : 0; h[i] = Math.round((h[i] + sg * Number(e.portions)) * 1e6) / 1e6; hold.set(r.id, h);
      if (h[0] < -1e-9 || h[1] < -1e-9 || h[0] + h[1] - cap > 1e-9) err(`${e.transfer_id}: crop of ${r.id} at sugar ${h[0]} + liquid protein ${h[1]} (capacity ${cap})`);
    } }
  // the record's creation: values fixed by the rules (migrated: null + 0; Day0: not_applicable + k × daily need)
  const val = (x: Any) => (typeof x === 'object' && x !== null ? Number(x.value) : Number(x));
  for (const e of ev.filter((x) => x.type === 'queen_body_initialized')) {
    const k = val(qf.day0_initial_reserve_days_of_need), ns = val(species?.nutrition?.queen_sugar_daily), np = val(species?.nutrition?.queen_protein_daily);
    const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
    const okInit = e.basis === 'unknown_at_migration' ? e.unknown_initial_reserve === null && e.known_balance?.sugar === 0 && e.known_balance?.protein === 0
      : e.basis === 'day0_scenario' ? e.unknown_initial_reserve === 'not_applicable' && Math.abs(e.known_balance?.sugar - r6(k * ns)) < 1e-9 && Math.abs(e.known_balance?.protein - r6(k * np)) < 1e-9 : false;
    if (!okInit) err(`queen record created as ${JSON.stringify(e).slice(0, 160)}: not what the rules give`);
  }
  // nobody carries liquid protein out of the round; the participants are nurses at the nest (from the state)
  const endW = new Map((end?.population?.workers ?? []).map((w: Any) => [w.id, w]));
  for (const w of endW.values() as Iterable<Any>) if (Number(w.crop_cargo_protein_liquid) > 0) err(`${w.id}: holds liquid protein after the round`);
  // timelines: out (store -> queen), optionally back (queen -> store)
  const tl = new Map<string, { depart: number; arrive: number; back: number | null; leave: number; diedAt: number }>();
  ev.forEach((e) => {
    if (e.type !== 'nest_move') return;
    const t = tl.get(e.worker), w: Any = endW.get(e.worker);
    if (!present.has(e.worker)) err(`${e.worker}: moves but was not present at the start`);
    if (w && (w.task !== 'nurse' || w.last_location !== end.nest_node)) err(`${e.worker}: takes part as ${w.task} at ${w.last_location} (only nurses at the nest)`);
    if (!(Number(e.arrive_ordinal) >= Number(e.depart_ordinal))) err(`${e.worker}: arrives (${e.arrive_ordinal}) before leaving (${e.depart_ordinal})`);
    if (!t) { if (e.from !== storeAt || e.to !== 'queen') err(`${e.worker}: first move ${e.from} -> ${e.to}`); tl.set(e.worker, { depart: Number(e.depart_ordinal), arrive: Number(e.arrive_ordinal), back: null, leave: Infinity, diedAt: Infinity }); }
    else if (t.back === null && e.from === 'queen' && e.to === storeAt && Number(e.depart_ordinal) >= t.arrive) { t.back = Number(e.arrive_ordinal); t.leave = Number(e.depart_ordinal); }
    else err(`${e.worker}: an extra move ${e.from} -> ${e.to}`);
  });
  ev.forEach((e, i) => { if (e.type === 'worker_death') { const t = tl.get(String(e.id)); if (t && t.diedAt === Infinity) t.diedAt = i; } });
  const contactById = new Map<string, Any>(), contactOf = new Set<string>(), fedKey = new Set<string>(), takeOf = new Set<string>();
  ev.forEach((e, i) => {
    if (e.type === 'queen_contact') {
      out.contacts++;
      const t = tl.get(e.worker);
      if (contactById.has(e.contact_event_id)) err(`${e.contact_event_id}: duplicate contact id`);
      contactById.set(e.contact_event_id, e);
      if (contactOf.has(e.worker)) err(`${e.worker}: two contacts with the queen in one round`); contactOf.add(e.worker);
      if (!present.has(e.worker)) err(`${e.contact_event_id}: ${e.worker} was not in the nest at the start`);
      if (!start?.population?.queen_alive || e.queen !== start.queen_id) err(`${e.contact_event_id}: ${e.queen} is not the living queen of ${start?.id}`);
      if (!(e.worker_location === 'queen' && e.queen_location === (q1?.location ?? 'queen') && e.location === 'queen')) err(`${e.contact_event_id}: worker at ${e.worker_location}, queen at ${e.queen_location}`);
      if (!t || Number(e.ordinal) < t.arrive) err(`${e.contact_event_id}: at ${e.ordinal}, before ${e.worker} arrived (${t?.arrive})`);
      // R6-03: at the queen only on [arrival, departure back to the store)
      if (t && !(Number(e.ordinal) < t.leave)) err(`${e.contact_event_id}: at ${e.ordinal}, ${e.worker} already left the queen (${t.leave})`);
      if (t && i > t.diedAt) err(`${e.contact_event_id}: after ${e.worker} died`);
    } else if (e.type === 'food_transfer' && e.phase === 'nest_round') {
      const actor = e.cause === 'take_from_cache' ? e.recipient?.id : e.cause === 'feed_queen' || e.cause === 'return_to_cache' ? e.source?.id : null;
      const t = actor ? tl.get(actor) : undefined;
      if (actor && t && i > t.diedAt) err(`${e.transfer_id}: ${actor} acts after its death`);
      if (e.cause === 'take_from_cache') {
        if (takeOf.has(actor)) err(`${e.transfer_id}: ${actor} takes twice`); takeOf.add(actor);
        if (!present.has(actor)) err(`${e.transfer_id}: ${actor} was not present`);
        if (e.contact?.location !== storeAt) err(`${e.transfer_id}: taken at ${e.contact?.location}, the store is ${storeAt}`);
        if (!t || !(Number(e.ordinal) < t.depart)) err(`${e.transfer_id}: taken at ${e.ordinal}, ${actor} left the store at ${t?.depart}`);
        if (qf.route_b1 !== true) err(`${e.transfer_id}: route B1 is off`);
      } else if (e.cause === 'feed_queen') {
        if (t && !(Number(e.ordinal) < t.leave)) err(`${e.transfer_id}: fed at ${e.ordinal}, after ${actor} left the queen (${t.leave})`);
        const c = contactById.get(e.contact?.contact_event_id);
        if (!c) err(`${e.transfer_id}: no earlier contact ${e.contact?.contact_event_id}`);
        else {
          if (c.worker !== e.source?.id || c.queen !== e.recipient?.id) err(`${e.transfer_id}: ${e.source?.id} -> ${e.recipient?.id}, contact was ${c.worker} with ${c.queen}`);
          if (Number(e.ordinal) < Number(c.ordinal)) err(`${e.transfer_id}: fed at ${e.ordinal}, before the contact at ${c.ordinal}`);
        }
        const k = `${e.contact?.contact_event_id}/${e.food_type}`; if (fedKey.has(k)) err(`${e.transfer_id}: second ${e.food_type} feeding in one contact`); fedKey.add(k);
        if (e.food_type === 'sugar' || e.food_type === 'protein') out.feedings[e.food_type as 'sugar' | 'protein']++;
      } else if (e.cause === 'return_to_cache') {
        const at = storeAt === 'queen' ? t?.arrive : t?.back;
        if (e.contact?.location !== storeAt) err(`${e.transfer_id}: put back at ${e.contact?.location}, the store is ${storeAt}`);
        if (at === undefined || at === null || Number(e.ordinal) < at) err(`${e.transfer_id}: put back at ${e.ordinal} before ${actor} is at the store (${at})`);
      } else if (e.cause === 'queen_self_feed') {
        out.self_feedings++;
        if (qf.route_c_self_feed !== true) err(`${e.transfer_id}: route C is off`);
        if (storeAt !== (q1?.location ?? 'queen') || e.contact?.location !== e.contact?.food_location || e.contact?.location !== (q1?.location ?? 'queen')) err(`${e.transfer_id}: queen at ${e.contact?.location}, food at ${e.contact?.food_location}`);
      }
    }
  });
  out.ok = errors.length === 0;
  return out;
}
