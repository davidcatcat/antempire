/**
 * Brood development egg -> larva -> pupa -> worker. Rate scales with nest temperature (species Q10,
 * clamped) and, for larvae, with today's ration. Brood depends on worker care: with no workers,
 * larvae stop developing and every stage dies after the species' unattended-day limits.
 *
 * v2-review.21 (Issue #50 / #49 N1, switch brood_care.daily_care_snapshot_v21): every brood item's care exposure for
 * the day comes from the workers present when the time step began; all brood is developed / killed first and the
 * day's eclosions are committed afterwards, with worker ids assigned in ascending source-pupa id. The result for an
 * individual no longer depends on its position in the brood array. A worker that ecloses today gives no care today
 * (time-resolution assumption: there is no eclosion minute and no care-contact event yet).
 */
import { clamp, round } from './math.ts';
import { colonyDice } from './workers.ts';
import { closeBroodBody, hatchRecord } from './larva-feeding.ts';
import { nutritionFactor } from './larva-development.ts';
import type { SpeciesParams } from './params.ts';
import type { Brood, ColonyState, ColonySummary, Ratios, SimEvent, Weather, WorldState } from './types.ts';

export const formatId = (prefix: string, n: number, width: number): string => `${prefix}${String(n).padStart(width, '0')}`;

export function developBrood(world: WorldState, colony: ColonyState, sp: SpeciesParams, weather: Weather, ratios: Ratios, events: SimEvent[], summary: ColonySummary, ownPaid?: Map<string, number>): void {
  const dev = sp.development, care = sp.brood_care, st = sp.starvation, pop = colony.population;
  const factor = clamp(Math.pow(dev.q10, (weather.nest_temp_model_c - dev.reference_c) / 10), dev.min_temp_factor, dev.max_temp_factor);
  const survived: Brood[] = [];
  const snapshot = sp.brood_care.daily_care_snapshot_v21, workersAtStart = pop.workers.length;
  /** Was there any worker to care for brood? v21: at the start of the step; v20: at this point of the loop. */
  const noCare = () => (snapshot ? workersAtStart : pop.workers.length) === 0;
  const eclosing: Brood[] = [];
  const c4a = sp.larval_feeding.individual_larva_body_c4a, c4b = sp.larval_development.individual_development_c4b; // C4a: hatch record (D2a); accounts leave at eclosion (D5) or death
  for (const b of pop.brood) {
    if (!b.alive && b.alive !== undefined) continue;
    // Brood needs worker care (basic biology); the exact day limits are game assumptions.
    b.no_caretaker_days = noCare() ? (b.no_caretaker_days || 0) + 1 : 0;
    const orphanLimit = b.stage === 'larva' ? care.unattended_larva_max_days : b.stage === 'egg' ? care.unattended_egg_max_days : care.unattended_pupa_max_days;
    if (b.no_caretaker_days >= orphanLimit) { events.push({ type: 'brood_death', id: b.id, stage: b.stage, reason: 'unattended_brood_no_worker_care_game_assumption', max_unattended_days_assumption: orphanLimit }); summary.brood_deaths++; if (c4a) closeBroodBody(colony, b, 'death', events); continue; }
    if (noCare() && b.stage === 'larva') { b.age_days = typeof b.age_days === 'number' ? b.age_days + 1 : null; survived.push(b); continue; }
    // C4b: a larva with an account develops from what it paid for itself (N(xᵢ)); otherwise the old colony-wide factor (L2)
    if (c4b && b.stage === 'larva' && b.body) {
      const x = ownPaid?.get(b.id);
      if (x === undefined) throw Error(`LARVA_DEVELOPMENT ${colony.id}: larva ${b.id} has an account but no metabolism record today`);
      const n = nutritionFactor(x, sp), before = b.progress;
      b.progress = round((b.progress || 0) + factor / dev.larva_days * n);
      events.push({ type: 'larva_development', larva: b.id, temperature_factor: round(factor), larva_days_assumption: dev.larva_days, own_paid_fraction: round(x), nutrition_response: sp.larval_development.nutrition_response, nutrition_factor: round(n), progress_before: before, progress_after: b.progress, note: 'C4b: development from the larva\'s own paid metabolism (its own account), not from the colony fraction; the response form is a model assumption', assumption: true });
    } else
    b.progress = round((b.progress || 0) + factor / dev[`${b.stage}_days`] * (b.stage === 'larva' ? Math.max(dev.larva_min_nutrition_growth_factor, Math.min(ratios.pFraction, ratios.sFraction)) : 1));
    b.age_days = typeof b.age_days === 'number' ? b.age_days + 1 : null;
    if (b.stage === 'larva' && colony.stores.protein_gap_days >= st.larva_mortality_starts_days) {
      const g = colonyDice(world, colony, 'brood_survival:' + b.id), risk = clamp(st.larva_daily_hazard_base + (colony.stores.protein_gap_days - st.larva_mortality_starts_days) * st.larva_daily_hazard_slope, 0, st.larva_daily_hazard_cap);
      if (g() < risk) { events.push({ type: 'brood_death', id: b.id, stage: b.stage, reason: 'chronic_protein_shortage_game_scenario', probability_assumption: round(risk) }); summary.brood_deaths++; if (c4a) closeBroodBody(colony, b, 'death', events); continue; }
    }
    if (b.progress >= 1) {
      const old = b.stage; b.progress = round(Math.max(0, b.progress - 1));
      if (old === 'egg') { b.stage = 'larva'; b.age_days = 0; events.push({ type: 'hatch', id: b.id }); summary.hatchings++; if (c4a) hatchRecord(b, events); }
      else if (old === 'larva') { b.stage = 'pupa'; b.age_days = 0; events.push({ type: 'pupation', id: b.id }); summary.pupations++; }
      else if (old === 'pupa' && snapshot) { eclosing.push(b); continue; }
      else if (old === 'pupa') {
        const newId = formatId(colony.worker_id_prefix, colony.next_worker_number++, colony.id_number_width);
        pop.workers.push({ id: newId, alive: true, age_days: sp.worker_lifespan.newborn_initial_age_days, age_origin: 'born_after_v2_migration', injured: false, task: 'nurse', known_sources: [], last_location: colony.nest_node });
        summary.eclosions++; events.push({ type: 'eclosion', source_brood_id: b.id, new_worker_id: newId, caste: sp.castes.eclosion_caste_label }); if (c4a) closeBroodBody(colony, b, 'eclosion', events); continue;
      }
    }
    survived.push(b);
  }
  // v2-review.21: commit the day's eclosions after every brood item has been processed (ids in source-pupa order)
  for (const b of eclosing.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
    const newId = formatId(colony.worker_id_prefix, colony.next_worker_number++, colony.id_number_width);
    pop.workers.push({ id: newId, alive: true, age_days: sp.worker_lifespan.newborn_initial_age_days, age_origin: 'born_after_v2_migration', injured: false, task: 'nurse', known_sources: [], last_location: colony.nest_node });
    summary.eclosions++; events.push({ type: 'eclosion', source_brood_id: b.id, new_worker_id: newId, caste: sp.castes.eclosion_caste_label });
    if (c4a) closeBroodBody(colony, b, 'eclosion', events);
  }
  pop.brood = survived; summary.development_factor = round(factor);
}
