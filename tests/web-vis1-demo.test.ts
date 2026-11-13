/**
 * VIS-1 (P0-A2 experiment view: garden scene, articulated ants, display paths, underground concept view) — Node checks
 * of the pure display modules. Non-official experiment world (Owner #201). Checks:
 *  1. display paths are deterministic: the same ant + trip (departure instant) gives the same curve, from fresh model
 *     instances too; different trips differ; nothing depends on call order or frame rate.
 *  2. end points and timing match the engine: for every travelling worker sampled over 24 h (two seeds), the drawn
 *     position at the recorded departure instant is EXACTLY the start (nest or source) and at the recorded arrival
 *     instant EXACTLY the end, never interpolated at those instants; strictly between them the pose is flagged display
 *     interpolation and the distance along the displayed path is proportional to elapsed time (constant speed: the ant
 *     covers the displayed path exactly in [since_s, until_s]); the corridor arc length equals the engine route length
 *     and every trip path stays within 2 % of it (displayed speed = engine length / travel time).
 *  3. gait phase advances monotonically with the displayed ground distance (proportional below the anti-aliasing cap,
 *     never negative), including along real trips.
 *  4. observation does not change the world: a world whose frames are turned into display poses (and underground
 *     spots) at many times reaches the same event-log hash and the same full payload at T as a world that is only
 *     stepped; frames are never mutated.
 *  5. labels: the page names 「路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎」, 裝飾 and 示意 classes in a legend; the
 *     underground view carries 「概念圖：巢室幾何尚未模擬」; every garden item is flagged decoration and stones / plants
 *     keep off the display corridor and the nest / source clearings.
 *  6. underground concept view shows only engine facts: in-nest / transit workers get a spot, outside workers none;
 *     a worker in the entrance passage is at the passage ends at its recorded instants.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { VisModel, PATH_LABEL, UNDERGROUND_LABEL, VIS_LEGEND } from '../web/src/vis1-model.ts';
import { gaitAdvance, makeCorridor, poseOnTrip, tripPath, STRIDE_BODY_LENGTHS } from '../web/src/vis1-path.ts';
import { Garden, DECOR_CLASSES } from '../web/src/vis1-garden.ts';
import { undergroundSpot } from '../web/src/vis1-nest.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const frameOf = (w: P0a2ExperimentWorld) => w.frame() as unknown as P0a2FrameMsg;

// 1. determinism
{
  const C1 = makeCorridor(7, 200), C2 = makeCorridor(7, 200);
  ok(JSON.stringify(C1.line.pts) === JSON.stringify(C2.line.pts), 'corridor: same world seed → same curve');
  ok(JSON.stringify(makeCorridor(8, 200).line.pts) !== JSON.stringify(C1.line.pts), 'corridor: another world seed → another curve');
  const a = tripPath(C1, 'w003', 3600.25, 3718, 'outbound'), b = tripPath(C2, 'w003', 3600.25, 3718, 'outbound'), c = tripPath(C1, 'w003', 4000, 4117.6, 'outbound'), d = tripPath(C1, 'w004', 3600.25, 3718, 'outbound');
  ok(JSON.stringify(a.line.pts) === JSON.stringify(b.line.pts), 'trip path: same ant + departure instant → identical curve (fresh instances)');
  ok(JSON.stringify(a.line.pts) !== JSON.stringify(c.line.pts) && JSON.stringify(a.line.pts) !== JSON.stringify(d.line.pts), 'trip path: another trip or ant → another curve');
  const ts = [3600.25, 3650, 3700.5, 3718];
  const fwd = ts.map((t) => poseOnTrip(a, t)), rev = [...ts].reverse().map((t) => poseOnTrip(b, t)).reverse();
  ok(JSON.stringify(fwd) === JSON.stringify(rev), 'trip pose depends only on (trip, t), not on call order');
}

// 2 + 4. end points / timing over 24 h, and observation does not change results
const T = 86_400;
const stats = { travelling: 0, exactStart: 0, exactEnd: 0, interpolated: 0, linear: 0, maxLenErr: 0, feeding: 0, search: 0, inNest: 0 };
for (const seed of [7, 31]) {
  const { world } = P0a2ExperimentWorld.create(`exp-vis1-${seed}`, seed), { world: plain } = P0a2ExperimentWorld.create(`exp-vis1-${seed}`, seed);
  const f0 = frameOf(world), V = VisModel.of(f0);
  ok(Math.abs(V.corridor.line.len - f0.layout.source_distance_cm) < 1e-9 * f0.layout.source_distance_cm, `seed ${seed}: corridor arc length = engine route length (${V.corridor.line.len.toFixed(9)} cm)`);
  for (let t = 0; t <= T; t += 61) {
    world.advanceTo(t); const f = frameOf(world), frozen = JSON.stringify(f);
    for (const w of f.workers) {
      const p = V.pose(w, f.t_sim);
      if (w.state === 'outbound' || w.state === 'returning') {
        stats.travelling++;
        const P = V.trip(w), s0 = V.pose(w, w.since_s), s1 = V.pose(w, w.until_s!);
        const start = w.state === 'outbound' ? V.corridor.nest : w.route === null ? P.from : V.corridor.source, end = w.state === 'outbound' ? V.corridor.source : V.corridor.nest;
        assert.ok(s0.x === start.x && s0.y === start.y && !s0.interpolated, `${w.id}: at its departure instant drawn exactly at the start`); stats.exactStart++;
        assert.ok(s1.x === end.x && s1.y === end.y && !s1.interpolated, `${w.id}: at its arrival instant drawn exactly at the end`); stats.exactEnd++;
        assert.ok(w.route === null || P.from.x === start.x && P.from.y === start.y, 'path starts at the engine end point');
        for (const u of [0.13, 0.5, 0.87]) {
          const tt = w.since_s + (w.until_s! - w.since_s) * u, q = V.pose(w, tt);
          assert.ok(q.interpolated && q.where === 'route', 'between the records: display interpolation'); stats.interpolated++;
          assert.ok(Math.abs(q.dist_cm / P.line.len - u) < 1e-9, 'constant speed along the displayed path (distance ∝ elapsed time)'); stats.linear++;
        }
        if (w.route !== null) stats.maxLenErr = Math.max(stats.maxLenErr, Math.abs(P.line.len / f.layout.source_distance_cm - 1));
        assert.ok(p.where === 'route' && !p.schematic === (w.route !== null), 'travelling pose on its route (schematic only for a failed searcher returning)');
      } else if (w.state === 'feeding') { stats.feeding++; assert.ok(p.x === V.corridor.source.x && p.y === V.corridor.source.y && p.where === 'source' && !p.interpolated, 'feeding: pose = the source point (slot is a display arrangement)'); }
      else if (w.state === 'searching') { stats.search++; assert.ok(p.schematic && p.where === 'search', 'searching: schematic'); }
      else { stats.inNest++; assert.ok(p.vis === 'in_nest', 'in the nest: no surface position'); }
      undergroundSpot(w, f.t_sim, t * 0.01);
    }
    assert.equal(JSON.stringify(f), frozen, 'display computations never mutate the Worker frame');
  }
  world.advanceTo(T); plain.advanceTo(T);
  ok(frameOf(world).log.hash === frameOf(plain).log.hash && JSON.stringify(world.payload()) === JSON.stringify(plain.payload()), `seed ${seed}: drawing poses at ${Math.floor(T / 61)} instants does not change the event-log hash or the full payload at T`);
}
ok(stats.travelling > 300 && stats.exactStart === stats.travelling && stats.exactEnd === stats.travelling && stats.linear === 3 * stats.travelling, `every travelling worker drawn exactly at its recorded ends, at constant speed in between (${JSON.stringify(stats)})`);
ok(stats.maxLenErr < 0.02, `trip path length within 2 % of the engine route length (max ${(stats.maxLenErr * 100).toFixed(3)} %)`);
ok(stats.inNest > 1000, 'in-nest workers exercised');

// 3. gait phase monotonic with displayed distance
{
  let prev = -1;
  for (let d = 0; d <= 0.05; d += 0.001) { const g = gaitAdvance(d, 0.25); assert.ok(g.cycles >= prev - 1e-15 && g.cycles >= 0, 'monotonic in distance'); prev = g.cycles; }
  const g1 = gaitAdvance(0.01, 0.25), g2 = gaitAdvance(0.02, 0.25);
  ok(!g1.capped && !g2.capped && Math.abs(g2.cycles - 2 * g1.cycles) < 1e-12 && Math.abs(g1.cycles - 0.01 / (STRIDE_BODY_LENGTHS * 0.25)) < 1e-12, 'gait phase ∝ displayed distance (stride λ body lengths per cycle) below the cap');
  ok(gaitAdvance(-1, 0.25).cycles === 0 && gaitAdvance(10, 0.25).capped, 'never negative; capped at high playback speed');
  // along a real trip sampled at 60 fps display times
  const C = makeCorridor(7, 200), P = tripPath(C, 'w010', 1000, 1117.65, 'outbound');
  let phase = 0, last = 0, mono = true;
  for (let t = 1000; t <= 1117.65; t += 1 / 60) { const q = poseOnTrip(P, t), adv = gaitAdvance(q.dist_cm - last, 0.25 * 4); if (adv.cycles < 0) mono = false; phase += adv.cycles; last = q.dist_cm; }
  ok(mono && Math.abs(phase - P.line.len / (STRIDE_BODY_LENGTHS * 1)) < 1e-6, `along a trip at 1× the summed gait phase = path length / stride (${phase.toFixed(3)} cycles)`);
}

// 5. labels and decoration
const html = fs.readFileSync(path.join(REPO_ROOT, 'web/experiment.html'), 'utf8'), v62 = fs.readFileSync(path.join(REPO_ROOT, 'web/src/v62.ts'), 'utf8');
ok(PATH_LABEL === '路徑形狀＝顯示插值（示意），出發／抵達時刻＝引擎' && html.includes(PATH_LABEL) && /PATH_LABEL/.test(v62), 'path label on the page and drawn on the canvas');
ok(/<div id="legend"/.test(html) && /<button id="legendBtn"/.test(html) && /裝飾/.test(html) && /示意/.test(html) && /顯示插值/.test(html) && /不是障礙物/.test(html) && /螞蟻不感知/.test(html), 'legend separates engine / display interpolation / 示意 / 裝飾');
ok(Object.values(VIS_LEGEND).every((s) => s.length > 10) && VIS_LEGEND.decor.startsWith('裝飾'), 'legend strings defined');
ok(UNDERGROUND_LABEL === '概念圖：巢室幾何尚未模擬' && /<div id="ugLabel"/.test(html) && /UNDERGROUND_LABEL/.test(v62) && /<button id="viewBtn"/.test(html), 'underground concept label and the surface / underground toggle');
ok(/放大顯示 ×\$\{mag\.toFixed\(1\)\}/.test(v62) && /實際比例/.test(v62), 'magnification label remains (×N when enlarged; 實際比例 at true scale)');
{
  const C = makeCorridor(7, 200), G = new Garden(12345, C), items = G.itemsIn(-60, -60, 260, 200, 8, 0);
  ok(items.length > 500 && items.every((it) => it.decoration === true), `${items.length} garden items, every one flagged decoration`);
  const clear = (k: string) => DECOR_CLASSES.find((d) => d.kind === k)!;
  const bad = items.filter((it) => (it.kind === 'stone' || it.kind === 'grass' || it.kind === 'clover') && G.distCorridor(it.x, it.y) < it.r + clear(it.kind).clearCorridor - 1e-9);
  ok(bad.length === 0, 'stones and plants keep off the display corridor (drawing choice; no obstacle model)');
  ok(items.filter((it) => it.kind === 'stone').every((it) => Math.hypot(it.x, it.y) >= it.r + clear('stone').clearNest), 'stones keep off the nest clearing');
  ok(JSON.stringify(new Garden(12345, C).itemsIn(0, 0, 50, 50, 8, 0)) === JSON.stringify(G.itemsIn(0, 0, 50, 50, 8, 0)), 'garden layout deterministic');
}

// 6. underground concept view: engine facts only
{
  const { world } = P0a2ExperimentWorld.create('exp-vis1-ug', 11);
  let transit = 0, outside = 0, inNest = 0;
  for (let t = 0; t <= 43_200; t += 37) {
    world.advanceTo(t); const f = frameOf(world);
    for (const w of f.workers) {
      const s = undergroundSpot(w, f.t_sim, 0);
      if (w.loc === 'outside') { assert.equal(s, null, 'outside workers are not in the concept view'); outside++; continue; }
      assert.ok(s !== null, 'in-nest / transit workers are drawn'); inNest++;
      if (w.state === 'to_entrance' || w.state === 'from_entrance') {
        const a = undergroundSpot(w, w.since_s, 0)!, b = undergroundSpot(w, w.until_s!, 0)!;
        assert.ok(!a.walking && !b.walking && !a.interpolated && !b.interpolated, 'passage ends at the recorded instants are not interpolated');
        assert.ok(w.state === 'to_entrance' ? b.y < a.y : b.y > a.y, 'to_entrance moves up toward the entrance; from_entrance moves down');
        transit++;
      }
    }
  }
  ok(transit > 50 && outside > 50 && inNest > 1000, `underground concept view: ${inNest} in-nest samples drawn, ${outside} outside samples not drawn, ${transit} passage moves end-exact`);
}
console.log(JSON.stringify({ test: 'web-vis1-demo', checks, stats }));
