/**
 * V4 (Issue #99 follow-up): derived walking speed and the daily ecology series of the read-only viewer, on the committed
 * 30-day experiment replays (web/data). The viewer may only show numbers that come from engine records:
 *  1. dailySeries: one point for Day0 and one per simulated day; every value equals the exported engine end-of-day state
 *     or day summary (no smoothing, no interpolation); Day0 has no daily flows (null, never 0 invented);
 *  2. walkSpeedAt: only while a worker walks a recorded edge; = recorded edge length / engine-recorded time on that edge;
 *     null speed when the edge length is not recorded (never estimated);
 *  3. engine-replay consistency: every derived speed equals the engine's own walking speed — the species trail speed
 *     (activity.trail_walking_speed_mm_s) or that × activity.off_trail_speed_factor — within the export's minute rounding;
 *  4. purity: frozen data, deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { dailySeries, walkSpeedAt, segmentsOf, type Experiment } from '../web/src/model.ts';
import { CHARTS, chartSvg, tableHtml } from '../web/src/charts.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const DATA = path.join(REPO_ROOT, 'web', 'data'), index = JSON.parse(fs.readFileSync(path.join(DATA, 'index.json'), 'utf8'));
const deepFreeze = <T>(o: T): T => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const sp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'species', 'pheidole-megacephala.json'), 'utf8'));
const vTrail = sp.activity.trail_walking_speed_mm_s.value as number, vOff = vTrail * (sp.activity.off_trail_speed_factor.value as number);
let speeds = 0, unknown = 0, onTrail = 0, offTrail = 0, notWalking = 0;
for (const meta of index.experiments) {
  const exp = deepFreeze(JSON.parse(fs.readFileSync(path.join(DATA, meta.file), 'utf8')) as Experiment), id = exp.spec.id;
  // 1. series
  const s = dailySeries(exp);
  ok(s.length === exp.days.length + 1 && s[0].day === 0 && s.every((p, i) => p.day === i), `${id}: Day0 + one point per simulated day`);
  ok(s[0].income_sugar === null && s[0].air_c === null && s[0].deaths === null && s[0].workers === exp.day0.state.workers.length, `${id}: Day0 has the initial state and no invented daily flows`);
  for (const d of exp.days) {
    const p = s[d.day], e = d.end_state;
    assert.equal(p.workers, e.workers.length); assert.equal(p.eggs, e.brood.filter((b) => b.stage === 'egg').length); assert.equal(p.larvae, e.brood.filter((b) => b.stage === 'larva').length); assert.equal(p.pupae, e.brood.filter((b) => b.stage === 'pupa').length);
    assert.equal(p.store_sugar, e.stores.sugar); assert.equal(p.store_protein, e.stores.protein);
    assert.equal(p.garden_sugar, Object.values(e.sources).reduce((q, x) => q + x.sugar, 0)); assert.equal(p.garden_protein, Object.values(e.sources).reduce((q, x) => q + x.protein, 0));
    assert.equal(p.income_sugar, d.income.sugar); assert.equal(p.air_c, d.weather.air_temp_c); assert.equal(p.nest_c, d.weather.nest_temp_c); assert.equal(p.rain_mm, d.weather.rain_mm);
    assert.equal(p.deaths, d.worker_deaths); assert.equal(p.eclosions, d.eclosions); assert.equal(p.eggs_laid, d.eggs_laid);
    checks += 15;
  }
  // charts and table render every day and every series
  for (const c of CHARTS) { const svg = chartSvg(c, s, 5); ok(svg.includes(`data-chart="${c.id}"`) && c.series.every((_, i) => svg.includes(`class="s${i + 1}"`)), `${id}: chart ${c.id} draws all its series`); }
  ok((tableHtml(s).match(/<tr>/g) ?? []).length === s.length + 1, `${id}: the table lists every day`);
  // 2./3. speed
  for (const d of exp.days) {
    for (const st of d.events.filter((e) => e.type === 'route_step')) {
      const w = st.worker as string, t = st.minute as number, v = walkSpeedAt(d, w, t, exp.map.links);
      assert.ok(v, `${id} day ${d.day}: ${w} walking at its recorded arrival minute ${t} has a speed record`);
      assert.equal(v.to, st.to, 'the speed belongs to the recorded edge'); assert.equal(v.t1, t, 'ending at the recorded arrival');
      const link = exp.map.links.find((l) => (l.from === v.from && l.to === v.to) || (l.from === v.to && l.to === v.from));
      if (typeof link?.length_cm !== 'number') { assert.equal(v.mm_s, null, 'no recorded length -> speed unknown'); unknown++; continue; }
      assert.equal(v.mm_s, (link.length_cm * 10) / ((v.t1 - v.t0) * 60), 'speed = recorded length / recorded time');
      const tol = 1e-3;
      if (Math.abs((v.mm_s as number) - vTrail) <= tol) onTrail++; else if (Math.abs((v.mm_s as number) - vOff) <= tol) offTrail++;
      else assert.fail(`${id} day ${d.day} ${w} ${v.edge}: derived ${v.mm_s} mm/s is neither the engine's trail speed ${vTrail} nor off-trail ${vOff}`);
      speeds++;
    }
    // not walking -> no speed
    for (const w of (d.day === 1 ? exp.day0.state : exp.days[d.day - 2].end_state).workers.slice(0, 4)) {
      const segs = segmentsOf(d, w.id), walking = (t: number) => segs.some((x) => (x.start as number) <= t && t <= (x.end as number) && String(x.place).includes('>'));
      for (const t of [0.5, 90, 200]) if (!walking(t)) { assert.equal(walkSpeedAt(d, w.id, t, exp.map.links), null, 'no speed when not walking'); notWalking++; }
    }
  }
}
ok(speeds > 0 && unknown > 0 && onTrail > 0 && offTrail > 0 && notWalking > 0, `speeds derived ${speeds} (trail ${onTrail}, off-trail ${offTrail}), unknown-length ${unknown}, not walking ${notWalking}: every derived speed equals the engine's own walking speed`);
console.log(JSON.stringify({ passed: true, checks, speeds, onTrail, offTrail, unknown, notWalking, trail_mm_s: vTrail, off_trail_mm_s: vOff }));
