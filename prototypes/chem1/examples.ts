/**
 * CHEM-1 synthetic examples (#132), printed to the terminal only (no file written). Synthetic numbers, 非正式.
 *   node prototypes/chem1/examples.ts
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sparseSpace, twoAnts, yMaze } from './scenarios.ts';

export function examples() {
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const y0 = yMaze(0), y1 = yMaze(Math.LN2 / 600);
  const near = twoAnts(0), far = twoAnts(50), sp = sparseSpace(14, 30);
  return {
    label: 'CHEM-1 synthetic examples — 非正式; every number synthetic (遊戲假設, D), not a species value',
    y_maze: [y0, y1].map((y) => ({ lambda_per_s: r6(y.lambda_per_s), ants: y.n, read_at_s: y.read_at_s, left: r6(y.left), right: r6(y.right), stem: r6(y.stem), decayed: r6(y.ledger.decayed_amount) })),
    two_ants: [near, far].map((x) => ({ gap_mm: x.gap_mm, a_t10: r6(x.readings.at(-1)!.a), b_t10: r6(x.readings.at(-1)!.b), cells: x.ledger.cells })),
    sparse: { agents: sp.agents, seconds: sp.seconds, cells_stored: sp.cells_stored, cells_possible: sp.cells_possible },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(examples(), null, 2));
