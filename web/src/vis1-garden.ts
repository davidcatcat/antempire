/**
 * VIS-1 garden scene layout (DECORATION, 裝飾). Pure and DOM-free; deterministic from the world seed.
 * The P0-A2 world models NO garden geometry, vegetation, shade or soil (matrix M02: 簡化代理). Every item here is
 * decoration: it is never an obstacle, no worker senses it, and it changes nothing in the simulation. Items are kept
 * off the display corridor and the nest / source clearings only so that drawn ants do not walk through stones (a
 * drawing choice, not an obstacle model). Sizes are plausible garden-floor sizes (示意), not measurements.
 * Placement is per world-space cell (hash of seed, class and cell), so any chunk of the scene can be built
 * independently and the same world always looks the same.
 */
import { h01 } from './art-core.ts';
import type { Corridor, Pt } from './vis1-path.ts';

export type DecorKind = 'stone' | 'pebble' | 'leaf' | 'twig' | 'grass' | 'clover' | 'moss' | 'seed';
export interface Decor { kind: DecorKind; x: number; y: number; r: number; rot: number; seed: number; tone: number; decoration: true }
interface ClassDef { kind: DecorKind; cell: number; tries: number; p: number; rMin: number; rMax: number; clearCorridor: number; clearNest: number; clearSource: number; field?: 'litter' | 'veg' | 'moist' }
/** r = characteristic radius (cm): stones / pebbles radius, leaves and twigs half length, plants radius */
export const DECOR_CLASSES: ClassDef[] = [
  { kind: 'moss', cell: 26, tries: 2, p: 0.5, rMin: 1.5, rMax: 6, clearCorridor: 0, clearNest: 4, clearSource: 0, field: 'moist' },
  { kind: 'stone', cell: 34, tries: 2, p: 0.42, rMin: 1.4, rMax: 7.5, clearCorridor: 2.2, clearNest: 6, clearSource: 7 },
  { kind: 'twig', cell: 30, tries: 2, p: 0.38, rMin: 2, rMax: 8, clearCorridor: 0, clearNest: 4, clearSource: 4 },
  { kind: 'leaf', cell: 7, tries: 2, p: 0.5, rMin: 0.9, rMax: 3.4, clearCorridor: 0, clearNest: 2.5, clearSource: 2.5, field: 'litter' },
  { kind: 'pebble', cell: 4.5, tries: 3, p: 0.45, rMin: 0.12, rMax: 0.65, clearCorridor: 0.35, clearNest: 1.2, clearSource: 0.5 },
  { kind: 'seed', cell: 9, tries: 2, p: 0.35, rMin: 0.12, rMax: 0.3, clearCorridor: 0, clearNest: 1, clearSource: 0 },
  { kind: 'clover', cell: 24, tries: 2, p: 0.5, rMin: 2.2, rMax: 5.5, clearCorridor: 1.6, clearNest: 5, clearSource: 3, field: 'veg' },
  { kind: 'grass', cell: 20, tries: 2, p: 0.55, rMin: 3, rMax: 9, clearCorridor: 1.8, clearNest: 6, clearSource: 3, field: 'veg' },
];
/** draw order (bottom → top) */
export const DECOR_ORDER: DecorKind[] = ['moss', 'seed', 'pebble', 'leaf', 'twig', 'stone', 'clover', 'grass'];

function vnoise(seed: number, x: number, y: number, period: number): number {
  const fx = x / period, fy = y / period, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty), v = (i: number, j: number) => h01(seed, ix + i, iy + j, period | 0);
  return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
}
export function fbm(seed: number, x: number, y: number, period: number, oct = 3): number {
  let s = 0, a = 1, n = 0, p = period;
  for (let i = 0; i < oct; i++) { s += a * vnoise(seed + i * 977, x, y, p); n += a; a *= 0.5; p /= 2.1; }
  return s / n;
}
/** decorative fields in [0, 1]: litter density, vegetation, moisture (darker soil), canopy shade (dappled light) */
export function fields(seed: number, x: number, y: number) {
  return { litter: fbm(seed + 11, x, y, 70), veg: fbm(seed + 23, x, y, 90), moist: fbm(seed + 37, x, y, 55), shade: fbm(seed + 51, x, y, 140, 2), soil: fbm(seed + 67, x, y, 30, 4) };
}

export class Garden {
  private coarse: Pt[];
  private cells = new Map<string, Decor[]>();
  readonly seed: number; readonly C: Corridor;
  constructor(seed: number, C: Corridor) {
    this.seed = seed; this.C = C;
    this.coarse = [];
    const L = C.line, n = 120;
    for (let i = 0; i <= n; i++) this.coarse.push(L.pts[Math.round((i / n) * (L.pts.length - 1))]);
  }
  distCorridor(x: number, y: number): number {
    let best = Infinity;
    for (let i = 1; i < this.coarse.length; i++) {
      const a = this.coarse[i - 1], b = this.coarse[i], dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
      const k = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2)), d = Math.hypot(x - a.x - dx * k, y - a.y - dy * k);
      if (d < best) best = d;
    }
    return best;
  }
  /** items of one class in one cell (memoised; deterministic) */
  cell(ci: number, i: number, j: number): Decor[] {
    const key = `${ci}|${i}|${j}`; let out = this.cells.get(key); if (out) return out;
    out = []; const D = DECOR_CLASSES[ci], s = this.seed + ci * 7919;
    for (let k = 0; k < D.tries; k++) {
      const x = (i + h01(s, i, j, k * 3 + 1)) * D.cell, y = (j + h01(s, i, j, k * 3 + 2)) * D.cell, F = fields(this.seed, x, y);
      const w = D.field === 'litter' ? 0.25 + 1.5 * F.litter : D.field === 'veg' ? Math.max(0, (F.veg - 0.35) * 2.6) : D.field === 'moist' ? Math.max(0, (F.moist - 0.45) * 3) : 1;
      if (h01(s, i, j, k * 3 + 3) > D.p * w) continue;
      const u = h01(s, i, j, k * 5 + 101), r = D.rMin + (D.rMax - D.rMin) * u * u;
      if (D.clearCorridor > 0 && this.distCorridor(x, y) < r + D.clearCorridor) continue;
      if (Math.hypot(x - this.C.nest.x, y - this.C.nest.y) < r + D.clearNest) continue;
      if (Math.hypot(x - this.C.source.x, y - this.C.source.y) < r + D.clearSource) continue;
      out.push({ kind: D.kind, x, y, r, rot: h01(s, i, j, k * 5 + 102) * Math.PI * 2, seed: (s ^ (i * 73856093) ^ (j * 19349663) ^ (k * 83492791)) >>> 0, tone: h01(s, i, j, k * 5 + 103), decoration: true });
    }
    if (this.cells.size > 60000) this.cells.clear();
    this.cells.set(key, out); return out;
  }
  /** all items of the classes whose drawn size reaches `minPx` at `pxPerCm`, overlapping the world rectangle */
  itemsIn(x0: number, y0: number, x1: number, y1: number, pxPerCm: number, minPx = 1.6): Decor[] {
    const out: Decor[] = [];
    DECOR_CLASSES.forEach((D, ci) => {
      if (D.rMax * 2 * pxPerCm < minPx) return;
      const m = D.rMax * (D.kind === 'grass' || D.kind === 'twig' ? 1.3 : 1.15) + 1;
      for (let i = Math.floor((x0 - m) / D.cell); i <= Math.floor((x1 + m) / D.cell); i++) for (let j = Math.floor((y0 - m) / D.cell); j <= Math.floor((y1 + m) / D.cell); j++)
        for (const it of this.cell(ci, i, j)) if (it.r * 2 * pxPerCm >= minPx * 0.6) out.push(it);
    });
    return out.sort((a, b) => DECOR_ORDER.indexOf(a.kind) - DECOR_ORDER.indexOf(b.kind) || a.seed - b.seed);
  }
}
