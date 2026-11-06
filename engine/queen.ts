/**
 * Adult survival (workers), queen survival and oviposition of one colony.
 * Order of random draws is identical to v6 deathAndQueen().
 */
import { clamp, round } from './math.ts';
import { colonyDice } from './workers.ts';
import { formatId } from './brood.ts';
import { settleCrops } from './nutrition.ts';
import { foodTransfer, recordSettlement } from './transfers.ts';
import type { SpeciesParams } from './params.ts';
import type { ColonyState, ColonySummary, Ratios, SimEvent, Weather, Worker, WorldState } from './types.ts';

/** Natural (age/injury) and starvation hazards; resting injured workers may recover. */
export function workerSurvival(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[], summary: ColonySummary): void {
  const life = sp.worker_lifespan, st = sp.starvation, stores = colony.stores;
  const alive: Worker[] = [];
  for (const w of colony.population.workers) {
    const g = colonyDice(world, colony, 'adult_survival:' + w.id);
    let natural = life.natural_daily_base_hazard;
    natural += Math.max(0, w.age_days - life.age_risk_from_days) * life.age_hazard_slope;
    if (w.injured) natural *= life.injury_mortality_multiplier;
    let starvation = 0;
    if (stores.sugar_gap_days >= st.worker_mortality_starts_days) starvation = clamp(st.worker_daily_hazard_base + (stores.sugar_gap_days - st.worker_mortality_starts_days) * st.worker_daily_hazard_slope, 0, st.worker_starvation_hazard_cap);
    const risk = clamp(1 - (1 - natural) * (1 - starvation), 0, life.adult_total_daily_hazard_cap);
    if (g() < risk) {
      summary.worker_deaths++;
      // v2-review.16 diagnostics: the two hazards compete in ONE draw, so the cause cannot be split; both
      // components and the sampling rule are recorded instead of naming a single physiological cause.
      events.push({ type: 'worker_death', id: w.id, reason: starvation > 0 ? 'starvation_or_natural_competing_hazards_scenario' : 'natural_or_injury_assumed', risk_assumption: round(risk), hazards: { natural_age_injury: round(natural), sugar_deficit_starvation: round(starvation), sugar_gap_days: stores.sugar_gap_days, age_days: w.age_days, injured: w.injured }, sampling: 'one uniform draw < 1-(1-natural)(1-starvation), capped at adult_total_daily_hazard_cap; competing risks, cause not separable' });
      // v2-review.22 (C2): the engine keeps a dead worker's crop sugar in the nest ledger (no corpse compartment until C5)
      foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'crop', id: w.id }, recipient: { kind: 'nest_unlocated', id: colony.id }, food_type: 'sugar', portions: w.crop_cargo_sugar || 0, cause: 'death_crop_to_nest_ledger', attribution: 'engine_rule', nest_ledger_delta: 0, basis: 'engine bookkeeping: a dead worker keeps no corpse compartment until C5; its crop sugar stays in the nest ledger' });
      // C3a: liquid protein in a dead carrier's crop is not nest sugar; it goes with the body (sink until C5 models corpses, D)
      if (w.crop_cargo_protein_liquid) foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'crop', id: w.id }, recipient: { kind: 'loss', id: 'worker_corpse' }, food_type: 'protein', portions: w.crop_cargo_protein_liquid, cause: 'death_crop_to_corpse', attribution: 'engine_rule', basis: 'carrier death: liquid protein leaves with the body (D; corpse compartment is C5)' });
    }
    else {
      // v2-review.12: an abrasion can close, a lost or damaged appendage never regrows (adult insects do not
      // moult); an unrecorded type keeps the earlier rule. A worker without injury_type is 'unknown'.
      const repair = life.injury_repair_probability * life[`injury_repair_multiplier_${w.injury_type ?? 'unknown'}`];
      if (w.injured && w.task === 'rest' && stores.stress_days === 0 && g() < repair) {
        w.injured = false; delete w.injury_type; delete w.injury_body_part; delete w.injury_record;
        events.push({ type: 'injury_recovery', id: w.id });
      }
      alive.push(w);
    }
  }
  colony.population.workers = alive;
}

/** Queen hazard rises after prolonged deficits or several days without any worker. */
export function queenSurvival(world: WorldState, colony: ColonyState, sp: SpeciesParams, events: SimEvent[]): void {
  const st = sp.starvation, stores = colony.stores, pop = colony.population;
  stores.no_worker_days = pop.workers.length === 0 ? (stores.no_worker_days || 0) + 1 : 0;
  const zeroWorkers = stores.no_worker_days >= st.queen_zero_worker_hazard_after_days;
  const queenRisk = zeroWorkers ? Math.max(st.queen_daily_hazard, st.queen_zero_worker_starved_daily_hazard) : st.queen_daily_hazard;
  const deficit = stores.stress_days >= st.queen_hazard_after_days;
  if (pop.queen_alive && (deficit || zeroWorkers) && colonyDice(world, colony, 'queen_survival')() < queenRisk) {
    pop.queen_alive = false;
    // v2-review.16 diagnostics (probabilities and draws unchanged): name the trigger(s) that were active and
    // which one set the applied hazard (the rule takes the MAX, it does not combine them). There is no
    // natural/age hazard for the queen in this engine; that is recorded as not modelled, not as zero risk.
    const sugarLong = stores.sugar_gap_days >= st.queen_hazard_after_days, proteinLong = stores.protein_gap_days >= st.queen_hazard_after_days;
    const deficitKind = sugarLong && proteinLong ? 'chronic_sugar_and_protein_deficit' : sugarLong ? 'chronic_sugar_deficit' : proteinLong ? 'chronic_protein_deficit' : null;
    const applied = zeroWorkers && st.queen_zero_worker_starved_daily_hazard >= st.queen_daily_hazard ? 'no_workers' : deficitKind;
    events.push({
      type: 'queen_death', id: colony.queen_id, reason: applied ?? 'unclassified',
      active_triggers: [...(deficitKind ? [deficitKind] : []), ...(zeroWorkers ? ['no_workers'] : [])],
      hazards: { nutritional_deficit: deficit ? st.queen_daily_hazard : 0, no_workers: zeroWorkers ? st.queen_zero_worker_starved_daily_hazard : 0, natural_age: 'not_modelled', applied: round(queenRisk) },
      sugar_gap_days: stores.sugar_gap_days, protein_gap_days: stores.protein_gap_days, no_worker_days: stores.no_worker_days,
      sampling: 'one uniform draw < applied hazard; applied = max(active trigger hazards), not a product of competing risks',
    });
  }
}

/** Egg laying after maintenance, conditional on nutrition, reserves, temperature and existing brood. */
export function oviposition(world: WorldState, colony: ColonyState, sp: SpeciesParams, ratios: Ratios, weather: Weather, events: SimEvent[], summary: ColonySummary): void {
  const q = sp.queen_laying, n = sp.nutrition, st = sp.starvation, stores = colony.stores, pop = colony.population;
  const broodCount = pop.brood.length;
  const enough = ratios.sFraction >= q.adequate_nutrition_threshold && ratios.pFraction >= q.adequate_nutrition_threshold && stores.sugar >= n.egg_laying_sugar_cost && stores.protein >= n.egg_laying_protein_cost;
  const pause = stores.sugar_gap_days >= st.queen_egg_pause_days || stores.protein_gap_days >= st.queen_egg_pause_days;
  const layingTemp = round(clamp(Math.pow(q.laying_temperature_q10, (weather.nest_temp_model_c - q.laying_reference_c) / 10), 0, 1));
  summary.queen_laying_temperature_factor = layingTemp;
  const probability = clamp(q.base_laying_probability * layingTemp * (stores.queen_laid_yesterday ? q.previous_laying_penalty : 1) * (1 - q.existing_brood_pressure * broodCount), 0, q.laying_probability_cap);
  const eggDice = colonyDice(world, colony, 'oviposition');
  let laid = pop.queen_alive && pop.workers.length > 0 && enough && !pause && eggDice() < probability ? 1 : 0;
  // At most max_eggs_per_day; the conditional second-egg probability is a game assumption.
  if (laid && q.max_eggs_per_day >= 2 && eggDice() < q.second_egg_given_laying_probability && stores.sugar >= 2 * n.egg_laying_sugar_cost && stores.protein >= 2 * n.egg_laying_protein_cost) laid = 2;
  for (let i = 0; i < laid; i++) {
    stores.sugar = round(stores.sugar - n.egg_laying_sugar_cost);
    // v2-review.13: the sugar spent on an egg leaves the workers' crops too, so crops stay a subset of the ledger.
    const draws = sp.nutrition_rules.egg_laying_settles_crops ? settleCrops(colony, n.egg_laying_sugar_cost) : [];
    stores.protein = round(stores.protein - n.egg_laying_protein_cost);
    const id = formatId(colony.egg_id_prefix, colony.next_egg_number++, colony.id_number_width);
    // v2-review.22 (C2): the egg's cost comes from the colony ledger (A08: the queen's own intake is not modelled)
    const egg = { kind: 'egg' as const, id }, basis = 'egg cost taken from the colony ledger (A08: not from what the queen ate); crops drawn in worker-array order (Issue #56)';
    recordSettlement(events, colony, draws, n.egg_laying_sugar_cost, 'lay_egg', egg, basis);
    foodTransfer(events, { minute: null, phase: 'nest_settlement', source: { kind: 'cache', id: colony.nest_node }, recipient: egg, food_type: 'protein', portions: n.egg_laying_protein_cost, cause: 'lay_egg', attribution: 'unknown', nest_ledger_delta: round(-n.egg_laying_protein_cost), basis });
    pop.brood.push({ id, stage: 'egg', laid_on_day: world.sim_day + 1, age_days: 0, progress: 0, origin: 'v2_scenario_laying' });
    events.push({ type: 'egg_laid', id, queen: colony.queen_id, sugar_cost_portions: n.egg_laying_sugar_cost, protein_cost_portions: n.egg_laying_protein_cost }); summary.eggs_laid++;
  }
  stores.queen_laid_yesterday = Boolean(laid);
  summary.queen_laying_probability_applied = pop.queen_alive && pop.workers.length > 0 && enough && !pause ? round(probability) : 0;
}
