/**
 * Model C diagnosis (docs/kin2d-model-c-diagnosis.md): the tables are recomputed and must appear verbatim; the
 * three-term decomposition must reproduce every executed angular rate bit for bit; the diagnosis must not change model C
 * (the original §8 failure table is still checked verbatim by tests/natural-walk.test.ts). Diagnostics, not targets: no
 * assertion on agreement with R133.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { allDiagnosisTables, runSet, decompose, linearLoop, heldLoopSdY } from '../prototypes/natural-walk/diagnose-c.ts';
import { trailAnt, walkParams, trailField, body } from '../prototypes/natural-walk/lib.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/kin2d-model-c-diagnosis.md'), 'utf8');
for (const [k, t] of Object.entries(allDiagnosisTables())) ok(doc.includes(t), `docs/kin2d-model-c-diagnosis.md contains the ${k} table verbatim (rerun node prototypes/natural-walk/diagnose-c.ts)`);
// the diagnosis runner reproduces the §8 runs exactly when nothing is overridden
{
  const r = runSet('C', 'out').slice(0, 3), ref = [0, 1, 2].map((i) => trailAnt('C', 10, i, { speed: 18.5 }));
  ok(r.every((x, i) => JSON.stringify(x.plan.track.segs) === JSON.stringify(ref[i].plan.track.segs)), 'diagnosis runs = §8 trail runs');
  ok(r.every((x) => decompose(x).mismatches === 0), 'noise + heading + chem reconstruction reproduces every executed ω bit for bit');
}
// linear loop: the sample-and-hold map converges to the continuous-time Lyapunov solution as Δc → 0
{
  const p = walkParams('C'), L = body().length_mm as number, c = linearLoop(p, trailField().sigma_mm, 18.5, L).sd_y;
  ok(Math.abs(heldLoopSdY(p, trailField().sigma_mm, 18.5, L, 0.0005) / c - 1) < 1e-3, 'held loop → continuous loop as Δc → 0');
}
console.log(JSON.stringify({ kin2d_diagnosis: 'pass', checks }));
