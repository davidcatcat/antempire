/**
 * KIN-2D ↔ PH-3b shared physics interface (engine/physics/shared-contract.ts; docs/physics-shared-contract.md). Blocking.
 * PH-3b (solver2d.ts) must stay byte-identical to main; adapters only translate; scenarios both solvers support agree
 * within the stated error bounds; the acceleration extension is reserved (inactive, null); the document tables are
 * reproduced verbatim.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { runBoth, validateScenario, toKin2DInput, toPH3bInput, ACCELERATION_RESERVED, SharedRefused, type SharedScenario } from '../engine/physics/shared-contract.ts';
import { scenarios, compare, comparisonTable, capabilityTable } from '../prototypes/physics-shared/compare.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, p))).digest('hex');
// PH-3b unchanged (hash of engine/physics/solver2d.ts on origin/main 6864974)
ok(sha('engine/physics/solver2d.ts') === '3726d1d50c34bad0e3a44ef52bbf58c34cfe3d814f094f2d1ff297650b85bc26', 'solver2d.ts byte-identical to main');
for (const f of ['engine/physics/solver2d.ts', 'engine/physics/kinematics2d.ts']) ok(!/shared-contract/.test(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8')), `${f} does not depend on the shared contract`);

const list = scenarios();
for (const x of list.filter((e) => e.scenario)) {
  const s = x.scenario as SharedScenario, before = JSON.stringify(s);
  ok(validateScenario(s).length === 0, `${x.id}: valid scenario`);
  const r1 = runBoth(s), r2 = runBoth(s), c = compare(s, r1);
  ok(JSON.stringify(s) === before, `${x.id}: adapters do not mutate the scenario`);
  ok(JSON.stringify(r1) === JSON.stringify(r2), `${x.id}: replayable (identical records)`);
  ok(r1.kin2d.schema === 'antempire.physics-run.v1' && r1.ph3b.schema === 'antempire.physics-run.v1' && r1.kin2d.acceleration.active === false && r1.ph3b.acceleration.active === false, `${x.id}: shared record schema, acceleration inactive`);
  if (x.expect === 'agree') ok(c.ok, `${x.id}: both solvers agree within the error bounds (${c.notes.join('; ')})`);
  else ok(!c.ok && c.contact_max_dt_s !== null && c.contact_tol_s !== null && c.contact_max_dt_s <= c.contact_tol_s, `${x.id}: contact time agrees; the post-contact constraint differs by model (expected)`);
  // input order invariance: reversing the agent list gives the same per-agent results
  const rev = { ...s, agents: [...s.agents].reverse() }, r3 = runBoth(rev);
  for (const a of s.agents) for (const k of ['kin2d', 'ph3b'] as const) ok(JSON.stringify(r1[k].agents.find((q) => q.id === a.id)) === JSON.stringify(r3[k].agents.find((q) => q.id === a.id)), `${x.id}/${a.id}/${k}: independent of agent input order`);
}
ok(list.some((e) => e.id === 'straight' && e.scenario) && list.some((e) => e.id === 'two-ant-meeting' && e.scenario), 'straight and two-ant scenarios are compared');
ok(['arc', 'in-place-rotation', 'lateral-steering'].every((id) => list.find((e) => e.id === id)?.supported === 'kin2d_only'), 'motions PH-3b does not support are listed, not approximated');
// acceleration is reserved
{
  const s = list[0].scenario as SharedScenario;
  ok(validateScenario({ ...s, acceleration: { ...ACCELERATION_RESERVED, max_accel_mm_s2: 100 as unknown as null } }).length > 0, 'a filled acceleration value is refused');
  ok(validateScenario({ ...s, acceleration: { ...ACCELERATION_RESERVED, active: true as unknown as false } }).length > 0, 'an active acceleration extension is refused');
  // polyline lanes are not converted for KIN-2D (no instantaneous turn there)
  const poly = { ...s, lanes: [{ ...s.lanes[0], centerline: [{ x_mm: 0, y_mm: 0 }, { x_mm: 50, y_mm: 0 }, { x_mm: 50, y_mm: 50 }] }] };
  assert.throws(() => toKin2DInput(poly), SharedRefused); checks++;
  ok(toPH3bInput(poly).lanes[0].centerline_mm.length === 3, 'PH-3b accepts the polyline lane');
}
// doc tables verbatim
{
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/physics-shared-contract.md'), 'utf8');
  ok(doc.includes(capabilityTable()) && doc.includes(comparisonTable()), 'docs/physics-shared-contract.md contains both tables verbatim (rerun node prototypes/physics-shared/compare.ts)');
}
console.log(JSON.stringify({ physics_shared_contract: 'pass', checks }));
