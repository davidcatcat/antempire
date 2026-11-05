/**
 * Work C (Issues #68/#69): two P. megacephala minor workers meet head-on in a narrow corridor, plus a no-wall control.
 * Re-runs the experiment (prototypes/physics/two-ant-corridor.ts) and checks: contact → obstruction → back-out/wait →
 * changed arrival times; control unchanged; engine = hand-worked closed form; replay and input-order invariance; tie
 * broken by the named stream; an independent fixed-step implementation converges to the engine; and the committed report
 * (reports/physics-two-ant-corridor.md) holds exactly these results. Engineering evidence only, not species validation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { runExperiment, report } from '../prototypes/physics/two-ant-corridor.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const e = runExperiment(), m = e.main, c = e.control;
ok(m.contact && m.contact.certain === true && m.obstruction_t_s !== null && m.contact.t_s <= m.obstruction_t_s, 'walls: contact (certain), then obstruction');
ok(m.yielder === 'W2' && m.back_out_mm! > 0, `walls: W2 (shorter way back) backs out ${m.back_out_mm} mm`);
ok(m.ants.W1.added_s! > 0 && m.ants.W2.added_s! > m.ants.W1.added_s!, 'walls: both arrive later than alone; the yielder much later');
ok(m.ants.W2.path_mm > m.ants.W2.displacement_mm + 2 * m.back_out_mm! - 1e-6 && m.ants.W2.waiting_s > 0, 'walls: the yielder walks the back-out twice and waits');
ok(m.ants.W1.mean_moving_speed! < 18.5 && m.ants.W1.waiting_s === 0, 'walls: W1 never stops but is held to W2’s speed for a while (physical, not a factor)');
ok(Math.abs(e.analytic.engine_minus_analytic_s[0]) < 1e-9 && Math.abs(e.analytic.engine_minus_analytic_s[1]) < 1e-9, `engine = closed form (${e.analytic.engine_minus_analytic_s})`);
ok(c.obstruction_t_s === null && c.yielder === null && c.contact?.certain === false && Math.abs(c.ants.W1.added_s!) < 1e-9 && Math.abs(c.ants.W2.added_s!) < 1e-9, 'control (no walls): possible contact only, arrivals equal walking alone');
for (const r of [m, c, ...e.sensitivity]) ok(r.exclusion_violations === 0 && r.replay_identical && r.order_identical, `${r.label}: no overlap, replay and input order identical`);
const low = e.sensitivity.filter((r) => r.width_mm === 0.5), high = e.sensitivity.filter((r) => r.width_mm > 0.6);
ok(low.every((r) => r.obstruction_t_s === null) && high.every((r) => r.yielder === 'W2'), 'sensitivity: width 0.5 passes abreast, ≥ 0.65 must give way (depends on the unknown collision width)');
ok(new Set(e.sensitivity.filter((r) => r.width_mm === 0.8).map((r) => r.ants.W2.arrive_s)).size === 1, 'sensitivity: the contact reach changes only when contact happens, not arrivals');
ok(Object.keys(e.tie.yielder_counts).sort().join() === 'W1,W2' && e.tie.yielder_counts.W1 + e.tie.yielder_counts.W2 === e.tie.seeds, `tie: both ants give way in some seeds (${JSON.stringify(e.tie.yielder_counts)})`);
const cv = e.convergence;
ok(cv.every((x) => x.yielder === 'W2') && Math.abs(cv.at(-1)!.W1_err_s) < 1e-5 && Math.abs(cv.at(-1)!.W2_err_s) < 1e-5 && Math.abs(cv[0].W2_err_s) > 100 * Math.abs(cv.at(-1)!.W2_err_s), `fixed-step reference converges to the engine as Δt → 0 (${cv.map((x) => x.W2_err_s.toExponential(1)).join(' → ')})`);
const og = e.convergence_offgrid.rows;
ok(og.slice(1).every((x, i) => Math.abs(x.W2_err_s) < 0.2 * Math.abs(og[i].W2_err_s)), `off-grid speeds: the fixed-step error falls about tenfold per decade of Δt (${og.map((x) => x.W2_err_s.toExponential(1)).join(' → ')})`);
ok(Math.abs(e.analytic.section_end_mm - (80 + Math.sqrt(0.64 - 0.25))) < 1e-12, 'closed form uses the wall-corner geometry by hand (no engine geometry code)');
// the committed report is exactly what the experiment produces now
const committed = fs.readFileSync(path.join(REPO_ROOT, 'reports/physics-two-ant-corridor.md'), 'utf8');
ok(committed === report(e), 'reports/physics-two-ant-corridor.md is regenerated output (run: node prototypes/physics/two-ant-corridor.ts > reports/physics-two-ant-corridor.md)');
console.log(JSON.stringify({ physics_two_ant: 'pass', checks }, null, 2));
