/**
 * C4b (docs/design-c4b-larval-development.md; switch larval_development.individual_development_c4b, requires C4a): a larva
 * develops at  Δprogress = r_s(T) / larva_days × N(xᵢ)  where
 *   r_s(T)  the existing temperature factor (Q10 with limits; unchanged — #38 / P0-B decide the temperature model);
 *   xᵢ      = min over sugar and protein of (what THIS larva paid for its own metabolism today / its own need), from its own
 *           account (C4a, D3) — so a bolus eaten yesterday can still be spent today; never a colony quantity;
 *   N(x)    the nutrition-response form, an OWNER DECISION (null until chosen; switching on is refused):
 *           'clamp_linear' clamp(x, n_min, 1)  (the old formula with the individual input; the linear form is an assumption)
 *           'threshold'    x ≥ θ ? 1 : n_min
 *           'saturating'   n_min + (1 − n_min) · x (1 + K) / (K + x)
 * Care (no worker in the colony at the start of the step) keeps the existing rule (stated limit, design §4). The
 * development is recorded per larva per day as a larva_development event. Model assumptions, not species measurements.
 */
import { clamp, round } from './math.ts';
import type { SpeciesParams } from './params.ts';
import type { ColonyState, SimEvent } from './types.ts';
import type { LarvaRoundStart } from './larva-feeding.ts';

type Food = { sugar: number; protein: number };

/** xᵢ: the fraction of its own need a larva paid today (worst of the two foods), in [0, 1]. */
export const ownPaidFraction = (paid: Food, need: Food): number => clamp(Math.min(need.sugar > 0 ? paid.sugar / need.sugar : 1, need.protein > 0 ? paid.protein / need.protein : 1), 0, 1);

/** N(x) for the chosen form. Throws when no form is chosen (the parameter check refuses this earlier). */
export function nutritionFactor(x: number, sp: SpeciesParams): number {
  const ld = sp.larval_development, nmin = sp.development.larva_min_nutrition_growth_factor;
  if (ld.nutrition_response === 'clamp_linear') return clamp(x, nmin, 1);
  if (ld.nutrition_response === 'threshold') return x >= (ld.threshold_theta as number) ? 1 : nmin;
  if (ld.nutrition_response === 'saturating') { const k = ld.saturation_k as number; return clamp(nmin + (1 - nmin) * x * (1 + k) / (k + x), nmin, 1); }
  throw Error(`LARVA_DEVELOPMENT: no nutrition-response form chosen (${JSON.stringify(ld.nutrition_response)})`);
}

/** The temperature factor of development (the same expression as engine/brood.ts developBrood). */
export const developmentFactor = (sp: SpeciesParams, nestTempC: number): number => clamp(Math.pow(sp.development.q10, (nestTempC - sp.development.reference_c) / 10), sp.development.min_temp_factor, sp.development.max_temp_factor);

/**
 * Engine check of a C4b day (B1, B4): every larva that was a larva with an account at the start and had care develops by
 * exactly r_s(T) / larva_days × N(xᵢ), xᵢ recomputed from its own larva_metabolism transfers and its own need; one record
 * each; its end progress follows (or it pupated with the remainder, or it died). No care: no development, no record.
 */
export function checkLarvaDevelopment(start: LarvaRoundStart, colony: ColonyState, events: SimEvent[], sp: SpeciesParams, nestTempC: number, metabolicFactor: number, workersAtStart: number): void {
  const fail = (m: string) => { throw Error(`LARVA_DEVELOPMENT ${colony.id}: ${m}`); };
  const factor = developmentFactor(sp, nestTempC), need = { sugar: round(sp.nutrition.larva_sugar_daily * metabolicFactor), protein: round(sp.nutrition.larva_protein_daily * metabolicFactor) };
  const paid = new Map<string, Food>();
  for (const e of events) if (e.type === 'food_transfer' && e.cause === 'larva_metabolism') { const x = e as unknown as { source: { id: string }; food_type: 'sugar' | 'protein'; portions: number }; const p = paid.get(x.source.id) ?? { sugar: 0, protein: 0 }; p[x.food_type] = round(p[x.food_type] + x.portions); paid.set(x.source.id, p); }
  const recs = new Map<string, SimEvent>();
  for (const e of events) if (e.type === 'larva_development') { const id = String(e.larva); if (recs.has(id)) fail(`two development records for ${id}`); recs.set(id, e); }
  const end = new Map(colony.population.brood.map((b) => [b.id, b])), pupated = new Set(events.filter((e) => e.type === 'pupation').map((e) => String(e.id))), died = new Set(events.filter((e) => e.type === 'brood_death').map((e) => String(e.id)));
  for (const [id, b] of start.brood) {
    const rec = recs.get(id);
    if (b.stage !== 'larva' || !b.body) { if (rec) fail(`development record for ${id} (${b.stage}), not a larva with an account`); continue; }
    // Codex review (2026-11-07): without care a larva does not develop — no record AND no change of progress or stage
    if (workersAtStart === 0) { if (rec) fail(`${id} developed on a day with no worker care`); const e0 = end.get(id); if (e0 && (e0.stage !== 'larva' || e0.progress !== b.progress)) fail(`larva ${id}: no care today, but its stage/progress changed ${b.stage}/${b.progress} -> ${e0.stage}/${e0.progress}`); if (pupated.has(id)) fail(`larva ${id} pupated on a day without care`); continue; }
    if (!rec) { if (!died.has(id) || end.has(id)) fail(`larva ${id} has no development record`); continue; }
    const x = ownPaidFraction(paid.get(id) ?? { sugar: 0, protein: 0 }, need), n = nutritionFactor(x, sp), after = round((b.progress as number) + factor / sp.development.larva_days * n);
    if (rec.own_paid_fraction !== round(x) || rec.nutrition_factor !== round(n) || rec.progress_before !== b.progress || rec.progress_after !== after || rec.nutrition_response !== sp.larval_development.nutrition_response) fail(`larva ${id}: development ${JSON.stringify({ x: rec.own_paid_fraction, n: rec.nutrition_factor, before: rec.progress_before, after: rec.progress_after })}; its own records give ${JSON.stringify({ x: round(x), n: round(n), before: b.progress, after })}`);
    const e = end.get(id);
    // Codex review (2026-11-07): pupation happens exactly when the progress reaches 1 — never below it, always at or above it
    if (after >= 1 && !(e === undefined ? died.has(id) : e.stage === 'pupa' && pupated.has(id))) fail(`larva ${id} reached progress ${after} ≥ 1 but did not pupate`);
    if (after < 1 && (pupated.has(id) || e?.stage === 'pupa')) fail(`larva ${id} pupated at progress ${after} < 1`);
    if (e && e.stage === 'larva' && e.progress !== after) fail(`larva ${id}: end progress ${e.progress}, the development record gives ${after}`);
    if (e && e.stage === 'pupa' && e.progress !== round(Math.max(0, after - 1))) fail(`larva ${id} pupated with progress ${e.progress}; the record gives ${round(Math.max(0, after - 1))}`);
  }
  for (const id of recs.keys()) if (!start.brood.has(id)) fail(`development record for ${id}, which was not brood at the start`);
}
