/**
 * Work C v2 (Issues #68/#69): two P. megacephala minor workers meet head-on in a narrow corridor, with the LOCAL,
 * literature-based encounter rules. Re-runs the experiment (prototypes/physics/two-ant-corridor.ts) and checks:
 * entry yield applied with the literature proportion; laden priority as the alternative; both-inside rule symmetric;
 * contact time loss paid; control unchanged; engine = hand-worked closed form for the drawn decision; replay and
 * input-order invariance; an independent fixed-step implementation converges; the committed report is exactly the output.
 * Engineering evidence only — not validation of P. megacephala behaviour (no traffic study exists for any Pheidole).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { runExperiment, report, runOne } from '../prototypes/physics/two-ant-corridor.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const e = runExperiment(), en = e.entry, c = e.control, la = e.laden;
const se = (p: number, n: number) => Math.sqrt(p * (1 - p) / n);
ok(en.contact_certain === true && en.obstruction_t_s !== null && en.contact_t_s! <= en.obstruction_t_s, 'entry: contact (certain), then obstruction');
ok(en.rule === 'entry yield' && en.yielder === 'W2' && Math.abs(en.hold_s - 0.18) < 1e-12, `entry: the ant not yet inside (W2) gives way after a 0.18 s contact pause (L. humile contact duration) — seed 1 (${en.rule}, ${en.yielder}, ${en.hold_s})`);
ok(en.ants.W1.added_s! >= 0.18 - 1e-9 && en.ants.W2.added_s! > en.ants.W1.added_s!, 'entry: both pay the contact pause; the one that gives way loses more');
ok(Math.abs(e.entry_seeds.W2_gave_way / e.entry_seeds.seeds - e.entry_seeds.literature) < 3 * se(e.entry_seeds.literature, e.entry_seeds.seeds), `entry: ${e.entry_seeds.W2_gave_way}/${e.entry_seeds.seeds} gave way, literature ${e.entry_seeds.literature.toFixed(3)} (within 3 SE)`);
ok(la.rule === 'laden priority' && la.yielder === 'W1' && Math.abs(e.laden_seeds.unladen_gave_way / e.laden_seeds.seeds - e.laden_seeds.literature) < 3 * se(e.laden_seeds.literature, e.laden_seeds.seeds), `laden priority: the unladen ant gives way even though it is already inside (${e.laden_seeds.unladen_gave_way}/${e.laden_seeds.seeds}; Atta 294/300)`);
ok(c.obstruction_t_s === null && c.yielder === null && c.contact_certain === false && Math.abs(c.ants.W1.added_s!) < 1e-9 && Math.abs(c.ants.W2.added_s!) < 1e-9, 'control (no walls): possible contact only, arrivals equal walking alone');
for (const r of [en, c, la, ...e.width_sensitivity]) ok(r.exclusion_violations === 0 && r.replay_identical && r.order_identical, `${r.label}: no overlap, replay and input order identical`);
ok(Math.abs(e.analytic.engine_minus_analytic_s[0]) < 1e-9 && Math.abs(e.analytic.engine_minus_analytic_s[1]) < 1e-9 && e.analytic.inside_checked === 45 && e.analytic.inside_max_abs_diff_s < 1e-9, `engine = closed form for the drawn decision (entry ${e.analytic.engine_minus_analytic_s}; inside max ${e.analytic.inside_max_abs_diff_s})`);
// both inside: no study → candidate p, τ; more contacts when p is far from 0.5; never a non-local rule
for (const r of e.inside) {
  ok(r.violations === 0, `inside p=${r.p} τ=${r.tau_s}: no overlap in the checked seeds`);
  ok(Math.abs(r.mean_contacts - 1 / (2 * r.p * (1 - r.p))) < 4 * Math.sqrt((1 - 2 * r.p * (1 - r.p)) / (2 * r.p * (1 - r.p)) ** 2 / r.seeds), `inside p=${r.p}: mean contacts ${r.mean_contacts.toFixed(2)} ≈ 1/(2p(1−p)) = ${(1 / (2 * r.p * (1 - r.p))).toFixed(2)}`);
}
const t43 = e.inside.filter((r) => r.p === 0.5).map((r) => r.mean_added_W2_s);
ok(t43[0] < t43[1] && t43[1] < t43[2], 'inside: a larger contact time loss gives a larger delay');
{
  let w1 = 0; const n = 2000;
  for (let sd = 1; sd <= n; sd++) if (runOne('sym', 'inside', { seed: sd, light: true, enc: { inside_turn_back_probability: 0.5, contact_pause_s: 0.43 } }).summary.yielder === 'W1') w1++;
  ok(Math.abs(w1 / n - 0.5) < 3 * se(0.5, n), `inside: the rule is symmetric — W1 gives way in ${w1}/${n} (0.5 ± 3 SE)`);
}
const low = e.width_sensitivity[0], high = e.width_sensitivity.slice(1);
ok(low.obstruction_t_s === null && high.every((r) => r.yielder !== null), 'width 0.5 passes abreast (boundary case); wider ants must give way');
const cv = e.convergence.rows;
ok(Math.abs(cv.at(-1)!.W1_err_s) < 1e-5 && Math.abs(cv.at(-1)!.W2_err_s) < 1e-4 && Math.abs(cv[0].W2_err_s) > 100 * Math.abs(cv.at(-1)!.W2_err_s), `fixed-step version converges to the engine as Δt → 0 (${cv.map((x) => x.W2_err_s.toExponential(1)).join(' → ')})`);
const committed = fs.readFileSync(path.join(REPO_ROOT, 'reports/physics-two-ant-corridor.md'), 'utf8');
ok(committed === report(e), 'reports/physics-two-ant-corridor.md is regenerated output (run: node prototypes/physics/two-ant-corridor.ts > reports/physics-two-ant-corridor.md)');
console.log(JSON.stringify({ physics_two_ant: 'pass', checks }, null, 2));
