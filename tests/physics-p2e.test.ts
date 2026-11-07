/**
 * PH-P2E (independent review of #98 / #105, 2026-11-07): two numerical defects of the isolated physics layer. Neither
 * changes a speed, a probability, a body size, an encounter rule or a seed.
 *
 *  A. A walk's END event (back-out target `retreat_done`, goal `arrive`) was dropped when an unrelated event fell within
 *     T_EPS / S_EPS before it: the `at()` guard skips an event that is "not ahead", and the end was then never scheduled,
 *     so the ant walked on past the passage end (traffic seed 30: A6 to s = −1978.77 mm; seed 44: A7 to s = 2175.20 mm,
 *     both still `retreat` at the horizon). Window-split invariance cannot see this (every window drops it the same way)
 *     and the 12-seed traffic test did not reach these seeds. Fix: within S_EPS of the end (or past it) the end is
 *     scheduled at its ANALYTIC time (never earlier than now). A2 measures that no end fires early: every move record and
 *     every arrival agrees with t_start + distance / speed within SAME_INSTANT (Owner review of #108).
 *  B. The entry queue decided which of several ants with COINCIDENT 1-D ARC COORDINATES (equal up to 1–4 ulp, e.g. seeds
 *     3 and 7 of the 12 × 8 corridor) is "ahead" by the sign of the rounding residue: `(o.s − r.s)·travel > 0`. Every
 *     ring member was then "blocked ahead" by a nestmate at the same arc length and all were reported unresolved,
 *     although none of their bodies was in the single-file section. Fix: a difference within LEN_TOL(lane length) is
 *     coincident — neither is ahead — and the existing entry-queue rule (game assumption, unchanged) applies.
 *     Coincident arc length is NOT a claim that the bodies fit side by side: the lane model has no lateral coordinate.
 *  C. P2-E, NOT fixed (model limitation, recorded): the engine and checkExclusion check bodies in PAIRS. Three or more
 *     bodies at one arc position may need more width than the passage has; checkWidthOccupancy reports this. The tests
 *     pin the counterexamples (accepted by the engine, invisible to checkExclusion, reported by the width-sum check) and
 *     record how often it happens — so no result here (e.g. 96/96 arrivals) is evidence of 2-D physical feasibility.
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
import { type EncounterRules, type SimAgentSpec, type SimConfig, type SimResult, type PhysObject, simulate, checkExclusion, checkWidthOccupancy, LEN_TOL, SAME_INSTANT } from '../engine/physics/collision.ts';
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

// ---- A2. no end fires early: every move record ends at t_start + distance / speed, every arrival at its analytic time
{
  let worstRec = 0, worstArr = 0, recs = 0, arrs = 0;
  for (const [gen, n, f] of [['traffic', 60, traffic], ['dense', 200, dense]] as const) for (let seed = 1; seed <= n; seed++) {
    const cfg = f(seed), r = simulate(cfg);
    for (const [id, ivs] of Object.entries(r.intervals)) for (const iv of ivs) if (iv.kind === 'move' && iv.speed_mm_s > 0) {
      const early = iv.t_start_s + iv.distance_mm / iv.speed_mm_s - iv.t_end_s; recs++; worstRec = Math.max(worstRec, early);
      assert.ok(early <= SAME_INSTANT(iv.t_end_s), `${gen} ${seed} ${id}: a move record ends ${early.toExponential(2)} s before t_start + distance / speed (more than SAME_INSTANT)`);
    }
    for (const e of r.events.filter((x) => x.kind === 'arrive')) {
      const mv = r.intervals[e.agent].filter((iv) => iv.kind === 'move' && iv.t_end_s <= e.t_s + 1e-12).at(-1); if (!mv) continue;
      const early = mv.t_start_s + Math.abs(e.s_mm - mv.s_start_mm) / mv.speed_mm_s - e.t_s; arrs++; worstArr = Math.max(worstArr, early);
      assert.ok(early <= SAME_INSTANT(e.t_s), `${gen} ${seed} ${e.agent}: arrival ${early.toExponential(2)} s before its analytic time`);
      assert.equal(e.s_mm, cfg.agents.find((a) => a.id === e.agent)!.goal_s_mm, 'an arrival is exactly at the goal');
    }
  }
  ok(recs > 0 && arrs > 0, `A2: ${recs} move records and ${arrs} arrivals: none earlier than its analytic time by more than SAME_INSTANT (worst ${worstRec.toExponential(2)} s / ${worstArr.toExponential(2)} s)`);
  console.error(`A2. worst early end: move record ${worstRec.toExponential(2)} s, arrival ${worstArr.toExponential(2)} s (tolerance SAME_INSTANT = 16 ulps of t)`);
}

// ---- B. ants with coincident 1-D arc coordinates are never "ahead" of each other in the entry queue
{
  const fx: Any = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/physics/corridor-12x8-seed3-seed7.json'), 'utf8'));
  for (const [name, c] of Object.entries(fx.cases) as [string, Any][]) {
    const cfg: SimConfig = { encounter: c.encounter, geometry: cor, agents: c.agents, horizon_s: c.horizon_s, seed: c.seed }, r = simulate(cfg);
    const blocked = r.events.filter((e) => e.kind === 'unresolved' && /every ant blocked ahead/.test(e.detail ?? ''));
    ok(blocked.length === 0, `${name}: no entry-queue ring is declared 'every ant blocked ahead' between ants at coincident arc lengths (${blocked.map((e) => `${e.agent}@${r.final[e.agent].s_mm}`).join(', ')})`);
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

// ---- C. P2-E (not fixed): three bodies at one arc position can need more width than the passage — pinned and counted
{
  const prov = { source: 'synthetic_scenario', assumption: true, basis: '遊戲假設', note: 'P2-E counterexample lane' };
  const lane2: PhysicsGeometry = { schema: 'antempire.physics-geometry.v1', layer_of: 'antempire.world-geometry.v1', world_geometry_ref: null, world_id: 'synthetic-p2e', geometry_version: '0.1.0', synthetic: true, synthetic_note: 'P2-E: a straight 100 mm lane 2.0 mm wide', frame: { units: 'mm', axes: { x: 'east', y: 'north', z: 'up' }, origin: 'synthetic' }, obstacles: [], entrances: [],
    surfaces: [{ id: 'S', material: 'bare_soil', polygon_mm: [[-10, -10], [110, -10], [110, 10], [-10, 10]], elevation: { kind: 'flat', z_mm: 0 }, provenance: prov }],
    passages: [{ id: 'P', centerline_mm: [[0, 0, 0], [100, 0, 0]], width_mm: 2.0, route_edge_ref: null, provenance: prov }] } as Any;
  const ag = (id: string, s: number, w: number): SimAgentSpec => ({ id, passage: 'P', s_mm: s, dir: 1, start_t_s: 0, free_speed_mm_s: 10, goal_s_mm: 90, body: { length_mm: 2.5, width_mm: w, contact_reach_mm: 0.5 }, load: null });
  const run = (agents: SimAgentSpec[]) => { const cfg: SimConfig = { encounter: { ...ENC, contact_pause_s: null }, geometry: lane2, agents, horizon_s: 20, seed: 1 }; return { cfg, r: simulate(cfg) }; };
  // two bodies that do not fit side by side (1.1 + 1.1 > 2.0) are refused at the start: pairs ARE enforced
  assert.throws(() => run([ag('a', 10, 1.1), ag('b', 10.5, 1.1)]), /start in the same space/); checks++;
  const two = run([ag('a', 10, 1.1), ag('b', 14, 1.1)]);
  ok(checkExclusion(two.cfg, two.r, 0.005).length === 0 && checkWidthOccupancy(two.cfg, two.r, 0.005).length === 0, 'two bodies in single file: no pairwise and no width-sum excess (control)');
  // three bodies of 0.8 mm overlapping in arc length on a 2.0 mm lane need 2.4 mm: KNOWN LIMITATION P2-E
  const three = run([ag('a', 10, 0.8), ag('b', 10.5, 0.8), ag('c', 11, 0.8)]), wx = checkWidthOccupancy(three.cfg, three.r, 0.005);
  ok(Object.values(three.r.final).every((f) => f.mode === 'arrived'), 'P2-E counterexample: the 1-D engine accepts three 0.8 mm bodies at one arc position on a 2.0 mm lane (2.4 mm needed) — recorded, not fixed');
  ok(checkExclusion(three.cfg, three.r, 0.005).length === 0, 'P2-E counterexample: checkExclusion (pairwise) does not see it — passing it is NOT a 2-D exclusion proof');
  ok(wx.length > 0 && /need 2\.400 mm/.test(wx[0]), `P2-E counterexample: the width-sum check reports it (${wx[0]})`);
  // how often the 1-D model reaches such states in the corridor generators (recorded; the 1-D model cannot represent the fix)
  const tally: Record<string, number> = {};
  for (const [gen, n, f] of [['traffic', 60, traffic], ['dense', 200, dense]] as const) for (let seed = 1; seed <= n; seed++) { const cfg = f(seed), r = simulate(cfg); if (checkWidthOccupancy(cfg, r, 0.005).length) tally[gen] = (tally[gen] ?? 0) + 1; }
  const fx: Any = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/physics/corridor-12x8-seed3-seed7.json'), 'utf8'));
  for (const [name, c] of Object.entries(fx.cases) as [string, Any][]) { const cfg: SimConfig = { encounter: c.encounter, geometry: cor, agents: c.agents, horizon_s: c.horizon_s, seed: c.seed }; tally[name] = checkWidthOccupancy(cfg, simulate(cfg), 0.005).length; }
  ok(Object.keys(tally).length > 0, `P2-E occurrence (recorded): ${JSON.stringify(tally)} — scenes / instants where three or more bodies need more than the usable width`);
  console.error(`C. P2-E width-sum excess: ${JSON.stringify(tally)} (traffic/dense = scenes; seed-3/7 = sampled instants)`);
}
console.log(JSON.stringify({ passed: true, checks }));
