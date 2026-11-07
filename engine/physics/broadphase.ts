/**
 * PH-3b broad phase (docs/physics-ph3b-solver2d.md): candidate pairs of axis-aligned boxes for the ISOLATED 2-D solver
 * (engine/physics/solver2d.ts). Not used by simulate() or by the daily simulation (tests/physics-isolation.test.ts).
 *
 * Three interchangeable methods with IDENTICAL output (tests/ph3b-solver2d.test.ts):
 *  - bruteForcePairs: every pair, O(N²) — the reference only, never the solver's default;
 *  - gridPairs2D: uniform grid / spatial hash;
 *  - sweepAndPrunePairs: sort on x, sweep with an active list, test y.
 * Semantics: boxes are CLOSED (touching boxes are a pair), only boxes with the same `key` (collision layer) pair up,
 * and the result is the sorted list of index pairs i < j encoded as i·n + j. Indices are positions in the given array;
 * the solver passes its canonically sorted (by id) agents, so the result does not depend on any input order.
 * Pure functions, no platform APIs. Units: mm.
 */
export interface AABB { minX: number; minY: number; maxX: number; maxY: number }

const overlap = (a: AABB, b: AABB) => a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
const sorted = (out: number[]) => out.sort((x, y) => x - y);

/** Reference: every pair (O(N²)). */
export function bruteForcePairs(boxes: readonly AABB[], keys: readonly number[]): number[] {
  const n = boxes.length, out: number[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (keys[i] === keys[j] && overlap(boxes[i], boxes[j])) out.push(i * n + j);
  return out;
}

/**
 * Uniform grid (spatial hash) of cell size `cell` (mm; a numerical choice that changes cost, never the result). Each box
 * is entered in every cell it touches; a pair found in several shared cells is reported only from the cell holding the
 * corner (max minX, max minY) of the two boxes, so no set is needed for de-duplication.
 */
export function gridPairs2D(boxes: readonly AABB[], keys: readonly number[], cell: number): number[] {
  if (!(cell > 0) || !Number.isFinite(cell)) throw Error('BROADPHASE: grid cell must be a positive finite number');
  const n = boxes.length, grid = new Map<string, number[]>(), out: number[] = [];
  const cx = (x: number) => Math.floor(x / cell);
  for (let i = 0; i < n; i++) {
    const b = boxes[i];
    for (let gx = cx(b.minX); gx <= cx(b.maxX); gx++) for (let gy = cx(b.minY); gy <= cx(b.maxY); gy++) {
      const k = `${gx},${gy}`, l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
    }
  }
  for (const [k, l] of grid) {
    const comma = k.indexOf(','), gx = Number(k.slice(0, comma)), gy = Number(k.slice(comma + 1));
    for (let p = 0; p < l.length; p++) for (let q = p + 1; q < l.length; q++) {
      const i = l[p], j = l[q], A = boxes[i], B = boxes[j];
      if (keys[i] !== keys[j] || !overlap(A, B)) continue;
      if (cx(Math.max(A.minX, B.minX)) !== gx || cx(Math.max(A.minY, B.minY)) !== gy) continue;   // reported by another cell
      out.push(i < j ? i * n + j : j * n + i);
    }
  }
  return sorted(out);
}

/** Sweep and prune on x (ties broken by index), y tested for the boxes active in the sweep. */
export function sweepAndPrunePairs(boxes: readonly AABB[], keys: readonly number[]): number[] {
  const n = boxes.length, order = Array.from({ length: n }, (_, i) => i).sort((a, b) => boxes[a].minX - boxes[b].minX || a - b);
  let active: number[] = []; const out: number[] = [];
  for (const i of order) {
    const b = boxes[i];
    active = active.filter((j) => boxes[j].maxX >= b.minX);
    for (const j of active) if (keys[i] === keys[j] && boxes[j].minY <= b.maxY && b.minY <= boxes[j].maxY) out.push(i < j ? i * n + j : j * n + i);
    active.push(i);
  }
  return sorted(out);
}

export type BroadphaseKind = 'grid' | 'sap' | 'brute';
export function broadphasePairs(kind: BroadphaseKind, boxes: readonly AABB[], keys: readonly number[], cell: number): number[] {
  return kind === 'grid' ? gridPairs2D(boxes, keys, cell) : kind === 'sap' ? sweepAndPrunePairs(boxes, keys) : bruteForcePairs(boxes, keys);
}
