/**
 * WP4 local-steer candidates (docs/wp4-local-avoidance.md), BLOCKING:
 *  1. no penetration — every candidate (and the baseline) in every playback scenario: the independent sample-based verifier
 *     (bodies, lane side edges, obstacles; exact convex minimum between records) and the common solver-compare judge
 *     (per-instant + swept overlaps, obstacles, lane bands, 2-D occupancy contract) report 0 violations; also the
 *     100-agent crossing with the verifier. A positive control shows the verifier does catch an overlap;
 *  2. determinism (same input + seed → identical output) and permutation invariance (reversed / shuffled agent arrays);
 *  3. 'none' is exactly the PH-3b solver output (deep-equal agents and events);
 *  4. locality: an agent far away (another lane, out of reach) does not change anyone else's trajectory or draws;
 *  5. failures are kept: head-on in the 1.0 mm corridor is reported (rule D: too narrow for two) and stalls are recorded;
 *  6. refusals: unknown policy, a needed parameter that is null, a bent lane;
 *  7. isolation: the official pipeline does not import the module; no platform API, no unseeded randomness, no species branch.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { steer2D, STEER_POLICIES, SteerRefused, type SteerResult } from '../engine/physics/local-steer.ts';
import { solve2D } from '../engine/physics/solver2d.ts';
import { ph3bInput } from '../prototypes/solver-compare/lib/ph3b.ts';
import { judge } from '../prototypes/solver-compare/lib/judge.ts';
import { steerInput, runSteer, verify, runHash, toTrajectory } from '../prototypes/local-steer/lib.ts';
import { scenarioById } from '../prototypes/local-steer/compare.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const SMALL = ['head-on-2', 'offset-block', 'pass-clear', 'pass-graze', 'crossing', 'crossing-flank', 'stone', 'corridor-8'];

// 1 + 3: no penetration everywhere; 'none' = PH-3b
for (const id of SMALL) {
  const sc = scenarioById(id);
  const base = solve2D(ph3bInput(sc));
  for (const p of STEER_POLICIES) {
    const res = runSteer(sc, p).res, v = verify(sc, res);
    ok(v.pair_penetrations === 0 && v.static_penetrations === 0 && v.min_pair_gap_mm >= -1e-9 && v.min_static_gap_mm >= -1e-9, `${id}/${p}: verifier finds no penetration (min pair ${v.min_pair_gap_mm}, static ${v.min_static_gap_mm})`);
    const j = judge(sc, toTrajectory(sc, res), { occupancy2d: true });
    ok(j.overlap_pair_instants === 0 && j.overlap_between_instants === 0, `${id}/${p}: judge finds no body overlap`);
    ok(j.obstacle_violation_agent_instants === 0 && j.out_of_walkable_agent_instants === 0, `${id}/${p}: judge finds no obstacle or lane-band violation`);
    ok(j.occupancy2d!.overlap === 0, `${id}/${p}: 2-D occupancy contract finds no overlap`);
    ok(res.stats.unresolved === 0 && res.stats.fallback_intervals === 0, `${id}/${p}: nothing unresolved`);
    if (p === 'none') {
      assert.deepEqual(res.events, base.events.map((e) => ({ ...e }))); checks++;
      for (const aid of Object.keys(base.agents)) { assert.deepEqual(res.agents[aid].samples, base.agents[aid].samples); ok(res.agents[aid].final_mode === base.agents[aid].final_mode && res.agents[aid].arrival_t_s === base.agents[aid].arrival_t_s, `${id}: none = PH-3b agent ${aid}`); }
      ok(res.ph3b !== undefined && JSON.stringify(res.ph3b.stats) === JSON.stringify(base.stats), `${id}: none carries the PH-3b stats unchanged`);
    } else {
      // every recorded motion change is named by an event of that agent (no unexplained motion)
      for (const [aid, a] of Object.entries(res.agents)) {
        const own = new Set(res.events.filter((e) => e.agents.includes(aid)).map((e) => e.t_s));
        for (let k = 1; k + 1 < a.samples.length; k++) ok(own.has(a.samples[k][0]), `${id}/${p}/${aid}: record at ${a.samples[k][0]} has an event`);
      }
    }
  }
}
// positive control: the verifier catches an overlap planted in a trajectory
{
  const sc = scenarioById('pass-clear'), res = runSteer(sc, 'A_free_direction').res;
  const bad: SteerResult = JSON.parse(JSON.stringify(res));
  const ids = Object.keys(bad.agents).sort(), b0 = bad.agents[ids[1]].samples;
  bad.agents[ids[0]].samples = b0.map((s) => [s[0], s[1], s[2] + 0.3, s[3] + Math.PI, s[4], s[5]]);   // B's path shifted 0.3 mm
  const v = verify(sc, bad);
  ok(v.pair_penetrations > 0 && v.max_pair_penetration_mm > 0.4, 'positive control: verifier finds a planted overlap');
}

// 1 (large) + 2: 100-agent crossing: no penetration, deterministic, permutation invariant
{
  const sc = scenarioById('crossing-traffic-100');
  for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
    const r1 = runSteer(sc, p).res, v = verify(sc, r1), h = runHash(r1);
    ok(v.pair_penetrations === 0 && v.static_penetrations === 0, `crossing-traffic-100/${p}: no penetration (min pair ${v.min_pair_gap_mm})`);
    ok(runHash(runSteer(sc, p).res) === h, `crossing-traffic-100/${p}: rerun identical`);
    ok(runHash(runSteer(sc, p, { order: 'reversed' }).res) === h, `crossing-traffic-100/${p}: reversed input identical`);
    ok(runHash(runSteer(sc, p, { order: 'shuffled' }).res) === h, `crossing-traffic-100/${p}: shuffled input identical`);
    ok(runHash(runSteer(sc, p, { seed: 2 }).res) !== h, `crossing-traffic-100/${p}: the seed is used (seed 2 differs)`);
    ok(r1.stats.stalled + r1.stats.arrived <= 100 && r1.stats.decision_instants === 400, `crossing-traffic-100/${p}: bookkeeping`);
  }
  const none = runSteer(sc, 'none').res;
  ok(runHash(none) === runHash(runSteer(sc, 'none', { order: 'shuffled' }).res), 'crossing-traffic-100/none: shuffled input identical');
  ok(JSON.stringify(none.events) === JSON.stringify(solve2D(ph3bInput(sc)).events), 'crossing-traffic-100: none = PH-3b events');
}
for (const id of ['corridor-8', 'stone', 'crossing']) for (const p of STEER_POLICIES) {
  const sc = scenarioById(id), h = runHash(runSteer(sc, p).res);
  ok(runHash(runSteer(sc, p, { order: 'reversed' }).res) === h && runHash(runSteer(sc, p, { order: 'shuffled' }).res) === h, `${id}/${p}: permutation invariant`);
}

// 4: locality — a far agent on another lane changes nothing for the others
{
  const sc = scenarioById('head-on-2');
  for (const p of STEER_POLICIES.filter((x) => x !== 'none')) {
    const base = steer2D(steerInput(sc, p));
    const inp = steerInput(sc, p);
    inp.lanes = [...inp.lanes, { id: 'far-lane', centerline_mm: [{ x: 0, y: 1000 }, { x: 100, y: 1000 }], width_mm: 10, layer: inp.lanes[0].layer }];
    inp.agents = [...inp.agents, { ...inp.agents[0], id: 'Z-far', lane: 'far-lane', s_mm: 5, u_mm: 0, dir: 1, goal_s_mm: 95 }];
    const more = steer2D(inp);
    for (const aid of Object.keys(base.agents)) assert.deepEqual(more.agents[aid].samples, base.agents[aid].samples);
    ok(JSON.stringify(more.events.filter((e) => !e.agents.includes('Z-far'))) === JSON.stringify(base.events), `${p}: a far agent changes nobody else's events`);
    ok(more.agents['Z-far'].arrival_t_s !== null, `${p}: the far agent walks its free lane`);
  }
}

// 5: failures are kept and reported
{
  const sc = scenarioById('head-on-2');
  for (const p of ['A_free_direction', 'C_sidestep'] as const) {
    const res = runSteer(sc, p).res;
    ok(res.stats.arrived === 0 && res.stats.stalled === 2, `head-on-2/${p}: both stall in the 1.0 mm corridor (kept, not hidden)`);
    ok((res.stats.blocked_reports.too_narrow_for_two ?? 0) === 2 && res.events.filter((e) => e.kind === 'blocked_report' && /^too_narrow_for_two/.test(e.detail ?? '')).length === 2, `head-on-2/${p}: rule D reports 'too narrow for two'`);
    ok(res.events.filter((e) => e.kind === 'stalled').length === 2, `head-on-2/${p}: stalled events at the horizon`);
  }
  const b = runSteer(sc, 'B_contact_decision').res;
  const narrowDecisions = b.events.filter((e) => e.class === 'behavioural_response' && /too narrow to pass/.test(e.detail ?? ''));
  ok(narrowDecisions.length > 0 && narrowDecisions.every((e) => e.kind === 'back_off' || e.kind === 'wait'), 'head-on-2/B: where too narrow for two, only wait / back off (re-route excluded)');
  const none = runSteer(sc, 'none').res;
  ok(none.events.filter((e) => e.kind === 'stalled').length === 2, 'head-on-2/none: PH-3b stalls kept');
}

// 6: refusals
{
  const sc = scenarioById('head-on-2');
  const refused = (f: () => unknown) => { try { f(); return false; } catch (e) { return e instanceof SteerRefused; } };
  ok(refused(() => steer2D({ ...steerInput(sc, 'A_free_direction'), policy: 'keep_right' as never })), 'unknown policy refused');
  for (const p of ['A_free_direction', 'B_contact_decision', 'C_sidestep'] as const) ok(refused(() => steer2D(steerInput(sc, p, { over: { sensing_radius_mm: null } }))), `${p}: null sensing radius refused`);
  ok(refused(() => steer2D(steerInput(sc, 'B_contact_decision', { over: { p_back: null } }))), 'B: null p_back refused');
  ok(!refused(() => steer2D(steerInput(sc, 'A_free_direction', { over: { p_back: null } }))), 'A does not need p_back');
  ok(refused(() => steer2D(steerInput(sc, 'B_contact_decision', { over: { p_wait: 0.5 } }))), 'B: probabilities must sum to 1');
  const bent = steerInput(sc, 'C_sidestep');
  bent.lanes = bent.lanes.map((l) => ({ ...l, centerline_mm: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 10 }] }));
  ok(refused(() => steer2D(bent)), 'a bent lane is refused (no body-rotation model)');
}

// 7: isolation
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/local-steer.ts'), 'utf8'));
  ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(src), 'local-steer: no unseeded randomness or clock');
  ok(!/pheidole|megacephala/i.test(src), 'local-steer: no species-specific branch');
  ok(!/from\s+['"](node:|fs|path)/.test(src), 'local-steer: no platform API');
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js|mjs|cjs)$/.test(e.name) ? [path.join(d, e.name)] : []) : [];
  const official = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
  for (const f of official) ok(!/local-steer/.test(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not reference local-steer`);
  const others = fs.readdirSync(path.join(REPO_ROOT, 'engine/physics')).filter((f) => f.endsWith('.ts') && f !== 'local-steer.ts');
  for (const f of others) ok(!/local-steer/.test(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics', f), 'utf8')), `engine/physics/${f} does not depend on local-steer (PH-3b unchanged)`);
}
console.log(JSON.stringify({ wp4_local_steer: 'pass', checks }, null, 2));
