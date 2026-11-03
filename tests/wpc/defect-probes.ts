/**
 * Work package C DEFECT PROBES (evidence, not part of the test suite): whether Issue #43 F01 (T1) and A08 (T6) are
 * present in the current engine. Prints PRESENT/ABSENT; does not assert. Run: node tests/wpc/defect-probes.ts
 * The correct-behaviour assertions become suite tests in the C2 (T1) and C4 (T6) rules updates.
 */
import { loadBundle } from '../../cli/lib/load.ts';
import { buildDay0 } from '../../cli/lib/day0.ts';
import { resolveBundle } from '../../engine/index.ts';
import { consume } from '../../engine/nutrition.ts';
import { oviposition } from '../../engine/queen.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const b = loadBundle(), sp: Any = resolveBundle(b).species['pheidole-megacephala'];
const weather: Any = { nest_temp_model_c: 25, rain_mm: 0, daytime_air_temp_c: 28, soil_index: 0 };
const summary = (): Any => ({ extra_sugar_cost: 0, eggs_laid: 0 });
// T1 (F01): W001 holds 0.8 sugar, W002 holds 0, no trophallaxis — is W002 judged fed?
const t1 = (() => {
  const s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0];
  c.population.brood = []; c.population.workers = c.population.workers.slice(0, 2); c.population.workers.forEach((w: Any) => { w.crop_cargo_sugar = 0; });
  c.population.workers[0].crop_cargo_sugar = 0.8; c.stores.sugar = 0.8;
  consume(s, c, sp, summary(), weather);
  return { W002_crop: c.population.workers[1].crop_cargo_sugar, W002_own_feeding_fraction: c.population.workers[1].local_sensory?.own_feeding_fraction };
})();
// T6 (A08): change ONLY the number of brood the queen never touches (remote) — does her laying probability change?
const t6 = (extraRemoteBrood: number) => {
  const s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0], sm = summary();
  c.stores.sugar = 5; c.stores.protein = 5; c.stores.sugar_gap_days = 0; c.stores.protein_gap_days = 0; c.stores.queen_laid_yesterday = false;
  for (let i = 0; i < extraRemoteBrood; i++) c.population.brood.push({ id: `R${i}`, stage: 'pupa', laid_on_day: 0, age_days: 0, progress: 0, origin: 'probe' } as Any);
  oviposition(s, c, sp, { sFraction: 1, pFraction: 1 } as Any, weather, [], sm);
  return sm.queen_laying_probability_applied;
};
const p0 = t6(0), p40 = t6(40);
console.log(JSON.stringify({
  T1_F01: { present: t1.W002_own_feeding_fraction === 1 && t1.W002_crop === 0, ...t1 },
  T6_A08: { present: p0 !== p40, laying_probability_without_remote_brood: p0, with_40_remote_pupae: p40 },
}, null, 1));
