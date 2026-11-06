/**
 * v2-review.27 (Issue #82): relative-humidity wet/dry offsets balanced on the day's rain prior.
 *  - BEFORE (switch off): the fixed offsets (+5 wet, −2 dry, game assumptions) average 7p − 2, so the simulated monthly
 *    mean drifts from the CWA 1991–2020 normal in a month-dependent direction (wet months too humid, dry months too dry).
 *  - AFTER (switch on): offset = (wet − dry) × (wet? − rain prior) — the form the temperature offset already uses — so its
 *    long-run mean is 0 and the wet−dry contrast (7 points) is unchanged.
 *  - The comparison baseline is the same generator with both offsets and the anomaly term set to 0: what is left there is
 *    the monthly interpolation of the normals (engine/weather.ts monthInterp), an existing, separate effect that this
 *    rules update does not touch (reported, not fixed).
 *  - Relative humidity is read by no ant mechanism: with the switch on, every other weather field and every colony result
 *    is identical; only relative_humidity_model_percent changes.
 * Tolerances fixed in advance from the expected sampling error of a 20-seed × 3-year mean (≈ 0.1 point); synthetic
 * weather, not observations; engineering check, not a climate validation.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { resolveBundle, simulateWorldDay } from '../engine/index.ts';
import { calcWeather, nextClimate } from '../engine/weather.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const OFF: Any = loadBundle();
const variant = (on: boolean, zero = false) => { const b: Any = structuredClone(OFF); b.world.weather_rules.rh_offsets_balanced_v27 = on; if (zero) { b.world.climate.rh_wet_offset_percent.value = 0; b.world.climate.rh_dry_offset_percent.value = 0; b.world.climate.rh_anomaly_coefficient.value = 0; } return b; };
const monthly = (b: Any) => {
  const wp = resolveBundle(b).world, sum = Array.from({ length: 12 }, () => ({ rh: 0, n: 0, wet: 0, nw: 0, dry: 0, nd: 0 })), contrast = { wet: 0, nw: 0, dry: 0, nd: 0 };
  let normal: number[] = [];
  for (let seed = 1; seed <= 20; seed++) {
    const w: Any = buildDay0('A1' as Any, seed, '2027-01-01', b).state; normal = w.climate.monthly.map((r: Any) => r.mean_relative_humidity_percent);
    let date = w.calendar_date;
    for (let d = 0; d < 365 * 3; d++) {
      const nd = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10), wx: Any = calcWeather(w, wp, nd), m = Number(nd.slice(5, 7)) - 1;
      sum[m].rh += wx.relative_humidity_model_percent; sum[m].n++;
      if (wx.wet) { sum[m].wet += wx.relative_humidity_model_percent; sum[m].nw++; } else { sum[m].dry += wx.relative_humidity_model_percent; sum[m].nd++; }
      if (wx.wet) { contrast.wet += wx.relative_humidity_model_percent; contrast.nw++; } else { contrast.dry += wx.relative_humidity_model_percent; contrast.nd++; }
      w.climate = nextClimate(w.climate, wx); w.sim_day++; date = nd;
    }
  }
  const within = sum.filter((s) => s.nw > 0 && s.nd > 0).map((s) => s.wet / s.nw - s.dry / s.nd);
  return { bias: sum.map((s, i) => s.rh / s.n - normal[i]), contrast: within.reduce((a, b) => a + b, 0) / within.length, pooled: contrast.wet / contrast.nw - contrast.dry / contrast.nd };
};
const off = monthly(variant(false)), on = monthly(variant(true)), interp = monthly(variant(false, true));
const vsInterp = (x: { bias: number[] }) => x.bias.map((v, i) => +(v - interp.bias[i]).toFixed(3));
const offErr = vsInterp(off), onErr = vsInterp(on), maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));
ok(maxAbs(offErr) > 1.0, `BEFORE (switch off): the fixed offsets move the monthly mean by up to ${maxAbs(offErr)} points beyond the interpolation baseline (${JSON.stringify(offErr)})`);
ok(offErr[6] > 0.5 && offErr[10] < -0.5, `BEFORE: the sign follows 7p − 2 — the wet July too humid (${offErr[6]}), the dry November too dry (${offErr[10]})`);
ok(maxAbs(onErr) <= 0.2, `AFTER (switch on): every monthly mean within 0.2 points of the interpolation baseline (${JSON.stringify(onErr)})`);
// within a month (same rain prior) every day is shifted by the same 2 − 7p, so the within-month wet−dry contrast is kept;
// the contrast POOLED over the year is not (wet days fall in high-p months, which shift more) — reported, not a target
ok(Math.abs(on.contrast - off.contrast) <= 0.1, `AFTER: the within-month wet−dry contrast is unchanged (${off.contrast.toFixed(3)} -> ${on.contrast.toFixed(3)} points); pooled over the year it changes ${off.pooled.toFixed(3)} -> ${on.pooled.toFixed(3)}`);
ok(maxAbs(interp.bias) > 0.3, `stated, not fixed: the monthly interpolation of the normals alone leaves up to ${maxAbs(interp.bias).toFixed(2)} points (existing, separate effect)`);

// switch on changes only relative humidity: no ant reads it
{
  const bOn = variant(true);
  let a: Any = buildDay0('A5' as Any, 3, '2027-03-21', OFF).state, c: Any = buildDay0('A5' as Any, 3, '2027-03-21', bOn).state, days = 0, rhDiff = 0;
  for (let d = 0; d < 40; d++) {
    const oa: Any = simulateWorldDay(a, OFF), oc: Any = simulateWorldDay(c, bOn);
    const strip = (o: Any) => { const x = structuredClone(o); delete x.result.weather.relative_humidity_model_percent; delete x.state.last_world_events; return JSON.stringify([x.result.colonies, x.result.world_events, x.result.weather, x.state.colonies, x.state.sources, x.state.ecology]); };
    ok(strip(oa) === strip(oc), `switch on, day ${oa.day}: every weather field except relative humidity, every event and every colony state equal the switch-off run`);
    if (oa.result.weather.relative_humidity_model_percent !== oc.result.weather.relative_humidity_model_percent) rhDiff++;
    days++; a = oa.state; c = oc.state;
  }
  ok(rhDiff > 0, `switch on changes relative humidity on ${rhDiff}/${days} days`);
}
console.log(JSON.stringify({ test: 'rh-offsets-v27', checks, bias_vs_interpolation: { off: offErr, on: onErr }, interpolation_only_bias: interp.bias.map((v) => +v.toFixed(3)), contrast_within_month: { off: +off.contrast.toFixed(3), on: +on.contrast.toFixed(3) }, contrast_pooled: { off: +off.pooled.toFixed(3), on: +on.pooled.toFixed(3) }, note: 'synthetic weather; engineering check, not a climate validation' }, null, 2));
