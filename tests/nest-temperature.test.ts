/**
 * v2-review.7 rules update: the model nest temperature remembers yesterday's NEST temperature.
 *   nest_today = round(prior_nest_temp_model_c × m + air_today × (1 − m)),  m = world nest_microclimate.nest_temp_memory
 * With no recorded nest temperature yet (first day after the Day15 migration) it falls back to yesterday's air.
 */
import assert from 'node:assert/strict';
import { calcWeather, resolveWorld, round, simulateDay } from '../engine/index.ts';
import { bundle, fixture } from './lib/harness.ts';

const b = bundle(), wp = resolveWorld(b.world), m = wp.nest_microclimate.nest_temp_memory, s0 = fixture();
let checks = 0;
const date = '2026-11-14';
// 1. fallback: no prior nest temperature recorded -> yesterday's air temperature
assert.equal(s0.climate.prior_nest_temp_model_c, undefined);
const w0 = calcWeather(s0, wp, date);
assert.equal(w0.nest_temp_model_c, round(s0.climate.prior_air_temp_c * m + w0.air_temp_c * (1 - m))); checks++;
// 2. with a recorded nest temperature the memory uses it (air weather itself is unchanged)
for (const prior of [12, 18.5, 26]) {
  const s = structuredClone(s0); s.climate.prior_nest_temp_model_c = prior;
  const w = calcWeather(s, wp, date);
  assert.equal(w.air_temp_c, w0.air_temp_c); assert.equal(w.rain_mm, w0.rain_mm); checks += 2;
  assert.equal(w.nest_temp_model_c, round(prior * m + w.air_temp_c * (1 - m))); checks++;
  if (prior !== s0.climate.prior_air_temp_c) { assert.notEqual(w.nest_temp_model_c, w0.nest_temp_model_c); checks++; }
}
// 3. over consecutive days the engine carries the nest temperature forward
let state = s0;
for (let d = 0; d < 30; d++) {
  const out = simulateDay(state, b), w = out.summary.weather;
  const prior = state.climate.prior_nest_temp_model_c ?? state.climate.prior_air_temp_c;
  assert.equal(w.nest_temp_model_c, round(prior * m + w.air_temp_c * (1 - m)), 'day ' + out.day); checks++;
  assert.equal(out.state.climate.prior_nest_temp_model_c, w.nest_temp_model_c); checks++;
  state = out.state;
}
console.log(JSON.stringify({ passed: true, checks, nest_temp_memory: m }, null, 2));
