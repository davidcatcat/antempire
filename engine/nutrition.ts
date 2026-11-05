/**
 * Nest food ledger of one colony (stores.sugar / stores.protein, game portions, NOT mg).
 * `stores.sugar` is ONE aggregate mass that INCLUDES the sugar held in individual workers' crops;
 * crop_cargo_sugar is a subset used for local trophallaxis, never additional mass.
 * This is the only module (besides queen.ts egg costs) that writes the nest ledger.
 */
import { clamp, round } from './math.ts';
import { colonyDice } from './workers.ts';
import type { Rng } from './rng.ts';
import { foodTransfer, recordSettlement } from './transfers.ts';
import { cropHeld } from './queen-feeding.ts';
import type { SpeciesParams } from './params.ts';
import type { ColonyState, ColonySummary, Macro, Ratios, SimEvent, Weather, Worker, WorldState } from './types.ts';

/** A returning forager unloads: sugar is passed mouth-to-mouth to nestmates physically at the nest; protein is cached. */
export function handoff(colony: ColonyState, sp: SpeciesParams, worker: Worker, macro: Macro, load: number, events: SimEvent[], g: Rng, site: string, minute?: number): { count: number; transferred: number } {
  const tr = sp.trophallaxis, nest = colony.nest_node, at = minute === undefined ? null : round(minute);
  // v2-review.22 (C2): the load leaves the worker's transit compartment into its crop (sugar) or the nest cache (protein)
  foodTransfer(events, { minute: at, phase: 'foraging', source: { kind: 'in_transit', id: worker.id }, recipient: macro === 'sugar' ? { kind: 'crop', id: worker.id } : { kind: 'cache', id: nest }, food_type: macro, portions: load, cause: 'unload', attribution: 'individual', nest_ledger_delta: round(load), contact: { site, location: nest } });
  const contacts = colony.population.workers.filter((w) => w.id !== worker.id && w.last_location === nest);
  let transferred = 0, count = 0;
  if (macro === 'sugar') {
    worker.crop_cargo_sugar = round((worker.crop_cargo_sugar || 0) + load);
    for (let i = 0; i < tr.max_trophallaxis_contacts && contacts.length; i++) {
      const peer = contacts.splice(Math.floor(g() * contacts.length), 1)[0], room = Math.max(0, tr.crop_capacity - cropHeld(peer)), amount = round(Math.min(worker.crop_cargo_sugar, room, tr.transfer_max_portions));
      if (amount <= 0) continue;
      worker.crop_cargo_sugar = round(worker.crop_cargo_sugar - amount); peer.crop_cargo_sugar = round((peer.crop_cargo_sugar || 0) + amount);
      transferred = round(transferred + amount); count++;
      events.push({ type: 'trophallaxis', from: worker.id, to: peer.id, location: nest, macro, portions: amount, assumption: true });
      foodTransfer(events, { minute: at, phase: 'foraging', source: { kind: 'crop', id: worker.id }, recipient: { kind: 'crop', id: peer.id }, food_type: 'sugar', portions: amount, cause: 'trophallaxis', attribution: 'individual', contact: { location: nest, donor_location: worker.last_location, recipient_location: peer.last_location, basis: 'engine contact rule: recipient chosen among nestmates whose last_location is the nest node (no separate contact event)' } });
    }
    colony.stores.sugar = round(colony.stores.sugar + load);
  } else {
    colony.stores.protein = round(colony.stores.protein + load);
    events.push({ type: 'protein_cached_at_nest', worker: worker.id, site, portions: load, assumption: true });
  }
  events.push({ type: 'food_delivered', site, worker: worker.id, macro, portions: load, location: nest, trophallaxis_portions: transferred, assumption: true });
  return { count, transferred };
}

/** Remove `used` sugar from individual crops (in worker order) so crops stay a subset of the ledger.
 *  Returns what each crop gave (v2-review.22 records it; the arithmetic is unchanged). Worker-array order: Issue #56. */
export function settleCrops(colony: ColonyState, used: number): { worker: string; amount: number }[] {
  let remaining = used;
  const draws: { worker: string; amount: number }[] = [];
  for (const w of colony.population.workers) {
    const held = w.crop_cargo_sugar || 0, take = Math.min(held, remaining);
    w.crop_cargo_sugar = round(held - take); remaining = round(remaining - take);
    if (take > 0) draws.push({ worker: w.id, amount: round(take) });
    if (remaining <= 0) break;
  }
  return draws;
}

/** Storage capacity scales with workers above a baseline; the excess is lost (not retained). */
export function storageOverflow(colony: ColonyState, sp: SpeciesParams, events: SimEvent[] = []): { sugar: number; protein: number } {
  const n = sp.nutrition, extra = Math.max(0, colony.population.workers.length - n.store_capacity_baseline_workers);
  const overflow = {
    sugar: round(Math.max(0, colony.stores.sugar - (n.max_sugar_store + extra * n.sugar_store_per_extra_worker))),
    protein: round(Math.max(0, colony.stores.protein - (n.max_protein_store + extra * n.protein_store_per_extra_worker))),
  };
  colony.stores.sugar = round(colony.stores.sugar - overflow.sugar); const draws = settleCrops(colony, overflow.sugar);
  colony.stores.protein = round(colony.stores.protein - overflow.protein);
  const loss = { kind: 'loss' as const, id: 'storage_overflow' }, basis = 'storage capacity rule (game assumption); taken from the colony ledger, crops in worker-array order (Issue #56)';
  recordSettlement(events, colony, draws, overflow.sugar, 'storage_overflow', loss, basis);
  foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'cache', id: colony.nest_node }, recipient: loss, food_type: 'protein', portions: overflow.protein, cause: 'storage_overflow', attribution: 'unknown', nest_ledger_delta: round(-overflow.protein), basis });
  return overflow;
}

/**
 * Daily metabolism. Demand scales with nest temperature by the species Q10 (general physiology +
 * game assumption). Only workers can feed the queen and larvae: with zero workers nothing is eaten.
 * Each worker learns only what IT ate; the colony-wide fraction is never broadcast to behaviour.
 */
export function consume(world: WorldState, colony: ColonyState, sp: SpeciesParams, summary: ColonySummary, weather: Weather, events: SimEvent[] = []): Ratios {
  const n = sp.nutrition, ls = sp.local_signals, st = colony.stores;
  const workers = colony.population.workers.length, larvae = colony.population.brood.filter((b) => b.stage === 'larva');
  const metabolicFactor = round(Math.pow(sp.metabolism.q10, (weather.nest_temp_model_c - sp.metabolism.reference_c) / 10));
  // C3a: the queen pays her own metabolism from what she ate (engine/queen-feeding.ts queenMetabolism), not from this pool
  const servedQueen = colony.population.queen_alive && workers > 0 && !sp.queen_feeding.individual_queen_body_c3a ? 1 : 0, servedLarvae = workers > 0 ? larvae.length : 0;
  const extraCost = summary.extra_sugar_cost;
  const demandS = round((workers * n.worker_sugar_daily + servedQueen * n.queen_sugar_daily + servedLarvae * n.larva_sugar_daily) * metabolicFactor + extraCost);
  const demandP = round((workers * n.worker_protein_daily + servedQueen * n.queen_protein_daily + servedLarvae * n.larva_protein_daily) * metabolicFactor);
  summary.metabolic_factor = metabolicFactor; summary.nurse_available = workers > 0;
  const gotS = round(Math.min(st.sugar, demandS)), gotP = round(Math.min(st.protein, demandP));
  st.sugar = round(Math.max(0, st.sugar - gotS)); const draws = settleCrops(colony, gotS); st.protein = round(Math.max(0, st.protein - gotP));
  // v2-review.22 (C2): the engine eats from the colony ledger as one pool (F01): who ate is NOT individual
  const eaten = { kind: 'metabolized' as const, id: colony.id }, basis = 'aggregate daily metabolism of workers, queen and larvae plus activity cost (Issue #43 defect: consumer not individual); crops drawn in worker-array order (Issue #56)';
  recordSettlement(events, colony, draws, gotS, 'metabolism', eaten, basis);
  foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'cache', id: colony.nest_node }, recipient: eaten, food_type: 'protein', portions: gotP, cause: 'metabolism', attribution: 'unknown', nest_ledger_delta: round(-gotP), basis });
  const unattendedQueen = colony.population.queen_alive && workers === 0;
  const sFraction = unattendedQueen ? 0 : (demandS > 0 ? gotS / demandS : 1), pFraction = unattendedQueen ? 0 : (demandP > 0 ? gotP / demandP : 1);
  st.sugar_gap_days = sFraction < n.ration_gap_threshold ? st.sugar_gap_days + 1 : 0;
  st.protein_gap_days = pFraction < n.ration_gap_threshold ? st.protein_gap_days + 1 : 0;
  st.stress_days = Math.max(st.sugar_gap_days, st.protein_gap_days);
  summary.demand = { sugar: demandS, protein: demandP }; summary.consumed = { sugar: gotS, protein: gotP }; summary.ratios = { sugar: round(sFraction), protein: round(pFraction) };
  // Physical rationing in the nest; each worker only learns what it ate.
  let budget = Math.max(0, gotS - (servedQueen * n.queen_sugar_daily + servedLarvae * n.larva_sugar_daily) * metabolicFactor - extraCost);
  const order = [...colony.population.workers]; const g = colonyDice(world, colony, 'nest_sugar_feeding_allocation');
  for (let k = order.length - 1; k > 0; k--) { const j = Math.floor(g() * (k + 1)); [order[k], order[j]] = [order[j], order[k]]; }
  for (const w of order) {
    const need = n.worker_sugar_daily * metabolicFactor, got = clamp(Math.min(need, budget), 0, need);
    budget = Math.max(0, budget - got); w.local_sensory ??= {}; const mem = w.local_sensory;
    const full = need > 0 ? got / need : 1;
    mem.own_crop_sugar_fill = round(ls.crop_fill_previous_weight * (mem.own_crop_sugar_fill ?? ls.default_crop_fill_before_feeding) + ls.crop_fill_today_weight * full); mem.own_feeding_fraction = round(full);
  }
  // Larval begging changes the larva itself; it reaches a worker only through a real nurse contact.
  for (const b of larvae) { b.begging_signal = round(clamp(ls.larva_begging_previous_weight * (b.begging_signal ?? ls.default_larva_begging_prior) + ls.larva_begging_shortfall_weight * (1 - pFraction), 0, 1)); }
  return { sFraction, pFraction };
}
