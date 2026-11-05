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
import { type EncounterRules, type SimAgentSpec, type SimConfig, type SimResult, type PhysObject, type ReachDisc, simulate, checkExclusion, gridPairs, bruteForcePairs, pickUp, drop, narrowSections, usableWidth } from '../engine/physics/collision.ts';
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
// encounter rules from the candidates file; inside_turn_back_probability and contact_pause_s are null in the file
// (no study): tests that need a value take one of the file's candidate values explicitly
const E = inter.encounter;
const ENC: EncounterRules = { priority: E.priority.value, entry_yield_probability: E.entry_yield_probability.value, laden_yield_probability: E.laden_yield_probability.value, contact_pause_s: E.contact_pause_s.value, inside_turn_back_probability: E.inside_turn_back_probability.candidate_values[1] };
const body = (w = wHi) => ({ length_mm: L, width_mm: w, contact_reach_mm: reach });
const ant = (id: string, passage: string, s: number, d: 1 | -1, goal: number, v: number, extra: Partial<SimAgentSpec> = {}): SimAgentSpec => ({ id, passage, s_mm: s, dir: d, start_t_s: 0, free_speed_mm_s: v, goal_s_mm: goal, body: body(), load: null, ...extra });
const run = (g: PhysicsGeometry, agents: SimAgentSpec[], extra: Partial<SimConfig> = {}) => { const cfg: SimConfig = { encounter: ENC, geometry: g, agents, horizon_s: 60, seed: 1, ...extra }; return { cfg, res: simulate(cfg) }; };
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

// ---- 1. single-file head-on with both ants wholly inside the walls: no studied rule → each turns back with a per-contact
// probability (candidate 0.5); both lose the contact time (candidate 0.43 s, L. niger); one gives way; replay
const solo = (id: string, s: number, d: 1 | -1, goal: number, v: number) => arrival(run(cor, [ant(id, 'P-corridor', s, d, goal, v)]).res, id)!;
{
  const tau = E.contact_pause_s.candidate_values[1] as number;
  const agents = [ant('W1', 'P-corridor', 2, 1, 98, vOut), ant('W2', 'P-corridor', 98, -1, 2, vRet)];
  const { cfg, res } = run(cor, agents, { encounter: { ...ENC, contact_pause_s: tau } });
  consistent(cfg, res, 'head-on');
  const c = kinds(res, 'contact_start')[0], o = kinds(res, 'obstruction')[0], y = kinds(res, 'yield_start')[0];
  ok(c && o && y && c.t_s < o.t_s + 1e-12 && c.certain === true, 'contact (certain in single file) comes no later than the obstruction');
  ok(/both wholly inside/.test(y.detail!) && /game assumption/.test(y.detail!) && !/shorter way back/.test(y.detail!), `inside rule, labelled; the non-local 'shorter way back' rule is gone: ${y.detail}`);
  const rounds = Number(/decided at contact (\d+)/.exec(y.detail!)![1]);
  ok(new RegExp(`stand ${(tau * rounds).toFixed(3)} s`).test(y.detail!), `both stand ${rounds} × ${tau} s for the contact(s)`);
  const yid = y.agent, oid = y.other!;
  for (const id of ['W1', 'W2']) {
    const held = res.intervals[id].filter((r) => r.cause === 'contact').reduce((x, r) => x + r.t_end_s - r.t_start_s, 0);
    ok(near(held, tau * rounds, 1e-9), `${id} stood still ${held.toFixed(3)} s = contact time loss`);
  }
  ok(kinds(res, 'yield_hold').length === 1 && kinds(res, 'yield_resume').length === 1, `${yid} waits beside the narrow part, then resumes`);
  const f = { W1: solo('W1', 2, 1, 98, vOut), W2: solo('W2', 98, -1, 2, vRet) } as Record<string, number>;
  ok(near(f.W1, 96 / vOut) && near(f.W2, 96 / vRet), 'alone: arrival = distance / speed');
  const dY = arrival(res, yid)! - f[yid], dO = arrival(res, oid)! - f[oid];
  ok(dO >= tau * rounds - 1e-9 && dY > dO, `meeting delays both (at least the contact time), the one that gave way more: ${yid} +${dY.toFixed(3)} s, ${oid} +${dO.toFixed(3)} s`);
  ok(JSON.stringify(simulate(cfg)) === JSON.stringify(res), 'replay: identical result');
  ok(JSON.stringify(simulate({ ...cfg, agents: [...agents].reverse() })) === JSON.stringify(res), 'array-order invariance: reversed input, identical result');
  const sig = (r: SimResult) => r.events.map((e) => `${e.kind}|${e.agent}|${e.other}`).join(',');
  for (const H of [0.001, 0.05, 0.5, 7, 60]) { const r = simulate({ ...cfg, window_s: H }); ok(sig(r) === sig(res) && r.events.every((e, i) => Math.abs(e.t_s - res.events[i].t_s) < 1e-9 && Math.abs(e.s_mm - res.events[i].s_mm) < 1e-8), `broadphase window ${H} s: same events (times within 1e-9 s)`); }
  // no studied rule and no candidate value given → reported, not invented
  const nul = run(cor, agents, { encounter: { ...ENC, inside_turn_back_probability: null } });
  ok(kinds(nul.res, 'unresolved').length === 1 && /no studied rule/.test(kinds(nul.res, 'unresolved')[0].detail!) && checkExclusion(nul.cfg, nul.res, 0.01).length === 0, 'inside_turn_back_probability null: reported unresolved, no overlap');
  // the per-contact probability changes how many contacts it takes (more contacts → more time) — never who is 'closer'
  const avgRounds = (p: number) => { let tot = 0; for (let sd = 1; sd <= 200; sd++) { const r = simulate({ ...cfg, seed: sd, encounter: { ...ENC, contact_pause_s: tau, inside_turn_back_probability: p } }); tot += Number(/decided at contact (\d+)/.exec(kinds(r, 'yield_start')[0].detail!)![1]); } return tot / 200; };
  const r1 = avgRounds(0.1), r5 = avgRounds(0.5);
  ok(Math.abs(r5 - 2) < 0.4 && Math.abs(r1 - 1 / (2 * 0.1 * 0.9)) < 1.5, `mean contacts until exactly one turns back: p=0.5 → ${r5.toFixed(2)} (expected 2), p=0.1 → ${r1.toFixed(2)} (expected ${(1 / 0.18).toFixed(2)})`);
}
// ---- 1b. entry yield (Lasius niger, R380): W1 is wholly inside, W2 arrives at the entry → W2 gives way with p≈0.957
{
  const t2 = (98 - 80.5) / vRet, start2 = 76 / vOut - t2;   // touch with W1 at s=78 (inside), W2 at s=80.5 (not yet inside)
  const mk = (seed: number, enc: EncounterRules, loadW1 = false, loadW2 = false) => {
    const objs: PhysObject[] = [...(loadW1 ? [{ id: 'p1', width_mm: 0.5, holder: 'W1' }] : []), ...(loadW2 ? [{ id: 'p2', width_mm: 0.5, holder: 'W2' }] : [])];
    return run(cor, [ant('W1', 'P-corridor', 2, 1, 98, vOut, { load: loadW1 ? 'p1' : null }), ant('W2', 'P-corridor', 98, -1, 2, vRet, { start_t_s: start2, load: loadW2 ? 'p2' : null })], { seed, encounter: enc, objects: objs });
  };
  const first = mk(1, ENC);
  consistent(first.cfg, first.res, 'entry yield');
  const y = kinds(first.res, 'yield_start')[0];
  ok(/entry yield \(Lasius niger R380/.test(y.detail!), `entry rule applied: ${y.detail}`);
  let w2 = 0, n = 400, bad = 0;
  for (let sd = 1; sd <= n; sd++) { const r = mk(sd, ENC); const yy = kinds(r.res, 'yield_start')[0]; if (yy.agent === 'W2') w2++; if (!/entry yield/.test(yy.detail!)) bad++; }
  const pHat = w2 / n, pLit = ENC.entry_yield_probability, se = Math.sqrt(pLit * (1 - pLit) / n);
  ok(bad === 0 && Math.abs(pHat - pLit) < 3 * se, `400 seeds: the entering ant gave way in ${w2}/${n} = ${pHat.toFixed(3)} (literature 202/211 = ${pLit.toFixed(3)} ± 3 SE ${(3 * se).toFixed(3)})`);
  // laden priority (Atta, R381) as the alternative candidate: an unladen ant gives way to a laden one even when inside
  const lad: EncounterRules = { ...ENC, priority: 'laden_priority' };
  let w1y = 0;
  let ladenRule = 0;
  for (let sd = 1; sd <= n; sd++) { const r = mk(sd, lad, false, true); const yy = kinds(r.res, 'yield_start')[0]; if (yy.agent === 'W1') w1y++; if (/laden priority/.test(yy.detail!)) ladenRule++; }
  ok(ladenRule === n, 'laden rule applied in every seed');
  const qHat = w1y / n, q = lad.laden_yield_probability, se2 = Math.sqrt(q * (1 - q) / n);
  ok(Math.abs(qHat - q) < 3 * se2 + 1e-9, `laden_priority: the unladen W1 (already inside) gave way to the laden W2 in ${w1y}/${n} = ${qHat.toFixed(3)} (literature 294/300 = ${q})`);
  const both = mk(1, lad, true, true);
  ok(/entry yield/.test(kinds(both.res, 'yield_start')[0].detail!), 'both laden: falls back to the entry rule');
  ok(/entry yield/.test(kinds(mk(1, ENC, false, true).res, 'yield_start')[0].detail!), 'entry_yield (default): load makes no difference (as in L. niger)');
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
  assert.throws(() => simulate({ encounter: ENC, geometry: cor, horizon_s: 1, seed: 1, objects: [{ id: 'o1', width_mm: 0.5, holder: 'A' }], agents: [ant('A', 'P-corridor', 2, 1, 10, 10, { load: 'o1' }), ant('B', 'P-corridor', 12, 1, 20, 10, { load: 'o1' })] }), /double carrying/); checks++;
  assert.throws(() => simulate({ encounter: ENC, geometry: cor, horizon_s: 1, seed: 1, objects: [], agents: [ant('A', 'P-corridor', 2, 1, 10, 10, { load: 'ghost' })] }), /unknown object/); checks++;
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
  ok(kinds(same.res, 'contact_start').length >= 1 && kinds(same.res, 'cross_wait').length >= 1 && kinds(same.res, 'yield_start').length === 1, 'same time: contact, then one stops and gives way');
  const cw = kinds(same.res, 'cross_wait')[0], wy = kinds(same.res, 'yield_start')[0];
  ok(/both have the other ahead: even chance/.test(cw.detail!) && wy.agent === cw.agent && /pressed by the ant it waits for/.test(wy.detail!) && !/path/.test(wy.detail!), `symmetric approach: an even draw picks who stops; pressed, it backs off out of antennal reach (no use of the other's path): ${cw.detail} / ${wy.detail}`);
  const other = wy.agent === 'E' ? 'N' : 'E', dy = arrival(same.res, wy.agent)! - 50, dO = arrival(same.res, other)! - 50;
  ok(dO > 0 && dy > dO, `both are delayed, the one that gave way more (${wy.agent} +${dy.toFixed(3)} s, ${other} +${dO.toFixed(3)} s)`);
  ok(JSON.stringify(simulate({ ...same.cfg, agents: [...same.cfg.agents].reverse() })) === JSON.stringify(same.res), 'crossing: array-order invariance');
  const yielders = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((seed) => kinds(simulate({ ...same.cfg, seed }), 'cross_wait')[0].agent));
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
  let queueRel = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = rng(seed), agents: SimAgentSpec[] = [];
    for (let k = 0; k < 8; k++) { const d = (k % 2 ? -1 : 1) as 1 | -1; agents.push(ant(`A${k}`, 'P-corridor', d > 0 ? 2 + Math.floor(k / 2) * 3 : 98 - Math.floor(k / 2) * 3, d, d > 0 ? 98 : 2, 15 + g() * 4, { start_t_s: g() * 8 })); }
    const cfg: SimConfig = { encounter: ENC, geometry: cor, agents, horizon_s: 120, seed }, res = simulate(cfg);
    ok(checkExclusion(cfg, res, 0.005).length === 0, `traffic seed ${seed}: no mutually exclusive positions`);
    for (const a of agents) ok(checkTrajectory(Pc, res.intervals[a.id], 19).length === 0, `traffic seed ${seed}: ${a.id} trajectory consistent`);
    for (const f of Object.values(res.final)) tally[f.mode] = (tally[f.mode] ?? 0) + 1;
    ok(res.events.filter((e) => e.kind === 'unresolved').every((e) => typeof e.detail === 'string' && e.other !== null), `traffic seed ${seed}: every unresolved jam names the ants and the reason`);
    ok(noSilentWait(res), `traffic seed ${seed}: no ant ends waiting for an ant that has stopped for good (silent deadlock)`);
    queueRel += res.events.filter((e) => /queue at the entry/.test(e.detail ?? '')).length;
  }
  console.error(`two-way single-file traffic, 12 seeds × 8 ants, final states: ${JSON.stringify(tally)}, entry-queue releases ${queueRel}`);
  ok(queueRel > 0, `traffic exercises the entry-queue release (${queueRel})`);
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
    return { encounter: ENC, geometry: g, agents, horizon_s: 20, seed, window_s: [0.05, 1, 7][seed % 3] };
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
    return { encounter: ENC, geometry: g, agents, objects, horizon_s: 25, seed, window_s: [0.05, 1, 7][seed % 3] };
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
// ---- 9d. review of #75: dense two-way corridors (3–10 ants starting inside and outside, loads, both priority rules,
// all pause and turn-back candidates): no overlap, no order dependence, no rule loop, and no silent wait — every ant
// still standing at the horizon is reported. Seed 26 left a backing-out ant standing behind an ant that had stopped for
// good, unreported (P1); several seeds looped when the entry queue released an ant blocked ahead.
{
  const dense = (seed: number): SimConfig => {
    const r = rng(seed * 7717), na = 3 + Math.floor(r() * 8), agents: SimAgentSpec[] = [], objects: PhysObject[] = [], used: number[] = [];
    for (let k = 0; k < na; k++) {
      const d = (r() < 0.5 ? 1 : -1) as 1 | -1;
      let s = 0; for (let tries = 0; tries < 50; tries++) { s = 2 + r() * 96; if (used.every((u) => Math.abs(u - s) > 2.6)) break; }
      if (!used.every((u) => Math.abs(u - s) > 2.6)) continue; used.push(s);
      let load: string | null = null; if (r() < 0.3) { load = `o${k}`; objects.push({ id: load, width_mm: 0.5 + r() * 0.3, holder: `a${k}` }); }
      agents.push(ant(`a${k}`, 'P-corridor', s, d, d > 0 ? Math.max(s, 99) : Math.min(s, 1), 10 + r() * 10, { start_t_s: r() * 3, load, body: { length_mm: 2.5, width_mm: 0.55 + r() * 0.25, contact_reach_mm: r() } }));
    }
    return { encounter: { priority: seed % 2 ? 'entry_yield' : 'laden_priority', entry_yield_probability: [0.957, 0.5, 0.05][seed % 3], laden_yield_probability: 0.98, contact_pause_s: [null, 0.18, 0.43, 0.8][seed % 4], inside_turn_back_probability: [0.1, 0.5, 0.9, null][seed % 4 === 3 ? 3 : seed % 3] }, geometry: cor, agents, objects, horizon_s: 120, seed, window_s: [0.05, 1, 7][seed % 3] };
  };
  let pressEvents = 0, chainEvents = 0, queueReleases = 0;
  const finals: Record<string, number> = {};
  for (const seed of [26, ...Array.from({ length: 24 }, (_, i) => i + 1).filter((x) => x !== 26)]) {
    const cfg = dense(seed);
    let res: SimResult;
    try { res = simulate(cfg); } catch (e) { if (/same space|narrower than its width/.test(String(e))) continue; throw e; }
    ok(checkExclusion(cfg, res, 0.005).length === 0, `dense seed ${seed}: no mutually exclusive positions`);
    ok(JSON.stringify(simulate({ ...cfg, agents: [...cfg.agents].reverse() })) === JSON.stringify(res), `dense seed ${seed}: input order invariant`);
    const unresolvedIds = new Set(res.events.filter((e) => e.kind === 'unresolved').flatMap((e) => [e.agent, e.other]));
    const silent = Object.entries(res.final).filter(([id, f]) => !['arrived', 'blocked', 'unresolved'].includes(f.mode) && !unresolvedIds.has(id) && res.intervals[id].at(-1)!.speed_mm_s === 0 && res.intervals[id].at(-1)!.t_end_s - res.intervals[id].at(-1)!.t_start_s > 60);
    ok(silent.length === 0, `dense seed ${seed}: no ant stands for more than 60 s at the horizon without being reported (${silent.map(([id, f]) => `${id}:${f.mode}`)})`);
    for (const f of Object.values(res.final)) finals[f.mode] = (finals[f.mode] ?? 0) + 1;
    pressEvents += res.events.filter((e) => e.kind === 'follow_start' && /backing out behind/.test(e.detail ?? '')).length;
    chainEvents += res.events.filter((e) => e.kind === 'yield_start' && /chain back-out/.test(e.detail ?? '')).length;
    queueReleases += res.events.filter((e) => e.kind === 'follow_end' && /queue at the entry/.test(e.detail ?? '')).length;
  }
  ok(pressEvents > 0 && chainEvents > 0, `dense corridors exercise backing out behind a backing-out ant (${pressEvents}) and chain back-out (${chainEvents}); entry-queue releases here: ${queueReleases} (a release of an ant blocked ahead would loop and throw)`);
  console.error(`dense two-way corridors, 25 seeds, final states: ${JSON.stringify(finals)}`);
  assert.throws(() => simulate({ ...dense(1), encounter: { ...dense(1).encounter, inside_turn_back_probability: 1 } }), /\(0, 1\)/); checks++;
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
assert.throws(() => simulate({ encounter: ENC, geometry: cor, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 50, 1, 60, 10), ant('B', 'P-corridor', 51, 1, 60, 10)] }), /same space/); checks++;
assert.throws(() => simulate({ encounter: ENC, geometry: cor, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 50, 1, 60, 10, { body: { length_mm: 2.5, width_mm: 1.2, contact_reach_mm: 1 } })] }), /narrower than its width/); checks++;
{ const u = structuredClone(cor) as Any; u.passages[0].width_mm = null; assert.throws(() => simulate({ encounter: ENC, geometry: u, horizon_s: 1, seed: 1, agents: [ant('A', 'P-corridor', 2, 1, 60, 10)] }), /unknown geometry/); checks++; }

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
  const t0 = performance.now(), res = simulate({ encounter: ENC, geometry: lat, agents, horizon_s: 3, seed: 3, window_s: 0.5 }), ms = performance.now() - t0;
  const nC = kinds(res, 'contact_start').length, nW = kinds(res, 'cross_wait').length;
  console.error(`performance: 1000 ants × 3 s on a 40-lane lattice: ${ms.toFixed(0)} ms, ${res.stats.steps} steps, ${res.stats.pair_evaluations} pair evaluations, ${nC} contacts, ${nW} crossing waits`);
  ok(ms < 60000 && res.stats.pair_evaluations < 1000 * 999 / 2 * res.stats.steps, `1000 ants run in ${ms.toFixed(0)} ms with the grid (pair evaluations ${res.stats.pair_evaluations} ≪ brute force ${(1000 * 999 / 2 * res.stats.steps).toExponential(1)})`);
}

// ---------------------------------------------------------------- Codex physics review f61db12 (F1 P1, F2 P2, F3 P2)
{
  const prov = { source: 'synthetic_scenario', assumption: true, basis: '遊戲假設', note: 'Codex review counterexample' };
  const scene = (extra: Any): PhysicsGeometry => ({ schema: 'antempire.physics-geometry.v1', layer_of: 'antempire.world-geometry.v1', world_geometry_ref: null, world_id: 'synthetic-codex-review', geometry_version: '0.1.0', synthetic: true, synthetic_note: 'review counterexample', frame: { units: 'mm', axes: { x: 'east', y: 'north', z: 'up' }, origin: 'synthetic' }, obstacles: [], entrances: [], ...extra } as PhysicsGeometry);
  const ground = { id: 'S-ground', material: 'bare_soil', polygon_mm: [[-5, -15], [25, -15], [25, 15], [-5, 15]], elevation: { kind: 'flat', z_mm: 0 }, provenance: prov };
  const rb = { length_mm: 2.5, width_mm: 0.6, contact_reach_mm: 0.5 };
  const a2 = (o: Any): SimAgentSpec => ({ dir: 1, start_t_s: 0, load: null, body: rb, ...o });
  // F1: an ant walking down a ramp reaches the height layer of an ant on the ground lane beneath it
  const ramp = scene({ surfaces: [ground, { id: 'S-ramp', material: 'stone', polygon_mm: [[0, -15], [20, -15], [20, 15], [0, 15]], elevation: { kind: 'ramp', anchor_mm: [0, 0], z0_mm: 10, direction: [1, 0], gradient: -0.5 }, provenance: prov }],
    passages: [{ id: 'P1', centerline_mm: [[0, 0, 10], [20, 0, 0]], width_mm: 20, route_edge_ref: null, provenance: prov }, { id: 'P2', centerline_mm: [[0, 0, 0], [20, 0, 0]], width_mm: 20, route_edge_ref: null, provenance: prov }] });
  const stops: number[] = [];
  for (const w of [2, 1, 0.5, 0.1, 0.01, 0.003]) {
    const cfg: SimConfig = { encounter: ENC, geometry: ramp, horizon_s: 2, seed: 1, window_s: w, agents: [a2({ id: 'A', passage: 'P1', s_mm: 0, free_speed_mm_s: 20, goal_s_mm: Math.sqrt(500) }), a2({ id: 'B', passage: 'P2', s_mm: 17, start_t_s: 10, free_speed_mm_s: 20, goal_s_mm: 19 })] };
    const r = simulate(cfg), ex = checkExclusion(cfg, r, 0.0005);
    ok(ex.length === 0, `F1 window ${w}: the descending ant never overlaps the one below (${ex[0] ?? ''})`);
    ok(r.final.A.mode === 'unresolved' && kinds(r, 'unresolved').some((e) => /height layer/.test(e.detail ?? '')), `F1 window ${w}: it is stopped and reported, not passed through (${r.final.A.mode})`);
    stops.push(r.final.A.s_mm);
  }
  // A stops where |dz| reaches the layer limit: x = 15 (z = 2.5), i.e. s = 15·√1.25
  ok(stops.every((x) => Math.abs(x - stops[0]) < 1e-9) && Math.abs(stops[0] / Math.sqrt(1.25) - 15) < 1e-5, `F1: the same stop for every window, at x = ${(stops[0] / Math.sqrt(1.25)).toFixed(6)} (expected 15)`);
  // reaching the layer first, then touching: an ordinary crossing obstruction, still without overlap, window-independent
  const far: number[] = [];
  for (const w of [2, 0.1, 0.01]) {
    const cfg: SimConfig = { encounter: ENC, geometry: ramp, horizon_s: 2, seed: 1, window_s: w, agents: [a2({ id: 'A', passage: 'P1', s_mm: 0, free_speed_mm_s: 20, goal_s_mm: Math.sqrt(500) }), a2({ id: 'B', passage: 'P2', s_mm: 19.5, start_t_s: 10, free_speed_mm_s: 20, goal_s_mm: 19.9 })] };
    const r = simulate(cfg), ex = checkExclusion(cfg, r, 0.0005);
    ok(ex.length === 0 && kinds(r, 'obstruction').length > 0 && !kinds(r, 'unresolved').some((e) => /height layer/.test(e.detail ?? '')), `F1 window ${w}: on one layer first, then an ordinary obstruction without overlap (${ex[0] ?? ''})`);
    far.push(r.final.A.s_mm);
  }
  ok(far.every((x) => Math.abs(x - far[0]) < 1e-9), `F1: the ordinary case is window-independent too (${far.join(', ')})`);
  // an ant on a different layer the whole time is never obstructed (ground lane, other ant on a high ramp segment)
  { const cfg: SimConfig = { encounter: ENC, geometry: ramp, horizon_s: 2, seed: 1, agents: [a2({ id: 'A', passage: 'P1', s_mm: 0, free_speed_mm_s: 20, goal_s_mm: 5 }), a2({ id: 'B', passage: 'P2', s_mm: 1, free_speed_mm_s: 20, goal_s_mm: 6 })] };
    const r = simulate(cfg); ok(r.final.A.mode === 'arrived' && r.final.B.mode === 'arrived' && kinds(r, 'obstruction').length === 0 && checkExclusion(cfg, r, 0.0005).length === 0, 'F1: ants that stay on different layers pass one above the other'); }

  // F2: a narrowing shorter than any sampling step (Codex: 7.2 µm long, between the old 0.01 mm samples)
  const flat = (obstacles: Any[], centerline: number[][] = [[0, 0, 0], [20, 0, 0]], surfaces: Any[] = [ground]) => scene({ surfaces, obstacles, passages: [{ id: 'P', centerline_mm: centerline, width_mm: 20, route_edge_ref: null, provenance: prov }] });
  const g2 = flat([{ id: 'O', kind: 'stone', shape: { type: 'circle', center_mm: [10.005, 1.299995], radius_mm: 1 }, base_z_mm: 0, height_mm: 1, provenance: prov }]);
  const ns = narrowSections(g2, g2.passages[0], 0.6), half = Math.sqrt(1.3 ** 2 - 1.299995 ** 2);
  ok(ns.length === 1 && near(ns[0][0], 10.005 - half, 1e-9) && near(ns[0][1], 10.005 + half, 1e-9), `F2: the 7.2 µm narrowing is found exactly ([${ns[0]?.join(', ')}], expected ±${half.toFixed(9)} around 10.005)`);
  { const cfg: SimConfig = { encounter: ENC, geometry: g2, horizon_s: 2, seed: 1, agents: [a2({ id: 'A', passage: 'P', s_mm: 1, free_speed_mm_s: 10, goal_s_mm: 19 })] };
    const r = simulate(cfg); ok(r.final.A.mode === 'blocked' && checkExclusion(cfg, r, 0.0001).length === 0, `F2: the ant is stopped before it, as PH-1 traverse says (impassable), not let through (${r.final.A.mode})`); }
  // oracle: random circles and polygons near random (also sloped) lanes vs. a dense brute-force scan
  const R = rng(20261105);
  let fuzz = 0;
  for (let k = 0; k < 150; k++) {
    const z1 = R() < 0.3 ? 2 * R() : 0, obs: Any[] = [];
    for (let j = 0; j < 3; j++) {
      const cx = 2 + 16 * R(), cy = (R() - 0.5) * 2.4, base = R() < 0.2 ? 1 + R() : 0;
      if (R() < 0.5) obs.push({ id: `O${j}`, kind: 'stone', shape: { type: 'circle', center_mm: [cx, cy], radius_mm: 0.05 + R() }, base_z_mm: base, height_mm: 0.5 + R(), provenance: prov });
      else { const n = 3 + Math.floor(R() * 3), rr = 0.1 + R(); obs.push({ id: `O${j}`, kind: 'stone', shape: { type: 'polygon', points_mm: Array.from({ length: n }, (_, i) => [cx + rr * Math.cos((2 * Math.PI * i) / n + 0.3), cy + rr * Math.sin((2 * Math.PI * i) / n + 0.3)]) }, base_z_mm: base, height_mm: 0.5 + R(), provenance: prov }); }
    }
    const surf = z1 === 0 ? [ground] : [{ ...ground, elevation: { kind: 'ramp', anchor_mm: [0, 0], z0_mm: 0, direction: [1, 0], gradient: z1 / 20 } }];
    const g = flat(obs, [[0, 0, 0], [20, 0, z1]], surf), p = g.passages[0], T = 0.3 + R(), secs = narrowSections(g, p, T), Lp = laneLength(p);
    const inside = (x: number) => secs.some(([a, b]) => x >= a - 1e-9 && x <= b + 1e-9);
    for (let x = 0; x <= Lp; x += 0.0007) if ((usableWidth(g, p, x) < T) !== inside(x)) { assert.fail(`F2 oracle ${k}: at s=${x} the scan says narrow=${usableWidth(g, p, x) < T}, the sections say ${inside(x)} (${JSON.stringify(secs)})`); }
    for (const [a, b] of secs) ok(b > a && usableWidth(g, p, (a + b) / 2) < T, `F2 oracle ${k}: every reported section is narrow`);
    fuzz++;
  }
  ok(fuzz === 150, `F2: analytic sections agree with a 0.7 µm brute-force scan on ${fuzz} random scenes (circles, polygons, sloped lanes, raised obstacles)`);

  // F3: an ant already at its goal arrives at its start time and does not move (both directions, delayed start)
  const g3 = flat([]);
  for (const [d, st] of [[1, 0], [-1, 0], [1, 0.2], [-1, 0.3]] as [1 | -1, number][]) {
    const r = simulate({ encounter: ENC, geometry: g3, horizon_s: 0.5, seed: 1, agents: [a2({ id: 'A', passage: 'P', s_mm: 1, dir: d, start_t_s: st, free_speed_mm_s: 10, goal_s_mm: 1 })] });
    const arr = kinds(r, 'arrive')[0];
    ok(r.final.A.mode === 'arrived' && r.final.A.s_mm === 1 && arr && near(arr.t_s, st) && r.intervals.A.every((iv) => iv.s_start_mm === 1 && iv.s_end_mm === 1), `F3 dir ${d} start ${st}: arrives at once and never moves (final ${JSON.stringify(r.final.A)})`);
  }
}

console.log(JSON.stringify({ ph2_collision: 'pass', checks }, null, 2));
