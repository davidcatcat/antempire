/**
 * C4a independent reader of one colony-day's larval feeding (docs/design-c4-larval-nutrition.md §5 A2, A4, A6, A10, A11):
 * written separately from engine/larva-feeding.ts checkLarvaRound and shares no code with the engine. Amounts, paths and
 * per-compartment closure are the C2 reader's job (cli/lib/engine-transfers.ts with c4a = true); this reader replays every
 * larva from its OWN records:
 *   - one presence interval per nurse at the brood place, from its nest_move events;
 *   - one account per larva: start balance (state, or today's initialization record) + its feed_larva records − its
 *     metabolism, where the metabolism must be min(own need, own balance) and the need is recomputed here from the species
 *     parameters and the day's nest temperature (never from a colony quantity);
 *   - its begging signal recomputed from its start signal, its own protein intake and its own need (D6);
 *   - hatch (D2a): the record inherits exactly what its egg recorded at laying (or null), reserve_at_hatch null;
 *   - an egg laid today records exactly its lay_egg transfers; an account leaves whole at eclosion or death.
 * Never throws; at most 50 messages.
 */
type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface LarvaReplay { ok: boolean; errors: string[]; contacts: number; feedings: { sugar: number; protein: number }; larvae: Record<string, { intake: { sugar: number; protein: number }; begging: number; balance: { sugar: number; protein: number } }> }

/** The engine's published rounding contract for stored quantities (six decimals, half-up with a machine-epsilon nudge). */
const r6 = (x: number) => Math.round((x + Number.EPSILON) * 1e6) / 1e6;
const val = (x: Any) => (typeof x === 'object' && x !== null ? Number(x.value) : Number(x));
const same = (a: Any, b: Any) => JSON.stringify(a) === JSON.stringify(b);

/** `world`: the world before the day (sim_day, migration_log); `nestTempC`: the day's nest temperature (weather output). */
export function replayLarvaRound(start: Any, end: Any, events: Any[], species: Any, world: { sim_day: number; migration_log?: Any[] }, nestTempC: number): LarvaReplay {
  const errors: string[] = [], err = (m: string) => { if (errors.length < 50) errors.push(m); };
  const out: LarvaReplay = { ok: true, errors, contacts: 0, feedings: { sugar: 0, protein: 0 }, larvae: {} };
  const ev: Any[] = Array.isArray(events) ? events.filter((e) => e && typeof e === 'object') : [];
  const lf = species?.larval_feeding ?? {}, ls = species?.local_signals ?? {}, nut = species?.nutrition ?? {}, met = species?.metabolism ?? {};
  const threshold = val(lf.feed_begging_threshold), bolus = { sugar: val(lf.feed_bolus_sugar_portions), protein: val(lf.feed_bolus_protein_portions) };
  const prior = val(ls.default_larva_begging_prior), wPrev = val(ls.larva_begging_previous_weight), wShort = val(ls.larva_begging_shortfall_weight);
  const factor = r6(Math.pow(val(met.q10), (nestTempC - val(met.reference_c)) / 10));
  const need = { sugar: r6(val(nut.larva_sugar_daily) * factor), protein: r6(val(nut.larva_protein_daily) * factor) };
  const day0 = world.sim_day === 0 && (world.migration_log ?? []).some((m: Any) => m?.type === 'day0_initialization');
  const brood0 = new Map<string, Any>((start?.population?.brood ?? []).map((b: Any) => [b.id, b]));
  const brood1 = new Map<string, Any>((end?.population?.brood ?? []).map((b: Any) => [b.id, b]));
  const nurses0 = new Set<string>((start?.population?.workers ?? []).map((w: Any) => w.id));

  // 1. records first seen today (D8): which items needed one, and with which basis
  const init = new Map<string, Any>();
  for (const e of ev) if (e.type === 'brood_nutrition_record_initialized') { if (init.has(e.id)) err(`${e.id}: initialized twice`); init.set(e.id, e); }
  for (const [id, b] of brood0) {
    const needs = (b.stage === 'egg' && b.reserve_basis === undefined) || (b.stage === 'larva' && !b.body);
    const e = init.get(id);
    if (!needs) { if (e) err(`${id}: initialized although it had a record (or is a pupa)`); continue; }
    if (!e) { err(`${id} (${b.stage}): no record and no initialization`); continue; }
    const basis = day0 ? 'day0_scenario' : b.stage === 'egg' && b.origin === 'v2_scenario_laying' ? 'egg_laid_before_switch' : 'unknown_at_migration';
    if (e.stage !== b.stage || e.reserve_basis !== basis || e.egg_investment !== null) err(`${id}: initialized as ${e.stage}/${e.reserve_basis}/${JSON.stringify(e.egg_investment)}; expected ${b.stage}/${basis}/null`);
    if (b.stage === 'larva' && (!same(e.fed_balance, { sugar: 0, protein: 0 }) || e.reserve_at_hatch !== null)) err(`${id}: a first-seen larva starts at 0 with an unknown (null) reserve, recorded ${JSON.stringify(e.fed_balance)} / ${JSON.stringify(e.reserve_at_hatch)}`);
  }
  for (const id of init.keys()) if (!brood0.has(id)) err(`${id}: initialized but not brood at the start`);
  // the larvae at the start of the round: account start, place, start-of-round begging
  const larva = new Map<string, { bal: { sugar: number; protein: number }; place: string; begging: number; basis: string; inv: Any }>();
  for (const [id, b] of brood0) if (b.stage === 'larva') {
    const e = init.get(id);
    const bal = b.body ? { sugar: Number(b.body.fed_balance?.sugar), protein: Number(b.body.fed_balance?.protein) } : e ? { sugar: 0, protein: 0 } : null;
    if (!bal) continue;
    larva.set(id, { bal, place: b.location ?? e?.location, begging: r6(typeof b.begging_signal === 'number' ? b.begging_signal : prior), basis: b.body?.reserve_basis ?? e?.reserve_basis, inv: b.body ? b.body.egg_investment : null });
  }

  // 2. nurse presence at the brood place
  const stay = new Map<string, { from: number; to: number }>();
  for (const e of ev) if (e.type === 'nest_move') {
    if (e.to === 'brood') { if (stay.has(e.worker)) err(`${e.worker}: reaches the brood twice`); stay.set(e.worker, { from: Number(e.arrive_ordinal), to: Infinity }); }
    if (e.from === 'brood') { const s = stay.get(e.worker); if (!s || s.to !== Infinity) err(`${e.worker}: leaves the brood it is not at`); else s.to = Number(e.depart_ordinal); }
  }
  const died = new Map<string, number>(); ev.forEach((e, i) => { if (e.type === 'worker_death' && !died.has(String(e.id))) died.set(String(e.id), i); });
  const atPlace = [...larva.values()].filter((l) => l.place === 'brood').length;

  // 3. contacts and feedings
  const contact = new Map<string, Any>(), met1 = new Set<string>(), bolusKey = new Set<string>(), intake = new Map<string, { sugar: number; protein: number }>();
  // every crop replayed from the start of the day; what the nurse holds when it meets the larva fixes the bolus (D4)
  const crop = new Map<string, { sugar: number; protein: number }>((start?.population?.workers ?? []).map((w: Any) => [w.id, { sugar: Number(w.crop_cargo_sugar) || 0, protein: Number(w.crop_cargo_protein_liquid) || 0 }]));
  const atContact = new Map<string, { sugar: number; protein: number }>();
  ev.forEach((e, i) => {
    if (e.type === 'larva_contact') {
      out.contacts++;
      if (contact.has(e.contact_event_id)) err(`${e.contact_event_id}: duplicate contact id`);
      contact.set(e.contact_event_id, e);
      if (met1.has(e.worker)) err(`${e.worker}: meets two larvae in one round`); met1.add(e.worker);
      const l = larva.get(e.larva), s = stay.get(e.worker), t = Number(e.ordinal);
      if (!nurses0.has(e.worker)) err(`${e.contact_event_id}: ${e.worker} not present at the start`);
      if (!l) { err(`${e.contact_event_id}: ${e.larva} is not a larva with an account at the start of the round`); return; }
      if (l.place !== 'brood' || e.location !== 'brood' || e.worker_location !== 'brood' || e.larva_location !== l.place) err(`${e.contact_event_id}: larva at ${l.place}, nurse at ${e.worker_location}, contact at ${e.location}`);
      if (!s || !(t >= s.from && t < s.to)) err(`${e.contact_event_id}: at ${t}, ${e.worker} is not at the brood (${s?.from}..${s?.to})`);
      if (i > (died.get(e.worker) ?? Infinity)) err(`${e.contact_event_id}: after ${e.worker} died`);
      if (e.begging_signal !== l.begging) err(`${e.contact_event_id}: begging ${e.begging_signal}; the larva's own start-of-round signal is ${l.begging}`);
      atContact.set(e.contact_event_id, { ...(crop.get(e.worker) ?? { sugar: 0, protein: 0 }) });
      if (e.larvae_at_place !== atPlace) err(`${e.contact_event_id}: says ${e.larvae_at_place} larvae at the place, the start state has ${atPlace}`);
    } else if (e.type === 'food_transfer' && e.cause === 'feed_larva') {
      const c = contact.get(e.contact?.contact_event_id), s = stay.get(e.source?.id);
      if (!c) { err(`${e.transfer_id}: no earlier larva_contact ${e.contact?.contact_event_id}`); return; }
      if (c.worker !== e.source?.id || c.larva !== e.recipient?.id) err(`${e.transfer_id}: ${e.source?.id} -> ${e.recipient?.id}; contact was ${c.worker} with ${c.larva}`);
      if (Number(e.ordinal) < Number(c.ordinal) || !(Number(e.ordinal) < (s?.to ?? -Infinity))) err(`${e.transfer_id}: at ${e.ordinal}, not within the contact (${c.ordinal}..${s?.to})`);
      const has = crop.get(e.source?.id)?.[e.food_type as 'sugar' | 'protein'] ?? 0, due = r6(Math.min(has, bolus[e.food_type as 'sugar' | 'protein']));
      if (Number(e.portions) !== due) err(`${e.transfer_id}: ${e.portions} ${e.food_type}; holding ${has}, the fixed bolus is ${due}`);
      const k = `${c.contact_event_id}/${e.food_type}`; if (bolusKey.has(k)) err(`${e.transfer_id}: second ${e.food_type} bolus in one contact`); bolusKey.add(k);
      if (Number(e.portions) - bolus[e.food_type as 'sugar' | 'protein'] > 1e-9) err(`${e.transfer_id}: ${e.portions} above the ${e.food_type} bolus ${bolus[e.food_type as 'sugar' | 'protein']}`);
      const l = larva.get(c.larva); if (l && l.begging < threshold) err(`${e.transfer_id}: fed although ${c.larva} begged ${l.begging} < ${threshold}`);
      const g = intake.get(c.larva) ?? { sugar: 0, protein: 0 }; g[e.food_type as 'sugar' | 'protein'] = r6(g[e.food_type as 'sugar' | 'protein'] + Number(e.portions)); intake.set(c.larva, g);
      if (e.food_type === 'sugar' || e.food_type === 'protein') out.feedings[e.food_type as 'sugar' | 'protein']++;
    }
    if (e.type === 'food_transfer') for (const [side, sg] of [[e.source, -1], [e.recipient, 1]] as [Any, number][]) if (side?.kind === 'crop') { const h = crop.get(side.id) ?? { sugar: 0, protein: 0 }; const f = e.food_type as 'sugar' | 'protein'; h[f] = r6(h[f] + sg * Number(e.portions)); crop.set(side.id, h); }
  });
  for (const [id, c] of contact) {
    const l = larva.get(c.larva), h = atContact.get(id);
    if (!l || !h || l.begging < threshold) continue;
    for (const f of ['sugar', 'protein'] as const) if (r6(Math.min(h[f], bolus[f])) > 0 && !bolusKey.has(`${id}/${f}`)) err(`${id}: ${c.larva} begs ${l.begging} ≥ ${threshold} and ${c.worker} holds ${h[f]} ${f}, but gives none`);
  }

  // 4. each larva's own account and begging
  const flows = new Map<string, Record<string, { sugar: number; protein: number }>>();
  for (const e of ev) if (e.type === 'food_transfer' && e.source?.kind === 'larva_body') {
    const f = flows.get(e.source.id) ?? {}, c = (f[e.cause] ??= { sugar: 0, protein: 0 });
    c[e.food_type as 'sugar' | 'protein'] = r6(c[e.food_type as 'sugar' | 'protein'] + Number(e.portions)); flows.set(e.source.id, f);
  }
  const report = new Map<string, Any>();
  for (const e of ev) if (e.type === 'larva_nutrition') { if (report.has(e.larva)) err(`${e.larva}: two larva_nutrition records`); report.set(e.larva, e); }
  const deadNow = new Set(ev.filter((e) => e.type === 'brood_death').map((e) => String(e.id))), outNow = new Set(ev.filter((e) => e.type === 'eclosion').map((e) => String(e.source_brood_id)));
  for (const [id, l] of larva) {
    const got = intake.get(id) ?? { sugar: 0, protein: 0 }, f = flows.get(id) ?? {}, paid = f.larva_metabolism ?? { sugar: 0, protein: 0 };
    const bal = { sugar: r6(l.bal.sugar + got.sugar), protein: r6(l.bal.protein + got.protein) };
    for (const k of ['sugar', 'protein'] as const) { const want = r6(Math.min(need[k], bal[k])); if (paid[k] !== want) err(`${id}: paid ${paid[k]} ${k}, own rule min(need ${need[k]}, balance ${bal[k]}) = ${want}`); bal[k] = r6(bal[k] - paid[k]); }
    const short = need.protein > 0 ? Math.min(1, Math.max(0, 1 - got.protein / need.protein)) : 0;
    const begging = r6(Math.min(1, Math.max(0, wPrev * l.begging + wShort * short)));
    out.larvae[id] = { intake: got, begging, balance: bal };
    const rep = report.get(id), b1 = brood1.get(id);
    if (!rep) err(`${id}: no larva_nutrition record`);
    else if (rep.begging_signal !== begging || !same(rep.intake_portions, got) || !same(rep.fed_balance, bal)) err(`${id}: reports begging ${rep.begging_signal}, intake ${JSON.stringify(rep.intake_portions)}, balance ${JSON.stringify(rep.fed_balance)}; its own records give ${begging}, ${JSON.stringify(got)}, ${JSON.stringify(bal)}`);
    if (b1) { if (!same(b1.body?.fed_balance, bal) || b1.begging_signal !== begging) err(`${id}: end state ${JSON.stringify(b1.body?.fed_balance)} / ${b1.begging_signal}, replay ${JSON.stringify(bal)} / ${begging}`); }
    else if (deadNow.has(id)) { if (!same(f.death_body_to_corpse ?? { sugar: 0, protein: 0 }, bal)) err(`${id}: died with ${JSON.stringify(bal)}, ${JSON.stringify(f.death_body_to_corpse)} left with the body`); }
    else err(`${id}: an account vanished without death`);
  }
  for (const id of report.keys()) if (!larva.has(id)) err(`${id}: larva_nutrition record for something that was not a larva with an account at the start`);
  // pupae carry their account unchanged (D5) and give it all up at eclosion or death
  for (const [id, b] of brood0) if (b.stage === 'pupa' && b.body) {
    const b1 = brood1.get(id), f = flows.get(id) ?? {};
    if (b1) { if (!same(b1.body, b.body) || Object.keys(f).length) err(`${id}: a pupa's account changed`); }
    else if (outNow.has(id)) { if (!same(f.brood_body_at_eclosion ?? { sugar: 0, protein: 0 }, b.body.fed_balance)) err(`${id}: eclosed with ${JSON.stringify(b.body.fed_balance)}, recorded ${JSON.stringify(f.brood_body_at_eclosion)}`); }
    else if (deadNow.has(id)) { if (!same(f.death_body_to_corpse ?? { sugar: 0, protein: 0 }, b.body.fed_balance)) err(`${id}: died with ${JSON.stringify(b.body.fed_balance)}, recorded ${JSON.stringify(f.death_body_to_corpse)}`); }
  }

  // 5. hatch records (D2a) and egg records
  const hatchedIds = new Set(ev.filter((e) => e.type === 'hatch').map((e) => String(e.id)));
  const hrec = new Map<string, Any>();
  for (const e of ev) if (e.type === 'larva_hatch_nutrition') { if (hrec.has(e.larva)) err(`${e.larva}: two hatch records`); hrec.set(e.larva, e); }
  for (const id of hrec.keys()) if (!hatchedIds.has(id)) err(`${id}: a hatch record without a hatch`);
  for (const id of hatchedIds) {
    const egg = brood0.get(id), e = hrec.get(id), b1 = brood1.get(id), ie = init.get(id);
    const inherited = egg?.reserve_basis !== undefined ? (egg.egg_investment ?? null) : ie ? null : undefined, basis = egg?.reserve_basis ?? ie?.reserve_basis;
    if (!e) { err(`${id}: hatched without a hatch record`); continue; }
    if (inherited === undefined) { err(`${id}: hatched from an egg with no record`); continue; }
    if (!same(e.inherited, inherited) || e.reserve_at_hatch !== null || e.reserve_basis !== basis) err(`${id}: hatch record ${JSON.stringify(e.inherited)} / ${JSON.stringify(e.reserve_at_hatch)} / ${e.reserve_basis}; the egg recorded ${JSON.stringify(inherited)} / ${basis}, reserve unknown (null)`);
    if (b1 && !same(b1.body, { fed_balance: { sugar: 0, protein: 0 }, egg_investment: inherited, reserve_at_hatch: null, reserve_basis: basis })) err(`${id}: hatchling account ${JSON.stringify(b1.body)}`);
  }
  const laid = new Map<string, { sugar: number; protein: number }>();
  for (const e of ev) if (e.type === 'food_transfer' && e.cause === 'lay_egg') { const g = laid.get(e.recipient.id) ?? { sugar: 0, protein: 0 }; g[e.food_type as 'sugar' | 'protein'] = r6(g[e.food_type as 'sugar' | 'protein'] + Number(e.portions)); laid.set(e.recipient.id, g); }
  for (const [id, b] of brood1) {
    if (b.body && b.body.reserve_at_hatch !== null) err(`${id}: reserve_at_hatch ${JSON.stringify(b.body.reserve_at_hatch)}; it is unknown and stays null`);
    if (b.stage !== 'egg') continue;
    const b0 = brood0.get(id);
    if (!b0) { if (!same(b.egg_investment, laid.get(id) ?? null) || b.reserve_basis !== 'egg_laid_with_record') err(`${id}: laid today with record ${JSON.stringify(b.egg_investment)} / ${b.reserve_basis}; lay_egg moved ${JSON.stringify(laid.get(id))}`); }
    else { const ie = init.get(id), inv0 = b0.reserve_basis !== undefined ? b0.egg_investment : ie ? null : undefined, bas0 = b0.reserve_basis ?? ie?.reserve_basis; if (!same(b.egg_investment, inv0) || b.reserve_basis !== bas0) err(`${id}: egg record changed during the day`); }
  }
  for (const e of ev) if (e.type === 'food_transfer' && (e.source?.kind === 'larva_yolk' || e.recipient?.kind === 'larva_yolk')) err(`${e.transfer_id}: a larva_yolk transfer (D2a records the hatch only)`);
  out.ok = errors.length === 0;
  return out;
}
