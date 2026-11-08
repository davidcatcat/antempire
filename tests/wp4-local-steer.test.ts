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
 *  7. isolation: the official pipeline does not import the module; no platform API, no unseeded randomness, no species branch;
 *  8. event timing (R13-05/06): analytic arrivals (on a decision-grid point, off-grid, initially at the goal, at the horizon,
 *     recorded once, same as PH-3b) and contacts (the other body starting late, separation across decision boundaries,
 *     positive duration = analytic value); for every candidate and scenario: arrival recorded once at the goal, never
 *     missed; contact_end ≥ contact_start, the gap stays within CONTACT_TOL_MM at every motion record before the end
 *     (the end is never before the separating motion begins) and has just exceeded it at the end.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { steer2D, STEER_POLICIES, SteerRefused, CONTACT_TOL_MM, type SteerResult, type SteerInput, type SteerPolicyId } from '../engine/physics/local-steer.ts';
import { capsuleGap, type Capsule } from '../engine/physics/body2d.ts';
import { solve2D } from '../engine/physics/solver2d.ts';
import { ph3bInput } from '../prototypes/solver-compare/lib/ph3b.ts';
import { judge } from '../prototypes/solver-compare/lib/judge.ts';
import { steerInput, runSteer, verify, runHash, toTrajectory } from '../prototypes/local-steer/lib.ts';
import { scenarioById } from '../prototypes/local-steer/compare.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const timing = { arrivals: 0, contacts: 0 };
/** event-timing invariants of one run (R13-05/06), from the run's own records only */
function timingInvariants(inp: SteerInput, res: SteerResult, label: string) {
  const spec = new Map(inp.agents.map((a) => [a.id, a]));
  const capAt = (id: string, t: number): Capsule => {
    const S = res.agents[id].samples, sp = spec.get(id)!;
    let k = 0; while (k + 1 < S.length && S[k + 1][0] <= t) k++;
    const p = S[k], q = S[k + 1], f = q && q[0] > p[0] ? (t - p[0]) / (q[0] - p[0]) : 0;
    const x = q ? p[1] + (q[1] - p[1]) * f : p[1], y = q ? p[2] + (q[2] - p[2]) * f : p[2], h = p[3];
    const hw = Math.max(0, sp.body.length_mm! - sp.body.width_mm!) / 2, d = { x: Math.cos(h) * hw, y: Math.sin(h) * hw };
    return { a: { x: x - d.x, y: y - d.y }, b: { x: x + d.x, y: y + d.y }, r: sp.body.width_mm! / 2 };
  };
  const gap = (i: string, j: string, t: number) => capsuleGap(capAt(i, t), capAt(j, t));
  // arrivals: once, at the goal; an agent that is not arrived never reached its goal at any record
  for (const [id, a] of Object.entries(res.agents)) {
    const sp = spec.get(id)!, arr = res.events.filter((e) => e.kind === 'arrive' && e.agents[0] === id);
    ok(arr.length <= 1, `${label}/${id}: arrival recorded at most once`);
    if (a.arrival_t_s !== null) {
      timing.arrivals++;
      ok(arr.length === 1 && arr[0].t_s === a.arrival_t_s && a.arrival_t_s <= inp.horizon_s, `${label}/${id}: arrival event = arrival_t_s ≤ horizon`);
      const at = a.samples.filter((s) => s[0] === a.arrival_t_s).at(-1)!;
      ok(at && Math.abs((at[4] - sp.goal_s_mm) * sp.dir) <= 1e-9 && a.final_mode === 'arrived', `${label}/${id}: at the goal on arrival`);
      ok(a.samples.every((s) => s[0] <= a.arrival_t_s! || (s[1] === at[1] && s[2] === at[2])), `${label}/${id}: no motion after arrival`);
    } else {
      ok(arr.length === 0 && (sp.start_t_s > inp.horizon_s || a.samples.every((s) => (sp.goal_s_mm - s[4]) * sp.dir > 1e-12)), `${label}/${id}: not arrived → not started by the horizon, or never at its goal (no missed arrival)`);
    }
  }
  // contacts: matched start/end per pair
  const open = new Map<string, number>();
  const episode = (i: string, j: string, ts: number, te: number | null) => {
    timing.contacts++;
    const end = te ?? inp.horizon_s, recs = [...new Set([ts, ...res.agents[i].samples.map((s) => s[0]), ...res.agents[j].samples.map((s) => s[0])])].filter((t) => t >= ts && t < end);
    if (te !== null) ok(te >= ts, `${label}/${i}-${j}: contact_end ${te} ≥ contact_start ${ts}`);
    for (const r of recs) ok(gap(i, j, r) <= CONTACT_TOL_MM + 1e-12, `${label}/${i}-${j}: still in contact at record ${r} (start ${ts}, end ${te}): gap ${gap(i, j, r)}`);
    if (te !== null) {
      ok(gap(i, j, te) > CONTACT_TOL_MM / 2, `${label}/${i}-${j}: gap has opened at contact_end ${te} (${gap(i, j, te)})`);
      ok(te - 1e-9 < ts || gap(i, j, te - 1e-9) <= CONTACT_TOL_MM + 1e-12, `${label}/${i}-${j}: contact_end is the first separation (to 1e-9 s)`);
    }
  };
  for (const e of res.events) {
    if (e.kind !== 'contact_start' && e.kind !== 'contact_end') continue;
    const key = e.agents.join('|');
    if (e.kind === 'contact_start') { ok(!open.has(key), `${label}/${key}: no nested contact_start`); open.set(key, e.t_s); }
    else { ok(open.has(key), `${label}/${key}: contact_end has a start`); episode(e.agents[0], e.agents[1], open.get(key)!, e.t_s); open.delete(key); }
  }
  for (const [key, ts] of open) { const [i, j] = key.split('|'); episode(i, j, ts, null); }
}

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
      timingInvariants(steerInput(sc, p), res, `${id}/${p}`);
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
    timingInvariants(steerInput(sc, p), r1, `crossing-traffic-100/${p}`);
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

// 8: event timing — analytic cases (R13-05 arrival at an interval end; R13-06 contact end from the actual separation)
{
  const params = { sensing_radius_mm: 0.5, decision_interval_s: 0.1, probe_angles_deg: [0, 90], same_heading_max_deg: 20, stall_window_s: 1, stall_progress_mm: 0.01, p_wait: 0.5, p_back: 0.25, p_reroute: 0.25, wait_s: 0.5, back_distance_mm: 0.5, reroute_max_s: 0.5 };
  const lanes = [{ id: 'L', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 10, layer: 'G' }], body = { length_mm: 2.5, width_mm: 0.8 };
  const ag = (id: string, s: number, start: number, goal: number) => ({ id, lane: 'L', s_mm: s, u_mm: 0, dir: 1 as const, start_t_s: start, goal_s_mm: goal, free_speed_mm_s: 10, body });
  const run = (policy: SteerPolicyId, agents: ReturnType<typeof ag>[], horizon_s: number, dt: number) => { const inp: SteerInput = { lanes, obstacles: [], agents, horizon_s, policy, params: { ...params, decision_interval_s: dt }, seed: 1 }; return { inp, res: steer2D(inp) }; };
  const near = (x: number | null, y: number, tol = 1e-12) => x !== null && Math.abs(x - y) <= tol;
  // arrivals: [label, start s, start time, goal, horizon, dt, expected arrival (null = none)]
  const cases: [string, number, number, number, number, number, number | null][] = [
    ['on a decision-grid point', 10, 0, 11, 0.4, 0.1, 0.1],
    ['off grid', 10, 0, 11.1, 0.4, 0.1, 0.11],
    ['on grid, late start', 10, 0.05, 11, 0.4, 0.1, 0.15],
    ['initially at the goal', 10, 0, 10, 0.4, 0.1, 0],
    ['initially at the goal, late start', 10, 0.05, 10, 0.4, 0.1, 0.05],
    ['exactly at the horizon (on grid)', 10, 0, 14, 0.4, 0.1, 0.4],
    ['exactly at the horizon (horizon off grid)', 10, 0, 13.5, 0.35, 0.1, 0.35],
    ['just beyond the horizon', 10, 0, 14.001, 0.4, 0.1, null],
    ['start after the horizon', 10, 0.5, 10, 0.4, 0.1, null],
  ];
  for (const p of STEER_POLICIES) for (const [label, s0, st, goal, H, dt, exp] of cases) {
    const { inp, res } = run(p, [ag('A', s0, st, goal)], H, dt), a = res.agents.A;
    ok(exp === null ? a.arrival_t_s === null : near(a.arrival_t_s, exp), `${p}: arrival ${label}: expected ${exp}, got ${a.arrival_t_s}`);
    ok(res.events.filter((e) => e.kind === 'arrive').length === (exp === null ? 0 : 1), `${p}: arrival ${label} recorded exactly ${exp === null ? 0 : 1} time(s)`);
    ok(exp === null || (a.final_mode === 'arrived' && !res.events.some((e) => e.kind === 'stop')), `${p}: arrival ${label}: final mode arrived, no stop event`);
    const ph = solve2D({ lanes, obstacles: [], agents: inp.agents, horizon_s: H });
    ok(exp === null ? ph.agents.A.arrival_t_s === null : near(ph.agents.A.arrival_t_s, exp), `PH-3b reference: arrival ${label} = ${ph.agents.A.arrival_t_s}`);
    timingInvariants(inp, res, `arrival ${label}/${p}`);
  }
  // contacts: A (s 10) follows B (s 13.1, starting late); A stops on touching B at (13.1 − 2.5 − 10)/10 = 0.06 s and the
  // contact lasts until B's own motion opens the gap beyond CONTACT_TOL_MM: end = B start + (tol − gap at stop)/10 mm/s
  for (const p of ['B_contact_decision', 'C_sidestep'] as const) for (const [bStart, dt] of [[0.15, 0.2], [0.25, 0.2], [0.33, 0.1], [0.07, 0.05], [0.41, 0.2]] as const) {
    const { inp, res } = run(p, [ag('A', 10, 0, 90), ag('B', 13.1, bStart, 90)], 0.5, dt), lbl = `${p}: B starts at ${bStart}, decision interval ${dt}`;
    const cs = res.events.filter((e) => e.kind === 'contact_start'), ce = res.events.filter((e) => e.kind === 'contact_end');
    ok(cs.length === 1 && ce.length === 1, `${lbl}: one contact episode (${cs.length}/${ce.length})`);
    const ts = cs[0].t_s, sA = res.agents.A.samples.find((s) => s[0] === ts)!, g0 = sA ? 13.1 - sA[4] - 2.5 : NaN;
    ok(near(ts, 0.06, 1e-9), `${lbl}: contact starts at 0.06 s (${ts})`);
    const expEnd = bStart + (CONTACT_TOL_MM - g0) / 10;
    ok(near(ce[0].t_s, expEnd, 1e-12), `${lbl}: contact ends at B's start + (tol − gap)/v = ${expEnd} (${ce[0].t_s})`);
    ok(ce[0].t_s >= bStart && ce[0].t_s - ts > 0 && near(ce[0].t_s - ts, expEnd - 0.06, 1e-9), `${lbl}: positive contact duration ${ce[0].t_s - ts} = analytic ${expEnd - 0.06}`);
    timingInvariants(inp, res, lbl);
  }
  // control: B starts exactly on A's decision instant → both move at the same speed, the gap never opens: no contact_end
  for (const p of ['B_contact_decision', 'C_sidestep'] as const) {
    const { inp, res } = run(p, [ag('A', 10, 0, 90), ag('B', 13.1, 0.2, 90)], 0.5, 0.2);
    ok(res.events.filter((e) => e.kind === 'contact_start').length === 1 && !res.events.some((e) => e.kind === 'contact_end'), `${p}: lockstep after a contact keeps the contact open`);
    timingInvariants(inp, res, `${p}: lockstep`);
  }
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
ok(timing.arrivals > 0 && timing.contacts > 0, `timing invariants exercised (${timing.arrivals} arrivals, ${timing.contacts} contact episodes)`);
console.log(JSON.stringify({ wp4_local_steer: 'pass', checks, timing }, null, 2));
