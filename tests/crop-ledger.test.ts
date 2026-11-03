/**
 * v2-review.13 bug fix: sugar held in worker crops is always a subset of the colony sugar ledger, on EVERY day of
 * 20 seeds × 120 days (the existing checks in foraging-physics / save-counters only cover one seed). With the fix
 * switch off (v2-review.12) the same scan found violations on days after egg laying (8 of 2,400 days up to the first
 * v2-review.20 draft c87896f; 0 since the PR #44 review fixes changed the foraging trajectories). The scan count with the
 * switch off is still recorded, not hidden. Because a random trajectory may or may not reach the state that shows the bug,
 * the bug itself is now demonstrated deterministically: all colony sugar is held in one worker's crop and the queen lays an
 * egg; with the switch off the crops exceed the ledger, with it on they do not (PR #44 review, 2026-11-03).
 */
import assert from 'node:assert/strict';
import { resolveBundle, simulateDay, type LegacyV2State } from '../engine/index.ts';
import { oviposition } from '../engine/queen.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { bundle, counter, fixture, MAIN_SPECIES } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const c = counter(), { ok } = c;
function scan(on: boolean) {
  const b = bundle(); (b.species[MAIN_SPECIES] as Any).nutrition.egg_laying_settles_crops = on;
  let bad = 0, days = 0, afterLaying = 0;
  for (let seed = 15032026; seed < 15032046; seed++) {
    let s: LegacyV2State = fixture(); s.seed = seed;
    for (let d = 0; d < 120; d++) {
      const o = simulateDay(s, b), crops = o.state.population.workers.reduce((a, w) => a + (w.crop_cargo_sugar || 0), 0);
      days++;
      if (crops > o.state.colony.sugar + 1e-6) { bad++; if (o.summary.eggs_laid > 0) afterLaying++; }
      if (on) ok(crops <= o.state.colony.sugar + 1e-6, `seed ${seed} Day${o.day}: crops ${crops} <= ledger ${o.state.colony.sugar}`);
      s = o.state;
      if (!s.population.workers.length) break;
    }
  }
  return { bad, days, afterLaying };
}
const fixed = scan(true), old = scan(false);
ok(fixed.bad === 0, 'v2-review.13: no day with crops above the ledger');
// the bug the switch fixes, shown deterministically: one worker carries all colony sugar in its crop, the queen lays one egg
function layOneEgg(on: boolean) {
  const b = bundle(), s = buildDay0('A1', 1, '2027-09-23', b).state, c = s.colonies[0], sp = structuredClone(resolveBundle(b).species[MAIN_SPECIES]) as Any;
  sp.nutrition_rules.egg_laying_settles_crops = on;
  Object.assign(sp.queen_laying, { base_laying_probability: 1, laying_probability_cap: 1, existing_brood_pressure: 0, max_eggs_per_day: 1 });
  c.population.brood = []; c.population.workers.forEach((w: Any) => { w.crop_cargo_sugar = 0; });
  c.stores.sugar = 1; c.stores.protein = 1; c.stores.sugar_gap_days = 0; c.stores.protein_gap_days = 0; c.stores.queen_laid_yesterday = false; c.population.workers[0].crop_cargo_sugar = 1;
  const summary: Any = { eggs_laid: 0 }, weather: Any = { nest_temp_model_c: sp.queen_laying.laying_reference_c };
  oviposition(s, c, sp, { sFraction: 1, pFraction: 1 } as Any, weather, [], summary);
  return { eggs: summary.eggs_laid, crops: c.population.workers.reduce((a: number, w: Any) => a + (w.crop_cargo_sugar || 0), 0), ledger: c.stores.sugar };
}
const off = layOneEgg(false), onRun = layOneEgg(true);
ok(off.eggs === 1 && off.crops > off.ledger + 1e-9, `v2-review.12 behaviour (switch off): after one egg the crops ${off.crops} exceed the ledger ${off.ledger} (the bug being fixed)`);
ok(onRun.eggs === 1 && onRun.crops <= onRun.ledger + 1e-9, `v2-review.13 (switch on): after one egg the crops ${onRun.crops} stay within the ledger ${onRun.ledger}`);
assert.ok(c.checks > 1000);
console.log(JSON.stringify({ passed: true, checks: c.checks, days_scanned: fixed.days, v12_violating_days: old.bad, v12_violating_days_on_laying_days: old.afterLaying }, null, 2));
