/**
 * PH-P2D (Owner issue #100): in the PH-2b rules, an ant backing out behind a nestmate in single file (`pressOn`) may walk
 * faster once the stretch it shares with the ant ahead is no longer single-file. That instant must be an explicitly
 * scheduled event (the boundary event of its front), never the next unrelated event or a broadphase window end.
 * Also: a window end is never an evaluation instant (tolerance-based 'now' tests are only evaluated at event instants).
 * The historical #73 P2-A (old rules) is a separate item and is NOT covered here.
 *
 * Before the fix (commit 003184d): the dense-corridor comparisons of window_s 100 vs 1 / 0.37 / 0.05 / 0.003 differed in
 * 4 of 400 runs (event times up to 2.7e-3 s apart, seeds 7, 34, 38), and 369 of 4,000 comparisons over 200 seeds with
 * boundary-aligned windows differed. The preserved 12 × 8 corridor counterexamples (seeds 3 and 7) are recorded, not
 * required to arrive (Owner #100: keep 88/96; do not tune to 96/96). Since PH-P2E (#107) the numerical cause is fixed and
 * the fixture checks that coincident ants are never 'ahead' of each other; arrivals are still only recorded.
 *
 * Engineering evidence only: the physics layer is experimental, not connected to the daily simulation, and not a
 * validated model of P. megacephala behaviour.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';
import { checkTrajectory, passageOf, stateAt } from '../engine/physics/kinematics.ts';
import { type SimAgentSpec, type SimConfig, type SimResult, type PhysObject, simulate, checkExclusion, narrowSections, SAME_INSTANT, LEN_TOL } from '../engine/physics/collision.ts';
import { rng } from '../engine/rng.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const cor: PhysicsGeometry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scenarios/physics/narrow-corridor.geometry.json'), 'utf8'));
const Pc = passageOf(cor, 'P-corridor');
const key = (r: SimResult) => JSON.stringify([r.events, r.final, r.intervals]);   // everything except stats (window/step counts)

// the dense two-way corridor generator of the window-split fuzz (3–10 ants, loads, contact pause 0.18 s)
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
const solid = (cfg: SimConfig, r: SimResult, why: string) => {
  ok(checkExclusion(cfg, r, 0.005).length === 0, `${why}: no overlap (checked at every record boundary and every 5 ms; length tolerance 1e-6 mm)`);
  const vmax = Math.max(...cfg.agents.map((a) => a.free_speed_mm_s));
  ok(cfg.agents.every((a) => checkTrajectory(cfg.geometry, r.intervals[a.id], vmax).length === 0), `${why}: no teleport or tunnelling (continuous records, |Δs| = v·Δt within 1e-6 relative, v ≤ vmax)`);
};

// ---- 1. the reproducers: seeds 7, 34, 38 — the speed-up of a pressed back-out ant at its own instant, for every window
for (const seed of [7, 34, 38]) {
  const cfg = dense(seed), base = simulate({ ...cfg, window_s: 100 });
  solid(cfg, base, `dense ${seed}`);
  for (const w of [1, 0.37, 0.05, 0.003]) ok(key(simulate({ ...cfg, window_s: w })) === key(base), `dense ${seed}: window ${w} s gives bit-identical events, records and finals (before: up to 2.7e-3 s apart)`);
  ok(key(simulate({ ...cfg, window_s: 100, agents: [...cfg.agents].reverse() })) === key(base) && key(simulate({ ...cfg, window_s: 100 })) === key(base), `dense ${seed}: input-order and replay invariant`);
}
// the causal instant: in dense seed 7, a6 backs out pressed behind a3 (single file); it speeds up to its own free speed
// exactly when its front (the contact point) leaves the single-file section of the pair a6 + a3
{
  const cfg = dense(7), r = simulate(cfg), a6 = cfg.agents.find((a) => a.id === 'a6')!, a3 = cfg.agents.find((a) => a.id === 'a3')!;
  const ivs = r.intervals.a6, k = ivs.findIndex((iv, i) => i > 0 && iv.cause === 'yield_back_out' && iv.speed_mm_s === a6.free_speed_mm_s && ivs[i - 1].cause === 'yield_back_out' && ivs[i - 1].speed_mm_s < a6.free_speed_mm_s);
  ok(k > 0, 'dense 7: a6 speeds up while backing out (pressed, then free)');
  const tr = ivs[k].t_start_s, front = stateAt(ivs, tr)!.s_mm - a6.body.length_mm / 2, sec = narrowSections(cor, Pc, a6.body.width_mm + a3.body.width_mm)[0];
  ok(Math.abs(front - sec[0]) <= LEN_TOL(100), `dense 7: the speed-up is at t = ${tr} s, when a6's front is at the section boundary (${front} vs ${sec[0]} mm, tolerance ${LEN_TOL(100).toExponential(1)} mm)`);
  const prev = ivs[k - 1], tBoundary = prev.t_start_s + (prev.s_start_mm - (sec[0] + a6.body.length_mm / 2)) / prev.speed_mm_s;
  ok(Math.abs(tr - tBoundary) <= SAME_INSTANT(tr) + 1e-12, `dense 7: the speed-up instant equals the analytic boundary time ${tBoundary} s (tolerance SAME_INSTANT ≈ ${SAME_INSTANT(tr).toExponential(1)} s + 1e-12 s for the record-start rounding)`);
}

// ---- 2. window-split sweep with boundary-aligned windows: window ends on an event instant, 1 ulp-ish before/after it,
// 0.5 ns before it, and a third of it — none may change any event, record or final state
{
  let cmp = 0, diff = 0, ord = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const cfg = dense(seed); let base: SimResult;
    try { base = simulate({ ...cfg, window_s: 100 }); } catch (e) { if (/same space|narrower/.test(String(e))) continue; throw e; }
    n++; solid(cfg, base, `sweep seed ${seed}`);
    if (key(simulate({ ...cfg, window_s: 100, agents: [...cfg.agents].reverse() })) !== key(base)) ord++;
    const evT = base.events.filter((e) => e.t_s > 0.01).map((e) => e.t_s), pick = [evT[0], evT[Math.floor(evT.length / 2)], evT[evT.length - 1]].filter((x) => x !== undefined);
    for (const w of [7, 1, 0.37, 0.05, 0.003, ...pick.flatMap((t) => [t, t / 3, t * (1 - 1e-15), t * (1 + 1e-15), t - 5e-10])]) { cmp++; if (key(simulate({ ...cfg, window_s: w })) !== key(base)) diff++; }
  }
  ok(n === 40 && cmp >= 600 && diff === 0 && ord === 0, `window-split sweep: ${n} dense scenes, ${cmp} window comparisons (incl. boundary-aligned) all bit-identical; input order invariant (${diff} / ${ord} differing)`);
}

// ---- 3. the preserved 12 × 8 corridor counterexamples (seeds 3 and 7; Owner #100) — recorded, not required to arrive
{
  const fx: Any = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/physics/corridor-12x8-seed3-seed7.json'), 'utf8'));
  ok(fx.synthetic === true && /numerical degeneracy/.test(fx.observation) && /not tuned away/.test(fx.observation), 'fixture documents its source and the classification');
  for (const [name, c] of Object.entries(fx.cases) as [string, Any][]) {
    const cfg: SimConfig = { encounter: c.encounter, geometry: cor, agents: c.agents, horizon_s: c.horizon_s, seed: c.seed }, r = simulate(cfg);
    solid(cfg, r, name);
    for (const w of [7, 0.05, 0.003]) ok(key(simulate({ ...cfg, window_s: w })) === key(r), `${name}: window ${w} s bit-identical`);
    ok(key(simulate({ ...cfg, agents: [...cfg.agents].reverse() })) === key(r), `${name}: input-order invariant`);
    const modes = Object.values(r.final).map((f) => f.mode), unresolvedIds = new Set(r.events.filter((e) => e.kind === 'unresolved').flatMap((e) => [e.agent, e.other]));
    ok(modes.every((m) => m === 'arrived' || m === 'unresolved') && Object.entries(r.final).every(([id, f]) => f.mode !== 'unresolved' || unresolvedIds.has(id)), `${name}: every ant arrives or is reported unresolved with a named partner (no silent wait)`);
    const stuck = Object.entries(r.final).filter(([, f]) => f.mode === 'unresolved');
    // PH-P2E B (#107): before, all four outbound ants stood at one arc length (spread ≤ 1e-12 mm) and were each judged
    // 'blocked ahead' by an abreast nestmate on the sign of a rounding residue. Now coincident ants are never 'ahead'.
    const abreastBlocked = r.events.filter((e) => e.kind === 'unresolved' && /every ant blocked ahead/.test(e.detail ?? '') && (() => { const ss = stuck.map(([, f]) => f.s_mm); return ss.length > 1 && Math.max(...ss) - Math.min(...ss) <= 1e-12; })());
    ok(abreastBlocked.length === 0, `${name}: no ring of coincident (abreast) ants is reported 'every ant blocked ahead' (PH-P2E B, #107)`);
    console.error(`${name}: ${modes.filter((m) => m === 'arrived').length} arrived, ${stuck.length} unresolved (${stuck.map(([id]) => id).join(', ') || '—'})`);
  }
}

console.log(JSON.stringify({ physics_p2d: 'pass', checks }, null, 2));
