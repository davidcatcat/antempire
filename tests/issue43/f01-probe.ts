/**
 * Issue #43 F01 DEFECT PROBE (evidence, not part of the suite; the correct-behaviour tests T1–T8 of
 * docs/design-wpc-food-compartments.md will be added with the C2 implementation, where they must pass).
 * Two workers, only W001 has sugar in its crop, no trophallaxis contact. A worker without food and without contact
 * must not be judged fed. Prints whether the defect is PRESENT.   node tests/issue43/f01-probe.ts
 */
import { loadBundle } from '../../cli/lib/load.ts';
import { buildDay0 } from '../../cli/lib/day0.ts';
import { resolveBundle } from '../../engine/index.ts';
import { consume } from '../../engine/nutrition.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const b = loadBundle(), sp = resolveBundle(b).species['pheidole-megacephala'];
const s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0];
c.population.brood = []; c.population.workers = c.population.workers.slice(0, 2);
for (const w of c.population.workers) w.crop_cargo_sugar = 0;
c.population.workers[0].crop_cargo_sugar = 0.8; c.stores.sugar = 0.8;
const summary: Any = { extra_sugar_cost: 0 };
consume(s, c, sp, summary, { nest_temp_model_c: 25 } as Any);
const crops = c.population.workers.map((w) => w.crop_cargo_sugar), fed = c.population.workers.map((w) => (w.local_sensory as Any)?.own_feeding_fraction);
console.log(JSON.stringify({ crops_after: crops, own_feeding_fraction: fed, consumed: summary.consumed, F01_defect_present: fed[1] > 0 && crops[1] === 0 }, null, 1));
