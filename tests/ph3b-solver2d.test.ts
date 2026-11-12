/**
 * PH-3b (docs/physics-ph3b-solver2d.md): the isolated event-driven 2-D multi-agent solver engine/physics/solver2d.ts and
 * the broad phase engine/physics/broadphase.ts. The solver never grades itself: legality is checked by the solver-compare
 * judge (prototypes/solver-compare/lib/judge.ts) or, for bent lanes the judge does not accept, by an independent dense
 * check with body2d's exact capsuleInLane / capsuleGap. Body sizes come from the candidate files via the spec loader.
 * Counterexamples: geometry boundary, tangent contact, seams, bends, narrow mouths, several bodies touching at the same
 * instant, same-instant events permuted, layer separation, unknown size refusal, contact executed once, independence of
 * the broad-phase window / grid / method (event-driven: no time step).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { solve2D, pairFirstHit, Solver2DRefused, ACTIVE_TOL_MM, type Solver2DInput, type SolverAgent, type Solver2DResult, type Sample } from '../engine/physics/solver2d.ts';
import { bruteForcePairs, gridPairs2D, sweepAndPrunePairs, type AABB } from '../engine/physics/broadphase.ts';
import { capsuleGap, capsuleInLane, sweptCapsuleContact, lateralPacking, OCC_TOL_MM, type Capsule, type Lane2 } from '../engine/physics/body2d.ts';
import { loadScenario, ScenarioRefused, scenarioPath, type ScenarioFile } from '../prototypes/solver-compare/lib/spec.ts';
import { runPh3b } from '../prototypes/solver-compare/lib/ph3b.ts';
import { judge } from '../prototypes/solver-compare/lib/judge.ts';
import { rng } from '../engine/rng.ts';
import fs from 'node:fs';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const near = (a: number, b: number, tol: number, why: string) => ok(Math.abs(a - b) <= tol, `${why} (${a} vs ${b}, tol ${tol})`);
// body sizes ONLY from the candidate files (through the solver-compare loader): 2.5 mm (R94) and 0.8 mm (candidate upper bound)
const SC = loadScenario('head-on-2');
const BODY = { length_mm: SC.body.length_mm.value, width_mm: SC.body.width_mm.value };
const L = BODY.length_mm, w = BODY.width_mm, r = w / 2, hw = (L - w) / 2;
const hashRes = (res: Solver2DResult) => createHash('sha256').update(JSON.stringify({ a: res.agents, e: res.events })).digest('hex');
const ag = (id: string, lane: string, s: number, u: number, dir: 1 | -1, goal: number, v = 10, start = 0): SolverAgent => ({ id, lane, s_mm: s, u_mm: u, dir, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: v, body: BODY });
const straight = (id: string, W: number, len = 100, layer = 'z=0', y = 0) => ({ id, centerline_mm: [{ x: 0, y }, { x: len, y }], width_mm: W, layer });
const kinds = (res: Solver2DResult, k: string) => res.events.filter((e) => e.kind === k);

/** independent dense legality check (body2d only): every body in its lane region, no same-layer overlap, at dense
 *  times and at every sample (both headings at a joint), plus every joint rotation sampled over its angle */
function denseCheck(inp: Solver2DInput, res: Solver2DResult, dt = 0.002) {
  const lanes = new Map(inp.lanes.map((l) => [l.id, { id: l.id, centerline_mm: l.centerline_mm, width_mm: l.width_mm } as Lane2]));
  const layer = new Map(inp.lanes.map((l) => [l.id, l.layer]));
  const ids = Object.keys(res.agents).sort();
  const cap = (s: Sample): Capsule => { const cx = Math.cos(s[3]), cy = Math.sin(s[3]); return { a: { x: s[1] - cx * hw, y: s[2] - cy * hw }, b: { x: s[1] + cx * hw, y: s[2] + cy * hw }, r }; };
  const at = (S: Sample[], t: number): Sample[] => {
    if (t <= S[0][0]) return [S[0]];
    for (let i = 0; i < S.length - 1; i++) if (S[i + 1][0] >= t) { const p = S[i], q = S[i + 1]; if (q[0] === p[0]) continue; const f = (t - p[0]) / (q[0] - p[0]); return [[t, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f, f < 1 ? p[3] : q[3], 0, 0]]; }
    return [S[S.length - 1]];
  };
  const T = new Set<number>(); for (let k = 0; k * dt <= inp.horizon_s; k++) T.add(k * dt); for (const id of ids) for (const s of res.agents[id].samples) T.add(s[0]);
  let outside = 0, overlap = 0, rotOutside = 0, worst = 0;
  for (const t of [...T].sort((a, b) => a - b)) {
    const poses = ids.map((id) => { const S = res.agents[id].samples, same = S.filter((s) => s[0] === t); return same.length ? same : at(S, t); });
    poses.forEach((ps, i) => { for (const p of ps) { const c = capsuleInLane(lanes.get(res.agents[ids[i]].lane)!, cap(p)); if (c.checked && !c.inside) { outside++; } } });
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      if (layer.get(res.agents[ids[i]].lane) !== layer.get(res.agents[ids[j]].lane)) continue;
      for (const p of poses[i]) for (const q of poses[j]) { const g = capsuleGap(cap(p), cap(q)); if (g < -OCC_TOL_MM) { overlap++; worst = Math.max(worst, -g); } }
    }
  }
  // joint rotations: consecutive samples at the same time with different headings
  for (const id of ids) {
    const S = res.agents[id].samples;
    for (let i = 1; i < S.length; i++) if (S[i][0] === S[i - 1][0] && S[i][3] !== S[i - 1][3]) {
      let d = S[i][3] - S[i - 1][3]; while (d > Math.PI) d -= 2 * Math.PI; while (d <= -Math.PI) d += 2 * Math.PI;
      for (let k = 0; k <= 400; k++) { const p: Sample = [S[i][0], S[i][1], S[i][2], S[i - 1][3] + (d * k) / 400, 0, 0]; const c = capsuleInLane(lanes.get(res.agents[id].lane)!, cap(p)); if (c.checked && !c.inside) rotOutside++; }
    }
  }
  return { outside, overlap, rotOutside, worst };
}

// ---- 1. broad phase: grid (several cells) and sweep-and-prune give exactly the brute-force pair set
{
  const g = rng(7);
  for (let rep = 0; rep < 60; rep++) {
    const n = 2 + Math.floor(g() * 150), boxes: AABB[] = [], keys: number[] = [];
    for (let i = 0; i < n; i++) {
      // integer-ish coordinates so touching boxes (shared edges / corners) are frequent
      const x = Math.round(g() * 40) / 2, y = Math.round(g() * 40) / 2, wx = Math.round(g() * 8) / 2, wy = Math.round(g() * 8) / 2;
      boxes.push({ minX: x, minY: y, maxX: x + wx, maxY: y + wy }); keys.push(g() < 0.2 ? 1 : 0);
    }
    const ref = bruteForcePairs(boxes, keys).join(',');
    for (const cell of [0.5, 1, 2.5, 7, 100]) ok(gridPairs2D(boxes, keys, cell).join(',') === ref, `grid cell ${cell}: identical candidate set (rep ${rep}, n ${n})`);
    ok(sweepAndPrunePairs(boxes, keys).join(',') === ref, `sweep and prune: identical candidate set (rep ${rep})`);
  }
  const b: AABB[] = [{ minX: 0, minY: 0, maxX: 1, maxY: 1 }, { minX: 1, minY: 1, maxX: 2, maxY: 2 }, { minX: 2.000001, minY: 0, maxX: 3, maxY: 1 }];
  ok(bruteForcePairs(b, [0, 0, 0]).join() === '1' && gridPairs2D(b, [0, 0, 0], 1).join() === '1' && sweepAndPrunePairs(b, [0, 0, 0]).join() === '1', 'boxes touching at one corner are a pair (closed boxes); a 1e-6 mm gap is not');
  ok(bruteForcePairs(b, [0, 1, 0]).length === 0 && gridPairs2D(b, [0, 1, 0], 1).length === 0, 'different layers never pair');
}

// ---- 2. exact continuous contact: pairFirstHit agrees with the independent body2d.sweptCapsuleContact
{
  const g = rng(11); let compared = 0;
  for (let k = 0; k < 2000; k++) {
    const mk = (): Capsule => { const x = g() * 10, y = g() * 10, th = g() * 2 * Math.PI, h = g() * 1.5; return { a: { x: x - Math.cos(th) * h, y: y - Math.sin(th) * h }, b: { x: x + Math.cos(th) * h, y: y + Math.sin(th) * h }, r: 0.1 + g() * 0.5 }; };
    const P = mk(), Q = mk();
    if (capsuleGap(P, Q) <= 1e-6) continue;
    const vP = { x: (g() - 0.5) * 40, y: (g() - 0.5) * 40 }, vQ = { x: (g() - 0.5) * 40, y: (g() - 0.5) * 40 };
    const H = 2, mine = pairFirstHit(P, vP, Q, vQ), ref = sweptCapsuleContact(P, vP, Q, vQ, H, 1e-12);
    const mt = mine && mine.tau <= H ? mine.tau : null;
    if (mt === null) ok(ref === null || (() => { const at = (c: Capsule, v: { x: number; y: number }, t: number): Capsule => ({ a: { x: c.a.x + v.x * t, y: c.a.y + v.y * t }, b: { x: c.b.x + v.x * t, y: c.b.y + v.y * t }, r: c.r }); return capsuleGap(at(P, vP, ref), at(Q, vQ, ref)) > -1e-9; })(), `case ${k}: no hit ⇒ the reference finds none or only a graze`);
    else { ok(ref !== null && Math.abs(ref - mt) < 1e-9, `case ${k}: first contact time ${mt} = reference ${ref}`); compared++; }
  }
  ok(compared > 200, `${compared} contact times compared`);
  // head-on analytic: fronts 10 mm apart, closing at 30 mm/s → (10 − 0)/30 for the capsule tips
  const P: Capsule = { a: { x: -hw, y: 0 }, b: { x: hw, y: 0 }, r }, Q: Capsule = { a: { x: 10 + L - r - hw, y: 0 }, b: { x: 10 + L - r + hw, y: 0 }, r };
  near(pairFirstHit(P, { x: 20, y: 0 }, Q, { x: -10, y: 0 })!.tau, (Q.a.x - Q.r - (P.b.x + P.r)) / 30, 1e-12, 'head-on contact time = tip gap / closing speed');
  // tangent: parallel bodies passing at exactly touching distance never "hit"; 1e-9 mm closer they do
  const A: Capsule = { a: { x: 0, y: 0 }, b: { x: 1.7, y: 0 }, r }, B0: Capsule = { a: { x: 20, y: 2 * r }, b: { x: 21.7, y: 2 * r }, r };
  ok(pairFirstHit(A, { x: 10, y: 0 }, B0, { x: -10, y: 0 }) === null, 'tangent pass (gap exactly 0 while abreast): not a contact');
  const B1: Capsule = { a: { x: 20, y: 2 * r - 1e-9 }, b: { x: 21.7, y: 2 * r - 1e-9 }, r };
  ok(pairFirstHit(A, { x: 10, y: 0 }, B1, { x: -10, y: 0 }) !== null, '1e-9 mm closer: a contact');
}

// ---- 3. refusals: unknown sizes / widths are never invented
{
  const base: Solver2DInput = { lanes: [straight('P', 20)], obstacles: [], agents: [ag('A', 'P', 10, 0, 1, 90)], horizon_s: 5 };
  assert.throws(() => solve2D({ ...base, agents: [{ ...base.agents[0], body: { length_mm: L, width_mm: null } }] }), Solver2DRefused); checks++;
  assert.throws(() => solve2D({ ...base, agents: [{ ...base.agents[0], body: { length_mm: null, width_mm: w } }] }), Solver2DRefused); checks++;
  assert.throws(() => solve2D({ ...base, lanes: [{ ...base.lanes[0], width_mm: null }] }), Solver2DRefused); checks++;
  const f: ScenarioFile = JSON.parse(fs.readFileSync(scenarioPath('head-on-2'), 'utf8')); f.body.width = { ...f.body.width, path: 'castes.minor.effective_collision_width_mm.value' };
  assert.throws(() => loadScenario(f), ScenarioRefused); checks++;
  // three bodies abreast in 2.0 mm: no arrangement fits (lateralPacking) and the solver refuses the overlapping start
  const W3 = 2.0, us = [-0.6, 0, 0.6];
  ok(lateralPacking(us.map(() => ({ s_mm: 10, ...BODY })), W3).feasible === false, 'P2-E: three 0.8 mm bodies abreast do not fit in 2.0 mm');
  assert.throws(() => solve2D({ ...base, lanes: [straight('P', W3)], agents: us.map((u, i) => ag(`A${i}`, 'P', 10, u, 1, 90)) }), Solver2DRefused); checks++;
  // geometry boundary at the start: |u| + w/2 = W/2 exactly is legal, 1e-6 mm more is refused
  solve2D({ ...base, lanes: [straight('P', 2)], agents: [ag('A', 'P', 10, 1 - r, 1, 90)] }); checks++;
  assert.throws(() => solve2D({ ...base, lanes: [straight('P', 2)], agents: [ag('A', 'P', 10, 1 - r + 1e-6, 1, 90)] }), Solver2DRefused); checks++;
  // an offset body cannot follow a bend (lateral steering unknown): refused, not invented
  const bend = { id: 'B', centerline_mm: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }], width_mm: 6, layer: 'z=0' };
  assert.throws(() => solve2D({ ...base, lanes: [bend], agents: [ag('A', 'B', 5, 0.5, 1, 35)] }), /lateral steering/); checks++;
  solve2D({ ...base, lanes: [bend], agents: [ag('A', 'B', 5, 0.5, 1, 15)] }); checks++;   // goal before the joint: allowed
}

// ---- 4. a single body arrives at distance / speed (no time step)
{
  const res = solve2D({ lanes: [straight('P', 4)], obstacles: [], agents: [ag('A', 'P', 3, 0.7, 1, 97, 17, 0.25)], horizon_s: 10 });
  near(res.agents.A.arrival_t_s!, 0.25 + 94 / 17, 1e-12, 'solo arrival = start + distance / speed');
  ok(res.agents.A.samples.every((s) => s[5] === 0.7), 'lateral offset u stays as given');
}

// ---- 5. head-on in the 1.0 mm narrow passage (solver-compare head-on-2), judged by the common judge
{
  const sc = loadScenario('head-on-2'), run = runPh3b(sc), j = judge(sc, run.tr, { occupancy2d: true, dense_dt_s: 0.002 });
  const a = sc.agents, tc = (a[1].s_mm - a[0].s_mm - L) / (a[0].free_speed_mm_s + a[1].free_speed_mm_s);
  const cs = kinds(run.res, 'contact_start');
  // contact = gap ≤ θ (docs/physics-time-contract.md §3): it starts θ/(closing speed) before the touch; the bodies stop at the touch
  const tθ = tc - ACTIVE_TOL_MM / (a[0].free_speed_mm_s + a[1].free_speed_mm_s);
  ok(cs.length === 1 && Math.abs(cs[0].t_s - tθ) < 1e-12, `one contact, starting at the analytic θ crossing ${tθ} (touch ${tc})`);
  ok(kinds(run.res, 'stop').every((e) => Math.abs(e.t_s - tc) < 1e-12), 'both stop at the analytic touch');
  ok(kinds(run.res, 'stop').length === 2 && run.res.stats.stalled === 2, 'both stop (head-on: neither can advance without penetrating) and stay stalled: no yielding is decided by the solver');
  ok(j.overlap_pair_instants === 0 && j.overlap_between_instants === 0 && j.out_of_walkable_agent_instants === 0 && j.obstacle_violation_agent_instants === 0 && j.occupancy2d!.overlap === 0 && j.occupancy2d!.outside_lane === 0, 'common judge: no overlap at or between instants, no wall or lane violation');
  ok(run.res.events.every((e) => (e.class as string) !== 'behavioural_response'), 'no behavioural events at all');
  ok(lateralPacking([{ s_mm: 50, ...BODY }, { s_mm: 50, ...BODY }], 1.0).feasible === false, 'the stall is forced by the geometry: two bodies abreast do not fit in 1.0 mm');
}

// ---- 6. passing only where the geometry allows it with the given u
{
  // u is measured to the left of the lane's +s direction (body2d convention), so +u and −u are opposite sides
  const run = (u: number, W = 1.8) => solve2D({ lanes: [straight('P', W)], obstacles: [], agents: [ag('A', 'P', 5, u, 1, 95, 10), ag('B', 'P', 95, -u, -1, 5, 10)], horizon_s: 12 });
  const pass = run(0.45);
  ok(pass.agents.A.arrival_t_s !== null && pass.agents.B.arrival_t_s !== null && kinds(pass, 'contact_start').length === 0, 'u = ±0.45 in 1.8 mm: they pass (0.1 mm apart), no contact');
  near(kinds(pass, 'pass')[0].t_s, 4.5, 1e-12, 'pass event at the analytic time');
  near(pass.agents.A.arrival_t_s!, 9, 1e-12, 'arrival unaffected by the pass');
  const tangent = run(r);
  ok(tangent.agents.A.arrival_t_s !== null && kinds(tangent, 'stop').length === 0, 'tangent (u = ±w/2: gap exactly 0 abreast): no penetration, no stop');
  const blocked = run(r - 1e-9);
  ok(blocked.agents.A.arrival_t_s === null && kinds(blocked, 'stop').length === 2, 'u 1e-9 mm closer: rounded fronts meet, both stop');
  ok(denseCheck({ lanes: [straight('P', 1.8)], obstacles: [], agents: [], horizon_s: 12 }, blocked).overlap === 0, 'independent dense check: no overlap');
}

// ---- 7. narrow mouth (polygon walls): an offset body stops exactly where its front first touches the wall corner
{
  const walls = [{ id: 'N', layer: 'z=0', kind: 'polygon' as const, points_mm: [{ x: 20, y: 0.5 }, { x: 80, y: 0.5 }, { x: 80, y: 10 }, { x: 20, y: 10 }] }, { id: 'S', layer: 'z=0', kind: 'polygon' as const, points_mm: [{ x: 20, y: -10 }, { x: 80, y: -10 }, { x: 80, y: -0.5 }, { x: 20, y: -0.5 }] }];
  const res = solve2D({ lanes: [straight('P', 20)], obstacles: walls, agents: [ag('C', 'P', 6, 0, 1, 98), ag('O', 'P', 2, 0.2, 1, 98, 10, 20)], horizon_s: 40 });
  ok(res.agents.C.arrival_t_s !== null, 'centred body passes the 1.0 mm mouth (0.1 mm each side)');
  const xf = 20 - Math.sqrt(r * r - 0.3 * 0.3);   // axis tip (y = 0.2) at distance r from the corner (20, 0.5)
  near(res.agents.O.geometry_stop_s_mm!, xf - hw, 1e-9, 'offset body (u = 0.2) stops where its rounded front touches the corner');
  ok(res.agents.O.final_mode === 'stopped_by_geometry', 'and stays there (no side-step)');
}

// ---- 8. same instant: four bodies meet at a crossing at the same time; order-independent
{
  const lanes = [{ id: 'EW', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 4, layer: 'z=0' }, { id: 'NS', centerline_mm: [{ x: 50, y: -50 }, { x: 50, y: 50 }], width_mm: 4, layer: 'z=0' }];
  const agents = [ag('E', 'EW', 30, 0, 1, 90), ag('W', 'EW', 70, 0, -1, 10), ag('N', 'NS', 30, 0, 1, 90), ag('S', 'NS', 70, 0, -1, 10)];
  const inp = { lanes, obstacles: [], agents, horizon_s: 5 }, res = solve2D(inp);
  const c = kinds(res, 'contact_start');
  ok(c.length >= 2 && c.every((e) => Math.abs(e.t_s - c[0].t_s) < 1e-9), `four symmetric bodies: contacts within 1e-9 s (${c.length} at ${c[0]?.t_s})`);
  ok(res.stats.stalled === 4, 'all four wait (no right of way is decided by the solver)');
  // guaranteed same instant: A and C start together, each already touching the stationary B
  const same: Solver2DInput = { lanes: [straight('P', 2)], obstacles: [], agents: [ag('A', 'P', 10, 0, 1, 90, 10, 1), ag('B', 'P', 10 + L, 0, 1, 90, 10, 50), ag('C', 'P', 10 + 2 * L, 0, -1, 2, 10, 1)], horizon_s: 3 };
  const rs = solve2D(same), cs = kinds(rs, 'contact_start');
  // the bodies touch from t = 0 (contact episodes start at 0); A and C start at t = 1 and both constraints act in one batch
  ok(cs.length === 2 && cs[0].t_s === 0 && cs[1].t_s === 0 && kinds(rs, 'stop').length === 2 && kinds(rs, 'stop').every((e) => e.t_s === 1) && rs.stats.batches === 1, 'two touching pairs (contacts from t = 0); both constraints act in the same instant (t = 1 s) in one batch: both stop');
  for (const perm of [[2, 1, 0], [1, 0, 2], [0, 2, 1]]) ok(hashRes(solve2D({ ...same, agents: perm.map((i) => same.agents[i]) })) === hashRes(rs), `same-instant events permuted ${perm}: identical`);
  const d = denseCheck(inp, res);
  ok(d.overlap === 0 && d.outside === 0, 'independent dense check: no overlap, inside lanes');
  const g = rng(3);
  for (let k = 0; k < 6; k++) { const perm = [...agents].sort(() => g() - 0.5); ok(hashRes(solve2D({ ...inp, agents: perm })) === hashRes(res), `permutation ${k}: identical result`); }
}

// ---- 9. layers (2.5D): bodies in different layers never collide; in the same layer they do
{
  const mk = (l2: string) => solve2D({ lanes: [straight('G', 2, 100, 'ground'), straight('U', 2, 100, l2)], obstacles: [], agents: [ag('A', 'G', 5, 0, 1, 95), ag('B', 'U', 95, 0, -1, 5)], horizon_s: 12 });
  const sep = mk('leaf'), same = mk('ground');
  ok(sep.agents.A.arrival_t_s === 9 && sep.agents.B.arrival_t_s === 9 && kinds(sep, 'contact_start').length === 0, 'different layers: pass through each other in plan, no contact');
  ok(same.agents.A.arrival_t_s === null && kinds(same, 'contact_start').length === 1, 'same layer: contact and stop');
  const obs = solve2D({ lanes: [straight('G', 4, 100, 'ground')], obstacles: [{ id: 'stone', layer: 'leaf', kind: 'circle', center_mm: { x: 50, y: 0 }, radius_mm: 1 }], agents: [ag('A', 'G', 5, 0, 1, 95)], horizon_s: 12 });
  ok(obs.agents.A.arrival_t_s !== null, 'an obstacle of another layer does not block');
}

// ---- 10. following keeps the leader's speed; a contact is executed exactly once
{
  const inp: Solver2DInput = { lanes: [straight('P', 2)], obstacles: [], agents: [ag('F', 'P', 2, 0, 1, 90, 18), ag('S', 'P', 10, 0, 1, 60, 12)], horizon_s: 12 };
  const res = solve2D(inp);
  const fol = kinds(res, 'follow')[0];
  ok(fol && /following S/.test(fol.detail ?? '') && /at 12 mm\/s/.test(fol.detail ?? ''), 'fast body behind a slow one follows at the leader speed');
  near(fol.t_s, (10 - 2 - L) / 6, 1e-12, 'catch-up time analytic');
  ok(kinds(res, 'stop').some((e) => e.agents[0] === 'F' && e.t_s === res.agents.S.arrival_t_s), 'when the leader arrives the follower stops at the same instant');
  const d = denseCheck(inp, res);
  ok(d.overlap === 0, 'follower never penetrates the leader');
  // contact episodes alternate start/end per pair, never two starts in a row
  for (const sc of ['corridor-8', 'crossing-traffic-100']) {
    const run = runPh3b(loadScenario(sc)), open = new Map<string, number>();
    let bad = 0;
    for (const e of run.res.events) { const k = e.agents.join('|'); if (e.kind === 'contact_start') { if (open.get(k)) bad++; open.set(k, 1); } else if (e.kind === 'contact_end') { if (!open.get(k)) bad++; open.set(k, 0); } }
    ok(bad === 0 && run.res.stats.unresolved === 0 && run.res.stats.aborted === null, `${sc}: every contact started once per episode (${run.res.stats.contacts} contacts), unresolved 0`);
  }
}

// ---- 11. bends: turning at the joint is legal or refused by the geometry; the stop is necessary
{
  const g = rng(19); let stops = 0, turns = 0;
  for (let k = 0; k < 40; k++) {
    const W = 0.85 + g() * 3, n = 2 + Math.floor(g() * 3), pts = [{ x: 0, y: 0 }]; let th = 0;
    for (let i = 0; i < n; i++) { const len = 4 + g() * 8; pts.push({ x: pts[i].x + Math.cos(th) * len, y: pts[i].y + Math.sin(th) * len }); th += (g() - 0.5) * 2.4; }
    let total = 0; for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    const inp: Solver2DInput = { lanes: [{ id: 'B', centerline_mm: pts, width_mm: W, layer: 'z=0' }], obstacles: [], agents: [ag('A', 'B', L / 2 + 0.01, 0, 1, total - L / 2 - 0.01)], horizon_s: 10 };
    let res: Solver2DResult;
    try { res = solve2D(inp); } catch (e) { ok(e instanceof Solver2DRefused, `bend ${k}: only a refusal may be thrown (${e})`); continue; }
    const d = denseCheck(inp, res, 0.001);
    ok(d.outside === 0 && d.rotOutside === 0, `bend ${k} (W ${W.toFixed(2)}): every pose and every turning angle inside the lane region (independent capsuleInLane)`);
    turns += res.stats.turns;
    if (res.agents.A.final_mode === 'stopped_by_geometry') {
      stops++;
      // necessity: just past the stop the body would leave the region, or the turn at that joint would
      const S = res.agents.A.samples, last = S[S.length - 1], lane: Lane2 = { id: 'B', centerline_mm: pts, width_mm: W };
      const cap = (x: number, y: number, h: number): Capsule => ({ a: { x: x - Math.cos(h) * hw, y: y - Math.sin(h) * hw }, b: { x: x + Math.cos(h) * hw, y: y + Math.sin(h) * hw }, r });
      const ahead = capsuleInLane(lane, cap(last[1] + Math.cos(last[3]) * 1e-4, last[2] + Math.sin(last[3]) * 1e-4, last[3]));
      const atJoint = /turn at the joint/.test(res.agents.A.stop_cause ?? '');
      let turnFails = false;
      if (atJoint) {
        const vi = pts.findIndex((p) => Math.hypot(p.x - last[1], p.y - last[2]) < 1e-9), nx = pts[vi + 1];
        const th2 = Math.atan2(nx.y - pts[vi].y, nx.x - pts[vi].x); let dth = th2 - last[3]; while (dth > Math.PI) dth -= 2 * Math.PI; while (dth <= -Math.PI) dth += 2 * Math.PI;
        for (let q = 0; q <= 4000 && !turnFails; q++) if (!capsuleInLane(lane, cap(last[1], last[2], last[3] + (dth * q) / 4000), 0).inside) turnFails = true;
      }
      ok(atJoint ? turnFails : !ahead.inside, `bend ${k}: the geometry stop is necessary (${atJoint ? 'some turning angle leaves the region' : '1e-4 mm further is outside'})`);
    }
  }
  ok(stops > 0 && turns > 0, `both outcomes exercised (${turns} turns, ${stops} geometry stops)`);
}

// ---- 12. seams: in a zig-zag lane whose bands touch, a body over the seam is inside and moves; with a gap it is refused
{
  const touch = { id: 'Z', centerline_mm: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 2 }, { x: 5, y: 2 }], width_mm: 2, layer: 'z=0' };
  const gap = { ...touch, centerline_mm: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 2.001 }, { x: 5, y: 2.001 }] };
  // on band 1 at u = 0.8: the body reaches y = 1.2, i.e. over the seam into band 3; moving towards −x it leaves band 3's
  // coverage at x = 5 (band 3 ends there), where band 1's own top edge begins: it must stop there, not before
  const inp: Solver2DInput = { lanes: [touch], obstacles: [], agents: [ag('A', 'Z', 16, 0.8, -1, 1.5)], horizon_s: 5 };
  const res = solve2D(inp);
  ok(res.agents.A.final_mode === 'stopped_by_geometry', `body over the seam is accepted and stops only where the seam ends (${res.agents.A.stop_cause})`);
  near(res.agents.A.geometry_stop_s_mm! - hw, 5 + Math.sqrt(r * r - 0.2 * 0.2), 1e-6, 'stop where its rounded end meets the exposed corner (5, 1)');
  ok(denseCheck(inp, res).outside === 0, 'independent check: inside the region the whole time');
  assert.throws(() => solve2D({ ...inp, lanes: [gap] }), Solver2DRefused); checks++;
}

// ---- 13. a turn blocked by another body waits at the joint and is retried when the blocker moves away
{
  const lanes = [{ id: 'T', centerline_mm: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }], width_mm: 6, layer: 'z=0' }, { id: 'M', centerline_mm: [{ x: 10.75 + hw - L / 2, y: 1.3 }, { x: 60, y: 1.3 }], width_mm: 1, layer: 'z=0' }];
  const inp: Solver2DInput = { lanes, obstacles: [], agents: [ag('T', 'T', 2, 0, 1, 25), ag('B', 'M', L / 2, 0, 1, 40, 10, 3)], horizon_s: 8 };
  const res = solve2D(inp);
  const tb = kinds(res, 'turn_blocked'), tu = kinds(res, 'turn');
  ok(tb.length === 1 && Math.abs(tb[0].t_s - 0.8) < 1e-12, 'turn blocked at the joint at 0.8 s (the swinging rear would penetrate B)');
  ok(tu.length === 1 && tu[0].t_s > 3 && res.agents.T.arrival_t_s !== null, `after B starts (3 s) and leaves the turning disc, T turns (${tu[0]?.t_s}) and arrives`);
  const d = denseCheck(inp, res, 0.001);
  ok(d.overlap === 0 && d.outside === 0, 'independent dense check: no overlap, inside lanes');
}

// ---- 14. independence of the broad-phase window, grid cell and method (no sampling step anywhere)
{
  for (const id of ['corridor-8', 'crossing-traffic-100']) {
    const sc = loadScenario(id), base = hashRes(runPh3b(sc).res);
    for (const o of [{ window_s: 0.01 }, { window_s: 1 }, { window_s: 25 }, { grid_cell_mm: 2 }, { grid_cell_mm: 60 }, { broadphase: 'sap' as const }, { broadphase: 'brute' as const }, { reverse_order: true }])
      ok(hashRes(runPh3b(sc, o).res) === base, `${id} ${JSON.stringify(o)}: bit-identical trajectories and events`);
  }
}

// ---- 15. common judge on the solver-compare scenarios: no overlap, no wall / obstacle / lane violation
{
  for (const id of ['corridor-8', 'stone', 'crossing', 'crossing-traffic-100']) {
    const sc = loadScenario(id), run = runPh3b(sc), j = judge(sc, run.tr, { occupancy2d: sc.agents.length <= 24 });
    ok(j.overlap_pair_instants === 0 && j.overlap_between_instants === 0 && j.out_of_walkable_agent_instants === 0 && j.obstacle_violation_agent_instants === 0 && (!j.occupancy2d || (j.occupancy2d.overlap === 0 && j.occupancy2d.outside_lane === 0)), `${id}: judge finds no violation (${j.instants} instants)`);
    ok(run.res.stats.unresolved === 0 && run.res.stats.aborted === null, `${id}: no unresolved event, not aborted`);
  }
  const st = runPh3b(loadScenario('stone'));
  near(st.res.agents.S1.geometry_stop_s_mm!, 250 - 15 - r - hw, 1e-9, 'stone: centred body stops with its front on the stone (analytic)');
}
ok(ACTIVE_TOL_MM < 1e-6, 'contact tolerance is numerical (≪ body size)');
console.log(JSON.stringify({ ph3b_solver2d: 'pass', checks }));
