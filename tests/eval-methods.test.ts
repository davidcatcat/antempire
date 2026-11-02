/**
 * v2-review.19 evaluation-method checks (the experiments must test what they claim):
 *  1. the continuous-rain forcing used by cli/reports/day0-extremes.ts (E5a–c) really makes every forced day wet
 *     through the world climate parameters the weather generator reads, and soil wetness rises;
 *  2. the far-food forcing (E2a–c) really lengthens the walking path: one-way minutes scale with the length factor;
 *  3. the lone-queen hazard parameters are labelled as game assumptions (not literature measurements).
 */
import assert from 'node:assert/strict';
import { simulateWorldDay, resolveBundle, type ParamBundle } from '../engine/index.ts';
import { edgeMinutes } from '../engine/activity.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0, seasonStart } from '../cli/lib/day0.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SP = 'pheidole-megacephala';

// 1. continuous rain
{
  const b = loadBundle(), wet: ParamBundle = structuredClone(b), c = (wet.world as Any).climate;
  c.annual_rain_days.value = 365; c.rain_probability_daily_cap.value = 1; c.wet_persistence.value = 0;
  // E5a: every forced day is wet. The generator keeps each month's expected rainfall and divides it by the expected
  // number of wet days, so forcing every day wet spreads the SAME expected total as light daily rain (reported so).
  // E5b: the monthly totals are also raised to 600 mm during the block: real heavy continuous rain.
  for (const seed of [20270001, 20270002, 20270003, 20270004, 20270005]) {
    let s = buildDay0('A1', seed, seasonStart('autumn'), b).state, h = structuredClone(s), ctl = structuredClone(s), wetDays = 0, heavyWet = 0, rainHeavy = 0, rainCtl = 0, soilHeavy = 0, soilCtl = 0;
    const orig = h.climate.monthly.map((m) => m.mean_monthly_precipitation_mm);
    for (let d = 1; d <= 23; d++) {
      if (d >= 10) for (const m of h.climate.monthly) m.mean_monthly_precipitation_mm = 600;
      const o = simulateWorldDay(s, d >= 10 ? wet : b), oh = simulateWorldDay(h, d >= 10 ? wet : b), q = simulateWorldDay(ctl, b);
      const w = o.result.weather as Any, wh = oh.result.weather as Any, wc = q.result.weather as Any;
      if (d >= 10) { if (w.wet && w.rain_mm > 0) wetDays++; if (wh.wet && wh.rain_mm > 0) heavyWet++; rainHeavy += wh.rain_mm; rainCtl += wc.rain_mm; soilHeavy += wh.soil_index; soilCtl += wc.soil_index; }
      s = o.state; h = oh.state; ctl = q.state;
    }
    h.climate.monthly.forEach((m, i) => { m.mean_monthly_precipitation_mm = orig[i]; });
    ok(wetDays === 14 && heavyWet === 14, `seed ${seed}: E5a and E5b make all 14 forced days wet (${wetDays}, ${heavyWet})`);
    ok(rainHeavy / 14 >= 10 && rainHeavy > rainCtl && soilHeavy >= soilCtl - 1e-9, `seed ${seed}: E5b brings heavy rain (${(rainHeavy / 14).toFixed(1)} mm/day vs control ${(rainCtl / 14).toFixed(1)}) and wetter soil (${(soilHeavy / 14).toFixed(3)} vs ${(soilCtl / 14).toFixed(3)})`);
  }
  // the v18 E5 design changed a field the generator does not read: the number of wet days is unchanged
  const s0 = buildDay0('A1', 20270001, seasonStart('autumn'), b).state, s1 = structuredClone(s0);
  (s1.climate as Any).rain_days_per_year = 999;
  let a = s0, x = s1, same = true;
  for (let d = 0; d < 30; d++) { const o = simulateWorldDay(a, b), p = simulateWorldDay(x, b); if ((o.result.weather as Any).wet !== (p.result.weather as Any).wet) same = false; a = o.state; x = p.state; }
  ok(same, 'documented defect: climate.rain_days_per_year in the state does not change which days are wet (the v18 E5 design had no effect on rain frequency)');
}
// 2. far food
{
  for (const k of [5, 20, 100]) {
    const b = loadBundle(); for (const v of Object.values((b.world as Any).routes.edge_length_cm)) if (v && typeof v === 'object' && 'value' in (v as Any)) (v as Any).value *= k;
    const base = resolveBundle(loadBundle()), far = resolveBundle(b), col: Any = { trail_by_edge: { 'F01:N00': 1 } };
    const m0 = edgeMinutes(base.species[SP], base.world, col, 'N00', 'F01').minutes, m1 = edgeMinutes(far.species[SP], far.world, col, 'N00', 'F01').minutes;
    ok(Math.abs(m1 / m0 - k) < 1e-3 && far.world.routes.edge_length_cm['F01:N00'] === 48 * k, `×${k}: N00–F01 is ${48 * k} cm and takes ${m1} min (×${k} the walking time) — distance, not just time`);
  }
}
// 3. labels
{
  const st = (loadBundle().species[SP] as Any).starvation;
  ok(st.queen_zero_worker_hazard_after_days.basis === '遊戲假設' && st.queen_zero_worker_starved_daily_hazard.basis === '遊戲假設', 'lone-queen hazard start (14 d) and daily hazard (0.24) are labelled game assumptions');
}
console.log(JSON.stringify({ passed: true, checks }, null, 2));
