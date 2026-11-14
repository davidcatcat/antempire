/**
 * VIS-1 (P0-A2 experiment view) — continuity of the DRAWN point across engine state boundaries (issue #252).
 * Non-official experiment world (Owner #201). Pure Node checks with real P0-A2 Worker state; nothing here changes the
 * world (CLAUDE.md §8: display interpolation never writes back and never moves an engine instant).
 *
 * The drawn point is what the renderer puts on screen: the display pose (x, y) PLUS the display arrangement offset
 * (`slot`, the feeding spot around the host stem) — vis1-render.ts draws worldToScreen(x + slot.dx, y + slot.dy).
 * Checks:
 *  1. regression #252 (seed 7, worker w026, 33341.101 → 33341.102 s, feeding → returning): before the fix the drawn
 *     point jumped 3.153 cm in 1 ms (the slot was dropped when the return trip started at the source centre); now the
 *     1 ms step stays within the display speed bound, and the engine instants are unchanged (the return trip still
 *     departs at 33341.102 s and arrives at the nest at its recorded arrival instant, drawn exactly at the nest).
 *  2. audit over three seeds × 24 h: at EVERY surface state boundary found (outbound→feeding, feeding→returning,
 *     outbound→returning, failed search→returning, …) the drawn displacement over the 1 ms around the boundary is
 *     bounded by MAX_DRAWN_SPEED, except the listed discontinuities (VIS_DISCONTINUITIES), each of which must carry a
 *     label and be of a listed kind; appearing / vanishing on the surface happens exactly at the nest entrance; inside
 *     every surface state the drawn point moves at most MAX_DRAWN_SPEED (1 ms samples).
 *  3. the underground concept view: the passage ends meet the entrance and the junction at the recorded instants; the
 *     room ↔ passage / room ↔ room re-placements are listed (概念圖) and counted, never silently tolerated.
 *  4. observing (all of the above) does not change the event-log hash or the payload.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { VisModel, drawnPoint, MAX_DRAWN_SPEED_FACTOR, SEARCH_EMERGE_S, VIS_DISCONTINUITIES, VIS_LEGEND, classifyBoundary, type VisPose } from '../web/src/vis1-model.ts';
import { undergroundSpot, PASSAGE } from '../web/src/vis1-nest.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
type PW = P0a2FrameMsg['workers'][number];
const frameOf = (w: P0a2ExperimentWorld) => w.frame() as unknown as P0a2FrameMsg;
const MS = 0.001;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
const drawn = (V: VisModel, w: PW, t: number): { x: number; y: number } | null => { const p: VisPose = V.pose(w, t); return p.vis === 'in_nest' ? null : drawnPoint(p); };

// 1. regression #252
{
  const { world } = P0a2ExperimentWorld.create('exp-review', 7), { world: plain } = P0a2ExperimentWorld.create('exp-review', 7);
  world.advanceTo(33341.101); const f0 = frameOf(world), V = VisModel.of(f0), a = f0.workers.find((w) => w.id === 'w026')!;
  world.advanceTo(33341.102); const f1 = frameOf(world), b = f1.workers.find((w) => w.id === 'w026')!;
  ok(a.state === 'feeding' && a.since_s === 33329.852 && b.state === 'returning' && b.since_s === 33341.102 && b.until_s !== null, `#252 scene reproduced from engine state (w026 ${a.state}@${a.since_s} → ${b.state}@${b.since_s})`);
  const pa = drawn(V, a, f0.t_sim)!, pb = drawn(V, b, f1.t_sim)!, jump = dist(pa, pb);
  ok(jump <= MAX_DRAWN_SPEED_FACTOR * V.speedCmS * MS + 1e-12, `#252: drawn point moves ${jump.toFixed(6)} cm in 1 ms at feeding → returning (bound ${(MAX_DRAWN_SPEED_FACTOR * V.speedCmS * MS).toFixed(6)} cm; was 3.153 cm)`);
  const s0 = drawn(V, a, a.since_s + 60)!;
  ok(dist(pa, s0) < 1e-12, '#252: the feeding spot is reached and kept while feeding (drawn point does not move at the end of feeding)');
  const ang = (x: number, y: number) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)));
  const ha = V.pose(a, f0.t_sim).heading!, hb = V.pose(b, f1.t_sim).heading!, hc = V.pose(b, f1.t_sim + MS).heading!;
  ok(ang(ha, hb) < 1e-12 && ang(hb, hc) < 0.01, `#252: the drawn heading also turns smoothly (Δ ${ang(ha, hb).toExponential(2)} rad at the boundary, ${ang(hb, hc).toExponential(2)} rad in the next 1 ms)`);
  const course = V.drawnCourse(b).pts, c0 = drawnPoint(V.pose(b, b.since_s));
  ok(course[0].x === c0.x && course[0].y === c0.y && course[course.length - 1].x === V.corridor.nest.x && course[course.length - 1].y === V.corridor.nest.y, '#252: the dashed course of the selected ant starts at its drawn feeding spot and ends exactly at the nest');
  const end = V.pose(b, b.until_s!);
  ok(drawnPoint(end).x === V.corridor.nest.x && drawnPoint(end).y === V.corridor.nest.y && end.x === V.corridor.nest.x && !end.interpolated, '#252: the return trip still ends exactly at the nest at the engine arrival instant (no slot left)');
  ok(V.pose(b, b.since_s).x === V.corridor.source.x && V.pose(b, b.since_s).y === V.corridor.source.y, '#252: the engine pose at the departure instant is still exactly the source (slot = display arrangement only)');
  world.advanceTo(40_000); plain.advanceTo(40_000);
  ok(frameOf(world).log.hash === frameOf(plain).log.hash && JSON.stringify(world.payload()) === JSON.stringify(plain.payload()), '#252: observing does not change the event log or the payload');
}

// 2 + 3. audit of every boundary found over 24 h
const T = 86_400, STEP = 5;
const tally: Record<string, { n: number; max_cm: number }> = {}, listed: Record<string, number> = {};
const bump = (k: string, d: number) => { const x = (tally[k] ??= { n: 0, max_cm: 0 }); x.n++; x.max_cm = Math.max(x.max_cm, d); };
let inState = 0, appear = 0, vanish = 0, ugPassage = 0;
for (const seed of [7, 31, 101]) {
  const { world: A } = P0a2ExperimentWorld.create(`exp-cont-${seed}`, seed), { world: B } = P0a2ExperimentWorld.create(`exp-cont-${seed}`, seed), { world: plain } = P0a2ExperimentWorld.create(`exp-cont-${seed}`, seed);
  const V = VisModel.of(frameOf(A)), bound = MAX_DRAWN_SPEED_FACTOR * V.speedCmS * MS + 1e-12;
  let prev = new Map(frameOf(A).workers.map((w) => [w.id, w]));
  let bT = 0;
  for (let t = STEP; t <= T; t += STEP) {
    A.advanceTo(t); const f = frameOf(A);
    // boundaries in (t − STEP, t]: replay them in time order on world B to get the IMMEDIATE predecessor state
    const bounds = f.workers.filter((w) => prev.get(w.id)!.since_s !== w.since_s).map((w) => ({ id: w.id, T: w.since_s })).sort((x, y) => x.T - y.T || (x.id < y.id ? -1 : 1));
    for (const { id, T: tb } of bounds) {
      if (tb - MS < bT) continue; // B is already past (two boundaries of one ant in 1 ms: not possible with ms event times)
      B.advanceTo(tb - MS); const w0 = frameOf(B).workers.find((w) => w.id === id)!;
      B.advanceTo(tb); bT = tb; const w1 = frameOf(B).workers.find((w) => w.id === id)!;
      if (w1.since_s !== tb || w0.since_s === tb) continue;
      const before = drawn(V, w0, tb - MS), at = drawn(V, w1, tb), after = drawn(V, w1, tb + MS);
      const kind = `${w0.state}${w0.route === null ? '(no-route)' : ''}→${w1.state}${w1.route === null ? '(no-route)' : ''}`;
      if (before === null && at === null) {
        // underground concept view only
        const u0 = undergroundSpot(w0, tb - MS, 0), u1 = undergroundSpot(w1, tb, 0);
        if (u0 && u1) {
          const d = dist(u0, u1), c = classifyBoundary(w0, w1, d, 'underground');
          if (c) { listed[c] = (listed[c] ?? 0) + 1; bump(`ug ${kind}`, d); } else assert.ok(d < 0.05, `underground ${kind}: ${d} concept units`);
        }
        continue;
      }
      if (before !== null && at === null) { assert.ok(dist(before, V.corridor.nest) <= bound, `${id} ${kind} @${tb}: vanishes from the surface only at the nest entrance (${dist(before, V.corridor.nest)} cm)`); vanish++; bump(kind, 0); continue; }
      if (before === null && at !== null) { assert.ok(at.x === V.corridor.nest.x && at.y === V.corridor.nest.y, `${id} ${kind} @${tb}: appears on the surface exactly at the nest entrance`); appear++; bump(kind, 0); continue; }
      const d = Math.max(dist(before!, at!), dist(at!, after!));
      const c = classifyBoundary(w0, w1, d, 'surface');
      if (d > bound) {
        assert.ok(c !== null, `${id} ${kind} @${tb}: drawn point jumps ${d.toFixed(4)} cm in 1 ms and is not a listed discontinuity`);
        listed[c!] = (listed[c!] ?? 0) + 1;
      }
      bump(kind, d);
    }
    // inside the states: 1 ms steps of the drawn point at this frame's time
    for (const w of f.workers) {
      const p = drawn(V, w, f.t_sim), q = drawn(V, w, f.t_sim + MS);
      if (p && q && f.t_sim + MS !== w.until_s) { assert.ok(dist(p, q) <= bound, `${w.id} ${w.state} @${f.t_sim}: in-state 1 ms step ${dist(p, q)} cm`); inState++; }
      if (w.state === 'to_entrance' || w.state === 'from_entrance') {
        const a = undergroundSpot(w, w.since_s, 0)!, b = undergroundSpot(w, w.until_s!, 0)!, top = PASSAGE[0], junction = PASSAGE[PASSAGE.length - 1];
        const [first, last] = w.state === 'to_entrance' ? [junction, top] : [top, junction];
        assert.ok(Math.abs(a.y - first[1]) < 1e-9 && Math.abs(b.y - last[1]) < 1e-9, `${w.id} ${w.state}: passage ends at the recorded instants`); ugPassage++;
      }
    }
    prev = new Map(f.workers.map((w) => [w.id, w]));
  }
  A.advanceTo(T); plain.advanceTo(T);
  ok(frameOf(A).log.hash === frameOf(plain).log.hash && JSON.stringify(A.payload()) === JSON.stringify(plain.payload()), `seed ${seed}: the audit does not change the event log or the payload`);
}
const surf = (k: string) => Object.entries(tally).filter(([x]) => !x.startsWith('ug ') && x.startsWith(k)).reduce((s, [, v]) => s + v.n, 0);
ok(surf('outbound→feeding') > 100 && surf('feeding→returning') > 100 && surf('outbound→returning') > 1000, `surface boundaries exercised: ${JSON.stringify(tally)}`);
ok(surf('searching(no-route)→returning(no-route)') > 20, 'failed search → returning exercised');
for (const k of ['outbound→feeding', 'feeding→returning', 'outbound→returning']) ok(tally[k].max_cm <= MAX_DRAWN_SPEED_FACTOR * 1.7 * MS + 1e-9, `${k}: max drawn 1 ms step ${tally[k].max_cm.toExponential(3)} cm (continuous; no listed exception used)`);
ok(appear > 1000 && vanish > 1000, `surface appear (${appear}) / vanish (${vanish}) exactly at the nest entrance`);
ok(inState > 100_000 && ugPassage > 1000, `in-state 1 ms steps bounded (${inState} samples); underground passage ends exact (${ugPassage})`);
ok(Object.keys(listed).every((k) => VIS_DISCONTINUITIES.some((d) => d.key === k)) && VIS_DISCONTINUITIES.every((d) => d.label_zh.length > 10 && (d.basis === 'engine' || d.basis === 'display_limit' || d.basis === 'concept_view')), `listed discontinuities used: ${JSON.stringify(listed)}`);
const html = fs.readFileSync(path.join(REPO_ROOT, 'web/experiment.html'), 'utf8');
ok(/畫面跳位（已列出/.test(html) && /搜尋成功時從搜尋區直接到食源旁/.test(html) && html.includes(`短於 ${SEARCH_EMERGE_S} 秒的失敗搜尋`) && /地下概念圖換狀態＝換巢室/.test(html) && VIS_LEGEND.jumps.startsWith('畫面跳位'), 'every listed discontinuity is labelled in the page legend');
console.log(JSON.stringify({ test: 'web-vis1-continuity', checks, listed, tally }));
