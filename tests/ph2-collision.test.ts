/**
 * PH-2 / PH-3 (Issue #68) first working version: obstruction, contact and mechanical limits on synthetic scenes.
 * Engineering tests (Owner list): replay, no passing through obstacles, no teleport, body/load size vs narrow entrance,
 * same node ≠ contact, unit consistency, waiting changes arrival, array-order invariance, no double carrying, no
 * tunnelling at any time resolution, window-size invariance, no creation of food or organisms, broadphase = brute force,
 * and a performance run. Passing says the mechanics are consistent; the response rules are candidate rules (see
 * scenarios/physics/pheidole-megacephala.interaction-candidates.json), not validated ant behaviour.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import type { PhysicsGeometry } from '../engine/physics/geometry.ts';
import { checkTrajectory, passageOf, positionAt, laneLength } from '../engine/physics/kinematics.ts';
import { type SimAgentSpec, type SimConfig, type SimResult, type PhysObject, type ReachDisc, simulate, checkExclusion, gridPairs, bruteForcePairs, pickUp, drop, narrowSections, usableWidth } from '../engine/physics/collision.ts';
import { rng } from '../engine/rng.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
const dir = path.join(REPO_ROOT, 'scenarios/physics');
const geo = (n: string): PhysicsGeometry => JSON.parse(fs.readFileSync(path.join(dir, `${n}.geometry.json`), 'utf8'));
const bodyC = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.body-candidates.json'), 'utf8'));
const inter = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.interaction-candidates.json'), 'utf8'));
const motion = JSON.parse(fs.readFileSync(path.join(dir, 'pheidole-megacephala.motion-candidates.json'), 'utf8'));
const L = bodyC.castes.minor.body_length_mm.value as number;
const [wLo, wHi] = bodyC.castes.minor.effective_collision_width_mm.candidate_range as [number, number];
const reach = (inter.contact_reach_mm.candidate_range as number[])[0] + 0.5;  // 1.0 mm: inside the candidate range
const vOut = motion.trail_speed_mm_s.outbound.value as number, vRet = motion.trail_speed_mm_s.returning.value as number;
const body = (w = wHi) => ({ length_mm: L, width_mm: w, contact_reach_mm: reach });
const ant = (id: string, passage: string, s: number, d: 1 | -1, goal: number, v: number, extra: Partial<SimAgentSpec> = {}): SimAgentSpec => ({ id, passage, s_mm: s, dir: d, start_t_s: 0, free_speed_mm_s: v, goal_s_mm: goal, body: body(), load: null, ...extra });
const run = (g: PhysicsGeometry, agents: SimAgentSpec[], extra: Partial<SimConfig> = {}) => { const cfg: SimConfig = { geometry: g, agents, horizon_s: 60, seed: 1, ...extra }; return { cfg, res: simulate(cfg) }; };
const kinds = (r: SimResult, k: string) => r.events.filter((e) => e.kind === k);
const arrival = (r: SimResult, id: string) => r.events.find((e) => e.kind === 'arrive' && e.agent === id)?.t_s ?? null;
const consistent = (cfg: SimConfig, r: SimResult, why: string) => {
  const ex = checkExclusion(cfg, r, 0.01);
  ok(ex.length === 0, `${why}: no mutually exclusive positions (${ex.slice(0, 3).join(' | ')})`);
  const vmax = Math.max(...cfg.agents.map((a) => a.free_speed_mm_s));
  for (const a of cfg.agents) { const v = checkTrajectory(passageOf(cfg.geometry, a.passage), r.intervals[a.id], vmax); ok(v.length === 0, `${why}: ${a.id} trajectory continuous, |Δs| = v·Δt, no overspeed (${v.slice(0, 2)})`); }
};

const noSilentWait = (r: SimResult) => {
  const unresolvedIds = new Set(r.events.filter((e) => e.kind === 'unresolved').flatMap((e) => [e.agent, e.other]));
  return Object.entries(r.final).every(([id, f]) => ['arrived', 'blocked'].includes(f.mode) || (f.mode === 'unresolved' && unresolvedIds.has(id)) || !['follow', 'yield_wait', 'cross_wait'].includes(f.mode) || (() => {
    // a waiter at the horizon must be waiting for an ant that can still move
    const last = [...r.events].reverse().find((e) => (e.kind === 'follow_start' || e.kind === 'yield_start' || e.kind === 'cross_wait' || e.kind === 'obstruction') && e.agent === id);
    return !last?.other || !['arrived', 'blocked', 'unresolved'].includes(r.final[last.other].mode);
  })());
};
// ---- geometry helpers: usable width and narrow sections of the corridor
const cor = geo('narrow-corridor'), Pc = passageOf(cor, 'P-corridor');
ok(near(usableWidth(cor, Pc, 50), 1.0) && near(usableWidth(cor, Pc, 5), 20), 'usable width: 1.0 mm between the walls, 20 mm in the open');
{ const s = narrowSections(cor, Pc, 2 * wHi); ok(s.length === 1 && near(s[0][0], 20 - Math.sqrt(wHi * wHi - 0.25), 1e-9) && near(s[0][1], 80 + Math.sqrt(wHi * wHi - 0.25), 1e-9), `single-file section for two ${wHi} mm ants: [${s[0]}] (exact boundary from the wall corners)`); }
ok(narrowSections(cor, Pc, 2 * wLo).length === 0, `two ${wLo} mm ants fit abreast everywhere (sensitivity)`);

// ---- 1. single-file head-on: contact, obstruction, one backs out, waits, both arrive later than alone; replay
const solo = (id: string, s: number, d: 1 | -1, goal: number, v: number) => arrival(run(cor, [ant(id, 'P-corridor', s, d, goal, v)]).res, id)!;
{
  const agents = [ant('W1', 'P-corridor', 2, 1, 98, vOut), ant('W2', 'P-corridor', 98, -1, 2, vRet)];
  const { cfg, res } = run(cor, agents);
  consistent(cfg, res, 'head-on');
  const c = kinds(res, 'contact_start')[0], o = kinds(res, 'obstruction')[0], y = kinds(res, 'yield_start')[0];
  ok(c && o && y && c.t_s < o.t_s + 1e-12 && c.certain === true, 'contact (certain in single file) comes no later than the obstruction');
  ok(y.agent === 'W2' && /shorter way back/.test(y.detail!), `W2 backs out (shorter way back): ${y.detail}`);
  ok(kinds(res, 'follow_start').some((e) => e.agent === 'W1' && e.other === 'W2'), 'the faster W1 cannot pass the backing-out W2 in single file: it follows');
  ok(kinds(res, 'yield_hold').length === 1 && kinds(res, 'yield_resume').length === 1, 'W2 waits outside the narrow section, then resumes');
  const a1 = arrival(res, 'W1')!, a2 = arrival(res, 'W2')!, f1 = solo('W1', 2, 1, 98, vOut), f2 = solo('W2', 98, -1, 2, vRet);
  ok(near(f1, 96 / vOut) && near(f2, 96 / vRet), 'alone: arrival = distance / speed');
  ok(a1 > f1 + 1e-6 && a2 > f2 + 1 && a2 - f2 > a1 - f1, `meeting delays both, the yielder more: W1 +${(a1 - f1).toFixed(3)} s, W2 +${(a2 - f2).toFixed(3)} s`);
  const w1 = res.intervals.W1.filter((r) => r.kind === 'move' && r.cause === 'follow');
  ok(w1.length > 0 && w1.every((r) => near(r.speed_mm_s, vRet)), 'while following, W1 walks exactly at the backing-out W2’s speed (mm/s; physical, not a factor)');
  const w2wait = res.intervals.W2.filter((r) => r.kind === 'wait' && r.cause === 'yield').reduce((x, r) => x + r.t_end_s - r.t_start_s, 0);
  ok(w2wait > 0, `W2 waited ${w2wait.toFixed(3)} s`);
  ok(JSON.stringify(simulate(cfg)) === JSON.stringify(res), 'replay: identical result');
  ok(JSON.stringify(simulate({ ...cfg, agents: [...agents].reverse() })) === JSON.stringify(res), 'array-order invariance: reversed input, identical result');
  // the broadphase window only changes where floating-point steps fall: same events, same order, times equal to 1e-9 s
  const sig = (r: SimResult) => r.events.map((e) => `${e.kind}|${e.agent}|${e.other}`).join(',');
  for (const H of [0.001, 0.05, 0.5, 7, 60]) { const r = simulate({ ...cfg, window_s: H }); ok(sig(r) === sig(res) && r.events.every((e, i) => Math.abs(e.t_s - res.events[i].t_s) < 1e-9 && Math.abs(e.s_mm - res.events[i].s_mm) < 1e-8), `broadphase window ${H} s: same events (times within 1e-9 s)`); }
}
// ---- 2. control: same ants, no walls (obstacle removed) → no obstruction, contact only possible, arrivals as alone
{
  const open = structuredClone(cor); open.obstacles = []; open.world_id = 'synthetic-corridor-control';
  const { cfg, res } = run(open, [ant('W1', 'P-corridor', 2, 1, 98, vOut), ant('W2', 'P-corridor', 98, -1, 2, vRet)]);
  consistent(cfg, res, 'control');
  ok(kinds(res, 'obstruction').length === 0 && kinds(res, 'yield_start').length === 0, 'control: no obstruction without the walls');
  ok(kinds(res, 'contact_start').length === 1 && kinds(res, 'contact_start')[0].certain === false, 'control: contact is possible but not certain on a 20 mm lane (lateral position not modelled)');
  ok(near(arrival(res, 'W1')!, 96 / vOut) && near(arrival(res, 'W2')!, 96 / vRet), 'control: arrivals equal walking alone (a contact by itself changes nothing)');
}
// ---- 3. sensitivity: at the low width candidate two ants pass abreast even between the walls
{
  const a = [ant('W1', 'P-corridor', 2, 1, 98, vOut, { body: body(wLo) }), ant('W2', 'P-corridor', 98, -1, 2, vRet, { body: body(wLo) })];
  const { cfg, res } = run(cor, a);
  consistent(cfg, res, 'low width');
  ok(kinds(res, 'obstruction').length === 0 && near(arrival(res, 'W2')!, 96 / vRet), `width ${wLo} mm: no obstruction (result depends on the unknown width; reported, not resolved)`);
}
// ---- 4. same direction in single file: a faster ant behind a slower one cannot pass; it arrives right behind
{
  const { cfg, res } = run(cor, [ant('Slow', 'P-corridor', 30, 1, 98, vRet), ant('Fast', 'P-corridor', 22, 1, 95.5, vOut)]);
  consistent(cfg, res, 'overtake');
  ok(kinds(res, 'follow_start').some((e) => e.agent === 'Fast'), 'the faster ant follows inside the narrow section');
  ok(kinds(res, 'follow_end').some((e) => e.agent === 'Fast' && /wide/.test(e.detail!)), 'following ends where the passage is wide enough to pass');
}
// ---- 5. no tunnelling at any speed or window: a very fast ant still meets the other
{
  for (const v of [100, 1e4, 1e6]) for (const H of [0.01, 100]) {
    const { cfg, res } = run(cor, [ant('A', 'P-corridor', 2, 1, 98, v), ant('B', 'P-corridor', 50, 1, 98, 0.001)], { window_s: H, horizon_s: 5 });
    ok(kinds(res, 'follow_start').length === 1 && checkExclusion(cfg, res, 0.001).length === 0, `speed ${v} mm/s, window ${H} s: A does not pass through B`);
  }
}
// ---- 6. body / load size vs a narrow entrance; a big load cannot pass the nest entrance
{
  const ne = geo('nest-entrance'), Pe = passageOf(ne, 'P-entry');
  const objs: PhysObject[] = [{ id: 'prey-1', width_mm: 3.0, holder: 'W1' }];
  const { cfg, res } = run(ne, [ant('W1', 'P-entry', 2, 1, 100, vRet, { load: 'prey-1' })], { objects: objs });
  const b = kinds(res, 'blocked')[0];
  ok(b && /aperture/.test(b.detail!) && near(res.final.W1.s_mm, 100 - L / 2) && arrival(res, 'W1') === null, `3 mm prey stops at the entrance: front at s=100 (${b?.detail})`);
  consistent(cfg, res, 'entrance');
  ok(arrival(run(ne, [ant('W1', 'P-entry', 2, 1, 100, vRet)]).res, 'W1') !== null, 'the same worker without the load enters');
  const [mLo, mHi] = bodyC.castes.major.effective_collision_width_mm.candidate_range as [number, number];
  ok(arrival(run(ne, [ant('M', 'P-entry', 2, 1, 100, vRet, { body: { length_mm: 3.5, width_mm: mLo, contact_reach_mm: reach } })]).res, 'M') !== null && kinds(run(ne, [ant('M', 'P-entry', 2, 1, 100, vRet, { body: { length_mm: 3.5, width_mm: mHi, contact_reach_mm: reach } })]).res, 'blocked').length === 1, `a major passes the 1.6 mm aperture at width ${mLo}, not at ${mHi} (sensitivity)`);
  ok(Pe.id === 'P-entry', 'entrance passage');
  // a major is stopped by the 1.0 mm corridor walls before entering
  const maj = run(cor, [ant('M', 'P-corridor', 2, 1, 98, vOut, { body: { length_mm: 3.5, width_mm: mLo, contact_reach_mm: reach } })]);
  ok(kinds(maj.res, 'blocked').length === 1 && maj.res.final.M.s_mm < 20 && checkExclusion(maj.cfg, maj.res, 0.01).length === 0, 'a major does not pass through the walls');
}
// ---- 7. no double carrying; objects are never created
{
  const objs: PhysObject[] = [{ id: 'o1', width_mm: 0.5, holder: null }];
  const held = pickUp(objs, 'o1', 'A');
  ok(held[0].holder === 'A' && objs[0].holder === null, 'pickUp is pure and records the holder');
  assert.throws(() => pickUp(held, 'o1', 'B'), /double carrying/); checks++;
  assert.throws(() => pickUp(held, 'nope', 'B'), /never created/); checks++;
  ok(drop(held, 'o1', 'A')[0].holder === null, 'drop releases');
  assert.throws(() => drop(held, 'o1', 'B'), /does not hold/); checks++;
  assert.throws(() => simulate({ geometry: cor, horizon_s: 1, seed: 1, objects: [{ id: 'o1', width_mm: 0.5, holder: 'A' }], agents: [ant('A', 'P-corridor', 2, 1, 10, 10, { load: 'o1' }), ant('B', 'P-corridor', 12, 1, 20, 10, { load: 'o1' })] }), /double carrying/); checks++;
  assert.throws(() => simulate({ geometry: cor, horizon_s: 1, seed: 1, objects: [], agents: [ant('A', 'P-corridor', 2, 1, 10, 10, { load: 'ghost' })] }), /unknown object/); checks++;
}
// ---- 8. same node ≠ contact: two ants both pass the crossing point, 5 s apart → no contact; at the same time → contact
{
  const cr = geo('crossing');
  const [ew, ns] = [passageOf(cr, 'P-east-west'), passageOf(cr, 'P-north-south')];
  const sx = (p: typeof ew) => p.centerline_mm[0], cross = 250;
  ok(sx(ew)[0] === 0 && sx(ns)[1] === -250, 'crossing geometry as expected');
  const apart = run(cr, [ant('E', 'P-east-west', 0, 1, 500, 10), ant('N', 'P-north-south', 0, 1, 500, 10, { start_t_s: 5 })]);
  ok(kinds(apart.res, 'contact_start').length === 0 && near(arrival(apart.res, 'E')!, 50) && near(arrival(apart.res, 'N')!, 55), 'same crossing node 5 s apart: no contact, no delay');
  const same = run(cr, [ant('E', 'P-east-west', 0, 1, 500, 10), ant('N', 'P-north-south', 0, 1, 500, 10)]);
  consistent(same.cfg, same.res, 'crossing');
  ok(kinds(same.res, 'contact_start').length === 1 && kinds(same.res, 'yield_start').length === 1, 'same time: contact, then one gives way');
  const wy = kinds(same.res, 'yield_start')[0];
  ok(/tie broken by named stream/.test(wy.detail!) && /clear of the other ant’s path/.test(wy.detail!), `exactly symmetric approach: the tie is broken by the named stream; the yielder backs out of the other's path (${wy.detail})`);
  const other = wy.agent === 'E' ? 'N' : 'E', dy = arrival(same.res, wy.agent)! - 50, dO = arrival(same.res, other)! - 50;
  ok(dO > 0 && dy > dO, `both are delayed, the one that gave way more (${wy.agent} +${dy.toFixed(3)} s, ${other} +${dO.toFixed(3)} s)`);
  ok(JSON.stringify(simulate({ ...same.cfg, agents: [...same.cfg.agents].reverse() })) === JSON.stringify(same.res), 'crossing: array-order invariance');
  const yielders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => kinds(simulate({ ...same.cfg, seed }), 'yield_start')[0].agent));
  ok(yielders.size === 2, `the tie-break depends on the seed, not on position in the list (${[...yielders]})`);
  ok(cross === 250, 'crossing point');
}
// ---- 9. unresolved configurations are reported, never overlapped
{
  const { cfg, res } = run(cor, [ant('A', 'P-corridor', 30, 1, 98, vOut), ant('B', 'P-corridor', 70, -1, 2, vRet), ant('C', 'P-corridor', 73, -1, 2, vRet)]);
  consistent(cfg, res, 'three in single file');
  ok(kinds(res, 'unresolved').length >= 1 || kinds(res, 'yield_start').length >= 1, `three ants: resolved by backing out or reported unresolved (${res.events.filter((e) => /yield|unresolved/.test(e.kind)).map((e) => `${e.kind}:${e.agent}`).join(',')})`);
}
// ---- 9b. two-way traffic of 8 ants in the single-file corridor, 12 seeds: never an overlap, never a jump; jams this
// version cannot untangle (no chain back-out) are reported as `unresolved`, not hidden
{
  const tally: Record<string, number> = {};
  for (let seed = 1; seed <= 12; seed++) {
    const g = rng(seed), agents: SimAgentSpec[] = [];
    for (let k = 0; k < 8; k++) { const d = (k % 2 ? -1 : 1) as 1 | -1; agents.push(ant(`A${k}`, 'P-corridor', d > 0 ? 2 + Math.floor(k / 2) * 3 : 98 - Math.floor(k / 2) * 3, d, d > 0 ? 98 : 2, 15 + g() * 4, { start_t_s: g() * 8 })); }
    const cfg: SimConfig = { geometry: cor, agents, horizon_s: 120, seed }, res = simulate(cfg);
    ok(checkExclusion(cfg, res, 0.005).length === 0, `traffic seed ${seed}: no mutually exclusive positions`);
    for (const a of agents) ok(checkTrajectory(Pc, res.intervals[a.id], 19).length === 0, `traffic seed ${seed}: ${a.id} trajectory consistent`);
    for (const f of Object.values(res.final)) tally[f.mode] = (tally[f.mode] ?? 0) + 1;
    ok(res.events.filter((e) => e.kind === 'unresolved').every((e) => typeof e.detail === 'string' && e.other !== null), `traffic seed ${seed}: every unresolved jam names the ants and the reason`);
    ok(noSilentWait(res), `traffic seed ${seed}: no ant ends waiting for an ant that has stopped for good (silent deadlock)`);
  }
  console.error(`two-way single-file traffic, 12 seeds × 8 ants, final states: ${JSON.stringify(tally)}`);
  ok((tally.arrived ?? 0) + (tally.unresolved ?? 0) + (tally.blocked ?? 0) === 96, `traffic: every ant either arrives or is reported (${JSON.stringify(tally)})`);
}
// ---- 9c. independent review of #73: regressions for every reproducer
{
  const cr = geo('crossing');
  // P1-1: discs starting exactly one body length apart, E walking at N (standing until t=100): E must stop, not pass through
  for (const s0 of [247.5, 247.5 - 5e-10]) {
    const r1 = run(cr, [ant('E', 'P-east-west', s0, 1, 500, 10), ant('N', 'P-north-south', 250, 1, 250.0000001, 10, { start_t_s: 100 })], { horizon_s: 3 });
    ok(checkExclusion(r1.cfg, r1.res, 0.01).length === 0 && r1.res.events.some((e) => e.kind === 'cross_wait' && e.agent === 'E'), `touching start (E at ${s0}): E stops instead of walking through N`);
  }
  // P1-2: an ant that has arrived on the crossing is never brought back to life; the passer is reported
  const r2 = run(cr, [ant('E', 'P-east-west', 200, 1, 250, 10), ant('N', 'P-north-south', 200, 1, 500, 10, { start_t_s: 3 })], { horizon_s: 30 });
  ok(r2.res.final.E.mode === 'arrived' && r2.res.final.N.mode === 'unresolved' && checkExclusion(r2.cfg, r2.res, 0.01).length === 0, `arrived ant stays arrived; the blocked passer is reported (${JSON.stringify(r2.res.final)})`);
  // M6: a 1.2 mm major starting with its front exactly at the wall section is stopped there
  const s6 = narrowSections(cor, Pc, 1.2)[0][0];
  const r6 = run(cor, [ant('M', 'P-corridor', s6 - 1.25, 1, 98, 10, { body: { length_mm: 2.5, width_mm: 1.2, contact_reach_mm: 1 } })], { horizon_s: 3 });
  ok(r6.res.final.M.mode === 'blocked' && checkExclusion(r6.cfg, r6.res, 0.01).length === 0, 'front exactly at a too-narrow section: blocked at once (no walking through walls)');
  // M2: two ants abreast at t=0 with A's front exactly at the single-file boundary: A waits, no squeeze
  const b2 = narrowSections(cor, Pc, 2 * wHi)[0][0];
  const r7 = run(cor, [ant('A', 'P-corridor', b2 - 1.25, 1, 98, 10), ant('B', 'P-corridor', b2 - 0.5, 1, 98, 10, { start_t_s: 5 })], { horizon_s: 3 });
  ok(checkExclusion(r7.cfg, r7.res, 0.01).length === 0 && r7.res.events.some((e) => e.kind === 'obstruction' && e.agent === 'A'), 'abreast at the boundary at t=0: the one entering waits');
  // a second pinch right behind the back-out point: no silent deadlock
  const dp = structuredClone(cor) as Any; dp.world_id = 'synthetic-double-pinch';
  dp.obstacles = [
    { id: 'O-n', kind: 'wall', shape: { type: 'polygon', points_mm: [[40, 0.5], [60, 0.5], [60, 10], [40, 10]] }, base_z_mm: 0, height_mm: 10, provenance: cor.obstacles[0].provenance },
    { id: 'O-s', kind: 'wall', shape: { type: 'polygon', points_mm: [[40, -0.5], [40, -10], [60, -10], [60, -0.5]] }, base_z_mm: 0, height_mm: 10, provenance: cor.obstacles[0].provenance },
    { id: 'O-c1', kind: 'stone', shape: { type: 'circle', center_mm: [37, 0.8], radius_mm: 0.3 }, base_z_mm: 0, height_mm: 10, provenance: cor.obstacles[0].provenance },
    { id: 'O-c2', kind: 'stone', shape: { type: 'circle', center_mm: [37, -0.8], radius_mm: 0.3 }, base_z_mm: 0, height_mm: 10, provenance: cor.obstacles[0].provenance },
  ];
  for (const [s1, s2] of [[30, 59], [33, 70], [25, 62], [35, 90]]) {
    const r8 = run(dp, [ant('W1', 'P-corridor', s1, 1, 98, vOut), ant('W2', 'P-corridor', s2, -1, 2, vRet)], { horizon_s: 20 });
    ok(checkExclusion(r8.cfg, r8.res, 0.005).length === 0 && noSilentWait(r8.res) && Object.values(r8.res.final).every((f) => f.mode === 'arrived' || f.mode === 'unresolved'), `double pinch W1@${s1} W2@${s2}: no overlap, no silent wait (${JSON.stringify(Object.values(r8.res.final).map((f) => f.mode))})`);
  }
  // seeded generators from the review (random lanes at random angles; random pinches, loads, goals in narrow parts)
  const crossingCase = (seed: number): SimConfig => {
    const r = rng(seed * 7919), g = structuredClone(cr) as Any; g.world_id = 'synthetic-fuzz';
    g.surfaces[0].polygon_mm = [[-300, -300], [300, -300], [300, 300], [-300, 300]];
    const prov = cr.passages[0].provenance, nl = 2 + Math.floor(r() * 3), lanes: Any[] = [];
    for (let i = 0; i < nl; i++) {
      const a = r() * Math.PI, R = 60, off = (r() - 0.5) * 10, bend = r() < 0.5;
      const p0 = [Math.cos(a) * -R - Math.sin(a) * off, Math.sin(a) * -R + Math.cos(a) * off, 0], p2 = [Math.cos(a) * R - Math.sin(a) * off, Math.sin(a) * R + Math.cos(a) * off, 0];
      const mid = bend ? [(p0[0] + p2[0]) / 2 + (r() - 0.5) * 20, (p0[1] + p2[1]) / 2 + (r() - 0.5) * 20, 0] : null;
      lanes.push({ id: `P${i}`, centerline_mm: mid ? [p0, mid, p2] : [p0, p2], width_mm: 20, route_edge_ref: null, provenance: prov });
    }
    g.passages = lanes;
    const na = 2 + Math.floor(r() * 5), agents: SimAgentSpec[] = [];
    for (let k = 0; k < na; k++) {
      const lane = lanes[k % nl], Lp = laneLength(lane), d = (r() < 0.5 ? 1 : -1) as 1 | -1;
      const s = d > 0 ? 5 + r() * 30 + Math.floor(k / nl) * 6 : Lp - 5 - r() * 30 - Math.floor(k / nl) * 6, Lb = 1.5 + r() * 2.5;
      agents.push(ant(`a${k}`, lane.id, s, d, d > 0 ? Lp - 1 : 1, 5 + r() * 20, { start_t_s: r() * 3, body: { length_mm: Lb, width_mm: 0.5 + r() * 0.4, contact_reach_mm: r() } }));
    }
    return { geometry: g, agents, horizon_s: 20, seed, window_s: [0.05, 1, 7][seed % 3] };
  };
  const laneCase = (seed: number): SimConfig => {
    const r = rng(seed * 104729), g = structuredClone(cor) as Any; g.world_id = 'synthetic-fuzz2';
    const prov = cor.obstacles[0].provenance, bend = r() < 0.5;
    g.passages[0].centerline_mm = bend ? [[0, 0, 0], [50, 0, 0], [100, 8, 0]] : [[0, 0, 0], [100, 0, 0]];
    const P = g.passages[0], obs: Any[] = [], np = 3 + Math.floor(r() * 6);
    for (let i = 0; i < np; i++) {
      const x = 10 + r() * 80, q = positionAt(P, x), rad = 0.2 + r() * 2, half = 0.45 + r() * 0.5;
      obs.push({ id: `c${i}n`, kind: 'stone', shape: { type: 'circle', center_mm: [q.x, q.y + half + rad], radius_mm: rad }, base_z_mm: 0, height_mm: 5, provenance: prov });
      if (r() < 0.6) obs.push({ id: `c${i}s`, kind: 'stone', shape: { type: 'circle', center_mm: [q.x + (r() - 0.5), q.y - half - rad], radius_mm: rad }, base_z_mm: 0, height_mm: 5, provenance: prov });
    }
    g.obstacles = obs;
    const Lp = laneLength(P), na = 4 + Math.floor(r() * 6), agents: SimAgentSpec[] = [], objects: PhysObject[] = [];
    for (let k = 0; k < na; k++) {
      const d = (r() < 0.5 ? 1 : -1) as 1 | -1, Lb = 1.5 + r() * 2.5, s = d > 0 ? 2 + r() * 90 : Lp - 2 - r() * 90;
      const goal = r() < 0.3 ? (d > 0 ? s + 5 + r() * (Lp - 2 - s - 5) : s - 5 - r() * (s - 7)) : (d > 0 ? Lp - 2 : 2);
      let load: string | null = null; if (r() < 0.2) { load = `o${k}`; objects.push({ id: load, width_mm: 0.5 + r() * 0.6, holder: `a${k}` }); }
      agents.push(ant(`a${k}`, P.id, s, d, Math.max(0, Math.min(Lp, goal)), 5 + r() * 20, { start_t_s: r() * 4, load, body: { length_mm: Lb, width_mm: 0.4 + r() * 0.5, contact_reach_mm: r() } }));
    }
    return { geometry: g, agents, objects, horizon_s: 25, seed, window_s: [0.05, 1, 7][seed % 3] };
  };
  const fuzzRun = (cfg: SimConfig, label: string) => {
    let res: SimResult;
    try { res = simulate(cfg); } catch (e) { if (/same space|narrower than its width|inconsistent/.test(String(e))) return; throw e; }
    ok(checkExclusion(cfg, res, 0.005).length === 0, `${label}: no mutually exclusive positions`);
    ok(cfg.agents.every((a) => checkTrajectory(cfg.geometry, res.intervals[a.id], Math.max(...cfg.agents.map((x) => x.free_speed_mm_s))).length === 0), `${label}: trajectories consistent`);
    ok(JSON.stringify(simulate({ ...cfg, agents: [...cfg.agents].reverse() })) === JSON.stringify(res), `${label}: input order invariant`);
    ok(noSilentWait(res), `${label}: no silent wait`);
  };
  for (const seed of [152, 1301, 1585, 1750, 1001, 1002, 1003, 1004]) fuzzRun(crossingCase(seed), `crossing fuzz seed ${seed}`);
  for (const seed of [5167, 1, 2, 3, 4, 5, 6, 7]) fuzzRun(laneCase(seed), `lane fuzz seed ${seed}`);
  // broadphase window does not change crossing events
  const wc = run(cr, [ant('E', 'P-east-west', 0, 1, 500, 10), ant('N', 'P-north-south', 0, 1, 500, 10)]);
  const sigc = (r: SimResult) => r.events.map((e) => `${e.kind}|${e.agent}|${e.other}`).join(',');
  for (const H of [0.05, 7]) { const r = simulate({ ...wc.cfg, window_s: H }); ok(sigc(r) === sigc(wc.res) && r.events.every((e, i) => Math.abs(e.t_s - wc.res.events[i].t_s) < 1e-9), `crossing: window ${H} s gives the same events`); }
}
// ---- 10. no food, no organisms: the result holds only motion; the agent set is unchanged
{
  const { res } = run(cor, [ant('W1', 'P-corridor', 2, 1, 98, vOut), ant('W2', 'P-corridor', 98, -1, 2, vRet)]);
  const keys = new Set<string>(); const walkK = (o: Any) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { keys.add(k); walkK(v); } }; walkK(res);
  ok(![...keys].some((k) => /food|crop|sugar|protein|brood|egg|larva|nutrition|energy/i.test(k)), 'no food or nutrition fields anywhere in the result');
  ok(Object.keys(res.final).sort().join() === 'W1,W2' && Object.keys(res.intervals).sort().join() === 'W1,W2', 'no organisms created or removed');
  ok(res.events.every((e) => e.model_ref.startsWith('PH-2')), 'every event carries its model reference');
}
// ---- 11. invalid input is refused
assert.throws(() => simulate({ geometry: cor, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 50, 1, 60, 10), ant('B', 'P-corridor', 51, 1, 60, 10)] }), /same space/); checks++;
assert.throws(() => simulate({ geometry: cor, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 50, 1, 60, 10, { body: { length_mm: 2.5, width_mm: 1.2, contact_reach_mm: 1 } })] }), /narrower than its width/); checks++;
{ const u = structuredClone(cor) as Any; u.passages[0].width_mm = null; assert.throws(() => simulate({ geometry: u, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 2, 1, 60, 10)] }), /unknown geometry/); checks++; }

// ---- 12. broadphase: uniform grid gives exactly the brute-force pairs; and it is faster at scale
{
  const g = rng(42);
  for (const n of [50, 500, 2000]) {
    const items: ReachDisc[] = Array.from({ length: n }, (_, i) => ({ id: `A${String(i).padStart(5, '0')}`, x: g() * 2000, y: g() * 2000, r: 1 + g() * 4 }));
    const t0 = performance.now(), gp = gridPairs(items, 10), t1 = performance.now(), bp = bruteForcePairs(items), t2 = performance.now();
    ok(JSON.stringify(gp) === JSON.stringify(bp), `n=${n}: grid pairs = brute force (${gp.length} pairs; grid ${(t1 - t0).toFixed(1)} ms, brute ${(t2 - t1).toFixed(1)} ms)`);
    ok(JSON.stringify(gridPairs([...items].reverse(), 10)) === JSON.stringify(gp) && JSON.stringify(gridPairs(items, 37)) === JSON.stringify(gp), `n=${n}: independent of input order and cell size`);
  }
}
// ---- 13. performance: 1,000 ants on a lattice of 40 lanes with 400 crossings, 3 s of motion
{
  const N = 20, span = 1000, prov = cor.passages[0].provenance, lanes: Any[] = [];
  for (let i = 0; i < N; i++) { const c = 25 + i * 50; lanes.push({ id: `H${i}`, centerline_mm: [[0, c, 0], [span, c, 0]], width_mm: 20, route_edge_ref: null, provenance: prov }, { id: `V${i}`, centerline_mm: [[c, 0, 0], [c, span, 0]], width_mm: 20, route_edge_ref: null, provenance: prov }); }
  const lat = { ...structuredClone(cor), world_id: 'synthetic-lattice', obstacles: [], surfaces: [{ ...cor.surfaces[0], polygon_mm: [[-10, -10], [span + 10, -10], [span + 10, span + 10], [-10, span + 10]] }], passages: lanes } as PhysicsGeometry;
  const g = rng(7), agents: SimAgentSpec[] = [];
  for (let k = 0; k < 1000; k++) {
    // two slots between each pair of crossings (8 mm either side of the midpoint): never on a crossing at the start
    const lane = lanes[k % lanes.length], slot = Math.floor(k / lanes.length), s = 50 + Math.floor(slot / 2) * 50 + (slot % 2 ? 8 : -8) + g(), d = (slot % 2 ? -1 : 1) as 1 | -1;
    agents.push(ant(`X${String(k).padStart(4, '0')}`, lane.id, s, d, d > 0 ? span : 0, 15 + g() * 4));
  }
  const t0 = performance.now(), res = simulate({ geometry: lat, agents, horizon_s: 3, seed: 3, window_s: 0.5 }), ms = performance.now() - t0;
  const nC = kinds(res, 'contact_start').length, nW = kinds(res, 'cross_wait').length;
  console.error(`performance: 1000 ants × 3 s on a 40-lane lattice: ${ms.toFixed(0)} ms, ${res.stats.steps} steps, ${res.stats.pair_evaluations} pair evaluations, ${nC} contacts, ${nW} crossing waits`);
  ok(ms < 60000 && res.stats.pair_evaluations < 1000 * 999 / 2 * res.stats.steps, `1000 ants run in ${ms.toFixed(0)} ms with the grid (pair evaluations ${res.stats.pair_evaluations} ≪ brute force ${(1000 * 999 / 2 * res.stats.steps).toExponential(1)})`);
}

console.log(JSON.stringify({ ph2_collision: 'pass', checks }, null, 2));
