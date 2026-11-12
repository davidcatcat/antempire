/**
 * CHEM-1b — area-weighted sampling geometry of the sparse_2d backend (Owner decision 30; docs/chemical-ecology-engine.md
 * §14.6). NUMERICAL METHOD ONLY: no biological number, no calibration.
 *
 * Status: ISOLATED (tests/chemistry-isolation.test.ts). Pure functions; no platform API, no randomness, no clock.
 *
 * The stored 2D field is piecewise constant: a cell's amount a_c is spread uniformly over the cell's area |c| (the cell
 * rectangle clipped to the domain bounds). A disc sensor D (centre, radius r > 0) reads the integral of that field over D:
 *     exposure = Σ_c a_c · |D ∩ c| / |c|               (amount inside the disc)
 *     mean density = Σ_c w_c · a_c / |c|,   w_c = |D ∩ c| / |D|   (area-weighted average; Σ w_c = 1 for an interior disc)
 * with |D ∩ c| the EXACT circle-rectangle intersection area (closed form below). A cell whose intersection with the
 * disc has zero area (outside, or touching only at a point or along a boundary) gets weight exactly 0, so no part of the
 * stored field outside the sensing disc is read because of cell boundaries.
 * r = 0 (point sensor): zero area, exposure 0; the mean density is the r -> 0 limit, i.e. the average of the cells
 * whose closure contains the point (1, 2 or 4 cells; weight 1/4 per quadrant).
 */

/** ∫ sqrt(r² − x²) dx (antiderivative), argument clamped to [−r, r] */
function halfChordPrimitive(x: number, r: number): number {
  const u = Math.max(-r, Math.min(r, x)), q = Math.max(-1, Math.min(1, u / r));
  return 0.5 * (u * Math.sqrt(Math.max(0, r * r - u * u)) + r * r * Math.asin(q));
}

/**
 * Exact area of the intersection of the disc centred at (0, 0) with radius r and the rectangle [x0, x1] × [y0, y1].
 * The area is ∫ |[y0, y1] ∩ [−h(x), h(x)]| dx with h(x) = sqrt(r² − x²). The x-range is split at the points where h
 * crosses |y0| or |y1|; on each piece the integrand is one closed form (y1 or h on top, y0 or −h at the bottom), so
 * every piece is integrated analytically and is non-negative (no inclusion-exclusion cancellation).
 */
export function circleRectArea(r: number, x0: number, x1: number, y0: number, y1: number): number {
  if (!(r > 0) || !(x1 > x0) || !(y1 > y0)) return 0;
  const xa = Math.max(x0, -r), xb = Math.min(x1, r);
  if (!(xb > xa) || y0 >= r || y1 <= -r) return 0;
  const cuts = [xa, xb];
  for (const y of [y0, y1]) if (Math.abs(y) < r) { const a = Math.sqrt(r * r - y * y); for (const v of [-a, a]) if (v > xa && v < xb) cuts.push(v); }
  cuts.sort((p, q) => p - q);
  let area = 0;
  for (let k = 0; k + 1 < cuts.length; k++) {
    const u = cuts[k], v = cuts[k + 1];
    if (!(v > u)) continue;
    const m = 0.5 * (u + v), hm = Math.sqrt(Math.max(0, r * r - m * m));
    if (!(Math.min(y1, hm) > Math.max(y0, -hm))) continue;
    const S = halfChordPrimitive(v, r) - halfChordPrimitive(u, r);
    const top = y1 < hm ? y1 * (v - u) : S, bottom = y0 > -hm ? y0 * (v - u) : -S;
    area += Math.max(0, top - bottom);
  }
  return Math.max(0, Math.min(area, (x1 - x0) * (y1 - y0), Math.PI * r * r));
}

/** A sparse_2d grid: origin (x0, y0), square cells of `size`, nx × ny cells, clipped to the domain bounds (x1, y1). */
export interface Grid2D { x0: number; y0: number; x1: number; y1: number; size: number; nx: number; ny: number }

/** the cell rectangle clipped to the domain bounds (the area the stored amount is spread over) */
export function cellRect(g: Grid2D, i: number, j: number): { x0: number; x1: number; y0: number; y1: number; area: number } {
  const x0 = g.x0 + i * g.size, y0 = g.y0 + j * g.size;
  const x1 = Math.min(g.x1, x0 + g.size), y1 = Math.min(g.y1, y0 + g.size);
  return { x0, x1, y0, y1, area: Math.max(0, x1 - x0) * Math.max(0, y1 - y0) };
}

export interface CellWeight {
  i: number; j: number;
  /** |D ∩ c| (mm²); 0 for r = 0 */
  area_mm2: number;
  /** |D ∩ c| / |D| (r > 0) or the r -> 0 limit weight (r = 0); Σ = 1 for a disc inside the domain */
  weight: number;
  /** |D ∩ c| / |c|: the fraction of the cell's stored amount that lies inside the disc (0 for r = 0) */
  cover: number;
}

/** Every grid cell whose intersection with the disc has POSITIVE area, in (i, j) order, with its exact weights. Cells
 *  with zero intersection area are never listed. Grid cells outside [0, nx) × [0, ny) do not exist (no field there). */
export function discCellWeights(g: Grid2D, cx: number, cy: number, r: number): CellWeight[] {
  const out: CellWeight[] = [];
  if (r === 0) {
    // r -> 0 limit: each of the four quadrants around the point falls into one cell (a point on a grid line touches two)
    const idx = (p: number, o: number, dir: 1 | -1): number => {
      const u = (p - o) / g.size, k = Math.floor(u);
      return u === k && dir < 0 ? k - 1 : k;
    };
    const acc = new Map<string, CellWeight>();
    for (const dx of [-1, 1] as const) for (const dy of [-1, 1] as const) {
      const i = idx(cx, g.x0, dx), j = idx(cy, g.y0, dy);
      if (i < 0 || j < 0 || i >= g.nx || j >= g.ny) continue;
      const key = `${i},${j}`, w = acc.get(key);
      if (w) w.weight += 0.25; else acc.set(key, { i, j, area_mm2: 0, weight: 0.25, cover: 0 });
    }
    return [...acc.values()].sort((a, b) => a.i - b.i || a.j - b.j);
  }
  if (!(r > 0) || !Number.isFinite(r)) return out;
  const disc = Math.PI * r * r;
  const i0 = Math.max(0, Math.floor((cx - r - g.x0) / g.size)), i1 = Math.min(g.nx - 1, Math.floor((cx + r - g.x0) / g.size));
  const j0 = Math.max(0, Math.floor((cy - r - g.y0) / g.size)), j1 = Math.min(g.ny - 1, Math.floor((cy + r - g.y0) / g.size));
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const c = cellRect(g, i, j);
    if (!(c.area > 0)) continue;
    // a cell whose four corners lie in the closed disc is inside it (convexity): its area is exact, cover exactly 1
    const fx = Math.max(Math.abs(c.x0 - cx), Math.abs(c.x1 - cx)), fy = Math.max(Math.abs(c.y0 - cy), Math.abs(c.y1 - cy));
    const a = fx * fx + fy * fy <= r * r ? c.area : circleRectArea(r, c.x0 - cx, c.x1 - cx, c.y0 - cy, c.y1 - cy);
    if (a > 0) out.push({ i, j, area_mm2: a, weight: a / disc, cover: Math.min(1, a / c.area) });
  }
  return out;
}
