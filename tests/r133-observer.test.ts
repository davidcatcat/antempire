/**
 * O-R133 v1 observation operator (docs/kin2d-r133-observation-operator.md §5): validation on synthetic trajectories with
 * known ground truth. Blocking. The operator must not import engine/ or cli/.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { observe, detectTurns, localFrame, V1, type CentroidSample, type XY } from '../prototypes/natural-walk/observe-r133.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
/** path y = f(x) along the straight 150 mm trail, sampled every ds mm, constant speed v */
const path1 = (f: (s: number) => number, opts: { ds?: number; v?: number; s1?: number; time?: (s: number) => number } = {}): CentroidSample[] => {
  const ds = opts.ds ?? 0.05, v = opts.v ?? 18.5, s1 = opts.s1 ?? 150, out: CentroidSample[] = [];
  for (let i = 0; i * ds <= s1 + 1e-9; i++) { const s = i * ds; out.push({ t: opts.time ? opts.time(s) : s / v, x_mm: s, y_mm: f(s) }); }
  return out;
};
const tri = (A: number, P: number) => (s: number) => { const u = ((s / P) % 1 + 1) % 1; return A * (u < 0.25 ? 4 * u : u < 0.75 ? 2 - 4 * u : 4 * u - 4); };
const T = (o: ReturnType<typeof observe>, h: number, r: 'C05' | 'G5s' | 'G5q' = 'C05', sm: 'S0' | 'S1' = 'S0') => o.turns[r][sm][String(h)];

// 0. the operator imports nothing (in particular not engine/ or cli/)
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'prototypes/natural-walk/observe-r133.ts'), 'utf8');
  ok(!/^\s*import\s/m.test(src) && !/require\(/.test(src), 'observe-r133.ts has no imports');
  ok(JSON.stringify(V1.thresholds_mm) === '[0.25,0.5,1,2.5,5]' && V1.primary_h_mm === 1 && V1.ds_mm === 0.5 && V1.dead_band_mm === 0.15 && V1.merge_ds_mm === 1, 'v1 settings equal the pre-registered spec');
}
// 1. straight on the centreline
{
  const o = observe(path1(() => 0));
  ok(o.finished && Math.abs((o.speed_mm_s as number) - 18.5) < 1e-9, 'straight: finished, speed = input');
  for (const h of V1.thresholds_mm) ok(T(o, h).total === 0 && T(o, h).crossings === 0, `straight: 0 turns at h=${h}`);
  ok(o.fidelity_pct === 100 && o.mean_abs_d_mm < 1e-12 && o.peak_amp_mm === null, 'straight: fidelity 100 %, no deviation');
}
// 2. parallel offset line
{
  const o = observe(path1(() => 2));
  ok(T(o, 1).total === 0 && T(o, 1).crossings === 0 && o.fidelity_pct === 0 && Math.abs(o.mean_abs_d_mm - 2) < 1e-12, 'offset 2 mm: 0 turns, fidelity 0 %, mean |d| = 2');
}
// 3. triangle zigzag A = 2 mm, period 20 mm: extrema at s = 5, 15, …, 145 (15), zero crossings at 10, 20, …, 140 (14)
{
  const o = observe(path1(tri(2, 20)));
  for (const h of [0.25, 0.5, 1]) ok(T(o, h).total === 15 && T(o, h).toward === 15 && T(o, h).away === 0, `zigzag ±2: 15 toward-centre turns at h=${h} (got ${T(o, h).total})`);
  ok(T(o, 1).crossings === 14, `zigzag ±2: 14 crossings (got ${T(o, 1).crossings})`);
  // h = 2.5 > A: the first peak (move from start 2 < h) and the last (retreat 2 < h) are not confirmed
  ok(T(o, 2.5).total === 13, `zigzag ±2, h=2.5: 13 (got ${T(o, 2.5).total})`);
  ok(T(o, 5).total === 0, 'zigzag ±2 (peak-to-peak 4 mm), h=5: 0');
  ok(Math.abs((o.peak_amp_mm as number) - 2) < 1e-9, 'zigzag ±2: peak amplitude 2 mm');
  ok(Math.abs(o.mean_abs_d_mm - 1) < 0.01, 'zigzag ±2: mean |d| = A/2');
  { let lo = 0, hi = 0; for (let j = 0; j <= 300; j++) { const a = Math.abs(tri(2, 20)(0.5 * j)); if (a < 1 - 1e-9) lo++; if (a <= 1 + 1e-9) hi++; } ok(o.fidelity_pct >= (100 * lo) / 301 - 1e-9 && o.fidelity_pct <= (100 * hi) / 301 + 1e-9, `zigzag ±2: fidelity = share of 0.5 mm grid points with |d| ≤ 1, boundary points may round either way (got ${o.fidelity_pct})`); }
  // 4. amplitude below h/2: no turn
  const small = observe(path1(tri(0.2, 20)));
  ok(T(small, 1).total === 0 && T(small, 0.25).total === 13, 'zigzag ±0.2: 0 turns at h=1, 13 at h=0.25 (first and last peak are within h of the start and end)');
  const sine = observe(path1((s) => 0.45 * Math.sin((2 * Math.PI * s) / 7)));
  ok(T(sine, 1).total === 0, 'sine amplitude 0.45 < h/2: 0 turns at h=1');
}
// 5. approach without crossing then veer away: classification
{
  const knots: [number, number][] = [[0, 3], [10, 0.5], [20, 3], [30, -3], [40, -0.5], [50, -3], [60, 0], [150, 0]];
  const f = (s: number) => { for (let i = 0; i + 1 < knots.length; i++) { const [a, ya] = knots[i], [b, yb] = knots[i + 1]; if (s <= b) return ya + ((s - a) / (b - a)) * (yb - ya); } return 0; };
  const t = T(observe(path1(f)), 1);
  ok(t.events.map((e) => e.cls).join(',') === 'away,toward,toward,away,toward', `approach-and-veer classes (got ${t.events.map((e) => e.cls).join(',')})`);
  ok(t.crossings === 1, 'one centreline crossing (3 → −3)');
  // start dip smaller than h is not an event
  const g = (s: number) => (s < 2 ? -0.3 * (s / 2) : s < 12 ? -0.3 + (3.3 * (s - 2)) / 10 : 3 - (3 * (s - 12)) / 10 > 0 ? 3 - (3 * (s - 12)) / 10 : 0);
  ok(T(observe(path1(g)), 1).events.map((e) => e.cls).join(',') === 'toward', 'a start dip < h is not counted; the 3 mm peak is');
  // on-line extremum (|d| ≤ dead band)
  const on = detectTurns([0, 1, 2, 3, 4, 5, 6], [2, 1, 0.1, 1.2, 2.2, 1, 0], 1);
  ok(on.events.map((e) => e.cls).join(',') === 'on_line,toward', `on-line extremum classified on_line (got ${on.events.map((e) => e.cls).join(',')})`);
}
// 6. small noise (< h/2) does not change the count; merge rule removes sub-1 mm reversal pairs
{
  const o = observe(path1((s) => tri(2, 20)(s) + 0.2 * Math.sin((2 * Math.PI * s) / 1.3)));
  ok(T(o, 1).total === 15, `zigzag + 0.2 mm noise: still 15 at h=1 (got ${T(o, 1).total})`);
  const m = detectTurns([0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5], [0, 2, 0.5, 2.1, 1, 0, -1, -2, -3], 0.25);
  // extrema: max@0.5, min@1, max@1.5 → pair (min@1, max@1.5) is closer than 1 mm after max@0.5 … greedy: max@0.5 kept, min@1 (0.5 mm) removes max@0.5
  ok(m.total === 1, `merge rule: reversal pairs closer than 1 mm cancel (got ${m.total})`);
}
// 7. time reparametrisation: same path, different speed profile → same events, different speed
{
  const a = observe(path1(tri(2, 20))), b = observe(path1(tri(2, 20), { time: (s) => s / 10 + 0.01 * Math.sin(s) }));
  ok(JSON.stringify(a.turns) === JSON.stringify(b.turns) && Math.abs((b.speed_mm_s as number) - 10) < 0.01, 'time reparametrisation: identical turns; speed follows the timing');
}
// 8. backtracking is counted
{
  const s: CentroidSample[] = [];
  let t = 0;
  for (let i = 0; i <= 500; i++) s.push({ t: (t += 0.01), x_mm: i / 10, y_mm: 0 });
  for (let i = 500; i >= 450; i--) s.push({ t: (t += 0.01), x_mm: i / 10, y_mm: 0 });
  for (let i = 450; i <= 1500; i++) s.push({ t: (t += 0.01), x_mm: i / 10, y_mm: 0 });
  const o = observe(s);
  ok(o.backtracks === 1 && o.finished, 'one backtrack counted');
}
// 9. 5 mm grid observation
{
  const small = observe(path1(tri(1, 20)));
  ok(T(small, 1, 'C05').total === 15 && T(small, 1, 'G5q').total === 0, 'zigzag ±1: 15 at C05, 0 after 5 mm quantisation (G5q)');
  const big = observe(path1(tri(7.5, 40)));
  ok(T(big, 1, 'G5s').total === 7 && T(big, 1, 'G5q').total === 7 && T(big, 1, 'C05').total === 7, `zigzag ±7.5 period 40: 7 turns at C05/G5s/G5q (got ${T(big, 1, 'C05').total}/${T(big, 1, 'G5s').total}/${T(big, 1, 'G5q').total})`);
}
// 10. rotation / translation invariance with a general centreline; polyline local frame
{
  const th = 0.7, c = Math.cos(th), sn = Math.sin(th), o0 = { x: 12.3, y: -4.1 };
  const R = (p: XY): XY => ({ x: o0.x + c * p.x - sn * p.y, y: o0.y + sn * p.x + c * p.y });
  const base = path1((s) => tri(2, 20)(s + 1.7) * 1.1);
  const rot = base.map((q) => { const p = R({ x: q.x_mm, y: q.y_mm }); return { t: q.t, x_mm: p.x, y_mm: p.y }; });
  const a = observe(base), b = observe(rot, [R({ x: 0, y: 0 }), R({ x: 150, y: 0 })]);
  for (const h of V1.thresholds_mm) ok(T(a, h).total === T(b, h).total && T(a, h).crossings === T(b, h).crossings, `rotation invariance at h=${h}`);
  const lf = localFrame([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], { x: 9, y: 5 });
  ok(Math.abs(lf.s - 15) < 1e-12 && Math.abs(lf.d - 1) < 1e-12, 'polyline local frame: s along the bend, left positive');
}
// 11. undersampled input is flagged
ok(observe(path1(() => 0, { ds: 1 })).undersampled === true && observe(path1(() => 0)).undersampled === false, 'undersampled input flagged');
console.log(JSON.stringify({ r133_observer: 'pass', checks }));
