/**
 * CHEM-1b tests (Owner decisions 30 and 43). Groups, reported separately:
 *  (A) exact circle-rectangle area vs fine quadrature and Monte Carlo, closed-form special cases;
 *  (B) area weights: Σ = 1 for interior discs, zero weight for cells outside (or only touching) the disc, symmetry,
 *      translation invariance, domain-boundary fraction, r -> 0 limit;
 *  (C) store-level invariants of area-weighted sampling: non-negativity, conservation (a covering disc reads the whole
 *      present amount; the disc-convolution integral equals πr²·amount; sampling never changes the store), exposure <=
 *      present amount, overreach removed (a cell with zero intersection area never contributes);
 *  (D) causal read contract: real-time reads only the latest committed state (records state commit vs sensing time);
 *      historical reads are a separate API behind an unforgeable capability, marked decision_use 'forbidden', and are
 *      bitwise equal to the real-time reading made at that instant.
 * Every number is synthetic (遊戲假設, D). Convergence across grid sizes is in chem1-core (gridSensitivity).
 */
import assert from 'node:assert/strict';
import {
  ChemRefused, ChemStore, createDiagnosticCapability, replayChem,
  type ChemDiagnosticCapability, type ChemRealtimeReader, type HistoricalSampleQuery, type SampleResult, type StoreConfig,
} from '../engine/chemistry/core.ts';
import { cellRect, circleRectArea, discCellWeights, type Grid2D } from '../engine/chemistry/sampling.ts';
import type { DepositEvent, SampleQuery } from '../engine/chemistry/contract.ts';
import { CLOCK, PLANE, T, Y_EDGES, dep, rng, synthChannel } from '../prototypes/chem1/scenarios.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refused = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof ChemRefused && e.codes.some((c) => c.includes(code)), `${why}: refused with ${code} (got ${(e as ChemRefused).codes ?? e})`); return; }
  ok(false, `${why}: expected refusal ${code}`);
};
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// ======================= (A) exact area
{
  const r = 3, A = Math.PI * r * r;
  ok(close(circleRectArea(r, -10, 10, -10, 10), A, 1e-12), 'rectangle containing the disc: πr²');
  ok(close(circleRectArea(r, 0, 10, 0, 10), A / 4, 1e-12) && close(circleRectArea(r, -10, 0, -10, 10), A / 2, 1e-12), 'quarter and half disc');
  ok(close(circleRectArea(r, -1, 1, -1, 1), 4, 1e-12), 'rectangle inside the disc: its own area');
  ok(circleRectArea(r, 3, 5, -1, 1) === 0 && circleRectArea(r, 3, 5, 3, 5) === 0 && circleRectArea(r, 2.2, 5, 2.2, 5) === 0, 'touching along a line, at a point, or disjoint: exactly 0');
  ok(circleRectArea(0, -1, 1, -1, 1) === 0 && circleRectArea(r, 1, 1, -1, 1) === 0, 'zero radius or empty rectangle: 0');
  // circular segment closed form: area of {x >= d} ∩ disc = r² acos(d/r) − d sqrt(r² − d²)
  for (const d of [0.1, 1, 2.5, 2.999]) ok(close(circleRectArea(r, d, 10, -10, 10), r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d), 1e-12), `circular segment at d = ${d}`);
  // random rectangles vs fine 1D quadrature (midpoint, 400000 steps) and Monte Carlo (200000 points, ±5 SE)
  const g = rng(31337);
  let worstQ = 0, worstMC = 0;
  for (let k = 0; k < 40; k++) {
    const R = 0.5 + 4 * g(), x0 = -6 + 10 * g(), y0 = -6 + 10 * g(), x1 = x0 + 0.05 + 4 * g(), y1 = y0 + 0.05 + 4 * g();
    const exact = circleRectArea(R, x0, x1, y0, y1);
    const N = 400000, h = (x1 - x0) / N; let q = 0;
    for (let n = 0; n < N; n++) { const x = x0 + (n + 0.5) * h, hh = R * R - x * x; if (hh > 0) { const s = Math.sqrt(hh); q += Math.max(0, Math.min(y1, s) - Math.max(y0, -s)) * h; } }
    worstQ = Math.max(worstQ, Math.abs(exact - q));
    const M = 200000, area = (x1 - x0) * (y1 - y0); let hit = 0;
    for (let n = 0; n < M; n++) { const x = x0 + (x1 - x0) * g(), y = y0 + (y1 - y0) * g(); if (x * x + y * y <= R * R) hit++; }
    const p = hit / M, se = area * Math.sqrt(Math.max(p * (1 - p), 1 / M) / M);
    ok(Math.abs(exact - p * area) <= 5 * se + 1e-12, `rect ${k}: exact area within 5 SE of Monte Carlo (${exact.toFixed(6)} vs ${(p * area).toFixed(6)})`);
    worstMC = Math.max(worstMC, Math.abs(exact - p * area) / Math.max(se, 1e-12));
    ok(exact >= 0 && exact <= area + 1e-12 && exact <= Math.PI * R * R + 1e-12, `rect ${k}: 0 <= area <= min(rect, disc)`);
  }
  ok(worstQ < 1e-7, `exact area matches fine quadrature (max abs diff ${worstQ.toExponential(2)})`);
  console.error(`[chem1b] area: max |exact − quadrature| = ${worstQ.toExponential(2)}; max |exact − MC| = ${worstMC.toFixed(2)} SE`);
}

// ======================= (B) weights
const grid = (size: number, x0 = 0, y0 = 0, W = 200): Grid2D => ({ x0, y0, x1: x0 + W, y1: y0 + W, size, nx: Math.ceil(W / size), ny: Math.ceil(W / size) });
const minDist = (g: Grid2D, i: number, j: number, cx: number, cy: number) => {
  const c = cellRect(g, i, j), ex = Math.max(c.x0 - cx, 0, cx - c.x1), ey = Math.max(c.y0 - cy, 0, cy - c.y1);
  return Math.hypot(ex, ey);
};
{
  const g0 = rng(4711);
  let worst = 0;
  for (let k = 0; k < 300; k++) {
    const size = [0.25, 0.5, 1, 2, 3, 5, 8][k % 7], r = 0.1 + 6 * g0(), ox = -3 + 6 * g0(), oy = -3 + 6 * g0(), G = grid(size, ox, oy);
    const cx = ox + 50 + 100 * g0(), cy = oy + 50 + 100 * g0(), ws = discCellWeights(G, cx, cy, r);
    const sum = ws.reduce((a, w) => a + w.weight, 0);
    worst = Math.max(worst, Math.abs(sum - 1));
    ok(ws.every((w) => w.area_mm2 > 0 && w.weight > 0 && w.weight <= 1 && w.cover > 0 && w.cover <= 1), `disc ${k}: listed cells have positive area, weights and covers in (0, 1]`);
    ok(ws.every((w) => minDist(G, w.i, w.j, cx, cy) < r), `disc ${k}: no listed cell lies at distance >= r (outside or touching)`);
    // every cell of the bounding box that is not listed meets the disc in zero area
    const listed = new Set(ws.map((w) => `${w.i},${w.j}`));
    let missed = 0;
    for (let i = Math.floor((cx - r - ox) / size) - 1; i <= Math.floor((cx + r - ox) / size) + 1; i++) for (let j = Math.floor((cy - r - oy) / size) - 1; j <= Math.floor((cy + r - oy) / size) + 1; j++) {
      if (listed.has(`${i},${j}`)) continue;
      const c = cellRect(G, i, j);
      if (circleRectArea(r, c.x0 - cx, c.x1 - cx, c.y0 - cy, c.y1 - cy) > 0) missed++;
    }
    ok(missed === 0, `disc ${k}: no cell with positive intersection is left out`);
  }
  ok(worst < 1e-12, `Σ weights = 1 for 300 interior discs (max |Σ − 1| = ${worst.toExponential(2)})`);
  // symmetry: disc at a cell centre on a 1 mm grid -> weights symmetric under reflections and the diagonal swap
  for (const [cx, cy, r] of [[50.5, 50.5, 3], [50.5, 50.5, 2.3], [50, 50, 3], [50, 50.5, 1.7]] as const) {
    const ws = discCellWeights(grid(1), cx, cy, r), m = new Map(ws.map((w) => [`${w.i},${w.j}`, w.weight]));
    const mi = (i: number) => Math.round(2 * cx - 1) - i, mj = (j: number) => Math.round(2 * cy - 1) - j;
    ok(ws.every((w) => close(m.get(`${mi(w.i)},${w.j}`) ?? -1, w.weight, 1e-14) && close(m.get(`${w.i},${mj(w.j)}`) ?? -1, w.weight, 1e-14)), `mirror symmetry (${cx}, ${cy}, r ${r})`);
    if (cx === cy) ok(ws.every((w) => close(m.get(`${w.j},${w.i}`) ?? -1, w.weight, 1e-14)), `diagonal symmetry (${cx}, ${cy}, r ${r})`);
  }
  // translation invariance: shifting disc and grid origin together, or the disc by whole cells
  const g1 = rng(99);
  for (let k = 0; k < 50; k++) {
    const size = [0.5, 1, 2, 4][k % 4], r = 0.3 + 5 * g1(), cx = 40 + 20 * g1(), cy = 40 + 20 * g1(), dx = -5 + 10 * g1(), dy = -5 + 10 * g1(), m = 1 + Math.floor(5 * g1()), n = Math.floor(5 * g1());
    const a = discCellWeights(grid(size), cx, cy, r), b = discCellWeights(grid(size, dx, dy), cx + dx, cy + dy, r), c = discCellWeights(grid(size), cx + m * size, cy + n * size, r);
    ok(a.length === b.length && a.every((w, i) => w.i === b[i].i && w.j === b[i].j && close(w.weight, b[i].weight, 1e-12)), `translation of disc + grid origin (${k})`);
    ok(a.length === c.length && a.every((w, i) => w.i + m === c[i].i && w.j + n === c[i].j && close(w.weight, c[i].weight, 1e-12)), `translation by whole cells (${k})`);
  }
  // domain boundary: a disc centred on the domain corner sees a quarter; on an edge, a half
  ok(close(discCellWeights(grid(1), 0, 0, 3).reduce((a, w) => a + w.weight, 0), 0.25, 1e-12) && close(discCellWeights(grid(1), 0, 100, 3).reduce((a, w) => a + w.weight, 0), 0.5, 1e-12), 'domain corner / edge: Σ weights = 1/4 / 1/2 (no field outside the domain)');
  // r = 0: the r -> 0 limit of the area-weighted average
  const p = (x: number, y: number) => discCellWeights(grid(2), x, y, 0).map((w) => `${w.i},${w.j}:${w.weight}`).join(' ');
  ok(p(51, 51) === '25,25:1' && p(50, 51) === '24,25:0.5 25,25:0.5' && p(50, 50) === '24,24:0.25 24,25:0.25 25,24:0.25 25,25:0.25', 'r = 0: inside a cell 1 cell; on a grid line 2 x 1/2; on a corner 4 x 1/4');
}

// ======================= (C) store-level invariants
const planeCfg = (cell = 2, lambda = 0): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('p', 'sparse_2d', { lambda_per_s: lambda, size_mm: cell }), domain: PLANE(200) }] });
const dq = (x: number, y: number, r: number, t = 10, round = 0): SampleQuery => ({ signal_id: 'p', agent_id: 'w', layer: 'surface', time: T(t, round), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: x, y_mm: y, radius_mm: r } });
const randomPlane = (g: () => number, n: number, t = 10): DepositEvent[] => Array.from({ length: n }, (_, i) => {
  const x0 = 70 + 60 * g(), y0 = 70 + 60 * g();
  return dep(`d${i}`, 'p', `w${i % 5}`, T(Math.floor(g() * t)), g() < 0.5 ? { kind: 'point2d', x_mm: x0, y_mm: y0 } : { kind: 'segment2d', x0_mm: x0, y0_mm: y0, x1_mm: x0 + 10 * g() + 0.1, y1_mm: y0 + 10 * g() - 5 }, 0.1 + g());
});
for (let seed = 1; seed <= 10; seed++) {
  const g = rng(500 + seed), cell = [0.5, 1, 2, 3][seed % 4], s = new ChemStore(planeCfg(cell, seed % 2 ? 0.03 : 0));
  s.deposit(randomPlane(g, 80)); s.advance(T(10));
  const before = JSON.stringify([s.snapshot(), s.ledger('p')]), L = s.ledger('p');
  let allNonNeg = true, bounded = true, consistent = true;
  for (let k = 0; k < 200; k++) {
    const r = k % 10 === 0 ? 0 : 3 * g(), res = s.sampleLocal(dq(60 + 80 * g(), 60 + 80 * g(), r));
    allNonNeg &&= res.exposure >= 0 && res.mean_density_per_mm2! >= 0 && res.cells.every((c) => c.value >= 0 && c.weight! >= 0 && c.cover >= 0 && c.cover <= 1);
    bounded &&= res.exposure <= L.present_amount * (1 + 1e-12);
    consistent &&= r === 0 ? res.exposure === 0 : close(res.exposure, res.mean_density_per_mm2! * Math.PI * r * r, 1e-12 * Math.max(1, res.exposure));
  }
  ok(allNonNeg, `seed ${seed}: exposure, density, values, weights and covers are non-negative`);
  ok(bounded, `seed ${seed}: no sample exceeds the present amount (no signal created by sampling)`);
  ok(consistent, `seed ${seed}: exposure = mean density · πr² (amount inside the disc vs area-weighted average)`);
  ok(JSON.stringify([s.snapshot(), s.ledger('p')]) === before, `seed ${seed}: 200 samples change neither the field nor the ledger (bitwise)`);
  const all = s.sampleLocal(dq(100, 100, 3)); // nothing fits in r = 3; use a big-disc channel for the covering check below
  ok(all.sensed_area_fraction !== null && close(all.sensed_area_fraction, 1, 1e-12), `seed ${seed}: interior disc senses its whole area`);
}
{ // conservation: a disc covering every stored cell reads exactly the present amount; disc convolution integrates to πr²·M
  const g = rng(8080), wide = (cell: number): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('p', 'sparse_2d', { size_mm: cell, max_radius_mm: 200 }), domain: PLANE(200) }] });
  for (const cell of [0.5, 1, 2, 4]) {
    const s = new ChemStore(wide(cell)); s.deposit(randomPlane(g, 60)); s.advance(T(10));
    const M = s.ledger('p').present_amount, r = s.sampleLocal(dq(100, 100, 90));
    ok(close(r.exposure, M, 1e-12 * M) && r.cells.every((c) => c.cover === 1), `cell ${cell}: a disc covering the whole support reads exactly the present amount (${r.exposure} vs ${M})`);
  }
  // ∫ exposure(x) dx over sensor positions = πr²·M (each cell's mass is counted once per unit sensor area)
  const s = new ChemStore(planeCfg(2)); s.deposit([dep('a', 'p', 'w', T(1), { kind: 'segment2d', x0_mm: 95.3, y0_mm: 97.1, x1_mm: 104.2, y1_mm: 101.9 }, 1), dep('b', 'p', 'w', T(1), { kind: 'point2d', x_mm: 99.4, y_mm: 102.7 }, 0.5)]); s.advance(T(10));
  const r = 2.5, h = 0.125; let integral = 0;
  for (let x = 85 + h / 2; x < 115; x += h) for (let y = 85 + h / 2; y < 115; y += h) integral += s.sampleLocal(dq(x, y, r)).exposure * h * h;
  ok(close(integral, Math.PI * r * r * 1.5, 2e-3 * Math.PI * r * r * 1.5), `disc-convolution conservation: ∫ exposure = πr²·M (${integral.toFixed(5)} vs ${(Math.PI * r * r * 1.5).toFixed(5)})`);
}
{ // overreach removed: a deposit whose cell meets the disc in zero area never changes the reading (bitwise), any amount
  const g = rng(2024);
  let tested = 0;
  for (let k = 0; k < 300; k++) {
    const cell = [1, 2, 3][k % 3], cx = 90 + 20 * g(), cy = 90 + 20 * g(), r = 0.5 + 2.5 * g(), G = grid(cell);
    // a point deposit in a cell of the bounding box that has zero intersection area with the disc
    const i = Math.floor((cx - r) / cell) + Math.floor(g() * (Math.ceil(2 * r / cell) + 2)) - 1, j = Math.floor((cy - r) / cell) + Math.floor(g() * (Math.ceil(2 * r / cell) + 2)) - 1;
    const c = cellRect(G, i, j);
    if (circleRectArea(r, c.x0 - cx, c.x1 - cx, c.y0 - cy, c.y1 - cy) > 0) continue;
    const base = randomPlane(g, 10), mk = (extra: boolean) => { const s = new ChemStore(planeCfg(cell)); s.deposit(extra ? [...base, dep('far', 'p', 'w', T(3), { kind: 'point2d', x_mm: c.x0 + cell * (0.01 + 0.98 * g()), y_mm: c.y0 + cell * (0.01 + 0.98 * g()) }, 1e9)] : base); s.advance(T(10)); return s.sampleLocal({ ...dq(cx, cy, Math.min(3, r)) }); };
    const a = mk(false), b = mk(true);
    ok(Object.is(a.exposure, b.exposure) && Object.is(a.mean_density_per_mm2, b.mean_density_per_mm2), `case ${k}: a 10⁹ deposit in a cell with zero intersection area adds exactly 0`);
    tested++;
  }
  ok(tested >= 100, `zero-area cells tested: ${tested}`);
  // CHEM-1 vs CHEM-1b on the documented example: a cell touching the 3 mm disc only at (54, 51)
  const s = new ChemStore(planeCfg(2)); s.deposit([dep('t', 'p', 'w', T(9), { kind: 'point2d', x_mm: 55.9, y_mm: 51 }, 1)]); s.advance(T(9));
  ok(s.sampleLocal(dq(51, 51, 3, 9)).exposure === 0, 'the CHEM-1 overreach example (4.9 mm deposit read in full) now reads exactly 0');
}

// ======================= (D) causal read contract
const edgeCfg = (lambda = 0.05): StoreConfig => ({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'surface_edge', { lambda_per_s: lambda }), domain: Y_EDGES }] });
const eqq = (t: number, round = 0, s_mm = 10): SampleQuery => ({ signal_id: 'trail', agent_id: 'w', layer: 'surface', time: T(t, round), phase: 'local_sensing', sensor: { kind: 'edge', edge_id: 'stem', s_mm, radius_mm: 3 } });
{ // real-time reader capability: only latestCommitted + sampleLocal
  const s = new ChemStore(edgeCfg()), reader: ChemRealtimeReader = s.realtimeReader();
  ok(Object.isFrozen(reader) && Object.keys(reader).sort().join() === 'kind,latestCommitted,sampleLocal', 'the real-time reader exposes kind, latestCommitted and sampleLocal only (frozen)');
  for (const k of ['sampleHistorical', 'snapshot', 'ledger', 'provenance', 'deposit', 'advance', 'horizon']) ok(!(k in reader), `the real-time reader has no ${k}`);
  ok(reader.latestCommitted() === null, 'nothing committed yet');
  s.deposit([dep('a', 'trail', 'w1', T(4), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 })]); s.advance(T(4));
  s.deposit([dep('b', 'trail', 'w1', T(5), { kind: 'edge_point', edge_id: 'stem', s_mm: 11 }, 2)]);
  const c4 = reader.latestCommitted()!, r4 = reader.sampleLocal(eqq(4));
  ok(c4.seq === 1 && c4.time.t_s === 4 && r4.read_kind === 'realtime_latest_committed' && r4.state_commit.seq === 1 && r4.sensing_time.t_s === 4 && r4.exposure === 1, 'sample records the state commit (seq 1, t = 4) separately from the sensing time; pending t = 5 deposit invisible');
  refused(() => reader.sampleLocal(eqq(5)), 'FUTURE_SAMPLE', 'sensing at t = 5 before the t = 5 commit');
  s.advance(T(5)); s.advance(T(5));
  ok(reader.latestCommitted()!.seq === 2, 're-closing the same instant does not create a new commit');
  refused(() => reader.sampleLocal(eqq(4)), 'STALE_SAMPLE', 'real-time read of an older committed state (t = 4 after t = 5 committed)');
  const r5 = reader.sampleLocal(eqq(5));
  ok(r5.state_commit.seq === 2 && r5.exposure === Math.exp(-0.05) + 2, 'real-time read at the latest commit sees the deposits committed for that instant');
  // type-level: a real-time reader cannot reach historical reads; a capability cannot be written by hand; a historical
  // result is not a real-time sample. Checked by `npm run typecheck` (the function is never called).
  const typeChecks = (cap: ChemDiagnosticCapability, hq: HistoricalSampleQuery) => {
    // @ts-expect-error -- ChemRealtimeReader has no historical API
    reader.sampleHistorical(cap, hq);
    // @ts-expect-error -- a hand-written object is not a ChemDiagnosticCapability (brand)
    s.sampleHistorical({ kind: 'chem_diagnostic', purpose: 'diagnosis' }, hq);
    // @ts-expect-error -- a historical result is not assignable to a real-time SampleResult
    const x: SampleResult = s.sampleHistorical(cap, hq);
    return x;
  };
  ok(typeof typeChecks === 'function', 'type-level separation compiled (see @ts-expect-error lines)');
}
{ // historical API: capability, no future, bitwise equal to the real-time reading made then, never edits the store
  for (const plane of [false, true]) for (let seed = 1; seed <= 8; seed++) {
    const g = rng(900 + seed * 2 + (plane ? 1 : 0)), lambda = 0.04;
    const cfg = plane ? planeCfg(1 + (seed % 3), lambda) : edgeCfg(lambda), id = plane ? 'p' : 'trail';
    const sensor = (): SampleQuery['sensor'] => plane ? { kind: 'disc', x_mm: 80 + 40 * g(), y_mm: 80 + 40 * g(), radius_mm: 3 * g() } : { kind: 'edge', edge_id: 'stem', s_mm: 60 * g(), radius_mm: 3 * g() };
    const evs = plane ? randomPlane(g, 60, 12) : Array.from({ length: 60 }, (_, i) => dep(`e${i}`, 'trail', `w${i % 4}`, T(Math.floor(g() * 12), g() < 0.3 ? 1 : 0), { kind: 'edge_point', edge_id: ['stem', 'left'][i % 2], s_mm: 60 * g() }, 0.1 + g()));
    const s = new ChemStore(cfg); s.deposit(evs);
    const sensors = Array.from({ length: 5 }, sensor), seen: { t: number; round: number; res: string[] }[] = [];
    for (let t = 0; t <= 12; t++) for (const round of [0, 1]) {
      s.advance(T(t, round));
      seen.push({ t, round, res: sensors.map((sn) => { const r = s.sampleLocal({ signal_id: id, agent_id: 'w', layer: 'surface', time: T(t, round), phase: 'local_sensing', sensor: sn }); return JSON.stringify([r.exposure, r.mean_density_per_mm2, r.cells]); }) });
    }
    const cap = createDiagnosticCapability('reconstruction'), before = JSON.stringify([s.snapshot(), s.ledger(id)]);
    let same = true;
    for (const { t, round, res } of seen) sensors.forEach((sn, k) => {
      const h = s.sampleHistorical(cap, { signal_id: id, layer: 'surface', at: T(t, round), sensor: sn, purpose: 'reconstruction' });
      same &&= JSON.stringify([h.exposure, h.mean_density_per_mm2, h.cells]) === res[k] && h.view === 'diagnostic_history' && h.decision_use === 'forbidden' && h.exact_commit_instant && h.covered_by_commit.time.t_s === t;
    });
    ok(same, `${plane ? '2d' : 'edge'} seed ${seed}: historical reconstruction at every past commit is bitwise equal to the real-time reading made then`);
    ok(JSON.stringify([s.snapshot(), s.ledger(id)]) === before, `${plane ? '2d' : 'edge'} seed ${seed}: historical reads change nothing`);
  }
  const s = new ChemStore(edgeCfg(0.1)), cap = createDiagnosticCapability('diagnosis');
  s.deposit([dep('a', 'trail', 'w', T(2), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }), dep('b', 'trail', 'w', T(6), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }, 4), dep('c', 'trail', 'w', T(20), { kind: 'edge_point', edge_id: 'stem', s_mm: 10 }, 9)]);
  s.advance(T(2)); s.advance(T(8));
  const hq = (t: number, round = 0): HistoricalSampleQuery => ({ signal_id: 'trail', layer: 'surface', at: T(t, round), sensor: { kind: 'edge', edge_id: 'stem', s_mm: 10, radius_mm: 1 }, purpose: 'diagnosis' });
  const mid = s.sampleHistorical(cap, hq(4));
  ok(close(mid.exposure, Math.exp(-0.2), 1e-15) && mid.covered_by_commit.seq === 2 && !mid.exact_commit_instant, 'between two commits: the state at t = 4 (a decayed, b not yet), covered by commit 2, flagged as not a commit instant');
  ok(close(s.sampleHistorical(cap, hq(8)).exposure, Math.exp(-0.6) + 4 * Math.exp(-0.2), 1e-14), 'at the horizon: same as the real-time state');
  refused(() => s.sampleHistorical(cap, hq(8, 1)), 'FUTURE_SAMPLE', 'historical read beyond the horizon');
  refused(() => s.sampleHistorical(cap, hq(20)), 'FUTURE_SAMPLE', 'historical read of a pending (uncommitted) instant');
  refused(() => s.sampleHistorical({ kind: 'chem_diagnostic', purpose: 'diagnosis' } as unknown as ChemDiagnosticCapability, hq(4)), 'NO_DIAGNOSTIC_CAPABILITY', 'a forged capability object');
  refused(() => s.sampleHistorical(undefined as unknown as ChemDiagnosticCapability, hq(4)), 'NO_DIAGNOSTIC_CAPABILITY', 'no capability');
  refused(() => s.sampleHistorical(createDiagnosticCapability('replay'), hq(4)), 'PURPOSE_MISMATCH', 'capability purpose differs from the query purpose');
  refused(() => s.sampleHistorical(cap, { ...hq(4), ...eqq(4) } as unknown as HistoricalSampleQuery), 'HISTORICAL_QUERY_IS_NOT_A_SENSING_ACT', 'a real-time sensing query (agent, phase) sent to the historical API');
  refused(() => createDiagnosticCapability('behaviour' as never), 'BAD:diagnostic_purpose', 'a capability for decisions does not exist');
  ok(replayChem(edgeCfg(), []).view === 'replay_diagnostic', 'replay output is labelled diagnostic');
}

console.log(JSON.stringify({ test: 'chem1b-sampling', checks }));
