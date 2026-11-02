/**
 * v2-review.13 bug fix: sugar held in worker crops is always a subset of the colony sugar ledger, on EVERY day of
 * 20 seeds × 120 days (the existing checks in foraging-physics / save-counters only cover one seed). With the fix
 * switch off (v2-review.12) the same scan finds violations on days after egg laying; this is recorded, not hidden.
 */
import assert from 'node:assert/strict';
import { simulateDay, type LegacyV2State } from '../engine/index.ts';
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
ok(old.bad > 0 && old.afterLaying > 0, `v2-review.12 (switch off) had ${old.bad} such days, ${old.afterLaying} of them on laying days (the bug being fixed)`);
assert.ok(c.checks > 1000);
console.log(JSON.stringify({ passed: true, checks: c.checks, days_scanned: fixed.days, v12_violating_days: old.bad, v12_violating_days_on_laying_days: old.afterLaying }, null, 2));
