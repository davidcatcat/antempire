/**
 * PH-P2E (independent review of #98 / #105, 2026-11-07): two numerical defects of the isolated physics layer. Neither
 * changes a speed, a probability, a body size, an encounter rule or a seed.
 *
 *  A. A walk's END event (back-out target `retreat_done`, goal `arrive`) was dropped when an unrelated event fell within
 *     T_EPS / S_EPS before it: the `at()` guard skips an event that is "not ahead", and the end was then never scheduled,
 *     so the ant walked on past the passage end (traffic seed 30: A6 to s = −1978.77 mm; seed 44: A7 to s = 2175.20 mm,
 *     both still `retreat` at the horizon). Window-split invariance cannot see this (every window drops it the same way)
 *     and the 12-seed traffic test did not reach these seeds. Fix: the end of a walk is due NOW when the ant is within
 *     S_EPS of it or past it — the same rule boundary / wall / aperture events already use.
 *  B. The entry queue decided which of several ABREAST ants (same arc length up to 1–4 ulp, e.g. seeds 3 and 7 of the
 *     12 × 8 corridor) is "ahead" by the sign of the rounding residue: `(o.s − r.s)·travel > 0`. Every ring member was
 *     then "blocked ahead" by a coincident nestmate and all were reported unresolved, although none of their bodies was
 *     in the single-file section. Fix: a difference within LEN_TOL(lane length) is coincident — neither is ahead — and
 *     the existing entry-queue rule (game assumption, unchanged) applies.
 *
 * Before the fixes (ef8308d, PR #105 head): A fails for traffic seeds 30 and 44; B fails for seeds 3 and 7 (fixture).
 * Engineering evidence only: the physics layer is experimental and not connected to the daily simulation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';
import { checkTrajectory, passageOf } from '../engine/physics/kinematics.ts';
import { type EncounterRules, type SimAgentSpec, type SimConfig, type SimResult, simulate, checkExclusion } from '../engine/physics/collision.ts';
import { rng } from '../engine/rng.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const dir = path.join(REPO_ROOT, 'scenarios/physics');
const cor: PhysicsGeometry = JSON.parse(fs.readFileSync(path.join(dir, 'narrow-corridor.geometry.json'), 'utf8'));
const Pc = passageOf(cor, 'P-corridor');
const bodyC = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.body-candidates.json'), 'utf8'));
const inter = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.interaction-candidates.json'), 'utf8'));
const L = bodyC.castes.minor.body_length_mm.value as number, wHi = (bodyC.castes.minor.effective_collision_width_mm.candidate_range as number[])[1];
const reach = (inter.contact_reach_mm.candidate_range as number[])[0] + 0.5;
const E = inter.encounter;
const ENC: EncounterRules = { priority: E.priority.value, entry_yield_probability: E.entry_yield_probability.value, laden_yield_probability: E.laden_yield_probability.value, contact_pause_s: E.contact_pause_s.value, inside_turn_back_probability: E.inside_turn_back_probability.candidate_values[1] };
const key = (r: SimResult) => JSON.stringify([r.events, r.final, r.intervals]);
/** exactly the generator of tests/ph2-collision.test.ts §9b, for any seed */
const traffic = (seed: number): SimConfig => {
  const g = rng(seed), agents: SimAgentSpec[] = [];
  for (let k = 0; k < 8; k++) { const d = (k % 2 ? -1 : 1) as 1 | -1, v = 15 + g() * 4, t0 = g() * 8; /* same draw order as §9b: speed, then start */ agents.push({ id: `A${k}`, passage: 'P-corridor', s_mm: d > 0 ? 2 + Math.floor(k / 2) * 3 : 98 - Math.floor(k / 2) * 3, dir: d, start_t_s: t0, free_speed_mm_s: v, goal_s_mm: d > 0 ? 98 : 2, body: { length_mm: L, width_mm: wHi, contact_reach_mm: reach }, load: null }); }
  return { encounter: ENC, geometry: cor, agents, horizon_s: 120, seed };
};
const STOPPED = new Set(['arrived', 'unresolved', 'blocked']);
/** every record of every ant inside the passage [0, length] (with a length tolerance), and no ant still walking a
 *  back-out or towards its goal at the horizon without having been reported */
const inPassage = (cfg: SimConfig, r: SimResult) => {
  const len = 100 /* narrow-corridor.geometry.json P-corridor length */, tol = 1e-6, out: string[] = [];
  for (const a of cfg.agents) for (const iv of r.intervals[a.id]) if (Math.min(iv.s_start_mm, iv.s_end_mm) < -tol || Math.max(iv.s_start_mm, iv.s_end_mm) > len + tol) { out.push(`${a.id} ${iv.s_start_mm.toFixed(3)}→${iv.s_end_mm.toFixed(3)} mm`); break; }
  return out;
};

// ---- A. the end of a walk is never dropped: no ant leaves the passage (traffic seeds 1–60, incl. 30 and 44)
{
  const iv0 = simulate(traffic(1)).intervals.A0[0] as Any;
  ok(['s_start_mm', 's_end_mm'].every((k) => typeof iv0[k] === 'number'), 'motion records carry s_start / s_end (the in-passage check reads them)');
  let arrived = 0, total = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const cfg = traffic(seed), r = simulate(cfg), outside = inPassage(cfg, r);
    ok(outside.length === 0, `traffic seed ${seed}: every ant stays inside the passage (${outside.join('; ') || 'ok'})`);
    ok(cfg.agents.every((a) => checkTrajectory(Pc, r.intervals[a.id], 19).length === 0), `traffic seed ${seed}: trajectories consistent (no leaving the passage, no jump)`);
    ok(Object.values(r.final).every((f) => STOPPED.has(f.mode)), `traffic seed ${seed}: every ant has arrived or is reported; none is still walking a back-out or a goal at the horizon (${JSON.stringify(Object.fromEntries(Object.entries(r.final).filter(([, f]) => !STOPPED.has(f.mode)).map(([k, f]) => [k, f.mode])))})`);
    ok(checkExclusion(cfg, r, 0.005).length === 0, `traffic seed ${seed}: no overlap`);
    arrived += Object.values(r.final).filter((f) => f.mode === 'arrived').length; total += cfg.agents.length;
    if (seed === 30 || seed === 44) for (const w of [7, 0.37, 0.05, 0.003]) ok(key(simulate({ ...cfg, window_s: w })) === key(r), `traffic seed ${seed}: window ${w} s bit-identical`);
  }
  console.error(`A. traffic seeds 1–60: ${arrived}/${total} arrived (recorded, not a target)`);
}

console.log(JSON.stringify({ passed: true, checks }));
