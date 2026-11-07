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
import { type EncounterRules, type SimAgentSpec, type SimConfig, type SimResult, type PhysObject, simulate, checkExclusion, LEN_TOL } from '../engine/physics/collision.ts';
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
/** exactly the dense two-way generator of tests/physics-p2d.test.ts (3–10 ants, loads); it has real blocked rings */
const dense = (seed: number): SimConfig => {
  const r = rng(seed * 7717), na = 3 + Math.floor(r() * 8), agents: SimAgentSpec[] = [], objects: PhysObject[] = [], used: number[] = [];
  for (let k = 0; k < na; k++) {
    const d = (r() < 0.5 ? 1 : -1) as 1 | -1;
    let s = 0; for (let tries = 0; tries < 50; tries++) { s = 2 + r() * 96; if (used.every((u) => Math.abs(u - s) > 2.6)) break; }
    if (!used.every((u) => Math.abs(u - s) > 2.6)) continue; used.push(s);
    let load: string | null = null; if (r() < 0.3) { load = `o${k}`; objects.push({ id: load, width_mm: 0.5 + r() * 0.3, holder: `a${k}` }); }
    agents.push({ id: `a${k}`, passage: 'P-corridor', s_mm: s, dir: d, goal_s_mm: d > 0 ? Math.max(s, 99) : Math.min(s, 1), free_speed_mm_s: 10 + r() * 10, start_t_s: r() * 3, load, body: { length_mm: 2.5, width_mm: 0.55 + r() * 0.25, contact_reach_mm: r() } });
  }
  return { encounter: { priority: 'entry_yield', entry_yield_probability: 0.957, laden_yield_probability: 0.98, contact_pause_s: 0.18, inside_turn_back_probability: [0.1, 0.5, 0.9][seed % 3] }, geometry: cor, agents, objects, horizon_s: 60, seed };
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

// ---- B. coincident (abreast) ants are never "ahead" of each other in the entry queue
{
  const fx: Any = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/physics/corridor-12x8-seed3-seed7.json'), 'utf8'));
  for (const [name, c] of Object.entries(fx.cases) as [string, Any][]) {
    const cfg: SimConfig = { encounter: c.encounter, geometry: cor, agents: c.agents, horizon_s: c.horizon_s, seed: c.seed }, r = simulate(cfg);
    const blocked = r.events.filter((e) => e.kind === 'unresolved' && /every ant blocked ahead/.test(e.detail ?? ''));
    ok(blocked.length === 0, `${name}: no entry-queue ring is declared 'every ant blocked ahead' between abreast ants (${blocked.map((e) => `${e.agent}@${r.final[e.agent].s_mm}`).join(', ')})`);
    ok(inPassage(cfg, r).length === 0 && checkExclusion(cfg, r, 0.005).length === 0 && Object.values(r.final).every((f) => STOPPED.has(f.mode)), `${name}: in the passage, no overlap, every ant arrived or reported`);
    console.error(`B. ${name}: ${Object.values(r.final).filter((f) => f.mode === 'arrived').length}/${cfg.agents.length} arrived (recorded, not a target)`);
  }
  // across traffic 1–60 and dense 1–200: whenever a ring is reported blocked, its members are NOT coincident (a real block)
  let rings = 0;
  for (const [gen, n, f] of [['traffic', 60, traffic], ['dense', 200, dense]] as const) for (let seed = 1; seed <= n; seed++) {
    const r = simulate(f(seed));
    for (const e of r.events.filter((x) => x.kind === 'unresolved' && /every ant blocked ahead/.test(x.detail ?? ''))) {
      const ids = (/\(([^)]*)\)/.exec(e.detail!)?.[1] ?? '').split(' → ').filter(Boolean), ss = ids.map((id) => r.final[id].s_mm as number);
      const coincident = ss.length > 1 && Math.max(...ss) - Math.min(...ss) <= LEN_TOL(100);
      ok(!coincident, `${gen} seed ${seed}: blocked ring ${ids.join('→')} is not a set of coincident ants (spread ${(Math.max(...ss) - Math.min(...ss)).toExponential(2)} mm)`); rings++;
    }
  }
  console.error(`B. blocked rings remaining in traffic 1–60 + dense 1–200: ${rings} (all non-coincident)`);
  ok(rings > 0, `the non-coincidence check met real blocked rings (${rings})`);
}
console.log(JSON.stringify({ passed: true, checks }));
