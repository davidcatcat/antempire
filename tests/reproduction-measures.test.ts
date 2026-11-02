/**
 * Reproduction measures (Issue #43 F07). Correct-behaviour assertions: every 30-day bin that has data counts,
 * including the last partial bin Day361–365. (The v1 definition counted only the first 12 bins; it is kept as a
 * separately named field own_eclosion_windows_first_360 for traceability.)
 */
import assert from 'node:assert/strict';
import { reproductionMeasures, binOf } from '../cli/reports/reproduction-measures.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const run = (own: number[], eggs: number[], c365: object) => ({ own_eclosions: own.reduce((a, b) => a + b, 0), own_eclosions_by_30d: own, eggs_laid_by_30d: eggs, checkpoints: { 365: c365 } });
const z = () => new Array(13).fill(0);
ok(binOf(361) === 12 && binOf(365) === 12 && binOf(360) === 11 && binOf(1) === 0, 'Day361–365 form bin 12');
{ // only eclosion on Day365 (bin 12)
  const own = z(); own[12] = 1;
  const m = reproductionMeasures(run(own, z(), { extinct: false, queen: true, workers: 3 }));
  ok(m.any_own_worker_eclosion === true, 'eclosion on Day365 counts as an eclosion');
  ok(m.own_eclosion_windows === 1, `F07: the Day361–365 bin counts as a window with eclosion (got ${m.own_eclosion_windows})`);
  ok(m.own_eclosion_windows_first_360 === 0, 'the v1 field (first 360 days only) is 0, and is named as such');
  ok(m.own_eclosions_second_half === 1, 'second half includes Day365');
}
{ // every bin
  const own = new Array(13).fill(1), m = reproductionMeasures(run(own, z(), { extinct: false, queen: true, workers: 3 }));
  ok(m.own_eclosion_windows === 13 && m.own_eclosion_windows_first_360 === 12, 'all 13 bins counted; first-360 field counts 12');
}
console.log(`reproduction-measures: ${checks} checks passed`);
