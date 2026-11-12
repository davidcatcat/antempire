/**
 * Issue #159 option B: pre-rotated ant sprite atlas (BLOCKING). Pure checks of the plan used by
 * web/src/render-canvas.ts (antSprites: 'prerotated'):
 *  1. heading bucket: drawn heading within π/n of the planned heading, for every heading; deterministic
 *  2. atlas plan: deterministic, every (gait, frame, pose, bucket) exactly once, no overlap, inside its sheet, sheets
 *     within the size limits; the rotated box contains the whole rotated sprite extent
 *  3. positions exact: the blit rectangle puts the anchor on the planned screen position (1e-9 px), on a real replay
 *  4. memory budget: chosen n fits, a larger n does not; the pose axis (future head / antenna states) scales linearly
 *  5. drawing only: the option is off in the game view; the plan (positions, headings) is made before and independent
 *     of the sprite option; the comparison results are committed and passed their browser checks
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { ROT_BUCKET_CHOICES, ROT_ATLAS_BUDGET, ROT_SHEET_PX, PREROTATED_GAITS, bucketAngle, bucketError, chooseBuckets, headingBucket, planAnts, planRotatedAtlas, rotCellIndex, rotDrawRect, rotatedAtlasBytes, rotatedBox, worldToScreen, type AntInput, type Camera } from '../web/src/render-scene.ts';
import { ANT_EXTENT, framesOf, walkCycles } from '../web/src/art-ant.ts';
import { displayPositions, type Experiment } from '../web/src/model.ts';
import { antFrame, buildDayIndex, mulberry32, rosterAtStart } from '../web/src/game-model.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

// 1. buckets
const rnd = mulberry32(159);
for (const n of ROT_BUCKET_CHOICES) {
  const hs = [0, Math.PI, -Math.PI, 2 * Math.PI, Math.PI / n, -Math.PI / n, Math.PI / n - 1e-12, 1e3, -1e3, ...Array.from({ length: 400 }, () => (rnd() - 0.5) * 40)];
  let worst = 0;
  for (const h of hs) {
    const k = headingBucket(h, n), e = bucketError(h, n); worst = Math.max(worst, e);
    ok(Number.isInteger(k) && k >= 0 && k < n, `bucket in range (n ${n}, h ${h})`);
    ok(e <= Math.PI / n + 1e-12, `n ${n}: drawn heading within π/n of the planned heading (h ${h}, err ${e})`);
    ok(headingBucket(h, n) === k && (e > Math.PI / n - 1e-9 || headingBucket(h + 2 * Math.PI, n) === k), 'bucket is deterministic and 2π-periodic (away from the exact edge)');
  }
  ok(worst > Math.PI / n * 0.9, `n ${n}: the tolerance π/n is reached (test covers the bucket edges)`);
  for (let k = 0; k < n; k++) ok(headingBucket(bucketAngle(k, n), n) === k, 'a bucket angle maps to its own bucket');
}

// 2. plan
for (const [L, dpr, n, poses] of [[26, 1, 32, 1], [26, 2, 16, 1], [48, 2.625, 8, 1], [64, 1, 12, 2], [36, 1, 64, 1]] as const) {
  const p = planRotatedAtlas(L, dpr, n, PREROTATED_GAITS, poses), p2 = planRotatedAtlas(L, dpr, n, PREROTATED_GAITS, poses);
  ok(JSON.stringify(p) === JSON.stringify(p2), 'plan is deterministic');
  const expect = PREROTATED_GAITS.reduce((a, g) => a + framesOf(g), 0) * poses * n;
  ok(p.cells.length === expect, `every (gait, frame, pose, bucket) once: ${p.cells.length} = ${expect}`);
  ok(new Set(p.cells.map((c) => `${c.gait}|${c.frame}|${c.pose}|${c.bucket}`)).size === expect, 'no duplicate cell');
  for (const g of PREROTATED_GAITS) for (let f = 0; f < framesOf(g); f++) for (let ps = 0; ps < poses; ps++) for (let k = 0; k < n; k++) { const c = p.cells[rotCellIndex(p, g, f, k, ps)]; ok(c && c.gait === g && c.frame === f && c.pose === ps && c.bucket === k, 'rotCellIndex finds the cell'); }
  ok(p.sheets.every((s) => s.w <= ROT_SHEET_PX && s.h <= ROT_SHEET_PX), 'sheets within the sheet limit');
  const bySheet = new Map<number, typeof p.cells>(); for (const c of p.cells) { const a = bySheet.get(c.sheet) ?? []; a.push(c); bySheet.set(c.sheet, a); }
  for (const [si, cs] of bySheet) {
    for (const c of cs) ok(c.x >= 0 && c.y >= 0 && c.x + c.w <= p.sheets[si].w && c.y + c.h <= p.sheets[si].h, 'cell inside its sheet');
    // overlap: cells are packed on shelves, check pairwise on a sample of neighbours (sorted)
    const s = [...cs].sort((a, b) => a.y - b.y || a.x - b.x);
    for (let i = 0; i < s.length; i++) for (let j = i + 1; j < Math.min(s.length, i + 80); j++) { const a = s[i], b = s[j]; ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, 'cells do not overlap'); }
  }
  ok(p.bytesPerSet === p.sheets.reduce((a, s) => a + s.w * s.h * 4, 0) && rotatedAtlasBytes(p, 5) === 6 * p.bytesPerSet, 'bytes = RGBA sheet area; 5 colour variants + 1 shared shadow set');
  // rotated box contains the rotated extent; anchor = image of the local origin
  for (let k = 0; k < n; k++) {
    const b = rotatedBox(p.scale, bucketAngle(k, n)), th = bucketAngle(k, n), co = Math.cos(th), si = Math.sin(th);
    for (const [x, y] of [[ANT_EXTENT.x0, ANT_EXTENT.y0], [ANT_EXTENT.x1, ANT_EXTENT.y0], [ANT_EXTENT.x0, ANT_EXTENT.y1], [ANT_EXTENT.x1, ANT_EXTENT.y1], [0, 0]]) {
      const X = b.ax + (x * co - y * si) * p.scale, Y = b.ay + (x * si + y * co) * p.scale;
      ok(X >= 0 && Y >= 0 && X <= b.w && Y <= b.h, 'rotated sprite extent stays inside its cell');
    }
  }
}

// 3. positions exact on a real replay (planAnts → bucket → blit rectangle)
const index = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web', 'data', 'index.json'), 'utf8')) as { experiments: { file: string }[] };
let anchors = 0;
for (const meta of index.experiments) {
  const exp = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'web', 'data', meta.file), 'utf8')) as Experiment, pos = displayPositions(exp.map.places);
  for (const day of [1, 2, exp.days.length]) {
    const d = exp.days[day - 1], idx = buildDayIndex(d), roster = rosterAtStart(exp, day);
    for (const [cam, dpr] of [[{ cx: 3, cy: -2, s: 7.3, w: 1280, h: 800 }, 1], [{ cx: 0, cy: 0, s: 13.1, w: 412, h: 839 }, 2.625]] as [Camera, number][]) {
      const n = chooseBuckets(64, dpr, 5, Number.MAX_SAFE_INTEGER) as number, plan = planRotatedAtlas(64, dpr, n);
      let look = new Map();
      for (let t = 0; t < 360; t += 1.7) {
        const ants: AntInput[] = roster.map((id) => { const f = antFrame(idx, d, id, t, pos); return { id, x: f.x, y: f.y, vis: f.vis, moving: f.moving, heading: f.heading, displayOffset: { dx: 0.37, dy: -1.1, heading: 0.4 } }; });
        const r = planAnts(cam, ants, look, 0.05, walkCycles, 48, true); look = r.look;
        for (const dr of r.draws) {
          const a = ants.find((x) => x.id === dr.id) as AntInput, [ex, ey] = worldToScreen(cam, a.x, a.y);
          ok(ex === dr.ex && ey === dr.ey, 'planned engine anchor = affine image of the replay position');
          const k = headingBucket(dr.heading, n), c = plan.cells[rotCellIndex(plan, 'walk', 0, k)], rr = rotDrawRect(c, dpr, dr.sx, dr.sy);
          ok(Math.abs(rr.dx + c.ax / dpr - dr.sx) < 1e-9 && Math.abs(rr.dy + c.ay / dpr - dr.sy) < 1e-9, 'blit anchor = planned screen position (no snapping)');
          ok(bucketError(dr.heading, n) <= Math.PI / n + 1e-12, 'drawn pose heading within the bucket tolerance');
          anchors++;
        }
      }
    }
  }
}
ok(anchors > 200, `anchors checked on real replays: ${anchors}`);

// 4. budget
for (const [L, dpr] of [[26, 1], [26, 2], [36, 1], [48, 1], [64, 2], [67, 2.625]] as const) {
  const n = chooseBuckets(L, dpr, 5);
  if (n === null) ok(rotatedAtlasBytes(planRotatedAtlas(L, dpr, 8), 5) > ROT_ATLAS_BUDGET, `L ${L} dpr ${dpr}: null only when even n = 8 is over budget`);
  else {
    ok(rotatedAtlasBytes(planRotatedAtlas(L, dpr, n), 5) <= ROT_ATLAS_BUDGET, `L ${L} dpr ${dpr}: n ${n} fits the budget`);
    const bigger = ROT_BUCKET_CHOICES.filter((m) => m > n); if (bigger.length) ok(rotatedAtlasBytes(planRotatedAtlas(L, dpr, bigger[bigger.length - 1]), 5) > ROT_ATLAS_BUDGET, `L ${L} dpr ${dpr}: the next larger n does not fit`);
  }
}
{ const one = planRotatedAtlas(26, 1, 16, PREROTATED_GAITS, 1).bytesPerSet, four = planRotatedAtlas(26, 1, 16, PREROTATED_GAITS, 4).bytesPerSet; ok(four > 3.5 * one && four < 4.5 * one, `pose axis scales the bytes ~linearly (${one} → ${four})`); }
ok((chooseBuckets(26, 1, 5, ROT_ATLAS_BUDGET, PREROTATED_GAITS, 4) ?? 0) < (chooseBuckets(26, 1, 5) ?? 0), 'more poses per frame → fewer buckets under the same budget');

// 5. drawing only
const SRC = path.join(REPO_ROOT, 'web', 'src'), canvasCode = fs.readFileSync(path.join(SRC, 'render-canvas.ts'), 'utf8'), game = fs.readFileSync(path.join(SRC, 'game.ts'), 'utf8');
ok(!/prerotated|antSprites/.test(game) && /new LayeredRenderer\(canvas\)/.test(game), 'the game view keeps the default live rotation (option B is off)');
const planLine = canvasCode.split('\n').find((l) => /planAnts\(/.test(l)) ?? '';
ok(planLine && !/this\.opts|antSprites|rotFor/.test(planLine), 'the ant plan (positions, headings) does not depend on the sprite option');
ok(/antSprites === 'prerotated'/.test(canvasCode) && !/Math\.random|Date\.now/.test(canvasCode), 'option is explicit; no unseeded randomness or clock');
const res = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes', 'render-compare', 'results.json'), 'utf8'));
ok(Array.isArray(res.failures) && res.failures.length === 0, 'committed comparison run passed its browser checks');
for (const p of ['desktop', 'pixel7', 'pixel7-cpu4x']) for (const m of ['replay', 'stress100', 'stress1000', 'stress5000']) for (const r of ['A', 'B', 'C']) ok(res.rows.some((x: { profile: string; mode: string; renderer: string; fps_mean: number }) => x.profile === p && x.mode === m && x.renderer === r && x.fps_mean > 0), `measured ${p}/${m}/${r}`);
ok(res.probes.length >= 6 && res.longRuns.length >= 6 && res.longRuns.every((x: { secs: number }) => x.secs >= 60), 'pixel probes and ≥ 60 s long runs are committed');

console.log(JSON.stringify({ test: 'render-atlas', passed: true, checks, anchors }));
