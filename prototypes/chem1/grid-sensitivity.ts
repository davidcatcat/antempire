/**
 * CHEM-1 grid / cell-size sensitivity and numerical convergence of sparse_2d sampling (Owner decision 4: if the cell
 * size materially changes sampled values, the result is kept and reported, never tuned). Synthetic, 非正式: every
 * number (segment length, radius, cell sizes, positions) is a synthetic candidate (遊戲假設, D), not a species value.
 *
 * Reference: the exact continuous exposure of a straight deposit (amount A spread uniformly over length L) read by a
 * disc of radius r is A·|segment ∩ disc(r)|/L. The core reads whole cells that intersect the disc (no area weighting),
 * so for λ = 0 it must satisfy  exact(r) <= sample <= exact(r + cell·√2)  (cell-diagonal band), and the error -> 0 as
 * the cell shrinks. Printed only (no file written):  node prototypes/chem1/grid-sensitivity.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChemStore } from '../../engine/chemistry/core.ts';
import { CLOCK, T, dep, rng, synthChannel } from './scenarios.ts';

export const GRID_CELLS_MM = [8, 4, 2, 1, 0.5, 0.25];
export const GRID_SETUP = { trials: 200, seed: 20261108, segment_mm: 20, radius_mm: 3, max_offset_mm: 5, amount: 1, plane_mm: 200 };

/** length of the segment P0-P1 inside the disc (cx, cy, R) */
export function chordInDisc(x0: number, y0: number, x1: number, y1: number, cx: number, cy: number, R: number): number {
  const dx = x1 - x0, dy = y1 - y0, fx = x0 - cx, fy = y0 - cy, a = dx * dx + dy * dy, b = 2 * (fx * dx + fy * dy), c = fx * fx + fy * fy - R * R;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return 0;
  const sq = Math.sqrt(disc), t0 = Math.max(0, (-b - sq) / (2 * a)), t1 = Math.min(1, (-b + sq) / (2 * a));
  return t1 > t0 ? (t1 - t0) * Math.sqrt(a) : 0;
}

interface Trial { x0: number; y0: number; x1: number; y1: number; sx: number; sy: number }
export function gridTrials(): Trial[] {
  const g = rng(GRID_SETUP.seed), out: Trial[] = [], L = GRID_SETUP.segment_mm;
  for (let k = 0; k < GRID_SETUP.trials; k++) {
    const x0 = 60 + 80 * g(), y0 = 60 + 80 * g(), th = 2 * Math.PI * g(), ux = Math.cos(th), uy = Math.sin(th);
    const u = (0.2 + 0.6 * g()) * L, off = (2 * g() - 1) * GRID_SETUP.max_offset_mm;
    out.push({ x0, y0, x1: x0 + L * ux, y1: y0 + L * uy, sx: x0 + u * ux - off * uy, sy: y0 + u * uy + off * ux });
  }
  return out;
}

/** sample every trial on a fresh store with the given cell size (origin shifted by `shift_mm` to test grid alignment) */
function sampleAll(cell_mm: number, shift_mm: number, trials: Trial[]): number[] {
  const { radius_mm: r, amount, plane_mm: W } = GRID_SETUP;
  return trials.map((tr, k) => {
    const s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('g', 'sparse_2d', { size_mm: cell_mm, max_radius_mm: r }), domain: { backend: 'sparse_2d', bounds_mm: { x0: -shift_mm, y0: -shift_mm, x1: W, y1: W }, layers: ['surface'] } }] });
    s.deposit([dep(`d${k}`, 'g', 'w', T(1), { kind: 'segment2d', x0_mm: tr.x0, y0_mm: tr.y0, x1_mm: tr.x1, y1_mm: tr.y1 }, amount)]);
    s.advance(T(1));
    return s.sampleLocal({ signal_id: 'g', agent_id: 'reader', layer: 'surface', time: T(1), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: tr.sx, y_mm: tr.sy, radius_mm: r } }).exposure;
  });
}

export interface GridRow {
  cell_mm: number; mean_exact: number; mean_sample: number; mean_abs_err: number; max_abs_err: number; rel_bias: number;
  false_positive: number; shift_max_diff: number; bound_violations: number; mean_band: number;
}
export function gridSensitivity(): GridRow[] {
  const trials = gridTrials(), { radius_mm: r, amount, segment_mm: L } = GRID_SETUP;
  const exact = trials.map((t) => amount * chordInDisc(t.x0, t.y0, t.x1, t.y1, t.sx, t.sy, r) / L);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return GRID_CELLS_MM.map((c) => {
    const v = sampleAll(c, 0, trials), shifted = sampleAll(c, c / 2, trials);
    const upper = trials.map((t) => amount * chordInDisc(t.x0, t.y0, t.x1, t.y1, t.sx, t.sy, r + c * Math.SQRT2) / L);
    const err = v.map((x, i) => x - exact[i]), eps = 1e-12;
    return {
      cell_mm: c, mean_exact: mean(exact), mean_sample: mean(v), mean_abs_err: mean(err.map(Math.abs)), max_abs_err: Math.max(...err.map(Math.abs)),
      rel_bias: mean(v) / mean(exact) - 1, false_positive: v.filter((x, i) => exact[i] === 0 && x > 0).length / trials.length,
      shift_max_diff: Math.max(...v.map((x, i) => Math.abs(x - shifted[i]))),
      bound_violations: v.filter((x, i) => x < exact[i] - eps || x > upper[i] + eps).length + shifted.filter((x, i) => x < exact[i] - eps || x > upper[i] + eps).length,
      mean_band: mean(upper.map((u, i) => u - exact[i])),
    };
  });
}

/** the markdown rows recorded in docs/chemical-ecology-engine.md §14.5 (checked by tests/chem1-core.test.ts) */
export function gridTableRows(rows = gridSensitivity()): string[] {
  const f = (x: number, d = 4) => x.toFixed(d);
  return rows.map((x) => `| ${x.cell_mm} | ${f(x.mean_exact)} | ${f(x.mean_sample)} | ${f(x.mean_abs_err)} | ${f(x.max_abs_err)} | ${(100 * x.rel_bias).toFixed(1)}% | ${(100 * x.false_positive).toFixed(1)}% | ${f(x.shift_max_diff)} | ${f(x.mean_band)} | ${x.bound_violations} |`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(gridTableRows().join('\n'));
